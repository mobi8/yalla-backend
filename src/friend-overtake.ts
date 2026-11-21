import { decimalString } from './model.js';
import { rankingPeriod } from './journey-read.js';
import { scaled } from './drop-economy.js';
import { playerKey } from './repository.js';
import { notificationEvent, type NotificationEvent } from './notification-events.js';
import type { FriendsStore } from './friends-store.js';

export async function acceptedFriends(store: Pick<FriendsStore,'list'>, player: string) {
  const rows = [];
  const prefix = 'FRIENDS#LIST#';
  let cursor: string | undefined;
  do {
    const page = await store.list(playerKey(player,'').PK,prefix,100,cursor);
    rows.push(...page);
    cursor = page.length === 100 ? page.at(-1)?.SK : undefined;
  } while (cursor);
  return rows;
}

type ScoreLookup = (player: string, start: string, through: string) => Promise<bigint>;
export async function friendCrossings(
  store: Pick<FriendsStore,'list'|'get'>, score: ScoreLookup,
  settlement: { actor: string; round: string; occurredAt: string; added: bigint },
  days: number, now: number, allowBots = false, onlyRecipient?: string,
): Promise<NotificationEvent[]> {
  const {actor, round, occurredAt, added} = settlement;
  const isBot = actor.startsWith('bot-');
  const time = Date.parse(occurredAt);
  const period = rankingPeriod(now, days);
  if (!Number.isFinite(time) || time > now || now - time >= 3_600_000 ||
      occurredAt < period.startsAt || occurredAt >= period.endsAt || added <= 0n || (isBot && !allowBots)) return [];

  const lookup = new Map<string,Promise<bigint>>();
  const distance = (id: string) => {
    if (!lookup.has(id)) lookup.set(id,score(id,period.startsAt,occurredAt));
    return lookup.get(id)!;
  };
  const eligible = await acceptedFriends(store,actor);
  const recipients = eligible.filter(row => typeof row.other === 'string' && !row.other.startsWith('bot-') &&
    typeof row.acceptedAt === 'string' && row.acceptedAt < occurredAt && (!onlyRecipient || row.other === onlyRecipient));
  if (!recipients.length) return [];
  const after = await distance(actor);
  if (after < added) return [];
  const before = after - added;
  const profile = await store.get(playerKey(actor,'PROFILE'));
  const name = typeof profile?.nickname === 'string' ? profile.nickname : isBot ? actor.slice(4) : 'A friend';
  const events: NotificationEvent[] = [];
  for (const row of recipients) {
    const recipient = String(row.other);
    const own = await distance(recipient);
    if (before >= own || after <= own) continue;

    const active = (await acceptedFriends(store,recipient)).filter(friend =>
      typeof friend.acceptedAt === 'string' && friend.acceptedAt < occurredAt);
    if (!active.some(friend => friend.other === actor && friend.SK === row.SK)) continue;
    const scores = await Promise.all(active.map(async friend => {
      const id = String(friend.other);
      return { id, distance: await distance(id) };
    }));
    const rank = 1 + scores.filter(other => other.distance > own ||
      (other.distance === own && other.id.localeCompare(recipient) < 0)).length;
    events.push(notificationEvent.parse({
      eventId: `FRIEND_RANK:${period.startsAt}:${actor}:${round}:${recipient}`,
      eventType: 'RANK_OVERTAKEN', recipientPlayerId: recipient, actorPlayerId: actor,
      actorDisplayName: name.slice(0,100), occurredAt,
      payload: { rank, scope: 'FRIENDS', periodStartsAt: period.startsAt },
    }));
  }
  return events;
}

export function settlementChange(player: string, sk: string, prior: Record<string, unknown>, next: Record<string, unknown>) {
  if (!sk.startsWith('ROUND#') || prior.status === 'SETTLED' || next.status !== 'SETTLED' ||
      typeof next.settledAt !== 'string' || typeof next.rankDistance !== 'string' ||
      !decimalString.safeParse(next.rankDistance).success) return;
  return { actor: player, round: sk.slice(6), occurredAt: next.settledAt, added: scaled(next.rankDistance) };
}
