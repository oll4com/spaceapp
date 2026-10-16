import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  buildCodexAppServerTurnWorkflowId,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  type DummyTurnInput,
  type RoomAgentSupervisorQueueItem,
  type TurnWorkflowResult
} from "@space/contracts";
import { expect } from "vitest";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import type { Scenario } from "./temporal-test-harness.js";

type ScenarioContext = Parameters<Scenario["run"]>[0];
type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;
type Finish = Parameters<typeof finishSupervisorTurn>[0];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// These waits synchronize with real activity executions. Workflow timers are
// advanced only through TestWorkflowEnvironment.sleep, never a mocked SDK.
async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function advanceUntil(ctx: ScenarioContext, predicate: () => boolean, seconds = 8) {
  for (let index = 0; index < seconds && !predicate(); index++) {
    await ctx.env.sleep("1 second");
    // Let the activity reply and the following Workflow Task reach the worker.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await eventually(predicate, "the expected activity result");
}

async function pinned(ctx: ScenarioContext, handle: WorkflowHandle) {
  const { runId } = await handle.describe();
  return ctx.env.client.workflow.getHandle(handle.workflowId, runId, { followRuns: false });
}

async function closeAndRecord(ctx: ScenarioContext, handle: WorkflowHandle, name: string) {
  // An activity-side marker is visible before its completion reaches Temporal.
  // Drain that reply before termination so the test server can release its
  // activity time-skipping lock and the history contains the completed effect.
  await eventually(async () => {
    const description = await handle.describe();
    return !description.raw.pendingActivities?.length && !description.raw.pendingChildren?.length;
  }, `activities and children in ${name} to drain`);
  await handle.terminate("Integration scenario assertions completed.");
  await ctx.record(handle, name);
}

async function recordChild(ctx: ScenarioContext, turn: DummyTurnInput, name: string) {
  const handle = ctx.env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(turn));
  await eventually(async () => (await handle.describe()).status.name !== "RUNNING", `child ${name} to close`);
  await ctx.record(handle, name);
}

function continued(history: History) {
  return history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
    ?.workflowExecutionContinuedAsNewEventAttributes;
}

async function continuation(ctx: ScenarioContext, handle: WorkflowHandle) {
  let history!: History;
  await eventually(async () => {
    history = await handle.fetchHistory();
    return Boolean(continued(history));
  }, "Continue-As-New");
  const attributes = continued(history)!;
  const payload = attributes.input?.payloads?.[0]?.data;
  expect(payload).toBeDefined();
  const input = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(payload!).toString("utf8")));
  const next = ctx.env.client.workflow.getHandle(handle.workflowId, attributes.newExecutionRunId!, { followRuns: false });
  return { history, input, next };
}

function oneSecondTimers(history: History, minimum: number) {
  const timers = history.events?.flatMap((event) => event.timerStartedEventAttributes ? [event.timerStartedEventAttributes] : []) ?? [];
  expect(timers.length).toBeGreaterThanOrEqual(minimum);
  for (const timer of timers) {
    expect(Number(timer.startToFireTimeout?.seconds ?? 0)).toBe(1);
    expect(timer.startToFireTimeout?.nanos ?? 0).toBe(0);
  }
}

function queueItem(index: string | number, roomId = "room:temporal-supervisor", missionId = "mission:temporal-supervisor") {
  return roomAgentSupervisorQueueItemSchema.parse({
    missionId,
    turn: {
      roomId, paneId: "pane:temporal-supervisor", prompt: `Request ${index}`,
      agentRunId: `agent_run:temporal-${index}`, traceId: `trace:temporal-${index}`
    }
  });
}

function verified(pendingActionIds?: string[]): TurnWorkflowResult {
  return {
    status: "COMPLETED", message: "Verified",
    roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1,
      statusReason: "Verified remaining request.",
      ...(pendingActionIds ? { pendingActionIds } : {})
    }
  } as TurnWorkflowResult;
}

