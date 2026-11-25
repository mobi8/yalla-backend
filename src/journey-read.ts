import { activityCutoff, activityDisplayUntil, loadActivityPolicy } from './activity-policy.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ApiError, decodeProgress, playerKey, playerNumberOptions, type PlayerRepository } from './repository.js';
import { decimal, scaled } from './drop-economy.js';
import { activityPartition, deltaPartition, distanceOrder, journeyIndex, privateActivity, totalPartition } from './journey-read-keys.js';
import type { Principal } from './model.js';

const dayMs = 86400000;
const monday = Date.UTC(1970, 0, 5);
type Row = { PK: string; SK: string; journeySK: string; rankDistance?: string };
type Bounds = { before?: string; after?: string; atOrAfter?: string; range?: [string, string] };
type Query = {
  partition: string; bounds?: Bounds; limit?: number; count?: boolean;
  start?: Pick<Row, 'PK' | 'SK' | 'journeySK'>;
};
export interface JourneyReadStore {
  get(player: string, key: string): Promise<Record<string, any> | undefined>;
  index(input: Query): Promise<{ rows: Row[]; count: number }>;
}

export class DynamoJourneyReadStore implements JourneyReadStore {
  constructor(private client: DynamoDBDocumentClient, private table: string) {}
  async get(player: string, key: string) {
    return (await this.client.send(new GetCommand({
      TableName: this.table, Key: playerKey(player, key), ConsistentRead: true,
    }))).Item;
  }
  async index({ partition, bounds, limit, count, start }: Query) {
    const condition = 'journeyPK = :pk';
    const values: Record<string, string> = { ':pk': partition };
    let filter = '';
    if (bounds?.range) {
      filter = ' AND journeySK BETWEEN :low AND :high';
      [values[':low'], values[':high']] = bounds.range;
    } else if (bounds?.before) {
      filter = ' AND journeySK < :key'; values[':key'] = bounds.before;
    } else if (bounds?.after) {
      filter = ' AND journeySK > :key'; values[':key'] = bounds.after;
    } else if (bounds?.atOrAfter) {
      filter = ' AND journeySK >= :key'; values[':key'] = bounds.atOrAfter;
    }
    const rows: Row[] = [];
    let total = 0, key: QueryCommandInput['ExclusiveStartKey'] = start && { ...start, journeyPK: partition };
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.table, IndexName: journeyIndex, KeyConditionExpression: condition + filter,
        ExpressionAttributeValues: values, ScanIndexForward: false, ExclusiveStartKey: key,
        ...(count ? { Select: 'COUNT' } : { ProjectionExpression: 'PK, SK, journeySK, rankDistance' }),
        ...(limit ? { Limit: limit - rows.length } : {}),
      }));
      rows.push(...(result.Items ?? []) as Row[]);
      total += result.Count ?? 0;
      key = result.LastEvaluatedKey;
    } while (key && (!limit || rows.length < limit));
    return { rows, count: total };
  }
}

const page = {
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(800).regex(/^[A-Za-z0-9_-]+$/).optional(),
};
export const rankingQuery = z.strictObject({
  ...page, scope: z.enum(['total', 'period']).default('total'), periodStart: z.iso.datetime().optional(),
});
export const activityQuery = z.strictObject({ ...page, limit: z.coerce.number().int().min(1).optional() });
type RankingQuery = z.infer<typeof rankingQuery>;
type ActivityQuery = z.infer<typeof activityQuery>;
const cursorData = z.tuple([z.string(), z.string().max(500)]);
function before(cursor: string | undefined, scope: string) {
  if (!cursor) return undefined;
  let decoded: z.infer<typeof cursorData>;
  try { decoded = cursorData.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())); }
  catch { throw new ApiError(400, 'INVALID_CURSOR'); }
  if (decoded[0] !== scope) throw new ApiError(409, 'CURSOR_SCOPE_CHANGED');
  return decoded[1];
}
const cursorFor = (scope: string, key?: string) => key
  ? Buffer.from(JSON.stringify([scope, key])).toString('base64url') : null;
const positiveFloor = distanceOrder('0', '~');
const playerFrom = (row: Row) => row.PK.slice('PLAYER#'.length);

export function rankingPeriod(now: number, days: number) {
  const window = days * dayMs;
  const start = monday + Math.floor((now - monday) / window) * window;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + window).toISOString(), days, timezone: 'UTC' };
}
type Period = ReturnType<typeof rankingPeriod>;
type Score = { player: string; order: string; distance: string };

export class JourneyReadService {
  private cachedPeriod?: { start: string; expires: number; scores: Promise<Score[]> };
  constructor(private players: Pick<PlayerRepository, 'find'>, private store: JourneyReadStore,
    private days: number, private clock = Date.now, private activityPolicy = loadActivityPolicy()) {}

  private async owner(principal: Principal) {
    const player = await this.players.find(principal);
    if (!player) throw new ApiError(404, 'PLAYER_NOT_FOUND');
    return player;
  }

