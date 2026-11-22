import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BotsSource } from './bots-config.js';
import { acceptedFriends } from './friend-overtake.js';
import { scaled } from './drop-economy.js';
import type { JourneyReadService } from './journey-read.js';
import { currentVillageDamage, type Principal } from './model.js';
import { ApiError, decodeProgress, playerKey, type PlayerRepository } from './repository.js';
import { canHelpDamage, buildingIds } from './world-config.js';
import type { FriendHelpService } from './friend-help.js';
import type { FriendsStore, Item, Write } from './friends-store.js';

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const codePattern = /^YAL-[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/;
const botPattern = /^bot-player_10\d{2}$/;
const newCode = () => {
  const chunk = () => Array.from({ length: 3 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `YAL-${chunk()}-${chunk()}`;
};
export const friendCode = z.string().max(32).transform(value => value.trim().toUpperCase()).pipe(z.string().regex(codePattern));
const targetInput = z.union([friendCode, z.string().regex(botPattern)]);
const sendInput = z.strictObject({ code: targetInput, requestId: z.uuid(), referral: z.boolean().optional() });
const actionInput = z.strictObject({ code: targetInput, requestId: z.uuid(),
  action: z.enum(['accept', 'decline', 'cancel', 'remove']) });
const pageInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
});
const stateSchema = z.object({
  requestId: z.uuid(), revision: z.uuid(), sender: z.string(), recipient: z.string(),
  state: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'REMOVED']),
  acceptedAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime(),
});
type State = z.infer<typeof stateSchema>;
type Status = State['state'];
type List = 'IN' | 'OUT' | 'LIST';
const codeKey = (SK: string) => ({ PK: 'FRIENDS#CODES', SK });
const ownerCode = (player: string) => playerKey(player, 'FRIENDS#CODE');
const pairKey = (a: string, b: string) => ({ PK: `FRIENDS#PAIR#${[a,b].sort().join('#')}`, SK: 'STATE' });
const memberKey = (player: string, list: List, requestId: string) => playerKey(player, `FRIENDS#${list}#${requestId}`);
const isBot = (id: string) => botPattern.test(id);
const fail = (status: number, code: string): never => { throw new ApiError(status, code); };
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(400, 'INVALID_REQUEST');
};

export class FriendsService {
  constructor(private store: FriendsStore, private players: Pick<PlayerRepository,'find'>,
    private journey: Pick<JourneyReadService,'currentPeriodDistances'|'recentRankedPlayers'>, private bots: BotsSource,
    private clock = Date.now, private mintCode = newCode, private friendHelp?: FriendHelpService) {}

