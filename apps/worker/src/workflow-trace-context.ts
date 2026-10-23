import { formatTraceparent, parseTraceparent, type ParsedTraceparent } from "@space/contracts";

/**
 * Trace context for workflow and activity spans. Pure functions only: this
 * module is imported by the workflow sandbox, so it does no I/O, reads no clock
 * and draws no random numbers. Span ids are derived from Temporal's own
 * identifiers, so a replayed workflow computes exactly the ids it had.
 */

/** Temporal header naming the span a workflow, child workflow or activity runs under. */
export const TRACEPARENT_HEADER = "space-traceparent";
/** Temporal header naming a span the next run links to (continue-as-new). */
export const TRACE_LINK_HEADER = "space-tracelink";

/** 32-bit FNV-1a hash of `text` from `seed`: deterministic and sandbox-safe. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A `words` x 8 hex-digit id derived from `text`, never all zeros. */
function derivedHex(text: string, words: number): string {
  let value = "";
  for (let word = 0; word < words; word++) {
    value += fnv1a32(text, (0x811c9dc5 ^ Math.imul(word + 1, 0x9e3779b1)) >>> 0).toString(16).padStart(8, "0");
  }
  // All-zero ids are invalid in W3C trace context and OTLP.
  return /^0+$/.test(value) ? `${value.slice(0, -1)}1` : value;
}

export interface WorkflowRunIdentity {
  workflowId: string;
  /** The run this one continues (continue-as-new, retry or cron), if any. */
  continuedFromExecutionRunId?: string | null;
  attempt?: number;
}

/**
 * The span id of one workflow run. It depends only on values that are known
 * before the run starts, so the run that continues a workflow (or the activity
 * that prepares a background continuation) can name it in a span link.
 */
export function workflowRunSpanId(run: WorkflowRunIdentity): string {
  return derivedHex(`workflow\u0000${run.workflowId}\u0000${run.continuedFromExecutionRunId ?? ""}\u0000${run.attempt ?? 1}`, 2);
}

/** Trace id for a workflow chain that no request started (for example a scheduled run). */
export function rootWorkflowTraceId(workflowId: string, firstExecutionRunId: string): string {
  return derivedHex(`trace\u0000${workflowId}\u0000${firstExecutionRunId}`, 4);
}

/** Span id of one activity attempt. */
export function activityAttemptSpanId(workflowRunId: string, activityId: string, attempt: number): string {
  return derivedHex(`activity\u0000${workflowRunId}\u0000${activityId}\u0000${attempt}`, 2);
}

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

/** The string at `key` in `value` or in its known nested inputs, up to `depth` levels down. */
function findString(value: unknown, key: string, depth: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  if (depth <= 0) return null;
  for (const nested of nestedKeys) {
    const found = findString(record[nested], key, depth - 1);
    if (found !== null) return found;
  }
  return null;
}

/** The first valid `key` traceparent in workflow or activity arguments (top level or one known nesting). */
export function traceparentInArgs(args: readonly unknown[], key = "traceparent"): ParsedTraceparent | null {
  for (const arg of args) {
    const parsed = parseTraceparent(findString(arg, key, 2));
    if (parsed) return parsed;
  }
  return null;
}

export interface SpanContextRef {
  traceId: string;
  spanId: string;
}

export interface WorkflowRunTrace {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  links: SpanContextRef[];
}

export interface WorkflowRunTraceSources {
  workflowId: string;
  firstExecutionRunId: string;
  continuedFromExecutionRunId?: string | null;
  attempt?: number;
  /** traceparent from the Temporal header (parent workflow or previous run). */
  header?: ParsedTraceparent | null;
  /** Link header from the previous run (continue-as-new). */
  linkHeader?: ParsedTraceparent | null;
  /** traceparent carried in the workflow input (the request that asked for this run). */
  args?: ParsedTraceparent | null;
  /** Explicit continuation link carried in the workflow input. */
  continues?: ParsedTraceparent | null;
  /** traceparent from the workflow memo (set by the API when it starts the workflow). */
  memo?: ParsedTraceparent | null;
}

/** The span a parsed traceparent names. */
const ref = (parsed: ParsedTraceparent): SpanContextRef => ({ traceId: parsed.traceId, spanId: parsed.parentId });

/**
 * Where a workflow run sits in the trace. The request named in the input wins,
 * so a turn that a long-lived supervisor runs belongs to its own request; the
 * parent workflow is then a link. Without one the run nests under the parent
 * workflow (or the previous run), then under the span named in the memo, and
 * otherwise starts its own trace.
 */
export function resolveWorkflowRunTrace(sources: WorkflowRunTraceSources): WorkflowRunTrace {
  const spanId = workflowRunSpanId(sources);
  const parent = sources.args ?? sources.header ?? sources.memo ?? null;
  const links: SpanContextRef[] = [];
  /** Adds a link once, skipping this run's own span. */
  const addLink = (parsed: ParsedTraceparent | null | undefined) => {
    if (!parsed) return;
    const link = ref(parsed);
    if (link.traceId === (parent?.traceId ?? link.traceId) && link.spanId === spanId) return;
    if (!links.some((existing) => existing.traceId === link.traceId && existing.spanId === link.spanId)) links.push(link);
  };
  if (sources.args) addLink(sources.header);
  addLink(sources.linkHeader);
  addLink(sources.continues);
  return {
    traceId: parent?.traceId ?? rootWorkflowTraceId(sources.workflowId, sources.firstExecutionRunId),
    spanId,
    parentSpanId: parent?.parentId ?? null,
    links
  };
}

/** W3C traceparent naming `context` as the parent span. */
export function traceparentOf(context: SpanContextRef): string {
  return formatTraceparent(context.traceId, context.spanId);
}
