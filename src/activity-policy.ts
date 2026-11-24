import { z } from 'zod';

const hourMs = 3_600_000;

export function loadActivityPolicy() {
  const integer = z.coerce.number().int().positive();
  return {
    activityDisplayHours: integer.max(87600).parse(process.env.ACTIVITY_DISPLAY_HOURS ?? 24),
    activityMaxDisplayCount: integer.max(100).parse(process.env.ACTIVITY_MAX_DISPLAY_COUNT ?? 50),
    activityRetentionDays: integer.max(3650).parse(process.env.ACTIVITY_RETENTION_DAYS ?? 30),
  };
}

export type ActivityPolicy = ReturnType<typeof loadActivityPolicy>;

export function activityCutoff(now: number, policy: ActivityPolicy) {
  return now - Math.min(policy.activityDisplayHours, policy.activityRetentionDays * 24) * hourMs;
}

export function activityExpiry(occurredAt: string, policy: ActivityPolicy) {
  return Math.ceil(Date.parse(occurredAt) / 1000) + policy.activityRetentionDays * 86400;
}

export function activityDisplayUntil(occurredAt: unknown, policy: ActivityPolicy, storedExpiry?: number) {
  const time = typeof occurredAt === 'string' ? Date.parse(occurredAt) : NaN;
  return Math.min(time + policy.activityDisplayHours * hourMs,
    time + policy.activityRetentionDays * 24 * hourMs, (storedExpiry ?? Infinity) * 1000);
}
