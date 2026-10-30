import type { Headers, Sinks } from "@temporalio/workflow";

/** The same W3C value is used in Temporal headers, arguments and memo. */
export const TRACE_HEADER = "traceparent";
export const TRACE_LINK_HEADER = "space-trace-link";

export interface TraceContext { traceId: string; spanId: string; flags: string }
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED";
  links?: readonly { traceId: string; spanId: string }[];
  correlation?: Record<string, string>;
}
export interface WorkflowTracingSinks extends Sinks {
  spaceTracing: { record(span: WorkflowSpanRecord): void };
}

export function parseWorkflowTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== "string") return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]!, flags: match[3]! };
}

export function workflowTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/** Header values are short ASCII JSON strings; no converter or I/O is needed in the sandbox. */
export function traceHeader(value: string): Headers[string] {
  return {
    metadata: { encoding: Uint8Array.from("json/plain", char => char.charCodeAt(0)) },
    data: Uint8Array.from(JSON.stringify(value), char => char.charCodeAt(0))
  };
}

export function traceFromHeaders(headers: Headers, key = TRACE_HEADER): TraceContext | null {
  const payload = headers[key];
  if (!payload?.data || payload.data.length > 256) return null;
  try {
    return parseWorkflowTraceparent(JSON.parse(String.fromCharCode(...payload.data)));
  } catch { return null; }
}

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;
const correlationKeys = ["roomId", "paneId", "missionId", "roomAgentMissionId", "goalId", "actionId", "turnId", "agentRunId"] as const;
const safeIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value);

export function traceArgument(args: readonly unknown[], key = TRACE_HEADER): TraceContext | null {
  const visit = (value: unknown, depth: number): TraceContext | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const direct = parseWorkflowTraceparent(record[key]);
    if (direct) return direct;
    if (!depth) return null;
    for (const name of nestedKeys) {
      const found = visit(record[name], depth - 1);
      if (found) return found;
    }
    return null;
  };
  for (const arg of args) {
    const found = visit(arg, 2);
    if (found) return found;
  }
  return null;
}

export function workflowCorrelation(args: readonly unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of correlationKeys) {
      if (safeIdentifier(record[key])) result[key] ??= record[key];
    }
    if (depth) for (const key of nestedKeys) visit(record[key], depth - 1);
  };
  for (const arg of args) visit(arg, 2);
  return result;
}

/** Stable tracing IDs do not consume the workflow's deterministic random stream. */
export function workflowSpanId(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`.replace(/^0{16}$/, "0000000000000001");
}

export function safeWorkflowIdentifier(value: unknown): string | null {
  return safeIdentifier(value) ? value : null;
}
