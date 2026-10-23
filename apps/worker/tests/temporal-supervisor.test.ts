import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, defaultPayloadConverter, TimeoutFailure, TimeoutType } from "@temporalio/common";
import type { WorkflowHandleWithStartDetails } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema, type DummyTurnInput, type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { bundleSupervisorWorkflows } from "./support/supervisor-workflow-bundle.js";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

const verified = {
  status: "COMPLETED", message: "Verified",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
};
type Activities = object;
let env: TestWorkflowEnvironment;
let currentBundle: Awaited<ReturnType<typeof bundleSupervisorWorkflows>>;
let legacyBundle: Awaited<ReturnType<typeof bundleSupervisorWorkflows>>;

beforeAll(async () => {
  [currentBundle, legacyBundle] = await Promise.all([bundleSupervisorWorkflows(), bundleSupervisorWorkflows(true)]);
}, 120_000);
// These supervisors deliberately remain open and continue-as-new. Isolate their
// virtual clocks so terminating one run cannot affect the next scenario's timers.
beforeEach(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 30_000);
afterEach(async () => { await env?.teardown(); }, 30_000);

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw Error("Expected Temporal activity/history event did not arrive");
    await delay(10);
  }
}

function item(index: number, roomId = "room:sandbox", missionId = "mission:sandbox") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
    roomId, paneId: "pane:sandbox", prompt: `Request ${index}`, agentRunId: `agent_run:sandbox-${index}`,
    traceId: `trace:${randomUUID()}`
  } });
}

