import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { formatTraceparent, parseTraceparent, isSafeErrorCode } from "@space/contracts";

export const TRACE_HEADER = "traceparent";
export const PREVIOUS_SPAN_HEADER = "space.previous-span";

/** Only these argument identifiers can become exported span attributes. */
const identityKeys = ["traceId", "requestId", "roomId", "paneId", "missionId", "roomAgentMissionId",
  "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;
export const safeIdentifier = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value) ? value : null;

function records(args: readonly unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    result.push(record);
    if (depth > 0) for (const key of nestedKeys) visit(record[key], depth - 1);
  };
  for (const arg of args) visit(arg, 2);
  return result;
}

export function argumentTraceparent(args: readonly unknown[], key = "traceparent"): string | null {
  for (const record of records(args)) {
    const parsed = parseTraceparent(record[key]);
    if (parsed) return formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags);
  }
  return null;
}

/** Matches workflow-tracing's stable ID without consuming workflow randomness. */
export function workflowRunSpanId(runId: string): string | null {
  const hex = runId.replace(/-/g, "");
  const spanId = hex.slice(16);
  return /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(spanId) ? spanId : null;
}

export function traceIdentifiers(args: readonly unknown[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const record of records(args)) for (const key of identityKeys) {
    const value = safeIdentifier(record[key]);
    if (value && found[key] === undefined) found[key] = value;
  }
  return found;
}

export function headerTraceparent(headers: Headers, key = TRACE_HEADER): string | null {
  try {
    const payload = headers[key];
    if (!payload) return null;
    const parsed = parseTraceparent(defaultPayloadConverter.fromPayload(payload));
    return parsed ? formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags) : null;
  } catch { return null; }
}

export function withTraceHeader(headers: Headers, traceparent: string, previous?: string): Headers {
  return {
    ...headers,
    [TRACE_HEADER]: defaultPayloadConverter.toPayload(traceparent),
    ...(previous ? { [PREVIOUS_SPAN_HEADER]: defaultPayloadConverter.toPayload(previous) } : {})
  };
}

/** Stable codes only: never export Error.message, stack, details or causes. */
export function traceFailureCode(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown } | null;
  if (isSafeErrorCode(record?.code)) return record.code;
  if (isSafeErrorCode(record?.type)) return record.type;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "WORKFLOW_CANCELLED";
  if (/Timeout/i.test(name)) return "WORKFLOW_TIMEOUT";
  return "WORKFLOW_ERROR";
}
