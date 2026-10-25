import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { localArtifactFilePath } from "../src/artifact-storage.js";
import { getApiConfig } from "../src/config.js";
import { createConnectorCrypto } from "../src/dot-connectors.js";
import { createDiscovery, matchesQuery, parseBoardPayload } from "../src/job-apply/discovery.js";
import { InMemoryJobApplyRepository } from "../src/job-apply/memory-repository.js";
import { decodeQuotedPrintable, extractCode, extractLinks, sourceToText, type MailboxFactory, type MailboxReader } from "../src/job-apply/mailbox.js";
import { createJobApplyService, parseCsv, type JobApplyGoogleAccess, type JobApplyServiceOptions } from "../src/job-apply/service.js";
import { companyKey, gmailScanQuery, matchConfirmationEmail } from "../src/job-apply/gmail-mailbox.js";
import { JOB_APPLY_IMPORTED_URL_PREFIX, importedJobPostingUrl, type ConnectorCapability } from "@space/contracts";

vi.setConfig({ testTimeout: 30_000 });
const csrfHeaderName = "x-space-csrf-token";
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const greenhouseMail = [
  "From: Greenhouse <no-reply@us.greenhouse-mail.io>",
  "Subject: Your security code",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "<p>Enter this security code field on your application:=20<b>AB12cd34</b></p>",
  "<a href=3D\"https://boards.greenhouse.io/verify?token=3Dabc=",
  "def\">Confirm</a>"
].join("\r\n");

function fakeMailboxes(messages: Array<{ from: string; subject: string; source: string }>, failures: string[] = []): MailboxFactory & { opened: Array<{ host: string; user: string; password: string }> } {
  const opened: Array<{ host: string; user: string; password: string }> = [];
  return {
    opened,
    async open(config, password) {
      opened.push({ host: config.host, user: config.user, password });
      if (failures.includes(password)) throw new Error("LOGIN failed");
      const reader: MailboxReader = {
        async recent(filter) {
          return messages.filter((message) => !filter.fromContains || message.from.includes(filter.fromContains))
            .slice(0, filter.limit).map((message, index) => ({ uid: index + 1, from: message.from, subject: message.subject, receivedAt: null, snippet: sourceToText(message.source).slice(0, 300) }));
        },
        async texts(filter) {
          return (await this.recent(filter)).map((summary) => ({ ...summary, text: `${sourceToText(messages[summary.uid - 1]!.source)}\n${extractLinks(messages[summary.uid - 1]!.source).join("\n")}` }));
        },
        async close() { /* no connection */ }
      };
      return reader;
    }
  };
}

/** The owner's Google connector: me@gmail.com allowed `granted` (token `token`), plus `others` (email → capabilities and token). */
function fakeGoogle(granted: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"], token = "gmail-token",
  others: Record<string, { capabilities: ConnectorCapability[]; token: string }> = {}) {
  const calls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
  const accounts: Record<string, { capabilities: ConnectorCapability[]; token: string }> = { "me@gmail.com": { capabilities: granted, token }, ...others };
  const access: JobApplyGoogleAccess = {
    googleConfigured: true,
    async googleAccounts() { return Object.entries(accounts).map(([email, account]) => ({ email, capabilities: account.capabilities })); },
    async googleCapabilities(_owner, email) { return accounts[email]?.capabilities ?? []; },
    async googleAccessToken(_owner, email, capability) {
      if (!accounts[email]?.capabilities.includes(capability)) throw Object.assign(new Error("not allowed"), { code: "CONNECTOR_NEEDS_CONNECTION" });
      return accounts[email]!.token;
    },
    async tool(_owner, toolId, args) {
      calls.push({ toolId, args });
      return { status: "COMPLETED", result: { toolId, account: args.account } };
    }
  };
  return { access, calls };
}

