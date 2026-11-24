import type { BingoEvent } from './bingo-config.js';
import type { DropStore, Write } from './drop.js';
import { recharge, rollJourneyReward } from './drop-economy.js';
import { cloverState } from './friend-help.js';
import type { ConfigData, ConfigSource, GameConfig } from './game-config.js';
import { walletSchema, type Principal } from './model.js';
import { ApiError, type PlayerRepository } from './repository.js';

type Rules = ConfigData['bingo'];
type Reward = Rules['rewards'][number];
type Item = { rewardType: 'YallaPoint' | 'Gold' | 'Energy' | 'Clover' | 'CostumePoint'; rewardAmount: number };
type Event = { type: BingoEvent; count?: number; multiplier?: number };
type Entitlement = Reward & { version: number; bingoPeriodId: string; configVersion: string; configHash: string;
  journey?: ConfigData['journey']; paidItems?: Item[] };
type Board = {
  bingoPeriodId: string;
  config: GameConfig<'bingo'>;
  counts: Partial<Record<BingoEvent, number>>;
  completedLines: number[];
  rewards: Record<string, 'earned' | 'paid' | 'presented'>;
};
type State = { version: number; board: Board; pendingCount: number };
type BingoStore = DropStore & { list(player: string, prefix: string, limit: number, newestFirst: boolean): Promise<Record<string, any>[]> };
const STATE = 'BINGO#STATE';
const PENDING = 'BINGO#PENDING#';
const rewardKey = (period: string, rewardId: string) => `${PENDING}${period}#${rewardId}`;
const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const day = (now: string) => now.slice(0, 10);
export function bingoLines(complete: ReadonlySet<number>) {
  return lines.flatMap((line, i) => line.every(position => complete.has(position)) ? [i] : []);
}

export class BingoMission {
  constructor(private db: DropStore, private configs: ConfigSource) {}

  async state(player: string, now: string) {
    const old = await this.db.get(player, STATE) as State | undefined;
    if (old && old.board.bingoPeriodId >= day(now)) return old;
    return { version: old?.version ?? 0, pendingCount: old?.pendingCount ?? 0, board: {
      bingoPeriodId: day(now), config: await this.configs.load('bingo'), counts: {}, completedLines: [], rewards: {},
    } } satisfies State;
  }

  async record(player: string, now: string, events: Event[], state?: State): Promise<Write[]> {
    const next = state ?? await this.state(player, now);
    const { board } = next;
    let changed = false;
    const complete = new Set<number>();
    for (const mission of board.config.data.missions) {
      const before = board.counts[mission.missionId] ?? 0;
      const increment = events.filter(e => e.type === mission.eventType &&
        (e.multiplier ?? 0) >= (mission.minimumMultiplier ?? 0)).reduce((sum, e) => sum + (e.count ?? 1), 0);
      const progress = Math.min(mission.requiredCount, before + increment);
      if (before !== progress) {
        board.counts[mission.missionId] = progress;
        changed = true;
      }
      if (progress >= mission.requiredCount) complete.add(mission.gridPosition);
    }
    if (!changed) return [];
    const earned: Write[] = [];
    board.completedLines = bingoLines(complete);
    for (const reward of board.config.data.rewards) {
      if (board.completedLines.length < reward.requiredLines || board.rewards[reward.rewardId]) continue;
      const journey = reward.presentationType === 'JourneyChest' ? (await this.configs.load('journey')).data : undefined;
      const value: Entitlement = { ...reward, version: 1, bingoPeriodId: board.bingoPeriodId, configVersion: board.config.version,
        configHash: board.config.contentHash, ...(journey ? { journey } : {}) };
      earned.push({ sk: rewardKey(board.bingoPeriodId, reward.rewardId), value });
      board.rewards[reward.rewardId] = 'earned';
    }
    next.pendingCount += earned.length;
    return [this.write(next, now), ...earned];
  }

