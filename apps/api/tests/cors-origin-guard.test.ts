import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";

// Review F17 (2026-10-14): the session cookie is SameSite=Lax, so a page on another
// port of 127.0.0.1 still sends it. Such a page must not read the CSRF token or change Space.
const secret = "origin-guard-test-secret";
const actor = { id: "user:owner", email: "fixture@example.test", role: "ADMIN" as const, googleId: null, avatarUrl: null };
const otherLocalOrigin = "http://127.0.0.1:5173";
const APP_LIFECYCLE_TIMEOUT_MS = 60_000;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); });

async function fixture() {
  const store = new InMemorySpaceStore();
  vi.spyOn(store, "getControlActor").mockReturnValue(actor);
  app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  const token = signSession(actor, secret);
  return { server: app, cookie: `space_session=${token}`, csrf: createCsrfToken(token, secret)! };
}

it("grants no CORS access to other local origins", async () => {
  const { server, cookie } = await fixture();
  const csrf = await server.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie, origin: otherLocalOrigin, "sec-fetch-site": "same-site" } });
  expect(csrf.statusCode).toBe(403);
  expect(csrf.headers["access-control-allow-origin"]).toBeUndefined();
  const preflight = await server.inject({
    method: "OPTIONS",
    url: "/api/rooms",
    headers: { origin: otherLocalOrigin, "access-control-request-method": "POST", "access-control-request-headers": csrfHeaderName }
  });
  expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
}, APP_LIFECYCLE_TIMEOUT_MS);

it("rejects other-site requests, also on routes without a CSRF token, and keeps same-origin requests working", async () => {
  const { server, cookie, csrf } = await fixture();
  expect((await server.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie, "sec-fetch-site": "same-origin" } })).statusCode).toBe(200);
  for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: otherLocalOrigin }]) {
    const response = await server.inject({ method: "POST", url: "/api/voice/client-error", headers: { cookie, [csrfHeaderName]: csrf, ...headers }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_REJECTED");
  }
  const sameOrigin = await server.inject({ method: "POST", url: "/api/voice/client-error", headers: { cookie, "sec-fetch-site": "same-origin" }, payload: {} });
  expect(sameOrigin.statusCode).not.toBe(403);
}, APP_LIFECYCLE_TIMEOUT_MS);

it("requires the CSRF token to configure Google OAuth", async () => {
  const { server, cookie } = await fixture();
  const response = await server.inject({
    method: "POST",
    url: "/api/auth/google/configure",
    headers: { cookie, "sec-fetch-site": "same-origin" },
    payload: { clientId: "fixture-client", clientSecret: "fixture-secret" }
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe("CSRF_INVALID");
}, APP_LIFECYCLE_TIMEOUT_MS);

it("rejects WebSocket handshakes from another site and keeps same-origin handshakes", async () => {
  // A WebSocket handshake is a GET; the VNC stream and the shared-chat socket used to accept another local port.
  const { server, cookie } = await fixture();
  const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
  for (const url of ["/api/shared-chat/live", "/api/panes/pane:fixture/vnc/stream?host=127.0.0.1&port=5900"]) {
    for (const headers of [{ "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: otherLocalOrigin }]) {
      const response = await server.inject({ method: "GET", url, headers: { cookie, ...upgrade, ...headers } });
      expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
      expect(response.json().error.code).toBe("ORIGIN_REJECTED");
    }
    const sameOrigin = await server.inject({ method: "GET", url, headers: { cookie, ...upgrade, "sec-fetch-site": "same-origin" } });
    expect(sameOrigin.statusCode).not.toBe(403);
  }
}, APP_LIFECYCLE_TIMEOUT_MS);
