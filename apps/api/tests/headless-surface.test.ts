import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { AccountLifecycle } from "../src/computer/accounts.js";
import type { TenantAiKeys } from "../src/computer/ai-key.js";
import { HEADLESS_ROUTES } from "../src/headless-surface.js";

// K2 §3 guard: headless keeps a handler only on HEADLESS_ROUTES, each of them a real route, and each signed-in one refuses a stranger.
const sessionSecret = "headless-surface-test-secret";
// A disabled route answers 404, so a listed one is live when it answers anything else (signed-in ones: 401 without a session).
const PUBLIC = new Set(["GET /healthz", "GET /readyz", "GET /api/auth/me", "POST /api/auth/logout", "GET /api/auth/google/start",
  "GET /api/auth/google/callback", "POST /api/auth/app-handoff", "GET /api/cli/nous/mcp"]);
const WEBSOCKET_ONLY = "GET /api/mobile/channel"; // answers plain HTTP 404 self-hosted too
const admin = () => {
  const session = signSession({ id: "user:admin", email: "admin@example.test", role: "ADMIN" }, sessionSecret);
  return { cookie: `space_session=${session}`, [csrfHeaderName]: createCsrfToken(session, sessionSecret)! };
};
const build = (headless: boolean) => createApp({ store: new InMemorySpaceStore(), config: { ...getApiConfig({ SPACE_LOG_LEVEL: "silent" }), headless },
  auth: { sessionSecret, devLogin: false, secureCookies: false }, accountLifecycle: {} as AccountLifecycle, accountAiKeys: {} as TenantAiKeys });

describe("headless route surface", () => {
  let headless: FastifyInstance, selfHosted: FastifyInstance;
  beforeAll(async () => {
    [headless, selfHosted] = await Promise.all([build(true), build(false)]);
    await Promise.all([headless.ready(), selfHosted.ready()]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([headless?.close(), selfHosted?.close()]);
  });

  it("keeps every listed route registered and live, and every signed-in one refuses no session", async () => {
    for (const key of Object.keys(HEADLESS_ROUTES)) {
      const [method, url] = key.split(" ") as [HTTPMethods, string];
      expect(headless.hasRoute({ method, url }), `${key} is not a registered route`).toBe(true);
      if (key === WEBSOCKET_ONLY) continue;
      const { statusCode } = await headless.inject({ method, url: url.replace(/:\w+/g, "x") });
      if (PUBLIC.has(key)) expect(statusCode, key).not.toBe(404);
      else expect([401, 403], `${key} answered ${statusCode} without a session`).toContain(statusCode);
    }
  });

  it("answers not found on every other route, even for an administrator, and keeps the query rules", async () => {
    for (const [method, url] of [["GET", "/api/rooms"], ["HEAD", "/api/rooms"], ["POST", "/api/auth/login"], ["GET", "/api/admin/cli-sessions"],
      ["GET", "/api/nous/pane-board"], ["GET", "/api/clipboard-items?source=NOTE"], ["GET", "/api/clipboard-items"]] as const) {
      expect((await headless.inject({ method, url, headers: admin() })).statusCode, `${method} ${url}`).toBe(404);
    }
    // Without a session the global guard answers first; a disabled route still looks like one that never existed.
    const anonymous = async (url: string) => { const response = await headless.inject({ method: "GET", url }); return [response.statusCode, response.json().error?.code]; };
    expect(await anonymous("/api/rooms")).toEqual(await anonymous("/api/no-such-route"));
    expect((await headless.inject({ method: "GET", url: "/api/clipboard-items?source=PLAN", headers: admin() })).statusCode).toBe(200);
    expect((await selfHosted.inject({ method: "GET", url: "/api/rooms", headers: admin() })).statusCode).toBe(200);
  });
});
