import { JOB_APPLY_IMPORTED_URL_PREFIX, type Appointment, type NousJobApplicationRow, type NousJobCompany, type NousJobMail, type NousJobReport, type TaskItem } from "@space/contracts";
import type { JobApplicationRecord, JobApplyEventRecord } from "@space/db";
import { companyKey } from "./gmail-mailbox.js";
import { requestKind, taskDeadline } from "./interview-tasks.js";
import { APPLICATION_SENDER_DOMAINS, ASSESSMENT_SENDER_DOMAINS, senderDomain } from "./mail-triage.js";

/**
 * The Nous "Job applications" page (operator 3/11 22:33 BKK, nous_msg:e734994004dd): every application and what the companies answered,
 * from the Job Copilot's own records. Replies are counted per company: a rejection or invitation rarely names the role, and the triage's
 * stored match is a loose substring (stable 3/11: "Oura" took fifteen companies' rejections through "yOUR Application"). So a mail belongs to
 * the company its sender's domain, its sender's name or its subject names as a whole word, among the companies we sent an application to;
 * it belongs to none otherwise. Stages are not recorded as such: stage n is the n-th distinct test or interview record of the company (derived).
 */
const SENT = new Set(["SUBMITTED", "VERIFIED"]);
// Mail from these comes for many companies; their domains name none of them.
const SHARED_SENDER_DOMAINS = [...APPLICATION_SENDER_DOMAINS, ...ASSESSMENT_SENDER_DOMAINS, "linkedin.com", "workablemail.com", "gmail.com", "google.com"];
const PLATFORM_KEYS = new Set(SHARED_SENDER_DOMAINS.map((domain) => companyKey(domain.split(".")[0]!)));
const PLATFORMS: Record<string, string> = { greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workday: "Workday", linkedin: "LinkedIn", workable: "Workable",
  smartrecruiters: "SmartRecruiters", wellfound: "Wellfound", turing: "Turing", mercor: "Mercor", personio: "Personio", bamboohr: "BambooHR", recruitee: "Recruitee",
  breezy: "Breezy HR", teamtailor: "Teamtailor", zohorecruit: "Zoho Recruit", rippling: "Rippling", dover: "Dover", himalayas: "Himalayas" };
// "Offer letter", "Your offer from X": never "offer you an interview".
const OFFER = /\boffer letter\b|\bjob offer\b|\boffer of employment\b|\bemployment offer\b|\byour offer\b/i;
// A "company" a board import filled with the job title ("Software Engineer") is found only by its sender's domain; "Remote" too
// (stable 3/11: "FINN Frontend Engineer - React Assessment - Remote at Ewa Services" made the company Remote "invited").
const ROLE_WORDS = /\b(engineer|developer|manager|designer|analyst|scientist|architect|intern|specialist|consultant|remote)\b/i;
const STAGE_PREFIX = /^\s*(?:re|fwd?|reminder|invitation|updated invitation)\s*:\s*/i;

/** The ATS the row names, else the hiring platform its address shows, else the company's own site. */
export function platformOf(ats: string, url: string): string {
  if (ats !== "other") return PLATFORMS[ats] ?? ats;
  if (url.startsWith(JOB_APPLY_IMPORTED_URL_PREFIX)) return "Earlier tracker";
  let labels: string[] = [];
  try { labels = new URL(url).hostname.toLowerCase().split("."); } catch { /* not a URL: the company's site */ }
  const known = labels.find((label) => Object.hasOwn(PLATFORMS, label));
  return known ? PLATFORMS[known]! : "Company site";
}

