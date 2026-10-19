import type {} from "./request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { addRoomShareInputSchema, roomShareListResponseSchema, roomShareSchema, setRoomShareInputSchema, type Pane, type Room, type RoomSharePermission } from "@space/contracts";
import { nowIso, type SpaceStore } from "@space/runtime";
import type { AuditRecorder } from "./request-audit.js";
import { sendApiError } from "./http-errors.js";

type ShareStore = Pick<SpaceStore, "getRoom" | "getControlActor" | "setRoomShare" | "deleteRoomShare" | "getRoomShare" |
  "listRoomShares" | "listSharedRooms" | "getPaneOwner" | "setPaneOwner">;

/** Room sharing (multi-user step 3, plan clipboard:evAaFYqrgDfd); everything answers "not shared" with the flag off. */
export function createRoomShareAccess(deps: { store: ShareStore; enabled: boolean }) {
  const { store, enabled } = deps;
  const removedListeners = new Set<(roomId: string, userId: string) => void>();
  const shareOf = async (roomId: string, userId: string): Promise<RoomSharePermission | null> =>
    enabled && store.getRoomShare ? (await store.getRoomShare(roomId, userId))?.permission ?? null : null;
  const explicitPaneOwner = async (paneId: string): Promise<string | null> =>
    enabled && store.getPaneOwner ? await store.getPaneOwner(paneId) : null;
  return {
    enabled,
    shareOf,
    explicitPaneOwner,
    /** Rooms shared with a USER, shown beside their own, each with the user's permission. */
    sharedRooms: async (userId: string): Promise<Room[]> => enabled && store.listSharedRooms
      ? await Promise.all((await store.listSharedRooms(userId)).map(async (room) => ({ ...room, sharePermission: await shareOf(room.id, userId) ?? undefined })))
      : [],
    /** A pane opened by someone other than the room's owner belongs to whoever opened it. */
    async notePaneCreator(pane: Pane, userId: string): Promise<void> {
      if (!enabled || !store.setPaneOwner) return;
      if ((await store.getRoom(pane.roomId)).ownerUserId !== userId) await store.setPaneOwner(pane.id, userId);
    },
    /**
     * True when a user may only watch this pane's terminal (operator-approved 2026-10-16): someone else opened it,
     * or the room was shared with the user. Rooms without shares and the operator's rooms are unchanged.
     */
    async observeOnly(pane: Pane, userId: string): Promise<boolean> {
      if (!enabled) return false;
      const owner = await explicitPaneOwner(pane.id);
      if (owner) return owner !== userId;
      const room = await store.getRoom(pane.roomId);
      return room.ownerUserId !== userId && (await shareOf(room.id, userId)) !== null;
    },
    onRemoved(listener: (roomId: string, userId: string) => void): () => void {
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },
    removed(roomId: string, userId: string): void {
      for (const listener of removedListeners) listener(roomId, userId);
    }
  };
}

export type RoomShareAccess = ReturnType<typeof createRoomShareAccess>;

/** Share routes for the room's owner; the parent retains authentication, CSRF, errors and rate limits. */
export function registerRoomShareRoutes(app: FastifyInstance, options: {
  store: ShareStore;
  access: RoomShareAccess;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Ends the user's terminal sockets in the room. */
  closeUserRoomSockets: (userId: string, roomId: string) => void;
}) {
  const { store, access, recordAudit, routeOptions, closeUserRoomSockets } = options;
  const ownedRoom = async (roomId: string, userId: string | undefined) => {
    const room = await store.getRoom(roomId);
    return room.ownerUserId && room.ownerUserId === userId ? room : null;
  };
  const params = z.object({ id: z.string().min(1), userId: z.string().min(1).optional() });
  const refuse = (reply: Parameters<typeof sendApiError>[0], disabled: boolean) => disabled
    ? sendApiError(reply, 404, "MULTI_USER_DISABLED", "Multi-user accounts are not enabled on this installation.")
    : sendApiError(reply, 403, "ROOM_OWNER_ONLY", "Only the room's owner shares it.");

  app.get("/api/rooms/:id/shares", routeOptions, async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!access.enabled || !store.listRoomShares) return refuse(reply, true);
    if (!await ownedRoom(id, request.user?.id)) return refuse(reply, false);
    const shares = await Promise.all((await store.listRoomShares(id)).map(async (share) =>
      ({ ...share, email: (await store.getControlActor(share.userId))?.email ?? "unknown@invalid" })));
    return roomShareListResponseSchema.parse({ shares });
  });

  const share = async (request: FastifyRequest, reply: FastifyReply, id: string, user: { id: string } | null, permission: RoomSharePermission) => {
    if (!access.enabled || !store.setRoomShare) return refuse(reply, true);
    const room = await ownedRoom(id, request.user?.id);
    if (!room) return refuse(reply, false);
    if (!user || user.id === room.ownerUserId) return sendApiError(reply, 404, "USER_NOT_FOUND", "No other SpaceApp user has this account.");
    const stored = await store.setRoomShare(roomShareSchema.parse({ roomId: id, userId: user.id, permission, createdBy: request.user!.id, createdAt: nowIso() }));
    await recordAudit(request, { action: "room.share.set", targetType: "room", targetId: id, metadata: { userId: user.id, permission } });
    return stored;
  };

  // Shares with a team member by email (the room's owner does not get the list of users).
  app.put("/api/rooms/:id/shares", routeOptions, async (request, reply) => {
    const { id } = params.parse(request.params);
    const { email, permission } = addRoomShareInputSchema.parse(request.body);
    // getControlActor matches the email when no user has it as an id.
    return share(request, reply, id, await store.getControlActor(email, email), permission);
  });

  app.put("/api/rooms/:id/shares/:userId", routeOptions, async (request, reply) => {
    const { id, userId } = params.required({ userId: true }).parse(request.params);
    const { permission } = setRoomShareInputSchema.parse(request.body);
    return share(request, reply, id, await store.getControlActor(userId), permission);
  });

  app.delete("/api/rooms/:id/shares/:userId", routeOptions, async (request, reply) => {
    const { id, userId } = params.required({ userId: true }).parse(request.params);
    if (!access.enabled || !store.deleteRoomShare) return refuse(reply, true);
    if (!await ownedRoom(id, request.user?.id)) return refuse(reply, false);
    if (!await store.deleteRoomShare(id, userId)) return sendApiError(reply, 404, "SHARE_NOT_FOUND", "This room is not shared with this user.");
    // The user loses the room at once: open terminals close and their event stream forgets the room.
    access.removed(id, userId);
    closeUserRoomSockets(userId, id);
    await recordAudit(request, { action: "room.share.removed", targetType: "room", targetId: id, metadata: { userId } });
    return { roomId: id, userId, removed: true };
  });
}
