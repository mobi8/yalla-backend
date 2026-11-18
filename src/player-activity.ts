import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { playerKey } from './repository.js';

export const ACTIVITY_KEY = 'ACTIVITY';
export const ACTIVITY_PARTITION = 'PLAYER_ACTIVITY';
export const OFFLINE_AFTER_MS = 5 * 60_000;
export const INACTIVE_AFTER_MS = 24 * 60 * 60_000;

export function isRaidCandidate(lastActiveAt: unknown, now: number) {
  const elapsed = typeof lastActiveAt === 'string' ? now - Date.parse(lastActiveAt) : NaN;
  return elapsed > OFFLINE_AFTER_MS && elapsed <= INACTIVE_AFTER_MS;
}

export class PlayerActivity {
  constructor(private client: DynamoDBDocumentClient, private table: string, private clock = Date.now) {}

  async record(playerId: string) {
    const lastActiveAt = new Date(this.clock()).toISOString();
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: {...playerKey(playerId, ACTIVITY_KEY), activityPartition: ACTIVITY_PARTITION, lastActiveAt},
        ConditionExpression: 'attribute_not_exists(lastActiveAt) OR lastActiveAt < :now',
        ExpressionAttributeValues: {':now': lastActiveAt},
      }));
    } catch (error) {
      // Concurrent requests can reach DynamoDB out of order.
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
}
