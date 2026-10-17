import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryMailCopilotRepository } from "@space/db";
import type { ConnectorCapability } from "@space/contracts";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import type { MailCopilotGoogleAccess } from "../src/mail-copilot/service.js";
import { createMailCopilotSync } from "../src/mail-copilot/sync.js";
import { classifyThreadChange } from "../src/mail-copilot/history.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
interface FakeMessage { id: string; threadId: string; from: string; subject: string; labelIds: string[]; plain: string }

/** A Gmail whose history grows as the test "receives" mail; `expireHistory` makes history.list answer 404 once. */
function fakeGmail(token: string) {
  const messages = new Map<string, FakeMessage>();
  const history: Array<{ id: number; entry: Record<string, unknown> }> = [];
  let historyId = 100;
  let expired = false;
  const full = (message: FakeMessage) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds, internalDate: String(Date.now()), snippet: message.plain.slice(0, 80),
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: message.from }, { name: "To", value: "Me <me@gmail.com>" }, { name: "Subject", value: message.subject }, { name: "Message-ID", value: `<${message.id}@x>` }], body: { data: b64(message.plain) } } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return Response.json({ error: { message: "bad token" } }, { status: 401 });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return Response.json({ emailAddress: "me@gmail.com", historyId: String(historyId) });
    if (path === "/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Clients", type: "user" }, { id: "Label_9", name: "Job Applications/Confirmations", type: "user" }] });
    if (path === "/labels/INBOX") return Response.json({ id: "INBOX", threadsUnread: 0 });
    if (path === "/history") {
      if (expired) { expired = false; return Response.json({ error: { message: "startHistoryId is too old" } }, { status: 404 }); }
      const start = Number(url.searchParams.get("startHistoryId"));
      const page = Number(url.searchParams.get("pageToken") ?? 0);
      const rows = history.filter((entry) => entry.id > start);
      const slice = rows.slice(page, page + 1);
      return Response.json({ historyId: String(historyId), history: slice.map((entry) => ({ id: String(entry.id), ...entry.entry })),
        ...(rows.length > page + 1 ? { nextPageToken: String(page + 1) } : {}) });
    }
    if (path === "/threads") return Response.json({ threads: url.searchParams.get("q")?.includes("newer_than:30d") ? [...new Set([...messages.values()].map((message) => message.threadId))].map((id) => ({ id })) : [] });
    if (/^\/threads\/[^/]+\/(modify|trash)$/.test(path)) return Response.json({ id: path.split("/")[2] });
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread) return Response.json({ id: thread[1], messages: [...messages.values()].filter((message) => message.threadId === thread[1]).map(full) });
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message) { const row = messages.get(message[1]!); return row ? Response.json(full(row)) : Response.json({ error: { message: "nope" } }, { status: 404 }); }
    return Response.json({ error: { message: `unexpected ${path}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    receive(message: FakeMessage) {
      messages.set(message.id, message);
      historyId += 1;
      history.push({ id: historyId, entry: { messagesAdded: [{ message: { id: message.id, threadId: message.threadId, labelIds: message.labelIds } }] } });
    },
    /** Mail already in the mailbox before Space looked (no history record). */
    seed(message: FakeMessage) { messages.set(message.id, message); },
    /** Something done to mail in Gmail itself (web, phone): one history record of label changes or deletions. */
    change(entry: Record<string, unknown>) { historyId += 1; history.push({ id: historyId, entry }); },
    expireHistory() { expired = true; },
    calls: () => fetchImpl.mock.calls.map((call) => new URL(String(call[0] instanceof URL ? call[0].href : call[0])).pathname.replace("/gmail/v1/users/me", ""))
  };
}

const full: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"];
const google: MailCopilotGoogleAccess = {
  googleConfigured: true,
  async googleAccounts() { return [{ email: "me@gmail.com", capabilities: full }]; },
  async googleAccessToken(_owner, email) { if (email !== "me@gmail.com") throw new Error("not allowed"); return "token-me"; }
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-mail-copilot-sync-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-mail-copilot-tests", SPACE_ARTIFACT_ROOT: root
  });
  const store = new InMemorySpaceStore();
  const gmail = fakeGmail("token-me");
  const repository = new InMemoryMailCopilotRepository();
  const kickoffs: string[] = [];
  const app = await createApp({ store, config, mailCopilotGoogle: google, mailCopilotGmailFetch: gmail.fetchImpl, jobApplyMailTriage: false, mailCopilotSync: false, mailCopilotRepository: repository,
    mailCopilotKickoff: async (_pane, run) => { await new Promise((resolve) => setTimeout(resolve, 50)); kickoffs.push(run.id); }, auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Mail", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  const paneUrl = `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot`;
  // The operator's "check now" runs the same sync the poller runs for this pane.
  const sync = { tick: async () => (await app.inject({ method: "POST", url: `${paneUrl}/sync`, headers })).json() as { accounts: number; created: number } };
  return { app, store, pane, headers, agent, gmail, sync, paneUrl, repository, kickoffs, owner: (await store.getRoom(room.id)).ownerUserId! };
}

describe("mail copilot sync poller", () => {
  it("syncs each owner's account once per tick across open Mail Copilot panes, skips rooms without an owner and closed panes, and holds an account after repeated failures", async () => {
    const calls: string[] = [];
    const states: Record<string, { consecutiveFailures: number; updatedAt: string }> = { "u1|held@gmail.com": { consecutiveFailures: 3, updatedAt: new Date().toISOString() } };
    const service = {
      async accounts(_owner: string, pane: { id: string }) { return pane.id === "pane:b" ? [{ email: "me@gmail.com", access: "full", inPane: true }, { email: "held@gmail.com", access: "read", inPane: true }, { email: "off@gmail.com", access: "none", inPane: true }] : [{ email: "me@gmail.com", access: "full", inPane: true }]; },
      async syncState(owner: string, email: string) { const state = states[`${owner}|${email}`]; return state ? { ownerUserId: owner, accountEmail: email, historyId: "1", lastSyncedAt: null, lastError: null, ...state } : null; },
      async syncAccount(owner: string, pane: { id: string }, email: string) { calls.push(`${owner}:${pane.id}:${email}`); if (email === "fails@gmail.com") throw new Error("boom"); return { created: 1, reset: false }; }
    };
    const store = {
      listRooms: async () => [{ id: "room:1", ownerUserId: "u1" }, { id: "room:2", ownerUserId: null }, { id: "room:3", ownerUserId: "u2" }],
      listPanes: async (roomId: string) => roomId === "room:1" ? [{ id: "pane:a", mode: "MAIL_COPILOT", isClosed: false }, { id: "pane:b", mode: "MAIL_COPILOT", isClosed: false }, { id: "pane:c", mode: "MAIL_COPILOT", isClosed: true }, { id: "pane:d", mode: "TERMINAL", isClosed: false }]
        : roomId === "room:3" ? [{ id: "pane:e", mode: "MAIL_COPILOT", isClosed: false }] : [{ id: "pane:f", mode: "MAIL_COPILOT", isClosed: false }]
    };
    const sync = createMailCopilotSync({ service: service as never, store: store as never, log: { warn: () => undefined } });
    expect(await sync.tick()).toEqual({ accounts: 3, created: 2 });
    expect(calls).toEqual(["u1:pane:a:me@gmail.com", "u2:pane:e:me@gmail.com"]);
  });
});

describe("mail copilot learns from Gmail history", () => {
  it("queues mail sent to the AI ahead of the backlog, closes triage items of mail already handled, and starts the run once for back-to-back hand-offs", async () => {
    const { app, pane, headers, agent, gmail, sync, kickoffs, paneUrl } = await fixture();
    try {
      await sync.tick();
      gmail.receive({ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice", labelIds: ["INBOX"], plain: "Pay" });
      gmail.receive({ id: "m2", threadId: "t2", from: "PVE <root@pve.example>", subject: "backup failed", labelIds: ["INBOX"], plain: "lock" });
      gmail.receive({ id: "m3", threadId: "t3", from: "Bob <bob@acme.com>", subject: "Promo", labelIds: ["INBOX"], plain: "Sale" });
      gmail.receive({ id: "m4", threadId: "t4", from: "PVE <root@pve.example>", subject: "New packages", labelIds: ["INBOX"], plain: "apt" });
      await sync.tick();
      // The operator trashes Bob's mail: its waiting triage item closes.
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t3/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "trash" } });
      // Two hand-offs at once: two queued items, one run, one kickoff.
      const fix = (threadId: string, note: string) => app.inject({ method: "POST", url: `${paneUrl}/fix`, headers, payload: { account: "me@gmail.com", threadId, note } });
      const [first, second] = await Promise.all([fix("t2", "Fix the backup"), fix("t4", "Run the upgrade")]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(kickoffs).toHaveLength(1);
      const events = (await app.inject({ method: "GET", url: "/api/mail-copilot/events?limit=50", headers })).json().events as Array<{ type: string; threadId: string | null; status: string | null }>;
      expect(events.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
      expect(Object.fromEntries(events.filter((event) => event.type === "MAIL_RECEIVED").map((event) => [event.threadId, event.status]))).toEqual({ t1: "PENDING", t2: "DONE", t3: "DONE", t4: "DONE" });
      // The hand-offs come first, then the rest of the inbox.
      const order: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const next = (await app.inject({ method: "POST", url: "/api/cli/mail-copilot/next", headers: agent, payload: { waitMs: 0 } })).json();
        order.push(`${next.item.type}:${next.item.threadId}`);
        await app.inject({ method: "POST", url: "/api/cli/mail-copilot/report", headers: agent, payload: { eventId: next.item.id, outcome: next.item.type === "FIX_REQUESTED" ? "fixed" : "skipped", summary: "Done." } });
      }
      expect(order.slice(0, 2).sort()).toEqual(["FIX_REQUESTED:t2", "FIX_REQUESTED:t4"]);
      expect(order[2]).toBe("MAIL_RECEIVED:t1");
    } finally {
      await app.close();
    }
  });

  it("sends new mail matching an approved FIX rule to the copilot on its own, with a notification and the run started", async () => {
    const { app, headers, gmail, sync, repository, owner, paneUrl } = await fixture();
    try {
      await sync.tick();
      const rule = (await app.inject({ method: "POST", url: "/api/mail-copilot/rules", headers, payload: { name: "Backups to the copilot", accountEmail: "me@gmail.com", condition: { fromAddress: "root@pve.example", subjectPattern: "backup failed" }, action: { type: "FIX" } } })).json().rule;
      gmail.receive({ id: "f1", threadId: "ft1", from: "PVE <root@pve.example>", subject: "vzdump backup status (pve): backup failed", labelIds: ["INBOX"], plain: "lock" });
      gmail.receive({ id: "f2", threadId: "ft2", from: "PVE <root@pve.example>", subject: "vzdump backup status (pve): backup successful", labelIds: ["INBOX"], plain: "ok" });
      expect(await sync.tick()).toMatchObject({ created: 2 });
      const events = (await app.inject({ method: "GET", url: "/api/mail-copilot/events?limit=20", headers })).json().events as Array<{ type: string; threadId: string | null; status: string | null; payload: Record<string, unknown> }>;
      expect(events.find((event) => event.type === "FIX_REQUESTED")).toMatchObject({ threadId: "ft1", status: "PENDING", payload: { by: "rule", ruleId: rule.id } });
      expect(events.find((event) => event.type === "MAIL_RECEIVED" && event.threadId === "ft1")?.status).toBeNull();
      expect(events.find((event) => event.type === "MAIL_RECEIVED" && event.threadId === "ft2")?.status).toBe("PENDING");
      const titles = ((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications as Array<{ title: string; body: string }>);
      expect(titles.find((entry) => entry.title.startsWith("Mail Copilot took a mail to fix"))?.body).toBe('Sent to the copilot to check and fix (rule "Backups to the copilot"): vzdump backup status (pve): backup failed');
      expect((await repository.listActions(owner, { actions: ["FIX"], limit: 5 }))[0]).toMatchObject({ threadId: "ft1", actor: "AGENT", source: "SPACE", ruleId: rule.id });
      expect((await repository.getRule(owner, rule.id))?.appliedCount).toBe(1);
      expect((await app.inject({ method: "GET", url: `${paneUrl}/run`, headers })).json().status).toBe("RUNNING");
    } finally {
      await app.close();
    }
  });

  it("first looks at the last 30 days of the mailbox once and records where mail ended up as inferred habits", async () => {
    const { gmail, sync, repository, owner, app } = await fixture();
    try {
      const seed = (id: string, from: string, labelIds: string[]) => gmail.seed({ id, threadId: `t${id}`, from, subject: `Subject ${id}`, labelIds, plain: "x" });
      seed("1", "Shop <deals@shop.example>", ["TRASH"]);
      seed("2", "Anna <anna@acme.com>", ["Label_1"]);
      seed("3", "Bob <bob@acme.com>", ["INBOX", "Label_1"]);
      seed("4", "News <news@paper.example>", ["STARRED"]);
      seed("5", "Me <me@gmail.com>", ["SENT"]);
      seed("6", "Anna <anna@acme.com>", ["INBOX"]);
      seed("7", "Jobs <jobs@board.example>", ["Label_9"]);
      await sync.tick();
      const rows = await repository.listActions(owner, { limit: 20 });
      expect(rows.map((row) => [row.threadId, row.action, row.labelIds.join(","), row.source]).sort()).toEqual([
        ["t1", "TRASH", "", "BACKFILL"], ["t2", "MOVE", "Label_1", "BACKFILL"], ["t3", "LABEL", "Label_1", "BACKFILL"], ["t4", "ARCHIVE", "", "BACKFILL"], ["t4", "STAR", "", "BACKFILL"]
      ]);
      expect(rows.find((row) => row.threadId === "t2")).toMatchObject({ fromAddress: "anna@acme.com", subject: "Subject 2", actor: "OPERATOR" });
      expect((await repository.getSyncState(owner, "me@gmail.com"))?.backfillDoneAt).not.toBeNull();
      // Once is enough: the next tick reads history only.
      await sync.tick();
      expect(await repository.listActions(owner, { limit: 20 })).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it("classifies a thread's net label change the way the pane names its actions", () => {
    const change = (added: string[], removed: string[], extra: Partial<Parameters<typeof classifyThreadChange>[0]> = {}) => classifyThreadChange({ threadId: "t", messageIds: ["m"], added, removed, deleted: false, sent: [], ...extra }, new Set(["Label_9"]));
    expect(change(["SPAM"], ["INBOX"])).toEqual([{ action: "SPAM", labelIds: [] }]);
    expect(change(["INBOX"], ["SPAM"])).toEqual([{ action: "NOT_SPAM", labelIds: [] }]);
    expect(change([], ["TRASH"])).toEqual([{ action: "UNTRASH", labelIds: [] }]);
    expect(change(["INBOX"], [])).toEqual([{ action: "UNARCHIVE", labelIds: [] }]);
    expect(change(["Label_3"], ["Label_4"])).toEqual([{ action: "LABEL", labelIds: ["Label_3"] }, { action: "UNLABEL", labelIds: ["Label_4"] }]);
    expect(change(["UNREAD", "IMPORTANT", "CATEGORY_UPDATES"], [])).toEqual([]);
    expect(change(["Label_9", "Label_3"], ["INBOX"])).toEqual([]);
    expect(change(["TRASH"], [], { deleted: true })).toEqual([{ action: "DELETE", labelIds: [] }]);
    expect(change([], [], { sent: ["m2"] })).toEqual([{ action: "REPLY", labelIds: [] }]);
  });

  it("logs what the operator does in Gmail web or on the phone, per thread and net, without Space's own writes, in budgeted steps", async () => {
    const { app, pane, headers, gmail, sync, repository, owner } = await fixture();
    const message = (id: string, threadId: string, labelIds: string[]) => ({ message: { id, threadId, labelIds } });
    try {
      await sync.tick();
      gmail.receive({ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice 42", labelIds: ["INBOX"], plain: "Pay" });
      gmail.receive({ id: "m2", threadId: "t2", from: "Shop <deals@shop.example>", subject: "Weekly deals", labelIds: ["INBOX"], plain: "Deals" });
      gmail.receive({ id: "m3", threadId: "t3", from: "Bob <bob@acme.com>", subject: "Hello", labelIds: ["INBOX"], plain: "Hi" });
      gmail.receive({ id: "m5", threadId: "t5", from: "News <news@paper.example>", subject: "Today", labelIds: ["INBOX"], plain: "News" });
      await sync.tick();
      expect(await repository.listActions(owner, { limit: 10 })).toEqual([]);

      // In Gmail: Anna's invoice moved to Clients (one record), the deals trashed, Bob archived and put back (an undo), Job Copilot filed one,
      gmail.change({ labelsRemoved: [{ ...message("m1", "t1", ["Label_1"]), labelIds: ["INBOX"] }], labelsAdded: [{ ...message("m1", "t1", ["Label_1"]), labelIds: ["Label_1"] }] });
      gmail.change({ labelsAdded: [{ ...message("m2", "t2", ["TRASH"]), labelIds: ["TRASH"] }], labelsRemoved: [{ ...message("m2", "t2", ["TRASH"]), labelIds: ["INBOX"] }] });
      gmail.change({ labelsRemoved: [{ ...message("m3", "t3", []), labelIds: ["INBOX"] }] });
      gmail.change({ labelsAdded: [{ ...message("m3", "t3", ["INBOX"]), labelIds: ["INBOX"] }] });
      gmail.change({ labelsAdded: [{ ...message("m9", "t9", ["Label_9"]), labelIds: ["Label_9"] }], labelsRemoved: [{ ...message("m9", "t9", ["Label_9"]), labelIds: ["INBOX"] }] });
      // a reply to Anna sent from the phone, and the newspaper starred and read (read marks say nothing).
      gmail.receive({ id: "m6", threadId: "t1", from: "Me <me@gmail.com>", subject: "Re: Invoice 42", labelIds: ["SENT"], plain: "Paid" });
      gmail.change({ labelsAdded: [{ ...message("m5", "t5", ["STARRED"]), labelIds: ["STARRED"] }], labelsRemoved: [{ ...message("m5", "t5", ["STARRED"]), labelIds: ["UNREAD"] }] });
      // The pane archived the newspaper itself: history shows it, the log already has it.
      await app.inject({ method: "POST", url: "/api/mail-copilot/threads/t5/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", action: "archive" } });
      gmail.change({ labelsRemoved: [{ ...message("m5", "t5", ["STARRED"]), labelIds: ["INBOX"] }] });

      // Eight records: one tick reads four pages (one record each in this fake), the next one the rest.
      await sync.tick();
      await sync.tick();
      const rows = await repository.listActions(owner, { limit: 20 });
      expect(rows.map((row) => [row.threadId, row.action, row.source]).sort()).toEqual([
        ["t1", "MOVE", "GMAIL"], ["t1", "REPLY", "GMAIL"], ["t2", "TRASH", "GMAIL"], ["t5", "ARCHIVE", "PANE"], ["t5", "STAR", "GMAIL"]
      ]);
      expect(rows.find((row) => row.action === "MOVE")).toMatchObject({ labelIds: ["Label_1"], fromAddress: "anna@acme.com", fromDomain: "acme.com", subject: "Invoice 42", subjectKey: "invoice 0", actor: "OPERATOR", accountEmail: "me@gmail.com" });
      expect(rows.find((row) => row.action === "REPLY")).toMatchObject({ messageId: "m6", fromAddress: "anna@acme.com" });

      // Trash emptied: the deleted message has no metadata left, the log still knows the sender.
      gmail.change({ messagesDeleted: [message("m2", "t2", [])] });
      await sync.tick();
      expect((await repository.listActions(owner, { actions: ["DELETE"], limit: 5 }))[0]).toMatchObject({ threadId: "t2", fromAddress: "deals@shop.example", subject: "Weekly deals" });
      // A draft replaced while the operator types, and a message Space never saw, are no deleted mail.
      gmail.change({ messagesDeleted: [message("dr1", "t1", ["DRAFT"]), message("old1", "t77", [])] });
      await sync.tick();
      expect((await repository.listActions(owner, { actions: ["DELETE"], limit: 5 })).map((row) => row.threadId)).toEqual(["t2"]);
      expect(gmail.calls().filter((path) => path === "/history").length).toBeGreaterThan(4);
    } finally {
      await app.close();
    }
  });
});

describe("mail copilot new-mail sync", () => {
  it("records where to start, then turns new inbox mail into notifications and work items, pages history, skips automated senders as items, and resets on an expired history", async () => {
    const { app, pane, headers, agent, gmail, sync, paneUrl } = await fixture();
    try {
      // First tick: only the starting history id is stored; nothing is reported.
      expect(await sync.tick()).toEqual({ accounts: 1, created: 0 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);

      gmail.receive({ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice question", labelIds: ["INBOX", "UNREAD"], plain: "Can you resend?" });
      gmail.receive({ id: "m2", threadId: "t2", from: "Shop <no-reply@shop.example>", subject: "Your order", labelIds: ["INBOX"], plain: "Shipped" });
      gmail.receive({ id: "m3", threadId: "t3", from: "Bob <bob@acme.com>", subject: "Sent folder", labelIds: ["SENT"], plain: "not inbox" });
      expect(await sync.tick()).toEqual({ accounts: 1, created: 2 });
      // Two history pages were read (one entry per page in the fake).
      expect(gmail.calls().filter((path) => path === "/history").length).toBeGreaterThanOrEqual(2);
      const notifications = await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers });
      // Order-free: both arrive within the same tick and may share a timestamp.
      expect(notifications.json().notifications.map((row: { title: string; body: string; severity: string; link: { target: string } }) => [row.title, row.body, row.severity, row.link.target]).sort().reverse()).toEqual([
        ["Shop · me@gmail.com", "Your order — Shipped", "INFO", "thread:me@gmail.com:t2"],
        ["Anna · me@gmail.com", "Invoice question — Can you resend?", "INFO", "thread:me@gmail.com:t1"]
      ]);
      // A second tick finds nothing new; the same message never becomes a second item.
      expect(await sync.tick()).toEqual({ accounts: 1, created: 0 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(2);

      // The run serves the human mail as a work item with its text; the automated one never becomes an item.
      await app.inject({ method: "POST", url: `${paneUrl}/run/start`, headers });
      const next = await app.inject({ method: "POST", url: "/api/cli/mail-copilot/next", headers: agent, payload: { waitMs: 0 } });
      expect(next.json()).toMatchObject({ done: false, item: { type: "MAIL_RECEIVED", threadId: "t1", messageId: "m1" } });
      expect(next.json().context.thread.messages[0].text).toBe("Can you resend?");
      await app.inject({ method: "POST", url: "/api/cli/mail-copilot/report", headers: agent, payload: { eventId: next.json().item.id, outcome: "skipped", summary: "Nothing to do." } });
      expect((await app.inject({ method: "POST", url: "/api/cli/mail-copilot/next", headers: agent, payload: { waitMs: 0 } })).json()).toMatchObject({ done: true, reason: "QUEUE_EMPTY" });

      // An expired history restarts from now with a note; mail that arrived meanwhile is not re-read (the backlog scan covers it).
      gmail.expireHistory();
      expect(await sync.tick()).toEqual({ accounts: 1, created: 0 });
      const events = await app.inject({ method: "GET", url: `/api/mail-copilot/events?paneId=${encodeURIComponent(pane.id)}&limit=3`, headers });
      expect(events.json().events[0]).toMatchObject({ type: "SYNC_RESET", accountEmail: "me@gmail.com" });
      gmail.receive({ id: "m4", threadId: "t4", from: "Anna <anna@acme.com>", subject: "Again", labelIds: ["INBOX"], plain: "Hi" });
      expect(await sync.tick()).toEqual({ accounts: 1, created: 1 });

      // The pane's new-mail toggle off: items still exist for the run, notifications stop.
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { notifications: { newMail: false, needsYou: true, telegram: false } } } });
      gmail.receive({ id: "m5", threadId: "t5", from: "Anna <anna@acme.com>", subject: "Quiet", labelIds: ["INBOX"], plain: "Hi" });
      expect(await sync.tick()).toEqual({ accounts: 1, created: 1 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(3);

      // The toggle back on with this account muted: its new mail stays quiet too.
      await app.inject({ method: "PUT", url: `${paneUrl}/settings`, headers, payload: { version: 1, settings: { notifications: { newMail: true, needsYou: true, telegram: false, mutedAccounts: ["Me@gmail.com"] } } } });
      gmail.receive({ id: "m6", threadId: "t6", from: "Anna <anna@acme.com>", subject: "Muted", labelIds: ["INBOX"], plain: "Hi" });
      expect(await sync.tick()).toEqual({ accounts: 1, created: 1 });
      expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(3);
    } finally {
      await app.close();
    }
  });
});
