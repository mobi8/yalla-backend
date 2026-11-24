import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BingoService, bingoLines } from '../src/bingo.js';
import { bingoEvents, type BingoEvent } from '../src/bingo-config.js';
import type { DropStore, Write } from '../src/drop.js';
import { parseConfig, type ConfigName, type ConfigSource } from '../src/game-config.js';
import { newSave, type Principal, type Save } from '../src/model.js';
import type { PlayerRepository } from '../src/repository.js';

const firstDay = '2026-11-24';
const secondDay = '2026-11-25';
const principal: Principal = { provider: 'guest', subject: 'account' };
const configFile = (name: ConfigName) => new URL(`../config/dev/${name}.json`, import.meta.url);

function fixture() {
  let time = Date.parse(firstDay + 'T23:59:59Z');
  let bingo = JSON.parse(readFileSync(configFile('bingo'), 'utf8'));
  const configs: ConfigSource = { load: async <K extends ConfigName>(name: K) =>
    parseConfig(name, name === 'bingo' ? JSON.stringify(bingo) : name === 'journey'
      ? JSON.stringify({ schemaVersion: 1, environment: 'dev', version: 'test',
        data: { distancePerChest: '300', repeat: 'REPEATING', rewardType: 'YallaPoint', rewardAmount: 250 } })
      : readFileSync(configFile(name), 'utf8'), 'dev') };
  const save = newSave(new Date(time).toISOString());
  const player = save.profile.playerId;
  const items = new Map<string, any>([['WALLET', save.wallet]]);
  const store: DropStore & { list: (_: string, prefix: string, max: number) => Promise<Record<string, any>[]> } = {
    get: async (owner, sk) => owner === player ? structuredClone(items.get(sk)) : undefined,
    list: async (owner, prefix, max) => owner === player
      ? [...items.keys()].filter(sk => sk.startsWith(prefix)).sort().slice(0, max)
        .map(sk => ({ ...structuredClone(items.get(sk)), _key: sk }))
      : [],
    commit: async (_owner, writes: Write[]) => {
      for (const write of writes) {
        if (items.get(write.sk)?.version !== write.expectedVersion) {
          const error = new Error('Stale version');
          error.name = 'TransactionCanceledException';
          throw error;
        }
      }
      for (const write of writes) {
        if (write.delete) items.delete(write.sk);
        else items.set(write.sk, structuredClone(write.value));
      }
    },
  };
  const players: PlayerRepository = {
    find: async identity => identity.subject === principal.subject ? player : undefined,
    read: async owner => owner === player ? structuredClone({ ...save, wallet: items.get('WALLET') }) as Save : undefined,
    create: async () => {},
  };
  const service = new BingoService(players, store, configs, () => time);
  const record = async (...events: { type: BingoEvent; count?: number; multiplier?: number }[]) => {
    const writes = await service.record(player, new Date(time).toISOString(), events);
    if (writes.length) await store.commit(player, writes);
  };
  const all = bingoEvents.map(type => ({ type, multiplier: type === 'Multiplier' ? 2 : undefined }));
  return { service, record, all, items, advance: (ms: number) => { time += ms; },
    config: () => bingo, changeConfig: (next: unknown) => { bingo = next; } };
}

