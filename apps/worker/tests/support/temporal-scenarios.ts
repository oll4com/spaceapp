import assert from "node:assert/strict";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, DOT_GOAL_SIGNAL, roomAgentSupervisorInputSchema,
  memoryConsolidationRunSchema, memoryMaintenanceResultSchema } from "@space/contracts";
import { TemporalSandbox, deferred, failure, holdUntilCancelled, until, type StubActivities } from "./temporal-sandbox.js";
import { continuationFixture } from "../room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../../src/room-background-continuation.js";

export type Scenario = { name: string; run: (h: TemporalSandbox) => Promise<void> };
const completed = { status: "COMPLETED", message: "Synthetic completion." };
const verified = { ...completed, roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified synthetic request." } };
const waiting = { state: "WAITING", runId: null, goalStatus: "RUNNING" };
const done = { state: "DONE", runId: null, goalStatus: "COMPLETED" };
const input = (suffix = "one") => ({ roomId: "room:synthetic", paneId: "pane:synthetic", prompt: `Synthetic ${suffix}`,
  traceId: `trace:synthetic-${suffix}`, artifactIds: [], collaborationMode: "default", permissionMode: null });
const item = (n = 0) => ({ missionId: `mission:${n}`, turn: { ...input(String(n)), agentRunId: `agent_run:${n}` } });
const events = (history: any, attribute: string) => (history.events ?? []).filter((e: any) => e[attribute]);
const failureTypes = (error: any): string[] => error ? [error.type ?? error.name, ...failureTypes(error.cause)] : [];

const timestamp = "2026-01-01T00:00:00.000Z";
const run = memoryConsolidationRunSchema.parse({ id: "audit:synthetic", workflowId: "synthetic-memory-child", status: "SUCCEEDED",
  mode: "REPAIR", triggerKind: "SCHEDULED", dedupeKey: "synthetic-audit", sourceHash: null, actorUserId: null,
  progressCompleted: 1, progressTotal: 1, findingCount: 1, appliedOperationCount: 1, skippedOperationCount: 0,
  failedOperationCount: 0, metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
  createdAt: timestamp, startedAt: timestamp, completedAt: timestamp, updatedAt: timestamp });
const snapshot = memoryMaintenanceResultSchema.parse({ status: "REFRESHED", sourceHash: "a".repeat(64), previousSourceHash: null,
  generatedAt: timestamp, summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 }, durationMs: 0 });
const mutation = { status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: "b".repeat(64), reason: null };
function memoryActivities(): StubActivities {
  return {
    refreshMemoryGraphSnapshot: () => snapshot, refreshAllMonthsMemoryGraphSnapshot: () => snapshot,
    reconcileStaleSpaceAgentSessions: () => undefined, createScheduledMemoryAudit: () => run,
    prepareMemoryConsolidation: () => ({ changeSetId: "change:synthetic", run }),
    executePersistedMemoryChangeSet: () => mutation, finalizeMemoryRepair: () => run
  };
}

