import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/workflow";
import { Context } from "@temporalio/activity";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  DOT_GOAL_SIGNAL
} from "@space/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(__dirname, "../src/workflows.ts");
const maintenanceWorkflowsPath = resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const mutationWorkflowsPath = resolve(__dirname, "../src/memory-mutation-workflows.ts");

const DEFAULT_TASK_QUEUE = "space-agent-turns-test";
const LEGACY_TASK_QUEUE = "space-agent-turns-legacy-test";
const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
const MEMORY_MUTATION_TASK_QUEUE = "space-memory-mutations";

describe("Temporal Time-Skipping Workflow Sandbox", () => {
  let testEnv: TestWorkflowEnvironment;
  let defaultWorker: Worker;
  let legacyWorker: Worker;
  let maintenanceWorker: Worker;
  let mutationWorker: Worker;
  let workersRunPromise: Promise<void[]>;

  // Dynamic activity dispatch table
  const activityOverrides: Record<string, (...args: any[]) => any> = {};

  const defaultActivities = {
    recordDummyTurnStarted: async (...args: any[]) => {
      if (activityOverrides.recordDummyTurnStarted) return activityOverrides.recordDummyTurnStarted(...args);
    },
    recordDummyTurnCompleted: async (...args: any[]) => {
      if (activityOverrides.recordDummyTurnCompleted) return activityOverrides.recordDummyTurnCompleted(...args);
      return { status: "COMPLETED", message: "Turn completed successfully" };
    },
    runCodexAppServerTurn: async (...args: any[]) => {
      if (activityOverrides.runCodexAppServerTurn) return activityOverrides.runCodexAppServerTurn(...args);
      return { status: "COMPLETED", message: "Codex turn finished" };
    },
    runOpenCodeAgentTurn: async (...args: any[]) => {
      if (activityOverrides.runOpenCodeAgentTurn) return activityOverrides.runOpenCodeAgentTurn(...args);
      return { status: "COMPLETED", message: "OpenCode turn finished" };
    },
    runCliAgentTurn: async (...args: any[]) => {
      if (activityOverrides.runCliAgentTurn) return activityOverrides.runCliAgentTurn(...args);
      return { status: "COMPLETED", message: "CLI turn finished" };
    },
    markRoomAgentMissionStarted: async (...args: any[]) => {
      if (activityOverrides.markRoomAgentMissionStarted) return activityOverrides.markRoomAgentMissionStarted(...args);
    },
    markRoomAgentMissionFinished: async (...args: any[]) => {
      if (activityOverrides.markRoomAgentMissionFinished) return activityOverrides.markRoomAgentMissionFinished(...args);
    },
    markRoomAgentMissionContinued: async (...args: any[]) => {
      if (activityOverrides.markRoomAgentMissionContinued) return activityOverrides.markRoomAgentMissionContinued(...args);
    },
    dotGoalStep: async (...args: any[]) => {
      if (activityOverrides.dotGoalStep) return activityOverrides.dotGoalStep(...args);
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    },
    dotGoalObserve: async (...args: any[]) => {
      if (activityOverrides.dotGoalObserve) return activityOverrides.dotGoalObserve(...args);
      return { run: "SUCCEEDED", goalStatus: "COMPLETED" };
    },
    settleRoomAgentBackgroundMission: async (...args: any[]) => {
      if (activityOverrides.settleRoomAgentBackgroundMission) return activityOverrides.settleRoomAgentBackgroundMission(...args);
      return true;
    },
    discardRoomAgentSupervisorTurn: async (...args: any[]) => {
      if (activityOverrides.discardRoomAgentSupervisorTurn) return activityOverrides.discardRoomAgentSupervisorTurn(...args);
    },
    finishRoomAgentSupervisorTurn: async (...args: any[]) => {
      if (activityOverrides.finishRoomAgentSupervisorTurn) return activityOverrides.finishRoomAgentSupervisorTurn(...args);
    },
    checkRoomAgentSupervisorTurn: async (...args: any[]) => {
      if (activityOverrides.checkRoomAgentSupervisorTurn) return activityOverrides.checkRoomAgentSupervisorTurn(...args);
      return "READY";
    },
    prepareRoomAgentBackgroundContinuation: async (...args: any[]) => {
      if (activityOverrides.prepareRoomAgentBackgroundContinuation) return activityOverrides.prepareRoomAgentBackgroundContinuation(...args);
      return { state: "DONE" };
    },
    runRoomAgentBackgroundAction: async (...args: any[]) => {
      if (activityOverrides.runRoomAgentBackgroundAction) return activityOverrides.runRoomAgentBackgroundAction(...args);
      return { status: "COMPLETED", message: "Action succeeded" };
    },
    failRoomAgentBackgroundAction: async (...args: any[]) => {
      if (activityOverrides.failRoomAgentBackgroundAction) return activityOverrides.failRoomAgentBackgroundAction(...args);
    }
  };

  const maintenanceActivities = {
    refreshMemoryGraphSnapshot: async (...args: any[]) => {
      if (activityOverrides.refreshMemoryGraphSnapshot) return activityOverrides.refreshMemoryGraphSnapshot(...args);
      return { sourceHash: "hash-sandbox-default", refreshedAt: "2026-10-17T00:00:00Z" };
    },
    refreshAllMonthsMemoryGraphSnapshot: async (...args: any[]) => {
      if (activityOverrides.refreshAllMonthsMemoryGraphSnapshot) return activityOverrides.refreshAllMonthsMemoryGraphSnapshot(...args);
    },
    reconcileStaleSpaceAgentSessions: async (...args: any[]) => {
      if (activityOverrides.reconcileStaleSpaceAgentSessions) return activityOverrides.reconcileStaleSpaceAgentSessions(...args);
    },
    createScheduledMemoryAudit: async (...args: any[]) => {
      if (activityOverrides.createScheduledMemoryAudit) return activityOverrides.createScheduledMemoryAudit(...args);
      return { id: "audit:sandbox-1", workflowId: "memory-audit:sandbox-1" };
    },
    prepareMemoryConsolidation: async (...args: any[]) => {
      if (activityOverrides.prepareMemoryConsolidation) return activityOverrides.prepareMemoryConsolidation(...args);
      return { run: { id: "audit:sandbox-1", status: "COMPLETED" }, changeSetId: null };
    },
    finalizeMemoryRepair: async (...args: any[]) => {
      if (activityOverrides.finalizeMemoryRepair) return activityOverrides.finalizeMemoryRepair(...args);
      return { id: "audit:sandbox-1", status: "COMPLETED", changeSetId: null };
    }
  };

  const mutationActivities = {
    executePersistedMemoryChangeSet: async (...args: any[]) => {
      if (activityOverrides.executePersistedMemoryChangeSet) return activityOverrides.executePersistedMemoryChangeSet(...args);
      return { success: true, mutatedCount: 3 };
    }
  };

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();

    defaultWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: DEFAULT_TASK_QUEUE,
      workflowsPath,
      activities: defaultActivities
    });

    legacyWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: LEGACY_TASK_QUEUE,
      workflowsPath,
      activities: defaultActivities,
      patchActivationCallback: () => false
    });

    maintenanceWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: maintenanceWorkflowsPath,
      activities: maintenanceActivities
    });

    mutationWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: mutationWorkflowsPath,
      activities: mutationActivities
    });

    workersRunPromise = Promise.all([
      defaultWorker.run(),
      legacyWorker.run(),
      maintenanceWorker.run(),
      mutationWorker.run()
    ]);
  }, 60000);

  afterAll(async () => {
    defaultWorker?.shutdown();
    legacyWorker?.shutdown();
    maintenanceWorker?.shutdown();
    mutationWorker?.shutdown();
    await workersRunPromise;
    await testEnv?.teardown();
  });

  beforeEach(() => {
    for (const key of Object.keys(activityOverrides)) {
      delete activityOverrides[key];
    }
  });

  // --------------------------------------------------------------------------
  // 1. dummyTurnWorkflow
  // --------------------------------------------------------------------------
  describe("dummyTurnWorkflow", () => {
    it("records dummy turn started and completed, returning the activity result", async () => {
      const startedSpy = vi.fn();
      const completedSpy = vi.fn().mockResolvedValue({ status: "COMPLETED", message: "Dummy success" });
      activityOverrides.recordDummyTurnStarted = startedSpy;
      activityOverrides.recordDummyTurnCompleted = completedSpy;

      const input = {
        roomId: "room:sandbox-dummy",
        paneId: "pane:sandbox-dummy",
        prompt: "Run sandbox dummy turn",
        artifactIds: [],
        agentRunId: "agent_run:sandbox-dummy",
        permissionMode: null,
        collaborationMode: "default",
        traceId: "trace:sandbox-dummy"
      };

      const result = await testEnv.client.workflow.execute("dummyTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-dummy-turn-" + Date.now(),
        args: [input]
      });

      expect(result).toEqual({ status: "COMPLETED", message: "Dummy success" });
      expect(startedSpy).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: "agent_run:sandbox-dummy" }));
      expect(completedSpy).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: "agent_run:sandbox-dummy" }));
    });
  });

  // --------------------------------------------------------------------------
  // 2. codexAppServerTurnWorkflow
  // --------------------------------------------------------------------------
  describe("codexAppServerTurnWorkflow", () => {
    it("routes provider 'opencode' to openCodeAgentTurnActivities", async () => {
      const openCodeSpy = vi.fn().mockResolvedValue({ status: "COMPLETED", message: "OpenCode finished" });
      activityOverrides.runOpenCodeAgentTurn = openCodeSpy;

      const input = {
        roomId: "room:sandbox-opencode",
        paneId: "pane:sandbox-opencode",
        prompt: "OpenCode request",
        artifactIds: [],
        agentRunId: "agent_run:sandbox-opencode",
        permissionMode: null,
        collaborationMode: "default",
        traceId: "trace:sandbox-opencode",
        providerId: "opencode"
      };

      const result = await testEnv.client.workflow.execute("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-codex-opencode-" + Date.now(),
        args: [input]
      });

      expect(result).toEqual({ status: "COMPLETED", message: "OpenCode finished" });
      expect(openCodeSpy).toHaveBeenCalledWith(expect.objectContaining({ providerId: "opencode" }));
    });

    it("routes CLI chat providers to cliChatTurnActivities", async () => {
      const cliSpy = vi.fn().mockResolvedValue({ status: "COMPLETED", message: "CLI finished" });
      activityOverrides.runCliAgentTurn = cliSpy;

      const input = {
        roomId: "room:sandbox-cli",
        paneId: "pane:sandbox-cli",
        prompt: "CLI request",
        artifactIds: [],
        agentRunId: "agent_run:sandbox-cli",
        permissionMode: null,
        collaborationMode: "default",
        traceId: "trace:sandbox-cli",
        providerId: "cli:claude"
      };

      const result = await testEnv.client.workflow.execute("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-codex-cli-" + Date.now(),
        args: [input]
      });

      expect(result).toEqual({ status: "COMPLETED", message: "CLI finished" });
      expect(cliSpy).toHaveBeenCalledWith(expect.objectContaining({ providerId: "cli:claude" }));
    });

    it("retries activity on transient failure according to retry policy", async () => {
      let attempts = 0;
      activityOverrides.runCodexAppServerTurn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw ApplicationFailure.retryable("Temporary transport glitch");
        }
        return { status: "COMPLETED", message: "Recovered on attempt 2" };
      });

      const input = {
        roomId: "room:sandbox-retry",
        paneId: "pane:sandbox-retry",
        prompt: "Retry test prompt",
        artifactIds: [],
        agentRunId: "agent_run:sandbox-retry",
        permissionMode: null,
        collaborationMode: "default",
        traceId: "trace:sandbox-retry"
      };

      const result = await testEnv.client.workflow.execute("codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-codex-retry-" + Date.now(),
        args: [input]
      });

      expect(result).toEqual({ status: "COMPLETED", message: "Recovered on attempt 2" });
      expect(attempts).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 3. dotGoalWorkflow
  // --------------------------------------------------------------------------
  describe("dotGoalWorkflow", () => {
    it("completes immediately when first step is DONE", async () => {
      activityOverrides.dotGoalStep = vi.fn().mockResolvedValue({ state: "DONE", runId: null, goalStatus: "COMPLETED" });

      const result = await testEnv.client.workflow.execute("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-dot-goal-done-" + Date.now(),
        args: [{ goalId: "goal:sandbox-done" }]
      });

      expect(result).toEqual({ goalStatus: "COMPLETED" });
    });

    it("wakes up early via wake signal during condition wait", async () => {
      let stepCount = 0;
      activityOverrides.dotGoalStep = vi.fn().mockImplementation(async () => {
        stepCount++;
        if (stepCount === 1) {
          // Paused will enter 1 hour wait unless woken
          return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
        }
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });

      const handle = await testEnv.client.workflow.start("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-dot-goal-wake-" + Date.now(),
        args: [{ goalId: "goal:sandbox-wake" }]
      });

      // Send signal to wake the loop
      await handle.signal(DOT_GOAL_SIGNAL);
      const result = await handle.result();
      expect(result).toEqual({ goalStatus: "COMPLETED" });
      expect(stepCount).toBe(2);
    });

    it("advances through observe polls under time-skipping", async () => {
      let stepCount = 0;
      let observeCount = 0;

      activityOverrides.dotGoalStep = vi.fn().mockImplementation(async () => {
        stepCount++;
        if (stepCount === 1) {
          return { state: "RUNNING", runId: "run:step-1", goalStatus: "RUNNING" };
        }
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });

      activityOverrides.dotGoalObserve = vi.fn().mockImplementation(async () => {
        observeCount++;
        if (observeCount < 2) {
          return { run: "RUNNING", goalStatus: "RUNNING" };
        }
        return { run: "SUCCEEDED", goalStatus: "COMPLETED" };
      });

      const result = await testEnv.client.workflow.execute("dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-dot-goal-observe-" + Date.now(),
        args: [{ goalId: "goal:sandbox-observe" }]
      });

      expect(result).toEqual({ goalStatus: "COMPLETED" });
      expect(observeCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 4. roomAgentSupervisorWorkflow (Current Patched Branch)
  // --------------------------------------------------------------------------
  describe("roomAgentSupervisorWorkflow (Current Patched)", () => {
    it("processes an enqueued mission through check, child turn execution, and finish", async () => {
      const checkSpy = vi.fn().mockResolvedValue("READY");
      const finishSpy = vi.fn().mockResolvedValue(undefined);
      activityOverrides.checkRoomAgentSupervisorTurn = checkSpy;
      activityOverrides.finishRoomAgentSupervisorTurn = finishSpy;
      activityOverrides.runCodexAppServerTurn = vi.fn().mockResolvedValue({
        status: "COMPLETED",
        message: "Verified",
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified successfully." }
      });

      const roomId = "room:supervisor-patched-run";
      const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-sup-enqueue-" + Date.now(),
        args: [{
          roomId,
          pending: [],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 0
        }]
      });

      // Enqueue mission via signal
      const queueItem = {
        missionId: "mission:supervisor-p1",
        turn: {
          roomId,
          paneId: "pane:supervisor-p1",
          prompt: "Process supervisor turn",
          artifactIds: [],
          agentRunId: "agent_run:sup-p1",
          permissionMode: null,
          collaborationMode: "default",
          traceId: "trace:sup-p1"
        }
      };

      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem);

      // Give worker a moment to process item
      await testEnv.sleep("1s");

      expect(checkSpy).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission:supervisor-p1" }));
      expect(finishSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: "COMPLETED"
      }));

      // Terminate the open workflow
      await handle.terminate("Test completed");
    });

    it("cancels active child turn and marks mission INTERRUPTED when stop signal arrives", async () => {
      const discardSpy = vi.fn().mockResolvedValue(undefined);
      const finishSpy = vi.fn().mockResolvedValue(undefined);
      activityOverrides.discardRoomAgentSupervisorTurn = discardSpy;
      activityOverrides.finishRoomAgentSupervisorTurn = finishSpy;

      // Activity waits on Temporal cancellation signal
      activityOverrides.runCodexAppServerTurn = vi.fn().mockImplementation(async () => {
        const ctx = Context.current();
        const heartbeatInterval = setInterval(() => {
          try {
            ctx.heartbeat();
          } catch {
            // Heartbeat can fail if context is completed or cancelled
          }
        }, 100);
        try {
          await new Promise((_, reject) => {
            if (ctx.cancellationSignal.aborted) {
              reject(new Error("CANCELLED"));
              return;
            }
            ctx.cancellationSignal.addEventListener("abort", () => {
              reject(new Error("CANCELLED"));
            }, { once: true });
          });
        } finally {
          clearInterval(heartbeatInterval);
        }
        return { status: "COMPLETED", message: "Finished" };
      });

      const roomId = "room:supervisor-stop";
      const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-sup-stop-" + Date.now(),
        args: [{
          roomId,
          pending: [{
            missionId: "mission:supervisor-stop-1",
            turn: {
              roomId,
              paneId: "pane:supervisor-stop-1",
              prompt: "Long task to be cancelled",
              artifactIds: [],
              agentRunId: "agent_run:sup-stop-1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:sup-stop-1"
            }
          }],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 0
        }]
      });

      // Wait a moment for turn to start and become active
      await testEnv.sleep("1s");

      // Send stop signal while turn is actively running
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:supervisor-stop-1", reason: "Stopped by user" });

      await testEnv.sleep("1s");

      expect(discardSpy).toHaveBeenCalledWith(expect.objectContaining({
        reason: "Stopped by user"
      }));
      expect(finishSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: "INTERRUPTED",
        statusReason: "Stopped by user"
      }));

      await handle.terminate("Test completed");
    });

    it("triggers continueAsNew once 50 items are processed and carried state bounds hold", async () => {
      const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-sup-can-" + Date.now(),
        args: [{
          roomId: "room:sup-can-bounds",
          pending: [{
            missionId: "mission:sup-can-1",
            turn: {
              roomId: "room:sup-can-bounds",
              paneId: "pane:sup-can-1",
              prompt: "Turn 50 trigger",
              artifactIds: [],
              agentRunId: "agent_run:sup-can-1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:sup-can-1"
            }
          }],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 49
        }]
      });

      await testEnv.sleep("1s");

      const firstHandle = testEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await firstHandle.fetchHistory();
      const lastEvent = history.events[history.events.length - 1];

      // Last event of first run must be WorkflowExecutionContinuedAsNew
      expect([28, "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW"]).toContain(lastEvent.eventType);

      await handle.terminate("Test completed");
    });
  });

  // --------------------------------------------------------------------------
  // 5. roomAgentSupervisorWorkflow (Legacy Pre-Patch Branch)
  // --------------------------------------------------------------------------
  describe("roomAgentSupervisorWorkflow (Legacy Pre-Patch)", () => {
    it("executes the unpatched branch with settleRoomAgentBackgroundMission and continueAsNew", async () => {
      const settleSpy = vi.fn().mockResolvedValue(true);
      const startedSpy = vi.fn().mockResolvedValue(undefined);
      const finishedSpy = vi.fn().mockResolvedValue(undefined);
      activityOverrides.settleRoomAgentBackgroundMission = settleSpy;
      activityOverrides.markRoomAgentMissionStarted = startedSpy;
      activityOverrides.markRoomAgentMissionFinished = finishedSpy;

      const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: LEGACY_TASK_QUEUE,
        workflowId: "test-sup-legacy-" + Date.now(),
        args: [{
          roomId: "room:sup-legacy-run",
          pending: [{
            missionId: "mission:sup-legacy-1",
            turn: {
              roomId: "room:sup-legacy-run",
              paneId: "pane:sup-legacy-1",
              prompt: "Legacy turn",
              artifactIds: [],
              agentRunId: "agent_run:sup-legacy-1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:sup-legacy-1"
            }
          }],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 49
        }]
      });

      await testEnv.sleep("1s");

      expect(startedSpy).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission:sup-legacy-1" }));
      expect(finishedSpy).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission:sup-legacy-1" }));

      const firstHandle = testEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await firstHandle.fetchHistory();
      const lastEvent = history.events[history.events.length - 1];
      expect([28, "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW"]).toContain(lastEvent.eventType);

      await handle.terminate("Test completed");
    });
  });

  // --------------------------------------------------------------------------
  // 6. roomAgentActionWorkflow
  // --------------------------------------------------------------------------
  describe("roomAgentActionWorkflow", () => {
    it("returns activity result on normal execution", async () => {
      activityOverrides.runRoomAgentBackgroundAction = vi.fn().mockResolvedValue({
        status: "COMPLETED",
        message: "Background action OK"
      });

      const result = await testEnv.client.workflow.execute("roomAgentActionWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "test-action-ok-" + Date.now(),
        args: [{
          bridge: { roomId: "room:action-ok", missionId: "mission:action-ok" },
          actionId: "action:ok-1",
          traceId: "trace:action-ok"
        }]
      });

      expect(result).toEqual({ status: "COMPLETED", message: "Background action OK" });
    });

    it("calls failRoomAgentBackgroundAction under patched('room-background-action-failure-v1') when activity fails", async () => {
      const failSpy = vi.fn().mockResolvedValue(undefined);
      activityOverrides.failRoomAgentBackgroundAction = failSpy;
      activityOverrides.runRoomAgentBackgroundAction = vi.fn().mockRejectedValue(
        ApplicationFailure.nonRetryable("Action transport failed")
      );

      let caughtError: unknown;
      try {
        await testEnv.client.workflow.execute("roomAgentActionWorkflow", {
          taskQueue: DEFAULT_TASK_QUEUE,
          workflowId: "test-action-fail-" + Date.now(),
          args: [{
            bridge: { roomId: "room:action-fail", missionId: "mission:action-fail" },
            actionId: "action:fail-1",
            traceId: "trace:action-fail"
          }]
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect(failSpy).toHaveBeenCalledWith({
        roomId: "room:action-fail",
        missionId: "mission:action-fail",
        actionId: "action:fail-1",
        cancelled: false
      });
    });
  });

  // --------------------------------------------------------------------------
  // 7. memoryMaintenanceWorkflow
  // --------------------------------------------------------------------------
  describe("memoryMaintenanceWorkflow", () => {
    it("survives failures in refreshAllMonths and reconcileStaleSessions, still running child consolidation", async () => {
      activityOverrides.refreshMemoryGraphSnapshot = vi.fn().mockResolvedValue({
        sourceHash: "hash-resilience",
        refreshedAt: "2026-10-17T00:00:00Z"
      });
      activityOverrides.refreshAllMonthsMemoryGraphSnapshot = vi.fn().mockRejectedValue(
        ApplicationFailure.nonRetryable("All-months snapshot service unavailable")
      );
      activityOverrides.reconcileStaleSpaceAgentSessions = vi.fn().mockRejectedValue(
        ApplicationFailure.nonRetryable("Session reconciliation timed out")
      );

      const createAuditSpy = vi.fn().mockResolvedValue({ id: "audit:resilience", workflowId: "memory-audit:resilience" });
      const prepareConsolidationSpy = vi.fn().mockResolvedValue({
        run: { id: "audit:resilience", status: "COMPLETED" },
        changeSetId: null
      });

      activityOverrides.createScheduledMemoryAudit = createAuditSpy;
      activityOverrides.prepareMemoryConsolidation = prepareConsolidationSpy;

      const result = await testEnv.client.workflow.execute("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "test-maintenance-resilience-" + Date.now(),
        args: [{ traceId: "trace:maintenance-resilience", reason: "scheduled_audit" }]
      });

      expect(result).toEqual({ sourceHash: "hash-resilience", refreshedAt: "2026-10-17T00:00:00Z" });
      expect(createAuditSpy).toHaveBeenCalled();
      expect(prepareConsolidationSpy).toHaveBeenCalled();
    }, 15000);
  });

  // --------------------------------------------------------------------------
  // 8. memoryConsolidationWorkflow
  // --------------------------------------------------------------------------
  describe("memoryConsolidationWorkflow", () => {
    it("returns run immediately without mutation activity when changeSetId is empty", async () => {
      const prepareSpy = vi.fn().mockResolvedValue({
        run: { id: "audit:no-change", status: "COMPLETED" },
        changeSetId: null
      });
      const mutateSpy = vi.fn();
      activityOverrides.prepareMemoryConsolidation = prepareSpy;
      activityOverrides.executePersistedMemoryChangeSet = mutateSpy;

      const result = await testEnv.client.workflow.execute("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "test-consolidation-no-change-" + Date.now(),
        args: [{ runId: "audit:no-change", traceId: "trace:no-change" }]
      });

      expect(result).toEqual({ id: "audit:no-change", status: "COMPLETED" });
      expect(mutateSpy).not.toHaveBeenCalled();
    });

    it("executes mutation on MEMORY_MUTATION_TASK_QUEUE and finalizes repair when changeSetId exists", async () => {
      activityOverrides.prepareMemoryConsolidation = vi.fn().mockResolvedValue({
        run: { id: "audit:with-change", status: "PENDING" },
        changeSetId: "cs:with-change-1"
      });
      const mutateSpy = vi.fn().mockResolvedValue({ success: true, mutatedCount: 7 });
      const finalizeSpy = vi.fn().mockResolvedValue({ id: "audit:with-change", status: "COMPLETED", changeSetId: "cs:with-change-1" });
      activityOverrides.executePersistedMemoryChangeSet = mutateSpy;
      activityOverrides.finalizeMemoryRepair = finalizeSpy;

      const result = await testEnv.client.workflow.execute("memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "test-consolidation-with-change-" + Date.now(),
        args: [{ runId: "audit:with-change", traceId: "trace:with-change" }]
      });

      expect(result).toEqual({ id: "audit:with-change", status: "COMPLETED", changeSetId: "cs:with-change-1" });
      expect(mutateSpy).toHaveBeenCalledWith({ changeSetId: "cs:with-change-1", traceId: "trace:with-change" });
      expect(finalizeSpy).toHaveBeenCalledWith(expect.objectContaining({ changeSetId: "cs:with-change-1" }));
    }, 15000);
  });

  // --------------------------------------------------------------------------
  // 9. memoryMutationWorkflow
  // --------------------------------------------------------------------------
  describe("memoryMutationWorkflow", () => {
    it("executes persisted memory change set on mutation task queue", async () => {
      const mutateSpy = vi.fn().mockResolvedValue({ success: true, mutatedCount: 42 });
      activityOverrides.executePersistedMemoryChangeSet = mutateSpy;

      const result = await testEnv.client.workflow.execute("memoryMutationWorkflow", {
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: "test-mutation-" + Date.now(),
        args: [{ changeSetId: "cs:mut-standalone", traceId: "trace:mut-standalone" }]
      });

      expect(result).toEqual({ success: true, mutatedCount: 42 });
      expect(mutateSpy).toHaveBeenCalledWith({ changeSetId: "cs:mut-standalone", traceId: "trace:mut-standalone" });
    });
  });
});