function fixtureDriver() {
  const c = continuationFixture();
  const turns: DummyTurnInput[] = [];
  const prepared: RoomAgentSupervisorQueueItem[] = [];
  const discarded: Array<{ item: RoomAgentSupervisorQueueItem; reason: string }> = [];
  const finished: Finish[] = [];
  const activities = {
    async prepareRoomAgentBackgroundContinuation(input: Parameters<typeof prepareBackgroundContinuation>[0]) {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    },
    checkRoomAgentSupervisorTurn: (item: RoomAgentSupervisorQueueItem) => supervisorTurnState(item, c.store),
    async discardRoomAgentSupervisorTurn(input: { item: RoomAgentSupervisorQueueItem; reason: string }) {
      discarded.push(input);
      await discardSupervisorTurn(input.item, input.reason, c.store);
    },
    async finishRoomAgentSupervisorTurn(input: Finish) {
      await finishSupervisorTurn(input, c.store);
      finished.push(input);
    },
    async runCodexAppServerTurn(turn: DummyTurnInput) {
      turns.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return verified();
    }
  };
  const input = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { ...c, activities, turns, prepared, discarded, finished, input };
}

function allocationScenario(): Scenario {
  const c = fixtureDriver();
  c.activities.runCodexAppServerTurn = async (turn) => {
    c.turns.push(turn);
    c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
    if (c.turns.length === 1) {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      return verified(["action:send"]);
    }
    return verified();
  };
  return {
    name: "supervisor-allocation-send-verification", activities: c.activities,
    async run(ctx) {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [c.input]);
      await advanceUntil(ctx, () => c.finished.length === 1);
      expect(c.turns).toHaveLength(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      expect(c.finished).toHaveLength(1);
      const history = await handle.fetchHistory();
      oneSecondTimers(history, 2);
      await recordChild(ctx, c.turns[0]!, "allocation-send-child");
      await recordChild(ctx, c.turns[1]!, "allocation-verify-child");
      await closeAndRecord(ctx, handle, "allocation-supervisor");
    }
  };
}

function preparedRaceScenario(kind: "stop" | "follow-up"): Scenario {
  const c = fixtureDriver();
  const reply = gate();
  const prepare = c.activities.prepareRoomAgentBackgroundContinuation;
  c.activities.prepareRoomAgentBackgroundContinuation = async (input) => {
    const result = await prepare(input);
    if (c.prepared.length === 1) await reply.promise;
    return result;
  };
  return {
    name: `supervisor-prepared-${kind}-race`, activities: c.activities,
    async run(ctx) {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [c.input]);
      try {
        await advanceUntil(ctx, () => c.prepared.length === 1);
        const prepared = c.prepared[0]!;
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
        } else {
          const followUp = c.enqueue("follow-up", "Only inspect the room.");
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
        }
        reply.release();
        await eventually(() => c.discarded.length === 1, "the prepared continuation to be retired");
        expect(c.discarded[0]).toEqual({ item: prepared, reason: "Superseded while preparing the automatic continuation." });
        await eventually(() => c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run.status === "INTERRUPTED", "retired run persistence");
        if (kind === "stop") {
          expect(c.turns).toHaveLength(0);
          expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("INTERRUPTED");
        } else {
          // A follow-up keeps the original monitoring entry until a subsequent
          // poll verifies the remaining work; the first child must be the user turn.
          await advanceUntil(ctx, () => c.finished.length === 1);
          expect(c.turns[0]?.roomAgentOperatorRequest).toBe("Only inspect the room.");
          expect(c.turns.every((turn) => turn.agentRunId !== prepared.turn.agentRunId)).toBe(true);
          for (const [index, turn] of c.turns.entries()) await recordChild(ctx, turn, `prepared-follow-up-child-${index}`);
        }
        await closeAndRecord(ctx, handle, `prepared-${kind}-supervisor`);
      } finally { reply.release(); }
    }
  };
}

