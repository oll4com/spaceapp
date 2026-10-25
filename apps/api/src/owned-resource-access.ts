import type { FastifyRequest } from "fastify";
import type { AuthUser, Room, RoomSharePermission } from "@space/contracts";
import { SpaceNotFoundError } from "@space/runtime";

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

export interface OwnedResourceRefusal {
  status: 403 | 404;
  code: "ROOM_SHARE_READ_ONLY" | "PANE_OWNER_ONLY" | "NOT_FOUND";
  message: string;
}

// A USER reaches only these route families, with or without multi-user (deny by default; operator decisions 2026-10-17,
// security review MU-001). Each is confined to the user's rooms by the check below or keeps its own owner check; everything
// else (Space Memory, Shared Chat, audit, Council, Space Control, /api/admin, providers, settings, files, Codex history,
// CLI tasks, Nous, ...) has no owner yet and answers 404. Swarm and Review are read-only and only for a named room.
// `/api/nous` is intentionally absent from this allowlist, preserving its ownerless-feature denial.
const userRoutes: ReadonlyArray<{ prefix: string; methods?: readonly string[]; namesRoom?: true }> = [
  { prefix: "/api/auth" }, { prefix: "/api/app", methods: ["GET"] }, { prefix: "/api/client-errors", methods: ["POST"] },
  { prefix: "/api/rooms" }, { prefix: "/api/panes" }, { prefix: "/api/artifacts" }, { prefix: "/api/events" }, { prefix: "/api/turns" },
  { prefix: "/api/clipboard-items" }, { prefix: "/api/task-items" }, { prefix: "/api/links" }, { prefix: "/api/notifications" },
  { prefix: "/api/user-settings" }, { prefix: "/api/dots" }, { prefix: "/api/live" }, { prefix: "/api/voice" }, { prefix: "/api/databases" },
  { prefix: "/api/job-apply" }, { prefix: "/api/mail-copilot" }, { prefix: "/api/marketing-copilot" }, { prefix: "/api/freelance-copilot" },
  // The Vault is personal: every route's owner is the session user itself (vault/wiring.ts), never a room's.
  { prefix: "/api/space-vault" },
  { prefix: "/api/cli/runtimes", methods: ["GET"] }, { prefix: "/api/cli/runtime-settings", methods: ["GET"] },
  { prefix: "/api/cli/client-events", methods: ["POST"] }, { prefix: "/api/model-capabilities", methods: ["GET"] },
  { prefix: "/api/swarm", methods: ["GET"], namesRoom: true }, { prefix: "/api/reviews", methods: ["GET"], namesRoom: true }
];
const under = (routePath: string, prefix: string) => routePath === prefix || routePath.startsWith(`${prefix}/`);

/**
 * USER accounts reach only the rooms they own or that were shared with them, and what is inside them (multi-user
 * step 3). One check for every route: the room or pane in the path (`/api/rooms/:id`, `/api/proof-rooms/:id`,
 * `/api/panes/:id`, an artifact's room for `/api/artifacts/:id`), and any `roomId`, `paneId` or `roomIds` in the path
 * parameters, query or JSON body. In a shared room VIEW only reads; COLLABORATE also opens its own panes and writes
 * with a body or query roomId; only a pane's owner changes it, types into it or opens its browser (a terminal in
 * someone else's pane only watches). ADMIN and OPERATOR are not checked here.
 */
export function createOwnedResourceGuard(deps: {
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  paneRoomId: (paneId: string) => Promise<string>;
  artifactRoomId: (artifactId: string) => Promise<string | null>;
  /** The share a user holds on a room they do not own; null: none, or sharing is off. */
  shareOf?: (roomId: string, userId: string) => Promise<RoomSharePermission | null>;
  /** The user who opened a pane in a room they do not own; null: the room's owner. */
  paneOwner?: (paneId: string) => Promise<string | null>;
}) {
  return async (request: FastifyRequest, routePath: string): Promise<OwnedResourceRefusal | null> => {
    // A refusal names only the id the caller sent, never the room a pane or artifact belongs to.
    const assertIn = async (roomId: string | null, notFound: string): Promise<Room> => {
      try {
        // An artifact outside every room has no owner a USER could be.
        if (!roomId) throw new SpaceNotFoundError(notFound);
        return await deps.assertRoomAccess(roomId, request.user);
      } catch (error) {
        throw error instanceof SpaceNotFoundError ? new SpaceNotFoundError(notFound) : error;
      }
    };
    const params = fields(request.params);
    if (routePath.startsWith("/api/")) {
      const namesRoom = typeof fields(request.query).roomId === "string";
      const allowed = userRoutes.some((route) => under(routePath, route.prefix) &&
        (!route.methods || route.methods.includes(request.method)) && (!route.namesRoom || namesRoom));
      if (!allowed) return { status: 404, code: "NOT_FOUND", message: "Not found." };
    }
    const pathRooms = new Set<string>();
    const fieldRooms = new Set<string>();
    const listedRooms = new Set<string>();
    const panes = new Set<string>();
    const id = typeof params.id === "string" && params.id ? params.id : null;
    if (id && (routePath.startsWith("/api/rooms/:id") || routePath.startsWith("/api/proof-rooms/:id"))) pathRooms.add(id);
    if (id && routePath.startsWith("/api/panes/:id")) panes.add(id);
    if (id && routePath.startsWith("/api/artifacts/:id")) {
      pathRooms.add((await assertIn(await deps.artifactRoomId(id), `Artifact ${id} was not found.`)).id);
    }
    for (const source of [params, fields(request.query), fields(request.body)]) {
      if (typeof source.roomId === "string" && source.roomId) (source === params ? pathRooms : fieldRooms).add(source.roomId);
      if (typeof source.paneId === "string" && source.paneId) panes.add(source.paneId);
      if (Array.isArray(source.roomIds)) for (const roomId of source.roomIds) if (typeof roomId === "string") listedRooms.add(roomId);
      // A pane moved into a room changes that room: the target must be the user's own (security review 2026-10-17).
      if (typeof source.targetRoomId === "string" && source.targetRoomId) listedRooms.add(source.targetRoomId);
    }

    const userId = request.user?.id;
    const write = request.method !== "GET" && request.method !== "HEAD";
    const readOnly: OwnedResourceRefusal = { status: 403, code: "ROOM_SHARE_READ_ONLY", message: "This room is shared with you to view only." };
    for (const paneId of panes) {
      const room = await assertIn(await deps.paneRoomId(paneId), `Pane ${paneId} was not found.`);
      if (((await deps.paneOwner?.(paneId)) ?? room.ownerUserId) === userId) continue;
      if (write || (request.ws && !routePath.endsWith("/cli/terminal"))) {
        return { status: 403, code: "PANE_OWNER_ONLY", message: "Only the user who opened this pane can change it or type into it." };
      }
    }
    const kinds: Array<[Set<string>, "path" | "field" | "list"]> = [[pathRooms, "path"], [fieldRooms, "field"], [listedRooms, "list"]];
    for (const [rooms, kind] of kinds) {
      for (const roomId of rooms) {
        const room = await assertIn(roomId, `Room ${roomId} was not found.`);
        if (room.ownerUserId === userId || !write || !userId) continue;
        const permission = await deps.shareOf?.(roomId, userId);
        const collaborates = permission === "COLLABORATE" &&
          (kind === "field" || (kind === "path" && request.method === "POST" && routePath === "/api/rooms/:id/panes"));
        if (!collaborates) return readOnly;
      }
    }
    return null;
  };
}
