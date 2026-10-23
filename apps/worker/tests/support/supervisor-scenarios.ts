import assert from "node:assert/strict";
import { Context, CancelledFailure } from "@temporalio/activity";
import { WorkflowContinuedAsNewError, type WorkflowHandle } from "@temporalio/client";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema,
  type RoomAgentSupervisorQueueItem,
} from "@space/contracts";
import { continuationFixture } from "../room-continuation-fixture.js";
import {
  discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState,
} from "../../src/room-background-continuation.js";

import type { ScenarioContext, WorkflowScenario } from "./temporal-test-harness.js";
type StartedHandle = WorkflowHandle & { firstExecutionRunId?: string };
type SupervisorScenarioContext = ScenarioContext;
type SupervisorScenario = WorkflowScenario;
/**
 * Expose a promise and its settlement callbacks for explicit host/activity synchronization.
 * Settling it does not advance the Temporal test server clock.
 */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/**
 * Bound a host-side wait and identify the stalled observation in the error.
 * Always clear the timer; timing out does not cancel the supplied promise.
 */
async function deadline<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
// The zero-delay yield synchronizes transport callbacks only. Every workflow timer
// is advanced by the real test server, never by this host timer.
/**
 * Advance the real test-server clock one second at a time until ready is observed.
 * Host yields only drain transport callbacks; both the step count and wall-clock deadline bound the wait.
 */
async function pump(ctx: SupervisorScenarioContext, ready: () => boolean, label: string, max = 1_200) {
  const expires = Date.now() + 20_000;
  for (let i = 0; i < max && Date.now() < expires && !ready(); i++) {
    await ctx.env.sleep("1 second");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  assert.ok(ready(), `No observed ${label} after ${max} real server-clock steps`);
}
/**
 * Return a handle pinned to the native firstExecutionRunId for first-run assertions.
 * Fail if the scenario starter did not preserve that run identity.
 */
function firstRun(ctx: SupervisorScenarioContext, handle: StartedHandle): WorkflowHandle {
  assert.equal(typeof handle.firstExecutionRunId, "string", "ctx.start must preserve native firstExecutionRunId");
  return ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
}
/**
 * Decode a test payload only after checking the default json/plain encoding and data.
 */
function decodeJsonPayload(payload: any) {
  assert.ok(payload?.data, "Expected default JSON payload");
  assert.equal(Buffer.from(payload.metadata?.encoding ?? []).toString(), "json/plain");
  return JSON.parse(Buffer.from(payload.data).toString("utf8"));
}
/**
 * Await the pinned execution with followRuns disabled and require actual continue-as-new.
 * Return its schema-checked carried input, first-run history and next run ID.
 */
async function continuedInput(ctx: SupervisorScenarioContext, pinned: WorkflowHandle) {
  const { runId } = await pinned.describe();
  const firstOnly = ctx.client.workflow.getHandle(pinned.workflowId, runId, { followRuns: false });
  // Awaiting the first run unlocks the actual time-skipping server. Stop at the
  // continue-as-new boundary instead of polling large histories after each tick.
  await assert.rejects(firstOnly.result(), WorkflowContinuedAsNewError);
  const history: any = await pinned.fetchHistory();
  const event = history.events?.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
  assert.ok(event, 'Expected actual continue-as-new command in the first run');
  const attrs = event.workflowExecutionContinuedAsNewEventAttributes;
  return { input: roomAgentSupervisorInputSchema.parse(decodeJsonPayload(attrs.input?.payloads?.[0])), history, nextRunId: attrs.newExecutionRunId as string };
}

/**
 * Construct a schema-checked synthetic supervisor item with explicit mission and room identity.
 */
function queued(suffix: string, missionId = `mission:${suffix}`, roomId = "room:supervisor-synthetic") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
    roomId, paneId: "pane:supervisor-synthetic", prompt: `Synthetic request ${suffix}`,
    roomAgentOperatorRequest: `Synthetic request ${suffix}`, roomAgentMissionId: missionId,
    agentRunId: `agent_run:${suffix}`, traceId: `trace:${suffix}`,
  } });
}
/**
 * Create a synthetic successful turn outcome with optional pending action IDs.
 * This fixture shape is not evidence of an external task or customer result.
 */
