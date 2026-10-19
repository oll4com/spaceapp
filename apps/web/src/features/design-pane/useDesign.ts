import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, DesignAsset, DesignBrandKit, DesignEvent, DesignPaneMetadata, DesignRequest, Pane } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeDesignLiveEvents } from "./live-events.js";

export interface DesignData {
  settings: DesignPaneMetadata | null;
  requests: DesignRequest[];
  assets: DesignAsset[];
  brandKits: DesignBrandKit[];
  events: DesignEvent[];
  runtimes: AgentRuntimeRegistry | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: DesignPaneMetadata): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;

/** Pane settings, requests, the library, brand kits and activity, refreshed while the pane is visible and on live events. */
export function useDesignData(pane: Pane, enabled: boolean): DesignData {
  const [settings, setSettings] = useState<DesignPaneMetadata | null>(null);
  const [requests, setRequests] = useState<DesignRequest[]>([]);
  const [assets, setAssets] = useState<DesignAsset[]>([]);
  const [brandKits, setBrandKits] = useState<DesignBrandKit[]>([]);
  const [events, setEvents] = useState<DesignEvent[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [settingsResponse, requestsResponse, assetsResponse, kitsResponse, eventsResponse] = await Promise.all([
          api.designSettings(pane.id),
          api.designRequests(pane.id).catch(() => null),
          api.designAssets(pane.id, { limit: 200 }).catch(() => null),
          api.designBrandKits().catch(() => null),
          api.designEvents(pane.id, 100).catch(() => null)
        ]);
        setSettings(settingsResponse.metadata);
        if (requestsResponse) setRequests(requestsResponse.requests);
        if (assetsResponse) setAssets(assetsResponse.assets);
        if (kitsResponse) setBrandKits(kitsResponse.brandKits);
        if (eventsResponse) setEvents(eventsResponse.events);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Design data could not be loaded.");
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
    const unsubscribe = subscribeDesignLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 20_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, requests, assets, brandKits, events, runtimes, loading, error, refresh, setSettings }),
    [settings, requests, assets, brandKits, events, runtimes, loading, error, refresh]);
}
