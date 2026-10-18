import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { ApplicationFailure, type Headers } from "@temporalio/common";
import type { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type FailureCategory
} from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import {
  contextFromHeaders,
  inputTraceContext,
  runSpanId,
  runTraceId,
  type SpanContext
} from "./workflow-trace-context.js";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";

/**
 * One structured start/finish record and metrics per activity execution, with
 * the correlation ids the API put into the workflow input. Runs in the worker
 * process (activity interceptor), never inside the deterministic workflow
 * sandbox, so it cannot affect replay.
 */

type ActivityInfo = Pick<
  Context["info"],
  "activityType" | "attempt" | "workflowExecution" | "workflowType" | "currentAttemptScheduledTimestampMs" | "activityId"
>;

export type ActivityOutcome = "COMPLETED" | "FAILED_RESULT" | "FAILED" | "CANCELLED";

interface ActivityObservation {
  reasonCode: string | null;
  spanContext?: SpanContext;
}

const observations = new AsyncLocalStorage<ActivityObservation>();

/**
 * Called by failure recorders (for example recordCodexAppServerTurnFailure)
 * that return a FAILED result instead of throwing, so the activity record
 * carries the causal reason code. A no-op outside an observed activity.
 */
export function noteActivityFailureReason(reasonCode: string): void {
  const observation = observations.getStore();
  if (observation && isSafeErrorCode(reasonCode)) observation.reasonCode = reasonCode;
}

/**
 * Runs `execute` inside a failure-reason scope, reusing the activity's scope
 * when the interceptor already opened one, and exposes the noted reason code.
 */
export function failureReasonScope<T>(execute: () => Promise<T>): { promise: Promise<T>; reasonCode: () => string | null } {
  const existing = observations.getStore();
  if (existing) return { promise: execute(), reasonCode: () => existing.reasonCode };
  const observation: ActivityObservation = { reasonCode: null };
  return { promise: observations.run(observation, execute), reasonCode: () => observation.reasonCode };
}

/** Propagate the recorded activity span, or the existing caller when tracing is off. */
export function activityTraceparent(fallback?: string | null): string | null {
  const active = observations.getStore()?.spanContext;
  if (active) return formatTraceparent(active.traceId, active.spanId);
  const parsed = parseTraceparent(fallback);
  return parsed ? formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags) : null;
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
  "sourceRunId",
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
  const continuation = record.roomAgentContinuation;
  if (into.sourceRunId === undefined && continuation && typeof continuation === "object") {
    const sourceRunId = (continuation as Record<string, unknown>).sourceRunId;
    const identifier = logIdentifier(sourceRunId);
    if (identifier !== null) into.sourceRunId = identifier;
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
  for (const key of ["roomId", "paneId", "agentRunId", "agentSessionId", "actionId", "sourceRunId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"] as const) {
    if (found[key]) correlation[key] = found[key]!;
  }
  return correlation;
}

function errorCodeOf(error: unknown): string {
  const seen = new Set<unknown>();
  let found: string | null = null;
  let fallbackName = "";
  for (let depth = 0; depth < 8 && error && typeof error === "object" && !seen.has(error); depth++) {
    seen.add(error);
    const record = error as { code?: unknown; type?: unknown; name?: unknown; cause?: unknown };
    if (isSafeErrorCode(record.code)) found = record.code;
    else if (isSafeErrorCode(record.type)) found = record.type;
    if (!fallbackName && typeof record.name === "string" && record.name && record.name !== "Error") {
      fallbackName = record.name;
    } else if (!fallbackName && typeof record.type === "string" && record.type) {
      fallbackName = record.type;
    }
    error = record.cause;
  }
  if (found) return found;
  if (/Cancel/i.test(fallbackName)) return "ACTIVITY_CANCELLED";
  if (/Timeout/i.test(fallbackName)) return "ACTIVITY_TIMEOUT";
  if (/Conflict/i.test(fallbackName)) return "CONFLICT";
  if (/NotFound/i.test(fallbackName)) return "STATE_NOT_FOUND";
  if (/Retryable/i.test(fallbackName)) return "UPSTREAM_RETRYABLE_UNAVAILABLE";
  return "ACTIVITY_ERROR";
}

function isFailedResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { status?: unknown }).status === "FAILED");
}

export interface ObserveActivityDependencies {
  metrics?: WorkerMetrics;
  now?: () => number;
  cancelled?: () => boolean;
  /** Optional OTLP export: one span per attempt, parented to its workflow. */
  spans?: SpanExporter | null;
  headers?: Headers;
}

function randomSpanId(): string {
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
  return spanId;
}

