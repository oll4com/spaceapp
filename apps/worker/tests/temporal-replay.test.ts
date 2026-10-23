import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import proto from "@temporalio/proto";
import { describe, expect, it } from "vitest";

const directory = new URL("./fixtures/workflow-histories/", import.meta.url);
const workflowsPath = fileURLToPath(new URL("./support/temporal-replay-workflows.ts", import.meta.url));
const required = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow-legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];

describe("recorded workflow compatibility", () => {
  it("replays every committed history against the current production workflows", async () => {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(expect.arrayContaining(required.map((name) => `${name}.json`)));
    const names = new Map<string, string>();
    const histories = await Promise.all(files.map(async (file) => {
      const fixture = JSON.parse(await readFile(new URL(file, directory), "utf8"));
      expect(fixture.workflowId, `${file}: recorded workflowId`).toBeTypeOf("string");
      const history = proto.temporal.api.history.v1.History.fromObject(fixture.history);
      const workflowType = history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
      const base = file.replace(/\.json$/, "");
      if (required.includes(base)) expect(workflowType, `${file}: workflow type`).toBe(base.replace(/-legacy$/, ""));
      if (base === "roomAgentSupervisorWorkflow-legacy") {
        expect(history.events?.filter((event) => event.markerRecordedEventAttributes?.markerName === "core_patch"), "legacy history must not contain a patch marker").toEqual([]);
      }
      expect(names.has(fixture.workflowId), `${file}: duplicate recorded workflow ID`).toBe(false);
      names.set(fixture.workflowId, file);
      return { workflowId: fixture.workflowId, history };
    }));
    let count = 0;
    for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
      expect(result.error, `Replay failed for workflow ${result.workflowId}, history ${names.get(result.workflowId)}: ${result.error?.message ?? ""}`).toBeUndefined();
      count++;
    }
    expect(count).toBe(files.length);
  }, 60_000);

  it("rejects an extra timer in dotGoalWorkflow with DeterminismViolationError", async () => {
    const filename = "dotGoalWorkflow.json";
    const fixture = JSON.parse(await readFile(new URL(filename, directory), "utf8"));
    const history = proto.temporal.api.history.v1.History.fromObject(fixture.history);
    const target = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
    const loader = fileURLToPath(new URL("./support/temporal-nondeterminism-loader.cjs", import.meta.url));
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath,
      webpackConfigHook(config) {
        config.module ??= {};
        config.module.rules ??= [];
        config.module.rules.push({ test: (resource: string) => resource === target, enforce: "pre", use: [loader] });
        return config;
      }
    });
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle }, [{ workflowId: fixture.workflowId, history }])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.workflowId).toBe(fixture.workflowId);
    expect(results[0]?.error, `Negative replay control for dotGoalWorkflow/${filename}`).toBeInstanceOf(DeterminismViolationError);
  }, 60_000);
});
