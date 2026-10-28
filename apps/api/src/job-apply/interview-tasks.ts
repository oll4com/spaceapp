import { isValidTimeZone, ownerWorkingTimeZone, type NotificationListQuery, type NotificationRaiseInput, type SpaceNotification, type TaskItem } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { localParts } from "../owner-clock.js";
import { NOT_A_REQUEST } from "./mail-triage.js";

// Tests and interviews become reminder tasks (operator 2026-10-27 13:41 Bangkok): one open task per Gmail thread with the
// deadline in the operator's working time zone, and one reminder a day at 10:00 their time. The deadline is read from the
// mail itself; a mail that states none says so, and nothing is guessed.

export type InterviewTaskStore = Pick<SpaceStore, "listTaskItems" | "upsertTaskItem" | "updateTaskItem" | "getUserSettings">;
export interface InterviewNotifications {
  raise(input: NotificationRaiseInput): Promise<unknown>;
  list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = /\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})|(\d{4})-(\d{2})-(\d{2}))(?![\d-])/gi;
const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\b\.?)?`;
const TIME_AFTER_DATE = new RegExp(String.raw`[\s,]*(?:at\s+|@\s*|T)?${TIME}`, "iy");
const TIME_ANYWHERE = new RegExp(String.raw`(?<![\d:.])${TIME}(?![\d:])`, "gi");
const RANGE_END = new RegExp(String.raw`\s*(?:[-–]|to)\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\b\.?)?`, "iy");
// What may stand between a time and the date after it: a range end, a zone, "on", a weekday.
const TIME_TO_DATE_GAP = /^(?:\s*(?:[-–]|to)\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s?m\b\.?)?)?\s*(?:\(?[a-z][a-z +\-:\d/]{0,30}\)?)?[\s,]*(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?[\s,]+)?$/i;

// shortcut: abbreviations map to the region's IANA zone (an "EST" written in July reads as New York time); CST is left out
// because it is also China's. Upgrade to fixed offsets per abbreviation if a mail ever proves the colloquial reading wrong.
const ZONE_ABBREVIATIONS: Record<string, string> = {
  utc: "UTC", gmt: "UTC", z: "UTC", ist: "Asia/Kolkata", ict: "Asia/Bangkok", sgt: "Asia/Singapore", hkt: "Asia/Hong_Kong", jst: "Asia/Tokyo",
  kst: "Asia/Seoul", aest: "Australia/Sydney", aedt: "Australia/Sydney", cet: "Europe/Paris", cest: "Europe/Paris", eet: "Europe/Athens",
  eest: "Europe/Athens", bst: "Europe/London", est: "America/New_York", edt: "America/New_York", et: "America/New_York", cdt: "America/Chicago",
  ct: "America/Chicago", mst: "America/Denver", mdt: "America/Denver", mt: "America/Denver", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles"
};
const ZONE_NAMES: Array<[RegExp, string]> = [
  [/^indochina time/i, "Asia/Bangkok"], [/^india(n)? standard time/i, "Asia/Kolkata"], [/^(coordinated universal|greenwich mean) time/i, "UTC"],
  [/^central european (standard |summer )?time/i, "Europe/Paris"], [/^eastern european (standard |summer )?time/i, "Europe/Athens"],
  [/^british summer time/i, "Europe/London"], [/^singapore (standard )?time/i, "Asia/Singapore"], [/^pacific (standard |daylight )?time/i, "America/Los_Angeles"],
  [/^eastern (standard |daylight )?time/i, "America/New_York"], [/^central (standard |daylight )?time/i, "America/Chicago"],
  [/^mountain (standard |daylight )?time/i, "America/Denver"]
];

/** The zone written at the start of `text`: an IANA zone or a fixed offset in minutes; null when none is written there. */
function zoneAt(text: string): { zone: string } | { offset: number } | null {
  const head = text.replace(/^[\s,(]+/, "");
  // "GMT+7", "UTC+05:30", or an ISO offset written right after the time ("+05:30").
  const offset = /^(?:(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|([+-])(\d{2}):?(\d{2}))(?!\d)/i.exec(head);
  if (offset) {
    const [sign, hours, minutes] = offset[1] ? [offset[1], offset[2], offset[3]] : [offset[4], offset[5], offset[6]];
    return { offset: (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0)) };
  }
  for (const [pattern, zone] of ZONE_NAMES) if (pattern.test(head)) return { zone };
  const iana = /^([a-z]+)\s*[/-]\s*([a-z]+(?:_[a-z]+)*)/i.exec(head);
  const named = iana ? `${iana[1]![0]!.toUpperCase()}${iana[1]!.slice(1).toLowerCase()}/${iana[2]!.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase()).join("_")}` : null;
  if (named && named.includes("/") && isValidTimeZone(named)) return { zone: named };
  const abbreviation = /^([a-z]{1,5})(?![a-z])/i.exec(head)?.[1]?.toLowerCase();
  return abbreviation && ZONE_ABBREVIATIONS[abbreviation] ? { zone: ZONE_ABBREVIATIONS[abbreviation]! } : null;
}

function offsetMinutes(timeZone: string, atMs: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(new Date(atMs)).map((part) => [part.type, part.value]));
  return (Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - (atMs - (atMs % 60_000))) / 60_000;
}

function wallClockToUtc(wall: number, where: { zone: string } | { offset: number }): number {
  if ("offset" in where) return wall - where.offset * 60_000;
  const first = wall - offsetMinutes(where.zone, wall) * 60_000;
  return wall - offsetMinutes(where.zone, first) * 60_000;
}

function dayOf(match: RegExpExecArray): { year: number; month: number; day: number } | null {
  const [day, monthName, year] = match[1] ? [match[1], match[2], match[3]] : match[4] ? [match[5], match[4], match[6]] : [match[9], null, match[7]];
  const month = monthName === null ? Number(match[8]) - 1 : MONTHS.findIndex((name) => name.startsWith(monthName!.toLowerCase()));
  const date = new Date(Date.UTC(Number(year), month, Number(day)));
  return month >= 0 && date.getUTCDate() === Number(day) ? { year: Number(year), month, day: Number(day) } : null;
}

function clockOf(hour: string, minute: string | undefined, meridiem: string | undefined): number | null {
  if (minute === undefined && meridiem === undefined) return null;
  const [h, m] = [Number(hour), Number(minute ?? 0)];
  if (m > 59 || (meridiem ? h < 1 || h > 12 : h > 23)) return null;
  return ((meridiem ? (h % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0) : h) * 60 + m) * 60_000;
}

/** Every date with a time and a written zone in one sentence, as UTC milliseconds (a date or time without a zone is skipped). */
export function zonedDateTimes(sentence: string): number[] {
  const found: number[] = [];
  for (const match of sentence.matchAll(DATE)) {
    const day = dayOf(match);
    if (!day) continue;
    const start = match.index!;
    const end = start + match[0].length;
    const wallDay = Date.UTC(day.year, day.month, day.day);
    // "3 Nov 2026 09:31 AM IST", "October 20, 2026 at 11:59 PM PDT", "2026-11-03T09:31+05:30"
    TIME_AFTER_DATE.lastIndex = end;
    const after = TIME_AFTER_DATE.exec(sentence);
    const afterClock = after ? clockOf(after[1]!, after[2], after[3]) : null;
    if (after && afterClock !== null) {
      // A range ("10:00 - 10:30 ICT") keeps its start; the zone follows its end.
      RANGE_END.lastIndex = TIME_AFTER_DATE.lastIndex;
      const zone = zoneAt(sentence.slice(RANGE_END.exec(sentence) ? RANGE_END.lastIndex : TIME_AFTER_DATE.lastIndex));
      if (zone) { found.push(wallClockToUtc(wallDay + afterClock, zone)); continue; }
    }
    // "11:00 AM GMT+7 on Tuesday, November 3, 2026", "10:00am - 10:30am, Tuesday, November 3, 2026 (Indochina Time)"
    const times = [...sentence.slice(0, start).matchAll(TIME_ANYWHERE)].filter((time) => clockOf(time[1]!, time[2], time[3]) !== null);
    const last = times.at(-1);
    if (!last || !TIME_TO_DATE_GAP.test(sentence.slice(last.index! + last[0].length, start))) continue;
    const previous = times.at(-2);
    const first = previous && /^\s*(?:[-–]|to)\s*$/i.test(sentence.slice(previous.index! + previous[0].length, last.index!)) ? previous : last;
    const zone = zoneAt(sentence.slice(last.index! + last[0].length)) ?? zoneAt(sentence.slice(end));
    if (zone) found.push(wallClockToUtc(wallDay + clockOf(first[1]!, first[2], first[3])!, zone));
  }
  return found;
}

const SENTENCES = /\n+|(?<=[.!?])(?<!\b(?:[ap]\.m|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.)\s+/i;
const DEADLINE_WORDS = /\b(end|ends|due|deadline|expir\w*|by|before|until|no later than|clos\w*|submit|complete|finish)\b/i;
const SCHEDULE_WORDS = /\b(interview|scheduled|when|date|time|meeting|call|confirmed)\b/i;
// A test's start time is not its deadline; an interview's start is its time.
const START_ONLY = (sentence: string) => /\bstart/i.test(sentence) && !/\b(interview|meeting|call)\b/i.test(sentence);
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14 };
const COUNT = String.raw`(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|fourteen)`;
const RELATIVE = new RegExp(String.raw`\b(?:within(?: the next)?|in the next|in|due(?: in)?):?\s+${COUNT}\s+(?:calendar\s+)?(days?|hours?)\b|\b${COUNT}\s+(?:calendar\s+)?(days?|hours?)\s+to\s+(?:complete|finish|submit|take)\b`, "i");
const RELATIVE_ASK = /\b(complete|finish|submit|take|due|deadline|expir\w*|valid|available|respond|reply|book|schedule|attempt)\b/i;

/**
 * The deadline (or an interview's time) a test or interview mail states, as an ISO time: an explicit date and time with
 * its zone (a "due"/"end"/"by" sentence first, then a scheduled time), else "within N days" from when the mail was sent.
 * Null when the mail states none: never a guess.
 */
export function parseDeadline(text: string, sentAt: string | null): string | null {
  const sentences = text.slice(0, 8000).split(SENTENCES);
  const sent = sentAt ? Date.parse(sentAt) : Number.NaN;
  // A time before the mail was sent is a quoted header or a past date, not this mail's deadline.
  const plausible = (at: number) => !Number.isFinite(sent) || at >= sent - 60_000;
  // From the first deadline word on: "Start Login Date/Time: 27 Oct ... End Login Date/Time: 3 Nov ..." gives 3 Nov.
  for (const sentence of sentences.filter((s) => DEADLINE_WORDS.test(s))) {
    const at = zonedDateTimes(sentence.slice(sentence.search(DEADLINE_WORDS))).find(plausible);
    if (at !== undefined) return new Date(at).toISOString();
  }
  for (const sentence of sentences.filter((s) => SCHEDULE_WORDS.test(s) && !START_ONLY(s))) {
    const at = zonedDateTimes(sentence).find(plausible);
    if (at !== undefined) return new Date(at).toISOString();
  }
  if (!Number.isFinite(sent)) return null;
  for (const sentence of sentences) {
    const match = RELATIVE.exec(sentence);
    if (!match || NOT_A_REQUEST.test(sentence) || !RELATIVE_ASK.test(sentence)) continue;
    const count = match[1] ?? match[3]!;
    const amount = COUNT_WORDS[count.toLowerCase()] ?? Number(count);
    const hours = /^hour/i.test(match[2] ?? match[4]!) ? amount : amount * 24;
    if (amount > 0 && hours <= 60 * 24) return new Date(sent + hours * 3_600_000).toISOString();
  }
  return null;
}

const TEST_WORDS = /\b(assessments?|tests?|challenges?|exercises?|assignments?|quiz(zes)?|take[- ]home|coding|screening questions?|written questions?|hackerrank|codesignal|coderpad|testgorilla)\b/i;
export const requestKind = (text: string): "Test" | "Interview" => (TEST_WORDS.test(text) ? "Test" : "Interview");

const THREAD_LINE = "Gmail thread: ";
const DAY_MS = 86_400_000;
/** "Tue 3 Nov 11:01 GMT+7" in the owner's zone. */
const local = (iso: string, zone: string) => localParts(new Date(iso), zone).label;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The deadline a task records: an ISO time, null for "not stated", undefined when it is not a test or interview task. */
export function taskDeadline(task: Pick<TaskItem, "objective">): string | null | undefined {
  const line = /^Deadline: (\S+)/m.exec(task.objective)?.[1];
  if (line === undefined || !task.objective.includes(THREAD_LINE)) return undefined;
  return Number.isFinite(Date.parse(line)) ? new Date(line).toISOString() : null;
}

function taskText(base: string, kind: "Test" | "Interview", dueAt: string | null, zone: string, rest: string): { title: string; objective: string } {
  const when = dueAt ? local(dueAt, zone) : null;
  const title = `${base}, ${when ? (kind === "Test" ? `due ${when}` : when) : "deadline not stated"}`;
  const todo = kind === "Test" ? "Take the test before its deadline; the mail has the link." : "Go to the interview (or book its time); the mail has the details.";
  const missing = "The mail states no deadline: find it and record it (space_job_mail_deadline), or ask the recruiter.";
  return { title, objective: [base, `Deadline: ${dueAt ? `${dueAt} (${when})` : "not stated"}`, dueAt ? todo : `${todo} ${missing}`, rest].join("\n") };
}

export async function findThreadTask(store: InterviewTaskStore, owner: string, threadId: string): Promise<TaskItem | null> {
  const { items } = await store.listTaskItems(owner, { q: `${THREAD_LINE}${threadId}`, page: 1, pageSize: 10 });
  return items.find((task) => task.objective.includes(`${THREAD_LINE}${threadId} (`)) ?? null;
}

export interface InterviewRequest {
  account: string;
  threadId: string;
  subject: string;
  /** "Name <address>" */
  from: string;
  text: string;
  sentAt: string | null;
  application: { id: string; company: string; role: string } | null;
}

/** Another mail of the same pass that states the deadline the invitation leaves out. */
export interface SiblingDeadline { dueAt: string; from: string; threadId: string }
/** A mail read in the same triage pass, with the tracked company it names. */
export interface PassMail { threadId: string; company: string | null; sentAt: string | null; from: string; subject: string; text: string }
const SIBLING_WINDOW_MS = 3_600_000;

/**
 * The deadline a sibling mail states: the same tracked company, another thread, sent within an hour, about a test or an
 * interview (FINN 2026-10-26: HackerRank's invite states none, the recruiter's mail that minute says "within: 7 days").
 * shortcut: only mails read in the same pass; a recruiter mail that lands a pass later leaves the task for the copilot.
 */
export function siblingDeadline(request: InterviewRequest, mails: readonly PassMail[]): SiblingDeadline | null {
  const company = request.application?.company ?? null;
  const at = request.sentAt ? Date.parse(request.sentAt) : Number.NaN;
  if (!company || !Number.isFinite(at)) return null;
  for (const mail of mails) {
    const sent = mail.sentAt ? Date.parse(mail.sentAt) : Number.NaN;
    const text = `${mail.subject}\n${mail.text}`;
    if (mail.threadId === request.threadId || mail.company !== company || !(Math.abs(sent - at) <= SIBLING_WINDOW_MS) || !(TEST_WORDS.test(text) || /\binterview/i.test(text))) continue;
    const dueAt = parseDeadline(text, mail.sentAt);
    if (dueAt) return { dueAt, from: mail.from, threadId: mail.threadId };
  }
  return null;
}

/** Creates the thread's task, or updates it (reopened) when a later mail of the thread asks again. */
export async function recordInterviewTask(store: InterviewTaskStore, owner: string, request: InterviewRequest, sibling: SiblingDeadline | null = null): Promise<TaskItem> {
  const zone = ownerWorkingTimeZone(await store.getUserSettings(owner));
  const existing = await findThreadTask(store, owner, request.threadId);
  const mail = `${request.subject}\n${request.text}`;
  const own = parseDeadline(mail, request.sentAt);
  const from = own ? null : sibling;
  const dueAt = own ?? from?.dueAt ?? (existing ? taskDeadline(existing) ?? null : null);
  const kind = requestKind(mail);
  // The mail's subject names the test or interview; a tracked company with several roles cannot (FINN's React test is not its DevOps application).
  const subject = request.subject || "(no subject)";
  const company = request.application?.company;
  const who = company && !subject.toLowerCase().includes(company.toLowerCase()) ? `${company}: ${subject}` : subject;
  const rest = [...(from ? [`Deadline stated in: ${clip(from.from, 200)} (thread ${from.threadId}); this mail states none.`] : []), `From: ${clip(request.from, 200)}`, `Mail: "${clip(request.subject, 300)}"${request.sentAt ? ` sent ${local(request.sentAt, zone)}` : ""}`,
    `${THREAD_LINE}${request.threadId} (${request.account})`].join("\n");
  const { title, objective } = taskText(`${kind}: ${clip(who, 110)}`, kind, dueAt, zone, rest);
  if (existing) return store.updateTaskItem(owner, existing.id, { title, objective, status: "OPEN" });
  return store.upsertTaskItem({ ownerUserId: owner, title, objective, status: "OPEN", source: "AGENT" });
}

/** The deadline an agent read in the mail when the parser found none (or a wrong one); null when the thread has no task. */
export async function setInterviewDeadline(store: InterviewTaskStore, owner: string, threadId: string, dueAt: string): Promise<TaskItem | null> {
  const task = await findThreadTask(store, owner, threadId);
  if (!task) return null;
  const zone = ownerWorkingTimeZone(await store.getUserSettings(owner));
  const [base = task.title, , , ...rest] = task.objective.split("\n");
  const { title, objective } = taskText(base, base.startsWith("Interview:") ? "Interview" : "Test", new Date(dueAt).toISOString(), zone,
    rest.filter((line) => !line.startsWith("Deadline stated in: ")).join("\n"));
  return store.updateTaskItem(owner, task.id, { title, objective });
}

/** A later mail of the thread reports the test done, or rejects: the task is done (never deleted). */
export async function closeInterviewTask(store: InterviewTaskStore, owner: string, threadId: string): Promise<TaskItem | null> {
  const task = await findThreadTask(store, owner, threadId);
  return task && task.status === "OPEN" ? store.updateTaskItem(owner, task.id, { status: "DONE" }) : null;
}

/** The daily list: open ones soonest first ("not stated" last), "due in <24 h" marked, and deadlines passed in the last day once. */
export function renderInterviewReminder(tasks: readonly TaskItem[], nowMs: number): { title: string; body: string; taskIds: string[] } | null {
  const rows = tasks.filter((task) => task.status === "OPEN").map((task) => ({ task, due: taskDeadline(task) }))
    .filter((row): row is { task: TaskItem; due: string | null } => row.due !== undefined).map((row) => ({ ...row, at: row.due === null ? null : Date.parse(row.due) }));
  const open = rows.filter((row) => row.at === null || row.at > nowMs).sort((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity));
  // shortcut: "in the last day" counts from now, so a deadline within the timer's 15 minutes of 10:00 may show twice or not at all; keep the last reminder's time if that matters.
  const passed = rows.filter((row) => row.at !== null && row.at <= nowMs && row.at > nowMs - DAY_MS);
  if (!open.length && !passed.length) return null;
  const lines = [...open.map((row) => `- ${row.task.title}${row.at !== null && row.at - nowMs < DAY_MS ? " (due in <24 h)" : ""}`),
    ...passed.map((row) => `- ${row.task.title} (deadline passed)`)];
  return { title: `Tests and interviews: ${open.length} open`, body: clip(lines.join("\n"), 2000), taskIds: [...open, ...passed].map((row) => row.task.id) };
}

/**
 * ONE reminder a day at 10:00 in the owner's zone (after quiet hours), from the 15-minute triage timer: an ATTENTION
 * notification Nous takes into its inbox. Once per local day, also across restarts (the day's dedupe key is looked up).
 */
export async function remindInterviews(deps: { store: InterviewTaskStore; notifications: InterviewNotifications; sent: Set<string> }, owner: string, now: Date): Promise<boolean> {
  const zone = ownerWorkingTimeZone(await deps.store.getUserSettings(owner));
  if (localParts(now, zone).minutes < 600) return false;
  const dedupeKey = `job-apply:interviews:${new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now)}`;
  if (deps.sent.has(`${owner}|${dedupeKey}`)) return false;
  if ((await deps.notifications.list(owner, { status: "ALL", source: "JOB_COPILOT", limit: 200 })).some((item) => item.dedupeKey === dedupeKey)) {
    deps.sent.add(`${owner}|${dedupeKey}`);
    return false;
  }
  const reminder = renderInterviewReminder((await deps.store.listTaskItems(owner, { q: THREAD_LINE, status: "OPEN", page: 1, pageSize: 100 })).items, now.getTime());
  if (!reminder) return false;
  await deps.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "JOB_COPILOT", kind: "INTERVIEW_REMINDER", severity: "ATTENTION",
    title: reminder.title, body: reminder.body, link: {}, dedupeKey, payload: { taskIds: reminder.taskIds }, telegram: null });
  deps.sent.add(`${owner}|${dedupeKey}`);
  return true;
}
