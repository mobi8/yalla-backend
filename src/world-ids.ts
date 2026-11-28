import { z } from 'zod';

export const legacyWorlds = ['dunes','canyon','oasis','bazaar','palace','nightcity','goldentemple'] as const;

export function worldIdAt(index: number): string {
  return legacyWorlds[index] ?? `world-${String(index + 1).padStart(3, '0')}`;
}

export function worldIndex(id: string): number {
  const legacy = legacyWorlds.findIndex(world => world === id);
  if (legacy >= 0) return legacy;
  const match = /^world-(\d{3,10})$/.exec(id);
  const order = Number(match?.[1]);
  return order >= 8 && order <= 2147483647 && id === worldIdAt(order - 1)
    ? order - 1 : -1;
}

export const worldIdSchema = z.string().refine(id => worldIndex(id) >= 0);
