import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ActivityInterceptorsFactory, InjectedSinks, WorkerInterceptors } from "@temporalio/worker";
import {
  otlpSpanExporterFromEnv,
  type ServerSpan,
  type SpanExporter,
  type SpanExporterStats
} from "@space/runtime";
import {
  createActivityObservabilityInterceptors,
  observeActivityExecution
} from "./activity-observability.js";
import {
  mergeTraceLinks,
  WORKFLOW_TRACE_CONTEXT_HEADER,
  traceContextFromArgs,
  readTraceContextHeaders,
  readTraceLink,
  safeTraceIdentifier,
  sanitizeTraceAttributes,
  traceCorrelationAttributes,
  type SpaceTracingSinks
} from "./workflow-trace-context.js";

export interface WorkerTracingOptions {
  serviceName: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; null explicitly disables export. */
  exporter?: SpanExporter | null;
}

export interface WorkerTracing {
  interceptors: WorkerInterceptors;
  sinks: InjectedSinks<SpaceTracingSinks>;
  close(): Promise<void>;
  stats(): SpanExporterStats;
}

/** A stable ID for this one attempt, including retries on another process. */
function activitySpanId(runId: string, activityId: string, attempt: number): string {
  const id = createHash("sha256").update(JSON.stringify(["space.activity", runId, activityId, attempt])).digest("hex").slice(0, 16);
  return /^0+$/.test(id) ? "0000000000000001" : id;
}

/**
 * Stateless host-side export. All parent context comes from Temporal headers,
 * which travel through the server and survive task queues, retries and worker
 * restarts. No map shared with the workflow worker is required.
 */
export function createWorkerTracing(options: WorkerTracingOptions): WorkerTracing {
  const exporter = options.exporter !== undefined
    ? options.exporter
    : otlpSpanExporterFromEnv(options.env ?? process.env, options.serviceName, "space-worker");

  const record = (span: ServerSpan): void => {
    try { exporter?.record(span); } catch {}
  };

  const tracingActivity: ActivityInterceptorsFactory = (context) => ({
    inbound: {
      execute(input, next) {
        // During rolling upgrades, older workflows have no tracing header,
        // but may carry a valid W3C traceparent in their original arguments.
        // Parent those activity spans to the API span, not an invented workflow.
        const workflowParent = readTraceContextHeaders(input.headers);
        const parent = workflowParent ?? (
          input.headers?.[WORKFLOW_TRACE_CONTEXT_HEADER] ? null : traceContextFromArgs(input.args)
        );
        const execution = context.info.workflowExecution;
        let spanId: string | null = null;
        try {
          if (parent && execution) spanId = activitySpanId(execution.runId, context.info.activityId, context.info.attempt);
        } catch {}
        return observeActivityExecution(context.info, input.args, () => next(input), {
          cancelled: () => context.cancellationSignal.aborted,
          ...(workflowParent ? { workflowTrace: { traceId: workflowParent.traceId, spanId: workflowParent.spanId } } : {}),
          onFinished(summary) {
            if (!parent || !spanId) return;
            const type = safeTraceIdentifier(context.info.activityType) ?? "unknown";
            record({
              traceId: parent.traceId,
              spanId,
              parentSpanId: parent.spanId,
              name: `temporal.activity.${type}`,
              kind: 1,
              startTimeUnixNano: BigInt(Math.trunc(summary.startedAt)) * 1_000_000n,
              endTimeUnixNano: BigInt(Math.trunc(Math.max(summary.startedAt, summary.endedAt))) * 1_000_000n,
              attributes: sanitizeTraceAttributes({
                ...traceCorrelationAttributes(input.args),
                activityType: type,
                activityId: context.info.activityId,
                workflowId: execution?.workflowId,
                runId: execution?.runId,
                workflowType: context.info.workflowType,
                taskQueue: context.info.taskQueue,
                w3cTraceId: parent.traceId,
                attempt: context.info.attempt,
                outcome: summary.outcome,
                reasonCode: summary.reasonCode,
                category: summary.category,
                durationMs: summary.durationMs
              }),
              error: summary.outcome === "FAILED" || summary.outcome === "FAILED_RESULT"
            });
          }
        });
      }
    }
  });

  const sinks: InjectedSinks<SpaceTracingSinks> = {
    spaceTracing: {
      exportSpan: {
        callDuringReplay: false,
        fn(info, span) {
          if (!exporter) return;
          try {
            const ids = readTraceLink(span);
            if (!ids || !/^[0-9]{1,30}$/.test(span.startTimeUnixNano) || !/^[0-9]{1,30}$/.test(span.endTimeUnixNano)) return;
            const start = BigInt(span.startTimeUnixNano);
            const end = BigInt(span.endTimeUnixNano);
            if (end < start) return;
            const parent = span.parentSpanId === null ? null : readTraceLink({ traceId: ids.traceId, spanId: span.parentSpanId });
            if (span.parentSpanId !== null && !parent) return;
            const type = safeTraceIdentifier(info.workflowType) ?? "unknown";
            const links = mergeTraceLinks(span.links);
            record({
              ...ids,
              parentSpanId: parent?.spanId ?? null,
              name: `temporal.workflow.${type}`,
              kind: 1,
              startTimeUnixNano: start,
              endTimeUnixNano: end,
              attributes: sanitizeTraceAttributes(span.attributes),
              error: span.error === true,
              ...(links.length ? { links } : {})
            });
          } catch {
            // Malformed instrumentation data is dropped at the boundary.
          }
        }
      }
    }
  };

  return {
    interceptors: {
      activity: [exporter ? tracingActivity : createActivityObservabilityInterceptors()],
      // Keep the patch installed when export is disabled: existing histories
      // may already contain its marker. Only host-side export is optional.
      workflowModules: [fileURLToPath(new URL("./workflow-tracing.js", import.meta.url))]
    },
    sinks,
    async close() {
      try { await exporter?.close(); } catch {}
    },
    stats: () => exporter?.stats() ?? { exported: 0, dropped: 0, failed: 0 }
  };
}
