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
  const secret = "local-composer-test-session-secret";
  const headersFor = (user: AuthUser) => {
    const token = signSession(user, secret);
    return { cookie: `${cookieName}=${token}`, [csrfHeaderName]: createCsrfToken(token, secret)! };
  };
  const build = async (multiUserEnabled = false) => {
    const store = new InMemorySpaceStore();
    const alice: AuthUser = { id: "user:alice", email: "alice@example.test", role: "ADMIN" };
    const bob: AuthUser = { id: "user:bob", email: "bob@example.test", role: "USER" };
    const admin: AuthUser = { id: "user:other-admin", email: "other@example.test", role: "ADMIN" };
    for (const user of [alice, bob, admin]) store.upsertUser(user);
    const room = store.createRoom({ name: "Owned composer", initialPaneCount: 0 }, "trace:composer", alice.id);
    const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude", cwd: "/etc" });
    const app = await createApp({ store, config: { ...getApiConfig({ SPACE_CLI_ENABLED: "false" }), multiUserEnabled },
      auth: { sessionSecret: secret, devLogin: true, secureCookies: false },
      systemAnalyticsService: { sample: async () => {}, rollupAndSweep: async () => {}, backfill: async () => {}, dispose: async () => {} } as unknown as SystemAnalyticsService });
    return { store, alice, bob, admin, room, pane, app };
  };

  it("keeps authentication, CSRF, proof scope and the terminal's room-access rule on both route registrations", async () => {
    const { alice, bob, admin, pane, app } = await build();
    const send = vi.spyOn(CliTerminalManager.prototype, "sendInput");
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
      // A USER without the room is refused; an administrator reaches it as Space Control prompts and the terminal do (stable 1/11:
      // SpaceApp Android signed in as another ADMIN prompted a pane but its keys got 404, plan clipboard:1cZ-YxU8zS2O N1).
      expect((await app.inject({ method: "POST", url, payload, headers: headersFor(bob) })).statusCode).toBe(404);
      expect((await app.inject({ url: receiptUrl, headers: headersFor(bob) })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/panes/${pane.id}/cli/keys`, payload: { expectedSessionId: "cli_session:composer", keys: ["ESCAPE"] }, headers: headersFor(bob) })).statusCode).toBe(404);
      for (const user of [alice, admin]) {
        const read = await app.inject({ url: receiptUrl, headers: headersFor(user) });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({ status: "NOT_FOUND", sessionId: null });
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
      await app.close();
    }
  });

  it("keeps multi-user strictness: only the pane's opener types, and an administrator without it gets 404", async () => {
    const { store, alice, bob, admin, room, pane, app } = await build(true);
    store.setPaneOwner(pane.id, bob.id);
    store.setRoomShare({ roomId: room.id, userId: bob.id, permission: "COLLABORATE", createdBy: alice.id, createdAt: "2026-11-02T00:00:00.000Z" });
    const receiptUrl = `/api/panes/${pane.id}/cli/local-composer/submissions/${randomUUID()}`;
    try {
      for (const user of [admin, alice]) {
        expect((await app.inject({ url: receiptUrl, headers: headersFor(user) })).statusCode).toBe(404);
        expect((await app.inject({ method: "POST", url: `/api/panes/${pane.id}/cli/keys`, payload: { expectedSessionId: "cli_session:composer", keys: ["ESCAPE"] }, headers: headersFor(user) })).statusCode).toBe(404);
      }
      expect((await app.inject({ url: receiptUrl, headers: headersFor(bob) })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
