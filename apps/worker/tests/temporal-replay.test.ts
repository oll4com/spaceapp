import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { temporal } from "@temporalio/proto";
import { bundleWorkflows, workflowBundle } from "./support/temporal-sandbox.js";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));
const requiredWorkflows = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];

async function recordedHistories() {
  const files = (await readdir(fixtureDirectory)).filter(name => name.endsWith(".json")).sort();
  return Promise.all(files.map(async name => {
    const fixture = JSON.parse(await readFile(resolve(fixtureDirectory, name), "utf8"));
    expect(fixture.workflowId, `Missing original workflow identity in ${name}`).toBeTypeOf("string");
    return { name, ...fixture };
  }));
}

it("replays every committed history against current production workflows", async () => {
  const histories = await recordedHistories();
  const types = new Set(histories.map(({ history }) =>
    history.events[0].workflowExecutionStartedEventAttributes.workflowType.name));
  for (const name of requiredWorkflows) expect(types, `Missing recorded history for ${name}`).toContain(name);
  const supervisors = histories.filter(({ history }) =>
    history.events[0].workflowExecutionStartedEventAttributes.workflowType.name === "roomAgentSupervisorWorkflow");
  const containsPatch = (history: { events: Array<{ markerRecordedEventAttributes?: {
    markerName?: string; details?: Record<string, { payloads?: Array<{ data?: string }> }>
  } }> }) => history.events.some(event => {
    const marker = event.markerRecordedEventAttributes;
    if (marker?.markerName !== "core_patch") return false;
    return marker.details?.["patch-data"]?.payloads?.some(payload =>
      payload.data && JSON.parse(Buffer.from(payload.data, "base64").toString("utf8")).id === "room-background-continuation-v1");
  });
  expect(supervisors.some(({ history }) => containsPatch(history)), "Missing patched supervisor history").toBe(true);
  expect(supervisors.some(({ history }) => !containsPatch(history)), "Missing pre-patch supervisor history").toBe(true);

  let replayed = 0;
  for await (const result of Worker.runReplayHistories(
    { workflowBundle: await workflowBundle() },
    histories.map(({ workflowId, history }) => ({
      workflowId,
      history: temporal.api.history.v1.History.fromObject(history)
    }))
  )) {
    const file = histories.find(fixture => fixture.workflowId === result.workflowId)?.name;
    expect(result.error, `Replay failed for ${result.workflowId} (${file}): ${result.error?.message}`).toBeUndefined();
    replayed++;
  }
  expect(replayed).toBe(histories.length);
}, 60_000);

it("rejects a real history when a test-only workflow adds an incompatible timer", async () => {
  const fixture = (await recordedHistories()).find(({ history }) =>
    history.events[0].workflowExecutionStartedEventAttributes.workflowType.name === "dummyTurnWorkflow");
  expect(fixture, "Missing dummy-turn history for the negative replay proof").toBeDefined();
  await expect(Worker.runReplayHistory({
    workflowBundle: await bundleWorkflows(fileURLToPath(new URL("./support/temporal-incompatible-workflow.ts", import.meta.url)))
  }, temporal.api.history.v1.History.fromObject(fixture!.history), fixture!.workflowId)).rejects.toBeInstanceOf(DeterminismViolationError);
}, 60_000);
