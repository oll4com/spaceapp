/**
 * Retry hints and backoff, ported from codex-lb `app/core/utils/retry.py` (MIT, Soju06/codex-lb).
 */
const unitAlternation = "ms|milliseconds?|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s";
// A unit is valid only when no letter follows it, so `m` never swallows the start of `month`.
const unitBoundary = "(?![A-Za-z])";
const retryPattern = new RegExp(`try again in\\s*((?:\\d+(?:\\.\\d+)?\\s*(?:${unitAlternation})${unitBoundary}\\s*)+)`, "i");
const durationToken = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitAlternation})${unitBoundary}`, "gi");

const unitSeconds: Record<string, number> = {
  ms: 0.001, millisecond: 0.001, milliseconds: 0.001,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1
};

/** Reads "try again in 6m0s" style hints (compound units included); null when there is none. */
export function parseRetryAfter(message: string | null | undefined): number | null {
  const match = retryPattern.exec(message ?? "");
  if (!match) return null;
  let total = 0;
  let matched = false;
  for (const [, value, unit] of match[1]!.matchAll(durationToken)) {
    const multiplier = unitSeconds[unit!.toLowerCase()];
    if (multiplier === undefined) continue;
    total += Number(value) * multiplier;
    matched = true;
  }
  return matched ? total : null;
}

const backoffInitialDelayMs = 200;
const backoffFactor = 2;
const backoffJitterMin = 0.9;
const backoffJitterMax = 1.1;

/** Exponential backoff with ±10% jitter, in seconds. */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, attempt);
  const base = backoffInitialDelayMs * backoffFactor ** (safeAttempt - 1);
  const jitter = backoffJitterMin + random() * (backoffJitterMax - backoffJitterMin);
  return (base * jitter) / 1000;
}
