import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCanonicalSpaceMemoryBridge, InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// Multi-user step 3 (plan clipboard:evAaFYqrgDfd): every registered route and WebSocket that names a room, pane or
// artifact answers 404 to another USER, and a VIEW share never writes. The route list comes from the app itself, so
// a new route is covered without editing this test.
function registeredRoutes(tree: string): string[] {
  const routes = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const match = /^([\s│├└─]*)(\S+?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!match || !match[2]) continue;
    stack.length = match[1]!.length / 4;
    stack.push(match[2].split("|")[0]!);
    for (const method of match[3]?.split(", ") ?? []) if (method !== "HEAD" && method !== "OPTIONS") routes.add(`${method} ${stack.join("")}`);
  }
  return [...routes].sort();
}

it("hides another user's rooms, panes and artifacts on every route, and VIEW never writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-route-matrix-"));
  const indexPath = join(root, "space_memory.md");
  const monthlyPath = join(root, "space_memory_2026-10.md");
  await writeFile(indexPath, "# Test memory\n");
  await writeFile(monthlyPath, "# Test monthly memory\n");
  const store = new InMemorySpaceStore();
  const secret = "route-matrix-session-secret";
  const app = await createApp({
    store,
    config: { ...getApiConfig({ SPACE_LOG_LEVEL: "silent" }), multiUserEnabled: true, spaceMemoryIndexPath: indexPath, spaceMemoryMonthlyPath: monthlyPath, spaceMemoryLockPath: join(root, "memory.lock") },
    canonicalMemory: createCanonicalSpaceMemoryBridge({ indexPath, monthlyPath }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false },
    systemAnalyticsService: { sample: async () => {}, rollupAndSweep: async () => {}, backfill: async () => {}, dispose: async () => {} } as any
  });
  try {
    const session = async (user: AuthUser) => {
      await store.upsertUser(user);
      const cookie = `${cookieName}=${signSession(user, secret)}`;
      const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
      return { cookie, [csrfHeaderName]: csrf };
    };
    const alice = await session({ id: "user:alice", email: "alice@space.local", role: "USER" });
    const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
    const carol = await session({ id: "user:carol", email: "carol@space.local", role: "USER" });
    const room = store.createRoom({ name: "Alice room", initialPaneCount: 0 }, "trace:matrix", "user:alice");
    const pane = store.createPane({ roomId: room.id, title: "Alice pane", mode: "CHAT" }, "trace:matrix");
    const { artifact } = store.createArtifact({ roomId: room.id, kind: "EXPORT", mimeType: "text/plain",
      storageUri: "space-artifact://browser-evidence/fixture/alice.txt", byteSize: 7, sha256: "a".repeat(64), metadata: {} });
    expect((await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/shares/user:carol`, headers: alice, payload: { permission: "VIEW" } })).statusCode).toBe(200);

    const idFor = (path: string) => path.startsWith("/api/panes/") ? pane.id : path.startsWith("/api/artifacts/") ? artifact.id : room.id;
    const routes = registeredRoutes(app.printRoutes({ commonPrefix: false })).filter((route) =>
      /^\S+ \/api\/(rooms|proof-rooms|panes|artifacts)\/:id\b/.test(route) || /:(roomId|paneId)\b/.test(route));
    expect(routes.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    const writes: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(" ") as [string, string];
      // Ids contain ":", so the other parameters are filled first.
      const url = path.replace(/:(?!id\b|roomId\b|paneId\b)[A-Za-z0-9_]+/g, "x").replace(/\*/g, "x")
        .replace(/:id\b/, idFor(path)).replace(/:roomId\b/g, room.id).replace(/:paneId\b/g, pane.id);
      const body = method === "GET" || method === "DELETE" ? {} : { payload: "{}" };
      const request = (headers: Record<string, string>) => app.inject({ method: method as "GET", url,
        headers: method === "GET" || method === "DELETE" ? headers : { ...headers, "content-type": "application/json" }, ...body });
      const asBob = await request(bob);
      // T3 Code checks its single owner account in its own onRequest hook, before the shared check.
      const ownGate = path.startsWith("/api/t3code/");
      if (ownGate ? asBob.statusCode < 400 : asBob.statusCode !== 404) leaks.push(`${route} ${asBob.statusCode}`);
      if (method !== "GET") {
        const asCarol = await request(carol);
        // 403 from the share check, or 404 for a family a USER never reaches with multi-user on.
        if (ownGate ? asCarol.statusCode < 400 : ![403, 404].includes(asCarol.statusCode)) writes.push(`${route} ${asCarol.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(writes).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 600_000);
