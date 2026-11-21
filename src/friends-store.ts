import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient,
  type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

export type Key = { PK: string; SK: string };
export type Item = Key & Record<string, unknown>;
export type Write = { item: Item; expected?: string | null } | { remove: Key };

export interface FriendsStore {
  get(key: Key): Promise<Item | undefined>;
  list(PK: string, prefix: string, limit: number, after?: string): Promise<Item[]>;
  commit(writes: Write[]): Promise<boolean>;
}

export class DynamoFriendsStore implements FriendsStore {
  constructor(private client: DynamoDBDocumentClient, private table: string) {}

  async get(Key: Key) {
    return (await this.client.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }))).Item as Item | undefined;
  }

  async list(PK: string, prefix: string, limit: number, after?: string) {
    const result = await this.client.send(new QueryCommand({
      TableName: this.table, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix },
      ExclusiveStartKey: after ? { PK, SK: after } : undefined,
    }));
    return (result.Items ?? []) as Item[];
  }

  async commit(writes: Write[]) {
    const TransactItems: TransactWriteCommandInput['TransactItems'] = writes.map(write => {
      if ('remove' in write) return { Delete: { TableName: this.table, Key: write.remove } };
      const expected = write.expected;
      return { Put: {
        TableName: this.table, Item: write.item,
        ...(expected === null ? { ConditionExpression: 'attribute_not_exists(PK)' } :
          expected === undefined ? {} : {
            ConditionExpression: '#revision = :previous',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':previous': expected },
          }),
      } };
    });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException' &&
          'CancellationReasons' in error && Array.isArray(error.CancellationReasons) &&
          error.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed')) return false;
      throw error;
    }
  }
}
