import {
  ContinueAsNew, isCancellation, patched, proxySinks, workflowInfo,
  type Sinks, type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, parseTraceparent, workflowTraceSpanId } from "@space/contracts";
import {
  inputTrace, readTraceCarrier, traceHeaders, traceCorrelationAttributes, WORKFLOW_TRACE_PATCH,
  type WorkflowSpanEvent, type WorkflowTraceCarrier
} from "./workflow-trace-context.js";

export interface WorkflowTracingSinks extends Sinks {
  spaceTracing: { record(event: WorkflowSpanEvent): void };
}

/** Always installed, including when export is disabled, for history compatibility. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  let carrier: WorkflowTraceCarrier | null = null;
  let enabled = false;
  const sinks = proxySinks<WorkflowTracingSinks>();
  return {
    inbound: [{
      async execute(input, next) {
        // Old histories must not acquire new header commands or RNG calls.
        enabled = patched(WORKFLOW_TRACE_PATCH);
        if (!enabled) return next(input);
        const info = workflowInfo();
        const inherited = readTraceCarrier(input.headers);
        const origin = inputTrace(input.args);
        const parent = parseTraceparent(inherited?.traceparent ?? origin.traceparent ?? info.memo?.traceparent);
        const traceId = parent?.traceId ?? workflowTraceSpanId(`trace:${info.runId}`) + workflowTraceSpanId(info.runId);
        const spanId = workflowTraceSpanId(`workflow:${info.runId}`);
        carrier = {
          traceparent: formatTraceparent(traceId, spanId, parent?.flags ?? "01"),
          requestTraceparent: inherited?.requestTraceparent ?? origin.traceparent ?? (parent ? formatTraceparent(parent.traceId, parent.parentId, parent.flags) : undefined)
        };
        const startedAt = Date.now();
        let outcome: WorkflowSpanEvent["outcome"] = "COMPLETED";
        try {
          const result = await next(input);
          const status = (result as { status?: unknown } | null)?.status;
          if (status === "FAILED") outcome = "FAILED";
          if (status === "CANCELLED" || status === "INTERRUPTED") outcome = "CANCELLED";
          return result;
        }
        catch (error) {
          outcome = error instanceof ContinueAsNew ? "CONTINUED_AS_NEW" : isCancellation(error) ? "CANCELLED" : "FAILED";
          throw error;
        } finally {
          sinks.spaceTracing.record({ traceId, spanId, parentSpanId: parent?.parentId ?? null,
            startedAt, endedAt: Date.now(), outcome,
            links: [...(inherited?.links ?? []), ...(origin.link ? [origin.link] : [])].slice(0, 8),
            correlation: traceCorrelationAttributes(input.args) });
        }
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        return next(enabled && carrier ? { ...input, headers: traceHeaders(input.headers, carrier) } : input);
      },
      scheduleLocalActivity(input, next) {
        return next(enabled && carrier ? { ...input, headers: traceHeaders(input.headers, carrier) } : input);
      },
      startChildWorkflowExecution(input, next) {
        if (!enabled || !carrier) return next(input);
        const origin = inputTrace(input.options.args);
        // Long-lived supervisors accept turns from later API requests, even
        // within the same W3C trace. Parent each such turn to its own request.
        const child = origin.traceparent && origin.traceparent !== carrier.requestTraceparent
          ? { traceparent: origin.traceparent, requestTraceparent: origin.traceparent }
          : carrier;
        return next({ ...input, headers: traceHeaders(input.headers, child) });
      },
      continueAsNew(input, next) {
        if (!enabled || !carrier) return next(input);
        const previous = parseTraceparent(carrier.traceparent)!;
        return next({ ...input, headers: traceHeaders(input.headers, { ...carrier,
          links: [{ traceId: previous.traceId, spanId: previous.parentId }] }) });
      }
    }]
  };
};
