import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { BrowserHostActorContext } from "@space/browser-host";
import type { RoomAgentEvent } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId, type SpaceStore } from "@space/runtime";
import { defaultDeployQueueRoot, readDeployQueue } from "./deploy-queue.js";
import { sendApiError } from "./http-errors.js";
import { defaultReleasesOptions } from "./instance-releases.js";
import { changeReleaseTrain, listReleaseTrains, releaseTrainInputSchema, releaseTrainLines, type ReleaseTrainActor, type ReleaseTrainInput } from "./release-trains.js";
import { createRoomWork } from "./room-work.js";
import { WorktreeService } from "./worktrees/worktree-service.js";

/**
 * Room coordination (operator request 2026-10-15): the merge queue, the panes' work and the release trains as the
 * Room Agent and the operator see them, wired once here so the composition root only passes them on.
 */
export function createRoomCoordination(deps: {
  store: Pick<SpaceStore, "listPanes" | "getPane" | "getRoom">;
  controlRepository: ControlRepository;
  deployQueueRoot?: string;
  devQueueRoot?: string;
  /** The room as the Room Agent describes it; the work blocks are appended. */
  describeRoom(roomId: string): Promise<string>;
}) {
  const { store, controlRepository } = deps;
  const roomWork = createRoomWork({
    listPanes: async (roomId) => store.listPanes(roomId, true),
    queueRoots: [deps.deployQueueRoot ?? defaultDeployQueueRoot, deps.devQueueRoot ?? defaultReleasesOptions.devQueueRoot],
    trains: () => listReleaseTrains(controlRepository),
    registry: async () => Object.values((await new WorktreeService().readRegistry()).worktrees)
  });

  async function releaseTrain(input: ReleaseTrainInput, by: ReleaseTrainActor): Promise<string> {
    if (input.op !== "status") {
      await changeReleaseTrain(controlRepository, input, by);
      roomWork.forget();
    }
    return (await releaseTrainLines(await listReleaseTrains(controlRepository))).join("\n") || "No release trains yet.";
  }

  return {
    async describeRoom(roomId: string): Promise<string> {
      // shortcut: a turn never waits for git; a read slower than 1 s leaves this turn without the blocks (the monitor's
      // minute read fills the cache). Upgrade to keeping the last read per room if turns miss the blocks too often.
      const work = Promise.race([roomWork.read(roomId).catch(() => null), new Promise<null>((resolve) => { setTimeout(resolve, 1_000, null); })]);
      const [room, ready] = await Promise.all([deps.describeRoom(roomId), work]);
      return ready?.lines.length ? `${room}\n\n${ready.lines.join("\n")}` : room;
    },
    releaseTrain,
    readOverlaps: async (roomId: string) => (await roomWork.read(roomId)).overlaps,
    /**
     * An overlap starts a Room Agent turn as the room's owner; false (the sweep retries) over a running turn, a
     * question the operator has not answered yet, or while the Room Agent has no tool-capable model.
     */
    async coordinate(event: RoomAgentEvent, room: {
      owner(roomId: string): Promise<string | null>;
      chat: { isRunning(roomId: string): boolean; pendingConfirmations(roomId: string): Array<{ expiresAt: number }>; toolsAvailable(): Promise<boolean> };
      send(roomId: string, content: string, clientRequestId: string, traceId: string, actor: BrowserHostActorContext): Promise<unknown>;
    }): Promise<boolean> {
      const owner = await room.owner(event.roomId);
      if (!owner) throw new Error("The room has no owner to act for.");
      if (room.chat.isRunning(event.roomId) || room.chat.pendingConfirmations(event.roomId).some((entry) => entry.expiresAt > Date.now())) return false;
      // A text-only tier (the tool-capable model hit its limit) cannot act on panes: wait for the tools, the sweep retries.
      // shortcut: a gateway failure inside a started turn still counts as coordinating; its answer says what failed.
      if (!await room.chat.toolsAvailable()) return false;
      try {
        // Only the title (pane names, ticket id, release): file names are pane data and stay in the untrusted room context.
        await room.send(event.roomId, `Room monitor: ${event.title}.\nThe details are under "Overlaps to coordinate" in the room context. Coordinate these panes.`,
          `coordinate:${event.eventId}`, makeSpaceId("trace"), { holderType: "OPERATOR", holderId: owner });
        return true;
      } catch (error) {
        if (error instanceof SpaceConflictError) return false;
        throw error;
      }
    },
    registerRoutes(app: FastifyInstance, routeOptions: Pick<RouteShorthandOptions, "config">) {
      app.get("/api/admin/deploy-queue", routeOptions, async (request, reply) => {
        if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "The deploy queue requires ADMIN.");
        return readDeployQueue(deps.deployQueueRoot, Date.now(), {
          paneTitle: async (paneId) => { const pane = await store.getPane(paneId); return pane.paneName || pane.title; },
          roomName: async (roomId) => (await store.getRoom(roomId)).name
        });
      });
      // A pane reads or changes its product's release train through space-admin-action release-train (pane id from its env).
      app.post("/api/release-trains", routeOptions, async (request, reply) => {
        if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Release trains require ADMIN.");
        const { roomId, paneId, ...input } = releaseTrainInputSchema.extend({ roomId: z.string().min(1).max(120), paneId: z.string().min(1).max(120) }).parse(request.body);
        const pane = await store.getPane(paneId);
        if (pane.roomId !== roomId || pane.isClosed) return sendApiError(reply, 403, "PANE_NOT_IN_ROOM", "The pane is not open in this room.");
        try {
          return { text: await releaseTrain(input, { roomId, pane: { paneId: pane.id, name: pane.paneName ?? pane.title }, paneSelf: true }) };
        } catch (error) {
          if (error instanceof SpaceConflictError) return sendApiError(reply, 409, "RELEASE_TRAIN_CONFLICT", error.message);
          throw error;
        }
      });
    }
  };
}
