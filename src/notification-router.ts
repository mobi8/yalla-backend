import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { readNotificationPolicy, receiptNotification, type NotificationEvent } from './notification-events.js';
import { GameConfigs } from './game-config.js';

type StreamRecord = {eventName?:string;dynamodb?:{SequenceNumber?:string;NewImage?:Record<string,AttributeValue>}};
const configs = new GameConfigs();

export async function routeNotifications(records: StreamRecord[], publish: (event:NotificationEvent)=>Promise<void>,
  policy = readNotificationPolicy(), enrich = async (event:NotificationEvent) => event) {
  const batchItemFailures = [];
  for (const record of records) {
    const image = record.dynamodb?.NewImage;
    if (!policy.remoteEnabled || record.eventName !== 'INSERT' || !image) continue;
    try {
      const {PK,SK,...item} = unmarshall(image);
      if (typeof PK !== 'string' || !PK.startsWith('PLAYER#') || typeof SK !== 'string') continue;
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

export async function handler(input:{Records:StreamRecord[]}) {
  // Lambda's managed Node.js runtime provides these AWS SDK v3 transport clients.
  const sdk = '@aws-sdk/client-sqs';
  return routeNotifications(input.Records, async event => {
    const {SQSClient,SendMessageCommand} = await import(sdk);
    await new SQSClient({}).send(new SendMessageCommand({QueueUrl:process.env.PUSH_QUEUE_URL,MessageBody:JSON.stringify(event)}));
  }, readNotificationPolicy(), async event => {
    if (event.eventType !== 'ATTACK_HIT') return event;
    const { data } = await configs.load('world-buildings');
    const id = event.payload.buildingId as (typeof data.defaults.buildings)[number]['id'];
    const world = event.payload.worldId as keyof typeof data.worldOverrides;
    const name = data.worldOverrides[world]?.buildingOverrides?.[id]?.displayName ??
      data.defaults.buildings.find(building => building.id === id)?.displayName;
    if (name) event.payload.buildingName = name;
    return event;
  });
}
