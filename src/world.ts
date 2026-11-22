import { BotsConfigs, type BotsSource } from './bots-config.js';
import { newBonusState, syncRaidBots } from './raid-bots.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoRepository } from './repository.js';
import { DynamoDropStore } from './drop.js';
import { ApiError,type PlayerRepository } from './repository.js';
import { type DropStore,type Write,DropService,type Session } from './drop.js';
import { type ConfigSource } from './game-config.js';
import { loadWorldCatalog,villageRepairCost,buildingIds,type WorldCatalog } from './world-config.js';
import { worldIds } from './world-ids.js';
import { currentVillageDamage,progressSchema,walletSchema,type Principal,type Save } from './model.js';
type Item=Record<string,any>;
export const worldCommand=z.strictObject({requestId:z.string().uuid(),worldId:z.enum(worldIds),configRevision:z.string().regex(/^[a-f0-9]{64}$/)});
export const upgradeCommand=worldCommand.extend({buildingId:z.enum(buildingIds),expectedLevel:z.number().int().min(1).max(5)});
export const repairCommand=worldCommand.extend({buildingId:z.enum(buildingIds),attackId:z.string().regex(/^\d{1,16}$/)});
type WorldAction='upgrade'|'repair'|'complete'|'select';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const meta=(now:string,version=1)=>({schemaVersion:1,version,updatedAt:now});
export class WorldService {
 constructor(private players:PlayerRepository,private db:DropStore,private drops:DropService,private configs:ConfigSource,private clock=Date.now,private botsConfig:BotsSource=new BotsConfigs()){}
 private now(){return new Date(this.clock()).toISOString();}
 private async owner(p:Principal){const id=await this.players.find(p);if(!id)throw new ApiError(404,'PLAYER_NOT_FOUND');return id;}
 private async retry<T>(fn:()=>Promise<T>):Promise<T>{for(let i=0;i<5;i++)try{return await fn();}catch(e){if(!(e instanceof Error)||!['TransactionCanceledException','ConditionalCheckFailedException'].includes(e.name))throw e;}throw new ApiError(409,'STATE_CHANGED_RETRY_SAME_REQUEST');}
 private async catalog(){try{return await loadWorldCatalog(this.configs);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,'WORLD_CONFIG_INVALID');}}
 private async context(player:string){
  const save=(await this.players.read(player))!;
  const active=await this.db.get(player,'SESSION#ACTIVE');
  const session=active?await this.db.get(player,`SESSION#${active.sessionId}`) as Session:undefined;
  if(!session)throw new ApiError(409,'DROP_SESSION_REQUIRED');
  if(session.pendingRoundId)throw new ApiError(409,'ROUND_PENDING');
  const bonus=await this.db.get(player,'BONUS#STATE');
  if(bonus?.run||bonus?.raid?.activeRaid)throw new ApiError(409,'BONUS_ACTIVE');
  return {save,session,bonus};
 }
 private async current(player:string,p:Save['progress']){
  const stored=await this.db.get(player,`WORLD#${p.worldId}`);
  return {stored,value:stored??{...meta(p.updatedAt,0),worldId:p.worldId,levels:[...p.facilityLevels],status:p.worldRunComplete?'COMPLETE':'ACTIVE',rewardClaimed:p.worldRunComplete,completionRewards:[],legacyBaseline:true}};
 }
 private async unlocks(player:string,p:Save['progress']){
  const stored=await this.db.get(player,'WORLD#UNLOCKS');
  return {stored,value:stored??{...meta(p.updatedAt,0),worldIds:worldIds.slice(0,p.highestUnlockedWorld+1)}};
 }
 async state(principal:Principal){
  const player=await this.owner(principal),catalog=await this.catalog();
  for(let i=0;i<5;i++){
   const drop=await this.drops.active(principal),p=drop.save.progress;
   const current=await this.current(player,p),unlocks=await this.unlocks(player,p);
   const after=(await this.players.read(player))!.progress;if(after.version!==p.version)continue;
   const definition=catalog.worlds.find(w=>w.id===p.worldId)!;
   const damage=currentVillageDamage(p);
   const repairs=definition.buildings.flatMap(building=>{
    const attackId=damage[building.id];
    return attackId?[{buildingId:building.id,attackId,cost:villageRepairCost(p,building)}]:[];
   });
   return {...drop,worldState:{...current.value,levels:current.value.levels,worldRunId:p.worldRunId,village:p.village,repairs},unlockedWorldIds:unlocks.value.worldIds,
    currentWorld:definition,catalog:{...catalog,worlds:catalog.worlds.map(({buildings,...w})=>w)}};
  }
  throw new ApiError(409,'STATE_CHANGED_RETRY_SAME_REQUEST');
 }
 private playable(w:WorldCatalog['worlds'][number]){if(!w.playable)throw new ApiError(409,w.blockedReason??'WORLD_CONTENT_NOT_READY');}
 private checkCurrent(p:Save['progress'],id:string){if(p.worldId!==id)throw new ApiError(409,'WORLD_NOT_CURRENT');}
 private checkUndamaged(p:Save['progress']){if(Object.keys(currentVillageDamage(p)).length)throw new ApiError(409,'VILLAGE_DAMAGED');}
 private lock(session:Session):Write{return {sk:`SESSION#${session.sessionId}`,value:{...session,version:session.version+1,updatedAt:this.now()},expectedVersion:session.version};}
 private async replay(player:string,id:string,requestHash:string){
  const receipt=await this.db.get(player,`ECONOMY#OP#world:${id}`);
  if(receipt&&receipt.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
  return receipt;
 }
 private async prepare(player:string,type:string,input:Item):Promise<Item>{
  const requestHash=hash({type,...input}),key=`WORLD#REQUEST#${input.requestId}`;
  const old=await this.db.get(player,key);
  if(old){if(old.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');return old;}
  const catalog=await this.catalog();if(catalog.revision!==input.configRevision)throw new ApiError(409,'CONFIG_CHANGED');
  const ctx=await this.context(player),p=ctx.save.progress;
  const w=catalog.worlds.find(w=>w.id===input.worldId)!;this.playable(w);
  const current=await this.current(player,p);
  let cost=0;
  if(type==='upgrade'){
   this.checkCurrent(p,input.worldId);
   if(p.worldRunComplete||current.value.status==='COMPLETE')throw new ApiError(409,'WORLD_ALREADY_COMPLETE');
   const building=w.buildings.find(b=>b.id===input.buildingId)!;
   const index=buildingIds.indexOf(input.buildingId);
   if(currentVillageDamage(p)[buildingIds[index]!])throw new ApiError(409,'BUILDING_DAMAGED');
   if(p.facilityLevels[index]===5)throw new ApiError(409,'BUILDING_MAX');
   if(p.facilityLevels[index]!==input.expectedLevel)throw new ApiError(409,'STALE_BUILDING_LEVEL');
   cost=building.levels[input.expectedLevel-1]!.upgradeCost!;
   if(ctx.save.wallet.yallaPoint<cost)throw new ApiError(409,'INSUFFICIENT_YALLA_POINT');
  }else if(type==='repair'){
   this.checkCurrent(p,input.worldId);
   if(currentVillageDamage(p)[input.buildingId as typeof buildingIds[number]]!==input.attackId)throw new ApiError(409,'BUILDING_DAMAGE_CHANGED');
   const building=w.buildings.find(b=>b.id===input.buildingId)!;
   cost=villageRepairCost(p,building);
   if(ctx.save.wallet.yallaPoint<cost)throw new ApiError(409,'INSUFFICIENT_YALLA_POINT');
  }else if(type==='complete'){
   this.checkCurrent(p,input.worldId);
   this.checkUndamaged(p);
   if(p.facilityLevels.some(l=>l!==5))throw new ApiError(409,'WORLD_NOT_MAX');
  }else{
   if(!p.worldRunComplete)throw new ApiError(409,'COMPLETE_CURRENT_WORLD_FIRST');
   this.checkUndamaged(p);
   const source=catalog.worlds.find(w=>w.id===p.worldId)!;
   const unlocks=await this.unlocks(player,p);
   if(source.nextWorldId!==input.worldId||!unlocks.value.worldIds.includes(input.worldId)||(w.unlockAfterWorldId&&(p.worldCompletionCounts[w.unlockAfterWorldId]??0)<1)||p.worldCompletionCounts[input.worldId])throw new ApiError(409,'WORLD_SELECTION_FORBIDDEN');
  }
  const intent={...meta(this.now()),requestHash,type,input,cost,definition:w,fromWorldId:p.worldId,fromWorldRunId:p.worldRunId,fromVillage:p.village,
   configVersions:catalog.versions,configHashes:catalog.hashes,catalogRevision:catalog.revision};
  // Accepted commands retain the exact price/rewards across retries and config updates. No currency mutation yet.
  try{await this.db.commit(player,[{sk:key,value:intent}]);}catch(e){const winner=await this.db.get(player,key);if(!winner)throw e;if(winner.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');return winner;}
  return intent;
 }
 async execute(principal:Principal,type:WorldAction,input:z.infer<typeof worldCommand>|z.infer<typeof upgradeCommand>|z.infer<typeof repairCommand>){
  const player=await this.owner(principal),requestHash=hash({type,...input});
  let receipt=await this.replay(player,input.requestId,requestHash);
  if(receipt)return {...await this.state(principal),result:receipt.result,replayed:true};
  // Completion identity is World-scoped, independent of requestId, runId and future config versions.
  if(type==='complete'){
   const cause=await this.db.get(player,`ECONOMY#CAUSE#world-complete:${input.worldId}`);
   if(cause){const prior=await this.db.get(player,`ECONOMY#OP#${cause.operationId}`);return {...await this.state(principal),result:prior!.result,replayed:true};}
   const p=(await this.players.read(player))!.progress;
   if((p.worldCompletionCounts[input.worldId]??0)>0)return {...await this.state(principal),result:{type,worldId:input.worldId,completionRewards:[],legacyAlreadyCompleted:true},replayed:true};
  }
  const intent=await this.prepare(player,type,input);
  await this.retry(async()=>{
   receipt=await this.replay(player,input.requestId,requestHash);if(receipt)return;
   if(type==='complete'){
    const cause=await this.db.get(player,`ECONOMY#CAUSE#world-complete:${input.worldId}`);
    if(cause){receipt=await this.db.get(player,`ECONOMY#OP#${cause.operationId}`);return;}
   }
   const ctx=await this.context(player),before=ctx.save,p=structuredClone(before.progress),w=structuredClone(before.wallet),now=this.now();
   const current=await this.current(player,p),unlock=await this.unlocks(player,p),def=intent.definition as WorldCatalog['worlds'][number];
   if(p.worldId!==intent.fromWorldId||p.worldRunId!==intent.fromWorldRunId||(intent.fromVillage!==undefined&&p.village!==intent.fromVillage))
    throw new ApiError(409,'WORLD_CHECKPOINT_CHANGED');
   const extras:Write[]=[];
   let result:Item={type,worldId:input.worldId,configVersions:intent.configVersions,configHashes:intent.configHashes};
   if(type==='upgrade'){
    const command=input as z.infer<typeof upgradeCommand>,index=buildingIds.indexOf(command.buildingId);
    this.checkCurrent(p,command.worldId);
    if(currentVillageDamage(p)[command.buildingId])throw new ApiError(409,'BUILDING_DAMAGED');
    if(p.worldRunComplete||p.facilityLevels[index]===5)throw new ApiError(409,'BUILDING_MAX');
    if(p.facilityLevels[index]!==command.expectedLevel)throw new ApiError(409,'STALE_BUILDING_LEVEL');
    if(w.yallaPoint<intent.cost)throw new ApiError(409,'INSUFFICIENT_YALLA_POINT');
    w.yallaPoint-=intent.cost;p.facilityLevels[index]!++;p.constructionStars=String(BigInt(p.constructionStars)+1n);
    result={...result,buildingId:command.buildingId,fromLevel:command.expectedLevel,toLevel:command.expectedLevel+1,cost:intent.cost};
    extras.push({sk:`WORLD#${p.worldId}`,value:{...current.value,...meta(now,(current.stored?.version??0)+1),levels:[...p.facilityLevels]},expectedVersion:current.stored?.version});
   }else if(type==='repair'){
    const command=input as z.infer<typeof repairCommand>;
    const damage=currentVillageDamage(p);
    if(damage[command.buildingId]!==command.attackId)throw new ApiError(409,'BUILDING_DAMAGE_CHANGED');
    const building = def.buildings.find(b => b.id === command.buildingId)!;
    const cost = Math.min(intent.cost, villageRepairCost(p, building));
    if(w.yallaPoint<cost)throw new ApiError(409,'INSUFFICIENT_YALLA_POINT');
    w.yallaPoint-=cost;
    const levelBefore = p.villageDamage?.levelsBefore?.[command.buildingId];
    if (levelBefore !== undefined) {
     const index = buildingIds.indexOf(command.buildingId);
     if (p.facilityLevels[index] !== levelBefore - 1) throw new ApiError(409,'BUILDING_DAMAGE_CHANGED');
     p.facilityLevels[index] = levelBefore;
     delete p.villageDamage!.levelsBefore![command.buildingId];
     extras.push({sk:`WORLD#${p.worldId}`,value:{...current.value,...meta(now,(current.stored?.version??0)+1),
      levels:[...p.facilityLevels]},expectedVersion:current.stored?.version});
    }
    delete damage[command.buildingId];
    if (p.villageDamage?.help) delete p.villageDamage.help[command.buildingId];
    if(!Object.keys(damage).length)delete p.villageDamage;
    result={...result,worldRunId:p.worldRunId,village:p.village,buildingId:command.buildingId,attackId:command.attackId,cost};
   }else if(type==='complete'){
    this.checkCurrent(p,input.worldId);
    this.checkUndamaged(p);
    if(p.facilityLevels.some(l=>l!==5))throw new ApiError(409,'WORLD_NOT_MAX');
    if(p.worldRunComplete||(p.worldCompletionCounts[p.worldId]??0)>0)throw new ApiError(409,'WORLD_ALREADY_COMPLETE');
    for(const reward of def.completionRewards){if(reward.type==='ENERGY')w.energy+=reward.amount!;else if(reward.type==='YALLA_POINT')w.yallaPoint+=reward.amount!;else if(reward.type==='DIAMOND')w.diamond+=reward.amount!;else throw new ApiError(409,'WORLD_REWARD_UNSUPPORTED');}
    if(w.energy>=50)w.energyRechargeAnchor='0';
    p.worldRunComplete=true;p.worldCompletionCounts[p.worldId]=1;
    const unlocked=[...unlock.value.worldIds];if(def.nextWorldId&&!unlocked.includes(def.nextWorldId))unlocked.push(def.nextWorldId);
    if(def.nextWorldId)p.highestUnlockedWorld=Math.max(p.highestUnlockedWorld,worldIds.indexOf(def.nextWorldId));
    result={...result,completionRewards:def.completionRewards,nextWorldId:def.nextWorldId};
    extras.push({sk:`WORLD#${p.worldId}`,value:{...current.value,...meta(now,(current.stored?.version??0)+1),levels:[...p.facilityLevels],status:'COMPLETE',rewardClaimed:true,completionRewards:def.completionRewards,completedAt:now,configVersions:intent.configVersions,configHashes:intent.configHashes},expectedVersion:current.stored?.version},
     {sk:'WORLD#UNLOCKS',value:{...meta(now,(unlock.stored?.version??0)+1),worldIds:unlocked},expectedVersion:unlock.stored?.version});
   }else{
    if(!p.worldRunComplete||!unlock.value.worldIds.includes(input.worldId)||(p.worldCompletionCounts[input.worldId]??0)>0)throw new ApiError(409,'WORLD_SELECTION_FORBIDDEN');
    this.checkUndamaged(p);
    const existing=await this.db.get(player,`WORLD#${input.worldId}`);if(existing?.status==='COMPLETE')throw new ApiError(409,'WORLD_SELECTION_FORBIDDEN');
    p.worldId=input.worldId;p.village=1;p.facilityLevels=[1,1,1,1,1];p.worldRunId=`world:${input.worldId}:${input.requestId}`;p.worldRunComplete=false;
    delete p.villageDamage;
    result={...result,fromWorldId:intent.fromWorldId,toWorldId:p.worldId};
    const [raidConfig, botSettings] = await Promise.all([this.configs.load('raid'), this.botsConfig.load()]);
    const bonus = ctx.bonus ?? newBonusState(now);
    const bots = syncRaidBots(p, raidConfig, botSettings, bonus.raid.bots, Date.parse(now));
    extras.push({sk:'BONUS#STATE',value:{...bonus,...meta(now,(ctx.bonus?.version??0)+1),
      raid:{...bonus.raid,bots}},expectedVersion:ctx.bonus?.version});

    extras.push({sk:`WORLD#${p.worldId}`,value:{...meta(now,(existing?.version??0)+1),worldId:p.worldId,levels:[1,1,1,1,1],status:'ACTIVE',rewardClaimed:false,completionRewards:[]},expectedVersion:existing?.version});
   }
   p.version++;p.updatedAt=now;progressSchema.parse(p);
   w.version++;w.updatedAt=now;walletSchema.parse(w);
   const operationId=`world:${input.requestId}`,causeKey=type==='complete'?`world-complete:${input.worldId}`:`world-${type}:${input.requestId}`;
   receipt={...meta(now),operationId,operationType:`world-${type}`,requestHash,causeKey,configVersion:Object.values(intent.configVersions).join(':'),configVersions:intent.configVersions,configHashes:intent.configHashes,configSnapshot:{definition:def,cost:intent.cost},
    deltas:{energy:w.energy-before.wallet.energy,yallaPoint:w.yallaPoint-before.wallet.yallaPoint,diamond:w.diamond-before.wallet.diamond},balancesBefore:before.wallet,balancesAfter:w,walletVersionAfter:w.version,result,committedAt:now};
   await this.db.commit(player,[this.lock(ctx.session),{sk:'PROGRESS',value:p,expectedVersion:before.progress.version},{sk:'WALLET',value:w,expectedVersion:before.wallet.version},...extras,
    {sk:`ECONOMY#OP#${operationId}`,value:receipt},{sk:`ECONOMY#CAUSE#${causeKey}`,value:{operationId,requestHash}}]);
  });
  return {...await this.state(principal),result:receipt!.result,replayed:false};
 }
}

export function createWorldService(table:string,drops:DropService,configs:ConfigSource){return new WorldService(createDynamoRepository(table),new DynamoDropStore(DynamoDBDocumentClient.from(new DynamoDBClient({})),table),drops,configs);}
