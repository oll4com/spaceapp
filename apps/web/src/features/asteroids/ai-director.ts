import { validateLLMModifier, type LLMModifier } from "./director.js";

export interface AISnapshot {
  score: number;
  sector: number;
  accuracy: number;
  deaths: number;
  combo: number;
  playstyle: "aggressive" | "evasive" | "sniper" | "balanced";
}

const ENDPOINT = "/api/asteroids/direct";
const NORMAL_THROTTLE_MS = 25_000;
const INFERNO_THROTTLE_MS = 10_000;
let lastCall = 0;
let cached: LLMModifier | null = null;
let disabled = false;

export function disableAIDirector() { disabled = true; }
export function lastAIModifier(): LLMModifier | null { return cached; }
export function aiThrottleMs(infernoFire: boolean): number {
  return infernoFire ? INFERNO_THROTTLE_MS : NORMAL_THROTTLE_MS;
}
export function resetAIDirectorForTests() { lastCall = 0; cached = null; disabled = false; }

/** Throttled client: at most one call per 25s (10s in inferno fire), 12s timeout, never throws. Non-blocking: applied when it lands. */
export async function fetchAIModifier(
  snapshot: AISnapshot,
  fetchFn: typeof fetch = fetch,
  opts?: { infernoFire?: boolean },
): Promise<LLMModifier | null> {
  if (disabled) return null;
  const throttle = aiThrottleMs(opts?.infernoFire === true);
  const now = Date.now();
  if (now - lastCall < throttle) return cached;
  lastCall = now;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return cached;
    const data = await res.json();
    const valid = validateLLMModifier(data);
    if (valid) cached = valid;
    return cached;
  } catch {
    return cached;
  }
}
