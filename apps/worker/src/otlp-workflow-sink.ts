import type { InjectedSinks } from "@temporalio/worker";
import type { Sinks, Sink } from "@temporalio/workflow";
import type { SpanExporter, OtlpSpan } from "@space/runtime";

/**
 * Payload passed from the workflow sandbox through the Temporal sink to the worker process.
 * Primitives only (strings, numbers, booleans, arrays, records) as required by Structured Clone.
 */
export interface OtlpWorkflowSpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: Array<{
    traceId: string;
    spanId: string;
    attributes?: Record<string, string | number>;
  }>;
}

export interface OtlpWorkflowSink extends Sink {
  exportSpan(span: OtlpWorkflowSpanPayload): void;
}

export interface OtlpWorkflowSinks extends Sinks {
  otlpExport: OtlpWorkflowSink;
}

/**
 * Creates Temporal worker sinks for OTLP workflow span export.
 * `callDuringReplay: false` guarantees that Temporal will NEVER invoke the sink
 * during history replay, ensuring determinism and zero duplicate spans.
 */
export function createOtlpWorkflowSinks(spanExporter: SpanExporter | null): InjectedSinks<OtlpWorkflowSinks> {
  return {
    otlpExport: {
      exportSpan: {
        fn: (_info, payload: OtlpWorkflowSpanPayload) => {
          if (!spanExporter) return;
          try {
            const span: OtlpSpan = {
              traceId: payload.traceId,
              spanId: payload.spanId,
              parentSpanId: payload.parentSpanId,
              name: payload.name,
              kind: payload.kind ?? 1,
              startTimeUnixNano: BigInt(payload.startTimeUnixNano),
              endTimeUnixNano: BigInt(payload.endTimeUnixNano),
              attributes: payload.attributes,
              error: payload.error,
              links: payload.links
            };
            spanExporter.record(span);
          } catch {
            // Span export is best effort; exceptions must never propagate to worker logic.
          }
        },
        callDuringReplay: false
      }
    }
  };
}
