import { isSafeErrorCode } from "@space/contracts";
import { logIdentifier } from "./worker-log.js";

/**
 * Strict allowlist of attributes that may be exported in OTLP spans.
 *
 * Privacy & Security Policy (Issue #61):
 * Spans MUST carry only IDs, types, attempt counts, status/outcome, safe error
 * codes/categories, and durations.
 * Prompts, operator instructions, assistant response text, query parameters,
 * credentials, URLs, and filesystem paths are NEVER exported.
 */

export const ALLOWLISTED_ATTRIBUTE_KEYS = new Set([
  // Service
  "service.name",

  // HTTP (API)
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "space.request_id",

  // Correlation IDs (Identifiers only)
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

  // Execution state & metrics
  "space.workflow_type",
  "space.activity_type",
  "space.outcome",
  "space.attempt",
  "space.reason_code",
  "space.category",
  "space.duration_ms",
  "space.queue_ms",

  // Temporal execution identifiers
  "temporal.workflow_id",
  "temporal.workflow_type",
  "temporal.run_id",
  "temporal.parent_run_id",
  "temporal.parent_workflow_id",
  "temporal.activity_id",
  "temporal.activity_type",
  "temporal.attempt",

  // Span link reasons
  "link.reason"
]);

/**
 * Derives a deterministic 16-character hex span ID from a Temporal execution run ID.
 * Temporal runId is an immutable UUID v4 assigned by the Temporal server for that execution.
 */
export function runIdToSpanId(runId: string): string {
  const hex = runId.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  let id = hex.slice(0, 16);
  if (id.length < 16) id = id.padEnd(16, "0");
  if (/^0+$/.test(id)) id = "0000000000000001";
  return id;
}

const safeTextPattern = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * Sanitizes and filters attributes against the strict allowlist.
 */
export function allowlistSpanAttributes(attributes: Record<string, unknown>): Record<string, string | number> {
  const filtered: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWLISTED_ATTRIBUTE_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === "number" && Number.isFinite(value)) {
      filtered[key] = value;
      continue;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      // Drop URLs, absolute/relative paths, multi-line prompts or arbitrary long text
      if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\n") || trimmed.includes("\r")) {
        continue;
      }
      if (safeTextPattern.test(trimmed)) {
        filtered[key] = trimmed;
      }
    }
  }
  return filtered;
}
