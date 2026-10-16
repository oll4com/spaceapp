import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-task-agent-"));
  roots.push(root);
  const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-task-tests", SPACE_ARTIFACT_ROOT: root });
  const store = new InMemorySpaceStore();
  const app = await createApp({ store, config, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Tasks", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
  const agent = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!, "content-type": "application/json" };
  return { app, store, pane, headers, agent };
}

describe("CLI task bridge", () => {
  it("adds a scheduled task for the calling pane that the operator sees in the Tasks dock", async () => {
    const { app, pane, headers, agent } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/cli/task-items" })).statusCode).toBe(401);
      const created = await app.inject({ method: "POST", url: "/api/cli/task-items", headers: agent, payload: {
        title: "Hetzner VAT watch", objective: "Check the ticket for a human reply.", schedule: { recurrence: { kind: "INTERVAL", minutes: 120 }, timeZone: "Europe/Athens" } } });
      expect(created.statusCode).toBe(201);
      const task = created.json();
      expect(task).toMatchObject({ source: "AGENT", status: "OPEN", paneId: pane.id, paneTitle: "Claude", schedule: { recurrence: { kind: "INTERVAL", minutes: 120 }, lastRunAt: null } });
      expect(Date.parse(task.schedule.nextRunAt)).toBeGreaterThan(Date.now());
      // An agent cannot pick another pane: the field is not accepted.
      expect((await app.inject({ method: "POST", url: "/api/cli/task-items", headers: agent, payload: { title: "x", objective: "y", paneId: "pane:other" } })).statusCode).toBe(422);
      // The operator's dock lists it and can complete it, which stops the schedule.
      const dock = (await app.inject({ method: "GET", url: "/api/task-items", headers })).json();
      expect(dock.data.map((item: { id: string }) => item.id)).toEqual([task.id]);
      const done = (await app.inject({ method: "PATCH", url: `/api/task-items/${encodeURIComponent(task.id)}`, headers, payload: { status: "DONE" } })).json();
      expect(done.schedule.nextRunAt).toBeNull();
      // The agent reopens it through the bridge; the schedule resumes.
      const reopened = await app.inject({ method: "PATCH", url: `/api/cli/task-items/${encodeURIComponent(task.id)}`, headers: agent, payload: { status: "OPEN" } });
      expect(reopened.json().schedule.nextRunAt).not.toBeNull();
      const list = (await app.inject({ method: "GET", url: "/api/cli/task-items?status=OPEN", headers: agent })).json();
      expect(list.total).toBe(1);
      expect((await app.inject({ method: "PATCH", url: "/api/cli/task-items/task:missing", headers: agent, payload: { status: "DONE" } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("lets the operator schedule a task only in a pane of their own rooms", async () => {
    const { app, store, pane, headers } = await fixture();
    try {
      const schedule = { recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Europe/Athens" };
      const own = await app.inject({ method: "POST", url: "/api/task-items", headers, payload: { title: "Backups", objective: "Check the backup report.", paneId: pane.id, schedule } });
      expect(own.statusCode).toBe(201);
      expect(own.json()).toMatchObject({ paneId: pane.id, roomId: pane.roomId, schedule: { recurrence: schedule.recurrence } });
      const otherRoom = store.createRoom({ name: "Not mine" });
      const foreign = store.createPane({ roomId: otherRoom.id, title: "Other", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      expect((await app.inject({ method: "POST", url: "/api/task-items", headers, payload: { title: "x", objective: "Type here.", paneId: foreign.id, schedule } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid time zone and an interval under fifteen minutes", async () => {
    const { app, agent } = await fixture();
    try {
      for (const schedule of [{ recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Mars/Olympus" }, { recurrence: { kind: "INTERVAL", minutes: 5 }, timeZone: "UTC" }]) {
        expect((await app.inject({ method: "POST", url: "/api/cli/task-items", headers: agent, payload: { title: "x", objective: "y", schedule } })).statusCode).toBe(422);
      }
    } finally {
      await app.close();
    }
  });
});