  private async profiles(players: string[]) {
    const ids = [...new Set(players)];
    return new Map(await Promise.all(ids.map(async id => [id, await this.store.get(id, 'PROFILE')] as const)));
  }

  private periodScores(period: Period) {
    const now = this.clock(), cache = this.cachedPeriod;
    if (cache?.start === period.startsAt && now < cache.expires) return cache.scores;
    const scores = this.store.index({ partition: deltaPartition, bounds: { range: [period.startsAt, period.endsAt] } })
      .then(({ rows }) => {
        const totals = new Map<string, bigint>();
        for (const row of rows) {
          if (row.journeySK < period.startsAt || row.journeySK >= period.endsAt || !row.rankDistance) continue;
          const player = playerFrom(row);
          totals.set(player, (totals.get(player) ?? 0n) + scaled(row.rankDistance));
        }
        return [...totals].map(([player, distance]) => {
          const meters = decimal(distance);
          return { player, distance: meters, order: distanceOrder(meters, player) };
        }).sort((a,b) => a.order < b.order ? 1 : a.order > b.order ? -1 : 0);
      });
    const latest = { start: period.startsAt, expires: now + 5000, scores };
    this.cachedPeriod = latest;
    void scores.catch(() => { if (this.cachedPeriod === latest) this.cachedPeriod = undefined; });
    return scores;
  }

  async recentRankedPlayers(limit: number) {
    const scores = await this.periodScores(rankingPeriod(this.clock(), this.days));
    return scores.slice(0, limit).map(score => score.player);
  }

  async currentPeriodDistances(players: string[]) {
    const period = rankingPeriod(this.clock(), this.days);
    const selected = new Set(players);
    const scores = await this.periodScores(period);
    return { period, distances: new Map(scores.filter(score => selected.has(score.player))
      .map(score => [score.player, score.distance])) };
  }

