import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import proto from "@temporalio/proto";
const DEFAULT_TASK_QUEUE = "space-agent-turns";
const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
const MEMORY_MUTATION_TASK_QUEUE = "space-memory-mutations";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const fixturesDir = resolve(__dirname, "../tests/fixtures/workflow-histories");
mkdirSync(fixturesDir, { recursive: true });

const workflowsPath = resolve(__dirname, "../src/workflows.ts");
const maintenanceWorkflowsPath = resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const mutationWorkflowsPath = resolve(__dirname, "../src/memory-mutation-workflows.ts");

const defaultActivities = {
  recordDummyTurnStarted: async () => {},
  recordDummyTurnCompleted: async () => ({ status: "COMPLETED", message: "Turn completed successfully" }),
  runCodexAppServerTurn: async () => ({ status: "COMPLETED", message: "Codex turn finished" }),
  runOpenCodeAgentTurn: async () => ({ status: "COMPLETED", message: "OpenCode turn finished" }),
  runCliAgentTurn: async () => ({ status: "COMPLETED", message: "CLI turn finished" }),
  markRoomAgentMissionStarted: async () => {},
  markRoomAgentMissionFinished: async () => {},
  markRoomAgentMissionContinued: async () => {},
  dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
  dotGoalObserve: async () => ({ run: "SUCCEEDED", goalStatus: "COMPLETED" }),
  settleRoomAgentBackgroundMission: async () => true,
  discardRoomAgentSupervisorTurn: async () => {},
  finishRoomAgentSupervisorTurn: async () => {},
  checkRoomAgentSupervisorTurn: async () => "READY",
  prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" }),
  runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED", message: "Action succeeded" }),
  failRoomAgentBackgroundAction: async () => {}
};

const maintenanceActivities = {
  refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash-history-maint", refreshedAt: "2026-10-17T00:00:00Z" }),
  refreshAllMonthsMemoryGraphSnapshot: async () => {},
  reconcileStaleSpaceAgentSessions: async () => {},
  createScheduledMemoryAudit: async () => ({ id: "audit:history-1", workflowId: "memory-audit:history-1" }),
  prepareMemoryConsolidation: async () => ({ run: { id: "audit:history-1", status: "COMPLETED" }, changeSetId: null }),
  finalizeMemoryRepair: async () => ({ id: "audit:history-1", status: "COMPLETED", changeSetId: null })
};

const mutationActivities = {
  executePersistedMemoryChangeSet: async () => ({ success: true, mutatedCount: 2 })
};

