import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authUserSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createBrowserSessionManager } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";
import { createSetupBrowserCheck } from "../src/setup-browser-check.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(body = '{"ok":true,"service":"space-api"}') {
  // Chrome's Unix singleton socket cannot fit inside the CLI session's long inherited temp path.
  vi.stubEnv("TMPDIR", "/tmp");
  const root = await mkdtemp(join(tmpdir(), "setup-browser-check-"));
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    response.writeHead(request.url?.startsWith("/healthz?") ? 200 : 404, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const store = new InMemorySpaceStore();
  store.upsertUser(authUserSchema.parse({ id: "user:owner", email: "owner@example.test", role: "ADMIN" }));
  store.upsertUser(authUserSchema.parse({ id: "user:reader", email: "reader@example.test", role: "USER" }));
  const existing = store.createRoom({ name: "Existing workspace", initialPaneCount: 0 }, "existing", "user:owner");
  const existingPane = store.createPane({ roomId: existing.id, title: "Existing browser", mode: "BROWSER" });
  const manager = createBrowserSessionManager({ store, config: getApiConfig({
    SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: origin,
    SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: "false"
  }) });
  const check = createSetupBrowserCheck({ store, manager, origin, profileRoot: root });
  return { store, root, manager, check, paths, existing, existingPane, close: async () => {
    await manager.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe("owned Browser setup function check", () => {
  it("renders the fixed local health fixture through the actual managed browser and cleans only its owned resources", async () => {
    const f = await fixture();
    try {
      const before = await f.check.fingerprint("user:owner");
      await expect(f.check.exercise("user:owner")).resolves.toBeUndefined();
      expect(await f.check.fingerprint("user:owner")).toBe(before);
      expect(f.paths.some(path => /^\/healthz\?setup-check=[a-f0-9-]+$/.test(path))).toBe(true);
      expect(f.store.listRooms("user:owner").map(room => room.id)).toEqual([f.existing.id]);
      expect(f.store.getPane(f.existingPane.id)).toEqual(f.existingPane);
      expect(f.manager.capacity?.().activeSessions).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  }, 30_000);

  it("refuses a reachable page with the wrong fixture content and cleans the failed runtime", async () => {
    const f = await fixture('{"ok":true,"service":"different-api"}');
    try {
      await expect(f.check.exercise("user:owner")).rejects.toThrow("fixture");
      expect(f.paths.some(path => path.startsWith("/healthz?"))).toBe(true);
      expect(f.store.listRooms("user:owner").map(room => room.id)).toEqual([f.existing.id]);
      expect(f.manager.capacity?.().activeSessions).toBe(0);
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  }, 30_000);

  it("refuses unknown and unprivileged actors before opening a room or browser", async () => {
    const f = await fixture();
    try {
      await expect(f.check.exercise("user:reader")).rejects.toThrow();
      await expect(f.check.fingerprint("user:missing")).rejects.toThrow();
      expect(f.paths).toEqual([]);
      expect(f.store.listRooms("user:owner").map(room => room.id)).toEqual([f.existing.id]);
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  });
});
