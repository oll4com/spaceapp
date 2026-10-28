import {
  defaultPayloadConverter,
  isCancellation,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type Headers,
  type LocalActivityInput,
  type Next,
  type SignalInput,
  type Sinks,
  type StartChildWorkflowExecutionInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  categorizeFailureCode,
  formatTraceparent,
  isSafeErrorCode,
  parseTraceparent
} from "@space/contracts";

export const WORKFLOW_TRACEPARENT_HEADER = "space-traceparent";
export const WORKFLOW_CONTINUED_TRACEPARENT_HEADER = "space-continued-from-traceparent";
export const WORKFLOW_TRACE_ID_HEADER = "space-trace-id";

export interface WorkflowSpanLinkRecord {
  traceId: string;
  spanId: string;
  attributes?: Record<string, string | number>;
}

export interface WorkflowSpanRecordPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workflowType: string;
  workflowId: string;
  runId: string;
  parentWorkflowId: string | null;
  parentRunId: string | null;
  continuedFromRunId: string | null;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  reasonCode: string | null;
  category: string | null;
  correlation: Record<string, string>;
  links: WorkflowSpanLinkRecord[];
}

export interface WorkflowObservabilitySinks extends Sinks {
  workflowObservability: {
    workflowStarted(spanId: string, traceparent: string, correlation: Record<string, string>): void;
    workflowFinished(payload: WorkflowSpanRecordPayload): void;
  };
}

const { workflowObservability } = proxySinks<WorkflowObservabilitySinks>();

const safeIdPattern = /^[A-Za-z0-9:._-]{1,240}$/;

function safeId(value: unknown): string | null {
  return typeof value === "string" && safeIdPattern.test(value) ? value : null;
}

/**
 * Pure deterministic 64-bit FNV-1a / SplitMix64 hex generator for workflow isolate.
 * Produces 16 hex chars (spanId) or 32 hex chars (traceId) without Node crypto.
 */
