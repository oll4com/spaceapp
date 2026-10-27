import { afterEach, beforeEach, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { CompleteAsyncError, Context } from "@temporalio/activity";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { Sandbox, deferred, until } from "./support/workflow-sandbox.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

const s = new Sandbox();
beforeEach(() => s.open(), 60_000);
afterEach(() => s.close(), 30_000);
const completed = { status: "COMPLETED", message: "Synthetic verified result", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verification complete."
} };
const events = (history: any, attribute: string) => history.events.filter((event: any) => event[attribute]);
const item = (index: number, missionId = "mission:probe") => ({ missionId, turn: {
  roomId: "room:probe", paneId: "pane:probe", prompt: `Synthetic request ${index}`, artifactIds: [],
  agentRunId: `agent_run:probe-${index}`, permissionMode: null, collaborationMode: "default", traceId: `trace:probe-${index}`
} });

it("dot goal uses its real timeout and records a replayable execution", async () => {
  let steps = 0;
  s.activities.dotGoalStep = async () => ++steps === 1
    ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
    : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  const handle = await s.start("dotGoalWorkflow", { goalId: "goal:timeout" });
  expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
  expect(events(await s.firstHistory(handle), "timerStartedEventAttributes")).toHaveLength(1);
  await s.record("dotGoalWorkflow", handle);
});

it("a wake signal during a dot activity is retained and avoids the timeout", async () => {
  const entered = deferred(), release = deferred();
  let steps = 0;
  s.activities.dotGoalStep = async () => {
    if (++steps === 1) { entered.resolve(); await release.promise; return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; }
    return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  };
  const handle = await s.start("dotGoalWorkflow", { goalId: "goal:wake" });
  await entered.promise;
  await handle.signal(DOT_GOAL_SIGNAL);
  release.resolve();
  expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
  expect(events(await s.firstHistory(handle), "timerStartedEventAttributes")).toHaveLength(0);
});

it("dot goal observes a running turn through real polling timers", async () => {
  let steps = 0, observations = 0;
  s.activities.dotGoalStep = async () => ++steps === 1
    ? { state: "RUNNING", runId: "run:synthetic", goalStatus: "ACTIVE" }
    : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  s.activities.dotGoalObserve = async () => ({ run: ++observations === 1 ? "RUNNING" : "COMPLETED", goalStatus: "ACTIVE" });
  const handle = await s.start("dotGoalWorkflow", { goalId: "goal:observe" });
  await handle.result();
  expect(observations).toBe(2);
  expect(events(await s.firstHistory(handle), "timerStartedEventAttributes")).toHaveLength(2);
});

it("an unfinished dot goal really continues as new after 300 iterations", async () => {
  let steps = 0;
  s.activities.dotGoalStep = async () => ++steps <= 300
    ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
    : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  const handle = await s.start("dotGoalWorkflow", { goalId: "goal:continue" });
  const next = await s.continued(handle);
  expect(next.input).toEqual({ goalId: "goal:continue" });
  expect(events(next.history, "activityTaskScheduledEventAttributes")).toHaveLength(300);
  expect(await next.next.result()).toEqual({ goalStatus: "COMPLETED" });
}, 30_000);

it("dummy turn retries an activity and returns the completed result", async () => {
  let attempts = 0;
  s.activities.recordDummyTurnStarted = async () => { if (++attempts === 1) throw Error("Transient synthetic failure"); };
  s.activities.recordDummyTurnCompleted = async () => completed;
  const handle = await s.start("dummyTurnWorkflow", item(1).turn);
  expect(await handle.result()).toEqual(completed);
  expect(attempts).toBe(2);
  expect(s.count("recordDummyTurnCompleted")).toBe(1);
  await s.record("dummyTurnWorkflow", handle);
});

it.each([
  ["codex", "runCodexAppServerTurn"], ["opencode", "runOpenCodeAgentTurn"], ["cli:claude", "runCliAgentTurn"]
] as const)("turn workflow dispatches provider %s in the real sandbox", async (providerId, activity) => {
  s.activities[activity] = async () => completed;
  const handle = await s.start("codexAppServerTurnWorkflow", { ...item(2).turn, providerId });
  expect(await handle.result()).toEqual(completed);
  expect(s.count(activity)).toBe(1);
  if (providerId === "codex") await s.record("codexAppServerTurnWorkflow", handle);
});

