import { createHash, randomInt, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, QueryCommand, NumberValue } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { GameConfigs, type ConfigSource, type GameConfig } from './game-config.js';
import { ApiError, createDynamoRepository, playerKey, type PlayerRepository } from './repository.js';
import type { Principal, Save, Wallet, Progress } from './model.js';
import { ResultPools, color, outcomeSchema, type AssignedSet, type Outcome, type PoolSource } from './pools.js';
import { collectionSchema, newCollection, recharge, settle, multiplier, type Collection } from './drop-economy.js';
export const requestId = z.string().uuid();
export const beginSchema = z.strictObject({ requestId, prediction: color, energyCost: z.number().int().min(1).max(3) });
export const resultSchema = z.strictObject({ requestId, actual: outcomeSchema, physicsVersion: z.string().min(1).max(128) });
export const cancelSchema = z.strictObject({ requestId, reason: z.literal('PHYSICS_TIMEOUT') });
export interface Session { schemaVersion: 1; version: number; updatedAt: string; sessionId: string; mode: 'ENERGY_DROP';
  status: 'ACTIVE'; nextRound: number; completedRounds: number; pendingRoundId: string | null; recentConfirmedResults?: { round: number; color: string; symbol: string }[] }
export interface Round extends AssignedSet { schemaVersion: 1; version: number; updatedAt: string; sessionId: string; roundId: string;
  roundNumber: number; status: 'ISSUED' | 'SETTLED' | 'CANCELLED'; prediction: z.infer<typeof color>; energyCost: number;
  multiplier: number; collectionConfig?: GameConfig<'collection'>; journeyConfig?: GameConfig<'journey'>; issuedAt: string; cancelAfter: string; policy: 'PERMISSIVE';
  actual?: Outcome; actualPhysicsVersion?: string; matchStatus?: string; reward?: ReturnType<typeof settle>['reward']; settledAt?: string }
