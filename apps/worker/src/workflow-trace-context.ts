import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";

export const TRACE_PARENT_HEADER = "space-traceparent";
export const TRACE_LINK_HEADER = "space-trace-link";
export interface WorkflowTraceSpan {
  traceId: string; spanId: string; parentSpanId: string | null;
  name: string; startedAt: number; endedAt: number;
  attributes: Record<string, string | number>; error: boolean;
  links: Array<{ traceId: string; spanId: string }>;
}
export type WorkflowTraceSinks = { spaceTrace: { record(span: WorkflowTraceSpan): void } };

export function readTraceHeader(headers: Record<string, Payload>, key = TRACE_PARENT_HEADER): string | null {
  try { const value = headers[key] ? defaultPayloadConverter.fromPayload(headers[key]) : null;
    return typeof value === "string" && parseTraceparent(value) ? value : null;
  } catch { return null; }
}
export function writeTraceHeader(headers: Record<string, Payload>, value: string | null, key = TRACE_PARENT_HEADER) {
  return value && parseTraceparent(value) ? { ...headers, [key]: defaultPayloadConverter.toPayload(value) } : headers;
}
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value) ? value : null;
const identifierKeys = ["traceId", "roomId", "paneId", "missionId", "roomAgentMissionId", "agentRunId", "goalId", "dotId", "turnId"] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;
export function traceInput(args: readonly unknown[]) {
  const attributes: Record<string, string | number> = {};
  let parent: string | null = null; let background = false;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    if (!parent && typeof input.traceparent === "string" && parseTraceparent(input.traceparent)) parent = input.traceparent;
    if (input.roomAgentContinuation && typeof input.roomAgentContinuation === "object") background = true;
    for (const key of identifierKeys) { const safe = id(input[key]); if (safe) attributes[`space.${key}`] ??= safe; }
    if (depth > 0) for (const key of nestedKeys) visit(input[key], depth - 1);
  };
  for (const arg of args.slice(0, 8)) visit(arg, 2);
  return { attributes, parent, background };
}
/** Stable IDs without consuming the workflow's deterministic PRNG. */
export function workflowSpanId(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex) && !/^0{16}$/.test(hex.slice(0, 16))) return hex.slice(0, 16);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < runId.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(runId.charCodeAt(index))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}
export function traceFailureCode(error: unknown): string {
  let failure = error as { name?: unknown; type?: unknown; cause?: unknown } | null;
  let code = "WORKFLOW_ERROR";
  for (let depth = 0; failure && depth < 8; depth++, failure = failure.cause as typeof failure) {
    if (failure.name === "TimeoutFailure") code = "WORKFLOW_TIMEOUT";
    else if (isSafeErrorCode(failure.type)) code = failure.type;
  }
  return code;
}
export function spanTraceparent(traceId: string, spanId: string) { return formatTraceparent(traceId, spanId, "01"); }
