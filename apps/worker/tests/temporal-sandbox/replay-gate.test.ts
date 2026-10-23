/**
 * Replay determinism gate (issue #60): every recorded workflow history must
 * replay against the current workflow code via Worker.runReplayHistories,
 * and a deliberately replay-incompatible change must fail with
 * DeterminismViolationError.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeterminismViolationError } from "@temporalio/workflow";
import { Worker } from "@temporalio/worker";
import * as proto from "@temporalio/proto";
import { allWorkflowsEntry, buildWorkflowBundle } from "./sandbox.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../fixtures/workflow-histories");

const EXPECTED_FIXTURES = [
  "codexAppServerTurnWorkflow.json",
  "dotGoalWorkflow.json",
  "dummyTurnWorkflow.json",
  "memoryConsolidationWorkflow.json",
  "memoryMaintenanceWorkflow.json",
  "memoryMutationWorkflow.json",
  "roomAgentActionWorkflow.json",
  "roomAgentSupervisorWorkflow.json",
  "roomAgentSupervisorWorkflow.pre-patch.json"
];

/**
 * Loads the recorded fixtures. The histories are stored as the JSON form
 * emitted by protobufjs (enum names, int64s as strings), so they are decoded
 * back into History messages with History.fromObject() here. That converts
 * enum names to their numeric proto values, which lets
 * Worker.validateHistory hand the history straight to the replay worker
 * without any JSON-conversion layer.
 */
async function readHistories() {
  const files = (await readdir(FIXTURES_DIR)).filter((file) => file.endsWith(".json"));
  const histories = [];
  for (const file of files) {
    const recorded = JSON.parse(await readFile(resolve(FIXTURES_DIR, file), "utf8"));
    const history = proto.temporal.api.history.v1.History.fromObject(recorded.history);
    histories.push({ workflowId: recorded.workflowId, history });
  }
  return { files: files.sort(), histories };
}

describe("replay determinism gate", () => {
  it("has one recorded history per workflow plus the pre-patch supervisor", async () => {
    const { files } = await readHistories();
    expect(files).toEqual(EXPECTED_FIXTURES);
  }, 30000);

  it("replays every recorded history against the real workflow code", async () => {
    const { histories } = await readHistories();
    expect(histories.length).toBeGreaterThanOrEqual(9);
    const bundle = await buildWorkflowBundle(allWorkflowsEntry());

    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle: { code: bundle.code } }, histories)) {
      results.push(result);
      if (result.error) {
        console.error("replay failed for", result.workflowId, result.error);
      }
    }

    expect(results).toHaveLength(histories.length);
    expect(results.filter((result) => result.error)).toEqual([]);
  }, 120000);

  it("rejects a replay-incompatible workflow change with DeterminismViolationError", async () => {
    const { histories } = await readHistories();
    const dotGoalHistory = histories.find((item) => item.workflowId === "fixture-dot-goal");
    expect(dotGoalHistory).toBeDefined();
    // tests/support/determinism-violation-workflow.ts: dotGoalWorkflow with
    // one extra timer at the start.
    const bundle = await buildWorkflowBundle(
      resolve(__dirname, "../support/determinism-violation-workflow.ts")
    );

    const results = [];
    for await (const result of Worker.runReplayHistories(
      { workflowBundle: { code: bundle.code } },
      [dotGoalHistory]
    )) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0].error).toBeInstanceOf(DeterminismViolationError);
  }, 60000);
});
