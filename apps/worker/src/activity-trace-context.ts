import { AsyncLocalStorage } from "node:async_hooks";
import { formatParent, type TraceReference } from "./tracing-protocol.js";

export const activityTraceContext = new AsyncLocalStorage<TraceReference>();
export function currentActivityTraceparent(): string | null {
  const context = activityTraceContext.getStore();
  return context ? formatParent(context) : null;
}
