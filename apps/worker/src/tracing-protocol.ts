import type { Headers } from "@temporalio/workflow";

/** Pure, bounded tracing data shared by the workflow sandbox and worker host. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: string;
}

export interface TraceLink {
  traceId: string;
  spanId: string;
}

export interface TraceEnvelope {
  context: TraceContext;
  /** Continue-as-new keeps the original parent, including an explicit root. */
  parentSpanId?: string | null;
  links?: TraceLink[];
  continuation?: true;
  /** A background continuation starts a new trace linked to its source. */
  root?: true;
}

export interface WorkflowTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 1;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: TraceLink[];
}

export const TRACE_CONTEXT_HEADER = "space-trace-context";
export const MAX_TRACE_LINKS = 16;
const MAX_HEADER_BYTES = 4096;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const flagsPattern = /^[0-9a-f]{2}$/;
const identifierPattern = /^[A-Za-z0-9:._-]{1,240}$/;
const typePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{1,95}$/;
const nestedInputKeys = ["turn", "turnInput", "item", "input", "bridge"] as const;

/** Restrict decoded carriers to object records; arrays and primitives carry no context. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Accept only nonzero, lowercase 128-bit W3C trace identifiers. */
export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && traceIdPattern.test(value) && !/^0+$/.test(value);
}

/** Accept only nonzero, lowercase 64-bit W3C span identifiers. */
export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && spanIdPattern.test(value) && !/^0+$/.test(value);
}

/** Copy only valid trace/span identifiers and flags from an untrusted carrier. */
export function sanitizeTraceContext(value: unknown): TraceContext | null {
  const record = recordOf(value);
  if (!record || !isTraceId(record.traceId) || !isSpanId(record.spanId)) return null;
  if (typeof record.flags !== "string" || !flagsPattern.test(record.flags)) return null;
  return { traceId: record.traceId, spanId: record.spanId, flags: record.flags };
}

/** Parse a bounded W3C header, rejecting reserved versions and invalid or zero identifiers. */
export function traceContextFromTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const normalized = value.trim().toLowerCase();
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/.exec(normalized);
  if (!match || match[1] === "ff" || (match[1] === "00" && normalized.length !== 55)) return null;
  return sanitizeTraceContext({ traceId: match[2], spanId: match[3], flags: match[4] });
}

/** Serialize an already validated context as a version-00 W3C traceparent. */
export function traceparentFromContext(value: TraceContext): string {
  return `00-${value.traceId}-${value.spanId}-${value.flags}`;
}

