import { ContinueAsNew, isCancellation, proxySinks, workflowInfo, type WorkflowInterceptors } from "@temporalio/workflow";
import { categorizeFailureCode, formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";
import { inputTraceContext, readTraceHeader, traceHeader, TRACE_HEADER, TRACE_LINK_HEADER, workflowSpanId, type TraceHeaders } from "./trace-propagation.js";
import { workerSpanAttributes, type WorkflowSpanRecord } from "./workflow-span.js";

export type WorkflowTracingSinks = { spaceTracing: { record(span: WorkflowSpanRecord): void } };

/** Pure deterministic interceptor. Only the replay-suppressed sink crosses the sandbox boundary. */
export function createWorkflowObservabilityInterceptors(): WorkflowInterceptors {
  const sink = proxySinks<WorkflowTracingSinks>().spaceTracing;
  let context: string | null = null;
  let parentContext: string | null = null;
  type MissionSegment = { context: string; parent: string | null; missionId: string; roomId?: string; paneId?: string;
    startedAt: number; links: Array<{ traceId: string; spanId: string }>; closed: boolean; checked: boolean; skipped: boolean };
  const segments = new Map<string, MissionSegment>();
  const missionSegments = new Map<string, MissionSegment>();
  const signaledContexts = new Map<string, Record<string, string>>();
  /** Read only bounded identifier fields from known activity and mission containers. */
  const identifiers = (args: readonly unknown[]) => {
    const found: Record<string, string> = {};
    const read = (value: unknown, depth: number) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      for (const key of ["missionId", "roomAgentMissionId", "roomId", "paneId"]) {
        const value = record[key];
        if (typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value)) found[key] ??= value;
      }
      if (depth) for (const key of ["item", "turn", "input", "turnInput", "bridge"]) read(record[key], depth - 1);
    };
    for (const arg of args) read(arg, 3);
    return { missionId: found.missionId ?? found.roomAgentMissionId, roomId: found.roomId, paneId: found.paneId };
  };
  /** Reuse or create a bounded request segment when a supervisor handles later or background work. */
  const segmentFor = (args: readonly unknown[]): MissionSegment | null => {
    if (workflowInfo().workflowType !== "roomAgentSupervisorWorkflow" || !context) return null;
    const ids = identifiers(args);
    if (!ids.missionId) return null;
    const signaled = signaledContexts.get(ids.missionId);
    const explicit = inputTraceContext(args);
    const existing = missionSegments.get(ids.missionId);
    if (!explicit && existing && !existing.closed) return existing;
    const incoming = explicit ?? signaled?.traceparent ?? null;
    if (!incoming) return missionSegments.get(ids.missionId) ?? null;
    const requested = parseTraceparent(incoming)!;
    const runParent = parseTraceparent(parentContext);
    // The first request already owns the execution span. Later requests need
    // a recorded workflow segment in their own API ancestry.
    const traceLink = inputTraceContext(args, "traceLink") ?? (!explicit ? signaled?.traceLink : null);
    if (runParent?.traceId === requested.traceId && runParent.parentId === requested.parentId && !traceLink) return null;
    const key = `${ids.missionId}:${incoming}`;
    let segment = segments.get(key);
    if (!segment) {
      // Normal supervisor runs continue after 50 processed turns. Keep a hard
      // bound as well for unusual histories; discard only completed entries.
      if (segments.size >= 512) {
        const oldest = [...segments.entries()].find(([, value]) => value.closed);
        if (!oldest) return null;
        segments.delete(oldest[0]);
        if (missionSegments.get(oldest[1].missionId) === oldest[1]) missionSegments.delete(oldest[1].missionId);
      }
      const supervisor = parseTraceparent(context)!;
      const continuation = parseTraceparent(traceLink);
      segment = { context: formatTraceparent(requested.traceId, workflowSpanId(`${workflowInfo().runId}:mission:${key}`), requested.flags),
        parent: continuation ? null : incoming, missionId: ids.missionId, roomId: ids.roomId, paneId: ids.paneId,
        startedAt: Date.now(), closed: false, checked: false, skipped: false,
        links: [{ traceId: supervisor.traceId, spanId: supervisor.parentId },
          ...(continuation ? [{ traceId: continuation.traceId, spanId: continuation.parentId }] : [])] };
      segments.set(key, segment);
    }
    missionSegments.set(ids.missionId, segment);
    return segment;
  };
  /** Emit a mission segment once in this execution, with allowlisted outcomes and failure codes. */
  const closeSegment = (segment: MissionSegment | null, outcome: string, reasonCode?: unknown) => {
    if (!segment || segment.closed) return;
    segment.closed = true;
    try {
      const info = workflowInfo();
      const parsed = parseTraceparent(segment.context)!;
      const endTimeMs = Date.now();
      sink.record({ traceId: parsed.traceId, spanId: parsed.parentId,
        parentSpanId: parseTraceparent(segment.parent)?.parentId ?? null,
        startTimeMs: segment.startedAt, endTimeMs, error: outcome === "FAILED" || outcome === "FAILED_RESULT",
        attributes: workerSpanAttributes({ "space.workflow_id": info.workflowId, "space.run_id": info.runId,
          "space.workflow_type": info.workflowType, "space.mission_id": segment.missionId,
          "space.room_id": segment.roomId, "space.pane_id": segment.paneId,
          "space.outcome": outcome, "space.duration_ms": Math.max(0, endTimeMs - segment.startedAt),
          ...(isSafeErrorCode(reasonCode) ? { "space.reason_code": reasonCode, "space.category": categorizeFailureCode(reasonCode) } : {}) }),
        links: segment.links });
    } catch { /* Tracing never changes the supervisor's result. */ }
  };
  /** Preserve unrelated headers while supplying the active parent and optional prior-run link. */
  const headersFor = (headers: TraceHeaders, link = false, parent = context): TraceHeaders => parent ? {
    ...headers, [TRACE_HEADER]: traceHeader(parent), ...(link ? { [TRACE_LINK_HEADER]: traceHeader(parent) } : {})
  } : headers;
  return {
    inbound: [{
      /** Wrap the workflow execution and emit its terminal span through the replay-suppressed sink. */
      async execute(input, next) {
        const info = workflowInfo();
        const inbound = readTraceHeader(input.headers) ?? inputTraceContext(input.args) ?? parentContext ??
          (parseTraceparent(info.memo?.traceparent) ? info.memo!.traceparent as string : null);
        parentContext = inbound;
        const parent = parseTraceparent(inbound);
        const spanId = workflowSpanId(info.runId);
        const traceId = parent?.traceId ?? (workflowSpanId(`trace:${info.runId}`) + workflowSpanId(`root:${info.runId}`));
        context = formatTraceparent(traceId, spanId, parent?.flags ?? "01");
        const startedAt = Date.now();
        const link = parseTraceparent(readTraceHeader(input.headers, TRACE_LINK_HEADER) ?? inputTraceContext(input.args, "traceLink"));
        // A background continuation opens a trace, rather than inventing an
        // unrecorded parent. Later continue-as-new headers name the real prior run.
        const backgroundRoot = Boolean(inputTraceContext(input.args, "traceLink")) && inbound === inputTraceContext(input.args);
        let outcome = "COMPLETED";
        let reasonCode: string | null = null;
        try {
          const result = await next(input);
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") {
            outcome = "FAILED_RESULT";
            const code = (result as { reasonCode?: unknown; errorCode?: unknown }).reasonCode ?? (result as { errorCode?: unknown }).errorCode;
            reasonCode = isSafeErrorCode(code) ? code : "WORKFLOW_RESULT_FAILED";
          }
          return result;
        } catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else {
            outcome = isCancellation(error) ? "CANCELLED" : "FAILED";
            const record = error as { code?: unknown; type?: unknown; cause?: { type?: unknown; code?: unknown } } | null;
            const code = record?.code ?? record?.type ?? record?.cause?.code ?? record?.cause?.type;
            reasonCode = isSafeErrorCode(code) ? code : outcome === "CANCELLED" ? "WORKFLOW_CANCELLED" : "WORKFLOW_ERROR";
          }
          throw error;
        } finally {
          for (const segment of segments.values()) closeSegment(segment, outcome, reasonCode);
          try {
            const endTimeMs = Date.now();
            sink.record({ traceId: parseTraceparent(context)?.traceId ?? traceId, spanId,
              parentSpanId: backgroundRoot ? null : parseTraceparent(parentContext)?.parentId ?? null,
              startTimeMs: startedAt, endTimeMs, error: outcome === "FAILED" || outcome === "FAILED_RESULT",
              attributes: workerSpanAttributes({ "space.workflow_id": info.workflowId, "space.run_id": info.runId,
                "space.workflow_type": info.workflowType, "space.outcome": outcome,
                "space.duration_ms": Math.max(0, endTimeMs - startedAt),
                ...(reasonCode ? { "space.reason_code": reasonCode, "space.category": categorizeFailureCode(reasonCode) } : {}) }),
              ...(link ? { links: [{ traceId: link.traceId, spanId: link.parentId }] } : {}) });
          } catch { /* Instrumentation cannot replace a workflow result or failure. */ }
        }
      },
      /** Retain bounded request contexts for signal-started and subsequent supervisor missions. */
      async handleSignal(input, next) {
        // signalWithStart supervisors receive their first request in signalArgs
        // rather than workflow args. The first request establishes ancestry;
        // subsequent requests keep their own child context in the outbound hook.
        const incoming = readTraceHeader(input.headers) ?? inputTraceContext(input.args);
        if (!parentContext && incoming) {
          parentContext = incoming;
          const parsed = parseTraceparent(incoming)!;
          context = formatTraceparent(parsed.traceId, workflowSpanId(workflowInfo().runId), parsed.flags);
        }
        const ids = identifiers(input.args);
        if (ids.missionId && incoming) {
          const traceLink = inputTraceContext(input.args, "traceLink");
          signaledContexts.delete(ids.missionId);
          signaledContexts.set(ids.missionId, { traceparent: incoming, ...(traceLink ? { traceLink } : {}) });
          if (signaledContexts.size > 100) signaledContexts.delete(signaledContexts.keys().next().value!);
        }
        return next(input);
      }
    }],
    outbound: [{
      /** Parent each activity attempt to its mission segment and close segments at lifecycle boundaries. */
      scheduleActivity: async (input, next) => {
        const segment = segmentFor(input.args);
        if (segment && input.activityType === "checkRoomAgentSupervisorTurn") segment.checked = true;
        const result = await next({ ...input, headers: headersFor(input.headers, false, segment?.context ?? context) });
        if (segment && input.activityType === "checkRoomAgentSupervisorTurn") segment.skipped = result === "SKIP";
        if (["finishRoomAgentSupervisorTurn", "markRoomAgentMissionFinished"].includes(input.activityType) ||
          (input.activityType === "discardRoomAgentSupervisorTurn" && segment && (segment.skipped || !segment.checked))) {
          const details = input.args[0] as { status?: unknown; errorCode?: unknown } | null;
          const outcome = details?.status === "FAILED" || isSafeErrorCode(details?.errorCode) ? "FAILED" :
            input.activityType === "discardRoomAgentSupervisorTurn" || details?.status === "INTERRUPTED" ? "CANCELLED" : "COMPLETED";
          closeSegment(segment, outcome, details?.errorCode);
        }
        if (input.activityType === "prepareRoomAgentBackgroundContinuation" && result && typeof result === "object" &&
          ["DONE", "READY"].includes((result as { state: string }).state)) closeSegment(segment, "COMPLETED");
        return result;
      },
      /** Apply the same parent selection to local activities without adding workflow commands. */
      scheduleLocalActivity: (input, next) => next({ ...input, headers: headersFor(input.headers, false, segmentFor(input.args)?.context ?? context) }),
      /** Nest children under their request segment and preserve explicit background continuation links. */
      startChildWorkflowExecution: (input, next) => {
        const segment = segmentFor(input.options.args);
        if (segment) return next({ ...input, headers: headersFor(input.headers, false, segment.context) });
        // A long-lived supervisor can dispatch a later request or a background
        // trace. Keep that request's ancestry and link it to the supervisor.
        const explicit = inputTraceContext(input.options.args);
        const own = parseTraceparent(context);
        const requested = parseTraceparent(explicit);
        const headers = own && requested && requested.traceId !== own.traceId
          ? { ...input.headers, [TRACE_HEADER]: traceHeader(explicit!), [TRACE_LINK_HEADER]: traceHeader(context!) }
          : headersFor(input.headers);
        const continuation = inputTraceContext(input.options.args, "traceLink");
        if (continuation) headers[TRACE_LINK_HEADER] = traceHeader(continuation);
        return next({ ...input, headers });
      },
      /** Carry current ancestry plus a causal link to this run into the next execution. */
      continueAsNew: (input, next) => next({ ...input, headers: headersFor(input.headers, true) })
    }]
  };
}

export const interceptors = createWorkflowObservabilityInterceptors;
