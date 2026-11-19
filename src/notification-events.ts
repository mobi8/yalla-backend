import { z } from 'zod';
import { privateActivity } from './journey-read-keys.js';

const base = z.object({eventId:z.string().min(1).max(256),recipientPlayerId:z.uuid(),
  actorPlayerId:z.string().min(1).max(160),actorDisplayName:z.string().min(1).max(100),occurredAt:z.iso.datetime()});
export const notificationEvent = z.discriminatedUnion('eventType', [
  base.extend({eventType:z.literal('RAID_STOLEN'),payload:z.object({stolenYP:z.number().int().positive()})}),
  base.extend({eventType:z.literal('ATTACK_HIT'),payload:z.object({buildingId:z.string().min(1),worldId:z.string().optional(),buildingName:z.string().optional()})}),
  base.extend({eventType:z.literal('ATTACK_BLOCKED'),payload:z.object({shieldConsumed:z.literal(true)})}),
]);
export type NotificationEvent = z.infer<typeof notificationEvent>;
const rule = z.object({activity:z.boolean(),telegram:z.boolean(),push:z.union([z.boolean(),z.literal('LOCAL')]),
  pushCooldownSeconds:z.number().int().nonnegative().optional(),title:z.string(),body:z.string(),fallback:z.string().optional()});
export const notificationPolicy = z.object({remoteEnabled:z.boolean(),apns:z.object({
  environment:z.enum(['sandbox','production']),bundleId:z.string(),teamId:z.string(),keyId:z.string(),
}),events:z.object({RAID_STOLEN:rule,ATTACK_HIT:rule,ATTACK_BLOCKED:rule,ENERGY_FULL:rule})});
export const readNotificationPolicy = () => notificationPolicy.parse(JSON.parse(process.env.NOTIFICATION_CONFIG ?? '{}'));

export function receiptNotification(player: string, sk: string, item: Record<string, unknown>): NotificationEvent | undefined {
  if (!sk.startsWith('INCOMING#RECEIPT#') && !sk.startsWith('INCOMING#WALLET_RAID#')) return;
  const event = privateActivity(player, sk, item);
  if (!event || event.defender.type !== 'PLAYER') return;
  const actorDisplayName = typeof item.actorDisplayName === 'string' && item.actorDisplayName.trim()
    ? item.actorDisplayName.trim().slice(0,100) : 'A rival';
  const common = {eventId:event.eventId,recipientPlayerId:player,actorPlayerId:event.attacker.id,actorDisplayName,occurredAt:event.occurredAt};
  const value = 'stolenYP' in event ? {...common,eventType:'RAID_STOLEN',payload:{stolenYP:event.stolenYP}} :
    event.outcome === 'BLOCKED' ? {...common,eventType:'ATTACK_BLOCKED',payload:{shieldConsumed:'shieldConsumed' in event && event.shieldConsumed}} :
      {...common,eventType:'ATTACK_HIT',payload:{buildingId:'buildingId' in event ? event.buildingId : undefined,worldId:'worldId' in event ? event.worldId : undefined,buildingName:item.buildingName}};
  const checked = notificationEvent.safeParse(value);
  return checked.success ? checked.data : undefined;
}

export function notificationMessage(event: NotificationEvent, policy: ReturnType<typeof readNotificationPolicy>) {
  const rule = policy.events[event.eventType];
  const p = event.payload;
  const values: Record<string,string> = {actor:event.actorDisplayName,amount:'stolenYP' in p ? String(p.stolenYP) : '',
    building:'buildingName' in p ? p.buildingName ?? '' : ''};
  const body = event.eventType === 'ATTACK_HIT' && !values.building ? rule.fallback ?? rule.body : rule.body;
  return {title:rule.title,body:body.replace(/\{(\w+)\}/g, (_,key:string) => values[key] ?? '')};
}
