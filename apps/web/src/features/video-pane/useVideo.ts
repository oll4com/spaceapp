import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, Artifact, Pane, VideoAsset, VideoEvent, VideoPaneMetadata, VideoRequest } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { subscribeVideoLiveEvents } from "./live-events.js";

export interface VideoData {
  settings: VideoPaneMetadata | null;
  requests: VideoRequest[];
  assets: VideoAsset[];
  events: VideoEvent[];
  /** The room's Media videos and audio tracks: sources the Studio can cut without an upload. */
  media: Artifact[];
  runtimes: AgentRuntimeRegistry | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  setSettings(settings: VideoPaneMetadata): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 400;
export const isMediaSource = (artifact: Artifact) => artifact.kind === "VIDEO" || artifact.kind === "AUDIO" || artifact.mimeType.startsWith("video/") || artifact.mimeType.startsWith("audio/");

/** Pane settings, requests, the library, the room's media and activity, refreshed while the pane is visible and on live events. */
export function useVideoData(pane: Pane, enabled: boolean): VideoData {
  const [settings, setSettings] = useState<VideoPaneMetadata | null>(null);
  const [requests, setRequests] = useState<VideoRequest[]>([]);
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [events, setEvents] = useState<VideoEvent[]>([]);
  const [media, setMedia] = useState<Artifact[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const [settingsResponse, requestsResponse, assetsResponse, eventsResponse, mediaResponse] = await Promise.all([
          api.videoSettings(pane.id),
          api.videoRequests(pane.id).catch(() => null),
          api.videoAssets(pane.id, { limit: 200 }).catch(() => null),
          api.videoEvents(pane.id, 100).catch(() => null),
          api.artifacts({ roomId: pane.roomId, collection: "ROOM_MEDIA", pageSize: 100, sortOrder: "desc" }).catch(() => null)
        ]);
        setSettings(settingsResponse.metadata);
        if (requestsResponse) setRequests(requestsResponse.requests);
        if (assetsResponse) setAssets(assetsResponse.assets);
        if (eventsResponse) setEvents(eventsResponse.events);
        if (mediaResponse) setMedia(mediaResponse.data.filter(isMediaSource));
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Video data could not be loaded.");
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [pane.id, pane.roomId]);

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
    const unsubscribe = subscribeVideoLiveEvents(pane.id, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, pane.id, refresh]);

  usePanePolling(() => refresh(), 20_000, enabled, true, pane.id);

  return useMemo(() => ({ settings, requests, assets, events, media, runtimes, loading, error, refresh, setSettings }),
    [settings, requests, assets, events, media, runtimes, loading, error, refresh]);
}
