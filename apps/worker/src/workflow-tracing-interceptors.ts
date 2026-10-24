import { defaultPayloadConverter } from "@temporalio/common";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import {
  ContinueAsNew, isCancellation, patched, proxySinks, workflowInfo,
  type WorkflowInterceptors, type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import type { WorkflowTraceSinks } from "./workflow-tracing-sink.js";
import type { WorkflowSpanWire } from "./workflow-tracing-wire.js";
import { workflowSpanId } from "./workflow-span-ids.js";

const { spaceTrace } = proxySinks<WorkflowTraceSinks>();
const TRACE_HEADER = "space.w3c.traceparent";
const LINK_HEADER = "space.w3c.link";
const PATCH = "otlp-trace-propagation-v1";
type Trace = NonNullable<ReturnType<typeof parseTraceparent>>;

function walkTraceparent(value: unknown, depth = 2): Trace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct = parseTraceparent(record.traceparent);
  if (direct) return direct;
  if (depth > 0) {
    for (const key of ["turn", "item", "input", "turnInput", "bridge"]) {
      const nested = walkTraceparent(record[key], depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

function headerTraceparent(headers: Record<string, unknown>): Trace | null {
  try {
    const payload = headers[TRACE_HEADER];
    return payload ? parseTraceparent(defaultPayloadConverter.fromPayload(payload as never)) : null;
  } catch { return null; }
}

function resolveTraceparent(
  args: readonly unknown[],
  headers: Record<string, unknown>,
  memo: Record<string, unknown> | undefined
): Trace | null {
  const header = headerTraceparent(headers);
  if (header) return header;
  // A child workflow's propagated memo is more recent than the original API
  // context embedded in its task input. Respect the actual parent span.
  const fromMemo = parseTraceparent(memo?.traceparent);
  if (fromMemo) return fromMemo;
  for (const arg of args) {
    const found = walkTraceparent(arg);
    if (found) return found;
  }
  return null;
}

interface CurrentTrace {
  traceId: string;
  spanId: string;
  flags: string;
  startMs: number;
  parentSpanId: string | null;
  linkedTraceId: string | null;
  linkedSpanId: string | null;
}
const traceparentForCurrent = (context: CurrentTrace) =>
  formatTraceparent(context.traceId, context.spanId, context.flags);

const payload = (value: string) => defaultPayloadConverter.toPayload(value)!;

/**
 * Temporal workflows can run without an API parent (scheduled memory work).
 * Derive their root trace id deterministically from the Temporal run UUID so
 * workflow replays never generate new identifiers.
 */
function rootTraceId(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) && !/^0{32}$/.test(hex)
    ? hex : workflowSpanId(runId).repeat(2);
}

/**
 * Only deterministic pure computations run in the workflow isolate.
 * The sink (callDuringReplay:false) sends a primitive, allowlisted span to
 * the shared, bounded Node exporter. Header/memo changes are patch-gated.
 */
export const interceptors: WorkflowInterceptorsFactory = (): WorkflowInterceptors => {
  let current: CurrentTrace | null = null;
  let contextLocked = false;
  let contextAdopted = false;

  return {
    inbound: [{
      async execute(input, next) {
        const info = workflowInfo();
        const parsed = resolveTraceparent(input.args, input.headers, info.memo);
        const continuation = input.args[0] && typeof input.args[0] === "object"
          ? (input.args[0] as Record<string, unknown>).roomAgentContinuation
          : undefined;
        const background = continuation && typeof continuation === "object"
          ? parseTraceparent((continuation as Record<string, unknown>).sourceTraceparent)
          : null;
        const link = background ?? parseTraceparent(info.memo?.spaceTraceLink);
        // Background continuations mint a new W3C trace with no preceding
        // HTTP span. Its workflow is the root, linked to the actual prior
        // Temporal run rather than a synthetic unexported parent ID.
        const sourceTemporalRunId = continuation && typeof continuation === "object"
          ? (continuation as Record<string, unknown>).sourceTemporalRunId : null;
        const backgroundRunId = background && typeof sourceTemporalRunId === "string" &&
          /^[A-Za-z0-9._-]{1,160}$/.test(sourceTemporalRunId) ? sourceTemporalRunId : null;
        current = {
          traceId: parsed?.traceId ?? rootTraceId(info.runId),
          spanId: workflowSpanId(info.runId),
          flags: parsed?.flags ?? "01",
          parentSpanId: background ? null : parsed?.parentId ?? null,
          startMs: Date.now(),
          linkedTraceId: link?.traceId ?? null,
          linkedSpanId: background ? (backgroundRunId ? workflowSpanId(backgroundRunId) : null) : link?.parentId ?? null
        };
        contextAdopted = parsed !== null;
        const report = (status: WorkflowSpanWire["status"]) => {
          const snapshot = current!;
          const wire: WorkflowSpanWire = {
            traceId: snapshot.traceId, spanId: snapshot.spanId,
            parentSpanId: snapshot.parentSpanId,
            workflowId: info.workflowId, workflowType: info.workflowType,
            runId: info.runId, startMs: snapshot.startMs,
            endMs: Date.now(), status,
            continuedFromRunId: info.continuedFromExecutionRunId ?? null,
            linkedTraceId: snapshot.linkedTraceId,
            linkedSpanId: snapshot.linkedSpanId
          };
          // If the sink is unavailable, tracing must not fail business work.
          try { spaceTrace.record(wire); } catch { /* Optional telemetry only. */ }
        };
        try {
          const result = await next(input);
          report(result && typeof result === "object" &&
            (result as { status?: unknown }).status === "FAILED" ? "FAILED" : "COMPLETED");
          return result;
        } catch (error) {
          report(error instanceof ContinueAsNew ? "CONTINUED" : isCancellation(error) ? "CANCELLED" : "FAILED");
          throw error;
        }
      },
      handleSignal(input, next) {
        const incoming = resolveTraceparent(input.args, input.headers, undefined);
        if (incoming && current) {
          if (!contextAdopted && !contextLocked) {
            // signalWithStart can supply its first context through the signal
            // before the supervisor schedules any commands.
            current.traceId = incoming.traceId;
            current.flags = incoming.flags;
            current.parentSpanId = incoming.parentId;
            contextAdopted = true;
          } else if ((incoming.traceId !== current.traceId ||
                      incoming.parentId !== current.parentSpanId) &&
                     !current.linkedTraceId) {
            // A long-lived room supervisor is linked to later API requests.
            // Its original workflow span cannot be reparented across traces.
            current.linkedTraceId = incoming.traceId;
            current.linkedSpanId = incoming.parentId;
          }
        }
        return next(input);
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        if (!current || !patched(PATCH)) return next(input);
        contextLocked = true;
        const requested = workflowInfo().workflowType === "roomAgentSupervisorWorkflow"
          ? input.args.map(arg => walkTraceparent(arg)).find(Boolean) ?? null
          : null;
        const separate = requested && (requested.traceId !== current.traceId ||
          requested.parentId !== current.parentSpanId);
        const parent = separate
          ? formatTraceparent(requested.traceId, requested.parentId, requested.flags)
          : traceparentForCurrent(current);
        return next({
          ...input,
          headers: {
            ...input.headers,
            [TRACE_HEADER]: payload(parent),
            ...(separate ? { [LINK_HEADER]: payload(traceparentForCurrent(current)) } : {})
          }
        });
      },
      scheduleLocalActivity(input, next) {
        if (!current || !patched(PATCH)) return next(input);
        contextLocked = true;
        return next({ ...input, headers: {
          ...input.headers, [TRACE_HEADER]: payload(traceparentForCurrent(current))
        } });
      },
      startChildWorkflowExecution(input, next) {
        if (!current || !patched(PATCH)) return next(input);
        contextLocked = true;
        const specific = workflowInfo().workflowType === "roomAgentSupervisorWorkflow"
          ? (input.options.args ?? []).map(arg => walkTraceparent(arg)).find(Boolean) ?? null
          : null;
        const separate = specific && (specific.traceId !== current.traceId ||
          specific.parentId !== current.parentSpanId);
        const parent = separate
          ? formatTraceparent(specific.traceId, specific.parentId, specific.flags)
          : traceparentForCurrent(current);
        return next({
          ...input,
          options: {
            ...input.options,
            memo: {
              ...input.options.memo,
              traceparent: parent,
              ...(separate ? { spaceTraceLink: traceparentForCurrent(current) } : {})
            }
          }
        });
      },
      continueAsNew(input, next) {
        if (!current || !patched(PATCH)) return next(input);
        return next({
          ...input,
          options: { ...input.options, memo: {
            ...input.options.memo, traceparent: traceparentForCurrent(current)
          } }
        });
      }
    }]
  };
};
