import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";

// A pane CLI's own progress report to Nous (plan clipboard:ot6-jLKOWDNC, slice 2): POST /api/cli/progress.
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-pane-reports-"));
  roots.push(root);
  const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-report-tests", SPACE_ARTIFACT_ROOT: root });
  const store = new InMemorySpaceStore();
  const app = await createApp({ store, config, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Reports", initialPaneCount: 0 } })).json();
  const agentFor = (title: string) => {
    const pane = store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
    return { pane, cliSession, headers: { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!, "content-type": "application/json" } };
  };
  return { app, store, agentFor };
}

describe("CLI progress bridge", () => {
  it("stores a report for the token's own pane only, redacted and within the caps, at most 30 an hour", async () => {
    const { app, store, agentFor } = await fixture();
    const andy = agentFor("Andy");
    const bob = agentFor("Bob");
    const post = (headers: Record<string, string>, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/cli/progress", headers, payload });
    try {
      expect((await app.inject({ method: "POST", url: "/api/cli/progress", payload: { status: "done", summary: "x" } })).statusCode).toBe(401);
      const created = await post(andy.headers, { status: "needs-decision", summary: "Deploy with   Authorization: Bearer abc.def.ghi?", plan: "clipboard:ot6-jLKOWDNC", step: 2,
        needs: "Greece or Thailand; I recommend Greece", report: "full text" });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ status: "NEEDS_DECISION", summary: "Deploy with Authorization: Bearer [REDACTED]?" });
      // The pane comes from the token: a body cannot name another pane, and caps and formats are enforced.
      for (const payload of [
        { status: "done", summary: "x", paneId: bob.pane.id },
        { status: "finished", summary: "x" },
        { status: "done", summary: "" },
        { status: "done", summary: "x".repeat(301) },
        { status: "done", summary: "x", report: "x".repeat(8_001) },
        { status: "done", summary: "x", plan: "plan-1" },
        { status: "done", summary: "x", ticket: "1234" },
        { status: "done", summary: "x", percent: 101 }
      ]) expect((await post(andy.headers, payload)).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(422);
      for (let index = 1; index < 30; index += 1) expect((await post(andy.headers, { status: "progress", summary: `step ${index}` })).statusCode).toBe(201);
      expect((await post(andy.headers, { status: "progress", summary: "one too many" })).statusCode).toBe(429);
      // Another pane has its own budget; a stopped CLI's token reports nothing.
      expect((await post(bob.headers, { status: "started", summary: "Bob starts" })).statusCode).toBe(201);
      store.updatePaneCliSession(bob.cliSession.sessionId, { status: "EXITED", isActive: false });
      expect((await post(bob.headers, { status: "done", summary: "after exit" })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
