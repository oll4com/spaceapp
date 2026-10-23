/**
 * Sandbox tests for the memory workflows on a real time-skipping test
 * server: memoryMaintenanceWorkflow (incl. its child consolidation run),
 * memoryConsolidationWorkflow (empty and non-empty change set paths) and
 * memoryMutationWorkflow (passthrough), plus activity retry behavior.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

let tenv: TemporalTestEnv;
let stubs: WorkflowStubs;

beforeAll(async () => {
  stubs = createWorkflowStubs();
  tenv = await createTemporalTestEnv(testWorkflowsPath(), stubs.activities);
}, 240_000);

afterAll(async () => {
  await tenv.teardown();
}, 120_000);

beforeEach(() => {
  stubs.reset();
  stubs.clearCalls();
});

const maintenanceInput = (traceId: string) => ({ scheduledAt: new Date().toISOString(), traceId });
const consolidationInput = (runId: string, traceId: string) => ({ runId, traceId });

it("maintenance continues when the all-months refresh and reconciliation fail, and runs the child consolidation", async () => {
  stubs.set("refreshAllMonthsMemoryGraphSnapshot", () => {
    throw new Error("all-months exploded");
  });
  stubs.set("reconcileStaleSpaceAgentSessions", () => {
    throw new Error("reconcile exploded");
  });
  const handle = await tenv.client.workflow.start("memoryMaintenanceWorkflow", {
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowId: "memory-maintenance-failure-test",
    args: [maintenanceInput("trace:mem-a")]
  });
  const result = await handle.result();
  // The live snapshot result is still returned.
  expect(result.status).toBe("REFRESHED");
  expect(result.sourceHash).toBe("b".repeat(64));
  // Both failing activities were retried (maxAttempts 3) and then skipped.
  expect(stubs.callCount("refreshAllMonthsMemoryGraphSnapshot")).toBe(3);
  expect(stubs.callCount("reconcileStaleSpaceAgentSessions")).toBe(3);
  expect(stubs.callCount("createScheduledMemoryAudit")).toBe(1);
  // The child consolidation workflow really ran on the maintenance queue.
  expect(stubs.callCount("prepareMemoryConsolidation")).toBe(1);
}, 180_000);

it("maintenance retries a failing snapshot activity and succeeds once it recovers", async () => {
  let attempts = 0;
  stubs.set("refreshMemoryGraphSnapshot", () => {
    attempts += 1;
    if (attempts === 1) throw new Error("snapshot exploded");
    return {
      status: "REFRESHED" as const,
      generatedAt: new Date().toISOString(),
      sourceHash: "c".repeat(64),
      previousSourceHash: null,
      summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 },
      durationMs: 1
    };
  });
  const handle = await tenv.client.workflow.start("memoryMaintenanceWorkflow", {
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowId: "memory-maintenance-retry-test",
    args: [maintenanceInput("trace:mem-b")]
  });
  const result = await handle.result();
  expect(result.sourceHash).toBe("c".repeat(64));
  expect(stubs.callCount("refreshMemoryGraphSnapshot")).toBe(2);
}, 180_000);

it("consolidation returns the run directly when there is no change set", async () => {
  const handle = await tenv.client.workflow.start("memoryConsolidationWorkflow", {
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowId: "memory-consolidation-empty-test",
    args: [consolidationInput("run:cons-empty", "trace:mem-c")]
  });
  const result = await handle.result();
  expect(result.id).toBe("run:cons-empty");
  expect(stubs.callCount("prepareMemoryConsolidation")).toBe(1);
  expect(stubs.callCount("executePersistedMemoryChangeSet")).toBe(0);
  expect(stubs.callCount("finalizeMemoryRepair")).toBe(0);
}, 120_000);

it("consolidation applies a non-empty change set and finalizes the repair", async () => {
  const now = new Date().toISOString();
  stubs.set("prepareMemoryConsolidation", (input: { runId: string }) => ({
    run: { id: input.runId, status: "RUNNING", createdAt: now, updatedAt: now },
    changeSetId: "cs:nonempty-1"
  }));
  const handle = await tenv.client.workflow.start("memoryConsolidationWorkflow", {
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
    workflowId: "memory-consolidation-change-set-test",
    args: [consolidationInput("run:cons-full", "trace:mem-d")]
  });
  const result = await handle.result();
  expect(result.id).toBe("run:cons-full");
  // The mutation activity ran on the mutations queue...
  expect(stubs.callCount("executePersistedMemoryChangeSet")).toBe(1);
  expect(stubs.lastCall("executePersistedMemoryChangeSet")![0]).toEqual({
    changeSetId: "cs:nonempty-1",
    traceId: "trace:mem-d"
  });
  // ...and the repair was finalized afterwards.
  expect(stubs.callCount("finalizeMemoryRepair")).toBe(1);
  expect(stubs.lastCall("finalizeMemoryRepair")![0]).toMatchObject({
    runId: "run:cons-full",
    changeSetId: "cs:nonempty-1"
  });
}, 120_000);

it("mutation workflow passes the change set straight through to the activity", async () => {
  const handle = await tenv.client.workflow.start("memoryMutationWorkflow", {
    taskQueue: MEMORY_MUTATION_TASK_QUEUE,
    workflowId: "memory-mutation-passthrough-test",
    args: [{ changeSetId: "cs:mut-1", traceId: "trace:mem-e" }]
  });
  const result = await handle.result();
  expect(result).toMatchObject({ status: "APPLIED", changeSetId: "cs:mut-1", reason: null });
  expect(stubs.callCount("executePersistedMemoryChangeSet")).toBe(1);
  expect(stubs.lastCall("executePersistedMemoryChangeSet")![0]).toEqual({
    changeSetId: "cs:mut-1",
    traceId: "trace:mem-e"
  });
}, 120_000);
