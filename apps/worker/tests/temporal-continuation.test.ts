import { ApplicationFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import type { WorkflowHandle } from "@temporalio/client";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  buildCodexAppServerTurnWorkflowId,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  type DummyTurnInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { Sandbox, continuedInput, deferred, eventually, waitForTimer } from "./support/temporal-sandbox.js";

type Fixture = ReturnType<typeof continuationFixture>;
let sequence = 0;
const workflowId = () => `workflow:continuation-sandbox-${++sequence}`;

function verified(pendingActionIds: string[] = []) {
  return {
    status: "COMPLETED", message: "Verified", roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1, pendingActionIds,
      statusReason: "Verified remaining request."
    }
  };
}

function fixtureActivities(c: Fixture, overrides: Record<string, (...args: any[]) => any> = {}) {
  const finishes: unknown[] = [];
  const childInputs: DummyTurnInput[] = [];
  const activities = {
    prepareRoomAgentBackgroundContinuation: (input: Parameters<typeof prepareBackgroundContinuation>[0]) =>
      prepareBackgroundContinuation(input, c.store),
    checkRoomAgentSupervisorTurn: (item: RoomAgentSupervisorQueueItem) => supervisorTurnState(item, c.store),
    discardRoomAgentSupervisorTurn: ({ item, reason, errorCode }: {
      item: RoomAgentSupervisorQueueItem; reason: string; errorCode?: string;
    }) => discardSupervisorTurn(item, reason, c.store, errorCode),
    finishRoomAgentSupervisorTurn: (input: Parameters<typeof finishSupervisorTurn>[0]) => {
      finishes.push(input);
      return finishSupervisorTurn(input, c.store);
    },
    runCodexAppServerTurn: async (turn: DummyTurnInput) => {
      childInputs.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
      return verified();
    },
    ...overrides
  };
  const workflowInput = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { activities, workflowInput, finishes, childInputs };
}

async function startSupervisor(worker: Sandbox, input: unknown) {
  return worker.start("roomAgentSupervisorWorkflow", input, { workflowId: workflowId(), followRuns: false });
}

async function advanceMonitoring(worker: Sandbox, handle: WorkflowHandle) {
  await waitForTimer(handle);
  await worker.env.sleep(2_000);
}

