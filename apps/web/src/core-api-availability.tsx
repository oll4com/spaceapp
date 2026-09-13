import { useEffect, useEffectEvent, useState } from "react";
import { X } from "./features/ui-theme/app-icons.js";

export const CORE_API_RECOVERY_WINDOW_MS = 10_000;
export const ACTION_ERROR_DISMISS_MS = 10_000;

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

function ErrorBanner({ message, autoDismiss, onDismiss }: {
  message: string;
  autoDismiss: boolean;
  onDismiss?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };
  const expire = useEffectEvent(dismiss);
  useEffect(() => {
    if (!autoDismiss || dismissed || hovered || focused) return;
    const timer = globalThis.setTimeout(() => expire(), ACTION_ERROR_DISMISS_MS);
    return () => globalThis.clearTimeout(timer);
  }, [autoDismiss, dismissed, hovered, focused]);

  if (dismissed) return null;
  return (
    <div className="banner bad" role="alert"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className="notice-row">
        <span>{message}</span>
        <button type="button" className="notice-close" aria-label="Dismiss notification"
          title="Dismiss notification" onClick={dismiss}>
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  );
}

export function GlobalApiErrorAlert({ actionError, onDismissActionError }: {
  actionError: string | null;
  onDismissActionError?: () => void;
}) {
  const [coreApiUnavailable, setCoreApiUnavailable] = useState(unavailable);
  useEffect(() => subscribe(setCoreApiUnavailable), []);
  const message = actionError ?? (coreApiUnavailable ? outageMessage : null);
  return message ? <ErrorBanner key={`${actionError !== null ? "action" : "outage"}:${message}`}
    message={message} autoDismiss={actionError !== null}
    onDismiss={actionError !== null ? onDismissActionError : undefined} /> : null;
}
