import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Next,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent
} from "@space/contracts";
import type { OtlpSpanLink } from "@space/runtime";
import {
  allowlistSpanAttributes,
  decodeTraceCarrierHeader,
  encodeTraceCarrierHeader,
  extractCorrelationFromArgs,
  isSafeAttributeString,
  OTLP_TRACE_HEADER,
  runIdToSpanId
} from "./otlp-attributes.js";
import type { OtlpWorkflowSinks } from "./otlp-workflow-sink.js";

/**
 * In-memory map of active workflow runIds to their resolved W3C traceId.
 * Used as an in-process fallback when activities are invoked in tests without headers.
 */
const activeWorkflowTraceIds = new Map<string, string>();

export function getActiveWorkflowTraceId(runId: string | null | undefined): string | null {
  if (!runId) return null;
  return activeWorkflowTraceIds.get(runId) ?? null;
}

function classifyWorkflowErrorCode(error: unknown, isCancelled: boolean): string {
  if (isCancelled) return "WORKFLOW_CANCELLED";
  const record = error as { code?: unknown; type?: unknown; name?: unknown; cause?: { code?: unknown; type?: unknown } } | null;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  if (isSafeErrorCode(record?.cause?.code)) return record!.cause!.code as string;
  if (isSafeErrorCode(record?.cause?.type)) return record!.cause!.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Timeout/i.test(name)) return "WORKFLOW_TIMEOUT";
  if (/Cancel/i.test(name)) return "WORKFLOW_CANCELLED";
  return "WORKFLOW_FAILED";
}

export interface WorkflowInterceptorDeps {
  workflowInfo?: typeof workflowInfo;
  proxySinks?: typeof proxySinks;
  now?: () => number;
}

/**
 * Replay-safe Temporal workflow interceptor that emits an INTERNAL workflow
 * span via `otlpExport` sink (`callDuringReplay: false`) and propagates trace
 * context to child workflows, activities, and continue-as-new runs.
 */
