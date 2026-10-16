import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundle, type WorkerOptions } from "@temporalio/worker";
import { defaultPayloadConverter } from "@temporalio/common";
import type { WorkflowHandleWithStartDetails } from "@temporalio/client";
import { temporal } from "@temporalio/proto";

export const here = dirname(fileURLToPath(import.meta.url));
export const fixtures = resolve(here, "../fixtures/workflow-histories");
export const recording = process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1";
export type History = temporal.api.history.v1.IHistory;
export type Handle = WorkflowHandleWithStartDetails;
export type Activities = NonNullable<WorkerOptions["activities"]>;

export function bundle(legacy = false) {
  return bundleWorkflowCode({
    workflowsPath: resolve(here, "workflows.ts"),
    webpackConfigHook(config) {
      config.resolve = { ...config.resolve, alias: {
        ...config.resolve?.alias,
        "@space/contracts": resolve(here, "../../../../packages/contracts/src/index.ts")
      } };
      if (legacy) config.module!.rules!.unshift({
        include: resolve(here, "../../src/workflows.ts"),
        enforce: "pre", use: [{ loader: resolve(here, "historical-workflow-loader.cjs") }]
      });
      return config;
    }
  });
}

export async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(5);
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function signalProcessed(handle: Handle, name: string, value?: unknown) {
  const before = (await handle.fetchHistory()).events?.length ?? 0;
  await handle.signal(name, ...(value === undefined ? [] : [value]));
  await until(async () => {
    const events = (await handle.fetchHistory()).events?.slice(before) ?? [];
    const signaled = events.findIndex(e => e.workflowExecutionSignaledEventAttributes);
    return signaled >= 0 && events.slice(signaled + 1).some(e => e.workflowTaskCompletedEventAttributes);
  }, `workflow task processing ${name}`);
}

export function continuedInput(history: History): any {
  const event = history.events?.find(e => e.workflowExecutionContinuedAsNewEventAttributes);
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) throw new Error("Expected a continued-as-new event with carried input");
  return defaultPayloadConverter.fromPayload(payload);
}

export class Harness {
  private sequence = 0;
  constructor(readonly env: TestWorkflowEnvironment, readonly current: WorkflowBundle, readonly legacy: WorkflowBundle) {}

  async advanceUntil(predicate: () => boolean, message: string) {
    await until(async () => {
      if (predicate()) return true;
      await this.env.sleep("1 second");
      return predicate();
    }, message);
  }

  async run<T>(activities: Activities, body: (s: Scenario) => Promise<T>, legacy = false) {
    const taskQueue = `temporal-proof-${++this.sequence}`;
    // The memory workflow explicitly dispatches child work/mutations to these queues.
    const queues = [taskQueue];
    if ("prepareMemoryConsolidation" in activities) queues.push("space-memory-maintenance");
    if ("executePersistedMemoryChangeSet" in activities) queues.push("space-memory-mutations");
    const workers = await Promise.all(queues.map(taskQueue => Worker.create({
      connection: this.env.nativeConnection, taskQueue,
      workflowBundle: legacy ? this.legacy : this.current,
      activities, shutdownGraceTime: "0 seconds", maxCachedWorkflows: 20,
      maxConcurrentWorkflowTaskExecutions: 4, maxConcurrentActivityTaskExecutions: 4
    })));
    const scenario = new Scenario(this.env, taskQueue);
    const invoke = async () => { try { return await body(scenario); } finally { await scenario.close(); } };
    const run = (index: number): Promise<T> => index === workers.length ? invoke() : workers[index]!.runUntil(() => run(index + 1));
    return run(0);
  }
}

export class Scenario {
  private handles: Handle[] = [];
  constructor(readonly env: TestWorkflowEnvironment, readonly taskQueue: string) {}
  async start(type: string, input: unknown, workflowId = `${this.taskQueue}-${type}`) {
    const handle = await this.env.client.workflow.start(type, { taskQueue: this.taskQueue, workflowId, args: [input] });
    this.handles.push(handle);
    return handle;
  }
  async originalHistory(handle: Handle) {
    return this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
  }
  async waitForContinue(handle: Handle) {
    await until(async () => (await this.originalHistory(handle)).events!.some(e => e.workflowExecutionContinuedAsNewEventAttributes), "continue-as-new");
    return this.originalHistory(handle);
  }
  async save(name: string, history: History) {
    if (!recording) return;
    await mkdir(fixtures, { recursive: true });
    // Worker identities and activity failure stacks contain the recording host's
    // username/path. Neither participates in replay; keep only synthetic data.
    const json = temporal.api.history.v1.History.toObject(temporal.api.history.v1.History.fromObject(history), {
      longs: String, bytes: String, enums: String
    });
    const clean = (value: any): any => Array.isArray(value) ? value.map(clean)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) =>
        [key, key === "identity" ? "synthetic-test-worker" : key === "stackTrace" ? "Synthetic test failure" : clean(entry)])) : value;
    await writeFile(resolve(fixtures, `${name}.json`), JSON.stringify(clean(json), null, 2) + "\n");
  }
  async finish(handle: Handle, name?: string) {
    const status = await handle.describe();
    if (status.status.name === "RUNNING") await handle.terminate("Synthetic test complete");
    const history = await this.originalHistory(handle);
    if (name) await this.save(name, history);
    return history;
  }
  async close() {
    for (const handle of this.handles) await this.finish(handle);
  }
}
