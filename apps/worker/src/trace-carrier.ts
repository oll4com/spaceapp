/** Pure, bounded tracing metadata. Safe to import into a Temporal workflow. */
export interface TraceLink { traceId: string; spanId: string; }
export interface TraceCarrier { traceId: string; parentSpanId: string | null; flags: string; links?: readonly TraceLink[]; }
export interface TraceContext { traceId: string; spanId: string; flags: string; }
export const TRACE_HEADER = "space-otel-context-v1";
type Payload = { metadata?: Record<string, Uint8Array> | null; data?: Uint8Array | null };
type Headers = Record<string, Payload>;
const tracePattern = /^[0-9a-f]{32}$/;
const spanPattern = /^[0-9a-f]{16}$/;
const valid = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value) && !/^0+$/.test(value);

export function parseParent(value: unknown): TraceCarrier | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value.trim().toLowerCase());
  return match && valid(match[1], tracePattern) && valid(match[2], spanPattern)
    ? { traceId: match[1], parentSpanId: match[2], flags: match[3]! } : null;
}

/** Does not touch Temporal's seeded random stream or application UUID sequence. */
export function stableSpanId(key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < key.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(key.charCodeAt(index))) * 0x100000001b3n);
  return (hash || 1n).toString(16).padStart(16, "0");
}

export function traceIdForRun(runId: string): string {
  const compact = runId.replaceAll("-", "").toLowerCase();
  return valid(compact, tracePattern) ? compact : stableSpanId(`trace:${runId}`) + stableSpanId(`trace2:${runId}`);
}

export function contextForRun(runId: string, parent: TraceCarrier | null): TraceContext {
  return { traceId: parent?.traceId ?? traceIdForRun(runId), spanId: stableSpanId(`workflow:${runId}`), flags: parent?.flags ?? "01" };
}

export function carrierForChild(context: TraceContext): TraceCarrier {
  return { traceId: context.traceId, parentSpanId: context.spanId, flags: context.flags };
}

export function carrierForContinuation(context: TraceContext, parent: TraceCarrier | null): TraceCarrier {
  return { traceId: context.traceId, parentSpanId: parent?.parentSpanId ?? null, flags: context.flags, links: [{ traceId: context.traceId, spanId: context.spanId }] };
}

function sanitizeCarrier(value: unknown): TraceCarrier | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<TraceCarrier>;
  if (!valid(item.traceId, tracePattern) || !(item.parentSpanId === null || valid(item.parentSpanId, spanPattern)) || typeof item.flags !== "string" || !/^[0-9a-f]{2}$/.test(item.flags)) return null;
  const links = Array.isArray(item.links) ? item.links.slice(0, 8).filter(link => link && valid(link.traceId, tracePattern) && valid(link.spanId, spanPattern)).map(link => ({ traceId: link.traceId, spanId: link.spanId })) : [];
  return { traceId: item.traceId, parentSpanId: item.parentSpanId, flags: item.flags, ...(links.length ? { links } : {}) };
}

// The carrier alphabet is ASCII. No workflow-side codec or Node module needed.
const ascii = (value: string) => Uint8Array.from(value, char => char.charCodeAt(0));
export function withTraceHeader<T extends Headers>(headers: T, carrier: TraceCarrier): T & Headers {
  const clean = sanitizeCarrier(carrier);
  return clean ? { ...headers, [TRACE_HEADER]: { metadata: { encoding: ascii("json/plain") }, data: ascii(JSON.stringify(clean)) } } : headers;
}

export function parentFromHeaders(headers: Headers): TraceCarrier | null {
  const payload = headers[TRACE_HEADER];
  if (!payload?.data || payload.data.length > 2048 || payload.metadata?.encoding?.length !== 10 || String.fromCharCode(...payload.metadata.encoding) !== "json/plain") return null;
  try { return sanitizeCarrier(JSON.parse(String.fromCharCode(...payload.data))); } catch { return null; }
}

/** Read only known carrier locations. Never traverse prompts, results or arbitrary objects. */
export function parentFromArgs(args: readonly unknown[]): TraceCarrier | null {
  const visit = (value: unknown, depth: number): TraceCarrier | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const own = parseParent(record.traceparent);
    if (own) return own;
    if (depth > 0) for (const key of ["turn", "item", "bridge", "input", "turnInput"] as const) {
      const nested = visit(record[key], depth - 1); if (nested) return nested;
    }
    return null;
  };
  for (const arg of args) { const parent = visit(arg, 2); if (parent) return parent; }
  return null;
}

/** A background turn has an independent trace plus a link to its causal span. */
export function backgroundParentFromArgs(args: readonly unknown[]): TraceCarrier | null {
  const visit = (value: unknown, depth: number): TraceCarrier | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const continuation = record.roomAgentContinuation as { w3cTraceId?: unknown; sourceTraceparent?: unknown } | undefined;
    const previous = parseParent(continuation?.sourceTraceparent);
    if (previous && valid(continuation?.w3cTraceId, tracePattern)) return {
      traceId: continuation.w3cTraceId, parentSpanId: null, flags: previous.flags,
      links: [{ traceId: previous.traceId, spanId: previous.parentSpanId! }]
    };
    if (depth > 0) for (const key of ["turn", "item", "input"] as const) {
      const nested = visit(record[key], depth - 1); if (nested) return nested;
    }
    return null;
  };
  for (const arg of args) { const parent = visit(arg, 2); if (parent) return parent; }
  return null;
}

export function correlationAttributes(args: readonly unknown[]): Record<string, string> {
  const found: Record<string, string> = {};
  const keys: Record<string, string> = { roomId: "space.room_id", paneId: "space.pane_id", missionId: "space.mission_id", roomAgentMissionId: "space.mission_id", agentRunId: "space.agent_run_id", turnId: "space.turn_id", traceId: "space.request_id" };
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const [key, name] of Object.entries(keys)) {
      const id = record[key];
      if (!found[name] && typeof id === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(id)) found[name] = id;
    }
    if (depth > 0) for (const key of ["turn", "item", "bridge", "input", "turnInput"]) visit(record[key!], depth - 1);
  };
  for (const arg of args) visit(arg, 2);
  return found;
}
