import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

export const DEV_RAID_PLAYER = 'd73ac596-a7b2-48dc-b5cf-c6af3c42fcf1';
const botIds = ['player_1001','player_1002','player_1003','player_1005','player_1006','player_1007','player_1008','player_1009','player_1010','player_1011'] as const;
const weightsSchema = z.number().int().min(0).max(1000000);
const bps = z.number().int().min(0).max(10000);
const walletRaidSchema = z.strictObject({
  enabled: z.boolean(),
  protectedBalanceBps: bps,
  minimumTargetYP: z.number().int().min(0).max(2147483647).optional(),
  bagWeightsBps: z.tuple([bps.positive(), bps.positive(), bps.positive(), z.literal(0), z.literal(0)]).optional(),
}).refine(raid => (!raid.enabled || raid.bagWeightsBps !== undefined) &&
  (raid.bagWeightsBps?.reduce((sum, weight) => sum + weight, 0) ?? 0) <= 10000 - raid.protectedBalanceBps);

const offlinePolicySchema = z.strictObject({
  scheduleMinutes: z.number().int().min(1).max(1440),
  offlineMinMinutes: z.number().int().min(0),
  offlineMaxHours: z.number().int().min(1).max(168),
  perPlayerCooldownMinutes: z.number().int().min(0),
  dailyLimit: z.number().int().positive().nullable(),
  attackRaidWeights: z.strictObject({
    ATTACK: weightsSchema,
    RAID: weightsSchema,
  }).optional(),
  walletRaid: walletRaidSchema.optional(),
}).refine(policy => policy.offlineMinMinutes < policy.offlineMaxHours * 60 &&
  (!policy.attackRaidWeights?.RAID || policy.walletRaid?.enabled === true));

export const botsSchema = z.strictObject({ version:z.literal(1), offlinePolicy:offlinePolicySchema.optional(), devFastMode:z.literal(true).optional(), incomingRaid:z.strictObject({
  enabled:z.boolean(), targetOffline:z.literal(true).optional(), averageAttacksPerDay:z.number().finite().min(1).max(3), maximumAttacksPerDay:z.number().int().min(1).max(3),
  shieldConsumption:z.literal(1), allowedPlayerIds:z.array(z.string().min(1).max(160)).max(100) }),
  shield:z.strictObject({maximum:z.literal(3),regenHours:z.number().int().min(1).max(8760)}),
  bots:z.array(z.strictObject({id:z.enum(botIds),avatarId:z.string().regex(/^[a-f0-9]{32}$/),attackEnabled:z.boolean(),defenseEnabled:z.boolean()})).length(10)
}).refine(v=>(!v.offlinePolicy || (v.incomingRaid.targetOffline && !v.devFastMode)) && (!v.incomingRaid.targetOffline || v.offlinePolicy || !v.incomingRaid.allowedPlayerIds.length) && new Set(v.bots.map(b=>b.id)).size===10 && v.incomingRaid.averageAttacksPerDay<=v.incomingRaid.maximumAttacksPerDay && (!v.incomingRaid.enabled || v.bots.some(b=>b.attackEnabled)));
export type BotsConfig = z.infer<typeof botsSchema>;
export const DEFAULT_BOTS: BotsConfig = {"version":1,"incomingRaid":{"enabled":false,"averageAttacksPerDay":2.5,"maximumAttacksPerDay":3,"shieldConsumption":1,"allowedPlayerIds":[]},"shield":{"maximum":3,"regenHours":3},"bots":[{"id":"player_1001","avatarId":"1914377d7b894820acd70169db0c7f5d","attackEnabled":true,"defenseEnabled":true},{"id":"player_1002","avatarId":"3c885d9cccbf4b919b2a33f1f888ea4b","attackEnabled":true,"defenseEnabled":true},{"id":"player_1003","avatarId":"04c7662389e4465e83cab8997e0de696","attackEnabled":true,"defenseEnabled":true},{"id":"player_1005","avatarId":"d0cc4f5e972e4d7fb228f8d0b59affcc","attackEnabled":true,"defenseEnabled":true},{"id":"player_1006","avatarId":"721e172b07fb4d1cb7718a2061bca2ba","attackEnabled":true,"defenseEnabled":true},{"id":"player_1007","avatarId":"ede370ced3294d71ae386fe138bc2c32","attackEnabled":true,"defenseEnabled":true},{"id":"player_1008","avatarId":"1914377d7b894820acd70169db0c7f5d","attackEnabled":true,"defenseEnabled":true},{"id":"player_1009","avatarId":"3c885d9cccbf4b919b2a33f1f888ea4b","attackEnabled":false,"defenseEnabled":true},{"id":"player_1010","avatarId":"04c7662389e4465e83cab8997e0de696","attackEnabled":false,"defenseEnabled":true},{"id":"player_1011","avatarId":"d0cc4f5e972e4d7fb228f8d0b59affcc","attackEnabled":false,"defenseEnabled":true}]};
export interface BotsSource { load():Promise<BotsConfig> }

// Fail closed on a cold start; a warm instance retains the last validated config.
export class BotsConfigs implements BotsSource {
  private last: BotsConfig = structuredClone(DEFAULT_BOTS); private expires=0; private pending?:Promise<BotsConfig | undefined>;
  constructor(private s3=new S3Client({}),private bucket=process.env.GAME_CONFIG_BUCKET??'',private environment=process.env.ENVIRONMENT??'',private clock=Date.now) {}
  async load():Promise<BotsConfig> {
    if(this.clock()>=this.expires) {
      if(!this.pending) this.pending=this.refresh().finally(()=>{this.pending=undefined;});
      await this.pending;
    }
    return structuredClone(this.last);
  }
  private async refresh() {
    try {
      if(!this.bucket || !['dev','staging','prod'].includes(this.environment)) throw Error();
      const object=await this.s3.send(new GetObjectCommand({Bucket:this.bucket,Key:`game-config/${this.environment}/v1/bots.json`}));
      if(!object.Body || !object.ContentLength || object.ContentLength>100000) throw Error();
      const config = botsSchema.parse(JSON.parse(await object.Body.transformToString()));
      if (this.environment === 'dev' && config.incomingRaid.enabled && !config.incomingRaid.targetOffline &&
          (config.incomingRaid.allowedPlayerIds.length !== 1 || config.incomingRaid.allowedPlayerIds[0] !== DEV_RAID_PLAYER)) throw Error();
      if (config.offlinePolicy && this.environment !== 'dev') throw Error();
      if (config.devFastMode && (this.environment !== 'dev' ||
          config.bots.filter(bot => bot.attackEnabled).map(bot => bot.id).join() !== 'player_1001')) throw Error();
      this.last = config;
    } catch { console.warn(JSON.stringify({event:'BOTS_CONFIG_UNAVAILABLE'})); }
    this.expires=this.clock()+60000; return this.last;
  }
}
