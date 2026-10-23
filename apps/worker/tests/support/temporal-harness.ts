import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/common";
import type { temporal } from "@temporalio/proto";
import { WorkflowContinuedAsNewError, type WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Runtime, DefaultLogger, Worker, type WorkflowBundle } from "@temporalio/worker";

const require = createRequire(import.meta.url);
export const workflowsPath = require.resolve("./temporal-workflows.ts");
export const negativeWorkflowsPath = require.resolve("./nondeterministic-workflows.ts");
export const currentQueue = "space-memory-maintenance";
const legacyQueue = "space-test-pre-patch";
const mutationQueue = "space-memory-mutations";
let bundlePromise: Promise<WorkflowBundle> | undefined;
export type Handlers = Record<string, (...args: any[]) => any>;
export type History = temporal.api.history.v1.IHistory;
export type StartedHandle = WorkflowHandleWithFirstExecutionRunId;
export type RecordedExecution = { workflowId: string; runId: string; workflowType: string; history: History };
type Event = NonNullable<History["events"]>[number];

const activityNames = [
  "dotGoalStep", "dotGoalObserve", "recordDummyTurnStarted", "recordDummyTurnCompleted",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission", "prepareRoomAgentBackgroundContinuation",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
];

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export async function eventually(predicate: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    assert(Date.now() < deadline, `Timed out: ${description}`);
    await setTimeout(10);
  }
}

export function payload<T>(value: { payloads?: any[] | null } | null | undefined): T {
  assert(value?.payloads?.[0], "Expected an encoded workflow argument");
  return defaultPayloadConverter.fromPayload(value.payloads[0]) as T;
}

export function eventsOf(history: History, key: keyof Event) {
  return (history.events ?? []).filter(event => event[key] != null);
}

export function scheduledActivities(history: History) {
  return eventsOf(history, "activityTaskScheduledEventAttributes")
    .map(event => event.activityTaskScheduledEventAttributes!);
}

export class TemporalHarness {
  private handlers: Handlers = {};
  private starts: StartedHandle[] = [];
  private workers: Worker[] = [];
  private running: Promise<void>[] = [];

  private constructor(public readonly env: TestWorkflowEnvironment, public readonly bundle: WorkflowBundle) {}

  static async create() {
    if (!bundlePromise) {
      Runtime.install({ logger: new DefaultLogger("ERROR") });
      bundlePromise = bundleWorkflowCode({ workflowsPath, logger: new DefaultLogger("ERROR") });
    }
    const bundle = await bundlePromise;
    const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-synthetic-test-client" } });
    const harness = new TemporalHarness(env, bundle);
    try {
      const activities = Object.fromEntries(activityNames.map(name => [name, async (...args: any[]) => {
        const handler = harness.handlers[name];
        assert(handler, `Unexpected activity: ${name}`);
        return handler(...args);
      }]));
      for (const taskQueue of [currentQueue, legacyQueue, mutationQueue]) {
        const worker = await Worker.create({
          connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities,
          identity: "spaceapp-synthetic-test-worker",
          maxHeartbeatThrottleInterval: "20ms", defaultHeartbeatThrottleInterval: "20ms",
          ...(taskQueue === legacyQueue ? {
            patchActivationCallback: ({ patchId }: { patchId: string }) => patchId !== "room-background-continuation-v1"
          } : {})
        });
        harness.workers.push(worker);
        const run = worker.run();
        run.catch(() => undefined);
        harness.running.push(run);
      }
      return harness;
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  use(handlers: Handlers) {
    assert.equal(this.starts.length, 0, "Previous scenario was not cleaned up");
    this.handlers = handlers;
  }

  async start(workflowType: string, input: unknown, id: string, legacy = false) {
    const handle = await this.env.client.workflow.start(workflowType, {
      args: [input], workflowId: id, taskQueue: legacy ? legacyQueue : currentQueue
    });
    this.starts.push(handle);
    return handle;
  }

  async history(handle: StartedHandle, runId = handle.firstExecutionRunId) {
    return this.env.client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
  }

  async waitHistory(handle: StartedHandle, predicate: (history: History) => boolean, description: string, runId?: string) {
    let history!: History;
    await eventually(async () => { history = await this.history(handle, runId); return predicate(history); }, description);
    return history;
  }

  async continued(handle: StartedHandle) {
    // Wait for exactly the first run to close. Unlike handle.result(), this cannot
    // silently follow an indefinitely running supervisor through further runs.
    const first = this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
    await first.result().catch(error => {
      assert(error instanceof WorkflowContinuedAsNewError);
    });
    const history = await first.fetchHistory();
    const continued = eventsOf(history, "workflowExecutionContinuedAsNewEventAttributes").at(-1)?.workflowExecutionContinuedAsNewEventAttributes;
    assert(continued?.newExecutionRunId, "Expected continue-as-new");
    const next = this.env.client.workflow.getHandle(handle.workflowId, continued.newExecutionRunId);
    const nextHistory = await next.fetchHistory();
    assert.deepEqual(payload(nextHistory.events![0]!.workflowExecutionStartedEventAttributes!.input), payload(continued.input));
    return { history, input: payload<any>(continued.input), runId: continued.newExecutionRunId, next };
  }

  async cleanup(): Promise<RecordedExecution[]> {
    const starts = this.starts.splice(0);
    // Let outstanding replies reach the server before closing the execution.
    await this.drain();
    for (const handle of starts) {
      if ((await handle.describe()).status.name === "RUNNING") await handle.terminate("Synthetic scenario complete");
    }
    const executions: RecordedExecution[] = [];
    const seen = new Set<string>();
    const visit = async (workflowId: string, runId: string) => {
      if (seen.has(runId)) return;
      seen.add(runId);
      const handle = this.env.client.workflow.getHandle(workflowId, runId);
      if ((await handle.describe()).status.name === "RUNNING") await handle.terminate("Synthetic child cleanup");
      const history = await handle.fetchHistory();
      const first = history.events?.[0]?.workflowExecutionStartedEventAttributes;
      assert(first?.workflowType?.name, "History has no workflow type");
      executions.push({ workflowId, runId, workflowType: first.workflowType.name, history });
      for (const event of history.events ?? []) {
        const child = event.childWorkflowExecutionStartedEventAttributes?.workflowExecution;
        if (child?.workflowId && child.runId) await visit(child.workflowId, child.runId);
        const next = event.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
        if (next) await visit(workflowId, next);
      }
    };
    for (const handle of starts) await visit(handle.workflowId, handle.firstExecutionRunId);
    await this.drain();
    return executions;
  }

  private async drain() {
    await eventually(() => this.workers.every(worker => {
      const status = worker.getStatus();
      return status.numInFlightActivities === 0 && status.numInFlightWorkflowActivations === 0;
    }), "scenario workers drained before replacing activity handlers");
  }

  async close() {
    try {
      await this.cleanup();
    } finally {
      for (const worker of this.workers) if (worker.getState() === "RUNNING") worker.shutdown();
      try { await Promise.all(this.running); }
      finally { await this.env.teardown(); }
    }
  }
}

// A real Activity cancellation handshake, including server-delivered cancellation.
export async function untilCancelled(onStarted: () => void, onCancelled: () => void): Promise<never> {
  const context = Context.current();
  context.heartbeat();
  const heartbeat = globalThis.setInterval(() => context.heartbeat(), 10);
  onStarted();
  try {
    return await context.cancelled;
  } finally {
    clearInterval(heartbeat);
    onCancelled();
  }
}
