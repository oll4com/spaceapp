import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import { outcomeAttributes, workerSpanAttributes } from "./otlp-span-attributes.js";
import type { WorkflowTracingSinks } from "./workflow-tracing.js";

/**
 * Worker-side end of the workflow tracing sink. Temporal calls it outside the
 * sandbox, and never while a history is replayed (`callDuringReplay: false`),
 * so each workflow run is exported once, when it finishes, continues as new,
 * fails or is cancelled. Recording only queues the span; the bounded exporter
 * sends it in the background.
 */
export function createWorkflowTracingSinks(spans: SpanExporter, now: () => number = Date.now): InjectedSinks<WorkflowTracingSinks> {
  return {
    spaceTracing: {
      workflowRun: {
        callDuringReplay: false,
        /** Queues the finished workflow run's span; never throws into the workflow. */
        fn(info, span) {
          try {
            const startedAt = info.runStartTime.getTime();
            const endedAt = Math.max(startedAt, now());
            spans.record({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: `workflow ${info.workflowType}`,
              startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
              endTimeUnixNano: BigInt(endedAt) * 1_000_000n,
              attributes: workerSpanAttributes({
                ...span.correlation,
                "space.workflow_type": info.workflowType,
                "space.workflow_id": info.workflowId,
                "space.run_id": info.runId,
                "space.task_queue": info.taskQueue,
                "space.parent_workflow_id": info.parent?.workflowId,
                "space.attempt": info.attempt,
                ...outcomeAttributes(span.outcome, span.reasonCode)
              }),
              error: span.outcome === "FAILED",
              kind: 1,
              ...(span.links.length
                ? { links: span.links.map((link) => ({ traceId: link.traceId, spanId: link.spanId, attributes: workerSpanAttributes({ "space.link": link.reason }) })) }
                : {})
            });
          } catch {
            // Span export is best effort and never affects the workflow.
          }
        }
      }
    }
  };
}
