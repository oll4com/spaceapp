import { useEffect, useState } from "react";

export const CORE_API_RECOVERY_WINDOW_MS = 10_000;

const outageMessage =
  "UPSTREAM_UNAVAILABLE: Space API has been unavailable for more than 10 seconds. Room state may be stale; active CLI sessions continue running.";
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

export function reportCoreApiFailure(requestStartedAt = Date.now()) {
  if (requestStartedAt < lastSuccessAt) return;
  if (failureStarted) return;
  failureStarted = true;
  failureTimer = globalThis.setTimeout(() => {
    failureTimer = null;
    if (failureStarted) publish(true);
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

function subscribe(listener: (nextUnavailable: boolean) => void) {
  listeners.add(listener);
  listener(unavailable);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) resetCoreApiAvailability();
  };
}

export function GlobalApiErrorAlert({ actionError }: { actionError: string | null }) {
  const [coreApiUnavailable, setCoreApiUnavailable] = useState(unavailable);
  useEffect(() => subscribe(setCoreApiUnavailable), []);
  const message = actionError ?? (coreApiUnavailable ? outageMessage : null);
  return message ? <div className="banner bad" role="alert">{message}</div> : null;
}
