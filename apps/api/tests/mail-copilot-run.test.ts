import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { InMemoryMailCopilotRepository } from "@space/db";
import type { ConnectorCapability, Event, MailCopilotRun, Pane } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import type { MailCopilotGoogleAccess } from "../src/mail-copilot/service.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
interface FakeMessage { id: string; threadId: string; from: string; subject: string; minutesAgo: number; labelIds: string[]; plain: string }

/** The smallest Gmail an agent run needs: inbox threads, one thread, modify, send, drafts; records every write. */
function fakeGmail(token: string, inbox: FakeMessage[]) {
  const writes: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const full = (message: FakeMessage) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds, internalDate: String(Date.now() - message.minutesAgo * 60_000), snippet: message.plain.slice(0, 80),
    payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: message.from }, { name: "To", value: "Me <me@gmail.com>" }, { name: "Subject", value: message.subject }, { name: "Message-ID", value: `<${message.id}@mail.example>` },
      { name: "Date", value: new Date(Date.now() - message.minutesAgo * 60_000).toUTCString() }], parts: [{ mimeType: "text/plain", body: { data: b64(message.plain) } }, { mimeType: "text/html", body: { data: b64(`<p>${message.plain}</p>`) } }] } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return Response.json({ error: { message: "bad token" } }, { status: 401 });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (init?.method === "POST") writes.push({ path, body });
    if (path === "/profile") return Response.json({ emailAddress: "me@gmail.com", historyId: "1" });
    if (path === "/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Invoices", type: "user" }, { id: "Label_2", name: "Friends", type: "user" }] });
    if (path === "/labels/INBOX") return Response.json({ id: "INBOX", threadsUnread: 1 });
    if (path === "/threads") return Response.json({ threads: [...new Set(inbox.filter((message) => message.labelIds.includes(url.searchParams.get("labelIds") ?? "INBOX")).sort((a, b) => a.minutesAgo - b.minutesAgo).map((message) => message.threadId))].map((id) => ({ id })) });
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread) return Response.json({ id: thread[1], messages: inbox.filter((message) => message.threadId === thread[1]).map(full) });
    if (/^\/threads\/[^/]+\/(modify|trash)$/.test(path)) return Response.json({ id: path.split("/")[2] });
    if (path === "/messages/send") return Response.json({ id: `sent-${writes.length}`, threadId: (body as { threadId?: string }).threadId ?? "thread-new" });
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message) { const row = inbox.find((entry) => entry.id === message[1]); return row ? Response.json(full(row)) : Response.json({ error: { message: "nope" } }, { status: 404 }); }
    if (path === "/drafts") return Response.json({ id: "draft-1", message: { id: "draft-msg-1" } });
    return Response.json({ error: { message: `unexpected ${path}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, writes };
}

const full: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"];
const google: MailCopilotGoogleAccess = {
  googleConfigured: true,
  async googleAccounts() { return [{ email: "me@gmail.com", capabilities: full }]; },
  async googleAccessToken(_owner, email, capability) { if (email !== "me@gmail.com" || !full.includes(capability)) throw new Error("not allowed"); return "token-me"; }
};

/** A signed-in owner, a Mail Copilot pane, the operator's session and the agent's bridge token; the kickoff is recorded, not typed. */
async function fixture(inbox: FakeMessage[]) {
  const root = await mkdtemp(join(tmpdir(), "space-mail-copilot-run-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-mail-copilot-tests", SPACE_ARTIFACT_ROOT: root
  });
  const store = new InMemorySpaceStore();
  const gmail = fakeGmail("token-me", inbox);
  const eventBus = new SpaceEventBus();
  const roomEvents: Event[] = [];
  eventBus.subscribe((event) => { if (event.type === "MAIL_COPILOT_UPDATED") roomEvents.push(event); });
  const kickoffs: Array<{ paneId: string; runId: string }> = [];
  const repository = new InMemoryMailCopilotRepository();
  const app = await createApp({ store, config, eventBus, mailCopilotGoogle: google, mailCopilotGmailFetch: gmail.fetchImpl, jobApplyMailTriage: false, mailCopilotRepository: repository,
    mailCopilotKickoff: async (pane: Pane, run: MailCopilotRun) => { kickoffs.push({ paneId: pane.id, runId: run.id }); },
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Mail", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  return { app, store, pane, headers, agent, gmail, roomEvents, kickoffs, repository, paneUrl: `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot` };
}

const cli = "/api/cli/mail-copilot";

describe("mail copilot run loop", () => {
  it("starts a run with a kickoff, serves the inbox backlog as triage items with context, holds Assist to reviews, learns from the operator's edit and finishes", async () => {
    const { app, pane, headers, agent, gmail, roomEvents, kickoffs, paneUrl } = await fixture([
      { id: "m1", threadId: "t1", from: "Anna Client <anna@acme.com>", subject: "Invoice question", minutesAgo: 30, labelIds: ["INBOX", "UNREAD"], plain: "Can you resend the invoice?" },
      { id: "m2", threadId: "t2", from: "Shop <no-reply@shop.example>", subject: "Your order", minutesAgo: 20, labelIds: ["INBOX"], plain: "Order shipped" },
      { id: "m3", threadId: "t3", from: "Old <old@acme.com>", subject: "Last month", minutesAgo: 60 * 48, labelIds: ["INBOX"], plain: "Stale" }
    ]);
    try {
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: true, reason: "NO_RUN" });
      const idle = await app.inject({ method: "GET", url: `${paneUrl}/run`, headers });
      expect(idle.json()).toMatchObject({ run: null, status: "IDLE", pending: [] });

      const started = await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "RUNNING", kickoffSent: true });
      expect(kickoffs).toEqual([{ paneId: pane.id, runId: started.json().run.id }]);

      // The agent's state carries the pane settings and the run; the backlog scan makes one triage item per human conversation of the last 24 h.
      const state = await app.inject({ method: "GET", url: `${cli}/state`, headers: agent });
      expect(state.json()).toMatchObject({ settings: { autonomy: "ASSIST", backlogHours: 24 }, run: { status: "RUNNING" } });
      const next = await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } });
      expect(next.statusCode).toBe(200);
      const packet = next.json();
      expect(packet).toMatchObject({ done: false, autonomy: "ASSIST", item: { type: "TRIAGE", status: "TAKEN", accountEmail: "me@gmail.com", threadId: "t1" }, run: { counters: { taken: 1 } } });
      expect(packet.context.thread.messages[0]).toMatchObject({ text: "Can you resend the invoice?", html: null });
      expect(packet.context.memories).toEqual([]);

      // Assist: sending and archiving are refused, a draft is fine, a review hands the reply to the operator (and raises a notification).
      const draft = { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Invoice question", text: "Hi Anna, attached again. Best, Me", threadId: "t1", inReplyToMessageId: "m1" };
      const refused = await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: draft });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/MAIL_NEEDS_REVIEW/);
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { account: "me@gmail.com", action: "archive" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${cli}/draft`, headers: agent, payload: draft })).statusCode).toBe(200);
      expect(gmail.writes.map((write) => write.path)).toEqual(["/drafts"]);
      const review = await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft, summary: "Reply resending the invoice", reasoning: "Anna asks for it" } });
      expect(review.statusCode).toBe(200);
      const reviewId = review.json().reviewId as string;
      expect(reviewId).toMatch(/^mailrev:/);
      expect((await app.inject({ method: "POST", url: `${cli}/review/wait`, headers: agent, payload: { reviewId, waitMs: 0 } })).json()).toEqual({ decided: false, decision: null });
      const pending = await app.inject({ method: "GET", url: `${paneUrl}/run`, headers });
      expect(pending.json().pending).toEqual([expect.objectContaining({ kind: "REVIEW", id: reviewId })]);
      const notifications = await app.inject({ method: "GET", url: "/api/notifications/pending", headers });
      expect(notifications.json()).toMatchObject({ total: 1, bySource: { MAIL_COPILOT: 1 } });

      // The operator edits the reply: the server sends the operator's version, learns the difference, and resolves the notification.
      const decided = await app.inject({ method: "POST", url: `${paneUrl}/review`, headers, payload: { reviewId, decision: "edit", text: "Hi Anna, here it is again. Thanks, Me" } });
      expect(decided.statusCode).toBe(200);
      expect(decided.json()).toMatchObject({ decision: "edit", sent: { threadId: "t1" } });
      const sent = gmail.writes.find((write) => write.path === "/messages/send")!;
      expect(sent.body).toMatchObject({ threadId: "t1" });
      const raw = Buffer.from(String(sent.body!.raw), "base64url").toString("utf8");
      expect(raw).toContain("In-Reply-To: <m1@mail.example>");
      expect(raw.includes("here it is again") || raw.includes(Buffer.from("Hi Anna, here it is again. Thanks, Me", "utf8").toString("base64"))).toBe(true);
      expect((await app.inject({ method: "POST", url: `${cli}/review/wait`, headers: agent, payload: { reviewId, waitMs: 0 } })).json()).toMatchObject({ decided: true, decision: "edit", sent: { threadId: "t1" } });
      // One decision, one send (stable 2026-10-17: one approval reached Hetzner twice): a repeat answers the recorded decision.
      const sends = () => gmail.writes.filter((write) => write.path === "/messages/send").length;
      const before = sends();
      expect((await app.inject({ method: "POST", url: `${paneUrl}/review`, headers, payload: { reviewId, decision: "approve" } })).json()).toMatchObject({ decision: "edit", sent: { threadId: "t1" } });
      expect(sends()).toBe(before);
      const lessons = await app.inject({ method: "POST", url: `${cli}/memory/recall`, headers: agent, payload: { contactEmail: "anna@acme.com" } });
      expect(lessons.json().memories).toEqual([expect.objectContaining({ kind: "LESSON", source: "LEARNED", contactEmail: "anna@acme.com", domain: "acme.com" })]);
      expect(lessons.json().memories[0].text).toContain("Operator's version");
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);

      // Closing the item counts it; the next poll finds nothing more (the automated and stale senders were skipped) and finishes the run.
      const reported = await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: packet.item.id, outcome: "replied", summary: "Replied after your edit.", memoryIds: [lessons.json().memories[0].id] } });
      expect(reported.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: packet.item.id, outcome: "replied", summary: "again" } })).statusCode).toBe(409);
      const finished = await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } });
      expect(finished.json()).toMatchObject({ done: true, reason: "QUEUE_EMPTY", run: { status: "STOPPED", counters: { taken: 1, replied: 1 } } });
      const events = await app.inject({ method: "GET", url: `/api/mail-copilot/events?paneId=${encodeURIComponent(pane.id)}`, headers });
      const types = events.json().events.map((event: { type: string }) => event.type) as string[];
      expect(types.slice(0, 2)).toEqual(["RUN_FINISHED", "REPLIED"]);
      expect([...types].sort()).toEqual(["DRAFTED", "REPLIED", "REVIEW_DECIDED", "REVIEW_REQUESTED", "RUN_FINISHED", "RUN_STARTED", "SENT", "TRIAGE"]);
      expect(roomEvents.every((event) => event.paneId === pane.id && event.type === "MAIL_COPILOT_UPDATED")).toBe(true);
      expect(roomEvents.some((event) => (event.payload as { type: string }).type === "REVIEW_REQUESTED")).toBe(true);
      // The lesson counts a use when recalled and another when the report names it.
      expect((await app.inject({ method: "GET", url: "/api/mail-copilot/memory?kinds=LESSON", headers })).json().memories[0].uses).toBe(2);
      // Two approvals of one review racing each other send once.
      const second = (await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft, summary: "Second reply", reasoning: "race test" } })).json().reviewId as string;
      const raced = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `${paneUrl}/review`, headers, payload: { reviewId: second, decision: "approve" } })));
      expect(raced.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(sends()).toBe(before + 1);
    } finally {
      await app.close();
    }
  });

  it("pauses and resumes, answers questions into memory, sends alone under Full within the hourly cap, and keeps the operator's memory editable", async () => {
    const { app, headers, agent, gmail, paneUrl } = await fixture([{ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Hello", minutesAgo: 5, labelIds: ["INBOX"], plain: "Hi" }]);
    try {
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { autonomy: "FULL", sendsPerHour: 2 } } });
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/pause`, headers })).json().status).toBe("PAUSED");
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: false, waiting: true, reason: "PAUSED" });
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers })).json()).toMatchObject({ status: "RUNNING", kickoffSent: false });

      // A question becomes a pending card for the operator; the answer is a FACT memory the agent can wait for.
      const asked = await app.inject({ method: "POST", url: `${cli}/question`, headers: agent, payload: { question: "Should I answer Anna in English?", options: ["Yes", "No"], accountEmail: "me@gmail.com", threadId: "t1" } });
      const questionId = asked.json().questionId as string;
      expect(questionId).toMatch(/^mailq:/);
      // The agent asking the same open question again (a retry) gets the same card, not a second one.
      const again = await app.inject({ method: "POST", url: `${cli}/question`, headers: agent, payload: { question: "Should I answer Anna in English?", options: ["Yes", "No"], accountEmail: "me@gmail.com", threadId: "t1" } });
      expect(again.json().questionId).toBe(questionId);
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().pending).toEqual([expect.objectContaining({ kind: "QUESTION", id: questionId, threadId: "t1" })]);
      const answered = await app.inject({ method: "POST", url: `${paneUrl}/answer`, headers, payload: { questionId, answer: "Yes, always English" } });
      expect(answered.json().memory).toMatchObject({ kind: "FACT", source: "USER", text: "Yes, always English" });
      expect((await app.inject({ method: "POST", url: `${cli}/question/wait`, headers: agent, payload: { questionId, waitMs: 0 } })).json()).toMatchObject({ answered: true, answer: "Yes, always English" });

      // Full: the agent sends on its own, archives, and the hourly cap stops the third send.
      const reply = { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Hello", text: "Hello Anna", threadId: "t1", inReplyToMessageId: "m1" };
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: reply })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: reply })).statusCode).toBe(200);
      const capped = await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: reply });
      expect(capped.statusCode).toBe(409);
      expect(capped.json().error.message).toMatch(/hour/i);
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { account: "me@gmail.com", action: "archive" } })).statusCode).toBe(200);
      expect(gmail.writes.filter((write) => write.path === "/messages/send")).toHaveLength(2);
      expect(gmail.writes.at(-1)).toMatchObject({ path: "/threads/t1/modify", body: { removeLabelIds: ["INBOX"] } });
      // Never to an automated sender, whatever the level.
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: { ...reply, to: ["no-reply@shop.example"] } })).statusCode).toBe(409);

      // Memory: the agent remembers, the operator searches, pins, edits and forgets.
      const remembered = await app.inject({ method: "POST", url: `${cli}/memory`, headers: agent, payload: { kind: "STYLE", key: "sign-off", text: "Signs off with 'Best, Me'", source: "AGENT", confidence: 0.8, tags: [], pinned: false } });
      expect(remembered.statusCode).toBe(200);
      const id = remembered.json().memory.id as string;
      expect((await app.inject({ method: "GET", url: "/api/mail-copilot/memory?query=sign", headers })).json().memories.map((memory: { id: string }) => memory.id)).toEqual([id]);
      expect((await app.inject({ method: "PATCH", url: `/api/mail-copilot/memory/${encodeURIComponent(id)}`, headers, payload: { pinned: true, text: "Signs off with 'Thanks, Me'" } })).json().memory).toMatchObject({ pinned: true, text: "Signs off with 'Thanks, Me'" });
      expect((await app.inject({ method: "POST", url: `${cli}/memory/recall`, headers: agent, payload: { query: "anything" } })).json().memories[0]).toMatchObject({ id, pinned: true });
      expect((await app.inject({ method: "DELETE", url: `/api/mail-copilot/memory/${encodeURIComponent(id)}`, headers })).json()).toEqual({ forgotten: true });
      expect((await app.inject({ method: "GET", url: "/api/mail-copilot/memory", headers })).json().memories.map((memory: { kind: string }) => memory.kind)).toEqual(["FACT"]);

      // Stop ends the run; the view goes back to idle and the agent's next poll finds no run.
      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/stop`, headers })).json()).toMatchObject({ status: "IDLE", run: null });
      expect((await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: true, reason: "NO_RUN" });
    } finally {
      await app.close();
    }
  });

  it("Send to AI hands a mail to the copilot to check and fix: logged, a work item, the run starts, a fixed report notifies, and three hand-offs make a FIX rule", async () => {
    const pve = (n: number) => ({ id: `p${n}`, threadId: `pt${n}`, from: "PVE <root@pve.example>", subject: "vzdump backup status (pve): backup failed: multiple problems", minutesAgo: 5 + n, labelIds: ["INBOX"], plain: "can't acquire lock" });
    const { app, pane, headers, agent, kickoffs, repository, store } = await fixture([pve(1), pve(2), pve(3)]);
    const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
    const fix = (threadId: string, note?: string) => app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot/fix`, headers, payload: { account: "me@gmail.com", threadId, ...(note ? { note } : {}) } });
    const openTitles = async () => ((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ title: string; body: string }>);
    try {
      const sent = await fix("pt1", "Check why the backup failed and fix it");
      expect(sent.statusCode).toBe(200);
      expect(sent.json()).toMatchObject({ runStarted: true, event: { type: "FIX_REQUESTED", status: "PENDING", threadId: "pt1", payload: { by: "operator", note: "Check why the backup failed and fix it", subject: "vzdump backup status (pve): backup failed: multiple problems" } } });
      expect(kickoffs).toHaveLength(1);
      // The operator's own click raises no notice.
      expect((await openTitles()).some((entry) => entry.title.includes("took a mail to fix"))).toBe(false);
      const [row] = await repository.listActions(owner, { actions: ["FIX"], limit: 5 });
      expect(row).toMatchObject({ action: "FIX", actor: "OPERATOR", source: "PANE", fromAddress: "root@pve.example", subjectKey: "vzdump backup status (pve): backup failed: multiple problems" });

      const next = await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } });
      expect(next.json().item).toMatchObject({ type: "FIX_REQUESTED", threadId: "pt1", payload: { note: "Check why the backup failed and fix it" } });
      expect(next.json().context.thread.messages[0].text).toBe("can't acquire lock");
      // The copilot asks before changing anything; the operator decides in the rail.
      const asked = (await app.inject({ method: "POST", url: `${cli}/question`, headers: agent, payload: { question: "Disable the duplicate backup job?", options: ["Yes", "No"], accountEmail: "me@gmail.com", threadId: "pt1" } })).json();
      await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot/answer`, headers, payload: { questionId: asked.questionId, answer: "Yes, disable the job" } });
      const done = await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: next.json().item.id, outcome: "fixed", summary: "A stuck vzdump held the lock; cleared it and the backup ran again." } });
      expect(done.json().event).toMatchObject({ type: "FIXED", message: "A stuck vzdump held the lock; cleared it and the backup ran again." });
      // Activity → Sent to AI shows the request, the exchange and the result together.
      const [shown] = (await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot/fix-requests`, headers })).json().requests;
      expect(shown).toMatchObject({ subject: "vzdump backup status (pve): backup failed: multiple problems", from: "root@pve.example", note: "Check why the backup failed and fix it", by: "operator", status: "DONE",
        exchanges: [{ question: "Disable the duplicate backup job?", answer: "Yes, disable the job" }], outcome: { type: "FIXED", summary: "A stuck vzdump held the lock; cleared it and the backup ran again." } });
      // The fix is remembered for the next mail of this kind: the request, the operator's decision and what fixed it.
      const lesson = (await repository.listMemory(owner, { kinds: ["LESSON"], limit: 10 })).find((memory) => memory.tags.includes("fix"));
      expect(lesson).toMatchObject({ id: shown.memoryId, key: "fix: vzdump backup status (pve): backup failed: multiple problems", contactEmail: "root@pve.example", accountEmail: "me@gmail.com", source: "LEARNED" });
      expect(lesson!.text).toContain('the operator answered "Yes, disable the job"');
      expect(lesson!.text).toContain("What fixed it: A stuck vzdump held the lock");
      expect((await openTitles()).find((entry) => entry.title.startsWith("Mail Copilot fixed a mail"))).toMatchObject({ body: "A stuck vzdump held the lock; cleared it and the backup ran again." });

      // Three hand-offs of the same kind of mail make an approved FIX rule.
      await fix("pt2");
      expect((await repository.listRules(owner)).filter((rule) => rule.action.type === "FIX")).toEqual([]);
      // The next mail of that kind comes with the lesson.
      const second = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json();
      expect(second.item).toMatchObject({ type: "FIX_REQUESTED", threadId: "pt2" });
      expect(second.context.memories.map((memory: { id: string }) => memory.id)).toContain(lesson!.id);
      await fix("pt3");
      const [rule] = (await repository.listRules(owner)).filter((entry) => entry.action.type === "FIX");
      expect(rule).toMatchObject({ status: "APPROVED", proposedBy: "LEARNED", condition: { fromAddress: "root@pve.example" }, name: "Send to the copilot to fix mail from root@pve.example" });

      // The log reads back through the API with who, what, where.
      const log = (await app.inject({ method: "GET", url: `/api/mail-copilot/actions?paneId=${encodeURIComponent(pane.id)}&limit=10`, headers })).json().actions as Array<{ action: string; threadId: string; labelNames: string[] }>;
      expect(log.map((entry) => [entry.action, entry.threadId])).toEqual([["FIX", "pt3"], ["FIX", "pt2"], ["FIX", "pt1"]]);
      expect(log[0]!.labelNames).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/api/mail-copilot/actions?source=GMAIL", headers })).json().actions).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("learns approved rules from consistent operator actions per account (sender, or sender and subject shape) and retires one the operator takes back", async () => {
    const deals = (n: number) => ({ id: `d${n}`, threadId: `s${n}`, from: "Deals <deals@shop.example>", subject: `Weekly deals ${n}`, minutesAgo: 10 + n, labelIds: ["INBOX"], plain: "Deals" });
    const billing = (n: number, subject: string) => ({ id: `b${n}`, threadId: `i${n}`, from: "Acme Billing <billing@acme.com>", subject, minutesAgo: 20 + n, labelIds: ["INBOX"], plain: "Bill" });
    const { app, pane, headers, agent, paneUrl, repository, store } = await fixture([deals(1), deals(2), deals(3), deals(4), deals(5),
      billing(1, "Invoice 1"), billing(2, "Invoice 2"), billing(3, "Invoice 3"), billing(4, "Acme newsletter"), billing(5, "Invoice 5")]);
    const operator = (threadId: string, action: string, labelIds?: string[]) => app.inject({ method: "POST", url: `/api/mail-copilot/threads/${threadId}/modify`, headers, payload: { paneId: pane.id, account: "me@gmail.com", action, ...(labelIds ? { labelIds } : {}) } });
    const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
    const learned = async () => (await repository.listRules(owner)).filter((rule) => rule.proposedBy === "LEARNED");
    try {
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { autonomy: "RULES" } } });
      await operator("s1", "archive");
      await operator("s2", "archive");
      expect(await learned()).toEqual([]);
      await operator("s3", "archive");
      const [rule] = await learned();
      expect(rule).toMatchObject({ status: "APPROVED", accountEmail: "me@gmail.com", condition: { fromAddress: "deals@shop.example" }, action: { type: "ARCHIVE" }, confidence: 1, name: "Archive mail from deals@shop.example" });
      expect(rule!.evidence[0]).toBe("You did this 3 of 3 times on me@gmail.com in the last 90 days");
      const open = (await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ title: string; severity: string; body: string }>;
      expect(open.find((entry) => entry.title.startsWith("Mail Copilot learned a rule"))).toMatchObject({ severity: "INFO", body: "Rule learned from your actions: Archive mail from deals@shop.example" });

      // The learned rule lets the copilot act alone under Rules; the operator taking that back retires it, and it is never learned again.
      expect((await app.inject({ method: "POST", url: `${cli}/threads/s4/modify`, headers: agent, payload: { account: "me@gmail.com", action: "archive", ruleId: rule!.id } })).statusCode).toBe(200);
      await operator("s4", "unarchive");
      expect((await repository.getRule(owner, rule!.id))?.status).toBe("RETIRED");
      const retired = (await app.inject({ method: "GET", url: `/api/mail-copilot/events?paneId=${encodeURIComponent(pane.id)}&limit=5`, headers })).json().events.find((event: { type: string }) => event.type === "RULE_RETIRED");
      expect(retired.message).toBe("Rule retired: Archive mail from deals@shop.example (you took back what it did)");
      await operator("s5", "archive");
      expect((await learned()).map((entry) => entry.status)).toEqual(["RETIRED"]);

      // Mixed handling of a sender: invoices go to Invoices, the newsletter is archived; the subject shape makes the rule.
      await operator("i4", "archive");
      for (const thread of ["i1", "i2", "i3"]) await operator(thread, "move", ["Invoices"]);
      const invoices = (await learned()).find((entry) => entry.action.type === "MOVE");
      expect(invoices).toMatchObject({ condition: { fromAddress: "billing@acme.com" }, action: { type: "MOVE", labels: ["Label_1"] }, name: 'Move to Invoices mail from billing@acme.com about "Invoice 3"' });
      expect(invoices!.condition.subjectPattern).toMatch(/invoice\\s\+\\d\+$/);
      expect((await app.inject({ method: "POST", url: `${cli}/threads/i5/modify`, headers: agent, payload: { account: "me@gmail.com", action: "move", labelIds: ["Invoices"], ruleId: invoices!.id } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `${cli}/threads/i4/modify`, headers: agent, payload: { account: "me@gmail.com", action: "move", labelIds: ["Invoices"], ruleId: invoices!.id } })).statusCode).toBe(409);

      // The Memory tab lists each sender's habit per account; Forget drops the sender's rows and retires the rules learned from them.
      const listed = (await app.inject({ method: "GET", url: `/api/mail-copilot/habits?paneId=${encodeURIComponent(pane.id)}`, headers })).json().habits as Array<{ account: string; sender: string; summary: string }>;
      expect(listed.find((habit) => habit.sender === "billing@acme.com")).toMatchObject({ account: "me@gmail.com", summary: "moved to Invoices 3 of 4 (75%); archived 1 of 4 (25%)" });
      expect(listed.find((habit) => habit.sender === "deals@shop.example")?.summary).toBe("archived 4 of 4 (100%); moved back to the inbox once");
      const forgot = await app.inject({ method: "DELETE", url: `/api/mail-copilot/habits?${new URLSearchParams({ paneId: pane.id, account: "me@gmail.com", sender: "billing@acme.com" })}`, headers });
      expect(forgot.json()).toEqual({ forgotten: 5, retired: 1 });
      expect((await repository.getRule(owner, invoices!.id))?.status).toBe("RETIRED");
      expect((await app.inject({ method: "GET", url: `/api/mail-copilot/habits?paneId=${encodeURIComponent(pane.id)}`, headers })).json().habits.map((habit: { sender: string }) => habit.sender)).toEqual(["deals@shop.example"]);
    } finally {
      await app.close();
    }
  });

  it("under Rules the agent acts alone only with an approved matching rule, the operator's own actions become learn items, and proposals wait for the operator", async () => {
    const { app, store, pane, headers, agent, gmail, paneUrl, repository } = await fixture([
      { id: "m1", threadId: "t1", from: "Acme Billing <billing@acme.com>", subject: "Invoice 42", minutesAgo: 5, labelIds: ["INBOX"], plain: "Please pay" },
      { id: "m2", threadId: "t2", from: "Anna <anna@other.org>", subject: "Lunch?", minutesAgo: 3, labelIds: ["INBOX"], plain: "Friday?" }
    ]);
    try {
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { autonomy: "RULES" } } });
      const archive = { account: "me@gmail.com", action: "archive" };
      // No rule named: review needed.
      const bare = await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: archive });
      expect(bare.statusCode).toBe(409);
      expect(bare.json().error.message).toMatch(/ruleId/);
      // The agent proposes a rule; the operator gets a notification and decides in the rail.
      const proposed = await app.inject({ method: "POST", url: `${cli}/rules/propose`, headers: agent, payload: { name: "Archive Acme invoices", accountEmail: "me@gmail.com", condition: { domain: "acme.com", subjectPattern: "invoice" }, action: { type: "ARCHIVE" }, confidence: 0.8, evidence: ["You archived Invoice 41 on Monday", "You archived Invoice 40 last week"] } });
      expect(proposed.statusCode).toBe(200);
      const ruleId = proposed.json().rule.id as string;
      expect(proposed.json().rule).toMatchObject({ status: "PROPOSED", proposedBy: "AGENT", appliedCount: 0 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json()).toMatchObject({ total: 1, bySource: { MAIL_COPILOT: 1 } });
      // A proposed rule grants nothing.
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { ...archive, ruleId } })).statusCode).toBe(409);
      const approved = await app.inject({ method: "POST", url: `/api/mail-copilot/rules/${encodeURIComponent(ruleId)}/decide`, headers, payload: { decision: "approve" } });
      expect(approved.json().rule).toMatchObject({ status: "APPROVED" });
      expect(approved.json().rule.decidedAt).not.toBeNull();
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);
      expect((await app.inject({ method: "GET", url: `${cli}/rules?status=APPROVED`, headers: agent })).json().rules.map((rule: { id: string }) => rule.id)).toEqual([ruleId]);
      // The rule matches the invoice thread (archive goes through, the use is counted) but not Anna's lunch mail.
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { ...archive, ruleId } })).statusCode).toBe(200);
      expect(gmail.writes.at(-1)).toMatchObject({ path: "/threads/t1/modify", body: { removeLabelIds: ["INBOX"] } });
      expect((await app.inject({ method: "GET", url: "/api/mail-copilot/rules", headers })).json().rules[0]).toMatchObject({ id: ruleId, appliedCount: 1 });
      const mismatch = await app.inject({ method: "POST", url: `${cli}/threads/t2/modify`, headers: agent, payload: { ...archive, ruleId } });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error.message).toMatch(/does not match/);
      // A rule for another action never covers a send.
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: { account: "me@gmail.com", to: ["billing@acme.com"], subject: "Re: Invoice 42", text: "Paid", threadId: "t1", inReplyToMessageId: "m1", ruleId } })).json().error.message).toMatch(/allows ARCHIVE, not send/);
      // Retired: the rule stops working.
      await app.inject({ method: "POST", url: `/api/mail-copilot/rules/${encodeURIComponent(ruleId)}/decide`, headers, payload: { decision: "retire" } });
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { ...archive, ruleId } })).statusCode).toBe(409);

      // A LABEL rule lets the copilot add only its own labels; a label's name resolves to the account's label id.
      const labelRule = (await app.inject({ method: "POST", url: "/api/mail-copilot/rules", headers, payload: { name: "Acme to Invoices", accountEmail: "me@gmail.com", condition: { fromAddress: "billing@acme.com" }, action: { type: "LABEL", labels: ["Label_1"] } } })).json().rule.id as string;
      const otherLabel = await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { account: "me@gmail.com", action: "label", labelIds: ["Friends"], ruleId: labelRule } });
      expect(otherLabel.json().error.message).toMatch(/allows only the labels Label_1/);
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: { account: "me@gmail.com", action: "label", labelIds: ["Invoices"], ruleId: labelRule } })).statusCode).toBe(200);
      expect(gmail.writes.at(-1)).toMatchObject({ path: "/threads/t1/modify", body: { addLabelIds: ["Label_1"] } });

      // What the operator does by hand lands in the account's action log with the correspondent and the subject; an Undo takes it back out.
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t2/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "star" } });
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t2/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "archive" } });
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t2/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "unarchive" } });
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t2/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "move", labelIds: ["Friends"] } });
      expect(gmail.writes.at(-1)).toMatchObject({ path: "/threads/t2/modify", body: { addLabelIds: ["Label_2"], removeLabelIds: ["INBOX"] } });
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t2/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "read" } });
      await app.inject({ method: "POST", url: "/api/mail-copilot/messages/send", headers, payload: { paneId: pane.id, account: "me@gmail.com", to: ["anna@other.org"], subject: "Re: Lunch?", text: "Friday works, see you at 1. Best, Me", threadId: "t2", inReplyToMessageId: "m2" } });
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const log = await repository.listActions(owner, { accountEmail: "me@gmail.com", limit: 20 });
      expect(log.map((row) => [row.action, row.actor, row.threadId])).toEqual([["REPLY", "OPERATOR", "t2"], ["MOVE", "OPERATOR", "t2"], ["STAR", "OPERATOR", "t2"], ["LABEL", "AGENT", "t1"], ["ARCHIVE", "AGENT", "t1"]]);
      expect(log[1]).toMatchObject({ labelIds: ["Label_2"], fromAddress: "anna@other.org", fromDomain: "other.org", subject: "Lunch?", subjectKey: "lunch?", source: "PANE" });
      expect(log[3]).toMatchObject({ ruleId: labelRule, fromAddress: "billing@acme.com", subjectKey: "invoice 0" });
      // Only the hand-written reply is still a learn item; archive, trash and labels are learned from the log.
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      const first = await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } });
      expect(first.json().item).toMatchObject({ type: "USER_ACTION", threadId: "t2", payload: { action: "reply", text: "Friday works, see you at 1. Best, Me", from: "Anna <anna@other.org>" } });
      expect(first.json().context.thread.messages[0].text).toBe("Friday?");
      // Each item carries the operator's habits with its correspondent on this account (label names resolved); the copilot's own actions never count.
      const habits = first.json().context.habits;
      expect(habits).toMatchObject({ account: "me@gmail.com", sender: "anna@other.org", domain: "other.org", subjectKey: "lunch?" });
      expect(habits.levels[0]).toMatchObject({ level: "sender", decisions: 1 });
      expect(habits.levels[0].actions.find((entry: { action: string }) => entry.action === "MOVE")).toMatchObject({ observed: 1, inferred: 0, share: 1, labels: [{ id: "Label_2", name: "Friends" }] });
      expect(habits.levels[0].actions.find((entry: { action: string }) => entry.action === "REPLY")).toMatchObject({ observed: 1, share: null });
      expect(habits.summary[0]).toMatch(/^anna@other.org on me@gmail.com: moved to Friends 1 of 1 \(100%\); replied to once; starred once$/);
      const billing = await app.inject({ method: "POST", url: `${cli}/habits`, headers: agent, payload: { account: "me@gmail.com", from: "Acme Billing <billing@acme.com>", subject: "Invoice 43" } });
      expect(billing.json()).toMatchObject({ sender: "billing@acme.com", subjectKey: "invoice 0", levels: [], summary: [] });
    } finally {
      await app.close();
    }
  });
});
