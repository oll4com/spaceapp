import { defaultPayloadConverter, type Headers } from "@temporalio/common";
import { parseTraceparent } from "@space/contracts";

// This module is safe inside the workflow sandbox: no I/O, random number
// generation, environment reads, or mutable process-global state.
export const TRACE_HEADER = "space-trace-context-v1";
export interface SpanLink { traceId: string; spanId: string }
export interface TemporalTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  links: SpanLink[];
}
export interface PropagatedTrace {
  traceparent: string;
  links?: SpanLink[];
}

const tracePattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const spanPattern = /^(?!0{16}$)[0-9a-f]{16}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export function traceIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && identifierPattern.test(value) ? value : undefined;
}

export function validLink(value: unknown): value is SpanLink {
  if (!value || typeof value !== "object") return false;
  const link = value as SpanLink;
  return tracePattern.test(link.traceId) && spanPattern.test(link.spanId);
}

export function readTraceHeader(headers: Headers): PropagatedTrace | null {
  try {
    const payload = headers[TRACE_HEADER];
    if (!payload) return null;
    const value = defaultPayloadConverter.fromPayload(payload) as PropagatedTrace;
    if (!value || !parseTraceparent(value.traceparent)) return null;
    return { traceparent: value.traceparent, links: Array.isArray(value.links) ? value.links.filter(validLink).slice(0, 2) : [] };
  } catch { return null; }
}

export function traceHeaders(headers: Headers, context: PropagatedTrace): Headers {
  return { ...headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(context) };
}

export function inputTraceparent(args: readonly unknown[]): string | undefined {
  const read = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const object = value as Record<string, unknown>;
    if (typeof object.traceparent === "string" && parseTraceparent(object.traceparent)) return object.traceparent;
    if (depth > 0) for (const key of ["turn", "item", "bridge", "input"]) {
      const found = read(object[key], depth - 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const arg of args) { const found = read(arg, 2); if (found) return found; }
  return undefined;
}

/** Stable per-run ID; does not consume the workflow's deterministic PRNG. */
export function workflowSpanId(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  if (!tracePattern.test(hex)) throw new Error("Temporal supplied an invalid run id");
  const span = hex.slice(16);
  return spanPattern.test(span) ? span : hex.slice(0, 16);
}

export function workflowTraceContext(runId: string, propagated?: PropagatedTrace | null): TemporalTraceContext {
  const parent = parseTraceparent(propagated?.traceparent);
  return {
    traceId: parent?.traceId ?? runId.replace(/-/g, "").toLowerCase(),
    spanId: workflowSpanId(runId),
    parentSpanId: parent?.parentId ?? null,
    links: propagated?.links?.filter(validLink).slice(0, 2) ?? []
  };
}

export const temporalAttributeKeys = [
  "temporal.workflow_id", "temporal.run_id", "temporal.workflow_type", "temporal.activity_type",
  "temporal.activity_id", "temporal.attempt", "space.trace_id", "space.room_id", "space.pane_id",
  "space.mission_id", "space.goal_id", "space.outcome", "space.reason_code", "space.category", "duration_ms"
] as const;

export function temporalAttributes(input: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const key of temporalAttributeKeys) {
    const value = input[key];
    if ((key === "duration_ms" || key === "temporal.attempt") && typeof value === "number" && Number.isFinite(value) && value >= 0) attributes[key] = value;
    else {
      const identifier = traceIdentifier(value);
      if (identifier) attributes[key] = identifier;
    }
  }
  return attributes;
}

export function workflowInputAttributes(args: readonly unknown[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const arg of args) {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
    const object = arg as Record<string, unknown>;
    for (const [input, output] of [["traceId", "space.trace_id"], ["roomId", "space.room_id"], ["paneId", "space.pane_id"], ["missionId", "space.mission_id"], ["goalId", "space.goal_id"]]) {
      const value = traceIdentifier(object[input!]);
      if (value) attrs[output!] = value;
    }
  }
  return attrs;
}
