import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { walletSchema, progressSchema, type Wallet, type Progress } from './model.js';
import type { ConfigData } from './game-config.js';
import type { Outcome } from './pools.js';
export const collectionSchema = z.strictObject({ schemaVersion: z.literal(1), version: z.number().int().positive(), updatedAt: z.string(),
  crownProgress: z.number().int().min(0).max(2), yallaYCount: z.number().int().min(0).max(5),
  yallaACount: z.number().int().min(0).max(10), yallaLCount: z.number().int().min(0).max(10),
  starProgress: z.number().int().min(0).max(4), camelProgress: z.number().int().min(0).max(4),
  jackpotTickets: z.number().int().min(0).max(2147483647), raidTickets: z.number().int().min(0).max(2147483647), shieldCount: z.number().int().min(0).max(2147483647) });
export type Collection = z.infer<typeof collectionSchema>;
export const newCollection = (now: string): Collection => ({ schemaVersion: 1, version: 1, updatedAt: now,
  crownProgress: 0, yallaYCount: 0, yallaACount: 0, yallaLCount: 0, starProgress: 0, camelProgress: 0,
  jackpotTickets: 0, raidTickets: 0, shieldCount: 0 });
export function recharge(input: Wallet, now: number): Wallet {
  const w = structuredClone(input); let time = BigInt(Math.max(1, Math.floor(now / 1000)));
  time = time > BigInt(w.energyRechargeHighWater) ? time : BigInt(w.energyRechargeHighWater);
  let anchor = BigInt(w.energyRechargeAnchor);
  if (w.energy >= 50) anchor = 0n;
  else {
    if (anchor === 0n) anchor = time;
    if (time < anchor) time = anchor;
    const ticks = (time - anchor) / 720n;
    w.energy += Number(ticks > BigInt(50 - w.energy) ? BigInt(50 - w.energy) : ticks);
    anchor = w.energy >= 50 ? 0n : anchor + ticks * 720n;
  }
  w.energyRechargeAnchor = String(anchor); w.energyRechargeHighWater = String(time); return w;
}
export const multiplier = (prediction: string, actual: string) => prediction === actual ? actual === 'GOLD' ? 8 : 2 : 1;
const SCALE = 10n ** 28n;
export const scaled = (s: string) => { const [a, b = ''] = s.split('.'); return BigInt(a!) * SCALE + BigInt(b.padEnd(28, '0')); };
export const decimal = (n: bigint) => `${n / SCALE}.${String(n % SCALE).padStart(28, '0')}`.replace(/\.?0+$/, '');
export function settle(wallet: Wallet, progress: Progress, collection: Collection, actual: Outcome,
  prediction: string, energy: number, now: string, rules: ConfigData['collection'], journey: ConfigData['journey'],
  checkpoint?: { processedDistance: string; claimedChestCount: string }, roll: () => number = () => randomInt(10000)) {
  const w = structuredClone(wallet), p = structuredClone(progress), c = structuredClone(collection);
  const m = multiplier(prediction, actual.color), yallaPoint = 10 * m * energy;
  const distance = ({ Y: 5, A: 5, L: 5, Star: 10, Crown: 20, Camel: 30 }[actual.symbol]) * m * energy;
  p.distance = decimal(scaled(p.distance) + BigInt(distance) * SCALE);
  // Absolute processed distance, rather than a version-specific ordinal, prevents retroactive rewards on config changes.
  const step = scaled(journey.distancePerChest), before = scaled(progress.distance);
  const processed = checkpoint ? scaled(checkpoint.processedDistance) : before;
  const watermark = processed > before ? processed : before;
  const first = watermark / step + 1n;
  let count = scaled(p.distance) / step >= first ? scaled(p.distance) / step - first + 1n : 0n;
  const claimed = BigInt(checkpoint?.claimedChestCount ?? progress.lastDistanceMilestone);
  if (journey.repeat === 'ONCE') count = claimed > 0n ? 0n : count > 0n ? 1n : 0n;
  const rewards: { milestone: string; rewardType: 'Energy' | 'YallaPoint'; rewardAmount: number }[] = [];
  for (let i = 0n; i < count; i++) {
    let selected: { rewardType: 'Energy' | 'YallaPoint'; rewardAmount: number };
    if ('rewards' in journey) {
      let value = roll();
      if (!Number.isInteger(value) || value < 0 || value >= 10000) throw new Error('Invalid Journey roll');
      selected = journey.rewards.find(r => { value -= r.weight; return value < 0; })!;
    } else selected = journey;
    rewards.push({ milestone: String(first + i), rewardType: selected.rewardType, rewardAmount: selected.rewardAmount });
  }
  const distanceEnergy = rewards.reduce((sum, r) => sum + (r.rewardType === 'Energy' ? r.rewardAmount : 0), 0);
  const distanceYallaPoint = rewards.reduce((sum, r) => sum + (r.rewardType === 'YallaPoint' ? r.rewardAmount : 0), 0);
  const milestone = scaled(p.distance) / step;
  p.lastDistanceMilestone = String(milestone > BigInt(p.lastDistanceMilestone) ? milestone : BigInt(p.lastDistanceMilestone));
  let collectionEnergy = 0, jackpot = 0, raid = 0, shields = 0, overflow = 0, starCompletions = 0, camelCompletions = 0;
  switch (actual.symbol) {
    case 'Crown': jackpot = Math.floor((c.crownProgress + energy) / rules.crown.required) * rules.crown.rewardAmount; c.crownProgress = (c.crownProgress + energy) % rules.crown.required; c.jackpotTickets += jackpot; break;
    case 'Star': starCompletions = Math.floor((c.starProgress + energy) / rules.star.required); collectionEnergy = starCompletions * rules.star.rewardAmount; c.starProgress = (c.starProgress + energy) % rules.star.required; break;
    case 'Camel': {
      camelCompletions = Math.floor((c.camelProgress + energy) / rules.camel.required);
      const completions = camelCompletions * rules.camel.rewardAmount; c.camelProgress = (c.camelProgress + energy) % rules.camel.required;
      shields = Math.min(completions, Math.max(0, rules.camel.maximumShields - c.shieldCount)); c.shieldCount += shields;
      overflow = completions - shields; collectionEnergy = overflow * rules.camel.overflowRewardAmount; break;
    }
    default:
      if (actual.symbol === 'Y') c.yallaYCount = c.yallaYCount + Math.max(0, Math.min(energy, rules.yalla.maximumLetters.Y - c.yallaYCount));
      if (actual.symbol === 'A') c.yallaACount = c.yallaACount + Math.max(0, Math.min(energy, rules.yalla.maximumLetters.A - c.yallaACount));
      if (actual.symbol === 'L') c.yallaLCount = c.yallaLCount + Math.max(0, Math.min(energy, rules.yalla.maximumLetters.L - c.yallaLCount));
      { const sets = Math.min(Math.floor(c.yallaYCount / rules.yalla.required.Y), Math.floor(c.yallaACount / rules.yalla.required.A), Math.floor(c.yallaLCount / rules.yalla.required.L));
      c.yallaYCount -= sets * rules.yalla.required.Y; c.yallaACount -= sets * rules.yalla.required.A; c.yallaLCount -= sets * rules.yalla.required.L;
      raid = sets * rules.yalla.rewardAmount; c.raidTickets += raid; }
  }
  if ((c.jackpotTickets > rules.crown.maximumTickets && c.jackpotTickets > collection.jackpotTickets) || (c.raidTickets > rules.yalla.maximumTickets && c.raidTickets > collection.raidTickets)) throw new Error('Collection ticket capacity exceeded');
  w.yallaPoint += yallaPoint + distanceYallaPoint; w.energy += distanceEnergy + collectionEnergy;
  if (w.energy >= 50) w.energyRechargeAnchor = '0';
  for (const item of [w, p, c]) { item.version++; item.updatedAt = now; }
  return { wallet: walletSchema.parse(w), progress: progressSchema.parse(p), collection: collectionSchema.parse(c),
    journeyCheckpoint: { processedDistance: p.distance, claimedChestCount: String(claimed + count) },
    journeyAward: { count: String(count), firstMilestone: String(first), distancePerChest: journey.distancePerChest,
      ...('rewardType' in journey ? { rewardType: journey.rewardType, rewardAmount: journey.rewardAmount, total: distanceEnergy + distanceYallaPoint } : {}), rewards },
    reward: { yallaPoint, distanceYallaPoint, distance: String(distance), distanceEnergy, collectionEnergy, jackpotTickets: jackpot,
      raidTickets: raid, shields, overflowShields: overflow, multiplier: m, crownCompletions: jackpot / rules.crown.rewardAmount, yallaCompletions: raid / rules.yalla.rewardAmount, starCompletions, camelCompletions } };
}
