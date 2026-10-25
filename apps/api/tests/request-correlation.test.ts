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
}, 30_000);
