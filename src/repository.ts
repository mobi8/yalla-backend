import { GameConfigs, type ConfigSource } from './game-config.js';
import { BotsConfigs, type BotsSource } from './bots-config.js';
import { newBonusState, syncRaidBots } from './raid-bots.js';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactGetCommand, TransactWriteCommand, NumberValue,
  type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { profileSchema, progressSchema, walletSchema, type Principal, type Profile, type Save } from './model.js';
import { journeyReadKeys, withoutJourneyKeys } from './journey-read-keys.js';
import { starterItems } from './starter.js';
import { newIncomingSchedule } from './incoming-raid.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface PlayerRepository {
  find(principal: Principal): Promise<string | undefined>;
  read(playerId: string): Promise<Save | undefined>;
  create(principal: Principal, save: Save): Promise<void>;
  setAvatar?(playerId: string, avatarId: string): Promise<Profile | undefined>;
}
type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>;
export const authKey = (p: Principal) => ({ PK: `AUTH#${p.provider}#${p.subject}`, SK: 'PLAYER' });
export const playerKey = (id: string, SK: string) => ({ PK: `PLAYER#${id}`, SK });
const stripKey = (item: Record<string, unknown>) => {
  const { PK, SK, ...value } = item; return value;
};
function plainDecimal(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const digits = match[1]! + (match[2] ?? '');
  const point = match[1]!.length + Number(match[3]);
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return digits.slice(0, point) + '.' + digits.slice(point);
}
const exact = (value: unknown): unknown => value instanceof NumberValue ? plainDecimal(value.toString()) :
  typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;

const progressNumberFields = ['distance', 'lastDistanceMilestone', 'constructionStars'] as const;

export function decodeProgress(item: Record<string, unknown>) {
  const data = withoutJourneyKeys(stripKey(item));
  for (const key of progressNumberFields) data[key] = exact(data[key]);
  return progressSchema.parse(data);
}

export function encodeProgress(progress: Save['progress']) {
  return {
    ...progress,
    distance: NumberValue.from(progress.distance),
    lastDistanceMilestone: NumberValue.from(progress.lastDistanceMilestone),
    constructionStars: NumberValue.from(progress.constructionStars),
  };
}

export function decodeWallet(item: Record<string, unknown>) {
  const data = stripKey(item);
  for (const key of ['energyRechargeAnchor', 'energyRechargeHighWater']) data[key] = exact(data[key]);
  return walletSchema.parse(data);
}

export function encodeWallet(wallet: Save['wallet']) {
  return {
    ...wallet,
    energyRechargeAnchor: NumberValue.from(wallet.energyRechargeAnchor),
    energyRechargeHighWater: NumberValue.from(wallet.energyRechargeHighWater),
  };
}

export const playerNumberOptions = {
  wrapNumbers: (n: string) => Number.isSafeInteger(Number(n)) && /^-?\d+$/.test(n) ? Number(n) : NumberValue.from(n),
};

const nicknameCounterKey = { PK: 'SYSTEM#PLAYER_NICKNAME', SK: 'COUNTER' };
const needsNickname = (value: unknown) =>
  value == null || (typeof value === 'string' && ['', 'YOU'].includes(value.trim()));

const previousDefault = /^Player ([0-9]{4}|[1-9][0-9]{4,})$/;

function readProfile(item: Record<string, unknown>, playerId: string): Profile {
  const data = stripKey(item);
  if (needsNickname(data.nickname)) data.nickname = 'YOU';
  const profile = profileSchema.parse(data);
  if (profile.playerId !== playerId) throw new Error('Player identity mismatch');
  return profile;
}

