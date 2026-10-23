import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import proto from "@temporalio/proto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures/workflow-histories");
const workflowsPath = resolve(__dirname, "../src/workflows.ts");
const maintenanceWorkflowsPath = resolve(__dirname, "../src/memory-maintenance-workflows.ts");
const mutationWorkflowsPath = resolve(__dirname, "../src/memory-mutation-workflows.ts");

function loadHistory(filename: string) {
  const raw = readFileSync(resolve(fixturesDir, filename), "utf8");
  const parsed = JSON.parse(raw);
  return proto.temporal.api.history.v1.History.fromObject(parsed);
}

describe("Temporal Workflow Replay Determinism Gate", () => {
  it("replays all workflows.ts recorded histories deterministically via Worker.runReplayHistories", async () => {
    const fixtureNames = [
      "dummy-turn.json",
      "codex-app-server-turn.json",
      "dot-goal.json",
      "room-agent-supervisor-patched.json",
      "room-agent-supervisor-legacy.json",
      "room-agent-action.json"
    ];

    const histories = fixtureNames.map((name) => ({
      history: loadHistory(name),
      workflowId: `replay-${name.replace(".json", "")}`
    }));

    let replayedCount = 0;
    for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
      expect(result.error).toBeUndefined();
      replayedCount++;
    }
    expect(replayedCount).toBe(fixtureNames.length);
  });

  it("replays all memory maintenance recorded histories deterministically via Worker.runReplayHistories", async () => {
    const fixtureNames = [
      "memory-maintenance.json",
      "memory-consolidation.json"
    ];

    const histories = fixtureNames.map((name) => ({
      history: loadHistory(name),
      workflowId: `replay-${name.replace(".json", "")}`
    }));

    let replayedCount = 0;
    for await (const result of Worker.runReplayHistories({ workflowsPath: maintenanceWorkflowsPath }, histories)) {
      expect(result.error).toBeUndefined();
      replayedCount++;
    }
    expect(replayedCount).toBe(fixtureNames.length);
  });

  it("replays all memory mutation recorded histories deterministically via Worker.runReplayHistories", async () => {
    const fixtureNames = [
      "memory-mutation.json"
    ];

    const histories = fixtureNames.map((name) => ({
      history: loadHistory(name),
      workflowId: `replay-${name.replace(".json", "")}`
    }));

    let replayedCount = 0;
    for await (const result of Worker.runReplayHistories({ workflowsPath: mutationWorkflowsPath }, histories)) {
      expect(result.error).toBeUndefined();
      replayedCount++;
    }
    expect(replayedCount).toBe(fixtureNames.length);
  });

  it("verifies every fixture JSON in the fixtures directory is covered by replay tests", () => {
    const allFiles = readdirSync(fixturesDir).filter((file) => file.endsWith(".json"));
    expect(allFiles.length).toBe(9);
    expect(allFiles).toEqual(
      expect.arrayContaining([
        "dummy-turn.json",
        "codex-app-server-turn.json",
        "dot-goal.json",
        "room-agent-supervisor-patched.json",
        "room-agent-supervisor-legacy.json",
        "room-agent-action.json",
        "memory-maintenance.json",
        "memory-consolidation.json",
        "memory-mutation.json"
      ])
    );
  });

  it("fails replay with DeterminismViolationError when a workflow definition has non-deterministic changes", async () => {
    const history = loadHistory("dummy-turn.json");
    const badWorkflowsPath = resolve(__dirname, "fixtures/bad-workflow-determinism.ts");

    // Replaying dummyTurnWorkflow history against badWorkflowsPath (which introduces an unrecorded sleep timer)
    let caughtError: unknown;
    try {
      await Worker.runReplayHistory({ workflowsPath: badWorkflowsPath }, history, "replay-nondeterministic-dummy");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    const isDeterminismViolation =
      caughtError instanceof DeterminismViolationError ||
      (caughtError as Error).name === "DeterminismViolationError";
    expect(isDeterminismViolation).toBe(true);
  });
});
