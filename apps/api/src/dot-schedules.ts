import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  createDotScheduleInputSchema,
  describeDotScheduleRecurrence,
  DOT_PROACTIVE_MIN_INTERVAL_MINUTES,
  DOT_PROACTIVE_REQUEST_PREFIX,
  DOT_SCHEDULE_GRACE_MS,
  DOT_SCHEDULE_REQUEST_PREFIX,
  dotIdSchema,
  dotScheduleControlInputSchema,
  dotScheduleRecurrenceSchema,
  isValidTimeZone,
  nextDotScheduleRun,
  type DotSchedule
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { DotSchedulesRepository, DotsRepository } from "@space/db";

/**
 * Space Dots Stage 4: reminders and recurring work.
 *
 * The scheduler sends each occurrence as a visible message into its Dot
 * conversation with an idempotent request key, then advances the schedule with
 * a compare-and-set, so several API instances never run an occurrence twice.
 * It never switches the user's pane: when the conversation is not open or the
 * Dot is busy, the occurrence waits for up to twelve hours and is then skipped.
 */
export class DotScheduleError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message); }
}
export interface DotScheduleServiceDeps {
  store: SpaceStore;
  dots: DotsRepository;
  schedules: DotSchedulesRepository;
  send(input: { paneId: string; sessionId: string; ownerUserId: string; content: string; requestKey: string }): Promise<void>;
  activeSessionId(paneId: string): Promise<string | null>;
  atCapacity?(session: { sessionId: string; dotId: string; roomId: string }): Promise<boolean>;
  now?: () => number;
}

export function createDotScheduleService(deps: DotScheduleServiceDeps) {
  const now = () => deps.now?.() ?? Date.now();
  function firstRun(input: { recurrence: DotSchedule["recurrence"]; timeZone: string }): string | null {
    const next = nextDotScheduleRun(input.recurrence, input.timeZone, now());
    return next === null ? null : new Date(next).toISOString();
  }
  async function create(owner: string, dotId: string, raw: unknown, createdBy: "USER" | "DOT"): Promise<DotSchedule> {
    const input = createDotScheduleInputSchema.parse(raw);
    if (!isValidTimeZone(input.timeZone)) throw new DotScheduleError(400, "DOT_SCHEDULE_TIMEZONE", "Use an IANA time zone such as Europe/Athens.");
    if (!await deps.dots.get(owner, dotId)) throw new DotScheduleError(404, "DOT_NOT_FOUND", "Dot was not found.");
    const session = await deps.store.getSpaceAgentSession(input.sessionId);
    if (!session || session.dotId !== dotId) throw new DotScheduleError(409, "DOT_SCHEDULE_SESSION", "Open this Dot's conversation before scheduling.");
    if ((await deps.store.getRoom(session.roomId)).ownerUserId !== owner) throw new DotScheduleError(404, "DOT_NOT_FOUND", "Dot was not found.");
    const nextRunAt = firstRun(input);
    if (!nextRunAt) throw new DotScheduleError(400, "DOT_SCHEDULE_PAST", "That time has already passed.");
    return deps.schedules.create({ dotId, ownerUserId: owner, roomId: session.roomId, sessionId: session.sessionId, title: input.title,
      prompt: input.prompt, recurrence: input.recurrence, timeZone: input.timeZone, createdBy, nextRunAt: createdBy === "DOT" ? null : nextRunAt });
  }
  async function control(owner: string, dotId: string, scheduleId: string, raw: unknown): Promise<DotSchedule> {
    const { action } = dotScheduleControlInputSchema.parse(raw);
    const schedule = await deps.schedules.getOwned(owner, dotId, scheduleId);
    if (!schedule) throw new DotScheduleError(404, "DOT_SCHEDULE_NOT_FOUND", "Schedule was not found.");
    const next = action === "CONFIRM" || action === "RESUME" ? firstRun(schedule) : undefined;
    if ((action === "CONFIRM" || action === "RESUME") && !next) throw new DotScheduleError(409, "DOT_SCHEDULE_PAST", "This schedule has no future occurrence.");
    const updated = action === "CONFIRM" ? await deps.schedules.setStatus(scheduleId, ["PENDING_CONFIRMATION"], "ACTIVE", next)
      : action === "RESUME" ? await deps.schedules.setStatus(scheduleId, ["PAUSED"], "ACTIVE", next)
      : action === "PAUSE" ? await deps.schedules.setStatus(scheduleId, ["ACTIVE"], "PAUSED", null)
      : await deps.schedules.setStatus(scheduleId, ["PENDING_CONFIRMATION", "ACTIVE", "PAUSED"], "CANCELLED", null);
    if (!updated) throw new DotScheduleError(409, "DOT_SCHEDULE_STATE", `This schedule cannot ${action.toLowerCase()} while it is ${schedule.status.toLowerCase().replace("_", " ")}.`);
    return updated;
  }
  async function runOccurrence(schedule: DotSchedule): Promise<"RAN" | "WAITING" | "SKIPPED" | "LOST"> {
    const dueAt = schedule.nextRunAt!;
    const following = () => {
      const next = nextDotScheduleRun(schedule.recurrence, schedule.timeZone, Math.max(now(), Date.parse(dueAt)));
      return next === null ? null : new Date(next).toISOString();
    };
    const advance = async (outcome: string, ran: boolean) => {
      const nextRunAt = schedule.recurrence.kind === "ONCE" ? null : following();
      return deps.schedules.claim(schedule.scheduleId, dueAt, { nextRunAt, status: nextRunAt ? "ACTIVE" : "COMPLETED", outcome, ran });
    };
    const session = await deps.store.getSpaceAgentSession(schedule.sessionId);
    // Proactive work is enforced read-only only by the native Codex gateway.
    if (schedule.createdBy === "DOT" && session?.selectedProviderId && session.selectedProviderId !== "codex") {
      return await advance(`Skipped ${dueAt}: proactive work runs only in a Codex conversation.`, false) ? "SKIPPED" : "LOST";
    }
    const open = session?.isActive && await deps.activeSessionId(session.paneId) === session.sessionId ? session : null;
    const latest = open ? await deps.store.getLatestSpaceAgentRun(open.sessionId) : null;
    const busy = latest && (latest.status === "QUEUED" || latest.status === "RUNNING");
    const waitingApproval = open ? await deps.dots.hasPendingApproval(open.sessionId) : false;
    const full = open && !busy && deps.atCapacity ? await deps.atCapacity({ sessionId: open.sessionId, dotId: schedule.dotId, roomId: schedule.roomId }) : false;
    const reason = !open ? "the conversation was not open" : busy || full ? "the Dot was busy" : waitingApproval ? "an approval was pending" : null;
    if (reason) {
      if (now() - Date.parse(dueAt) < DOT_SCHEDULE_GRACE_MS) return "WAITING";
      return await advance(`Skipped ${dueAt}: ${reason} for twelve hours.`, false) ? "SKIPPED" : "LOST";
    }
    // A schedule the Dot proposed is proactive work and runs read-only (see the gateway and worker).
    const proactive = schedule.createdBy === "DOT";
    const requestKey = `${proactive ? DOT_PROACTIVE_REQUEST_PREFIX : DOT_SCHEDULE_REQUEST_PREFIX}${createHash("sha256").update(`${schedule.scheduleId}:${dueAt}`).digest("hex").slice(0, 40)}`;
    try {
      await deps.send({ paneId: open!.paneId, sessionId: open!.sessionId, ownerUserId: schedule.ownerUserId, requestKey,
        content: `Scheduled task “${schedule.title}” (${describeDotScheduleRecurrence(schedule.recurrence, schedule.timeZone)}):\n${schedule.prompt}${proactive
          ? "\n\nYou proposed this recurring work, so it runs read-only: read, research and report. Ask me before changing anything." : ""}` });
    } catch {
      return "WAITING";
    }
    return await advance(`Ran at ${new Date(now()).toISOString()}.`, true) ? "RAN" : "LOST";
  }
  async function tick(limit = 10): Promise<Record<string, number>> {
    const counts: Record<string, number> = { RAN: 0, WAITING: 0, SKIPPED: 0, LOST: 0 };
    for (const schedule of await deps.schedules.due(new Date(now()).toISOString(), limit)) {
      counts[await runOccurrence(schedule)]! += 1;
    }
    return counts;
  }
  /** `schedule.create` for the Dot gateway: proposes a schedule the owner must confirm. */
  async function tool(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>) {
    const input = z.object({ title: z.string().trim().min(1).max(160), prompt: z.string().trim().min(1).max(4000),
      recurrence: dotScheduleRecurrenceSchema, timeZone: z.string().trim().min(1).max(80) }).strict().safeParse(args);
    if (!input.success) return { status: "BLOCKED" as const, statusReason: "schedule.create needs title, prompt, recurrence and an IANA timeZone." };
    if (input.data.recurrence.kind === "INTERVAL" && input.data.recurrence.minutes < DOT_PROACTIVE_MIN_INTERVAL_MINUTES) {
      return { status: "BLOCKED" as const, statusReason: `Recurring work you propose runs at most every ${DOT_PROACTIVE_MIN_INTERVAL_MINUTES} minutes.` };
    }
    try {
      const proposed = await create(owner, session.dotId, { ...input.data, sessionId: session.sessionId }, "DOT");
      return { status: "PROPOSED" as const, schedule: proposed, summary: `Schedule “${proposed.title}”: ${describeDotScheduleRecurrence(proposed.recurrence, proposed.timeZone)}` };
    } catch (error) {
      return { status: "BLOCKED" as const, statusReason: error instanceof Error ? error.message : "The schedule is invalid." };
    }
  }
  return { create, control, tick, tool };
}
export type DotScheduleService = ReturnType<typeof createDotScheduleService>;

