import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter, ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { WorkflowHandle, WorkflowHandleWithFirstExecutionRunId } from "@temporalio/client";
import { roomAgentSupervisorInputSchema } from "@space/contracts";
import proto from "@temporalio/proto";
import type { temporal as TemporalProto } from "@temporalio/proto";
const { temporal } = proto;

export type History = TemporalProto.api.history.v1.IHistory;
export const workflowPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));
const sourcePath = fileURLToPath(new URL("../../../src/workflows.ts", import.meta.url));
export async function bundle(variant?: "legacy" | "nondeterministic") {
  return bundleWorkflowCode({ workflowsPath: workflowPath, webpackConfigHook(config) {
    if (variant) config.module!.rules!.unshift({ test: (path: string) => path === sourcePath, enforce: "pre", use: [{ loader: fileURLToPath(new URL("./variant-loader.cjs", import.meta.url)), options: { variant } }] });
    return config;
  } });
}
export const activityNames = [
  "dotGoalStep", "dotGoalObserve", "recordDummyTurnStarted", "recordDummyTurnCompleted",
  "runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn", "markRoomAgentMissionStarted",
  "markRoomAgentMissionFinished", "markRoomAgentMissionContinued", "settleRoomAgentBackgroundMission",
  "checkRoomAgentSupervisorTurn", "prepareRoomAgentBackgroundContinuation", "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
] as const;
export type Call = { name: string; args: any[]; attempt: number; runId: string; workflowId: string };
export type Handlers = Partial<Record<typeof activityNames[number], (...args: any[]) => any>>;
export async function waitFor(check: () => boolean | Promise<boolean>, description: string) {
  const until = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < until, `Timed out: ${description}`); await delay(10); }
}
export class Harness {
  calls: Call[] = [];
  handlers: Handlers = {};
  private runs: Promise<void>[] = [];
  private workers: Worker[] = [];
  private count = 0;
  private closing?: Promise<void>;
  private code?: WorkflowBundleWithSourceMap;
  private queue?: string;
  constructor(public env: TestWorkflowEnvironment) {}
  async startWorkers(code: WorkflowBundleWithSourceMap, queue: string) {
    this.code = code; this.queue = queue;
    const activities = Object.fromEntries(activityNames.map(name => [name, async (...args: any[]) => {
      const info = Context.current().info;
      assert.ok(info.workflowExecution, "Synthetic activity belongs to a workflow");
      this.calls.push({ name, args, attempt: info.attempt, runId: info.workflowExecution.runId, workflowId: info.workflowExecution.workflowId });
      const fn = this.handlers[name];
      try {
        if (!fn) throw ApplicationFailure.nonRetryable(`Missing synthetic stub: ${name}`);
        return await fn(...args);
      } catch (error) {
        // Synthetic failure metadata must not embed a recorder's local filesystem path.
        for (let failure: unknown = error, depth = 0; failure instanceof Error && depth < 8; failure = failure.cause, depth++) {
          failure.stack = `${failure.name}: ${failure.message}\n    at synthetic-activity (${name}:1:1)`;
        }
        throw error;
      }
    }]));
    for (const taskQueue of [queue, "space-memory-maintenance", "space-memory-mutations"]) {
      const w = await Worker.create({ connection: this.env.nativeConnection, namespace: this.env.namespace,
        taskQueue, workflowBundle: code, activities, identity: "synthetic-temporal-worker",
        maxHeartbeatThrottleInterval: "10 milliseconds", defaultHeartbeatThrottleInterval: "10 milliseconds", shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds" });
      this.workers.push(w);
      this.runs.push(w.run());
    }
  }
  async restart() {
    // The test server uses global clock locks. Isolate scenarios which terminate
    // infinite supervisors so cancellation/termination cannot leak clock state.
    assert.ok(this.code && this.queue);
    await this.close();
    this.workers = []; this.runs = [];
    this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-temporal-client" } });
    this.closing = undefined;
    await this.startWorkers(this.code, this.queue);
  }
  reset(handlers: Handlers) { this.calls = []; this.handlers = handlers; }
  countCalls(name: string) { return this.calls.filter(c => c.name === name); }
  async start(workflowType: string, args: unknown, queue: string, id?: string) {
    const workflowId = id ?? `synthetic-${workflowType}-${++this.count}`;
    const h = await this.env.client.workflow.start(workflowType, { taskQueue: queue, workflowId, args: [args], workflowExecutionTimeout: "1 day" });
    return h;
  }
  async stop(h: WorkflowHandle) {
    // A stub invocation is not the server's completion acknowledgement. Terminating
    // between them can strand the ephemeral server's activity time-skipping lock.
    await waitFor(async () => {
      const description = await h.describe();
      return description.status.name !== "RUNNING" || (!description.raw.pendingActivities?.length
        && !description.raw.pendingChildren?.length && !description.raw.pendingWorkflowTask);
    }, "activity completion acknowledged before cleanup");
    await h.terminate("Synthetic test cleanup").catch(() => undefined);
  }
  close() {
    return this.closing ??= this.cleanup();
  }
  private async cleanup() {
    // Always destroy the disposable server, even if a scenario leaves a held
    // activity or a worker fails. No cleanup barrier may prevent teardown.
    try {
      for (const w of this.workers) if (w.getState() === "RUNNING") w.shutdown();
      const results = await Promise.allSettled(this.runs);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally { await this.env.teardown(); }
  }
}
export function events(history: History, type: keyof typeof proto.temporal.api.enums.v1.EventType) {
  return (history.events ?? []).filter(e => e.eventType === temporal.api.enums.v1.EventType[type]);
}
export function continuedInput(history: History) {
  const event = events(history, "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW")[0];
  assert.ok(event, "first run must continue as new");
  const attrs = event.workflowExecutionContinuedAsNewEventAttributes!;
  return { input: roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(attrs.input!.payloads![0]!)), runId: attrs.newExecutionRunId! };
}
export function activityTypes(history: History) {
  return events(history, "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED").map(e => e.activityTaskScheduledEventAttributes!.activityType!.name);
}
export async function currentHistory(h: WorkflowHandleWithFirstExecutionRunId, harness: Harness) {
  // Fixed run handle prevents a continue-as-new chain from hiding the run under test.
  return harness.env.client.workflow.getHandle(h.workflowId, h.firstExecutionRunId).fetchHistory();
}
export async function untilContinued(h: WorkflowHandleWithFirstExecutionRunId, harness: Harness) {
  await waitFor(async () => events(await currentHistory(h, harness), "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW").length > 0, "continue as new history");
  return currentHistory(h, harness);
}
