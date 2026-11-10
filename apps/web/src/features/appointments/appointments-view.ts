import { useCallback, useEffect, useState } from "react";
import type { Appointment, AppointmentList, UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { Calendar, Phone, Timer, Users, Video, type LucideIcon } from "../ui-theme/app-icons.js";
import { browserTimeZone, formatAppDate, formatAppTime, useDateTimeSettings, type DateTimeSettings } from "../date-time-settings/date-time-settings.js";
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
export const isoToZonedInput = (iso: string, zone: string) => { const local = wall(Date.parse(iso), zone); return `${local.date}T${local.time}`; };

/** The location's first web address (a Teams link followed by its meeting ID and passcode stays a link) and the text around it. */
export function appointmentLink(location: string | null): { href: string; host: string; rest: string } | null {
  const href = location?.match(/https?:\/\/\S+/i)?.[0].replace(/[),.;:]+$/, "");
  if (!location || !href) return null;
  try { return { href, host: new URL(href).hostname, rest: location.replace(href, "").trim() }; } catch { return null; }
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
