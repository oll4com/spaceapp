import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createRoomShareAccess } from "../src/room-shares.js";

const sessionSecret = "room-shares-test-session-secret";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTestApp(multiUserEnabled: boolean) {
  const memoryRoot = await mkdtemp(join(tmpdir(), "space-room-shares-memory-"));
  temporaryRoots.push(memoryRoot);
  const indexPath = join(memoryRoot, "space_memory.md");
  const monthlyPath = join(memoryRoot, "space_memory_2026-10.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const config = {
    ...getApiConfig({ SPACE_INTERNAL_API_TOKEN: "room-shares-test-internal-token" }),
    multiUserEnabled,
    spaceMemoryIndexPath: indexPath,
    spaceMemoryMonthlyPath: monthlyPath,
    spaceMemoryLockPath: join(memoryRoot, "memory.lock")
  };
  const store = new InMemorySpaceStore();
  const app = await createApp({
    store,
    config,
    canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath, monthlyPath }),
    auth: { sessionSecret, devLogin: true, secureCookies: false },
    systemAnalyticsService: { sample: async () => {}, rollupAndSweep: async () => {}, backfill: async () => {}, dispose: async () => {} } as any
  });
  const session = async (user: AuthUser) => {
    await store.upsertUser(user);
    const cookie = `${cookieName}=${signSession(user, sessionSecret)}`;
    const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    return { cookie, headers: { cookie, [csrfHeaderName]: csrf } };
  };
  return { app, store, session };
}

