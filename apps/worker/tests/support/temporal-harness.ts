import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import type { Client } from "@temporalio/client";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

// This test-only VM execution guard applies to every activation, not durable timers.
// The production contract module is large; cold initialization can exceed the SDK
// 5-second default on constrained CI hosts. Production timeouts remain unchanged.
export const workflowsPath = fileURLToPath(new URL("./temporal-workflows.ts", import.meta.url));
let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;
let sharedEnvironment: Promise<TestWorkflowEnvironment> | undefined;
let sharedWorkers: Promise<{ worker: Worker; mutationWorker: Worker; running: Promise<void>[] }> | undefined;
type Scenario = { activities: Record<string, (...args: any[]) => any>; legacyPatch?: boolean; freshServer?: boolean; timeoutMs?: number };
let activeCase: Scenario | undefined;
const executionOwners = new Map<string, Scenario>();
function ownExecution(runId: string): Scenario {
  if (!activeCase) throw new Error(`Execution delivered outside a scenario: ${runId}`);
  const owner = executionOwners.get(runId);
  if (owner && owner !== activeCase) throw new Error(`Late execution from a finished scenario: ${runId}`);
  executionOwners.set(runId, activeCase);
  return activeCase;
}
const activityNames = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued", "dotGoalStep", "dotGoalObserve",
  "settleRoomAgentBackgroundMission", "prepareRoomAgentBackgroundContinuation", "checkRoomAgentSupervisorTurn",
  "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "createScheduledMemoryAudit", "finalizeMemoryRepair", "prepareMemoryConsolidation", "reconcileStaleSpaceAgentSessions",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "executePersistedMemoryChangeSet"
];
let reuseEnvironment = false;
/** Opt in per serial test file. Reuse isolates, but reset activity implementations for every scenario. */
export function reuseTemporalServer() { reuseEnvironment = true; }
/** Call in the suite's afterAll; keeping one loopback server avoids startup cost per scenario. */
export async function closeTemporalServer() {
  const environment = sharedEnvironment;
  const workers = sharedWorkers;
  sharedEnvironment = undefined;
  sharedWorkers = undefined;
  activeCase = undefined;
  executionOwners.clear();
  try {
    if (workers) {
      const { worker, mutationWorker, running } = await workers;
      for (const current of [worker, mutationWorker]) if (current.getState() === "RUNNING") current.shutdown();
      const results = await Promise.allSettled(running);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  } finally {
    if (environment) await (await environment).teardown();
  }
}
/** Compile the real workflow entry point once per test process, not once per scenario. */
export function productionBundle() {
  return bundle ??= bundleWorkflowCode({ workflowsPath });
}

export interface TemporalContext {
  env: TestWorkflowEnvironment;
  client: Client;
  worker: Worker;
  taskQueue: string;
}

/** The recorder gets fresh workers; serial suites reuse them with per-case activity implementations. */
export async function withTemporal<T>(
  options: Scenario,
  run: (context: TemporalContext) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 50_000);
  if (reuseEnvironment && !options.freshServer) return withSharedWorkers(options, run, deadline);
  const createEnvironment = () => TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-synthetic-tests" } });
  const env = await createEnvironment();
  try {
    const workflowBundle = await productionBundle();
    const taskQueue = MEMORY_MAINTENANCE_TASK_QUEUE;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowBundle, identity: "spaceapp-synthetic-tests",
      activities: options.activities,
      ...(options.legacyPatch ? { patchActivationCallback: ({ patchId }: { patchId: string }) => patchId !== "room-background-continuation-v1" } : {}),
      ...({ isolateExecutionTimeout: "15 seconds" } as Record<string, unknown>), shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds"
    });
    if (!("executePersistedMemoryChangeSet" in options.activities)) {
      return await worker.runUntil(() => boundedRun(() => run({ env, client: env.client, worker, taskQueue }), deadline));
    }
    const mutationWorker = await Worker.create({
      connection: env.nativeConnection, taskQueue: MEMORY_MUTATION_TASK_QUEUE, identity: "spaceapp-synthetic-tests",
      activities: options.activities, ...({ isolateExecutionTimeout: "15 seconds" } as Record<string, unknown>), shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds"
    });
    return await worker.runUntil(() => mutationWorker.runUntil(() => boundedRun(() => run({ env, client: env.client, worker, taskQueue }), deadline)));
  } finally {
    await env.teardown();
  }
}


/** Shared SDK workers avoid reparsing the large production bundle for every case.
 * Only sequential tests may use this path. Unique execution IDs and completed /
 * terminated scenarios isolate workflow state; a failed case discards the server.
 */
async function withSharedWorkers<T>(options: Scenario, run: (context: TemporalContext) => Promise<T>, deadline: number): Promise<T> {
  if (activeCase) throw new Error("Temporal scenarios must run serially");
  activeCase = options;
  try {
    const env = await (sharedEnvironment ??= TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-synthetic-tests" } }));
    const taskQueue = MEMORY_MAINTENANCE_TASK_QUEUE;
    const { worker, running } = await (sharedWorkers ??= (async () => {
      const activities = Object.fromEntries(activityNames.map(name => [name, (...args: any[]) => {
        const execution = Context.current().info.workflowExecution;
        if (!execution) throw new Error("Expected a workflow-owned activity");
        const scenario = ownExecution(execution.runId);
        const implementation = scenario.activities[name];
        if (!implementation) throw new Error(`Unexpected activity in scenario: ${name}`);
        return implementation(...args);
      }]));
      const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: await productionBundle(),
        activities, identity: "spaceapp-synthetic-tests", ...({ isolateExecutionTimeout: "15 seconds" } as Record<string, unknown>), shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds",
        patchActivationCallback: ({ patchId, workflowInfo }) => !(ownExecution(workflowInfo.runId).legacyPatch && patchId === "room-background-continuation-v1") });
      const mutationWorker = await Worker.create({ connection: env.nativeConnection, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        activities, identity: "spaceapp-synthetic-tests", ...({ isolateExecutionTimeout: "15 seconds" } as Record<string, unknown>), shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds" });
      const running = [worker.run(), mutationWorker.run()];
      for (const promise of running) void promise.catch(() => undefined);
      return { worker, mutationWorker, running };
    })());
    return await Promise.race([boundedRun(() => run({ env, client: env.client, worker, taskQueue }), deadline), ...running.map(promise => promise.then(() => { throw new Error("Temporal worker stopped during scenario"); }))]);
  } catch (error) {
    await closeTemporalServer().catch(() => undefined);
    throw error;
  } finally {
    activeCase = undefined;
  }
}

/** Reject before Vitest's outer deadline so runUntil/catch can shut down the server. */
async function boundedRun<T>(run: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Temporal scenario setup exceeded its deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Temporal scenario exceeded its internal deadline")), remaining);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait for an activity-side observation without advancing Temporal's virtual clock. */
export async function waitFor(predicate: () => boolean, message = "activity observation", timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(5);
  }
}

/** Default JSON payloads in histories are decoded solely for state assertions. */
export function jsonPayload(payload: { data?: Uint8Array | string | null } | null | undefined): any {
  if (!payload?.data) throw new Error("Expected a JSON payload");
  return JSON.parse(Buffer.from(payload.data as Uint8Array).toString("utf8"));
}
