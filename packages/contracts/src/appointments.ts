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
  deadlineAt: isoDateTime.nullable().optional()
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
  status: appointmentStatusSchema,
  /** The reminder lead times (minutes) already sent for this start time; a new start time clears it. */
  remindersSent: z.array(z.number().int()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
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

/** An UPCOMING appointment whose time is over: a FIXED one after its end (its start without one), a FLEXIBLE one after its deadline. */
export const appointmentOverdue = (item: Pick<Appointment, "status" | "startsAt" | "endsAt" | "timing" | "deadlineAt">, nowMs = Date.now()) =>
  item.status === "UPCOMING" && Date.parse(item.timing === "FLEXIBLE" && item.deadlineAt ? item.deadlineAt : item.endsAt ?? item.startsAt) < nowMs;

/** Where the operator reads them: the newest open Appointments pane of theirs, if any. */
export interface AppointmentsPaneRef { roomId: string; paneId: string }
export interface AppointmentList { appointments: Appointment[]; timeZone: string; pane: AppointmentsPaneRef | null }