  write(state: State, now: string): Write {
    return { sk: STATE, expectedVersion: state.version || undefined,
      value: { ...state, schemaVersion: 1, version: state.version + 1, updatedAt: now } };
  }

  view(state: State, now: string, pending?: Entitlement[]) {
    const { board, pendingCount, version } = state;
    return { bingoPeriodId: board.bingoPeriodId, version, serverTime: now, pendingCount,
      resetAt: new Date(Date.parse(board.bingoPeriodId) + 86400000).toISOString(),
      missions: board.config.data.missions.map(m => {
        const progress = board.counts[m.missionId] ?? 0;
        return { ...m, progress, completed: progress >= m.requiredCount };
      }),
      completedLines: board.completedLines,
      rewards: board.config.data.rewards.map(r => ({ ...r, status: board.rewards[r.rewardId] ?? 'locked' })),
      ...(pending && { pending: pending.map(({ journey, configHash, configVersion, version, ...entry }) => entry)
        .sort((a, b) => a.bingoPeriodId.localeCompare(b.bingoPeriodId) || a.requiredLines - b.requiredLines) }),
    };
  }
}

export class BingoService extends BingoMission {
  constructor(private players: PlayerRepository, private store: BingoStore, configs: ConfigSource,
    private clock = Date.now) { super(store, configs); }

  private async owner(principal: Principal) {
    const player = await this.players.find(principal);
    if (!player) throw new ApiError(404, 'PLAYER_NOT_FOUND');
    return player;
  }

