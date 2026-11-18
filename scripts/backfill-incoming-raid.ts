/** One-time registration of existing PROFILE items. Dry-run by default; --apply requires explicit approval. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { newIncomingSchedule } from '../src/incoming-raid.js';
const table=process.env.PLAYER_TABLE;
if(!table) throw new Error('Set PLAYER_TABLE explicitly');
const apply=process.argv.includes('--apply');
const client=DynamoDBDocumentClient.from(new DynamoDBClient({}));
const index=process.argv.indexOf('--player-id');
const one=index>=0?process.argv[index+1]:undefined;
if(index>=0 && (!one || one.startsWith('--'))) throw new Error('--player-id requires a value');
let cursor:Record<string,any>|undefined, count=0, created=0;
async function register(pk:string) {
  count++; if(!apply) return;
  const id=pk.slice('PLAYER#'.length);
  try { await client.send(new PutCommand({TableName:table,Item:{PK:pk,SK:'INCOMING#SCHEDULE',...newIncomingSchedule(id,Date.now())},ConditionExpression:'attribute_not_exists(PK)'}));created++; }
  catch(e) { if(!(e instanceof Error) || e.name!=='ConditionalCheckFailedException') throw e; }
}
if(one) {
  const key={PK:`PLAYER#${one}`,SK:'PROFILE'};
  const profile=await client.send(new GetCommand({TableName:table,Key:key,ConsistentRead:true}));
  if(!profile.Item) throw new Error('Player profile not found');
  await register(key.PK);
} else {
do {
  const result=await client.send(new ScanCommand({TableName:table,FilterExpression:'SK = :profile AND begins_with(PK, :player)',
    ExpressionAttributeValues:{':profile':'PROFILE',':player':'PLAYER#'},ProjectionExpression:'PK',ExclusiveStartKey:cursor}));
  for(const item of result.Items??[]) {
    if(typeof item.PK!=='string') continue;
    await register(item.PK);
  }
  cursor=result.LastEvaluatedKey;
} while(cursor);
}
console.log(JSON.stringify({mode:apply?'apply':'dry-run',profiles:count,created}));
