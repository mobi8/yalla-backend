import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {newSave,type Save,type Principal,progressSchema} from '../src/model.js';
import {parseConfig,type ConfigName,type ConfigSource} from '../src/game-config.js';
import {loadWorldCatalog,worldConfigSchema,worldRewardsSchema} from '../src/world-config.js';
import {WorldService} from '../src/world.js';
import {IncomingRaidService,newIncomingSchedule} from '../src/incoming-raid.js';
import {DEFAULT_BOTS} from '../src/bots-config.js';
import {DropService,type Write} from '../src/drop.js';
import type {BonusStore} from '../src/bonus.js';
import type {PlayerRepository} from '../src/repository.js';
process.env.ENVIRONMENT='dev';process.env.RESULT_POLICY='PERMISSIVE';
const principal:Principal={provider:'guest',subject:'owner'};
const read=<K extends ConfigName>(name:K)=>parseConfig(name,readFileSync(new URL(`../config/dev/${name}.json`,import.meta.url),'utf8'),'dev');
const worlds=read('world').data.worlds.map(world=>world.id);
async function fixture(world=1,allReady=false){
 const save=newSave('2026-11-17T00:00:00Z');save.wallet.yallaPoint=1000;save.progress.worldId=worlds[world-1]!;save.progress.highestUnlockedWorld=world-1;
 const items=new Map<string,any>([['PROFILE',save.profile],['PROGRESS',save.progress],['WALLET',save.wallet]]);
 const live=new Map<ConfigName,any>(Object.keys((await import('../src/game-config.js')).configSchemas).map(k=>[k as ConfigName,read(k as ConfigName)]));
 if(allReady){for(const w of live.get('world').data.worlds){w.enabled=true;w.contentState='READY';w.objectSetKey??='dunes';w.thumbnailAssetKey='fixture-thumbnail';}for(const r of live.get('world-rewards').data.worlds)r.confirmed=true;}
 const configs:ConfigSource={load:async name=>structuredClone(live.get(name))};
 const db:BonusStore={get:async(p,sk)=>p===save.profile.playerId?structuredClone(items.get(sk)):undefined,
 list:async(_p,prefix)=>[...items].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>({...structuredClone(v),_key:k})),
 commit:async(_p,writes:Write[])=>{for(const w of writes)if(w.expectedVersion===undefined?items.has(w.sk):items.get(w.sk)?.version!==w.expectedVersion){const e=new Error();e.name='TransactionCanceledException';throw e;}for(const w of writes)items.set(w.sk,structuredClone(w.value));}};
 const players:PlayerRepository={find:async p=>p.subject==='owner'?save.profile.playerId:undefined,read:async()=>structuredClone({profile:items.get('PROFILE'),wallet:items.get('WALLET'),progress:items.get('PROGRESS')}) as Save,create:async()=>{}};
 const drops=new DropService(players,db,{pick:async()=>{throw new Error();}},()=>Date.parse(save.wallet.updatedAt),undefined,configs);
 await drops.open(principal);
 const service=new WorldService(players,db,drops,configs,()=>Date.parse(save.wallet.updatedAt),
  {load:async()=>structuredClone(DEFAULT_BOTS)});
 const cmd=async(id=items.get('PROGRESS').worldId)=>({requestId:randomUUID(),worldId:id,configRevision:(await service.state(principal)).catalog.revision});
 return{service,items,configs,live,db,cmd};
}
describe('World 100 catalog and compatibility',()=>{
 it('keeps 7 names/order, 5 buildings x 5 levels, authored art and unconfirmed worlds locked',async()=>{
  const f=await fixture(),s=await f.service.state(principal);
  expect(s.catalog.worlds).toHaveLength(100);expect(s.catalog.worlds.slice(0,7).map(w=>w.id)).toEqual(['dunes','canyon','oasis','bazaar','palace','nightcity','goldentemple']);
  expect(s.currentWorld.buildings).toHaveLength(5);expect(s.currentWorld.buildings.every(b=>b.levels.length===5)).toBe(true);
  expect(s.catalog.worlds.filter(w=>w.playable)).toHaveLength(15);expect(s.worldState.levels).toEqual([1,1,1,1,1]);
  expect(s.catalog.worlds[30]!.thumbnailAssetKey).toBe(s.catalog.worlds[30]!.fallbackAssetKey);
  expect([...f.items.keys()].filter(k=>k.startsWith('WORLD#'))).toHaveLength(0);
 });
 it('rejects unconfirmed or unsupported rewards and cross-file release mismatch',async()=>{
  const f=await fixture();f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];
  f.live.get('world-rewards').data.worlds[0].completionRewards=[{type:'COSTUME_ITEM',amount:1,itemId:'unimplemented'}];
  await expect(f.service.execute(principal,'complete',await f.cmd())).rejects.toMatchObject({code:'WORLD_REWARD_UNSUPPORTED'});
  expect(f.items.get('WALLET').yallaPoint).toBe(1000);
  f.live.get('world-buildings').data.releaseId='other';await expect(f.service.state(principal)).rejects.toMatchObject({code:'WORLD_CONFIG_INVALID'});
 });
 it('accepts legacy schema 1 progress without resetting village, wallet or previous metadata',async()=>{
  const f=await fixture();f.items.get('PROGRESS').village=4;f.items.get('PROGRESS').facilityLevels=[2,3,1,5,4];
  const s=await f.service.state(principal);expect(s.worldState.levels).toEqual([2,3,1,5,4]);expect(s.save.progress.village).toBe(4);expect(s.save.wallet.yallaPoint).toBe(1000);
  expect(progressSchema.parse({...s.save.progress,worldId:'world-100',highestUnlockedWorld:99}).worldId).toBe('world-100');
 });
});
describe('World economy and one-way progress',()=>{
 it('downgrades only an eligible building and atomically restores its lost level at half price',async()=>{
  const f=await fixture(),p=f.items.get('PROGRESS'),player=f.items.get('PROFILE').playerId;
  const now=Date.parse(p.updatedAt);
  f.live.get('world-buildings').data.defaults.upgradePrices=[11,21,31,41];
  p.facilityLevels=[3,1,1,1,1];p.village=3;p.constructionStars='2';
  f.items.set('WORLD#dunes',{version:1,worldId:'dunes',levels:[3,1,1,1,1],status:'ACTIVE'});
  f.items.set('ACTIVITY',{lastActiveAt:new Date(now-360000).toISOString()});
  const settings=structuredClone(DEFAULT_BOTS);
  settings.incomingRaid.enabled=true;settings.incomingRaid.targetOffline=true;
  settings.offlinePolicy={scheduleMinutes:15,offlineMinMinutes:5,offlineMaxHours:24,perPlayerCooldownMinutes:0,dailyLimit:null};
  const worker=new IncomingRaidService({...f.db,due:async()=>[]},{load:async()=>settings},()=>now);
  expect(await worker.execute(player)).toBe(true);
  expect(f.items.get('INCOMING#RECEIPT#0000000000000001')).toMatchObject({
   eventId:`ATTACK:${player}:1`,eventType:'ATTACK',actorType:'BOT',targetPlayerId:player,
   facilityId:'building-1',levelBefore:3,levelAfter:2,outcome:'HIT',
  });
  const hit=await f.service.state(principal);
  expect(hit.save.progress).toMatchObject({facilityLevels:[2,1,1,1,1],worldId:'dunes',village:3,worldRunId:p.worldRunId,constructionStars:'2'});
  expect(hit.worldState.levels).toEqual([2,1,1,1,1]);
  expect(hit.save.wallet.yallaPoint).toBe(1000);
  expect(hit.worldState.repairs).toEqual([{buildingId:'building-1',attackId:'1',cost:11}]);
  expect(await worker.execute(player)).toBe(false);
  const repair={...await f.cmd(),buildingId:'building-1' as const,attackId:'1'};
  const results=await Promise.all([f.service.execute(principal,'repair',repair),f.service.execute(principal,'repair',repair)]);
  for(const result of results)
   expect(result.bingo.missions.find(m=>m.missionId==='Upgrade')).toMatchObject({progress:1,completed:true});
  for(const result of results){
   expect(result.worldState.levels).toEqual([3,1,1,1,1]);
   expect(result.worldState.repairs).toEqual([]);
   expect(result.save.wallet.yallaPoint).toBe(989);
   expect(result.save.progress).toMatchObject({facilityLevels:[3,1,1,1,1],worldId:'dunes',village:3,worldRunId:p.worldRunId,constructionStars:'2'});
  }
 });
 it('quotes half the previous upgrade rounded up, blocks damaged upgrades and replays repair only once',async()=>{
  const f=await fixture(),p=f.items.get('PROGRESS');
  f.live.get('world-buildings').data.defaults.upgradePrices=[11,21,31,41];
  p.facilityLevels=[3,1,1,1,1];p.constructionStars='2';
  p.villageDamage={worldRunId:p.worldRunId,village:p.village,buildings:{'building-1':'1'}};
  const buildingId='building-1' as const;
  const command={...await f.cmd(),buildingId,attackId:'1'};
  expect((await f.service.state(principal)).worldState.repairs).toEqual([{buildingId,attackId:'1',cost:11}]);
  await expect(f.service.execute(principal,'upgrade',{...await f.cmd(),buildingId,expectedLevel:3})).rejects.toMatchObject({code:'BUILDING_DAMAGED'});
  await f.service.execute(principal,'upgrade',{...await f.cmd(),buildingId:'building-2',expectedLevel:1});
  f.items.get('WALLET').yallaPoint=10;
  await expect(f.service.execute(principal,'repair',command)).rejects.toMatchObject({code:'INSUFFICIENT_YALLA_POINT'});
  f.items.get('WALLET').yallaPoint=100;
  const [a,b]=await Promise.all([f.service.execute(principal,'repair',command),f.service.execute(principal,'repair',command)]);
  expect(a.result).toEqual(b.result);
  expect(a.save.wallet.yallaPoint).toBe(89);
  expect(b.save.progress).toMatchObject({facilityLevels:[3,2,1,1,1],constructionStars:'3'});
  expect(b.worldState.repairs).toEqual([]);
  await f.service.execute(principal,'upgrade',{...await f.cmd(),buildingId,expectedLevel:3});
 });
 it('honors a friend discount committed after the owner repair intent without charging twice',async()=>{
  const f=await fixture(),p=f.items.get('PROGRESS');
  f.live.get('world-buildings').data.defaults.upgradePrices=[11,21,31,41];
  p.facilityLevels=[2,1,1,1,1];
  p.villageDamage={worldRunId:p.worldRunId,village:p.village,buildings:{'building-1':'1'},levelsBefore:{'building-1':3}};
  const command={...await f.cmd(),buildingId:'building-1' as const,attackId:'1'};
  const commit=f.db.commit.bind(f.db);
  f.db.commit=async(player,writes)=>{
   if(writes.some(write=>write.sk===`WORLD#REQUEST#${command.requestId}`)){
    await commit(player,writes);
    const current=f.items.get('PROGRESS');
    current.version++;
    current.villageDamage.help={'building-1':{attackId:'1',savedYP:3}};
    return;
   }
   await commit(player,writes);
  };
  const repaired=await f.service.execute(principal,'repair',command);
  expect(repaired.result.cost).toBe(8);
  expect(repaired.save.wallet.yallaPoint).toBe(992);
  expect(repaired.save.progress.facilityLevels[0]).toBe(3);
  expect(repaired.save.progress.villageDamage).toBeUndefined();
  expect((await f.service.execute(principal,'repair',command)).save.wallet.yallaPoint).toBe(992);
 });
 it('blocks completion and travel on current damage while ignoring damage from other checkpoints',async()=>{
  const f=await fixture(),p=f.items.get('PROGRESS');
  p.facilityLevels=[5,5,5,5,5];
  p.villageDamage={worldRunId:p.worldRunId,village:p.village,buildings:{'building-5':'1'}};
  await expect(f.service.execute(principal,'complete',await f.cmd())).rejects.toMatchObject({code:'VILLAGE_DAMAGED'});
  p.villageDamage.village=p.village+1;
  expect((await f.service.state(principal)).worldState.repairs).toEqual([]);
  await f.service.execute(principal,'complete',await f.cmd());
  const completed=f.items.get('PROGRESS');
  completed.villageDamage={worldRunId:completed.worldRunId,village:completed.village,buildings:{'building-5':'2'}};
  await expect(f.service.execute(principal,'select',await f.cmd('canyon'))).rejects.toMatchObject({code:'VILLAGE_DAMAGED'});
  await f.service.execute(principal,'repair',{...await f.cmd(),buildingId:'building-5',attackId:'2'});
  const selected=await f.service.execute(principal,'select',await f.cmd('canyon'));
  expect(selected.worldState.repairs).toEqual([]);
  expect(selected.save.progress.villageDamage).toBeUndefined();
 });
 it('preserves a concurrent new HIT while repairing an older attack',async()=>{
  const f=await fixture(),p=f.items.get('PROGRESS'),player=f.items.get('PROFILE').playerId;
  const now=Date.parse(p.updatedAt);
  p.villageDamage={worldRunId:p.worldRunId,village:p.village,buildings:{'building-1':'1'}};
  f.items.set('INCOMING#SCHEDULE',{...newIncomingSchedule(player,now),dueAt:p.updatedAt,sequence:2});
  const config=structuredClone(DEFAULT_BOTS);config.incomingRaid.enabled=true;
  const worker=new IncomingRaidService({...f.db,due:async()=>[]},{load:async()=>config},()=>now);
  const command={...await f.cmd(),buildingId:'building-1' as const,attackId:'1'};
  await Promise.all([worker.execute(player),f.service.execute(principal,'repair',command)]);
  const state=await f.service.state(principal);
  const hit=f.items.get('INCOMING#RECEIPT#0000000000000002');
  expect(hit.outcome).toBe('HIT');
  expect(state.worldState.repairs).toEqual([{buildingId:hit.buildingId,attackId:'2',cost:5}]);
  expect(state.save.wallet.yallaPoint).toBe(995);
  await f.service.execute(principal,'repair',command);
  expect((await f.service.state(principal)).worldState.repairs).toEqual(state.worldState.repairs);
 });
 it('upgrades every building 1->5, debits 200 once, completes once, unlocks and enters world 2 with level 1',async()=>{
  const f=await fixture();
  for(let b=1;b<=5;b++)for(let level=1;level<=4;level++){
   const command={...await f.cmd(),buildingId:`building-${b}` as 'building-1',expectedLevel:level};
   const result=await f.service.execute(principal,'upgrade',command);await f.service.execute(principal,'upgrade',command);
   expect(result.result.cost).toBe(10);
   expect(result.bingo.missions.find(m => m.missionId === 'Upgrade')?.progress).toBe(1);
  }
  expect(f.items.get('WALLET').yallaPoint).toBe(800);expect(f.items.get('PROGRESS').constructionStars).toBe('20');
  const command=await f.cmd();const [a,b]=await Promise.all([f.service.execute(principal,'complete',command),f.service.execute(principal,'complete',{...command,requestId:randomUUID()})]);
  expect(a.save.wallet.yallaPoint).toBe(900);expect(b.save.wallet.yallaPoint).toBe(900);expect(a.unlockedWorldIds).toContain('canyon');
  const selected=await f.service.execute(principal,'select',await f.cmd('canyon'));
  expect(f.items.get('BONUS#STATE').raid.bots).toHaveLength(10);
  expect(f.items.get('BONUS#STATE').raid.bots.every((bot: any) => bot.worldId === 'canyon')).toBe(true);
  expect(selected.save.progress).toMatchObject({worldId:'canyon',village:1,facilityLevels:[1,1,1,1,1],worldRunComplete:false});
  expect(f.items.get('WORLD#dunes')).toMatchObject({status:'COMPLETE',levels:[5,5,5,5,5],rewardClaimed:true});
  await expect(f.service.execute(principal,'select',await f.cmd('dunes'))).rejects.toMatchObject({code:'COMPLETE_CURRENT_WORLD_FIRST'});
 });
 it('rejects insufficient funds, MAX, wrong owner, locked next world and stale level',async()=>{
  const f=await fixture();let command={...await f.cmd(),buildingId:'building-1' as const,expectedLevel:1};
  f.items.get('WALLET').yallaPoint=0;await expect(f.service.execute(principal,'upgrade',command)).rejects.toMatchObject({code:'INSUFFICIENT_YALLA_POINT'});
  f.items.get('WALLET').yallaPoint=100;f.items.get('PROGRESS').facilityLevels[0]=5;
  await expect(f.service.execute(principal,'upgrade',{...command,requestId:randomUUID(),expectedLevel:5})).rejects.toMatchObject({code:'BUILDING_MAX'});
  f.items.get('PROGRESS').facilityLevels[0]=2;await expect(f.service.execute(principal,'upgrade',{...command,requestId:randomUUID()})).rejects.toMatchObject({code:'STALE_BUILDING_LEVEL'});
  await expect(f.service.state({...principal,subject:'other'})).rejects.toMatchObject({code:'PLAYER_NOT_FOUND'});
  await expect(f.service.execute(principal,'select',await f.cmd('world-016'))).rejects.toMatchObject({code:'WORLD_DISABLED'});
 });
 it('supports distinct multiple currency rewards only in test fixtures, never invents live future rewards',async()=>{
  const f=await fixture();f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];
  f.live.get('world-rewards').data.worlds[0].completionRewards=[{type:'ENERGY',amount:2},{type:'YALLA_POINT',amount:3},{type:'DIAMOND',amount:4}];
  const first=await f.service.execute(principal,'complete',await f.cmd());expect(first.save.wallet).toMatchObject({energy:52,yallaPoint:1003,diamond:4});
  await f.service.execute(principal,'select',await f.cmd('canyon'));f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];f.items.get('WORLD#canyon').levels=[5,5,5,5,5];
  const second=await f.service.execute(principal,'complete',await f.cmd());expect(second.save.wallet.yallaPoint).toBe(1103);
  await expect(f.service.execute(principal,'select',await f.cmd('dunes'))).rejects.toMatchObject({code:'WORLD_SELECTION_FORBIDDEN'});
 });
 it('does not regrant completed world rewards after config changes',async()=>{
  const f=await fixture();f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];
  const first=await f.service.execute(principal,'complete',await f.cmd());
  f.live.get('world-rewards').version='reward-v2';f.live.get('world-rewards').contentHash='f'.repeat(64);f.live.get('world-rewards').data.worlds[0].completionRewards[0].amount=999;
  const duplicate=await f.service.execute(principal,'complete',await f.cmd());
  expect(duplicate.save.wallet.yallaPoint).toBe(1100);expect(duplicate.result.completionRewards).toEqual(first.result.completionRewards);
 });
 it('pins accepted price across response loss and later config changes, and resumes after committed timeout',async()=>{
  const f=await fixture(),command={...await f.cmd(),buildingId:'building-1' as const,expectedLevel:1};
  const commit=f.db.commit;let fail=true;
  f.db.commit=async(p,w)=>{if(fail&&w.some(v=>v.sk==='WALLET')){fail=false;const e=new Error();e.name='TimeoutError';throw e;}await commit(p,w);};
  await expect(f.service.execute(principal,'upgrade',command)).rejects.toMatchObject({name:'TimeoutError'});
  f.live.get('world-buildings').version='buildings-v2';f.live.get('world-buildings').contentHash='e'.repeat(64);f.live.get('world-buildings').data.defaults.upgradePrices=[999,999,999,999];
  const recovered=await f.service.execute(principal,'upgrade',command);expect(recovered.result.cost).toBe(10);expect(recovered.save.wallet.yallaPoint).toBe(990);
  const second={...await f.cmd(),buildingId:'building-1' as const,expectedLevel:2};fail=true;
  f.live.get('world-buildings').data.defaults.upgradePrices=[10,10,10,10];
  f.db.commit=async(p,w)=>{await commit(p,w);if(fail&&w.some(v=>v.sk==='WALLET')){fail=false;const e=new Error();e.name='TimeoutError';throw e;}};
  await expect(f.service.execute(principal,'upgrade',second)).rejects.toMatchObject({name:'TimeoutError'});
  expect((await f.service.execute(principal,'upgrade',second)).save.wallet.yallaPoint).toBe(980);
 });
 it('advances the actual dev bundle from World 07 through 15 and blocks 16',async()=>{
  const f=await fixture(7);
  const p=f.items.get('PROGRESS');
  f.items.get('WALLET').yallaPoint=2000;
  p.worldCompletionCounts=Object.fromEntries(worlds.slice(0,6).map(id=>[id,1]));
  for(let n=7;n<=15;n++){
   const id=worlds[n-1]!;
   for(const buildingId of ['building-1','building-2','building-3','building-4','building-5'] as const)
    for(let expectedLevel=1;expectedLevel<=4;expectedLevel++)
     await f.service.execute(principal,'upgrade',{...await f.cmd(),buildingId,expectedLevel});
   const before=f.items.get('WALLET').yallaPoint;
   const complete=await f.service.execute(principal,'complete',await f.cmd());
   const replay=await f.service.execute(principal,'complete',await f.cmd());
   expect(complete.save.progress).toMatchObject({worldId:id,facilityLevels:[5,5,5,5,5],worldRunComplete:true});
   expect(complete.save.wallet.yallaPoint).toBe(before+100);
   expect(replay.save.wallet.yallaPoint).toBe(before+100);
   expect(complete.save.progress.worldCompletionCounts.dunes).toBe(1);
   if(n<15){
    const next=worlds[n]!;
    const moved=await f.service.execute(principal,'select',await f.cmd(next));
    expect(moved.save.progress).toMatchObject({worldId:next,facilityLevels:[1,1,1,1,1],worldRunComplete:false});
    expect(f.items.get('BONUS#STATE').raid.bots.filter((bot: {worldId:string})=>bot.worldId===next)).toHaveLength(10);
   }
  }
  await expect(f.service.execute(principal,'select',await f.cmd('world-016'))).rejects.toMatchObject({code:'WORLD_DISABLED'});
  expect((await f.service.state(principal)).save.progress).toMatchObject({worldId:'world-015',worldRunComplete:true});
 });
 it('resumes an already completed World 07 without a second reward',async()=>{
  const f=await fixture(7),p=f.items.get('PROGRESS');
  Object.assign(p,{facilityLevels:[5,5,5,5,5],worldRunComplete:true,worldCompletionCounts:{goldentemple:1},highestUnlockedWorld:7});
  const replay=await f.service.execute(principal,'complete',await f.cmd());
  expect(replay.save.wallet.yallaPoint).toBe(1000);
  expect((await f.service.execute(principal,'select',await f.cmd('world-008'))).save.progress.worldId).toBe('world-008');
 });
 it('blocks an enabled world when primary art is missing and accepts an extended catalog',async()=>{
  const f=await fixture();
  const entries=f.live.get('world').data.worlds;
  entries[7].backgroundAssetKey=null;
  expect((await f.service.state(principal)).catalog.worlds[7]).toMatchObject({playable:false,blockedReason:'WORLD_CONTENT_NOT_READY'});
  entries[99].nextWorldId='world-101';
  entries.push({...entries[99],id:'world-101',order:101,rewardKey:'world-101',unlockAfterWorldId:'world-100',nextWorldId:null});
  f.live.get('world-rewards').data.worlds.push({worldId:'world-101',confirmed:false,completionRewards:[]});
  expect(worldConfigSchema.parse(f.live.get('world').data).worlds).toHaveLength(101);
  expect(worldRewardsSchema.parse(f.live.get('world-rewards').data).worlds).toHaveLength(101);
  expect((await loadWorldCatalog(f.configs)).worlds[100]).toMatchObject({id:'world-101',playable:false});
  expect(progressSchema.parse({...f.items.get('PROGRESS'),worldId:'world-101',highestUnlockedWorld:100}).worldId).toBe('world-101');
 });
 it.each([7,30,99])('handles world %i -> next boundary with explicitly synthetic ready content',async(n)=>{
  const f=await fixture(n,true);f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];
  await f.service.execute(principal,'complete',await f.cmd());const moved=await f.service.execute(principal,'select',await f.cmd(worlds[n]!));
  expect(moved.save.progress.worldId).toBe(worlds[n]);expect(moved.save.progress.facilityLevels).toEqual([1,1,1,1,1]);
 });
 it('completes world 100 and retains terminal state with no next world',async()=>{
  const f=await fixture(100,true);f.items.get('PROGRESS').facilityLevels=[5,5,5,5,5];
  const result=await f.service.execute(principal,'complete',await f.cmd());expect(result.result.nextWorldId).toBeNull();
  expect(result.save.progress).toMatchObject({worldId:'world-100',worldRunComplete:true,highestUnlockedWorld:99});
  expect((await f.service.state(principal)).worldState.levels).toEqual([5,5,5,5,5]);
 });
});
