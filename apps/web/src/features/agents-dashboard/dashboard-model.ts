import type { Pane } from "@space/contracts";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import type { PaneCompletionEntry } from "../../pane-completion-lifecycle.js";

export const agentStatuses = ["waiting", "working", "done", "idle"] as const;
export type AgentStatus = typeof agentStatuses[number];
export const agentStatusLabels: Record<AgentStatus, string> = {
  waiting: "Waiting for you", working: "Working", done: "Done", idle: "Idle",
};

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

