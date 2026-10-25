import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, ConnectorAccountSummary, MailCopilotEvent, MailCopilotPaneMetadata, MailCopilotRunView, Pane } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeMailCopilotLiveEvents } from "./live-events.js";

export interface MailCopilotData {
  settings: MailCopilotPaneMetadata | null;
  /** The owner's Google connector accounts (every account allowed for Space, with what each grants). */
  accounts: ConnectorAccountSummary[];
  runtimes: AgentRuntimeRegistry | null;
  run: MailCopilotRunView | null;
  events: MailCopilotEvent[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: MailCopilotPaneMetadata): void;
  setRun(run: MailCopilotRunView): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** Pane settings, Google accounts and CLI runtimes, refreshed while the pane is visible and on live events. */
export function useMailCopilotData(pane: Pane, enabled: boolean): MailCopilotData {
  const [settings, setSettings] = useState<MailCopilotPaneMetadata | null>(null);
  const [accounts, setAccounts] = useState<ConnectorAccountSummary[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [run, setRun] = useState<MailCopilotRunView | null>(null);
  const [events, setEvents] = useState<MailCopilotEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [settingsResponse, connectors, runResponse, eventsResponse] = await Promise.all([
          api.mailCopilotSettings(pane.id),
          api.connectors().catch(() => null),
          api.mailCopilotRun(pane.id).catch(() => null),
          api.mailCopilotEvents({ paneId: pane.id, limit: 150 }).catch(() => null)
        ]);
        setSettings(settingsResponse.metadata);
        if (connectors) setAccounts(connectors.accounts.filter((account) => account.provider === "GOOGLE"));
        if (runResponse) setRun(runResponse);
        if (eventsResponse) setEvents(eventsResponse.events);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Mail Copilot data could not be loaded.");
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
    const unsubscribe = subscribeMailCopilotLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 20_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, accounts, runtimes, run, events, loading, error, refresh, setSettings, setRun }), [settings, accounts, runtimes, run, events, loading, error, refresh]);
}
