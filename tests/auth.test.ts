import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoGuestIdentity } from '../src/auth.js';
import { cognitoContext, createHandler, type HttpEvent } from '../src/handler.js';
import { PlayerService } from '../src/service.js';
import { newSave, type Principal, type Save } from '../src/model.js';
import { starterItems } from '../src/starter.js';
const sub = 'b1111111-1111-4111-8111-111111111111';
const tokenResult = { AccessToken: 'access', IdToken: 'id', RefreshToken: 'refresh', ExpiresIn: 3600, TokenType: 'Bearer' };
function sdk() {
  const send = vi.fn(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'AdminGetUserCommand') return { UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: sub }] };
    if (['AdminInitiateAuthCommand', 'GetTokensFromRefreshTokenCommand'].includes(command.constructor.name))
      return { AuthenticationResult: tokenResult };
    return {};
  });
  return { send, identity: new CognitoGuestIdentity({ send } as unknown as CognitoIdentityProviderClient, 'pool', 'client') };
}
describe('Real Guest credentials', () => {
  it('never accepts a device ID or player ID as a credential', async () => {
    const { send, identity } = sdk();
    await expect(identity.bootstrap('local:known-player')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('uses the same Cognito username on response-loss retries without resetting a confirmed password', async () => {
    const { send, identity } = sdk();
    const first = await identity.bootstrap('a'.repeat(64)), second = await identity.bootstrap('a'.repeat(64));
    expect(first.principal).toEqual(second.principal);
    const names = send.mock.calls.filter(([c]) => c.constructor.name === 'AdminCreateUserCommand')
      .map(([c]) => (c as unknown as { input: { Username: string } }).input.Username);
    expect(names[0]).toBe(names[1]); expect(names[0]).not.toContain('a'.repeat(64));
    expect(send.mock.calls.some(([c]) => c.constructor.name === 'AdminSetUserPasswordCommand')).toBe(false);
  });
  it('recovers after Cognito user creation but before password confirmation', async () => {
    const { send, identity } = sdk();
    send.mockImplementation(async command => {
      if (command.constructor.name === 'AdminCreateUserCommand') throw Object.assign(new Error(), { name: 'UsernameExistsException' });
      if (command.constructor.name === 'AdminGetUserCommand') return { UserStatus: 'FORCE_CHANGE_PASSWORD', UserAttributes: [{ Name: 'sub', Value: sub }] };
      return { AuthenticationResult: tokenResult };
    });
    expect((await identity.bootstrap('b'.repeat(64))).principal.subject).toBe(`pool:${sub}`);
    expect(send.mock.calls.some(([c]) => c.constructor.name === 'AdminSetUserPasswordCommand')).toBe(true);
  });
  it('propagates disabled-user failures instead of enabling users', async () => {
    const { send, identity } = sdk();
    send.mockImplementation(async command => {
      if (command.constructor.name === 'AdminInitiateAuthCommand') throw Object.assign(new Error(), { name: 'NotAuthorizedException' });
      return { UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: sub }] };
    });
    await expect(identity.bootstrap('c'.repeat(64))).rejects.toMatchObject({ name: 'NotAuthorizedException' });
    expect(send.mock.calls.some(([c]) => c.constructor.name === 'AdminEnableUserCommand')).toBe(false);
  });
  it('returns rotated refresh tokens and rejects invalid ones', async () => {
    const { send, identity } = sdk();
    expect((await identity.refresh('old')).refreshToken).toBe('refresh');
    send.mockRejectedValue(Object.assign(new Error(), { name: 'NotAuthorizedException' }));
    await expect(identity.refresh('bad')).rejects.toMatchObject({ status: 401 });
  });
});
describe('JWT and ownership enforcement', () => {
  afterEach(() => vi.unstubAllEnvs());
  function request(patch: Record<string, unknown> = {}): HttpEvent {
    vi.stubEnv('USER_POOL_ID', 'pool'); vi.stubEnv('USER_POOL_CLIENT_ID', 'client'); vi.stubEnv('COGNITO_ISSUER', 'https://issuer');
    return { rawPath: '/players/me', requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: {
      sub, iss: 'https://issuer', client_id: 'client', token_use: 'access', exp: Math.floor(Date.now() / 1000) + 600, ...patch,
    } } } } };
  }
  it.each([{ iss: 'https://attacker' }, { client_id: 'another-app' }, { token_use: 'id' }, { exp: 1 }, { sub: '' }])(
    'rejects a wrong issuer/client/type or expired credential: %j', async patch => {
      await expect(cognitoContext(request(patch))).rejects.toMatchObject({ status: 401 });
    });
  it('resolves ownership only from the authenticated subject', async () => {
    const lookup = vi.fn(async (_p: Principal) => undefined);
    const service = new PlayerService({ find: lookup, read: async () => undefined, create: async () => {} });
    const req = request(); req.body = '{"playerId":"victim"}';
    expect((await createHandler(service)(req)).statusCode).toBe(404);
    expect(lookup).toHaveBeenCalledWith({ provider: 'guest', subject: `pool:${sub}` });
  });
  it('accepts an opaque real Cognito subject without RFC UUID assumptions', async () => {
    expect((await cognitoContext(request({ sub: '41833dea-80a1-7064-48d9-572ee6c23108' }))).subject)
      .toBe('pool:41833dea-80a1-7064-48d9-572ee6c23108');
  });
});
describe('Initial Economy transaction', () => {
  it('records the existing initial grant, balances and stable cause without adding rewards', () => {
    const s = newSave(), p: Principal = { provider: 'guest', subject: `pool:${sub}` };
    const items = starterItems(s, p), receipt = items[1]!;
    expect(receipt).toMatchObject({ operationType: 'starter', causeKey: `starter#${s.profile.playerId}`,
      configVersion: 'starter-v1', deltas: { energy: 50, diamond: 0, yallaPoint: 0 },
      balancesBefore: { energy: 0, diamond: 0, yallaPoint: 0 }, balancesAfter: { energy: 50, diamond: 0, yallaPoint: 0 }, walletVersionAfter: 1 });
    expect(items[2]).toMatchObject({ operationId: receipt.operationId, requestHash: receipt.requestHash });
    expect(items.some(i => 'ttl' in i)).toBe(false);
  });
  it('refuses an accidental change to initial balances', () => {
    const s = newSave(); s.wallet.diamond = 100000;
    expect(() => starterItems(s, { provider: 'guest', subject: 'p' })).toThrow('documented initial balances');
  });
  it('restores the same Player when Cognito succeeds but initial DynamoDB creation fails', async () => {
    const { identity } = sdk(); let stored: Save | undefined, first = true;
    const service = new PlayerService({ find: async () => stored?.profile.playerId, read: async () => stored,
      create: async (_p, s) => { if (first) { first = false; throw new Error('DB unavailable'); } stored = s; } });
    const handle = createHandler(service, cognitoContext, identity);
    const req: HttpEvent = { rawPath: '/auth/guest', body: JSON.stringify({ guestKey: 'd'.repeat(64) }), requestContext: { http: { method: 'POST' } } };
    expect((await handle(req)).statusCode).toBe(500);
    const created = await handle(req), recovered = await handle(req);
    expect(created.statusCode).toBe(201); expect(recovered.statusCode).toBe(200);
    expect(JSON.parse(created.body).save).toEqual(JSON.parse(recovered.body).save);
  });
});
