import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import type { SystemAnalyticsService } from "../src/system-analytics-service.js";

describe("local composer application authentication", () => {
  it("keeps authentication, CSRF, proof scope and owner checks on both new route registrations", async () => {
    const secret = "local-composer-test-session-secret";
    const store = new InMemorySpaceStore();
    const alice: AuthUser = { id: "user:alice", email: "alice@example.test", role: "ADMIN" };
    const bob: AuthUser = { id: "user:bob", email: "bob@example.test", role: "USER" };
    const admin: AuthUser = { id: "user:other-admin", email: "other@example.test", role: "ADMIN" };
    for (const user of [alice, bob, admin]) store.upsertUser(user);
    const room = store.createRoom({ name: "Owned composer", initialPaneCount: 0 }, "trace:composer", alice.id);
    const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
    const app = await createApp({ store, config: getApiConfig({ SPACE_CLI_ENABLED: "false" }),
      auth: { sessionSecret: secret, devLogin: true, secureCookies: false },
      systemAnalyticsService: { sample: async () => {}, rollupAndSweep: async () => {}, backfill: async () => {}, dispose: async () => {} } as unknown as SystemAnalyticsService });
    const send = vi.spyOn(CliTerminalManager.prototype, "sendInput");
    const headersFor = (user: AuthUser) => {
      const token = signSession(user, secret);
      return { cookie: `${cookieName}=${token}`, [csrfHeaderName]: createCsrfToken(token, secret)! };
    };
    const payload = { submissionId: randomUUID(), expectedSessionId: "cli_session:composer", text: "hello" };
    const url = `/api/panes/${pane.id}/cli/local-composer/submissions`;
    const receiptUrl = `${url}/${payload.submissionId}`;
    try {
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      expect((await app.inject({ url: receiptUrl })).statusCode).toBe(401);
      const missingCsrf = await app.inject({ method: "POST", url, payload, headers: { cookie: headersFor(alice).cookie } });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json().error.code).toBe("CSRF_INVALID");
      for (const scope of [{ proofScope: "READ_ONLY" as const }, { automationScope: "APP_DIAGNOSTICS" as const }]) {
        expect((await app.inject({ method: "POST", url, payload, headers: headersFor({ ...alice, ...scope }) })).statusCode).toBe(403);
      }
      for (const user of [bob, admin]) {
        expect((await app.inject({ method: "POST", url, payload, headers: headersFor(user) })).statusCode).toBe(404);
        expect((await app.inject({ url: receiptUrl, headers: headersFor(user) })).statusCode).toBe(404);
      }
      const owned = await app.inject({ url: receiptUrl, headers: headersFor(alice) });
      expect(owned.statusCode, owned.body).toBe(200);
      expect(owned.json()).toMatchObject({ status: "NOT_FOUND", sessionId: null });
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
      await app.close();
    }
  });
});
