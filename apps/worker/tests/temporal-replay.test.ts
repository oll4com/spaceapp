import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bundleWorkflowCode, DefaultLogger, Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { temporal } from "@temporalio/proto";
import { workflowBundle } from "./support/temporal-sandbox.js";

const directory = new URL("./fixtures/workflow-histories/", import.meta.url);
type Entry = { file: string; workflowType: string; workflowId: string; sha256: string; branch?: string };

async function fixtures() {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as { sdkVersion: string; histories: Entry[] };
  const workerPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.sdkVersion).toBe(workerPackage.devDependencies["@temporalio/testing"]);
  expect(new Set(manifest.histories.map(entry => entry.workflowType))).toEqual(new Set([
    "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
    "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"
  ]));
  expect(manifest.histories.some(entry => entry.workflowType === "roomAgentSupervisorWorkflow" && entry.branch === "pre-patch")).toBe(true);
  expect((await readdir(directory)).filter(file => file.endsWith(".json") && file !== "manifest.json").sort())
    .toEqual(manifest.histories.map(entry => entry.file).sort());
  return Promise.all(manifest.histories.map(async entry => {
    const content = await readFile(new URL(entry.file, directory), "utf8");
    expect(createHash("sha256").update(content).digest("hex"), entry.file).toBe(entry.sha256);
    const history = JSON.parse(content);
    expect(history.events[0].workflowExecutionStartedEventAttributes.workflowType.name, entry.file).toBe(entry.workflowType);
    if (entry.branch === "pre-patch") expect(history.events.filter((event: any) => event.markerRecordedEventAttributes?.markerName === "core_patch"), entry.file).toHaveLength(0);
    // The recorder uses the SDK's protobuf object JSON (seconds/nanos and base64 bytes),
    // so restore its Long/Uint8Array fields before handing it to the replay worker.
    return { ...entry, history: temporal.api.history.v1.History.fromObject(history) };
  }));
}

it("replays every immutable committed history against the current production workflow bundle", async () => {
  const entries = await fixtures();
  const byId = new Map(entries.map(entry => [entry.workflowId, entry]));
  let count = 0;
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle() }, entries)) {
    count++;
    const entry = byId.get(result.workflowId)!;
    expect(result.error, `${entry.workflowType} (${entry.file}): ${result.error?.message ?? ""}`).toBeUndefined();
  }
  expect(count).toBe(entries.length);
  // Recording is a separate command; a test run must never replace its own oracle.
  await fixtures();
}, 60_000);

it("detects an added timer in a test-only variant with DeterminismViolationError", async () => {
  const entry = (await fixtures()).find(entry => entry.workflowType === "dummyTurnWorkflow")!;
  await workflowBundle(); // Install the same logger/runtime before bundling the deliberate divergence.
  const divergent = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./support/temporal-replay-divergence.ts", import.meta.url)),
    logger: new DefaultLogger("ERROR")
  });
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: divergent }, [entry])) results.push(result);
  expect(results).toHaveLength(1);
  expect(results[0]!.error, `${entry.workflowType} (${entry.file}) must reject the extra timer`).toBeInstanceOf(DeterminismViolationError);
}, 60_000);