it("turn activity retries and eventually exhausts the production retry policy", async () => {
  s.activities.runCodexAppServerTurn = async () => { throw Error("Synthetic retryable failure"); };
  const handle = await s.start("codexAppServerTurnWorkflow", item(3).turn);
  await expect(handle.result()).rejects.toThrow();
  expect(s.count("runCodexAppServerTurn")).toBe(5);
});

it("action failure compensation runs after retry exhaustion, including legacy action IDs", async () => {
  s.activities.runRoomAgentBackgroundAction = async () => { throw Error("Synthetic transport failure"); };
  s.activities.failRoomAgentBackgroundAction = async () => undefined;
  const handle = await s.start("roomAgentActionWorkflow", {
    bridge: { roomId: "room:probe", missionId: "mission:probe" }, traceId: "trace:probe"
  }, "current", "space-room-action:action:legacy");
  await expect(handle.result()).rejects.toThrow();
  expect(s.count("runRoomAgentBackgroundAction")).toBe(5);
  expect(s.named("failRoomAgentBackgroundAction")[0]!.args[0]).toEqual({
    roomId: "room:probe", missionId: "mission:probe", actionId: "action:legacy", cancelled: false
  });
  await s.record("roomAgentActionWorkflow", handle);
});

it("memory mutation retries on the real server and returns its result", async () => {
  let attempts = 0;
  s.activities.executePersistedMemoryChangeSet = async input => {
    if (++attempts === 1) throw Error("Synthetic transient storage failure");
    return { status: "APPLIED", changeSetId: input.changeSetId };
  };
  const handle = await s.start("memoryMutationWorkflow", { changeSetId: "change:probe", traceId: "trace:probe" });
  expect(await handle.result()).toEqual({ status: "APPLIED", changeSetId: "change:probe" });
  expect(attempts).toBe(2);
  await s.record("memoryMutationWorkflow", handle);
});

it("memory mutation exhausts three activity attempts", async () => {
  s.activities.executePersistedMemoryChangeSet = async () => { throw Error("Synthetic persistent storage failure"); };
  const handle = await s.start("memoryMutationWorkflow", { changeSetId: "change:failure", traceId: "trace:probe" });
  await expect(handle.result()).rejects.toThrow();
  expect(s.count("executePersistedMemoryChangeSet")).toBe(3);
});

it("memory consolidation uses its mutation queue and finalizes the repair", async () => {
  s.activities.prepareMemoryConsolidation = async () => ({ changeSetId: "change:consolidate", run: { id: "audit:probe" } });
  s.activities.executePersistedMemoryChangeSet = async () => ({ status: "APPLIED" });
  s.activities.finalizeMemoryRepair = async input => ({ ...input, status: "COMPLETED" });
  const handle = await s.start("memoryConsolidationWorkflow", { runId: "audit:probe", traceId: "trace:probe" });
  expect(await handle.result()).toEqual({ runId: "audit:probe", changeSetId: "change:consolidate", mutationResult: { status: "APPLIED" }, status: "COMPLETED" });
  await s.record("memoryConsolidationWorkflow", handle);
});

it("memory consolidation returns early when there is no change set", async () => {
  s.activities.prepareMemoryConsolidation = async () => ({ changeSetId: null, run: { id: "audit:empty", status: "COMPLETED" } });
  const handle = await s.start("memoryConsolidationWorkflow", { runId: "audit:empty", traceId: "trace:probe" });
  expect(await handle.result()).toEqual({ id: "audit:empty", status: "COMPLETED" });
  expect(s.count("executePersistedMemoryChangeSet")).toBe(0);
});

