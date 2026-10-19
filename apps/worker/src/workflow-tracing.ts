import { ContinueAsNew, isCancellation, proxySinks, workflowInfo, type WorkflowInterceptors } from "@temporalio/workflow";
import { categorizeFailureCode, parseTraceparent } from "@space/contracts";
import { readTraceHeader, spanTraceparent, traceFailureCode, traceInput, workflowSpanId, writeTraceHeader,
  TRACE_LINK_HEADER, type WorkflowTraceSinks, type WorkflowTraceSpan } from "./workflow-trace-context.js";

/** Workflow-only module: no Node imports, exporter, I/O, or additional PRNG calls. */
export function interceptors(): WorkflowInterceptors {
  const sinks = proxySinks<WorkflowTraceSinks>();
  let span: WorkflowTraceSpan | null = null;
  let incomingParent: string | null = null;
  const emit = (status: string, error = false, code?: string) => {
    if (!span) return;
    try { sinks.spaceTrace.record({ ...span, endedAt: Math.max(span.startedAt, Date.now()), error,
      attributes: { ...span.attributes, "space.status": status,
        ...(code ? { "space.reason_code": code, "space.category": categorizeFailureCode(code) } : {}) } }); } catch {}
  };
  const context = () => span ? spanTraceparent(span.traceId, span.spanId) : null;
  return {
    inbound: [{ async execute(input, next) {
      const info = workflowInfo(), values = traceInput(input.args);
      const memo = typeof info.memo?.traceparent === "string" ? info.memo.traceparent : null;
      incomingParent = readTraceHeader(input.headers) ?? values.parent ?? memo;
      const parsed = parseTraceparent(incomingParent);
      const runHex = info.runId.replace(/-/g, "").toLowerCase();
      const traceId = parsed?.traceId ?? (/^[0-9a-f]{32}$/.test(runHex) ? runHex : `${workflowSpanId(info.runId)}${workflowSpanId(info.workflowId)}`);
      const link = parseTraceparent(readTraceHeader(input.headers, TRACE_LINK_HEADER));
      span = { traceId, spanId: workflowSpanId(info.runId), parentSpanId: parsed?.parentId ?? null,
        name: `workflow ${info.workflowType}`, startedAt: info.startTime.getTime(), endedAt: info.startTime.getTime(), error: false,
        attributes: { ...values.attributes, "space.workflow_type": info.workflowType,
          "space.workflow_id": info.workflowId, "space.run_id": info.runId },
        links: link ? [{ traceId: link.traceId, spanId: link.parentId }] : [] };
      // OTLP exports ended spans. Sending an initial snapshot with the same ID
      // is not portable: Jaeger retains both records rather than upserting.
      // Activities may arrive first; their parent is exported when this run ends.
      try { const result = await next(input);
        const failed = Boolean(result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED");
        emit(failed ? "FAILED_RESULT" : "COMPLETED", failed, failed ? "WORKFLOW_RESULT_FAILED" : undefined);
        return result;
      } catch (error) {
        if (error instanceof ContinueAsNew) emit("CONTINUED");
        else if (isCancellation(error)) emit("CANCELLED");
        else emit("FAILED", true, traceFailureCode(error));
        throw error;
      }
    } }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: writeTraceHeader(input.headers, context()) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: writeTraceHeader(input.headers, context()) }),
      startChildWorkflowExecution: (input, next) => {
        const values = traceInput(input.options.args ?? []), external = parseTraceparent(values.parent);
        const parent = external && span && external.traceId !== span.traceId ? values.parent : context();
        let headers = writeTraceHeader(input.headers, parent);
        if (values.background) headers = writeTraceHeader(headers, values.parent ?? context(), TRACE_LINK_HEADER);
        else if (parent !== context()) headers = writeTraceHeader(headers, context(), TRACE_LINK_HEADER);
        return next({ ...input, headers });
      },
      continueAsNew: (input, next) => next({ ...input,
        headers: writeTraceHeader(writeTraceHeader(input.headers, incomingParent ?? context()), context(), TRACE_LINK_HEADER) })
    }]
  };
}
