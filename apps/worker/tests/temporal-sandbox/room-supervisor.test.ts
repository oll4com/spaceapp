/**
 * roomAgentSupervisorWorkflow on the real time-skipping test server
 * (issue #60): enqueue/stop signals, one-second polling loops, interrupting
 * a running mission, continueAsNew with carried state, and both the current
 * (patched) and the pre-patch branches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL } from "@space/contracts";
import { ActivityStubs, buildActivities, makeGate } from "./activity-stubs.js";
import { supervisorInput, supervisorQueueItem, turnWorkflowResult } from "./stubs.js";
import {
  createSandboxEnv,
  MAIN_TASK_QUEUE,
  waitForRunIdChange,
  type SandboxEnv
} from "./sandbox.js";

const LEGACY_TASK_QUEUE = MAIN_TASK_QUEUE + "-legacy";

const stubs = new ActivityStubs();
let env: SandboxEnv;

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
  // A worker with the test-only pre-patch supervisor copy, so a marker-less
  // (legacy) execution can be produced and exercised live.
  const { buildWorkflowBundle, legacySupervisorEntry } = await import("./sandbox.js");
  await env.startWorker(LEGACY_TASK_QUEUE, buildActivities(stubs), await buildWorkflowBundle(legacySupervisorEntry()));
}, 120000);

beforeEach(() => stubs.reset());

afterAll(async () => {
  await env.teardown();
}, 60000);

function startSupervisor(workflowId: string, input: unknown, taskQueue = MAIN_TASK_QUEUE) {
  return env.testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue,
    workflowId,
    args: [input]
  });
}

describe("roomAgentSupervisorWorkflow (current patched branch)", () => {
  it("runs an enqueued mission end to end", async () => {
    const roomId = "room-sup-01";
    const item = supervisorQueueItem(roomId, "mission-0001", "a");

    const handle = await startSupervisor("sup-test-01", supervisorInput(roomId));
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);

    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.count("checkRoomAgentSupervisorTurn")).toBe(1);
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[0]).toMatchObject({ missionId: "mission-0001" });
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0001" },
      status: "COMPLETED"
    });
    expect(stubs.count("discardRoomAgentSupervisorTurn")).toBe(0);

    await handle.cancel();
  }, 60000);

  it("moves a pending mission to the interrupted queue on a stop signal instead of running it", async () => {
    const roomId = "room-sup-02";
    const item1 = supervisorQueueItem(roomId, "mission-0002", "b");
    const item2 = supervisorQueueItem(roomId, "mission-0003", "c");
    const gate = makeGate();
    stubs.override("checkRoomAgentSupervisorTurn", async (input) => {
      if (input.missionId === "mission-0002") await gate.promise;
      return "READY";
    });

    const handle = await startSupervisor("sup-test-02", supervisorInput(roomId, { pending: [item1, item2] }));
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0003", reason: "Synthetic operator stop." });
    gate.open();

    await stubs.waitForCall("finishRoomAgentSupervisorTurn", 2);
    const finishCalls = stubs.callsOf("finishRoomAgentSupervisorTurn");
    expect(finishCalls[0]).toMatchObject({ item: { missionId: "mission-0002" }, status: "COMPLETED" });
    expect(finishCalls[1]).toMatchObject({ item: { missionId: "mission-0003" }, status: "INTERRUPTED", statusReason: "Synthetic operator stop." });
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0003" },
      reason: "Synthetic operator stop."
    });

    await handle.cancel();
  }, 60000);

  it("interrupts a running mission on a stop signal and marks it INTERRUPTED", async () => {
    const roomId = "room-sup-03";
    const item = supervisorQueueItem(roomId, "mission-0004", "d");
    const gate = makeGate();
    // Hold the turn activity open until the test releases it. A never-settling
    // activity would orphan a pending record on the test server and stop all
    // further time skipping, so the stub always completes instead.
    stubs.override("runCodexAppServerTurn", async (input) => {
      await gate.promise;
      return turnWorkflowResult(input, {
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic room-agent turn verified." }
      });
    });

    const handle = await startSupervisor("sup-test-03", supervisorInput(roomId, { pending: [item] }));
    await stubs.waitForCall("runCodexAppServerTurn");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0004", reason: "Synthetic operator interruption." });
    gate.open();

    await stubs.waitForCall("discardRoomAgentSupervisorTurn");
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0004" },
      status: "INTERRUPTED",
      statusReason: "Synthetic operator interruption."
    });
    expect(stubs.callsOf("discardRoomAgentSupervisorTurn")[0]).toMatchObject({
      item: { missionId: "mission-0004" },
      reason: "Synthetic operator interruption."
    });

    await handle.cancel();
  }, 60000);


  it("re-queues a paused turn and re-checks it after the one-second wait", async () => {
    const roomId = "room-sup-04";
    const item = supervisorQueueItem(roomId, "mission-0005", "e");
    const states = ["PAUSED", "READY"];
    stubs.override("checkRoomAgentSupervisorTurn", (_input, index) => states[index]);

    const handle = await startSupervisor("sup-test-04", supervisorInput(roomId, { pending: [item] }));

    await stubs.waitForCall("checkRoomAgentSupervisorTurn", 2);
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({ status: "COMPLETED" });

    await handle.cancel();
  }, 60000);

  it("prepares a monitored background continuation on the one-second poll loop and runs it", async () => {
    const roomId = "room-sup-05";
    const continuation = supervisorQueueItem(roomId, "mission-0006", "f");
    continuation.turn.roomAgentContinuation = { sourceRunId: "agent_run:room-sup-05-src", generation: 1 };
    stubs.override("prepareRoomAgentBackgroundContinuation", () => ({ state: "READY", item: continuation }));

    const handle = await startSupervisor("sup-test-05", supervisorInput(roomId, { monitoringMissionIds: ["mission-0006"] }));

    await stubs.waitForCall("prepareRoomAgentBackgroundContinuation");
    await stubs.waitForCall("checkRoomAgentSupervisorTurn");
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[0]).toMatchObject({ missionId: "mission-0006" });
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    expect(stubs.callsOf("finishRoomAgentSupervisorTurn")[0]).toMatchObject({ item: { missionId: "mission-0006" }, status: "COMPLETED" });

    await handle.cancel();
  }, 60000);

  it("continues as a new run with carried state after 50 processed missions", async () => {
    const roomId = "room-sup-06";
    const item1 = supervisorQueueItem(roomId, "mission-0007", "g");
    const item2 = supervisorQueueItem(roomId, "mission-0008", "h");

    const handle = await startSupervisor("sup-test-06", supervisorInput(roomId, { pending: [item1], processedCount: 49 }));
    // Capture the run id before the first turn: the continueAsNew after the
    // 50th processed mission can happen before waitForCall resolves.
    const firstRunId = (await handle.describe()).runId;
    await stubs.waitForCall("finishRoomAgentSupervisorTurn");
    await waitForRunIdChange(handle, firstRunId, 30000);

    // The continued run keeps working: enqueue another mission and watch it run.
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item2);
    await stubs.waitForCall("checkRoomAgentSupervisorTurn", 2);
    expect(stubs.callsOf("checkRoomAgentSupervisorTurn")[1]).toMatchObject({ missionId: "mission-0008" });

    await handle.cancel();
  }, 90000);

  it("continues as a new run after 250 monitoring polls", async () => {
    const roomId = "room-sup-07";
    stubs.override("prepareRoomAgentBackgroundContinuation", () => ({ state: "WAITING" }));

    const handle = await startSupervisor("sup-test-07", supervisorInput(roomId, { monitoringMissionIds: ["mission-0009"] }));
    const firstRunId = (await handle.describe()).runId;


    // Each monitoring poll waits one second of server time; drive the clock
    // forward until the 250-poll budget continues the run as a new one.
    for (let i = 0; i < 30; i++) {
      await env.testEnv.sleep("10 seconds");
      if ((await handle.describe()).runId !== firstRunId) break;
    }
    expect(stubs.count("prepareRoomAgentBackgroundContinuation")).toBeGreaterThanOrEqual(250);

    await handle.cancel();
  }, 180000);
});

describe("roomAgentSupervisorWorkflow (pre-patch branch)", () => {
  it("finishes a completed mission and interrupts a stopped pending mission like a pre-patch execution", async () => {
    const roomId = "room-sup-08";
    const item1 = supervisorQueueItem(roomId, "mission-0010", "i");
    const item2 = supervisorQueueItem(roomId, "mission-0011", "j");
    const gate = makeGate();
    stubs.override("markRoomAgentMissionStarted", async (input) => {
      if (input.missionId === "mission-0010") await gate.promise;
      return null;
    });

    const handle = await startSupervisor("sup-test-08-legacy", supervisorInput(roomId, { pending: [item1, item2] }), LEGACY_TASK_QUEUE);
    await stubs.waitForCall("markRoomAgentMissionStarted");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission-0011", reason: "Synthetic legacy stop." });
    gate.open();

    await stubs.waitForCall("markRoomAgentMissionFinished", 2);
    const finished = stubs.callsOf("markRoomAgentMissionFinished");
    expect(finished[0]).toMatchObject({ missionId: "mission-0010", status: "COMPLETED" });
    expect(finished[1]).toMatchObject({ missionId: "mission-0011", status: "INTERRUPTED", statusReason: "Synthetic legacy stop." });
    expect(stubs.count("discardRoomAgentSupervisorTurn")).toBe(0);

    await handle.cancel();
  }, 60000);
});
