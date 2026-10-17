import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { ActivityInfo } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type ActivityObservation,
  type ActivityOutcome,
  type FailureCategory
} from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import {
  SPAN_KIND_INTERNAL,
  sanitizeSpanAttributes,
  spanIdFromRunId,
  traceparentFromHeaders
} from "./otlp-span-context.js";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";

export { type ActivityObservation, type ActivityOutcome, type FailureCategory };

const observations = new AsyncLocalStorage<ActivityObservation>();

/**
 * Associates an internal or downstream failure code with the active activity,
 * so the activity-execution metrics and worker log line report it without
 * exposing the error message. Unknown or unsafe codes are rejected.
 */
export function noteActivityFailureReason(code: string | null | undefined): void {
  if (!code || !isSafeErrorCode(code)) return;
  const observation = observations.getStore();
  if (observation && !observation.reasonCode) observation.reasonCode = code;
}

/** Runs a callback in an isolated observation scope; used for unit tests. */
export function withActivityObservationScope<T>(execute: () => Promise<T>): { promise: Promise<T>; reasonCode: () => string | null } {
  const existing = observations.getStore();
  if (existing) return { promise: execute(), reasonCode: () => existing.reasonCode };
  const observation: ActivityObservation = { reasonCode: null };
  return { promise: observations.run(observation, execute), reasonCode: () => observation.reasonCode };
}

export const failureReasonScope = withActivityObservationScope;

/** traceparent for an outbound call: same W3C trace, new span id; null if none. */
export function childTraceparent(traceparent: string | null | undefined): string | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
  return formatTraceparent(parsed.traceId, spanId, parsed.flags);
}

// Keys whose values are identifiers. Prompts, content and messages are never read.
const correlationKeys = [
  "traceId",
  "traceparent",
  "requestId",
  "roomId",
  "paneId",
  "missionId",
  "roomAgentMissionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId"
] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

type CorrelationKey = (typeof correlationKeys)[number];

function readCorrelation(value: unknown, into: Partial<Record<CorrelationKey, string>>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (into[key] !== undefined) continue;
    const identifier = logIdentifier(record[key]);
    if (identifier !== null) into[key] = identifier;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) readCorrelation(record[key], into, depth - 1);
}

/** Allowlisted correlation fields from activity arguments (identifiers only). */
export function activityCorrelation(args: readonly unknown[]): Record<string, string> {
  const found: Partial<Record<CorrelationKey, string>> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  const correlation: Record<string, string> = {};
  if (found.traceId) correlation.traceId = found.traceId;
  const w3cTraceId = traceIdFromTraceparent(found.traceparent);
  if (w3cTraceId) correlation.w3cTraceId = w3cTraceId;
  if (found.requestId && found.requestId !== found.traceId) correlation.parentTraceId = found.requestId;
  const missionId = found.missionId ?? found.roomAgentMissionId;
  if (missionId) correlation.missionId = missionId;
  for (const key of ["roomId", "paneId", "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"] as const) {
    if (found[key]) correlation[key] = found[key]!;
  }
  return correlation;
}

function errorCodeOf(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown } | null;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "ACTIVITY_CANCELLED";
  if (/Timeout/i.test(name)) return "ACTIVITY_TIMEOUT";
  if (/NotFound/i.test(name)) return "STATE_NOT_FOUND";
  if (/Retryable/i.test(name)) return "UPSTREAM_RETRYABLE_UNAVAILABLE";
  return "ACTIVITY_ERROR";
}

function isFailedResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { status?: unknown }).status === "FAILED");
}

export interface ObserveActivityDependencies {
  metrics?: WorkerMetrics;
  now?: () => number;
  cancelled?: () => boolean;
  /** OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity whose input carries a traceparent. */
  spans?: SpanExporter | null;
  /** When set, one span per activity attempt is recorded. */
  spanExporter?: SpanExporter | null;
  /** Traceparent propagated in the activity task headers by the workflow interceptor. */
  traceparent?: string | null;
}

function activityTraceparent(args: readonly unknown[]) {
  const found: Partial<Record<CorrelationKey, string>> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  return parseTraceparent(found.traceparent);
}

