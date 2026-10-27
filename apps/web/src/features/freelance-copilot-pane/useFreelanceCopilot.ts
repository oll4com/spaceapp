import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, BrowserHandoffRequest, FreelanceCopilotPaneMetadata, FreelanceEvent, FreelanceFunnel, FreelanceLead, FreelanceRunView, Pane } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { withRefreshTimeout } from "../copilot-kit/refresh-timeout.js";
import { subscribeFreelanceCopilotLiveEvents } from "./live-events.js";

export interface FreelanceCopilotData {
  settings: FreelanceCopilotPaneMetadata | null;
  runtimes: AgentRuntimeRegistry | null;
  run: FreelanceRunView | null;
  events: FreelanceEvent[];
  leads: FreelanceLead[];
  funnel: FreelanceFunnel | null;
  /** The agent waits for the operator in the pane browser (login, two-step code, CAPTCHA, identity check). */
  handoff: BrowserHandoffRequest | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: FreelanceCopilotPaneMetadata): void;
  setRun(run: FreelanceRunView): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** Pane settings, run, activity, leads, funnel and CLI runtimes, refreshed while the pane is visible and on live events. */
export function useFreelanceCopilotData(pane: Pane, enabled: boolean): FreelanceCopilotData {
  const [settings, setSettings] = useState<FreelanceCopilotPaneMetadata | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [run, setRun] = useState<FreelanceRunView | null>(null);
  const [events, setEvents] = useState<FreelanceEvent[]>([]);
  const [leads, setLeads] = useState<FreelanceLead[]>([]);
  const [funnel, setFunnel] = useState<FreelanceFunnel | null>(null);
  const [handoff, setHandoff] = useState<BrowserHandoffRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [settingsResponse, runResponse, eventsResponse, leadsResponse, funnelResponse, handoffResponse] = await withRefreshTimeout(Promise.all([
          api.freelanceCopilotSettings(pane.id),
          api.freelanceCopilotRun(pane.id).catch(() => null),
          api.freelanceEvents(pane.id).catch(() => null),
          api.freelanceLeads().catch(() => null),
          api.freelanceFunnel().catch(() => null),
          api.browserHandoff(pane.id).catch(() => null)
        ]), "Freelance Copilot");
        setSettings(settingsResponse.metadata);
        if (runResponse) setRun(runResponse);
        if (eventsResponse) setEvents(eventsResponse.events);
        if (leadsResponse) setLeads(leadsResponse.leads);
        if (funnelResponse) setFunnel(funnelResponse);
        setHandoff(handoffResponse?.handoff ?? null);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Freelance Copilot data could not be loaded.");
      } finally {
        setLoading(false);
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

  // Live activity: one debounced refresh per burst of events for this pane.
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const unsubscribe = subscribeFreelanceCopilotLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 30_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, runtimes, run, events, leads, funnel, handoff, loading, error, refresh, setSettings, setRun }),
    [settings, runtimes, run, events, leads, funnel, handoff, loading, error, refresh]);
}
