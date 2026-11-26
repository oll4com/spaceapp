import { z } from "zod";

// The operator's appointments (operator 2/11 15:22 BKK, brief nous/briefs/20261102-appointments-pane.md): calls, interviews,
// webinars and deadlines in one list, reminded automatically before each (Settings → Notifications → Appointment reminders).
const isoDateTime = z.string().datetime({ offset: true });

export const APPOINTMENT_KINDS = ["CALL", "INTERVIEW", "WEBINAR", "DEADLINE", "OTHER"] as const;
export const APPOINTMENT_STATUSES = ["UPCOMING", "DONE", "CANCELLED"] as const;
export const appointmentKindSchema = z.enum(APPOINTMENT_KINDS);
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
// Operator 6/11 10:15 BKK (nous_msg:ea6f0792): what the meeting is (who or what is on the other side) and whether its time is strict or "any time until".
export const APPOINTMENT_FORMATS = ["AI_INTERVIEW", "RECORDED_VIDEO", "LIVE_HUMAN_VIDEO", "PHONE", "IN_PERSON", "WEBINAR", "TEST", "OTHER"] as const;
/** FIXED: only at startsAt exactly. FLEXIBLE: any time until deadlineAt (startsAt is when we plan to do it). */
export const APPOINTMENT_TIMINGS = ["FIXED", "FLEXIBLE"] as const;
export const appointmentFormatSchema = z.enum(APPOINTMENT_FORMATS);
export const appointmentTimingSchema = z.enum(APPOINTMENT_TIMINGS);
// Operator 26/11 11:08 BKK (nous_msg:cfce1783): a call every day (or weekday) of a period; `until` is the last day, in the appointment's own zone.
export const APPOINTMENT_REPEATS = ["DAY", "WEEKDAY"] as const;
export const appointmentRecurrenceSchema = z.object({ every: z.enum(APPOINTMENT_REPEATS), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.") }).strict();
export type AppointmentRecurrence = z.infer<typeof appointmentRecurrenceSchema>;

// Without defaults, so a partial update never resets a field it does not name.
const appointmentFields = z.object({
  title: z.string().trim().min(1).max(300),
  startsAt: isoDateTime,
  endsAt: isoDateTime.nullable().optional(),
  /** The zone the appointment was booked in; the owner's working zone when absent. */
  timeZone: z.string().trim().min(1).max(64).optional(),
  kind: appointmentKindSchema,
  /** A place or a meeting link. */
  location: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  /** Where it came from: `task:<id>`, `gmail:<account>:<threadId>`, `clipboard:<id>`; one appointment per source. */
  sourceRef: z.string().trim().min(1).max(300).nullable().optional(),
  // Required on an UPCOMING one by the write check (apps/api appointment-content.ts); null on rows older than the rule.
  format: appointmentFormatSchema.nullable().optional(),
  timing: appointmentTimingSchema.nullable().optional(),
  deadlineAt: isoDateTime.nullable().optional(),
  /** Repeats at the same wall time every day or weekday until a day; startsAt/endsAt are the first (or current) occurrence. */
  recurrence: appointmentRecurrenceSchema.nullable().optional()
}).strict();
export const appointmentInputSchema = appointmentFields.extend({ kind: appointmentKindSchema.default("OTHER") }).strict();
export type AppointmentInput = z.input<typeof appointmentInputSchema>;

export const appointmentUpdateSchema = appointmentFields.partial().extend({ status: appointmentStatusSchema.optional() }).strict();
export type AppointmentUpdate = z.input<typeof appointmentUpdateSchema>;

export const appointmentSchema = z.object({
  id: z.string().min(1),
  ownerUserId: z.string().min(1),
  title: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime.nullable(),
  timeZone: z.string(),
  kind: appointmentKindSchema,
  location: z.string().nullable(),
  notes: z.string().nullable(),
  sourceRef: z.string().nullable(),
  format: appointmentFormatSchema.nullable(),
  timing: appointmentTimingSchema.nullable(),
  deadlineAt: isoDateTime.nullable(),
  recurrence: appointmentRecurrenceSchema.nullable().optional(),
  status: appointmentStatusSchema,
  /** The reminder lead times (minutes) already sent for this start time; a new start time clears it. */
  remindersSent: z.array(z.number().int()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /** Set by the service on an UPCOMING meeting outside the owner's appointment hours (a FIXED time the other side set): ask them to move it. */
  outOfHours: z.string().optional()
}).strict();
export type Appointment = z.infer<typeof appointmentSchema>;

export const appointmentListQuerySchema = z.object({ when: z.enum(["upcoming", "past", "all"]).default("upcoming") }).strict();
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;

/**
 * Upcoming while nobody marked it done or cancelled, whatever its time (operator 7/11, nous_msg:cc777543e99e44e8bcba66db): a passed one
 * stays listed, marked overdue, until it is completed or cancelled; time never hides an appointment.
 */
export const appointmentUpcoming = (item: Pick<Appointment, "status">) =>
  item.status === "UPCOMING";

const DAY_MS = 86_400_000;
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of `ms` in `zone`: its day key and that wall time read as UTC (so `utc - ms` is the zone's offset). */
function zoneWall(ms: number, zone: string) {
  let format = zoneFormats.get(zone);
  if (!format) zoneFormats.set(zone, format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, utc: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) };
}

type Occurring = Pick<Appointment, "startsAt" | "endsAt" | "deadlineAt" | "timeZone"> & { recurrence?: AppointmentRecurrence | null };
/**
 * A recurring appointment at the occurrence it is on (operator 26/11, nous_msg:cfce1783): the first one whose end is still ahead, else the last
 * of its period; startsAt, endsAt and deadlineAt move there at the same wall time in its zone. A one-off one is returned as it is.
 */
export function appointmentOccurrence<T extends Occurring>(item: T, nowMs = Date.now()): T {
  const rule = item.recurrence;
  if (!rule) return item;
  const start = Date.parse(item.startsAt);
  const length = Date.parse(item.endsAt ?? item.startsAt) - start;
  const offset = (ms: number) => zoneWall(ms, item.timeZone).utc - ms;
  // From three days before now (or the period's end) on: a weekend and a zone's offset never hide the last one.
  const lastDay = Date.parse(`${rule.until}T23:59:59Z`);
  let found: number | null = null;
  for (let k = Math.max(0, Math.floor((Math.min(nowMs, lastDay) - start) / DAY_MS) - 3); ; k += 1) {
    const guess = start + k * DAY_MS;
    const at = guess + offset(start) - offset(guess);
    const day = zoneWall(at, item.timeZone).day;
    if (day > rule.until) break;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (rule.every === "WEEKDAY" && (weekday === 0 || weekday === 6)) continue;
    found = at;
    if (at + length >= nowMs) break;
  }
  if (found === null || found === start) return item;
  const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) + found! - start).toISOString() : null);
  return { ...item, startsAt: new Date(found).toISOString(), endsAt: shift(item.endsAt), deadlineAt: shift(item.deadlineAt) };
}

/**
 * An UPCOMING appointment whose time is over: a FIXED one after its end (its start without one), a FLEXIBLE one after its deadline; a recurring
 * one only after the last occurrence of its period.
 */
export const appointmentOverdue = (item: Pick<Appointment, "status" | "timing"> & Occurring, nowMs = Date.now()) => {
  const at = appointmentOccurrence(item, nowMs);
  return item.status === "UPCOMING" && Date.parse(item.timing === "FLEXIBLE" && at.deadlineAt ? at.deadlineAt : at.endsAt ?? at.startsAt) < nowMs;
};

/** Where the operator reads them: the newest open Appointments pane of theirs, if any. */
export interface AppointmentsPaneRef { roomId: string; paneId: string }
export interface AppointmentList { appointments: Appointment[]; timeZone: string; hours: { start: string; end: string; timeZone: string }; pane: AppointmentsPaneRef | null }
