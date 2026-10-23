/**
 * Sandbox tests for roomAgentSupervisorWorkflow (continuing + legacy
 * branches) on a real time-skipping test server.
 *
 * The workflow code runs unmocked inside the Temporal workflow sandbox. The
 * child turn workflow (codexAppServerTurnWorkflow) also runs for real; only
 * activities are stubs. Supervisor store-backed activities
 * (prepare/check/discard/finish) delegate to the real lib functions in
 * room-background-continuation.ts bound to an InMemorySpaceStore fixture --
 * the same pattern as the mocked room-supervisor-continuation.test.ts, whose
 * key assertions (carry bound, continuation carry, legacy boolean settle)
 * are covered here against the real server.
 *
 * The supervisor workflow never returns (Promise<never>); tests observe side
 * effects / history, then terminate the run.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowHandle } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema
} from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { cancellableGate, createWorkflowStubs, deferred, type WorkflowStubs } from "./support/workflow-stubs.js";

let tenv: TemporalTestEnv;
let stubs: WorkflowStubs;

beforeAll(async () => {
  stubs = createWorkflowStubs();
  tenv = await createTemporalTestEnv(testWorkflowsPath(), stubs.activities);
}, 240_000);

afterAll(async () => {
  await tenv.teardown();
}, 120_000);

beforeEach(() => {
  stubs.reset();
  stubs.clearCalls();
  stubs.setSupervisorStore(undefined);
});

const CONTINUED_AS_NEW = temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW;

/**
 * Handles returned by `start()` follow the run chain (by design), so
 * describe()/fetchHistory() would follow into the continued run. These
 * helpers bind to the first run via firstExecutionRunId to observe the
 * continue-as-new itself.
 */
type StartedHandle = WorkflowHandle & { firstExecutionRunId: string };

function firstRunHandle(handle: StartedHandle): WorkflowHandle {
  return tenv.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
}

