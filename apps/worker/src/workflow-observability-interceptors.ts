import {
  ContinueAsNew,
  defaultPayloadConverter,
  isCancellation,
  proxySinks,
  rootCause,
  workflowInfo,
  type ActivityInput,
  type ConcludeActivationInput,
  type ConcludeActivationOutput,
  type ContinueAsNewInput,
  type Headers,
  type LocalActivityInput,
  type Next,
  type SignalInput,
  type Sinks,
  type StartChildWorkflowExecutionInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInternalsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  categorizeFailureCode,
  deterministicSpanId,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent
} from "@space/contracts";

export const SPACE_TRACE_HEADER = "space-trace-context";

export interface SpaceTraceLinkPayload {
  traceId: string;
  spanId: string;
  attributes?: Record<string, string | number>;
}

export interface SpaceTraceHeaderPayload {
  traceparent?: string;
  traceId?: string;
  parentTraceId?: string;
  roomId?: string;
  paneId?: string;
  missionId?: string;
  agentRunId?: string;
  continuationOfRunId?: string;
  continuationGeneration?: number;
  actionId?: string;
  goalId?: string;
  dotId?: string;
  turnId?: string;
  changeSetId?: string;
  consolidationRunId?: string;
  continuedFromSpanId?: string;
  continuedFromRunId?: string;
  links?: SpaceTraceLinkPayload[];
}

export interface WorkflowSpanRecordPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  error: boolean;
  attributes: Record<string, string | number>;
  links?: SpaceTraceLinkPayload[];
}

export interface WorkflowObservabilitySinks extends Sinks {
  observability: {
    recordWorkflowSpan(payload: WorkflowSpanRecordPayload): void;
  };
}

const { observability } = proxySinks<WorkflowObservabilitySinks>();

const idPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/;
const forbiddenTokenPattern = /^(?:https?:|file:|ws:|wss:|ftp:|sk-[A-Za-z0-9_-]{6,})/i;

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && idPattern.test(value) && !forbiddenTokenPattern.test(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function decodeSpaceTraceHeader(headers: Headers | undefined): SpaceTraceHeaderPayload | null {
  const raw = headers?.[SPACE_TRACE_HEADER];
  if (!raw) return null;
  try {
    const decoded = defaultPayloadConverter.fromPayload(raw);
    const record = asRecord(decoded);
    if (!record) return null;
    const links: SpaceTraceLinkPayload[] = [];
    if (Array.isArray(record.links)) {
      for (const entry of record.links) {
        const link = asRecord(entry);
        const parsed = link && typeof link.traceId === "string" && typeof link.spanId === "string"
          ? parseTraceparent(`00-${link.traceId}-${link.spanId}-01`)
          : null;
        if (!parsed) continue;
        const attrsRecord = asRecord(link?.attributes);
        const attributes: Record<string, string | number> = {};
        if (attrsRecord) {
          for (const [k, v] of Object.entries(attrsRecord)) {
            if (typeof v === "string" || typeof v === "number") attributes[k] = v;
          }
        }
        links.push({
          traceId: parsed.traceId,
          spanId: parsed.parentId,
          ...(Object.keys(attributes).length ? { attributes } : {})
        });
      }
    }
    const parsedTraceparent = parseTraceparent(record.traceparent);
    const generation = typeof record.continuationGeneration === "number" && Number.isInteger(record.continuationGeneration) && record.continuationGeneration > 0
      ? record.continuationGeneration
      : undefined;
    return {
      ...(parsedTraceparent ? { traceparent: formatTraceparent(parsedTraceparent.traceId, parsedTraceparent.parentId, parsedTraceparent.flags) } : {}),
      ...(safeId(record.traceId) ? { traceId: safeId(record.traceId)! } : {}),
      ...(safeId(record.parentTraceId) ? { parentTraceId: safeId(record.parentTraceId)! } : {}),
      ...(safeId(record.roomId) ? { roomId: safeId(record.roomId)! } : {}),
      ...(safeId(record.paneId) ? { paneId: safeId(record.paneId)! } : {}),
      ...(safeId(record.missionId) ? { missionId: safeId(record.missionId)! } : {}),
      ...(safeId(record.agentRunId) ? { agentRunId: safeId(record.agentRunId)! } : {}),
      ...(safeId(record.continuationOfRunId) ? { continuationOfRunId: safeId(record.continuationOfRunId)! } : {}),
      ...(generation !== undefined ? { continuationGeneration: generation } : {}),
      ...(safeId(record.actionId) ? { actionId: safeId(record.actionId)! } : {}),
      ...(safeId(record.goalId) ? { goalId: safeId(record.goalId)! } : {}),
      ...(safeId(record.dotId) ? { dotId: safeId(record.dotId)! } : {}),
      ...(safeId(record.turnId) ? { turnId: safeId(record.turnId)! } : {}),
      ...(safeId(record.changeSetId) ? { changeSetId: safeId(record.changeSetId)! } : {}),
      ...(safeId(record.consolidationRunId) ? { consolidationRunId: safeId(record.consolidationRunId)! } : {}),
      ...(safeId(record.continuedFromSpanId) ? { continuedFromSpanId: safeId(record.continuedFromSpanId)! } : {}),
      ...(safeId(record.continuedFromRunId) ? { continuedFromRunId: safeId(record.continuedFromRunId)! } : {}),
      ...(links.length ? { links } : {})
    };
  } catch {
    return null;
  }
}

export function encodeSpaceTraceHeader(headers: Headers, payload: SpaceTraceHeaderPayload): void {
  const encoded = defaultPayloadConverter.toPayload(payload);
  if (encoded) headers[SPACE_TRACE_HEADER] = encoded;
}

export function extractArgsTraceContext(args: readonly unknown[], workflowType?: string): SpaceTraceHeaderPayload {
  const out: SpaceTraceHeaderPayload = {};
  const links: SpaceTraceLinkPayload[] = [];
  const visit = (candidate: Record<string, unknown> | null) => {
    if (!candidate) return;
    const tp = parseTraceparent(candidate.traceparent);
    if (tp && !out.traceparent) out.traceparent = formatTraceparent(tp.traceId, tp.parentId, tp.flags);
    out.traceId ??= safeId(candidate.traceId);
    out.roomId ??= safeId(candidate.roomId);
    out.paneId ??= safeId(candidate.paneId) ?? safeId(candidate.agentPaneId);
    out.missionId ??= safeId(candidate.missionId) ?? safeId(candidate.roomAgentMissionId);
    out.agentRunId ??= safeId(candidate.agentRunId);
    out.actionId ??= safeId(candidate.actionId);
    out.goalId ??= safeId(candidate.goalId);
    out.dotId ??= safeId(candidate.dotId);
    out.turnId ??= safeId(candidate.turnId);
    out.changeSetId ??= safeId(candidate.changeSetId);
    if (workflowType === "memoryConsolidationWorkflow" || (typeof candidate.runId === "string" && candidate.runId.startsWith("memory_consolidation:"))) {
      out.consolidationRunId ??= safeId(candidate.runId);
    }
    const continuation = asRecord(candidate.roomAgentContinuation);
    if (continuation) {
      const sourceRunId = safeId(continuation.sourceRunId);
      const sourceTraceId = safeId(continuation.sourceTraceId);
      const generation = typeof continuation.generation === "number" && Number.isInteger(continuation.generation) && continuation.generation > 0
        ? continuation.generation
        : undefined;
      if (sourceRunId) out.continuationOfRunId ??= sourceRunId;
      if (generation !== undefined) out.continuationGeneration ??= generation;
      const sourceTp = parseTraceparent(continuation.sourceTraceparent);
      if (sourceTp) {
        links.push({
          traceId: sourceTp.traceId,
          spanId: sourceTp.parentId,
          attributes: {
            "space.link_type": "background_continuation",
            ...(sourceRunId ? { "space.source_run_id": sourceRunId } : {}),
            ...(sourceTraceId ? { "space.source_trace_id": sourceTraceId } : {}),
            ...(generation !== undefined ? { "space.continuation_generation": generation } : {})
          }
        });
      }
    }
  };

  for (const arg of args) {
    if (typeof arg === "string" && /^dot_goal:[A-Za-z0-9_-]{8,64}$/.test(arg)) {
      out.goalId ??= arg;
      continue;
    }
    const record = asRecord(arg);
    if (!record) continue;
    visit(record);
    visit(asRecord(record.turn));
    const item = asRecord(record.item);
    visit(item);
    visit(asRecord(item?.turn));
    const queueItem = asRecord(record.queueItem);
    visit(queueItem);
    visit(asRecord(queueItem?.turn));
    const bridge = asRecord(record.bridge);
    if (bridge) {
      out.parentTraceId ??= safeId(bridge.requestId);
      visit(bridge);
    }
  }
  if (links.length) out.links = links;
  return out;
}

function extractMemoTraceContext(memo: Record<string, unknown> | undefined): SpaceTraceHeaderPayload {
  if (!memo) return {};
  const readField = (key: string): unknown => {
    const raw = memo[key];
    const record = asRecord(raw);
    if (record && "metadata" in record && "data" in record) {
      try {
        return defaultPayloadConverter.fromPayload(raw as never);
      } catch {
        return undefined;
      }
    }
    return raw;
  };
  const tp = parseTraceparent(readField("traceparent"));
  const traceId = safeId(readField("spaceTraceId"));
  const parentTraceId = safeId(readField("parentSpaceTraceId"));
  const missionId = safeId(readField("missionId"));
  return {
    ...(tp ? { traceparent: formatTraceparent(tp.traceId, tp.parentId, tp.flags) } : {}),
    ...(traceId ? { traceId } : {}),
    ...(parentTraceId ? { parentTraceId } : {}),
    ...(missionId ? { missionId } : {})
  };
}

function mergeLinks(
  first: readonly SpaceTraceLinkPayload[] | undefined,
  second: readonly SpaceTraceLinkPayload[] | undefined
): SpaceTraceLinkPayload[] | undefined {
  const combined = [...(first ?? []), ...(second ?? [])];
  if (!combined.length) return undefined;
  const seen = new Set<string>();
  const deduped: SpaceTraceLinkPayload[] = [];
  for (const link of combined) {
    const key = `${link.traceId}:${link.spanId}:${link.attributes?.["space.link_type"] ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}

export function mergeTraceContexts(...contexts: Array<SpaceTraceHeaderPayload | null | undefined>): SpaceTraceHeaderPayload {
  const merged: SpaceTraceHeaderPayload = {};
  let links: SpaceTraceLinkPayload[] | undefined;
  for (const ctx of contexts) {
    if (!ctx) continue;
    merged.traceparent ??= ctx.traceparent;
    merged.traceId ??= ctx.traceId;
    merged.parentTraceId ??= ctx.parentTraceId;
    merged.roomId ??= ctx.roomId;
    merged.paneId ??= ctx.paneId;
    merged.missionId ??= ctx.missionId;
    merged.agentRunId ??= ctx.agentRunId;
    merged.continuationOfRunId ??= ctx.continuationOfRunId;
    merged.continuationGeneration ??= ctx.continuationGeneration;
    merged.actionId ??= ctx.actionId;
    merged.goalId ??= ctx.goalId;
    merged.dotId ??= ctx.dotId;
    merged.turnId ??= ctx.turnId;
    merged.changeSetId ??= ctx.changeSetId;
    merged.consolidationRunId ??= ctx.consolidationRunId;
    merged.continuedFromSpanId ??= ctx.continuedFromSpanId;
    merged.continuedFromRunId ??= ctx.continuedFromRunId;
    links = mergeLinks(links, ctx.links);
  }
  if (links?.length) merged.links = links;
  return merged;
}

function continueAsNewLinks(ctx: SpaceTraceHeaderPayload, continuedFromRunId?: string): SpaceTraceLinkPayload[] | undefined {
  const tp = parseTraceparent(ctx.traceparent);
  const continuedSpanId = ctx.continuedFromSpanId;
  const runId = ctx.continuedFromRunId ?? continuedFromRunId;
  const extra: SpaceTraceLinkPayload[] = [];
  if (tp && continuedSpanId && /^[0-9a-f]{16}$/.test(continuedSpanId)) {
    extra.push({
      traceId: tp.traceId,
      spanId: continuedSpanId,
      attributes: {
        "space.link_type": "continue_as_new",
        ...(runId && safeId(runId) ? { "space.source_run_id": runId } : {})
      }
    });
  }
  return mergeLinks(ctx.links, extra);
}

function buildWorkflowSpanAttributes(
  ctx: SpaceTraceHeaderPayload,
  outcome: string,
  durationMs: number,
  reasonCode: string | null
): Record<string, string | number> {
  const info = workflowInfo();
  const attributes: Record<string, string | number> = {
    "space.workflow_type": info.workflowType,
    "space.workflow_id": info.workflowId,
    "space.run_id": info.runId,
    "space.task_queue": info.taskQueue,
    "space.attempt": info.attempt,
    "space.outcome": outcome,
    "space.duration_ms": Math.max(0, Math.round(durationMs))
  };
  if (info.parent) {
    if (safeId(info.parent.workflowId)) attributes["space.parent_workflow_id"] = info.parent.workflowId;
    if (safeId(info.parent.runId)) attributes["space.parent_run_id"] = info.parent.runId;
  }
  const continuedRunId = ctx.continuedFromRunId ?? info.continuedFromExecutionRunId;
  if (continuedRunId && safeId(continuedRunId)) {
    attributes["space.continued_from_run_id"] = continuedRunId;
  }
  if (ctx.traceId) attributes["space.trace_id"] = ctx.traceId;
  if (ctx.parentTraceId) attributes["space.parent_trace_id"] = ctx.parentTraceId;
  if (ctx.roomId) attributes["space.room_id"] = ctx.roomId;
  if (ctx.paneId) attributes["space.pane_id"] = ctx.paneId;
  if (ctx.missionId) attributes["space.mission_id"] = ctx.missionId;
  if (ctx.agentRunId) attributes["space.agent_run_id"] = ctx.agentRunId;
  if (ctx.continuationOfRunId) attributes["space.continuation_of_run_id"] = ctx.continuationOfRunId;
  if (ctx.continuationGeneration !== undefined) attributes["space.continuation_generation"] = ctx.continuationGeneration;
  if (ctx.actionId) attributes["space.action_id"] = ctx.actionId;
  if (ctx.goalId) attributes["space.goal_id"] = ctx.goalId;
  if (ctx.dotId) attributes["space.dot_id"] = ctx.dotId;
  if (ctx.turnId) attributes["space.turn_id"] = ctx.turnId;
  if (ctx.changeSetId) attributes["space.change_set_id"] = ctx.changeSetId;
  if (ctx.consolidationRunId) attributes["space.consolidation_run_id"] = ctx.consolidationRunId;
  if (reasonCode && isSafeErrorCode(reasonCode)) {
    attributes["space.reason_code"] = reasonCode;
    attributes["space.error_code"] = reasonCode;
    attributes["space.category"] = categorizeFailureCode(reasonCode);
  }
  return attributes;
}

function classifyWorkflowResult(result: unknown): { outcome: string; error: boolean; reasonCode: string | null } {
  const record = asRecord(result);
  if (record && (record.status === "FAILED" || record.status === "OPERATOR_REQUIRED")) {
    const code = [record.reasonCode, record.errorCode, record.code].find(isSafeErrorCode) ?? null;
    return { outcome: "FAILED_RESULT", error: true, reasonCode: code };
  }
  return { outcome: "COMPLETED", error: false, reasonCode: null };
}

function classifyWorkflowError(err: unknown): { outcome: string; error: boolean; reasonCode: string | null } {
  if (err instanceof ContinueAsNew || (err as { name?: string } | null)?.name === "ContinueAsNew") {
    return { outcome: "CONTINUED_AS_NEW", error: false, reasonCode: null };
  }
  if (isCancellation(err)) {
    return { outcome: "CANCELLED", error: false, reasonCode: "WORKFLOW_CANCELLED" };
  }
  const cause = rootCause(err);
  for (const candidate of [err, cause]) {
    const rec = asRecord(candidate);
    if (!rec) continue;
    for (const field of [rec.code, rec.type, rec.reasonCode, rec.errorCode]) {
      if (isSafeErrorCode(field)) return { outcome: "FAILED", error: true, reasonCode: field };
    }
  }
  return { outcome: "FAILED", error: true, reasonCode: "WORKFLOW_ERROR" };
}

interface ActiveSupervisorTurnSpan {
  turnKey: string;
  spanId: string;
  context: SpaceTraceHeaderPayload;
  startTimeMs: number;
  inFlightActivities: number;
  inFlightChildren: number;
  childCompleted: boolean;
  discardCompleted: boolean;
  finishCompleted: boolean;
  outcome: string;
  error: boolean;
  reasonCode: string | null;
  emitted: boolean;
}

const supervisorTurnTerminalActivities = new Set([
  "finishRoomAgentSupervisorTurn",
  "markRoomAgentMissionFinished",
  "markRoomAgentMissionContinued"
]);

export const interceptors: WorkflowInterceptorsFactory = () => {
  let workflowContext: SpaceTraceHeaderPayload = {};
  let workflowSpanId = "";
  let workflowStartTimeMs = 0;
  let continueAsNewCarryIncluded = false;

  // Room Agent Supervisor per-mission-turn span state.
  const missionContexts = new Map<string, SpaceTraceHeaderPayload>();
  let activeTurn: ActiveSupervisorTurnSpan | null = null;

  const emitSpan = (
    ctx: SpaceTraceHeaderPayload,
    spanId: string,
    startTimeMs: number,
    endTimeMs: number,
    outcome: string,
    error: boolean,
    reasonCode: string | null,
    links: SpaceTraceLinkPayload[] | undefined
  ) => {
    const parsed = parseTraceparent(ctx.traceparent);
    if (!parsed) return;
    observability.recordWorkflowSpan({
      traceId: parsed.traceId,
      spanId,
      parentSpanId: parsed.parentId,
      name: `workflow ${workflowInfo().workflowType}`,
      startTimeMs,
      endTimeMs: Math.max(startTimeMs, endTimeMs),
      error,
      attributes: buildWorkflowSpanAttributes(ctx, outcome, Math.max(0, endTimeMs - startTimeMs), reasonCode),
      ...(links?.length ? { links } : {})
    });
  };

  const flushActiveSupervisorTurn = () => {
    if (!activeTurn || activeTurn.emitted) return;
    activeTurn.emitted = true;
    const turn = activeTurn;
    activeTurn = null;
    const links = !continueAsNewCarryIncluded
      ? continueAsNewLinks(
          mergeTraceContexts(turn.context, {
            continuedFromSpanId: workflowContext.continuedFromSpanId,
            continuedFromRunId: workflowContext.continuedFromRunId
          }),
          workflowInfo().continuedFromExecutionRunId
        )
      : turn.context.links;
    continueAsNewCarryIncluded = true;
    emitSpan(turn.context, turn.spanId, turn.startTimeMs, Date.now(), turn.outcome, turn.error, turn.reasonCode, links);
  };

  const ensureSupervisorTurnSpan = (callCtx: SpaceTraceHeaderPayload): ActiveSupervisorTurnSpan | null => {
    const info = workflowInfo();
    const missionId =
      callCtx.missionId ??
      (activeTurn && (!callCtx.traceId || callCtx.traceId === activeTurn.context.traceId)
        ? activeTurn.context.missionId
        : undefined);
    const merged = mergeTraceContexts(
      callCtx,
      missionId ? missionContexts.get(missionId) : undefined,
      workflowContext
    );
    if (!parseTraceparent(merged.traceparent)) return null;
    const turnKey = merged.agentRunId ?? `${merged.missionId ?? "mission"}:${merged.traceId ?? "trace"}`;
    if (activeTurn && activeTurn.turnKey !== turnKey) {
      flushActiveSupervisorTurn();
    }
    if (!activeTurn) {
      const spanId = deterministicSpanId(`workflow:${info.workflowId}:${info.runId}:${turnKey}`);
      activeTurn = {
        turnKey,
        spanId,
        context: merged,
        startTimeMs: Date.now(),
        inFlightActivities: 0,
        inFlightChildren: 0,
        childCompleted: false,
        discardCompleted: false,
        finishCompleted: false,
        outcome: "COMPLETED",
        error: false,
        reasonCode: null,
        emitted: false
      };
    } else {
      activeTurn.context = mergeTraceContexts(activeTurn.context, merged);
    }
    if (activeTurn.context.missionId) {
      missionContexts.set(activeTurn.context.missionId, activeTurn.context);
    }
    return activeTurn;
  };

  const childContextHeader = (baseCtx: SpaceTraceHeaderPayload, parentSpanId: string): SpaceTraceHeaderPayload | null => {
    const parsed = parseTraceparent(baseCtx.traceparent);
    if (!parsed) return null;
    return {
      ...baseCtx,
      traceparent: formatTraceparent(parsed.traceId, parentSpanId, parsed.flags)
    };
  };

  const rememberSupervisorItemsFromArgs = (args: readonly unknown[]) => {
    for (const arg of args) {
      const rec = asRecord(arg);
      if (!rec) continue;
      const items: unknown[] = [
        rec,
        ...(Array.isArray(rec.pending) ? rec.pending : []),
        ...(Array.isArray(rec.interrupted) ? rec.interrupted.map((entry) => asRecord(entry)?.item) : [])
      ];
      for (const item of items) {
        const itemCtx = extractArgsTraceContext([item], "roomAgentSupervisorWorkflow");
        if (itemCtx.missionId && parseTraceparent(itemCtx.traceparent)) {
          missionContexts.set(itemCtx.missionId, mergeTraceContexts(itemCtx, workflowContext));
        }
      }
    }
  };

  const inbound: WorkflowInboundCallsInterceptor = {
    async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
      const info = workflowInfo();
      workflowStartTimeMs = Date.now();
      workflowSpanId = deterministicSpanId(`workflow:${info.workflowId}:${info.runId}`);
      const headerCtx = decodeSpaceTraceHeader(input.headers);
      const argsCtx = extractArgsTraceContext(input.args, info.workflowType);
      const memoCtx = extractMemoTraceContext(info.memo);
      workflowContext = mergeTraceContexts(headerCtx, argsCtx, memoCtx);

      if (info.workflowType === "roomAgentSupervisorWorkflow") {
        rememberSupervisorItemsFromArgs(input.args);
      }

      try {
        const result = await next(input);
        if (info.workflowType === "roomAgentSupervisorWorkflow") {
          flushActiveSupervisorTurn();
        } else {
          const classified = classifyWorkflowResult(result);
          emitSpan(
            workflowContext,
            workflowSpanId,
            workflowStartTimeMs,
            Date.now(),
            classified.outcome,
            classified.error,
            classified.reasonCode,
            continueAsNewLinks(workflowContext, info.continuedFromExecutionRunId)
          );
        }
        return result;
      } catch (err) {
        const classified = classifyWorkflowError(err);
        if (info.workflowType === "roomAgentSupervisorWorkflow") {
          if (activeTurn) {
            if (classified.error || classified.outcome === "CANCELLED") {
              activeTurn.outcome = classified.outcome;
              activeTurn.error = classified.error;
              activeTurn.reasonCode = classified.reasonCode;
            }
            flushActiveSupervisorTurn();
          }
        } else {
          emitSpan(
            workflowContext,
            workflowSpanId,
            workflowStartTimeMs,
            Date.now(),
            classified.outcome,
            classified.error,
            classified.reasonCode,
            continueAsNewLinks(workflowContext, info.continuedFromExecutionRunId)
          );
        }
        throw err;
      }
    },

    async handleSignal(input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, "handleSignal">): Promise<void> {
      if (workflowInfo().workflowType === "roomAgentSupervisorWorkflow") {
        const headerCtx = decodeSpaceTraceHeader(input.headers);
        const signalCtx = mergeTraceContexts(headerCtx, extractArgsTraceContext(input.args, "roomAgentSupervisorWorkflow"));
        if (signalCtx.missionId && parseTraceparent(signalCtx.traceparent)) {
          missionContexts.set(signalCtx.missionId, mergeTraceContexts(signalCtx, workflowContext));
        }
      }
      return next(input);
    }
  };

  const outbound: WorkflowOutboundCallsInterceptor = {
    async scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">): Promise<unknown> {
      const info = workflowInfo();
      const callCtx = extractArgsTraceContext(input.args, info.workflowType);

      if (info.workflowType === "roomAgentSupervisorWorkflow") {
        if (input.activityType === "prepareRoomAgentBackgroundContinuation" || input.activityType === "settleRoomAgentBackgroundMission") {
          const stored = callCtx.missionId ? missionContexts.get(callCtx.missionId) : undefined;
          const base = mergeTraceContexts(callCtx, stored, workflowContext);
          const parentSpan = activeTurn?.spanId ?? (callCtx.missionId ? deterministicSpanId(`workflow:${info.workflowId}:${info.runId}:${callCtx.missionId}:${base.traceId ?? "trace"}`) : workflowSpanId);
          const header = childContextHeader(base, parentSpan);
          if (header) encodeSpaceTraceHeader(input.headers, header);
          const res = await next(input);
          const resRec = asRecord(res);
          if (resRec?.state === "READY" && resRec.item) {
            const readyCtx = extractArgsTraceContext([resRec.item], "roomAgentSupervisorWorkflow");
            if (readyCtx.missionId && parseTraceparent(readyCtx.traceparent)) {
              missionContexts.set(readyCtx.missionId, readyCtx);
            }
          }
          return res;
        }

        const turnSpan = ensureSupervisorTurnSpan(callCtx);
        if (turnSpan) {
          const header = childContextHeader(turnSpan.context, turnSpan.spanId);
          if (header) encodeSpaceTraceHeader(input.headers, header);
          turnSpan.inFlightActivities += 1;
          try {
            const res = await next(input);
            if (input.activityType === "discardRoomAgentSupervisorTurn") {
              turnSpan.discardCompleted = true;
            }
            if (supervisorTurnTerminalActivities.has(input.activityType)) {
              const statusArg = asRecord(input.args[0])?.status;
              if (statusArg === "FAILED") {
                turnSpan.outcome = "FAILED_RESULT";
                turnSpan.error = true;
              } else if (statusArg === "INTERRUPTED") {
                turnSpan.outcome = "CANCELLED";
                turnSpan.reasonCode = "ROOM_AGENT_STOPPED";
              }
              turnSpan.finishCompleted = true;
            }
            return res;
          } catch (err) {
            const classified = classifyWorkflowError(err);
            turnSpan.outcome = classified.outcome;
            turnSpan.error = classified.error;
            turnSpan.reasonCode = classified.reasonCode;
            throw err;
          } finally {
            turnSpan.inFlightActivities = Math.max(0, turnSpan.inFlightActivities - 1);
            if (turnSpan.finishCompleted && turnSpan.inFlightActivities === 0 && turnSpan.inFlightChildren === 0) {
              flushActiveSupervisorTurn();
            }
          }
        }
      }

      workflowContext = mergeTraceContexts(workflowContext, callCtx);
      const header = childContextHeader(mergeTraceContexts(callCtx, workflowContext), workflowSpanId);
      if (header) encodeSpaceTraceHeader(input.headers, header);
      return next(input);
    },

    async scheduleLocalActivity(input: LocalActivityInput, next: Next<WorkflowOutboundCallsInterceptor, "scheduleLocalActivity">): Promise<unknown> {
      const info = workflowInfo();
      const callCtx = extractArgsTraceContext(input.args, info.workflowType);
      workflowContext = mergeTraceContexts(workflowContext, callCtx);
      const header = childContextHeader(mergeTraceContexts(callCtx, workflowContext), workflowSpanId);
      if (header) encodeSpaceTraceHeader(input.headers, header);
      return next(input);
    },

    async startChildWorkflowExecution(
      input: StartChildWorkflowExecutionInput,
      next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">
    ): Promise<[Promise<string>, Promise<unknown>]> {
      const info = workflowInfo();
      const callCtx = extractArgsTraceContext(input.options.args ?? [], input.workflowType);

      if (info.workflowType === "roomAgentSupervisorWorkflow") {
        const turnSpan = ensureSupervisorTurnSpan(callCtx);
        if (turnSpan) {
          const header = childContextHeader(turnSpan.context, turnSpan.spanId);
          if (header) encodeSpaceTraceHeader(input.headers, header);
          turnSpan.inFlightChildren += 1;
          const [started, completed] = await next(input);
          const trackedCompleted = completed.then(
            (res) => {
              turnSpan.inFlightChildren = Math.max(0, turnSpan.inFlightChildren - 1);
              turnSpan.childCompleted = true;
              const classified = classifyWorkflowResult(res);
              if (classified.error) {
                turnSpan.outcome = classified.outcome;
                turnSpan.error = true;
                turnSpan.reasonCode = classified.reasonCode;
              }
              return res;
            },
            (err) => {
              turnSpan.inFlightChildren = Math.max(0, turnSpan.inFlightChildren - 1);
              turnSpan.childCompleted = true;
              const classified = classifyWorkflowError(err);
              turnSpan.outcome = classified.outcome;
              turnSpan.error = classified.error;
              turnSpan.reasonCode = classified.reasonCode;
              throw err;
            }
          );
          return [started, trackedCompleted];
        }
      }

      workflowContext = mergeTraceContexts(workflowContext, callCtx);
      const header = childContextHeader(mergeTraceContexts(callCtx, workflowContext), workflowSpanId);
      if (header) encodeSpaceTraceHeader(input.headers, header);
      return next(input);
    },

    async continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">): Promise<never> {
      const info = workflowInfo();
      const callCtx = extractArgsTraceContext(input.args, input.options.workflowType);
      const latestMissionCtx = missionContexts.size ? Array.from(missionContexts.values()).at(-1) : undefined;
      const continuedFromSpanId = activeTurn?.spanId ?? workflowSpanId;
      if (info.workflowType === "roomAgentSupervisorWorkflow") {
        flushActiveSupervisorTurn();
      }
      const nextCtx = mergeTraceContexts(callCtx, workflowContext, latestMissionCtx);
      if (parseTraceparent(nextCtx.traceparent)) {
        encodeSpaceTraceHeader(input.headers, {
          ...nextCtx,
          continuedFromSpanId,
          continuedFromRunId: info.runId
        });
      }
      return next(input);
    }
  };

  const internals: WorkflowInternalsInterceptor = {
    concludeActivation(input: ConcludeActivationInput, next: Next<WorkflowInternalsInterceptor, "concludeActivation">): ConcludeActivationOutput {
      const output = next(input);
      if (
        activeTurn &&
        (activeTurn.childCompleted || activeTurn.discardCompleted || activeTurn.finishCompleted) &&
        activeTurn.inFlightActivities === 0 &&
        activeTurn.inFlightChildren === 0
      ) {
        flushActiveSupervisorTurn();
      }
      return output;
    }
  };

  return {
    inbound: [inbound],
    outbound: [outbound],
    internals: [internals]
  };
};
