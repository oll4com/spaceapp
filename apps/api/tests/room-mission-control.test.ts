import { describe, expect, it, vi } from "vitest";
import type { RoomAgentMissionRecord } from "@space/contracts";
import { InMemorySpaceStore, roomAgentMissionGuardMatches } from "@space/runtime";
import { createRoomActionExecutor } from "../src/room-actions.js";
import { createRoomAgentService } from "../src/room-agent.js";
import { createRoomPlanInventoryProvider } from "../src/room-plan-inventory.js";
import { missionControlGuard } from "../src/room-mission-control.js";

const actorId = "operator:mission-owner";
async function fixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Mission control", initialPaneCount: 0, kind: "AGENT_PROOF" });
  const interrupt = vi.fn();
  const executor = createRoomActionExecutor({ store, cliTerminalManager: {} as never,
    spaceAgentAdapter: { interrupt } as never, browserSessionManager: {} as never });
  const workflow = { enqueue: vi.fn(), stop: vi.fn(async () => {}) };
  const service = createRoomAgentService({ store, workflow, missionStopper: executor,
    roomPlanInventoryProvider: createRoomPlanInventoryProvider({ store, findPlanState: async () => null }) });
  const session = await service.load(room.id);
  const createMission = (id: string, status: RoomAgentMissionRecord["status"] = "RUNNING", ownerId = actorId) => {
    const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "An explicit goal" });
    const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const request = store.createRoomAgentRequest({ requestId: `request:${id}`, roomId: room.id, sessionId: session.sessionId,
      clientRequestId: `client:${id}`, promptMessageId: prompt.messageId, responseMessageId: response.messageId });
    return store.createRoomAgentMission({ id, requestId: request.requestId, roomId: room.id, sessionId: session.sessionId,
      workflowId: `supervisor:${room.id}`, currentPaneId: null, status, statusReason: "Test goal", executionState: { ownerId } });
  };
  const mission = createMission("mission:one");
  const target = { actorId, expectedMissionId: mission.id };
  return { store, room, executor, service, workflow, interrupt, createMission, mission, target };
}

