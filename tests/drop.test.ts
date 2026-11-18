import { readFileSync } from 'node:fs';
import { parseConfig, type ConfigSource, type ConfigName } from '../src/game-config.js';
import { describe, it, expect } from 'vitest';
import { DropService, type DropStore, type Write, type Session } from '../src/drop.js';
import { newSave, type Principal, type Save } from '../src/model.js';
import { recharge, settle as settleConfigured, newCollection } from '../src/drop-economy.js';
import { ResultPools, validatePool } from '../src/pools.js';
import type { PlayerRepository } from '../src/repository.js';
import type { S3Client } from '@aws-sdk/client-s3';
const configs: ConfigSource = { load: async <K extends ConfigName>(name:K) => parseConfig(name,readFileSync(new URL(`../config/dev/${name}.json`,import.meta.url),'utf8'),'dev') };
const rules = parseConfig('collection',readFileSync(new URL('../config/dev/collection.json',import.meta.url),'utf8'),'dev').data;
const journey = { distancePerChest: '300', repeat: 'REPEATING' as const, rewardType: 'Energy' as const, rewardAmount: 20 };
const settle = (...args: Parameters<typeof settleConfigured> extends [...infer _] ? [Parameters<typeof settleConfigured>[0],Parameters<typeof settleConfigured>[1],Parameters<typeof settleConfigured>[2],Parameters<typeof settleConfigured>[3],string,number,string] : never) => settleConfigured(...args,rules,journey);
process.env.ENVIRONMENT = 'dev'; process.env.RESULT_POLICY = 'PERMISSIVE';
const principal: Principal = { provider: 'guest', subject: 'p' };
const input = (id = '11111111-1111-4111-8111-111111111111') => ({ requestId: id, prediction: 'RED' as const, energyCost: 3 });
const actual = { ball: 'Ball010', color: 'BLUE' as const, symbol: 'A' as const };
const poolText = JSON.stringify(Array.from({ length: 1_000 }, (_, i) => ({ ...actual, setId: i + 1, order: Array.from({ length: 25 }, (_, j) => j) })));
const assigned = validatePool(poolText, 'result-pools/v1/result_pool_1000.json')[0]!;
function fixture(rollEvent?: () => number) {
  let time = Date.parse('2026-11-17T00:00:00Z');
  const save = newSave(new Date(time).toISOString()), player = save.profile.playerId;
  const items = new Map<string, any>([['PROFILE', save.profile], ['PROGRESS', save.progress], ['WALLET', save.wallet]]);
  const db: DropStore = { get: async (p, sk) => p === player ? structuredClone(items.get(sk)) : undefined,
    commit: async (_p, writes: Write[]) => {
      for (const w of writes) if (w.expectedVersion === undefined ? items.has(w.sk) : items.get(w.sk)?.version !== w.expectedVersion) {
        const e = new Error(); e.name = 'TransactionCanceledException'; throw e;
      }
      for (const w of writes) items.set(w.sk, structuredClone(w.value));
    } };
  const players: PlayerRepository = { find: async p => p.subject === 'p' ? player : undefined,
    read: async () => structuredClone({ profile: items.get('PROFILE'), progress: items.get('PROGRESS'), wallet: items.get('WALLET') }) as Save,
    create: async () => {} };
  const service = new DropService(players, db, { pick: async () => structuredClone(assigned) }, () => time, undefined, configs, rollEvent);
  return { service, items, db, advance: (ms: number) => { time += ms; } };
}
describe('server drop economy', () => {
  it('charges one per 12 minutes, stops at 50, preserves above-cap rewards and rollback floor', () => {
    const w = newSave().wallet; w.energy = 45; w.energyRechargeAnchor = '1000'; w.energyRechargeHighWater = '1000';
    expect(recharge(w, 1719000).energy).toBe(45); expect(recharge(w, 1720000).energy).toBe(46);
    expect(recharge(w, 999999999).energy).toBe(50); expect(recharge(w, 999999999).energyRechargeAnchor).toBe('0');
    w.energy = 70; expect(recharge(w, 999999999).energy).toBe(70);
    w.energy = 45; expect(recharge(w, 1).energyRechargeHighWater).toBe('1000');
  });
  it('ports prediction, distance chest, Star and Camel collection rules', () => {
    const s = newSave(), c = newCollection('now'); s.progress.distance = '295'; c.starProgress = 4;
    const r = settle(s.wallet, s.progress, c, { ...actual, symbol: 'Star' }, 'BLUE', 1, s.wallet.updatedAt);
    expect(r.reward).toMatchObject({ yallaPoint: 20, distance: '20', distanceEnergy: 20, collectionEnergy: 5 });
    expect(r.progress.distance).toBe('315'); expect(r.wallet.energy).toBe(75);
    c.camelProgress = 4; c.shieldCount = 3;
    expect(settle(s.wallet, s.progress, c, { ...actual, symbol: 'Camel' }, 'RED', 1, s.wallet.updatedAt).reward.collectionEnergy).toBe(3);
  });
  it('keeps decimal distance exact and produces jackpot and raid rights', () => {
    const s = newSave(), c = newCollection('now'); s.progress.distance = '123456789012345.1234567890123'; s.progress.lastDistanceMilestone = '411522630041';
    expect(settle(s.wallet, s.progress, c, actual, 'RED', 1, s.wallet.updatedAt).progress.distance).toBe('123456789012350.1234567890123');
    c.crownProgress = 2; expect(settle(s.wallet, s.progress, c, { ...actual, symbol: 'Crown' }, 'RED', 1, s.wallet.updatedAt).collection.jackpotTickets).toBe(1);
    c.yallaYCount = 1; c.yallaACount = 2; c.yallaLCount = 1;
    expect(settle(s.wallet, s.progress, c, { ...actual, symbol: 'L' }, 'RED', 1, s.wallet.updatedAt).collection.raidTickets).toBe(1);
  });
});
describe('drop transaction lifecycle', () => {
  it('persists one ordered event per YALLA set and reuses the batch on resubmission', async () => {
    const rolls = [4999, 5000];
    const f = fixture(() => {
      const roll = rolls.shift();
      if (roll === undefined) throw new Error('Unexpected event draw');
      return roll;
    });
    const sid = (await f.service.open(principal)).session!.sessionId;
    Object.assign(f.items.get('COLLECTION'), { yallaYCount: 2, yallaACount: 4, yallaLCount: 1 });
    const rid = (await f.service.begin(principal, sid, input())).round!.roundId;
    const result = { requestId: input().requestId, actual: { ...actual, symbol: 'L' as const }, physicsVersion: assigned.physicsVersion };
    await f.service.submit(principal, sid, rid, result);
    await f.service.submit(principal, sid, rid, result);
    expect(f.items.get(`BONUS#${rid}#raidTickets`)).toMatchObject({ total: 2, eventTypes: ['ATTACK', 'RAID'] });
    expect(f.items.get('COLLECTION')).toMatchObject({ raidTickets: 2, yallaYCount: 0, yallaACount: 0, yallaLCount: 0 });
    expect(rolls).toEqual([]);
  });
  it('persists the same chest draw and wallet credit for concurrent and repeated settlement', async () => {
    const f = fixture(); f.items.get('PROGRESS').distance = '295';
    const sid = (await f.service.open(principal)).session!.sessionId;
    const started = await f.service.begin(principal, sid, input());
    const rid = started.round!.roundId, result = { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion };
    const [a,b] = await Promise.all([f.service.submit(principal,sid,rid,result),f.service.submit(principal,sid,rid,result)]);
    const again = await f.service.submit(principal,sid,rid,result);
    expect(a.round.journeyAward).toEqual(b.round.journeyAward);
    expect(again.round.journeyAward).toEqual(a.round.journeyAward);
    expect(a.round.journeyAward.rewards).toHaveLength(1);
    expect(f.items.get('WALLET').yallaPoint).toBe(30 + a.round.reward.distanceYallaPoint);
    expect(f.items.get('WALLET').energy).toBe(47 + a.round.reward.distanceEnergy);
  });
  it('opens one session under concurrent requests and never changes existing initial balances', async () => {
    const f = fixture(); const results = await Promise.all([f.service.open(principal), f.service.open(principal)]);
    expect(results[0].session?.sessionId).toBe(results[1].session?.sessionId); expect(f.items.get('WALLET').energy).toBe(50);
  });
  it('reserves and settles once under duplicates, including a changed request ID', async () => {
    const f = fixture(), opened = await f.service.open(principal), sid = opened.session!.sessionId;
    const [a, b] = await Promise.all([f.service.begin(principal, sid, input()), f.service.begin(principal, sid, input())]);
    expect(a.round!.roundId).toBe(b.round!.roundId); expect(f.items.get('WALLET').energy).toBe(47);
    const rid = a.round!.roundId, result = { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion };
    await Promise.all([f.service.submit(principal, sid, rid, result), f.service.submit(principal, sid, rid, result)]);
    await f.service.submit(principal, sid, rid, { ...result, requestId: '22222222-2222-4222-8222-222222222222' });
    expect(f.items.get('WALLET').yallaPoint).toBe(30); expect(f.items.get('PROGRESS').distance).toBe('15');
    expect([...f.items.keys()].filter(k => k.startsWith('ECONOMY#CAUSE#settle:'))).toHaveLength(1);
    expect((await f.service.round(principal, sid, rid)).round.status).toBe('SETTLED');
  });
  it('prevents new pending rounds, input changes, cross-player calls and changed result replays', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId;
    const r = await f.service.begin(principal, sid, input());
    await expect(f.service.begin(principal, sid, { ...input(), energyCost: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(f.service.begin(principal, sid, input('22222222-2222-4222-8222-222222222222'))).rejects.toMatchObject({ code: 'ROUND_PENDING' });
    await expect(f.service.round({ ...principal, subject: 'other' }, sid, r.round!.roundId)).rejects.toMatchObject({ status: 404 });
    await f.service.submit(principal, sid, r.round!.roundId, { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion });
    await expect(f.service.submit(principal, sid, r.round!.roundId, { requestId: input().requestId, actual: { ...actual, symbol: 'Star' }, physicsVersion: assigned.physicsVersion })).rejects.toMatchObject({ code: 'RESULT_CONFLICT' });
  });
  it('settles mismatches using actual, stores audit and blocks production permissive', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId, r = await f.service.begin(principal, sid, input());
    const result = await f.service.submit(principal, sid, r.round!.roundId, { requestId: input().requestId,
      actual: { ball: 'Ball008', color: 'RED', symbol: 'Crown' }, physicsVersion: assigned.physicsVersion });
    expect(result.round.matchStatus).toBe('MISMATCH'); expect(result.save.wallet.yallaPoint).toBe(60);
    expect(result.collection!.jackpotTickets).toBe(1); expect([...f.items.keys()].some(k => k.startsWith('BONUS#'))).toBe(true);
    process.env.ENVIRONMENT = 'prod';
    try { await expect(f.service.begin(principal, sid, input())).rejects.toMatchObject({ code: 'RESULT_POLICY_DISABLED' }); }
    finally { process.env.ENVIRONMENT = 'dev'; }
  });
  it('requires timeout, refunds only the paid energy once and refuses cancelled results', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId, r = await f.service.begin(principal, sid, input());
    const cancel = { requestId: input().requestId, reason: 'PHYSICS_TIMEOUT' as const }, rid = r.round!.roundId;
    await expect(f.service.cancel(principal, sid, rid, cancel)).rejects.toMatchObject({ code: 'CANCEL_TOO_EARLY' });
    f.advance(120000); await Promise.all([f.service.cancel(principal, sid, rid, cancel), f.service.cancel(principal, sid, rid, cancel)]);
    expect(f.items.get('WALLET').energy).toBe(50);
    await expect(f.service.submit(principal, sid, rid, { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion })).rejects.toMatchObject({ code: 'ROUND_CANCELLED' });
  });
  it('recovers ambiguous commits with the original request', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId;
    const commit = f.db.commit; let fail = true;
    f.db.commit = async (p, writes) => { await commit(p, writes); if (fail) { fail = false; const e = new Error(); e.name = 'TimeoutError'; throw e; } };
    await expect(f.service.begin(principal, sid, input())).rejects.toMatchObject({ name: 'TimeoutError' });
    const r = await f.service.begin(principal, sid, input()); expect(f.items.get('WALLET').energy).toBe(47);
    fail = true;
    const result = { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion };
    await expect(f.service.submit(principal, sid, r.round!.roundId, result)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await f.service.submit(principal, sid, r.round!.roundId, result)).save.wallet.yallaPoint).toBe(30);
  });
  it('does not mutate settlement state on economy overflow', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId;
    f.items.get('WALLET').yallaPoint = 2147483640;
    const r = await f.service.begin(principal, sid, input());
    await expect(f.service.submit(principal, sid, r.round!.roundId, { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion })).rejects.toThrow();
    expect(f.items.get('WALLET').yallaPoint).toBe(2147483640);
    expect(f.items.get('PROGRESS').distance).toBe('0');
    expect(f.items.get('ROUND#' + r.round!.roundId).status).toBe('ISSUED');
  });
  it('does not return a terminal Round paired with its pre-settlement Wallet', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId;
    const issued = await f.service.begin(principal, sid, input()), rid = issued.round!.roundId;
    const original = f.db.get; let reads = 0, fired = false;
    f.db.get = async (p, sk) => {
      if (sk === 'ROUND#' + rid && ++reads === 2 && !fired) {
        fired = true;
        await f.service.submit(principal, sid, rid, { requestId: input().requestId, actual, physicsVersion: assigned.physicsVersion });
      }
      return original(p, sk);
    };
    const result = await f.service.round(principal, sid, rid);
    expect(result.round.status).toBe('SETTLED'); expect(result.save.wallet.yallaPoint).toBe(30);
  });
  it('resumes a frozen issued set from durable state', async () => {
    const f = fixture(), sid = (await f.service.open(principal)).session!.sessionId, r = await f.service.begin(principal, sid, input());
    const active = await f.service.active(principal); expect(active.round).toMatchObject({ roundId: r.round!.roundId, order: assigned.order, poolVersion: assigned.poolVersion });
  });
});
describe('result pool validation and cache', () => {
  it('rejects wrong count, duplicate IDs and malformed permutations', () => {
    expect(() => validatePool('[]', 'x')).toThrow(); const rows = JSON.parse(poolText); rows[1].setId = 1;
    expect(() => validatePool(JSON.stringify(rows), 'x')).toThrow(); rows[1].setId = 2; rows[1].order[0] = 1;
    expect(() => validatePool(JSON.stringify(rows), 'x')).toThrow();
  });
  it('loads only the 1,000-set file and refreshes after the TTL', async () => {
    let now = 0, listings = 0;
    const reads: string[] = [];
    const key = 'v1/result_pool_1000.json';
    const s3 = { send: async (cmd: any) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        listings++;
        return { Contents: [{ Key: 'v1/result_pool_100_1.json', Size: 100 }, { Key: key, Size: 100 }] };
      }
      reads.push(cmd.input.Key);
      return { Body: { transformToString: async () => poolText } };
    } } as unknown as S3Client;
    const pools = new ResultPools(s3, 'bucket', 'v1/', () => now);
    expect((await pools.pick()).poolFileId).toBe(key);
    await pools.pick();
    expect(listings).toBe(1);
    expect(reads).toEqual([key]);
    now = 60001;
    expect((await pools.pick()).poolFileId).toBe(key);
    expect(listings).toBe(2);
    expect(reads).toEqual([key, key]);
  });
});
