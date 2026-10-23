import type { InjectedSinks } from "@temporalio/worker";
import type { Sink, Sinks } from "@temporalio/workflow";
import type { OtlpSpanLink, SpanExporter } from "@space/runtime";
import { allowlistSpanAttributes } from "./otlp-attributes.js";

/**
 * Payload emitted from the workflow interceptor inside the Temporal sandbox
 * to the worker sink outside the sandbox.
 */
export interface OtlpWorkflowSpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  error: boolean;
  attributes: Record<string, string | number>;
  links?: OtlpSpanLink[];
}

export interface OtlpWorkflowSink extends Sink {
  exportSpan(payload: OtlpWorkflowSpanPayload): void;
}

export interface OtlpWorkflowSinks extends Sinks {
  otlpExport: OtlpWorkflowSink;
}

/**
 * Creates Temporal worker sinks for workflow OTLP span export.
 *
 * Replay safety: `callDuringReplay: false` guarantees that replaying existing
 * or new workflow histories never calls the sink and never emits duplicate spans.
 */
export function createOtlpWorkflowSinks(
  exporter: SpanExporter | null | undefined,
  now: () => number = Date.now
): InjectedSinks<OtlpWorkflowSinks> {
  return {
    otlpExport: {
      exportSpan: {
        fn(_workflowInfo, payload: OtlpWorkflowSpanPayload) {
          if (!exporter) return;
          try {
            const startNs = BigInt(Math.max(0, Math.round(payload.startTimeMs))) * 1_000_000n;
            const realNowMs = now();
            const effectiveEndMs = Math.max(payload.startTimeMs, realNowMs);
            const endNs = BigInt(Math.max(0, Math.round(effectiveEndMs))) * 1_000_000n;
            const realDurationMs = Math.max(0, Math.round(effectiveEndMs - payload.startTimeMs));
            const mergedAttributes = {
              ...payload.attributes,
              "space.duration_ms": realDurationMs
            };
            const sanitizedLinks = payload.links
              ?.filter(link => link && typeof link.traceId === "string" && typeof link.spanId === "string")
              .map(link => ({
                traceId: link.traceId,
                spanId: link.spanId,
                ...(link.attributes ? { attributes: allowlistSpanAttributes(link.attributes) } : {})
              }));
            exporter.record({
              traceId: payload.traceId,
              spanId: payload.spanId,
              parentSpanId: payload.parentSpanId,
              name: payload.name,
              kind: 1, // SPAN_KIND_INTERNAL
              startTimeUnixNano: startNs,
              endTimeUnixNano: endNs >= startNs ? endNs : startNs,
              attributes: allowlistSpanAttributes(mergedAttributes),
              error: payload.error,
              ...(sanitizedLinks && sanitizedLinks.length > 0 ? { links: sanitizedLinks } : {})
            });
          } catch {
            // Best-effort: exporter errors must never disrupt workflow execution.
          }
        },
        callDuringReplay: false
      }
    }
  };
}
