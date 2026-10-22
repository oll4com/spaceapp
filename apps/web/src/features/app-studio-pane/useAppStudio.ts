import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, AppStudioEvent, AppStudioPaneMetadata, AppStudioPreview, AppStudioRunStatus, Pane } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeAppStudioLiveEvents } from "./live-events.js";

export interface AppStudioRun { status: AppStudioRunStatus; paused: boolean; openQuestions: number; pendingBriefs: number }
export interface AppStudioData {
  settings: AppStudioPaneMetadata | null;
  run: AppStudioRun | null;
  previews: AppStudioPreview[];
  events: AppStudioEvent[];
  runtimes: AgentRuntimeRegistry | null;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: AppStudioPaneMetadata): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** The pane's settings, run, latest previews and feed, refreshed while the pane is visible and on live events. */
export function useAppStudioData(pane: Pane, enabled: boolean): AppStudioData {
  const [settings, setSettings] = useState<AppStudioPaneMetadata | null>(null);
  const [run, setRun] = useState<AppStudioRun | null>(null);
  const [previews, setPreviews] = useState<AppStudioPreview[]>([]);
  const [events, setEvents] = useState<AppStudioEvent[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const state = await api.appStudioState(pane.id);
        setSettings(state.metadata);
        setRun(state.run);
        setPreviews(state.previews);
        setEvents(state.events);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "App Studio could not be loaded.");
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

  // Live activity: one debounced refresh per burst of events for this pane (a preview uploads several captures at once).
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const unsubscribe = subscribeAppStudioLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 20_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, run, previews, events, runtimes, error, refresh, setSettings }), [settings, run, previews, events, runtimes, error, refresh]);
}
