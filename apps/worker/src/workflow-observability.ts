import { ContinueAsNew, isCancellation, proxySinks, workflowInfo, type WorkflowInterceptorsFactory } from "@temporalio/workflow";
import { backgroundParentFromArgs, correlationAttributes, carrierForChild, carrierForContinuation, contextForRun, parentFromArgs, parentFromHeaders, parseParent, withTraceHeader, type TraceCarrier, type TraceContext } from "./trace-carrier.js";
import { installWorkflowScopeTracer } from "./workflow-trace-scope.js";
import type { WorkflowTraceSinks } from "./workflow-trace-types.js";

const { spaceOtel } = proxySinks<WorkflowTraceSinks>();
const safeType = (value: string) => /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : "unknown";

function failureCode(error: unknown): string {
  let current = error as { type?: unknown; code?: unknown; cause?: unknown } | null;
  let code = "WORKFLOW_ERROR";
  for (let depth = 0; current && depth < 8; depth++, current = current.cause as typeof current) {
    for (const value of [current.type, current.code]) if (typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/.test(value)) code = value;
  }
  return code;
}

/** No I/O and no random calls. The worker installs this only when export is enabled. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const info = workflowInfo();
  let parent: TraceCarrier | null = null;
  let context: TraceContext = contextForRun(info.originalExecutionRunId, null);
  let scopeSequence = 0;
  const record = (spanContext: TraceContext, spanParent: TraceCarrier | null, startedAt: number, outcome: string, code: string | undefined, args: readonly unknown[]) => {
    const endedAt = Math.max(startedAt, Date.now());
    spaceOtel.record({
      traceId: spanContext.traceId, spanId: spanContext.spanId, parentSpanId: spanParent?.parentSpanId ?? null,
      name: `workflow ${safeType(info.workflowType)}`, startTimeMs: startedAt, endTimeMs: endedAt,
      attributes: { "space.workflow_id": info.workflowId, "space.workflow_run_id": info.runId,
        "space.workflow_type": safeType(info.workflowType), "space.attempt": info.attempt,
        "space.outcome": outcome, "space.duration_ms": endedAt - startedAt,
        ...(code ? { "space.reason_code": code } : {}), ...correlationAttributes(args) },
      error: outcome === "FAILED" || outcome === "FAILED_RESULT", links: spanParent?.links
    });
  };
  installWorkflowScopeTracer(async (args, work) => {
    const previousContext = context, previousParent = parent;
    parent = backgroundParentFromArgs(args) ?? parentFromArgs(args) ?? carrierForChild(context);
    context = contextForRun(`${info.originalExecutionRunId}:scope:${scopeSequence++}`, parent);
    const scopeContext = context, scopeParent = parent, startedAt = Date.now();
    let outcome = "COMPLETED", code: string | undefined;
    try { return await work(); }
    catch (error) {
      outcome = error instanceof ContinueAsNew ? "CONTINUED" : isCancellation(error) ? "CANCELLED" : "FAILED";
      if (outcome === "FAILED") code = failureCode(error);
      throw error;
    } finally {
      record(scopeContext, scopeParent, startedAt, outcome, code, args);
      context = previousContext; parent = previousParent;
    }
  });
  return {
    inbound: [{
      async execute(input, next) {
        parent = parentFromHeaders(input.headers) ?? backgroundParentFromArgs(input.args) ?? parentFromArgs(input.args) ?? parseParent(info.memo?.traceparent);
        context = contextForRun(info.originalExecutionRunId, parent);
        const startedAt = info.runStartTime.getTime();
        let outcome = "COMPLETED";
        let code: string | undefined;
        try {
          return await next(input);
        } catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED";
          else if (isCancellation(error)) outcome = "CANCELLED";
          else { outcome = "FAILED"; code = failureCode(error); }
          throw error;
        } finally {
          record(context, parent, startedAt, outcome, code, input.args);
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, carrierForChild(context)) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, carrierForChild(context)) }),
      startChildWorkflowExecution: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, carrierForChild(context)) }),
      continueAsNew: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, carrierForContinuation(context, parent)) })
    }]
  };
};
