import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  agentLanguageOf, appointmentInputSchema, appointmentListQuerySchema, appointmentUpcoming, appointmentUpdateSchema, historySince, ownerWorkingTimeZone,
  resolveNotificationSettings, type Appointment, type AppointmentInput, type AppointmentList, type AppointmentUpdate, type AppointmentsPaneRef,
  type NotificationRaiseInput, type UserSettings
} from "@space/contracts";
import { InMemoryAppointmentsRepository, PostgresAppointmentsRepository, type AppointmentsRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { requireAppointmentContent } from "./appointment-content.js";
import { afterWrite, emitMakeEvent } from "./make-webhooks.js";
import { localParts, ownerQuietState } from "./owner-clock.js";
import { parseBody, parseQuery } from "./route-parsing.js";

// The operator's appointments (operator 2/11 15:22 BKK, brief nous/briefs/20261102-appointments-pane.md): one list for the Appointments pane,
// Nous's fullscreen card, Nous's tools and every pane's space_appointment_* tools, reminded before each appointment.

type Store = Pick<SpaceStore, "upsertUser" | "getUserSettings" | "listRooms" | "listPanes" | "getRoom" | "getPane">;
type Settings = Pick<UserSettings, "dateTime" | "notifications"> | null | undefined;

/** A reminder that falls in the operator's quiet hours goes this long before they start (22:55 for 23:00), never dropped. */
export const APPOINTMENT_QUIET_LEAD_MS = 5 * 60_000;
const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/**
 * When each reminder goes, soonest first: `lead` minutes before the start, or, when that is inside the operator's quiet hours, just before
 * those quiet hours began. Leads that land on the same time go as one reminder.
 */
export function appointmentReminderPlan(startsAt: string, leadMinutes: readonly number[], settings: Settings): Array<{ at: number; leads: number[] }> {
  const start = Date.parse(startsAt);
  const groups = new Map<number, number[]>();
  for (const lead of [...new Set(leadMinutes)].filter((value) => value > 0)) {
    let at = start - lead * 60_000;
    const state = ownerQuietState(settings, new Date(at));
    if (state.night) {
      const since = (localParts(new Date(at), state.timeZone).minutes - clockMinutes(state.start) + 1440) % 1440;
      at = at - (at % 60_000) - since * 60_000 - APPOINTMENT_QUIET_LEAD_MS;
    }
    groups.set(at, [...(groups.get(at) ?? []), lead]);
  }
  return [...groups].map(([at, leads]) => ({ at, leads })).sort((a, b) => a.at - b.at);
}

const KIND_EL: Record<Appointment["kind"], string> = { CALL: "Κλήση", INTERVIEW: "Συνέντευξη", WEBINAR: "Webinar", DEADLINE: "Προθεσμία", OTHER: "Ραντεβού" };
const KIND_EN: Record<Appointment["kind"], string> = { CALL: "Call", INTERVIEW: "Interview", WEBINAR: "Webinar", DEADLINE: "Deadline", OTHER: "Appointment" };

function untilText(ms: number, greek: boolean): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] = minutes < 90 ? [minutes, "m"] : minutes < 20 * 60 ? [Math.round(minutes / 60), "h"] : [Math.round(minutes / 1440), "d"];
  if (greek) return `σε ${value} ${unit === "m" ? "λεπτά" : unit === "h" ? (value === 1 ? "ώρα" : "ώρες") : (value === 1 ? "ημέρα" : "ημέρες")}`;
  return `in ${value} ${unit === "m" ? "min" : unit === "h" ? (value === 1 ? "hour" : "hours") : (value === 1 ? "day" : "days")}`;
}

/** The reminder's words, in the operator's agent language (Settings → Personal → Language). */
export function appointmentReminderText(item: Appointment, settings: Settings & Pick<UserSettings, "uiLanguage" | "agentLanguage"> | null | undefined, nowMs: number) {
  const greek = agentLanguageOf(settings ?? null) === "el";
  const zone = ownerWorkingTimeZone(settings ?? null);
  const when = new Intl.DateTimeFormat(greek ? "el-GR" : "en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short" }).format(new Date(item.startsAt));
  const kind = (greek ? KIND_EL : KIND_EN)[item.kind];
  return {
    title: `${greek ? "Υπενθύμιση" : "Reminder"}: ${item.title} ${untilText(Date.parse(item.startsAt) - nowMs, greek)}`,
    body: [`${kind} · ${when}`, item.location, item.notes].filter(Boolean).join("\n")
  };
}

const reminderKey = (item: Appointment, leads: readonly number[]) => `appointment:${item.id}:${Math.floor(Date.parse(item.startsAt) / 60_000)}:${Math.min(...leads)}`;

export interface AppointmentsService {
  repository: AppointmentsRepository;
  list(owner: string, when: "upcoming" | "past" | "all"): Promise<AppointmentList>;
  /** Creates one, or, with a sourceRef, updates the appointment that source made. */
  add(owner: string, input: AppointmentInput): Promise<Appointment>;
  update(owner: string, id: string, patch: AppointmentUpdate): Promise<Appointment>;
  /** Sends every reminder that is due (one per appointment, the latest due); answers how many went. */
  remind(now?: Date): Promise<number>;
}

