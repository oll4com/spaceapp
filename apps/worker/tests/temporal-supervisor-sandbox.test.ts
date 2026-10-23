import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, TimeoutFailure, TimeoutType, defaultPayloadConverter } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

// Only activities are replaced. The supervisor and its child execute from the
// production entry point inside Temporal's workflow isolate.
describe("room supervisor in the Temporal sandbox", { timeout: 30_000 }, () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let running: Promise<void>;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let sequence = 0;
  const taskQueue = `supervisor-sandbox-${randomUUID()}`;
  const handles: Array<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["getHandle"]>> = [];
  const releases: Array<() => void> = [];
  let check: ReturnType<typeof vi.fn>;
  let prepare: ReturnType<typeof vi.fn>;
  let discard: ReturnType<typeof vi.fn>;
  let finish: ReturnType<typeof vi.fn>;
  let turn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url))
    });
  }, 120_000);

  beforeEach(async () => {
    env = undefined!;
    worker = undefined!;
    running = undefined!;
    check = vi.fn(async () => "READY");
    prepare = vi.fn(async () => ({ state: "WAITING" }));
    discard = vi.fn(async () => undefined);
    finish = vi.fn(async () => undefined);
    turn = vi.fn(async () => verified());
    // Time skipping is global to a server. A fresh environment also isolates
    // locks held by activities that were outstanding when a prior run ended.
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: env.nativeConnection, taskQueue,
      workflowBundle,
      activities: {
        checkRoomAgentSupervisorTurn: (...args: unknown[]) => check(...args),
        prepareRoomAgentBackgroundContinuation: (...args: unknown[]) => prepare(...args),
        discardRoomAgentSupervisorTurn: (...args: unknown[]) => discard(...args),
        finishRoomAgentSupervisorTurn: (...args: unknown[]) => finish(...args),
        runCodexAppServerTurn: (...args: unknown[]) => turn(...args)
      }
    });
    running = worker.run();
    // Keep the rejection observable in teardown without an unhandled rejection
    // if a worker fails while a test is inspecting its history.
    void running.catch(() => undefined);
  }, 120_000);

  afterEach(async () => {
    try {
      for (const release of releases.splice(0)) release();
      for (const handle of handles.splice(0)) {
        await handle.terminate("Sandbox test complete").catch(() => undefined);
      }
      if (worker) worker.shutdown();
      if (running) await running;
    } finally {
      if (env) await env.teardown();
    }
  }, 30_000);

  function item(suffix: string, missionId = "mission:sandbox", automatic = false): RoomAgentSupervisorQueueItem {
    return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
      roomId: "room:sandbox", paneId: "pane:sandbox", prompt: `Request ${suffix}`,
      agentRunId: `agent_run:${sequence}-${suffix}`, traceId: `trace:${sequence}-${suffix}`,
      ...(automatic ? { roomAgentContinuation: { sourceRunId: "agent_run:source", generation: 1 } } : {})
    } });
  }

  function verified(pendingActionIds?: string[]) {
    return { status: "COMPLETED", message: "Verified", roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request.",
      ...(pendingActionIds ? { pendingActionIds } : {})
    } };
  }

  function storeDriver() {
    const c = continuationFixture();
    const prepared: RoomAgentSupervisorQueueItem[] = [];
    prepare = vi.fn(async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") prepared.push(result.item);
      return result;
    });
    check = vi.fn(input => supervisorTurnState(input, c.store));
    discard = vi.fn(({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode));
    finish = vi.fn(input => finishSupervisorTurn(input, c.store));
    turn = vi.fn(async input => {
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return verified();
    });
    const workflowInput = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
    return { ...c, prepared, workflowInput };
  }

  async function startStoreDriver(c: ReturnType<typeof storeDriver>, extra: Record<string, unknown> = {}) {
    const handle = await start({ ...c.workflowInput, ...extra });
    await waitForTimer(handle);
    await env.sleep("1 second");
    return handle;
  }

  async function start(input: Record<string, unknown> = {}) {
    sequence++;
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: `supervisor-sandbox-${randomUUID()}`, taskQueue,
      args: [roomAgentSupervisorInputSchema.parse({ roomId: "room:sandbox", ...input })]
    });
    handles.push(handle);
    return handle;
  }

  async function settled(assertion: () => void | Promise<void>) {
    await vi.waitFor(assertion, { timeout: 15_000, interval: 20 });
  }

  async function waitForTimer(handle: Awaited<ReturnType<typeof start>>, count = 1) {
    await settled(async () => {
      const history = await handle.fetchHistory();
      expect(history.events?.filter(event => event.timerStartedEventAttributes).length).toBeGreaterThanOrEqual(count);
    });
  }

  async function continued(handle: Awaited<ReturnType<typeof start>>) {
    let input: ReturnType<typeof roomAgentSupervisorInputSchema.parse> | undefined;
    await settled(async () => {
      // Pin the first run: getHandle without a run ID would follow the new run.
      const history = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      const event = history.events?.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
      expect(event).toBeDefined();
      const payload = event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
      input = roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(payload));
    });
    return input!;
  }

  it("accepts an enqueue signal, rejects foreign-room and duplicate turns, and runs the real child", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(() => release());
    check.mockImplementationOnce(async () => { await gate; return "READY"; });
    const handle = await start();
    const queued = item("signal");
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...queued, turn: { ...queued.turn, roomId: "room:other" } });
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
    await settled(() => expect(check).toHaveBeenCalledOnce());
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
    release();
    await settled(() => expect(finish).toHaveBeenCalledOnce());
    expect(turn).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ item: queued, status: "COMPLETED" }));
    const history = await handle.fetchHistory();
    expect(history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
  });

  it("uses one-second timers to retry PAUSED turns and discards SKIP turns", async () => {
    check.mockResolvedValueOnce("PAUSED").mockResolvedValueOnce("SKIP");
    const queued = item("paused");
    const handle = await start({ pending: [queued] });
    await settled(() => expect(check).toHaveBeenCalledOnce());
    await waitForTimer(handle);
    await env.sleep("1 second");
    await settled(() => expect(discard).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledTimes(2);
    expect(turn).not.toHaveBeenCalled();
    const history = await handle.fetchHistory();
    const timers = history.events?.filter(event => event.timerStartedEventAttributes);
    expect(timers?.some(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
  });

  it("polls background work after one second and executes allocation, send, verification in one mission", async () => {
    const c = storeDriver();
    turn.mockImplementationOnce(async input => {
      expect(input.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return verified(["action:send"]);
    });
    const handle = await startStoreDriver(c);
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    await waitForTimer(handle, 2);
    await env.sleep("1 second");
    await settled(() => expect(finish).toHaveBeenCalledOnce());
    await settled(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"));
    expect(turn.mock.calls.map(([input]) => input.agentRunId)).toEqual(c.prepared.map(item => item.turn.agentRunId));
    expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ item: c.prepared[1], status: "COMPLETED" }));
    const history = await handle.fetchHistory();
    expect(history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(2);
  });

  it.each(["stop", "follow-up"])("retires a prepared continuation when %s arrives before the activity reply", async kind => {
    const c = storeDriver();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(() => release());
    prepare.mockImplementationOnce(async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") c.prepared.push(result.item);
      await gate;
      return result;
    });
    const handle = await startStoreDriver(c);
    await settled(() => expect(c.prepared).toHaveLength(1));
    const automatic = c.prepared[0]!;
    if (kind === "stop") {
      c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
    } else {
      const followUp = c.enqueue("follow-up", "Only inspect the room.");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
    }
    release();
    await settled(() => expect(discard).toHaveBeenCalledWith(expect.objectContaining({ item: automatic })));
    await settled(() => expect(c.store.getRoomAgentTurn(c.initial.mission.id, automatic.turn.agentRunId)?.run.status).toBe("INTERRUPTED"));
    if (kind === "stop") expect(turn).not.toHaveBeenCalled();
    else {
      await settled(() => expect(turn).toHaveBeenCalledOnce());
      expect(turn.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
    }
  });

  it("cancels a running mission and drains a stopped queued turn", async () => {
    turn.mockImplementationOnce(async () => {
      // Real activity cancellation is delivered by the child workflow scope.
      Context.current().heartbeat();
      const heartbeat = setInterval(() => Context.current().heartbeat(), 50);
      try { await Context.current().cancelled; } finally { clearInterval(heartbeat); }
    });
    const active = item("active");
    const queued = item("queued", "mission:queued");
    const handle = await start({ pending: [active, queued] });
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Operator stopped everything" });
    await settled(() => expect(finish).toHaveBeenCalledTimes(2));
    expect(finish.mock.calls.map(([input]) => [input.item.missionId, input.status])).toEqual([
      [active.missionId, "INTERRUPTED"], [queued.missionId, "INTERRUPTED"]
    ]);
    expect(discard).toHaveBeenCalledTimes(2);
    expect(turn).toHaveBeenCalledOnce();
  });

  it("supersedes a running automatic continuation with an operator follow-up", async () => {
    let cancelled = false;
    turn.mockImplementationOnce(async () => {
      const heartbeat = setInterval(() => Context.current().heartbeat(), 50);
      try { await Context.current().cancelled; } finally { cancelled = true; clearInterval(heartbeat); }
    });
    const automatic = item("automatic", "mission:sandbox", true);
    const operator = item("operator");
    const handle = await start({ pending: [automatic] });
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, operator);
    await settled(() => expect(finish).toHaveBeenCalledOnce());
    expect(cancelled).toBe(true);
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ item: automatic, reason: "Superseded by a newer operator request." }));
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ item: operator, status: "COMPLETED" }));
  });

  it.each([
    ["plain failure", "Error", "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["application failure", "CODEX_APP_SERVER_TURN_TIMEOUT", "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ])("finishes a child %s as FAILED with its cause code", async (_label, type, code) => {
    const c = storeDriver();
    turn.mockImplementation(async () => { throw ApplicationFailure.nonRetryable("Child failed", type); });
    await startStoreDriver(c);
    await settled(() => expect(finish).toHaveBeenCalledOnce());
    const queued = c.prepared[0]!;
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ item: queued, status: "FAILED", errorCode: code }));
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ item: queued, errorCode: code }));
    await settled(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED"));
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, queued.turn.agentRunId)?.run).toMatchObject({ status: "FAILED", errorCode: code });
  });

  it("preserves a serialized Temporal timeout cause through the real activity and child failure chain", async () => {
    const c = storeDriver();
    turn.mockImplementation(async () => {
      throw ApplicationFailure.create({ message: "Transport failed", type: "Error", nonRetryable: true,
        cause: new TimeoutFailure("Turn timed out", undefined, TimeoutType.START_TO_CLOSE) });
    });
    await startStoreDriver(c);
    await settled(() => expect(finish).toHaveBeenCalledOnce());
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT" }));
    await settled(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED"));
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, c.prepared[0]!.turn.agentRunId)?.run).toMatchObject({ status: "FAILED", errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT" });
  });

  it("continues after 50 processed turns carrying pending, interrupted and monitored state", async () => {
    const stopped = item("stopped", "mission:stopped");
    const alsoStopped = item("also-stopped", "mission:also-stopped");
    const pending = item("carried");
    const handle = await start({ processedCount: 49, pending: [pending],
      interrupted: [{ item: stopped, reason: "Stopped before restart" }, { item: alsoStopped, reason: "Stop carried" }], monitoringMissionIds: ["mission:monitor"] });
    const carried = await continued(handle);
    expect(carried).toMatchObject({ processedCount: 0, pending: [pending], interrupted: [{ item: alsoStopped, reason: "Stop carried" }], monitoringMissionIds: ["mission:monitor"] });
    await recordWorkflowHistory(env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId), "supervisor-current-continue-as-new");
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    expect(turn.mock.calls[0]![0].agentRunId).toBe(pending.turn.agentRunId);
  });

  it("carries a prepared continuation at the 50-turn boundary and starts it once in the next run", async () => {
    const c = storeDriver();
    const handle = await startStoreDriver(c, { processedCount: 50 });
    const carried = await continued(handle);
    const automatic = c.prepared[0]!;
    expect(carried.pending).toEqual([automatic]);
    const firstRun = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
    const history = await firstRun.fetchHistory();
    expect(history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(0);
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    expect(turn.mock.calls[0]![0].agentRunId).toBe(automatic.turn.agentRunId);
    await settled(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"));
  });

  it("continues after 250 one-second monitoring polls retaining the mission", async () => {
    const handle = await start({ monitoringMissionIds: ["mission:monitor"] });
    // result() enables SDK-managed time skipping for the complete first run;
    // followRuns:false stops at continue-as-new instead of waiting forever on
    // this long-lived supervisor's next run.
    await expect(env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false })).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const carried = await continued(handle);
    expect(carried).toEqual(roomAgentSupervisorInputSchema.parse({ roomId: "room:sandbox", monitoringMissionIds: ["mission:monitor"] }));
    const history = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
    const timers = history.events?.filter(event => event.timerStartedEventAttributes) ?? [];
    expect(timers).toHaveLength(250);
    expect(timers.every(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
    expect(history.events?.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "prepareRoomAgentBackgroundContinuation")).toHaveLength(250);
    // The resumed run may already poll before the result waiter reacquires the
    // server's time-skipping lock; exact counts belong to the pinned history.
    expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(250);
  }, 60_000);

  it("defers continue-as-new while more than 100 queued turns would exceed input bounds", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(() => release());
    check.mockImplementationOnce(async () => { await gate; return "SKIP"; });
    check.mockResolvedValue("SKIP");
    const handle = await start({ processedCount: 49, pending: [item("initial")] });
    await settled(() => expect(check).toHaveBeenCalledOnce());
    const queued = Array.from({ length: 105 }, (_, index) => item(`flood-${index}`));
    for (const queuedItem of queued) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queuedItem);
    release();
    const carried = await continued(handle);
    expect(carried.pending).toEqual(queued.slice(5));
    expect(carried.pending).toHaveLength(100);
    const history = await env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
    const checks = history.events?.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
    expect(checks).toHaveLength(6);
  }, 60_000);
});
