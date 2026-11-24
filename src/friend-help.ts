import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recharge } from './drop-economy.js';
import type { FriendsStore, Item, Key } from './friends-store.js';
import type { ConfigSource } from './game-config.js';
import { activityPartition, journeyReadKeys } from './journey-read-keys.js';
import { currentVillageDamage, type Progress } from './model.js';
import { ApiError, decodeProgress, decodeWallet, encodeProgress, encodeWallet, playerKey } from './repository.js';
import { canHelpDamage, loadWorldCatalog, villageRepairCost, type WorldCatalog } from './world-config.js';

const eventInput = z.strictObject({ eventId: z.uuid() });
const visitInput = z.strictObject({ targetId: z.uuid() });
const helpInput = visitInput.extend({ requestId: z.uuid() });
const interval = 4 * 60 * 60 * 1000;
const capacity = 5;
export const helpPrefix = 'FRIEND_HELP#';
const thanksPrefix = 'FRIEND_HELP_THANKS#';
const unreadPrefix = 'FRIEND_HELP_UNREAD#';
const conflict = () => new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');

const repairDiscountBands = [
  { min: 1, max: 1, weight: 1 },
  { min: 2, max: 2, weight: 1 },
  { min: 3, max: 5, weight: 45 },
  { min: 6, max: 10, weight: 30 },
  { min: 11, max: 15, weight: 13 },
  { min: 16, max: 20, weight: 6 },
  { min: 21, max: 25, weight: 3 },
  { min: 26, max: 30, weight: 1 },
] as const;

const repairDiscountWeight = repairDiscountBands.reduce((total, band) => total + band.weight, 0);
if (repairDiscountWeight !== 100) throw new Error('Friend HELP discount weights must sum to 100');

export function rollRepairDiscount(roll: (max: number) => number = randomInt): number {
  let ticket = roll(repairDiscountWeight);
  for (const { min, max, weight } of repairDiscountBands) {
    if (ticket < weight) return min === max ? min : min + roll(max - min + 1);
    ticket -= weight;
  }
  throw new RangeError('Invalid Friend HELP discount roll');
}

export function cloverState(row: Record<string, unknown> | undefined, now: number) {
  const previous = Number(row?.remaining ?? capacity);
  const anchor = typeof row?.anchor === 'number' ? row.anchor : now;
  const charges = Math.max(0, Math.floor((now - anchor) / interval));
  const remaining = Math.min(capacity, previous + charges);
  const nextAnchor = remaining === capacity ? null : anchor + charges * interval;
  return { remaining, capacity, anchor: nextAnchor, nextAt: nextAnchor === null ? null : new Date(nextAnchor + interval).toISOString() };
}

function indexedEvent(player: string, prefix: string, event: {eventId: string; occurredAt: string} & Record<string, unknown>): Item {
  const key = playerKey(player, prefix + event.eventId);
  return { ...key, ...event, version: 1, journeyPK: activityPartition(player), journeySK: `${event.occurredAt}#${event.eventId}#${key.SK}` };
}

export class FriendHelpService {
  constructor(private store: FriendsStore, private configs: ConfigSource, private clock = Date.now,
    private roll = randomInt) {}

  private async party(id: string) {
    const profile = await this.store.get(playerKey(id, 'PROFILE'));
    return { id, type: 'PLAYER', nickname: profile?.nickname ?? 'Player', avatarId: profile?.avatarId ?? null };
  }

  private async target(player: string, targetId: string) {
    const key: Key = { PK: `FRIENDS#PAIR#${[player, targetId].sort().join('#')}`, SK: 'STATE' };
    const pair = await this.store.get(key);
    if (player === targetId || pair?.state !== 'ACCEPTED' || typeof pair.revision !== 'string')
      throw new ApiError(403, 'FRIEND_REQUIRED');
    const row = await this.store.get(playerKey(targetId, 'PROGRESS'));
    if (!row) throw new ApiError(404, 'PLAYER_NOT_FOUND');
    return { key, revision: pair.revision, progress: decodeProgress(row) };
  }

  eligibleDamage(progress: Progress, world: WorldCatalog['worlds'][number]) {
    const damage = currentVillageDamage(progress);
    return new Set(world.buildings.filter(building => {
      const attackId = damage[building.id];
      return attackId && canHelpDamage(progress, building.id) && villageRepairCost(progress, building) > 0;
    }).map(building => building.id));
  }

  async catalog() {
    return loadWorldCatalog(this.configs);
  }

  private async village(progress: Progress) {
    const catalog = await this.catalog();
    const world = catalog.worlds.find(entry => entry.id === progress.worldId)!;
    const damage = currentVillageDamage(progress);
    const eligible = this.eligibleDamage(progress, world);
    const repairs = world.buildings.flatMap(building => {
      const attackId = damage[building.id];
      if (!attackId) return [];
      const cost = villageRepairCost(progress, building);
      return [{ buildingId: building.id, attackId, cost, name: building.displayName,
        eligible: eligible.has(building.id), levelBefore: progress.villageDamage?.levelsBefore?.[building.id] ?? null }];
    });
    return { world, levels: progress.facilityLevels, worldRunId: progress.worldRunId, village: progress.village, repairs };
  }

  async clover(player: string) {
    const row = await this.store.get(playerKey(player, 'FRIEND_HELP_CLOVER'));
    const now = this.clock();
    return { clover: cloverState(row, now), serverTime: new Date(now).toISOString() };
  }

  private async visit(player: string, targetId: string) {
    const target = await this.target(player, targetId);
    const [village, friend, balance, costume] = await Promise.all([this.village(target.progress), this.party(targetId),
      this.clover(player), this.store.get(playerKey(targetId, 'COSTUME'))]);
    return { ...village, friend, equippedCostume: costume?.equipped ?? {}, ...balance };
  }

