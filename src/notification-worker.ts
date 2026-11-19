import { installationKey } from './notification-devices.js';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, type QueryCommandInput, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { notificationEvent, notificationMessage, readNotificationPolicy, type NotificationEvent } from './notification-events.js';
import { apnsClient } from './notification-apns.js';

const conflict = (error:unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException';
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
type QueueRecord={messageId:string;body:string};
type Send = ReturnType<typeof apnsClient>;
export async function dispatchBatch(records:QueueRecord[], process:(event:NotificationEvent)=>Promise<void>) {
  const batchItemFailures=[];
  for (const record of records) {
    try { await process(notificationEvent.parse(JSON.parse(record.body))); }
    catch { batchItemFailures.push({itemIdentifier:record.messageId}); }
  }
  return {batchItemFailures};
}

export function worker(client:DynamoDBDocumentClient, table:string, policy:ReturnType<typeof readNotificationPolicy>,
  send?:Send, deliveryTable=table) {
  return async (event:NotificationEvent) => {
    const rule = policy.events[event.eventType];
    if (!policy.remoteEnabled || rule.push !== true || !send) return;
    const PK = 'PLAYER#'+event.recipientPlayerId;
    const devices=[];
    let cursor: QueryCommandInput['ExclusiveStartKey'];
    do {
      const page: QueryCommandOutput = await client.send(new QueryCommand({TableName:table,ConsistentRead:true,ExclusiveStartKey:cursor,
        KeyConditionExpression:'PK = :pk AND begins_with(SK,:device)',ExpressionAttributeValues:{':pk':PK,':device':'PUSH#DEVICE#'}}));
      devices.push(...page.Items ?? []);
      cursor=page.LastEvaluatedKey;
    } while (cursor);
    if (!devices.some(device=>device.active && device.environment===policy.apns.environment)) return;
    const now = Math.floor(Date.now()/1000);
    if (rule.pushCooldownSeconds) {
      try {
        await client.send(new PutCommand({TableName:deliveryTable,Item:{PK,SK:'PUSH#COOLDOWN#'+event.eventType,
          eventId:event.eventId,until:now+rule.pushCooldownSeconds,notificationExpiresAt:now+rule.pushCooldownSeconds},
          ConditionExpression:'attribute_not_exists(PK) OR #until <= :now OR eventId = :id',
          ExpressionAttributeNames:{'#until':'until'},ExpressionAttributeValues:{':now':now,':id':event.eventId}}));
      } catch (error) {if (conflict(error)) return;throw error;}
    }
    const result = await Promise.allSettled(devices.map(async device => {
      if (!device.active || device.environment !== policy.apns.environment) return;
      const Key={PK,SK:'PUSH#DELIVERY#'+digest(event.eventId+':APNS:'+device.deviceId)};
      const claim=randomUUID();
      try {
        await client.send(new PutCommand({TableName:deliveryTable,Item:{...Key,state:'PROCESSING',claim,leaseUntil:now+90,notificationExpiresAt:now+30*86400},
          ConditionExpression:'attribute_not_exists(PK) OR (#state = :processing AND leaseUntil < :now) OR (#state = :failed AND retryable = :yes)',
          ExpressionAttributeNames:{'#state':'state'},ExpressionAttributeValues:{':processing':'PROCESSING',':failed':'FAILED',':yes':true,':now':now}}));
      } catch (error) {
        if (!conflict(error)) throw error;
        const {Item}=await client.send(new GetCommand({TableName:deliveryTable,Key,ConsistentRead:true}));
        if (Item?.state==='PROCESSING') throw new Error('PUSH_BUSY');
        return;
      }
      const finish = (state:string, retryable:boolean, status:number) => client.send(new UpdateCommand({TableName:deliveryTable,Key,
        ConditionExpression:'claim = :claim',UpdateExpression:'SET #state = :state, retryable = :retry, httpStatus = :status',
        ExpressionAttributeNames:{'#state':'state'},ExpressionAttributeValues:{':claim':claim,':state':state,':retry':retryable,':status':status}}));
      const {Item:latest}=await client.send(new GetCommand({TableName:table,Key:{PK,SK:device.SK},ConsistentRead:true}));
      const {Item:installation}=await client.send(new GetCommand({TableName:table,Key:installationKey(device.deviceId),ConsistentRead:true}));
      if (!latest?.active || latest.revision !== device.revision ||
          installation?.player!==event.recipientPlayerId || installation.revision!==device.revision) {await finish('SKIPPED',false,0);return;}
      let status;
      try {status=await send(device.token,event,notificationMessage(event,policy));}
      catch {await finish('SKIPPED',false,0);console.warn('APNS_DELIVERY_UNKNOWN');return;}
      if (status===200) {await finish('ACCEPTED',false,status);return;}
      if (status===410) {
        try {await client.send(new UpdateCommand({TableName:table,Key:{PK,SK:device.SK},ConditionExpression:'revision = :revision',
          UpdateExpression:'SET active = :false',ExpressionAttributeValues:{':revision':device.revision,':false':false}}));}
        catch (error) {if(!conflict(error)) throw error;}
      }
      const retryable=status===429 || status>=500;
      await finish('FAILED',retryable,status);
      if (retryable) throw new Error('APNS_RETRY');
    }));
    if (result.some(item=>item.status==='rejected')) throw new Error('PUSH_BATCH_RETRY');
  };
}

export async function handler(input:{Records:QueueRecord[]}) {
  const policy=readNotificationPolicy();
  if (!policy.remoteEnabled) return {batchItemFailures:[]};
  const {apns}=policy;
  if (!apns.teamId || !apns.keyId || !apns.bundleId) return {batchItemFailures:[]};
  const sdk='@aws-sdk/client-ssm';
  const {SSMClient,GetParameterCommand}=await import(sdk);
  let privateKey:string|undefined;
  try {privateKey=(await new SSMClient({}).send(new GetParameterCommand({Name:process.env.APNS_PARAMETER,WithDecryption:true}))).Parameter?.Value;}
  catch (error) {
    if (error instanceof Error && error.name==='ParameterNotFound') return {batchItemFailures:[]};
    throw error;
  }
  if (!privateKey) return {batchItemFailures:[]};
  return dispatchBatch(input.Records,worker(DynamoDBDocumentClient.from(new DynamoDBClient({})),process.env.PLAYER_TABLE!,policy,apnsClient(apns,privateKey),process.env.PUSH_DELIVERY_TABLE!));
}
