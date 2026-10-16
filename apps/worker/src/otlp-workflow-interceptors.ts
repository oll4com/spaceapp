import { proxySinks as temporalProxySinks, workflowInfo as temporalWorkflowInfo } from "@temporalio/workflow";
import type {
  WorkflowInboundCallsInterceptor,
  WorkflowExecuteInput,
  WorkflowInfo,
  Sinks,
  Next
} from "@temporalio/workflow";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import type { OtlpWorkflowSinks } from "./otlp-workflow-sink.js";
import { allowlistSpanAttributes, runIdToSpanId } from "./otlp-attributes.js";

/**
 * Parses inbound traceparent from workflow args (e.g. Turn, QueueItem, or Maintenance input).
 */
function extractTraceparentFromArgs(args: readonly unknown[]): { traceId: string; parentId: string; flags: string } | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    if (typeof record.traceparent === "string") {
      const parsed = parseTraceparent(record.traceparent);
      if (parsed) return parsed;
    }
    const turn = (record.turn ?? (record.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    if (turn && typeof turn.traceparent === "string") {
      const parsed = parseTraceparent(turn.traceparent);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Extracts raw traceId from args if present.
 */
function extractRawTraceIdFromArgs(args: readonly unknown[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    if (typeof record.traceId === "string") return record.traceId;
    const turn = (record.turn ?? (record.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    if (turn && typeof turn.traceId === "string") return turn.traceId;
  }
  return null;
}

/**
 * Extracts background continuation metadata from args if present.
 */
function extractBackgroundContinuationFromArgs(args: readonly unknown[]): { sourceRunId?: string } | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    const turn = (record.turn ?? (record.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    const cont = (record.roomAgentContinuation ?? turn?.roomAgentContinuation) as { sourceRunId?: string } | undefined;
    if (cont?.sourceRunId) return cont;
  }
  return null;
}

/**
 * Extracts strictly safe correlation identifiers from workflow arguments.
 */
function extractCorrelationAttributesFromArgs(args: readonly unknown[]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const r = arg as Record<string, unknown>;
    const turn = (r.turn ?? (r.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    const target = { ...r, ...(turn ?? {}) };
    if (target.roomId) attrs["space.room_id"] = target.roomId;
    if (target.paneId) attrs["space.pane_id"] = target.paneId;
    if (target.missionId) attrs["space.mission_id"] = target.missionId;
    if (target.roomAgentMissionId) attrs["space.mission_id"] = target.roomAgentMissionId;
    if (target.turnId) attrs["space.turn_id"] = target.turnId;
    if (target.actionId) attrs["space.action_id"] = target.actionId;
    if (target.agentRunId) attrs["space.agent_run_id"] = target.agentRunId;
    if (target.agentSessionId) attrs["space.agent_session_id"] = target.agentSessionId;
    if (target.traceId) attrs["space.trace_id"] = target.traceId;
  }
  return attrs;
}

export interface WorkflowInterceptorDependencies {
  workflowInfo?: () => WorkflowInfo;
  proxySinks?: <T extends Sinks>() => T;
}

export class OtlpWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  constructor(private readonly dependencies: WorkflowInterceptorDependencies = {}) {}

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
    const getInfo = this.dependencies.workflowInfo ?? temporalWorkflowInfo;
    const getSinks = this.dependencies.proxySinks ?? temporalProxySinks;
    const info = getInfo();
    const startTimeMs = info.runStartTime?.getTime() ?? Date.now();
    const startTimeUnixNano = `${startTimeMs}000000`;
    const spanId = runIdToSpanId(info.runId);

    // 1. Resolve parentSpanId and traceId
    let traceId: string | null = null;
    let parentSpanId: string | null = null;

    // Child workflow nesting
    if (info.parent) {
      parentSpanId = runIdToSpanId(info.parent.runId);
    }

    // Check workflow memo
    const memoTraceparent = typeof info.memo?.traceparent === "string" ? info.memo.traceparent : null;
    const parsedMemo = parseTraceparent(memoTraceparent);
    if (parsedMemo) {
      traceId = parsedMemo.traceId;
      if (!info.parent) {
        parentSpanId = parsedMemo.parentId;
      }
    }

    // Check args if not determined yet
    if (!traceId || (!parentSpanId && !info.parent)) {
      const fromArgs = extractTraceparentFromArgs(input.args);
      if (fromArgs) {
        if (!traceId) traceId = fromArgs.traceId;
        if (!parentSpanId && !info.parent) parentSpanId = fromArgs.parentId;
      }
    }

    // Fallback for traceId: check raw traceId or derive from runId
    if (!traceId) {
      const rawTraceId = extractRawTraceIdFromArgs(input.args);
      if (rawTraceId && /^[0-9a-f]{32}$/i.test(rawTraceId)) {
        traceId = rawTraceId.toLowerCase();
      } else {
        traceId = info.runId.replace(/[^0-9a-fA-F]/g, "").toLowerCase().padEnd(32, "0").slice(0, 32);
      }
    }

    // 2. Resolve Span Links (Criteria 5)
    const links: Array<{ traceId: string; spanId: string; attributes?: Record<string, string | number> }> = [];

    // Continue-as-new span link:
    if (info.continuedFromExecutionRunId) {
      links.push({
        traceId,
        spanId: runIdToSpanId(info.continuedFromExecutionRunId),
        attributes: { "link.reason": "continue_as_new" }
      });
    }

    // Room background continuation span link:
    const bgContinuation = extractBackgroundContinuationFromArgs(input.args);
    if (bgContinuation?.sourceRunId) {
      links.push({
        traceId,
        spanId: runIdToSpanId(bgContinuation.sourceRunId),
        attributes: { "link.reason": "room_background_continuation" }
      });
    }

    let error = false;
    let thrownError: unknown = null;
    try {
      return await next(input);
    } catch (err) {
      error = true;
      thrownError = err;
      throw err;
    } finally {
      const endTimeMs = Date.now();
      const endTimeUnixNano = `${endTimeMs}000000`;
      const durationMs = Math.max(0, endTimeMs - startTimeMs);

      const rawAttributes: Record<string, unknown> = {
        "service.name": "space-worker",
        "temporal.workflow_type": info.workflowType,
        "temporal.workflow_id": info.workflowId,
        "temporal.run_id": info.runId,
        "temporal.status": error ? "FAILED" : "COMPLETED",
        "temporal.outcome": error ? "FAILED" : "COMPLETED",
        "temporal.duration_ms": durationMs,
        ...(info.parent ? {
          "temporal.parent_run_id": info.parent.runId,
          "temporal.parent_workflow_id": info.parent.workflowId
        } : {}),
        ...extractCorrelationAttributesFromArgs(input.args)
      };

      if (error && thrownError) {
        rawAttributes["temporal.error_name"] = (thrownError as { name?: string })?.name;
        rawAttributes["temporal.error_code"] = (thrownError as { code?: string })?.code;
      }

      const attributes = allowlistSpanAttributes(rawAttributes);

      try {
        const sinks = getSinks<OtlpWorkflowSinks>();
        if (sinks?.otlpExport?.exportSpan) {
          sinks.otlpExport.exportSpan({
            traceId,
            spanId,
            parentSpanId,
            name: `workflow:${info.workflowType}`,
            kind: 1, // INTERNAL
            startTimeUnixNano,
            endTimeUnixNano,
            attributes,
            error,
            links: links.length > 0 ? links : undefined
          });
        }
      } catch {
        // Never fail workflow on sink export issues
      }
    }
  }
}

/**
 * Creates an OtlpWorkflowInboundInterceptor instance with optional injected dependencies.
 */
export function createOtlpWorkflowInboundInterceptor(
  dependencies: WorkflowInterceptorDependencies = {}
): WorkflowInboundCallsInterceptor {
  return new OtlpWorkflowInboundInterceptor(dependencies);
}

/**
 * Workflow interceptors module export for Temporal Worker bundle.
 */
export function interceptors(): { inbound: WorkflowInboundCallsInterceptor[] } {
  return {
    inbound: [new OtlpWorkflowInboundInterceptor()]
  };
}
