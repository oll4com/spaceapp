import { parseTraceparent } from "@space/contracts";

/** Sandbox-safe wire format. Headers contain trace context only, never inputs. */
export const TRACE_HEADER = "space-traceparent";
export const TRACE_LINK_HEADER = "space-trace-link";
type TracePayload = { metadata?: Record<string, Uint8Array> | null; data?: Uint8Array | null };
export type TraceHeaders = Record<string, TracePayload>;

/** Encode validated ASCII trace context using Temporal's json/plain payload format. */
export function traceHeader(value: string): TracePayload {
  // Trace contexts and the converter marker are ASCII. Do not depend on
  // TextEncoder/TextDecoder globals, which are absent in some workflow VMs.
  const ascii = (text: string) => Uint8Array.from(text, character => character.charCodeAt(0));
  return { metadata: { encoding: ascii("json/plain") }, data: ascii(JSON.stringify(value)) };
}

/** Decode a bounded header and reject malformed or invalid W3C context without throwing. */
export function readTraceHeader(headers: TraceHeaders | undefined, key = TRACE_HEADER): string | null {
  try {
    const payload = headers?.[key];
    if (!payload?.data || payload.data.length > 600) return null;
    const value: unknown = JSON.parse(String.fromCharCode(...payload.data));
    return parseTraceparent(value) ? value as string : null;
  } catch { return null; }
}

/** Read only known context containers; arbitrary user payload fields are ignored. */
export function inputTraceContext(args: readonly unknown[], field = "traceparent"): string | null {
  const read = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (parseTraceparent(record[field])) return record[field] as string;
    if (!depth) return null;
    for (const key of ["turn", "item", "input", "turnInput", "bridge"]) {
      const found = read(record[key], depth - 1);
      if (found) return found;
    }
    // Supervisors can start with an already queued mission.
    if (Array.isArray(record.pending)) for (const item of record.pending.slice(0, 100)) {
      const found = read(item, depth - 1);
      if (found) return found;
    }
    return null;
  };
  for (const arg of args ?? []) { const found = read(arg, 3); if (found) return found; }
  return null;
}

/** Deterministic ID: instrumentation must not consume the workflow's PRNG. */
export function workflowSpanId(runId: string): string {
  let a = 2166136261, b = 2246822507;
  for (const c of runId) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619);
    b = Math.imul(b ^ c.charCodeAt(0), 3266489909);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
