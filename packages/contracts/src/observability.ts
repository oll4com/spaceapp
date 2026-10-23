import { z } from "zod";

/**
 * Coarse, bounded failure categories shared by the API, the worker and their
 * metrics. Error codes stay specific (for example CODEX_APP_SERVER_TURN_TIMEOUT);
 * the category answers "what kind of failure was this" with a value that is
 * safe to use as a metric label and stable across adapters.
 */
export const failureCategorySchema = z.enum([
  "TIMEOUT",
  "TOOL_UNAVAILABLE",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "INVALID_INPUT",
  "CONFLICT",
  "RATE_LIMITED",
  "DISABLED",
  "CONFIGURATION",
  "STATE_UNAVAILABLE",
  "PROTOCOL_ERROR",
  "PROVIDER_ERROR",
  "UPSTREAM_UNAVAILABLE",
  "CANCELLED",
  "INTERNAL"
]);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

const exactCategories: Readonly<Record<string, FailureCategory>> = {
  TIMEOUT: "TIMEOUT",
  TOOL_UNAVAILABLE: "TOOL_UNAVAILABLE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PATH_UNSAFE: "PERMISSION_DENIED",
  UNAUTHORIZED: "PERMISSION_DENIED",
  FORBIDDEN: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "INVALID_INPUT",
  BAD_REQUEST: "INVALID_INPUT",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  SPACE_EXECUTION_STATE_UNAVAILABLE: "STATE_UNAVAILABLE",
  ROOM_AGENT_STOPPED: "CANCELLED",
  ROOM_AGENT_SUPERSEDED: "CANCELLED",
  INTERNAL_ERROR: "INTERNAL",
  SEARCH_FAILED: "INTERNAL",
  FILESYSTEM_ERROR: "INTERNAL"
};

// Ordered: the first matching rule wins. Codes are upper-case identifiers.
const categoryRules: ReadonlyArray<readonly [RegExp, FailureCategory]> = [
  [/TIMEOUT|TIMED_OUT|DEADLINE/, "TIMEOUT"],
  [/COMMAND_UNAVAILABLE|TOOL_UNAVAILABLE|NOT_INSTALLED|EXECUTABLE|SPAWN/, "TOOL_UNAVAILABLE"],
  [/PERMISSION|FORBIDDEN|UNAUTHORI[SZ]ED|DENIED|CSRF|AUTH_REQUIRED|NOT_ALLOWED/, "PERMISSION_DENIED"],
  [/RATE_LIMIT|TOO_MANY|QUOTA/, "RATE_LIMITED"],
  [/STOPPED|CANCEL|INTERRUPTED|SUPERSEDED|ABORTED/, "CANCELLED"],
  [/_DISABLED$|NOT_IMPLEMENTED|FEATURE_GATE/, "DISABLED"],
  [/CONFIG/, "CONFIGURATION"],
  [/STATE_UNAVAILABLE|STATE_MISSING/, "STATE_UNAVAILABLE"],
  [/PROTOCOL|INVALID_JSON|MALFORMED/, "PROTOCOL_ERROR"],
  [/NOT_FOUND$/, "NOT_FOUND"],
  [/CONFLICT|ALREADY_|STALE/, "CONFLICT"],
  [/^(VALIDATION|INVALID|BAD_REQUEST)|_INVALID$|_REQUIRED$|_TOO_LARGE$/, "INVALID_INPUT"],
  [/_UNAVAILABLE$|_EXITED$|UNREACHABLE|NOT_READY|NO_POLLERS/, "UPSTREAM_UNAVAILABLE"],
  [/PROVIDER|_RPC_|ROUTE|UPSTREAM|MODEL/, "PROVIDER_ERROR"]
];

const errorCodePattern = /^[A-Z][A-Z0-9_]{1,95}$/;

/** True for an upper-case identifier that may be used as an error-code label. */
export function isSafeErrorCode(code: unknown): code is string {
  return typeof code === "string" && errorCodePattern.test(code);
}

/** Maps any error code to its bounded category. Unknown codes are INTERNAL. */
export function categorizeFailureCode(code: string | null | undefined): FailureCategory {
  if (!isSafeErrorCode(code)) return "INTERNAL";
  const exact = exactCategories[code];
  if (exact) return exact;
  for (const [pattern, category] of categoryRules) {
    if (pattern.test(code)) return category;
  }
  return "INTERNAL";
}

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) version-00
 * `traceparent`: 00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>.
 */
export const traceparentSchema = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

export interface ParsedTraceparent {
  traceId: string;
  parentId: string;
  flags: string;
}

const traceparentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/**
 * Parses an inbound header. Returns null for anything that is not a valid
 * trace context: wrong shape, version ff, or an all-zero trace/parent id.
 * Future versions are accepted by their version-00 prefix, as the spec requires.
 */
export function parseTraceparent(value: unknown): ParsedTraceparent | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const match = traceparentPattern.exec(value.trim().toLowerCase());
  if (!match) return null;
  const [, version, traceId, parentId, flags] = match as unknown as [string, string, string, string, string];
  if (version === "ff") return null;
  if (version === "00" && value.trim().length !== 55) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, parentId, flags };
}

