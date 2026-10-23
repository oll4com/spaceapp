import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  MEMORY_MUTATION_WORKFLOW_TYPE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  ROOM_AGENT_SUPERVISOR_WORKFLOW_TYPE
} from "@space/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(here, "../src/workflows.ts");
const memoryWorkflowsPath = resolve(here, "../src/memory-maintenance-workflows.ts");
const mutationWorkflowsPath = resolve(here, "../src/memory-mutation-workflows.ts");

let env: TestWorkflowEnvironment;
let worker: Worker;
let memoryWorker: Worker;
let mutationWorker: Worker;

const activities = {
  runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED" }),
  failRoomAgentBackgroundAction: async () => undefined,
  prepareRoomAgentBackgroundContinuation: async () => ({ items: [] }),
  checkRoomAgentSupervisorTurn: async () => ({ status: "COMPLETED" }),
  discardRoomAgentSupervisorTurn: async () => undefined,
  finishRoomAgentSupervisorTurn: async () => ({ status: "COMPLETED" }),
  refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash" }),
  refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
  reconcileStaleSpaceAgentSessions: async () => undefined,
  createScheduledMemoryAudit: async () => ({ id: "run-1", workflowId: "wf-1" }),
  prepareMemoryConsolidation: async () => ({ run: { id: "run-1" }, changeSetId: null }),
  finalizeMemoryRepair: async () => ({ id: "run-1" }),
  executePersistedMemoryChangeSet: async () => ({ ok: true })
};

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: "space-worker",
    workflowsPath,
    activities
  });
  memoryWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: "space-memory-maintenance",
    workflowsPath: memoryWorkflowsPath,
    activities
  });
  mutationWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: "space-memory-mutations",
    workflowsPath: mutationWorkflowsPath,
    activities
  });
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("real Temporal sandbox", () => {
  it("runs roomAgentActionWorkflow failure path", async () => {
    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue: "space-worker",
        workflowId: "action-1",
        args: [{ bridge: { roomId: "room:1", missionId: "mission:1" }, traceId: "trace:1" }]
      });
      return handle.result();
    });
    expect(result).toBeDefined();
  });

  it("runs roomAgentSupervisorWorkflow with enqueue and stop signals", async () => {
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(ROOM_AGENT_SUPERVISOR_WORKFLOW_TYPE, {
        taskQueue: "space-worker",
        workflowId: "supervisor-1",
        args: [{ roomId: "room:1", monitoringMissionIds: [] }]
      });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { missionId: "mission:1" });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:1" });
      await env.client.workflow.getHandle("supervisor-1").terminate("done");
    });
  });

  it("runs memoryMaintenanceWorkflow with child consolidation", async () => {
    const result = await memoryWorker.runUntil(async () => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: "space-memory-maintenance",
        workflowId: "maintenance-1",
        args: [{ traceId: "trace:1" }]
      });
      return handle.result();
    });
    expect(result).toEqual({ sourceHash: "hash" });
  });

  it("runs memoryMutationWorkflow", async () => {
    const result = await mutationWorker.runUntil(async () => {
      const handle = await env.client.workflow.start(MEMORY_MUTATION_WORKFLOW_TYPE, {
        taskQueue: "space-memory-mutations",
        workflowId: "mutation-1",
        args: [{ changeSetId: "cs-1", traceId: "trace:1" }]
      });
      return handle.result();
    });
    expect(result).toEqual({ ok: true });
  });
});
