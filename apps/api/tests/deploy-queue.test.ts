import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { readDeployQueue } from "../src/deploy-queue.js";

const sessionSecret = "deploy-queue-test-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

function queueFixture(now: number) {
  const root = mkdtempSync(join(tmpdir(), "deploy-queue-"));
  mkdirSync(join(root, "tickets"));
  const ticket = (id: string, status: string, extra: Record<string, unknown>) => writeFileSync(join(root, "tickets", `${id}.json`), JSON.stringify({
    id, status, sha: "a".repeat(40), branch: `space/${id}`, summary: `Change ${id}`, worktree: "/var/lib/spaceapp-user/agent-workspace/active/secret-path",
    submittedAt: "2026-10-11T03:00:00.000Z", updatedAt: "2026-10-11T03:05:00.000Z",
    history: [{ at: "2026-10-11T03:00:00.000Z", status: "QUEUED", note: "Submitted." }, { at: "2026-10-11T03:05:00.000Z", status, note: `${status} note` }],
    ...extra
  }));
  ticket("q-20261011-030000-0001", "DEPLOYING", {
    submitter: { cliSessionId: "cli_session:abc", paneId: "pane:one", roomId: "room:one", runtimeId: "cli:claude" },
    history: [
      { at: "2026-10-11T03:00:00.000Z", status: "QUEUED", note: "Submitted." },
      { at: "2026-10-11T03:01:00.000Z", status: "INTEGRATING", note: "Batch b-20261011-030100-ab12 on live." },
      { at: "2026-10-11T03:02:00.000Z", status: "VERIFYING", note: "Building." },
      { at: "2026-10-11T03:04:00.000Z", status: "DEPLOYING", note: "Deploying cccccccccc." },
      { at: "2026-10-11T03:05:00.000Z", status: "DEPLOYING", note: "Still deploying." }
    ]
  });
  ticket("q-20261011-030000-0005", "QUEUED", { submitter: { cliSessionId: null, paneId: "pane:gone", roomId: null, runtimeId: "cli:codex" } });
  ticket("q-20261011-030000-0002", "DEPLOYED", {
    result: { commit: "b".repeat(40), remotes: "ok", log: "/opt/spaceapp/var/merge-queue/logs/b.log", tail: "npm output" },
    autoResolved: { files: ["apps/web/src/a.ts"], summary: "resolver said" }
  });
  ticket("q-20261011-030000-0003", "CONFLICT", { result: { files: ["packages/x.ts"], detail: "<<<<<<< raw merge output" } });
  writeFileSync(join(root, "tickets", "q-20261011-030000-0004.json"), "{not json");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    heartbeatAt: new Date(now - 5_000).toISOString(),
    paused: null,
    current: { batchId: "b-1", phase: "DEPLOYING", tickets: ["q-20261011-030000-0001"], logPath: "/opt/spaceapp/var/merge-queue/logs/b-1.log" },
    next: null
  }));
  return root;
}

