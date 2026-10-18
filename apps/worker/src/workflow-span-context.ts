/**
 * Pure helpers for workflow span context: deterministic span ids, the Temporal
 * header payload that parents activities and child workflows to the workflow
 * span, and the attribute allowlist for exported spans.
 *
 * Importable from inside the deterministic workflow sandbox (no node: imports,
 * no I/O) and from worker code and tests alike.
 */

import { parseTraceparent, type ParsedTraceparent } from "@space/contracts";

/** Temporal header that carries the workflow run's span context to activities and child workflows. */
export const SPAN_CONTEXT_HEADER = "space.span-context";

/** The span context of the workflow run that scheduled the call. */
export interface WorkflowSpanContextHeader {
  traceId: string;
  spanId: string;
  /** parent: the caller's span becomes a child of this span; link: the caller links to it (continue-as-new). */
  kind: "parent" | "link";
}

/** An OTLP span link to the trace or run this workflow continues. */
export interface WorkflowSpanLink {
  traceId: string;
  spanId: string;
  attributes?: Readonly<Record<string, string | number>>;
}

export type WorkflowOutcome = "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED";

/** What the workflow sandbox emits through the workerSpans sink. Primitives only: the value is copied out of the sandbox. */
export interface WorkflowSpanEvent {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  workflowType: string;
  workflowId: string;
  runId: string;
  attempt: number;
  startedAtMs: number;
  endedAtMs: number;
  outcome: WorkflowOutcome;
  attributes: Record<string, string | number>;
  links: readonly WorkflowSpanLink[];
}

/** Sink shape shared by the sandbox (proxySinks) and the worker (InjectedSinks). */
export type WorkerSpanSinkDefinitions = {
  workerSpans: {
    workflowSpan: (event: WorkflowSpanEvent) => void;
  };
};

/** Attribute keys that may ever leave the worker. Anything else is dropped, in the sink and in tests. */
export const WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST = [
  "space.workflow_type",
  "space.activity_type",
  "space.outcome",
  "space.attempt",
  "space.reason_code",
  "space.category",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.goal_id",
  "space.dot_id",
  "space.space_trace_id",
  "space.continuation_generation"
] as const;

export type WorkflowSpanAttributeKey = (typeof WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST)[number];

const FNV1A_OFFSET = 0xcbf29ce484222325n;
const FNV1A_PRIME = 0x100000001b3n;

/** Deterministic FNV-1a 64-bit hash as 16 lowercase hex digits. */
export function fnv1a64Hex(value: string): string {
  let hash = FNV1A_OFFSET;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index) & 0xff);
    hash = BigInt.asUintN(64, hash * FNV1A_PRIME);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic span id for one workflow run; stable across replays of the same history. */
export function workflowSpanId(workflowId: string, runId: string): string {
  return fnv1a64Hex(workflowId + "|" + runId + "|span");
}

/** Deterministic 32-hex trace id for workflow runs that no traceparent parented. */
export function workflowTraceId(workflowId: string, runId: string): string {
  return fnv1a64Hex(workflowId + "|" + runId + "|trace-a") + fnv1a64Hex(workflowId + "|" + runId + "|trace-b");
}

// Identifier keys scanned from workflow input. Prompts, model output and other
// user text are never read, only these keys and only as short identifiers.
const idKeys = ["traceparent", "sourceTraceparent", "traceId", "roomId", "paneId", "missionId", "roomAgentMissionId", "goalId", "dotId"] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

export interface WorkflowSpanCorrelation {
  /** W3C trace context propagated in the workflow input, when present. */
  traceparent: ParsedTraceparent | null;
  /** W3C trace context of the run a background continuation continues. */
  sourceTraceparent: ParsedTraceparent | null;
  /** The internal Space trace id (not a W3C id) when the input carries one. */
  spaceTraceId: string | null;
  /** Allowlisted attributes only. */
  attributes: Record<string, string | number>;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,128}$/.test(value) ? value : null;
}

function readSpanCorrelation(value: unknown, found: Record<string, unknown>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth < 0) return;
  const record = value as Record<string, unknown>;
  for (const key of idKeys) {
    if (found[key] !== undefined) continue;
    const identifier = safeIdentifier(record[key]);
    if (identifier !== null) found[key] = identifier;
  }
  const continuation = record.roomAgentContinuation;
  if (continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
    const generation = (continuation as Record<string, unknown>).generation;
    if (Number.isInteger(generation) && (generation as number) >= 0 && (generation as number) <= 100) {
      found.continuationGeneration = generation;
    }
  }
  if (depth <= 0) return;
  for (const key of nestedKeys) readSpanCorrelation(record[key], found, depth - 1);
}

/** Allowlisted correlation (trace context and ids) from workflow input arguments. */
export function workflowSpanCorrelation(args: readonly unknown[]): WorkflowSpanCorrelation {
  const found: Record<string, unknown> = {};
  for (const arg of args) readSpanCorrelation(arg, found, 2);
  const attributes: Record<string, string | number> = {};
  const traceId = typeof found.traceId === "string" ? found.traceId : null;
  const roomId = typeof found.roomId === "string" ? found.roomId : null;
  const paneId = typeof found.paneId === "string" ? found.paneId : null;
  const missionId = typeof found.missionId === "string" ? found.missionId : (typeof found.roomAgentMissionId === "string" ? found.roomAgentMissionId : null);
  const goalId = typeof found.goalId === "string" ? found.goalId : null;
  const dotId = typeof found.dotId === "string" ? found.dotId : null;
  if (roomId) attributes["space.room_id"] = roomId;
  if (paneId) attributes["space.pane_id"] = paneId;
  if (missionId) attributes["space.mission_id"] = missionId;
  if (goalId) attributes["space.goal_id"] = goalId;
  if (dotId) attributes["space.dot_id"] = dotId;
  if (traceId) attributes["space.space_trace_id"] = traceId;
  if (typeof found.continuationGeneration === "number") attributes["space.continuation_generation"] = found.continuationGeneration;
  return {
    traceparent: parseTraceparent(found.traceparent ?? null),
    sourceTraceparent: parseTraceparent(found.sourceTraceparent ?? null),
    spaceTraceId: traceId,
    attributes
  };
}

/** Encode a span-context header as a default JSON payload (json/plain metadata, JSON data). */
export function encodeSpanContextHeader(header: WorkflowSpanContextHeader): { metadata: Record<string, Uint8Array>; data: Uint8Array } {
  const encoder = new TextEncoder();
  return {
    metadata: { encoding: encoder.encode("json/plain") },
    data: encoder.encode(JSON.stringify(header))
  };
}

const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

/** Decode a span-context header payload; null unless it is exactly the expected shape. */
export function decodeSpanContextHeader(payload: unknown): WorkflowSpanContextHeader | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as { data?: unknown };
  let text: string;
  try {
    const data = record.data;
    if (!data || typeof data !== "object" || typeof (data as Uint8Array).length !== "number" || (data as Uint8Array).length === 0) return null;
    text = new TextDecoder().decode(data as Uint8Array);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const traceId = parsed.traceId;
    const spanId = parsed.spanId;
    const kind = parsed.kind;
    if (typeof traceId !== "string" || !traceIdPattern.test(traceId)) return null;
    if (typeof spanId !== "string" || !spanIdPattern.test(spanId)) return null;
    if (kind !== "parent" && kind !== "link") return null;
    return { traceId, spanId, kind };
  } catch {
    return null;
  }
}
