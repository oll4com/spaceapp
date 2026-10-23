import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError, WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure, TerminatedFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  type DummyTurnInput,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { history, waitUntil, withSandbox } from "./support/temporal-sandbox.js";

type Branch = "current" | "legacy";
type Sandbox = Parameters<Parameters<typeof withSandbox>[1]>[0];
type Started = { handle: WorkflowHandle; first: WorkflowHandle; runId: string };
type SupervisorSandbox = Sandbox & { start(input: Partial<RoomAgentSupervisorInput> & { roomId: string }): Promise<Started> };
const closedSupervisors = new WeakSet<WorkflowHandle>();

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function item(index: number, missionId = `mission:synthetic-${index}`, roomId = "room:synthetic") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
    roomId, paneId: "pane:synthetic", prompt: `Synthetic request ${index}`,
    agentRunId: `agent_run:synthetic-${index}`, traceId: `trace:synthetic-${index}`
  } });
}

const verified = {
  status: "COMPLETED", message: "Verified",
  roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
};

async function sandbox(
  branch: Branch,
  activities: Record<string, Function>,
  run: (context: SupervisorSandbox) => Promise<void>
) {
  // A cancelled successor can leave the test server's clock locked after child
  // workflows. Give each scenario its own server instead of sharing that state.
  await withSandbox({ legacySupervisor: branch === "legacy", activities }, async context => {
    const started: WorkflowHandle[] = [];
    try {
      await run({ ...context, async start(input) {
        const handle = await context.client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor-synthetic-${randomUUID()}`, taskQueue: context.taskQueue,
          args: [roomAgentSupervisorInputSchema.parse(input)]
        });
        started.push(handle);
        const runId = handle.firstExecutionRunId;
        const first = context.client.workflow.getHandle(handle.workflowId, runId, { followRuns: false });
        return { handle, first, runId };
      } });
    } finally {
      // Close each infinite workflow before disposing of its owned test server.
      await Promise.all(started.map(closeSupervisor));
    }
  });
}

async function closeSupervisor(handle: WorkflowHandle) {
  if (closedSupervisors.has(handle)) return;
  await handle.terminate("Synthetic scenario completed");
  await handle.result().then(() => {
    throw new Error("An indefinitely running supervisor unexpectedly completed");
  }, error => {
    expect(error).toBeInstanceOf(WorkflowFailedError);
    expect(error.cause).toBeInstanceOf(TerminatedFailure);
  });
  closedSupervisors.add(handle);
}

async function continuation(first: WorkflowHandle) {
  await expect(first.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
  const events = (await history(first)).events ?? [];
  const event = events.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
  expect(event, "the first run must really continue as new").toBeDefined();
  const attributes = event!.workflowExecutionContinuedAsNewEventAttributes!;
  const payload = attributes.input!.payloads![0]!;
  const input = roomAgentSupervisorInputSchema.parse(JSON.parse(Buffer.from(payload.data!).toString()));
  return { input, events, newRunId: attributes.newExecutionRunId! };
}

async function advanceUntil(env: TestWorkflowEnvironment, predicate: () => boolean) {
  await waitUntil(async () => {
    if (predicate()) return true;
    await env.sleep("1 second");
    return predicate();
  }, 30_000);
}

function storeActivities(c: ReturnType<typeof continuationFixture>) {
  return {
    prepareRoomAgentBackgroundContinuation: (input: Parameters<typeof prepareBackgroundContinuation>[0]) =>
      prepareBackgroundContinuation(input, c.store),
    checkRoomAgentSupervisorTurn: (item: RoomAgentSupervisorQueueItem) => supervisorTurnState(item, c.store),
    discardRoomAgentSupervisorTurn: ({ item, reason, errorCode }: { item: RoomAgentSupervisorQueueItem; reason: string; errorCode?: string }) =>
      discardSupervisorTurn(item, reason, c.store, errorCode),
    finishRoomAgentSupervisorTurn: (input: Parameters<typeof finishSupervisorTurn>[0]) => finishSupervisorTurn(input, c.store)
  };
}

describe.each<Branch>(["current", "legacy"])("%s supervisor in the Temporal sandbox", branch => {
  it("validates enqueue signals, deduplicates queued work, and stops queued and running missions", async () => {
    const active = item(1);
    const queued = item(2);
    const sentinel = item(4);
    const executed: string[] = [];
    const finished: Array<{ missionId: string; status: string; statusReason: string }> = [];
    const discarded: string[] = [];
    let cancelled = false;
    await sandbox(branch, {
      checkRoomAgentSupervisorTurn: async () => "READY",
      markRoomAgentMissionStarted: async () => undefined,
      runCodexAppServerTurn: async (turn: DummyTurnInput) => {
        executed.push(turn.agentRunId!);
        if (turn.agentRunId === sentinel.turn.agentRunId) return verified;
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 20);
        try { return await context.cancelled; }
        finally { clearInterval(heartbeat); cancelled = true; }
      },
      discardRoomAgentSupervisorTurn: async ({ item }: { item: RoomAgentSupervisorQueueItem }) => { discarded.push(item.missionId); },
      finishRoomAgentSupervisorTurn: async ({ item, ...result }: { item: RoomAgentSupervisorQueueItem; status: string; statusReason: string }) => {
        finished.push({ missionId: item.missionId, ...result });
      },
      markRoomAgentMissionFinished: async (result: typeof finished[number]) => { finished.push(result); }
    }, async ({ start, record }) => {
      const { handle, first } = await start({ roomId: active.turn.roomId });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
      await waitUntil(() => executed.length === 1);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { invalid: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(3, "mission:wrong-room", "room:other"));
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: queued.missionId, reason: "Stop queued mission" });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: active.missionId, reason: "Stop running mission" });
      await waitUntil(() => finished.length === 2 && cancelled);
      // A successful sentinel behind all earlier signals proves the queue really
      // drained; observing a stub's invocation alone could hide a duplicate turn.
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, sentinel);
      await waitUntil(async () => {
        const events = (await history(first)).events ?? [];
        const scheduled = events.find(event => {
          const attributes = event.activityTaskScheduledEventAttributes;
          if (!["finishRoomAgentSupervisorTurn", "markRoomAgentMissionFinished"].includes(attributes?.activityType?.name ?? "")) return false;
          const input = JSON.parse(Buffer.from(attributes!.input!.payloads![0]!.data!).toString());
          return (input.item?.missionId ?? input.missionId) === sentinel.missionId;
        });
        return Boolean(scheduled && events.some(event => String(event.activityTaskCompletedEventAttributes?.scheduledEventId) === String(scheduled.eventId)));
      });
      expect(executed).toEqual(["agent_run:synthetic-1", "agent_run:synthetic-4"]);
      expect(finished).toEqual(expect.arrayContaining([
        expect.objectContaining({ missionId: "mission:synthetic-1", status: "INTERRUPTED", statusReason: "Stop running mission" }),
        expect.objectContaining({ missionId: "mission:synthetic-2", status: "INTERRUPTED", statusReason: "Stop queued mission" }),
        expect.objectContaining({ missionId: "mission:synthetic-4", status: "COMPLETED" })
      ]));
      expect(finished).toHaveLength(3);
      if (branch === "current") expect(discarded.sort()).toEqual(["mission:synthetic-1", "mission:synthetic-2"]);
      const events = (await history(first)).events ?? [];
      expect(events.filter(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(2);
      expect(events.some(event => event.requestCancelExternalWorkflowExecutionInitiatedEventAttributes)).toBe(true);
      await closeSupervisor(handle);
      await record(first, `supervisor-${branch}`);
    });
  }, 30_000);

  it("continues after exactly 50 processed turns with queued work and monitored missions intact", async () => {
    const turns = [item(10), item(11), item(12)];
    const executed: string[] = [];
    await sandbox(branch, {
      checkRoomAgentSupervisorTurn: async () => "READY",
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async () => undefined,
      finishRoomAgentSupervisorTurn: async () => undefined,
      runCodexAppServerTurn: async (turn: DummyTurnInput) => { executed.push(turn.agentRunId!); return verified; },
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" }),
      settleRoomAgentBackgroundMission: async () => false
    }, async ({ start, client, record }) => {
      const { first, handle } = await start({ roomId: "room:synthetic", pending: turns,
        processedCount: 48, monitoringMissionIds: ["mission:still-monitoring"] });
      const carried = await continuation(first);
      expect(carried.input).toEqual({ roomId: "room:synthetic", pending: [turns[2]], interrupted: [],
        processedCount: 0, monitoringMissionIds: ["mission:still-monitoring"] });
      expect(carried.events.filter(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(2);
      await waitUntil(() => executed.length === 3);
      const next = client.workflow.getHandle(handle.workflowId, carried.newRunId);
      await waitUntil(async () => ((await history(next)).events ?? []).some(event => event.childWorkflowExecutionCompletedEventAttributes));
      expect(executed).toEqual(["agent_run:synthetic-10", "agent_run:synthetic-11", "agent_run:synthetic-12"]);
      await record(first, `supervisor-${branch}-processed`);
    });
  }, 30_000);

  it("polls each second and continues at 250 polls, retaining only unfinished monitoring", async () => {
    const polled: Array<{ runId: string; missionId: string }> = [];
    const poll = (missionId: string) => {
      polled.push({ runId: Context.current().info.workflowExecution!.runId, missionId });
      return missionId === "mission:done";
    };
    await sandbox(branch, {
      prepareRoomAgentBackgroundContinuation: async ({ missionId }: { missionId: string }) => ({ state: poll(missionId) ? "DONE" : "WAITING" }),
      settleRoomAgentBackgroundMission: async ({ missionId }: { missionId: string }) => poll(missionId)
    }, async ({ start }) => {
      const { first, runId } = await start({ roomId: "room:synthetic", processedCount: 7,
        monitoringMissionIds: ["mission:done", "mission:waiting"] });
      const carried = await continuation(first);
      const firstPolls = polled.filter(poll => poll.runId === runId);
      expect(firstPolls.filter(poll => poll.missionId === "mission:done")).toHaveLength(1);
      expect(firstPolls.filter(poll => poll.missionId === "mission:waiting")).toHaveLength(250);
      const timers = carried.events.filter(event => event.timerStartedEventAttributes);
      expect(timers).toHaveLength(250);
      expect(timers.every(event => String(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === "1" &&
        !event.timerStartedEventAttributes!.startToFireTimeout!.nanos)).toBe(true);
      expect(carried.input).toEqual({ roomId: "room:synthetic", pending: [], interrupted: [],
        processedCount: branch === "legacy" ? 7 : 0, monitoringMissionIds: ["mission:waiting"] });
      const activityNames = carried.events.flatMap(event => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
      expect(new Set(activityNames)).toEqual(new Set([branch === "legacy"
        ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation"]));
    });
  }, 60_000);
});

it("carries pending, interrupted and monitored work together when interrupted work reaches the 50-item boundary", async () => {
  const firstStopped = { item: item(20), reason: "First queued stop" };
  const carriedStop = { item: item(21), reason: "Carried queued stop" };
  const pending = item(22);
  const discarded: string[] = [];
  const executed: string[] = [];
  await sandbox("current", {
    discardRoomAgentSupervisorTurn: async ({ item }: { item: RoomAgentSupervisorQueueItem }) => { discarded.push(item.missionId); },
    finishRoomAgentSupervisorTurn: async () => undefined,
    checkRoomAgentSupervisorTurn: async () => "READY",
    runCodexAppServerTurn: async (turn: DummyTurnInput) => { executed.push(turn.agentRunId!); return verified; },
    prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" })
  }, async ({ start, client, record }) => {
    const { handle, first } = await start({ roomId: "room:synthetic", pending: [pending],
      interrupted: [firstStopped, carriedStop], monitoringMissionIds: ["mission:still-monitoring"], processedCount: 49 });
    const carried = await continuation(first);
    expect(carried.input).toEqual({ roomId: "room:synthetic", pending: [pending], interrupted: [carriedStop],
      monitoringMissionIds: ["mission:still-monitoring"], processedCount: 0 });
    expect(carried.events.filter(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
    const next = client.workflow.getHandle(handle.workflowId, carried.newRunId);
    await waitUntil(async () => ((await history(next)).events ?? []).some(event => event.timerStartedEventAttributes));
    expect(discarded).toEqual(["mission:synthetic-20", "mission:synthetic-21"]);
    expect(executed).toEqual(["agent_run:synthetic-22"]);
    await record(first, "supervisor-interrupted-continuation");
  });
}, 30_000);

it("runs allocation, send and verification in one durable mission", async () => {
  const c = continuationFixture();
  const executed: DummyTurnInput[] = [];
  const finished: Parameters<typeof finishSupervisorTurn>[0][] = [];
  await sandbox("current", {
    ...storeActivities(c),
    finishRoomAgentSupervisorTurn: async (input: Parameters<typeof finishSupervisorTurn>[0]) => {
      finished.push(input); await finishSupervisorTurn(input, c.store);
    },
    runCodexAppServerTurn: async (turn: DummyTurnInput) => {
      executed.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      if (executed.length === 1) {
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return { ...verified, roomAgentOutcome: { ...verified.roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      return verified;
    }
  }, async ({ start, env }) => {
    await start({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
    await advanceUntil(env, () => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
    expect(executed).toHaveLength(2);
    expect(executed[0]!.prompt).toContain("Open CLI and Chat, then send a story");
    expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.status).toBe("COMPLETED");
  });
}, 30_000);

it.each([
  ["a plain child failure", "plain", "ROOM_AGENT_SUPERVISOR_FAILED"],
  ["a serialized Temporal timeout", "timeout", "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
  ["an application failure type", "application", "CODEX_APP_SERVER_TURN_TIMEOUT"]
])("persists %s as FAILED with its cause code", async (_, kind, errorCode) => {
  const c = continuationFixture();
  let prepared: RoomAgentSupervisorQueueItem | undefined;
  const finished: Parameters<typeof finishSupervisorTurn>[0][] = [];
  await sandbox("current", {
    ...storeActivities(c),
    prepareRoomAgentBackgroundContinuation: async (input: Parameters<typeof prepareBackgroundContinuation>[0]) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") prepared = result.item;
      return result;
    },
    finishRoomAgentSupervisorTurn: async (input: Parameters<typeof finishSupervisorTurn>[0]) => {
      finished.push(input); await finishSupervisorTurn(input, c.store);
    },
    runCodexAppServerTurn: async () => {
      if (kind === "timeout") {
        // The external dependency is stubbed, but its SDK timeout crosses the
        // actual activity and child-workflow failure serialization boundaries.
        throw ApplicationFailure.create({ message: "Synthetic dependency timed out", type: "Error", nonRetryable: true,
          cause: new TimeoutFailure("Synthetic timeout", undefined, TimeoutType.HEARTBEAT) });
      }
      throw ApplicationFailure.nonRetryable("Synthetic child failed", kind === "application" ? errorCode : "Error");
    }
  }, async ({ start }) => {
    const { first } = await start({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id], processedCount: 49 });
    await continuation(first);
    expect(prepared).toBeDefined();
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared!.turn.agentRunId)?.run)
      .toMatchObject({ status: "FAILED", errorCode });
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
    expect(finished).toEqual([expect.objectContaining({ status: "FAILED", errorCode })]);
  });
}, 45_000);

it.each(["stop", "follow-up"])("retires a continuation if %s arrives before preparation replies", async kind => {
  const c = continuationFixture();
  const reply = gate();
  let prepared: RoomAgentSupervisorQueueItem | undefined;
  const executed: DummyTurnInput[] = [];
  await sandbox("current", {
    ...storeActivities(c),
    prepareRoomAgentBackgroundContinuation: async (input: Parameters<typeof prepareBackgroundContinuation>[0]) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") { prepared = result.item; await reply.promise; }
      return result;
    },
    runCodexAppServerTurn: async (turn: DummyTurnInput) => {
      executed.push(turn); c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" }); return verified;
    }
  }, async ({ start, env }) => {
    const { handle } = await start({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
    try {
      await advanceUntil(env, () => prepared !== undefined);
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      reply.release();
      await waitUntil(() => c.store.getRoomAgentTurn(c.initial.mission.id, prepared!.turn.agentRunId)?.run.status === "INTERRUPTED");
      if (kind === "stop") expect(executed).toEqual([]);
      else {
        await waitUntil(() => executed.length === 1);
        expect(executed[0]!.roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
    } finally { reply.release(); }
  });
}, 30_000);

it("carries a prepared continuation into the next run and executes it once", async () => {
  const c = continuationFixture();
  const executed: string[] = [];
  await sandbox("current", {
    ...storeActivities(c),
    runCodexAppServerTurn: async (turn: DummyTurnInput) => {
      executed.push(turn.agentRunId!); c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" }); return verified;
    }
  }, async ({ start, record }) => {
    const { first } = await start({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id], processedCount: 50 });
    const carried = await continuation(first);
    expect(carried.input.pending).toHaveLength(1);
    expect(carried.events.filter(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toEqual([]);
    await waitUntil(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
    expect(executed).toEqual([carried.input.pending[0]!.turn.agentRunId]);
    await record(first, "supervisor-prepared-continuation");
  });
}, 30_000);

it("drains an oversized signalled queue until continue-as-new can carry every remaining item", async () => {
  const firstCheck = gate();
  let checking = false;
  let firstRunId: string;
  const checked: Array<{ runId: string; item: RoomAgentSupervisorQueueItem }> = [];
  const turns = Array.from({ length: 106 }, (_, index) => item(index));
  await sandbox("current", {
    checkRoomAgentSupervisorTurn: async (item: RoomAgentSupervisorQueueItem) => {
      checked.push({ runId: Context.current().info.workflowExecution!.runId, item });
      if (!checking) { checking = true; await firstCheck.promise; }
      return "SKIP";
    },
    discardRoomAgentSupervisorTurn: async () => undefined
  }, async ({ start }) => {
    const { handle, first, runId } = await start({ roomId: "room:synthetic", pending: turns.slice(0, 100), processedCount: 49 });
    firstRunId = runId;
    try {
      await waitUntil(() => checking);
      for (const next of turns.slice(100)) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, next);
      firstCheck.release();
      await waitUntil(() => checked.filter(check => check.runId === firstRunId).length >= 6);
      const carried = await continuation(first);
      const drained = checked.filter(check => check.runId === firstRunId).map(check => check.item);
      expect(drained).toHaveLength(6);
      expect(carried.input.pending).toHaveLength(100);
      expect([...drained, ...carried.input.pending].map(item => item.turn.agentRunId).sort())
        .toEqual(turns.map(item => item.turn.agentRunId).sort());
    } finally { firstCheck.release(); }
  });
}, 30_000);
