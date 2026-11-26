import { ACTIVITY_KEY, INACTIVE_AFTER_MS, OFFLINE_AFTER_MS } from './player-activity.js';
import { loadPlayerWalletRaidPolicy } from './player-wallet-raid.js';
import { startWalletRaid, walletRaidDebit, WALLET_RAID_PREFIX } from './incoming-wallet-raid.js';
import { newBonusState, syncRaidBots } from './raid-bots.js';
export { mirrorBots } from './raid-bots.js';
import { regenBot } from './balance.js';
import { BotsConfigs, type BotsSource } from './bots-config.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ApiError, decodeProgress, decodeWallet, playerKey, playerNumberOptions, createDynamoRepository, type PlayerRepository } from './repository.js';
import { DropService, DynamoDropStore, type DropStore, type Write, type Session } from './drop.js';
import { GameConfigs, type ConfigSource, type GameConfig } from './game-config.js';
import { collectionSchema, newCollection, type Collection } from './drop-economy.js';
import { buildingIds, loadWorldCatalog } from './world-config.js';
import { currentVillageDamage, walletSchema, type Principal, type Save } from './model.js';
export const bonusInput = z.strictObject({ requestId: z.string().uuid() });
export const kindInput = z.strictObject({ kind: z.enum(['Jackpot','Raid']) });
export const raidBeginInput = z.strictObject({ requestId: z.string().uuid(), botId: z.string().min(1).max(160).optional(),
  targetPlayerId: z.uuid().optional(), replaceRaidId: z.uuid().optional(),
}).refine(value => !value.botId || !value.targetPlayerId);
export const attackInput = z.strictObject({ requestId: z.string().uuid(), facilityId: z.number().int().min(0).max(4) });
export const pickInput = bonusInput.extend({ bagId: z.number().int().min(0).max(11) });
export const costumePurchaseInput = bonusInput.extend({
  itemId: z.string().regex(/^[a-z0-9_-]{1,100}$/),
  expectedPrice: z.number().int().positive().max(2147483647).optional(),
});
const costumeSlotPrefixes={HEAD:'camel_hat_',GLASS:'camel_glasses_',NECK:'camel_neck_',BODY:'camel_back_',FEET:'camel_shoes_',TAIL:'camel_tail_'} as const;
export const costumeEquipInput=bonusInput.extend({
  slot:z.enum(['HEAD','GLASS','NECK','BODY','FEET','TAIL']),
  itemId:costumePurchaseInput.shape.itemId.nullable(),
});
type Item = Record<string, any>;
type BagPick = {requestId: string; bagId: number; outcome: 'GOLD'|'MISS'; gold: number};
export interface BonusStore extends DropStore { list(player: string, prefix: string, newestLimit?: number): Promise<Item[]> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ATTACK_COOLDOWN_MS = 60 * 60_000;
const meta = (now: string, version = 1) => ({ schemaVersion: 1, version, updatedAt: now });
function publicRaidReceipt(record: Item|undefined) {
  if (!record) return undefined;
  const {bagGold, ...visible}=record;
  return visible;
}
export function jackpotSegment(weights: number[], roll: number) {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 10000) throw new Error('Invalid roll');
  let sum = 0; for (let i = 0; i < weights.length; i++) { sum += weights[i]!; if (roll < sum) return i; }
  throw new Error('Invalid probability table');
}
export class BonusService {
  constructor(private players: PlayerRepository, private db: BonusStore, private drops: DropService,
    private configs: ConfigSource = new GameConfigs(), private clock = Date.now, private roll = () => randomInt(10000), private botsConfig: BotsSource = new BotsConfigs(), private walletRaid = loadPlayerWalletRaidPolicy()) {}
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
        state = newBonusState(this.now());
        await this.db.commit(player,[{ sk:'BONUS#STATE',value:state }]);
      }
      if (state.run || state.queue.length) return state;
      const pending = (await this.db.list(player,'BONUS#')).filter(b => b.status === 'PENDING').sort((a,b) => a.updatedAt.localeCompare(b.updatedAt) || a._key.localeCompare(b._key)).slice(0,20);
      if (!pending.length) return state;
      const next = { ...state, ...meta(this.now(),state.version+1), queue: pending.map(b => ({ kind:b.kind,total:b.total,completed:b.completed,
        totalReward:b.totalReward,roundId:b.roundId,cause:b.cause,announced:b.announced,batchKey:b._key,
        ...(b.eventTypes ? {eventTypes:b.eventTypes} : {}) })) };
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
      const [currentRaidConfig, botSettings] = await Promise.all([this.configs.load('raid'), this.botsConfig.load()]);
      const bots = syncRaidBots(drop.save.progress, currentRaidConfig, botSettings, state.raid.bots, this.clock());
      if (bots.some((bot, index) => bot !== state.raid.bots[index])) {
        try { await this.db.commit(player,[{sk:'BONUS#STATE',value:{...state,raid:{...state.raid,bots},...meta(this.now(),state.version+1)},expectedVersion:state.version}]); }
        catch(e) { if (e instanceof Error && ['TransactionCanceledException','ConditionalCheckFailedException'].includes(e.name)) continue; throw e; }
        continue;
      }
      const active=state.raid.activeRaid;
      const [bagRaid, costume]=await Promise.all([
        active?.eventType==='RAID' ? this.db.get(player,`RAID#${active.raidId}`) : undefined,
        this.db.get(player,'COSTUME'),
      ]);
      const after=await this.db.get(player,'BONUS#STATE');
      if (state.version!==after?.version) continue;
      const jackpotConfig=state.jackpot && !state.jackpot.acknowledged ? state.jackpot.config : await this.configs.load('jackpot');
      const raidConfig=state.raid.activeRaid?.config ?? currentRaidConfig;
      const visibleBots=state.raid.bots.filter((b:Item)=>(b.worldId===drop.save.progress.worldId && b.village===drop.save.progress.village && botSettings.bots.some(t=>t.id===b.profileTemplateId && t.defenseEnabled)) || b.botId===state.raid.activeRaid?.botId);
      const visibleState:Item={...state,raid:{...state.raid,bots:visibleBots}};
      const incomingRaid=(await this.db.list(player,'INCOMING#RECEIPT#',40)).sort((a,b)=>b._key.localeCompare(a._key)).slice(0,40).map(({_key,...record})=>record);
      const walletRaid = botSettings.offlinePolicy ? await this.db.list(player, WALLET_RAID_PREFIX, 40) : [];
      const incomingActivity = [
        ...incomingRaid.filter(event => typeof event.eventId === 'string'),
        ...walletRaid.map(({eventId,eventType,actorType,actorId,targetType,targetId,targetPlayerId,
          occurredAt,result,outcome,stolenYP,shieldConsumed}) => ({eventId,eventType,actorType,actorId,
          targetType,targetId,targetPlayerId,occurredAt,result,outcome,stolenYP,shieldConsumed})),
      ].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt) || b.eventId.localeCompare(a.eventId)).slice(0,40);
      const latestCollection=await this.db.get(player,'COLLECTION');
      if (drop.collection?.version !== latestCollection?.version) continue;
      if (walletRaid.length && (await this.db.get(player,'WALLET'))?.version !== drop.save.wallet.version) continue;
      return {...drop,bonus:visibleState,incomingRaid,incomingActivity,bagRaid:publicRaidReceipt(bagRaid)??null,
        costume:{ownedIds:costume?.ownedIds??[],equipped:costume?.equipped??{},prices:currentRaidConfig.data.costumePrices??{}},settings:{jackpot:jackpotConfig,raid:raidConfig,
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
      configVersion:config.version,configHash:config.contentHash,deltas:{energy:0,diamond:0,yallaPoint:wallet.yallaPoint-ctx.save.wallet.yallaPoint,
        costumePoint:(wallet.costumePoint??0)-(ctx.save.wallet.costumePoint??0)},
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
        ...await this.drops.bingoRecord(player,this.now(),[{type:'Jackpot'}]),
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
  private revengeKey(other: string, eventType: 'ATTACK' | 'RAID') {
    return `${eventType === 'RAID' ? 'RAID_REVENGE' : 'REVENGE'}#${other}`;
  }

  async revengeTargets(principal: Principal, eventType: 'ATTACK' | 'RAID' = 'ATTACK') {
    const player = await this.owner(principal);
    const prefix = this.revengeKey('', eventType);
    const rows = await this.db.list(player, prefix);
    const entries = await Promise.all(rows.sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) || a._key.localeCompare(b._key)).map(async row => {
      const playerId = row._key.slice(prefix.length);
      const profile = await this.db.get(playerId, 'PROFILE');
      return profile && { playerId, nickname: profile.nickname, avatarId: profile.avatarId };
    }));
    const targets = entries.filter(entry => entry != null);
    return { entries: eventType === 'ATTACK' ? await this.withAttackAvailability(principal, targets) : targets };
  }

  private attackableFacilities(progress: Save['progress'], shields: number) {
    const damage = currentVillageDamage(progress);
    return progress.facilityLevels.map((level, index) => shields > 0 ||
      (!progress.worldRunComplete && level > 1 && !damage[buildingIds[index]!]));
  }

  private attackCooldownKey(target: string) { return `ATTACK_TARGET#${target}`; }

  private attackCooldownUntil(cooldown: Item | undefined) {
    const until = Date.parse(cooldown?.updatedAt ?? '') + ATTACK_COOLDOWN_MS;
    return until > this.clock() ? new Date(until).toISOString() : null;
  }

  async withAttackAvailability<T extends {playerId?: string}>(principal: Principal, entries: T[]) {
    const player = await this.owner(principal);
    return Promise.all(entries.map(async entry => {
      if (!entry.playerId) return entry;
      const target = entry.playerId;
      const [progress, collection, cooldown] = await Promise.all([
        this.db.get(target, 'PROGRESS'),
        this.db.get(target, 'COLLECTION'),
        this.db.get(player, this.attackCooldownKey(target)),
      ]);
      const availableAt = this.attackCooldownUntil(cooldown);
      const reason = !progress ? 'UNAVAILABLE'
        : availableAt ? 'COOLDOWN'
        : this.attackableFacilities(decodeProgress(progress), collection?.shieldCount ?? 0).some(Boolean)
          ? null : 'NO_ATTACKABLE_BUILDINGS';
      return {...entry, attackAvailability:{reason, availableAt, available: reason === null}};
    }));
  }

  private async playerTarget(player: string, target: string, kind: 'ATTACK' | 'RAID') {
    if (player === target) throw new ApiError(400, 'INVALID_RAID_TARGET');
    const pair = `FRIENDS#PAIR#${[player, target].sort().join('#')}`;
    const [revenge, relationship, profile, storedProgress, collection] = await Promise.all([
      this.db.get(player, this.revengeKey(target, kind)), this.db.get(pair, 'STATE', true),
      this.db.get(target, 'PROFILE'), this.db.get(target, 'PROGRESS'), this.db.get(target, 'COLLECTION'),
    ]);
    if (!revenge && (relationship?.state !== 'ACCEPTED' || typeof relationship.revision !== 'string'))
      throw new ApiError(403, 'RAID_TARGET_NOT_ALLOWED');
    if (!profile || !storedProgress) throw new ApiError(404, 'RAID_TARGET_NOT_FOUND');
    const progress = decodeProgress(storedProgress);
    return { revenge, relationship, pair, profile, progress,
      collection: collection ? collectionSchema.parse(collection) : newCollection(this.now()),
      collectionVersion: collection?.version as number | undefined };
  }

  private async eligibleWalletTarget(target: string) {
    const cooldownKey = 'PLAYER_RAID#COOLDOWN';
    const [row, activity, cooldown, settings] = await Promise.all([
      this.db.get(target,'WALLET'), this.db.get(target,ACTIVITY_KEY),
      this.db.get(target,cooldownKey), this.botsConfig.load(),
    ]);
    const now = this.clock();
    const lastActiveAt = activity?.lastActiveAt;
    const age = now - (typeof lastActiveAt === 'string' ? Date.parse(lastActiveAt) : NaN);
    const policy = settings.offlinePolicy;
    const offlineMin = policy ? policy.offlineMinMinutes * 60_000 : OFFLINE_AFTER_MS;
    const offlineMax = policy ? policy.offlineMaxHours * 3600_000 : INACTIVE_AFTER_MS;
    if (!(age >= offlineMin && age <= offlineMax)) throw new ApiError(409, 'RAID_TARGET_ONLINE_OR_INACTIVE');
    if (cooldown && now - Date.parse(cooldown.updatedAt) < this.walletRaid.cooldownMs)
      throw new ApiError(409, 'RAID_TARGET_COOLDOWN');
    const wallet = row && decodeWallet(row);
    if (!wallet || wallet.yallaPoint < this.walletRaid.minimumTargetYP)
      throw new ApiError(409, 'RAID_TARGET_BALANCE_TOO_LOW');
    return { wallet, lastActiveAt: lastActiveAt as string, cooldown, cooldownKey };
  }

  private raidAccess(target: string, kind: 'ATTACK' | 'RAID',
    access: Awaited<ReturnType<BonusService['playerTarget']>>): Write {
    return access.revenge
      ? {sk:this.revengeKey(target,kind),value:{},delete:true,expectedVersion:access.revenge.version}
      : {sk:'STATE',value:{},check:{key:{PK:access.pair,SK:'STATE'},field:'revision',value:access.relationship!.revision}};
  }

  async beginRaid(principal:Principal,input:z.infer<typeof raidBeginInput>) {
    const player=await this.owner(principal); let id=input.requestId;
    await this.retry(async()=>{
      const previous=await this.db.get(player,`RAID#${input.requestId}`);
      if(previous) { if((input.botId && previous.operation.botId!==input.botId) || previous.operation.playerTarget?.playerId!==input.targetPlayerId || previous.replacedRaidId!==input.replaceRaidId) throw new ApiError(409,'IDEMPOTENCY_CONFLICT'); return; }
      const state=await this.state(player); this.needRun(state,'Raid');
      const active = state.raid.activeRaid;
      // Recover legacy ATTACKs that were saved before empty targets were rejected.
      const recoverEmptyTarget = !input.replaceRaidId && !input.targetPlayerId && !input.botId &&
        active?.eventType === 'ATTACK' && active.playerTarget &&
        Array.isArray(active.eligibleCosts) && active.eligibleCosts.length === buildingIds.length &&
        active.eligibleCosts.every((cost: unknown) => cost === null);
      const replacementId = input.replaceRaidId ?? (recoverEmptyTarget ? active.raidId : undefined);
      let replaced: Item | undefined;
      if (replacementId) {
        if (active?.raidId !== replacementId) throw new ApiError(409, 'RAID_NOT_ACTIVE');
        replaced = await this.db.get(player, `RAID#${replacementId}`);
        if (replaced?.status !== 'READY' || replaced.picks?.length) {
          if (recoverEmptyTarget) { id = active.raidId; return; }
          throw new ApiError(409, 'RAID_ALREADY_STARTED');
        }
      }
      if(active && !replaced) { if(input.targetPlayerId || (input.botId && active.botId!==input.botId)) throw new ApiError(409,'RAID_ACTIVE'); id=active.raidId; return; }
      const ctx=await this.context(player),config=await this.configs.load('raid'), botSettings=await this.botsConfig.load();
      if(ctx.collection.raidTickets<config.data.ticketCost) throw new ApiError(409,'INSUFFICIENT_RAID_TICKETS');
      const now=this.clock();
      const eventType=state.run.eventTypes?.[state.run.completed] ?? 'ATTACK';
      const target = input.targetPlayerId && await this.playerTarget(player, input.targetPlayerId, eventType);
      const walletTarget = input.targetPlayerId && eventType === 'RAID' && await this.eligibleWalletTarget(input.targetPlayerId);
      const bots=syncRaidBots(ctx.save.progress,config,botSettings,state.raid.bots,now);
      const eligible=bots.filter(b=>b.worldId===ctx.save.progress.worldId && b.village===ctx.save.progress.village &&
        botSettings.bots.some(t=>t.id===b.profileTemplateId && t.defenseEnabled));
      const bot=input.botId?eligible.find(b=>b.botId===input.botId):eligible[0];
      if(!target && !bot) throw new ApiError(400,'INVALID_RAID_TARGET');
      const opponent = target ? {
        botId: input.targetPlayerId!, worldId: target.progress.worldId, village: target.progress.village,
        stateVersion: target.progress.version, facilityLevels: target.progress.facilityLevels,
      } : bot!;
      if (target && eventType === 'ATTACK' &&
          this.attackCooldownUntil(await this.db.get(player, this.attackCooldownKey(input.targetPlayerId!))))
        throw new ApiError(409, 'ATTACK_TARGET_COOLDOWN');
      const attackable = target && this.attackableFacilities(target.progress, target.collection.shieldCount);
      const costs: (number | null)[] = opponent.facilityLevels.map((_level: number, index: number) =>
        !attackable || attackable[index] ? config.data.eligibleUpgradeCost : null);
      if (target && eventType === 'ATTACK' && costs.every(cost => cost === null))
        throw new ApiError(409, 'ATTACK_TARGET_NO_ELIGIBLE_BUILDINGS');
      const playerTarget = target ? {
        playerId: input.targetPlayerId!, nickname: target.profile.nickname, avatarId: target.profile.avatarId,
        worldRunId: target.progress.worldRunId, facilityLevels: target.progress.facilityLevels,
        shieldCount: target.collection.shieldCount,
      } : undefined;
      const bags=eventType==='RAID'?config.data.bags:undefined;
      if(eventType==='RAID' && !bags)throw new ApiError(503,'RAID_BAGS_NOT_CONFIGURED');
      const operation={raidId:id,eventType,attackerId:player,botId:opponent.botId,worldId:opponent.worldId,village:opponent.village,botStateVersion:opponent.stateVersion,
        configurationVersion:config.version,ticketCost:config.data.ticketCost,multiplier:config.data.multiplier,
        eligibleCosts:costs,config,
        ...(playerTarget ? {playerTarget} : {}),
        ...(walletTarget ? {bagCount:5,pickLimit:3} : bags ? {bagCount:bags.count,pickLimit:bags.picks} : {})};
      const bagGold=walletTarget ? startWalletRaid(walletTarget.wallet.yallaPoint,this.walletRaid.bagWeightsBps).bags : bags && Array.from({length:bags.count},(_,i)=>i<bags.winners?randomInt(bags.minGold,bags.maxGold+1):0);
      if(bagGold && !walletTarget)for(let i=bagGold.length-1;i>0;i--){
        const j=randomInt(i+1);
        [bagGold[i],bagGold[j]]=[bagGold[j]!,bagGold[i]!];
      }
      await this.write(player,state,{...state,raid:{...state.raid,bots,activeRaid:operation}},ctx,[{sk:`RAID#${id}`,value:{...meta(this.now()),operation,
        ...(bagGold?{bagGold,picks:[]}:{}),
        ...(input.replaceRaidId ? {replacedRaidId:input.replaceRaidId} : {}),
        acknowledged:false,status:'READY',batchKey:state.run.batchKey,sequence:state.run.completed+1}},
        ...(replaced ? [{sk:`RAID#${replacementId}`, value:{...replaced,status:'CANCELLED',
          ...meta(this.now(),replaced.version+1)},expectedVersion:replaced.version}] : [])]);
    }); return {...await this.snapshot(principal),result:publicRaidReceipt(await this.db.get(player,`RAID#${id}`))};
  }
  async attack(principal:Principal,id:string,input:z.infer<typeof attackInput>) {
    const player=await this.owner(principal);
    await this.retry(async()=>{
      const record=await this.db.get(player,`RAID#${id}`); if(!record) throw new ApiError(404,'RAID_NOT_FOUND');
      if((record.operation.eventType ?? 'ATTACK') !== 'ATTACK') throw new ApiError(409,'BONUS_EVENT_TYPE_MISMATCH');
      if(record.status==='SETTLED') { if(record.result.selectedFacilityId!==input.facilityId) throw new ApiError(409,'RESULT_CONFLICT'); return; }
      if(record.status!=='READY') throw new ApiError(409,'RAID_CANCELLED');
      const state=await this.state(player);this.needRun(state,'Raid');
      if(state.raid.activeRaid?.raidId!==id) throw new ApiError(409,'RAID_NOT_ACTIVE');
      const ctx=await this.context(player),op=record.operation, config=op.config as GameConfig<'raid'>;
      if (op.playerTarget) {
        await this.attackPlayer(player, id, input.facilityId, record, state, ctx);
        return;
      }
      if(op.worldId!==ctx.save.progress.worldId || op.village!==ctx.save.progress.village) throw new ApiError(409,'PROGRESS_CHANGED');
      if(ctx.collection.raidTickets<op.ticketCost) throw new ApiError(409,'INSUFFICIENT_RAID_TICKETS');
      const storedBot=state.raid.bots.find((b:Item)=>b.botId===op.botId);
      const bot=storedBot && regenBot(storedBot as {shieldCount:number; shieldRegenAt?:string | null},this.clock(),(await this.botsConfig.load()).shield.regenHours) as Item;
      if(!bot || bot.stateVersion!==op.botStateVersion) throw new ApiError(409,'BOT_STATE_CHANGED');
      const blocked=bot.shieldCount>0;
      let reward=op.eligibleCosts[input.facilityId]*op.multiplier;
      if(blocked) {
        const catalog=await loadWorldCatalog(this.configs);
        const world=catalog.worlds.find(entry=>entry.id===op.worldId);
        const building=world?.buildings.find(entry=>entry.id===buildingIds[input.facilityId]);
        // MAX uses the final upgrade price, just as the local ATTACK price lookup does.
        const level=Math.min(bot.facilityLevels[input.facilityId],4);
        const price=building?.levels[level-1]?.upgradeCost;
        if(price==null) throw new ApiError(503,'ATTACK_BUILDING_PRICE_UNAVAILABLE');
        reward=Math.floor(price/10);
      }
      const result={raidId:id,attackerId:player,defenderId:bot.botId,attackerEntityType:'LocalPlayer',defenderEntityType:'SystemBot',
        selectedFacilityId:input.facilityId,worldId:op.worldId,village:op.village,result:blocked?'BlockedByShield':'Success',rewardAmount:reward,
        outcome:blocked?'BLOCKED':'HIT',shieldConsumed:blocked,...(blocked?{blockedRewardEligible:true}:{}),timestamp:this.now()};
      const wallet=walletSchema.parse({...ctx.save.wallet,yallaPoint:ctx.save.wallet.yallaPoint+reward,...meta(this.now(),ctx.save.wallet.version+1)});
      const collection=collectionSchema.parse({...ctx.collection,raidTickets:ctx.collection.raidTickets-op.ticketCost,...meta(this.now(),ctx.collection.version+1)});
      const raid={...state.raid,bots:state.raid.bots.map((b:Item)=>b.botId===bot.botId?{...bot,shieldCount:bot.shieldCount-(blocked?1:0),shieldRegenAt:blocked && bot.shieldCount>=3 ? this.now() : bot.shieldRegenAt,stateVersion:bot.stateVersion+1}:b),
        activities:[...state.raid.activities,result].slice(-40)};
      await this.write(player,state,{...state,raid},ctx,[{sk:'WALLET',value:wallet,expectedVersion:ctx.save.wallet.version},
        {sk:'COLLECTION',value:collection,expectedVersion:ctx.collection.version},
        {sk:`RAID#${id}`,value:{...record,...meta(this.now(),record.version+1),status:'SETTLED',result},expectedVersion:record.version},
        ...await this.drops.bingoRecord(player,this.now(),[{type:'Attack'}]),
        ...this.receipt(`raid:${id}`,'raid',`bonus:${record.batchKey}:${record.sequence}`,config,ctx,wallet,result,hash({id,facilityId:input.facilityId}))]);
    }); return {...await this.snapshot(principal),result:await this.db.get(player,`RAID#${id}`)};
  }
  private async attackPlayer(player: string, id: string, facility: number, record: Item, state: Item,
    ctx: Awaited<ReturnType<BonusService['context']>>) {
    const op = record.operation;
    const defender = String(op.playerTarget.playerId);
    if (ctx.collection.raidTickets < op.ticketCost) throw new ApiError(409, 'INSUFFICIENT_RAID_TICKETS');
    const cooldownKey = this.attackCooldownKey(defender);
    const [target, cooldown] = await Promise.all([
      this.playerTarget(player, defender, 'ATTACK'), this.db.get(player, cooldownKey),
    ]);
    if (this.attackCooldownUntil(cooldown)) throw new ApiError(409, 'ATTACK_TARGET_COOLDOWN');
    const { progress, collection } = target;
    if (progress.worldId !== op.worldId || progress.village !== op.village ||
        progress.worldRunId !== op.playerTarget.worldRunId)
      throw new ApiError(409, 'RAID_TARGET_VILLAGE_CHANGED');
    const blocked = collection.shieldCount > 0;
    const buildingId = buildingIds[facility]!;
    const levelBefore = progress.facilityLevels[facility]!;
    const damage = currentVillageDamage(progress);
    if (op.eligibleCosts[facility] == null || (!blocked && (progress.worldRunComplete || levelBefore <= 1 || damage[buildingId])))
      throw new ApiError(409, 'RAID_TARGET_FACILITY_UNAVAILABLE');

    const now = this.now();
    const attackId = BigInt(`0x${id.replaceAll('-', '')}`).toString();
    const levelAfter = levelBefore - Number(!blocked);
    let reward = op.eligibleCosts[facility] * op.multiplier;
    if (blocked) {
      const catalog = await loadWorldCatalog(this.configs);
      const building = catalog.worlds.find(world => world.id === progress.worldId)?.buildings[facility];
      const price = building?.levels[Math.min(levelBefore, 4) - 1]?.upgradeCost;
      if (price == null) throw new ApiError(503, 'ATTACK_BUILDING_PRICE_UNAVAILABLE');
      reward = Math.floor(price / 10);
    }
    const result = {
      raidId:id, attackerId:player, defenderId:defender, attackerEntityType:'LocalPlayer', defenderEntityType:'RemotePlayer',
      selectedFacilityId:facility, worldId:op.worldId, village:op.village, result:blocked?'BlockedByShield':'Success',
      rewardAmount:reward, outcome:blocked?'BLOCKED':'HIT', shieldConsumed:blocked, timestamp:now,
      defenderShieldCount:collection.shieldCount - Number(blocked),
      ...(blocked ? {blockedRewardEligible:true} : {buildingId, levelBefore, levelAfter}),
    };
    const incoming = await this.db.get(defender, this.revengeKey(player,'ATTACK'));
    const defenderWrites: Write[] = [
      { owner:defender, sk:'COLLECTION', value:{...collection,shieldCount:collection.shieldCount-Number(blocked),
        ...meta(now,(target.collectionVersion ?? 0)+1)}, expectedVersion:target.collectionVersion },
      { owner:defender, sk:`INCOMING#PLAYER_ATTACK#${id}`, value:{...meta(now),attackId,actorId:player,
        actorType:'PLAYER',targetPlayerId:defender,eventType:'ATTACK',occurredAt:now,worldId:progress.worldId,
        timestamp:now, result:result.result,outcome:result.outcome,shieldConsumed:blocked,
        ...(blocked ? {} : {buildingId,levelBefore,levelAfter})} },
      { owner:defender, sk:this.revengeKey(player,'ATTACK'), value:{...meta(now,(incoming?.version ?? 0)+1),
        occurredAt:now}, expectedVersion:incoming?.version },
    ];
    if (blocked) {
      defenderWrites.push({sk:'PROGRESS',value:{},check:{key:playerKey(defender,'PROGRESS'),field:'version',value:progress.version}});
    } else {
      const levels = [...progress.facilityLevels];
      levels[facility] = levelAfter;
      const prior = Object.keys(damage).length ? progress.villageDamage : undefined;
      defenderWrites.push({owner:defender,sk:'PROGRESS',expectedVersion:progress.version,value:{
        ...progress,...meta(now,progress.version+1),facilityLevels:levels,
        villageDamage:{...prior,worldRunId:progress.worldRunId,village:progress.village,
          buildings:{...damage,[buildingId]:attackId},levelsBefore:{...prior?.levelsBefore,[buildingId]:levelBefore}},
      }});
      const sk = `WORLD#${progress.worldId}`;
      const world = await this.db.get(defender,sk);
      if (world?.status === 'COMPLETE') throw new ApiError(409, 'RAID_TARGET_VILLAGE_CHANGED');
      if (world) defenderWrites.push({owner:defender,sk,expectedVersion:world.version,
        value:{...world,...meta(now,world.version+1),levels}});
    }
    const access = this.raidAccess(defender,'ATTACK',target);
    const wallet=walletSchema.parse({...ctx.save.wallet,yallaPoint:ctx.save.wallet.yallaPoint+reward,
      ...meta(now,ctx.save.wallet.version+1)});
    const attackerCollection=collectionSchema.parse({...ctx.collection,raidTickets:ctx.collection.raidTickets-op.ticketCost,
      ...meta(now,ctx.collection.version+1)});
    const raid={...state.raid,activities:[...state.raid.activities,result].slice(-40)};
    await this.write(player,state,{...state,raid},ctx,[
      {sk:'WALLET',value:wallet,expectedVersion:ctx.save.wallet.version},
      {sk:'COLLECTION',value:attackerCollection,expectedVersion:ctx.collection.version},
      {sk:`RAID#${id}`,value:{...record,...meta(now,record.version+1),status:'SETTLED',result},expectedVersion:record.version},
      {sk:cooldownKey,value:meta(now,(cooldown?.version ?? 0)+1),expectedVersion:cooldown?.version},
      access,...defenderWrites,
      ...await this.drops.bingoRecord(player,now,[{type:'Attack'}]),
      ...this.receipt(`raid:${id}`,'raid',`bonus:${record.batchKey}:${record.sequence}`,op.config,ctx,wallet,result,hash({id,facilityId:facility})),
    ]);
  }

  async cancelRaid(principal:Principal,id:string) {
    const player=await this.owner(principal);
    await this.retry(async()=>{const record=await this.db.get(player,`RAID#${id}`);if(!record)throw new ApiError(404,'RAID_NOT_FOUND');
      if(record.status==='CANCELLED')return;if(record.status!=='READY')throw new ApiError(409,'RAID_ALREADY_SETTLED');
      if(record.picks?.length)throw new ApiError(409,'RAID_ALREADY_STARTED');
      const state=await this.state(player),ctx=await this.context(player);
      if(state.raid.activeRaid?.raidId!==id)throw new ApiError(409,'RAID_NOT_ACTIVE');
      await this.write(player,state,{...state,raid:{...state.raid,activeRaid:null}},ctx,[{sk:`RAID#${id}`,value:{...record,...meta(this.now(),record.version+1),status:'CANCELLED'},expectedVersion:record.version}]);
    });return this.snapshot(principal);
  }
  private async settleWalletRaid(player: string, target: string, id: string, selected: number, now: string) {
    const writes: Write[] = [];
    let access, eligible;
    try {
      access = await this.playerTarget(player,target,'RAID');
      eligible = await this.eligibleWalletTarget(target);
    } catch (error) {
      if (error instanceof ApiError && ['RAID_TARGET_NOT_ALLOWED','RAID_TARGET_NOT_FOUND',
        'RAID_TARGET_ONLINE_OR_INACTIVE','RAID_TARGET_COOLDOWN','RAID_TARGET_BALANCE_TOO_LOW'].includes(error.code))
        return {rewardAmount:0,writes,unavailable:true};
      throw error;
    }
    const {wallet, lastActiveAt, cooldown, cooldownKey} = eligible;
    const rewardAmount = walletRaidDebit(selected,wallet.yallaPoint,this.walletRaid.protectedBalanceBps);
    if (!rewardAmount) return {rewardAmount,writes,unavailable:false};
    const revengeKey=this.revengeKey(player,'RAID');
    const revenge = await this.db.get(target,revengeKey);
    writes.push(
      {owner:target,sk:'WALLET',expectedVersion:wallet.version,value:{...wallet,...meta(now,wallet.version+1),
        yallaPoint:wallet.yallaPoint-rewardAmount}},
      {owner:target,sk:cooldownKey,expectedVersion:cooldown?.version,value:meta(now,(cooldown?.version ?? 0)+1)},
      {owner:target,sk:revengeKey,expectedVersion:revenge?.version,value:{...meta(now,(revenge?.version ?? 0)+1),occurredAt:now}},
      {owner:target,sk:`INCOMING#PLAYER_RAID#${id}`,value:{...meta(now),actorId:player,actorType:'PLAYER',
        targetPlayerId:target,eventType:'RAID',occurredAt:now,outcome:'HIT',stolenYP:rewardAmount,balanceBefore:wallet.yallaPoint}},
      {sk:ACTIVITY_KEY,value:{},check:{key:playerKey(target,ACTIVITY_KEY),field:'lastActiveAt',value:lastActiveAt}},
      this.raidAccess(target,'RAID',access),
    );
    return {rewardAmount,writes,unavailable:false};
  }

  async pick(principal:Principal,id:string,input:z.infer<typeof pickInput>) {
    const player=await this.owner(principal), key=`RAID#${id}`;
    const selection=await this.retry(async()=>{
      const record=await this.db.get(player,key);
      if(!record)throw new ApiError(404,'RAID_NOT_FOUND');
      const op=record.operation;
      if(op.eventType!=='RAID')throw new ApiError(409,'BONUS_EVENT_TYPE_MISMATCH');
      const picks=record.picks as BagPick[];
      const previous=picks.find(p=>p.requestId===input.requestId);
      if(previous){
        if(previous.bagId!==input.bagId)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
        return previous;
      }
      if(record.status!=='READY')throw new ApiError(409,record.status==='CANCELLED'?'RAID_CANCELLED':'RAID_ALREADY_SETTLED');
      const config=op.config as GameConfig<'raid'>, rules=config.data.bags!;
      if(input.bagId>=(op.bagCount ?? rules.count))throw new ApiError(400,'INVALID_RAID_BAG');
      if(picks.some(p=>p.bagId===input.bagId))throw new ApiError(409,'RAID_BAG_ALREADY_PICKED');
      const state=await this.state(player);
      this.needRun(state,'Raid');
      if(state.raid.activeRaid?.raidId!==id)throw new ApiError(409,'RAID_NOT_ACTIVE');
      const ctx=await this.context(player),p=ctx.save.progress;
      if(!op.playerTarget && (p.worldId!==op.worldId || p.village!==op.village))throw new ApiError(409,'PROGRESS_CHANGED');
      if(ctx.collection.raidTickets<op.ticketCost)throw new ApiError(409,'INSUFFICIENT_RAID_TICKETS');
      const gold=record.bagGold[input.bagId] as number;
      const pick:BagPick={...input,gold,outcome:gold>0?'GOLD':'MISS'};
      const nextPicks=[...picks,pick],now=this.now();
      const next={...record,...meta(now,record.version+1),picks:nextPicks};
      const writes:Write[]=[{sk:key,value:next,expectedVersion:record.version}];
      if(nextPicks.length===(op.pickLimit ?? rules.picks)){
        const selected = nextPicks.reduce((sum,p)=>sum+p.gold,0);
        const transfer = op.playerTarget && await this.settleWalletRaid(player, op.playerTarget.playerId, id, Math.min(selected, 2147483647 - ctx.save.wallet.yallaPoint), now);
        const rewardAmount = transfer ? transfer.rewardAmount : Math.min(rules.goldCap, selected);
        const costumePoint = transfer && !rewardAmount ? 0 :
          nextPicks.filter(p=>p.outcome==='GOLD').length*rules.costumePointPerWin;
        const result={raidId:id,eventType:'RAID',defenderId:op.botId,rewardAmount,costumePoint,timestamp:now,
          ...(transfer ? {attackerId:player,attackerEntityType:'LocalPlayer',defenderEntityType:'RemotePlayer',
            stolenYP:rewardAmount,outcome:rewardAmount>0?'HIT':'MISS',targetUnavailable:transfer.unavailable} : {})};
        if (transfer) writes.push(...transfer.writes);
        Object.assign(next,{status:'SETTLED',result});
        const before=ctx.save.wallet;
        const wallet=walletSchema.parse({...before,...meta(now,before.version+1),
          yallaPoint:before.yallaPoint+rewardAmount,costumePoint:(before.costumePoint??0)+costumePoint});
        const collection=collectionSchema.parse({...ctx.collection,...meta(now,ctx.collection.version+1),raidTickets:ctx.collection.raidTickets-op.ticketCost});
        writes.push({sk:'WALLET',value:wallet,expectedVersion:before.version},{sk:'COLLECTION',value:collection,expectedVersion:ctx.collection.version},
          ...await this.drops.bingoRecord(player,now,[{type:'Raid'}]),
          ...this.receipt(`raid:${id}`,'raid',`bonus:${record.batchKey}:${record.sequence}`,config,ctx,wallet,result,hash({id,picks:nextPicks})));
      }
      await this.write(player,state,{...state},ctx,writes);
      return pick;
    });
    return {...await this.snapshot(principal),selection,result:publicRaidReceipt(await this.db.get(player,key))};
  }
  async purchaseCostume(principal:Principal,input:z.infer<typeof costumePurchaseInput>) {
    const player=await this.owner(principal),opId=`costume:${input.requestId}`,key=`ECONOMY#OP#${opId}`,requestHash=hash(input);
    const result=await this.retry(async()=>{
      const previous=await this.db.get(player,key);
      if(previous){
        if(previous.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
        return previous.result;
      }
      const config=await this.configs.load('raid'), prices=config.data.costumePrices??{};
      if(!Object.hasOwn(prices,input.itemId))throw new ApiError(409,'COSTUME_NOT_FOR_SALE');
      const price=prices[input.itemId]!;
      if(input.expectedPrice!==undefined && input.expectedPrice!==price)throw new ApiError(409,'COSTUME_PRICE_CHANGED');
      const state=await this.state(player),ctx=await this.context(player),before=ctx.save.wallet;
      const inventory=await this.db.get(player,'COSTUME'),ownedIds=inventory?.ownedIds??[];
      if(ownedIds.includes(input.itemId))throw new ApiError(409,'COSTUME_ALREADY_OWNED');
      if((before.costumePoint??0)<price)throw new ApiError(409,'INSUFFICIENT_COSTUME_POINT');
      const now=this.now(),result={itemId:input.itemId,costumePointSpent:price};
      const wallet=walletSchema.parse({...before,...meta(now,before.version+1),costumePoint:before.costumePoint-price});
      await this.write(player,state,{...state},ctx,[
        {sk:'WALLET',value:wallet,expectedVersion:before.version},
        {sk:'COSTUME',value:{...inventory,...meta(now,(inventory?.version??0)+1),ownedIds:[...ownedIds,input.itemId]},expectedVersion:inventory?.version},
        ...this.receipt(opId,'costume-purchase',opId,config,ctx,wallet,result,requestHash)]);
      return result;
    });
    return {...await this.snapshot(principal),result};
  }
  async equipCostume(principal:Principal,input:z.infer<typeof costumeEquipInput>) {
    const player=await this.owner(principal),key=`COSTUME#EQUIP#${input.requestId}`,requestHash=hash(input);
    const result=await this.retry(async()=>{
      const previous=await this.db.get(player,key);
      if(previous){
        if(previous.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
        return previous.result;
      }
      const inventory=await this.db.get(player,'COSTUME'),ownedIds=inventory?.ownedIds??[];
      if(input.itemId!==null){
        if(!input.itemId.startsWith(costumeSlotPrefixes[input.slot]))throw new ApiError(409,'COSTUME_SLOT_MISMATCH');
        if(!ownedIds.includes(input.itemId))throw new ApiError(409,'COSTUME_NOT_OWNED');
      }
      const now=this.now(),result={slot:input.slot,itemId:input.itemId};
      await this.db.commit(player,[
        {sk:'COSTUME',expectedVersion:inventory?.version,value:{...inventory,...meta(now,(inventory?.version??0)+1),
          ownedIds,equipped:{...inventory?.equipped,[input.slot]:input.itemId}}},
        {sk:key,value:{...meta(now),requestHash,result}},
      ]);
      return result;
    });
    return {...await this.snapshot(principal),result};
  }
}
export function createBonusService(table:string,drops:DropService,configs:ConfigSource) {
  const client=DynamoDBDocumentClient.from(new DynamoDBClient({}), {unmarshallOptions:playerNumberOptions});
  return new BonusService(createDynamoRepository(table),new DynamoDropStore(client,table),drops,configs);
}
