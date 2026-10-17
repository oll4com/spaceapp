/** Pure wire protocol shared by the workflow isolate and activity host. */
export const TRACE_HEADER = "space-otlp-v1";
export interface TraceReference { traceId: string; spanId: string }
export interface TraceContext extends TraceReference { links?: TraceReference[]; root?: true }
export interface TraceRecord extends TraceContext {
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  endedAt: number;
  attributes: Record<string, string | number>;
  error: boolean;
}
const validHex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
export function traceReference(value: unknown): TraceReference | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as TraceReference;
  return validHex(ref.traceId, 32) && validHex(ref.spanId, 16) ? { traceId: ref.traceId, spanId: ref.spanId } : null;
}
export function parseParent(value: unknown): TraceReference | null {
  if (typeof value !== "string" || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value)) return null;
  const [, traceId, spanId] = value.split("-");
  return traceReference({ traceId, spanId });
}
export function formatParent(ref: TraceReference): string { return `00-${ref.traceId}-${ref.spanId}-01`; }
export function contextFrom(value: unknown): TraceContext | null {
  const ref = traceReference(value);
  if (!ref) return null;
  const links = (value as TraceContext).links;
  return { ...ref, ...((value as TraceContext).root === true ? { root: true as const } : {}),
    ...(Array.isArray(links) ? { links: links.slice(0, 8).map(traceReference).filter((x): x is TraceReference => x !== null) } : {}) };
}
type Headers = Record<string, { data?: Uint8Array | null; metadata?: Record<string, Uint8Array> | null }>;
export function readTraceHeader(headers: Headers): TraceContext | null {
  const data = headers[TRACE_HEADER]?.data;
  if (!data || data.byteLength > 2048) return null;
  try { return contextFrom(JSON.parse(new TextDecoder().decode(data))); } catch { return null; }
}
export function writeTraceHeader<T extends Headers>(headers: T, context: TraceContext): T {
  return { ...headers, [TRACE_HEADER]: {
    metadata: { encoding: new TextEncoder().encode("json/plain") },
    data: new TextEncoder().encode(JSON.stringify(contextFrom(context)))
  } };
}
/** Read only known context containers, never search arbitrary user content. */
export function parentFromArgs(args: readonly unknown[], depth = 3): TraceContext | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
    const value = arg as Record<string, unknown>;
    const parent = parseParent(value.traceparent);
    if (parent) return { ...parent, ...(typeof value.traceId === "string" && value.traceId.startsWith("trace:bg-") ? { root: true as const } : {}), links: Array.isArray(value.traceLinks)
      ? value.traceLinks.slice(0, 8).map(parseParent).filter((x): x is TraceReference => x !== null) : [] };
    if (depth > 0) {
      const nested = parentFromArgs([value.turn, value.input, value.item, value.turnInput], depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}
/** Stable ids without consuming the workflow's deterministic random stream. */
export function stableSpanId(seed: string): string {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    a = Math.imul(a ^ seed.charCodeAt(i), 16777619);
    b = Math.imul(b ^ seed.charCodeAt(i), 2246822519);
  }
  const id = (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  return /^0+$/.test(id) ? "0000000000000001" : id;
}
const identifier = /^[A-Za-z0-9:._-]{1,200}$/;
const idKeys = new Set(["space.workflow_id", "space.run_id", "space.room_id", "space.pane_id", "space.mission_id"]);
const enums = new Set(["space.workflow_type", "space.activity_type", "space.outcome", "space.reason_code", "space.category"]);
export function safeTraceAttributes(input: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((idKeys.has(key) || enums.has(key)) && typeof value === "string" && identifier.test(value)) result[key] = value;
    if ((key === "space.attempt" || key === "space.duration_ms") && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}
