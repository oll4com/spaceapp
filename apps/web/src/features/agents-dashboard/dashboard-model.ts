import type { Pane } from "@space/contracts";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import type { PaneCompletionEntry } from "../../pane-completion-lifecycle.js";

export const agentStatuses = ["waiting", "working", "done", "idle"] as const;
export type AgentStatus = typeof agentStatuses[number];
export const agentStatusLabels: Record<AgentStatus, string> = {
  waiting: "Waiting for you", working: "Working", done: "Done", idle: "Idle",
};
const agentStatusPriority: Record<AgentStatus, number> = { waiting: 0, working: 1, done: 2, idle: 3 };

/** Server-side reason for a status: fixed labels, timestamps and model ids only. */
export interface AgentActivityDetail {
  status: AgentStatus;
  reason?: string | null;
  since?: string | null;
  modelId?: string | null;
  source?: "native" | "screen" | "session" | "run";
}

export interface DashboardAgentsSnapshot {
  data: Pane[];
  activity?: Record<string, AgentStatus>;
  details?: Record<string, AgentActivityDetail>;
  sampledAt?: string;
}

export function isDashboardAgent(pane: Pane): boolean {
  if (pane.isClosed || pane.status === "CLOSED") return false;
  if (pane.mode === "TERMINAL") return Boolean(cliRuntimePresentation(pane.terminalRuntimeId ?? "cli:codex"));
  return ["CHAT", "CODE", "REVIEW", "SWARM", "DESIGN", "HARNESS"].includes(pane.mode);
}

export function dashboardStatus(pane: Pane, completion?: PaneCompletionEntry): AgentStatus {
  if (pane.status === "BLOCKED" || pane.status === "ERROR") return "waiting";
  if (completion?.activeRunKey || pane.status === "RUNNING" || pane.status === "QUEUED") return "working";
  // A historical completion survives later failures in the shared lifecycle.
  // Only an unacknowledged completion is evidence of a newly finished CLI task.
  if (pane.status === "COMPLETE" || completion?.pendingCompletionEventId) return "done";
  return "idle";
}

/**
 * Per-browser record of when the operator last looked at each agent. Finished work
 * stays "Done" until then; everything that finished before the first visit counts as seen.
 */
export interface AgentSeenState {
  baseline: string;
  panes: Record<string, string>;
}

export function seenAt(seen: AgentSeenState, paneId: string): string {
  return seen.panes[paneId] ?? seen.baseline;
}

export function markAgentsSeen(seen: AgentSeenState, paneIds: readonly string[], at: string, livePaneIds?: ReadonlySet<string>): AgentSeenState {
  const panes: Record<string, string> = {};
  for (const [paneId, value] of Object.entries(seen.panes)) {
    if (!livePaneIds || livePaneIds.has(paneId)) panes[paneId] = value;
  }
  for (const paneId of paneIds) panes[paneId] = at;
  // Bound the record; the oldest views fall back to the baseline.
  const kept = Object.entries(panes).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 500);
  return { baseline: seen.baseline, panes: Object.fromEntries(kept) };
}

export interface ResolvedAgentStatus {
  status: AgentStatus;
  detail: AgentActivityDetail | null;
  /** Finished work the operator has already looked at. */
  seenFinish: boolean;
}

export function resolveAgentStatus(pane: Pane, input: {
  activity?: AgentStatus; detail?: AgentActivityDetail; completion?: PaneCompletionEntry; seen: AgentSeenState;
}): ResolvedAgentStatus {
  const detail = input.detail ?? null;
  const status = input.activity ?? detail?.status ?? dashboardStatus(pane, input.completion);
  if (status === "done" && detail?.since && detail.since <= seenAt(input.seen, pane.id)) {
    return { status: "idle", detail, seenFinish: true };
  }
  return { status, detail, seenFinish: false };
}

export function compareAgentEntries(
  a: { status: AgentStatus; lastActivityAt: string; pane: Pane },
  b: { status: AgentStatus; lastActivityAt: string; pane: Pane }
): number {
  return agentStatusPriority[a.status] - agentStatusPriority[b.status] ||
    b.lastActivityAt.localeCompare(a.lastActivityAt) || a.pane.id.localeCompare(b.pane.id);
}

export function dashboardProject(pane: Pane, roomName: string) {
  const path = pane.cwd?.trim().replace(/[\\/]+$/, "");
  return path ? { key: path, label: path.split(/[\\/]/).at(-1) || path, path } : { key: `room:${pane.roomId}`, label: roomName, path: roomName };
}

export function dashboardAge(updatedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Compact elapsed time for a running or blocked agent: 45s, 12m, 1h 5m, 2d 3h. */
export function dashboardElapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export interface AgentDashboardSummary {
  total: number;
  working: number;
  waiting: number;
  done: number;
  idle: number;
  loaded: boolean;
}

export type AgentsIndicatorBorder = "run" | "waiting-only" | "done-only" | "idle";

export function getAgentsIndicatorBorder(summary?: AgentDashboardSummary | null): AgentsIndicatorBorder {
  if (!summary || !summary.loaded) return "idle";
  if (summary.working > 0) return "run";
  if (summary.waiting > 0) return "waiting-only";
  if (summary.done > 0) return "done-only";
  return "idle";
}
