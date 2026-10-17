import { TemporalFailure } from "@temporalio/common";
import { ContinueAsNew, isCancellation, proxySinks, workflowInfo, type WorkflowInterceptorsFactory } from "@temporalio/workflow";
import { categorizeFailureCode, formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import { argumentTrace, readCarrier, safeWorkerAttributes, traceIdForRun, withCarrier, workflowSpanId, spanIdFor, traceIdentifier,
  type TraceCarrier, type TraceSinks, type TraceLink, type ArgumentTrace } from "./temporal-trace-context.js";
import { installWorkflowRequestTracer } from "./workflow-trace-scope.js";

export const interceptors: WorkflowInterceptorsFactory = () => {
  const info = workflowInfo(), sink = proxySinks<TraceSinks>();
  const runSpanId = workflowSpanId(info.runId);
  let carrier: TraceCarrier = { traceparent: formatTraceparent(traceIdForRun(info.runId), runSpanId) };
  let parentSpanId: string | null = null, scoped = false, scopeSequence = 0;
  let lastCompleted: TraceLink | undefined, inheritedLink: TraceLink | undefined;
  const missions = new Map<string, ArgumentTrace>();

  async function observed<T>(traceId: string, spanId: string, parent: string | null, spaceTraceId: string | undefined,
    links: TraceLink[], execute: () => Promise<T>, emit: () => boolean = () => true): Promise<T> {
    const start = Date.now(); let outcome = "COMPLETED", reason: string | undefined, completed = true;
    try { return await execute(); }
    catch (error) {
      if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
      else if (!(error instanceof TemporalFailure)) completed = false; // Workflow Task retry, not execution failure.
      else {
        outcome = isCancellation(error) ? "CANCELLED" : "FAILED";
        const code = (error as { type?: unknown; code?: unknown } | null)?.type ?? (error as { code?: unknown } | null)?.code;
        reason = isSafeErrorCode(code) ? code : outcome === "CANCELLED" ? "WORKFLOW_CANCELLED" : "WORKFLOW_ERROR";
      }
      throw error;
    } finally {
      if (completed && emit()) {
        sink.spaceTracing.completed({ traceId, spanId, parentSpanId: parent, name: info.workflowType,
          startedMs: start, endedMs: Date.now(), error: outcome === "FAILED" || outcome === "CANCELLED", links,
          attributes: safeWorkerAttributes({ "space.workflow_id": info.workflowId, "space.run_id": info.runId,
            "space.workflow_type": info.workflowType, "space.trace_id": spaceTraceId, "space.outcome": outcome,
            "space.reason_code": reason, "space.category": reason ? categorizeFailureCode(reason) : undefined,
            "space.duration_ms": Math.max(0, Date.now() - start) }) });
        lastCompleted = { traceId, spanId };
      }
    }
  }

  installWorkflowRequestTracer(async (input, execute) => {
    scoped = true;
    const raw = input as { missionId?: unknown } | null;
    const missionId = traceIdentifier(raw?.missionId);
    const request = argumentTrace([input]);
    if (missionId && request.traceparent) missions.set(missionId, request);
    const source = request.traceparent ? request : (missionId ? missions.get(missionId) : undefined) ?? {};
    const parsed = parseTraceparent(source.traceparent), previous = carrier;
    const background = parseTraceparent(source.sourceTraceparent);
    const traceId = parsed?.traceId ?? traceIdForRun(`${info.runId}:${missionId ?? "background"}`);
    // Each execution (including PAUSED retries) has a distinct real span. A
    // background trace starts at a root; its source is a link, never a phantom parent.
    const spanId = spanIdFor(`request:${info.runId}:${++scopeSequence}`);
    const parent = source.background ? null : parsed?.parentId ?? null;
    carrier = { traceparent: formatTraceparent(traceId, spanId, parsed?.flags), spaceTraceId: source.traceId };
    const links = background ? [{ traceId: background.traceId, spanId: background.parentId }] : inheritedLink ? [inheritedLink] : [];
    try { return await observed(traceId, spanId, parent, source.traceId, links, execute); }
    finally {
      if (missionId) missions.set(missionId, { traceparent: carrier.traceparent, traceId: source.traceId });
      carrier = previous;
    }
  });

  return {
    inbound: [{ async execute(input, next) {
      const request = argumentTrace(input.args), received = readCarrier(input.headers);
      const parsed = parseTraceparent(received?.traceparent ?? request.traceparent ?? workflowInfo().memo?.traceparent);
      const source = parseTraceparent(request.sourceTraceparent);
      const backgroundRoot = !received && request.background;
      const spanId = runSpanId;
      parentSpanId = backgroundRoot ? null : parsed?.parentId ?? null;
      const traceId = parsed?.traceId ?? traceIdForRun(info.runId);
      carrier = { traceparent: formatTraceparent(traceId, spanId, parsed?.flags), spaceTraceId: received?.spaceTraceId ?? request.traceId };
      inheritedLink = received?.link;
      for (const [id, context] of Object.entries(received?.missions ?? {})) missions.set(id, context);
      const links = source ? [{ traceId: source.traceId, spanId: source.parentId }] : received?.link ? [received.link] : [];
      return observed(traceId, spanId, parentSpanId, carrier.spaceTraceId, links, () => next(input), () => !scoped);
    }}],
    outbound: [{
      scheduleActivity: (input, next) => next({ ...input, headers: withCarrier(input.headers, carrier) }),
      scheduleLocalActivity: (input, next) => next({ ...input, headers: withCarrier(input.headers, carrier) }),
      startChildWorkflowExecution: (input, next) => next({ ...input, headers: withCarrier(input.headers, carrier) }),
      continueAsNew: (input, next) => {
        const parsed = parseTraceparent(carrier.traceparent)!;
        const monitored = (input.args[0] as { monitoringMissionIds?: unknown } | null)?.monitoringMissionIds;
        const retained: Record<string, ArgumentTrace> = {};
        if (Array.isArray(monitored)) for (const id of monitored.slice(0, 100)) if (typeof id === "string" && missions.has(id)) retained[id] = missions.get(id)!;
        return next({ ...input, headers: withCarrier(input.headers, { ...carrier,
          traceparent: formatTraceparent(parsed.traceId, parentSpanId ?? runSpanId, parsed.flags),
          link: lastCompleted ?? { traceId: parsed.traceId, spanId: runSpanId }, missions: retained }) });
      }
    }]
  };
};
