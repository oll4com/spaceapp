import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import {
  sanitizeSpanAttributes,
  type OtlpSpanSinks,
  type WorkflowSpanPayload
} from "./otlp-span-context.js";

/**
 * Worker-process side of workflow span export. The sandbox interceptor hands
 * plain-data spans to this sink; the sink records them on the shared OTLP
 * exporter from @space/runtime.
 *
 * `callDuringReplay: false` is the determinism guarantee: when a history is
 * replayed, the Temporal SDK never invokes this function, so replaying emits
 * no duplicate spans. A null exporter (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT
 * unset) makes the sink a no-op.
 */
export function createOtlpSpanSinks(spanExporter: SpanExporter | null): InjectedSinks<OtlpSpanSinks> {
  return {
    otlp: {
      exportWorkflowSpan: {
        callDuringReplay: false,
        fn: (_info, span: WorkflowSpanPayload) => {
          spanExporter?.record({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: span.kind,
            startTimeUnixNano: BigInt(span.startTimeUnixNano),
            endTimeUnixNano: BigInt(span.endTimeUnixNano),
            attributes: sanitizeSpanAttributes(span.attributes),
            error: span.error,
            ...(span.links?.length ? { links: span.links } : {})
          });
        }
      }
    }
  };
}
