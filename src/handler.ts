import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PlayerActivity } from './player-activity.js';
import { z } from 'zod';
import { createWorldService,worldCommand,upgradeCommand,repairCommand,type WorldService } from './world.js';
import { GameConfigs } from './game-config.js';
import { createBonusService, bonusInput, kindInput, raidBeginInput, attackInput, pickInput, costumePurchaseInput, costumeEquipInput, type BonusService } from './bonus.js';
import { createDropService, beginSchema, resultSchema, cancelSchema, type DropService } from './drop.js';
import type { Principal } from './model.js';
import { ApiError, createDynamoRepository } from './repository.js';
import { PlayerService } from './service.js';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoGuestIdentity, guestKeySchema, type GuestIdentity } from './auth.js';

export interface HttpEvent {
  rawPath: string; body?: string | null; isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; authorizer?: unknown };
}
export type Authenticate = (event: HttpEvent) => Promise<Principal>;
/** API Gateway verifies signatures. Lambda additionally enforces issuer, client, token type and ownership.
 * The function has no Function URL and only its API Gateway may invoke it through resource permissions. */
export const cognitoContext: Authenticate = async event => {
  const parsed = z.object({ jwt: z.object({ claims: z.object({ sub: z.string().min(1).max(128), iss: z.string(),
    client_id: z.string(), token_use: z.literal('access'), exp: z.coerce.number().int() }) }) }).safeParse(event.requestContext.authorizer);
  if (!parsed.success || !process.env.USER_POOL_ID || !process.env.USER_POOL_CLIENT_ID || !process.env.COGNITO_ISSUER ||
      parsed.data.jwt.claims.iss !== process.env.COGNITO_ISSUER ||
      parsed.data.jwt.claims.client_id !== process.env.USER_POOL_CLIENT_ID || parsed.data.jwt.claims.exp <= Date.now() / 1000)
    throw new ApiError(401, 'UNAUTHENTICATED');
  return { provider: 'guest', subject: `${process.env.USER_POOL_ID}:${parsed.data.jwt.claims.sub}` };
};
const emptyBody = z.strictObject({});
function body(event: HttpEvent): unknown {
  try { return JSON.parse(event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}'); }
  catch { throw new ApiError(400, 'INVALID_JSON'); }
}
export function createHandler(service: PlayerService, authenticate: Authenticate = cognitoContext, identity?: GuestIdentity, drops?: DropService, bonuses?: BonusService, worlds?: WorldService, recordActivity?: (principal: Principal) => Promise<void>) {
  return async (event: HttpEvent) => {
    const response = (statusCode: number, data: unknown) => ({ statusCode,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(data) });
    const activePrincipal = async () => {
      const principal = await authenticate(event);
      await recordActivity?.(principal);
      return principal;
    };
    try {
      const route = `${event.requestContext.http.method} ${event.rawPath}`;
      if (['POST /auth/guest', 'POST /auth/refresh', 'POST /auth/logout'].includes(route)) {
        if (!identity) throw new ApiError(503, 'AUTH_NOT_CONFIGURED');
        if (route === 'POST /auth/guest') {
          const input = z.strictObject({ guestKey: guestKeySchema }).safeParse(body(event));
          if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
          const auth = await identity.bootstrap(input.data.guestKey);
          const result = await service.createGuest(auth.principal);
          return response(result.created ? 201 : 200, { ...result, tokens: auth.tokens });
        }
        const input = z.strictObject({ refreshToken: z.string().min(1).max(16384) }).safeParse(body(event));
        if (!input.success) throw new ApiError(400, 'INVALID_REQUEST');
        if (route.endsWith('/refresh')) return response(200, { tokens: await identity.refresh(input.data.refreshToken) });
        await identity.revoke(input.data.refreshToken);
        return response(200, { revoked: true });
      }
      if(event.rawPath.startsWith('/worlds/')) {
        if(!worlds)throw new ApiError(503,'WORLD_NOT_CONFIGURED');
        const principal=await activePrincipal();
        if(route==='GET /worlds/state')return response(200,await worlds.state(principal));
        const action=event.rawPath.split('/')[2];
        if(event.requestContext.http.method==='POST' && (action==='upgrade'||action==='repair'||action==='complete'||action==='select')){
          const input=(action==='upgrade'?upgradeCommand:action==='repair'?repairCommand:worldCommand).safeParse(body(event));
          if(!input.success)throw new ApiError(400,'INVALID_REQUEST');
          return response(200,await worlds.execute(principal,action,input.data));
        }
        throw new ApiError(404,'ROUTE_NOT_FOUND');
      }
      if (event.rawPath.startsWith('/bonuses')) {
        if (!bonuses) throw new ApiError(503,'BONUS_NOT_CONFIGURED');
        const principal = await activePrincipal();
        const parse = <T>(schema:z.ZodType<T>):T => { const input=schema.safeParse(body(event));
          if(!input.success)throw new ApiError(400,'INVALID_REQUEST');return input.data; };
        if(route==='GET /bonuses')return response(200,await bonuses.get(principal));
        if(route==='POST /bonuses/ensure')return response(200,await bonuses.ensure(principal,parse(kindInput).kind));
        if(route==='POST /bonuses/finish')return response(200,await bonuses.finish(principal,parse(kindInput).kind));
        if(route==='POST /bonuses/announce')return response(200,await bonuses.announce(principal,parse(z.strictObject({roundId:z.string().min(1).max(160)})).roundId));
        if(route==='POST /bonuses/jackpot/spins')return response(200,await bonuses.spin(principal,parse(bonusInput)));
        if(route==='POST /bonuses/raids')return response(200,await bonuses.beginRaid(principal,parse(raidBeginInput)));
        if(route==='POST /bonuses/costumes/purchase')return response(200,await bonuses.purchaseCostume(principal,parse(costumePurchaseInput)));
        if(route==='POST /bonuses/costumes/equip')return response(200,await bonuses.equipCostume(principal,parse(costumeEquipInput)));
        const m=/^\/bonuses\/(jackpot|raids)\/([a-f0-9-]{36})\/(ack|attack|pick|cancel)$/.exec(event.rawPath);
        if(m && event.requestContext.http.method==='POST') {
          if(m[3]==='ack'){parse(emptyBody);return response(200,await bonuses.acknowledge(principal,m[1]==='jackpot'?'Jackpot':'Raid',m[2]!));}
          if(m[1]==='raids' && m[3]==='attack')return response(200,await bonuses.attack(principal,m[2]!,parse(attackInput)));
          if(m[1]==='raids' && m[3]==='pick')return response(200,await bonuses.pick(principal,m[2]!,parse(pickInput)));
          if(m[1]==='raids' && m[3]==='cancel'){parse(emptyBody);return response(200,await bonuses.cancelRaid(principal,m[2]!));}
        }
        throw new ApiError(404,'ROUTE_NOT_FOUND');
      }
      if (event.rawPath.startsWith('/drop/')) {
        if (!drops) throw new ApiError(503, 'DROP_NOT_CONFIGURED');
        const principal = await activePrincipal();
        const parse = <T>(schema: z.ZodType<T>): T => {
          const value = schema.safeParse(body(event));
          if (!value.success) throw new ApiError(400, 'INVALID_REQUEST'); return value.data;
        };
        if (route === 'POST /drop/sessions') { parse(emptyBody); return response(200, await drops.open(principal)); }
        if (route === 'GET /drop/sessions/active') return response(200, await drops.active(principal));
        const match = /^\/drop\/sessions\/([a-f0-9-]{36})\/rounds(?:\/([a-f0-9-]{36})(?:\/(result|cancel))?)?$/.exec(event.rawPath);
        if (!match) throw new ApiError(404, 'ROUTE_NOT_FOUND');
        const [, sessionId, roundId, action] = match;
        if (!roundId && event.requestContext.http.method === 'POST')
          return response(200, await drops.begin(principal, sessionId!, parse(beginSchema)));
        if (roundId && !action && event.requestContext.http.method === 'GET')
          return response(200, await drops.round(principal, sessionId!, roundId));
        if (roundId && action && event.requestContext.http.method === 'POST')
          return response(200, action === 'result' ? await drops.submit(principal, sessionId!, roundId, parse(resultSchema)) :
            await drops.cancel(principal, sessionId!, roundId, parse(cancelSchema)));
        throw new ApiError(404, 'ROUTE_NOT_FOUND');
      }
      if (route === 'POST /players/me/heartbeat') {
        if (!emptyBody.safeParse(body(event)).success) throw new ApiError(400, 'INVALID_REQUEST');
        if (!recordActivity) throw new ApiError(503, 'ACTIVITY_NOT_CONFIGURED');
        await activePrincipal();
        return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
      }
      if (!['POST /players/guest', 'GET /players/me', 'GET /players/me/save', 'GET /players/me/progress', 'GET /players/me/wallet'].includes(route))
        throw new ApiError(404, 'ROUTE_NOT_FOUND');
      const principal = await authenticate(event);
      if (route === 'POST /players/guest') {
        if (!emptyBody.safeParse(body(event)).success) throw new ApiError(400, 'INVALID_REQUEST');
        const result = await service.createGuest(principal);
        await recordActivity?.(principal);
        return response(result.created ? 201 : 200, result.save);
      }
      await recordActivity?.(principal);
      const save = await service.read(principal);
      return response(200, route.endsWith('/save') ? save : route.endsWith('/progress') ? save.progress : route.endsWith('/wallet') ? save.wallet : save.profile);
    } catch (error) {
      if (error instanceof ApiError) return response(error.status, { error: error.code });
      if (error instanceof Error && ['TooManyRequestsException', 'LimitExceededException'].includes(error.name))
        return response(429, { error: 'RATE_LIMITED' });
      if (error instanceof Error && ['NotAuthorizedException', 'UserNotFoundException', 'PasswordResetRequiredException'].includes(error.name))
        return response(401, { error: 'UNAUTHENTICATED' });
      // Never log error messages, request bodies or SDK command inputs (they can contain credentials).
      console.error(JSON.stringify({ errorType: error instanceof Error ? error.name : 'UnknownError' }));
      if (error instanceof Error && ['TransactionCanceledException', 'TransactionInProgressException', 'ProvisionedThroughputExceededException',
        'InternalServerError', 'ServiceUnavailableException', 'TimeoutError'].includes(error.name))
        return response(503, { error: 'RETRY_SAME_REQUEST' });
      return response(500, { error: 'INTERNAL_ERROR' });
    }
  };
}
let configured: ReturnType<typeof createHandler> | undefined;
export async function handler(event: HttpEvent) {
  if (!process.env.PLAYER_TABLE) return { statusCode: 503, body: JSON.stringify({ error: 'PLAYER_TABLE_NOT_CONFIGURED' }) };
  if (!process.env.USER_POOL_ID || !process.env.USER_POOL_CLIENT_ID || !process.env.COGNITO_ISSUER)
    return { statusCode: 503, body: JSON.stringify({ error: 'AUTH_NOT_CONFIGURED' }) };
  if (!configured) {
    const configs = new GameConfigs();
    const drops = createDropService(process.env.PLAYER_TABLE, configs);
    const players = createDynamoRepository(process.env.PLAYER_TABLE);
    const activity = new PlayerActivity(DynamoDBDocumentClient.from(new DynamoDBClient({})), process.env.PLAYER_TABLE);
    configured = createHandler(new PlayerService(players), cognitoContext,
    new CognitoGuestIdentity(new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'ap-south-1' }),
      process.env.USER_POOL_ID, process.env.USER_POOL_CLIENT_ID), drops, createBonusService(process.env.PLAYER_TABLE, drops, configs),createWorldService(process.env.PLAYER_TABLE,drops,configs), async principal => {
      const playerId = await players.find(principal);
      if (!playerId) throw new ApiError(404, 'PLAYER_NOT_FOUND');
      await activity.record(playerId);
    });
  }
  return configured(event);
}