type GmailMessage = { id: string; from: string; subject: string; receivedAt: string; source: string };
/** Gmail API answers per access token (`gmail-token` by default); 401 for any other token. */
function fakeGmail(inbox: GmailMessage[], others: Record<string, GmailMessage[]> = {}) {
  const requests: string[] = [];
  const inboxes: Record<string, GmailMessage[]> = { "gmail-token": inbox, ...others };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    const messages = inboxes[(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "")];
    if (!messages) return json({ error: { code: 401 } }, 401);
    if (parsed.pathname.endsWith("/messages")) return json({ messages: messages.map((message) => ({ id: message.id })) });
    const message = messages.find((entry) => entry.id === decodeURIComponent(parsed.pathname.split("/").pop()!))!;
    if (parsed.searchParams.get("format") === "raw") return json({ id: message.id, raw: Buffer.from(message.source).toString("base64url") });
    return json({ id: message.id, internalDate: String(Date.parse(message.receivedAt)), snippet: `${message.subject} &#39;preview&#39;`,
      payload: { headers: [{ name: "From", value: `Sender <${message.from}>` }, { name: "Subject", value: message.subject }] } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const gmailInbox = () => fakeGmail([
  { id: "m2", from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", receivedAt: "2026-10-13T08:00:00.000Z", source: greenhouseMail },
  { id: "m1", from: "news@example.com", subject: "Weekly", receivedAt: "2026-10-12T08:00:00.000Z", source: "Subject: Weekly\r\n\r\nhello" }
]);

async function serviceFixture(mailboxes = fakeMailboxes([{ from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", source: greenhouseMail }]),
  extra: Pick<JobApplyServiceOptions, "google" | "gmailFetch" | "now" | "repository"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-job-apply-"));
  temporaryRoots.push(root);
  const store = new InMemorySpaceStore();
  const service = createJobApplyService({
    repository: new InMemoryJobApplyRepository(),
    crypto: createConnectorCrypto({ key: "synthetic-connector-key-with-enough-length-0123456789", legacySecrets: ["test-secret-with-enough-length-0123456789"] }),
    store,
    artifactRoot: root,
    jobApplyRoot: join(root, "job-apply"),
    mailboxes,
    readerOptions: { workerPath: fileURLToPath(new URL("../src/attachment-reader-worker.ts", import.meta.url)), timeoutMs: 30_000 },
    ...extra
  });
  return { root, store, service, mailboxes };
}

describe("job apply mailbox decoding", () => {
  it("decodes quoted-printable mail, finds codes and links", () => {
    expect(decodeQuotedPrintable("a=20b=\r\nc")).toBe("a bc");
    const text = sourceToText(greenhouseMail);
    expect(extractCode(text, /security code field on your application[:\s]*([A-Za-z0-9]{8})/i)).toBe("AB12cd34");
    expect(extractLinks(greenhouseMail, "greenhouse.io/verify")).toEqual(["https://boards.greenhouse.io/verify?token=abcdef"]);
  });
});

describe("job apply service", () => {
  it("seals the mailbox password, never exposes it, and reads codes through the API only", async () => {
    const { service, mailboxes } = await serviceFixture();
    const bad = fakeMailboxes([], ["wrong"]);
    const { service: strict } = await serviceFixture(bad);
    await expect(strict.setMailbox("user:a", { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "wrong" })).rejects.toThrow(/LOGIN failed/);

    const profile = await service.setMailbox("user:a", { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "app-password" });
    expect(profile.mailbox).toEqual({ host: "imap.example.com", port: 993, secure: true, user: "me@example.com" });
    expect(JSON.stringify(profile)).not.toContain("app-password");
    expect(profile.mailboxVerifiedAt).not.toBeNull();
    const code = await service.waitForCode("user:a", { fromContains: "greenhouse", pattern: "security code field on your application[:\\s]*([A-Za-z0-9]{8})", timeoutMs: 1000 });
    expect(code).toMatchObject({ code: "AB12cd34", from: "no-reply@us.greenhouse-mail.io" });
    expect(mailboxes.opened.at(-1)?.password).toBe("app-password");
    const link = await service.findLink("user:a", { urlContains: "verify", timeoutMs: 1000 });
    expect(link?.link).toBe("https://boards.greenhouse.io/verify?token=abcdef");
    expect(await service.waitForCode("user:a", { fromContains: "nobody", pattern: "\\d{6}", timeoutMs: 10, pollMs: 2000 })).toBeNull();
    const cleared = await service.clearMailbox("user:a");
    expect(cleared.mailbox).toBeNull();
    await expect(service.recentMail("user:a", { limit: 3 })).rejects.toThrow("Allow Gmail for a Google account in Job Copilot Setup → Google account, or connect a mailbox there.");
  });

  it("reads codes, links and recent mail from the Gmail of the chosen Google account", async () => {
    const google = fakeGoogle();
    const gmail = gmailInbox();
    const { service, mailboxes } = await serviceFixture(undefined, { google: () => google.access, gmailFetch: gmail.fetchImpl });
    expect((await service.getProfile("user:a")).google).toBeNull();
    const profile = await service.setGoogleAccount("user:a", "Me@Gmail.com");
    expect(profile.google).toEqual({ email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"], available: true });
    expect(profile.googleAccounts).toEqual([{ email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] }]);
    expect(profile.mailbox).toBeNull();

    const code = await service.waitForCode("user:a", { fromContains: "greenhouse", pattern: "security code field on your application[:\\s]*([A-Za-z0-9]{8})",
      since: "2026-10-13T07:59:00.000Z", timeoutMs: 1000 });
    expect(code).toEqual({ code: "AB12cd34", from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", receivedAt: "2026-10-13T08:00:00.000Z", account: "me@gmail.com" });
    expect(gmail.requests[0]).toBe(`/gmail/v1/users/me/messages?${new URLSearchParams({ q: gmailScanQuery("2026-10-13T07:59:00.000Z"), maxResults: "30" })}`);
    expect(gmailScanQuery("2026-10-13T07:59:00.000Z")).toBe(`-in:sent -in:drafts -in:chats after:${Date.parse("2026-10-13T07:58:00.000Z") / 1000}`);
    // Only the matching message is downloaded in full.
    expect(gmail.requests.filter((request) => request.includes("format=raw"))).toEqual(["/gmail/v1/users/me/messages/m2?format=raw"]);
    expect((await service.findLink("user:a", { urlContains: "verify", timeoutMs: 1000 }))?.link).toBe("https://boards.greenhouse.io/verify?token=abcdef");
    expect(await service.recentMail("user:a", { limit: 5 })).toEqual([
      { messageId: "m2", from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", receivedAt: "2026-10-13T08:00:00.000Z", snippet: "Your security code 'preview'", account: "me@gmail.com" },
      { messageId: "m1", from: "news@example.com", subject: "Weekly", receivedAt: "2026-10-12T08:00:00.000Z", snippet: "Weekly 'preview'", account: "me@gmail.com" }
    ]);
    expect((await service.testMailbox("user:a")).recent).toHaveLength(2);
    expect(mailboxes.opened).toHaveLength(0);
    expect((await service.setGoogleAccount("user:a", null)).google).toBeNull();
  });

  it("falls back to the IMAP mailbox when Gmail access is missing or lapsed, and says how to allow it", async () => {
    const readless = fakeGoogle(["CALENDAR"]);
    const { service, mailboxes } = await serviceFixture(undefined, { google: () => readless.access, gmailFetch: gmailInbox().fetchImpl });
    await service.setGoogleAccount("user:a", "me@gmail.com");
    await expect(service.recentMail("user:a", { limit: 3 })).rejects.toThrow("Allow Gmail access for me@gmail.com in Job Copilot Setup → Google account, or connect a mailbox there.");
    await service.setMailbox("user:a", { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "app-password" });
    expect((await service.waitForCode("user:a", { fromContains: "greenhouse", pattern: "application[:\\s]*([A-Za-z0-9]{8})", timeoutMs: 1000 }))?.code).toBe("AB12cd34");
    expect(mailboxes.opened).toHaveLength(2);

    const lapsed = fakeGoogle(undefined, "revoked-token");
    const { service: expired, mailboxes: imap } = await serviceFixture(undefined, { google: () => lapsed.access, gmailFetch: gmailInbox().fetchImpl });
    await expired.setGoogleAccount("user:a", "me@gmail.com");
    await expect(expired.recentMail("user:a", { limit: 3 })).rejects.toThrow("Google access for me@gmail.com is missing or expired. Allow Gmail & Calendar again in Job Copilot Setup → Google account.");
    await expired.setMailbox("user:a", { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "app-password" });
    expect(await expired.recentMail("user:a", { limit: 3 })).toHaveLength(1);
    expect(imap.opened).toHaveLength(2);
  });

  it("reads codes and mail from every Google account allowed for Space at once", async () => {
    const google = fakeGoogle(undefined, undefined, { "work@gmail.com": { capabilities: ["MAIL_READ"], token: "work-token" }, "cal@gmail.com": { capabilities: ["CALENDAR"], token: "cal-token" } });
    const gmail = fakeGmail([
      { id: "m1", from: "news@example.com", subject: "Weekly", receivedAt: "2026-10-12T08:00:00.000Z", source: "Subject: Weekly\r\n\r\nhello" }
    ], { "work-token": [{ id: "w1", from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", receivedAt: "2026-10-13T08:00:00.000Z", source: greenhouseMail }] });
    const { service } = await serviceFixture(undefined, { google: () => google.access, gmailFetch: gmail.fetchImpl });
    await service.setGoogleAccount("user:a", "me@gmail.com");
    const profile = await service.getProfile("user:a");
    expect(profile.googleAccounts.map((account) => account.email)).toEqual(["me@gmail.com", "work@gmail.com", "cal@gmail.com"]);
    // The code arrived in the second account; the chosen account is read too, the calendar-only one is not.
    expect(await service.waitForCode("user:a", { fromContains: "greenhouse", pattern: "application[:\\s]*([A-Za-z0-9]{8})", timeoutMs: 1000 }))
      .toMatchObject({ code: "AB12cd34", account: "work@gmail.com" });
    expect((await service.recentMail("user:a", { limit: 5 })).map((message) => [message.account, message.subject]))
      .toEqual([["work@gmail.com", "Your security code"], ["me@gmail.com", "Weekly"]]);
    // A search without an account spans both readable accounts; a named one is used alone.
    google.calls.splice(0);
    const searched = await service.googleTool("user:a", "mail.search", { query: "interview", limit: 5 }) as { accounts: string[] };
    expect(searched.accounts).toEqual(["me@gmail.com", "work@gmail.com"]);
    expect(google.calls.map((call) => call.args.account)).toEqual(["me@gmail.com", "work@gmail.com"]);
    await service.googleTool("user:a", "mail.read", { messageId: "w1", account: "WORK@gmail.com" });
    expect(google.calls.at(-1)).toEqual({ toolId: "mail.read", args: { messageId: "w1", account: "work@gmail.com" } });
    await expect(service.googleTool("user:a", "mail.read", { messageId: "c1", account: "cal@gmail.com" }))
      .rejects.toThrow("cal@gmail.com has not allowed reading email for Space. Allow Gmail & Calendar for it in Job Copilot Setup → Google account.");
    // Calendar and drafts default to the chosen account, else the first one that allowed them.
    await service.googleTool("user:a", "calendar.list", {});
    expect(google.calls.at(-1)!.args.account).toBe("me@gmail.com");
  });

  it("matches confirmation emails to sent applications by company and date", () => {
    expect(companyKey("Qube Research & Technologies")).toBe(companyKey("quberesearchandtechnologies"));
    const hits = [
      { subject: "Thank you for applying to Databricks!", snippet: "", receivedAt: "2026-08-24T10:00:00.000Z" },
      { subject: "Thank you for your application to Qube Research & Technologies", snippet: "", receivedAt: "2026-08-18T09:00:00.000Z" },
      { subject: "Nikolaos, your application was sent to Conquer AI", snippet: "Software Engineer · Conquer AI · Singapore", receivedAt: "2026-09-02T20:10:00.000Z" },
      { subject: "Your weekly job alert", snippet: "New jobs at Databricks", receivedAt: "2026-08-24T11:00:00.000Z" }
    ];
    expect(matchConfirmationEmail({ company: "databricks", appliedAt: "2026-08-24T09:00:00.000Z" }, hits)?.subject).toBe("Thank you for applying to Databricks!");
    expect(matchConfirmationEmail({ company: "quberesearchandtechnologies", appliedAt: "2026-08-17T12:00:00.000Z" }, hits)?.receivedAt).toBe("2026-08-18T09:00:00.000Z");
    // LinkedIn rows of the earlier tracker carry "title company" in the company column.
    expect(matchConfirmationEmail({ company: "SE Conquer AI", appliedAt: "2026-09-02T20:09:07.000Z" }, hits)?.subject).toContain("Conquer AI");
    // Out of the window, another company, an alert that is not a confirmation, or no applied date: no match.
    expect(matchConfirmationEmail({ company: "databricks", appliedAt: "2026-08-01T09:00:00.000Z" }, hits)).toBeNull();
    expect(matchConfirmationEmail({ company: "Snowflake", appliedAt: "2026-08-24T09:00:00.000Z" }, hits)).toBeNull();
    expect(matchConfirmationEmail({ company: "databricks", appliedAt: null }, hits)).toBeNull();
  });

  it("checks sent applications with Gmail: confirmed ones become VERIFIED with the email, the rest say none was found", async () => {
    const google = fakeGoogle();
    const gmail = fakeGmail([
      { id: "c1", from: "no-reply@us.greenhouse-mail.io", subject: "Thank you for applying to Databricks!", receivedAt: "2026-08-24T10:00:00.000Z", source: "Subject: x\r\n\r\nthanks" }
    ]);
    const { service } = await serviceFixture(undefined, { google: () => google.access, gmailFetch: gmail.fetchImpl });
    await service.importCsv("user:a", ["id,company,board,role,geo,source,status,applied_date,notes",
      "databricks_8569390002,databricks,gh-iframe,Job 8569390002,,greenhouse,applied,2026-08-24 09:00:00,verified",
      "snowflake_123456,snowflake,gh-generic,Job 123456,,greenhouse,applied,2026-08-25 09:00:00,verified",
      "linkedin_4453887122,SE Conquer AI,,,,NO_FORM,linkedin_ea,2026-09-02 20:09:07,,"].join("\n"), null);
    const result = await service.checkWithMail("user:a");
    expect(result).toEqual({ checked: 2, confirmed: 1, unconfirmed: 1, accounts: ["me@gmail.com"] });
    expect(decodeURIComponent(gmail.requests[0]!.replace(/\+/g, " "))).toContain("after:2026/08/22 before:2026/09/02 {from:greenhouse-mail.io");
    const rows = new Map((await service.listApplications("user:a", { limit: 10 })).map((row) => [row.company, row]));
    expect(rows.get("databricks")).toMatchObject({ status: "VERIFIED", externalConfirmation: 'Gmail me@gmail.com: "Thank you for applying to Databricks!" 2026-08-24' });
    expect(rows.get("databricks")!.notes).toBe("verified | imported id: databricks_8569390002 | earlier tracker said verified | confirmation email 2026-08-24");
    expect(rows.get("snowflake")).toMatchObject({ status: "SUBMITTED", externalConfirmation: null });
    expect(rows.get("snowflake")!.notes).toMatch(/earlier tracker said verified \| no confirmation email found \(checked \d{4}-\d{2}-\d{2}\)$/);
    expect(rows.get("SE Conquer AI")!.status).toBe("FAILED");
    // A second check looks again at the unconfirmed one only, without piling up notes.
    expect(await service.checkWithMail("user:a")).toMatchObject({ checked: 1, confirmed: 0, unconfirmed: 1 });
    expect((await service.getApplication("user:a", rows.get("snowflake")!.id)).notes!.match(/no confirmation email found/g)).toHaveLength(1);
    const events = await service.listEvents("user:a", { limit: 5 });
    expect(events[0]).toMatchObject({ type: "NOTE", message: "Checked 1 sent applications against Gmail (me@gmail.com): 0 confirmed by email, 1 without a confirmation email." });
    const none = fakeGoogle([]);
    const { service: unallowed } = await serviceFixture(undefined, { google: () => none.access });
    await expect(unallowed.checkWithMail("user:a")).rejects.toThrow("Allow Gmail for a Google account in Job Copilot Setup → Google account first.");
  });

  it("drafts mail and keeps the calendar of the chosen Google account only with the access allowed", async () => {
    const google = fakeGoogle(["MAIL_READ", "CALENDAR"]);
    const { service } = await serviceFixture(undefined, { google: () => google.access });
    const none = fakeGoogle([]);
    const { service: unallowed } = await serviceFixture(undefined, { google: () => none.access });
    await expect(unallowed.googleTool("user:a", "calendar.list", {})).rejects.toThrow("No Google account has allowed calendar for Space. Allow Gmail & Calendar for one in Job Copilot Setup → Google account.");
    await service.setGoogleAccount("user:a", "me@gmail.com");
    expect(await service.googleTool("user:a", "calendar.create", { title: "Interview", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" }))
      .toEqual({ toolId: "calendar.create", account: "me@gmail.com" });
    expect(google.calls).toEqual([{ toolId: "calendar.create", args: { title: "Interview", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z", account: "me@gmail.com" } }]);
    await expect(service.googleTool("user:a", "mail.draft", { to: ["recruiter@example.com"], subject: "Thanks", body: "Hello" }))
      .rejects.toThrow("me@gmail.com has not allowed drafting email for Space. Allow Gmail & Calendar in Job Copilot Setup → Google account.");
    expect(google.calls).toHaveLength(1);
  });

  it("imports CV text from an Agent Files artifact", async () => {
    const { root, store, service } = await serviceFixture();
    const content = "Nikolaos Theodoropoulos\nBackend engineer. Skills: Node.js, Postgres.\n";
    const created = await store.createArtifact({ roomId: null, paneId: null, kind: "EXPORT", mimeType: "text/plain",
      storageUri: "space-artifact://agent-files/room_x/pane_y/session_z/2026-10-12/cv.txt",
      sha256: createHash("sha256").update(content).digest("hex"), byteSize: Buffer.byteLength(content), metadata: { originalFilename: "cv.txt" } });
    const artifact = "artifact" in created ? created.artifact : created;
    const sourcePath = localArtifactFilePath({ artifactRoot: root, artifact });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content, "utf8");
    const imported = await service.importCv("user:a", artifact.id);
    expect(imported.coverage).toBe("FULL");
    expect(imported.textPreview).toContain("Backend engineer");
    expect(imported.profile.cvArtifactId).toBe(artifact.id);
    expect(imported.profile.cvTextChars).toBeGreaterThan(20);
    const cv = await service.cvText("user:a");
    expect(cv.path).toBe(sourcePath);
    await expect(service.importCv("user:a", "artifact:missing0")).rejects.toThrow(/not found/);
  });

  it("tracks applications with evidence-gated verification, pacing and CSV import", async () => {
    const { service } = await serviceFixture();
    const first = await service.createApplication("user:a", { company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(first.created).toBe(true);
    const again = await service.createApplication("user:a", { company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(again.created).toBe(false);
    expect(again.application.id).toBe(first.application.id);
    await expect(service.updateApplication("user:a", first.application.id, { status: "VERIFIED" })).rejects.toThrow(/cannot move/);
    await service.updateApplication("user:a", first.application.id, { status: "FILLING" });
    await expect(service.updateApplication("user:a", first.application.id, { status: "SUBMITTED" })).rejects.toThrow(/form snapshot/);
    await service.recordFields("user:a", first.application.id, [{ stepIndex: 0, label: "Full name", fieldType: "text", value: "Nikolaos", source: "PROFILE" }]);
    const submitted = await service.updateApplication("user:a", first.application.id, { status: "SUBMITTED" });
    expect(submitted.appliedAt).not.toBeNull();
    await expect(service.updateApplication("user:a", first.application.id, { status: "VERIFIED" })).rejects.toThrow(/needs evidence/);
    const verified = await service.updateApplication("user:a", first.application.id, { status: "VERIFIED", externalConfirmation: "security code AB12cd34" });
    expect(verified.status).toBe("VERIFIED");
    await expect(service.getApplication("user:b", first.application.id)).rejects.toThrow(/not found/);

    const pacing = await service.pacing("user:a", "greenhouse", { version: 1, settings: { submitMode: "AUTO", dailyCaps: { linkedin: 1, greenhouse: 1, ashby: 1, lever: 1, workday: 1, indeed: 1, other: 1 }, minDelayMs: 0, maxDelayMs: 0, paused: false } });
    expect(pacing).toMatchObject({ site: "greenhouse", todayCount: 1, dailyCap: 1, allowed: false, nextAllowedAt: "tomorrow" });
    expect((await service.pacing("user:a", "ashby", null)).allowed).toBe(true);
    expect((await service.pacing("user:a", "ashby", { version: 1, settings: { submitMode: "AUTO", dailyCaps: { linkedin: 25, greenhouse: 60, ashby: 60, lever: 60, workday: 40, indeed: 40, other: 40 }, minDelayMs: 1, maxDelayMs: 1, paused: true } })).allowed).toBe(false);

    expect(parseCsv("a,b\n\"x, y\",\"q\"\"q\"\r\n")).toEqual([["a", "b"], ["x, y", "q\"q"]]);
    const csv = ["id,company,board,role,geo,source,status,applied_date,notes,relevance",
      "T1,Quora,quberesearchandtechnologies,DevOps Engineer,HK,greenhouse,applied,2026-08-07,verified code DBapi1eA,match",
      "li_1,Snowflake,linkedin,Backend Engineer,APAC,linkedin,applied,2026-09-02,,match",
      "x9,,x,Role,,greenhouse,applied,,,",
      // Shifted columns of the 2026-09-02 LinkedIn run: status holds the board, source the outcome.
      "linkedin_4453887122,SE Conquer AI,,,,NO_FORM,linkedin_ea,2026-09-02 20:09:07,,",
      "linkedin_4459768617,Senior Distributed Systems AI NEXadept SG,,,,applied,linkedin_ea,2026-09-02 20:11:06,,",
      // Status holds the date, applied_date a run tag.
      "6ddcfe47-6cce-469b-ba6d-4f0e83440c9d,railway,,railway job,remote,applied,2026-08-28,ASHBY_STEALTH_RUN16,,",
      "databricks_8569390002,databricks,gh-iframe,Job 8569390002,,greenhouse,applied,2026-08-24,verified,",
      "z1,Nowhere,,Role,,somewhere,drafted,2026-08-01,,"].join("\n");
    const imported = await service.importCsv("user:a", csv, null);
    expect(imported).toEqual({ imported: 6, skipped: 2, duplicates: 0 });
    expect(await service.importCsv("user:a", csv, null)).toEqual({ imported: 0, skipped: 2, duplicates: 6 });
    const rows = await service.listApplications("user:a", { limit: 20 });
    const byCompany = new Map(rows.map((row) => [row.company, row]));
    // An earlier tracker's "verified" is a claim: imported rows are never VERIFIED.
    expect(rows.map((row) => [row.company, row.ats, row.status]).sort()).toEqual([
      ["Acme", "greenhouse", "VERIFIED"], ["Quora", "greenhouse", "SUBMITTED"], ["SE Conquer AI", "linkedin", "FAILED"],
      ["Senior Distributed Systems AI NEXadept SG", "linkedin", "SUBMITTED"], ["Snowflake", "linkedin", "SUBMITTED"],
      ["databricks", "greenhouse", "SUBMITTED"], ["railway", "other", "SUBMITTED"]]);
    expect(byCompany.get("Quora")).toMatchObject({ externalConfirmation: null, notes: expect.stringContaining("earlier tracker said verified; no confirmation email checked yet") });
    expect(byCompany.get("SE Conquer AI")).toMatchObject({ role: "Title not recorded", notes: expect.stringContaining("earlier tracker: no application form found"),
      appliedAt: new Date("2026-09-02 20:09:07").toISOString() });
    expect(byCompany.get("railway")!.appliedAt).toBe(new Date("2026-08-28").toISOString());
    expect(byCompany.get("databricks")!.role).toBe("Title not recorded");
    expect(importedJobPostingUrl(byCompany.get("SE Conquer AI")!)).toBe("https://www.linkedin.com/jobs/view/4453887122/");
    expect(importedJobPostingUrl(byCompany.get("databricks")!)).toBe("https://job-boards.greenhouse.io/databricks/jobs/8569390002");
    expect(importedJobPostingUrl(byCompany.get("railway")!)).toBeNull();
    expect(importedJobPostingUrl(byCompany.get("Acme")!)).toBeNull();
  });
});

describe("job copilot data", () => {
  it("recalls, remembers, updates and forgets memories; the v1 Q&A bank migrates into ANSWER memories once", async () => {
    const { service } = await serviceFixture();
    await service.updateProfile("user:a", { qaBank: [
      { question: "How many years of Node.js experience do you have?", answer: "8", source: "USER", updatedAt: "2026-10-12T00:00:00.000Z" },
      { question: "Do you need visa sponsorship?", answer: "Yes", source: "PROFILE", updatedAt: "2026-10-12T00:00:00.000Z" }
    ] });
    const migrated = await service.listMemory("user:a", { kinds: ["ANSWER"], limit: 10 });
    expect(migrated.map((memory) => [memory.key, memory.text, memory.source, memory.tags]).sort()).toEqual([
      ["do you need visa sponsorship", "Yes", "PROFILE", ["qa-bank"]],
      ["how many years of node js experience do you have", "8", "USER", ["qa-bank"]]
    ]);
    expect((await service.getProfile("user:a")).qaBank).toEqual([]);

    const answer = await service.answerFor("user:a", "Will you now or in the future need visa sponsorship? Do you need visa sponsorship?");
    expect(answer?.text).toBe("Yes");
    expect((await service.answerFor("user:a", "how many years of node.js experience do you have"))?.text).toBe("8");
    expect(await service.answerFor("user:a", "Favourite colour?")).toBeNull();

    const lesson = await service.rememberMemory("user:a", { kind: "LESSON", text: "Greenhouse security code arrives within a minute; never resubmit the code page.", site: "greenhouse", tags: ["code"] });
    expect(lesson).toMatchObject({ kind: "LESSON", key: null, site: "greenhouse", source: "AGENT", confidence: 0.8 });
    const salary = await service.rememberMemory("user:a", { kind: "ANSWER", key: "Expected salary", text: "80k EUR", source: "USER" });
    const salaryAgain = await service.rememberMemory("user:a", { kind: "ANSWER", key: "expected salary?", text: "85k EUR", source: "USER" });
    expect(salaryAgain.id).toBe(salary.id);
    expect(salaryAgain.text).toBe("85k EUR");
    await expect(service.rememberMemory("user:a", { kind: "ANSWER", text: "no key" })).rejects.toThrow(/need the question/);
    expect(await service.memoryCount("user:a")).toBe(4);

    const recalled = await service.recallMemory("user:a", { query: "security code greenhouse", site: "greenhouse", limit: 5 });
    expect(recalled.map((memory) => memory.kind)).toEqual(["LESSON"]);
    expect((await service.listMemory("user:a", { kinds: ["LESSON"], limit: 5 }))[0]).toMatchObject({ uses: 1 });
    expect(await service.updateMemory("user:a", lesson.id, { pinned: true, text: "Greenhouse security code: wait, never resubmit." })).toMatchObject({ pinned: true });
    await service.forgetMemory("user:a", lesson.id);
    await expect(service.forgetMemory("user:a", lesson.id)).rejects.toThrow(/not found/);
    expect(await service.listMemory("user:b", { limit: 5 })).toEqual([]);
  });

  it("records fields per step, turns non-personal answers into memories, logs events and gates SUBMITTED", async () => {
    const { service } = await serviceFixture();
    const events: string[] = [];
    const observed = createJobApplyService({ ...service.options, onEvent: (event) => events.push(`${event.type}:${event.message}`) });
    const { application } = await observed.createApplication("user:a", { company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/9" }, { paneId: "pane:jobs0001" });
    expect(application.queuePosition).toBe(0);
    await observed.updateApplication("user:a", application.id, { status: "FILLING" }, { paneId: "pane:jobs0001" });
    const fields = await observed.recordFields("user:a", application.id, [
      { stepIndex: 0, stepTitle: "Application", label: "Full name", fieldType: "text", value: "Nikolaos Theodoropoulos", source: "PROFILE" },
      { stepIndex: 0, stepTitle: "Application", label: "Email", fieldType: "text", value: "me@example.com", source: "PROFILE" },
      { stepIndex: 0, stepTitle: "Application", label: "Resume/CV", fieldType: "file", value: "/opt/spaceapp/var/artifacts/cv.pdf", source: "PROFILE" },
      { stepIndex: 1, stepTitle: "Questions", label: "How many years of TypeScript experience do you have?", fieldType: "text", value: "6", source: "CV" },
      { stepIndex: 1, stepTitle: "Questions", label: "Are you legally authorized to work in Greece?", fieldType: "radio", value: "Yes", source: "PROFILE" },
      { stepIndex: 1, stepTitle: "Questions", label: "Security code", fieldType: "text", value: "AB12cd34", source: "AGENT" }
    ], { paneId: "pane:jobs0001" });
    expect(fields).toHaveLength(6);
    expect(fields.find((field) => field.label === "Resume/CV")?.value).toBe("cv.pdf");
    const answers = await observed.listMemory("user:a", { kinds: ["ANSWER"], limit: 10 });
    expect(answers.map((memory) => [memory.key, memory.text]).sort()).toEqual([
      ["are you legally authorized to work in greece", "Yes"],
      ["how many years of typescript experience do you have", "6"]
    ]);
    expect(answers.find((memory) => memory.key?.startsWith("how many"))).toMatchObject({ source: "CV", confidence: 0.7, tags: ["form", "greenhouse"] });

    const again = await observed.recordFields("user:a", application.id, [{ stepIndex: 1, label: "How many years of TypeScript experience do you have?", fieldType: "text", value: "7", source: "USER" }]);
    expect(again[0]?.id).toBe(fields.find((field) => field.label.startsWith("How many"))?.id);
    expect((await observed.listFields("user:a", application.id))).toHaveLength(6);
    expect((await observed.answerFor("user:a", "How many years of TypeScript experience do you have?"))?.text).toBe("7");

    const edited = await observed.editField("user:a", fields.find((field) => field.label.startsWith("Are you"))!.id, "Yes, EU citizen");
    expect(edited).toMatchObject({ value: "Yes, EU citizen", source: "USER" });
    expect((await observed.answerFor("user:a", "Are you legally authorized to work in Greece?"))?.text).toBe("Yes, EU citizen");

    const submitted = await observed.updateApplication("user:a", application.id, { status: "SUBMITTED" }, { paneId: "pane:jobs0001" });
    expect(submitted.queuePosition).toBeNull();
    await observed.logEvent("user:a", { applicationId: application.id, type: "SCREENSHOT", message: "Thank-you page", artifactId: "artifact:shot0001", paneId: "pane:jobs0001" });
    await expect(observed.logEvent("user:a", { applicationId: "jobapp:missing0", message: "x" })).rejects.toThrow(/not found/);
    await observed.updateApplication("user:a", application.id, { status: "VERIFIED", evidenceArtifactIds: ["artifact:shot0001"] }, { paneId: "pane:jobs0001" });
    expect(events).toEqual([
      "NOTE:Queued Acme · Backend",
      "STARTED:Filling Acme · Backend",
      "FIELD_FILLED:Filled 6 fields on Application, Questions",
      "FIELD_FILLED:Filled 1 field on step 2",
      "SUBMITTED:Submitted Acme · Backend",
      "SCREENSHOT:Thank-you page",
      "VERIFIED:Verified Acme · Backend"
    ]);
    const timeline = await observed.listEvents("user:a", { applicationId: application.id, limit: 10 });
    expect(timeline[0]).toMatchObject({ type: "VERIFIED", artifactId: "artifact:shot0001", paneId: "pane:jobs0001" });
    expect(await observed.listEvents("user:b", { limit: 10 })).toEqual([]);
  });

  it("counts applications since the first day, per day in the operator's zone, with the earlier campaign apart", async () => {
    const repository = new InMemoryJobApplyRepository();
    // 12:00 on Oct 14 in Bangkok (UTC+7).
    const { service } = await serviceFixture(undefined, { repository, now: () => "2026-10-14T05:00:00.000Z" });
    const row = async (url: string, status: "QUEUED" | "NEEDS_USER" | "SUBMITTED" | "VERIFIED", appliedAt: string | null) => {
      const created = await repository.createApplication({ ownerUserId: "user:a", paneId: null, company: "Acme", role: "Dev", ats: "greenhouse", url, status: "QUEUED", notes: null, queuePosition: null });
      await repository.updateApplication("user:a", created.id, { status, appliedAt });
    };
    await row("https://boards.greenhouse.io/acme/jobs/1", "VERIFIED", "2026-10-12T18:00:00.000Z"); // Oct 13, 01:00 in Bangkok
    await row("https://boards.greenhouse.io/acme/jobs/2", "SUBMITTED", "2026-10-13T16:59:00.000Z"); // Oct 13, 23:59
    await row("https://boards.greenhouse.io/acme/jobs/3", "VERIFIED", "2026-10-13T17:00:00.000Z"); // Oct 14, 00:00
    await row("https://boards.greenhouse.io/acme/jobs/4", "NEEDS_USER", null);
    await row("https://boards.greenhouse.io/acme/jobs/5", "QUEUED", null);
    await row(`${JOB_APPLY_IMPORTED_URL_PREFIX}linkedin/4453887122`, "SUBMITTED", "2026-09-02T20:09:07.000Z");
    expect(await service.stats("user:a", "Asia/Bangkok")).toEqual({
      campaignStartedAt: null,
      firstDay: "2026-10-13",
      today: { applied: 1, verified: 1, failed: 0 },
      totals: { applied: 3, verified: 2, failed: 0, needsUser: 1 },
      days: [{ day: "2026-10-14", applied: 1, verified: 1, failed: 0 }, { day: "2026-10-13", applied: 2, verified: 1, failed: 0 }],
      earlier: { imported: { sent: 1, failed: 0 }, archived: { sent: 0, failed: 0 } }
    });
    // The same sends fall on other days in UTC.
    expect((await service.stats("user:a", "UTC")).days.map((day) => [day.day, day.applied])).toEqual([["2026-10-13", 2], ["2026-10-12", 1]]);
    expect(await service.stats("user:b", "UTC")).toMatchObject({ firstDay: null, totals: { applied: 0 }, days: [] });
  });

  it("asks the operator instead of answering from an unrelated memory, and leaves a trace when memory answers", async () => {
    const { service } = await serviceFixture();
    await service.rememberMemory("user:a", { kind: "ANSWER", key: "what are your pronouns", text: "Prefer not to say", source: "USER" });
    const { application } = await service.createApplication("user:a", { url: "https://boards.greenhouse.io/acme/jobs/41", company: "Acme", role: "Dev", ats: "greenhouse", status: "QUEUED" });
    await service.updateApplication("user:a", application.id, { status: "FILLING" });
    // The full-text search finds the pronouns answer for this question; it must not be used.
    expect(await service.answerFor("user:a", "What is your language proficiency in German?")).toBeNull();
    const german = await service.askQuestion("user:a", application.id, { question: "What is your language proficiency in German?" });
    expect(german).toMatchObject({ answered: false });
    expect(german.questionId).toMatch(/^jobq:/);
    await service.updateApplication("user:a", application.id, { status: "FILLING" });
    const pronouns = await service.askQuestion("user:a", application.id, { question: "What are your pronouns?" });
    expect(pronouns).toMatchObject({ answered: true, answer: "Prefer not to say", questionId: null });
    const trace = (await service.listEvents("user:a", { applicationId: application.id, limit: 10 })).find((event) => event.type === "NOTE");
    expect(trace).toMatchObject({ message: "Answered from memory: What are your pronouns?", payload: { autoAnswered: true, memoryKey: "what are your pronouns", answer: "Prefer not to say" } });
  });

  it("keeps an open question pending however many other events the pane logs after it", async () => {
    const { service } = await serviceFixture();
    const { application } = await service.createApplication("user:a", { url: "https://boards.greenhouse.io/acme/jobs/51", company: "Acme", role: "Dev", ats: "greenhouse", status: "QUEUED" });
    await service.updateApplication("user:a", application.id, { status: "FILLING" }, { paneId: "pane:jobs0001" });
    const { questionId } = await service.askQuestion("user:a", application.id, { question: "Years of Spring Boot?" }, { paneId: "pane:jobs0001" });
    for (let index = 0; index < 400; index++) await service.logEvent("user:a", { applicationId: application.id, type: "NOTE", message: `step ${index}`, paneId: "pane:jobs0001" });
    expect((await service.pendingItems("user:a", "pane:jobs0001")).map((item) => item.id)).toEqual([questionId]);
    await service.answerQuestion("user:a", application.id, { questionId: questionId!, answer: "5" }, { paneId: "pane:jobs0001" });
    expect(await service.pendingItems("user:a", "pane:jobs0001")).toEqual([]);
  });

  it("starts over without deleting anything: stops runs, closes open postings, archives the rest, refuses a second click", async () => {
    let clock = "2026-10-14T05:00:00.000Z";
    const repository = new InMemoryJobApplyRepository(() => clock);
    const { service } = await serviceFixture(undefined, { repository, now: () => clock });
    const sentEarlier = await repository.createApplication({ ownerUserId: "user:a", paneId: null, company: "Acme", role: "Dev", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/31", status: "QUEUED", notes: null, queuePosition: null });
    await repository.updateApplication("user:a", sentEarlier.id, { status: "VERIFIED", appliedAt: "2026-10-13T10:00:00.000Z" });
    const { application: queued } = await service.createApplication("user:a", { url: "https://boards.greenhouse.io/acme/jobs/32", company: "Acme", role: "Dev", ats: "greenhouse", status: "QUEUED", notes: "limit: wait" });
    const { application: waiting } = await service.createApplication("user:a", { url: "https://jobs.lever.co/initech/33", company: "Initech", role: "SRE", ats: "lever", status: "QUEUED" });
    await service.updateApplication("user:a", waiting.id, { status: "FILLING" });
    await service.askQuestion("user:a", waiting.id, { question: "Notice period?" });
    await repository.createRun({ ownerUserId: "user:a", paneId: "pane:jobs0001", status: "RUNNING" });
    expect(await service.pendingItems("user:a", null)).toHaveLength(1);

    clock = "2026-10-14T06:00:00.000Z";
    await expect(service.resetCampaign("user:a", { expectedCampaignStartedAt: "2026-10-01T00:00:00.000Z" })).rejects.toThrow(/already reset/);
    const reset = await service.resetCampaign("user:a", { expectedCampaignStartedAt: null });
    expect(reset).toEqual({ campaignStartedAt: "2026-10-14T06:00:00.000Z", closed: 2, runsStopped: 1 });
    // A repeated click with the old expectation changes nothing.
    await expect(service.resetCampaign("user:a", { expectedCampaignStartedAt: null })).rejects.toThrow(/already reset/);
    expect(await repository.listActiveRuns("user:a")).toEqual([]);
    const rows = await service.listApplications("user:a", { limit: 10 });
    expect(rows.find((row) => row.id === queued.id)).toMatchObject({ status: "FAILED", notes: "limit: wait | Closed by reset on 2026-10-14" });
    expect(rows.find((row) => row.id === waiting.id)).toMatchObject({ status: "FAILED", notes: "Notice period? | Closed by reset on 2026-10-14" });
    expect(rows.find((row) => row.id === sentEarlier.id)?.status).toBe("VERIFIED");
    expect(await service.pendingItems("user:a", null)).toEqual([]);
    expect((await service.getProfile("user:a")).campaignStartedAt).toBe("2026-10-14T06:00:00.000Z");
    expect(await service.stats("user:a", "UTC")).toMatchObject({ firstDay: "2026-10-14", totals: { applied: 0, verified: 0 }, earlier: { archived: { sent: 1, failed: 2 } } });
    // Archived postings still guard against applying twice; closed ones can be queued again.
    expect((await service.createApplication("user:a", { url: "https://boards.greenhouse.io/acme/jobs/31", company: "Acme", role: "Dev", ats: "greenhouse", status: "QUEUED" })).created).toBe(false);
    expect((await service.updateApplication("user:a", queued.id, { status: "QUEUED" })).status).toBe("QUEUED");
  });

  it("dates an application by its send, not by a later verification, and a new send after a failure by the new send", async () => {
    let clock = "2026-10-13T10:00:00.000Z";
    const repository = new InMemoryJobApplyRepository();
    const { service } = await serviceFixture(undefined, { repository, now: () => clock });
    const field = [{ stepIndex: 0, stepTitle: null, label: "Full name", fieldType: "text" as const, refHint: null, value: "N", source: "PROFILE" as const, verifiedAt: null }];
    const sent = async (url: string) => {
      const { application } = await service.createApplication("user:a", { url, company: "Acme", role: "Dev", ats: "greenhouse", status: "QUEUED" });
      await service.updateApplication("user:a", application.id, { status: "FILLING" });
      await repository.upsertFields("user:a", application.id, field, clock);
      return service.updateApplication("user:a", application.id, { status: "SUBMITTED" });
    };
    const verifiedLater = await sent("https://boards.greenhouse.io/acme/jobs/7");
    const resent = await sent("https://boards.greenhouse.io/acme/jobs/8");
    clock = "2026-10-14T09:00:00.000Z";
    expect((await service.updateApplication("user:a", verifiedLater.id, { status: "VERIFIED", externalConfirmation: "confirmation email" })).appliedAt).toBe("2026-10-13T10:00:00.000Z");
    await service.updateApplication("user:a", resent.id, { status: "FAILED" });
    await service.updateApplication("user:a", resent.id, { status: "QUEUED" });
    await service.updateApplication("user:a", resent.id, { status: "FILLING" });
    expect((await service.updateApplication("user:a", resent.id, { status: "SUBMITTED" })).appliedAt).toBe("2026-10-14T09:00:00.000Z");
  });

  it("adds pasted URLs to the queue, reorders it and removes only queued rows", async () => {
    const { service } = await serviceFixture();
    const added = await service.addToQueue("user:a", "pane:jobs0001", ["https://boards.greenhouse.io/acme/jobs/1", "not a url", "https://jobs.ashbyhq.com/globex/2", "https://boards.greenhouse.io/acme/jobs/1"]);
    expect(added.queued.map((row) => [row.company, row.queuePosition])).toEqual([["Acme", 0], ["Globex", 1]]);
    expect(added).toMatchObject({ existing: 1, rejected: ["not a url"] });
    const [acme, globex] = added.queued;
    const reordered = await service.reorderQueue("user:a", [globex!.id, acme!.id]);
    expect(reordered.map((row) => row.company)).toEqual(["Globex", "Acme"]);
    await service.updateApplication("user:a", globex!.id, { status: "FILLING" });
    await expect(service.removeFromQueue("user:a", globex!.id)).rejects.toThrow(/Only queued/);
    await service.removeFromQueue("user:a", acme!.id);
    expect(await service.listQueue("user:a", "pane:jobs0001")).toEqual([]);
    await expect(service.removeFromQueue("user:a", acme!.id)).rejects.toThrow(/not found/);
    const requeued = await service.updateApplication("user:a", globex!.id, { status: "FAILED" });
    expect(requeued.queuePosition).toBeNull();
    expect((await service.updateApplication("user:a", globex!.id, { status: "QUEUED" })).queuePosition).toBe(0);
  });
});

describe("job apply routes", () => {
  async function authedApp() {
    const root = await mkdtemp(join(tmpdir(), "space-job-apply-api-"));
    temporaryRoots.push(root);
    const store = new InMemorySpaceStore();
    // The dedicated connector key file (hardening step 9), synthetic.
    await writeFile(join(root, "connector.key"), "synthetic-connector-key-with-enough-length-0123456789\n");
    const app = await createApp({
      store,
      config: { ...getApiConfig({ SPACE_ARTIFACT_ROOT: root }), jobApplyRoot: join(root, "job-apply"), connectorKeyFile: join(root, "connector.key") },
      jobApplyMailboxes: fakeMailboxes([{ from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", source: greenhouseMail }]),
      auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
    return { app, store, cookie, csrfToken: csrf.json().csrfToken as string };
  }

  it("resets only with the explicit confirmation and records it in the audit log", async () => {
    const { app, store, cookie, csrfToken } = await authedApp();
    try {
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      expect((await app.inject({ method: "POST", url: "/api/job-apply/reset", payload: { confirm: "RESET", expectedCampaignStartedAt: null } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/job-apply/reset", headers, payload: { expectedCampaignStartedAt: null } })).statusCode).toBe(422);
      const reset = await app.inject({ method: "POST", url: "/api/job-apply/reset", headers, payload: { confirm: "RESET", expectedCampaignStartedAt: null } });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().reset).toMatchObject({ closed: 0, runsStopped: 0 });
      expect((await app.inject({ method: "POST", url: "/api/job-apply/reset", headers, payload: { confirm: "RESET", expectedCampaignStartedAt: null } })).statusCode).toBe(409);
      const profile = (await app.inject({ method: "GET", url: "/api/job-apply/profile", headers })).json().profile;
      expect(profile.campaignStartedAt).toBe(reset.json().reset.campaignStartedAt);
      expect((await store.listAuditEvents()).some((event) => event.action === "job_apply.campaign.reset")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("serves the stats in the requested zone and refuses an unknown zone", async () => {
    const { app, cookie, csrfToken } = await authedApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/job-apply/stats?tz=UTC" })).statusCode).toBe(401);
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      const stats = await app.inject({ method: "GET", url: "/api/job-apply/stats?tz=Asia%2FBangkok", headers });
      expect(stats.statusCode).toBe(200);
      expect(stats.json().stats).toMatchObject({ firstDay: null, totals: { applied: 0, verified: 0 }, days: [] });
      expect((await app.inject({ method: "GET", url: "/api/job-apply/stats?tz=Mars%2FOlympus", headers })).statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("requires a session, keeps the password out of responses, and persists pane settings", async () => {
    const { app, store, cookie, csrfToken } = await authedApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/job-apply/profile" })).statusCode).toBe(401);
      const headers = { cookie, [csrfHeaderName]: csrfToken };
      const empty = await app.inject({ method: "GET", url: "/api/job-apply/profile", headers });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().profile).toMatchObject({ mailbox: null, cvArtifactId: null, qaBank: [] });

      const patched = await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers,
        payload: { candidate: { fullName: "Nikolaos Theodoropoulos", skills: ["Node.js"], needsSponsorship: true }, qaBank: [{ question: "Years of Node.js?", answer: "8", source: "USER", updatedAt: "2026-10-12T00:00:00.000Z" }] } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().profile.candidate).toMatchObject({ fullName: "Nikolaos Theodoropoulos", skills: ["Node.js"], needsSponsorship: true });
      expect((await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { password: "x" } } })).statusCode).toBe(422);

      const mailbox = await app.inject({ method: "PUT", url: "/api/job-apply/mailbox", headers,
        payload: { host: "imap.gmail.com", port: 993, secure: true, user: "me@gmail.com", password: "app-password" } });
      expect(mailbox.statusCode).toBe(200);
      expect(mailbox.body).not.toContain("app-password");
      expect(mailbox.json().profile.mailbox).toEqual({ host: "imap.gmail.com", port: 993, secure: true, user: "me@gmail.com" });
      const test = await app.inject({ method: "POST", url: "/api/job-apply/mailbox/test", headers });
      expect(test.statusCode).toBe(200);
      expect(test.json()).toMatchObject({ ok: true });
      expect(test.body).not.toContain("app-password");

      const created = await app.inject({ method: "POST", url: "/api/job-apply/applications", headers,
        payload: { company: "Acme", role: "Backend", ats: "ashby", url: "https://jobs.ashbyhq.com/acme/1" } });
      expect(created.statusCode).toBe(201);
      const id = created.json().application.id as string;
      expect((await app.inject({ method: "PATCH", url: `/api/job-apply/applications/${id}`, headers, payload: { status: "VERIFIED" } })).statusCode).toBe(409);
      const listed = await app.inject({ method: "GET", url: "/api/job-apply/applications?status=QUEUED", headers });
      expect(listed.json().applications).toHaveLength(1);
      const imported = await app.inject({ method: "POST", url: "/api/job-apply/applications/import-csv", headers,
        payload: { csv: "id,company,board,role,geo,source,status,applied_date,notes\nT1,Quora,gh,DevOps,HK,greenhouse,applied,2026-08-07,verified" } });
      expect(imported.json()).toEqual({ imported: 1, skipped: 0, duplicates: 0 });

      const room = store.createRoom({ name: "Jobs", initialPaneCount: 0 });
      const pane = store.createPane({ roomId: room.id, title: "Job Applications", mode: "JOB_APPLY", terminalRuntimeId: "cli:opencode" });
      const defaults = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/job-apply/settings`, headers });
      expect(defaults.json().metadata.settings).toMatchObject({ submitMode: "AUTO", paused: false });
      const saved = await app.inject({ method: "PUT", url: `/api/panes/${encodeURIComponent(pane.id)}/job-apply/settings`, headers,
        payload: { version: 1, settings: { paused: true, dailyCaps: { linkedin: 10 } } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().metadata.settings).toMatchObject({ paused: true, dailyCaps: expect.objectContaining({ linkedin: 10, greenhouse: 60 }) });
      expect(store.getPane(pane.id).jobApplyMetadata?.settings.paused).toBe(true);
      const terminal = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      expect((await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(terminal.id)}/job-apply/settings`, headers })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});

describe("job copilot discovery", () => {
  it("scans public boards, filters titles, dedupes against the tracker and remembered board tokens", async () => {
    const { service: base } = await serviceFixture();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
        return new Response(JSON.stringify({ jobs: [
          { id: 1, title: "Senior Backend Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/1", location: { name: "Remote - EU" }, updated_at: "2026-10-10T00:00:00Z" },
          { id: 2, title: "Account Development Representative", absolute_url: "https://boards.greenhouse.io/acme/jobs/2", location: { name: "Athens" } }
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("api.lever.co/v0/postings/globex")) {
        return new Response(JSON.stringify([{ id: "a", text: "Backend Engineer (Platform)", hostedUrl: "https://jobs.lever.co/globex/a", categories: { location: "Berlin" }, workplaceType: "remote", createdAt: 1760000000000 }]), { status: 200 });
      }
      if (url.includes("api.ashbyhq.com/posting-api/job-board/initech")) {
        return new Response(JSON.stringify({ jobs: [{ title: "Staff Backend Engineer", jobUrl: "https://jobs.ashbyhq.com/initech/x", location: "London", isRemote: false, publishedAt: "2026-10-11T00:00:00Z" }] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const service = createJobApplyService({ ...base.options, discovery: createDiscovery({ fetchImpl, timeoutMs: 2000 }) });
    await service.createApplication("user:a", { company: "Globex", role: "Backend", ats: "lever", url: "https://jobs.lever.co/globex/a" });
    await service.rememberMemory("user:a", { kind: "SITE", text: "ashby:initech", tags: ["board-token"], source: "AGENT" });
    const result = await service.discover("user:a", { query: "backend engineer", tokens: ["acme", "globex", "nothere"], sites: ["greenhouse", "lever", "ashby"], limit: 50 });
    expect(result.postings.map((posting) => [posting.company, posting.role, posting.remote, posting.tracked])).toEqual([
      ["Initech", "Staff Backend Engineer", false, false],
      ["Acme", "Senior Backend Engineer", true, false],
      ["Globex", "Backend Engineer (Platform)", true, true]
    ]);
    expect(result.scanned.filter((entry) => entry.error === "no board").map((entry) => `${entry.ats}:${entry.board}`).sort()).toEqual(["ashby:acme", "ashby:globex", "ashby:nothere", "greenhouse:globex", "greenhouse:nothere", "lever:acme", "lever:nothere"]);
    expect(result.scanned.filter((entry) => entry.error === null).map((entry) => `${entry.ats}:${entry.board}`).sort()).toEqual(["ashby:initech", "greenhouse:acme", "lever:globex"]);
    expect(result.truncated).toBe(false);
    expect(calls.some((url) => url.includes("job-board/initech"))).toBe(true);
    const remoteOnly = await service.discover("user:a", { query: "backend", tokens: ["acme", "globex"], sites: ["greenhouse", "lever"], remote: true, limit: 10 });
    expect(remoteOnly.postings.map((posting) => posting.company)).toEqual(["Acme", "Globex"]);
    expect(parseBoardPayload("greenhouse", "acme", { jobs: [{ title: "x" }] })).toEqual([]);
    expect(matchesQuery({ url: "https://x", ats: "lever", board: "b", company: "B", role: "Backend Engineer", location: "Athens, Greece", remote: null, postedAt: null }, { query: "engineer", location: "greece" })).toBe(true);
    expect(matchesQuery({ url: "https://x", ats: "lever", board: "b", company: "B", role: "Backend Engineer", location: "Athens, Greece", remote: null, postedAt: null }, { query: "frontend" })).toBe(false);
  });
});
