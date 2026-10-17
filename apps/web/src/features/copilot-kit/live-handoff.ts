import { useEffect, useState } from "react";
import type { BrowserHandoffRequest } from "@space/contracts";
import { BROWSER_PANE_CONTROL_EVENT, browserPaneControlHeld } from "../browser-pane/events.js";

/** A handoff that still needs the pane: one the operator holds, or a request that has not expired. */
export function isLiveHandoff(handoff: BrowserHandoffRequest | null | undefined, now: number): handoff is BrowserHandoffRequest {
  if (!handoff) return false;
  if (handoff.status === "ACCEPTED") return true;
  return handoff.status === "REQUESTED" && Date.parse(handoff.expiresAt) > now;
}

/** `isLiveHandoff` for a pane, re-checked the moment a request expires (the server may still report it as REQUESTED). */
export function useLiveHandoff(handoff: BrowserHandoffRequest | null | undefined): BrowserHandoffRequest | null {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = handoff?.status === "REQUESTED" ? Date.parse(handoff.expiresAt) : Number.NaN;
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [expiresAt, handoff?.handoffRequestId]);
  return isLiveHandoff(handoff, now) ? handoff : null;
}

/** Whether the operator holds this pane's browser, also after the handoff that gave it to him ended. */
export function useBrowserControlHeld(paneId: string): boolean {
  const [held, setHeld] = useState(() => browserPaneControlHeld(paneId));
  useEffect(() => {
    setHeld(browserPaneControlHeld(paneId));
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: unknown; held?: unknown }>).detail;
      if (detail?.paneId === paneId) setHeld(detail.held === true);
    };
    window.addEventListener(BROWSER_PANE_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(BROWSER_PANE_CONTROL_EVENT, onControl);
  }, [paneId]);
  return held;
}
