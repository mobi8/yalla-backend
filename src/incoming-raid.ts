import { loadActivityPolicy } from './activity-policy.js';
import { ACTIVITY_KEY, ACTIVITY_PARTITION, INACTIVE_AFTER_MS, OFFLINE_AFTER_MS, isRaidCandidate } from './player-activity.js';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { collectionSchema } from './drop-economy.js';
import { BotsConfigs, DEV_RAID_PLAYER, type BotsConfig, type BotsSource } from './bots-config.js';
import { currentVillageDamage, profileSchema } from './model.js';
import { buildingIds } from './world-config.js';
import { regenerateRaidBots } from './raid-bots.js';
import { decodeProgress, decodeWallet, encodeProgress, encodeWallet, playerKey, playerNumberOptions } from './repository.js';

import { activityFeedItem, journeyReadKeys } from './journey-read-keys.js';
import { startWalletRaid, walletRaidDebit, WALLET_RAID_PREFIX } from './incoming-wallet-raid.js';

const MINUTE=60000, DAY=86400000, SHARDS=16;
const digest=(s:string)=>createHash('sha256').update(s).digest();
const fraction=(s:string)=>digest(s).readUInt32BE(0)/0x100000000;
const shard=(id:string)=>`INCOMING#${digest(id)[0]! % SHARDS}`;
/** Stable randomized daily slots. A day has floor(rate) or ceil(rate) slots. */
export function nextAttackAt(player:string, after:number, rate:number):number {
  if(rate<=0) return after+DAY;
  for(let d=Math.floor(after/DAY);d<Math.floor(after/DAY)+4;d++) {
    const count=Math.floor(rate)+(fraction(`${player}:${d}:count`)<rate%1?1:0);
    const slots=Array.from({length:count},(_,i)=>d*DAY+Math.floor((i+fraction(`${player}:${d}:${i}`))*DAY/count)).sort((a,b)=>a-b);
    const next=slots.find(t=>t>after); if(next!==undefined)return next;
  }
  return (Math.floor(after/DAY)+4)*DAY;
}
export function newIncomingSchedule(player:string, now:number, rate=2.5) {
  return {schemaVersion:1,version:1,updatedAt:new Date(now).toISOString(),playerId:player,
    duePartition:shard(player),dueAt:new Date(nextAttackAt(player,now,rate)).toISOString(),sequence:1,day:'',dayCount:0};
}
function offlineWindow(now: number, policy?: BotsConfig['offlinePolicy']) {
  const maxAge = policy ? policy.offlineMaxHours * 60 * MINUTE : INACTIVE_AFTER_MS;
  const minAge = policy ? policy.offlineMinMinutes * MINUTE : OFFLINE_AFTER_MS;
  return {
    oldest: new Date(now - maxAge).toISOString(),
    latest: new Date(now - minAge - 1).toISOString(),
  };
}

function scheduledSlot(at: number, scheduleMinutes: number) {
  return Math.floor(at / (scheduleMinutes * MINUTE)) * scheduleMinutes;
}

type IncomingAction = 'ATTACK' | 'RAID';
type IncomingWrite = {sk: string; value: Record<string, any>; expectedVersion?: number};
type RaidGuard = { oldest: string; latest: string; slot?: number };

