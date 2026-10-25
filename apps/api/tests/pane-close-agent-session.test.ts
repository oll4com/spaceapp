import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

const csrfHeaderName = "x-space-csrf-token";

async function authedApp(store: InMemorySpaceStore) {
  const app = await createApp({
    store,
    config: getApiConfig({}),
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, cookie, csrfToken: csrf.json().csrfToken as string };
}

function createSession(store: InMemorySpaceStore, roomId: string, paneId: string, title: string, status: "RUNNING" | "READY") {
  return store.createSpaceAgentSession({
    paneId,
    roomId,
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
}

function createRunningRun(store: InMemorySpaceStore, session: ReturnType<typeof createSession>, roomId: string, paneId: string) {
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
  store.createSpaceAgentRun({
    sessionId: session.sessionId,
    roomId,
    paneId,
    workflowId: "workflow:mission",
    status: "RUNNING",
    promptMessageId: promptMessage.messageId,
    responseMessageId: responseMessage.messageId
  });
}

describe("Pane close deactivates idle space agent sessions", () => {
  it("deactivates a CHAT session without a running run when its pane is closed", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
    const pane = store.createPane({ roomId: room.id, title: "Chat 7", mode: "CHAT" }, "trace:pane");
    const session = createSession(store, room.id, pane.id, "Chat 7", "READY");
    const { app, cookie, csrfToken } = await authedApp(store);
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers
    });

    expect(response.statusCode).toBe(200);
    const updated = store.getSpaceAgentSession(session.sessionId);
    expect(updated).toMatchObject({ isActive: false, status: "READY" });
    expect(store.getActiveSpaceAgentSession(pane.id)).toBeNull();
    await app.close();
  });

  it("keeps a CHAT session active when its pane is closed while a run is in progress", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 0 }, "trace:room");
    const pane = store.createPane({ roomId: room.id, title: "Room Agent", mode: "CHAT" }, "trace:pane");
    const session = createSession(store, room.id, pane.id, "Room Agent", "RUNNING");
    createRunningRun(store, session, room.id, pane.id);
    const { app, cookie, csrfToken } = await authedApp(store);
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers
    });

    expect(response.statusCode).toBe(200);
    const updated = store.getSpaceAgentSession(session.sessionId);
    expect(updated).toMatchObject({ isActive: true, status: "RUNNING" });
    expect(store.getActiveSpaceAgentSession(pane.id)?.sessionId).toBe(session.sessionId);
    await app.close();
  });

  it("does not touch TERMINAL pane behavior while closing", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI", initialPaneCount: 0 }, "trace:room");
    const pane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" }, "trace:pane");
    const { app, cookie, csrfToken } = await authedApp(store);
    const headers = { cookie, [csrfHeaderName]: csrfToken };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/panes/${encodeURIComponent(pane.id)}`,
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(store.getPane(pane.id).isClosed).toBe(true);
    await app.close();
  });
});