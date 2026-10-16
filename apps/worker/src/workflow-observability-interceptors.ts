import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import { isSafeErrorCode } from "@space/contracts";

/**
 * Deterministic workflow-sandbox tracing interceptor. Performs no I/O and
 * consumes no PRNG state (`uuid4` / `Math.random`), so existing workflow
 * histories replay identically. Spans leave the sandbox exclusively through
 * Temporal sinks configured with `callDuringReplay: false`.
 */

export interface WorkflowTraceObservations {
  traceId?: string;
  traceparent?: string;
  parentTraceId?: string;
  roomId?: string;
  paneId?: string;
  missionId?: string;
  agentRunId?: string;
  agentSessionId?: string;
  actionId?: string;
  goalId?: string;
  dotId?: string;
  turnId?: string;
  cliTaskId?: string;
  revisionId?: string;
  changeSetId?: string;
  continuationSourceRunId?: string;
  continuationGeneration?: number;
  continuationSourceTraceId?: string;
  continuationSourceTraceparent?: string;
}

export type WorkflowSpanOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";

export interface WorkflowTraceStartEvent {
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string;
  parentWorkflowId: string | null;
  parentRunId: string | null;
  continuedFromRunId: string | null;
  startTimeMs: number;
  observations: WorkflowTraceObservations;
}

export interface WorkflowTraceFinishEvent extends WorkflowTraceStartEvent {
  endTimeMs: number;
  outcome: WorkflowSpanOutcome;
  reasonCode: string | null;
  error: boolean;
}

export interface WorkflowObservabilitySinks extends Sinks {
  workflowObservability: {
    recordWorkflowStart(event: WorkflowTraceStartEvent): void;
    recordWorkflowFinish(event: WorkflowTraceFinishEvent): void;
  };
}

const { workflowObservability } = proxySinks<WorkflowObservabilitySinks>();

const identifierPattern = /^[A-Za-z0-9:._-]{1,240}$/;

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && identifierPattern.test(value) ? value : undefined;
}

function readObservations(value: unknown, into: WorkflowTraceObservations, depth: number): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (depth > 0) {
      for (const entry of value.slice(0, 4)) readObservations(entry, into, depth - 1);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  const traceId = safeIdentifier(record.traceId) ?? safeIdentifier(record.spaceTraceId);
  if (traceId && !into.traceId) into.traceId = traceId;
  const traceparent = safeIdentifier(record.traceparent);
  if (traceparent && !into.traceparent) into.traceparent = traceparent;
  const parentTraceId = safeIdentifier(record.parentSpaceTraceId) ?? safeIdentifier(record.requestId);
  if (parentTraceId && parentTraceId !== into.traceId && !into.parentTraceId) into.parentTraceId = parentTraceId;
  const missionId = safeIdentifier(record.missionId) ?? safeIdentifier(record.roomAgentMissionId);
  if (missionId && !into.missionId) into.missionId = missionId;

  const directKeys = [
    "roomId",
    "paneId",
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
  for (const key of directKeys) {
    if (into[key] !== undefined) continue;
    const id = safeIdentifier(record[key]);
    if (id) into[key] = id;
  }

  const continuation = record.roomAgentContinuation;
  if (continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
    const cont = continuation as Record<string, unknown>;
    const sourceRunId = safeIdentifier(cont.sourceRunId);
    if (sourceRunId) into.continuationSourceRunId = sourceRunId;
    if (typeof cont.generation === "number" && Number.isInteger(cont.generation) && cont.generation > 0) {
      into.continuationGeneration = cont.generation;
    }
    const sourceTraceId = safeIdentifier(cont.sourceTraceId);
    if (sourceTraceId) into.continuationSourceTraceId = sourceTraceId;
    const sourceTraceparent = safeIdentifier(cont.sourceTraceparent);
    if (sourceTraceparent) into.continuationSourceTraceparent = sourceTraceparent;
  }

  if (depth <= 0) return;
  for (const nestedKey of ["turn", "item", "bridge", "input", "turnInput", "pending", "interrupted"] as const) {
    if (record[nestedKey] !== undefined) {
      readObservations(record[nestedKey], into, depth - 1);
    }
  }
}

function workflowErrorCode(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown; failure?: { cause?: { type?: unknown } } } | null;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  if (isSafeErrorCode(record?.failure?.cause?.type)) return record!.failure!.cause!.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "WORKFLOW_CANCELLED";
  if (/Timeout/i.test(name)) return "WORKFLOW_TIMEOUT";
  return "WORKFLOW_FAILED";
}

function isFailedWorkflowResult(value: unknown): { failed: boolean; reasonCode: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { failed: false, reasonCode: null };
  const record = value as Record<string, unknown>;
  if (record.status !== "FAILED") return { failed: false, reasonCode: null };
  const reasonCode = isSafeErrorCode(record.reasonCode)
    ? (record.reasonCode as string)
    : isSafeErrorCode(record.errorCode)
      ? (record.errorCode as string)
      : "WORKFLOW_RESULT_FAILED";
  return { failed: true, reasonCode };
}