function preparedCarryScenario(): Scenario {
  const c = fixtureDriver();
  return {
    name: "supervisor-prepared-continue-as-new", activities: c.activities,
    async run(ctx) {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [{ ...c.input, processedCount: 50 }]);
      const first = await pinned(ctx, handle);
      await advanceUntil(ctx, () => c.prepared.length > 0);
      const { history, input, next } = await continuation(ctx, first);
      expect(input.pending).toHaveLength(1);
      expect(input.pending[0]).toEqual(c.prepared[0]);
      expect(input.monitoringMissionIds).toEqual([c.initial.mission.id]);
      expect(input.processedCount).toBe(0);
      expect(history.events?.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
      await eventually(() => c.finished.length === 1, "the carried continuation to finish");
      expect(c.turns).toHaveLength(1);
      expect(c.turns[0]?.agentRunId).toBe(input.pending[0]?.turn.agentRunId);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      await ctx.record(first, "prepared-carry-first");
      await recordChild(ctx, c.turns[0]!, "prepared-carry-child");
      await closeAndRecord(ctx, next, "prepared-carry-next");
    }
  };
}

function carryBoundScenario(): Scenario {
  const entered = gate();
  const nextRun = gate();
  const checked: Array<{ item: RoomAgentSupervisorQueueItem; runId: string }> = [];
  const discarded: RoomAgentSupervisorQueueItem[] = [];
  return {
    name: "supervisor-carried-queue-bound",
    activities: {
      async checkRoomAgentSupervisorTurn(item: RoomAgentSupervisorQueueItem) {
        checked.push({ item, runId: Context.current().info.workflowExecution!.runId });
        if (checked.length === 1) await entered.promise;
        if (checked.length >= 7) {
          await nextRun.promise;
          return "PAUSED";
        }
        return "SKIP";
      },
      async discardRoomAgentSupervisorTurn({ item }: { item: RoomAgentSupervisorQueueItem }) { discarded.push(item); },
      async finishRoomAgentSupervisorTurn() { throw new Error("SKIP must not finish a mission"); }
    },
    async run(ctx) {
      const initial = queueItem(0);
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [roomAgentSupervisorInputSchema.parse({ roomId: initial.turn.roomId, pending: [initial], processedCount: 49 })]);
      const first = await pinned(ctx, handle);
      try {
        await eventually(() => checked.length === 1, "the initial check activity");
        for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem(index));
        entered.release();
        const { input, next } = await continuation(ctx, first);
        expect(input.pending).toHaveLength(100);
        expect(input.pending.map((item) => item.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, index) => queueItem(index + 6).turn.agentRunId));
        expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(input)))).not.toThrow();
        await eventually(() => checked.length === 7, "the first check in the next run");
        const firstRunId = checked[0]!.runId;
        expect(checked.filter((entry) => entry.runId === firstRunId)).toHaveLength(6);
        expect(discarded).toHaveLength(6);
        expect(new Set([...discarded, ...input.pending].map((item) => item.turn.agentRunId)).size).toBe(106);
        await ctx.record(first, "queue-bound-first");
        nextRun.release();
        await closeAndRecord(ctx, next, "queue-bound-next");
      } finally { entered.release(); nextRun.release(); }
    }
  };
}

