import { Context } from "@temporalio/activity";
import { ApplicationFailure, TimeoutFailure, TimeoutType, defaultPayloadConverter } from "@temporalio/common";
import { expect } from "vitest";
import {
  buildCodexAppServerTurnWorkflowId,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import {
  discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState
} from "../../src/room-background-continuation.js";
import { continuationFixture } from "../room-continuation-fixture.js";
import { deferred, historyEvents, type Scenario, type TraceContext } from "./harness.js";
import { syntheticQueueItem as item, syntheticSupervisorInput as input, syntheticVerifiedResult as verified } from "./synthetic-data.js";

const workflowType = "roomAgentSupervisorWorkflow";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function payloadValue(payload: any): any {
  return defaultPayloadConverter.fromPayload(payload);
}

function activityInputs(history: any, activityType: string): any[] {
  return historyEvents(history, "ActivityTaskScheduled")
    .map((event: any) => event.activityTaskScheduledEventAttributes)
    .filter((attrs: any) => attrs.activityType?.name === activityType)
    .map((attrs: any) => payloadValue(attrs.input.payloads[0]));
}

async function rollover(ctx: TraceContext, handle: any, label: string) {
  const pinned = ctx.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
  let history: any;
  await ctx.waitFor(async () => {
    history = await pinned.fetchHistory();
    return historyEvents(history, "WorkflowExecutionContinuedAsNew").length === 1;
  }, `${label}: first run continued as new`);
  history = await ctx.record(handle, label);
  const attrs = historyEvents(history, "WorkflowExecutionContinuedAsNew")[0]!.workflowExecutionContinuedAsNewEventAttributes!;
  return { history, carried: payloadValue(attrs.input!.payloads![0]), runId: attrs.newExecutionRunId! };
}

async function awaitProbe<T>(ctx: TraceContext, promise: Promise<T>, description: string): Promise<T> {
  let settled = false;
  let value!: T;
  let failure: unknown;
  promise.then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
  await ctx.waitFor(() => settled, description);
  if (failure !== undefined) throw failure;
  return value;
}

async function waitForTimer(ctx: TraceContext, handle: any) {
  await ctx.waitFor(async () => historyEvents(await handle.fetchHistory(), "TimerStarted").length > 0, "supervisor's first one-second timer");
}

function assertOneSecondTimers(history: any, expectedCount?: number) {
  const timers = historyEvents(history, "TimerStarted");
  if (expectedCount !== undefined) expect(timers).toHaveLength(expectedCount);
  expect(timers.length).toBeGreaterThan(0);
  for (const event of timers) {
    const duration = event.timerStartedEventAttributes!.startToFireTimeout!;
    expect(Number(duration.seconds ?? 0)).toBe(1);
    expect(Number(duration.nanos ?? 0)).toBe(0);
  }
}

function installContinuationActivities(ctx: TraceContext) {
  const fixture = continuationFixture();
  const prepared: RoomAgentSupervisorQueueItem[] = [];
  const finishes: any[] = [];
  ctx.activities.prepareRoomAgentBackgroundContinuation = async args => {
    const result = await prepareBackgroundContinuation(args, fixture.store);
    if (result.state === "READY") prepared.push(clone(result.item));
    return result;
  };
  ctx.activities.checkRoomAgentSupervisorTurn = async value => supervisorTurnState(value, fixture.store);
  ctx.activities.discardRoomAgentSupervisorTurn = async ({ item: value, reason, errorCode }) => discardSupervisorTurn(value, reason, fixture.store, errorCode);
  ctx.activities.finishRoomAgentSupervisorTurn = async value => {
    finishes.push(clone(value));
    return finishSupervisorTurn(value, fixture.store);
  };
  return { ...fixture, prepared, finishes };
}

function childFailureScenario(kind: "generic" | "timeout-cause" | "application", errorCode: string): Scenario {
  return {
    name: `current-supervisor-${kind}-child-failure-persists-failed-cause`, workflowType,
    async run(ctx) {
      const fixture = installContinuationActivities(ctx);
      ctx.activities.runCodexAppServerTurn = async () => {
        if (kind === "generic") throw Error("Synthetic child activity failed.");
        if (kind === "timeout-cause") {
          // Exercise a serialized Temporal timeout cause, not elapsed timeout
          // expiration. A direct activity TimeoutFailure would be flattened by
          // the SDK's ensureApplicationFailure conversion.
          throw ApplicationFailure.create({
            message: "Synthetic timeout propagation", type: "SyntheticTimeout", nonRetryable: true,
            cause: new TimeoutFailure("Synthetic heartbeat timeout", undefined, TimeoutType.HEARTBEAT)
          });
        }
        throw ApplicationFailure.nonRetryable("Synthetic typed child failure.", errorCode);
      };
      const handle = await ctx.start(workflowType, roomAgentSupervisorInputSchema.parse({
        roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id]
      }));
      await waitForTimer(ctx, handle);
      await ctx.env.sleep("1 second");
      await ctx.waitFor(() => ctx.trace.some(event => event.kind === "start" && event.name === "runCodexAppServerTurn"),
        "real continuation child activity started");
      expect(fixture.prepared).toHaveLength(1);
      const turn = fixture.prepared[0]!;
      const child = ctx.env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(turn.turn));
      const applicationFailure = kind === "timeout-cause"
        ? { type: "SyntheticTimeout", cause: { name: "TimeoutFailure", timeoutType: TimeoutType.HEARTBEAT } }
        : { type: kind === "generic" ? "Error" : errorCode };
      // Waiting on the finite child enables test-server time skipping through
      // generic activity retries while its long-lived supervisor remains open.
      await awaitProbe(ctx, expect(child.result()).rejects.toMatchObject({
        cause: { name: "ActivityFailure", cause: applicationFailure }
      }), "real child failed with its serialized cause");
      await ctx.waitFor(() => fixture.finishes.length === 1 &&
        fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "FAILED",
      "supervisor persisted the failed turn and mission");
      expect(fixture.store.getRoomAgentTurn(turn.missionId, turn.turn.agentRunId)?.run)
        .toMatchObject({ status: "FAILED", errorCode });
      expect(fixture.store.getRoomAgentMission(fixture.room.id, turn.missionId)?.status).toBe("FAILED");
      expect(fixture.finishes).toEqual([expect.objectContaining({ item: turn, status: "FAILED", errorCode })]);
      const history = await handle.fetchHistory();
      expect(historyEvents(history, "ChildWorkflowExecutionFailed")).toHaveLength(1);
      expect(activityInputs(history, "discardRoomAgentSupervisorTurn")).toEqual([{
        item: turn, reason: "Room Agent supervisor turn failed.", errorCode
      }]);
      expect(activityInputs(history, "finishRoomAgentSupervisorTurn")).toEqual([{
        item: turn, status: "FAILED", statusReason: "Room Agent supervisor turn failed.", errorCode
      }]);
    }
  };
}

