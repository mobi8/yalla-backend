import { createHash } from 'node:crypto';
import { NumberValue } from '@aws-sdk/lib-dynamodb';
import type { Principal, Save } from './model.js';

/** Initial grant only. No spend/recharge/reward API is exposed in this bundle. */
export function starterItems(save: Save, principal: Principal) {
  const { profile, wallet } = save;
  const operationId = `starter#${profile.playerId}`, causeKey = operationId;
  const balancesBefore = { energy: 0, diamond: 0, yallaPoint: 0 };
  const balancesAfter = { energy: wallet.energy, diamond: wallet.diamond, yallaPoint: wallet.yallaPoint };
  if (wallet.energy !== 50 || wallet.diamond !== 0 || wallet.yallaPoint !== 0 || wallet.version !== 1)
    throw new Error('Starter must use the documented initial balances');
  const requestHash = createHash('sha256').update(JSON.stringify({ provider: principal.provider,
    subject: principal.subject, operationType: 'starter', balancesAfter })).digest('hex');
  const PK = `PLAYER#${profile.playerId}`;
  const metadata = { schemaVersion: 1, version: 1, updatedAt: profile.createdAt };
  return [
    { PK, SK: 'WALLET', ...wallet, energyRechargeAnchor: NumberValue.from(wallet.energyRechargeAnchor),
      energyRechargeHighWater: NumberValue.from(wallet.energyRechargeHighWater) },
    { PK, SK: `ECONOMY#OP#${operationId}`, ...metadata, operationId, operationType: 'starter', requestHash,
      causeKey, configVersion: 'starter-v1', deltas: balancesAfter, balancesBefore, balancesAfter,
      walletVersionAfter: 1, result: { playerId: profile.playerId, balances: balancesAfter }, committedAt: profile.createdAt },
    { PK, SK: `ECONOMY#CAUSE#${causeKey}`, ...metadata, operationId, requestHash },
  ] as const;
}
