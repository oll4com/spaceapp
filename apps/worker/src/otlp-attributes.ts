import { isSafeErrorCode } from "@space/contracts";
import { logIdentifier } from "./worker-log.js";

/**
 * Strict allowlist of attributes that may be exported in OTLP spans.
 *
 * Privacy & Security Policy (Issue #61):
 * Spans MUST carry only IDs, types, attempt counts, status/outcome, safe error
 * codes/categories, and durations.
 * Under NO circumstances may prompts, operator instructions, assistant responses,
 * message contents, tool payloads, query strings, URLs, file paths, or credentials
 * be emitted in attributes.
 */

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  // Resource / Service
  "service.name",
  // Standard HTTP / Route (API)
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "space.request_id",
  // Correlation IDs
  "space.trace_id",
  "space.w3c_trace_id",
  "space.parent_trace_id",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.turn_id",
  "space.action_id",
  "space.goal_id",
  "space.dot_id",
  "space.agent_run_id",
  "space.agent_session_id",
  "space.cli_task_id",
  "space.revision_id",
  // Temporal Workflow / Activity identifiers & execution state
  "temporal.workflow_id",
  "temporal.workflow_type",
  "temporal.run_id",
  "temporal.parent_run_id",
  "temporal.parent_workflow_id",
  "temporal.activity_id",
  "temporal.activity_type",
  "temporal.attempt",
  "temporal.status",
  "temporal.outcome",
  "temporal.duration_ms",
  "temporal.queue_ms",
  // Error / Classification
  "temporal.reason_code",
  "temporal.failure_category",
  "temporal.error_code",
  "temporal.error_name",
  // Link metadata
  "link.reason"
]);

/**
 * Validates and filters attributes against the strict allowlist.
 * Free-text strings, paths, URLs, and unknown keys are strictly dropped.
 */
export function allowlistSpanAttributes(
  raw: Readonly<Record<string, unknown>>
): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key) || value === null || value === undefined) {
      continue;
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        sanitized[key] = value;
      }
      continue;
    }

    if (typeof value === "string") {
      // Must pass identifier or safe code validation
      const safeIdent = logIdentifier(value);
      if (safeIdent !== null) {
        sanitized[key] = safeIdent;
      } else if (isSafeErrorCode(value)) {
        sanitized[key] = value;
      }
    }
  }

  return sanitized;
}

/**
 * Derives a deterministic 16-character hex W3C Span ID from a 128-bit Temporal UUID runId.
 */
export function runIdToSpanId(runId: string | null | undefined): string {
  if (!runId) return "0000000000000000";
  const hex = runId.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.length >= 16 ? hex.slice(0, 16) : hex.padStart(16, "0");
}
