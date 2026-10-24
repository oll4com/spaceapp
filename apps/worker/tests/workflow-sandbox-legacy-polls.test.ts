import { rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPayloadConverter } from "@temporalio/common";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";

// A second 250-poll loop on the server that just ran the current branch waits
// in real time. This file has its own time-skipping server, same as the
// current-branch poll test.

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

function oneSecondTimers(history: { events?: unknown[]; history?: { events?: unknown[] } }) {
  return historyEvents(history).filter((item) => {
    const seconds = (item as { timerStartedEventAttributes?: { startToFireTimeout?: { seconds?: unknown } } })
      .timerStartedEventAttributes?.startToFireTimeout?.seconds;
    const text = typeof seconds === "object" && seconds !== null ? String(seconds) : seconds;
    return text === "1" || text === 1;
  }).length;
}

// The public pre-patch branch settles with a boolean activity. Returning false
// keeps the mission, and the 250th idle poll continues as new. That live path
// is skipped unless histories are being recorded. The copy of workflows.ts
// forces the legacy branch; the real source file stays unchanged.
it("continues the pre-patch supervisor after 250 idle polls and keeps the mission", async () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/workflows.ts");
  const legacyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/workflows.legacy-polls.ts");
  const original = await readFile(sourcePath, "utf8");
  const needle = 'if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);';
  expect(original).toContain(needle);
  const legacy = original.replace(needle, "return legacyRoomAgentSupervisorWorkflow(rawInput);");
  expect(legacy).not.toContain('patched("room-background-continuation-v1")');
  await writeFile(legacyPath, legacy);
  try {
    let polls = 0;
    const taskQueue = "sandbox-legacy-polls";
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath: legacyPath,
      activities: {
        async settleRoomAgentBackgroundMission() {
          polls += 1;
          return false;
        }
      }
    });
    const carried = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue,
        workflowId: "workflow:supervisor-pre-patch-polls-live",
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
    const text = JSON.stringify(carried);
    expect(text).not.toContain("room-background-continuation-v1");
    expect(text).not.toContain("prepareRoomAgentBackgroundContinuation");
    const continued = continuedAsNewInput(carried) as {
      roomId?: string;
      processedCount?: number;
      monitoringMissionIds?: string[];
      pending?: unknown[];
      interrupted?: unknown[];
    };
    expect(continued).toMatchObject({
      roomId: ROOM,
      processedCount: 0,
      monitoringMissionIds: [MISSION],
      pending: [],
      interrupted: []
    });
  } finally {
    await rm(legacyPath, { force: true });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
  }
}, 60_000);