function signalCancellationScenario(legacy: boolean): Scenario {
  return {
    name: `${legacy ? "legacy" : "current"}-supervisor-enqueue-stop-and-real-child-cancellation`, workflowType, legacy,
    async run(ctx) {
      const active = item("active", "mission:cancel");
      const queued = item("queued", "mission:cancel");
      const survivor = item("survivor", "mission:survivor");
      const entered = deferred<void>();
      const cancellationObserved = deferred<void>();
      const executed: string[] = [];
      const finishes: any[] = [];
      const discards: any[] = [];
      ctx.activities.checkRoomAgentSupervisorTurn = async () => "READY";
      ctx.activities.markRoomAgentMissionStarted = async () => undefined;
      ctx.activities.markRoomAgentMissionContinued = async () => undefined;
      ctx.activities.markRoomAgentMissionFinished = async value => { finishes.push(clone(value)); };
      ctx.activities.finishRoomAgentSupervisorTurn = async value => { finishes.push(clone(value)); };
      ctx.activities.discardRoomAgentSupervisorTurn = async value => { discards.push(clone(value)); };
      ctx.activities.runCodexAppServerTurn = async turn => {
        executed.push(turn.agentRunId);
        if (turn.agentRunId !== active.turn.agentRunId) return verified();
        const activity = Context.current();
        entered.resolve();
        const heartbeat = setInterval(() => activity.heartbeat("synthetic cancellation probe"), 20);
        try { return await activity.cancelled; }
        finally { clearInterval(heartbeat); cancellationObserved.resolve(); }
      };
      const handle = await ctx.start(workflowType, input({ pending: [active] }));
      await awaitProbe(ctx, entered.promise, "synthetic child activity started");
      // Current code suppresses an active-run duplicate. The legacy branch only
      // suppresses duplicates already in pending, so do not invent parity here.
      if (!legacy) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...item("wrong-room"), turn: { ...item("wrong-room").turn, roomId: "room:other" } });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { missionId: "invalid", turn: {} });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { reason: "" });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, survivor);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: active.missionId, reason: "Synthetic operator stop." });
      await awaitProbe(ctx, cancellationObserved.promise, "real child activity observed cancellation");
      await ctx.waitFor(() => finishes.length === 3, "active and queued turns interrupted; unrelated mission completed");
      expect(executed).toEqual([active.turn.agentRunId, survivor.turn.agentRunId]);
      expect(finishes.map(value => value.status)).toEqual(["INTERRUPTED", "INTERRUPTED", "COMPLETED"]);
      expect(finishes.slice(0, 2).map(value => value.statusReason)).toEqual(["Synthetic operator stop.", "Synthetic operator stop."]);
      if (!legacy) expect(discards.map(value => value.item.turn.agentRunId)).toEqual([active.turn.agentRunId, queued.turn.agentRunId]);
      const history = await ctx.record(handle, `${legacy ? "legacy" : "current"}-signal-cancellation`);
      expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(2);
      expect(historyEvents(history, "RequestCancelExternalWorkflowExecutionInitiated")).toHaveLength(1);
      expect(historyEvents(history, "ChildWorkflowExecutionCanceled")).toHaveLength(1);
      const child = ctx.env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(active.turn));
      const childHistory = await ctx.record(child, `${legacy ? "legacy" : "current"}-cancelled-child`);
      expect(historyEvents(childHistory, "WorkflowExecutionCancelRequested")).toHaveLength(1);
      expect(historyEvents(childHistory, "WorkflowExecutionCanceled")).toHaveLength(1);
    }
  };
}

