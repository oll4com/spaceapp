import { allowlistSpanAttributes } from "./tracing/span-attributes.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { categorizeFailureCode } from "@space/contracts";
import { otlpSpanExporterFromEnv, otlpTracesUrl, type ServerSpan, type SpanExporter } from "@space/runtime";
import type { InjectedSinks, WorkerOptions } from "@temporalio/worker";
import type { WorkflowInfo } from "@temporalio/workflow";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import type { SpaceTracingSinks, WorkflowSpanRecord } from "./workflow-tracing-interceptors.js";

/**
 * Worker-process half of OTLP span export. With SPACE_OTEL_EXPORTER_OTLP_ENDPOINT
 * unset, `workerTracing` returns null and Worker.create gets exactly the options
 * it had before: no workflow interceptor module, no sinks, no exporter timer.
 */

const CLOSE_TIMEOUT_MS = 2_000;

export interface WorkerTracing {
  exporter: SpanExporter;
  spans: SpanExporter;
  workflowModules: string[];
  sinks: InjectedSinks<SpaceTracingSinks>;
  /** Flushes queued spans, capped so a stuck collector never holds up shutdown. */
  close(): Promise<void>;
}

/** The workflow interceptor module next to this file (`.js` when built, `.ts` under vitest). */
export function workflowTracingModulePath(): string {
  const built = fileURLToPath(new URL("./workflow-tracing-interceptors.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("./workflow-tracing-interceptors.ts", import.meta.url));
}

/** The OTLP span for a finished workflow run; attributes pass the allowlist. */
export function toWorkflowSpan(info: Pick<WorkflowInfo, "workflowId" | "runId" | "workflowType" | "taskQueue"> & Partial<Pick<WorkflowInfo, "memo" | "parent">>, record: WorkflowSpanRecord): ServerSpan {
  const startTimeMs = Math.max(0, Math.floor(record.startTimeMs));
  const endTimeMs = Math.max(startTimeMs, Math.floor(record.endTimeMs));
  const category = record.outcome === "FAILED"
    ? categorizeFailureCode(record.errorCode)
    : record.outcome === "CANCELLED" ? "CANCELLED" : null;
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    parentSpanId: record.parentSpanId,
    name: `workflow ${info.workflowType}`,
    kind: 1,
    startTimeUnixNano: BigInt(startTimeMs) * 1_000_000n,
    endTimeUnixNano: BigInt(endTimeMs) * 1_000_000n,
    attributes: allowlistSpanAttributes({
      "temporal.workflow.id": info.workflowId,
      "temporal.workflow.run_id": info.runId,
      "temporal.workflow.type": info.workflowType,
      "space.outcome": record.outcome,
      "error.code": record.errorCode,
      "space.error.category": category,
      "space.duration_ms": endTimeMs - startTimeMs,
      "space.trace_id": record.correlation.spaceTraceId ?? info.memo?.spaceTraceId,
      "space.room_id": record.correlation.roomId,
      "space.pane_id": record.correlation.paneId,
      "space.mission_id": record.correlation.missionId ?? info.memo?.missionId,
    }),
    links: record.links.map(link => ({ traceId: link.traceId, spanId: link.spanId, attributes: allowlistSpanAttributes({ "space.link.kind": link.reason }) })),
    error: record.outcome === "FAILED"
  };
}

/** The `spaceTracing` sink: never called during replay, never throws into the worker. */
export function spaceTracingSinks(spans: SpanExporter): InjectedSinks<SpaceTracingSinks> {
  return {
    spaceTracing: {
      workflowSpan: {
        fn: (info, record) => {
          try {
            spans.record(toWorkflowSpan(info, record));
          } catch {
            // Tracing is best effort.
          }
        },
        callDuringReplay: false
      }
    }
  };
}

function tracingForExporter(spans: SpanExporter): WorkerTracing {
  return {
    exporter: spans,
    spans,
    workflowModules: [workflowTracingModulePath()],
    sinks: spaceTracingSinks(spans),
    async close() {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        spans.close().catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); })
      ]);
      clearTimeout(timer);
    }
  };
}

/** Tracing for a worker process, or null when SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is unset or invalid. */
export function createWorkerTracing(spans: SpanExporter): WorkerTracing;
export function createWorkerTracing(env: NodeJS.ProcessEnv, serviceName: string, options?: { exporter?: SpanExporter }): WorkerTracing | null;
export function createWorkerTracing(input: SpanExporter | NodeJS.ProcessEnv, serviceName?: string, options?: { exporter?: SpanExporter }): WorkerTracing | null {
  if (serviceName === undefined) return tracingForExporter(input as SpanExporter);
  const env = input as NodeJS.ProcessEnv;
  if (!otlpTracesUrl(env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT)) return null;
  const spans = options?.exporter ?? otlpSpanExporterFromEnv(env, serviceName);
  return spans ? tracingForExporter(spans) : null;
}

export const workerTracing = (env: NodeJS.ProcessEnv, serviceName: string): WorkerTracing | null => createWorkerTracing(env, serviceName);

/** Worker.create options for observability: activity records always, workflow spans only with tracing. */
export function workerObservabilityOptions(tracing: WorkerTracing | null): Pick<WorkerOptions, "interceptors" | "sinks"> {
  const activity = [createActivityObservabilityInterceptors({ spans: tracing?.spans ?? null })];
  if (!tracing) return { interceptors: { activity } };
  return { interceptors: { activity, workflowModules: tracing.workflowModules }, sinks: tracing.sinks };
}
