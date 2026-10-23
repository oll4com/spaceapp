import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, ActivityFailure, ChildWorkflowFailure } from "@temporalio/common";
import { WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  memoryConsolidationRunSchema,
  memoryMaintenanceResultSchema,
  memoryMutationWorkflowResultSchema
} from "@space/contracts";
import type { MemoryMaintenanceInput } from "@space/contracts";
import type { FinalizeMemoryRepairInput, MemoryConsolidationPreparation, ScheduledMemoryAuditInput } from "../src/memory-maintenance-activities.js";
import type { memoryConsolidationWorkflow, memoryMaintenanceWorkflow } from "../src/memory-maintenance-workflows.js";
import type { memoryMutationWorkflow } from "../src/memory-mutation-workflows.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

const timestamp = "2026-07-13T02:15:00.000Z";
const sourceHash = "a".repeat(64);
const input: MemoryMaintenanceInput = { scheduledAt: timestamp, traceId: "trace:memory-sandbox" };
const changeSetId = "changeset:memory-sandbox";
const snapshot = memoryMaintenanceResultSchema.parse({
  status: "REFRESHED", generatedAt: timestamp, sourceHash, previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 2, nodeCount: 2, edgeCount: 0, issueCount: 0 }, durationMs: 1
});
const mutation = memoryMutationWorkflowResultSchema.parse({
  status: "APPLIED", changeSetId, resultingSourceHash: "b".repeat(64), reason: null
});

function completedRun() {
  return memoryConsolidationRunSchema.parse({
    id: `run:${randomUUID()}`, mode: "AUDIT", triggerKind: "SCHEDULED", status: "SUCCEEDED",
    workflowId: `memory-child:${randomUUID()}`, dedupeKey: `scheduled:${randomUUID()}`,
    sourceHash, actorUserId: null, progressCompleted: 0, progressTotal: 0,
    findingCount: 0, appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0,
    metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp
  });
}