// `first` and `role` are read once per company, not once per company and mail (the report held the API's main thread up to 3.2 s on stable 4/11);
// `word` is compiled only for a company a mail's text holds the first word of (one unicode RegExp per application held it 1.5 s).
interface Company { name: string; key: string; word?: RegExp; lower: string; first: string; role: boolean }
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function companyOf(name: string): Company {
  const trimmed = name.trim();
  return { name: trimmed, key: companyKey(trimmed) || trimmed.toLowerCase(), lower: trimmed.toLowerCase(), first: trimmed.toLowerCase().split(/\s+/)[0]!, role: ROLE_WORDS.test(trimmed) };
}
const wordOf = (company: Company) => company.word ??= new RegExp(`(?<![\\p{L}\\p{N}])${escape(company.name).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");

// Two or three words in a row read as one name: boards store "Dvtrading", "Mystenlabs", "Eightsleep", "Aurosglobal" (stable 3/11: their mails
// say "DV Trading", "Mysten Labs", "Eight Sleep", auros.global, and ten rejections and a test were listed under no company).
const joinedKeys = (words: readonly string[]) => words.flatMap((_, index) => [2, 3].filter((size) => index + size <= words.length).map((size) => companyKey(words.slice(index, index + size).join(""))));

// A name the text holds as a whole word starts with its first run of letters and digits, and that run is one of the text's own runs: each
// mail looks only at the companies whose first run its text has (scanning every company for every mail took seconds with 20,000 applications).
const RUN = /[\p{L}\p{N}]+/gu;
const runIndexes = new WeakMap<readonly Company[], { byRun: Map<string, number[]>; always: number[] }>();
function candidatesIn(companies: readonly Company[], lower: string): Company[] {
  let index = runIndexes.get(companies);
  if (!index) {
    index = { byRun: new Map(), always: [] };
    for (const [at, company] of companies.entries()) {
      const run = company.first.match(RUN)?.[0];
      if (run) index.byRun.set(run, [...(index.byRun.get(run) ?? []), at]); else index.always.push(at);
    }
    runIndexes.set(companies, index);
  }
  const found = new Set(index.always);
  for (const run of new Set(lower.match(RUN) ?? [])) for (const at of index.byRun.get(run) ?? []) found.add(at);
  // In the companies' own order, so the longest-name tie still goes to the same company.
  return [...found].sort((a, b) => a - b).map((at) => companies[at]!);
}

/** The company a mail names: its sender's own domain first, then the sender's name, then the subject; the longest name wins a tie. */
export function namedCompany(companies: readonly Company[], byKey: ReadonlyMap<string, Company>, mail: { from: string | null; display?: string | null; subject: string }): Company | null {
  const domain = mail.from && mail.from.includes("@") ? senderDomain(mail.from) : "";
  if (domain && !SHARED_SENDER_DOMAINS.some((entry) => domain === entry || domain.endsWith(`.${entry}`))) {
    const labels = domain.split(".");
    const hits = [...labels.slice(0, -1).map(companyKey), ...joinedKeys(labels)].map((key) => byKey.get(key)).filter((hit): hit is Company => Boolean(hit));
    if (hits.length) return hits.sort((a, b) => b.key.length - a.key.length)[0]!;
  }
  const display = mail.display ?? (mail.from?.includes("<") ? mail.from.replace(/<[^>]*>/, "") : mail.from && !mail.from.includes("@") ? mail.from : "");
  // Short names ("Via", "Map") stand in subjects as plain words; there a name needs four letters.
  for (const [text, minimum] of [[display?.trim() ?? "", 2], [mail.subject, 4]] as const) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const named = (company: Company) => company.key.length >= minimum && !company.role;
    const hits = [...candidatesIn(companies, lower).filter((company) => named(company) && lower.includes(company.first) && wordOf(company).test(text)),
      ...joinedKeys(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)).map((key) => byKey.get(key)).filter((hit): hit is Company => Boolean(hit) && named(hit!))];
    // A test or ATS platform named beside another company is the tool, not the employer (stable 5/11: "Agoda · …: HackerRank Coding Interview" went to HackerRank).
    const employers = hits.filter((hit) => !PLATFORM_KEYS.has(hit.key));
    if (hits.length) return (employers.length ? employers : hits).sort((a, b) => b.key.length - a.key.length)[0]!;
  }
  return null;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function weekFormatter(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  return (iso: string): string => {
    const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    return new Date(day - Math.max(0, WEEKDAYS.indexOf(parts.weekday!)) * DAY_MS).toISOString().slice(0, 10);
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const line = (objective: string, pattern: RegExp) => pattern.exec(objective)?.[1]?.trim() ?? null;
const stageSubject = (subject: string) => { let rest = subject; while (STAGE_PREFIX.test(rest)) rest = rest.replace(STAGE_PREFIX, ""); return rest.trim().toLowerCase(); };

export interface JobReportInput {
  applications: readonly JobApplicationRecord[];
  /** MAIL events (others are ignored). */
  events: readonly JobApplyEventRecord[];
  /** The Job Copilot's test and interview tasks (others are ignored). */
  tasks: readonly TaskItem[];
  appointments: readonly Appointment[];
  timeZone: string;
  now: Date;
}

export function buildJobReport(input: JobReportInput): NousJobReport {
  const sent = input.applications.filter((row) => SENT.has(row.status));
  const index = new Map<string, Company>();
  const entries = new Map<string, NousJobCompany>();
  const spellings = new Map<string, Company>();
  const names = new Map<string, Map<string, number>>();
  for (const row of sent) {
    const company = companyOf(row.company);
    if (!index.has(company.key)) index.set(company.key, company);
    // Every spelling is looked for ("Scale AI" and "Scaleai" are one company).
    if (!spellings.has(company.lower)) spellings.set(company.lower, company);
    const entry = entries.get(company.key) ?? entries.set(company.key, { name: company.name, applicationIds: [], stages: [], rejections: [], offers: [], otherMails: [], outcome: "NO_REPLY" }).get(company.key)!;
    entry.applicationIds.push(row.id);
    // A company shows under the spelling most of its applications use.
    const counts = names.get(company.key) ?? names.set(company.key, new Map()).get(company.key)!;
    counts.set(company.name, (counts.get(company.name) ?? 0) + 1);
    if (counts.get(company.name)! > (counts.get(entry.name) ?? 0)) entry.name = company.name;
  }
  const companies = [...spellings.values()];
  const unmatched: NousJobMail[] = [];
  const place = (mail: NousJobMail, company: Company | null, list: "stages" | "rejections" | "offers" | "otherMails") => {
    if (company) entries.get(company.key)![list].push(mail);
    else if (list !== "otherMails") unmatched.push(mail);
  };

  // Mail events: one per Gmail message (a pass that failed half-way records some twice); the summaries ("Archived 3 emails") name no message.
  const seen = new Set<string>();
  const threadCompany = new Map<string, Company>();
  const threadAt = new Map<string, string>();
  for (const event of [...input.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const payload = event.payload, category = text(payload.category), messageId = text(payload.messageId);
    if (event.type !== "MAIL" || !messageId || seen.has(messageId) || (category !== "REJECTION" && category !== "ACTION_NEEDED")) continue;
    seen.add(messageId);
    const subject = text(payload.subject);
    // The sender's name is only in the message: "Rejection email from <sender>: <subject>", "Action needed: <subject> from <sender>[. Task: …]".
    const display = category === "REJECTION" ? /^Rejection email from (.+?): /.exec(event.message)?.[1] ?? null
      : event.message.startsWith(`Action needed: ${subject || "(no subject)"} from `) ? event.message.slice(`Action needed: ${subject || "(no subject)"} from `.length).split(". Task: ")[0]! : null;
    const from = text(payload.from) || (display?.includes("@") ? display : null);
    const company = namedCompany(companies, index, { from, display: display?.includes("@") ? null : display, subject });
    const threadId = text(payload.threadId) || null;
    const mail: NousJobMail = { id: event.id, kind: category === "REJECTION" ? "REJECTION" : OFFER.test(subject) ? "OFFER" : "ACTION_NEEDED", at: text(payload.receivedAt) || event.createdAt,
      subject, from: display ?? from, threadId, account: text(payload.account) || null, applicationId: event.applicationId };
    if (threadId && company) threadCompany.set(threadId, company);
    if (threadId && !threadAt.has(threadId)) threadAt.set(threadId, mail.at);
    place(mail, company, mail.kind === "REJECTION" ? "rejections" : mail.kind === "OFFER" ? "offers" : "otherMails");
  }

  // Tests and interviews: the triage's task per mail thread, and interviews put in Appointments by hand.
  const stageThreads = new Set<string>();
  const taskStarts = new Set<number>();
  for (const task of input.tasks) {
    const kind = /^(Test|Interview): /.exec(task.title)?.[1];
    const threadId = line(task.objective, /^Gmail thread: (\S+)/m);
    if (!kind || !threadId) continue;
    const subject = line(task.objective, /^Mail: "(.*)"(?: sent .*)?$/m) ?? task.title;
    const from = line(task.objective, /^From: (.+)$/m);
    const deadline = taskDeadline(task) ?? null;
    if (deadline) taskStarts.add(Math.floor(Date.parse(deadline) / 60_000));
    const mail: NousJobMail = { id: task.id, kind: OFFER.test(subject) ? "OFFER" : kind === "Test" ? "TEST" : "INTERVIEW", at: threadAt.get(threadId) ?? task.createdAt, subject, from,
      threadId, account: line(task.objective, /^Gmail thread: \S+ \((.+)\)$/m), deadline, open: task.status === "OPEN" || task.status === "RUNNING" };
    stageThreads.add(threadId);
    place(mail, namedCompany(companies, index, { from, subject }) ?? threadCompany.get(threadId) ?? null, mail.kind === "OFFER" ? "offers" : "stages");
  }
  for (const appointment of input.appointments) {
    // A test put in Appointments is a DEADLINE whose title names a test (stable 5/11: Agoda's SHL assessment of 31/8 counted no stage).
    const kind = appointment.kind === "INTERVIEW" ? "INTERVIEW" : appointment.kind === "DEADLINE" && requestKind(appointment.title) === "Test" ? "TEST" : null;
    if (!kind || appointment.status === "CANCELLED" || appointment.sourceRef?.startsWith("task:")) continue;
    if (taskStarts.has(Math.floor(Date.parse(appointment.startsAt) / 60_000))) continue;
    place({ id: appointment.id, kind, at: appointment.startsAt, subject: appointment.title, from: null, threadId: null, account: null, deadline: appointment.startsAt,
      open: appointment.status === "UPCOMING" }, namedCompany(companies, index, { from: null, subject: appointment.title }), "stages");
  }

  for (const entry of entries.values()) {
    // One stage per test or interview: a reminder or a re-sent invitation of the same subject within 14 days is the same stage, and so is
    // every record of the same kind within 3 days (stable 3/11: Snyk's invitation, calendar invite and appointment read "passed stage 2";
    // 5/11: Agoda's HackerRank tests of 18/10 and 2/11, same subject, are two stages).
    const stages: NousJobMail[] = [];
    for (const mail of entry.stages.sort((a, b) => a.at.localeCompare(b.at))) {
      const same = stages.find((stage) => stage.kind === mail.kind
        && Date.parse(mail.at) - Date.parse(stage.at) <= (stageSubject(stage.subject) === stageSubject(mail.subject) ? 14 : 3) * DAY_MS);
      if (!same) { stages.push(mail); continue; }
      // An open step keeps the date one of its open records knows (stable 3/11: Snyk's appointment held the interview time, its invitation none).
      if (mail.open) Object.assign(same, { open: true, deadline: (same.open ? same.deadline : null) ?? mail.deadline ?? same.deadline });
    }
    entry.stages = stages;
    for (const list of [entry.rejections, entry.offers, entry.otherMails]) list.sort((a, b) => a.at.localeCompare(b.at));
    const lastStage = stages.at(-1)?.at ?? "", lastRejection = entry.rejections.at(-1)?.at ?? "";
    entry.outcome = entry.offers.length ? "OFFER" : stages.some((stage) => stage.open) ? "IN_PROCESS" : lastRejection && lastRejection >= lastStage ? "REJECTED" : stages.length ? "INVITED" : "NO_REPLY";
  }

  const week = weekFormatter(input.timeZone);
  const applications: NousJobApplicationRow[] = input.applications.map((row) => ({ id: row.id, company: row.company, role: row.role, platform: platformOf(row.ats, row.url),
    url: row.url, status: row.status, appliedAt: row.appliedAt, createdAt: row.createdAt, week: SENT.has(row.status) && row.appliedAt ? week(row.appliedAt) : null }));
  const all = [...entries.values()];
  const companyOfApplication = new Map(all.flatMap((entry) => entry.applicationIds.map((id) => [id, entry] as const)));

  const platforms = new Map<string, { platform: string; applied: number; confirmed: number; companies: Set<NousJobCompany> }>();
  const weeks = new Map<string, { week: string; applied: number; confirmed: number; rejections: number; invitations: number }>();
  const weekRow = (key: string) => weeks.get(key) ?? weeks.set(key, { week: key, applied: 0, confirmed: 0, rejections: 0, invitations: 0 }).get(key)!;
  for (const row of applications.filter((entry) => SENT.has(entry.status))) {
    const platform = platforms.get(row.platform) ?? platforms.set(row.platform, { platform: row.platform, applied: 0, confirmed: 0, companies: new Set() }).get(row.platform)!;
    platform.applied += 1;
    if (row.status === "VERIFIED") platform.confirmed += 1;
    platform.companies.add(companyOfApplication.get(row.id)!);
    if (row.week) { const counts = weekRow(row.week); counts.applied += 1; if (row.status === "VERIFIED") counts.confirmed += 1; }
  }
  for (const entry of all) {
    for (const mail of entry.rejections) weekRow(week(mail.at)).rejections += 1;
    for (const mail of entry.stages) weekRow(week(mail.at)).invitations += 1;
  }

  const notSent: Record<string, number> = {};
  for (const row of input.applications) if (!SENT.has(row.status)) notSent[row.status] = (notSent[row.status] ?? 0) + 1;
  const pending = [...all.flatMap((entry) => entry.stages.filter((stage) => stage.open).map((stage) => ({ ...stage, company: entry.name }))),
    ...unmatched.filter((mail) => mail.open).map((mail) => ({ ...mail, company: null }))]
    .sort((a, b) => (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity) || a.at.localeCompare(b.at));
  return {
    generatedAt: input.now.toISOString(),
    timeZone: input.timeZone,
    funnel: {
      rows: input.applications.length, applied: sent.length, confirmed: sent.filter((row) => row.status === "VERIFIED").length, companies: all.length,
      rejected: all.filter((entry) => entry.rejections.length).length, invited: all.filter((entry) => entry.stages.length).length,
      passed: [1, 2, 3, 4].map((stage) => all.filter((entry) => entry.stages.length > stage).length), offers: all.filter((entry) => entry.offers.length).length,
      noReply: all.filter((entry) => entry.outcome === "NO_REPLY").length, pending: pending.length
    },
    notSent,
    platforms: [...platforms.values()].map(({ companies: set, ...rest }) => ({ ...rest, companies: set.size, rejected: [...set].filter((entry) => entry.rejections.length).length,
      invited: [...set].filter((entry) => entry.stages.length).length })).sort((a, b) => b.applied - a.applied || a.platform.localeCompare(b.platform)),
    weeks: [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)),
    pending,
    unmatched: unmatched.sort((a, b) => b.at.localeCompare(a.at)),
    companies: all.sort((a, b) => a.name.localeCompare(b.name)),
    applications: applications.sort((a, b) => (b.appliedAt ?? b.createdAt).localeCompare(a.appliedAt ?? a.createdAt))
  };
}