export interface AppointmentsDeps {
  store: Store;
  repository?: AppointmentsRepository;
  databaseUrl?: string | null;
  notifications?: { raise(input: NotificationRaiseInput): Promise<unknown>; resolve(owner: string, dedupeKey: string): Promise<number> };
  log?: { warn(details: unknown, message: string): void };
  /** nous_msg:8e7e6c25: notes with each workspace file they name filed in Agent Files and its id beside it (`hint`: the kind). */
  annotate?(owner: string, text: string, hint: string): Promise<string>;
  /** What an appointment marked DONE also closes (its interview task and application, the cards about it, Nous's inbox line), whoever marked it. */
  onDone?: (owner: string, item: Appointment) => Promise<void>;
}

export function createAppointmentsService(deps: AppointmentsDeps): AppointmentsService {
  const { store } = deps;
  const settingsOf = async (owner: string) => await Promise.resolve(store.getUserSettings(owner)).catch(() => null);
  const repository = requireAppointmentContent(deps.repository ?? (deps.databaseUrl ? PostgresAppointmentsRepository.fromConnectionString(deps.databaseUrl) : new InMemoryAppointmentsRepository()),
    async (owner) => ownerWorkingTimeZone(await settingsOf(owner)));
  // Every appointment writer goes through this repository; one event per appointment, status and time.
  const toMake = (item: Appointment | null | undefined, owner: string) => {
    if (item) emitMakeEvent(owner, "appointment", `${item.id}:${item.status}:${item.startsAt}`, { id: item.id, title: item.title, kind: item.kind, status: item.status,
      startsAt: item.startsAt, endsAt: item.endsAt, timeZone: item.timeZone, location: item.location });
  };
  for (const method of ["create", "update", "upsertBySource"] as const) afterWrite(repository, method, (item, [owner]) => toMake(item as Appointment | null, owner));

  async function pane(owner: string): Promise<AppointmentsPaneRef | null> {
    const rooms = await store.listRooms(owner);
    const panes = (await Promise.all(rooms.map(async (room) => await Promise.resolve(store.listPanes(room.id)).catch(() => [])))).flat()
      .filter((item) => item.mode === "APPOINTMENTS" && !item.isClosed).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return panes[0] ? { roomId: panes[0].roomId, paneId: panes[0].id } : null;
  }

  // Interview preparation and other files the notes name are always in Agent Files (Documents/Interviews for prep), their ids beside them.
  const notesFiled = async (owner: string, notes: string | null | undefined, kind: string) =>
    notes && deps.annotate ? (await deps.annotate(owner, notes, kind).catch(() => notes)).slice(0, 20_000) : notes;

  return {
    repository,
    async list(owner, when) {
      const settings = await settingsOf(owner);
      // Past ones within the owner's history period (Settings → History); upcoming ones (status UPCOMING) whatever their date.
      const rows = await repository.list(owner, historySince(settings));
      const appointments = when === "all" ? rows : rows.filter((item) => appointmentUpcoming(item) === (when === "upcoming"));
      return { appointments: when === "past" ? appointments.reverse() : appointments, timeZone: ownerWorkingTimeZone(settings), pane: await pane(owner) };
    },
    async add(owner, raw) {
      const parsed = appointmentInputSchema.parse(raw);
      const input = parsed.notes ? { ...parsed, notes: await notesFiled(owner, parsed.notes, parsed.kind) } : parsed;
      const timeZone = input.timeZone ?? ownerWorkingTimeZone(await settingsOf(owner));
      return input.sourceRef ? repository.upsertBySource(owner, { ...input, sourceRef: input.sourceRef, timeZone }) : repository.create(owner, { ...input, timeZone });
    },
    async update(owner, id, patch) {
      const parsed = appointmentUpdateSchema.parse(patch);
      const notes = parsed.notes ? { notes: await notesFiled(owner, parsed.notes, parsed.kind ?? "") } : {};
      const before = parsed.status === "DONE" && deps.onDone ? await repository.get(owner, id) : null;
      const item = await repository.update(owner, id, { ...parsed, ...notes });
      if (!item) throw new SpaceNotFoundError("Appointment was not found.");
      // Operator 4/11 (nous_msg:dc24e81ea2c9 «να το κανω completed και να ενημερωσει ολα τα συστηματα»): once, on the change to DONE; a failure never undoes it.
      if (before && before.status !== "DONE") await deps.onDone!(owner, item).catch((error: unknown) => deps.log?.warn({ err: error, appointmentId: id }, "Appointment completion follow-up failed."));
      return item;
    },
    async remind(now = new Date()) {
      if (!deps.notifications) return 0;
      let sent = 0;
      for (const item of await repository.upcoming(now.toISOString())) {
        try {
          const settings = await settingsOf(item.ownerUserId);
          const config = resolveNotificationSettings(settings?.notifications).appointmentReminders;
          if (!config.enabled) continue;
          const plan = appointmentReminderPlan(item.startsAt, config.leadMinutes, settings);
          const due = plan.filter((step) => step.at <= now.getTime());
          const latest = due.at(-1);
          if (!latest || latest.leads.every((lead) => item.remindersSent.includes(lead))) continue;
          const { title, body } = appointmentReminderText(item, settings, now.getTime());
          const where = await pane(item.ownerUserId).catch(() => null);
          // Source NOUS: other sources' ATTENTION alerts wait for Nous instead of Telegram and push while it works; a reminder must not.
          await deps.notifications.raise({ ownerUserId: item.ownerUserId, roomId: where?.roomId ?? null, paneId: where?.paneId ?? null, source: "NOUS",
            kind: "APPOINTMENT_REMINDER", severity: "ATTENTION", title, body, link: where ? { roomId: where.roomId, paneId: where.paneId } : {}, dedupeKey: reminderKey(item, latest.leads),
            payload: { appointmentId: item.id, startsAt: item.startsAt }, telegram: null });
          await repository.markReminded(item.id, due.flatMap((step) => step.leads));
          for (const step of due.slice(0, -1)) await deps.notifications.resolve(item.ownerUserId, reminderKey(item, step.leads)).catch(() => 0);
          sent += 1;
        } catch (error) {
          deps.log?.warn({ err: error, appointmentId: item.id }, "Appointment reminder failed.");
        }
      }
      return sent;
    }
  };
}