function enqueueStopScenario(legacy: boolean): Scenario {
  const variant = legacy ? "legacy" : "current";
  const active = queueItem("active", undefined, "mission:active");
  const queued = queueItem("queued", undefined, "mission:queued");
  const tail = queueItem("tail", undefined, "mission:tail");
  const started: string[] = [];
  const turns: DummyTurnInput[] = [];
  const finished: Array<{ missionId: string; status: string; statusReason: string }> = [];
  let cancelled = false;
  const activities = {
    async checkRoomAgentSupervisorTurn(item: RoomAgentSupervisorQueueItem) { started.push(item.missionId); return "READY"; },
    async markRoomAgentMissionStarted(input: { missionId: string }) { started.push(input.missionId); },
    async discardRoomAgentSupervisorTurn() {},
    async finishRoomAgentSupervisorTurn(input: Finish) { finished.push({ missionId: input.item.missionId, status: input.status, statusReason: input.statusReason }); },
    async markRoomAgentMissionFinished(input: { missionId: string; status: string; statusReason: string }) { finished.push(input); },
    async runCodexAppServerTurn(turn: DummyTurnInput) {
      turns.push(turn);
      if (turn.agentRunId !== active.turn.agentRunId) return verified();
      const activity = Context.current();
      activity.heartbeat();
      const heartbeat = setInterval(() => activity.heartbeat(), 20);
      try { return await activity.cancelled; }
      finally { clearInterval(heartbeat); cancelled = true; }
    }
  };
  return {
    name: `supervisor-${legacy ? "legacy" : "current"}-enqueue-stop`, legacy, activities,
    async run(ctx) {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [roomAgentSupervisorInputSchema.parse({ roomId: active.turn.roomId, pending: [active] })]);
      await eventually(() => turns.length === 1, "the running child activity");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { invalid: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem("wrong-room", "room:other"));
      if (!legacy) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: queued.missionId, reason: "Cancel queued request." });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: active.missionId, reason: "Interrupt running request." });
      await eventually(() => cancelled && finished.length === 2, "active cancellation and queued stop persistence");
      expect(finished).toEqual(expect.arrayContaining([
        expect.objectContaining({ missionId: active.missionId, status: "INTERRUPTED", statusReason: "Interrupt running request." }),
        expect.objectContaining({ missionId: queued.missionId, status: "INTERRUPTED", statusReason: "Cancel queued request." })
      ]));
      expect(turns).toHaveLength(1);
      expect(started).toEqual([active.missionId]);
      const child = ctx.env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(active.turn));
      await eventually(async () => (await child.describe()).status.name === "CANCELLED", "the child workflow to acknowledge cancellation");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, tail);
      await eventually(() => finished.length === 3, "the supervisor to accept another request");
      expect(turns.map((turn) => turn.agentRunId)).toEqual([active.turn.agentRunId, tail.turn.agentRunId]);
      expect(finished[2]).toMatchObject({ missionId: tail.missionId, status: "COMPLETED" });
      await recordChild(ctx, active.turn, `${variant}-stopped-child`);
      await recordChild(ctx, tail.turn, `${variant}-post-stop-child`);
      await closeAndRecord(ctx, handle, `${variant}-enqueue-stop-supervisor`);
    }
  };
}

function fiftyItemCarryScenario(legacy: boolean): Scenario {
  const variant = legacy ? "legacy" : "current";
  const firstItem = queueItem("fifty-first");
  const nextItem = queueItem("fifty-next");
  const interrupted = ["first", "next"].map((suffix) => ({ item: queueItem(`interrupted-${suffix}`, undefined, `mission:interrupted-${suffix}`), reason: `Stopped ${suffix}.` }));
  const firstGate = gate();
  const turns: DummyTurnInput[] = [];
  const discarded: string[] = [];
  const finished: string[] = [];
  let monitored = 0;
  const activities = {
    async checkRoomAgentSupervisorTurn() { return "READY"; },
    async markRoomAgentMissionStarted() {},
    async markRoomAgentMissionContinued() {},
    async discardRoomAgentSupervisorTurn({ item }: { item: RoomAgentSupervisorQueueItem }) {
      discarded.push(item.turn.agentRunId!);
      if (discarded.length === 1) await firstGate.promise;
    },
    async finishRoomAgentSupervisorTurn(input: Finish) { finished.push(input.item.turn.agentRunId!); },
    async markRoomAgentMissionFinished(input: { missionId: string }) { finished.push(input.missionId); },
    async prepareRoomAgentBackgroundContinuation() { monitored++; return { state: "DONE" }; },
    async settleRoomAgentBackgroundMission() { monitored++; return true; },
    async runCodexAppServerTurn(turn: DummyTurnInput) {
      turns.push(turn);
      if (legacy && turns.length === 1) await firstGate.promise;
      return verified();
    }
  };
  return {
    name: `supervisor-${legacy ? "legacy" : "current"}-fifty-item-carry`, legacy, activities,
    async run(ctx) {
      const rawInput = roomAgentSupervisorInputSchema.parse({
        roomId: firstItem.turn.roomId, processedCount: 49,
        pending: legacy ? [firstItem, nextItem] : [nextItem],
        interrupted: legacy ? [] : interrupted, monitoringMissionIds: ["mission:monitor-carried"]
      });
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [rawInput]);
      const first = await pinned(ctx, handle);
      try {
        await eventually(() => legacy ? turns.length === 1 : discarded.length === 1, "the fiftieth item to start");
        firstGate.release();
        const { input, next } = await continuation(ctx, first);
        expect(input.processedCount).toBe(0);
        expect(input.pending).toEqual([nextItem]);
        expect(input.monitoringMissionIds).toEqual(["mission:monitor-carried"]);
        expect(input.interrupted).toEqual(legacy ? [] : [interrupted[1]]);
        await advanceUntil(ctx, () => monitored === 1);
        expect(turns.map((turn) => turn.agentRunId)).toEqual(legacy ? [firstItem.turn.agentRunId, nextItem.turn.agentRunId] : [nextItem.turn.agentRunId]);
        if (!legacy) {
          expect(discarded).toEqual(interrupted.map((entry) => entry.item.turn.agentRunId));
          expect(finished).toEqual([...interrupted.map((entry) => entry.item.turn.agentRunId), nextItem.turn.agentRunId]);
        }
        await ctx.record(first, `${variant}-fifty-item-first`);
        for (const [index, turn] of turns.entries()) await recordChild(ctx, turn, `${variant}-fifty-item-child-${index}`);
        await closeAndRecord(ctx, next, `${variant}-fifty-item-next`);
      } finally { firstGate.release(); }
    }
  };
}

