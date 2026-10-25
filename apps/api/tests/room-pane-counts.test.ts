import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, createCanonicalSpaceMemoryBridge } from "@space/runtime";
import { createApp } from "../src/app.js";

async function authedApp({ store }: { store: InMemorySpaceStore }) {
  const app = await createApp({ store, canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath: "/nonexistent/room-count-index", monthlyPath: "/nonexistent/room-count-month" }), auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = login.cookies.map(({name, value}) => `${name}=${value}`).join("; ");
  return { app, cookie };
}

describe("room activity pane totals", () => {
  it("reports authenticated RUNNING CLI counts for every current room without sensitive session data", async () => {
    const store = new InMemorySpaceStore();
    const firstRoom = store.createRoom({ name: "First", initialPaneCount: 0 }, "trace:first");
    const secondRoom = store.createRoom({ name: "Second", initialPaneCount: 0 }, "trace:second");
    const emptyRoom = store.createRoom({ name: "Empty", initialPaneCount: 0 }, "trace:empty");
    const runningPane = store.createPane({ roomId: firstRoom.id, title: "Codex", mode: "TERMINAL" });
    const detachedPane = store.createPane({
      roomId: secondRoom.id,
      title: "Detached OpenCode",
      mode: "TERMINAL",
      isMinimized: true
    });
    const idlePane = store.createPane({ roomId: secondRoom.id, title: "Idle", mode: "TERMINAL" });

    store.createPaneCliSession({
      paneId: runningPane.id,
      roomId: firstRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      status: "RUNNING"
    });
    store.createPaneCliSession({
      paneId: detachedPane.id,
      roomId: secondRoom.id,
      runtimeId: "cli:opencode",
      providerId: "opencode",
      agentId: "opencode",
      status: "RUNNING"
    });
    store.createPaneCliSession({
      paneId: idlePane.id,
      roomId: secondRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      status: "IDLE"
    });

    store.createPane({ roomId: firstRoom.id, title: "Chat", mode: "CHAT", isMinimized: true });
    store.createPane({ roomId: firstRoom.id, title: "Browser", mode: "BROWSER" });
    const closedPane = store.createPane({ roomId: firstRoom.id, title: "Closed", mode: "CHAT" });
    store.updatePane(closedPane.id, { isClosed: true });

    const currentCounts = store.listRunningCliSessionCountsByRoom.bind(store);
    store.listRunningCliSessionCountsByRoom = () => [
      ...currentCounts(),
      { roomId: "room:stale", runningCliCount: 9 }
    ];

    const unauthenticated = await createApp({
      store,
      canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath: "/nonexistent/room-count-index", monthlyPath: "/nonexistent/room-count-month" }),
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });
    expect((await unauthenticated.inject({ method: "GET", url: "/api/rooms/cli-activity" })).statusCode).toBe(401);
    await unauthenticated.close();

    const { app, cookie } = await authedApp({ store });
    const response = await app.inject({ method: "GET", url: "/api/rooms/cli-activity", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        { roomId: firstRoom.id, runningCliCount: 1, paneCount: 3, runtimeIds: ["cli:codex"] },
        { roomId: secondRoom.id, runningCliCount: 1, paneCount: 2, runtimeIds: ["cli:opencode"] },
        { roomId: emptyRoom.id, runningCliCount: 0, paneCount: 0, runtimeIds: [] }
      ]
    });
    expect(response.json().sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(response.json())).not.toMatch(/sessionId|paneId|providerId|agentId|pid/i);
    await app.close();
  }, 30000);

});
