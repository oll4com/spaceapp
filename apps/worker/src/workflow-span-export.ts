import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import { failureCategorySchema, isSafeErrorCode } from "@space/contracts";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import type { WorkflowSpanSinks } from "./workflow-observability-interceptors.js";
import { validHexId, validSpanContext } from "./workflow-span-context.js";

const idKeys = new Set(["space.workflow_id", "space.run_id", "space.activity_id", "space.trace_id", "space.room_id", "space.pane_id", "space.mission_id"]);
const typeKeys = new Set(["space.workflow_type", "space.activity_type"]);
const outcomes = new Set(["COMPLETED", "FAILED", "FAILED_RESULT", "CANCELLED", "CONTINUED_AS_NEW"]);

export function safeSpanType(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value) ? value : "unknown";
}

/** Shared boundary for workflow AND activity attributes. No user-text fallback. */
export function allowlistedWorkerSpanAttributes(values: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (idKeys.has(key) && typeof value === "string" && /^[A-Za-z0-9:._-]{1,240}$/.test(value)) result[key] = value;
    else if (typeKeys.has(key) && safeSpanType(value) !== "unknown") result[key] = value as string;
    else if (key === "space.outcome" && typeof value === "string" && outcomes.has(value)) result[key] = value;
    else if (key === "space.reason_code" && isSafeErrorCode(value)) result[key] = value;
    else if (key === "space.category" && failureCategorySchema.safeParse(value).success) result[key] = value as string;
    else if ((key === "space.attempt" || key === "space.duration_ms") && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return result;
}

/** Instrumentation failure must never change an activity's result. */
export function recordWorkerSpan(exporter: SpanExporter, span: ServerSpan): void {
  try { exporter.record({ ...span, attributes: allowlistedWorkerSpanAttributes(span.attributes) }); }
  catch { /* Best-effort telemetry, independent of task execution. */ }
}

export function workflowSpanSinks(exporter: SpanExporter | null): InjectedSinks<WorkflowSpanSinks> | undefined {
  if (!exporter) return undefined;
  return {
    workerTracing: {
      finish: {
        callDuringReplay: false,
        fn(info, report) {
          try {
            if (!validSpanContext(report.context) || !Number.isSafeInteger(report.startedAt) || !Number.isSafeInteger(report.finishedAt)
              || report.startedAt < 0 || report.finishedAt < report.startedAt) return;
            const durationMs = report.finishedAt - report.startedAt;
            recordWorkerSpan(exporter, {
              ...report.context,
              parentSpanId: validHexId(report.parentSpanId, 16) ? report.parentSpanId : null,
              links: report.links.filter(validSpanContext).slice(0, 8).map(({ traceId, spanId }) => ({ traceId, spanId })),
              name: `workflow ${safeSpanType(info.workflowType)}`, kind: 1,
              startTimeUnixNano: BigInt(report.startedAt) * 1_000_000n,
              endTimeUnixNano: BigInt(report.finishedAt) * 1_000_000n,
              error: report.outcome === "FAILED",
              attributes: {
                ...report.attributes,
                "space.workflow_id": info.workflowId, "space.run_id": info.runId,
                "space.workflow_type": info.workflowType, "space.outcome": report.outcome,
                "space.duration_ms": durationMs,
                ...(report.reasonCode ? { "space.reason_code": report.reasonCode } : {})
              }
            });
          } catch { /* Sink errors must not affect workflow execution. */ }
        }
      }
    }
  };
}

/** All three worker entrypoints use precisely the same opt-in configuration. */
export function workflowSpanOptions(exporter: SpanExporter | null) {
  return exporter ? {
    workflowModules: [fileURLToPath(new URL("./workflow-observability-interceptors.js", import.meta.url))]
  } : {};
}
