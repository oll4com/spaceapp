import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { createOtlpSpanSinks } from "./otlp-span-sink.js";

/**
 * Single wiring helper for worker-side OTLP span export. When
 * SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is set, every Temporal worker process
 * (`worker.ts`, `memory-maintenance-worker.ts`, `memory-mutation-worker.ts`)
 * exports one span per workflow run (through sinks) and one span per
 * activity attempt (through the activity observability interceptor) to
 * `<endpoint>/v1/traces`, using the same exporter implementation as the API.
 * When it is not set, the exporter is null and nothing is recorded or sent.
 */

export const WORKER_OTLP_SCOPE_NAME = "space-worker";

export interface WorkerOtlp {
  spanExporter: SpanExporter | null;
  /** Spread into Worker.create: sinks plus workflow/activity interceptors. */
  workerOptions: Pick<WorkerOptions, "sinks" | "interceptors">;
}

export function workerOtlp(serviceName: string, env: NodeJS.ProcessEnv = process.env): WorkerOtlp {
  const spanExporter = otlpSpanExporterFromEnv(env, serviceName, WORKER_OTLP_SCOPE_NAME);
  return {
    spanExporter,
    workerOptions: {
      sinks: createOtlpSpanSinks(spanExporter),
      interceptors: {
        workflowModules: [fileURLToPath(new URL("./otlp-workflow-interceptors.js", import.meta.url))],
        activity: [createActivityObservabilityInterceptors({ spanExporter })]
      }
    }
  };
}
