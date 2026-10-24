import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import { traceAttributes, validLinks, type WorkflowTraceSpan } from "./trace-propagation.js";

/** Tracing is opt-in; the workflow module has no HTTP, filesystem or host I/O. */
export function createWorkflowTracingOptions(spans: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  if (!spans) return {};
  return {
    interceptors: { workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))] },
    sinks: { spaceTracing: { record: {
      callDuringReplay: false,
      fn: (_info, span: WorkflowTraceSpan) => {
        const attributes = traceAttributes(span.attributes);
        const type = attributes["space.workflow_type"] ?? "unknown";
        if (!Number.isFinite(span.startTimeMs) || !Number.isFinite(span.endTimeMs)) return;
        try {
          spans.record({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
            name: `workflow ${type}`, kind: 1,
            startTimeUnixNano: BigInt(Math.trunc(span.startTimeMs)) * 1_000_000n,
            endTimeUnixNano: BigInt(Math.trunc(span.startTimeMs)) * 1_000_000n +
              (span.endTimeMs > span.startTimeMs ? BigInt(Math.trunc(span.endTimeMs - span.startTimeMs)) * 1_000_000n : 1n),
            attributes, links: validLinks(span.links), error: span.error === true });
        } catch { /* Telemetry must never affect workflow completion. */ }
      }
    } } }
  };
}
