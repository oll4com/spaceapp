import type {} from "./request-context.js";
import { cliInputProofRoomDescriptionPrefix } from "./proof-room-descriptions.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  activeAgentTurnsInputSchema, activeAgentTurnsResponseSchema, type AgentRuntime, cliToggleRuntimeIdSchema,
  createProofRoomInputSchema, isWarmMixedProofProfile, warmMixedProofManifests, idSchema, type Pane, proofRoomCliIdentitySchema, proofRoomSchema
} from "@space/contracts";
import {
  nowIso, SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import type { ActivityLogService } from "./activity-log.js";
import {
  cleanupCliRenderAiRepository, cliRenderAiDescription, type createCliRenderAiController, createCliRenderAiRepository
} from "./cli-render-ai-proof.js";
import {
  cliRenderProofDescription, cliRenderProofRuntimeIds, createCliRenderProofFixture, startCliRenderProofFixture,
  warmCapacityProofDescription, warmMixedProofDescriptions, mixedProofProfileForDescription, mixedProofPanesMatch
} from "./cli-render-proof-fixture.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { type createAgentRuntimeRegistryCache, findRuntime, isCliRuntimeTerminalLaunchable } from "./cli-runtimes.js";
import type { CliHostGateway, CliTerminalManager } from "./cli-terminal.js";
import type { CodexCliModeDefaultsService } from "./codex-cli-mode-defaults.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import type { createDashboardCliProofController } from "./agents-dashboard-proof.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

const proofRoomPaneParamSchema = z
  .object({
    roomId: idSchema,
    paneId: idSchema
  })
  .strict();

const activeAgentStressModelId = "gpt-5.4-mini";

const activeAgentStressReasoningEffort = "low";

const activeAgentStressRoomDescription =
  "Internal auxiliary AGENT_PROOF room for active-agent stress. [ACTIVE_AGENT_STRESS:v1]";

export { cliInputProofRoomDescriptionPrefix };

const activeAgentStressPrompts = [
  "Write the opening paragraph of a harmless fictional story about a lighthouse keeper cataloging constellations. Return only the story paragraph.",
  "Continue the same harmless fictional story by introducing a small mechanical seabird that delivers a weather note. Return only the next paragraph.",
  "Continue the same harmless fictional story with the keeper and seabird solving a gentle navigation puzzle before dawn. Return only the next paragraph.",
  "Conclude the same harmless fictional story at sunrise with the lighthouse log safely completed. Return only the final paragraph."
] as const;

/**
 * Agent Proof rooms: creation, CLI render fixtures and AI proof, CLI identity and active-agent turns; the parent
 * retains authentication, CSRF, errors and rate limits.
 */
export function registerProofRoomRoutes(app: FastifyInstance, deps: {
  options: { cliHostClient?: CliHostGateway };
  config: SpaceApiConfig;
  store: SpaceStore;
  activityLogService: ActivityLogService;
  eventBus: SpaceEventBus;
  codexCliModeDefaultsService: CodexCliModeDefaultsService;
  cliRuntimeRegistryCache: ReturnType<typeof createAgentRuntimeRegistryCache>;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  cliRenderAi: ReturnType<typeof createCliRenderAiController>;
  dashboardCliProof: ReturnType<typeof createDashboardCliProofController>;
}) {
  const { options, config, store, activityLogService, eventBus, codexCliModeDefaultsService, cliRuntimeRegistryCache,
    cliTerminalManager, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions, cliRenderAi, dashboardCliProof } = deps;
  const assertActiveAgentStressModelAdvertised = async () => {
    const catalog = (await codexCliModeDefaultsService.read()).catalog;
    const model = catalog.status === "AVAILABLE"
      ? catalog.models.find((candidate) => candidate.id === activeAgentStressModelId)
      : null;
    if (!model?.supportedReasoningEfforts.includes(activeAgentStressReasoningEffort)) {
      throw new SpaceFeatureDisabledError(
        "ACTIVE_AGENT_STRESS_MODEL_UNAVAILABLE",
        "Active-agent stress requires the advertised gpt-5.4-mini model with low reasoning."
      );
    }
  };
  const readProofRoom = async (roomId: string) => {
    const room = await store.getRoom(roomId);
    if (room.kind !== "AGENT_PROOF") {
      throw new SpaceNotFoundError(`Proof room ${roomId} was not found.`);
    }
    const panes = await store.listPanes(room.id);
    const sessions = await Promise.all(panes.map((pane) => store.getActivePaneCliSession(pane.id)));
    const cliInputRuntimeCandidate = room.description?.startsWith(cliInputProofRoomDescriptionPrefix) &&
      room.description.endsWith("]")
      ? cliToggleRuntimeIdSchema.safeParse(
          room.description.slice(cliInputProofRoomDescriptionPrefix.length, -1)
        )
      : null;
    const cliInputRuntimeId = cliInputRuntimeCandidate?.success
      ? cliInputRuntimeCandidate.data
      : undefined;
    const mixedProfile = mixedProofProfileForDescription(room.description);
    if (mixedProfile && config.instance !== "dev") throw new SpaceNotFoundError("Mixed fixtures are dev only.");
    const profile = mixedProfile ?? (room.description === warmCapacityProofDescription
      ? "WARM_CAPACITY" as const
      : room.description === cliRenderAiDescription
      ? "CLI_RENDER_AI" as const
      : room.description === cliRenderProofDescription
      ? "CLI_RENDER" as const
      : room.description === activeAgentStressRoomDescription
      ? "ACTIVE_AGENT_STRESS" as const
      : cliInputRuntimeId
        ? "CLI_INPUT" as const
        : "STANDARD" as const);
    const renderRuntime = profile === "CLI_RENDER"
      ? panes.length === 3 && panes.every((pane,index)=>pane.terminalRuntimeId===cliRenderProofRuntimeIds[index])
        ? "ALL" as const
        : panes[0]?.terminalRuntimeId === "cli:gemini"
          ? "GEMINI" as const
          : panes[0]?.terminalRuntimeId === "cli:opencode"
            ? "OPENCODE" as const
            : "CODEX" as const
      : undefined;
    return proofRoomSchema.parse({
      ...(profile === "STANDARD"
        ? {}
        : {
            profile,
            ...(cliInputRuntimeId ? { runtimeId: cliInputRuntimeId } : {}),
            ...(renderRuntime ? { renderRuntime } : {})
          }),
      room,
      panes,
      sessionIds: sessions.flatMap((session) => session ? [session.sessionId] : [])
    });
  };
  app.post("/api/proof-rooms", { config: { rateLimit: { max: 16, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const input = parseBody(createProofRoomInputSchema, request.body);
    const profile = input.profile ?? "STANDARD";
    const mixedProfile = isWarmMixedProofProfile(profile) ? profile : null;
    if (mixedProfile && (config.instance !== "dev" || request.user?.role !== "ADMIN" || request.user.proofScope === "READ_ONLY")) {
      return sendApiError(reply,403,"ADMIN_REQUIRED","Mixed fixtures require dev and full ADMIN capability.");
    }
    if (profile === "ACTIVE_AGENT_STRESS" || profile === "CLI_INPUT" || profile === "CLI_RENDER" || profile === "CLI_RENDER_AI" || profile === "WARM_CAPACITY") {
      if (request.user?.role !== "ADMIN" || (["CLI_RENDER","CLI_RENDER_AI","WARM_CAPACITY"].includes(profile)&&request.user.proofScope==="READ_ONLY")) {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Specialized proof rooms require the full ADMIN capability.");
      }
    }
    if (profile === "ACTIVE_AGENT_STRESS") {
      await assertActiveAgentStressModelAdvertised();
    }
    let cliInputRuntime: AgentRuntime | null = null;
    if (profile === "CLI_INPUT") {
      await cliRuntimeVisibility.assertEnabled(input.runtimeId!);
      const registry = await cliRuntimeRegistryCache.read();
      cliInputRuntime = findRuntime(registry, input.runtimeId!);
      if (
        !cliInputRuntime ||
        !cliInputRuntime.capabilities.includes("CLI") ||
        !isCliRuntimeTerminalLaunchable(cliInputRuntime)
      ) {
        throw new SpaceFeatureDisabledError(
          "CLI_RUNTIME_DISABLED",
          cliInputRuntime?.statusReason ?? `CLI runtime ${input.runtimeId} is unavailable.`,
          { runtimeId: input.runtimeId }
        );
      }
    }
    const renderRuntimeIds = profile === "CLI_RENDER"
      ? input.renderRuntime === "ALL"
        ? [...cliRenderProofRuntimeIds]
        : [`cli:${(input.renderRuntime ?? "CODEX").toLowerCase()}`]
      : [];
    const roomName = mixedProfile ? `Agent Proof · Mixed switch ${mixedProfile.slice(-1)}` : input.roomLabel
      ? `Agent Proof · ${input.roomLabel}`
      : `Agent Proof · ${nowIso().slice(0, 19).replace("T", " ")}`;
    const room = await store.createRoom(
      {
        name: roomName,
        description: mixedProfile ? warmMixedProofDescriptions[mixedProfile] : profile === "WARM_CAPACITY" ? warmCapacityProofDescription : profile === "CLI_RENDER_AI" ? cliRenderAiDescription : profile === "CLI_RENDER" ? cliRenderProofDescription : profile === "ACTIVE_AGENT_STRESS"
          ? activeAgentStressRoomDescription
          : profile === "CLI_INPUT"
            ? `${cliInputProofRoomDescriptionPrefix}${input.runtimeId}]`
            : "Persistent isolated room for agent UI proof and debugging.",
        // Proof rooms never inherit the /opt/spaceapp room default (eda97abab6):
        // their /etc panes would otherwise start CLI sessions in the live checkout.
        projectPath: "/etc",
        initialPaneCount: 0,
        kind: "AGENT_PROOF"
      },
      request.requestIdForSpace,
      (profile === "STANDARD" || profile === "CLI_RENDER") && request.user ? (await store.upsertUser(request.user)).id : undefined
    );
    await activityLogService.recordRoomCreate({
      roomId: room.id,
      actorUserId: request.user?.id ?? null,
      traceId: request.requestIdForSpace,
      metadata: { roomName: room.name, profile: input.profile ?? "STANDARD" }
    });
    let panes: Pane[] = [];
    let creationComplete = false;
    const cleanupAbortedMixed = async () => {
      const currentPanes = await store.listPanes(room.id);
      if (currentPanes.length !== panes.length || currentPanes.some((pane,index)=>pane.id!==panes[index]?.id)) {
        throw new SpaceConflictError("Mixed creation cleanup identity changed; room retained.");
      }
      const sessions = await Promise.all(panes.map(pane=>store.getActivePaneCliSession(pane.id)));
      const stopped = await Promise.allSettled(sessions.map(session=>session?cliTerminalManager.detachSession(session):undefined));
      if (stopped.some(result=>result.status==="rejected")) throw new SpaceConflictError("Mixed creation process cleanup failed; room retained.");
      const stopDeadline = Date.now()+5000;
      while (true) {
        const hosts = await Promise.all(sessions.map(session=>session?cliTerminalManager.inspectSessionHost(session):null));
        if (hosts.every(session=>session?.status!=="RUNNING")) break;
        if (Date.now()>=stopDeadline) throw new SpaceConflictError("Mixed creation process still running; room retained.");
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      await store.deleteRoom(room.id);
    };
    // New-profile-only: do not strand resources if the response connection dies.
    let abortCleanup: Promise<void> | null = null;
    let responseFinished = false;
    const onResponseClose = () => {
      if (mixedProfile && !responseFinished && creationComplete) {
        abortCleanup ??= cleanupAbortedMixed();
        void abortCleanup.catch(() => { request.log.error({roomId:room.id},"Mixed response-close cleanup incomplete; owned room retained for recovery."); });
      }
    };
    if (mixedProfile) {
      reply.raw.once("finish",()=>{responseFinished=true;});
      reply.raw.once("close",onResponseClose);
    }
    try {
      const aiCwd=profile === "CLI_RENDER_AI" ? await createCliRenderAiRepository(config.browserEvidenceArtifactRoot,room.id) : null;
      if (profile === "CLI_RENDER") {
        for (const runtimeId of renderRuntimeIds) await cliRuntimeVisibility.assertEnabled(runtimeId);
      } else if (input.paneCount > 0) await cliRuntimeVisibility.assertEnabled("cli:codex");
      panes = await store.createPanes(
        mixedProfile ? warmMixedProofManifests[mixedProfile].map((mode) => ({
          roomId:room.id, title:`Mixed ${mixedProfile.slice(-1)}`, mode,
          terminalRuntimeId:mode === "BROWSER" ? null : "cli:codex",
          cwd:mode === "BROWSER" ? null : "/tmp"
        })) : Array.from({ length: input.paneCount }, (_,index) => ({
          roomId: room.id,
          title: profile === "WARM_CAPACITY" ? `Warm capacity ${index + 1}` : profile === "CLI_RENDER" ? `${renderRuntimeIds[index]!.slice(4)} synthetic render fixture` : cliInputRuntime?.displayName ?? "Codex CLI",
          mode: "TERMINAL" as const,
          terminalRuntimeId: profile === "CLI_RENDER" ? renderRuntimeIds[index]! : cliInputRuntime?.id ?? "cli:codex",
          ...(profile === "ACTIVE_AGENT_STRESS" ? { modelId: activeAgentStressModelId } : {}),
          cwd: aiCwd ?? (["CLI_RENDER", "WARM_CAPACITY"].includes(profile) ? "/tmp" : "/etc")
        })),
        request.requestIdForSpace
      );
      if (profile === "ACTIVE_AGENT_STRESS") {
        panes = await Promise.all(
          panes.map((pane) =>
            store.updatePane(
              pane.id,
              { modelId: activeAgentStressModelId, reasoningEffort: activeAgentStressReasoningEffort },
              request.requestIdForSpace
            )
          )
        );
      }
      const sessionSetup = mixedProfile
        ? await Promise.allSettled(panes.filter(pane=>pane.mode!=="BROWSER").map(pane=>createCliRenderProofFixture(store,pane,request.requestIdForSpace,config.cliHostSocketPath,options.cliHostClient)))
        : profile === "CLI_RENDER" || profile === "WARM_CAPACITY"
        ? await Promise.allSettled(panes.map(pane=>createCliRenderProofFixture(store,pane,request.requestIdForSpace,config.cliHostSocketPath,options.cliHostClient)))
        : profile === "CLI_INPUT"
        ? []
        : await Promise.allSettled(
            panes.map((pane) =>
              cliTerminalManager.ensurePaneTransportReady(
                pane,
                request.requestIdForSpace,
                profile === "ACTIVE_AGENT_STRESS"
                  ? { modelId: activeAgentStressModelId, reasoningEffort: activeAgentStressReasoningEffort }
                  : {}
              )
            )
          );
      const failedSession = sessionSetup.find((result) => result.status === "rejected");
      if (failedSession?.status === "rejected") throw failedSession.reason;

      const paneIds = new Set(panes.map((pane) => pane.id));
      const createdEvents = (await store.listEvents(room.id)).filter(
        (event) => event.type === "ROOM_CREATED" || (event.type === "PANE_CREATED" && event.paneId && paneIds.has(event.paneId))
      );
      for (const event of createdEvents) eventBus.publish(event);

      const proofRoom = await readProofRoom(room.id);
      await recordAudit(store, request, {
        action: "proof-room.create",
        targetType: "room",
        targetId: room.id,
        metadata: {
          name: room.name,
          profile,
          runtimeId: input.runtimeId ?? null,
          renderRuntime: input.renderRuntime ?? (profile === "CLI_RENDER" ? "CODEX" : null),
          paneCount: panes.length,
          sessionCount: proofRoom.sessionIds.length
        }
      });
      creationComplete = true;
      if (mixedProfile && (request.raw.aborted || reply.raw.destroyed)) {
        abortCleanup ??= cleanupAbortedMixed();
        await abortCleanup;
        throw new SpaceConflictError("Mixed fixture request aborted before handoff.");
      }
      return reply.code(201).send(proofRoom);
    } catch (error) {
      if (mixedProfile) {
        try { abortCleanup ??= cleanupAbortedMixed(); await abortCleanup; }
        catch { request.log.error({roomId:room.id},"Mixed fixture cleanup incomplete; owned room retained for recovery."); }
        throw error;
      }
      await Promise.allSettled(
        panes.map(async (pane) => {
          const session = await store.getActivePaneCliSession(pane.id);
          if (session) await cliTerminalManager.interrupt(session.sessionId);
        })
      );
      try {
        await store.deleteRoom(room.id);
        if(profile === "CLI_RENDER_AI")await cleanupCliRenderAiRepository(config.browserEvidenceArtifactRoot,room.id);
      } catch {
        // Preserve the setup failure while cleanup remains scoped to this newly-created proof room.
      }
      throw error;
    }
  });
  app.post("/api/proof-rooms/:id/cli-render/cleanup",defaultRouteRateLimitOptions,async(request,reply)=>{
    if(request.user?.role!=="ADMIN"||request.user.proofScope==="READ_ONLY")return sendApiError(reply,403,"ADMIN_REQUIRED","Render cleanup requires the full protected capability.");
    parseBody(z.object({}).strict(),request.body??{});const params=parseQuery(idParamSchema,request.params);
    const room=await store.getRoom(params.id);
    const mixedProfile = mixedProofProfileForDescription(room.description);
    if (mixedProfile && config.instance !== "dev") throw new SpaceNotFoundError("Mixed fixtures are dev only.");
    if(room.kind!=="AGENT_PROOF"||(!mixedProfile && ![cliRenderProofDescription,cliRenderAiDescription,warmCapacityProofDescription].includes(room.description??"")))throw new SpaceConflictError("Render cleanup is outside the owned fixture scope.");
    const panes=await store.listPanes(room.id);if(mixedProfile ? !mixedProofPanesMatch(mixedProfile,room.id,panes) : room.description===warmCapacityProofDescription ? panes.length!==16 : ![1,3].includes(panes.length))throw new SpaceConflictError("Render fixture pane set changed.");
    const sessions=await Promise.all(panes.map(pane=>store.getActivePaneCliSession(pane.id)));
    await Promise.all(sessions.map(session=>session?cliTerminalManager.detachSession(session):undefined));
    // Termination acknowledges the signal before the PTY exit event arrives.
    const stopDeadline = Date.now() + 5000;
    let running = true;
    while (running) {
      const remaining = await Promise.all(sessions.map(session => session ? cliTerminalManager.inspectSessionHost(session) : null));
      running = remaining.some(session => session?.status === "RUNNING");
      if (!running || Date.now() >= stopDeadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (running) throw new SpaceConflictError("An owned render process is still running.");
    cliRenderAi.dispose(room.id);
    if(room.description===cliRenderAiDescription)await cleanupCliRenderAiRepository(config.browserEvidenceArtifactRoot,room.id);
    return {ok:true,roomId:room.id,sessionIds:sessions.flatMap(session=>session?[session.sessionId]:[]),ownedProcessStopped:true};
  });
  app.post("/api/proof-rooms/:id/cli-render/ai-start",defaultRouteRateLimitOptions,async(request,reply)=>{
    if(request.user?.role!=="ADMIN"||request.user.proofScope==="READ_ONLY")return sendApiError(reply,403,"ADMIN_REQUIRED","AI render proof requires the full protected capability.");
    parseBody(z.object({}).strict(),request.body??{});const params=parseQuery(idParamSchema,request.params);
    return cliRenderAi.start(params.id,request.requestIdForSpace);
  });
  app.get("/api/proof-rooms/:id/cli-render/ai-state",defaultRouteRateLimitOptions,async(request,reply)=>{
    if(request.user?.role!=="ADMIN"||request.user.proofScope==="READ_ONLY")return sendApiError(reply,403,"ADMIN_REQUIRED","AI render proof requires the full protected capability.");
    const params=parseQuery(idParamSchema,request.params);return cliRenderAi.state(params.id);
  });
  // Agents Dashboard status proof: fixed tasks in an owned single-pane CLI input proof room, never operator rooms.
  app.post("/api/proof-rooms/:id/dashboard-cli/start", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN" || request.user.proofScope === "READ_ONLY") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Dashboard CLI proof requires the full protected capability.");
    const input = parseBody(z.object({ task: z.enum(["STREAM", "SHELL"]) }).strict(), request.body ?? {});
    const params = parseQuery(idParamSchema, request.params);
    return dashboardCliProof.start(params.id, input.task, request.requestIdForSpace);
  });
  app.post("/api/proof-rooms/:id/dashboard-cli/interrupt", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN" || request.user.proofScope === "READ_ONLY") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Dashboard CLI proof requires the full protected capability.");
    parseBody(z.object({}).strict(), request.body ?? {});
    const params = parseQuery(idParamSchema, request.params);
    return dashboardCliProof.interrupt(params.id, request.requestIdForSpace);
  });
  app.get("/api/proof-rooms/:id/dashboard-cli/screen", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN" || request.user.proofScope === "READ_ONLY") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Dashboard CLI proof requires the full protected capability.");
    const params = parseQuery(idParamSchema, request.params);
    return dashboardCliProof.screen(params.id);
  });
  app.post("/api/proof-rooms/:id/cli-render/start", defaultRouteRateLimitOptions, async(request,reply)=>{
    if(request.user?.role!=="ADMIN"||request.user.proofScope==="READ_ONLY")return sendApiError(reply,403,"ADMIN_REQUIRED","Render proof requires the full authenticated proof capability.");
    const input=parseBody(z.object({mode:z.literal("COMPOSER").optional()}).strict(),request.body??{});
    const params=parseQuery(idParamSchema,request.params);
    return startCliRenderProofFixture(store,params.id,config.cliHostSocketPath,options.cliHostClient,input.mode);
  });
  app.get("/api/proof-rooms/:id", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const room = await store.getRoom(params.id);
    if (mixedProofProfileForDescription(room.description) && (config.instance !== "dev" || request.user?.role !== "ADMIN" || request.user.proofScope === "READ_ONLY")) throw new SpaceNotFoundError("Mixed fixtures require dev and full ADMIN capability.");
    return readProofRoom(params.id);
  });
  app.get(
    "/api/proof-rooms/:roomId/panes/:paneId/cli-identity",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(
          reply,
          403,
          "ADMIN_REQUIRED",
          "CLI input proof identity requires the ADMIN role."
        );
      }
      const params = parseQuery(proofRoomPaneParamSchema, request.params);
      const proofRoom = await readProofRoom(params.roomId);
      const pane = proofRoom.panes.find((candidate) => candidate.id === params.paneId);
      if (
        proofRoom.profile !== "CLI_INPUT" ||
        !proofRoom.runtimeId ||
        !pane ||
        pane.roomId !== params.roomId ||
        pane.mode !== "TERMINAL" ||
        pane.terminalRuntimeId !== proofRoom.runtimeId
      ) {
        throw new SpaceNotFoundError(
          `CLI input proof pane ${params.paneId} was not found.`
        );
      }

      const session = await store.getActivePaneCliSession(pane.id);
      if (
        !session ||
        session.roomId !== params.roomId ||
        session.paneId !== params.paneId ||
        session.runtimeId !== proofRoom.runtimeId ||
        session.purpose !== "NORMAL" ||
        session.status !== "RUNNING" ||
        session.isActive !== true
      ) {
        throw new SpaceConflictError("CLI input proof pane has no matching active session.");
      }
      const hostSession = await cliTerminalManager.inspectSessionHost(session);
      if (
        !hostSession ||
        hostSession.cliSessionId !== session.sessionId ||
        hostSession.roomId !== session.roomId ||
        hostSession.paneId !== session.paneId ||
        hostSession.runtimeId !== session.runtimeId ||
        hostSession.status !== "RUNNING"
      ) {
        throw new SpaceConflictError("CLI input proof host identity is unavailable.");
      }

      reply.header("cache-control", "no-store");
      return proofRoomCliIdentitySchema.parse({
        sessionId: hostSession.cliSessionId,
        pid: hostSession.pid,
        generationId: hostSession.generationId,
        sampledAt: nowIso()
      });
    }
  );
  app.post(
    "/api/proof-rooms/:id/active-agent-turns",
    { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Active-agent stress turns require the ADMIN role.");
      }
      const params = parseQuery(idParamSchema, request.params);
      const input = parseBody(activeAgentTurnsInputSchema, request.body);
      const room = await store.getRoom(params.id);
      if (room.kind !== "AGENT_PROOF" || room.description !== activeAgentStressRoomDescription) {
        throw new SpaceNotFoundError(`Active-agent stress proof room ${params.id} was not found.`);
      }
      await assertActiveAgentStressModelAdvertised();

      const panes = await store.listPanes(room.id);
      const requestedPaneIds = new Set(input.paneIds);
      if (
        panes.length !== input.paneIds.length ||
        panes.some((pane) =>
          !requestedPaneIds.has(pane.id) ||
          pane.mode !== "TERMINAL" ||
          pane.terminalRuntimeId !== "cli:codex" ||
          pane.modelId !== activeAgentStressModelId ||
          pane.reasoningEffort !== activeAgentStressReasoningEffort
        )
      ) {
        throw new SpaceConflictError("Active-agent stress turns must target the exact mini/low pane set.");
      }

      const sessions = await Promise.all(
        panes.map(async (pane) => {
          const session = await store.getActivePaneCliSession(pane.id);
          if (!session) throw new SpaceConflictError(`Active-agent stress pane ${pane.id} has no active CLI session.`);
          return { pane, session };
        })
      );
      const prompt = activeAgentStressPrompts[input.cycle]!;
      await Promise.all(
        sessions.map(async ({ pane, session }) => {
          const idempotencyPrefix = `active-agent-stress:${room.id}:${pane.id}:${input.cycle}`;
          await cliTerminalManager.sendInput(
            session.sessionId,
            prompt,
            request.requestIdForSpace,
            null,
            `${idempotencyPrefix}:content`
          );
          await cliTerminalManager.sendInput(
            session.sessionId,
            "\r",
            request.requestIdForSpace,
            null,
            `${idempotencyPrefix}:submit`
          );
        })
      );
      await recordAudit(store, request, {
        action: "proof-room.active-agent-turns",
        targetType: "room",
        targetId: room.id,
        metadata: { cycle: input.cycle, paneCount: panes.length }
      });
      return activeAgentTurnsResponseSchema.parse({
        roomId: room.id,
        paneIds: panes.map((pane) => pane.id),
        cycle: input.cycle,
        acceptedCount: panes.length
      });
    }
  );
}
