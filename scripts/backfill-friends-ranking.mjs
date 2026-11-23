// One-time metadata backfill for existing players, discovered through the JourneyRead index.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { execFileSync } from 'node:child_process';
import { friendRankKeys, journeyIndex, totalPartition } from '../dist/journey-read-keys.js';
import { decodeProgress, playerNumberOptions } from '../dist/repository.js';

const table = process.argv[2];
const region = 'ap-south-1';
if (process.env.AWS_PROFILE !== 'yalla-dev' || !table?.startsWith('yalla-dev-bundle1-PlayerTable-') ||
    execFileSync('aws', ['sts','get-caller-identity','--profile','yalla-dev','--region',region,'--query','Account','--output','text'],
      {encoding:'utf8'}).trim() !== '533266967583') throw new Error('Expected the DEV account and PlayerTable.');
const client = DynamoDBDocumentClient.from(new DynamoDBClient({region}), {unmarshallOptions:playerNumberOptions});
let cursor, updated = 0;
do {
  const page = await client.send(new QueryCommand({TableName:table, IndexName:journeyIndex, ExclusiveStartKey:cursor, Limit:100,
    KeyConditionExpression:'journeyPK = :scope', ExpressionAttributeValues:{':scope':totalPartition}, ProjectionExpression:'PK, SK'}));
  for (const {PK, SK} of page.Items ?? []) {
    if (SK !== 'PROGRESS' || !/^PLAYER#[a-f0-9-]{36}$/i.test(PK)) continue;
    const Key = {PK,SK};
    for (let attempt = 0; attempt < 6; attempt++) {
      const {Item} = await client.send(new GetCommand({TableName:table, Key, ConsistentRead:true}));
      if (!Item) break;
      const progress = decodeProgress(Item);
      const keys = friendRankKeys(progress.distance, progress.constructionStars, PK.slice(7));
      if (Object.entries(keys).every(([k,v]) => Item[k] === v)) break;
      try {
        await client.send(new UpdateCommand({TableName:table, Key,
          UpdateExpression:'SET friendsRankPK = :pk, friendsStarsSK = :stars, friendsDistanceSK = :distance',
          ConditionExpression:'#version = :version', ExpressionAttributeNames:{'#version':'version'},
          ExpressionAttributeValues:{':pk':keys.friendsRankPK, ':stars':keys.friendsStarsSK,
            ':distance':keys.friendsDistanceSK, ':version':progress.version}}));
        updated++;
        break;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException' || attempt === 5) throw error;
      }
    }
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
console.log(`Updated ${updated} ranking index entries.`);
