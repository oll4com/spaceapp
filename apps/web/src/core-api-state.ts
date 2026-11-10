/** Past this the global banner shows the outage (calm: Space restarts take a few seconds, the proxy holds GETs for 10). */
export const CORE_API_RECOVERY_WINDOW_MS = 10_000;
/** Past this an outage is no restart any more: a real (red) error with the time it started. */
export const CORE_API_OUTAGE_MS = 60_000;
const PROBE_FIRST_MS = 1_000;
const PROBE_MAX_MS = 10_000;

/** failing: under 10 s (only notices of failed requests show it); reconnecting: the calm global notice; down: the red error. */
export type CoreApiOutagePhase = "failing" | "reconnecting" | "down";
export interface CoreApiOutage { phase: CoreApiOutagePhase; since: number }

const listeners = new Set<(outage: CoreApiOutage | null) => void>();
let outage: CoreApiOutage | null = null;
let phaseTimers: Array<ReturnType<typeof globalThis.setTimeout>> = [];
let probeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let probeDelayMs = PROBE_FIRST_MS;
let probeRun = 0;
let lastSuccessAt = Number.NEGATIVE_INFINITY;

function publish(next: CoreApiOutage | null) {
  if (outage?.phase === next?.phase && outage?.since === next?.since) return;
  outage = next;
  for (const listener of listeners) listener(outage);
}

function stopOutage() {
  for (const timer of phaseTimers) globalThis.clearTimeout(timer);
  phaseTimers = [];
  if (probeTimer !== null) globalThis.clearTimeout(probeTimer);
  probeTimer = null;
  probeRun += 1;
}

const phaseAt = (elapsedMs: number): CoreApiOutagePhase =>
  elapsedMs >= CORE_API_OUTAGE_MS ? "down" : elapsedMs >= CORE_API_RECOVERY_WINDOW_MS ? "reconnecting" : "failing";

// Retries with backoff until Space answers, so the notice goes by itself even where nothing else polls.
function scheduleProbe() {
  if (probeTimer !== null || outage === null) return;
  const run = probeRun;
  probeTimer = globalThis.setTimeout(() => {
    void (async () => {
      let ok = false;
      try {
        ok = (await fetch("/readyz", { credentials: "include", cache: "no-store" })).ok;
      } catch {
        // Still unreachable: try again later.
      }
      if (run !== probeRun) return; // the outage ended (or another began) while this probe was out
      probeTimer = null;
      if (ok) {
        reportCoreApiSuccess();
        return;
      }
      probeDelayMs = Math.min(probeDelayMs * 2, PROBE_MAX_MS);
      scheduleProbe();
    })();
  }, probeDelayMs);
}

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    // A hidden tab is throttled and its failures say nothing; back in front, the next request decides again.
    if (!isHidden()) lastSuccessAt = Date.now();
    stopOutage();
    publish(null);
  });
}

export function reportCoreApiFailure(requestStartedAt = Date.now()) {
  if (requestStartedAt < lastSuccessAt) return;
  if (isHidden()) {
    stopOutage();
    publish(null);
    return;
  }
  if (outage !== null) return;
  const now = Date.now();
  // The request's start: a GET the proxy held for 10 s failed when the API went away, not when its answer came.
  const since = Math.min(requestStartedAt, now);
  publish({ phase: phaseAt(now - since), since });
  for (const thresholdMs of [CORE_API_RECOVERY_WINDOW_MS, CORE_API_OUTAGE_MS]) {
    const delayMs = since + thresholdMs - now;
    if (delayMs > 0) phaseTimers.push(globalThis.setTimeout(() => publish({ phase: phaseAt(Date.now() - since), since }), delayMs));
  }
  probeDelayMs = PROBE_FIRST_MS;
  scheduleProbe();
}

export function reportCoreApiSuccess() {
  lastSuccessAt = Date.now();
  stopOutage();
  publish(null);
}

export function resetCoreApiAvailability() {
  lastSuccessAt = Number.NEGATIVE_INFINITY;
  stopOutage();
  publish(null);
}

export function subscribeCoreApiAvailability(listener: (next: CoreApiOutage | null) => void) {
  listeners.add(listener);
  listener(outage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) resetCoreApiAvailability();
  };
}

export function getCoreApiOutage(): CoreApiOutage | null {
  return outage;
}
