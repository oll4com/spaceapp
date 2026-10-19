import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// Multi-user accounts (plan clipboard:VrMJ14wJPmVs step 2): invites, per-user sign-in and disabled users,
// only with SPACE_MULTI_USER_ENABLED=true.
const sessionSecret = "multi-user-accounts-test-secret";
const APP_LIFECYCLE_TIMEOUT_MS = 60_000;
const password = "correct horse battery staple";

async function harness(multiUser: boolean) {
  const store = new InMemorySpaceStore();
  const owner = { id: "user:owner", email: "owner@example.com", role: "ADMIN" as const };
  store.upsertUser(owner);
  const app = await createApp({
    store,
    config: getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false",
      ...(multiUser ? { SPACE_MULTI_USER_ENABLED: "true" } : {}) }),
    auth: { sessionSecret, devLogin: false, secureCookies: false }
  });
  const sessionFor = (user: { id: string; email: string; role: "ADMIN" | "USER" | "OPERATOR" }) => {
    const token = signSession(user, sessionSecret);
    return { cookie: `${cookieName}=${token}`, [csrfHeaderName]: createCsrfToken(token, sessionSecret)! };
  };
  return { app, store, admin: sessionFor(owner), sessionFor };
}

const cookieOf = (response: { cookies: Array<{ name: string; value: string }> }) => {
  const value = response.cookies.find((entry) => entry.name === cookieName)?.value;
  return value ? { cookie: `${cookieName}=${value}`, [csrfHeaderName]: createCsrfToken(value, sessionSecret)! } : null;
};

describe("multi-user accounts", () => {
  it("answer 404 while SPACE_MULTI_USER_ENABLED is off", async () => {
    const { app, admin } = await harness(false);
    try {
      const invite = await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: admin, payload: { email: "dev@example.com" } });
      expect(invite.statusCode).toBe(404);
      const accept = await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token: "x".repeat(43), password } });
      expect(accept.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, APP_LIFECYCLE_TIMEOUT_MS);

  it("invite, accept once, sign in with the own password, disable and enable again", async () => {
    const { app, store, admin, sessionFor } = await harness(true);
    try {
      const notAdmin = sessionFor({ id: "user:someone", email: "someone@example.com", role: "OPERATOR" });
      store.upsertUser({ id: "user:someone", email: "someone@example.com", role: "OPERATOR" });
      expect((await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: notAdmin, payload: { email: "dev@example.com" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: admin, payload: { email: "owner@example.com" } })).statusCode).toBe(409);

      const created = await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: admin, payload: { email: "Dev@Example.com" } });
      expect(created.statusCode).toBe(201);
      const { invite, token } = created.json() as { invite: { id: string; email: string; role: string }; token: string };
      expect(invite).toMatchObject({ email: "dev@example.com", role: "USER", acceptedAt: null });
      const listed = await app.inject({ method: "GET", url: "/api/admin/users/invites", headers: admin });
      expect(JSON.stringify(listed.json())).not.toContain(token);

      expect((await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token: `${token}x`, password } })).statusCode).toBe(400);
      const accepted = await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token, password } });
      expect(accepted.statusCode).toBe(200);
      const user = (accepted.json() as { user: { id: string; email: string; role: string } }).user;
      expect(user).toMatchObject({ email: "dev@example.com", role: "USER" });
      const acceptedSession = cookieOf(accepted)!;
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: acceptedSession })).json()).toMatchObject({ isAuthenticated: true });
      expect((await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token, password } })).statusCode).toBe(400);

      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@example.com", password: "wrong password value" } })).statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@example.com", password } });
      expect(login.statusCode).toBe(200);
      expect((login.json() as { user: { id: string } }).user.id).toBe(user.id);

      expect((await app.inject({ method: "PATCH", url: "/api/admin/users/user:owner/disabled", headers: admin, payload: { disabled: true } })).statusCode).toBe(409);
      const disabled = await app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}/disabled`, headers: admin, payload: { disabled: true } });
      expect(disabled.statusCode).toBe(200);
      // Disabling ends the sessions it already has and refuses a new sign-in.
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: acceptedSession })).json()).toMatchObject({ isAuthenticated: false });
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@example.com", password } })).statusCode).toBe(401);
      // A session issued after disabling (e.g. through a linked Google account) still gets no access.
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionFor({ id: user.id, email: user.email, role: "USER" }) })).json())
        .toMatchObject({ isAuthenticated: false });

      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}/disabled`, headers: admin, payload: { disabled: false } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@example.com", password } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, APP_LIFECYCLE_TIMEOUT_MS);

  it("a sign-in for an email without an account takes the password-check time too (no email enumeration)", async () => {
    const { app, admin } = await harness(true);
    try {
      const { token } = (await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: admin, payload: { email: "dev@example.com" } })).json() as { token: string };
      expect((await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token, password } })).statusCode).toBe(200);
      const timed = async (email: string) => {
        const started = performance.now();
        expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong password value" } })).statusCode).toBe(401);
        return performance.now() - started;
      };
      await timed("nobody@example.com"); // the decoy hash is made once, on the first such sign-in
      const known = Math.min(await timed("dev@example.com"), await timed("dev@example.com"));
      const unknown = Math.min(await timed("nobody@example.com"), await timed("nobody@example.com"));
      expect(unknown).toBeGreaterThan(known * 0.5);
    } finally {
      await app.close();
    }
  }, APP_LIFECYCLE_TIMEOUT_MS);

  it("a disabled account gets no session even after the flag is turned off", async () => {
    const { app, store, sessionFor } = await harness(false);
    try {
      store.upsertUser({ id: "user:former", email: "former@example.com", role: "USER" });
      store.setUserDisabled("user:former", true);
      const session = sessionFor({ id: "user:former", email: "former@example.com", role: "USER" });
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: session })).json()).toMatchObject({ isAuthenticated: false });
    } finally {
      await app.close();
    }
  }, APP_LIFECYCLE_TIMEOUT_MS);

  it("a revoked or expired invite cannot be accepted", async () => {
    const { app, store, admin } = await harness(true);
    try {
      const created = await app.inject({ method: "POST", url: "/api/admin/users/invites", headers: admin, payload: { email: "revoked@example.com", role: "OPERATOR" } });
      const { invite, token } = created.json() as { invite: { id: string }; token: string };
      expect((await app.inject({ method: "DELETE", url: `/api/admin/users/invites/${invite.id}`, headers: admin })).statusCode).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/api/admin/users/invites/${invite.id}`, headers: admin })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token, password } })).statusCode).toBe(400);

      const { createHash } = await import("node:crypto");
      const expiredToken = "e".repeat(43);
      store.createUserInvite({
        tokenSha256: createHash("sha256").update(expiredToken).digest("hex"), email: "late@example.com", role: "USER",
        createdBy: "user:owner", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z"
      });
      expect((await app.inject({ method: "POST", url: "/api/auth/invites/accept", payload: { token: expiredToken, password } })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, APP_LIFECYCLE_TIMEOUT_MS);
});
