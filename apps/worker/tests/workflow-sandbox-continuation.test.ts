import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { roomAgentSupervisorInputSchema } from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
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

type Fixture = ReturnType<typeof continuationFixture>;
type TurnInput = { prompt: string; agentRunId?: string; roomAgentOperatorRequest?: string };

function storeActivities(fixture: Fixture, turn: (input: TurnInput) => unknown) {
  const { store } = fixture;
  return {
    async prepareRoomAgentBackgroundContinuation(input: { roomId: string; missionId: string; continuationId: string }) {
      return prepareBackgroundContinuation(input, store);
    },
    async checkRoomAgentSupervisorTurn(item: Parameters<typeof supervisorTurnState>[0]) {
      return supervisorTurnState(item, store);
    },
    async discardRoomAgentSupervisorTurn(input: { item: Parameters<typeof discardSupervisorTurn>[0]; reason: string; errorCode?: string }) {
      return discardSupervisorTurn(input.item, input.reason, store, input.errorCode);
    },
    async finishRoomAgentSupervisorTurn(input: Parameters<typeof finishSupervisorTurn>[0]) {
      return finishSupervisorTurn(input, store);
    },
    async runCodexAppServerTurn(input: TurnInput) {
      return turn(input);
    }
  };
}

async function withSupervisor<T>(
  activities: Record<string, (...args: never[]) => unknown>,
  input: unknown,
  run: (handle: {
    signal: (name: string, payload: unknown) => Promise<void>;
    terminate: () => Promise<void>;
    result: () => Promise<unknown>;
    workflowId: string;
    firstExecutionRunId?: string;
    fetchHistory: () => Promise<{ events?: unknown[] } | { history?: { events?: unknown[] } }>;
  }) => Promise<T>
) {
  const taskQueue = `sandbox-continuation-${Math.random().toString(16).slice(2)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath,
    activities
  });
  return worker.runUntil(() => env.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue,
    workflowId: `room-supervisor-${Math.random().toString(16).slice(2)}`,
    followRuns: false,
    args: [input]
  }).then(run));
}

async function until(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 45_000) throw new Error("timed out waiting for the sandbox store");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function supervisorInput(fixture: Fixture) {
  return roomAgentSupervisorInputSchema.parse({
    roomId: fixture.room.id,
    monitoringMissionIds: [fixture.initial.mission.id]
  });
}

function historyEvents(history: { events?: unknown[] } | { history?: { events?: unknown[] } }) {
  const events = "events" in history && history.events
    ? history.events
    : "history" in history ? history.history?.events : undefined;
  return events ?? [];
}

function continuedAsNewInput(history: Parameters<typeof historyEvents>[0]) {
  const event = [...historyEvents(history)].reverse().find((item) => {
    const record = item as { eventType?: unknown; workflowExecutionContinuedAsNewEventAttributes?: unknown };
    const type = String(record.eventType ?? "");
    return record.workflowExecutionContinuedAsNewEventAttributes !== undefined
      || type.includes("CONTINUED_AS_NEW")
      || type === "28";
  }) as { workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: unknown[] } } } | undefined;
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) throw new Error("no continue-as-new input in history");
  return defaultPayloadConverter.fromPayload(payload) as { pending?: unknown[]; processedCount?: number };
}

it("runs allocation, send, and verification through the real continuation activities", async () => {
  const fixture = continuationFixture();
  let calls = 0;
  const finishes: string[] = [];
  const activities = storeActivities(fixture, (turn) => {
    calls += 1;
    if (calls === 1) {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      fixture.store.createRoomAgentAction({
        ...fixture.action,
        actionId: "action:send",
        idempotencyKey: "send-once",
        actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" },
        statusReason: "Both tasks completed."
      });
    }
    fixture.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
    return calls === 1
      ? {
        status: "COMPLETED",
        message: "Sent",
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, pendingActionIds: ["action:send"], statusReason: "Queued" }
      }
      : {
        status: "COMPLETED",
        message: "Verified",
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
      };
  });
  const realFinish = activities.finishRoomAgentSupervisorTurn;
  activities.finishRoomAgentSupervisorTurn = async (input) => {
    finishes.push(input.status ?? "");
    return realFinish(input);
  };
  await withSupervisor(activities, supervisorInput(fixture), async (handle) => {
    try {
      await until(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED");
    } finally {
      await handle.terminate();
    }
  });
  expect(calls).toBe(2);
  expect(finishes).toEqual(["COMPLETED"]);
  expect(fixture.store.listRoomAgentActions(fixture.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
  expect(fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status).toBe("COMPLETED");
}, 60_000);

it.each([
  ["a plain error", () => { throw ApplicationFailure.nonRetryable("child failed"); }, "ROOM_AGENT_SUPERVISOR_FAILED"],
  ["an application failure type", () => { throw ApplicationFailure.nonRetryable("timed out", "CODEX_APP_SERVER_TURN_TIMEOUT"); }, "CODEX_APP_SERVER_TURN_TIMEOUT"]
])("records a sandbox turn failed by %s on the run and the mission", async (_label, fail, code) => {
  const fixture = continuationFixture();
  let runId = "";
  const finishes: Array<{ status?: string; errorCode?: string }> = [];
  const activities = storeActivities(fixture, (turn) => {
    runId = turn.agentRunId ?? "";
    return fail();
  });
  const realFinish = activities.finishRoomAgentSupervisorTurn;
  activities.finishRoomAgentSupervisorTurn = async (input) => {
    finishes.push({ status: input.status, errorCode: input.errorCode });
    return realFinish(input);
  };
  await withSupervisor(activities, supervisorInput(fixture), async (handle) => {
    try {
      await until(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "FAILED");
    } finally {
      await handle.terminate();
    }
  });
  expect(fixture.store.getRoomAgentTurn(fixture.initial.mission.id, runId)?.run).toMatchObject({ status: "FAILED", errorCode: code });
  expect(fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status).toBe("FAILED");
  expect(finishes).toEqual([expect.objectContaining({ status: "FAILED", errorCode: code })]);
}, 60_000);

it.each(["stop", "follow-up"])("retires a prepared sandbox run when %s arrives before the activity reply", async (kind) => {
  const fixture = continuationFixture();
  let releasePrepare: (() => void) | undefined;
  const prepareHeld = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let sawPrepare: (() => void) | undefined;
  const prepareStarted = new Promise<void>((resolve) => { sawPrepare = resolve; });
  const childPrompts: string[] = [];
  let preparedRunId = "";
  const activities = storeActivities(fixture, (turn) => {
    childPrompts.push(turn.roomAgentOperatorRequest ?? turn.prompt);
    fixture.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
    return {
      status: "COMPLETED",
      message: "Verified",
      roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
    };
  });
  const realPrepare = activities.prepareRoomAgentBackgroundContinuation;
  activities.prepareRoomAgentBackgroundContinuation = async (input) => {
    const result = await realPrepare(input);
    if (result.state === "READY") preparedRunId = result.item.turn.agentRunId ?? "";
    sawPrepare?.();
    await prepareHeld;
    return result;
  };
  await withSupervisor(activities, supervisorInput(fixture), async (handle) => {
    try {
      await prepareStarted;
      if (kind === "stop") {
        await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Stop" });
      } else {
        const followUp = fixture.enqueue("follow-up", "Only inspect the room.");
        await handle.signal("enqueueRoomAgentMission", followUp.queueItem);
      }
      releasePrepare?.();
      await until(() => fixture.store.getRoomAgentTurn(fixture.initial.mission.id, preparedRunId)?.run.status === "INTERRUPTED");
      if (kind === "follow-up") await until(() => childPrompts.length > 0);
    } finally {
      releasePrepare?.();
      await handle.terminate();
    }
  });
  expect(fixture.store.getRoomAgentTurn(fixture.initial.mission.id, preparedRunId)?.run.status).toBe("INTERRUPTED");
  if (kind === "stop") expect(childPrompts).toEqual([]);
  else expect(childPrompts[0]).toBe("Only inspect the room.");
}, 60_000);

it("carries a prepared continuation through continue-as-new and completes the mission once", async () => {
  const fixture = continuationFixture();
  let calls = 0;
  const activities = storeActivities(fixture, (turn) => {
    calls += 1;
    fixture.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
    return {
      status: "COMPLETED",
      message: "Verified",
      roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
    };
  });
  let carried: { pending?: unknown[]; processedCount?: number } | undefined;
  await withSupervisor(activities, { ...supervisorInput(fixture), processedCount: 50 }, async (handle) => {
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const pinned = handle.firstExecutionRunId
      ? env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId)
      : handle;
    carried = continuedAsNewInput(await pinned.fetchHistory());
  });
  expect(calls).toBe(0);
  const resumed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
  expect(resumed.pending).toHaveLength(1);
  expect(resumed.processedCount).toBe(0);
  await withSupervisor(activities, resumed, async (handle) => {
    try {
      await until(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED");
    } finally {
      await handle.terminate();
    }
  });
  expect(calls).toBe(1);
  expect(fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status).toBe("COMPLETED");
}, 60_000);
