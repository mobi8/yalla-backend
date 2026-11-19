import { startWalletRaid, walletRaidDebit, WALLET_RAID_PREFIX } from '../src/incoming-wallet-raid.js';
import { NumberValue } from '@aws-sdk/lib-dynamodb';
import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { botsSchema, DEFAULT_BOTS, DEV_RAID_PLAYER } from '../src/bots-config.js';
import { IncomingRaidService,nextAttackAt,newIncomingSchedule,type IncomingStore } from '../src/incoming-raid.js';
import { isRaidCandidate } from '../src/player-activity.js';
import { newCollection } from '../src/drop-economy.js';
import { currentVillageDamage, newSave } from '../src/model.js';
const config=botsSchema.parse(JSON.parse(readFileSync(new URL('../config/dev/bots.json',import.meta.url),'utf8')));
const t=Date.parse('2026-01-01T12:00:00Z');
function fixture(shields:number, fast=false) {
 let now=t;
 const values=new Map<string,any>([['INCOMING#SCHEDULE',{...newIncomingSchedule(DEV_RAID_PLAYER,t-86400000),dueAt:new Date(t-1000).toISOString()}],['COLLECTION',{...newCollection(new Date(t).toISOString()),shieldCount:shields}]]);
 values.set('PROFILE', {playerId: DEV_RAID_PLAYER});
 values.set('PROGRESS',newSave(new Date(t).toISOString()).progress);
 const db:IncomingStore={get:async(_p,sk)=>{const value=values.get(sk);return value && {...value};},due:async()=>[{playerId:DEV_RAID_PLAYER}],commit:async(_p,writes)=>{
  for(const w of writes) if(w.expectedVersion===undefined?values.has(w.sk):values.get(w.sk)?.version!==w.expectedVersion) {const e=new Error();e.name='TransactionCanceledException';throw e;}
  for(const w of writes) values.set(w.sk,structuredClone(w.value));}};
 const c=structuredClone(fast ? config : DEFAULT_BOTS);
 delete c.incomingRaid.targetOffline;
 delete c.offlinePolicy;
 if (fast) c.devFastMode = true;
 c.incomingRaid.enabled=true; c.incomingRaid.allowedPlayerIds=[DEV_RAID_PLAYER];
 return {values,c,service:new IncomingRaidService(db,{load:async()=>c},()=>now),advance:()=>{now+=60000;}};
}
describe('incoming raid worker',()=>{
 it('defaults to disabled with ten independent profiles',()=>{expect(DEFAULT_BOTS.incomingRaid.enabled).toBe(false);expect(config.incomingRaid.targetOffline).toBe(true);expect(config.incomingRaid.allowedPlayerIds).toEqual([]);expect(config.bots).toHaveLength(10);expect(config.bots.filter(b=>b.attackEnabled).map(b=>b.id)).toEqual(['player_1001']);expect(config.bots.every(b=>b.defenseEnabled)).toBe(true);});
 it.each([3,2,1,0])('settles offline shield %i and is idempotent under concurrent calls',async n=>{
  const f=fixture(n);await Promise.all([f.service.execute(DEV_RAID_PLAYER),f.service.execute(DEV_RAID_PLAYER)]);
  expect(f.values.get('COLLECTION').shieldCount).toBe(Math.max(0,n-1));
  const receipts=[...f.values.entries()].filter(([k])=>k.startsWith('INCOMING#RECEIPT#'));
  expect(receipts).toHaveLength(1);
  const receipt=receipts[0]![1];
  expect(receipt).toMatchObject({shieldConsumed:n>0,outcome:n>0?'BLOCKED':'HIT'});
  const progress=f.values.get('PROGRESS');
  expect(progress).toMatchObject({facilityLevels:[1,1,1,1,1],constructionStars:'0'});
  expect(currentVillageDamage(progress)).toEqual(n ? {} : {[receipt.buildingId]:receipt.attackId});
  expect(f.c.bots.find(b=>b.id===receipts[0]![1].botId)?.attackEnabled).toBe(true);
 });
 it('settles a hit on numeric DynamoDB progress with exact precision', async () => {
  const f = fixture(0);
  f.values.set('PROGRESS', {
    ...f.values.get('PROGRESS'),
    distance: NumberValue.from('12345678901234567890.12345'),
    lastDistanceMilestone: 42,
    constructionStars: 7,
  });
  await expect(f.service.execute(DEV_RAID_PLAYER)).resolves.toBe(true);
  expect(f.values.get('PROGRESS')).toMatchObject({
    distance: '12345678901234567890.12345',
    lastDistanceMilestone: '42',
    constructionStars: '7',
  });
 });
 it('does nothing when disabled or excluded from the test allowlist',async()=>{
  const f=fixture(3);f.c.incomingRaid.enabled=false;await f.service.execute(DEV_RAID_PLAYER);
  f.c.incomingRaid.enabled=true;f.c.incomingRaid.allowedPlayerIds=['someone-else'];await f.service.execute(DEV_RAID_PLAYER);
  expect(f.values.get('COLLECTION').shieldCount).toBe(3);expect(f.values.get('INCOMING#SCHEDULE').sequence).toBe(1);
 });
 it('preserves existing collection fields during settlement',async()=>{
  const f=fixture(1);Object.assign(f.values.get('COLLECTION'),{raidTickets:7,camelProgress:3});await f.service.execute(DEV_RAID_PLAYER);
  expect(f.values.get('COLLECTION')).toMatchObject({raidTickets:7,camelProgress:3,shieldCount:0});
 });
 it('obeys daily cap even after retries and overdue events',async()=>{
  const f=fixture(3);Object.assign(f.values.get('INCOMING#SCHEDULE'),{day:'2026-01-01',dayCount:3});await f.service.execute(DEV_RAID_PLAYER);
  expect(f.values.get('COLLECTION').shieldCount).toBe(3);expect([...f.values.keys()].some(k=>k.startsWith('INCOMING#RECEIPT#'))).toBe(false);
 });
 it('runs one DEV attack per minute without accelerating bot shield recharge',async()=>{
  const f=fixture(2,true);
  f.values.set('BONUS#STATE',{version:1,raid:{bots:config.bots.map(bot=>({
    profileTemplateId:bot.id,shieldCount:0,shieldRegenAt:new Date(t).toISOString()
  }))}});
  const counts=()=>f.values.get('BONUS#STATE').raid.bots.map((bot:{shieldCount:number})=>bot.shieldCount);
  const run=()=>Promise.all([f.service.run(),f.service.run()]);
  for (const count of [0,1,2,3]) {
    await run();
    expect(counts()).toEqual(Array(10).fill(0));
    expect(f.values.get('COLLECTION').shieldCount).toBe(Math.max(0,1-count));
    f.advance();
  }
  expect([...f.values.entries()].filter(([key])=>key.startsWith('INCOMING#RECEIPT#'))
    .map(([,receipt])=>receipt.outcome)).toEqual(['BLOCKED','BLOCKED','HIT','HIT']);
  expect(f.values.get('INCOMING#SCHEDULE').sequence).toBe(5);
 });
 it('hits only healthy buildings and advances the schedule at full damage without another receipt',async()=>{
  const f=fixture(0,true);
  for(let i=0;i<6;i++){
   await f.service.execute(DEV_RAID_PLAYER);
   f.advance();
  }
  const receipts=[...f.values.entries()].filter(([key])=>key.startsWith('INCOMING#RECEIPT#')).map(([,r])=>r);
  expect(receipts).toHaveLength(5);
  expect(new Set(receipts.map(r=>r.buildingId)).size).toBe(5);
  expect(Object.keys(currentVillageDamage(f.values.get('PROGRESS')))).toHaveLength(5);
  expect(f.values.get('INCOMING#SCHEDULE').sequence).toBe(7);
 });

 it('rejects a bot ID and requires a matching player profile',async()=>{
  const f=fixture(2,true);
  await f.service.execute('player_1001');
  await f.service.execute('bot:dunes:v1:player_1001');
  f.values.delete('PROFILE');
  await f.service.run();
  expect(f.values.get('COLLECTION').shieldCount).toBe(2);
  expect(f.values.get('INCOMING#SCHEDULE').sequence).toBe(1);
 });

 it('uses strict five-minute and inclusive 24-hour activity boundaries',()=>{
  expect(isRaidCandidate(undefined,t)).toBe(false);
  expect(isRaidCandidate(new Date(t-300000).toISOString(),t)).toBe(false);
  expect(isRaidCandidate(new Date(t-300001).toISOString(),t)).toBe(true);
  expect(isRaidCandidate(new Date(t-86400000).toISOString(),t)).toBe(true);
  expect(isRaidCandidate(new Date(t-86400001).toISOString(),t)).toBe(false);
 });

 it('skips a player who came online and allows the same offline target in the next slot',async()=>{
  const first=DEV_RAID_PLAYER, second='65388836-ddcd-47ec-983e-fe3ab330b4e0';
  const lastActiveAt=new Date(t-360000).toISOString(), iso=new Date(t).toISOString();
  const items=new Map([first,second].map(id=>[id,new Map<string,any>([
    ['PROFILE',{playerId:id}],['ACTIVITY',{lastActiveAt}],['COLLECTION',{...newCollection(iso),shieldCount:1}]
  ])]));
  let slot:number|undefined;
  let now = t;
  const db:IncomingStore={
    due:async()=>{throw Error('Legacy index must not be queried');},
    offline:async function*(){yield first; yield second;},
    slotUsed:async value=>slot !== undefined && slot >= value,
    get:async (id,sk)=>structuredClone(items.get(id)?.get(sk)),
    commit:async (id,writes,guard)=>{
      const state=items.get(id)!;
      if(id===first) state.set('ACTIVITY',{lastActiveAt:iso});
      if (!guard || !isRaidCandidate(state.get('ACTIVITY').lastActiveAt,t) || slot===guard.slot) {
        const error=new Error();error.name='TransactionCanceledException';throw error;
      }
      slot=guard.slot;
      for(const write of writes) state.set(write.sk,write.value);
    }
  };
  items.get(second)!.set('INCOMING#SCHEDULE', {
    ...newIncomingSchedule(second, t),
    dueAt: new Date(t + 86400000).toISOString(),
    day: '2026-01-01',
    dayCount: 99,
    lastSettledAt: iso,
  });
  const attackOnly=structuredClone(config);
  attackOnly.offlinePolicy!.attackRaidWeights={ATTACK:1,RAID:0};
  const worker=new IncomingRaidService(db,{load:async()=>attackOnly},()=>now);
  await Promise.all([worker.run(),worker.run()]);
  expect(items.get(first)!.get('COLLECTION').shieldCount).toBe(1);
  expect(items.get(second)!.get('COLLECTION').shieldCount).toBe(0);
  expect(items.get(second)!.get('INCOMING#RECEIPT#0000000000000001').botId).toBe('player_1001');
  expect(items.get(second)!.get('INCOMING#SCHEDULE').dayCount).toBe(100);
  items.get(second)!.get('COLLECTION').shieldCount = 1;
  now += 15 * 60000;
  await worker.run(t); // A delayed retry must retain its original slot.
  expect(items.get(second)!.get('COLLECTION').shieldCount).toBe(1);
  await worker.run(now);
  expect(items.get(second)!.get('COLLECTION').shieldCount).toBe(0);
  expect(items.get(second)!.get('INCOMING#RECEIPT#0000000000000002').botId).toBe('player_1001');
 });

 it('spreads slots, caps them daily and averages close to 2.5',()=>{
  let count=0;for(let p=0;p<100;p++){let x=Date.UTC(2026,0,1)-1;for(let d=0;d<30;d++){let n=0;const end=Date.UTC(2026,0,2+d);while(true){const next=nextAttackAt('p'+p,x,2.5);if(next>=end)break;x=next;n++;}expect(n).toBeLessThanOrEqual(3);count+=n;x=end-1;}}
  expect(count/3000).toBeGreaterThan(2.4);expect(count/3000).toBeLessThan(2.6);
 });
 it('floors each bag, chooses three different slots and caps the debit at the current protected balance',()=>{
  const plan=startWalletRaid(107,[2000,2000,1000,0,0],max=>max-1);
  expect(plan.bags).toEqual([21,21,10,0,0]);
  expect(plan.picks).toEqual([{bagId:4,amount:0},{bagId:3,amount:0},{bagId:2,amount:10}]);
  expect(walletRaidDebit(plan.selectedYP,17,5000)).toBe(8);
  expect(walletRaidDebit(plan.selectedYP,107,5000)).toBe(10);
  expect(botsSchema.safeParse({...config,offlinePolicy:{...config.offlinePolicy,
    walletRaid:{enabled:true,protectedBalanceBps:5000,bagWeightsBps:[3000,2000,1000,0,0]}}}).success).toBe(false);
 });

 it('keeps the starting bags across a wallet conflict and commits only once for a slot',async()=>{
  const f=fixture(1), player=DEV_RAID_PLAYER, iso=new Date(t).toISOString();
  const items=f.values;
  items.set('ACTIVITY',{lastActiveAt:new Date(t-360000).toISOString()});
  items.set('WALLET',{...newSave(iso).wallet,yallaPoint:107,energyRechargeAnchor:0});
  let latestSlot=-1;
  let conflicted=false;
  const settings=structuredClone(config);
  settings.offlinePolicy!.attackRaidWeights={ATTACK:0,RAID:1};
  const db:IncomingStore={
    due:async()=>[],
    offline:async function*(){yield player;},
    slotUsed:async slot=>slot<=latestSlot,
    get:async(_p,key)=>structuredClone(items.get(key)),
    commit:async(_p,writes,guard)=>{
      if (!conflicted && writes.some(w=>w.sk==='WALLET')) {
        conflicted=true;
        const wallet=items.get('WALLET');
        items.set('WALLET',{...wallet,version:wallet.version+1,yallaPoint:1});
      }
      if (!guard?.slot || guard.slot<=latestSlot || writes.some(w=>items.get(w.sk)?.version!==w.expectedVersion)) {
        const error=new Error();error.name='TransactionCanceledException';throw error;
      }
      latestSlot=guard.slot;
      for(const write of writes)items.set(write.sk,structuredClone(write.value));
    },
  };
  const worker=new IncomingRaidService(db,{load:async()=>settings},()=>t);
  await worker.run(t);
  await worker.run(t);
  const receipt=items.get(WALLET_RAID_PREFIX+'0000000000000001');
  expect(receipt).toMatchObject({eventType:'RAID',eventId:`RAID:${player}:1`,startYP:107,
    balanceBefore:1,balanceAfter:1,stolenYP:0,burnedYP:0,shieldConsumed:false});
  expect([...receipt.bags].sort((a,b)=>a-b)).toEqual([0,0,10,21,21]);
  expect(items.get('COLLECTION').shieldCount).toBe(1);
  expect([...items.keys()].filter(key=>key.startsWith(WALLET_RAID_PREFIX))).toHaveLength(1);
 });

});
