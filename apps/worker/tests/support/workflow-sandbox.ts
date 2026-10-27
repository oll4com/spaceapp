import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundle } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../../src/memory-mutation-config.js";

export type Mode = "current" | "legacy" | "drift";
export const historyNames = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow",
  "roomAgentSupervisorWorkflow", "roomAgentSupervisorWorkflow-legacy",
  "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"
] as const;
const here = fileURLToPath(new URL(".", import.meta.url));
export const historiesDirectory = resolve(here, "../fixtures/workflow-histories");
const bundles = new Map<Mode, Promise<WorkflowBundle>>();
/** Cache the real workflow bundle, with test-only legacy or replay-drift transforms. */
export function workflowBundle(mode: Mode = "current") {
  if (!bundles.has(mode)) bundles.set(mode, bundleWorkflowCode({
    workflowsPath: resolve(here, "workflow-sandbox-entry.ts"),
    logger: new DefaultLogger("ERROR"),
    webpackConfigHook: config => {
      if (mode !== "current") config.module!.rules!.push({
        test: /[/\\]src[/\\]workflows\.ts$/, enforce: "pre",
        use: [{ loader: resolve(here, "workflow-recording-loader.cjs"), options: { mode } }]
      });
      return config;
    }
  }));
  return bundles.get(mode)!;
}

const activityNames = [
  "dotGoalStep", "dotGoalObserve", "recordDummyTurnStarted", "recordDummyTurnCompleted",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "prepareRoomAgentBackgroundContinuation",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"
] as const;
type ActivityName = typeof activityNames[number];
export type Activities = Partial<Record<ActivityName, (...args: any[]) => any>>;

