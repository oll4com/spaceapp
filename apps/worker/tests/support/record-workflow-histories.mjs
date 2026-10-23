import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, eventually, fixtureDirectory, queueItem, turnInput, verifiedTurn } from "./temporal-sandbox.mjs";

// Recording is explicitly separate from the tests: a failing replay can never
// silently replace the evidence against which it was checked.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--patch" && /^[a-zA-Z0-9_-]+$/.test(args[1])),
  "Usage: npm run temporal:record-histories -w @space/worker [-- --patch intentional-patch-id]");
const suffix = args.length ? `.${args[1]}` : "";
const names = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow.legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"];
await mkdir(fixtureDirectory, { recursive: true });
for (const name of names) {
  const path = join(fixtureDirectory, `${name}${suffix}.json`);
  const exists = await access(path).then(() => true, () => false);
  assert.ok(!exists, `Refusing to overwrite ${path}. Preserve old histories; add a new --patch fixture only with an intentional patched() change.`);
}

const sandbox = await createSandbox();
const recordings = new Map();
try {
  const audit = { id: "audit:synthetic", workflowId: "synthetic-recording-audit-child", status: "COMPLETED" };
  sandbox.use({
    dotGoalStep: async () => sandbox.count("dotGoalStep") === 1
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" },
    recordDummyTurnStarted: async () => undefined,
    recordDummyTurnCompleted: async () => ({ status: "COMPLETED", message: "Synthetic dummy completion" }),
    runCodexAppServerTurn: async () => verifiedTurn,
    checkRoomAgentSupervisorTurn: async () => "READY",
    discardRoomAgentSupervisorTurn: async () => undefined,
    finishRoomAgentSupervisorTurn: async () => undefined,
    markRoomAgentMissionStarted: async () => undefined,
    markRoomAgentMissionFinished: async () => undefined,
    settleRoomAgentBackgroundMission: async () => true,
    prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" }),
    runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED", actionId: "action:synthetic" }),
    refreshMemoryGraphSnapshot: async () => ({ sourceHash: "synthetic-source", nodes: 0, edges: 0 }),
    refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
    reconcileStaleSpaceAgentSessions: async () => undefined,
    createScheduledMemoryAudit: async () => audit,
    prepareMemoryConsolidation: async () => ({ run: audit, changeSetId: "change:synthetic" }),
    executePersistedMemoryChangeSet: async () => ({ status: "APPLIED", changeSetId: "change:synthetic" }),
    finalizeMemoryRepair: async () => audit
  });

  for (const [name, input] of [
    ["dotGoalWorkflow", { goalId: "goal:synthetic" }],
    ["dummyTurnWorkflow", turnInput("record-dummy")],
    ["codexAppServerTurnWorkflow", turnInput("record-turn")],
    ["roomAgentActionWorkflow", { actionId: "action:synthetic", bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:record-action" }],
    ["memoryMaintenanceWorkflow", { traceId: "trace:record-maintenance" }],
    ["memoryConsolidationWorkflow", { runId: audit.id, traceId: "trace:record-consolidation" }],
    ["memoryMutationWorkflow", { changeSetId: "change:synthetic", traceId: "trace:record-mutation" }]
  ]) {
    const handle = await sandbox.start(name, input, { workflowId: `synthetic-record-${name}${suffix}` });
    await handle.result();
    recordings.set(name, await sandbox.history(handle));
  }
  for (const legacy of [false, true]) {
    const name = `roomAgentSupervisorWorkflow${legacy ? ".legacy" : ""}`;
    const completedBefore = sandbox.count(legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn");
    const settledBefore = sandbox.count(legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation");
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", {
      roomId: "room:synthetic", pending: [queueItem(`record-${legacy}`)], monitoringMissionIds: ["mission:record-monitor"]
    }, { legacy, workflowId: `synthetic-record-${name}${suffix}` });
    await eventually(() => sandbox.count(legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn") > completedBefore);
    await sandbox.env.sleep("1 second");
    await eventually(() => sandbox.count(legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation") > settledBefore);
    await sandbox.close(handle, { cancel: true });
    recordings.set(name, await sandbox.history(handle));
  }
  assert.equal(recordings.size, 9);
  // Only publish after every execution has succeeded. 'wx' still prevents a
  // concurrent recorder from replacing a fixture after the initial check.
  for (const [name, history] of recordings) {
    const path = join(fixtureDirectory, `${name}${suffix}.json`);
    await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, { flag: "wx" });
    console.log(`Recorded ${name}: ${history.events.length} events`);
  }
} finally { await sandbox.stop(); }
