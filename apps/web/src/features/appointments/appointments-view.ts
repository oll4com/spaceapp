import { useCallback, useEffect, useState } from "react";
import { appointmentJoinUrl, appointmentSections, type Appointment, type AppointmentHours, type AppointmentInput, type AppointmentList, type AppointmentSectionKey,
  type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { Calendar, Phone, Timer, Users, Video, type LucideIcon } from "../ui-theme/app-icons.js";
import { browserTimeZone, formatAppDate, formatAppTime, formatDateByPattern, useDateTimeSettings, type DateFormat, type DateTimeSettings, type TimeFormat } from "../date-time-settings/date-time-settings.js";
import { dayLabel, shiftDay } from "../task-dock/calendar-days.js";
import { uiText } from "../ui-language/ui-language.js";

// What the Appointments pane and Nous's fullscreen card share (operator 2/11 15:22 BKK): times in the operator's working zone, countdowns.

export const APPOINTMENT_KIND_LABELS: Record<Appointment["kind"], string> = { CALL: "Call", INTERVIEW: "Interview", WEBINAR: "Webinar", DEADLINE: "Deadline", OTHER: "Other" };
/** One colour and icon per kind (operator 3/11): mid hues that read on the dark and the light room themes. */
export const APPOINTMENT_KIND_COLORS: Record<Appointment["kind"], string> = { CALL: "#4f9df7", INTERVIEW: "#a37ef5", WEBINAR: "#2bb8a3", DEADLINE: "#ec6a5e", OTHER: "#8f9aa6" };
export const APPOINTMENT_KIND_ICONS: Record<Appointment["kind"], LucideIcon> = { CALL: Phone, INTERVIEW: Users, WEBINAR: Video, DEADLINE: Timer, OTHER: Calendar };

function wall(ms: number, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23" }).formatToParts(ms).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Internal calendar keys and datetime-local values stay ISO-shaped, independent of display preferences. */
export const appointmentDay = (iso: string, zone: string) => wall(Date.parse(iso), zone).date;
export const appointmentClock = (iso: string, settings: DateTimeSettings) =>
  formatAppTime(iso, { hour: "2-digit", minute: "2-digit" }, settings);
export const appointmentDayLabel = (iso: string, settings: DateTimeSettings) =>
  formatAppDate(iso, { weekday: "short" }, settings);

/** "Sat 7/11" ("Σάβ 7/11"): weekday in the interface language, day and month in the chosen date order, no year (operator 6/11 11:02 BKK). */
export function appointmentShortDay(iso: string, settings: DateTimeSettings, language: UiLanguage): string {
  const day = appointmentDay(iso, settings.timeZone && settings.timeZone !== "system" ? settings.timeZone : browserTimeZone());
  const [, month, date] = day.split("-").map(Number);
  const dm = settings.dateFormat === "MM/DD/YYYY" ? `${month}/${date}` : settings.dateFormat === "YYYY-MM-DD" ? day.slice(5) : `${date}/${month}`;
  return `${dayLabel(day, { weekday: "short" }, language === "el" ? "el-GR" : "en-GB")} ${dm}`;
}

/** A day key is already in the display zone: format its date without shifting it a second time. */
export const appointmentCalendarDayLabel = (day: string, settings: DateTimeSettings, weekday?: "short" | "long") =>
  formatAppDate(`${day}T12:00:00Z`, { timeZone: "UTC", ...(weekday ? { weekday } : {}) }, settings);

/** Month headings retain the selected pattern's month/year order and year length. */
export function appointmentMonthLabel(day: string, settings: DateTimeSettings): string {
  const date = appointmentCalendarDayLabel(day, settings);
  return settings.dateFormat === "YYYY-MM-DD" ? date.slice(0, 7)
    : settings.dateFormat === "MM/DD/YYYY" ? `${date.slice(0, 2)}/${date.slice(6)}` : date.slice(3);
}

export const appointmentWhen = (item: Appointment, byDeadline = false): string => (byDeadline && item.deadlineAt ? item.deadlineAt : item.startsAt);

/** Appointments by their local day, in the order given. */
export function appointmentsByDay(items: Appointment[], zone: string, byDeadline = false): Map<string, Appointment[]> {
  const ordered = byDeadline
    ? [...items].sort((a, b) => Date.parse(appointmentWhen(a, true)) - Date.parse(appointmentWhen(b, true)))
    : items;
  const days = new Map<string, Appointment[]>();
  for (const item of ordered) {
    const day = appointmentDay(appointmentWhen(item, byDeadline), zone);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return days;
}
/** "Today", "Tomorrow", "Yesterday" or nothing, for a local day against today's. */
export const appointmentRelativeDay = (day: string, today: string) =>
  day === today ? "Today" : day === shiftDay(today, 1) ? "Tomorrow" : day === shiftDay(today, -1) ? "Yesterday" : null;

/** "in 2 d 4 h", "in 3 h 5 min", "in 12 min", "now", "40 min ago"; in the interface language when given (operator 6/11, nous_msg:1affa0ad). */
export function appointmentCountdown(startsAt: string, nowMs: number, language: UiLanguage = "en"): string {
  const ms = Date.parse(startsAt) - nowMs;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) return uiText(language, "now");
  const [d, h, min] = [uiText(language, "d"), uiText(language, "h"), uiText(language, "min")];
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  const text = days ? `${days} ${d}${hours ? ` ${hours} ${h}` : ""}` : hours ? `${hours} ${h}${rest ? ` ${rest} ${min}` : ""}` : `${rest} ${min}`;
  return uiText(language, ms > 0 ? "in {time}" : "{time} ago", { time: text });
}

/** A datetime-local value ("2026-11-09T21:30") read in `zone`, as an ISO instant. */
export function zonedInputToIso(value: string, zone: string): string {
  const [date = "", time = "00:00"] = value.split("T");
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms: number) => { const local = wall(ms, zone); return Date.parse(`${local.date}T${local.time}:00Z`) - (ms - (ms % 60_000)); };
  // Twice: the offset at the guess, then at the instant it gives (a DST change between them).
  return new Date(guess - offset(guess - offset(guess))).toISOString();
}
// Typed dates and times in the operator's Settings format (operator 26/11, nous_msg:cfce1783: the native picker showed 01/31/2027); values stay ISO-shaped.
/** A day key ("2027-01-31") in the Settings date pattern ("31/01/2027"). */
export const appointmentDayText = (day: string, format: DateFormat = "DD/MM/YYYY") => formatDateByPattern(new Date(`${day}T12:00:00Z`), format, "UTC");
/** Typed text in the Settings date pattern as a day key; null when it is not a real date in that order. */
export function appointmentDayFromText(text: string, format: DateFormat = "DD/MM/YYYY"): string | null {
  const parts = text.trim().split(/[/.\-\s]+/);
  if (parts.length !== 3 || parts.some((part) => !/^\d{1,4}$/.test(part))) return null;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const [year, month, day] = format === "YYYY-MM-DD" ? [a, b, c] : format === "MM/DD/YYYY" ? [c, a, b] : [c, b, a];
  const full = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(full, month - 1, day));
  return full >= 1000 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
/** "14:30" as the Settings clock shows it ("2:30 PM" on 12-hour). */
export function appointmentTimeText(time: string, format: TimeFormat = "24h"): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return format === "12h" ? `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}` : time;
}
/** Typed time ("14:30", "9", "2:30 pm") as "HH:MM"; null when it is not one. */
export function appointmentTimeFromText(text: string): string | null {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])?\.?\s*m?\.?$/i.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (match[3]) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (/p/i.test(match[3]) ? 12 : 0); }
  return hour < 24 && minute < 60 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
}

