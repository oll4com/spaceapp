import { describe, expect, it } from "vitest";
import { requestTraceContexts } from "../src/trace-context.js";
import {
  MEMORY_CONSOLIDATION_TASK_QUEUE,
  MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  scheduleMemoryConsolidation
} from "../src/memory-consolidation-coordinator.js";

describe("Memory consolidation coordinator", () => {
  it("propagates actual API SERVER context through Temporal memo", async () => {
    const requestId = "req:test-memory-consolidation";
    const traceId = "12341234123412341234123412341234";
    const spanId = "deadbeef12345678";
    requestTraceContexts.remember(requestId, {
      w3cTraceId: traceId, spanId, parentSpanId: null, inbound: false,
      traceparent: "00-" + traceId + "-" + spanId + "-01"
    });
    let memo: Record<string, string> | undefined;
    await scheduleMemoryConsolidation(
      { runId: "memory_consolidation:sample", traceId: requestId },
      "space-memory-consolidation:test-workflow",
      async (_name, options) => { memo = options.memo; return { workflowId: options.workflowId }; }
    );
    expect(memo).toEqual({
      spaceTraceId: requestId,
      traceparent: "00-" + traceId + "-" + spanId + "-01",
      w3cTraceId: traceId
    });
  });


  it("starts a retry-safe workflow on the exclusive maintenance queue", async () => {
    const calls: Array<{ workflowType: string; options: unknown }> = [];
    const input = { runId: "memory_consolidation:run-1", traceId: "trace:memory-consolidation" };
    const workflowId = `space-memory-consolidation:${"a".repeat(64)}`;

    const result = await scheduleMemoryConsolidation(input, workflowId, async (workflowType, options) => {
      calls.push({ workflowType, options });
      return { workflowId: options.workflowId, firstExecutionRunId: "temporal:run-1" };
    });

    expect(result).toEqual({ status: "SCHEDULED", workflowId, runId: "temporal:run-1" });
    expect(calls).toEqual([{
      workflowType: MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
      options: {
        args: [input],
        taskQueue: MEMORY_CONSOLIDATION_TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING"
      }
    }]);
  });

  it("maps duplicate starts to a stable idempotent result", async () => {
    const duplicate = new Error("already started");
    duplicate.name = "WorkflowExecutionAlreadyStartedError";
    const workflowId = `space-memory-consolidation:${"b".repeat(64)}`;

    const result = await scheduleMemoryConsolidation(
      { runId: "memory_consolidation:run-2", traceId: "trace:memory-consolidation-retry" },
      workflowId,
      async () => { throw duplicate; }
    );

    expect(result).toEqual({ status: "ALREADY_SCHEDULED", workflowId, runId: null });
  });
});
