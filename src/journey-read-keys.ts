import { activityExpiry, type ActivityPolicy } from './activity-policy.js';
import { decimalString, longString } from './model.js';
import { scaled } from './drop-economy.js';

type Stored = Record<string, any>;
export const journeyIndex = 'JourneyRead';
export const friendRankPartition = 'PLAYERS';
export const totalPartition = 'DISTANCE#TOTAL';
export const deltaPartition = 'DISTANCE#DELTA';
export const activityPartition = (player: string) => `FEED#${player}`;
const smoke = /(^|[:#_-])(?:test|smoke)(?:[:#_-]|$)/i;
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : undefined;
const botId = (value: string) => value.split(':').at(-1)!;
const amount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function distanceOrder(distance: string, player: string) {
  return `${String(scaled(distance)).padStart(57, '0')}#${player}`;
}

export function privateActivity(player: string, sk: string, value: Stored) {
  const isIncomingAttack = sk.startsWith('INCOMING#RECEIPT#');
  const isIncomingRaid = sk.startsWith('INCOMING#WALLET_RAID#');
  const incoming = isIncomingAttack || isIncomingRaid;
  const result = incoming ? value : value.result;
  if (!result || (!incoming && (!sk.startsWith('RAID#') || value.status !== 'SETTLED' ||
      (value.operation?.eventType ?? result.eventType ?? 'ATTACK') !== 'ATTACK' ||
      result.attackerEntityType !== 'LocalPlayer' || result.defenderEntityType !== 'SystemBot' ||
      result.attackerId !== player))) return;
  if (incoming && result.targetPlayerId && result.targetPlayerId !== player) return;
  const type = isIncomingRaid ? 'RAID' : 'ATTACK';
  if (isIncomingRaid && (result.actorType !== 'BOT' || result.targetType !== 'PLAYER' ||
      !amount(result.stolenYP) || result.stolenYP === 0 || result.outcome !== 'HIT')) return;
  const outcome = isIncomingRaid ? 'STOLEN' :
    result.outcome ?? (result.result === 'Success' ? 'HIT' : result.result === 'BlockedByShield' ? 'BLOCKED' : undefined);
  if (!isIncomingRaid && outcome !== 'HIT' && outcome !== 'BLOCKED') return;
  const bot = incoming ? result.actorId ?? result.botId : result.defenderId;
  const sequence = incoming ? sk.split('#').at(-1)?.replace(/^0+(?=\d)/, '') : sk.slice('RAID#'.length);
  if (!sequence || (incoming && !/^\d+$/.test(sequence))) return;
  const eventId = `${type}:${player}:${sequence}`;
  const occurredAt = iso(result.occurredAt ?? result.timestamp);
  if (typeof bot !== 'string' || !bot || smoke.test(eventId) || value.test === true || result.test === true ||
      (result.eventId !== undefined && result.eventId !== eventId) || !occurredAt) return;
  const facility = result.buildingId ?? result.facilityId ??
    (amount(result.selectedFacilityId) && result.selectedFacilityId < 5 ? `building-${result.selectedFacilityId + 1}` : undefined);
  const human = { id: player, type: 'PLAYER' };
  const opponent = { id: botId(bot), type: 'BOT' };
  const before = result.balanceBefore;
  return {
    eventId, occurredAt, type, outcome, attacker: incoming ? opponent : human, defender: incoming ? human : opponent,
    ...(isIncomingRaid ? {
      stolenYP: result.stolenYP,
      ...(amount(before) && before > 0 ? { stolenPercent: Math.round(1000 * result.stolenYP / before) / 10 } : {}),
    } : {
      ...(typeof result.worldId === 'string' ? { worldId: result.worldId } : {}),
      ...(outcome === 'HIT' && typeof facility === 'string' ? { buildingId: facility } : {}),
      ...(outcome === 'HIT' && amount(result.levelBefore) && amount(result.levelAfter)
        ? { levelBefore: result.levelBefore, levelAfter: result.levelAfter } : {}),
      ...(typeof result.shieldConsumed === 'boolean' ? { shieldConsumed: result.shieldConsumed } : {}),
    }),
  };
}

export function friendRankKeys(distance: string, stars: string, player: string) {
  const metersKey = String(scaled(distance)).padStart(57, '0');
  const starsKey = stars.padStart(19, '0');
  return { friendsRankPK: friendRankPartition, friendsStarsSK: `${starsKey}#${metersKey}#${player}`,
    friendsDistanceSK: `${metersKey}#${starsKey}#${player}` };
}

export function activityFeedItem(player: string, sourceKey: string, value: Stored, policy: ActivityPolicy) {
  const event = privateActivity(player, sourceKey, value);
  if (!event) return;
  return {
    PK: `PLAYER#${player}`, SK: `ACTIVITY_FEED#${sourceKey}`, event,
    journeyPK: activityPartition(player), journeySK: `${event.occurredAt}#${event.eventId}#${sourceKey}`,
    activityExpiresAt: activityExpiry(event.occurredAt, policy),
  };
}

export function journeyReadKeys(player: string, sk: string, value: Stored, indexLegacyActivity = true) {
  if (sk === 'PROGRESS' && decimalString.safeParse(value.distance).success)
    return { journeyPK: totalPartition, journeySK: distanceOrder(value.distance, player), rankDistance: value.distance,
      ...(longString.safeParse(value.constructionStars).success ? friendRankKeys(value.distance, value.constructionStars, player) : {}) };
  if (sk.startsWith('ROUND#') && value.status === 'SETTLED') {
    const when = iso(value.settledAt);
    const distance = decimalString.safeParse(value.reward?.distance);
    if (when && distance.success && scaled(distance.data) > 0n)
      return { journeyPK: deltaPartition, journeySK: `${when}#${player}#${sk}`, rankDistance: distance.data };
  }
  const event = indexLegacyActivity ? privateActivity(player, sk, value) : undefined;
  if (event) return { journeyPK: activityPartition(player), journeySK: `${event.occurredAt}#${event.eventId}#${sk}` };
  return {};
}

export function withoutJourneyKeys(value: Stored) {
  const { journeyPK, journeySK, rankDistance, friendsRankPK, friendsStarsSK, friendsDistanceSK, ...stored } = value;
  return stored;
}
