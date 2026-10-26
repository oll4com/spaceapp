import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, Pane, SecurityCopilotPaneMetadata } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeSecurityCopilotLiveEvents } from "./live-events.js";
import type { SecurityCopilotState } from "./types.js";

export interface SecurityCopilotData {
  state: SecurityCopilotState | null;
  runtimes: AgentRuntimeRegistry | null;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: SecurityCopilotPaneMetadata): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** The pane's settings, run, hosts, findings, actions and feed, refreshed while the pane is visible and on live events. */
export function useSecurityCopilotData(pane: Pane, enabled: boolean): SecurityCopilotData {
  const [state, setState] = useState<SecurityCopilotState | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        setState(await api.securityCopilotState(pane.id));
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The Security Copilot could not be loaded.");
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [pane.id]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.cliRuntimes({ allowStale: true }).then((registry) => { if (!cancelled) setRuntimes(registry); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled]);

  // Live activity: one debounced refresh per burst of events for this pane (an inventory raises several findings at once).
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const unsubscribe = subscribeSecurityCopilotLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 30_000, enabled, true, pane.id);

  const setSettings = useCallback((metadata: SecurityCopilotPaneMetadata) => setState((current) => current ? { ...current, metadata } : current), []);
  return useMemo(() => ({ state, runtimes, error, refresh, setSettings }), [state, runtimes, error, refresh, setSettings]);
}
