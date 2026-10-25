import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig, type SpaceApiConfig } from "../src/config.js";
import { pluginsService } from "../src/plugins-service.js";

const sessionSecret = "auth-route-guards-test-session-secret";
const temporaryRoots: string[] = [];

async function createTestApp(override: Partial<SpaceApiConfig> = {}) {
  const memoryRoot = await mkdtemp(join(tmpdir(), "space-auth-guards-memory-"));
  temporaryRoots.push(memoryRoot);
  const indexPath = join(memoryRoot, "gemini_history.md");
  const monthlyPath = join(memoryRoot, "gemini_history_2026-07.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const config = {
    ...getApiConfig({
      SPACE_INTERNAL_API_TOKEN: "auth-route-guards-test-internal-token",
      SPACE_HARNESS_ENABLED: "true",
      SPACE_HARNESS_ORIGIN: "http://127.0.0.1:1"
    }),
    ...override,
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
    systemAnalyticsService: {
      sample: async () => {},
      rollupAndSweep: async () => {},
      backfill: async () => {},
      dispose: async () => {}
    } as any
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const adminCookie = `${cookieName}=${login.cookies.find((c) => c.name === cookieName)?.value}`;
  return { app, store, adminCookie };
}

async function sessionFor(app: Awaited<ReturnType<typeof createTestApp>>["app"], store: InMemorySpaceStore, user: AuthUser) {
  await store.upsertUser(user);
  const cookie = `${cookieName}=${signSession(user, sessionSecret)}`;
  const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
  return { cookie, headers: { cookie, [csrfHeaderName]: csrf } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("route guards decide on the matched route, not the raw URL", () => {
  it("rejects anonymous requests to percent-encoded API paths", async () => {
    const { app } = await createTestApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/rooms" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/%61pi/rooms" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/%72ooms" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("keeps internal routes behind the internal token even when the path is encoded", async () => {
    const { app, adminCookie } = await createTestApp();
    try {
      const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie: adminCookie } })).json().csrfToken as string;
      const headers = { cookie: adminCookie, [csrfHeaderName]: csrf };
      for (const url of ["/api/internal/agent/room-actions", "/api/%69nternal/agent/room-actions"]) {
        const response = await app.inject({ method: "POST", url, headers, payload: {} });
        expect(response.statusCode, url).toBe(401);
        expect(response.json().error.code, url).toBe("INTERNAL_AUTH_REQUIRED");
      }
    } finally {
      await app.close();
    }
  });

  it("still enforces CSRF on encoded mutation paths", async () => {
    const { app, adminCookie } = await createTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/%61pi/rooms",
        headers: { cookie: adminCookie },
        payload: { name: "Encoded", initialPaneCount: 0 }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("CSRF_INVALID");
    } finally {
      await app.close();
    }
  });
});

