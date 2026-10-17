import {
  proxySinks,
  workflowInfo,
  ContinueAsNew,
  type Next,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
  type WorkflowOutboundCallsInterceptor,
  type ActivityInput,
  type StartChildWorkflowExecutionInput,
  type ContinueAsNewInput
} from "@temporalio/workflow";
import { defaultPayloadConverter } from "@temporalio/common";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import type { SpanLink } from "@space/runtime";
import type { WorkflowTracingSinks } from "./workflow-tracing-sinks.js";

export interface WorkflowObservabilityOptions {
  sink?: {
    recordWorkflowSpan: (span: any) => void;
  };
  getWorkflowInfo?: () => any;
}

interface TracingState {
  currentSpan: { traceId: string; spanId: string } | null;
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;

function safeId(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

const correlationKeys = [
  "traceId",
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
  "revisionId"
] as const;

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

function readCorrelation(value: unknown, into: Record<string, string>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of correlationKeys) {
    if (into[key] !== undefined) continue;
    const id = safeId(record[key]);
    if (id !== null) into[key] = id;
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) readCorrelation(record[key], into, depth - 1);
}

function extractWorkflowCorrelation(args: readonly unknown[]): Record<string, string | number> {
  const found: Record<string, string> = {};
  for (const arg of args) readCorrelation(arg, found, 2);
  const result: Record<string, string | number> = {};
  if (found.traceId) result["space.trace_id"] = found.traceId;
  const missionId = found.missionId ?? found.roomAgentMissionId;
  if (missionId) result["space.mission_id"] = missionId;
  for (const [k, attr] of [
    ["roomId", "space.room_id"],
    ["paneId", "space.pane_id"],
    ["agentRunId", "space.agent_run_id"],
    ["agentSessionId", "space.agent_session_id"],
    ["actionId", "space.action_id"],
    ["goalId", "space.goal_id"],
    ["dotId", "space.dot_id"],
    ["turnId", "space.turn_id"],
    ["cliTaskId", "space.cli_task_id"],
    ["revisionId", "space.revision_id"]
  ] as const) {
    if (found[k]) result[attr] = found[k];
  }
  return result;
}

function extractInboundTraceparent(input: WorkflowExecuteInput, memo: Record<string, unknown> | undefined): string | null {
  // 1. From execution headers
  if (input.headers?.traceparent) {
    try {
      const decoded = defaultPayloadConverter.fromPayload(input.headers.traceparent);
      if (typeof decoded === "string" && parseTraceparent(decoded)) return decoded;
    } catch {}
  }

  // 2. From Temporal workflow correlation memo
  if (memo?.traceparent && typeof memo.traceparent === "string" && parseTraceparent(memo.traceparent)) {
    return memo.traceparent;
  }

  // 3. From workflow input arguments
  const checkObject = (obj: unknown, depth: number): string | null => {
    if (!obj || typeof obj !== "object" || depth <= 0) return null;
    const record = obj as Record<string, unknown>;
    if (typeof record.traceparent === "string" && parseTraceparent(record.traceparent)) {
      return record.traceparent;
    }
    for (const k of nestedKeys) {
      const nested = checkObject(record[k], depth - 1);
      if (nested) return nested;
    }
    return null;
  };

  for (const arg of input.args) {
    const found = checkObject(arg, 3);
    if (found) return found;
  }

  return null;
}

function extractContinuationLinks(input: WorkflowExecuteInput): SpanLink[] {
  const links: SpanLink[] = [];

  // Check for continue-as-new header
  if (input.headers?.["x-space-continue-from"]) {
    try {
      const decoded = defaultPayloadConverter.fromPayload(input.headers["x-space-continue-from"]);
      if (typeof decoded === "string") {
        const parsed = parseTraceparent(decoded);
        if (parsed) {
          links.push({
            traceId: parsed.traceId,
            spanId: parsed.parentId,
            attributes: { "link.reason": "continue_as_new" }
          });
        }
      }
    } catch {}
  }

  // Check for background continuation in args (roomAgentContinuation)
  const checkContinuation = (obj: unknown, depth: number): void => {
    if (!obj || typeof obj !== "object" || depth <= 0) return;
    const record = obj as Record<string, unknown>;
    const continuation = record.roomAgentContinuation as { sourceTraceparent?: string } | undefined;
    if (continuation?.sourceTraceparent) {
      const parsed = parseTraceparent(continuation.sourceTraceparent);
      if (parsed) {
        links.push({
          traceId: parsed.traceId,
          spanId: parsed.parentId,
          attributes: { "link.reason": "background_continuation" }
        });
      }
    }
    for (const k of nestedKeys) {
      checkContinuation(record[k], depth - 1);
    }
  };

  for (const arg of input.args) {
    checkContinuation(arg, 3);
  }

  return links;
}

function fnv1a32(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function deterministicHex(input: string, length: 16 | 32): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const parts: string[] = [];
  const count = length === 32 ? 4 : 2;
  for (let i = 0; i < count; i++) {
    const seed = seeds[i] ?? 0x811c9dc5;
    let val = fnv1a32(`${input}#${i}`, seed);
    if (val === 0) val = 1 + i;
    parts.push(val.toString(16).padStart(8, "0"));
  }
  const result = parts.join("");
  return /^0+$/.test(result) ? result.slice(0, -1) + "1" : result;
}

class TracingWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  constructor(private readonly state: TracingState, private readonly options?: WorkflowObservabilityOptions) {}

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
    const info = this.options?.getWorkflowInfo ? this.options.getWorkflowInfo() : workflowInfo();

