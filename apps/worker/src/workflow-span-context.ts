import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { formatTraceparent, parseTraceparent } from "@space/contracts";

export const WORKFLOW_SPAN_HEADER = "space.workflow-span";

export interface WorkflowSpanContext {
  traceId: string;
  spanId: string;
  /** A new run links to, rather than becoming a child of, the previous run. */
  link?: boolean;
}

export interface WorkflowSpanReport {
  context: WorkflowSpanContext;
  parentSpanId: string | null;
  links: WorkflowSpanContext[];
  startedAt: number;
  finishedAt: number;
  attributes: Record<string, string | number>;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  reasonCode?: string;
}

export function validHexId(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
}

export function validSpanContext(value: unknown): value is WorkflowSpanContext {
  if (!value || typeof value !== "object") return false;
  const context = value as WorkflowSpanContext;
  return validHexId(context.traceId, 32) && validHexId(context.spanId, 16)
    && (context.link === undefined || typeof context.link === "boolean");
}

/** Pure deterministic IDs: no random-number consumption or workflow commands. */
export function workflowHexId(value: string, length: 16 | 32): string {
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(128, hash * 0x1000000000000000000013bn);
  }
  const id = hash.toString(16).padStart(32, "0").slice(0, length);
  return /^0+$/.test(id) ? `${id.slice(1)}1` : id;
}

export function spanContextFromHeaders(headers: Headers): WorkflowSpanContext | null {
  const payload = headers[WORKFLOW_SPAN_HEADER];
  if (!payload || !payload.data || payload.data.byteLength > 1024) return null;
  try {
    const value: unknown = defaultPayloadConverter.fromPayload(payload);
    return validSpanContext(value) ? { traceId: value.traceId, spanId: value.spanId, ...(value.link ? { link: true } : {}) } : null;
  } catch { return null; }
}

export function headersWithSpanContext(headers: Headers, context: WorkflowSpanContext): Headers {
  return { ...headers, [WORKFLOW_SPAN_HEADER]: defaultPayloadConverter.toPayload(context) };
}

const correlationKeys = ["traceparent", "sourceTraceparent", "traceId", "roomId", "paneId", "missionId", "roomAgentMissionId"] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;
export type SpanCorrelation = Partial<Record<(typeof correlationKeys)[number], string>>;

/** Read only known correlation fields; never traverse messages, prompts or results. */
export function spanCorrelation(args: readonly unknown[]): SpanCorrelation {
  const found: SpanCorrelation = {};
  function read(value: unknown, depth: number): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of correlationKeys) {
      const field = record[key];
      if (found[key] === undefined && typeof field === "string" && field.length <= 240) found[key] = field;
    }
    if (depth > 0) for (const key of nestedKeys) read(record[key], depth - 1);
  }
  for (const arg of args) read(arg, 3);
  return found;
}

export function correlationSpanAttributes(correlation: SpanCorrelation): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of [
    ["space.trace_id", correlation.traceId], ["space.room_id", correlation.roomId],
    ["space.pane_id", correlation.paneId], ["space.mission_id", correlation.missionId ?? correlation.roomAgentMissionId]
  ]) {
    if (value && /^[A-Za-z0-9:._-]{1,240}$/.test(value)) attributes[key!] = value;
  }
  return attributes;
}

/** An explicit new request takes precedence over a long-lived supervisor's trace. */
export function resolveWorkflowSpanContext(input: {
  workflowId: string; runId: string; args: readonly unknown[]; headers: Headers; memo?: Record<string, unknown>;
}): Pick<WorkflowSpanReport, "context" | "parentSpanId" | "links"> {
  const correlation = spanCorrelation(input.args);
  const explicit = parseTraceparent(correlation.traceparent);
  const source = parseTraceparent(correlation.sourceTraceparent);
  const inherited = spanContextFromHeaders(input.headers);
  const memo = parseTraceparent(input.memo?.traceparent);
  // A background turn starts its own trace. The source request is a link only.
  const background = Boolean(source && correlation.traceId?.startsWith("trace:bg-"));
  const parent = background ? null
    : inherited?.link ? null
    : explicit && (!inherited || explicit.traceId !== inherited.traceId) ? { traceId: explicit.traceId, spanId: explicit.parentId }
    : inherited ?? (explicit ? { traceId: explicit.traceId, spanId: explicit.parentId }
      : memo ? { traceId: memo.traceId, spanId: memo.parentId } : null);
  const traceId = background ? workflowHexId(`trace:${input.runId}`, 32)
    : inherited?.link ? inherited.traceId
    : parent?.traceId ?? workflowHexId(`trace:${input.runId}`, 32);
  const links: WorkflowSpanContext[] = [];
  if (inherited?.link) links.push({ traceId: inherited.traceId, spanId: inherited.spanId });
  if (source) links.push({ traceId: source.traceId, spanId: source.parentId });
  return {
    context: { traceId, spanId: workflowHexId(`workflow:${input.workflowId}:${input.runId}`, 16) },
    parentSpanId: parent?.spanId ?? null,
    links
  };
}

/** Reconstruct a completed turn's actual span from durable run metadata. */
export function continuationSourceTraceparent(input: {
  workflowId: string; temporalRunId: string | null; turn: unknown;
}): string | undefined {
  const correlation = spanCorrelation([input.turn]);
  if (input.temporalRunId && (parseTraceparent(correlation.traceparent) || parseTraceparent(correlation.sourceTraceparent))) {
    const { context } = resolveWorkflowSpanContext({ workflowId: input.workflowId, runId: input.temporalRunId, args: [input.turn], headers: {} });
    return formatTraceparent(context.traceId, context.spanId);
  }
  return correlation.traceparent ?? correlation.sourceTraceparent;
}
