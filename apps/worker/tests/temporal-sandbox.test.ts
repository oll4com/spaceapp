import assert from "node:assert/strict";
import { afterAll, beforeAll, it } from "vitest";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { TemporalSandbox, incompatibleWorkflowsPath } from "./support/temporal-sandbox.js";
import { scenarios, runScenario } from "./support/temporal-scenarios.js";
import { assertReplay, readHistories } from "./support/temporal-replay.js";

// Fresh disposable servers isolate virtual clocks and outstanding activity locks.
// Compiled production/legacy bundles are shared; no workflow API is mocked.
const sandbox = new TemporalSandbox();
beforeAll(() => sandbox.open(), 60_000);
afterAll(() => sandbox.close(), 30_000);
for (const scenario of scenarios) {
  it(scenario.name, () => runScenario(sandbox, scenario), 60_000);
}

it("replays every immutable history against current production workflows", () => assertReplay(sandbox.bundle), 60_000);

it("rejects an extra workflow timer with the real DeterminismViolationError", async () => {
  const histories = (await readHistories()).filter(h => h.workflowId === "dot-goal-wake.json");
  assert.equal(histories.length, 1);
  const incompatible = await bundleWorkflowCode({ workflowsPath: incompatibleWorkflowsPath });
  const results = [];
  for await (const replay of Worker.runReplayHistories({ workflowBundle: incompatible }, histories)) results.push(replay);
  assert.equal(results.length, 1);
  assert(results[0]!.error instanceof DeterminismViolationError, `Expected a determinism error for dot-goal-wake.json, got ${results[0]!.error}`);
}, 30_000);
