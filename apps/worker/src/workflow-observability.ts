import {
  defaultPayloadConverter,
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInterceptors,
  type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, isSafeErrorCode, parseTraceparent } from "@space/contracts";

/**
 * OTLP span export for Temporal workflows. This module is bundled into the
 * workflow isolate (via `interceptors.workflowModules`), so it must stay
 * deterministic-safe: imports only from `@temporalio/workflow` and
 * `@space/contracts`. No I/O happens here — spans leave the sandbox through
 * the `workflowTelemetry` sink, which the worker registers with
 * `callDuringReplay: false`, so replay emits no duplicate spans.
 *
 * Span tree: each workflow execution gets one span. Its span id is derived
 * deterministically from the Temporal run id, so a continue-as-new run or a
 * background continuation can link to the run it continues without any extra
 * state passing. Activities become children of the workflow span via the
 * `traceparent` header injected on each activity/child-workflow invocation.
 */

/** Sinks for exporting workflow span data out of the isolate. Args are JSON strings (postMessage-safe). */
export interface WorkflowTelemetrySinks extends Sinks {
  workflowTelemetry: {
    workflowStarted(payloadJson: string): void;
    workflowCompleted(payloadJson: string): void;
  };
}

/** Header carrying the W3C traceparent for downstream spans. */
export const TRACEPARENT_HEADER = "traceparent";
/** Header carrying the traceparent of the run this run continues (for OTLP span links). */
export const CONTINUED_FROM_HEADER = "x-space-continued-from";

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;

function identifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

/**
 * Deterministic workflow span id from the Temporal run id. Run ids are UUIDs;
 * the first 16 hex characters give a valid, unique-per-run span id without
 * any randomness, so continued runs can recompute their predecessor's span id.
 */
export function workflowSpanIdForRun(runId: string): string {
  const hex = runId.toLowerCase().replace(/[^0-9a-f]/g, "");
  const id = (hex + "0".repeat(16)).slice(0, 16);
  return /^0+$/.test(id) ? "f".repeat(16) : id;
}

/** Allowlisted workflow span attribute keys. Ids, type, status and codes only. */
const WORKFLOW_ATTRIBUTE_KEYS = new Set([
  "space.trace_id",
  "space.workflow_type",
  "space.workflow_id",
  "space.run_id",
  "space.room_id",
  "space.pane_id",
  "space.mission_id",
  "space.status",
  "space.error_code",
  "space.error_category"
]);

/** Allowlisted activity span attribute keys. */
const ACTIVITY_ATTRIBUTE_KEYS = new Set([
  "space.activity_type",
  "space.outcome",
  "space.attempt",
  "space.reason_code",
  "space.category",
  "space.workflow_type",
  "space.run_id"
]);

/**
 * Allowlist gate for span attributes. Prompts, model output, file paths,
 * URLs, error messages and any user text never become attributes: keys must
 * be allowlisted and values must be identifiers or integers.
 */
export function isAllowedSpanAttribute(kind: "workflow" | "activity", key: string, value: string | number): boolean {
  const keys = kind === "workflow" ? WORKFLOW_ATTRIBUTE_KEYS : ACTIVITY_ATTRIBUTE_KEYS;
  if (!keys.has(key)) return false;
  if (typeof value === "number") return Number.isInteger(value);
  return identifierPattern.test(value);
}

/** Build an allowlisted attribute record from candidate entries. */
export function allowlistedAttributes(
  kind: "workflow" | "activity",
  entries: ReadonlyArray<readonly [string, string | number | null | undefined]>
): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (isAllowedSpanAttribute(kind, key, value)) attributes[key] = value;
  }
  return attributes;
}

