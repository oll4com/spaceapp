import assert from "node:assert/strict";
import { it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { loadHistoryFixtures } from "./support/workflow-history-fixtures.js";
import { workflowBundle } from "./support/temporal-test-harness.js";

it("replays every committed baseline against current production, including pre-patch supervisor", async () => {
  const fixtures = await loadHistoryFixtures();
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle() }, fixtures)) {
    const fixture = fixtures.find(item => item.workflowId === result.workflowId)!;
    assert.ok(!result.error, `${fixture.workflowType} ${fixture.file}: ${result.error?.stack}`);
    results.push(result);
  }
  assert.equal(results.length, fixtures.length, "Replay must consume every baseline, not merely finish without throwing");
// The full worker suite also starts live workers. Keep replay's host deadline
// independent of that startup contention; CI still caps live + replay at180s.
}, 90_000);

it("rejects an unpatched extra timer with the determinism-specific error", async () => {
  const fixture = (await loadHistoryFixtures()).find(item => item.file === "dot-durable-timers.json")!;
  assert.ok(fixture, "Missing known-positive dot timer history");
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle("negative") }, [fixture])) results.push(result);
  assert.equal(results.length, 1);
  assert.ok(results[0]!.error instanceof DeterminismViolationError,
    `${fixture.workflowType} ${fixture.file}: expected DeterminismViolationError, received ${results[0]!.error?.stack}`);
}, 30_000);