export function formatTraceparent(traceId: string, spanId: string, flags = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/** The trace id of a valid traceparent, otherwise null. */
export function traceIdFromTraceparent(value: unknown): string | null {
  return parseTraceparent(value)?.traceId ?? null;
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Pure, deterministic 16-hex W3C span id derived from a stable seed string.
 * Safe inside the Temporal workflow sandbox without advancing workflow PRNG.
 */
export function deterministicSpanId(seed: string): string {
  const high = fnv1a32(`span:hi:${seed}`, 0x811c9dc5);
  const low = fnv1a32(`span:lo:${seed}`, 0x9e3779b9) || 1;
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

/** Pure, deterministic 32-hex W3C trace id derived from a stable seed string. */
export function deterministicTraceId(seed: string): string {
  const p0 = fnv1a32(`trace:0:${seed}`, 0x811c9dc5);
  const p1 = fnv1a32(`trace:1:${seed}`, 0x9e3779b9);
  const p2 = fnv1a32(`trace:2:${seed}`, 0x85ebca6b);
  const p3 = fnv1a32(`trace:3:${seed}`, 0xc2b2ae35) || 1;
  return [p0, p1, p2, p3].map((part) => part.toString(16).padStart(8, "0")).join("");
}

/** Pure, deterministic W3C traceparent derived from a stable trace seed and span seed. */
export function deterministicTraceparent(traceSeed: string, spanSeed = traceSeed, flags = "01"): string {
  return formatTraceparent(deterministicTraceId(traceSeed), deterministicSpanId(spanSeed), flags);
}


/**
 * Admin trace lookup (GET /api/admin/traces/:traceId). Identifiers, codes,
 * statuses and timestamps only: event messages, payload metadata, prompts and
 * audit metadata are deliberately not part of this contract.
 */
export const traceLookupIdSchema = z.string().regex(/^[A-Za-z0-9:._-]{8,128}$/);

const traceIdentifierSchema = z.string().min(1).max(240).nullable();

export const traceLookupResponseSchema = z.object({
  traceId: traceLookupIdSchema,
  causalError: z.object({
    code: z.string().min(1).max(96),
    category: failureCategorySchema,
    source: z.string().min(1).max(64),
    eventId: z.string().min(1).max(240),
    workflowId: traceIdentifierSchema,
    at: z.string().min(1).max(64)
  }).nullable(),
  events: z.array(z.object({
    id: z.string().min(1).max(240),
    type: z.string().min(1).max(80),
    createdAt: z.string().min(1).max(64),
    roomId: traceIdentifierSchema,
    paneId: traceIdentifierSchema,
    turnId: traceIdentifierSchema,
    workflowId: traceIdentifierSchema,
    runId: traceIdentifierSchema,
    status: z.string().max(40).nullable(),
    reasonCode: z.string().max(96).nullable(),
    category: failureCategorySchema.nullable()
  })).max(500),
  auditEvents: z.array(z.object({
    id: z.string().min(1).max(240),
    action: z.string().min(1).max(160),
    createdAt: z.string().min(1).max(64),
    targetType: z.string().max(80).nullable(),
    targetId: traceIdentifierSchema,
    parentTraceId: traceIdentifierSchema
  })).max(500),
  workflows: z.array(z.object({
    workflowId: z.string().min(1).max(240),
    runId: traceIdentifierSchema,
    type: z.string().min(1).max(80),
    status: z.string().min(1).max(40),
    startedAt: z.string().min(1).max(64),
    closedAt: z.string().max(64).nullable()
  })).max(500),
  // Space-native agent runs of the trace's workflows (status and error code; never messages).
  agentRuns: z.array(z.object({
    runId: z.string().min(1).max(240),
    workflowId: z.string().min(1).max(240),
    status: z.string().min(1).max(40),
    errorCode: z.string().max(96).nullable(),
    category: failureCategorySchema.nullable(),
    createdAt: z.string().min(1).max(64),
    completedAt: z.string().max(64).nullable(),
    // A background continuation keeps its own trace; it is found through the run it continues.
    continuationOf: traceIdentifierSchema.default(null)
  })).max(500).default([]),
  // Room Agent missions and task runs created under this trace (ids, status and error code; never instructions).
  roomAgentMissions: z.array(z.object({
    missionId: z.string().min(1).max(240),
    roomId: z.string().min(1).max(240),
    status: z.string().min(1).max(40),
    errorCode: z.string().max(96).nullable(),
    queuedAt: z.string().min(1).max(64),
    completedAt: z.string().max(64).nullable()
  })).max(500).default([]),
  roomAgentTaskRuns: z.array(z.object({
    runId: z.string().min(1).max(240),
    missionId: z.string().min(1).max(240),
    roomId: z.string().min(1).max(240),
    status: z.string().min(1).max(40),
    errorCode: z.string().max(96).nullable(),
    queuedAt: z.string().min(1).max(64),
    completedAt: z.string().max(64).nullable()
  })).max(500).default([]),
  logQueries: z.object({ api: z.string(), worker: z.string() })
});
export type TraceLookupResponse = z.infer<typeof traceLookupResponseSchema>;
