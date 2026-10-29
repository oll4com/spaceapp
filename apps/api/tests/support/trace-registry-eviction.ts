import { createRequestTraceContext, requestTraceContexts } from "../../src/trace-context.js";

/** Fill the real bounded registry while the request keeps its own context. */
export function evictRequestTraceContext(requestId: string): void {
  const filler = createRequestTraceContext(undefined);
  for (let i = 0; i < 4096; i++) requestTraceContexts.remember(`req:eviction:${i}`, filler);
  if (requestTraceContexts.lookup(requestId)) throw new Error("Request was not evicted");
}
