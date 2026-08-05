import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import {
  cookieName,
  createCsrfToken,
  csrfHeaderName,
  hashPassword,
  signSession
} from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { createOwnerSetupBootstrap } from "../src/owner-setup.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

describe("public single-owner setup API", () => {
  it("claims an expiring token once, creates a session, and enables later owner login", async () => {
    const token = "setup-token-value-with-at-least-thirty-two-characters";
    const legacyPassword = "legacy operator password";
    const sessionSecret = "test-session-secret-with-enough-length";
    const store = new InMemorySpaceStore();
    let connectionState: "NEEDS_SETUP" | "CONNECTED" = "NEEDS_SETUP";
    let verifyAllCalls = 0;
    const setupConnections: SetupConnectionsService = {
      overview: async () => [{
        id: "cli:codex",
        label: "Codex CLI",
        providerName: "Codex",
        category: "AI coding CLI",
        state: connectionState,
        functionalState: connectionState === "CONNECTED" ? "FUNCTIONAL" : "NEEDS_SETUP",
        liveVerificationState: connectionState === "CONNECTED" ? "VERIFIED" : "NOT_CHECKED",
        reasonCode: connectionState === "CONNECTED" ? null : "CREDENTIAL_REQUIRED",
        verifiedAt: connectionState === "CONNECTED" ? "2026-07-29T10:00:00.000Z" : null,
        staleAt: connectionState === "CONNECTED" ? "2026-08-28T10:00:00.000Z" : null,
        actions: connectionState === "CONNECTED" ? ["VERIFY"] : ["OPEN_LOGIN_PANE", "VERIFY"]
      }],
      verify: async (connectionId) => {
        expect(connectionId).toBe("cli:codex");
        connectionState = "CONNECTED";
        return (await setupConnections.overview())[0]!;
      },
      verifyAll: async () => {
        verifyAllCalls += 1;
        connectionState = "CONNECTED";
        return setupConnections.overview();
      },
      recordVerifiedEvidence: async () => {
        connectionState = "CONNECTED";
        return (await setupConnections.overview())[0]!;
      }
    };
    const app = await createApp({
      store,
      setupConnections,
      auth: {
        sessionSecret,
        operatorEmail: "legacy@example.com",
        operatorPasswordHash: await hashPassword(legacyPassword),
        devLogin: false,
        secureCookies: false
      },
      setup: createOwnerSetupBootstrap(token, "2099-07-23T12:15:00.000Z"),
      config: getApiConfig({
        SPACE_BROWSER_EVIDENCE_ENABLED: "false",
        SPACE_BROWSER_SESSIONS_ENABLED: "false"
      })
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

    const operatorToken = signSession(
      { id: "user:read-only-operator", email: "operator@example.com", role: "OPERATOR" },
      sessionSecret
    );
    const operatorCookie = `${cookieName}=${operatorToken}`;
    const operatorCsrfToken = createCsrfToken(operatorToken, sessionSecret)!;
    const operatorOverview = await app.inject({
      method: "GET",
      url: "/api/setup/overview",
      headers: { cookie: operatorCookie }
    });
    expect(operatorOverview.statusCode).toBe(403);
    for (const url of [
      "/api/setup/starter-room",
      "/api/setup/connections/cli:codex/verify",
      "/api/setup/connections/verify-all",
      "/api/setup/finish"
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          cookie: operatorCookie,
          [csrfHeaderName]: operatorCsrfToken
        }
      });
      expect(response.statusCode).toBe(403);
    }

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
      isSetupRequired: false,
      onboardingVersion: 1,
      isOnboardingComplete: false
    });
    const starterRoomId = claimed.json().starterRoomId as string;
    expect(starterRoomId).toMatch(/^room:/);
    expect(store.listRooms()).toEqual([
      expect.objectContaining({
        id: starterRoomId,
        name: "Getting Started"
      })
    ]);
    expect(store.listPanes(starterRoomId)).toEqual([]);

    const sessionCookie = `${claimed.cookies[0]!.name}=${claimed.cookies[0]!.value}`;
    const csrf = await app.inject({
      method: "GET",
      url: "/api/auth/csrf",
      headers: { cookie: sessionCookie }
    });
    expect(csrf.statusCode).toBe(200);
    const csrfPayload = csrf.json() as { csrfToken: string; headerName: string };

    const overview = await app.inject({
      method: "GET",
      url: "/api/setup/overview",
      headers: { cookie: sessionCookie }
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toEqual({
      onboardingVersion: 1,
      isComplete: false,
      completedAt: null,
      starterRoomId,
      summary: {
        total: 1,
        functional: 0,
        liveVerified: 0,
        needsSetup: 1
      },
      connections: [
        expect.objectContaining({
          id: "cli:codex",
          state: "NEEDS_SETUP",
          reasonCode: "CREDENTIAL_REQUIRED"
        })
      ]
    });

    const verified = await app.inject({
      method: "POST",
      url: "/api/setup/connections/cli:codex/verify",
      headers: {
        cookie: sessionCookie,
        [csrfPayload.headerName]: csrfPayload.csrfToken
      }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      id: "cli:codex",
      state: "CONNECTED",
      reasonCode: null
    });

    const verifiedAll = await app.inject({
      method: "POST",
      url: "/api/setup/connections/verify-all",
      headers: {
        cookie: sessionCookie,
        [csrfPayload.headerName]: csrfPayload.csrfToken
      }
    });
    expect(verifiedAll.statusCode).toBe(200);
    expect(verifiedAll.json()).toMatchObject({
      connections: [expect.objectContaining({ id: "cli:codex", state: "CONNECTED" })]
    });
    expect(verifyAllCalls).toBe(1);

    const ensured = await app.inject({
      method: "POST",
      url: "/api/setup/starter-room",
      headers: {
        cookie: sessionCookie,
        [csrfPayload.headerName]: csrfPayload.csrfToken
      }
    });
    expect(ensured.statusCode).toBe(200);
    expect(ensured.json()).toMatchObject({
      room: { id: starterRoomId, name: "Getting Started" },
      onboarding: { starterRoomId }
    });
    expect(store.listRooms()).toHaveLength(1);

    const finished = await app.inject({
      method: "POST",
      url: "/api/setup/finish",
      headers: {
        cookie: sessionCookie,
        [csrfPayload.headerName]: csrfPayload.csrfToken
      }
    });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({
      onboardingVersion: 1,
      isComplete: true,
      starterRoomId,
      connections: [expect.objectContaining({ id: "cli:codex", state: "CONNECTED" })]
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
