/**
 * Strict allowlist and sanitization for OTLP span attributes.
 *
 * Security & privacy guarantee:
 * Prompts, chat messages, model output, file paths, URLs, raw error messages,
 * credentials, tokens, headers, and arbitrary object fields are never exported.
 * Only bounded, safe identifiers, types, outcomes, attempts, durations, and
 * stable reasonCode/category values pass this filter.
 *
 * Pure and deterministic: safe for both the Temporal workflow sandbox and worker host.
 */

export const ALLOWLISTED_ATTRIBUTE_KEYS = new Set<string>([
  // Service & OpenTelemetry standard keys
  "service.name",

  // Space correlation identifiers
  "space.trace_id",
  "space.w3c_trace_id",
  "space.parent_trace_id",
  "space.workflow_id",
  "space.run_id",
  "space.workflow_type",
  "space.activity_id",
  "space.activity_type",
  "space.attempt",
  "space.outcome",
  "space.reason_code",
  "space.category",
  "space.duration_ms",
  "space.queue_ms",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.agent_run_id",
  "space.agent_session_id",
  "space.action_id",
  "space.goal_id",
  "space.dot_id",
  "space.turn_id",
  "space.cli_task_id",
  "space.revision_id",
  "space.continued_from_run_id",
  "space.continuation_generation",
  "space.source_run_id",
  "link.reason",

  // Temporal execution metadata
  "temporal.workflow_type",
  "temporal.workflow_id",
  "temporal.run_id",
  "temporal.parent_workflow_id",
  "temporal.parent_run_id",
  "temporal.activity_type",
  "temporal.activity_id",
  "temporal.attempt",

  // HTTP server span attributes (API compatibility)
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "space.request_id"
]);

/**
 * Safe identifier / code pattern:
 * - No whitespace, newlines, or control characters
 * - No slashes or backslashes (prevents file paths and URLs)
 * - Bounded length (1..200 chars)
 */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * Rejects strings that look like file paths, URLs, or free-form user/error text.
 */
export function isSafeAttributeString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 200) return false;
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("http:") ||
    value.includes("https:") ||
    value.includes("ws:") ||
    value.includes("wss:") ||
    value.includes("file:") ||
    value.includes("\n") ||
    value.includes("\r") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return SAFE_IDENTIFIER_PATTERN.test(value);
}

/**
 * Filters an arbitrary attribute map down to allowlisted keys with validated
 * primitive values. Strips any non-allowlisted key, file path, URL, or free-form text.
 */
export function allowlistSpanAttributes(
  raw: Readonly<Record<string, unknown>>
): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWLISTED_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value) && value >= 0) {
        sanitized[key] = value;
      }
      continue;
    }
    if (typeof value === "string") {
      if (key === "http.route") {
        if (
          value.length > 0 &&
          value.length <= 240 &&
          !value.includes("?") &&
          !value.includes("#") &&
          !value.includes("://") &&
          !/\s/.test(value)
        ) {
          sanitized[key] = value;
        }
        continue;
      }
      if (isSafeAttributeString(value)) {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

/**
 * Deterministically derives a valid 16-hex-character OTLP spanId from a Temporal
 * runId (or arbitrary identifier string). Safe to call both inside and outside
 * the Temporal workflow sandbox without consuming PRNG state.
 */
export function runIdToSpanId(runId: string): string {
  const hexOnly = runId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hexOnly.length >= 16) {
    const candidate = hexOnly.slice(0, 16);
    if (!/^0+$/.test(candidate)) return candidate;
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < runId.length; i++) {
    const ch = runId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
  return /^0+$/.test(combined) ? "0000000000000001" : combined;
}

const CORRELATION_ARG_KEYS = [
  "traceId",
  "traceparent",
  "requestId",
  "roomId",
  "paneId",
  "missionId",
  "roomAgentMissionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId",
  "sourceRunId",
  "sourceTraceId",
  "sourceTraceparent"
] as const;

const NESTED_CONTAINER_KEYS = [
  "turn",
  "item",
  "bridge",
  "input",
  "turnInput",
  "roomAgentContinuation"
] as const;

export type ExtractedCorrelationKey = (typeof CORRELATION_ARG_KEYS)[number] | "generation";

/**
 * Pure, sandbox-safe extraction of allowlisted correlation identifiers from
 * workflow or activity arguments. Never reads prompts, content, or messages.
 */
export function extractCorrelationFromArgs(
  args: readonly unknown[],
  maxDepth = 3
): Partial<Record<ExtractedCorrelationKey, string | number>> {
  const into: Partial<Record<ExtractedCorrelationKey, string | number>> = {};

  function visit(value: unknown, depth: number): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of CORRELATION_ARG_KEYS) {
      if (into[key] !== undefined) continue;
      const val = record[key];
      if (isSafeAttributeString(val)) {
        into[key] = val;
      }
    }
    if (into.generation === undefined && typeof record.generation === "number" && Number.isInteger(record.generation) && record.generation > 0) {
      into.generation = record.generation;
    }
    if (depth <= 0) return;
    for (const nestedKey of NESTED_CONTAINER_KEYS) {
      if (record[nestedKey] !== undefined) {
        visit(record[nestedKey], depth - 1);
      }
    }
  }

  for (const arg of args) {
    visit(arg, maxDepth);
  }
  return into;
}

export const OTLP_TRACE_HEADER = "x-space-otlp-trace";

export interface TraceCarrierHeader {
  traceparent: string;
  w3cTraceId?: string;
  spaceTraceId?: string;
  continuedFromSpanId?: string;
}

function encodeAsciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0x7f;
  }
  return bytes;
}

/**
 * Encodes trace context into a Temporal Header Payload using pure Uint8Array
 * (safe inside the Temporal V8 workflow sandbox with zero Node dependencies).
 */
export function encodeTraceCarrierHeader(carrier: TraceCarrierHeader): {
  metadata: Record<string, Uint8Array>;
  data: Uint8Array;
} {
  return {
    metadata: { encoding: encodeAsciiBytes("json/plain") },
    data: encodeAsciiBytes(JSON.stringify(carrier))
  };
}

/**
 * Decodes trace context from Temporal headers (`input.headers`).
 */
export function decodeTraceCarrierHeader(
  headers: Readonly<Record<string, { data?: Uint8Array | null } | undefined>> | undefined | null
): TraceCarrierHeader | null {
  if (!headers) return null;
  const payload = headers[OTLP_TRACE_HEADER];
  if (!payload?.data || payload.data.byteLength === 0 || payload.data.byteLength > 4096) return null;
  try {
    let json = "";
    for (let i = 0; i < payload.data.byteLength; i++) {
      json += String.fromCharCode(payload.data[i]!);
    }
    const parsed = JSON.parse(json) as Partial<TraceCarrierHeader> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.traceparent !== "string" || !isSafeAttributeString(parsed.traceparent)) {
      return null;
    }
    return {
      traceparent: parsed.traceparent,
      ...(isSafeAttributeString(parsed.w3cTraceId) ? { w3cTraceId: parsed.w3cTraceId } : {}),
      ...(isSafeAttributeString(parsed.spaceTraceId) ? { spaceTraceId: parsed.spaceTraceId } : {}),
      ...(isSafeAttributeString(parsed.continuedFromSpanId) ? { continuedFromSpanId: parsed.continuedFromSpanId } : {})
    };
  } catch {
    return null;
  }
}
