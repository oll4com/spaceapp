import { failureCategorySchema, isSafeErrorCode } from "@space/contracts";

/** Keys a worker span or link may carry. Everything else is dropped before export. */
export const SPAN_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  "space.trace_id",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "temporal.workflow.id",
  "temporal.workflow.run_id",
  "temporal.workflow.type",
  "temporal.activity.type",
  "temporal.activity.id",
  "temporal.activity.attempt",
  "space.outcome",
  "error.code",
  "space.error.category",
  "space.duration_ms",
  "space.queue_ms",
  "space.link.kind"
]);

// Same shape as the Temporal memo ids: no slashes, spaces, URLs or free text.
const identifierValuePattern = /^[A-Za-z0-9:._-]{1,200}$/;
const failureCategories: ReadonlySet<string> = new Set(failureCategorySchema.options);

/**
 * Allowlisted, identifier-shaped attributes only. Unknown keys, free text,
 * paths, URLs, non-finite numbers, unsafe error codes and unknown failure
 * categories are dropped silently.
 */
export function allowlistSpanAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const output: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SPAN_ATTRIBUTE_ALLOWLIST.has(key)) continue;
    if (key === "error.code") {
      if (isSafeErrorCode(value)) output[key] = value;
    } else if (key === "space.error.category") {
      if (typeof value === "string" && failureCategories.has(value)) output[key] = value;
    } else if (["temporal.activity.attempt", "space.duration_ms", "space.queue_ms"].includes(key)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) output[key] = value;
    } else if (key === "space.outcome") {
      if (typeof value === "string" && ["COMPLETED", "FAILED_RESULT", "FAILED", "CANCELLED", "CONTINUED_AS_NEW"].includes(value)) output[key] = value;
    } else if (key === "space.link.kind") {
      if (value === "continue_as_new" || value === "background_continuation") output[key] = value;
    } else if (typeof value === "string" && identifierValuePattern.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

