import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryConsolidationRun, MemoryMaintenanceInput, MemoryMaintenanceResult, MemoryMutationWorkflowResult } from "@space/contracts";
import type { memoryConsolidationWorkflow, memoryMaintenanceWorkflow } from "../src/memory-maintenance-workflows.js";
import type { memoryMutationWorkflow } from "../src/memory-mutation-workflows.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

const timestamp = "2026-01-15T03:00:00.000Z";
const sourceHash = "a".repeat(64);
const input: MemoryMaintenanceInput = { scheduledAt: timestamp, traceId: "trace:memory-test" };
const snapshot: MemoryMaintenanceResult = {
  status: "REFRESHED", generatedAt: timestamp, sourceHash, previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 2, nodeCount: 2, edgeCount: 1, issueCount: 0 }, durationMs: 12
};
const mutation: MemoryMutationWorkflowResult = {
  status: "APPLIED", changeSetId: "changeset:memory-test", resultingSourceHash: "b".repeat(64), reason: null
};

function consolidationRun(): MemoryConsolidationRun {
  return {
    id: `audit:${randomUUID()}`, mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED",
    workflowId: `consolidation:${randomUUID()}`, dedupeKey: "memory:test:scheduled", sourceHash,
    actorUserId: null, progressCompleted: 1, progressTotal: 1, findingCount: 1,
    appliedOperationCount: 1, skippedOperationCount: 0, failedOperationCount: 0,
    metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp
  };
}

function activityStubs(run: MemoryConsolidationRun) {
  return {
    refreshMemoryGraphSnapshot: vi.fn<(_input: MemoryMaintenanceInput) => Promise<MemoryMaintenanceResult>>(async () => snapshot),
    refreshAllMonthsMemoryGraphSnapshot: vi.fn<(_input: MemoryMaintenanceInput) => Promise<MemoryMaintenanceResult>>(async () => snapshot),
    reconcileStaleSpaceAgentSessions: vi.fn(async () => 0),
    createScheduledMemoryAudit: vi.fn<(_input: MemoryMaintenanceInput & { sourceHash: string }) => Promise<MemoryConsolidationRun>>(async () => run),
    prepareMemoryConsolidation: vi.fn<(_input: { runId: string; traceId: string }) => Promise<{ run: MemoryConsolidationRun; changeSetId: string | null }>>(async () => ({ run, changeSetId: mutation.changeSetId })),
    executePersistedMemoryChangeSet: vi.fn<(_input: { changeSetId: string; traceId: string }) => Promise<MemoryMutationWorkflowResult>>(async () => mutation),
    finalizeMemoryRepair: vi.fn<(_input: { runId: string; changeSetId: string; mutationResult: MemoryMutationWorkflowResult }) => Promise<MemoryConsolidationRun>>(async () => run)
  };
}

