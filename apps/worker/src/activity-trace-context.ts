import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { formatTraceparent, parseTraceparent } from "@space/contracts";

export interface ActivityTraceContext { traceId: string; spanId: string; flags: string }
const activityTraceContexts = new AsyncLocalStorage<ActivityTraceContext>();

/** The actual parent workflow span, scoped to this activity attempt only. */
export function runWithActivityTraceContext<T>(context: ActivityTraceContext | null, run: () => T): T {
  return context ? activityTraceContexts.run(context, run) : run();
}

/** Generate a nonzero host-side carrier ID without using workflow sandbox randomness. */
function randomId(bytes: number): string {
  let value: string;
  do { value = randomBytes(bytes).toString("hex"); } while (/^0+$/.test(value));
  return value;
}

/** A background turn starts a new trace and links to the work it continues. */
export function createBackgroundTraceContext(fallbackTraceparent?: string): {
  traceparent: string;
  traceLinks: Array<{ traceId: string; spanId: string }>;
} {
  const active = activityTraceContexts.getStore();
  const fallback = parseTraceparent(fallbackTraceparent);
  const prior = active ?? (fallback ? { traceId: fallback.traceId, spanId: fallback.parentId, flags: fallback.flags } : null);
  return {
    // This is a context carrier, not an emitted parent. The workflow interceptor
    // recognizes background continuation links and starts a root span (parent=null).
    traceparent: formatTraceparent(randomId(16), randomId(8), "01"),
    traceLinks: prior ? [{ traceId: prior.traceId, spanId: prior.spanId }] : []
  };
}
