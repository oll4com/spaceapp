import type { SpanExporter } from "@space/runtime";
import type { InjectedSinks } from "@temporalio/worker";
import type { WorkflowSpanPayload, WorkflowTelemetrySinks } from "./workflow-observability.js";

/**
 * Worker-side end of the workflow span sink. Runs in the Node.js process, never
 * in the deterministic workflow sandbox, and forwards to the shared OTLP
 * exporter. Replay does not re-emit spans.
 */
export function workflowObservabilitySinks(spans: SpanExporter | null): InjectedSinks<WorkflowTelemetrySinks> {
  return {
    spaceWorkflowTelemetry: {
      span: {
        fn: (_info, payload: WorkflowSpanPayload) => {
          spans?.record({
            traceId: payload.traceId,
            spanId: payload.spanId,
            parentSpanId: payload.parentSpanId,
            name: payload.name,
            startTimeUnixNano: BigInt(payload.startTimeUnixNano),
            endTimeUnixNano: BigInt(payload.endTimeUnixNano),
            attributes: payload.attributes,
            error: payload.error,
            kind: payload.kind,
            ...(payload.links?.length ? { links: payload.links } : {})
          });
        },
        callDuringReplay: false
      }
    }
  };
}