describe("harness proxy", () => {
  it("requires a Space session for /plugins routes", async () => {
    const { app } = await createTestApp({ harnessOrigin: "http://127.0.0.1:1" });
    try {
      for (const url of ["/plugins/events", "/plugins/@deepseek-ai/dsh-client-ui/client.js"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(401);
        expect(response.json().error.code, url).toBe("UNAUTHENTICATED");
      }
    } finally {
      await app.close();
    }
  });
});

describe("admin role changes", () => {
  it("lets an administrator demote an operator but never lets an operator escalate", async () => {
    const { app, store, adminCookie } = await createTestApp();
    try {
      const operator = await sessionFor(app, store, { id: "user:operator-b", email: "operator-b@space.local", role: "OPERATOR" });
      const adminCsrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie: adminCookie } })).json().csrfToken as string;
      const adminHeaders = { cookie: adminCookie, [csrfHeaderName]: adminCsrf };
      const adminId = (await app.inject({ url: "/api/auth/me", headers: { cookie: adminCookie } })).json().user.id as string;

      const selfPromotion = await app.inject({
        method: "PATCH",
        url: "/api/admin/users/user:operator-b/role",
        headers: operator.headers,
        payload: { role: "ADMIN" }
      });
      expect(selfPromotion.statusCode).toBe(403);
      expect(selfPromotion.json().error.code).toBe("ROLE_ESCALATION_FORBIDDEN");
      expect((await store.getControlActor("user:operator-b"))?.role).toBe("OPERATOR");

      const demoteAdmin = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${adminId}/role`,
        headers: operator.headers,
        payload: { role: "USER" }
      });
      expect(demoteAdmin.statusCode).toBe(403);
      expect((await store.getControlActor(adminId))?.role).toBe("ADMIN");

      const adminDemotesOperator = await app.inject({
        method: "PATCH",
        url: "/api/admin/users/user:operator-b/role",
        headers: adminHeaders,
        payload: { role: "USER" }
      });
      expect(adminDemotesOperator.statusCode).toBe(200);
      expect((await store.getControlActor("user:operator-b"))?.role).toBe("USER");
    } finally {
      await app.close();
    }
  });
});

describe("room and pane ownership for USER accounts", () => {
  // The plugins store writes under a fixed data path (/opt/spaceapp/var here, /opt/spaceapp in the public export, where
  // the suite cannot create it); these probes check room and pane ownership, not plugin storage.
  beforeEach(() => {
    vi.spyOn(pluginsService, "getAgentConfig").mockImplementation(async (paneId) => ({ paneId, enabledPluginIds: [], disabledPluginIds: [] }));
  });

  it("hides other users' rooms and panes behind 404 on every room and pane route", async () => {
    const { app, store } = await createTestApp();
    try {
      const alice = await sessionFor(app, store, { id: "user:alice", email: "alice@space.local", role: "USER" });
      const mallory = await sessionFor(app, store, { id: "user:mallory", email: "mallory@space.local", role: "USER" });

      const created = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: alice.headers,
        payload: { name: "Alice room", initialPaneCount: 1 }
      });
      expect([200, 201], created.body).toContain(created.statusCode);
      const room = created.json().room ?? created.json();
      const roomId = room.id as string;
      expect(room.ownerUserId).toBe("user:alice");
      const pane = (await store.listPanes(roomId))[0]!;

      const probes: Array<{ method: "GET" | "POST" | "DELETE" | "PATCH"; url: string; payload?: unknown }> = [
        { method: "GET", url: `/api/rooms/${roomId}/room-agent` },
        { method: "GET", url: `/api/rooms/${roomId}/agent-history` },
        { method: "DELETE", url: `/api/rooms/${roomId}/media` },
        { method: "DELETE", url: `/api/rooms/${roomId}/agent-files` },
        { method: "DELETE", url: `/api/rooms/${roomId}/room-agent/transcript` },
        { method: "PATCH", url: `/api/rooms/${roomId}/room-agent/monitor`, payload: { enabled: false } },
        { method: "POST", url: `/api/rooms/${roomId}/room-agent/events/room_agent_event:any/ack`, payload: {} },
        { method: "PATCH", url: `/api/panes/${pane.id}`, payload: { title: "stolen" } },
        { method: "DELETE", url: `/api/panes/${pane.id}` }
      ];
      for (const probe of probes) {
        const response = await app.inject({ method: probe.method, url: probe.url, headers: mallory.headers, payload: probe.payload });
        expect(response.statusCode, `${probe.method} ${probe.url} -> ${response.body}`).toBe(404);
      }
      expect((await store.listPanes(roomId)).length).toBe(1);

      // Mallory cannot move her own pane into Alice's room.
      const malloryRoom = (await app.inject({ method: "POST", url: "/api/rooms", headers: mallory.headers, payload: { name: "Mallory room", initialPaneCount: 1 } })).json();
      const malloryPane = (await store.listPanes(malloryRoom.room?.id ?? malloryRoom.id))[0]!;
      const intrusion = await app.inject({ method: "POST", url: `/api/panes/${malloryPane.id}/move`, headers: mallory.headers, payload: { targetRoomId: roomId } });
      expect(intrusion.statusCode, intrusion.body).toBe(404);
      expect((await store.listPanes(roomId)).length).toBe(1);

      const ownerView = await app.inject({ method: "GET", url: `/api/rooms/${roomId}/room-agent`, headers: alice.headers });
      expect(ownerView.statusCode, ownerView.body).not.toBe(404);
      const ownerPane = await app.inject({
        method: "PATCH",
        url: `/api/panes/${pane.id}`,
        headers: alice.headers,
        payload: { title: "renamed by owner" }
      });
      expect(ownerPane.statusCode, ownerPane.body).toBe(200);
      expect((await store.listPanes(roomId))[0]?.title).toBe("renamed by owner");
    } finally {
      await app.close();
    }
  });

  it("checks a roomId or paneId in the query, body or a :roomId/:paneId path, and artifacts by their room", async () => {
    const { app, store } = await createTestApp();
    try {
      const alice = await sessionFor(app, store, { id: "user:alice", email: "alice@space.local", role: "USER" });
      const mallory = await sessionFor(app, store, { id: "user:mallory", email: "mallory@space.local", role: "USER" });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Alice room", initialPaneCount: 1 } })).json();
      const roomId = (room.room ?? room).id as string;
      const pane = (await store.listPanes(roomId))[0]!;
      const { artifact } = await store.createArtifact({ roomId, kind: "EXPORT", mimeType: "text/plain",
        storageUri: "space-artifact://browser-evidence/fixture/alice.txt", byteSize: 7, sha256: "a".repeat(64), metadata: {} });

      const probes: Array<{ method: "GET" | "POST" | "DELETE" | "PATCH"; url: string; payload?: unknown }> = [
        { method: "GET", url: `/api/events?roomId=${roomId}` },
        { method: "GET", url: `/api/turns?roomId=${roomId}` },
        { method: "POST", url: "/api/turns", payload: { roomId, paneId: pane.id, prompt: "stolen" } },
        { method: "GET", url: `/api/plugins/agent/${pane.id}` },
        { method: "GET", url: `/api/control/v1/layout/${roomId}` },
        { method: "POST", url: "/api/rooms/reorder", payload: { roomIds: [roomId] } },
        { method: "GET", url: `/api/artifacts/${artifact.id}/file` },
        { method: "GET", url: `/api/artifacts/${artifact.id}/download` },
        { method: "DELETE", url: `/api/artifacts/${artifact.id}` }
      ];
      for (const probe of probes) {
        const response = await app.inject({ method: probe.method, url: probe.url, headers: mallory.headers, payload: probe.payload });
        expect(response.statusCode, `${probe.method} ${probe.url} -> ${response.body}`).toBe(404);
        // The refusal never reveals the room behind a pane or an artifact.
        if (!probe.url.includes(roomId) && !JSON.stringify(probe.payload ?? {}).includes(roomId)) expect(response.body).not.toContain(roomId);
      }
      // The owner reaches the same room routes (the artifact file itself is not on disk in this fixture); plugins and
      // Space Control stay closed to every USER (MU-001).
      for (const probe of probes.filter((item) => item.method === "GET" && !item.url.startsWith("/api/artifacts/"))) {
        const response = await app.inject({ method: probe.method, url: probe.url, headers: alice.headers });
        const closed = /^\/api\/(plugins|control)\//.test(probe.url);
        expect(response.statusCode, `${probe.method} ${probe.url} -> ${response.body}`).toBe(closed ? 404 : 200);
      }
      const ownFile = await app.inject({ method: "GET", url: `/api/artifacts/${artifact.id}/file`, headers: alice.headers });
      expect(ownFile.json().error.message).not.toContain(artifact.id);
      const refusedFile = await app.inject({ method: "GET", url: `/api/artifacts/${artifact.id}/file`, headers: mallory.headers });
      expect(refusedFile.json().error.message).toBe(`Artifact ${artifact.id} was not found.`);
      const listed = await app.inject({ method: "GET", url: "/api/artifacts", headers: mallory.headers });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().data.map((item: { id: string }) => item.id)).not.toContain(artifact.id);
      const ownList = await app.inject({ method: "GET", url: "/api/artifacts", headers: alice.headers });
      expect(ownList.json().data.map((item: { id: string }) => item.id)).toContain(artifact.id);
      const ownEvents = await app.inject({ method: "GET", url: `/api/events?roomId=${roomId}`, headers: alice.headers });
      expect(ownEvents.statusCode, ownEvents.body).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("streams and lists only a USER's own rooms' events", async () => {
    const { app, store, adminCookie } = await createTestApp();
    const controller = new AbortController();
    try {
      const alice = await sessionFor(app, store, { id: "user:alice", email: "alice@space.local", role: "USER" });
      const mallory = await sessionFor(app, store, { id: "user:mallory", email: "mallory@space.local", role: "USER" });
      const create = async (headers: Record<string, string>, name: string) => {
        const created = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name, initialPaneCount: 0 } })).json();
        return (created.room ?? created).id as string;
      };
      const aliceRoom = await create(alice.headers, "Alice room");
      const malloryRoom = await create(mallory.headers, "Mallory room");

      const listed = await app.inject({ method: "GET", url: "/api/events", headers: mallory.headers });
      expect(listed.json().data).toEqual([]);
      const adminList = await app.inject({ method: "GET", url: "/api/events", headers: { cookie: adminCookie } });
      expect(adminList.body).toContain(aliceRoom);

      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${address}/api/events/stream?replayLimit=200`, { headers: { cookie: mallory.cookie }, signal: controller.signal });
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
      expect(text).toContain(malloryRoom);
      expect(text).not.toContain(aliceRoom);

      const aliceLater = await create(alice.headers, "Alice later");
      await create(mallory.headers, "Mallory later");
      await readUntil("Room Mallory later created.");
      expect(text).not.toContain(aliceRoom);
      expect(text).not.toContain(aliceLater);
      expect(text).not.toContain("Alice later");
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