describe("memory workflows in the real Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  const workers: Worker[] = [];
  const running: Promise<void>[] = [];
  let run = completedRun();
  const refresh = vi.fn<(input: MemoryMaintenanceInput) => Promise<typeof snapshot>>(async () => snapshot);
  const allMonths = vi.fn<(input: MemoryMaintenanceInput) => Promise<typeof snapshot>>(async () => snapshot);
  const sessions = vi.fn(async () => 0);
  const audit = vi.fn<(input: ScheduledMemoryAuditInput) => Promise<typeof run>>(async () => run);
  const prepare = vi.fn(async (): Promise<MemoryConsolidationPreparation> => ({ run, changeSetId: null }));
  const mutate = vi.fn(async () => mutation);
  const finalize = vi.fn<(input: FinalizeMemoryRepairInput) => Promise<typeof run>>(async () => run);

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const startWorker = (worker: Worker) => {
      workers.push(worker);
      const promise = worker.run();
      running.push(promise);
      // Keep a startup failure observable in afterAll without an unhandled rejection.
      void promise.catch(() => {});
    };
    startWorker(await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
      activities: {
        refreshMemoryGraphSnapshot: refresh,
        refreshAllMonthsMemoryGraphSnapshot: allMonths,
        reconcileStaleSpaceAgentSessions: sessions,
        createScheduledMemoryAudit: audit,
        prepareMemoryConsolidation: prepare,
        finalizeMemoryRepair: finalize
      }
    }));
    startWorker(await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
      activities: { executePersistedMemoryChangeSet: mutate }
    }));
    // afterAll owns teardown even if creating the second worker fails: the
    // first worker is already running and can release its native connection.
  }, 120_000);

  afterAll(async () => {
    try {
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      const results = await Promise.allSettled(running);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      await env?.teardown();
    }
  }, 30_000);

  beforeEach(() => {
    run = completedRun();
    refresh.mockReset().mockResolvedValue(snapshot);
    allMonths.mockReset().mockResolvedValue(snapshot);
    sessions.mockReset().mockResolvedValue(0);
    audit.mockReset().mockImplementation(async () => run);
    prepare.mockReset().mockImplementation(async () => ({ run, changeSetId: null }));
    mutate.mockReset().mockResolvedValue(mutation);
    finalize.mockReset().mockImplementation(async () => run);
  });

  async function maintain(record = false) {
    const handle = await env.client.workflow.start<typeof memoryMaintenanceWorkflow>("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: `maintenance:${randomUUID()}`, args: [input]
    });
    const result = await handle.result();
    if (record) await recordWorkflowHistory(handle, "memory-maintenance");
    return result;
  }
  async function consolidate(record = false) {
    const handle = await env.client.workflow.start<typeof memoryConsolidationWorkflow>("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: `consolidation:${randomUUID()}`,
      args: [{ runId: run.id, traceId: input.traceId }]
    });
    const result = await handle.result();
    if (record) await recordWorkflowHistory(handle, "memory-consolidation");
    return result;
  }
  async function mutationWorkflow(record = false) {
    const handle = await env.client.workflow.start<typeof memoryMutationWorkflow>("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE, workflowId: `mutation:${randomUUID()}`,
      args: [{ changeSetId, traceId: input.traceId }]
    });
    const result = await handle.result();
    if (record) await recordWorkflowHistory(handle, "memory-mutation");
    return result;
  }

  it("refreshes, reconciles and awaits an actual consolidation child", async () => {
    expect(await maintain(true)).toEqual(snapshot);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(input);
    expect(allMonths).toHaveBeenCalledExactlyOnceWith(input);
    expect(sessions).toHaveBeenCalledExactlyOnceWith();
    expect(audit).toHaveBeenCalledExactlyOnceWith({ ...input, sourceHash });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ runId: run.id, traceId: input.traceId });
    const child = env.client.workflow.getHandle(run.workflowId);
    expect((await child.describe()).type).toBe("memoryConsolidationWorkflow");
    expect(await child.result()).toEqual(run);
    expect(mutate).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["all-months", "sessions", "both"] as const)("continues after %s failures exhaust activity retries", async (failure) => {
    if (failure !== "sessions") allMonths.mockRejectedValue(new Error("all-months unavailable"));
    if (failure !== "all-months") sessions.mockRejectedValue(new Error("session reconciliation unavailable"));
    expect(await maintain()).toEqual(snapshot);
    expect(allMonths).toHaveBeenCalledTimes(failure === "sessions" ? 1 : 3);
    expect(sessions).toHaveBeenCalledTimes(failure === "all-months" ? 1 : 3);
    expect(audit).toHaveBeenCalledOnce();
    expect(await env.client.workflow.getHandle(run.workflowId).result()).toEqual(run);
  }, 30_000);

  it("fails maintenance after three live snapshot attempts without scheduling an audit", async () => {
    refresh.mockRejectedValue(new Error("snapshot unavailable"));
    const error = await maintain().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect((error as WorkflowFailedError).cause).toBeInstanceOf(ActivityFailure);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(allMonths).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  }, 30_000);

  it("returns a prepared audit without dispatching mutation or finalization", async () => {
    expect(await consolidate()).toEqual(run);
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ runId: run.id, traceId: input.traceId });
    expect(mutate).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  }, 30_000);

  it("retries preparation and dispatches repair to the actual mutation task queue before finalizing", async () => {
    prepare.mockRejectedValueOnce(new Error("transient preparation failure"))
      .mockResolvedValue({ run, changeSetId });
    mutate.mockRejectedValueOnce(new Error("transient mutation failure"));
    expect(await consolidate(true)).toEqual(run);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith({ changeSetId, traceId: input.traceId });
    expect(finalize).toHaveBeenCalledExactlyOnceWith({ runId: run.id, changeSetId, mutationResult: mutation });
  }, 30_000);

  it("propagates a real child failure to maintenance", async () => {
    prepare.mockRejectedValue(ApplicationFailure.nonRetryable("invalid audit", "InvalidAudit"));
    const error = await maintain().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect((error as WorkflowFailedError).cause).toBeInstanceOf(ChildWorkflowFailure);
    expect(prepare).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  }, 30_000);

  it("does not finalize a repair when mutation exhausts its retries", async () => {
    prepare.mockResolvedValue({ run, changeSetId });
    mutate.mockRejectedValue(new Error("repair mutation unavailable"));
    const error = await consolidate().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect((error as WorkflowFailedError).cause).toBeInstanceOf(ActivityFailure);
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(finalize).not.toHaveBeenCalled();
  }, 30_000);

  it("retries mutation workflow activities and returns their result unchanged", async () => {
    mutate.mockRejectedValueOnce(new Error("temporary mutation failure"));
    expect(await mutationWorkflow(true)).toEqual(mutation);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith({ changeSetId, traceId: input.traceId });
  }, 30_000);

  it("fails mutation after its three allowed attempts", async () => {
    mutate.mockRejectedValue(new Error("persistent mutation failure"));
    const error = await mutationWorkflow().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect((error as WorkflowFailedError).cause).toBeInstanceOf(ActivityFailure);
    expect(mutate).toHaveBeenCalledTimes(3);
  }, 30_000);
});
