import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// 1.1.9 in-app review S1 and S2 (2026-11-02): a team USER never becomes admin on /api/databases through ?mode=admin
// or x-space-mode, and never lists another room's turns (prompts) through GET /api/turns without a room.
async function build(multiUserEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), "space-team-user-"));
  const indexPath = join(root, "space_memory.md");
  const monthlyPath = join(root, "space_memory_2026-11.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const store = new InMemorySpaceStore();
  const secret = "team-user-session-secret";
  const app = await createApp({
    store,
    config: { ...getApiConfig({ SPACE_LOG_LEVEL: "silent" }), multiUserEnabled, spaceMemoryIndexPath: indexPath, spaceMemoryMonthlyPath: monthlyPath, spaceMemoryLockPath: join(root, "memory.lock") },
    canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath, monthlyPath }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false },
    systemAnalyticsService: { sample: async () => {}, rollupAndSweep: async () => {}, backfill: async () => {}, dispose: async () => {} } as unknown as Parameters<typeof createApp>[0]["systemAnalyticsService"]
  });
  const session = async (user: AuthUser) => {
    await store.upsertUser(user);
    const cookie = `${cookieName}=${signSession(user, secret)}`;
    const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    return { cookie, [csrfHeaderName]: csrf };
  };
  const turnIn = (ownerUserId: string, prompt: string) => {
    const room = store.createRoom({ name: `${prompt} room`, initialPaneCount: 0 }, `trace:${prompt}`, ownerUserId);
    const pane = store.createPane({ roomId: room.id, title: "Pane", mode: "CHAT" }, `trace:${prompt}`);
    store.recordTurnQueued({ roomId: room.id, paneId: pane.id, workflowId: `workflow:${room.id}`, runId: `run:${prompt}`,
      taskQueue: "space-agent-turns", traceId: `trace:${prompt}`, prompt, runtime: "CODEX_APP_SERVER", providerId: "codex-lb", modelId: "gpt-5.4-mini" });
    return room;
  };
  return { app, session, turnIn, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

const internal = "/api/databases/connections/spaceapp-internal";

it("S1: a USER's ?mode=admin or x-space-mode never opens the internal database; an ADMIN's still does", async () => {
  const { app, session, close } = await build(true);
  try {
    const user = await session({ id: "user:invitee", email: "invitee@space.local", role: "USER" });
    const admin = await session({ id: "user:operator", email: "operator@space.local", role: "ADMIN" });
    for (const request of [{ url: `${internal}?mode=admin`, headers: user }, { url: internal, headers: { ...user, "x-space-mode": "admin" } }]) {
      const response = await app.inject(request);
      expect(response.statusCode).not.toBe(200);
      expect(response.body).toContain("Admin privileges required");
    }
    const writable = await app.inject({ url: `${internal}?mode=admin`, headers: admin });
    expect(writable.statusCode).toBe(200);
    expect(writable.json().connection.isReadOnly).toBe(false);
    expect((await app.inject({ url: internal, headers: admin })).json().connection.isReadOnly).toBe(true);
  } finally {
    await close();
  }
});

it("S2: a USER lists turns only of a room they reach; the owner and ADMIN lists are unchanged", async () => {
  for (const multiUser of [true, false]) {
    const { app, session, turnIn, close } = await build(multiUser);
    try {
      const user = await session({ id: "user:invitee", email: "invitee@space.local", role: "USER" });
      const admin = await session({ id: "user:operator", email: "operator@space.local", role: "ADMIN" });
      const own = turnIn("user:invitee", "invitee prompt");
      const other = turnIn("user:operator", "operator secret prompt");
      expect((await app.inject({ url: "/api/turns", headers: user })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/turns?roomId=${other.id}`, headers: user })).statusCode).toBe(404);
      const mine = await app.inject({ url: `/api/turns?roomId=${own.id}`, headers: user });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().data.map((turn: { prompt: string }) => turn.prompt)).toEqual(["invitee prompt"]);
      const all = await app.inject({ url: "/api/turns", headers: admin });
      expect(all.statusCode).toBe(200);
      expect(all.json().data.map((turn: { prompt: string }) => turn.prompt).sort()).toEqual(["invitee prompt", "operator secret prompt"]);
    } finally {
      await close();
    }
  }
});
