import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOTS } from '../src/bots-config.js';
import { FriendHelpService, cloverState, rollRepairDiscount } from '../src/friend-help.js';
import { parseConfig, type ConfigName } from '../src/game-config.js';
import { FriendsService } from '../src/friends.js';
import { DynamoFriendsStore, type FriendsStore, type Item, type Key, type Write } from '../src/friends-store.js';
import { createHandler } from '../src/handler.js';
import { friendCrossings, settlementChange } from '../src/friend-overtake.js';
import { JourneyReadService, rankingPeriod } from '../src/journey-read.js';
import { scaled } from '../src/drop-economy.js';
import { notificationMessage, notificationPolicy } from '../src/notification-events.js';
import { routeNotifications } from '../src/notification-router.js';
import { newSave } from '../src/model.js';
import { ApiError, decodeProgress, playerKey } from '../src/repository.js';
import type { PlayerService } from '../src/service.js';
import { worker } from '../src/notification-worker.js';
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const today = Date.parse('2026-11-19T10:10:00.000Z');
const players: string[] = Array.from({ length: 4 }, () => randomUUID());
const [a,b,c,d] = players as [string,string,string,string];
const principal = (subject: string) => ({ provider: 'guest' as const, subject });
const key = ({PK,SK}: Key) => `${PK}/${SK}`;
const bot = 'bot-player_1001';

class Memory implements FriendsStore {
  rows = new Map<string,Item>();
  async get(item: Key) { return this.rows.get(key(item)); }
  async list(pk: string, prefix: string, limit: number, after = '') {
    return [...this.rows.values()].filter(row => row.PK === pk && row.SK.startsWith(prefix) && row.SK > after)
      .sort((x,y) => x.SK.localeCompare(y.SK)).slice(0,limit);
  }
  async commit(writes: Write[]) {
    const targets = writes.map(write => key('item' in write ? write.item : 'check' in write ? write.check : write.remove));
    if (new Set(targets).size !== targets.length) throw Error('duplicate DynamoDB transaction key');
    for (const write of writes) {
      if ('check' in write && this.rows.get(key(write.check))?.revision !== write.expected) return false;
      if (!('item' in write) || write.expected === undefined) continue;
      const current = this.rows.get(key(write.item));
      if (write.expected === null ? current : (typeof write.expected === 'number' ? current?.version : current?.revision) !== write.expected) return false;
    }
    for (const write of writes) {
      if ('remove' in write) this.rows.delete(key(write.remove));
      else if ('item' in write) this.rows.set(key(write.item),write.item);
    }
    return true;
  }
}

function seedAcceptedBot(store: Memory, player: string, time: number) {
  const requestId = randomUUID();
  const acceptedAt = new Date(time).toISOString();
  const state = {
    PK: `FRIENDS#PAIR#${[player,bot].sort().join('#')}`, SK: 'STATE', requestId,
    revision: randomUUID(), sender: player, recipient: bot, state: 'ACCEPTED',
    acceptedAt, updatedAt: acceptedAt,
  };
  store.rows.set(key(state),state);
  for (const [owner,other] of [[player,bot],[bot,player]] as const) {
    const row = { ...playerKey(owner,`FRIENDS#LIST#${requestId}`), other, acceptedAt };
    store.rows.set(key(row),row);
  }
  return requestId;
}

const localConfig = <K extends ConfigName>(name: K) =>
  parseConfig(name, readFileSync(new URL(`../config/dev/${name}.json`, import.meta.url), 'utf8'), 'dev');

function fixture(mint?: () => string, withHelp = false) {
  const store = new Memory();
  let now = today;
  const distances = new Map([[a,'30.0001'],[b,'20'],[bot,'20']]);
  for (const [index, player] of players.entries()) {
    const profile = playerKey(player,'PROFILE');
    store.rows.set(key(profile),{ ...profile, nickname: `Camel ${index}`, avatarId: 'camel',
      migrationState: 'new', createdAt: new Date(now - (player === d ? 172_800_000 : 5_000)).toISOString() });
  }
  const service = new FriendsService(store,{find:async p => players.includes(p.subject) ? p.subject : undefined},
    {recentRankedPlayers: async () => [...distances.keys()], currentPeriodDistances: async ids => ({
      period: rankingPeriod(now,7),
      distances: new Map(ids.filter(id => distances.has(id)).map(id => [id,distances.get(id)!])),
    })}, {load: async () => DEFAULT_BOTS},() => now,mint,
    withHelp ? new FriendHelpService(store, { load: async name => localConfig(name) }, () => now, n => n - 1) : undefined);
  const api = async (player: string, route: string, query = {}, body = {}): Promise<any> => service.route(principal(player),route,query,() => body);
  const send = async (sender: string, target: string, requestId = randomUUID(), referral = false) =>
    api(sender,'POST /friends/requests',{}, {code: target,requestId,referral});
  const action = async (player: string, code: string, requestId: string, action: string) =>
    api(player,'POST /friends/actions',{}, {code,requestId,action});
  return { store, service, api, send, action, distances, clock: () => now, tick: (ms:number) => {now += ms;} };
}

