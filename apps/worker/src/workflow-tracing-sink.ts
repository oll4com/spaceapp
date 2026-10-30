import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import {
  safeWorkflowIdentifier,
  workflowCorrelation,
  type WorkflowTracingSinks
} from "./workflow-tracing-context.js";

/** A sink only enqueues; HTTP export remains outside the workflow task path. */
export function createWorkflowTraceSinks(spans: SpanExporter | null | undefined): InjectedSinks<WorkflowTracingSinks> | undefined {
  if (!spans) return undefined;
  return {
    spaceTracing: {
      record: {
        callDuringReplay: false,
        fn(info, span) {
          if (!["COMPLETED", "FAILED", "CANCELLED", "CONTINUED"].includes(span.outcome)) return;
          const workflowType = safeWorkflowIdentifier(info.workflowType) ?? "unknown";
          const attributes: Record<string, string | number> = { "space.workflow_type": workflowType, "space.outcome": span.outcome };
          for (const [key, value] of Object.entries({
            workflowId: info.workflowId, runId: info.runId, ...workflowCorrelation([span.correlation])
          })) {
            const safe = safeWorkflowIdentifier(value);
            if (safe) attributes[`space.${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`] = safe;
          }
          if (!Number.isFinite(span.startedAtMs) || !Number.isFinite(span.endedAtMs)) return;
          try {
            spans.record({
              traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
              name: `workflow ${workflowType}`, kind: 1,
              startTimeUnixNano: BigInt(Math.trunc(span.startedAtMs)) * 1_000_000n,
              endTimeUnixNano: BigInt(Math.trunc(Math.max(span.startedAtMs, span.endedAtMs))) * 1_000_000n,
              attributes, error: span.outcome === "FAILED", links: span.links
            });
          } catch { /* Best-effort tracing must not fail a workflow task. */ }
        }
      }
    }
  };
}
