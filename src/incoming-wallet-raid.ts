import { randomInt } from 'node:crypto';

export const WALLET_RAID_PREFIX = 'INCOMING#WALLET_RAID#';

export function startWalletRaid(startYP: number, bagWeightsBps: readonly number[], roll = randomInt) {
  const bags = bagWeightsBps.map(weight => Math.floor(startYP * weight / 10000));
  for (let i = bags.length - 1; i > 0; i--) {
    const j = roll(i + 1);
    [bags[i], bags[j]] = [bags[j]!, bags[i]!];
  }
  const remaining = bags.map((_, i) => i);
  const picks = Array.from({length: 3}, () => {
    const [bagId] = remaining.splice(roll(remaining.length), 1);
    return {bagId: bagId!, amount: bags[bagId!]!};
  });
  return {startYP, bags, picks, selectedYP: picks.reduce((sum, pick) => sum + pick.amount, 0)};
}

export function walletRaidDebit(selectedYP: number, currentYP: number, protectedBalanceBps: number) {
  return Math.min(selectedYP, Math.floor(currentYP * (10000 - protectedBalanceBps) / 10000));
}
