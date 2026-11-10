// DATA-001 / CORE-001: what a workflow does when the worker running its activity stops mid-attempt.
// Real workflow code, stub activities, an owned time-skipping server (CORE-006's setup); no live Temporal.
// A first worker takes the attempt and stops; a second worker on the same task queue is the restarted one.
// - A graceful stop (SIGTERM: every deploy and restart) cancels the attempt with WORKER_SHUTDOWN at once
//   (shutdownGraceTime 0). Each stub reacts as its real activity does: turns rethrow the abort, the memory
//   change set and the Dot Goal step ignore it and finish while the worker drains.
// - A hard kill (SIGKILL, power loss) is a worker that never answers or heartbeats again. Only turns and
//   background actions heartbeat (15 s), so only they time out here: this server never skips time while an
//   attempt is out with a worker, so the start-to-close waits of the other activities (memory change set
//   15 min, Dot Goal step 2 min, supervisor steps 1 min) are taken from workflows.ts, not shown.
// The stopped worker caches no workflow: this test server never moves a stopped worker's sticky tasks back
// to the task queue (a real server does after the sticky schedule-to-start timeout, as the live histories show).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { temporal } from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { buildCodexAppServerTurnWorkflowId, singleAttemptTurnOutcomeUnknownMessage } from "@space/contracts";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const eventType = temporal.api.enums.v1.EventType;
const timeoutType = temporal.api.enums.v1.TimeoutType;
type Bundle = Awaited<ReturnType<typeof bundleWorkflowCode>>;
type Activities = Record<string, (...args: never[]) => Promise<unknown>>;
let mainBundle: Bundle;
let mutationBundle: Bundle;
let env: TestWorkflowEnvironment | undefined;
const drains: Array<() => Promise<void>> = [];

const bundle = (file: string) => bundleWorkflowCode({
  workflowsPath: path.join(repoRoot, "apps/worker/src", file),
  webpackConfigHook: (config) => ({ ...config, resolve: { ...config.resolve,
    alias: { ...config.resolve?.alias, "@space/contracts": path.join(repoRoot, "packages/contracts/src") } } })
});

beforeAll(async () => {
  [mainBundle, mutationBundle] = await Promise.all([bundle("workflows.ts"), bundle("memory-mutation-workflows.ts")]);
}, 90_000);

beforeEach(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterEach(async () => {
  while (drains.length) await drains.pop()!();
  await env?.teardown();
  env = undefined;
}, 60_000);

type OnStop = "rethrow" | "finish" | "vanish";

/**
 * Runs the first worker. Its `activity` records its attempt and waits; `stop()` waits for attempt 1 and stops the
 * worker. On the WORKER_SHUTDOWN cancel the activity rethrows it ("rethrow"), keeps going and returns `result` while
 * the worker drains ("finish"), or never answers again ("vanish", a hard kill as the server sees it).
 */
async function firstWorker(taskQueue: string, workflowBundle: Bundle, activity: string, onStop: OnStop,
  { result, activities = {} }: { result?: unknown; activities?: Activities } = {}) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen = { attempts: [] as number[], cancel: [] as string[] };
  const worker = await Worker.create({ connection: env!.nativeConnection, taskQueue, workflowBundle, maxCachedWorkflows: 0,
    activities: { ...activities, [activity]: async () => {
      const context = Context.current();
      seen.attempts.push(context.info.attempt);
      const signal = context.cancellationSignal;
      const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => {
        seen.cancel.push(signal.reason instanceof Error ? signal.reason.message : String(signal.reason));
        if (onStop === "rethrow") reject(signal.reason);
      }));
      await Promise.race([held, aborted]);
      if (onStop === "vanish") throw new Error("lost worker drained after the test");
      return result;
    } } });
  const running = worker.run();
  drains.push(async () => { release(); await running.catch(() => undefined); });
  return {
    async stop() {
      await vi.waitFor(() => expect(seen.attempts).toEqual([1]), { timeout: 20_000 });
      worker.shutdown();
      if (onStop === "finish") { await vi.waitFor(() => expect(seen.cancel).toEqual(["WORKER_SHUTDOWN"])); release(); await running; }
      if (onStop === "rethrow") await running;
      return seen;
    }
  };
}

const nextWorker = (taskQueue: string, workflowBundle: Bundle, activities: Activities) =>
  Worker.create({ connection: env!.nativeConnection, taskQueue, workflowBundle, activities });

async function historyOf(workflowId: string) {
  return (await env!.client.workflow.getHandle(workflowId).fetchHistory()).events!;
}

const timedOut = (events: Awaited<ReturnType<typeof historyOf>>) => events
  .filter((e) => e.eventType === eventType.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT)
  .map((e) => e.activityTaskTimedOutEventAttributes!.failure!.timeoutFailureInfo!.timeoutType);