function verified(pendingActionIds: string[] = []) {
  return { status: "COMPLETED", message: "Synthetic verified result", roomAgentOutcome: {
    status: "VERIFIED", executedActionCount: 1, pendingActionIds, statusReason: "Verified remaining request.",
  } };
}
/**
 * Install synthetic supervisor activity defaults and collect forwarded calls for assertions.
 * Individual scenarios replace these stubs when exercising failure, signals or continuation.
 */
function installBasic(ctx: SupervisorScenarioContext) {
  const calls = { turns: [] as any[], started: [] as any[], finished: [] as any[],
    continued: [] as any[], checked: [] as any[], discarded: [] as any[] };
  Object.assign(ctx.activities, {
    runCodexAppServerTurn: async (turn: any) => { calls.turns.push(turn); return verified(); },
    markRoomAgentMissionStarted: async (x: any) => { calls.started.push(x); },
    markRoomAgentMissionFinished: async (x: any) => { calls.finished.push(x); },
    markRoomAgentMissionContinued: async (x: any) => { calls.continued.push(x); },
    checkRoomAgentSupervisorTurn: async (x: any) => { calls.checked.push(x); return "READY"; },
    discardRoomAgentSupervisorTurn: async (x: any) => { calls.discarded.push(x); },
    finishRoomAgentSupervisorTurn: async (x: any) => { calls.finished.push(x); },
    settleRoomAgentBackgroundMission: async () => true,
    prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" }),
  });
  return calls;
}
/**
 * Adapt real continuation functions to an isolated in-memory fixture store.
 * Collect prepared, executed, discarded and finished turns without provider or database access.
 */
function fixtureDriver(ctx: SupervisorScenarioContext) {
  const c = continuationFixture();
  const prepared: RoomAgentSupervisorQueueItem[] = [];
  const turns: any[] = [];
  const discarded: any[] = [];
  const finished: any[] = [];
  Object.assign(ctx.activities, {
    prepareRoomAgentBackgroundContinuation: async (input: any) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    },
    checkRoomAgentSupervisorTurn: (item: any) => supervisorTurnState(item, c.store),
    discardRoomAgentSupervisorTurn: async ({ item, reason }: any) => {
      await discardSupervisorTurn(item, reason, c.store); discarded.push({ item, reason });
    },
    finishRoomAgentSupervisorTurn: async (input: any) => {
      await finishSupervisorTurn(input, c.store); finished.push(input);
    },
    runCodexAppServerTurn: async (turn: any) => {
      turns.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return verified();
    },
  });
  const input = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { ...c, input, prepared, turns, discarded, finished };
}
/**
 * Collect nested cause messages so a test can assert persisted activity-failure context.
 */
function causeMessages(error: unknown) {
  const messages: string[] = [];
  for (let e = error as any; e; e = e.cause) messages.push(String(e.message ?? e));
  return messages.join(" | ");
}

