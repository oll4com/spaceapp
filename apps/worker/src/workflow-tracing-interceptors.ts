import {
  ContinueAsNew,
  defaultPayloadConverter,
  isCancellation,
  proxySinks,
  workflowInfo,
  uuid4,
  type Headers,
  type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, isSafeCode as isSafeErrorCode, parseTraceparent, type ParsedTraceparent } from "./workflows/trace-ids.js";
import { LINK_TRACEPARENT_HEADER, TRACEPARENT_HEADER } from "./workflow-tracing-headers.js";

export { LINK_TRACEPARENT_HEADER, TRACEPARENT_HEADER };
import type { SpaceTracingSinks, WorkflowSpanOutcome, WorkflowSpanRecord } from "./tracing/sinks.js";
export type { SpaceTracingSinks, WorkflowSpanRecord } from "./tracing/sinks.js";

/**
 * Workflow span for OTLP export (SPACE_OTEL_EXPORTER_OTLP_ENDPOINT). This module
 * runs inside the deterministic workflow sandbox and is registered only when
 * export is on (see worker-tracing.ts). It does no I/O: the finished span leaves
 * the sandbox through the `spaceTracing` sink, which the worker registers with
 * `callDuringReplay: false`, so a replayed history emits nothing.
 *
 * IDs use Temporal's deterministic workflow random stream.
 */

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const nestedKeys = ["turn", "input", "turnInput"] as const;

function readHeader(headers: Headers | undefined, key: string): ParsedTraceparent | null {
  const payload = headers?.[key];
  if (!payload) return null;
  try {
    return parseTraceparent(defaultPayloadConverter.fromPayload(payload));
  } catch {
    return null;
  }
}

/** First value of `key` in the argument or its nested turn/input objects (depth 2). */
function findArgument(value: unknown, key: string, depth: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  if (depth <= 0) return undefined;
  for (const nested of nestedKeys) {
    const found = findArgument(record[nested], key, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && identifierPattern.test(value) ? value : undefined;
}

function errorCodeOf(error: unknown): string {
  const record = error as { type?: unknown; code?: unknown; cause?: { type?: unknown } } | null;
  if (isSafeErrorCode(record?.type)) return record!.type as string;
  if (isSafeErrorCode(record?.code)) return record!.code as string;
  if (isSafeErrorCode(record?.cause?.type)) return record.cause.type;
  return "WORKFLOW_FAILED";
}

function withHeader(headers: Headers, key: string, traceparent: string | null): Headers {
  return traceparent ? { ...headers, [key]: defaultPayloadConverter.toPayload(traceparent) } : headers;
}

/** One instance per workflow run: the factory closure holds that run's span. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  let current: { traceId: string; spanId: string; flags: string; parentTraceparent: string | null } | null = null;
  const own = () => (current ? formatTraceparent(current.traceId, current.spanId, current.flags) : null);
  const { spaceTracing } = proxySinks<SpaceTracingSinks>();

  return {
    inbound: [{
      async execute(input, next) {
        const info = workflowInfo();
        const first = input.args[0];
        const carrier = readHeader(input.headers, TRACEPARENT_HEADER);
        const argument = parseTraceparent(findArgument(first, "traceparent", 2));
        const memo = parseTraceparent(info.memo?.traceparent);
        const links: WorkflowSpanRecord["links"] = [];
        const continued = parseTraceparent(info.memo?.continuationTraceparent) ?? parseTraceparent(findArgument(first, "continuationTraceparent", 2));
        // Background turns start a new root. Older queued turns may still carry
        // a fresh traceparent: retain its trace id, never its unexported parent.
        const backgroundRoot = !carrier && Boolean(continued || findArgument(first, "roomAgentContinuation", 2));
        const parent = backgroundRoot ? null : carrier ?? argument ?? memo;
        const traceId = parent?.traceId ?? (backgroundRoot ? argument?.traceId : undefined) ?? uuid4().replace(/-/g, "");
        const span = {
          traceId,
          spanId: uuid4().replace(/-/g, "").slice(0, 16),
          flags: parent?.flags ?? "01",
          parentTraceparent: parent ? formatTraceparent(parent.traceId, parent.parentId, parent.flags) : null
        };
        current = span;
        const previousRun = readHeader(input.headers, LINK_TRACEPARENT_HEADER);
        if (previousRun) links.push({ traceId: previousRun.traceId, spanId: previousRun.parentId, reason: "continue_as_new" });
        if (continued) links.push({ traceId: continued.traceId, spanId: continued.parentId, reason: "background_continuation" });
        const correlation: WorkflowSpanRecord["correlation"] = {};
        const spaceTraceId = identifier(findArgument(first, "traceId", 2));
        const roomId = identifier(findArgument(first, "roomId", 2));
        const paneId = identifier(findArgument(first, "paneId", 2));
        const missionId = identifier(findArgument(first, "missionId", 2)) ?? identifier(findArgument(first, "roomAgentMissionId", 2));
        const goalId = identifier(findArgument(first, "goalId", 2));
        if (spaceTraceId) correlation.spaceTraceId = spaceTraceId;
        if (roomId) correlation.roomId = roomId;
        if (paneId) correlation.paneId = paneId;
        if (missionId) correlation.missionId = missionId;
        if (goalId) correlation.goalId = goalId;

        let outcome: WorkflowSpanOutcome = "COMPLETED";
        let errorCode: string | null = null;
        try {
          return await next(input);
        } catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else if (isCancellation(error)) outcome = "CANCELLED";
          else {
            outcome = "FAILED";
            errorCode = errorCodeOf(error);
          }
          throw error;
        } finally {
          try { spaceTracing.workflowSpan({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: parent?.parentId ?? null,
            startTimeMs: info.runStartTime?.getTime() ?? Date.now(),
            endTimeMs: Date.now(),
            outcome,
            errorCode,
            correlation,
            links
          }); } catch { /* Tracing must never change the workflow result. */ }
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: withHeader(input.headers, TRACEPARENT_HEADER, own()) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: withHeader(input.headers, TRACEPARENT_HEADER, own()) }),
      startChildWorkflowExecution: (input, next) => {
        let tracedInput = input;
        try {
          const first = input.options?.args?.[0];
          const link = parseTraceparent(findArgument(first, "continuationTraceparent", 2));
          const argument = parseTraceparent(findArgument(first, "traceparent", 2));
          const background = Boolean(link || findArgument(first, "roomAgentContinuation", 2));
          // Per-request turns under a long-lived supervisor keep their API parent.
          const parent = argument && current && argument.traceId !== current.traceId
            ? formatTraceparent(argument.traceId, argument.parentId, argument.flags) : own();
          const headers = { ...input.headers };
          if (background) delete headers[TRACEPARENT_HEADER];
          tracedInput = { ...input,
            headers: background ? headers : withHeader(headers, TRACEPARENT_HEADER, parent),
            ...(link ? { options: { ...input.options, memo: { ...input.options?.memo, continuationTraceparent: formatTraceparent(link.traceId, link.parentId, link.flags) } } } : {})
          };
        } catch { /* Tracing must never prevent a child from starting. */ }
        // Keep next outside the catch: never retry a failed child start.
        return next(tracedInput);
      },
      continueAsNew: (input, next) => {
        // The next run stays in this trace under the same parent and links back to this run.
        const headers = withHeader(input.headers, TRACEPARENT_HEADER, current?.parentTraceparent ?? own());
        return next({ ...input, headers: withHeader(headers, LINK_TRACEPARENT_HEADER, own()) });
      }
    }]
  };
};
