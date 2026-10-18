import { parseTraceparent, type ParsedTraceparent } from "@space/contracts";

/**
 * Shared span context for OTLP workflow-run spans. This module is pure and
 * deterministic on purpose: it is imported by the workflow interceptors that
 * run inside the Temporal sandbox, so it must never do I/O, read the clock or
 * use randomness.
 *
 * The workflow span id is derived from the Temporal run id, so a child
 * workflow's span can name its parent run's span as its parent, and a
 * continue-as-new run can link to the run it continues, without any extra
 * propagation beyond the traceparent the outbound interceptor stamps into
 * Temporal headers.
 */

/** Temporal header that carries the W3C traceparent between workflow and activities/children. */
export const TRACEPARENT_HEADER = "space-traceparent";

/** SPAN_KIND_INTERNAL for workflow and activity spans. */
export const SPAN_KIND_INTERNAL = 1;

export interface WorkflowSpanLinkPayload {
  traceId: string;
  spanId: string;
  attributes?: Record<string, string | number>;
}

/** Plain-data span handed from the sandbox to the worker process through a sink. */
export interface WorkflowSpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: WorkflowSpanLinkPayload[];
}

/** Sink contract implemented in the worker process (see otlp-span-sink.ts). */
export type OtlpSpanSinks = {
  otlp: {
    exportWorkflowSpan: (span: WorkflowSpanPayload) => void;
  };
};

function fnv1a64(value: string, seed: bigint): bigint {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function hex64(hash: bigint): string {
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic 16-hex span id for a Temporal run id. Never all zero. */
export function spanIdFromRunId(runId: string): string {
  const spanId = hex64(fnv1a64(`span:${runId}`, 0xcbf29ce484222325n));
  return spanId === "0000000000000000" ? "0000000000000001" : spanId;
}

/**
 * Deterministic 32-hex trace id for runs that arrive without a propagated
 * traceparent (scheduler-started workflows, tests). Keeps the run's spans in
 * one trace whose id is stable across replay.
 */
export function traceIdFromRunId(runId: string): string {
  const traceId =
    hex64(fnv1a64(`trace:${runId}:a`, 0xcbf29ce484222325n)) +
    hex64(fnv1a64(`trace:${runId}:b`, 0x84222325cbf29ce4n));
  return traceId === "00000000000000000000000000000000" ? "00000000000000000000000000000001" : traceId;
}

/**
 * The exported attribute allowlist. Spans may carry identifiers, workflow and
 * activity types, attempt, outcome, stable error codes/categories and
 * durations only. Prompts, model output, file paths, URLs, error messages and
 * user text are never exported; anything not listed here is dropped.
 */
export const SPAN_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  "space.workflow_id",
  "space.run_id",
  "space.workflow_type",
  "space.activity_type",
  "space.activity_id",
  "space.attempt",
  "space.outcome",
  "space.reason_code",
  "space.category",
  "space.duration_ms",
  "space.queue_ms",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.turn_id",
  "space.action_id",
  "space.agent_run_id",
  "space.agent_session_id",
  "space.goal_id",
  "space.dot_id",
  "space.cli_task_id",
  "space.revision_id",
  "space.continuation.source_run_id",
  "space.continuation.generation",
  "space.link.type"
]);

const MAX_ATTRIBUTE_STRING_LENGTH = 256;

/** Allowlisted keys whose values are measurements; strings are dropped for these. */
const NUMERIC_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "space.attempt",
  "space.duration_ms",
  "space.queue_ms",
  "space.continuation.generation"
]);

/** Drops every attribute that is not allowlisted or not a plain string/finite number. */
export function sanitizeSpanAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SPAN_ATTRIBUTE_ALLOWLIST.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
    else if (typeof value === "string" && value.length > 0 && !NUMERIC_ATTRIBUTE_KEYS.has(key)) {
      sanitized[key] = value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
    }
  }
  return sanitized;
}

interface PayloadLike {
  metadata?: Record<string, Uint8Array>;
  data?: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encodes a traceparent string as a binary/plain Temporal header payload. */
export function traceparentHeaderPayload(traceparent: string): PayloadLike {
  return {
    metadata: { encoding: textEncoder.encode("binary/plain") },
    data: textEncoder.encode(traceparent)
  };
}

/** Reads the traceparent this module's outbound interceptor put into Temporal headers. */
export function traceparentFromHeaders(headers: Readonly<Record<string, unknown>> | undefined): string | null {
  const payload = headers?.[TRACEPARENT_HEADER] as PayloadLike | undefined;
  if (!payload?.data) return null;
  const encoding = payload.metadata?.encoding ? textDecoder.decode(payload.metadata.encoding) : "";
  if (encoding && encoding !== "binary/plain") return null;
  try {
    return textDecoder.decode(payload.data);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function traceparentValue(record: Record<string, unknown> | null): ParsedTraceparent | null {
  if (!record) return null;
  const raw = record.traceparent;
  return typeof raw === "string" ? parseTraceparent(raw) : null;
}

/**
 * Finds the traceparent the API placed into the workflow input (directly, on a
 * turn, or on a supervisor queue item's turn), mirroring how the API starters
 * pass it (apps/api/src/trace-context.ts).
 */
export function traceparentFromArgs(args: readonly unknown[]): ParsedTraceparent | null {
  for (const arg of args) {
    const record = asRecord(arg);
    const direct = traceparentValue(record);
    if (direct) return direct;
    const turn = traceparentValue(asRecord(record?.turn));
    if (turn) return turn;
    const itemTurn = traceparentValue(asRecord(asRecord(record?.item)?.turn));
    if (itemTurn) return itemTurn;
    const input = traceparentValue(asRecord(record?.input));
    if (input) return input;
  }
  return null;
}

/** Finds the traceparent the API placed into the workflow memo. */
export function traceparentFromMemo(memo: Readonly<Record<string, unknown>> | undefined): ParsedTraceparent | null {
  if (!memo) return null;
  const raw = memo.traceparent;
  return typeof raw === "string" ? parseTraceparent(raw) : null;
}

export interface BackgroundContinuation {
  sourceRunId: string;
  generation: number | null;
  /** The `trace:bg-<id>` trace id the continuation turn was given, when present. */
  backgroundTraceId: string | null;
}

function continuationValue(record: Record<string, unknown> | null): BackgroundContinuation | null {
  const continuation = asRecord(record?.roomAgentContinuation);
  if (!continuation || typeof continuation.sourceRunId !== "string" || !continuation.sourceRunId) return null;
  const traceId = typeof record?.traceId === "string" && record.traceId.startsWith("trace:bg-") ? record.traceId : null;
  return {
    sourceRunId: continuation.sourceRunId,
    generation: typeof continuation.generation === "number" ? continuation.generation : null,
    backgroundTraceId: traceId
  };
}

/**
 * Detects a background continuation turn (see room-background-continuation.ts):
 * the new turn carries `roomAgentContinuation.sourceRunId` and a fresh
 * `trace:bg-<id>` trace id instead of continuing the source trace.
 */
export function backgroundContinuationFromArgs(args: readonly unknown[]): BackgroundContinuation | null {
  for (const arg of args) {
    const record = asRecord(arg);
    const direct = continuationValue(record);
    if (direct) return direct;
    const turn = continuationValue(asRecord(record?.turn));
    if (turn) return turn;
    const itemTurn = continuationValue(asRecord(asRecord(record?.item)?.turn));
    if (itemTurn) return itemTurn;
  }
  return null;
}
