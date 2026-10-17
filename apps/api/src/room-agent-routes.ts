import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  type AuthUser, type RoomAgentEvent, type RoomAgentSession, roomAgentControlInputSchema, roomAgentMessageInputSchema, roomAgentStartMissionInputSchema,
  roomAgentStopInputSchema
} from "@space/contracts";
import type { InMemoryControlRepository, PostgresControlRepository, RoomAgentMonitorRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { operatorBrowserActor } from "./browser-actors.js";
import { recordAudit } from "./request-audit.js";
import type { RoomAgentService } from "./room-agent.js";
import type { RoomAgentChat } from "./room-agent-chat.js";
import { formatSseHeartbeat } from "./sse.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

/**
 * Room Agent session, missions, messages, command acknowledgements, stop, control and transcript; the parent
 * retains authentication, CSRF, errors and rate limits.
 */
export function registerRoomAgentRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  controlRepository: PostgresControlRepository | InMemoryControlRepository;
  controlUser: (id: string, verifiedEmail?: string) => Promise<AuthUser>;
  roomAgentService: RoomAgentService;
  /** Frames of the answer being written, for the dock's stream. */
  chat?: Pick<RoomAgentChat, "subscribe">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Room monitor switch and feed acknowledgements. */
  monitor?: {
    repository: Pick<RoomAgentMonitorRepository, "listEvents" | "setMonitorEnabled" | "setAutopilotEnabled" | "monitorEnabled" | "getEvent" | "updateEvent" | "pendingCounts" | "latestPending">;
    forget(roomId: string): void;
    changed(event: RoomAgentEvent): Promise<void>;
    /** Sends the operator's answer (or Escape to decline) to the question an event is about. */
    answer(event: RoomAgentEvent, input: { answer?: string; submit: boolean; decline: boolean }): Promise<void>;
  };
}) {
  const { store, controlRepository, controlUser, roomAgentService, routeOptions: defaultRouteRateLimitOptions } = options;
  // Pause, resume and stop are operator controls; other viewers never see buttons the API would refuse.
  const forViewer = (session: RoomAgentSession, user: AuthUser | null | undefined): RoomAgentSession =>
    user?.role === "ADMIN" && !user.automationScope ? session
      : { ...session, capabilities: { ...session.capabilities, canPause: false, canResume: false, canStop: false } };
  app.get("/api/rooms/:id/room-agent", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    return forViewer(await roomAgentService.load(params.id), request.user);
  });
  // The dock's own stream (open only while the dock is visible); room ownership is checked by the shared preHandler.
  app.get("/api/rooms/:id/room-agent/stream", { config: { rateLimit: defaultRouteRateLimitOptions.config?.rateLimit }, compress: false }, async (request, reply) => {
    const params = parseQuery(idParamSchema, request.params);
    await store.getRoom(params.id);
    if (!options.chat) throw new SpaceConflictError("The Room Agent stream is unavailable.");
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");
    let closed = false;
    const unsubscribe = options.chat.subscribe(params.id, (frame) => {
      if (!closed) reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(formatSseHeartbeat()); }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    reply.raw.once("close", close);
    request.raw.once("aborted", close);
  });
  app.get("/api/rooms/:id/room-agent/missions", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    return roomAgentService.inspectMission(params.id);
  });
  app.post("/api/rooms/:id/room-agent/missions", defaultRouteRateLimitOptions, async (request, reply) => {
    if (!request.user || request.user.role !== "ADMIN" || request.user.automationScope) {
      throw new SpaceConflictError("Only an authenticated operator may start a Live mission.");
    }
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(roomAgentStartMissionInputSchema, request.body);
    await store.getRoom(params.id);
    const actor = await controlUser(request.user.id, request.user.email);
    const key = `room-agent:${params.id}`;
    const previous = await controlRepository.get("grant", "shared", key);
    const previousGrant = z.object({ actorId: z.string().nullable() }).safeParse(previous?.value);
    if (previous && !previousGrant.success) throw new SpaceConflictError("Room Agent control grant is invalid.");
    if (previousGrant.success && previousGrant.data.actorId && previousGrant.data.actorId !== actor.id &&
      (await store.listRoomAgentMissions(params.id)).some(mission => ["QUEUED", "RUNNING", "PAUSED"].includes(mission.status))) {
      throw new SpaceConflictError("This room already has an active mission for another operator.");
    }
    if (!await controlRepository.write({ kind: "grant", actorId: "shared", key, roomId: params.id,
      version: (previous?.version ?? 0) + 1, value: { actorId: actor.id } }, previous?.version ?? 0)) {
      throw new SpaceConflictError("Room Agent control grant changed. Retry the same request.");
    }
    const session = await roomAgentService.startMission(params.id, input.objective, input.clientRequestId,
      request.requestIdForSpace, { holderType: "OPERATOR", holderId: actor.id });
    await recordAudit(store, request, { action: "room.agent.mission.start", targetType: "room", targetId: params.id,
      metadata: { sessionId: session.sessionId, missionId: session.missionSnapshot?.mission.id ?? null } });
    return reply.code(202).send(session);
  });
  app.post("/api/rooms/:id/room-agent/messages", defaultRouteRateLimitOptions, async (request, reply) => {
    const params = parseQuery(idParamSchema, request.params);
    if(request.user?.role==="ADMIN"&&!request.user.automationScope){
      const actor=await controlUser(request.user.id,request.user.email);
      const key=`room-agent:${params.id}`,previous=await controlRepository.get("grant","shared",key);
      if (!await controlRepository.write({kind:"grant",actorId:"shared",key,roomId:params.id,version:(previous?.version??0)+1,value:{actorId:actor.id}},previous?.version??0)) {
        throw new SpaceConflictError("Room Agent control grant changed. Retry the same request.");
      }
    }
    const input = parseBody(roomAgentMessageInputSchema, request.body);
    const session = await roomAgentService.send(params.id, input.content, input.clientRequestId, request.requestIdForSpace, operatorBrowserActor(request), input.selectedBrowserPaneId);
    await recordAudit(store, request, {
      action: "room.agent.message",
      targetType: "room",
      targetId: params.id,
      metadata: { sessionId: session.sessionId, queuedMissionCount: session.queuedMissionCount }
    });
    return reply.code(202).send(forViewer(session, request.user));
  });
  app.post("/api/rooms/:id/room-agent/commands/:clientRequestId/ack", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(z.object({ id: z.string().min(1), clientRequestId: z.string().min(1).max(200) }), request.params);
    const input = parseBody(z.object({ ok: z.boolean() }).strict(), request.body);
    return forViewer(await roomAgentService.acknowledgeCommand(params.id, params.clientRequestId, input.ok, operatorBrowserActor(request)), request.user);
  });
  app.post("/api/rooms/:id/room-agent/stop", defaultRouteRateLimitOptions, async (request) => {
    if (!request.user || request.user.role !== "ADMIN" || request.user.automationScope) throw new SpaceConflictError("Only an authenticated operator may stop a mission.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(roomAgentStopInputSchema, request.body ?? {});
    const actor = await controlUser(request.user.id, request.user.email);
    const session = await roomAgentService.stop(params.id, input.reason, request.requestIdForSpace, { expectedMissionId: input.expectedMissionId, actorId: actor.id });
    await recordAudit(store, request, {
      action: "room.agent.stop",
      targetType: "room",
      targetId: params.id,
      metadata: { sessionId: session.sessionId, expectedMissionId: input.expectedMissionId ?? null }
    });
    return session;
  });
  app.post("/api/rooms/:id/room-agent/control", defaultRouteRateLimitOptions, async (request) => {
    if (!request.user || request.user.role !== "ADMIN" || request.user.automationScope) throw new SpaceConflictError("Only an authenticated operator may control a mission.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(roomAgentControlInputSchema, request.body ?? {});
    const actor = await controlUser(request.user.id, request.user.email);
    const session = await roomAgentService.control(params.id, input.action, "reason" in input ? input.reason : undefined, request.requestIdForSpace,
      { expectedMissionId: input.expectedMissionId, actorId: actor.id });
    await recordAudit(store, request, {
      action: `room.agent.${input.action.toLowerCase()}`,
      targetType: "room",
      targetId: params.id,
      metadata: { sessionId: session.sessionId, missionId: session.missionSnapshot?.mission.id ?? null, expectedMissionId: input.expectedMissionId ?? null }
    });
    return session;
  });
  app.patch("/api/rooms/:id/room-agent/monitor", defaultRouteRateLimitOptions, async (request) => {
    if (!options.monitor) throw new SpaceConflictError("The room monitor is unavailable.");
    if (!request.user || request.user.role !== "ADMIN" || request.user.automationScope) throw new SpaceConflictError("Only an authenticated operator may switch the room monitor.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(z.object({ enabled: z.boolean().optional(), autopilot: z.boolean().optional() }).strict()
      .refine((value) => value.enabled !== undefined || value.autopilot !== undefined, "Provide enabled or autopilot."), request.body);
    await store.getRoom(params.id);
    if (input.enabled !== undefined) {
      await options.monitor.repository.setMonitorEnabled(params.id, input.enabled);
      options.monitor.forget(params.id);
    }
    if (input.autopilot !== undefined) await options.monitor.repository.setAutopilotEnabled(params.id, input.autopilot);
    await recordAudit(store, request, { action: "room.agent.monitor", targetType: "room", targetId: params.id, metadata: input });
    return forViewer(await roomAgentService.load(params.id), request.user);
  });
  // The monitor's feed alone, never the conversation: what the Room Agent saw and decided (read only, for agents too).
  app.get("/api/rooms/:id/room-agent/events", defaultRouteRateLimitOptions, async (request) => {
    if (!options.monitor) return { events: [] };
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query);
    return { events: await options.monitor.repository.listEvents(params.id, { limit: query.limit }) };
  });
  app.post("/api/rooms/:id/room-agent/events/:eventId/ack", defaultRouteRateLimitOptions, async (request) => {
    if (!options.monitor) throw new SpaceConflictError("The room monitor is unavailable.");
    const params = parseQuery(z.object({ id: z.string().min(1), eventId: z.string().min(1).max(200) }), request.params);
    const event = await options.monitor.repository.getEvent(params.eventId);
    if (!event || event.roomId !== params.id) throw new SpaceNotFoundError("Room Agent event was not found.");
    const updated = await options.monitor.repository.updateEvent(event.eventId, { status: "ACKED" }, ["OPEN", "ESCALATED", "HANDLED", "RESOLVED"]);
    if (updated) await options.monitor.changed(updated);
    return forViewer(await roomAgentService.load(params.id), request.user);
  });
  app.post("/api/rooms/:id/room-agent/events/:eventId/answer", defaultRouteRateLimitOptions, async (request) => {
    if (!options.monitor) throw new SpaceConflictError("The room monitor is unavailable.");
    if (!request.user || request.user.role !== "ADMIN" || request.user.automationScope) throw new SpaceConflictError("Only an authenticated operator may answer a pane.");
    const params = parseQuery(z.object({ id: z.string().min(1), eventId: z.string().min(1).max(200) }), request.params);
    const input = parseBody(z.object({
      answer: z.string().max(2000).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/).optional(),
      submit: z.boolean().default(true),
      decline: z.boolean().default(false)
    }).strict().refine((value) => value.decline || (value.answer !== undefined && value.answer.trim() !== ""), "Provide an answer or decline."), request.body);
    const event = await options.monitor.repository.getEvent(params.eventId);
    if (!event || event.roomId !== params.id) throw new SpaceNotFoundError("Room Agent event was not found.");
    if (!event.paneId) throw new SpaceConflictError("This event has no pane to answer.");
    if (event.status !== "OPEN" && event.status !== "ESCALATED") throw new SpaceConflictError("This question was already handled.");
    await options.monitor.answer(event, input);
    const decision = input.decline ? "You declined in the Room Agent." : `You answered "${input.answer!.trim().slice(0, 80)}" in the Room Agent.`;
    const updated = await options.monitor.repository.updateEvent(event.eventId, { status: "HANDLED", decision }, ["OPEN", "ESCALATED"]);
    if (updated) await options.monitor.changed(updated);
    await recordAudit(store, request, { action: "room.agent.event.answer", targetType: "room", targetId: params.id,
      metadata: { eventId: event.eventId, paneId: event.paneId, decline: input.decline } });
    return forViewer(await roomAgentService.load(params.id), request.user);
  });
  app.get("/api/room-agent/pending", defaultRouteRateLimitOptions, async (request) => {
    if (!options.monitor) return { rooms: {}, latest: [] };
    const listed = await store.listRooms(request.user?.role === "USER" ? request.user.id : undefined);
    const rooms = listed.map((room) => room.id);
    const [counts, latest] = await Promise.all([options.monitor.repository.pendingCounts(rooms), options.monitor.repository.latestPending(rooms, 10)]);
    // Live says which room an announcement comes from; the operator may be in another one.
    const roomNames = Object.fromEntries(listed.filter((room) => latest.some((event) => event.roomId === room.id)).map((room) => [room.id, room.name]));
    return { rooms: counts, latest, roomNames };
  });
  app.delete("/api/rooms/:id/room-agent/transcript", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const session = await roomAgentService.clearTranscript(params.id, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.agent.transcript.clear",
      targetType: "room",
      targetId: params.id,
      metadata: { sessionId: session.sessionId }
    });
    return forViewer(session, request.user);
  });
}
