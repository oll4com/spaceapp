import { beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { basicScenarios } from "./temporal-basic-scenarios.js";
import { supervisorScenarios } from "./temporal-supervisor-scenarios.js";
import { assertReplay, createHistoryRecorder, loadHistories, runScenario, workflowBundle } from "./temporal-test-harness.js";

// Isolate time-skipping locks and production memory queues between scenarios.
describe.sequential("real Temporal sandbox and replay compatibility", () => {
  const recording = process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1";
  // An alternate corpus is supported only for explicit recording. Ordinary CI
  // always replays the committed baseline, regardless of this environment value.
  const replayDirectory = recording ? process.env.SPACE_TEMPORAL_HISTORY_DIRECTORY || undefined : undefined;
  let recordHistories: Awaited<ReturnType<typeof createHistoryRecorder>> | undefined;
  beforeAll(async () => {
    await Promise.all([workflowBundle(), workflowBundle("legacy")]);
    if (recording) {
      recordHistories = await createHistoryRecorder({
        directory: replayDirectory,
        version: process.env.SPACE_TEMPORAL_HISTORY_VERSION || undefined,
        replay: assertReplay
      });
    }
  }, 60_000);

  for (const scenario of [...basicScenarios(), ...supervisorScenarios()]) {
    it(scenario.name, async () => {
      const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-test-client" } });
      try {
        const histories = await runScenario(env, scenario);
        // Recording only adds new names after the existing corpus passed replay.
        if (recordHistories) await recordHistories(histories);
        // Replay the committed corpus once below. Replaying the same scenarios
        // here doubles the compatibility work without adding a baseline.
      } finally {
        await env.teardown();
      }
    }, 60_000);
  }

  it("replays every committed synthetic history against current production code", async () => {
    const histories = await loadHistories(replayDirectory);
    const results = await assertReplay(histories);
    expect(results).toHaveLength(histories.length);
    for (const result of results) {
      expect(result.error, `${result.fixture}: ${result.error?.message ?? ""}`).toBeUndefined();
    }
  }, 60_000);

  it("rejects an incompatible extra timer with a determinism error", async () => {
    const histories = (await loadHistories(replayDirectory)).filter(entry => entry.name.startsWith("dot-"));
    expect(histories.length).toBeGreaterThan(0);
    const results = await assertReplay(histories, "negative");
    expect(results.some(result => result.error?.name === "DeterminismViolationError"),
      results.map(result => `${result.fixture}: ${result.error?.name ?? "no error"}`).join("\n")).toBe(true);
  }, 30_000);
});
