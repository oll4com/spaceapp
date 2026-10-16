import { beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { basicScenarios } from "./temporal-basic-scenarios.js";
import { supervisorScenarios } from "./temporal-supervisor-scenarios.js";
import { assertReplay, loadHistories, runScenario, saveHistories, workflowBundle } from "./temporal-test-harness.js";

// Isolate time-skipping locks and production memory queues between scenarios.
describe.sequential("real Temporal sandbox and replay compatibility", () => {
  beforeAll(async () => {
    await Promise.all([workflowBundle(), workflowBundle("legacy")]);
  }, 60_000);

  for (const scenario of [...basicScenarios(), ...supervisorScenarios()]) {
    it(scenario.name, async () => {
      const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-test-client" } });
      try {
        const histories = await runScenario(env, scenario);
        // Ordinary tests never overwrite the compatibility baseline.
        if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1") await saveHistories(histories);
        // Replay the committed corpus once below. Replaying the same scenarios
        // here doubles the compatibility work without adding a baseline.
      } finally {
        await env.teardown();
      }
    }, 60_000);
  }

  it("replays every committed synthetic history against current production code", async () => {
    const histories = await loadHistories();
    const results = await assertReplay(histories);
    expect(results).toHaveLength(histories.length);
    for (const result of results) {
      expect(result.error, `${result.fixture}: ${result.error?.message ?? ""}`).toBeUndefined();
    }
  }, 60_000);

  it("rejects an incompatible extra timer with a determinism error", async () => {
    const histories = (await loadHistories()).filter(entry => entry.name.startsWith("dot-"));
    expect(histories.length).toBeGreaterThan(0);
    const results = await assertReplay(histories, "negative");
    expect(results.some(result => result.error?.name === "DeterminismViolationError"),
      results.map(result => `${result.fixture}: ${result.error?.name ?? "no error"}`).join("\n")).toBe(true);
  }, 30_000);
});