const actionFailure: SupervisorScenario = {
  name: "action retry exhaustion preserves legacy-id failure persistence", workflowType: "roomAgentActionWorkflow",
  async run(ctx) {
    const failures: any[] = [];
    let attempts = 0;
    ctx.activities.runRoomAgentBackgroundAction = async () => { attempts++; const error = new Error("synthetic transport failed"); error.stack = "Error: synthetic transport failed"; throw error; };
    ctx.activities.failRoomAgentBackgroundAction = async (input: any) => { failures.push(input); };
    const h = await ctx.start("roomAgentActionWorkflow", {
      bridge: { roomId: "room:proof", missionId: "mission:proof" }, traceId: "trace:proof",
    }, { workflowId: "space-room-action:action:legacy" });
    await assert.rejects(h.result(), (error: unknown) => causeMessages(error).includes("synthetic transport failed"));
    assert.equal(attempts, 5);
    assert.deepEqual(failures, [{ roomId: "room:proof", missionId: "mission:proof", actionId: "action:legacy", cancelled: false }]);
    await ctx.capture(h, "room-action-failure");
  },
};
const allocation: SupervisorScenario = {
  name: "allocation send and verification stay in one mission", workflowType: "roomAgentSupervisorWorkflow",
  async run(ctx) {
    const c = fixtureDriver(ctx);
    ctx.activities.runCodexAppServerTurn = async (turn: any) => {
      c.turns.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (c.turns.length === 1) {
        assert.match(turn.prompt, /Open CLI and Chat, then send a story/);
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return verified(["action:send"]);
      }
      return verified();
    };
    const h = await ctx.start("roomAgentSupervisorWorkflow", c.input);
    await pump(ctx, () => c.finished.length === 1, "verified mission completion");
    assert.equal(c.turns.length, 2);
    assert.equal(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND").length, 1);
    assert.equal(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, "COMPLETED");
    assert.equal(c.finished.length, 1);
    await ctx.capture(h, "supervisor-current");
  },
};
/**
 * Build the race where stop or follow-up arrives before a READY activity reply.
 * The scenario checks that the obsolete prepared continuation is retired.
 */
function readyRace(kind: "stop" | "follow-up"): SupervisorScenario {
  return {
    name: `prepared continuation retired after ${kind} before activity reply`, workflowType: "roomAgentSupervisorWorkflow",
    async run(ctx) {
      const c = fixtureDriver(ctx);
      const handleReady = deferred<StartedHandle>();
      const prepare = ctx.activities.prepareRoomAgentBackgroundContinuation!;
      let first = true;
      let prepareCalls = 0;
      ctx.activities.prepareRoomAgentBackgroundContinuation = async (input: any) => {
        prepareCalls++;
        const result = await prepare(input);
        if (first) {
          first = false;
          assert.equal(result.state, "READY");
          const h = await handleReady.promise;
          if (kind === "stop") {
            c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
            await h.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
          } else {
            const followUp = c.enqueue("follow-up", "Only inspect the room.");
            await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
          }
        }
        return result;
      };
      const h = await ctx.start("roomAgentSupervisorWorkflow", c.input);
      handleReady.resolve(h);
      await pump(ctx, () => c.discarded.length > 0 && (kind === "stop" || c.turns.length > 0), `${kind} race resolved`);
      assert.ok(c.prepared.length >= 1);
      const stale = c.prepared[0]!;
      assert.equal(c.store.getRoomAgentTurn(c.initial.mission.id, stale.turn.agentRunId)?.run.status, "INTERRUPTED");
      if (kind === "stop") {
        assert.equal(c.turns.length, 0);
        // A stale READY result must not restore monitoring after stop. Keep the
        // server clock moving beyond the normal one-second polling interval.
        await ctx.env.sleep("3 seconds");
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.equal(prepareCalls, 1, "stop removes the mission from monitoring");
      }
      else assert.equal(c.turns[0]!.roomAgentOperatorRequest, "Only inspect the room.");
    },
  };
}
const carriedReady: SupervisorScenario = {
  name: "prepared continuation carried into next run and executed once", workflowType: "roomAgentSupervisorWorkflow",
  async run(ctx) {
    const c = fixtureDriver(ctx);
    const h = await ctx.start("roomAgentSupervisorWorkflow", { ...c.input, processedCount: 50 });
    const pinned = firstRun(ctx, h);
    const { input, history } = await continuedInput(ctx, pinned);
    assert.equal(input.pending.length, 1);
    const firstRunChildren = history.events.filter((e: any) => e.startChildWorkflowExecutionInitiatedEventAttributes);
    assert.equal(firstRunChildren.length, 0, "first run carries rather than executing the continuation");
    assert.equal(input.pending[0]!.turn.agentRunId, c.prepared[0]!.turn.agentRunId);
    await pump(ctx, () => c.finished.length === 1, "carried continuation completion");
    assert.equal(c.turns.length, 1);
    assert.equal(c.turns[0]!.agentRunId, input.pending[0]!.turn.agentRunId);
    assert.equal(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, "COMPLETED");
    await ctx.capture(pinned, "supervisor-current-continued");
  },
};
const carryBound: SupervisorScenario = {
  name: "continue-as-new defers until queued state fits100item bound", workflowType: "roomAgentSupervisorWorkflow",
  async run(ctx) {
    const calls = installBasic(ctx);
    const roomId = "room:carry-bound";
    const item = (i: number) => queued(`carry-${String(i).padStart(3, "0")}`, "mission:carry-bound", roomId);
    const entered = deferred(); const release = deferred();
    let checks = 0;
    ctx.activities.checkRoomAgentSupervisorTurn = async () => {
      checks++;
      if (checks === 1) { entered.resolve(undefined); await release.promise; }
      return "SKIP";
    };
    const h = await ctx.start("roomAgentSupervisorWorkflow", { roomId, pending: [item(0)], processedCount: 49 });
    const pinned = firstRun(ctx, h);
    await deadline(entered.promise, "first blocked state check");
    try {
      // All105 signal events are accepted before the activity completes.
      for (let i = 1; i <= 105; i++) await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(i));
    } finally { release.resolve(undefined); }
    const { input, history } = await continuedInput(ctx, pinned);
    assert.equal(input.pending.length, 100);
    assert.equal(input.processedCount, 0);
    assert.deepEqual(input.pending.map(p => p.turn.agentRunId), Array.from({ length: 100 }, (_, i) => item(i + 6).turn.agentRunId));
    const checkedEvents = history.events.filter((e: any) => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
    assert.equal(checkedEvents.length, 6, "five extra turns drained; no accepted item lost");
    assert.ok(calls.discarded.length >= 6);
  },
};
const legacySettle: SupervisorScenario = {
  name: "prepatch supervisor retains boolean settle contract", workflowType: "roomAgentSupervisorWorkflow", legacy: true,
  async run(ctx) {
    installBasic(ctx); let settles = 0; let prepares = 0;
    ctx.activities.settleRoomAgentBackgroundMission = async () => { settles++; return true; };
    ctx.activities.prepareRoomAgentBackgroundContinuation = async () => { prepares++; return { state: "DONE" }; };
    const h = await ctx.start("roomAgentSupervisorWorkflow", { roomId: "room:legacy-settle", monitoringMissionIds: ["mission:legacy-settle"] });
    await pump(ctx, () => settles === 1, "legacy settle");
    await ctx.env.sleep("2 seconds");
    assert.equal(settles, 1);
    assert.equal(prepares, 0);
    await ctx.capture(h, "supervisor-prepatch");
  },
};
/**
 * Build current or legacy signal coverage that cancels the active child and retains other work.
 * Heartbeat synchronization observes actual activity cancellation before checking queued outcomes.
 */
function interruptRunning(legacy: boolean): SupervisorScenario {
  return {
    name: `${legacy ? "prepatch" : "current"} real enqueue stop and active child cancellation`,
    workflowType: "roomAgentSupervisorWorkflow", legacy,
    async run(ctx) {
      const calls = installBasic(ctx);
      const active = queued(`active-${legacy}`);
      const stoppedQueued = queued(`queued-stop-${legacy}`, active.missionId);
      const retained = queued(`retained-${legacy}`);
      const entered = deferred(); const cancelled = deferred();
      ctx.activities.runCodexAppServerTurn = async (turn: any) => {
        calls.turns.push(turn);
        if (turn.agentRunId !== active.turn.agentRunId) return verified();
        const activity = Context.current();
        activity.heartbeat("synthetic running");
        entered.resolve(undefined);
        const beat = setInterval(() => activity.heartbeat("synthetic running"), 50);
        try { return await activity.cancelled; }
        catch (error) { assert.ok(error instanceof CancelledFailure); cancelled.resolve(undefined); throw error; }
        finally { clearInterval(beat); }
      };
      const h = await ctx.start("roomAgentSupervisorWorkflow", { roomId: active.turn.roomId });
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await deadline(entered.promise, "active child activity");
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, stoppedQueued);
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, retained);
      await h.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: active.missionId, reason: "Synthetic operator stop" });
      // Do not virtual-time-skip while deliberately holding an active activity.
      await deadline(cancelled.promise, "actual activity cancellation");
      await pump(ctx, () => calls.finished.length >= 3 && calls.turns.some(t => t.agentRunId === retained.turn.agentRunId), "cancelled plus retained missions");
      assert.equal(calls.turns.filter(t => t.agentRunId === active.turn.agentRunId).length, 1);
      assert.equal(calls.turns.filter(t => t.agentRunId === stoppedQueued.turn.agentRunId).length, 0);
      assert.equal(calls.turns.filter(t => t.agentRunId === retained.turn.agentRunId).length, 1);
      const interrupted = calls.finished.filter(x => x.status === "INTERRUPTED");
      assert.equal(interrupted.length, 2);
      assert.ok(interrupted.every(x => x.statusReason === "Synthetic operator stop"));
    },
  };
}
/**
 * Build the 50-processed continuation case for the selected supervisor branch.
 * Assert that branch's distinct pending/interrupted state and retained monitoring cross the boundary.
 */
