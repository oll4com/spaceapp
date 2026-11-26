import { z } from "zod";
import { APPOINTMENT_FORMATS } from "./appointments.js";
import { isValidTimeZone } from "./dot-schedules.js";

// What every upcoming appointment must hold (operator 4/11 14:39 BKK, nous_msg:a60162597d984866b79b9a2f «όλες αυτές οι πληροφορίες
// πρέπει ΠΑΝΤΑ να είναι μέσα στο ραντεβού … ΥΠΟΧΡΕΩΤΙΚΟ»): sections of its notes, a heading at a line's start, in English or Greek
// (the operator's records use the Greek ones). The server refuses an UPCOMING one that misses a required section; the pane shows them.

export const APPOINTMENT_SECTIONS = {
  what: ["WHAT IT IS", "WHAT", "ΤΙ ΕΙΝΑΙ"],
  time: ["TIME", "ΩΡΑ"],
  topic: ["TOPIC", "ΘΕΜΑ"],
  join: ["HOW TO JOIN", "JOIN", "ΕΙΣΟΔΟΣ"],
  why: ["WHY IT MATTERS", "WHY", "ΓΙΑΤΙ ΑΞΙΖΕΙ"],
  prepare: ["WHAT YOU NEED", "PREPARE", "ΤΙ ΧΡΕΙΑΖΕΣΑΙ"],
  source: ["SOURCE", "ΠΗΓΗ"],
  // Operator 25/11 (nous_msg:805b3110): notes written after the call, from the record's editor; optional.
  after: ["AFTER THE CALL", "POST-CALL NOTES", "ΣΗΜΕΙΩΣΕΙΣ ΜΕΤΑ ΤΗΝ ΚΛΗΣΗ"],
  // Operator 26/11 (nous_msg:cfce1783): Set recontact links the two records, each naming the other's date and id; optional.
  recontact: ["RECONTACT", "ΕΠΑΝΕΠΙΚΟΙΝΩΝΙΑ"],
  recontactOf: ["RECONTACT OF", "ΣΥΝΕΧΕΙΑ ΤΟΥ"]
} as const;
export type AppointmentSectionKey = keyof typeof APPOINTMENT_SECTIONS;

/** The one-line rule every writer reads (tool descriptions, the refusal). */
export const APPOINTMENT_CONTENT_RULE = "An UPCOMING appointment's notes need these sections, each on its own line as `HEADING: text` (English or Greek headings): "
  + "WHAT IT IS (ΤΙ ΕΙΝΑΙ: company and role or the event, and what kind it is, e.g. not a test), HOW TO JOIN (ΕΙΣΟΔΟΣ: the link or exact place and the account "
  + "to sign in with and how its code arrives, or \"no sign-in\"), WHY IT MATTERS (ΓΙΑΤΙ ΑΞΙΖΕΙ), WHAT YOU NEED (ΤΙ ΧΡΕΙΑΖΕΣΑΙ: what to prepare or bring, "
  + "the prep file's artifact id when there is one), SOURCE (ΠΗΓΗ: the mail thread or task); TIME (ΩΡΑ: with the source time zone, e.g. join 5 min early) "
  + "and TOPIC (ΘΕΜΑ) when known.";

const REQUIRED: Array<[AppointmentSectionKey, string]> = [
  ["what", "WHAT IT IS (company and role, or the event, and its type)"],
  ["join", "HOW TO JOIN (the link or exact place)"],
  ["why", "WHY IT MATTERS"],
  ["prepare", "WHAT YOU NEED (what to prepare or bring)"],
  ["source", "SOURCE (the mail thread or task)"]
];
// Read on the folded text: "Λογαριασμός: x@y", "Δεν χρειάζεται λογαριασμός", "σύνδεση με …", "Account: …", "no sign-in", "your personal Gmail", the address.
const ACCOUNT = /ACCOUNT|SIGN[- ]?IN|LOG[- ]?IN|ΛΟΓΑΡΙΑΣΜ|ΣΥΝΔΕΣ|GMAIL|[\w.+-]+@[\w-]+\.[\w.-]+/;

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();
const HEADINGS = new Map<string, AppointmentSectionKey>(Object.entries(APPOINTMENT_SECTIONS).flatMap(([key, names]) => names.map((name) => [name, key as AppointmentSectionKey] as const)));