describe("room supervisor continuation in a real Temporal sandbox", () => {
  let sandbox: Sandbox;
  beforeAll(async () => { sandbox = await Sandbox.create(); }, 60_000);
  afterAll(async () => { await sandbox?.close(); });

  it("allocates, sends once, verifies, and finishes the mission once", async () => {
    const c = continuationFixture();
    const childInputs: DummyTurnInput[] = [];
    const { activities, workflowInput, finishes } = fixtureActivities(c, {
      runCodexAppServerTurn: async (turn: DummyTurnInput) => {
        childInputs.push(turn);
        c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
        if (childInputs.length === 1) {
          expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
          c.store.createRoomAgentAction({
            ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
            evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed."
          });
          return verified(["action:send"]);
        }
        return verified();
      }
    });
    await sandbox.run(activities, async (worker) => {
      const handle = await startSupervisor(worker, workflowInput);
      await advanceMonitoring(worker, handle);
      await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status,
        status => status === "COMPLETED", "verified mission completion");
      expect(childInputs).toHaveLength(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(action => action.actionType === "SEND")).toHaveLength(1);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({ status: "COMPLETED" });
    });
  }, 25_000);

  it.each([
    ["plain error", () => new Error("child failed"), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["Temporal timeout", () => ApplicationFailure.create({ message: "child failed", type: "SYNTHETIC_TIMEOUT_WRAPPER", nonRetryable: true,
      cause: new TimeoutFailure("timed out", undefined, TimeoutType.HEARTBEAT) }), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application failure", () => ApplicationFailure.create({ message: "child failed", type: "CODEX_APP_SERVER_TURN_TIMEOUT", nonRetryable: true }), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ])("records a %s child failure with the correct cause code", async (label, makeError, code) => {
    const c = continuationFixture();
    const { activities, workflowInput, finishes } = fixtureActivities(c, {
      runCodexAppServerTurn: async () => { throw makeError(); }
    });
    await sandbox.run(activities, async (worker) => {
      const handle = await startSupervisor(worker, workflowInput);
      await advanceMonitoring(worker, handle);
      const queued = c.store.getRoomAgentTurn(c.initial.mission.id)!;
      const child = worker.env.client.workflow.getHandle(buildCodexAppServerTurnWorkflowId(queued.queueItem.turn));
      await eventually(() => child.describe().catch(() => null), description => description !== null, `${label} child start`);
      // Waiting on the finite child's result skips its real retry backoffs; the
      // supervisor itself stays open, so waiting for its result would never end.
      await expect(child.result()).rejects.toMatchObject({ name: "WorkflowFailedError" });
      await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status,
        status => status === "FAILED", "failed mission completion");
      const latest = c.store.getRoomAgentTurn(c.initial.mission.id);
      expect(latest?.run).toMatchObject({ status: "FAILED", errorCode: code });
      expect(finishes).toHaveLength(1);
      expect(finishes[0]).toMatchObject({ status: "FAILED", errorCode: code });
    });
  }, 30_000);

  it.each(["stop", "follow-up"])("retires the prepared continuation when %s arrives during preparation", async (kind) => {
    const c = continuationFixture();
    const handleReady = deferred<WorkflowHandle>();
    const childInputs: DummyTurnInput[] = [];
    let preparedRunId: string | undefined;
    const { activities, workflowInput } = fixtureActivities(c, {
      prepareRoomAgentBackgroundContinuation: async (input: Parameters<typeof prepareBackgroundContinuation>[0]) => {
        const prepared = await prepareBackgroundContinuation(input, c.store);
        if (prepared.state === "READY") preparedRunId = prepared.item.turn.agentRunId;
        const handle = await handleReady.promise;
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
        } else {
          const followUp = c.enqueue("follow-up", "Only inspect the room.");
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
        }
        return prepared;
      },
      runCodexAppServerTurn: async (turn: DummyTurnInput) => {
        childInputs.push(turn);
        c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
        return verified();
      }
    });
    await sandbox.run(activities, async (worker) => {
      const handle = await startSupervisor(worker, workflowInput);
      handleReady.resolve(handle);
      await advanceMonitoring(worker, handle);
      await eventually(() => preparedRunId && c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status,
        status => status === "INTERRUPTED", "prepared continuation retirement");
      expect(preparedRunId).toMatch(/^agent_run:bg-/);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId!)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(childInputs).toHaveLength(0);
      else {
        await eventually(() => childInputs.length, count => count === 1, "operator follow-up child");
        expect(childInputs[0]?.roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
    });
  }, 25_000);

  it("carries a prepared continuation through continueAsNew and starts it once", async () => {
    const c = continuationFixture();
    const { activities, workflowInput, childInputs } = fixtureActivities(c);
    await sandbox.run(activities, async (worker) => {
      const handle = await startSupervisor(worker, { ...workflowInput, processedCount: 50 });
      await advanceMonitoring(worker, handle);
      const continued = await continuedInput(handle);
      expect(continued.input.pending).toHaveLength(1);
      expect(continued.input.pending[0]?.turn.roomAgentContinuation?.generation).toBe(1);
      expect(continued.history.events?.some(event => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
      await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status,
        status => status === "COMPLETED", "resumed continuation completion");
      expect(childInputs).toHaveLength(1);
    });
  }, 25_000);

  it("defers continueAsNew until 105 queued signals fit the 100-item carry bound, then drains each once", async () => {
    const roomId = "room:carry-bound";
    const item = (index: number) => roomAgentSupervisorQueueItemSchema.parse({
      missionId: "mission:carry-bound",
      turn: {
        roomId, paneId: "pane:carry-bound", prompt: `Queued request ${index}`, artifactIds: [],
        agentRunId: `agent_run:carry-${String(index).padStart(3, "0")}`, permissionMode: null,
        collaborationMode: "default", traceId: `trace:carry-${index}`
      }
    });
    const handleReady = deferred<WorkflowHandle>();
    const checked: string[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: async (queued: RoomAgentSupervisorQueueItem) => {
        checked.push(queued.turn.agentRunId!);
        if (checked.length === 1) {
          const handle = await handleReady.promise;
          for (let index = 1; index <= 105; index += 1) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
        }
        return "SKIP" as const;
      },
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async () => undefined
    };
    const input = roomAgentSupervisorInputSchema.parse({ roomId, pending: [item(0)], processedCount: 49 });
    await sandbox.run(activities, async (worker) => {
      const handle = await startSupervisor(worker, input);
      handleReady.resolve(handle);
      const continued = await continuedInput(handle);
      expect(continued.input.pending).toHaveLength(100);
      expect(continued.input.processedCount).toBe(0);
      expect(continued.input.pending.map(queued => queued.turn.agentRunId))
        .toEqual(Array.from({ length: 100 }, (_, index) => item(index + 6).turn.agentRunId));
      expect(checked.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, index) => item(index).turn.agentRunId));
      const firstRunChecks = continued.history.events!.filter(event =>
        event.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
      expect(firstRunChecks).toHaveLength(6);
      await eventually(() => checked.length, count => count === 106, "all queued turns drained");
      expect(new Set(checked).size).toBe(106);
    });
  }, 30_000);
});
