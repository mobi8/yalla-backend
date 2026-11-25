import { z } from 'zod';

const basisPoints = z.number().int().min(0).max(5000);
const bagWeightsSchema = z.tuple([basisPoints, basisPoints, basisPoints, basisPoints, basisPoints])
  .refine(weights => weights.some(weight => weight > 0) && weights.reduce((total, weight) => total + weight, 0) <= 5000);

export function loadPlayerWalletRaidPolicy() {
  return {
    bagWeightsBps: bagWeightsSchema.parse((process.env.PLAYER_RAID_BAG_WEIGHTS_BPS ?? '0,2000,1000,0,0')
      .split(',').map(value => value.trim() === '' ? NaN : Number(value))),
    protectedBalanceBps: 5000,
    minimumTargetYP: 100,
    cooldownMs: 60 * 60_000,
  };
}
