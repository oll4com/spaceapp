import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import {
  categorizeFailureCode,
  deterministicSpanId,
  deterministicTraceId,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  sanitizeSpanAttributes,
  traceIdFromTraceparent,
  workflowExecutionSpanId,
  type FailureCategory,
  type SpanLink
} from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";
import { defaultWorkflowTraceRegistry, type WorkflowTraceRegistry } from "./worker-observability.js";

/**
 * One structured start/finish record, metrics and optional OTLP activity span
 * per activity execution, with the correlation ids the API put into the
 * workflow input. Runs in the worker process (activity interceptor), never
 * inside the deterministic workflow sandbox, so it cannot affect replay.
 */

type ActivityInfo = Pick<
  Context["info"],
  "activityType" | "attempt" | "workflowExecution" | "workflowType" | "currentAttemptScheduledTimestampMs" | "activityId"
>;

export type ActivityOutcome = "COMPLETED" | "FAILED_RESULT" | "FAILED" | "CANCELLED";

interface ActivityObservation {
  reasonCode: string | null;
  spanId: string | null;
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
  const observation: ActivityObservation = { reasonCode: null, spanId: null };
  return { promise: observations.run(observation, execute), reasonCode: () => observation.reasonCode };
}

/** traceparent for an outbound call: same W3C trace, new span id; null if none. */
export function childTraceparent(traceparent: string | null | undefined): string | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId) || spanId === parsed.parentId) spanId = randomBytes(8).toString("hex");
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
  "revisionId",
  "changeSetId"
] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

type CorrelationKey = (typeof correlationKeys)[number];

interface ExtraTraceDetails {
  traceparent?: string;
  continuationSourceRunId?: string;
  continuationGeneration?: number;
  continuationSourceTraceId?: string;
  continuationSourceTraceparent?: string;
}

function readCorrelation(
  value: unknown,
  into: Partial<Record<CorrelationKey, string>>,
  extra: ExtraTraceDetails,
  depth: number
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (into[key] !== undefined) continue;
    const identifier = logIdentifier(record[key]);
    if (identifier !== null) into[key] = identifier;
  }
  if (!extra.traceparent && into.traceparent) {
    extra.traceparent = into.traceparent;
  }
  const continuation = record.roomAgentContinuation;
  if (continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
    const cont = continuation as Record<string, unknown>;
    const sourceRunId = logIdentifier(cont.sourceRunId);
    if (sourceRunId && !extra.continuationSourceRunId) extra.continuationSourceRunId = sourceRunId;
    if (typeof cont.generation === "number" && Number.isInteger(cont.generation) && cont.generation > 0) {
      extra.continuationGeneration = cont.generation;
    }
    const sourceTraceId = logIdentifier(cont.sourceTraceId);
    if (sourceTraceId && !extra.continuationSourceTraceId) extra.continuationSourceTraceId = sourceTraceId;
    const sourceTraceparent = logIdentifier(cont.sourceTraceparent);
    if (sourceTraceparent && !extra.continuationSourceTraceparent) extra.continuationSourceTraceparent = sourceTraceparent;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) readCorrelation(record[key], into, extra, depth - 1);
}

/** Allowlisted correlation fields from activity arguments (identifiers only). */
export function activityCorrelation(args: readonly unknown[]): Record<string, string> {
  const found: Partial<Record<CorrelationKey, string>> = {};
  const extra: ExtraTraceDetails = {};
  for (const arg of args) readCorrelation(arg, found, extra, 2);
  const correlation: Record<string, string> = {};
  if (found.traceId) correlation.traceId = found.traceId;
  const w3cTraceId = traceIdFromTraceparent(found.traceparent);
  if (w3cTraceId) correlation.w3cTraceId = w3cTraceId;
  if (found.requestId && found.requestId !== found.traceId) correlation.parentTraceId = found.requestId;
  const missionId = found.missionId ?? found.roomAgentMissionId;
  if (missionId) correlation.missionId = missionId;
  for (const key of ["roomId", "paneId", "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId", "changeSetId"] as const) {
    if (found[key]) correlation[key] = found[key]!;
  }
  return correlation;
}