export interface AppointmentSection { key: AppointmentSectionKey | null; heading: string | null; text: string }

/** The notes as sections in their order; text before the first heading is a section without one. */
export function appointmentSections(notes: string | null | undefined): AppointmentSection[] {
  const sections: AppointmentSection[] = [];
  for (const line of (notes ?? "").split("\n")) {
    const match = /^\s*([^:\n]{2,30}):[ \t]*(.*)$/.exec(line);
    const key = match ? HEADINGS.get(fold(match[1]!)) : undefined;
    if (match && key) sections.push({ key, heading: match[1]!.trim(), text: match[2]! });
    else if (sections.length) sections[sections.length - 1]!.text += `\n${line}`;
    else sections.push({ key: null, heading: null, text: line });
  }
  return sections.map((section) => ({ ...section, text: section.text.trim() })).filter((section) => section.heading || section.text);
}

/** What an UPCOMING appointment still misses, by the names the refusal gives; none for DONE and CANCELLED ones. */
export function appointmentContentMissing(item: { status?: string | null; notes?: string | null }): string[] {
  if (item.status && item.status !== "UPCOMING") return [];
  const text = new Map<AppointmentSectionKey, string>();
  for (const section of appointmentSections(item.notes)) if (section.key) text.set(section.key, `${text.get(section.key) ?? ""}\n${section.text}`.trim());
  const missing = REQUIRED.filter(([key]) => !text.get(key)).map(([, name]) => name);
  if (text.get("join") && !ACCOUNT.test(fold(text.get("join")!))) missing.push("the account HOW TO JOIN signs in with (or \"no sign-in\")");
  return missing;
}

// Operator 17/11 09:54 BKK (nous_msg:266ee062, replaces 6/11's 11:00-18:00 and its 21:00 time-zone exception): every appointment starts at or
// after `start` and ENDS by `end` in `timeZone` (null: the owner's working zone), Settings → Notifications → Appointment hours.
const clockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 hours).");
export const appointmentHoursSchema = z.object({
  start: clockSchema.default("11:00"),
  end: clockSchema.default("20:00"),
  timeZone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Use an IANA time zone such as Asia/Bangkok.").nullable().default(null)
}).strict().refine((hours) => hours.start < hours.end, "Appointment hours end after they start.");
export type AppointmentHoursSetting = z.infer<typeof appointmentHoursSchema>;
/** The hours with their zone resolved. */
export interface AppointmentHours { start: string; end: string; timeZone: string }

/** The owner's appointment hours: the setting (its defaults when unset or invalid), its zone else `workingZone`. */
export function appointmentHoursOf(setting: unknown, workingZone: string): AppointmentHours {
  const parsed = appointmentHoursSchema.safeParse(setting ?? {});
  const hours = parsed.success ? parsed.data : appointmentHoursSchema.parse({});
  return { start: hours.start, end: hours.end, timeZone: hours.timeZone ?? workingZone };
}

/** The line agents read before they propose, book or accept a time (Nous's world, the tools' answers). */
export const appointmentHoursRule = (hours: AppointmentHours) => `Appointment hours (Settings → Notifications): ${hours.start}-${hours.end} ${hours.timeZone}. `
  + `Every time you propose, book or accept starts at or after ${hours.start} and ends by ${hours.end} there (a 30-minute call at `
  + `${clockMinus(hours.end, 15)} is outside); convert the other side's zone first. A fixed time the other side set outside them is kept, marked outOfHours: ask them to move it.`;
const clockMinus = (clock: string, by: number) => { const at = minutes(clock) - by; return `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`; };

export const APPOINTMENT_SCHEDULE_RULE = `An UPCOMING appointment also needs format (${APPOINTMENT_FORMATS.join(" | ")}: who or what is on the other side) and timing `
  + "(FIXED: only at that exact start; FLEXIBLE: can be done any time until deadlineAt, which it then needs). Every time we propose, book or "
  + "accept starts and ends within the operator's appointment hours (space_appointments returns them as `hours`); a FLEXIBLE one outside them is "
  + "refused; a FIXED one the other side set outside them is kept and marked outOfHours, and the other side is asked to move it. One joined online (format "
  + "AI_INTERVIEW | RECORDED_VIDEO | LIVE_HUMAN_VIDEO | WEBINAR | TEST) needs location to start with its real join link as an http(s) URL, taken from "
  + "the mail or invite (for a button that exists only in the mail, the Gmail thread URL), never text such as \"link in the mail\"; PHONE and "
  + "IN_PERSON may give a number or place as text.";

