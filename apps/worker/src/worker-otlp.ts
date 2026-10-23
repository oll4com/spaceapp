import { fileURLToPath } from "node:url";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import type { InjectedSinks } from "@temporalio/worker";
import { createOtlpWorkflowSinks, type OtlpWorkflowSinks } from "./otlp-workflow-sink.js";

export interface WorkerOtlpConfiguration {
  spans: SpanExporter | null;
  sinks: InjectedSinks<OtlpWorkflowSinks>;
  interceptors: {
    workflowModules: string[];
    activity: ReturnType<typeof createActivityObservabilityInterceptors>[];
  };
}

import { existsSync } from "node:fs";

export function resolveWorkflowInterceptorsPath(): string {
  const jsPath = fileURLToPath(new URL("./otlp-workflow-interceptors.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("./otlp-workflow-interceptors.ts", import.meta.url));
  return existsSync(jsPath) ? jsPath : tsPath;
}

/**
 * Configures OTLP tracing for Temporal workers.
 *
 * When SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is configured, workers export spans
 * over OTLP/HTTP to `<endpoint>/v1/traces`. When not configured, spans is
 * null and workers do not attempt export or connect to anything.
 */
export function configureWorkerOtlp(serviceName: string, env: NodeJS.ProcessEnv = process.env): WorkerOtlpConfiguration {
  const spans = otlpSpanExporterFromEnv(env, serviceName);
  const sinks = createOtlpWorkflowSinks(spans);
  const workflowInterceptorsPath = resolveWorkflowInterceptorsPath();

  return {
    spans,
    sinks,
    interceptors: {
      workflowModules: [workflowInterceptorsPath],
      activity: [createActivityObservabilityInterceptors({ spans })]
    }
  };
}
