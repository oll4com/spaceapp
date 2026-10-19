import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema
} from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState
} from "../src/room-background-continuation.js";
import {
  TemporalHarness, deferred, eventAttributes, payloadValue, recordedHistories,
  recording, syntheticFailure, waitFor, type ActivityHandlers
} from "./support/temporal-harness.js";

const h = new TemporalHarness();
beforeAll(() => h.prepare(), 60_000);
beforeEach(() => h.start(), 30_000);
afterEach(() => h.close(), 15_000);

const completed = { status: "COMPLETED", message: "Synthetic result", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verification."
} };

function item(index: string | number, roomId = "room:synthetic") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId: `mission:${index}`, turn: {
    roomId, paneId: "pane:synthetic", prompt: "Synthetic test request", traceId: `trace:synthetic-${index}`,
    agentRunId: `agent_run:${index}`
  } });
}

const supervisorHandlers = (): ActivityHandlers => ({
  checkRoomAgentSupervisorTurn: () => "RUN", discardRoomAgentSupervisorTurn: () => undefined,
  finishRoomAgentSupervisorTurn: () => undefined, markRoomAgentMissionStarted: () => undefined,
  markRoomAgentMissionFinished: () => undefined, markRoomAgentMissionContinued: () => undefined,
  prepareRoomAgentBackgroundContinuation: () => ({ state: "WAITING" }),
  settleRoomAgentBackgroundMission: () => false, runCodexAppServerTurn: () => completed
});

async function continued(handle: Awaited<ReturnType<typeof h.startWorkflow>>) {
  const first = h.firstRun(handle);
  const description = await waitFor(() => first.describe(), value => value.status.name !== "RUNNING", "continue-as-new", 25_000).catch(error => {
    throw new Error(`${error.message}; activities in this test: ${h.calls.length}; last: ${h.calls.at(-1)?.name}`);
  });
  expect(description.status.name).toBe("CONTINUED_AS_NEW");
  const history = await first.fetchHistory();
  const attrs = eventAttributes(history, "workflowExecutionContinuedAsNewEventAttributes")[0];
  return { history, input: payloadValue(attrs.input), nextRunId: attrs.newExecutionRunId };
}