export async function observeActivityExecution<T>(
  info: ActivityInfo,
  args: readonly unknown[],
  execute: () => Promise<T>,
  dependencies: ObserveActivityDependencies = {}
): Promise<T> {
  const metrics = dependencies.metrics ?? workerMetrics;
  const now = dependencies.now ?? Date.now;
  const activityType = logIdentifier(info.activityType) ?? "unknown";
  const startedAt = now();
  const queueMs = Number.isFinite(info.currentAttemptScheduledTimestampMs)
    ? Math.max(0, startedAt - info.currentAttemptScheduledTimestampMs)
    : null;
  const correlation = activityCorrelation(args);
  const base: Record<string, WorkerLogValue> = {
    activityType,
    activityId: info.activityId,
    workflowType: info.workflowType ?? null,
    workflowId: info.workflowExecution?.workflowId ?? null,
    temporalRunId: info.workflowExecution?.runId ?? null,
    attempt: info.attempt,
    ...correlation
  };
  const labels = { activity_type: activityType };
  if (info.attempt > 1) metrics.activityRetries.inc(labels);
  if (queueMs !== null) metrics.activityScheduleToStart.observe(labels, queueMs / 1000);
  metrics.activitiesInFlight.inc(labels);
  workerLog("info", "activity.started", { ...base, queueMs });
  const observation: ActivityObservation = { reasonCode: null };

  const finish = (outcome: ActivityOutcome, reasonCode: string | null, errorName: string | null) => {
    const durationMs = Math.max(0, now() - startedAt);
    metrics.activitiesInFlight.inc(labels, -1);
    metrics.activityExecutions.inc({ activity_type: activityType, outcome });
    metrics.activityDuration.observe(labels, durationMs / 1000);
    let category: FailureCategory | null = null;
    if (outcome !== "COMPLETED") {
      category = outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(reasonCode);
      metrics.activityFailures.inc({ activity_type: activityType, category, code: reasonCode ?? "UNSPECIFIED" });
    }
    workerLog(outcome === "COMPLETED" ? "info" : outcome === "CANCELLED" ? "warn" : "error", "activity.finished", {
      ...base,
      outcome,
      reasonCode,
      category,
      errorName,
      durationMs,
      queueMs,
      rssBytes: process.memoryUsage().rss
    });
    const exporter = dependencies.spans ?? dependencies.spanExporter ?? null;
    if (exporter) {
      const propagated = parseTraceparent(dependencies.traceparent);
      const parent = propagated ?? activityTraceparent(args);
      const traceId = parent?.traceId ?? correlation.w3cTraceId ?? null;
      const runId = info.workflowExecution?.runId;
      if (traceId) {
        let spanId = randomBytes(8).toString("hex");
        while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
        const parentSpanId = parent?.parentId ?? (runId ? spanIdFromRunId(runId) : null);
        const startTimeUnixNano = BigInt(Math.round(startedAt)) * 1_000_000n;
        const endTimeUnixNano = BigInt(Math.round(startedAt + durationMs)) * 1_000_000n;
        exporter.record({
          traceId,
          spanId,
          parentSpanId,
          name: `activity ${activityType}`,
          startTimeUnixNano,
          endTimeUnixNano,
          attributes: sanitizeSpanAttributes({
            "space.activity_type": activityType,
            "space.activity_id": info.activityId,
            "space.workflow_type": info.workflowType ?? undefined,
            "space.workflow_id": info.workflowExecution?.workflowId,
            "space.run_id": runId,
            "space.attempt": info.attempt,
            "space.outcome": outcome,
            "space.reason_code": reasonCode ?? undefined,
            "space.category": category ?? undefined,
            "space.duration_ms": durationMs,
            "space.queue_ms": queueMs ?? undefined,
            "space.room_id": correlation.roomId,
            "space.pane_id": correlation.paneId,
            "space.mission_id": correlation.missionId,
            "space.agent_run_id": correlation.agentRunId,
            "space.agent_session_id": correlation.agentSessionId,
            "space.action_id": correlation.actionId,
            "space.goal_id": correlation.goalId,
            "space.dot_id": correlation.dotId,
            "space.turn_id": correlation.turnId,
            "space.cli_task_id": correlation.cliTaskId,
            "space.revision_id": correlation.revisionId
          }),
          error: outcome !== "COMPLETED",
          kind: SPAN_KIND_INTERNAL
        });
      }
    }
  };

  try {
    const result = await observations.run(observation, execute);
    if (isFailedResult(result)) finish("FAILED_RESULT", observation.reasonCode ?? "ACTIVITY_RESULT_FAILED", null);
    else finish("COMPLETED", null, null);
    return result;
  } catch (error) {
    const cancelled = dependencies.cancelled?.() === true || /Cancel/i.test((error as { name?: string } | null)?.name ?? "");
    const errorName = logIdentifier((error as { name?: unknown } | null)?.name);
    finish(cancelled ? "CANCELLED" : "FAILED", observation.reasonCode ?? errorCodeOf(error), errorName);
    throw error;
  }
}

/** Temporal worker interceptor factory: register in Worker.create({ interceptors }). */
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled"> = {}): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      execute: (input, next) => observeActivityExecution(context.info, input.args, () => next(input), {
        ...dependencies,
        traceparent: traceparentFromHeaders(input.headers),
        cancelled: () => context.cancellationSignal.aborted
      })
    }
  });
}
