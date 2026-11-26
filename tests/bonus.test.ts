import { describe,it,expect } from 'vitest';
import { DEFAULT_BOTS } from '../src/bots-config.js';
import { IncomingRaidService, newIncomingSchedule } from '../src/incoming-raid.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GameConfigs,parseConfig,type ConfigSource,type ConfigName } from '../src/game-config.js';
import { BonusService,jackpotSegment,mirrorBots,type BonusStore } from '../src/bonus.js';
import { privateActivity } from '../src/journey-read-keys.js';
import { DropService,type Write } from '../src/drop.js';
import { currentVillageDamage, newSave,type Principal,type Save } from '../src/model.js';
import { newCollection,settle } from '../src/drop-economy.js';
import type { PlayerRepository } from '../src/repository.js';
import type { S3Client } from '@aws-sdk/client-s3';
const load=<K extends ConfigName>(name:K)=>parseConfig(name,readFileSync(new URL(`../config/dev/${name}.json`,import.meta.url),'utf8'),'dev');
process.env.ENVIRONMENT='dev';process.env.RESULT_POLICY='PERMISSIVE';
const p:Principal={provider:'guest',subject:'owner'};
async function fixture(kind:'Jackpot'|'Raid'='Jackpot',count=2) {
  const save=newSave('2026-11-17T00:00:00.000Z'),items=new Map<string,any>([['PROFILE',save.profile],['PROGRESS',save.progress],['WALLET',save.wallet]]);
  const player=save.profile.playerId;
  const partitions = new Map<string, Map<string, any>>([[player, items]]);
  const partition = (id: string) => {
    if (!partitions.has(id)) partitions.set(id, new Map());
    return partitions.get(id)!;
  };
  const db:BonusStore = {
    get:async(id,sk)=>structuredClone(partitions.get(id)?.get(sk)),
    list:async(id,prefix)=>[...(partitions.get(id) ?? [])].filter(([k])=>k.startsWith(prefix))
      .map(([k,v])=>({...structuredClone(v),_key:k})),
    commit:async(id,writes:Write[])=>{
      for(const w of writes) {
        const value = partition(w.owner ?? id).get(w.sk);
        const valid = w.check
          ? partitions.get(w.check.key.PK.replace(/^PLAYER#/, ''))?.get(w.check.key.SK)?.[w.check.field] === w.check.value
          : w.expectedVersion === undefined ? !value : value?.version === w.expectedVersion;
        if (!valid) { const e=new Error();e.name='TransactionCanceledException';throw e; }
      }
      for(const w of writes) {
        if (w.check) continue;
        const rows = partition(w.owner ?? id);
        if (w.delete) rows.delete(w.sk); else rows.set(w.sk,structuredClone(w.value));
      }
    },
  };
  const players:PlayerRepository={find:async principal=>principal.subject==='owner'?player:
    partitions.get(principal.subject)?.has('PROFILE') ? principal.subject : undefined,
    read:async id=>structuredClone({profile:partition(id).get('PROFILE'),progress:partition(id).get('PROGRESS'),
      wallet:partition(id).get('WALLET')}) as Save,create:async()=>{}};
  const configs:ConfigSource={load:async name=>load(name)};
  const drops=new DropService(players,db,{pick:async()=>{throw new Error('No pool needed');}},()=>Date.parse(save.wallet.updatedAt),undefined,configs);
  await drops.open(p);
  const c=newCollection(save.wallet.updatedAt);c[kind==='Jackpot'?'jackpotTickets':'raidTickets']=count;items.set('COLLECTION',c);
  items.set('BONUS#batch#'+kind,{schemaVersion:1,version:1,updatedAt:save.wallet.updatedAt,kind,total:count,completed:0,totalReward:0,roundId:'source-round',cause:'round-collection',announced:false,status:'PENDING'});
  let now=Date.parse(save.wallet.updatedAt);
  const botSettings=structuredClone(DEFAULT_BOTS);
  const bonus=new BonusService(players,db,drops,configs,()=>now,()=>9999,{load:async()=>structuredClone(botSettings)});
  return {bonus,drops,items,db,configs,players,save,botSettings,partition,advance:(ms:number)=>{now+=ms;}};
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
  it('loads updated Journey rewards after cache expiry',async()=>{
    let now=0, text=readFileSync(new URL('../config/dev/journey.json',import.meta.url),'utf8');
    const s3={send:async()=>({ContentLength:100,Body:{transformToString:async()=>text}})} as unknown as S3Client;
    const configs=new GameConfigs(s3,'bucket','dev',()=>now), first=await configs.load('journey');
    const changed=JSON.parse(text); changed.version='journey-v3'; changed.data.rewards[0].rewardAmount=123; text=JSON.stringify(changed);
    expect((await configs.load('journey')).contentHash).toBe(first.contentHash);
    now=60001; const updated=await configs.load('journey');
    expect(updated.version).toBe('journey-v3'); expect(updated.contentHash).not.toBe(first.contentHash);
    expect('rewards' in updated.data && updated.data.rewards[0]!.rewardAmount).toBe(123);
  });
  it('reproduces each jackpot probability bucket for all 10000 rolls',()=>{
    const j=load('jackpot'),counts=[0,0,0,0,0,0];for(let roll=0;roll<10000;roll++)counts[jackpotSegment(j.data.weights,roll)]!++;
    expect(counts).toEqual([3500,2500,1800,1200,800,200]);expect(j.data.rewards).toEqual([100,250,500,1000,2500,5000]);
  });
});
describe('config-driven Collection and Journey',()=>{
  it('validates weights and maps every roll to the configured reward, including above-cap energy',()=>{
    const config=load('journey'), counts=new Map<string,number>();
    expect('rewards' in config.data).toBe(true);
    if (!('rewards' in config.data)) throw new Error('Expected weighted rewards');
    const invalid=structuredClone(config.data); invalid.rewards[0]!.weight--;
    expect(()=>parseConfig('journey',JSON.stringify({schemaVersion:1,environment:'dev',version:'bad',data:invalid}),'dev')).toThrow();
    for(let roll=0;roll<10000;roll++) {
      const s=newSave(); s.progress.distance='295'; s.wallet.energy=50;
      const r=settle(s.wallet,s.progress,newCollection('now'),{ball:'Ball001',color:'RED',symbol:'Y'},'BLUE',1,s.wallet.updatedAt,load('collection').data,config.data,undefined,()=>roll);
      const award=r.journeyAward.rewards[0]!; const key=`${award.rewardType}:${award.rewardAmount}`;
      counts.set(key,(counts.get(key)??0)+1);
      expect(r.wallet.energy).toBe(50+r.reward.distanceEnergy);
      expect(r.wallet.yallaPoint).toBe(10+r.reward.distanceYallaPoint);
    }
    expect(Object.fromEntries(counts)).toEqual({'YallaPoint:100':3500,'YallaPoint:250':2500,'YallaPoint:500':1500,'Energy:3':2000,'Energy:5':500});
  });
  it('retains latest Camel Shield and overflow policy, never old Camel Energy 30',()=>{
    const s=newSave(),c=newCollection('now');c.camelProgress=4;
    const args=[s.wallet,s.progress,c,{ball:'Ball003',color:'RED',symbol:'Camel'},'RED',1,s.wallet.updatedAt] as const;
    const first=settle(...args,load('collection').data,load('journey').data);expect(first.reward.shields).toBe(1);expect(first.reward.collectionEnergy).toBe(0);
    c.shieldCount=3;expect(settle(...args,load('collection').data,load('journey').data).reward.collectionEnergy).toBe(3);
  });
  it('preserves absolute milestone watermark across interval and reward changes',()=>{
    const s=newSave(),c=newCollection('now'),j={distancePerChest:'300',repeat:'REPEATING' as const,rewardType:'Energy' as const,rewardAmount:20};s.progress.distance='380';s.progress.lastDistanceMilestone='1';
    j.distancePerChest='30';
    const r=settle(s.wallet,s.progress,c,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',3,s.wallet.updatedAt,load('collection').data,j,{processedDistance:'380',claimedChestCount:'1'});
    expect(r.progress.distance).toBe('410');expect(r.journeyAward.count).toBe('1');expect(r.reward.distanceEnergy).toBe(20);
    expect(r.journeyCheckpoint).toEqual({processedDistance:'410',claimedChestCount:'2'});
    j.distancePerChest='300';const next=settle(r.wallet,r.progress,r.collection,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j,r.journeyCheckpoint);
    expect(next.reward.distanceEnergy).toBe(0);
  });
  it('supports once-only and configured reward kind without retroactive grants',()=>{
    const s=newSave(),j={distancePerChest:'300',repeat:'ONCE' as const,rewardType:'YallaPoint' as const,rewardAmount:7};s.progress.distance='295';
    const r=settle(s.wallet,s.progress,newCollection('now'),{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j);
    expect(r.reward.distanceYallaPoint).toBe(7);expect(r.wallet.yallaPoint).toBe(17);
    const more=settle(r.wallet,{...r.progress,distance:'595'},r.collection,{ball:'Ball001',color:'RED',symbol:'Star'},'BLUE',1,s.wallet.updatedAt,load('collection').data,j,r.journeyCheckpoint);
    expect(more.reward.distanceYallaPoint).toBe(0);
  });
});
describe('atomic bonus lifecycle',()=>{
  it.each([3,2,1,0])('settles %i winning bags once and restores every stage without leaking unrevealed bags', async wins => {
    const f=await fixture('Raid',2);
    f.items.get('BONUS#batch#Raid').eventTypes=['RAID','ATTACK'];
    f.items.get('COLLECTION').shieldCount=3;
    const loadCurrent=f.configs.load;
    if(wins===0)f.configs.load=async name=>{
      const config=await loadCurrent(name);
      if(name==='raid')Object.assign((config as ReturnType<typeof load<'raid'>>).data.bags!,{winners:2});
      return config;
    };
    await f.bonus.ensure(p,'Raid');
    const id=randomUUID(),key=`RAID#${id}`,start=await f.bonus.beginRaid(p,{requestId:id});
    const receipt=f.items.get(key),gold=receipt.bagGold as number[];
    expect(gold).toHaveLength(5);
    expect(gold.filter(v=>v>0)).toHaveLength(wins===0?2:3);
    expect(gold.every(v=>v===0 || (v>=100 && v<=300))).toBe(true);
    expect(start.result!.operation).toMatchObject({bagCount:5,pickLimit:3});
    expect(JSON.stringify(start)).not.toContain('bagGold');
    expect(start.result!.picks).toEqual([]);
    const bagIds=[...gold.map((v,i)=>v>0?i:-1).filter(i=>i>=0).slice(0,wins),
      ...gold.map((v,i)=>v===0?i:-1).filter(i=>i>=0).slice(0,3-wins)];
    // Change the live rules after issuance. Picks and settlement keep the original snapshot.
    f.configs.load=async name=>{
      const config=await loadCurrent(name);
      if(name==='raid')Object.assign((config as ReturnType<typeof load<'raid'>>).data.bags!,{goldCap:1,costumePointPerWin:0});
      return config;
    };
    const reader=new BonusService(f.players,f.db,f.drops,f.configs,()=>Date.parse(f.save.wallet.updatedAt),undefined,{load:async()=>f.botSettings});
    const commands=bagIds.map(bagId=>({requestId:randomUUID(),bagId}));
    for(const [i,command] of commands.slice(0,2).entries()){
      const response=await reader.pick(p,id,command);
      expect(response.selection).toMatchObject({bagId:command.bagId,gold:gold[command.bagId]});
      expect(JSON.stringify(response)).not.toContain('bagGold');
      const resumed=await reader.get(p);
      expect(resumed.bagRaid!.picks).toHaveLength(i+1);
      expect(resumed.bingo.missions.find(m => m.missionId === 'Raid')?.completed).toBe(false);
      expect(JSON.stringify(resumed)).not.toContain('bagGold');
      expect(resumed.save.wallet.yallaPoint).toBe(0);
      expect(resumed.save.wallet.costumePoint).toBe(0);
    }
    await expect(reader.cancelRaid(p,id)).rejects.toMatchObject({code:'RAID_ALREADY_STARTED'});
    await expect(reader.pick(p,id,{...commands[0]!,requestId:randomUUID()})).rejects.toMatchObject({code:'RAID_BAG_ALREADY_PICKED'});
    await expect(reader.pick(p,id,{...commands[0]!,bagId:commands[1]!.bagId})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(reader.acknowledge(p,'Raid',id)).rejects.toMatchObject({code:'BONUS_RECEIPT_CONFLICT'});
    const walletBefore=f.items.get('WALLET').version;
    const last=commands[2]!;
    const [a,b]=await Promise.all([reader.pick(p,id,last),f.bonus.pick(p,id,last)]);
    expect(a.selection).toEqual(b.selection);
    expect(a.bingo.missions.find(m => m.missionId === 'Raid')?.progress).toBe(1);
    const total=bagIds.reduce((sum,index)=>sum+gold[index]!,0);
    expect(total).toBeLessThanOrEqual(900);
    expect(a.result).toMatchObject({status:'SETTLED',result:{rewardAmount:total,costumePoint:wins}});
    expect((await reader.get(p)).bagRaid!.result).toEqual(a.result!.result);
    expect(f.items.get('WALLET')).toMatchObject({version:walletBefore+1,yallaPoint:total,costumePoint:wins});
    expect(f.items.get('COLLECTION')).toMatchObject({raidTickets:1,shieldCount:3});
    await reader.acknowledge(p,'Raid',id);
    expect((await reader.get(p)).bagRaid).toBeNull();
    expect((await reader.pick(p,id,last)).selection).toEqual(a.selection);
    const attack=await reader.beginRaid(p,{requestId:randomUUID()});
    expect(attack.result!.operation.eventType).toBe('ATTACK');
    await expect(reader.pick(p,attack.result!.operation.raidId,last)).rejects.toMatchObject({code:'BONUS_EVENT_TYPE_MISMATCH'});
  });
  it('applies the pinned gold cap and preserves configured costume purchase ownership across retries', async () => {
    const f=await fixture('Raid',1);
    const fromDisk=f.configs.load, itemId='camel_hat_star_cap';
    f.configs.load=async name=>{
      const config=await fromDisk(name);
      if(name==='raid'){
        const data=(config as ReturnType<typeof load<'raid'>>).data;
        Object.assign(data.bags!,{minGold:400,maxGold:400});
        data.costumePrices={[itemId]:2};
      }
      return config;
    };
    const purchase={requestId:randomUUID(),itemId};
    f.items.get('BONUS#batch#Raid').eventTypes=['RAID'];
    await expect(f.bonus.purchaseCostume(p,purchase)).rejects.toMatchObject({code:'INSUFFICIENT_COSTUME_POINT'});
    await expect(f.bonus.purchaseCostume(p,{requestId:randomUUID(),itemId:'original_bg'})).rejects.toMatchObject({code:'COSTUME_NOT_FOR_SALE'});
    await f.bonus.ensure(p,'Raid');
    const id=randomUUID();
    await f.bonus.beginRaid(p,{requestId:id});
    for(const [bagId,gold] of (f.items.get(`RAID#${id}`).bagGold as number[]).entries())
      if(gold)await f.bonus.pick(p,id,{requestId:randomUUID(),bagId});
    expect(f.items.get('WALLET')).toMatchObject({yallaPoint:900,costumePoint:3});
    await f.bonus.acknowledge(p,'Raid',id);
    const [a,b]=await Promise.all([f.bonus.purchaseCostume(p,purchase),f.bonus.purchaseCostume(p,purchase)]);
    expect(a.result).toEqual(b.result);
    expect((await f.bonus.get(p)).costume.ownedIds).toEqual([itemId]);
    expect(f.items.get('WALLET')).toMatchObject({yallaPoint:900,costumePoint:1});
    await expect(f.bonus.purchaseCostume(p,{...purchase,requestId:randomUUID()})).rejects.toMatchObject({code:'COSTUME_ALREADY_OWNED'});
  });
  it('prices every DEV wearable at one CP and persists one owned item per slot after reconnect', async () => {
    const f=await fixture();
    const prices=load('raid').data.costumePrices!;
    expect(Object.values(prices)).toEqual(Array(21).fill(1));
    expect(prices).not.toHaveProperty('original_bg');
    expect(prices).not.toHaveProperty('original_board');
    const loadout={
      HEAD:'camel_hat_star_cap',GLASS:'camel_glasses_aqua',NECK:'camel_neck_bell',
      BODY:'camel_back_blue_crown',FEET:'camel_shoes_blue_snow',TAIL:'camel_tail_fire',
    } as const;
    const items=Object.values(loadout);
    f.items.get('WALLET').costumePoint=items.length+1;
    await expect(f.bonus.purchaseCostume(p,{requestId:randomUUID(),itemId:loadout.HEAD,expectedPrice:2}))
      .rejects.toMatchObject({code:'COSTUME_PRICE_CHANGED'});
    await expect(f.bonus.equipCostume(p,{requestId:randomUUID(),slot:'HEAD',itemId:loadout.HEAD}))
      .rejects.toMatchObject({code:'COSTUME_NOT_OWNED'});
    for(const itemId of [...items,'camel_hat_turkey'])
      await f.bonus.purchaseCostume(p,{requestId:randomUUID(),itemId});
    expect(f.items.get('WALLET').costumePoint).toBe(0);
    await expect(f.bonus.purchaseCostume(p,{requestId:randomUUID(),itemId:loadout.HEAD}))
      .rejects.toMatchObject({code:'COSTUME_ALREADY_OWNED'});
    await expect(f.bonus.equipCostume(p,{requestId:randomUUID(),slot:'BODY',itemId:loadout.HEAD}))
      .rejects.toMatchObject({code:'COSTUME_SLOT_MISMATCH'});
    for(const slot of Object.keys(loadout) as (keyof typeof loadout)[])
      await f.bonus.equipCostume(p,{requestId:randomUUID(),slot,itemId:loadout[slot]});
    const reader=new BonusService(f.players,f.db,f.drops,f.configs,()=>Date.parse(f.save.wallet.updatedAt),undefined,{load:async()=>f.botSettings});
    expect((await reader.get(p)).costume).toMatchObject({ownedIds:[...items,'camel_hat_turkey'],equipped:loadout});
    const replacement={requestId:randomUUID(),slot:'HEAD' as const,itemId:'camel_hat_turkey'};
    await reader.equipCostume(p,replacement);
    await reader.equipCostume(p,{requestId:randomUUID(),slot:'HEAD',itemId:null});
    await reader.equipCostume(p,replacement);
    expect((await reader.get(p)).costume.equipped).toMatchObject({...loadout,HEAD:null});
    expect(f.items.get('WALLET').costumePoint).toBe(0);
  });
  it('restores ordered event types through the queue, active operation, acknowledgement and a new service instance', async () => {
    const f = await fixture('Raid', 2);
    f.items.get('BONUS#batch#Raid').eventTypes = ['ATTACK', 'RAID'];
    expect((await f.bonus.get(p)).bonus.queue[0].eventTypes).toEqual(['ATTACK', 'RAID']);
    await f.bonus.ensure(p, 'Raid');
    const firstId = randomUUID();
    const first = await f.bonus.beginRaid(p, { requestId: firstId });
    expect(first.result!.operation.eventType).toBe('ATTACK');
    await f.bonus.attack(p, firstId, { requestId: randomUUID(), facilityId: 0 });
    await f.bonus.acknowledge(p, 'Raid', firstId);
    const second = await f.bonus.beginRaid(p, { requestId: randomUUID() });
    const reader = new BonusService(f.players, f.db, f.drops, f.configs,
      () => Date.parse(f.save.wallet.updatedAt), undefined, { load: async () => f.botSettings });
    const resumed = await reader.get(p);
    expect(resumed.bonus.run).toMatchObject({ completed: 1, eventTypes: ['ATTACK', 'RAID'] });
    expect(resumed.bonus.raid.activeRaid).toMatchObject({ raidId: second.result!.operation.raidId, eventType: 'RAID' });
    expect(second.result).toMatchObject({ sequence: 2, operation: { eventType: 'RAID' } });
    const wallet = structuredClone(f.items.get('WALLET'));
    const state = structuredClone(f.items.get('BONUS#STATE'));
    const collection = structuredClone(f.items.get('COLLECTION'));
    await expect(reader.attack(p, second.result!.operation.raidId, { requestId: randomUUID(), facilityId: 0 }))
      .rejects.toMatchObject({ code: 'BONUS_EVENT_TYPE_MISMATCH' });
    expect(f.items.get('WALLET')).toEqual(wallet);
    expect(f.items.get('BONUS#STATE')).toEqual(state);
    expect(f.items.get('COLLECTION')).toEqual(collection);
    expect(f.items.get(`RAID#${second.result!.operation.raidId}`).status).toBe('READY');
  });
  it.each([0, 1, 2, 3, 4])('settles and restores a HIT for building %i', async facilityId => {
    const f = await fixture('Raid', 1);
    await f.bonus.ensure(p, 'Raid');
    const requestId = randomUUID();
    await f.bonus.beginRaid(p, { requestId });
    const resumed = await f.bonus.get(p);
    expect(resumed.bonus.raid.activeRaid).toMatchObject({ raidId: requestId, eventType: 'ATTACK' });
    const selection = { requestId: randomUUID(), facilityId };
    const hit = await f.bonus.attack(p, requestId, selection);
    expect(hit.result!.result).toMatchObject({ outcome: 'HIT', selectedFacilityId: facilityId, rewardAmount: 100 });
    expect((await f.bonus.get(p)).bonus.raid.activities).toContainEqual(hit.result!.result);
    const retry = await f.bonus.attack(p, requestId, selection);
    expect(retry.result).toEqual(hit.result);
    expect(retry.save.wallet.yallaPoint).toBe(100);
    await f.bonus.acknowledge(p, 'Raid', requestId);
    expect((await f.bonus.get(p)).bonus.raid.activeRaid).toBeNull();
  });
  it('consumes and pays jackpot once, even with concurrent new request IDs',async()=>{
    const f=await fixture();await f.bonus.ensure(p,'Jackpot');
    const [a,b]=await Promise.all([f.bonus.spin(p,{requestId:randomUUID()}),f.bonus.spin(p,{requestId:randomUUID()})]);
    expect(a.bingo.missions.find(m => m.missionId === 'Jackpot')?.progress).toBe(1);
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
  it('creates ten local mirrors with the exact existing initial-level rule and snapshots raid config',async()=>{
    const f=await fixture('Raid',1);f.items.get('PROGRESS').facilityLevels=[5,4,3,2,1];
    await f.bonus.ensure(p,'Raid');const issued=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    expect(issued.result!.operation.eventType).toBe('ATTACK');
    expect(issued.bonus.raid.bots).toHaveLength(10);expect(issued.bonus.raid.bots[0].facilityLevels).toEqual([1,1,1,1,1]);
    expect(issued.bonus.raid.bots[0].worldId).toBe('dunes');expect(f.items.get('COLLECTION').raidTickets).toBe(1);
    const before=f.configs.load;f.configs.load=async name=>{const c=await before(name);if(name==='raid')(c.data as any).multiplier=999;return c;};
    const id=issued.result!.operation.raidId;
    const [a,b]=await Promise.all([f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0}),f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0})]);
    expect(a.result!.result.rewardAmount).toBe(100);expect(b.save.wallet.yallaPoint).toBe(100);expect(f.items.get('COLLECTION').raidTickets).toBe(0);
    await expect(f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:1})).rejects.toMatchObject({code:'RESULT_CONFLICT'});
    await f.bonus.acknowledge(p,'Raid',id);await f.bonus.finish(p,'Raid');expect(f.items.get('WALLET').yallaPoint).toBe(100);
  });
  it('fills a legacy roster and persists missing timers during a bonus read', async () => {
    const f = await fixture('Raid', 1);
    await f.bonus.get(p);
    const legacy = f.items.get('BONUS#STATE');
    legacy.raid.bots = legacy.raid.bots.slice(0, 6);
    const existing = legacy.raid.bots[0];
    existing.facilityLevels[0] = 5;
    delete existing.shieldRegenAt;
    await f.bonus.get(p);
    const stored = f.items.get('BONUS#STATE').raid.bots;
    expect(stored).toHaveLength(10);
    expect(stored[0]).toEqual({...existing, shieldRegenAt: f.save.wallet.updatedAt});
  });
  it.each([[1, 0], [2, 5], [5, 9]])('pays 10%% of the selected building price at level %i once after a shield block', async (level, reward) => {
    const f = await fixture('Raid', 1);
    const previous = f.configs.load;
    f.configs.load = async name => {
      const config = await previous(name);
      if (name === 'raid') (config.data as any).initialShieldCounts[0] = 1;
      if (name === 'world-buildings') (config.data as any).worldOverrides.dunes = {
        buildingOverrides: {'building-2': {upgradePrices: [9, 59, 79, 99]}},
      };
      return config;
    };
    f.items.get('COLLECTION').shieldCount = 3;
    await f.bonus.ensure(p,'Raid');
    const facilities = f.items.get('BONUS#STATE').raid.bots[0].facilityLevels;
    facilities[1] = level;
    const ready = await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const id = ready.result!.operation.raidId;
    const attack = () => f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:1});
    const [first, retry] = await Promise.all([attack(),attack()]);
    expect(first.result!.result).toMatchObject({outcome:'BLOCKED',result:'BlockedByShield',rewardAmount:reward,shieldConsumed:true,blockedRewardEligible:true});
    expect(retry.result!.result).toEqual(first.result!.result);
    expect(first.bonus.raid.bots[0]).toMatchObject({shieldCount:0,facilityLevels:facilities});
    expect(f.items.get('COLLECTION')).toMatchObject({shieldCount:3,raidTickets:0});
    await f.bonus.acknowledge(p,'Raid',id);
    await f.bonus.acknowledge(p,'Raid',id);
    expect(f.items.get('WALLET').yallaPoint).toBe(reward);
  });
  it('restarts the timer after consuming a full bot shield and commits concurrent attacks once',async()=>{
    const f=await fixture('Raid',1);const previous=f.configs.load;f.configs.load=async name=>{const c=await previous(name);if(name==='raid')(c.data as any).initialShieldCounts[0]=3;return c;};
    f.items.get('COLLECTION').shieldCount=2;await f.bonus.ensure(p,'Raid');const ready=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const id=ready.result!.operation.raidId;
    await Promise.all([f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0}),f.bonus.attack(p,id,{requestId:randomUUID(),facilityId:0})]);
    expect((await f.bonus.get(p)).bingo.missions.find(m => m.missionId === 'Attack')?.completed).toBe(true);
    expect(f.items.get('BONUS#STATE').raid.bots[0].shieldCount).toBe(2);
    expect(f.items.get('BONUS#STATE').raid.bots[0].shieldRegenAt).toBe(f.save.wallet.updatedAt);
    f.advance(3*3600000);const [a,b]=await Promise.all([f.bonus.get(p),f.bonus.get(p)]);
    expect(a.bonus.raid.bots[0]).toMatchObject({shieldCount:3,shieldRegenAt:null});expect(b.bonus.raid.bots[0].shieldCount).toBe(3);
    expect(f.items.get('COLLECTION').shieldCount).toBe(2);
  });
  it('preserves the original bot state and enforces independent defense switches',async()=>{
    const f=await fixture('Raid',1);await f.bonus.ensure(p,'Raid');let initial=await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const original=initial.bonus.raid.bots[0];await f.bonus.cancelRaid(p,initial.result!.operation.raidId);
    const state=f.items.get('BONUS#STATE');state.raid.bots[0].shieldCount=2;state.raid.bots[0].shieldRegenAt=null;
    f.botSettings.bots[0]!.attackEnabled=false;f.botSettings.bots[0]!.defenseEnabled=false;
    await expect(f.bonus.beginRaid(p,{requestId:randomUUID(),botId:original.botId})).rejects.toMatchObject({code:'INVALID_RAID_TARGET'});
    expect(f.items.get('BONUS#STATE').raid.bots[0].shieldCount).toBe(2);
    f.botSettings.bots[0]!.defenseEnabled=true;initial=await f.bonus.beginRaid(p,{requestId:randomUUID(),botId:original.botId});
    expect(initial.bonus.raid.bots[0]).toMatchObject({botId:original.botId,shieldCount:2});
  });
  it('regenerates a bot while an offline incoming attack consumes the player shield',async()=>{
    const f=await fixture('Raid',1);f.items.get('COLLECTION').shieldCount=2;
    await f.bonus.ensure(p,'Raid');await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const player=f.save.profile.playerId, now=Date.parse(f.save.wallet.updatedAt);
    f.items.set('INCOMING#SCHEDULE',{...newIncomingSchedule(player,now-86400000),dueAt:new Date(now-1).toISOString()});
    const c=structuredClone(DEFAULT_BOTS);c.incomingRaid.enabled=true;
    const worker=new IncomingRaidService({...f.db,due:async()=>[{playerId:player}]},{load:async()=>c},()=>now+3*3600000);
    f.advance(3*3600000);await Promise.all([f.bonus.get(p),worker.execute(player)]);
    expect(f.items.get('BONUS#STATE').raid.bots[0].shieldCount).toBe(1);
    expect(f.items.get('COLLECTION').shieldCount).toBe(1);
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

describe('player attack targets', () => {
  it.each([false, true])('recovers a saved empty ATTACK without consuming a ticket (explicit retry: %s)', async explicitRetry => {
    const f = await fixture('Raid', 2);
    await f.bonus.ensure(p,'Raid');
    const first = await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const original = first.result!.operation;
    const state = f.items.get('BONUS#STATE');
    const record = f.items.get(`RAID#${original.raidId}`);
    const empty = {...original, playerTarget:{playerId:randomUUID()}, eligibleCosts:[null,null,null,null,null]};
    f.items.set('BONUS#STATE', {...state,raid:{...state.raid,activeRaid:empty}});
    f.items.set(`RAID#${original.raidId}`, {...record,operation:empty});

    const request = {requestId:randomUUID(), ...(explicitRetry ? {replaceRaidId:original.raidId} : {})};
    const recovered = await f.bonus.beginRaid(p,request);
    expect(recovered.result!.operation.raidId).toBe(request.requestId);
    expect(recovered.result!.operation.playerTarget).toBeUndefined();
    expect(recovered.result!.operation.eligibleCosts.some((cost: unknown) => cost != null)).toBe(true);
    expect((await f.bonus.beginRaid(p,request)).result!.operation.raidId).toBe(request.requestId);
    expect(f.items.get(`RAID#${original.raidId}`).status).toBe('CANCELLED');
    expect(f.items.get('COLLECTION').raidTickets).toBe(2);
  });

  it('changes targets for free and atomically settles shields, damage, Activity and revenge across both accounts', async () => {
    const f = await fixture('Raid', 3);
    const attacker = f.save.profile.playerId;
    const remote = newSave(f.save.wallet.updatedAt);
    const defender = remote.profile.playerId;
    const defenderPrincipal: Principal = {provider: 'guest', subject: defender};
    const rows = f.partition(defender);
    rows.set('PROFILE', remote.profile);
    rows.set('PROGRESS', {...remote.progress, facilityLevels: [3,3,3,3,3]});
    rows.set('WALLET', remote.wallet);
    rows.set('COLLECTION', {...newCollection(remote.wallet.updatedAt),shieldCount:1,raidTickets:1});
    rows.set('BONUS#batch#Raid',{...f.items.get('BONUS#batch#Raid'),total:1});
    const pair = f.partition(`FRIENDS#PAIR#${[attacker,defender].sort().join('#')}`);
    f.items.set('PROGRESS', {...f.save.progress,facilityLevels:[3,3,3,3,3]});
    rows.set(`WORLD#${remote.progress.worldId}`,{version:1,status:'ACTIVE',levels:[3,3,3,3,3]});
    await f.drops.open(defenderPrincipal);
    await f.bonus.ensure(p,'Raid');
    const base = await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const replaceRaidId = base.result!.operation.raidId;
    const first = {requestId:randomUUID(),replaceRaidId,targetPlayerId:defender};
    await expect(f.bonus.beginRaid(p,first)).rejects.toMatchObject({code:'RAID_TARGET_NOT_ALLOWED'});
    expect(f.items.get(`RAID#${replaceRaidId}`).status).toBe('READY');

    pair.set('STATE',{state:'ACCEPTED',revision:randomUUID()});
    rows.set('COLLECTION', {...rows.get('COLLECTION'), shieldCount:0});
    rows.set('PROGRESS', {...rows.get('PROGRESS'), facilityLevels:[1,1,1,1,1]});
    expect((await f.bonus.withAttackAvailability(p,[{playerId:defender}]))[0])
      .toMatchObject({attackAvailability:{available:false,reason:'NO_ATTACKABLE_BUILDINGS'}});
    await expect(f.bonus.beginRaid(p,first)).rejects.toMatchObject({code:'ATTACK_TARGET_NO_ELIGIBLE_BUILDINGS'});
    expect(f.items.get(`RAID#${replaceRaidId}`).status).toBe('READY');
    rows.set('COLLECTION', {...rows.get('COLLECTION'), shieldCount:1});
    rows.set('PROGRESS', {...rows.get('PROGRESS'), facilityLevels:[3,3,3,3,3]});
    const target = await f.bonus.beginRaid(p,first);
    expect(target.result!.operation.playerTarget).toMatchObject({
      playerId:defender,nickname:remote.profile.nickname,avatarId:remote.profile.avatarId,facilityLevels:[3,3,3,3,3],shieldCount:1,
    });
    expect(f.items.get(`RAID#${replaceRaidId}`).status).toBe('CANCELLED');
    expect(f.items.get('COLLECTION').raidTickets).toBe(3);
    const strike = {requestId:randomUUID(),facilityId:0};
    const [blocked, retry] = await Promise.all([
      f.bonus.attack(p, first.requestId, strike), f.bonus.attack(p, first.requestId, strike),
    ]);
    expect(blocked.result!.result).toMatchObject({outcome:'BLOCKED',shieldConsumed:true,defenderEntityType:'RemotePlayer'});
    expect(retry.result!.result).toEqual(blocked.result!.result);
    expect(rows.get('COLLECTION').shieldCount).toBe(0);
    expect(rows.get('PROGRESS').facilityLevels).toEqual([3,3,3,3,3]);
    expect(f.items.get('COLLECTION').raidTickets).toBe(2);
    expect((await f.bonus.revengeTargets(defenderPrincipal)).entries.map(row => row?.playerId)).toEqual([attacker]);
    const incomingKey = `INCOMING#PLAYER_ATTACK#${first.requestId}`;
    expect(privateActivity(defender,incomingKey,rows.get(incomingKey))).toMatchObject({
      direction:'INCOMING',outcome:'BLOCKED',attacker:{id:attacker,type:'PLAYER'},
    });
    expect(privateActivity(attacker,`RAID#${first.requestId}`,f.items.get(`RAID#${first.requestId}`)))
      .toMatchObject({direction:'OUTGOING',defender:{id:defender,type:'PLAYER'}});

    await f.bonus.acknowledge(p,'Raid',first.requestId);
    const older = newSave(f.save.wallet.updatedAt).profile;
    f.partition(older.playerId).set('PROFILE', older);
    rows.set(`REVENGE#${older.playerId}`,{version:1,occurredAt:f.save.wallet.updatedAt});
    f.advance(60*60_000-1);
    const repeat = {requestId:randomUUID(),targetPlayerId:defender};
    await expect(f.bonus.beginRaid(p,repeat)).rejects.toMatchObject({code:'ATTACK_TARGET_COOLDOWN'});
    expect((await f.bonus.withAttackAvailability(p,[{playerId:defender}]))[0])
      .toMatchObject({attackAvailability:{available:false,reason:'COOLDOWN'}});
    f.advance(1);
    await f.bonus.beginRaid(p,repeat);
    await f.bonus.attack(p,repeat.requestId,{...strike,facilityId:2});
    await f.bonus.acknowledge(p,'Raid',repeat.requestId);
    expect((await f.bonus.revengeTargets(defenderPrincipal)).entries.map(row => row?.playerId))
      .toEqual([attacker,older.playerId]);
    await f.bonus.ensure(defenderPrincipal,'Raid');
    pair.set('STATE',{state:'REMOVED',revision:randomUUID()});
    const counter = {requestId:randomUUID(),targetPlayerId:attacker};
    await f.bonus.beginRaid(defenderPrincipal,counter);
    await f.bonus.attack(defenderPrincipal,counter.requestId,{...strike,facilityId:1});
    expect((await f.bonus.revengeTargets(defenderPrincipal)).entries.map(row => row?.playerId)).toEqual([older.playerId]);
    expect(f.items.get('PROGRESS').facilityLevels).toEqual([3,2,3,3,3]);
    expect(currentVillageDamage(f.items.get('PROGRESS'))['building-2']).toMatch(/^\d+$/);

    f.advance(60*60_000);
    const reply = {requestId:randomUUID(),targetPlayerId:defender};
    await f.bonus.beginRaid(p,reply);
    await f.bonus.attack(p,reply.requestId,strike);
    expect((await f.bonus.revengeTargets(defenderPrincipal)).entries.map(row => row?.playerId))
      .toEqual([attacker,older.playerId]);
    expect(rows.get('PROGRESS').facilityLevels).toEqual([2,3,2,3,3]);
    expect(rows.get(`WORLD#${remote.progress.worldId}`).levels).toEqual([2,3,2,3,3]);
    expect(rows.has(incomingKey)).toBe(true);
  });
});

describe('player wallet RAID', () => {
  it('uses configurable bags, transfers conserved YP once, and limits each target for a rolling hour', async () => {
    const f = await fixture('Raid', 2);
    const attacker = f.save.profile.playerId;
    const target = newSave(f.save.wallet.updatedAt);
    const targetId = target.profile.playerId;
    const targetPrincipal: Principal = {provider:'guest',subject:targetId};
    const rows = f.partition(targetId);
    rows.set('PROFILE',target.profile);
    rows.set('PROGRESS',target.progress);
    rows.set('WALLET',{...target.wallet,yallaPoint:1000});
    rows.set('ACTIVITY',{lastActiveAt:f.save.wallet.updatedAt});
    f.partition(`FRIENDS#PAIR#${[attacker,targetId].sort().join('#')}`)
      .set('STATE',{state:'ACCEPTED',revision:randomUUID()});
    f.items.get('BONUS#batch#Raid').eventTypes=['RAID','RAID'];
    await f.bonus.ensure(p,'Raid');
    const bot = await f.bonus.beginRaid(p,{requestId:randomUUID()});
    const input = {requestId:randomUUID(),targetPlayerId:targetId,replaceRaidId:bot.result!.operation.raidId};
    await expect(f.bonus.beginRaid(p,input)).rejects.toMatchObject({code:'RAID_TARGET_ONLINE_OR_INACTIVE'});
    f.advance(6*60_000);
    const opened = await f.bonus.beginRaid(p,input);
    expect(JSON.stringify(opened)).not.toContain('bagGold');
    expect(f.items.get('COLLECTION').raidTickets).toBe(2);
    const id = input.requestId;
    const values = f.items.get(`RAID#${id}`).bagGold as number[];
    expect([...values].sort((a,b)=>a-b)).toEqual([0,0,0,100,200]);
    const ids = [values.indexOf(100),values.indexOf(200),values.indexOf(0)];
    const pick = (bagId: number) => f.bonus.pick(p,id,{requestId:randomUUID(),bagId});
    await pick(ids[0]!);
    expect(rows.get('WALLET').yallaPoint).toBe(1000);
    await expect(f.bonus.beginRaid(p,{requestId:randomUUID(),replaceRaidId:id,targetPlayerId:targetId}))
      .rejects.toMatchObject({code:'RAID_ALREADY_STARTED'});
    await pick(ids[1]!);
    const before = f.items.get('WALLET').yallaPoint;
    const command = {requestId:randomUUID(),bagId:ids[2]!};
    const [settled,replay] = await Promise.all([f.bonus.pick(p,id,command),f.bonus.pick(p,id,command)]);
    expect(settled.result!.result).toMatchObject({rewardAmount:300,outcome:'HIT'});
    expect(replay.result!.result).toEqual(settled.result!.result);
    expect(f.items.get('WALLET').yallaPoint-before).toBe(300);
    expect(rows.get('WALLET').yallaPoint).toBe(700);
    expect((await f.bonus.revengeTargets(targetPrincipal,'RAID')).entries.map(row=>row?.playerId)).toEqual([attacker]);
    expect((await f.bonus.revengeTargets(targetPrincipal,'ATTACK')).entries).toEqual([]);
    const receiptKey = `INCOMING#PLAYER_RAID#${id}`;
    expect(privateActivity(targetId,receiptKey,rows.get(receiptKey))).toMatchObject({type:'RAID',direction:'INCOMING',stolenYP:300});
    expect(privateActivity(attacker,`RAID#${id}`,f.items.get(`RAID#${id}`))).toMatchObject({type:'RAID',direction:'OUTGOING',stolenYP:300});
    await f.bonus.acknowledge(p,'Raid',id);
    const second = {requestId:randomUUID(),targetPlayerId:targetId};
    f.advance(60*60_000-1);
    await expect(f.bonus.beginRaid(p,second)).rejects.toMatchObject({code:'RAID_TARGET_COOLDOWN'});
    f.advance(1);
    await f.bonus.beginRaid(p,second);
    rows.set('ACTIVITY',{lastActiveAt:new Date(Date.parse(f.save.wallet.updatedAt)+66*60_000).toISOString()});
    for (const bagId of [0,1,2]) await f.bonus.pick(p,second.requestId,{requestId:randomUUID(),bagId});
    expect(f.items.get(`RAID#${second.requestId}`).result).toMatchObject({rewardAmount:0,targetUnavailable:true});
    expect(rows.get('WALLET').yallaPoint).toBe(700);
    expect(rows.get('PLAYER_RAID#COOLDOWN').version).toBe(1);
  });
});