  async ranking(principal: Principal, query: RankingQuery) {
    const player = await this.owner(principal);
    const current = rankingPeriod(this.clock(), this.days);
    if (query.scope === 'total' && query.periodStart) throw new ApiError(400, 'INVALID_PERIOD');
    const period = query.scope === 'period'
      ? query.periodStart ? rankingPeriod(Date.parse(query.periodStart), this.days) : current : null;
    if (period && query.periodStart &&
        (Date.parse(period.startsAt) !== Date.parse(query.periodStart) || period.startsAt > current.startsAt))
      throw new ApiError(400, 'INVALID_PERIOD');
    const scope = period ? `period:${period.startsAt}:${period.days}` : 'total:positive';
    const limit = query.limit;
    const cursor = before(query.cursor, scope);
    if (cursor && (!/^\d{57}#[0-9a-f-]{36}$/i.test(cursor) || cursor <= positiveFloor)) throw new ApiError(400, 'INVALID_CURSOR');
    let scores: Score[], offset: number, participantCount: number, rank: number | null, distance: string;
    if (period) {
      const all = await this.periodScores(period);
      offset = cursor ? all.findIndex(row => row.order < cursor) : 0;
      if (offset < 0) offset = all.length;
      scores = all.slice(offset, offset + limit + 1);
      participantCount = all.length;
      const mine = all.findIndex(row => row.player === player);
      rank = mine < 0 ? null : mine + 1;
      distance = mine < 0 ? '0' : all[mine]!.distance;
    } else {
      const progress = await this.store.get(player, 'PROGRESS');
      if (!progress) throw new ApiError(404, 'PLAYER_NOT_FOUND');
      distance = decodeProgress(progress).distance;
      const ownOrder = distanceOrder(distance, player);
      const ranked = ownOrder > positiveFloor && progress.journeySK === ownOrder;
      const positive = { after: positiveFloor };
      const [{ rows }, total, higher, preceding] = await Promise.all([
        this.store.index({ partition: totalPartition, bounds: positive, limit: limit + 1,
          start: cursor ? { PK: `PLAYER#${cursor.slice(58)}`, SK: 'PROGRESS', journeySK: cursor } : undefined }),
        this.store.index({ partition: totalPartition, count: true, bounds: positive }),
        ranked ? this.store.index({ partition: totalPartition, count: true, bounds: { after: ownOrder } }) : undefined,
        cursor ? this.store.index({ partition: totalPartition, count: true, bounds: { atOrAfter: cursor } }) : undefined,
      ]);
      scores = rows.map(row => ({ player: playerFrom(row), distance: row.rankDistance!, order: row.journeySK }));
      offset = preceding?.count ?? 0;
      participantCount = total.count;
      rank = higher ? higher.count + 1 : null;
    }
    const visible = scores.slice(0, limit);
    const profiles = await this.profiles([...visible.map(row => row.player), player]);
    const entry = (id: string, meters: string, position: number | null) => ({
      playerId: id, distanceMeters: meters, rank: position,
      nickname: profiles.get(id)?.nickname ?? null, avatarId: profiles.get(id)?.avatarId ?? null,
    });
    const periodSummary = period ? null : (await this.periodScores(current)).find(row => row.player === player)?.distance ?? '0';
    return {
      scope: query.scope, period, currentPeriod: current, participantCount,
      me: entry(player, distance, rank), currentPeriodDistanceMeters: periodSummary,
      entries: visible.map((row, i) => entry(row.player, row.distance, offset + i + 1)),
      nextCursor: cursorFor(scope, scores.length > limit ? visible.at(-1)?.order : undefined),
    };
  }

  async activity(principal: Principal, query: ActivityQuery) {
    const player = await this.owner(principal);
    const partition = activityPartition(player);
    const cursor = before(query.cursor, partition);
    const now = this.clock();
    const policy = this.activityPolicy;
    const cutoff = activityCutoff(now, policy);
    // Apply the feed cap before the legacy cursor so pagination stays inside the display window.
    const { rows } = await this.store.index({
      partition,
      bounds: { range: [new Date(cutoff + 1).toISOString(), `${new Date(now).toISOString()}$`] },
      limit: policy.activityMaxDisplayCount,
    });
    const keys = new Set<string>();
    const candidates = rows.filter(row => {
      if (row.PK !== `PLAYER#${player}` || keys.has(row.journeySK)) return false;
      keys.add(row.journeySK);
      return true;
    });
    const limit = query.limit ?? policy.activityMaxDisplayCount;
    const remaining = candidates.filter(row => !cursor || row.journeySK < cursor);
    const selected = remaining.slice(0, limit);
    const batch = await Promise.all(selected.map(async row => {
      if (!/^(ACTIVITY_FEED#|INCOMING#(?:RECEIPT|WALLET_RAID|PLAYER_ATTACK|PLAYER_RAID)#|RAID#|FRIEND_HELP(?:_THANKS)?#)/.test(row.SK)) return;
      const item = await this.store.get(player, row.SK);
      if (!item) return;
      const expiry = typeof item.activityExpiresAt === 'number' ? item.activityExpiresAt : undefined;
      const displayUntil = (occurredAt: unknown) => activityDisplayUntil(occurredAt, policy, expiry);
      if (/^FRIEND_HELP(?:_THANKS)?#/.test(row.SK) && item.recipientId === player &&
          (item.type === 'FRIEND_HELP_REPAIR' || item.type === 'FRIEND_HELP_THANKS')) {
        const { PK, SK, version, journeyPK, journeySK, activityExpiresAt, ...event } = item;
        const until = displayUntil(event.occurredAt);
        if (until > now) return { event, until, social: true as const };
        return;
      }
      const event: ReturnType<typeof privateActivity> = row.SK.startsWith('ACTIVITY_FEED#')
        ? item.event : privateActivity(player, row.SK, item);
      if (!event) return;
      const until = displayUntil(event.occurredAt);
      if (until > now) return { event, until, social: false as const };
    }));
    const visible = batch.filter(record => record !== undefined);
    const senderSchema = z.object({ id: z.uuid(), type: z.literal('PLAYER') }).passthrough();
    const senders = visible.map(record => record.social ? senderSchema.safeParse(record.event.sender).data : undefined);
    const participants = visible.flatMap(record => record.social ? [] :
      [record.event.attacker, record.event.defender].filter(party => party.type === 'PLAYER').map(party => party.id));
    const profiles = await this.profiles([...participants, ...senders.flatMap(sender => sender ? [sender.id] : [])]);
    const named = (party: { id: string; type: string }) => ({
      ...party, nickname: party.type === 'BOT' ? party.id : profiles.get(party.id)?.nickname ?? null,
      ...(party.type === 'PLAYER' ? { avatarId: profiles.get(party.id)?.avatarId ?? null } : {}),
    });
    const events = visible.map<Record<string, unknown>>(({social,event,until}, index) => {
      const displayUntil = new Date(until).toISOString();
      if (!social) return { ...event, displayUntil, attacker: named(event.attacker), defender: named(event.defender) };
      const sender = senders[index];
      const profile = sender && profiles.get(sender.id);
      return profile ? {
        ...event,
        displayUntil,
        sender: { ...sender, nickname: profile.nickname ?? sender.nickname, avatarId: profile.avatarId ?? sender.avatarId },
      } : { ...event, displayUntil };
    });
    return {
      events, playerId: player, serverTime: new Date(now).toISOString(),
      nextCursor: cursorFor(partition, remaining.length > limit ? selected.at(-1)?.journeySK : undefined),
    };
  }
}

export function createJourneyReadService(table: string, players: PlayerRepository) {
  const parsed = z.coerce.number().int().min(1).max(31).parse(process.env.RANKING_PERIOD_DAYS ?? '1');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { unmarshallOptions: playerNumberOptions });
  return new JourneyReadService(players, new DynamoJourneyReadStore(client, table), parsed);
}
