export interface LiveSessionStats {
  sessionActive: boolean;
  sessionStartedAt?: number;
  sessionDurationSec: number;

  // Actual payload dispatched to OpenAI API
  model: string;
  delegatedModel?: string;
  delegatedReasoningEffort?: string;
  delegatedType?: string;
  voice?: string;
  language?: string;
  webSearch: boolean;
  toolsCount: number;
  toolNames: string[];
  rawPayload?: Record<string, unknown>;

  // WebRTC Connection States
  connectionState: RTCPeerConnectionState | "closed" | "idle";
  iceConnectionState: RTCIceConnectionState | "closed" | "idle";
  signalingState: RTCSignalingState | "closed" | "idle";
  dataChannelState: RTCDataChannelState | "closed" | "idle";

  // Real-time Audio & Network Telemetry
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  packetsLost: number;
  fractionLost?: number;
  jitterMs?: number;
  roundTripTimeMs?: number; // RTT latency in ms
  currentAudioInputLevel: number;
  currentAudioOutputLevel: number;

  // DataChannel Message Telemetry
  eventsSentCount: number;
  eventsReceivedCount: number;
  lastEventSent?: string;
  lastEventReceived?: string;
  lastError?: string;
  updatedAtMs: number;

  // Space Control MCP Telemetry
  mcpRoomId?: string;
  mcpOpenPanesCount?: number;
  mcpPaneCap?: number;
  mcpPanes?: Array<{
    id: string;
    title: string;
    mode: string;
    runtime?: string;
    status?: string;
    isUnused?: boolean;
  }>;
  mcpRecentToolCalls?: Array<{
    name: string;
    args?: string;
    status: "running" | "done" | "error";
    timestamp: string;
    durationMs?: number;
    output?: string;
  }>;
  mcpLastDiagnostic?: Record<string, unknown>;
  mcpTestResults?: Array<{
    tool: string;
    domain: string;
    status: "PASS" | "FAIL" | "WARN";
    latencyMs: number;
    details?: unknown;
    error?: string;
  }>;

}

export const initialLiveSessionStats: LiveSessionStats = {
  sessionActive: false,
  sessionDurationSec: 0,
  model: "gpt-live-1",
  delegatedModel: "gpt-5.6-luna",
  delegatedReasoningEffort: "low",
  delegatedType: "responses",
  voice: "gleam",
  language: "auto",
  webSearch: true,
  toolsCount: 0,
  toolNames: [],
  connectionState: "idle",
  iceConnectionState: "idle",
  signalingState: "idle",
  dataChannelState: "idle",
  bytesSent: 0,
  bytesReceived: 0,
  packetsSent: 0,
  packetsReceived: 0,
  packetsLost: 0,
  currentAudioInputLevel: 0,
  currentAudioOutputLevel: 0,
  eventsSentCount: 0,
  eventsReceivedCount: 0,
  mcpRecentToolCalls: [],
  updatedAtMs: Date.now()
};

let currentStats: LiveSessionStats = { ...initialLiveSessionStats };
const listeners = new Set<(stats: LiveSessionStats) => void>();

export function getLiveSessionStats(): LiveSessionStats {
  return currentStats;
}

export function updateLiveSessionStats(
  update: Partial<LiveSessionStats> | ((prev: LiveSessionStats) => Partial<LiveSessionStats>)
): void {
  const patch = typeof update === "function" ? update(currentStats) : update;
  currentStats = {
    ...currentStats,
    ...patch,
    updatedAtMs: Date.now()
  };
  listeners.forEach((listener) => {
    try {
      listener(currentStats);
    } catch {}
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("space-live-stats-changed", { detail: currentStats }));
  }
}

export function recordMcpToolCall(event: {
  name: string;
  args?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  output?: string;
}): void {
  updateLiveSessionStats((prev) => {
    const nowStr = new Date().toLocaleTimeString();
    const item = {
      name: event.name,
      args: event.args,
      status: event.status,
      timestamp: nowStr,
      durationMs: event.durationMs,
      output: event.output
    };
    const existing = prev.mcpRecentToolCalls || [];
    let updatedCalls: typeof existing;
    if (event.status !== "running") {
      const runningIdx = existing.findIndex((c) => c.name === event.name && c.status === "running");
      if (runningIdx !== -1) {
        updatedCalls = [
          ...existing.slice(0, runningIdx),
          item,
          ...existing.slice(runningIdx + 1)
        ];
      } else {
        updatedCalls = [item, ...existing].slice(0, 30);
      }
    } else {
      updatedCalls = [item, ...existing].slice(0, 30);
    }
    return {
      mcpRecentToolCalls: updatedCalls,
      lastEventSent: `MCP ${event.name} (${event.status})`
    };
  });
}

export function recordMcpRoomState(state: {
  roomId: string;
  paneCap?: number;
  openPanesCount?: number;
  panes?: Array<{ id: string; title: string; mode: string; runtime?: string; status?: string; isUnused?: boolean }>;
}): void {
  updateLiveSessionStats({
    mcpRoomId: state.roomId,
    mcpPaneCap: state.paneCap,
    mcpOpenPanesCount: state.openPanesCount,
    mcpPanes: state.panes
  });
}

export function recordMcpDiagnostic(diagnostic: Record<string, unknown>): void {
  updateLiveSessionStats({
    mcpLastDiagnostic: diagnostic
  });
}

export function recordMcpTestResults(results: any[]): void {
  updateLiveSessionStats({
    mcpTestResults: results
  });
}


export function clearMcpToolCalls(): void {
  updateLiveSessionStats({
    mcpRecentToolCalls: []
  });
}


export function subscribeLiveSessionStats(listener: (stats: LiveSessionStats) => void): () => void {
  listeners.add(listener);
  listener(currentStats);
  return () => {
    listeners.delete(listener);
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
