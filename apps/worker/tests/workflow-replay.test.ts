import { Worker, type ReplayWorkerOptions } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");
const HISTORIES = path.resolve(__dirname, "fixtures/workflow-histories");

const WORKFLOWS = path.join(SRC, "workflows.ts");
const MAINTENANCE = path.join(SRC, "memory-maintenance-workflows.ts");
const MUTATION = path.join(SRC, "memory-mutation-workflows.ts");

/** Each recorded file replays against the module its production worker ships. */
function bundleFor(file: string): string {
  if (file.startsWith("memoryMaintenance")) return MAINTENANCE;
  if (file.startsWith("memoryMutation")) return MUTATION;
  return WORKFLOWS;
}

async function historyFor(file: string) {
  // @temporalio/proto builds the protobuf message the replay worker expects;
  // historyFromJSON cannot be used because the workspace pins protobufjs 7 for
  // @grpc/proto-loader while @temporalio/common loads protobufjs 8.
  const proto: any = await import("@temporalio/proto");
  const History = proto.default.temporal.api.history.v1.History;
  const events = JSON.parse(await readFile(path.join(HISTORIES, file), "utf8"));
  return History.fromObject({ events });
}

async function replayOne(
  file: string,
  workflowsPath: string
): Promise<Array<{ workflowId: string; error?: string }>> {
  const options: ReplayWorkerOptions = {
    workflowsPath,
    taskQueue: "space-replay",
    activities: {}
  };
  const results: Array<{ workflowId: string; error?: string }> = [];
  const iterable = Worker.runReplayHistories(options, [
    { workflowId: `replay:${file}`, history: await historyFor(file) }
  ]);
  for await (const result of iterable) {
    results.push({
      workflowId: result.workflowId,
      ...(result.error ? { error: `${result.error.name}: ${result.error.message}` } : {})
    });
  }
  return results;
}

describe("replay gate", () => {
  it("has a recorded history for every workflow module under test", async () => {
    const files = (await readdir(HISTORIES)).filter((name) => name.endsWith(".json"));
    expect(files).toContain("dotGoalWorkflow.json");
    expect(files).toContain("dummyTurnWorkflow.json");
    expect(files).toContain("memoryMutationWorkflow.json");
    expect(files).toContain("memoryMaintenanceWorkflow.json");
  }, 30_000);

  it("replays every recorded history without a determinism violation", async () => {
    const files = (await readdir(HISTORIES)).filter((name) => name.endsWith(".json")).sort();
    const failures: string[] = [];
    for (const file of files) {
      const results = await replayOne(file, bundleFor(file));
      expect(results.length).toBe(1);
      for (const result of results) {
        if (result.error) failures.push(`${file}: ${result.error}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("fails replay when a workflow gains a timer the history does not contain", async () => {
    // The test-only variant sleeps before its first activity; the recorded run did not.
    const variant = path.resolve(__dirname, "fixtures/replay-violation-workflows.ts");
    const results = await replayOne("dummyTurnWorkflow.json", variant);
    expect(results.length).toBe(1);
    expect(results[0].error).toBeTruthy();
    expect(results[0].error).toMatch(/determinis|nondeterminis/i);
  }, 600_000);
});
