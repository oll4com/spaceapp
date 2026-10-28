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
import { classifyApplicationMail, digestQuery, hasReceiptSubject, isApplicationMail, isJobDigest, isJobReceipt, triageQueries } from "../src/job-apply/mail-triage.js";
import type { JobApplyGoogleAccess } from "../src/job-apply/service.js";
import { htmlToText } from "../src/mail-html-text.js";
import { createGmailClient } from "../src/mail-copilot/gmail-client.js";

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
    ["unknown", "talent@acme.com", "Quick question", "Could you tell us your current notice period?", 30, "OTHER"],
    // Seen 2026-10-27 in Job Applications/Action needed (operator: only tests and interviews belong there).
    ["receipt promising an interview if there is a fit (Primer)", "Primer <no-reply@ashbyhq.com>", "Thank you for your application for Senior Software Engineer, Full Stack", "We will review your application promptly and let you know whether there is a good fit for both of us here. If we think there's an overlap in what we're looking for in the role and your skillset, we'll reach out to schedule an interview.", 30, "CONFIRMATION"],
    ["receipt listing next steps (Lambda)", "Lambda <no-reply@ashbyhq.com>", "Thank you for applying to Lambda!", "Thanks for applying to Lambda! We've received your application and appreciate your interest in joining our team! Next steps: - Our team will review your application - We'll contact you if we need any additional information or to schedule an interview - We strive to keep every candidate informed throughout the process.", 30, "CONFIRMATION"],
    ["candidate experience survey (Neo4j)", "Neo4j <feedback@invites.starred.com>", "Your experience at Neo4j", "At Neo4j we aim at providing a great candidate experience. As you recently applied to the Full-Stack Software Engineer - Aura, Instances role, we'd appreciate you letting us know how it went.", 30, "OTHER"],
    ["receipt promising an initial interview (Alloy)", "Alloy <no-reply@ashbyhq.com>", "Thank you for applying to Alloy", "Your application has been received and someone from our team will review it soon - we will reach out to set up an initial interview if your background is a match.", 30, "CONFIRMATION"],
    ["assessment invitation (Agoda)", "Agoda <careers@agoda.com>", "[Due 7 days] Your HackerRank Agoda's Technical Assessment (Back End) - Software Engineering Invitation", "Hi Nikolaos, You have been invited to attend the challenge. Please complete it within 7 days.", 30, "ACTION_NEEDED"],
    ["take-home interview (Ewa)", "Ewa <hiring@ewa.example>", "Next round", "Thanks for your interest. This round is a voice-to-voice, take-home interview.", 30, "ACTION_NEEDED"],
    ["conditional ask that is a real invite", "talent@acme.com", "Thanks for your interest in Acme", "Thank you for your interest in Acme. If you're still interested, please pick a time for a 30-minute interview below.", 30, "ACTION_NEEDED"],
    ["asks that are neither a test nor an interview", "talent@acme.com", "Your offer", "Please reply with your start date. The offer letter expires on Friday; a background check follows.", 30, "OTHER"],
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
    expect(triageQueries(["Acme Robotics"])).toEqual([expect.stringMatching(/^in:inbox newer_than:14d \{.*from:codesignal\.com.*subject:"thank you for applying".*\}$/),
      "in:inbox newer_than:14d {from:acme}"]);
  });

  // Seen 2026-10-27: ntheogr's inbox kept ~90 receipts since 21/10 because only ATS senders and the 60 newest companies were searched.
  it("searches receipt subjects and every tracked company, split within the query length", () => {
    const companies = Array.from({ length: 400 }, (_, index) => `Company${index} Inc`);
    const queries = triageQueries(companies);
    expect(queries[0]).toContain('subject:"we\'ve got it"');
    expect(queries.length).toBeGreaterThan(2);
    for (const query of queries) expect(query.length).toBeLessThan(1450);
    for (const company of companies) expect(queries.some((query) => query.includes(`from:${company.split(" ")[0]!.toLowerCase()} `) || query.includes(`from:${company.split(" ")[0]!.toLowerCase()}}`))).toBe(true);
  });

  it.each([
    ["Datadog <no-reply@datadoghq.com>", "Thank you for applying to Datadog", "Thanks for applying for the Software Engineer role. We will review your application.", "CONFIRMATION"],
    ["xAI <careers@x.ai>", "Thank you for applying to SpaceXAI", "We have received your application for the Backend Engineer position.", "CONFIRMATION"],
    ["IMC <noreply@imc.com>", "We've got it! Your application for Software Engineer", "Our recruiting team will look at your application.", "CONFIRMATION"],
    ["Constructor <jobs@constructor.io>", "We've Received Your Application", "Thank you for your interest in the Frontend Engineer role.", "CONFIRMATION"],
    ["Zscaler <talent@zscaler.com>", "Thank you for your application to Zscaler!", "Your application for the Staff Engineer position has been received.", "CONFIRMATION"],
    ["Justworks <careers@justworks.com>", "Job Application Status", "Thank you for applying. We have decided to move forward with other candidates.", "REJECTION"],
    ["Riot Games <noreply@riotgames.com>", "Important information about your application", "Your candidacy for the Software Engineer role is under review.", "OTHER"]
  ] as const)("finds and files a receipt from the company's own domain: %s", (from, subject, text, expected) => {
    expect(isApplicationMail({ from, subject }, [])).toBe(false);
    expect(hasReceiptSubject({ from, subject })).toBe(true);
    expect(isJobReceipt({ from, subject, text })).toBe(true);
    expect(classifyApplicationMail({ from, subject, text, receivedAt: null }, Date.now())).toBe(expected);
  });

  it("leaves receipt-like mail that is not about a job alone", () => {
    expect(isJobReceipt({ from: "Bank <noreply@bank.example>", subject: "Your application is approved", text: "Your credit card application is approved. Your card arrives in 5 days." })).toBe(false);
    expect(hasReceiptSubject({ from: "Shop <deals@shop.example>", subject: "Big sale" })).toBe(false);
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
    expect(labels).toEqual({ CONFIRMATION: "L-Job Applications/Confirmations", REJECTION: "L-Job Applications/Rejections", ACTION_NEEDED: "L-Job Applications/Action needed", OTHER: "L-Job Applications/Other" });
    expect(calls.filter((call) => call.method === "POST").map((call) => (call.body as { name: string }).name))
      .toEqual(["Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed", "Job Applications/Other"]);
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
    // Job Copilot's mail search (the Google connector) and Mail Copilot's client tell a rate limit apart from a missing grant too.
    const rateLimit = { message: "User-rate limit exceeded.", errors: [{ reason: "userRateLimitExceeded" }] };
    await expect(createGoogleConnector({ clientId: "c", fetchImpl: failing(403, rateLimit) }).searchMail("t", "", 3))
      .rejects.toThrow("Gmail search failed (403): User-rate limit exceeded.");
    const limited = failing(403, rateLimit);
    await expect(createGmailClient({ accessToken: "t", fetchImpl: limited, retryDelayMs: 0 }).profile()).rejects.toThrow(/rate limit reached/);
    expect(limited).toHaveBeenCalledTimes(4);
    await expect(createGmailClient({ accessToken: "t", fetchImpl: failing(403, { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] }) }).profile())
      .rejects.toThrow(/needs full Gmail access/);
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
function fakeGmail(messages: Array<{ id: string; from: string; subject: string; minutesAgo: number; plain?: string; html?: string; threadId?: string }>) {
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
    if (url.searchParams.get("format") === "metadata") return Response.json({ id: message.id, threadId: message.threadId ?? message.id, labelIds: message.labelIds, internalDate, snippet: (message.plain ?? "").slice(0, 100), payload: { headers } });
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
  return { app, store, pane, owner: room.ownerUserId as string, headers, agent: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" } };
}

describe("job copilot mail triage", () => {
  it("gives a test invitation without a deadline the one its recruiter's mail of the same minute states", async () => {
    const gmail = fakeGmail([
      { id: "m-recruiter", from: "Sam <sam@acme-recruiting.example>", subject: "Your Acme interview journey starts here", minutesAgo: 30, plain: "Look for an email from HackerRank Chakra, please complete it within: 7 days" },
      { id: "m-invite", from: "Acme Hiring Team <support@hackerrankforwork.com>", subject: "Acme Frontend Engineer - React Assessment", minutesAgo: 30, plain: "You have been invited to take the test. Interview Duration: 65 minutes" }]);
    const capabilities: ConnectorCapability[] = ["MAIL_READ", "MAIL_ORGANIZE"];
    const google: JobApplyGoogleAccess = {
      googleConfigured: true,
      async googleAccounts() { return [{ email: "me@gmail.com", capabilities }]; },
      async googleCapabilities() { return capabilities; },
      async googleAccessToken() { return "gmail-token"; },
      async tool() { return { status: "COMPLETED", result: {} }; }
    };
    const { app, store, owner, headers, agent } = await fixture(google, gmail.fetchImpl);
    try {
      expect((await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "me@gmail.com" } })).statusCode).toBe(200);
      const tracked = (await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: { company: "Acme", role: "Engineer", ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/1" } })).json().application as { id: string };
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${encodeURIComponent(tracked.id)}`, headers: agent, payload: { status: "FILLING" } });
      const pass = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(pass.json()).toMatchObject({ scanned: 2, actionNeeded: 1, other: 1 });
      const [task, ...others] = (await store.listTaskItems(owner, { page: 1, pageSize: 25 })).items;
      expect(others).toEqual([]);
      expect(task!.objective).toContain("Gmail thread: m-invite (me@gmail.com)");
      expect(task!.objective).toContain("Deadline stated in: Sam <sam@acme-recruiting.example> (thread m-recruiter)");
      const due = Date.parse(/^Deadline: (\S+)/m.exec(task!.objective)![1]!);
      expect(Math.abs(due - (Date.now() - 30 * 60_000 + 7 * 86_400_000))).toBeLessThan(60_000);
    } finally {
      await app.close();
    }
  });

  it("clears a backlog of receipts from companies' own domains in one pass and leaves mail that is not about a job", async () => {
    const receipts = Array.from({ length: 40 }, (_, index) => ({ id: `m-r${index}`, from: `Company${index} <careers@company${index}.example>`, subject: `Thank you for applying to Company${index}`,
      minutesAgo: 60 + index, plain: `We received your application for the Software Engineer role at Company${index}.` }));
    const gmail = fakeGmail([...receipts,
      { id: "m-code", from: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme", minutesAgo: 180, plain: "Paste this code: AB12cd34" },
      { id: "m-bank", from: "Bank <noreply@bank.example>", subject: "Your application is approved", minutesAgo: 30, plain: "Your credit card application is approved." }]);
    const capabilities: ConnectorCapability[] = ["MAIL_READ", "MAIL_ORGANIZE"];
    const google: JobApplyGoogleAccess = {
      googleConfigured: true,
      async googleAccounts() { return [{ email: "me@gmail.com", capabilities }]; },
      async googleCapabilities() { return capabilities; },
      async googleAccessToken() { return "gmail-token"; },
      async tool() { return { status: "COMPLETED", result: {} }; }
    };
    const { app, headers, agent } = await fixture(google, gmail.fetchImpl);
    try {
      expect((await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "me@gmail.com" } })).statusCode).toBe(200);
      const pass = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(pass.json()).toEqual({ accounts: ["me@gmail.com"], scanned: 41, confirmations: 41, rejections: 0, actionNeeded: 0, other: 0, skipped: 0, digests: 0 });
      const confirmations = gmail.labels.find((entry) => entry.name === "Job Applications/Confirmations")!.id;
      for (const id of [...receipts.map((receipt) => receipt.id), "m-code"]) expect(gmail.state.get(id)!.labelIds).toEqual([confirmations]);
      expect(gmail.state.get("m-bank")!.labelIds).toEqual(["INBOX"]);
    } finally {
      await app.close();
    }
  });

  it("files application mail once: receipts, stale codes and rejections archived, test and interview requests kept and announced, other mail kept quietly", async () => {
    const gmail = fakeGmail([
      { id: "m-receipt", from: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Thank you for applying to Acme", minutesAgo: 90, plain: "Your application has been received." },
      { id: "m-old-code", from: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme", minutesAgo: 180, plain: "Paste this code: AB12cd34" },
      { id: "m-new-code", from: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Acme", minutesAgo: 5, plain: "Paste this code: ZZ12cd34" },
      { id: "m-reject", from: "Acme Recruiting <recruiting@acme.com>", subject: "Your application to Acme", minutesAgo: 60, plain: "Unfortunately, we will not be moving forward." },
      // Newest first, as Gmail lists them: the "completed" mail closes the thread's test task the invitation opens.
      { id: "m-done", threadId: "t-ramp", from: "CodeSignal <no-reply@codesignal.com>", subject: "Ramp Frontend Challenge completed", minutesAgo: 15, plain: "Thank you for completing the Ramp Frontend Challenge assessment." },
      { id: "m-codesignal", threadId: "t-ramp", from: "CodeSignal <no-reply@codesignal.com>", subject: "Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal", minutesAgo: 40, html: codeSignalHtml },
      { id: "m-interview", from: "Acme <no-reply@ashbyhq.com>", subject: "Interview with Acme", minutesAgo: 20, plain: "Please select a time for your interview." },
      { id: "m-survey", from: "Acme Talent <talent@acme.com>", subject: "Your experience at Acme", minutesAgo: 25, plain: "As you recently applied to the Engineer role, we'd appreciate you letting us know how it went." },
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
    const { app, store, pane, owner, headers, agent } = await fixture(google, gmail.fetchImpl);
    const tasks = async () => (await store.listTaskItems(owner, { page: 1, pageSize: 25 })).items.map((task) => `${task.status} ${task.title}`).sort();
    try {
      expect((await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "me@gmail.com" } })).statusCode).toBe(200);
      // An older application of the same company: mail links to the newest one (the oldest won before 2026-10-27).
      const older = (await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: { company: "Acme", role: "Old role", ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/0" } })).json().application as { id: string };
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${encodeURIComponent(older.id)}`, headers: agent, payload: { status: "FILLING" } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: { company: "Acme", role: "Engineer", ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/1" } });
      const application = started.json().application as { id: string };
      await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${encodeURIComponent(application.id)}`, headers: agent, payload: { status: "FILLING" } });

      // Without the organize grant nothing is touched.
      const before = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(before.json()).toEqual({ accounts: [], scanned: 0, confirmations: 0, rejections: 0, actionNeeded: 0, other: 0, skipped: 0, digests: 0 });
      expect(gmail.modifies).toEqual([]);
      const refused = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "CONFIRMATION" } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain("has not allowed organizing mail");

      capabilities.push("MAIL_ORGANIZE");
      const first = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ accounts: ["me@gmail.com"], scanned: 8, confirmations: 3, rejections: 1, actionNeeded: 2, other: 1, skipped: 1, digests: 3 });
      const label = (name: string) => gmail.labels.find((entry) => entry.name === name)!.id;
      expect(gmail.labels.map((entry) => entry.name)).toEqual(["INBOX", "Job Applications", "Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed", "Job Applications/Other"]);
      expect(gmail.state.get("m-receipt")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-old-code")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-done")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-reject")!.labelIds).toEqual([label("Job Applications/Rejections")]);
      expect(gmail.state.get("m-codesignal")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      expect(gmail.state.get("m-interview")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      expect(gmail.state.get("m-survey")!.labelIds).toEqual(["INBOX", label("Job Applications/Other")]);
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX"]);
      // Job-alert digests leave the inbox without a label; LinkedIn News and the shop mail stay.
      for (const id of ["m-alert", "m-hiring", "m-board"]) expect(gmail.state.get(id)!.labelIds).toEqual([]);
      expect(gmail.state.get("m-news")!.labelIds).toEqual(["INBOX"]);

      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string; message: string; applicationId: string | null; payload: Record<string, unknown> }>;
      const mail = events.filter((event) => event.type === "MAIL");
      expect(mail.map((event) => event.message).sort()).toEqual([
        "Action needed: Interview with Acme from Acme. Task: Interview: Interview with Acme, deadline not stated (find the deadline in the mail and record it)",
        // The invitation's October 20 deadline is older than the fake mail's date, so it does not count.
        "Action needed: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal from CodeSignal. Task: Test: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal, deadline not stated (find the deadline in the mail and record it)",
        "Archived 3 confirmations and 1 rejection and 3 job alerts from me@gmail.com under Job Applications",
        "Rejection email from Acme Recruiting: Your application to Acme"
      ]);
      expect(mail.find((event) => event.message.startsWith("Rejection"))!.applicationId).toBe(application.id);
      expect(mail.find((event) => event.message.startsWith("Action needed: Interview"))!.payload).toMatchObject({ category: "ACTION_NEEDED", from: "no-reply@ashbyhq.com", messageId: "m-interview" });
      // One reminder task per test or interview thread, none for the Other mail; the completed test's task is done.
      expect(await tasks()).toEqual(["DONE Test: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal, deadline not stated", "OPEN Interview: Interview with Acme, deadline not stated"]);
      // No mail body is stored in an event.
      expect(JSON.stringify(mail)).not.toContain("Please select a time");

      // A second pass finds nothing new: labelled mail is skipped and the fresh code is still left alone.
      const modifiesBefore = gmail.modifies.length;
      const second = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(second.json()).toEqual({ accounts: ["me@gmail.com"], scanned: 1, confirmations: 0, rejections: 0, actionNeeded: 0, other: 0, skipped: 1, digests: 0 });
      expect(gmail.modifies.length).toBe(modifiesBefore);
      const eventsAfter = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string }>;
      expect(eventsAfter.filter((event) => event.type === "MAIL")).toHaveLength(4);

      // The agent files what the rules missed; action-needed mail stays in the inbox unless archive is true.
      const organized = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "ACTION_NEEDED" } });
      expect(organized.json()).toEqual({ account: "me@gmail.com", category: "ACTION_NEEDED", label: "Job Applications/Action needed", organized: 1, archived: false });
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      // The next pass backfills a task for mail filed as Action needed outside the triage.
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} })).statusCode).toBe(200);
      expect(await tasks()).toContain("OPEN Interview: Big sale, deadline not stated");
      expect((await store.listTaskItems(owner, { page: 1, pageSize: 25 })).items).toHaveLength(3);
      // The copilot records the deadline it read; an unknown thread is a 404.
      const deadline = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/deadline", headers: agent, payload: { threadId: "m-interview", dueAt: "2026-11-03T10:00:00+07:00" } });
      expect(deadline.json()).toMatchObject({ title: "Interview: Interview with Acme, Tue 3 Nov 10:00 GMT+7" });
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/deadline", headers: agent, payload: { threadId: "nope", dueAt: "2026-11-03T10:00:00+07:00" } })).statusCode).toBe(404);
      // Mail filed by mistake loses the Job Applications labels only; the inbox stays as it is.
      const unfiled = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "NONE" } });
      expect(unfiled.json()).toEqual({ account: "me@gmail.com", category: "NONE", label: null, organized: 1, archived: false });
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-other"], removeLabelIds: Object.values({
        c: label("Job Applications/Confirmations"), r: label("Job Applications/Rejections"), a: label("Job Applications/Action needed"), o: label("Job Applications/Other") }) });
      // NONE + archive: plain archive, the Job Applications labels go too.
      const archivedNone = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "NONE", archive: true } });
      expect(archivedNone.json()).toEqual({ account: "me@gmail.com", category: "NONE", label: null, organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-other"], removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections"), label("Job Applications/Action needed"), label("Job Applications/Other")] });
      expect(gmail.state.get("m-other")!.labelIds).toEqual([]);
      // ACTION_NEEDED + archive: the label stays, the inbox goes.
      const archivedAction = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-new-code"], category: "ACTION_NEEDED", archive: true } });
      expect(archivedAction.json()).toEqual({ account: "me@gmail.com", category: "ACTION_NEEDED", label: "Job Applications/Action needed", organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ ids: ["m-new-code"], addLabelIds: [label("Job Applications/Action needed")], removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections"), label("Job Applications/Other")] });
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual([label("Job Applications/Action needed")]);
      const invalid = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "SPAM" } });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
