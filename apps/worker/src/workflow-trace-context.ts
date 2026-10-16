// Pure helpers shared by the workflow sandbox and the worker process.
import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { parseTraceparent } from "@space/contracts";

export const TRACE_HEADER = "space-otlp-context";
export interface SpanContext { traceId: string; spanId: string }
export interface TraceContext extends SpanContext { links?: SpanContext[] }
const tracePattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const spanPattern = /^(?!0{16}$)[0-9a-f]{16}$/;
/** Accept only nonzero W3C trace/span identifiers at the workflow boundary. */
export function validContext(value: unknown): value is SpanContext {
  if (!value || typeof value !== "object") return false;
  const v = value as SpanContext;
  return typeof v.traceId === "string" && tracePattern.test(v.traceId) && typeof v.spanId === "string" && spanPattern.test(v.spanId);
}
/** Extract a caller's trace and parent span from a valid W3C traceparent. */
export function contextFromTraceparent(value: unknown): SpanContext | null {
  const p = parseTraceparent(value);
  return p ? { traceId: p.traceId, spanId: p.parentId } : null;
}
/** Decode the private Temporal trace header, dropping malformed context and excess links. */
export function contextFromHeaders(headers: Headers): TraceContext | null {
  try {
    const payload = headers[TRACE_HEADER];
    const value: unknown = payload ? defaultPayloadConverter.fromPayload(payload) : null;
    if (!validContext(value)) return null;
    const links = (value as TraceContext).links;
    return { traceId: value.traceId, spanId: value.spanId, ...(Array.isArray(links) ? { links: links.filter(validContext).slice(0, 4).map(({ traceId, spanId }) => ({ traceId, spanId })) } : {}) };
  } catch { return null; }
}
/** Add propagation context without replacing unrelated Temporal headers. */
export function withTraceHeader(headers: Headers, context: TraceContext): Headers {
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(context)! };
}
/** Read traceparents only from the allowlisted input envelopes, at bounded depth. */
export function inputTraceContext(args: readonly unknown[]): SpanContext | null {
  function visit(value: unknown, depth: number): SpanContext | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const context = contextFromTraceparent(v.traceparent);
    if (context) return context;
    if (depth > 0) for (const key of ["turn", "item", "bridge", "input", "turnInput"]) {
      const child = visit(v[key], depth - 1);
      if (child) return child;
    }
    return null;
  }
  for (const arg of args) { const context = visit(arg, 2); if (context) return context; }
  return null;
}
/** Run IDs are UUIDs supplied by Temporal; no randomness or additional workflow commands. */
export function runSpanId(runId: string): string { return runId.replace(/-/g, "").slice(-16); }
/** Use the Temporal run UUID as a deterministic trace ID for unparented executions. */
export function runTraceId(runId: string): string { return runId.replace(/-/g, ""); }
/** Identify room-agent continuation inputs that need links to prior execution context. */
export function isBackgroundContinuation(args: readonly unknown[]): boolean {
  return args.some(arg => Boolean(arg && typeof arg === "object" && (
    (arg as { roomAgentContinuation?: unknown }).roomAgentContinuation ||
    (arg as { turn?: { roomAgentContinuation?: unknown } }).turn?.roomAgentContinuation
  )));
}
const attributeKeys = new Set(["workflowId", "runId", "workflowType", "activityType", "attempt", "status", "reasonCode", "category", "durationMs", "roomId", "paneId", "missionId"]);
const identifier = /^[A-Za-z0-9:._-]{1,200}$/;
/** Enforce the export boundary even if a caller supplies extra fields or free-form values. */
export function traceAttributes(values: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!attributeKeys.has(key)) continue;
    if (["attempt", "durationMs"].includes(key)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
    } else if (typeof value === "string" && identifier.test(value)) out[key] = value;
  }
  return out;
}