const carryInterruptedAt50: Scenario = {
  name: "current-supervisor-fifty-processed-carries-exact-interrupted-pending-monitoring-state", workflowType,
  async run(ctx) {
    const stopped = [
      { item: item("discard-1"), reason: "Synthetic stop one." },
      { item: item("discard-2"), reason: "Synthetic stop two." }
    ];
    const pending = [item("carry-pending", "mission:pending")];
    ctx.activities.discardRoomAgentSupervisorTurn = async () => undefined;
    ctx.activities.finishRoomAgentSupervisorTurn = async () => undefined;
    ctx.activities.checkRoomAgentSupervisorTurn = async () => "SKIP";
    ctx.activities.prepareRoomAgentBackgroundContinuation = async () => ({ state: "DONE" });
    const handle = await ctx.start(workflowType, input({ pending, interrupted: stopped, monitoringMissionIds: ["mission:monitor"], processedCount: 49 }));
    const { history, carried } = await rollover(ctx, handle, "current-fifty-processed");
    expect(carried).toEqual(input({ pending, interrupted: [stopped[1]!], monitoringMissionIds: ["mission:monitor"], processedCount: 0 }));
    expect(activityInputs(history, "discardRoomAgentSupervisorTurn")).toEqual([stopped[0]]);
    expect(activityInputs(history, "finishRoomAgentSupervisorTurn")).toEqual([{ item: stopped[0]!.item, status: "INTERRUPTED", statusReason: stopped[0]!.reason }]);
    expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(0);
  }
};

const legacyCarryAt50: Scenario = {
  name: "legacy-supervisor-fifty-processed-carries-pending-and-monitoring", workflowType, legacy: true,
  async run(ctx) {
    const first = item("legacy-first");
    const second = item("legacy-second");
    ctx.activities.markRoomAgentMissionStarted = async () => undefined;
    ctx.activities.markRoomAgentMissionFinished = async () => undefined;
    ctx.activities.markRoomAgentMissionContinued = async () => undefined;
    ctx.activities.runCodexAppServerTurn = async () => verified();
    ctx.activities.settleRoomAgentBackgroundMission = async () => true;
    const handle = await ctx.start(workflowType, input({ pending: [first, second], monitoringMissionIds: ["mission:legacy-monitor"], processedCount: 49 }));
    const { history, carried } = await rollover(ctx, handle, "legacy-fifty-processed");
    expect(carried).toEqual(input({ pending: [second], monitoringMissionIds: ["mission:legacy-monitor"], processedCount: 0 }));
    expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(1);
    expect(activityInputs(history, "markRoomAgentMissionContinued")).toHaveLength(1);
    expect(activityInputs(history, "markRoomAgentMissionFinished")).toHaveLength(0);
  }
};

