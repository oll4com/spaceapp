import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { failRoomAgentBackgroundAction, settleRoomAgentBackgroundMission } from "../src/activities.js";

function setup() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Background actions", initialPaneCount: 0 });
  const pane = store.getOrCreateRoomAgentPane(room.id);
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent", selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
    selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
  const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Tell a story" });
  const assistant = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "Queued" });
  const request = store.createRoomAgentRequest({ requestId: "request:background", roomId: room.id, sessionId: session.sessionId,
    clientRequestId: "client-background-actions", promptMessageId: user.messageId, responseMessageId: assistant.messageId });
  const mission = store.createRoomAgentMission({ id: "mission:background", requestId: request.requestId, roomId: room.id,
    sessionId: session.sessionId, workflowId: "workflow:room-background", status: "RUNNING", currentPaneId: null, statusReason: "Running" });
  const root = store.createRoomAgentAction({ actionId: "action:root", missionId: mission.id, roomId: room.id, paneId: null,
    idempotencyKey: "background-action-root", actionType: "ORCHESTRATE", status: "QUEUED", requestPayload: { _roomBackgroundRoot: true },
    evidence: {}, attemptCount: 0, statusReason: "Queued" });
  return { store, room, session, mission, root, input: { roomId: room.id, missionId: mission.id } };
}

describe("Background room mission completion", () => {
  it("settles exhausted transport failures without overwriting completed roots or another mission", async () => {
    const c = setup();
    const input = { ...c.input, actionId: c.root.actionId, cancelled: false };
    await failRoomAgentBackgroundAction({ ...input, roomId: "room:other" }, c.store);
    expect(c.store.getRoomAgentAction(c.mission.id, c.root.actionId)?.status).toBe("QUEUED");
    await failRoomAgentBackgroundAction(input, c.store);
    expect(c.store.getRoomAgentAction(c.mission.id, c.root.actionId)?.status).toBe("FAILED");
    expect(await settleRoomAgentBackgroundMission(c.input, c.store)).toBe(true);
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)?.status).toBe("FAILED");
    c.store.updateRoomAgentAction(c.root.actionId, { status: "COMPLETED" });
    await failRoomAgentBackgroundAction(input, c.store);
    expect(c.store.getRoomAgentAction(c.mission.id, c.root.actionId)?.status).toBe("COMPLETED");
  });
  it("records cancellation as unverified and does not claim mission completion", async () => {
    const c = setup();
    await failRoomAgentBackgroundAction({ ...c.input, actionId: c.root.actionId, cancelled: true }, c.store);
    expect(c.store.getRoomAgentAction(c.mission.id, c.root.actionId)?.status).toBe("BLOCKED");
  });
  it("does not complete a mission merely because an action was queued", async () => {
    const c = setup();
    expect(await settleRoomAgentBackgroundMission(c.input, c.store)).toBe(false);
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)?.status).toBe("RUNNING");
  });
  it("uses final root outcomes after successful recovery and emits completion once", async () => {
    const c = setup();
    c.store.createRoomAgentAction({ ...c.root, actionId: "action:recovered-attempt", idempotencyKey: "background-recovered-attempt",
      actionType: "SEND", status: "FAILED", requestPayload: {}, statusReason: "First attempt failed" });
    c.store.updateRoomAgentAction(c.root.actionId, { status: "COMPLETED", statusReason: "Native completion verified" });
    expect(await settleRoomAgentBackgroundMission(c.input, c.store)).toBe(true);
    expect(c.store.getRoomAgentMission(c.room.id, c.mission.id)?.status).toBe("COMPLETED");
    const before = c.store.listSpaceAgentMessages(c.session.sessionId).length;
    expect(await settleRoomAgentBackgroundMission(c.input, c.store)).toBe(true);
    expect(c.store.listSpaceAgentMessages(c.session.sessionId)).toHaveLength(before);
  });
  it("keeps a paused mission pending even when its actions have finished", async () => {
    const c = setup();
    c.store.updateRoomAgentAction(c.root.actionId, { status: "COMPLETED" });
    c.store.updateRoomAgentMission(c.mission.id, { status: "PAUSED", statusReason: "Paused by operator" });
    expect(await settleRoomAgentBackgroundMission(c.input, c.store)).toBe(false);
  });
});
