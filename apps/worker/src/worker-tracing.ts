import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";
import { createOtlpSpanExporter, otlpTracesUrl, type OtlpSpanExporterOptions, type ServerSpan } from "@space/observability";
import { activityCorrelation, createActivityObservabilityInterceptors, observeActivityExecution } from "./activity-observability.js";
import { runWithActivityTraceContext } from "./activity-trace-context.js";
import { findTraceContext, readTraceHeader, sanitizeTraceAttributes, workflowSpanId, workflowTraceId, type WorkflowTraceSpan } from "./tracing-protocol.js";

type TracingWorkerOptions = Pick<WorkerOptions, "interceptors" | "sinks">;
export interface WorkerTracingOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit source module path for tests; production uses its built JS file. */
  workflowModule?: string;
  exporter?: Omit<OtlpSpanExporterOptions, "endpoint" | "serviceName">;
}

function activitySpanId(): string {
  let id: string;
  do { id = randomBytes(8).toString("hex"); } while (/^0+$/.test(id));
  return id;
}

function safeWorkflowSpan(span: WorkflowTraceSpan): ServerSpan | null {
  if (!Number.isFinite(span.startTimeMs) || !Number.isFinite(span.endTimeMs)) return null;
  return {
    traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
    // Workflow/activity types are deployment-owned symbols, not arbitrary names.
    name: /^workflow\.[A-Za-z0-9_.-]{1,160}$/.test(span.name) ? span.name : "workflow.unknown",
    kind: 1,
    startTimeUnixNano: BigInt(Math.max(0, Math.trunc(span.startTimeMs))) * 1_000_000n,
    endTimeUnixNano: BigInt(Math.max(span.startTimeMs, Math.trunc(span.endTimeMs))) * 1_000_000n,
    attributes: sanitizeTraceAttributes(span.attributes), error: span.error === true,
    links: span.links
  };
}

/** Shared by all three worker processes. No collector work is awaited by an activity or workflow. */
export function createWorkerTracing(serviceName: string, options: WorkerTracingOptions = {}) {
  const endpoint = (options.env ?? process.env).SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpTracesUrl(endpoint)) {
    return {
      enabled: false,
      workerOptions: { interceptors: { activity: [createActivityObservabilityInterceptors()] } } satisfies TracingWorkerOptions,
      flush: async () => {}, close: async () => {},
      stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };
  }
  const exporter = createOtlpSpanExporter({ endpoint: endpoint!, serviceName, scopeName: "space-worker", ...options.exporter });
  const workerOptions: TracingWorkerOptions = {
    sinks: {
      tracing: {
        record: {
          callDuringReplay: false,
          fn: (_info, span: WorkflowTraceSpan) => {
            try { const safe = safeWorkflowSpan(span); if (safe) exporter.record(safe); } catch { /* best effort */ }
          }
        }
      }
    },
    interceptors: {
      workflowModules: [options.workflowModule ?? fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))],
      activity: [(context) => ({
        inbound: {
          execute: (input, next) => {
            const execution = context.info.workflowExecution;
            // Standalone activities have no workflow parent to invent.
            if (!execution) return observeActivityExecution(context.info, input.args, () => next(input), {
              cancelled: () => context.cancellationSignal.aborted
            });
            const legacyContext = findTraceContext(input.args);
            const parent = readTraceHeader(input.headers)?.context ?? {
              traceId: legacyContext?.traceId ?? workflowTraceId(execution.runId),
              spanId: workflowSpanId(execution.runId), flags: legacyContext?.flags ?? "01"
            };
            const spanId = activitySpanId();
            return runWithActivityTraceContext(parent, () => observeActivityExecution(context.info, input.args, () => next(input), {
              cancelled: () => context.cancellationSignal.aborted,
              onFinished: (observation) => {
                const correlation = activityCorrelation(input.args);
                exporter.record({
                  traceId: parent.traceId, spanId, parentSpanId: parent.spanId,
                  name: `activity.${/^[A-Za-z0-9_.-]{1,160}$/.test(context.info.activityType) ? context.info.activityType : "unknown"}`,
                  kind: 1,
                  startTimeUnixNano: BigInt(observation.startedAt) * 1_000_000n,
                  endTimeUnixNano: BigInt(Math.max(observation.startedAt, observation.finishedAt)) * 1_000_000n,
                  attributes: sanitizeTraceAttributes({
                    "temporal.workflow.type": context.info.workflowType,
                    "temporal.workflow.id": execution.workflowId,
                    "temporal.run.id": execution.runId,
                    "temporal.activity.type": context.info.activityType,
                    "temporal.activity.id": context.info.activityId,
                    "temporal.activity.attempt": context.info.attempt,
                    "space.outcome": observation.outcome,
                    "space.reason_code": observation.reasonCode,
                    "space.failure_category": observation.category,
                    "space.room_id": correlation.roomId,
                    "space.pane_id": correlation.paneId,
                    "space.mission_id": correlation.missionId
                  }),
                  error: observation.outcome !== "COMPLETED"
                });
              }
            }));
          }
        }
      })]
    }
  };
  return { enabled: true, workerOptions, flush: () => exporter.flush(), close: () => exporter.close(), stats: () => exporter.stats() };
}
