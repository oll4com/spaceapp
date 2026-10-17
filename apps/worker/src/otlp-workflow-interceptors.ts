import {
  ApplicationFailure,
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Next,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent
} from "@space/contracts";
import {
  backgroundContinuationFromArgs,
  sanitizeSpanAttributes,
  spanIdFromRunId,
  SPAN_KIND_INTERNAL,
  TRACEPARENT_HEADER,
  traceIdFromRunId,
  traceparentFromArgs,
  traceparentFromHeaders,
  traceparentFromMemo,
  traceparentHeaderPayload,
  type OtlpSpanSinks,
  type WorkflowSpanLinkPayload,
  type WorkflowSpanPayload
} from "./otlp-span-context.js";

/**
 * Workflow tracing interceptors. They run inside the deterministic workflow
 * sandbox, so they perform no I/O: the only way a span leaves the sandbox is
 * the `otlp.exportWorkflowSpan` sink, whose worker-process implementation is
 * registered with `callDuringReplay: false` (see otlp-span-sink.ts), which
 * makes replay emit no spans. Everything computed here is a pure function of
 * the workflow info, headers and arguments, so it is identical on replay.
 *
 * Span tree: the workflow span is parented by the API span that the API
 * propagated as a traceparent (Temporal header from a parent workflow, else
 * the workflow memo, else the workflow input). Its span id is derived from
 * the run id (spanIdFromRunId), which is how activity spans parent to it. The
 * outbound interceptor stamps the same trace context into Temporal headers
 * for activities, child workflows and continue-as-new, so the tree continues
 * across process and run boundaries. Continue-as-new runs and background
 * continuations instead carry a span link to the run they continue.
 */

const { otlp } = proxySinks<OtlpSpanSinks>();

interface WorkflowSpanState {
  traceId: string;
  spanId: string;
  traceparent: string;
}

function isTerminalWorkflowError(error: unknown): boolean {
  if (error instanceof ContinueAsNew) return true;
  if (isCancellation(error)) return true;
  if (error instanceof ApplicationFailure) return Boolean(error.nonRetryable);
  const name = typeof (error as { name?: unknown })?.name === "string" ? (error as { name: string }).name : "";
  if (/ContinueAsNew/i.test(name) || /Cancel/i.test(name)) return true;
  return false;
}

function errorDetails(error: unknown): { outcome: string; reasonCode: string | null; error: boolean } {
  const record = error as { name?: unknown; code?: unknown; type?: unknown } | null;
  const name = typeof record?.name === "string" ? record.name : "";
  if (error instanceof ContinueAsNew || /ContinueAsNew/i.test(name)) {
    return { outcome: "CONTINUED_AS_NEW", reasonCode: null, error: false };
  }
  if (isCancellation(error) || /Cancel/i.test(name)) {
    return { outcome: "CANCELLED", reasonCode: "WORKFLOW_CANCELLED", error: true };
  }
  const code = isSafeErrorCode(record?.code)
    ? (record!.code as string)
    : isSafeErrorCode(record?.type)
      ? (record!.type as string)
      : null;
  return { outcome: "FAILED", reasonCode: code ?? "WORKFLOW_ERROR", error: true };
}

class OtlpWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  constructor(private readonly state: { current: WorkflowSpanState | null }) {}

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
    const info = workflowInfo();
    const spanId = spanIdFromRunId(info.runId);
    const headerTraceparent = parseTraceparent(traceparentFromHeaders(input.headers));
    const argsTraceparent = traceparentFromArgs(input.args);
    const memoTraceparent = traceparentFromMemo(info.memo);

    const propagated = headerTraceparent ?? memoTraceparent ?? argsTraceparent;
    const traceId = propagated?.traceId ?? traceIdFromRunId(info.runId);
    // If continued-as-new, parentSpanId is null because continue-as-new links to the previous run
    const parentSpanId = info.continuedFromExecutionRunId ? null : (propagated?.parentId ?? null);

    const links: WorkflowSpanLinkPayload[] = [];
    if (info.continuedFromExecutionRunId) {
      links.push({
        traceId,
        spanId: spanIdFromRunId(info.continuedFromExecutionRunId),
        attributes: sanitizeSpanAttributes({
          "space.link.type": "continue_as_new"
        })
      });
    }

    const continuation = backgroundContinuationFromArgs(input.args);
    if (continuation && argsTraceparent) {
      links.push({
        traceId: argsTraceparent.traceId,
        spanId: argsTraceparent.parentId,
        attributes: sanitizeSpanAttributes({
          "space.link.type": "background_continuation",
          "space.continuation.source_run_id": continuation.sourceRunId,
          ...(continuation.generation !== null ? { "space.continuation.generation": continuation.generation } : {})
        })
      });
    }

    const state: WorkflowSpanState = {
      traceId,
      spanId,
      traceparent: formatTraceparent(traceId, spanId, headerTraceparent?.flags ?? "01")
    };
    this.state.current = state;
    const startedAtMs = info.runStartTime.getTime();

    const emit = (outcome: string, reasonCode: string | null, error: boolean) => {
      const endedAtMs = Date.now();
      const payload: WorkflowSpanPayload = {
        traceId,
        spanId,
        parentSpanId,
        name: `workflow/${info.workflowType}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: (BigInt(startedAtMs) * 1_000_000n).toString(),
        endTimeUnixNano: (BigInt(endedAtMs) * 1_000_000n).toString(),
        attributes: sanitizeSpanAttributes({
          "space.workflow_id": info.workflowId,
          "space.run_id": info.runId,
          "space.workflow_type": info.workflowType,
          "space.outcome": outcome,
          "space.reason_code": reasonCode ?? undefined,
          "space.category": error && reasonCode ? categorizeFailureCode(reasonCode) : undefined,
          "space.duration_ms": Math.max(0, endedAtMs - startedAtMs)
        }),
        error,
        ...(links.length ? { links } : {})
      };
      otlp.exportWorkflowSpan(payload);
    };

    try {
      const result = await next(input);
      emit("COMPLETED", null, false);
      return result;
    } catch (error) {
      // Only emit terminal span for errors that actually terminate or continue the execution.
      // Transient workflow task errors will be retried by Temporal without ending the execution.
      if (isTerminalWorkflowError(error)) {
        const details = errorDetails(error);
        emit(details.outcome, details.reasonCode, details.error);
      }
      throw error;
    }
  }
}

class OtlpWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly state: { current: WorkflowSpanState | null }) {}

  private stamp<T extends { headers?: Record<string, unknown> }>(input: T): T {
    const current = this.state.current;
    if (current) {
      return {
        ...input,
        headers: {
          ...input.headers,
          [TRACEPARENT_HEADER]: traceparentHeaderPayload(current.traceparent)
        }
      };
    }
    return input;
  }

  scheduleActivity(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["scheduleActivity"]>>[0], next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">) {
    return next(this.stamp(input));
  }

  scheduleLocalActivity(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["scheduleLocalActivity"]>>[0], next: Next<WorkflowOutboundCallsInterceptor, "scheduleLocalActivity">) {
    return next(this.stamp(input));
  }

  startChildWorkflowExecution(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["startChildWorkflowExecution"]>>[0], next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">) {
    const childTraceparent = traceparentFromArgs(input.options?.args);
    if (childTraceparent) {
      return next({
        ...input,
        headers: {
          ...input.headers,
          [TRACEPARENT_HEADER]: traceparentHeaderPayload(
            formatTraceparent(childTraceparent.traceId, childTraceparent.parentId, childTraceparent.flags)
          )
        }
      });
    }
    return next(this.stamp(input));
  }

  signalWorkflow(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["signalWorkflow"]>>[0], next: Next<WorkflowOutboundCallsInterceptor, "signalWorkflow">) {
    return next(this.stamp(input));
  }

  continueAsNew(input: Parameters<NonNullable<WorkflowOutboundCallsInterceptor["continueAsNew"]>>[0], next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">) {
    return next(this.stamp(input));
  }
}

/** Workflow interceptor factory, registered through Worker `interceptors.workflowModules`. */
export const interceptors = (): WorkflowInterceptors => {
  const state: { current: WorkflowSpanState | null } = { current: null };
  return {
    inbound: [new OtlpWorkflowInboundInterceptor(state)],
    outbound: [new OtlpWorkflowOutboundInterceptor(state)]
  };
};