/** "Weekdays until 24/11/2026" for a recurring one; null for a one-off. */
export function appointmentRecurrenceLabel(item: Pick<Appointment, "recurrence">, settings: DateTimeSettings, language: UiLanguage = "en"): string | null {
  const rule = item.recurrence;
  if (!rule) return null;
  return uiText(language, rule.every === "WEEKDAY" ? "Weekdays until {day}" : "Every day until {day}", { day: appointmentDayText(rule.until, settings.dateFormat) });
}

/**
 * Completed on a recurring one completes its whole period (operator 26/11, nous_msg:cfce1783): it asks first, in the interface language; Cancel
 * changes nothing. A one-off one goes straight.
 */
export function appointmentCompleteAllowed(item: Pick<Appointment, "recurrence">, settings: DateTimeSettings, language: UiLanguage,
  confirm: (options: { title: string; message: string; confirmLabel: string; cancelLabel: string; tone: "primary" }) => Promise<boolean>): Promise<boolean> {
  const rule = appointmentRecurrenceLabel(item, settings, language);
  if (!rule) return Promise.resolve(true);
  const t = (text: string, vars?: Record<string, string>) => uiText(language, text, vars);
  return confirm({ title: t("Complete the whole series?"), message: t("Completed applies to the whole period and all its repetitions ({rule}). Yes completes it for every day.", { rule }),
    confirmLabel: t("Yes"), cancelLabel: t("Cancel"), tone: "primary" });
}

