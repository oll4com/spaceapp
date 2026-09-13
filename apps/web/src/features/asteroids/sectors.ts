export type Biome = "launch" | "drift" | "storm";
export type BossKind = "none" | "sentinel" | "warden" | "hive";
export type Hazard = "gust" | "debris" | "fog";
export type EnemyMix = Partial<Record<"drifter" | "weaver" | "gunship" | "kamikaze" | "splitter" | "shielder" | "miner", number>>;

export interface SectorDef {
  sector: number;
  name: string;
  biome: Biome;
  rocks: number;
  enemies: EnemyMix;
  hazards: Hazard[];
  boss: BossKind;
  music: number;
}

/** 12 hand-tuned sectors. Sector 13+ uses endlessSector(). */
const TABLE: SectorDef[] = [
  { sector: 1, name: "Launch orbit", biome: "launch", rocks: 3, enemies: {}, hazards: [], boss: "none", music: 108 },
  { sector: 2, name: "First debris", biome: "launch", rocks: 4, enemies: {}, hazards: [], boss: "none", music: 110 },
  { sector: 3, name: "Weaver nests", biome: "launch", rocks: 4, enemies: { weaver: 2 }, hazards: [], boss: "none", music: 112 },
  { sector: 4, name: "Neon approach", biome: "launch", rocks: 5, enemies: { weaver: 2, splitter: 1 }, hazards: [], boss: "none", music: 114 },
  { sector: 5, name: "Sentinel encounter", biome: "drift", rocks: 3, enemies: { weaver: 2 }, hazards: [], boss: "sentinel", music: 118 },
  { sector: 6, name: "Neon drift", biome: "drift", rocks: 6, enemies: { weaver: 2, gunship: 1 }, hazards: [], boss: "none", music: 118 },
  { sector: 7, name: "Minefield run", biome: "drift", rocks: 6, enemies: { gunship: 2, miner: 1 }, hazards: ["debris"], boss: "none", music: 120 },
  { sector: 8, name: "The debris belt", biome: "drift", rocks: 7, enemies: { kamikaze: 2, gunship: 1, shielder: 1 }, hazards: ["debris"], boss: "none", music: 122 },
  { sector: 9, name: "Solar storm", biome: "storm", rocks: 7, enemies: { kamikaze: 2, weaver: 3 }, hazards: ["gust"], boss: "none", music: 124 },
  { sector: 10, name: "Warden vigil", biome: "storm", rocks: 4, enemies: { gunship: 2, shielder: 1 }, hazards: ["gust"], boss: "warden", music: 126 },
  { sector: 11, name: "Ion fog", biome: "storm", rocks: 8, enemies: { weaver: 3, kamikaze: 2, miner: 1 }, hazards: ["gust", "fog"], boss: "none", music: 128 },
  { sector: 12, name: "Hive depths", biome: "storm", rocks: 5, enemies: { weaver: 4, splitter: 2 }, hazards: ["fog"], boss: "hive", music: 130 },
];

export function getSectorDef(sector: number): SectorDef {
  if (sector >= 1 && sector <= TABLE.length) return TABLE[sector - 1]!;
  return endlessSector(sector);
}

/** Endless scaling past 12: harder mixes, boss every 5th. */
export function endlessSector(sector: number): SectorDef {
  const over = sector - 12;
  const boss: BossKind = sector % 5 === 0 ? (["sentinel", "warden", "hive"] as const)[Math.floor(sector / 5) % 3]! : "none";
  return {
    sector,
    name: sector % 5 === 0 ? "Deep sentinel" : "Deep void",
    biome: "storm",
    rocks: Math.min(10, 7 + Math.floor(over / 2)),
    enemies: {
      weaver: Math.min(5, 2 + Math.floor(over / 3)),
      gunship: Math.min(4, 1 + Math.floor(over / 4)),
      kamikaze: Math.min(4, 1 + Math.floor(over / 4)),
      shielder: over >= 4 ? 1 : 0,
      miner: over >= 3 ? 1 : 0,
    },
    hazards: over >= 2 ? ["gust", "fog"] : ["gust"],
    boss,
    music: 132,
  };
}

/** Legacy 5-name cycle kept for HUD compat during migration. */
export const SECTOR_NAMES = ["Launch orbit", "Neon drift", "The debris belt", "Solar storm", "Sentinel encounter"];
