import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorCapability } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { buildMime, parseParticipants, parsePayload } from "../src/mail-copilot/gmail-mime.js";
import { sanitizeMailHtml } from "../src/mail-copilot/html-sanitizer.js";
import { createMailCopilotService, type MailCopilotGoogleAccess } from "../src/mail-copilot/service.js";
import { InMemoryMailCopilotRepository } from "@space/db";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

interface FakeMessage { id: string; threadId: string; from: string; to?: string; subject: string; minutesAgo: number; labelIds: string[]; plain?: string; html?: string; attachment?: { id: string; filename: string; mimeType: string; data: string; cid?: string } }

/** One Gmail account's API: threads, labels, modify, trash, send, drafts, attachments; records every write. */
function fakeGmail(token: string, inbox: FakeMessage[], userLabels: Array<{ id: string; name: string }> = []) {
  const messages = new Map(inbox.map((message) => [message.id, { ...message, labelIds: [...message.labelIds] }]));
  const writes: Array<{ path: string; body: unknown }> = [];
  const headers = (message: FakeMessage) => [
    { name: "From", value: message.from }, { name: "To", value: message.to ?? "Me <me@gmail.com>" }, { name: "Subject", value: message.subject },
    { name: "Message-ID", value: `<${message.id}@mail.example>` }, { name: "Date", value: new Date(Date.now() - message.minutesAgo * 60_000).toUTCString() }
  ];
  const payload = (message: FakeMessage, format: string) => {
    if (format === "metadata") return { headers: headers(message), ...(message.attachment ? { parts: [{ filename: message.attachment.filename }] } : {}) };
    const parts: Record<string, unknown>[] = [];
    if (message.plain !== undefined) parts.push({ mimeType: "text/plain", body: { data: b64(message.plain) } });
    if (message.html !== undefined) parts.push({ mimeType: "text/html", body: { data: b64(message.html) } });
    if (message.attachment) parts.push({ mimeType: message.attachment.mimeType, filename: message.attachment.filename, headers: message.attachment.cid ? [{ name: "Content-ID", value: `<${message.attachment.cid}>` }] : [],
      body: { attachmentId: message.attachment.id, size: message.attachment.data.length } });
    return { mimeType: "multipart/mixed", headers: headers(message), parts };
  };
  const full = (message: FakeMessage, format: string) => ({ id: message.id, threadId: message.threadId, labelIds: message.labelIds, internalDate: String(Date.now() - message.minutesAgo * 60_000),
    // Gmail HTML-escapes the snippet field.
    snippet: (message.plain ?? "").slice(0, 80).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;"), payload: payload(message, format) });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return Response.json({ error: { message: "bad token" } }, { status: 401 });
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (init?.method === "POST") writes.push({ path, body });
    if (path === "/profile") return Response.json({ emailAddress: "me@gmail.com", historyId: "100" });
    if (path === "/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "STARRED", name: "STARRED", type: "system" }, { id: "Label_7", name: "Clients", type: "user" }, ...userLabels.map((label) => ({ ...label, type: "user" }))] });
    if (path === "/labels/INBOX") return Response.json({ id: "INBOX", threadsUnread: [...messages.values()].filter((message) => message.labelIds.includes("INBOX") && message.labelIds.includes("UNREAD")).length });
    if (path === "/labels/Label_7") return Response.json({ id: "Label_7", threadsUnread: 0 });
    if (path === "/threads") {
      const label = url.searchParams.get("labelIds");
      const q = url.searchParams.get("q");
      const ids = [...new Set([...messages.values()].filter((message) => (!label || message.labelIds.includes(label)) && (!q || `${message.subject} ${message.plain ?? ""}`.toLowerCase().includes(q.toLowerCase())))
        .sort((left, right) => left.minutesAgo - right.minutesAgo).map((message) => message.threadId))];
      const max = Number(url.searchParams.get("maxResults") ?? 25);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      return Response.json({ threads: ids.slice(start, start + max).map((id) => ({ id })), ...(ids.length > start + max ? { nextPageToken: String(start + max) } : {}) });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (thread) {
      const rows = [...messages.values()].filter((message) => message.threadId === thread[1]).sort((left, right) => right.minutesAgo - left.minutesAgo);
      if (!rows.length) return Response.json({ error: { message: "not found" } }, { status: 404 });
      return Response.json({ id: thread[1], messages: rows.map((message) => full(message, url.searchParams.get("format") ?? "full")) });
    }
    const modifyThread = /^\/threads\/([^/]+)\/(modify|trash|untrash)$/.exec(path);
    if (modifyThread) {
      for (const message of messages.values()) {
        if (message.threadId !== modifyThread[1]) continue;
        if (modifyThread[2] === "modify") {
          const change = body as { addLabelIds?: string[]; removeLabelIds?: string[] };
          message.labelIds = [...new Set([...message.labelIds.filter((label) => !(change.removeLabelIds ?? []).includes(label)), ...(change.addLabelIds ?? [])])];
        } else message.labelIds = modifyThread[2] === "trash" ? [...message.labelIds.filter((label) => label !== "INBOX"), "TRASH"] : [...message.labelIds.filter((label) => label !== "TRASH"), "INBOX"];
      }
      return Response.json({ id: modifyThread[1] });
    }
    if (path === "/messages/send") return Response.json({ id: "sent-1", threadId: (body as { threadId?: string }).threadId ?? "thread-new" });
    if (path === "/settings/sendAs") return Response.json({ sendAs: [{ sendAsEmail: "me@gmail.com", displayName: "", isPrimary: true, isDefault: true },
      { sendAsEmail: "Lab@team.com", displayName: "Lab Team", verificationStatus: "accepted" }, { sendAsEmail: "pending@team.com", verificationStatus: "pending" }] });
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message) {
      const row = messages.get(message[1]!);
      if (!row) return Response.json({ error: { message: "nope" } }, { status: 404 });
      const body = full(row, url.searchParams.get("format") ?? "full");
      // Like Gmail, metadata answers only the headers named.
      const named = url.searchParams.getAll("metadataHeaders").map((name) => name.toLowerCase());
      if (named.length) body.payload.headers = body.payload.headers.filter((entry) => named.includes(entry.name.toLowerCase()));
      return Response.json(body);
    }
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment) { const row = messages.get(attachment[1]!); return row?.attachment?.id === attachment[2] ? Response.json({ data: b64(row.attachment.data) }) : Response.json({}, { status: 404 }); }
    if (path === "/drafts") return Response.json({ id: "draft-1", message: { id: "draft-msg-1" } });
    return Response.json({ error: { message: `unexpected ${path}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, writes, messages };
}

async function fixture(google: MailCopilotGoogleAccess, gmailFetch: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "space-mail-copilot-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_ARTIFACT_ROOT: root });
  const store = new InMemorySpaceStore();
  const app = await createApp({ store, config, mailCopilotGoogle: google, mailCopilotGmailFetch: gmailFetch, jobApplyMailTriage: false,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Mail", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:codex" });
  return { app, store, pane, headers };
}

const full: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"];
const readOnly: ConnectorCapability[] = ["MAIL_READ"];
function googleAccess(accounts: Array<{ email: string; capabilities: ConnectorCapability[]; token: string }>): MailCopilotGoogleAccess {
  return {
    googleConfigured: true,
    async googleAccounts() { return accounts.map(({ email, capabilities }) => ({ email, capabilities })); },
    async googleAccessToken(_owner, email, capability) {
      const account = accounts.find((entry) => entry.email === email);
      if (!account || !account.capabilities.includes(capability)) throw new Error("not allowed");
      return account.token;
    }
  };
}

describe("mail copilot mailbox", () => {
  const htmlMail = `<html><head><style>p{color:red}</style><script>evil()</script></head><body><p>Hi <b>there</b></p><img src="https://tracker.example/pixel.gif" width="1" height="1">
<img src="https://cdn.example/photo.jpg" alt="Photo"><img src="cid:logo123"><a href="https://example.com/x">Link</a><form action="https://evil"><input></form></body></html>`;

  it("lists accounts with access and unread counts, labels in rail order, and a unified inbox across accounts", async () => {
    const me = fakeGmail("token-me", [
      { id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice", minutesAgo: 30, labelIds: ["INBOX", "UNREAD"], plain: "Please find the invoice." },
      { id: "m2", threadId: "t2", from: "Bob <bob@shop.example>", subject: "Sale", minutesAgo: 120, labelIds: ["INBOX", "STARRED"], plain: "50% off & don't miss <today>", attachment: { id: "a1", filename: "flyer.pdf", mimeType: "application/pdf", data: "%PDF-1.4" } }
    ]);
    const work = fakeGmail("token-work", [{ id: "w1", threadId: "wt1", from: "Boss <boss@corp.example>", subject: "Standup", minutesAgo: 10, labelIds: ["INBOX", "UNREAD"], plain: "9am" }]);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => ((init?.headers as Record<string, string>)?.authorization === "Bearer token-work" ? work.fetchImpl : me.fetchImpl)(input, init)) as unknown as typeof fetch;
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }, { email: "work@gmail.com", capabilities: readOnly, token: "token-work" }]), fetchImpl);

    const accounts = await app.inject({ method: "GET", url: `/api/mail-copilot/accounts?paneId=${encodeURIComponent(pane.id)}`, headers });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().accounts).toEqual([
      { email: "me@gmail.com", access: "full", inPane: true, unread: 1, error: null },
      { email: "work@gmail.com", access: "read", inPane: true, unread: 1, error: null }
    ]);

    const labels = await app.inject({ method: "GET", url: `/api/mail-copilot/labels?paneId=${encodeURIComponent(pane.id)}&account=all`, headers });
    expect(labels.json().labels.slice(0, 2)).toEqual([{ id: "INBOX", name: "Inbox", type: "system", unread: 2 }, { id: "STARRED", name: "Starred", type: "system", unread: null }]);
    expect(labels.json().labels.find((label: { name: string }) => label.name === "Clients")).toMatchObject({ type: "user", unread: 0 });

    const inbox = await app.inject({ method: "GET", url: `/api/mail-copilot/threads?paneId=${encodeURIComponent(pane.id)}&account=all&labelId=INBOX`, headers });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().threads.map((thread: { account: string; threadId: string; unread: boolean; starred: boolean; hasAttachment: boolean; from: { name: string } }) =>
      [thread.account, thread.threadId, thread.unread, thread.starred, thread.hasAttachment, thread.from.name])).toEqual([
      ["work@gmail.com", "wt1", true, false, false, "Boss"], ["me@gmail.com", "t1", true, false, false, "Anna"], ["me@gmail.com", "t2", false, true, true, "Bob"]
    ]);
    expect(inbox.json().errors).toEqual([]);
    expect(inbox.json().threads.find((thread: { threadId: string }) => thread.threadId === "t2").snippet).toBe("50% off & don't miss <today>");
    // A search scopes to the label and is case-insensitive.
    const search = await app.inject({ method: "GET", url: `/api/mail-copilot/threads?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com&labelId=INBOX&q=invoice`, headers });
    expect(search.json().threads.map((thread: { threadId: string }) => thread.threadId)).toEqual(["t1"]);
    // The pane's chosen accounts narrow the mailbox; an account outside the pane is refused.
    await app.inject({ method: "PUT", url: `/api/panes/${encodeURIComponent(pane.id)}/mail-copilot/settings`, headers, payload: { version: 1, settings: { accounts: ["work@gmail.com"] } } });
    const narrowed = await app.inject({ method: "GET", url: `/api/mail-copilot/threads?paneId=${encodeURIComponent(pane.id)}&account=all&labelId=INBOX`, headers });
    expect(narrowed.json().threads.map((thread: { account: string }) => thread.account)).toEqual(["work@gmail.com"]);
    expect((await app.inject({ method: "GET", url: `/api/mail-copilot/threads?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com&labelId=INBOX`, headers })).statusCode).toBe(409);
    await app.close();
  });

  it("reads a thread with sanitized HTML, blocked remote images, inline cid images and attachments to download", async () => {
    const me = fakeGmail("token-me", [{ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", to: "Me <me@gmail.com>, Carl <carl@acme.com>", subject: "Photos", minutesAgo: 30, labelIds: ["INBOX"],
      html: htmlMail, attachment: { id: "att-logo", filename: "logo.png", mimeType: "image/png", data: "PNGDATA", cid: "logo123" } }]);
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), me.fetchImpl);
    const response = await app.inject({ method: "GET", url: `/api/mail-copilot/threads/t1?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com`, headers });
    expect(response.statusCode).toBe(200);
    const message = response.json().thread.messages[0];
    expect(message.from).toEqual({ name: "Anna", address: "anna@acme.com" });
    expect(message.to).toEqual([{ name: "Me", address: "me@gmail.com" }, { name: "Carl", address: "carl@acme.com" }]);
    expect(message.rfcMessageId).toBe("<m1@mail.example>");
    expect(message.text).toContain("Hi there");
    expect(message.html).not.toMatch(/<script|<form|<input|<style|color:red/);
    expect(message.html).not.toContain("pixel.gif");
    expect(message.html).toContain('data-blocked-src="https://cdn.example/photo.jpg"');
    expect(message.html).toContain(`src="/api/mail-copilot/messages/m1/attachments/att-logo?account=me%40gmail.com&amp;inline=1"`);
    expect(message.html).toContain('rel="noopener noreferrer nofollow"');
    expect(message.blockedImages).toBe(true);
    expect(message.attachments).toEqual([{ attachmentId: "att-logo", filename: "logo.png", mimeType: "image/png", size: 7, contentId: "logo123" }]);
    // Asking for images keeps the remote one.
    const withImages = await app.inject({ method: "GET", url: `/api/mail-copilot/threads/t1?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com&images=1`, headers });
    expect(withImages.json().thread.messages[0].html).toContain('src="https://cdn.example/photo.jpg"');
    expect(withImages.json().thread.messages[0].blockedImages).toBe(false);
    const download = await app.inject({ method: "GET", url: `/api/mail-copilot/messages/m1/attachments/att-logo?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.headers["content-disposition"]).toBe('attachment; filename="logo.png"');
    expect(download.body).toBe("PNGDATA");
    const inline = await app.inject({ method: "GET", url: `/api/mail-copilot/messages/m1/attachments/att-logo?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com&inline=1`, headers });
    expect(inline.headers["content-type"]).toBe("image/png");
    expect((await app.inject({ method: "GET", url: `/api/mail-copilot/threads/missing?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com`, headers })).statusCode).toBe(409);
    await app.close();
  });

  it("archives, stars, marks and trashes threads with full access, and refuses on a read-only account", async () => {
    const me = fakeGmail("token-me", [{ id: "m1", threadId: "t1", from: "a@x.com", subject: "A", minutesAgo: 1, labelIds: ["INBOX", "UNREAD"], plain: "a" }]);
    const work = fakeGmail("token-work", [{ id: "w1", threadId: "wt1", from: "b@x.com", subject: "B", minutesAgo: 1, labelIds: ["INBOX"], plain: "b" }]);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => ((init?.headers as Record<string, string>)?.authorization === "Bearer token-work" ? work.fetchImpl : me.fetchImpl)(input, init)) as unknown as typeof fetch;
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }, { email: "work@gmail.com", capabilities: readOnly, token: "token-work" }]), fetchImpl);
    const modify = (threadId: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/mail-copilot/threads/${threadId}/modify`, headers, payload: { paneId: pane.id, ...payload } });
    expect((await modify("t1", { account: "me@gmail.com", action: "read" })).statusCode).toBe(200);
    expect((await modify("t1", { account: "me@gmail.com", action: "star" })).statusCode).toBe(200);
    expect(me.messages.get("m1")!.labelIds).toEqual(["INBOX", "STARRED"]);
    expect((await modify("t1", { account: "me@gmail.com", action: "label", labelIds: ["Label_7"] })).statusCode).toBe(200);
    expect((await modify("t1", { account: "me@gmail.com", action: "archive" })).statusCode).toBe(200);
    expect(me.messages.get("m1")!.labelIds).toEqual(["STARRED", "Label_7"]);
    expect((await modify("t1", { account: "me@gmail.com", action: "trash" })).statusCode).toBe(200);
    expect(me.messages.get("m1")!.labelIds).toContain("TRASH");
    expect((await modify("t1", { account: "me@gmail.com", action: "untrash" })).statusCode).toBe(200);
    expect(me.messages.get("m1")!.labelIds).not.toContain("TRASH");
    expect((await modify("t1", { account: "me@gmail.com", action: "label" })).statusCode).toBe(409);
    // Read-only accounts cannot change anything, and the Gmail API never sees a write for them.
    expect((await modify("wt1", { account: "work@gmail.com", action: "archive" })).statusCode).toBe(409);
    expect(work.writes).toEqual([]);
    await app.close();
  });

  it("keeps one Job Applications label on a thread: a label or move to one takes the others off (operator 3/11, Kraken under Other and Rejections)", async () => {
    const me = fakeGmail("token-me", [{ id: "m1", threadId: "t1", from: "Kraken <no-reply@kraken.com>", subject: "An update on your application", minutesAgo: 1, labelIds: ["INBOX", "Label_9"], plain: "We've decided not to move ahead." }],
      [{ id: "Label_8", name: "Job Applications/Rejections" }, { id: "Label_9", name: "Job Applications/Other" }, { id: "Label_10", name: "Job Applications/Confirmations" }]);
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), me.fetchImpl);
    const modify = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/mail-copilot/threads/t1/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", ...payload } });
    expect((await modify({ action: "move", labelIds: ["Label_8"] })).statusCode).toBe(200);
    expect(me.writes.at(-1)).toEqual({ path: "/threads/t1/modify", body: { addLabelIds: ["Label_8"], removeLabelIds: ["INBOX", "Label_9", "Label_10"] } });
    expect(me.messages.get("m1")!.labelIds).toEqual(["Label_8"]);
    // Another label beside it stays; a second Job Applications label replaces the first.
    expect((await modify({ action: "label", labelIds: ["Label_7", "Label_10"] })).statusCode).toBe(200);
    expect(me.messages.get("m1")!.labelIds).toEqual(["Label_7", "Label_10"]);
    await app.close();
  });

  it("answers a thread's labels after a move or a removal and records when each label went on and came off (operator 3/11)", async () => {
    const me = fakeGmail("token-me", [{ id: "m1", threadId: "t1", from: "Kraken <no-reply@kraken.com>", subject: "Your application", minutesAgo: 1, labelIds: ["INBOX", "Label_9"], plain: "Thanks." }],
      [{ id: "Label_1", name: "Clients" }, { id: "Label_8", name: "Job Applications/Rejections" }, { id: "Label_9", name: "Job Applications/Other" }, { id: "Label_10", name: "Job Applications/Confirmations" }]);
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), me.fetchImpl);
    const modify = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/mail-copilot/threads/t1/modify", headers, payload: { paneId: pane.id, account: "me@gmail.com", ...payload } });
    const moved = await modify({ action: "move", labelIds: ["Label_8"] });
    expect(moved.json()).toEqual({ ok: true, labels: [{ id: "Label_8", name: "Job Applications/Rejections" }] });
    expect((await modify({ action: "label", labelIds: ["Label_1"] })).json().labels.map((label: { name: string }) => label.name)).toEqual(["Clients", "Job Applications/Rejections"]);
    // Taken off right after it went on: still recorded, never taken back out of the log as an undo.
    expect((await modify({ action: "unlabel", labelIds: ["Label_1"] })).json()).toEqual({ ok: true, labels: [{ id: "Label_8", name: "Job Applications/Rejections" }] });
    const answer = (await app.inject({ method: "GET", url: `/api/mail-copilot/threads/t1/labels?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com`, headers })).json() as { labels: unknown[]; history: Array<{ action: string; labelNames: string[]; actor: string; source: string }> };
    expect(answer.labels).toEqual([{ id: "Label_8", name: "Job Applications/Rejections" }]);
    // The one-label rule took Other off with the move (the thread had it), not Confirmations (it never had it).
    expect(answer.history.map((row) => [row.action, row.labelNames.join(","), row.actor, row.source]).sort()).toEqual([
      ["LABEL", "Clients", "OPERATOR", "PANE"], ["MOVE", "Job Applications/Rejections", "OPERATOR", "PANE"],
      ["UNLABEL", "Clients", "OPERATOR", "PANE"], ["UNLABEL", "Job Applications/Other", "OPERATOR", "PANE"]
    ]);
    // The list rows carry the same labels by name.
    const rows = (await app.inject({ method: "GET", url: `/api/mail-copilot/threads?paneId=${encodeURIComponent(pane.id)}&account=me@gmail.com&labelId=Label_8`, headers })).json();
    expect(JSON.stringify(rows)).toContain('"labels":[{"id":"Label_8","name":"Job Applications/Rejections"}]');
    await app.close();
  });

  it("sends replies with threading headers, forwards and new mail from the account, and saves drafts", async () => {
    const me = fakeGmail("token-me", [{ id: "m1", threadId: "t1", from: "Anna <anna@acme.com>", subject: "Invoice", minutesAgo: 30, labelIds: ["INBOX"], plain: "Please find the invoice." },
      { id: "m2", threadId: "t2", from: "Piotr <piotr@acme.com>", to: "pending@team.com, LAB@team.com", subject: "PRs", minutesAgo: 20, labelIds: ["INBOX"], plain: "Status?" }]);
    const { app, pane, headers } = await fixture(googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), me.fetchImpl);
    const reply = await app.inject({ method: "POST", url: "/api/mail-copilot/messages/send", headers,
      payload: { paneId: pane.id, account: "me@gmail.com", to: ["anna@acme.com"], cc: ["carl@acme.com"], bcc: [], subject: "Re: Invoice", text: "Thanks Άννα, received.", threadId: "t1", inReplyToMessageId: "m1" } });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ messageId: "sent-1", threadId: "t1" });
    const sent = me.writes.find((write) => write.path === "/messages/send")!.body as { raw: string; threadId: string };
    expect(sent.threadId).toBe("t1");
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(raw).toContain("From: me@gmail.com\r\nTo: anna@acme.com\r\nCc: carl@acme.com\r\n");
    expect(raw).toContain("In-Reply-To: <m1@mail.example>\r\nReferences: <m1@mail.example>\r\n");
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toMatch(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/);
    expect(Buffer.from(/text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/.exec(raw)![1]!, "base64").toString("utf8")).toBe("Thanks Άννα, received.");
    const draft = await app.inject({ method: "POST", url: "/api/mail-copilot/drafts", headers,
      payload: { paneId: pane.id, account: "me@gmail.com", to: ["x@y.com"], subject: "Hello", text: "Draft body" } });
    expect(draft.json()).toEqual({ draftId: "draft-1", messageId: "draft-msg-1" });
    await app.inject({ method: "POST", url: "/api/mail-copilot/drafts", headers,
      payload: { paneId: pane.id, account: "me@gmail.com", to: ["anna@acme.com"], subject: "Re: Invoice", text: "Draft reply", threadId: "t1", inReplyToMessageId: "m1" } });
    const replyDraft = me.writes.filter((write) => write.path === "/drafts").at(-1)!.body as { message: { raw: string; threadId: string } };
    expect(replyDraft.message.threadId).toBe("t1");
    expect(Buffer.from(replyDraft.message.raw, "base64url").toString("utf8")).toContain("In-Reply-To: <m1@mail.example>\r\nReferences: <m1@mail.example>\r\n");
    // A reply to mail sent to a "Send mail as" address goes from that address, as Gmail answers; a pending alias never sends.
    await app.inject({ method: "POST", url: "/api/mail-copilot/messages/send", headers,
      payload: { paneId: pane.id, account: "me@gmail.com", to: ["piotr@acme.com"], subject: "Re: PRs", text: "Thanks", threadId: "t2", inReplyToMessageId: "m2" } });
    const aliasReply = Buffer.from((me.writes.filter((write) => write.path === "/messages/send").at(-1)!.body as { raw: string }).raw, "base64url").toString("utf8");
    expect(aliasReply).toMatch(/^From: "Lab Team" <lab@team\.com>\r\nTo: piotr@acme\.com\r\n/);
    expect(aliasReply).toContain("In-Reply-To: <m2@mail.example>\r\n");
    expect((await app.inject({ method: "POST", url: "/api/mail-copilot/messages/send", headers, payload: { paneId: pane.id, account: "me@gmail.com", to: [], subject: "x", text: "y" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/mail-copilot/messages/send", headers, payload: { paneId: pane.id, account: "other@gmail.com", to: ["x@y.com"], subject: "x", text: "y" } })).statusCode).toBe(409);
    await app.close();
  });

  it("parses participants and payloads, and builds a threaded MIME message", () => {
    expect(parseParticipants('"Doe, Jane" <jane@x.com>, bob@y.com, Carl <CARL@Z.com>')).toEqual([
      { name: "Doe, Jane", address: "jane@x.com" }, { name: "", address: "bob@y.com" }, { name: "Carl", address: "carl@z.com" }
    ]);
    const parsed = parsePayload({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>Only <b>HTML</b> here</p>") } }] });
    expect(parsed).toMatchObject({ text: "Only HTML here", html: "<p>Only <b>HTML</b> here</p>", attachments: [] });
    // 27/10: a bank sent its HTML document as the text/plain part; the reader gets text, not tags.
    const bank = parsePayload({ mimeType: "text/plain", body: { data: b64("<!DOCTYPE html><html><body><table><tr><td>Your statement</td></tr><tr><td>is attached.</td></tr></table></body></html>") } });
    expect(bank.text).toBe("Your statement\nis attached.");
    expect(parsePayload({ mimeType: "text/plain", body: { data: b64("Use <b>bold</b> in the template.") } }).text).toBe("Use <b>bold</b> in the template.");
    const raw = Buffer.from(buildMime({ from: "me@gmail.com", to: ["a@b.c"], subject: "Καλημέρα", text: "x", inReplyTo: "<1@x>", references: "<0@x>" }), "base64url").toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("References: <0@x> <1@x>");
    expect(raw).toMatch(/^From: me@gmail\.com\r\nTo: a@b\.c\r\n/);
    const sanitized = sanitizeMailHtml('<p onclick="x()">Hi</p><a href="javascript:alert(1)">bad</a><img src="cid:abc">', { loadImages: true, cidUrl: () => null });
    expect(sanitized.html).toBe("<p>Hi</p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\">bad</a><img alt=\"\" />");
    expect(sanitized.blockedImages).toBe(false);
  });
});

describe("mail copilot attachments", () => {
  it("R25-2: an attachment id from an earlier read is found by its file name when Gmail issued a new one, read by this fetch's id", async () => {
    // Like Gmail, every full fetch names the attachment with a new id; any id issued so far reads its bytes.
    const issued: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace("/gmail/v1/users/me", "");
      if (path === "/messages/m1") {
        issued.push(`att-${issued.length + 1}`);
        return Response.json({ id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "0", payload: { mimeType: "multipart/mixed", headers: [], parts: [
          { mimeType: "application/pdf", filename: "statement.pdf", body: { attachmentId: issued.at(-1), size: 8 } },
          { mimeType: "application/pdf", filename: "terms.pdf", body: { attachmentId: `terms-${issued.length}`, size: 5 } }] } });
      }
      const bytes = /^\/messages\/m1\/attachments\/(.+)$/.exec(path);
      if (bytes && issued.includes(bytes[1]!)) return Response.json({ data: Buffer.from("%PDF-1.4").toString("base64url") });
      return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
    }) as unknown as typeof fetch;
    const service = createMailCopilotService({ google: () => googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), gmailFetch: fetchImpl,
      repository: new InMemoryMailCopilotRepository() });
    const file = await service.attachment("user:owner", null, "me@gmail.com", "m1", "att-stale", "statement.pdf");
    expect(file).toMatchObject({ filename: "statement.pdf", mimeType: "application/pdf" });
    expect(file.data.toString()).toBe("%PDF-1.4");
    // Without a name, or a name that is not there, a stale id stays not found.
    await expect(service.attachment("user:owner", null, "me@gmail.com", "m1", "att-stale")).rejects.toThrow("Attachment was not found.");
    await expect(service.attachment("user:owner", null, "me@gmail.com", "m1", "att-stale", "other.pdf")).rejects.toThrow("Attachment was not found.");
  });

  it("threadSend (Nous Score, no Gmail read): our logged reply since the ask is SENT, a mailer-daemon mail after it BOUNCED, an older reply nothing", async () => {
    let clock = "2026-11-05T10:00:00.000Z";
    const repository = new InMemoryMailCopilotRepository(() => clock);
    const gmailFetch = vi.fn();
    const service = createMailCopilotService({ google: () => googleAccess([]), gmailFetch: gmailFetch as unknown as typeof fetch, repository });
    const owner = "user:owner";
    const reply = (threadId: string) => repository.recordAction({ ownerUserId: owner, accountEmail: "me@gmail.com", threadId, messageId: `m-${threadId}`, action: "REPLY", labelIds: [],
      fromAddress: "them@x.com", fromDomain: "x.com", subject: "Re: offer", subjectKey: "offer", actor: "AGENT", source: "PANE", ruleId: null });
    await reply("t1");
    await reply("t2");
    clock = "2026-11-05T10:05:00.000Z";
    await repository.createEvent({ ownerUserId: owner, paneId: null, runId: null, accountEmail: "me@gmail.com", threadId: "t2", messageId: "bounce", type: "MAIL_RECEIVED", status: null,
      message: "New mail: Delivery Status Notification (Failure)", payload: { from: { name: "Mail Delivery Subsystem", address: "MAILER-DAEMON@googlemail.com" } } });
    const ask = "2026-11-05T09:00:00.000Z";
    expect(await service.threadSend(owner, "Me@Gmail.com", "t1", ask)).toBe("SENT");
    expect(await service.threadSend(owner, "me@gmail.com", "t2", ask)).toBe("BOUNCED");
    expect(await service.threadSend(owner, "me@gmail.com", "t1", "2026-11-05T11:00:00.000Z")).toBeNull();
    expect(await service.threadSend(owner, "me@gmail.com", "t3", ask)).toBeNull();
    expect(gmailFetch).not.toHaveBeenCalled();
  });

  it("sentTo (goal 84ba917a): our send to the recipients in ANY thread since the approval, SENT unless a bounce came after it", async () => {
    let clock = "2026-11-05T10:00:00.000Z";
    const repository = new InMemoryMailCopilotRepository(() => clock);
    const service = createMailCopilotService({ google: () => googleAccess([]), gmailFetch: vi.fn() as unknown as typeof fetch, repository });
    const owner = "user:owner";
    const event = (threadId: string, type: string, payload: Record<string, unknown>) => repository.createEvent({ ownerUserId: owner, paneId: null, runId: null,
      accountEmail: "me@gmail.com", threadId, messageId: `m-${threadId}-${type}`, type: type as never, status: null, message: type, payload });
    await event("t-new", "SENT", { to: ["B2B@Vodafone.gr"], cc: [] });
    await repository.recordAction({ ownerUserId: owner, accountEmail: "me@gmail.com", threadId: "t-gmail", messageId: "m-gmail", action: "REPLY", labelIds: [],
      fromAddress: "them@x.com", fromDomain: "x.com", subject: "Re: offer", subjectKey: "offer", actor: "AGENT", source: "PANE", ruleId: null });
    clock = "2026-11-05T10:05:00.000Z";
    await event("t-gmail", "MAIL_RECEIVED", { from: { address: "postmaster@x.com" } });
    const approved = "2026-11-05T09:00:00.000Z";
    expect(await service.sentTo(owner, null, ["b2b@vodafone.gr"], approved)).toMatchObject({ state: "SENT", threadId: "t-new" });
    expect(await service.sentTo(owner, "me@gmail.com", ["them@x.com"], approved)).toMatchObject({ state: "BOUNCED", threadId: "t-gmail" });
    expect(await service.sentTo(owner, null, ["b2b@vodafone.gr"], "2026-11-05T11:00:00.000Z")).toBeNull();
    expect(await service.sentTo(owner, "other@gmail.com", ["b2b@vodafone.gr"], approved)).toBeNull();
  });

  it("sentTo, the 6/11 audit's cases: the recipient's domain counts, a shared provider's does not, a bounce counts only for an address we sent to", async () => {
    let clock = "2026-11-03T13:00:00.000Z";
    const repository = new InMemoryMailCopilotRepository(() => clock);
    const service = createMailCopilotService({ google: () => googleAccess([]), gmailFetch: vi.fn() as unknown as typeof fetch, repository });
    const owner = "user:owner";
    const event = (threadId: string, type: string, payload: Record<string, unknown>) => repository.createEvent({ ownerUserId: owner, paneId: null, runId: null,
      accountEmail: "info@example.invalid", threadId, messageId: `m-${threadId}-${type}`, type: type as never, status: null, message: type, payload });
    // Decisions 087b9f06/171a186a: thread 1a17b65672b48124 to six Hetzner addresses; only tco@ (an internal forward, not in To) bounced.
    await event("1a17b65672b48124", "SENT", { to: ["legal@hetzner.com", "info@hetzner.com"], cc: ["billing@hetzner.com"] });
    // Decision 2b23e984: the resend went in a NEW thread, not the auto-reply thread the decision named.
    await event("1a19b3efd04092b7", "SENT", { to: ["myhome@vodafone.gr"] });
    await event("t-gmail", "SENT", { to: ["someone@gmail.com"] });
    clock = "2026-11-03T13:01:00.000Z";
    await event("1a17b65672b48124", "MAIL_RECEIVED", { from: { address: "mailer-daemon@googlemail.com" },
      snippet: "Address not found Your message wasn't delivered to tco@hetzner.com because the address couldn't be found." });
    const asked = "2026-11-02T00:00:00.000Z";
    expect(await service.sentTo(owner, null, ["complaint@hetzner.com"], asked)).toMatchObject({ state: "SENT", threadId: "1a17b65672b48124" });
    expect(await service.sentTo(owner, null, ["myhome@vodafone.gr"], asked)).toMatchObject({ state: "SENT", threadId: "1a19b3efd04092b7" });
    expect(await service.sentTo(owner, null, ["other@gmail.com"], asked)).toBeNull();
    expect(await service.sentTo(owner, null, ["tco@hetzner.com"], asked)).toMatchObject({ state: "BOUNCED" });
  });

  it("sentTo (Score 6/11, Runware/FUTO/OVH): the Bcc copy of an SMTP send from the owner's alias or domain is our send; a stranger's mail to them is not", async () => {
    const clock = "2026-11-04T07:00:10.000Z";
    const repository = new InMemoryMailCopilotRepository(() => clock);
    const gmail = fakeGmail("token-me", []);
    const service = createMailCopilotService({ google: () => googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), gmailFetch: gmail.fetchImpl, repository });
    const owner = "user:owner";
    const copy = (threadId: string, from: string, to: string[], receivedAt = clock) => repository.createEvent({ ownerUserId: owner, paneId: null, runId: null, accountEmail: "me@gmail.com", threadId,
      messageId: `m-${threadId}`, type: "MAIL_RECEIVED", status: "PENDING", message: "New mail", payload: { from: { name: "", address: from }, to, receivedAt } });
    // Lab@team.com is a send-as alias of me@gmail.com; crew@team.com shares its domain; the sales mail and the gmail.com one are someone else's.
    await copy("t-alias", "lab@team.com", ["support@runware.example"]);
    await copy("t-domain", "crew@team.com", ["grantapps@futo.example"]);
    await copy("t-stranger", "sales@vendor.example", ["startups@e2b.example"]);
    await copy("t-shared", "friend@gmail.com", ["startup-program@ovh.example"]);
    // Sent before the approval, synced after it.
    await copy("t-late", "lab@team.com", ["sales@latitude.example"], "2026-11-04T06:00:00.000Z");
    const approved = "2026-11-04T06:45:00.000Z";
    expect(await service.sentTo(owner, null, ["support@runware.example"], approved)).toMatchObject({ state: "SENT", account: "me@gmail.com", threadId: "t-alias" });
    expect(await service.sentTo(owner, null, ["grantapps@futo.example"], approved)).toMatchObject({ state: "SENT", threadId: "t-domain" });
    expect(await service.sentTo(owner, null, ["startups@e2b.example"], approved)).toBeNull();
    expect(await service.sentTo(owner, null, ["startup-program@ovh.example"], approved)).toBeNull();
    expect(await service.sentTo(owner, null, ["sales@latitude.example"], approved)).toBeNull();
    // Before the approval it is no send for it.
    expect(await service.sentTo(owner, null, ["support@runware.example"], "2026-11-04T08:00:00.000Z")).toBeNull();
  });

  it("R25-2b: a later message's id reads that message's thread; an id Gmail has neither as thread nor message stays Gmail's not found", async () => {
    // Like Gmail: a thread opens only by its first message's id (t1); m2 is the thread's second message.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace("/gmail/v1/users/me", "");
      if (path === "/threads/t1") return Response.json({ id: "t1", messages: [{ id: "t1", threadId: "t1", labelIds: ["INBOX"], internalDate: "0",
        payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Case update" }], body: { data: b64("Hello") } } }] });
      if (path === "/messages/m2") return Response.json({ id: "m2", threadId: "t1" });
      return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
    }) as unknown as typeof fetch;
    const service = createMailCopilotService({ google: () => googleAccess([{ email: "me@gmail.com", capabilities: full, token: "token-me" }]), gmailFetch: fetchImpl,
      repository: new InMemoryMailCopilotRepository() });
    expect(await service.thread("user:owner", null, "me@gmail.com", "m2")).toMatchObject({ threadId: "t1", subject: "Case update" });
    await expect(service.thread("user:owner", null, "me@gmail.com", "x9")).rejects.toThrow("me@gmail.com: Gmail no longer has that message or thread.");
  });
});
