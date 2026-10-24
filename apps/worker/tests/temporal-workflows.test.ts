import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundle } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/workflow";
import {
  DOT_GOAL_SIGNAL,
  MEMORY_MUTATION_TASK_QUEUE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL
} from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { sanitizeTemporalHistory } from "./support/sanitize-temporal-history.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mainTaskQueue = "space-real-workflows";
const workflowEntry = path.join(repoRoot, "apps/worker/tests/support/temporal-workflows.ts");
const fixtureRoot = path.join(repoRoot, "apps/worker/tests/fixtures/workflow-histories");
const recordFixtures = process.env.TEMPORAL_RECORD_HISTORIES === "1";

type ActivityCall = { name: string; args: unknown[] };
type ActivityState = { calls: ActivityCall[]; dotSteps: Array<Record<string, unknown>>; dotObservations: Array<Record<string, unknown>>; failures: number };

let environment: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

function input(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-test-1",
    paneId: "pane-test-1",
    prompt: "Run the deterministic test.",
    traceId: "trace-test-1",
    providerId: null,
    ...overrides
  };
}

function memoryRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-run-1",
    mode: "AUDIT",
    triggerKind: "SCHEDULED",
    status: "SUCCEEDED",
    workflowId: "memory-consolidation-1",
    dedupeKey: "scheduled-memory-2026-01-01",
    sourceHash: "a".repeat(64),
    actorUserId: null,
    progressCompleted: 0,
    progressTotal: 0,
    findingCount: 0,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function activitySet(state: ActivityState, options: { actionFails?: boolean } = {}) {
  const record = (name: string, args: unknown[]) => state.calls.push({ name, args });
  return {
    async recordDummyTurnStarted(value: unknown) { record("recordDummyTurnStarted", [value]); return { workflowId: "dummy-workflow-1" }; },
    async recordDummyTurnCompleted(value: any) {
      record("recordDummyTurnCompleted", [value]);
      return { workflowId: "dummy-workflow-1", roomId: value.roomId, paneId: value.paneId, traceId: value.traceId, status: "COMPLETED", message: "stub completed" };
    },
    async runCodexAppServerTurn(value: unknown) { record("runCodexAppServerTurn", [value]); return { workflowId: "turn-workflow-1", status: "COMPLETED", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "stub" } }; },
    async runOpenCodeAgentTurn(value: unknown) { record("runOpenCodeAgentTurn", [value]); return { workflowId: "turn-workflow-1", status: "COMPLETED" }; },
    async runCliAgentTurn(value: unknown) { record("runCliAgentTurn", [value]); return { workflowId: "turn-workflow-1", status: "COMPLETED" }; },
    async markRoomAgentMissionStarted(value: unknown) { record("markRoomAgentMissionStarted", [value]); return value; },
    async markRoomAgentMissionFinished(value: unknown) { record("markRoomAgentMissionFinished", [value]); return value; },
    async markRoomAgentMissionContinued(value: unknown) { record("markRoomAgentMissionContinued", [value]); return value; },
    async dotGoalStep(goalId: string) { record("dotGoalStep", [goalId]); return state.dotSteps.shift() ?? { state: "DONE", runId: null, goalStatus: "COMPLETED" }; },
    async dotGoalObserve(goalId: string, runId: string) { record("dotGoalObserve", [goalId, runId]); return state.dotObservations.shift() ?? { run: "COMPLETED", goalStatus: "COMPLETED" }; },
    async runRoomAgentBackgroundAction(value: unknown) {
      record("runRoomAgentBackgroundAction", [value]);
      if (options.actionFails) throw ApplicationFailure.nonRetryable("transport failed", "ROOM_ACTION_TRANSPORT_FAILED");
      return { id: "space-agent-room-action-bridge", results: [{ request: (value as any).bridge.actions[0], status: "EXECUTED", statusReason: "stub", paneId: "pane-test-1", missionId: "mission-test-1", evidence: {} }] };
    },
    async failRoomAgentBackgroundAction(value: unknown) { record("failRoomAgentBackgroundAction", [value]); return undefined; },
    async discardRoomAgentSupervisorTurn(value: unknown) { record("discardRoomAgentSupervisorTurn", [value]); return undefined; },
    async checkRoomAgentSupervisorTurn(value: unknown) { record("checkRoomAgentSupervisorTurn", [value]); return "SKIP"; },
    async finishRoomAgentSupervisorTurn(value: unknown) { record("finishRoomAgentSupervisorTurn", [value]); return undefined; },
    async prepareRoomAgentBackgroundContinuation(value: unknown) { record("prepareRoomAgentBackgroundContinuation", [value]); return { state: "DONE" }; },
    async settleRoomAgentBackgroundMission(value: unknown) { record("settleRoomAgentBackgroundMission", [value]); return true; },
    async refreshMemoryGraphSnapshot(value: unknown) {
      record("refreshMemoryGraphSnapshot", [value]);
      return { status: "REFRESHED", generatedAt: "2026-01-01T00:00:00.000Z", sourceHash: "a".repeat(64), previousSourceHash: null, summary: {}, durationMs: 1 };
    },
    async refreshAllMonthsMemoryGraphSnapshot(value: unknown) { record("refreshAllMonthsMemoryGraphSnapshot", [value]); return {}; },
    async reconcileStaleSpaceAgentSessions() { record("reconcileStaleSpaceAgentSessions", []); return {}; },
    async createScheduledMemoryAudit(value: unknown) { record("createScheduledMemoryAudit", [value]); return memoryRun(); },
    async prepareMemoryConsolidation(value: unknown) { record("prepareMemoryConsolidation", [value]); return { run: memoryRun(), changeSetId: null }; },
    async finalizeMemoryRepair(value: unknown) { record("finalizeMemoryRepair", [value]); return memoryRun({ status: "SUCCEEDED" }); },
    async executePersistedMemoryChangeSet(value: any) {
      record("executePersistedMemoryChangeSet", [value]);
      return { status: "DISABLED", changeSetId: value.changeSetId, resultingSourceHash: null, reason: "stub" };
    }
  };
}

