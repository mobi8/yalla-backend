import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { decimal, scaled } from './drop-economy.js';
import { acceptedFriends } from './friend-overtake.js';
import { DynamoFriendsStore, type FriendsStore, type Item, type Key } from './friends-store.js';
import { ApiError, decodeProgress, playerKey, playerNumberOptions } from './repository.js';
import { friendRankPartition } from './journey-read-keys.js';

export const friendsRankQuery = z.strictObject({ scope: z.enum(['friends', 'global']) });
const dayMs = 86_400_000;
const topLimit = 100;
const snapshotKey = { PK: 'RANKING#FRIENDS', SK: 'DAILY' };
const playerId = z.uuid();
type Metric = 'stars' | 'distance';
type Score = { playerId: string; stars: string; distanceMeters: string };
type Positions = { stars: number | null; distance: number | null };
type Snapshot = { day: string; capturedAt: string; stars: Score[]; distance: Score[] };

export interface FriendsRankingStore extends Pick<FriendsStore, 'list'> {
  batch(keys: Key[]): Promise<Item[]>;
  top(metric: Metric): Promise<Score[]>;
  snapshot(): Promise<Snapshot | undefined>;
  publish(snapshot: Snapshot): Promise<boolean>;
}

const cmp = (a: bigint, b: bigint) => a === b ? 0 : a > b ? -1 : 1;
function order(metric: Metric, a: Score, b: Score) {
  const stars = cmp(BigInt(a.stars), BigInt(b.stars));
  const distance = cmp(scaled(a.distanceMeters), scaled(b.distanceMeters));
  return (metric === 'stars' ? stars || distance : distance || stars)
    || (a.playerId === b.playerId ? 0 : a.playerId > b.playerId ? -1 : 1);
}

export class DynamoFriendsRankingStore extends DynamoFriendsStore implements FriendsRankingStore {
  constructor(private db: DynamoDBDocumentClient, private tableName: string) { super(db, tableName); }

  async batch(keys: Key[]) {
    const rows: Item[] = [];
    for (let offset = 0; offset < keys.length; offset += 100) {
      let pending = keys.slice(offset, offset + 100);
      for (let attempt = 0; pending.length && attempt < 6; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        const result = await this.db.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: pending, ConsistentRead: true } },
        }));
        rows.push(...(result.Responses?.[this.tableName] ?? []) as Item[]);
        pending = (result.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as Key[];
      }
      if (pending.length) throw new ApiError(503, 'RANKING_RETRY');
    }
    return rows;
  }

  async top(metric: Metric) {
    const index = metric === 'stars' ? 'FriendsRankStars' : 'FriendsRankDistance';
    const field = metric === 'stars' ? 'friendsStarsSK' : 'friendsDistanceSK';
    const { Items } = await this.db.send(new QueryCommand({
      TableName: this.tableName, IndexName: index, Limit: topLimit, ScanIndexForward: false,
      KeyConditionExpression: 'friendsRankPK = :scope', ExpressionAttributeValues: { ':scope': friendRankPartition },
      ProjectionExpression: '#orderKey', ExpressionAttributeNames: { '#orderKey': field },
    }));
    return (Items ?? []).map(row => {
      const [first, second, id] = (row[field] as string).split('#');
      const [stars, distance] = metric === 'stars' ? [first, second] : [second, first];
      if (!stars || !distance || !id || !playerId.safeParse(id).success) throw new Error('Invalid ranking index entry');
      return { playerId: id, stars: BigInt(stars).toString(), distanceMeters: decimal(BigInt(distance)) };
    });
  }

  async snapshot() {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: snapshotKey, ConsistentRead: true }));
    return Item as Snapshot | undefined;
  }

  async publish(snapshot: Snapshot) {
    try {
      await this.db.send(new PutCommand({
        TableName: this.tableName, Item: { ...snapshotKey, ...snapshot },
        ConditionExpression: 'attribute_not_exists(#day) OR #day < :day',
        ExpressionAttributeNames: { '#day': 'day' }, ExpressionAttributeValues: { ':day': snapshot.day },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}

export class FriendsRankingService {
  constructor(private store: FriendsRankingStore, private clock = Date.now) {}

  async refreshGlobal() {
    const capturedAt = new Date(this.clock()).toISOString();
    const day = capturedAt.slice(0, 10);
    const previous = await this.store.snapshot();
    if (previous && previous.day >= day) return false;
    const [stars, distance] = await Promise.all([this.store.top('stars'), this.store.top('distance')]);
    return this.store.publish({ day, capturedAt, stars, distance });
  }

  async get(player: string, scope: 'friends' | 'global') {
    if (scope === 'global') {
      const snapshot = await this.store.snapshot();
      if (!snapshot) return { scope, capturedAt: null, nextRefreshAt: null, me: { stars: null, distance: null }, entries: [] };
      return this.present(player, scope, snapshot.stars, snapshot.distance, snapshot.capturedAt,
        new Date(Date.parse(snapshot.day) + dayMs).toISOString());
    }
    const accepted = await acceptedFriends(this.store, player);
    const ids = [...new Set([player, ...accepted.map(row => String(row.other)).filter(id => playerId.safeParse(id).success)])];
    const progress = await this.store.batch(ids.map(id => playerKey(id, 'PROGRESS')));
    const scores = progress.map(row => {
      const data = decodeProgress(row);
      return { playerId: row.PK.slice('PLAYER#'.length), stars: data.constructionStars, distanceMeters: data.distance };
    });
    if (!scores.some(score => score.playerId === player)) throw new ApiError(404, 'PLAYER_NOT_FOUND');
    return this.present(player, scope, [...scores].sort((a,b) => order('stars',a,b)),
      [...scores].sort((a,b) => order('distance',a,b)), new Date(this.clock()).toISOString(), null);
  }

  private async present(player: string, scope: 'friends' | 'global', stars: Score[], distance: Score[],
    capturedAt: string, nextRefreshAt: string | null) {
    const scores = new Map<string, Score & { ranks: Positions }>();
    for (const [metric, ranking] of [['stars',stars], ['distance',distance]] as const)
      ranking.forEach((score, index) => {
        const row = scores.get(score.playerId) ?? { ...score, ranks: { stars: null, distance: null } };
        if (metric === 'stars') row.stars = score.stars;
        else row.distanceMeters = score.distanceMeters;
        row.ranks[metric] = index + 1;
        scores.set(score.playerId, row);
      });
    const profiles = new Map((await this.store.batch([...scores.keys()].map(id => playerKey(id, 'PROFILE'))))
      .map(profile => [profile.PK.slice('PLAYER#'.length), profile]));
    return {
      scope, capturedAt, nextRefreshAt, me: scores.get(player)?.ranks ?? { stars: null, distance: null },
      entries: [...scores.values()].map(score => {
        const profile = profiles.get(score.playerId);
        return { ...score, me: score.playerId === player, nickname: profile?.nickname ?? 'Player', avatarId: profile?.avatarId ?? null };
      }),
    };
  }
}

export async function handler() {
  const table = process.env.PLAYER_TABLE;
  if (!table) throw new Error('PLAYER_TABLE is required');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { unmarshallOptions: playerNumberOptions });
  const service = new FriendsRankingService(new DynamoFriendsRankingStore(client, table));
  return { published: await service.refreshGlobal() };
}