// Operator 13/11 16:00 BKK («link μέσα στο ραντεβού να το ανοίγω, όχι κείμενο»): an online one's location is the link the operator opens.
export const APPOINTMENT_ONLINE_FORMATS = ["AI_INTERVIEW", "RECORDED_VIDEO", "LIVE_HUMAN_VIDEO", "WEBINAR", "TEST"] as const;
const WEB_ADDRESS = /https?:\/\/[^\s<>"«»]+[^\s<>"«»),.;:!?]/i;
const webAddress = (text: string | null | undefined): string | null => {
  const href = WEB_ADDRESS.exec(text ?? "")?.[0];
  try { return href && new URL(href) ? href : null; } catch { return null; }
};

const startsWithLink = (location: string | null | undefined) => {
  const link = webAddress(location);
  return Boolean(link && location!.trim().startsWith(link));
};

/** The link to join by: the first web address in location, else in its HOW TO JOIN (ΕΙΣΟΔΟΣ) notes. */
export function appointmentJoinUrl(item: { location?: string | null; notes?: string | null }): string | null {
  return webAddress(item.location) ?? appointmentSections(item.notes).filter((section) => section.key === "join").map((section) => webAddress(section.text)).find(Boolean) ?? null;
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const minuteOfDay = (iso: string, zone: string) =>
  minutes(new Date(iso).toLocaleTimeString("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }));

/** Whether it starts at or after `hours.start` and ends by `hours.end` in their zone. Without an end it takes its start minute; past midnight is outside. */
export function appointmentWithinHours(item: { startsAt: string; endsAt?: string | null }, hours: AppointmentHours): boolean {
  const start = minuteOfDay(item.startsAt, hours.timeZone);
  const end = start + Math.max(1, (Date.parse(item.endsAt ?? item.startsAt) - Date.parse(item.startsAt)) / 60_000);
  return start >= minutes(hours.start) && end <= minutes(hours.end);
}

/** An UPCOMING meeting (not a DEADLINE, a cut-off) outside the hours: the flag Nous and the copilots read to ask the other side to move it. */
export function appointmentOutOfHours(item: { status?: string | null; kind?: string | null; startsAt: string; endsAt?: string | null }, hours: AppointmentHours): string | null {
  return item.status === "UPCOMING" && item.kind !== "DEADLINE" && !appointmentWithinHours(item, hours)
    ? `OUT_OF_HOURS: outside the appointment hours ${hours.start}-${hours.end} ${hours.timeZone}; ask the other side to move it into them.` : null;
}

/** What an UPCOMING appointment's format and time still miss or break, by the names the refusal gives; none for DONE and CANCELLED ones. */
export function appointmentScheduleMissing(item: { status?: string | null; format?: string | null; timing?: string | null; deadlineAt?: string | null;
  startsAt: string; endsAt?: string | null; notes?: string | null; location?: string | null }, hours: AppointmentHours): string[] {
  if (item.status && item.status !== "UPCOMING") return [];
  const missing: string[] = [];
  if (!item.format) missing.push(`format (${APPOINTMENT_FORMATS.join(" | ")})`);
  else if ((APPOINTMENT_ONLINE_FORMATS as readonly string[]).includes(item.format) && !startsWithLink(item.location)) {
    missing.push(`location that starts with the real join link as an http(s) URL (${item.format} is joined online; from the mail or invite, `
      + "for a button only in the mail the Gmail thread URL), not text");
  }
  if (!item.timing) missing.push("timing (FIXED or FLEXIBLE)");
  if (item.timing !== "FLEXIBLE") return missing;
  if (!item.deadlineAt) missing.push("deadlineAt (a FLEXIBLE one can be done any time until it)");
  else if (Date.parse(item.deadlineAt) < Date.parse(item.endsAt ?? item.startsAt)) missing.push("a deadlineAt at or after its end");
  if (!appointmentWithinHours(item, hours)) {
    missing.push(`a time within the appointment hours ${hours.start}-${hours.end} ${hours.timeZone}: start at or after ${hours.start}, end by ${hours.end} `
      + "(a FLEXIBLE one is timed by us)");
  }
  return missing;
}
