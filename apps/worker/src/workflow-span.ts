import { failureCategorySchema, isSafeErrorCode } from "@space/contracts";

/** Wire data passed through the replay-suppressed sink; no bigint in payloads. */
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number>;
  error: boolean;
  links?: Array<{ traceId: string; spanId: string }>;
}

export const WORKER_SPAN_ATTRIBUTES = new Set([
  "space.trace_id", "space.workflow_id", "space.run_id", "space.room_id", "space.pane_id", "space.mission_id",
  "space.workflow_type", "space.activity_type", "space.activity_id", "space.attempt", "space.outcome",
  "space.reason_code", "space.category", "space.duration_ms", "space.queue_ms"
]);

/** Defense in depth at every worker export boundary. No free-form strings. */
export function workerSpanAttributes(values: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const attributes: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!WORKER_SPAN_ATTRIBUTES.has(key)) continue;
    if (key === "space.reason_code" && !isSafeErrorCode(value)) continue;
    if (key === "space.category" && !failureCategorySchema.safeParse(value).success) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) attributes[key] = value;
    if (typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value)) attributes[key] = value;
  }
  return attributes;
}
