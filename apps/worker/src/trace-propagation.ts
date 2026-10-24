import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { parseTraceparent } from "@space/contracts";

export const TRACE_HEADER = "space-trace-context";
export interface SpanLink { traceId: string; spanId: string }
export interface TraceEnvelope { traceparent?: string; links?: SpanLink[]; newTrace?: boolean }
const id = /^[A-Za-z0-9:._-]{1,200}$/;
const allowed = new Set([
  "space.workflow_type", "space.workflow_id", "space.temporal_run_id",
  "space.activity_type", "space.activity_id", "space.attempt", "space.outcome",
  "space.reason_code", "space.category", "space.duration_ms", "space.room_id",
  "space.pane_id", "space.mission_id", "space.trace_id"
]);

/** One allowlist at both the workflow/host boundary and activity export boundary. */
export function traceAttributes(values: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.has(key) &&
    (typeof value === "string" ? id.test(value) : typeof value === "number" && Number.isFinite(value) && value >= 0))) as Record<string, string | number>;
}

export function traceContextFromArgs(args: readonly unknown[]): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (parseTraceparent(record.traceparent)) return record.traceparent as string;
    if (depth <= 0) return null;
    for (const key of ["turn", "item", "bridge", "input", "turnInput"]) {
      const found = visit(record[key], depth - 1);
      if (found) return found;
    }
    return null;
  };
  for (const arg of args) { const found = visit(arg, 3); if (found) return found; }
  return null;
}

export function validLinks(value: unknown): SpanLink[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).filter((link): link is SpanLink => Boolean(link &&
    typeof link === "object" && /^[0-9a-f]{32}$/.test(link.traceId) && !/^0+$/.test(link.traceId) &&
    /^[0-9a-f]{16}$/.test(link.spanId) && !/^0+$/.test(link.spanId)))
    .map(({ traceId, spanId }) => ({ traceId, spanId }));
}

export function readTraceEnvelope(headers: Headers): TraceEnvelope {
  try {
    const payload = headers[TRACE_HEADER];
    const value = payload ? defaultPayloadConverter.fromPayload(payload) as TraceEnvelope : {};
    return { ...(parseTraceparent(value.traceparent) ? { traceparent: value.traceparent } : {}),
      ...(value.newTrace === true ? { newTrace: true } : {}), links: validLinks(value.links) };
  } catch { return {}; }
}

export function traceHeaders(headers: Headers, context: TraceEnvelope): Headers {
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(context)! };
}

export interface WorkflowTraceSpan {
  traceId: string; spanId: string; parentSpanId: string | null;
  workflowType: string; startTimeMs: number; endTimeMs: number;
  attributes: Record<string, string | number>; links: SpanLink[]; error: boolean;
}