  private async help(player: string, {targetId, requestId}: z.infer<typeof helpInput>) {
    const receiptKey = playerKey(player, `FRIEND_HELP_REQUEST#${requestId}`);
    const cloverKey = playerKey(player, 'FRIEND_HELP_CLOVER');
    const walletKey = playerKey(player, 'WALLET');
    let percent: number | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const receipt = await this.store.get(receiptKey);
      if (receipt) {
        if (receipt.targetId !== targetId) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        return receipt.result;
      }
      const target = await this.target(player, targetId);
      const { progress } = target;
      const now = this.clock(), occurredAt = new Date(now).toISOString();
      const [village, row, sender, storedWallet] = await Promise.all([
        this.village(progress), this.store.get(cloverKey), this.party(player), this.store.get(walletKey),
      ]);
      const eligible = village.repairs.filter(repair => repair.eligible);
      const current = cloverState(row, now);
      if (!eligible.length || !current.remaining) {
        if (await this.store.get(receiptKey)) continue;
        throw new ApiError(409, eligible.length ? 'NO_CLOVER' : 'NO_HELP_ELIGIBLE_DAMAGE');
      }
      if (!storedWallet) throw new ApiError(404, 'PLAYER_NOT_FOUND');
      const selected = eligible[this.roll(eligible.length)]!;
      percent ??= rollRepairDiscount(this.roll);
      const wallet = recharge(decodeWallet(storedWallet), now);
      const walletVersion = wallet.version++;
      wallet.energy += percent;
      if (wallet.energy >= 50) wallet.energyRechargeAnchor = '0';
      wallet.updatedAt = occurredAt;
      const savedYP = Math.min(selected.cost, Math.max(1, Math.floor(selected.cost * percent / 100)));
      const clover = cloverState({ ...cloverKey, remaining: current.remaining - 1, anchor: current.anchor ?? now }, now);
      const event = { eventId: randomUUID(), type: 'FRIEND_HELP_REPAIR', occurredAt, sender, recipientId: targetId,
        buildingId: selected.buildingId, attackId: selected.attackId, worldRunId: progress.worldRunId, buildingName: selected.name, worldId: progress.worldId, percent, savedYP,
        remainingCost: selected.cost - savedYP, thanked: false };
      const result = { event, clover, serverTime: occurredAt, energyReward: percent };
      const version = progress.version++;
      progress.updatedAt = occurredAt;
      const damage = progress.villageDamage!;
      damage.help = { ...damage.help, [selected.buildingId]: { attackId: selected.attackId, savedYP } };
      if (await this.store.commit([
        { check: target.key, expected: target.revision },
        { item: { ...cloverKey, remaining: clover.remaining, anchor: clover.anchor, version: Number(row?.version ?? 0) + 1 },
          expected: row ? Number(row.version) : null },
        { item: { ...playerKey(targetId, 'PROGRESS'), ...encodeProgress(progress),
          ...journeyReadKeys(targetId, 'PROGRESS', progress) }, expected: version },
        { item: indexedEvent(targetId, helpPrefix, event), expected: null },
        { item: { ...playerKey(targetId, unreadPrefix + event.eventId), event }, expected: null },
        { item: { ...walletKey, ...encodeWallet(wallet) }, expected: walletVersion },
        { item: { ...receiptKey, targetId, result }, expected: null },
      ])) return result;
    }
    throw conflict();
  }

  private async thanks(player: string, eventId: string) {
    const sourceKey = playerKey(player, helpPrefix + eventId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const source = await this.store.get(sourceKey);
      if (source?.type !== 'FRIEND_HELP_REPAIR' || source.recipientId !== player)
        throw new ApiError(404, 'HELP_EVENT_NOT_FOUND');
      if (source.thanked === true) return { thanked: true };
      const helperId = (source.sender as {id: string}).id;
      const event = { eventId: `thanks:${eventId}`, originalHelpEventId: eventId, type: 'FRIEND_HELP_THANKS',
        occurredAt: new Date(this.clock()).toISOString(), sender: await this.party(player),
        recipientId: helperId, message: 'Thanks for helping my Village!' };
      if (await this.store.commit([
        { item: { ...source, thanked: true, version: Number(source.version) + 1 }, expected: Number(source.version) },
        { item: indexedEvent(helperId, thanksPrefix, event), expected: null },
      ])) return { thanked: true };
    }
    throw conflict();
  }

  async route(player: string, route: string, query: unknown, body: () => unknown) {
    const parse = <T>(schema: z.ZodType<T>, input: unknown) => {
      const result = schema.safeParse(input);
      if (!result.success) throw new ApiError(400, 'INVALID_REQUEST');
      return result.data;
    };
    switch (route) {
      case 'GET /friends/help/visit': return this.visit(player, parse(visitInput, query).targetId);
      case 'POST /friends/help/repair': return this.help(player, parse(helpInput, body()));
      case 'POST /friends/help/thanks': return this.thanks(player, parse(eventInput, body()).eventId);
      case 'GET /friends/help/unread': return { entries: (await this.store.list(playerKey(player, '').PK, unreadPrefix, 20)).map(row => row.event) };
      case 'POST /friends/help/read': {
        const { eventId } = parse(eventInput, body());
        if (!await this.store.commit([{ remove: playerKey(player, unreadPrefix + eventId) }])) throw conflict();
        return { read: true };
      }
      default: throw new ApiError(404, 'ROUTE_NOT_FOUND');
    }
  }
}
