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
 const db:IncomingStore={get:async(_p,sk)=>structuredClone(values.get(sk)),due:async()=>[{playerId:DEV_RAID_PLAYER}],commit:async(_p,writes)=>{
  for(const w of writes) if(w.expectedVersion===undefined?values.has(w.sk):values.get(w.sk)?.version!==w.expectedVersion) {const e=new Error();e.name='TransactionCanceledException';throw e;}
  for(const w of writes) values.set(w.sk,structuredClone(w.value));}};
 const c=structuredClone(fast ? config : DEFAULT_BOTS);
 delete c.incomingRaid.targetOffline;
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
 it('runs one DEV attack per minute, hits after shields run out, and recharges every bot to three',async()=>{
  const f=fixture(2,true);
  f.values.set('BONUS#STATE',{version:1,raid:{bots:config.bots.map(bot=>({
    profileTemplateId:bot.id,shieldCount:0,shieldRegenAt:new Date(t).toISOString()
  }))}});
  const counts=()=>f.values.get('BONUS#STATE').raid.bots.map((bot:{shieldCount:number})=>bot.shieldCount);
  const run=()=>Promise.all([f.service.run(),f.service.run()]);
  for (const count of [0,1,2,3]) {
    await run();
    expect(counts()).toEqual(Array(10).fill(count));
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

 it('selects an offline player without a schedule and skips a player who just came online',async()=>{
  const first=DEV_RAID_PLAYER, second='65388836-ddcd-47ec-983e-fe3ab330b4e0';
  const lastActiveAt=new Date(t-360000).toISOString(), iso=new Date(t).toISOString();
  const items=new Map([first,second].map(id=>[id,new Map<string,any>([
    ['PROFILE',{playerId:id}],['ACTIVITY',{lastActiveAt}],['COLLECTION',{...newCollection(iso),shieldCount:1}]
  ])]));
  let slot:number|undefined;
  const db:IncomingStore={
    due:async()=>{throw Error('Legacy index must not be queried');},
    offline:async function*(){yield first; yield second;},
    slotUsed:async value=>slot===value,
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
  const worker=new IncomingRaidService(db,{load:async()=>config},()=>t);
  await Promise.all([worker.run(),worker.run()]);
  expect(items.get(first)!.get('COLLECTION').shieldCount).toBe(1);
  expect(items.get(second)!.get('COLLECTION').shieldCount).toBe(0);
  expect(items.get(second)!.get('INCOMING#RECEIPT#0000000000000001').botId).toBe('player_1001');
 });

 it('spreads slots, caps them daily and averages close to 2.5',()=>{
  let count=0;for(let p=0;p<100;p++){let x=Date.UTC(2026,0,1)-1;for(let d=0;d<30;d++){let n=0;const end=Date.UTC(2026,0,2+d);while(true){const next=nextAttackAt('p'+p,x,2.5);if(next>=end)break;x=next;n++;}expect(n).toBeLessThanOrEqual(3);count+=n;x=end-1;}}
  expect(count/3000).toBeGreaterThan(2.4);expect(count/3000).toBeLessThan(2.6);
 });
});
