import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { DotProfile, Pane } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { DotsRepository } from "@space/db";

/**
 * Space Dots Stage 6: voice and task continuity.
 *
 * From Live, the user hands work to one of their Dots, answers its questions,
 * steers its Goal or asks how it is going, all in that Dot's own conversation
 * in the room. Requests are idempotent per Live tool call. A watch on the
 * Dot's pane lets Live announce the result when the task finishes.
 */
export const dotLiveRequestSchema = z.object({
  roomId: z.string().min(1).max(200),
  dot: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(4000),
  liveSessionId: z.string().min(8).max(100),
  requestId: z.string().min(1).max(200)
}).strict();

export interface DotLiveDeps {
  store: Pick<SpaceStore, "listPanes" | "getActiveSpaceAgentSession" | "getLatestSpaceAgentRun" | "listSpaceAgentMessages" | "getRoom">;
  dots: Pick<DotsRepository, "list">;
  openPane(input: { owner: string; roomId: string; title: string }): Promise<Pane>;
  startSession(input: { pane: Pane; owner: string; dotId: string }): Promise<{ sessionId: string }>;
  /** Throws SpaceConflictError while the conversation is busy. */
  send(input: { pane: Pane; sessionId: string; owner: string; content: string; requestKey: string }): Promise<void>;
  openGoal(sessionId: string): Promise<{ goalId: string; status: string; objective: string; statusReason: string | null; steps: number; maxSteps: number } | null>;
  steerGoal(owner: string, dotId: string, goalId: string, text: string, resume: boolean): Promise<void>;
  pendingApprovals(owner: string, dotId: string, sessionId: string): Promise<Array<{ summary: string }>>;
  /** Registers a watch so Live announces the task's outcome. */
  watch(owner: string, roomId: string, paneId: string): Promise<string | null>;
  /** True for conversations linked to a Slack or Teams thread. */
  isChannelSession?(sessionId: string): Promise<boolean>;
}

