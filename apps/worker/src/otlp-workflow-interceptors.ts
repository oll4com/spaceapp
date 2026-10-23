import { proxySinks as temporalProxySinks, workflowInfo as temporalWorkflowInfo } from "@temporalio/workflow";
import type {
  WorkflowInboundCallsInterceptor,
  WorkflowOutboundCallsInterceptor,
  WorkflowExecuteInput,
  StartChildWorkflowExecutionInput,
  WorkflowInfo,
  Sinks,
  Next,
  WorkflowInterceptors
} from "@temporalio/workflow";
import { parseTraceparent } from "@space/contracts";
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
 * Extracts background continuation parameters from workflow args.
 */
function extractBackgroundContinuationFromArgs(args: readonly unknown[]): {
  sourceRunId?: string;
  sourceTraceId?: string;
  sourceTraceparent?: string;
} | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    const turn = (record.turn ?? (record.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    const cont = (record.roomAgentContinuation ?? turn?.roomAgentContinuation) as {
      sourceRunId?: string;
      sourceTraceId?: string;
      sourceTraceparent?: string;
    } | undefined;
    if (cont?.sourceRunId) return cont;
  }
  return null;
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
      let linkTraceId = traceId;
      if (bgContinuation.sourceTraceparent) {
        const parsedSource = parseTraceparent(bgContinuation.sourceTraceparent);
        if (parsedSource) linkTraceId = parsedSource.traceId;
      }
      links.push({
        traceId: linkTraceId,
        spanId: runIdToSpanId(bgContinuation.sourceRunId),
        attributes: { "link.reason": "room_background_continuation" }
      });
    }

    let error = false;

    try {
      const result = await next(input);
      return result;
    } catch (err) {
      error = true;
      throw err;
    } finally {
      const rawAttrs: Record<string, unknown> = {
        "service.name": "space-worker",
        "temporal.workflow_type": info.workflowType,
        "temporal.workflow_id": info.workflowId,
        "temporal.run_id": info.runId,
        "space.workflow_type": info.workflowType,
        "space.outcome": error ? "FAILED" : "COMPLETED"
      };
      if (info.parent) {
        rawAttrs["temporal.parent_run_id"] = info.parent.runId;
        rawAttrs["temporal.parent_workflow_id"] = info.parent.workflowId;
      }

      const safeAttributes = allowlistSpanAttributes(rawAttrs);

      try {
        const sinks = getSinks<OtlpWorkflowSinks>();
        if (sinks?.otlpExport?.exportSpan) {
          sinks.otlpExport.exportSpan({
            traceId,
            spanId,
            parentSpanId,
            name: `workflow ${info.workflowType}`,
            kind: 1, // INTERNAL
            startTimeUnixNano,
            attributes: safeAttributes,
            error,
            ...(links.length > 0 ? { links } : {})
          });
        }
      } catch {
        // Sinks cannot break workflow determinism
      }
    }
  }
}

export class OtlpWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly dependencies: WorkflowInterceptorDependencies = {}) {}

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">
  ): Promise<[Promise<string>, Promise<unknown>]> {
    const getInfo = this.dependencies.workflowInfo ?? temporalWorkflowInfo;
    const info = getInfo();
    const memo = { ...(info.memo ?? {}), ...(input.options.memo ?? {}) };
    return next({
      ...input,
      options: {
        ...input.options,
        memo
      }
    });
  }
}

export function createOtlpWorkflowInboundInterceptor(dependencies: WorkflowInterceptorDependencies = {}): WorkflowInboundCallsInterceptor {
  return new OtlpWorkflowInboundInterceptor(dependencies);
}

export function createOtlpWorkflowOutboundInterceptor(dependencies: WorkflowInterceptorDependencies = {}): WorkflowOutboundCallsInterceptor {
  return new OtlpWorkflowOutboundInterceptor(dependencies);
}

export function interceptors(): WorkflowInterceptors {
  return {
    inbound: [new OtlpWorkflowInboundInterceptor()],
    outbound: [new OtlpWorkflowOutboundInterceptor()]
  };
}