export interface IncomingStore {
  offline?(oldest: string, latest: string): AsyncIterable<string>;
  slotUsed?(slot: number): Promise<boolean>;
  due(now:string, shard:string):Promise<{playerId:string}[]>;
  get(player:string, sk:string):Promise<Record<string,any>|undefined>;
  commit(player:string,writes:IncomingWrite[],guard?: RaidGuard):Promise<void>;
}
export class IncomingRaidService {
  constructor(private store:IncomingStore,private configs:BotsSource,private clock=Date.now) {}
  async run(scheduledAt?: number, eventId?: string) {
    const config=await this.configs.load();
    if (!config.incomingRaid.enabled) return;
    if (config.incomingRaid.targetOffline) {
      if (!this.store.offline || !config.bots.some(bot => bot.attackEnabled)) return;
      const now = this.clock();
      const policy = config.offlinePolicy;
      const slot = policy ? scheduledSlot(scheduledAt ?? now, policy.scheduleMinutes) : undefined;
      if (slot !== undefined && await this.store.slotUsed?.(slot)) return;
      const weights = policy?.attackRaidWeights ?? { ATTACK: 1, RAID: 0 };
      const total = weights.ATTACK + weights.RAID;
      if (!total) return;
      // EventBridge supplies the same random event ID when retrying a scheduled invocation.
      const action = fraction(`bot-slot:${eventId ?? slot ?? now}`) * total < weights.ATTACK ? 'ATTACK' : 'RAID';
      if (policy) console.info(JSON.stringify({event:'INCOMING_ACTION_SELECTED', slot, action, weights}));
      if (policy || config.devFastMode) await this.rechargeDevBots(DEV_RAID_PLAYER, config, now);
      if (config.devFastMode && await this.store.slotUsed?.(Math.floor(now / MINUTE))) return;
      const {oldest, latest} = offlineWindow(now, policy);
      for await (const player of this.store.offline(oldest, latest)) {
        if (await this.execute(player, config, slot, action)) return;
      }
      if (policy && action === 'RAID') console.info(JSON.stringify({event:'INCOMING_WALLET_RAID_SKIPPED',slot}));
      return;
    }
    if(config.incomingRaid.allowedPlayerIds.length) {
      let failures=0;
      for(const player of config.incomingRaid.allowedPlayerIds) try { await this.execute(player,config); } catch { failures++; }
      if(failures) throw new Error('INCOMING_RAID_BATCH_FAILED');
      return;
    }
    const now=new Date(this.clock()).toISOString();
    let failures=0;
    for(let i=0;i<SHARDS;i++) for(const item of await this.store.due(now,`INCOMING#${i}`)) {
      try { await this.execute(item.playerId,config); } catch { failures++; console.error(JSON.stringify({event:'INCOMING_RAID_FAILED'})); }
    }
    if(failures) throw new Error('INCOMING_RAID_BATCH_FAILED');
  }
  private async rechargeDevBots(player: string, config: BotsConfig, now: number) {
    const state = await this.store.get(player, 'BONUS#STATE');
    if (!state?.raid?.bots?.length) return;
    const bots = regenerateRaidBots(state.raid.bots, config, now);
    if (bots.every((bot, index) => bot === state.raid.bots[index])) return;
    try {
      await this.store.commit(player, [{sk: 'BONUS#STATE', expectedVersion: state.version,
        value: {...state, raid: {...state.raid, bots}, version: state.version + 1, updatedAt: new Date(now).toISOString()}}]);
    } catch (error) {
      // A concurrent game request can refresh the roster. A later tick catches up from the stored timer.
      if (!(error instanceof Error) || !['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)) throw error;
    }
  }

  async execute(player:string,config?:BotsConfig, slot?: number, action: IncomingAction = 'ATTACK') {
    const c=config??await this.configs.load();
    if(!c.incomingRaid.enabled || (action === 'ATTACK' && (c.offlinePolicy?.attackRaidWeights?.ATTACK ?? 1) === 0) ||
        (c.incomingRaid.allowedPlayerIds.length && !c.incomingRaid.allowedPlayerIds.includes(player)) ||
        (c.devFastMode && !c.incomingRaid.targetOffline && player !== DEV_RAID_PLAYER) || !profileSchema.shape.playerId.safeParse(player).success) return;
    const active = c.bots.filter(bot => bot.attackEnabled);
    if (!active.length) return;
    if ((await this.store.get(player, 'PROFILE'))?.playerId !== player) return;
    const raidConfig = c.offlinePolicy?.walletRaid;
    if (action === 'RAID' && (!raidConfig?.enabled || !raidConfig.bagWeightsBps)) return;
    let raidPlan: ReturnType<typeof startWalletRaid> | undefined;
    for(let attempt=0;attempt<5;attempt++) {
      try {
        const now=this.clock(), iso=new Date(now).toISOString();
        const offline = c.incomingRaid.targetOffline;
        const policy = c.offlinePolicy;
        const currentSlot = slot ?? (policy ? scheduledSlot(now, policy.scheduleMinutes) : undefined);
        const guard = offline ? {
          ...offlineWindow(now, policy),
          slot: currentSlot ?? (c.devFastMode ? Math.floor(now / MINUTE) : undefined),
        } : undefined;
        if (guard) {
          const lastActiveAt = (await this.store.get(player, ACTIVITY_KEY))?.lastActiveAt;
          if (policy
            ? typeof lastActiveAt !== 'string' || lastActiveAt < guard.oldest || lastActiveAt > guard.latest
            : !isRaidCandidate(lastActiveAt, now)) return;
        }
        if (c.devFastMode && !offline) await this.rechargeDevBots(player, c, now);
        const storedSchedule = await this.store.get(player, 'INCOMING#SCHEDULE');
        if (!storedSchedule && !offline) return;
        const schedule = storedSchedule ?? {...newIncomingSchedule(player, now), version: 0, dueAt: iso};
        if (policy) {
          if (policy.perPlayerCooldownMinutes > 0 && schedule.lastSettledAt &&
              now - Date.parse(schedule.lastSettledAt) < policy.perPlayerCooldownMinutes * MINUTE) return;
        } else if (Date.parse(schedule.dueAt)>now) return;
        const day=iso.slice(0,10), count=schedule.day===day?schedule.dayCount:0;
        const nextAt = policy ? now : c.devFastMode ? (Math.floor(now / MINUTE) + 1) * MINUTE :
          nextAttackAt(player, Math.max(now, Date.parse(schedule.dueAt)), c.incomingRaid.averageAttacksPerDay);
        const next={...schedule,version:schedule.version+1,updatedAt:iso,dueAt:new Date(nextAt).toISOString(),
          sequence:schedule.sequence+1,day,dayCount:count};
        const writes:IncomingWrite[]=[
          {sk:'INCOMING#SCHEDULE',value:next,expectedVersion:storedSchedule?.version}
        ];
        if(policy ? policy.dailyLimit === null || count < policy.dailyLimit : c.devFastMode || count<c.incomingRaid.maximumAttacksPerDay) {
          if (action === 'RAID') {
            const stored = await this.store.get(player, 'WALLET');
            if (!stored) return;
            const wallet = decodeWallet(stored);
            const {protectedBalanceBps, bagWeightsBps, minimumTargetYP = 0} = raidConfig!;
            // A rejected wallet version retries this read and eligibility check before any settlement.
            if (wallet.yallaPoint < minimumTargetYP) return;
            raidPlan ??= startWalletRaid(wallet.yallaPoint, bagWeightsBps!);
            const stolenYP = walletRaidDebit(raidPlan.selectedYP, wallet.yallaPoint, protectedBalanceBps);
            const balanceAfter = wallet.yallaPoint - stolenYP;
            const sequence = String(schedule.sequence);
            const eventId = `RAID:${player}:${sequence}`;
            const bot = active[digest(`${player}:${sequence}:bot`).readUInt32BE(0) % active.length]!;
            next.dayCount = count + 1;
            Object.assign(next, {lastSettledAt: iso});
            writes.push(
              {sk:'WALLET', expectedVersion:wallet.version, value:{...wallet,
                yallaPoint:balanceAfter, version:wallet.version+1, updatedAt:iso}},
              {sk:`${WALLET_RAID_PREFIX}${sequence.padStart(16, '0')}`, value:{
                schemaVersion:1, version:1, updatedAt:iso, eventId, eventType:'RAID', actorType:'BOT',
                actorId:bot.id, targetType:'PLAYER', targetId:player, targetPlayerId:player, occurredAt:iso,
                result:stolenYP ? 'Success' : 'Miss', outcome:stolenYP ? 'HIT' : 'MISS', shieldConsumed:false,
                stolenYP, burnedYP:stolenYP, ...raidPlan, protectedBalanceBps, bagWeightsBps,
                balanceBefore:wallet.yallaPoint, balanceAfter,
              }},
            );
            await this.store.commit(player, writes, guard);
            console.info(JSON.stringify({event:'INCOMING_WALLET_RAID_SETTLED',slot:currentSlot,outcome:stolenYP?'HIT':'MISS'}));
            return true;
          }
          const previous=await this.store.get(player,'COLLECTION');
          if (!previous) return;
          const collection=collectionSchema.parse(previous);
          const bot=active[digest(`${player}:${schedule.sequence}:bot`).readUInt32BE(0)%active.length]!;
          const attackId=`${schedule.sequence}`;
          const blocked=collection.shieldCount>0;
          let hit;
          if (!blocked) {
            const stored=await this.store.get(player,'PROGRESS');
            if (!stored) return;
            const progress=decodeProgress(stored);
            const damage=currentVillageDamage(progress);
            const healthy=buildingIds.filter((id, index) => !damage[id] &&
              (!policy || (!progress.worldRunComplete && progress.facilityLevels[index]! > 1)));
            if (healthy.length) {
              const buildingId=healthy[digest(`${player}:${attackId}:building`).readUInt32BE(0)%healthy.length]!;
              const index = buildingIds.indexOf(buildingId);
              const facilityLevels = [...progress.facilityLevels];
              const levelBefore = facilityLevels[index]!;
              if (policy) facilityLevels[index] = levelBefore - 1;
              hit={worldId:progress.worldId,worldRunId:progress.worldRunId,village:progress.village,buildingId,
                ...(policy ? {levelBefore, levelAfter: facilityLevels[index]} : {})};
              const levelsBefore = Object.keys(damage).length ? progress.villageDamage?.levelsBefore : undefined;
              writes.push({sk:'PROGRESS',expectedVersion:progress.version,value:{...progress,facilityLevels,
                version:progress.version+1,updatedAt:iso,
                villageDamage:{worldRunId:progress.worldRunId,village:progress.village,buildings:{...damage,[buildingId]:attackId},
                  ...(Object.keys(damage).length && progress.villageDamage?.help ? {help: progress.villageDamage.help} : {}),
                  ...(policy ? {levelsBefore:{...levelsBefore,[buildingId]:levelBefore}} : {})}}});
              if (policy) {
                const sk = `WORLD#${progress.worldId}`;
                const world = await this.store.get(player, sk);
                if (world?.status === 'COMPLETE') return;
                if (world) writes.push({sk, expectedVersion:world.version,
                  value:{...world, levels:facilityLevels, version:world.version+1, updatedAt:iso}});
              }
            }
          }
          if (blocked || hit) {
            next.dayCount=count+1;
            if (policy) Object.assign(next, {lastSettledAt: iso});
            // Pin the shield check against concurrent Collection changes even on an unblocked hit.
            writes.push({sk:'COLLECTION',value:{...collection,shieldCount:collection.shieldCount-Number(blocked),
              version:collection.version+1,updatedAt:iso},expectedVersion:collection.version});
            writes.push({sk:`INCOMING#RECEIPT#${attackId.padStart(16,'0')}`,
              value:{schemaVersion:1,version:1,updatedAt:iso,attackId,botId:bot.id,timestamp:iso,eventType:'ATTACK',
                ...(policy ? {eventId:`ATTACK:${player}:${attackId}`,actorType:'BOT',actorId:bot.id,
                  targetType:'PLAYER',targetId:player,targetPlayerId:player,occurredAt:iso,
                  ...(hit ? {villageId:String(hit.village),facilityId:hit.buildingId} : {})} : {}),
                shieldConsumed:blocked,result:blocked?'BlockedByShield':'Success',outcome:blocked?'BLOCKED':'HIT',...hit}});
          }
        }
        await this.store.commit(player,writes,guard);
        return writes.length > 1;
      } catch(e) {
        if(!(e instanceof Error) || !['TransactionCanceledException','ConditionalCheckFailedException'].includes(e.name)) throw e;
        if (slot !== undefined && await this.store.slotUsed?.(slot)) return true;
        if (c.incomingRaid.targetOffline && c.devFastMode && await this.store.slotUsed?.(Math.floor(this.clock() / MINUTE))) return true;
      }
    }
    if (!c.incomingRaid.targetOffline) throw new Error('INCOMING_RAID_CONFLICT');
  }
}
export class DynamoIncomingStore implements IncomingStore {
  constructor(private client:DynamoDBDocumentClient,private table:string, private activityPolicy = loadActivityPolicy()) {}
  async get(player:string,sk:string) { const r=await this.client.send(new GetCommand({TableName:this.table,Key:playerKey(player,sk),ConsistentRead:true})); if(!r.Item)return; const {PK,SK,...item}=r.Item;return item; }
  async due(now:string,partition:string) {
    const out:{playerId:string}[]=[]; let cursor:Record<string,any>|undefined;
    do {const r=await this.client.send(new QueryCommand({TableName:this.table,IndexName:'IncomingDue',KeyConditionExpression:'duePartition = :p AND dueAt <= :t',ExpressionAttributeValues:{':p':partition,':t':now},ExclusiveStartKey:cursor}));
      for(const item of r.Items??[]) if(typeof item.playerId==='string')out.push({playerId:item.playerId}); cursor=r.LastEvaluatedKey;
    } while(cursor); return out;
  }
  async *offline(oldest: string, latest: string): AsyncIterable<string> {
    let cursor: Record<string, any> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.table, IndexName: 'PlayerActivity',
        KeyConditionExpression: 'activityPartition = :partition AND lastActiveAt BETWEEN :oldest AND :latest',
        ExpressionAttributeValues: {':partition': ACTIVITY_PARTITION, ':oldest': oldest, ':latest': latest},
        ProjectionExpression: 'PK', Limit: 25, ScanIndexForward: false, ExclusiveStartKey: cursor,
      }));
      for (const item of page.Items ?? []) {
        if (typeof item.PK === 'string' && item.PK.startsWith('PLAYER#')) yield item.PK.slice('PLAYER#'.length);
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  }
  private readonly slotKey = {PK: 'SYSTEM#INCOMING', SK: 'MINUTE'};
  async slotUsed(slot: number) {
    const {Item} = await this.client.send(new GetCommand({TableName: this.table, Key: this.slotKey, ConsistentRead: true}));
    return typeof Item?.slot === 'number' && Item.slot >= slot;
  }
  async commit(player:string,writes:IncomingWrite[],guard?: RaidGuard) {
    await this.client.send(new TransactWriteCommand({TransactItems:[
      ...writes.map(w=>({Put:{TableName:this.table,Item:{...playerKey(player,w.sk),...(w.sk === 'PROGRESS' ? encodeProgress(decodeProgress(w.value)) :
          w.sk === 'WALLET' ? encodeWallet(decodeWallet(w.value)) : w.value), ...journeyReadKeys(player,w.sk,w.value,false)},
        ConditionExpression:w.expectedVersion===undefined?'attribute_not_exists(PK)':'#v = :v',
        ...(w.expectedVersion===undefined?{}:{ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':w.expectedVersion}})}})),
      ...writes.flatMap(w => {
        const feed = activityFeedItem(player, w.sk, w.value, this.activityPolicy);
        return feed ? [{Put: {TableName: this.table, Item: feed}}] : [];
      }),
      ...(guard ? [{ConditionCheck: {TableName: this.table, Key: playerKey(player, ACTIVITY_KEY),
        ConditionExpression: 'lastActiveAt BETWEEN :oldest AND :latest',
        ExpressionAttributeValues: {':oldest': guard.oldest, ':latest': guard.latest}}}] : []),
      ...(guard?.slot === undefined || writes.length === 1 ? [] : [{Put: {TableName: this.table,
        Item: {...this.slotKey, slot: guard.slot},
        ConditionExpression: 'attribute_not_exists(#slot) OR #slot < :slot',
        ExpressionAttributeNames: {'#slot': 'slot'}, ExpressionAttributeValues: {':slot': guard.slot}}}]),
    ]}));
  }
}
let service:IncomingRaidService|undefined;
export async function handler(event?: {time?: string; id?: string}) {
  if(!process.env.PLAYER_TABLE) throw Error('PLAYER_TABLE_NOT_CONFIGURED');
  service??=new IncomingRaidService(new DynamoIncomingStore(DynamoDBDocumentClient.from(new DynamoDBClient({}), {unmarshallOptions: playerNumberOptions}),process.env.PLAYER_TABLE),new BotsConfigs());
  const scheduledAt = Date.parse(event?.time ?? '');
  await service.run(Number.isFinite(scheduledAt) ? scheduledAt : undefined, event?.id);
}