function extractActivityTraceDetails(args: readonly unknown[]): {
  correlation: Record<string, string>;
  extra: ExtraTraceDetails;
} {
  const found: Partial<Record<CorrelationKey, string>> = {};
  const extra: ExtraTraceDetails = {};
  for (const arg of args) readCorrelation(arg, found, extra, 2);
  return { correlation: activityCorrelation(args), extra };
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

const correlationAttributeKeyMap: Readonly<Record<string, string>> = {
  traceId: "space.trace_id",
  parentTraceId: "space.parent_trace_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  missionId: "space.mission_id",
  agentRunId: "space.agent_run_id",
  agentSessionId: "space.agent_session_id",
  actionId: "space.action_id",
  goalId: "space.goal_id",
  dotId: "space.dot_id",
  turnId: "space.turn_id",
  cliTaskId: "space.cli_task_id",
  revisionId: "space.revision_id",
  changeSetId: "space.change_set_id"
};

export interface ObserveActivityDependencies {
  metrics?: WorkerMetrics;
  now?: () => number;
  cancelled?: () => boolean;
  spanExporter?: SpanExporter | null;
  traceRegistry?: WorkflowTraceRegistry;
  /** OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity whose input carries a traceparent. */
  spans?: SpanExporter | null;
}

export async function observeActivityExecution<T>(
  info: ActivityInfo,
  args: readonly unknown[],
  execute: () => Promise<T>,
  dependencies: ObserveActivityDependencies = {}
): Promise<T> {
  const metrics = dependencies.metrics ?? workerMetrics;
  const now = dependencies.now ?? Date.now;
  const spanExporter = dependencies.spanExporter ?? null;
  const traceRegistry = dependencies.traceRegistry ?? defaultWorkflowTraceRegistry;
  const activityType = logIdentifier(info.activityType) ?? "unknown";
  const startedAt = now();
  const queueMs = Number.isFinite(info.currentAttemptScheduledTimestampMs)
    ? Math.max(0, startedAt - info.currentAttemptScheduledTimestampMs)
    : null;
  const { correlation, extra } = extractActivityTraceDetails(args);
  const workflowId = info.workflowExecution?.workflowId ?? null;
  const temporalRunId = info.workflowExecution?.runId ?? null;
  const workflowTrace = workflowId && temporalRunId
    ? traceRegistry.getByExecution(workflowId, temporalRunId)
    : null;

  const w3cTraceId = correlation.w3cTraceId
    ?? workflowTrace?.w3cTraceId
    ?? (correlation.traceId
      ? traceRegistry.getBySpaceTraceId(correlation.traceId)?.w3cTraceId ?? null
      : null);

  const effectiveCorrelation: Record<string, string> = {
    ...correlation,
    ...(w3cTraceId && !correlation.w3cTraceId ? { w3cTraceId } : {}),
    ...(!correlation.traceId && workflowTrace?.spaceTraceId ? { traceId: workflowTrace.spaceTraceId } : {})
  };

  const base: Record<string, WorkerLogValue> = {
    activityType,
    activityId: info.activityId,
    workflowType: info.workflowType ?? null,
    workflowId,
    temporalRunId,
    attempt: info.attempt,
    ...effectiveCorrelation
  };
  const labels = { activity_type: activityType };
  if (info.attempt > 1) metrics.activityRetries.inc(labels);
  if (queueMs !== null) metrics.activityScheduleToStart.observe(labels, queueMs / 1000);
  metrics.activitiesInFlight.inc(labels);
  workerLog("info", "activity.started", { ...base, queueMs });

  const activitySpanId = deterministicSpanId(
    `activity:${workflowId ?? "none"}:${temporalRunId ?? "none"}:${info.activityId}:${info.attempt}`
  );
  const observation: ActivityObservation = { reasonCode: null, spanId: activitySpanId };

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

    if (spanExporter) {
      const spanTraceId = w3cTraceId
        ?? (effectiveCorrelation.traceId ? deterministicTraceId(effectiveCorrelation.traceId) : null)
        ?? (workflowId ? deterministicTraceId(workflowId) : null);
      if (spanTraceId) {
        const parentSpanId = workflowId && temporalRunId
          ? workflowExecutionSpanId(workflowId, temporalRunId)
          : (parseTraceparent(extra.traceparent)?.parentId ?? null);
        const startNs = BigInt(Math.round(startedAt * 1_000_000));
        const endNs = startNs + BigInt(Math.max(0, Math.round(durationMs * 1_000_000)));
        const mappedCorrelation: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(effectiveCorrelation)) {
          const targetKey = correlationAttributeKeyMap[key];
          if (targetKey) mappedCorrelation[targetKey] = value;
        }
        if (effectiveCorrelation.traceId) {
          mappedCorrelation["space.request_id"] = effectiveCorrelation.traceId;
        }
        const links: SpanLink[] = [];
        if (extra.continuationSourceRunId) {
          const sourceEntry = traceRegistry.getByAgentRunId(extra.continuationSourceRunId)
            ?? traceRegistry.getBySpaceTraceId(extra.continuationSourceTraceId);
          const parsedSource = parseTraceparent(extra.continuationSourceTraceparent);
          const linkTraceId = sourceEntry?.w3cTraceId
            ?? parsedSource?.traceId
            ?? deterministicTraceId(extra.continuationSourceTraceId ?? extra.continuationSourceRunId);
          const linkSpanId = sourceEntry?.spanId ?? parsedSource?.parentId ?? deterministicSpanId(extra.continuationSourceRunId);
          links.push({
            traceId: linkTraceId,
            spanId: linkSpanId,
            attributes: sanitizeSpanAttributes({
              "space.link_kind": "background_continuation",
              "space.source_run_id": extra.continuationSourceRunId,
              ...(extra.continuationGeneration !== undefined ? { "space.continuation_generation": extra.continuationGeneration } : {}),
              ...(extra.continuationSourceTraceId ? { "space.parent_trace_id": extra.continuationSourceTraceId } : {})
            })
          });
        }
        spanExporter.record({
          traceId: spanTraceId,
          spanId: activitySpanId,
          parentSpanId,
          name: activityType,
          kind: 1,
          startTimeUnixNano: startNs,
          endTimeUnixNano: endNs,
          attributes: sanitizeSpanAttributes({
            ...(workflowTrace?.attributes ?? {}),
            ...mappedCorrelation,
            "space.activity_type": activityType,
            "space.activity_id": info.activityId,
            "space.attempt": info.attempt,
            "space.outcome": outcome,
            "space.status": outcome,
            "space.duration_ms": durationMs,
            ...(queueMs !== null ? { "space.queue_ms": queueMs } : {}),
            ...(info.workflowType ? { "space.workflow_type": info.workflowType } : {}),
            ...(workflowId ? { "space.workflow_id": workflowId } : {}),
            ...(temporalRunId ? { "space.run_id": temporalRunId } : {}),
            ...(reasonCode ? { "space.reason_code": reasonCode, "space.error_code": reasonCode } : {}),
            ...(category ? { "space.category": category, "space.error_category": category } : {})
          }),
          ...(links.length ? { links } : {}),
          error: outcome !== "COMPLETED"
        });
      }
    } else if (dependencies.spans) {
      const parent = parseTraceparent(extra.traceparent);
      if (parent) {
        dependencies.spans.record({
          traceId: parent.traceId,
          spanId: activitySpanId,
          parentSpanId: parent.parentId,
          name: `activity ${activityType}`,
          startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
          endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
          attributes: sanitizeSpanAttributes({
            "space.activity_type": activityType,
            "space.outcome": outcome,
            "space.attempt": info.attempt
          }),
          error: outcome === "FAILED" || outcome === "FAILED_RESULT",
          kind: 1
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
        cancelled: () => context.cancellationSignal.aborted
      })
    }
  });
}
