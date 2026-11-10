import type { Pane } from "@space/contracts";
import { PostgresConnectorAccountsRepository, PostgresDotDelegationsRepository, PostgresDotDeliverablesRepository, PostgresDotSchedulesRepository, type AutoRouteShadowRepository, type PostgresDotGoalsRepository, type PostgresDotsRepository } from "@space/db";
import { SpaceConflictError, makeSpaceId, redactMemoryText, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { cookieName, verifySession, type AuthConfig } from "./auth.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { safeBrowserObservationUrl } from "./browser-observation.js";
import { agentFileMaxBytes, persistAgentFile, type AgentFileDocxNormalizer } from "./cli-agent-files.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import { registerDotAutoRoutingShadowRoutes } from "./dot-auto-routing-routes.js";
import { createDotComputerService } from "./dot-computer.js";
import { createConnectorService, createGoogleConnector, createMicrosoftConnector, registerConnectorRoutes, type ConnectorCrypto, type ConnectorOAuthStateTools } from "./dot-connectors.js";
import { createDotDelegationService } from "./dot-delegations.js";
import { createDotDeliverablesService, registerDotDeliverableRoutes } from "./dot-deliverables.js";
import type { createDotGoalService } from "./dot-goals.js";
import { registerDotMemoryRoutes } from "./dot-memory.js";
import { createDotScheduleService, registerDotScheduleRoutes } from "./dot-schedules.js";
import { assertBrowserPaneCompatible, getPaneById } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import { GitControlError } from "./source-control/errors.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import { privatePaneProfileId, type YouTubeAccountStore } from "./youtube-accounts.js";

type DotServicesWiringDeps = {
  store: SpaceStore;
  config: SpaceApiConfig;
  options: { agentFileDocxNormalizer?: AgentFileDocxNormalizer; autoRouteShadowRepository?: AutoRouteShadowRepository };
  auth: Pick<AuthConfig, "sessionSecret" | "googleClientId" | "googleClientSecret">;
  eventBus: Pick<SpaceEventBus, "publish">;
  defaultRouteRateLimitOptions: RouteShorthandOptions;
  dotsAuthenticatedOwner: (request: FastifyRequest) => Promise<string>;
  dotsRepository: PostgresDotsRepository | null;
  dotGoalsRepository: PostgresDotGoalsRepository | null;
  dotGoalService: ReturnType<typeof createDotGoalService> | null;
  dotMemoryService: Parameters<typeof registerDotMemoryRoutes>[1];
  dotAtCapacity: (input: { sessionId: string; dotId: string; roomId: string }) => Promise<boolean>;
  autoRouteFactsLoader: Parameters<typeof registerDotAutoRoutingShadowRoutes>[1]["autoRouteFactsLoader"];
  browserSessionManager: Pick<BrowserSessionManagerWithHostHealth, "startOrRestore" | "navigate" | "getActive">;
  browserAccountStore: Pick<YouTubeAccountStore, "save">;
  youtubeAccountOwner: (owner: string, pane: Pane) => Promise<string>;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "assertEnabled">;
  connectorCrypto: ConnectorCrypto;
  connectorServiceRef: { current: ReturnType<typeof createConnectorService> | null };
  connectorStateTools: ConnectorOAuthStateTools;
  roomPaneCommands: Pick<ReturnType<typeof createRoomPaneCommands>, "resolve">;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "sendMessage" | "interrupt" | "createOrRestoreSession">;
};

/**
 * The Dot services (moved verbatim from app.ts, ARCH-001 step 72): schedules with their routes, the Dot computer (its own browser
 * pane, Goal pause, interrupts), deliverables published as Agent Files, the Google and Microsoft connectors (whose service the
 * sign-in callback reaches through `connectorServiceRef`), the deliverable, memory and auto-routing shadow routes, and delegations.
 * Each store's close is registered with its service. Returns the services the Dot channels, Live and tool gateway read.
 */
export function registerDotServices(app: FastifyInstance, deps: DotServicesWiringDeps) {
  const { store, config, options, auth, eventBus, defaultRouteRateLimitOptions, dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotGoalService,
    dotMemoryService, dotAtCapacity, autoRouteFactsLoader, browserSessionManager, browserAccountStore, youtubeAccountOwner, cliRuntimeVisibility, connectorCrypto,
    connectorServiceRef, connectorStateTools, roomPaneCommands, spaceAgentAdapter } = deps;
  const dotSchedulesRepository = dotsRepository && config.databaseUrl ? PostgresDotSchedulesRepository.fromConnectionString(config.databaseUrl) : null;
  if (dotSchedulesRepository) app.addHook("onClose", () => dotSchedulesRepository.dispose());
  const dotScheduleService = dotsRepository && dotSchedulesRepository ? createDotScheduleService({
    store, dots: dotsRepository, schedules: dotSchedulesRepository,
    activeSessionId: async (paneId) => (await store.getActiveSpaceAgentSession(paneId))?.sessionId ?? null,
    atCapacity: dotAtCapacity,
    send: async ({ paneId, sessionId, ownerUserId, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane: await getPaneById(store, paneId), sessionId, content, operatorUserId: ownerUserId,
        clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    }
  }) : null;
  registerDotScheduleRoutes(app, dotScheduleService, dotSchedulesRepository, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  const dotBrowserActor = (agentSessionId: string) => ({ holderType: "AGENT" as const, holderId: agentSessionId });
  const dotComputerService = dotsRepository ? createDotComputerService({
    dots: dotsRepository, goals: dotGoalsRepository, workspaceRoot: config.dotWorkspaceRoot,
    pauseGoal: async (owner, dotId, goalId, request) => {
      if (!dotGoalService) return false;
      await dotGoalService.control(owner, dotId, goalId, { action: "PAUSE" }, request);
      return true;
    },
    interrupt: async (run, reason) => {
      const pane = await getPaneById(store, run.paneId);
      // Only the conversation the pane is showing can be interrupted through it.
      if ((await store.getActiveSpaceAgentSession(pane.id))?.sessionId !== run.sessionId) return false;
      await spaceAgentAdapter.interrupt({ pane, reason });
      return true;
    },
    browserState: async (paneId) => {
      const session = await store.getActivePaneBrowserSession(paneId);
      return { active: Boolean(session?.isActive), currentUrl: session ? safeBrowserObservationUrl(session.currentUrl) : null,
        title: session?.title ? redactMemoryText(session.title).slice(0, 500) : null,
        sessionId: session?.isActive ? session.sessionId : null, ready: Boolean(session?.isActive && session.runtimeState === "READY") };
    },
    ...(config.browserSessionsEnabled && config.browserToolBridgeEnabled ? {
      createBrowserPane: async ({ owner, dotName, roomId }: { owner: string; dotId: string; dotName: string; roomId: string }) => {
        const traceId = makeSpaceId("trace");
        const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "BROWSER" }]);
        const [pane] = await store.createPanes([{ ...input!, title: `${dotName} browser`.slice(0, 120) }], traceId);
        // Its own profile: never the owner's Google sign-in.
        await browserAccountStore.save(await youtubeAccountOwner(owner, pane!), pane!.id, privatePaneProfileId);
        for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
        return pane!.id;
      },
      closePane: async (paneId: string) => {
        // A browser pane that lost a creation race never started a browser.
        await store.updatePane(paneId, { isClosed: true, status: "CLOSED" }, makeSpaceId("trace"));
      },
      openBrowser: async (paneId: string, url: string | null, holder: { agentSessionId: string; roomId: string }) => {
        const pane = await getPaneById(store, paneId);
        assertBrowserPaneCompatible(pane);
        if (pane.isClosed || pane.roomId !== holder.roomId) throw new SpaceConflictError("The Dot's browser is no longer in this room. Call computer.browser again.");
        const traceId = makeSpaceId("trace");
        const active = await store.getActivePaneBrowserSession(pane.id);
        const response = !active ? await browserSessionManager.startOrRestore({ pane, targetUrl: url, profileKey: null, traceId }, dotBrowserActor(holder.agentSessionId))
          : url ? await browserSessionManager.navigate(pane, url, traceId, dotBrowserActor(holder.agentSessionId))
          : await browserSessionManager.getActive(pane);
        const session = response?.session ?? active!;
        return { sessionId: session.sessionId, active: true, currentUrl: safeBrowserObservationUrl(session.currentUrl),
          title: session.title ? redactMemoryText(session.title).slice(0, 500) : null };
      }
    } : {}),
    audit: (request, action, roomId, metadata) => request ? recordAudit(store, request, { action, targetType: "room", targetId: roomId, metadata })
      : Promise.resolve(store.recordAuditEvent({ actorUserId: null, traceId: makeSpaceId("trace"), action, targetType: "room", targetId: roomId, metadata }))
        .then(() => undefined).catch(() => undefined)
  }) : null;
  const dotDeliverablesRepository = dotsRepository && config.databaseUrl ? PostgresDotDeliverablesRepository.fromConnectionString(config.databaseUrl) : null;
  if (dotDeliverablesRepository) app.addHook("onClose", () => dotDeliverablesRepository.dispose());
  const dotDeliverablesService = dotsRepository && dotDeliverablesRepository ? createDotDeliverablesService({
    store, dots: dotsRepository, deliverables: dotDeliverablesRepository, workspaceRoot: config.dotWorkspaceRoot, maxBytes: agentFileMaxBytes,
    publishArtifact: async ({ roomId, dotName, filename, mimeType, buffer }) => {
      const record = await persistAgentFile({ store, artifactRoot: config.browserEvidenceArtifactRoot, roomId, paneId: null, cliSessionId: null,
        runtimeId: "dot", originalFilename: filename, declaredMimeType: mimeType, buffer, traceId: makeSpaceId("trace"),
        folder: `Dots/${dotName}`.slice(0, 120), docxNormalizer: options.agentFileDocxNormalizer });
      eventBus.publish(record.event);
      return record.artifact;
    },
    audit: async (request, action, metadata) => {
      if (request) await recordAudit(store, request, { action, targetType: "dot", targetId: String(metadata.dotId ?? ""), metadata });
      else await Promise.resolve(store.recordAuditEvent({ actorUserId: null, traceId: makeSpaceId("trace"), action, targetType: "dot",
        targetId: String(metadata.dotId ?? ""), metadata })).catch(() => undefined);
    }
  }) : null;
  const connectorAccountsRepository = dotsRepository && config.databaseUrl ? PostgresConnectorAccountsRepository.fromConnectionString(config.databaseUrl) : null;
  if (connectorAccountsRepository) app.addHook("onClose", () => connectorAccountsRepository.dispose());
  const microsoftConnectorConfigured = Boolean(process.env.SPACE_MICROSOFT_CLIENT_ID && process.env.SPACE_MICROSOFT_CLIENT_SECRET);
  const connectorService = connectorAccountsRepository ? createConnectorService({
    accounts: connectorAccountsRepository,
    crypto: connectorCrypto,
    google: auth.googleClientId ? createGoogleConnector({ clientId: auth.googleClientId, clientSecret: auth.googleClientSecret }) : null,
    microsoft: microsoftConnectorConfigured ? createMicrosoftConnector({ clientId: process.env.SPACE_MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.SPACE_MICROSOFT_CLIENT_SECRET!, tenant: process.env.SPACE_MICROSOFT_TENANT || "common" }) : null,
    microsoftReason: "Microsoft needs an app registration on this server (SPACE_MICROSOFT_CLIENT_ID and SPACE_MICROSOFT_CLIENT_SECRET).",
    audit: async (request, action, metadata) => {
      if (request) await recordAudit(store, request, { action, targetType: "connector", targetId: String(metadata.accountId ?? ""), metadata });
      else await Promise.resolve(store.recordAuditEvent({ actorUserId: null, traceId: makeSpaceId("trace"), action, targetType: "connector",
        targetId: String(metadata.accountId ?? ""), metadata })).catch(() => undefined);
    }
  }) : null;
  connectorServiceRef.current = connectorService;
  registerConnectorRoutes(app, connectorService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: dotsAuthenticatedOwner,
    state: connectorStateTools
  });
  registerDotDeliverableRoutes(app, dotDeliverablesService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  registerDotMemoryRoutes(app, dotMemoryService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  registerDotAutoRoutingShadowRoutes(app, {
    config, autoRouteShadowRepository: options.autoRouteShadowRepository, autoRouteFactsLoader, routeOptions: defaultRouteRateLimitOptions
  });
  const dotDelegationsRepository = dotsRepository && dotGoalsRepository && config.databaseUrl
    ? PostgresDotDelegationsRepository.fromConnectionString(config.databaseUrl) : null;
  if (dotDelegationsRepository) app.addHook("onClose", () => dotDelegationsRepository.dispose());
  const dotDelegationService = dotsRepository && dotGoalsRepository && dotGoalService && dotDelegationsRepository ? createDotDelegationService({
    store, dots: dotsRepository, goals: dotGoalsRepository, delegations: dotDelegationsRepository,
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId }) => {
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The delegate's conversation could not start.");
      return { sessionId: session.binding.sessionId };
    },
    createGoal: (owner, dotId, input) => dotGoalService.create(owner, dotId, input, null),
    closePane: async (paneId) => { await store.updatePane(paneId, { isClosed: true, status: "CLOSED" }, makeSpaceId("trace")); },
    report: async ({ paneId, sessionId, ownerUserId, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane: await getPaneById(store, paneId), sessionId, content, operatorUserId: ownerUserId,
        clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    }
  }) : null;
  return { dotScheduleService, dotComputerService, dotDeliverablesService, connectorService, dotDelegationService };
}
