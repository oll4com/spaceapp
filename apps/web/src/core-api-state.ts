export const CORE_API_RECOVERY_WINDOW_MS = 10_000;

const listeners = new Set<(unavailable: boolean) => void>();
let failureTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let failureStarted = false;
let lastSuccessAt = Number.NEGATIVE_INFINITY;
let unavailable = false;

function publish(nextUnavailable: boolean) {
  if (unavailable === nextUnavailable) return;
  unavailable = nextUnavailable;
  for (const listener of listeners) listener(unavailable);
}

function clearFailureTimer() {
  if (failureTimer === null) return;
  globalThis.clearTimeout(failureTimer);
  failureTimer = null;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearFailureTimer();
      failureStarted = false;
    } else {
      lastSuccessAt = Date.now();
      clearFailureTimer();
      failureStarted = false;
    }
  });
}

export function reportCoreApiFailure(requestStartedAt = Date.now()) {
  if (requestStartedAt < lastSuccessAt) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    clearFailureTimer();
    failureStarted = false;
    return;
  }
  if (failureStarted) return;
  failureStarted = true;
  failureTimer = globalThis.setTimeout(() => {
    failureTimer = null;
    if (failureStarted && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
      publish(true);
    }
  }, CORE_API_RECOVERY_WINDOW_MS);
}

export function reportCoreApiSuccess() {
  lastSuccessAt = Date.now();
  failureStarted = false;
  clearFailureTimer();
  publish(false);
}

export function resetCoreApiAvailability() {
  lastSuccessAt = Number.NEGATIVE_INFINITY;
  failureStarted = false;
  clearFailureTimer();
  publish(false);
}

export function subscribeCoreApiAvailability(listener: (nextUnavailable: boolean) => void) {
  listeners.add(listener);
  listener(unavailable);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) resetCoreApiAvailability();
  };
}

export function getCoreApiUnavailable(): boolean {
  return unavailable;
}
