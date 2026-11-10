import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { X } from "./features/ui-theme/app-icons.js";
import { isTransientUpstreamErrorMessage } from "./app-shell-utils.js";
import type { UiLanguage } from "@space/contracts";
import { uiText, useUiLanguage } from "./features/ui-language/ui-language.js";

export { CORE_API_OUTAGE_MS, CORE_API_RECOVERY_WINDOW_MS, reportCoreApiFailure, reportCoreApiSuccess, resetCoreApiAvailability } from "./core-api-state.js";
import { getCoreApiOutage, subscribeCoreApiAvailability, type CoreApiOutage } from "./core-api-state.js";
export const ACTION_ERROR_DISMISS_MS = 10_000;

/** The API outage now (null while Space answers), for every notice of a failed request. */
export const useCoreApiOutage = (): CoreApiOutage | null => useSyncExternalStore(subscribeCoreApiAvailability, getCoreApiOutage);

/** A restart is calm and passes by itself; past CORE_API_OUTAGE_MS it is a real error with the time it started. */
export function coreApiOutageText(language: UiLanguage, outage: CoreApiOutage): string {
  if (outage.phase !== "down") return uiText(language, "SpaceApp is updating… reconnecting");
  const time = new Date(outage.since).toLocaleTimeString(language === "el" ? "el-GR" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return uiText(language, "UPSTREAM_UNAVAILABLE: Space API has not answered since {time}. Room state may be stale; active CLI sessions continue running.", { time });
}

function OutageBanner({ outage }: { outage: CoreApiOutage }) {
  const language = useUiLanguage();
  return <ErrorBanner message={coreApiOutageText(language, outage)} autoDismiss={false} tone={outage.phase === "down" ? "bad" : "calm"} />;
}

function ErrorBanner({ message, autoDismiss, onDismiss, tone = "bad" }: {
  message: string;
  autoDismiss: boolean;
  onDismiss?: () => void;
  tone?: "bad" | "calm";
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
    <div className={tone === "bad" ? "banner bad" : "banner"} role={tone === "bad" ? "alert" : "status"}
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
  const outage = useCoreApiOutage();
  // A brief API blip is not an action error; the outage banner reports it after 10 seconds.
  const shownActionError = isTransientUpstreamErrorMessage(actionError) ? null : actionError;
  if (shownActionError !== null) {
    return <ErrorBanner key={`action:${shownActionError}`} message={shownActionError} autoDismiss onDismiss={onDismissActionError} />;
  }
  return outage && outage.phase !== "failing" ? <OutageBanner key={`outage:${outage.phase}:${outage.since}`} outage={outage} /> : null;
}
