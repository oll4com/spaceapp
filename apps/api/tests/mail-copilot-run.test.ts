import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, makeSpaceId, SpaceEventBus } from "@space/runtime";
import { InMemoryMailCopilotRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { defaultMailCopilotPaneMetadata, eventSchema, type ConnectorCapability, type Event, type MailCopilotEvent, type MailCopilotRun, type Pane } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { createMailCopilotService, type MailCopilotGoogleAccess } from "../src/mail-copilot/service.js";
import { createMailCopilotKickoff } from "../src/mail-copilot/kickoff.js";
import { notifyMailCopilotEvent } from "../src/mail-copilot/notify.js";
import { createNotificationService } from "../src/notifications/service.js";

import type { RoomPaneObservation } from "../src/room-pane-control.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
interface FakeMessage { id: string; threadId: string; from: string; subject: string; minutesAgo: number; labelIds: string[]; plain: string; files?: Array<{ id: string; filename: string; mimeType: string; data: string }> }

/** The smallest Gmail an agent run needs: inbox threads, one thread, modify, send, drafts; records every write. */
function fakeGmail(token: string, inbox: FakeMessage[]) {
  const writes: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  // Each draft's current message: Gmail gives an edited draft a new one.
  const draftMessages = new Map([["draft-1", "draft-msg-1"]]);
  const deletedDrafts: string[] = [];
  const full = (message: FakeMessage) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds, internalDate: String(Date.now() - message.minutesAgo * 60_000), snippet: message.plain.slice(0, 80),
    payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: message.from }, { name: "To", value: "Me <me@gmail.com>" }, { name: "Subject", value: message.subject }, { name: "Message-ID", value: `<${message.id}@mail.example>` },
      { name: "Date", value: new Date(Date.now() - message.minutesAgo * 60_000).toUTCString() }], parts: [{ mimeType: "text/plain", body: { data: b64(message.plain) } }, { mimeType: "text/html", body: { data: b64(`<p>${message.plain}</p>`) } },
      ...(message.files ?? []).map((file) => ({ mimeType: file.mimeType, filename: file.filename, body: { attachmentId: file.id, size: Buffer.byteLength(file.data) } }))] } });
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
    if (path === "/settings/sendAs") return Response.json({ sendAs: [{ sendAsEmail: "me@gmail.com", isPrimary: true, isDefault: true }] });
    if (path === "/messages/send") return Response.json({ id: `sent-${writes.length}`, threadId: (body as { threadId?: string }).threadId ?? "thread-new" });
    const part = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (part) { const file = inbox.find((entry) => entry.id === part[1])?.files?.find((entry) => entry.id === part[2]); return file ? Response.json({ data: b64(file.data) }) : Response.json({ error: { message: "nope" } }, { status: 404 }); }
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message) { const row = inbox.find((entry) => entry.id === message[1]); return row ? Response.json(full(row)) : Response.json({ error: { message: "nope" } }, { status: 404 }); }
    if (path === "/drafts") return Response.json({ id: "draft-1", message: { id: "draft-msg-1" } });
    const draft = /^\/drafts\/([^/]+)$/.exec(path)?.[1];
    if (/^\/messages\/[^/]+\/trash$/.test(path)) return Response.json({ id: path.split("/")[2] });
    if (draft && init?.method === "DELETE") { deletedDrafts.push(draft); return new Response(null, { status: 204 }); }
    if (draft) return Response.json({ id: draft, message: { id: draftMessages.get(draft) ?? "other-msg" } });
    return Response.json({ error: { message: `unexpected ${path}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, writes, draftMessages, deletedDrafts };
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

      // Assist: sending is refused, a draft is fine, a review hands the reply to the operator (and raises a notification).
      const draft = { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Invoice question", text: "Hi Anna, attached again. Best, Me", threadId: "t1", inReplyToMessageId: "m1" };
      const refused = await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: draft });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/MAIL_NEEDS_REVIEW/);
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
      // Organizing is the copilot's own job under Assist too (operator 2026-10-27): archive, label, move and trash go through.
      for (const action of [{ action: "archive" }, { action: "label", labelIds: ["Invoices"] }, { action: "move", labelIds: ["Invoices"] }, { action: "trash" }]) {
        expect((await app.inject({ method: "POST", url: `${cli}/threads/t2/modify`, headers: agent, payload: { account: "me@gmail.com", ...action } })).statusCode).toBe(200);
      }
      expect(gmail.writes.slice(-4).map((write) => write.path)).toEqual(["/threads/t2/modify", "/threads/t2/modify", "/threads/t2/modify", "/threads/t2/trash"]);
    } finally {
      await app.close();
    }
  });

  it("raises no review or question its own memory forbids, naming the memory (R12-5)", async () => {
    // 29/10 09:16 BKK: review mailrev:zTKfA_IVEmwC (a Telnyx thank-you) reached Needs you although mailmem:HkyoywEn0sDc forbade exactly that.
    const { app, agent, repository, store, pane } = await fixture([
      { id: "m1", threadId: "t1", from: "Telnyx Talent <talent@telnyx.com>", subject: "Your application", minutesAgo: 30, labelIds: ["INBOX"], plain: "We went with another candidate." },
      { id: "m2", threadId: "t2", from: "Anna Client <anna@acme.com>", subject: "Invoice question", minutesAgo: 20, labelIds: ["INBOX"], plain: "Can you resend the invoice?" }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const rule = await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "telnyx rejection", text: "Telnyx rejection thank-you: no draft, no review request, no question, never a notification. Archive it.",
        contactEmail: null, domain: "telnyx.com", accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false });
      const draft = (to: string, subject: string, threadId: string) => ({ account: "me@gmail.com", to: [to], subject, text: "Thanks.", threadId });
      const refused = await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft: draft("talent@telnyx.com", "Re: Your application", "t1"), summary: "Optional short thank-you" } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain(`Not raised: Mail Copilot memory ${rule.id} forbids it`);
      const question = await app.inject({ method: "POST", url: `${cli}/question`, headers: agent, payload: { question: "Send Telnyx a thank-you for the rejection?", accountEmail: "me@gmail.com", threadId: "t1" } });
      expect(question.statusCode).toBe(409);
      expect((await repository.listEvents(owner, { types: ["QUESTION", "REVIEW_REQUESTED"], limit: 10 }))).toEqual([]);
      // Another correspondent, another subject: raised as before.
      expect((await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft: draft("anna@acme.com", "Re: Invoice question", "t2"), summary: "Reply resending the invoice" } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("raises no review promising a call, a visit or a payment unless a memory allows it, naming the stored policy (R12-6)", async () => {
    // 29/10 09:2x BKK: mailrev:tmL-VVdJEC-3 asked "approve only if you or someone will call" while mailmem:ayKBBtka7V3t said what to write.
    const { app, agent, repository, store, pane } = await fixture([
      { id: "m1", threadId: "t1", from: "Maria <maria@customer.example>", subject: "Νέα παραγγελία 1042", minutesAgo: 30, labelIds: ["INBOX"], plain: "Πότε έρχεται;" }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const policy = await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "orders", text: "Order mails: thank them, give the order number, the courier sends the tracking. Never promise a call.",
        contactEmail: null, domain: null, accountEmail: "me@gmail.com", tags: [], source: "USER", confidence: 1, pinned: false });
      const review = (text: string) => app.inject({ method: "POST", url: `${cli}/review`, headers: agent,
        payload: { draft: { account: "me@gmail.com", to: ["maria@customer.example"], subject: "Re: Νέα παραγγελία 1042", text, threadId: "t1" }, summary: "Order reply" } });
      for (const text of ["Ευχαριστούμε! Θα σας καλέσουμε αύριο.", "Thanks Maria, we will call you tomorrow.", "We'll refund the shipping."]) {
        const refused = await review(text);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.message).toContain(`Write what ${policy.id} says for this mail instead`);
      }
      expect((await review("Thanks Maria, we will call you tomorrow.")).json().error.message).toContain("commits the operator to a phone call (\"we will call\")");
      expect(await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"], limit: 10 })).toEqual([]);
      // No promise, or a memory about the recipient that allows the act: raised.
      expect((await review("Thanks Maria, order 1042 ships today.")).statusCode).toBe(200);
      await repository.upsertMemory({ ownerUserId: owner, kind: "PREFERENCE", key: "maria", text: "Maria confirms orders by phone call.", contactEmail: "maria@customer.example", domain: null,
        accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false });
      expect((await review("Θα σας καλέσουμε αύριο.")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("answers a thread asking to schedule an interview although a rejection rule shares its words; a rejection still refused; replied needs a sent message (2/11)", async () => {
    // 2/11 McArthur/WIM: «Would Wednesday or Thursday at 12:00 work?» was read as a rejection by mailmem:HkyoywEn0sDc; the reply sat 4 hours as a draft.
    const { app, agent, repository, store, pane, paneUrl, headers } = await fixture([
      { id: "m1", threadId: "t1", from: "Sarah Recruiter <sarah@mcarthur.example>", subject: "Re: WIM Reporting Analyst", minutesAgo: 30, labelIds: ["INBOX"],
        plain: "Thanks for your interest. Would Wednesday or Thursday at 12:00 noon Bangkok time work for you for a Teams call? Let me know which day suits you best." },
      { id: "m2", threadId: "t2", from: "Talent <talent@other.example>", subject: "Your application", minutesAgo: 20, labelIds: ["INBOX"],
        plain: "Thank you for applying. Unfortunately we will not move forward with your application." }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "recruiter rejections", contactEmail: null, domain: null, accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false,
        text: "Never reply to recruiter or ATS mails that reject (\"we will not move forward\"), close or fill a role, say \"thanks for applying\" or confirm an application. No draft, no review request, no question. Archive them." });
      const review = (to: string, subject: string, threadId: string, text: string) => app.inject({ method: "POST", url: `${cli}/review`, headers: agent,
        payload: { draft: { account: "me@gmail.com", to: [to], subject, text, threadId }, summary: "Reply to the recruiter" } });
      const scheduled = await review("sarah@mcarthur.example", "Re: WIM Reporting Analyst", "t1", "Hi Sarah, Wednesday at 12:00 noon works for me; I'll call in on Teams then.");
      expect(scheduled.statusCode).toBe(200);
      const rejected = await review("talent@other.example", "Re: Your application", "t2", "Thanks for letting me know.");
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().error.message).toContain("forbids it");

      expect((await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers })).statusCode).toBe(200);
      const item = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json().item as { id: string };
      const replied = await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: item.id, outcome: "replied", summary: "Replied with the slot." } });
      expect(replied.statusCode).toBe(409);
      expect(replied.json().error.message).toContain("so it is not replied");
      expect((await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: item.id, outcome: "drafted", summary: "Reply with the slot." } })).statusCode).toBe(200);
      const reported = (await repository.listEvents(owner, {})).find((event) => event.payload.itemId === item.id)!;
      expect(reported.message).toBe("DRAFT, not sent: Reply with the slot.");
    } finally {
      await app.close();
    }
  });

  it("raises the review of our own new application on a thread with no mail from the other side; a rejection still refused (BlooMind 5/11)", async () => {
    // ntheogr thread 1a1a6dd84e85adcd (draft 1a1a74d6eb750c32 with the CV): only our application to Tamara, refused by mailmem:HkyoywEn0sDc's words.
    const { app, agent, repository, store, pane } = await fixture([
      { id: "d1", threadId: "t1", from: "Me <me@gmail.com>", subject: "Your application at BlooMind", minutesAgo: 30, labelIds: ["DRAFT"],
        plain: "Hi Tamara, I applied on LinkedIn and, as the posting asks, I send you my CV directly." },
      { id: "m2", threadId: "t2", from: "Talent <talent@other.example>", subject: "Your application", minutesAgo: 20, labelIds: ["INBOX"],
        plain: "Thank you for applying. Unfortunately we will not move forward with your application." }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "recruiter rejections", contactEmail: null, domain: null, accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false,
        text: "Never reply to recruiter or ATS mails that reject (\"we will not move forward\"), close or fill a role, say \"thanks for applying\" or confirm an application. No draft, no review request, no question. Archive them." });
      const review = (to: string, threadId: string) => app.inject({ method: "POST", url: `${cli}/review`, headers: agent,
        payload: { draft: { account: "me@gmail.com", to: [to], subject: "Your application at BlooMind", text: "Hi Tamara, my CV is attached.", threadId }, summary: "Reply to the recruiter with the application" } });
      expect((await review("tamara@bloomind.example", "t1")).statusCode).toBe(200);
      const refused = await review("talent@other.example", "t2");
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("forbids it");
    } finally {
      await app.close();
    }
  });

  it("answers a recruiter mail asking the candidate to write although a rejection rule shares its words; a rejection with advice and a plain receipt still refused (3/11)", async () => {
    // 3/11 Human Power BG via Manatal (thread 1a19f88ca18c4c1e): «Please send a message that you have applied to …» was refused by mailmem:HkyoywEn0sDc.
    const { app, agent, repository, store, pane } = await fixture([
      { id: "m1", threadId: "t1", from: "Slavi Slavov <noreply@manatal.example>", subject: "Your Application to Full-Stack Node.js & React Developer", minutesAgo: 30, labelIds: ["INBOX"],
        plain: "Dear Nikolaos Theodoropoulos, Please send a message that you have applied to slavi.slavov@humanpowerbg.example This is to confirm we have received your application for Full-Stack Node.js & React Developer." },
      { id: "m2", threadId: "t2", from: "Phasathorn <talent@arcfusion.example>", subject: "Re: Your Application at ArcFusion", minutesAgo: 20, labelIds: ["INBOX"],
        plain: "Thank you for following up. After careful consideration, we have decided not to move forward with your application. Please keep building hands-on GenAI projects, and please send us your updated CV for future roles." },
      { id: "m3", threadId: "t3", from: "Talent <talent@receipt.example>", subject: "Your application", minutesAgo: 10, labelIds: ["INBOX"],
        plain: "Thank you for applying. We have received your application and will be in touch." }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "recruiter rejections", contactEmail: null, domain: null, accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false,
        text: "Never reply to recruiter or ATS mails that reject (\"we will not move forward\"), close or fill a role, say \"thanks for applying\" or confirm an application. No draft, no review request, no question. Archive them." });
      const review = (to: string, subject: string, threadId: string, text: string) => app.inject({ method: "POST", url: `${cli}/review`, headers: agent,
        payload: { draft: { account: "me@gmail.com", to: [to], subject, text, threadId }, summary: "Reply to the recruiter" } });
      expect((await review("slavi.slavov@humanpowerbg.example", "Your application to Full-Stack Node.js & React Developer", "t1", "Hi Slavi, I have applied for the Full-Stack Node.js & React Developer role.")).statusCode).toBe(200);
      for (const [to, subject, threadId] of [["talent@arcfusion.example", "Re: Your Application at ArcFusion", "t2"], ["talent@receipt.example", "Re: Your application", "t3"]]) {
        const refused = await review(to!, subject!, threadId!, "Thank you for letting me know.");
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.message).toContain("forbids it");
      }
    } finally {
      await app.close();
    }
  });

  it("raises a review a rejection memory refused when the thread is about a test, or when the operator's own recent order names it (5/11)", async () => {
    // 5/11 nous_msg:8f84e7e6b64443178d24d715: Criteria's Eight Sleep test (Event EGH76By2Tw1mSx4v) closed mid-way; the operator asked to write
    // and ask for a new test, and mailmem:HkyoywEn0sDc refused the review.
    const gmail = fakeGmail("token-me", [
      { id: "m1", threadId: "t1", from: "Hiring Team <do-not-reply@criteriacorp.example>", subject: "Next step in your application with Eight Sleep", minutesAgo: 60, labelIds: ["INBOX"],
        plain: "Eight Sleep has asked you to take 2 assessments for the Senior Backend Engineer position: the CCAT (5-7 minutes) and a personality questionnaire (about 9 minutes). Click Start now to begin. Event ID: EGH76By2Tw1mSx4v" },
      { id: "m2", threadId: "t2", from: "Talent <talent@other.example>", subject: "Your application", minutesAgo: 20, labelIds: ["INBOX"],
        plain: "Thank you for applying. Unfortunately we will not move forward with your application." }]);
    const owner = "user:owner";
    const order = "nous_msg:8f84e7e6b64443178d24d715";
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const refs = [{ id: order, createdAt: hoursAgo(1), person: true }, { id: "nous_msg:fromAnAgentSession", createdAt: hoursAgo(1), person: false },
      { id: "nous_msg:olderThanTwoDays", createdAt: hoursAgo(49), person: true }];
    const repository = new InMemoryMailCopilotRepository();
    const service = createMailCopilotService({ google: () => google, gmailFetch: gmail.fetchImpl, repository, operatorMessages: async (who) => who === owner ? refs : [] });
    const store = new InMemorySpaceStore();
    const pane = store.createPane({ roomId: store.createRoom({ name: "Mail", initialPaneCount: 0 }).id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
    const rule = await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: "criteria rejections", contactEmail: null, domain: "criteriacorp.example", accountEmail: null, tags: [], source: "USER",
      confidence: 1, pinned: true, text: "Criteria (ATS) mails: never reply to recruiter/ATS rejections, closings, thanks-for-applying. No draft, no review request, no question." });
    const review = (who: string, threadId: string, operatorOrder?: string) => service.requestReview(who, pane, { summary: "Ask Criteria for a new test link",
      draft: { account: "me@gmail.com", to: ["do-not-reply@criteriacorp.example"], subject: "Re: Next step in your application with Eight Sleep - assessment closed mid-test (Event ID EGH76By2Tw1mSx4v)",
        text: "Hello, my Criteria assessment (Event ID EGH76By2Tw1mSx4v) closed in the middle of the test. Could you kindly send me a new test link?", threadId }, ...(operatorOrder ? { operatorOrder } : {}) });

    expect(await review(owner, "t1")).toEqual({ reviewId: expect.stringMatching(/^mailrev:/) });
    // The same words on a rejection thread are refused by the memory, unless the operator's order names the reply.
    await expect(review(owner, "t2")).rejects.toThrow(`memory ${rule.id} forbids it`);
    const ordered = await review(owner, "t2", order);
    expect(ordered.overrides).toBe(`operator order ${order} overrides memory ${rule.id}`);
    const raised = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"] })).find((event) => event.payload.reviewId === ordered.reviewId)!;
    expect(raised).toMatchObject({ message: expect.stringContaining(ordered.overrides!), payload: { operatorOrder: order, reasoning: ordered.overrides } });
    // Only a person's own message to Nous from the last 48 hours of the same owner counts.
    for (const [who, id] of [[owner, "nous_msg:fromAnAgentSession"], [owner, "nous_msg:olderThanTwoDays"], [owner, "nous_msg:neverWrittenAtAll"], ["user:other", order]] as const) {
      await expect(review(who, "t2", id), id).rejects.toThrow("is not a message the operator wrote to Nous in the last 48 hours");
    }
  });

  it("sends a review with the attachments of the Gmail draft it names, and refuses when they changed after the review (BlooMind 5/11)", async () => {
    // ntheogr thread 1a1a6dd84e85adcd: Job Copilot's round-10 draft to Tamara carried the CV; review_request could not, so only the operator could send it.
    const pdf = "%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n";
    const draftMail = { id: "d1", threadId: "t1", from: "Me <me@gmail.com>", subject: "Re: Your application at BlooMind", minutesAgo: 10, labelIds: ["DRAFT"], plain: "Hi Tamara, my CV is attached.",
      files: [{ id: "att-cv", filename: "Nikolaos-CV.pdf", mimeType: "application/pdf", data: pdf }] };
    const inbox = [{ id: "m1", threadId: "t1", from: "Tamara <tamara@bloomind.example>", subject: "Your application at BlooMind", minutesAgo: 60, labelIds: ["INBOX"],
      plain: "Thanks Nikolaos, could you send us your CV? Please reply with it attached." }, draftMail];
    const gmail = fakeGmail("token-me", inbox);
    const repository = new InMemoryMailCopilotRepository();
    const service = createMailCopilotService({ google: () => google, gmailFetch: gmail.fetchImpl, repository });
    const store = new InMemorySpaceStore();
    const pane = store.createPane({ roomId: store.createRoom({ name: "Mail", initialPaneCount: 0 }).id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
    const owner = "user:owner";
    const draft = { account: "me@gmail.com", to: ["tamara@bloomind.example"], cc: [], bcc: [], subject: "Re: Your application at BlooMind", text: "Hi Tamara, my CV is attached.", threadId: "t1", inReplyToMessageId: "m1" };
    const review = (attachmentsFrom: string) => service.requestReview(owner, pane, { draft, summary: "Send Tamara the CV", attachmentsFrom });

    await expect(review("m1")).rejects.toThrow("m1 holds no attachments");
    const { reviewId } = await review("d1");
    const raised = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"] }))[0]!;
    expect(raised.message).toContain("[attachments: Nikolaos-CV.pdf]");
    expect(raised.payload).toMatchObject({ attachmentsFrom: "d1", attachments: [{ filename: "Nikolaos-CV.pdf", mimeType: "application/pdf", size: Buffer.byteLength(pdf) }] });
    expect(await service.decideReview(owner, pane, { reviewId, decision: "approve" })).toMatchObject({ decision: "approve", sent: { messageId: expect.stringMatching(/^sent-/) } });
    const sends = gmail.writes.filter((write) => write.path === "/messages/send");
    expect(sends).toHaveLength(1);
    const mime = Buffer.from(String(sends[0]!.body!.raw), "base64url").toString("utf8");
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="([^"]+)"/);
    expect(mime).toContain('Content-Type: application/pdf; name="Nikolaos-CV.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="Nikolaos-CV.pdf"');
    expect(mime).toContain(Buffer.from(pdf).toString("base64"));
    expect(mime).toContain(Buffer.from(draft.text).toString("base64"));
    expect((await repository.listEvents(owner, { types: ["SENT"] }))[0]!.payload.attachments).toEqual(["Nikolaos-CV.pdf"]);

    // The draft's files changed after the review: nothing is sent, a new review is needed.
    const second = await review("d1");
    draftMail.files = [{ id: "att-other", filename: "Other.pdf", mimeType: "application/pdf", data: pdf }];
    await expect(service.decideReview(owner, pane, { reviewId: second.reviewId, decision: "approve" })).rejects.toThrow("changed since the review");
    expect(gmail.writes.filter((write) => write.path === "/messages/send")).toHaveLength(1);
  });

  it("answers a question its own memory may answer with the memories first, and asks only with afterMemory (R13-5)", async () => {
    const { app, agent, repository, store, pane } = await fixture([]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const fact = await repository.upsertMemory({ ownerUserId: owner, kind: "FACT", key: "courier for olla orders", text: "ACS Courier, tracking within 24 hours.", contactEmail: null, domain: null,
        accountEmail: null, tags: [], source: "USER", confidence: 1, pinned: false });
      const ask = (afterMemory?: boolean) => app.inject({ method: "POST", url: `${cli}/question`, headers: agent, payload: { question: "Which courier do olla orders use?", ...(afterMemory ? { afterMemory } : {}) } });
      expect((await ask()).json()).toMatchObject({ questionId: null, memoryHits: [{ id: fact.id, text: "ACS Courier, tracking within 24 hours." }], note: expect.stringContaining("afterMemory: true") });
      expect(await repository.listEvents(owner, { types: ["QUESTION"], limit: 5 })).toEqual([]);
      expect((await ask(true)).json().questionId).toMatch(/^mailq:/);
    } finally {
      await app.close();
    }
  });

  it("recommends Approve on a review card whose reply an approved REPLY rule covers (R12-4)", async () => {
    const { app, agent, repository, store, pane } = await fixture([
      { id: "m1", threadId: "t1", from: "Anna Client <anna@acme.com>", subject: "Invoice question", minutesAgo: 30, labelIds: ["INBOX"], plain: "Can you resend the invoice?" }]);
    try {
      const owner = (await store.getRoom(pane.roomId)).ownerUserId!;
      const review = async (to: string) => {
        const draft = { account: "me@gmail.com", to: [to], subject: "Re: Invoice question", text: "Attached again.", threadId: "t1" };
        const { reviewId } = (await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft, summary: "Resend the invoice" } })).json();
        const event = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"], limit: 50 })).find((item) => item.payload.reviewId === reviewId)!;
        const raise = vi.fn(async () => null);
        await notifyMailCopilotEvent(event, { roomId: pane.roomId, pane, owner, notifications: { raise, resolve: vi.fn(async () => 0) } as never });
        return (raise.mock.calls[0] as unknown as [{ payload: { ask: { recommended?: string } } }])[0].payload.ask.recommended ?? null;
      };
      expect(await review("anna@acme.com")).toBeNull();
      await repository.createRule({ ownerUserId: owner, accountEmail: "me@gmail.com", name: "Invoices for acme", condition: { domain: "acme.com", subjectPattern: "^invoice" },
        action: { type: "REPLY" }, status: "APPROVED", confidence: 1, evidence: [], proposedBy: "USER" });
      expect(await review("anna@acme.com")).toBe("Approve");
      expect(await review("bob@other.example")).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("starts the daily organize run once a day at the pane's hour in the owner's zone, only unpaused with a CLI, over the whole inbox (operator 2026-10-27)", async () => {
    let clock = "2026-10-27T01:30:00.000Z"; // 08:30 in Bangkok
    const repository = new InMemoryMailCopilotRepository(() => clock);
    const gmail = fakeGmail("token-me", [
      { id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Interview", minutesAgo: 30, labelIds: ["INBOX"], plain: "Tuesday?" },
      { id: "m2", threadId: "t2", from: "Datadog <no-reply@greenhouse.io>", subject: "Thank you for applying", minutesAgo: 60 * 24 * 5, labelIds: ["INBOX"], plain: "Received" },
      { id: "m3", threadId: "t3", from: "Shop <news@shop.example>", subject: "Sale", minutesAgo: 60 * 24 * 3, labelIds: ["INBOX"], plain: "50% off" },
      { id: "m4", threadId: "t4", from: "Bob <bob@acme.com>", subject: "Contract", minutesAgo: 60 * 24 * 2, labelIds: ["INBOX"], plain: "Sign it" }
    ]);
    let cliUp = false;
    const kickoffs: string[] = [];
    const cliStarts: string[] = [];
    const service = createMailCopilotService({ google: () => google, gmailFetch: gmail.fetchImpl, repository, now: () => clock,
      kickoff: { ready: async () => cliUp, cliRunning: async () => cliUp, startCli: async (pane) => { cliStarts.push(pane.id); return true; }, send: async (_pane, run) => { kickoffs.push(run.id); } } });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Mail", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" });
    const owner = "user:owner";
    // t3 was skipped (undecided: offered again), t4 decided already (left for the operator).
    await repository.createEvent({ ownerUserId: owner, paneId: pane.id, runId: null, accountEmail: "me@gmail.com", threadId: "t3", messageId: "m3", type: "TRIAGE", status: "DONE", message: "Triage: Sale", payload: {} });
    await repository.createEvent({ ownerUserId: owner, paneId: pane.id, runId: null, accountEmail: "me@gmail.com", threadId: "t3", messageId: "m3", type: "SKIPPED", status: null, message: "Skipped", payload: {} });
    await repository.createEvent({ ownerUserId: owner, paneId: pane.id, runId: null, accountEmail: "me@gmail.com", threadId: "t4", messageId: "m4", type: "NEEDS_USER", status: null, message: "Contract to sign", payload: {} });
    const zone = "Asia/Bangkok";

    expect(await service.dailyRun(owner, pane, zone)).toBe(false); // before 09:00
    clock = "2026-10-27T02:30:00.000Z"; // 09:30
    expect(await service.dailyRun(owner, pane, zone)).toBe(false); // the CLI is down: Space starts it, the pass waits for its prompt
    expect(cliStarts).toEqual([pane.id]);
    const paused = { ...pane, mailCopilotMetadata: { version: 1 as const, settings: { ...defaultMailCopilotPaneMetadata().settings, paused: true } } };
    cliUp = true;
    expect(await service.dailyRun(owner, paused, zone)).toBe(false);
    expect(kickoffs).toEqual([]);

    expect(await service.dailyRun(owner, pane, zone)).toBe(true);
    expect(kickoffs).toHaveLength(1);
    // Every inbox conversation not decided yet, automated senders and old mail included, once.
    const items = await repository.listEvents(owner, { paneId: pane.id, types: ["TRIAGE"], status: ["PENDING"], limit: 50 });
    expect(items.map((item) => item.threadId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(await service.dailyRun(owner, pane, zone)).toBe(false); // once a day
    clock = "2026-10-27T10:00:00.000Z";
    expect(await service.dailyRun(owner, pane, zone)).toBe(false);
    expect((await repository.listEvents(owner, { paneId: pane.id, types: ["TRIAGE"], limit: 50 })).length).toBe(4);

    clock = "2026-10-28T02:30:00.000Z"; // the next day; waiting items are not made twice; the run idle since yesterday gets its kickoff again
    expect(await service.dailyRun(owner, pane, zone)).toBe(true);
    expect((await repository.listEvents(owner, { paneId: pane.id, types: ["TRIAGE"], limit: 50 })).length).toBe(4);
    expect(kickoffs).toHaveLength(2);
    // New mail with work items starts the run on its own; a run kicked a minute ago is not kicked again; nothing pending starts nothing.
    expect(await service.startForNewMail(owner, pane)).toBe(true);
    expect(kickoffs).toHaveLength(2);
    expect(await service.startForNewMail("user:nobody", pane)).toBe(false);
    expect((await repository.listEvents(owner, { paneId: pane.id, types: ["NOTE"], limit: 50 })).map((event) => event.payload.dailyRun).sort()).toEqual(["2026-10-27", "2026-10-28"]);
  });

  it("types a kickoff only into a running CLI at an empty prompt, and starts a stopped CLI at most once in 10 minutes", async () => {
    let session: unknown = null;
    let screen: Partial<RoomPaneObservation> = { state: "WORKING" };
    const starts: string[] = [];
    const kickoff = createMailCopilotKickoff({ store: { getActivePaneCliSession: async () => session } as never, terminal: {} as never,
      inspect: async () => ({ sessionId: "cli_session:mail1", promptFingerprint: "fp", text: "────\n❯ \n────", ...screen }) as RoomPaneObservation,
      start: async (pane) => { starts.push(pane.id); } });
    const pane = { id: "pane:mail0001" } as Pane;
    expect(await kickoff.cliRunning!(pane)).toBe(false);
    await kickoff.startCli!(pane);
    await kickoff.startCli!(pane);
    expect(starts).toEqual([pane.id]);
    session = { sessionId: "cli_session:mail1", purpose: "NORMAL", isActive: true, status: "RUNNING" };
    expect(await kickoff.cliRunning!(pane)).toBe(true);
    expect(await kickoff.ready(pane)).toBe(false); // the agent is working
    screen = { state: "IDLE" };
    expect(await kickoff.ready(pane)).toBe(true);
    screen = { state: "IDLE", text: "────\n❯ half-written draft\n────" };
    expect(await kickoff.ready(pane)).toBe(false);
    // Nous 03:20 BKK: a session that never got a kickoff from Space (a restart) is new until one goes in; a restart makes it new again.
    const typed = createMailCopilotKickoff({ store: { getActivePaneCliSession: async () => session } as never, terminal: { runSerializedTerminalMutation: async () => undefined } as never });
    expect(await typed.newSession!(pane)).toBe(true);
    await typed.send(pane, { id: "mailrun:run00001" } as MailCopilotRun);
    expect(await typed.newSession!(pane)).toBe(false);
    session = { ...(session as object), sessionId: "cli_session:mail2" };
    expect(await typed.newSession!(pane)).toBe(true);
  });

  it("clears an idle Claude conversation before a new run's kickoff, never before a run's repeated kickoff (plan qH5emwVaV6yO step 9)", async () => {
    const typed: string[] = [];
    const terminal = { runSerializedTerminalMutation: async (_id: string, run: () => Promise<void>) => { await run(); },
      observeRoomScreenUndimmed: async () => "────\n❯ \n────", sendInput: async (_id: string, data: string) => { typed.push(data); } };
    const session = { sessionId: "cli_session:mail1", runtimeId: "cli:claude", purpose: "NORMAL", isActive: true, status: "RUNNING" };
    const kickoff = createMailCopilotKickoff({ store: { getActivePaneCliSession: async () => session } as never, terminal: terminal as never });
    const pane = { id: "pane:mail0001" } as Pane;
    await kickoff.send(pane, { id: "mailrun:run00001", kickoffSentAt: null } as MailCopilotRun);
    expect(typed[0]).toBe("\u001b[200~/clear\u001b[201~");
    expect(typed.filter((data) => data.includes("Mail Copilot run mailrun:run00001"))).toHaveLength(1);
    typed.length = 0;
    await kickoff.send(pane, { id: "mailrun:run00001", kickoffSentAt: "2026-11-06T05:00:00.000Z" } as MailCopilotRun);
    expect(typed.some((data) => data.includes("/clear"))).toBe(false);
  });

  it("asks what to do with a mail left to the operator, and stops asking once they handled the thread (plan clipboard:5AQvaoSR-IZa)", async () => {
    const { app, pane, headers, agent, paneUrl } = await fixture([
      { id: "m1", threadId: "t1", from: "Anna Client <anna@acme.com>", subject: "Sign the form", minutesAgo: 30, labelIds: ["INBOX"], plain: "Please sign the attached form." }
    ]);
    const open = async () => ((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string; payload: Record<string, unknown> }>)
      .filter((entry) => entry.kind === "NEEDS_USER");
    try {
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      const item = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json().item;
      await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: item.id, outcome: "needs_user", summary: "Only you can sign this form." } });
      const [asked] = await open();
      expect(asked!.payload.ask).toEqual({ question: "What should Mail Copilot do with this mail?", options: ["I handled it", "Ignore it"], answer: { kind: "MAIL_FIX", account: "me@gmail.com", threadId: "t1" } });
      expect((await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t1/modify", headers, payload: { account: "me@gmail.com", action: "archive", paneId: pane.id } })).statusCode).toBe(200);
      expect(await open()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("closes the thread's needs-you card once a review in that thread was sent (2/11: ArcFusion's card stayed after REVIEW_DECIDED sent)", async () => {
    const { app, headers, agent, paneUrl } = await fixture([
      { id: "m1", threadId: "t1", from: "Anna Client <anna@acme.com>", subject: "Invoice question", minutesAgo: 30, labelIds: ["INBOX"], plain: "Can you resend the invoice?" }]);
    const open = async () => ((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ kind: string }>)
      .filter((entry) => entry.kind === "NEEDS_USER");
    try {
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      const item = (await app.inject({ method: "POST", url: `${cli}/next`, headers: agent, payload: { waitMs: 0 } })).json().item;
      await app.inject({ method: "POST", url: `${cli}/report`, headers: agent, payload: { eventId: item.id, outcome: "needs_user", summary: "Anna wants the invoice again." } });
      expect(await open()).toHaveLength(1);
      const draft = { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Invoice question", text: "Attached again.", threadId: "t1" };
      const { reviewId } = (await app.inject({ method: "POST", url: `${cli}/review`, headers: agent, payload: { draft, summary: "Resend the invoice" } })).json();
      expect((await app.inject({ method: "POST", url: `${paneUrl}/review`, headers, payload: { reviewId, decision: "approve" } })).json()).toMatchObject({ sent: { threadId: "t1" } });
      expect(await open()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("holds a NEEDS_USER card for Nous under \"Copilot questions go to Nous first\", and raises it as before when Nous does not hold (queue item 32)", async () => {
    for (const holds of [true, false]) {
      const repository = new InMemorySpaceNotificationsRepository();
      const notifications = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
        recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
        nous: { held: async () => false, raised: () => {}, holdsCopilotQuestions: async () => holds } });
      const pane = { id: "pane:mail0001", title: "Mail", mailCopilotMetadata: defaultMailCopilotPaneMetadata() } as Pane;
      const event = { id: "mailevt:sign00001", type: "NEEDS_USER", accountEmail: "me@gmail.com", threadId: "t1", message: "Only you can sign this form.", payload: {} } as unknown as MailCopilotEvent;
      await notifyMailCopilotEvent(event, { roomId: "room:mail0001", pane, owner: "user:operator", notifications });
      const [card] = await notifications.list("user:operator", { status: "ALL", limit: 10 });
      expect(Boolean(card!.payload.heldForNous)).toBe(holds);
      // goal ee5a573e: the card says what the copilot read, so the daily REVIEW does not count it as bare.
      expect(card!.body).toBe("Only you can sign this form.\n\nChecked first:\n• Thread: me@gmail.com t1, read by Mail\n• Labels and rules: none of Mail's rules settles this mail alone");
    }
  });

  it("deletes only a draft the copilot saved itself and nobody changed since", async () => {
    const { app, agent, gmail } = await fixture([]);
    try {
      const remove = (draftId: string) => app.inject({ method: "POST", url: `${cli}/draft/delete`, headers: agent, payload: { account: "me@gmail.com", draftId } });
      expect((await app.inject({ method: "POST", url: `${cli}/draft`, headers: agent, payload: { account: "me@gmail.com", to: ["anna@acme.com"], subject: "Test", text: "Test draft" } })).json())
        .toEqual({ draftId: "draft-1", messageId: "draft-msg-1" });
      expect((await remove("draft-op")).json().error.message).toMatch(/did not save that draft/);
      gmail.draftMessages.set("draft-1", "draft-msg-edited");
      expect((await remove("draft-1")).json().error.message).toMatch(/changed after the copilot saved it/);
      gmail.draftMessages.set("draft-1", "draft-msg-1");
      expect((await remove("draft-1")).json()).toEqual({ ok: true });
      expect(gmail.deletedDrafts).toEqual(["draft-1"]);
    } finally {
      await app.close();
    }
  });

  it("deletes any mail or draft at every autonomy: a message to the Trash, a draft discarded", async () => {
    const { app, agent, gmail, pane, headers } = await fixture([{ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice", minutesAgo: 5, labelIds: ["INBOX"], plain: "Hi" }]);
    try {
      const remove = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${cli}/delete`, headers: agent, payload: { account: "me@gmail.com", ...payload } });
      // The pane is on Assist, where space_mail_trash asks for a review; delete does not.
      expect((await remove({ messageId: "m1" })).json()).toEqual({ ok: true, trashed: "m1" });
      expect(gmail.writes.map((write) => write.path)).toContain("/messages/m1/trash");
      expect((await remove({ draftId: "draft-op" })).json()).toEqual({ ok: true, discarded: "draft-op" });
      expect(gmail.deletedDrafts).toEqual(["draft-op"]);
      expect((await remove({ messageId: "m1", draftId: "draft-op" })).statusCode).toBe(422);
      expect((await remove({})).statusCode).toBe(422);
      const events = (await app.inject({ method: "GET", url: `/api/mail-copilot/events?paneId=${encodeURIComponent(pane.id)}&limit=10`, headers })).json().events as Array<{ type: string; message: string }>;
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "TRASHED", message: "The copilot deleted: Invoice from Anna <anna@acme.com>" }), expect.objectContaining({ type: "NOTE", message: "The copilot discarded a draft" })]));
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

  it("under Rules the agent organizes alone and replies only under an approved rule, the operator's own actions become learn items, and proposals wait for the operator", async () => {
    const { app, store, pane, headers, agent, gmail, paneUrl, repository } = await fixture([
      { id: "m1", threadId: "t1", from: "Acme Billing <billing@acme.com>", subject: "Invoice 42", minutesAgo: 5, labelIds: ["INBOX"], plain: "Please pay" },
      { id: "m2", threadId: "t2", from: "Anna <anna@other.org>", subject: "Lunch?", minutesAgo: 3, labelIds: ["INBOX"], plain: "Friday?" }
    ]);
    try {
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { autonomy: "RULES" } } });
      const archive = { account: "me@gmail.com", action: "archive" };
      // Organizing needs no rule (operator 2026-10-27); a reply does.
      expect((await app.inject({ method: "POST", url: `${cli}/threads/t1/modify`, headers: agent, payload: archive })).statusCode).toBe(200);
      expect(gmail.writes.at(-1)).toMatchObject({ path: "/threads/t1/modify", body: { removeLabelIds: ["INBOX"] } });
      const reply = { account: "me@gmail.com", to: ["billing@acme.com"], subject: "Re: Invoice 42", text: "Paid", threadId: "t1", inReplyToMessageId: "m1" };
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: reply })).json().error.message).toMatch(/ruleId/);
      // The agent proposes a rule; the operator gets a notification and decides in the rail.
      const proposed = await app.inject({ method: "POST", url: `${cli}/rules/propose`, headers: agent, payload: { name: "Archive Acme invoices", accountEmail: "me@gmail.com", condition: { domain: "acme.com", subjectPattern: "invoice" }, action: { type: "ARCHIVE" }, confidence: 0.8, evidence: ["You archived Invoice 41 on Monday", "You archived Invoice 40 last week"] } });
      expect(proposed.statusCode).toBe(200);
      const ruleId = proposed.json().rule.id as string;
      expect(proposed.json().rule).toMatchObject({ status: "PROPOSED", proposedBy: "AGENT", appliedCount: 0 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json()).toMatchObject({ total: 1, bySource: { MAIL_COPILOT: 1 } });
      // A proposed rule grants nothing.
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: { ...reply, ruleId } })).json().error.message).toMatch(/not an approved rule/);
      const approved = await app.inject({ method: "POST", url: `/api/mail-copilot/rules/${encodeURIComponent(ruleId)}/decide`, headers, payload: { decision: "approve" } });
      expect(approved.json().rule).toMatchObject({ status: "APPROVED" });
      expect(approved.json().rule.decidedAt).not.toBeNull();
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);
      expect((await app.inject({ method: "GET", url: `${cli}/rules?status=APPROVED`, headers: agent })).json().rules.map((rule: { id: string }) => rule.id)).toEqual([ruleId]);
      // A rule for another action never covers a send.
      expect((await app.inject({ method: "POST", url: `${cli}/send`, headers: agent, payload: { ...reply, ruleId } })).json().error.message).toMatch(/allows ARCHIVE, not send/);

      // A rule the copilot organizes under is logged with the action; a label's name resolves to the account's label id.
      const labelRule = (await app.inject({ method: "POST", url: "/api/mail-copilot/rules", headers, payload: { name: "Acme to Invoices", accountEmail: "me@gmail.com", condition: { fromAddress: "billing@acme.com" }, action: { type: "LABEL", labels: ["Label_1"] } } })).json().rule.id as string;
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
