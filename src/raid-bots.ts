import { regenBot } from './balance.js';
import { type BotsConfig } from './bots-config.js';
import type { GameConfig } from './game-config.js';
import type { Save } from './model.js';

type Item = Record<string, any>;

export function mirrorBots(progress: Save['progress'], config: GameConfig<'raid'>, previous: Item[], botConfig?: BotsConfig) {
  const current = (botConfig?.bots ?? config.data.botTemplates).map(template => {
    const botId = `bot:${encodeURIComponent(progress.worldId)}:v${progress.village}:${template.id}`;
    return previous.find(b => b.botId === botId) ?? { botId, profileTemplateId: template.id,
      worldId: progress.worldId, village: progress.village, facilityLevels: [...config.data.initialFacilityLevels],
      shieldCount: config.data.initialShieldCounts[config.data.botTemplates.findIndex(t=>t.id===template.id)] ?? 0, stateVersion: 1 };
  });
  const existingIds = new Set(previous.map(b => b.botId));
  return [...previous, ...current.filter(bot => !existingIds.has(bot.botId))];
}
export function syncRaidBots(progress: Save['progress'], config: GameConfig<'raid'>, settings: BotsConfig, previous: Item[], now: number) {
  return regenerateRaidBots(mirrorBots(progress, config, previous, settings), settings, now);
}

export function regenerateRaidBots(bots: Item[], settings: BotsConfig, now: number) {
  return bots.map(bot => regenBot(bot as Item & { shieldCount: number }, now, settings.shield.regenHours));
}

export function newBonusState(updatedAt: string, bots: Item[] = []) {
  return { schemaVersion: 1, version: 1, updatedAt, queue: [], run: null, jackpot: null,
    raid: { bots, activities: [], activeRaid: null } };
}
