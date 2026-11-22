import { z } from 'zod';
import { createHash } from 'node:crypto';
import { worldIds } from './world-ids.js';
import type { ConfigSource } from './game-config.js';
const amount=z.number().int().min(0).max(2147483647),id=z.enum(worldIds),asset=z.string().min(1).max(200);
const layout=z.strictObject({anchoredPosition:z.tuple([z.number(),z.number()]).optional(),sizeDelta:z.tuple([z.number().positive(),z.number().positive()]).optional(),rotation:z.number().optional(),siblingIndex:z.number().int().min(0).max(100).optional()});
export const buildingIds=['building-1','building-2','building-3','building-4','building-5'] as const;
const prices=z.array(amount).length(4);
export const worldConfigSchema=z.strictObject({releaseId:z.string().min(1),worlds:z.array(z.strictObject({id,order:z.number().int().min(1).max(100),displayName:z.string().min(1).max(100),enabled:z.boolean(),contentState:z.enum(['READY','PLANNED']),objectSetKey:asset.nullable(),backgroundAssetKey:asset.nullable(),thumbnailAssetKey:asset.nullable(),fallbackAssetKey:asset,fallbackObjectSetKey:asset,unlockAfterWorldId:id.nullable(),nextWorldId:id.nullable(),completionCondition:z.literal('ALL_BUILDINGS_MAX'),rewardKey:id,overrides:z.strictObject({objectSetKey:asset,backgroundAssetKey:asset}).partial()})).length(100)})
 .refine(c=>new Set(c.worlds.map(w=>w.id)).size===100 && new Set(c.worlds.map(w=>w.order)).size===100,'World IDs/orders must be unique');
export const worldBuildingsSchema=z.strictObject({releaseId:z.string().min(1),defaults:z.strictObject({initialLevel:z.literal(1),maxLevel:z.literal(5),upgradePrices:prices,buildings:z.array(z.strictObject({id:z.enum(buildingIds),displayName:z.string().min(1),order:z.number().int().min(1).max(5),purchaseCondition:z.literal('PREVIOUS_LEVEL'),levels:z.array(z.strictObject({level:z.number().int().min(1).max(5),spriteSlot:z.number().int().min(0).max(4),prefabAssetKey:asset.nullable()})).length(5).refine(v=>v.every((l,i)=>l.level===i+1)),layout:layout.nullable()})).length(5).refine(b=>new Set(b.map(v=>v.id)).size===5 && new Set(b.map(v=>v.order)).size===5)}),
 objectSets:z.record(z.string().min(1),z.strictObject({backgroundAssetKey:asset,buildings:z.array(z.array(asset.nullable()).length(5)).length(5)})),
 worldOverrides:z.partialRecord(id,z.strictObject({upgradePrices:prices.optional(),buildingOverrides:z.partialRecord(z.enum(buildingIds),z.strictObject({displayName:z.string().min(1).optional(),upgradePrices:prices.optional(),layout:layout.optional(),levelAssetKeys:z.array(asset.nullable()).length(5).optional()})).optional()}))});
