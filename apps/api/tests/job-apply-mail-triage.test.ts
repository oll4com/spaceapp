import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorCapabilities, connectorCapabilitySchema, type ConnectorCapability } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { createGoogleConnector, messageText } from "../src/dot-connectors.js";
import { ensureJobApplyLabels, gmailErrorMessage, labelGmailMessages, unlabelGmailMessages } from "../src/job-apply/gmail-organize.js";
import { classifyApplicationMail, digestQuery, isApplicationMail, isJobDigest, triageQuery } from "../src/job-apply/mail-triage.js";
import type { JobApplyGoogleAccess } from "../src/job-apply/service.js";
import { htmlToText } from "../src/mail-html-text.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
// CodeSignal invitations carry no text/plain part: the deadline and the link live only in the HTML.
const codeSignalHtml = `<html><head><style>.x{color:red}</style><script>track()</script></head><body><table><tr><td>
<p>Hi Nikolaos,</p><p>Ramp invited you to take the <b>Ramp Frontend Challenge</b> assessment on CodeSignal.</p>
<p>Please complete it by <strong>October 20, 2026 at 11:59&nbsp;PM PDT</strong>.</p>
<a href="https://app.codesignal.com/test/abc123?utm=1">Start assessment</a><br>Questions? &amp; reply to this email.</td></tr></table></body></html>`;

describe("html mail as text", () => {
  it("keeps the words, the deadline and the link of an HTML-only invitation", () => {
    const text = htmlToText(codeSignalHtml);
    expect(text).toContain("Ramp invited you to take the Ramp Frontend Challenge assessment on CodeSignal.");
    expect(text).toContain("Please complete it by October 20, 2026 at 11:59 PM PDT.");
    expect(text).toContain("Start assessment (https://app.codesignal.com/test/abc123?utm=1)");
    expect(text).toContain("Questions? & reply to this email.");
    expect(text).not.toMatch(/color:red|track\(\)|<[a-z]/i);
  });

  it("reads an HTML-only Gmail message as text and says so; plain parts win when present", async () => {
    const htmlOnly = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64(codeSignalHtml) } }] };
    expect(messageText(htmlOnly, 20_000)).toMatchObject({ fromHtml: true });
    const both = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Plain body") } }, { mimeType: "text/html", body: { data: b64("<p>Html</p>") } }] };
    expect(messageText(both, 20_000)).toEqual({ text: "Plain body", fromHtml: false });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "m1", threadId: "t1", payload: { ...htmlOnly,
      headers: [{ name: "From", value: "CodeSignal <no-reply@codesignal.com>" }, { name: "Subject", value: "Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal" }] } }), { status: 200 })) as unknown as typeof fetch;
    const message = await createGoogleConnector({ clientId: "c", fetchImpl }).readMail("token", "m1") as { text: string; textSource?: string };
    expect(message.textSource).toBe("html");
    expect(message.text).toContain("October 20, 2026 at 11:59 PM PDT");
    expect(message.text).toContain("https://app.codesignal.com/test/abc123");
  });
});

