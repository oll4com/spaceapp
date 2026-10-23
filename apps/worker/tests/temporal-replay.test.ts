import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { temporal } from "@temporalio/proto";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));

async function histories() {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  expect(files.length, "Record real synthetic histories before running the replay gate").toBeGreaterThanOrEqual(9);
  return Promise.all(files.map(async (file) => {
    const recorded = JSON.parse(await readFile(`${directory}/${file}`, "utf8"));
    expect(typeof recorded.workflowId, `Missing original workflow ID in ${file}`).toBe("string");
    return { file, workflowId: recorded.workflowId,
      history: temporal.api.history.v1.History.fromObject(recorded.history) };
  }));
}

describe("recorded workflow histories", () => {
  it("replays every recorded history against the current workflow implementations", async () => {
    const recordings = await histories();
    const covered = new Set(recordings.map(({ history }) => history.events?.[0].workflowExecutionStartedEventAttributes?.workflowType?.name));
    expect([...covered].sort()).toEqual([
      "codexAppServerTurnWorkflow", "dotGoalWorkflow", "dummyTurnWorkflow", "memoryConsolidationWorkflow",
      "memoryMaintenanceWorkflow", "memoryMutationWorkflow", "roomAgentActionWorkflow", "roomAgentSupervisorWorkflow"
    ].sort());
    const legacy = recordings.find(({ file }) => file === "supervisor-legacy-continue-as-new.json");
    expect(legacy, "A marker-free legacy supervisor history is required").toBeDefined();
    expect(legacy?.history.events?.some((event) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(false);
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("./support/replay-workflows.ts", import.meta.url)) });
    for await (const result of Worker.runReplayHistories({ workflowBundle }, recordings)) {
      const source = recordings.find(({ workflowId }) => workflowId === result.workflowId);
      expect(result.error, `Replay failed for ${result.workflowId} (${source?.file}); do not re-record to hide a determinism regression`).toBeUndefined();
    }
  }, 90_000);

  it("rejects a test-only variant that inserts a timer before the original first activity", async () => {
    const history = (await histories()).find(({ file }) => file === "dummy-turn-retry.json");
    expect(history).toBeDefined();
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("./support/incompatible-replay-workflow.ts", import.meta.url)) });
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle }, [history!])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeInstanceOf(DeterminismViolationError);
  }, 60_000);
});
