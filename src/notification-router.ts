import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, type QueryCommandInput, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { DynamoFriendsStore } from './friends-store.js';
import { friendCrossings, settlementChange } from './friend-overtake.js';
import { rankingPeriod } from './journey-read.js';
import { scaled } from './drop-economy.js';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { readNotificationPolicy, receiptNotification, type NotificationEvent } from './notification-events.js';
import { GameConfigs } from './game-config.js';

type StreamRecord = {eventName?:string;dynamodb?:{SequenceNumber?:string;NewImage?:Record<string,AttributeValue>;OldImage?:Record<string,AttributeValue>}};
const configs = new GameConfigs();

export async function routeNotifications(records: StreamRecord[], publish: (event:NotificationEvent)=>Promise<void>,
  policy = readNotificationPolicy(), enrich = async (event:NotificationEvent) => event,
  crossings?: (settlement: NonNullable<ReturnType<typeof settlementChange>>) => Promise<NotificationEvent[]>) {
  const batchItemFailures = [];
  for (const record of records) {
    const image = record.dynamodb?.NewImage;
    if (!image || (!policy.remoteEnabled && !crossings)) continue;
    try {
      const {PK,SK,...item} = unmarshall(image);
      if (typeof PK !== 'string' || !PK.startsWith('PLAYER#') || typeof SK !== 'string') continue;
      if (record.eventName === 'MODIFY' && record.dynamodb?.OldImage && crossings && policy.events.RANK_OVERTAKEN.push === true) {
        const settlement = settlementChange(PK.slice(7), SK, unmarshall(record.dynamodb.OldImage), item);
        if (settlement) for (const event of await crossings(settlement)) await publish(event);
      }
      if (!policy.remoteEnabled || record.eventName !== 'INSERT') continue;
      const event = receiptNotification(PK.slice(7), SK, item);
      if (event && policy.events[event.eventType].push === true) await publish(await enrich(event));
    } catch {
      const seq = record.dynamodb?.SequenceNumber;
      if (!seq) throw new Error('NOTIFICATION_ROUTER_SEQUENCE_MISSING');
      batchItemFailures.push({itemIdentifier:seq});
    }
  }
  return {batchItemFailures};
}

const simulation = z.strictObject({
  action: z.literal('simulateFriendBotOvertake'), recipient: z.uuid(),
  bot: z.string().regex(/^bot-player_10\d{2}$/), requestId: z.uuid(), occurredAt: z.iso.datetime(),
});

export async function handler(input:{Records:StreamRecord[]} | z.infer<typeof simulation>) {
  const table = process.env.PLAYER_TABLE!;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = new DynamoFriendsStore(client,table);
  const score = async (player:string, start:string, through:string) => {
    let distance = 0n;
    let cursor: QueryCommandInput['ExclusiveStartKey'];
    do {
      const page: QueryCommandOutput = await client.send(new QueryCommand({
        TableName:table, ConsistentRead:true, ExclusiveStartKey:cursor,
        KeyConditionExpression:'PK = :pk AND begins_with(SK, :round)',
        FilterExpression:'settledAt BETWEEN :start AND :through AND attribute_exists(rankDistance)',
        ExpressionAttributeValues:{':pk':'PLAYER#'+player,':round':'ROUND#',':start':start,':through':through},
        ProjectionExpression:'rankDistance',
      }));
      for (const row of page.Items ?? []) distance += scaled(row.rankDistance);
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return distance;
  };
  // Lambda's managed Node.js runtime provides these AWS SDK v3 transport clients.
  const sdk = '@aws-sdk/client-sqs';
  const publish = async (event: NotificationEvent) => {
    const {SQSClient,SendMessageCommand} = await import(sdk);
    await new SQSClient({}).send(new SendMessageCommand({QueueUrl:process.env.PUSH_QUEUE_URL,MessageBody:JSON.stringify(event)}));
  };
  const days = Number(process.env.RANKING_PERIOD_DAYS ?? 7);
  if (!('Records' in input)) {
    // Direct IAM invocation of the DEV router only. No gameplay data is written.
    if (process.env.ENVIRONMENT !== 'dev') throw Error('DEV_ONLY');
    const test = simulation.parse(input);
    const now = Date.now();
    const period = rankingPeriod(now,days);
    if (test.occurredAt < period.startsAt || test.occurredAt > new Date(now).toISOString())
      return { queued: 0 };
    const own = await score(test.recipient,period.startsAt,test.occurredAt);
    if (own <= 0n) return { queued: 0 };
    const events = await friendCrossings(store, async (player,start,through) =>
      player === test.bot ? own + 1n : score(player,start,through),
    {actor:test.bot,round:test.requestId,occurredAt:test.occurredAt,added:2n},days,now,true,test.recipient);
    // Simulation events enter the DEV queue only while real sending is disabled.
    if (readNotificationPolicy().remoteEnabled) throw Error('SIMULATION_REQUIRES_APNS_DISABLED');
    for (const event of events) await publish(event);
    return { queued: events.length, eventIds: events.map(event => event.eventId) };
  }
  return routeNotifications(input.Records, publish, readNotificationPolicy(), async event => {
    if (event.eventType !== 'ATTACK_HIT') return event;
    const { data } = await configs.load('world-buildings');
    const id = event.payload.buildingId as (typeof data.defaults.buildings)[number]['id'];
    const world = event.payload.worldId as keyof typeof data.worldOverrides;
    const name = data.worldOverrides[world]?.buildingOverrides?.[id]?.displayName ??
      data.defaults.buildings.find(building => building.id === id)?.displayName;
    if (name) event.payload.buildingName = name;
    return event;
  }, settlement => friendCrossings(store,score,settlement,days,Date.now()));
}
