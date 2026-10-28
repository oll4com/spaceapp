import { categorizeFailureCode, isSafeErrorCode, type FailureCategory } from "@space/contracts";
import { MetricsRegistry } from "@space/runtime";

/**
 * Process-wide API domain metrics that services record without access to the
 * Fastify instance (workflow starts, retries and recoveries). HTTP metrics stay
 * per application instance in observability.ts. Labels are code-defined
 * workflow types, enum outcomes and failure categories only.
 */
export const apiDomainMetrics = new MetricsRegistry({ maxSeriesPerMetric: 200 });

const workflowStarts = apiDomainMetrics.counter(
  "space_temporal_workflow_starts_total",
  "Temporal workflow start and signal-with-start attempts from the API by workflow type, outcome and failure category.",
  ["workflow_type", "outcome", "category"]
);

const recoveryEvents = apiDomainMetrics.counter(
  "space_recovery_events_total",
  "Retry and recovery events recorded by API services, by bounded kind and outcome.",
  ["kind", "outcome"]
);

export type WorkflowStartOutcome = "STARTED" | "SIGNALED" | "ALREADY_STARTED" | "FAILED" | "DISABLED";

/** Stable error code for a failed workflow start; never includes the message. */
export function workflowStartErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (isSafeErrorCode(code)) return code;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/timeout|deadline/i.test(name) || /deadline exceeded|timed out|timeout/i.test(message)) return "TEMPORAL_START_TIMEOUT";
  if (/Transport|Connection|ServiceError/i.test(name) || /ECONNREFUSED|UNAVAILABLE|connect/i.test(message)) return "TEMPORAL_UNAVAILABLE";
  return "TURN_START_FAILED";
}

export function recordWorkflowStart(workflowType: string, outcome: WorkflowStartOutcome, error?: unknown): void {
  const category: FailureCategory | "NONE" = outcome === "FAILED"
    ? categorizeFailureCode(workflowStartErrorCode(error))
    : outcome === "DISABLED" ? "DISABLED" : "NONE";
  workflowStarts.inc({ workflow_type: workflowType, outcome, category });
}

export type RecoveryKind = "plan_model_retry" | "browser_stream_host";
export type RecoveryOutcome = "SCHEDULED" | "SUCCEEDED" | "FAILED";

export function recordRecoveryEvent(kind: RecoveryKind, outcome: RecoveryOutcome): void {
  recoveryEvents.inc({ kind, outcome });
}