function deterministicHexBlock(seed: string, salt: number): string {
  let hash = 0xcbf29ce484222325n ^ BigInt(salt & 0xffffffff);
  const prime = 0x100000001b3n;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= BigInt(seed.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  // SplitMix64 finalizer
  hash = ((hash ^ (hash >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  hash = ((hash ^ (hash >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  hash = (hash ^ (hash >> 31n)) & 0xffffffffffffffffn;
  if (hash === 0n) hash = 1n;
  return hash.toString(16).padStart(16, "0");
}

export function workflowSpanId(workflowId: string, runId: string): string {
  return deterministicHexBlock(`wf-span:${workflowId}:${runId}`, 0x53504143);
}

export function deterministicTraceId(seed: string): string {
  return `${deterministicHexBlock(`wf-trace-hi:${seed}`, 0x10203040)}${deterministicHexBlock(`wf-trace-lo:${seed}`, 0x50607080)}`;
}

export function continuationSpanId(sourceRunId: string): string {
  return deterministicHexBlock(`bg-continuation:${sourceRunId}`, 0x4247434e);
}

function readHeaderString(headers: Headers | undefined, key: string): string | null {
  if (!headers) return null;
  const payload = headers[key];
  if (!payload) return null;
  try {
    const decoded = defaultPayloadConverter.fromPayload<unknown>(payload);
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

const correlationKeys = [
  "traceId",
  "traceparent",
  "requestId",
  "roomId",
  "paneId",
  "missionId",
  "roomAgentMissionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId",
  "changeSetId",
  "runId"
] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

type CorrelationKey = (typeof correlationKeys)[number];

interface ExtractedWorkflowInput {
  fields: Partial<Record<CorrelationKey, string>>;
  sourceRunId: string | null;
}

function scanObject(value: unknown, out: ExtractedWorkflowInput, depth: number): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (depth > 0) {
      for (const item of value.slice(0, 4)) scanObject(item, out, depth - 1);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (out.fields[key] !== undefined) continue;
    const id = safeId(record[key]);
    if (id !== null) out.fields[key] = id;
  }
  const continuation = record.roomAgentContinuation;
  if (!out.sourceRunId && continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
    const sourceId = safeId((continuation as Record<string, unknown>).sourceRunId);
    if (sourceId) out.sourceRunId = sourceId;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) {
    scanObject(record[key], out, depth - 1);
  }
  if (Array.isArray(record.pending)) {
    scanObject(record.pending[0], out, depth - 1);
  }
}

export function extractWorkflowInputMetadata(
  args: readonly unknown[],
  memo?: Record<string, unknown>
): ExtractedWorkflowInput {
  const out: ExtractedWorkflowInput = { fields: {}, sourceRunId: null };
  for (const arg of args) scanObject(arg, out, 3);
  if (memo && typeof memo === "object") {
    if (!out.fields.traceparent) {
      const memoTp = safeId(memo.traceparent);
      if (memoTp) out.fields.traceparent = memoTp;
    }
    if (!out.fields.traceId) {
      const memoTraceId = safeId(memo.spaceTraceId);
      if (memoTraceId) out.fields.traceId = memoTraceId;
    }
    if (!out.fields.requestId) {
      const parentSpaceTraceId = safeId(memo.parentSpaceTraceId);
      if (parentSpaceTraceId) out.fields.requestId = parentSpaceTraceId;
    }
    if (!out.fields.missionId) {
      const memoMissionId = safeId(memo.missionId);
      if (memoMissionId) out.fields.missionId = memoMissionId;
    }
  }
  return out;
}

function buildCorrelationAttributes(fields: Partial<Record<CorrelationKey, string>>): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (fields.traceId) attrs["space.trace_id"] = fields.traceId;
  if (fields.requestId && fields.requestId !== fields.traceId) attrs["space.parent_trace_id"] = fields.requestId;
  const missionId = fields.missionId ?? fields.roomAgentMissionId;
  if (missionId) attrs["space.mission_id"] = missionId;
  const mapping: ReadonlyArray<readonly [CorrelationKey, string]> = [
    ["roomId", "space.room_id"],
    ["paneId", "space.pane_id"],
    ["agentRunId", "space.agent_run_id"],
    ["agentSessionId", "space.agent_session_id"],
    ["actionId", "space.action_id"],
    ["goalId", "space.goal_id"],
    ["dotId", "space.dot_id"],
    ["turnId", "space.turn_id"],
    ["cliTaskId", "space.cli_task_id"],
    ["revisionId", "space.revision_id"],
    ["changeSetId", "space.change_set_id"]
  ];
  for (const [field, attrKey] of mapping) {
    if (fields[field]) attrs[attrKey] = fields[field]!;
  }
  return attrs;
}

function workflowErrorCode(error: unknown): string {
  let cursor = error as { name?: unknown; type?: unknown; code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.cause as typeof cursor) {
    if (isSafeErrorCode(cursor.code)) return cursor.code;
    if (isSafeErrorCode(cursor.type)) return cursor.type;
    if (cursor.name === "TimeoutFailure") return "WORKFLOW_TIMEOUT";
  }
  return "WORKFLOW_ERROR";
}

function isSupervisorMissionTerminalActivity(activityType: string): boolean {
  return (
    activityType === "finishRoomAgentSupervisorTurn" ||
    activityType === "markRoomAgentMissionFinished" ||
    activityType === "markRoomAgentMissionContinued" ||
    activityType === "discardRoomAgentSupervisorTurn"
  );
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  const info = workflowInfo();
  let spanId = workflowSpanId(info.workflowId, info.runId);
  let traceId = deterministicTraceId(`${info.workflowId}:${info.firstExecutionRunId || info.runId}`);
  let parentSpanId: string | null = info.parent ? workflowSpanId(info.parent.workflowId, info.parent.runId) : null;
  let flags = "01";
  let hasExplicitTrace = false;
  let correlation: Record<string, string> = {};
  const links: WorkflowSpanLinkRecord[] = [];
  let spanEmitted = false;

  const currentTraceparent = () => formatTraceparent(traceId, spanId, flags);

  const applyTraceInput = (args: readonly unknown[], headers?: Headers) => {
    const headerTp = parseTraceparent(readHeaderString(headers, WORKFLOW_TRACEPARENT_HEADER));
    const continuedTp = parseTraceparent(readHeaderString(headers, WORKFLOW_CONTINUED_TRACEPARENT_HEADER));
    const headerTraceId = safeId(readHeaderString(headers, WORKFLOW_TRACE_ID_HEADER));
    const extracted = extractWorkflowInputMetadata(args, info.memo);
    const argTp = parseTraceparent(extracted.fields.traceparent);
    const traceIdField = extracted.fields.traceId ?? "";
    // Background continuations keep a new W3C trace (`trace:bg-*`) and point
    // at the caller's span with a link. A parent-workflow header still nests
    // real child workflows under the parent span.
    const isBackgroundContinuation = Boolean(extracted.sourceRunId) || traceIdField.startsWith("trace:bg-");

    const chosenTp = headerTp ?? (isBackgroundContinuation ? null : argTp);
    if (chosenTp) {
      traceId = chosenTp.traceId;
      parentSpanId = chosenTp.parentId;
      flags = chosenTp.flags;
      hasExplicitTrace = true;
    } else if (info.parent) {
      parentSpanId = workflowSpanId(info.parent.workflowId, info.parent.runId);
    }

    const nextCorrelation = buildCorrelationAttributes(extracted.fields);
    if (!nextCorrelation["space.trace_id"] && headerTraceId) {
      nextCorrelation["space.trace_id"] = headerTraceId;
    }
    correlation = { ...correlation, ...nextCorrelation };

    // 1. Continue-As-New link
    if (info.continuedFromExecutionRunId || continuedTp) {
      const prevTraceId = continuedTp?.traceId ?? traceId;
      const prevSpanId =
        continuedTp?.parentId ??
        (info.continuedFromExecutionRunId ? workflowSpanId(info.workflowId, info.continuedFromExecutionRunId) : null);
      if (prevSpanId && !links.some(l => l.spanId === prevSpanId && l.attributes?.["space.link_kind"] === "CONTINUE_AS_NEW")) {
        links.push({
          traceId: prevTraceId,
          spanId: prevSpanId,
          attributes: {
            "space.link_kind": "CONTINUE_AS_NEW",
            ...(info.continuedFromExecutionRunId ? { "space.continued_from_run_id": info.continuedFromExecutionRunId } : {})
          }
        });
      }
    }

    // 2. Background continuation link (`trace:bg-...` or `roomAgentContinuation.sourceRunId`).
    // Prefer the caller's real span (traceparent) over a synthetic id so the link
    // resolves in an OTLP backend.
    if (isBackgroundContinuation) {
      const sourceRunId = extracted.sourceRunId ?? traceIdField;
      const linkedTraceId = argTp?.traceId ?? continuedTp?.traceId ?? traceId;
      const linkedSpanId = argTp?.parentId ?? continuedTp?.parentId ?? continuationSpanId(sourceRunId);
      if (!links.some(l => l.spanId === linkedSpanId && l.attributes?.["space.link_kind"] === "BACKGROUND_CONTINUATION")) {
        links.push({
          traceId: linkedTraceId,
          spanId: linkedSpanId,
          attributes: {
            "space.link_kind": "BACKGROUND_CONTINUATION",
            ...(sourceRunId ? { "space.source_run_id": sourceRunId } : {})
          }
        });
      }
    }
  };

  const emitStart = () => {
    if (!info.unsafe.isReplaying) {
      workflowObservability.workflowStarted(spanId, currentTraceparent(), correlation);
    }
  };

  const emitFinish = (
    outcome: WorkflowSpanRecordPayload["outcome"],
    reasonCode: string | null = null,
    category: string | null = null
  ) => {
    if (spanEmitted) return;
    spanEmitted = true;
    if (!info.unsafe.isReplaying) {
      workflowObservability.workflowFinished({
        traceId,
        spanId,
        parentSpanId,
        workflowType: info.workflowType,
        workflowId: info.workflowId,
        runId: info.runId,
        parentWorkflowId: info.parent?.workflowId ?? null,
        parentRunId: info.parent?.runId ?? null,
        continuedFromRunId: info.continuedFromExecutionRunId ?? null,
        outcome,
        reasonCode,
        category,
        correlation,
        links
      });
    }
  };

  const inbound: WorkflowInboundCallsInterceptor = {
    async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">) {
      applyTraceInput(input.args, input.headers);
      emitStart();
      try {
        const result = await next(input);
        const failedObj =
          result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED"
            ? (result as { reasonCode?: unknown; errorCode?: unknown })
            : null;
        if (failedObj) {
          const code = isSafeErrorCode(failedObj.reasonCode)
            ? failedObj.reasonCode
            : isSafeErrorCode(failedObj.errorCode)
            ? failedObj.errorCode
            : "WORKFLOW_RESULT_FAILED";
          emitFinish("FAILED", code, categorizeFailureCode(code));
        } else {
          emitFinish("COMPLETED");
        }
        return result;
      } catch (error) {
        // ContinueAsNew is handled in the outbound continueAsNew interceptor before throwing.
        if ((error as { name?: string } | null)?.name === "ContinueAsNew") {
          emitFinish("CONTINUED_AS_NEW");
          throw error;
        }
        if (isCancellation(error)) {
          emitFinish("CANCELLED", "WORKFLOW_CANCELLED", "CANCELLED");
        } else {
          const code = workflowErrorCode(error);
          emitFinish("FAILED", code, categorizeFailureCode(code));
        }
        throw error;
      }
    },

    async handleSignal(input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, "handleSignal">) {
      const beforeExplicit = hasExplicitTrace;
      applyTraceInput(input.args, input.headers);
      if (!beforeExplicit && hasExplicitTrace) {
        // A supervisor signaled with a mission turn starts a new mission span cycle if a previous one already emitted.
        spanEmitted = false;
        emitStart();
      } else if (spanEmitted) {
        // Subsequent mission signaled into an existing supervisor workflow run.
        spanId = workflowSpanId(info.workflowId, `${info.runId}:${ correlation["space.mission_id"] ?? "next" }`);
        spanEmitted = false;
        emitStart();
      }
      return next(input);
    }
  };

  const outbound: WorkflowOutboundCallsInterceptor = {
    async scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">) {
      input.headers[WORKFLOW_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(currentTraceparent());
      const spaceTraceId = correlation["space.trace_id"];
      if (spaceTraceId) {
        input.headers[WORKFLOW_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(spaceTraceId);
      }
      const result = await next(input);
      if (info.workflowType === "roomAgentSupervisorWorkflow" && isSupervisorMissionTerminalActivity(input.activityType)) {
        emitFinish("COMPLETED");
      }
      return result;
    },

    async scheduleLocalActivity(
      input: LocalActivityInput,
      next: Next<WorkflowOutboundCallsInterceptor, "scheduleLocalActivity">
    ) {
      input.headers[WORKFLOW_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(currentTraceparent());
      const spaceTraceId = correlation["space.trace_id"];
      if (spaceTraceId) {
        input.headers[WORKFLOW_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(spaceTraceId);
      }
      return next(input);
    },

    async startChildWorkflowExecution(
      input: StartChildWorkflowExecutionInput,
      next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">
    ) {
      input.headers[WORKFLOW_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(currentTraceparent());
      const spaceTraceId = correlation["space.trace_id"];
      if (spaceTraceId) {
        input.headers[WORKFLOW_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(spaceTraceId);
      }
      return next(input);
    },

    async continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">) {
      input.headers[WORKFLOW_CONTINUED_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(currentTraceparent());
      input.headers[WORKFLOW_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(
        parentSpanId ? formatTraceparent(traceId, parentSpanId, flags) : currentTraceparent()
      );
      const spaceTraceId = correlation["space.trace_id"];
      if (spaceTraceId) {
        input.headers[WORKFLOW_TRACE_ID_HEADER] = defaultPayloadConverter.toPayload(spaceTraceId);
      }
      emitFinish("CONTINUED_AS_NEW");
      return next(input);
    }
  };

  return { inbound: [inbound], outbound: [outbound] };
};
