import { describe, expect, it } from "vitest";
import { createRequestTraceContext, requestTraceContexts, traceparentForTraceId } from "../src/trace-context.js";
import { scheduleMemoryConsolidation } from "../src/memory-consolidation-coordinator.js";
import { scheduleMemoryMutation } from "../src/memory-mutation-coordinator.js";

describe("OTLP API parent continuity", () => {
  it("uses the exported request span for direct turn and memory workflow starts", async () => {
    const context = createRequestTraceContext(undefined);
    const traceId = "req:otlp-parent-test";
    requestTraceContexts.remember(traceId, context);
    expect(traceparentForTraceId(traceId)).toBe(context.traceparent);
    const memos: unknown[] = [];
    const start = async (_type: string, options: { workflowId: string; memo?: Record<string, string> }) => {
      memos.push(options.memo);
      return { workflowId: options.workflowId };
    };
    await scheduleMemoryConsolidation({ runId: "audit:test", traceId }, "workflow:test", start);
    await scheduleMemoryMutation({ changeSetId: "change:test", traceId }, start);
    expect(memos).toEqual([0, 1].map(() => ({ spaceTraceId: traceId, traceparent: context.traceparent, w3cTraceId: context.w3cTraceId })));
  });
});