describe('daily Bingo Mission', () => {
  it('recognizes every distinct line and awards multiple thresholds when the center completes', async () => {
    expect(bingoLines(new Set([0, 1, 2]))).toEqual([0]);
    expect(bingoLines(new Set([0, 4, 8]))).toEqual([6]);
    const { service, record, all } = fixture();
    await record(...all.filter(event => event.type !== 'Attack'));
    const initial = (await service.get(principal)).bingo;
    expect(initial.completedLines).toEqual([0, 2, 3, 5]);
    expect(initial.pending?.map(r => r.requiredLines)).toEqual([1, 3]);
    await record({ type: 'Attack' }, { type: 'Attack' });
    const finished = (await service.get(principal)).bingo;
    expect(finished.completedLines).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(finished.pending?.map(r => r.requiredLines)).toEqual([1, 3, 5, 8]);
    expect(finished.missions.find(m => m.missionId === 'Attack')?.progress).toBe(1);
  });

  it('requires the configured multiplier and preserves the board’s rules until reset', async () => {
    const { service, record, config, changeConfig, advance } = fixture();
    await record({ type: 'Multiplier', multiplier: 1 });
    expect((await service.get(principal)).bingo.missions[3]?.progress).toBe(0);
    await record({ type: 'Multiplier', multiplier: 2 });
    const next = config();
    next.data.missions[3].requiredCount = 3;
    changeConfig(next);
    expect((await service.get(principal)).bingo.missions[3]).toMatchObject({ progress: 1, completed: true });
    advance(1000);
    await record({ type: 'Multiplier', multiplier: 2 });
    expect((await service.get(principal)).bingo.missions[3]).toMatchObject({
      requiredCount: 3, progress: 1, completed: false,
    });
  });

  it('keeps earned and paid rewards through reset and returns the same concurrent claim receipt', async () => {
    const { service, record, all, items, advance, config, changeConfig } = fixture();
    await record(...all);
    const one = await service.claim(principal, firstDay, 'lines-1');
    expect(one.result.items).toEqual([{ rewardType: 'YallaPoint', rewardAmount: 300 }]);
    expect(one.bingo.rewards[0]?.status).toBe('paid');
    advance(1000);
    const next = config();
    next.data.rewards[1].rewardAmount = 1;
    changeConfig(next);
    const reset = (await service.get(principal)).bingo;
    expect(reset.bingoPeriodId).toBe(secondDay);
    expect(reset.resetAt).toBe('2026-11-26T00:00:00.000Z');
    expect(reset.completedLines).toEqual([]);
    expect(reset.rewards[1]?.rewardAmount).toBe(1);
    expect(reset.pending?.[0]?.paidItems).toEqual(one.result.items);

    const [three, replay] = await Promise.all([
      service.claim(principal, firstDay, 'lines-3'), service.claim(principal, firstDay, 'lines-3'),
    ]);
    expect(replay.result).toEqual(three.result);
    expect(items.get('WALLET')).toMatchObject({ energy: 80, yallaPoint: 300 });
    await Promise.all([
      service.acknowledgeReward(principal, firstDay, 'lines-1'),
      service.acknowledgeReward(principal, firstDay, 'lines-1'),
    ]);
    expect((await service.get(principal)).bingo.pending?.map(r => r.requiredLines)).toEqual([3, 5, 8]);
    expect((await service.claim(principal, firstDay, 'lines-1')).result).toEqual(one.result);
    expect(items.get('WALLET').yallaPoint).toBe(300);
    await expect(service.claim(principal, secondDay, 'lines-1')).rejects.toMatchObject({ code: 'BINGO_REWARD_NOT_EARNED' });
  });

  it('unlocks Bingo Box after actually opening the five-line Journey Chest and pays its items atomically', async () => {
    const { service, record, all, items } = fixture();
    await record(...all.filter(event => event.type !== 'JourneyChest'));
    expect((await service.get(principal)).bingo.completedLines).toHaveLength(5);
    await expect(service.acknowledgeReward(principal, firstDay, 'lines-5'))
      .rejects.toMatchObject({ code: 'BINGO_REWARD_NOT_PAID' });
    const journey = await service.claim(principal, firstDay, 'lines-5');
    expect(journey.result.items).toEqual([{ rewardType: 'YallaPoint', rewardAmount: 250 }]);
    expect(journey.bingo.completedLines).toHaveLength(5);
    const opened = await service.acknowledgeReward(principal, firstDay, 'lines-5');
    expect(opened.bingo.completedLines).toHaveLength(8);
    expect(opened.bingo.rewards[2]?.status).toBe('presented');
    expect(opened.bingo.rewards[3]?.status).toBe('earned');

    const clover = { remaining: 4, version: 1, anchor: Date.parse(firstDay + 'T23:00:00Z') };
    items.set('FRIEND_HELP_CLOVER', clover);
    const [box, retry] = await Promise.all([
      service.claim(principal, firstDay, 'lines-8'), service.claim(principal, firstDay, 'lines-8'),
    ]);
    expect(box.result).toEqual(retry.result);
    expect(box.result.items).toEqual([
      { rewardType: 'Gold', rewardAmount: 100 }, { rewardType: 'Energy', rewardAmount: 10 },
      { rewardType: 'Clover', rewardAmount: 1 }, { rewardType: 'CostumePoint', rewardAmount: 1 },
    ]);
    expect(items.get('WALLET')).toMatchObject({ energy: 60, yallaPoint: 350, costumePoint: 1, energyRechargeAnchor: '0' });
    expect(items.get('FRIEND_HELP_CLOVER')).toMatchObject({ remaining: 5, anchor: null, version: 2 });
    const presented = await service.acknowledgeReward(principal, firstDay, 'lines-8');
    expect(presented.bingo.missions[6]?.progress).toBe(1);
    expect(presented.bingo.rewards[3]?.status).toBe('presented');
  });

  it('uses the existing Clover cap and does not count a Bingo Box as a Journey Chest', async () => {
    const { service, record, all, items, advance } = fixture();
    await record(...all);
    advance(1000);
    const box = await service.claim(principal, firstDay, 'lines-8');
    expect(box.result.items).toContainEqual({ rewardType: 'Clover', rewardAmount: 0 });
    const presented = await service.acknowledgeReward(principal, firstDay, 'lines-8');
    expect(items.get('FRIEND_HELP_CLOVER').remaining).toBe(5);
    expect(presented.bingo.missions[6]?.progress).toBe(0);
  });

  it('acknowledges only a settled distance chest and records it once even if requests race', async () => {
    const { service, items, config, changeConfig } = fixture();
    const next = config();
    next.data.missions[6].requiredCount = 3;
    changeConfig(next);
    const roundId = '48a5ec52-f2e3-49f4-ba2e-286680e31034';
    await expect(service.acknowledgeChest(principal, roundId)).rejects.toMatchObject({ code: 'JOURNEY_CHEST_NOT_AWARDED' });
    items.set('ROUND#' + roundId, { version: 2, status: 'SETTLED',
      journeyAward: { rewards: [{ rewardType: 'Energy', rewardAmount: 3 }] } });
    await Promise.all([
      service.acknowledgeChest(principal, roundId), service.acknowledgeChest(principal, roundId),
    ]);
    expect((await service.get(principal)).bingo.missions[6]).toMatchObject({ progress: 1, completed: false });
    expect(items.get('ROUND#' + roundId)).toMatchObject({ version: 3, journeyPresented: true });
  });
});