    const inbound = extractInboundTraceparent(input, info.memo);
    const parsed = parseTraceparent(inbound);

    let traceId: string;
    let parentSpanId: string | null = null;

    if (parsed) {
      traceId = parsed.traceId;
      parentSpanId = parsed.parentId;
    } else {
      const memoTraceId = typeof info.memo?.w3cTraceId === "string"
        ? info.memo.w3cTraceId
        : typeof info.memo?.traceId === "string"
          ? info.memo.traceId
          : null;
      if (memoTraceId && /^[0-9a-f]{32}$/.test(memoTraceId.toLowerCase())) {
        traceId = memoTraceId.toLowerCase();
      } else {
        traceId = deterministicHex(`${info.workflowId}:${info.runId}:trace`, 32);
      }
    }

    const spanId = deterministicHex(`${info.workflowId}:${info.runId}:${info.attempt}:span`, 16);

    this.state.currentSpan = { traceId, spanId };

    const links = extractContinuationLinks(input);
    const startedAt = Date.now();
    let isError = false;

    try {
      return await next(input);
    } catch (error) {
      if (!(error instanceof ContinueAsNew || (error && typeof error === "object" && (error as any).name === "ContinueAsNew"))) {
        isError = true;
      }
      throw error;
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const correlation = extractWorkflowCorrelation(input.args);

      const spanData = {
        traceId,
        spanId,
        parentSpanId,
        name: `workflow ${info.workflowType}`,
        startTimeUnixNano: String(BigInt(startedAt) * 1_000_000n),
        endTimeUnixNano: String(BigInt(startedAt + durationMs) * 1_000_000n),
        attributes: {
          "space.workflow_type": info.workflowType,
          "space.workflow_id": info.workflowId,
          "space.run_id": info.runId,
          "space.attempt": info.attempt,
          "space.status": isError ? "FAILED" : "COMPLETED",
          "space.duration_ms": durationMs,
          ...correlation
        },
        error: isError,
        kind: 1, // INTERNAL
        links: links.length > 0 ? links : undefined
      };

      if (this.options?.sink?.recordWorkflowSpan) {
        this.options.sink.recordWorkflowSpan(spanData);
      } else {
        try {
          const { observability } = proxySinks<WorkflowTracingSinks>();
          observability.recordWorkflowSpan(spanData);
        } catch {
          // Sinks never fail workflow executions
        }
      }
    }
  }
}

class TracingWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly state: TracingState) {}

  async scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, "scheduleActivity">): Promise<unknown> {
    if (this.state.currentSpan) {
      const traceparent = formatTraceparent(this.state.currentSpan.traceId, this.state.currentSpan.spanId, "01");
      const headers = {
        ...input.headers,
        traceparent: defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, "startChildWorkflowExecution">
  ): Promise<[Promise<string>, Promise<unknown>]> {
    if (this.state.currentSpan) {
      const traceparent = formatTraceparent(this.state.currentSpan.traceId, this.state.currentSpan.spanId, "01");
      const headers = {
        ...input.headers,
        traceparent: defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }

  async continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, "continueAsNew">): Promise<never> {
    if (this.state.currentSpan) {
      const traceparent = formatTraceparent(this.state.currentSpan.traceId, this.state.currentSpan.spanId, "01");
      const headers = {
        ...input.headers,
        "x-space-continue-from": defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }
}

export function createWorkflowObservabilityInterceptors(
  options?: WorkflowObservabilityOptions
): WorkflowInterceptorsFactory {
  return () => {
    const state: TracingState = { currentSpan: null };
    return {
      inbound: [new TracingWorkflowInboundInterceptor(state, options)],
      outbound: [new TracingWorkflowOutboundInterceptor(state)]
    };
  };
}

export const interceptors: WorkflowInterceptorsFactory = createWorkflowObservabilityInterceptors();
