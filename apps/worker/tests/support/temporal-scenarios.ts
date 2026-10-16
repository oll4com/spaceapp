import assert from "node:assert/strict";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  dummyTurnInputSchema, memoryConsolidationRunSchema, roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema, type DummyTurnInput, type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { continuationFixture } from "../room-continuation-fixture.js";
import {
  discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState
} from "../../src/room-background-continuation.js";
import {
  deferred, eventually, eventsOf, payload, scheduledActivities, TemporalHarness, untilCancelled,
  type Handlers, type RecordedExecution
} from "./temporal-harness.js";

export type Scenario = {
  name: string;
  record?: boolean;
  legacy?: boolean;
  run(harness: TemporalHarness, id: string): Promise<void>;
};

const done = { state: "DONE", runId: null, goalStatus: "COMPLETED" };
const waiting = { state: "WAITING", runId: null, goalStatus: "RUNNING" };
const verified = { status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic evidence verified." } as const;
const syntheticFailure = () => {
  const failure = ApplicationFailure.retryable("Synthetic transport failure", "SyntheticFailure");
  failure.stack = "ApplicationFailure: Synthetic transport failure";
  return failure;
};
const input = (suffix: string) => dummyTurnInputSchema.parse({
  roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Inspect the synthetic room.",
  agentRunId: `agent_run:${suffix}`, traceId: `trace:${suffix}`
});
const turnResult = (turn: DummyTurnInput) => ({
  workflowId: Context.current().info.workflowExecution!.workflowId,
  roomId: turn.roomId, paneId: turn.paneId, traceId: turn.traceId,
  status: "COMPLETED" as const, message: "Synthetic work completed.", roomAgentOutcome: verified
});
const item = (suffix: string, missionId = `mission:${suffix}`) => roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: input(suffix) });
const supervisorInput = (value: object) => roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", ...value });

function activityAttempts(history: Awaited<ReturnType<TemporalHarness["history"]>>) {
  return eventsOf(history, "activityTaskStartedEventAttributes").map(event => event.activityTaskStartedEventAttributes!.attempt);
}

const dotScenarios: Scenario[] = [
  {
    name: "dot-wake-during-activity",
    async run(h, id) {
      const started = deferred(); const release = deferred(); let calls = 0;
      h.use({ dotGoalStep: async () => {
        if (++calls > 1) return done;
        started.resolve(); await release.promise; return waiting;
      } });
      const handle = await h.start("dotGoalWorkflow", { goalId: "goal:wake" }, id);
      try {
        await started.promise;
        await handle.signal(DOT_GOAL_SIGNAL);
        release.resolve();
        assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
        const history = await h.history(handle);
        assert.equal(calls, 2);
        assert.equal(eventsOf(history, "timerFiredEventAttributes").length, 0, "A retained wake must avoid waiting 30 seconds");
        const signal = history.events!.findIndex(event => event.workflowExecutionSignaledEventAttributes);
        const reply = history.events!.findIndex(event => event.activityTaskCompletedEventAttributes);
        assert(signal >= 0 && signal < reply, "Wake must precede the first activity reply");
      } finally { release.resolve(); }
    }
  },
  {
    name: "dot-timeout-and-observe", record: true,
    async run(h, id) {
      let steps = 0; let observations = 0;
      h.use({
        dotGoalStep: () => ++steps === 1 ? waiting : steps === 2 ? { state: "RUNNING", runId: "run:synthetic", goalStatus: "RUNNING" } : done,
        dotGoalObserve: (goalId, runId) => {
          assert.equal(goalId, "goal:timeout"); assert.equal(runId, "run:synthetic"); observations++;
          return { run: "COMPLETED", goalStatus: "RUNNING" };
        }
      });
      const handle = await h.start("dotGoalWorkflow", { goalId: "goal:timeout" }, id);
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      const history = await h.history(handle);
      assert.deepEqual(eventsOf(history, "timerStartedEventAttributes").map(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds)), [30, 15]);
      assert.equal(eventsOf(history, "timerFiredEventAttributes").length, 2);
      assert.equal(observations, 1);
    }
  },
  {
    name: "dot-continues-unfinished", record: true,
    async run(h, id) {
      let steps = 0;
      h.use({ dotGoalStep: goalId => { assert.equal(goalId, "goal:continued"); return ++steps <= 300 ? waiting : done; } });
      const handle = await h.start("dotGoalWorkflow", { goalId: "goal:continued" }, id);
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      const continued = await h.continued(handle);
      assert.equal(scheduledActivities(continued.history).length, 300);
      assert.deepEqual(continued.input, { goalId: "goal:continued" });
      assert.equal(steps, 301);
      assert.equal(scheduledActivities(await continued.next.fetchHistory()).length, 1);
    }
  }
];

