import { expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { negativeWorkflowsPath } from "./support/temporal-harness.js";
import { readHistories, replayHistories } from "./support/temporal-replay.js";

it("replays every committed history against the current production workflows", async () => {
  expect(await replayHistories()).toBeGreaterThanOrEqual(9);
}, 60_000);

it("rejects an extra timer in dotGoalWorkflow with a real determinism violation", async () => {
  const fixtures = await readHistories();
  const fixture = fixtures.find(entry => entry.scenario === "dot-timeout-and-observe")!;
  expect(fixture, "The negative control needs the fixed Dot history").toBeDefined();
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowsPath: negativeWorkflowsPath }, [fixture])) results.push(result);
  expect(results).toHaveLength(1);
  expect(results[0]!.workflowId).toBe(fixture.workflowId);
  expect(results[0]!.error, `${fixture.workflowType}: ${fixture.file}`).toBeInstanceOf(DeterminismViolationError);
}, 30_000);
