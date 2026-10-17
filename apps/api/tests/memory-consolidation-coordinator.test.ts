import { describe, expect, it } from "vitest";
import {
  MEMORY_CONSOLIDATION_TASK_QUEUE,
  MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  scheduleMemoryConsolidation
} from "../src/memory-consolidation-coordinator.js";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";

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

  it("propagates the active API request traceparent and correlation memo when registered", async () => {
    const calls: Array<{ workflowType: string; options: unknown }> = [];
    const traceCtx = createRequestTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    requestTraceContexts.remember("req:consolidation-traced", traceCtx);
    const input = { runId: "memory_consolidation:run-traced", traceId: "req:consolidation-traced" };
    const workflowId = `space-memory-consolidation:${"c".repeat(64)}`;

    await scheduleMemoryConsolidation(input, workflowId, async (workflowType, options) => {
      calls.push({ workflowType, options });
      return { workflowId: options.workflowId, firstExecutionRunId: "temporal:run-traced" };
    });

    expect(calls).toEqual([{
      workflowType: MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
      options: {
        args: [{ ...input, traceparent: traceCtx.traceparent }],
        taskQueue: MEMORY_CONSOLIDATION_TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
        memo: {
          spaceTraceId: "req:consolidation-traced",
          traceparent: traceCtx.traceparent,
          w3cTraceId: traceCtx.w3cTraceId
        }
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