async function runSupervisor(
  input: Partial<RoomAgentSupervisorInput> & { roomId: string }, activities: Activities,
  body: (handle: WorkflowHandleWithStartDetails) => Promise<void>, options: { legacy?: boolean; record?: string; timeoutMs?: number } = {}
) {
  const taskQueue = `supervisor-test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue,
    workflowBundle: options.legacy ? legacyBundle : currentBundle, activities,
    maxConcurrentWorkflowTaskExecutions: 4, maxConcurrentActivityTaskExecutions: 4,
    maxHeartbeatThrottleInterval: "10 milliseconds", defaultHeartbeatThrottleInterval: "10 milliseconds",
    shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds"
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: `supervisor-${randomUUID()}`, taskQueue,
      args: [roomAgentSupervisorInputSchema.parse(input)]
    });
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error("Supervisor scenario exceeded its wall-time bound")), options.timeoutMs ?? 20_000);
    });
    try { await Promise.race([body(handle), deadline]); }
    finally {
      clearTimeout(timeout!);
      await env.client.workflow.getHandle(handle.workflowId).terminate("Test finished");
      if (options.record) await recordWorkflowHistory(options.record, handle);
    }
  });
}

function durableDriver() {
  const fixture = continuationFixture();
  const prepared: RoomAgentSupervisorQueueItem[] = [];
  const activities = {
    prepareRoomAgentBackgroundContinuation: vi.fn(async input => {
      const result = await prepareBackgroundContinuation(input, fixture.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    }),
    checkRoomAgentSupervisorTurn: vi.fn(input => supervisorTurnState(input, fixture.store)),
    discardRoomAgentSupervisorTurn: vi.fn(({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, fixture.store, errorCode)),
    finishRoomAgentSupervisorTurn: vi.fn(input => finishSupervisorTurn(input, fixture.store)),
    runCodexAppServerTurn: vi.fn(async (turn: DummyTurnInput) => {
      fixture.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return verified;
    })
  };
  return { ...fixture, prepared, activities,
    workflowInput: { roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id] } };
}

async function continuationInput(handle: WorkflowHandleWithStartDetails) {
  const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
  const history = await first.fetchHistory();
  const continued = history.events?.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
  const payload = continued?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  expect(payload, "a real ContinueAsNew event with carried input").toBeDefined();
  return roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(payload!));
}

describe("room supervisor in the real Temporal sandbox", () => {
  // The following cases mirror every assertion family in room-supervisor-continuation.test.ts.
  it("allocates, sends once, and verifies the same durable mission", async () => {
    const c = durableDriver();
    c.activities.runCodexAppServerTurn.mockImplementationOnce(async turn => {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once",
        actionType: "SEND", evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return { ...verified, roomAgentOutcome: { ...verified.roomAgentOutcome, pendingActionIds: ["action:send"] } };
    });
    await runSupervisor(c.workflowInput, c.activities, async handle => {
      await env.sleep("3 seconds");
      await until(() => c.activities.finishRoomAgentSupervisorTurn.mock.calls.length === 1);
      expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
      expect(c.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      const history = await handle.fetchHistory();
      expect(history.events?.filter(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(2);
      expect(history.events?.some(e => Number(e.timerStartedEventAttributes?.startToFireTimeout?.seconds) === 1)).toBe(true);
    }, { record: "roomAgentSupervisorWorkflow" });
  }, 30_000);

  it.each([
    ["plain activity failure", () => Error("child failed"), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["Temporal timeout cause", () => new ApplicationFailure("child failed", "TransportError", true, [],
      new TimeoutFailure("timed out", undefined, TimeoutType.START_TO_CLOSE)), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application failure type", () => ApplicationFailure.create({ message: "turn timed out", type: "CODEX_APP_SERVER_TURN_TIMEOUT", nonRetryable: true }), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const)("persists %s as FAILED with the real nested failure code", async (_, failure, code) => {
    const c = durableDriver();
    c.activities.runCodexAppServerTurn.mockImplementation(async () => { throw failure(); });
    await runSupervisor(c.workflowInput, c.activities, async () => {
      await env.sleep("40 seconds");
      await until(() => c.activities.finishRoomAgentSupervisorTurn.mock.calls.length > 0);
      expect(c.prepared).toHaveLength(1);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, c.prepared[0]!.turn.agentRunId)?.run)
        .toMatchObject({ status: "FAILED", errorCode: code });
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
      expect(c.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode: code }));
    });
  }, 30_000);

  it.each(["stop", "follow-up"] as const)("retires prepared work when a %s signal arrives before its activity reply", async kind => {
    const c = durableDriver();
    c.activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async input => {
      const running = env.client.workflow.getHandle(Context.current().info.workflowExecution!.workflowId);
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") c.prepared.push(result.item);
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await running.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await running.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      return result;
    });
    await runSupervisor(c.workflowInput, c.activities, async () => {
      await env.sleep("2 seconds");
      await until(() => c.activities.discardRoomAgentSupervisorTurn.mock.calls.length > 0);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, c.prepared[0]!.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(c.activities.runCodexAppServerTurn).not.toHaveBeenCalled();
      else {
        await until(() => c.activities.runCodexAppServerTurn.mock.calls.length > 0);
        expect(c.activities.runCodexAppServerTurn.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
    });
  }, 30_000);

  it("carries a prepared continuation through ContinueAsNew and starts it once", async () => {
    const c = durableDriver();
    await runSupervisor({ ...c.workflowInput, processedCount: 50 }, c.activities, async handle => {
      await env.sleep("2 seconds");
      await until(() => c.activities.finishRoomAgentSupervisorTurn.mock.calls.length > 0);
      const carried = await continuationInput(handle);
      expect(carried.pending).toHaveLength(1);
      expect(carried.pending[0]).toEqual(c.prepared[0]);
      expect(carried.processedCount).toBe(0);
      expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
      const first = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      expect(first.events?.filter(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
    });
  }, 30_000);

  it("drains an oversized signaled queue to the 100-item carry bound without loss", async () => {
    const initial = item(0);
    const checked: string[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: vi.fn(async (queued: RoomAgentSupervisorQueueItem) => {
        checked.push(queued.turn.agentRunId!);
        if (checked.length === 1) {
          const running = env.client.workflow.getHandle(Context.current().info.workflowExecution!.workflowId);
          for (let index = 1; index <= 105; index++) await running.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
        }
        return "SKIP";
      }),
      discardRoomAgentSupervisorTurn: vi.fn(async () => undefined)
    };
    await runSupervisor({ roomId: initial.turn.roomId, pending: [initial], processedCount: 49 }, activities, async handle => {
      await until(async () => (await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory()).events?.some(e => Boolean(e.workflowExecutionContinuedAsNewEventAttributes)) ?? false);
      const carried = await continuationInput(handle);
      expect(carried.pending).toHaveLength(100);
      expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();
      const first = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      expect(first.events?.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
      expect(new Set([...checked.slice(0, 6), ...carried.pending.map(p => p.turn.agentRunId)]).size).toBe(106);
    });
  }, 30_000);

  it.each([false, true])("enqueues a real child and cancels the running mission (legacy=%s)", async legacy => {
    const queued = item(1);
    let started = false;
    let cancelled = false;
    const finished = vi.fn(async () => undefined);
    const activities = {
      checkRoomAgentSupervisorTurn: async () => "READY",
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: finished,
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: finished,
      runCodexAppServerTurn: async () => {
        started = true;
        const context = Context.current();
        const heartbeats = setInterval(() => context.heartbeat(), 10);
        try { await context.cancelled; }
        finally { cancelled = true; clearInterval(heartbeats); }
        return verified;
      }
    };
    await runSupervisor({ roomId: queued.turn.roomId }, activities, async handle => {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await until(() => started);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: queued.missionId, reason: "Operator stopped mission" });
      await until(() => finished.mock.calls.length > 0);
      await until(() => cancelled);
      expect(cancelled).toBe(true);
      expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: "INTERRUPTED", statusReason: "Operator stopped mission" }));
      const history = await handle.fetchHistory();
      expect(history.events?.some(e => e.childWorkflowExecutionCanceledEventAttributes)).toBe(true);
    }, { legacy });
  }, 30_000);

  it.each([false, true])("continues when the persisted counter reaches 50, carrying the untouched next turn (legacy=%s)", async legacy => {
    // Resume the real persisted counter at 49 to exercise the boundary without
    // repeating 49 already-covered child executions.
    const pending = [item(0), item(1)];
    let resolveSecond!: () => void;
    const secondObserved = new Promise<void>(resolve => { resolveSecond = resolve; });
    const observe = (turn: DummyTurnInput) => {
      if (turn.agentRunId === pending[1]!.turn.agentRunId) resolveSecond();
    };
    const activities = {
      checkRoomAgentSupervisorTurn: async (queued: RoomAgentSupervisorQueueItem) => { observe(queued.turn); return "SKIP"; },
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async () => undefined,
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async () => undefined,
      markRoomAgentMissionContinued: async () => undefined,
      runCodexAppServerTurn: async (turn: DummyTurnInput) => { observe(turn); return verified; }
    };
    await runSupervisor({ roomId: pending[0]!.turn.roomId, pending, processedCount: 49 }, activities, async handle => {
      await secondObserved;
      const carried = await continuationInput(handle);
      expect(carried.pending).toEqual([pending.at(-1)]);
      expect(carried.processedCount).toBe(0);
      expect(carried.interrupted).toEqual([]);
      const first = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      if (legacy) expect(first.events?.filter(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(1);
      else expect(first.events?.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(1);
    }, { legacy });
  }, 45_000);

  it("carries interrupted work and monitoring state through continue-as-new and retires the stopped turn once", async () => {
    const roomId = "room:interrupted-carry";
    const first = item(0, roomId, "mission:first");
    const stopped = item(1, roomId, "mission:stopped");
    const next = item(2, roomId, "mission:next");
    const reason = "Stop the queued mission";
    const monitoringMissionIds = ["mission:unrelated-watch"];
    let resolveNext!: () => void;
    const nextObserved = new Promise<void>(resolve => { resolveNext = resolve; });
    const check = vi.fn(async (queued: RoomAgentSupervisorQueueItem) => {
      if (queued.turn.agentRunId === first.turn.agentRunId) {
        const execution = Context.current().info.workflowExecution;
        if (!execution) throw new Error("Expected a workflow-bound supervisor activity");
        await env.client.workflow.getHandle(execution.workflowId, execution.runId)
          .signal(ROOM_AGENT_STOP_SIGNAL, { missionId: stopped.missionId, reason });
      }
      if (queued.turn.agentRunId === next.turn.agentRunId) resolveNext();
      return "SKIP";
    });
    const discard = vi.fn<(input: { item: RoomAgentSupervisorQueueItem; reason: string }) => Promise<void>>(async () => undefined);
    const finish = vi.fn<(input: { item: RoomAgentSupervisorQueueItem; status: string; statusReason: string }) => Promise<void>>(async () => undefined);
    await runSupervisor({ roomId, pending: [first, stopped, next], monitoringMissionIds, processedCount: 49 }, {
      checkRoomAgentSupervisorTurn: check,
      discardRoomAgentSupervisorTurn: discard,
      finishRoomAgentSupervisorTurn: finish,
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" })
    }, async handle => {
      await nextObserved;
      const carried = await continuationInput(handle);
      expect(carried).toEqual({ roomId, pending: [next], interrupted: [{ item: stopped, reason }],
        monitoringMissionIds, processedCount: 0 });
      expect(discard.mock.calls.filter(([input]) => input.item.turn.agentRunId === stopped.turn.agentRunId))
        .toEqual([[{ item: stopped, reason }]]);
      expect(finish).toHaveBeenCalledWith({ item: stopped, status: "INTERRUPTED", statusReason: reason });
      expect(check.mock.calls.map(([queued]) => queued.turn.agentRunId))
        .toEqual([first.turn.agentRunId, next.turn.agentRunId]);
    });
  }, 30_000);

  it.each([false, true])("continues after 250 one-second monitoring polls, preserving mission IDs (legacy=%s)", async legacy => {
    const monitor = "mission:monitor";
    const settle = vi.fn(async () => false);
    const prepare = vi.fn(async () => ({ state: "WAITING" }));
    await runSupervisor({ roomId: "room:monitor", monitoringMissionIds: [monitor] }, {
      settleRoomAgentBackgroundMission: settle,
      prepareRoomAgentBackgroundContinuation: prepare
    }, async handle => {
      // Wait until the first timer exists before advancing the virtual clock;
      // otherwise the test service can skip ahead before the worker starts.
      const firstHandle = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await until(async () => (await firstHandle.fetchHistory()).events?.some(e => Boolean(e.timerStartedEventAttributes)) ?? false);
      await env.sleep("251 seconds");
      await until(async () => (await firstHandle.fetchHistory()).events?.some(e => Boolean(e.workflowExecutionContinuedAsNewEventAttributes)) ?? false);
      const carried = await continuationInput(handle);
      expect(carried.monitoringMissionIds).toEqual([monitor]);
      expect(carried.pending).toEqual([]);
      const first = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      const events = first.events ?? [];
      expect(events.filter(e => e.timerStartedEventAttributes)).toHaveLength(250);
      expect(events.filter(e => e.activityTaskScheduledEventAttributes)).toHaveLength(250);
      expect(events.filter(e => e.timerStartedEventAttributes).every(e => Number(e.timerStartedEventAttributes!.startToFireTimeout?.seconds) === 1)).toBe(true);
      if (legacy) { expect(settle).toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); }
      else { expect(prepare).toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); }
    }, { legacy, timeoutMs: 50_000 });
  }, 65_000);

  it("executes the pre-patch boolean settlement branch and replays it with current code", async () => {
    const settle = vi.fn(async () => true);
    const prepare = vi.fn(async () => ({ state: "DONE" }));
    await runSupervisor({ roomId: "room:legacy", monitoringMissionIds: ["mission:legacy"] }, {
      settleRoomAgentBackgroundMission: settle, prepareRoomAgentBackgroundContinuation: prepare
    }, async handle => {
      await env.sleep("2 seconds");
      await until(() => settle.mock.calls.length === 1);
      expect(prepare).not.toHaveBeenCalled();
      const history = await handle.fetchHistory();
      expect(history.events?.some(e => e.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(false);
      await Worker.runReplayHistory({ workflowBundle: currentBundle }, history);
    }, { legacy: true, record: "roomAgentSupervisorWorkflow-legacy" });
  }, 30_000);
});

it("returns a completed background action without recording a failure", async () => {
  const taskQueue = `action-test-${randomUUID()}`;
  const result = { actionId: "action:success", status: "COMPLETED" };
  const fail = vi.fn(async () => undefined);
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: currentBundle,
    activities: { runRoomAgentBackgroundAction: async () => result, failRoomAgentBackgroundAction: fail }
  });
  await worker.runUntil(async () => {
    const actual = await env.client.workflow.execute("roomAgentActionWorkflow", {
      workflowId: `space-room-action:${randomUUID()}`, taskQueue,
      args: [{ actionId: result.actionId, bridge: { roomId: "room:proof", missionId: "mission:proof" }, traceId: "trace:proof" }]
    });
    expect(actual).toEqual(result);
    expect(fail).not.toHaveBeenCalled();
  });
}, 30_000);

it("persists background action failure only after all five real retries, including a legacy workflow ID", async () => {
  const attempts: number[] = [];
  const fail = vi.fn(async () => undefined);
  const taskQueue = `action-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: currentBundle,
    activities: {
      runRoomAgentBackgroundAction: async () => { attempts.push(Context.current().info.attempt); throw Error("transport failed"); },
      failRoomAgentBackgroundAction: fail
    }
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
      workflowId: `space-room-action:action:legacy-${randomUUID()}`, taskQueue,
      args: [{ bridge: { roomId: "room:proof", missionId: "mission:proof" }, traceId: "trace:proof" }]
    });
    await expect(handle.result()).rejects.toThrow();
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith({ roomId: "room:proof", missionId: "mission:proof",
      actionId: handle.workflowId.replace(/^space-room-action:/, ""), cancelled: false });
    const history = await handle.fetchHistory();
    expect(history.events?.some(e => e.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(true);
    expect(history.events?.some(e => e.workflowExecutionFailedEventAttributes)).toBe(true);
    await recordWorkflowHistory("roomAgentActionWorkflow", handle);
  });
}, 30_000);