// Bound each manual skip. Awaiting result() on an intentionally idle supervisor
// can skip all the way to the test server's default execution timeout.
function drive(handle: Awaited<ReturnType<typeof h.startWorkflow>>) {
  let stopped = false;
  const running = (async () => {
    while (!stopped && (await handle.describe()).status.name === "RUNNING") {
      await h.env.sleep("1 second");
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  const stop = async () => { stopped = true; await running; };
  h.stopDrivers.push(stop);
  return stop;
}

it("dummy turn retries a failed activity and records a real complete history", async () => {
  h.reset({
    recordDummyTurnStarted: () => { if (Context.current().info.attempt === 1) throw syntheticFailure(); },
    recordDummyTurnCompleted: () => completed
  });
  const handle = await h.startWorkflow("dummyTurnWorkflow", item("dummy").turn);
  expect(await handle.result()).toEqual(completed);
  expect(h.calls.filter(c => c.name === "recordDummyTurnStarted").map(c => c.attempt)).toEqual([1, 2]);
  await h.record("dummy-turn", handle);
}, 15_000);

it.each([
  ["codex", "codex", "runCodexAppServerTurn", false],
  ["opencode", "opencode", "runOpenCodeAgentTurn", false],
  ["cli", "cli:claude", "runCliAgentTurn", false],
  ["native-chat", "codex", "runCodexAppServerTurn", true]
] as const)("executes the real %s turn and its production retry policy", async (name, providerId, activity, nativeChat) => {
  const retry = name === "codex";
  h.reset({ [activity]: () => {
    if (retry && Context.current().info.attempt === 1) throw syntheticFailure();
    return completed;
  } });
  const handle = await h.startWorkflow("codexAppServerTurnWorkflow", {
    ...item(name).turn, providerId,
    ...(nativeChat ? { agentSessionId: "agent_session:synthetic", agentAssistantMessageId: "message:synthetic" } : {})
  });
  expect(await handle.result()).toEqual(completed);
  expect(h.calls.map(c => c.name)).toEqual(retry ? [activity, activity] : [activity]);
  const scheduled = eventAttributes(await handle.fetchHistory(), "activityTaskScheduledEventAttributes")[0];
  expect(scheduled.activityType?.name).toBe(activity);
  // The test server may cap the native 100-year timeout to its workflow
  // execution limit; it must still exceed the room-agent 24-hour timeout.
  expect(Number(scheduled.startToCloseTimeout?.seconds) > 86_400).toBe(nativeChat);
  await h.record(`${name}-turn`, handle);
}, 15_000);

it.each(["wake", "timeout"])("dot goal resumes after %s with a real condition timer", async mode => {
  let steps = 0;
  h.reset({ dotGoalStep: () => ++steps === 1
    ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
    : { state: "DONE", runId: null, goalStatus: "COMPLETED" } });
  const handle = await h.startWorkflow("dotGoalWorkflow", { goalId: "goal:synthetic" });
  await waitFor(() => handle.fetchHistory(), value => eventAttributes(value, "timerStartedEventAttributes").length === 1, "goal timer");
  if (mode === "wake") await handle.signal(DOT_GOAL_SIGNAL);
  expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
  const history = await handle.fetchHistory();
  expect(eventAttributes(history, mode === "wake" ? "timerCanceledEventAttributes" : "timerFiredEventAttributes")).toHaveLength(1);
  expect(steps).toBe(2);
  await h.record(`dot-goal-${mode}`, handle);
}, 15_000);

it("dot goal carries its id to a new run when 300 iterations remain unfinished", async () => {
  let steps = 0;
  h.reset({ dotGoalStep: () => ++steps <= 300
    ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
    : { state: "DONE", runId: null, goalStatus: "COMPLETED" } });
  const handle = await h.startWorkflow("dotGoalWorkflow", { goalId: "goal:long-synthetic" });
  expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
  const carry = await continued(handle);
  expect(carry.input).toEqual({ goalId: "goal:long-synthetic" });
  expect(eventAttributes(carry.history, "timerFiredEventAttributes")).toHaveLength(300);
  expect(steps).toBe(301);
  await h.record("dot-goal-continue", h.firstRun(handle));
}, 30_000);

it("background action exhausts retries and persists the patched failure with the legacy action id", async () => {
  h.reset({ runRoomAgentBackgroundAction: () => { throw syntheticFailure(); }, failRoomAgentBackgroundAction: () => undefined });
  const handle = await h.startWorkflow("roomAgentActionWorkflow", {
    bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic"
  }, { workflowId: `space-room-action:action:synthetic-${randomUUID()}` });
  await expect(handle.result()).rejects.toThrow("Workflow execution failed");
  expect(h.calls.filter(c => c.name === "runRoomAgentBackgroundAction").map(c => c.attempt)).toEqual([1, 2, 3, 4, 5]);
  expect(h.calls.filter(c => c.name === "failRoomAgentBackgroundAction").map(c => c.args[0])).toEqual([{
    roomId: "room:synthetic", missionId: "mission:synthetic", actionId: handle.workflowId.replace(/^space-room-action:/, ""), cancelled: false
  }]);
  expect(eventAttributes(await handle.fetchHistory(), "markerRecordedEventAttributes")).not.toHaveLength(0);
  await h.record("room-action-failure", handle);
}, 15_000);

it("memory maintenance survives both optional failures and runs consolidation as a child", async () => {
  const result = { sourceHash: "synthetic-source-hash", nodeCount: 0, edgeCount: 0 };
  const run = { id: "consolidation:synthetic", status: "COMPLETED", workflowId: `synthetic-memory-child-${randomUUID()}` };
  h.reset({
    refreshMemoryGraphSnapshot: () => result,
    refreshAllMonthsMemoryGraphSnapshot: () => { throw syntheticFailure(); },
    reconcileStaleSpaceAgentSessions: () => { throw syntheticFailure(); },
    createScheduledMemoryAudit: () => run,
    prepareMemoryConsolidation: () => ({ changeSetId: null, run })
  });
  const handle = await h.startWorkflow("memoryMaintenanceWorkflow", { traceId: "trace:memory", month: "2025-01" });
  expect(await handle.result()).toEqual(result);
  for (const name of ["refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions"]) {
    expect(h.calls.filter(c => c.name === name).map(c => c.attempt)).toEqual([1, 2, 3]);
  }
  const children = eventAttributes(await handle.fetchHistory(), "startChildWorkflowExecutionInitiatedEventAttributes");
  expect(children).toHaveLength(1);
  expect(children[0].workflowType.name).toBe("memoryConsolidationWorkflow");
  expect(payloadValue(children[0].input)).toEqual({ runId: run.id, traceId: "trace:memory" });
  await h.record("memory-maintenance", handle);
}, 15_000);

it("memory consolidation retries a mutation on the dedicated queue then finalizes", async () => {
  const run = { id: "consolidation:synthetic-repair", status: "COMPLETED" };
  const mutationResult = { changeSetId: "change:synthetic", status: "APPLIED" };
  h.reset({
    prepareMemoryConsolidation: () => ({ changeSetId: mutationResult.changeSetId, run }),
    executePersistedMemoryChangeSet: () => {
      if (Context.current().info.attempt === 1) throw syntheticFailure();
      return mutationResult;
    },
    finalizeMemoryRepair: () => run
  });
  const handle = await h.startWorkflow("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:memory" });
  expect(await handle.result()).toEqual(run);
  expect(h.calls.filter(c => c.name === "executePersistedMemoryChangeSet").map(c => c.attempt)).toEqual([1, 2]);
  expect(h.calls.find(c => c.name === "finalizeMemoryRepair")?.args[0]).toEqual({ runId: run.id, changeSetId: mutationResult.changeSetId, mutationResult });
  await h.record("memory-consolidation", handle);
}, 15_000);

it("memory mutation retries twice before succeeding", async () => {
  const result = { changeSetId: "change:synthetic-retry", status: "APPLIED" };
  h.reset({ executePersistedMemoryChangeSet: () => {
    if (Context.current().info.attempt < 3) throw syntheticFailure();
    return result;
  } });
  const handle = await h.startWorkflow("memoryMutationWorkflow", { changeSetId: result.changeSetId, traceId: "trace:mutation" });
  expect(await handle.result()).toEqual(result);
  expect(h.calls.map(c => c.attempt)).toEqual([1, 2, 3]);
  await h.record("memory-mutation", handle);
}, 15_000);

it.each([false, true])("supervisor (legacy=%s) carries queued and monitored work after 50 processed items", async legacy => {
  h.reset(supervisorHandlers());
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: "room:synthetic", processedCount: 49, pending: [item("first"), item("carried")], monitoringMissionIds: ["mission:monitor"]
  });
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", input, { legacy });
  const carry = await continued(handle);
  expect(carry.input).toEqual({ ...input, processedCount: 0, pending: [item("carried")] });
  await waitFor(async () => h.calls, value => value.filter(c => c.name === "runCodexAppServerTurn").length === 2, "both queued children");
  expect(h.calls.filter(c => c.name === "runCodexAppServerTurn").map(c => c.args[0].agentRunId)).toEqual(["agent_run:first", "agent_run:carried"]);
  await h.record(`supervisor-${legacy ? "legacy" : "current"}-processed`, h.firstRun(handle));
}, 20_000);