const sentence = (text: string) => /[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

/** Finds a Dot by name (any language case), slot number or id. */
export function findLiveDot(dots: DotProfile[], query: string): DotProfile | null {
  const wanted = query.trim().toLocaleLowerCase();
  return dots.find((dot) => dot.name.toLocaleLowerCase() === wanted || String(dot.slot) === wanted || dot.dotId === query.trim()) ?? null;
}

export function createDotLiveService(deps: DotLiveDeps) {
  // A repeated Live tool call gets the first call's answer instead of acting twice; requests for one Dot run one at a time.
  const answered = new Map<string, { at: number; result: unknown }>();
  const locks = new Map<string, Promise<unknown>>();
  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  async function conversation(owner: string, roomId: string, dot: DotProfile, create: boolean) {
    // The Dot's most recently active conversation in this room; otherwise a new Chat pane for it.
    const panes = (await deps.store.listPanes(roomId)).filter((pane) => pane.mode === "CHAT" && !pane.isClosed);
    let found: { pane: Pane; sessionId: string; updatedAt: string } | null = null;
    for (const pane of panes) {
      const session = await deps.store.getActiveSpaceAgentSession(pane.id);
      // Slack and Teams conversations stay with their thread; voice continues in the Dot's own Space conversation.
      if (session?.dotId === dot.dotId && !await deps.isChannelSession?.(session.sessionId) && (!found || session.updatedAt > found.updatedAt)) {
        found = { pane, sessionId: session.sessionId, updatedAt: session.updatedAt };
      }
    }
    if (found || !create) return found;
    const pane = await deps.openPane({ owner, roomId, title: `${dot.name} · Live` });
    const { sessionId } = await deps.startSession({ pane, owner, dotId: dot.dotId });
    return { pane, sessionId, updatedAt: new Date().toISOString() };
  }
  async function ownedRoom(owner: string, roomId: string) {
    const room = await Promise.resolve(deps.store.getRoom(roomId)).catch(() => null);
    if (!room || room.ownerUserId !== owner) throw new SpaceConflictError("That room is not available.");
  }

  async function ask(owner: string, raw: unknown) {
    const input = dotLiveRequestSchema.parse(raw);
    await ownedRoom(owner, input.roomId);
    const callKey = createHash("sha256").update(`${owner}:${input.liveSessionId}:${input.requestId}`).digest("hex");
    return serialized(`${owner}:${input.roomId}:${input.dot.toLocaleLowerCase()}`, async () => {
      const previous = answered.get(callKey);
      if (previous) return previous.result as Awaited<ReturnType<typeof askOnce>>;
      const result = await askOnce(owner, input);
      for (const [key, value] of answered) if (Date.now() - value.at > 30 * 60_000) answered.delete(key);
      answered.set(callKey, { at: Date.now(), result });
      return result;
    });
  }
  async function askOnce(owner: string, input: z.infer<typeof dotLiveRequestSchema>) {
    const dots = await deps.dots.list(owner);
    const dot = findLiveDot(dots, input.dot);
    if (!dot) return { status: "UNKNOWN_DOT" as const, message: `There is no Dot called ${input.dot}. The user's Dots are ${dots.map((item) => item.name).join(", ")}.` };
    const target = (await conversation(owner, input.roomId, dot, true))!;
    const goal = await deps.openGoal(target.sessionId);
    // A Goal waiting for the user takes this as its answer; an active Goal takes it as guidance.
    if (goal?.status === "BLOCKED") {
      await deps.steerGoal(owner, dot.dotId, goal.goalId, input.text, true);
      return { status: "ANSWERED" as const, dot: dot.name, paneId: target.pane.id, message: `${dot.name} received the answer and continues its Goal.` };
    }
    const requestKey = `live-${createHash("sha256").update(`${input.liveSessionId}:${input.requestId}`).digest("hex").slice(0, 40)}`;
    try {
      await deps.send({ pane: target.pane, sessionId: target.sessionId, owner, content: `(Voice) ${input.text}`, requestKey });
    } catch (error) {
      if (!(error instanceof SpaceConflictError)) throw error;
      if (goal?.status === "ACTIVE" || goal?.status === "PAUSED") {
        await deps.steerGoal(owner, dot.dotId, goal.goalId, input.text, false);
        return { status: "STEERED" as const, dot: dot.name, paneId: target.pane.id, message: `${dot.name} is working on its Goal and will take this into account.` };
      }
      return { status: "BUSY" as const, dot: dot.name, paneId: target.pane.id, message: `${dot.name} is still working on the previous request. Ask again when it finishes.` };
    }
    const watchId = await deps.watch(owner, input.roomId, target.pane.id).catch(() => null);
    return { status: "SENT" as const, dot: dot.name, paneId: target.pane.id, watchId,
      message: `${dot.name} started on it in its own pane.${watchId ? " The result will be announced when it finishes." : ""}` };
  }

  /** A short, speakable summary of what a Dot is doing in this room. */
  async function status(owner: string, roomId: string, query: string) {
    await ownedRoom(owner, roomId);
    const dots = await deps.dots.list(owner);
    const dot = findLiveDot(dots, query);
    if (!dot) return { status: "UNKNOWN_DOT" as const, message: `There is no Dot called ${query}.` };
    const target = await conversation(owner, roomId, dot, false);
    if (!target) return { status: "IDLE" as const, dot: dot.name, message: `${dot.name} has no conversation in this room yet.` };
    const [run, goal, approvals] = await Promise.all([deps.store.getLatestSpaceAgentRun(target.sessionId), deps.openGoal(target.sessionId),
      deps.pendingApprovals(owner, dot.dotId, target.sessionId)]);
    const answer = run?.status === "COMPLETED"
      ? (await deps.store.listSpaceAgentMessages(target.sessionId)).find((message) => message.messageId === run.responseMessageId)?.content?.trim() ?? null : null;
    const parts = [
      run ? run.status === "RUNNING" || run.status === "QUEUED" ? `${dot.name} is working on a request.`
        : run.status === "COMPLETED" ? `${dot.name}'s last answer: ${(answer ?? "done").slice(0, 600)}` : `${dot.name}'s last request ${run.status.toLowerCase()}.` : `${dot.name} has not started anything here.`,
      goal ? sentence(`Goal "${goal.objective.slice(0, 160)}" is ${goal.status.toLowerCase()} after ${goal.steps} of ${goal.maxSteps} steps${
        goal.status === "BLOCKED" && goal.statusReason ? `; it asks: ${goal.statusReason.slice(0, 300)}` : ""}`) : null,
      approvals.length ? sentence(`${approvals.length} ${approvals.length === 1 ? "action waits" : "actions wait"} for approval in Space, for example: ${approvals[0]!.summary.slice(0, 200)}`) : null
    ].filter(Boolean);
    return { status: "OK" as const, dot: dot.name, paneId: target.pane.id, runStatus: run?.status ?? null, goalStatus: goal?.status ?? null,
      pendingApprovals: approvals.length, message: parts.join(" ") };
  }
  return { ask, status };
}
export type DotLiveService = ReturnType<typeof createDotLiveService>;

export function registerDotLiveRoutes(app: FastifyInstance, service: DotLiveService | null, options: {
  routeOptions: RouteShorthandOptions; authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  app.post("/api/dots/live/requests", options.routeOptions, async (request, reply) => {
    const owner = await options.authenticatedOwner(request);
    if (!service) return reply.code(503).send({ error: { code: "DOTS_UNAVAILABLE", message: "Dots are unavailable." } });
    const parsed = dotLiveRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: "DOT_LIVE_INVALID", message: "A room, a Dot and the request are required." } });
    try { return await service.ask(owner, parsed.data); }
    catch (error) {
      if (error instanceof SpaceConflictError) return reply.code(409).send({ error: { code: "DOT_LIVE_CONFLICT", message: error.message.slice(0, 300) } });
      throw error;
    }
  });
  app.get("/api/dots/live/status", options.routeOptions, async (request, reply) => {
    const owner = await options.authenticatedOwner(request);
    if (!service) return reply.code(503).send({ error: { code: "DOTS_UNAVAILABLE", message: "Dots are unavailable." } });
    const query = z.object({ roomId: z.string().min(1).max(200), dot: z.string().trim().min(1).max(80) }).strict().safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: { code: "DOT_LIVE_INVALID", message: "A room and a Dot are required." } });
    try { return await service.status(owner, query.data.roomId, query.data.dot); }
    catch (error) {
      if (error instanceof SpaceConflictError) return reply.code(409).send({ error: { code: "DOT_LIVE_CONFLICT", message: error.message.slice(0, 300) } });
      throw error;
    }
  });
}
