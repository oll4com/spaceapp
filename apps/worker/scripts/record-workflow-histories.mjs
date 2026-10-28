import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../tests/fixtures/workflow-histories");
const WORKFLOWS_MAIN = resolve(__dirname, "../src/workflows.ts");
const WORKFLOWS_MAINTENANCE = resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const WORKFLOWS_MUTATION = resolve(__dirname, "../src/memory-mutation-workflows.ts");

mkdirSync(FIXTURES_DIR, { recursive: true });

console.log("Starting TestWorkflowEnvironment for canonical history recording...");
const env = await TestWorkflowEnvironment.createTimeSkipping();

let onSupervisorFirstRunFinished = () => {};
const supervisorFirstRunPromise = new Promise((resolve) => {
  onSupervisorFirstRunFinished = resolve;
});

let onSupervisorPrePatchFinished = () => {};
const supervisorPrePatchPromise = new Promise((resolve) => {
  onSupervisorPrePatchFinished = resolve;
});

const mainWorker = await Worker.create({
  connection: env.nativeConnection,
  namespace: env.client.options.namespace,
  taskQueue: "space-agent-turns",
  workflowsPath: WORKFLOWS_MAIN,
  activities: {
    recordDummyTurnStarted: async () => {},
    recordDummyTurnCompleted: async () => ({
      runId: "run:synthetic-dummy-completed",
      status: "COMPLETED"
    }),
    runCodexAppServerTurn: async () => ({
      roomAgentOutcome: {
        status: "COMPLETED",
        executedActionCount: 1,
        pendingActionIds: [],
        statusReason: "Synthetic turn completed successfully."
      }
    }),
    dotGoalStep: async () => ({
      state: "DONE",
      runId: null,
      goalStatus: "COMPLETED"
    }),
    dotGoalObserve: async () => ({
      run: "COMPLETED",
      goalStatus: "COMPLETED"
    }),
    runRoomAgentBackgroundAction: async () => ({
      status: "COMPLETED"
    }),
    checkRoomAgentSupervisorTurn: async () => "READY",
    finishRoomAgentSupervisorTurn: async () => {
      onSupervisorFirstRunFinished();
    },
    discardRoomAgentSupervisorTurn: async () => {}
  }
});

const prePatchWorker = await Worker.create({
  connection: env.nativeConnection,
  namespace: env.client.options.namespace,
  taskQueue: "space-agent-turns-pre-patch",
  workflowsPath: WORKFLOWS_MAIN,
  patchActivationCallback: (info, patchId) => {
    const pid = patchId ?? (info && typeof info === "object" ? info.patchId : undefined);
    return pid !== "room-background-continuation-v1";
  },
  activities: {
    markRoomAgentMissionStarted: async () => {},
    markRoomAgentMissionFinished: async () => {
      onSupervisorPrePatchFinished();
    },
    markRoomAgentMissionContinued: async () => {},
    runCodexAppServerTurn: async () => ({
      roomAgentOutcome: {
        status: "COMPLETED",
        executedActionCount: 1,
        pendingActionIds: [],
        statusReason: "Synthetic turn completed successfully."
      }
    })
  }
});

const maintenanceWorker = await Worker.create({
  connection: env.nativeConnection,
  namespace: env.client.options.namespace,
  taskQueue: "space-memory-maintenance",
  workflowsPath: WORKFLOWS_MAINTENANCE,
  activities: {
    refreshMemoryGraphSnapshot: async () => ({
      sourceHash: "hash:synthetic-maintenance-snapshot-1"
    }),
    refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
    reconcileStaleSpaceAgentSessions: async () => ({}),
    createScheduledMemoryAudit: async () => ({
      id: "run:synthetic-audit-run-1",
      workflowId: "memory-consolidation:synthetic-audit-run-1"
    }),
    prepareMemoryConsolidation: async () => ({
      run: { id: "run:synthetic-consolidation-run-1", status: "COMPLETED" },
      changeSetId: "cs:synthetic-change-set-1"
    }),
    finalizeMemoryRepair: async () => ({
      id: "run:synthetic-consolidation-run-1",
      status: "COMPLETED"
    })
  }
});

const mutationWorker = await Worker.create({
  connection: env.nativeConnection,
  namespace: env.client.options.namespace,
  taskQueue: "space-memory-mutations",
  workflowsPath: WORKFLOWS_MUTATION,
  activities: {
    executePersistedMemoryChangeSet: async () => ({
      status: "APPLIED",
      appliedCount: 1
    })
  }
});

const runPromises = Promise.all([
  mainWorker.run(),
  prePatchWorker.run(),
  maintenanceWorker.run(),
  mutationWorker.run()
]);

async function recordHistory(fixtureName, startFn, waitFn) {
  console.log(`Recording fixture: ${fixtureName}...`);
  const handle = await startFn();
  if (waitFn) {
    await waitFn(handle);
  }
  // Allow any pending workflow task to flush to the server
  await new Promise((r) => setTimeout(r, 150));
  const history = await handle.fetchHistory();
  const filePath = resolve(FIXTURES_DIR, fixtureName);
  writeFileSync(filePath, JSON.stringify(history, null, 2), "utf8");
  console.log(`Saved ${fixtureName} (${history.events?.length ?? 0} events) to ${filePath}`);
}