async function startWorkers(state: ActivityState, queues = [mainTaskQueue], options: { actionFails?: boolean } = {}) {
  const activities = activitySet(state, options);
  const workers = await Promise.all(queues.map((taskQueue) => Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowBundle,
    activities
  })));
  const runs = workers.map((worker) => worker.run());
  return async () => {
    await Promise.all(workers.map((worker) => worker.shutdown()));
    await Promise.all(runs);
  };
}

async function waitForCall(state: ActivityState, name: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (state.calls.some((call) => call.name === name)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for activity ${name}`);
}

async function recordHistory(name: string, workflowId: string) {
  if (!recordFixtures) return;
  const history = await environment.client.workflow.getHandle(workflowId).fetchHistory();
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, `${name}.json`), sanitizeTemporalHistory(history), "utf8");
}

beforeAll(async () => {
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: workflowEntry,
    webpackConfigHook(config) {
      config.resolve ??= {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@space/contracts": path.join(repoRoot, "packages/contracts/src/index.ts")
      };
      return config;
    }
  });
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
}, 120_000);

describe("real Temporal workflow sandbox", () => {
  it("runs dummy turns with the production workflow bundle", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state);
    try {
      const result = await environment.client.workflow.execute("dummyTurnWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "real-dummy-turn-1",
        args: [input()]
      });
      await recordHistory("dummy-turn", "real-dummy-turn-1");
      expect(result.status).toBe("COMPLETED");
      expect(state.calls.map((call) => call.name)).toEqual(["recordDummyTurnStarted", "recordDummyTurnCompleted"]);
    } finally { await stop(); }
  }, 120_000);

  it("handles a Dot Goal wake signal before the waiting timeout", async () => {
    const state: ActivityState = {
      calls: [],
      dotSteps: [{ state: "WAITING", runId: null, goalStatus: "ACTIVE" }, { state: "DONE", runId: null, goalStatus: "COMPLETED" }],
      dotObservations: [],
      failures: 0
    };
    const stop = await startWorkers(state);
    try {
      const handle = await environment.client.workflow.start("dotGoalWorkflow", { taskQueue: mainTaskQueue, workflowId: "real-dot-wake-1", args: [{ goalId: "dot_goal:test-1" }] });
      await handle.signal(DOT_GOAL_SIGNAL);
      await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETED" });
      await recordHistory("dot-goal-wake", "real-dot-wake-1");
      expect(state.calls.filter((call) => call.name === "dotGoalStep")).toHaveLength(2);
    } finally { await stop(); }
  }, 120_000);

  it("advances a Dot Goal after a real time-skipping timeout", async () => {
    const state: ActivityState = {
      calls: [],
      dotSteps: [{ state: "WAITING", runId: null, goalStatus: "ACTIVE" }, { state: "DONE", runId: null, goalStatus: "COMPLETED" }],
      dotObservations: [],
      failures: 0
    };
    const stop = await startWorkers(state);
    try {
      await expect(environment.client.workflow.execute("dotGoalWorkflow", { taskQueue: mainTaskQueue, workflowId: "real-dot-timeout-1", args: [{ goalId: "dot_goal:test-2" }] })).resolves.toEqual({ goalStatus: "COMPLETED" });
      await recordHistory("dot-goal-timeout", "real-dot-timeout-1");
      expect(state.calls.filter((call) => call.name === "dotGoalStep")).toHaveLength(2);
    } finally { await stop(); }
  }, 120_000);

  it("executes the provider-routing workflow in the real sandbox", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state);
    try {
      const result = await environment.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: mainTaskQueue, workflowId: "real-codex-turn-1", args: [input()] });
      await recordHistory("codex-app-server-turn", "real-codex-turn-1");
      expect(result.status).toBe("COMPLETED");
      expect(state.calls.map((call) => call.name)).toContain("runCodexAppServerTurn");
    } finally { await stop(); }
  }, 120_000);

  it("runs memory maintenance and its consolidation child on their real task queues", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state, [mainTaskQueue, MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE]);
    try {
      const result = await environment.client.workflow.execute("memoryMaintenanceWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "real-memory-maintenance-1",
        args: [{ scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace-memory-1" }]
      });
      await recordHistory("memory-maintenance", "real-memory-maintenance-1");
      expect(result.status).toBe("REFRESHED");
      expect(state.calls.map((call) => call.name)).toEqual(expect.arrayContaining(["refreshMemoryGraphSnapshot", "createScheduledMemoryAudit", "prepareMemoryConsolidation"]));
    } finally { await stop(); }
  }, 120_000);

  it("routes the room background action failure through the patched failure activity", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state, [mainTaskQueue], { actionFails: true });
    try {
      const bridge = { roomId: "room-test-1", missionId: "mission-test-1", agentPaneId: "pane-test-1", agentSessionId: "session-test-1", selectedToolIds: [], actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] };
      await expect(environment.client.workflow.execute("roomAgentActionWorkflow", { taskQueue: mainTaskQueue, workflowId: "space-room-action:real-failure-1", args: [{ bridge, traceId: "trace-action-1" }] })).rejects.toThrow();
      await recordHistory("room-agent-action-failure", "space-room-action:real-failure-1");
      expect(state.calls.map((call) => call.name)).toEqual(expect.arrayContaining(["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]));
    } finally { await stop(); }
  }, 120_000);

  it("accepts and processes a supervisor enqueue signal in the real sandbox", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state);
    const handle = await environment.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: mainTaskQueue,
      workflowId: "space-room-supervisor:real-signal-1",
      args: [{ roomId: "room-test-1", pending: [], monitoringMissionIds: [], interrupted: [], processedCount: 0 }]
    });
    try {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { missionId: "mission-test-1", turn: input({ agentRunId: "agent-run-1" }) });
      await waitForCall(state, "checkRoomAgentSupervisorTurn");
      await waitForCall(state, "discardRoomAgentSupervisorTurn");
      expect(state.calls.map((call) => call.name)).toEqual(expect.arrayContaining(["checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn"]));
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "test cleanup" });
      await recordHistory("room-agent-supervisor", "space-room-supervisor:real-signal-1");
    } finally {
      await handle.terminate("test cleanup");
      await stop();
    }
  }, 120_000);

  it("runs memory consolidation as a standalone real workflow", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state, [MEMORY_MAINTENANCE_TASK_QUEUE]);
    try {
      const result = await environment.client.workflow.execute("memoryConsolidationWorkflow", { taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowId: "real-memory-consolidation-1", args: [{ runId: "memory-run-2", traceId: "trace-memory-3" }] });
      await recordHistory("memory-consolidation", "real-memory-consolidation-1");
      expect(result.id).toBe("memory-run-1");
      expect(state.calls.map((call) => call.name)).toContain("prepareMemoryConsolidation");
    } finally { await stop(); }
  }, 120_000);

  it("executes the memory mutation workflow against a stubbed activity", async () => {
    const state: ActivityState = { calls: [], dotSteps: [], dotObservations: [], failures: 0 };
    const stop = await startWorkers(state);
    try {
      const result = await environment.client.workflow.execute("memoryMutationWorkflow", { taskQueue: mainTaskQueue, workflowId: "real-memory-mutation-1", args: [{ changeSetId: "change-set-1", traceId: "trace-memory-2" }] });
      await recordHistory("memory-mutation", "real-memory-mutation-1");
      expect(result).toEqual({ status: "DISABLED", changeSetId: "change-set-1", resultingSourceHash: null, reason: "stub" });
    } finally { await stop(); }
  }, 120_000);
});
