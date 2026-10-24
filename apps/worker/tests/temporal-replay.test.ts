import { beforeAll, expect, inject, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import { defaultPayloadConverter } from "@temporalio/common";
import { DeterminismViolationError } from "@temporalio/workflow";

const directory = new URL("./fixtures/workflow-histories/", import.meta.url);
let bundle: { codePath: string };
let fixtures: Array<{ file: string; workflowId: string; history: any }>;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  bundle = { codePath: inject("temporalBundles").current };
  const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  fixtures = await Promise.all(names.map(async file => {
    const fixture = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    // Match the recorder's protobuf toObject format explicitly. This avoids the
    // CLI proto-JSON converter and works with the SDK's generated message type.
    return { file, workflowId: fixture.workflowId, history: temporal.api.history.v1.History.fromObject(fixture.history) };
  }));
}, 120_000);

it("verifies saved histories identify real workflow executions and preserve the pre-patch branch", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(9);
  const named = new Map(fixtures.map(f => [f.file, f]));
  for (const fixture of fixtures) {
    const expected = fixture.file.split("-")[0]!.replace(/\.json$/, "");
    const events = fixture.history.events ?? [];
    expect(events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name,
      `${fixture.file} must identify its actual Temporal workflow type`).toBe(expected);
    expect(events.some((event: any) => event.workflowTaskCompletedEventAttributes),
      `${fixture.file} must include a completed Temporal workflow task`).toBe(true);
  }
  for (const variant of ["legacy", "current"] as const) {
    for (const scenario of ["items", "polls"]) {
      const name = `roomAgentSupervisorWorkflow-${variant}-${scenario}.json`;
      const fixture = named.get(name);
      expect(fixture, `Missing recorded ${variant} ${scenario} history`).toBeDefined();
      const events = fixture!.history.events ?? [];
      const hasPatchMarker = events.some((event: any) => {
        const marker = event.markerRecordedEventAttributes;
        if (!["core_patch", "patch"].includes(marker?.markerName)) return false;
        const payload = marker.details?.["patch-data"]?.payloads?.[0];
        if (!payload) return false;
        const data = defaultPayloadConverter.fromPayload(payload) as { id?: string; deprecated?: boolean };
        return data.id === "room-background-continuation-v1" && data.deprecated === false;
      });
      expect(hasPatchMarker, `${name} must retain the appropriate patch marker`).toBe(variant === "current");
      expect(events.some((event: any) => event.workflowExecutionContinuedAsNewEventAttributes),
        `${name} must contain an actual continue-as-new event`).toBe(true);
    }
  }
});

it("replays every committed history against current production workflows", async () => {
  const required = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
    "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"];
  for (const type of required) expect(fixtures.some(f => f.file.startsWith(type)), `Missing history for ${type}`).toBe(true);
  expect(fixtures.some(f => f.file.includes("legacy")), "Missing pre-patch supervisor history").toBe(true);
  let currentFilename = "";
  let count = 0;
  function* histories() {
    for (const fixture of fixtures) {
      // A versioned recording can share a workflow ID with an older fixture.
      // runReplayHistories consumes this iterable sequentially; retain its exact
      // current filename instead of collapsing distinct versions in an ID map.
      currentFilename = fixture.file;
      console.log(`Replaying ${fixture.file} (${fixture.workflowId})`);
      yield fixture;
    }
  }
  for await (const result of Worker.runReplayHistories({ workflowBundle: bundle }, histories())) {
    count++;
    expect(result.error, `${currentFilename} (${result.workflowId}): ${result.error}`).toBeUndefined();
  }
  expect(count).toBe(fixtures.length);
}, 120_000);

it("rejects an inserted timer with DeterminismViolationError", async () => {
  const negative = { codePath: inject("temporalBundles").nondeterministic };
  const fixture = fixtures.find(f => f.file === "dotGoalWorkflow.json")!;
  expect(fixture).toBeDefined();
  const results = [];
  for await (const result of Worker.runReplayHistories({ workflowBundle: negative }, [fixture])) results.push(result);
  expect(results).toHaveLength(1);
  expect(results[0].workflowId).toBe(fixture.workflowId);
  expect(results[0].error, `${fixture.file} (${fixture.workflowId})`).toBeInstanceOf(DeterminismViolationError);
}, 60_000);
