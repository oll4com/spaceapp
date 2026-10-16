import { ContinueAsNew, isCancellation, proxySinks, workflowInfo, type Sinks, type WorkflowInterceptors } from "@temporalio/workflow";
import type { ServerSpan } from "@space/telemetry";
import { contextFromHeaders, contextFromTraceparent, inputTraceContext, isBackgroundContinuation, runSpanId, runTraceId, traceAttributes, withTraceHeader, type TraceContext } from "./workflow-trace-context.js";

export interface TraceSinks extends Sinks {
  spaceTrace: { record(span: ServerSpan): void };
}
const sink = proxySinks<TraceSinks>();

export function interceptors(): WorkflowInterceptors {
  const info = workflowInfo();
  let context: TraceContext = { traceId: runTraceId(info.runId), spanId: runSpanId(info.runId) };
  return {
    inbound: [{
      async execute(input, next) {
        // Memo is decoded after interceptor factories are initialized.
        const info = workflowInfo();
        const parent = contextFromHeaders(input.headers) ?? inputTraceContext(input.args) ?? contextFromTraceparent(info.memo?.traceparent);
        context = { traceId: parent?.traceId ?? context.traceId, spanId: context.spanId };
        const links = parent && "links" in parent ? [...((parent as TraceContext).links ?? [])] : [];
        if (info.continuedFromExecutionRunId) links.push({ traceId: context.traceId, spanId: runSpanId(info.continuedFromExecutionRunId) });
        const started = Date.now();
        let status = "COMPLETED";
        try { return await next(input); }
        catch (error) {
          status = error instanceof ContinueAsNew ? "CONTINUED_AS_NEW" : isCancellation(error) ? "CANCELLED" : "FAILED";
          throw error;
        } finally {
          const ended = Date.now();
          // Sinks perform no workflow I/O and are registered with callDuringReplay:false.
          sink.spaceTrace.record({ ...context, parentSpanId: parent?.spanId ?? null, name: info.workflowType, kind: 1,
            startTimeUnixNano: BigInt(started) * 1_000_000n, endTimeUnixNano: BigInt(ended) * 1_000_000n,
            attributes: traceAttributes({ workflowId: info.workflowId, runId: info.runId, workflowType: info.workflowType, status, durationMs: Math.max(0, ended - started) }),
            error: status === "FAILED", links: links.filter((link, index) => links.findIndex(other => other.traceId === link.traceId && other.spanId === link.spanId) === index).slice(0, 4) });
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, context) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, context) }),
      startChildWorkflowExecution(input, next) {
        const args = input.options.args ?? [];
        const request = inputTraceContext(args);
        // A long-lived supervisor can receive missions from different HTTP traces.
        // Preserve that mission's API parent and link its supervising execution.
        const parent = request && request.traceId !== context.traceId ? { ...request, links: [context] } : context;
        const propagated = isBackgroundContinuation(args) ? { ...parent, links: [context, ...(request ? [request] : [])] } : parent;
        return next({ ...input, headers: withTraceHeader(input.headers, propagated) });
      },
      continueAsNew: (input, next) => next({ ...input, headers: withTraceHeader(input.headers, { ...context, links: [context] }) })
    }]
  };
}
