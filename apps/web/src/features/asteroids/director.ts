/** Local AI director: fair difficulty without any network calls. Decided at 2Hz. */
import type { DifficultyDef } from "./difficulty.js";

export type DirectorZone = "calm" | "tense" | "brutal";
export interface DirectorStats {
  accuracy: number; // 0..1
  deaths: number; // recent deaths in window
  combo: number;
  clearTime: number; // seconds for last sector
  dashUses: number;
  score: number;
  sector: number;
}
export interface DirectorModifier {
  spawnRate: number; // 0.6..1.6
  enemySpeed: number; // 0.8..1.4
  fireCooldown: number; // 0.7..1.4 (multiplier, lower = faster enemies)
  eliteChance: number; // 0..0.35
  pickupRate: number; // 0.6..1.8
  zone: DirectorZone;
}

export interface DirectorState {
  zone: DirectorZone;
  window: DirectorStats[];
  modifier: DirectorModifier;
}

export const emptyDirector = (): DirectorState => ({
  zone: "tense",
  window: [],
  modifier: { spawnRate: 1, enemySpeed: 1, fireCooldown: 1, eliteChance: 0.08, pickupRate: 1, zone: "tense" },
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function updateDirector(state: DirectorState, sample: DirectorStats): DirectorModifier {
  state.window.push(sample);
  if (state.window.length > 6) state.window.shift();
  const n = state.window.length || 1;
  const avgAcc = state.window.reduce((s, w) => s + w.accuracy, 0) / n;
  const deaths = state.window.reduce((s, w) => s + w.deaths, 0);
  const avgCombo = state.window.reduce((s, w) => s + w.combo, 0) / n;

  let zone: DirectorZone = "tense";
  if (deaths >= 2 || avgAcc < 0.25) zone = "calm";
  else if (avgAcc > 0.7 || avgCombo >= 8) zone = "brutal";

  state.zone = zone;
  const m: DirectorModifier =
    zone === "calm"
      ? { spawnRate: 0.7, enemySpeed: 0.85, fireCooldown: 1.3, eliteChance: 0.03, pickupRate: 1.6, zone }
      : zone === "brutal"
        ? { spawnRate: 1.4, enemySpeed: 1.25, fireCooldown: 0.75, eliteChance: 0.22, pickupRate: 0.7, zone }
        : { spawnRate: 1, enemySpeed: 1, fireCooldown: 1, eliteChance: 0.08, pickupRate: 1, zone };
  state.modifier = m;
  return m;
}

/**
 * Layer the selected difficulty ladder on top of the local director zone.
 * Keeps the director fair/playstyle-aware while the difficulty sets the base pressure.
 */
export function scaleModifierForDifficulty(base: DirectorModifier, difficulty: DifficultyDef): DirectorModifier {
  return {
    spawnRate: base.spawnRate * difficulty.spawn,
    enemySpeed: base.enemySpeed * difficulty.enemySpeed,
    fireCooldown: base.fireCooldown * difficulty.enemyFire,
    eliteChance: Math.max(0, Math.min(0.5, base.eliteChance + difficulty.elite - 0.08)),
    pickupRate: base.pickupRate * difficulty.pickup,
    zone: base.zone,
  };
}

/** LLM event modifier (validated + clamped). Applied for ~20s on top of local. */
export type LLMEvent = "ambush" | "storm" | "elite-pack" | "calm" | "boss-rage" | "none";
export interface LLMModifier {
  event: LLMEvent;
  threat: number; // 0..1
  spawnRate: number; // 0.7..1.5
  taunt: string; // English, max 60 chars, display only
}

export function validateLLMModifier(raw: unknown): LLMModifier | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const event = r.event;
  const valid: LLMEvent[] = ["ambush", "storm", "elite-pack", "calm", "boss-rage", "none"];
  if (typeof event !== "string" || !valid.includes(event as LLMEvent)) return null;
  const threat = Number(r.threat);
  const spawnRate = Number(r.spawnRate);
  const taunt = String(r.taunt ?? "");
  if (!Number.isFinite(threat) || !Number.isFinite(spawnRate)) return null;
  if (taunt.length > 60) return null;
  // ASCII printable only for HUD safety; keep English-only.
  if (taunt && /[^\x20-\x7E]/.test(taunt)) return null;
  return { event: event as LLMEvent, threat: clamp(threat, 0, 1), spawnRate: clamp(spawnRate, 0.7, 1.5), taunt };
}
