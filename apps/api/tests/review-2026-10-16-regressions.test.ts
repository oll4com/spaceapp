import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import {
  SessionRevocationStore, csrfHeaderName, defaultSessionRevocationStore, signSession, verifySession,
  type SessionRevocationPersistence
} from "../src/auth.js";
import { deleteEntry } from "../src/files-service.js";
import { decryptSecret, encryptSecret } from "../src/databases/crypto.js";

// Regressions for the external review of v1.1.5 (2026-10-16).
const sessionSecret = "review-secret-0123456789abcdef";
const owner = { id: "user:operator", email: "operator@space.local", role: "ADMIN" as const };
const otherLocalOrigin = { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" };

async function startApp(env: Record<string, string> = {}) {
  const store = new InMemorySpaceStore();
  const user = store.upsertUser(owner);
  const app = await createApp({
    config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false", ...env }),
    store,
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return { app, port, cookie: `space_session=${signSession(user, sessionSecret)}` };
}

function openSocket(url: string, headers: Record<string, string>): Promise<{ ws?: WebSocket; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ ws, status: 101 }));
    ws.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode ?? 0 }));
    ws.once("error", () => resolve({ status: -1 }));
  });
}

function persistence(overrides: Partial<SessionRevocationPersistence> = {}) {
  const signatures = new Map<string, number>();
  const durable: SessionRevocationPersistence = {
    load: async () => ({ signatures: [...signatures], userEpochs: [] }),
    revokeSignature: async (hash, expiresAt) => { signatures.set(hash, expiresAt); },
    revokeUser: async () => undefined,
    pruneExpired: async () => 0,
    ...overrides
  };
  return { durable, signatures };
}

describe("session tokens have exactly two segments (logout bypass)", () => {
  it("rejects extra segments and keeps a revoked token revoked", async () => {
    const store = new SessionRevocationStore();
    const token = signSession(owner, sessionSecret);
    expect(verifySession(`${token}.x`, sessionSecret, store)).toBeNull();
    await store.revokeToken(token);
    expect(verifySession(token, sessionSecret, store)).toBeNull();
    expect(verifySession(`${token}.x`, sessionSecret, store)).toBeNull();
    store.close();
  });

  it("a logged-out cookie with an appended segment stays logged out over HTTP", async () => {
    const { app, cookie } = await startApp();
    try {
      expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(200);
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${cookie}.x` } });
      expect(me.json().isAuthenticated).toBe(false);
    } finally { await app.close(); }
  });
});

describe("a logout is reported saved only when it was saved", () => {
  it("answers 503 when the revocation cannot be persisted, keeps it effective and saves it on the next tick", async () => {
    let failing = true;
    const { durable, signatures } = persistence({
      revokeSignature: async (hash, expiresAt) => {
        if (failing) throw new Error("database unavailable");
        signatures.set(hash, expiresAt);
      }
    });
    const { app, cookie } = await startApp();
    try {
      await defaultSessionRevocationStore.attachPersistence(durable);
      const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
      expect(logout.statusCode).toBe(503);
      expect(logout.json().error.code).toBe("LOGOUT_NOT_SAVED");
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json().isAuthenticated).toBe(false);
      expect(signatures.size).toBe(0);
      failing = false;
      defaultSessionRevocationStore.cleanup();
      await new Promise((resolve) => setImmediate(resolve));
      expect(signatures.size).toBe(1);
    } finally {
      defaultSessionRevocationStore.detachPersistence();
      await app.close();
    }
  });

  it("refuses every session until persisted revocations load, and readyz says so", async () => {
    const store = new SessionRevocationStore();
    const token = signSession(owner, sessionSecret);
    await expect(store.attachPersistence(persistence({ load: async () => { throw new Error("database unavailable"); } }).durable)).rejects.toThrow();
    expect(store.isReady()).toBe(false);
    expect(verifySession(token, sessionSecret, store)).toBeNull();
    await store.attachPersistence(persistence().durable);
    expect(store.isReady()).toBe(true);
    expect(verifySession(token, sessionSecret, store)).toMatchObject({ id: owner.id });
    store.close();

    const { app } = await startApp();
    try {
      await defaultSessionRevocationStore.attachPersistence(persistence({ load: async () => { throw new Error("down"); } }).durable).catch(() => undefined);
      const readyz = (await app.inject({ method: "GET", url: "/readyz" })).json();
      expect(readyz.ok).toBe(false);
      expect(readyz.dependencies.sessionRevocations).toBe("UNAVAILABLE");
    } finally {
      defaultSessionRevocationStore.detachPersistence();
      await app.close();
    }
  });
});

describe("WebSocket upgrades refuse other local origins", () => {
  it("shared-chat live: same-site refused, same-origin still works", async () => {
    const { app, port, cookie } = await startApp();
    try {
      const url = `ws://127.0.0.1:${port}/api/shared-chat/live`;
      const hostile = await openSocket(url, { cookie, ...otherLocalOrigin });
      expect(hostile.status).not.toBe(101);
      const legit = await openSocket(url, { cookie, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
      expect(legit.status).toBe(101);
      const got = new Promise<string>((resolve) => legit.ws!.once("message", (data) => resolve(String(data))));
      const csrf = (await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie, "sec-fetch-site": "same-origin" } })).json().csrfToken;
      await app.inject({
        method: "POST", url: "/api/shared-chat/messages",
        headers: { cookie, "sec-fetch-site": "same-origin", [csrfHeaderName]: csrf }, payload: { content: "hello" }
      });
      expect(await got).toContain("hello");
      legit.ws!.close();
    } finally { await app.close(); }
  });

  it("harness proxy: same-site refused, same-origin still reaches the upstream", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
    upstream.on("connection", (socket) => socket.send("harness"));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { app, port, cookie } = await startApp({ SPACE_HARNESS_ENABLED: "true", SPACE_HARNESS_ORIGIN: `http://127.0.0.1:${upstreamPort}` });
    try {
      const url = `ws://127.0.0.1:${port}/api/remote.mux`;
      expect((await openSocket(url, { cookie, ...otherLocalOrigin })).status).toBe(401);
      expect((await openSocket(url, { cookie, origin: "http://127.0.0.1:5173" })).status).toBe(401);
      const legit = await openSocket(url, { cookie, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
      expect(legit.status).toBe(101);
      legit.ws!.close();
    } finally { await app.close(); upstream.close(); }
  });
});

describe("Admin Mode delete guard follows symlinked ancestors", () => {
  it("refuses the workspace addressed through a symlinked ancestor", async () => {
    const base = await mkdtemp(join(tmpdir(), "hostdel-"));
    try {
      const workspace = join(base, "real", "workspace");
      await mkdir(workspace, { recursive: true });
      await symlink(join(base, "real"), join(base, "alias"));
      await expect(deleteEntry({
        targetPath: join(base, "alias", "workspace"), recursive: true, mode: "admin", user: owner, workspaceRoot: workspace
      })).rejects.toThrow(/protected/);
      await access(workspace);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

describe("stored database passwords require a full GCM tag", () => {
  it("round-trips and rejects a truncated tag", () => {
    process.env.SPACE_SESSION_SECRET ??= sessionSecret;
    const sealed = encryptSecret("pw");
    expect(decryptSecret(sealed)).toBe("pw");
    const parsed = JSON.parse(sealed);
    parsed.tag = Buffer.from(parsed.tag, "base64").subarray(0, 4).toString("base64");
    expect(() => decryptSecret(JSON.stringify(parsed))).toThrow(/CREDENTIAL_UNREADABLE/);
  });
});