function processed50(legacy: boolean): SupervisorScenario {
  return {
    name: `${legacy ? "prepatch" : "current"}50processed continuation preserves carried state`,
    workflowType: "roomAgentSupervisorWorkflow", legacy,
    async run(ctx) {
      installBasic(ctx);
      const a = queued(`processed-a-${legacy}`); const b = queued(`processed-b-${legacy}`);
      const monitor = "mission:carry-monitor";
      const raw = { roomId: a.turn.roomId, pending: [a, b], monitoringMissionIds: [monitor], processedCount: 49,
        ...(!legacy ? { interrupted: [
          { item: queued("already-stopped-a"), reason: "Previously stoppedA" },
          { item: queued("already-stopped-b"), reason: "Previously stoppedB" },
        ] } : {}) };
      const h = await ctx.start("roomAgentSupervisorWorkflow", raw);
      const { input } = await continuedInput(ctx, firstRun(ctx, h));
      assert.equal(input.processedCount, 0);
      assert.deepEqual(input.monitoringMissionIds, [monitor]);
      if (legacy) { assert.deepEqual(input.pending, [b]); assert.deepEqual(input.interrupted, []); }
      else {
        assert.deepEqual(input.pending, [a, b]);
        assert.equal(input.interrupted.length, 1);
        assert.equal(input.interrupted[0]!.reason, "Previously stoppedB");
      }
    },
  };
}
/**
 * Build the 250-poll continuation case and count polls by execution run.
 * Require 250 actual first-run one-second timers and unchanged monitoring in the next input.
 */
