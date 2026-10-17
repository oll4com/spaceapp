import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import { sanitizeSpanAttributes, type SpanExporter } from "@space/runtime";
import type {
  WorkflowObservabilitySinks,
  WorkflowSpanRecordPayload
} from "./workflow-observability-interceptors.js";

const candidateJs = fileURLToPath(new URL("./workflow-observability-interceptors.js", import.meta.url));

/**
 * Path to the workflow interceptor module loaded into the Temporal workflow
 * bundle. Resolves to `.ts` when running directly from source in tests and
 * `.js` in compiled builds.
 */
export const workflowObservabilityInterceptorsPath = existsSync(candidateJs)
  ? candidateJs
  : candidateJs.replace(/\.js$/, ".ts");

export function recordWorkflowSpanFromSink(
  payload: WorkflowSpanRecordPayload,
  spans: SpanExporter | null | undefined
): void {
  if (!spans) return;
  const startNs = BigInt(Math.max(0, Math.round(payload.startTimeMs * 1_000_000)));
  const endNs = BigInt(Math.max(Number(startNs), Math.round(payload.endTimeMs * 1_000_000)));
  spans.record({
    traceId: payload.traceId,
    spanId: payload.spanId,
    parentSpanId: payload.parentSpanId,
    name: payload.name,
    kind: 1,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    attributes: sanitizeSpanAttributes(payload.attributes),
    ...(payload.links?.length ? { links: payload.links } : {}),
    error: payload.error
  });
}

/**
 * Temporal workflow sinks for OTLP workflow span export.
 * `callDuringReplay: false` guarantees replaying workflow histories never
 * re-exports duplicate spans or performs non-deterministic I/O inside the
 * workflow sandbox.
 */
export function createWorkflowObservabilitySinks(
  options: { spans?: SpanExporter | null } = {}
): InjectedSinks<WorkflowObservabilitySinks> {
  return {
    observability: {
      recordWorkflowSpan: {
        fn(_info, payload) {
          recordWorkflowSpanFromSink(payload, options.spans);
        },
        callDuringReplay: false
      }
    }
  };
}
