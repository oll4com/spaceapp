import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import proto from "@temporalio/proto";
import { TemporalHarness } from "./temporal-harness.js";
import { historyDirectory, replayHistories, type HistoryManifest } from "./temporal-replay.js";
import { runScenario, scenarios } from "./temporal-scenarios.js";

const temporary = await mkdtemp(join(tmpdir(), "space-workflow-histories-"));
const manifest: HistoryManifest = {
  sdkVersion: "1.24.0",
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  histories: []
};
let harness: TemporalHarness | undefined;
let bundle: TemporalHarness["bundle"] | undefined;
try {
  for (const scenario of scenarios.filter(value => value.record)) {
    harness = await TemporalHarness.create();
    bundle = harness.bundle;
    const executions = await runScenario(harness, scenario);
    for (const [index, execution] of executions.entries()) {
      const file = `${scenario.name}--${index + 1}.json`;
      const message = proto.temporal.api.history.v1.History.create(execution.history);
      const json = proto.temporal.api.history.v1.History.toObject(message, { longs: String, bytes: String, enums: String });
      await writeFile(join(temporary, file), JSON.stringify(json, null, 2) + "\n");
      manifest.histories.push({ file, workflowId: execution.workflowId, runId: execution.runId,
        workflowType: execution.workflowType, scenario: scenario.name,
        prePatch: Boolean(scenario.legacy && execution.workflowType === "roomAgentSupervisorWorkflow") });
    }
    await harness.close(); harness = undefined;
    console.log(`Recorded ${scenario.name}: ${executions.length} execution(s)`);
  }
  await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const count = await replayHistories(temporary, bundle);
  // Existing fixtures remain untouched until all scenarios AND replays succeed.
  let previous: HistoryManifest | undefined;
  try { previous = JSON.parse(await readFile(join(historyDirectory, "manifest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(historyDirectory, { recursive: true });
  for (const entry of manifest.histories) await copyFile(join(temporary, entry.file), join(historyDirectory, entry.file));
  await copyFile(join(temporary, "manifest.json"), join(historyDirectory, "manifest.json"));
  for (const entry of previous?.histories ?? []) {
    if (!manifest.histories.some(next => next.file === entry.file)) await rm(join(historyDirectory, entry.file));
  }
  console.log(`Updated ${count} verified synthetic histories in ${historyDirectory}`);
} finally {
  await harness?.close();
  await rm(temporary, { recursive: true, force: true });
}
