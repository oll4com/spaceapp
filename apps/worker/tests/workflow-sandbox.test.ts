import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { WorkflowFailedError } from "@temporalio/client";
import {
  DOT_GOAL_SIGNAL,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  buildCodexAppServerTurnWorkflowId,
  type DummyTurnInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { DEFAULT_TASK_QUEUE } from "../src/constants.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";

const PRE_PATCH_TASK_QUEUE = "space-agent-turns-pre-patch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_WORKFLOWS_PATH = path.resolve(__dirname, "../src/workflows.ts");
const MEMORY_MAINTENANCE_WORKFLOWS_PATH = path.resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const MEMORY_MUTATION_WORKFLOWS_PATH = path.resolve(__dirname, "../src/memory-mutation-workflows.ts");

function createQueueItem(
  agentRunId: string,
  missionId = "mission:sandbox-1",
  roomId = "room:sandbox-1",
  prompt = "Execute room task."
): RoomAgentSupervisorQueueItem {
  return {
    missionId,
    turn: {
      roomId,
      paneId: "pane:sandbox-1",
      prompt,
      artifactIds: [],
      agentRunId,
      permissionMode: null,
      collaborationMode: "default",
      traceId: `trace:${agentRunId}`
    }
  };
}

describe("Temporal Workflow Sandbox (TimeSkipping)", { timeout: 180_000 }, () => {
  let env: TestWorkflowEnvironment;
  let mainWorker: Worker;
  let prePatchWorker: Worker;
  let memoryMaintenanceWorker: Worker;
  let memoryMutationWorker: Worker;
  let workersPromise: Promise<[void, void, void, void]>;
  let stopActivity = false;
  let stopLegacyActivity = false;

  async function terminateWorkflow(workflowId: string, runId?: string) {
    stopActivity = true;
    stopLegacyActivity = true;
    try {
      await env.client.workflow.getHandle(workflowId).terminate().catch(() => {});
      if (runId) {
        await env.client.workflow.getHandle(workflowId, runId).terminate().catch(() => {});
      }
    } catch {}
  }

  const activityHandlers = {
    // Dot Goal
    dotGoalStep: vi.fn(async (goalId: string) => ({
      state: "DONE",
      runId: null,
      goalStatus: "COMPLETED"
    })),
    dotGoalObserve: vi.fn(async (goalId: string, runId: string) => ({
      run: "COMPLETED",
      goalStatus: "COMPLETED"
    })),

    // Dummy Turn
    recordDummyTurnStarted: vi.fn(async (input: DummyTurnInput) => ({
      workflowId: `wf:${input.agentRunId ?? "dummy"}`
    })),
    recordDummyTurnCompleted: vi.fn(async (input: DummyTurnInput) => ({
      status: "COMPLETED" as const,
      message: "Dummy turn completed."
    })),

    // Codex App Server Turn / Providers
    runOpenCodeAgentTurn: vi.fn(async (input: DummyTurnInput) => ({
      status: "COMPLETED" as const,
      message: "OpenCode turn completed."
    })),
    runCliAgentTurn: vi.fn(async (input: DummyTurnInput) => ({
      status: "COMPLETED" as const,
      message: "CLI turn completed."
    })),
    runCodexAppServerTurn: vi.fn(async (input: DummyTurnInput) => ({
      status: "COMPLETED" as const,
      message: "Codex turn completed.",
      roomAgentOutcome: {
        status: "VERIFIED" as const,
        executedActionCount: 1,
        statusReason: "Verified action."
      }
    })),

    // Room Agent Supervisor (Current Branch)
    checkRoomAgentSupervisorTurn: vi.fn(async (item: RoomAgentSupervisorQueueItem) => "ACTIVE" as string),
    prepareRoomAgentBackgroundContinuation: vi.fn(async (input: { roomId: string; missionId: string; continuationId: string }) => ({
      state: "DONE" as const
    })),
    discardRoomAgentSupervisorTurn: vi.fn(async (input: {
      item: RoomAgentSupervisorQueueItem;
      reason: string;
      errorCode?: string;
    }) => undefined),
    finishRoomAgentSupervisorTurn: vi.fn(async (input: {
      item: RoomAgentSupervisorQueueItem;
      status: string;
      statusReason: string;
      errorCode?: string;
    }) => undefined),

    // Room Agent Supervisor (Legacy Pre-Patch Branch)
    markRoomAgentMissionStarted: vi.fn(async (input: { missionId: string; roomId: string; paneId: string }) => undefined),
    markRoomAgentMissionFinished: vi.fn(async (input: {
      missionId: string;
      roomId: string;
      status: string;
      statusReason: string;
      errorCode?: string;
    }) => undefined),
    markRoomAgentMissionContinued: vi.fn(async (input: { missionId: string; roomId: string; statusReason: string }) => undefined),
    settleRoomAgentBackgroundMission: vi.fn(async (input: { roomId: string; missionId: string }) => true),

    // Room Agent Action
    runRoomAgentBackgroundAction: vi.fn(async (input: {
      bridge: { roomId: string; missionId: string };
      actionId?: string;
      traceId?: string;
    }) => ({
      status: "COMPLETED" as const,
      actionId: input.actionId ?? "act:sandbox-default"
    })),
    failRoomAgentBackgroundAction: vi.fn(async (input: {
      roomId: string;
      missionId: string;
      actionId: string;
      cancelled: boolean;
    }) => undefined),

    // Memory Maintenance
    refreshMemoryGraphSnapshot: vi.fn(async (input: any) => ({
      snapshotId: "snapshot:live",
      sourceHash: "hash:source-123"
    })),
    refreshAllMonthsMemoryGraphSnapshot: vi.fn(async (input: any) => ({
      snapshotId: "snapshot:all-months"
    })),
    reconcileStaleSpaceAgentSessions: vi.fn(async () => ({ reconciledCount: 0 })),
    createScheduledMemoryAudit: vi.fn(async (input: any) => ({
      id: "audit:run-1",
      workflowId: `wf:audit-${Date.now()}`
    })),
    prepareMemoryConsolidation: vi.fn(async (input: any) => ({
      run: { id: input.runId, status: "PREPARED" },
      changeSetId: null as string | null
    })),
    finalizeMemoryRepair: vi.fn(async (input: any) => ({
      id: input.runId,
      status: "COMPLETED",
      changeSetId: input.changeSetId,
      mutationResult: input.mutationResult
    })),

    // Memory Mutation
    executePersistedMemoryChangeSet: vi.fn(async (input: any) => ({
      status: "APPLIED",
      appliedCount: 1,
      changeSetId: input.changeSetId
    }))
  };

  const mainActivities = {
    dotGoalStep: (...args: Parameters<typeof activityHandlers.dotGoalStep>) => activityHandlers.dotGoalStep(...args),
    dotGoalObserve: (...args: Parameters<typeof activityHandlers.dotGoalObserve>) => activityHandlers.dotGoalObserve(...args),
    recordDummyTurnStarted: (...args: Parameters<typeof activityHandlers.recordDummyTurnStarted>) => activityHandlers.recordDummyTurnStarted(...args),
    recordDummyTurnCompleted: (...args: Parameters<typeof activityHandlers.recordDummyTurnCompleted>) => activityHandlers.recordDummyTurnCompleted(...args),
    runOpenCodeAgentTurn: (...args: Parameters<typeof activityHandlers.runOpenCodeAgentTurn>) => activityHandlers.runOpenCodeAgentTurn(...args),
    runCliAgentTurn: (...args: Parameters<typeof activityHandlers.runCliAgentTurn>) => activityHandlers.runCliAgentTurn(...args),
    runCodexAppServerTurn: (...args: Parameters<typeof activityHandlers.runCodexAppServerTurn>) => activityHandlers.runCodexAppServerTurn(...args),
    checkRoomAgentSupervisorTurn: (...args: Parameters<typeof activityHandlers.checkRoomAgentSupervisorTurn>) => activityHandlers.checkRoomAgentSupervisorTurn(...args),
    prepareRoomAgentBackgroundContinuation: (...args: Parameters<typeof activityHandlers.prepareRoomAgentBackgroundContinuation>) => activityHandlers.prepareRoomAgentBackgroundContinuation(...args),
    discardRoomAgentSupervisorTurn: (...args: Parameters<typeof activityHandlers.discardRoomAgentSupervisorTurn>) => activityHandlers.discardRoomAgentSupervisorTurn(...args),
    finishRoomAgentSupervisorTurn: (...args: Parameters<typeof activityHandlers.finishRoomAgentSupervisorTurn>) => activityHandlers.finishRoomAgentSupervisorTurn(...args),
    markRoomAgentMissionStarted: (...args: Parameters<typeof activityHandlers.markRoomAgentMissionStarted>) => activityHandlers.markRoomAgentMissionStarted(...args),
    markRoomAgentMissionFinished: (...args: Parameters<typeof activityHandlers.markRoomAgentMissionFinished>) => activityHandlers.markRoomAgentMissionFinished(...args),
    markRoomAgentMissionContinued: (...args: Parameters<typeof activityHandlers.markRoomAgentMissionContinued>) => activityHandlers.markRoomAgentMissionContinued(...args),
    settleRoomAgentBackgroundMission: (...args: Parameters<typeof activityHandlers.settleRoomAgentBackgroundMission>) => activityHandlers.settleRoomAgentBackgroundMission(...args),
    runRoomAgentBackgroundAction: (...args: Parameters<typeof activityHandlers.runRoomAgentBackgroundAction>) => activityHandlers.runRoomAgentBackgroundAction(...args),
    failRoomAgentBackgroundAction: (...args: Parameters<typeof activityHandlers.failRoomAgentBackgroundAction>) => activityHandlers.failRoomAgentBackgroundAction(...args),
  };

  const maintenanceActivities = {
    refreshMemoryGraphSnapshot: (...args: Parameters<typeof activityHandlers.refreshMemoryGraphSnapshot>) => activityHandlers.refreshMemoryGraphSnapshot(...args),
    refreshAllMonthsMemoryGraphSnapshot: (...args: Parameters<typeof activityHandlers.refreshAllMonthsMemoryGraphSnapshot>) => activityHandlers.refreshAllMonthsMemoryGraphSnapshot(...args),
    reconcileStaleSpaceAgentSessions: (...args: Parameters<typeof activityHandlers.reconcileStaleSpaceAgentSessions>) => activityHandlers.reconcileStaleSpaceAgentSessions(...args),
    createScheduledMemoryAudit: (...args: Parameters<typeof activityHandlers.createScheduledMemoryAudit>) => activityHandlers.createScheduledMemoryAudit(...args),
    prepareMemoryConsolidation: (...args: Parameters<typeof activityHandlers.prepareMemoryConsolidation>) => activityHandlers.prepareMemoryConsolidation(...args),
    finalizeMemoryRepair: (...args: Parameters<typeof activityHandlers.finalizeMemoryRepair>) => activityHandlers.finalizeMemoryRepair(...args),
    executePersistedMemoryChangeSet: (...args: Parameters<typeof activityHandlers.executePersistedMemoryChangeSet>) => activityHandlers.executePersistedMemoryChangeSet(...args),
  };

  const mutationActivities = {
    executePersistedMemoryChangeSet: (...args: Parameters<typeof activityHandlers.executePersistedMemoryChangeSet>) => activityHandlers.executePersistedMemoryChangeSet(...args),
  };

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();

    mainWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: DEFAULT_TASK_QUEUE,
      workflowsPath: MAIN_WORKFLOWS_PATH,
      activities: mainActivities,
      maxHeartbeatThrottleInterval: "50ms",
      defaultHeartbeatThrottleInterval: "50ms"
    });

    prePatchWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: PRE_PATCH_TASK_QUEUE,
      workflowsPath: MAIN_WORKFLOWS_PATH,
      patchActivationCallback: () => false,
      activities: mainActivities,
      maxHeartbeatThrottleInterval: "50ms",
      defaultHeartbeatThrottleInterval: "50ms"
    });

    memoryMaintenanceWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: MEMORY_MAINTENANCE_WORKFLOWS_PATH,
      activities: maintenanceActivities
    });

    memoryMutationWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: MEMORY_MUTATION_WORKFLOWS_PATH,
      activities: mutationActivities
    });

    workersPromise = Promise.all([
      mainWorker.run(),
      prePatchWorker.run(),
      memoryMaintenanceWorker.run(),
      memoryMutationWorker.run()
    ]);
  });

  afterAll(async () => {
    mainWorker?.shutdown();
    prePatchWorker?.shutdown();
    memoryMaintenanceWorker?.shutdown();
    memoryMutationWorker?.shutdown();
    if (workersPromise) {
      await workersPromise;
    }
    if (env) {
      await env.teardown();
    }
  });

  afterEach(async () => {
    stopActivity = true;
    stopLegacyActivity = true;
    try {
      const open = await env.client.workflowService.listOpenWorkflowExecutions({
        namespace: env.namespace
      });
      for (const exec of open.executions ?? []) {
        if (exec.execution?.workflowId) {
          await env.client.workflow
            .getHandle(exec.execution.workflowId)
            .terminate()
            .catch(() => {});
        }
      }
    } catch {}
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stopActivity = false;
    stopLegacyActivity = false;

    activityHandlers.dotGoalStep.mockImplementation(async (goalId: string) => ({
      state: "DONE",
      runId: null,
      goalStatus: "COMPLETED"
    }));
    activityHandlers.dotGoalObserve.mockImplementation(async (goalId: string, runId: string) => ({
      run: "COMPLETED",
      goalStatus: "COMPLETED"
    }));
    activityHandlers.recordDummyTurnStarted.mockImplementation(async (input: DummyTurnInput) => ({
      workflowId: `wf:${input.agentRunId ?? "dummy"}`
    }));
    activityHandlers.recordDummyTurnCompleted.mockImplementation(async (input: DummyTurnInput) => ({
      status: "COMPLETED",
      message: "Dummy turn completed."
    }));
    activityHandlers.runOpenCodeAgentTurn.mockImplementation(async (input: DummyTurnInput) => ({
      status: "COMPLETED",
      message: "OpenCode turn completed."
    }));
    activityHandlers.runCliAgentTurn.mockImplementation(async (input: DummyTurnInput) => ({
      status: "COMPLETED",
      message: "CLI turn completed."
    }));
    activityHandlers.runCodexAppServerTurn.mockImplementation(async (input: DummyTurnInput) => ({
      status: "COMPLETED",
      message: "Codex turn completed.",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 1,
        statusReason: "Verified action."
      }
    }));
    activityHandlers.checkRoomAgentSupervisorTurn.mockImplementation(async () => "ACTIVE");
    activityHandlers.prepareRoomAgentBackgroundContinuation.mockImplementation(async () => ({ state: "DONE" }));
    activityHandlers.discardRoomAgentSupervisorTurn.mockImplementation(async () => undefined);
    activityHandlers.finishRoomAgentSupervisorTurn.mockImplementation(async () => undefined);
    activityHandlers.markRoomAgentMissionStarted.mockImplementation(async () => undefined);
    activityHandlers.markRoomAgentMissionFinished.mockImplementation(async () => undefined);
    activityHandlers.markRoomAgentMissionContinued.mockImplementation(async () => undefined);
    activityHandlers.settleRoomAgentBackgroundMission.mockImplementation(async () => true);
    activityHandlers.runRoomAgentBackgroundAction.mockImplementation(async (input) => ({
      status: "COMPLETED",
      actionId: input.actionId ?? "act:sandbox-default"
    }));
    activityHandlers.failRoomAgentBackgroundAction.mockImplementation(async () => undefined);
    activityHandlers.refreshMemoryGraphSnapshot.mockImplementation(async () => ({
      snapshotId: "snapshot:live",
      sourceHash: "hash:source-123"
    }));
    activityHandlers.refreshAllMonthsMemoryGraphSnapshot.mockImplementation(async () => ({
      snapshotId: "snapshot:all-months"
    }));
    activityHandlers.reconcileStaleSpaceAgentSessions.mockImplementation(async () => ({ reconciledCount: 0 }));
    activityHandlers.createScheduledMemoryAudit.mockImplementation(async () => ({
      id: "audit:run-1",
      workflowId: `wf:audit-${Date.now()}`
    }));
    activityHandlers.prepareMemoryConsolidation.mockImplementation(async (input: any) => ({
      run: { id: input.runId, status: "PREPARED" },
      changeSetId: null
    }));
    activityHandlers.finalizeMemoryRepair.mockImplementation(async (input: any) => ({
      id: input.runId,
      status: "COMPLETED",
      changeSetId: input.changeSetId,
      mutationResult: input.mutationResult
    }));
    activityHandlers.executePersistedMemoryChangeSet.mockImplementation(async (input: any) => ({
      status: "APPLIED",
      appliedCount: 1,
      changeSetId: input.changeSetId
    }));
  });

  describe("1. dotGoalWorkflow", () => {
    it("returns goal status as soon as API reports DONE", async () => {
      activityHandlers.dotGoalStep.mockResolvedValueOnce({
        state: "DONE",
        runId: null,
        goalStatus: "SUCCEEDED"
      });

      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-dot-goal-done-${Date.now()}`,
        args: [{ goalId: "goal:immediate-done" }]
      });

      const result = await handle.result();
      expect(result).toEqual({ goalStatus: "SUCCEEDED" });
      expect(activityHandlers.dotGoalStep).toHaveBeenCalledWith("goal:immediate-done");
    });

    it("wakes on DOT_GOAL_SIGNAL before the 30s polling timeout", async () => {
      let callCount = 0;
      activityHandlers.dotGoalStep.mockImplementation(async (goalId: string) => {
        callCount++;
        if (callCount === 1) {
          return { state: "WAITING", runId: null, goalStatus: "WAITING" };
        }
        return { state: "DONE", runId: null, goalStatus: "WOKEN_DONE" };
      });

      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-dot-goal-wake-${Date.now()}`,
        args: [{ goalId: "goal:wake-test" }]
      });

      // Workflow enters wait condition; wake it up with the signal
      await handle.signal(DOT_GOAL_SIGNAL);

      const result = await handle.result();
      expect(result).toEqual({ goalStatus: "WOKEN_DONE" });
      expect(callCount).toBe(2);
    });

    it("continues as new when the loop reports the goal is still unfinished", async () => {
      let stepCalls = 0;
      activityHandlers.dotGoalStep.mockImplementation(async () => {
        stepCalls++;
        if (stepCalls <= 300) {
          return { state: "WAITING", runId: null, goalStatus: "WAITING" };
        }
        return { state: "DONE", runId: null, goalStatus: "DONE_AFTER_CAN" };
      });

      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-dot-goal-can-${Date.now()}`,
        args: [{ goalId: "goal:can-test" }]
      });

      const result = await handle.result();
      expect(result).toEqual({ goalStatus: "DONE_AFTER_CAN" });
      expect(stepCalls).toBe(301);
    });

    it("polls dotGoalObserve until the agent run is no longer QUEUED or RUNNING", async () => {
      let stepCalls = 0;
      activityHandlers.dotGoalStep.mockImplementation(async (goalId: string) => {
        stepCalls++;
        if (stepCalls === 1) {
          return { state: "STARTED", runId: "run:active-42", goalStatus: "IN_PROGRESS" };
        }
        return { state: "DONE", runId: null, goalStatus: "ALL_OBSERVED_DONE" };
      });

      let observeCalls = 0;
      activityHandlers.dotGoalObserve.mockImplementation(async (goalId: string, runId: string) => {
        observeCalls++;
        if (observeCalls === 1) return { run: "QUEUED", goalStatus: "IN_PROGRESS" };
        if (observeCalls === 2) return { run: "RUNNING", goalStatus: "IN_PROGRESS" };
        return { run: "SUCCEEDED", goalStatus: "IN_PROGRESS" };
      });

      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-dot-goal-observe-${Date.now()}`,
        args: [{ goalId: "goal:observe-test" }]
      });

      const result = await handle.result();
      expect(result).toEqual({ goalStatus: "ALL_OBSERVED_DONE" });
      expect(observeCalls).toBe(3);
      expect(activityHandlers.dotGoalObserve).toHaveBeenCalledWith("goal:observe-test", "run:active-42");
    });
  });

  describe("2. roomAgentSupervisorWorkflow", () => {
    describe("A. Current branch (patched('room-background-continuation-v1') === true)", () => {
      it("runs a queued turn through child workflow", async () => {
        const item = createQueueItem("agent_run:turn-ok-1", "mission:turn-ok-1", "room:sandbox-sup");
        let finished = false;
        activityHandlers.finishRoomAgentSupervisorTurn.mockImplementationOnce(async () => {
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-normal-${Date.now()}`,
          args: [{ roomId: "room:sandbox-sup", pending: [item] }]
        });

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(activityHandlers.checkRoomAgentSupervisorTurn).toHaveBeenCalledWith(item);
        expect(activityHandlers.runCodexAppServerTurn).toHaveBeenCalledWith(item.turn);
        expect(activityHandlers.finishRoomAgentSupervisorTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            item,
            status: "COMPLETED",
            statusReason: "Verified action."
          })
        );

        await terminateWorkflow(handle.workflowId);
      });

      it("handles enqueue signal while idle", async () => {
        let finished = false;
        activityHandlers.finishRoomAgentSupervisorTurn.mockImplementationOnce(async () => {
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-idle-enqueue-${Date.now()}`,
          args: [{ roomId: "room:sandbox-sup", pending: [] }]
        });

        const item = createQueueItem("agent_run:turn-enq-1", "mission:turn-enq-1", "room:sandbox-sup");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(activityHandlers.checkRoomAgentSupervisorTurn).toHaveBeenCalledWith(item);
        expect(activityHandlers.finishRoomAgentSupervisorTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            item,
            status: "COMPLETED"
          })
        );

        await terminateWorkflow(handle.workflowId);
      });

      it("handles stop signal while idle vs interrupting an active running mission", async () => {
        // Part 1: Stop while idle does not fail the supervisor
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-stop-idle-${Date.now()}`,
          args: [{ roomId: "room:sandbox-sup", pending: [] }]
        });

        await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
          missionId: "mission:nonexistent",
          reason: "Stop while idle."
        });

        // Part 2: Interrupting an active running mission
        let turnStarted = false;
        let finished = false;
        let finishedPayload: any = null;
        let discardedPayload: any = null;
        let triggerCancel: () => void = () => {};
        const cancelPromise = new Promise<void>((resolve) => {
          triggerCancel = resolve;
        });

        activityHandlers.runCodexAppServerTurn.mockImplementationOnce(async () => {
          turnStarted = true;
          await cancelPromise;
          throw new CancelledFailure("Activity was cancelled");
        });

        activityHandlers.discardRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          discardedPayload = args;
        });
        activityHandlers.finishRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          finishedPayload = args;
          finished = true;
        });

        const item = createQueueItem("agent_run:turn-stop-act", "mission:stop-act", "room:sandbox-sup");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);

        while (!turnStarted) {
          await new Promise((r) => setTimeout(r, 20));
        }

        await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
          missionId: "mission:stop-act",
          reason: "Operator aborted the mission."
        });
        triggerCancel();

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(discardedPayload).toEqual(
          expect.objectContaining({
            item,
            reason: "Operator aborted the mission."
          })
        );
        expect(finishedPayload).toEqual(
          expect.objectContaining({
            item,
            status: "INTERRUPTED",
            statusReason: "Operator aborted the mission."
          })
        );

        const childHandle = env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(item.turn));
        await childHandle.result().catch(() => {});

        await terminateWorkflow(handle.workflowId);
      });

      it("discards turn carried in interrupted list and finishes as INTERRUPTED", async () => {
        const item = createQueueItem("agent_run:carried-int-1", "mission:carried-int-1", "room:sandbox-sup");
        let finished = false;
        let discardedPayload: any = null;
        let finishedPayload: any = null;

        activityHandlers.discardRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          discardedPayload = args;
        });
        activityHandlers.finishRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          finishedPayload = args;
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-carried-int-${Date.now()}`,
          args: [{
            roomId: "room:sandbox-sup",
            pending: [],
            interrupted: [{ item, reason: "Halted prior to restart." }]
          }]
        });

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(discardedPayload).toEqual({
          item,
          reason: "Halted prior to restart."
        });
        expect(finishedPayload).toEqual({
          item,
          status: "INTERRUPTED",
          statusReason: "Halted prior to restart."
        });
        expect(activityHandlers.runCodexAppServerTurn).not.toHaveBeenCalled();

        await terminateWorkflow(handle.workflowId);
      });

      it("skips a turn the API reports as no longer active (SKIP)", async () => {
        const item = createQueueItem("agent_run:turn-skip-1", "mission:turn-skip-1", "room:sandbox-sup");
        activityHandlers.checkRoomAgentSupervisorTurn.mockResolvedValueOnce("SKIP");
        let discarded = false;
        let discardedPayload: any = null;
        activityHandlers.discardRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          discardedPayload = args;
          discarded = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-skip-${Date.now()}`,
          args: [{ roomId: "room:sandbox-sup", pending: [item] }]
        });

        while (!discarded) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(discardedPayload).toEqual({
          item,
          reason: "Turn is no longer active or was superseded."
        });
        expect(activityHandlers.runCodexAppServerTurn).not.toHaveBeenCalled();

        await terminateWorkflow(handle.workflowId);
      });

      it("records a failed turn with ROOM_AGENT_SUPERVISOR_FAILED code", async () => {
        const item = createQueueItem("agent_run:turn-fail-1", "mission:turn-fail-1", "room:sandbox-sup");
        activityHandlers.runCodexAppServerTurn.mockRejectedValueOnce(
          ApplicationFailure.create({ message: "Engine execution crashed.", nonRetryable: true })
        );

        let finished = false;
        let finishedPayload: any = null;
        let discardedPayload: any = null;

        activityHandlers.discardRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          discardedPayload = args;
        });
        activityHandlers.finishRoomAgentSupervisorTurn.mockImplementationOnce(async (args) => {
          finishedPayload = args;
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-failed-turn-${Date.now()}`,
          args: [{ roomId: "room:sandbox-sup", pending: [item] }]
        });

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(discardedPayload).toEqual({
          item,
          reason: "Room Agent supervisor turn failed.",
          errorCode: "ROOM_AGENT_SUPERVISOR_FAILED"
        });
        expect(finishedPayload).toEqual({
          item,
          status: "FAILED",
          statusReason: "Room Agent supervisor turn failed.",
          errorCode: "ROOM_AGENT_SUPERVISOR_FAILED"
        });

        await terminateWorkflow(handle.workflowId);
      });

      it("executes 1-second condition polling loop with monitoringMissionIds", async () => {
        let prepared = false;
        activityHandlers.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async () => {
          prepared = true;
          return { state: "DONE" as const };
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-poll-loop-${Date.now()}`,
          args: [{
            roomId: "room:sandbox-sup",
            pending: [],
            monitoringMissionIds: ["mission:poll-loop-1"]
          }]
        });

        while (!prepared) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(activityHandlers.prepareRoomAgentBackgroundContinuation).toHaveBeenCalledWith(
          expect.objectContaining({
            roomId: "room:sandbox-sup",
            missionId: "mission:poll-loop-1"
          })
        );

        await terminateWorkflow(handle.workflowId);
      });

      it("continues as new after 50 processed items with carried state intact", async () => {
        const item1 = createQueueItem("agent_run:sup-can-1", "mission:sup-can-1", "room:sandbox-sup");
        const item2 = createQueueItem("agent_run:sup-can-2", "mission:sup-can-2", "room:sandbox-sup");

        activityHandlers.checkRoomAgentSupervisorTurn.mockResolvedValue("SKIP");

        let processedCheckCount = 0;
        activityHandlers.discardRoomAgentSupervisorTurn.mockImplementation(async () => {
          processedCheckCount++;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-can-50-${Date.now()}`,
          args: [{
            roomId: "room:sandbox-sup",
            pending: [item1, item2],
            processedCount: 49,
            monitoringMissionIds: ["mission:carried-mon-1"]
          }]
        });

        const initialRunId = handle.firstExecutionRunId;

        while (processedCheckCount < 2) {
          await new Promise((r) => setTimeout(r, 20));
        }

        await new Promise((r) => setTimeout(r, 50));

        const desc = await handle.describe();
        expect(desc.runId).not.toBe(initialRunId);
        expect(processedCheckCount).toBe(2);

        await terminateWorkflow(handle.workflowId, desc.runId);
      });

      it("continues as new after 250 monitoring polls with carried state intact", async () => {
        let pollsCount = 0;
        activityHandlers.prepareRoomAgentBackgroundContinuation.mockImplementation(async () => {
          pollsCount++;
          return { state: "WAITING" as const };
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: `test-sup-can-250-polls-${Date.now()}`,
          args: [{
            roomId: "room:sandbox-sup",
            pending: [],
            monitoringMissionIds: ["mission:poll-can-250"]
          }]
        });

        const initialRunId = handle.firstExecutionRunId;
        await env.sleep("260s");

        expect(pollsCount).toBeGreaterThanOrEqual(250);
        const desc = await handle.describe();
        expect(desc.runId).not.toBe(initialRunId);

        await terminateWorkflow(handle.workflowId, desc.runId);
      });
    });

    describe("B. Pre-patch branch (legacyRoomAgentSupervisorWorkflow)", () => {
      it("runs a queued turn through child workflow", async () => {
        const item = createQueueItem("agent_run:legacy-turn-1", "mission:legacy-1", "room:legacy-sup");
        let finished = false;

        activityHandlers.markRoomAgentMissionFinished.mockImplementationOnce(async () => {
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: PRE_PATCH_TASK_QUEUE,
          workflowId: `test-legacy-turn-${Date.now()}`,
          args: [{ roomId: "room:legacy-sup", pending: [item] }]
        });

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(activityHandlers.markRoomAgentMissionStarted).toHaveBeenCalledWith({
          missionId: "mission:legacy-1",
          roomId: "room:legacy-sup",
          paneId: "pane:sandbox-1"
        });
        expect(activityHandlers.runCodexAppServerTurn).toHaveBeenCalledWith(item.turn);
        expect(activityHandlers.markRoomAgentMissionFinished).toHaveBeenCalledWith(
          expect.objectContaining({
            missionId: "mission:legacy-1",
            roomId: "room:legacy-sup",
            status: "COMPLETED",
            statusReason: "Verified action."
          })
        );

        await terminateWorkflow(handle.workflowId);
      });

      it("handles enqueue signal", async () => {
        let finished = false;
        activityHandlers.markRoomAgentMissionFinished.mockImplementationOnce(async () => {
          finished = true;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: PRE_PATCH_TASK_QUEUE,
          workflowId: `test-legacy-enq-${Date.now()}`,
          args: [{ roomId: "room:legacy-sup", pending: [] }]
        });

        const item = createQueueItem("agent_run:legacy-enq-1", "mission:legacy-enq-1", "room:legacy-sup");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(activityHandlers.markRoomAgentMissionStarted).toHaveBeenCalled();
        expect(activityHandlers.markRoomAgentMissionFinished).toHaveBeenCalledWith(
          expect.objectContaining({
            missionId: "mission:legacy-enq-1",
            roomId: "room:legacy-sup",
            status: "COMPLETED"
          })
        );

        await terminateWorkflow(handle.workflowId);
      });

      it("handles stop signal (interruption)", async () => {
        let turnStarted = false;
        let finished = false;
        let finishedPayload: any = null;
        let triggerLegacyCancel: () => void = () => {};
        const cancelLegacyPromise = new Promise<void>((resolve) => {
          triggerLegacyCancel = resolve;
        });

        activityHandlers.runCodexAppServerTurn.mockImplementationOnce(async () => {
          turnStarted = true;
          await cancelLegacyPromise;
          throw new CancelledFailure("Activity was cancelled");
        });

        activityHandlers.markRoomAgentMissionFinished.mockImplementationOnce(async (args) => {
          finishedPayload = args;
          finished = true;
        });

        const item = createQueueItem("agent_run:legacy-stop-act", "mission:legacy-stop", "room:legacy-sup");
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: PRE_PATCH_TASK_QUEUE,
          workflowId: `test-legacy-stop-${Date.now()}`,
          args: [{ roomId: "room:legacy-sup", pending: [item] }]
        });

        while (!turnStarted) {
          await new Promise((r) => setTimeout(r, 20));
        }

        await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
          missionId: "mission:legacy-stop",
          reason: "Operator stopped legacy mission."
        });
        triggerLegacyCancel();

        while (!finished) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(finishedPayload).toEqual({
          missionId: "mission:legacy-stop",
          roomId: "room:legacy-sup",
          status: "INTERRUPTED",
          statusReason: "Operator stopped legacy mission."
        });

        const legacyChildHandle = env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(item.turn));
        await legacyChildHandle.result().catch(() => {});

        await terminateWorkflow(handle.workflowId);
      });

      it("continues as new at 50 items", async () => {
        const item1 = createQueueItem("agent_run:leg-can-1", "mission:leg-can-1", "room:legacy-sup");
        const item2 = createQueueItem("agent_run:leg-can-2", "mission:leg-can-2", "room:legacy-sup");

        let finishCount = 0;
        activityHandlers.markRoomAgentMissionFinished.mockImplementation(async () => {
          finishCount++;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: PRE_PATCH_TASK_QUEUE,
          workflowId: `test-legacy-can-50-${Date.now()}`,
          args: [{
            roomId: "room:legacy-sup",
            pending: [item1, item2],
            processedCount: 49,
            monitoringMissionIds: ["mission:leg-carried-mon"]
          }]
        });

        const initialRunId = handle.firstExecutionRunId;

        while (finishCount < 2) {
          await new Promise((r) => setTimeout(r, 20));
        }

        await new Promise((r) => setTimeout(r, 50));

        const desc = await handle.describe();
        expect(desc.runId).not.toBe(initialRunId);
        expect(finishCount).toBe(2);

        await terminateWorkflow(handle.workflowId, desc.runId);
      });

      it("continues as new at 250 polls with settleRoomAgentBackgroundMission activity calls", async () => {
        let settleCalls = 0;
        activityHandlers.settleRoomAgentBackgroundMission.mockImplementation(async () => {
          settleCalls++;
          return false;
        });

        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          taskQueue: PRE_PATCH_TASK_QUEUE,
          workflowId: `test-legacy-can-250-polls-${Date.now()}`,
          args: [{
            roomId: "room:legacy-sup",
            pending: [],
            monitoringMissionIds: ["mission:legacy-poll-mon"]
          }]
        });

        const initialRunId = handle.firstExecutionRunId;

        // Advance virtual time by 260s
        await env.sleep("260s");

        expect(settleCalls).toBeGreaterThanOrEqual(250);
        const desc = await handle.describe();
        expect(desc.runId).not.toBe(initialRunId);

        await terminateWorkflow(handle.workflowId, desc.runId);
      });
    });
  });

  describe("3. roomAgentActionWorkflow", () => {
    it("returns background action result on success", async () => {
      activityHandlers.runRoomAgentBackgroundAction.mockResolvedValueOnce({
        status: "COMPLETED",
        actionId: "act:success-1"
      });

      const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-action-ok-${Date.now()}`,
        args: [{
          bridge: { roomId: "room:action-ok", missionId: "mission:action-ok" } as any,
          actionId: "act:success-1"
        }]
      });

      const result = await handle.result();
      expect(result).toEqual({ status: "COMPLETED", actionId: "act:success-1" });
      expect(activityHandlers.failRoomAgentBackgroundAction).not.toHaveBeenCalled();
    });

    it("persists failure through patched failRoomAgentBackgroundAction activity and rethrows error on failure", async () => {
      activityHandlers.runRoomAgentBackgroundAction.mockRejectedValueOnce(
        ApplicationFailure.create({ message: "Action transport failed.", nonRetryable: true })
      );

      const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-action-fail-${Date.now()}`,
        args: [{
          bridge: { roomId: "room:action-fail", missionId: "mission:action-fail" } as any,
          actionId: "act:failed-1"
        }]
      });

      await expect(handle.result()).rejects.toThrow(WorkflowFailedError);

      expect(activityHandlers.failRoomAgentBackgroundAction).toHaveBeenCalledWith({
        roomId: "room:action-fail",
        missionId: "mission:action-fail",
        actionId: "act:failed-1",
        cancelled: false
      });
    });
  });

  describe("4. memoryMaintenanceWorkflow", () => {
    it("runs normal cycle with memoryConsolidationWorkflow as real child workflow", async () => {
      activityHandlers.refreshMemoryGraphSnapshot.mockResolvedValueOnce({
        snapshotId: "snapshot:normal",
        sourceHash: "hash:normal-1"
      });
      activityHandlers.createScheduledMemoryAudit.mockResolvedValueOnce({
        id: "audit:run-child",
        workflowId: `wf:audit-child-${Date.now()}`
      });

      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: `test-maint-normal-${Date.now()}`,
        args: [{ scheduledAt: new Date().toISOString(), traceId: "trace:maint-normal" }]
      });

      const result = await handle.result();
      expect(result).toEqual({
        snapshotId: "snapshot:normal",
        sourceHash: "hash:normal-1"
      });

      expect(activityHandlers.refreshMemoryGraphSnapshot).toHaveBeenCalled();
      expect(activityHandlers.refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalled();
      expect(activityHandlers.reconcileStaleSpaceAgentSessions).toHaveBeenCalled();
      expect(activityHandlers.createScheduledMemoryAudit).toHaveBeenCalled();
      expect(activityHandlers.prepareMemoryConsolidation).toHaveBeenCalledWith({
        runId: "audit:run-child",
        traceId: "trace:maint-normal"
      });
    });

    it("continues when all-months refresh and session reconciliation both fail", async () => {
      activityHandlers.refreshAllMonthsMemoryGraphSnapshot.mockRejectedValueOnce(
        ApplicationFailure.create({ message: "All-months refresh error.", nonRetryable: true })
      );
      activityHandlers.reconcileStaleSpaceAgentSessions.mockRejectedValueOnce(
        ApplicationFailure.create({ message: "Session reconciliation error.", nonRetryable: true })
      );
      activityHandlers.refreshMemoryGraphSnapshot.mockResolvedValueOnce({
        snapshotId: "snapshot:resilient",
        sourceHash: "hash:resilient-1"
      });
      activityHandlers.createScheduledMemoryAudit.mockResolvedValueOnce({
        id: "audit:run-resilient",
        workflowId: `wf:audit-resilient-${Date.now()}`
      });

      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: `test-maint-resilient-${Date.now()}`,
        args: [{ scheduledAt: new Date().toISOString(), traceId: "trace:maint-resilient" }]
      });

      const result = await handle.result();
      expect(result).toEqual({
        snapshotId: "snapshot:resilient",
        sourceHash: "hash:resilient-1"
      });
      expect(activityHandlers.prepareMemoryConsolidation).toHaveBeenCalledWith({
        runId: "audit:run-resilient",
        traceId: "trace:maint-resilient"
      });
    });

    it("fails when live snapshot refresh fails", async () => {
      activityHandlers.refreshMemoryGraphSnapshot.mockRejectedValueOnce(
        ApplicationFailure.create({ message: "Live snapshot error.", nonRetryable: true })
      );

      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: `test-maint-fail-${Date.now()}`,
        args: [{ scheduledAt: new Date().toISOString(), traceId: "trace:maint-fail" }]
      });

      await expect(handle.result()).rejects.toThrow(WorkflowFailedError);
      expect(activityHandlers.createScheduledMemoryAudit).not.toHaveBeenCalled();
    });
  });

  describe("5. memoryConsolidationWorkflow", () => {
    it("returns prepared run without mutating when no change set", async () => {
      activityHandlers.prepareMemoryConsolidation.mockResolvedValueOnce({
        run: { id: "audit:run-clean", status: "CLEAN" },
        changeSetId: null
      });

      const handle = await env.client.workflow.start("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: `test-consolidation-no-cs-${Date.now()}`,
        args: [{ runId: "audit:run-clean", traceId: "trace:no-cs" }]
      });

      const result = await handle.result();
      expect(result).toEqual({ id: "audit:run-clean", status: "CLEAN" });
      expect(activityHandlers.executePersistedMemoryChangeSet).not.toHaveBeenCalled();
      expect(activityHandlers.finalizeMemoryRepair).not.toHaveBeenCalled();
    });

    it("executes and finalizes change set when audit produced one", async () => {
      activityHandlers.prepareMemoryConsolidation.mockResolvedValueOnce({
        run: { id: "audit:run-dirty", status: "PREPARED" },
        changeSetId: "cs:dirty-123"
      });
      activityHandlers.executePersistedMemoryChangeSet.mockResolvedValueOnce({
        status: "APPLIED",
        appliedCount: 3,
        changeSetId: "cs:dirty-123"
      });
      activityHandlers.finalizeMemoryRepair.mockResolvedValueOnce({
        id: "audit:run-dirty",
        status: "REPAIRED",
        changeSetId: "cs:dirty-123",
        mutationResult: { status: "APPLIED", appliedCount: 3, changeSetId: "cs:dirty-123" }
      });

      const handle = await env.client.workflow.start("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: `test-consolidation-with-cs-${Date.now()}`,
        args: [{ runId: "audit:run-dirty", traceId: "trace:with-cs" }]
      });

      const result = await handle.result();
      expect(result).toEqual({
        id: "audit:run-dirty",
        status: "REPAIRED",
        changeSetId: "cs:dirty-123",
        mutationResult: { status: "APPLIED", appliedCount: 3, changeSetId: "cs:dirty-123" }
      });
      expect(activityHandlers.executePersistedMemoryChangeSet).toHaveBeenCalledWith({
        changeSetId: "cs:dirty-123",
        traceId: "trace:with-cs"
      });
      expect(activityHandlers.finalizeMemoryRepair).toHaveBeenCalledWith({
        runId: "audit:run-dirty",
        changeSetId: "cs:dirty-123",
        mutationResult: { status: "APPLIED", appliedCount: 3, changeSetId: "cs:dirty-123" }
      });
    });
  });

  describe("6. memoryMutationWorkflow", () => {
    it("executes persisted change set", async () => {
      activityHandlers.executePersistedMemoryChangeSet.mockResolvedValueOnce({
        status: "APPLIED",
        appliedCount: 8,
        changeSetId: "cs:mutation-direct"
      });

      const handle = await env.client.workflow.start("memoryMutationWorkflow", {
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: `test-mutation-direct-${Date.now()}`,
        args: [{ changeSetId: "cs:mutation-direct", traceId: "trace:mutation-direct" }]
      });

      const result = await handle.result();
      expect(result).toEqual({
        status: "APPLIED",
        appliedCount: 8,
        changeSetId: "cs:mutation-direct"
      });
      expect(activityHandlers.executePersistedMemoryChangeSet).toHaveBeenCalledWith({
        changeSetId: "cs:mutation-direct",
        traceId: "trace:mutation-direct"
      });
    });
  });

  describe("7. dummyTurnWorkflow", () => {
    it("starts and completes dummy turn", async () => {
      const input: DummyTurnInput = {
        roomId: "room:sandbox-dummy",
        paneId: "pane:sandbox-dummy",
        prompt: "test dummy turn",
        agentRunId: "agent_run:dummy-test-1",
        traceId: "trace:dummy-test-1"
      };

      const handle = await env.client.workflow.start("dummyTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-dummy-${Date.now()}`,
        args: [input]
      });

      const result = await handle.result();
      expect(result).toEqual({
        status: "COMPLETED",
        message: "Dummy turn completed."
      });
      expect(activityHandlers.recordDummyTurnStarted).toHaveBeenCalledWith(input);
      expect(activityHandlers.recordDummyTurnCompleted).toHaveBeenCalledWith(input);
    });
  });

  describe("8. codexAppServerTurnWorkflow", () => {
    it("routes opencode provider to runOpenCodeAgentTurn", async () => {
      const input: DummyTurnInput = {
        roomId: "room:sandbox-providers",
        paneId: "pane:sandbox-providers",
        prompt: "opencode prompt",
        providerId: "opencode",
        agentRunId: "agent_run:opencode-1",
        traceId: "trace:opencode-1"
      };

      activityHandlers.runOpenCodeAgentTurn.mockResolvedValueOnce({
        status: "COMPLETED",
        message: "OpenCode success"
      });

      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-provider-opencode-${Date.now()}`,
        args: [input]
      });

      const result = await handle.result();
      expect(result).toEqual({ status: "COMPLETED", message: "OpenCode success" });
      expect(activityHandlers.runOpenCodeAgentTurn).toHaveBeenCalledWith(input);
      expect(activityHandlers.runCliAgentTurn).not.toHaveBeenCalled();
      expect(activityHandlers.runCodexAppServerTurn).not.toHaveBeenCalled();
    });

    it("routes CLI chat provider to runCliAgentTurn", async () => {
      const input: DummyTurnInput = {
        roomId: "room:sandbox-providers",
        paneId: "pane:sandbox-providers",
        prompt: "claude prompt",
        providerId: "cli:claude",
        agentRunId: "agent_run:cli-1",
        traceId: "trace:cli-1"
      };

      activityHandlers.runCliAgentTurn.mockResolvedValueOnce({
        status: "COMPLETED",
        message: "CLI Claude success"
      });

      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-provider-cli-${Date.now()}`,
        args: [input]
      });

      const result = await handle.result();
      expect(result).toEqual({ status: "COMPLETED", message: "CLI Claude success" });
      expect(activityHandlers.runCliAgentTurn).toHaveBeenCalledWith(input);
      expect(activityHandlers.runOpenCodeAgentTurn).not.toHaveBeenCalled();
      expect(activityHandlers.runCodexAppServerTurn).not.toHaveBeenCalled();
    });

    it("routes native / room turn to runCodexAppServerTurn", async () => {
      // Part A: Native chat turn (has agentSessionId and agentAssistantMessageId, without roomAgentMissionId)
      const nativeInput: DummyTurnInput = {
        roomId: "room:sandbox-native",
        paneId: "pane:sandbox-native",
        prompt: "native prompt",
        providerId: "codex",
        agentSessionId: "session:native-1",
        agentAssistantMessageId: "msg:assistant-1",
        agentRunId: "agent_run:native-1",
        traceId: "trace:native-1"
      };

      activityHandlers.runCodexAppServerTurn.mockResolvedValueOnce({
        status: "COMPLETED",
        message: "Native chat success"
      });

      const hNative = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-provider-native-${Date.now()}`,
        args: [nativeInput]
      });

      const nativeResult = await hNative.result();
      expect(nativeResult).toEqual({ status: "COMPLETED", message: "Native chat success" });
      expect(activityHandlers.runCodexAppServerTurn).toHaveBeenCalledWith(nativeInput);

      // Part B: Room agent turn (has roomAgentMissionId)
      const roomInput: DummyTurnInput = {
        roomId: "room:sandbox-room",
        paneId: "pane:sandbox-room",
        prompt: "room prompt",
        providerId: "codex",
        roomAgentMissionId: "mission:room-1",
        agentRunId: "agent_run:room-1",
        traceId: "trace:room-1"
      };

      activityHandlers.runCodexAppServerTurn.mockResolvedValueOnce({
        status: "COMPLETED",
        message: "Room agent turn success"
      });

      const hRoom = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-provider-room-${Date.now()}`,
        args: [roomInput]
      });

      const roomResult = await hRoom.result();
      expect(roomResult).toEqual({ status: "COMPLETED", message: "Room agent turn success" });
      expect(activityHandlers.runCodexAppServerTurn).toHaveBeenCalledWith(roomInput);
    });

    it("retries turn activity on failure and surfaces error", async () => {
      // Sub-case A: Retries transient failure and succeeds on attempt 2
      const retryInput: DummyTurnInput = {
        roomId: "room:sandbox-retry",
        paneId: "pane:sandbox-retry",
        prompt: "retry turn",
        providerId: "codex",
        agentRunId: "agent_run:retry-1",
        traceId: "trace:retry-1"
      };

      let attempt = 0;
      activityHandlers.runCodexAppServerTurn.mockImplementation(async () => {
        attempt++;
        if (attempt === 1) {
          throw ApplicationFailure.create({ message: "Network jitter." });
        }
        return {
          status: "COMPLETED",
          message: "Recovered after retry."
        };
      });

      const hRetry = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-turn-retry-success-${Date.now()}`,
        args: [retryInput]
      });

      const retryRes = await hRetry.result();
      expect(retryRes).toEqual({ status: "COMPLETED", message: "Recovered after retry." });
      expect(attempt).toBe(2);

      // Sub-case B: Non-retryable error surfaces immediately
      const fatalInput: DummyTurnInput = {
        roomId: "room:sandbox-fatal",
        paneId: "pane:sandbox-fatal",
        prompt: "fatal turn",
        providerId: "opencode",
        agentRunId: "agent_run:fatal-1",
        traceId: "trace:fatal-1"
      };

      activityHandlers.runOpenCodeAgentTurn.mockRejectedValueOnce(
        ApplicationFailure.create({ message: "Fatal token exhaustion.", nonRetryable: true })
      );

      const hFatal = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: `test-turn-fatal-${Date.now()}`,
        args: [fatalInput]
      });

      await expect(hFatal.result()).rejects.toThrow(WorkflowFailedError);
    });
  });
});
