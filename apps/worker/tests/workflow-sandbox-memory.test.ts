import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/activity";
import {
  ActivityRecorder,
  createTimeSkippingEnvironment,
  createSandboxWorker,
  stopSandboxWorker
} from "./support/workflow-sandbox-kit.js";

const MAINTENANCE_QUEUE = "space-memory-maintenance";
const MUTATION_QUEUE = "space-memory-mutations";
const MAINTENANCE_PATH = new URL("../src/memory-maintenance-workflows.ts", import.meta.url).pathname;
const MUTATION_PATH = new URL("../src/memory-mutation-workflows.ts", import.meta.url).pathname;

const INPUT = { scheduledAt: "2026-10-23T00:00:00.000Z", traceId: "trace-run-1" };
const RUN = {
  id: "run:audit-1",
  workflowId: "space-memory-consolidation:run:audit-1"
};

const snapshotResult = {
  status: "REFRESHED",
  generatedAt: "2026-10-23T00:00:01.000Z",
  sourceHash: "hash:aaaa1111",
  previousSourceHash: null,
  summary: { entryCount: 1 },
  durationMs: 12
};

describe("real sandbox: memory maintenance + consolidation + mutation workflows", () => {
  let env: TestWorkflowEnvironment;
  const rec = new ActivityRecorder({
    refreshMemoryGraphSnapshot: () => snapshotResult,
    refreshAllMonthsMemoryGraphSnapshot: () => undefined,
    reconcileStaleSpaceAgentSessions: () => undefined,
    createScheduledMemoryAudit: () => RUN,
    prepareMemoryConsolidation: () => ({ run: RUN, changeSetId: null }),
    finalizeMemoryRepair: () => ({ status: "FINALIZED" }),
    executePersistedMemoryChangeSet: () => ({ status: "APPLIED" })
  });

  let maintenanceBundle: { worker: unknown; running: Promise<void> } | undefined;
  let mutationBundle: { worker: unknown; running: Promise<void> } | undefined;

  beforeAll(async () => {
    env = await createTimeSkippingEnvironment();
    maintenanceBundle = await createSandboxWorker(env, {
      taskQueue: MAINTENANCE_QUEUE, workflowsPath: MAINTENANCE_PATH, activities: rec.acts
    });
    mutationBundle = await createSandboxWorker(env, {
      taskQueue: MUTATION_QUEUE, workflowsPath: MUTATION_PATH, activities: rec.acts
    });
  }, 60_000);

  afterAll(async () => {
    await stopSandboxWorker(maintenanceBundle as never);
    await stopSandboxWorker(mutationBundle as never);
    await env?.teardown();
  }, 40_000);

  afterEach(() => {
    rec.restoreDefaults();
  });

  it("maintenance refreshes, audits, and runs child consolidation to completion", async () => {
    const before = { refresh: rec.count("refreshMemoryGraphSnapshot"), child: rec.count("prepareMemoryConsolidation") };
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      workflowId: "space-memory-maintenance:test-1", taskQueue: MAINTENANCE_QUEUE, args: [INPUT]
    });
    expect(result).toMatchObject({ status: "REFRESHED", sourceHash: "hash:aaaa1111" });
    expect(rec.count("refreshMemoryGraphSnapshot") - before.refresh).toBe(1);
    expect(rec.count("refreshAllMonthsMemoryGraphSnapshot")).toBe(1);
    expect(rec.count("reconcileStaleSpaceAgentSessions")).toBe(1);
    expect(rec.count("createScheduledMemoryAudit")).toBe(1);
    expect(rec.count("prepareMemoryConsolidation") - before.child).toBe(1); // child ran on the same maintenance queue
    expect(rec.count("executePersistedMemoryChangeSet")).toBe(0); // no change set prepared
  }, 30_000);

  it("maintenance continues when the all-months refresh fails (resilience)", async () => {
    rec.impl.refreshAllMonthsMemoryGraphSnapshot = () => {
      throw ApplicationFailure.nonRetryable("months are down", "MEMORY_MONTHS_DOWN");
    };
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      workflowId: "space-memory-maintenance:test-2", taskQueue: MAINTENANCE_QUEUE, args: [INPUT]
    });
    expect(result).toMatchObject({ status: "REFRESHED" });
    expect(rec.count("createScheduledMemoryAudit")).toBe(1); // maintenance moved on
    expect(rec.count("prepareMemoryConsolidation")).toBe(1);
  }, 30_000);

  it("maintenance continues when stale-session reconciliation fails (resilience)", async () => {
    rec.impl.reconcileStaleSpaceAgentSessions = () => {
      throw ApplicationFailure.nonRetryable("sessions are down", "MEMORY_SESSIONS_DOWN");
    };
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      workflowId: "space-memory-maintenance:test-3", taskQueue: MAINTENANCE_QUEUE, args: [INPUT]
    });
    expect(result).toMatchObject({ status: "REFRESHED" });
    expect(rec.count("createScheduledMemoryAudit")).toBe(1);
    expect(rec.count("prepareMemoryConsolidation")).toBe(1);
  }, 30_000);

  it("consolidation persists a prepared change set and finalizes the repair", async () => {
    rec.impl.prepareMemoryConsolidation = () => ({ run: RUN, changeSetId: "changeset:1" });
    const result = await env.client.workflow.execute("memoryConsolidationWorkflow", {
      workflowId: "space-memory-consolidation:test-4", taskQueue: MAINTENANCE_QUEUE,
      args: [{ runId: RUN.id, traceId: "trace-run-1" }]
    });
    expect(result).toMatchObject({ status: "FINALIZED" });
    const [mutationArgs] = rec.argsOf("executePersistedMemoryChangeSet").slice(-1);
    expect(mutationArgs[0]).toMatchObject({ changeSetId: "changeset:1", traceId: "trace-run-1" });
    const [finalizeArgs] = rec.argsOf("finalizeMemoryRepair").slice(-1);
    expect(finalizeArgs[0]).toMatchObject({ runId: RUN.id, changeSetId: "changeset:1" });
  }, 30_000);

  it("consolidation returns the run untouched when there is no change set", async () => {
    const before = { mutation: rec.count("executePersistedMemoryChangeSet"), finalize: rec.count("finalizeMemoryRepair") };
    const result = await env.client.workflow.execute("memoryConsolidationWorkflow", {
      workflowId: "space-memory-consolidation:test-5", taskQueue: MAINTENANCE_QUEUE,
      args: [{ runId: RUN.id, traceId: "trace-run-1" }]
    });
    expect(result).toMatchObject({ id: RUN.id, workflowId: RUN.workflowId });
    expect(rec.count("executePersistedMemoryChangeSet") - before.mutation).toBe(0);
    expect(rec.count("finalizeMemoryRepair") - before.finalize).toBe(0);
  }, 30_000);
});
