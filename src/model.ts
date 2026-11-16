import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const worlds = ['dunes', 'canyon', 'oasis', 'bazaar', 'palace', 'nightcity', 'goldentemple'] as const;
const int = z.number().int().min(0).max(2147483647);
// C# long and decimal must never pass through a JavaScript Number.
export const longString = z.string().regex(/^(0|[1-9]\d*)$/).refine(v =>
  /^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const decimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,28})?$/).refine(v => {
  if (!/^(0|[1-9]\d*)(\.\d{1,28})?$/.test(v)) return false;
  const [whole, fraction = ''] = v.split('.');
  return BigInt(whole! + fraction.replace(/0+$/, '')) <= 79228162514264337593543950335n;
});
const state = { schemaVersion: z.literal(1), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), updatedAt: z.iso.datetime() };
export const profileSchema = z.strictObject({
  ...state, playerId: z.string().uuid(), accountType: z.literal('guest'),
  nickname: z.string().min(1), avatarId: z.string().min(1), createdAt: z.iso.datetime(),
  // Only new accounts are implemented. Importing/complete policies need a migration contract.
  migrationState: z.literal('new'),
});
export const progressSchema = z.strictObject({
  ...state, worldId: z.enum(worlds), village: z.number().int().min(1).max(5),
  facilityLevels: z.array(z.number().int().min(1).max(5)).length(5),
  worldRunId: z.string().min(1), worldRunComplete: z.boolean(),
  worldCompletionCounts: z.partialRecord(z.enum(worlds), int),
  highestUnlockedWorld: z.number().int().min(0).max(6),
  distance: decimalString, lastDistanceMilestone: longString, constructionStars: longString,
}).superRefine((p, ctx) => {
  if (p.highestUnlockedWorld < worlds.indexOf(p.worldId)) ctx.addIssue({ code: 'custom', message: 'World is locked' });
  if (p.worldRunComplete && (p.facilityLevels.some(v => v !== 5) || !(p.worldCompletionCounts[p.worldId]! > 0)))
    ctx.addIssue({ code: 'custom', message: 'Invalid completed World checkpoint' });
});
export type Profile = z.infer<typeof profileSchema>;
export type Progress = z.infer<typeof progressSchema>;
export const walletSchema = z.strictObject({ ...state, energy: int, diamond: int, yallaPoint: int,
  energyRechargeAnchor: longString, energyRechargeHighWater: longString });
export type Wallet = z.infer<typeof walletSchema>;
export interface Save { profile: Profile; progress: Progress; wallet: Wallet }
export interface Principal { provider: 'guest' | 'apple' | 'google'; subject: string }
export function newSave(now = new Date().toISOString(), uuid: () => string = randomUUID): Save {
  const metadata = { schemaVersion: 1 as const, version: 1, updatedAt: now };
  return {
    profile: profileSchema.parse({ ...metadata, playerId: uuid(), accountType: 'guest', nickname: 'YOU',
      avatarId: 'ae6a6b0db4994642a1b45102daa825bd', createdAt: now, migrationState: 'new' }),
    progress: progressSchema.parse({ ...metadata, worldId: 'dunes', village: 1, facilityLevels: [1, 1, 1, 1, 1],
      worldRunId: 'legacy:dunes', worldRunComplete: false, worldCompletionCounts: {}, highestUnlockedWorld: 0,
      distance: '0', lastDistanceMilestone: '0', constructionStars: '0' }),
    wallet: walletSchema.parse({ ...metadata, energy: 200, diamond: 20000, yallaPoint: 0,
      energyRechargeAnchor: '0', energyRechargeHighWater: String(Math.max(1, Math.floor(Date.parse(now) / 1000))) }),
  };
}
