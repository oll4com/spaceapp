import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/index.js";

function setupSession(store: InMemorySpaceStore, title: string, roomAgent = false) {
  const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
  const pane = roomAgent ? store.getOrCreateRoomAgentPane(room.id) : store.createPane({ roomId: room.id, title, mode: "CHAT" }, "trace:pane");
  const session = store.createSpaceAgentSession({
    paneId: pane.id,
    roomId: room.id,
    status: "RUNNING",
    title,
    threadId: null,
    selectedProviderId: "codex-lb",
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: null,
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds: [],
    isActive: true,
    lastSyncedAt: "2026-08-12T00:00:00.000Z"
  });
  const promptMessage = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "user",
    content: "Run the mission.",
    status: "COMPLETED"
  });
  const responseMessage = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    status: "RUNNING"
  });
  const run = store.createSpaceAgentRun({
    sessionId: session.sessionId,
    roomId: room.id,
    paneId: pane.id,
    workflowId: "workflow:mission",
    status: "RUNNING",
    promptMessageId: promptMessage.messageId,
    responseMessageId: responseMessage.messageId
  });
  return { room, pane, session, run, responseMessage };
}

function completeRun(store: InMemorySpaceStore, runId: string, sessionId: string, responseMessageId: string) {
  return store.completeSpaceAgentRun({
    runId,
    sessionId,
    responseMessageId,
    responseContent: "Mission accomplished.",
    finalResponse: "Mission accomplished.",
    codexThreadId: "11111111-1111-4111-8111-111111111111",
    codexTurnId: "turn:codex1",
    sourceType: "ROOM_AGENT",
    traceId: "trace:complete",
    completedAt: "2026-08-12T12:00:00.000Z"
  });
}

describe("Space agent session lifecycle on run completion", () => {
  it("keeps the bound hidden Room Agent active after allocation and maintenance", () => {
    const store = new InMemorySpaceStore();
    const { pane, session, run, responseMessage } = setupSession(store, "Room Agent", true);
    expect(pane.isClosed).toBe(true);
    expect(completeRun(store, run.runId, session.sessionId, responseMessage.messageId).session.isActive).toBe(true);
    expect(store.reconcileStaleSpaceAgentSessions()).toBe(0);
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.sessionId);
  });
  it("does not revive a superseded hidden Room Agent session", () => {
    const store = new InMemorySpaceStore();
    const { session, run, responseMessage } = setupSession(store, "Room Agent", true);
    store.updateSpaceAgentSession(session.sessionId, { isActive: false });
    expect(completeRun(store, run.runId, session.sessionId, responseMessage.messageId).session.isActive).toBe(false);
  });
  it("deactivates a session when its run completes on a closed pane", () => {
    const store = new InMemorySpaceStore();
    const { pane, session, run, responseMessage } = setupSession(store, "Room Agent");
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");

    const completed = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);

    expect(completed.session).toMatchObject({ status: "READY", isActive: false });
    expect(store.getActiveSpaceAgentSession(pane.id)).toBeNull();
  });

  it("keeps a session active when its run completes on an open pane", () => {
    const store = new InMemorySpaceStore();
    const { pane, session, run, responseMessage } = setupSession(store, "Room Agent");

    const completed = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);

    expect(completed.session).toMatchObject({ status: "READY", isActive: true });
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.sessionId);
  });

  it("returns the original TURN_COMPLETED event when an unchanged completion is replayed", () => {
    const store = new InMemorySpaceStore();
    const { room, session, run, responseMessage } = setupSession(store, "Replay");
    const turnCompleted = () => store.listEvents(room.id).filter((event) =>
      event.type === "TURN_COMPLETED" && (event.payload as { runId?: string }).runId === run.runId);

    const first = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);
    const replay = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);
    expect(replay.event.id).toBe(first.event.id);
    expect(turnCompleted()).toHaveLength(1);

    // A completion that changes the response is not a replay and still announces itself.
    const changed = store.completeSpaceAgentRun({ runId: run.runId, sessionId: session.sessionId, responseMessageId: responseMessage.messageId,
      responseContent: "Mission accomplished, with a follow-up.", finalResponse: "Mission accomplished, with a follow-up.",
      codexThreadId: "11111111-1111-4111-8111-111111111111", codexTurnId: "turn:codex1", sourceType: "ROOM_AGENT",
      traceId: "trace:complete", completedAt: "2026-08-12T12:01:00.000Z" });
    expect(changed.event.id).not.toBe(first.event.id);
    expect(turnCompleted()).toHaveLength(2);
  });

  it("does not reactivate a superseded session when its run completes late", () => {
    const store = new InMemorySpaceStore();
    const { room, pane, session, run, responseMessage } = setupSession(store, "Old Chat");
    // A new conversation starts only after the current action is stopped; the worker may still complete it late.
    store.updateSpaceAgentRun(run.runId, { status: "INTERRUPTED" });
    store.updateSpaceAgentSession(session.sessionId, { isActive: false });
    const newerSession = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      status: "READY",
      title: "New Chat",
      threadId: null,
      selectedProviderId: "opencode",
      selectedModelId: "openai/gpt-5",
      selectedModelConfigId: "opencode-v1|openai/gpt-5|high",
      selectedProviderName: "OpenCode",
      selectedModelName: "GPT-5",
      selectedReasoningKey: "high",
      selectedToolIds: [],
      isActive: true
    });

    const completed = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);

    expect(completed.session).toMatchObject({ sessionId: session.sessionId, status: "READY", isActive: false });
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(newerSession.sessionId);
  });

  it("keeps a session active on a closed pane when another run is still running", () => {
    const store = new InMemorySpaceStore();
    const { pane, session, run, responseMessage } = setupSession(store, "Room Agent");
    const secondPrompt = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "Follow-up mission.",
      status: "COMPLETED"
    });
    const secondResponse = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    store.createSpaceAgentRun({
      sessionId: session.sessionId,
      roomId: pane.roomId,
      paneId: pane.id,
      workflowId: "workflow:mission:2",
      status: "RUNNING",
      promptMessageId: secondPrompt.messageId,
      responseMessageId: secondResponse.messageId
    });
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");

    const completed = completeRun(store, run.runId, session.sessionId, responseMessage.messageId);

    expect(completed.session).toMatchObject({ status: "READY", isActive: true });
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.sessionId);
  });
});