export const worldRewardsSchema=z.strictObject({releaseId:z.string().min(1),worlds:z.array(z.strictObject({worldId:id,confirmed:z.boolean(),completionRewards:z.array(z.strictObject({type:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),amount:amount.optional(),itemId:z.string().min(1).max(100).optional()})).max(20)})).length(100)}).refine(v=>new Set(v.worlds.map(w=>w.worldId)).size===100);
export async function loadWorldCatalog(configs:ConfigSource) {
 const [world,buildings,rewards]=await Promise.all([configs.load('world'),configs.load('world-buildings'),configs.load('world-rewards')]);
 if(new Set([world.data.releaseId,buildings.data.releaseId,rewards.data.releaseId]).size!==1)throw new Error('WORLD_CONFIG_RELEASE_MISMATCH');
 const worlds=world.data.worlds.map(w=>{
  if(w.rewardKey!==w.id || w.nextWorldId===w.id || w.unlockAfterWorldId===w.id)throw new Error('Invalid World link/reward key');
  const reward=rewards.data.worlds.find(r=>r.worldId===w.id)!;
  const setKey=w.overrides.objectSetKey??w.objectSetKey,art=setKey?buildings.data.objectSets[setKey]:undefined;
  const fallback=buildings.data.objectSets[w.fallbackObjectSetKey];if(!fallback)throw new Error('Missing fallback object set');
  const supported=reward.completionRewards.every(r=>['ENERGY','YALLA_POINT','DIAMOND'].includes(r.type)&&r.amount!==undefined&&!r.itemId);
  const playable=w.enabled&&w.contentState==='READY'&&!!art&&reward.confirmed&&supported;
  const override=buildings.data.worldOverrides[w.id];
  const resolved=buildings.data.defaults.buildings.map(b=>{
   const own=override?.buildingOverrides?.[b.id];const costs=own?.upgradePrices??override?.upgradePrices??buildings.data.defaults.upgradePrices;
   return {...b,displayName:own?.displayName??b.displayName,layout:own?.layout??b.layout,levels:b.levels.map(l=>({...l,upgradeCost:l.level===5?null:costs[l.level-1],spriteAssetKey:own?.levelAssetKeys?.[l.level-1]??(art??fallback).buildings[buildingIds.indexOf(b.id)]![l.spriteSlot],fallbackSpriteAssetKey:fallback.buildings[buildingIds.indexOf(b.id)]![l.spriteSlot]}))};
  });
  return {...w,playable,blockedReason:!w.enabled?'WORLD_DISABLED':w.contentState!=='READY'||!art?'WORLD_CONTENT_NOT_READY':!reward.confirmed?'WORLD_REWARD_UNCONFIRMED':!supported?'WORLD_REWARD_UNSUPPORTED':null,completionRewards:reward.completionRewards,rewardConfirmed:reward.confirmed,buildings:resolved};
 }).sort((a,b)=>a.order-b.order);
 const legacy=['dunes','canyon','oasis','bazaar','palace','nightcity','goldentemple'];
 if(legacy.some((id,i)=>worlds[i]?.id!==id))throw new Error('Legacy World order changed');
 for(const w of worlds){
  if(w.id==='dunes'?w.unlockAfterWorldId!==null:w.unlockAfterWorldId===null)throw new Error('Invalid unlock root');
  if(w.id==='world-100'?w.nextWorldId!==null:w.nextWorldId===null)throw new Error('Invalid terminal World');
  if(w.nextWorldId && worlds.find(n=>n.id===w.nextWorldId)?.unlockAfterWorldId!==w.id)throw new Error('Inconsistent next/unlock links');
  if(w.unlockAfterWorldId && worlds.find(n=>n.id===w.unlockAfterWorldId)?.nextWorldId!==w.id)throw new Error('Inconsistent prerequisite');
 }
 // The explicit next link is independent from display order, but must form one forward, non-cyclic chain.
 for(const w of worlds){const seen=new Set<string>();let at:typeof w|undefined=w;while(at){if(seen.has(at.id))throw new Error('Cyclic World chain');seen.add(at.id);at=at.nextWorldId?worlds.find(n=>n.id===at!.nextWorldId):undefined;}}
 return {releaseId:world.data.releaseId,revision:createHash('sha256').update([world.contentHash,buildings.contentHash,rewards.contentHash].join(':')).digest('hex'),
  versions:{world:world.version,buildings:buildings.version,rewards:rewards.version},hashes:{world:world.contentHash,buildings:buildings.contentHash,rewards:rewards.contentHash},worlds};
}
export type WorldCatalog=Awaited<ReturnType<typeof loadWorldCatalog>>;

export function villageRepairCost(progress: import('./model.js').Progress, building: WorldCatalog['worlds'][number]['buildings'][number]) {
 const level = progress.villageDamage?.levelsBefore?.[building.id] ?? progress.facilityLevels[buildingIds.indexOf(building.id)]!;
 const base = Math.ceil(building.levels[Math.max(0, level - 2)]!.upgradeCost! / 2);
 const help = progress.villageDamage?.help?.[building.id];
 return Math.max(0, base - (help?.savedYP ?? 0));
}

export function canHelpDamage(progress: import('./model.js').Progress, buildingId: typeof buildingIds[number]) {
 // Owner repair clears this marker. A new attack ID does not reset an open damage cycle.
 return progress.villageDamage?.help?.[buildingId] === undefined;
}
