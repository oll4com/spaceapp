import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { Context } from "@temporalio/activity";
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

export const workflowsPath = fileURLToPath(new URL("./temporal-workflows.ts", import.meta.url));
export const recording = process.env.SPACE_TEMPORAL_RECORD_HISTORIES === "1";
export const historyDirectory = recording && process.env.SPACE_TEMPORAL_HISTORY_DIR
  ? process.env.SPACE_TEMPORAL_HISTORY_DIR
  : fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));

export const activityNames = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runCodexAppServerTurn", "runOpenCodeAgentTurn",
  "runCliAgentTurn", "dotGoalStep", "dotGoalObserve", "markRoomAgentMissionStarted",
  "markRoomAgentMissionFinished", "markRoomAgentMissionContinued", "settleRoomAgentBackgroundMission",
  "prepareRoomAgentBackgroundContinuation", "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"
] as const;
type ActivityName = typeof activityNames[number];
type Handler = (...args: any[]) => unknown;
export type ActivityHandlers = Partial<Record<ActivityName, Handler>>;
export type ActivityCall = { name: ActivityName; args: any[]; attempt: number; runId: string };
type StartedHandle = WorkflowHandleWithFirstExecutionRunId;

export function syntheticFailure(nonRetryable = false) {
  const error = ApplicationFailure.create({ message: "Synthetic activity failure", type: "SyntheticFailure", nonRetryable });
  error.stack = "ApplicationFailure: Synthetic activity failure";
  return error;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, description: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Temporal test did not observe ${description}`);
}

export class TemporalHarness {
  env!: TestWorkflowEnvironment;
  workers: Worker[] = [];
  runs: Promise<void>[] = [];
  handles: StartedHandle[] = [];
  stopDrivers: Array<() => Promise<void>> = [];
  calls: ActivityCall[] = [];
  handlers: ActivityHandlers = {};
  bundle!: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  legacyBundle!: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  workerFailure?: unknown;
  readonly taskQueue = "spaceapp-synthetic-workflows";
  readonly legacyTaskQueue = "spaceapp-synthetic-legacy-workflows";

  async prepare() {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    const logger = new DefaultLogger("ERROR");
    this.bundle = await bundleWorkflowCode({ workflowsPath, logger });
    this.legacyBundle = await bundleWorkflowCode({
      workflowsPath, logger,
      webpackConfigHook(config) {
        config.module!.rules!.push({
          test: /[/\\]src[/\\]workflows\.ts$/,
          enforce: "pre",
          use: [{ loader: fileURLToPath(new URL("./temporal-legacy-loader.cjs", import.meta.url)) }]
        });
        return config;
      }
    });
  }

  async start() {
    // Time-skipping state is global to a server. Give every test its own server,
    // especially after terminating an indefinitely running continued workflow.
    this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-synthetic-client" } });
    this.workerFailure = undefined;
    const activities = Object.fromEntries(activityNames.map(name => [name, async (...args: any[]) => {
      const info = Context.current().info;
      if (!info.workflowExecution) throw new Error("The test registered a workflow activity, not a standalone activity");
      this.calls.push({ name, args, attempt: info.attempt, runId: info.workflowExecution.runId });
      const handler = this.handlers[name];
      if (!handler) throw ApplicationFailure.nonRetryable(`No synthetic handler for ${name}`, "MissingTestActivity");
      return handler(...args);
    }]));
    for (const taskQueue of [this.taskQueue, this.legacyTaskQueue, MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE]) {
      const worker = await Worker.create({
        connection: this.env.nativeConnection,
        namespace: this.env.namespace,
        taskQueue,
        workflowBundle: taskQueue === this.legacyTaskQueue ? this.legacyBundle : this.bundle,
        activities,
        identity: "spaceapp-synthetic-worker",
        maxCachedWorkflows: 16,
        maxConcurrentWorkflowTaskExecutions: 8,
        maxConcurrentActivityTaskExecutions: 8,
        maxConcurrentWorkflowTaskPolls: 2,
        maxConcurrentActivityTaskPolls: 2,
        shutdownGraceTime: "1 second"
      });
      this.workers.push(worker);
      this.runs.push(worker.run().catch(error => { this.workerFailure = error; }));
    }
  }

  reset(handlers: ActivityHandlers = {}) {
    this.handlers = handlers;
    this.calls = [];
    if (this.workerFailure) throw this.workerFailure;
  }

  async startWorkflow(type: string, input: unknown, options: { legacy?: boolean; workflowId?: string } = {}) {
    const handle = await this.env.client.workflow.start(type, {
      workflowId: options.workflowId ?? `synthetic-${type}-${randomUUID()}`,
      taskQueue: options.legacy ? this.legacyTaskQueue : this.taskQueue,
      args: [input]
    });
    this.handles.push(handle);
    return handle;
  }

  firstRun(handle: StartedHandle) {
    return this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
  }

  async history(handle: WorkflowHandle) { return handle.fetchHistory(); }

  async record(name: string, handle: WorkflowHandle) {
    if (!recording) return;
    // Stack traces are diagnostic metadata, and may contain checkout paths.
    // No events, commands, inputs, outputs, or patch markers are changed.
    const history = temporal.api.history.v1.History.toObject(
      temporal.api.history.v1.History.fromObject(await handle.fetchHistory()),
      { longs: String, bytes: String, enums: String }
    );
    const stripStackTraces = (value: any): void => {
      if (!value || typeof value !== "object") return;
      for (const key of Object.keys(value)) {
        if (key === "stackTrace") value[key] = "synthetic-fixture";
        else stripStackTraces(value[key]);
      }
    };
    stripStackTraces(history);
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(`${historyDirectory}/${name}.json`, JSON.stringify({ workflowId: handle.workflowId, history }, null, 2) + "\n", { flag: "wx" });
  }

  async cleanup() {
    for (const stop of this.stopDrivers.splice(0)) await stop();
    for (const handle of this.handles.splice(0)) {
      const description = await handle.describe();
      if (description.status.name === "RUNNING") await handle.terminate("Synthetic test cleanup");
    }
    if (this.workerFailure) throw this.workerFailure;
  }

  async close() {
    try { await this.cleanup(); }
    finally {
      for (const worker of this.workers) if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.all(this.runs);
      await this.env?.teardown();
      this.workers = [];
      this.runs = [];
    }
  }
}

export function eventAttributes(history: any, name: string): any[] {
  return (history.events ?? []).flatMap((event: any) => event[name] ? [event[name]] : []);
}

export function payloadValue(payloads: any) {
  return defaultPayloadConverter.fromPayload(payloads.payloads[0]);
}

export async function recordedHistories() {
  const names = (await readdir(historyDirectory)).filter(name => name.endsWith(".json")).sort();
  return Promise.all(names.map(async name => {
    const fixture = JSON.parse(await readFile(`${historyDirectory}/${name}`, "utf8"));
    return { name, workflowId: fixture.workflowId as string, history: temporal.api.history.v1.History.fromObject(fixture.history) };
  }));
}
