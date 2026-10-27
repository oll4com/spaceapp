import type {} from "./request-context.js";
import { execFile } from "./safe-child-process.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isBrowserPane, isCliPane } from "./pane-guards.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  type AuthUser, createRoomInputSchema, MAX_ROOMS, paginationRequestSchema, roomLimitReached, type Pane, type PaneBrowserSession,
  type PaneCliSession, pickNextAvailableRoomName, reorderPanesInputSchema, reorderRoomsInputSchema, type Room,
  roomCliActivityResponseSchema, roomKindSchema, updatePaneLayoutInputSchema, updateRoomInputSchema
} from "@space/contracts";
import { nowIso, SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { ActivityLogService } from "./activity-log.js";
import type { DashboardActivityDetail, DashboardStatus } from "./agents-dashboard.js";
import { operatorBrowserActor } from "./browser-actors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import {
  cleanupCliRenderAiRepository, cliRenderAiDescription, type createCliRenderAiController
} from "./cli-render-ai-proof.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { mayCreatePaneDirectory, resolveProjectEnsureTarget } from "./project-paths.js";
import { WORKTREES_ROOT } from "./worktrees/worktree-service.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { YouTubeAccountStore } from "./youtube-accounts.js";
import type { YouTubePlaybackStore } from "./youtube-playback-state.js";

const execFileAsync = promisify(execFile);

export interface DashboardAgentsSample {
  data: Pane[];
  activity: Record<string, DashboardStatus>;
  details: Record<string, DashboardActivityDetail>;
  sampledAt: string;
}

/**
 * Room list, dashboard agents, CLI activity and room creation; the parent retains authentication, CSRF, errors and
 * rate limits.
 */
export function registerRoomListRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  activityLogService: ActivityLogService;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  /** Open panes and their live activity, cached briefly and shared with the Room Agent. */
  readDashboardAgents: (roomId: string) => Promise<DashboardAgentsSample>;
  visibleCliRuntimeIds: () => Promise<string[]>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  /** SPACE_AGENT_PANE_ENABLED: without agent panes a room created without initialPaneCount starts empty. */
  agentPaneEnabled: boolean;
  /** Rooms shared with a USER (multi-user), listed after their own. */
  sharedRooms?: (userId: string) => Promise<Room[]>;
}) {
  const { store, activityLogService, cliRuntimeVisibility, readDashboardAgents,
    visibleCliRuntimeIds, routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, agentPaneEnabled, sharedRooms } = options;
  app.get("/api/rooms", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(paginationRequestSchema, request.query);
    const query = request.query as { all?: string; ownerUserId?: string } | undefined;
    const isUserRole = request.user?.role === "USER";
    const filterUserId = isUserRole
      ? request.user!.id
      : (query?.ownerUserId && query.ownerUserId !== "all"
          ? (query.ownerUserId === "me" ? request.user?.id ?? null : query.ownerUserId)
          : (query?.all === "false" ? request.user?.id ?? null : null));
    let rooms = await store.listRooms(filterUserId);
    if (rooms.length === 0 && request.user && (!filterUserId || filterUserId === request.user.id)) {
      if (store.ensureUserStarterRoom) {
        const starter = await store.ensureUserStarterRoom(request.user.id, request.user.email, request.requestIdForSpace);
        if (starter) {
          rooms = await store.listRooms(filterUserId);
        }
      }
    }
    if (isUserRole && sharedRooms) rooms = [...rooms, ...await sharedRooms(request.user!.id)];
    const start = (page.page - 1) * page.pageSize;
    return {
      data: rooms.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: rooms.length,
        totalPages: Math.ceil(rooms.length / page.pageSize)
      }
    };
  });
  app.get("/api/rooms/:id/dashboard-agents", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    return readDashboardAgents(params.id);
  });
  app.get("/api/rooms/cli-activity", defaultRouteRateLimitOptions, async (request) => {
    const runtimeIds = await visibleCliRuntimeIds();
    const query = request.query as { all?: string; ownerUserId?: string } | undefined;
    const isUserRole = request.user?.role === "USER";
    const filterUserId = isUserRole
      ? request.user!.id
      : (query?.ownerUserId && query.ownerUserId !== "all"
          ? (query.ownerUserId === "me" ? request.user?.id ?? null : query.ownerUserId)
          : (query?.all === "false" ? request.user?.id ?? null : null));
    const [rooms, activity] = await Promise.all([
      store.listRooms(filterUserId),
      store.listRunningCliSessionCountsByRoom(runtimeIds)
    ]);
    const activityByRoomId = new Map(activity.map((item) => [
      item.roomId,
      item as typeof item & { runtimeIds?: string[] }
    ]));
    return roomCliActivityResponseSchema.parse({
      data: rooms.map((room) => {
        const roomActivity = activityByRoomId.get(room.id);
        return {
          roomId: room.id,
          runningCliCount: roomActivity?.runningCliCount ?? 0,
          paneCount: roomActivity?.paneCount ?? 0,
          runtimeIds: roomActivity?.runtimeIds ?? []
        };
      }),
      sampledAt: nowIso()
    });
  });
  app.post("/api/rooms", defaultRouteRateLimitOptions, async (request) => {
    const parsed = parseBody(createRoomInputSchema, request.body);
    // The contract default (4 agent panes) would open panes that cannot run on a public install (pilot F7).
    const omitted = (request.body as { initialPaneCount?: unknown } | null | undefined)?.initialPaneCount === undefined;
    const input = !agentPaneEnabled && omitted ? { ...parsed, initialPaneCount: 0 } : parsed;
    if (input.initialPaneCount > 0) await cliRuntimeVisibility.assertEnabled("cli:codex");
    const existingRooms = await store.listRooms(request.user?.id ?? null);
    const roomLimit = request.user ? (await store.getUserSettings(request.user.id)).roomLimit : MAX_ROOMS;
    if (roomLimitReached(existingRooms, roomLimit)) {
      throw new SpaceConflictError(`Maximum room limit of ${roomLimit} rooms reached. Test rooms do not count; change the limit in Settings → Workspace → Rooms.`);
    }
    const roomName = input.name?.trim() || pickNextAvailableRoomName(existingRooms.map((r) => r.name));
    const room = await store.createRoom({ ...input, name: roomName }, request.requestIdForSpace, request.user?.id ?? null);
    await recordAudit(store, request, {
      action: "room.create",
      targetType: "room",
      targetId: room.id,
      metadata: { name: room.name, initialPaneCount: input.initialPaneCount }
    });
    await activityLogService.recordRoomCreate({
      roomId: room.id,
      actorUserId: request.user?.id ?? null,
      reason: input.reason,
      traceId: request.requestIdForSpace,
      metadata: { roomName: room.name, initialPaneCount: input.initialPaneCount }
    });
    return room;
  });
}

