import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";

export const workflowsPath = fileURLToPath(new URL("./sandbox-workflows.ts", import.meta.url));
export const legacyWorkflowsPath = fileURLToPath(new URL("./legacy-supervisor-workflows.ts", import.meta.url));
export const incompatibleWorkflowsPath = fileURLToPath(new URL("./incompatible-sandbox-workflows.ts", import.meta.url));

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function failure(type = "SYNTHETIC_FAILURE", nonRetryable = false) {
  const error = ApplicationFailure.create({ message: "Synthetic activity failure", type, nonRetryable });
  // Public history fixtures contain no developer paths or machine identifiers.
  error.stack = "ApplicationFailure: Synthetic activity failure";
  return error;
}

export async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

// Real cancellation must be delivered through heartbeats, as it is in production.
export async function holdUntilCancelled(started: { resolve: () => void }) {
  const context = Context.current();
  const interval = setInterval(() => context.heartbeat(), 20);
  started.resolve();
  try { await context.cancelled; } finally { clearInterval(interval); }
}

const names = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn",
  "dotGoalStep", "dotGoalObserve", "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "prepareRoomAgentBackgroundContinuation", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"
] as const;
export type StubActivities = Partial<Record<typeof names[number], (...args: any[]) => any>>;

export class TemporalSandbox {
  env!: TestWorkflowEnvironment;
  bundle!: WorkflowBundleWithSourceMap;
  private legacyBundle?: WorkflowBundleWithSourceMap;
  private opened = false;
  private queues = new Set<string>();
  workers: Worker[] = [];
  runs: Promise<void>[] = [];
  activities: StubActivities = {};
  calls: Array<{ name: string; args: any[]; attempt: number; workflowId: string }> = [];
  handles: WorkflowHandle[] = [];
  histories = new Map<string, string>();
  private serial = 0;

  async open() {
    if (this.opened) return;
    this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-sandbox-client" } });
    this.opened = true;
    try {
      this.bundle ??= await bundleWorkflowCode({ workflowsPath });
      await this.ensureWorker("sandbox");
    } catch (error) { await this.close(); throw error; }
  }

  private async ensureWorker(taskQueue: string) {
    if (this.queues.has(taskQueue)) return;
    if (taskQueue === "sandbox-legacy") this.legacyBundle ??= await bundleWorkflowCode({ workflowsPath: legacyWorkflowsPath });
    const activities = Object.fromEntries(names.map(name => [name, async (...args: any[]) => {
      const info = Context.current().info;
      this.calls.push({ name, args, attempt: info.attempt, workflowId: info.workflowExecution!.workflowId });
      const fn = this.activities[name];
      assert(fn, `Unexpected activity ${name}; define a stub for this scenario`);
      return fn(...args);
    }]));
    const worker = await Worker.create({
      connection: this.env.nativeConnection, taskQueue, activities,
      identity: `synthetic-${taskQueue}-worker`, workflowBundle: taskQueue === "sandbox-legacy" ? this.legacyBundle! : this.bundle,
      shutdownGraceTime: "1 second", maxConcurrentWorkflowTaskExecutions: 4, maxConcurrentActivityTaskExecutions: 8
    });
    this.workers.push(worker);
    const run = worker.run();
    void run.catch(() => {});
    this.runs.push(run);
    this.queues.add(taskQueue);
  }

  reset(activities: StubActivities) {
    assert.equal(this.handles.length, 0, "Previous scenario must close its workflows before replacing stubs");
    this.activities = activities;
    this.calls = [];
  }

  async start(type: string, input: unknown, legacy = false, workflowId?: string) {
    if (legacy) await this.ensureWorker("sandbox-legacy");
    if (type === "memoryMaintenanceWorkflow") await this.ensureWorker("space-memory-maintenance");
    if (type === "memoryMaintenanceWorkflow" || type === "memoryConsolidationWorkflow") await this.ensureWorker("space-memory-mutations");
    const handle = await this.env.client.workflow.start(type, {
      workflowId: workflowId ?? `synthetic-${type}-${++this.serial}`,
      taskQueue: legacy ? "sandbox-legacy" : "sandbox", args: [input]
    });
    this.handles.push(handle);
    return handle;
  }

  // Enable the real server's time skipping while the supervisor is running.
  // Every scenario closes it in finally; rejection handlers avoid hidden failures.
  runSupervisor(handle: WorkflowHandle) {
    const result = handle.result();
    void result.catch(() => {});
    return result;
  }

  async save(name: string, handle: WorkflowHandle, runId = (handle as WorkflowHandle & { firstExecutionRunId?: string }).firstExecutionRunId) {
    const history = await this.env.client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
    // Generated protobuf toJSON preserves int64 values and bytes losslessly.
    // The replay reader restores the same protobuf type with History.fromObject.
    this.histories.set(name, JSON.stringify(history, null, 2));
    return history;
  }

  async cleanup() {
    const handles = this.handles.splice(0);
    for (const handle of handles) {
      // These supervisors intentionally never return. Terminate only the disposable
      // test execution after assertions; mission cancellation is tested separately
      // with the real stop signal and heartbeat-delivered child cancellation.
      try { await handle.terminate("Synthetic test scenario finished"); } catch { /* Already closed. */ }
      try { await handle.result(); } catch { /* Expected closure/failure asserted by each scenario. */ }
    }
  }

  async close() {
    if (!this.opened) return;
    try { if (this.env) await this.cleanup(); }
    finally {
      for (const worker of this.workers) {
        if (worker.getState() === "RUNNING") worker.shutdown();
      }
      await Promise.allSettled(this.runs);
      try { await this.env.teardown(); }
      finally { this.opened = false; this.workers = []; this.runs = []; this.queues.clear(); }
    }
  }
}
