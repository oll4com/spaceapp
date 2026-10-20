import type { SpanExporter } from "@space/runtime";
import type { InjectedSinks } from "@temporalio/worker";
import type { WorkflowTracingSinks } from "./workflow-observability.js";
import { workerSpanAttributes } from "./workflow-span.js";

/** Sink processing is outside the workflow isolate; it never waits for HTTP. */
export function workflowSpanSinks(spans: SpanExporter): InjectedSinks<WorkflowTracingSinks> {
  return { spaceTracing: { record: {
    callDuringReplay: false,
    fn(_info, span) {
      try {
        const attributes = workerSpanAttributes(span.attributes);
        spans.record({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
          name: `workflow ${attributes["space.workflow_type"] ?? "unknown"}`, kind: 1,
          startTimeUnixNano: BigInt(Math.trunc(span.startTimeMs)) * 1_000_000n,
          endTimeUnixNano: BigInt(Math.trunc(span.endTimeMs)) * 1_000_000n,
          attributes, error: span.error, links: span.links });
      } catch { /* Collector/instrumentation failures never fail a workflow task. */ }
    }
  } } };
}
