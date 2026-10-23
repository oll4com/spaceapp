import type { InjectedSinks } from "@temporalio/worker";
import type { Sinks, Sink, WorkflowInfo } from "@temporalio/workflow";
import type { SpanExporter, ServerSpan } from "@space/runtime";

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
  endTimeUnixNano?: string;
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
 *
 * Real end-time timestamping and duration calculations are performed here
 * in the worker process (outside the sandbox) to avoid Temporal workflow-task clock drift.
 */
export function createOtlpWorkflowSinks(spanExporter: SpanExporter | null): InjectedSinks<OtlpWorkflowSinks> {
  return {
    otlpExport: {
      exportSpan: {
        fn: (_info: WorkflowInfo, payload: OtlpWorkflowSpanPayload) => {
          if (!spanExporter) return;
          try {
            const nowNano = BigInt(Date.now()) * 1_000_000n;
            const startTimeUnixNano = BigInt(payload.startTimeUnixNano);
            const rawEnd = payload.endTimeUnixNano ? BigInt(payload.endTimeUnixNano) : nowNano;
            const endTimeUnixNano = rawEnd >= startTimeUnixNano ? rawEnd : startTimeUnixNano;
            const durationMs = Math.max(0, Number((endTimeUnixNano - startTimeUnixNano) / 1_000_000n));
            const attributes = {
              ...payload.attributes,
              "space.duration_ms": durationMs
            };
            const span: ServerSpan = {
              traceId: payload.traceId,
              spanId: payload.spanId,
              parentSpanId: payload.parentSpanId,
              name: payload.name,
              kind: payload.kind ?? 1,
              startTimeUnixNano,
              endTimeUnixNano,
              attributes,
              error: payload.error,
              links: payload.links?.map(link => ({
                traceId: link.traceId,
                spanId: link.spanId,
                attributes: link.attributes
              }))
            };
            spanExporter.record(span);
          } catch {
            // Exporter guarantees safe dropping without disrupting workers
          }
        },
        callDuringReplay: false
      }
    }
  };
}