function polled250(legacy: boolean): SupervisorScenario {
  return {
    name: `${legacy ? "prepatch" : "current"}250one-second polls continue with monitoring intact`,
    workflowType: "roomAgentSupervisorWorkflow", legacy,
    async run(ctx) {
      installBasic(ctx);
      const byRun = new Map<string, number>();
      const poll = () => {
        const execution = Context.current().info.workflowExecution;
        assert.ok(execution, "Synthetic activity must belong to a workflow");
        const runId = execution.runId;
        byRun.set(runId, (byRun.get(runId) ?? 0) + 1);
        return legacy ? false : { state: "WAITING" };
      };
      if (legacy) ctx.activities.settleRoomAgentBackgroundMission = poll;
      else ctx.activities.prepareRoomAgentBackgroundContinuation = poll;
      const missionId = "mission:poll-threshold";
      const h = await ctx.start("roomAgentSupervisorWorkflow", { roomId: "room:poll-threshold", monitoringMissionIds: [missionId] });
      const pinned = firstRun(ctx, h);
      const { input, history } = await continuedInput(ctx, pinned);
      assert.equal(byRun.get(h.firstExecutionRunId!), 250);
      assert.deepEqual(input.monitoringMissionIds, [missionId]);
      assert.deepEqual(input.pending, []); assert.deepEqual(input.interrupted, []);
      const timers = history.events.filter((e: any) => e.timerStartedEventAttributes);
      assert.equal(timers.length, 250);
      assert.ok(timers.every((e: any) => Number(e.timerStartedEventAttributes.startToFireTimeout?.seconds) === 1));
    },
  };
}
const currentSignals: SupervisorScenario = {
  name: "current branch ignores wrong-room and duplicate active or queued signals", workflowType: "roomAgentSupervisorWorkflow",
  async run(ctx) {
    const calls = installBasic(ctx); const entered = deferred(); const release = deferred();
    const active = queued("dedup-active"); const next = queued("dedup-next");
    ctx.activities.runCodexAppServerTurn = async (turn: any) => {
      calls.turns.push(turn);
      if (turn.agentRunId === active.turn.agentRunId) { entered.resolve(undefined); await release.promise; }
      return verified();
    };
    const h = await ctx.start("roomAgentSupervisorWorkflow", { roomId: active.turn.roomId });
    await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active); await deadline(entered.promise, "dedup active");
    try {
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, next); await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, next);
      await h.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued("wrong-room", "mission:wrong", "room:other"));
    } finally { release.resolve(undefined); }
    await pump(ctx, () => calls.finished.length >= 2, "deduplicated completions");
    assert.deepEqual(calls.turns.map(t => t.agentRunId), [active.turn.agentRunId, next.turn.agentRunId]);
  },
};
export const supervisorScenarios: SupervisorScenario[] = [
  actionFailure, allocation, readyRace("stop"), readyRace("follow-up"), carriedReady,
  carryBound, legacySettle, interruptRunning(false), interruptRunning(true),
  processed50(false), processed50(true), polled250(false), polled250(true), currentSignals,
];
export const supervisorActivityNames = [
  "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction", "runCodexAppServerTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "settleRoomAgentBackgroundMission", "prepareRoomAgentBackgroundContinuation",
] as const;
