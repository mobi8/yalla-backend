// One-time DEV index metadata backfill. Source values and versions are left intact.
import { execFileSync } from 'node:child_process';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { journeyReadKeys } from '../dist/journey-read-keys.js';
import { decodeProgress, playerNumberOptions } from '../dist/repository.js';

const region = 'ap-south-1';
const table = process.argv[2];
if (process.env.AWS_PROFILE !== 'yalla-dev' || !table?.startsWith('yalla-dev-bundle1-PlayerTable-') ||
    execFileSync('aws', ['sts','get-caller-identity','--profile','yalla-dev','--region',region,'--query','Account','--output','text'], { encoding:'utf8' }).trim() !== '533266967583')
  throw new Error('Expected DEV account and PlayerTable');
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { unmarshallOptions: playerNumberOptions });
let key, scanned = 0, total = 0, raced = 0;
const counts = {};
// These two unmarked receipts are the documented, isolated DEV rollout replay.
const isolatedPlayer = 'PLAYER#1474904f-3d57-4453-afa4-02d4aa3c7d42';
const isolatedReceipts = ['INCOMING#WALLET_RAID#0000000000000001', 'INCOMING#RECEIPT#0000000000000002'];
do {
  const page = await client.send(new ScanCommand({
    TableName: table, ExclusiveStartKey: key, ConsistentRead: true,
    FilterExpression: 'begins_with(PK,:player) AND attribute_not_exists(journeyPK) AND (SK=:progress OR begins_with(SK,:round) OR begins_with(SK,:incoming) OR begins_with(SK,:raid))',
    ExpressionAttributeValues: { ':player':'PLAYER#', ':progress':'PROGRESS', ':round':'ROUND#', ':incoming':'INCOMING#', ':raid':'RAID#' },
  }));
  scanned += page.ScannedCount ?? 0;
  const rows = page.Items ?? [];
  for (let i = 0; i < rows.length; i += 12) {
    await Promise.all(rows.slice(i,i+12).map(async item => {
      if (item.PK === isolatedPlayer && isolatedReceipts.includes(item.SK)) return;
      const player = item.PK.slice('PLAYER#'.length);
      if (!/^[a-f0-9-]{36}$/i.test(player) || !Number.isSafeInteger(item.version)) return;
      const fields = journeyReadKeys(player, item.SK, item.SK === 'PROGRESS' ? decodeProgress(item) : item);
      if (!fields.journeyPK) return;
      const entries = Object.entries(fields);
      const values = Object.fromEntries(entries.map(([name,value])=>[':'+name,value]));
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { PK:item.PK, SK:item.SK },
          ConditionExpression:'attribute_exists(PK) AND #v = :version AND attribute_not_exists(journeyPK)',
          ExpressionAttributeNames:{ '#v':'version' },
          UpdateExpression:'SET '+entries.map(([name])=>`${name}=:${name}`).join(', '),
          ExpressionAttributeValues:{ ...values, ':version':item.version },
        }));
        total++;
        const kind = fields.journeyPK.startsWith('FEED#') ? 'activity' : fields.journeyPK;
        counts[kind] = (counts[kind] ?? 0) + 1;
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        raced++;
      }
    }));
  }
  key = page.LastEvaluatedKey;
} while (key);
for (const sk of isolatedReceipts) {
  try {
    await client.send(new UpdateCommand({
      TableName:table, Key:{ PK:isolatedPlayer, SK:sk },
      ConditionExpression:'journeyPK = :feed',
      UpdateExpression:'REMOVE journeyPK, journeySK',
      ExpressionAttributeValues:{ ':feed':'FEED#'+isolatedPlayer.slice('PLAYER#'.length) },
    }));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }
}
console.log(JSON.stringify({ scanned, indexed: total, raced, counts }));
