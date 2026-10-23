import { mkdir, writeFile } from "node:fs/promises";
import { ApplicationFailure } from "@temporalio/common";
import proto, { type temporal } from "@temporalio/proto";
import { dummyTurnInputSchema, roomAgentSupervisorInputSchema } from "@space/contracts";
import { createSandbox, type SandboxOptions } from "../tests/support/workflow-sandbox.js";

// Only synthetic input and activity responses. Never connect to an operator's
// server or download histories from a running installation to refresh fixtures.
const turn = dummyTurnInputSchema.parse({
  roomId: "room:replay", paneId: "pane:replay", agentRunId: "agent_run:replay",
  traceId: "trace:replay", prompt: "Synthetic replay verification"
});
const turnResult = {
  workflowId: "workflow:replay", roomId: turn.roomId, paneId: turn.paneId,
  traceId: turn.traceId, status: "COMPLETED", message: "Synthetic result",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified synthetic work." }
};
const memoryInput = { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:replay-memory" };
const snapshot = {
  status: "REFRESHED", generatedAt: memoryInput.scheduledAt, sourceHash: "a".repeat(64), previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 1
};
const mutationInput = { changeSetId: "change_set:replay", traceId: memoryInput.traceId };
const mutationResult = { status: "APPLIED", changeSetId: mutationInput.changeSetId, resultingSourceHash: "b".repeat(64), reason: null };
const memoryRun = {
  id: "memory_run:replay", mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED",
  workflowId: "replay-memory-child", dedupeKey: "scheduled:replay", sourceHash: snapshot.sourceHash,
  actorUserId: null, progressCompleted: 1, progressTotal: 1, findingCount: 1,
  appliedOperationCount: 1, skippedOperationCount: 0, failedOperationCount: 0,
  metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
  createdAt: memoryInput.scheduledAt, startedAt: memoryInput.scheduledAt,
  completedAt: memoryInput.scheduledAt, updatedAt: memoryInput.scheduledAt
};
/** Supply synthetic memory results, including recoverable optional failures. */
function memoryActivities() {
  return {
    refreshMemoryGraphSnapshot: async () => snapshot,
    refreshAllMonthsMemoryGraphSnapshot: async () => { throw ApplicationFailure.nonRetryable("Synthetic optional refresh failure"); },
    reconcileStaleSpaceAgentSessions: async () => { throw ApplicationFailure.nonRetryable("Synthetic optional reconciliation failure"); },
    createScheduledMemoryAudit: async () => memoryRun,
    prepareMemoryConsolidation: async () => ({ run: memoryRun, changeSetId: mutationInput.changeSetId }),
    executePersistedMemoryChangeSet: async () => mutationResult,
    finalizeMemoryRepair: async () => memoryRun
  };
}

const recorded = new Map<string, string>();
/** Serialize protobuf history losslessly while omitting local failure stacks. */
function historyJSON(history: temporal.api.history.v1.IHistory): string {
  // Use the generated schema on both sides of the fixture boundary, preserving
  // int64 IDs and base64 payloads without depending on protobuf reflection copies.
  return `${JSON.stringify(proto.temporal.api.history.v1.History.toObject(history as temporal.api.history.v1.History, {
    longs: String, enums: String, bytes: String, json: true
  }), (key, value) => key === "stackTrace" ? "Synthetic test failure (local stack omitted)" : value, 2)}\n`;
}
/** Record a real synthetic execution and always tear down its private server. */
async function record(
  workflow: string,
  input: unknown,
  options: SandboxOptions,
  { continued = false, expectedFailure = false } = {}
) {
  const name = `${workflow}${options.legacySupervisor ? "-prepatch" : ""}`;
  const sandbox = await createSandbox(options);
  try {
    await sandbox.runUntil(async () => {
      const handle = await sandbox.env.client.workflow.start(workflow, {
        workflowId: `replay-${name}`, taskQueue: sandbox.queue, args: [input]
      });
      const initial = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      if (continued) {
        // result() unlocks time skipping; pin fetchHistory to the first run so
        // the fixture includes the actual ContinueAsNew command and carried state.
        const finished = handle.result().catch(() => undefined);
        try {
          const deadline = Date.now() + 30_000;
          for (;;) {
            const history = await initial.fetchHistory();
            if (history.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)) {
              recorded.set(name, historyJSON(history));
              break;
            }
            if (Date.now() >= deadline) throw new Error(`No continue-as-new event recorded for ${name}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          await handle.terminate("Synthetic history recorded");
          await finished;
        }
      } else {
        let failed = false;
        try { await handle.result(); } catch (error) {
          if (!expectedFailure) throw error;
          failed = true;
        }
        if (expectedFailure && !failed) throw new Error(`Expected a failed synthetic execution for ${name}`);
        recorded.set(name, historyJSON(await initial.fetchHistory()));
      }
    });
  } finally {
    await sandbox.close();
  }
  console.log(`Recorded ${name}`);
}

let goalSteps = 0;
await record("dotGoalWorkflow", { goalId: "goal:replay" }, {
  activities: {
    dotGoalStep: async () => ++goalSteps === 1
      ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
  }
});
await record("dummyTurnWorkflow", turn, {
  activities: { recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => turnResult }
});
await record("codexAppServerTurnWorkflow", turn, { activities: { runCodexAppServerTurn: async () => turnResult } });
for (const legacySupervisor of [false, true]) {
  await record("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
    roomId: turn.roomId, pending: [{ missionId: "mission:replay", turn }], processedCount: 49
  }), {
    legacySupervisor,
    activities: {
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => turnResult,
      finishRoomAgentSupervisorTurn: async () => undefined,
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async () => undefined
    }
  }, { continued: true });
}
await record("roomAgentActionWorkflow", {
  actionId: "action:replay", bridge: { roomId: turn.roomId, missionId: "mission:replay" }
}, {
  activities: {
    runRoomAgentBackgroundAction: async () => { throw ApplicationFailure.nonRetryable("Synthetic action failure"); },
    failRoomAgentBackgroundAction: async () => undefined
  }
}, { expectedFailure: true });
await record("memoryMaintenanceWorkflow", memoryInput, { activities: memoryActivities(), memoryQueues: true });
await record("memoryConsolidationWorkflow", { runId: memoryRun.id, traceId: memoryInput.traceId }, {
  activities: memoryActivities(), memoryQueues: true
});
await record("memoryMutationWorkflow", mutationInput, { activities: memoryActivities() });

// Wait for every real workflow run to succeed before writing any new fixtures.
// Existing compatibility histories must never be replaced, even on an explicit run.
const destination = new URL("../tests/fixtures/workflow-histories/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, history] of recorded) {
  const target = new URL(`${name}.json`, destination);
  await writeFile(target, history, { flag: "wx" });
}
console.log(`Wrote ${recorded.size} synthetic histories. Review the diff before committing.`);