const supervisorTurnTerminalActivities = new Set([
  "finishRoomAgentSupervisorTurn",
  "markRoomAgentMissionFinished",
  "markRoomAgentMissionContinued"
]);

function applyObservations(args: readonly unknown[], into: WorkflowTraceObservations): void {
  const fresh: WorkflowTraceObservations = {};
  for (const arg of args) readObservations(arg, fresh, 3);
  if (fresh.traceId && into.traceId && fresh.traceId !== into.traceId) {
    delete into.traceparent;
    delete into.parentTraceId;
    delete into.agentRunId;
    delete into.turnId;
    delete into.continuationSourceRunId;
    delete into.continuationGeneration;
    delete into.continuationSourceTraceId;
    delete into.continuationSourceTraceparent;
  }
  Object.assign(into, fresh);
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  const observations: WorkflowTraceObservations = {};
  let startTimeMs: number | null = null;
  let lastObservedTraceId: string | undefined;

  function buildStartEvent(): WorkflowTraceStartEvent {
    const info = workflowInfo();
    if (info.memo && !observations.traceId) readObservations(info.memo, observations, 1);
    if (startTimeMs === null || observations.traceId !== lastObservedTraceId) {
      startTimeMs = Date.now();
      lastObservedTraceId = observations.traceId;
    }
    return {
      workflowId: info.workflowId,
      runId: info.runId,
      workflowType: info.workflowType,
      taskQueue: info.taskQueue,
      parentWorkflowId: info.parent?.workflowId ?? null,
      parentRunId: info.parent?.runId ?? null,
      continuedFromRunId: info.continuedFromExecutionRunId ?? null,
      startTimeMs,
      observations: { ...observations }
    };
  }

  function emitStart(): void {
    const event = buildStartEvent();
    if (!workflowInfo().unsafe.isReplayingHistoryEvents) {
      workflowObservability.recordWorkflowStart(event);
    }
  }

  function emitFinish(outcome: WorkflowSpanOutcome, reasonCode: string | null, error: boolean): void {
    const startEvent = buildStartEvent();
    if (!workflowInfo().unsafe.isReplayingHistoryEvents) {
      workflowObservability.recordWorkflowFinish({
        ...startEvent,
        endTimeMs: Math.max(startEvent.startTimeMs, Date.now()),
        outcome,
        reasonCode,
        error
      });
    }
  }

  const inbound: WorkflowInboundCallsInterceptor = {
    async handleSignal(input, next) {
      applyObservations(input.args, observations);
      emitStart();
      return next(input);
    },
    async execute(input, next) {
      applyObservations(input.args, observations);
      emitStart();
      try {
        const result = await next(input);
        const failure = isFailedWorkflowResult(result);
        if (failure.failed) {
          emitFinish("FAILED", failure.reasonCode, true);
        } else {
          emitFinish("COMPLETED", null, false);
        }
        return result;
      } catch (error) {
        if (error instanceof ContinueAsNew || (error as { name?: string } | null)?.name === "ContinueAsNew") {
          emitFinish("CONTINUED_AS_NEW", null, false);
        } else if (isCancellation(error)) {
          emitFinish("CANCELLED", "WORKFLOW_CANCELLED", true);
        } else {
          emitFinish("FAILED", workflowErrorCode(error), true);
        }
        throw error;
      }
    }
  };

  const outbound: WorkflowOutboundCallsInterceptor = {
    async scheduleActivity(input, next) {
      applyObservations(input.args, observations);
      emitStart();
      const result = await next(input);
      // Long-lived roomAgentSupervisorWorkflow loops across missions without
      // returning from execute(); emit its workflow span when a mission turn
      // finishes so traces are complete immediately.
      if (supervisorTurnTerminalActivities.has(input.activityType)) {
        emitFinish("COMPLETED", null, false);
      }
      return result;
    },
    async startChildWorkflowExecution(input, next) {
      const childArgs = (input.options as { args?: readonly unknown[] } | undefined)?.args ?? [];
      applyObservations(childArgs, observations);
      emitStart();
      const [executionPromise, resultPromise] = await next(input);
      if (workflowInfo().workflowType === "roomAgentSupervisorWorkflow") {
        const tracedResultPromise = resultPromise.then(
          (value) => {
            const failure = isFailedWorkflowResult(value);
            emitFinish(failure.failed ? "FAILED" : "COMPLETED", failure.reasonCode, failure.failed);
            return value;
          },
          (error: unknown) => {
            if (isCancellation(error)) {
              emitFinish("CANCELLED", "WORKFLOW_CANCELLED", true);
            } else {
              emitFinish("FAILED", workflowErrorCode(error), true);
            }
            throw error;
          }
        );
        return [executionPromise, tracedResultPromise];
      }
      return [executionPromise, resultPromise];
    }
  };

  return {
    inbound: [inbound],
    outbound: [outbound]
  };
};