/** Expose completion controls so tests can order signals around running activities. */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Poll a test observation with a bounded wall-clock deadline and useful failure label. */
export async function until(predicate: () => boolean | Promise<boolean>, label = "condition", timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

/** Own an isolated time-skipping server, activity stubs, workers and workflow handles. */
export class Sandbox {
  env!: TestWorkflowEnvironment;
  activities: Activities = {};
  calls: Array<{ name: ActivityName; args: any[] }> = [];
  private workers: Worker[] = [];
  private running: Promise<void>[] = [];
  private handles: WorkflowHandle[] = [];
  private missingActivities: string[] = [];
  private sequence = 0;
  private initialized = false;
  private opened = false;

  /** Start a fresh server and workers for both supervisor branches and memory child queues. */
  async open() {
    if (!this.initialized) {
      Runtime.install({ logger: new DefaultLogger("ERROR") });
      this.initialized = true;
    }
    // The SDK gives the server a fixed five-second startup window. Retry only
    // that bootstrap failure once; workflow executions are never retried.
    try {
      this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-sandbox-tests" } });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("did not start within 5s")) throw error;
      await delay(200);
      this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-sandbox-tests" } });
    }
    this.opened = true;
    const activities = Object.fromEntries(activityNames.map(name => [name, async (...args: any[]) => {
      this.calls.push({ name, args });
      const handler = this.activities[name];
      if (!handler) { this.missingActivities.push(name); throw Error(`Missing stub activity: ${name}`); }
      return handler(...args);
    }]));
    for (const [queue, mode] of [
      ["sandbox-current", "current"], ["sandbox-legacy", "legacy"],
      [MEMORY_MAINTENANCE_TASK_QUEUE, "current"], [MEMORY_MUTATION_TASK_QUEUE, "current"]
    ] as const) {
      const worker = await Worker.create({
        connection: this.env.nativeConnection, identity: "spaceapp-sandbox-tests",
        taskQueue: queue, workflowBundle: await workflowBundle(mode), activities,
        shutdownGraceTime: "1 second",
        maxHeartbeatThrottleInterval: "20 milliseconds",
        defaultHeartbeatThrottleInterval: "20 milliseconds"
      });
      this.workers.push(worker);
      this.running.push(worker.run());
    }
  }

  /** Start a real workflow and retain its handle for deterministic cleanup. */
  async start(type: string, input: unknown, mode: "current" | "legacy" = "current", workflowId?: string) {
    const handle = await this.env.client.workflow.start(type, {
      taskQueue: `sandbox-${mode}`, workflowId: workflowId ?? `synthetic-${type}-${++this.sequence}`, args: [input]
    });
    this.handles.push(handle);
    return handle;
  }

  /** Allow server time to advance only while the supplied test operation runs. */
  async skipping<T>(body: () => Promise<T>): Promise<T> {
    await this.env.connection.testService.unlockTimeSkipping({});
    try { return await body(); }
    finally { await this.env.connection.testService.lockTimeSkipping({}); }
  }

  /** Count invocations of a named stub activity. */
  count(name: ActivityName) { return this.calls.filter(call => call.name === name).length; }
  /** Return the captured arguments for every invocation of a named activity. */
  named(name: ActivityName) { return this.calls.filter(call => call.name === name); }

  /** Fetch the original execution history even after continue-as-new advances the handle. */
  async firstHistory(handle: WorkflowHandleWithFirstExecutionRunId) {
    return this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
  }

  /** Require continue-as-new and return the next execution input plus the original history. */
  async continued(handle: WorkflowHandleWithFirstExecutionRunId) {
    let nextRunId: string | undefined;
    await assert.rejects(this.env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false }), error => {
      const continued = error as Error & { newExecutionRunId: string };
      assert.equal(continued.name, "WorkflowExecutionContinuedAsNewError");
      nextRunId = continued.newExecutionRunId;
      return true;
    });
    assert.ok(nextRunId);
    const next = this.env.client.workflow.getHandle(handle.workflowId, nextRunId);
    const history = await next.fetchHistory();
    const payload = history.events![0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!;
    return { next, input: JSON.parse(new TextDecoder().decode(payload.data!)), history: await this.firstHistory(handle) };
  }

  /** Write synthetic history only in recorder mode, removing machine-local failure stacks. */
  async record(name: typeof historyNames[number], handle: WorkflowHandleWithFirstExecutionRunId) {
    const destination = process.env.SPACE_RECORD_WORKFLOW_HISTORIES;
    if (!destination) return;
    const history = await this.firstHistory(handle);
    await mkdir(destination, { recursive: true });
    const synthetic = JSON.parse(JSON.stringify(temporal.api.history.v1.History.toObject(
      temporal.api.history.v1.History.fromObject(history), { longs: String, enums: String, bytes: String }
    ), (key, value) => key === "stackTrace" ? "" : value));
    // One event per line keeps the 250-poll histories diffable without tens of
    // thousands of formatting-only lines. Failure stacks contain local paths.
    await writeFile(resolve(destination, `${name}.json`), '{\n  "events": [\n' +
      synthetic.events.map((event: unknown) => "    " + JSON.stringify(event)).join(",\n") + '\n  ]\n}\n');
  }

  /** Terminate remaining runs, drain workers and reject any activity lacking an explicit stub. */
  async reset() {
    for (const handle of this.handles.splice(0)) {
      const current = this.env.client.workflow.getHandle(handle.workflowId);
      const description = await current.describe();
      if (description.status.name === "RUNNING") await current.terminate("Synthetic test finished");
    }
    await until(() => this.workers.every(worker => {
      const status = worker.getStatus();
      return status.numInFlightActivities === 0 && status.numInFlightWorkflowActivations === 0;
    }), "test worker activities and activations to drain");
    const missing = this.missingActivities;
    this.missingActivities = [];
    this.activities = {};
    this.calls = [];
    assert.deepEqual(missing, [], "Every executed production activity must have an explicit test stub");
  }

  /** Drain test work and tear down every worker and the ephemeral server. */
  async close() {
    if (!this.opened) return;
    this.opened = false;
    try { await this.reset(); }
    finally {
      this.workers.forEach(worker => worker.shutdown());
      try { await Promise.all(this.running); }
      finally {
        await this.env.teardown();
        this.workers = [];
        this.running = [];
        this.activities = {};
        this.calls = [];
        this.missingActivities = [];
      }
    }
  }
}
