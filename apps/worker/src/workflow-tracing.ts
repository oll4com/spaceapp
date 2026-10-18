import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInterceptors
} from "@temporalio/workflow";
import { categorizeFailureCode, isSafeErrorCode } from "@space/contracts";
import type { ServerSpan, SpanLink } from "@space/runtime";
import {
  contextFromHeaders,
  contextFromTraceparent,
  inputTraceContext,
  isBackgroundContinuation,
  MAX_MISSION_CONTEXTS,
  missionContextsFromHeaders,
  operationSpanId,
  runSpanId,
  runTraceId,
  validContext,
  withTraceHeader,
  withMissionContextsHeader,
  type SpanContext,
  type TraceContext
} from "./workflow-trace-context.js";

interface TraceSinks extends Sinks {
  spaceTrace: {
    record(span: ServerSpan): void;
  };
}

const sink = proxySinks<TraceSinks>();
const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const correlationFields = [
  ["traceId", "space.trace_id"],
  ["roomId", "space.room_id"],
  ["paneId", "space.pane_id"],
  ["missionId", "space.mission_id"],
  ["roomAgentMissionId", "space.mission_id"],
  ["agentRunId", "space.agent_run_id"],
  ["agentSessionId", "space.agent_session_id"],
  ["actionId", "space.action_id"],
  ["goalId", "space.goal_id"],
  ["dotId", "space.dot_id"],
  ["turnId", "space.turn_id"],
  ["cliTaskId", "space.cli_task_id"],
  ["revisionId", "space.revision_id"]
] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

function workflowCorrelationAttributes(args: readonly unknown[]): Record<string, string> {
  const found: Record<string, string> = {};
  function visit(value: unknown, depth: number): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const [source, target] of correlationFields) {
      const candidate = record[source];
      if (found[target] === undefined && typeof candidate === "string" && identifierPattern.test(candidate)) found[target] = candidate;
    }
    const continuation = record.roomAgentContinuation;
    if (found["space.source_run_id"] === undefined && continuation && typeof continuation === "object") {
      const sourceRunId = (continuation as Record<string, unknown>).sourceRunId;
      if (typeof sourceRunId === "string" && identifierPattern.test(sourceRunId)) found["space.source_run_id"] = sourceRunId;
    }
    if (depth > 0) for (const key of nestedKeys) visit(record[key], depth - 1);
  }
  for (const arg of args) visit(arg, 2);
  return found;
}

function spanLink(context: SpanContext, reason: string): SpanLink {
  return { traceId: context.traceId, spanId: context.spanId, attributes: { "link.reason": reason } };
}

function backgroundSourceContext(args: readonly unknown[]): SpanContext | null {
  function visit(value: unknown, depth: number): SpanContext | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const continuation = record.roomAgentContinuation;
    if (continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
      const context = (continuation as Record<string, unknown>).sourceSpanContext;
      if (validContext(context)) return { traceId: context.traceId, spanId: context.spanId };
    }
    if (depth <= 0) return null;
    for (const key of nestedKeys) {
      const nested = visit(record[key], depth - 1);
      if (nested) return nested;
    }
    return null;
  }
  for (const arg of args) {
    const found = visit(arg, 3);
    if (found) return found;
  }
  return null;
}

function uniqueLinks(links: readonly SpanLink[]): SpanLink[] {
  const seen = new Set<string>();
  const result: SpanLink[] = [];
  for (const link of links) {
    const key = link.traceId + ":" + link.spanId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
    if (result.length === 4) break;
  }
  return result;
}

function reasonCodeFrom(error: unknown): string {
  const seen = new Set<unknown>();
  let found: string | null = null;
  let fallbackName = "";
  for (let depth = 0; depth < 8 && error && typeof error === "object" && !seen.has(error); depth++) {
    seen.add(error);
    const record = error as { code?: unknown; type?: unknown; name?: unknown; cause?: unknown };
    if (isSafeErrorCode(record.code)) found = record.code;
    else if (isSafeErrorCode(record.type)) found = record.type;
    else if (isSafeErrorCode(record.name)) found = record.name;
    if (typeof record.type === "string" && record.type && record.type !== "Error" && record.type !== "ActivityFailure") {
      fallbackName = record.type;
    } else if (typeof record.name === "string" && record.name && record.name !== "Error" && record.name !== "ActivityFailure") {
      fallbackName = record.name;
    }
    error = record.cause;
  }
  if (found) return found;
  if (/Cancel/i.test(fallbackName)) return "ACTIVITY_CANCELLED";
  if (/Timeout/i.test(fallbackName)) return "ACTIVITY_TIMEOUT";
  if (/Conflict/i.test(fallbackName)) return "CONFLICT";
  if (/NotFound/i.test(fallbackName)) return "STATE_NOT_FOUND";
  if (/Retryable/i.test(fallbackName)) return "UPSTREAM_RETRYABLE_UNAVAILABLE";
  return "WORKFLOW_ERROR";
}

