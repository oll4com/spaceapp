import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, BrowserHandoffRequest, MarketingCampaign, MarketingCopilotPaneMetadata, MarketingEvent, MarketingPost, MarketingRunView, Pane } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { withRefreshTimeout } from "../copilot-kit/refresh-timeout.js";
import { subscribeMarketingCopilotLiveEvents } from "./live-events.js";

export interface MarketingCopilotData {
  settings: MarketingCopilotPaneMetadata | null;
  runtimes: AgentRuntimeRegistry | null;
  run: MarketingRunView | null;
  events: MarketingEvent[];
  posts: MarketingPost[];
  campaigns: MarketingCampaign[];
  /** The agent waits for the operator in the pane browser (login, two-step code, CAPTCHA). */
  handoff: BrowserHandoffRequest | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: MarketingCopilotPaneMetadata): void;
  setRun(run: MarketingRunView): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** Pane settings, run, activity, posts, campaigns and CLI runtimes, refreshed while the pane is visible and on live events. */
export function useMarketingCopilotData(pane: Pane, enabled: boolean): MarketingCopilotData {
  const [settings, setSettings] = useState<MarketingCopilotPaneMetadata | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [run, setRun] = useState<MarketingRunView | null>(null);
  const [events, setEvents] = useState<MarketingEvent[]>([]);
  const [posts, setPosts] = useState<MarketingPost[]>([]);
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [handoff, setHandoff] = useState<BrowserHandoffRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [settingsResponse, runResponse, eventsResponse, postsResponse, campaignsResponse, handoffResponse] = await withRefreshTimeout(Promise.all([
          api.marketingCopilotSettings(pane.id),
          api.marketingCopilotRun(pane.id).catch(() => null),
          api.marketingEvents(pane.id).catch(() => null),
          api.marketingPosts().catch(() => null),
          api.marketingCampaigns().catch(() => null),
          api.browserHandoff(pane.id).catch(() => null)
        ]), "Marketing Copilot");
        setSettings(settingsResponse.metadata);
        if (runResponse) setRun(runResponse);
        if (eventsResponse) setEvents(eventsResponse.events);
        if (postsResponse) setPosts(postsResponse.posts);
        if (campaignsResponse) setCampaigns(campaignsResponse.campaigns);
        setHandoff(handoffResponse?.handoff ?? null);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Marketing Copilot data could not be loaded.");
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
    const unsubscribe = subscribeMarketingCopilotLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 30_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, runtimes, run, events, posts, campaigns, handoff, loading, error, refresh, setSettings, setRun }),
    [settings, runtimes, run, events, posts, campaigns, handoff, loading, error, refresh]);
}
