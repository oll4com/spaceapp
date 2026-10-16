import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkerOptions } from "@temporalio/worker";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

export const recordingWorkflowHistories = process.env.SPACE_TEMPORAL_RECORD_HISTORIES === "1";
export const workflowHistoryDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));

type WorkflowBundle = Awaited<ReturnType<typeof bundleWorkflowCode>>;
type WorkflowHistory = temporal.api.history.v1.IHistory;
type Activities = NonNullable<WorkerOptions["activities"]>;
type HistoryHandle = {
  workflowId: string;
  firstExecutionRunId?: string;
  fetchHistory(): Promise<WorkflowHistory>;
};

export type TemporalSandboxContext = {
  env: TestWorkflowEnvironment;
  client: Client;
  taskQueue: string;
};

export type RecordedWorkflowHistory = {
  format: 1;
  label: string;
  workflowId: string;
  workflowType: string;
  history: Record<string, unknown>;
};

let environment: TestWorkflowEnvironment | undefined;
const bundles = new Map<string, Promise<WorkflowBundle>>();

/**
 * Bundles the real production, preserved legacy, or deliberately incompatible
 * test entry point, caching each bundle for the lifetime of the suite.
 */
export function getTemporalWorkflowBundle(options: { legacy?: boolean; negative?: boolean } = {}): Promise<WorkflowBundle> {
  const name = options.negative
    ? "temporal-negative-workflow.ts"
    : options.legacy ? "temporal-legacy-workflows.ts" : "temporal-workflows.ts";
  let bundle = bundles.get(name);
  if (!bundle) {
    bundle = bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL(name, import.meta.url)) });
    bundles.set(name, bundle);
  }
  return bundle;
}

/** Starts the suite-owned time-skipping server and prepares its production bundle. */
export async function startTemporalSandbox(): Promise<void> {
  if (environment) throw new Error("The Temporal sandbox is already running.");
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  // Build once per suite. Every case executes the real production bundle.
  await getTemporalWorkflowBundle();
}

/** Tears down the shared test server and clears bundles even when teardown fails. */
export async function stopTemporalSandbox(): Promise<void> {
  const current = environment;
  environment = undefined;
  try {
    if (current) await current.teardown();
  } finally {
    bundles.clear();
  }
}

/** Returns the initialized shared environment, failing if suite setup was omitted. */
function sandboxEnvironment(): TestWorkflowEnvironment {
  if (!environment) throw new Error("Initialize the Temporal sandbox in beforeAll before running a case.");
  return environment;
}

// Bind every ordinary method to the genuine SDK object. Only start/execute are
// wrapped to remember IDs for cleanup; signals, results, histories and timers
// still cross the real Temporal client/server boundary.
/**
 * Preserves the genuine SDK client while recording workflow IDs started or
 * executed by a case so cleanup can terminate their latest executions.
 */