export function createOtlpWorkflowInboundInterceptor(
  deps: WorkflowInterceptorDeps = {}
): WorkflowInboundCallsInterceptor & WorkflowOutboundCallsInterceptor {
  const getInfo = deps.workflowInfo ?? workflowInfo;
  const getSinks = deps.proxySinks ?? proxySinks;
  const getNow = deps.now ?? Date.now;

  let activeTraceId: string | undefined;
  let activeSpanId: string | undefined;
  let activeParentSpanId: string | null = null;
  let activeFlags = "01";
  let activeSpaceTraceId: string | undefined;

  return {
    async execute(
      input: WorkflowExecuteInput,
      next: Next<WorkflowInboundCallsInterceptor, "execute">
    ): Promise<unknown> {
      const info = getInfo();
      const sinks = getSinks<OtlpWorkflowSinks>();
      const startTimeMs = getNow();

      const carrier = decodeTraceCarrierHeader(
        input.headers as Readonly<Record<string, { data?: Uint8Array | null } | undefined>> | undefined
      );
      const argCorr = extractCorrelationFromArgs(input.args);
      const memo = info.memo ?? {};
      const memoTraceparent = typeof memo.traceparent === "string" ? memo.traceparent : undefined;
      const memoW3cTraceId = typeof memo.w3cTraceId === "string" ? memo.w3cTraceId : undefined;
      const memoSpaceTraceId = typeof memo.spaceTraceId === "string" ? memo.spaceTraceId : undefined;

      const argTp = parseTraceparent(typeof argCorr.traceparent === "string" ? argCorr.traceparent : undefined);
      const inheritedTp = parseTraceparent(carrier?.traceparent ?? memoTraceparent);
      // A workflow input that names its own originating request wins over the
      // context inherited from a long-lived parent (e.g. the room supervisor).
      const ownTrace = Boolean(argTp && argTp.traceId !== inheritedTp?.traceId);
      const parsedTp = ownTrace ? argTp : inheritedTp ?? argTp;

      const traceId =
        parsedTp?.traceId ??
        (typeof carrier?.w3cTraceId === "string" && /^[0-9a-f]{32}$/.test(carrier.w3cTraceId)
          ? carrier.w3cTraceId
          : undefined) ??
        (typeof memoW3cTraceId === "string" && /^[0-9a-f]{32}$/.test(memoW3cTraceId)
          ? memoW3cTraceId
          : undefined);

      if (!traceId) {
        return next(input);
      }

      const spanId = runIdToSpanId(info.runId);
      activeTraceId = traceId;
      activeSpanId = spanId;
      activeFlags = parsedTp?.flags ?? "01";
      activeWorkflowTraceIds.set(info.runId, traceId);

      // Child workflows nest under their parent workflow span unless they carry
      // their own originating request traceparent from a long-lived supervisor.
      let parentSpanId: string | null = null;
      if (ownTrace) {
        parentSpanId = argTp!.parentId;
      } else if (info.parent?.runId) {
        parentSpanId = runIdToSpanId(info.parent.runId);
      } else if (parsedTp?.parentId) {
        parentSpanId = parsedTp.parentId;
      }
      activeParentSpanId = parentSpanId;

      const spaceTraceId =
        (typeof argCorr.traceId === "string" ? argCorr.traceId : undefined) ??
        carrier?.spaceTraceId ??
        (memoSpaceTraceId && isSafeAttributeString(memoSpaceTraceId) ? memoSpaceTraceId : undefined);
      activeSpaceTraceId = spaceTraceId;

      // Build OTLP span links for continue-as-new and room background continuations.
      const links: OtlpSpanLink[] = [];
      if (info.continuedFromExecutionRunId || carrier?.continuedFromSpanId) {
        const prevSpanId =
          carrier?.continuedFromSpanId ?? runIdToSpanId(info.continuedFromExecutionRunId!);
        links.push({
          traceId,
          spanId: prevSpanId,
          attributes: {
            "link.reason": "continue_as_new",
            ...(info.continuedFromExecutionRunId && isSafeAttributeString(info.continuedFromExecutionRunId)
              ? { "space.continued_from_run_id": info.continuedFromExecutionRunId }
              : {})
          }
        });
      }

      if (argCorr.sourceRunId && typeof argCorr.sourceRunId === "string") {
        const sourceTp =
          typeof argCorr.sourceTraceparent === "string" ? parseTraceparent(argCorr.sourceTraceparent) : null;
        const linkedTraceId = sourceTp?.traceId ?? traceId;
        const linkedSpanId = sourceTp?.parentId ?? runIdToSpanId(argCorr.sourceRunId);
        links.push({
          traceId: linkedTraceId,
          spanId: linkedSpanId,
          attributes: {
            "link.reason": "room_background_continuation",
            ...(isSafeAttributeString(argCorr.sourceRunId)
              ? { "space.source_run_id": argCorr.sourceRunId }
              : {}),
            ...(typeof argCorr.generation === "number"
              ? { "space.continuation_generation": argCorr.generation }
              : {})
          }
        });
      }

      let outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW" = "COMPLETED";
      let reasonCode: string | null = null;
      let isError = false;

      try {
        const result = await next(input);
        if (result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") {
          outcome = "FAILED";
          isError = true;
          const resCode = (result as { reasonCode?: unknown; errorCode?: unknown }).reasonCode ??
            (result as { errorCode?: unknown }).errorCode;
          reasonCode = isSafeErrorCode(resCode) ? (resCode as string) : "WORKFLOW_RESULT_FAILED";
        }
        return result;
      } catch (err) {
        if (err instanceof ContinueAsNew || (err as { name?: string } | null)?.name === "ContinueAsNew") {
          outcome = "CONTINUED_AS_NEW";
          isError = false;
        } else {
          const cancelled = isCancellation(err) || /Cancel/i.test((err as { name?: string } | null)?.name ?? "");
          outcome = cancelled ? "CANCELLED" : "FAILED";
          isError = !cancelled;
          reasonCode = classifyWorkflowErrorCode(err, cancelled);
        }
        throw err;
      } finally {
        activeWorkflowTraceIds.delete(info.runId);
        const endTimeMs = getNow();
        const durationMs = Math.max(0, endTimeMs - startTimeMs);
        const category = reasonCode
          ? outcome === "CANCELLED"
            ? "CANCELLED"
            : categorizeFailureCode(reasonCode)
          : null;

        const rawAttrs: Record<string, unknown> = {
          "temporal.workflow_type": info.workflowType,
          "temporal.workflow_id": info.workflowId,
          "temporal.run_id": info.runId,
          "space.workflow_type": info.workflowType,
          "space.workflow_id": info.workflowId,
          "space.run_id": info.runId,
          "space.outcome": outcome,
          "space.duration_ms": durationMs,
          "space.w3c_trace_id": traceId
        };

        if (info.parent) {
          rawAttrs["temporal.parent_workflow_id"] = info.parent.workflowId;
          rawAttrs["temporal.parent_run_id"] = info.parent.runId;
        }
        if (info.continuedFromExecutionRunId) {
          rawAttrs["space.continued_from_run_id"] = info.continuedFromExecutionRunId;
        }
        if (reasonCode) rawAttrs["space.reason_code"] = reasonCode;
        if (category) rawAttrs["space.category"] = category;
        if (spaceTraceId) rawAttrs["space.trace_id"] = spaceTraceId;
        if (argCorr.requestId) rawAttrs["space.parent_trace_id"] = argCorr.requestId;
        if (argCorr.roomId) rawAttrs["space.room_id"] = argCorr.roomId;
        if (argCorr.paneId) rawAttrs["space.pane_id"] = argCorr.paneId;
        const missionId = argCorr.missionId ?? argCorr.roomAgentMissionId;
        if (missionId) rawAttrs["space.mission_id"] = missionId;
        if (argCorr.agentRunId) rawAttrs["space.agent_run_id"] = argCorr.agentRunId;
        if (argCorr.agentSessionId) rawAttrs["space.agent_session_id"] = argCorr.agentSessionId;
        if (argCorr.actionId) rawAttrs["space.action_id"] = argCorr.actionId;
        if (argCorr.goalId) rawAttrs["space.goal_id"] = argCorr.goalId;
        if (argCorr.dotId) rawAttrs["space.dot_id"] = argCorr.dotId;
        if (argCorr.turnId) rawAttrs["space.turn_id"] = argCorr.turnId;
        if (typeof argCorr.generation === "number") {
          rawAttrs["space.continuation_generation"] = argCorr.generation;
        }

        sinks.otlpExport.exportSpan({
          traceId,
          spanId,
          parentSpanId,
          name: `workflow ${info.workflowType}`,
          startTimeMs,
          endTimeMs,
          error: isError,
          attributes: allowlistSpanAttributes(rawAttrs),
          ...(links.length > 0 ? { links } : {})
        });
      }
    },

    scheduleActivity(input, next) {
      if (!activeTraceId || !activeSpanId) {
        return next(input);
      }
      const childTp = formatTraceparent(activeTraceId, activeSpanId, activeFlags);
      return next({
        ...input,
        headers: {
          ...input.headers,
          [OTLP_TRACE_HEADER]: encodeTraceCarrierHeader({
            traceparent: childTp,
            w3cTraceId: activeTraceId,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          })
        }
      });
    },

    scheduleLocalActivity(input, next) {
      if (!activeTraceId || !activeSpanId) {
        return next(input);
      }
      const childTp = formatTraceparent(activeTraceId, activeSpanId, activeFlags);
      return next({
        ...input,
        headers: {
          ...input.headers,
          [OTLP_TRACE_HEADER]: encodeTraceCarrierHeader({
            traceparent: childTp,
            w3cTraceId: activeTraceId,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          })
        }
      });
    },

    startChildWorkflowExecution(input, next) {
      if (!activeTraceId || !activeSpanId) {
        return next(input);
      }
      const childTp = formatTraceparent(activeTraceId, activeSpanId, activeFlags);
      const existingMemo = input.options.memo ?? {};
      return next({
        ...input,
        headers: {
          ...input.headers,
          [OTLP_TRACE_HEADER]: encodeTraceCarrierHeader({
            traceparent: childTp,
            w3cTraceId: activeTraceId,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          })
        },
        options: {
          ...input.options,
          memo: {
            ...existingMemo,
            w3cTraceId: activeTraceId,
            traceparent: childTp,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          }
        }
      });
    },

    continueAsNew(input, next) {
      if (!activeTraceId || !activeSpanId) {
        return next(input);
      }
      const continuedTp = formatTraceparent(
        activeTraceId,
        activeParentSpanId ?? activeSpanId,
        activeFlags
      );
      const existingMemo = input.options.memo ?? {};
      return next({
        ...input,
        headers: {
          ...input.headers,
          [OTLP_TRACE_HEADER]: encodeTraceCarrierHeader({
            traceparent: continuedTp,
            w3cTraceId: activeTraceId,
            continuedFromSpanId: activeSpanId,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          })
        },
        options: {
          ...input.options,
          memo: {
            ...existingMemo,
            w3cTraceId: activeTraceId,
            traceparent: continuedTp,
            ...(activeSpaceTraceId ? { spaceTraceId: activeSpaceTraceId } : {})
          }
        }
      });
    }
  };
}

/**
 * Default export required by Temporal `interceptors.workflowModules`.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const interceptor = createOtlpWorkflowInboundInterceptor();
  return {
    inbound: [interceptor],
    outbound: [interceptor]
  };
};
