import type { PaneCliSession } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { describe, expect, it, vi } from "vitest";
import { createActiveAgentCountProvider } from "../src/active-agent-count.js";

function addCliSession(
  store: InMemorySpaceStore,
  roomId: string,
  runtimeId: string,
  purpose: "NORMAL" | "LOGIN" = "NORMAL"
): PaneCliSession {
  const pane = store.createPane({ roomId, title: runtimeId, mode: "TERMINAL" });
  return store.createPaneCliSession({
    paneId: pane.id,
    roomId,
    runtimeId,
    providerId: runtimeId.slice(4),
    agentId: runtimeId.slice(4),
    status: "RUNNING",
    purpose
  });
}

function addRunningChatAgent(store: InMemorySpaceStore, roomId: string): void {
  const pane = store.createPane({ roomId, title: "Chat agent", mode: "CHAT" });
  const session = store.createSpaceAgentSession({
    paneId: pane.id,
    roomId,
    status: "RUNNING",
    title: "Chat agent",
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
  const prompt = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "user",
    content: "Continue.",
    status: "COMPLETED"
  });
  const response = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    status: "RUNNING"
  });
  store.createSpaceAgentRun({
    sessionId: session.sessionId,
    roomId,
    paneId: pane.id,
    workflowId: "workflow:active-agent-count",
    status: "RUNNING",
    promptMessageId: prompt.messageId,
    responseMessageId: response.messageId
  });
}

describe("createActiveAgentCountProvider", () => {
  it("adds verified turns from every CLI runtime to running chat agents", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 });
    addRunningChatAgent(store, room.id);
    const activeOpenCode = addCliSession(store, room.id, "cli:opencode");
    const idleOpenCode = addCliSession(store, room.id, "cli:opencode");
    const activeCodex = addCliSession(store, room.id, "cli:codex");
    addCliSession(store, room.id, "cli:opencode", "LOGIN");
    const activeGemini = addCliSession(store, room.id, "cli:gemini");
    const activeDroid = addCliSession(store, room.id, "cli:droid");
    const idleClaude = addCliSession(store, room.id, "cli:claude");
    const activeSessionIds = new Set([activeOpenCode.sessionId, activeCodex.sessionId, activeGemini.sessionId, activeDroid.sessionId]);
    const isCliTurnActive = vi.fn(async (session: PaneCliSession) => activeSessionIds.has(session.sessionId));
    const count = createActiveAgentCountProvider({ store, isCliTurnActive });

    await expect(count()).resolves.toBe(5);
    expect(isCliTurnActive).toHaveBeenCalledTimes(6);
    expect(isCliTurnActive).toHaveBeenCalledWith(idleOpenCode);
    expect(isCliTurnActive).toHaveBeenCalledWith(idleClaude);
  });

  it("keeps the chat-agent count when a CLI activity probe fails", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 });
    addRunningChatAgent(store, room.id);
    addCliSession(store, room.id, "cli:opencode");
    const count = createActiveAgentCountProvider({
      store,
      isCliTurnActive: vi.fn(async () => {
        throw new Error("status unavailable");
      })
    });

    await expect(count()).resolves.toBe(1);
  });
});
