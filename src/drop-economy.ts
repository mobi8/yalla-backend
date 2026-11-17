import { z } from 'zod';
import { walletSchema, progressSchema, type Wallet, type Progress } from './model.js';
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
  prediction: string, energy: number, now: string) {
  const w = structuredClone(wallet), p = structuredClone(progress), c = structuredClone(collection);
  const m = multiplier(prediction, actual.color), yallaPoint = 10 * m * energy;
  const distance = ({ Y: 5, A: 5, L: 5, Star: 10, Crown: 20, Camel: 30 }[actual.symbol]) * m * energy;
  p.distance = decimal(scaled(p.distance) + BigInt(distance) * SCALE);
  const milestone = scaled(p.distance) / (300n * SCALE);
  const distanceEnergy = Number(milestone > BigInt(p.lastDistanceMilestone) ? milestone - BigInt(p.lastDistanceMilestone) : 0n) * 20;
  p.lastDistanceMilestone = String(milestone > BigInt(p.lastDistanceMilestone) ? milestone : BigInt(p.lastDistanceMilestone));
  let collectionEnergy = 0, jackpot = 0, raid = 0, shields = 0, overflow = 0;
  switch (actual.symbol) {
    case 'Crown': jackpot = Math.floor((c.crownProgress + energy) / 3); c.crownProgress = (c.crownProgress + energy) % 3; c.jackpotTickets += jackpot; break;
    case 'Star': collectionEnergy = Math.floor((c.starProgress + energy) / 5) * 5; c.starProgress = (c.starProgress + energy) % 5; break;
    case 'Camel': {
      const completions = Math.floor((c.camelProgress + energy) / 5); c.camelProgress = (c.camelProgress + energy) % 5;
      shields = Math.min(completions, Math.max(0, 3 - c.shieldCount)); c.shieldCount += shields;
      overflow = completions - shields; collectionEnergy = overflow * 3; break;
    }
    default:
      if (actual.symbol === 'Y') c.yallaYCount = Math.min(5, c.yallaYCount + energy);
      if (actual.symbol === 'A') c.yallaACount = Math.min(10, c.yallaACount + energy);
      if (actual.symbol === 'L') c.yallaLCount = Math.min(10, c.yallaLCount + energy);
      raid = Math.min(c.yallaYCount, Math.floor(c.yallaACount / 2), Math.floor(c.yallaLCount / 2));
      c.yallaYCount -= raid; c.yallaACount -= raid * 2; c.yallaLCount -= raid * 2; c.raidTickets += raid;
  }
  w.yallaPoint += yallaPoint; w.energy += distanceEnergy + collectionEnergy;
  if (w.energy >= 50) w.energyRechargeAnchor = '0';
  for (const item of [w, p, c]) { item.version++; item.updatedAt = now; }
  return { wallet: walletSchema.parse(w), progress: progressSchema.parse(p), collection: collectionSchema.parse(c),
    reward: { yallaPoint, distance: String(distance), distanceEnergy, collectionEnergy, jackpotTickets: jackpot,
      raidTickets: raid, shields, overflowShields: overflow, multiplier: m } };
}
