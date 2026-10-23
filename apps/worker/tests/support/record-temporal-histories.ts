/** Explicit, offline fixture creation; never run automatically by the replay gate. */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import proto from "@temporalio/proto";
const { temporal } = proto;
const historyToJSON = (history: import("@temporalio/proto").temporal.api.history.v1.IHistory) => JSON.stringify(temporal.api.history.v1.History.toObject(temporal.api.history.v1.History.create(history), { longs: String, enums: String, bytes: String }), null, 2);
import { withTemporal, waitFor } from "./temporal-harness.js";

const directory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
const completed = { status: "COMPLETED", message: "Synthetic result", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verification" } };
const turn = { roomId: "room:fixture", paneId: "pane:fixture", prompt: "Synthetic request", traceId: "trace:fixture" };
const run = { id: "consolidation:fixture", workflowId: "consolidation-child:fixture", status: "COMPLETED" };
const snapshot = { sourceHash: "synthetic-source-hash", status: "COMPLETED" };
const mutation = { changeSetId: "changeset:fixture", status: "APPLIED" };
const activities = {
  recordDummyTurnStarted: async () => undefined,
  recordDummyTurnCompleted: async () => completed,
  runCodexAppServerTurn: async () => completed,
  dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
  runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED" }),
  refreshMemoryGraphSnapshot: async () => snapshot,
  refreshAllMonthsMemoryGraphSnapshot: async () => snapshot,
  reconcileStaleSpaceAgentSessions: async () => undefined,
  createScheduledMemoryAudit: async () => run,
  prepareMemoryConsolidation: async () => ({ run, changeSetId: "changeset:fixture" }),
  executePersistedMemoryChangeSet: async () => mutation,
  finalizeMemoryRepair: async () => run
};
const scenarios: Array<[string, unknown]> = [
  ["dotGoalWorkflow", { goalId: "goal:fixture" }],
  ["dummyTurnWorkflow", turn],
  ["codexAppServerTurnWorkflow", turn],
  ["roomAgentActionWorkflow", { actionId: "action:fixture", bridge: { roomId: turn.roomId, missionId: "mission:fixture" }, traceId: turn.traceId }],
  ["memoryMaintenanceWorkflow", { traceId: turn.traceId }],
  ["memoryConsolidationWorkflow", { runId: run.id, traceId: turn.traceId }],
  ["memoryMutationWorkflow", { changeSetId: mutation.changeSetId, traceId: turn.traceId }]
];
await mkdir(directory, { recursive: true });
for (const [workflow, input] of scenarios) {
  await withTemporal({ activities }, async ({ client, taskQueue }) => {
    const handle = await client.workflow.start(workflow, { workflowId: `fixture:${workflow}`, taskQueue, args: [input] });
    await handle.result();
    await writeFile(`${directory}/${workflow}.json`, historyToJSON(await handle.fetchHistory()) + "\n");
    console.log(`Recorded ${workflow}`);
  });
}
for (const legacyPatch of [false, true]) {
  let observed = 0;
  await withTemporal({ legacyPatch, activities: {
    prepareRoomAgentBackgroundContinuation: async () => { observed++; return { state: "DONE" }; },
    settleRoomAgentBackgroundMission: async () => { observed++; return true; }
  } }, async ({ client, taskQueue, env }) => {
    const suffix = legacyPatch ? "pre-patch" : "current";
    const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: `fixture:supervisor:${suffix}`, taskQueue,
      args: [{ roomId: "room:fixture", monitoringMissionIds: ["mission:fixture"] }]
    });
    // Wait for the first durable polling timer before advancing the test clock.
    let pollingTimerObserved = false;
    for (let attempts = 0; attempts < 200; attempts++) {
      if ((await handle.fetchHistory()).events?.some(e => e.timerStartedEventAttributes)) {
        pollingTimerObserved = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!pollingTimerObserved) {
      throw new Error(`Supervisor ${suffix} did not schedule its initial polling timer after 200 history checks`);
    }
    await env.sleep("1 second");
    await waitFor(() => observed === 1, "supervisor fixture polling");
    // Capture a completed activation that consumes the activity result, not only
    // an activity invocation followed by termination in the middle of its reply.
    let settled = false;
    for (let attempts = 0; attempts < 1000; attempts++) {
      const events = (await handle.fetchHistory()).events ?? [];
      const completion = events.findLastIndex(event => event.activityTaskCompletedEventAttributes);
      if (completion >= 0 && events.slice(completion + 1).some(event => event.workflowTaskCompletedEventAttributes)) {
        settled = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!settled) throw new Error(`Supervisor ${suffix} did not consume its activity result`);
    await handle.terminate("End synthetic idle supervisor recording");
    await writeFile(`${directory}/roomAgentSupervisorWorkflow-${suffix}.json`, historyToJSON(await handle.fetchHistory()) + "\n");
    console.log(`Recorded supervisor ${suffix}`);
  });
}
