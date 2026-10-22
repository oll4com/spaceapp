import { SpaceApiError } from "./api.js";
import { type Event as SpaceEvent } from "@space/contracts";

export type AppView = "workspace" | "help" | "benchmark";

export function readAppView(): AppView {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/help") return "help";
  if (pathname === "/benchmark") return "benchmark";
  return "workspace";
}

export function isTransientUpstreamErrorMessage(message: string | null): boolean {
  if (!message) return false;
  return (
    message.startsWith("UPSTREAM_UNAVAILABLE:") ||
    message.includes("Space API is not reachable from the web server.") ||
    message.startsWith("Request failed: 502")
  );
}

export function isTransientUpstreamRuntimeError(error: unknown): boolean {
  if (error instanceof SpaceApiError) {
    return error.code === "UPSTREAM_UNAVAILABLE" || error.status === 0 || error.status === 502;
  }
  if (error instanceof Error) {
    return isTransientUpstreamErrorMessage(error.message);
  }
  return false;
}

export const streamEventTypes: SpaceEvent["type"][] = [
  "ROOM_CREATED",
  "PANE_CREATED",
  "PANE_UPDATED",
  "PANE_CLOSED",
  "TURN_STARTED",
  "TURN_DELTA",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "APPROVAL_REQUESTED",
  "ARTIFACT_CREATED",
  "CAPABILITY_STATUS_CHANGED",
  "MEMORY_SAVED",
  "SKILL_PROPOSED",
  "IMPORT_CANDIDATE_CREATED",
  "IMPORT_CANDIDATE_DECIDED",
  "SWARM_TASK_CREATED",
  "SWARM_TASK_UPDATED",
  "SWARM_LOCK_CLAIMED",
  "SWARM_LOCK_RELEASED",
  "SWARM_MESSAGE_POSTED",
  "SWARM_RECONCILED",
  "REVIEW_CHECK_RECORDED",
  "REVIEW_DIFF_RECORDED",
  "REVIEW_DECISION_CREATED",
  "BROWSER_HANDOFF_REQUESTED",
  "ROOM_WATCHDOG_ALERT",
  "JOB_APPLY_UPDATED",
  "MAIL_COPILOT_UPDATED",
  "MARKETING_COPILOT_UPDATED",
  "FREELANCE_COPILOT_UPDATED",
  "DESIGN_UPDATED",
  "APP_STUDIO_UPDATED",
  "NOTIFICATION_CREATED",
  "NOTIFICATION_UPDATED"
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStreamEvent(data: string, roomId?: string): SpaceEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const type = payload.type;
  const eventRoomId = payload.roomId;
  if (typeof type !== "string" || !streamEventTypes.includes(type as SpaceEvent["type"])) return null;
  if (typeof eventRoomId !== "string" || (roomId && eventRoomId !== roomId)) return null;
  if (
    typeof payload.id !== "string" ||
    typeof payload.traceId !== "string" ||
    typeof payload.message !== "string" ||
    typeof payload.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: payload.id,
    roomId: eventRoomId,
    paneId: typeof payload.paneId === "string" ? payload.paneId : null,
    turnId: typeof payload.turnId === "string" ? payload.turnId : null,
    workflowId: typeof payload.workflowId === "string" ? payload.workflowId : null,
    traceId: payload.traceId,
    type: type as SpaceEvent["type"],
    message: payload.message,
    payload: isRecord(payload.payload) ? payload.payload : {},
    createdAt: payload.createdAt
  };
}
