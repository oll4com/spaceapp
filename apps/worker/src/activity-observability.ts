import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { defaultPayloadConverter } from "@temporalio/client";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type FailureCategory,
  type ParsedTraceparent
} from "@space/contracts";
import type { SpanExporter, SpanLink } from "@space/runtime";
import { outcomeAttributes, workerSpanAttributes } from "./otlp-span-attributes.js";
import { logIdentifier, workerLog, type WorkerLogValue } from "./worker-log.js";
import { TRACEPARENT_HEADER, activityAttemptSpanId, traceparentInArgs } from "./workflow-trace-context.js";
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
  /** traceparent naming this attempt's span when it is exported, else null. */
  traceparent?: string | null;
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

/**
 * traceparent naming the running activity attempt's exported span, so an
 * outbound call (for example the internal room-action request) nests under it.
 * Null outside an observed activity or when spans are not exported.
 */
export function activeActivityTraceparent(): string | null {
  return observations.getStore()?.traceparent ?? null;
}

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
  /**
   * OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity
   * attempt, under the workflow span named in the Temporal header, or under
   * the traceparent in the activity input when the workflow sent none.
   */
  spans?: SpanExporter | null;
  /** traceparent of the scheduling workflow's span (Temporal header). */
  workflowTraceparent?: ParsedTraceparent | null;
}

/** The workflow span traceparent that the workflow interceptor put into the activity's headers. */
export function headerTraceparent(headers: Readonly<Record<string, unknown>> | undefined): ParsedTraceparent | null {
  const payload = headers?.[TRACEPARENT_HEADER];
  if (!payload) return null;
  try {
    return parseTraceparent(defaultPayloadConverter.fromPayload(payload as never));
  } catch {
    return null;
  }
}

const spanCorrelationKeys: Readonly<Record<string, string>> = {
  traceId: "space.trace_id",
  parentTraceId: "space.parent_trace_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  missionId: "space.mission_id",
  agentRunId: "space.agent_run_id",
  goalId: "space.goal_id"
};

/**
 * Runs one activity attempt with its log records, metrics and, when spans are
 * exported, one OTLP span under the workflow span from the Temporal header (or
 * the traceparent in the input). Export is best effort: it never changes the
 * activity's result or error.
 */
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
  const requestParent = dependencies.spans ? traceparentInArgs(args) : null;
  const parent = dependencies.spans ? dependencies.workflowTraceparent ?? requestParent : null;
  const spanId = parent
    ? activityAttemptSpanId(info.workflowExecution?.runId ?? "", info.activityId ?? activityType, info.attempt)
    : null;
  const observation: ActivityObservation = {
    reasonCode: null,
    traceparent: parent && spanId ? formatTraceparent(parent.traceId, spanId, parent.flags) : null
  };

  /** Records the attempt's outcome once: metrics, the finished log record and the attempt's span. */
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
    if (parent && spanId) {
      const correlation = activityCorrelation(args);
      const links: SpanLink[] = [];
      // A supervisor activity for a request from another trace links to that request.
      if (requestParent && requestParent.traceId !== parent.traceId) {
        links.push({ traceId: requestParent.traceId, spanId: requestParent.parentId, attributes: { "space.link": "REQUEST" } });
      }
      try {
        dependencies.spans!.record({
          traceId: parent.traceId,
          spanId,
          parentSpanId: parent.parentId,
          name: `activity ${activityType}`,
          startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
          endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
          attributes: workerSpanAttributes({
            "space.activity_type": activityType,
            "space.activity_id": info.activityId,
            "space.attempt": info.attempt,
            "space.workflow_type": info.workflowType,
            "space.workflow_id": info.workflowExecution?.workflowId,
            "space.run_id": info.workflowExecution?.runId,
            ...outcomeAttributes(outcome, reasonCode),
            "space.queue_ms": queueMs,
            ...Object.fromEntries(Object.entries(correlation)
              .filter(([key]) => spanCorrelationKeys[key])
              .map(([key, value]) => [spanCorrelationKeys[key], value]))
          }),
          error: outcome === "FAILED" || outcome === "FAILED_RESULT",
          kind: 1,
          ...(links.length ? { links } : {})
        });
      } catch {
        // Span export is best effort and never fails the activity.
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
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled" | "workflowTraceparent"> = {}): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      execute: (input, next) => observeActivityExecution(context.info, input.args, () => next(input), {
        ...dependencies,
        cancelled: () => context.cancellationSignal.aborted,
        workflowTraceparent: dependencies.spans ? headerTraceparent(input.headers) : null
      })
    }
  });
}
