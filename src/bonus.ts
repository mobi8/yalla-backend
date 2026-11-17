import { createHash, randomInt, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ApiError, createDynamoRepository, type PlayerRepository } from './repository.js';
import { DropService, DynamoDropStore, type DropStore, type Write, type Session } from './drop.js';
import { GameConfigs, type ConfigSource, type GameConfig } from './game-config.js';
import { collectionSchema, type Collection } from './drop-economy.js';
import { walletSchema, type Principal, type Save } from './model.js';
export const bonusInput = z.strictObject({ requestId: z.string().uuid() });
export const kindInput = z.strictObject({ kind: z.enum(['Jackpot','Raid']) });
export const raidBeginInput = z.strictObject({ requestId: z.string().uuid(), botId: z.string().min(1).max(160).optional() });
export const attackInput = z.strictObject({ requestId: z.string().uuid(), facilityId: z.number().int().min(0).max(4) });
type Item = Record<string, any>;
export interface BonusStore extends DropStore { list(player: string, prefix: string): Promise<Item[]> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const meta = (now: string, version = 1) => ({ schemaVersion: 1, version, updatedAt: now });
export function jackpotSegment(weights: number[], roll: number) {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10000) throw new Error('Invalid roll');
  let sum = 0; for (let i = 0; i < weights.length; i++) { sum += weights[i]!; if (roll < sum) return i; }
  throw new Error('Invalid probability table');
}
export function mirrorBots(progress: Save['progress'], config: GameConfig<'raid'>, previous: Item[]) {
  return config.data.botTemplates.map((template, i) => {
    const botId = `bot:${encodeURIComponent(progress.worldId)}:v${progress.village}:${template.id}`;
    return previous.find(b => b.botId === botId) ?? { botId, profileTemplateId: template.id,
      worldId: progress.worldId, village: progress.village, facilityLevels: [...config.data.initialFacilityLevels],
      shieldCount: config.data.initialShieldCounts[i], stateVersion: 1 };
  });
}
export class BonusService {
  constructor(private players: PlayerRepository, private db: BonusStore, private drops: DropService,
    private configs: ConfigSource = new GameConfigs(), private clock = Date.now, private roll = () => randomInt(10000)) {}
  private now() { return new Date(this.clock()).toISOString(); }
  private async owner(p: Principal) { const id = await this.players.find(p); if (!id) throw new ApiError(404,'PLAYER_NOT_FOUND'); return id; }
  private async retry<T>(action: () => Promise<T>): Promise<T> {
    for (let i=0;i<5;i++) try { return await action(); } catch(e) {
      if (!(e instanceof Error) || !['TransactionCanceledException','ConditionalCheckFailedException'].includes(e.name)) throw e;
    }
    throw new ApiError(409,'STATE_CHANGED_RETRY_SAME_REQUEST');
  }
  private async state(player: string): Promise<Item> {
    return this.retry(async () => {
      let state = await this.db.get(player,'BONUS#STATE');
      if (!state) {
        state = { ...meta(this.now()), queue: [], run: null, jackpot: null, raid: { bots: [], activities: [], activeRaid: null } };
        await this.db.commit(player,[{ sk:'BONUS#STATE',value:state }]);
      }
      if (state.run || state.queue.length) return state;
      const pending = (await this.db.list(player,'BONUS#')).filter(b => b.status === 'PENDING').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt) || a._key.localeCompare(b._key)).slice(0,20);
      if (!pending.length) return state;
      const next = { ...state, ...meta(this.now(),state.version+1), queue: pending.map(b => ({ kind:b.kind,total:b.total,completed:b.completed,
        totalReward:b.totalReward,roundId:b.roundId,cause:b.cause,announced:b.announced,batchKey:b._key })) };
      await this.db.commit(player,[{sk:'BONUS#STATE',value:next,expectedVersion:state.version},...pending.map(b => {
        const {_key,...value}=b; return {sk:_key,value:{...value,status:'ASSIGNED',...meta(this.now(),b.version+1)},expectedVersion:b.version};
      })]);
      return next;
    });
  }
  private async context(player: string) {
    const save=(await this.players.read(player))!;
    const collection=collectionSchema.parse(await this.db.get(player,'COLLECTION'));
    const active=await this.db.get(player,'SESSION#ACTIVE');
    const session=active ? await this.db.get(player,`SESSION#${active.sessionId}`) as Session | undefined : undefined;
    if (!session) throw new ApiError(409,'DROP_SESSION_REQUIRED');
    if (session.pendingRoundId) throw new ApiError(409,'ROUND_PENDING');
    return {save,collection,session};
  }
  private async write(player:string, old:Item, next:Item, context:Awaited<ReturnType<BonusService['context']>>, extras:Write[]=[]) {
    next.version=old.version+1; next.updatedAt=this.now();
    const s=context.session;
    await this.db.commit(player,[{sk:'BONUS#STATE',value:next,expectedVersion:old.version},
      {sk:`SESSION#${s.sessionId}`,value:{...s,version:s.version+1,updatedAt:this.now()},expectedVersion:s.version},...extras]);
  }
  private async snapshot(principal:Principal) {
    const player=await this.owner(principal);
    for(let i=0;i<5;i++) {
      const state=await this.state(player), drop=await this.drops.active(principal);
      const after=await this.db.get(player,'BONUS#STATE');
      if (state.version!==after?.version) continue;
      const jackpotConfig=state.jackpot && !state.jackpot.acknowledged ? state.jackpot.config : await this.configs.load('jackpot');
      const raidConfig=state.raid.activeRaid?.config ?? await this.configs.load('raid');
      return {...drop,bonus:state,settings:{jackpot:jackpotConfig,raid:raidConfig,
        collection:await this.configs.load('collection'),journey:await this.configs.load('journey')}};
    }
    throw new ApiError(409,'STATE_CHANGED_RETRY_SAME_REQUEST');
  }
  async get(principal:Principal) { return this.snapshot(principal); }
  async ensure(principal:Principal,kind:'Jackpot'|'Raid') {
    const player=await this.owner(principal);
    await this.retry(async()=>{
      const state=await this.state(player);
      if(state.run) { if(state.run.kind!==kind) throw new ApiError(409,'FINISH_OTHER_BONUS'); return; }
      const first=state.queue[0]; if(!first || first.kind!==kind) throw new ApiError(409,'BONUS_ORDER_OR_ENTITLEMENT');
      const ctx=await this.context(player);
      await this.write(player,state,{...state,run:first,queue:state.queue.slice(1)},ctx);
    }); return this.snapshot(principal);
  }
  async announce(principal:Principal,roundId:string) {
    const player=await this.owner(principal);
    await this.retry(async()=>{ const state=await this.state(player), ctx=await this.context(player);
      const mark=(run:Item)=>run?.roundId===roundId?{...run,announced:true}:run;
      await this.write(player,state,{...state,run:mark(state.run),queue:state.queue.map(mark)},ctx);
    }); return this.snapshot(principal);
  }
  async finish(principal:Principal,kind:'Jackpot'|'Raid') {
    const player=await this.owner(principal);
    await this.retry(async()=>{
      const state=await this.state(player); if(!state.run) return;
      const run=state.run;
      if(run.kind!==kind || run.completed!==run.total || state.raid.activeRaid || (state.jackpot && !state.jackpot.acknowledged)) throw new ApiError(409,'BONUS_NOT_COMPLETE');
      const batch=await this.db.get(player,run.batchKey),ctx=await this.context(player);
      await this.write(player,state,{...state,run:null},ctx,[{sk:run.batchKey,value:{...batch,...run,...meta(this.now(),batch!.version+1),status:'DONE'},expectedVersion:batch!.version}]);
    }); return this.snapshot(principal);
  }
  private receipt(id:string,type:string,cause:string,config:GameConfig<any>,ctx:Awaited<ReturnType<BonusService['context']>>,wallet:Save['wallet'],result:Item,requestHash:string):Write[] {
    return [{sk:`ECONOMY#OP#${id}`,value:{...meta(this.now()),operationId:id,operationType:type,causeKey:cause,requestHash,
      configVersion:config.version,configHash:config.contentHash,deltas:{energy:0,diamond:0,yallaPoint:wallet.yallaPoint-ctx.save.wallet.yallaPoint},
      balancesBefore:ctx.save.wallet,balancesAfter:wallet,walletVersionAfter:wallet.version,result,committedAt:this.now()}},
      {sk:`ECONOMY#CAUSE#${cause}`,value:{operationId:id,requestHash}}];
  }
  private needRun(state:Item,kind:string) { if(state.run?.kind!==kind || state.run.completed>=state.run.total) throw new ApiError(409,'NO_BONUS_ENTITLEMENT'); }
  async spin(principal:Principal,input:z.infer<typeof bonusInput>) {
    const player=await this.owner(principal);
    let resultId=input.requestId;
    await this.retry(async()=>{
      const previous=await this.db.get(player,`JACKPOT#${input.requestId}`);
      if(previous) return;
      const state=await this.state(player);
      if(state.jackpot && !state.jackpot.acknowledged) { resultId=state.jackpot.id; return; }
      this.needRun(state,'Jackpot'); const ctx=await this.context(player),config=await this.configs.load('jackpot'),cost=config.data.ticketCost;
      if(ctx.collection.jackpotTickets<cost) throw new ApiError(409,'INSUFFICIENT_JACKPOT_TICKETS');
      const segment=jackpotSegment(config.data.weights,this.roll()), reward=config.data.rewards[segment]!;
      const receipt={id:input.requestId,segment,weight:config.data.weights[segment],goldReward:reward,ticketsBefore:ctx.collection.jackpotTickets,
        goldBefore:ctx.save.wallet.yallaPoint,acknowledged:false,paidToYallaPoint:true,config,batchKey:state.run.batchKey,sequence:state.run.completed+1};
      const wallet=walletSchema.parse({...ctx.save.wallet,yallaPoint:ctx.save.wallet.yallaPoint+reward,...meta(this.now(),ctx.save.wallet.version+1)});
      const collection=collectionSchema.parse({...ctx.collection,jackpotTickets:ctx.collection.jackpotTickets-cost,...meta(this.now(),ctx.collection.version+1)});
      await this.write(player,state,{...state,jackpot:receipt},ctx,[{sk:'WALLET',value:wallet,expectedVersion:ctx.save.wallet.version},
        {sk:'COLLECTION',value:collection,expectedVersion:ctx.collection.version},{sk:`JACKPOT#${input.requestId}`,value:{...receipt,...meta(this.now())}},
        ...this.receipt(`jackpot:${input.requestId}`,'jackpot',`bonus:${receipt.batchKey}:${receipt.sequence}`,config,ctx,wallet,receipt,hash(input))]);
    });
    return {...await this.snapshot(principal),result:await this.db.get(player,`JACKPOT#${resultId}`)};
  }
  async acknowledge(principal:Principal,kind:'Jackpot'|'Raid',id:string) {
    const player=await this.owner(principal),key=kind==='Jackpot'?`JACKPOT#${id}`:`RAID#${id}`;
    await this.retry(async()=>{
      const record=await this.db.get(player,key); if(!record) throw new ApiError(404,'BONUS_RESULT_NOT_FOUND');
      if(record.acknowledged) return;
      const state=await this.state(player); this.needRun(state,kind);
      const reward=kind==='Jackpot'?record.goldReward:record.result?.rewardAmount;
      if(reward===undefined || record.batchKey!==state.run.batchKey || record.sequence!==state.run.completed+1) throw new ApiError(409,'BONUS_RECEIPT_CONFLICT');
      const ctx=await this.context(player),next:Item={...state,run:{...state.run,completed:state.run.completed+1,totalReward:state.run.totalReward+reward}};
      if(kind==='Jackpot') { if(state.jackpot?.id!==id) throw new ApiError(409,'BONUS_RECEIPT_CONFLICT'); next.jackpot={...state.jackpot,acknowledged:true}; }
      else { if(state.raid.activeRaid?.raidId!==id) throw new ApiError(409,'BONUS_RECEIPT_CONFLICT'); next.raid={...state.raid,activeRaid:null}; }
      await this.write(player,state,next,ctx,[{sk:key,value:{...record,acknowledged:true,...meta(this.now(),record.version+1)},expectedVersion:record.version}]);
    }); return this.snapshot(principal);
  }
  async beginRaid(principal:Principal,input:z.infer<typeof raidBeginInput>) {
    const player=await this.owner(principal); let id=input.requestId;
    await this.retry(async()=>{
      const previous=await this.db.get(player,`RAID#${input.requestId}`);
      if(previous) { if(input.botId && previous.operation.botId!==input.botId) throw new ApiError(409,'IDEMPOTENCY_CONFLICT'); return; }
      const state=await this.state(player); this.needRun(state,'Raid');
      if(state.raid.activeRaid) { if(input.botId && state.raid.activeRaid.botId!==input.botId) throw new ApiError(409,'RAID_ACTIVE'); id=state.raid.activeRaid.raidId; return; }
      const ctx=await this.context(player),config=await this.configs.load('raid');
      if(ctx.collection.raidTickets<config.data.ticketCost) throw new ApiError(409,'INSUFFICIENT_RAID_TICKETS');
      const bots=mirrorBots(ctx.save.progress,config,state.raid.bots),bot=input.botId?bots.find(b=>b.botId===input.botId):bots[0];
      if(!bot) throw new ApiError(400,'INVALID_RAID_TARGET');
      const operation={raidId:id,attackerId:player,botId:bot.botId,worldId:bot.worldId,village:bot.village,botStateVersion:bot.stateVersion,
        configurationVersion:config.version,ticketCost:config.data.ticketCost,multiplier:config.data.multiplier,
        eligibleCosts:bot.facilityLevels.map(()=>config.data.eligibleUpgradeCost),config};
      await this.write(player,state,{...state,raid:{...state.raid,bots,activeRaid:operation}},ctx,[{sk:`RAID#${id}`,value:{...meta(this.now()),operation,
        acknowledged:false,status:'READY',batchKey:state.run.batchKey,sequence:state.run.completed+1}}]);
    }); return {...await this.snapshot(principal),result:await this.db.get(player,`RAID#${id}`)};
  }
  async attack(principal:Principal,id:string,input:z.infer<typeof attackInput>) {
    const player=await this.owner(principal);
    await this.retry(async()=>{
      const record=await this.db.get(player,`RAID#${id}`); if(!record) throw new ApiError(404,'RAID_NOT_FOUND');
      if(record.status==='SETTLED') { if(record.result.selectedFacilityId!==input.facilityId) throw new ApiError(409,'RESULT_CONFLICT'); return; }
      if(record.status!=='READY') throw new ApiError(409,'RAID_CANCELLED');
      const state=await this.state(player);this.needRun(state,'Raid');
      if(state.raid.activeRaid?.raidId!==id) throw new ApiError(409,'RAID_NOT_ACTIVE');
      const ctx=await this.context(player),op=record.operation, config=op.config as GameConfig<'raid'>;
      if(op.worldId!==ctx.save.progress.worldId || op.village!==ctx.save.progress.village) throw new ApiError(409,'PROGRESS_CHANGED');
      if(ctx.collection.raidTickets<op.ticketCost) throw new ApiError(409,'INSUFFICIENT_RAID_TICKETS');
      const bot=state.raid.bots.find((b:Item)=>b.botId===op.botId);
      if(!bot || bot.stateVersion!==op.botStateVersion) throw new ApiError(409,'BOT_STATE_CHANGED');
      const blocked=bot.shieldCount>0,reward=blocked?0:op.eligibleCosts[input.facilityId]*op.multiplier;
      const result={raidId:id,attackerId:player,defenderId:bot.botId,attackerEntityType:'LocalPlayer',defenderEntityType:'SystemBot',
        selectedFacilityId:input.facilityId,worldId:op.worldId,village:op.village,result:blocked?'BlockedByShield':'Success',rewardAmount:reward,
        shieldConsumed:blocked,timestamp:this.now()};
      const wallet=walletSchema.parse({...ctx.save.wallet,yallaPoint:ctx.save.wallet.yallaPoint+reward,...meta(this.now(),ctx.save.wallet.version+1)});
      const collection=collectionSchema.parse({...ctx.collection,raidTickets:ctx.collection.raidTickets-op.ticketCost,...meta(this.now(),ctx.collection.version+1)});
      const raid={...state.raid,bots:state.raid.bots.map((b:Item)=>b.botId===bot.botId?{...b,shieldCount:b.shieldCount-(blocked?1:0),stateVersion:b.stateVersion+1}:b),
        activities:[...state.raid.activities,result].slice(-40)};
      await this.write(player,state,{...state,raid},ctx,[{sk:'WALLET',value:wallet,expectedVersion:ctx.save.wallet.version},
        {sk:'COLLECTION',value:collection,expectedVersion:ctx.collection.version},
        {sk:`RAID#${id}`,value:{...record,...meta(this.now(),record.version+1),status:'SETTLED',result},expectedVersion:record.version},
        ...this.receipt(`raid:${id}`,'raid',`bonus:${record.batchKey}:${record.sequence}`,config,ctx,wallet,result,hash({id,facilityId:input.facilityId}))]);
    }); return {...await this.snapshot(principal),result:await this.db.get(player,`RAID#${id}`)};
  }
  async cancelRaid(principal:Principal,id:string) {
    const player=await this.owner(principal);
    await this.retry(async()=>{const record=await this.db.get(player,`RAID#${id}`);if(!record)throw new ApiError(404,'RAID_NOT_FOUND');
      if(record.status==='CANCELLED')return;if(record.status!=='READY')throw new ApiError(409,'RAID_ALREADY_SETTLED');
      const state=await this.state(player),ctx=await this.context(player);
      if(state.raid.activeRaid?.raidId!==id)throw new ApiError(409,'RAID_NOT_ACTIVE');
      await this.write(player,state,{...state,raid:{...state.raid,activeRaid:null}},ctx,[{sk:`RAID#${id}`,value:{...record,...meta(this.now(),record.version+1),status:'CANCELLED'},expectedVersion:record.version}]);
    });return this.snapshot(principal);
  }
}
export function createBonusService(table:string,drops:DropService,configs:ConfigSource) {
  const client=DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return new BonusService(createDynamoRepository(table),new DynamoDropStore(client,table),drops,configs);
}