it.each([false, true])("memory maintenance runs its real consolidation child despite optional failures=%s", async degraded => {
  const snapshot = { sourceHash: "synthetic-source", changed: true };
  s.activities.refreshMemoryGraphSnapshot = async () => snapshot;
  s.activities.refreshAllMonthsMemoryGraphSnapshot = async () => { if (degraded) throw Error("Synthetic all-months failure"); };
  s.activities.reconcileStaleSpaceAgentSessions = async () => { if (degraded) throw Error("Synthetic reconciliation failure"); };
  s.activities.createScheduledMemoryAudit = async input => { expect(input.sourceHash).toBe(snapshot.sourceHash); return { id: "audit:maintenance", workflowId: `synthetic-consolidation-${degraded}` }; };
  s.activities.prepareMemoryConsolidation = async () => ({ changeSetId: null, run: { id: "audit:maintenance", status: "COMPLETED" } });
  const handle = await s.start("memoryMaintenanceWorkflow", { traceId: "trace:probe" });
  expect(await handle.result()).toEqual(snapshot);
  expect(s.count("refreshAllMonthsMemoryGraphSnapshot")).toBe(degraded ? 3 : 1);
  expect(s.count("reconcileStaleSpaceAgentSessions")).toBe(degraded ? 3 : 1);
  expect(s.count("prepareMemoryConsolidation")).toBe(1);
  expect(events(await s.firstHistory(handle), "childWorkflowExecutionCompletedEventAttributes")).toHaveLength(1);
  if (degraded) await s.record("memoryMaintenanceWorkflow", handle);
});

