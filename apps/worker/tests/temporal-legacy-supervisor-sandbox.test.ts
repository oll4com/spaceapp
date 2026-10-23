import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

// This recorder removes only the entry selector's patch call, preserving the
// production legacy implementation and every Temporal API. Histories are then
// replayed by the separate replay suite against unmodified production code.
describe("legacy room supervisor in the real Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let running: Promise<void>;
  let environmentActive = false;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  const taskQueue = `legacy-supervisor-${randomUUID()}`;
  const handles: Array<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["getHandle"]>> = [];
  const releases: Array<() => void> = [];
  let started: ReturnType<typeof vi.fn>;
  let finished: ReturnType<typeof vi.fn>;
  let continuedMission: ReturnType<typeof vi.fn>;
  let settle: ReturnType<typeof vi.fn>;
  let turn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
    workflowBundle = await bundleWorkflowCode({
      workflowsPath,
      webpackConfigHook(config) {
        config.module ??= {};
        config.module.rules ??= [];
        config.module.rules.push({
          test: /workflows\.ts$/,
          include: workflowsPath,
          enforce: "pre",
          use: [fileURLToPath(new URL("./support/legacy-supervisor-loader.cjs", import.meta.url))]
        });
        return config;
      }
    });
  }, 120_000);

  beforeEach(async () => {
    started = vi.fn(async () => undefined);
    finished = vi.fn(async () => undefined);
    continuedMission = vi.fn(async () => undefined);
    settle = vi.fn(async () => false);
    turn = vi.fn(async () => verified());
    // A terminated workflow can retain test-server activity time locks (SDK
    // Java #1138). Each case gets a fresh clock; the bundle is compiled once.
    env = await TestWorkflowEnvironment.createTimeSkipping();
    environmentActive = true;
    worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowBundle,
      activities: {
        markRoomAgentMissionStarted: (...args: unknown[]) => started(...args),
        markRoomAgentMissionFinished: (...args: unknown[]) => finished(...args),
        markRoomAgentMissionContinued: (...args: unknown[]) => continuedMission(...args),
        settleRoomAgentBackgroundMission: (...args: unknown[]) => settle(...args),
        runCodexAppServerTurn: (...args: unknown[]) => turn(...args)
      }
    });
    running = worker.run();
    void running.catch(() => undefined);
  }, 120_000);

  afterEach(async () => {
    try {
      for (const release of releases.splice(0)) release();
      for (const handle of handles.splice(0)) {
        await handle.terminate("Legacy sandbox test complete").catch(() => undefined);
      }
      if (worker?.getState() === "RUNNING") worker.shutdown();
      if (running) await running;
    } finally {
      if (environmentActive) {
        environmentActive = false;
        await env.teardown();
      }
    }
  }, 30_000);

  function item(suffix: string, missionId = `mission:${suffix}`): RoomAgentSupervisorQueueItem {
    return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
      roomId: "room:legacy-sandbox", paneId: "pane:legacy-sandbox", prompt: `Request ${suffix}`,
      agentRunId: `agent_run:${suffix}`, traceId: `trace:${suffix}`
    } });
  }

  function verified(pendingActionIds?: string[]) {
    return { status: "COMPLETED", message: "Verified", roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1, statusReason: "Verified room request.",
      ...(pendingActionIds ? { pendingActionIds } : {})
    } };
  }

  async function start(input: Record<string, unknown> = {}) {
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: `legacy-supervisor:${randomUUID()}`, taskQueue,
      args: [roomAgentSupervisorInputSchema.parse({ roomId: "room:legacy-sandbox", ...input })]
    });
    handles.push(handle);
    return handle;
  }

  const settled = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 15_000, interval: 20 });

  async function waitForTimer(handle: Awaited<ReturnType<typeof start>>, count: number) {
    await settled(async () => {
      const history = await handle.fetchHistory();
      expect(history.events?.filter(event => event.timerStartedEventAttributes).length).toBeGreaterThanOrEqual(count);
    });
  }

  async function firstRunContinued(handle: Awaited<ReturnType<typeof start>>) {
    const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
    // result() unlocks time skipping, so 250 actual timer/activity cycles can
    // execute without a wall-clock wait or replacing the workflow clock.
    await expect(first.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const history = await first.fetchHistory();
    const event = history.events?.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
    expect(event).toBeDefined();
    expect(history.events?.filter(event => event.markerRecordedEventAttributes)).toHaveLength(0);
    const payload = event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
    return { first, history, input: roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(payload)) };
  }

  it("uses the legacy boolean settle result to keep polling until background work finishes", async () => {
    settle.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const handle = await start({ monitoringMissionIds: ["mission:boolean"] });
    for (let poll = 1; poll <= 3; poll++) {
      await waitForTimer(handle, poll);
      await env.sleep("1 second");
      await settled(() => expect(settle).toHaveBeenCalledTimes(poll));
    }
    await env.sleep("10 seconds");
    expect(settle).toHaveBeenCalledTimes(3);
    expect(settle).toHaveBeenLastCalledWith({ roomId: "room:legacy-sandbox", missionId: "mission:boolean" });
    expect(turn).not.toHaveBeenCalled();
    const history = await handle.fetchHistory();
    expect(history.events?.filter(event => event.timerStartedEventAttributes)).toHaveLength(3);
    expect(history.events?.filter(event => event.markerRecordedEventAttributes)).toHaveLength(0);
  }, 30_000);

  it("retries one transiently failing settlement activity through its fifth attempt before accepting true", async () => {
    const attempts: number[] = [];
    settle.mockImplementation(async () => {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      if (attempt < 5) throw new Error("Synthetic temporary settlement failure");
      return true;
    });
    const handle = await start({ monitoringMissionIds: ["mission:retry-settle"] });
    await waitForTimer(handle, 1);
    await env.sleep("1 minute");
    await settled(() => expect(attempts).toEqual([1, 2, 3, 4, 5]));
    const history = await handle.fetchHistory();
    // Server-side retries belong to one activity, rather than five polls.
    expect(history.events?.filter(event => event.timerStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.filter(event =>
      event.activityTaskScheduledEventAttributes?.activityType?.name === "settleRoomAgentBackgroundMission")).toHaveLength(1);
    expect(history.events?.filter(event => event.activityTaskCompletedEventAttributes)).toHaveLength(1);
    expect(turn).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    ["CODEX_APP_SERVER_TURN_TIMEOUT", "CODEX_APP_SERVER_TURN_TIMEOUT"],
    ["unsafe provider error text", "ROOM_AGENT_SUPERVISOR_FAILED"]
  ])("records a failed real child with safe mission error code for %s", async (type, errorCode) => {
    turn.mockImplementation(async () => {
      throw ApplicationFailure.nonRetryable("Synthetic child failure", type);
    });
    const queued = item("child-failure");
    const handle = await start({ pending: [queued] });
    await settled(() => expect(finished).toHaveBeenCalledExactlyOnceWith({
      missionId: queued.missionId, roomId: queued.turn.roomId, status: "FAILED",
      statusReason: "Room agent child workflow failed.", errorCode
    }));
    expect(turn).toHaveBeenCalledOnce();
    expect(continuedMission).not.toHaveBeenCalled();
    const history = await handle.fetchHistory();
    expect(history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
    expect(history.events?.filter(event => event.childWorkflowExecutionFailedEventAttributes)).toHaveLength(1);
  }, 30_000);

  it("continues at 50 processed turns carrying pending and monitored missions", async () => {
    const firstItem = item("boundary-first");
    const carriedItem = item("boundary-carried");
    turn.mockResolvedValueOnce(verified(["action:pending"]));
    const handle = await start({ processedCount: 49, pending: [firstItem, carriedItem], monitoringMissionIds: ["mission:existing"] });
    const continued = await firstRunContinued(handle);
    expect(continued.input).toEqual(roomAgentSupervisorInputSchema.parse({
      roomId: "room:legacy-sandbox", pending: [carriedItem], processedCount: 0,
      interrupted: [], monitoringMissionIds: ["mission:existing", firstItem.missionId]
    }));
    expect(continued.history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
    await recordWorkflowHistory(continued.first, "supervisor-legacy-continue-as-new");
    await settled(() => expect(started).toHaveBeenCalledWith({
      missionId: carriedItem.missionId, roomId: carriedItem.turn.roomId, paneId: carriedItem.turn.paneId
    }));
    expect(continuedMission).toHaveBeenCalledWith(expect.objectContaining({ missionId: firstItem.missionId }));
  }, 30_000);

  it("continues after 250 real one-second monitoring polls with the boolean contract", async () => {
    const handle = await start({ processedCount: 7, monitoringMissionIds: ["mission:monitor"] });
    const continued = await firstRunContinued(handle);
    expect(continued.input).toEqual(roomAgentSupervisorInputSchema.parse({
      roomId: "room:legacy-sandbox", processedCount: 7, monitoringMissionIds: ["mission:monitor"]
    }));
    const timers = continued.history.events?.filter(event => event.timerStartedEventAttributes) ?? [];
    expect(timers).toHaveLength(250);
    expect(timers.every(event => Number(event.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
    const settlements = continued.history.events?.filter(event =>
      event.activityTaskScheduledEventAttributes?.activityType?.name === "settleRoomAgentBackgroundMission");
    expect(settlements).toHaveLength(250);
    // The exact count belongs to the pinned history; the next run may already
    // be polling when the server delivers the first run's terminal event.
    expect(settle.mock.calls.length).toBeGreaterThanOrEqual(250);
    expect(turn).not.toHaveBeenCalled();
  }, 120_000);

  it("accepts enqueue signals and stops the active child and one deduplicated pending turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    turn.mockImplementationOnce(async () => {
      Context.current().heartbeat();
      const heartbeat = setInterval(() => Context.current().heartbeat(), 50);
      try { await Context.current().cancelled; } finally { clearInterval(heartbeat); }
    });
    started.mockImplementationOnce(async () => { await gate; });
    const active = item("active");
    const queued = item("queued");
    const handle = await start();
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...queued, turn: { ...queued.turn, roomId: "room:foreign" } });
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, active);
    await settled(() => expect(started).toHaveBeenCalledOnce());
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
    release();
    await settled(() => expect(turn).toHaveBeenCalledOnce());
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Operator stopped legacy missions" });
    await settled(() => expect(finished).toHaveBeenCalledTimes(2));
    expect(finished.mock.calls.map(([input]) => [input.missionId, input.status, input.statusReason])).toEqual([
      [active.missionId, "INTERRUPTED", "Operator stopped legacy missions"],
      [queued.missionId, "INTERRUPTED", "Operator stopped legacy missions"]
    ]);
    expect(started).toHaveBeenCalledOnce();
    expect(turn).toHaveBeenCalledOnce();
    const history = await handle.fetchHistory();
    expect(history.events?.filter(event => event.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
  }, 30_000);
});
