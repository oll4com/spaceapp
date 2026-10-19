import type { Headers, Sinks } from "@temporalio/workflow";
import { isSafeErrorCode } from "@space/contracts";

/** Pure trace data shared by the workflow sandbox and the activity host. */
export interface SpaceTraceLink {
  traceId: string;
  spanId: string;
}

export interface SpaceTraceContext extends SpaceTraceLink {
  flags: number;
  links?: readonly SpaceTraceLink[];
  /** Original API span, distinct from the current workflow span's parent. */
  requestParent?: SpaceTraceLink;
}

/** Sink arguments must be cloneable; nanoseconds cross the isolate as strings. */
export interface WorkflowTraceSpan extends SpaceTraceContext {
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Readonly<Record<string, string | number>>;
  error: boolean;
}

export interface SpaceTracingSinks extends Sinks {
  spaceTracing: {
    exportSpan(span: WorkflowTraceSpan): void;
  };
}

export const WORKFLOW_TRACE_CONTEXT_HEADER = "space-trace-context";
const encoding = "json/plain";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
const nestedKeys = ["turn", "item", "input", "turnInput", "bridge"] as const;
const maxLinks = 8;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Drop free text, paths and credentials instead of truncating them. */
export function safeTraceIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

const traceAttributeKeys = [
  "workflowId", "runId", "workflowType", "taskQueue", "traceId", "w3cTraceId", "parentTraceId",
  "roomId", "paneId", "missionId", "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId",
  "cliTaskId", "revisionId", "activityType", "activityId", "outcome", "status", "reasonCode", "category"
] as const;

/** Final privacy boundary shared by sandbox spans and the host sink. */
export function sanitizeTraceAttributes(value: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const key of traceAttributeKeys) {
    const identifier = safeTraceIdentifier(value[key]);
    if (!identifier || (key === "reasonCode" && !isSafeErrorCode(identifier))) continue;
    if (key === "w3cTraceId" && (!traceIdPattern.test(identifier) || /^0+$/.test(identifier))) continue;
    attributes[key] = identifier;
  }
  for (const key of ["attempt", "durationMs"] as const) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0) continue;
    if (key === "attempt" && !Number.isSafeInteger(number)) continue;
    attributes[key] = number;
  }
  return attributes;
}

export function readTraceLink(value: unknown): SpaceTraceLink | null {
  const record = asRecord(value);
  if (!record || typeof record.traceId !== "string" || typeof record.spanId !== "string") return null;
  if (!traceIdPattern.test(record.traceId) || /^0+$/.test(record.traceId)
    || !spanIdPattern.test(record.spanId) || /^0+$/.test(record.spanId)) return null;
  return { traceId: record.traceId, spanId: record.spanId };
}

/** Bounded, de-duplicated identifier pairs. No other object fields survive. */
export function mergeTraceLinks(...groups: readonly (readonly unknown[] | undefined)[]): SpaceTraceLink[] {
  const links: SpaceTraceLink[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const value of group) {
      const link = readTraceLink(value);
      if (!link || links.some(existing => existing.traceId === link.traceId && existing.spanId === link.spanId)) continue;
      links.push(link);
      if (links.length === maxLinks) return links;
    }
  }
  return links;
}

function readTraceContext(value: unknown): SpaceTraceContext | null {
  const link = readTraceLink(value);
  const record = asRecord(value);
  if (!link || !record || typeof record.flags !== "number"
    || !Number.isInteger(record.flags) || record.flags < 0 || record.flags > 255) return null;
  const links = mergeTraceLinks(Array.isArray(record.links) ? record.links : undefined);
  const requestParent = readTraceLink(record.requestParent);
  return { ...link, flags: record.flags, ...(links.length ? { links } : {}), ...(requestParent ? { requestParent } : {}) };
}

/** W3C context only: Space's application `traceId` is never a W3C trace id. */
export function traceContextFromTraceparent(value: unknown): SpaceTraceContext | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const normalized = value.trim();
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/.exec(normalized);
  if (!match || match[1] === "ff" || (match[1] === "00" && normalized.length !== 55)) return null;
  return readTraceContext({ traceId: match[2], spanId: match[3], flags: Number.parseInt(match[4]!, 16) });
}

