import { describe, expect, it, vi } from 'vitest';
import { QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDropStore } from '../src/drop.js';
import { DynamoIncomingStore } from '../src/incoming-raid.js';
import { createHandler, type HttpEvent } from '../src/handler.js';
import { DynamoJourneyReadStore, JourneyReadService, rankingPeriod, type JourneyReadStore } from '../src/journey-read.js';
import { activityFeedItem, journeyReadKeys, privateActivity } from '../src/journey-read-keys.js';
import { newSave, type Principal } from '../src/model.js';
import type { PlayerService } from '../src/service.js';

import { loadActivityPolicy, type ActivityPolicy } from '../src/activity-policy.js';

const now = Date.parse('2026-11-19T12:00:00.000Z');
const signedIn = (subject:string):Principal => ({ provider:'guest', subject });
function fixture(policy = loadActivityPolicy(), clock = () => now) {
  const first = newSave(), second = newSave(), third = newSave();
  const [a,b,c] = [first,second,third].map(save=>save.profile.playerId) as [string,string,string];
  const items = new Map<string,Record<string,any>>();
  const put = (player:string, key:string, value:Record<string,any>) =>
    items.set(`PLAYER#${player}/${key}`, { ...value, ...journeyReadKeys(player,key,value), PK:`PLAYER#${player}`, SK:key });
  for (const [index, save] of [first,second,third].entries()) {
    put(save.profile.playerId,'PROFILE',{ ...save.profile, nickname:`Guest 000${index+1}` });
    put(save.profile.playerId,'PROGRESS',{ ...save.progress, distance:index<2?'2100.1':'4100.01' });
  }
  const store:JourneyReadStore = {
    get: async (id,key)=>items.get(`PLAYER#${id}/${key}`),
    index: async ({partition,bounds,limit,count,start}) => {
      const rows = [...items.values()].filter(row=>row.journeyPK===partition &&
        (!start || row.journeySK<start.journeySK) &&
        (!bounds?.atOrAfter || row.journeySK>=bounds.atOrAfter) &&
        (!bounds?.before || row.journeySK<bounds.before) && (!bounds?.after || row.journeySK>bounds.after) &&
        (!bounds?.range || row.journeySK>=bounds.range[0] && row.journeySK<=bounds.range[1]))
        .sort((left,right)=>left.journeySK>right.journeySK?-1:1);
      return {count:rows.length, rows:count?[]:rows.slice(0,limit??rows.length).map(row=>({
        PK:row.PK,SK:row.SK,journeySK:row.journeySK,rankDistance:row.rankDistance,
      }))};
    },
  };
  const read = new JourneyReadService({find:async p=>[a,b,c].includes(p.subject)?p.subject:undefined},store,1,clock,policy);
  return {a,b,c,put,read};
}
const attack = (player:string, sequence:number, outcome:'HIT'|'BLOCKED', occurredAt = '2026-11-19T10:00:00Z') => ({
  outcome, occurredAt, botId:'player_1001', targetPlayerId:player, eventId:`ATTACK:${player}:${sequence}`,
  worldId:'dunes', ...(outcome==='HIT'?{buildingId:'building-1', levelBefore:4, levelAfter:3}:{}), shieldConsumed:outcome==='BLOCKED',
});
describe('Journey read APIs',()=>{
  it('ranks exact all-time distances with a stable tie break and my rank on every page',async()=>{
    const {a,b,c,read}=fixture();
    const first=await read.ranking(signedIn(a),{scope:'total',limit:1});
    expect(first.entries[0]).toMatchObject({playerId:c,rank:1,distanceMeters:'4100.01'});
    const second=await read.ranking(signedIn(a),{scope:'total',limit:2,cursor:first.nextCursor!});
    expect(second.entries.map(row=>row.playerId)).toEqual([a,b].sort().reverse());
    expect(second.entries.map(row=>row.rank)).toEqual([2,3]);
    expect(first.me).toEqual(second.me);
    expect(second.nextCursor).toBeNull();
  });
  it('excludes zero meters from both boards, counts, cursors and the caller rank',async()=>{
    const {a,b,c,read,put}=fixture();
    const progress=newSave().progress;
    put(a,'PROGRESS',{...progress,distance:'0'});
    put(b,'PROGRESS',{...progress,distance:'0.0000000000000000000000000001'});
    put(a,'ROUND#zero',{status:'SETTLED',settledAt:'2026-11-19T11:00:00Z',reward:{distance:'0'}});
    put(b,'ROUND#positive',{status:'SETTLED',settledAt:'2026-11-19T11:00:00Z',reward:{distance:'5'}});
    const first=await read.ranking(signedIn(a),{scope:'total',limit:1});
    expect(first.participantCount).toBe(2);
    expect(first.me).toMatchObject({rank:null,distanceMeters:'0'});
    expect(first.entries.map(row=>row.playerId)).toEqual([c]);
    const last=await read.ranking(signedIn(b),{scope:'total',limit:1,cursor:first.nextCursor!});
    expect(last.entries).toMatchObject([{playerId:b,rank:2}]);
    expect(last.me.rank).toBe(2);
    expect(last.nextCursor).toBeNull();
    const period=await read.ranking(signedIn(a),{scope:'period',limit:1});
    expect(period.participantCount).toBe(1);
    expect(period.me.rank).toBeNull();
    expect(period.entries).toMatchObject([{playerId:b,rank:1}]);
    expect(period.nextCursor).toBeNull();
  });
  it('uses only the immutable settled round delta across UTC boundaries and preserves old periods',async()=>{
    const {a,b,put,read}=fixture();
    const round=(status:string,settledAt:string,distance:string)=>({status,settledAt,reward:{distance}});
    put(a,'ROUND#last',round('SETTLED','2026-11-18T23:59:59.999Z','200'));
    const confirmed=round('SETTLED','2026-11-19T00:00:00.000Z','25');
    put(a,'ROUND#confirmed',confirmed);
    put(a,'ROUND#confirmed',confirmed);
    put(a,'ROUND#pending',round('ISSUED','2026-11-19T00:00:01Z','1000'));
    put(b,'ROUND#second',round('SETTLED','2026-11-19T11:59:59Z','50'));
    put(a,'ROUND#next',round('SETTLED','2026-11-20T00:00:00.000Z','300'));
    const current=await read.ranking(signedIn(a),{scope:'period',limit:1});
    expect(current.entries[0]).toMatchObject({playerId:b,distanceMeters:'50'});
    expect(current.me).toMatchObject({rank:2,distanceMeters:'25'});
    expect(current.period).toMatchObject({startsAt:'2026-11-19T00:00:00.000Z',endsAt:'2026-11-20T00:00:00.000Z'});
    const page=await read.ranking(signedIn(a),{scope:'period',limit:1,cursor:current.nextCursor!});
    expect(page.entries[0]).toMatchObject({playerId:a,distanceMeters:'25'});
    expect((await read.ranking(signedIn(a),{scope:'period',limit:20,periodStart:'2026-11-18T00:00:00.000Z'})).me.distanceMeters).toBe('200');
    expect((await read.ranking(signedIn(a),{scope:'total',limit:20})).me.distanceMeters).toBe('2100.1');
    expect(rankingPeriod(now,7).startsAt).toBe('2026-11-16T00:00:00.000Z');
  });
  it('returns only owner activity, hides misses and smoke, and pages settled unique events newest first',async()=>{
    const {a,b,read,put}=fixture();
    put(a,'INCOMING#RECEIPT#0001',attack(a,1,'HIT'));
    put(a,'INCOMING#RECEIPT#0002',attack(a,2,'BLOCKED'));
    put(a,'INCOMING#RECEIPT#0003',{...attack(a,2,'BLOCKED'),eventId:`ATTACK:${a}:2`});
    put(b,'INCOMING#RECEIPT#0001',attack(b,1,'HIT'));
    const raid={actorId:'player_1001',actorType:'BOT',targetType:'PLAYER',targetPlayerId:a,occurredAt:'2026-11-19T11:00:00Z',balanceBefore:1200};
    put(a,'INCOMING#WALLET_RAID#0004',{...raid,eventId:`RAID:${a}:4`,stolenYP:360,outcome:'HIT'});
    put(a,'INCOMING#WALLET_RAID#0005',{...raid,eventId:`RAID:${a}:5`,stolenYP:0,outcome:'MISS'});
    put(a,'INCOMING#WALLET_RAID#0006',{...raid,eventId:'DEV-TELEGRAM-SMOKE:fake',stolenYP:360,outcome:'HIT'});
    const result=await read.activity(signedIn(a),{limit:2});
    expect(result.events.map(event=>event.outcome)).toEqual(['STOLEN','BLOCKED']);
    expect(result.events[0]).toMatchObject({stolenYP:360,stolenPercent:30,defender:{id:a,type:'PLAYER',nickname:'Guest 0001'}});
    const next=await read.activity(signedIn(a),{limit:2,cursor:result.nextCursor!});
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({levelBefore:4,levelAfter:3});
    await expect(read.activity(signedIn(b),{limit:2,cursor:result.nextCursor!})).rejects.toMatchObject({status:409});
    expect((await read.activity(signedIn(b),{limit:10})).events).toHaveLength(1);
  });
  it('ignores unfinished outgoing attacks and does not publish bag rewards as stolen YP',()=>{
    const {a}=fixture(), sk='RAID#id';
    const row={ status:'READY', operation:{eventType:'ATTACK'}, result:{
      attackerId:a, attackerEntityType:'LocalPlayer', defenderEntityType:'SystemBot',defenderId:'bot:dunes:v1:player_1001',
      result:'Success',timestamp:'2026-11-19T11:00:00Z',selectedFacilityId:2,
    }};
    expect(privateActivity(a,sk,row)).toBeUndefined();
    expect(privateActivity(a,sk,{...row,status:'SETTLED'})).toMatchObject({type:'ATTACK',outcome:'HIT',buildingId:'building-3'});
    expect(privateActivity(a,sk,{...row,status:'SETTLED',operation:{eventType:'RAID'}})).toBeUndefined();
  });
  it('attaches index metadata inside the original round and incoming settlement transactions',async()=>{
    const {a}=fixture();
    const send=vi.fn(async (_request:TransactWriteCommand)=>({}));
    const client={send} as unknown as DynamoDBDocumentClient;
    const drop=new DynamoDropStore(client,'test-table');
    const progress={...newSave().progress,distance:'25'};
    await drop.commit(a,[{sk:'PROGRESS',value:progress,expectedVersion:1},
      {sk:'ROUND#confirmed',expectedVersion:1,value:{status:'SETTLED',settledAt:'2026-11-19T11:00:00Z',reward:{distance:'25'}}}]);
    const roundWrites=send.mock.calls[0]![0].input.TransactItems!;
    expect(roundWrites.map(w=>w.Put!.Item!.journeyPK)).toEqual(['DISTANCE#TOTAL','DISTANCE#DELTA']);
    expect(roundWrites[1]!.Put!.ConditionExpression).toBe('#v = :v');
    const incoming=new DynamoIncomingStore(client,'test-table');
    await incoming.commit(a,[{sk:'INCOMING#SCHEDULE',value:{sequence:2},expectedVersion:1},
      {sk:'INCOMING#RECEIPT#0001',value:attack(a,1,'BLOCKED')}]);
    const attackWrites=send.mock.calls[1]![0].input.TransactItems!;
    expect(attackWrites[1]!.Put!.Item).toMatchObject({eventId:`ATTACK:${a}:1`});
    expect(attackWrites[1]!.Put!.Item).not.toHaveProperty('activityExpiresAt');
    expect(attackWrites[2]!.Put!.Item).toMatchObject({
      SK:'ACTIVITY_FEED#INCOMING#RECEIPT#0001', journeyPK:`FEED#${a}`, event:{eventId:`ATTACK:${a}:1`},
      activityExpiresAt:Date.parse('2026-12-19T10:00:00Z') / 1000,
    });
    expect(attackWrites[1]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('uses rolling millisecond boundaries across UTC midnight and applies configurable limits', async () => {
    let time = Date.parse('2026-11-19T00:00:01.000Z');
    const policy: ActivityPolicy = {activityDisplayHours:24, activityMaxDisplayCount:50, activityRetentionDays:30};
    const {a,put,read} = fixture(policy, () => time);
    const add = (sequence: number, offset: number) => put(a, `INCOMING#RECEIPT#${sequence}`,
      attack(a,sequence,'HIT',new Date(time + offset).toISOString()));
    add(1, -86400000);
    add(2, -86400000 + 1);
    add(3, -2000);
    add(4, 0);
    add(5, 1);
    const ids = (events: {eventId?: unknown}[]) => events.map(event => event.eventId);
    const eventId = (sequence: number) => `ATTACK:${a}:${sequence}`;
    expect(ids((await read.activity(signedIn(a),{})).events)).toEqual([4,3,2].map(eventId));
    time++;
    expect(ids((await read.activity(signedIn(a),{})).events)).toEqual([5,4,3].map(eventId));
    for (let n=6; n<=61; n++) add(n, -1000 - n);
    const result = await read.activity(signedIn(a),{});
    expect(result.events).toHaveLength(50);
    expect(result.nextCursor).toBeNull();
    const first = await read.activity(signedIn(a),{limit:49});
    const last = await read.activity(signedIn(a),{limit:49,cursor:first.nextCursor!});
    expect(last.events).toEqual(result.events.slice(49));
    expect(last.nextCursor).toBeNull();
    policy.activityDisplayHours = 1;
    policy.activityMaxDisplayCount = 2;
    policy.activityRetentionDays = 2;
    add(62, -3600000);
    expect(ids((await read.activity(signedIn(a),{})).events)).toEqual([5,4].map(eventId));
    policy.activityMaxDisplayCount = 100;
    expect(ids((await read.activity(signedIn(a),{})).events)).not.toContain(eventId(62));
    const feed = activityFeedItem(a,'INCOMING#RECEIPT#1',attack(a,1,'HIT'),policy);
    expect(feed?.activityExpiresAt).toBe(Date.parse('2026-11-21T10:00:00Z') / 1000);
  });

  it('reads the isolated feed projection and ignores logically expired items before DynamoDB deletes them', async () => {
    const policy = {activityDisplayHours:72, activityMaxDisplayCount:50, activityRetentionDays:30};
    const shortRetention = { ...policy, activityRetentionDays:1 };
    const {a,put,read} = fixture(policy);
    const insert = (sequence: number, occurredAt: string) => {
      const key = `INCOMING#RECEIPT#${sequence}`;
      const feed = activityFeedItem(a, key, attack(a,sequence,'BLOCKED',occurredAt), shortRetention)!;
      put(a, feed.SK, feed);
    };
    insert(1, '2026-11-18T12:00:00.000Z');
    insert(2, '2026-11-18T12:00:00.001Z');
    const result = await read.activity(signedIn(a),{});
    expect(result.events).toMatchObject([{
      eventId: `ATTACK:${a}:2`, outcome: 'BLOCKED', displayUntil: '2026-11-19T12:00:01.000Z',
    }]);
    expect(result.events[0]).not.toHaveProperty('activityExpiresAt');
  });

  it('bounds the existing descending GSI Query and skips hydration for an empty window', async () => {
    const send = vi.fn(async (_command: QueryCommand) => ({ Items: [], Count: 0 }));
    const store = new DynamoJourneyReadStore({send} as unknown as DynamoDBDocumentClient, 'table');
    const read = new JourneyReadService({find: async () => 'viewer'}, store, 1, () => now);
    expect((await read.activity(signedIn('viewer'), {})).events).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      IndexName: 'JourneyRead', KeyConditionExpression: 'journeyPK = :pk AND journeySK BETWEEN :low AND :high',
      ExpressionAttributeValues: { ':pk': 'FEED#viewer', ':low': '2026-11-18T12:00:00.001Z',
        ':high': '2026-11-19T12:00:00.000Z$' }, ScanIndexForward: false, Limit: 50,
    });
  });

  it('requires auth and rejects client supplied player IDs at the HTTP boundary',async()=>{
    const {a,read}=fixture();
    const request:HttpEvent = {rawPath:'/players/me/activity',requestContext:{http:{method:'GET'}}};
    const noAuth = createHandler({} as PlayerService);
    expect((await noAuth(request)).statusCode).toBe(401);
    const handler = createHandler({} as PlayerService,async()=>signedIn(a),undefined,undefined,undefined,undefined,undefined,read);
    expect((await handler({...request,queryStringParameters:{playerId:'other'}})).statusCode).toBe(400);
    expect((await handler(request)).statusCode).toBe(200);
  });
});
