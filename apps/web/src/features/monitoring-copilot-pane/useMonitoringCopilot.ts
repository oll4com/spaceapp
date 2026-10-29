import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, Pane, MonitoringCopilotPaneMetadata } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeMonitoringCopilotLiveEvents } from "./live-events.js";
import type { MonitoringCopilotState } from "./types.js";

export interface MonitoringCopilotData {
  state: MonitoringCopilotState | null;
  runtimes: AgentRuntimeRegistry | null;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: MonitoringCopilotPaneMetadata): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** The pane's settings, run, alerts and feed, refreshed while the pane is visible and on live events. */
export function useMonitoringCopilotData(pane: Pane, enabled: boolean): MonitoringCopilotData {
  const [state, setState] = useState<MonitoringCopilotState | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        setState(await api.monitoringCopilotState(pane.id));
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The Monitoring Copilot could not be loaded.");
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

  // Live activity: one debounced refresh per burst of events for this pane (a watch pass can record several alerts at once).
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const unsubscribe = subscribeMonitoringCopilotLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 30_000, enabled, true, pane.id);

  const setSettings = useCallback((metadata: MonitoringCopilotPaneMetadata) => setState((current) => current ? { ...current, metadata } : current), []);
  return useMemo(() => ({ state, runtimes, error, refresh, setSettings }), [state, runtimes, error, refresh, setSettings]);
}
