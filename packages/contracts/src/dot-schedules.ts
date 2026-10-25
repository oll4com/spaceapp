import { z } from "zod";
import { dotIdSchema } from "./dots.js";

/**
 * Space Dots Stage 4: reminders and recurring work.
 *
 * A schedule belongs to one Dot conversation. Each occurrence sends a visible
 * message into that conversation when it is open, waits (up to a grace period)
 * when it is not or when the Dot is busy, and is then recorded as run or
 * skipped. Times are stored with their IANA time zone; a schedule a Dot
 * proposes is inactive until its owner confirms it.
 */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const dotScheduleRecurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ONCE"), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("DAILY"), time }).strict(),
  z.object({ kind: z.literal("WEEKLY"), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time }).strict(),
  z.object({ kind: z.literal("INTERVAL"), minutes: z.number().int().min(15).max(10080) }).strict()
]);
export const dotScheduleStatusSchema = z.enum(["PENDING_CONFIRMATION", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]);
export const dotScheduleSchema = z.object({
  scheduleId: z.string().regex(/^dot_schedule:[a-f0-9]{32}$/),
  dotId: dotIdSchema,
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(4000),
  recurrence: dotScheduleRecurrenceSchema,
  timeZone: z.string().min(1).max(80),
  status: dotScheduleStatusSchema,
  createdBy: z.enum(["USER", "DOT"]),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  lastOutcome: z.string().max(500).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}).strict();
export const createDotScheduleInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(4000),
  recurrence: dotScheduleRecurrenceSchema,
  timeZone: z.string().trim().min(1).max(80)
}).strict();
export const dotScheduleControlInputSchema = z.object({ action: z.enum(["CONFIRM", "PAUSE", "RESUME", "CANCEL"]) }).strict();
export type DotSchedule = z.infer<typeof dotScheduleSchema>;
export type DotScheduleRecurrence = z.infer<typeof dotScheduleRecurrenceSchema>;
export type CreateDotScheduleInput = z.infer<typeof createDotScheduleInputSchema>;
/** An occurrence that cannot run within this window is skipped and recorded. */
export const DOT_SCHEDULE_GRACE_MS = 12 * 60 * 60 * 1000;
/**
 * Occurrences of a schedule the user created run as ordinary turns. Occurrences
 * of a schedule the Dot proposed are proactive work: read-only tools and a
 * read-only sandbox, recognized by their request key.
 */
export const DOT_SCHEDULE_REQUEST_PREFIX = "schedule-";
export const DOT_PROACTIVE_REQUEST_PREFIX = "proactive-";
/** Proposed recurring work runs at most hourly. */
export const DOT_PROACTIVE_MIN_INTERVAL_MINUTES = 60;
export function isDotProactiveRequest(clientRequestId: string | null | undefined): boolean {
  return typeof clientRequestId === "string" && clientRequestId.startsWith(DOT_PROACTIVE_REQUEST_PREFIX);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); return true; } catch { return false; }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** One formatter per zone: building one costs about 8x formatting with it, and the Tasks calendar converts every repeat on every day. */
function zoneParts(utcMs: number, timeZone: string): Record<string, string> {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    zoneFormats.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
}
/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const parts = zoneParts(utcMs, timeZone);
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/** UTC instant of a wall-clock time in a zone (DST gaps resolve forward, overlaps to the first instant). */
export function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone);
  return result;
}
function localDate(utcMs: number, timeZone: string) {
  const parts = zoneParts(utcMs, timeZone);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day), weekday };
}

/** Next occurrence strictly after `afterMs`, or null when a one-time schedule has passed. */
export function nextDotScheduleRun(recurrence: DotScheduleRecurrence, timeZone: string, afterMs: number): number | null {
  if (recurrence.kind === "ONCE") { const at = Date.parse(recurrence.at); return at > afterMs ? at : null; }
  if (recurrence.kind === "INTERVAL") return afterMs + recurrence.minutes * 60_000;
  const [hour, minute] = recurrence.time.split(":").map(Number) as [number, number];
  const start = localDate(afterMs, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(start.year, start.month, start.day + offset));
    const candidate = zonedWallTimeToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, timeZone);
    if (candidate <= afterMs) continue;
    if (recurrence.kind === "WEEKLY" && !recurrence.days.includes(localDate(candidate, timeZone).weekday)) continue;
    return candidate;
  }
  return null;
}

export function describeDotScheduleRecurrence(recurrence: DotScheduleRecurrence, timeZone: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (recurrence.kind) {
    case "ONCE": return `Once at ${new Date(recurrence.at).toLocaleString("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" })} (${timeZone})`;
    case "DAILY": return `Every day at ${recurrence.time} (${timeZone})`;
    case "WEEKLY": return `Every ${recurrence.days.map((day) => days[day]).join(", ")} at ${recurrence.time} (${timeZone})`;
    case "INTERVAL": return `Every ${recurrence.minutes >= 60 && recurrence.minutes % 60 === 0 ? `${recurrence.minutes / 60} h` : `${recurrence.minutes} min`}`;
  }
}
