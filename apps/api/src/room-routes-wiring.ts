import { type AuthUser, type Room } from "@space/contracts";
import { makeSpaceId, type SpaceStore, SpaceNotFoundError } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { createDashboardCliProofController } from "./agents-dashboard-proof.js";
import { createCliRenderAiController } from "./cli-render-ai-proof.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { registerProofRoomRoutes } from "./proof-room-routes.js";
import { recordAudit } from "./request-audit.js";
import type { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import { deleteRoomWithTeardown, registerRoomListRoutes, registerRoomManagementRoutes } from "./room-routes.js";
import { idleProofRooms, PROOF_ROOM_SWEEP_MS } from "./proof-room-sweep.js";
import { PANE_HIBERNATE_SWEEP_MS, runsBackgroundJob, sweepHibernatePanes } from "./pane-hibernate-sweep.js";
import { type createRoomShareAccess, registerRoomShareRoutes } from "./room-shares.js";
import { YouTubeAccountStore } from "./youtube-accounts.js";
import { YouTubePlaybackStore } from "./youtube-playback-state.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type List = D<typeof registerRoomListRoutes>; type Shares = D<typeof registerRoomShareRoutes>; type Proof = D<typeof registerProofRoomRoutes>;
type Manage = D<typeof registerRoomManagementRoutes>; type RenderAi = Parameters<typeof createCliRenderAiController>[0];
type DashboardProof = Parameters<typeof createDashboardCliProofController>[0];
type RoomRoutesDeps = Pick<List, "readDashboardAgents" | "visibleCliRuntimeIds"> & Pick<Proof, "options" | "eventBus" | "codexCliModeDefaultsService" | "cliRuntimeRegistryCache">
  & {
    config: SpaceApiConfig; store: SpaceStore; browserSessionManager: Manage["browserSessionManager"];
    activityLogService: List["activityLogService"] & Proof["activityLogService"];
    cliTerminalManager: Proof["cliTerminalManager"] & Manage["cliTerminalManager"] & Pick<CliTerminalManager, "observeRoomScreen" | "closeUserRoomSockets" | "activeSessionPids" | "interrupt">;
    cliRuntimeVisibility: List["cliRuntimeVisibility"] & Proof["cliRuntimeVisibility"];
    roomShares: ReturnType<typeof createRoomShareAccess>; roomPaneController: Pick<ReturnType<typeof createRoomPaneCliController>, "interrupt">;
    inspectRoomCli: RenderAi["inspect"]; controlQuota: RenderAi["quota"]; controlSend: RenderAi["send"] & DashboardProof["send"];
    defaultRouteRateLimitOptions: List["routeOptions"] & Shares["routeOptions"] & Proof["routeOptions"] & Manage["routeOptions"];
    assertPaneMayClose?: Manage["assertPaneMayClose"];
  };

/** The room routes (moved verbatim from app.ts, ARCH-001 step 79): the room access check, the room list, room shares, the proof rooms with
 * their CLI render and dashboard proof controllers, and room management with the YouTube and browser account stores, in the order app.ts
 * registered them. Returns the access check and the stores, which earlier request-time closures and later routes read. */
export function registerRoomRoutes(app: FastifyInstance, deps: RoomRoutesDeps) {
  const { config, store, options, eventBus, activityLogService, browserSessionManager, cliRuntimeRegistryCache, cliRuntimeVisibility, cliTerminalManager,
    codexCliModeDefaultsService, controlQuota, controlSend, defaultRouteRateLimitOptions, inspectRoomCli, readDashboardAgents, roomPaneController, roomShares,
    visibleCliRuntimeIds } = deps;
  const assertRoomAccess = async (roomId: string, user: AuthUser | null | undefined): Promise<Room> => {
    const room = await store.getRoom(roomId);
    if (user?.role === "USER" && (!room.ownerUserId || room.ownerUserId !== user.id) && !await roomShares.shareOf(roomId, user.id)) {
      throw new SpaceNotFoundError(`Room ${roomId} was not found.`);
    }
    return room;
  };

  registerRoomListRoutes(app, {
    store, activityLogService, cliRuntimeVisibility, readDashboardAgents,
    visibleCliRuntimeIds, routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, agentPaneEnabled: config.agentPaneEnabled,
    sharedRooms: roomShares.sharedRooms
  });
  registerRoomShareRoutes(app, { store, access: roomShares, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input),
    closeUserRoomSockets: (userId, roomId) => void cliTerminalManager.closeUserRoomSockets(userId, roomId) });

  const cliRenderAi=createCliRenderAiController({store,root:config.browserEvidenceArtifactRoot,inspect:inspectRoomCli,quota:controlQuota,send:controlSend,interrupt:pane=>roomPaneController.interrupt(pane,"cli-render-expired")});
  app.addHook("onClose",async()=>cliRenderAi.close());
  const dashboardCliProof = createDashboardCliProofController({
    store, screen: async sessionId => (await cliTerminalManager.observeRoomScreen(sessionId)).text,
    send: controlSend, interrupt: (pane, traceId) => roomPaneController.interrupt(pane, traceId)
  });
  app.addHook("onClose", async () => dashboardCliProof.close());
  registerProofRoomRoutes(app, {
    options, config, store, activityLogService, eventBus, codexCliModeDefaultsService, cliRuntimeRegistryCache,
    cliTerminalManager, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions, cliRenderAi, dashboardCliProof
  });

  const youtubePlaybackStore = new YouTubePlaybackStore(join(dirname(config.browserEvidenceArtifactRoot), "youtube-playback"));
  const youtubeAccountStore = new YouTubeAccountStore(join(dirname(config.browserEvidenceArtifactRoot), "youtube-accounts"));
  const browserAccountStore = new YouTubeAccountStore(join(dirname(config.browserEvidenceArtifactRoot), "browser-accounts"));
  registerRoomManagementRoutes(app, {
    config, store, browserSessionManager, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions,
    assertRoomAccess, cliRenderAi, youtubePlaybackStore, youtubeAccountStore, browserAccountStore, assertPaneMayClose: deps.assertPaneMayClose
  });
  // Abandoned Agent Proof rooms delete themselves through the same path as DELETE /api/rooms/:id (operator 2/11 10:04 BKK).
  const deleteDeps = { config, store, browserSessionManager, cliTerminalManager, cliRenderAi, youtubePlaybackStore, youtubeAccountStore, browserAccountStore, assertPaneMayClose: deps.assertPaneMayClose };
  const sweepProofRooms = async () => {
    for (const room of await idleProofRooms({ store, readDetails: async (roomId) => (await readDashboardAgents(roomId)).details })) {
      const traceId = makeSpaceId("trace");
      await deleteRoomWithTeardown(deleteDeps, room.id, {
        traceId, actor: { holderType: "OPERATOR", holderId: "space:proof-room-autosweep" }, log: app.log, reason: "proof-room-autosweep",
        proofStateUserId: room.ownerUserId ?? "user:operator",
        audit: async (input) => { await store.recordAuditEvent({ actorUserId: null, traceId, ...input }); }
      }).catch((error: unknown) => app.log.warn({ err: error, roomId: room.id }, "Proof room autosweep delete failed."));
    }
  };
  const proofRoomSweep = setInterval(() => void sweepProofRooms().catch((error: unknown) => app.log.warn({ err: error }, "Proof room autosweep failed.")), PROOF_ROOM_SWEEP_MS);
  proofRoomSweep.unref();
  app.addHook("onClose", async () => clearInterval(proofRoomSweep));
  // Idle CLI panes sleep after their owner's Settings → Panes → Sleep after and wake on their next message (plan clipboard:YqhRIXfLAnfK step 2β).
  let hibernateSweeping = false; // a slow sweep never overlaps the next minute's and interrupts a pane twice
  const paneHibernateSweep = setInterval(() => {
    if (hibernateSweeping) return;
    hibernateSweeping = true;
    void sweepHibernatePanes({
    store, readDetails: async (roomId) => (await readDashboardAgents(roomId)).details,
    backgroundJobs: async (sessions) => {
      const pids = await cliTerminalManager.activeSessionPids(sessions);
      const busy = await Promise.all([...pids].map(async ([sessionId, pid]) => (await runsBackgroundJob(pid)) ? sessionId : null));
      return new Set(busy.filter((sessionId): sessionId is string => sessionId !== null));
    },
    interrupt: (sessionId, transcript) => cliTerminalManager.interrupt(sessionId, transcript),
    makeTraceId: () => makeSpaceId("trace"),
    onError: (error, paneId) => app.log.warn({ err: error, paneId }, "Pane hibernate failed.")
  }).then((slept) => { if (slept.length) app.log.info({ event: "pane.hibernate", paneIds: slept }, "Idle CLI panes hibernated."); })
    .catch((error: unknown) => app.log.warn({ err: error }, "Pane hibernate sweep failed."))
    .finally(() => { hibernateSweeping = false; });
  }, PANE_HIBERNATE_SWEEP_MS);
  paneHibernateSweep.unref();
  app.addHook("onClose", async () => clearInterval(paneHibernateSweep));
  return { assertRoomAccess, youtubePlaybackStore, youtubeAccountStore, browserAccountStore };
}
