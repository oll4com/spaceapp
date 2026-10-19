import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime/otlp-span-exporter";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { safeWorkerAttributes, traceIdentifier, type TraceSinks } from "./temporal-trace-context.js";

/** One exporter per process, no shared registry or coupling to a workflow worker. */
export function createWorkerTracing(serviceName: string, env: NodeJS.ProcessEnv = process.env, supplied?: SpanExporter) {
  const exporter = supplied ?? otlpSpanExporterFromEnv(env, serviceName);
  const sinks: InjectedSinks<TraceSinks> = { spaceTracing: { completed: {
    callDuringReplay: false,
    fn(_info, record) {
      if (!exporter) return;
      try { exporter.record({ traceId: record.traceId, spanId: record.spanId, parentSpanId: record.parentSpanId,
        name: traceIdentifier(record.name) ?? "workflow", kind: 1,
        startTimeUnixNano: BigInt(Math.trunc(record.startedMs)) * 1_000_000n,
        endTimeUnixNano: BigInt(Math.trunc(record.endedMs)) * 1_000_000n,
        attributes: safeWorkerAttributes(record.attributes), error: record.error, links: record.links }); } catch { /* Observation never changes work. */ }
    }
  } } };
  return {
    exporter,
    options: {
      sinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spanExporter: exporter })],
        workflowModules: exporter ? [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))] : []
      }
    },
    close: () => exporter?.close() ?? Promise.resolve()
  };
}
