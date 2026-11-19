import { readFileSync } from 'node:fs';
import { DEFAULT_BOTS } from '../src/bots-config.js';
import { parseConfig } from '../src/game-config.js';
import { describe, it, expect, vi } from 'vitest';
import { GetCommand, NumberValue, TransactGetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { decimalString, longString, newSave, progressSchema, type Save, type Principal } from '../src/model.js';
import { DynamoPlayerRepository, authKey, type PlayerRepository } from '../src/repository.js';
import { PlayerService } from '../src/service.js';
import { createHandler, cognitoContext, type HttpEvent } from '../src/handler.js';

const principal: Principal = { provider: 'guest', subject: 'verified-subject' };
const save = () => newSave('2026-11-16T00:00:00.000Z');
function memory() {
  let stored: Save | undefined;
  const repository: PlayerRepository = {
    find: vi.fn(async () => stored?.profile.playerId), read: vi.fn(async () => stored),
    create: vi.fn(async (_p, candidate) => { if (stored) throw new Error('Conflict'); stored = candidate; }),
  };
  return repository;
}
const claims = { sub: 'b1111111-1111-4111-8111-111111111111', iss: 'https://issuer', client_id: 'test-client', token_use: 'access', exp: 4102444800 };
process.env.USER_POOL_ID = 'ap-south-1_test'; process.env.USER_POOL_CLIENT_ID = 'test-client'; process.env.COGNITO_ISSUER = 'https://issuer';
function event(method: string, path: string, body?: string): HttpEvent {
  return { rawPath: path, body, requestContext: { http: { method }, authorizer: { jwt: { claims } } } };
}
function dynamo() {
  const send = vi.fn();
  return { send, repository: new DynamoPlayerRepository({ send } as unknown as DynamoDBDocumentClient, 'test-table', { load: async name =>
    parseConfig(name, readFileSync(new URL(`../config/dev/${name}.json`, import.meta.url), 'utf8'), 'dev') },
  { load: async () => DEFAULT_BOTS }) };
}
describe('Unity-compatible models', () => {
  it('uses the existing profile and progress defaults and a server UUID', () => {
    const s = save();
    expect(s.profile.playerId).toMatch(/^[a-f0-9-]{36}$/);
    expect(save().profile.playerId).not.toBe(s.profile.playerId);
    expect(s.profile.nickname).toBe('YOU');
    expect(s.profile.avatarId).toBe('ae6a6b0db4994642a1b45102daa825bd');
    expect(s.progress).toMatchObject({ worldId: 'dunes', village: 1, facilityLevels: [1, 1, 1, 1, 1],
      worldRunId: 'legacy:dunes', highestUnlockedWorld: 0, distance: '0', constructionStars: '0' });
    expect(s.wallet).toMatchObject({ energy: 50, diamond: 0, yallaPoint: 0, energyRechargeAnchor: '0' });
  });
  it('preserves C# decimal precision and rejects overflow/numeric transport', () => {
    for (const value of ['0', '0.0000000000000000000000000001', '79228162514264337593543950335', '12345678901234567890.12345678'])
      expect(decimalString.parse(value)).toBe(value);
    for (const value of [0.1, '-1', '1e3', '79228162514264337593543950336', '0.00000000000000000000000000001'])
      expect(decimalString.safeParse(value).success).toBe(false);
    expect(longString.parse('9223372036854775807')).toBe('9223372036854775807');
    expect(longString.safeParse('9223372036854775808').success).toBe(false);
  });
  it('rejects broken progress instead of replacing it with fresh data', () => {
    for (const patch of [{ village: 0 }, { facilityLevels: [1, 1] }, { facilityLevels: [1, 1, 1, 1, 6] },
      { worldId: 'oasis' }, { worldRunComplete: true }, { distance: null }, { constructionStars: '-1' }])
      expect(progressSchema.safeParse({ ...save().progress, ...patch }).success).toBe(false);
  });
});
describe('Guest creation and recovery', () => {
  it('returns the same ID on repeated authenticated requests', async () => {
    const repository = memory(), service = new PlayerService(repository, save);
    const first = await service.createGuest(principal), second = await service.createGuest(principal);
    expect(first.created).toBe(true); expect(second.created).toBe(false);
    expect(second.save).toEqual(first.save); expect(repository.create).toHaveBeenCalledTimes(1);
  });
  it('restores an existing above-cap wallet without applying the new initial grant', async () => {
    const existing = save(); existing.wallet.energy = 200; existing.wallet.diamond = 20000;
    const create = vi.fn(), makeSave = vi.fn(save);
    const service = new PlayerService({ find: async () => existing.profile.playerId,
      read: async () => existing, create }, makeSave);
    expect(await service.createGuest(principal)).toEqual({ created: false, save: existing });
    expect(create).not.toHaveBeenCalled(); expect(makeSave).not.toHaveBeenCalled();
    expect(await service.read(principal)).toEqual(existing);
  });
  it('recovers the winning player under concurrent create requests', async () => {
    const service = new PlayerService(memory(), save);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.createGuest(principal)));
    expect(new Set(results.map(r => r.save.profile.playerId)).size).toBe(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
  });
  it('recovers a committed create after response loss', async () => {
    const repository = memory(), original = repository.create;
    repository.create = async (p, s) => { await original(p, s); throw new Error('Timeout'); };
    const result = await new PlayerService(repository, save).createGuest(principal);
    expect(result.created).toBe(false); expect(result.save.profile.playerId).toBeTruthy();
  });
  it('does not reinterpret an unknown transaction outcome as success', async () => {
    const repository = memory(); repository.create = async () => { throw new Error('Timeout'); };
    await expect(new PlayerService(repository).createGuest(principal)).rejects.toThrow('Timeout');
  });
  it('does not create Apple/Google players through the guest API', async () => {
    await expect(new PlayerService(memory()).createGuest({ provider: 'apple', subject: 'a' })).rejects.toMatchObject({ status: 403 });
  });
});
describe('HTTP boundaries', () => {
  it('creates and reads profile, progress and the save projection', async () => {
    const handle = createHandler(new PlayerService(memory(), save));
    const created = await handle(event('POST', '/players/guest', '{}'));
    expect(created.statusCode).toBe(201);
    expect((await handle(event('POST', '/players/guest'))).statusCode).toBe(200);
    for (const path of ['/players/me', '/players/me/save', '/players/me/progress'])
      expect((await handle(event('GET', path))).statusCode).toBe(200);
    const snapshot = JSON.parse((await handle(event('GET', '/players/me/save'))).body);
    expect(snapshot).toEqual(JSON.parse(created.body));
  });
  it('records authenticated heartbeats and game activity without editing the save', async () => {
    const repo = memory(), recordActivity = vi.fn();
    const handle = createHandler(new PlayerService(repo, save), undefined, undefined, undefined, undefined, undefined, recordActivity);
    const unauthorized = event('POST', '/players/me/heartbeat');
    delete unauthorized.requestContext.authorizer;
    expect((await handle(unauthorized)).statusCode).toBe(401);
    expect(recordActivity).not.toHaveBeenCalled();
    const created = await handle(event('POST', '/players/guest', '{}'));
    const heartbeat = await handle(event('POST', '/players/me/heartbeat'));
    expect(heartbeat).toMatchObject({statusCode: 204, body: ''});
    const snapshot = await handle(event('GET', '/players/me/save'));
    expect(JSON.parse(snapshot.body)).toEqual(JSON.parse(created.body));
    expect(recordActivity).toHaveBeenCalledTimes(3);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
  it('denies missing authentication even if a player ID is submitted', async () => {
    const handle = createHandler(new PlayerService(memory()));
    const request = event('POST', '/players/guest', '{"playerId":"victim"}');
    delete request.requestContext.authorizer;
    expect((await handle(request)).statusCode).toBe(401);
  });
  it.each(['{"playerId":"victim"}', '{"energy":200}', '{"progress":{}}', 'null', '[]', 'invalid'])(
    'rejects client-controlled state: %s', async body => {
      const repo = memory();
      expect((await createHandler(new PlayerService(repo))(event('POST', '/players/guest', body))).statusCode).toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  it('returns 404 without inventing fresh data; does not expose save mutation/reset', async () => {
    const handle = createHandler(new PlayerService(memory()));
    expect((await handle(event('GET', '/players/me/save'))).statusCode).toBe(404);
    expect((await handle(event('PUT', '/players/me/save', '{}'))).statusCode).toBe(404);
    expect((await handle(event('POST', '/players/me/reset'))).statusCode).toBe(404);
  });
});
describe('DynamoDB contracts (mocked SDK, no AWS calls)', () => {
  it('uses provider-scoped auth keys and strongly consistent identity lookup', async () => {
    const { send, repository } = dynamo(); send.mockResolvedValue({});
    await repository.find(principal);
    expect(send.mock.calls[0]![0].input).toMatchObject({ Key: authKey(principal), ConsistentRead: true });
    expect(authKey({ ...principal, provider: 'google' })).not.toEqual(authKey(principal));
  });
  it('composes all required items in one conditional transaction using exact numbers', async () => {
    const { send, repository } = dynamo(); send.mockResolvedValue({});
    const s = save(); s.profile.nickname = 'Desert Rider'; s.progress.distance = '12345678901234567890.12345678';
    await repository.create(principal, s);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(8);
    expect(command.input.TransactItems?.find(write => write.Put?.Item?.SK === 'BONUS#STATE')?.Put?.Item?.raid.bots).toHaveLength(10);
    expect(command.input.TransactItems?.every(w => w.Put?.ConditionExpression === 'attribute_not_exists(PK)')).toBe(true);
    expect(command.input.TransactItems?.[2]?.Put?.Item?.distance.toString()).toBe(s.progress.distance);
  });
  it('reads a transactional snapshot and preserves exact decimals and long counters', async () => {
    const { send, repository } = dynamo(), s = save();
    send.mockResolvedValue({ Responses: [{ Item: { ...s.profile, nickname: 'Desert Rider' } }, { Item: { ...s.progress,
      distance: NumberValue.from('12345678901234567890.12345678'),
      constructionStars: NumberValue.from('9223372036854775807'), lastDistanceMilestone: 0 } }, { Item: s.wallet }] });
    const result = await repository.read(s.profile.playerId);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(TransactGetCommand);
    expect(result?.progress.distance).toBe('12345678901234567890.12345678');
    expect(result?.progress.constructionStars).toBe('9223372036854775807');
    expect(result?.progress.lastDistanceMilestone).toBe('0');
  });
  it('does not repair an incomplete save silently', async () => {
    const { send, repository } = dynamo(); send.mockResolvedValue({ Responses: [{ Item: save().profile }, {}] });
    await expect(repository.read(save().profile.playerId)).rejects.toThrow('Incomplete player save');
  });
  it('restores DynamoDB exponent notation without a floating point conversion', async () => {
    const { send, repository } = dynamo(), s = save();
    send.mockResolvedValue({ Responses: [{ Item: { ...s.profile, nickname: 'Desert Rider' } }, { Item: { ...s.progress, distance: NumberValue.from('1E-28') } }, { Item: s.wallet }] });
    expect((await repository.read(s.profile.playerId))?.progress.distance).toBe('0.0000000000000000000000000001');
  });
  it('does not return another identity or expose stored validation details', async () => {
    const { send, repository } = dynamo(), s = save();
    send.mockResolvedValue({ Responses: [{ Item: s.profile }, { Item: s.progress }, { Item: s.wallet }] });
    await expect(repository.read(save().profile.playerId)).rejects.toThrow('Player identity mismatch');
  });
});

describe('Persistent default nickname assignment', () => {
  function nicknameTable() {
    const { send, repository } = dynamo();
    const data = new Map<string, Record<string, any>>();
    const key = (item: Record<string, any>) => `${item.PK}/${item.SK}`;
    const conflict = () => Object.assign(new Error('Concurrent write'), {
      name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    send.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: data.get(key(command.input.Key!)) };
      if (command instanceof TransactGetCommand)
        return { Responses: command.input.TransactItems!.map(({ Get }) => ({ Item: data.get(key(Get!.Key!)) })) };
      const puts = (command as TransactWriteCommand).input.TransactItems!.map(item => item.Put!);
      for (const put of puts) {
        const item = data.get(key(put.Item!));
        const values = put.ExpressionAttributeValues;
        if (put.ConditionExpression === 'attribute_not_exists(PK)' ? item !== undefined
          : put.Item!.SK === 'COUNTER' ? item?.lastNumber !== values?.[':last']
          : item?.version !== values?.[':version'] || item?.nickname !== values?.[':previous']) throw conflict();
      }
      for (const put of puts) data.set(key(put.Item!), put.Item!);
      return {};
    });
    return { repository, data };
  }

  it('assigns unique names to parallel guests and reuses each committed profile on reconnect', async () => {
    const { repository, data } = nicknameTable();
    const service = new PlayerService(repository, save);
    const guests = Array.from({ length: 8 }, (_, i) => ({ ...principal, subject: `guest-${i}` }));
    const results = await Promise.all(guests.map(guest => service.createGuest(guest)));
    expect(results.map(r => r.save.profile.nickname).sort()).toEqual(guests.map((_, i) => `Player 000${i + 1}`));
    const reconnects = await Promise.all(guests.map(guest => service.read(guest)));
    expect(reconnects).toEqual(results.map(r => r.save));
    expect(data.get('SYSTEM#PLAYER_NICKNAME/COUNTER')?.lastNumber).toBe(8);
  });

  it('shares the sequence with legacy repairs and preserves an existing nickname and UUID', async () => {
    const { repository, data } = nicknameTable();
    const service = new PlayerService(repository, save);
    const { save: first } = await service.createGuest(principal);
    expect(first.profile.nickname).toBe('Player 0001');
    const legacy = ['YOU', '', '  ', undefined, null, 'Desert Rider', 'You'].map(nickname => ({ ...save().profile, nickname }));
    for (const profile of legacy)
      data.set(`PLAYER#${profile.playerId}/PROFILE`, profile);
    const profiles = await Promise.all([...legacy, legacy[0]!].map(profile => repository.ensureProfileNickname(profile.playerId)));
    expect(profiles.slice(0, 5).map(profile => profile?.nickname).sort())
      .toEqual(['Player 0002', 'Player 0003', 'Player 0004', 'Player 0005', 'Player 0006']);
    expect(profiles[5]).toEqual(legacy[5]);
    expect(profiles[6]).toEqual(legacy[6]);
    expect(profiles[0]).toEqual(profiles[7]);
    expect(profiles[0]?.playerId).toBe(legacy[0]?.playerId);
  });
});
