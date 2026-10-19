import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import { isSafeErrorCode } from "@space/contracts";
import type { WorkflowTraceSinks } from "./workflow-trace-context.js";

const allowedKeys = new Set(["space.traceId", "space.roomId", "space.paneId", "space.missionId", "space.roomAgentMissionId",
  "space.agentRunId", "space.goalId", "space.dotId", "space.turnId", "space.workflow_type", "space.workflow_id", "space.run_id",
  "space.status", "space.reason_code", "space.category", "space.activity_type", "space.activity_id", "space.outcome", "space.attempt", "space.duration_ms"]);
export function workerSpanAttributes(input: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => allowedKeys.has(key) &&
    (typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value)) &&
    (key !== "space.reason_code" || isSafeErrorCode(value)))) as Record<string, string | number>;
}
export function workflowTracingOptions(exporter: SpanExporter | null) {
  if (!exporter) return {};
  const sinks: InjectedSinks<WorkflowTraceSinks> = { spaceTrace: { record: { callDuringReplay: false,
    fn(_info, span) {
      try {
        const attributes = workerSpanAttributes(span.attributes);
        exporter.record({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
          name: `workflow ${attributes["space.workflow_type"] ?? "unknown"}`, kind: 1,
          startTimeUnixNano: BigInt(Math.floor(span.startedAt)) * 1_000_000n,
          endTimeUnixNano: BigInt(Math.floor(span.endedAt)) * 1_000_000n, attributes, error: span.error, links: span.links });
      } catch { /* Telemetry must never change workflow execution. */ }
    }
  } } };
  return { sinks, workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))] };
}
