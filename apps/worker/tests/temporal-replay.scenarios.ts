import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import proto from "@temporalio/proto";
const { temporal } = proto;
import { jsonPayload, productionBundle } from "./support/temporal-harness.js";

const directory = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));
const required = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentActionWorkflow",
  "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow",
  "roomAgentSupervisorWorkflow-current", "roomAgentSupervisorWorkflow-pre-patch"];
async function fixture(filename: string) {
  return { workflowId: filename, history: temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(`${directory}/${filename}`, "utf8"))) };
}

describe("recorded production workflow replay", () => {
  it("replays every committed history, including the genuine pre-patch supervisor branch", async () => {
    const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
    for (const name of required) expect(files, `missing required fixture ${name}`).toContain(`${name}.json`);
    const histories = await Promise.all(files.map(fixture));
    for (const suffix of ["current", "pre-patch"]) {
      const history = histories.find(entry => entry.workflowId === `roomAgentSupervisorWorkflow-${suffix}.json`)!.history;
      const events = history.events;
      const activities = events.flatMap(event => event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes.activityType?.name] : []);
      expect(activities).toEqual([suffix === "current" ? "prepareRoomAgentBackgroundContinuation" : "settleRoomAgentBackgroundMission"]);
      const patches = events.flatMap(event => {
        const marker = event.markerRecordedEventAttributes;
        const payload = marker?.details?.["patch-data"]?.payloads?.[0];
        return payload ? [jsonPayload(payload).id] : [];
      });
      expect(patches.includes("room-background-continuation-v1")).toBe(suffix === "current");
      const completedActivity = events.findLastIndex(event => event.activityTaskCompletedEventAttributes);
      expect(events.slice(completedActivity + 1).some(event => event.workflowTaskCompletedEventAttributes), "Supervisor fixture must consume its settle result").toBe(true);
    }
    let count = 0;
    for await (const result of Worker.runReplayHistories({ workflowBundle: await productionBundle() }, histories)) {
      if (result.error) throw new Error(`Replay failed for workflow/history ${result.workflowId}: ${result.error.message}`, { cause: result.error });
      count++;
    }
    expect(count).toBe(files.length);
  }, 60_000);

  it("rejects an unpatched extra timer with DeterminismViolationError", async () => {
    const filename = "dotGoalWorkflow.json";
    const results = [];
    for await (const result of Worker.runReplayHistories({
      workflowsPath: fileURLToPath(new URL("./support/non-deterministic-workflows.ts", import.meta.url))
    }, [await fixture(filename)])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.workflowId).toBe(filename);
    expect(results[0]?.error, `Expected determinism failure: dotGoalWorkflow / ${filename}`).toBeInstanceOf(DeterminismViolationError);
  }, 60_000);
});
