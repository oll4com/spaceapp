import { isAgentRuntimeReady } from "@space/contracts";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { registerAgentPaneRoutes } from "./agent-pane-routes.js";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { cliAgentFilesApiBaseUrl } from "./cli-agent-files.js";
import type { createAgentRuntimeRegistryCache } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { registerCouncil } from "./council/wiring.js";
import { registerEventRoutes } from "./event-routes.js";
import { registerLiveRoutes } from "./live-routes.js";
import { type NousWiring, nousLessonEmbedder, registerNous } from "./nous/wiring.js";
import type { createRoomCliControl } from "./room-cli-control.js";
import type { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import type { SystemAnalyticsService } from "./system-analytics-service.js";
import type { SystemHealthMonitor } from "./system-health-service.js";
import { registerTurnRoutes } from "./turn-routes.js";
import type { registerUserToolRoutes } from "./user-routes-wiring.js";
import { registerVoiceAttachmentRoutes, registerVoiceRoutes } from "./voice-routes.js";
import type { YouTubePlaybackStore } from "./youtube-playback-state.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type AgentPane = D<typeof registerAgentPaneRoutes>; type Voice = D<typeof registerVoiceRoutes>; type Live = D<typeof registerLiveRoutes>;
type Council = D<typeof registerCouncil>; type Nous = D<typeof registerNous>; type Turns = D<typeof registerTurnRoutes>; type Events = D<typeof registerEventRoutes>;
type Copilots = Nous["copilots"]; type Ops = NonNullable<Nous["ops"]>; type Telegram = NonNullable<Nous["telegram"]>;
type ConversationRoutesDeps = Pick<AgentPane, "spaceAgentAdapter" | "codexHistoryAccessCoordinator"> & Pick<Voice, "setupOwnerVoiceRuntime" | "setupVoiceCredentials" | "decisionsService">
  & Pick<Live, "roomAgentService"> & Pick<Council, "jobApplyRepository"> & Pick<Turns, "turnStarter" | "codexTurnStarter"> & Pick<Events, "roomShares">
  & {
    config: SpaceApiConfig; store: SpaceStore; eventBus: SpaceEventBus; auth: Live["auth"] & Council["auth"] & Nous["auth"];
    options: { telegramIntegrationManager?: unknown; nousRunner?: Nous["runner"]; vaultBrokerReinstall?: Nous["vaultBrokerReinstall"]; paneBoardRunner?: Nous["paneBoardRunner"] };
    nousRef: { current: NousWiring | null }; browserSessionManager: BrowserSessionManagerWithHostHealth & NonNullable<Nous["browser"]>;
    cliTerminalManager: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "activeSessionPids" | "hostHealth">;
    cliRuntimeVisibility: AgentPane["cliRuntimeVisibility"] & Turns["cliRuntimeVisibility"];
    roomPaneController: Live["roomPaneController"] & Pick<ReturnType<typeof createRoomPaneCliController>, "inspect">;
    commandRoomCli: ReturnType<typeof createRoomCliControl>["commandRoomCli"]; assertRoomAccess: Voice["assertRoomAccess"] & Live["assertRoomAccess"];
    readDashboardAgents: Live["readDashboardAgents"] & Nous["readActivity"]; roomAgentTools: Nous["roomTools"]; roomCoordination: { releaseTrain: Nous["releaseTrain"] };
    roomAgentMonitorRepository: NonNullable<Nous["monitorEvents"]>; controlRepository: NonNullable<Nous["controlRepository"]>; controlInvoke: NonNullable<Nous["invoke"]>;
    railCli: NonNullable<Nous["railCli"]>; cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read">; vault: NonNullable<Nous["vault"]>; paneBrowserAccounts: NonNullable<Nous["paneBrowserAccounts"]>; browserControlActivity: NonNullable<Nous["browserAgents"]>;
    cliUpdateAllRunner: NonNullable<Nous["cliUpdateAllRunner"]>; codexResetCreditsService: NonNullable<Nous["codexResetCredits"]>; telegramPersistence: Telegram["persistence"]; telegramSecrets: Telegram["secrets"];
    youtubePlaybackStore: Pick<YouTubePlaybackStore, "getByPaneId">; notificationService: Council["notifications"] & Nous["notifications"];
    claudeUsageProvider: Council["claudeUsageProvider"] & NonNullable<Nous["claudeUsageProvider"]>; canonicalMemory: Council["canonicalMemory"] & Nous["canonicalMemory"];
    apiProviderAccountsProvider: NonNullable<Nous["apiProviderAccountsProvider"]>; healthMonitor: SystemHealthMonitor; systemServicesProvider: Ops["services"];
    systemAnalyticsService: Pick<SystemAnalyticsService, "models">; gatewayAdminService: ReturnType<typeof registerUserToolRoutes>["gatewayAdminService"];
    mailCopilotService: Copilots["mail"]; marketingCopilotService: Copilots["marketing"]; freelanceCopilotService: Copilots["freelance"]; designService: Copilots["design"];
    appStudioService: Copilots["appStudio"]; videoService: Copilots["video"]; securityCopilotService: Copilots["security"]; monitoringCopilotService: Copilots["monitoring"];
    mailCampaignsService: Copilots["mailCampaigns"]; jobApplyService: Copilots["job"] & Council["jobApplyService"];
    defaultRouteRateLimitOptions: AgentPane["routeOptions"] & Voice["routeOptions"] & Live["routeOptions"] & Council["routeOptions"] & Nous["routeOptions"]
      & D<typeof registerVoiceAttachmentRoutes>["routeOptions"] & Turns["routeOptions"] & Events["routeOptions"];
    defaultWebsocketRateLimitOptions: Voice["websocketRouteOptions"];
  };

/** The conversation routes (moved verbatim from app.ts, ARCH-001 step 81): the agent pane, voice, Live, the Research Council, Nous, voice
 * attachments, turns and the event stream, in the order app.ts registered them. Nous is set on nousRef, which earlier routes read per request. */
export function registerConversationRoutes(app: FastifyInstance, deps: ConversationRoutesDeps) {
  const { config, store, eventBus, auth, options, nousRef, browserSessionManager, cliTerminalManager, cliRuntimeVisibility, roomPaneController, commandRoomCli,
    assertRoomAccess, readDashboardAgents, roomAgentService, roomAgentTools, roomCoordination, roomAgentMonitorRepository, controlRepository, controlInvoke, railCli, cliRuntimeRegistryCache,
    vault, paneBrowserAccounts, browserControlActivity, cliUpdateAllRunner, codexResetCreditsService, telegramPersistence, telegramSecrets, youtubePlaybackStore, notificationService, claudeUsageProvider, canonicalMemory,
    apiProviderAccountsProvider, healthMonitor, systemServicesProvider, systemAnalyticsService, gatewayAdminService, jobApplyRepository, jobApplyService,
    mailCopilotService, marketingCopilotService, freelanceCopilotService, designService, appStudioService, videoService, securityCopilotService,
    monitoringCopilotService, mailCampaignsService, spaceAgentAdapter, codexHistoryAccessCoordinator, setupOwnerVoiceRuntime, setupVoiceCredentials,
    decisionsService, turnStarter, codexTurnStarter, roomShares, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions } = deps;
  registerAgentPaneRoutes(app, {
    store, spaceAgentAdapter, cliRuntimeVisibility, codexHistoryAccessCoordinator,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerVoiceRoutes(app, {
    setupOwnerVoiceRuntime, setupVoiceCredentials,
    config, decisionsService, store, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions, assertRoomAccess
  });

  const { livePersonalMemory, liveHistory } = registerLiveRoutes(app, { config, auth, store, roomPaneController, roomAgentService, routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, readDashboardAgents });
  const councilService = registerCouncil(app, { config, auth, store, parseBody, parseQuery, routeOptions: defaultRouteRateLimitOptions, claudeUsageProvider, jobApplyRepository, jobApplyService, livePersonalMemory, canonicalMemory, notifications: notificationService });
  nousRef.current = registerNous(app, { config, memoryEmbedding: nousLessonEmbedder(config), vault, browser: browserSessionManager, paneBrowserAccounts, browserAgents: browserControlActivity, cliUpdateAllRunner, codexResetCredits: codexResetCreditsService, browserHostHealth: async () => (await browserSessionManager.browserHostHealth?.()) ?? null, paneHostHealth: async () => await cliTerminalManager.hostHealth("cli:codex").catch(() => null), ...(options.telegramIntegrationManager ? {} : { telegram: { persistence: telegramPersistence, secrets: telegramSecrets } }), autonomous: config.instanceJobs.nous, planControllerRunning: config.instanceJobs["managed-plan-controller"], auth, store, parseBody, parseQuery, routeOptions: defaultRouteRateLimitOptions, readActivity: readDashboardAgents, railCli, youtubePlayback: (paneId) => youtubePlaybackStore.getByPaneId(paneId),
    roomTools: roomAgentTools, readyCliRuntimes: async () => (await cliRuntimeRegistryCache.read()).data.filter(isAgentRuntimeReady).map((runtime) => runtime.id), inspectPane: (pane) => roomPaneController.inspect(pane, { fresh: true }), releaseTrain: roomCoordination.releaseTrain, notifications: notificationService, runner: options.nousRunner, vaultBrokerReinstall: options.vaultBrokerReinstall, monitorEvents: roomAgentMonitorRepository,
    answerCli: (pane, input, traceId) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: input.sessionId, answer: input.answer, submit: true, ...(input.fingerprint ? { expectedPromptFingerprint: input.fingerprint } : {}), when: "NOW" }, traceId), pressKeys: (sessionId, keys, traceId) => cliTerminalManager.runSerializedTerminalMutation(sessionId, () => cliTerminalManager.sendInput(sessionId, keys, traceId, null, `${traceId}:keys:${randomUUID()}`)), activeSessionPids: (sessions) => cliTerminalManager.activeSessionPids(sessions), ops: { health: healthMonitor, services: systemServicesProvider, tokenUsage: (range) => systemAnalyticsService.models(range, "all"), gateway: () => gatewayAdminService!.status(), ...(gatewayAdminService ? { gatewayAdmin: gatewayAdminService } : {}) },
    copilots: { mail: mailCopilotService, marketing: marketingCopilotService, freelance: freelanceCopilotService, job: jobApplyService, design: designService, appStudio: appStudioService, video: videoService, security: securityCopilotService, monitoring: monitoringCopilotService, mailCampaigns: mailCampaignsService }, invoke: controlInvoke, eventBus, health: healthMonitor, controlRepository, sessionPids: (sessions) => cliTerminalManager.activeSessionPids(sessions), apiBaseUrl: cliAgentFilesApiBaseUrl(config), claudeUsageProvider, apiProviderAccountsProvider, paneBoardJob: config.instanceJobs["nous-pane-board"], priorityPanesJob: config.instanceJobs["gateway-priority-panes"], paneBoardRunner: options.paneBoardRunner, council: councilService, liveHistory });

  registerVoiceAttachmentRoutes(app, { config, store, routeOptions: defaultRouteRateLimitOptions });

  registerTurnRoutes(app, {
    config, store, eventBus, turnStarter, codexTurnStarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerEventRoutes(app, { store, eventBus, routeOptions: defaultRouteRateLimitOptions, roomShares });
}