async function waitForContinuedAsNew(handle: StartedHandle, timeoutMs = 180_000): Promise<void> {
  const runHandle = firstRunHandle(handle);
  const startedAt = Date.now();
  for (;;) {
    const description = await runHandle.describe();
    if (description.status.name !== "RUNNING") {
      expect(description.status.name).toBe("CONTINUED_AS_NEW");
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for continue-as-new.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Decodes the input of the WorkflowExecutionContinuedAsNew history event. */
async function continuedAsNewInput(handle: StartedHandle): Promise<any> {
  const history = await firstRunHandle(handle).fetchHistory();
  const event = history.events?.find((e) => e.eventType === CONTINUED_AS_NEW);
  expect(event).toBeDefined();
  const payloads = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads ?? [];
  const [input] = await Promise.all(payloads.map((payload) => defaultPayloadConverter.fromPayload(payload)));
  return input;
}

async function terminateLatestRun(workflowId: string, reason: string): Promise<void> {
  await tenv.client.workflow.getHandle(workflowId).terminate(reason);
}

const verifiedTurnResult = (input: { roomId: string; paneId: string; traceId: string }) => ({
  workflowId: `turn:${input.traceId}`,
  roomId: input.roomId,
  paneId: input.paneId,
  traceId: input.traceId,
  status: "COMPLETED" as const,
  message: "Verified",
  roomAgentOutcome: { status: "VERIFIED", statusReason: "Verified remaining request." }
});

// NOTE: this test runs first on purpose. The test server grants exactly one
// effective time-skipping period per server: once any workflow execution
// closes, unlockTimeSkipping() stops taking effect. The 250 one-second polls
// below need skipping, so this must run before any other workflow closes.
it("continues as new after 250 monitoring polls and carries the monitoring set", async () => {
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: "room:mon-test",
    pending: [],
    monitoringMissionIds: ["mission:mon-250"],
    interrupted: [],
    processedCount: 0
  });
  const workflowId = "room-supervisor-continue-250-test";
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  // prepare always reports WAITING; the 250 one-second polls need time skipping.
  await tenv.unlockTimeSkipping();
  try {
    await waitForContinuedAsNew(handle);
    const carried = await continuedAsNewInput(handle);
    expect(carried.monitoringMissionIds).toEqual(["mission:mon-250"]);
    expect(carried.processedCount).toBe(0);
    expect(carried.pending).toEqual([]);
    // One prepare call per poll, 250 polls before continueAsNew. The new run
    // may already be polling again, so only a lower bound is asserted.
    expect(stubs.callCount("prepareRoomAgentBackgroundContinuation")).toBeGreaterThanOrEqual(250);
  } finally {
    await tenv.lockTimeSkipping();
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 240_000);

it("runs an enqueued mission through the real child workflow to COMPLETED", async () => {
  const c = continuationFixture();
  stubs.setSupervisorStore(c.store);
  stubs.set("runCodexAppServerTurn", verifiedTurnResult);
  const item = c.enqueue("sup-t1", "Inspect the room and report.").queueItem;
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: c.room.id,
    pending: [item],
    monitoringMissionIds: [],
    interrupted: [],
    processedCount: 0
  });
  const workflowId = `room-supervisor-enqueue-${c.room.id}`;
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  try {
    await stubs.waitForCalls("finishRoomAgentSupervisorTurn", 1);
    const finishCall = stubs.lastCall("finishRoomAgentSupervisorTurn")![0] as { status: string; statusReason: string };
    expect(finishCall.status).toBe("COMPLETED");
    // The real finish lib marked the mission completed in the store.
    expect(c.store.getRoomAgentMission(c.room.id, item.missionId)?.status).toBe("COMPLETED");
    // The child turn workflow really ran on the test server.
    expect(stubs.callCount("runCodexAppServerTurn")).toBe(1);
  } finally {
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 180_000);

it("interrupts the running mission when the stop signal arrives", async () => {
  const c = continuationFixture();
  stubs.setSupervisorStore(c.store);
  const gate = deferred<void>();
  stubs.set("runCodexAppServerTurn", async () => {
    await cancellableGate(gate.promise);
    return verifiedTurnResult({ roomId: c.room.id, paneId: c.pane.id, traceId: "trace:sup-stop" });
  });
  const item = c.enqueue("sup-t2", "A long inspection.").queueItem;
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: c.room.id,
    pending: [item],
    monitoringMissionIds: [],
    interrupted: [],
    processedCount: 0
  });
  const workflowId = `room-supervisor-stop-${c.room.id}`;
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  try {
    // The child turn is blocked inside its activity; now stop the mission.
    await stubs.waitForCalls("runCodexAppServerTurn", 1);
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop it" });
    await stubs.waitForCalls("finishRoomAgentSupervisorTurn", 1);
    const finishCall = stubs.lastCall("finishRoomAgentSupervisorTurn")![0] as { status: string; statusReason: string };
    expect(finishCall.status).toBe("INTERRUPTED");
    expect(finishCall.statusReason).toBe("Stop it");
    expect(c.store.getRoomAgentMission(c.room.id, item.missionId)?.status).toBe("INTERRUPTED");
  } finally {
    gate.resolve();
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 180_000);

it("keeps polling monitoring missions every second while prepare reports WAITING", async () => {
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: "room:poll-test",
    pending: [],
    monitoringMissionIds: ["mission:poll-1"],
    interrupted: [],
    processedCount: 0
  });
  const workflowId = "room-supervisor-poll-test";
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  try {
    // Real-time 1s polls: prepare must be called repeatedly and the workflow
    // must stay alive (no continueAsNew after a couple of polls).
    await stubs.waitForCalls("prepareRoomAgentBackgroundContinuation", 2, 30_000);
    expect((await handle.describe()).status.name).toBe("RUNNING");
    expect(stubs.callCount("prepareRoomAgentBackgroundContinuation")).toBeGreaterThanOrEqual(2);
  } finally {
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 180_000);

it("continues as new at 50 processed items and carries the state into the new run", async () => {
  const item = roomAgentSupervisorQueueItemSchema.parse({
    missionId: "mission:skip-50",
    turn: {
      roomId: "room:skip-test",
      paneId: "pane:skip-test",
      prompt: "A superseded request.",
      agentRunId: "agent_run:skip-0",
      traceId: "trace:skip-0"
    }
  });
  stubs.set("checkRoomAgentSupervisorTurn", async () => "SKIP");
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: "room:skip-test",
    pending: [item],
    monitoringMissionIds: [],
    interrupted: [],
    processedCount: 49
  });
  const workflowId = "room-supervisor-continue-50-test";
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  try {
    await waitForContinuedAsNew(handle);
    const carried = await continuedAsNewInput(handle);
    expect(carried.roomId).toBe("room:skip-test");
    expect(carried.pending).toEqual([]);
    expect(carried.interrupted).toEqual([]);
    expect(carried.monitoringMissionIds).toEqual([]);
    // The new run restarts the processed counter.
    expect(carried.processedCount).toBe(0);
    expect(stubs.callCount("checkRoomAgentSupervisorTurn")).toBe(1);
    expect(stubs.callCount("discardRoomAgentSupervisorTurn")).toBe(1);
  } finally {
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 180_000);

it("defers continueAsNew until the carried queue fits the 100-item input bound", async () => {
  const roomId = "room:carry-bound";
  const carryItem = (index: number) =>
    roomAgentSupervisorQueueItemSchema.parse({
      missionId: "mission:carry-bound",
      turn: {
        roomId,
        paneId: "pane:carry-bound",
        prompt: `Queued request ${index}`,
        artifactIds: [],
        agentRunId: `agent_run:carry-${String(index).padStart(3, "0")}`,
        permissionMode: null,
        collaborationMode: "default",
        traceId: `trace:carry-${index}`
      }
    });
  const workflowId = "room-supervisor-carry-bound-test";
  let handle!: StartedHandle;
  let checkCalls = 0;
  stubs.set("checkRoomAgentSupervisorTurn", async () => {
    checkCalls += 1;
    if (checkCalls === 1) {
      // Flood the queue while the first check is in flight, like the mocked test.
      for (let index = 1; index <= 105; index += 1) {
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, carryItem(index));
      }
    }
    return "SKIP";
  });
  const input = roomAgentSupervisorInputSchema.parse({ roomId, pending: [carryItem(0)], processedCount: 49 });
  handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  try {
    await waitForContinuedAsNew(handle);
    const carried = await continuedAsNewInput(handle);
    // 106 queued, drained to the 100-item bound before continuing as new.
    expect(carried.pending).toHaveLength(100);
    expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();
    // Six SKIPped turns drained in this run; none were dropped.
    expect(checkCalls).toBe(6);
    expect(stubs.callCount("discardRoomAgentSupervisorTurn")).toBe(6);
  } finally {
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 240_000);

it("carries a prepared continuation through continueAsNew and starts it once", async () => {
  // Belt and suspenders: run 2 of this scenario idles with no timers, and an
  // unlocked test server would skip past its execution timeout. The 250-poll
  // test above locks before finishing, but make it explicit here.
  await tenv.lockTimeSkipping();
  const c = continuationFixture();
  stubs.setSupervisorStore(c.store);
  stubs.set("runCodexAppServerTurn", verifiedTurnResult);
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: c.room.id,
    pending: [],
    monitoringMissionIds: [c.initial.mission.id],
    interrupted: [],
    processedCount: 50
  });
  const workflowId = `room-supervisor-continuation-carry-${c.room.id}`;
  const handle = await tenv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  // No time-skipping unlock here: run 1 needs a single 1s poll, and an
  // unlocked idle run 2 would skip past the 10-year execution timeout.
  try {
    await waitForContinuedAsNew(handle);
    const carried = await continuedAsNewInput(handle);
    // The prepared continuation item is carried into the new run.
    expect(carried.pending).toHaveLength(1);
    expect(carried.pending[0].turn.roomAgentContinuation).toBeDefined();
    expect(carried.monitoringMissionIds).toEqual([c.initial.mission.id]);
    // The new run starts the carried continuation exactly once and finishes it.
    await stubs.waitForCalls("runCodexAppServerTurn", 1);
    await stubs.waitForCalls("finishRoomAgentSupervisorTurn", 1);
    expect(stubs.callCount("runCodexAppServerTurn")).toBe(1);
    const childInput = stubs.lastCall("runCodexAppServerTurn")![0] as { traceId: string };
    expect(childInput.traceId).toMatch(/^trace:bg-/);
    const finishCall = stubs.lastCall("finishRoomAgentSupervisorTurn")![0] as { status: string };
    expect(finishCall.status).toBe("COMPLETED");
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
  } finally {
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 240_000);
