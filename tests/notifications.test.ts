import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import { notificationMessage, notificationPolicy, receiptNotification } from '../src/notification-events.js';
import { routeNotifications } from '../src/notification-router.js';
import { dispatchBatch, worker } from '../src/notification-worker.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const player='d73ac596-a7b2-48dc-b5cf-c6af3c42fcf1';
const when='2026-11-19T10:00:00.000Z';
const policy=notificationPolicy.parse(JSON.parse(readFileSync('config/dev/notifications.json','utf8')));
const raid={actorType:'BOT',targetType:'PLAYER',actorId:'player_1001',targetPlayerId:player,
  occurredAt:when,outcome:'HIT',stolenYP:230};
const raidKey='INCOMING#WALLET_RAID#0001';
const event=receiptNotification(player,raidKey,raid)!;

describe('notification hub',()=>{
  it('maps only actual stored harm and never exposes a bot ID as display copy',()=>{
    expect(event).toMatchObject({eventType:'RAID_STOLEN',recipientPlayerId:player,payload:{stolenYP:230}});
    expect(notificationMessage(event,policy).body).toBe('A rival stole 230 YP from you!');
    expect(receiptNotification(player,raidKey,{...raid,outcome:'MISS',stolenYP:0})).toBeUndefined();
    expect(receiptNotification(player,'WALLET',raid)).toBeUndefined();
    const base={actorId:'player_1001',actorDisplayName:'Desert Bandit',occurredAt:when};
    const hit=receiptNotification(player,'INCOMING#RECEIPT#0001',{...base,outcome:'HIT',buildingId:'building-1',buildingName:'Shelter'})!;
    expect(notificationMessage(hit,policy).body).toBe('Desert Bandit damaged your Shelter!');
    expect(receiptNotification(player,'INCOMING#RECEIPT#0002',{...base,outcome:'BLOCKED',shieldConsumed:true})?.eventType).toBe('ATTACK_BLOCKED');
    expect(receiptNotification(player,'INCOMING#RECEIPT#0002',{...base,outcome:'BLOCKED',shieldConsumed:false})).toBeUndefined();
  });

  it('acknowledges irrelevant stream records and retries only failed publishes',async()=>{
    const record=(id:string,SK:string,eventName='INSERT')=>({eventName,dynamodb:{SequenceNumber:id,
      NewImage:marshall({PK:'PLAYER#'+player,SK,...raid})}});
    const publish=vi.fn().mockRejectedValue(new Error('SQS unavailable'));
    expect(await routeNotifications([record('1',raidKey),record('2','WALLET'),record('3',raidKey,'MODIFY')],publish,{...policy,remoteEnabled:true}))
      .toEqual({batchItemFailures:[{itemIdentifier:'1'}]});
    expect(publish).toHaveBeenCalledOnce();
  });

  it('keeps the disabled worker safe and reports only failed SQS records',async()=>{
    const send=vi.fn();
    await worker({send} as unknown as DynamoDBDocumentClient,'table',policy,vi.fn())(event);
    expect(send).not.toHaveBeenCalled();
    expect(await dispatchBatch([{messageId:'ok',body:JSON.stringify(event)},{messageId:'bad',body:'{}'}],async()=>{}))
      .toEqual({batchItemFailures:[{itemIdentifier:'bad'}]});
  });

  it('ignores distance settlements with remote policy enabled',async()=>{
    const publish=vi.fn();
    const round={eventName:'MODIFY',dynamodb:{SequenceNumber:'1',NewImage:marshall({
      PK:'PLAYER#'+player,SK:'ROUND#closed',status:'SETTLED',journeyPK:'DISTANCE#DELTA',settledAt:when})}};
    expect(await routeNotifications([round,{...round,eventName:'INSERT'}],publish,{...policy,remoteEnabled:true}))
      .toEqual({batchItemFailures:[]});
    expect(publish).not.toHaveBeenCalled();
  });

  it('pages across retained history and returns the three supported outcomes',async()=>{
    const {JourneyReadService,rankingPeriod}=await import('../src/journey-read.js');
    expect(rankingPeriod(Date.parse(when),7).startsAt).toBe('2026-11-16T00:00:00.000Z');
    const PK='PLAYER#'+player;
    const items=[
      {SK:'ACTIVITY#RANK#older1',journeySK:'6'},
      {SK:'ACTIVITY#RANK#older2',journeySK:'5'},
      {SK:'INCOMING#RECEIPT#0001',journeySK:'4',actorId:'player_1001',timestamp:when,outcome:'HIT',buildingId:'building-1'},
      {SK:'INCOMING#RECEIPT#0002',journeySK:'3',actorId:'player_1001',timestamp:when,outcome:'BLOCKED',shieldConsumed:true},
      {SK:raidKey,journeySK:'2',...raid},
    ].map(row=>({...row,PK}));
    const service=new JourneyReadService({find:async()=>player},{
      get:async(_id,sk)=>items.find(row=>row.SK===sk),
      index:async({bounds,limit})=>({rows:items.filter(row=>!bounds?.before||row.journeySK<bounds.before).slice(0,limit),count:0}),
    },7);
    const principal={provider:'guest' as const,subject:'viewer'};
    const first=await service.activity(principal,{limit:1});
    expect(first.events.map(e=>e.outcome)).toEqual(['HIT']);
    const second=await service.activity(principal,{limit:2,cursor:first.nextCursor!});
    expect(second.events.map(e=>e.outcome)).toEqual(['BLOCKED','STOLEN']);
    expect(second.nextCursor).toBeNull();
  });
});
