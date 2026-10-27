import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { temporal } from "@temporalio/proto";
import { historiesDirectory, historyNames, workflowBundle } from "./support/workflow-sandbox.js";

/** Decode a checked-in history with the protobuf version used by the pinned Temporal SDK. */
async function history(name: string) {
  // Construct with the same protobuf package as the declared SDK, rather than
  // relying on protobufjs resolving another workspace's duplicate module.
  return temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(resolve(historiesDirectory, `${name}.json`), "utf8")));
}

it("replays every required workflow and the pre-patch supervisor history", async () => {
  const files = (await readdir(historiesDirectory)).filter(file => file.endsWith(".json")).sort();
  expect(files).toEqual(historyNames.map(name => `${name}.json`).sort());
  /** Label replay inputs so determinism failures identify the workflow and fixture file. */
  async function* histories() {
    for (const name of historyNames) yield { workflowId: `${name} (${name}.json)`, history: await history(name) };
  }
  const replayed: string[] = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle() }, histories())) {
    expect(result.error, `Replay failed for ${result.workflowId}: ${result.error?.message}`).toBeUndefined();
    replayed.push(result.workflowId);
  }
  expect(replayed).toHaveLength(historyNames.length);
}, 60_000);

it("rejects an extra timer with a determinism error naming the workflow and history", async () => {
  /** Label replay inputs so determinism failures identify the workflow and fixture file. */
  async function* histories() {
    yield { workflowId: "dotGoalWorkflow (dotGoalWorkflow.json)", history: await history("dotGoalWorkflow") };
  }
  const failures = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle("drift") }, histories())) {
    expect(result.workflowId).toBe("dotGoalWorkflow (dotGoalWorkflow.json)");
    expect(result.error, result.workflowId).toBeInstanceOf(DeterminismViolationError);
    failures.push(result.error);
  }
  expect(failures).toHaveLength(1);
}, 30_000);
