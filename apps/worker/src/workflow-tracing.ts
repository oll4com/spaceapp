import {
  ContinueAsNew, isCancellation, proxySinks, workflowInfo,
  type Sinks, type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import {
  argumentTraceparent, headerTraceparent, PREVIOUS_SPAN_HEADER,
  traceFailureCode, traceIdentifiers, withTraceHeader, workflowRunSpanId
} from "./trace-propagation.js";

export interface WorkflowSpanRecord {
  traceparent: string;
  parentTraceparent: string | null;
  previousTraceparent: string | null;
  startedAt: number;
  finishedAt: number;
  outcome: "COMPLETED" | "FAILED" | "FAILED_RESULT" | "CANCELLED" | "CONTINUED_AS_NEW";
  reasonCode: string | null;
  identifiers: Record<string, string>;
}
export interface WorkflowTraceSinks extends Sinks {
  spaceTracing: { finish(record: WorkflowSpanRecord): void };
}

/** Deterministic context propagation only. Export/I/O lives in worker-tracing. */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const { spaceTracing } = proxySinks<WorkflowTraceSinks>();
  let traceparent: string | null = null;
  let parent: string | null = null;
  let previous: string | null = null;

  return {
    inbound: [{
      async execute(input, next) {
        const info = workflowInfo();
        parent = headerTraceparent(input.headers) ?? argumentTraceparent(input.args)
          ?? (parseTraceparent(info.memo?.traceparent) ? info.memo!.traceparent as string : null);
        previous = headerTraceparent(input.headers, PREVIOUS_SPAN_HEADER) ?? argumentTraceparent(input.args, "previousTraceparent");
        const parsed = parseTraceparent(parent);
        // Run IDs are server-generated UUIDs. Do not consume workflow PRNG values:
        // doing so would change existing uuid4() results when replaying old history.
        const runHex = info.runId.replace(/-/g, "");
        traceparent = formatTraceparent(parsed?.traceId ?? runHex, workflowRunSpanId(info.runId)!, parsed?.flags ?? "01");
        const startedAt = info.runStartTime.getTime();
        let outcome: WorkflowSpanRecord["outcome"] = "COMPLETED";
        let reasonCode: string | null = null;
        try {
          const result = await next(input);
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") {
            outcome = "FAILED_RESULT";
            reasonCode = "WORKFLOW_RESULT_FAILED";
          }
          return result;
        } catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else {
            outcome = isCancellation(error) ? "CANCELLED" : "FAILED";
            reasonCode = traceFailureCode(error);
          }
          throw error;
        } finally {
          // The sink also declares callDuringReplay:false. Keep replay free of
          // calls even when a test/embedding registers a replay-enabled sink.
          if (!workflowInfo().unsafe.isReplaying) spaceTracing.finish({
            traceparent, parentTraceparent: parent, previousTraceparent: previous,
            startedAt, finishedAt: Date.now(), outcome, reasonCode,
            identifiers: traceIdentifiers(input.args)
          });
        }
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        return next(traceparent ? { ...input, headers: withTraceHeader(input.headers, traceparent) } : input);
      },
      scheduleLocalActivity(input, next) {
        return next(traceparent ? { ...input, headers: withTraceHeader(input.headers, traceparent) } : input);
      },
      startChildWorkflowExecution(input, next) {
        if (!traceparent) return next(input);
        const explicit = argumentTraceparent(input.options.args ?? []);
        // A supervisor can receive missions from different API requests. Keep
        // that mission's trace and link its supervising run across traces.
        const foreign = explicit && parseTraceparent(explicit)?.traceId !== parseTraceparent(traceparent)?.traceId;
        const background = Object.values(traceIdentifiers(input.options.args ?? [])).some(value => value.startsWith("trace:bg-"));
        const predecessor = argumentTraceparent(input.options.args ?? [], "previousTraceparent");
        return next({ ...input, headers: withTraceHeader(input.headers,
          foreign ? explicit! : traceparent, predecessor ?? (foreign || background ? traceparent : undefined)) });
      },
      continueAsNew(input, next) {
        return next(traceparent ? { ...input, headers: withTraceHeader(input.headers, traceparent, traceparent) } : input);
      }
    }]
  };
};
