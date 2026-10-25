import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { signSession } from "../src/auth.js";

const secret = "auto-login-boundary-test-secret";
const actor = { id: "user:operator", email: "fixture@example.test", role: "OPERATOR" as const, googleId: null, avatarUrl: null };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); vi.restoreAllMocks(); });

async function fixture() {
  const store = new InMemorySpaceStore();
  vi.spyOn(store, "getControlActor").mockReturnValue(actor);
  app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret: secret, devLogin: true, secureCookies: false } });
  return app;
}

it("does not create an operator session for an unauthenticated remote visitor", async () => {
  const server = await fixture();
  const result = await server.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "203.0.113.10" });
  expect(result.json().isAuthenticated).toBe(false);
  expect(result.cookies.find(cookie => cookie.name === "space_session")).toBeUndefined();
  expect((await server.inject({ method: "GET", url: "/api/rooms", remoteAddress: "203.0.113.10" })).statusCode).toBe(401);
});

it("treats forwarded remote clients as remote and does not trust spoofed forwarded loopback", async () => {
  const server = await fixture();
  for (const input of [
    { remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.10" } },
    { remoteAddress: "203.0.113.10", headers: { "x-forwarded-for": "127.0.0.1" } }
  ]) {
    expect((await server.inject({ method: "GET", url: "/api/auth/me", ...input })).json().isAuthenticated).toBe(false);
  }
});

it("requires a signed session from loopback clients too and preserves authenticated sessions", async () => {
  // Owner auto-login was removed entirely (main 9a933cd0cb), which is stricter
  // than the earlier loopback-only restriction: no client is signed in implicitly.
  const server = await fixture();
  const local = await server.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "127.0.0.1" });
  expect(local.json().isAuthenticated).toBe(false);
  expect(local.cookies.find(cookie => cookie.name === "space_session")).toBeUndefined();
  expect((await server.inject({ method: "GET", url: "/api/rooms", remoteAddress: "127.0.0.1" })).statusCode).toBe(401);
  const cookie = `space_session=${signSession(actor, secret)}`;
  expect((await server.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "203.0.113.10", headers: { cookie } })).json().isAuthenticated).toBe(true);
  expect((await server.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "127.0.0.1", headers: { cookie } })).json().isAuthenticated).toBe(true);
  expect((await server.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "127.0.0.1", headers: { cookie: "space_logged_out=1" } })).json().isAuthenticated).toBe(false);
});

it("does not fall back to preinstalled owner credentials for a remote visitor", async () => {
  const store = new InMemorySpaceStore();
  vi.spyOn(store, "getOwnerCredentials").mockReturnValue({ user: { ...actor, id: "user:owner", role: "ADMIN" }, passwordHash: "fixture-hash" });
  app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret: secret, devLogin: true, secureCookies: false } });
  const result = await app.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "203.0.113.10" });
  expect(result.json().isAuthenticated).toBe(false);
  expect(result.cookies.find(cookie => cookie.name === "space_session")).toBeUndefined();
});
