import { useEffect, useRef, useState } from "react";
import {
  type LiveSessionStats,
  formatBytes,
  getLiveSessionStats,
  subscribeLiveSessionStats
} from "./live-stats.js";

interface LiveStatsWindowProps {
  onClose: () => void;
  position?: { left: number; top: number };
  onPositionChange?: (pos: { left: number; top: number }) => void;
  roomId?: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function LiveStatsWindow({
  onClose,
  position,
  onPositionChange
}: LiveStatsWindowProps) {
  const [stats, setStats] = useState<LiveSessionStats>(getLiveSessionStats);
  const [copied, setCopied] = useState(false);

  // Position handling: external (if provided) or self-managed
  const [internalPos, setInternalPos] = useState<{ left: number; top: number }>(() => {
    if (typeof window !== "undefined") {
      const w = Math.min(540, window.innerWidth - 40);
      const h = Math.min(540, window.innerHeight - 80);
      return {
        left: Math.max(16, Math.round((window.innerWidth - w) / 2)),
        top: Math.max(40, Math.round((window.innerHeight - h) / 3))
      };
    }
    return { left: 80, top: 80 };
  });

  const effectivePos = position || internalPos;
  const updatePos = onPositionChange || setInternalPos;
  const dragRef = useRef<{ offsetX: number; offsetY: number; width: number; height: number } | null>(null);

  useEffect(() => {
    return subscribeLiveSessionStats(setStats);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (rect) {
      dragRef.current = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height
      };
    }
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const { width, height, offsetX, offsetY } = dragRef.current;
      updatePos({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - offsetX)),
        top: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - offsetY))
      });
    };

    const handlePointerUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [updatePos]);

  const handleCopyReport = async () => {
    try {
      const report = {
        timestamp: new Date().toISOString(),
        sessionActive: stats.sessionActive,
        sessionDuration: formatDuration(stats.sessionDurationSec),
        model: stats.model,
        delegatedModel: stats.delegatedModel,
        reasoningEffort: stats.delegatedReasoningEffort,
        voice: stats.voice,
        language: stats.language,
        webSearch: stats.webSearch,
        connectionState: stats.connectionState,
        iceConnectionState: stats.iceConnectionState,
        roundTripTimeMs: stats.roundTripTimeMs,
        jitterMs: stats.jitterMs,
        bytesSent: stats.bytesSent,
        packetsSent: stats.packetsSent,
        bytesReceived: stats.bytesReceived,
        packetsReceived: stats.packetsReceived,
        packetsLost: stats.packetsLost,
        dataChannelState: stats.dataChannelState,
        eventsSentCount: stats.eventsSentCount,
        eventsReceivedCount: stats.eventsReceivedCount,
        lastError: stats.lastError
      };
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <section
      className="live-rail-stats-window"
      aria-label="Live Voice Telemetry & Statistics"
      style={{
        left: effectivePos.left,
        top: effectivePos.top,
        width: 540,
        maxWidth: "92vw"
      }}
    >
      <header className="live-rail-stats-header" onPointerDown={handlePointerDown}>
        <div className="live-stats-header-title">
          <span className={`live-stats-pulse-dot ${stats.sessionActive ? "is-active" : ""}`} />
          <strong>Live Voice Telemetry</strong>
          <span className={`live-stats-status-badge ${stats.sessionActive ? "is-active" : "is-idle"}`}>
            {stats.sessionActive ? "ACTIVE" : "IDLE"}
          </span>
          {stats.sessionActive && (
            <span className="live-stats-duration-badge">
              {formatDuration(stats.sessionDurationSec)}
            </span>
          )}
        </div>
        <div className="live-stats-header-actions">
          <button
            type="button"
            className="live-stats-btn-copy"
            onClick={handleCopyReport}
            title="Copy telemetry JSON to clipboard"
          >
            {copied ? "✓ Copied" : "Copy Report"}
          </button>
          <button
            type="button"
            className="live-stats-close-btn"
            aria-label="Close telemetry window"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      <div className="live-rail-stats-body" style={{ overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Section 1: Active Voice & Upstream Models */}
        <div className="live-stats-section">
          <div className="live-stats-section-title">
            <span>Voice &amp; Upstream Models</span>
            <span className="live-stats-source-tag">
              {stats.sessionActive ? "🟢 Session Active" : "Configured (Ready)"}
            </span>
          </div>

          <div className="live-stats-grid">
            <div className="live-stats-item">
              <span className="live-stats-label">Voice Model</span>
              <strong className="live-stats-value is-highlight">{stats.model}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Delegated Model</span>
              <strong className="live-stats-value">{stats.delegatedModel || "None"}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Reasoning Effort</span>
              <strong className={`live-stats-value ${stats.delegatedReasoningEffort === "minimal" || stats.delegatedReasoningEffort === "low" ? "is-efficient" : "is-warning"}`}>
                {stats.delegatedReasoningEffort || "minimal"}
              </strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Voice &amp; Language</span>
              <strong className="live-stats-value">{stats.voice} · {stats.language}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Web Search</span>
              <strong className="live-stats-value">{stats.webSearch ? "Enabled" : "Disabled"}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Active Tools</span>
              <strong className="live-stats-value">{stats.toolsCount} configured</strong>
            </div>
          </div>
        </div>

        {/* Section 2: Network & WebRTC Telemetry */}
        <div className="live-stats-section">
          <div className="live-stats-section-title">
            <span>Network &amp; Audio Telemetry</span>
            <span className="live-stats-source-tag">PeerConnection stats</span>
          </div>

          <div className="live-stats-grid">
            <div className="live-stats-item">
              <span className="live-stats-label">WebRTC Peer</span>
              <strong className="live-stats-value">{stats.connectionState}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">ICE State</span>
              <strong className="live-stats-value">{stats.iceConnectionState}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Round-Trip Latency (RTT)</span>
              <strong className="live-stats-value is-latency">
                {stats.roundTripTimeMs != null ? `${stats.roundTripTimeMs} ms` : "Measuring..."}
              </strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Jitter</span>
              <strong className="live-stats-value">
                {stats.jitterMs != null ? `${stats.jitterMs.toFixed(1)} ms` : "Measuring..."}
              </strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Audio Sent (Mic)</span>
              <strong className="live-stats-value">
                {formatBytes(stats.bytesSent)} · {stats.packetsSent.toLocaleString()} pkts
              </strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Audio Received (AI)</span>
              <strong className="live-stats-value">
                {formatBytes(stats.bytesReceived)} · {stats.packetsReceived.toLocaleString()} pkts
                {stats.packetsLost > 0 ? ` (${stats.packetsLost} lost)` : ""}
              </strong>
            </div>
          </div>

          {/* Audio levels indicator */}
          <div className="live-stats-audio-levels">
            <div className="live-stats-meter-row">
              <span className="live-stats-meter-label">Mic In</span>
              <div className="live-stats-meter-bar">
                <div
                  className="live-stats-meter-fill is-input"
                  style={{ width: `${Math.min(100, Math.round(stats.currentAudioInputLevel * 100))}%` }}
                />
              </div>
            </div>
            <div className="live-stats-meter-row">
              <span className="live-stats-meter-label">AI Out</span>
              <div className="live-stats-meter-bar">
                <div
                  className="live-stats-meter-fill is-output"
                  style={{ width: `${Math.min(100, Math.round(stats.currentAudioOutputLevel * 100))}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: DataChannel Traffic */}
        <div className="live-stats-section">
          <div className="live-stats-section-title">
            <span>DataChannel Traffic</span>
            <span className="live-stats-duration">{formatDuration(stats.sessionDurationSec)}</span>
          </div>

          <div className="live-stats-grid">
            <div className="live-stats-item">
              <span className="live-stats-label">DataChannel</span>
              <strong className="live-stats-value">{stats.dataChannelState}</strong>
            </div>
            <div className="live-stats-item">
              <span className="live-stats-label">Events Traffic</span>
              <strong className="live-stats-value">
                ↑ {stats.eventsSentCount} sent · ↓ {stats.eventsReceivedCount} recv
              </strong>
            </div>
            <div className="live-stats-item full-width">
              <span className="live-stats-label">Last Event Sent</span>
              <code className="live-stats-code">{stats.lastEventSent || "none"}</code>
            </div>
            <div className="live-stats-item full-width">
              <span className="live-stats-label">Last Event Received</span>
              <code className="live-stats-code">{stats.lastEventReceived || "none"}</code>
            </div>
          </div>

          {stats.lastError && (
            <div className="live-stats-error-banner">
              <strong>Last Error:</strong> {stats.lastError}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