  async code(player: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const stored = await this.store.get(ownerCode(player));
      if (typeof stored?.code === 'string') return stored.code;
      const code = this.mintCode();
      if (await this.store.commit([
        { item: { ...ownerCode(player), code }, expected: null },
        { item: { ...codeKey(code), player }, expected: null },
      ])) return code;
    }
    return fail(503, 'FRIEND_CODE_RETRY');
  }

  private async target(code: string) {
    if (isBot(code)) {
      if ((await this.bots.load()).bots.some(bot => `bot-${bot.id}` === code)) return code;
    } else {
      const row = await this.store.get(codeKey(code));
      if (typeof row?.player === 'string') return row.player;
    }
    return fail(404, 'FRIEND_CODE_NOT_FOUND');
  }

  private async profile(player: string) {
    if (isBot(player)) {
      const bot = (await this.bots.load()).bots.find(entry => `bot-${entry.id}` === player);
      return { code: player, nickname: bot?.id ?? 'Camel', avatarId: bot?.avatarId ?? null, type: 'BOT' };
    }
    const row = await this.store.get(playerKey(player, 'PROFILE'));
    return { code: await this.code(player), nickname: row?.nickname ?? 'Player', avatarId: row?.avatarId ?? null, type: 'PLAYER' };
  }

  private async state(a: string, b: string) {
    const item = await this.store.get(pairKey(a,b));
    return item ? stateSchema.parse(item) : undefined;
  }

  private projections(state: State): Item[] {
    const {sender, recipient, requestId, acceptedAt} = state;
    if (state.state === 'PENDING') return [
      { ...memberKey(sender,'OUT',requestId), other: recipient },
      { ...memberKey(recipient,'IN',requestId), other: sender },
    ];
    if (state.state !== 'ACCEPTED') return [];
    return [
      { ...memberKey(sender,'LIST',requestId), other: recipient, acceptedAt },
      { ...memberKey(recipient,'LIST',requestId), other: sender, acceptedAt },
    ];
  }

  private async transition(previous: State | undefined, state: State, extra: Write[] = []) {
    const writes: Write[] = [
      { item: { ...pairKey(state.sender,state.recipient), ...state }, expected: previous?.revision ?? null },
      ...(previous ? this.projections(previous).map(({PK, SK}) => ({ remove: {PK, SK} })) : []),
      ...this.projections(state).map(item => ({ item })),
      ...extra,
    ];
    return this.store.commit(writes);
  }

  private async send(player: string, input: z.infer<typeof sendInput>) {
    const other = await this.target(input.code);
    if (player === other) return fail(400, 'CANNOT_ADD_SELF');
    if (isBot(other)) return fail(404, 'FRIEND_CODE_NOT_FOUND');
    const memo = playerKey(player, `FRIENDS#SENT#${input.requestId}`);
    for (let attempt = 0; attempt < 4; attempt++) {
      const [receipt, previous] = await Promise.all([this.store.get(memo), this.state(player,other)]);
      if (receipt) {
        if (receipt.other !== other) return fail(409, 'REQUEST_ID_REUSED');
        return { status: previous?.requestId === receipt.requestId ? previous?.state : receipt.status, requestId: receipt.requestId };
      }
      if (previous?.state === 'PENDING' || previous?.state === 'ACCEPTED')
        return fail(409, previous.state === 'PENDING' ? 'REQUEST_PENDING' : 'ALREADY_FRIENDS');
      const now = this.clock();
      const timestamp = new Date(now).toISOString();
      const status = 'PENDING';
      const next: State = { requestId: randomUUID(), revision: randomUUID(), sender: player, recipient: other,
        state: status, updatedAt: timestamp };
      const extra: Write[] = [{ item: { ...memo, status, other, requestId: next.requestId }, expected: null }];
      if (input.referral) {
        const key = playerKey(player, 'FRIENDS#REFERRAL');
        const profile = await this.store.get(playerKey(player, 'PROFILE'));
        const age = now - Date.parse(String(profile?.createdAt));
        // Attribution is opt-in on an invite request within 24 hours of new account creation.
        if (profile?.migrationState === 'new' && age >= 0 && age <= 86_400_000 && !await this.store.get(key))
          extra.push({ item: { ...key, inviterPlayerId: other, inviteePlayerId: player, referralCode: input.code,
            createdAt: timestamp, status: 'ATTRIBUTED', rewardStatus: 'NOT_AWARDED' }, expected: null });
      }
      if (await this.transition(previous,next,extra)) return { status, requestId: next.requestId };
    }
    return fail(409, 'FRIEND_STATE_CHANGED');
  }

  private async act(player: string, input: z.infer<typeof actionInput>) {
    const other = await this.target(input.code);
    if (player === other) return fail(400, 'CANNOT_ADD_SELF');
    const previous = await this.state(player,other);
    if (!previous || previous.requestId !== input.requestId) return fail(404, 'REQUEST_NOT_FOUND');
    const allowed = input.action === 'remove' || (input.action === 'cancel' ? previous.sender === player : previous.recipient === player);
    if (!allowed) return fail(403, 'FRIEND_ACTION_FORBIDDEN');
    const status: Status = { accept: 'ACCEPTED', decline: 'DECLINED', cancel: 'CANCELLED', remove: 'REMOVED' }[input.action] as Status;
    if (previous.state === status) return { status };
    if (previous.state !== (input.action === 'remove' ? 'ACCEPTED' : 'PENDING')) return fail(409, 'FRIEND_STATE_CHANGED');
    const updatedAt = new Date(this.clock()).toISOString();
    const next = { ...previous, state: status, revision: randomUUID(), updatedAt,
      ...(status === 'ACCEPTED' ? { acceptedAt: updatedAt } : {}) };
    if (await this.transition(previous,next)) return { status };
    const current = await this.state(player,other);
    if (current?.requestId === input.requestId && current.state === status) return { status };
    return fail(409, 'FRIEND_STATE_CHANGED');
  }

  async members(player: string, list: List) {
    const PK = playerKey(player,'').PK;
    const prefix = `FRIENDS#${list}#`;
    const result: Item[] = [];
    let page: Item[];
    do {
      page = await this.store.list(PK,prefix,100,result.at(-1)?.SK);
      result.push(...page);
    } while (page.length === 100);
    return result;
  }

  private async list(player: string, list: List, {limit,cursor}: z.infer<typeof pageInput>) {
    const prefix = `FRIENDS#${list}#`;
    const rows = await this.store.list(playerKey(player,'').PK,prefix,limit + 1,cursor && prefix + cursor);
    const requestId = (row: Item) => row.SK.slice(prefix.length);
    const entries = await Promise.all(rows.slice(0,limit).map(async row =>
      ({ ...await this.profile(String(row.other)), requestId: requestId(row) })));
    return { entries, nextCursor: rows.length > limit ? requestId(rows[limit - 1]!) : null };
  }

  private async suggestions(player: string) {
    const candidates = await this.journey.recentRankedPlayers(50);
    const ids = candidates.filter(id => id !== player && !isBot(id));
    const pairs = await Promise.all(ids.map(id => this.state(player,id)));
    const entries = ids.filter((_,i) => pairs[i]?.state !== 'PENDING' && pairs[i]?.state !== 'ACCEPTED');
    return { entries: await Promise.all(entries.slice(0,10).map(id => this.profile(id))) };
  }

  private async help(player: string, {limit,cursor}: z.infer<typeof pageInput>) {
    const prefix = 'FRIENDS#LIST#';
    const rows = await this.store.list(playerKey(player,'').PK,prefix,limit + 1,cursor && prefix + cursor);
    const catalog = rows.length ? await this.friendHelp?.catalog() : undefined;
    const entries = await Promise.all(rows.slice(0,limit).map(async row => {
      const other = String(row.other);
      if (isBot(other)) return;
      const progress = await this.store.get(playerKey(other,'PROGRESS'));
      if (!progress) return;
      const village = decodeProgress(progress);
      const damage = currentVillageDamage(village);
      const world = catalog?.worlds.find(entry => entry.id === village.worldId);
      const damagedBuildingCount = world && this.friendHelp
        ? this.friendHelp.eligibleDamage(village, world).size
        : buildingIds.filter(id => damage[id] && canHelpDamage(village, id)).length;
      if (damagedBuildingCount > 0) return { ...await this.profile(other), targetId: other, damagedBuildingCount };
    }));
    return {
      entries: entries.filter(entry => entry !== undefined),
      nextCursor: rows.length > limit ? rows[limit - 1]!.SK.slice(prefix.length) : null,
    };
  }

  private async rank(player: string) {
    const friends = await acceptedFriends(this.store, player);
    const ids = [player, ...friends.map(row => String(row.other))];
    const { period, distances } = await this.journey.currentPeriodDistances(ids);
    const entries = ids.map(id => ({ id, distance: distances.get(id) ?? '0' }));
    entries.sort((a,b) => {
      const difference = scaled(b.distance) - scaled(a.distance);
      return difference === 0n ? a.id.localeCompare(b.id) : difference > 0n ? 1 : -1;
    });
    return { period, entries: await Promise.all(entries.map(async ({id,distance},i) =>
      ({ ...await this.profile(id), distanceMeters: distance, rank: i + 1, me: id === player }))) };
  }

  async invite(value: unknown) {
    const { code, nickname } = await this.profile(await this.target(parse(friendCode,value)));
    return { code, nickname };
  }

  async route(principal: Principal, route: string, query: unknown, readBody: () => unknown) {
    const player = await this.players.find(principal) ?? fail(404,'PLAYER_NOT_FOUND');
    switch (route) {
      case 'GET /friends/code': return { code: await this.code(player) };
      case 'GET /friends/search': {
        const {code} = parse(z.strictObject({code: friendCode}),query);
        const other = await this.target(code);
        return { ...await this.profile(other), me: player === other, status: (await this.state(player,other))?.state ?? null };
      }
      case 'GET /friends/requests/incoming': return this.list(player,'IN',parse(pageInput,query));
      case 'GET /friends/requests/outgoing': return this.list(player,'OUT',parse(pageInput,query));
      case 'GET /friends/list': return this.list(player,'LIST',parse(pageInput,query));
      case 'GET /friends/count': return { count: (await this.members(player,'IN')).length };
      case 'GET /friends/suggested': return this.suggestions(player);
      case 'GET /friends/help': return this.help(player,parse(pageInput,query));
      case 'GET /friends/rank': return this.rank(player);
      case 'POST /friends/requests': return this.send(player,parse(sendInput,readBody()));
      case 'POST /friends/actions': return this.act(player,parse(actionInput,readBody()));
      default: return this.friendHelp?.route(player, route, query, readBody) ?? fail(404,'ROUTE_NOT_FOUND');
    }
  }
}