// The test server keeps no lastFailure on a retried attempt's started event, so a retry shows only as the next attempt number.
const failed = (events: Awaited<ReturnType<typeof historyOf>>) => events
  .filter((e) => e.eventType === eventType.EVENT_TYPE_ACTIVITY_TASK_FAILED)
  .map((e) => e.activityTaskFailedEventAttributes!.failure!.message);

const roomId = "room:stop-recovery";
const turn = (providerId: string, traceId: string) => ({
  roomId, paneId: "pane:stop-recovery", agentRunId: `agent_run:${traceId}`, roomAgentMissionId: "mission:stop-recovery",
  providerId, prompt: "Synthetic worker stop test", artifactIds: [], traceId,
  permissionMode: null, collaborationMode: "default"
});
const turnResult = (item: { turn: ReturnType<typeof turn> }) => ({
  workflowId: buildCodexAppServerTurnWorkflowId(item.turn), roomId, paneId: item.turn.paneId, traceId: item.turn.traceId,
  status: "COMPLETED", message: "Turn completed.",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Room action verified." }
});

/** Runs a mission through the supervisor: the first worker stops during its turn, the next one carries on. */
async function missionAcrossStop(name: string, providerId: string, turnActivity: string, onStop: OnStop) {
  const taskQueue = `data001-${name}`;
  const item = { missionId: "mission:stop-recovery", turn: turn(providerId, `req:${name}`) };
  const ready = async () => "READY";
  const first = await firstWorker(taskQueue, mainBundle, turnActivity, onStop, { activities: { checkRoomAgentSupervisorTurn: ready } });
  const handle = await env!.client.workflow.start("roomAgentSupervisorWorkflow", { workflowId: taskQueue, taskQueue,
    args: [{ roomId, pending: [item] }] });
  const seen = await first.stop();
  const finish = vi.fn(async () => undefined);
  const discard = vi.fn(async () => undefined);
  const again: number[] = [];
  const worker = await nextWorker(taskQueue, mainBundle, {
    checkRoomAgentSupervisorTurn: ready, finishRoomAgentSupervisorTurn: finish, discardRoomAgentSupervisorTurn: discard,
    [turnActivity]: async () => { again.push(Context.current().info.attempt); return turnResult(item); }
  });
  let child: Awaited<ReturnType<typeof historyOf>> = [];
  await worker.runUntil(async () => {
    try {
      await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce(), { timeout: 40_000, interval: 250 });
      child = await historyOf(buildCodexAppServerTurnWorkflowId(item.turn));
    } finally {
      await handle.cancel(); // supervisors never complete on their own
    }
  });
  return { item, seen, again, finish, discard, child };
}

it("graceful stop: a memory change set finishes while the worker drains and the workflow completes on the next worker", async () => {
  const taskQueue = "data001-memory-mutation";
  const input = { changeSetId: "memory_change:stop-recovery", traceId: "req:stop-recovery" };
  const applied = { changeSetId: input.changeSetId, status: "APPLIED" };
  const first = await firstWorker(taskQueue, mutationBundle, "executePersistedMemoryChangeSet", "finish", { result: applied });
  const handle = await env!.client.workflow.start("memoryMutationWorkflow", { workflowId: taskQueue, taskQueue,
    args: [input], workflowExecutionTimeout: "1 hour" });
  const seen = await first.stop();
  const again = vi.fn(async () => applied);
  const worker = await nextWorker(taskQueue, mutationBundle, { executePersistedMemoryChangeSet: again });
  expect(await worker.runUntil(handle.result())).toEqual(applied);
  expect(seen).toEqual({ attempts: [1], cancel: ["WORKER_SHUTDOWN"] });
  expect(again).not.toHaveBeenCalled();
  const events = await historyOf(taskQueue);
  expect([failed(events), timedOut(events)]).toEqual([[], []]);
}, 60_000);

it("graceful stop: a Dot Goal step finishes while the worker drains and the next worker observes and completes the Goal", async () => {
  const taskQueue = "data001-dot-goal";
  const first = await firstWorker(taskQueue, mainBundle, "dotGoalStep", "finish",
    { result: { state: "STARTED", runId: "run:stop-recovery", goalStatus: "RUNNING" } });
  const handle = await env!.client.workflow.start("dotGoalWorkflow", { workflowId: taskQueue, taskQueue,
    args: [{ goalId: "dot_goal:stop-recovery" }], workflowExecutionTimeout: "1 hour" });
  const seen = await first.stop();
  const calls: string[] = [];
  const worker = await nextWorker(taskQueue, mainBundle, {
    dotGoalObserve: async ({ runId }: { runId: string }) => { calls.push(`observe ${runId}`); return { run: "COMPLETED", goalStatus: "RUNNING" }; },
    dotGoalStep: async () => { calls.push(`step ${Context.current().info.attempt}`); return { state: "DONE", runId: null, goalStatus: "COMPLETED" }; }
  });
  expect(await worker.runUntil(handle.result())).toEqual({ goalStatus: "COMPLETED" });
  expect(seen).toEqual({ attempts: [1], cancel: ["WORKER_SHUTDOWN"] });
  expect(calls).toEqual(["observe run:stop-recovery", "step 1"]);
  expect(failed(await historyOf(taskQueue))).toEqual([]);
}, 60_000);