function pollingRolloverScenario(legacy: boolean): Scenario {
  return {
    name: `${legacy ? "legacy" : "current"}-supervisor-one-second-polling-and-250-poll-rollover`, workflowType, legacy,
    async run(ctx) {
      const done = "mission:poll-done";
      const waiting = "mission:poll-waiting";
      let wrongContractCalls = 0;
      ctx.activities.settleRoomAgentBackgroundMission = async value => {
        if (!legacy) wrongContractCalls++;
        return value.missionId === done;
      };
      ctx.activities.prepareRoomAgentBackgroundContinuation = async value => {
        if (legacy) wrongContractCalls++;
        return { state: value.missionId === done ? "DONE" : "WAITING" };
      };
      const handle = await ctx.start(workflowType, input({ monitoringMissionIds: [done, waiting], processedCount: 7 }));
      await waitForTimer(ctx, handle);
      await ctx.env.sleep("260 seconds");
      const { history, carried } = await rollover(ctx, handle, `${legacy ? "legacy" : "current"}-250-polls`);
      // The old polling rollover intentionally retains processedCount. The new
      // continuation contract resets it. These are not interchangeable traces.
      expect(carried).toEqual(input({ monitoringMissionIds: [waiting], processedCount: legacy ? 7 : 0 }));
      assertOneSecondTimers(history, 250);
      const activityType = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
      const calls = activityInputs(history, activityType);
      expect(calls.filter(value => value.missionId === done)).toHaveLength(1);
      expect(calls.filter(value => value.missionId === waiting)).toHaveLength(250);
      expect(wrongContractCalls).toBe(0);
      expect(activityInputs(history, legacy ? "prepareRoomAgentBackgroundContinuation" : "settleRoomAgentBackgroundMission")).toHaveLength(0);
      expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(0);
    }
  };
}

const allocationSendVerification: Scenario = {
  name: "current-supervisor-allocation-send-verification-stays-in-one-mission", workflowType,
  async run(ctx) {
    const fixture = installContinuationActivities(ctx);
    const executions: any[] = [];
    ctx.activities.runCodexAppServerTurn = async turn => {
      executions.push(clone(turn));
      expect(turn.roomAgentMissionId).toBe(fixture.initial.mission.id);
      expect(turn.roomAgentOperatorRequest).toBe("Open CLI and Chat, then send a story to both.");
      fixture.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (executions.length === 1) {
        expect(turn.prompt).toContain("Allocation or configuration can be an intermediate step");
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story to both.");
        fixture.store.createRoomAgentAction({ ...fixture.action, actionId: "action:trace-send", idempotencyKey: "trace-send-once", actionType: "SEND",
          evidence: { cli: "Synthetic story complete", chat: "Synthetic story complete" }, statusReason: "Both synthetic tasks completed." });
        return verified("Synthetic pane work queued.", ["action:trace-send"]);
      }
      return verified("Synthetic remaining request verified.");
    };
    const handle = await ctx.start(workflowType, roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id] }));
    await waitForTimer(ctx, handle);
    await ctx.env.sleep("3 seconds");
    await ctx.waitFor(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED", "allocation then send then verification persisted");
    expect(executions).toHaveLength(2);
    expect(executions.map(turn => turn.roomAgentContinuation.generation)).toEqual([1, 2]);
    expect(fixture.prepared).toHaveLength(2);
    expect(fixture.store.listRoomAgentActions(fixture.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
    expect(fixture.finishes).toHaveLength(1);
    const history = await ctx.record(handle, "allocation-send-verification");
    expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(2);
    expect(activityInputs(history, "prepareRoomAgentBackgroundContinuation")).toHaveLength(2);
    assertOneSecondTimers(history, 2);
  }
};

const carriedContinuationOnce: Scenario = {
  name: "current-supervisor-prepared-continuation-survives-rollover-exactly-once", workflowType,
  async run(ctx) {
    const fixture = installContinuationActivities(ctx);
    const executions: any[] = [];
    ctx.activities.runCodexAppServerTurn = async turn => {
      executions.push(clone(turn));
      fixture.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return verified();
    };
    const handle = await ctx.start(workflowType, roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id], processedCount: 50 }));
    await waitForTimer(ctx, handle);
    await ctx.env.sleep("2 seconds");
    const { history, carried, runId } = await rollover(ctx, handle, "prepared-continuation-before-rollover");
    expect(fixture.prepared).toHaveLength(1);
    expect(carried).toEqual(roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id, pending: fixture.prepared, monitoringMissionIds: [fixture.initial.mission.id] }));
    expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(0);
    await ctx.waitFor(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED", "carried continuation completed");
    expect(executions.map(turn => turn.agentRunId)).toEqual([fixture.prepared[0]!.turn.agentRunId]);
    expect(fixture.finishes).toHaveLength(1);
    const resumed = ctx.env.client.workflow.getHandle(handle.workflowId, runId);
    const resumedHistory = await ctx.record(resumed, "prepared-continuation-after-rollover");
    expect(historyEvents(resumedHistory, "StartChildWorkflowExecutionInitiated")).toHaveLength(1);
    expect(activityInputs(resumedHistory, "prepareRoomAgentBackgroundContinuation")).toHaveLength(0);
  }
};

