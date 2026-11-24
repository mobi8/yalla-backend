import { z } from 'zod';

export const bingoEvents = ['Play', 'RedMatch', 'BlueMatch', 'Multiplier', 'Attack', 'Upgrade', 'JourneyChest', 'Jackpot', 'Raid'] as const;
export type BingoEvent = typeof bingoEvents[number];
const count = z.number().int().min(1).max(10000);
const asset = z.string().regex(/^bingo_ui_icon_[a-z_]+$/);
const currency = z.enum(['YallaPoint', 'Energy', 'Gold', 'Clover', 'CostumePoint']);
const item = z.strictObject({ rewardType: currency, rewardAmount: count });
const display = {
  rewardId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  displayName: z.string().min(1).max(32),
  icon: asset,
  requiredLines: count.max(8),
};
export const bingoConfigSchema = z.strictObject({
  missions: z.array(z.strictObject({
    missionId: z.enum(bingoEvents), displayName: z.string().min(1).max(32), icon: asset,
    eventType: z.enum(bingoEvents), requiredCount: count, gridPosition: z.number().int().min(0).max(8),
    minimumMultiplier: count.optional(),
  })).length(9),
  rewards: z.array(z.discriminatedUnion('presentationType', [
    z.strictObject({ ...display, presentationType: z.literal('Currency'), ...item.shape }),
    z.strictObject({ ...display, presentationType: z.literal('JourneyChest'),
      rewardType: z.literal('JourneyChest'), rewardAmount: count.max(20) }),
    z.strictObject({ ...display, presentationType: z.literal('BingoBox'), rewardType: z.literal('BingoBox'),
      rewardAmount: count.max(20), rewardItems: z.array(item).min(1).max(4) }),
  ])).length(4),
}).refine(({ missions, rewards }) => new Set(missions.map(m => m.missionId)).size === 9 &&
  new Set(missions.map(m => m.gridPosition)).size === 9 &&
  missions.every(m => m.eventType === 'Multiplier' || m.minimumMultiplier === undefined) &&
  new Set(rewards.map(r => r.rewardId)).size === 4 &&
  new Set(rewards.map(r => r.requiredLines)).size === 4, 'Invalid bingo mission or reward configuration');
