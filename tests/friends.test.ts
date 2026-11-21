import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOTS } from '../src/bots-config.js';
import { FriendsService } from '../src/friends.js';
import { DynamoFriendsStore, type FriendsStore, type Item, type Key, type Write } from '../src/friends-store.js';
import { createHandler } from '../src/handler.js';
import { friendCrossings, settlementChange } from '../src/friend-overtake.js';
import { rankingPeriod } from '../src/journey-read.js';
import { scaled } from '../src/drop-economy.js';
import { notificationMessage, notificationPolicy } from '../src/notification-events.js';
import { routeNotifications } from '../src/notification-router.js';
import { ApiError, playerKey } from '../src/repository.js';
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
    const targets = writes.map(write => key('item' in write ? write.item : write.remove));
    if (new Set(targets).size !== targets.length) throw Error('duplicate DynamoDB transaction key');
    for (const write of writes) {
      if (!('item' in write) || write.expected === undefined) continue;
      const current = this.rows.get(key(write.item));
      if (write.expected === null ? current : current?.revision !== write.expected) return false;
    }
    for (const write of writes) {
      if ('remove' in write) this.rows.delete(key(write.remove));
      else this.rows.set(key(write.item),write.item);
    }
    return true;
  }
}

function fixture(dev = true, mint?: () => string) {
  const store = new Memory();
  let now = today;
  const distances = new Map([[a,'30.0001'],[b,'20'],[bot,'20']]);
  for (const [index, player] of players.entries()) {
    const profile = playerKey(player,'PROFILE');
    store.rows.set(key(profile),{ ...profile, nickname: `Camel ${index}`, avatarId: 'camel',
      migrationState: 'new', createdAt: new Date(now - (player === d ? 172_800_000 : 5_000)).toISOString() });
  }
  const service = new FriendsService(store,{find:async p => players.includes(p.subject) ? p.subject : undefined},
    {currentPeriodDistances: async ids => ({
      period: rankingPeriod(now,7),
      distances: new Map(ids.filter(id => distances.has(id)).map(id => [id,distances.get(id)!])),
    })}, {load: async () => DEFAULT_BOTS},dev,() => now,mint);
  const api = async (player: string, route: string, query = {}, body = {}): Promise<any> => service.route(principal(player),route,query,() => body);
  const send = async (sender: string, target: string, requestId = randomUUID(), referral = false) =>
    api(sender,'POST /friends/requests',{}, {code: target,requestId,referral});
  const action = async (player: string, code: string, requestId: string, action: string) =>
    api(player,'POST /friends/actions',{}, {code,requestId,action});
  return { store, service, api, send, action, distances, tick: (ms:number) => {now += ms;} };
}

describe('Friends API', () => {
  it('allocates one stable code per player and retries a competing claim', async () => {
    const codes = ['YAL-AAA-AAA','YAL-AAA-AAA','YAL-BBB-BBB','YAL-CCC-CCC'];
    const {api,service} = fixture(true,() => codes.shift()!);
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

  it('pages friends and only recommends configured unconnected DEV bots', async () => {
    const {api,send,action,distances} = fixture();
    const suggestions = (await api(a,'GET /friends/suggested')).entries;
    expect(suggestions).toHaveLength(10);
    expect((await api(a,'GET /friends/suggested')).entries).toEqual(suggestions);
    const first = await send(a,suggestions[0].code);
    expect(first.status).toBe('ACCEPTED');
    await send(a,suggestions[1].code);
    const page = await api(a,'GET /friends/list',{limit: '1'});
    expect(page.entries).toHaveLength(1);
    const next = await api(a,'GET /friends/list',{limit: '1', cursor:page.nextCursor});
    expect(next.entries[0].code).not.toBe(page.entries[0].code);
    expect(next.nextCursor).toBeNull();
    distances.set(bot,'99');
    expect((await api(a,'GET /friends/rank')).entries[0]).toMatchObject({ code:bot,distanceMeters:'99',rank:1,me:false });
    await action(a,bot,first.requestId,'remove');
    expect((await api(a,'GET /friends/suggested')).entries).toHaveLength(8);
    const live = fixture(false);
    expect(await live.api(a,'GET /friends/suggested')).toEqual({entries:[]});
    await expect(live.send(a,bot)).rejects.toMatchObject({status:404});
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
    const {store,send,action,tick} = fixture();
    const linked = await send(a,bot);
    const change = {actor:bot,round:randomUUID(),occurredAt:when,added:scaled('9')};
    const data = scores({[bot]:'15',[a]:'10'});
    expect(await friendCrossings(store,data,change,7,now)).toEqual([]);
    expect(await friendCrossings(store,data,change,7,now,true)).toHaveLength(1);
    expect(await friendCrossings(store,scores({[bot]:'10',[a]:'10'}),change,7,now,true)).toEqual([]);
    expect(await friendCrossings(store,data,change,7,Date.parse('2026-11-23T00:00:00Z'),true)).toEqual([]);
    tick(70_000);
    await action(a,bot,linked.requestId,'remove');
    await send(a,bot);
    expect(await friendCrossings(store,data,change,7,now,true)).toEqual([]);
  });

  it('uses the existing delivery deduplication and 60-minute cooldown', async () => {
    const {store,send} = fixture();
    await send(a,bot);
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
