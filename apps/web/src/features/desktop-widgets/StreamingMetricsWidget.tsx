import { useSyncExternalStore } from "react";
import type { StreamingOverlaySnapshot } from "@space/contracts";
import { Radio } from "lucide-react";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { DesktopWidgetState } from "./types.js";
import { formatStreamingValue } from "../streaming/StreamingOverlay.js";
import { getStreamingSnapshot, subscribeStreamingSnapshot } from "../streaming/streaming-snapshot-store.js";

interface Props {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

export function StreamingMetricsWidget(props: Props) {
  const snapshot = useSyncExternalStore(subscribeStreamingSnapshot, getStreamingSnapshot, () => null);
  const groups = new Map<string, StreamingOverlaySnapshot["tiles"]>();
  for (const tile of snapshot?.tiles ?? []) {
    const key = `${tile.provider} · ${tile.badge}`;
    groups.set(key, [...(groups.get(key) ?? []), tile]);
  }

  const dockedSummary = (
    <div className="widget-docked-rail-body">
      <span className="widget-docked-title">Live</span>
      <span className="widget-docked-countdown">{snapshot?.tiles.length ?? 0}</span>
      <span className="widget-docked-reps">metrics</span>
    </div>
  );

  return <DesktopWidgetContainer
    id="streaming-metrics" title="Streaming Metrics" icon={<Radio className="widget-header-svg" />}
    x={props.state.x} y={props.state.y} zIndex={props.state.zIndex} minimized={props.state.minimized}
    dockedToRail={props.state.dockedToRail}
    dockPosition={props.state.dockPosition}
    isMultiColumn={props.isMultiColumn}
    isHeaderDockActive={props.isHeaderDockActive}
    minimizedSummary={<span>{snapshot?.tiles.length ?? 0} active metrics</span>}
    dockedSummary={dockedSummary}
    onPositionChange={props.onPositionChange} onToggleMinimize={props.onToggleMinimize}
    onClose={props.onClose} onFocus={props.onFocus} className="widget-streaming-metrics"
  >
    <div className="widget-streaming-metrics-content">
      {!snapshot || snapshot.tiles.length === 0 ? <p>No active streaming metrics.</p> : [...groups].map(([name, tiles]) => <section key={name}>
        <h3>{name}</h3>
        {tiles.map(tile => <div key={`${tile.metricKey}:${tile.accountId ?? "SPACE"}`} className="widget-streaming-metric-row" data-state={tile.state}>
          <span>{tile.label}</span><strong>{formatStreamingValue(tile.value)}</strong>
          <small>{tile.state[0]}{tile.state.slice(1).toLowerCase()}{tile.sampledAt ? ` · ${new Date(tile.sampledAt).toLocaleTimeString()}` : ""}</small>
        </div>)}
      </section>)}
      {snapshot ? <small>Snapshot {new Date(snapshot.generatedAt).toLocaleTimeString()}</small> : null}
    </div>
  </DesktopWidgetContainer>;
}
