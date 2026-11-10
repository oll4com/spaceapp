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
import { ensureJobApplyLabels, exclusiveJobLabels, fileGmailThreads, gmailErrorMessage, jobLabelIdsOf, unlabelGmailMessages } from "../src/job-apply/gmail-organize.js";
import { asksAboutAssessment, asksForAction, asksToSchedule, classifyApplicationMail, digestQuery, hasReceiptSubject, isApplicationMail, isJobDigest, isJobReceipt, triageQueries } from "../src/job-apply/mail-triage.js";
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
    ["unknown", "talent@acme.com", "Quick question", "Could you tell us your current notice period?", 30, "NONE"],
    // Seen 2026-10-27 in Job Applications/Action needed (operator: only tests and interviews belong there).
    ["receipt promising an interview if there is a fit (Primer)", "Primer <no-reply@ashbyhq.com>", "Thank you for your application for Senior Software Engineer, Full Stack", "We will review your application promptly and let you know whether there is a good fit for both of us here. If we think there's an overlap in what we're looking for in the role and your skillset, we'll reach out to schedule an interview.", 30, "CONFIRMATION"],
    ["receipt listing next steps (Lambda)", "Lambda <no-reply@ashbyhq.com>", "Thank you for applying to Lambda!", "Thanks for applying to Lambda! We've received your application and appreciate your interest in joining our team! Next steps: - Our team will review your application - We'll contact you if we need any additional information or to schedule an interview - We strive to keep every candidate informed throughout the process.", 30, "CONFIRMATION"],
    ["candidate experience survey (Neo4j)", "Neo4j <feedback@invites.starred.com>", "Your experience at Neo4j", "At Neo4j we aim at providing a great candidate experience. As you recently applied to the Full-Stack Software Engineer - Aura, Instances role, we'd appreciate you letting us know how it went.", 30, "NONE"],
    ["receipt promising an initial interview (Alloy)", "Alloy <no-reply@ashbyhq.com>", "Thank you for applying to Alloy", "Your application has been received and someone from our team will review it soon - we will reach out to set up an initial interview if your background is a match.", 30, "CONFIRMATION"],
    ["assessment invitation (Agoda)", "Agoda <careers@agoda.com>", "[Due 7 days] Your HackerRank Agoda's Technical Assessment (Back End) - Software Engineering Invitation", "Hi Nikolaos, You have been invited to attend the challenge. Please complete it within 7 days.", 30, "ACTION_NEEDED"],
    ["take-home interview (Ewa)", "Ewa <hiring@ewa.example>", "Next round", "Thanks for your interest. This round is a voice-to-voice, take-home interview.", 30, "ACTION_NEEDED"],
    ["conditional ask that is a real invite", "talent@acme.com", "Thanks for your interest in Acme", "Thank you for your interest in Acme. If you're still interested, please pick a time for a 30-minute interview below.", 30, "ACTION_NEEDED"],
    ["asks that are neither a test nor an interview", "talent@acme.com", "Your offer", "Please reply with your start date. The offer letter expires on Friday; a background check follows.", 30, "NONE"],
    // Seen 2026-10-13 (Browserbase, Replit, Figma receipts): a conditional "not selected" is not a rejection.
    ["receipt with a conditional rejection line", "no-reply@ashbyhq.com", "Thank you for your application to Browserbase", "We received your application for our Software Engineer (Agent Platform) role. Our team will review your application and will be in touch to let you know if your qualifications match our needs.\nIf you're not selected for this position, keep an eye on our jobs page as we're growing and adding openings!", 30, "CONFIRMATION"],
    ["rejection after a conditional line", "no-reply@ashbyhq.com", "Update on your application", "If you have questions, reply to this email. Unfortunately, you have not been selected for the role.", 30, "REJECTION"],
    // Seen 2026-10-14: receipts with a bare "Unfortunately" were filed as rejections (Cohere, Circle).
    ["receipt that cannot answer everyone (Cohere)", "Cohere Talent Team <no-reply@ashbyhq.com>", "Thanks for applying to Cohere!", "Hi Nikolaos, Thank you for applying to the Forward Deployed Engineer, Agentic Platform (ET - Canada/US) role at Cohere! A member of our Talent team will review your application and be in touch if your qualifications match the requirements of the role. Unfortunately, due to the high volume of interest we've been receiving, we aren't able to personally respond to every candidate. Please know that we value your time and interest in Cohere. Beware of Scams: Cohere will never ask for payment or third-party services as part of our hiring process. If jobs are viewed on other sites then please verify these through our careers page.", 30, "CONFIRMATION"],
    ["receipt with a safety note (Circle)", "Circle Talent Team <no-reply@ashbyhq.com>", "Thank you for applying to Circle!", "Hi Nikolaos, Thank you for taking the time to apply for the Lead Engineer, AI Quality with Circle. Our team reviews applications to identify candidates whose experience aligns with what we're looking for. While we aren't able to connect individually with everyone who applies, we'll reach out if we'd like to explore your background further. IMPORTANT NOTE ABOUT CANDIDATE SAFETY: Your safety and trust is important to us. Unfortunately, recruiting fraud is increasingly common in the job market, and bad actors sometimes impersonate companies or employees. If selected to move forward, you may be invited to record a short introductory video, or to participate in a live interview. If you receive a suspicious message claiming to be from Circle, please do not respond. No matter the outcome, we're wishing you all the best in your search.", 30, "CONFIRMATION"],
    ["explicit rejection (StackAdapt)", "no-reply@stackadapt.com", "Your Application for StackAdapt", "Hi Nikos, Thank you for taking the time to apply for the Automation Engineer, Agentic Orchestration position at StackAdapt. After carefully reviewing your application, we regret to inform you that we will not be moving forward with your application at this time.", 30, "REJECTION"],
    // Seen 2026-10-28 (OpenTrain AI job alerts filed as tests): an alert gets no label whatever its roles are called.
    ["job alert naming a coding test (OpenTrain, 15:53)", "OpenTrain Alert <alert@opentrain.ai>", "New job: Python Infrastructure Engineer - LLM Training & Agent Tooling [AS-L]", "A new job matches your profile. Please complete a short coding test to qualify for this role. Apply now.", 30, "NONE"],
    ["job alert naming a coding task (OpenTrain, 11:54)", "OpenTrain Alert <alert@opentrain.ai>", "New job: Backend Coding Task and Verifier Specialist", "Backend Coding Task and Verifier Specialist. Please complete the coding challenge when you apply.", 30, "NONE"],
    ["a recruiter's new job opportunity with an interview stays a request", "Sam <sam@acme.example>", "New job opportunity at Acme", "Please select a time for your first interview.", 30, "ACTION_NEEDED"],
    // 31/10 (goal 91e45be1): Lendable's test through Ashby and Criteria made no task.
    ["a cognitive assessment named only in the subject (Lendable via Ashby)", "Lendable <no-reply@ashbyhq.com>", "Cognitive Assessment", "Hi Nikolaos, the next stage is a short cognitive test. The link is below.", 30, "ACTION_NEEDED"],
    ["Criteria's next step (Lendable)", "Lendable via Criteria <no-reply@criteriacorp.com>", "Your next step with Lendable", "Lendable has invited you to the next step of the process.", 30, "ACTION_NEEDED"],
    ["Criteria's test platform", "Criteria <noreply@ondemandassessment.com>", "Lendable", "Click the link to begin.", 30, "ACTION_NEEDED"],
    // 5/11: Flosum's one-way video interview was archived as a receipt ("Thank you for your interest").
    ["Hireflix's video interview (Flosum)", "Flosum via Hireflix <users@hireflix.com>", "Nikolaos, great news! You're moving forward to the next step", "Great news. Thank you for your interest in the Senior Node.js Developer role at Flosum. The next step is a short video interview.", 30, "ACTION_NEEDED"],
    ["explicit rejection (Scale AI)", "no-reply@scale.com", "Thank you for your interest with Scale AI", "Hi Nikolaos, Thank you for applying to our Staff Frontier Agents Engineer (Applied AI) role. Unfortunately, after reviewing your work and experience, we've decided not to move forward with your application. While this position is not a match at this time, we'd still love to stay in touch for future opportunities.", 30, "REJECTION"],
    // 2/11 (operator 3/11 «Είναι τόσο δύσκολο να διαβαστεί ένα email?»): Kraken's rejection was filed as Other.
    ["move ahead with your candidacy (Kraken)", "Kraken <no-reply@kraken.com>", "An update on your application", "Hi Nikolaos, Thank you for your interest in Kraken and for the time you put into your application. After careful consideration, we've decided not to move ahead with your candidacy at this stage. We wish you the best in your search.", 30, "REJECTION"],
    ["not able to proceed with your application", "talent@acme.com", "Your application", "Thank you for applying. We are unable to proceed with your application.", 30, "REJECTION"],
    ["decided to go with another candidate", "talent@acme.com", "Engineer role", "We have decided to go with another candidate for this role.", 30, "REJECTION"],
    ["not the right fit for the role", "talent@acme.com", "Engineer role", "After review, your profile is not the right fit for this role.", 30, "REJECTION"],
    ["no offer", "talent@acme.com", "Engineer role", "Thank you for interviewing with us; we will not be extending an offer.", 30, "REJECTION"],
    ["moving ahead with other applicants", "talent@acme.com", "Engineer role", "We are moving ahead with other applicants whose experience is closer to the role.", 30, "REJECTION"],
    ["a receipt saying what happens if they move ahead stays a receipt", "no-reply@ashbyhq.com", "Thanks for applying to Acme", "Thanks for applying to Acme! If we decide to move ahead with your application, we will reach out. If you are not a match for this role, we will keep your details on file.", 30, "CONFIRMATION"],
    // 3/11, Gmail ntheogr thread 1a19f88ca18c4c1e: filed under Confirmations and archived; the consultant asks the candidate to write to him.
    ["the Human Power BG ask stays in the inbox, never a receipt (3/11)", "Human Power BG <noreply@manatal.com>", "Full-Stack Node.js & React Developer", "Dear Nikolaos Theodoropoulos, Please send a message that you have applied to slavi.slavov@humanpowerbg.com This is to confirm we have received your application for Full-Stack Node.js & React Developer.", 30, "NONE"],
    // 3/11, Gmail thread 1a19fe608e29ac3b: HackerRank's contest badge was filed as a test (Action needed, a task, a notice); 30/10 its sign-up mail.
    ["a contest participant badge is a receipt, not a test (HackerRank Orchestrate, 3/11)", "HackerRank Team <hackers@hackerrank.com>", "Your Orchestrate December’26 participant badge", "HackerRank Hey Alex, You're all set for HackerRank Orchestrate December 2026! We have attached your participant badge. Feel free to share it on your socials and let everyone know you're in.", 30, "CONFIRMATION"],
    ["a contest sign-up is a receipt, not a test (HackerRank Orchestrate, 30/10)", "HackerRank Team <hackers@hackerrank.com>", "You are in! Next Edition of Orchestrate just went live", "Hey Alex, the next edition of HackerRank Orchestrate is live and we have saved your spot. See you on the leaderboard.", 30, "CONFIRMATION"],
    ["a contest mail that asks to start the test stays a request", "HackerRank Team <hackers@hackerrank.com>", "You're all set for Orchestrate", "You're all set! Please start the challenge before 7 December 23:59 UTC: https://www.hackerrank.com/contests/orchestrate", 30, "ACTION_NEEDED"],
    ["a receipt offering help stays a receipt", "no-reply@ashbyhq.com", "Thanks for applying to Acme", "We have received your application for the Engineer role. If you have any questions, please contact us at talent@acme.com.", 30, "CONFIRMATION"]
  ] as const)("%s", (_name, from, subject, text, minutesAgo, expected) => {
    expect(classifyApplicationMail({ from, subject, text, receivedAt: at(minutesAgo) }, now)).toBe(expected);
  });

  it.each([
    ["the WIM/McArthur slot question (2/11)", "Thanks for your interest. Would Wednesday or Thursday at 12:00 noon Bangkok time work for you for a Teams call? Let me know which day suits you best.", true],
    ["Greek availability", "Θα ήθελα να κανονίσουμε μια συνέντευξη. Ποια μέρα σας βολεύει την επόμενη εβδομάδα;", true],
    ["a rejection offering a call", "Unfortunately we will not move forward with your application. Happy to set up a call for feedback if useful?", false],
    ["a receipt saying they will reach out to schedule", "Thanks for applying. We will reach out to schedule an interview if your profile matches.", false],
    ["thanks for applying", "Thank you for applying. We have received your application.", false]
  ] as const)("asksToSchedule: %s", (_name, text, expected) => {
    expect(asksToSchedule(text)).toBe(expected);
  });

  it.each([
    ["the Human Power BG ask (3/11)", "Dear Nikolaos Theodoropoulos, Please send a message that you have applied to slavi.slavov@humanpowerbg.com This is to confirm we have received your application for Full-Stack Node.js & React Developer.", true],
    ["the ArcFusion rejection with advice (3/11)", "Thank you for following up. After careful consideration, we have decided not to move forward with your application. Please keep building hands-on GenAI projects, and please send us your updated CV for future roles.", false],
    ["a rejection that will not move forward", "We will not move forward with your application. Please reply if you want feedback.", false],
    ["a plain receipt", "Thank you for applying. We have received your application and will be in touch.", false]
  ] as const)("asksForAction: %s", (_name, text, expected) => {
    expect(asksForAction(text)).toBe(expected);
  });

  // 5/11 nous_msg:8f84e7e6: Criteria's Eight Sleep test (Event EGH76By2Tw1mSx4v) closed mid-way; the operator asked for a new one.
  const CRITERIA = "Next step in your application with Eight Sleep. Eight Sleep has asked you to take 2 assessments for the Senior Backend Engineer position: the CCAT (5-7 minutes) and a personality questionnaire (about 9 minutes). Click Start now to begin. Event ID: EGH76By2Tw1mSx4v";
  it.each([
    ["the Criteria test of 5/11", CRITERIA, true],
    ["an expired link", "Your link has expired. Request a new one from the hiring team.", true],
    ["a session that closed mid-way", "Your session closed before you finished. Contact support to reopen it.", true],
    ["Greek: the test link expired", "Ο σύνδεσμος για το τεστ έληξε. Παρακαλούμε ζητήστε νέο.", true],
    ["Greek questionnaire", "Συμπληρώστε το ερωτηματολόγιο αξιολόγησης έως την Παρασκευή.", true],
    ["a rejection after the assessment", "Thank you for taking the assessment. Unfortunately we will not move forward with your application.", false],
    ["a finished test", "Thank you for completing the assessment. We will review your results.", false],
    ["a receipt promising a test later", "Thanks for applying. You may be asked to take an assessment later.", false],
    ["thanks for applying", "Thank you for applying. We have received your application.", false]
  ] as const)("asksAboutAssessment: %s", (_name, text, expected) => {
    expect(asksAboutAssessment(text)).toBe(expected);
  });
  it("reads the Criteria mail as no schedule or action ask, which is why a rejection memory refused it before 5/11", () => {
    expect(asksToSchedule(CRITERIA) || asksForAction(CRITERIA)).toBe(false);
  });

  it("gives a List-Unsubscribe mail that reads like a job alert no label; the header alone changes nothing", () => {
    const text = "Python roles this week: Backend Engineer. Please complete the coding challenge to apply. Manage your job alerts.";
    expect(classifyApplicationMail({ from: "Jobs <jobs@board.example>", subject: "Python roles this week", text, receivedAt: null, listUnsubscribe: true }, now)).toBe("NONE");
    expect(classifyApplicationMail({ from: "Jobs <jobs@board.example>", subject: "Python roles this week", text, receivedAt: null }, now)).toBe("ACTION_NEEDED");
    expect(classifyApplicationMail({ from: "Acme Hiring <hiring@acme.example>", subject: "Your interview", text: "Please select a time for your interview.", receivedAt: null, listUnsubscribe: true }, now)).toBe("ACTION_NEEDED");
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
    ["Riot Games <noreply@riotgames.com>", "Important information about your application", "Your candidacy for the Software Engineer role is under review.", "NONE"]
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
  it("creates only the missing Job Applications labels and files whole threads under one of them, never deleting", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url.endsWith("/labels") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ labels: [{ id: "INBOX", name: "INBOX" }, { id: "L1", name: "Job Applications" }, { id: "L-old", name: "Job Applications/Other" }, { id: "L-mine", name: "Job Applications/Someday" }] }), { status: 200 });
      }
      if (url.endsWith("/labels")) return new Response(JSON.stringify({ id: `L-${(body as { name: string }).name}`, name: (body as { name: string }).name }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const labels = await ensureJobApplyLabels({ accessToken: "t", fetchImpl });
    const [c, r, a] = ["L-Job Applications/Confirmations", "L-Job Applications/Rejections", "L-Job Applications/Action needed"];
    expect(labels).toEqual({ ids: { CONFIRMATION: c, REJECTION: r, ACTION_NEEDED: a }, all: ["L-old", "L-mine", c, r, a], legacyOther: "L-old" });
    // No Other label any more (operator 3/11).
    expect(calls.filter((call) => call.method === "POST").map((call) => (call.body as { name: string }).name))
      .toEqual(["Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed"]);
    calls.length = 0;
    await fileGmailThreads({ accessToken: "t", fetchImpl, threadIds: ["t1", "t1", "t2"], labelId: c, archive: true, jobLabelIds: labels.all });
    await fileGmailThreads({ accessToken: "t", fetchImpl, threadIds: ["t3"], labelId: a, archive: false, jobLabelIds: labels.all });
    await fileGmailThreads({ accessToken: "t", fetchImpl, threadIds: ["t4"], labelId: null, archive: false, jobLabelIds: labels.all });
    await fileGmailThreads({ accessToken: "t", fetchImpl, threadIds: [], labelId: a, archive: false, jobLabelIds: labels.all });
    expect(calls.map((call) => [call.url.replace(/^.*\/users\/me/, ""), call.body])).toEqual([
      ["/threads/t1/modify", { addLabelIds: [c], removeLabelIds: ["INBOX", "L-old", "L-mine", r, a] }],
      ["/threads/t2/modify", { addLabelIds: [c], removeLabelIds: ["INBOX", "L-old", "L-mine", r, a] }],
      ["/threads/t3/modify", { addLabelIds: [a], removeLabelIds: ["L-old", "L-mine", c, r] }],
      ["/threads/t4/modify", { removeLabelIds: ["L-old", "L-mine", c, r, a] }]
    ]);
    expect(calls.some((call) => /trash|delete/i.test(call.url) || call.method === "DELETE")).toBe(false);
  });

  it("keeps one Job Applications label in any change and leaves other labels alone", () => {
    expect(jobLabelIdsOf([{ id: "A", name: "Job Applications" }, { id: "B", name: "job applications/Other" }, { id: "C", name: "Jobs/x" }, { id: "D", name: "Job Applications/Rejections" }])).toEqual(["B", "D"]);
    expect(exclusiveJobLabels({ addLabelIds: ["STARRED", "R"], removeLabelIds: ["INBOX"] }, ["O", "C", "R"])).toEqual({ addLabelIds: ["STARRED", "R"], removeLabelIds: ["INBOX", "O", "C"] });
    // Two named at once: the last one wins.
    expect(exclusiveJobLabels({ addLabelIds: ["C", "R"], removeLabelIds: [] }, ["C", "R"])).toEqual({ addLabelIds: ["R"], removeLabelIds: ["C"] });
    expect(exclusiveJobLabels({ addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] }, ["C"])).toEqual({ addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] });
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

