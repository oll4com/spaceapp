import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { parseTraceparent } from "@space/contracts";

// This module is shared by the workflow sandbox and activity workers. No Node
// imports, I/O, wall clock or random-number consumption are permitted here.
export const TRACE_HEADER = "space-tracing-v1";
export interface TraceLink { traceId: string; spanId: string }
export interface TraceCarrier {
  traceparent: string;
  spaceTraceId?: string;
  link?: TraceLink;
  missions?: Record<string, ArgumentTrace>;
}
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedMs: number;
  endedMs: number;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: TraceLink[];
}
export interface TraceSinks {
  [name: string]: { [fn: string]: (...args: any[]) => void };
  spaceTracing: { completed(record: WorkflowSpanRecord): void };
}

export function traceIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value) ? value : undefined;
}

/** Stable correlation identifiers, not cryptographic hashes. Does not alter workflow PRNG state. */
export function spanIdFor(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
  return (hash || 1n).toString(16).padStart(16, "0");
}
export function traceIdForRun(runId: string): string {
  const uuid = runId.replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(uuid) && !/^0+$/.test(uuid) ? uuid : spanIdFor(`trace:${runId}`) + spanIdFor(`trace2:${runId}`);
}
export const workflowSpanId = (runId: string) => spanIdFor(`workflow:${runId}`);

export function readCarrier(headers: Headers): TraceCarrier | null {
  try {
    const payload = headers[TRACE_HEADER];
    if (!payload || (payload.data?.length ?? 0) > 65_536) return null;
    const value = defaultPayloadConverter.fromPayload(payload) as Partial<TraceCarrier> | null;
    const parsed = parseTraceparent(value?.traceparent);
    if (!parsed) return null;
    const link = value?.link;
    const missions: Record<string, ArgumentTrace> = {};
    if (value?.missions && typeof value.missions === "object") for (const [id, context] of Object.entries(value.missions).slice(0, 100)) {
      if (traceIdentifier(id) && parseTraceparent(context?.traceparent)) missions[id] = argumentTrace([context]);
    }
    return { traceparent: `00-${parsed.traceId}-${parsed.parentId}-${parsed.flags}`, missions,
      ...(traceIdentifier(value?.spaceTraceId) ? { spaceTraceId: value!.spaceTraceId } : {}),
      ...(link && /^[0-9a-f]{32}$/.test(link.traceId) && /^[0-9a-f]{16}$/.test(link.spanId) ? { link: { traceId: link.traceId, spanId: link.spanId } } : {}) };
  } catch { return null; }
}
export function withCarrier(headers: Headers, carrier: TraceCarrier): Headers {
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(carrier)! };
}

export interface ArgumentTrace { traceparent?: string; traceId?: string; sourceTraceparent?: string; background?: boolean }
/** Read named correlation fields only, never serialize arbitrary workflow inputs. */
export function argumentTrace(args: readonly unknown[]): ArgumentTrace {
  const result: ArgumentTrace = {};
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const r = value as Record<string, unknown>;
    if (r.roomAgentContinuation || r.background === true) result.background = true;
    if (!result.traceparent && parseTraceparent(r.traceparent)) result.traceparent = r.traceparent as string;
    if (!result.traceId && traceIdentifier(r.traceId)) result.traceId = r.traceId as string;
    if (!result.sourceTraceparent && parseTraceparent(r.sourceTraceparent)) result.sourceTraceparent = r.sourceTraceparent as string;
    if (depth) for (const key of ["turn", "item", "input", "turnInput", "roomAgentContinuation"]) visit(r[key], depth - 1);
  };
  for (const arg of args) visit(arg, 3);
  return result;
}

const stringKeys = new Set([
  "space.trace_id", "space.workflow_id", "space.run_id", "space.workflow_type",
  "space.activity_id", "space.activity_type", "space.room_id", "space.pane_id", "space.mission_id",
  "space.outcome", "space.reason_code", "space.category"
]);
const numericKeys = new Set(["space.attempt", "space.duration_ms", "space.queue_ms"]);
export function safeWorkerAttributes(values: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (stringKeys.has(key) && traceIdentifier(value)) result[key] = value as string;
    if (numericKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}
