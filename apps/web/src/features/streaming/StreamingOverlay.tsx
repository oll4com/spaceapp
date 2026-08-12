import type {
  StreamingMetricState,
  StreamingMetricTileSnapshot,
  StreamingOverlaySnapshot,
  StreamingProvider
} from "@space/contracts";
import {
  Boxes,
  Music2,
  Radio,
  Youtube
} from "../ui-theme/app-icons.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import "./streaming.css";

export const STREAMING_OVERLAY_SESSION_KEY = "space.streamingOverlay.enabled.v1";
export const STREAMING_OVERLAY_POLL_INTERVAL_MS = 10_000;

type StreamingOverlayContextValue = {
  enabled: boolean;
  previewActive: boolean;
  snapshot: StreamingOverlaySnapshot | null;
  snapshotError: string | null;
  setEnabled: (enabled: boolean) => void;
  setPreviewActive: (active: boolean) => void;
  refreshSnapshot: () => Promise<void>;
};

const StreamingOverlayContext = createContext<StreamingOverlayContextValue | null>(null);

function readEnabled(): boolean {
  try {
    return getSpaceRuntime().platform.sessionStorage.getItem(STREAMING_OVERLAY_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

export function StreamingOverlayProvider({
  active,
  children
}: {
  active: boolean;
  children: ReactNode;
}) {
  const runtime = getSpaceRuntime();
  const [enabled, setEnabledState] = useState(readEnabled);
  const [previewActive, setPreviewActive] = useState(false);
  const [snapshot, setSnapshot] = useState<StreamingOverlaySnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      runtime.platform.sessionStorage.setItem(STREAMING_OVERLAY_SESSION_KEY, String(next));
    } catch {
      // Session-only activation is best-effort when storage is blocked by the browser.
    }
  }, [runtime.platform.sessionStorage]);

  const refreshSnapshot = useCallback(async () => {
    if (!active) return;
    const sequence = ++requestSequence.current;
    try {
      const next = await api.streamingOverlaySnapshot();
      if (sequence !== requestSequence.current) return;
      setSnapshot(next);
      setSnapshotError(null);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setSnapshotError(error instanceof Error ? error.message : "Streaming snapshot is unavailable.");
    }
  }, [active]);

  const shouldPoll = active && (enabled || previewActive);
  useEffect(() => {
    if (!shouldPoll) return;
    void refreshSnapshot();
    const interval = window.setInterval(() => void refreshSnapshot(), STREAMING_OVERLAY_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshSnapshot, shouldPoll]);

  const value = useMemo<StreamingOverlayContextValue>(() => ({
    enabled,
    previewActive,
    snapshot,
    snapshotError,
    setEnabled,
    setPreviewActive,
    refreshSnapshot
  }), [enabled, previewActive, refreshSnapshot, setEnabled, snapshot, snapshotError]);

  return <StreamingOverlayContext.Provider value={value}>{children}</StreamingOverlayContext.Provider>;
}

export function useStreamingOverlay(): StreamingOverlayContextValue {
  const value = useContext(StreamingOverlayContext);
  if (!value) throw new Error("StreamingOverlayProvider is required.");
  return value;
}

function ProviderIcon({ provider }: { provider: StreamingProvider }) {
  const Icon = provider === "YOUTUBE"
    ? Youtube
    : provider === "TWITCH"
      ? Radio
      : provider === "TIKTOK"
        ? Music2
        : Boxes;
  return <Icon aria-hidden="true" />;
}

export function formatStreamingValue(value: number | string | null): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(value);
}

function stateLabel(state: StreamingMetricState): string | null {
  if (state === "FRESH") return null;
  if (state === "STALE") return "Stale";
  if (state === "OFFLINE") return "Offline";
  if (state === "UNAVAILABLE") return "Unavailable";
  return "Error";
}

export function StreamingMetricTile({ tile }: { tile: StreamingMetricTileSnapshot }) {
  const status = stateLabel(tile.state);
  return (
    <article className="streaming-metric-tile" data-provider={tile.provider} data-state={tile.state}>
      <div className="streaming-metric-heading">
        <span className="streaming-provider-icon" aria-label={tile.provider.toLowerCase()}>
          <ProviderIcon provider={tile.provider} />
        </span>
        <span className="streaming-metric-badge" title={tile.badge}>{tile.badge}</span>
      </div>
      <strong>{formatStreamingValue(tile.value)}</strong>
      <span className="streaming-metric-label">{tile.label}</span>
      {status ? <small className="streaming-metric-state">{status}</small> : null}
    </article>
  );
}
export function StreamingMetricGrid({
  snapshot,
  className = ""
}: {
  snapshot: StreamingOverlaySnapshot;
  className?: string;
}) {
  return (
    <div className={["streaming-metric-grid", className].filter(Boolean).join(" ")}>
      {snapshot.tiles.map((tile, index) => (
        <StreamingMetricTile key={`${tile.metricKey}:${tile.accountId ?? "SPACE"}:${index}`} tile={tile} />
      ))}
    </div>
  );
}

export function StreamingOverlay({ theme }: { theme: "classic" | "modern" }) {
  const { enabled, snapshot } = useStreamingOverlay();
  if (!enabled || !snapshot || (snapshot.tiles.length === 0 && !snapshot.customTextEnabled && !snapshot.botTickerEnabled)) return null;

  return (
    <aside
      className={`streaming-overlay streaming-overlay-${theme}`}
      aria-label="Streaming overlay"
      data-settings-version={snapshot.settingsVersion}
    >
      {snapshot.tiles.length > 0 ? <StreamingMetricGrid snapshot={snapshot} /> : null}
      {snapshot.botTickerEnabled && snapshot.botTicker.length > 0 ? (
        <div className="streaming-overlay-bot-ticker" aria-label="Live Q&A">
          {snapshot.botTicker.map((item, index) => (
            <p key={`${item.createdAt}:${index}`}>
              {item.author ? <strong>{item.author}:</strong> : null} {item.reply ?? item.message}
            </p>
          ))}
        </div>
      ) : null}
      {snapshot.customTextEnabled && snapshot.customText ? (
        <p className="streaming-overlay-custom-text">{snapshot.customText}</p>
      ) : null}
    </aside>
  );
}
