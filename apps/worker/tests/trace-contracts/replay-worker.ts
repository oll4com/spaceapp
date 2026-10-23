// Executed only by replay-process.ts, never as production workflow code.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker, Runtime, DefaultLogger } from "@temporalio/worker";
import { decodeHistory } from "./history-codec.js";

const [mode, bundlePath, directory, laneText] = process.argv.slice(2);
assert(bundlePath && directory && (mode === "positive" || mode === "negative"));
Runtime.install({ logger: new DefaultLogger("ERROR") });
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const workflowBundle = { codePath: bundlePath };
const load = async (entry: any) => {
  assert(/^[a-z0-9-]+\.json$/.test(entry.file));
  const text = await readFile(join(directory, entry.file), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), entry.sha256, entry.file);
  const history = decodeHistory(JSON.parse(text));
  assert.equal(history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name, entry.workflowType);
  return { workflowId: entry.workflowId, history };
};
let report: unknown;
if (mode === "positive") {
  const lane = Number(laneText);
  assert(lane === 0 || lane === 1);
  const entries = manifest.filter((_: unknown, index: number) => index % 2 === lane);
  const histories = await Promise.all(entries.map(load));
  const results: Array<{
    file: string;
    workflowType: string;
    error: { name: string; message: string } | null;
  }> = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle }, histories)) {
    const entry = entries[results.length];
    assert(entry);
    assert.equal(result.workflowId, entry.workflowId);
    results.push({ file: entry.file, workflowType: entry.workflowType,
      error: result.error ? { name: result.error.name, message: result.error.message } : null });
  }
  assert.equal(results.length, entries.length);
  report = { results };
} else {
  const entry = manifest.find((item: any) => item.workflowType === "dotGoalWorkflow");
  assert(entry);
  const { history, workflowId } = await load(entry);
  let error: { name: string; message: string } | null = null;
  try { await Worker.runReplayHistory({ workflowBundle }, history, workflowId); }
  catch (failure) {
    assert(failure instanceof Error);
    error = { name: failure.name, message: failure.message };
  }
  report = { file: entry.file, workflowType: entry.workflowType, error };
}
process.stdout.write(`SPACEAPP_REPLAY_RESULT=${JSON.stringify(report)}\n`);
