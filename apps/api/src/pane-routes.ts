import type {} from "./request-context.js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  type AuthUser, cliToggleRuntimeIdSchema, createPaneInputSchema, createRoomPanesRequestSchema, eventSchema,
  type HarnessMaintenanceStatus, listPanesQuerySchema, movePaneInputSchema, type Pane, type PaneCliSession,
  type PaneBrowserSessionResponse, type PaneCapabilityGroup, type PaneCapabilityItem, type PaneCapabilityMatrix,
  paneCapabilityMatrixSchema, type Room, roomCommandSchema, roomPanesResultSchema, taskTitleSettingsSchema,
  updatePaneInputSchema
} from "@space/contracts";
import type { InMemoryTaskTitleRepository, PostgresTaskTitleRepository } from "@space/db";
import {
  makeSpaceId, nowIso, SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, type SpaceStore
} from "@space/runtime";
import { operatorBrowserActor } from "./browser-actors.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { isCliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import type { CliPaneReopener } from "./cli-pane-reopen.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { publishHarnessAgentTokens } from "./harness-agent-tokens.js";
import { sendApiError } from "./http-errors.js";
import { getLatestRoomEvent, getPaneById, isBrowserPane, isCliPane } from "./pane-guards.js";
import { mayCreatePaneDirectory } from "./project-paths.js";
import { recordAudit } from "./request-audit.js";
import type { RoomAgentService } from "./room-agent.js";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { SpaceControl } from "./space-control.js";
import type { TaskTitleProviders } from "./task-title-providers.js";
import type { TaskTitleService } from "./task-title-service.js";
import { WORKTREES_ROOT } from "./worktrees/worktree-service.js";
import { youtubeBrowserPlayback, type YouTubePlaybackStore } from "./youtube-playback-state.js";

function forceOnForChat(paneMode: Pane["mode"]): "force_on" | "selectable" {
  return "force_on";
}

function statusForCapabilityItems(items: readonly PaneCapabilityItem[]): PaneCapabilityGroup["status"] {
  if (items.some((item) => item.status === "ERROR")) return "ERROR";
  if (items.some((item) => item.status === "WARN" || item.status === "DISABLED")) return "WARN";
  return "VERIFIED";
}

async function buildPaneCapabilityMatrix(store: SpaceStore, pane: Pane): Promise<PaneCapabilityMatrix> {
  const [mcpServers, skills] = await Promise.all([store.listMcpServers(), store.listSkills()]);
  const memoryItems: PaneCapabilityItem[] = [
    {
      id: "memory:search",
      label: "Memory search",
      status: "VERIFIED",
      statusReason: "Force-on canonical Space Memory search through Space mediation.",
      execution: forceOnForChat(pane.mode),
      requiresApproval: false
    },
    {
      id: "memory:save",
      label: "Memory save",
      status: "VERIFIED",
      statusReason: "Authenticated saves append directly to the canonical Space Memory monthly file with redaction and audit.",
      execution: forceOnForChat(pane.mode),
      requiresApproval: false
    }
  ];
  const skillItems: PaneCapabilityItem[] = [
    {
      id: "skills:list",
      label: "Skills list",
      status: "VERIFIED",
      statusReason: `${skills.length} Space/Codex skills are visible through mediated reads.`,
      execution: forceOnForChat(pane.mode),
      requiresApproval: false
    },
    {
      id: "skills:read",
      label: "Skills read",
      status: "VERIFIED",
      statusReason: "Verified bounded skill bodies are readable without exposing raw config.",
      execution: forceOnForChat(pane.mode),
      requiresApproval: false
    }
  ];
  const mcpItems: PaneCapabilityItem[] = mcpServers.map((server) => ({
    id: `mcp:${server.id}`,
    label: server.displayName,
    status: server.status === "VERIFIED" ? "VERIFIED" : server.status === "ERROR" ? "ERROR" : "DISABLED",
    statusReason: server.statusReason,
    execution: server.status === "VERIFIED" ? "selectable" : "metadata_only",
    requiresApproval: true
  }));
  const groups: PaneCapabilityGroup[] = [
    {
      id: "memory",
      label: "Memory",
      status: statusForCapabilityItems(memoryItems),
      statusReason: "Canonical Space Memory is exposed through mediated tools as the shared read/write plane.",
      items: memoryItems
    },
    {
      id: "skills",
      label: "Skills",
      status: statusForCapabilityItems(skillItems),
      statusReason: "Space static skills and verified Codex skills are available as read-only capability context.",
      items: skillItems
    },
    {
      id: "mcp",
      label: "MCP",
      status: mcpItems.length ? statusForCapabilityItems(mcpItems) : "DISABLED",
      statusReason: mcpItems.length
        ? "MCP servers are visible as metadata; execution depends on smoke, allowlist, and approval."
        : "No MCP servers are configured for this pane.",
      items: mcpItems
    }
  ];
  return paneCapabilityMatrixSchema.parse({
    paneId: pane.id,
    paneMode: pane.mode,
    generatedAt: nowIso(),
    groups
  });
}

