import { formatTraceparent, parseTraceparent } from "@space/contracts";
import {
  ContinueAsNew, isCancellation, proxySinks, workflowInfo,
  type Sinks, type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import {
  inputTraceparent, readTraceHeader, traceHeaders, workflowInputAttributes, workflowTraceContext,
  type SpanLink, type TemporalTraceContext
} from "./temporal-trace-context.js";

export interface WorkflowSpanRecord {
  context: TemporalTraceContext;
  startTimeMs: number;
  endTimeMs: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  attributes: Record<string, string>;
}
export interface TelemetrySinks extends Sinks {
  spaceTelemetry: { record(span: WorkflowSpanRecord): void };
}
const { spaceTelemetry } = proxySinks<TelemetrySinks>();

export const interceptors: WorkflowInterceptorsFactory = () => {
  let context: TemporalTraceContext;
  let outcome: WorkflowSpanRecord["outcome"] = "COMPLETED";
  let attributes: Record<string, string> = {};
  const parent = () => formatTraceparent(context.traceId, context.spanId, "01");
  return {
    inbound: [{
      async execute(input, next) {
        // Memo decoding happens after interceptor construction. Read the
        // current WorkflowInfo here so starts that propagate through memo work.
        const info = workflowInfo();
        const fromInput = inputTraceparent(input.args);
        const fromMemo = typeof info.memo?.traceparent === "string" ? info.memo.traceparent : undefined;
        context = workflowTraceContext(info.runId, readTraceHeader(input.headers) ??
          (fromInput || fromMemo ? { traceparent: (fromInput ?? fromMemo)! } : null));
        attributes = workflowInputAttributes(input.args);
        const startTimeMs = Date.now();
        try { return await next(input); }
        catch (error) {
          outcome = error instanceof ContinueAsNew ? "CONTINUED_AS_NEW" : isCancellation(error) ? "CANCELLED" : "FAILED";
          throw error;
        } finally {
          // The host sink is registered with callDuringReplay:false. This call
          // enqueues a record without I/O or an await in workflow code.
          spaceTelemetry.record({ context, startTimeMs, endTimeMs: Date.now(), outcome, attributes });
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: traceHeaders(input.headers, { traceparent: parent() }) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: traceHeaders(input.headers, { traceparent: parent() }) }),
      startChildWorkflowExecution(input, next) {
        const args = input.options.args ?? [];
        const source = inputTraceparent(args);
        const links: SpanLink[] = [];
        const first = args[0] as { roomAgentContinuation?: unknown } | undefined;
        // A later operator request can start a mission in an older supervisor.
        // Preserve its request trace and link to that supervising run.
        if (source && (first?.roomAgentContinuation || source.split("-")[1] !== context.traceId)) {
          links.push({ traceId: context.traceId, spanId: context.spanId });
          if (first?.roomAgentContinuation) {
            const origin = parseTraceparent(source)!;
            links.push({ traceId: origin.traceId, spanId: origin.parentId });
          }
          return next({ ...input, headers: traceHeaders(input.headers, { traceparent: source, links }) });
        }
        return next({ ...input, headers: traceHeaders(input.headers, { traceparent: parent() }) });
      },
      continueAsNew(input, next) {
        return next({ ...input, headers: traceHeaders(input.headers, {
          traceparent: formatTraceparent(context.traceId, context.parentSpanId ?? context.spanId, "01"),
          links: [{ traceId: context.traceId, spanId: context.spanId }]
        }) });
      }
    }]
  };
};
