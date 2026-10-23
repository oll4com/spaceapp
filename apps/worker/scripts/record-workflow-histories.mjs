#!/usr/bin/env node
/**
 * @fileoverview Records synthetic Temporal workflow execution histories for replay determinism gating.
 * Runs each in-scope workflow in TestWorkflowEnvironment.createTimeSkipping() with stubbed activities,
 * serializes histories to JSON, and stores them under apps/worker/tests/fixtures/workflow-histories/.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowContinuedAsNewError, WorkflowFailedError } from "@temporalio/client";
import {
  DOT_GOAL_SIGNAL,
  MEMORY_MUTATION_TASK_QUEUE,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema
} from "@space/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const fixturesDir = path.resolve(workerRoot, "tests/fixtures/workflow-histories");

const workflowsPath = path.resolve(workerRoot, "src/workflows.ts");
const memoryMaintenanceWorkflowsPath = path.resolve(workerRoot, "src/memory-maintenance-workflows.ts");
const memoryMutationWorkflowsPath = path.resolve(workerRoot, "src/memory-mutation-workflows.ts");

const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
const SYNTHETIC_WORKER_IDENTITY = "synthetic-test-worker";

const rawArgs = process.argv.slice(2);
const forceOverwrite = rawArgs.includes("--force");
const requestedFixtures = new Set(rawArgs.filter((arg) => !arg.startsWith("-")).map((arg) => arg.replace(/\.json$/i, "")));

/**
 * Creates an Error with a normalized stack trace for deterministic simulation.
 * @param {string} message - Error message
 * @returns {Error} Error instance with synthetic stack trace
 */
function syntheticError(message) {
  const err = new Error(message);
  err.stack = `Error: ${message}`;
  return err;
}

/**
 * Constructs a synthetic RoomAgentSupervisorQueueItem for testing supervisor continuation logic.
 * @param {string} roomId - Room identifier
 * @param {string} missionId - Mission identifier
 * @param {string} suffix - Unique suffix for IDs
 * @param {boolean} [continuation=false] - Whether this item represents an automatic continuation
 * @returns {import("@space/contracts").RoomAgentSupervisorQueueItem} Validated queue item
 */
function buildSyntheticQueueItem(roomId, missionId, suffix, continuation = false) {
  return roomAgentSupervisorQueueItemSchema.parse({
    missionId,
    turn: {
      roomId,
      paneId: `pane:${suffix}`,
      prompt: `Synthetic supervisor prompt ${suffix}`,
      roomAgentOperatorRequest: `Synthetic supervisor prompt ${suffix}`,
      roomAgentMissionId: missionId,
      ...(continuation
        ? { roomAgentContinuation: { sourceRunId: "agent_run:sup-initial", generation: 1 } }
        : {}),
      artifactIds: [],
      agentSessionId: `agent_session:${suffix}`,
      agentRunId: `agent_run:${suffix}`,
      agentUserMessageId: `agent_msg:user-${suffix}`,
      agentAssistantMessageId: `agent_msg:assistant-${suffix}`,
      permissionMode: null,
      collaborationMode: "default",
      traceId: `trace:${suffix}`
    }
  });
}

/**
 * Serializes and saves a workflow execution history to disk as a JSON fixture.
 * @param {string} name - Fixture base name (without .json extension)
 * @param {object} history - Temporal workflow execution history object
 * @returns {Promise<void>}
 */
async function saveHistory(name, history) {
  if (requestedFixtures.size > 0 && !requestedFixtures.has(name)) {
    return;
  }
  const targetPath = path.join(fixturesDir, `${name}.json`);
  if (existsSync(targetPath) && !forceOverwrite) {
    console.log(`Skipping existing ${name}.json (pass --force to overwrite)`);
    return;
  }
  const sanitized = JSON.parse(
    JSON.stringify(history, (key, value) => {
      if (key === "identity" && typeof value === "string" && value !== SYNTHETIC_WORKER_IDENTITY) {
        return "synthetic-test-client";
      }
      return value;
    })
  );
  const json = JSON.stringify(sanitized, null, 2).replace(/\r\n/g, "\n") + "\n";
  await writeFile(targetPath, json, "utf8");
  console.log(`Recorded ${name}.json`);
}