// Post-call notes and a recontact date from the record (operator 25/11 16:52 BKK, nous_msg:805b311060d04be19dd8ca26).
const HEADINGS: Partial<Record<AppointmentSectionKey, string>> = { after: "ΣΗΜΕΙΩΣΕΙΣ ΜΕΤΑ ΤΗΝ ΚΛΗΣΗ", recontact: "ΕΠΑΝΕΠΙΚΟΙΝΩΝΙΑ", recontactOf: "ΣΥΝΕΧΕΙΑ ΤΟΥ" };
export const appointmentAfterCall = (notes: string | null) => appointmentSections(notes).find((section) => section.key === "after")?.text ?? "";
/** The notes with their `key` section replaced by `text` (dropped when empty), at the end. */
function notesWith(notes: string | null, key: AppointmentSectionKey, text: string): string {
  const kept = appointmentSections(notes).filter((section) => section.key !== key).map((section) => (section.heading ? `${section.heading}: ${section.text}` : section.text));
  return [...kept, ...(text.trim() ? [`${HEADINGS[key]}: ${text.trim()}`] : [])].join("\n");
}
export const appointmentNotesWithAfterCall = (notes: string | null, text: string) => notesWith(notes, "after", text);

/**
 * Set recontact (operator 26/11 11:08 BKK, nous_msg:cfce1783): a new record carrying everything of `item` (title, kind, format, link, every
 * section with its Agent Files, the post-call notes) as a FLEXIBLE call on `day` within the appointment hours, one per original
 * (`followup:<id>`, so a second date moves it); `closed` completes the original and names the new one, and the new one names it back.
 */
export function appointmentRecontact(item: Appointment, day: string, hours: AppointmentHours, afterCall: string, settings: DateTimeSettings) {
  const own = appointmentSections(item.notes);
  const has = (key: AppointmentSectionKey) => own.some((section) => section.key === key && section.text);
  // An older record without a required section still gets one, so the server takes the copy.
  const missing = ([["what", `ΤΙ ΕΙΝΑΙ: Επανεπικοινωνία μετά το «${item.title}».`], ["join", "ΕΙΣΟΔΟΣ: Mail ή κλήση στην ίδια επαφή· no sign-in."],
    ["why", `ΓΙΑΤΙ ΑΞΙΖΕΙ: Συνέχεια του «${item.title}».`], ["prepare", `ΤΙ ΧΡΕΙΑΖΕΣΑΙ: Τις σημειώσεις μετά την κλήση στο ${item.id}.`],
    ["source", `ΠΗΓΗ: ${item.id}${item.sourceRef ? ` (${item.sourceRef})` : ""}`]] as const).filter(([key]) => !has(key)).map(([, line]) => line);
  const notes = notesWith(item.notes, "after", afterCall);
  const previous = `«${item.title}» ${appointmentDayText(appointmentDay(item.startsAt, item.timeZone), settings.dateFormat)} (${item.id})`;
  const copied = notesWith([notesWith(notes, "recontact", ""), ...missing].join("\n"), "recontactOf", previous);
  const input: AppointmentInput = {
    title: item.title, kind: item.kind, format: item.format ?? "OTHER", timing: "FLEXIBLE", location: item.location, timeZone: hours.timeZone,
    startsAt: zonedInputToIso(`${day}T${hours.start}`, hours.timeZone), deadlineAt: zonedInputToIso(`${day}T${hours.end}`, hours.timeZone),
    sourceRef: `followup:${item.id}`, notes: copied
  };
  return { input, closed: (created: Pick<Appointment, "id">) => notesWith(notes, "recontact", `${appointmentDayText(day, settings.dateFormat)} (${created.id})`) };
}
export const isoToZonedInput = (iso: string, zone: string) => { const local = wall(Date.parse(iso), zone); return `${local.date}T${local.time}`; };

/**
 * The join link: the location's first web address (a Teams link followed by its meeting ID and passcode stays a link), else the HOW TO JOIN
 * (ΕΙΣΟΔΟΣ) line's (operator 13/11 16:00 BKK: a button to open, never the link as text), and the location's other text.
 */
export function appointmentLink(item: Pick<Appointment, "location" | "notes">): { href: string; host: string; rest: string } | null {
  const href = appointmentJoinUrl(item);
  return href ? { href, host: new URL(href).hostname, rest: (item.location ?? "").replace(href, "").trim() } : null;
}

/** The list, read again every minute while shown, and a clock for the countdowns. */
export function useAppointments(when: "upcoming" | "past" | "all", active = true) {
  const { settings } = useDateTimeSettings();
  const zone = settings.timeZone === "system" ? browserTimeZone() : settings.timeZone;
  const [list, setList] = useState<AppointmentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(async () => {
    try {
      const next = await api.appointments(when);
      setList(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Appointments could not be read.");
    }
  }, [when]);
  useEffect(() => {
    if (!active) return;
    setList(null);
    void reload();
    const read = window.setInterval(() => void reload(), 60_000);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { window.clearInterval(read); window.clearInterval(tick); };
  }, [active, reload]);
  return { list, error, reload, now, settings, zone };
}
