import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, InMemoryTelegramPersistence, SpaceEventBus, TelegramIntegrationManager, TelegramSecretStore } from "@space/runtime";
import type { Event, JobApplyRun, Pane } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A signed-in owner, a Job Copilot pane with a RUNNING CLI session, and both the operator and the agent credentials. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-job-apply-run-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-job-apply-tests",
    SPACE_ARTIFACT_ROOT: root
  });
  const store = new InMemorySpaceStore();
  const sent: string[] = [];
  const telegramPersistence = new InMemoryTelegramPersistence();
  const telegramSecrets = new TelegramSecretStore(join(root, "telegram"));
  const telegramIntegrationManager = new TelegramIntegrationManager({
    persistence: telegramPersistence, secrets: telegramSecrets,
    clientFactory: () => ({
      async getMe() { return { id: "1", username: "space_bot", firstName: "Space" }; },
      async getWebhookInfo() { return { url: "" }; },
      async getUpdates() { return []; },
      async sendMessage(_chatId: string, text: string) { sent.push(text); return { messageId: String(sent.length) }; }
    })
  });
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "JOB_APPLY_UPDATED") roomEvents.push(event); });
  const kickoffs: Array<{ paneId: string; runId: string }> = [];
  const app = await createApp({ store, config: { ...config, jobApplyRoot: join(root, "job-apply") }, telegramIntegrationManager, eventBus,
    jobApplyKickoff: async (pane: Pane, run: JobApplyRun) => { kickoffs.push({ paneId: pane.id, runId: run.id }); },
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Jobs", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Job Copilot", mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  return { app, store, room, pane, headers, agent, sent, roomEvents, telegramPersistence, telegramSecrets, cliSession, kickoffs };
}

describe("job copilot run supervisor", () => {
  it("queues postings, starts a run with a kickoff into the pane CLI, serves job_next, closes with job_report and finishes", async () => {
    const { app, pane, headers, agent, roomEvents, kickoffs } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers })).statusCode).toBe(409);
      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://boards.greenhouse.io/acme/jobs/1", "nope", "https://jobs.ashbyhq.com/globex/2"] } });
      expect(queued.statusCode).toBe(200);
      expect(queued.json()).toMatchObject({ existing: 0, rejected: ["nope"] });
      expect(queued.json().queued.map((row: { company: string; queuePosition: number }) => [row.company, row.queuePosition])).toEqual([["Acme", 0], ["Globex", 1]]);
      const [acme, globex] = queued.json().queued as Array<{ id: string }>;
      const reordered = await app.inject({ method: "PUT", url: `${paneUrl}/queue/order`, headers, payload: { applicationIds: [globex!.id, acme!.id] } });
      expect(reordered.json().queue.map((row: { company: string }) => row.company)).toEqual(["Globex", "Acme"]);

      const idle = await app.inject({ method: "GET", url: `${paneUrl}/run`, headers });
      expect(idle.json()).toMatchObject({ run: null, status: "IDLE", pending: [] });
      expect(idle.json().queue).toHaveLength(2);

      // The agent polls before any run exists: nothing to do, no waiting.
      const noRun = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(noRun.json()).toMatchObject({ done: true, reason: "NO_RUN" });

      const started = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "RUNNING", kickoffSent: true });
      expect(started.json().run.counters).toEqual({ taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0 });
      expect(kickoffs).toEqual([{ paneId: pane.id, runId: started.json().run.id }]);
      expect(started.json().run.kickoffSentAt).not.toBeNull();

      // job_next takes the head of the queue (Globex after the reorder) and returns the task packet.
      const next = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(next.statusCode).toBe(200);
      const packet = next.json();
      expect(packet.done).toBe(false);
      expect(packet.application).toMatchObject({ id: globex!.id, status: "FILLING", queuePosition: null });
      expect(packet.run).toMatchObject({ counters: { taken: 1 }, remaining: 1 });
      expect(packet.settings).toMatchObject({ submitMode: "AUTO", dailyCap: 60 });
      expect(packet).toHaveProperty("candidate");
      expect(packet).toHaveProperty("answers");
      const view = await app.inject({ method: "GET", url: `${paneUrl}/run`, headers });
      expect(view.json().current.id).toBe(globex!.id);
      expect(view.json().queue.map((row: { company: string }) => row.company)).toEqual(["Acme"]);

      // Reporting an outcome that does not match the tracker is refused.
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: globex!.id, outcome: "submitted", summary: "done" } })).statusCode).toBe(409);
      await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${globex!.id}/fields`, headers: agent, payload: { fields: [{ label: "Full name", value: "N", source: "PROFILE" }] } });
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${globex!.id}`, headers: agent, payload: { status: "SUBMITTED" } });
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${globex!.id}`, headers: agent, payload: { status: "VERIFIED", externalConfirmation: "Thank you page" } });
      const reported = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: globex!.id, outcome: "verified", summary: "Submitted and verified on the thank-you page." } });
      expect(reported.statusCode).toBe(200);
      expect(reported.json()).toMatchObject({ remaining: 1, run: { counters: { taken: 1, submitted: 1, verified: 1 } } });

      // Pause: job_next waits instead of taking Acme; resume continues without a second kickoff while the agent polls.
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/pause`, headers })).json().status).toBe("PAUSED");
      const pausedNext = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(pausedNext.json()).toMatchObject({ done: false, waiting: true, reason: "PAUSED" });
      const resumed = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(resumed.json()).toMatchObject({ status: "RUNNING", kickoffSent: true });
      const acmeNext = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(acmeNext.json().application.id).toBe(acme!.id);
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${acme!.id}`, headers: agent, payload: { status: "FAILED", notes: "not eligible: US work authorization" } });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: acme!.id, outcome: "failed", summary: "not eligible" } });
      const finished = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(finished.json()).toMatchObject({ done: true, reason: "QUEUE_EMPTY", run: { status: "STOPPED", counters: { taken: 2, verified: 1, failed: 1 } } });
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().status).toBe("IDLE");

      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toEqual(["RUN_FINISHED", "NOTE", "FAILED", "STARTED", "RUN_RESUMED", "RUN_PAUSED", "NOTE", "VERIFIED", "SUBMITTED", "FIELD_FILLED", "STARTED", "RUN_STARTED", "NOTE", "NOTE"]);
      expect(roomEvents.length).toBe(events.length);
      expect(roomEvents[0]).toMatchObject({ roomId: pane.roomId, paneId: pane.id, type: "JOB_APPLY_UPDATED" });
    } finally {
      await app.close();
    }
  });

  it("answers a question longer than a memory key: the key keeps the first 300 normalized characters", async () => {
    const { app, room, pane, headers, agent } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://jobs.lever.co/initech/10"] } });
      const [initech] = queued.json().queued as Array<{ id: string }>;
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      // The copilot gives the operator context around the form's own question (up to 1000 characters).
      const question = `Initech, Platform Engineer (Remote; Australia, listed with a US address). The form requires: "Will you now or in the future require visa sponsorship to work in the country where this position is located?" ${"Context for the operator. ".repeat(20)}Which answer is true?`;
      expect(question.length).toBeGreaterThan(500);
      const asked = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question`, headers: agent, payload: { question, options: ["No", "Yes"], label: "Visa sponsorship" } });
      expect(asked.json()).toMatchObject({ answered: false });
      // The question makes the room "Needs attention" until it is answered.
      const attention = async () => (await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().byRoom[room.id] ?? 0;
      await vi.waitFor(async () => expect(await attention()).toBe(1));
      const answered = await app.inject({ method: "POST", url: `/api/job-apply/applications/${initech!.id}/answer`, headers, payload: { questionId: asked.json().questionId, answer: "No" } });
      expect(answered.statusCode).toBe(200);
      await vi.waitFor(async () => expect(await attention()).toBe(0));
      expect(answered.json().memory.key.length).toBeLessThanOrEqual(300);
      const known = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question`, headers: agent, payload: { question } });
      expect(known.json()).toMatchObject({ answered: true, answer: "No" });
    } finally {
      await app.close();
    }
  });

  it("gives the earlier note back when a parked application leaves NEEDS_USER, answered in the rail or not", async () => {
    const { app, pane, headers, agent } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://jobs.lever.co/initech/11", "https://jobs.lever.co/initech/12"] } });
      const [first, second] = queued.json().queued as Array<{ id: string }>;
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      const notesOf = async (id: string) => (await app.inject({ method: "GET", url: "/api/job-apply/applications", headers })).json().applications.find((row: { id: string }) => row.id === id)?.notes;
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${first!.id}`, headers: agent, payload: { notes: "Referred by a former colleague" } });

      // Answered in the rail: the question stops being the row's note.
      const asked = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${first!.id}/question`, headers: agent, payload: { question: "Notice period in weeks?" } });
      expect(await notesOf(first!.id)).toBe("Notice period in weeks?");
      await app.inject({ method: "POST", url: `/api/job-apply/applications/${first!.id}/answer`, headers, payload: { questionId: asked.json().questionId, answer: "4" } });
      expect(await notesOf(first!.id)).toBe("Referred by a former colleague");

      // Answered elsewhere (the terminal): the copilot submits the parked row and the question note goes away too.
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${second!.id}`, headers: agent, payload: { status: "FILLING" } });
      await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${second!.id}/question`, headers: agent, payload: { question: "Will you require visa sponsorship?" } });
      expect(await notesOf(second!.id)).toBe("Will you require visa sponsorship?");
      await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${second!.id}/fields`, headers: agent, payload: { fields: [{ label: "Full name", value: "N", source: "PROFILE" }] } });
      const submitted = await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${second!.id}`, headers: agent, payload: { status: "SUBMITTED" } });
      expect(submitted.statusCode).toBe(200);
      expect(await notesOf(second!.id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("sends a posting back to the queue when the operator answers after the copilot moved on, and fails it on a later rejection", async () => {
    const { app, pane, headers, agent } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://jobs.lever.co/initech/21"] } });
      const [initech] = queued.json().queued as Array<{ id: string }>;
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      const statusOf = async () => (await app.inject({ method: "GET", url: "/api/job-apply/applications", headers })).json().applications.find((row: { id: string }) => row.id === initech!.id)?.status;

      // Nobody answered in time: the copilot reports needs_user and moves on; the answer comes later.
      const asked = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question`, headers: agent, payload: { question: "Years of experience?" } });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: initech!.id, outcome: "needs_user", summary: "waiting for the operator" } });
      await app.inject({ method: "POST", url: `/api/job-apply/applications/${initech!.id}/answer`, headers, payload: { questionId: asked.json().questionId, answer: "15" } });
      expect(await statusOf()).toBe("QUEUED");
      const again = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(again.json().application).toMatchObject({ id: initech!.id, status: "FILLING" });

      // A review the operator rejects after the copilot moved on fails the posting instead of leaving it FILLING.
      const review = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/review`, headers: agent, payload: { fields: [{ label: "Full name", value: "N" }] } });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: initech!.id, outcome: "needs_user", summary: "review pending" } });
      await app.inject({ method: "POST", url: `/api/job-apply/applications/${initech!.id}/review`, headers, payload: { reviewId: review.json().reviewId, decision: "reject", note: "Wrong role" } });
      expect(await statusOf()).toBe("FAILED");
    } finally {
      await app.close();
    }
  });

  it("defers a posting until an employer limit expires, holds the company's other postings and serves them after the date", async () => {
    const { app, pane, headers, agent } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      // Two postings of one company on different boards (pacing is per board) and one of another company.
      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://boards.greenhouse.io/acme/jobs/11", "https://jobs.lever.co/acme/12", "https://jobs.ashbyhq.com/globex/13"] } });
      const [acmeGreenhouse, acmeLever, globex] = queued.json().queued as Array<{ id: string }>;
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers })).statusCode).toBe(200);
      const first = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(first.json().application.id).toBe(acmeGreenhouse!.id);

      // A deferral belongs to the queue: notBefore with another status is refused.
      const until = new Date(Date.now() + 1500).toISOString();
      expect((await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${acmeGreenhouse!.id}`, headers: agent, payload: { status: "FAILED", notBefore: until } })).statusCode).toBe(409);
      const deferred = await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${acmeGreenhouse!.id}`, headers: agent,
        payload: { status: "QUEUED", notBefore: until, notes: "limit: candidates may not apply more than 5 times in any 180 day span" } });
      expect(deferred.statusCode).toBe(200);
      expect(deferred.json().application).toMatchObject({ status: "QUEUED", notBefore: until });
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: acmeGreenhouse!.id, outcome: "skipped", summary: "limit" } })).statusCode).toBe(200);

      // The other Acme posting is held too: job_next serves Globex, and the pacing check names the hold.
      const second = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(second.json().application.id).toBe(globex!.id);
      const held = await app.inject({ method: "GET", url: "/api/cli/job-apply/pacing?site=lever&company=ACME", headers: agent });
      expect(held.json()).toMatchObject({ allowed: false, companyHoldUntil: until, nextAllowedAt: until, reason: `company limit until ${until.slice(0, 10)}` });
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/pacing?site=lever&company=Globex", headers: agent })).json()).toMatchObject({ allowed: true });
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${globex!.id}`, headers: agent, payload: { status: "FAILED", notes: "closed" } });
      await app.inject({ method: "POST", url: "/api/cli/job-apply/job/report", headers: agent, payload: { applicationId: globex!.id, outcome: "failed", summary: "closed" } });

      // Only deferred work is left: the run finishes and says when the next posting is free; a new run waits for it.
      const finished = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(finished.json()).toMatchObject({ done: true, reason: "QUEUE_DEFERRED", nextDeferredAt: until, run: { status: "STOPPED" } });
      const early = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(early.statusCode).toBe(409);
      expect(early.json().error.message).toContain("waits for an employer limit");

      // Once the date has passed, both Acme postings are served again and the deferral clears when one is taken.
      await new Promise((resolve) => setTimeout(resolve, Date.parse(until) - Date.now() + 100));
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers })).statusCode).toBe(200);
      const after = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect([acmeGreenhouse!.id, acmeLever!.id]).toContain(after.json().application.id);
      expect(after.json().application).toMatchObject({ status: "FILLING", notBefore: null });
    } finally {
      await app.close();
    }
  });

  it("an answer closes the question in the pane that asked, even when the posting was queued from another pane", async () => {
    const { app, store, room, pane, headers, agent } = await fixture();
    try {
      const oldPane = store.createPane({ roomId: room.id, title: "Old Job Copilot", mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" });
      const queued = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(oldPane.id)}/job-apply/queue`, headers, payload: { urls: ["https://jobs.lever.co/initech/10"] } });
      const [posting] = queued.json().queued as Array<{ id: string }>;
      const asked = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${posting!.id}/question`, headers: agent, payload: { question: "Years of Flutter?" } });
      const questionId = asked.json().questionId as string;
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().pending).toEqual([expect.objectContaining({ id: questionId })]);
      expect((await app.inject({ method: "POST", url: `/api/job-apply/applications/${posting!.id}/answer`, headers, payload: { questionId, answer: "0" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().pending).toEqual([]);
      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}`, headers })).json().events as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toContain("ANSWERED");
    } finally {
      await app.close();
    }
  });

  it("routes questions and reviews to the operator, answers become memory, and Telegram gets the needs-you moments when enabled", async () => {
    const { app, pane, headers, agent, sent, telegramPersistence, telegramSecrets } = await fixture();
    try {
      const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/job-apply`;
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { submitMode: "REVIEW", notifications: { inApp: true, telegram: true } } } });
      const secretVersion = await telegramSecrets.write("123456:abcdefghijklmnopqrstuvwxyz0123456789");
      await telegramPersistence.startPairing({ pairingId: "telegram_pairing:test", codeHash: "x".repeat(64), secretVersion, botUserId: "1", botUsername: "space_bot", expiresAt: "2099-01-01T00:00:00.000Z", createdByUserId: null, now: "2026-10-12T00:00:00.000Z" });
      await telegramPersistence.activatePairing({ pairingId: "telegram_pairing:test", chatId: "42", chatDisplayName: "Operator", pollingOffset: 0, now: "2026-10-12T00:00:00.000Z" });
      await telegramPersistence.setEnabled(true, "2026-10-12T00:00:00.000Z");

      const queued = await app.inject({ method: "POST", url: `${paneUrl}/queue`, headers, payload: { urls: ["https://jobs.lever.co/initech/9"] } });
      const [initech] = queued.json().queued as Array<{ id: string }>;
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      const next = await app.inject({ method: "POST", url: "/api/cli/job-apply/job/next", headers: agent, payload: { waitMs: 0 } });
      expect(next.json().settings.submitMode).toBe("REVIEW");

      // A question with no stored answer parks the application and surfaces in the rail.
      const asked = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question`, headers: agent, payload: { question: "What is your expected salary in EUR?", options: ["70k", "80k", "90k"], label: "Salary expectation" } });
      expect(asked.json()).toMatchObject({ answered: false });
      const questionId = asked.json().questionId as string;
      expect(questionId).toMatch(/^jobq:/);
      const pending = (await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json();
      expect(pending.pending).toEqual([expect.objectContaining({ kind: "QUESTION", id: questionId, applicationId: initech!.id })]);
      expect(pending.current.status).toBe("NEEDS_USER");
      const unanswered = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question/wait`, headers: agent, payload: { questionId, waitMs: 0 } });
      expect(unanswered.json()).toEqual({ answered: false, answer: null });
      const answered = await app.inject({ method: "POST", url: `/api/job-apply/applications/${initech!.id}/answer`, headers, payload: { questionId, answer: "80k EUR" } });
      expect(answered.statusCode).toBe(200);
      expect(answered.json().memory).toMatchObject({ kind: "ANSWER", key: "what is your expected salary in eur", text: "80k EUR", source: "USER" });
      const waited = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question/wait`, headers: agent, payload: { questionId, waitMs: 0 } });
      expect(waited.json()).toMatchObject({ answered: true, answer: "80k EUR" });
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json()).toMatchObject({ pending: [], current: { status: "FILLING" } });
      // The same question next time is answered from memory without parking the application.
      const known = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/question`, headers: agent, payload: { question: "Expected salary (EUR)?" } });
      expect(known.json()).toMatchObject({ answered: true, answer: "80k EUR" });

      // Review before submit: the operator corrects a value; the correction becomes memory too.
      const review = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/review`, headers: agent, payload: { fields: [{ label: "Notice period", value: "1 month" }, { label: "Full name", value: "N" }], note: "final step" } });
      const reviewId = review.json().reviewId as string;
      expect(reviewId).toMatch(/^jobrev:/);
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().pending[0]).toMatchObject({ kind: "REVIEW", id: reviewId });
      const decided = await app.inject({ method: "POST", url: `/api/job-apply/applications/${initech!.id}/review`, headers, payload: { reviewId, decision: "edit", edits: [{ label: "Notice period", value: "2 months" }] } });
      expect(decided.statusCode).toBe(200);
      const decision = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${initech!.id}/review/wait`, headers: agent, payload: { reviewId, waitMs: 0 } });
      expect(decision.json()).toMatchObject({ decided: true, decision: "edit", edits: [{ label: "Notice period", value: "2 months" }] });
      const memories = (await app.inject({ method: "GET", url: "/api/job-apply/memory?kinds=ANSWER", headers })).json();
      expect(memories.memories.map((memory: { key: string; text: string }) => [memory.key, memory.text]).sort()).toEqual([["notice period", "2 months"], ["what is your expected salary in eur", "80k EUR"]]);

      // Telegram received the question and the review request, nothing else.
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent[0]).toContain("Needs you: What is your expected salary in EUR?");
      expect(sent[1]).toContain("Review before submit");
      expect(sent.join("\n")).not.toContain("80k EUR");

      // Operator memory management: teach, pin, forget.
      const taught = await app.inject({ method: "POST", url: "/api/job-apply/memory", headers, payload: { kind: "PREFERENCE", text: "Prefer remote roles in the EU time zone." } });
      expect(taught.statusCode).toBe(201);
      expect(taught.json().memory).toMatchObject({ source: "USER" });
      expect((await app.inject({ method: "PATCH", url: `/api/job-apply/memory/${taught.json().memory.id}`, headers, payload: { pinned: true } })).json().memory.pinned).toBe(true);
      expect((await app.inject({ method: "DELETE", url: `/api/job-apply/memory/${taught.json().memory.id}`, headers })).json()).toEqual({ forgotten: true });
      const fields = (await app.inject({ method: "GET", url: `/api/job-apply/applications/${initech!.id}/fields`, headers })).json();
      expect(fields.fields).toEqual([]);

    } finally {
      await app.close();
    }
  });
});
