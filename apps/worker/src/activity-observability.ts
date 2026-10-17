import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory, Headers } from "@temporalio/worker";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type FailureCategory
} from "@space/contracts";
import { sanitizeSpanAttributes, type SpanExporter } from "@space/runtime";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";
import {
  decodeSpaceTraceHeader,
  extractArgsTraceContext,
  mergeTraceContexts
} from "./workflow-observability-interceptors.js";

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

function randomNonZeroHex(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(value)) return value;
  }
}

/** traceparent for an outbound call: same W3C trace, new span id; null if none. */
export function childTraceparent(traceparent: string | null | undefined): string | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  return formatTraceparent(parsed.traceId, randomNonZeroHex(8), parsed.flags);
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
  /** OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity whose input or workflow header carries a traceparent. */
  spans?: SpanExporter | null;
  /** Inbound Temporal headers from the workflow outbound interceptor. */
  headers?: Headers;
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
  const headerCtx = decodeSpaceTraceHeader(dependencies.headers);
  const argsCtx = extractArgsTraceContext(args, info.workflowType);
  const mergedCtx = mergeTraceContexts(headerCtx, argsCtx);
  const argCorr = activityCorrelation(args);
  const w3cTraceId = traceIdFromTraceparent(mergedCtx.traceparent) ?? argCorr.w3cTraceId;
  const base: Record<string, WorkerLogValue> = {
    activityType,
    activityId: info.activityId,
    workflowType: info.workflowType ?? null,
    workflowId: info.workflowExecution?.workflowId ?? null,
    temporalRunId: info.workflowExecution?.runId ?? null,
    attempt: info.attempt,
    ...(mergedCtx.traceId ? { traceId: mergedCtx.traceId } : {}),
    ...(w3cTraceId ? { w3cTraceId } : {}),
    ...(mergedCtx.parentTraceId ? { parentTraceId: mergedCtx.parentTraceId } : {}),
    ...(mergedCtx.roomId ? { roomId: mergedCtx.roomId } : {}),
    ...(mergedCtx.paneId ? { paneId: mergedCtx.paneId } : {}),
    ...(mergedCtx.missionId ? { missionId: mergedCtx.missionId } : {}),
    ...(mergedCtx.agentRunId ? { agentRunId: mergedCtx.agentRunId } : {}),
    ...(mergedCtx.actionId ? { actionId: mergedCtx.actionId } : {}),
    ...(mergedCtx.goalId ? { goalId: mergedCtx.goalId } : {}),
    ...(mergedCtx.dotId ? { dotId: mergedCtx.dotId } : {}),
    ...(mergedCtx.turnId ? { turnId: mergedCtx.turnId } : {}),
    ...argCorr
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
    const parent = dependencies.spans
      ? (parseTraceparent(headerCtx?.traceparent) ?? activityTraceparent(args))
      : null;
    if (parent) {
      const rawAttributes: Record<string, unknown> = {
        "space.activity_type": activityType,
        "space.outcome": outcome,
        "space.attempt": info.attempt,
        "space.duration_ms": durationMs,
        ...(queueMs !== null ? { "space.queue_ms": queueMs } : {}),
        ...(info.workflowType ? { "space.workflow_type": info.workflowType } : {}),
        ...(info.workflowExecution?.workflowId ? { "space.workflow_id": info.workflowExecution.workflowId } : {}),
        ...(info.workflowExecution?.runId ? { "space.run_id": info.workflowExecution.runId } : {}),
        ...(mergedCtx.traceId ? { "space.trace_id": mergedCtx.traceId } : {}),
        ...(mergedCtx.parentTraceId ? { "space.parent_trace_id": mergedCtx.parentTraceId } : {}),
        ...(mergedCtx.roomId ? { "space.room_id": mergedCtx.roomId } : {}),
        ...(mergedCtx.paneId ? { "space.pane_id": mergedCtx.paneId } : {}),
        ...(mergedCtx.missionId ? { "space.mission_id": mergedCtx.missionId } : {}),
        ...(mergedCtx.agentRunId ? { "space.agent_run_id": mergedCtx.agentRunId } : {}),
        ...(mergedCtx.continuationOfRunId ? { "space.continuation_of_run_id": mergedCtx.continuationOfRunId } : {}),
        ...(mergedCtx.continuationGeneration !== undefined ? { "space.continuation_generation": mergedCtx.continuationGeneration } : {}),
        ...(mergedCtx.actionId ? { "space.action_id": mergedCtx.actionId } : {}),
        ...(mergedCtx.goalId ? { "space.goal_id": mergedCtx.goalId } : {}),
        ...(mergedCtx.dotId ? { "space.dot_id": mergedCtx.dotId } : {}),
        ...(mergedCtx.turnId ? { "space.turn_id": mergedCtx.turnId } : {}),
        ...(mergedCtx.changeSetId ? { "space.change_set_id": mergedCtx.changeSetId } : {}),
        ...(mergedCtx.consolidationRunId ? { "space.consolidation_run_id": mergedCtx.consolidationRunId } : {}),
        ...(reasonCode && isSafeErrorCode(reasonCode)
          ? { "space.reason_code": reasonCode, "space.error_code": reasonCode }
          : {}),
        ...(category ? { "space.category": category } : {})
      };
      dependencies.spans!.record({
        traceId: parent.traceId,
        spanId: randomNonZeroHex(8),
        parentSpanId: parent.parentId,
        name: `activity ${activityType}`,
        startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
        endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
        attributes: sanitizeSpanAttributes(rawAttributes),
        error: outcome === "FAILED" || outcome === "FAILED_RESULT",
        kind: 1
      });
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
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled" | "headers"> = {}): ActivityInterceptorsFactory {
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