function setupIdleSession(store: InMemorySpaceStore, title: string, status: "RUNNING" | "READY") {
  const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
  const pane = store.createPane({ roomId: room.id, title, mode: "CHAT" }, "trace:pane");
  const session = store.createSpaceAgentSession({
    paneId: pane.id,
    roomId: room.id,
    status,
    title,
    threadId: null,
    selectedProviderId: "codex-lb",
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: null,
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds: [],
    isActive: true,
    lastSyncedAt: "2026-08-12T00:00:00.000Z"
  });
  return { room, pane, session };
}

describe("Stale space agent session reconciliation", () => {
  it("deactivates active sessions without a running run on closed panes", () => {
    const store = new InMemorySpaceStore();
    const staleRunning = setupIdleSession(store, "Stale Chat", "RUNNING");
    const staleReady = setupIdleSession(store, "Old Chat", "READY");
    store.updatePane(staleRunning.pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");
    store.updatePane(staleReady.pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");

    const deactivated = store.reconcileStaleSpaceAgentSessions();

    expect(deactivated).toBe(2);
    expect(store.getSpaceAgentSession(staleRunning.session.sessionId)).toMatchObject({ isActive: false, status: "READY" });
    expect(store.getSpaceAgentSession(staleReady.session.sessionId)).toMatchObject({ isActive: false, status: "READY" });
  });

  it("keeps sessions with a running run on closed panes", () => {
    const store = new InMemorySpaceStore();
    const { pane, session } = setupSession(store, "Room Agent");
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");

    const deactivated = store.reconcileStaleSpaceAgentSessions();

    expect(deactivated).toBe(0);
    expect(store.getSpaceAgentSession(session.sessionId)).toMatchObject({ isActive: true, status: "RUNNING" });
  });

  it("keeps active sessions on open panes without a running run", () => {
    const store = new InMemorySpaceStore();
    const { session } = setupIdleSession(store, "Idle Open Chat", "READY");

    const deactivated = store.reconcileStaleSpaceAgentSessions();

    expect(deactivated).toBe(0);
    expect(store.getSpaceAgentSession(session.sessionId)).toMatchObject({ isActive: true });
  });
});
