/** Difficulty ladder: LEVEL 1 (easiest) to LEVEL 10 (insane). Applied live, never resets mission/score. */

export type DifficultyId = number;

export interface DifficultyDef {
  id: DifficultyId;
  label: string;
  spawn: number;
  enemySpeed: number;
  enemyFire: number; // multiplier, lower = faster enemies
  elite: number; // 0..0.5
  pickup: number;
  scoreMul: number;
}

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 10;
export const DEFAULT_DIFFICULTY: DifficultyId = 4;

const TABLE: Omit<DifficultyDef, "id" | "label">[] = [
  { spawn: 0.5, enemySpeed: 0.75, enemyFire: 1.6, elite: 0, pickup: 2, scoreMul: 0.5 },
  { spawn: 0.7, enemySpeed: 0.85, enemyFire: 1.35, elite: 0.02, pickup: 1.7, scoreMul: 0.7 },
  { spawn: 0.85, enemySpeed: 0.92, enemyFire: 1.15, elite: 0.05, pickup: 1.35, scoreMul: 0.85 },
  { spawn: 1, enemySpeed: 1, enemyFire: 1, elite: 0.08, pickup: 1, scoreMul: 1 },
  { spawn: 1.15, enemySpeed: 1.08, enemyFire: 0.9, elite: 0.12, pickup: 0.9, scoreMul: 1.25 },
  { spawn: 1.35, enemySpeed: 1.18, enemyFire: 0.78, elite: 0.18, pickup: 0.8, scoreMul: 1.5 },
  { spawn: 1.6, enemySpeed: 1.28, enemyFire: 0.65, elite: 0.25, pickup: 0.7, scoreMul: 1.9 },
  { spawn: 2.2, enemySpeed: 1.45, enemyFire: 0.48, elite: 0.35, pickup: 0.55, scoreMul: 3 },
  { spawn: 3, enemySpeed: 1.7, enemyFire: 0.33, elite: 0.5, pickup: 0.45, scoreMul: 5 },
  { spawn: 4, enemySpeed: 1.9, enemyFire: 0.25, elite: 0.6, pickup: 0.4, scoreMul: 8 },
];

export const DIFFICULTY_ORDER: DifficultyDef[] = TABLE.map((t, i) => ({ ...t, id: i + 1, label: `LEVEL ${i + 1}` }));

export const DIFFICULTY_KEY = "space.asteroids.difficulty.v1";

/** Migrate legacy named ids (drift/pilot/veteran/elite/inferno) to the 1-10 ladder. */
const LEGACY_IDS: Record<string, DifficultyId> = { drift: 1, pilot: 4, veteran: 6, elite: 8, inferno: 10 };

export const clampLevel = (n: number): DifficultyId => {
  if (!Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.floor(n)));
};

export const difficultyById = (id: DifficultyId): DifficultyDef =>
  DIFFICULTY_ORDER[clampLevel(Number(id)) - 1]!;

export const difficultyIndex = (id: DifficultyId): number => clampLevel(Number(id)) - 1;

export const normalizeDifficultyId = (raw: unknown): DifficultyId => {
  if (typeof raw === "number" && Number.isFinite(raw)) return clampLevel(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (LEGACY_IDS[trimmed] !== undefined) return LEGACY_IDS[trimmed]!;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return clampLevel(n);
  }
  return DEFAULT_DIFFICULTY;
};

export const stepDifficulty = (id: DifficultyId, delta: 1 | -1): DifficultyDef =>
  difficultyById(clampLevel(Number(id)) + delta);

export const isInferno = (id: DifficultyId): boolean => clampLevel(Number(id)) === LEVEL_MAX;

/** Overdrive fire mode: LEVEL 10 AND adaptive AI enabled. */
export const isInfernoFire = (id: DifficultyId, aiMode: string): boolean =>
  clampLevel(Number(id)) === LEVEL_MAX && aiMode === "adaptive";

export const readDifficulty = (): DifficultyId => {
  try {
    return normalizeDifficultyId(localStorage.getItem(DIFFICULTY_KEY));
  } catch {
    return DEFAULT_DIFFICULTY;
  }
};

export const writeDifficulty = (id: DifficultyId): void => {
  try {
    localStorage.setItem(DIFFICULTY_KEY, String(clampLevel(Number(id))));
  } catch {
    /* Storage is optional. */
  }
};
