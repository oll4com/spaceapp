import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { registerAdminCleanupRoutes, registerPanePruneRoute } from "./admin-cleanup-routes.js";
import { registerAdminToolbarRoutes, registerProviderSwitchRoutes } from "./admin-toolbar-routes.js";
import { registerArtifactReadRoutes } from "./artifact-read-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerBrowserEvidenceRoutes } from "./browser-evidence-routes.js";
import { registerCliAuthHandoffRoutes } from "./cli-auth-handoff-routes.js";
import { registerCliMaintenanceRoutes } from "./cli-maintenance-routes.js";
import { registerCodexHistoryPurgeRoutes } from "./codex-history-purge-routes.js";
import type { SpaceApiConfig } from "./config.js";
import { registerConfigurationRoutes } from "./configuration-routes.js";
import { registerMaintenanceAutopilot } from "./maintenance-autopilot-wiring.js";
import { createMcpToolExecutor } from "./mcp-tool-executor.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { registerProviderRoutes } from "./provider-routes.js";
import { registerReleaseRoutes } from "./release-routes.js";
import { recordAudit } from "./request-audit.js";
import { registerReviewRoutes } from "./review-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerSharedTaskRoutes } from "./shared-task-routes.js";
import { registerSourceControlConnectionRoutes } from "./source-control-connection-routes.js";
import { registerStreamingAdminRoutes } from "./streaming-admin-routes.js";
import { registerStreamingBotRoutes } from "./streaming-bot-routes.js";
import { registerSystemAnalyticsRoutes } from "./system-analytics-routes.js";
import { registerTelegramRoutes } from "./telegram-routes.js";
import { registerTransferRoutes } from "./transfer-routes.js";

type Deps<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type AdminPlatformRoutesDeps = Pick<Deps<typeof registerStreamingBotRoutes>, "streamingService" | "streamingBotService" | "decisionsService">
  & Pick<Deps<typeof registerStreamingAdminRoutes>, "streamingService">
  & Pick<Deps<typeof registerSystemAnalyticsRoutes>, "systemAnalyticsService" | "opencodeModelBenchService">
  & Pick<Deps<typeof registerAdminToolbarRoutes>, "cliRuntimeVisibility" | "antigravityUsageProvider" | "claudeUsageProvider" | "apiProviderAccountsProvider"
    | "toolbarUsageProvider" | "codexResetCreditsService" | "toolbarCliSessionStatsProvider" | "toolbarHostMemoryProvider" | "toolbarModelStatsCollector"
    | "codexLbSpeedDefaultsProvider" | "codexLbSpeedDefaultUpdater">
  & Pick<Deps<typeof registerAdminCleanupRoutes>, "toolbarCliSessionReaper" | "toolbarCliSessionTerminator" | "toolbarKernelCacheReclaimer">
  & Pick<Deps<typeof registerCodexHistoryPurgeRoutes>, "codexHistoryPurgeService" | "cliSessionCleanupService" | "codexHistoryAccessCoordinator" | "sharedCliTaskPurgePreviews">
  & Pick<Deps<typeof registerCliMaintenanceRoutes>, "cliMaintenanceManager" | "cliUpdateAllRunner">
  & Pick<Deps<typeof registerCliAuthHandoffRoutes>, "activityLogService" | "openCliLogin">
  & Pick<Deps<typeof registerReleaseRoutes>, "releasePublishingManager">
  & Pick<Deps<typeof registerSourceControlConnectionRoutes>, "sourceControlPublishingManager">
  & Pick<Deps<typeof registerMemoryRoutes>, "memoryEmbeddingGenerator" | "canonicalMemory" | "canonicalSearch" | "memoryGraphService" | "memoryEmbeddingBackfill">
  & Pick<Deps<typeof registerSharedTaskRoutes>, "codexGoals">
  & Pick<Deps<typeof registerArtifactRoutes>, "browserEvidenceCapture">
  & {
    store: SpaceStore; config: SpaceApiConfig; eventBus: SpaceEventBus;
    options: Deps<typeof registerCliAuthHandoffRoutes>["options"] & Deps<typeof registerArtifactRoutes>["options"]
      & Pick<Deps<typeof registerMaintenanceAutopilot>, "maintenanceAutopilot">;
    telegramIntegrationManager: Deps<typeof registerTelegramRoutes>["manager"];
    notificationService: Deps<typeof registerCliMaintenanceRoutes>["notifications"];
    cliRuntimeRegistryCache: Deps<typeof registerConfigurationRoutes>["runtimes"];
    publicCredentialHost: Deps<typeof registerConfigurationRoutes>["credentialHost"];
    dotMemoryRepository: Deps<typeof registerMemoryRoutes>["dotMemoryEmbeddings"];
    defaultRouteRateLimitOptions: Deps<typeof registerMcpRoutes>["routeOptions"] & Deps<typeof registerConfigurationRoutes>["routeOptions"];
  };

/** The admin and platform routes (moved verbatim from app.ts, ARCH-001 step 74): streaming admin and bot, system analytics, the admin
 * toolbar, cleanup and Codex history purge, provider switch, Telegram, CLI maintenance and its autopilot, CLI sign-in handoffs, pane prune,
 * releases, source control connections, settings, configuration, providers, the model list, MCP with its tool executor, memory, shared
 * tasks, artifacts, browser evidence and reviews, in the order app.ts registered them. Returns the MCP tool executor, which earlier
 * routes call lazily. */
