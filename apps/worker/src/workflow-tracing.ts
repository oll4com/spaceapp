/**
 * Workflow interceptors for OTLP workflow spans (registered through
 * `interceptors.workflowModules` only when SPACE_OTEL_EXPORTER_OTLP_ENDPOINT is
 * set). This code runs inside the deterministic workflow sandbox: it does no
 * I/O, reads no clock and draws no random numbers. It derives the run's span
 * from Temporal identifiers, passes it to activities, child workflows and the
 * next run in Temporal headers, and hands the finished span to the
 * `spaceTracing` sink, which the worker registers with `callDuringReplay: false`,
 * so a replayed history emits nothing.
 */
import {
  ContinueAsNew,
  defaultPayloadConverter,
  isCancellation,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type LocalActivityInput,
  type Next,
  type Sinks,
  type StartChildWorkflowExecutionInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import { isSafeErrorCode, parseTraceparent, type ParsedTraceparent } from "@space/contracts";
import {
  TRACE_LINK_HEADER,
  TRACEPARENT_HEADER,
  resolveWorkflowRunTrace,
  traceparentInArgs,
  traceparentOf,
  type SpanContextRef,
  type WorkflowRunTrace
} from "./workflow-trace-context.js";

export type WorkflowOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";

export interface WorkflowRunSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  /** Each link names why it exists: PARENT_WORKFLOW, CONTINUE_AS_NEW or BACKGROUND_CONTINUATION. */
  links: Array<SpanContextRef & { reason: string }>;
  outcome: WorkflowOutcome;
  reasonCode: string | null;
  /** Identifier fields from the workflow input; the sink filters them through the allowlist again. */
  correlation: Record<string, string>;
}

export interface WorkflowTracingSinks extends Sinks {
  spaceTracing: {
    workflowRun(span: WorkflowRunSpan): void;
  };
}

type Headers = WorkflowExecuteInput["headers"];

/** The traceparent in Temporal header `name`, or null when it is missing or invalid. */
function headerTraceparent(headers: Headers, name: string): ParsedTraceparent | null {
  const payload = headers?.[name];
  if (!payload) return null;
  try {
    return parseTraceparent(defaultPayloadConverter.fromPayload(payload));
  } catch {
    return null;
  }
}

/** A copy of `input` with the given Temporal headers set. */
function withTraceparent<T extends { headers: Headers }>(input: T, values: Record<string, string>): T {
  const headers = { ...input.headers };
  for (const [name, value] of Object.entries(values)) headers[name] = defaultPayloadConverter.toPayload(value);
  return { ...input, headers };
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const correlationKeys = { traceId: "space.trace_id", roomId: "space.room_id", paneId: "space.pane_id", roomAgentMissionId: "space.mission_id", missionId: "space.mission_id", agentRunId: "space.agent_run_id", goalId: "space.goal_id" } as const;

/**
 * Identifier fields from the workflow input (top level and two known nesting
 * levels), mapped to span attribute names. Values must look like identifiers.
 */
function correlationOf(args: readonly unknown[]): Record<string, string> {
  const correlation: Record<string, string> = {};
  /** Collects identifiers from one input object and its known nested inputs. */
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const [key, attribute] of Object.entries(correlationKeys)) {
      const field = record[key];
      if (correlation[attribute] === undefined && typeof field === "string" && identifierPattern.test(field)) correlation[attribute] = field;
    }
    const continuation = record.roomAgentContinuation as { sourceRunId?: unknown } | undefined;
    if (continuation && typeof continuation.sourceRunId === "string" && identifierPattern.test(continuation.sourceRunId)) {
      correlation["space.continuation_of_run_id"] ??= continuation.sourceRunId;
    }
    if (depth > 0) for (const nested of ["turn", "item", "bridge", "input"]) visit(record[nested], depth - 1);
  };
  for (const arg of args) visit(arg, 2);
  return correlation;
}

/**
 * Stable reason code for a failed run: WORKFLOW_TIMEOUT, the innermost safe
 * failure type in the cause chain, or WORKFLOW_FAILED.
 */
