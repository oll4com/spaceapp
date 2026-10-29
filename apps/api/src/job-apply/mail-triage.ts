import type { JobApplyMailCategory } from "@space/contracts";
import { companyKey } from "./gmail-mailbox.js";

// Which inbox mail belongs to job applications, and what it asks for. The rules are conservative: only plain
// receipts, stale security codes and clear rejections are archived; a request to take a test or an interview stays
// in the inbox as "Action needed", and everything else (questions, offers, surveys, anything unrecognized) stays as "Other".

/** Applicant tracking systems, job boards and assessment or scheduling services that write to applicants. */
export const APPLICATION_SENDER_DOMAINS = [
  "greenhouse-mail.io", "greenhouse.io", "ashbyhq.com", "lever.co", "hire.lever.co", "myworkday.com", "workday.com", "icims.com",
  "smartrecruiters.com", "workablemail.com", "workable.com", "jobvite.com", "bamboohr.com", "recruitee.com", "teamtailor.com", "teamtailor-mail.com",
  "rippling.com", "breezy.hr", "pinpointhq.com", "personio.com"
];
/** Assessment and interview-scheduling services: their mail always asks for something. */
export const ASSESSMENT_SENDER_DOMAINS = [
  "codesignal.com", "hackerrank.com", "hackerrankforwork.com", "coderpad.io", "karat.com", "testgorilla.com", "calendly.com", "goodtime.io"
];
/** LinkedIn writes about applications from these senders only (job alerts and newsletters are not application mail). */
const LINKEDIN_APPLICATION_SENDERS = ["jobs-noreply@linkedin.com", "hiring-noreply@linkedin.com"];