function pollingCarryScenario(legacy: boolean): Scenario {
  const variant = legacy ? "legacy" : "current";
  const calls: string[] = [];
  let finish = false;
  let wrongContractCalls = 0;
  const poll = () => { calls.push(Context.current().info.workflowExecution!.runId); return finish; };
  const activities = {
    async settleRoomAgentBackgroundMission() {
      if (!legacy) wrongContractCalls++;
      return poll();
    },
    async prepareRoomAgentBackgroundContinuation() {
      if (legacy) wrongContractCalls++;
      return { state: poll() ? "DONE" : "WAITING" };
    }
  };
  return {
    name: `supervisor-${legacy ? "legacy" : "current"}-250-poll-carry`, legacy, activities,
    async run(ctx) {
      const handle = await ctx.start("roomAgentSupervisorWorkflow", [roomAgentSupervisorInputSchema.parse({
        roomId: "room:temporal-polls", processedCount: 7, monitoringMissionIds: ["mission:temporal-polls"]
      })]);
      const first = await pinned(ctx, handle);
      // Skip in batches: fetching an ever-growing history after each of 250
      // ticks adds avoidable RPC and protobuf decoding work to this proof.
      for (let index = 0; index < 4; index++) {
        if (continued(await first.fetchHistory())) break;
        await ctx.env.sleep("90 seconds");
      }
      const { history, input, next } = await continuation(ctx, first);
      const firstRunId = calls[0]!;
      expect(calls.filter((runId) => runId === firstRunId)).toHaveLength(250);
      expect(wrongContractCalls).toBe(0);
      oneSecondTimers(history, 250);
      expect(input.pending).toEqual([]);
      expect(input.interrupted).toEqual([]);
      expect(input.monitoringMissionIds).toEqual(["mission:temporal-polls"]);
      // The legacy poll rollover carried this counter; the patched path resets it.
      expect(input.processedCount).toBe(legacy ? 7 : 0);
      finish = true;
      const before = calls.length;
      await advanceUntil(ctx, () => calls.length > before);
      await ctx.env.sleep("2 seconds");
      expect(calls.length).toBe(before + 1);
      expect(wrongContractCalls).toBe(0);
      await ctx.record(first, `${variant}-poll-carry-first`);
      await closeAndRecord(ctx, next, `${variant}-poll-carry-next`);
    }
  };
}

export function supervisorScenarios(): Scenario[] {
  return [
    allocationScenario(), preparedRaceScenario("stop"), preparedRaceScenario("follow-up"),
    preparedCarryScenario(), carryBoundScenario(),
    ...[false, true].flatMap((legacy) => [enqueueStopScenario(legacy), fiftyItemCarryScenario(legacy), pollingCarryScenario(legacy)])
  ];
}
