/** Wire-safe trace references; shared with the deterministic workflow sandbox. */
export interface WorkflowTraceReference {
  traceId: string;
  spanId: string;
}

export function workflowTraceReference(value: unknown): WorkflowTraceReference | null {
  if (!value || typeof value !== "object") return null;
  const { traceId, spanId } = value as Partial<WorkflowTraceReference>;
  return typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId)
    && typeof spanId === "string" && /^[0-9a-f]{16}$/.test(spanId) && !/^0+$/.test(spanId)
    ? { traceId, spanId } : null;
}

/** Stable IDs without consuming Temporal's deterministic application RNG. */
export function workflowTraceSpanId(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0").replace(/^0{16}$/, "0000000000000001");
}