export function activitySpanParent(info: ActivityInfo, args: readonly unknown[], headers?: Headers): SpanContext | null {
  const propagated = contextFromHeaders(headers);
  if (propagated) return { traceId: propagated.traceId, spanId: propagated.spanId };
  const request = inputTraceContext(args);
  const runId = info.workflowExecution?.runId;
  if (request && runId) return { traceId: request.traceId, spanId: runSpanId(runId) };
  if (request) return request;
  if (runId) return { traceId: runTraceId(runId), spanId: runSpanId(runId) };
  return null;
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
  const base: Record<string, WorkerLogValue> = {
    activityType,
    activityId: info.activityId,
    workflowType: info.workflowType ?? null,
    workflowId: info.workflowExecution?.workflowId ?? null,
    temporalRunId: info.workflowExecution?.runId ?? null,
    attempt: info.attempt,
    ...activityCorrelation(args)
  };
  const labels = { activity_type: activityType };
  if (info.attempt > 1) metrics.activityRetries.inc(labels);
  if (queueMs !== null) metrics.activityScheduleToStart.observe(labels, queueMs / 1000);
  metrics.activitiesInFlight.inc(labels);
  workerLog("info", "activity.started", { ...base, queueMs });
  const parent = dependencies.spans ? activitySpanParent(info, args, dependencies.headers) : null;
  const spanContext = parent ? { traceId: parent.traceId, spanId: randomSpanId() } : undefined;
  const observation: ActivityObservation = { reasonCode: null, ...(spanContext ? { spanContext } : {}) };

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
    if (parent && spanContext) {
      const correlation = activityCorrelation(args);
      const spanAttributes: Record<string, string | number> = {
        "space.activity_type": activityType,
        "space.activity_id": info.activityId,
        "space.outcome": outcome,
        "space.attempt": info.attempt,
        "space.duration_ms": durationMs
      };
      if (queueMs !== null) spanAttributes["space.queue_ms"] = queueMs;
      if (info.workflowExecution?.workflowId) spanAttributes["space.workflow_id"] = info.workflowExecution.workflowId;
      if (info.workflowExecution?.runId) spanAttributes["space.temporal_run_id"] = info.workflowExecution.runId;
      if (info.workflowType) spanAttributes["space.workflow_type"] = info.workflowType;
      if (reasonCode && isSafeErrorCode(reasonCode)) spanAttributes["space.reason_code"] = reasonCode;
      if (category) spanAttributes["space.category"] = category;
      const fields: Array<[string, string]> = [
        ["traceId", "space.trace_id"],
        ["roomId", "space.room_id"],
        ["paneId", "space.pane_id"],
        ["missionId", "space.mission_id"],
        ["turnId", "space.turn_id"],
        ["goalId", "space.goal_id"],
        ["dotId", "space.dot_id"],
        ["agentRunId", "space.agent_run_id"],
        ["agentSessionId", "space.agent_session_id"],
        ["actionId", "space.action_id"],
        ["sourceRunId", "space.source_run_id"],
        ["cliTaskId", "space.cli_task_id"],
        ["revisionId", "space.revision_id"]
      ];
      for (const [source, target] of fields) {
        const value = correlation[source];
        if (value) spanAttributes[target] = value;
      }
      try {
        dependencies.spans!.record({
          traceId: parent.traceId,
          spanId: spanContext.spanId,
          parentSpanId: parent.spanId,
          name: "activity " + activityType,
          startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
          endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
          attributes: spanAttributes,
          error: outcome === "FAILED" || outcome === "FAILED_RESULT",
          kind: 1
        });
      } catch {
        // Telemetry is best effort and cannot change an Activity result.
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
    const reasonCode = observation.reasonCode ?? errorCodeOf(error);
    finish(cancelled ? "CANCELLED" : "FAILED", reasonCode, errorName);
    if (
      dependencies.headers &&
      error instanceof Error &&
      !isSafeErrorCode((error as { type?: unknown }).type) &&
      isSafeErrorCode(reasonCode)
    ) {
      // Temporal derives an Error's failure type from `constructor.name`, not
      // its mutable `name` property. Wrap it with an explicit type so a safe
      // custom code survives serialization into ActivityFailure. Keep it
      // retryable and preserve the original error as its cause.
      throw ApplicationFailure.create({ message: error.message, type: reasonCode, nonRetryable: false, cause: error });
    }
    throw error;
  }
}

/** Temporal worker interceptor factory: register in Worker.create({ interceptors }). */
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled"> = {}): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      execute: (input, next) => observeActivityExecution(context.info, input.args, () => next(input), {
        ...dependencies,
        headers: input.headers,
        cancelled: () => context.cancellationSignal.aborted
      })
    }
  });
}
