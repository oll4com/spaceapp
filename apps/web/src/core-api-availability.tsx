import { useEffect, useEffectEvent, useState } from "react";
import { X } from "./features/ui-theme/app-icons.js";
import { isTransientUpstreamErrorMessage } from "./app-shell-utils.js";

export { CORE_API_RECOVERY_WINDOW_MS, reportCoreApiFailure, reportCoreApiSuccess, resetCoreApiAvailability } from "./core-api-state.js";
import { getCoreApiUnavailable, subscribeCoreApiAvailability } from "./core-api-state.js";
export const ACTION_ERROR_DISMISS_MS = 10_000;

const outageMessage =
  "UPSTREAM_UNAVAILABLE: Space API has been unavailable for more than 10 seconds. Room state may be stale; active CLI sessions continue running.";
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
  const [coreApiUnavailable, setCoreApiUnavailable] = useState(getCoreApiUnavailable());
  useEffect(() => subscribeCoreApiAvailability(setCoreApiUnavailable), []);
  // A brief API blip is not an action error; the outage banner reports it after 10 seconds.
  const shownActionError = isTransientUpstreamErrorMessage(actionError) ? null : actionError;
  const message = shownActionError ?? (coreApiUnavailable ? outageMessage : null);
  return message ? <ErrorBanner key={`${shownActionError !== null ? "action" : "outage"}:${message}`}
    message={message} autoDismiss={shownActionError !== null}
    onDismiss={shownActionError !== null ? onDismissActionError : undefined} /> : null;
}