it.each([false, true])("supervisor (legacy=%s) continues after 250 one-second polls without dropping monitoring", async legacy => {
  let polls = 0;
  h.reset({ ...supervisorHandlers(),
    prepareRoomAgentBackgroundContinuation: () => ({ state: ++polls <= 250 ? "WAITING" : "DONE" }),
    settleRoomAgentBackgroundMission: () => ++polls > 250
  });
  const input = roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", monitoringMissionIds: ["mission:monitor"] });
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", input, { legacy });
  const result = drive(handle);
  const carry = await continued(handle);
  expect(carry.input).toEqual(input);
  expect(eventAttributes(carry.history, "timerFiredEventAttributes")).toHaveLength(250);
  const calls = h.calls.filter(c => c.runId === handle.firstExecutionRunId);
  expect(calls).toHaveLength(250);
  expect(new Set(calls.map(c => c.name))).toEqual(new Set([legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation"]));
  await h.record(`supervisor-${legacy ? "legacy" : "current"}-polls`, h.firstRun(handle));
  await result();
  await handle.terminate("Synthetic poll proof finished");
}, 30_000);

it.each([false, true])("supervisor (legacy=%s) enqueues work and stops a running child", async legacy => {
  const entered = deferred();
  h.reset({ ...supervisorHandlers(), runCodexAppServerTurn: async turn => {
    if (turn.agentRunId !== "agent_run:active") return completed;
    entered.resolve();
    const context = Context.current();
    for (;;) { context.heartbeat(); await context.sleep(20); }
  } });
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [item("active")] }), { legacy });
  await entered.promise;
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("next"));
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("next"));
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("wrong", "room:wrong"));
  await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:active", reason: "Synthetic operator stop" });
  const finishName = legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn";
  await waitFor(async () => h.calls, value => value.some(c => c.name === finishName && c.args[0].status === "INTERRUPTED"), "interrupted mission");
  await waitFor(async () => h.calls, value => value.filter(c => c.name === "runCodexAppServerTurn").length === 2, "next queued mission");
  expect(h.calls.filter(c => c.name === "runCodexAppServerTurn").map(c => c.args[0].agentRunId)).toEqual(["agent_run:active", "agent_run:next"]);
  expect(h.calls.find(c => c.name === finishName && c.args[0].status === "INTERRUPTED")?.args[0].statusReason).toBe("Synthetic operator stop");
}, 15_000);