type Item = Record<string, any>;
export interface Write { sk: string; value: Item; expectedVersion?: number }
export interface DropStore { get(player: string, sk: string): Promise<Item | undefined>; commit(player: string, writes: Write[]): Promise<void> }
export class DynamoDropStore implements DropStore {
  constructor(private client: DynamoDBDocumentClient, private table: string) {}
  async get(player: string, sk: string) {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: playerKey(player, sk), ConsistentRead: true }));
    if (!Item) return undefined; const { PK, SK, ...value } = Item; return value;
  }
  async list(player: string, prefix: string, newestLimit?: number): Promise<Item[]> {
    const items: Item[] = []; let cursor: Record<string, any> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `PLAYER#${player}`, ':sk': prefix },
        ConsistentRead: true, ExclusiveStartKey: cursor, ...(newestLimit ? { ScanIndexForward: false, Limit: newestLimit-items.length } : {}) }));
      for (const { PK, SK, ...value } of result.Items ?? []) items.push({ ...value, _key: SK });
      cursor = result.LastEvaluatedKey;
    } while (cursor && (!newestLimit || items.length < newestLimit));
    return items;
  }
  async commit(player: string, writes: Write[]) {
    await this.client.send(new TransactWriteCommand({ TransactItems: writes.map(w => {
      const value = { ...w.value };
      for (const k of w.sk === 'WALLET' ? ['energyRechargeAnchor', 'energyRechargeHighWater'] :
        w.sk === 'PROGRESS' ? ['distance', 'lastDistanceMilestone', 'constructionStars'] : []) value[k] = NumberValue.from(value[k]);
      return { Put: { TableName: this.table, Item: { ...playerKey(player, w.sk), ...value },
        ConditionExpression: w.expectedVersion === undefined ? 'attribute_not_exists(PK)' : '#v = :v',
        ...(w.expectedVersion === undefined ? {} : { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': w.expectedVersion } }) } };
    }) }));
  }
}
const sameOutcome = (a: Outcome | undefined, b: Outcome) => !!a && a.ball === b.ball && a.color === b.color && a.symbol === b.symbol;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const conflict = (e: unknown) => e instanceof Error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(e.name);
export class DropService {
  constructor(private players: PlayerRepository, private db: DropStore, private pools: PoolSource,
    private clock = Date.now, private uuid = randomUUID, private configs: ConfigSource = new GameConfigs(),
    private rollEvent = () => randomInt(10000)) {}
  private async owner(principal: Principal) {
    const id = await this.players.find(principal); if (!id) throw new ApiError(404, 'PLAYER_NOT_FOUND'); return id;
  }
  private async retry<T>(action: () => Promise<T>): Promise<T> {
    for (let i = 0; i < 5; i++) { try { return await action(); } catch (e) { if (!conflict(e)) throw e; } }
    throw new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');
  }
  private async session(player: string, id?: string): Promise<Session | undefined> {
    const active = await this.db.get(player, 'SESSION#ACTIVE');
    if (!active || (id && id !== active.sessionId)) { if (id) throw new ApiError(404, 'SESSION_NOT_FOUND'); return undefined; }
    return await this.db.get(player, `SESSION#${active.sessionId}`) as Session | undefined;
  }
  private receipt(type: string, id: string, cause: string, before: Wallet, after: Wallet, result: unknown, requestHash: string, now: string): Write[] {
    const value = { schemaVersion: 1, version: 1, updatedAt: now, operationId: id, operationType: type, causeKey: cause,
      requestHash, configVersion: 'energy-drop-v1:collection-v3', committedAt: now,
      deltas: { energy: after.energy - before.energy, yallaPoint: after.yallaPoint - before.yallaPoint, diamond: 0 },
      balancesBefore: before, balancesAfter: after, walletVersionAfter: after.version, result };
    return [{ sk: `ECONOMY#OP#${id}`, value }, { sk: `ECONOMY#CAUSE#${cause}`, value: { operationId: id, requestHash } }];
  }
  private async snapshot(player: string, _session: Session | undefined) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const s = await this.session(player);
      const save = await this.players.read(player); if (!save) throw new ApiError(404, 'PLAYER_NOT_FOUND');
      const collection = await this.db.get(player, 'COLLECTION');
      const round = s?.pendingRoundId ? await this.db.get(player, `ROUND#${s.pendingRoundId}`) : null;
      const after = await this.session(player);
      // Every issue/settle/cancel changes this version. Never pair a stale issued Round with a settled Wallet.
      if (s?.version !== after?.version || s?.sessionId !== after?.sessionId) continue;
      return { session: s ?? null, round: round ?? null, save, collection: collection ?? null, serverTime: new Date(this.clock()).toISOString() };
    }
    throw new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');
  }
  async active(principal: Principal) {
    const player = await this.owner(principal);
    return this.retry(async () => {
      const save = (await this.players.read(player))!, nowMs = this.clock(), now = new Date(nowMs).toISOString();
      const w = recharge(save.wallet, nowMs);
      if (JSON.stringify(w) !== JSON.stringify(save.wallet)) {
        w.version++; w.updatedAt = now;
        const writes: Write[] = [{ sk: 'WALLET', value: w, expectedVersion: save.wallet.version }];
        if (w.energy !== save.wallet.energy) writes.push(...this.receipt('recharge', `recharge:${w.version}`, `recharge:${w.version}`, save.wallet, w, {}, hash({ now }), now));
        await this.db.commit(player, writes);
      }
      return this.snapshot(player, await this.session(player));
    });
  }
  async open(principal: Principal) {
    const player = await this.owner(principal);
    await this.retry(async () => {
      if (await this.session(player)) return;
      const now = new Date(this.clock()).toISOString(), sessionId = this.uuid();
      const session: Session = { schemaVersion: 1, version: 1, updatedAt: now, sessionId, mode: 'ENERGY_DROP', status: 'ACTIVE',
        nextRound: 1, completedRounds: 0, pendingRoundId: null };
      const writes: Write[] = [{ sk: 'SESSION#ACTIVE', value: { sessionId, schemaVersion: 1, version: 1, updatedAt: now } },
        { sk: `SESSION#${sessionId}`, value: session }];
      if (!await this.db.get(player, 'COLLECTION')) writes.push({ sk: 'COLLECTION', value: newCollection(now) });
      await this.db.commit(player, writes);
    });
    return this.active(principal);
  }
  async round(principal: Principal, sessionId: string, roundId: string) {
    const player = await this.owner(principal); await this.session(player, sessionId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.snapshot(player, await this.session(player, sessionId));
      const round = await this.db.get(player, `ROUND#${roundId}`);
      if (!round || round.sessionId !== sessionId) throw new ApiError(404, 'ROUND_NOT_FOUND');
      const after = await this.session(player, sessionId);
      if (after?.version !== snapshot.session?.version) continue;
      return { ...snapshot, round };
    }
    throw new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');
  }
  async begin(principal: Principal, sessionId: string, input: z.infer<typeof beginSchema>) {
    if (process.env.ENVIRONMENT !== 'dev' || process.env.RESULT_POLICY !== 'PERMISSIVE') throw new ApiError(503, 'RESULT_POLICY_DISABLED');
    const player = await this.owner(principal), requestHash = hash({ sessionId, ...input });
    const marker = `DROP#REQUEST#${input.requestId}`;
    return this.retry(async () => {
      const previous = await this.db.get(player, marker);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
        return this.round(principal, sessionId, previous.roundId);
      }
      const s = (await this.session(player, sessionId))!;
      if (s.pendingRoundId) throw new ApiError(409, 'ROUND_PENDING');
      if ((await this.db.get(player, 'BONUS#STATE'))?.run) throw new ApiError(409, 'BONUS_ACTIVE');
      const save = (await this.players.read(player))!, nowMs = this.clock(), now = new Date(nowMs).toISOString();
      const w = recharge(save.wallet, nowMs);
      if (w.energy < input.energyCost) throw new ApiError(409, 'INSUFFICIENT_ENERGY');
      w.energy -= input.energyCost;
      if (w.energy < 50 && w.energyRechargeAnchor === '0') w.energyRechargeAnchor = w.energyRechargeHighWater;
      w.version++; w.updatedAt = now;
      const [assigned, collectionConfig, journeyConfig] = await Promise.all([this.pools.pick(), this.configs.load('collection'), this.configs.load('journey')]);
      const roundId = this.uuid();
      const r: Round = { ...assigned, collectionConfig, journeyConfig, schemaVersion: 1, version: 1, updatedAt: now, sessionId, roundId, roundNumber: s.nextRound,
        status: 'ISSUED', prediction: input.prediction, energyCost: input.energyCost, multiplier: multiplier(input.prediction, assigned.expected.color),
        issuedAt: now, cancelAfter: new Date(nowMs + 120_000).toISOString(), policy: 'PERMISSIVE' };
      const next = { ...s, pendingRoundId: roundId, version: s.version + 1, updatedAt: now };
      await this.db.commit(player, [{ sk: 'WALLET', value: w, expectedVersion: save.wallet.version },
        { sk: `SESSION#${sessionId}`, value: next, expectedVersion: s.version }, { sk: `ROUND#${roundId}`, value: r },
        { sk: marker, value: { requestHash, roundId } },
        ...this.receipt('drop-start', `start:${roundId}`, `start:${roundId}`, save.wallet, w,
          { roundId, energyCost: input.energyCost, rechargeEnergy: w.energy + input.energyCost - save.wallet.energy }, requestHash, now)]);
      return this.round(principal, sessionId, roundId);
    });
  }
  async submit(principal: Principal, sessionId: string, roundId: string, input: z.infer<typeof resultSchema>) {
    if (process.env.ENVIRONMENT !== 'dev' || process.env.RESULT_POLICY !== 'PERMISSIVE') throw new ApiError(503, 'RESULT_POLICY_DISABLED');
    const player = await this.owner(principal);
    return this.retry(async () => {
      const s = (await this.session(player, sessionId))!, r = await this.db.get(player, `ROUND#${roundId}`) as Round | undefined;
      if (!r || r.sessionId !== sessionId) throw new ApiError(404, 'ROUND_NOT_FOUND');
      if (r.status === 'CANCELLED') throw new ApiError(409, 'ROUND_CANCELLED');
      if (r.status === 'SETTLED') {
        if (!sameOutcome(r.actual, input.actual) || r.actualPhysicsVersion !== input.physicsVersion) throw new ApiError(409, 'RESULT_CONFLICT');
        return this.round(principal, sessionId, roundId);
      }
      if (s.pendingRoundId !== roundId) throw new ApiError(409, 'ROUND_NOT_PENDING');
      const save = (await this.players.read(player))!, nowMs = this.clock(), now = new Date(nowMs).toISOString();
      const oldCollection = collectionSchema.parse(await this.db.get(player, 'COLLECTION'));
      const collectionConfig = r.collectionConfig ?? await this.configs.load('collection');
      const journeyConfig = r.journeyConfig ?? await this.configs.load('journey');
      const chestState = await this.db.get(player, 'JOURNEY#CHESTS');
      const result = settle(recharge(save.wallet, nowMs), save.progress, oldCollection, input.actual, r.prediction, r.energyCost, now,
        collectionConfig.data, journeyConfig.data, chestState as { processedDistance: string; claimedChestCount: string } | undefined);
      // The complete expected/actual triple is retained even when physicsVersion differs.
      const matchStatus = sameOutcome(r.expected, input.actual) && r.physicsVersion === input.physicsVersion ? 'MATCH' : 'MISMATCH';
      const next: Round & { journeyAward: typeof result.journeyAward } = { ...r, status: 'SETTLED', actual: input.actual, actualPhysicsVersion: input.physicsVersion, matchStatus,
        reward: result.reward, collectionConfig, journeyConfig, journeyAward: result.journeyAward, settledAt: now, version: r.version + 1, updatedAt: now };
      const writes: Write[] = [{ sk: 'WALLET', value: result.wallet, expectedVersion: save.wallet.version },
        { sk: 'PROGRESS', value: result.progress, expectedVersion: save.progress.version },
        { sk: 'JOURNEY#CHESTS', value: { ...result.journeyCheckpoint, schemaVersion: 1, version: (chestState?.version ?? 0) + 1,
          updatedAt: now, configVersion: journeyConfig.version, configHash: journeyConfig.contentHash }, expectedVersion: chestState?.version },
        { sk: 'COLLECTION', value: result.collection, expectedVersion: oldCollection.version },
        { sk: `ROUND#${roundId}`, value: next, expectedVersion: r.version },
        { sk: `SESSION#${sessionId}`, expectedVersion: s.version, value: { ...s, pendingRoundId: null,
          nextRound: s.nextRound + 1, completedRounds: s.completedRounds + 1,
          recentConfirmedResults: [...(s.recentConfirmedResults ?? []), { round: r.roundNumber, color: input.actual.color, symbol: input.actual.symbol }].slice(-40), version: s.version + 1, updatedAt: now } },
        ...this.receipt('drop-settle', `settle:${roundId}`, `settle:${roundId}`, save.wallet, result.wallet,
          { round: next, reward: result.reward, configVersions: { collection: collectionConfig.version, journey: journeyConfig.version },
            configHashes: { collection: collectionConfig.contentHash, journey: journeyConfig.contentHash }, journeyAward: result.journeyAward }, hash({ actual: input.actual, physicsVersion: input.physicsVersion }), now)];
      const eventTypes = result.reward.yallaCompletions
        ? await this.yallaEventTypes(result.reward.yallaCompletions) : [];
      for (const kind of ['jackpotTickets', 'raidTickets'] as const) if (result.reward[kind])
        writes.push({ sk: `BONUS#${roundId}#${kind}`, value: { schemaVersion: 1, version: 1, updatedAt: now,
          roundId, sessionId, kind: kind === 'jackpotTickets' ? 'Jackpot' : 'Raid', total: result.reward[kind],
          ...(kind === 'raidTickets' ? { eventTypes } : {}),
          completed: 0, totalReward: 0, announced: false, cause: 'round-collection', status: 'PENDING' } });
      const receipt = writes.find(w => w.sk === `ECONOMY#OP#settle:${roundId}`)!;
      receipt.value.configVersion = `${collectionConfig.version}:${journeyConfig.version}`;
      await this.db.commit(player, writes);
      console.info(JSON.stringify({ event: 'DROP_SETTLED', playerId: player, sessionId, roundId, poolFileId: r.poolFileId,
        setId: r.setId, seed: r.seed, expected: r.expected, actual: input.actual, matchStatus, physicsVersion: input.physicsVersion }));
      return this.round(principal, sessionId, roundId);
    });
  }
  private async yallaEventTypes(count: number) {
    const { data } = await this.configs.load('raid');
    const attackWeight = data.attackWeight ?? 10000;
    return Array.from({ length: count }, () => this.rollEvent() < attackWeight ? 'ATTACK' : 'RAID');
  }
  async cancel(principal: Principal, sessionId: string, roundId: string, input: z.infer<typeof cancelSchema>) {
    const player = await this.owner(principal);
    return this.retry(async () => {
      const s = (await this.session(player, sessionId))!, r = await this.db.get(player, `ROUND#${roundId}`) as Round | undefined;
      if (!r || r.sessionId !== sessionId) throw new ApiError(404, 'ROUND_NOT_FOUND');
      if (r.status === 'CANCELLED') return this.round(principal, sessionId, roundId);
      if (r.status !== 'ISSUED' || s.pendingRoundId !== roundId) throw new ApiError(409, 'ROUND_NOT_CANCELLABLE');
      if (this.clock() < Date.parse(r.cancelAfter)) throw new ApiError(409, 'CANCEL_TOO_EARLY');
      const save = (await this.players.read(player))!, now = new Date(this.clock()).toISOString();
      const w = recharge(save.wallet, this.clock()); w.energy += r.energyCost;
      if (w.energy >= 50) w.energyRechargeAnchor = '0'; w.version++; w.updatedAt = now;
      await this.db.commit(player, [{ sk: 'WALLET', value: w, expectedVersion: save.wallet.version },
        { sk: `ROUND#${roundId}`, value: { ...r, status: 'CANCELLED', version: r.version + 1, updatedAt: now }, expectedVersion: r.version },
        { sk: `SESSION#${sessionId}`, expectedVersion: s.version, value: { ...s, pendingRoundId: null,
          nextRound: s.nextRound + 1, version: s.version + 1, updatedAt: now } },
        ...this.receipt('drop-cancel', `cancel:${roundId}`, `cancel:${roundId}`, save.wallet, w, { roundId }, hash(input), now)]);
      return this.round(principal, sessionId, roundId);
    });
  }
}
export function createDropService(table: string, configs: ConfigSource = new GameConfigs()) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { unmarshallOptions: { wrapNumbers: false } });
  return new DropService(createDynamoRepository(table), new DynamoDropStore(client, table), new ResultPools(), Date.now, randomUUID, configs);
}
