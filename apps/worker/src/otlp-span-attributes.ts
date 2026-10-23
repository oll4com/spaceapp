import { categorizeFailureCode, isSafeErrorCode } from "@space/contracts";

/**
 * The only attributes worker spans may carry: identifiers, workflow and
 * activity types, attempt, status, stable error code and category, and
 * durations. Prompts, model output, file paths, URLs, error messages and any
 * user text are never exported, because nothing outside this list leaves the
 * process and every value must match its kind.
 */
type AttributeKind = "id" | "code" | "count" | "duration";

export const workerSpanAttributeAllowlist: Readonly<Record<string, AttributeKind>> = {
  "space.trace_id": "id",
  "space.parent_trace_id": "id",
  "space.workflow_id": "id",
  "space.run_id": "id",
  "space.parent_workflow_id": "id",
  "space.workflow_type": "id",
  "space.task_queue": "id",
  "space.activity_type": "id",
  "space.activity_id": "id",
  "space.room_id": "id",
  "space.pane_id": "id",
  "space.mission_id": "id",
  "space.agent_run_id": "id",
  "space.goal_id": "id",
  "space.continuation_of_run_id": "id",
  "space.attempt": "count",
  "space.outcome": "code",
  "space.reason_code": "code",
  "space.category": "code",
  "space.link": "code",
  "space.queue_ms": "duration",
  "space.duration_ms": "duration"
};

// Same shape as worker log identifiers, minus "/" so a path can never pass as an id.
const idPattern = /^[A-Za-z0-9:._-]{1,200}$/;

/** True when `value` is valid for its attribute kind; ids never look like a URL or a path. */
function allowed(kind: AttributeKind, value: unknown): value is string | number {
  switch (kind) {
    case "id":
      return typeof value === "string" && idPattern.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    case "code":
      return isSafeErrorCode(value);
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
    case "duration":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
}

/** Keeps allowlisted keys whose values match their kind; drops everything else. */
export function workerSpanAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    const kind = workerSpanAttributeAllowlist[key];
    if (kind && value !== null && value !== undefined && allowed(kind, value)) {
      attributes[key] = kind === "duration" ? Math.round(value as number) : value;
    }
  }
  return attributes;
}

/** Outcome, reason code and category for a span, in one place for workflows and activities. */
export function outcomeAttributes(outcome: string, reasonCode: string | null): Record<string, string> {
  const attributes: Record<string, string> = { "space.outcome": outcome };
  if (outcome !== "COMPLETED") {
    const code = isSafeErrorCode(reasonCode) ? reasonCode : null;
    if (code) attributes["space.reason_code"] = code;
    attributes["space.category"] = outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(code);
  }
  return attributes;
}