function continuationDriver() {
  const c = continuationFixture();
  h.reset({
    prepareRoomAgentBackgroundContinuation: input => prepareBackgroundContinuation(input, c.store),
    checkRoomAgentSupervisorTurn: turn => supervisorTurnState(turn, c.store),
    discardRoomAgentSupervisorTurn: ({ item: turn, reason }) => discardSupervisorTurn(turn, reason, c.store),
    finishRoomAgentSupervisorTurn: input => finishSupervisorTurn(input, c.store),
    runCodexAppServerTurn: turn => { c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" }); return completed; }
  });
  const input = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { ...c, workflowInput: input };
}

it("real supervisor completes allocation, send, and verification in one mission", async () => {
  const c = continuationDriver();
  let turns = 0;
  h.handlers.runCodexAppServerTurn = turn => {
    expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
    c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
    if (++turns > 1) return completed;
    c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
      evidence: { cli: "Synthetic story complete", chat: "Synthetic story complete" }, statusReason: "Both tasks completed." });
    return { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } };
  };
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", c.workflowInput);
  const result = drive(handle);
  await waitFor(async () => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, value => value === "COMPLETED", "mission completion");
  expect(turns).toBe(2);
  expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
  expect(h.calls.filter(call => call.name === "finishRoomAgentSupervisorTurn")).toHaveLength(1);
  await result();
  await handle.terminate("Synthetic continuation proof finished");
}, 15_000);

it.each(["stop", "follow-up"])("real supervisor retires prepared work when %s arrives during preparation", async kind => {
  const c = continuationDriver();
  let preparedRunId: string | undefined;
  const started = deferred<Awaited<ReturnType<typeof h.startWorkflow>>>();
  h.handlers.prepareRoomAgentBackgroundContinuation = async input => {
    const handle = await started.promise;
    const prepared = await prepareBackgroundContinuation(input, c.store);
    if (prepared.state === "READY" && !preparedRunId) {
      preparedRunId = prepared.item.turn.agentRunId;
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop" });
      } else {
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, c.enqueue("follow-up", "Only inspect the room.").queueItem);
      }
    }
    return prepared;
  };
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", c.workflowInput);
  started.resolve(handle);
  const result = drive(handle);
  await waitFor(async () => preparedRunId && c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status,
    value => value === "INTERRUPTED", "retired prepared run");
  if (kind === "stop") expect(h.calls.filter(call => call.name === "runCodexAppServerTurn")).toHaveLength(0);
  else {
    await waitFor(async () => h.calls, value => value.some(call => call.name === "runCodexAppServerTurn"), "follow-up turn");
    expect(h.calls.find(call => call.name === "runCodexAppServerTurn")?.args[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
  }
  await result();
  await handle.terminate("Synthetic preparation proof finished");
}, 15_000);

