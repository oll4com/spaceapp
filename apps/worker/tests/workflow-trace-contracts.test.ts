import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, afterAll, test, expect } from "vitest";
import { encodeHistory } from "./trace-contracts/history-codec.js";
import { replayInChild } from "./trace-contracts/replay-process.js";
import { environment, runScenario, bundle, checksum, type Recording } from "./trace-contracts/harness.js";
import { basicScenarios } from "./trace-contracts/basic-scenarios.js";
import { supervisorScenarios } from "./trace-contracts/supervisor-scenarios.js";
import { historicalScenario } from "./trace-contracts/historical-scenario.js";

const record = process.env.SPACEAPP_RECORD_HISTORIES === "1";
const fixtureDir = record && process.env.SPACEAPP_HISTORY_OUTPUT
  ? resolve(process.env.SPACEAPP_HISTORY_OUTPUT) + "/"
  : fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));
const collected: Recording[] = [];
const scenarios = [...basicScenarios, ...supervisorScenarios, historicalScenario];
let completed = 0;
let shared: Awaited<ReturnType<typeof environment>>;
let start: number;
let replayCount = 0;
let replayDuration = 0;
type ManifestEntry = { file: string; sha256: string; workflowId: string; workflowType: string; mode: string };
const replayFailure = (entry: ManifestEntry, error: unknown) => `${entry.workflowType} (${entry.file}): ${String(error)}`;

beforeAll(async () => {
  start = performance.now();
  if (record) {
    await mkdir(fixtureDir, { recursive: true });
    assert(!(await readdir(fixtureDir)).some(name => name.endsWith(".json")),
      "Refusing to overwrite recorded history. Preserve existing baselines; see fixture README.");
  }
  shared = await environment();
  await bundle("current");
}, 90_000);

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    // Time is global to a Temporal test server. Supervisors intentionally never
    // finish, so each owns a disposable server; finite traces share a serial one.
    const privateServer = scenario.workflowType === "roomAgentSupervisorWorkflow";
    const env = privateServer ? await environment() : shared;
    try { collected.push(...await runScenario(env, scenario)); completed++; }
    finally { if (privateServer) await env.teardown(); }
  }, 35_000);
}

test("all stored histories replay without changing production behavior", async () => {
  if (record) {
    assert.equal(completed, scenarios.length, "Refusing to record an incomplete scenario run");
    const entries: ManifestEntry[] = [];
    const seen = new Set<string>();
    for (const item of collected) {
      const file = `${item.label}.json`;
      assert(/^[a-z0-9-]+\.json$/.test(file), `Unsafe history label ${item.label}`);
      assert(!seen.has(file), `Duplicate history label ${file}`); seen.add(file);
      const text = encodeHistory(item.history);
      await writeFile(fixtureDir + file, text, { flag: "wx" });
      entries.push({ file, sha256: checksum(text), workflowId: item.workflowId, workflowType: item.workflowType, mode: item.mode });
    }
    await writeFile(fixtureDir + "manifest.json", JSON.stringify(entries, null, 2) + "\n", { flag: "wx" });
  }
  const entries = JSON.parse(await readFile(fixtureDir + "manifest.json", "utf8")) as ManifestEntry[];
  expect(new Set(entries.map(x => x.file)).size, "Duplicate manifest filenames").toBe(entries.length);
  expect((await readdir(fixtureDir)).filter(x => x.endsWith(".json") && x !== "manifest.json").sort())
    .toEqual(entries.map(x => x.file).sort());
  expect(new Set(entries.map(x => x.workflowType))).toEqual(new Set([
    "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
    "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
  ]));
  expect(entries.some(x => x.mode === "legacy" && x.workflowType === "roomAgentSupervisorWorkflow")).toBe(true);
  expect(entries.some(x => x.mode === "historical" && x.workflowType === "roomAgentSupervisorWorkflow")).toBe(true);
  for (const entry of entries) {
    assert(/^[a-z0-9-]+\.json$/.test(entry.file), `Unsafe manifest filename ${entry.file}`);
    const text = await readFile(fixtureDir + entry.file, "utf8");
    expect(checksum(text), entry.file).toBe(entry.sha256);
  }
  const replayStart = performance.now();
  const workflowBundle = await bundle("current");
  // Separate processes provide real two-CPU replay parallelism and a parent
  // deadline that still fires if a regression blocks an isolate synchronously.
  const lanes = await Promise.allSettled([0, 1].map(lane => replayInChild(workflowBundle, fixtureDir, "positive", lane)));
  const results = [];
  for (const lane of lanes) {
    if (lane.status === "rejected") throw lane.reason;
    results.push(...lane.value.results);
  }
  expect(results.map(x => x.file).sort()).toEqual(entries.map(x => x.file).sort());
  for (const result of results) {
    const entry = entries.find(x => x.file === result.file)!;
    expect(result.error, replayFailure(entry, result.error && `${result.error.name}: ${result.error.message}`)).toBeNull();
  }
  replayCount = results.length;
  expect(replayCount).toBe(entries.length);
  replayDuration = performance.now() - replayStart;
}, 60_000);

test("an added timer is rejected rather than silently accepting incompatible replay", async () => {
  const entries = JSON.parse(await readFile(fixtureDir + "manifest.json", "utf8")) as ManifestEntry[];
  const goal = entries.find(x => x.workflowType === "dotGoalWorkflow")!;
  assert(goal, "Missing goal workflow baseline");
  const result = await replayInChild(await bundle("negative"), fixtureDir, "negative");
  const failure = result.error;
  expect(failure, replayFailure(goal, failure)).toMatchObject({ name: "DeterminismViolationError" });
  expect(replayFailure(goal, failure)).toContain("dotGoalWorkflow");
  expect(replayFailure(goal, failure)).toContain(goal.file);
}, 50_000);

afterAll(async () => {
  await shared?.teardown();
  const elapsed = performance.now() - start;
  console.log(`TRACE_REPLAY_HISTORIES=${replayCount};TRACE_REPLAY_DURATION_MS=${replayDuration.toFixed(1)}`);
  console.log(`TRACE_CONTRACT_DURATION_MS=${elapsed.toFixed(1)}`);
  // This is the issuer's real acceptance budget, not a mocked clock.
  expect(elapsed, "Added Temporal sandbox and replay suite exceeded 180 seconds").toBeLessThan(180_000);
}, 30_000);
