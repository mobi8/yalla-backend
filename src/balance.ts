// Missing legacy timestamps start now; never grant shields for unknown elapsed time.
export function regenBot<T extends { shieldCount: number; shieldRegenAt?: string | null }>(bot: T, now: number, hours: number): T {
  if (bot.shieldCount >= 3) return bot.shieldRegenAt == null ? bot : { ...bot, shieldRegenAt: null };
  const start = typeof bot.shieldRegenAt === 'string' ? Date.parse(bot.shieldRegenAt) : NaN;
  if (!Number.isFinite(start) || start > now) return { ...bot, shieldRegenAt: new Date(now).toISOString() };
  const interval = hours * 3600000;
  const gained = Math.min(3 - bot.shieldCount, Math.floor((now - start) / interval));
  if (!gained) return bot;
  const count = bot.shieldCount + gained;
  return { ...bot, shieldCount: count, shieldRegenAt: count >= 3 ? null : new Date(start + gained * interval).toISOString() };
}
