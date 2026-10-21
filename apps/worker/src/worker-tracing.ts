import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import { categorizeFailureCode, parseTraceparent, workflowTraceSpanId, type WorkflowTraceReference } from "@space/contracts";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { observeActivityExecution } from "./activity-observability.js";
import { activityWorkflowTrace, activitySpanTrace } from "./activity-trace-context.js";
import { inputTrace, readTraceCarrier, traceCorrelationAttributes, WORKFLOW_TRACE_HEADER } from "./workflow-trace-context.js";
import type { WorkflowTracingSinks } from "./workflow-tracing.js";
import type { InjectedSinks } from "@temporalio/worker";

const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const idKeys = new Set(["temporal.workflow_id", "temporal.run_id", "temporal.workflow_type", "temporal.activity_type", "temporal.activity_id",
  "space.room_id", "space.pane_id", "space.mission_id", "space.trace_id"]);
const outcomes = new Set(["COMPLETED", "FAILED", "FAILED_RESULT", "CANCELLED", "CONTINUED_AS_NEW"]);

/** An explicit final boundary: never serialize arbitrary inputs or error text. */
export function allowlistedTraceAttributes(values: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (idKeys.has(key) && typeof value === "string" && identifier.test(value)) result[key] = value;
    if ((key === "temporal.attempt" || key === "space.duration_ms") && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
    if (key === "space.outcome" && typeof value === "string" && outcomes.has(value)) result[key] = value;
    if (key === "space.reason_code" && typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/.test(value)) {
      result[key] = value;
      result["space.category"] = categorizeFailureCode(value);
    }
  }
  return result;
}

function record(exporter: SpanExporter | null, span: ServerSpan) {
  // Export failures must never change workflow or activity results.
  try { exporter?.record({ ...span, attributes: allowlistedTraceAttributes(span.attributes) }); } catch { /* best effort */ }
}

export function workerTracingOptions(exporter: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const sinks: InjectedSinks<WorkflowTracingSinks> = {
    spaceTracing: { record: {
      callDuringReplay: false,
      fn(info, event) {
        record(exporter, {
          traceId: event.traceId, spanId: event.spanId, parentSpanId: event.parentSpanId,
          name: "temporal.workflow", kind: 1,
          startTimeUnixNano: BigInt(event.startedAt) * 1_000_000n,
          endTimeUnixNano: BigInt(event.endedAt) * 1_000_000n,
          links: event.links,
          error: event.outcome === "FAILED",
          attributes: { ...event.correlation, "temporal.workflow_id": info.workflowId, "temporal.run_id": info.runId,
            "temporal.workflow_type": info.workflowType, "space.outcome": event.outcome,
            "space.duration_ms": Math.max(0, event.endedAt - event.startedAt) }
        });
      }
    } }
  };
  return {
    sinks,
    interceptors: {
      workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))],
      activity: [(context) => ({ inbound: {
        execute(input, next) {
          const carrier = readTraceCarrier(input.headers);
          // Preserve activity-only visibility for workflows from before tracing.
          // An invalid explicit carrier must not fall back to input contents.
          const parsed = parseTraceparent(carrier?.traceparent ??
            (WORKFLOW_TRACE_HEADER in input.headers ? undefined : inputTrace(input.args).traceparent));
          const parent: WorkflowTraceReference | undefined = parsed ? { traceId: parsed.traceId, spanId: parsed.parentId } : undefined;
          const execution = context.info.workflowExecution;
          const spanId = execution ? workflowTraceSpanId(`activity:${execution.runId}:${context.info.activityId}:${context.info.attempt}`) : null;
          const self = parent && spanId ? { traceId: parent.traceId, spanId } : undefined;
          return activityWorkflowTrace.run(parent, () => activitySpanTrace.run(self, () => observeActivityExecution(context.info, input.args, () => next(input), {
            cancelled: () => context.cancellationSignal.aborted,
            onFinish(event) {
              if (!parent) return;
              const info = context.info;
              const execution = info.workflowExecution;
              if (!execution || !spanId) return;
              record(exporter, { traceId: parent.traceId,
                spanId,
                parentSpanId: parent.spanId, name: "temporal.activity", kind: 1,
                startTimeUnixNano: BigInt(event.startedAt) * 1_000_000n,
                endTimeUnixNano: BigInt(event.startedAt + event.durationMs) * 1_000_000n,
                attributes: { ...traceCorrelationAttributes(input.args), "temporal.workflow_id": execution.workflowId, "temporal.run_id": execution.runId,
                  ...(info.workflowType ? { "temporal.workflow_type": info.workflowType } : {}), "temporal.activity_type": info.activityType,
                  "temporal.activity_id": info.activityId, "temporal.attempt": info.attempt,
                  "space.outcome": event.outcome, "space.duration_ms": event.durationMs,
                  ...(event.reasonCode ? { "space.reason_code": event.reasonCode } : {}) },
                error: event.outcome === "FAILED" || event.outcome === "FAILED_RESULT" });
            }
          })));
        }
      } })]
    }
  };
}