export function registerAdminPlatformRoutes(app: FastifyInstance, deps: AdminPlatformRoutesDeps) {
  const { store, config, eventBus, options, streamingService, streamingBotService, decisionsService, systemAnalyticsService, opencodeModelBenchService,
    cliRuntimeVisibility, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider, toolbarUsageProvider, codexResetCreditsService,
    toolbarCliSessionStatsProvider, toolbarHostMemoryProvider, toolbarModelStatsCollector, codexLbSpeedDefaultsProvider, codexLbSpeedDefaultUpdater,
    toolbarCliSessionReaper, toolbarCliSessionTerminator, toolbarKernelCacheReclaimer, codexHistoryPurgeService, cliSessionCleanupService,
    codexHistoryAccessCoordinator, sharedCliTaskPurgePreviews, telegramIntegrationManager, cliMaintenanceManager, cliUpdateAllRunner, notificationService,
    activityLogService, openCliLogin, releasePublishingManager, sourceControlPublishingManager, cliRuntimeRegistryCache, publicCredentialHost,
    memoryEmbeddingGenerator, canonicalMemory, canonicalSearch, memoryGraphService, memoryEmbeddingBackfill, dotMemoryRepository, codexGoals,
    browserEvidenceCapture, defaultRouteRateLimitOptions } = deps;
  registerStreamingAdminRoutes(app, {
    streamingService, recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerStreamingBotRoutes(app, {
    streamingService, streamingBotService, decisionsService, store,
    recordAudit: (request, input) => recordAudit(store, request, input),
    executeMcpToolWithPolicy: (input, request) => executeMcpToolWithPolicy(input, request),
    routeOptions: defaultRouteRateLimitOptions
  });
  registerSystemAnalyticsRoutes(app, { systemAnalyticsService, opencodeModelBenchService });
  registerAdminToolbarRoutes(app, {
    store, cliRuntimeVisibility, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider,
    toolbarUsageProvider, codexResetCreditsService, toolbarCliSessionStatsProvider, toolbarHostMemoryProvider,
    toolbarModelStatsCollector, codexLbSpeedDefaultsProvider, codexLbSpeedDefaultUpdater
  });
  const toolbarCleanup = registerAdminCleanupRoutes(app, {
    store, toolbarCliSessionStatsProvider, toolbarHostMemoryProvider, toolbarCliSessionReaper, toolbarCliSessionTerminator,
    toolbarKernelCacheReclaimer
  });
  registerCodexHistoryPurgeRoutes(app, {
    store, cliRuntimeVisibility, codexHistoryPurgeService, cliSessionCleanupService, codexHistoryAccessCoordinator,
    sharedCliTaskPurgePreviews
  });
  registerProviderSwitchRoutes(app, { cliRuntimeVisibility });
  if (config.optionalModules.has("telegram")) registerTelegramRoutes(app, {
    manager: telegramIntegrationManager,
    visibility: cliRuntimeVisibility,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerCliMaintenanceRoutes(app, {
    store, cliMaintenanceManager, cliUpdateAllRunner, notifications: notificationService,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerMaintenanceAutopilot(app, {
    config, store, cliRuntimeVisibility, codexHistoryAccessCoordinator, cliSessionCleanupService, toolbarCleanup,
    toolbarHostMemoryProvider, toolbarKernelCacheReclaimer, cliMaintenanceManager, cliUpdateAllRunner,
    maintenanceAutopilot: options.maintenanceAutopilot
  });
  registerCliAuthHandoffRoutes(app, {
    options, store, activityLogService, cliMaintenanceManager, eventBus, openCliLogin
  });
  registerPanePruneRoute(app, { store });
  registerReleaseRoutes(app, { store, releasePublishingManager });
  registerSourceControlConnectionRoutes(app, { store, sourceControlPublishingManager });
  registerSettingsRoutes(app, { store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions });

  registerConfigurationRoutes(app, { store, config, runtimes: cliRuntimeRegistryCache, credentialHost: publicCredentialHost,
    routeOptions: defaultRouteRateLimitOptions, recordAudit: (request, input) => recordAudit(store, request, input) });
  registerTransferRoutes(app, { store, config, routeOptions: defaultRouteRateLimitOptions });

  registerProviderRoutes(app, {
    store, config, visibility: cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  app.get("/api/models", defaultRouteRateLimitOptions, async () => {
    const models = await store.listModels();
    return { data: models, pagination: { page: 1, pageSize: 100, totalItems: models.length, totalPages: models.length ? 1 : 0 } };
  });
  const executeMcpToolWithPolicy = createMcpToolExecutor({
    store, config, eventBus,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerMcpRoutes(app, {
    config, store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions, executeMcpToolWithPolicy
  });

  registerMemoryRoutes(app, {
    config, store, eventBus, memoryEmbeddingGenerator, canonicalMemory, canonicalSearch, memoryGraphService,
    memoryEmbeddingBackfill, dotMemoryEmbeddings: dotMemoryRepository, routeOptions: defaultRouteRateLimitOptions
  });
  registerSharedTaskRoutes(app, {
    store, codexGoals, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions
  });
  registerArtifactReadRoutes(app, {
    store,
    artifactRoot: config.browserEvidenceArtifactRoot,
    routeOptions: defaultRouteRateLimitOptions
  });
  registerArtifactRoutes(app, {
    options, config, store, eventBus, browserEvidenceCapture, routeOptions: defaultRouteRateLimitOptions
  });
  registerBrowserEvidenceRoutes(app, {
    config, store, eventBus, browserEvidenceCapture, routeOptions: defaultRouteRateLimitOptions
  });
  registerReviewRoutes(app, {
    store, eventBus, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  return { executeMcpToolWithPolicy };
}
