import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type WorkflowInterceptors
} from "@temporalio/workflow";
import {
  TRACE_HEADER, TRACE_LINK_HEADER, parseWorkflowTraceparent, traceArgument, traceFromHeaders,
  traceHeader, workflowCorrelation, workflowSpanId, workflowTraceparent,
  type TraceContext, type WorkflowSpanRecord, type WorkflowTracingSinks
} from "./workflow-tracing-context.js";

/** This module is bundled into the workflow isolate only when export is enabled. */
export function interceptors(): WorkflowInterceptors {
  const { spaceTracing } = proxySinks<WorkflowTracingSinks>();
  const info = workflowInfo();
  let root: WorkflowSpanRecord | null = null;
  let rootParent: TraceContext | null = null;
  let rootArgumentParent: TraceContext | null = null;
  // A long-lived supervisor can process requests from several API traces. Do not
  // parent every later mission under the request that originally started it.
  const missions = new Map<string, WorkflowSpanRecord>();
  const missionIds = new Map<string, WorkflowSpanRecord>();
  const closed = new Set<WorkflowSpanRecord>();
  const operations = new Map<WorkflowSpanRecord, number>();
  const childCompleted = new Set<WorkflowSpanRecord>();
  const supervisor = info.workflowType === "roomAgentSupervisorWorkflow";
  const finished = (span: WorkflowSpanRecord, outcome: WorkflowSpanRecord["outcome"]) => {
    if (closed.has(span)) return;
    closed.add(span);
    span.endedAtMs = Date.now();
    spaceTracing.record({ ...span, outcome });
  };
  const makeSpan = (parent: TraceContext | null, args: readonly unknown[], link: TraceContext | null = null, discriminator = "run"): WorkflowSpanRecord => ({
    traceId: parent?.traceId ?? `${workflowSpanId(info.runId)}${workflowSpanId(`trace:${info.runId}`)}`,
    spanId: workflowSpanId(`${info.runId}:${parent?.traceId ?? "root"}:${parent?.spanId ?? "root"}:${discriminator}`),
    parentSpanId: parent?.spanId ?? null,
    startedAtMs: Date.now(), endedAtMs: Date.now(), outcome: "COMPLETED",
    correlation: workflowCorrelation(args),
    ...(link ? { links: [{ traceId: link.traceId, spanId: link.spanId }] } : {})
  });
  const parentFor = (args: readonly unknown[]): WorkflowSpanRecord | null => {
    const parent = traceArgument(args);
    const correlation = workflowCorrelation(args);
    const missionId = correlation.missionId ?? correlation.roomAgentMissionId;
    if (!parent) return (missionId ? missionIds.get(missionId) : undefined) ?? root;
    if ((!supervisor || !missionId) && [rootParent, rootArgumentParent].some(candidate => candidate && parent.traceId === candidate.traceId && parent.spanId === candidate.spanId)) return root;
    const key = `${parent.traceId}:${parent.spanId}:${missionId ?? "request"}:${correlation.agentRunId ?? ""}`;
    let span = missions.get(key);
    if (!span) {
      span = makeSpan(parent, args, traceArgument(args, "traceLink"), key);
      // Supervisor histories are continued periodically; also cap instrumentation
      // state independently, without exporting any unbounded request data.
      if (missions.size >= 256) {
        const oldest = missions.keys().next().value!;
        const discarded = missions.get(oldest)!;
        closed.delete(discarded);
        operations.delete(discarded);
        childCompleted.delete(discarded);
        missions.delete(oldest);
        missionIds.clear();
      }
      missions.set(key, span);
      if (missionId) missionIds.set(missionId, span);
    }
    return span;
  };
  const headersFor = (span: WorkflowSpanRecord) => ({
    [TRACE_HEADER]: traceHeader(workflowTraceparent({ traceId: span.traceId, spanId: span.spanId, flags: "01" }))
  });
  return {
    inbound: [{
      async execute(input, next) {
        rootArgumentParent = traceArgument(input.args);
        rootParent = traceFromHeaders(input.headers) ?? rootArgumentParent ?? parseWorkflowTraceparent(info.memo?.traceparent);
        const link = traceFromHeaders(input.headers, TRACE_LINK_HEADER) ?? traceArgument(input.args, "traceLink") ?? parseWorkflowTraceparent(info.memo?.traceLink);
        root = makeSpan(rootParent, input.args, link);
        if (supervisor) {
          const first = input.args[0] as { pending?: unknown } | undefined;
          if (Array.isArray(first?.pending)) for (const item of first.pending.slice(0, 256)) parentFor([item]);
        }
        try {
          const result = await next(input);
          for (const span of missions.values()) finished(span, span.outcome);
          finished(root, "COMPLETED");
          return result;
        } catch (error) {
          const outcome = error instanceof ContinueAsNew ? "CONTINUED" : isCancellation(error) ? "CANCELLED" : "FAILED";
          for (const span of missions.values()) finished(span, span.outcome === "FAILED" ? "FAILED" : outcome);
          finished(root, outcome);
          throw error;
        }
      },
      async handleSignal(input, next) {
        // Remember traced queue items so subsequent identifier-only bookkeeping
        // activities can use that mission's context, without altering its payload.
        parentFor(input.args);
        return next(input);
      }
    }],
    outbound: [{
      async scheduleActivity(input, next) {
        const span = parentFor(input.args);
        if (!span) return next(input);
        const closesMission = supervisor && span !== root && ["finishRoomAgentSupervisorTurn", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued"].includes(input.activityType);
        operations.set(span, (operations.get(span) ?? 0) + 1);
        try {
          const result = await next({ ...input, headers: { ...input.headers, ...headersFor(span) } });
          if (closesMission) {
            const status = (input.args[0] as { status?: unknown } | undefined)?.status;
            finished(span, status === "FAILED" ? "FAILED" : status === "INTERRUPTED" ? "CANCELLED" : span.outcome);
          }
          return result;
        } catch (error) {
          if (closesMission) finished(span, isCancellation(error) ? "CANCELLED" : "FAILED");
          throw error;
        } finally {
          operations.set(span, (operations.get(span) ?? 1) - 1);
        }
      },
      async scheduleLocalActivity(input, next) {
        const span = parentFor(input.args);
        if (!span) return next(input);
        operations.set(span, (operations.get(span) ?? 0) + 1);
        try { return await next({ ...input, headers: { ...input.headers, ...headersFor(span) } }); }
        finally { operations.set(span, (operations.get(span) ?? 1) - 1); }
      },
      async startChildWorkflowExecution(input, next) {
        const span = parentFor(input.options.args ?? []);
        if (!span) return next(input);
        operations.set(span, (operations.get(span) ?? 0) + 1);
        let result: [Promise<string>, Promise<unknown>];
        try { result = await next({ ...input, headers: { ...input.headers, ...headersFor(span) } }); }
        catch (error) { operations.set(span, (operations.get(span) ?? 1) - 1); throw error; }
        // Preserve both SDK promises: replacing or awaiting the completion here
        // would change child start/cancellation semantics.
        void result[1].then(result => {
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") span.outcome = "FAILED";
        }, () => { span.outcome = "FAILED"; }).then(() => {
          operations.set(span, (operations.get(span) ?? 1) - 1);
          childCompleted.add(span);
        });
        return result;
      },
      async continueAsNew(input, next) {
        if (!root) return next(input);
        const continued = workflowTraceparent({ traceId: root.traceId, spanId: root.spanId, flags: "01" });
        const parent = rootParent ? { [TRACE_HEADER]: traceHeader(workflowTraceparent(rootParent)) } : headersFor(root);
        return next({ ...input, headers: { ...input.headers, ...parent, [TRACE_LINK_HEADER]: traceHeader(continued) } });
      }
    }],
    internals: [{
      concludeActivation(input, next) {
        const result = next(input);
        // A supervisor may go directly from a finished turn to waiting for
        // background work or a new signal, with no finish activity. Emit at
        // the activation boundary only after any final bookkeeping settled.
        for (const span of missions.values()) {
          if (childCompleted.has(span) && !operations.get(span)) finished(span, span.outcome);
        }
        return result;
      }
    }]
  };
}