describe("memory workflows on the Temporal time-skipping server", () => {
  let env: TestWorkflowEnvironment;
  let run: MemoryConsolidationRun;
  let activities: ReturnType<typeof activityStubs>;
  const workers: Worker[] = [];
  const workerRuns: Promise<void>[] = [];
  const workerFailures: unknown[] = [];

  beforeEach(() => {
    run = consolidationRun();
    activities = activityStubs(run);
  });

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const maintenanceWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
      activities: {
        refreshMemoryGraphSnapshot: (...args: Parameters<typeof activities.refreshMemoryGraphSnapshot>) => activities.refreshMemoryGraphSnapshot(...args),
        refreshAllMonthsMemoryGraphSnapshot: (...args: Parameters<typeof activities.refreshAllMonthsMemoryGraphSnapshot>) => activities.refreshAllMonthsMemoryGraphSnapshot(...args),
        reconcileStaleSpaceAgentSessions: () => activities.reconcileStaleSpaceAgentSessions(),
        createScheduledMemoryAudit: (...args: Parameters<typeof activities.createScheduledMemoryAudit>) => activities.createScheduledMemoryAudit(...args),
        prepareMemoryConsolidation: (...args: Parameters<typeof activities.prepareMemoryConsolidation>) => activities.prepareMemoryConsolidation(...args),
        finalizeMemoryRepair: (...args: Parameters<typeof activities.finalizeMemoryRepair>) => activities.finalizeMemoryRepair(...args)
      }
    });
    workers.push(maintenanceWorker);
    workerRuns.push(maintenanceWorker.run().catch(error => { workerFailures.push(error); }));
    const mutationWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
      activities: {
        executePersistedMemoryChangeSet: (...args: Parameters<typeof activities.executePersistedMemoryChangeSet>) => activities.executePersistedMemoryChangeSet(...args)
      }
    });
    workers.push(mutationWorker);
    workerRuns.push(mutationWorker.run().catch(error => { workerFailures.push(error); }));
  }, 120_000);

  afterEach(() => {
    expect(workerFailures).toEqual([]);
  });

  afterAll(async () => {
    try {
      for (const worker of workers) {
        if (worker.getState() === "RUNNING") worker.shutdown();
      }
      await Promise.all(workerRuns);
      expect(workerFailures).toEqual([]);
    } finally {
      await env?.teardown();
    }
  }, 30_000);

  function startMaintenance() {
    return env.client.workflow.start<typeof memoryMaintenanceWorkflow>("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: `maintenance:${randomUUID()}`, args: [input]
    });
  }

  function startConsolidation() {
    return env.client.workflow.start<typeof memoryConsolidationWorkflow>("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: run.workflowId,
      args: [{ runId: run.id, traceId: input.traceId }]
    });
  }

  function startMutation() {
    return env.client.workflow.start<typeof memoryMutationWorkflow>("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE, workflowId: `mutation:${randomUUID()}`,
      args: [{ changeSetId: mutation.changeSetId, traceId: input.traceId }]
    });
  }

  it("refreshes memory, runs a real consolidation child and applies its repair on the mutation queue", async () => {
    const handle = await startMaintenance();
    await expect(handle.result()).resolves.toEqual(snapshot);
    expect(activities.refreshMemoryGraphSnapshot).toHaveBeenCalledExactlyOnceWith(input);
    expect(activities.refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalledExactlyOnceWith(input);
    expect(activities.reconcileStaleSpaceAgentSessions).toHaveBeenCalledOnce();
    expect(activities.createScheduledMemoryAudit).toHaveBeenCalledExactlyOnceWith({ ...input, sourceHash });
    expect(activities.prepareMemoryConsolidation).toHaveBeenCalledExactlyOnceWith({ runId: run.id, traceId: input.traceId });
    expect(activities.executePersistedMemoryChangeSet).toHaveBeenCalledExactlyOnceWith({ changeSetId: mutation.changeSetId, traceId: input.traceId });
    expect(activities.finalizeMemoryRepair).toHaveBeenCalledExactlyOnceWith({ runId: run.id, changeSetId: mutation.changeSetId, mutationResult: mutation });
    const history = await handle.fetchHistory();
    const started = history.events?.find(event => event.startChildWorkflowExecutionInitiatedEventAttributes)?.startChildWorkflowExecutionInitiatedEventAttributes;
    expect(started).toMatchObject({ workflowId: run.workflowId, workflowType: { name: "memoryConsolidationWorkflow" }, taskQueue: { name: MEMORY_MAINTENANCE_TASK_QUEUE } });
    expect(history.events?.filter(event => event.childWorkflowExecutionCompletedEventAttributes)).toHaveLength(1);
    await recordWorkflowHistory("memoryMaintenanceWorkflow", handle);
  }, 20_000);

  it.each(["refresh", "reconcile", "both"] as const)("still completes audit and child consolidation after %s exhausts retries", async failure => {
    if (failure !== "reconcile") activities.refreshAllMonthsMemoryGraphSnapshot.mockRejectedValue(new Error("all-months snapshot unavailable"));
    if (failure !== "refresh") activities.reconcileStaleSpaceAgentSessions.mockRejectedValue(new Error("session reconciliation unavailable"));
    const handle = await startMaintenance();
    await expect(handle.result()).resolves.toEqual(snapshot);
    expect(activities.refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalledTimes(failure === "reconcile" ? 1 : 3);
    expect(activities.reconcileStaleSpaceAgentSessions).toHaveBeenCalledTimes(failure === "refresh" ? 1 : 3);
    expect(activities.createScheduledMemoryAudit).toHaveBeenCalledOnce();
    expect(activities.prepareMemoryConsolidation).toHaveBeenCalledOnce();
    expect(activities.finalizeMemoryRepair).toHaveBeenCalledOnce();
  }, 20_000);

  it("fails after three failed live refresh attempts without scheduling an audit", async () => {
    activities.refreshMemoryGraphSnapshot.mockRejectedValue(new Error("live snapshot unavailable"));
    const handle = await startMaintenance();
    await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "live snapshot unavailable" } } });
    expect(activities.refreshMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
    expect(activities.refreshAllMonthsMemoryGraphSnapshot).not.toHaveBeenCalled();
    expect(activities.createScheduledMemoryAudit).not.toHaveBeenCalled();
    expect(activities.prepareMemoryConsolidation).not.toHaveBeenCalled();
  }, 20_000);

  it("returns an unchanged consolidation without submitting a mutation or finalizing a repair", async () => {
    activities.prepareMemoryConsolidation.mockResolvedValue({ run, changeSetId: null });
    const handle = await startConsolidation();
    await expect(handle.result()).resolves.toEqual(run);
    expect(activities.executePersistedMemoryChangeSet).not.toHaveBeenCalled();
    expect(activities.finalizeMemoryRepair).not.toHaveBeenCalled();
  }, 20_000);

  it("retries preparation and mutation independently, then finalizes exactly once with the mutation result", async () => {
    const preparationAttempts: number[] = [];
    const mutationAttempts: number[] = [];
    activities.prepareMemoryConsolidation.mockImplementation(async () => {
      preparationAttempts.push(Context.current().info.attempt);
      if (Context.current().info.attempt < 2) throw new Error("temporary audit conflict");
      return { run, changeSetId: mutation.changeSetId };
    });
    activities.executePersistedMemoryChangeSet.mockImplementation(async () => {
      mutationAttempts.push(Context.current().info.attempt);
      expect(Context.current().info.taskQueue).toBe(MEMORY_MUTATION_TASK_QUEUE);
      if (Context.current().info.attempt < 3) throw new Error("temporary memory write conflict");
      return mutation;
    });
    const handle = await startConsolidation();
    await expect(handle.result()).resolves.toEqual(run);
    expect(preparationAttempts).toEqual([1, 2]);
    expect(mutationAttempts).toEqual([1, 2, 3]);
    expect(activities.finalizeMemoryRepair).toHaveBeenCalledExactlyOnceWith({ runId: run.id, changeSetId: mutation.changeSetId, mutationResult: mutation });
    await recordWorkflowHistory("memoryConsolidationWorkflow", handle);
  }, 20_000);

  it("does not finalize a repair when the mutation activity exhausts retries", async () => {
    activities.executePersistedMemoryChangeSet.mockRejectedValue(new Error("memory write unavailable"));
    const handle = await startConsolidation();
    await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "memory write unavailable" } } });
    expect(activities.executePersistedMemoryChangeSet).toHaveBeenCalledTimes(3);
    expect(activities.finalizeMemoryRepair).not.toHaveBeenCalled();
  }, 20_000);

  it("retries a persisted mutation and returns the complete activity result", async () => {
    const attempts: number[] = [];
    activities.executePersistedMemoryChangeSet.mockImplementation(async () => {
      attempts.push(Context.current().info.attempt);
      if (Context.current().info.attempt < 3) throw new Error("temporary write conflict");
      return mutation;
    });
    const handle = await startMutation();
    await expect(handle.result()).resolves.toEqual(mutation);
    expect(attempts).toEqual([1, 2, 3]);
    expect(activities.executePersistedMemoryChangeSet.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ changeSetId: mutation.changeSetId, traceId: input.traceId }]));
    await recordWorkflowHistory("memoryMutationWorkflow", handle);
  }, 20_000);

  it("reports exhausted mutation retries as a failed workflow", async () => {
    activities.executePersistedMemoryChangeSet.mockRejectedValue(new Error("permanent write failure"));
    const handle = await startMutation();
    await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "permanent write failure" } } });
    expect(activities.executePersistedMemoryChangeSet).toHaveBeenCalledTimes(3);
  }, 20_000);
});