it("graceful stop: a Room Agent mission's Codex turn is retried at once on the next worker and the mission finishes once", async () => {
  const { item, seen, again, finish, discard, child } = await missionAcrossStop("codex-stop", "codex", "runCodexAppServerTurn", "rethrow");
  expect(seen).toEqual({ attempts: [1], cancel: ["WORKER_SHUTDOWN"] });
  expect(again).toEqual([2]);
  expect(finish).toHaveBeenCalledWith({ item, status: "COMPLETED", statusReason: "Room action verified." });
  expect(discard).not.toHaveBeenCalled();
}, 90_000);

it("graceful stop: a single-attempt OpenCode mission turn is never re-sent and the mission ends FAILED with an unknown outcome", async () => {
  const { item, seen, again, finish, discard, child } = await missionAcrossStop("opencode-stop", "opencode", "runOpenCodeAgentTurn", "rethrow");
  expect(seen).toEqual({ attempts: [1], cancel: ["WORKER_SHUTDOWN"] });
  expect(again).toEqual([]);
  expect(failed(child)).toHaveLength(1);
  // The mission says why, like the turn's own run record: the worker stopped and the outcome is unknown.
  const reason = singleAttemptTurnOutcomeUnknownMessage;
  expect(discard).toHaveBeenCalledWith({ item, reason, errorCode: "TURN_OUTCOME_UNKNOWN" });
  expect(finish).toHaveBeenCalledWith({ item, status: "FAILED", statusReason: reason, errorCode: "TURN_OUTCOME_UNKNOWN" });
}, 90_000);

it("hard kill: a Room Agent mission's Codex turn is retried on the next worker after its 15 s heartbeat timeout", async () => {
  const { item, seen, again, finish, discard, child } = await missionAcrossStop("codex-kill", "codex", "runCodexAppServerTurn", "vanish");
  expect(seen.attempts).toEqual([1]);
  expect(again).toEqual([2]);
  expect(finish).toHaveBeenCalledWith({ item, status: "COMPLETED", statusReason: "Room action verified." });
  expect(discard).not.toHaveBeenCalled();
}, 90_000);

it("hard kill: a single-attempt OpenCode mission turn times out on its heartbeat and the mission ends FAILED with a timeout code", async () => {
  const { item, seen, again, finish, discard, child } = await missionAcrossStop("opencode-kill", "opencode", "runOpenCodeAgentTurn", "vanish");
  expect(seen.attempts).toEqual([1]);
  expect(again).toEqual([]);
  expect(timedOut(child)).toEqual([timeoutType.TIMEOUT_TYPE_HEARTBEAT]);
  const failure = { item, reason: "Room Agent supervisor turn failed.", errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT" };
  expect(discard).toHaveBeenCalledWith(failure);
  expect(finish).toHaveBeenCalledWith({ item, status: "FAILED", statusReason: failure.reason, errorCode: failure.errorCode });
}, 90_000);

it("hard kill: a Room Agent background action is retried on the next worker after its 15 s heartbeat timeout", async () => {
  const taskQueue = "data001-room-action";
  const input = { actionId: "action:stop-recovery", bridge: { roomId, missionId: "mission:stop-recovery" } };
  const first = await firstWorker(taskQueue, mainBundle, "runRoomAgentBackgroundAction", "vanish");
  const handle = await env!.client.workflow.start("roomAgentActionWorkflow", { workflowId: taskQueue, taskQueue,
    args: [input], workflowExecutionTimeout: "1 hour" });
  const seen = await first.stop();
  const again: number[] = [];
  const failAction = vi.fn(async () => undefined);
  const worker = await nextWorker(taskQueue, mainBundle, {
    runRoomAgentBackgroundAction: async () => { again.push(Context.current().info.attempt); return { status: "COMPLETED" }; },
    failRoomAgentBackgroundAction: failAction
  });
  expect(await worker.runUntil(handle.result())).toEqual({ status: "COMPLETED" });
  expect([seen.attempts, again]).toEqual([[1], [2]]);
  expect(failAction).not.toHaveBeenCalled();
}, 90_000);
