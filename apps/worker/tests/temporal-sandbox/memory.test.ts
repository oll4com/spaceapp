/**
 * memoryMaintenanceWorkflow, memoryConsolidationWorkflow and
 * memoryMutationWorkflow on the real time-skipping test server (issue #60).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityStubs, buildActivities } from "./activity-stubs.js";
import { consolidationRun, HEX64, memoryMaintenanceResult } from "./stubs.js";
import {
  createSandboxEnv,
  MAIN_TASK_QUEUE,
  MEMORY_MAINTENANCE_TASK_QUEUE,
  MEMORY_MUTATION_TASK_QUEUE,
  type SandboxEnv
} from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;

beforeAll(async () => {
  env = await createSandboxEnv();
  // All three task queues host workers with the real workflows and stubbed
  // activities: the maintenance workflow proxies the mutation activity to
  // the space-memory-mutations queue.
  await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
  await env.startWorker(MEMORY_MAINTENANCE_TASK_QUEUE, buildActivities(stubs));
  await env.startWorker(MEMORY_MUTATION_TASK_QUEUE, buildActivities(stubs));
}, 120000);

beforeEach(() => stubs.reset());

afterAll(async () => {
  await env.teardown();
}, 60000);

const maintenanceInput = (suffix: string) => ({
  scheduledAt: "2026-01-01T00:00:00.000Z",
  traceId: "trace:memory-" + suffix
});

describe("memoryMaintenanceWorkflow", () => {
  it("refreshes the snapshot, audits, and runs the consolidation child with a persisted change set", async () => {
    const handle = await env.testEnv.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-maint-test-01",
      args: [maintenanceInput("01")]
    });

    const result = await handle.result();

    expect(result).toEqual(memoryMaintenanceResult());
    expect(stubs.count("refreshMemoryGraphSnapshot")).toBe(1);
    expect(stubs.count("refreshAllMonthsMemoryGraphSnapshot")).toBe(1);
    expect(stubs.count("reconcileStaleSpaceAgentSessions")).toBe(1);
    expect(stubs.callsOf("createScheduledMemoryAudit")[0]).toMatchObject({
      traceId: "trace:memory-01",
      sourceHash: HEX64
    });
    // The child memoryConsolidationWorkflow ran to completion through the
    // mutation task queue.
    expect(stubs.callsOf("prepareMemoryConsolidation")[0]).toMatchObject({ runId: "run-trace:memory-01", traceId: "trace:memory-01" });
    expect(stubs.callsOf("executePersistedMemoryChangeSet")[0]).toMatchObject({
      changeSetId: "changeset-0001",
      traceId: "trace:memory-01"
    });
    expect(stubs.count("finalizeMemoryRepair")).toBe(1);
  }, 60000);

  it("keeps maintaining memory when the all-months refresh and session reconciliation fail", async () => {
    stubs.override("refreshAllMonthsMemoryGraphSnapshot", () => {
      throw new Error("synthetic all-months failure");
    });
    stubs.override("reconcileStaleSpaceAgentSessions", () => {
      throw new Error("synthetic reconciliation failure");
    });

    const handle = await env.testEnv.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-maint-test-02",
      args: [maintenanceInput("02")]
    });

    const result = await handle.result();

    expect(result.status).toBe("REFRESHED");
    expect(stubs.count("refreshAllMonthsMemoryGraphSnapshot")).toBe(3);
    expect(stubs.count("reconcileStaleSpaceAgentSessions")).toBe(3);
    expect(stubs.count("prepareMemoryConsolidation")).toBe(1);
    expect(stubs.count("finalizeMemoryRepair")).toBe(1);
  }, 60000);

  it("retries a failing snapshot refresh and completes once the activity recovers", async () => {
    stubs.override("refreshMemoryGraphSnapshot", (_input, index) => {
      if (index < 2) throw new Error("synthetic refresh failure");
      return memoryMaintenanceResult();
    });

    const handle = await env.testEnv.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-maint-test-03",
      args: [maintenanceInput("03")]
    });

    const result = await handle.result();
    expect(result.status).toBe("REFRESHED");
    expect(stubs.count("refreshMemoryGraphSnapshot")).toBe(3);
  }, 60000);
});

describe("memoryConsolidationWorkflow", () => {
  it("applies a prepared change set and finalizes the repair", async () => {
    const handle = await env.testEnv.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-cons-test-01",
      args: [{ runId: "run-trace:memory-04", traceId: "trace:memory-04" }]
    });

    const result = await handle.result();

    expect(result).toEqual(consolidationRun("run-trace:memory-04"));
    expect(stubs.callsOf("prepareMemoryConsolidation")[0]).toMatchObject({ runId: "run-trace:memory-04" });
    expect(stubs.count("executePersistedMemoryChangeSet")).toBe(1);
    expect(stubs.count("finalizeMemoryRepair")).toBe(1);
  }, 60000);

  it("returns the prepared run unchanged when there is no change set to apply", async () => {
    stubs.override("prepareMemoryConsolidation", (input) => ({
      run: consolidationRun(input.runId),
      changeSetId: null
    }));

    const handle = await env.testEnv.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-cons-test-02",
      args: [{ runId: "run-trace:memory-05", traceId: "trace:memory-05" }]
    });

    const result = await handle.result();

    expect(result).toEqual(consolidationRun("run-trace:memory-05"));
    expect(stubs.count("executePersistedMemoryChangeSet")).toBe(0);
    expect(stubs.count("finalizeMemoryRepair")).toBe(0);
  }, 60000);

  it("fails the consolidation when the mutation activity keeps failing", async () => {
    stubs.override("executePersistedMemoryChangeSet", () => {
      throw new Error("synthetic mutation failure");
    });

    const handle = await env.testEnv.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId: "memory-cons-test-03",
      args: [{ runId: "run-trace:memory-06", traceId: "trace:memory-06" }]
    });

    await expect(handle.result()).rejects.toThrow();
    expect(stubs.count("executePersistedMemoryChangeSet")).toBe(3);
    expect(stubs.count("finalizeMemoryRepair")).toBe(0);
  }, 60000);
});

describe("memoryMutationWorkflow", () => {
  it("applies a persisted change set on the mutation task queue", async () => {
    const handle = await env.testEnv.client.workflow.start("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowId: "memory-mut-test-01",
      args: [{ changeSetId: "changeset-0002", traceId: "trace:memory-07" }]
    });

    const result = await handle.result();

    expect(result).toMatchObject({ status: "APPLIED", changeSetId: "changeset-0002" });
    expect(stubs.callsOf("executePersistedMemoryChangeSet")[0]).toMatchObject({
      changeSetId: "changeset-0002",
      traceId: "trace:memory-07"
    });
  }, 60000);

  it("retries a failing mutation and completes once the activity recovers", async () => {
    stubs.override("executePersistedMemoryChangeSet", (input, index) => {
      if (index < 2) throw new Error("synthetic mutation failure");
      return { status: "APPLIED", changeSetId: input.changeSetId, resultingSourceHash: HEX64, reason: null };
    });

    const handle = await env.testEnv.client.workflow.start("memoryMutationWorkflow", {
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowId: "memory-mut-test-02",
      args: [{ changeSetId: "changeset-0003", traceId: "trace:memory-08" }]
    });

    const result = await handle.result();

    expect(result.status).toBe("APPLIED");
    expect(stubs.count("executePersistedMemoryChangeSet")).toBe(3);
  }, 60000);
});