function failureCode(error: unknown): string {
  let code = "WORKFLOW_FAILED";
  let failure = error as { name?: unknown; type?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; failure && depth < 8; depth++, failure = failure.cause as typeof failure) {
    if (failure.name === "TimeoutFailure") code = "WORKFLOW_TIMEOUT";
    else if (isSafeErrorCode(failure.type)) code = failure.type;
  }
  return code;
}

/**
 * Workflow interceptors loaded through `workflowModules`: the inbound one
 * exports one span per run, the outbound one puts the run's span into the
 * headers of activities, child workflows and the next run.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const { spaceTracing } = proxySinks<WorkflowTracingSinks>();
  let run: WorkflowRunTrace | null = null;

  const inbound: WorkflowInboundCallsInterceptor = {
    /**
     * Resolves the run's place in the trace, runs the workflow and sends the run's
     * span with its outcome to the sink, however the run ends.
     */
    async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">) {
      const info = workflowInfo();
      const memo = info.memo as Record<string, unknown> | undefined;
      const args = traceparentInArgs(input.args);
      const header = headerTraceparent(input.headers, TRACEPARENT_HEADER);
      const linkHeader = headerTraceparent(input.headers, TRACE_LINK_HEADER);
      const continues = traceparentInArgs(input.args, "continuesTraceparent");
      run = resolveWorkflowRunTrace({
        workflowId: info.workflowId,
        firstExecutionRunId: info.firstExecutionRunId,
        continuedFromExecutionRunId: info.continuedFromExecutionRunId ?? null,
        attempt: info.attempt,
        header,
        linkHeader,
        args,
        continues,
        memo: parseTraceparent(memo?.traceparent)
      });
      const reasons = new Map<string, string>();
      /** Lookup key of the span a traceparent names. */
      const key = (parsed: ParsedTraceparent | null) => parsed ? `${parsed.traceId}:${parsed.parentId}` : "";
      if (args && header) reasons.set(key(header), "PARENT_WORKFLOW");
      if (linkHeader) reasons.set(key(linkHeader), "CONTINUE_AS_NEW");
      if (continues) reasons.set(key(continues), "BACKGROUND_CONTINUATION");
      const links = run.links.map((link) => ({ ...link, reason: reasons.get(`${link.traceId}:${link.spanId}`) ?? "RELATED" }));
      const correlation = correlationOf(input.args);
      let outcome: WorkflowOutcome = "COMPLETED";
      let reasonCode: string | null = null;
      try {
        return await next(input);
      } catch (error) {
        if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
        else if (isCancellation(error)) {
          outcome = "CANCELLED";
          reasonCode = "WORKFLOW_CANCELLED";
        } else {
          outcome = "FAILED";
          reasonCode = failureCode(error);
        }
        throw error;
      } finally {
        spaceTracing.workflowRun({
          traceId: run.traceId,
          spanId: run.spanId,
          parentSpanId: run.parentSpanId,
          links,
          outcome,
          reasonCode,
          correlation
        });
      }
    }
  };

  /** `input` with this run's span as its traceparent header, once the run is known. */
  const underThisRun = <T extends { headers: Headers }>(input: T): T =>
    run ? withTraceparent(input, { [TRACEPARENT_HEADER]: traceparentOf(run) }) : input;

  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity: (input: ActivityInput, next) => next(underThisRun(input)),
    scheduleLocalActivity: (input: LocalActivityInput, next) => next(underThisRun(input)),
    startChildWorkflowExecution: (input: StartChildWorkflowExecutionInput, next) => next(underThisRun(input)),
    /** The next run takes this run's parent (this run itself at a trace root) and links to this run. */
    continueAsNew(input: ContinueAsNewInput, next) {
      if (!run) return next(input);
      // The next run keeps this run's place in the trace and links back to it.
      const place = { traceId: run.traceId, spanId: run.parentSpanId ?? run.spanId };
      return next(withTraceparent(input, {
        [TRACEPARENT_HEADER]: traceparentOf(place),
        [TRACE_LINK_HEADER]: traceparentOf(run)
      }));
    }
  };

  return { inbound: [inbound], outbound: [outbound] };
};