async function helpFixture(buildingCount = 2) {
  const f = fixture(undefined, true);
  const [ownerCode, helperCode] = await Promise.all([f.service.code(b), f.service.code(a)]);
  const request = await f.send(a, ownerCode);
  await f.action(b, helperCode, request.requestId, 'accept');
  const save = newSave();
  const wallet = { ...playerKey(a, 'WALLET'), ...save.wallet };
  f.store.rows.set(key(wallet),wallet);
  const progress = save.progress;
  const buildings = Object.fromEntries(Array.from({length: buildingCount}, (_,i) => [`building-${i+1}`, String(i+1)]));
  const damaged = { ...playerKey(b, 'PROGRESS'), ...progress, facilityLevels: [2,2,2,2,2],
    villageDamage: { worldRunId: progress.worldRunId, village: progress.village, buildings } };
  f.store.rows.set(key(damaged), damaged);
  for (const [buildingId, attackId] of Object.entries(buildings)) {
    const receipt = { ...playerKey(b, `INCOMING#RECEIPT#${attackId.padStart(16,'0')}`),
      worldRunId: progress.worldRunId, village: progress.village, buildingId, timestamp: new Date(today).toISOString() };
    f.store.rows.set(key(receipt), receipt);
  }
  const repair = (requestId = randomUUID()) => f.api(a, 'POST /friends/help/repair', {}, {targetId: b, requestId});
  const thanks = (player: string, eventId: string) => f.api(player, 'POST /friends/help/thanks', {}, {eventId});
  const visit = (player = a) => f.api(player, 'GET /friends/help/visit', {targetId: b});
  const unread = () => f.api(b, 'GET /friends/help/unread');
  const activity = (player: string) => new JourneyReadService(
    { find: async () => player },
    { get: (id, sk) => f.store.get(playerKey(id, sk)),
      index: async ({partition,bounds,limit}) => ({count: 0, rows: [...f.store.rows.values()]
        .flatMap(row => typeof row.journeySK === 'string' && row.journeyPK === partition &&
          (!bounds?.range || row.journeySK >= bounds.range[0] && row.journeySK <= bounds.range[1])
          ? [{PK: row.PK, SK: row.SK, journeySK: row.journeySK}] : [])
        .sort((x,y) => y.journeySK.localeCompare(x.journeySK)).slice(0, limit) }) }, 7, f.clock);
  return {...f, repair, thanks, visit, unread, activity};
}

describe('Friend HELP weighted discount', () => {
  it('assigns each of 100 tickets to the correct band and samples every integer within it', () => {
    const bands = [
      [0, 0, 1, 1], [1, 1, 2, 2], [2, 46, 3, 5], [47, 76, 6, 10],
      [77, 89, 11, 15], [90, 95, 16, 20], [96, 98, 21, 25], [99, 99, 26, 30],
    ] as const;
    expect(bands.reduce((total, [first, last]) => total + last - first + 1, 0)).toBe(100);
    const discounts = new Set<number>();
    for (const [first, last, min, max] of bands) {
      for (let ticket = first; ticket <= last; ticket++) {
        for (let discount = min; discount <= max; discount++) {
          const roll = vi.fn((limit: number) => limit === 100 ? ticket : discount - min);
          const result = rollRepairDiscount(roll);
          expect(result).toBe(discount);
          discounts.add(result);
          expect(roll.mock.calls).toEqual(min === max ? [[100]] : [[100], [max - min + 1]]);
        }
      }
    }
    expect([...discounts]).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  });
});

