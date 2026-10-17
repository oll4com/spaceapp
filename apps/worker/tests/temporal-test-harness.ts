import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowHandle } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

const here = dirname(fileURLToPath(import.meta.url));
export const historyDirectory = resolve(here, "fixtures/workflow-histories");
export interface ScenarioContext {
  env: TestWorkflowEnvironment;
  taskQueue: string;
  start(type: string, args: unknown[], workflowId?: string): Promise<WorkflowHandle>;
  record(handle: WorkflowHandle, name?: string): Promise<void>;
}
export interface Scenario {
  name: string;
  legacy?: boolean;
  activities: Record<string, (...args: any[]) => any>;
  run(ctx: ScenarioContext): Promise<void>;
}
export interface RecordedHistory { name: string; workflowId: string; history: unknown }
const bundles = new Map<string, Promise<WorkflowBundleWithSourceMap>>();

export function workflowBundle(variant: "current" | "legacy" | "negative" = "current") {
  if (!bundles.has(variant)) {
    bundles.set(variant, bundleWorkflowCode({
      workflowsPath: resolve(here, "support/temporal-workflows.ts"),
      logger: new DefaultLogger("ERROR"),
      webpackConfigHook(config) {
        config.resolve = { ...config.resolve, alias: {
          ...config.resolve?.alias,
          "@space/contracts": resolve(here, "../../../packages/contracts/src/index.ts")
        } };
        if (variant !== "current") {
          config.module = { ...config.module, rules: [
            ...(config.module?.rules ?? []),
            { test: /[\\/]apps[\\/]worker[\\/]src[\\/]workflows\.ts$/, enforce: "pre", use: [{
              loader: resolve(here, "support/temporal-test-variant.cjs"), options: { variant }
            }] }
          ] };
        }
        return config;
      }
    }));
  }
  return bundles.get(variant)!;
}

export async function runScenario(env: TestWorkflowEnvironment, scenario: Scenario): Promise<RecordedHistory[]> {
  const taskQueue = `sandbox-${randomUUID()}`;
  const handles: WorkflowHandle[] = [];
  const histories: RecordedHistory[] = [];
  const workflowBundleValue = await workflowBundle(scenario.legacy ? "legacy" : "current");
  const queues = "prepareMemoryConsolidation" in scenario.activities
    ? [taskQueue, "space-memory-maintenance", "space-memory-mutations"] : [taskQueue];
  const workers = await Promise.all(queues.map(queue => Worker.create({
    connection: env.nativeConnection, taskQueue: queue, workflowBundle: workflowBundleValue,
    identity: "synthetic-worker",
    activities: scenario.activities, shutdownGraceTime: "0 seconds"
  })));
  const ctx: ScenarioContext = {
    env, taskQueue,
    async start(type, args, workflowId = `synthetic-${scenario.name}-${randomUUID()}`) {
      const handle = await env.client.workflow.start(type, {
        taskQueue, workflowId, args, followRuns: false
      });
      handles.push(handle);
      return handle;
    },
    async record(handle, name = scenario.name) {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Unsafe fixture name ${name}`);
      const history = temporal.api.history.v1.History.toObject(temporal.api.history.v1.History.fromObject(await handle.fetchHistory()), {
        longs: String, enums: String, bytes: String
      });
      histories.push({ name, workflowId: handle.workflowId, history });
    }
  };
  let begin!: () => void;
  const ready = new Promise<void>(resolve => { begin = resolve; });
  const task = ready.then(async () => {
    try { await scenario.run(ctx); }
    finally {
      // Supervisors are deliberately infinite. Stop only this scenario's IDs.
      await Promise.all(handles.map(handle => env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test cleanup").catch(() => undefined)));
    }
  });
  const running = workers.map(worker => worker.runUntil(task));
  begin();
  await Promise.all(running);
  if (!histories.length) throw new Error(`${scenario.name} did not capture a real history`);
  return histories;
}

export async function saveHistories(histories: RecordedHistory[]) {
  await mkdir(historyDirectory, { recursive: true });
  for (const entry of histories) {
    await writeFile(resolve(historyDirectory, `${entry.name}.json`), JSON.stringify({ workflowId: entry.workflowId, history: entry.history }, null, 2) + "\n");
  }
}

export async function loadHistories(): Promise<RecordedHistory[]> {
  const files = (await readdir(historyDirectory)).filter(file => file.endsWith(".json")).sort();
  if (!files.length) throw new Error("No recorded histories: replay must never silently pass without fixtures");
  return Promise.all(files.map(async file => ({ name: file.slice(0, -5), ...JSON.parse(await readFile(resolve(historyDirectory, file), "utf8")) })));
}

export async function assertReplay(histories: RecordedHistory[], variant: "current" | "negative" = "current") {
  const results = [];
  const replayInputs = histories.map(entry => ({ workflowId: entry.workflowId,
    history: temporal.api.history.v1.History.fromObject(entry.history as Record<string, unknown>) }));
  for await (const result of Worker.runReplayHistories({ workflowBundle: await workflowBundle(variant) }, replayInputs)) {
    // The SDK replays inputs in order. Workflow IDs can repeat across runs or
    // versions, so indexing preserves the exact failing filename.
    results.push({ ...result, fixture: `${histories[results.length].name}.json` });
  }
  return results;
}
