/**
 * Sandbox tests for roomAgentActionWorkflow on a real time-skipping test
 * server. Covers the patched failure-persistence path: a failing background
 * action is recorded via failRoomAgentBackgroundAction (with the action id
 * derived from the workflow id) and the original error is rethrown.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

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
});

const actionInput = (traceId: string) => ({
  bridge: { roomId: "room:action-test", missionId: "mission:action-1" } as never,
  traceId
});

async function runAction(workflowId: string, traceId: string) {
  const handle = await tenv.client.workflow.start("roomAgentActionWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    // The action id is derived from the workflow id by stripping the prefix.
    workflowId,
    args: [actionInput(traceId)]
  });
  return handle.result();
}

it("persists a failed background action and rethrows the original error", async () => {
  const error = new Error("transport failed");
  stubs.set("runRoomAgentBackgroundAction", () => {
    throw error;
  });
  const result = await runAction("space-room-action:test-1", "trace:action-1").then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({ ok: false as const, error: e as Error })
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const chain: string[] = [];
    for (let current: unknown = result.error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
      chain.push(current.message);
    }
    expect(chain.join("\n")).toMatch(/transport failed/);
  }
  // The patched branch records the failure with the derived action id.
  expect(stubs.callCount("failRoomAgentBackgroundAction")).toBe(1);
  expect(stubs.lastCall("failRoomAgentBackgroundAction")![0]).toEqual({
    roomId: "room:action-test",
    missionId: "mission:action-1",
    actionId: "test-1",
    cancelled: false
  });
  // Room-agent turn proxy retries the transport 5 times before giving up.
  expect(stubs.callCount("runRoomAgentBackgroundAction")).toBe(5);
}, 180_000);

it("marks the persisted action cancelled when the workflow is cancelled", async () => {
  // Hold the activity in-flight, then cancel the workflow: the SDK delivers
  // a bare CancelledFailure to the workflow's await, which the patched
  // branch records with cancelled: true.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubs.set("runRoomAgentBackgroundAction", () => gate.then(() => {
    throw new Error("should not reach here");
  }));
  const handle = await tenv.client.workflow.start("roomAgentActionWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId: "space-room-action:test-2",
    args: [actionInput("trace:action-2")]
  });
  await stubs.waitForCalls("runRoomAgentBackgroundAction", 1);
  await handle.cancel();
  const result = await handle.result().then(
    () => ({ ok: true as const }),
    () => ({ ok: false as const })
  );
  release();
  expect(result.ok).toBe(false);
  expect(stubs.callCount("failRoomAgentBackgroundAction")).toBe(1);
  expect(stubs.lastCall("failRoomAgentBackgroundAction")![0]).toEqual({
    roomId: "room:action-test",
    missionId: "mission:action-1",
    actionId: "test-2",
    cancelled: true
  });
  // A cancelled activity is not retried.
  expect(stubs.callCount("runRoomAgentBackgroundAction")).toBe(1);
}, 180_000);
