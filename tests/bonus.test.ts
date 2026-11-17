import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GameConfigs,parseConfig,type ConfigSource,type ConfigName } from '../src/game-config.js';
import { BonusService,jackpotSegment,mirrorBots,type BonusStore } from '../src/bonus.js';
import { DropService,type Write } from '../src/drop.js';
import { newSave,type Principal,type Save } from '../src/model.js';
import { newCollection,settle } from '../src/drop-economy.js';
import type { PlayerRepository } from '../src/repository.js';
import type { S3Client } from '@aws-sdk/client-s3';
const load=<K extends ConfigName>(name:K)=>parseConfig(name,readFileSync(new URL(`../config/dev/${name}.json`,import.meta.url),'utf8'),'dev');
process.env.ENVIRONMENT='dev';process.env.RESULT_POLICY='PERMISSIVE';
const p:Principal={provider:'guest',subject:'owner'};
async function fixture(kind:'Jackpot'|'Raid'='Jackpot',count=2) {
  const save=newSave('2026-11-17T00:00:00.000Z'),items=new Map<string,any>([['PROFILE',save.profile],['PROGRESS',save.progress],['WALLET',save.wallet]]);
  const player=save.profile.playerId;
  const db:BonusStore={get:async(id,sk)=>id===player?structuredClone(items.get(sk)):undefined,
    list:async(id,prefix)=>id===player?[...items].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>({...structuredClone(v),_key:k})):[],
    commit:async(_p,writes:Write[])=>{for(const w of writes)if(w.expectedVersion===undefined?items.has(w.sk):items.get(w.sk)?.version!==w.expectedVersion){const e=new Error();e.name='TransactionCanceledException';throw e;}
      for(const w of writes)items.set(w.sk,structuredClone(w.value));}};
  const players:PlayerRepository={find:async principal=>principal.subject==='owner'?player:undefined,
    read:async()=>structuredClone({profile:items.get('PROFILE'),progress:items.get('PROGRESS'),wallet:items.get('WALLET')}) as Save,create:async()=>{}};
  const configs:ConfigSource={load:async name=>load(name)};
  const drops=new DropService(players,db,{pick:async()=>{throw new Error('No pool needed');}},()=>Date.parse(save.wallet.updatedAt),undefined,configs);
  await drops.open(p);
  const c=newCollection(save.wallet.updatedAt);c[kind==='Jackpot'?'jackpotTickets':'raidTickets']=count;items.set('COLLECTION',c);
  items.set('BONUS#batch#'+kind,{schemaVersion:1,version:1,updatedAt:save.wallet.updatedAt,kind,total:count,completed:0,totalReward:0,roundId:'source-round',cause:'round-collection',announced:false,status:'PENDING'});
  const bonus=new BonusService(players,db,drops,configs,()=>Date.parse(save.wallet.updatedAt),()=>9999);
  return {bonus,drops,items,db,configs,save};
}
describe('versioned S3 game config',()=>{
  it('validates all four exact current policies and environment isolation',()=>{
    for(const name of ['collection','journey','jackpot','raid'] as const)expect(load(name).contentHash).toHaveLength(64);
    expect(()=>parseConfig('journey',JSON.stringify({...load('journey'),contentHash:undefined,environment:'prod'}),'dev')).toThrow();
    const j=load('jackpot');j.data.weights[0]=1;
    expect(()=>parseConfig('jackpot',JSON.stringify({schemaVersion:1,environment:'dev',version:'bad',data:j.data}),'dev')).toThrow();
  });
  it('caches for 60 seconds and fails closed on invalid updates without serving stale settings',async()=>{
    let now=0,calls=0,invalid=false;
    const s3={send:async()=>{calls++;return {ContentLength:100,Body:{transformToString:async()=>invalid?'{}':readFileSync(new URL('../config/dev/journey.json',import.meta.url),'utf8')}};}} as unknown as S3Client;
    const configs=new GameConfigs(s3,'bucket','dev',()=>now);
    await Promise.all([configs.load('journey'),configs.load('journey')]);expect(calls).toBe(1);
    await configs.load('journey');expect(calls).toBe(1);now=60001;invalid=true;
    await expect(configs.load('journey')).rejects.toMatchObject({code:'GAME_CONFIG_INVALID'});expect(calls).toBe(2);
  });
  it('reproduces each jackpot probability bucket for all 10000 rolls',()=>{
    const j=load('jackpot'),counts=[0,0,0,0,0,0];for(let roll=0;roll<10000;roll++)counts[jackpotSegment(j.data.weights,roll)]!++;
    expect(counts).toEqual([3500,2500,1800,1200,800,200]);expect(j.data.rewards).toEqual([100,250,500,1000,2500,5000]);
  });
});
describe('config-driven Collection and Journey',()=>{
  it('retains latest Camel Shield and overflow policy, never old Camel Energy 30',()=>{
    const s=newSave(),c=newCollection('now');c.camelProgress=4;
    const args=[s.wallet,s.progress,c,{ball:'Ball003',color:'RED',symbol:'Camel'},'RED',1,s.wallet.updatedAt] as const;
    const first=settle(...args,load('collection').data,load('journey').data);expect(first.reward.shields).toBe(1);expect(first.reward.collectionEnergy).toBe(0);
    c.shieldCount=3;expect(settle(...args,load('collection').data,load('journey').data).reward.collectionEnergy).toBe(3);
  });
  it('preserves absolute milestone watermark across interval and reward changes',()=>{
    const s=newSave(),c=newCollection('now'),j=load('journey').data;s.progress.distance='380';s.progress.lastDistanceMilestone='1';
    j.distancePerChest='30';
    const r=settle(s.wallet,s.progress,c,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',3,s.wallet.updatedAt,load('collection').data,j,{processedDistance:'380',claimedChestCount:'1'});
    expect(r.progress.distance).toBe('410');expect(r.journeyAward.count).toBe('1');expect(r.reward.distanceEnergy).toBe(20);
    expect(r.journeyCheckpoint).toEqual({processedDistance:'410',claimedChestCount:'2'});
    j.distancePerChest='300';const next=settle(r.wallet,r.progress,r.collection,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j,r.journeyCheckpoint);
    expect(next.reward.distanceEnergy).toBe(0);
  });
  it('supports once-only and configured reward kind without retroactive grants',()=>{
    const s=newSave(),j=load('journey').data;s.progress.distance='295';j.rewardType='YallaPoint';j.rewardAmount=7;j.repeat='ONCE';
    const r=settle(s.wallet,s.progress,newCollection('now'),{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j);
    expect(r.reward.distanceYallaPoint).toBe(7);expect(r.wallet.yallaPoint).toBe(17);
    const more=settle(r.wallet,{...r.progress,distance:'595'},r.collection,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j,r.journeyCheckpoint);
    expect(more.reward.distanceYallaPoint).toBe(0);
  });
});
describe('atomic bonus lifecycle',()=>{
  it('consumes and pays jackpot once, even with concurrent new request IDs',async()=>{
    const f=await fixture();await f.bonus.ensure(p,'Jackpot');
    const [a,b]=await Promise.all([f.bonus.spin(p,{requestId:randomUUID()}),f.bonus.spin(p,{requestId:randomUUID()})]);
    expect(a.result!.id).toBe(b.result!.id);expect(f.items.get('WALLET').yallaPoint).toBe(5000);expect(f.items.get('COLLECTION').jackpotTickets).toBe(1);
    await f.bonus.spin(p,{requestId:a.result!.id});expect(f.items.get('WALLET').yallaPoint).toBe(5000);
    await Promise.all([f.bonus.acknowledge(p,'Jackpot',a.result!.id),f.bonus.acknowledge(p,'Jackpot',a.result!.id)]);
    expect((await f.bonus.get(p)).bonus.run.completed).toBe(1);
    const receipt=f.items.get('ECONOMY#OP#jackpot:'+a.result!.id);expect(receipt.configVersion).toBe('jackpot-v1');expect(receipt.configHash).toHaveLength(64);
  });
  it('rejects insufficient rights, wrong owner and incomplete finish',async()=>{
    const f=await fixture('Jackpot',1);f.items.get('COLLECTION').jackpotTickets=0;await f.bonus.ensure(p,'Jackpot');
    await expect(f.bonus.spin(p,{requestId:randomUUID()})).rejects.toMatchObject({code:'INSUFFICIENT_JACKPOT_TICKETS'});
    await expect(f.bonus.get({...p,subject:'other'})).rejects.toMatchObject({code:'PLAYER_NOT_FOUND'});
    await expect(f.bonus.finish(p,'Jackpot')).rejects.toMatchObject({code:'BONUS_NOT_COMPLETE'});
    expect(f.items.get('WALLET').yallaPoint).toBe(0);
  });
  it('recovers a paid but unacknowledged result after a lost commit response',async()=>{
    const f=await fixture('Jackpot',1);await f.bonus.ensure(p,'Jackpot');const commit=f.db.commit;let fail=true;
    f.db.commit=async(p,w)=>{await commit(p,w);if(fail){fail=false;const e=new Error();e.name='TimeoutError';throw e;}};
    const id=randomUUID();await expect(f.bonus.spin(p,{requestId:id})).rejects.toMatchObject({name:'TimeoutError'});
    expect((await f.bonus.spin(p,{requestId:id})).result!.goldReward).toBe(5000);
    await f.bonus.acknowledge(p,'Jackpot',id);await f.bonus.finish(p,'Jackpot');await f.bonus.finish(p,'Jackpot');
    expect((await f.bonus.get(p)).bonus.run).toBeNull();expect(f.items.get('WALLET').yallaPoint).toBe(5000);
  });
  it('creates six local mirrors with the exact existing initial-level rule and snapshots raid config',async()=>{
    const f=await fixture('Raid',1);f.items.get('PROGRESS').facilityLevels=[5,4,3,2,1];
    await f.bonus.ensure(p,'Raid');const issued=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    expect(issued.bonus.raid.bots).toHaveLength(6);expect(issued.bonus.raid.bots[0].facilityLevels).toEqual([1,1,1,1,1]);
    expect(issued.bonus.raid.bots[0].worldId).toBe('dunes');expect(f.items.get('COLLECTION').raidTickets).toBe(1);
    const before=f.configs.load;f.configs.load=async name=>{const c=await before(name);if(name==='raid')(c.data as any).multiplier=999;return c;};
    const id=issued.result!.operation.raidId;
    const [a,b]=await Promise.all([f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0}),f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0})]);
    expect(a.result!.result.rewardAmount).toBe(100);expect(b.save.wallet.yallaPoint).toBe(100);expect(f.items.get('COLLECTION').raidTickets).toBe(0);
    await expect(f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:1})).rejects.toMatchObject({code:'RESULT_CONFLICT'});
    await f.bonus.acknowledge(p,'Raid',id);await f.bonus.finish(p,'Raid');expect(f.items.get('WALLET').yallaPoint).toBe(100);
  });
  it('consumes one bot shield and the raid ticket, pays zero, and never consumes the player shield',async()=>{
    const f=await fixture('Raid',1);const previous=f.configs.load;f.configs.load=async name=>{const c=await previous(name);if(name==='raid')(c.data as any).initialShieldCounts[0]=1;return c;};
    f.items.get('COLLECTION').shieldCount=3;await f.bonus.ensure(p,'Raid');const ready=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const r=await f.bonus.attack(p,ready.result!.operation.raidId,{requestId:randomUUID(),facilityId:0});
    expect(r.result!.result).toMatchObject({result:'BlockedByShield',rewardAmount:0,shieldConsumed:true});expect(r.bonus.raid.bots[0].shieldCount).toBe(0);
    expect(f.items.get('COLLECTION').shieldCount).toBe(3);expect(f.items.get('WALLET').yallaPoint).toBe(0);
  });
  it('target cancel is free, settled raids cannot be cancelled and bonus blocks new Drop',async()=>{
    const f=await fixture('Raid',1);await f.bonus.ensure(p,'Raid');const first=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    await f.bonus.cancelRaid(p,first.result!.operation.raidId);expect(f.items.get('COLLECTION').raidTickets).toBe(1);
    const second=await f.bonus.beginRaid(p,{requestId:randomUUID(),botId:first.bonus.raid.bots[1].botId});
    const sid=(await f.drops.active(p)).session!.sessionId;
    await expect(f.drops.begin(p,sid,{requestId:randomUUID(),prediction:'RED',energyCost:1})).rejects.toMatchObject({code:'BONUS_ACTIVE'});
    await f.bonus.attack(p,second.result!.operation.raidId,{requestId:randomUUID(),facilityId:4});
    await expect(f.bonus.cancelRaid(p,second.result!.operation.raidId)).rejects.toMatchObject({code:'RAID_ALREADY_SETTLED'});
  });
});