export const scenarios: Scenario[] = [
  { name: "dummy turn retries an activity in the real sandbox", async run(h) {
    h.reset({ recordDummyTurnStarted: () => { if (Context.current().info.attempt === 1) throw failure(); }, recordDummyTurnCompleted: () => completed });
    const handle = await h.start("dummyTurnWorkflow", input());
    assert.deepEqual(await handle.result(), completed);
    assert.deepEqual(h.calls.filter(c => c.name === "recordDummyTurnStarted").map(c => c.attempt), [1, 2]);
    const history = await h.save("dummy-turn-retry", handle);
    assert.equal(events(history, "workflowExecutionCompletedEventAttributes").length, 1);
  } },
  ...["room", "native", "opencode", "cli:claude"].map(provider => ({
    name: `codex turn dispatches ${provider} and obeys its retry policy`, async run(h: TemporalSandbox) {
      const activity = provider === "opencode" ? "runOpenCodeAgentTurn" : provider === "cli:claude" ? "runCliAgentTurn" : "runCodexAppServerTurn";
      const retries = provider === "room" || provider === "native";
      h.reset({ [activity]: () => { if (retries && Context.current().info.attempt === 1) throw failure(); return completed; } });
      const args = { ...input(provider), providerId: provider === "room" || provider === "native" ? null : provider,
        ...(provider === "native" ? { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" } : {}) };
      const handle = await h.start("codexAppServerTurnWorkflow", args);
      assert.deepEqual(await handle.result(), completed);
      assert.deepEqual(h.calls.map(c => [c.name, c.attempt]), retries ? [[activity, 1], [activity, 2]] : [[activity, 1]]);
      await h.save(`codex-turn-${provider.replace(":", "-")}`, handle);
    }
  })),
  { name: "turn exhaustion propagates an actual activity failure", async run(h) {
    h.reset({ recordDummyTurnStarted: () => { throw failure("TURN_EXHAUSTED"); } });
    const handle = await h.start("dummyTurnWorkflow", input("exhaustion"));
    await assert.rejects(handle.result(), error => failureTypes(error).includes("TURN_EXHAUSTED"));
    assert.deepEqual(h.calls.map(c => c.attempt), [1, 2, 3]);
  } },
  { name: "dot wake received during an activity survives until the next wait", async run(h) {
    const started = deferred(); const release = deferred(); let steps = 0;
    h.reset({ dotGoalStep: async () => { if (++steps === 1) { started.resolve(); await release.promise; return waiting; } return done; } });
    const handle = await h.start("dotGoalWorkflow", { goalId: "goal:wake" });
    await started.promise;
    await handle.signal(DOT_GOAL_SIGNAL); release.resolve();
    assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
    const history = await h.save("dot-goal-wake", handle);
    assert.equal(events(history, "workflowExecutionSignaledEventAttributes").length, 1);
    assert.equal(events(history, "timerStartedEventAttributes").length, 0);
  } },
  { name: "dot wake cancels an already started durable timer", async run(h) {
    let steps = 0;
    h.reset({ dotGoalStep: () => ++steps === 1 ? waiting : done });
    const handle = await h.start("dotGoalWorkflow", { goalId: "goal:timer-wake" });
    // Do not await result yet: time remains locked while we inspect and signal.
    await until(async () => events(await handle.fetchHistory(), "timerStartedEventAttributes").length === 1, "dot wait timer");
    await handle.signal(DOT_GOAL_SIGNAL);
    await handle.result();
    const history = await h.save("dot-goal-timer-wake", handle);
    assert.equal(events(history, "timerCanceledEventAttributes").length, 1);
    assert.equal(events(history, "timerFiredEventAttributes").length, 0);
  } },
  { name: "dot timeout and observation use real 30-second and 15-second timers", async run(h) {
    let steps = 0; let observations = 0;
    h.reset({ dotGoalStep: () => ++steps === 1 ? waiting : steps === 2 ? { ...waiting, state: "STARTED", runId: "run:synthetic" } : done,
      dotGoalObserve: () => ({ run: ++observations === 1 ? "RUNNING" : "COMPLETED", goalStatus: "RUNNING" }) });
    const handle = await h.start("dotGoalWorkflow", { goalId: "goal:timeout" });
    assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
    assert.equal(observations, 2);
    const history = await h.save("dot-goal-timeout", handle);
    assert.equal(events(history, "timerFiredEventAttributes").length, 3);
    assert.deepEqual(events(history, "timerStartedEventAttributes").map((e: any) => Number(e.timerStartedEventAttributes.startToFireTimeout.seconds)), [30, 15, 15]);
  } },
  { name: "unfinished dot goal continues as new with the original goal id", async run(h) {
    let steps = 0;
    h.reset({ dotGoalStep: () => ++steps <= 300 ? waiting : done });
    const handle = await h.start("dotGoalWorkflow", { goalId: "goal:continue" });
    assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
    assert.equal(steps, 301);
    assert(h.calls.every(c => c.args[0] === "goal:continue"));
    const history = await h.save("dot-goal-continue", handle);
    assert.equal(events(history, "workflowExecutionContinuedAsNewEventAttributes").length, 1);
  } },
  { name: "room action exhausts retries and persists the patched failure path", async run(h) {
    h.reset({ runRoomAgentBackgroundAction: () => { throw failure("ACTION_EXHAUSTED"); }, failRoomAgentBackgroundAction: () => undefined });
    const handle = await h.start("roomAgentActionWorkflow", { bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:action" });
    await assert.rejects(handle.result(), error => failureTypes(error).includes("ACTION_EXHAUSTED"));
    assert.deepEqual(h.calls.filter(c => c.name === "runRoomAgentBackgroundAction").map(c => c.attempt), [1, 2, 3, 4, 5]);
    assert.deepEqual(h.calls.find(c => c.name === "failRoomAgentBackgroundAction")!.args[0], {
      roomId: "room:synthetic", missionId: "mission:synthetic", actionId: handle.workflowId, cancelled: false
    });
    const history = await h.save("room-action-failure", handle);
    assert.equal(events(history, "markerRecordedEventAttributes").length, 1);
  } },
  { name: "memory maintenance tolerates both exhausted auxiliary failures and runs a real child", async run(h) {
    h.reset({ ...memoryActivities(), refreshAllMonthsMemoryGraphSnapshot: () => { throw failure("SNAPSHOT_UNAVAILABLE"); },
      reconcileStaleSpaceAgentSessions: () => { throw failure("SESSIONS_UNAVAILABLE"); } });
    const handle = await h.start("memoryMaintenanceWorkflow", { traceId: "trace:maintenance" });
    assert.deepEqual(await handle.result(), snapshot);
    for (const name of ["refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions"]) {
      assert.deepEqual(h.calls.filter(c => c.name === name).map(c => c.attempt), [1, 2, 3]);
    }
    assert(h.calls.some(c => c.name === "prepareMemoryConsolidation" && c.workflowId === run.workflowId));
    assert.deepEqual(h.calls.find(c => c.name === "createScheduledMemoryAudit")!.args[0], { traceId: "trace:maintenance", sourceHash: snapshot.sourceHash });
    const history = await h.save("memory-maintenance", handle);
    assert.equal(events(history, "childWorkflowExecutionCompletedEventAttributes").length, 1);
    const child = h.env.client.workflow.getHandle(run.workflowId);
    await h.save("memory-consolidation-child", child);
  } },
  { name: "memory consolidation retries mutation on its dedicated activity queue", async run(h) {
    h.reset({ ...memoryActivities(), executePersistedMemoryChangeSet: () => { if (Context.current().info.attempt < 3) throw failure(); return mutation; } });
    const handle = await h.start("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:consolidation" });
    assert.deepEqual(await handle.result(), run);
    assert.deepEqual(h.calls.filter(c => c.name === "executePersistedMemoryChangeSet").map(c => c.attempt), [1, 2, 3]);
    assert.deepEqual(h.calls.find(c => c.name === "finalizeMemoryRepair")!.args[0], { runId: run.id, changeSetId: mutation.changeSetId, mutationResult: mutation });
    const history = await h.save("memory-consolidation-retry", handle);
    const activity = events(history, "activityTaskScheduledEventAttributes").find((e: any) => e.activityTaskScheduledEventAttributes.activityType.name === "executePersistedMemoryChangeSet");
    assert.equal(activity.activityTaskScheduledEventAttributes.taskQueue.name, "space-memory-mutations");
  } },
  { name: "memory consolidation returns immediately without a change set", async run(h) {
    h.reset({ prepareMemoryConsolidation: () => ({ changeSetId: null, run }) });
    const handle = await h.start("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:no-change" });
    assert.deepEqual(await handle.result(), run);
    assert.deepEqual(h.calls.map(c => c.name), ["prepareMemoryConsolidation"]);
  } },
  { name: "memory mutation retries then returns its actual result", async run(h) {
    h.reset({ executePersistedMemoryChangeSet: () => { if (Context.current().info.attempt === 1) throw failure(); return mutation; } });
    const handle = await h.start("memoryMutationWorkflow", { changeSetId: mutation.changeSetId, traceId: "trace:mutation" });
    assert.deepEqual(await handle.result(), mutation);
    assert.deepEqual(h.calls.map(c => c.attempt), [1, 2]);
    await h.save("memory-mutation-retry", handle);
  } },
  { name: "memory mutation exhaustion is not mistaken for success", async run(h) {
    h.reset({ executePersistedMemoryChangeSet: () => { throw failure("MUTATION_EXHAUSTED"); } });
    const handle = await h.start("memoryMutationWorkflow", { changeSetId: mutation.changeSetId, traceId: "trace:mutation-failure" });
    await assert.rejects(handle.result(), error => failureTypes(error).includes("MUTATION_EXHAUSTED"));
    assert.deepEqual(h.calls.map(c => c.attempt), [1, 2, 3]);
  } }
];

scenarios.push({ name: "room action failure derives the legacy action id from the real workflow id", async run(h) {
  h.reset({ runRoomAgentBackgroundAction: () => { throw failure("ACTION_FAILED", true); }, failRoomAgentBackgroundAction: () => undefined });
  const handle = await h.start("roomAgentActionWorkflow", {
    bridge: { roomId: "room:proof", missionId: "mission:proof" }, traceId: "trace:proof"
  }, false, "space-room-action:action:legacy");
  await assert.rejects(handle.result(), error => failureTypes(error).includes("ACTION_FAILED"));
  assert.deepEqual(h.calls.find(c => c.name === "failRoomAgentBackgroundAction")!.args[0], {
    roomId: "room:proof", missionId: "mission:proof", actionId: "action:legacy", cancelled: false
  });
} });

function continuationDriver(h: TemporalSandbox) {
  const c = continuationFixture();
  const prepared: any[] = [];
  const finished = deferred();
  const activities: StubActivities = {
    prepareRoomAgentBackgroundContinuation: async args => {
      const result = await prepareBackgroundContinuation(args, c.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    },
    checkRoomAgentSupervisorTurn: args => supervisorTurnState(args, c.store),
    discardRoomAgentSupervisorTurn: ({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode),
    finishRoomAgentSupervisorTurn: async args => { await finishSupervisorTurn(args, c.store); finished.resolve(); },
    runCodexAppServerTurn: turn => { c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" }); return verified; }
  };
  h.reset(activities);
  return { ...c, activities, prepared, finished,
    workflowInput: roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }) };
}

scenarios.push(
  { name: "real supervisor executes allocation, send and verification exactly once", async run(h) {
    const c = continuationDriver(h); let turns = 0;
    c.activities.runCodexAppServerTurn = turn => {
      assert.match(turn.prompt, /Open CLI and Chat, then send a story/);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (++turns === 1) {
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return { ...verified, roomAgentOutcome: { ...verified.roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      return verified;
    };
    const handle = await h.start("roomAgentSupervisorWorkflow", c.workflowInput); h.runSupervisor(handle);
    await c.finished.promise;
    assert.equal(turns, 2);
    assert.equal(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND").length, 1);
    assert.equal(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, "COMPLETED");
    assert.equal(h.calls.filter(c => c.name === "finishRoomAgentSupervisorTurn").length, 1);
    await h.cleanup();
    const history = await h.save("supervisor-current-continuation", handle);
    assert.equal(events(history, "childWorkflowExecutionCompletedEventAttributes").length, 2);
    assert.equal(events(history, "timerFiredEventAttributes").length, 2);
  } },
  ...["plain", "timeout", "application"].map(kind => ({
    name: `supervisor preserves ${kind} child failure on both turn and mission`, async run(h: TemporalSandbox) {
      const c = continuationDriver(h);
      const code = kind === "plain" ? "ROOM_AGENT_SUPERVISOR_FAILED" : kind === "timeout" ? "ROOM_AGENT_SUPERVISOR_TIMEOUT" : "CODEX_APP_SERVER_TURN_TIMEOUT";
      c.activities.runCodexAppServerTurn = async () => {
        if (kind === "timeout") {
          // Fault injection at the activity boundary; Temporal serializes and
          // reconstructs the SDK timeout cause through the real child workflow.
          const timeout = new TimeoutFailure("Synthetic heartbeat timeout", undefined, TimeoutType.HEARTBEAT);
          timeout.stack = "TimeoutFailure: Synthetic heartbeat timeout";
          const error = ApplicationFailure.create({ message: "Synthetic child timeout", type: "SyntheticTimeout", nonRetryable: true, cause: timeout });
          error.stack = "ApplicationFailure: Synthetic child timeout";
          throw error;
        }
        if (kind === "application") throw failure(code, true);
        const error = Error("Synthetic child failure"); error.stack = "Error: Synthetic child failure";
        throw ApplicationFailure.fromError(error, { nonRetryable: true });
      };
      const handle = await h.start("roomAgentSupervisorWorkflow", c.workflowInput); h.runSupervisor(handle);
      await c.finished.promise;
      const prepared = c.prepared[0]; assert(prepared);
      assert.deepEqual(Object.fromEntries(Object.entries(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)!.run).filter(([key]) => ["status", "errorCode"].includes(key))), { status: "FAILED", errorCode: code });
      assert.equal(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, "FAILED");
      const finish = h.calls.find(c => c.name === "finishRoomAgentSupervisorTurn")!.args[0];
      assert.equal(finish.status, "FAILED"); assert.equal(finish.errorCode, code);
      await h.cleanup();
      await h.save(`supervisor-failure-${kind}`, handle);
    }
  })),
  ...["stop", "follow-up"].map(kind => ({
    name: `real ${kind} signal retires a prepared automatic run before its activity reply`, async run(h: TemporalSandbox) {
      const c = continuationDriver(h);
      const preparedReply = deferred(); const release = deferred();
      const original = c.activities.prepareRoomAgentBackgroundContinuation!;
      let first = true;
      c.activities.prepareRoomAgentBackgroundContinuation = async args => {
        const result = await original(args);
        if (first) { first = false; preparedReply.resolve(); await release.promise; }
        return result;
      };
      const handle = await h.start("roomAgentSupervisorWorkflow", c.workflowInput); h.runSupervisor(handle);
      await preparedReply.promise;
      const prepared = c.prepared[0]; assert(prepared);
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      release.resolve();
      await until(() => c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run.status === "INTERRUPTED", "prepared turn retirement");
      if (kind === "stop") assert.equal(h.calls.filter(c => c.name === "runCodexAppServerTurn").length, 0);
      else {
        await c.finished.promise;
        const child = h.calls.find(c => c.name === "runCodexAppServerTurn")!;
        assert.equal(child.args[0].roomAgentOperatorRequest, "Only inspect the room.");
      }
      await h.cleanup(); await h.save(`supervisor-signal-${kind}`, handle);
    }
  })),
  { name: "prepared continuation survives the 50-item continue-as-new boundary and starts once", async run(h) {
    const c = continuationDriver(h);
    const handle = await h.start("roomAgentSupervisorWorkflow", { ...c.workflowInput, processedCount: 50 }); h.runSupervisor(handle);
    await c.finished.promise;
    assert.equal(h.calls.filter(c => c.name === "runCodexAppServerTurn").length, 1);
    assert.equal(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status, "COMPLETED");
    const history = await h.save("supervisor-current-continue", handle);
    assert.equal(events(history, "startChildWorkflowExecutionInitiatedEventAttributes").length, 0);
    const continued = events(history, "workflowExecutionContinuedAsNewEventAttributes")[0]; assert(continued);
    const next = h.env.client.workflow.getHandle(handle.workflowId, continued.workflowExecutionContinuedAsNewEventAttributes.newExecutionRunId);
    const nextHistory = await next.fetchHistory();
    const payload = nextHistory.events![0].workflowExecutionStartedEventAttributes!.input!.payloads![0].data!;
    const carried = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(payload).toString()));
    assert.equal(carried.pending.length, 1); assert.equal(carried.processedCount, 0);
    assert.deepEqual(carried.pending[0], c.prepared[0]);
    await h.cleanup(); await h.save("supervisor-current-continued-run", next, continued.workflowExecutionContinuedAsNewEventAttributes.newExecutionRunId);
  } },
  { name: "supervisor drains excess signaled queue entries before carrying the schema-bound remainder", async run(h) {
    const flooded = deferred(); const release = deferred(); const resumed = deferred();
    let checks = 0; let parent: any;
    h.reset({ checkRoomAgentSupervisorTurn: async () => {
      checks++;
      if (checks === 1) { flooded.resolve(); await release.promise; }
      if (checks > 6) await holdUntilCancelled(resumed);
      return "SKIP";
    }, discardRoomAgentSupervisorTurn: () => undefined, finishRoomAgentSupervisorTurn: () => undefined });
    parent = await h.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", pending: [item(0)], processedCount: 49 }); h.runSupervisor(parent);
    await flooded.promise;
    for (let index = 1; index <= 105; index++) await parent.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
    release.resolve(); await resumed.promise;
    const history = await h.save("supervisor-queue-boundary", parent);
    const continued = events(history, "workflowExecutionContinuedAsNewEventAttributes")[0]; assert(continued);
    const carried = JSON.parse(Buffer.from(continued.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0].data).toString());
    assert.doesNotThrow(() => roomAgentSupervisorInputSchema.parse(carried));
    assert.equal(carried.pending.length, 100);
    assert.deepEqual(carried.pending.map((i: any) => i.turn.agentRunId), Array.from({ length: 100 }, (_, i) => `agent_run:${i + 6}`));
    assert.equal(h.calls.filter(c => c.name === "checkRoomAgentSupervisorTurn" && c.workflowId === parent.workflowId).length, 7);
    assert.equal(events(history, "activityTaskScheduledEventAttributes").filter((e: any) => e.activityTaskScheduledEventAttributes.activityType.name === "checkRoomAgentSupervisorTurn").length, 6);
  } }
);

for (const legacy of [false, true]) {
  const branch = legacy ? "legacy" : "current";
  scenarios.push(
    { name: `${branch} supervisor enqueues, cancels an active child and stops a pending mission`, async run(h) {
      const active = deferred(); const finished: any[] = [];
      h.reset({ checkRoomAgentSupervisorTurn: () => "READY", markRoomAgentMissionStarted: () => undefined,
        runCodexAppServerTurn: () => holdUntilCancelled(active), discardRoomAgentSupervisorTurn: () => undefined,
        finishRoomAgentSupervisorTurn: args => { finished.push(args); }, markRoomAgentMissionFinished: args => { finished.push(args); } });
      const handle = await h.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic" }, legacy); h.runSupervisor(handle);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { invalid: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...item(9), turn: { ...item(9).turn, roomId: "room:wrong" } });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(1)); await active.promise;
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(2));
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
      await until(() => finished.length === 2, "both missions interrupted");
      assert(finished.every(c => c.status === "INTERRUPTED" && c.statusReason === "Synthetic operator stop"));
      assert.equal(h.calls.filter(c => c.name === "runCodexAppServerTurn").length, 1);
      await h.cleanup();
      const history = await h.save(`supervisor-${branch}-signals`, handle);
      assert.equal(events(history, "childWorkflowExecutionCanceledEventAttributes").length, 1);
      assert.equal(events(history, "markerRecordedEventAttributes").length, legacy ? 0 : 1);
    } },
    { name: `${branch} supervisor carries queued and interrupted state after 50 processed items`, async run(h) {
      const first = deferred(); const release = deferred(); const second = deferred(); let starts = 0;
      h.reset({ checkRoomAgentSupervisorTurn: async () => { if (++starts === 1) { first.resolve(); await release.promise; } else await holdUntilCancelled(second); return "READY"; },
        markRoomAgentMissionStarted: async () => { if (++starts === 1) { first.resolve(); await release.promise; } else second.resolve(); },
        runCodexAppServerTurn: async () => { if (legacy && starts > 1) await holdUntilCancelled(second); return verified; },
        finishRoomAgentSupervisorTurn: () => undefined, markRoomAgentMissionFinished: () => undefined,
        discardRoomAgentSupervisorTurn: () => undefined });
      const handle = await h.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", pending: [item(1)], processedCount: 49 }, legacy); h.runSupervisor(handle);
      await first.promise;
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(2));
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(3));
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:3", reason: "Stop pending third" });
      release.resolve(); await second.promise;
      const history = await h.save(`supervisor-${branch}-50-items`, handle);
      const continued = events(history, "workflowExecutionContinuedAsNewEventAttributes")[0]; assert(continued);
      const carried = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(continued.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0].data).toString()));
      assert.equal(carried.pending.length, 1); assert.equal(carried.pending[0]!.missionId, "mission:2");
      assert.equal(carried.processedCount, 0);
      // The current implementation carries stopped items; the legacy implementation
      // historically clears them at this boundary. Replay freezes both.
      assert.equal(carried.interrupted.length, legacy ? 0 : 1);
    } },
    { name: `${branch} supervisor uses 1-second polls and carries monitoring state after 250 polls`, async run(h) {
      const nextRun = deferred(); let polls = 0;
      const poll = async () => { if (++polls === 251) await holdUntilCancelled(nextRun); return legacy ? false : { state: "WAITING" }; };
      h.reset({ prepareRoomAgentBackgroundContinuation: poll, settleRoomAgentBackgroundMission: poll });
      const handle = await h.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", monitoringMissionIds: ["mission:monitored"] }, legacy); h.runSupervisor(handle);
      await nextRun.promise;
      const history = await h.save(`supervisor-${branch}-250-polls`, handle);
      assert.equal(events(history, "timerFiredEventAttributes").length, 250);
      assert(events(history, "timerStartedEventAttributes").every((e: any) => Number(e.timerStartedEventAttributes.startToFireTimeout.seconds) === 1));
      const continued = events(history, "workflowExecutionContinuedAsNewEventAttributes")[0]; assert(continued);
      const carried = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(continued.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0].data).toString()));
      assert.deepEqual(carried.monitoringMissionIds, ["mission:monitored"]); assert.equal(carried.pending.length, 0);
      assert.equal(h.calls.filter(c => c.name === (legacy ? "prepareRoomAgentBackgroundContinuation" : "settleRoomAgentBackgroundMission")).length, 0);
    } },
    { name: `${branch} boolean/continuation polling settles without starting an unnecessary child`, async run(h) {
      const settled = deferred();
      h.reset({ settleRoomAgentBackgroundMission: () => { settled.resolve(); return true; },
        prepareRoomAgentBackgroundContinuation: () => { settled.resolve(); return { state: "DONE" }; } });
      const handle = await h.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", monitoringMissionIds: ["mission:monitored"] }, legacy); h.runSupervisor(handle);
      await settled.promise;
      await h.cleanup();
      const history = await h.save(`supervisor-${branch}-settled`, handle);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0]!.name, legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation");
      assert.equal(events(history, "startChildWorkflowExecutionInitiatedEventAttributes").length, 0);
    } }
  );
}

export async function runScenario(h: TemporalSandbox, scenario: Scenario) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await h.open();
    await Promise.race([
      scenario.run(h),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Scenario timed out: ${scenario.name}`)), 45_000); })
    ]);
  } catch (error) {
    // Diagnostics must neither replace the scenario failure nor delay teardown
    // indefinitely when the disposable server has stopped responding.
    await Promise.all(h.handles.map(async handle => {
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const history = await Promise.race([
          handle.fetchHistory(),
          new Promise<never>((_, reject) => {
            diagnosticTimer = setTimeout(() => reject(Error("Diagnostic history fetch timed out")), 1_000);
          })
        ]);
        console.error("Synthetic scenario diagnostic", scenario.name, JSON.stringify(history.events?.slice(-24)));
      } catch (diagnosticError) {
        console.error("Synthetic scenario diagnostic unavailable", scenario.name, handle.workflowId, diagnosticError);
      } finally { clearTimeout(diagnosticTimer); }
    }));
    throw error;
  } finally { clearTimeout(timer); await h.close(); }
}
