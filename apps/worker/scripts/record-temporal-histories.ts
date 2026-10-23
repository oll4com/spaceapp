import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WorkflowContinuedAsNewError, WorkflowFailedError } from "@temporalio/client";
import { Sandbox, type StubActivities } from "../tests/support/temporal-sandbox.js";
import { queueItem, supervisorInput, verified } from "../tests/support/temporal-inputs.js";

const { values } = parseArgs({ options: {
  output: { type: "string" }, force: { type: "boolean", default: false }, "patch-id": { type: "string" }
} });
const destination = values.output ? resolve(values.output) : fileURLToPath(new URL("../tests/fixtures/workflow-histories/", import.meta.url));
await mkdir(destination, { recursive: true });
const existing = (await readdir(destination)).filter(name => name.endsWith(".json"));
if (existing.length && !(values.force && values["patch-id"])) {
  throw new Error("Histories already exist. Re-record only alongside a reviewed patched() change, with --force --patch-id <id>; never to make replay pass.");
}

// Only failure stack traces are machine-specific. Keep every command/event/payload intact.
function syntheticHistory(history: unknown) {
  return JSON.stringify(history, (key, value) => key === "stackTrace" ? "" : value, 2) + "\n";
}
const manifest: Array<{ file: string; workflowType: string; workflowId: string; sha256: string; branch?: string }> = [];
const pendingHistories: Array<{ name: string; content: string }> = [];
const sandbox = await Sandbox.create();
try {
  async function record(file: string, workflowType: string, input: unknown, activities: StubActivities,
    options: { outcome?: "failed" | "continued"; legacy?: boolean; taskQueue?: string; extraTaskQueues?: string[] } = {}) {
    const workflowId = `history:${file}`;
    await sandbox.run(activities, async () => {
      const handle = await sandbox.start(workflowType, input, { workflowId, followRuns: false });
      if (options.outcome) {
        await assert.rejects(handle.result(), options.outcome === "continued" ? WorkflowContinuedAsNewError : WorkflowFailedError);
      } else await handle.result();
      const history = await handle.fetchHistory();
      assert(history.events && history.events.length > 0);
      const content = syntheticHistory(history);
      const name = `${file}.json`;
      pendingHistories.push({ name, content });
      manifest.push({ file: name, workflowType, workflowId, sha256: createHash("sha256").update(content).digest("hex"),
        ...(options.legacy ? { branch: "pre-patch" } : {}) });
    }, { ...options, taskQueue: options.taskQueue ?? `history-queue:${file}` });
  }

  const turn = queueItem("recorded").turn;
  const dummyResult = { workflowId: "history:dummy-turn", roomId: turn.roomId, paneId: turn.paneId, traceId: turn.traceId, status: "COMPLETED", message: "Synthetic completion" };
  await record("dummy-turn", "dummyTurnWorkflow", turn, { recordDummyTurnStarted: () => undefined, recordDummyTurnCompleted: () => dummyResult });
  await record("codex-turn", "codexAppServerTurnWorkflow", turn, { runCodexAppServerTurn: () => verified });
  let dotSteps = 0;
  await record("dot-goal", "dotGoalWorkflow", { goalId: "goal:recorded" }, {
    dotGoalStep: () => ++dotSteps === 1 ? { state: "WAITING", runId: null, goalStatus: "RUNNING" } : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
  });
  for (const legacy of [false, true]) {
    await record(legacy ? "supervisor-pre-patch" : "supervisor-current", "roomAgentSupervisorWorkflow", supervisorInput({ pending: [queueItem(legacy ? "legacy" : "current")], processedCount: 49 }), {
      checkRoomAgentSupervisorTurn: () => "READY", finishRoomAgentSupervisorTurn: () => undefined,
      markRoomAgentMissionStarted: () => undefined, markRoomAgentMissionFinished: () => undefined,
      runCodexAppServerTurn: () => verified
    }, { outcome: "continued", legacy });
  }
  await record("room-action-failure", "roomAgentActionWorkflow", {
    actionId: "action:recorded", bridge: { roomId: "room:synthetic", missionId: "mission:recorded" }, traceId: "trace:recorded"
  }, { runRoomAgentBackgroundAction: () => { throw Error("Synthetic action failure"); }, failRoomAgentBackgroundAction: () => undefined }, { outcome: "failed" });

  const timestamp = "2026-10-01T00:00:00.000Z";
  const sourceHash = "a".repeat(64);
  const run = { id: "memory_consolidation:recorded", mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED",
    workflowId: "history:memory-child", dedupeKey: "synthetic", sourceHash, actorUserId: null,
    progressCompleted: 0, progressTotal: 0, findingCount: 0, appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0,
    metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null, createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp };
  const mutation = { status: "APPLIED", changeSetId: "memory_change_set:recorded", resultingSourceHash: sourceHash, reason: null };
  const memoryActivities = {
    refreshMemoryGraphSnapshot: () => ({ status: "UNCHANGED", generatedAt: timestamp, sourceHash, previousSourceHash: sourceHash,
      summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 0 }),
    refreshAllMonthsMemoryGraphSnapshot: () => { throw Error("Synthetic optional refresh failure"); },
    reconcileStaleSpaceAgentSessions: () => { throw Error("Synthetic optional reconciliation failure"); },
    createScheduledMemoryAudit: () => run,
    prepareMemoryConsolidation: () => ({ run, changeSetId: mutation.changeSetId }),
    executePersistedMemoryChangeSet: () => mutation,
    finalizeMemoryRepair: () => run
  };
  await record("memory-maintenance", "memoryMaintenanceWorkflow", { scheduledAt: timestamp, traceId: "trace:recorded" }, memoryActivities,
    { taskQueue: "space-memory-maintenance", extraTaskQueues: ["space-memory-mutations"] });
  await record("memory-consolidation", "memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:recorded" }, memoryActivities,
    { taskQueue: "space-memory-maintenance", extraTaskQueues: ["space-memory-mutations"] });
  await record("memory-mutation", "memoryMutationWorkflow", { changeSetId: mutation.changeSetId, traceId: "trace:recorded" }, memoryActivities);

  const workerPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const metadata = { sdkVersion: workerPackage.devDependencies["@temporalio/testing"],
    ...(values["patch-id"] ? { patchId: values["patch-id"] } : {}), histories: manifest };
  for (const { name, content } of pendingHistories) {
    await writeFile(resolve(destination, name), content, { flag: values.force ? "w" : "wx" });
  }
  await writeFile(resolve(destination, "manifest.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: values.force ? "w" : "wx" });
  console.log(`Recorded ${manifest.length} synthetic histories in ${destination}. Review their diff; normal tests only read them.`);
} finally {
  await sandbox.close();
}