/**
 * Room ordering, settings, project folders, pane layout, deletion and agent history; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerRoomManagementRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  cliTerminalManager: CliTerminalManager;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  cliRenderAi: ReturnType<typeof createCliRenderAiController>;
  youtubePlaybackStore: YouTubePlaybackStore;
  youtubeAccountStore: YouTubeAccountStore;
  browserAccountStore: YouTubeAccountStore;
}) {
  const { config, store, browserSessionManager, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions,
    assertRoomAccess, cliRenderAi, youtubePlaybackStore, youtubeAccountStore, browserAccountStore } = options;
  app.post("/api/rooms/reorder", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(reorderRoomsInputSchema, request.body);
    return store.reorderRooms(input.roomIds, request.requestIdForSpace);
  });
  app.post("/api/rooms/:id/panes/reorder", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    const input = parseBody(reorderPanesInputSchema, request.body);
    const panes = await store.reorderPanes(params.id, input.paneIds, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.panes.reorder",
      targetType: "room",
      targetId: params.id,
      metadata: { paneCount: panes.length }
    });
    return panes;
  });
  app.patch("/api/rooms/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    const input = parseBody(updateRoomInputSchema, request.body);
    if (typeof input.projectPath === "string") {
      const trimmed = input.projectPath.trim();
      // A missing project directory is created only where pane creation may create one
      // (SEC-009 policy): never in system trees, shared parents or the live installation.
      if (trimmed && !existsSync(trimmed) && await mayCreatePaneDirectory({
        cwd: trimmed, role: request.user?.role, projectsRoot: config.projectsRoot, installRoot: config.installRoot, worktreesRoot: WORKTREES_ROOT
      })) {
        try {
          await mkdir(trimmed, { recursive: true, mode: 0o775 });
        } catch (err) {
          request.log.warn({ err, dir: trimmed }, "Failed to auto-create room project directory");
        }
      }
    }
    const room = await store.updateRoom(params.id, input, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.update",
      targetType: "room",
      targetId: room.id,
      metadata: { name: room.name }
    });
    return room;
  });
  app.post("/api/projects/ensure", defaultRouteRateLimitOptions, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; path?: unknown };
    const target = await resolveProjectEnsureTarget({
      name: body.name,
      path: body.path,
      role: request.user?.role,
      projectsRoot: config.projectsRoot,
      installRoot: config.installRoot
    });
    if (!target.ok) {
      return reply.status(target.status).send({ ok: false, error: target.error, code: target.code });
    }
    const targetPath = target.path;
    try {
      await mkdir(targetPath, { recursive: true, mode: 0o775 });
      try {
        if (!existsSync(join(targetPath, ".git"))) {
          await execFileAsync("git", ["init", "-b", "main", targetPath]);
        }
      } catch (gitErr) {
        request.log.warn({ err: gitErr, targetPath }, "Failed to auto-init git in project directory");
      }
      return reply.send({ ok: true, path: targetPath, name: target.name });
    } catch (err: any) {
      request.log.error({ err, targetPath }, "Failed to ensure project directory");
      return reply.status(500).send({ ok: false, error: `Failed to create directory: ${err?.message || String(err)}` });
    }
  });
  app.put("/api/rooms/:id/pane-layout", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    const input = parseBody(updatePaneLayoutInputSchema, request.body);
    const result = await store.updateRoomPaneLayout(params.id, input, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.pane-layout.update",
      targetType: "room",
      targetId: result.room.id,
      metadata: {
        paneLayoutColumns: input.paneLayoutColumns,
        paneLayoutHeight: input.paneLayoutHeight,
        paneCount: result.panes.length
      }
    });
    return result;
  });
  app.delete("/api/rooms/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    // ?kind=AGENT_PROOF: agents delete only their proof rooms, never an operator room by a wrong id.
    const expected = (request.query as { kind?: unknown } | undefined)?.kind;
    if (expected !== undefined && (await store.getRoom(params.id)).kind !== roomKindSchema.parse(expected)) throw new SpaceConflictError("The room is not of the expected kind.");
    const panes = await store.listPanes(params.id, true);
    const cliSessions: PaneCliSession[] = [];
    const browserSessions: PaneBrowserSession[] = [];
    for (const pane of panes) {
      if (isCliPane(pane)) {
        const active = await store.getActivePaneCliSession(pane.id);
        if (active) cliSessions.push(active);
      }
      if (isBrowserPane(pane)) {
        const active = await store.getActivePaneBrowserSession(pane.id);
        if (active) browserSessions.push(active);
      }
    }
    // The Unix host resolves stopPane against the stored active session. Stop
    // browsers before cascading room deletion removes that identity; otherwise
    // their Chrome processes keep consuming capacity until the host restarts.
    await Promise.all(browserSessions.map((session) =>
      browserSessionManager.stopPane(session.paneId, request.requestIdForSpace, operatorBrowserActor(request))
    ));
    const room = await store.deleteRoom(params.id);
    if(room.description===cliRenderAiDescription)cliRenderAi.dispose(room.id);
    if (room.kind === "AGENT_PROOF") {
      await youtubePlaybackStore.removeProofState(`${request.user!.id}:proof:${room.id}`);
      await youtubeAccountStore.removeProofState(`${request.user!.id}:proof:${room.id}`);
      await browserAccountStore.removeProofState(`${request.user!.id}:proof:${room.id}`);
    }
    await recordAudit(store, request, {
      action: "room.delete",
      targetType: "room",
      targetId: room.id,
      metadata: {
        name: room.name,
        paneCap: room.paneCap,
        interruptedCliSessions: cliSessions.length,
        closedBrowserSessions: browserSessions.length,
        deferredTeardown: cliSessions.length
      }
    });
    void (async () => {
      try {
        const settled = await Promise.allSettled(
          cliSessions.map((session) => cliTerminalManager.detachSession(session))
        );
        const failed = settled.filter((entry) => entry.status === "rejected").length;
        if(!failed&&room.description===cliRenderAiDescription)await cleanupCliRenderAiRepository(config.browserEvidenceArtifactRoot,room.id);
        request.log.info(
          {
            roomId: room.id,
            cliSessions: cliSessions.length,
            browserSessions: browserSessions.length,
            failedTeardown: failed
          },
          "room delete background teardown completed"
        );
      } catch (error) {
        request.log.error({ err: error, roomId: room.id }, "room delete background teardown failed");
      }
    })();
    return { ok: true, roomId: room.id };
  });
  app.get("/api/rooms/:id/agent-history", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await store.getRoom(params.id);
    const history = [...(await store.listSpaceAgentHistory(params.id)), ...(await store.listAgentPaneHistory(params.id))]
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .slice(0, 100);
    return {
      data: history,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: history.length,
        totalPages: history.length ? 1 : 0
      }
    };
  });
}
