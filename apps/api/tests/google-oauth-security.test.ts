import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { signSession, signSessionWithTtl } from "../src/auth.js";

// App shutdown waits for background collectors; shared-host deploys can delay teardown.
const authFixtureTimeoutMs = 30_000;
const sessionSecret = "test-secret-with-enough-length-123456";

describe("Google OAuth & Anonymous Auth Security", () => {
  it("never elevates anonymous requests to user:operator in /api/auth/me", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({
      id: "user:operator",
      email: "operator@space.local",
      role: "ADMIN"
    });

    const app = await createApp({
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        secureCookies: false
      }
    });

    try {
      // Anonymous request without cookies
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me"
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.isAuthenticated).toBe(false);
      expect(body.user).toBeFalsy();
      // Must NOT set a session cookie
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  }, authFixtureTimeoutMs);

  it("requires signed state and signed link cookie for account linking", async () => {
    const store = new InMemorySpaceStore();
    const op = store.upsertUser({
      id: "user:operator",
      email: "operator@space.local",
      role: "ADMIN"
    });

    const app = await createApp({
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        googleClientId: "test-client-id",
        googleClientSecret: "test-client-secret",
        secureCookies: false
      }
    });

    try {
      const opToken = signSession(op, sessionSecret);
      const opCookie = `space_session=${opToken}`;

      // Start linking
      const startRes = await app.inject({
        method: "GET",
        url: "/api/auth/google/start?link=true",
        headers: { cookie: opCookie }
      });

      expect(startRes.statusCode).toBe(302);
      const cookies = startRes.cookies;
      const linkCookie = cookies.find((c) => c.name === "space_oauth_link_user");
      const stateCookie = cookies.find((c) => c.name === "space_oauth_state");
      const pkceCookie = cookies.find((c) => c.name === "space_oauth_pkce");

      expect(linkCookie).toBeDefined();
      expect(stateCookie).toBeDefined();
      expect(pkceCookie).toBeDefined();
      // All must be signed
      expect(linkCookie?.value).toContain(".");
      expect(stateCookie?.value).toContain(".");
      expect(pkceCookie?.value).toContain(".");
      expect(startRes.headers.location).toContain("code_challenge=");
      expect(startRes.headers.location).toContain("code_challenge_method=S256");

      // Callback with tampered link cookie must fail
      const callbackTampered = await app.inject({
        method: "GET",
        url: `/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(stateCookie!.value)}`,
        headers: {
          cookie: `${opCookie}; space_oauth_state=${stateCookie!.value}; space_oauth_link_user=tampered-payload`
        }
      });
      expect(callbackTampered.statusCode).toBe(302);
      expect(callbackTampered.headers.location).toContain("googleLinkError");
    } finally {
      await app.close();
    }
  }, authFixtureTimeoutMs);

  it("rejects account linking requests from proof operators", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        googleClientId: "test-client-id",
        googleClientSecret: "test-client-secret",
        secureCookies: false
      }
    });

    try {
      const proofToken = signSessionWithTtl(
        { id: "user:operator-proof:test", email: "proof@space.test", role: "ADMIN" },
        sessionSecret,
        600
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/auth/google/start?link=true",
        headers: { cookie: `space_session=${proofToken}` }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    } finally {
      await app.close();
    }
  }, authFixtureTimeoutMs);

  it("revokes sessions on logout and allows full account session revocation via /api/auth/logout-all", async () => {
    const store = new InMemorySpaceStore();
    const user = store.upsertUser({
      id: "user:operator",
      email: "operator@space.local",
      role: "ADMIN"
    });

    const app = await createApp({
      config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }),
      store,
      auth: {
        sessionSecret,
        devLogin: false,
        secureCookies: false
      }
    });

    try {
      const token = signSession(user, sessionSecret);
      const sessionCookie = `space_session=${token}`;

      // Request with active session is authenticated
      const meBefore = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: sessionCookie }
      });
      expect(meBefore.json().isAuthenticated).toBe(true);

      // Call logout
      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: sessionCookie }
      });
      expect(logoutRes.statusCode).toBe(200);

      // Now reusing the same token must be rejected because it was revoked
      const meAfter = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: sessionCookie }
      });
      expect(meAfter.json().isAuthenticated).toBe(false);

      // New session for user
      const freshToken = signSession(user, sessionSecret, Date.now() + 2000);
      const freshCookie = `space_session=${freshToken}`;
      const meFresh = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: freshCookie }
      });
      expect(meFresh.json().isAuthenticated).toBe(true);

      // Revoke all sessions
      const logoutAllRes = await app.inject({
        method: "POST",
        url: "/api/auth/logout-all",
        headers: { cookie: freshCookie }
      });
      expect(logoutAllRes.statusCode).toBe(200);

      // Now even freshToken is revoked
      const meAfterAll = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: freshCookie }
      });
      expect(meAfterAll.json().isAuthenticated).toBe(false);
    } finally {
      await app.close();
    }
  }, authFixtureTimeoutMs);
});
