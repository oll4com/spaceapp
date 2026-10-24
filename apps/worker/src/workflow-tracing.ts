import {
  ContinueAsNew, isCancellation, proxySinks, workflowInfo,
  type WorkflowInterceptors, type Sinks
} from "@temporalio/workflow";
import { categorizeFailureCode, formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import { readTraceEnvelope, traceAttributes, traceContextFromArgs, traceHeaders, type SpanLink, type WorkflowTraceSpan } from "./trace-propagation.js";

export interface TraceSinks extends Sinks {
  spaceTracing: { record(span: WorkflowTraceSpan): void };
}
const { spaceTracing } = proxySinks<TraceSinks>();

/** Pure identity derivation: never consumes the workflow's deterministic RNG. */
function runIdentity(runId: string): string {
  const value = runId.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value) ? value : "00000000000000000000000000000001";
}

export const interceptors = (): WorkflowInterceptors => {
  const info = workflowInfo();
  let traceId = runIdentity(info.runId);
  const spanId = traceId.slice(0, 16) === "0000000000000000" ? traceId.slice(16) : traceId.slice(0, 16);
  let parentSpanId: string | null = null;
  let flags = "01";
  let links: SpanLink[] = [];
  let originalParent: string | null = null;
  const current = () => formatTraceparent(traceId, spanId, flags);
  const link = () => ({ traceId, spanId });
  return {
    inbound: [{
      async execute(input, next) {
        // Memo payloads are decoded after interceptor factories are created.
        const memo = workflowInfo().memo;
        const header = readTraceEnvelope(input.headers);
        originalParent = header.traceparent ?? traceContextFromArgs(input.args) ??
          (typeof memo?.traceparent === "string" ? memo.traceparent : null);
        const parent = header.newTrace ? null : parseTraceparent(originalParent);
        if (parent) { traceId = parent.traceId; parentSpanId = parent.parentId; flags = parent.flags; }
        links = header.links ?? [];
        const startTimeMs = Date.now();
        let outcome = "COMPLETED";
        let reasonCode: string | null = null;
        try { return await next(input); }
        catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else if (isCancellation(error)) outcome = "CANCELLED";
          else {
            outcome = "FAILED";
            reasonCode = "WORKFLOW_FAILED";
            let cause = error as { type?: unknown; cause?: unknown } | undefined;
            for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause as typeof cause)
              if (isSafeErrorCode(cause.type)) reasonCode = cause.type;
          }
          throw error;
        } finally {
          const endTimeMs = Date.now();
          spaceTracing.record({ traceId, spanId, parentSpanId, workflowType: info.workflowType,
            startTimeMs, endTimeMs, links, error: outcome === "FAILED",
            attributes: traceAttributes({ "space.workflow_type": info.workflowType,
              "space.workflow_id": info.workflowId, "space.temporal_run_id": info.runId,
              "space.outcome": outcome, "space.duration_ms": Math.max(0, endTimeMs - startTimeMs),
              ...(reasonCode ? { "space.reason_code": reasonCode, "space.category": categorizeFailureCode(reasonCode) } : {}) }) });
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: traceHeaders(input.headers, { traceparent: current() }) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: traceHeaders(input.headers, { traceparent: current() }) }),
      startChildWorkflowExecution(input, next) {
        const args = input.options.args ?? [];
        const first = args[0] as { traceId?: unknown; roomAgentContinuation?: unknown } | undefined;
        const background = first?.roomAgentContinuation && typeof first.traceId === "string" && first.traceId.startsWith("trace:bg-");
        const childParent = traceContextFromArgs(args);
        const newRequest = childParent && childParent !== originalParent && parseTraceparent(childParent);
        // Automatic continuation roots have their own trace, linked to their
        // supervisor and the originating request. Later operator requests keep
        // their own API parent while linking to the long-lived supervisor.
        const source = parseTraceparent(childParent);
        const context = background ? { newTrace: true, links: [link(), ...(source ? [{ traceId: source.traceId, spanId: source.parentId }] : [])] }
          : newRequest ? { traceparent: childParent!, links: [link()] }
          : { traceparent: current() };
        return next({ ...input, headers: traceHeaders(input.headers, context) });
      },
      continueAsNew: (input, next) => next({ ...input, headers: traceHeaders(input.headers, { traceparent: current(), links: [link()] }) })
    }]
  };
};
