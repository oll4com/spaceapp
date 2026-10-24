import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPayloadConverter } from "@temporalio/common";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";

const workflowsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/workflows.ts");
const ROOM = "room:sandbox";
const MISSION = "mission:sandbox";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

function historyEvents(history: { events?: unknown[]; history?: { events?: unknown[] } }) {
  return history.events ?? history.history?.events ?? [];
}

function continuedAsNewInput(history: { events?: unknown[]; history?: { events?: unknown[] } }) {
  const events = historyEvents(history);
  const event = [...events].reverse().find((item) => {
    const type = String((item as { eventType?: unknown }).eventType ?? "");
    return type.includes("CONTINUED_AS_NEW") || type === "28";
  }) as { workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: unknown[] } } } | undefined;
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) throw new Error("no continue-as-new input in history");
  return defaultPayloadConverter.fromPayload(payload);
}

export function oneSecondTimers(history: { events?: unknown[]; history?: { events?: unknown[] } }) {
  return historyEvents(history).filter((item) => {
    const seconds = (item as { timerStartedEventAttributes?: { startToFireTimeout?: { seconds?: unknown } } })
      .timerStartedEventAttributes?.startToFireTimeout?.seconds;
    const text = typeof seconds === "object" && seconds !== null ? String(seconds) : seconds;
    return text === "1" || text === 1;
  }).length;
}

it("continues a monitoring supervisor after 250 idle polls and keeps the mission", async () => {
  let polls = 0;
  const taskQueue = "sandbox-polls";
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      async prepareRoomAgentBackgroundContinuation() {
        polls += 1;
        return { state: "LATER" };
      }
    }
  });
  const carried = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue,
      workflowId: "workflow:supervisor-polls",
      followRuns: false,
      args: [{ roomId: ROOM, pending: [], monitoringMissionIds: [MISSION], processedCount: 0 }]
    });
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const pinned = handle.firstExecutionRunId
      ? env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId)
      : handle;
    return pinned.fetchHistory();
  });
  expect(polls).toBe(250);
  expect(oneSecondTimers(carried)).toBe(250);
  const continued = continuedAsNewInput(carried);
  expect(continued).toMatchObject({
    roomId: ROOM,
    processedCount: 0,
    monitoringMissionIds: [MISSION],
    pending: [],
    interrupted: []
  });
}, 60_000);
