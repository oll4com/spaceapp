import { describe, expect, it } from "vitest";
import {
  MEMORY_MUTATION_TASK_QUEUE,
  MEMORY_MUTATION_WORKFLOW_TYPE,
  buildMemoryMutationWorkflowId,
  scheduleMemoryMutation
} from "../src/memory-mutation-coordinator.js";

describe("Memory mutation coordinator", () => {
  it("starts the dedicated workflow with deterministic duplicate guards", async () => {
    const calls: Array<{ workflowType: string; options: unknown }> = [];
    const input = { changeSetId: "memory_change:approved", traceId: "req:mutation-start" };

    const result = await scheduleMemoryMutation(input, async (workflowType, options) => {
      calls.push({ workflowType, options });
      return { workflowId: options.workflowId, firstExecutionRunId: "run:mutation" };
    });

    expect(result).toEqual({
      status: "SCHEDULED",
      workflowId: "space-memory-mutation:memory_change:approved",
      runId: "run:mutation"
    });
    expect(buildMemoryMutationWorkflowId(input.changeSetId)).toBe(result.workflowId);
    expect(calls).toEqual([
      {
        workflowType: MEMORY_MUTATION_WORKFLOW_TYPE,
        options: {
          args: [input],
          memo: { spaceTraceId: input.traceId },
          taskQueue: MEMORY_MUTATION_TASK_QUEUE,
          workflowId: result.workflowId,
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowIdConflictPolicy: "USE_EXISTING"
        }
      }
    ]);
  });

  it("turns duplicate workflow starts into an idempotent response", async () => {
    const duplicate = new Error("already started");
    duplicate.name = "WorkflowExecutionAlreadyStartedError";

    const result = await scheduleMemoryMutation(
      { changeSetId: "memory_change:approved", traceId: "req:mutation-retry" },
      async () => {
        throw duplicate;
      }
    );

    expect(result).toEqual({
      status: "ALREADY_SCHEDULED",
      workflowId: "space-memory-mutation:memory_change:approved",
      runId: null
    });
  });

  it("starts a fresh retry-safe workflow for each reconciliation command identity", async () => {
    const input = { changeSetId: "memory_change:applying", traceId: "req:mutation-reconcile" };
    const firstCommandKey = `reconcile:${"a".repeat(64)}`;
    const secondCommandKey = `reconcile:${"b".repeat(64)}`;
    const calls: string[] = [];

    const first = await scheduleMemoryMutation(input, async (_workflowType, options) => {
      calls.push(options.workflowId);
      return { workflowId: options.workflowId, firstExecutionRunId: "run:reconcile-first" };
    }, firstCommandKey);
    const replay = await scheduleMemoryMutation(input, async (_workflowType, options) => {
      calls.push(options.workflowId);
      const duplicate = new Error("already started");
      duplicate.name = "WorkflowExecutionAlreadyStartedError";
      throw duplicate;
    }, firstCommandKey);
    const second = await scheduleMemoryMutation(input, async (_workflowType, options) => {
      calls.push(options.workflowId);
      return { workflowId: options.workflowId, firstExecutionRunId: "run:reconcile-second" };
    }, secondCommandKey);

    expect(first.workflowId).toBe(`space-memory-mutation:command:${firstCommandKey}`);
    expect(replay).toMatchObject({ status: "ALREADY_SCHEDULED", workflowId: first.workflowId });
    expect(second.workflowId).toBe(`space-memory-mutation:command:${secondCommandKey}`);
    expect(second.workflowId).not.toBe(first.workflowId);
    expect(calls).toEqual([first.workflowId, first.workflowId, second.workflowId]);
  });
});