  private now() { return new Date(this.clock()).toISOString(); }

  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await work(); }
      catch (err) {
        if (!(err instanceof Error) ||
          !['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(err.name)) throw err;
      }
    }
    throw new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');
  }

  async get(principal: Principal) {
    const player = await this.owner(principal);
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = this.now();
      const state = await this.state(player, now);
      // Each board earns at most four rewards. Reading four oldest keys always includes every
      // outstanding reward from the oldest period, even when reward IDs sort differently by tier.
      if (!state.pendingCount) return { bingo: this.view(state, now, []) };
      const pending = await this.store.list(player, PENDING, 4, false);
      if ((await this.store.get(player, STATE))?.version === (state.version || undefined))
        return { bingo: this.view(state, now, pending.map(({ _key, ...entry }) => entry as Entitlement)) };
    }
    throw new ApiError(409, 'STATE_CHANGED_RETRY_SAME_REQUEST');
  }

  async claim(principal: Principal, period: string, id: string) {
    const player = await this.owner(principal);
    const operationId = `bingo:${period}:${id}`;
    const receiptKey = `ECONOMY#OP#${operationId}`;
    const result = await this.retry(async () => {
      const receipt = await this.store.get(player, receiptKey);
      if (receipt) return receipt.result;
      const now = this.now();
      const state = await this.state(player, now);
      const sk = rewardKey(period, id);
      const reward = await this.store.get(player, sk) as Entitlement | undefined;
      if (!reward) throw new ApiError(409, 'BINGO_REWARD_NOT_EARNED');
      const before = (await this.players.read(player))!.wallet;
      const wallet = recharge(before, Date.parse(now));
      const items: Item[] = reward.presentationType === 'JourneyChest'
        ? Array.from({ length: reward.rewardAmount }, () => rollJourneyReward(reward.journey!))
        : reward.presentationType === 'BingoBox' ? reward.rewardItems.map(item => ({
          ...item, rewardAmount: item.rewardAmount * reward.rewardAmount,
        })) : [reward];
      const extras: Write[] = [];
      const cloverAmount = items.reduce((sum, item) => sum + (item.rewardType === 'Clover' ? item.rewardAmount : 0), 0);
      let cloverGranted = 0;
      if (cloverAmount) {
        const sk = 'FRIEND_HELP_CLOVER';
        const stored = await this.store.get(player, sk);
        const current = cloverState(stored, Date.parse(now));
        cloverGranted = Math.min(cloverAmount, current.capacity - current.remaining);
        const remaining = current.remaining + cloverGranted;
        extras.push({ sk, expectedVersion: stored?.version, value: { remaining,
          anchor: remaining === current.capacity ? null : current.anchor, version: (stored?.version ?? 0) + 1 } });
      }
      reward.paidItems = items.map(({ rewardType, rewardAmount }) => {
        if (rewardType === 'Clover') {
          const granted = Math.min(rewardAmount, cloverGranted);
          cloverGranted -= granted;
          return { rewardType, rewardAmount: granted };
        }
        if (rewardType === 'Energy') wallet.energy += rewardAmount;
        else if (rewardType === 'CostumePoint') wallet.costumePoint += rewardAmount;
        else wallet.yallaPoint += rewardAmount;
        return { rewardType, rewardAmount };
      });
      if (wallet.energy >= 50) wallet.energyRechargeAnchor = '0';
      wallet.version++;
      wallet.updatedAt = now;
      walletSchema.parse(wallet);
      if (state.board.bingoPeriodId === period) state.board.rewards[id] = 'paid';
      const result = { bingoPeriodId: period, rewardId: id, presentationType: reward.presentationType, items: reward.paidItems };
      await this.store.commit(player, [this.write(state, now), ...extras,
        { sk, expectedVersion: reward.version, value: { ...reward, version: reward.version + 1 } },
        { sk: 'WALLET', expectedVersion: before.version, value: wallet },
        { sk: receiptKey, value: { schemaVersion: 1, version: 1, operationId, operationType: 'bingo-reward',
          causeKey: operationId, configVersion: reward.configVersion, configHash: reward.configHash, committedAt: now,
          walletVersionAfter: wallet.version, balancesBefore: before, balancesAfter: wallet,
          deltas: { energy: wallet.energy - before.energy, yallaPoint: wallet.yallaPoint - before.yallaPoint,
            costumePoint: wallet.costumePoint - before.costumePoint, diamond: 0 }, result } },
      ]);
      return result;
    });
    return { ...await this.get(principal), save: await this.players.read(player), result };
  }

  async acknowledgeReward(principal: Principal, period: string, id: string) {
    const player = await this.owner(principal);
    await this.retry(async () => {
      const now = this.now();
      const state = await this.state(player, now);
      const sk = rewardKey(period, id);
      const reward = await this.store.get(player, sk) as Entitlement | undefined;
      if (!reward) {
        if (!await this.store.get(player, `ECONOMY#OP#bingo:${period}:${id}`))
          throw new ApiError(409, 'BINGO_REWARD_NOT_PAID');
        return;
      }
      if (!reward.paidItems) throw new ApiError(409, 'BINGO_REWARD_NOT_PAID');
      if (state.board.bingoPeriodId === period) state.board.rewards[id] = 'presented';
      state.pendingCount--;
      const progress = reward.presentationType === 'JourneyChest'
        ? await this.record(player, now, [{ type: 'JourneyChest', count: reward.rewardAmount }], state) : [];
      await this.store.commit(player, [...(progress.length ? progress : [this.write(state, now)]),
        { sk, value: {}, expectedVersion: reward.version, delete: true },
      ]);
    });
    return this.get(principal);
  }

  async acknowledgeChest(principal: Principal, roundId: string) {
    const player = await this.owner(principal);
    await this.retry(async () => {
      const sk = `ROUND#${roundId}`;
      const round = await this.store.get(player, sk);
      if (round?.status !== 'SETTLED' || !round.journeyAward?.rewards?.length)
        throw new ApiError(409, 'JOURNEY_CHEST_NOT_AWARDED');
      if (round.journeyPresented) return;
      const now = this.now();
      const progress = await this.record(player, now, [{ type: 'JourneyChest', count: round.journeyAward.rewards.length }]);
      await this.store.commit(player, [{ sk, expectedVersion: round.version,
        value: { ...round, journeyPresented: true, version: round.version + 1, updatedAt: now } }, ...progress]);
    });
    return this.get(principal);
  }
}
