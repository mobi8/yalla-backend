import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DynamoFriendsRankingStore, FriendsRankingService } from '../src/friends-ranking.js';
import { type Item, type Key } from '../src/friends-store.js';
import { friendRankKeys, journeyReadKeys } from '../src/journey-read-keys.js';
import { newSave } from '../src/model.js';
import { decodeProgress, encodeProgress, playerKey } from '../src/repository.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const date = Date.parse('2026-11-23T00:00:00Z');
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
function fixture() {
  const rows = new Map<string, Item>();
  const scoreboard = new Map<string, ReturnType<typeof friendRankKeys>>();
  let now = date;
  let snapshot: Awaited<ReturnType<DynamoFriendsRankingStore['snapshot']>>;
  const key = ({PK, SK}: Key) => `${PK}/${SK}`;
  const list = vi.fn(async (PK: string, prefix: string) =>
    [...rows.values()].filter(row => row.PK === PK && row.SK.startsWith(prefix)));
  const batch = vi.fn(async (keys: Key[]) => keys.flatMap(item => rows.get(key(item)) ?? []));
  const top = vi.fn(async (metric: 'stars' | 'distance') => {
    const column = metric === 'stars' ? 'friendsStarsSK' : 'friendsDistanceSK';
    return [...scoreboard].sort((a,b) => a[1][column] < b[1][column] ? 1 : -1).slice(0,100)
      .map(([playerId]) => {
        const value = decodeProgress(rows.get(key(playerKey(playerId,'PROGRESS')))!);
        return {playerId, stars:value.constructionStars, distanceMeters:value.distance};
      });
  });
  const publish = vi.fn(async (next: NonNullable<typeof snapshot>) => {
    if (snapshot && snapshot.day >= next.day) return false;
    snapshot = next;
    return true;
  });
  const service = new FriendsRankingService({list,batch,top,publish,snapshot:async () => snapshot}, () => now);
  function player(playerId: string, stars: string, distance: string) {
    const progress = {...newSave().progress, constructionStars:stars,distance};
    const row = {...playerKey(playerId,'PROGRESS'),...encodeProgress(progress),...journeyReadKeys(playerId,'PROGRESS',progress)};
    rows.set(key(row),row);
    scoreboard.set(playerId,friendRankKeys(distance,stars,playerId));
    const profile = {...playerKey(playerId,'PROFILE'),nickname:playerId,avatarId:'avatar'};
    rows.set(key(profile),profile);
  }
  function member(player: string, other: string, type: 'LIST' | 'IN' | 'OUT' = 'LIST') {
    const row = {...playerKey(player,`FRIENDS#${type}#${randomUUID()}`),other};
    rows.set(key(row),row);
    return () => rows.delete(key(row));
  }
  return {service,player,member,top,batch,publish, tick:(ms:number) => {now += ms;}};
}

describe('Cumulative FRIENDS ranking', () => {
  it('uses authoritative cumulative stats, accepted friends and self with two deterministic orders', async () => {
    const f = fixture();
    const a = id(1), b = id(2), c = id(3), d = id(4);
    f.player(a,'10','50.123'); f.player(b,'10','60'); f.player(c,'10','60'); f.player(d,'99','999');
    const initial = await f.service.get(a,'friends');
    expect(initial.entries.map(row => row.playerId)).toEqual([a]);
    expect(initial.me).toEqual({stars:1,distance:1});
    const remove = f.member(a,b); f.member(a,c); f.member(a,d,'IN'); f.member(a,'bot-player_1001');
    const ranked = await f.service.get(a,'friends');
    expect(ranked.entries.map(row => row.playerId)).toEqual([c,b,a]);
    expect(ranked.me).toEqual({stars:3,distance:3});
    expect(ranked.entries.at(-1)).toMatchObject({me:true,stars:'10',distanceMeters:'50.123'});
    f.player(a,'20','55');
    expect((await f.service.get(a,'friends')).me).toEqual({stars:1,distance:3});
    remove();
    expect((await f.service.get(a,'friends')).entries).toHaveLength(2);
    expect(f.batch.mock.calls[2]?.[0]).toHaveLength(3);
  });

  it('publishes two TOP 100 lists once per UTC day and keeps the last result on failure', async () => {
    const f = fixture();
    for (let i = 0; i <= 101; i++) f.player(id(i),String(i),String(i));
    f.player(id(101),'101','0');
    const missing = await f.service.get(id(0),'global');
    expect(missing).toMatchObject({capturedAt:null,me:{stars:null,distance:null},entries:[]});
    expect(f.top).not.toHaveBeenCalled();
    expect(await f.service.refreshGlobal()).toBe(true);
    expect(await f.service.refreshGlobal()).toBe(false);
    const snapshot = await f.service.get(id(0),'global');
    expect(snapshot).toMatchObject({capturedAt:'2026-11-23T00:00:00.000Z',nextRefreshAt:'2026-11-24T00:00:00.000Z',
      me:{stars:null,distance:null}});
    for (const metric of ['stars','distance'] as const)
      expect(snapshot.entries.filter(row => row.ranks[metric] != null)).toHaveLength(100);
    expect(snapshot.entries.find(row => row.playerId === id(101))?.ranks).toEqual({stars:1,distance:null});
    expect(snapshot.entries.find(row => row.playerId === id(100))?.ranks.distance).toBe(1);
    f.tick(24 * 60 * 60 * 1000);
    f.top.mockRejectedValueOnce(new Error('Read failed'));
    await expect(f.service.refreshGlobal()).rejects.toThrow('Read failed');
    expect((await f.service.get(id(0),'global')).capturedAt).toBe(snapshot.capturedAt);
    expect(await f.service.refreshGlobal()).toBe(true);
    expect(f.publish).toHaveBeenCalledTimes(2);
  });

  it('batches by DynamoDB limits and queries only the highest 100 keys for each metric', async () => {
    const send = vi.fn().mockResolvedValue({});
    const db = new DynamoFriendsRankingStore({send} as unknown as DynamoDBDocumentClient,'test-table');
    await db.batch(Array.from({length:205}, (_,i) => playerKey(id(i),'PROFILE')));
    expect(send.mock.calls.map(([cmd]) => cmd.input.RequestItems['test-table'].Keys.length)).toEqual([100,100,5]);
    send.mockClear();
    await db.top('stars'); await db.top('distance');
    expect(send.mock.calls.map(([cmd]) => cmd.input)).toEqual([
      expect.objectContaining({IndexName:'FriendsRankStars',Limit:100,ScanIndexForward:false}),
      expect.objectContaining({IndexName:'FriendsRankDistance',Limit:100,ScanIndexForward:false}),
    ]);
  });
});
