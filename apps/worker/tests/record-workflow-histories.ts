import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { additionalScenarios, basicScenarios, memoryScenarios } from "./support/workflow-scenarios.js";
import { supervisorScenarios } from "./support/supervisor-scenarios.js";
import { createTestEnvironment, runScenario } from "./support/temporal-test-harness.js";
import { assertPrePatchSupervisor, assertSyntheticHistory, fixtureDirectory, serializeHistory, sha256, workflowTypes, type FixtureEntry } from "./support/workflow-history-fixtures.js";

// Deliberately not part of ordinary test execution. Never overwrite a baseline.
await mkdir(fixtureDirectory, { recursive: true });
try {
  await access(`${fixtureDirectory}/manifest.json`);
  throw new Error("Baselines already exist. Preserve them; a reviewed patched() change needs an additive recorder revision, not regeneration.");
} catch (error: any) { if (error.code !== "ENOENT") throw error; }
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const sourceHashes: Record<string, string> = {};
for (const name of ["workflows.ts", "dot-goal-loop.ts", "room-supervisor-state.ts", "memory-maintenance-workflows.ts", "memory-mutation-workflows.ts"]) {
  sourceHashes[name] = sha256(await readFile(new URL(`../src/${name}`, import.meta.url), "utf8"));
}
const env = await createTestEnvironment();
const entries: FixtureEntry[] = [];
try {
  const pendingFiles: Array<{ file: string; text: string }> = [];
  for (const scenario of [...basicScenarios, ...memoryScenarios, ...supervisorScenarios, ...additionalScenarios]) {
    console.log(`Recording scenario: ${scenario.name}`);
    for (const captured of await runScenario(env, scenario)) {
      if (captured.legacy) assertPrePatchSupervisor(captured.history);
      const text = serializeHistory(captured.history); assertSyntheticHistory(text);
      const file = `${captured.label}.json`;
      pendingFiles.push({ file, text });
      entries.push({ file, workflowId: captured.workflowId, workflowType: captured.workflowType, scenario: scenario.name, legacy: captured.legacy, sha256: sha256(text) });
    }
  }
  assert.deepEqual([...new Set(entries.map(item => item.workflowType))].sort(), [...workflowTypes].sort());
  assert.ok(entries.some(item => item.workflowType === "roomAgentSupervisorWorkflow" && item.legacy));
  for (const { file, text } of pendingFiles) await writeFile(`${fixtureDirectory}/${file}`, text, { flag: "wx" });
  await writeFile(`${fixtureDirectory}/manifest.json`, JSON.stringify({ schemaVersion: 1, sdkVersion: "1.24.0", sourceCommit, sourceHashes, histories: entries }, null, 2) + "\n", { flag: "wx" });
  console.log(`Recorded ${entries.length} synthetic histories; ordinary tests only read them.`);
} finally { await env.teardown(); }
