import {
  ContinueAsNew,
  defaultPayloadConverter,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type Next,
  type Sinks,
  type Sink,
  type StartChildWorkflowExecutionInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  formatTraceparent,
  parseTraceparent,
  sanitizeSpanAttributes,
  type OtlpSpanLink
} from "@space/contracts";

export const SPACE_TRACEPARENT_HEADER = "x-space-traceparent";

export interface WorkflowSpanPayload {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: readonly OtlpSpanLink[];
}

export interface TracingSink extends Sink {
  exportWorkflowSpan(span: WorkflowSpanPayload): void;
}

export interface TracingSinks extends Sinks {
  tracing: TracingSink;
}

const { tracing } = proxySinks<TracingSinks>();

function extractTraceparentFromHeaders(headers: Record<string, unknown> | undefined): string | null {
  const raw = headers?.[SPACE_TRACEPARENT_HEADER];
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() || null;
  try {
    const decoded = defaultPayloadConverter.fromPayload<unknown>(raw as never);
    return typeof decoded === "string" && decoded.trim() ? decoded.trim() : null;
  } catch {
    return null;
  }
}

function extractTraceparentFromArgs(args: readonly unknown[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    if (typeof record.traceparent === "string" && record.traceparent.trim()) {
      return record.traceparent.trim();
    }
    if (record.turn && typeof record.turn === "object") {
      const turn = record.turn as Record<string, unknown>;
      if (typeof turn.traceparent === "string" && turn.traceparent.trim()) {
        return turn.traceparent.trim();
      }
    }
    if (record.item && typeof record.item === "object") {
      const item = record.item as Record<string, unknown>;
      if (item.turn && typeof item.turn === "object") {
        const turn = item.turn as Record<string, unknown>;
        if (typeof turn.traceparent === "string" && turn.traceparent.trim()) {
          return turn.traceparent.trim();
        }
      }
    }
  }
  return null;
}

function extractCorrelationAttributes(args: readonly unknown[]): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    const searchObjects: Record<string, unknown>[] = [record];
    if (record.turn && typeof record.turn === "object") searchObjects.push(record.turn as Record<string, unknown>);
    if (record.item && typeof record.item === "object") {
      const item = record.item as Record<string, unknown>;
      searchObjects.push(item);
      if (item.turn && typeof item.turn === "object") searchObjects.push(item.turn as Record<string, unknown>);
    }

    for (const obj of searchObjects) {
      if (typeof obj.roomId === "string") extracted["space.room_id"] = obj.roomId;
      if (typeof obj.paneId === "string") extracted["space.pane_id"] = obj.paneId;
      if (typeof obj.missionId === "string") extracted["space.mission_id"] = obj.missionId;
      if (typeof obj.roomAgentMissionId === "string") extracted["space.mission_id"] = obj.roomAgentMissionId;
      if (typeof obj.agentRunId === "string") extracted["space.agent_run_id"] = obj.agentRunId;
      if (typeof obj.agentSessionId === "string") extracted["space.agent_session_id"] = obj.agentSessionId;
      if (typeof obj.turnId === "string") extracted["space.turn_id"] = obj.turnId;
      if (typeof obj.goalId === "string") extracted["space.goal_id"] = obj.goalId;
      if (typeof obj.dotId === "string") extracted["space.dot_id"] = obj.dotId;
      if (typeof obj.actionId === "string") extracted["space.action_id"] = obj.actionId;
      if (typeof obj.cliTaskId === "string") extracted["space.cli_task_id"] = obj.cliTaskId;
      if (typeof obj.traceId === "string") extracted["space.trace_id"] = obj.traceId;
      if (obj.roomAgentContinuation && typeof obj.roomAgentContinuation === "object") {
        const cont = obj.roomAgentContinuation as Record<string, unknown>;
        if (typeof cont.sourceRunId === "string") extracted["space.source_run_id"] = cont.sourceRunId;
      }
    }
  }
  return extracted;
}

function extractContinuationLinks(args: readonly unknown[], currentTraceId: string): OtlpSpanLink[] {
  const links: OtlpSpanLink[] = [];
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    const turn = (record.turn ?? (record.item as Record<string, unknown>)?.turn) as Record<string, unknown> | undefined;
    if (turn?.roomAgentContinuation && typeof turn.roomAgentContinuation === "object") {
      const cont = turn.roomAgentContinuation as Record<string, unknown>;
      const sourceTraceparent = typeof cont.sourceTraceparent === "string" ? parseTraceparent(cont.sourceTraceparent) : null;
      const sourceTraceId = typeof cont.sourceTraceId === "string" && /^[0-9a-f]{32}$/i.test(cont.sourceTraceId)
        ? cont.sourceTraceId.toLowerCase()
        : sourceTraceparent?.traceId ?? null;
      const sourceSpanId = typeof cont.sourceSpanId === "string" && /^[0-9a-f]{16}$/i.test(cont.sourceSpanId)
        ? cont.sourceSpanId.toLowerCase()
        : sourceTraceparent?.parentId ?? null;

      // Only emit link when both predecessor traceId and spanId are valid W3C hex
      if (sourceTraceId && sourceSpanId && !/^0+$/.test(sourceSpanId)) {
        links.push({ traceId: sourceTraceId, spanId: sourceSpanId });
      }
    }
  }
  return links;
}

