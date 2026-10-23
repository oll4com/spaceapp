import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

// Use the SDK's own generated protobuf constructor. JSON keeps int64/bytes
// losslessly; fromObject restores Long and Uint8Array before replay validation.
// This also avoids protojson's instanceof-Type mismatch with duplicated
// protobufjs versions in npm trees (the SDK's historyToJSON throws there).
const { temporal } = createRequire(import.meta.url)("@temporalio/proto");
export const historyDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));

export async function readHistories() {
  const files = (await readdir(historyDirectory)).filter(name => name.endsWith(".json")).sort();
  assert(files.length >= 9, "Missing committed workflow histories: run the explicit recording command for the initial baseline");
  return Promise.all(files.map(async file => {
    const json = JSON.parse(await readFile(`${historyDirectory}/${file}`, "utf8"));
    assert(json.events?.length > 0, `${file}: history has no events`);
    return { workflowId: file, history: temporal.api.history.v1.History.fromObject(json) };
  }));
}

export async function assertReplay(bundle: WorkflowBundleWithSourceMap) {
  const histories = await readHistories();
  const types = new Set(histories.map(({ history }) => history.events[0].workflowExecutionStartedEventAttributes.workflowType.name));
  for (const type of ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
    "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"]) {
    assert(types.has(type), `Missing replay fixture for ${type}`);
  }
  const legacy = histories.filter(h => h.workflowId.startsWith("supervisor-legacy-"));
  assert(legacy.length > 0, "Missing genuine pre-patch supervisor history");
  for (const { history } of legacy) assert(!history.events.some((e: any) => e.markerRecordedEventAttributes), "Legacy history must not contain a synthetic patch marker");
  const failures: string[] = [];
  const workflowTypes = new Map(histories.map(({ workflowId, history }) => [workflowId, history.events[0].workflowExecutionStartedEventAttributes.workflowType.name]));
  let count = 0;
  for await (const replay of Worker.runReplayHistories({ workflowBundle: bundle }, histories)) {
    count++;
    if (replay.error) failures.push(`${workflowTypes.get(replay.workflowId)} in ${replay.workflowId} (${replay.runId}): ${replay.error.name}: ${replay.error.message}`);
  }
  assert.equal(count, histories.length, "Every committed fixture must be replayed");
  assert.deepEqual(failures, [], `Workflow replay is incompatible:\n${failures.join("\n")}`);
}