describe("room sharing (multi-user step 3)", () => {
  it("answers MULTI_USER_DISABLED while the flag is off", async () => {
    const { app, session } = await createTestApp(false);
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "USER" });
      await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Alice room", initialPaneCount: 0 } })).json();
      const share = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/shares/user:bob`, headers: alice.headers, payload: { permission: "VIEW" } });
      expect(share.statusCode).toBe(404);
      expect(share.json().error.code).toBe("MULTI_USER_DISABLED");
    } finally {
      await app.close();
    }
  });

  it("VIEW reads, COLLABORATE opens its own panes, only a pane's owner changes it, and unsharing hides everything again", async () => {
    const { app, store, session } = await createTestApp(true);
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "USER" });
      const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Alice room", initialPaneCount: 1 } })).json();
      const alicePane = (await store.listPanes(room.id))[0]!;
      const as = (who: typeof alice, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
        app.inject({ method, url, headers: who.headers, payload: payload as never });
      const roomIds = async () => (await as(bob, "GET", "/api/rooms")).json().data.map((item: { id: string }) => item.id);

      expect((await as(bob, "GET", `/api/rooms/${room.id}/room-agent`)).statusCode).toBe(404);
      expect((await as(bob, "PUT", `/api/rooms/${room.id}/shares/user:bob`, { permission: "VIEW" })).statusCode).toBe(404);
      expect((await as(alice, "PUT", `/api/rooms/${room.id}/shares/user:nobody`, { permission: "VIEW" })).statusCode).toBe(404);

      // VIEW: Bob sees the room and its panes but changes nothing. The owner shares by email.
      expect((await as(alice, "PUT", `/api/rooms/${room.id}/shares`, { email: "nobody@space.local", permission: "VIEW" })).statusCode).toBe(404);
      expect((await as(alice, "PUT", `/api/rooms/${room.id}/shares`, { email: "alice@space.local", permission: "VIEW" })).statusCode).toBe(404);
      expect((await as(alice, "PUT", `/api/rooms/${room.id}/shares`, { email: " Bob@Space.local ", permission: "VIEW" })).json())
        .toMatchObject({ userId: "user:bob", permission: "VIEW", createdBy: "user:alice" });
      expect(await roomIds()).toContain(room.id);
      // The web hides the write controls of a VIEW share (MU-007); the owner's own list carries no permission.
      expect((await as(bob, "GET", "/api/rooms")).json().data.find((item: { id: string }) => item.id === room.id)).toMatchObject({ sharePermission: "VIEW" });
      expect((await as(alice, "GET", "/api/rooms")).json().data.find((item: { id: string }) => item.id === room.id).sharePermission).toBeUndefined();
      expect((await as(bob, "GET", `/api/rooms/${room.id}/room-agent`)).statusCode).not.toBe(404);
      expect((await as(bob, "GET", `/api/events?roomId=${room.id}`)).statusCode).toBe(200);
      const viewWrites = [
        await as(bob, "PATCH", `/api/panes/${alicePane.id}`, { title: "stolen" }),
        await as(bob, "POST", `/api/rooms/${room.id}/panes`, { panes: [{ mode: "CHAT" }] }),
        await as(bob, "DELETE", `/api/rooms/${room.id}`),
        await as(bob, "PUT", `/api/rooms/${room.id}/shares/user:bob`, { permission: "COLLABORATE" })
      ];
      expect(viewWrites.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
      expect(viewWrites[0]!.json().error.code).toBe("PANE_OWNER_ONLY");
      expect(viewWrites[1]!.json().error.code).toBe("ROOM_SHARE_READ_ONLY");

      // COLLABORATE: Bob opens his own pane; neither side changes the other's pane.
      await as(alice, "PUT", `/api/rooms/${room.id}/shares/user:bob`, { permission: "COLLABORATE" });
      const created = await as(bob, "POST", `/api/rooms/${room.id}/panes`, { panes: [{ mode: "CHAT" }] });
      expect(created.statusCode, created.body).toBe(200);
      const bobPane = created.json().data[0];
      expect(await store.getPaneOwner(bobPane.id)).toBe("user:bob");
      expect((await as(bob, "PATCH", `/api/panes/${bobPane.id}`, { title: "Bob pane" })).statusCode).toBe(200);
      expect((await as(bob, "PATCH", `/api/panes/${alicePane.id}`, { title: "stolen" })).json().error.code).toBe("PANE_OWNER_ONLY");
      expect((await as(alice, "PATCH", `/api/panes/${bobPane.id}`, { title: "taken" })).json().error.code).toBe("PANE_OWNER_ONLY");
      expect((await as(bob, "DELETE", `/api/rooms/${room.id}`)).statusCode).toBe(403);
      // Bob cannot move his own pane out of his room into Alice's shared room (security review 2026-10-17).
      const bobOwnRoom = (await as(bob, "POST", "/api/rooms", { name: "Bob room", initialPaneCount: 1 })).json();
      const bobOwnPane = (await store.listPanes(bobOwnRoom.id))[0]!;
      expect((await as(bob, "POST", `/api/panes/${bobOwnPane.id}/move`, { targetRoomId: room.id })).statusCode).toBe(403);
      expect((await as(alice, "GET", `/api/rooms/${room.id}/shares`)).json().shares).toEqual([
        expect.objectContaining({ roomId: room.id, userId: "user:bob", email: "bob@space.local", permission: "COLLABORATE" })
      ]);

      // Unshare: 404 everywhere again, the room leaves Bob's list.
      expect((await as(alice, "DELETE", `/api/rooms/${room.id}/shares/user:bob`)).statusCode).toBe(200);
      expect(await roomIds()).not.toContain(room.id);
      for (const response of [
        await as(bob, "GET", `/api/rooms/${room.id}/room-agent`),
        await as(bob, "GET", `/api/events?roomId=${room.id}`),
        await as(bob, "PATCH", `/api/panes/${bobPane.id}`, { title: "after unshare" }),
        await as(bob, "GET", `/api/panes/${alicePane.id}/cli/session`)
      ]) expect(response.statusCode, response.body).toBe(404);
      expect((await as(alice, "DELETE", `/api/rooms/${room.id}/shares/user:bob`)).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("streams a shared room's events to the shared user until the share is removed", async () => {
    const { app, session } = await createTestApp(true);
    const controller = new AbortController();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "USER" });
      const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Alice room", initialPaneCount: 0 } })).json();
      const bobRoom = (await app.inject({ method: "POST", url: "/api/rooms", headers: bob.headers, payload: { name: "Bob room", initialPaneCount: 0 } })).json();
      await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/shares/user:bob`, headers: alice.headers, payload: { permission: "VIEW" } });
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${address}/api/events/stream?replayLimit=200`, { headers: { cookie: bob.cookie }, signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (needle: string) => {
        const deadline = Date.now() + 8000;
        while (!text.includes(needle)) {
          const left = deadline - Date.now();
          const chunk = left > 0 ? await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), left))]) : null;
          if (!chunk || chunk.done) throw new Error(`stream never contained ${needle}: ${text.slice(-600)}`);
          text += decoder.decode(chunk.value, { stream: true });
        }
      };
      await readUntil("event: replay-complete");
      expect(text).toContain("Room Alice room created.");
      const panes = (body: unknown) => app.inject({ method: "POST", url: `/api/rooms/${(body as { id: string }).id}/panes`, headers: (body === room ? alice : bob).headers, payload: { panes: [{ mode: "CHAT" }] } });
      const shared = (await panes(room)).json().data[0].id as string;
      await readUntil(shared);
      await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}/shares/user:bob`, headers: alice.headers });
      const hidden = (await panes(room)).json().data[0].id as string;
      const own = (await panes(bobRoom)).json().data[0].id as string;
      await readUntil(own);
      expect(text).not.toContain(hidden);
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it("closes the features without an owner to a USER, with the flag on or off (operator decisions 2026-10-17, MU-001)", async () => {
    const closed = ["/api/memory", "/api/skills", "/api/council/runs", "/api/admin/audit", "/api/admin/storage", "/api/audit/entries",
      "/api/activity-log", "/api/shared-chat/messages", "/api/control/v1/capabilities", "/api/agent/sessions", "/api/app-diagnostics",
      "/api/swarm", "/api/reviews", "/api/cli/tasks", "/api/codex/history", "/api/tasks", "/api/providers", "/api/files/list"];
    for (const enabled of [true, false]) {
      const { app, session } = await createTestApp(enabled);
      try {
        const alice = await session({ id: "user:alice", email: "alice@space.local", role: "USER" });
        const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Alice room", initialPaneCount: 0 } })).json();
        const answers = await Promise.all(closed.map(async (url) => `${url} ${(await app.inject({ method: "GET", url, headers: alice.headers })).statusCode}`));
        expect(answers).toEqual(closed.map((url) => `${url} 404`));
        // Deny by default also covers writes outside the allowed families (security review 2026-10-17).
        for (const [method, url] of [["PATCH", "/api/tasks/codex-goals/thread-1"], ["POST", "/api/providers"], ["PATCH", `/api/swarm/tasks/x?roomId=${room.id}`]] as const) {
          expect((await app.inject({ method, url, headers: alice.headers, payload: {} })).statusCode, `${method} ${url}`).toBe(404);
        }
        // Swarm and Review of the user's own room stay open.
        expect((await app.inject({ method: "GET", url: `/api/swarm?roomId=${room.id}`, headers: alice.headers })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: `/api/reviews/state?roomId=${room.id}`, headers: alice.headers })).statusCode).not.toBe(404);
      } finally {
        await app.close();
      }
    }
  });

  it("lets a shared user only watch a pane's terminal; the operator's rooms without shares are unchanged", async () => {
    const store = new InMemorySpaceStore();
    for (const id of ["user:alice", "user:bob", "user:carol"]) store.upsertUser({ id, email: `${id.slice(5)}@space.local`, role: "USER" });
    const room = store.createRoom({ name: "Alice room", initialPaneCount: 0 }, "trace:share", "user:alice");
    const alicePane = store.createPane({ roomId: room.id, title: "Alice", mode: "CHAT" }, "trace:share");
    const bobPane = store.createPane({ roomId: room.id, title: "Bob", mode: "CHAT" }, "trace:share");
    store.setPaneOwner(bobPane.id, "user:bob");
    store.setRoomShare({ roomId: room.id, userId: "user:bob", permission: "COLLABORATE", createdBy: "user:alice", createdAt: "2026-10-16T00:00:00.000Z" });
    const access = createRoomShareAccess({ store, enabled: true });
    expect(await access.observeOnly(alicePane, "user:alice")).toBe(false);
    expect(await access.observeOnly(alicePane, "user:bob")).toBe(true);
    expect(await access.observeOnly(bobPane, "user:bob")).toBe(false);
    expect(await access.observeOnly(bobPane, "user:alice")).toBe(true);
    // Not shared with Carol (she never reaches the room) and an ADMIN in a room without shares: unchanged.
    expect(await access.observeOnly(alicePane, "user:carol")).toBe(false);
    expect(await createRoomShareAccess({ store, enabled: false }).observeOnly(alicePane, "user:bob")).toBe(false);
  });
});
