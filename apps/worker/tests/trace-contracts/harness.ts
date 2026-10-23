import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, Runtime, DefaultLogger, bundleWorkflowCode, type WorkflowBundle, type History } from "@temporalio/worker";
import { WorkflowNotFoundError, type WorkflowHandle, type WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

export interface TraceContext {
  env: TestWorkflowEnvironment;
  activities: Record<string, (...args: any[]) => Promise<any> | any>;
  trace: Array<{ kind: string; name: string; args: any[]; attempt?: number; result?: any }>;
  start(type: string, input: any, opts?: { workflowId?: string }): Promise<WorkflowHandleWithFirstExecutionRunId>;
  record(handle: WorkflowHandle, label: string): Promise<History>;
  waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void>;
}
export interface Scenario {
  name: string;
  workflowType: string;
  legacy?: boolean;
  historical?: boolean;
  memoryQueues?: boolean;
  run(ctx: TraceContext): Promise<void>;
}
export interface Recording { label: string; workflowId: string; workflowType: string; mode: string; history: History }
const names = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "dotGoalStep", "dotGoalObserve",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn", "runRoomAgentBackgroundAction",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn", "prepareRoomAgentBackgroundContinuation", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"
];
const cache = new Map<string, Promise<WorkflowBundle>>();
let installed = false;

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function environment() {
  if (!installed) { Runtime.install({ logger: new DefaultLogger("ERROR") }); installed = true; }
  const path = process.env.SPACEAPP_TEMPORAL_TEST_SERVER_PATH;
  return TestWorkflowEnvironment.createTimeSkipping(path
    ? { server: { executable: { type: "existing-path", path } } }
    : undefined);
}

export function bundle(mode: "current" | "legacy" | "historical" | "negative" = "current") {
  if (!cache.has(mode)) cache.set(mode, bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL(mode === "historical" ? "./historical-entry.ts" : mode === "negative" ? "./negative-entry.ts" : "./workflow-entry.ts", import.meta.url)),
    logger: new DefaultLogger("ERROR"),
    webpackConfigHook: config => {
      if (mode === "legacy") config.module!.rules!.push({
        test: /[/\\]src[/\\]workflows\.ts$/, enforce: "pre",
        use: [{ loader: fileURLToPath(new URL("./select-legacy.cjs", import.meta.url)) }]
      });
      return config;
    }
  }));
  return cache.get(mode)!;
}

export async function runScenario(env: TestWorkflowEnvironment, scenario: Scenario): Promise<Recording[]> {
  const taskQueue = `trace-contract-${randomUUID()}`;
  const activities: TraceContext["activities"] = {};
  const trace: TraceContext["trace"] = [];
  const owned: WorkflowHandleWithFirstExecutionRunId[] = [];
  const recordings: Recording[] = [];
  const mode = scenario.historical ? "historical" : scenario.legacy ? "legacy" : "current";
  const ctx: TraceContext = {
    env, activities, trace,
    async start(type, input, opts = {}) {
      const handle = await env.client.workflow.start(type, {
        taskQueue, workflowId: opts.workflowId ?? `synthetic-${randomUUID()}`, args: [input]
      });
      owned.push(handle); return handle;
    },
    async record(handle, label) {
      const firstRun = (handle as WorkflowHandleWithFirstExecutionRunId).firstExecutionRunId;
      const pinned = firstRun ? env.client.workflow.getHandle(handle.workflowId, firstRun) : handle;
      const history = await pinned.fetchHistory();
      assert(history.events?.length, `Empty history for ${label}`);
      const workflowType = history.events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
      assert(workflowType, `History ${label} has no workflow type`);
      recordings.push({ label, history, workflowId: handle.workflowId, workflowType, mode });
      return history;
    },
    async waitFor(predicate, description) {
      const deadline = Date.now() + 10_000;
      while (!await predicate()) {
        assert(Date.now() < deadline, `Timed out waiting for ${description}`);
        await delay(5);
      }
    }
  };
  const registry = Object.fromEntries(names.map(name => [name, async (...args: any[]) => {
    const attempt = Context.current().info.attempt;
    trace.push({ kind: "start", name, args, attempt });
    assert.equal(typeof activities[name], "function", `Unspecified activity ${name} in ${scenario.name}`);
    try {
      const result = await activities[name]!(...args);
      trace.push({ kind: "complete", name, args, attempt, result });
      return result;
    } catch (error) { trace.push({ kind: "error", name, args, attempt }); throw error; }
  }]));
  const workflowBundle = await bundle(mode);
  const workers: Worker[] = [];
  const queues = [taskQueue, ...(scenario.memoryQueues ? [MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE] : [])];
  try {
    for (const queue of queues) workers.push(await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace, taskQueue: queue,
      workflowBundle, activities: registry, maxHeartbeatThrottleInterval: "50 milliseconds", defaultHeartbeatThrottleInterval: "50 milliseconds",
      // Every scenario has already completed or terminated its owned chains.
      // Use the SDK's zero-grace default rather than adding a second per worker.
      shutdownGraceTime: 0, shutdownForceTime: "5 seconds"
    }));
    const execute = async () => {
      let scenarioFailure: { error: unknown } | undefined;
      try { await scenario.run(ctx); }
      catch (error) { scenarioFailure = { error }; }
      // Native start handles target the current run of their original chain,
      // including after continue-as-new. Attempt every chain even if one fails.
      const cleanupErrors: unknown[] = [];
      for (const handle of owned) {
        try { await handle.terminate("Synthetic contract test completed"); }
        catch (error) { if (!(error instanceof WorkflowNotFoundError)) cleanupErrors.push(error); }
      }
      // Preserve even falsy thrown values from the scenario, rather than masking
      // its failure with cleanup diagnostics.
      if (scenarioFailure) throw scenarioFailure.error;
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, `Failed to terminate owned workflows in ${scenario.name}`);
      }
    };
    await workers.reduceRight<() => Promise<void>>((inner, worker) => () => worker.runUntil(inner), execute)();
    return recordings;
  } finally {
    for (const worker of workers) if (worker.getState() === "INITIALIZED") await worker.runUntil(Promise.resolve());
  }
}

export function historyEvents(history: History, suffix: string): any[] {
  const key = (suffix.includes("_") ? suffix.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase()) : suffix[0]!.toLowerCase() + suffix.slice(1)) + "EventAttributes";
  return (history.events ?? []).filter((event: any) => event[key]);
}
export function historyJson(history: History) { return JSON.stringify(history, null, 2) + "\n"; }
export function checksum(text: string) { return createHash("sha256").update(text).digest("hex"); }
