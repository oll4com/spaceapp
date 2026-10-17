import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInterceptors,
  type WorkflowInterceptorsFactory,
  type WorkflowInfo
} from "@temporalio/workflow";
import { categorizeFailureCode, isSafeErrorCode } from "@space/contracts";
import {
  MAX_TRACE_LINKS,
  findBackgroundTrace,
  findTraceContext,
  findTraceLinks,
  readTraceHeader,
  sanitizeTraceAttributes,
  sanitizeTraceLinks,
  traceCorrelationAttributes,
  withTraceHeader,
  workflowSpanId,
  workflowTraceId,
  type TraceContext,
  type TraceEnvelope,
  type TraceLink,
  type WorkflowTraceSpan
} from "./tracing-protocol.js";

export interface WorkflowTracingSinks extends Sinks {
  tracing: { record(span: WorkflowTraceSpan): void };
}

type TraceWorkflowInfo = Pick<WorkflowInfo, "workflowId" | "runId" | "workflowType" | "runStartTime" | "memo">;

/** Dependencies are explicit so protocol/outcome behavior can be tested alone. */
export interface WorkflowTracingDependencies {
  info(): TraceWorkflowInfo;
  now(): number;
  record(span: WorkflowTraceSpan): void;
}

/**
 * Tracing adds headers and sink calls only: no activities, timers, randomness or
 * I/O. The worker registers tracing.record with callDuringReplay:false.
 */
export function createWorkflowTracingInterceptors(dependencies: WorkflowTracingDependencies): WorkflowInterceptors {
  let info = dependencies.info();
  const spanId = workflowSpanId(info.runId);
  let context: TraceContext | null = null;
  let parentSpanId: string | null = null;
  let propagated = false;
  let contextLocked = false;
  let completed = false;
  let attributes: Record<string, string | number> = {};
  let links: TraceLink[] = [];

  const addLinks = (incoming: readonly TraceLink[]) => {
    links = sanitizeTraceLinks([...links, ...incoming].slice(0, MAX_TRACE_LINKS * 2));
  };
  /** Adopt a parent before scheduling locks context; later requests become links. */
  const adopt = (envelope: TraceEnvelope | null) => {
    if (!envelope) return;
    if (!propagated && !contextLocked) {
      context = { ...envelope.context, spanId };
      parentSpanId = envelope.continuation || envelope.root ? envelope.parentSpanId ?? null : envelope.context.spanId;
      propagated = true;
    } else if (envelope.context.traceId !== context?.traceId || envelope.context.spanId !== parentSpanId) {
      // Subsequent signal requests link to the existing workflow span; they
      // cannot re-parent activity spans already scheduled by this run.
      addLinks([envelope.context]);
    }
    addLinks(envelope.links ?? []);
  };
  const current = (): TraceContext => context ??= { traceId: workflowTraceId(info.runId), spanId, flags: "01" };
  /** Freeze parentage before propagating the workflow span to newly scheduled work. */
  const childHeaders = (headers: Parameters<typeof withTraceHeader>[0]) => {
    contextLocked = true;
    return withTraceHeader(headers, { context: current() });
  };
  /** Emit at most one sanitized outcome without allowing sink failures to affect execution. */
  const finish = (outcome: string, error: boolean, reasonCode?: string) => {
    if (completed) return;
    completed = true;
    const active = current();
    const startTimeMs = info.runStartTime.getTime();
    const allowed = sanitizeTraceAttributes({
      ...attributes,
      "temporal.workflow.type": info.workflowType,
      "temporal.workflow.id": info.workflowId,
      "temporal.run.id": info.runId,
      "space.outcome": outcome,
      ...(reasonCode ? {
        "space.reason_code": reasonCode,
        "space.failure_category": outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(reasonCode)
      } : {})
    });
    const span: WorkflowTraceSpan = {
      traceId: active.traceId,
      spanId,
      parentSpanId,
      name: `workflow.${allowed["temporal.workflow.type"] ?? "unknown"}`,
      kind: 1,
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, dependencies.now()),
      attributes: allowed,
      error,
      ...(links.length ? { links } : {})
    };
    // A missing/misconfigured optional sink cannot change the business result.
    try { dependencies.record(span); } catch { /* Best-effort telemetry only. */ }
  };

  return {
    inbound: [{
      async execute(input, next) {
        // The SDK initializes interceptor factories before decoding workflow
        // memo payloads. Read the populated info when execution actually starts.
        info = dependencies.info();
        const fallback = findTraceContext(input.args, info.memo);
        adopt(readTraceHeader(input.headers) ?? findBackgroundTrace(input.args) ?? (fallback ? { context: fallback } : null));
        attributes = { ...attributes, ...traceCorrelationAttributes(input.args, info.memo) };
        addLinks(findTraceLinks(input.args, info.memo));
        try {
          const result = await next(input);
          if (result !== null && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") {
            finish("FAILED_RESULT", true, "WORKFLOW_RESULT_FAILED");
          } else finish("COMPLETED", false);
          return result;
        } catch (error) {
          if (error instanceof ContinueAsNew) finish("CONTINUED_AS_NEW", false);
          else if (isCancellation(error)) finish("CANCELLED", true, "WORKFLOW_CANCELLED");
          else {
            const failure = error as { code?: unknown; type?: unknown } | null;
            const code = isSafeErrorCode(failure?.code) ? failure.code
              : isSafeErrorCode(failure?.type) ? failure.type : "WORKFLOW_ERROR";
            finish("FAILED", true, code);
          }
          throw error;
        }
      },
      async handleSignal(input, next) {
        info = dependencies.info();
        const fallback = findTraceContext(input.args);
        adopt(readTraceHeader(input.headers) ?? (fallback ? { context: fallback } : null));
        attributes = { ...traceCorrelationAttributes(input.args), ...attributes };
        addLinks(findTraceLinks(input.args));
        return next(input);
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: childHeaders(input.headers) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: childHeaders(input.headers) }),
      // Pass the SDK's promise pair through unchanged, including each rejection.
      startChildWorkflowExecution(input, next) {
        const background = findBackgroundTrace(input.options.args ?? []);
        contextLocked = true;
        return next({ ...input, headers: background ? withTraceHeader(input.headers, background) : childHeaders(input.headers) });
      },
      signalWorkflow: (input, next) => next({ ...input, headers: childHeaders(input.headers) }),
      continueAsNew(input, next) {
        contextLocked = true;
        const active = current();
        return next({
          ...input,
          headers: withTraceHeader(input.headers, {
            context: active,
            parentSpanId,
            continuation: true,
            links: [{ traceId: active.traceId, spanId: active.spanId }]
          })
        });
      }
    }]
  };
}

/** Temporal sandbox entrypoint: hand deterministic spans to the host sink without HTTP. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const sinks = proxySinks<WorkflowTracingSinks>();
  return createWorkflowTracingInterceptors({ info: workflowInfo, now: Date.now, record: span => sinks.tracing.record(span) });
};
