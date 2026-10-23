import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldTransport } from "node:timers/promises";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type History, type WorkflowBundle } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { WorkflowNotFoundError, type WorkflowHandle, type WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

export type ActivityStubs = Record<string, (...args: any[]) => any>;
export type CapturedHistory = { label: string; workflowType: string; workflowId: string; history: History; legacy: boolean };
export interface ScenarioContext {
  env: TestWorkflowEnvironment;
  client: TestWorkflowEnvironment["client"];
  taskQueue: string;
  activities: ActivityStubs;
  start(type: string, input: unknown, options?: { workflowId?: string }): Promise<WorkflowHandleWithFirstExecutionRunId>;
  capture(handle: WorkflowHandle, label: string): Promise<History>;
}
export interface WorkflowScenario {
  name: string;
  workflowType: string;
  legacy?: boolean;
  memoryQueues?: boolean;
  run(ctx: ScenarioContext): Promise<void>;
}

const activityNames = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "dotGoalStep", "dotGoalObserve",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn", "prepareRoomAgentBackgroundContinuation",
  "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction", "refreshMemoryGraphSnapshot",
  "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions", "createScheduledMemoryAudit",
  "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
] as const;
const bundles = new Map<string, Promise<WorkflowBundle>>();

/**
 * Cache real workflow bundles separately for current, legacy and incompatible negative tests.
 * Only the legacy bundle applies the single-guard test loader.
 */
export function workflowBundle(mode: "current" | "legacy" | "negative" = "current"): Promise<WorkflowBundle> {
  let cached = bundles.get(mode);
  if (!cached) {
    cached = bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL(mode === "negative" ? "./determinism-negative-workflows.ts" : "./temporal-workflows.ts", import.meta.url)),
      logger: new DefaultLogger("ERROR"),
      webpackConfigHook: config => {
        if (mode === "legacy") config.module!.rules!.push({
          test: /workflows\.ts$/,
          enforce: "pre",
          use: [{ loader: fileURLToPath(new URL("./legacy-workflow-loader.cjs", import.meta.url)) }]
        });
        return config;
      }
    });
    bundles.set(mode, cached);
  }
  return cached;
}

/**
 * Expose promise settlement callbacks so a scenario can synchronize with an activity.
 */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * Create a real time-skipping Temporal test server with a synthetic client identity.
 * The caller owns teardown; this does not connect to an operator installation.
 */
export async function createTestEnvironment() {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  return TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-workflow-test-client" } });
}

/**
 * Terminate an execution chain started by this scenario, including continue-as-new races.
 * Re-check status after a not-found termination response and bound retries by a host deadline.
 */
async function stopOwnedChain(handle: WorkflowHandle) {
  const expires = Date.now() + 5_000;
  for (;;) {
    // The native start handle targets the current run in its original chain;
    // checking describe before terminating can miss a continue-as-new boundary.
    try { await handle.terminate("Synthetic test cleanup"); }
    catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
    const { status } = await handle.describe();
    if (status.name !== "RUNNING" && status.name !== "CONTINUED_AS_NEW") return;
    assert.ok(Date.now() < expires, `Owned workflow chain did not stop: ${handle.workflowId}`);
    await yieldTransport();
  }
}

// One environment, serial scenarios: virtual time is global to the server.
/**
 * Run real workflow code with only activities stubbed and capture explicitly requested first-run histories.
 * Supervisors get dedicated servers; finite scenarios share serial virtual time.
 * Bound host execution and clean owned chains, workers and dedicated environments on completion or failure.
 */
export async function runScenario(env: TestWorkflowEnvironment, scenario: WorkflowScenario, isolated = false): Promise<CapturedHistory[]> {
  // Supervisors deliberately never return. Give each one its own server so
  // terminating a continued execution cannot affect another case's global
  // time-skipping clock. Finite workflows safely share the serial environment.
  if (scenario.workflowType === "roomAgentSupervisorWorkflow" && !isolated) {
    const dedicated = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-workflow-test-client" } });
    try { return await runScenario(dedicated, scenario, true); }
    finally { await dedicated.teardown(); }
  }
  const activities: ActivityStubs = {};
  const owned: WorkflowHandle[] = [];
  const types = new Map<string, string>();
  const captured: CapturedHistory[] = [];
  const taskQueue = `spaceapp-test-${randomUUID()}`;
  const ctx: ScenarioContext = {
    env, client: env.client, taskQueue, activities,
    async start(type, input, options = {}) {
      const handle = await env.client.workflow.start(type, {
        taskQueue, workflowId: options.workflowId ?? `spaceapp-test-${type}-${randomUUID()}`,
        args: [input], workflowExecutionTimeout: "30 days"
      });
      // Pin the first run: fixture capture must not silently switch to a later
      // continue-as-new execution. result() on the original handle still follows.
      owned.push(handle);
      types.set(handle.workflowId, type);
      return handle;
    },
    async capture(handle, label) {
      const pinned = (handle as any).firstExecutionRunId
        ? env.client.workflow.getHandle(handle.workflowId, (handle as any).firstExecutionRunId) : handle;
      const history = await pinned.fetchHistory();
      captured.push({ label, workflowType: types.get(handle.workflowId)!, workflowId: handle.workflowId, history, legacy: Boolean(scenario.legacy) });
      return history;
    }
  };
  // Worker.create snapshots its activity registry. Forward by name so scenario
  // closures can configure synthetic behavior after the workers start polling.
  const registry = Object.fromEntries(activityNames.map(name => [name, (...args: any[]) => {
    assert.equal(typeof activities[name], "function", `Missing synthetic activity ${name} in ${scenario.name}`);
    return activities[name]!(...args);
  }]));
  const bundle = await workflowBundle(scenario.legacy ? "legacy" : "current");
  const workers: Worker[] = [];
  try {
    for (const queue of [taskQueue, ...(scenario.memoryQueues ? [MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE] : [])]) {
      workers.push(await Worker.create({
        connection: env.nativeConnection, taskQueue: queue, namespace: env.namespace,
        identity: "spaceapp-workflow-test-worker", workflowBundle: bundle, activities: registry,
        maxHeartbeatThrottleInterval: "100 milliseconds", shutdownGraceTime: "2 seconds", shutdownForceTime: "5 seconds"
      }));
    }
    const execute = async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([scenario.run(ctx), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`Scenario deadline: ${scenario.name}`)), 22_000);
        })]);
      }
      finally {
        if (deadline) clearTimeout(deadline);
        for (const handle of owned) await stopOwnedChain(handle);
      }
    };
    await workers.reduceRight<() => Promise<void>>((inner, worker) => () => worker.runUntil(inner), execute)();
    return captured;
  } catch (error) {
    // runUntil tears down started workers. If creation failed partway, start
    // and immediately drain each initialized worker (shutdown requires RUNNING).
    for (const worker of workers) if (worker.getState() === "INITIALIZED") await worker.runUntil(Promise.resolve());
    throw error;
  }
}

/**
 * Coerce an event type to its string representation without translating numeric enum values.
 */
export function eventName(event: any): string { return String(event.eventType); }
/**
 * Select a Temporal event suffix after protobuf histories have been converted to their JSON form.
 */
export function eventsOf(history: History, suffix: string) {
  // JSON histories use enum strings; fetched protobuf histories use numbers.
  return JSON.parse(JSON.stringify(history)).events.filter((event: any) => eventName(event) === `EVENT_TYPE_${suffix}`);
}
