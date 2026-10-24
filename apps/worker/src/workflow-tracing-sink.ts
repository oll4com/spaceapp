import type { WorkflowInfo, Sinks } from "@temporalio/workflow";
import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import type { WorkflowSpanWire } from "./workflow-tracing-wire.js";
import { workflowSpanId } from "./workflow-span-ids.js";

export interface WorkflowTraceSinks extends Sinks {
  spaceTrace: { record(span: WorkflowSpanWire): void };
}

const TRACE = /^[0-9a-f]{32}$/;
const SPAN = /^[0-9a-f]{16}$/;
const ID = /^[A-Za-z0-9:._-]{1,200}$/;
const WORKFLOW_TYPE = /^[a-zA-Z0-9._-]{1,120}$/;

/** Harden the Node/sandbox boundary: never export free-form workflow inputs,
 * errors, prompts, paths or URLs. Only documented ID/status fields survive.
 */
export function recordWorkflowSpan(exporter: SpanExporter | null, span: WorkflowSpanWire): void {
  if (!exporter || !TRACE.test(span.traceId) || !SPAN.test(span.spanId) ||
      (span.parentSpanId !== null && !SPAN.test(span.parentSpanId)) ||
      !ID.test(span.workflowId) || !WORKFLOW_TYPE.test(span.workflowType) ||
      !ID.test(span.runId) || !Number.isSafeInteger(span.startMs) ||
      !Number.isSafeInteger(span.endMs) || span.endMs < span.startMs ||
      !["COMPLETED", "FAILED", "CANCELLED", "CONTINUED"].includes(span.status)) return;
  const attributes: Record<string, string | number> = {
    "space.workflow_type": span.workflowType,
    "space.workflow_id": span.workflowId,
    "space.temporal_run_id": span.runId,
    "space.status": span.status
  };
  const links = [];
  if (span.continuedFromRunId && ID.test(span.continuedFromRunId)) {
    const previousSpanId = workflowSpanId(span.continuedFromRunId);
    if (previousSpanId !== span.spanId) links.push({ traceId: span.traceId, spanId: previousSpanId });
  }
  if (span.linkedTraceId && TRACE.test(span.linkedTraceId) &&
      span.linkedSpanId && SPAN.test(span.linkedSpanId) &&
      (span.linkedTraceId !== span.traceId || span.linkedSpanId !== span.parentSpanId)) {
    links.push({ traceId: span.linkedTraceId, spanId: span.linkedSpanId });
  }
  exporter.record({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: "workflow " + span.workflowType,
    kind: 1,
    startTimeUnixNano: BigInt(span.startMs) * 1_000_000n,
    endTimeUnixNano: BigInt(span.endMs) * 1_000_000n,
    attributes,
    error: span.status === "FAILED",
    ...(links.length ? { links } : {})
  });
}

/** Non-blocking sink calls are automatically suppressed during Temporal replay.
 * The exporter only queues an immutable record, never performs I/O synchronously.
 */
export function workflowTracingSinks(exporter: SpanExporter | null): InjectedSinks<WorkflowTraceSinks> {
  return {
    spaceTrace: {
      record: {
        callDuringReplay: false,
        fn: (_info: WorkflowInfo, span: WorkflowSpanWire) => recordWorkflowSpan(exporter, span)
      }
    }
  };
}
