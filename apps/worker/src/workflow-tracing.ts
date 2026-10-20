import { fileURLToPath } from "node:url";
import { categorizeFailureCode } from "@space/contracts";
import { spanAttributes, type SpanExporter } from "@space/runtime";
import type { InjectedSinks } from "@temporalio/worker";
import type { WorkflowTraceSinks } from "./workflow-trace-types.js";

/** One registration shared by all worker entry points; no workflow hook when disabled. */
export function workflowTracing(spans: SpanExporter | null, workflowModule = fileURLToPath(new URL("./workflow-observability.js", import.meta.url))): {
  workflowModules: string[];
  sinks?: InjectedSinks<WorkflowTraceSinks>;
} {
  if (!spans) return { workflowModules: [] };
  return {
    workflowModules: [workflowModule],
    sinks: { spaceOtel: { record: {
      callDuringReplay: false,
      fn(_info, span) {
        // Telemetry must not change workflow-task success, including bad DTOs.
        try {
          if (!Number.isSafeInteger(span.startTimeMs) || !Number.isSafeInteger(span.endTimeMs) || span.startTimeMs < 0 || span.endTimeMs < span.startTimeMs) return;
          const outcome = span.attributes["space.outcome"];
          const code = span.attributes["space.reason_code"];
          spans.record({
            traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
            name: span.name, kind: 1, error: span.error,
            startTimeUnixNano: BigInt(span.startTimeMs) * 1_000_000n,
            endTimeUnixNano: BigInt(span.endTimeMs) * 1_000_000n,
            attributes: spanAttributes({ ...span.attributes,
              ...(outcome === "CANCELLED" ? { "space.category": "CANCELLED" } : span.error ? { "space.category": categorizeFailureCode(typeof code === "string" ? code : null) } : {}) }),
            links: span.links
          });
        } catch { /* Best-effort export never fails a workflow task. */ }
      }
    } } }
  };
}
