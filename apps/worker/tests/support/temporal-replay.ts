import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import proto from "@temporalio/proto";
import { Worker, type WorkflowBundle } from "@temporalio/worker";
import { eventsOf, payload, scheduledActivities, workflowsPath } from "./temporal-harness.js";

export const historyDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
export const requiredWorkflowTypes = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow", "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];
export type HistoryEntry = { file: string; workflowId: string; runId: string; workflowType: string; scenario: string; prePatch: boolean };
export type HistoryManifest = { sdkVersion: string; sourceRevision: string; histories: HistoryEntry[] };

export async function readHistories(directory = historyDirectory) {
  const manifest: HistoryManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.sdkVersion, "1.24.0");
  assert.deepEqual([...new Set(manifest.histories.map(entry => entry.workflowType))].sort(), [...requiredWorkflowTypes].sort());
  assert(manifest.histories.some(entry => entry.prePatch && entry.workflowType === "roomAgentSupervisorWorkflow"));
  const files = (await readdir(directory)).filter(file => file.endsWith(".json") && file !== "manifest.json").sort();
  assert.deepEqual(files, manifest.histories.map(entry => entry.file).sort(), "Manifest must list every committed history exactly once");
  return Promise.all(manifest.histories.map(async entry => {
    assert.equal(entry.file, entry.file.replace(/[^a-zA-Z0-9._-]/g, ""), "History names must stay in the fixture directory");
    const history = proto.temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(join(directory, entry.file), "utf8")));
    const start = history.events?.[0]?.workflowExecutionStartedEventAttributes;
    assert.equal(start?.workflowType?.name, entry.workflowType, entry.file);
    assert.equal(start?.originalExecutionRunId, entry.runId, entry.file);
    if (entry.workflowType === "roomAgentSupervisorWorkflow") {
      const patches = eventsOf(history, "markerRecordedEventAttributes")
        .map(event => event.markerRecordedEventAttributes!)
        .filter(marker => marker.markerName === "core_patch")
        .map(marker => payload<{ id: string }>(marker.details?.["patch-data"]).id);
      assert.equal(patches.includes("room-background-continuation-v1"), !entry.prePatch, `${entry.file}: wrong patch branch`);
      if (entry.prePatch) {
        const names = scheduledActivities(history).map(activity => activity.activityType!.name);
        assert(names.some(name => ["settleRoomAgentBackgroundMission", "markRoomAgentMissionStarted", "markRoomAgentMissionFinished"].includes(name!)), `${entry.file}: no legacy activity contract`);
        assert(!names.includes("prepareRoomAgentBackgroundContinuation"), `${entry.file}: current activity in pre-patch history`);
      }
    }
    return { ...entry, history };
  }));
}

export async function replayHistories(directory = historyDirectory, workflowBundle?: WorkflowBundle) {
  const fixtures = await readHistories(directory);
  let count = 0;
  for await (const result of Worker.runReplayHistories(
    workflowBundle ? { workflowBundle } : { workflowsPath }, fixtures
  )) {
    const fixture = fixtures[count++];
    assert(fixture, "Replay returned an unexpected execution");
    assert.equal(result.workflowId, fixture.workflowId);
    assert.equal(result.runId, fixture.runId);
    if (result.error) {
      throw new Error(`Replay failed for ${fixture.workflowType} (${fixture.workflowId}) in ${fixture.file}: ${result.error.name}: ${result.error.message}`, { cause: result.error });
    }
  }
  assert.equal(count, fixtures.length, "Every history must actually be replayed");
  return count;
}