async function recordAll() {
  console.log("Starting Temporal time-skipping test environment...");
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping();

  try {
    // 1. Default worker (workflows.ts)
    const defaultWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: DEFAULT_TASK_QUEUE,
      identity: "space-history-recorder@space.local",
      workflowsPath,
      activities: defaultActivities
    });

    // 2. Legacy supervisor worker (workflows.ts with patch disabled)
    const legacyTaskQueue = "space-agent-turns-legacy";
    const legacyWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: legacyTaskQueue,
      identity: "space-history-recorder@space.local",
      workflowsPath,
      activities: defaultActivities,
      patchActivationCallback: () => false
    });

    // 3. Maintenance worker (memory-maintenance-workflows.ts)
    const maintenanceWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      identity: "space-history-recorder@space.local",
      workflowsPath: maintenanceWorkflowsPath,
      activities: maintenanceActivities
    });

    // 4. Mutation worker (memory-mutation-workflows.ts)
    const mutationWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      identity: "space-history-recorder@space.local",
      workflowsPath: mutationWorkflowsPath,
      activities: mutationActivities
    });

    const runPromise = Promise.all([
      defaultWorker.run(),
      legacyWorker.run(),
      maintenanceWorker.run(),
      mutationWorker.run()
    ]);

    async function recordWorkflowHistory(name, workflowType, options, isContinuedAsNew = false) {
      console.log(`Recording fixture for ${name} (${workflowType})...`);
      const handle = await testEnv.client.workflow.start(workflowType, options);
      if (isContinuedAsNew) {
        const firstHandle = testEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        let closed = false;
        for (let i = 0; i < 20; i++) {
          await testEnv.sleep("100ms");
          const desc = await firstHandle.describe();
          if (desc.status?.name === "CONTINUED_AS_NEW" || desc.closeTime) {
            closed = true;
            break;
          }
        }
        if (!closed) {
          throw new Error(`Timed out waiting for first execution of ${name} (${handle.firstExecutionRunId}) to continue-as-new`);
        }
        const history = await firstHandle.fetchHistory();
        const lastEvent = history.events?.[history.events.length - 1];
        const eventType = String(lastEvent?.eventType || "");
        const isCanEvent = eventType.toLowerCase().includes("continued_as_new")
          || eventType.toLowerCase().includes("continuedasnew")
          || lastEvent?.workflowExecutionContinuedAsNewEventAttributes != null;
        if (!isCanEvent) {
          throw new Error(`Fetched history for ${name} does not end with continued-as-new event: ${JSON.stringify(lastEvent)}`);
        }
        const filePath = resolve(fixturesDir, `${name}.json`);
        const json = JSON.stringify(history, null, 2).replace(/"identity":\s*"[^"]+"/g, '"identity": "space-history-recorder@space.local"');
        writeFileSync(filePath, json, "utf8");
        console.log(`Saved ${name}.json (${history.events.length} events)`);
      } else {
        await handle.result();
        const history = await handle.fetchHistory();
        const filePath = resolve(fixturesDir, `${name}.json`);
        const json = JSON.stringify(history, null, 2).replace(/"identity":\s*"[^"]+"/g, '"identity": "space-history-recorder@space.local"');
        writeFileSync(filePath, json, "utf8");
        console.log(`Saved ${name}.json (${history.events.length} events)`);
      }
    }

    try {
      // 1. dummyTurnWorkflow
      await recordWorkflowHistory("dummy-turn", "dummyTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "hist-dummy-turn",
        args: [{
          roomId: "room:history",
          paneId: "pane:history",
          prompt: "History record dummy turn",
          artifactIds: [],
          agentRunId: "agent_run:history-dummy",
          permissionMode: null,
          collaborationMode: "default",
          traceId: "trace:history-dummy"
        }]
      });

      // 2. codexAppServerTurnWorkflow
      await recordWorkflowHistory("codex-app-server-turn", "codexAppServerTurnWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "hist-codex-turn",
        args: [{
          roomId: "room:history",
          paneId: "pane:history",
          prompt: "History record codex turn",
          artifactIds: [],
          agentRunId: "agent_run:history-codex",
          permissionMode: null,
          collaborationMode: "default",
          traceId: "trace:history-codex"
        }]
      });

      // 3. dotGoalWorkflow
      await recordWorkflowHistory("dot-goal", "dotGoalWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "hist-dot-goal",
        args: [{ goalId: "goal:history-dot" }]
      });

      // 4. roomAgentSupervisorWorkflow (Patched)
      await recordWorkflowHistory("room-agent-supervisor-patched", "roomAgentSupervisorWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "hist-room-supervisor-patched",
        args: [{
          roomId: "room:history-sup-patched",
          pending: [{
            missionId: "mission:history-sup-p1",
            turn: {
              roomId: "room:history-sup-patched",
              paneId: "pane:sup-p1",
              prompt: "Patched supervisor mission",
              artifactIds: [],
              agentRunId: "agent_run:history-sup-p1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:history-sup-p1"
            }
          }],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 49
        }]
      }, true);

      // 5. roomAgentSupervisorWorkflow (Legacy pre-patch)
      await recordWorkflowHistory("room-agent-supervisor-legacy", "roomAgentSupervisorWorkflow", {
        taskQueue: legacyTaskQueue,
        workflowId: "hist-room-supervisor-legacy",
        args: [{
          roomId: "room:history-sup-legacy",
          pending: [{
            missionId: "mission:history-sup-l1",
            turn: {
              roomId: "room:history-sup-legacy",
              paneId: "pane:sup-l1",
              prompt: "Legacy supervisor mission",
              artifactIds: [],
              agentRunId: "agent_run:history-sup-l1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: "trace:history-sup-l1"
            }
          }],
          interrupted: [],
          monitoringMissionIds: [],
          processedCount: 49
        }]
      }, true);

      // 6. roomAgentActionWorkflow
      await recordWorkflowHistory("room-agent-action", "roomAgentActionWorkflow", {
        taskQueue: DEFAULT_TASK_QUEUE,
        workflowId: "hist-room-agent-action",
        args: [{
          bridge: { roomId: "room:history-action", missionId: "mission:history-action-1" },
          actionId: "action:history-action-1",
          traceId: "trace:history-action-1"
        }]
      });

      // 7. memoryMaintenanceWorkflow
      await recordWorkflowHistory("memory-maintenance", "memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "hist-memory-maintenance",
        args: [{
          traceId: "trace:history-maint-1",
          reason: "scheduled_audit"
        }]
      });

      // 8. memoryConsolidationWorkflow
      await recordWorkflowHistory("memory-consolidation", "memoryConsolidationWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId: "hist-memory-consolidation",
        args: [{
          runId: "audit:history-consolidation-1",
          traceId: "trace:history-consolidation-1"
        }]
      });

      // 9. memoryMutationWorkflow
      await recordWorkflowHistory("memory-mutation", "memoryMutationWorkflow", {
        taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: "hist-memory-mutation",
        args: [{
          changeSetId: "cs:history-mutation-1",
          traceId: "trace:history-mutation-1"
        }]
      });

      console.log("\nAll 9 workflow histories recorded successfully!");
    } finally {
      defaultWorker.shutdown();
      legacyWorker.shutdown();
      maintenanceWorker.shutdown();
      mutationWorker.shutdown();
      await runPromise;
    }
  } finally {
    await testEnv.teardown();
  }
}

recordAll().catch((err) => {
  console.error("Failed to record workflow histories:", err);
  process.exit(1);
});
