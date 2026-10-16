import { fileURLToPath } from "node:url";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import type { InjectedSinks } from "@temporalio/worker";
import { createOtlpWorkflowSinks, type OtlpWorkflowSinks } from "./otlp-workflow-sink.js";

export interface WorkerOtlpConfiguration {
  spanExporter: SpanExporter | null;
  sinks: InjectedSinks<OtlpWorkflowSinks>;
  interceptors: {
    workflowModules: string[];
    activity: ReturnType<typeof createActivityObservabilityInterceptors>[];
  };
}

/**
 * Configures OTLP tracing for Temporal workers.
 *
 * When SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is configured, workers export spans
 * over OTLP/HTTP to `<endpoint>/v1/traces`. When not configured, spanExporter is
 * null and workers do not attempt export or connect to anything.
 */
export function configureWorkerOtlp(serviceName: string, env: NodeJS.ProcessEnv = process.env): WorkerOtlpConfiguration {
  const spanExporter = otlpSpanExporterFromEnv(env, serviceName);
  const sinks = createOtlpWorkflowSinks(spanExporter);
  const workflowInterceptorsPath = fileURLToPath(new URL("./otlp-workflow-interceptors.js", import.meta.url));

  return {
    spanExporter,
    sinks,
    interceptors: {
      workflowModules: [workflowInterceptorsPath],
      activity: [createActivityObservabilityInterceptors({ spanExporter })]
    }
  };
}
