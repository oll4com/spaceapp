import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ActivityInterceptorsFactory, InjectedSinks } from "@temporalio/worker";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { observeActivityExecution } from "./activity-observability.js";
import {
  parentFromArgs, readTraceHeader, safeTraceAttributes,
  type TraceContext, type TraceRecord, type TraceReference, traceReference
} from "./tracing-protocol.js";
import type { TraceSinks } from "./workflow-tracing.js";
import { activityTraceContext } from "./activity-trace-context.js";

function record(exporter: SpanExporter | null, span: TraceRecord): void {
  if (!exporter || !traceReference(span) || !Number.isFinite(span.startedAt) || !Number.isFinite(span.endedAt)) return;
  try {
    exporter.record({ traceId: span.traceId, spanId: span.spanId,
      parentSpanId: span.parentSpanId, name: span.name,
      startTimeUnixNano: BigInt(Math.trunc(span.startedAt)) * 1_000_000n,
      endTimeUnixNano: BigInt(Math.trunc(Math.max(span.startedAt, span.endedAt))) * 1_000_000n,
      attributes: safeTraceAttributes(span.attributes), error: span.error, kind: 1,
      links: span.links?.map(traceReference).filter((x): x is TraceReference => x !== null)
    });
  } catch { /* Trace delivery never changes business results. */ }
}

export function createWorkerTracing(env: NodeJS.ProcessEnv, service: string, exporter = otlpSpanExporterFromEnv(env, service)) {
  const activity: ActivityInterceptorsFactory = context => ({ inbound: {
    async execute(input, next) {
      const parent: TraceContext | null = readTraceHeader(input.headers) ?? parentFromArgs(input.args);
      const active = parent ? { traceId: parent.traceId, spanId: randomBytes(8).toString("hex") } : null;
      const invoke = () => observeActivityExecution(context.info, input.args, () => next(input), {
        cancelled: () => context.cancellationSignal.aborted,
        onFinished(event) {
          if (!active) return;
          record(exporter, { ...active, parentSpanId: parent!.spanId, name: `activity ${context.info.activityType}`,
            startedAt: event.startedAt, endedAt: event.startedAt + event.durationMs,
            attributes: safeTraceAttributes({ "space.workflow_id": context.info.workflowExecution?.workflowId,
              "space.run_id": context.info.workflowExecution?.runId, "space.workflow_type": context.info.workflowType,
              "space.activity_type": context.info.activityType, "space.attempt": context.info.attempt,
              "space.outcome": event.outcome, "space.reason_code": event.reasonCode,
              "space.category": event.category, "space.duration_ms": event.durationMs }),
            error: event.outcome === "FAILED" || event.outcome === "FAILED_RESULT" });
        }
      });
      return active ? activityTraceContext.run(active, invoke) : invoke();
    }
  } });
  const sinks: InjectedSinks<TraceSinks> = { spaceTracing: { record: {
    callDuringReplay: false,
    fn(_info, span) { record(exporter, span); }
  } } };
  return {
    // Keep interceptors installed while disabled so previously traced histories replay.
    interceptors: { activity: [activity], workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))] },
    sinks,
    close: () => exporter?.close() ?? Promise.resolve()
  };
}