/** Inspect at most 32 candidates and retain at most 16 distinct, valid span links. */
export function sanitizeTraceLinks(value: unknown): TraceLink[] {
  if (!Array.isArray(value)) return [];
  const links: TraceLink[] = [];
  const seen = new Set<string>();
  // Bound both work and output, even when an untrusted caller supplied a huge array.
  for (const candidate of value.slice(0, MAX_TRACE_LINKS * 2)) {
    const record = recordOf(candidate);
    if (!record || !isTraceId(record.traceId) || !isSpanId(record.spanId)) continue;
    const key = `${record.traceId}:${record.spanId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ traceId: record.traceId, spanId: record.spanId });
    if (links.length === MAX_TRACE_LINKS) break;
  }
  return links;
}

/** Validate context and explicit continuation/root overrides before propagating an envelope. */
function sanitizeEnvelope(value: unknown): TraceEnvelope | null {
  const record = recordOf(value);
  if (!record) return null;
  const context = sanitizeTraceContext(record.context);
  if (!context) return null;
  const envelope: TraceEnvelope = { context };
  if (record.continuation === true) {
    // A parent override is meaningful only at a continuation boundary.
    if (record.parentSpanId !== null && !isSpanId(record.parentSpanId)) return null;
    envelope.continuation = true;
    envelope.parentSpanId = record.parentSpanId;
  }
  const links = sanitizeTraceLinks(record.links);
  if (links.length) envelope.links = links;
  if (record.root === true) {
    if (record.parentSpanId !== null) return null;
    envelope.root = true;
    envelope.parentSpanId = null;
  }
  return envelope;
}

/**
 * Encode sanitized ASCII envelopes without Node Buffer or browser text encoders,
 * neither of which belongs in the workflow sandbox.
 */
function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

/** Decode a validated ASCII envelope of at most 4096 bytes; malformed headers are ignored. */
export function readTraceHeader(headers: Headers | undefined): TraceEnvelope | null {
  const payload = headers?.[TRACE_CONTEXT_HEADER];
  const data = payload?.data;
  if (!data || data.length === 0 || data.length > MAX_HEADER_BYTES) return null;
  let json = "";
  for (const byte of data) {
    if (byte > 127) return null;
    json += String.fromCharCode(byte);
  }
  try {
    return sanitizeEnvelope(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Add our validated context without mutating or removing any other header. */
export function withTraceHeader(headers: Headers, value: TraceEnvelope): Headers {
  const envelope = sanitizeEnvelope(value);
  if (!envelope) return headers;
  return {
    ...headers,
    [TRACE_CONTEXT_HEADER]: {
      metadata: { encoding: asciiBytes("json/plain") },
      data: asciiBytes(JSON.stringify(envelope))
    }
  };
}

/** Visit at most 16 inputs through known keys to depth three, plus top-level memo fields. */
function visitInputs(args: readonly unknown[], memo: unknown, visit: (record: Record<string, unknown>) => void): void {
  const walk = (value: unknown, depth: number) => {
    const record = recordOf(value);
    if (!record) return;
    visit(record);
    if (depth > 0) for (const key of nestedInputKeys) walk(record[key], depth - 1);
  };
  for (const arg of args.slice(0, 16)) walk(arg, 3);
  walk(memo, 0);
}

/** Only explicit traceparent fields in known input shapes or memo are read. */
export function findTraceContext(args: readonly unknown[], memo?: unknown): TraceContext | null {
  let found: TraceContext | null = null;
  visitInputs(args, memo, record => { found ??= traceContextFromTraceparent(record.traceparent); });
  return found;
}

/** Gather and deduplicate bounded links from the same known input/memo shapes as context. */
export function findTraceLinks(args: readonly unknown[], memo?: unknown): TraceLink[] {
  const found: TraceLink[] = [];
  visitInputs(args, memo, record => {
    if (found.length < MAX_TRACE_LINKS) found.push(...sanitizeTraceLinks(record.traceLinks));
  });
  return sanitizeTraceLinks(found);
}

/** The carrier id of a background trace is not a recorded span or a parent. */
export function findBackgroundTrace(args: readonly unknown[]): TraceEnvelope | null {
  let found: TraceEnvelope | null = null;
  visitInputs(args, undefined, record => {
    if (found || !recordOf(record.roomAgentContinuation)) return;
    const context = traceContextFromTraceparent(record.traceparent);
    const links = sanitizeTraceLinks(record.traceLinks);
    if (context) found = { context, ...(links.length ? { links } : {}), parentSpanId: null, root: true };
  });
  return found;
}

const correlationAttributes: Readonly<Record<string, string>> = {
  traceId: "space.trace_id",
  spaceTraceId: "space.trace_id",
  requestId: "space.request_id",
  parentSpaceTraceId: "space.parent_trace_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  missionId: "space.mission_id",
  roomAgentMissionId: "space.mission_id",
  agentRunId: "space.agent_run_id",
  agentSessionId: "space.agent_session_id",
  actionId: "space.action_id",
  goalId: "space.goal_id",
  dotId: "space.dot_id",
  turnId: "space.turn_id",
  cliTaskId: "space.cli_task_id",
  revisionId: "space.revision_id"
};

const identifierAttributes = new Set([
  "temporal.workflow.id", "temporal.run.id", "temporal.activity.id",
  ...Object.values(correlationAttributes)
]);
const typeAttributes = new Set(["temporal.workflow.type", "temporal.activity.type"]);
const outcomes = new Set(["COMPLETED", "FAILED_RESULT", "FAILED", "CANCELLED", "CONTINUED_AS_NEW"]);
const failureCategories = new Set([
  "TIMEOUT", "TOOL_UNAVAILABLE", "PERMISSION_DENIED", "NOT_FOUND", "INVALID_INPUT", "CONFLICT", "RATE_LIMITED",
  "DISABLED", "CONFIGURATION", "STATE_UNAVAILABLE", "PROTOCOL_ERROR", "PROVIDER_ERROR", "UPSTREAM_UNAVAILABLE", "CANCELLED", "INTERNAL"
]);

/** Worker export never accepts arbitrary attributes or free-form error text. */
export function sanitizeTraceAttributes(value: unknown): Record<string, string | number> {
  const input = recordOf(value);
  const attributes: Record<string, string | number> = {};
  if (!input) return attributes;
  for (const key of identifierAttributes) {
    const candidate = input[key];
    if (typeof candidate === "string" && identifierPattern.test(candidate)) attributes[key] = candidate;
  }
  for (const key of typeAttributes) {
    const candidate = input[key];
    if (typeof candidate === "string" && typePattern.test(candidate)) attributes[key] = candidate;
  }
  if (Number.isSafeInteger(input["temporal.activity.attempt"]) && (input["temporal.activity.attempt"] as number) > 0) {
    attributes["temporal.activity.attempt"] = input["temporal.activity.attempt"] as number;
  }
  for (const [key, allowed] of [["space.outcome", outcomes], ["space.failure_category", failureCategories]] as const) {
    const candidate = input[key];
    if (typeof candidate === "string" && allowed.has(candidate)) attributes[key] = candidate;
  }
  const code = input["space.reason_code"];
  if (typeof code === "string" && errorCodePattern.test(code)) attributes["space.reason_code"] = code;
  return attributes;
}

/** Map allowlisted correlation identifiers to span attributes without copying payload text. */
export function traceCorrelationAttributes(args: readonly unknown[], memo?: unknown): Record<string, string | number> {
  const found: Record<string, unknown> = {};
  visitInputs(args, memo, record => {
    for (const [source, target] of Object.entries(correlationAttributes)) {
      const value = record[source];
      if (found[target] === undefined && typeof value === "string" && identifierPattern.test(value)) found[target] = value;
    }
  });
  return sanitizeTraceAttributes(found);
}

/** Derive nonzero deterministic IDs without sandbox randomness; this hash is not cryptographic. */
function stableHex(value: string, seeds: readonly number[]): string {
  const result = seeds.map(seed => {
    let hash = seed;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, "0");
  }).join("");
  return /^0+$/.test(result) ? `${result.slice(0, -1)}1` : result;
}

/** Server-generated run ids supply uniqueness, without consuming workflow PRNG. */
export function workflowSpanId(runId: string): string {
  return stableHex(`workflow:${runId}`, [0x811c9dc5, 0x9e3779b9]);
}

/** A workflow without a propagated parent owns a deterministic root trace. */
export function workflowTraceId(runId: string): string {
  const uuid = runId.replace(/-/g, "").toLowerCase();
  return isTraceId(uuid) ? uuid : stableHex(`trace:${runId}`, [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]);
}
