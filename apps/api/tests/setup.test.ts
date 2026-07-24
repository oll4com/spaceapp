import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createOwnerSetupBootstrap } from "../src/owner-setup.js";

describe("public single-owner setup API", () => {
  it("claims an expiring token once, creates a session, and enables later owner login", async () => {
    const token = "setup-token-value-with-at-least-thirty-two-characters";
    const legacyPassword = "legacy operator password";
    const store = new InMemorySpaceStore();
    const app = await createApp({
      store,
      auth: {
        sessionSecret: "test-session-secret-with-enough-length",
        operatorEmail: "legacy@example.com",
        operatorPasswordHash: await hashPassword(legacyPassword),
        devLogin: false,
        secureCookies: false
      },
      setup: createOwnerSetupBootstrap(token, "2099-07-23T12:15:00.000Z"),
      config: getApiConfig({
        SPACE_BROWSER_EVIDENCE_ENABLED: "false",
        SPACE_BROWSER_HOST_TRANSPORT: "unix",
        SPACE_BROWSER_SESSIONS_ENABLED: "false",
        SPACE_DATABASE_URL: "postgres://spaceapp:test@postgres/spaceapp",
        SPACE_RUNTIME_STORE: "postgres"
      }),
      workerReadinessChecker: async () => ({
        id: "space-worker",
        status: "RUNNING",
        statusReason: "Test worker is ready.",
        address: "temporal:7233",
        namespace: "default",
        taskQueue: "space",
        reachable: true,
        workflowPollerCount: 1,
        activityPollerCount: 1,
        pollerCount: 2,
        workflowBacklogCount: 0,
        activityBacklogCount: 0,
        pollerIdentities: ["test-worker"],
        lastPollerAccessAt: "2026-07-24T00:00:00.000Z",
        checkedAt: "2026-07-24T00:00:00.000Z"
      })
    });

    const readiness = await app.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      ok: true,
      dependencies: {
        browserHost: "DISABLED"
      }
    });

    const initial = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      setupRequired: true,
      expiresAt: "2099-07-23T12:15:00.000Z"
    });
    const initialAuth = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(initialAuth.json()).toMatchObject({
      isAuthenticated: false,
      isSetupRequired: true
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/setup/claim",
      payload: {
        token: "wrong-token-value-with-at-least-thirty-two-characters",
        email: "owner@example.com",
        password: "correct horse battery staple"
      }
    });
    expect(rejected.statusCode).toBe(409);
    expect(store.getOwnerCredentials()).toBeNull();

    const claimed = await app.inject({
      method: "POST",
      url: "/api/setup/claim",
      payload: {
        token,
        email: "owner@example.com",
        password: "correct horse battery staple"
      }
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.cookies[0]?.name).toBe("space_session");
    expect(claimed.json()).toMatchObject({
      user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
      isAuthenticated: true,
      isSetupRequired: false
    });

    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toEqual({ setupRequired: false, expiresAt: null });
    const claimedAuth = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(claimedAuth.json()).toMatchObject({
      isAuthenticated: false,
      isSetupRequired: false
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "owner@example.com",
        password: "correct horse battery staple"
      }
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies[0]?.name).toBe("space_session");

    const legacyLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "legacy@example.com",
        password: legacyPassword
      }
    });
    expect(legacyLogin.statusCode).toBe(401);

    const secondClaim = await app.inject({
      method: "POST",
      url: "/api/setup/claim",
      payload: {
        token,
        email: "other@example.com",
        password: "another correct horse battery"
      }
    });
    expect(secondClaim.statusCode).toBe(409);

    await app.close();
  });
});