export function registerDotScheduleRoutes(app: FastifyInstance, service: DotScheduleService | null, schedules: DotSchedulesRepository | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const scheduleParams = z.object({ dotId: dotIdSchema, scheduleId: z.string().regex(/^dot_schedule:[a-f0-9]{32}$/) }).strict();
  const user = (action: (request: FastifyRequest, owner: string, service: DotScheduleService, schedules: DotSchedulesRepository) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!service || !schedules) return reply.code(503).send({ error: { code: "DOT_SCHEDULES_UNAVAILABLE", message: "Schedules are unavailable." } });
      try { return await action(request, await options.authenticatedOwner(request), service, schedules); }
      catch (error) {
        if (error instanceof DotScheduleError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "DOT_SCHEDULE_INVALID", message: "Schedule request is invalid." } });
        throw error;
      }
    };
  app.get("/api/dots/:dotId/schedules", options.routeOptions, user(async (request, owner, _service, schedules) => {
    const { dotId } = params.parse(request.params);
    return { dotId, items: await schedules.list(owner, dotId) };
  }));
  app.post("/api/dots/:dotId/schedules", options.routeOptions, user(async (request, owner, service) => {
    const { dotId } = params.parse(request.params);
    return { schedule: await service.create(owner, dotId, request.body ?? {}, "USER") };
  }));
  app.post("/api/dots/:dotId/schedules/:scheduleId/control", options.routeOptions, user(async (request, owner, service) => {
    const { dotId, scheduleId } = scheduleParams.parse(request.params);
    return { schedule: await service.control(owner, dotId, scheduleId, request.body ?? {}) };
  }));
}
