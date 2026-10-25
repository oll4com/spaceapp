import { fileURLToPath } from "node:url";
import { categorizeFailureCode, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import type { SpanExporter } from "@space/runtime";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import type { WorkflowTraceSinks } from "./workflow-tracing.js";
import { safeIdentifier } from "./trace-propagation.js";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";

export function workflowTraceSinks(spans: SpanExporter): InjectedSinks<WorkflowTraceSinks> {
  return { spaceTracing: { finish: {
    callDuringReplay: false,
    fn(info, record) {
      const context = parseTraceparent(record.traceparent);
      if (!context) return;
      const parent = parseTraceparent(record.parentTraceparent);
      const previous = parseTraceparent(record.previousTraceparent);
      const attributes: Record<string, string | number> = {
        "space.workflow_type": safeIdentifier(info.workflowType) ?? "unknown",
        "space.workflow_id": safeIdentifier(info.workflowId) ?? "unknown",
        "space.temporal_run_id": safeIdentifier(info.runId) ?? "unknown",
        "space.outcome": record.outcome,
        "space.duration_ms": Math.max(0, record.finishedAt - record.startedAt)
      };
      // Re-apply the allowlist at the isolate/Node boundary.
      for (const key of ["traceId", "requestId", "roomId", "paneId", "missionId", "roomAgentMissionId",
        "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"]) {
        const value = safeIdentifier(record.identifiers[key]);
        if (value) attributes[`space.${key}`] = value;
      }
      if (isSafeErrorCode(record.reasonCode)) {
        attributes["space.reason_code"] = record.reasonCode;
        attributes["space.failure_category"] = categorizeFailureCode(record.reasonCode);
      }
      // The sink only queues a bounded best-effort export. Never await HTTP in
      // a workflow task and never let instrumentation change its outcome.
      try {
        spans.record({
          traceId: context.traceId, spanId: context.parentId,
          parentSpanId: parent?.traceId === context.traceId ? parent.parentId : null,
          name: `workflow ${attributes["space.workflow_type"]}`, kind: 1,
          startTimeUnixNano: BigInt(record.startedAt) * 1_000_000n,
          endTimeUnixNano: BigInt(Math.max(record.startedAt, record.finishedAt)) * 1_000_000n,
          attributes, error: record.outcome === "FAILED" || record.outcome === "FAILED_RESULT",
          ...(previous ? { links: [{ traceId: previous.traceId, spanId: previous.parentId }] } : {})
        });
      } catch { /* Observability must not change workflow execution. */ }
    }
  } } };
}

/** Same opt-in wiring for the turn, memory-maintenance and mutation workers. */
export function workerTracingOptions(spans: SpanExporter | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  return {
    interceptors: {
      activity: [createActivityObservabilityInterceptors({ spans })],
      ...(spans ? { workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))] } : {})
    },
    ...(spans ? { sinks: workflowTraceSinks(spans) } : {})
  };
}
