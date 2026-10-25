import type { DeployQueueReport, DeployQueueSubmitter, DeployQueueTicketStatus } from "@space/contracts";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";

export interface DeployQueueClient {
  deployQueue(): Promise<DeployQueueReport>;
}

export const statusTone: Record<DeployQueueTicketStatus, string> = {
  AWAITING_APPROVAL: "warn",
  QUEUED: "idle",
  INTEGRATING: "busy",
  VERIFYING: "busy",
  DEPLOYING: "busy",
  DEPLOYED: "ok",
  CONFLICT: "warn",
  FAILED: "bad",
  CANCELLED: "idle"
};

export const statusLabel: Record<DeployQueueTicketStatus, string> = {
  AWAITING_APPROVAL: "Needs approval",
  QUEUED: "Queued",
  INTEGRATING: "Merging",
  VERIFYING: "Building",
  DEPLOYING: "Deploying",
  DEPLOYED: "Live",
  CONFLICT: "Conflict",
  FAILED: "Failed",
  CANCELLED: "Cancelled"
};

export function relative(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** Elapsed time since `iso`, as `45s`, `6m 12s` or `1h 03m`; null when the time is unknown. */
export function elapsed(iso: string | null | undefined, now: number): string | null {
  const start = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface SubmitterView {
  /** The CLI product, such as Claude Code; null when the ticket came from outside a Space CLI pane. */
  cli: string | null;
  iconSrc: string | null;
  /** The pane name; null when the pane was closed or is unknown. */
  pane: string | null;
  room: string | null;
}

export function submitterView(submitter: DeployQueueSubmitter | null | undefined): SubmitterView {
  const presentation = cliRuntimePresentation(submitter?.runtimeId);
  return {
    cli: presentation?.displayName ?? (submitter?.runtimeId ? submitter.runtimeId.replace(/^cli:/, "") : null),
    iconSrc: presentation?.iconSrc ?? null,
    pane: submitter?.paneTitle ?? null,
    room: submitter?.roomName ?? null
  };
}