export class WorkflowTracingInterceptor implements WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor {
  private workflowTraceparent: string | null = null;

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
    const info = workflowInfo();
    const startTime = (info as { runStartTime?: Date }).runStartTime ?? info.startTime;
    const startTimeUnixNano = (BigInt(startTime.getTime()) * 1_000_000n).toString();

    // 1. Resolve traceparent from args, workflow memo, or inbound workflow header
    const memoTraceparent = typeof info.memo?.traceparent === "string" ? info.memo.traceparent : null;
    const headerTraceparent = extractTraceparentFromHeaders(input.headers);
    const rawTraceparent = extractTraceparentFromArgs(input.args) ?? memoTraceparent ?? headerTraceparent;
    const parsed = parseTraceparent(rawTraceparent);

    // 2. Compute traceId and spanId
    const memoW3c = typeof info.memo?.w3cTraceId === "string" && /^[0-9a-f]{32}$/.test(info.memo.w3cTraceId) ? info.memo.w3cTraceId : null;
    const traceId = parsed?.traceId ?? memoW3c ?? info.runId.replace(/-/g, "").toLowerCase().slice(0, 32);
    const spanId = info.runId.replace(/-/g, "").toLowerCase().slice(0, 16);
    if (/^[0-9a-f]{32}$/.test(traceId) && /^[0-9a-f]{16}$/.test(spanId)) {
      this.workflowTraceparent = formatTraceparent(traceId, spanId, parsed?.flags ?? "01");
    }

    // 3. Parent span ID: nested under parent execution if child workflow; else under inbound traceparent parentId
    const parentSpanId = info.parent
      ? info.parent.runId.replace(/-/g, "").toLowerCase().slice(0, 16)
      : (parsed?.parentId ?? null);

    // 4. Span links: continueAsNew + background continuation
    const links: OtlpSpanLink[] = [];
    if (info.continuedFromExecutionRunId) {
      const prevSpanId = info.continuedFromExecutionRunId.replace(/-/g, "").toLowerCase().slice(0, 16);
      if (/^[0-9a-f]{16}$/.test(prevSpanId)) {
        links.push({
          traceId,
          spanId: prevSpanId
        });
      }
    }
    const bgLinks = extractContinuationLinks(input.args, traceId);
    for (const link of bgLinks) links.push(link);

    let error = false;
    let continuedAsNew = false;
    let reasonCode: string | null = null;
    try {
      return await next(input);
    } catch (err: unknown) {
      if (err instanceof ContinueAsNew || (err && typeof err === "object" && (err as Error).name === "ContinueAsNew")) {
        continuedAsNew = true;
        throw err;
      }
      error = true;
      const rec = err as { code?: unknown; name?: unknown; message?: unknown };
      if (typeof rec?.code === "string") reasonCode = rec.code;
      else if (typeof rec?.name === "string") reasonCode = rec.name;
      throw err;
    } finally {
      const endTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
      const workflowStatus = error ? "FAILED" : (continuedAsNew ? "CONTINUED_AS_NEW" : "COMPLETED");
      const rawAttributes: Record<string, unknown> = {
        "workflow.type": info.workflowType,
        "workflow.id": info.workflowId,
        "workflow.run_id": info.runId,
        "workflow.status": workflowStatus,
        ...(info.parent ? {
          "workflow.parent_id": info.parent.workflowId,
          "workflow.parent_run_id": info.parent.runId
        } : {}),
        ...(reasonCode ? { "error.code": reasonCode } : {}),
        ...extractCorrelationAttributes(input.args)
      };
      const attributes = sanitizeSpanAttributes(rawAttributes);

      try {
        tracing.exportWorkflowSpan({
          name: `workflow:${info.workflowType}`,
          traceId,
          spanId,
          parentSpanId,
          startTimeUnixNano,
          endTimeUnixNano,
          attributes,
          error: error && !continuedAsNew,
          links
        });
      } catch {
        // Tracing sink failures must never affect workflow outcome
      }
    }
  }

  async scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">): Promise<unknown> {
    if (this.workflowTraceparent && !input.headers[SPACE_TRACEPARENT_HEADER]) {
      try {
        input.headers[SPACE_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(this.workflowTraceparent);
      } catch {
        // Header encoding failure must never affect activity scheduling
      }
    }
    return next(input);
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">
  ): Promise<[Promise<string>, Promise<unknown>]> {
    if (this.workflowTraceparent && !input.headers[SPACE_TRACEPARENT_HEADER]) {
      try {
        input.headers[SPACE_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(this.workflowTraceparent);
      } catch {
        // Header encoding failure must never affect child workflow start
      }
    }
    return next(input);
  }

  async continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">): Promise<never> {
    if (this.workflowTraceparent && !input.headers[SPACE_TRACEPARENT_HEADER]) {
      try {
        input.headers[SPACE_TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(this.workflowTraceparent);
      } catch {
        // Header encoding failure must never affect continueAsNew
      }
    }
    return next(input);
  }
}

export function interceptors(): WorkflowInterceptors {
  const interceptor = new WorkflowTracingInterceptor();
  return {
    inbound: [interceptor],
    outbound: [interceptor]
  };
}
