import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import type { WorkflowInfo } from "@temporalio/workflow";
import type { SpanExporter } from "@space/contracts";
import type { TracingSinks, WorkflowSpanPayload } from "./workflow-tracing-interceptor.js";

/**
 * Creates the worker-side sinks for workflow span exports.
 * Setting `callDuringReplay: false` guarantees that replaying workflow histories
 * will never emit duplicate spans or perform any I/O.
 */
export function createTracingSinks(spanExporter: SpanExporter | null): InjectedSinks<TracingSinks> {
  if (!spanExporter) {
    return {
      tracing: {
        exportWorkflowSpan: {
          fn: () => undefined,
          callDuringReplay: false
        }
      }
    };
  }

  return {
    tracing: {
      exportWorkflowSpan: {
        fn: (_info: WorkflowInfo, payload: WorkflowSpanPayload) => {
          spanExporter.record({
            traceId: payload.traceId,
            spanId: payload.spanId,
            parentSpanId: payload.parentSpanId ?? null,
            name: payload.name,
            kind: 1, // SPAN_KIND_INTERNAL
            startTimeUnixNano: BigInt(payload.startTimeUnixNano),
            endTimeUnixNano: BigInt(payload.endTimeUnixNano),
            attributes: payload.attributes,
            error: payload.error,
            links: payload.links
          });
        },
        callDuringReplay: false
      }
    }
  };
}

/**
 * Resolves the path to the workflow-tracing-interceptor module,
 * adapting dynamically between TypeScript dev/test runs and compiled JS dist.
 */
export function resolveWorkflowTracingInterceptorPath(): string {
  const tsPath = fileURLToPath(new URL("./workflow-tracing-interceptor.ts", import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  return fileURLToPath(new URL("./workflow-tracing-interceptor.js", import.meta.url));
}