// A small Gmail: labels, messages with labelIds (a thread is its messages), metadata, full payloads, batch and thread modifies.
function fakeGmail(messages: Array<{ id: string; from: string; subject: string; minutesAgo: number; plain?: string; html?: string; threadId?: string; headers?: Record<string, string>; labelIds?: string[] }>, existingLabels: string[] = []) {
  const labels = [{ id: "INBOX", name: "INBOX" }, ...existingLabels.map((name, index) => ({ id: `Existing_${index}`, name }))];
  const state = new Map(messages.map((message) => [message.id, { ...message, labelIds: message.labelIds ?? ["INBOX"] }]));
  const modifies: Array<{ ids?: string[]; thread?: string; addLabelIds?: string[]; removeLabelIds?: string[] }> = [];
  type Stored = typeof state extends Map<string, infer V> ? V : never;
  const threadOf = (message: Stored) => message.threadId ?? message.id;
  const apply = (message: Stored, change: { addLabelIds?: string[]; removeLabelIds?: string[] }) => {
    const kept = message.labelIds.filter((label) => !(change.removeLabelIds ?? []).includes(label));
    message.labelIds = [...kept, ...(change.addLabelIds ?? []).filter((label) => !kept.includes(label))];
  };
  const headersOf = (message: Stored) => [{ name: "From", value: message.from }, { name: "Subject", value: message.subject }, ...Object.entries(message.headers ?? {}).map(([name, value]) => ({ name, value }))];
  const internalDate = (message: Stored) => String(Date.now() - message.minutesAgo * 60_000);
  const metadata = (message: Stored) => ({ id: message.id, threadId: threadOf(message), labelIds: message.labelIds, internalDate: internalDate(message), snippet: (message.plain ?? "").slice(0, 100), payload: { headers: headersOf(message) } });
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/labels" && method === "GET") return Response.json({ labels });
    if (path === "/labels") { const label = { id: `Label_${labels.length}`, name: body.name as string }; labels.push(label); return Response.json(label); }
    if (path.startsWith("/labels/") && method === "DELETE") { labels.splice(labels.findIndex((label) => label.id === decodeURIComponent(path.slice(8))), 1); return new Response(null, { status: 204 }); }
    if (path === "/messages/batchModify") {
      modifies.push(body);
      for (const id of body.ids as string[]) apply(state.get(id)!, body);
      return new Response(null, { status: 204 });
    }
    const threadModify = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (threadModify) {
      const threadId = decodeURIComponent(threadModify[1]!);
      modifies.push({ thread: threadId, ...body });
      for (const message of state.values()) if (threadOf(message) === threadId) apply(message, body);
      return Response.json({ id: threadId });
    }
    if (path === "/threads") {
      const labelId = url.searchParams.get("labelIds");
      return Response.json({ threads: [...new Set([...state.values()].filter((message) => !labelId || message.labelIds.includes(labelId)).map(threadOf))].map((id) => ({ id })) });
    }
    if (path.startsWith("/threads/")) {
      const threadId = decodeURIComponent(path.slice(9));
      return Response.json({ id: threadId, messages: [...state.values()].filter((message) => threadOf(message) === threadId).map(metadata) });
    }
    if (path === "/messages") {
      const inbox = url.searchParams.get("q")?.includes("in:inbox") ?? false;
      return Response.json({ messages: [...state.values()].filter((message) => !inbox || message.labelIds.includes("INBOX")).map((message) => ({ id: message.id })) });
    }
    const message = state.get(decodeURIComponent(path.replace("/messages/", "")))!;
    if (url.searchParams.get("format") === "metadata") return Response.json(metadata(message));
    if (url.searchParams.get("format") === "minimal") return Response.json({ id: message.id, threadId: threadOf(message), labelIds: message.labelIds });
    const parts = message.html ? [{ mimeType: "text/html", body: { data: b64(message.html) } }] : [{ mimeType: "text/plain", body: { data: b64(message.plain ?? "") } }];
    return Response.json({ id: message.id, threadId: threadOf(message), internalDate: internalDate(message), payload: { mimeType: "multipart/alternative", headers: headersOf(message), parts } });
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

  it("leaves a job alert in the inbox with no label, task or notice, and takes Action needed off an alert filed there earlier (OpenTrain, 28/10)", async () => {
    const gmail = fakeGmail([
      { id: "m-alert", from: "OpenTrain Alert <alert@opentrain.ai>", subject: "New job: Python Infrastructure Engineer - LLM Training & Agent Tooling [AS-L]", minutesAgo: 30,
        plain: "OpenTrain AI: a new job matches your profile. Please complete a short coding test to qualify. Apply now.", headers: { "List-Unsubscribe": "<https://opentrain.ai/unsubscribe>" } },
      { id: "m-alert-earlier", from: "OpenTrain Alert <alert@opentrain.ai>", subject: "New job: Backend Coding Task and Verifier Specialist", minutesAgo: 240,
        plain: "OpenTrain AI: Backend Coding Task and Verifier Specialist. Please complete the coding challenge when you apply.", labelIds: ["Existing_0"] }
    ], ["Job Applications/Action needed"]);
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
      // The operator applied to OpenTrain AI, so its alerts reach the triage as the company's mail.
      await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: { company: "OpenTrain AI", role: "Engineer", ats: "other", url: "https://opentrain.ai/jobs/1" } }).then(async (created) => {
        await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${encodeURIComponent(created.json().application.id as string)}`, headers: agent, payload: { status: "FILLING" } });
      });
      const pass = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(pass.json()).toMatchObject({ scanned: 1, actionNeeded: 0, other: 1 });
      expect(gmail.labels.some((label) => label.name === "Job Applications/Other")).toBe(false);
      expect(gmail.state.get("m-alert")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-alert-earlier")!.labelIds).toEqual([]);
      expect((await store.listTaskItems(owner, { page: 1, pageSize: 25 })).items).toEqual([]);
      const mail = await app.inject({ method: "GET", url: "/api/job-apply/events?limit=50", headers });
      expect(JSON.stringify(mail.json())).not.toContain("Action needed:");
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

  it("files application mail once, a thread under one label: receipts, stale codes and rejections archived, test and interview requests kept and announced, other mail left quietly with no label", async () => {
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
      expect(gmail.labels.map((entry) => entry.name)).toEqual(["INBOX", "Job Applications", "Job Applications/Confirmations", "Job Applications/Rejections", "Job Applications/Action needed"]);
      expect(gmail.state.get("m-receipt")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-old-code")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-done")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-reject")!.labelIds).toEqual([label("Job Applications/Rejections")]);
      // One label a thread, as its newest mail says: the completed test files the whole Ramp thread under Confirmations.
      expect(gmail.state.get("m-codesignal")!.labelIds).toEqual([label("Job Applications/Confirmations")]);
      expect(gmail.state.get("m-interview")!.labelIds).toEqual(["INBOX", label("Job Applications/Action needed")]);
      expect(gmail.state.get("m-survey")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-other")!.labelIds).toEqual(["INBOX"]);
      // Job-alert digests leave the inbox without a label; LinkedIn News and the shop mail stay.
      for (const id of ["m-alert", "m-hiring", "m-board"]) expect(gmail.state.get(id)!.labelIds).toEqual([]);
      expect(gmail.state.get("m-news")!.labelIds).toEqual(["INBOX"]);

      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string; message: string; applicationId: string | null; payload: Record<string, unknown> }>;
      const mail = events.filter((event) => event.type === "MAIL");
      expect(mail.map((event) => event.message).sort()).toEqual([
        "Action needed: Interview with Acme from Acme. Task: Interview: Interview with Acme, deadline not stated (no date, time or \"within/valid for N hours/days\" in this mail and Acme's other mail within the hour: find the deadline in the thread and record it)",
        // The invitation's October 20 deadline is older than the fake mail's date, so it does not count.
        "Action needed: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal from CodeSignal. Task: Test: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal, deadline not stated (no date, time or \"within/valid for N hours/days\" in this mail: find the deadline in the thread and record it)",
        "Archived 3 confirmations and 1 rejection and 3 job alerts from me@gmail.com under Job Applications",
        "Rejection email from Acme Recruiting: Your application to Acme"
      ]);
      expect(mail.find((event) => event.message.startsWith("Rejection"))!.applicationId).toBe(application.id);
      expect(mail.find((event) => event.message.startsWith("Action needed: Interview"))!.payload).toMatchObject({ category: "ACTION_NEEDED", from: "no-reply@ashbyhq.com", messageId: "m-interview" });
      // One reminder task per test or interview thread, none for the mail no rule placed; the completed test's task is done.
      expect(await tasks()).toEqual(["DONE Test: Ramp invited you to take Ramp Frontend Challenge Assessment on CodeSignal, deadline not stated", "OPEN Interview: Interview with Acme, deadline not stated"]);
      // No mail body is stored in an event.
      expect(JSON.stringify(mail)).not.toContain("Please select a time");

      // A second pass finds nothing new: labelled mail and the survey no rule placed are skipped, and the fresh code is still left alone.
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
      expect(gmail.modifies.at(-1)).toEqual({ thread: "m-other", removeLabelIds: [label("Job Applications/Confirmations"), label("Job Applications/Rejections"), label("Job Applications/Action needed")] });
      // NONE + archive: plain archive, the Job Applications labels go too.
      const archivedNone = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "NONE", archive: true } });
      expect(archivedNone.json()).toEqual({ account: "me@gmail.com", category: "NONE", label: null, organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ thread: "m-other", removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections"), label("Job Applications/Action needed")] });
      expect(gmail.state.get("m-other")!.labelIds).toEqual([]);
      // ACTION_NEEDED + archive: the label stays, the inbox goes.
      const archivedAction = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-new-code"], category: "ACTION_NEEDED", archive: true } });
      expect(archivedAction.json()).toEqual({ account: "me@gmail.com", category: "ACTION_NEEDED", label: "Job Applications/Action needed", organized: 1, archived: true });
      expect(gmail.modifies.at(-1)).toEqual({ thread: "m-new-code", addLabelIds: [label("Job Applications/Action needed")], removeLabelIds: ["INBOX", label("Job Applications/Confirmations"), label("Job Applications/Rejections")] });
      expect(gmail.state.get("m-new-code")!.labelIds).toEqual([label("Job Applications/Action needed")]);
      const invalid = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/organize", headers: agent, payload: { messageIds: ["m-other"], category: "SPAM" } });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
  it("repairs the mail filed before 3/11 once: Other's threads re-read and filed under one label, two-label threads keep one, the empty Other label deleted", async () => {
    const gmail = fakeGmail([
      // Kraken (2/11): filed as Other by the triage, then Rejections by the Mail Copilot.
      { id: "m-kraken", from: "Kraken <no-reply@kraken.com>", subject: "An update on your application", minutesAgo: 600, labelIds: ["INBOX", "Existing_0", "Existing_1"],
        plain: "After careful consideration, we've decided not to move ahead with your candidacy at this stage." },
      { id: "m-question", from: "Acme <no-reply@ashbyhq.com>", subject: "Quick question", minutesAgo: 700, labelIds: ["INBOX", "Existing_0"], plain: "Could you tell us your current notice period?" },
      { id: "m-receipt", from: "Acme <no-reply@ashbyhq.com>", subject: "Thanks for applying to Acme", minutesAgo: 800, labelIds: ["Existing_0"], plain: "We received your application." },
      { id: "m-two", from: "Acme <no-reply@ashbyhq.com>", subject: "Hello", minutesAgo: 900, labelIds: ["INBOX", "Existing_1", "Existing_2"], plain: "Hello there." },
      { id: "m-trash", from: "Acme <no-reply@ashbyhq.com>", subject: "Old", minutesAgo: 1000, labelIds: ["TRASH", "Existing_0"], plain: "Old mail." }
    ], ["Job Applications/Other", "Job Applications/Rejections", "Job Applications/Confirmations"]);
    const capabilities: ConnectorCapability[] = ["MAIL_READ", "MAIL_ORGANIZE"];
    const google: JobApplyGoogleAccess = {
      googleConfigured: true,
      async googleAccounts() { return [{ email: "me@gmail.com", capabilities }]; },
      async googleCapabilities() { return capabilities; },
      async googleAccessToken() { return "gmail-token"; },
      async tool() { return { status: "COMPLETED", result: {} }; }
    };
    const { app, pane, headers, agent } = await fixture(google, gmail.fetchImpl);
    try {
      expect((await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "me@gmail.com" } })).statusCode).toBe(200);
      const pass = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      expect(pass.statusCode, pass.body).toBe(200);
      expect(gmail.state.get("m-kraken")!.labelIds).toEqual(["Existing_1"]);
      expect(gmail.state.get("m-question")!.labelIds).toEqual(["INBOX"]);
      expect(gmail.state.get("m-receipt")!.labelIds).toEqual(["Existing_2"]);
      expect(gmail.state.get("m-two")!.labelIds).toEqual(["INBOX", "Existing_1"]);
      expect(gmail.state.get("m-trash")!.labelIds).toEqual(["TRASH"]);
      expect(gmail.labels.map((label) => label.name)).not.toContain("Job Applications/Other");
      // Only the label went: every message is still there, and nothing but the label was deleted.
      expect(gmail.state.size).toBe(5);
      const deletes = vi.mocked(gmail.fetchImpl).mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => String(url).replace(/^.*\/users\/me/, ""));
      expect(deletes).toEqual(["/labels/Existing_0"]);
      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ type: string; message: string; payload: Record<string, unknown> }>;
      const cleanups = events.filter((event) => event.payload.category === "CLEANUP");
      expect(cleanups.map((event) => [event.type, event.message])).toEqual([["MAIL",
        "Cleaned the Job Applications labels of me@gmail.com: 4 threads under Other, 1 under two or more labels; filed 1 → Rejections, 1 → Confirmations; 1 left where they were without a label; 1 kept their newest label; 1 in the trash or spam lost Other. Deleted the empty label Job Applications/Other (no mail deleted)."]]);
      expect(cleanups[0]!.payload).toMatchObject({ account: "me@gmail.com", other: 4, multiLabel: 1, rejections: 1, confirmations: 1, actionNeeded: 0, unlabelled: 1, kept: 1, trashOrSpam: 1, otherDeleted: true });
      // Once Other is gone the repair never runs again.
      await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/triage", headers: agent, payload: {} });
      const after = (await app.inject({ method: "GET", url: `/api/job-apply/events?paneId=${encodeURIComponent(pane.id)}&limit=50`, headers })).json().events as Array<{ payload: Record<string, unknown> }>;
      expect(after.filter((event) => event.payload.category === "CLEANUP")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
