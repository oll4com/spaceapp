import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { idSchema, type Event } from "@space/contracts";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import type { RoomShareAccess } from "./room-shares.js";
import { sendApiError } from "./http-errors.js";
import { parseQuery } from "./route-parsing.js";
import {
  eventMatchesRoom, formatReplayEvents, formatSseMessage, loadEventStreamReplay, startSseHeartbeat, trackSeenEventId
} from "./sse.js";

const eventStreamQuerySchema = z.object({
  roomId: idSchema.optional(),
  replayLimit: z.coerce.number().int().min(1).max(500).optional()
});

const listEventsQuerySchema = z
  .object({
    roomId: idSchema.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional()
  })
  .transform((input) => ({
    roomId: input.roomId,
    page: input.page ?? 1,
    pageSize: input.pageSize ?? input.limit ?? 50,
    sortOrder: input.sortOrder ?? "desc"
  }));

/**
 * Room event list and the SSE event stream with replay; the parent retains authentication, CSRF, errors and rate
 * limits.
 */
export function registerEventRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  routeOptions: { config: { rateLimit: { max: number; timeWindow: string } } };
  roomShares?: Pick<RoomShareAccess, "shareOf" | "onRemoved">;
}) {
  const { store, eventBus, routeOptions: defaultRouteRateLimitOptions, roomShares } = options;
  // A USER gets events only of rooms they own or that were shared with them (a roomId in the query is checked
  // centrally). Events outside every room carry ids only and still reach everyone. null: ADMIN and OPERATOR see
  // every room, as before. A removed share drops the room from the user's open streams.
  const ownedRoomEvents = (request: FastifyRequest) => {
    const user = request.user;
    if (user?.role !== "USER") return null;
    const owned = new Map<string, Promise<boolean>>();
    const visible = (event: Event): Promise<boolean> => {
      if (!event.roomId) return Promise.resolve(true);
      const roomId = event.roomId;
      let known = owned.get(roomId);
      if (!known) {
        known = Promise.resolve(store.getRoom(roomId)).then(async (room) =>
          room.ownerUserId === user.id || (await roomShares?.shareOf(roomId, user.id) ?? null) !== null, () => false);
        owned.set(roomId, known);
      }
      return known;
    };
    const forget = roomShares?.onRemoved((roomId, userId) => { if (userId === user.id) owned.set(roomId, Promise.resolve(false)); });
    return { visible, close: () => forget?.() };
  };
  app.get("/api/events", defaultRouteRateLimitOptions, async (request, reply) => {
    const parsedQuery = listEventsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", "Invalid request data.", parsedQuery.error.flatten());
    }
    const query = parsedQuery.data;
    if (query.roomId) {
      await store.getRoom(query.roomId);
    }
    // The paged list cannot filter by owner, so a USER lists events one room at a time.
    const events = request.user?.role === "USER" && !query.roomId ? { items: [], total: 0 } : await store.listEventsPage(query);
    return {
      data: events.items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: events.total,
        totalPages: Math.ceil(events.total / query.pageSize)
      }
    };
  });
  app.get("/api/events/stream", { config: { rateLimit: defaultRouteRateLimitOptions.config.rateLimit }, compress: false }, async (request, reply) => {
    const query = parseQuery(eventStreamQuerySchema, request.query);
    if (query.roomId) {
      await store.getRoom(query.roomId);
    }
    const filter = ownedRoomEvents(request);
    const visible = filter?.visible;
    const loaded = await loadEventStreamReplay(store, query);
    const replayEvents = visible ? (await Promise.all(loaded.map(async (event) => (await visible(event)) ? event : null)))
      .filter((event): event is Event => event !== null) : loaded;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(formatSseMessage("ready", { ok: true, requestId: request.requestIdForSpace }));
    reply.raw.write(formatSseMessage("replay-start", { count: replayEvents.length }));
    reply.raw.write(formatReplayEvents(replayEvents));
    reply.raw.write(formatSseMessage("replay-complete", { count: replayEvents.length }));
    const seenEventIds = new Set(replayEvents.map((event) => event.id));
    let isClosed = false;
    const stopHeartbeat = startSseHeartbeat((frame) => {
      if (!isClosed) reply.raw.write(frame);
    });
    const send = (event: Event) => {
      if (!isClosed && eventMatchesRoom(event, query.roomId) && !seenEventIds.has(event.id)) {
        trackSeenEventId(seenEventIds, event.id);
        reply.raw.write(formatSseMessage(event.type, event));
      }
    };
    // The owner lookups are chained so a USER's stream keeps the event order.
    let ordered = Promise.resolve();
    const unsubscribe = eventBus.subscribe((event) => {
      if (!visible) return send(event);
      ordered = ordered.then(async () => { if (await visible(event)) send(event); });
    });
    const closeStream = () => {
      if (isClosed) return;
      isClosed = true;
      stopHeartbeat();
      unsubscribe();
      filter?.close();
    };
    reply.raw.once("close", closeStream);
    request.raw.once("aborted", closeStream);
  });
}
