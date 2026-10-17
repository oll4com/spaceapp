import { isSafeErrorCode } from "@space/contracts";

/**
 * Strict allowlist of permitted OTLP span attribute keys.
 * High-cardinality values, raw inputs, prompts, file paths, URLs, error messages
 * and user text are forbidden.
 */
export const ALLOWED_SPAN_ATTRIBUTE_KEYS = new Set([
  // HTTP
  "http.request.method",
  "http.route",
  "http.response.status_code",
  // Service
  "service.name",
  // Space Correlation & IDs
  "space.request_id",
  "space.trace_id",
  "space.workflow_id",
  "space.workflow_type",
  "space.run_id",
  "space.temporal_run_id",
  "space.activity_id",
  "space.activity_type",
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
  "space.source_run_id",
  "space.generation",
  // Status, Outcome & Error Classification
  "space.status",
  "space.outcome",
  "space.attempt",
  "space.reason_code",
  "space.category",
  // Durations & Timings
  "space.duration_ms",
  "space.queue_ms",
  // Span Links
  "link.reason"
]);

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const routePattern = /^\/[A-Za-z0-9:._\/-]{1,200}$/;
const httpMethodPattern = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

export function isAllowlistedSpanAttributeKey(key: string): boolean {
  return ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key);
}

export function sanitizeSpanAttributeValue(key: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  if (key === "http.route") {
    return routePattern.test(value) && !value.includes("//") ? value : null;
  }
  if (key === "http.request.method") {
    return httpMethodPattern.test(value) ? value : null;
  }
  if (key === "space.reason_code") {
    return isSafeErrorCode(value) ? value : null;
  }
  return identifierPattern.test(value) ? value : null;
}

/**
 * Enforces the span attribute allowlist and value sanitization.
 * Drops any non-allowlisted keys or unsafe values.
 */
export function sanitizeSpanAttributes(
  attributes: Readonly<Record<string, unknown>>
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isAllowlistedSpanAttributeKey(key)) continue;
    const sanitized = sanitizeSpanAttributeValue(key, value);
    if (sanitized !== null) {
      result[key] = sanitized;
    }
  }
  return result;
}
