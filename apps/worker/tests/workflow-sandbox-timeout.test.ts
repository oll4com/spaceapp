import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  supervisorTurnState
} from "../src/room-background-continuation.js";

const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/workflows.ts");

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

// The embedded server does not time-skip this 15-second heartbeat, so the
// test waits in real time. It has its own file so that wait does not sit
// behind the other sandbox cases on the worker suite's two-file pool.
it("records a hung child activity as ROOM_AGENT_SUPERVISOR_TIMEOUT", async () => {
  const fixture = continuationFixture();
  await fixture.store.updateSpaceAgentRun(fixture.initial.run.runId, { status: "RUNNING" });
  const finished: Array<Record<string, unknown>> = [];
  const taskQueue = "sandbox-timeout";
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      async checkRoomAgentSupervisorTurn(item: Parameters<typeof supervisorTurnState>[0]) {
        return supervisorTurnState(item, fixture.store);
      },
      async runCodexAppServerTurn() {
        const context = Context.current();
        await new Promise((_resolve, reject) => {
          context.cancelled.catch((error: unknown) => reject(error));
        });
      },
      async discardRoomAgentSupervisorTurn(input: { item: Parameters<typeof discardSupervisorTurn>[0]; reason: string; errorCode?: string }) {
        return discardSupervisorTurn(input.item, input.reason, fixture.store, input.errorCode);
      },
      async finishRoomAgentSupervisorTurn(input: Parameters<typeof finishSupervisorTurn>[0]) {
        finished.push(input);
        return finishSupervisorTurn(input, fixture.store);
      }
    }
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue,
      workflowId: "workflow:sandbox-timeout",
      args: [{
        roomId: fixture.room.id,
        pending: [fixture.initial.queueItem],
        processedCount: 49
      }],
      followRuns: false
    });
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
  });
  expect(finished).toEqual([expect.objectContaining({
    status: "FAILED",
    errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT"
  })]);
  expect(fixture.store.getRoomAgentTurn(fixture.initial.mission.id, fixture.initial.run.runId)?.run).toMatchObject({
    status: "FAILED",
    errorCode: "ROOM_AGENT_SUPERVISOR_TIMEOUT"
  });
  expect(fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status).toBe("FAILED");
}, 150_000);