describe("Exact mission control", () => {
  it.each(["PAUSE", "RESUME", "STOP"] as const)("does not apply stale %s to a replacement mission", async action => {
    const c = await fixture();
    c.store.updateRoomAgentMission(c.mission.id, { status: "COMPLETED" });
    const other = c.createMission("mission:replacement");
    await expect(c.service.control(c.room.id, action, "User requested stop", "trace:stale", c.target)).rejects.toThrow("not controllable");
    expect(c.store.getRoomAgentMission(c.room.id, other.id)?.status).toBe("RUNNING");
    expect(c.workflow.stop).not.toHaveBeenCalled();expect(c.interrupt).not.toHaveBeenCalled();
  });
  it.each(["PAUSE", "RESUME", "STOP"] as const)("requires the stored owner for %s", async action => {
    const c = await fixture();
    await expect(c.service.control(c.room.id, action, "Control request", "trace:foreign", { ...c.target, actorId: "operator:other" })).rejects.toThrow("another operator");
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)?.status).toBe("RUNNING");
    expect(c.workflow.stop).not.toHaveBeenCalled();
  });
  it("supports queued pause/resume without starting work or resetting an existing pause", async () => {
    const c = await fixture();c.store.updateRoomAgentMission(c.mission.id, { status: "QUEUED" });
    const createPane = vi.spyOn(c.store, "getOrCreateRoomAgentPane");
    await c.executor.pauseMission(c.room.id, "Pause", "trace:pause", c.target);
    const paused = c.store.getRoomAgentMission(c.room.id, c.mission.id)!;
    await c.executor.pauseMission(c.room.id, "Retry", "trace:retry", c.target);
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)).toEqual(paused);
    await c.executor.resumeMission(c.room.id, "trace:resume", c.target);
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)).toMatchObject({ status: "QUEUED", pausedAt: null, executionState: { ownerId: actorId } });
    expect(createPane).not.toHaveBeenCalled();expect(c.interrupt).not.toHaveBeenCalled();
  });
  it("rejects a state change inside the read/write race before interrupting anything", async () => {
    const c = await fixture();
    const update = c.store.updateRoomAgentMission.bind(c.store);
    vi.spyOn(c.store, "updateRoomAgentMission").mockImplementationOnce((id, patch, trace, guard) => {
      update(id, { status: "COMPLETED", statusReason: "Finished before pause" });
      return update(id, patch, trace, guard);
    });
    await expect(c.executor.pauseMission(c.room.id, "Pause", "trace:race", c.target)).rejects.toThrow("state or owner changed");
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)?.status).toBe("COMPLETED");expect(c.interrupt).not.toHaveBeenCalled();
  });
  it("does not overwrite a same-millisecond pending completion or owner change", async () => {
    const c = await fixture();
    const guard = missionControlGuard(c.mission);
    expect(roomAgentMissionGuardMatches({ ...c.mission, executionState: { ...c.mission.executionState, pendingCompletion: { status: "COMPLETED" } } }, guard)).toBe(false);
    expect(roomAgentMissionGuardMatches({ ...c.mission, executionState: { ownerId: "operator:other" } }, guard)).toBe(false);
    c.store.updateRoomAgentMission(c.mission.id, { executionState: { ownerId: "operator:other" } });
    expect(() => c.store.updateRoomAgentMission(c.mission.id, { status: "INTERRUPTED" }, "trace:stale", guard)).toThrow("state or owner changed");
  });
  it("preserves the existing worker run guard semantics", async () => {
    const c = await fixture();
    expect(roomAgentMissionGuardMatches(c.mission, { expectedStatus: "RUNNING", expectedRunId: "run:current" }, "run:current")).toBe(true);
    expect(roomAgentMissionGuardMatches(c.mission, { expectedStatus: "RUNNING", expectedRunId: "run:old" }, "run:current")).toBe(false);
    expect(c.store.updateRoomAgentMission(c.mission.id, { status: "FAILED" }, "trace:worker", { expectedStatus: "RUNNING", expectedRunId: "run:old" }).status).toBe("RUNNING");
  });
  it("signals only the original mission even if new work arrives during stop", async () => {
    const c = await fixture();
    const stop = c.executor.stopMission.bind(c.executor);
    vi.spyOn(c.executor, "stopMission").mockImplementationOnce(async (...args) => {
      const result = await stop(...args);c.createMission("mission:new-arrival");return result;
    });
    const response = await c.service.stop(c.room.id, "Stop original", "trace:stop", c.target);
    expect(c.workflow.stop).toHaveBeenCalledExactlyOnceWith(c.room.id, "Stop original", c.mission.id);
    expect(response.missionSnapshot?.mission).toMatchObject({ id: c.mission.id, status: "INTERRUPTED" });
    expect(c.store.getRoomAgentMission(c.room.id, "mission:new-arrival")?.status).toBe("RUNNING");
    await c.service.stop(c.room.id, "Retry stop", "trace:retry", c.target);
    expect(c.workflow.stop).toHaveBeenLastCalledWith(c.room.id, "Retry stop", c.mission.id);
    expect(c.interrupt).not.toHaveBeenCalled();
  });
  it("does not send a workflow signal after a local target conflict", async () => {
    const c = await fixture();vi.spyOn(c.executor, "stopMission").mockRejectedValue(new Error("Local guard conflict"));
    await expect(c.service.stop(c.room.id, "Stop", "trace:conflict", c.target)).rejects.toThrow("Local guard conflict");
    expect(c.workflow.stop).not.toHaveBeenCalled();
  });
  it("does not interrupt a queued action's pane or cancel another mission's queue", async () => {
    const c = await fixture();const other = c.createMission("mission:other-queue");
    const pane = c.store.createPane({ roomId: c.room.id, title: "Shared target", mode: "CHAT" });
    for(const mission of [c.mission,other]) c.store.createRoomAgentAction({ actionId: `action:${mission.id}`, missionId: mission.id, roomId:c.room.id,
      paneId:pane.id,idempotencyKey:`control-test:${mission.id}`,actionType:"SEND",status:"QUEUED",requestPayload:{},evidence:{},attemptCount:0,statusReason:"Queued" });
    await c.executor.stopMission(c.room.id, "Stop this goal", "trace:queue", c.target);
    expect(c.store.listRoomAgentActions(c.mission.id)[0]?.status).toBe("BLOCKED");
    expect(c.store.listRoomAgentActions(other.id)[0]?.status).toBe("QUEUED");expect(c.interrupt).not.toHaveBeenCalled();
  });
});
