import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from './repository.js';
import { worldConfigSchema,worldBuildingsSchema,worldRewardsSchema } from './world-config.js';
import { bingoConfigSchema } from './bingo-config.js';
import { decimalString } from './model.js';
const amount = z.number().int().min(0).max(2147483647), positive = amount.min(1);
const botIds = ['player_1001','player_1002','player_1003','player_1005','player_1006','player_1007'] as const;
const letter = (y: number, al: number) => z.strictObject({ Y: positive.max(y), A: positive.max(al), L: positive.max(al) });
export const collectionConfigSchema = z.strictObject({
  crown: z.strictObject({ required: positive.max(3), rewardType: z.literal('JackpotTicket'), rewardAmount: positive,
    maximumTickets: amount, overflow: z.literal('REJECT') }),
  yalla: z.strictObject({ required: z.strictObject({Y:z.literal(1),A:z.literal(2),L:z.literal(2)}), maximumLetters: letter(5, 10), rewardType: z.literal('RaidTicket'),
    rewardAmount: z.literal(1), maximumTickets: amount, overflow: z.literal('DISCARD_LETTERS') }),
  star: z.strictObject({ required: positive.max(5), rewardType: z.literal('Energy'), rewardAmount: amount }),
  camel: z.strictObject({ required: positive.max(5), rewardType: z.literal('Shield'), rewardAmount: positive.max(3),
    maximumShields: amount.max(3), overflowRewardType: z.literal('Energy'), overflowRewardAmount: amount }),
}).refine(v => ['Y','A','L'].every(k => v.yalla.required[k as 'Y'] <= v.yalla.maximumLetters[k as 'Y']), 'Letter requirement exceeds capacity');
const journeyBase = { distancePerChest: decimalString.refine(v => /[1-9]/.test(v)), repeat: z.enum(['REPEATING','ONCE']) };
export const journeyConfigSchema = z.union([
  z.strictObject({ ...journeyBase, rewardType: z.enum(['Energy', 'YallaPoint']), rewardAmount: amount }),
  z.strictObject({ ...journeyBase, rewards: z.array(z.strictObject({ rewardType: z.enum(['Energy', 'YallaPoint']),
    rewardAmount: positive, weight: positive.max(10000) })).min(1).max(100) })
    .refine(v => v.rewards.reduce((sum, reward) => sum + reward.weight, 0) === 10000, 'Journey weights must sum to 10000'),
]);
export const jackpotConfigSchema = z.strictObject({ ticketCost: z.literal(1), weights: z.array(amount.max(10000)).length(6),
  rewards: z.array(amount).length(6), rewardType: z.literal('YallaPoint') })
  .refine(v => v.weights.reduce((a,b) => a+b,0) === 10000, 'Jackpot weights must sum to 10000');
export const raidConfigSchema = z.strictObject({ ticketCost: z.literal(1), multiplier: positive, shieldMaximum: amount.max(3),
  attackWeight: amount.max(10000).optional(),
  bags: z.strictObject({count: positive.max(12), winners: positive.max(12), picks: positive.max(12),
    minGold: positive, maxGold: positive, goldCap: positive, costumePointPerWin: amount})
    .refine(b => b.winners <= b.count && b.picks <= b.count && b.minGold <= b.maxGold, 'Invalid RAID bag rules').optional(),
  costumePrices: z.record(z.string().regex(/^[a-z0-9_-]{1,100}$/), positive).optional(),
  initialFacilityLevels: z.array(positive.max(5)).length(5), initialShieldCounts: z.array(amount.max(3)).length(6),
  eligibleUpgradeCost: positive, levelSource: z.literal('CONFIG_INITIAL'), shieldRule: z.literal('CONSUME_ONE_BLOCK_ALL'),
  botTemplates: z.array(z.strictObject({ id: z.enum(botIds), avatarId: z.string().regex(/^[a-f0-9]{32}$/) })).length(6),
}).refine(v => new Set(v.botTemplates.map(b => b.id)).size === 6 && v.initialShieldCounts.every(s => s <= v.shieldMaximum), 'Invalid bot profiles/shields');
export const configSchemas = { bingo: bingoConfigSchema, world:worldConfigSchema, 'world-buildings':worldBuildingsSchema, 'world-rewards':worldRewardsSchema, collection: collectionConfigSchema, journey: journeyConfigSchema, jackpot: jackpotConfigSchema, raid: raidConfigSchema };
export type ConfigName = keyof typeof configSchemas;
export type ConfigData = { [K in ConfigName]: z.infer<typeof configSchemas[K]> };
export interface GameConfig<K extends ConfigName> { schemaVersion: 1; environment: string; version: string; contentHash: string; data: ConfigData[K] }
export interface ConfigSource { load<K extends ConfigName>(name: K): Promise<GameConfig<K>> }
export function parseConfig<K extends ConfigName>(name: K, text: string, environment: string): GameConfig<K> {
  const parsed = z.strictObject({ schemaVersion: z.literal(1), environment: z.literal(environment),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/), data: configSchemas[name] }).parse(JSON.parse(text));
  return { ...parsed, contentHash: createHash('sha256').update(text).digest('hex') } as GameConfig<K>;
}
export class GameConfigs implements ConfigSource {
  private cache = new Map<ConfigName, { value: GameConfig<any>; expires: number }>();
  private loading = new Map<ConfigName, Promise<GameConfig<any>>>();
  constructor(private s3 = new S3Client({}), private bucket = process.env.GAME_CONFIG_BUCKET ?? '',
    private environment = process.env.ENVIRONMENT ?? '', private clock = Date.now) {}
  async load<K extends ConfigName>(name: K): Promise<GameConfig<K>> {
    if (!['dev','staging','prod'].includes(this.environment) || !this.bucket) throw new ApiError(503, 'GAME_CONFIG_NOT_CONFIGURED');
    const cached = this.cache.get(name); if (cached && cached.expires > this.clock()) return structuredClone(cached.value);
    let pending = this.loading.get(name);
    if (!pending) { pending = this.read(name).finally(() => this.loading.delete(name)); this.loading.set(name, pending); }
    return structuredClone(await pending);
  }
  private async read<K extends ConfigName>(name: K): Promise<GameConfig<K>> {
    const key = `game-config/${this.environment}/v1/${name}.json`;
    let text: string;
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!object.Body || !object.ContentLength || object.ContentLength > 1_000_000) throw new Error();
      text = await object.Body.transformToString();
    } catch { throw new ApiError(503, 'GAME_CONFIG_UNAVAILABLE'); }
    let value: GameConfig<K>;
    try { value = parseConfig(name, text, this.environment); }
    catch { console.error(JSON.stringify({ event: 'GAME_CONFIG_INVALID', key })); throw new ApiError(503, 'GAME_CONFIG_INVALID'); }
    this.cache.set(name, { value, expires: this.clock() + 60000 }); return value;
  }
}
