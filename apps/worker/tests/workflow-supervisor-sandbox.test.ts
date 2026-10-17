import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  type DummyTurnInput,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem,
  type TurnWorkflowResult
} from "@space/contracts";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState,
  type BackgroundContinuationResult
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { createSandbox } from "./support/workflow-sandbox.js";

type Sandbox = Awaited<ReturnType<typeof createSandbox>>;
type ActivityStubs = Parameters<typeof createSandbox>[0]["activities"];

/** Creates a gate that lets a scenario deliver a signal while an activity is still pending. */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Polls an assertion on the host clock and rethrows its last failure when the timeout expires. */
async function eventually(assertion: () => void | Promise<void>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { await assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Builds a schema-validated turn whose stable indexed IDs make queue order and deduplication observable. */
function queueItem(index: number, roomId = "room:sandbox", missionId = `mission:${index}`): RoomAgentSupervisorQueueItem {
  return roomAgentSupervisorQueueItemSchema.parse({
    missionId,
    turn: {
      roomId, paneId: "pane:sandbox", prompt: `Operator request ${index}`,
      agentRunId: `agent_run:sandbox-${index}`, traceId: `trace:sandbox-${index}`
    }
  });
}

/** Returns a completed child-turn result with the verification evidence the supervisor expects. */
const verified = (): TurnWorkflowResult => ({
  workflowId: "workflow:sandbox", roomId: "room:sandbox", paneId: "pane:sandbox", traceId: "trace:sandbox",
  status: "COMPLETED", message: "Verified",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
});

/** Supplies typed, overridable activity spies while leaving Temporal's workflow APIs and scheduling real. */
function defaultActivities() {
  return {
    checkRoomAgentSupervisorTurn: vi.fn<(item: RoomAgentSupervisorQueueItem) => Promise<"READY" | "PAUSED" | "SKIP">>().mockResolvedValue("READY"),
    discardRoomAgentSupervisorTurn: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    finishRoomAgentSupervisorTurn: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    prepareRoomAgentBackgroundContinuation: vi.fn<(input: Parameters<typeof prepareBackgroundContinuation>[0]) => Promise<BackgroundContinuationResult>>().mockResolvedValue({ state: "DONE" }),
    settleRoomAgentBackgroundMission: vi.fn<(input: { roomId: string; missionId: string }) => Promise<boolean>>().mockResolvedValue(true),
    markRoomAgentMissionStarted: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    markRoomAgentMissionFinished: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    markRoomAgentMissionContinued: vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    runCodexAppServerTurn: vi.fn<(input: DummyTurnInput) => Promise<TurnWorkflowResult>>().mockResolvedValue(verified())
  };
}

/**
 * Runs an otherwise unbounded supervisor until the scenario finishes, then terminates it and closes the sandbox.
 * The initial handle stays pinned to the first run so continue-as-new assertions inspect the intended history.
 */
async function withSupervisor(
  input: Partial<RoomAgentSupervisorInput> & { roomId: string },
  activities: ActivityStubs,
  scenario: (context: { sandbox: Sandbox; handle: WorkflowHandle; initial: WorkflowHandle }) => Promise<void>,
  legacySupervisor = false
) {
  const sandbox = await createSandbox({ activities, legacySupervisor });
  try {
    await sandbox.runUntil(async () => {
      const handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId: `sandbox-supervisor-${randomUUID()}`,
        taskQueue: sandbox.queue,
        args: [roomAgentSupervisorInputSchema.parse(input)]
      });
      const initial = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      // result() unlocks the testing server's clock. The supervisor intentionally
      // runs forever; the scenario terminates it after inspecting real events.
      const completed = handle.result().catch(() => undefined);
      try { await scenario({ sandbox, handle, initial }); }
      finally {
        await handle.terminate("Supervisor sandbox scenario complete").catch(() => undefined);
        await completed;
      }
    });
  } finally {
    await sandbox.close();
  }
}

/** Waits for the first run's continue-as-new event and validates the state carried into its successor. */
async function carriedInput(initial: WorkflowHandle): Promise<RoomAgentSupervisorInput> {
  let carried: RoomAgentSupervisorInput | undefined;
  await eventually(async () => {
    const history = await initial.fetchHistory();
    const event = history.events?.find((entry) => entry.workflowExecutionContinuedAsNewEventAttributes);
    const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
    expect(payload?.data).toBeDefined();
    carried = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(payload!.data!).toString("utf8")));
  });
  return carried!;
}

