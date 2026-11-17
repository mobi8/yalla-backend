export const legacyWorlds = ['dunes','canyon','oasis','bazaar','palace','nightcity','goldentemple'] as const;
export const worldIds: readonly string[] = [...legacyWorlds, ...Array.from({length:93},(_,i)=>`world-${String(i+8).padStart(3,'0')}`)];
