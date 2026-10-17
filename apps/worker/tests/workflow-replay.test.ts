import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleWorkflowCode, DefaultLogger, Worker, type ReplayResult, type WorkflowBundle } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import proto, { type temporal } from "@temporalio/proto";
import { getWorkflowBundle } from "./support/workflow-sandbox.js";

const historiesDirectory = new URL("./fixtures/workflow-histories/", import.meta.url);
const fixtures = [
  "dotGoalWorkflow",
  "dummyTurnWorkflow",
  "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow-prepatch",
  "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow",
  "memoryMutationWorkflow"
] as const;

/** Rehydrates a committed protobuf history and restores the fixed workflow ID used when it was recorded. */
async function loadHistory(name: typeof fixtures[number]) {
  return {
    workflowId: `replay-${name}`,
    // Rehydrate Longs, enum values and bytes using the same protobuf schema as
    // the SDK. Passing serialized event IDs would instead invoke protojson.
    history: proto.temporal.api.history.v1.History.fromObject(
      JSON.parse(await readFile(new URL(`${name}.json`, historiesDirectory), "utf8"))
    )
  };
}

/** Decodes Temporal patch marker payloads so legacy coverage cannot accidentally use a current-branch fixture. */
function recordedPatchIds(history: temporal.api.history.v1.IHistory): string[] {
  return (history.events ?? []).flatMap((event) => {
    const marker = event.markerRecordedEventAttributes;
    if (marker?.markerName !== "core_patch") return [];
    const data = marker.details?.["patch-data"]?.payloads?.[0]?.data;
    if (!data) return [];
    const { id } = JSON.parse(Buffer.from(data).toString("utf8"));
    return typeof id === "string" ? [id] : [];
  });
}

/** Fully consumes batch replay results, including each history's determinism error, without running activities. */
async function replay(workflowBundle: WorkflowBundle, histories: Awaited<ReturnType<typeof loadHistory>>[]) {
  const results: ReplayResult[] = [];
  // The batch API reports per-history errors in yielded results. Merely awaiting
  // creation of the iterator (or inspecting just the first result) misses failures.
  for await (const result of Worker.runReplayHistories({ workflowBundle }, histories)) {
    results.push(result);
  }
  return results;
}

describe("committed workflow histories", () => {
  let currentBundle: WorkflowBundle;
  let timerBundle: WorkflowBundle;
  let activityBundle: WorkflowBundle;

  beforeAll(async () => {
    currentBundle = await getWorkflowBundle();
    timerBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./fixtures/workflow-replay-timer.ts", import.meta.url)),
      logger: new DefaultLogger("ERROR")
    });
    activityBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./fixtures/workflow-replay-activity.ts", import.meta.url)),
      logger: new DefaultLogger("ERROR")
    });
  }, 90_000);

  it("replays all eight workflow types and the pre-patch supervisor history with the current code", async () => {
    const recordedNames = (await readdir(historiesDirectory)).filter((name) => name.endsWith(".json")).sort();
    expect(recordedNames).toEqual(fixtures.map((name) => `${name}.json`).sort());

    const histories = await Promise.all(fixtures.map(loadHistory));
    const byName = new Map(fixtures.map((name, index) => [name, histories[index]!.history]));
    expect(recordedPatchIds(byName.get("roomAgentSupervisorWorkflow")!)).toContain("room-background-continuation-v1");
    expect(recordedPatchIds(byName.get("roomAgentSupervisorWorkflow-prepatch")!)).not.toContain("room-background-continuation-v1");
    const results = await replay(currentBundle, histories);
    expect(results.map((result) => result.workflowId).sort()).toEqual(histories.map(({ workflowId }) => workflowId).sort());
    for (const result of results) {
      expect(result.error, `History ${result.workflowId} must replay without an error`).toBeUndefined();
    }
  }, 90_000);

  it("detects an added timer with DeterminismViolationError", async () => {
    const results = await replay(timerBundle, [await loadHistory("dummyTurnWorkflow")]);
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBeInstanceOf(DeterminismViolationError);
  }, 30_000);

  it("detects an added activity with DeterminismViolationError", async () => {
    const results = await replay(activityBundle, [await loadHistory("dummyTurnWorkflow")]);
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBeInstanceOf(DeterminismViolationError);
  }, 30_000);
});
