import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApplicationFailure, TimeoutFailure, TimeoutType, defaultPayloadConverter } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, MEMORY_MUTATION_TASK_QUEUE,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { deferred, histories, runInWorker, sandbox, saveHistory, workflowBundle } from "./support/temporal-sandbox.js";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowBundle } from "@temporalio/worker";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

const turn = (suffix = "initial", extra: Record<string, unknown> = {}) => ({
  roomId: "room:sandbox", paneId: "pane:sandbox", prompt: "Synthetic test request",
  artifactIds: [], agentRunId: `agent_run:${suffix}`, traceId: `trace:${suffix}`, ...extra
});
const item = (suffix = "initial", extra: Record<string, unknown> = {}) =>
  roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:sandbox", turn: turn(suffix, extra) });
const supervisor = (extra = {}) => roomAgentSupervisorInputSchema.parse({ roomId: "room:sandbox", ...extra });
const done = { status: "COMPLETED", message: "Verified synthetic result",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified." } };
const result = { status: "COMPLETED", message: "Synthetic result" };
const snapshot = { sourceHash: "synthetic-source", nodeCount: 1, edgeCount: 0 };
const run = { id: "repair:sandbox", workflowId: "repair-workflow:sandbox", status: "COMPLETED" };

describe("real Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  let bundle: WorkflowBundle;
  let legacy: WorkflowBundle;
  beforeAll(async () => { ({ env, bundle } = await sandbox()); legacy = await workflowBundle("legacy"); }, 90_000);
  afterAll(async () => { await env?.teardown(); }, 20_000);

  it("runs dummy turns and retries activity failures inside the real sandbox", async () => {
    const started = vi.fn().mockRejectedValueOnce(Error("transient")).mockResolvedValue(undefined);
    await runInWorker(env, bundle, { recordDummyTurnStarted: started, recordDummyTurnCompleted: () => result }, async taskQueue => {
      const handle = await env.client.workflow.start("dummyTurnWorkflow", { workflowId: "test-dummy", taskQueue, args: [turn()] });
      expect(await handle.result()).toEqual(result);
      expect(started).toHaveBeenCalledTimes(2);
      await saveHistory("dummyTurnWorkflow", handle);
    });
  }, 30_000);

  it.each([null, "opencode", "cli:claude"])("runs the real turn workflow with provider %s", async providerId => {
    const activity = vi.fn().mockRejectedValueOnce(Error("transient turn")).mockResolvedValue(result);
    // OpenCode and CLI intentionally have one attempt; the generic turn retries.
    if (providerId) activity.mockReset().mockResolvedValue(result);
    const codex = vi.fn((...args: any[]) => activity(...args));
    const openCode = vi.fn((...args: any[]) => activity(...args));
    const cli = vi.fn((...args: any[]) => activity(...args));
    await runInWorker(env, bundle, { runCodexAppServerTurn: codex, runOpenCodeAgentTurn: openCode, runCliAgentTurn: cli }, async taskQueue => {
      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        workflowId: `test-turn-${providerId ?? "default"}`, taskQueue, args: [turn("provider", { providerId })]
      });
      expect(await handle.result()).toEqual(result);
      expect(activity).toHaveBeenCalledTimes(providerId ? 1 : 2);
      expect(codex).toHaveBeenCalledTimes(providerId ? 0 : 2);
      expect(openCode).toHaveBeenCalledTimes(providerId === "opencode" ? 1 : 0);
      expect(cli).toHaveBeenCalledTimes(providerId === "cli:claude" ? 1 : 0);
      if (!providerId) await saveHistory("codexAppServerTurnWorkflow", handle);
    });
  }, 30_000);

  it("retains a goal wake signal arriving during an activity", async () => {
    const stepStarted = deferred(); const releaseStep = deferred(); let calls = 0;
    await runInWorker(env, bundle, { dotGoalStep: async () => {
      if (++calls === 1) { stepStarted.resolve(); await releaseStep.promise; return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; }
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    } }, async taskQueue => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", { workflowId: "test-goal-wake", taskQueue, args: [{ goalId: "goal:wake" }] });
      await stepStarted.promise; await handle.signal(DOT_GOAL_SIGNAL); releaseStep.resolve();
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await saveHistory("dotGoalWorkflow", handle);
      expect(history.events.some((event: any) => event.workflowExecutionSignaledEventAttributes)).toBe(true);
      expect(history.events.some((event: any) => event.timerFiredEventAttributes)).toBe(false);
    });
  }, 30_000);

  it("fires the goal timeout and continues an unfinished goal as a new run", async () => {
    let calls = 0;
    await runInWorker(env, bundle, { dotGoalStep: () => ++calls <= 300
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" } }, async taskQueue => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", { workflowId: "test-goal-continue", taskQueue, args: [{ goalId: "goal:continue" }] });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await saveHistory("dotGoalWorkflow-continue", first);
      expect(history.events.some((event: any) => event.timerFiredEventAttributes)).toBe(true);
      expect(history.events.some((event: any) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
      expect(calls).toBe(301);
    });
  }, 60_000);

  it("records exhausted background-action failure through the real patched path", async () => {
    const failed = vi.fn(); const action = vi.fn(() => { throw ApplicationFailure.nonRetryable("synthetic failure", "SYNTHETIC_ACTION_FAILURE"); });
    await runInWorker(env, bundle, { runRoomAgentBackgroundAction: action, failRoomAgentBackgroundAction: failed }, async taskQueue => {
      const handle = await env.client.workflow.start("roomAgentActionWorkflow", { workflowId: "space-room-action:action:legacy",
        taskQueue, args: [{ bridge: { roomId: "room:sandbox", missionId: "mission:sandbox" }, traceId: "trace:action" }] });
      await expect(handle.result()).rejects.toThrow();
      expect(failed).toHaveBeenCalledWith({ roomId: "room:sandbox", missionId: "mission:sandbox", actionId: "action:legacy", cancelled: false });
      await saveHistory("roomAgentActionWorkflow", handle);
    });
  }, 30_000);

  it("runs mutation retries and consolidation on their actual task queues", async () => {
    const mutation = vi.fn().mockRejectedValueOnce(Error("transient mutation")).mockResolvedValue({ status: "APPLIED" });
    const finalize = vi.fn(() => run);
    const activities = { executePersistedMemoryChangeSet: mutation, prepareMemoryConsolidation: () => ({ run, changeSetId: "change:sandbox" }), finalizeMemoryRepair: finalize };
    const mutationWorker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
      workflowBundle: bundle, taskQueue: MEMORY_MUTATION_TASK_QUEUE, activities });
    await mutationWorker.runUntil(() => runInWorker(env, bundle, activities, async taskQueue => {
      const handle = await env.client.workflow.start("memoryMutationWorkflow", { workflowId: "test-mutation", taskQueue,
        args: [{ changeSetId: "change:sandbox", traceId: "trace:mutation" }] });
      expect(await handle.result()).toEqual({ status: "APPLIED" });
      expect(mutation).toHaveBeenCalledTimes(2); await saveHistory("memoryMutationWorkflow", handle);
      const repair = await env.client.workflow.start("memoryConsolidationWorkflow", { workflowId: "test-repair", taskQueue,
        args: [{ runId: run.id, traceId: "trace:repair" }] });
      expect(await repair.result()).toEqual(run);
      expect(finalize).toHaveBeenCalledWith({ runId: run.id, changeSetId: "change:sandbox", mutationResult: { status: "APPLIED" } });
      await saveHistory("memoryConsolidationWorkflow", repair);
    }));
  }, 30_000);

  it("keeps maintenance alive after refresh/reconcile failures and executes a real consolidation child", async () => {
    const audit = vi.fn(() => run); const prepare = vi.fn(() => ({ run, changeSetId: null }));
    const activities = { refreshMemoryGraphSnapshot: () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot: () => { throw ApplicationFailure.nonRetryable("refresh failed", "SYNTHETIC_REFRESH"); },
      reconcileStaleSpaceAgentSessions: () => { throw ApplicationFailure.nonRetryable("reconcile failed", "SYNTHETIC_RECONCILE"); },
      createScheduledMemoryAudit: audit, prepareMemoryConsolidation: prepare };
    const childWorker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
      workflowBundle: bundle, taskQueue: "space-memory-maintenance", activities });
    await childWorker.runUntil(() => runInWorker(env, bundle, activities, async taskQueue => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", { workflowId: "test-maintenance", taskQueue,
        args: [{ traceId: "trace:maintenance" }] });
      expect(await handle.result()).toEqual(snapshot); expect(audit).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
      const history = await saveHistory("memoryMaintenanceWorkflow", handle);
      expect(history.events.some((event: any) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
    }));
  }, 30_000);

  async function withSupervisor(activeBundle: WorkflowBundle, input: ReturnType<typeof supervisor>,
    activities: Record<string, (...args: any[]) => any>, task: (handle: any) => Promise<void>, historyName?: string,
    testEnv = env) {
    await runInWorker(testEnv, activeBundle, activities, async taskQueue => {
      const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId: `supervisor-${taskQueue}`, taskQueue, args: [input]
      });
      try { await task(handle); }
      finally {
        await handle.terminate("Synthetic scenario complete");
        expect((await handle.describe()).status.name).toBe("TERMINATED");
      }
      if (historyName) await saveHistory(historyName,
        testEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
    });
  }

  const continuedInput = (history: any) => {
    const event = history.events.find((event: any) => event.workflowExecutionContinuedAsNewEventAttributes);
    expect(event, "Expected an actual continue-as-new history event").toBeDefined();
    return defaultPayloadConverter.fromPayload<any>(event.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0]);
  };

  it("executes allocation -> send -> verification as two real child workflows, finishing once", async () => {
    const c = continuationFixture();
    const reachedFinish = deferred(); const releaseFinish = deferred();
    const finished = vi.fn(async input => { await finishSupervisorTurn(input, c.store); reachedFinish.resolve(); await releaseFinish.promise; });
    let calls = 0;
    const child = vi.fn(async input => {
      if (++calls === 1) {
        expect(input.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      }
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return calls === 1 ? { ...done, roomAgentOutcome: { ...done.roomAgentOutcome, pendingActionIds: ["action:send"] } } : done;
    });
    await withSupervisor(bundle, roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }), {
      checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store), runCodexAppServerTurn: child,
      prepareRoomAgentBackgroundContinuation: input => prepareBackgroundContinuation(input, c.store),
      discardRoomAgentSupervisorTurn: input => discardSupervisorTurn(input.item, input.reason, c.store, input.errorCode),
      finishRoomAgentSupervisorTurn: finished
    }, async handle => {
      const clock = env.sleep("10 seconds");
      try {
        await reachedFinish.promise;
        expect(finished).toHaveBeenCalledOnce(); expect(child).toHaveBeenCalledTimes(2);
        expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
        expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
        const history = await handle.fetchHistory();
        expect(history.events.filter((event: any) => event.childWorkflowExecutionCompletedEventAttributes)).toHaveLength(2);
      } finally { releaseFinish.resolve(); await clock; }
    }, "roomAgentSupervisorWorkflow");
  }, 30_000);

  it.each(["stop", "follow-up"])("retires a prepared continuation if %s arrives during preparation", async kind => {
    const c = continuationFixture();
    const preparing = deferred(); const release = deferred();
    let automatic: any;
    const discarded = vi.fn(input => discardSupervisorTurn(input.item, input.reason, c.store, input.errorCode));
    const child = vi.fn(input => { c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" }); return done; });
    await withSupervisor(bundle, roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }), {
      prepareRoomAgentBackgroundContinuation: async input => { const prepared = await prepareBackgroundContinuation(input, c.store);
        expect(prepared.state).toBe("READY"); if (prepared.state === "READY") automatic = prepared.item;
        preparing.resolve(); await release.promise; return prepared; },
      discardRoomAgentSupervisorTurn: discarded, checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store),
      finishRoomAgentSupervisorTurn: input => finishSupervisorTurn(input, c.store), runCodexAppServerTurn: child
    }, async handle => {
      const timeAdvance = env.sleep("2 seconds"); await preparing.promise;
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, c.enqueue("follow-up", "Only inspect the room.").queueItem);
      release.resolve();
      await timeAdvance;
      await vi.waitFor(() => expect(discarded).toHaveBeenCalledWith({ item: automatic,
        reason: "Superseded while preparing the automatic continuation." }), { timeout: 5_000 });
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, automatic.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(child).not.toHaveBeenCalled();
      else { await vi.waitFor(() => expect(child).toHaveBeenCalledOnce()); expect(child.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room."); }
    });
  }, 30_000);

  it.each([false, true])("preserves carried state after50items and250polls (legacy=%s)", async isLegacy => {
    const activeBundle = isLegacy ? legacy : bundle;
    const check = vi.fn(() => "SKIP"); const settle = vi.fn(() => false); const prepare = vi.fn(() => ({ state: "WAITING" }));
    const acts = { checkRoomAgentSupervisorTurn: check, discardRoomAgentSupervisorTurn: () => undefined,
      markRoomAgentMissionStarted: () => undefined, markRoomAgentMissionFinished: () => undefined,
      markRoomAgentMissionContinued: () => undefined, runCodexAppServerTurn: () => done,
      settleRoomAgentBackgroundMission: settle, prepareRoomAgentBackgroundContinuation: prepare };
    await withSupervisor(activeBundle, supervisor({ pending: [item("processed")], processedCount: 49 }), acts, async handle => {
      await vi.waitFor(async () => {
        const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const next = continuedInput(await first.fetchHistory());
        expect(next.processedCount).toBe(0); expect(next.pending).toEqual([]);
        expect(next.monitoringMissionIds).toEqual([]);
      }, { timeout: 10_000 });
    }, isLegacy ? "roomAgentSupervisorWorkflow-prepatch" : "roomAgentSupervisorWorkflow-50items");
    const pollingEnv = await (await import("@temporalio/testing")).TestWorkflowEnvironment.createTimeSkipping();
    // Keep long polling proof isolated from prior terminated sticky executions:
    // the test server's virtual clock is global to its environment.
    try { await withSupervisor(activeBundle, supervisor({ monitoringMissionIds: ["mission:sandbox"] }), acts, async handle => {
      // Waiting on the first run's result unlocks automatic virtual time. The
      // real run closes by continue-as-new; do not follow the new idle run.
      await expect(pollingEnv.client.workflow.result(handle.workflowId, handle.firstExecutionRunId,
        { followRuns: false })).rejects.toThrow();
      await vi.waitFor(async () => {
        const first = pollingEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const next = continuedInput(await first.fetchHistory());
        expect(next.monitoringMissionIds).toEqual(["mission:sandbox"]);
        expect(next.pending).toEqual([]); expect(next.interrupted).toEqual([]);
      }, { timeout: 10_000 });
      const firstHistory = await pollingEnv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      const expectedActivity = isLegacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
      expect(firstHistory.events.filter((event: any) => event.activityTaskScheduledEventAttributes?.activityType?.name === expectedActivity)).toHaveLength(250);
      expect(isLegacy ? prepare : settle).not.toHaveBeenCalled();
    }, isLegacy ? "roomAgentSupervisorWorkflow-prepatch-polls" : "roomAgentSupervisorWorkflow-250polls", pollingEnv);
    } finally { await pollingEnv.teardown(); }
  }, 45_000);

  it("carries one prepared continuation through a new run and starts it only once", async () => {
    const prepared = item("carried", { roomAgentContinuation: { sourceRunId: "agent_run:initial", generation: 1 } });
    const child = vi.fn(() => done); const finished = vi.fn();
    const prepare = vi.fn().mockResolvedValueOnce({ state: "READY", item: prepared }).mockResolvedValue({ state: "DONE" });
    await withSupervisor(bundle, supervisor({ processedCount: 50, monitoringMissionIds: ["mission:sandbox"] }), {
      prepareRoomAgentBackgroundContinuation: prepare, checkRoomAgentSupervisorTurn: () => "RUN",
      runCodexAppServerTurn: child, finishRoomAgentSupervisorTurn: finished
    }, async handle => {
      await env.sleep("2 seconds"); await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce(), { timeout: 5_000 });
      const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const next = continuedInput(await first.fetchHistory());
      expect(next.pending).toEqual([prepared]); expect(child).toHaveBeenCalledOnce();
      expect(finished.mock.calls[0]![0].status).toBe("COMPLETED");
    }, "roomAgentSupervisorWorkflow-carried");
  }, 30_000);

  it.each([false, true])("receives enqueue and interrupts a real running child (legacy=%s)", async isLegacy => {
    const running = deferred(); const finished = vi.fn(); const cancelled = deferred();
    const child = async () => { const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), 50); running.resolve();
      try { await context.cancelled; }
      catch (error) { cancelled.resolve(); throw error; }
      finally { clearInterval(heartbeat); } };
    await withSupervisor(isLegacy ? legacy : bundle, supervisor(), {
      checkRoomAgentSupervisorTurn: () => "RUN", runCodexAppServerTurn: child,
      discardRoomAgentSupervisorTurn: () => undefined, finishRoomAgentSupervisorTurn: finished,
      markRoomAgentMissionStarted: () => undefined, markRoomAgentMissionFinished: finished
    }, async handle => {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item()); await running.promise;
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:sandbox", reason: "Operator stopped" });
      await cancelled.promise; await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: "INTERRUPTED", statusReason: "Operator stopped" })), { timeout: 5_000 });
    });
  }, 30_000);

  it.each([
    ["plain error", ApplicationFailure.fromError(Error("child failed"), { nonRetryable: true }), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["Temporal timeout", new ApplicationFailure("child failed", "Error", true, [], new TimeoutFailure("timed out", undefined, TimeoutType.HEARTBEAT)), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application failure", ApplicationFailure.nonRetryable("child failed", "CODEX_APP_SERVER_TURN_TIMEOUT"), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const)("records %s as failed rather than superseded", async (_, failure, errorCode) => {
    const c = continuationFixture(); const reachedFinish = deferred(); const releaseFinish = deferred();
    const failed = vi.fn(async input => { await finishSupervisorTurn(input, c.store); reachedFinish.resolve(); await releaseFinish.promise; });
    const discarded = vi.fn(input => discardSupervisorTurn(input.item, input.reason, c.store, input.errorCode));
    await withSupervisor(bundle, roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }), {
      checkRoomAgentSupervisorTurn: input => supervisorTurnState(input, c.store),
      prepareRoomAgentBackgroundContinuation: input => prepareBackgroundContinuation(input, c.store),
      runCodexAppServerTurn: () => { throw failure; },
      discardRoomAgentSupervisorTurn: discarded, finishRoomAgentSupervisorTurn: failed
    }, async handle => {
      const clock = env.sleep("10 seconds");
      try {
        await reachedFinish.promise;
        expect(failed).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode }));
        expect(discarded).toHaveBeenCalledWith(expect.objectContaining({ errorCode }));
        expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
        expect(c.store.getRoomAgentTurn(c.initial.mission.id)?.run).toMatchObject({ status: "FAILED", errorCode });
      } finally { releaseFinish.resolve(); await clock; }
    });
  }, 30_000);

  it("defers continue-as-new until a signalled queue fits the100item input bound", async () => {
    const checking = deferred(); const release = deferred(); let first = true;
    const check = vi.fn(async () => { if (first) { first = false; checking.resolve(); await release.promise; } return "SKIP"; });
    await withSupervisor(bundle, supervisor({ pending: [item("zero")], processedCount: 49 }), {
      checkRoomAgentSupervisorTurn: check, discardRoomAgentSupervisorTurn: () => undefined
    }, async handle => {
      await checking.promise;
      for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(`queued-${index}`));
      release.resolve();
      await vi.waitFor(async () => {
        const history = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
        const next = continuedInput(history); expect(next.pending).toHaveLength(100);
        expect(() => roomAgentSupervisorInputSchema.parse(next)).not.toThrow();
        const scheduled = history.events.filter((event: any) => event.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
        expect(scheduled).toHaveLength(6);
      }, { timeout: 10_000 });
    });
  }, 30_000);

  it.skipIf(process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1")("replays every committed synthetic history with the unchanged production bundle", async () => {
    const fixtures = await histories();
    for (const name of ["dummyTurnWorkflow", "codexAppServerTurnWorkflow", "dotGoalWorkflow", "roomAgentActionWorkflow",
      "roomAgentSupervisorWorkflow", "memoryMutationWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow",
      "roomAgentSupervisorWorkflow-prepatch"]) expect(fixtures.some(f => f.workflowId === `${name}.json`)).toBe(true);
    const failures: string[] = [];
    for await (const replay of Worker.runReplayHistories({ workflowBundle: bundle }, fixtures)) {
      if (replay.error) failures.push(`${replay.workflowId}: ${replay.error.name}: ${replay.error.message}`);
    }
    expect(failures).toEqual([]);
  }, 30_000);

  it.skipIf(process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1")("rejects a real nondeterministic extra timer and names the workflow/history", async () => {
    const fixture = (await histories()).filter(f => f.workflowId === "dotGoalWorkflow.json");
    expect(fixture).toHaveLength(1);
    const negative = await workflowBundle("negative"); const failures = [];
    for await (const replay of Worker.runReplayHistories({ workflowBundle: negative }, fixture)) failures.push(replay);
    expect(failures).toHaveLength(1); expect(failures[0]!.workflowId).toBe("dotGoalWorkflow.json");
    expect(failures[0]!.error).toBeInstanceOf(DeterminismViolationError);
  }, 30_000);
});