/**
 * Main execution harness to generate all synthetic workflow histories across main, legacy, and memory workers.
 * @returns {Promise<void>}
 */
async function main() {
  await mkdir(fixturesDir, { recursive: true });
  const env = await TestWorkflowEnvironment.createTimeSkipping();

  try {
    // 1. Main workflows worker (dotGoalWorkflow, dummyTurnWorkflow, codexAppServerTurnWorkflow,
    //    roomAgentSupervisorWorkflow current branch, roomAgentActionWorkflow)
    let dotStepCount = 0;
    let codexAttempts = 0;
    let supervisorPollCount = 0;

    const mainTaskQueue = "space-replay-record-main";
    const mainWorker = await Worker.create({
      connection: env.nativeConnection,
      identity: SYNTHETIC_WORKER_IDENTITY,
      taskQueue: mainTaskQueue,
      workflowsPath,
      activities: {
        dotGoalStep: async () => {
          dotStepCount += 1;
          if (dotStepCount === 1) {
            return { state: "WAITING", runId: null, goalStatus: "RUNNING" };
          }
          if (dotStepCount === 2) {
            return { state: "RUNNING", runId: "run:dot-1", goalStatus: "RUNNING" };
          }
          return { state: "DONE", runId: "run:dot-1", goalStatus: "COMPLETED" };
        },
        dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "RUNNING" }),
        recordDummyTurnStarted: async () => undefined,
        recordDummyTurnCompleted: async (input) => ({
          runId: input.runId,
          threadId: input.threadId,
          status: "COMPLETED",
          assistantMessage: `Echo: ${input.userMessage}`
        }),
        runCodexAppServerTurn: async (input) => {
          if (input.runId === "run:codex-retry" && ++codexAttempts < 2) {
            throw syntheticError("Transient synthetic turn error");
          }
          return {
            runId: input.runId ?? input.agentRunId ?? "run:synthetic",
            threadId: input.threadId ?? "thread:synthetic",
            status: "COMPLETED",
            assistantMessage: "Synthetic turn completed",
            roomAgentOutcome: {
              status: "VERIFIED",
              executedActionCount: 1,
              pendingActionIds: input.agentRunId === "agent_run:sup-initial" ? ["action:bg-1"] : [],
              statusReason: "Synthetic outcome verified."
            }
          };
        },
        runOpenCodeAgentTurn: async (input) => ({
          runId: input.runId ?? "run:opencode",
          threadId: input.threadId ?? "thread:opencode",
          status: "COMPLETED",
          assistantMessage: "OpenCode completed"
        }),
        runCliAgentTurn: async (input) => ({
          runId: input.runId ?? "run:cli",
          threadId: input.threadId ?? "thread:cli",
          status: "COMPLETED",
          assistantMessage: "CLI completed"
        }),
        checkRoomAgentSupervisorTurn: async () => "READY",
        discardRoomAgentSupervisorTurn: async () => undefined,
        finishRoomAgentSupervisorTurn: async () => undefined,
        prepareRoomAgentBackgroundContinuation: async ({ missionId }) => {
          supervisorPollCount += 1;
          if (supervisorPollCount === 1) {
            return {
              state: "READY",
              item: buildSyntheticQueueItem("room:sup-current", missionId, "cont-1", true)
            };
          }
          return { state: "DONE" };
        },
        runRoomAgentBackgroundAction: async () => {
          throw syntheticError("Synthetic background action transport failure");
        },
        failRoomAgentBackgroundAction: async () => undefined
      }
    });

    await mainWorker.runUntil(async () => {
      // 1a. dotGoalWorkflow
      const dotHandle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "fixture:dotGoalWorkflow",
        args: [{ goalId: "goal:fixture-1" }]
      });
      await dotHandle.signal(DOT_GOAL_SIGNAL);
      await dotHandle.result();
      await saveHistory("dotGoalWorkflow", await dotHandle.fetchHistory());

      // 1b. dummyTurnWorkflow
      const dummyHandle = await env.client.workflow.start("dummyTurnWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "fixture:dummyTurnWorkflow",
        args: [{ runId: "run:dummy-1", threadId: "thread:dummy-1", userMessage: "Hello synthetic world" }]
      });
      await dummyHandle.result();
      await saveHistory("dummyTurnWorkflow", await dummyHandle.fetchHistory());

      // 1c. codexAppServerTurnWorkflow
      const codexHandle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "fixture:codexAppServerTurnWorkflow",
        args: [{ runId: "run:codex-retry", threadId: "thread:codex-1", userMessage: "Run turn with retry" }]
      });
      await codexHandle.result();
      await saveHistory("codexAppServerTurnWorkflow", await codexHandle.fetchHistory());

      // 1d. roomAgentActionWorkflow (failure path with room-background-action-failure-v1)
      const actionHandle = await env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "space-room-action:action:fixture",
        args: [
          {
            bridge: { roomId: "room:fixture", missionId: "mission:fixture" },
            traceId: "trace:action-fixture"
          }
        ]
      });
      try {
        await actionHandle.result();
      } catch (err) {
        if (!(err instanceof WorkflowFailedError)) throw err;
      }
      await saveHistory("roomAgentActionWorkflow", await actionHandle.fetchHistory());

      // 1e. roomAgentSupervisorWorkflow (current patched branch)
      const supInput = roomAgentSupervisorInputSchema.parse({
        roomId: "room:sup-current",
        pending: [
          {
            ...buildSyntheticQueueItem("room:sup-current", "mission:sup-1", "sup-initial", false),
            turn: {
              ...buildSyntheticQueueItem("room:sup-current", "mission:sup-1", "sup-initial", false).turn,
              runId: "run:sup-initial"
            }
          }
        ],
        monitoringMissionIds: [],
        interrupted: [],
        processedCount: 48
      });
      const supHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: mainTaskQueue,
        workflowId: "fixture:roomAgentSupervisorWorkflow",
        args: [supInput],
        followRuns: false
      });
      try {
        await supHandle.result();
      } catch (err) {
        if (!(err instanceof WorkflowContinuedAsNewError)) throw err;
      }
      const firstSupHandle = env.client.workflow.getHandle(
        "fixture:roomAgentSupervisorWorkflow",
        supHandle.firstExecutionRunId
      );
      await saveHistory("roomAgentSupervisorWorkflow", await firstSupHandle.fetchHistory());
    });

    // 2. Pre-patch roomAgentSupervisorWorkflow worker
    const legacyTaskQueue = "space-replay-record-legacy";
    let legacySettledResolve;
    const legacySettledPromise = new Promise((resolve) => {
      legacySettledResolve = resolve;
    });
    const legacyWorker = await Worker.create({
      connection: env.nativeConnection,
      identity: SYNTHETIC_WORKER_IDENTITY,
      taskQueue: legacyTaskQueue,
      workflowsPath,
      patchActivationCallback: ({ patchId }) => patchId !== "room-background-continuation-v1",
      activities: {
        markRoomAgentMissionStarted: async () => undefined,
        markRoomAgentMissionContinued: async () => undefined,
        markRoomAgentMissionFinished: async () => undefined,
        settleRoomAgentBackgroundMission: async () => {
          legacySettledResolve();
          return true;
        },
        runCodexAppServerTurn: async () => ({
          runId: "run:legacy-1",
          threadId: "thread:legacy-1",
          status: "COMPLETED",
          assistantMessage: "Legacy child turn finished",
          roomAgentOutcome: {
            status: "VERIFIED",
            executedActionCount: 1,
            pendingActionIds: ["action:legacy-bg"],
            statusReason: "Legacy background work started."
          }
        })
      }
    });

    await legacyWorker.runUntil(async () => {
      const legacyInput = roomAgentSupervisorInputSchema.parse({
        roomId: "room:sup-legacy",
        pending: [],
        monitoringMissionIds: ["mission:legacy-monitored"],
        interrupted: [],
        processedCount: 49
      });
      const legacyHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: legacyTaskQueue,
        workflowId: "fixture:roomAgentSupervisorWorkflow.pre-patch",
        args: [legacyInput],
        followRuns: false
      });
      await legacySettledPromise;
      await legacyHandle.signal(
        ROOM_AGENT_ENQUEUE_SIGNAL,
        buildSyntheticQueueItem("room:sup-legacy", "mission:legacy-1", "legacy-1", false)
      );
      try {
        await legacyHandle.result();
      } catch (err) {
        if (!(err instanceof WorkflowContinuedAsNewError)) throw err;
      }
      const firstLegacyHandle = env.client.workflow.getHandle(
        "fixture:roomAgentSupervisorWorkflow.pre-patch",
        legacyHandle.firstExecutionRunId
      );
      await saveHistory("roomAgentSupervisorWorkflow.pre-patch", await firstLegacyHandle.fetchHistory());
    });

    // 3. Memory maintenance, consolidation, and mutation workflows
    let mutationAttempts = 0;
    const maintenanceWorker = await Worker.create({
      connection: env.nativeConnection,
      identity: SYNTHETIC_WORKER_IDENTITY,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: memoryMaintenanceWorkflowsPath,
      activities: {
        refreshMemoryGraphSnapshot: async (input) => ({
          monthKey: input.monthKey ?? "2026-10",
          nodeCount: 42,
          edgeCount: 18,
          sourceHash: "sha256:synthetic-snapshot"
        }),
        refreshAllMonthsMemoryGraphSnapshot: async () => {
          throw syntheticError("Synthetic all-months snapshot failure");
        },
        reconcileStaleSpaceAgentSessions: async () => {
          throw syntheticError("Synthetic stale session reconciliation failure");
        },
        createScheduledMemoryAudit: async (input) => ({
          id: "audit_run:fixture-1",
          workflowId: `fixture:memoryConsolidationChild:${input.traceId}`,
          status: "QUEUED",
          createdAt: "2026-10-16T00:00:00.000Z"
        }),
        prepareMemoryConsolidation: async (input) => ({
          changeSetId: "changeset:fixture-1",
          run: {
            id: input.runId,
            status: "RUNNING",
            traceId: input.traceId
          }
        }),
        finalizeMemoryRepair: async ({ runId, changeSetId, mutationResult }) => ({
          id: runId,
          changeSetId,
          status: "COMPLETED",
          appliedCount: mutationResult.appliedOperationCount ?? 1
        })
      }
    });

    const mutationWorker = await Worker.create({
      connection: env.nativeConnection,
      identity: SYNTHETIC_WORKER_IDENTITY,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: memoryMutationWorkflowsPath,
      activities: {
        executePersistedMemoryChangeSet: async (input) => {
          if (input.changeSetId === "changeset:retry-fixture" && ++mutationAttempts < 2) {
            throw syntheticError("Transient synthetic mutation error");
          }
          return {
            changeSetId: input.changeSetId,
            status: "APPLIED",
            appliedOperationCount: 2
          };
        }
      }
    });

    const mutationRunPromise = mutationWorker.run();
    try {
      await maintenanceWorker.runUntil(async () => {
        // 3a. memoryMaintenanceWorkflow (including child memoryConsolidationWorkflow)
        const maintHandle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowId: "fixture:memoryMaintenanceWorkflow",
          args: [{ monthKey: "2026-10", traceId: "trace:maint-fixture" }]
        });
        await maintHandle.result();
        await saveHistory("memoryMaintenanceWorkflow", await maintHandle.fetchHistory());

        // 3b. memoryConsolidationWorkflow standalone
        const consHandle = await env.client.workflow.start("memoryConsolidationWorkflow", {
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowId: "fixture:memoryConsolidationWorkflow",
          args: [{ runId: "audit_run:standalone-1", traceId: "trace:cons-fixture" }]
        });
        await consHandle.result();
        await saveHistory("memoryConsolidationWorkflow", await consHandle.fetchHistory());

        // 3c. memoryMutationWorkflow standalone (with activity retry)
        const mutHandle = await env.client.workflow.start("memoryMutationWorkflow", {
          taskQueue: MEMORY_MUTATION_TASK_QUEUE,
          workflowId: "fixture:memoryMutationWorkflow",
          args: [{ changeSetId: "changeset:retry-fixture", traceId: "trace:mut-fixture" }]
        });
        await mutHandle.result();
        await saveHistory("memoryMutationWorkflow", await mutHandle.fetchHistory());
      });
    } finally {
      mutationWorker.shutdown();
      await mutationRunPromise;
    }
  } finally {
    await env.teardown();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
