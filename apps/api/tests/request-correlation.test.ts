import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { InMemorySpaceStore } from "@space/runtime";


it("uses one server-owned identifier for request logs, error responses and audit correlation", async () => {
  const app = await createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({ SPACE_STORE_MODE: "memory" }),
    auth: { sessionSecret: "correlation-fixture-secret-123456", devLogin: false, secureCookies: false }
  });
  const observed: Array<{ id: string; traceId: string; logId: unknown }> = [];
  app.addHook("onResponse", async request => {
    observed.push({ id: request.id, traceId: request.requestIdForSpace, logId: request.log.bindings().reqId });
  });
  try {
    const response = await app.inject({ url: "/api/rooms", headers: { "x-request-id": "untrusted-client-value" } });
    expect(response.statusCode).toBe(401);
    const traceId = response.json().error.requestId;
    expect(traceId).toMatch(/^req:[\w-]{12}$/);
    expect(response.headers["x-request-id"]).toBe(traceId);
    expect(observed).toEqual([{ id: traceId, traceId, logId: traceId }]);
    const next = await app.inject("/healthz");
    expect(next.headers["x-request-id"]).not.toBe(traceId);
    expect(next.headers["x-request-id"]).toMatch(/^req:[\w-]{12}$/);
  } finally { await app.close(); }
}, 120_000);

// OBS-006: one request's request log line, audit record and error answer carry the same server-minted id.
it("writes the request log line and the audit record of one request under the id it answered with", async () => {
  const { Writable } = await import("node:stream");
  const { cookieName, createCsrfToken, hashPassword, signSession } = await import("../src/auth.js");
  const secret = "correlation-fixture-secret-123456";
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  const owner = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.test", passwordHash: await hashPassword("right horse battery"), now: new Date().toISOString() }).user;
  const log: string[] = [];
  const app = await createApp({
    store, config: getApiConfig({ SPACE_STORE_MODE: "memory" }),
    logStream: new Writable({ write(chunk, _encoding, callback) { log.push(String(chunk)); callback(); } }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false }
  });
  try {
    const token = signSession(owner, secret);
    const response = await app.inject({ method: "POST", url: "/api/auth/password", payload: { currentPassword: "wrong horse battery", newPassword: "a brand new staple phrase" },
      headers: { cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)!, "x-request-id": "untrusted-client-value" } });
    expect(response.statusCode).toBe(401);
    const traceId = response.headers["x-request-id"] as string;
    expect(traceId).toMatch(/^req:[\w-]{12}$/);
    expect(response.json().error.requestId).toBe(traceId);
    const audits = (await store.listAuditEvents()).filter((event) => event.action === "auth.password_change_failed");
    expect(audits).toEqual([expect.objectContaining({ traceId })]);
    const requestLines = log.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { reqId?: string; msg?: string; req?: { url?: string } })
      .filter((line) => line.msg === "request completed" && line.req?.url === "/api/auth/password");
    expect(requestLines.map((line) => line.reqId)).toEqual([traceId]);
  } finally { await app.close(); }
}, 120_000);