const services = new WeakMap<object, AppointmentsService>();
/** The store's appointments (Nous's tools, the CLI bridge and the Job Copilot's interview mail find them through the store they share). */
export const appointmentsFor = (store: object) => services.get(store);

export const APPOINTMENT_REMINDER_TICK_MS = 60_000;
const idParams = z.object({ id: z.string().min(1).max(200) }).strict();
/** A write by id updates that appointment; without one it adds (or, with a sourceRef, updates the one that source made). */
export const appointmentWriteSchema = appointmentUpdateSchema.extend({ id: z.string().min(1).max(200).optional() }).strict();
export async function writeAppointment(service: AppointmentsService, owner: string, raw: unknown): Promise<Appointment> {
  const { id, ...rest } = appointmentWriteSchema.parse(raw);
  if (id) return service.update(owner, id, rest);
  // 5/11 (3 refusals: a past interview timeline recorded from mail): a new appointment may be added already DONE or CANCELLED.
  const { status, ...input } = rest;
  const added = await service.add(owner, appointmentInputSchema.parse(input));
  return status ? service.update(owner, added.id, { status }) : added;
}

export function registerAppointments(app: FastifyInstance, deps: AppointmentsDeps & { routeOptions: Pick<RouteShorthandOptions, "config">; reminders: boolean }) {
  const service = createAppointmentsService(deps);
  services.set(deps.store, service);
  const owner = async (request: FastifyRequest) => (await deps.store.upsertUser(request.user!)).id;
  app.get("/api/appointments", deps.routeOptions, async (request) => service.list(await owner(request), parseQuery(appointmentListQuerySchema, request.query ?? {}).when));
  app.post("/api/appointments", deps.routeOptions, async (request, reply) => reply.code(201).send(await service.add(await owner(request), parseBody(appointmentInputSchema, request.body ?? {}))));
  app.patch("/api/appointments/:id", deps.routeOptions, async (request) =>
    service.update(await owner(request), parseQuery(idParams, request.params).id, parseBody(appointmentUpdateSchema, request.body ?? {})));
  if (deps.reminders) {
    const timer = setInterval(() => void service.remind().catch((error: unknown) => deps.log?.warn({ err: error }, "Appointment reminders failed.")), APPOINTMENT_REMINDER_TICK_MS);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  app.addHook("onClose", () => service.repository.dispose());
  return service;
}

/** The panes' space_appointment_add and space_appointments (MCP space_progress), with the pane's bridge token, as the room's owner. */
export function registerAppointmentAgentRoutes(app: FastifyInstance, deps: {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "getPaneOwner">;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: { roomId: string; paneId: string } } | null>;
}) {
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const service = appointmentsFor(deps.store);
    if (!service) throw new SpaceConflictError("Appointments are unavailable.");
    const owner = await deps.store.getPaneOwner?.(bridge.claims.paneId) ?? (await deps.store.getRoom(bridge.claims.roomId)).ownerUserId;
    if (!owner) throw new SpaceConflictError("This room has no owner; appointments belong to a signed-in operator account.");
    return { service, owner };
  };
  app.post("/api/cli/appointments", async (request, reply) => {
    const ctx = await context(request, reply);
    return ctx ? { appointment: await writeAppointment(ctx.service, ctx.owner, request.body ?? {}) } : reply;
  });
  app.post("/api/cli/appointments/list", async (request, reply) => {
    const ctx = await context(request, reply);
    return ctx ? ctx.service.list(ctx.owner, parseBody(appointmentListQuerySchema, request.body ?? {}).when) : reply;
  });
}
