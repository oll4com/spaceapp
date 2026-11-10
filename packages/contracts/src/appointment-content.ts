import { APPOINTMENT_FORMATS } from "./appointments.js";

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
  /** Why a FLEXIBLE one we time may run past 18:00 (to 21:00): the other side's time zone. */
  late: ["TIME ZONE REASON", "ΛΟΓΟΣ ΖΩΝΗΣ ΩΡΑΣ"]
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

// Operator 6/11 10:15 BKK (nous_msg:ea6f0792 «μετά τις 11:00 και πριν τις 18:00 ώρα Ταϊλάνδης, εκτός αν η διαφορά ώρας … ως 21:00»): the hours
// a time we choose (FLEXIBLE) must fall in, in the owner's working zone; a FIXED one the other side set is kept and flagged outside them.
export const APPOINTMENT_HOURS = { from: "11:00", to: "18:00", lateTo: "21:00" } as const;
export const APPOINTMENT_SCHEDULE_RULE = `An UPCOMING appointment also needs format (${APPOINTMENT_FORMATS.join(" | ")}: who or what is on the other side) and timing `
  + "(FIXED: only at that exact start; FLEXIBLE: can be done any time until deadlineAt, which it then needs). A FLEXIBLE one's time (start to end) must be "
  + `within ${APPOINTMENT_HOURS.from}-${APPOINTMENT_HOURS.to} in the operator's zone, to ${APPOINTMENT_HOURS.lateTo} only with a TIME ZONE REASON (ΛΟΓΟΣ ΖΩΝΗΣ ΩΡΑΣ) `
  + "line in its notes saying which time zone forces it. FIXED times the other side set are kept as they are.";

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const minuteOfDay = (iso: string, zone: string) =>
  minutes(new Date(iso).toLocaleTimeString("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }));

/** Whether start to end (the start alone without one) lies within the operator's hours in `zone`; `late` allows to 21:00. Past midnight is outside. */
export function appointmentWithinHours(item: { startsAt: string; endsAt?: string | null }, zone: string, late = false): boolean {
  const start = minuteOfDay(item.startsAt, zone);
  const end = start + Math.max(0, Date.parse(item.endsAt ?? item.startsAt) - Date.parse(item.startsAt)) / 60_000;
  return start >= minutes(APPOINTMENT_HOURS.from) && end <= minutes(late ? APPOINTMENT_HOURS.lateTo : APPOINTMENT_HOURS.to);
}

/** What an UPCOMING appointment's format and time still miss or break, by the names the refusal gives; none for DONE and CANCELLED ones. */
export function appointmentScheduleMissing(item: { status?: string | null; format?: string | null; timing?: string | null; deadlineAt?: string | null;
  startsAt: string; endsAt?: string | null; notes?: string | null }, zone: string): string[] {
  if (item.status && item.status !== "UPCOMING") return [];
  const missing: string[] = [];
  if (!item.format) missing.push(`format (${APPOINTMENT_FORMATS.join(" | ")})`);
  if (!item.timing) missing.push("timing (FIXED or FLEXIBLE)");
  if (item.timing !== "FLEXIBLE") return missing;
  if (!item.deadlineAt) missing.push("deadlineAt (a FLEXIBLE one can be done any time until it)");
  else if (Date.parse(item.deadlineAt) < Date.parse(item.endsAt ?? item.startsAt)) missing.push("a deadlineAt at or after its end");
  const late = appointmentSections(item.notes).some((section) => section.key === "late" && section.text);
  if (!appointmentWithinHours(item, zone, late)) {
    missing.push(`a time within ${APPOINTMENT_HOURS.from}-${late ? APPOINTMENT_HOURS.lateTo : APPOINTMENT_HOURS.to} ${zone} (a FLEXIBLE one is timed by us`
      + `${late ? "" : `; to ${APPOINTMENT_HOURS.lateTo} only with a TIME ZONE REASON line`})`);
  }
  return missing;
}