/**
 * Pane list, room pane catalog and durable room commands, watchdog test alert, pane creation, update, move, titles,
 * task title settings, capabilities and deletion; the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerPaneRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  taskTitleRepository: PostgresTaskTitleRepository | InMemoryTaskTitleRepository;
  taskTitleProviders: TaskTitleProviders;
  taskTitles: TaskTitleService;
  roomPaneCommands: ReturnType<typeof createRoomPaneCommands>;
  spaceControl: SpaceControl;
  roomAgentService: RoomAgentService;
  assertRootAdmin: (request: FastifyRequest, runtimeId: string | null | undefined) => void;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  youtubePlaybackStore: YouTubePlaybackStore;
  readDeepSeekHarnessMaintenanceStatus: () => Promise<HarnessMaintenanceStatus>;
  youtubeSessionStarts: Map<string, Promise<PaneBrowserSessionResponse>>;
  youtubeAccountOperations: Map<string, Promise<unknown>>;
  initializeNewPaneGoogleAccount: (userId: string, pane: Pane) => Promise<void>;
  cliPaneReopener: CliPaneReopener;
  /** A new Job Copilot pane continues the previous one's terminal session (registered as the pane's pending resume). */
  resumePreviousJobCopilotSession?: (pane: Pane, traceId: string) => Promise<boolean>;
  /** Records the native conversation of a running CLI session, for CLIs that name it only while they run (Claude). */
  rememberCliNativeRef?: (session: PaneCliSession) => Promise<void>;
}) {
  const { config, store, eventBus, browserSessionManager, cliTerminalManager, cliRuntimeVisibility,
    taskTitleRepository, taskTitleProviders, taskTitles, roomPaneCommands, spaceControl, roomAgentService,
    assertRootAdmin, routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, youtubePlaybackStore,
    readDeepSeekHarnessMaintenanceStatus, youtubeSessionStarts, youtubeAccountOperations,
    initializeNewPaneGoogleAccount, cliPaneReopener, resumePreviousJobCopilotSession, rememberCliNativeRef } = options;
  /** One pane per request continues the previous Job Copilot session; more would share one conversation. */
  function continuePreviousJobCopilot(panes: Pane[], traceId: string): void {
    const copilot = panes.find((pane) => pane.mode === "JOB_APPLY");
    if (copilot && resumePreviousJobCopilotSession) cliPaneReopener.reopen(copilot.id, () => copilot, traceId, resumePreviousJobCopilotSession);
  }
  app.get("/api/panes", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(listPanesQuerySchema, request.query);
    const enabledRuntimeIds = new Set(await cliRuntimeVisibility.enabledRuntimeIds());
    const panes = (await store.listPanes(query.roomId, query.includeClosed)).filter((pane) => {
      if (!isCliPane(pane) || !pane.terminalRuntimeId) return true;
      const toggleRuntimeId = cliToggleRuntimeIdSchema.safeParse(pane.terminalRuntimeId);
      return !toggleRuntimeId.success || enabledRuntimeIds.has(toggleRuntimeId.data);
    });
    return {
      data: panes,
      pagination: {
        page: 1,
        pageSize: 100,
        totalItems: panes.length,
        totalPages: 1
      }
    };
  });
  app.get("/api/rooms/:id/pane-catalog", defaultRouteRateLimitOptions, async (request) => {
    if (!config.roomPaneCommandsEnabled) throw new SpaceFeatureDisabledError("ROOM_PANE_COMMANDS_DISABLED", "Room pane commands are disabled.");
    const params = parseQuery(idParamSchema, request.params);
    const room = await store.getRoom(params.id);
    const panes = await store.listPanes(params.id);
    return { version: roomPaneCommands.version, availableSlots: Math.max(0, room.paneCap - panes.filter(pane => !pane.isClosed).length),
      data: await roomPaneCommands.catalog() };
  });
  app.post("/api/rooms/:id/commands", defaultRouteRateLimitOptions, async (request) => {
    if (!config.roomPaneCommandsEnabled) throw new SpaceFeatureDisabledError("ROOM_PANE_COMMANDS_DISABLED", "Room pane commands are disabled.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(roomCommandSchema, request.body);
    const session = await roomAgentService.executeCommand(params.id, input, request.requestIdForSpace, operatorBrowserActor(request));
    // Preserve the existing complete OPEN_PANES response. This read uses the same
    // durable pane transaction and can never create another batch on replay.
    if (input.action.type === "OPEN_PANES") return roomPaneCommands.execute(params.id, request.user!.id,
      { ...input, action: input.action }, request.requestIdForSpace);
    return session;
  });
  app.post("/api/rooms/:id/watchdog/test-alert", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const room = await store.getRoom(params.id);
    const alertMessage = `Room Watchdog: Auto-killed hanging process in room "${room.name}" to prevent room freeze.`;
    const watchdogEvent = eventSchema.parse({
      id: makeSpaceId("event"),
      roomId: room.id,
      paneId: null,
      turnId: null,
      workflowId: null,
      traceId: request.requestIdForSpace,
      type: "ROOM_WATCHDOG_ALERT",
      message: alertMessage,
      payload: {
        kind: "TEST_WATCHDOG_ALERT",
        roomId: room.id,
        simulated: true,
        killedAt: nowIso()
      },
      createdAt: nowIso()
    });
    const recorded = await Promise.resolve(store.recordRoomEvent(watchdogEvent)).catch(() => null);
    eventBus.publish(recorded ?? watchdogEvent);
    return { ok: true, event: watchdogEvent };
  });
  app.post("/api/rooms/:id/commands/:clientRequestId/ack", defaultRouteRateLimitOptions, async (request) => {
    if (!config.roomPaneCommandsEnabled) throw new SpaceFeatureDisabledError("ROOM_PANE_COMMANDS_DISABLED", "Room pane commands are disabled.");
    const params = parseQuery(z.object({ id: z.string().min(1), clientRequestId: z.string().min(8).max(128) }), request.params);
    const input = parseBody(z.object({ ok: z.boolean() }).strict(), request.body);
    return roomAgentService.acknowledgeCommand(params.id, params.clientRequestId, input.ok, operatorBrowserActor(request));
  });
  app.post("/api/rooms/:id/panes", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    await assertRoomAccess(params.id, request.user);
    const input = parseBody(createRoomPanesRequestSchema, request.body);
    for (const item of input.panes) {
      if (item.mode === "CHAT") {
        await cliRuntimeVisibility.assertEnabled("cli:codex");
      }
    }
    const paneInputs = await roomPaneCommands.resolve(params.id, input.panes);
    // A copilot pane's account (launch dialog or the user's default) must exist; the pane's CLI session
    // keeps it, not the pane row (the Browser Host parses pane rows with the contracts it started with).
    for (const [index, item] of input.panes.entries()) {
      const runtimeId = paneInputs[index]?.terminalRuntimeId;
      if ((item.mode !== "JOB_APPLY" && item.mode !== "MAIL_COPILOT" && item.mode !== "MARKETING_COPILOT" && item.mode !== "FREELANCE_COPILOT" && item.mode !== "DESIGN" && item.mode !== "APP_STUDIO") || !item.accountProfileId || !runtimeId || !isCliAccountProfileRuntimeId(runtimeId)) continue;
      if (!await store.getCliAccountProfile(runtimeId, item.accountProfileId)) {
        throw new SpaceConflictError(`CLI account profile ${runtimeId}/${item.accountProfileId} was not found.`);
      }
    }
    const panes = await store.createPanes(paneInputs, request.requestIdForSpace);
    for (const pane of panes) await initializeNewPaneGoogleAccount(request.user!.id, pane);
    continuePreviousJobCopilot(panes, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "room.panes.create",
      targetType: "room",
      targetId: params.id,
      metadata: {
        paneCount: panes.length,
        modes: panes.map((pane) => pane.mode),
        terminalRuntimeIds: panes.flatMap((pane) => pane.terminalRuntimeId ? [pane.terminalRuntimeId] : [])
      }
    });
    const paneIds = new Set(panes.map((pane) => pane.id));
    const createdEvents = (await store.listEvents(params.id)).filter(
      (event) => event.type === "PANE_CREATED" && event.paneId && paneIds.has(event.paneId)
    );
    for (const event of createdEvents) eventBus.publish(event);
    return roomPanesResultSchema.parse({ roomId: params.id, data: panes });
  });
  app.post("/api/panes", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createPaneInputSchema, request.body);
    assertRootAdmin(request, input.terminalRuntimeId);
    if (isCliPane(input) && input.terminalRuntimeId) {
      await cliRuntimeVisibility.assertEnabled(input.terminalRuntimeId);
    }
    if (input.mode === "CHAT") {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
    }
    if (input.mode === "HARNESS") {
      const harnessStatus = await readDeepSeekHarnessMaintenanceStatus();
      if (!harnessStatus.enabled || harnessStatus.effectiveMode === "BLOCKED") {
        throw new SpaceFeatureDisabledError("HARNESS_DISABLED", "DeepSeek Harness is disabled. Enable it in Settings to open a Harness pane.");
      }
    }
    if ((input.mode === "TERMINAL" || input.mode === "FILES" || input.mode === "DATABASES" || input.mode === "CHAT" || input.mode === "HARNESS") && (!input.cwd || input.cwd === "/etc")) {
      try {
        const room = await store.getRoom(input.roomId);
        if (room?.projectPath) {
          input.cwd = room.projectPath;
        }
      } catch {
        // Best effort fallback
      }
    }
    if (input.cwd && typeof input.cwd === "string" && input.cwd.startsWith("/")) {
      // SEC-009: only create a missing directory where a project or worktree may live.
      const cwd = input.cwd.trim();
      if (!existsSync(cwd) && await mayCreatePaneDirectory({
        cwd, role: request.user?.role, projectsRoot: config.projectsRoot, installRoot: config.installRoot, worktreesRoot: WORKTREES_ROOT
      })) {
        try {
          await mkdir(cwd, { recursive: true, mode: 0o775 });
        } catch {}
      }
    }
    const pane = await store.createPane(input, request.requestIdForSpace);
    await initializeNewPaneGoogleAccount(request.user!.id, pane);
    continuePreviousJobCopilot([pane], request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "pane.create",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, mode: pane.mode }
    });
    const latestEvent = await getLatestRoomEvent(store, input.roomId);
    if (latestEvent) {
      eventBus.publish(latestEvent);
    }
    return pane;
  });
  app.patch("/api/panes/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = request.params as { id: string };
    const input = parseBody(updatePaneInputSchema, request.body);
    const existingPane = await getPaneById(store, params.id);
    assertRootAdmin(request, input.terminalRuntimeId ?? existingPane.terminalRuntimeId);
    const targetRuntimeId = input.terminalRuntimeId ?? existingPane.terminalRuntimeId;
    const targetMode = input.mode ?? existingPane.mode;
    if (isCliPane({ mode: targetMode }) && targetRuntimeId && input.isClosed !== true) {
      await cliRuntimeVisibility.assertEnabled(targetRuntimeId);
    }
    if (targetMode === "CHAT" && input.isClosed !== true) {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
    }
    if (targetMode === "HARNESS" && input.isClosed !== true) {
      const harnessStatus = await readDeepSeekHarnessMaintenanceStatus();
      if (!harnessStatus.enabled || harnessStatus.effectiveMode === "BLOCKED") {
        throw new SpaceFeatureDisabledError("HARNESS_DISABLED", "DeepSeek Harness is disabled. Enable it in Settings to open a Harness pane.");
      }
    }
    // Task metadata is server-owned. Manual naming remains available while a CLI is offline.
    const { taskMetadata: _ignoredMetadata, ...editable } = input;
    const update = () => store.updatePane(params.id,
      typeof editable.title === "string" ? {...editable,titleSource:"manual"} : editable,
      request.requestIdForSpace);
    let pane: Pane;
    if (input.isClosed === false && existingPane.isClosed && (targetMode === "TERMINAL" || targetMode === "JOB_APPLY")) {
      const reopened = cliPaneReopener.reopen(params.id, update, request.requestIdForSpace);
      pane = await reopened.pane;
      if (await reopened.resumed) pane = await store.getPane(pane.id);
    } else {
      pane = await update();
    }
    if (typeof editable.title === "string" || editable.titleSource === "auto") {
      await taskTitles.requestSync(pane.id,editable.titleSource==="auto");
    }
    await recordAudit(store, request, {
      action: "pane.update",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, status: pane.status, isClosed: pane.isClosed }
    });
    const latestEvent = await getLatestRoomEvent(store, pane.roomId);
    if (latestEvent) {
      eventBus.publish(latestEvent);
    }
    return pane;
  });
  app.post("/api/panes/:id/move", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(movePaneInputSchema, request.body);
    // The source room is checked by the central pane-route hook; the target room needs its own check.
    await assertRoomAccess(input.targetRoomId, request.user);
    const move = await store.movePane(params.id, input, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "pane.move",
      targetType: "pane",
      targetId: move.targetPane.id,
      metadata: {
        sourcePaneId: move.sourcePane.id,
        sourceRoomId: move.sourceRoomId,
        targetPaneId: move.targetPane.id,
        targetRoomId: move.targetRoomId,
        mode: move.targetPane.mode
      }
    });
    const [sourceEvent, targetEvent] = await Promise.all([
      getLatestRoomEvent(store, move.sourceRoomId),
      getLatestRoomEvent(store, move.targetRoomId)
    ]);
    for (const event of [sourceEvent, targetEvent]) {
      if (event) {
        eventBus.publish(event);
      }
    }
    return move;
  });
  app.post("/api/panes/:id/title/generate", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    if (!["CHAT", "TERMINAL", "HARNESS"].includes(pane.mode)) throw new SpaceConflictError("Task titles require an AI task pane.");
    return taskTitles.observe(pane.id, true);
  });
  app.get("/api/settings/task-titles", defaultRouteRateLimitOptions, async () => taskTitleRepository.getSettings());
  app.patch("/api/settings/task-titles", defaultRouteRateLimitOptions, async (request, reply) => {
    if(request.user?.role!=="ADMIN")return sendApiError(reply,403,"ADMIN_REQUIRED","Task title settings require the ADMIN role.");
    const settings = parseBody(taskTitleSettingsSchema, request.body);
    const updated = await taskTitleRepository.setSettings(settings);
    await taskTitles.policyChanged();
    void taskTitleProviders.refresh(true).catch(()=>app.log.warn({event:"task_titles.availability_failed"},"Title model availability deferred."));
    return updated;
  });
  app.get("/api/settings/task-titles/availability", defaultRouteRateLimitOptions, async () => ({candidates:await taskTitleProviders.status()}));
  app.patch("/api/panes/:id/title/preference", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const body = parseBody(z.object({candidateId:z.string().min(1).max(320).nullable()}), request.body);
    return taskTitles.setPreference(params.id, body.candidateId);
  });
  app.post("/api/panes/:id/title/harness-session", defaultRouteRateLimitOptions, async(request)=>{
    const params=parseQuery(idParamSchema,request.params);
    const {sessionId}=parseBody(z.object({sessionId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/)}),request.body);
    const pane=await getPaneById(store,params.id);
    if(pane.mode!=="HARNESS"||pane.isClosed)throw new SpaceConflictError("A running Harness pane is required.");
    const bound=await taskTitles.bindHarnessSession(pane.id,sessionId);
    // The session the pane now shows gets its tool tokens at once, not only at the next pane load.
    if(config.harnessEnabled)await publishHarnessAgentTokens({config},{roomId:pane.roomId,paneId:pane.id,boundSessionId:sessionId})
      .catch((err)=>app.log.warn({err,paneId:pane.id},"harness agent tokens were not published for the bound session"));
    return bound;
  });
  app.get("/api/panes/:id/capabilities", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    return buildPaneCapabilityMatrix(store, pane);
  });
  app.delete("/api/panes/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = request.params as { id: string };
    const current = await getPaneById(store, params.id);
    await spaceControl.rememberStop(current);
    let interruptedCliSessionId: string | null = null;
    if (isCliPane(current)) {
      const allSessions = await store.listPaneCliSessions(current.id, 100);
      const runningSessions = allSessions.filter(
        (session) => session.status === "RUNNING"
      );
      for (const session of runningSessions) {
        // The next Job Copilot pane continues this conversation; Claude names it only while it still runs.
        if (current.mode === "JOB_APPLY") await rememberCliNativeRef?.(session).catch(() => undefined);
        try {
          await cliTerminalManager.interrupt(session.sessionId);
        } catch (error) {
          request.log.warn({ err: error, paneId: current.id, sessionId: session.sessionId }, "CLI session interrupt failed during pane close; closing pane anyway");
        }
        if (session.isActive) interruptedCliSessionId = session.sessionId;
      }
      const unendedSessions = allSessions.filter((session) => !session.endedAt && session.status !== "RUNNING");
      const nowIso = new Date().toISOString();
      for (const session of unendedSessions) {
        await Promise.resolve(store.updatePaneCliSession(session.sessionId, {
          endedAt: nowIso,
          isActive: false,
          status: "EXITED",
          statusReason: session.statusReason || "CLI session closed with pane."
        }, request.requestIdForSpace)).catch(() => null);
      }
    }
    if (isBrowserPane(current)) {
      if (current.mode === "YOUTUBE") {
        await youtubeAccountOperations.get(current.id)?.catch(() => undefined);
        await youtubeSessionStarts.get(current.id)?.catch(() => undefined);
      }
      const active = await store.getActivePaneBrowserSession(current.id);
      if (active) {
        try {
          await browserSessionManager.stopPane(current.id, request.requestIdForSpace, operatorBrowserActor(request));
          if (current.mode === "YOUTUBE") {
            const stopped = await store.getLatestPaneBrowserSession(current.id);
            const playback = youtubeBrowserPlayback(stopped?.currentUrl ?? null, stopped?.title ?? null);
            if (playback) {
              const room = await store.getRoom(current.roomId);
              await youtubePlaybackStore.save(room.kind === "AGENT_PROOF" ? `${request.user!.id}:proof:${room.id}` : request.user!.id, current.id, playback);
            }
          }
        } catch (error) {
          if (current.mode === "YOUTUBE") throw error;
          request.log.warn({ err: error, paneId: current.id }, "browser session stop failed during pane close; closing pane anyway");
        }
      }
    }
    if (current.mode === "CHAT") {
      const active = await store.getActiveSpaceAgentSession(current.id);
      if (active && !(await store.hasRunningSpaceAgentRun(active.sessionId))) {
        await store.updateSpaceAgentSession(
          active.sessionId,
          { status: "READY", isActive: false, title: active.title },
          request.requestIdForSpace
        );
      }
    }
    const pane = await store.updatePane(params.id, { isClosed: true, status: "CLOSED" }, request.requestIdForSpace);
    await recordAudit(store, request, {
      action: "pane.close",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, interruptedCliSessionId }
    });
    return pane;
  });
}
