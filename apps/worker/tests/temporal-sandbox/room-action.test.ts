/**
 * roomAgentActionWorkflow on the real time-skipping test server
 * (issue #60), including the room-background-action-failure-v1 failure
 * path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActivityStubs, blockUntilCancelled, buildActivities } from "./activity-stubs.js";
import { roomActionBridgeRequest } from "./stubs.js";
import { createSandboxEnv, MAIN_TASK_QUEUE, type SandboxEnv } from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
}, 120000);

beforeEach(() => stubs.reset());

afterAll(async () => {
  await env.teardown();
}, 60000);

function startAction(workflowId: string, roomId: string, missionId: string, actionId?: string) {
  return env.testEnv.client.workflow.start("roomAgentActionWorkflow", {
    taskQueue: MAIN_TASK_QUEUE,
    workflowId,
    args: [{ actionId, bridge: roomActionBridgeRequest(roomId, missionId), traceId: "trace:" + workflowId }]
  });
}

describe("roomAgentActionWorkflow", () => {
  it("returns the background action result on success", async () => {
    const handle = await startAction("room-action-test-01", "room-action-01", "mission-0100", "act-0001");

    const result = await handle.result();
    expect(result).toMatchObject({ status: "EXECUTED" });
    expect(stubs.callsOf("runRoomAgentBackgroundAction")[0]).toMatchObject({
      actionId: "act-0001",
      bridge: { roomId: "room-action-01", missionId: "mission-0100" }
    });
    expect(stubs.count("failRoomAgentBackgroundAction")).toBe(0);
  }, 60000);

  it("marks the background action failed and rethrows after exhausting activity retries", async () => {
    stubs.override("runRoomAgentBackgroundAction", () => {
      throw new Error("synthetic background action failure");
    });

    const handle = await startAction("room-action-test-02", "room-action-01", "mission-0101", "act-0002");

    await expect(handle.result()).rejects.toThrow();
    expect(stubs.count("runRoomAgentBackgroundAction")).toBe(5);
    expect(stubs.callsOf("failRoomAgentBackgroundAction")[0]).toMatchObject({
      roomId: "room-action-01",
      missionId: "mission-0101",
      actionId: "act-0002",
      cancelled: false
    });
  }, 60000);

  it("reports a cancelled background action when the workflow is cancelled", async () => {
    stubs.override("runRoomAgentBackgroundAction", () => blockUntilCancelled());

    const handle = await startAction("room-action-test-03", "room-action-01", "mission-0102", "act-0003");
    await stubs.waitForCall("runRoomAgentBackgroundAction");
    await handle.cancel();

    await stubs.waitForCall("failRoomAgentBackgroundAction");
    expect(stubs.callsOf("failRoomAgentBackgroundAction")[0]).toMatchObject({
      roomId: "room-action-01",
      missionId: "mission-0102",
      actionId: "act-0003",
      cancelled: true
    });
    await expect(handle.result()).rejects.toThrow();
  }, 60000);
});