describe("deploy queue report", () => {
  it("summarizes tickets without logs, worktree paths or resolver output", async () => {
    const now = Date.parse("2026-10-11T03:10:00.000Z");
    const report = await readDeployQueue(queueFixture(now), now);
    expect(report).toMatchObject({ available: true, daemonRunning: true, current: { batchId: "b-1", phase: "DEPLOYING", ticketIds: ["q-20261011-030000-0001"] } });
    expect(report.active.map((t) => t.status)).toEqual(["DEPLOYING", "QUEUED"]);
    expect(report.recent.map((t) => t.status).sort()).toEqual(["CONFLICT", "DEPLOYED"]);
    const deployed = report.recent.find((t) => t.status === "DEPLOYED")!;
    expect(deployed).toMatchObject({ deployedCommit: "b".repeat(40), remotes: "ok", autoResolvedFiles: ["apps/web/src/a.ts"], note: "DEPLOYED note" });
    expect(report.recent.find((t) => t.status === "CONFLICT")!.conflictFiles).toEqual(["packages/x.ts"]);
    const serialized = JSON.stringify(report);
    for (const hidden of ["secret-path", "npm output", "resolver said", "raw merge output", "logs/b"]) expect(serialized).not.toContain(hidden);
  });

  it("names the submitting CLI pane and times the batch phase", async () => {
    const now = Date.parse("2026-10-11T03:10:00.000Z");
    const root = queueFixture(now);
    writeFileSync(join(root, "state.json"), JSON.stringify({
      heartbeatAt: new Date(now - 5_000).toISOString(),
      current: { batchId: "b-20261011-030100-ab12", phase: "DEPLOYING", tickets: ["q-20261011-030000-0001"], candidate: "c".repeat(40), startedAt: "2026-10-11T03:03:59.000Z", deployPid: 42 },
      next: { batchId: "b-20261011-030500-cd34", phase: "READY", tickets: ["q-20261011-030000-0005"], startedAt: "2026-10-11T03:05:00.000Z" }
    }));
    const lookups: string[] = [];
    const report = await readDeployQueue(root, now, {
      paneTitle: async (id) => { lookups.push(id); if (id === "pane:gone") throw new Error("not found"); return "Deploy proof pane"; },
      roomName: async () => "Agent Proof"
    });
    expect(report.current).toEqual({
      batchId: "b-20261011-030100-ab12", phase: "DEPLOYING", ticketIds: ["q-20261011-030000-0001"],
      batchStartedAt: "2026-10-11T03:01:00.000Z", phaseStartedAt: "2026-10-11T03:04:00.000Z", candidate: "c".repeat(40)
    });
    // The prepared batch has no ticket in its phase, so its phase start falls back to the queue's own timestamp.
    expect(report.next).toMatchObject({ batchId: "b-20261011-030500-cd34", phase: "READY", phaseStartedAt: "2026-10-11T03:05:00.000Z" });
    const deploying = report.active.find((t) => t.status === "DEPLOYING")!;
    expect(deploying.statusSince).toBe("2026-10-11T03:04:00.000Z");
    expect(deploying.submitter).toEqual({
      runtimeId: "cli:claude", cliSessionId: "cli_session:abc", paneId: "pane:one", roomId: "room:one", paneTitle: "Deploy proof pane", roomName: "Agent Proof"
    });
    expect(report.active.find((t) => t.status === "QUEUED")!.submitter).toMatchObject({ runtimeId: "cli:codex", paneTitle: null, roomName: null });
    expect(report.recent.every((t) => t.submitter === null)).toBe(true);
    expect(lookups.sort()).toEqual(["pane:gone", "pane:one"]);
    expect(JSON.stringify(report)).not.toContain("logs/b-1");
  });

  it("reports an unavailable queue and a stale daemon plainly", async () => {
    expect(await readDeployQueue(join(tmpdir(), "missing-deploy-queue-dir"))).toMatchObject({ available: false, daemonRunning: false });
    const now = Date.parse("2026-10-11T03:10:00.000Z");
    const root = queueFixture(now);
    writeFileSync(join(root, "state.json"), JSON.stringify({ heartbeatAt: "2026-10-11T02:00:00.000Z", current: null }));
    expect((await readDeployQueue(root, now)).daemonRunning).toBe(false);
  });

  it("serves the report only to ADMIN users", async () => {
    const app = await createApp({
      store: new InMemorySpaceStore(), config: getApiConfig({}),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      deployQueueRoot: queueFixture(Date.now())
    });
    apps.push(app);
    const denied = await app.inject({ method: "GET", url: "/api/admin/deploy-queue", headers: authHeaders("OPERATOR") });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "GET", url: "/api/admin/deploy-queue", headers: authHeaders("ADMIN") });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().active).toHaveLength(2);
    // Panes that no longer exist leave the name empty instead of failing the report.
    expect(allowed.json().active[0].submitter).toMatchObject({ paneId: "pane:one", paneTitle: null, roomName: null });
  });
});