describe('Friend help cycle', () => {
  it('atomically pays the same repair roll once, including simultaneous and later retries', async () => {
    const f = await helpFixture();
    const wallet = playerKey(a, 'WALLET');
    const requestId = randomUUID();
    expect(await f.store.get(wallet)).toMatchObject({energy:50,version:1});
    const [repair, concurrent] = await Promise.all([f.repair(requestId), f.repair(requestId)]);
    expect(repair.energyReward).toBe(repair.event.percent);
    expect(repair.energyReward).toBe(30);
    expect(concurrent).toEqual(repair);
    expect(await f.repair(requestId)).toEqual(repair);
    expect(await f.store.get(wallet)).toMatchObject({energy:80,version:2});
    expect((await f.visit()).clover.remaining).toBe(4);
  });

  it('keeps Wallet and Clover unchanged when repair fails', async () => {
    const f = await helpFixture(0);
    await expect(f.repair()).rejects.toMatchObject({code:'NO_HELP_ELIGIBLE_DAMAGE'});
    expect(await f.store.get(playerKey(a,'WALLET'))).toMatchObject({energy:50,version:1});
    expect((await f.visit()).clover.remaining).toBe(5);
  });

  it('includes authoritative clover on the first HELP page even when the list is empty', async () => {
    const f = await helpFixture(1);
    await f.repair();
    const empty = await f.api(a,'GET /friends/help');
    expect(empty).toMatchObject({entries:[], clover:{remaining:4,capacity:5},
      serverTime:new Date(today).toISOString()});
    expect(empty.clover).toEqual((await f.visit()).clover);
    f.tick(4 * 60 * 60 * 1000);
    expect((await f.api(a,'GET /friends/help')).clover)
      .toMatchObject({remaining:5,nextAt:null});
  });

  it('returns the visited friend’s equipped costume without exposing inventory or using the visitor’s outfit', async () => {
    const f = await helpFixture();
    const visitor = { ...playerKey(a, 'COSTUME'), equipped: {HEAD: 'camel_hat_yellow_snow'} };
    f.store.rows.set(key(visitor), visitor);
    expect((await f.visit()).equippedCostume).toEqual({});
    const owner = { ...playerKey(b, 'COSTUME'), ownedIds: ['camel_hat_viking', 'camel_glasses_gold', 'camel_glasses_ray_ban'],
      equipped: {HEAD: 'camel_hat_viking', GLASS: 'camel_glasses_gold'} };
    f.store.rows.set(key(owner), owner);
    const view = await f.visit();
    expect(view.equippedCostume).toEqual(owner.equipped);
    expect(view).not.toHaveProperty('ownedIds');
    f.store.rows.set(key(owner), { ...owner, equipped: {HEAD: null, GLASS: 'camel_glasses_ray_ban'} });
    expect((await f.visit()).equippedCostume).toEqual({HEAD: null, GLASS: 'camel_glasses_ray_ban'});
    await expect(f.visit(c)).rejects.toMatchObject({code:'FRIEND_REQUIRED'});
  });

  it('discounts one random eligible building once, keeps damage and lists remaining eligible damage', async () => {
    const f = await helpFixture();
    await expect(f.visit(c)).rejects.toMatchObject({code:'FRIEND_REQUIRED'});
    const before = await f.visit();
    expect(before.clover.remaining).toBe(5);
    expect(before.repairs.filter((r: { eligible: boolean }) => r.eligible)).toHaveLength(2);
    const id = randomUUID();
    const [first, retry] = await Promise.all([f.repair(id), f.repair(id)]);
    expect(first).toEqual(retry);
    expect(first.event).toMatchObject({buildingId:'building-2',percent:30,
      savedYP:Math.floor(before.repairs[1].cost * .3)});
    expect(first.clover.remaining).toBe(4);
    const after = await f.visit();
    expect(after.levels).toEqual(before.levels);
    expect(after.repairs[1]).toMatchObject({attackId:'2', eligible:false, cost:first.event.remainingCost});
    expect((await f.api(a,'GET /friends/help')).entries[0].damagedBuildingCount).toBe(1);
    expect((await f.repair()).event.buildingId).toBe('building-1');
    await expect(f.repair()).rejects.toMatchObject({code:'NO_HELP_ELIGIBLE_DAMAGE'});
    expect((await f.api(a,'GET /friends/help')).entries).toEqual([]);
    const {entries} = await f.unread();
    expect(entries).toHaveLength(2);
    await f.api(b,'POST /friends/help/read',{}, {eventId:first.event.eventId});
    expect((await f.unread()).entries).toHaveLength(1);
    expect((await f.activity(b).activity(principal(b),{limit:20})).events).toHaveLength(2);
  });

  it('uses the current sender avatar for existing repair and thanks cards', async () => {
    const f = await helpFixture();
    const repair = await f.repair();
    await f.thanks(b, repair.event.eventId);
    const helperAvatar = '1914377d7b894820acd70169db0c7f5d';
    const ownerAvatar = '3c885d9cccbf4b919b2a33f1f888ea4b';
    for (const [id, avatarId] of [[a,helperAvatar],[b,ownerAvatar]] as const) {
      const profile = playerKey(id, 'PROFILE');
      f.store.rows.set(key(profile), { ...await f.store.get(profile), ...profile, avatarId });
    }
    expect((await f.activity(b).activity(principal(b),{limit:20})).events[0])
      .toMatchObject({type:'FRIEND_HELP_REPAIR',sender:{id:a,avatarId:helperAvatar}});
    expect((await f.activity(a).activity(principal(a),{limit:20})).events[0])
      .toMatchObject({type:'FRIEND_HELP_THANKS',sender:{id:b,avatarId:ownerAvatar}});
  });

  it('expires Activity and thanks without undoing the repair, reward or repair notice', async () => {
    const f = await helpFixture();
    const requestId = randomUUID();
    const result = await f.repair(requestId);
    const { eventId, occurredAt } = result.event;
    const progress = await f.store.get(playerKey(b, 'PROGRESS'));
    const wallet = await f.store.get(playerKey(a, 'WALLET'));
    expect(await f.store.get(playerKey(b, `FRIEND_HELP#${eventId}`))).toMatchObject({
      activityExpiresAt: Date.parse(occurredAt) / 1000 + 30 * 86400,
    });
    f.tick(24 * 3600 * 1000);
    expect((await f.activity(b).activity(principal(b), {})).events).toEqual([]);
    await expect(f.thanks(b, eventId)).rejects.toMatchObject({code: 'HELP_EVENT_EXPIRED'});
    expect((await f.unread()).entries).toHaveLength(1);
    await f.store.commit([{ remove: playerKey(b, `FRIEND_HELP#${eventId}`) }]);
    expect(await f.repair(requestId)).toEqual(result);
    expect(await f.store.get(playerKey(b, 'PROGRESS'))).toEqual(progress);
    expect(await f.store.get(playerKey(a, 'WALLET'))).toEqual(wallet);
  });

  it('atomically sends exactly one thanks per original event and preserves RAID feed entries', async () => {
    const f = await helpFixture();
    const first = await f.repair(), second = await f.repair();
    const firstId = first.event.eventId, secondId = second.event.eventId;
    await expect(f.thanks(a,firstId)).rejects.toMatchObject({code:'HELP_EVENT_NOT_FOUND'});
    await expect(f.thanks(c,firstId)).rejects.toMatchObject({code:'HELP_EVENT_NOT_FOUND'});
    await expect(f.api(b,'POST /friends/help/thanks',{}, {eventId:firstId,message:'Hello'}))
      .rejects.toMatchObject({code:'INVALID_REQUEST'});
    const clover = (await f.visit()).clover;
    const raid = { ...playerKey(a,'INCOMING#WALLET_RAID#0001'),
      journeyPK:`FEED#${a}`, journeySK:`${new Date(today-1000).toISOString()}#raid`,
      actorType:'BOT', actorId:'player_1001', targetType:'PLAYER', targetPlayerId:a, outcome:'HIT',
      stolenYP:10, occurredAt:new Date(today-1000).toISOString() };
    f.store.rows.set(key(raid),raid);
    const failedCommit = vi.spyOn(f.store, 'commit').mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.thanks(b,firstId)).rejects.toThrow('Unavailable');
    failedCommit.mockRestore();
    expect(await f.store.get(playerKey(b,`FRIEND_HELP#${firstId}`))).toMatchObject({thanked:false});
    expect((await f.activity(a).activity(principal(a),{limit:20})).events).toHaveLength(1);
    expect(await Promise.all([f.thanks(b,firstId),f.thanks(b,firstId)])).toEqual([{thanked:true},{thanked:true}]);
    const received = await f.activity(a).activity(principal(a),{limit:20});
    expect(received.events).toHaveLength(2);
    expect(received.events[0]).toMatchObject({type:'FRIEND_HELP_THANKS',originalHelpEventId:firstId,
      sender:{id:b,nickname:'Camel 1',avatarId:'camel'},message:'Thanks for helping my Village!'});
    expect(received.events[1]).toMatchObject({type:'RAID',stolenYP:10});
    const page = await f.activity(a).activity(principal(a),{limit:1});
    expect(page.events).toEqual([received.events[0]]);
    expect((await f.activity(a).activity(principal(a),{limit:1,cursor:page.nextCursor!})).events)
      .toEqual([received.events[1]]);
    expect(received.events[0]).not.toHaveProperty('thanked');
    await expect(f.thanks(a,firstId)).rejects.toMatchObject({code:'HELP_EVENT_NOT_FOUND'});
    expect(await f.thanks(b,secondId)).toEqual({thanked:true});
    expect((await f.activity(b).activity(principal(b),{limit:20})).events).toEqual([
      expect.objectContaining({thanked:true}),expect.objectContaining({thanked:true}),
    ]);
    expect((await f.activity(a).activity(principal(a),{limit:20})).events).toHaveLength(3);
    expect((await f.visit()).clover).toEqual(clover);
  });

  it('recharges clover offline and retains the existing timer below capacity', async () => {
    const f = await helpFixture();
    const charge = 4 * 60 * 60 * 1000;
    expect(cloverState(undefined,today)).toMatchObject({remaining:5,nextAt:null});
    expect(cloverState({...playerKey(a,'CLOVER'),remaining:2,anchor:today},today + 2 * charge))
      .toMatchObject({remaining:4,anchor:today + 2 * charge});
    expect(cloverState({...playerKey(a,'CLOVER'),remaining:2,anchor:today},today + 3 * charge))
      .toMatchObject({remaining:5,nextAt:null});
    const empty = {...playerKey(a,'FRIEND_HELP_CLOVER'),remaining:0,anchor:today,version:1};
    f.store.rows.set(key(empty),empty);
    await expect(f.repair()).rejects.toMatchObject({code:'NO_CLOVER'});
    expect((await f.unread()).entries).toEqual([]);
    f.tick(charge);
    const helped = await f.repair();
    expect(helped.clover).toMatchObject({remaining:0,anchor:today + charge});
    f.tick(charge);
    expect((await f.repair()).clover).toMatchObject({remaining:0,anchor:today + 2 * charge});
  });

  it.each([25, 72, 168])('allows HELP %i hours after an attack while the building remains damaged', async hours => {
    const f = await helpFixture(1);
    const elapsed = hours * 60 * 60 * 1000;
    f.tick(elapsed);
    expect((await f.api(a,'GET /friends/help')).entries).toMatchObject([{targetId:b,damagedBuildingCount:1}]);
    expect((await f.visit()).repairs).toMatchObject([{eligible:true}]);
    const {event} = await f.repair();
    expect(event.occurredAt).toBe(new Date(today + elapsed).toISOString());
  });

  it('keeps the discount and blocks repeat help through successive attacks until owner repair', async () => {
    const f = await helpFixture(1);
    const progressKey = playerKey(b, 'PROGRESS');
    const first = await f.repair();
    const afterHelp = decodeProgress((await f.store.get(progressKey))!);
    const damage = afterHelp.villageDamage!;
    const updateDamage = (villageDamage: typeof afterHelp.villageDamage) => {
      const {villageDamage: previous, ...progress} = afterHelp;
      f.store.rows.set(key(progressKey), {...progressKey,...progress,version:++afterHelp.version,
        ...(villageDamage ? {villageDamage} : {})});
    };
    f.tick(7 * 24 * 60 * 60 * 1000);
    updateDamage({...damage,buildings:{'building-1':'2'}});
    expect((await f.visit()).repairs).toMatchObject([{attackId:'2',eligible:false,cost:first.event.remainingCost}]);
    expect((await f.api(a,'GET /friends/help')).entries).toEqual([]);
    await expect(f.repair()).rejects.toMatchObject({code:'NO_HELP_ELIGIBLE_DAMAGE'});
    expect((await f.unread()).entries).toHaveLength(1);

    updateDamage(undefined);
    expect((await f.api(a,'GET /friends/help')).entries).toEqual([]);
    expect((await f.visit()).repairs).toEqual([]);
    await expect(f.repair()).rejects.toMatchObject({code:'NO_HELP_ELIGIBLE_DAMAGE'});

    updateDamage({worldRunId:damage.worldRunId,village:damage.village,buildings:{'building-1':'3'}});
    expect((await f.api(a,'GET /friends/help')).entries).toMatchObject([{damagedBuildingCount:1}]);
    expect((await f.visit()).repairs).toMatchObject([{attackId:'3',eligible:true}]);
    const second = await f.repair();
    expect(second.event).toMatchObject({attackId:'3',savedYP:first.event.savedYP});
    await expect(f.repair()).rejects.toMatchObject({code:'NO_HELP_ELIGIBLE_DAMAGE'});
    expect((await f.unread()).entries).toHaveLength(2);
  });

  it('charges only one helper when two accepted friends race for a single damage', async () => {
    const f = await helpFixture(1);
    const [ownerCode, helperCode] = await Promise.all([f.service.code(b),f.service.code(c)]);
    const invite = await f.send(c,ownerCode);
    await f.action(b,helperCode,invite.requestId,'accept');
    const pair = await Promise.allSettled([f.repair(),f.api(c,'POST /friends/help/repair',{}, {targetId:b,requestId:randomUUID()})]);
    expect(pair.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.unread()).entries).toHaveLength(1);
    expect([...(f.store.rows.values())].filter(row => row.SK === 'FRIEND_HELP_CLOVER')).toHaveLength(1);
    const row = await f.store.get(playerKey(b,'PROGRESS'));
    expect(decodeProgress(row!).villageDamage?.buildings).toEqual({'building-1':'1'});
  });
});