function readTraceparentHeader(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const payload = headers[TRACEPARENT_HEADER];
  if (!payload || typeof payload !== "object") return null;
  try {
    const value = defaultPayloadConverter.fromPayload(payload as never);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function writeTraceparentHeader(headers: Record<string, unknown>, traceparent: string): void {
  try {
    headers[TRACEPARENT_HEADER] = defaultPayloadConverter.toPayload(traceparent);
  } catch {
    // Header injection is best effort; never break the invocation.
  }
}

/** Shallow, safe read of the traceparent contract field from workflow input args. */
function traceparentFromArgs(args: readonly unknown[]): string | null {
  const first = args[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const traceparent = (first as Record<string, unknown>).traceparent;
  return typeof traceparent === "string" ? traceparent : null;
}

/** Shallow, allowlisted id read from workflow input args (never deep-spreads). */
function workflowInputIds(args: readonly unknown[]): { traceId: string | null; roomId: string | null; paneId: string | null; missionId: string | null; sourceRunId: string | null } {
  const first = args[0];
  const ids = { traceId: null as string | null, roomId: null as string | null, paneId: null as string | null, missionId: null as string | null, sourceRunId: null as string | null };
  if (!first || typeof first !== "object" || Array.isArray(first)) return ids;
  const record = first as Record<string, unknown>;
  ids.traceId = identifier(record.traceId);
  ids.roomId = identifier(record.roomId);
  ids.paneId = identifier(record.paneId);
  ids.missionId = identifier(record.missionId ?? record.roomAgentMissionId);
  const continuation = record.roomAgentContinuation;
  if (continuation && typeof continuation === "object" && !Array.isArray(continuation)) {
    const sourceRunId = (continuation as Record<string, unknown>).sourceRunId;
    ids.sourceRunId = typeof sourceRunId === "string" ? sourceRunId : null;
  }
  return ids;
}

function continuedFromHeader(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const payload = headers[CONTINUED_FROM_HEADER];
  if (!payload || typeof payload !== "object") return null;
  try {
    const value = defaultPayloadConverter.fromPayload(payload as never);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function safeErrorCode(error: unknown): string {
  const record = error as { code?: unknown; type?: unknown; name?: unknown } | null;
  if (record && isSafeErrorCode(record.code)) return record.code as string;
  if (record && isSafeErrorCode(record.type)) return record.type as string;
  const name = typeof record?.name === "string" ? record.name : "";
  if (/Cancel/i.test(name)) return "WORKFLOW_CANCELLED";
  return "WORKFLOW_ERROR";
}

interface PerExecutionState {
  traceId: string | null;
  workflowSpanId: string | null;
}

/**
 * Workflow interceptor factory for OTLP span export. Registered via
 * `interceptors.workflowModules`; the factory runs once per workflow execution
 * inside the isolate, so the closure holds per-execution trace state shared by
 * the inbound and outbound interceptors.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  const state: PerExecutionState = { traceId: null, workflowSpanId: null };
  const { workflowTelemetry } = proxySinks<WorkflowTelemetrySinks>();

  const childTraceparent = (): string | null => {
    if (!state.traceId || !state.workflowSpanId) return null;
    return formatTraceparent(state.traceId, state.workflowSpanId, "01");
  };

  const interceptors: WorkflowInterceptors = {
    inbound: [
      {
        async execute(input, next) {
          const info = workflowInfo();
          const headerTraceparent = readTraceparentHeader(input.headers as Record<string, unknown>);
          const parsed = parseTraceparent(headerTraceparent ?? traceparentFromArgs(input.args));
          if (!parsed) {
            // No trace context: run normally, export nothing. Activities keep
            // their existing args-based behavior.
            return next(input);
          }
          const spanId = workflowSpanIdForRun(info.runId);
          const ids = workflowInputIds(input.args);
          const links: Array<{ traceId: string; spanId: string }> = [];
          const continuedFrom = parseTraceparent(continuedFromHeader(input.headers as Record<string, unknown>));
          if (continuedFrom) links.push({ traceId: continuedFrom.traceId, spanId: continuedFrom.parentId });
          if (ids.sourceRunId) {
            links.push({ traceId: parsed.traceId, spanId: workflowSpanIdForRun(ids.sourceRunId) });
          }
          const attributes = allowlistedAttributes("workflow", [
            ["space.trace_id", ids.traceId],
            ["space.workflow_type", identifier(info.workflowType)],
            ["space.workflow_id", identifier(info.workflowId)],
            ["space.run_id", identifier(info.runId)],
            ["space.room_id", ids.roomId],
            ["space.pane_id", ids.paneId],
            ["space.mission_id", ids.missionId]
          ]);
          try {
            workflowTelemetry.workflowStarted(JSON.stringify({
              traceId: parsed.traceId,
              spanId,
              parentSpanId: parsed.parentId,
              name: `workflow ${info.workflowType}`,
              attributes,
              links
            }));
          } catch {
            // Best effort; never break the workflow.
          }
          state.traceId = parsed.traceId;
          state.workflowSpanId = spanId;
          try {
            const result = await next(input);
            try {
              workflowTelemetry.workflowCompleted(JSON.stringify({ spanId, status: "COMPLETED" }));
            } catch {
              // Best effort.
            }
            return result;
          } catch (error) {
            const name = (error as { name?: unknown } | null)?.name;
            const status = typeof name === "string" && /Cancel/i.test(name) ? "CANCELLED" : "FAILED";
            try {
              workflowTelemetry.workflowCompleted(JSON.stringify({ spanId, status, errorCode: safeErrorCode(error) }));
            } catch {
              // Best effort.
            }
            throw error;
          }
        }
      }
    ],
    outbound: [
      {
        async scheduleActivity(input, next) {
          const traceparent = childTraceparent();
          if (traceparent) writeTraceparentHeader(input.headers as unknown as Record<string, unknown>, traceparent);
          return next(input);
        },
        async startChildWorkflowExecution(input, next) {
          const traceparent = childTraceparent();
          if (traceparent) writeTraceparentHeader(input.headers as unknown as Record<string, unknown>, traceparent);
          return next(input);
        },
        async continueAsNew(input, next) {
          const traceparent = childTraceparent();
          if (traceparent) {
            writeTraceparentHeader(input.headers as unknown as Record<string, unknown>, traceparent);
            try {
              (input.headers as unknown as Record<string, unknown>)[CONTINUED_FROM_HEADER] =
                defaultPayloadConverter.toPayload(traceparent);
            } catch {
              // Best effort.
            }
          }
          return next(input);
        }
      }
    ]
  };
  return interceptors;
};