it("real supervisor carries a prepared continuation and executes it exactly once", async () => {
  const c = continuationDriver();
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", { ...c.workflowInput, processedCount: 50 });
  const result = drive(handle);
  const carry = await continued(handle);
  expect(roomAgentSupervisorInputSchema.parse(carry.input).pending).toHaveLength(1);
  expect(h.calls.filter(call => call.name === "runCodexAppServerTurn" && call.runId === handle.firstExecutionRunId)).toHaveLength(0);
  await waitFor(async () => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, value => value === "COMPLETED", "carried mission completion");
  expect(h.calls.filter(call => call.name === "runCodexAppServerTurn")).toHaveLength(1);
  await h.record("supervisor-prepared-continue", h.firstRun(handle));
  await result();
  await handle.terminate("Synthetic carry proof finished");
}, 15_000);

it("real supervisor drains an oversized signaled queue before continuing with 100 items", async () => {
  h.reset(supervisorHandlers());
  let flooded = false;
  const started = deferred<Awaited<ReturnType<typeof h.startWorkflow>>>();
  h.handlers.checkRoomAgentSupervisorTurn = async () => {
    const handle = await started.promise;
    if (!flooded) {
      flooded = true;
      for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
    }
    return "SKIP";
  };
  const handle = await h.startWorkflow("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
    roomId: "room:synthetic", pending: [item(0)], processedCount: 49
  }));
  started.resolve(handle);
  const carry = await continued(handle);
  const carried = roomAgentSupervisorInputSchema.parse(carry.input);
  expect(carried.pending).toHaveLength(100);
  expect(() => roomAgentSupervisorInputSchema.parse(carry.input)).not.toThrow();
  expect(h.calls.filter(call => call.name === "checkRoomAgentSupervisorTurn" && call.runId === handle.firstExecutionRunId)).toHaveLength(6);
  expect(carried.pending.map(entry => entry.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, n) => `agent_run:${n + 6}`));
  await h.record("supervisor-queue-bound", h.firstRun(handle));
}, 20_000);

it.skipIf(recording)("replays every committed history against the unmodified production workflows", async () => {
  const fixtures = await recordedHistories();
  expect(fixtures.map(f => f.name)).toEqual(expect.arrayContaining([
    "dummy-turn.json", "codex-turn.json", "dot-goal-wake.json", "dot-goal-timeout.json", "dot-goal-continue.json",
    "room-action-failure.json", "memory-maintenance.json", "memory-consolidation.json", "memory-mutation.json",
    "supervisor-current-processed.json", "supervisor-legacy-processed.json", "supervisor-current-polls.json", "supervisor-legacy-polls.json",
    "supervisor-prepared-continue.json", "supervisor-queue-bound.json"
  ]));
  const failures: string[] = [];
  let replayed = 0;
  for await (const replay of Worker.runReplayHistories({ workflowBundle: h.bundle }, fixtures)) {
    replayed++;
    if (replay.error) {
      const fixture = fixtures.find(f => f.workflowId === replay.workflowId)!;
      failures.push(`${fixture.name} (${replay.workflowId}): ${replay.error.name}: ${replay.error.message}`);
    }
  }
  expect(replayed).toBe(fixtures.length);
  expect(failures, "Recorded workflow compatibility must not be repaired by overwriting histories").toEqual([]);
}, 30_000);

it.skipIf(recording)("rejects an extra timer with DeterminismViolationError", async () => {
  const fixture = (await recordedHistories()).find(f => f.name === "dummy-turn.json")!;
  await expect(Worker.runReplayHistory({
    workflowsPath: fileURLToPath(new URL("./support/temporal-nondeterministic-workflows.ts", import.meta.url))
  }, fixture.history, fixture.workflowId)).rejects.toBeInstanceOf(DeterminismViolationError);
}, 15_000);