describe("mail triage rules", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  it.each([
    ["receipt", "no-reply@us.greenhouse-mail.io", "Thank you for applying to Acme", "Your application has been received. We will reach out about next steps.", 30, "CONFIRMATION"],
    ["ashby receipt", "no-reply@ashbyhq.com", "Thanks for applying to Exa", "We received your application and our team will review it.", 30, "CONFIRMATION"],
    ["stale security code", "no-reply@us.greenhouse-mail.io", "Security code for your application to Acme", "Copy and paste this code: AB12cd34", 120, "CONFIRMATION"],
    ["fresh security code", "no-reply@us.greenhouse-mail.io", "Security code for your application to Acme", "Copy and paste this code: AB12cd34", 10, null],
    ["rejection", "recruiting@acme.com", "Your application to Acme", "Unfortunately, we have decided to move forward with other candidates.", 30, "REJECTION"],
    ["interview invite", "no-reply@ashbyhq.com", "Interview with Acme", "We'd love to talk. Please select a time for your first interview.", 30, "ACTION_NEEDED"],
    ["assessment platform", "no-reply@codesignal.com", "Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal", "", 30, "ACTION_NEEDED"],
    ["receipt asking for a take-home", "no-reply@ashbyhq.com", "Thank you for applying", "Thank you for applying. Please complete the take-home exercise within 5 days.", 30, "ACTION_NEEDED"],
    ["unknown", "talent@acme.com", "Quick question", "Could you tell us your current notice period?", 30, "ACTION_NEEDED"],
    // Seen 2026-10-13 (Browserbase, Replit, Figma receipts): a conditional "not selected" is not a rejection.
    ["receipt with a conditional rejection line", "no-reply@ashbyhq.com", "Thank you for your application to Browserbase", "We received your application for our Software Engineer (Agent Platform) role. Our team will review your application and will be in touch to let you know if your qualifications match our needs.\nIf you're not selected for this position, keep an eye on our jobs page as we're growing and adding openings!", 30, "CONFIRMATION"],
    ["rejection after a conditional line", "no-reply@ashbyhq.com", "Update on your application", "If you have questions, reply to this email. Unfortunately, you have not been selected for the role.", 30, "REJECTION"],
    // Seen 2026-10-14: receipts with a bare "Unfortunately" were filed as rejections (Cohere, Circle).
    ["receipt that cannot answer everyone (Cohere)", "Cohere Talent Team <no-reply@ashbyhq.com>", "Thanks for applying to Cohere!", "Hi Nikolaos, Thank you for applying to the Forward Deployed Engineer, Agentic Platform (ET - Canada/US) role at Cohere! A member of our Talent team will review your application and be in touch if your qualifications match the requirements of the role. Unfortunately, due to the high volume of interest we've been receiving, we aren't able to personally respond to every candidate. Please know that we value your time and interest in Cohere. Beware of Scams: Cohere will never ask for payment or third-party services as part of our hiring process. If jobs are viewed on other sites then please verify these through our careers page.", 30, "CONFIRMATION"],
    ["receipt with a safety note (Circle)", "Circle Talent Team <no-reply@ashbyhq.com>", "Thank you for applying to Circle!", "Hi Nikolaos, Thank you for taking the time to apply for the Lead Engineer, AI Quality with Circle. Our team reviews applications to identify candidates whose experience aligns with what we're looking for. While we aren't able to connect individually with everyone who applies, we'll reach out if we'd like to explore your background further. IMPORTANT NOTE ABOUT CANDIDATE SAFETY: Your safety and trust is important to us. Unfortunately, recruiting fraud is increasingly common in the job market, and bad actors sometimes impersonate companies or employees. If selected to move forward, you may be invited to record a short introductory video, or to participate in a live interview. If you receive a suspicious message claiming to be from Circle, please do not respond. No matter the outcome, we're wishing you all the best in your search.", 30, "CONFIRMATION"],
    ["explicit rejection (StackAdapt)", "no-reply@stackadapt.com", "Your Application for StackAdapt", "Hi Nikos, Thank you for taking the time to apply for the Automation Engineer, Agentic Orchestration position at StackAdapt. After carefully reviewing your application, we regret to inform you that we will not be moving forward with your application at this time.", 30, "REJECTION"],
    ["explicit rejection (Scale AI)", "no-reply@scale.com", "Thank you for your interest with Scale AI", "Hi Nikolaos, Thank you for applying to our Staff Frontier Agents Engineer (Applied AI) role. Unfortunately, after reviewing your work and experience, we've decided not to move forward with your application. While this position is not a match at this time, we'd still love to stay in touch for future opportunities.", 30, "REJECTION"]
  ] as const)("%s", (_name, from, subject, text, minutesAgo, expected) => {
    expect(classifyApplicationMail({ from, subject, text, receivedAt: at(minutesAgo) }, now)).toBe(expected);
  });

  it("knows application senders, assessment services and tracked companies, and nothing else", () => {
    const tracked = [{ company: "Acme Robotics" }];
    expect(isApplicationMail({ from: "CodeSignal <no-reply@codesignal.com>", subject: "x" }, [])).toBe(true);
    expect(isApplicationMail({ from: "Calendly <notifications@calendly.com>", subject: "x" }, [])).toBe(true);
    expect(isApplicationMail({ from: "no-reply@us.greenhouse-mail.io", subject: "x" }, [])).toBe(true);
    expect(isApplicationMail({ from: "Acme Robotics Recruiting <jobs@acmerobotics.com>", subject: "Hello" }, tracked)).toBe(true);
    expect(isApplicationMail({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "New jobs for you" }, tracked)).toBe(false);
    // Seen 2026-10-14/15: LinkedIn digests from jobs-noreply and digests naming a tracked company were filed as Action needed.
    const trackedLinkedIn = [{ company: "Foundation Health" }, { company: "Xero" }, { company: "UCentric" }];
    expect(isApplicationMail({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "New jobs similar to Software Engineer at Foundation Health" }, trackedLinkedIn)).toBe(false);
    expect(isApplicationMail({ from: "LinkedIn <jobs-listings@linkedin.com>", subject: "Xero is hiring in Gen AI" }, trackedLinkedIn)).toBe(false);
    expect(isApplicationMail({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Xero is hiring in Gen AI" }, trackedLinkedIn)).toBe(false);
    expect(isApplicationMail({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Nikolaos, your application was sent to UCentric" }, trackedLinkedIn)).toBe(true);
    expect(isApplicationMail({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Your application was viewed by Foundation Health" }, trackedLinkedIn)).toBe(true);
    // A recruiter's LinkedIn message about a tracked company still counts, as before.
    expect(isApplicationMail({ from: "Jane via LinkedIn <messages-noreply@linkedin.com>", subject: "Jane from Xero sent you a message" }, trackedLinkedIn)).toBe(true);
    expect(isApplicationMail({ from: "deals@shop.example", subject: "Sale" }, tracked)).toBe(false);
    expect(triageQuery(["Acme Robotics"])).toMatch(/^in:inbox newer_than:14d \{.*from:codesignal\.com.*from:acme\}$/);
  });

  it("tells job-alert digests from application and unrelated mail", () => {
    expect(isJobDigest({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "New jobs similar to Software Engineer at Foundation Health" })).toBe(true);
    expect(isJobDigest({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Xero is hiring in Gen AI" })).toBe(true);
    expect(isJobDigest({ from: "LinkedIn <jobs-listings@linkedin.com>", subject: "Software Engineer: Acme and more" })).toBe(true);
    expect(isJobDigest({ from: "JobsDB <noreply@jobsdb.com>", subject: "Job alerts - Bangkok" })).toBe(true);
    expect(isJobDigest({ from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Nikolaos, your application was sent to UCentric" })).toBe(false);
    expect(isJobDigest({ from: "LinkedIn News <news@linkedin.com>", subject: "Top stories this week" })).toBe(false);
    expect(isJobDigest({ from: "CodeSignal <no-reply@codesignal.com>", subject: "Job alert: your assessment expires soon" })).toBe(false);
    expect(isJobDigest({ from: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Thank you for applying to Acme" })).toBe(false);
    expect(isJobDigest({ from: "deals@shop.example", subject: "Big sale" })).toBe(false);
    expect(digestQuery()).toMatch(/^in:inbox newer_than:30d \{from:jobalerts-noreply@linkedin\.com .*subject:"job alerts".*\}$/);
  });
});

describe("gmail organize client", () => {
  it("creates only the missing Job Applications labels and archives with batchModify, never deleting", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url.endsWith("/labels") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "L1", name: "Job Applications" }] }), { status: 200 });
      }
      if (url.endsWith("/labels")) return new Response(JSON.stringify({ id: `L-${(body as { name: string }).name}`, name: (body as { name: string }).name }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const labels = await ensureJobApplyLabels({ accessToken: "t", fetchImpl });
    expect(labels).toEqual({ CONFIRMATION: "L-Job Applications/Confirmations", REJECTION: "L-Job Applications/Rejections", ACTION_NEEDED: "L-Job Applications/Action needed" });
    expect(calls.filter((call) => call.method === "POST").map((call) => (call.body as { name: string }).name))
      .toEqual(["Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed"]);
    await labelGmailMessages({ accessToken: "t", fetchImpl, messageIds: ["m1", "m2"], labelId: "L-c", archive: true });
    await labelGmailMessages({ accessToken: "t", fetchImpl, messageIds: ["m3"], labelId: "L-a", archive: false });
    await labelGmailMessages({ accessToken: "t", fetchImpl, messageIds: [], labelId: "L-a", archive: false });
    // Filing again moves a message: the other category labels go, its own stays.
    await labelGmailMessages({ accessToken: "t", fetchImpl, messageIds: ["m4"], labelId: "L-c", archive: true, replaceLabelIds: ["L-c", "L-r", "L-a"] });
    const modifies = calls.filter((call) => call.url.endsWith("/messages/batchModify"));
    expect(modifies.map((call) => call.body)).toEqual([
      { ids: ["m1", "m2"], addLabelIds: ["L-c"], removeLabelIds: ["INBOX"] },
      { ids: ["m3"], addLabelIds: ["L-a"], removeLabelIds: [] },
      { ids: ["m4"], addLabelIds: ["L-c"], removeLabelIds: ["INBOX", "L-r", "L-a"] }
    ]);
    expect(calls.some((call) => /trash|delete/i.test(call.url) || call.method === "DELETE")).toBe(false);
  });

  it("unlabels with only removeLabelIds (no empty addLabelIds)", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    await unlabelGmailMessages({ accessToken: "t", fetchImpl, messageIds: ["m1"], labelIds: ["L-c", "L-r", "L-a"] });
    expect(bodies).toEqual([{ ids: ["m1"], removeLabelIds: ["L-c", "L-r", "L-a"] }]);
  });

  it("retries a Gmail per-user rate limit (403) once and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls === 1
      ? Response.json({ error: { code: 403, message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 })
      : new Response(null, { status: 204 }))) as unknown as typeof fetch;
    await unlabelGmailMessages({ accessToken: "t", fetchImpl, messageIds: ["m1"], labelIds: ["L-a"], retryDelayMs: 0 });
    expect(calls).toBe(2);
  });

  it("keeps Gmail's own reason in the error text instead of always blaming the grant", async () => {
    const failing = (status: number, error: unknown) => vi.fn(async () => Response.json({ error }, { status })) as unknown as typeof fetch;
    await expect(unlabelGmailMessages({ accessToken: "t", fetchImpl: failing(403, { message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] }), messageIds: ["m1"], labelIds: ["L-a"], retryDelayMs: 0 }))
      .rejects.toThrow(/rate limit reached \(userRateLimitExceeded: User-rate limit exceeded\)/);
    await expect(unlabelGmailMessages({ accessToken: "t", fetchImpl: failing(403, { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] }), messageIds: ["m1"], labelIds: ["L-a"] }))
      .rejects.toThrow(/gmail\.modify permission .*insufficientPermissions: Request had insufficient authentication scopes/);
    expect(gmailErrorMessage(400, { error: { message: "Invalid id value", errors: [{ reason: "invalidArgument" }] } })).toBe("Gmail request failed (400): invalidArgument: Invalid id value.");
    expect(gmailErrorMessage(403, {})).toMatch(/gmail\.modify permission/);
  });

  it("maps gmail.modify to MAIL_ORGANIZE and accepts it in consent requests", () => {
    expect(connectorCapabilities("GOOGLE", ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.readonly"]).sort())
      .toEqual(["MAIL_ORGANIZE", "MAIL_READ"]);
    expect(connectorCapabilitySchema.parse("MAIL_ORGANIZE")).toBe("MAIL_ORGANIZE");
    const url = new URL(createGoogleConnector({ clientId: "c" }).authorizeUrl({ redirectUri: "https://space.test/cb", state: "s", codeChallenge: "x".repeat(43),
      capabilities: ["MAIL_READ", "MAIL_ORGANIZE"] }));
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");
  });
});

// A small Gmail: labels, messages with labelIds, metadata, full payloads and batchModify.
function fakeGmail(messages: Array<{ id: string; from: string; subject: string; minutesAgo: number; plain?: string; html?: string }>) {
  const labels = [{ id: "INBOX", name: "INBOX" }];
  const state = new Map(messages.map((message) => [message.id, { ...message, labelIds: ["INBOX"] }]));
  const modifies: Array<{ ids: string[]; addLabelIds: string[]; removeLabelIds: string[] }> = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/labels" && (init?.method ?? "GET") === "GET") return Response.json({ labels });
    if (path === "/labels") { const label = { id: `Label_${labels.length}`, name: body.name as string }; labels.push(label); return Response.json(label); }
    if (path === "/messages/batchModify") {
      modifies.push(body);
      for (const id of body.ids as string[]) {
        const message = state.get(id)!;
        message.labelIds = [...message.labelIds.filter((label) => !(body.removeLabelIds as string[]).includes(label)), ...((body.addLabelIds ?? []) as string[])];
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/messages") {
      const inbox = url.searchParams.get("q")?.includes("in:inbox") ?? false;
      return Response.json({ messages: [...state.values()].filter((message) => !inbox || message.labelIds.includes("INBOX")).map((message) => ({ id: message.id })) });
    }
    const message = state.get(decodeURIComponent(path.replace("/messages/", "")))!;
    const headers = [{ name: "From", value: message.from }, { name: "Subject", value: message.subject }];
    const internalDate = String(Date.now() - message.minutesAgo * 60_000);
    if (url.searchParams.get("format") === "metadata") return Response.json({ id: message.id, labelIds: message.labelIds, internalDate, snippet: (message.plain ?? "").slice(0, 100), payload: { headers } });
    const parts = message.html ? [{ mimeType: "text/html", body: { data: b64(message.html) } }] : [{ mimeType: "text/plain", body: { data: b64(message.plain ?? "") } }];
    return Response.json({ id: message.id, internalDate, payload: { mimeType: "multipart/alternative", headers, parts } });
  }) as unknown as typeof fetch;
  return { fetchImpl, state, modifies, labels };
}

async function fixture(google: JobApplyGoogleAccess, gmailFetch: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "space-job-apply-mail-"));
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
  const app = await createApp({ store, config: { ...config, jobApplyRoot: join(root, "job-apply") }, jobApplyGoogle: google, jobApplyGmailFetch: gmailFetch, jobApplyMailTriage: false,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Jobs", initialPaneCount: 0 } })).json();
  const pane = store.createPane({ roomId: room.id, title: "Job Applications", mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  return { app, pane, headers, agent: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" } };
}

describe("job copilot mail triage", () => {
  it("files application mail once: receipts, stale codes and rejections archived, anything asking for something kept and announced", async () => {
    const gmail = fakeGmail([
      { id: "m-receipt", from: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Thank you for applying to Acme", minutesAgo: 90, plain: "Your application has been received." },
      { id: "m-old-code", from: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme", minutesAgo: 180, plain: "Paste this code: AB12cd34" },
      { id: "m-new-code", from: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme", minutesAgo: 5, plain: "Paste this code: ZZ12cd34" },
      { id: "m-reject", from: "Acme Recruiting <recruiting@acme.com>", subject: "Your application to Acme", minutesAgo: 60, plain: "Unfortunately, we will not be moving forward." },
      { id: "m-codesignal", from: "CodeSignal <no-reply@codesignal.com>", subject: "Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal", minutesAgo: 40, html: codeSignalHtml },
      { id: "m-interview", from: "Acme <no-reply@ashbyhq.com>", subject: "Interview with Acme", minutesAgo: 20, plain: "Please select a time for your interview." },
      { id: "m-other", from: "deals@shop.example", subject: "Big sale", minutesAgo: 10, plain: "50% off" },
      { id: "m-alert", from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "New jobs similar to Software Engineer at Acme", minutesAgo: 30 },
      { id: "m-hiring", from: "LinkedIn <jobs-noreply@linkedin.com>", subject: "Xero is hiring in Gen AI", minutesAgo: 35 },
      { id: "m-board", from: "JobsDB <noreply@jobsdb.com>", subject: "Job alerts - Bangkok", minutesAgo: 45 },
      { id: "m-news", from: "LinkedIn News <news@linkedin.com>", subject: "Top stories this week", minutesAgo: 50 }
    ]);
    const capabilities: ConnectorCapability[] = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"];
    const google: JobApplyGoogleAccess = {
      googleConfigured: true,
      async googleAccounts() { return [{ email: "me@gmail.com", capabilities }]; },
      async googleCapabilities() { return capabilities; },
      async googleAccessToken(_owner, _email, capability) { if (!capabilities.includes(capability)) throw new Error("not allowed"); return "gmail-token"; },
      async tool() { return { status: "COMPLETED", result: {} }; }
    };
    const { app, pane, headers, agent } = await fixture(google, gmail.fetchImpl);
    try {
      expect((await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "me@gmail.com" } })).statusCode).toBe(200);
      const started = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: { company: "Acme", role: "Engineer", ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/1" } });
      const application = started.json().application as { id: string };
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${encodeURIComponent(application.id)}`, headers: agent, payload: { status: "FILLING" } });

      // Without the organize grant nothing is touched.
      const before = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(before.json()).toEqual({ accounts: [], scanned: 0, confirmations: 0, rejections: 0, actionNeeded: 0, skipped: 0, digests: 0 });
      expect(gmail.modifies).toEqual([]);
      const refused = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "CONFIRMATION" } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("has not allowed organizing mail");

      capabilities.push("MAIL_ORGANIZE");
      const first = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ accounts: ["me@gmail.com"], scanned: 6, confirmations: 2, rejections: 1, actionNeeded: 2, skipped: 1, digests: 3 });
      const label = (name: string) => gmail.labels.find((entry) => entry.name === name)!.id;
      expect(gmail.labels.map((entry) => entry.name)).toEqual(["INBOX", "Job Applications", "Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed"]);
      expect(gmail.state.get("m-receipt")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-old-code")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-reject")!.labelIds).toEqual([label("Job Applications/Rejections")]);
      expect(gmail.state.get("m-codesignal")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      expect(gmail.state.get("m-interview")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX"]);
      // Job-alert digests leave the inbox without a label; LinkedIn News and the shop mail stay.
      for (const id of ["m-alert", "m-hiring", "m-board"]) expect(gmail.state.get(id)!.labelIds).toEqual([]);
      expect(gmail.state.get("m-news")!.labelIds).toEqual(["INBOX"]);

      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string; message: string; applicationId: string | null; payload: Record<string, unknown> }>;
      const mail = events.filter((event) => event.type === "MAIL");
      expect(mail.map((event) => event.message).sort()).toEqual([
        "Action needed: Interview with Acme from Acme",
        "Action needed: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal from CodeSignal",
        "Archived 2 confirmations and 1 rejection and 3 job alerts from me@gmail.com under Job Applications",
        "Rejection email from Acme Recruiting: Your application to Acme"
      ]);
      expect(mail.find((event) => event.message.startsWith("Rejection"))!.applicationId).toBe(application.id);
      expect(mail.find((event) => event.message.startsWith("Action needed: Interview"))!.payload).toMatchObject({ category: "ACTION_NEEDED", from: "no-reply@ashbyhq.com", messageId: "m-interview" });
      // No mail body is stored in an event.
      expect(JSON.stringify(mail)).not.toContain("Please select a time");

      // A second pass finds nothing new: labelled mail is skipped and the fresh code is still left alone.
      const modifiesBefore = gmail.modifies.length;
      const second = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(second.json()).toEqual({ accounts: ["me@gmail.com"], scanned: 1, confirmations: 0, rejections: 0, actionNeeded: 0, skipped: 1, digests: 0 });
      expect(gmail.modifies.length).toBe(modifiesBefore);
      const eventsAfter = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string }>;
      expect(eventsAfter.filter((event) => event.type === "MAIL")).toHaveLength(4);

      // The agent files what the rules missed; action-needed mail stays in the inbox unless archive is true.
      const organized = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "ACTION_NEEDED" } });
      expect(organized.json()).toEqual({ account: "me@gmail.com", category: "ACTION_NEEDED", label: "Job Applications/Action needed", organized: 1, archived: false });
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      // Mail filed by mistake loses the Job Applications labels only; the inbox stays as it is.
      const unfiled = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "NONE" } });
      expect(unfiled.json()).toEqual({ account: "me@gmail.com", category: "NONE", label: null, organized: 1, archived: false });
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-other"], removeLabelIds: Object.values({
        c: label("Job Applications/Confirmations"), r: label("Job Applications/Rejections"), a: label("Job Applications/Action needed") }) });
      // NONE + archive: plain archive, the Job Applications labels go too.
      const archivedNone = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "NONE", archive: true } });
      expect(archivedNone.json()).toEqual({ account: "me@gmail.com", category: "NONE", label: null, organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-other"], removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections"), label("Job Applications/Action needed")] });
      expect(gmail.state.get("m-other")!.labelIds).toEqual([]);
      // ACTION_NEEDED + archive: the label stays, the inbox goes.
      const archivedAction = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-new-code"], category: "ACTION_NEEDED", archive: true } });
      expect(archivedAction.json()).toEqual({ account: "me@gmail.com", category: "ACTION_NEEDED", label: "Job Applications/Action needed", organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-new-code"], addLabelIds: [label("Job Applications/Action needed")], removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections")] });
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual([label("Job Applications/Action needed")]);
      const invalid = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "SPAM" } });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