function trackedClient(client: Client, workflowIds: Set<string>): Client {
  const workflows = new Proxy(client.workflow, {
    /** Binds workflow methods to their SDK receiver and tracks start/execute IDs. */
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if ((property === "start" || property === "execute") && typeof value === "function") {
        return (...args: unknown[]) => {
          const options = args[1] as { workflowId?: string } | undefined;
          if (options?.workflowId) workflowIds.add(options.workflowId);
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(client, {
    /** Supplies the tracked workflow client while preserving other SDK receivers. */
    get(target, property) {
      if (property === "workflow") return workflows;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * Terminates the current run of each tracked workflow, including continued runs.
 * Already-closed executions are harmless; other cleanup errors fail the case.
 */
async function terminateStartedWorkflows(client: Client, workflowIds: Set<string>): Promise<void> {
  const failures: unknown[] = [];
  for (const workflowId of workflowIds) {
    try {
      // No run ID: terminate the CURRENT execution, including a continued run.
      await client.workflow.getHandle(workflowId).terminate("Synthetic test case cleanup");
    } catch (error) {
      // A completed execution is not an active resource to clean up. Other
      // errors must fail the test rather than concealing a leaked execution.
      if (!(error instanceof WorkflowNotFoundError)) failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Could not clean up synthetic workflow executions.");
}

/**
 * Runs a case against real workers with stub activities and the selected workflow
 * bundle. Optional memory queues exercise child routing; an isolated server gives
 * polling cases an independent clock. Synthetic executions and workers are joined
 * before an isolated server is torn down.
 */
export async function withTemporalWorker<T>(
  activities: Activities,
  run: (context: TemporalSandboxContext) => Promise<T>,
  options: { legacy?: boolean; memory?: boolean; isolated?: boolean } = {}
): Promise<T> {
  // Long polling cases need their own server clock: an unfinished result scope
  // from another case must not hold this environment's time-skipping lock.
  const env = options.isolated
    ? await TestWorkflowEnvironment.createTimeSkipping()
    : sandboxEnvironment();
  const taskQueue = `space-temporal-test-${randomUUID()}`;
  const workflowIds = new Set<string>();
  const client = trackedClient(env.client, workflowIds);
  const queues = options.memory
    ? [taskQueue, MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE]
    : [taskQueue];
  const workers: Worker[] = [];
  let executions: Promise<unknown>[] = [];
  let result: Promise<T> | undefined;
  try {
    const workflowBundle = await getTemporalWorkflowBundle({ legacy: options.legacy });
    for (const queue of new Set(queues)) {
      workers.push(await Worker.create({
        connection: env.nativeConnection,
        workflowBundle,
        taskQueue: queue,
        activities,
        // Tests exercise actual activity cancellation, with short heartbeats
        // instead of waiting for the production-sized throttling interval.
        maxHeartbeatThrottleInterval: "100 milliseconds",
        defaultHeartbeatThrottleInterval: "100 milliseconds",
        shutdownGraceTime: "1 second"
      }));
    }
    // The microtask starts only after all real workers have been constructed
    // and their runUntil calls registered. Secondary memory queues stay alive
    // for the same callback, so production executeChild/taskQueue routing runs.
    result = Promise.resolve().then(async () => {
      let callbackFailure: unknown;
      try {
        return await run({ env, client, taskQueue });
      } catch (error) {
        callbackFailure = error;
        throw error;
      } finally {
        try {
          await terminateStartedWorkflows(env.client, workflowIds);
        } catch (cleanupFailure) {
          if (callbackFailure !== undefined) {
            throw new AggregateError([callbackFailure, cleanupFailure], "Temporal case and cleanup both failed.");
          }
          throw cleanupFailure;
        }
      }
    });
    const caseResult = result;
    executions = workers.map((worker) => worker.runUntil(caseResult));
    await Promise.all(executions);
    return await result;
  } finally {
    try {
      // A failed SDK worker can leave the callback waiting for a result.
      // Terminate first to release that wait before joining the callback.
      await terminateStartedWorkflows(env.client, workflowIds);
      if (result) await Promise.allSettled([result]);
      for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
      // If a later Worker.create failed, release earlier initialized workers
      // through the same real SDK lifecycle, without starting any test work.
      for (const worker of workers) {
        if (worker.getState() === "INITIALIZED") executions.push(worker.runUntil(Promise.resolve()));
      }
      await Promise.allSettled(executions);
    } finally {
      // A dedicated server is torn down only after workflow and worker cleanup.
      // The shared environment remains owned by the suite's afterAll hook.
      if (options.isolated) await env.teardown();
    }
  }
}

/**
 * Fetches the initial execution's history without following continue-as-new.
 * Supply the case's client for an isolated server; otherwise use the shared one.
 */
export async function firstRunHistory(handle: HistoryHandle, client?: Client): Promise<WorkflowHistory> {
  if (!handle.firstExecutionRunId) throw new Error(`Missing first execution run ID for ${handle.workflowId}.`);
  return (client ?? sandboxEnvironment().client).workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
}

/**
 * Writes a portable synthetic history only in explicit recording mode, preserving
 * protobuf event IDs and payloads. Normal tests return without rewriting goldens;
 * firstRun selects the original execution when a scenario continues as new.
 */
export async function recordWorkflowHistory(
  label: string,
  handle: HistoryHandle,
  options: { firstRun?: boolean; client?: Client } = {}
): Promise<void> {
  if (!recordingWorkflowHistories) return;
  if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(label)) throw new Error(`Invalid synthetic history label: ${label}`);
  const history = options.firstRun ? await firstRunHistory(handle, options.client) : await handle.fetchHistory();
  const workflowType = history.events?.find((event) => event.workflowExecutionStartedEventAttributes)
    ?.workflowExecutionStartedEventAttributes?.workflowType?.name;
  if (!workflowType) throw new Error(`No workflow start event in history for ${label}.`);
  // Protobuf's JSON form preserves 64-bit IDs and base64 payloads portably.
  // Normal test execution NEVER updates golden files.
  const portable = temporal.api.history.v1.History.fromObject(history as Record<string, unknown>).toJSON();
  const fixture: RecordedWorkflowHistory = {
    format: 1,
    label,
    workflowId: handle.workflowId,
    workflowType,
    history: portable
  };
  await mkdir(workflowHistoryDirectory, { recursive: true });
  await writeFile(join(workflowHistoryDirectory, `${label}.json`), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}
