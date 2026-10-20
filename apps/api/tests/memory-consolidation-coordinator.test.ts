import { describe, expect, it } from "vitest";
import {
  MEMORY_CONSOLIDATION_TASK_QUEUE,
  MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  scheduleMemoryConsolidation
} from "../src/memory-consolidation-coordinator.js";

describe("Memory consolidation coordinator", () => {
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

  it("propagates the request traceparent in the workflow memo", async () => {
    const calls: Array<{ options: { memo?: Record<string, string> } }> = [];
    const input = { runId: "memory_consolidation:run-3", traceId: "req:memory-consolidation" };
    const workflowId = `space-memory-consolidation:${"c".repeat(64)}`;
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await scheduleMemoryConsolidation(input, workflowId, async (_workflowType, options) => {
      calls.push({ options });
      return { workflowId: options.workflowId };
    }, traceparent);

    expect(calls[0]?.options.memo).toEqual({
      traceparent,
      w3cTraceId: "4bf92f3577b34da6a3ce929d0e0e4736"
    });
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
