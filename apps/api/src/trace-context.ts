import { randomBytes } from "node:crypto";
import { formatTraceparent, parseTraceparent } from "@space/contracts";

/**
 * Lightweight local W3C trace context. The server-owned request id
 * (`req:...`, called `traceId` in Space contracts) stays the primary
 * correlation id. The W3C trace id is accepted from a valid inbound
 * `traceparent` header (or generated) and propagated next to it so an
 * external tracing system can join Space logs without any collector being
 * required. Nothing here exports spans anywhere.
 */
export interface RequestTraceContext {
  /** 32 lower-case hex characters. */
  w3cTraceId: string;
  /** This request's span id (16 hex). */
  spanId: string;
  /** The caller's span id when a valid traceparent was received. */
  parentSpanId: string | null;
  /** traceparent naming this request's span, for propagation to children. */
  traceparent: string;
  inbound: boolean;
}

function randomHex(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(value)) return value;
  }
}

export function createRequestTraceContext(header: unknown, random: (bytes: number) => string = randomHex): RequestTraceContext {
  const inbound = parseTraceparent(Array.isArray(header) ? header[0] : header);
  const w3cTraceId = inbound?.traceId ?? random(16);
  const spanId = random(8);
  return {
    w3cTraceId,
    spanId,
    parentSpanId: inbound?.parentId ?? null,
    traceparent: formatTraceparent(w3cTraceId, spanId, inbound?.flags ?? "01"),
    inbound: Boolean(inbound)
  };
}

/** A traceparent for a child operation: same trace, new span. Null if invalid. */
export function childTraceparent(traceparent: string | null | undefined, random: (bytes: number) => string = randomHex): string | null {
  const parsed = parseTraceparent(traceparent);
  return parsed ? formatTraceparent(parsed.traceId, random(8), parsed.flags) : null;
}

const rawRequestContexts = new WeakMap<object, RequestTraceContext>();

/**
 * One context per raw HTTP request. Fastify creates the request logger before
 * the onRequest hook runs, so both share the context through the raw request.
 */
export function traceContextForRawRequest(raw: { headers?: Record<string, unknown> } | null | undefined): RequestTraceContext {
  if (!raw || typeof raw !== "object") return createRequestTraceContext(undefined);
  const existing = rawRequestContexts.get(raw);
  if (existing) return existing;
  const created = createRequestTraceContext(raw.headers?.traceparent);
  rawRequestContexts.set(raw, created);
  return created;
}

/**
 * Bounded map from server request id to its trace context, so code that only
 * receives the request id (`traceId`) can attach the W3C context when it starts
 * a workflow, without threading the request object through every service.
 */
export class TraceContextRegistry {
  private readonly contexts = new Map<string, RequestTraceContext>();

  constructor(private readonly capacity = 4096) {}

  remember(requestId: string, context: RequestTraceContext): void {
    if (!requestId) return;
    this.contexts.delete(requestId);
    this.contexts.set(requestId, context);
    while (this.contexts.size > this.capacity) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
  }

  lookup(requestId: string | null | undefined): RequestTraceContext | null {
    return requestId ? this.contexts.get(requestId) ?? null : null;
  }

  get size(): number {
    return this.contexts.size;
  }
}

export const requestTraceContexts = new TraceContextRegistry();

/** traceparent for work started on behalf of this Space request id, if known. */
export function traceparentForTraceId(traceId: string | null | undefined, registry = requestTraceContexts): string | null {
  // Propagation names the recorded API span. The receiving operation creates
  // its own span ID; allocating one here would leave an unrecorded parent.
  return registry.lookup(traceId)?.traceparent ?? null;
}

/** Adds the request's traceparent to a turn input unless it already has a valid one. */
export function withTurnTraceparent<T extends { traceId: string; traceparent?: string | undefined }>(turn: T, registry = requestTraceContexts): T {
  if (parseTraceparent(turn.traceparent)) return turn;
  const traceparent = traceparentForTraceId(turn.traceId, registry);
  return traceparent ? { ...turn, traceparent } : turn;
}

const memoIdPattern = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * Temporal memo with correlation identifiers only. Memo is visible to anyone
 * with Temporal access, so it carries ids, never prompts, paths or errors.
 */
export function workflowCorrelationMemo(input: {
  traceId: string | null | undefined;
  traceparent?: string | null;
  parentTraceId?: string | null;
  missionId?: string | null;
}): Record<string, string> {
  const memo: Record<string, string> = {};
  if (input.traceId && memoIdPattern.test(input.traceId)) memo.spaceTraceId = input.traceId;
  const parsed = parseTraceparent(input.traceparent);
  if (parsed) {
    memo.traceparent = formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags);
    memo.w3cTraceId = parsed.traceId;
  }
  if (input.parentTraceId && memoIdPattern.test(input.parentTraceId)) memo.parentSpaceTraceId = input.parentTraceId;
  if (input.missionId && memoIdPattern.test(input.missionId)) memo.missionId = input.missionId;
  return memo;
}
