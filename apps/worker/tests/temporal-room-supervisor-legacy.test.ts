import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowHandle } from "@temporalio/client";
import { roomAgentSupervisorInputSchema } from "@space/contracts";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

// Legacy (pre-patch) supervisor branch: 250 boolean settle polls.
// This lives in its own file with a fresh test server because the server
// grants exactly one effective time-skipping period: once any workflow
// execution closes, unlockTimeSkipping() stops taking effect. The 250
// one-second polls need skipping, so the unlock here must happen before any
// workflow closes on this server.

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

type StartedHandle = WorkflowHandle & { firstExecutionRunId: string };

const CONTINUED_AS_NEW = 28; // EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW

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

async function terminateLatestRun(workflowId: string, reason: string): Promise<void> {
  await tenv.client.workflow.getHandle(workflowId).terminate(reason);
}

async function continuedAsNewInput(handle: StartedHandle): Promise<any> {
  const history: any = await firstRunHandle(handle).fetchHistory();
  const event = (history.events ?? []).find((e: any) => e.eventType === CONTINUED_AS_NEW);
  expect(event).toBeDefined();
  const payload = event.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  expect(payload).toBeDefined();
  const { defaultPayloadConverter } = await import("@temporalio/common");
  return await defaultPayloadConverter.fromPayload(payload);
}

it("legacy branch: settles with the boolean activity 250 times, never prepares", async () => {
  stubs.set("settleRoomAgentBackgroundMission", async () => false);
  const input = roomAgentSupervisorInputSchema.parse({
    roomId: "room:legacy-test",
    pending: [],
    monitoringMissionIds: ["mission:legacy-1"],
    interrupted: [],
    processedCount: 0
  });
  const workflowId = "room-supervisor-legacy-test";
  const handle = await tenv.client.workflow.start("legacyRoomAgentSupervisorWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId,
    args: [input]
  });
  await tenv.unlockTimeSkipping();
  try {
    await waitForContinuedAsNew(handle as StartedHandle);
    const carried = await continuedAsNewInput(handle as StartedHandle);
    expect(carried.monitoringMissionIds).toEqual(["mission:legacy-1"]);
    expect(carried.processedCount).toBe(0);
    // The legacy branch uses the old boolean settle activity 250 times...
    expect(stubs.callCount("settleRoomAgentBackgroundMission")).toBeGreaterThanOrEqual(250);
    // ...and never the patched prepare activity.
    expect(stubs.callCount("prepareRoomAgentBackgroundContinuation")).toBe(0);
  } finally {
    await tenv.lockTimeSkipping();
    await terminateLatestRun(workflowId, "test cleanup");
  }
}, 240_000);