/** The standard Temporal JSON payload, built without Node APIs or a converter. */
export function encodeTraceContextHeader(context: SpaceTraceContext): Headers[string] {
  // Reconstruct the allowlisted shape so incidental fields cannot enter history.
  const safe = readTraceContext(context);
  if (!safe) throw new TypeError("Invalid workflow trace context.");
  return { metadata: { encoding: encoder.encode(encoding) }, data: encoder.encode(JSON.stringify(safe)) };
}

/** Invalid or oversized external context is ignored; it must never fail work. */
export function readTraceContextHeaders(headers: Headers | undefined | null): SpaceTraceContext | null {
  const payload = headers?.[WORKFLOW_TRACE_CONTEXT_HEADER];
  if (!payload?.data || payload.data.byteLength > 4096) return null;
  try {
    if (!payload.metadata?.encoding || decoder.decode(payload.metadata.encoding) !== encoding) return null;
    return readTraceContext(JSON.parse(decoder.decode(payload.data)));
  } catch {
    return null;
  }
}

function visitArguments(args: readonly unknown[], visit: (record: Record<string, unknown>) => void): void {
  const read = (value: unknown, depth: number): void => {
    const record = asRecord(value);
    if (!record) return;
    visit(record);
    if (depth === 0) return;
    for (const key of nestedKeys) read(record[key], depth - 1);
  };
  for (const arg of args) read(arg, 2);
}

export function traceLinksFromArgs(args: readonly unknown[]): SpaceTraceLink[] {
  const links: unknown[] = [];
  visitArguments(args, record => { if (record.traceLink !== undefined) links.push(record.traceLink); });
  return mergeTraceLinks(links);
}

/** Reads only explicit traceparent/traceLink fields in known input wrappers. */
export function traceContextFromArgs(args: readonly unknown[]): SpaceTraceContext | null {
  let context: SpaceTraceContext | null = null;
  visitArguments(args, record => { context ??= traceContextFromTraceparent(record.traceparent); });
  if (!context) return null;
  const links = traceLinksFromArgs(args);
  return { ...(context as SpaceTraceContext), ...(links.length ? { links } : {}) };
}

export function traceContextFromMemo(memo: Record<string, unknown> | undefined): SpaceTraceContext | null {
  return traceContextFromTraceparent(memo?.traceparent);
}

/** Identifiers only; never inspect arbitrary metadata, prompts or results. */
export function traceCorrelationAttributes(args: readonly unknown[], memo?: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  const keys = ["traceId", "roomId", "paneId", "missionId", "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"] as const;
  let requestId: string | null = null;
  visitArguments(args, record => {
    for (const key of keys) {
      const value = safeTraceIdentifier(record[key]);
      if (value && attributes[key] === undefined) attributes[key] = value;
    }
    const missionId = safeTraceIdentifier(record.roomAgentMissionId);
    if (missionId && attributes.missionId === undefined) attributes.missionId = missionId;
    requestId ??= safeTraceIdentifier(record.requestId);
  });
  for (const [key, value] of [["traceId", memo?.spaceTraceId], ["missionId", memo?.missionId]]) {
    const identifier = safeTraceIdentifier(value);
    if (identifier && attributes[key as string] === undefined) attributes[key as string] = identifier;
  }
  // Compare against the effective trace id, including any value from the memo.
  // A trace cannot be its own parent; retain an earlier distinct parent if available.
  const memoParent = safeTraceIdentifier(memo?.parentSpaceTraceId);
  const parent = requestId && requestId !== attributes.traceId
    ? requestId : memoParent && memoParent !== attributes.traceId ? memoParent : null;
  if (parent) attributes.parentTraceId = parent;
  return attributes;
}

function deterministicId(value: string): string {
  // FNV-1a is used only for stable telemetry identifiers, never for security.
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return (hash === 0n ? 1n : hash).toString(16).padStart(16, "0");
}

/** Do not draw from workflow RNG: that would change historical uuid4 calls. */
export function workflowSpanId(runId: string): string {
  return deterministicId(`space.workflow.span:${runId}`);
}

/** A deterministic root trace for work without an incoming W3C context. */
export function workflowTraceId(runId: string): string {
  return deterministicId(`space.workflow.trace:0:${runId}`) + deterministicId(`space.workflow.trace:1:${runId}`);
}