export class DynamoPlayerRepository implements PlayerRepository {
  constructor(private client: DynamoDBDocumentClient, private table: string,
    private configs: ConfigSource = new GameConfigs(), private botsConfig: BotsSource = new BotsConfigs()) {
    if (!table.trim()) throw new Error('PLAYER_TABLE is required');
  }
  async find(principal: Principal): Promise<string | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: authKey(principal), ConsistentRead: true }));
    if (!Item) return undefined;
    if (Item.provider !== principal.provider || typeof Item.playerId !== 'string' || !profileSchema.shape.playerId.safeParse(Item.playerId).success)
      throw new Error('Corrupt auth link');
    return Item.playerId;
  }
  async read(playerId: string): Promise<Save | undefined> {
    const result = await this.client.send(new TransactGetCommand({ TransactItems: ['PROFILE', 'PROGRESS', 'WALLET'].map(SK => ({
      Get: { TableName: this.table, Key: playerKey(playerId, SK) },
    })) }));
    const profile = result.Responses?.[0]?.Item, progress = result.Responses?.[1]?.Item, wallet = result.Responses?.[2]?.Item;
    if (!profile && !progress && !wallet) return undefined;
    if (!profile || !progress || !wallet) throw new Error('Incomplete player save');
    const stored = readProfile(profile, playerId);
    const save = { profile: stored, progress: decodeProgress(progress), wallet: decodeWallet(wallet) };
    if (needsNickname(stored.nickname) || previousDefault.test(stored.nickname)) {
      const updated = await this.ensureProfileNickname(playerId);
      if (!updated) throw new Error('Profile missing during nickname assignment');
      save.profile = updated;
    }
    return save;
  }

  async setAvatar(playerId: string, avatarId: string): Promise<Profile | undefined> {
    return this.retryProfileWrite(async () => {
      const key = playerKey(playerId, 'PROFILE');
      const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
      if (!Item) return undefined;
      const profile = readProfile(Item, playerId);
      if (profile.avatarId === avatarId) return profile;
      const updated = { ...profile, avatarId, version: profile.version + 1, updatedAt: new Date().toISOString() };
      await this.commit([{ Put: {
        TableName: this.table, Item: { ...key, ...updated }, ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': profile.version },
      } }]);
      return updated;
    });
  }

  async ensureProfileNickname(playerId: string): Promise<Profile | undefined> {
    return this.retryProfileWrite(async () => {
      const { Item } = await this.client.send(new GetCommand({
        TableName: this.table, Key: playerKey(playerId, 'PROFILE'), ConsistentRead: true,
      }));
      if (!Item) return undefined;
      const profile = readProfile(Item, playerId);
      const previousNumber = previousDefault.exec(profile.nickname)?.[1];
      if (!previousNumber && !needsNickname(profile.nickname)) return profile;
      const allocation = previousNumber ? undefined : await this.nextNickname();
      const nickname = allocation?.nickname ?? `Guest ${previousNumber}`;
      const updated = { ...profile, nickname, version: profile.version + 1, updatedAt: new Date().toISOString() };
      await this.commit([...(allocation ? [allocation.write] : []), { Put: {
        TableName: this.table, Item: { ...playerKey(playerId, 'PROFILE'), ...updated },
        ConditionExpression: '#version = :version AND ' +
          (Item.nickname === undefined ? 'attribute_not_exists(nickname)' : 'nickname = :previous'),
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': profile.version,
          ...(Item.nickname === undefined ? {} : { ':previous': Item.nickname }) },
      } }]);
      return updated;
    });
  }

  private async nextNickname() {
    const { Item } = await this.client.send(new GetCommand({
      TableName: this.table, Key: nicknameCounterKey, ConsistentRead: true,
    }));
    const last: unknown = Item ? Item.lastNumber : 0;
    if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < (Item ? 1 : 0) || last >= Number.MAX_SAFE_INTEGER)
      throw new Error('Invalid nickname counter');
    const number = last + 1;
    const write: Writes[number] = { Put: {
      TableName: this.table, Item: { ...nicknameCounterKey, lastNumber: number },
      ConditionExpression: Item ? 'lastNumber = :last' : 'attribute_not_exists(PK)',
      ...(Item ? { ExpressionAttributeValues: { ':last': last } } : {}),
    } };
    return { nickname: `Guest ${String(number).padStart(4, '0')}`, write };
  }

  private async retryProfileWrite<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await write(); }
      catch (error) {
        const reasons = (error as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons;
        if (!(error instanceof Error) || error.name !== 'TransactionCanceledException' || !reasons?.length ||
            reasons.some(reason => !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code ?? 'None')) ||
            attempt >= 11) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(250, 10 * 2 ** attempt)));
      }
    }
  }

  async create(principal: Principal, save: Save): Promise<void> {
    const { profile, progress } = save;
    profileSchema.parse(profile); progressSchema.parse(progress);
    const put = (Item: Record<string, unknown>) => ({ Put: { TableName: this.table, Item,
      ConditionExpression: 'attribute_not_exists(PK)' } });
    walletSchema.parse(save.wallet);
    const [raidConfig, botSettings] = await Promise.all([this.configs.load('raid'), this.botsConfig.load()]);
    const bots = syncRaidBots(progress, raidConfig, botSettings, [], Date.parse(profile.createdAt));
    const writes: Writes = [
      put({ ...authKey(principal), playerId: profile.playerId, provider: principal.provider, createdAt: profile.createdAt,
        schemaVersion: 1, version: 1, updatedAt: profile.createdAt }),
      put({ ...playerKey(profile.playerId, 'PROFILE'), ...profile }),
      put({ ...playerKey(profile.playerId, 'PROGRESS'), ...encodeProgress(progress), ...journeyReadKeys(profile.playerId, 'PROGRESS', progress) }),
      ...starterItems(save, principal).map(put),
      put({ ...playerKey(profile.playerId, 'BONUS#STATE'), ...newBonusState(profile.createdAt, bots) }),
      put({ ...playerKey(profile.playerId, 'INCOMING#SCHEDULE'), ...newIncomingSchedule(profile.playerId, Date.parse(profile.createdAt)) }),
    ];
    if (!needsNickname(profile.nickname)) return this.commit(writes);
    await this.retryProfileWrite(async () => {
      // Preserve the existing auth-link condition and avoid retrying a losing duplicate guest creation.
      if (await this.find(principal)) throw new ApiError(409, 'PLAYER_ALREADY_EXISTS');
      const { nickname, write } = await this.nextNickname();
      const namedProfile = { ...profile, nickname };
      const namedWrites = [...writes];
      namedWrites[1] = put({ ...playerKey(profile.playerId, 'PROFILE'), ...namedProfile });
      await this.commit([write, ...namedWrites]);
    });
  }

  private async commit(writes: Writes) {
    await this.client.send(new TransactWriteCommand({ TransactItems: writes,
      ClientRequestToken: createHash('sha256').update(JSON.stringify(writes)).digest('hex').slice(0, 36) }));
  }
}

export function createDynamoRepository(table: string): DynamoPlayerRepository {
  // Local development: AWS_PROFILE=yalla-dev. Lambda uses its execution role.
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-south-1' }), {
    unmarshallOptions: playerNumberOptions,
  });
  return new DynamoPlayerRepository(client, table);
}
