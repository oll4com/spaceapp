import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeterminismViolationError } from "@temporalio/workflow";
import { Worker, bundleWorkflowCode, type WorkflowBundle } from "@temporalio/worker";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = path.join(repoRoot, "apps/worker/tests/fixtures/workflow-histories");
const workflowEntry = path.join(repoRoot, "apps/worker/tests/support/temporal-workflows.ts");
const negativeWorkflowEntry = path.join(repoRoot, "apps/worker/tests/support/temporal-negative-workflows.ts");

async function bundle(entry: string): Promise<WorkflowBundle> {
  return bundleWorkflowCode({
    workflowsPath: entry,
    webpackConfigHook(config) {
      config.resolve ??= {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "@space/contracts": path.join(repoRoot, "packages/contracts/src/index.ts")
      };
      return config;
    }
  });
}

async function fixture(name: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(fixtureRoot, `${name}.json`), "utf8"));
}

describe("Temporal replay gate", () => {
  it("replays every recorded workflow history with the production bundle", async () => {
    const files = (await fs.readdir(fixtureRoot)).filter((file) => file.endsWith(".json")).sort();
    for (const required of [
      "dummy-turn.json",
      "dot-goal-wake.json",
      "dot-goal-timeout.json",
      "codex-app-server-turn.json",
      "room-agent-supervisor.json",
      "room-agent-supervisor-prepatch.json",
      "room-agent-action-failure.json",
      "memory-maintenance.json",
      "memory-consolidation.json",
      "memory-mutation.json"
    ]) expect(files).toContain(required);
    const histories = await Promise.all(files.map(async (file) => ({
      history: JSON.parse(await fs.readFile(path.join(fixtureRoot, file), "utf8")),
      workflowId: `fixture-${file.replace(/\.json$/, "")}`
    })));
    const workflowBundle = await bundle(workflowEntry);
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle }, histories)) results.push(result);
    expect(results).toHaveLength(files.length);
    for (const result of results) expect(result.error, `replay failed for ${result.workflowId}`).toBeUndefined();
  }, 180_000);

  it("fails when a test-only workflow adds an unrecorded timer", async () => {
    const history = await fixture("dummy-turn");
    const workflowBundle = await bundle(negativeWorkflowEntry);
    let thrown: unknown;
    try {
      await Worker.runReplayHistory({ workflowBundle }, history, "negative-dummy-turn");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeterminismViolationError);
    expect(String((thrown as Error)?.message)).toMatch(/determin|nondetermin/i);
  }, 180_000);
});