const turnScenarios: Scenario[] = [
  {
    name: "dummy-turn-retries", record: true,
    async run(h, id) {
      const attempts: number[] = [];
      h.use({
        recordDummyTurnStarted: () => { const attempt = Context.current().info.attempt; attempts.push(attempt); if (attempt === 1) throw syntheticFailure(); return { workflowId: id }; },
        recordDummyTurnCompleted: turnResult
      });
      const turn = input(id);
      const handle = await h.start("dummyTurnWorkflow", turn, id);
      assert.deepEqual(await handle.result(), { workflowId: id, roomId: turn.roomId, paneId: turn.paneId, traceId: turn.traceId,
        status: "COMPLETED", message: "Synthetic work completed.", roomAgentOutcome: verified });
      assert.deepEqual(attempts, [1, 2]);
      const history = await h.history(handle);
      assert.deepEqual(scheduledActivities(history).map(activity => activity.activityType!.name), ["recordDummyTurnStarted", "recordDummyTurnCompleted"]);
      assert.deepEqual(activityAttempts(history), [2, 1]);
    }
  },
  ...[undefined, "opencode", "cli:claude"].map((providerId): Scenario => ({
    name: `codex-turn-${providerId ?? "default"}`, record: providerId === undefined,
    async run(h, id) {
      const expectedActivity = providerId === "opencode" ? "runOpenCodeAgentTurn" : providerId === "cli:claude" ? "runCliAgentTurn" : "runCodexAppServerTurn";
      const attempts: number[] = [];
      h.use({ [expectedActivity]: (turn: DummyTurnInput) => {
        attempts.push(Context.current().info.attempt);
        if (providerId === undefined && attempts.length === 1) throw syntheticFailure();
        return turnResult(turn);
      } });
      const handle = await h.start("codexAppServerTurnWorkflow", { ...input(id), providerId }, id);
      assert.equal((await handle.result() as any).status, "COMPLETED");
      assert.deepEqual(attempts, providerId === undefined ? [1, 2] : [1]);
      assert.deepEqual(scheduledActivities(await h.history(handle)).map(activity => activity.activityType!.name), [expectedActivity]);
    }
  })),
  {
    name: "background-action-exhausts-retries", record: true,
    async run(h, id) {
      const failures: unknown[] = []; const attempts: number[] = [];
      h.use({
        runRoomAgentBackgroundAction: () => { attempts.push(Context.current().info.attempt); throw syntheticFailure(); },
        failRoomAgentBackgroundAction: failure => { failures.push(failure); }
      });
      const handle = await h.start("roomAgentActionWorkflow", { bridge: {
        roomId: "room:proof", missionId: "mission:proof", agentPaneId: "pane:proof", agentSessionId: "session:proof",
        selectedToolIds: ["room:inspect"], actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
      }, traceId: "trace:proof" }, `space-room-action:${id}`);
      await assert.rejects(handle.result(), error => {
        assert.equal((error as Error).name, "WorkflowFailedError");
        const failure = (error as any).cause?.cause;
        assert.equal(failure?.message, "Synthetic transport failure");
        assert.equal(failure?.type, "SyntheticFailure");
        return true;
      });
      assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
      assert.deepEqual(failures, [{ roomId: "room:proof", missionId: "mission:proof", actionId: id, cancelled: false }]);
      assert.deepEqual(scheduledActivities(await h.history(handle)).map(activity => activity.activityType!.name), ["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]);
    }
  }
];

function simpleSupervisor(legacy: boolean, finished: any[], extra: Handlers = {}): Handlers {
  return {
    runCodexAppServerTurn: turnResult,
    checkRoomAgentSupervisorTurn: () => "READY",
    discardRoomAgentSupervisorTurn: () => undefined,
    finishRoomAgentSupervisorTurn: value => { finished.push(value); },
    prepareRoomAgentBackgroundContinuation: () => ({ state: "DONE" }),
    markRoomAgentMissionStarted: () => undefined,
    markRoomAgentMissionFinished: value => { finished.push(value); },
    markRoomAgentMissionContinued: () => undefined,
    settleRoomAgentBackgroundMission: () => true,
    ...extra
  };
}

const supervisorScenarios: Scenario[] = [false, true].flatMap(legacy => {
  const branch = legacy ? "legacy" : "current";
  return [
    {
      name: `supervisor-${branch}-signals-interrupt`, legacy, record: true,
      async run(h, id) {
        const started = deferred(); const finished: any[] = []; let cancelled = false;
        const active = item(`${id}-active`); const queued = item(`${id}-queued`);
        h.use(simpleSupervisor(legacy, finished, {
          runCodexAppServerTurn: () => untilCancelled(() => started.resolve(), () => { cancelled = true; })
        }));
        const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({ pending: [active] }), id, legacy);
        await started.promise;
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop" });
        await eventually(() => cancelled && finished.length === 2, "active child and queued turn interrupted");
        const history = await h.waitHistory(handle, value => eventsOf(value, "childWorkflowExecutionCanceledEventAttributes").length === 1 &&
          scheduledActivities(value).filter(a => a.activityType!.name === (legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn")).length === 2, "cancellation committed");
        assert.equal(eventsOf(history, "childWorkflowExecutionStartedEventAttributes").length, 1);
        assert.deepEqual(finished.map(value => value.status), ["INTERRUPTED", "INTERRUPTED"]);
        assert.deepEqual(new Set(finished.map(value => legacy ? value.missionId : value.item.missionId)), new Set([active.missionId, queued.missionId]));
        assert(finished.every(value => value.statusReason === "Synthetic stop"));
      }
    },
    {
      name: `supervisor-${branch}-50-items`, legacy,
      async run(h, id) {
        const finished: any[] = []; const first = item(`${id}-first`); const second = item(`${id}-second`);
        h.use(simpleSupervisor(legacy, finished));
        const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({
          pending: [first, second], monitoringMissionIds: ["mission:monitor"], processedCount: 49
        }), id, legacy);
        const continued = await h.continued(handle);
        assert.deepEqual(continued.input.pending, [second]);
        assert.deepEqual(continued.input.monitoringMissionIds, ["mission:monitor"]);
        assert.equal(continued.input.processedCount, 0);
        assert.equal(eventsOf(continued.history, "childWorkflowExecutionStartedEventAttributes").length, 1);
        await eventually(() => finished.length === 2, "carried turn completed in next run");
        const nextHistory = await continued.next.fetchHistory();
        assert.equal(eventsOf(nextHistory, "childWorkflowExecutionStartedEventAttributes").length, 1);
        assert.deepEqual(finished.map(value => legacy ? value.missionId : value.item.missionId), [first.missionId, second.missionId]);
      }
    },
    {
      name: `supervisor-${branch}-250-polls`, legacy, record: true,
      async run(h, id) {
        const finished: any[] = []; let polls = 0; const nextPoll = deferred();
        const pollActivity = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
        h.use(simpleSupervisor(legacy, finished, { [pollActivity]: () => {
          polls++;
          if (polls === 251) nextPoll.resolve();
          return legacy ? polls > 250 : { state: polls > 250 ? "DONE" : "WAITING" };
        } }));
        const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({ monitoringMissionIds: ["mission:poll"], processedCount: 7 }), id, legacy);
        const continued = await h.continued(handle);
        assert.equal(scheduledActivities(continued.history).filter(activity => activity.activityType!.name === pollActivity).length, 250);
        assert.equal(eventsOf(continued.history, "timerFiredEventAttributes").length, 250);
        assert(eventsOf(continued.history, "timerStartedEventAttributes").every(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1));
        assert.deepEqual(continued.input.monitoringMissionIds, ["mission:poll"]);
        assert.equal(continued.input.processedCount, legacy ? 7 : 0);
        await h.env.sleep("2 seconds");
        await nextPoll.promise;
        assert.equal(polls, 251);
        assert.equal(scheduledActivities(await continued.next.fetchHistory()).filter(activity => activity.activityType!.name === pollActivity).length, 1);
        assert.equal(finished.length, 0);
      }
    }
  ];
});

function storeDriver() {
  const c = continuationFixture();
  const turns: DummyTurnInput[] = []; const finishes: any[] = []; const discarded: any[] = [];
  const handlers: Handlers = {
    prepareRoomAgentBackgroundContinuation: value => prepareBackgroundContinuation(value, c.store),
    checkRoomAgentSupervisorTurn: value => supervisorTurnState(value, c.store),
    discardRoomAgentSupervisorTurn: ({ item, reason }) => { discarded.push(item); return discardSupervisorTurn(item, reason, c.store); },
    finishRoomAgentSupervisorTurn: value => { finishes.push(value); return finishSupervisorTurn(value, c.store); },
    runCodexAppServerTurn: (turn: DummyTurnInput) => {
      turns.push(turn); c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" }); return turnResult(turn);
    }
  };
  const workflowInput = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { ...c, handlers, workflowInput, turns, finishes, discarded };
}

const continuationScenarios: Scenario[] = [
  {
    name: "supervisor-interrupted-state-carried",
    async run(h, id) {
      const first = { item: item(`${id}-first`), reason: "First stopped request" };
      const second = { item: item(`${id}-second`), reason: "Second stopped request" };
      const pending = item(`${id}-pending`); const finished: any[] = [];
      h.use(simpleSupervisor(false, finished));
      const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({
        interrupted: [first, second], pending: [pending], monitoringMissionIds: ["mission:carried-monitor"], processedCount: 49
      }), id);
      const continued = await h.continued(handle);
      assert.deepEqual(continued.input.interrupted, [second]);
      assert.deepEqual(continued.input.pending, [pending]);
      assert.deepEqual(continued.input.monitoringMissionIds, ["mission:carried-monitor"]);
      assert.equal(continued.input.processedCount, 0);
      await eventually(() => finished.length === 3, "next run consumes the interrupted and pending state");
      assert.deepEqual(finished.map(value => [value.item.missionId, value.status]), [
        [first.item.missionId, "INTERRUPTED"], [second.item.missionId, "INTERRUPTED"], [pending.missionId, "COMPLETED"]
      ]);
    }
  },
  {
    name: "supervisor-allocation-send-verification",
    async run(h, id) {
      const c = storeDriver();
      c.handlers.runCodexAppServerTurn = (turn: DummyTurnInput) => {
        c.turns.push(turn); c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
        if (c.turns.length === 1) {
          assert(turn.prompt.includes("Open CLI and Chat, then send a story"));
          c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
            evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
          return { ...turnResult(turn), roomAgentOutcome: { ...verified, pendingActionIds: ["action:send"] } };
        }
        return turnResult(turn);
      };
      h.use(c.handlers);
      const handle = await h.start("roomAgentSupervisorWorkflow", c.workflowInput, id);
      await h.env.sleep("3 seconds");
      await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "mission verified");
      assert.equal(c.turns.length, 2);
      assert.equal(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND").length, 1);
      assert.equal(c.finishes.length, 1);
      const history = await h.waitHistory(handle, value => eventsOf(value, "childWorkflowExecutionCompletedEventAttributes").length === 2, "both real children complete");
      assert.equal(eventsOf(history, "childWorkflowExecutionStartedEventAttributes").length, 2);
    }
  },
  ...["stop", "follow-up"].map((kind): Scenario => ({
    name: `supervisor-preparation-race-${kind}`,
    async run(h, id) {
      const c = storeDriver(); const prepared = deferred<RoomAgentSupervisorQueueItem>(); const release = deferred(); let first = true;
      c.handlers.prepareRoomAgentBackgroundContinuation = async value => {
        const result = await prepareBackgroundContinuation(value, c.store);
        if (first) { first = false; assert.equal(result.state, "READY"); if (result.state === "READY") prepared.resolve(result.item); await release.promise; }
        return result;
      };
      h.use(c.handlers);
      const handle = await h.start("roomAgentSupervisorWorkflow", c.workflowInput, id);
      try {
        const advancing = h.env.sleep("1 second");
        const stale = await prepared.promise;
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
        } else {
          const followUp = c.enqueue("follow-up", "Only inspect the room.");
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
        }
        release.resolve(); await advancing;
        await eventually(() => c.store.getRoomAgentTurn(c.initial.mission.id, stale.turn.agentRunId!)?.run.status === "INTERRUPTED", "prepared run retired");
        if (kind === "stop") assert.equal(c.turns.length, 0);
        else {
          await eventually(() => c.turns.length > 0, "operator follow-up executes");
          assert.equal(c.turns[0]!.roomAgentOperatorRequest, "Only inspect the room.");
        }
        const history = await h.history(handle);
        const signaled = history.events!.findIndex(event => event.workflowExecutionSignaledEventAttributes);
        const replied = history.events!.findIndex(event => event.activityTaskCompletedEventAttributes);
        assert(signaled >= 0 && signaled < replied, "Signal must be recorded before prepare replies");
      } finally { release.resolve(); }
    }
  })),
  {
    name: "supervisor-prepared-turn-carried-once", record: true,
    async run(h, id) {
      const c = storeDriver(); h.use(c.handlers);
      const handle = await h.start("roomAgentSupervisorWorkflow", { ...c.workflowInput, processedCount: 50 }, id);
      const continued = await h.continued(handle);
      assert.equal(continued.input.pending.length, 1);
      assert.equal(eventsOf(continued.history, "childWorkflowExecutionStartedEventAttributes").length, 0);
      await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "carried automatic turn completes");
      assert.equal(c.turns.length, 1);
      assert.equal(c.turns[0]!.agentRunId, continued.input.pending[0].turn.agentRunId);
      assert.equal(c.finishes.length, 1);
    }
  },
  {
    name: "supervisor-queue-carry-bound",
    async run(h, id) {
      const entered = deferred(); const release = deferred(); const resumed = deferred(); const finishResumed = deferred();
      let checks = 0; let originalRun: string | undefined;
      const checked: string[] = [];
      h.use(simpleSupervisor(false, [], { checkRoomAgentSupervisorTurn: async value => {
        const runId = Context.current().info.workflowExecution!.runId;
        originalRun ??= runId;
        if (runId !== originalRun) { resumed.resolve(); await finishResumed.promise; }
        checks++; checked.push(value.turn.agentRunId);
        if (checks === 1) { entered.resolve(); await release.promise; }
        return "SKIP";
      } }));
      const items = Array.from({ length: 106 }, (_, index) => item(`${id}-${index}`, "mission:carry-bound"));
      const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({ pending: [items[0]], processedCount: 49 }), id);
      try {
        await entered.promise;
        for (const queued of items.slice(1)) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
        release.resolve();
        const continued = await h.continued(handle);
        await resumed.promise;
        assert.equal(checks, 6);
        assert.deepEqual(checked, items.slice(0, 6).map(queued => queued.turn.agentRunId));
        assert.equal(continued.input.pending.length, 100);
        assert.deepEqual(continued.input.pending, items.slice(6));
        assert.doesNotThrow(() => roomAgentSupervisorInputSchema.parse(continued.input));
      } finally { release.resolve(); finishResumed.resolve(); }
    }
  },
  {
    name: "supervisor-legacy-boolean-settle", legacy: true,
    async run(h, id) {
      let settles = 0; let prepares = 0;
      h.use(simpleSupervisor(true, [], {
        settleRoomAgentBackgroundMission: () => { settles++; return true; },
        prepareRoomAgentBackgroundContinuation: () => { prepares++; return { state: "DONE" }; }
      }));
      const handle = await h.start("roomAgentSupervisorWorkflow", supervisorInput({ monitoringMissionIds: ["mission:legacy"] }), id, true);
      await h.env.sleep("2 seconds");
      await h.waitHistory(handle, history => eventsOf(history, "activityTaskCompletedEventAttributes").length === 1, "legacy boolean reply committed");
      assert.equal(settles, 1); assert.equal(prepares, 0);
    }
  }
];