export function interceptors(): WorkflowInterceptors {
  const initial = workflowInfo();
  const supervisor = initial.workflowType === "roomAgentSupervisorWorkflow";
  const missionParents = new Map<string, SpanContext>();
  let current: TraceContext = { traceId: runTraceId(initial.runId), spanId: runSpanId(initial.runId) };

  // Signals and carried queue items name their own request; a supervisor run can
  // serve many requests. Never change the run's global context per signal.
  function remember(args: readonly unknown[]): void {
    function visit(value: unknown, depth: number): void {
      if (!value || typeof value !== "object" || depth < 0) return;
      if (Array.isArray(value)) { for (const entry of value.slice(0, 100)) visit(entry, depth - 1); return; }
      const record = value as Record<string, unknown>;
      const parent = inputTraceContext([value]);
      const mission = workflowCorrelationAttributes([value])["space.mission_id"];
      if (parent && mission) {
        missionParents.delete(mission);
        missionParents.set(mission, parent);
        if (missionParents.size > MAX_MISSION_CONTEXTS) missionParents.delete(missionParents.keys().next().value!);
      }
      for (const key of ["pending", "interrupted", "item"]) visit(record[key], depth - 1);
    }
    for (const arg of args) visit(arg, 4);
  }

  function requestFor(args: readonly unknown[]): SpanContext | null {
    const direct = inputTraceContext(args);
    if (direct) return direct;
    const mission = workflowCorrelationAttributes(args)["space.mission_id"];
    return mission ? missionParents.get(mission) ?? null : null;
  }

  // Finite supervisor operation spans make finished mission work visible while
  // the supervisor itself waits indefinitely for the next signal. They retain
  // the real workflow/run IDs and parent every attempt under a workflow span in
  // the correct request trace, without exporting revisions of one span ID.
  async function operation<T>(context: SpanContext, parent: SpanContext, name: string,
    args: readonly unknown[], execute: () => Promise<T>, startedAt = Date.now(), links?: readonly SpanLink[]): Promise<T> {
    let outcome = "COMPLETED";
    let reason: string | null = null;
    try { return await execute(); }
    catch (error) {
      outcome = isCancellation(error) ? "CANCELLED" : "FAILED";
      reason = outcome === "FAILED" ? reasonCodeFrom(error) : null;
      throw error;
    } finally {
      const endedAt = Math.max(startedAt, Date.now());
      sink.spaceTrace.record({ ...context, parentSpanId: parent.spanId, name,
        startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
        endTimeUnixNano: BigInt(endedAt) * 1_000_000n,
        attributes: { "space.workflow_type": initial.workflowType, "space.workflow_id": initial.workflowId,
          "space.run_id": initial.runId, "space.attempt": initial.attempt, "space.status": outcome,
          "space.duration_ms": endedAt - startedAt, ...workflowCorrelationAttributes(args),
          ...(reason ? { "space.reason_code": reason, "space.category": categorizeFailureCode(reason) } : {}) },
        error: outcome === "FAILED", kind: 1,
        ...(links?.length ? { links: uniqueLinks(links) } : {}) });
    }
  }

  return {
    inbound: [{
      handleSignal(input, next) {
        if (supervisor) remember(input.args);
        return next(input);
      },
      async execute(input, next) {
        const info = workflowInfo();
        if (supervisor) {
          const memoMission = typeof info.memo?.missionId === "string" && identifierPattern.test(info.memo.missionId)
            ? info.memo.missionId
            : null;
          const memoParent = contextFromTraceparent(info.memo?.traceparent);
          if (memoMission && memoParent) missionParents.set(memoMission, memoParent);
          for (const [mission, parent] of missionContextsFromHeaders(input.headers)) missionParents.set(mission, parent);
          remember(input.args);
        }
        const parent = contextFromHeaders(input.headers) ??
          inputTraceContext(input.args) ??
          contextFromTraceparent(info.memo?.traceparent);
        current = { traceId: parent?.traceId ?? runTraceId(info.runId), spanId: runSpanId(info.runId) };
        const parentSpanId = parent?.spanId ?? null;
        const links: SpanLink[] = parent && "links" in parent ? [...((parent as TraceContext).links ?? [])] : [];
        if (info.continuedFromExecutionRunId) {
          links.push(spanLink({ traceId: current.traceId, spanId: runSpanId(info.continuedFromExecutionRunId) }, "continue_as_new"));
        }

        const startedAt = Date.now();
        let outcome = "COMPLETED";
        let reasonCode: string | null = null;
        try {
          return await next(input);
        } catch (error) {
          if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else if (isCancellation(error)) outcome = "CANCELLED";
          else {
            outcome = "FAILED";
            reasonCode = reasonCodeFrom(error);
          }
          throw error;
        } finally {
          const endedAt = Math.max(startedAt, Date.now());
          const attributes: Record<string, string | number> = {
            "space.workflow_type": info.workflowType,
            "space.workflow_id": info.workflowId,
            "space.run_id": info.runId,
            "space.attempt": info.attempt,
            "space.status": outcome,
            "space.duration_ms": endedAt - startedAt,
            ...workflowCorrelationAttributes(input.args)
          };
          if (reasonCode) {
            attributes["space.reason_code"] = reasonCode;
            attributes["space.category"] = categorizeFailureCode(reasonCode);
          }
          sink.spaceTrace.record({
            traceId: current.traceId,
            spanId: current.spanId,
            parentSpanId,
            name: info.workflowType,
            startTimeUnixNano: BigInt(startedAt) * 1_000_000n,
            endTimeUnixNano: BigInt(endedAt) * 1_000_000n,
            attributes,
            error: outcome === "FAILED",
            kind: 1,
            ...(links.length ? { links: uniqueLinks(links) } : {})
          });
        }
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        const request = supervisor ? requestFor(input.args) : null;
        if (!request) return next({ ...input, headers: withTraceHeader(input.headers, current) });
        const context = { traceId: request.traceId, spanId: operationSpanId(initial.runId, "activity:" + input.seq) };
        return operation(context, request, initial.workflowType + ".activity", input.args, async () => {
          const result = await next({ ...input, headers: withTraceHeader(input.headers, context) });
          remember([result]);
          return result;
        });
      },
      scheduleLocalActivity(input, next) {
        const request = supervisor ? requestFor(input.args) : null;
        if (!request) return next({ ...input, headers: withTraceHeader(input.headers, current) });
        const context = { traceId: request.traceId, spanId: operationSpanId(initial.runId, "local:" + input.seq) };
        return operation(context, request, initial.workflowType + ".activity", input.args,
          () => next({ ...input, headers: withTraceHeader(input.headers, context) }));
      },
      async startChildWorkflowExecution(input, next) {
        const childArgs = input.options.args ?? [];
        const missionRequest = supervisor ? requestFor(childArgs) : null;
        if (missionRequest) {
          const context = { traceId: missionRequest.traceId, spanId: operationSpanId(initial.runId, "child:" + input.seq) };
          const background = isBackgroundContinuation(childArgs);
          const source = backgroundSourceContext(childArgs) ?? (background ? missionRequest : null);
          const links = source ? [spanLink(source, "background_continuation")] : undefined;
          const startedAt = Date.now();
          const [started, result] = await next({ ...input, headers: withTraceHeader(input.headers, {
            ...context, ...(links ? { links } : {})
          }) });
          const tracedResult = operation(context, missionRequest, initial.workflowType + ".child", childArgs, () => result, startedAt, links);
          // A child that fails to start can reject both promises; the SDK caller
          // may consume only the start promise in that case.
          void tracedResult.catch(() => undefined);
          return [started, tracedResult];
        }
        const request = inputTraceContext(childArgs);
        const background = isBackgroundContinuation(childArgs);
        const source = background ? backgroundSourceContext(childArgs) : null;
        const separateRequest = request !== null && request.traceId !== current.traceId;
        const parentContext = separateRequest ? request : current;
        const links = separateRequest
          ? [
              spanLink(current, "room_agent_mission"),
              ...(source ? [spanLink(source, "background_continuation")] : [])
            ]
          : background
            ? [...(current.links ?? []), spanLink(source ?? current, "background_continuation")]
            : current.links ?? [];
        const context: TraceContext = { ...parentContext, ...(links.length ? { links: uniqueLinks(links) } : {}) };
        return next({ ...input, headers: withTraceHeader(input.headers, context) });
      },
      continueAsNew(input, next) {
        const links = uniqueLinks([...(current.links ?? []), spanLink(current, "continue_as_new")]);
        const headers = withTraceHeader(input.headers, { ...current, links });
        return next({ ...input, headers: supervisor ? withMissionContextsHeader(headers, missionParents) : headers });
      }
    }]
  };
}
