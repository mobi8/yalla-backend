import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactGetCommand, TransactWriteCommand, NumberValue,
  type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { profileSchema, progressSchema, walletSchema, type Principal, type Save } from './model.js';
import { starterItems } from './starter.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export interface PlayerRepository {
  find(principal: Principal): Promise<string | undefined>;
  read(playerId: string): Promise<Save | undefined>;
  create(principal: Principal, save: Save): Promise<void>;
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

export class DynamoPlayerRepository implements PlayerRepository {
  constructor(private client: DynamoDBDocumentClient, private table: string) {
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
    const parsedProfile = profileSchema.parse(stripKey(profile));
    if (parsedProfile.playerId !== playerId) throw new Error('Player identity mismatch');
    const data = stripKey(progress);
    for (const key of ['distance', 'lastDistanceMilestone', 'constructionStars']) data[key] = exact(data[key]);
    const walletData = stripKey(wallet);
    for (const key of ['energyRechargeAnchor', 'energyRechargeHighWater']) walletData[key] = exact(walletData[key]);
    return { profile: parsedProfile, progress: progressSchema.parse(data), wallet: walletSchema.parse(walletData) };
  }
  async create(principal: Principal, save: Save): Promise<void> {
    const { profile, progress } = save;
    profileSchema.parse(profile); progressSchema.parse(progress);
    const put = (Item: Record<string, unknown>) => ({ Put: { TableName: this.table, Item,
      ConditionExpression: 'attribute_not_exists(PK)' } });
    walletSchema.parse(save.wallet);
    const writes: Writes = [
      put({ ...authKey(principal), playerId: profile.playerId, provider: principal.provider, createdAt: profile.createdAt,
        schemaVersion: 1, version: 1, updatedAt: profile.createdAt }),
      put({ ...playerKey(profile.playerId, 'PROFILE'), ...profile }),
      put({ ...playerKey(profile.playerId, 'PROGRESS'), ...progress, distance: NumberValue.from(progress.distance),
        lastDistanceMilestone: NumberValue.from(progress.lastDistanceMilestone), constructionStars: NumberValue.from(progress.constructionStars) }),
      ...starterItems(save, principal).map(put),
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: writes,
      ClientRequestToken: createHash('sha256').update(JSON.stringify(writes)).digest('hex').slice(0, 36) }));
  }
}

export function createDynamoRepository(table: string): DynamoPlayerRepository {
  // Local development: AWS_PROFILE=yalla-dev. Lambda uses its execution role.
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-south-1' }), {
    unmarshallOptions: { wrapNumbers: n => Number.isSafeInteger(Number(n)) && /^-?\d+$/.test(n) ? Number(n) : NumberValue.from(n) },
  });
  return new DynamoPlayerRepository(client, table);
}
