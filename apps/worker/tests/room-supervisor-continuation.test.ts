import { beforeEach, expect, it, vi } from "vitest";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

const temporal = vi.hoisted(() => ({
  handlers: new Map<string, (input: any) => void>(), activities: {} as Record<string, any>,
  child: vi.fn(), condition: vi.fn(), continueAsNew: vi.fn(), patch: true, counter: 0
}));
vi.mock("@temporalio/workflow", () => ({
  defineSignal: (name: string) => name,
  setHandler: (name: string, handler: (input: any) => void) => temporal.handlers.set(name, handler),
  patched: () => temporal.patch, uuid4: () => `workflow-${++temporal.counter}`,
  workflowInfo: () => ({ workflowId: "space-room-action:action:legacy" }),
  proxyActivities: () => new Proxy({}, { get: (_, name) => (...args: any[]) => temporal.activities[String(name)](...args) }),
  condition: (...args: any[]) => temporal.condition(...args),
  continueAsNew: (...args: any[]) => temporal.continueAsNew(...args),
  executeChild: (...args: any[]) => temporal.child(...args),
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  isCancellation: (error: Error) => error.message === "CANCELLED",
  CancellationScope: class {
    cancelled = false;
    cancel() { this.cancelled = true; }
    async run(fn: () => Promise<any>) { if (this.cancelled) throw Error("CANCELLED"); return fn(); }
    static nonCancellable(fn: () => Promise<any>) { return fn(); }
  }
}));
import { roomAgentActionWorkflow, roomAgentSupervisorWorkflow } from "../src/workflows.js";

beforeEach(() => {
  temporal.handlers.clear(); temporal.activities = {}; temporal.counter = 0; temporal.patch = true;
  temporal.child.mockReset(); temporal.condition.mockReset(); temporal.continueAsNew.mockReset();
  temporal.condition.mockImplementation(async (predicate, timeout) => {
    if (predicate()) return true;
    if (timeout) return false;
    throw Error("WORKFLOW_IDLE");
  });
  temporal.continueAsNew.mockImplementation(async () => { throw Error("CONTINUE_AS_NEW"); });
});

it("persists background failure after Temporal exhausts execution retries, including legacy workflows", async () => {
  const error = Error("transport failed");
  temporal.activities.runRoomAgentBackgroundAction = vi.fn().mockRejectedValue(error);
  temporal.activities.failRoomAgentBackgroundAction = vi.fn();
  await expect(roomAgentActionWorkflow({ bridge: { roomId: "room:proof", missionId: "mission:proof" } as any, traceId: "trace:proof" })).rejects.toBe(error);
  expect(temporal.activities.failRoomAgentBackgroundAction).toHaveBeenCalledWith({
    roomId: "room:proof", missionId: "mission:proof", actionId: "action:legacy", cancelled: false
  });
});

function driver() {
  const c = continuationFixture();
  temporal.activities = {
    prepareRoomAgentBackgroundContinuation: vi.fn(input => prepareBackgroundContinuation(input, c.store)),
    checkRoomAgentSupervisorTurn: vi.fn(item => supervisorTurnState(item, c.store)),
    discardRoomAgentSupervisorTurn: vi.fn(({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode)),
    finishRoomAgentSupervisorTurn: vi.fn(input => finishSupervisorTurn(input, c.store))
  };
  temporal.child.mockImplementation(async (_, { args: [turn] }) => {
    c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
    return { status: "COMPLETED", message: "Verified", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." } };
  });
  const input = roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] });
  return { ...c, workflowInput: input };
}

it("executes allocation -> send -> verification in one mission", async () => {
  const c = driver();
  temporal.child.mockImplementationOnce(async (_, { args: [turn] }) => {
    expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
    c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
      evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
    c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
    return { status: "COMPLETED", message: "Sent", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1,
      pendingActionIds: ["action:send"], statusReason: "Queued" } };
  });
  await expect(roomAgentSupervisorWorkflow(c.workflowInput)).rejects.toThrow("WORKFLOW_IDLE");
  expect(temporal.child).toHaveBeenCalledTimes(2);
  expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
  expect(temporal.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
});

