import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import temporalProto from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { basicScenarios, type Capture } from "./basic-scenarios.js";
import { bundle, Harness } from "./harness.js";
import { supervisorScenarios } from "./supervisor-scenarios.js";

const fixtureDirectory = new URL("../../fixtures/workflow-histories/", import.meta.url);
const { temporal } = temporalProto;
const args = process.argv.slice(2);
const patch = args[0] === "--patch" && args.length === 2 ? args[1] : undefined;
assert.ok(args.length === 1 && args[0] === "--initial" || patch,
  "Explicit recording only: use --initial for the first corpus, or --patch <patched-id> to add versioned histories");
if (patch) {
  assert.match(patch, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/, "Invalid patch ID");
  const sourceFiles = ["workflows.ts", "memory-maintenance-workflows.ts", "memory-mutation-workflows.ts"];
  const sources = await Promise.all(sourceFiles.map(file => readFile(new URL(`../../../src/${file}`, import.meta.url), "utf8")));
  assert.ok(sources.some(source => source.includes(`patched("${patch}")`) || source.includes(`patched('${patch}')`)),
    `Refusing to record: no production patched(${JSON.stringify(patch)}) change exists`);
}
await mkdir(fixtureDirectory, { recursive: true });
const existing = (await readdir(fixtureDirectory)).filter(name => name.endsWith(".json"));
if (!patch) assert.equal(existing.length, 0, "Initial histories already exist; never overwrite them to make replay pass");
const prefix = patch ? `patch-${patch}-` : "";
assert.ok(!existing.some(name => name.startsWith(prefix)), "This history generation already exists; previous fixtures are immutable");

const records = new Map<string, string>();
const recordedWorkflows = new Set<string>();
let branch: "current" | "legacy" = "current";
const capture: Capture = (name, workflowId, history) => {
  assert.match(name, /^[a-zA-Z0-9_-]+$/, "Invalid synthetic history name");
  assert.ok(!records.has(name), `Duplicate capture: ${name}`);
  const workflowType = history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
  assert.ok(workflowType && workflowId, `Incomplete captured history: ${name}`);
  recordedWorkflows.add(`${branch}:${workflowType}`);
  records.set(name, JSON.stringify({ schemaVersion: 1, name, workflowId, workflowType, branch,
    history: temporal.api.history.v1.History.create(history).toJSON() }, null, 2) + "\n");
};

for (const variant of [undefined, "legacy"] as const) {
  branch = variant ?? "current";
  const code = await bundle(variant);
  const harness = new Harness(await TestWorkflowEnvironment.createTimeSkipping({
    client: { identity: "synthetic-history-recorder" }
  }));
  const queue = `synthetic-record-${branch}`;
  try {
    await harness.startWorkers(code, queue);
    if (!variant) await basicScenarios(harness, queue, capture);
    await supervisorScenarios(harness, queue, capture, variant === "legacy");
  } finally {
    await harness.close();
  }
}

// Collect and validate all scenarios before writing. Exclusive creation never
// rewrites a baseline, including when another recorder races this command.
for (const workflowType of [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
]) {
  assert.ok(records.has(workflowType) && recordedWorkflows.has(`current:${workflowType}`),
    `Missing required current workflow capture: ${workflowType}`);
}
assert.ok(recordedWorkflows.has("legacy:roomAgentSupervisorWorkflow"), "Missing legacy supervisor execution");
for (const name of [
  "roomAgentSupervisorWorkflow-legacy", "roomAgentSupervisorWorkflow-legacy-settle",
  "roomAgentSupervisorWorkflow-current-rollover", "roomAgentSupervisorWorkflow-current-successor",
  "roomAgentSupervisorWorkflow-legacy-rollover", "roomAgentSupervisorWorkflow-legacy-successor",
  "dotGoalWorkflow-wake", "dotGoalWorkflow-rollover"
]) assert.ok(records.has(name), `Missing required regression capture: ${name}`);
for (const [name, contents] of records) {
  const filename = `${prefix}${name}.json`;
  await writeFile(new URL(filename, fixtureDirectory), contents, { flag: "wx" });
  console.log(`Recorded ${filename}`);
}
console.log("Recording complete. Inspect the synthetic fixtures and run the ordinary worker tests; old histories must remain in review.");
