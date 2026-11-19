import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiError, playerKey, type PlayerRepository } from './repository.js';
import type { Principal } from './model.js';

export const deviceInput = z.strictObject({deviceId:z.uuid(),token:z.string().regex(/^(?:[0-9a-fA-F]{2}){16,128}$/),
  environment:z.enum(['sandbox','production'])});
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export const deviceKey = (player:string, id:string) => playerKey(player,'PUSH#DEVICE#'+id);
export const installationKey = (id:string) => ({PK:'SYSTEM#PUSH_INSTALLATION',SK:id});
const ownerKey = (digest:string) => ({PK:'SYSTEM#PUSH_TOKEN',SK:digest});
export class NotificationDevices {
  constructor(private client:DynamoDBDocumentClient,private table:string,private players:Pick<PlayerRepository,'find'>) {}
  private async identity(principal:Principal) {
    const player = await this.players.find(principal);
    if (!player) throw new ApiError(404,'PLAYER_NOT_FOUND');
    return player;
  }
  private async read(key:{PK:string;SK:string}) {
    return (await this.client.send(new GetCommand({TableName:this.table,Key:key,ConsistentRead:true}))).Item;
  }
  async register(principal:Principal,input:z.infer<typeof deviceInput>) {
    const player = await this.identity(principal);
    const key = deviceKey(player,input.deviceId), token = input.token.toLowerCase();
    const tokenHash = hash(input.environment+':'+token), owner = ownerKey(tokenHash);
    const installation = installationKey(input.deviceId);
    const [previous, currentOwner, currentInstallation] = await Promise.all([this.read(key),this.read(owner),this.read(installation)]);
    const version = crypto.randomUUID();
    const expect = (old?:Record<string,unknown>) => old
      ? {ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'revision'},ExpressionAttributeValues:{':v':old.revision}}
      : {ConditionExpression:'attribute_not_exists(PK)'};
    await this.client.send(new TransactWriteCommand({TransactItems:[
      {Put:{TableName:this.table,Item:{...key,token,tokenHash,environment:input.environment,deviceId:input.deviceId,revision:version,active:true},...expect(previous)}},
      {Put:{TableName:this.table,Item:{...owner,player,deviceId:input.deviceId,revision:version},...expect(currentOwner)}},
      {Put:{TableName:this.table,Item:{...installation,player,revision:version},...expect(currentInstallation)}},
      ...(currentOwner && (currentOwner.player!==player || currentOwner.deviceId!==input.deviceId) ?
        [{Delete:{TableName:this.table,Key:deviceKey(currentOwner.player,currentOwner.deviceId),...expect(currentOwner)}}] : []),
      ...(previous && previous.tokenHash!==tokenHash ?
        [{Delete:{TableName:this.table,Key:ownerKey(previous.tokenHash),...expect(previous)}}] : []),
    ]}));
    return {deviceId:input.deviceId};
  }
  async remove(principal:Principal,id:string) {
    const player = await this.identity(principal), key = deviceKey(player,id), existing = await this.read(key);
    if (!existing) return {removed:true};
    const installation = installationKey(id), owner = await this.read(installation);
    const condition = {ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'revision'},ExpressionAttributeValues:{':v':existing.revision}};
    await this.client.send(new TransactWriteCommand({TransactItems:[
      {Delete:{TableName:this.table,Key:key,...condition}},
      {Delete:{TableName:this.table,Key:ownerKey(existing.tokenHash),...condition}},
      ...(owner?.revision===existing.revision ? [{Delete:{TableName:this.table,Key:installation,...condition}}] : []),
    ]}));
    return {removed:true};
  }
}