it.each([
  ["a plain error", Error("child failed"), "ROOM_AGENT_SUPERVISOR_FAILED"],
  ["a Temporal timeout", Object.assign(Error("child failed"), { name: "ChildWorkflowFailure", cause: Object.assign(Error("timed out"), { name: "TimeoutFailure" }) }), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
  ["an application failure type", Object.assign(Error("child failed"), { cause: { type: "CODEX_APP_SERVER_TURN_TIMEOUT" } }), "CODEX_APP_SERVER_TURN_TIMEOUT"]
])("records a turn failed by %s as FAILED with its cause code, never as superseded", async (_, error, code) => {
  const c = driver();
  temporal.child.mockImplementationOnce(async () => { throw error; });
  await expect(roomAgentSupervisorWorkflow(c.workflowInput)).rejects.toThrow("WORKFLOW_IDLE");
  expect(c.store.getRoomAgentTurn(c.initial.mission.id, "agent_run:bg-workflow-1")?.run).toMatchObject({ status: "FAILED", errorCode: code });
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
  expect(temporal.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode: code }));
});

it.each(["stop", "follow-up"])("retires a prepared run when %s arrives before the activity reply", async (kind) => {
  const c = driver();
  temporal.activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async input => {
    const result = await prepareBackgroundContinuation(input, c.store);
    if (kind === "stop") {
      c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
      temporal.handlers.get(ROOM_AGENT_STOP_SIGNAL)!({ missionId: null, reason: "Stop" });
    } else {
      const followUp = c.enqueue("follow-up", "Only inspect the room.");
      temporal.handlers.get(ROOM_AGENT_ENQUEUE_SIGNAL)!(followUp.queueItem);
    }
    return result;
  });
  await expect(roomAgentSupervisorWorkflow(c.workflowInput)).rejects.toThrow("WORKFLOW_IDLE");
  expect(c.store.getRoomAgentTurn(c.initial.mission.id, "agent_run:bg-workflow-1")?.run.status).toBe("INTERRUPTED");
  if (kind === "stop") expect(temporal.child).not.toHaveBeenCalled();
  else expect(temporal.child.mock.calls[0]![1].args[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
});

it("carries a prepared continuation through continueAsNew and starts it once", async () => {
  const c = driver();
  await expect(roomAgentSupervisorWorkflow({ ...c.workflowInput, processedCount: 50 })).rejects.toThrow("CONTINUE_AS_NEW");
  const resumed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(temporal.continueAsNew.mock.calls[0]![0])));
  expect(resumed.pending).toHaveLength(1);
  expect(temporal.child).not.toHaveBeenCalled();
  await expect(roomAgentSupervisorWorkflow(resumed)).rejects.toThrow("WORKFLOW_IDLE");
  expect(temporal.child).toHaveBeenCalledOnce();
  expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
});

it("defers continueAsNew until the carried queue fits the next run's input bounds", async () => {
  const roomId = "room:carry-bound";
  const item = (index: number) => ({
    missionId: "mission:carry-bound",
    turn: { roomId, paneId: "pane:carry-bound", prompt: `Queued request ${index}`, artifactIds: [],
      agentRunId: `agent_run:carry-${String(index).padStart(3, "0")}`, permissionMode: null,
      collaborationMode: "default", traceId: `trace:carry-${index}` }
  });
  let flooded = false;
  temporal.activities = {
    checkRoomAgentSupervisorTurn: vi.fn(async () => {
      if (!flooded) {
        flooded = true;
        const enqueue = temporal.handlers.get(ROOM_AGENT_ENQUEUE_SIGNAL)!;
        for (let index = 1; index <= 105; index += 1) enqueue(item(index));
      }
      return "SKIP";
    }),
    discardRoomAgentSupervisorTurn: vi.fn(async () => undefined),
    finishRoomAgentSupervisorTurn: vi.fn(async () => undefined)
  };
  const input = roomAgentSupervisorInputSchema.parse({ roomId, pending: [item(0)], processedCount: 49 });
  await expect(roomAgentSupervisorWorkflow(input)).rejects.toThrow("CONTINUE_AS_NEW");
  expect(temporal.continueAsNew).toHaveBeenCalledOnce();
  const carried = temporal.continueAsNew.mock.calls[0]![0];
  expect(carried.pending).toHaveLength(100);
  expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();
  // Five extra turns drained in this run; none were dropped.
  expect(temporal.activities.checkRoomAgentSupervisorTurn).toHaveBeenCalledTimes(6);
});

it("preserves the legacy boolean settle activity when replaying an unpatched history", async () => {
  const c = driver();
  temporal.patch = false;
  temporal.activities.settleRoomAgentBackgroundMission = vi.fn(async () => true);
  await expect(roomAgentSupervisorWorkflow(c.workflowInput)).rejects.toThrow("WORKFLOW_IDLE");
  expect(temporal.activities.settleRoomAgentBackgroundMission).toHaveBeenCalledOnce();
  expect(temporal.activities.prepareRoomAgentBackgroundContinuation).not.toHaveBeenCalled();
});