function stalePreparationScenario(kind: "stop" | "follow-up"): Scenario {
  return {
    name: `current-supervisor-${kind}-retires-continuation-prepared-before-reply`, workflowType,
    async run(ctx) {
      const fixture = installContinuationActivities(ctx);
      const prepared = deferred<RoomAgentSupervisorQueueItem>();
      const releaseReply = deferred<void>();
      const prepare = ctx.activities.prepareRoomAgentBackgroundContinuation!;
      ctx.activities.prepareRoomAgentBackgroundContinuation = async value => {
        const result = await prepare(value);
        if (result.state === "READY") { prepared.resolve(result.item); await releaseReply.promise; }
        return result;
      };
      const executions: any[] = [];
      ctx.activities.runCodexAppServerTurn = async turn => {
        executions.push(clone(turn));
        fixture.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
        return verified();
      };
      const handle = await ctx.start(workflowType, roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id] }));
      await waitForTimer(ctx, handle);
      await ctx.env.sleep("1 second");
      const stale = await awaitProbe(ctx, prepared.promise, "automatic continuation prepared before reply");
      if (kind === "stop") {
        fixture.store.updateRoomAgentMission(fixture.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop during preparation." });
      } else {
        const followUp = fixture.enqueue("trace-follow-up", "Only inspect the synthetic room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      releaseReply.resolve();
      await ctx.waitFor(() => fixture.store.getRoomAgentTurn(fixture.initial.mission.id, stale.turn.agentRunId)?.run.status === "INTERRUPTED", "stale automatic run retired");
      if (kind === "stop") expect(executions).toHaveLength(0);
      else {
        await ctx.waitFor(() => executions.length === 1, "new operator follow-up started instead");
        expect(executions[0].roomAgentOperatorRequest).toBe("Only inspect the synthetic room.");
        expect(executions[0].roomAgentContinuation).toBeUndefined();
      }
      const history = await ctx.record(handle, `prepared-continuation-${kind}-race`);
      expect(activityInputs(history, "discardRoomAgentSupervisorTurn")).toContainEqual({ item: stale, reason: "Superseded while preparing the automatic continuation." });
      const children = historyEvents(history, "StartChildWorkflowExecutionInitiated");
      expect(children.some((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId === buildCodexAppServerTurnWorkflowId(stale.turn))).toBe(false);
    }
  };
}

const queue105Deferral: Scenario = {
  name: "current-supervisor-defers-rollover-until-105-signalled-items-fit-100-item-input", workflowType,
  async run(ctx) {
    const firstCheck = deferred<void>();
    const releaseFirst = deferred<void>();
    ctx.activities.checkRoomAgentSupervisorTurn = async value => {
      if (value.turn.agentRunId === item(0).turn.agentRunId) { firstCheck.resolve(); await releaseFirst.promise; }
      return "SKIP";
    };
    ctx.activities.discardRoomAgentSupervisorTurn = async () => undefined;
    const handle = await ctx.start(workflowType, input({ pending: [item(0)], processedCount: 49 }));
    await awaitProbe(ctx, firstCheck.promise, "first queue check is in flight");
    for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
    releaseFirst.resolve();
    const { history, carried } = await rollover(ctx, handle, "queue-105-defers-until-100");
    expect(carried).toEqual(input({ pending: Array.from({ length: 100 }, (_, index) => item(index + 6)) }));
    expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
    expect(activityInputs(history, "checkRoomAgentSupervisorTurn")).toEqual(Array.from({ length: 6 }, (_, index) => item(index)));
    expect(activityInputs(history, "discardRoomAgentSupervisorTurn")).toHaveLength(6);
    expect(historyEvents(history, "WorkflowExecutionSignaled")).toHaveLength(105);
    expect(historyEvents(history, "StartChildWorkflowExecutionInitiated")).toHaveLength(0);
  }
};

export const supervisorScenarios: Scenario[] = [
  childFailureScenario("generic", "ROOM_AGENT_SUPERVISOR_FAILED"),
  childFailureScenario("timeout-cause", "ROOM_AGENT_SUPERVISOR_TIMEOUT"),
  childFailureScenario("application", "CODEX_APP_SERVER_TURN_TIMEOUT"),
  signalCancellationScenario(false), signalCancellationScenario(true),
  carryInterruptedAt50, legacyCarryAt50,
  pollingRolloverScenario(false), pollingRolloverScenario(true),
  allocationSendVerification, carriedContinuationOnce,
  stalePreparationScenario("stop"), stalePreparationScenario("follow-up"), queue105Deferral
];