const iso = "2026-01-01T00:00:00.000Z";
const sourceHash = "a".repeat(64);
const mutationResult = { status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: sourceHash, reason: null };
const snapshot = { status: "REFRESHED", generatedAt: iso, sourceHash, previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 1 };
function memoryRun(id: string) {
  return memoryConsolidationRunSchema.parse({
    id: `consolidation:${id}`, mode: "AUDIT", triggerKind: "SCHEDULED", status: "SUCCEEDED",
    workflowId: `memory-consolidation:${id}`, dedupeKey: `audit-${id}`, sourceHash, actorUserId: null,
    progressCompleted: 0, progressTotal: 0, findingCount: 0, appliedOperationCount: 0,
    skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null,
    aiVerified: false, aiEvidence: {}, statusReason: null, createdAt: iso, startedAt: iso, completedAt: iso, updatedAt: iso
  });
}

const memoryScenarios: Scenario[] = [
  {
    name: "memory-maintenance-survives-failures", record: true,
    async run(h, id) {
      const run = memoryRun(id); const all: number[] = []; const sessions: number[] = []; const repair: any[] = [];
      h.use({
        refreshMemoryGraphSnapshot: () => snapshot,
        refreshAllMonthsMemoryGraphSnapshot: () => { all.push(Context.current().info.attempt); throw syntheticFailure(); },
        reconcileStaleSpaceAgentSessions: () => { sessions.push(Context.current().info.attempt); throw syntheticFailure(); },
        createScheduledMemoryAudit: value => { assert.equal(value.sourceHash, sourceHash); assert.equal(value.scheduledAt, iso); return run; },
        prepareMemoryConsolidation: value => { assert.equal(value.runId, run.id); return { run, changeSetId: mutationResult.changeSetId }; },
        executePersistedMemoryChangeSet: value => { assert.equal(value.changeSetId, mutationResult.changeSetId); if (Context.current().info.attempt === 1) throw syntheticFailure(); return mutationResult; },
        finalizeMemoryRepair: value => { repair.push(value); return run; }
      });
      const handle = await h.start("memoryMaintenanceWorkflow", { scheduledAt: iso, traceId: "trace:memory" }, id);
      assert.deepEqual(await handle.result(), snapshot);
      assert.deepEqual(all, [1, 2, 3]); assert.deepEqual(sessions, [1, 2, 3]);
      assert.deepEqual(repair, [{ runId: run.id, changeSetId: mutationResult.changeSetId, mutationResult }]);
      const history = await h.history(handle);
      const child = eventsOf(history, "startChildWorkflowExecutionInitiatedEventAttributes")[0]!.startChildWorkflowExecutionInitiatedEventAttributes!;
      assert.equal(child.workflowType!.name, "memoryConsolidationWorkflow");
      assert.equal(child.taskQueue!.name, "space-memory-maintenance");
      assert.deepEqual(payload(child.input), { runId: run.id, traceId: "trace:memory" });
      assert.equal(eventsOf(history, "childWorkflowExecutionCompletedEventAttributes").length, 1);
    }
  },
  {
    name: "memory-consolidation-retries-preparation", record: true,
    async run(h, id) {
      const run = memoryRun(id); const attempts: number[] = [];
      h.use({ prepareMemoryConsolidation: () => {
        attempts.push(Context.current().info.attempt); if (attempts.length < 3) throw syntheticFailure();
        return { run, changeSetId: null };
      } });
      const handle = await h.start("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:memory" }, id);
      assert.deepEqual(await handle.result(), run);
      assert.deepEqual(attempts, [1, 2, 3]);
      assert.deepEqual(scheduledActivities(await h.history(handle)).map(activity => activity.activityType!.name), ["prepareMemoryConsolidation"]);
    }
  },
  {
    name: "memory-mutation-retries", record: true,
    async run(h, id) {
      const attempts: number[] = [];
      h.use({ executePersistedMemoryChangeSet: value => {
        assert.deepEqual(value, { changeSetId: mutationResult.changeSetId, traceId: "trace:mutation" });
        attempts.push(Context.current().info.attempt); if (attempts.length < 3) throw syntheticFailure(); return mutationResult;
      } });
      const handle = await h.start("memoryMutationWorkflow", { changeSetId: mutationResult.changeSetId, traceId: "trace:mutation" }, id);
      assert.deepEqual(await handle.result(), mutationResult);
      assert.deepEqual(attempts, [1, 2, 3]);
      assert.deepEqual(activityAttempts(await h.history(handle)), [3]);
    }
  }
];

export const scenarios: Scenario[] = [...dotScenarios, ...turnScenarios, ...supervisorScenarios, ...continuationScenarios, ...memoryScenarios];

export async function runScenario(harness: TemporalHarness, scenario: Scenario): Promise<RecordedExecution[]> {
  try {
    await scenario.run(harness, `synthetic:${scenario.name}`);
  } catch (error) {
    await harness.cleanup();
    throw error;
  }
  return harness.cleanup();
}