try {
  // 1. main-codex-turn.json
  await recordHistory(
    "main-codex-turn.json",
    () =>
      env.workflowClient.start("codexAppServerTurnWorkflow", {
        taskQueue: "space-agent-turns",
        workflowId: "workflow:main-codex-turn",
        args: [
          {
            roomId: "room:synthetic-room-1",
            paneId: "pane:synthetic-pane-1",
            prompt: "Synthetic test prompt for codex turn",
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 2. main-dot-goal.json
  await recordHistory(
    "main-dot-goal.json",
    () =>
      env.workflowClient.start("dotGoalWorkflow", {
        taskQueue: "space-agent-turns",
        workflowId: "workflow:main-dot-goal",
        args: [
          {
            goalId: "goal:synthetic-goal-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 3. main-dummy-turn.json
  await recordHistory(
    "main-dummy-turn.json",
    () =>
      env.workflowClient.start("dummyTurnWorkflow", {
        taskQueue: "space-agent-turns",
        workflowId: "workflow:main-dummy-turn",
        args: [
          {
            roomId: "room:synthetic-room-1",
            paneId: "pane:synthetic-pane-1",
            prompt: "Synthetic test prompt for dummy turn",
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 4. main-room-action.json
  await recordHistory(
    "main-room-action.json",
    () =>
      env.workflowClient.start("roomAgentActionWorkflow", {
        taskQueue: "space-agent-turns",
        workflowId: "workflow:main-room-action",
        args: [
          {
            actionId: "action:synthetic-action-1",
            bridge: {
              roomId: "room:synthetic-room-1",
              paneId: "pane:synthetic-pane-1",
              missionId: "mission:synthetic-mission-1",
              actionType: "OPEN_TYPES",
              payload: {}
            },
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 5. main-supervisor-first-run.json
  await recordHistory(
    "main-supervisor-first-run.json",
    () =>
      env.workflowClient.start("roomAgentSupervisorWorkflow", {
        taskQueue: "space-agent-turns",
        workflowId: "workflow:main-supervisor-first-run",
        args: [
          {
            roomId: "room:synthetic-room-1",
            pending: [
              {
                missionId: "mission:synthetic-supervisor-first-1",
                turn: {
                  roomId: "room:synthetic-room-1",
                  paneId: "pane:synthetic-pane-1",
                  prompt: "Synthetic supervisor first run prompt",
                  traceId: "trace:synthetic-trace-1",
                  providerId: null,
                  modelId: null
                }
              }
            ],
            monitoringMissionIds: [],
            processedCount: 0
          }
        ]
      }),
    async () => {
      await supervisorFirstRunPromise;
    }
  );

  // 6. main-supervisor-pre-patch.json
  await recordHistory(
    "main-supervisor-pre-patch.json",
    () =>
      env.workflowClient.start("roomAgentSupervisorWorkflow", {
        taskQueue: "space-agent-turns-pre-patch",
        workflowId: "workflow:main-supervisor-pre-patch",
        args: [
          {
            roomId: "room:synthetic-room-1",
            pending: [
              {
                missionId: "mission:synthetic-supervisor-pre-patch-1",
                turn: {
                  roomId: "room:synthetic-room-1",
                  paneId: "pane:synthetic-pane-1",
                  prompt: "Synthetic supervisor pre-patch prompt",
                  traceId: "trace:synthetic-trace-1",
                  providerId: null,
                  modelId: null
                }
              }
            ],
            monitoringMissionIds: [],
            processedCount: 0
          }
        ]
      }),
    async () => {
      await supervisorPrePatchPromise;
    }
  );

  // 7. maintenance-consolidation.json
  await recordHistory(
    "maintenance-consolidation.json",
    () =>
      env.workflowClient.start("memoryConsolidationWorkflow", {
        taskQueue: "space-memory-maintenance",
        workflowId: "workflow:maintenance-consolidation",
        args: [
          {
            runId: "run:synthetic-consolidation-run-1",
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 8. maintenance-run.json
  await recordHistory(
    "maintenance-run.json",
    () =>
      env.workflowClient.start("memoryMaintenanceWorkflow", {
        taskQueue: "space-memory-maintenance",
        workflowId: "workflow:maintenance-run",
        args: [
          {
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  // 9. mutation-run.json
  await recordHistory(
    "mutation-run.json",
    () =>
      env.workflowClient.start("memoryMutationWorkflow", {
        taskQueue: "space-memory-mutations",
        workflowId: "workflow:mutation-run",
        args: [
          {
            changeSetId: "cs:synthetic-change-set-1",
            traceId: "trace:synthetic-trace-1"
          }
        ]
      }),
    (handle) => handle.result()
  );

  console.log("All 9 workflow histories recorded successfully!");
} finally {
  mainWorker.shutdown();
  prePatchWorker.shutdown();
  maintenanceWorker.shutdown();
  mutationWorker.shutdown();
  await runPromises;
  await env.teardown();
}
