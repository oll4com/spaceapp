import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import { activityCorrelation, createActivityObservabilityInterceptors, observeActivityExecution } from "./activity-observability.js";
import {
  readTraceHeader, temporalAttributes, traceIdentifier, workflowTraceContext
} from "./temporal-trace-context.js";
import type { TelemetrySinks } from "./workflow-telemetry.js";
import type { InjectedSinks } from "@temporalio/worker";

const nanos = (milliseconds: number) => BigInt(Math.trunc(milliseconds * 1e3)) * 1_000n;
function spanId(): string {
  for (;;) { const id = randomBytes(8).toString("hex"); if (!/^0+$/.test(id)) return id; }
}

/** Host-only exporter and interceptors, shared by all three worker entrypoints. */
export function createWorkerTelemetry(options: {
  serviceName: "space-worker" | "space-memory-maintenance-worker" | "space-memory-mutation-worker";
  env?: NodeJS.ProcessEnv;
  exporter?: SpanExporter | null;
}) {
  const exporter = options.exporter === undefined
    ? otlpSpanExporterFromEnv(options.env ?? process.env, options.serviceName)
    : options.exporter;
  const sinks: InjectedSinks<TelemetrySinks> = {
    spaceTelemetry: { record: {
      callDuringReplay: false,
      fn(info, record) {
        if (!exporter) return;
        const { context } = record;
        const name = traceIdentifier(info.workflowType) ?? "unknown";
        exporter.record({
          traceId: context.traceId, spanId: context.spanId, parentSpanId: context.parentSpanId,
          name: `workflow.${name}`, kind: 1, links: context.links,
          startTimeUnixNano: nanos(record.startTimeMs), endTimeUnixNano: nanos(record.endTimeMs),
          error: record.outcome === "FAILED",
          attributes: temporalAttributes({
            ...record.attributes, "temporal.workflow_id": info.workflowId, "temporal.run_id": info.runId,
            "temporal.workflow_type": name, "space.outcome": record.outcome,
            duration_ms: Math.max(0, record.endTimeMs - record.startTimeMs)
          })
        });
      }
    } }
  };
  const workerOptions: Pick<WorkerOptions, "interceptors" | "sinks"> = exporter ? {
    sinks,
    interceptors: {
      workflowModules: [fileURLToPath(new URL("./workflow-telemetry.js", import.meta.url))],
      activity: [(context) => ({ inbound: { execute(input, next) {
        const info = context.info;
        const run = info.workflowExecution;
        const parent = readTraceHeader(input.headers);
        const propagated = parseTraceparent(parent?.traceparent);
        const fallback = run ? workflowTraceContext(run.runId) : null;
        const traceId = propagated?.traceId ?? fallback?.traceId;
        const parentSpanId = propagated?.parentId ?? fallback?.spanId;
        const correlation = activityCorrelation(input.args);
        const id = spanId();
        return observeActivityExecution(info, input.args, () => next(input), {
          cancelled: () => context.cancellationSignal.aborted,
          traceparent: traceId ? formatTraceparent(traceId, id, "01") : undefined,
          onFinish(observation) {
            if (!traceId || !parentSpanId) return;
            exporter.record({
              traceId, spanId: id, parentSpanId,
              name: `activity.${traceIdentifier(info.activityType) ?? "unknown"}`, kind: 1,
              startTimeUnixNano: nanos(observation.startTimeMs), endTimeUnixNano: nanos(observation.endTimeMs),
              error: observation.outcome === "FAILED" || observation.outcome === "FAILED_RESULT",
              attributes: temporalAttributes({
                "temporal.workflow_id": run?.workflowId, "temporal.run_id": run?.runId,
                "temporal.workflow_type": info.workflowType, "temporal.activity_type": info.activityType,
                "temporal.activity_id": info.activityId, "temporal.attempt": info.attempt,
                "space.trace_id": correlation.traceId, "space.room_id": correlation.roomId,
                "space.pane_id": correlation.paneId, "space.mission_id": correlation.missionId,
                "space.goal_id": correlation.goalId, "space.outcome": observation.outcome,
                "space.reason_code": observation.reasonCode, "space.category": observation.category,
                duration_ms: observation.durationMs
              })
            });
          }
        });
      } } })]
    }
  } : { interceptors: { activity: [createActivityObservabilityInterceptors()] } };
  return {
    workerOptions,
    sinks,
    stats: () => exporter?.stats() ?? { exported: 0, dropped: 0, failed: 0 },
    flush: async () => { await exporter?.flush(); },
    close: async () => { await exporter?.close(); }
  };
}
