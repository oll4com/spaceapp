import { describe, expect, it } from "vitest";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";
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
        memo: { spaceTraceId: input.traceId },
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

  it("propagates the recorded API span through memo without changing the strict workflow input", async () => {
    const traceId = "req:consolidation-tracing";
    const context = createRequestTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    requestTraceContexts.remember(traceId, context);
    const input = { runId: "memory_consolidation:trace-test", traceId };
    let options: any;
    await scheduleMemoryConsolidation(input, "memory-consolidation:trace-test", async (_, value) => {
      options = value; return { workflowId: value.workflowId };
    });
    expect(options.args).toEqual([input]);
    expect(options.memo).toEqual({ spaceTraceId: traceId, traceparent: context.traceparent, w3cTraceId: context.w3cTraceId });
  });
});
