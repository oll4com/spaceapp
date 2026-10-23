import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { createWorkflowTracingSinks } from "./workflow-span-sink.js";

/** The workflow interceptor module, built next to this file (TypeScript source when run from the source tree). */
export function workflowTracingModulePath(): string {
  const built = fileURLToPath(new URL("./workflow-tracing.js", import.meta.url));
  return existsSync(built) ? built : built.replace(/\.js$/, ".ts");
}

/**
 * Interceptors and sinks for one Temporal worker. Activity records and metrics
 * are always on. With SPACE_OTEL_EXPORTER_OTLP_ENDPOINT set (`spans` not null)
 * the worker also exports workflow spans and passes each run's span to its
 * activities and child workflows; without it the workflow sandbox is unchanged.
 */
export function workerTracingOptions(spans: SpanExporter | null, workflowModule = workflowTracingModulePath): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const activity = [createActivityObservabilityInterceptors({ spans })];
  if (!spans) return { interceptors: { activity } };
  return {
    interceptors: { activity, workflowModules: [workflowModule()] },
    sinks: createWorkflowTracingSinks(spans)
  };
}
