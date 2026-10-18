import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import { sanitizeSpanAttributes, type ServerSpan, type SpanExporter, type SpanLink } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { runSpanId, runTraceId, validContext } from "./workflow-trace-context.js";

function safeRecord(exporter: SpanExporter, span: ServerSpan): void {
  if (!validContext(span)) return;
  if (span.parentSpanId !== null && !validContext({ traceId: span.traceId, spanId: span.parentSpanId })) return;
  if (!/^[A-Za-z0-9_.$-]{1,100}$/.test(span.name)) return;
  const links: SpanLink[] = (span.links ?? [])
    .filter(link => validContext(link))
    .slice(0, 4)
    .map(link => ({
      traceId: link.traceId,
      spanId: link.spanId,
      ...(link.attributes ? { attributes: sanitizeSpanAttributes(link.attributes) } : {})
    }));
  try {
    exporter.record({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      attributes: sanitizeSpanAttributes(span.attributes),
      error: span.error,
      kind: 1,
      ...(links.length ? { links } : {})
    });
  } catch {
    // Optional tracing must not change a workflow result.
  }
}

export function workerTracingOptions(
  exporter: SpanExporter | null,
  workflowModule = fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))
): Pick<WorkerOptions, "interceptors" | "sinks"> {
  if (!exporter) return { interceptors: { activity: [createActivityObservabilityInterceptors()] } };
  return {
    interceptors: {
      activity: [createActivityObservabilityInterceptors({ spans: exporter })],
      workflowModules: [workflowModule]
    },
    sinks: {
      spaceTrace: {
        record: {
          fn: (_info, span) => safeRecord(exporter, span as ServerSpan),
          callDuringReplay: false
        }
      }
    }
  };
}

export { runSpanId, runTraceId };
