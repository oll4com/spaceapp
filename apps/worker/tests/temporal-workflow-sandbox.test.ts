import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationFailure, activityInfo, heartbeat, sleep as activitySleep } from "@temporalio/activity";
import { TimeoutFailure, TimeoutType } from "@temporalio/common";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, DOT_GOAL_SIGNAL,
  roomAgentSupervisorInputSchema } from "@space/contracts";
import { createSandbox, eventually, turnInput, queueItem, verifiedTurn, continuedInput,
  scheduledActivities, durationSeconds } from "./support/temporal-sandbox.mjs";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation,
  supervisorTurnState } from "../src/room-background-continuation.js";

describe("real Temporal workflow sandbox", { timeout: 15_000 }, () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  // Each case owns its server clock. In particular, native turn retries have a
  // multi-year timeout and must not advance the clock of subsequent scenarios.
  beforeEach(async () => { sandbox = await createSandbox(); }, 30_000);
  afterEach(async () => { await sandbox?.stop(); }, 15_000);

  it("retries dummy turn activities and preserves their arguments and result", async () => {
    const attempts: number[] = [];
    const input = turnInput("dummy");
    const result = { status: "COMPLETED", message: "Synthetic dummy completion" };
    sandbox.use({
      recordDummyTurnStarted: async (received: unknown) => {
        expect(received).toEqual(input); attempts.push(activityInfo().attempt);
        if (activityInfo().attempt < 3) throw new Error("Synthetic transient failure");
      },
      recordDummyTurnCompleted: async (received: unknown) => { expect(received).toEqual(input); return result; }
    });
    expect(await (await sandbox.start("dummyTurnWorkflow", input)).result()).toEqual(result);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it.each([
    [undefined, {}, "runCodexAppServerTurn", 5, 86_400],
    // The Java test server caps the recorded long activity timeout at ten years.
    [undefined, { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" }, "runCodexAppServerTurn", 5, 315_360_000],
    ["opencode", {}, "runOpenCodeAgentTurn", 1, 2_400],
    ["cli:claude", {}, "runCliAgentTurn", 1, 1_800]
  ])("routes a %s turn through its real retry and timeout policy", async (providerId, extra, activity, maxAttempts, timeout) => {
    const attempts: number[] = [];
    sandbox.use({ [activity]: async () => {
      attempts.push(activityInfo().attempt);
      throw ApplicationFailure.retryable("Synthetic turn failure", "SYNTHETIC_TURN_FAILED");
    } });
    const handle = await sandbox.start("codexAppServerTurnWorkflow", turnInput("routes", { ...extra, providerId }));
    await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { type: "SYNTHETIC_TURN_FAILED" } } });
    expect(attempts).toEqual(Array.from({ length: maxAttempts }, (_, index) => index + 1));
    const scheduled = scheduledActivities(await sandbox.history(handle))[0];
    expect(scheduled).toMatchObject({
      activityType: { name: activity },
      retryPolicy: { maximumAttempts: maxAttempts }
    });
    expect(durationSeconds(scheduled.startToCloseTimeout)).toBe(timeout);
  });

  it("wakes a paused Dot without consuming its one-hour timer, including a wake during an activity", async () => {
    let release!: () => void;
    sandbox.use({ dotGoalStep: async () => {
      if (sandbox.count("dotGoalStep") === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return { state: "PAUSED", runId: null, goalStatus: "ACTIVE" };
      }
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    } });
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:wake" });
    await eventually(() => release, "Dot step to begin");
    await handle.signal(DOT_GOAL_SIGNAL);
    release();
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    expect((await sandbox.history(handle)).events.some((event: any) => event.timerStartedEventAttributes)).toBe(false);
    expect(sandbox.count("dotGoalStep")).toBe(2);
  });

  it("cancels an already-started one-hour Dot timer when the wake signal arrives", async () => {
    sandbox.use({ dotGoalStep: async () => sandbox.count("dotGoalStep") === 1
      ? { state: "PAUSED", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" } });
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:waiting-wake" });
    await eventually(async () => (await sandbox.history(handle)).events.some((event: any) => event.timerStartedEventAttributes));
    await handle.signal(DOT_GOAL_SIGNAL);
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const events = (await sandbox.history(handle)).events;
    expect(events.some((event: any) => event.timerCanceledEventAttributes)).toBe(true);
    expect(events.some((event: any) => event.timerFiredEventAttributes)).toBe(false);
  });

  it("uses real 30-second and 15-second Dot timers when no wake arrives", async () => {
    sandbox.use({
      dotGoalStep: async () => sandbox.count("dotGoalStep") === 1
        ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
        : sandbox.count("dotGoalStep") === 2 ? { state: "RUNNING", runId: "run:dot", goalStatus: "ACTIVE" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" },
      dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "ACTIVE" })
    });
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:timeout" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const timers = (await sandbox.history(handle)).events.flatMap((event: any) => event.timerStartedEventAttributes ?? []);
    expect(timers.map((timer: any) => durationSeconds(timer.startToFireTimeout))).toEqual([30, 15]);
    expect(sandbox.count("dotGoalObserve")).toBe(1);
  });

  it("continues an unfinished Dot as a new run with its goal ID intact", async () => {
    sandbox.use({ dotGoalStep: async () => sandbox.count("dotGoalStep") <= 300
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" } });
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:carried" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
    const continued = continuedInput(await sandbox.history(first));
    expect(continued.input).toEqual({ goalId: "goal:carried" });
    expect(continued.runId).not.toBe(handle.firstExecutionRunId);
    expect(sandbox.count("dotGoalStep")).toBe(301);
  }, 30_000);

  it("persists action failure after all five attempts and infers a legacy action ID", async () => {
    const attempts: number[] = [];
    sandbox.use({
      runRoomAgentBackgroundAction: async () => { attempts.push(activityInfo().attempt); throw new Error("Synthetic action failure"); },
      failRoomAgentBackgroundAction: async () => undefined
    });
    const handle = await sandbox.start("roomAgentActionWorkflow", {
      bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:action"
    }, { workflowId: "space-room-action:action:legacy" });
    await expect(handle.result()).rejects.toThrow();
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(sandbox.calls.find((call: any) => call.name === "failRoomAgentBackgroundAction")?.args[0]).toEqual({
      roomId: "room:synthetic", missionId: "mission:synthetic", actionId: "action:legacy", cancelled: false
    });
    expect((await sandbox.history(handle)).events.some((event: any) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(true);
  });

  it("persists action cancellation through the non-cancellable cleanup scope", async () => {
    sandbox.use({ runRoomAgentBackgroundAction: async () => {
      for (;;) { heartbeat(); await activitySleep(10); }
    }, failRoomAgentBackgroundAction: async () => undefined });
    const handle = await sandbox.start("roomAgentActionWorkflow", {
      actionId: "action:cancel", bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:cancel"
    });
    await eventually(() => sandbox.count("runRoomAgentBackgroundAction") === 1);
    await sandbox.close(handle, { cancel: true });
    expect(sandbox.calls.find((call: any) => call.name === "failRoomAgentBackgroundAction")?.args[0]).toMatchObject({
      actionId: "action:cancel", cancelled: true
    });
  });

  describe.each([false, true])("supervisor legacy=%s", legacy => {
    function useSupervisor(overrides: Record<string, (...args: any[]) => any> = {}) {
      sandbox.use({
        checkRoomAgentSupervisorTurn: async () => "READY", discardRoomAgentSupervisorTurn: async () => undefined,
        finishRoomAgentSupervisorTurn: async () => undefined, markRoomAgentMissionStarted: async () => undefined,
        markRoomAgentMissionFinished: async () => undefined, markRoomAgentMissionContinued: async () => undefined,
        prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" }),
        settleRoomAgentBackgroundMission: async () => false, runCodexAppServerTurn: async () => verifiedTurn, ...overrides
      });
    }

    it("enqueues, deduplicates, rejects a different room and interrupts a running child", async () => {
      useSupervisor({ runCodexAppServerTurn: async () => { for (;;) { heartbeat(); await activitySleep(10); } } });
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic" }, { legacy });
      const active = queueItem("active");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem("wrong", { roomId: "room:other" }));
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await eventually(() => sandbox.count("runCodexAppServerTurn") === 1);
      const pending = queueItem("pending");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
      const finish = legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn";
      await eventually(() => sandbox.count(finish) === 2, "active and queued mission interruption");
      expect(sandbox.count("runCodexAppServerTurn")).toBe(1);
      expect(sandbox.calls.filter((call: any) => call.name === finish).map((call: any) => call.args[0].status)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    });

    it("continues after 50 processed items and carries pending work and monitoring IDs", async () => {
      let release!: () => void;
      useSupervisor({ runCodexAppServerTurn: async () => {
        if (sandbox.count("runCodexAppServerTurn") === 1) await new Promise<void>(resolve => { release = resolve; });
        return verifiedTurn;
      } });
      const pending = queueItem("carried");
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", {
        roomId: "room:synthetic", pending: [queueItem("fiftieth"), pending], processedCount: 49,
        monitoringMissionIds: ["mission:monitoring"]
      }, { legacy });
      await eventually(() => release);
      release();
      await eventually(() => sandbox.count("runCodexAppServerTurn") === 2, "carried child execution");
      const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const { input } = continuedInput(await sandbox.history(first));
      expect(input.pending).toEqual([roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [pending] }).pending[0]]);
      expect(input.monitoringMissionIds).toEqual(["mission:monitoring"]);
      expect(input.processedCount).toBe(0);
      expect(sandbox.count("runCodexAppServerTurn")).toBe(2);
    });

    it("polls on actual one-second timers and continues after 250 polls", async () => {
      useSupervisor();
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", {
        roomId: "room:synthetic", monitoringMissionIds: ["mission:polling"], processedCount: 7
      }, { legacy });
      const activity = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
      // Await only the first run so the server can automatically skip all 250
      // durable timers; following runs would wait forever for this supervisor.
      const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
      await expect(first.result()).rejects.toMatchObject({ name: "WorkflowExecutionContinuedAsNewError" });
      const history = await sandbox.history(first);
      const { input } = continuedInput(history);
      expect(input.monitoringMissionIds).toEqual(["mission:polling"]);
      expect(input.pending).toEqual([]);
      expect(input.processedCount).toBe(legacy ? 7 : 0);
      const timers = history.events.flatMap((event: any) => event.timerStartedEventAttributes ?? []);
      expect(timers).toHaveLength(250);
      expect(scheduledActivities(history).filter((scheduled: any) => scheduled.activityType.name === activity)).toHaveLength(250);
      expect(timers.every((timer: any) => durationSeconds(timer.startToFireTimeout) === 1)).toBe(true);
      expect(sandbox.count(legacy ? "prepareRoomAgentBackgroundContinuation" : "settleRoomAgentBackgroundMission")).toBe(0);
      expect(history.events.some((event: any) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(!legacy);
    }, 30_000);
  });

  function continuationDriver(overrides: Record<string, (...args: any[]) => any> = {}) {
    const c = continuationFixture();
    sandbox.use({
      prepareRoomAgentBackgroundContinuation: (input: any) => prepareBackgroundContinuation(input, c.store),
      checkRoomAgentSupervisorTurn: (item: any) => supervisorTurnState(item, c.store),
      discardRoomAgentSupervisorTurn: ({ item, reason, errorCode }: any) => discardSupervisorTurn(item, reason, c.store, errorCode),
      finishRoomAgentSupervisorTurn: (input: any) => finishSupervisorTurn(input, c.store),
      runCodexAppServerTurn: async (turn: any) => { c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" }); return verifiedTurn; },
      ...overrides
    });
    return { ...c, input: { roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] } };
  }

  it("rechecks a paused queued mission after a real one-second condition timeout", async () => {
    sandbox.use({ checkRoomAgentSupervisorTurn: async () => sandbox.count("checkRoomAgentSupervisorTurn") === 1 ? "PAUSED" : "READY",
      runCodexAppServerTurn: async () => verifiedTurn, finishRoomAgentSupervisorTurn: async () => undefined });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", pending: [queueItem("paused")] });
    await eventually(async () => (await sandbox.history(handle)).events.some((event: any) => event.timerStartedEventAttributes));
    expect(sandbox.count("runCodexAppServerTurn")).toBe(0);
    await sandbox.env.sleep("1 second");
    await eventually(() => sandbox.count("finishRoomAgentSupervisorTurn") === 1);
    expect(sandbox.count("checkRoomAgentSupervisorTurn")).toBe(2);
    const history = await sandbox.history(handle);
    expect(history.events.some((event: any) => event.timerFiredEventAttributes)).toBe(true);
    const timers = history.events.flatMap((event: any) => event.timerStartedEventAttributes ?? []);
    expect(timers.map((timer: any) => durationSeconds(timer.startToFireTimeout))).toEqual([1]);
  });

  it("executes allocation, send and verification in one mission with one SEND action", async () => {
    const c = continuationDriver({ runCodexAppServerTurn: async (turn: any) => {
      if (sandbox.count("runCodexAppServerTurn") === 1) {
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
        return { ...verifiedTurn, roomAgentOutcome: { ...verifiedTurn.roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return verifiedTurn;
    } });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", c.input);
    for (let i = 0; i < 3; i++) await sandbox.env.sleep("1 second");
    await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
    expect(sandbox.count("runCodexAppServerTurn")).toBe(2);
    expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
    expect(sandbox.count("finishRoomAgentSupervisorTurn")).toBe(1);
    await sandbox.close(handle);
  });

  it.each([
    ["plain failure", "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["timeout", "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application type", "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ])("keeps %s on the failed turn and mission through real child failure causes", async (kind, code) => {
    const c = continuationDriver({ runCodexAppServerTurn: async () => {
      if (kind === "timeout") {
        // The activity boundary serializes an SDK TimeoutFailure into Temporal's
        // timeoutFailureInfo; the child then fails with the real SDK cause chain.
        throw ApplicationFailure.create({ message: "Synthetic child timeout", nonRetryable: true,
          type: "SyntheticChildFailure", cause: new TimeoutFailure("Synthetic heartbeat timeout", undefined, TimeoutType.HEARTBEAT) });
      }
      throw ApplicationFailure.nonRetryable("Synthetic child failure", kind === "plain failure" ? "Error" : code);
    } });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", c.input);
    await sandbox.env.sleep("1 second");
    await eventually(() => sandbox.count("runCodexAppServerTurn") === 1);
    await eventually(() => sandbox.count("finishRoomAgentSupervisorTurn") === 1);
    const prepared = sandbox.calls.find((call: any) => call.name === "checkRoomAgentSupervisorTurn")!.args[0];
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId)?.run).toMatchObject({ status: "FAILED", errorCode: code });
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
    expect(sandbox.calls.find((call: any) => call.name === "finishRoomAgentSupervisorTurn")!.args[0]).toMatchObject({ status: "FAILED", errorCode: code });
    await sandbox.close(handle);
  });

  it.each(["stop", "follow-up"])("discards a prepared automatic turn when %s arrives during the activity", async kind => {
    let prepared: any;
    let release!: () => void;
    const c = continuationDriver({ prepareRoomAgentBackgroundContinuation: async (input: any) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      prepared = result;
      await new Promise<void>(resolve => { release = resolve; });
      return result;
    } });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", c.input);
    await sandbox.env.sleep("1 second");
    await eventually(() => release);
    if (kind === "stop") {
      c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop" });
    } else {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, c.enqueue("follow-up", "Only inspect the room.").queueItem);
    }
    release();
    await eventually(() => sandbox.count("discardRoomAgentSupervisorTurn") === 1);
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.item.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
    if (kind === "stop") expect(sandbox.count("runCodexAppServerTurn")).toBe(0);
    else {
      await eventually(() => sandbox.count("runCodexAppServerTurn") === 1);
      expect(sandbox.calls.find((call: any) => call.name === "runCodexAppServerTurn")!.args[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
    }
    await sandbox.close(handle);
  });

  it("carries a prepared continuation across the real continue-as-new boundary exactly once", async () => {
    const c = continuationDriver();
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", { ...c.input, processedCount: 50 });
    await sandbox.env.sleep("1 second");
    await eventually(() => sandbox.count("runCodexAppServerTurn") === 1);
    const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
    const { input } = continuedInput(await sandbox.history(first));
    expect(input.pending).toHaveLength(1);
    expect(input.pending[0].turn.roomAgentContinuation).toBeTruthy();
    await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
    expect(sandbox.count("runCodexAppServerTurn")).toBe(1);
    expect((await sandbox.history(first)).events.some((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
  });

  it("drains an oversized signalled queue to 100 before continuing without dropping work", async () => {
    let release!: () => void;
    let checks = 0;
    sandbox.use({ checkRoomAgentSupervisorTurn: async () => {
      if (++checks === 1) await new Promise<void>(resolve => { release = resolve; });
      return "SKIP";
    }, discardRoomAgentSupervisorTurn: async () => undefined });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", {
      roomId: "room:synthetic", pending: [queueItem("0")], processedCount: 49
    });
    await eventually(() => release);
    for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem(String(index)));
    release();
    const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
    await eventually(async () => (await first.describe()).status.name === "CONTINUED_AS_NEW");
    const history = await sandbox.history(first);
    const { input } = continuedInput(history);
    expect(input.pending).toHaveLength(100);
    expect(() => roomAgentSupervisorInputSchema.parse(input)).not.toThrow();
    expect(input.pending.map((item: any) => item.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, i) => `agent_run:${i + 6}`));
    expect(scheduledActivities(history).filter((activity: any) => activity.activityType.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
  }, 15_000);

  it("runs the legacy boolean settle contract without preparing an automatic turn", async () => {
    sandbox.use({ settleRoomAgentBackgroundMission: async () => true });
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", {
      roomId: "room:synthetic", monitoringMissionIds: ["mission:legacy-settle"]
    }, { legacy: true });
    await sandbox.env.sleep("1 second");
    await eventually(() => sandbox.count("settleRoomAgentBackgroundMission") === 1);
    await sandbox.env.sleep("2 seconds");
    expect(sandbox.count("settleRoomAgentBackgroundMission")).toBe(1);
    expect(sandbox.count("prepareRoomAgentBackgroundContinuation")).toBe(0);
    await sandbox.close(handle);
  });

  it("keeps memory maintenance alive after exhausted optional refresh and reconciliation failures, then runs its child", async () => {
    const attempts: Record<string, number[]> = { refresh: [], reconcile: [], mutation: [] };
    const snapshot = { sourceHash: "synthetic-source", nodes: 0, edges: 0 };
    const run = { id: "audit:maintenance", workflowId: "synthetic-audit-child", status: "COMPLETED" };
    sandbox.use({ refreshMemoryGraphSnapshot: async () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot: async () => { attempts.refresh.push(activityInfo().attempt); throw new Error("Synthetic optional refresh failure"); },
      reconcileStaleSpaceAgentSessions: async () => { attempts.reconcile.push(activityInfo().attempt); throw new Error("Synthetic reconciliation failure"); },
      createScheduledMemoryAudit: async () => run,
      prepareMemoryConsolidation: async () => ({ changeSetId: "change:maintenance", run }),
      executePersistedMemoryChangeSet: async () => {
        attempts.mutation.push(activityInfo().attempt);
        if (activityInfo().attempt < 3) throw new Error("Synthetic mutation retry");
        return { status: "APPLIED", changeSetId: "change:maintenance" };
      }, finalizeMemoryRepair: async () => run
    });
    const handle = await sandbox.start("memoryMaintenanceWorkflow", { traceId: "trace:memory" });
    expect(await handle.result()).toEqual(snapshot);
    expect(attempts).toEqual({ refresh: [1, 2, 3], reconcile: [1, 2, 3], mutation: [1, 2, 3] });
    expect(sandbox.count("prepareMemoryConsolidation")).toBe(1);
    expect(sandbox.count("finalizeMemoryRepair")).toBe(1);
    const children = (await sandbox.history(handle)).events.flatMap((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes ?? []);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ workflowType: { name: "memoryConsolidationWorkflow" }, taskQueue: { name: "space-memory-maintenance" }, workflowId: run.workflowId });
  });

  it("returns a consolidation without mutation when no change set is prepared", async () => {
    const run = { id: "audit:no-change", status: "COMPLETED" };
    sandbox.use({ prepareMemoryConsolidation: async () => ({ run, changeSetId: null }) });
    expect(await (await sandbox.start("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:no-change" })).result()).toEqual(run);
    expect(sandbox.count("executePersistedMemoryChangeSet")).toBe(0);
  });

  it.each(["memoryConsolidationWorkflow", "memoryMutationWorkflow"])("exhausts three mutation attempts and fails %s", async name => {
    const attempts: number[] = [];
    sandbox.use({ prepareMemoryConsolidation: async () => ({ changeSetId: "change:failure", run: { id: "audit:failure" } }),
      executePersistedMemoryChangeSet: async () => { attempts.push(activityInfo().attempt); throw new Error("Synthetic mutation failure"); }
    });
    const handle = await sandbox.start(name, { changeSetId: "change:failure", runId: "audit:failure", traceId: "trace:failure" });
    await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "Synthetic mutation failure" } } });
    expect(attempts).toEqual([1, 2, 3]);
    expect(sandbox.count("finalizeMemoryRepair")).toBe(0);
  });

  it("retries and returns a standalone memory mutation without changing its input", async () => {
    const input = { changeSetId: "change:standalone", traceId: "trace:standalone" };
    const result = { changeSetId: input.changeSetId, status: "APPLIED" };
    const attempts: number[] = [];
    sandbox.use({ executePersistedMemoryChangeSet: async (received: unknown) => {
      expect(received).toEqual(input);
      attempts.push(activityInfo().attempt);
      if (activityInfo().attempt < 3) throw new Error("Synthetic mutation retry");
      return result;
    } });
    expect(await (await sandbox.start("memoryMutationWorkflow", input)).result()).toEqual(result);
    expect(attempts).toEqual([1, 2, 3]);
  });
});
