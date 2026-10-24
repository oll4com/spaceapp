import { fileURLToPath } from "node:url";
import { categorizeFailureCode, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import type { WorkflowInfo } from "@temporalio/workflow";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import {
  sanitizeWorkflowTraceAttributes,
  traceIdentifier,
  type WorkflowSpanRecord
} from "./temporal-trace-context.js";
import type { WorkflowTracingSinks } from "./workflow-tracing.js";

// OTLP timestamps are fixed64 nanoseconds: (2^64 - 1) ns, in whole milliseconds.
const MAX_OTLP_TIME_MS = 18_446_744_073_709;

function recordWorkflowSpan(spans: SpanExporter, info: WorkflowInfo, span: WorkflowSpanRecord): void {
  try {
    if (!["COMPLETED", "FAILED_RESULT", "FAILED", "CANCELLED", "CONTINUED_AS_NEW"].includes(span.outcome)) return;
    if (!parseTraceparent(`00-${span.traceId}-${span.spanId}-01`)) return;
    if (span.parentSpanId !== null && !parseTraceparent(`00-${span.traceId}-${span.parentSpanId}-01`)) return;
    if (!Number.isSafeInteger(span.startTimeMs) || span.startTimeMs < 0 || !Number.isSafeInteger(span.endTimeMs)) return;
    if (span.startTimeMs > MAX_OTLP_TIME_MS || span.endTimeMs > MAX_OTLP_TIME_MS) return;
    const endTimeMs = Math.max(span.startTimeMs, span.endTimeMs);
    const workflowType = traceIdentifier(info.workflowType) ?? "unknown";
    const attributes: Record<string, string | number> = {
      ...sanitizeWorkflowTraceAttributes(span.attributes),
      "space.workflow_type": workflowType,
      "space.outcome": span.outcome,
      "space.duration_ms": endTimeMs - span.startTimeMs
    };
    if (Number.isSafeInteger(info.attempt) && info.attempt >= 1) attributes["space.attempt"] = info.attempt;
    const workflowId = traceIdentifier(info.workflowId);
    const runId = traceIdentifier(info.runId);
    if (workflowId) attributes["space.workflow_id"] = workflowId;
    if (runId) attributes["space.temporal_run_id"] = runId;
    const operation = span.operation === "mission" || span.operation === "signal" || span.operation === "update" ? span.operation : null;
    if (operation) attributes["space.workflow_operation"] = operation;
    const error = span.outcome === "FAILED" || span.outcome === "FAILED_RESULT";
    if (isSafeErrorCode(span.reasonCode)) attributes["space.reason_code"] = span.reasonCode!;
    if (error || span.outcome === "CANCELLED") {
      attributes["space.failure_category"] = span.outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(span.reasonCode);
    }
    const links = (span.links ?? []).slice(0, 16).filter((link) => parseTraceparent(`00-${link.traceId}-${link.spanId}-01`));
    spans.record({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: `workflow ${workflowType}${operation ? ` ${operation}` : ""}`,
      startTimeUnixNano: BigInt(span.startTimeMs) * 1_000_000n,
      endTimeUnixNano: BigInt(endTimeMs) * 1_000_000n,
      kind: 1,
      attributes,
      error,
      ...(links.length ? { links } : {})
    });
  } catch {
    // The host sink never lets an exporter or malformed telemetry fail a workflow task.
  }
}

/**
 * Common tracing composition for every worker. The workflow sandbox only
 * copies span data into this host sink; the shared exporter owns all I/O.
 */
export function createWorkerTracing(
  spans: SpanExporter | null,
  options: { workflowInterceptorModule?: string } = {}
): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const activity = [createActivityObservabilityInterceptors({ spans })];
  if (!spans) return { interceptors: { activity } };
  const sinks: InjectedSinks<WorkflowTracingSinks> = {
    spaceTracing: {
      record: {
        fn: (info, span) => recordWorkflowSpan(spans, info, span),
        callDuringReplay: false
      }
    }
  };
  return {
    interceptors: {
      activity,
      workflowModules: [options.workflowInterceptorModule ?? fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))]
    },
    sinks
  };
}
