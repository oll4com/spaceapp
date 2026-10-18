import { failureCategorySchema, isSafeErrorCode } from "@space/contracts";

const allowedKeys = new Set([
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "service.name",
  "space.request_id",
  "space.trace_id",
  "space.workflow_id",
  "space.workflow_type",
  "space.run_id",
  "space.temporal_run_id",
  "space.activity_id",
  "space.activity_type",
  "space.source_run_id",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.turn_id",
  "space.goal_id",
  "space.dot_id",
  "space.agent_run_id",
  "space.agent_session_id",
  "space.action_id",
  "space.cli_task_id",
  "space.revision_id",
  "space.status",
  "space.outcome",
  "space.attempt",
  "space.reason_code",
  "space.category",
  "space.duration_ms",
  "space.queue_ms",
  "link.reason"
]);

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const routePattern = /^\/[A-Za-z0-9:._/-]{1,200}$/;
const httpMethodPattern = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
const linkReasons = new Set(["continue_as_new", "background_continuation", "room_agent_mission"]);

export function isAllowlistedSpanAttributeKey(key: string): boolean {
  return allowedKeys.has(key);
}

function sanitizeValue(key: string, value: unknown): string | number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (key === "http.response.status_code") {
      return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
    }
    if (key === "space.attempt") return Number.isInteger(value) && value >= 1 ? value : null;
    if (key === "space.duration_ms" || key === "space.queue_ms") return value >= 0 ? value : null;
    return null;
  }
  if (typeof value !== "string") return null;
  if (key === "http.request.method") return httpMethodPattern.test(value) ? value : null;
  if (key === "http.route") return routePattern.test(value) && !value.includes("//") ? value : null;
  if (key === "space.reason_code") return isSafeErrorCode(value) ? value : null;
  if (key === "space.category") return failureCategorySchema.safeParse(value).success ? value : null;
  if (key === "link.reason") return linkReasons.has(value) ? value : null;
  return identifierPattern.test(value) ? value : null;
}

/** Retain only bounded, low-risk telemetry fields and validated values. */
export function sanitizeSpanAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, string | number> {
  if (!attributes || typeof attributes !== "object") return {};
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowedKeys.has(key)) continue;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== null) safe[key] = sanitized;
  }
  return safe;
}
