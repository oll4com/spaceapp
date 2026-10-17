import type { JobApplyMailCategory } from "@space/contracts";
import { companyKey } from "./gmail-mailbox.js";

// Which inbox mail belongs to job applications, and what it asks for. The rules are conservative: only plain
// receipts, stale security codes and clear rejections are archived; everything else (interviews, assessments,
// scheduling, questions, offers and anything unrecognized) stays in the inbox as "Action needed".

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

/** Gmail search for recent inbox mail from application senders and from the tracked companies' names. */
export function triageQuery(companies: readonly string[], days = 14): string {
  const terms = [...APPLICATION_SENDER_DOMAINS, ...ASSESSMENT_SENDER_DOMAINS, ...LINKEDIN_APPLICATION_SENDERS].map((entry) => `from:${entry}`);
  for (const company of companies) {
    const word = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((part) => part.length >= 3)[0];
    if (word && !terms.includes(`from:${word}`)) terms.push(`from:${word}`);
  }
  return `in:inbox newer_than:${days}d {${terms.join(" ")}}`;
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
function assertsRejection(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n+/).some((sentence) => REJECTION.test(sentence) && !CONDITIONAL.test(sentence));
}
const STRONG_ACTION = /\binvit(ed|ing|es) you to\b|\bplease (complete|schedule|select|choose|book|reply|respond|provide|send|fill|confirm|submit|share)\b|\bcomplete (the|your|this|our) (assessment|test|challenge|questionnaire|form|exercise)\b|\btake[- ]home\b|\bcoding (challenge|assessment|test|exercise)\b|\bonline assessment\b|\b(select|choose|book|pick) a (time|slot)\b|\byour availability\b|\bschedule (a|an|your) (call|interview|chat|time|meeting)\b|\bdeadline\b|\bexpires? (on|in|at)\b|\boffer letter\b|\breference check\b|\bbackground check\b/i;
const CONFIRMATION = /\bthanks? (you )?for (applying|your application|your interest|submitting)\b|\bapplication (has been |was )?(received|submitted|sent)\b|\b(we('ve| have)|we) received your application\b|\bapplication confirmation\b|\bsuccessfully submitted\b|\byour application (to|for|with)\b/i;

/**
 * What an application email asks for. Returns null for a security code under an hour old: the copilot may
 * still need it, so it stays untouched until the next pass.
 */
export function classifyApplicationMail(message: { from: string; subject: string; text: string; receivedAt: string | null }, nowMs: number): JobApplyMailCategory | null {
  const domain = senderDomain(message.from);
  const text = `${message.subject}\n${message.text}`.slice(0, 6000);
  if (domainIn(domain, ASSESSMENT_SENDER_DOMAINS)) return "ACTION_NEEDED";
  if (SECURITY_CODE.test(message.subject) || (SECURITY_CODE.test(text) && /\bcode\b/i.test(message.subject))) {
    const received = message.receivedAt ? Date.parse(message.receivedAt) : Number.NaN;
    return Number.isFinite(received) && nowMs - received >= 3_600_000 ? "CONFIRMATION" : null;
  }
  if (assertsRejection(text)) return "REJECTION";
  if (STRONG_ACTION.test(text)) return "ACTION_NEEDED";
  if (CONFIRMATION.test(text)) return "CONFIRMATION";
  return "ACTION_NEEDED";
}

/** "Name <address>" as a short display sender. */
export function displaySender(from: string): string {
  const name = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
  return (name || senderAddress(from)).slice(0, 120);
}
