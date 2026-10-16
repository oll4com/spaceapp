import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WorkerOptions, ActivityInterceptorsFactory } from "@temporalio/worker";
import type { SpanExporter, ServerSpan } from "@space/telemetry";
import { activityCorrelation, createActivityObservabilityInterceptors, observeActivityExecution } from "./activity-observability.js";
import { contextFromHeaders, inputTraceContext, runSpanId, runTraceId, traceAttributes, validContext } from "./workflow-trace-context.js";

function record(exporter: SpanExporter, span: ServerSpan): void {
  // Never forward arbitrary sink fields, attributes, errors or payloads.
  if (!validContext(span)) return;
  if (span.parentSpanId !== null && !validContext({ traceId: span.traceId, spanId: span.parentSpanId })) return;
  if (!/^[A-Za-z0-9_.$-]{1,100}$/.test(span.name)) return;
  try {
    exporter.record({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, kind: 1,
      startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
      error: span.error, attributes: traceAttributes(span.attributes),
      links: span.links?.filter(validContext).slice(0, 4).map(({ traceId, spanId }) => ({ traceId, spanId })) });
  } catch { /* optional telemetry must not fail work */ }
}

export function workerTracingOptions(exporter: SpanExporter | null, workflowModule = fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))): Pick<WorkerOptions, "interceptors" | "sinks"> {
  if (!exporter) return { interceptors: { activity: [createActivityObservabilityInterceptors()] } };
  const activity: ActivityInterceptorsFactory = context => ({ inbound: {
    execute(input, next) {
      const info = context.info;
      const execution = info.workflowExecution;
      if (!execution) return observeActivityExecution(info, input.args, () => next(input));
      const propagated = contextFromHeaders(input.headers);
      const request = inputTraceContext(input.args);
      // For histories created before instrumentation, attach to their workflow
      // execution deterministically; no activity payload or free-form error is exported.
      const parent = propagated ?? { traceId: request?.traceId ?? runTraceId(execution.runId), spanId: runSpanId(execution.runId) };
      const started = BigInt(Date.now()) * 1_000_000n;
      const startedTick = process.hrtime.bigint();
      const spanId = randomBytes(8).toString("hex");
      return observeActivityExecution(info, input.args, () => next(input), {
        cancelled: () => context.cancellationSignal.aborted,
        onFinish({ outcome, reasonCode, category, durationMs }) {
          record(exporter, { traceId: parent.traceId, spanId, parentSpanId: parent.spanId, name: info.activityType, kind: 1,
            startTimeUnixNano: started, endTimeUnixNano: started + (process.hrtime.bigint() - startedTick),
            error: outcome === "FAILED" || outcome === "FAILED_RESULT",
            attributes: traceAttributes({ ...activityCorrelation(input.args), workflowId: execution.workflowId, runId: execution.runId,
              workflowType: info.workflowType, activityType: info.activityType, attempt: info.attempt, status: outcome, reasonCode, category, durationMs }) });
        }
      });
    }
  } });
  return { interceptors: { activity: [activity], workflowModules: [workflowModule] }, sinks: {
    spaceTrace: { record: { callDuringReplay: false, fn: (_info, span: ServerSpan) => record(exporter, span) } }
  } };
}