/** Connects real continuation state transitions to the in-memory store through sandbox activity spies. */
function continuationDriver() {
  const fixture = continuationFixture();
  const activities = {
    ...defaultActivities(),
    prepareRoomAgentBackgroundContinuation: vi.fn((input: Parameters<typeof prepareBackgroundContinuation>[0]) => prepareBackgroundContinuation(input, fixture.store)),
    checkRoomAgentSupervisorTurn: vi.fn((item: RoomAgentSupervisorQueueItem) => supervisorTurnState(item, fixture.store)),
    discardRoomAgentSupervisorTurn: vi.fn(({ item, reason }: { item: RoomAgentSupervisorQueueItem; reason: string }) => discardSupervisorTurn(item, reason, fixture.store)),
    finishRoomAgentSupervisorTurn: vi.fn((input: Parameters<typeof finishSupervisorTurn>[0]) => finishSupervisorTurn(input, fixture.store)),
    runCodexAppServerTurn: vi.fn(async (turn: DummyTurnInput): Promise<TurnWorkflowResult> => {
      fixture.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return verified();
    })
  };
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id]
  });
  return { ...fixture, activities, workflowInput: input };
}

describe("Room Agent supervisor in the real Temporal sandbox", { timeout: 60_000 }, () => {
  it("executes allocation, send and verification in the same mission", async () => {
    const c = continuationDriver();
    c.activities.runCodexAppServerTurn.mockImplementationOnce(async (turn) => {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({
        ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed."
      });
      c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return {
        ...verified(),
        status: "COMPLETED", message: "Sent",
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, pendingActionIds: ["action:send"], statusReason: "Queued" }
      };
    });
    await withSupervisor(c.workflowInput, c.activities, async ({ initial }) => {
      await eventually(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"));
      expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
      expect(c.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
      const history = await initial.fetchHistory();
      expect(history.events?.filter((event) => event.childWorkflowExecutionCompletedEventAttributes)).toHaveLength(2);
    });
  });

  it.each(["stop", "follow-up"] as const)("retires a prepared continuation when %s arrives before its activity reply", async (kind) => {
    const c = continuationDriver();
    const preparing = deferred<RoomAgentSupervisorQueueItem>();
    const release = deferred();
    c.activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async (input) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state !== "READY") throw Error("Expected a prepared continuation");
      preparing.resolve(result.item);
      await release.promise;
      return result;
    });
    await withSupervisor(c.workflowInput, c.activities, async ({ handle, initial }) => {
      const prepared = await preparing.promise;
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      release.resolve();
      await eventually(() => expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.turn.agentRunId!)?.run.status).toBe("INTERRUPTED"));
      expect(c.activities.discardRoomAgentSupervisorTurn).toHaveBeenCalledWith({
        item: prepared, reason: "Superseded while preparing the automatic continuation."
      });
      if (kind === "stop") {
        expect(c.activities.runCodexAppServerTurn).not.toHaveBeenCalled();
        expect((await initial.fetchHistory()).events?.filter((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
      } else {
        await eventually(() => expect(c.activities.runCodexAppServerTurn).toHaveBeenCalled());
        expect(c.activities.runCodexAppServerTurn.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
    });
  });

  it("carries a prepared continuation across continue-as-new and starts it exactly once", async () => {
    const c = continuationDriver();
    await withSupervisor({ ...c.workflowInput, processedCount: 50 }, c.activities, async ({ initial }) => {
      const carried = await carriedInput(initial);
      expect(carried.pending).toHaveLength(1);
      expect(carried.pending[0]!.turn.roomAgentContinuation).toBeDefined();
      expect(carried.monitoringMissionIds).toEqual([c.initial.mission.id]);
      expect(carried.processedCount).toBe(0);
      expect((await initial.fetchHistory()).events?.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
      await eventually(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"));
      expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
    });
  });

  it("drains an overflowing signalled queue before carrying at most 100 turns", async () => {
    const activities = defaultActivities();
    const checking = deferred();
    const release = deferred();
    activities.checkRoomAgentSupervisorTurn.mockImplementationOnce(async () => {
      checking.resolve();
      await release.promise;
      return "SKIP";
    });
    activities.checkRoomAgentSupervisorTurn.mockImplementation(async () => "SKIP");
    await withSupervisor({ roomId: "room:carry-bound", pending: [queueItem(0, "room:carry-bound")], processedCount: 49 }, activities, async ({ handle, initial }) => {
      await checking.promise;
      for (let index = 1; index <= 105; index++) {
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queueItem(index, "room:carry-bound"));
      }
      release.resolve();
      const carried = await carriedInput(initial);
      expect(carried.pending).toHaveLength(100);
      expect(carried.pending.map((item) => item.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, index) => `agent_run:sandbox-${index + 6}`));
      const history = await initial.fetchHistory();
      expect(history.events?.filter((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
    });
  });

  it("retains the legacy boolean settlement contract on the pre-patch branch", async () => {
    const activities = defaultActivities();
    await withSupervisor({ roomId: "room:legacy", monitoringMissionIds: ["mission:legacy"] }, activities, async () => {
      await eventually(() => expect(activities.settleRoomAgentBackgroundMission).toHaveBeenCalledOnce());
      expect(activities.settleRoomAgentBackgroundMission).toHaveBeenCalledWith({ roomId: "room:legacy", missionId: "mission:legacy" });
      expect(activities.prepareRoomAgentBackgroundContinuation).not.toHaveBeenCalled();
    }, true);
  });

  for (const legacySupervisor of [false, true]) {
    const branch = legacySupervisor ? "legacy" : "current";

    it(`${branch}: enqueues a real child, ignores a duplicate request and cancels it with stop`, async () => {
      const activities = defaultActivities();
      const started = deferred();
      const cancelled = deferred();
      activities.runCodexAppServerTurn.mockImplementation(async () => {
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 25);
        started.resolve();
        try { await context.cancelled; throw Error("Expected activity cancellation"); }
        finally { clearInterval(heartbeat); cancelled.resolve(); }
      });
      const item = queueItem(1);
      await withSupervisor({ roomId: item.turn.roomId }, activities, async ({ handle, initial }) => {
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
        await started.promise;
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: item.missionId, reason: "Stopped from the test" });
        await cancelled.promise;
        const finish = legacySupervisor ? activities.markRoomAgentMissionFinished : activities.finishRoomAgentSupervisorTurn;
        await eventually(() => expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "INTERRUPTED", statusReason: "Stopped from the test" })));
        expect(activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
        const history = await initial.fetchHistory();
        expect(history.events?.filter((event) => event.childWorkflowExecutionCanceledEventAttributes)).toHaveLength(1);
      }, legacySupervisor);
    });

    it(`${branch}: continues after 50 processed turns with the remaining queue and monitoring intact`, async () => {
      const activities = defaultActivities();
      const first = queueItem(1);
      const next = queueItem(2);
      await withSupervisor({ roomId: first.turn.roomId, pending: [first, next], monitoringMissionIds: ["mission:watch"], processedCount: 49 }, activities, async ({ initial }) => {
        const carried = await carriedInput(initial);
        expect(carried.pending).toEqual([next]);
        expect(carried.monitoringMissionIds).toEqual(["mission:watch"]);
        expect(carried.processedCount).toBe(0);
        await eventually(() => expect(activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2));
        expect(activities.runCodexAppServerTurn.mock.calls.map(([input]) => input.agentRunId)).toEqual([first.turn.agentRunId, next.turn.agentRunId]);
      }, legacySupervisor);
    });

    it(`${branch}: executes 250 one-second monitoring polls before continuing as new`, async () => {
      const activities = defaultActivities();
      activities.settleRoomAgentBackgroundMission.mockImplementation(async () => false);
      activities.prepareRoomAgentBackgroundContinuation.mockImplementation(async () => ({ state: "WAITING" }));
      await withSupervisor({ roomId: "room:poll-limit", monitoringMissionIds: ["mission:watch"] }, activities, async ({ initial }) => {
        const carried = await carriedInput(initial);
        expect(carried.monitoringMissionIds).toEqual(["mission:watch"]);
        expect(carried.pending).toEqual([]);
        expect(carried.processedCount).toBe(0);
        const history = await initial.fetchHistory();
        const activityName = legacySupervisor ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
        expect(history.events?.filter((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === activityName)).toHaveLength(250);
        const timers = history.events?.filter((event) => event.timerStartedEventAttributes) ?? [];
        expect(timers).toHaveLength(250);
        expect(timers.every((event) => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
      }, legacySupervisor);
    });
  }
});