it.each(["current", "legacy"] as const)("supervisor %s carries monitoring state after 250 real timer/activity polls", async mode => {
  s.activities.prepareRoomAgentBackgroundContinuation = async () => ({ state: "WAITING" });
  s.activities.settleRoomAgentBackgroundMission = async () => false;
  const handle = await s.start("roomAgentSupervisorWorkflow", { roomId: "room:probe", monitoringMissionIds: ["mission:probe"], processedCount: 17 }, mode);
  const next = await s.continued(handle);
  expect(next.input.monitoringMissionIds).toEqual(["mission:probe"]);
  expect(next.input.pending).toEqual([]);
  expect(next.input.processedCount).toBe(mode === "legacy" ? 17 : 0);
  expect(events(next.history, "timerStartedEventAttributes")).toHaveLength(250);
  const activities = events(next.history, "activityTaskScheduledEventAttributes");
  expect(activities).toHaveLength(250);
  expect(activities.every((event: any) => event.activityTaskScheduledEventAttributes.activityType.name ===
    (mode === "legacy" ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation"))).toBe(true);
  if (mode === "legacy") expect(JSON.stringify(next.history)).not.toContain("room-background-continuation-v1");
  await s.record(mode === "legacy" ? "roomAgentSupervisorWorkflow-legacy" : "roomAgentSupervisorWorkflow", handle);
}, 30_000);

it.each(["current", "legacy"] as const)("supervisor %s carries pending work after the 50th processed item", async mode => {
  s.activities.checkRoomAgentSupervisorTurn = async () => "SKIP";
  s.activities.discardRoomAgentSupervisorTurn = async () => undefined;
  s.activities.markRoomAgentMissionStarted = async () => undefined;
  s.activities.markRoomAgentMissionFinished = async () => undefined;
  s.activities.markRoomAgentMissionContinued = async () => undefined;
  s.activities.runCodexAppServerTurn = async () => completed;
  const pending = [item(40), item(41)];
  const handle = await s.start("roomAgentSupervisorWorkflow", { roomId: "room:probe", pending, processedCount: 49 }, mode);
  const next = await s.continued(handle);
  expect(next.input.pending.map((entry: any) => entry.turn.agentRunId)).toEqual(["agent_run:probe-41"]);
  expect(next.input.processedCount).toBe(0);
  expect(() => roomAgentSupervisorInputSchema.parse(next.input)).not.toThrow();
});

it.each(["current", "legacy"] as const)("supervisor %s receives an enqueue signal and stops a running mission", async mode => {
  const entered = deferred();
  s.activities.checkRoomAgentSupervisorTurn = async () => "READY";
  s.activities.markRoomAgentMissionStarted = async () => undefined;
  s.activities.markRoomAgentMissionFinished = async () => undefined;
  s.activities.discardRoomAgentSupervisorTurn = async () => undefined;
  s.activities.finishRoomAgentSupervisorTurn = async () => undefined;
  s.activities.runCodexAppServerTurn = async () => {
    const context = Context.current();
    context.heartbeat(); entered.resolve();
    const heartbeat = setInterval(() => context.heartbeat(), 20);
    try { await context.cancelled; } finally { clearInterval(heartbeat); }
  };
  const handle = await s.start("roomAgentSupervisorWorkflow", { roomId: "room:probe" }, mode);
  await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(50));
  await entered.promise;
  await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:probe", reason: "Synthetic stop" });
  const finish = mode === "legacy" ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn";
  await until(() => s.count(finish) === 1, "cancelled mission finish");
  expect(s.named(finish)[0]!.args[0]).toMatchObject({ status: "INTERRUPTED", statusReason: "Synthetic stop" });
  expect(s.count("runCodexAppServerTurn")).toBe(1);
}, 20_000);

function continuationDriver() {
  const c = continuationFixture();
  s.activities.prepareRoomAgentBackgroundContinuation = input => prepareBackgroundContinuation(input, c.store);
  s.activities.checkRoomAgentSupervisorTurn = value => supervisorTurnState(value, c.store);
  s.activities.discardRoomAgentSupervisorTurn = ({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode);
  s.activities.finishRoomAgentSupervisorTurn = input => finishSupervisorTurn(input, c.store);
  s.activities.runCodexAppServerTurn = async turn => {
    c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
    return completed;
  };
  return { ...c, input: { roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] } };
}

it("real continuation allocates, sends and verifies once in one mission", async () => {
  const c = continuationDriver(); let turns = 0;
  s.activities.runCodexAppServerTurn = async turn => {
    if (++turns === 1) {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND", evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
    }
    c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
    return turns === 1 ? { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } } : completed;
  };
  await s.skipping(async () => {
    await s.start("roomAgentSupervisorWorkflow", c.input);
    await until(() => s.count("finishRoomAgentSupervisorTurn") === 1, "mission verification");
  });
  expect(turns).toBe(2);
  expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
});

it.each(["stop", "follow-up"])("a %s signal retires work prepared while the activity was running", async kind => {
  const c = continuationDriver(); const prepared = deferred(), release = deferred();
  let first = true;
  s.activities.prepareRoomAgentBackgroundContinuation = async input => {
    const result = await prepareBackgroundContinuation(input, c.store);
    if (first) { first = false; prepared.resolve(); await release.promise; }
    return result;
  };
  await s.skipping(async () => {
    const handle = await s.start("roomAgentSupervisorWorkflow", c.input);
    await prepared.promise;
    if (kind === "stop") {
      c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop" });
    } else {
      const followUp = c.enqueue("follow-up", "Only inspect the room.");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
    }
    release.resolve();
    await until(() => s.count("discardRoomAgentSupervisorTurn") >= 1, "prepared run discarded");
    if (kind === "follow-up") await until(() => s.count("runCodexAppServerTurn") >= 1, "follow-up started");
  });
  const discarded = s.named("discardRoomAgentSupervisorTurn")[0]!.args[0].item;
  expect(c.store.getRoomAgentTurn(c.initial.mission.id, discarded.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
  if (kind === "stop") expect(s.count("runCodexAppServerTurn")).toBe(0);
  else expect(s.named("runCodexAppServerTurn")[0]!.args[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
});

it("a prepared continuation survives the run boundary and executes once", async () => {
  const c = continuationDriver();
  const handle = await s.start("roomAgentSupervisorWorkflow", { ...c.input, processedCount: 50 });
  const next = await s.continued(handle);
  expect(next.input.pending).toHaveLength(1);
  expect(events(next.history, "startChildWorkflowExecutionInitiatedEventAttributes")).toHaveLength(0);
  await s.skipping(() => until(() => s.count("finishRoomAgentSupervisorTurn") === 1, "continued mission finish"));
  expect(s.count("runCodexAppServerTurn")).toBe(1);
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
});

it("a burst of 105 signals drains to 100 carried entries without losing work", async () => {
  const gate = deferred(), release = deferred(); let calls = 0;
  s.activities.checkRoomAgentSupervisorTurn = async () => { if (++calls === 1) { gate.resolve(); await release.promise; } return "SKIP"; };
  s.activities.discardRoomAgentSupervisorTurn = async () => undefined;
  const handle = await s.start("roomAgentSupervisorWorkflow", { roomId: "room:probe", pending: [item(1000)], processedCount: 49 });
  await gate.promise;
  for (let i = 1001; i <= 1105; i++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(i));
  release.resolve();
  const next = await s.continued(handle);
  expect(next.input.pending).toHaveLength(100);
  expect(() => roomAgentSupervisorInputSchema.parse(next.input)).not.toThrow();
  const firstChecks = events(next.history, "activityTaskScheduledEventAttributes").filter((event: any) => event.activityTaskScheduledEventAttributes.activityType.name === "checkRoomAgentSupervisorTurn");
  expect(firstChecks).toHaveLength(6);
  expect(next.input.pending.map((entry: any) => entry.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, i) => `agent_run:probe-${i + 1006}`));
}, 20_000);

it.each([
  ["plain", "ROOM_AGENT_SUPERVISOR_FAILED"], ["typed", "CODEX_APP_SERVER_TURN_TIMEOUT"]
])("a real child failure %s records FAILED and preserves its cause code", async (kind, code) => {
  const c = continuationDriver();
  s.activities.runCodexAppServerTurn = async () => {
    if (kind === "plain") throw Error("Synthetic child failure");
    throw ApplicationFailure.create({ message: "Synthetic typed child failure", type: code, nonRetryable: true });
  };
  await s.skipping(async () => {
    await s.start("roomAgentSupervisorWorkflow", c.input);
    await until(() => s.count("finishRoomAgentSupervisorTurn") === 1, "failed mission finish");
  });
  const finish = s.named("finishRoomAgentSupervisorTurn")[0]!.args[0];
  expect(finish).toMatchObject({ status: "FAILED", errorCode: code });
  expect(c.store.getRoomAgentTurn(c.initial.mission.id, finish.item.turn.agentRunId)?.run).toMatchObject({ status: "FAILED", errorCode: code });
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
});

it("a real child heartbeat timeout records FAILED with the timeout cause", async () => {
  const c = continuationDriver();
  // OpenCode has one production attempt. Leave that activity pending on the
  // server and advance past its heartbeat deadline to obtain a real timeout.
  s.activities.prepareRoomAgentBackgroundContinuation = async input => {
    const result = await prepareBackgroundContinuation(input, c.store);
    if (result.state === "READY") result.item.turn.providerId = "opencode";
    return result;
  };
  s.activities.runOpenCodeAgentTurn = async () => { throw new CompleteAsyncError(); };
  const handle = await s.start("roomAgentSupervisorWorkflow", c.input);
  await s.skipping(() => until(() => s.count("runOpenCodeAgentTurn") === 1, "heartbeat activity started"));
  await s.env.sleep(16_000);
  await s.skipping(() => until(() => s.count("finishRoomAgentSupervisorTurn") === 1, "timed out mission finish"));
  const finish = s.named("finishRoomAgentSupervisorTurn")[0]!.args[0];
  expect(finish).toMatchObject({ status: "FAILED", errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT" });
  expect(c.store.getRoomAgentTurn(c.initial.mission.id, finish.item.turn.agentRunId)?.run).toMatchObject({ status: "FAILED", errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT" });
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
  const childId = events(await s.firstHistory(handle), "startChildWorkflowExecutionInitiatedEventAttributes")[0].startChildWorkflowExecutionInitiatedEventAttributes.workflowId;
  const childHistory = await s.env.client.workflow.getHandle(childId).fetchHistory();
  expect(events(childHistory, "activityTaskTimedOutEventAttributes")).toHaveLength(1);
}, 30_000);

it("legacy replay contract settles with a boolean and does not prepare a continuation", async () => {
  s.activities.settleRoomAgentBackgroundMission = async () => true;
  await s.skipping(async () => {
    await s.start("roomAgentSupervisorWorkflow", { roomId: "room:legacy", monitoringMissionIds: ["mission:legacy"] }, "legacy");
    await until(() => s.count("settleRoomAgentBackgroundMission") === 1, "legacy settle");
  });
  expect(s.count("prepareRoomAgentBackgroundContinuation")).toBe(0);
});
