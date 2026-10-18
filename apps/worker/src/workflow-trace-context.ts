import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { parseTraceparent } from "@space/contracts";
import type { SpanLink } from "@space/runtime";

export const TRACE_HEADER = "space-otlp-context";
const MISSION_HEADER = "space-otlp-mission-contexts";
export const MAX_MISSION_CONTEXTS = 256;

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface TraceContext extends SpanContext {
  links?: readonly SpanLink[];
}

const tracePattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const spanPattern = /^(?!0{16}$)[0-9a-f]{16}$/;
const linkReasons = new Set(["continue_as_new", "background_continuation", "room_agent_mission"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validContext(value: unknown): value is SpanContext {
  if (!value || typeof value !== "object") return false;
  const context = value as SpanContext;
  return typeof context.traceId === "string" && tracePattern.test(context.traceId) &&
    typeof context.spanId === "string" && spanPattern.test(context.spanId);
}

export function contextFromTraceparent(value: unknown): SpanContext | null {
  const parsed = parseTraceparent(value);
  return parsed ? { traceId: parsed.traceId, spanId: parsed.parentId } : null;
}

function validLink(value: unknown): SpanLink | null {
  if (!validContext(value)) return null;
  const candidate = value as SpanLink;
  const reason = candidate.attributes?.["link.reason"];
  const attributes = typeof reason === "string" && linkReasons.has(reason) ? { "link.reason": reason } : undefined;
  return { traceId: candidate.traceId, spanId: candidate.spanId, ...(attributes ? { attributes } : {}) };
}

export function contextFromHeaders(headers: Headers | undefined): TraceContext | null {
  try {
    const payload = headers?.[TRACE_HEADER];
    const value: unknown = payload ? defaultPayloadConverter.fromPayload(payload) : null;
    if (!validContext(value)) return null;
    const rawLinks = (value as TraceContext).links;
    const links = Array.isArray(rawLinks)
      ? rawLinks.map(validLink).filter((link): link is SpanLink => link !== null).slice(0, 4)
      : [];
    return { traceId: value.traceId, spanId: value.spanId, ...(links.length ? { links } : {}) };
  } catch {
    return null;
  }
}

export function withTraceHeader(headers: Headers, context: TraceContext): Headers {
  const links = (context.links ?? []).map(validLink).filter((link): link is SpanLink => link !== null).slice(0, 4);
  const value: TraceContext = {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(links.length ? { links } : {})
  };
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(value) };
}

/** Bounded identifier-only state for supervisors that continue while monitoring missions. */
export function missionContextsFromHeaders(headers: Headers): Array<[string, SpanContext]> {
  try {
    const payload = headers[MISSION_HEADER];
    const value: unknown = payload ? defaultPayloadConverter.fromPayload(payload) : null;
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_MISSION_CONTEXTS).filter((entry): entry is [string, SpanContext] =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" &&
      /^[A-Za-z0-9:._-]{1,200}$/.test(entry[0]) && validContext(entry[1]));
  } catch { return []; }
}

export function withMissionContextsHeader(headers: Headers, contexts: Map<string, SpanContext>): Headers {
  return { ...headers, [MISSION_HEADER]: defaultPayloadConverter.toPayload([...contexts].slice(-MAX_MISSION_CONTEXTS)) };
}

/** Distinct stable span IDs for bounded workflow operations within a run. */
export function operationSpanId(runId: string, operation: string): string {
  return deterministicHex("operation:" + runId + ":" + operation, 16);
}

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

export function inputTraceContext(args: readonly unknown[]): SpanContext | null {
  function visit(value: unknown, depth: number): SpanContext | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const context = contextFromTraceparent(record.traceparent);
    if (context) return context;
    if (depth > 0) {
      for (const key of nestedKeys) {
        const nested = visit(record[key], depth - 1);
        if (nested) return nested;
      }
    }
    return null;
  }
  for (const arg of args) {
    const context = visit(arg, 2);
    if (context) return context;
  }
  return null;
}

function fnv32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function deterministicHex(value: string, length: 16 | 32): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const parts: string[] = [];
  const count = length === 32 ? 4 : 2;
  for (let index = 0; index < count; index += 1) {
    let word = fnv32(value + "#" + index, seeds[index]!);
    if (word === 0) word = index + 1;
    parts.push(word.toString(16).padStart(8, "0"));
  }
  return parts.join("");
}

/** Temporal run IDs are UUIDs; the hash fallback keeps test and imported IDs valid. */
export function runSpanId(runId: string): string {
  const compact = runId.replace(/-/g, "").toLowerCase();
  return uuidPattern.test(runId) && spanPattern.test(compact.slice(-16))
    ? compact.slice(-16)
    : deterministicHex("span:" + runId, 16);
}

export function runTraceId(runId: string): string {
  const compact = runId.replace(/-/g, "").toLowerCase();
  return uuidPattern.test(runId) && tracePattern.test(compact)
    ? compact
    : deterministicHex("trace:" + runId, 32);
}

export function isBackgroundContinuation(args: readonly unknown[]): boolean {
  function visit(value: unknown, depth: number): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.roomAgentContinuation && typeof record.roomAgentContinuation === "object") return true;
    if (depth <= 0) return false;
    return nestedKeys.some(key => visit(record[key], depth - 1));
  }
  return args.some(arg => visit(arg, 3));
}