describe('Friends API', () => {
  it('allocates one stable code per player and retries a competing claim', async () => {
    const codes = ['YAL-AAA-AAA','YAL-AAA-AAA','YAL-BBB-BBB','YAL-CCC-CCC'];
    const {api,service} = fixture(() => codes.shift()!);
    const [mine, theirs] = await Promise.all([service.code(a),service.code(b)]);
    expect(new Set([mine,theirs]).size).toBe(2);
    expect(await service.code(a)).toBe(mine);
    expect(await api(a,'GET /friends/search',{ code: ' ' + theirs.toLowerCase() + ' ' }))
      .toEqual({ code:theirs,nickname:'Camel 1',avatarId:'camel',type:'PLAYER',me:false,status:null });
    expect(await service.invite(theirs)).toEqual({ code:theirs,nickname:'Camel 1' });
  });

  it('serializes opposite requests, protects ownership and makes accept/remove retryable', async () => {
    const {service,send,action,api} = fixture();
    const [ca,cb] = await Promise.all([service.code(a),service.code(b)]);
    await expect(send(a,ca)).rejects.toMatchObject({code:'CANNOT_ADD_SELF'});
    const outcomes = await Promise.allSettled([send(a,cb),send(b,ca)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const sender = outcomes[0]?.status === 'fulfilled' ? a : b;
    const recipient = sender === a ? b : a;
    const senderCode = sender === a ? ca : cb;
    const recipientCode = sender === a ? cb : ca;
    const incoming = await api(recipient,'GET /friends/requests/incoming');
    expect(incoming.entries).toHaveLength(1);
    const requestId = incoming.entries[0].requestId;
    expect((await api(sender,'GET /friends/requests/outgoing')).entries[0].requestId).toBe(requestId);
    await expect(action(sender,recipientCode,requestId,'accept')).rejects.toMatchObject({status:403});
    await Promise.all([action(recipient,senderCode,requestId,'accept'), action(recipient,senderCode,requestId,'accept')]);
    expect(await api(recipient,'GET /friends/count')).toEqual({count:0});
    for (const member of [a,b]) expect((await api(member,'GET /friends/rank')).entries).toHaveLength(2);
    await action(sender,recipientCode,requestId,'remove');
    await action(sender,recipientCode,requestId,'remove');
    for (const member of [a,b]) expect((await api(member,'GET /friends/rank')).entries).toHaveLength(1);
  });

  it('uses fresh request IDs after decline or cancel and preserves original send retries', async () => {
    const {service,send,action} = fixture();
    const [ca,cb] = await Promise.all([service.code(a),service.code(b)]);
    const idempotencyKey = randomUUID();
    const first = await send(a,cb,idempotencyKey);
    await expect(send(a,cb)).rejects.toMatchObject({ code:'REQUEST_PENDING' });
    expect(await send(a,cb,idempotencyKey)).toEqual(first);
    await action(b,ca,first.requestId,'decline');
    const second = await send(a,cb);
    await action(a,cb,second.requestId,'cancel');
    expect((await send(a,cb)).requestId).not.toBe(first.requestId);
    await expect(action(b,ca,first.requestId,'accept')).rejects.toMatchObject({status:404});
  });

  it('recommends real players and keeps suggestion requests pending until the recipient accepts', async () => {
    const {api,send,action,service,distances} = fixture();
    distances.set(c,'10');
    const [ca,cb,cc] = await Promise.all([service.code(a),service.code(b),service.code(c)]);
    expect((await api(a,'GET /friends/suggested')).entries.map((entry: Item) => entry.code)).toEqual([cb,cc]);
    await expect(send(a,bot)).rejects.toMatchObject({status:404});
    for (const [recipient,code] of [[b,cb],[c,cc]] as const) {
      const {status,requestId} = await send(a,code);
      expect(status).toBe('PENDING');
      expect((await api(recipient,'GET /friends/requests/incoming')).entries[0])
        .toMatchObject({code:ca,requestId});
      expect((await api(a,'GET /friends/rank')).entries.some((entry: Item) => entry.code === code)).toBe(false);
      expect((await api(a,'GET /friends/suggested')).entries.some((entry: Item) => entry.code === code)).toBe(false);
      await action(recipient,ca,requestId,'accept');
    }
    const page = await api(a,'GET /friends/list',{limit: '1'});
    const next = await api(a,'GET /friends/list',{limit: '1', cursor:page.nextCursor});
    expect(next.entries[0].code).not.toBe(page.entries[0].code);
    expect(next.nextCursor).toBeNull();
  });

  it('lists only accepted friends with current village damage, even after an empty page', async () => {
    const {api,send,action,service,store} = fixture();
    const [ca,cb,cc] = await Promise.all([service.code(a),service.code(b),service.code(c)]);
    const progress = newSave().progress;
    const damaged = { ...progress, villageDamage: {
      worldRunId: progress.worldRunId, village: progress.village, buildings: {'building-1':'1','building-2':'2'},
    }};
    for (const player of [b,c]) {
      const row = { ...playerKey(player,'PROGRESS'), ...damaged };
      store.rows.set(key(row),row);
    }
    const first = await send(a,cb);
    const second = await send(a,cc);
    await action(c,ca,second.requestId,'decline');
    expect(await api(a,'GET /friends/help')).toEqual({entries:[],nextCursor:null});
    expect((await api(a,'GET /friends/rank')).entries).toHaveLength(1);
    await action(b,ca,first.requestId,'accept');
    expect((await api(a,'GET /friends/help')).entries).toEqual([
      {code:cb,nickname:'Camel 1',avatarId:'camel',type:'PLAYER',targetId:b,damagedBuildingCount:2},
    ]);

    const retry = await send(a,cc);
    await action(c,ca,retry.requestId,'accept');
    const [stale,active] = first.requestId < retry.requestId ? [b,c] : [c,b];
    const row = { ...playerKey(stale,'PROGRESS'), ...damaged, village: 2 };
    store.rows.set(key(row),row);
    const page = await api(a,'GET /friends/help',{limit:1});
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeTruthy();
    const next = await api(a,'GET /friends/help',{limit:1,cursor:page.nextCursor});
    expect(next.entries[0]).toMatchObject({code:await service.code(active),damagedBuildingCount:2});
    expect(next.nextCursor).toBeNull();
  });

  it('attributes only eligible new players and atomically keeps the first inviter', async () => {
    const {service,store,send} = fixture();
    const [ca,cb] = await Promise.all([service.code(a),service.code(b)]);
    await Promise.all([send(c,ca,randomUUID(),true),send(c,cb,randomUUID(),true)]);
    const ref = await store.get(playerKey(c,'FRIENDS#REFERRAL'));
    expect(ref).toMatchObject({ inviteePlayerId:c,status:'ATTRIBUTED',rewardStatus:'NOT_AWARDED' });
    expect([a,b]).toContain(ref?.inviterPlayerId);
    await send(d,cb,randomUUID(),true);
    expect(await store.get(playerKey(d,'FRIENDS#REFERRAL'))).toBeUndefined();
  });

  it('requires authentication for Friends routes and exposes only public invite fields', async () => {
    const {service} = fixture();
    const code = await service.code(a);
    const handler = createHandler({} as PlayerService, async () => { throw new ApiError(401,'UNAUTHENTICATED'); },
      undefined,undefined,undefined,undefined,undefined,undefined,undefined,service);
    const context = { http:{method:'GET'} };
    expect((await handler({rawPath:'/friends/code',requestContext:context})).statusCode).toBe(401);
    const response = await handler({rawPath:'/invites/'+code,requestContext:context});
    expect(JSON.parse(response.body)).toEqual({code,nickname:'Camel 0'});
  });

  it('maps a real DynamoDB conditional conflict to a retryable transaction result', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error(), {name:'TransactionCanceledException',
      CancellationReasons:[{Code:'ConditionalCheckFailed'}]}));
    const store = new DynamoFriendsStore({send} as unknown as DynamoDBDocumentClient,'Players');
    expect(await store.commit([{item:{PK:'FRIENDS#CODES',SK:'YAL-ABC-DEF'},expected:null}])).toBe(false);
    expect(send.mock.calls[0]?.[0].input.TransactItems[0].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});

describe('Friend rank notification integration', () => {
  const policy = notificationPolicy.parse(JSON.parse(readFileSync('config/dev/notifications.json','utf8')));
  const now = today + 60_000;
  const when = new Date(now).toISOString();
  const scores = (values: Record<string,string>) => async (player: string) => scaled(values[player] ?? '0');
  it('publishes a stable scoped event from the settlement stream even while APNs is disabled', async () => {
    const {service,store,send,action} = fixture();
    const {requestId} = await send(a,await service.code(b));
    await action(b,await service.code(a),requestId,'accept');
    const publish = vi.fn();
    const keys = {PK:'PLAYER#'+a,SK:'ROUND#'+randomUUID()};
    const record = { eventName:'MODIFY', dynamodb:{ SequenceNumber:'1',
      OldImage:marshall({...keys,status:'PENDING'}),
      NewImage:marshall({...keys,status:'SETTLED',settledAt:when,rankDistance:'9'}),
    }};
    const crossings = (change: NonNullable<ReturnType<typeof settlementChange>>) =>
      friendCrossings(store,scores({[a]:'15',[b]:'10'}),change,7,now);
    expect(await routeNotifications([record,record],publish,policy,undefined,crossings)).toEqual({batchItemFailures:[]});
    const first = publish.mock.calls[0]?.[0];
    expect(first).toMatchObject({recipientPlayerId:b,eventType:'RANK_OVERTAKEN',payload:{scope:'FRIENDS',rank:2}});
    expect(publish.mock.calls[1]?.[0]).toEqual(first);
    expect(notificationMessage(first,policy).body).toBe("Camel 0 passed you! You're now #2.");
  });

  it('skips ties, rollover, newly added friends, and moved relationships, and can simulate a DEV bot', async () => {
    const {store,action,tick,api} = fixture();
    const requestId = seedAcceptedBot(store,a,today);
    expect((await api(a,'GET /friends/rank')).entries).toContainEqual(expect.objectContaining({code:bot}));
    expect(await api(a,'GET /friends/help')).toEqual({entries:[],nextCursor:null});
    const change = {actor:bot,round:randomUUID(),occurredAt:when,added:scaled('9')};
    const data = scores({[bot]:'15',[a]:'10'});
    expect(await friendCrossings(store,data,change,7,now)).toEqual([]);
    expect(await friendCrossings(store,data,change,7,now,true)).toHaveLength(1);
    expect(await friendCrossings(store,scores({[bot]:'10',[a]:'10'}),change,7,now,true)).toEqual([]);
    expect(await friendCrossings(store,data,change,7,Date.parse('2026-11-23T00:00:00Z'),true)).toEqual([]);
    tick(70_000);
    await action(a,bot,requestId,'remove');
    seedAcceptedBot(store,a,today + 70_000);
    expect(await friendCrossings(store,data,change,7,now,true)).toEqual([]);
  });

  it('uses the existing delivery deduplication and 60-minute cooldown', async () => {
    const {store} = fixture();
    seedAcceptedBot(store,a,today);
    const [event] = await friendCrossings(store,scores({[bot]:'15',[a]:'10'}),
      {actor:bot,round:randomUUID(),occurredAt:when,added:scaled('9')},7,now,true);
    const conflict = () => Promise.reject(Object.assign(new Error(),{name:'ConditionalCheckFailedException'}));
    const seen = new Map();
    const device = {deviceId:'ios', SK:'PUSH#DEVICE#ios', active:true, environment:'sandbox', revision:'1', token:'token'};
    const commands = vi.fn(async command => {
      const { Item, Key } = command.input;
      if (command.constructor.name === 'QueryCommand') return {Items:[device]};
      if (command.constructor.name === 'GetCommand') {
        if (Key.SK === device.SK) return {Item:device};
        if (Key.PK === 'SYSTEM#PUSH_INSTALLATION') return {Item:{player:a,revision:'1'}};
        return {Item:{state:'ACCEPTED'}};
      }
      if (command.constructor.name === 'PutCommand') {
        const previous = seen.get(Item.SK);
        if (previous && (Item.SK.startsWith('PUSH#DELIVERY#') || Item.eventId !== previous.eventId)) return conflict();
        seen.set(Item.SK,Item);
      }
      return {};
    });
    const apns = vi.fn().mockResolvedValue(200);
    const deliver = worker({send:commands} as unknown as DynamoDBDocumentClient,'Players',{...policy,remoteEnabled:true},apns);
    await deliver(event!);
    await deliver(event!);
    await deliver({...event!,eventId:'another-crossing'});
    expect(apns).toHaveBeenCalledTimes(1);
    const cooldown = seen.get('PUSH#COOLDOWN#RANK_OVERTAKEN');
    expect(cooldown.until - Math.floor(Date.now()/1000)).toBeGreaterThanOrEqual(3599);
  });
});
