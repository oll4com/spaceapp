import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent,
  traceIdFromTraceparent,
  type FailureCategory,
  type ParsedTraceparent
} from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import { correlationIdentifier, decodeActivityTraceContext } from "./temporal-trace-context.js";
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
  traceparent: string | null;
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
  const observation: ActivityObservation = { reasonCode: null, traceparent: null };
  return { promise: observations.run(observation, execute), reasonCode: () => observation.reasonCode };
}

function randomSpanId(): string {
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
  return spanId;
}

/** Continue the exported activity attempt on outbound calls, or use the legacy input fallback. */
export function childTraceparent(traceparent: string | null | undefined): string | null {
  const active = observations.getStore()?.traceparent;
  if (active) return active;
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  return formatTraceparent(parsed.traceId, randomSpanId(), parsed.flags);
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
  /** OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT): one span per activity attempt. */
  spans?: SpanExporter | null;
  /** Propagated workflow span from Temporal headers; legacy inputs remain a fallback. */
  traceContext?: ParsedTraceparent | null;
}

function activityTraceparent(args: readonly unknown[]) {
  const found: Partial<Record<CorrelationKey, string>> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  return parseTraceparent(found.traceparent);
}

// Observability must never turn a successful activity into a retry, or replace
// the original business failure. In particular, exporting is never awaited.
function bestEffort<T>(observe: () => T): T | undefined {
  try { return observe(); } catch { return undefined; }
}

// Temporal-assigned identities; the Space correlation IDs below must also have the generated `<kind>:<token>` shape.
const temporalSpanKeys = {
  activityId: "space.activity_id",
  workflowType: "space.workflow_type",
  workflowId: "space.workflow_id",
  temporalRunId: "space.temporal_run_id"
} as const;

const spanCorrelationKeys = {
  traceId: "space.trace_id",
  parentTraceId: "space.request_id",
  missionId: "space.mission_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  agentRunId: "space.agent_run_id",
  agentSessionId: "space.agent_session_id",
  actionId: "space.action_id",
  goalId: "space.goal_id",
  dotId: "space.dot_id",
  turnId: "space.turn_id",
  cliTaskId: "space.cli_task_id",
  revisionId: "space.revision_id"
} as const;

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
    ...(bestEffort(() => activityCorrelation(args)) ?? {}),
    ...(dependencies.traceContext ? { w3cTraceId: dependencies.traceContext.traceId } : {})
  };
  const labels = { activity_type: activityType };
  bestEffort(() => {
    if (info.attempt > 1) metrics.activityRetries.inc(labels);
    if (queueMs !== null) metrics.activityScheduleToStart.observe(labels, queueMs / 1000);
    metrics.activitiesInFlight.inc(labels);
    workerLog("info", "activity.started", { ...base, queueMs });
  });
  const activitySpan = bestEffort(() => {
    if (!dependencies.spans) return null;
    const parent = dependencies.traceContext ?? activityTraceparent(args);
    return parent ? { parent, spanId: randomSpanId() } : null;
  });
  const observation: ActivityObservation = {
    reasonCode: null,
    traceparent: activitySpan ? formatTraceparent(activitySpan.parent.traceId, activitySpan.spanId, activitySpan.parent.flags) : null
  };

  const finish = (outcome: ActivityOutcome, reasonCode: string | null, errorName: string | null) => bestEffort(() => {
    const durationMs = Math.max(0, now() - startedAt);
    const category: FailureCategory | null = outcome === "COMPLETED" ? null
      : outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(reasonCode);
    bestEffort(() => {
      metrics.activitiesInFlight.inc(labels, -1);
      metrics.activityExecutions.inc({ activity_type: activityType, outcome });
      metrics.activityDuration.observe(labels, durationMs / 1000);
      if (category !== null) {
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
    });
    if (activitySpan) {
      const { parent, spanId } = activitySpan;
      const attributes: Record<string, string | number> = {
        "space.activity_type": activityType,
        "space.outcome": outcome,
        "space.duration_ms": durationMs
      };
      if (Number.isSafeInteger(info.attempt) && info.attempt >= 1) attributes["space.attempt"] = info.attempt;
      if (queueMs !== null) attributes["space.queue_ms"] = queueMs;
      for (const [key, attribute] of Object.entries(temporalSpanKeys)) {
        const identifier = logIdentifier(base[key]);
        if (identifier !== null) attributes[attribute] = identifier;
      }
      for (const [key, attribute] of Object.entries(spanCorrelationKeys)) {
        const identifier = correlationIdentifier(base[key]);
        if (identifier !== null) attributes[attribute] = identifier;
      }
      if (isSafeErrorCode(reasonCode)) attributes["space.reason_code"] = reasonCode;
      if (category !== null) attributes["space.failure_category"] = category;
      dependencies.spans!.record({
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.parentId,
        name: `activity ${activityType}`,
        startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
        endTimeUnixNano: BigInt(startedAt + durationMs) * 1_000_000n,
        attributes,
        error: outcome === "FAILED" || outcome === "FAILED_RESULT",
        kind: 1
      });
    }
  });

  try {
    const result = await observations.run(observation, execute);
    bestEffort(() => {
      if (isFailedResult(result)) finish("FAILED_RESULT", observation.reasonCode ?? "ACTIVITY_RESULT_FAILED", null);
      else finish("COMPLETED", null, null);
    });
    return result;
  } catch (error) {
    bestEffort(() => {
      const cancelled = dependencies.cancelled?.() === true || /Cancel/i.test((error as { name?: string } | null)?.name ?? "");
      const errorName = logIdentifier((error as { name?: unknown } | null)?.name);
      finish(cancelled ? "CANCELLED" : "FAILED", observation.reasonCode ?? errorCodeOf(error), errorName);
    });
    throw error;
  }
}

/** Temporal worker interceptor factory: register in Worker.create({ interceptors }). */
export function createActivityObservabilityInterceptors(dependencies: Omit<ObserveActivityDependencies, "cancelled"> = {}): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      execute: (input, next) => observeActivityExecution(context.info, input.args, () => next(input), {
        ...dependencies,
        traceContext: decodeActivityTraceContext(input.headers),
        cancelled: () => context.cancellationSignal.aborted
      })
    }
  });
}