export function senderAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}
export function senderDomain(from: string): string {
  return senderAddress(from).split("@")[1] ?? "";
}
function domainIn(domain: string, list: readonly string[]): boolean {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

// Receipts and status mail companies send from their own domain (Datadog, Zscaler, IMC, x.ai: the ntheogr inbox,
// 2026-10-27): found by subject, and filed only when the mail is about a job (`isJobReceipt`).
const RECEIPT_SUBJECT_PHRASES = ["thank you for applying", "thanks for applying", "thank you for your application", "we've received your application",
  "we have received your application", "we've got it", "your application", "application received", "application status"];
const RECEIPT_SUBJECT = /\bthanks? (you )?for (applying|your application)\b|\bwe(['’]ve| have) (received your application|got it)\b|\byour application\b|\bapplication (received|status)\b/i;
const JOB_CONTEXT = /\b(roles?|positions?|jobs?|candidates?|candidacy|careers?|hiring|recruit\w*|talent|resumes?|résumé|openings?|interviews?|vacanc\w+)\b/i;
// shortcut: Gmail documents no query length limit; 1,400 characters of terms per search stays well inside URL limits. Lower it if Gmail ever answers 400.
const MAX_QUERY_TERMS_LENGTH = 1400;

/**
 * Gmail searches for recent inbox mail: application senders and receipt subjects in the first, every tracked company's name
 * in the next ones (split to stay within the query length).
 */
export function triageQueries(companies: readonly string[], days = 14): string[] {
  const groups = [[...APPLICATION_SENDER_DOMAINS, ...ASSESSMENT_SENDER_DOMAINS, ...LINKEDIN_APPLICATION_SENDERS].map((entry) => `from:${entry}`)
    .concat(RECEIPT_SUBJECT_PHRASES.map((phrase) => `subject:"${phrase}"`))];
  const known = new Set(groups[0]);
  for (const company of companies) {
    const word = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((part) => part.length >= 3)[0];
    const term = `from:${word}`;
    if (!word || known.has(term)) continue;
    known.add(term);
    const last = groups.at(-1)!;
    if (groups.length === 1 || last.join(" ").length + term.length + 1 > MAX_QUERY_TERMS_LENGTH) groups.push([term]);
    else last.push(term);
  }
  return groups.map((terms) => `in:inbox newer_than:${days}d {${terms.join(" ")}}`);
}

/** A receipt or status subject from a sender Space does not know yet: worth reading to see whether it is about a job. */
export function hasReceiptSubject(message: { from: string; subject: string }): boolean {
  return !isLinkedInDigest(message) && RECEIPT_SUBJECT.test(message.subject);
}
/** Such a mail is application mail only when it is about a job (a bank's "Your application is approved" is not). */
export function isJobReceipt(message: { from: string; subject: string; text: string }): boolean {
  return hasReceiptSubject(message) && JOB_CONTEXT.test(`${message.subject}\n${message.text}`);
}

/**
 * The tracked application a message is about: a company whose name appears in the sender (name or domain) or
 * the subject. Short names (under four letters) never match on their own.
 */
export function matchApplicationCompany<T extends { company: string }>(message: { from: string; subject: string }, applications: readonly T[]): T | null {
  const haystack = companyKey(`${message.from} ${senderDomain(message.from).replace(/\.[a-z]+$/, "")} ${message.subject}`);
  return applications.find((application) => {
    const key = companyKey(application.company);
    return key.length >= 4 && haystack.includes(key);
  }) ?? null;
}

// LinkedIn job alerts and recommendation digests (also sent from jobs-noreply@linkedin.com, and naming tracked companies:
// "New jobs similar to Software Engineer at Foundation Health", "Xero is hiring in Gen AI") are not application mail.
const LINKEDIN_DIGEST_SENDERS = ["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com", "news@linkedin.com"];
const LINKEDIN_DIGEST_SUBJECT = /\bnew jobs?\b|\bjobs? similar to\b|\bjobs? for you\b|\bjobs? you may (be interested in|like)\b|\b(is|are) hiring\b|\bjob alert\b|\brecommended (jobs?|for you)\b|\btop job picks\b|\bstill hiring\b/i;
const LINKEDIN_APPLICATION_SUBJECT = /\byour application\b|\bapplication (was|has been) (sent|viewed|submitted|received)\b|\byou applied\b/i;
export function isLinkedInDigest(message: { from: string; subject: string }): boolean {
  if (!domainIn(senderDomain(message.from), ["linkedin.com"])) return false;
  if (LINKEDIN_APPLICATION_SUBJECT.test(message.subject)) return false;
  return LINKEDIN_DIGEST_SENDERS.includes(senderAddress(message.from)) || LINKEDIN_DIGEST_SUBJECT.test(message.subject);
}

// Job alerts and recommendation digests from LinkedIn and other job boards ("Job alerts - Bangkok"): the triage
// archives them without a Job Applications label. Anything else, LinkedIn News included, stays as it is.
const JOB_ALERT_SENDERS = ["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com", "jobs-noreply@linkedin.com"];
const JOB_ALERT_SUBJECT = /\bjob alerts?\b|\bjobs? similar to\b|\brecommended jobs?\b|\btop job picks\b|\bjobs? for you\b/i;

/** Gmail search for the job-alert digests still in the inbox (`isJobDigest` decides). */
export function digestQuery(days = 30): string {
  const subjects = ["job alert", "job alerts", "jobs similar to", "recommended jobs", "top job picks", "jobs for you"].map((phrase) => `subject:"${phrase}"`);
  return `in:inbox newer_than:${days}d {${[...JOB_ALERT_SENDERS.map((sender) => `from:${sender}`), ...subjects].join(" ")}}`;
}

export function isJobDigest(message: { from: string; subject: string }): boolean {
  if (LINKEDIN_APPLICATION_SUBJECT.test(message.subject) || domainIn(senderDomain(message.from), ASSESSMENT_SENDER_DOMAINS)) return false;
  if (isLinkedInDigest(message) && (senderAddress(message.from) !== "news@linkedin.com" || LINKEDIN_DIGEST_SUBJECT.test(message.subject))) return true;
  return JOB_ALERT_SUBJECT.test(message.subject);
}

/** Whether a message comes from an application sender, or names a tracked company (never a LinkedIn digest). */
export function isApplicationMail(message: { from: string; subject: string }, companies: readonly { company: string }[]): boolean {
  const domain = senderDomain(message.from);
  if (isLinkedInDigest(message)) return false;
  return domainIn(domain, APPLICATION_SENDER_DOMAINS) || domainIn(domain, ASSESSMENT_SENDER_DOMAINS)
    || LINKEDIN_APPLICATION_SENDERS.includes(senderAddress(message.from)) || matchApplicationCompany(message, companies) !== null;
}

const SECURITY_CODE = /\b(security|verification|one[- ]time|confirmation) code\b|\bverify your email\b|\bconfirm your email\b/i;
// Explicit rejection wording only. A bare "unfortunately" is not one: receipts say "Unfortunately, we aren't able to
// respond to every candidate" and safety notes say "Unfortunately, recruiting fraud is increasingly common" (Cohere, Circle 2026-10-14).
const REJECTION = /\bnot (be )?moving forward\b|\bdecided to (move|proceed) forward with other\b|\bwill not be (moving|proceeding|progressing)\b|\bwon't be (moving|proceeding|progressing)\b|\bposition has (already |now )?been filled\b|\bdecided not to (proceed|progress|move forward)\b|\bnot to move forward\b|\bpursue other candidates\b|\bother candidates whose\b|\bnot (been )?selected\b|\bregret to inform\b|\bunable to offer you\b|\bno longer (under consideration|being considered)\b|\bnot (be )?progress(ing)? (with )?your (application|candidacy)\b|\b(your application|you) (was|were|has been|have been) unsuccessful\b/i;
// Receipts often say "if you are not selected, keep an eye on our jobs page": a rejection phrase inside a
// conditional sentence is not a rejection.
const CONDITIONAL = /\b(if|in case|in the event|should you|unless|whether)\b/i;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/);
function assertsRejection(text: string): boolean {
  return sentences(text).some((sentence) => REJECTION.test(sentence) && !CONDITIONAL.test(sentence));
}
// "Action needed" is only a request to take a test or an interview (operator rule 2026-10-27): receipts promising an
// interview "if" there is a fit (Primer, Lambda, Alloy), surveys (Neo4j), offers and other asks are not.
const TEST_OR_INTERVIEW = /\binvit(e|es|ed|ing|ation)\b.{0,80}?\b(assessments?|tests?|challenges?|interviews?|exercises?|assignments?|quiz(zes)?)\b|\b(assessment|challenge|interview|test)s?\b.{0,40}?\binvit(e|ation)\b|\bplease (complete|take|start|finish|attempt)\b.{0,40}?\b(assessment|test|challenge|exercise|assignment|quiz)\b|\btake[- ]home\b|\bcoding (challenge|assessment|test|exercise)\b|\bonline assessment\b|\b(answer|complete|fill (in|out)|respond to)\b.{0,30}?\bscreening questions?\b|\b(select|choose|book|pick|schedule|reserve|set up|arrange)\b.{0,20}?\b(time|slot|interview)\b|\byour availability\b/i;
// The employer's promise to write later, and feedback surveys, ask nothing yet.
export const NOT_A_REQUEST = /\b(will|['’]ll|may|might|shall)\s+(be\s+)?(reach(ing)?\s+out|contact(ing)?|in\s+touch|get(ting)?\s+(back|in\s+touch)|follow(ing)?\s+up|let\s+you\s+know|notify|invited|asked)\b|\b(survey|feedback)\b/i;
export function asksForTestOrInterview(text: string): boolean {
  // A conditional sentence counts only when it says "please" ("If you're still interested, please pick a time"), so a real invite is never archived as a receipt.
  return sentences(text).some((sentence) => TEST_OR_INTERVIEW.test(sentence) && !NOT_A_REQUEST.test(sentence) && (!CONDITIONAL.test(sentence) || /\bplease\b/i.test(sentence)));
}
// A later mail of the thread that says the test is done ("Thank you for completing the assessment"); "Once you have
// completed the test, ..." in an invitation is a condition, not a report.
const COMPLETED = /\b(?:completing|submitting|completed|submitted|finished)\s+(?:the |your |our |this )?(?:[\w-]+\s+){0,3}?(?:assessment|test|challenge|exercise|assignment|quiz)\b|\b(?:assessment|test|challenge|exercise|assignment|quiz)\s+(?:has been |was |is )?(?:successfully )?(?:completed|submitted)\b/i;
export function reportsCompletion(text: string): boolean {
  return sentences(text).some((sentence) => COMPLETED.test(sentence) && !/\b(once|after|when|if|before|until|unless|please)\b/i.test(sentence));
}

const CONFIRMATION = /\bthanks? (you )?for (applying|your application|your interest|submitting)\b|\bapplication (has been |was )?(received|submitted|sent)\b|\b(we('ve| have)|we) received your application\b|\bapplication confirmation\b|\bsuccessfully submitted\b|\byour application (to|for|with)\b/i;

/**
 * What an application email asks for. Returns null for a security code under an hour old: the copilot may
 * still need it, so it stays untouched until the next pass.
 */
export function classifyApplicationMail(message: { from: string; subject: string; text: string; receivedAt: string | null }, nowMs: number): JobApplyMailCategory | null {
  const domain = senderDomain(message.from);
  const text = `${message.subject}\n${message.text}`.slice(0, 6000);
  // "Thank you for completing the assessment" (HackerRank too) is a receipt; it closes the thread's reminder task.
  if (reportsCompletion(text) && !asksForTestOrInterview(text)) return "CONFIRMATION";
  if (domainIn(domain, ASSESSMENT_SENDER_DOMAINS)) return "ACTION_NEEDED";
  if (SECURITY_CODE.test(message.subject) || (SECURITY_CODE.test(text) && /\bcode\b/i.test(message.subject))) {
    const received = message.receivedAt ? Date.parse(message.receivedAt) : Number.NaN;
    return Number.isFinite(received) && nowMs - received >= 3_600_000 ? "CONFIRMATION" : null;
  }
  if (assertsRejection(text)) return "REJECTION";
  if (asksForTestOrInterview(text)) return "ACTION_NEEDED";
  if (CONFIRMATION.test(text)) return "CONFIRMATION";
  return "OTHER";
}

/** "Name <address>" as a short display sender. */
export function displaySender(from: string): string {
  const name = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
  return (name || senderAddress(from)).slice(0, 120);
}
