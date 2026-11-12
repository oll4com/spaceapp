import { assertUnmanagedPlanPane } from "./plan-execution-mutations.js";
import { validateSessionDotOwner } from "./dots-routes.js";
import { dotConversationContext, dotRuntimeFor } from "./dot-home.js";
import { dotDeveloperContext, findRoomOwnerDot, sessionDotIdentity } from "./dot-tools-gateway.js";
import { registerAdminPlatformRoutes } from "./admin-platform-routes-wiring.js";
import { registerSignInRoutes, registerUserToolRoutes } from "./user-routes-wiring.js";
import { registerWorkspaceRoutes } from "./workspace-routes-wiring.js";
import { registerCopilotPaneRoutes } from "./copilot-pane-routes-wiring.js";
import { registerBrowserRoutes } from "./browser-routes-wiring.js";
import { registerRoomRoutes } from "./room-routes-wiring.js";
import { registerSpaceControlAndDotGoalRoutes } from "./space-control-dot-goals-wiring.js";
import { registerConversationRoutes } from "./conversation-routes-wiring.js";
import { registerDotRoutes } from "./dot-routes-wiring.js";
import { registerAdminRoutes } from "./admin-routes-wiring.js";
import { registerPlatformRoutes } from "./platform-routes-wiring.js";
import { registerPaneRoutesWiring } from "./pane-routes-wiring.js";
import { createStreamingServices } from "./streaming-services-wiring.js";
import { createSystemHealthServices } from "./system-health-wiring.js";
import { createSystemAnalyticsServices } from "./system-analytics-wiring.js";
import { createUsageProviders } from "./usage-providers-wiring.js";
import { createCliTaskHistory } from "./cli-task-history-wiring.js";
import { registerCliRoutes } from "./cli-routes-wiring.js";
import { describeCoverage, readAttachments } from "./attachment-readers.js";
import { type ChannelsRepository, type DotEvalsRepository, type AutoRouteShadowRepository, PostgresDotMemoryRepository, PostgresDotsRepository, PostgresDotHomeRepository } from "@space/db";
import { createDotMemoryService } from "./dot-memory.js";
import { InMemoryRoomAgentMonitorRepository, PostgresRoomAgentMonitorRepository, type RoomAgentMonitorRepository } from "@space/db";
import { InMemorySpaceNotificationsRepository, PostgresSpaceNotificationsRepository, type SpaceNotificationsRepository } from "@space/db";
import { createCardTranslator, createNotificationService } from "./notifications/service.js";
import { createFcmSender, loadFcmServiceAccount, type FcmSender } from "./notifications/fcm.js";
import { type NousWiring } from "./nous/wiring.js";
import { createRoomAgentEventRouting } from "./room-agent-event-routing.js";
import type { NousRunner } from "./nous/service.js";
import type { PaneSummaryRunner } from "./nous/pane-board.js";
import { createRoomAgentMonitor } from "./room-agent-monitor.js";
import { createConnectorCrypto, readConnectorKey } from "./dot-connectors.js";
import { registerSwarmRoutes } from "./swarm-routes.js";
import { getPaneById, getLatestRoomEvent } from "./pane-guards.js";
import { createPublicCredentialHost } from "./cli-auth-transfer.js";
import { recordAudit } from "./request-audit.js";
import { createInstallTelemetry } from "./install-telemetry.js";
import { createSessionAccess } from "./session-access.js";
import { createGatewayCodexResetCreditsService, createGatewayCodexUsageProvider } from "./gateway/gateway-codex-services.js";
import { type MailboxFactory } from "./job-apply/mailbox.js";
import type { JobApplyGoogleAccess, JobApplyService } from "./job-apply/service.js";
import { type MailCopilotGoogleAccess } from "./mail-copilot/service.js";
import { internalTokenHeader, isAllowedAppDiagnosticsAutomationMutation, isCliBrowserBridgeRequest, isInternalApiRequest, publicPaths, requiresCsrf } from "./api-request-classes.js";
import { type MailCopilotRepository } from "@space/db";
import { marketingPaneCloseGuard, type MarketingCopilotWiring } from "./marketing-copilot/wiring.js";
import { type FreelanceCopilotWiring } from "./freelance-copilot/wiring.js";
import type { DesignWiring } from "./design/wiring.js";
import { type VideoWiring } from "./video/wiring.js";
import { type AppStudioWiring } from "./app-studio/wiring.js";
import type { SecurityCopilotWiring } from "./security-copilot/wiring.js"; import type { MonitoringCopilotWiring } from "./monitoring-copilot/wiring.js";
import { collectStorageReadiness } from "./storage-readiness.js";
import { createCliSessionAccounts } from "./cli-session-account-profile.js";
import { gatewayKeyJoiner, gatewayVaultKeyReconciler, type GatewayAdminService } from "./gateway/gateway-service.js";
import { apiLoggerOptions } from "./request-logging.js";
export { redactRequestUrlForLog } from "./request-logging.js";
import { sendApiError } from "./http-errors.js";
import { registerApiErrorHandler } from "./api-error-handler.js";
import type { ReleasesOptions } from "./instance-releases.js";
import { localArtifactFilePath } from "./artifact-storage.js";
export { sweepExpiredBrowserArtifacts, type BrowserArtifactRetentionSweepResult } from "./artifact-storage.js";
import { createRetentionSweeps } from "./retention-sweeps.js";
export { runDatabaseRetentionSweep, type DatabaseRetentionSweepResult } from "./retention-sweeps.js";
import { createCliDashboardActivityReader, createDashboardAgentsReader, readDashboardActivity } from "./agents-dashboard.js";
import { createRoomAgentSnapshotProvider } from "./room-agent-snapshot.js";
import { startPaneCli } from "./nous/copilot-control.js";
import { PostgresSessionRevocationRepository } from "@space/db";
import { installMobileGate } from "./app-signin.js";
import { brokerScopeAllows, DOT_TOOL_GATEWAY_VERSION, dotWorkspacePath } from "@space/contracts";
import { findCodexWriterThreads } from "./codex-thread-writer.js";
import { controlExecuteSchema, controlOperationSchema } from "@space/contracts";
import { createCliAccountProfileCommands, type CliAccountProfileCommandOptions } from "./cli-account-profile-commands.js";
import { createCliAccountBalancer, type CliAccountBalancer } from "./cli-account-balancer.js";
import { createCliAccountAutoSwitch } from "./cli-account-auto-switch.js";
import { controlTokenHeader, spaceControlInvokeHeader, verifyControlToken } from "./space-control-token.js";
import { harnessAgentPrincipal, isHarnessAgentSessionId } from "./harness-agent-tokens.js";
import { PANE_CATALOG_VERSION, paneCountsSchema } from "@space/contracts";
import { createSpaceControl, supportsControlRuntime } from "./space-control.js";
import { createCaptureTerminalFit, createControlScreenshotCapture } from "./space-control-capture.js";
import { pluginsService } from "./plugins-service.js";
import { InMemorySourceControlRepository, PostgresSourceControlRepository } from "@space/db";
import { SourceControlService } from "./source-control/service.js";
import { WorktreeService } from "./worktrees/worktree-service.js";
import { type VaultOverrides, vaultKeyReader } from "./vault/wiring.js";
import { InMemoryControlRepository, PostgresControlRepository } from "@space/db";
import { createRoomRoutedActions } from "./room-routed-actions.js";
import { createRoomPaneCommands } from "./room-pane-commands.js";
import { NativeTaskTitles } from "./task-title-native.js";
import { InMemoryTaskTitleRepository, PostgresTaskTitleRepository } from "@space/db";
import { TaskTitleProviders } from "./task-title-providers.js";
import { TaskTitleService, taskTitleFailureCode } from "./task-title-service.js";
import { createRoomQuickActions } from "./room-quick-actions.js";
import { SystemHealthMonitor } from "./system-health-service.js";
import { SystemTopologyService } from "./system-topology-service.js";
import type { MemoryEmbeddingBackfill } from "./memory-embedding-backfill.js";
import { createMemoryEmbeddingIndexing } from "./memory-embedding-indexing.js";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  buildCodexAppServerProcessEnv,
  createCodexAppServerControlService,
  createCodexAppServerSocketControlService,
  type CodexAppServerSocketControlService
} from "@space/codex-app-server";
import {
  agentPaneGoalSchema,
  type CliToggleRuntimeId,
  type ApiProviderAccountList,
  imageArtifactMaxBytes,
  paneCliUploadMaxBytes,
  type AgentRuntime,
  type CliSessionStats,
  type CodexLbSpeedDefaultsResponse,
  type CodexLbSpeedTier,
  type AntigravityUsageAccountList,
  type ClaudeUsageAccountList,
  type CodexUsageAccountList,
  type Event,
  voiceTranscriptionMaxBytes,
  type StorageReadiness,
  type HostMemoryDetails,
  type PaneCliSession,
  type Pane,
  turnArtifactMaxCount,
  eventSchema,
  type JobApplyRun,
  type MailCopilotRun,
  type RoomAgentEvent
} from "@space/contracts";
import {
  PostgresSpaceStore,
  InMemoryGatewayRepository,
  PostgresGatewayRepository,
  type GatewayRepository
} from "@space/db";
import {
  InMemoryTelegramPersistence,
  SpaceConflictError,
  SpaceEventBus,
  TelegramIntegrationManager,
  TelegramSecretStore,
  createCanonicalSpaceMemoryBridge,
  createCodexGoalsAdapter,
  makeSpaceId,
  nowIso,
  type CanonicalMemoryBridge,
  type CodexGoalsAdapter,
  type SpaceStore
} from "@space/runtime";
import {
  createCsrfToken,
  csrfHeaderName,
  cookieName,
  defaultSessionRevocationStore,
  getAuthConfig,
  operatorSessionTtlSeconds,
  renewSessionIfDue,
  signSession,
  verifyCsrfToken,
  type AuthConfig
} from "./auth.js";
import {
  AppDiagnosticsService
} from "./app-diagnostics.js";
import { ActivityLogService } from "./activity-log.js";
import { createDefaultActivityLogService, createDefaultAppDiagnosticsService, createDefaultStore } from "./default-app-services.js";
import { DemoCredentialStore } from "./demo-projects/credentials.js";
import { t3PublicOrigins } from "./t3code/access.js";
import { isOtherSiteBrowserRequest, requiresSameSiteBrowser } from "./http-origin-guard.js";
import { type T3CodeServiceController } from "./t3code/service-control.js";
import { harnessSameOriginRequest, readHarnessTaskTitle, renameHarnessTaskTitle } from "./harness-proxy.js";
import { createAutoRouteFactsLoader } from "./auto-route-facts.js";
import { createRoomCoordination } from "./room-coordination.js";
import { projectRoutingState } from "./tool-routing.js";
import {
  type AgentFileDocxNormalizer
} from "./cli-agent-files.js";
import {
  createBrowserEvidenceCapture,
  type BrowserEvidenceCaptureHandler
} from "./browser-evidence.js";
import { withHostBoundBrowserInput } from "./browser-input-client.js";
import { withBrowserPageLifecycle } from "./browser-page-lifecycle.js";
import {
  createConfiguredBrowserSessionManager,
  type BrowserSessionManagerWithHostHealth
} from "./browser-host-proxy.js";
import {
  type BrowserSessionManager
} from "./browser-sessions.js";
import {
  codexDirectParityCodexHome,
  isCodexDirectParityRuntime,
} from "./cli-parity.js";
import { createOpenCodePaneModel } from "./opencode-pane-model.js";
import { createPaneCliModel } from "./pane-cli-model.js";
import { createPaneCliResume } from "./pane-cli-resume.js";
import { createRoomCliControl } from "./room-cli-control.js";
import { createRoomWatchdogNotices } from "./room-watchdog-notices.js";
import { createRoomPaneCliController } from "./room-pane-cli-controller.js";
import { createSpaceControlPaneActions } from "./space-control-pane-actions.js";
import { createSpaceControlPanesOpen } from "./space-control-panes-open.js";
import { createSpaceControlInspectSections } from "./space-control-inspect-sections.js";
import { createSpaceControlIntegration } from "./space-control-integration.js";
import { cliPromptNotReady } from "./cli-prompt-submit.js";
import { fetchOpenCodeSessionMessages } from "@space/opencode-control";
import { findCodexCliPlanState } from "./codex-rollout-diagnostics.js";
import type { CodexResetCreditsService } from "./codex-reset-credits.js";
import {
  type CodexParityService
} from "./codex-parity.js";
import { resolvePaneCodexThreadId } from "./pane-codex-thread.js";
import {
  CliRuntimeVisibilityPolicy
} from "./cli-runtime-visibility.js";
import {
  countRuntimeProcesses as countRuntimeProcessesDefault,
  sweepRuntimeProcesses as sweepRuntimeProcessesDefault,
  type RuntimeProcessSweepResult
} from "./cli-runtime-process-sweeper.js";
import {
  CliVpnBrokerClient,
  type CliVpnBroker
} from "./cli-vpn.js";
import {
  readOpenCodeNativeSessionId,
  readOpenCodeNativeSessionIdFromProcessTree
} from "./opencode-native-session.js";
import { expireGeminiNativeTurns, loadGeminiNativeTurns } from "./gemini-native-turns.js";
import { QuietRequestLogController } from "./request-log-policy.js";
import { createClaudeLiveTurnsReader } from "./claude-live-turns.js";
import { createControlPaneReaders } from "./space-control-pane-readers.js";
import { createClaudeNativeRefRecorder, expireClaudeNativeTurns } from "./claude-native-turns.js";
import { switchClaudePaneAccount, type ClaudeAccountSwitchDeps } from "./claude-account-switch.js";
import { claudeLimitMoveDeps, createClaudeDirectPins, controlPaceHolds, createClaudeLimitMove } from "./claude-limit-move.js";
import { createCliPaneReopener } from "./cli-pane-reopen.js";
import { createCliRuntimePaneRestorer } from "./cli-runtime-pane-restore.js";
import {
  fetchOpenCodeSessionIsTurnActive,
  readOpenCodeServerControl
} from "@space/opencode-control";
import { createOpenCodeServerControlResolver } from "./opencode-server-control.js";
import { createOpenCodeChatControl } from "./opencode-chat-control.js";
import { createCodexLbSpeedDefaultsService, type CodexLbSpeedModelId } from "./codex-lb-speed-defaults.js";
import {
  createCodexCliModeDefaultsService,
  type CodexCliModeDefaultsService
} from "./codex-cli-mode-defaults.js";
import {
  createCodexHistoryAccessCoordinator,
  createCodexHistoryPurgeService,
  type CodexHistoryAccessCoordinator,
  type CodexHistoryPurgeService
} from "./codex-history-purge.js";
import {
  createCliSessionCleanupService,
  type CliSessionCleanupService
} from "./cli-session-cleanup.js";
import {
  CliTerminalManager,
  codexPrivateAppServerSocketPath,
  resolveCodexCliLaunchSettings,
  type CliHostGateway,
  type CliHostReapAggregate,
  type CliTerminalManagerTelemetryEvent,
  type CodexCliCurrentTurnActivityFinder,
  type CodexCliTurnActivityFinder,
  type CodexThreadFinder,
  type CodexThreadResumeSettingsFinder
} from "./cli-terminal.js";
import {
  checkCliRuntimeCredential,
  createAgentRuntimeRegistryCache,
  createCliRuntimeRegistryCache,
  discoverAgentRuntimes,
  findRuntime,
  isCliRuntimeTerminalLaunchable,
  observeCliRuntimeCredential
} from "./cli-runtimes.js";
import {
  CliMaintenanceManager
} from "./cli-maintenance.js";
import { createCliUpdateAllRunner, type CliUpdateAllRunner } from "./cli-maintenance.js";
import type { MaintenanceAutopilot } from "./maintenance-autopilot.js";
import { type AgentToolsOptions } from "./agent-tools.js";
import { getApiConfig, type SpaceApiConfig } from "./config.js";
import {
  cliChatProviderEnabledByRuntimeToggle,
  cliChatRuntimeName,
  cliRuntimeModelsChatProviderAdapter
} from "./chat-providers.js";
import { opencodeDirectParityRoot } from "@space/opencode-control";
import type { OwnerSetupBootstrap } from "./owner-setup.js";
import {
  createSetupConnectionsService,
  type SetupConnectionsService
} from "./setup-connections.js";
import {
  SetupConnectionCheckRunManager
} from "./setup-connection-check-runs.js";
import type { HostStatsProvider } from "./host-stats.js";
import {
  type SystemServicesRunner
} from "./service-services.js";
import {
  runKernelCacheReclaim,
  type InvalidatableProvider,
  type KernelCacheReclaimResult
} from "./toolbar-system-services.js";
import {
  type ToolbarModelStatsCollector
} from "./toolbar-model-stats.js";
import { SystemAnalyticsService } from "./system-analytics-service.js";
import { OpencodeModelBenchService } from "./opencode-model-bench.js";
import {
  StreamingService
} from "./streaming-service.js";
import {
  StreamingBotService
} from "./streaming-bot-service.js";
import {
  createDeepSeekHarnessServiceController,
  runCoreServiceRestart,
  type CoreServiceRestarter,
  type DeepSeekHarnessServiceController
} from "./service-restarts.js";
import {
  SourceControlPublishingManager
} from "./source-control-publishing.js";
import {
  ReleasePublishingManager
} from "./release-publishing.js";
import { createAppVersionReader } from "./app-version.js";
import { createMemoryEmbedding } from "./memory-embedding-smoke.js";
import { createMemoryGraphService, type MemoryGraphApiService } from "./memory-graph-service.js";
import {
  createMemoryConsolidationCoordinator,
  type MemoryConsolidationCoordinator
} from "./memory-consolidation-coordinator.js";
import {
  createMemoryMutationCoordinator,
  type MemoryMutationCoordinator
} from "./memory-mutation-coordinator.js";
import { createHttpObservability } from "./observability.js";
import { requestTraceContexts, traceContextForRawRequest } from "./trace-context.js";
import { createCodexThreadSettings } from "./codex-thread-settings.js";
import { agentTokenSecret } from "./cli-browser-bridge.js";
import { CliTerminalControlRequiredError, parseCliHttpControlAuthority } from "./cli-http-control.js";
import { registerRoomAgentRoutes } from "./room-agent-routes.js";
import { isSemanticMemoryReady, searchDefaultSpaceMemory, type SpaceMemorySearcher } from "./memory-search.js";
export { type SpaceMemorySearcher } from "./memory-search.js";
import {
  paneArtifactUploadMaxBytes
} from "./upload-media.js";
import { collectDefaultSpaceCapabilityInventory, type SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
export { type SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
import { type DashboardAgentsSample } from "./room-routes.js";
import { createOwnedResourceGuard } from "./owned-resource-access.js";
import { createRoomShareAccess } from "./room-shares.js";
import { createCliUserHosting } from "./cli-user-hosts.js";
import { buildSharedCliTaskContext } from "./codex-history-titles.js";
export { buildSharedCliTaskContext } from "./codex-history-titles.js";
import { isLoopbackRequest, requestIpForLog, requestRoutePath, requestSessionUser, secureTokenMatches } from "./request-helpers.js";
import { createCliModelsExecutors } from "./cli-models-executors.js";
import { createSpaceAgentAdapter, type SpaceAgentAdapter, type SpaceAgentControl } from "./space-agent.js";
import {
  completeRoomAgentPrompt,
  createRoomAgentService,
  createRoomAgentWorkflowCoordinator,
  type RoomAgentWorkflowCoordinator
} from "./room-agent.js";
import { createCachedModelSelection, runOpenCodeText } from "./room-agent-model-resolver.js";
import { createGatewayChatModel, createOpenCodeTextModel, createRoomAgentChat, type RoomAgentChatModel } from "./room-agent-chat.js";
import { createRoomAgentTools } from "./room-agent-tools.js";
import { createRoomAgentAutopilot } from "./room-agent-autopilot.js";
import { createRoomActionExecutor, type RoomActionExecutor } from "./room-actions.js";
import { createRoomPlanInventoryProvider, type RoomPlanInventoryProvider } from "./room-plan-inventory.js";
import { createRoomTaskEvaluator, type RoomTaskEvaluator } from "./room-task-evaluator.js";
import {
  createDurableEventRelay
} from "./sse.js";
import { createCodexAppServerTurnStarter, createTurnStarter, type TurnStarter } from "./turns.js";
import { createWorkerReadinessChecker, type WorkerReadinessChecker } from "./worker-readiness.js";
import { createDecisionsService, type DecisionsService } from "./decisions-service.js";
import type { FirstSetupAppOptions } from "./setup-wiring.js";

export interface CreateAppOptions extends FirstSetupAppOptions, CliAccountProfileCommandOptions {
  /** Where the API log goes instead of stdout (tests read it). */
  logStream?: { write(message: string): void };
  /** The production server continues a chess tournament its restart interrupted (tests never do). */
  resumeChessTournament?: boolean;
  decisionsService?: DecisionsService;
  store?: SpaceStore;
  t3CodeServiceController?: T3CodeServiceController;
  agentFileDocxNormalizer?: AgentFileDocxNormalizer;
  appDiagnosticsService?: AppDiagnosticsService;
  activityLogService?: ActivityLogService;
  eventBus?: SpaceEventBus;
  turnStarter?: TurnStarter;
  codexTurnStarter?: TurnStarter;
  browserEvidenceCapture?: BrowserEvidenceCaptureHandler;
  browserSessionManager?: BrowserSessionManager;
  memoryEmbeddingGenerator?: (input: string, purpose?: "document" | "query") => Promise<number[]>;
  /** null turns the backfill off (tests); absent builds it from the config. */
  memoryEmbeddingBackfill?: MemoryEmbeddingBackfill | null;
  spaceAgentAdapter?: SpaceAgentAdapter;
  /** Stage 7 tests: Auto shadow evidence without a database. */
  autoRouteShadowRepository?: AutoRouteShadowRepository;
  /** Stage 7 tests: evaluation runs without a database. */
  dotEvalsRepository?: DotEvalsRepository;
  /** Stage 6 tests: Slack and Teams threads without a database. */
  channelsRepository?: ChannelsRepository;
  /** Room Agent conversation model; tests inject a scripted stream. */
  roomAgentChatModel?: RoomAgentChatModel;
  nousRunner?: NousRunner;
  /** The Vault broker's root reinstall a Nous decision runs (tests). */
  vaultBrokerReinstall?: () => Promise<string>;
  /** The pane board's summary model (nous/pane-board.ts); tests inject one, the live instance uses stable's worker. */
  paneBoardRunner?: PaneSummaryRunner;
  /** Room Agent monitor storage; defaults to Postgres with a database URL, else memory. */
  roomAgentMonitorRepository?: RoomAgentMonitorRepository;
  /** Tests replace the notification store (Postgres on the live instances). */
  notificationsRepository?: SpaceNotificationsRepository;
  /** Tests replace the FCM sender (the configured service account key on the live instances). */
  notificationPush?: FcmSender | null;
  /** Start the room monitor loop on ready; defaults to on for the production store and off for injected test stores. */
  startRoomAgentMonitor?: boolean;
  roomAgentWorkflow?: RoomAgentWorkflowCoordinator;
  dotGoalWorkflow?: import("./dot-goals.js").DotGoalWorkflowCoordinator | null;
  roomActionExecutor?: RoomActionExecutor;
  roomPlanInventoryProvider?: RoomPlanInventoryProvider;
  roomTaskEvaluator?: RoomTaskEvaluator;
  codexAgentControl?: SpaceAgentControl | null;
  codexCliModeDefaultsService?: CodexCliModeDefaultsService;
  workerReadinessChecker?: WorkerReadinessChecker;
  storageReadinessChecker?: () => Promise<StorageReadiness>;
  spaceCapabilityInventoryCollector?: SpaceCapabilityInventoryCollector;
  spaceMemorySearcher?: SpaceMemorySearcher;
  canonicalMemory?: CanonicalMemoryBridge;
  memoryGraphService?: MemoryGraphApiService;
  memoryConsolidationCoordinator?: MemoryConsolidationCoordinator;
  memoryMutationCoordinator?: MemoryMutationCoordinator;
  codexGoals?: CodexGoalsAdapter;
  codexParity?: CodexParityService;
  cliHostClient?: CliHostGateway;
  cliAdminHostClient?: CliHostGateway;
  cliModelSelectionTimeoutMs?: number;
  opencodeStateRoot?: string;
  cliLoginTimeoutMs?: number;
  cliLoginObservationIntervalMs?: number;
  agentToolsOptions?: AgentToolsOptions;
  /** Directory of the merge queue state (space-merge-queue.service); read-only for the API. */
  deployQueueRoot?: string;
  releasesOptions?: Partial<ReleasesOptions>;
  cliRuntimeSessionTerminator?: (sessionId: string) => Promise<boolean>;
  cliVpnBroker?: CliVpnBroker;
  cliVpnSessionPidResolver?: (sessions: readonly PaneCliSession[]) => Promise<Map<string, number>>;
  cliVpnSessionRestarter?: (
    session: PaneCliSession,
    runtime: AgentRuntime,
    traceId: string
  ) => Promise<PaneCliSession>;
  codexMasterChatInterrupter?: (paneId: string, reason: string, traceId: string) => Promise<boolean>;
  codexMasterRoomAgentStopper?: (
    roomId: string,
    missionId: string,
    reason: string,
    traceId: string
  ) => Promise<boolean>;
  killRuntimeProcesses?: (runtimeId: CliToggleRuntimeId, traceId: string) => Promise<RuntimeProcessSweepResult>;
  countRuntimeProcesses?: (runtimeId: CliToggleRuntimeId) => Promise<number>;
  findCodexCliTurnActivity?: CodexCliTurnActivityFinder;
  findCurrentCodexCliTurnActivity?: CodexCliCurrentTurnActivityFinder;
  findCodexThreadId?: CodexThreadFinder;
  findCodexModelControlThreads?: typeof findCodexWriterThreads;
  findCodexThreadResumeSettings?: CodexThreadResumeSettingsFinder;
  codexSessionSocketProbe?: (socketPath: string) => Promise<boolean>;
  codexSocketControlFactory?: (socketPath: string) => CodexAppServerSocketControlService;
  hostStatsProvider?: HostStatsProvider;
  requirementsCacheTtlMs?: number;
  modelCatalogCacheMaxAgeMs?: number;
  cancelWorkflow?: (workflowId: string) => Promise<void>;
  antigravityUsageProvider?: () => Promise<AntigravityUsageAccountList>;
  claudeUsageProvider?: () => Promise<ClaudeUsageAccountList>;
  apiProviderAccountsProvider?: () => Promise<ApiProviderAccountList>;
  toolbarUsageProvider?: () => Promise<CodexUsageAccountList>;
  codexResetCreditsService?: CodexResetCreditsService;
  toolbarCliSessionStatsProvider?: InvalidatableProvider<CliSessionStats> | (() => Promise<CliSessionStats>);
  systemServicesProvider?: SystemServicesRunner;
  toolbarHostMemoryProvider?: InvalidatableProvider<HostMemoryDetails> | (() => Promise<HostMemoryDetails>);
  toolbarModelStatsCollector?: ToolbarModelStatsCollector;
  systemAnalyticsService?: SystemAnalyticsService;
  jobApplyService?: JobApplyService;
  jobApplyMailboxes?: MailboxFactory;
  /** Tests replace the Google connector behind Job Copilot's Gmail and Calendar, and the Gmail API. */
  jobApplyGoogle?: JobApplyGoogleAccess;
  jobApplyGmailFetch?: typeof fetch;
  /** False keeps the periodic Job Copilot mail triage off (tests drive triageMail directly). */
  jobApplyMailTriage?: boolean;
  /** Tests replace the pane CLI kickoff (the live path types the prompt into the pane host session). */
  jobApplyKickoff?: (pane: Pane, run: JobApplyRun, discover: boolean) => Promise<void>;
  /** Tests replace the Google connector behind Mail Copilot's mailboxes, and the Gmail API. */
  mailCopilotGoogle?: MailCopilotGoogleAccess;
  mailCopilotGmailFetch?: typeof fetch; passwordResetMail?: Parameters<typeof registerSignInRoutes>[1]["passwordResetMail"];
  mailCopilotRepository?: MailCopilotRepository;
  vault?: VaultOverrides; marketingCopilotRepository?: MarketingCopilotWiring["repository"]; marketingCopilotKickoff?: MarketingCopilotWiring["kickoff"]; marketingCopilotScheduler?: boolean; marketingCopilotMetrics?: boolean; freelanceCopilotRepository?: FreelanceCopilotWiring["repository"]; freelanceCopilotKickoff?: FreelanceCopilotWiring["kickoff"]; freelanceCopilotScheduler?: boolean; freelanceCopilotMailboxes?: FreelanceCopilotWiring["mailboxes"];
  /** Tests replace the Design pane's repository, gateway client, template renderer and CLI kickoff. */
  designRepository?: DesignWiring["repository"]; designGenerate?: DesignWiring["generate"]; designRender?: DesignWiring["render"]; designKickoff?: DesignWiring["kickoff"]; appStudioRepository?: AppStudioWiring["repository"]; appStudioKickoff?: AppStudioWiring["kickoff"]; securityCopilotRepository?: SecurityCopilotWiring["repository"]; securityCopilotFeeds?: SecurityCopilotWiring["feeds"]; securityCopilotKickoff?: SecurityCopilotWiring["kickoff"]; securityCopilotWatch?: boolean; monitoringCopilotRepository?: MonitoringCopilotWiring["repository"]; monitoringCopilotCollector?: MonitoringCopilotWiring["collector"]; monitoringCopilotKickoff?: MonitoringCopilotWiring["kickoff"]; monitoringCopilotWatch?: boolean; mailCampaignsRepository?: import("@space/db").MailCampaignsRepository; mailCampaignsSmtp?: import("./mail-campaigns/transports.js").MailTransportDeps["smtp"]; mailCampaignsSender?: boolean; videoRepository?: VideoWiring["repository"]; videoEngine?: VideoWiring["engine"]; videoKickoff?: VideoWiring["kickoff"];
  /** Tests replace the pane CLI kickoff of a Mail Copilot run. */
  mailCopilotKickoff?: (pane: Pane, run: MailCopilotRun) => Promise<void>;
  /** false: no Gmail history polling (tests call the sync themselves). */
  mailCopilotSync?: boolean;
  opencodeModelBenchService?: OpencodeModelBenchService | null;
  healthMonitor?: SystemHealthMonitor;
  systemTopologyService?: SystemTopologyService;
  streamingService?: StreamingService;
  streamingBotService?: StreamingBotService;
  toolbarCliSessionReaper?: () => Promise<CliHostReapAggregate>;
  toolbarCliSessionTerminator?: (sessionId: string, traceId?: string) => Promise<boolean>;
  toolbarKernelCacheReclaimer?: () => Promise<KernelCacheReclaimResult>;
  codexLbSpeedDefaultsProvider?: () => Promise<CodexLbSpeedDefaultsResponse>;
  gatewayAdminService?: GatewayAdminService;
  codexLbSpeedDefaultUpdater?: (modelId: CodexLbSpeedModelId, tier: CodexLbSpeedTier) => Promise<CodexLbSpeedDefaultsResponse>;
  codexHistoryPurgeService?: CodexHistoryPurgeService;
  cliSessionCleanupService?: CliSessionCleanupService;
  codexHistoryAccessCoordinator?: CodexHistoryAccessCoordinator;
  maintenanceAutopilot?: MaintenanceAutopilot;
  serviceRestarter?: CoreServiceRestarter;
  deepSeekHarnessServiceController?: DeepSeekHarnessServiceController;
  serviceRestartCooldownPath?: string;
  telegramIntegrationManager?: TelegramIntegrationManager;
  sourceControlPublishingManager?: SourceControlPublishingManager;
  sourceControlService?: SourceControlService;
  cliMaintenanceManager?: CliMaintenanceManager;
  cliUpdateAllRunner?: CliUpdateAllRunner; serverOpsRunner?: import("./server-ops-routes.js").ServerOpsRunner;
  cliRecoveryLoginOpener?: (input: {
    roomId: string;
    runtimeId: string;
    requestId: string;
  }) => Promise<{ paneId: string }>;
  cliAccountBalancer?: CliAccountBalancer;
  releasePublishingManager?: ReleasePublishingManager;
  auth?: AuthConfig;
  config?: SpaceApiConfig;
  setup?: OwnerSetupBootstrap | null;
  setupConnections?: SetupConnectionsService;
  setupConnectionCheckRuns?: SetupConnectionCheckRunManager;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const apiStartedAt = new Date().toISOString();
  const config = options.config ?? getApiConfig(process.env);
  const decisionsService = options.decisionsService ?? createDecisionsService();
  const {
    removeGeminiAccountProfileState,
    readGeminiAccountProfileDetails,
    removeClaudeAccountProfileState,
    readClaudeAccountProfileUsage,
    removeCopilotAccountProfileState,
    removeCursorAccountProfileState,
    removeKimiAccountProfileState,
    readKimiAccountProfileUsage,
    readCopilotAccountProfileUsage,
    deletingCliAccountProfileKeys,
    cliAccountProfileKey,
    readCliAccountProfileDetails,
    cliAccountIdentityCacheTtlMs,
    cliAccountIdentityCache,
    readCachedCliAccountIdentity,
    invalidateCliAccountIdentity
  } = createCliAccountProfileCommands(options, config);
  const appVersionReader = createAppVersionReader({
    appVersionEnv: process.env.SPACE_APP_VERSION,
    publicDistribution: process.env.SPACE_PUBLIC_DISTRIBUTION === "true"
  });
  const auth = options.auth ?? getAuthConfig(process.env);
  const store = options.store ?? createDefaultStore(config);
  // Session-level balancing: Copilot reports its quotas; Cursor reports none, so its connected accounts rank equal.
  const cliAccountBalancer = options.cliAccountBalancer ?? createCliAccountBalancer({
    // Test apps never touch the live state file.
    statePath: process.env.VITEST === "true" ? null : config.cliAccountBalancerStateFile,
    listProfiles: async (runtimeId) => (await store.listCliAccountProfiles(runtimeId))
      .map(({ profileId, displayName }) => ({ profileId, displayName })),
    readUsage: async (runtimeId, profileId) => {
      if (runtimeId === "cli:copilot") return readCopilotAccountProfileUsage(profileId);
      if (runtimeId === "cli:kimi") return readKimiAccountProfileUsage(profileId);
      const identity = await readCachedCliAccountIdentity(runtimeId, profileId);
      return { status: identity.authStatus === "CONNECTED" ? "UNKNOWN" : "NOT_CONNECTED", plan: null, remainingPercent: null, resetAt: null, windows: [] };
    }
  });
  const claudeDirectPins = createClaudeDirectPins(process.env.VITEST === "true" ? null : join(dirname(config.cliAccountBalancerStateFile), "claude-direct-pins.json"));
  const appDiagnosticsService =
    options.appDiagnosticsService ?? createDefaultAppDiagnosticsService(config, store);
  const activityLogService =
    options.activityLogService ?? createDefaultActivityLogService(config, store);
  if (options.setup) {
    await store.initializeOwnerSetup(options.setup);
  }
  const sourceControlPublishingManager =
    options.sourceControlPublishingManager ?? new SourceControlPublishingManager({ store });
  const personalGitRoot = process.env.SPACE_PERSONAL_GIT_ROOT || "/opt/spaceapp/var/personal-source-control";
  const sourceControlService = options.sourceControlService ?? new SourceControlService({
    repository: config.runtimeStore === "postgres" && config.databaseUrl
      ? PostgresSourceControlRepository.fromConnectionString(config.databaseUrl)
      : new InMemorySourceControlRepository(),
    credentials: new DemoCredentialStore(personalGitRoot),
    credentialRoot: personalGitRoot,
    defaultGiteaUrl: process.env.SPACE_GITEA_URL,
    privateOrigins: (process.env.SPACE_GIT_ALLOWED_PRIVATE_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)
  });
  const cliMaintenanceManager =
    options.cliMaintenanceManager ?? new CliMaintenanceManager({
      store,
      repairEnabled: config.cliMaintenanceRepairEnabled
    });
  const cliUpdateAllRunner = options.cliUpdateAllRunner ?? createCliUpdateAllRunner();
  const releasePublishingManager =
    options.releasePublishingManager ?? new ReleasePublishingManager({ store });
  // Nous's Telegram two-way (2026-10-24) reads the same paired chat and bot secret; a test's own manager leaves Nous without Telegram.
  const telegramPersistence = store instanceof PostgresSpaceStore ? store.createTelegramPersistence() : new InMemoryTelegramPersistence();
  const telegramSecrets = new TelegramSecretStore(config.telegramSecretRoot);
  const telegramIntegrationManager =
    options.telegramIntegrationManager ??
    new TelegramIntegrationManager({ persistence: telegramPersistence, secrets: telegramSecrets });
  let reportEventSubscriberError: (error: unknown, event: Event) => void = () => undefined;
  const eventBus = options.eventBus ?? new SpaceEventBus({
    onSubscriberError: (error, event) => reportEventSubscriberError(error, event)
  });
  const durableEventRelay = createDurableEventRelay({
    listEvents: (query) => store.listEventChanges({ ...query, sortOrder: "asc" }),
    publish: (event) => eventBus.publish(event)
  });
  const stopTrackingPublishedEvents = eventBus.subscribe((event) => durableEventRelay.markSeen(event));
  const turnStarter =
    options.turnStarter ??
    createTurnStarter({
      enabled: config.enableDummyTurns,
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      taskQueue: config.temporalTaskQueue
    });
  const codexTurnStarter =
    options.codexTurnStarter ??
    createCodexAppServerTurnStarter({
      enabled: config.enableCodexTurns,
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      taskQueue: config.temporalTaskQueue
    });
  const browserEvidenceCapture =
    options.browserEvidenceCapture ??
    createBrowserEvidenceCapture({
      enabled: config.browserEvidenceEnabled,
      chromePath: config.browserEvidenceChromePath,
      artifactRoot: config.browserEvidenceArtifactRoot,
      timeoutMs: config.browserEvidenceTimeoutMs, targetOrigin: config.browserEvidenceTargetOrigin
    });
  const browserSessionManager: BrowserSessionManagerWithHostHealth = withBrowserPageLifecycle(options.browserSessionManager ??
    withHostBoundBrowserInput(createConfiguredBrowserSessionManager({ store, config }), config), store);
  const memoryEmbeddingGenerator =
    options.memoryEmbeddingGenerator ?? ((input: string, purpose: "document" | "query" = "document") =>
      createMemoryEmbedding(config, input, { taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }));
  const codexGoals = options.codexGoals ?? createCodexGoalsAdapter(config.codexGoalsDbPath);
  const spawnedCodexAppServerControl =
    config.codexAppServerEnabled && config.codexAppServerAllowStdioSpawn && config.codexAppServerHome
      ? createCodexAppServerControlService({
          command: config.codexAppServerCommand,
          cwd: process.cwd(),
          env: buildCodexAppServerProcessEnv({
            baseEnv: process.env,
            codexHome: config.codexAppServerHome,
            credential: null
          }),
          clientInfo: { name: "space", title: "Space", version: config.version },
          timeoutMs: 30_000
        })
      : null;
  const codexAgentControl = Object.hasOwn(options, "codexAgentControl")
    ? options.codexAgentControl ?? null
    : spawnedCodexAppServerControl;
  const codexCliModeDefaultsService =
    options.codexCliModeDefaultsService ??
    createCodexCliModeDefaultsService({ control: codexAgentControl });
  const codexSessionSocketProbe = options.codexSessionSocketProbe ?? (async (socketPath: string) => {
    try {
      return (await stat(socketPath)).isSocket();
    } catch {
      return false;
    }
  });
  const codexSocketControlFactory = options.codexSocketControlFactory ?? ((socketPath: string) =>
    createCodexAppServerSocketControlService({
      socketPath,
      rolloutRoot: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
      clientInfo: { name: "space", title: "Space", version: config.version },
      timeoutMs: 5_000
    }));
  const cliChatRuntimeState = async (runtimeId: string) => {
    const registry = await cliRuntimeRegistryCache.read();
    const runtime = findRuntime(registry, runtimeId);
    if (!runtime || runtime.adapterStatus !== "ENABLED" || !runtime.detectedCommandPath) {
      return { enabled: false, reason: runtime?.statusReason ?? `${runtimeId} is not available.` };
    }
    const quotaExhausted = runtime.authState === "READY" && /quota|billing[- ]cycle|tokens/i.test(runtime.statusReason ?? "");
    if (quotaExhausted) {
      return { enabled: false, reason: runtime.statusReason ?? `${runtimeId} has no available tokens/quota.` };
    }
    return { enabled: true, reason: null };
  };
  const cliModelsExecutor = createCliModelsExecutors();
  const cliChatProviderAdapters = config.cliChatTurnsEnabled
    ? config.cliChatTurnRuntimeIds.map((runtimeId) =>
        cliRuntimeModelsChatProviderAdapter({
          runtimeId,
          providerName: cliChatRuntimeName(runtimeId),
          executeModels: cliModelsExecutor(runtimeId),
          resolveState: cliChatRuntimeState
        })
      )
    : [];
  const dotsRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresDotsRepository.fromConnectionString(config.databaseUrl) : null;
  const dotMemoryRepository = dotsRepository && config.databaseUrl ? PostgresDotMemoryRepository.fromConnectionString(config.databaseUrl, config.memoryEmbeddingModel) : null;
  // Stage 8: the user's Dot settings and each Dot's feed across rooms.
  const dotHomeRepository = dotsRepository && config.databaseUrl ? PostgresDotHomeRepository.fromConnectionString(config.databaseUrl) : null;
  const roomOwnerDot = (roomId: string, dotId: string) => findRoomOwnerDot(store, dotsRepository ?? null, roomId, dotId);
  const dotMemoryService = dotsRepository && dotMemoryRepository ? createDotMemoryService({
    store, dots: dotsRepository, memories: dotMemoryRepository,
    // Embeddings only when semantic memory is verified; text search works without them.
    embed: async (text, purpose) => {
      const [smoke, vector] = await Promise.all([store.getLatestMemoryEmbeddingSmoke(), store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions)]);
      return isSemanticMemoryReady(smoke, vector) ? await memoryEmbeddingGenerator(text, purpose) : null;
    },
    audit: async (request, action, metadata) => {
      if (request) await recordAudit(store, request, { action, targetType: "dot", targetId: String(metadata.dotId ?? ""), metadata });
      else await Promise.resolve(store.recordAuditEvent({ actorUserId: null, traceId: makeSpaceId("trace"), action, targetType: "dot",
        targetId: String(metadata.dotId ?? ""), metadata })).catch(() => undefined);
    }
  }) : null;
  const autoRouteFactsLoader = config.codexAppServerHome
    ? createAutoRouteFactsLoader({ codexHome: config.codexAppServerHome, priceCatalogPath: config.modelPriceCatalogPath ?? null }) : null;
  const spaceAgentAdapter =
    options.spaceAgentAdapter ??
    createSpaceAgentAdapter({
      store,
      config,
      codexTurnStarter,
      codexAgentControl,
      validateDot: (pane, dotId, ownerUserId) => validateSessionDotOwner(store, dotsRepository, pane, dotId, ownerUserId),
      readPendingRequest: async (session) => dotsRepository && await dotsRepository.hasPendingApproval(session.sessionId).catch(() => false)
        ? { kind: "APPROVAL" as const } : null,
      dotTurnContext: async (session, workspace) => {
        if (!dotsRepository || !session.dotId) return null;
        const owned = await roomOwnerDot(session.roomId, session.dotId);
        if (!owned) return null;
        const { owner, dot } = owned;
        // Only a new thread or one that started with gateway tools uses the gateway.
        const toolGateway = config.dotToolGatewayEnabled
          && (!session.threadId || await dotsRepository.sessionToolGateway(session.sessionId) === DOT_TOOL_GATEWAY_VERSION);
        // Gateway turns start with the Dot's recent memories; recall finds the rest.
        const memories = toolGateway && dotMemoryService ? await dotMemoryService.context(owner, dot.dotId, session.roomId).catch(() => []) : [];
        // Stage 8: one continuous conversation per Dot. The turn learns what was said elsewhere and the notices it sent.
        const feed = toolGateway && dotHomeRepository
          ? await dotHomeRepository.conversationContext(owner, dot.dotId, session.sessionId).catch(() => null) : null;
        return { toolGateway, developerContext: dotDeveloperContext(dot, workspace, dotWorkspacePath(dot.dotId, config.dotWorkspaceRoot), memories),
          conversationContext: feed ? dotConversationContext(dot.name, feed) : null,
          onAccepted: async () => { if (feed?.notices.length) await dotHomeRepository!.markNoticesDelivered(dot.dotId, feed.notices.map((notice) => notice.entryId)); } };
      },
      dotIdentity: (session) => sessionDotIdentity(store, dotsRepository ?? null, session),
      dotRuntime: async (session) => {
        if (!dotHomeRepository || !session.dotId) return null;
        // Agent Proof and recovery rooms, and evaluation runs, keep the model and permissions their pane chose.
        if ((await store.getRoom(session.roomId)).kind !== "WORKSPACE") return null;
        if (await dotEvalsRepository?.isRunningSession(session.sessionId).catch(() => true)) return null;
        const owned = await roomOwnerDot(session.roomId, session.dotId);
        return owned ? dotRuntimeFor(owned.dot, await dotHomeRepository.settings(owned.owner)) : null;
      },
      defaultDotId: async (pane) => {
        const owner = dotHomeRepository && dotsRepository ? (await store.getRoom(pane.roomId)).ownerUserId : null;
        if (!owner) return null;
        // No choice in Settings means the first Dot.
        return (await dotHomeRepository!.settings(owner)).defaultDotId ?? (await dotsRepository!.list(owner))[0]?.dotId ?? null;
      },
      autoRouteFacts: autoRouteFactsLoader ?? undefined,
      readDotAttachments: async ({ dotId, artifacts }) => {
        const inputs = artifacts.flatMap((artifact) => {
          try {
            return [{ artifactId: artifact.id, sourcePath: localArtifactFilePath({ artifactRoot: config.browserEvidenceArtifactRoot, artifact }),
              filename: typeof artifact.metadata.originalFilename === "string" ? artifact.metadata.originalFilename : artifact.id,
              mimeType: artifact.mimeType, byteSize: artifact.byteSize, sha256: artifact.sha256 }];
          } catch { return []; }
        });
        // Text goes to the Dot's workspace; the coverage cache stays outside it so a Dot cannot rewrite what was read.
        const results = await readAttachments(inputs, { outputDir: join(dotWorkspacePath(dotId, config.dotWorkspaceRoot), "attachments"),
          cacheDir: dotWorkspacePath(dotId, join(dirname(config.dotWorkspaceRoot), "read-cache")) });
        return results.map((result) => ({ artifactId: result.artifactId, coverage: result.coverage, line: describeCoverage(result) }));
      },
      cliChatProviderAdapters,
      openCodeControlResolver: async () => resolveChatOpenCodeCatalogControl(),
      openCodeSessionControlResolver: async (spaceAgentSessionId) =>
        resolveChatPaneOpenCodeControl(spaceAgentSessionId),
      // Every Chat provider follows its OWN CLI runtime toggle: a CLI disabled in
      // Settings is never offered in Chat panes, and re-enabling it restores the
      // provider on the next session read. CLI providers still perform their own
      // live runtime/credential check on top of that (they must not inherit
      // Codex's global visibility switch).
      isChatProviderEnabled: cliChatProviderEnabledByRuntimeToggle(
        (runtimeId) => cliRuntimeVisibility.isEnabled(runtimeId)
      ),
      readGoal: async (threadId) => {
        const goal = (await codexGoals.list()).find((candidate) => candidate.threadId === threadId);
        return goal
          ? agentPaneGoalSchema.parse({
              threadId: goal.threadId,
              goalId: goal.goalId,
              objective: goal.title,
              status: goal.status,
              tokenBudget: goal.tokenBudget,
              tokensUsed: goal.tokensUsed,
              timeUsedSeconds: goal.timeUsedSeconds,
              createdAt: goal.createdAt,
              updatedAt: goal.updatedAt
            })
          : null;
      },
      requirementsCacheTtlMs: options.requirementsCacheTtlMs,
      modelCatalogCacheMaxAgeMs: options.modelCatalogCacheMaxAgeMs,
      cancelWorkflow: options.cancelWorkflow,
      decisionsService
    });
  const roomAgentWorkflow =
    options.roomAgentWorkflow ??
    createRoomAgentWorkflowCoordinator({
      enabled: config.agentPaneEnabled && config.enableCodexTurns,
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      taskQueue: config.temporalTaskQueue
    });
  const observability = createHttpObservability({ serviceName: "space-api" });
  // Public installations with telemetry Yes report anonymous activation events (plan 1.4).
  const installTelemetry = createInstallTelemetry(process.env, join(dirname(config.browserEvidenceArtifactRoot), "telemetry"));
  let reportCliTerminalManagerTelemetry = (event: CliTerminalManagerTelemetryEvent) => {
    observability.observeCliTerminalEvent({
      source: "SERVER",
      event: event.event,
      outcome: event.outcome,
      reason: event.reason
    });
  };
  const baseWorkerReadinessChecker = options.workerReadinessChecker ?? createWorkerReadinessChecker(config);
  // Every readiness check (readyz, admin worker, system status) refreshes the
  // Temporal queue gauges on /metrics; /metrics itself never calls Temporal.
  const workerReadinessChecker: WorkerReadinessChecker = async () => {
    const readiness = await baseWorkerReadinessChecker();
    try { observability.observeWorkerReadiness(readiness); } catch { /* metrics never fail readiness */ }
    return readiness;
  };
  const storageReadinessChecker = options.storageReadinessChecker ?? collectStorageReadiness;
  const spaceCapabilityInventoryCollector = options.spaceCapabilityInventoryCollector ?? collectDefaultSpaceCapabilityInventory;
  const spaceMemorySearcher = options.spaceMemorySearcher ?? ((q) => searchDefaultSpaceMemory(q, decisionsService));
  const canonicalMemory =
    options.canonicalMemory ??
    createCanonicalSpaceMemoryBridge({
      indexPath: config.spaceMemoryIndexPath,
      monthlyPath: config.spaceMemoryMonthlyPath,
      lockPath: config.spaceMemoryLockPath
    });
  const { canonicalSearch, backfill: memoryEmbeddingBackfill } = createMemoryEmbeddingIndexing({ config, store, canonicalMemory,
    dotMemories: dotMemoryRepository, backfill: options.memoryEmbeddingBackfill });
  const memoryGraphService =
    options.memoryGraphService ??
    createMemoryGraphService({
      rootDir: config.memoryGraphRoot,
      indexPath: config.spaceMemoryIndexPath,
      monthlyPath: config.spaceMemoryMonthlyPath
    });
  const memoryMutationCoordinator =
    options.memoryMutationCoordinator ??
    createMemoryMutationCoordinator({
      enabled: config.memoryGraphEnabled && config.memoryMutationsEnabled,
      address: config.temporalAddress,
      namespace: config.temporalNamespace
    });
  const memoryConsolidationCoordinator =
    options.memoryConsolidationCoordinator ??
    createMemoryConsolidationCoordinator({
      enabled: config.memoryGraphEnabled && config.memoryMaintenanceEnabled,
      address: config.temporalAddress,
      namespace: config.temporalNamespace
    });
  // The Codex parity service, the unified CLI task registry with each runtime's native task reference, the agent session history
  // (cli-task-history-wiring.ts). The CLI terminal manager is created below, so the registry gets a reader that looks it up when it runs.
  const { codexParity, unifiedCliTaskRegistry, agentSessionHistoryService } = createCliTaskHistory({ options, config, store,
    cliTerminalManager: { activeSessionPids: (sessions) => cliTerminalManager.activeSessionPids(sessions) } });
  let cliRuntimeRegistryCache!: ReturnType<typeof createAgentRuntimeRegistryCache>;
  let setupConnections!: SetupConnectionsService;

  let taskTitleInputNotifier: ((paneId: string) => void) | undefined;
  const roomShares = createRoomShareAccess({ store, enabled: config.multiUserEnabled === true });
  const cliUserHosting = createCliUserHosting({ store, config, paneById: (paneId) => getPaneById(store, paneId) });
  // Non-null only on public installs: their core image has no CLIs (OpenCode included), so CLI calls go to the CLI container.
  const publicCredentialHost = createPublicCredentialHost(config);
  const runOpenCode = publicCredentialHost?.openCodeText ?? runOpenCodeText;
  const cliTerminalManager = new CliTerminalManager({
    store,
    config,
    credentialHost: publicCredentialHost,
    observeOnly: (pane, userId) => roomShares.observeOnly(pane, userId), ...cliUserHosting.terminal,
    discoverRuntimes: () => cliRuntimeRegistryCache.read(),
    // Reattaching an allocated session must not await probes for unrelated CLIs.
    // Runtime visibility and session ownership are still checked on every request.
    discoverRuntimesForAttach: () => cliRuntimeRegistryCache.readStaleWhileRefreshing(),
    findCodexCliTurnActivity: options.findCodexCliTurnActivity,
    findCurrentCodexCliTurnActivity: options.findCurrentCodexCliTurnActivity,
    findCodexThreadId: options.findCodexThreadId,
    findCodexThreadResumeSettings: options.findCodexThreadResumeSettings,
    hostClient: options.cliHostClient,
    adminHostClient: options.cliAdminHostClient,
    modelSelectionTimeoutMs: options.cliModelSelectionTimeoutMs,
    loginTimeoutMs: options.cliLoginTimeoutMs,
    loginObservationIntervalMs: options.cliLoginObservationIntervalMs,
    onTelemetry: (event) => { reportCliTerminalManagerTelemetry(event); installTelemetry.observeCliEvent(event); },
    onTaskInput: (paneId) => { expireClaudeNativeTurns(paneId); expireGeminiNativeTurns(paneId); taskTitleInputNotifier?.(paneId); },
    withOperatorMutation: async (paneId, work) => spaceControl.withOperatorMutation(await store.getPane(paneId), work),
    codexBuildDefaultsProvider: () => codexCliModeDefaultsService.build(),
    newPaneAccountProfileId: (runtimeId) => gatewayCliAccounts.newPaneProfileId(runtimeId),
    onLoginSucceeded: async (loginSession, evidence) => {
      const startedAtMs = Date.parse(loginSession.startedAt);
      const durationMs = Math.min(900_000, Math.max(0, Date.now() - (Number.isFinite(startedAtMs) ? startedAtMs : Date.now())));
      try {
        cliRuntimeRegistryCache.invalidate();
        const registry = await cliRuntimeRegistryCache.read();
        const runtime = findRuntime(registry, loginSession.runtimeId);
        if (!runtime || !isCliRuntimeTerminalLaunchable(runtime)) {
          throw new SpaceConflictError("CLI login credential verification did not reach READY.");
        }
        const setupVerification = evidence
          ? await setupConnections.recordVerifiedEvidence(runtime.id, evidence.fingerprintHash)
          : await setupConnections.verify(runtime.id);
        if (setupVerification.state !== "CONNECTED") {
          throw new SpaceConflictError("CLI login credential verification did not reach CONNECTED.");
        }
        const pane = await store.getPane(loginSession.paneId);
        let modelId = pane.modelId ?? runtime.defaultModelId;
        let reasoningEffort = pane.reasoningEffort;
        if (isCodexDirectParityRuntime(runtime.id)) {
          const defaults = await codexCliModeDefaultsService.build();
          const resolved = resolveCodexCliLaunchSettings({
            cliCodexDefaultModel: defaults.modelId,
            cliCodexDefaultReasoningEffort: defaults.reasoningEffort
          }, pane);
          if (!resolved) throw new SpaceConflictError("Codex CLI defaults could not be resolved after login.");
          modelId = resolved.modelId;
          reasoningEffort = resolved.reasoningEffort;
          if (pane.modelId !== modelId || pane.reasoningEffort !== reasoningEffort) {
            await store.updatePane(pane.id, { modelId, reasoningEffort }, "req:cli-login-lifecycle");
          }
        }
        const normalSession = await store.createPaneCliSession({
          paneId: pane.id,
          roomId: pane.roomId,
          runtimeId: runtime.id,
          providerId: runtime.providerId,
          agentId: runtime.agentId,
          modelId,
          reasoningEffort,
          launchMode: "FRESH",
          purpose: "NORMAL",
          cwd: "/etc",
          codexThreadId: null,
          status: "IDLE",
          statusReason: "CLI login verified; normal session allocated in the same pane."
        }, "req:cli-login-lifecycle");
        try {
          await cliMaintenanceManager.completeAuthHandoffsForRuntime(runtime.id);
        } catch {
          try {
            await store.recordAuditEvent({
              actorUserId: null,
              traceId: "req:cli-login-lifecycle",
              action: "cli_maintenance.auth_handoff.reconcile",
              targetType: "runtime",
              targetId: runtime.id,
              metadata: { runtimeId: runtime.id, outcome: "FAILED" }
            });
          } catch {
            // Provider login remains successful even if maintenance reconciliation is temporarily unavailable.
          }
        }
        await store.recordAuditEvent({
          actorUserId: null,
          traceId: "req:cli-login-lifecycle",
          action: "cli.login.complete",
          targetType: "runtime",
          targetId: runtime.id,
          metadata: { runtimeId: runtime.id, outcome: "SUCCESS", durationMs }
        });
        const latestEvent = await getLatestRoomEvent(store, pane.roomId);
        if (latestEvent) eventBus.publish(latestEvent);
        return normalSession.sessionId;
      } catch {
        await store.recordAuditEvent({
          actorUserId: null,
          traceId: "req:cli-login-lifecycle",
          action: "cli.login.complete",
          targetType: "runtime",
          targetId: loginSession.runtimeId,
          metadata: { runtimeId: loginSession.runtimeId, outcome: "VERIFICATION_FAILED", durationMs }
        });
        throw new Error("CLI login credential verification failed.");
      }
    },
    onLoginFailed: async (loginSession, outcome) => {
      const startedAtMs = Date.parse(loginSession.startedAt);
      const durationMs = Math.min(900_000, Math.max(0, Date.now() - (Number.isFinite(startedAtMs) ? startedAtMs : Date.now())));
      await store.recordAuditEvent({
        actorUserId: null,
        traceId: "req:cli-login-lifecycle",
        action: "cli.login.complete",
        targetType: "runtime",
        targetId: loginSession.runtimeId,
        metadata: { runtimeId: loginSession.runtimeId, outcome, durationMs }
      });
    }
  });
  const recordClaudeNativeRef = createClaudeNativeRefRecorder(store);
  const readClaudeLiveTurns = createClaudeLiveTurnsReader({ cliTerminalManager, recordClaudeNativeRef });
  const cliVpnBroker = options.cliVpnBroker ?? new CliVpnBrokerClient();
  const deepSeekHarnessServiceController = options.deepSeekHarnessServiceController ?? createDeepSeekHarnessServiceController();
  const cliVpnSessionPidResolver = options.cliVpnSessionPidResolver
    ?? ((sessions: readonly PaneCliSession[]) => cliTerminalManager.activeSessionPids(sessions));
  const cliVpnSessionRestarter = options.cliVpnSessionRestarter
    ?? (async (session: PaneCliSession, runtime: AgentRuntime, traceId: string) => {
      const taskRevision = session.cliTaskRevisionId
        ? await store.getCliTaskRevision(session.cliTaskRevisionId)
        : null;
      const openCodeProcessPid = runtime.id === "cli:opencode"
        ? (await cliVpnSessionPidResolver([session])).get(session.sessionId) ?? null
        : null;
      const openCodeNativeSessionId = runtime.id === "cli:opencode"
        ? taskRevision?.nativeTaskRef
          ?? await readOpenCodeNativeSessionId(session.sessionId)
          ?? (openCodeProcessPid
            ? await readOpenCodeNativeSessionIdFromProcessTree(openCodeProcessPid)
            : null)
        : null;
      if (runtime.id === "cli:opencode" && !openCodeNativeSessionId) {
        throw new SpaceConflictError(
          `OpenCode session ${session.sessionId} has no exact native task reference; it was preserved instead of opening a blank VPN replacement.`
        );
      }
      if (openCodeNativeSessionId && session.cliTaskRevisionId) {
        await store.updateCliTaskRevision(
          session.cliTaskRevisionId,
          { nativeTaskRef: openCodeNativeSessionId },
          traceId
        );
      }
      return cliTerminalManager.replaceSessionForPolicyRestart(
        session.sessionId,
        runtime,
        traceId,
        async () => {
          await store.updatePaneCliSession(
            session.sessionId,
            {
              status: "EXITED",
              statusReason: "CLI session restarted by explicit VPN routing request.",
              isActive: false,
              endedAt: nowIso()
            },
            traceId
          );
          const replacementSessionId = makeSpaceId("cli_session");
          const allocatedAtNs = process.hrtime.bigint();
          const replacement = await store.createPaneCliSession(
            {
              sessionId: replacementSessionId,
              paneId: session.paneId,
              roomId: session.roomId,
              runtimeId: session.runtimeId,
              providerId: session.providerId,
              agentId: session.agentId,
              modelId: session.modelId,
              reasoningEffort: session.reasoningEffort,
              launchMode: openCodeNativeSessionId ? "RESUME" : "FRESH",
              cwd: session.cwd,
              codexThreadId: null,
              cliTaskId: session.cliTaskId,
              cliTaskRevisionId: session.cliTaskRevisionId,
              status: "IDLE",
              statusReason: openCodeNativeSessionId
                ? "OpenCode task allocated for exact native resume through VPN; waiting for terminal transport attach."
                : "CLI session allocated for VPN routing; waiting for terminal transport attach."
            },
            traceId
          );
          cliTerminalManager.recordSessionAllocation(replacement.sessionId, allocatedAtNs);
          await store.appendPaneCliTranscriptChunk(
            {
              sessionId: replacement.sessionId,
              paneId: replacement.paneId,
              roomId: replacement.roomId,
              sequence: 0,
              stream: "system",
              content: openCodeNativeSessionId
                ? `${runtime.displayName} task resumed exactly through the protected VPN route.`
                : `${runtime.displayName} session restarted by explicit VPN routing request.`
            },
            traceId
          );
          return replacement;
        }
      );
    });
  cliRuntimeRegistryCache = createCliRuntimeRegistryCache(config, { probeCredentialStatus: publicCredentialHost?.status, credentialGeneration: publicCredentialHost?.generation });
  // 4/11: after each restart every pane's GET cli/session waited ~4 s on the first discovery (its slowest credential probe);
  // it starts now and onReady waits for it, so no request meets a cold registry.
  const registryWarm = cliRuntimeRegistryCache.read().catch(() => undefined);
  setupConnections =
    options.setupConnections ??
    createSetupConnectionsService({
      store,
      discoverRuntimes: async () => {
        cliRuntimeRegistryCache.invalidate();
        return cliRuntimeRegistryCache.read();
      },
      observeCredential: (runtime) => observeCliRuntimeCredential(runtime, publicCredentialHost?.execute),
      checkCredential: (runtime) => checkCliRuntimeCredential(runtime, publicCredentialHost?.execute)
    });
  const setupConnectionCheckRuns =
    options.setupConnectionCheckRuns ??
    new SetupConnectionCheckRunManager({
      store,
      setupConnections
    });
  const assertCliHttpMutationControl = async (
    request: FastifyRequest,
    session: PaneCliSession
  ): Promise<void> => {
    const authority = parseCliHttpControlAuthority(request);
    const activeLease = await store.getActivePaneCliTerminalControlLease(session.sessionId);
    if (!activeLease && !authority) return;
    if (
      !activeLease ||
      !authority ||
      authority.leaseId !== activeLease.leaseId ||
      authority.browserClientId !== activeLease.browserClientId ||
      authority.tabLineageId !== activeLease.tabLineageId ||
      authority.pageClientId !== activeLease.pageClientId ||
      request.user?.id !== activeLease.userId
    ) {
      throw new CliTerminalControlRequiredError();
    }
  };
  let codexMasterRoomAgentStopper = options.codexMasterRoomAgentStopper ?? (async () => false);
  async function resumeReopenedCliPane(pane: Pane, traceId: string): Promise<boolean> {
    if (pane.isClosed || (pane.mode !== "TERMINAL" && pane.mode !== "JOB_APPLY") || !pane.terminalRuntimeId || pane.terminalRuntimeId === "cli:root") return false;
    const active = await store.getActivePaneCliSession(pane.id);
    if (active?.isActive && active.status !== "EXITED" && active.status !== "ERROR") return false;
    const task = await unifiedCliTaskRegistry.findLatestTaskForPane(pane.id, await visibleCliRuntimeIds());
    if (!task || task.runtimeId !== pane.terminalRuntimeId) return false;
    await resumePaneCliTask(pane, { taskId: task.taskId }, traceId, undefined, true);
    return true;
  }
  /** Tasks a new Job Copilot pane is taking over right now: two panes never continue one conversation at once. */
  const jobCopilotTasksResuming = new Set<string>();
  /** A new Job Copilot pane continues the terminal session of the newest closed Job Copilot pane of its room. */
  async function resumePreviousJobCopilotSession(pane: Pane, traceId: string): Promise<boolean> {
    if (pane.isClosed || pane.mode !== "JOB_APPLY" || !pane.terminalRuntimeId) return false;
    const previous = await previousCopilotPane(pane);
    if (!previous || previous.terminalRuntimeId !== pane.terminalRuntimeId) return false;
    // The task of its latest session: an older task of that pane may have been continued elsewhere already.
    const taskId = (await store.listPaneCliSessions(previous.id, 1))[0]?.cliTaskId;
    if (!taskId || jobCopilotTasksResuming.has(taskId)) return false;
    jobCopilotTasksResuming.add(taskId);
    try {
      // Continued by another pane meanwhile: that pane owns the conversation now.
      const task = await unifiedCliTaskRegistry.getTask(taskId, await visibleCliRuntimeIds());
      if (task.session.paneId !== previous.id) return false;
      await resumePaneCliTask(pane, { taskId }, traceId, undefined, true);
      return true;
    } finally {
      jobCopilotTasksResuming.delete(taskId);
    }
  }
  const cliPaneReopener = createCliPaneReopener({
    resume: resumeReopenedCliPane,
    onResumeError: (paneId, error) => app.log.info(
      { event: "cli_pane.reopen_resume_skipped", paneId, reason: error instanceof Error ? error.message : "unknown" },
      "Reopened CLI pane kept its last session state; Reconnect remains available."
    )
  });
  const cliRuntimeVisibility = new CliRuntimeVisibilityPolicy({
    store,
    terminateSession: options.cliRuntimeSessionTerminator ?? ((sessionId, traceId) => cliTerminalManager.interrupt(sessionId, undefined, traceId)),
    interruptChatPane: options.codexMasterChatInterrupter ?? (async (paneId, reason) => {
      const pane = await store.getPane(paneId);
      await spaceAgentAdapter.interrupt({ pane, reason });
      const session = await store.getActiveSpaceAgentSession(paneId);
      if (!session) return true;
      const run = await store.getLatestSpaceAgentRun(session.sessionId);
      return !run || (run.status !== "QUEUED" && run.status !== "RUNNING");
    }),
    stopRoomAgentMission: (roomId, missionId, reason, traceId) =>
      codexMasterRoomAgentStopper(roomId, missionId, reason, traceId),
    killRuntimeProcesses: options.killRuntimeProcesses ?? ((runtimeId) => sweepRuntimeProcessesDefault(runtimeId)),
    countRuntimeProcesses: options.countRuntimeProcesses ?? ((runtimeId) => countRuntimeProcessesDefault(runtimeId)),
    publishEvent: (event) => eventBus.publish(event),
    restoreClosedPanes: createCliRuntimePaneRestorer({
      store,
      reopener: cliPaneReopener,
      publishEvent: (event) => eventBus.publish(event)
    })
  });
  // The visibility file lives in stable's state directory, which a dev instance only reads.
  if (config.instanceJobs["cli-runtime-visibility-file"]) void cliRuntimeVisibility.syncVisibilityFile();
  // The host stats and account usage providers: CLI hosts, Antigravity, Claude and the API providers (usage-providers-wiring.ts).
  // The gateway repository and admin service are declared below, so the providers get readers that look them up when they run.
  const { hostStatsProvider, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider } = createUsageProviders({ options, apiStartedAt,
    config, store, cliTerminalManager, readClaudeAccountProfileUsage, gatewayRepositoryFor: () => gatewayRepositoryFor(),
    resolveGatewayAdminService: () => resolveGatewayAdminService() });
  // One Space Gateway repository for the admin routes and, once Codex reads from the gateway, the quota views.
  // It is created before the Fastify app exists, so its pool is closed by the onClose hook added after the app is built.
  let sharedGatewayRepository: GatewayRepository | null = null;
  const gatewayRepositoryFor = (): GatewayRepository => {
    sharedGatewayRepository ??= store instanceof PostgresSpaceStore && config.databaseUrl
      ? PostgresGatewayRepository.fromConnectionString(config.databaseUrl, 2)
      : new InMemoryGatewayRepository();
    return sharedGatewayRepository;
  };
  const resolveGatewayAdminService = (): GatewayAdminService => gatewayAdminService!;
  const { gatewayCliAccounts, resolveCliSessionAccountProfile } = createCliSessionAccounts({
    store,
    gateway: { serves: (provider) => resolveGatewayAdminService().serves(provider) },
    pinnedDirect: (paneId) => claudeDirectPins.has(paneId)
  });
  const toolbarUsageProvider = options.toolbarUsageProvider ?? createGatewayCodexUsageProvider({ repository: gatewayRepositoryFor() });
  const taskTitleRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresTaskTitleRepository.fromConnectionString(config.databaseUrl)
    : new InMemoryTaskTitleRepository();
  const taskTitleProviders = new TaskTitleProviders({store,config,repository:taskTitleRepository,opencodeStateRoot:options.opencodeStateRoot,usage:toolbarUsageProvider});
  const taskTitles = new TaskTitleService({summaryAllowed:cliUserHosting.ownerModels.pane,nativeTitles:new NativeTaskTitles(async session=>(await cliTerminalManager.activeSessionPids([session])).get(session.sessionId)??null),store,repository:taskTitleRepository,providers:taskTitleProviders,codex:codexParity,eventBus,opencodeStateRoot:options.opencodeStateRoot,
    harness:{read:(paneId,sessionId)=>readHarnessTaskTitle(config,paneId,sessionId),rename:async(paneId,sessionId,title)=>renameHarnessTaskTitle(config,paneId,sessionId,title,(await store.getPane(paneId)).taskMetadata?.harnessSessionId)},
    resolveCodexThread:session=>resolvePaneCodexThreadId({store,session,traceId:makeSpaceId("trace"),findThreadId:options.findCodexThreadId}),
    readCodexName:async(sessionId,threadId)=>{
      const session=await store.getPaneCliSession(sessionId);
      return session ? (await codexSocketControlFactory(codexPrivateAppServerSocketPath(session)).getThreadName?.(threadId))??null : null;
    },
    renameCodex:async(sessionId,threadId,title)=>{
      const session=await store.getPaneCliSession(sessionId);
      if(session){
        const control=codexSocketControlFactory(codexPrivateAppServerSocketPath(session));
        if(control.renameThread){await control.renameThread({threadId,name:title});return;}
      }
      const renamed=await codexParity.renameThread(threadId,title);
      if(renamed.title!==title)throw new Error("Native title not confirmed");
    },
    readClaudeTitle:async session=>{
      const turns=await readClaudeLiveTurns(session);
      return turns?{nativeId:turns.nativeSessionId,title:turns.title??null,manual:turns.titleManual??false,
        requests:turns.tasks.map(task=>task.title).filter(title=>title!=="Background task notification").slice(-12)}:null;
    },
    artifactRoot:config.browserEvidenceArtifactRoot,
    onError:(error)=>app.log.warn({event:"task_titles.background_failed",failureCode:taskTitleFailureCode(error)},"Task metadata refresh deferred.")});
  taskTitleInputNotifier = (paneId) => taskTitles.notify(paneId);
  const stopTaskTitleEvents = eventBus.subscribe(event => {
    if(event.paneId && !["PANE_UPDATED","PANE_CLOSED"].includes(event.type))taskTitles.notify(event.paneId);
  });
  const codexResetCreditsService = options.codexResetCreditsService
    ?? createGatewayCodexResetCreditsService({ repository: gatewayRepositoryFor(), admin: { gatewayAdmin: (path, body) => resolveGatewayAdminService().gatewayAdmin(path, body) } });
  // The toolbar and system analytics: CLI session stats, system services, host memory, the session reaper and terminator, model stats,
  // the system analytics service and the OpenCode model bench with its daily refresh (system-analytics-wiring.ts).
  const { toolbarCliSessionStatsProvider, systemServicesProvider, toolbarHostMemoryProvider, toolbarCliSessionReaper, toolbarCliSessionTerminator,
    toolbarModelStatsCollector, systemAnalyticsService, opencodeModelBenchService } = createSystemAnalyticsServices({ options, config, store,
    cliTerminalManager, unifiedCliTaskRegistry, gatewayRepositoryFor, publicCredentialHost });
  // The system health: its history repository, the health monitor with every check, the system topology (system-health-wiring.ts).
  // The monitor logs a failed history sample through app.log; the app is created further down, so its log is read lazily.
  const { healthMonitor, systemTopologyService } = createSystemHealthServices({ app: { get log() { return app.log; } }, options, config, store, observability,
    workerReadinessChecker, storageReadinessChecker, cliTerminalManager, browserSessionManager });
  // The streaming services: the streaming bot service and the streaming service with its active-agent count (streaming-services-wiring.ts).
  const { streamingBotService, streamingService } = createStreamingServices({ options, config, store, readClaudeLiveTurns, cliTerminalManager });
  const toolbarKernelCacheReclaimer = options.toolbarKernelCacheReclaimer ?? runKernelCacheReclaim;
  const codexLbSpeedDefaultsService = createCodexLbSpeedDefaultsService({
    listModels: async () => {
      if (!codexAgentControl) throw new Error("Codex model catalog is unavailable.");
      return codexAgentControl.listModels();
    },
    // Space Gateway applies the speed map to Codex requests.
    store: {
      read: () => gatewayRepositoryFor().speedDefaults(),
      set: (modelId: string, tier: "standard" | "fast") => gatewayRepositoryFor().setSpeedDefault(modelId, tier)
    }
  });
  const codexLbSpeedDefaultsProvider = options.codexLbSpeedDefaultsProvider ?? codexLbSpeedDefaultsService.read;
  const codexLbSpeedDefaultUpdater = options.codexLbSpeedDefaultUpdater ?? codexLbSpeedDefaultsService.update;
  const codexHistoryPurgeService = options.codexHistoryPurgeService ?? createCodexHistoryPurgeService();
  const cliSessionCleanupService = options.cliSessionCleanupService ?? createCliSessionCleanupService();
  const codexHistoryAccessCoordinator = options.codexHistoryAccessCoordinator ?? createCodexHistoryAccessCoordinator();
  const sharedCliTaskPurgePreviews = new Map<string, {
    actorId: string;
    taskIds: string[];
    expiresAt: string;
  }>();
  const serviceRestarter = options.serviceRestarter ?? runCoreServiceRestart;
  const serviceRestartCooldownPath =
    options.serviceRestartCooldownPath ?? join(config.browserEvidenceArtifactRoot, "service-restarts", "core-restart-cooldown.json");
  const { findCodexThreadRuntimeSettings, waitForCodexThreadSettings } =
    createCodexThreadSettings({ store, findCodexThreadResumeSettings: options.findCodexThreadResumeSettings });
  const { loadNativeCliModels, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings } = createPaneCliModel({ store, cliTerminalManager,
    cliRuntimeRegistryCache, codexSessionSocketProbe, codexSocketControlFactory, findCodexThreadRuntimeSettings,
    findCodexThreadId: options.findCodexThreadId, findCodexModelControlThreads: options.findCodexModelControlThreads });
  const { resolveOpenCodeServerControl } = createOpenCodeServerControlResolver({ opencodeStateRoot: options.opencodeStateRoot });
  const { resolveChatOpenCodeCatalogControl, resolveChatPaneOpenCodeControl } =
    createOpenCodeChatControl({ opencodeStateRoot: options.opencodeStateRoot }, config, store);
  const { readPaneOpenCodeModelSettings, applyOpenCodePaneSelection } =
    createOpenCodePaneModel({ store, cliTerminalManager, resolveOpenCodeServerControl });
  const roomPlanInventoryProvider = options.roomPlanInventoryProvider ?? createRoomPlanInventoryProvider({
    store,
    findPlanState: (threadId) => findCodexCliPlanState({ codexHome: codexDirectParityCodexHome, threadId }),
    isCliRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.isEnabled(runtimeId)
  });
  let roomTaskEvaluatorKey: string | null = null;
  if (!options.roomTaskEvaluator && config.codexLbKeyFile) {
    try {
      roomTaskEvaluatorKey = (await readFile(config.codexLbKeyFile, "utf8")).trim() || null;
    } catch {
      roomTaskEvaluatorKey = null;
    }
  }
  const roomTaskEvaluator = options.roomTaskEvaluator ?? createRoomTaskEvaluator({
    baseUrl: config.codexLbBaseUrl,
    apiKey: roomTaskEvaluatorKey,
    model: "gpt-5.6-sol"
  });
  const { resumePaneCliTask } = createPaneCliResume({ store, eventBus, config, cliTerminalManager, cliRuntimeVisibility, unifiedCliTaskRegistry, visibleCliRuntimeIds,
    codexParity, codexHistoryAccessCoordinator, resolveCliSessionAccountProfile, findCodexThreadId: options.findCodexThreadId,
    // assertRoomAccess is declared further down; it is called only at request time.
    assertRoomAccess: (roomId, user) => assertRoomAccess(roomId, user) });

  // Room watchdog alerts: the room-hour line for Nous; the banner and URGENT card only for a room stuck 10 minutes (room-watchdog-notices.ts).
  const roomWatchdog = createRoomWatchdogNotices({ room: async (roomId) => Promise.resolve(store.getRoom(roomId)).catch(() => null), pane: async (paneId) => store.getPane(paneId), publish: (event) => eventBus.publish(event),
    notice: async (owner, key, line, soonMs) => { await nousRef.current?.service.notice(owner, key, line, undefined, soonMs ? { soonMs } : {}); }, warn: (meta, message) => app.log.warn(meta, message) });
  const { roomCliSession, roomCliObservationCache, inspectRoomCli, commandRoomCli } = createRoomCliControl({ store, reportWatchdog: (event) => roomWatchdog.report(event), cliTerminalManager, cliRuntimeRegistryCache,
    assertPaneCliRuntimeEnabled, readPaneCliModelSettings, readPaneOpenCodeModelSettings, resolveOpenCodeServerControl, readPaneNativeModelSettings, loadNativeCliModels,
    antigravityUsageProvider, recordClaudeNativeRef });
  const assertNoManagedModelMutation = (paneId: string) => assertUnmanagedPlanPane(store, paneId);
  const claudeAccountSwitchDeps: ClaudeAccountSwitchDeps = { store, inspect: (target) => inspectRoomCli(target, { fresh: true }), now: nowIso, interrupt: (id, traceId) => cliTerminalManager.interrupt(id, undefined, traceId),
    resume: (target, input, trace) => resumePaneCliTask(target, input, trace, undefined, true), ensureReady: (target, trace, selection) => cliTerminalManager.ensurePaneControlReady(target, trace, selection) };
  const roomPaneController = createRoomPaneCliController({ store, spaceAgentAdapter, config, cliTerminalManager, cliRuntimeVisibility, unifiedCliTaskRegistry,
    assertNoManagedModelMutation, claudeAccountSwitchDeps, inspectRoomCli, commandRoomCli, roomCliSession, roomCliObservationCache, readPaneCliModelSettings,
    readPaneNativeModelSettings, applyNativePaneModel, readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, resolveOpenCodeServerControl, resumePaneCliTask,
    waitForCodexThreadSettings });

  const assertPaneMayClose = marketingPaneCloseGuard(() => marketingCopilotService, (roomId) => roomOwner(roomId)); // operator rule 9/11
  const roomActionExecutor = options.roomActionExecutor ??
    createRoomActionExecutor({
      store, assertPaneMayClose,
      paneController: roomPaneController,
      control:async(roomId,tool,args,missionId)=>{
        const grant=await controlRepository.get("grant","shared",`room-agent:${roomId}`);
        const actorId=(grant?.value as {actorId?:string}|undefined)?.actorId;
        if(!actorId)throw new SpaceConflictError("Room Agent has no authenticated operator context.");
        const mission = missionId ? await store.getRoomAgentMission(roomId, missionId) : null;
        if (mission?.executionState.ownerId && mission.executionState.ownerId !== actorId) {
          throw new SpaceConflictError("Mission operator context changed. Control cannot run as another operator.");
        }
        if(typeof args.roomId!=="string")throw new SpaceConflictError("A target room is required.");
        // The tool catalog is not room-scoped; its strict schema rejects a roomId.
        const {roomId:_catalogRoomId,...catalogArgs}=args;
        return spaceControlRoutes.call(await controlUser(actorId),tool,tool==="space_list_mcp_tools"?catalogArgs:args);
      },
      enqueueAction: roomAgentWorkflow.enqueueAction?.bind(roomAgentWorkflow),
      cliTerminalManager,
      spaceAgentAdapter,
      browserSessionManager,
      roomPlanInventoryProvider,
      taskEvaluator: roomTaskEvaluator,
      isCliRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.isEnabled(runtimeId),
      assertCliRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.assertEnabled(runtimeId),
      decisionsService
    });
  const worktreeService = new WorktreeService();
  const roomPaneCommands = createRoomPaneCommands({
    store,
    worktreeService,
    // Fast path: use cached registry (10s TTL + stale-while-revalidate) instead of
    // fresh discoverAgentRuntimes per bulk open, so 16x codex stays in the 2-3s budget.
    discover: (fresh) => fresh ? cliRuntimeRegistryCache.readFresh() : cliRuntimeRegistryCache.readStaleWhileRefreshing(),
    enabledRuntimeIds: () => cliRuntimeVisibility.enabledRuntimeIds(),
    harnessAvailable: async () => {
      const status = await readDeepSeekHarnessMaintenanceStatus();
      return status.enabled && status.effectiveMode !== "BLOCKED";
    },
    checkGeminiQuota: async () => {
      const usage = await antigravityUsageProvider().catch(() => null);
      if (!usage?.data || usage.data.length === 0 || usage.error) {
        return { allowed: true, reason: "Quota check deferred (telemetry unavailable)." };
      }
      const hasQuota = usage.data.some((a) => {
        if (a.status !== "CONNECTED") return false;
        const rem5h = a.gemini?.fiveHourRemainingPercent;
        const remWeekly = a.gemini?.weeklyRemainingPercent;
        const rem5hOk = rem5h === null || rem5h > 0;
        const remWeeklyOk = remWeekly === null || remWeekly > 0;
        return rem5hOk && remWeeklyOk;
      });
      return { allowed: hasQuota, reason: hasQuota ? "Quota available" : "No Google account has available Gemini quota." };
    }
  });

  const roomQuickActions = createRoomQuickActions({ store,
      assertRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.assertEnabled(runtimeId),
      navigate: async (pane, url, traceId, actor) => {
        if (!(await browserSessionManager.getActive(pane))) {
          const userId = actor?.holderId ?? "operator:unknown";
          const resolved = await resolvePaneBrowserAccount(userId, pane);
          const { account, profileKey, sharedProfileKey } = actor?.holderType === "OPERATOR" ? await adoptPaneSignIn(userId, pane, resolved, actor) : resolved;
          const opened = await browserSessionManager.startOrRestore({ pane, targetUrl: url, traceId, includeInitialFrame: false,
            profileKey: account ? null : profileKey,
            ...(!account && sharedProfileKey ? { sharedProfileKey } : {}),
            ...(account ? { googleAccount: { ownerUserId: account.ownerUserId, accountId: account.id } } : {}) }, actor);
          if (opened.session.currentUrl === url) return;
        }
        await browserSessionManager.navigate(pane, url, traceId, actor);
      },
      publish: async (roomId) => { const event = await getLatestRoomEvent(store, roomId); if (event) eventBus.publish(event); }
    });
  const controlRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresControlRepository.fromConnectionString(config.databaseUrl) : new InMemoryControlRepository();
  async function controlUser(id: string, verifiedEmail?: string) {
    const user = await store.getControlActor(id, verifiedEmail);
    if (!user || (user.role !== "ADMIN" && user.role !== "USER") || user.automationScope) throw new SpaceConflictError("Control actor is no longer an authorized user.");
    return user;
  }
  async function controlInvoke(actorId: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
    const user = await controlUser(actorId);
    const token = signSession(user, auth.sessionSecret);
    const response = await app.inject({method,url,headers:{cookie:`${cookieName}=${token}`,[spaceControlInvokeHeader]:"1",
      [csrfHeaderName]:createCsrfToken(token,auth.sessionSecret)!,...(payload===undefined?{}:{"content-type":"application/json"})},
      ...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
    const body = response.headers["content-type"]?.includes("application/json") ? response.json() : {content:response.body.slice(0,100_000),mimeType:response.headers["content-type"]};
    if(response.statusCode>=400)throw new SpaceConflictError(body.error?.message??"Protected control failed.");
    return body;
  }
  const controlCliRooms = new WeakMap<FastifyRequest,string>();
  const { controlQuota, controlSend } = createSpaceControlPaneActions({ store, cliTerminalManager, spaceAgentAdapter, antigravityUsageProvider, inspectRoomCli,
    roomCliSession, roomCliObservationCache, readPaneCliModelSettings, resolveOpenCodeServerControl,
    // Declared further down; the actions read them only when they run.
    dashboardAgentsCache: { delete: (roomId) => dashboardAgents.invalidate(roomId) }, nousRef: { get current() { return nousRef.current; } },
    roomOwner: (roomId) => roomOwner(roomId) });
  const { openControlPanes } = createSpaceControlPanesOpen({ store, cliTerminalManager, cliRuntimeRegistryCache, cliRuntimeVisibility, gatewayCliAccounts,
    antigravityUsageProvider, roomPaneCommands, controlSend,
    // Declared further down; panes.open saves a YouTube pane's video only when it runs.
    youtubePlaybackStore: { save: (userId, paneId, input) => youtubePlaybackStore.save(userId, paneId, input) } });
  const { inspectControlSection } = createSpaceControlInspectSections({ store, config, controlUser, controlQuota, antigravityUsageProvider,
    toolbarUsageProvider, healthMonitor, taskTitleRepository,
    // Declared further down (spaceControl is the result of the call that takes this); read only when a section is inspected.
    readCliVpnApplications: (settings) => readCliVpnApplications(settings), spaceControl: { layout: (roomId) => spaceControl.layout(roomId) } });
  const { controlIntegration } = createSpaceControlIntegration({ store, config, eventBus, browserSessionManager, controlRepository, cliRuntimeVisibility,
    controlUser, controlInvoke, openControlPanes,
    // Declared further down; read only when an integration action runs.
    vault: { protection: { ownerOf: (paneId) => vault.protection.ownerOf(paneId), release: (paneId, opts) => vault.protection.release(paneId, opts) } },
    spaceControl: { inspect: (actor, input) => spaceControl.inspect(actor, input) } });
  const controlPaneReaders = createControlPaneReaders({
    store, roomPaneCommands, cliTerminalManager, antigravityUsageProvider, cliRuntimeRegistryCache,
    loadNativeCliModels, resolveOpenCodeServerControl,
    youtubePlaybackStore: { getByPaneId: paneId => youtubePlaybackStore.getByPaneId(paneId) }
  });
  const readCliDashboardActivity = createCliDashboardActivityReader({
    screenText: async session => (await cliTerminalManager.observeRoomScreen(session.sessionId)).text, observedModel: (session, modelId) => void Promise.resolve(store.updatePaneCliSession(session.sessionId, { modelId })).catch(() => undefined),
    codexTurn: session => cliTerminalManager.getCurrentTurnActivity(session.sessionId),
    openCode: async session => {
      const control = await readOpenCodeServerControl(session.sessionId, options.opencodeStateRoot ?? opencodeDirectParityRoot + "/state");
      if (!control) return null;
      if (!control.directory && session.cwd) control.directory = session.cwd;
      const busy = await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId, session.cwd ?? undefined).catch(() => false);
      return { busy, messages: () => fetchOpenCodeSessionMessages(control, control.nativeSessionId, 2).catch(() => []) };
    },
    geminiTurns: async session => {
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const native = await loadGeminiNativeTurns({ paneId: session.paneId, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null }).catch(() => null);
      return native && native.turns.length > 0 ? native.turns : null;
    },
    claude: readClaudeLiveTurns
  });
  const dashboardAgents = createDashboardAgentsReader(async (roomId: string): Promise<DashboardAgentsSample> => {
    const data = (await store.listPanes(roomId)).filter(pane => !pane.isClosed);
    const { activity, details } = await readDashboardActivity(data, store, readCliDashboardActivity);
    if (Object.values(details).some((detail) => detail?.status === "done")) installTelemetry.firstAnswer.observe();
    return { data, activity, details, sampledAt: nowIso() };
  });
  const readDashboardAgents = dashboardAgents.read;
  const roomAgentSnapshots = createRoomAgentSnapshotProvider({ listPanes: async roomId => store.listPanes(roomId), readActivity: readDashboardAgents });
  // A rail-tab CLI pane's headless start and whether its session record has a live host process (Space Control and Nous).
  const railCli = { start: (pane: Pane) => roomPaneController.start(pane, makeSpaceId("trace")), hostRunning: async (session: PaneCliSession) => (await cliTerminalManager.activeSessionPids([session]).catch(() => new Map())).has(session.sessionId), gatewayAccount: async (pane: Pane) => pane.terminalRuntimeId && !(await claudeDirectPins.has(pane.id)) ? gatewayCliAccounts.newPaneProfileId(pane.terminalRuntimeId) : null };
  const spaceControl = createSpaceControl({store,repository:controlRepository,controller:roomPaneController,decisionsService,phase:2,pluginsService,queueDisconnected:true,
    startRailCli: (actor, pane) => startPaneCli({ invoke: controlInvoke, store, ...railCli }, actor.id, pane), promptNotReady: async (pane) => cliPromptNotReady(cliTerminalManager, await store.getActivePaneCliSession(pane.id)),
    captureScreenshot: process.env.VITEST === "true" ? undefined : createControlScreenshotCapture({ instance: config.instance, cookieName, sessionSecret: auth.sessionSecret, artifactRoot: config.browserEvidenceArtifactRoot, resolveUser: controlUser, createArtifact: async (input) => store.createArtifact(input),
      fitTerminals: createCaptureTerminalFit({ getRoom: async (id) => store.getRoom(id), getPane: async (id) => store.getPane(id),
        fitPaneTerminal: (paneId, cols, rows) => cliTerminalManager.fitPaneTerminal(paneId, cols, rows), recordAuditEvent: async (input) => store.recordAuditEvent(input) }) }),
    publish:async roomId=>{const event=await getLatestRoomEvent(store,roomId);if(event)eventBus.publish(event);},
    publishEvent: (event) => eventBus.publish(event),
    reportWatchdog: (event) => roomWatchdog.report(event), settledLate: (outcome) => void roomWatchdog.lateDelivery(outcome),
    resolveActor: controlUser,
    checkQuota:controlQuota,
    requireClientAcknowledgement:true,
    ...controlPaneReaders,
    // Generic browser evidence opens an anonymous page and does not verify the
    // selected room. Do not expose it as an authenticated Control screenshot.
    // A future adapter must use the existing authenticated evidence boundary.
    closePane: async(actor,pane,traceId)=>{
      if(pane.mode==="CHAT"){
        try{await roomPaneController.interrupt(pane,traceId);}catch(e){}
      }
      return controlInvoke(actor.id,"DELETE",`/api/panes/${encodeURIComponent(pane.id)}`);
    },
    send: controlSend,
    integration: controlIntegration,
    inspectExtra: inspectControlSection
  });
  const roomAgentMonitorRepository = options.roomAgentMonitorRepository ?? (store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresRoomAgentMonitorRepository.fromConnectionString(config.databaseUrl) : new InMemoryRoomAgentMonitorRepository());
  const publishLatestRoomEvent = async (roomId: string) => { const event = await getLatestRoomEvent(store, roomId); if (event) eventBus.publish(event); };
  const roomRoutedActions = createRoomRoutedActions({
    panes: roomPaneCommands, quick: roomQuickActions,
    control:async(roomId,command,requestId,actor)=>{
      if(actor?.holderType!=="OPERATOR")throw new SpaceConflictError("Authenticated operator required.");
      const user=await controlUser(actor.holderId);
      const operation=await spaceControl.execute(user,{roomId,requestId,actions:command.actions});
      const complete=operation.status==="COMPLETED";
      return {summary:complete?`Completed ${operation.results.length} controls.`:operation.status==="RUNNING"?"Control is running. Waiting for confirmation.":operation.results.map(r=>r.detail).join("\n"),
        operationId:operation.id,pending:operation.status==="RUNNING",failed:!["COMPLETED","RUNNING"].includes(operation.status)};
    },
    publish: publishLatestRoomEvent
  });
  const roomAgentModelSelection = createCachedModelSelection({ codexLbBaseUrl: config.codexLbBaseUrl, codexLbKeyFile: config.codexLbKeyFile });
  const roomCoordination = createRoomCoordination({ store, controlRepository, deployQueueRoot: options.deployQueueRoot,
    devQueueRoot: options.releasesOptions?.devQueueRoot, describeRoom: (roomId) => roomAgentService.describeRoom(roomId) });
  // The Room Agent's tools act as the operator through the same Space Control, pane controller and room commands as Live.
  const roomAgentTools = createRoomAgentTools({
    listPanes: async (roomId) => store.listPanes(roomId, true),
    describeRoom: roomCoordination.describeRoom, releaseTrain: roomCoordination.releaseTrain,
    inspectPane: (pane) => roomPaneController.inspect(pane, { fresh: true }),
    interruptPane: (pane, traceId) => roomPaneController.interrupt(pane, traceId),
    answerCli: (pane, input, traceId) => commandRoomCli(pane, input.key
      ? { type: "cli_command", paneId: pane.id, expectedSessionId: input.sessionId, key: input.key, when: "NOW" }
      : { type: "cli_command", paneId: pane.id, expectedSessionId: input.sessionId, answer: input.answer, submit: input.submit,
        ...(input.expectedPromptFingerprint ? { expectedPromptFingerprint: input.expectedPromptFingerprint } : {}), when: "NOW" }, traceId),
    controlExecute: async (actorId, command) => spaceControl.execute(await controlUser(actorId), controlExecuteSchema.parse(command)),
    controlCall: async (actorId, tool, args) => spaceControlRoutes.call(await controlUser(actorId), tool, args),
    openPanes: async ({ roomId, actorId, requestId, traceId, counts }) => {
      const result = await roomPaneCommands.execute(roomId, actorId, { requestId, catalogVersion: PANE_CATALOG_VERSION,
        action: { type: "OPEN_PANES", counts: paneCountsSchema.parse(counts) } }, traceId);
      await publishLatestRoomEvent(roomId);
      return result.data.map((pane) => pane.paneName ?? pane.title);
    },
    search: async ({ roomId, actorId, requestId, traceId, query, engine, paneId }) => (await roomRoutedActions(roomId,
      { type: "SEARCH", query, engine, ...(paneId ? { paneId } : {}) }, requestId, traceId, { holderType: "OPERATOR", holderId: actorId })).summary,
    monitor: {
      listEvents: (roomId, eventOptions) => roomAgentMonitorRepository.listEvents(roomId, eventOptions),
      updateEvent: (eventId, patch, from) => roomAgentMonitorRepository.updateEvent(eventId, patch, from),
      changed: (event) => roomAgentMonitorOnEvent(event)
    }
  });
  const roomAgentChat = createRoomAgentChat({
    store,
    publish: (event) => eventBus.publish(event),
    tools: roomAgentTools,
    describeRoom: roomCoordination.describeRoom,
    snapshot: (roomId) => roomAgentService.snapshot(roomId),
    paneTypes: async () => (await roomPaneCommands.catalog()).filter((entry) => entry.available).map((entry) => entry.definition.typeId),
    modelSelection: roomAgentModelSelection,
    model: options.roomAgentChatModel ?? createGatewayChatModel({ baseUrl: config.codexLbBaseUrl, keyFile: config.codexLbKeyFile }),
    textModel: options.roomAgentChatModel ?? createOpenCodeTextModel({ run: runOpenCode }),
    log: { warn: (details, message) => app.log.warn(details, message) }
  });
  const roomAgentService = createRoomAgentService({
    store,
    workflow: roomAgentWorkflow,
    missionStopper: roomActionExecutor,
    roomPlanInventoryProvider,
    codexLbBaseUrl: config.codexLbBaseUrl,
    codexLbKeyFile: config.codexLbKeyFile,
    modelSelection: roomAgentModelSelection,
    chat: roomAgentChat, chatAllowed: cliUserHosting.ownerModels.room,
    snapshotProvider: roomAgentSnapshots,
    monitorRepository: roomAgentMonitorRepository,
    refreshControlReceipts:async(roomId)=>{
      for(const record of await controlRepository.list("operation",null,roomId)){
        const operation=controlOperationSchema.parse(record.value);
        if(operation.status==="RUNNING")continue;
        const request=await store.getRoomAgentRequest(roomId,operation.requestId);
        if(!request||request.missionId)continue;
        const ok=operation.status==="COMPLETED";
        await store.updateSpaceAgentMessage(request.responseMessageId,{status:ok?"COMPLETED":"FAILED",
          content:ok?`Completed ${operation.results.length} controls.`:operation.results.map(r=>r.detail).join("\n")},undefined,"RUNNING");
      }
    },
    executeQuickCommand: roomQuickActions,
    executeRoutedCommand: roomRoutedActions
  });

  // Stored events are durable room events, so every API process and the docks of other tabs see them.
  // Space notifications: one record per thing a pane or service wants the operator to see, fanned out to the
  // channels the owner turned on (in-app, desktop, Telegram, push). Panes raise them through the service; room events
  // from the browser host and the watchdog are bridged below.
  const notificationsRepository = options.notificationsRepository ?? (store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresSpaceNotificationsRepository.fromConnectionString(config.databaseUrl) : new InMemorySpaceNotificationsRepository());
  const nousRef: { current: NousWiring | null } = { current: null };
  const notificationService = createNotificationService({
    repository: notificationsRepository, eventBus, translate: createCardTranslator({ baseUrl: config.codexLbBaseUrl, keyFile: config.codexLbKeyFile }),
    nous: { held: async (owner) => Boolean(await nousRef.current?.active(owner)), raised: (notification) => nousRef.current?.notification(notification), holdsCopilotQuestions: async (owner) => Boolean(await nousRef.current?.holdsCopilotQuestions(owner)), coversApproval: async (owner) => Boolean(await nousRef.current?.coversApproval(owner)), autoAnswer: async (record) => await nousRef.current?.autoAnswer(record) ?? null, recommend: async (card) => await nousRef.current?.recommend(card) ?? null, annotate: async (owner, text) => await nousRef.current?.fileMentions.annotate(owner, text) ?? text, agentFiles: async (owner) => await nousRef.current?.fileMentions.files(owner) ?? [] },
    userSettings: (userId) => Promise.resolve(store.getUserSettings(userId)),
    recordRoomEvent: (input) => Promise.resolve(store.recordRoomEvent(input)),
    push: options.notificationPush !== undefined ? options.notificationPush : await loadFcmServiceAccount(config.fcmServiceAccountFile).then((account) => account && createFcmSender(account)),
    log: { warn: (meta, message) => app.log.warn(meta, message) }
  });
  const notificationPrune = setInterval(() => { void notificationService.prune().catch((error: unknown) => app.log.warn({ err: error }, "Notification prune failed.")); }, 3_600_000);
  notificationPrune.unref();
  const stopMorningBatches = notificationService.startMorningBatches(async () => [...new Set((await store.listRooms()).map((room) => room.ownerUserId).filter((id): id is string => Boolean(id)))]);
  const roomOwner = async (roomId: string): Promise<string | null> => (await Promise.resolve(store.getRoom(roomId)).catch(() => null))?.ownerUserId ?? null;
  const stopNotificationProducers = roomWatchdog.bridge(eventBus, (input) => notificationService.raise(input));
  const roomAgentEventRouting = createRoomAgentEventRouting({ roomOwner, nousActive: async (owner) => Boolean(await nousRef.current?.active(owner)),
    notifications: notificationService, telegram: roomAgentMonitorRepository, events: roomAgentMonitorRepository, log: { warn: (details, message) => app.log.warn(details, message) } });
  const roomAgentMonitorOnEvent = async (event: RoomAgentEvent) => {
    nousRef.current?.monitorEvent(event);
    // Telegram and notifications for what needs the operator, or nothing while Nous works on the owner's behalf.
    await roomAgentEventRouting.route(event);
    const recorded = await store.recordRoomEvent({ roomId: event.roomId, paneId: event.paneId, turnId: null, traceId: makeSpaceId("trace"),
      type: "ROOM_AGENT_UPDATED", message: event.title, payload: { kind: "MONITOR_EVENT", eventId: event.eventId, eventKind: event.kind,
        severity: event.severity, status: event.status } });
    eventBus.publish(recorded);
  };
  const roomAgentAutopilot = createRoomAgentAutopilot({
    repository: {
      autopilotEnabled: async (roomId) => config.roomAgentAutopilotEnabled && roomAgentMonitorRepository.autopilotEnabled(roomId),
      updateEvent: (...args) => roomAgentMonitorRepository.updateEvent(...args),
      listEvents: (...args) => roomAgentMonitorRepository.listEvents(...args)
    },
    getPane: async (paneId) => store.getPane(paneId),
    inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }),
    answer: (pane, input) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: input.expectedSessionId,
      answer: input.answer, submit: input.submit, expectedPromptFingerprint: input.expectedPromptFingerprint, when: "NOW" }, makeSpaceId("trace")),
    complete: async (systemPrompt, content, traceId) => completeRoomAgentPrompt({ systemPrompt, content, codexLbBaseUrl: config.codexLbBaseUrl,
      codexLbKeyFile: config.codexLbKeyFile, modelSelection: await roomAgentModelSelection(), timeoutMs: 45_000, runOpenCode, traceId }),
    coordinate: (event) => roomCoordination.coordinate(event, { owner: roomOwner, chat: roomAgentChat, send: roomAgentService.send }),
    onEvent: (event) => roomAgentMonitorOnEvent(event),
    deferTo: async (event) => Boolean(await nousRef.current?.handles(event)),
    log: { warn: (details, message) => app.log.warn(details, message) }
  });
  const roomAgentMonitor = createRoomAgentMonitor({
    repository: roomAgentMonitorRepository,
    listRooms: async () => store.listRooms(),
    readActivity: (roomId, fresh) => { if (fresh) dashboardAgents.invalidate(roomId); return readDashboardAgents(roomId); },
    onEvent: (event) => roomAgentMonitorOnEvent(event),
    readOverlaps: roomCoordination.readOverlaps,
    onAttention: (event) => { void roomAgentAutopilot.handle(event); },
    onAttentionSweep: async (roomIds) => { await roomAgentAutopilot.sweep(roomIds); await roomAgentEventRouting.sweep(roomIds); },
    onActivity: (roomId) => eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId, paneId: null, turnId: null, workflowId: null,
      traceId: makeSpaceId("trace"), type: "ROOM_AGENT_UPDATED", message: "Pane activity changed.", payload: { kind: "PANE_ACTIVITY" }, createdAt: nowIso() })),
    log: { warn: (details, message) => app.log.warn(details, message) }
  });

  if (!options.codexMasterRoomAgentStopper) {
    codexMasterRoomAgentStopper = async (roomId, missionId, reason, traceId) => {
      await roomAgentService.stop(roomId, reason, traceId);
      const mission = await store.getRoomAgentMission(roomId, missionId);
      return mission?.status === "INTERRUPTED";
    };
  }

  function assertRootAdmin(request: FastifyRequest, runtimeId: string | null | undefined) {
    if (runtimeId !== "cli:root" || request.user?.role === "ADMIN") return;
    throw Object.assign(new Error("Root terminal access requires the ADMIN role."), { statusCode: 403 });
  }

  async function visibleCliRuntimeIds(): Promise<string[]> {
    return ["cli:root", ...await cliRuntimeVisibility.enabledRuntimeIds()];
  }

  async function assertPaneCliRuntimeEnabled(pane: Pane): Promise<void> {
    if (pane.mode === "TERMINAL" && pane.terminalRuntimeId) {
      await cliRuntimeVisibility.assertEnabled(pane.terminalRuntimeId);
    }
  }

  // Successful fast requests are the bulk of the journal (badge and dashboard
  // polls) and pushed everything else out within a day. Log only errors and
  // slow requests; SPACE_API_REQUEST_LOG=all restores Fastify's per-request lines.
  const app = Fastify({
    pluginTimeout: 120_000, // onReady under load (promote q-20261103-172721-9b35 crash-looped on the default 10 s); a hung hook still fails
    ...(process.env.SPACE_API_REQUEST_LOG === "all" ? {} : { logController: new QuietRequestLogController() }),
    requestIdHeader: false,
    genReqId: () => `req:${nanoid(12)}`,
    // Every request log line carries the W3C trace id next to reqId. The
    // context is created once per raw request and reused by onRequest.
    childLoggerFactory(logger, bindings, childOptions, rawRequest) {
      return logger.child({ ...bindings, w3cTraceId: traceContextForRawRequest(rawRequest).w3cTraceId }, childOptions);
    },
    // Loopback plus the reverse proxies named in SPACE_TRUSTED_PROXIES; forwarded IPs from every other remote remain untrusted.
    trustProxy: ["127.0.0.1", "::1", "::ffff:127.0.0.1", ...config.trustedProxies],
    logger: apiLoggerOptions(options.logStream)
  });
  // SEC-011: logouts and "log out everywhere" survive API restarts. Until the persisted revocations load,
  // every session is refused (fail closed, review 2026-10-16); loading is retried until it succeeds.
  const sessionRevocationRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresSessionRevocationRepository.fromConnectionString(config.databaseUrl) : null;
  let sessionRevocationRetry: NodeJS.Timeout | null = null;
  const attachSessionRevocations = async (): Promise<void> => {
    if (!sessionRevocationRepository) return;
    try {
      await defaultSessionRevocationStore.attachPersistence(sessionRevocationRepository);
    } catch (error) {
      app.log.error({ err: error, event: "session_revocations.load_failed" }, "Persisted session revocations could not be loaded; retrying.");
      sessionRevocationRetry = setTimeout(() => void attachSessionRevocations(), 5_000);
      sessionRevocationRetry.unref?.();
    }
  };
  await attachSessionRevocations();
  const persistRevocation = (pending: Promise<void>) => pending.catch((error: unknown) => {
    app.log.error({ err: error, event: "session_revocations.persist_failed" }, "A session revocation is effective now but was not persisted; retrying.");
    throw error;
  });
  reportCliTerminalManagerTelemetry = (telemetry) => {
    observability.observeCliTerminalEvent({
      source: "SERVER",
      event: telemetry.event,
      outcome: telemetry.outcome,
      reason: telemetry.reason
    });
    app.log.info(
      {
        event: "cli_terminal.lifecycle",
        source: "SERVER",
        eventType: telemetry.event,
        outcome: telemetry.outcome,
        reason: telemetry.reason,
        paneId: telemetry.paneId,
        roomId: telemetry.roomId,
        sessionId: telemetry.sessionId,
        runtimeId: telemetry.runtimeId,
        protocolVersion: telemetry.protocolVersion ?? null,
        clientMode: telemetry.clientMode ?? null,
        controlState: telemetry.controlState ?? null,
        socketCount: telemetry.socketCount,
        requestId: telemetry.requestId ?? null
      },
      "CLI terminal lifecycle event."
    );
  };
  reportEventSubscriberError = (error, event) => {
    app.log.error({ err: error, eventId: event.id, eventType: event.type }, "Space event subscriber failed.");
  };
  let artifactRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let appDiagnosticsRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let durableEventPollTimer: ReturnType<typeof setInterval> | null = null;
  let systemAnalyticsSampleTimer: ReturnType<typeof setInterval> | null = null;
  let systemAnalyticsRollupTimer: ReturnType<typeof setInterval> | null = null;
  let dbRetentionTimer: ReturnType<typeof setInterval> | null = null;

  async function runDurableEventPoll() {
    try {
      await durableEventRelay.poll();
    } catch (error) {
      app.log.error({ err: error }, "Durable event poll failed.");
    }
  }

  async function seedDurableEventRelay() {
    try {
      const latest = await store.listEventChanges({ afterSequence: null, sortOrder: "desc", limit: 1 });
      durableEventRelay.seed(latest[0]?.sequence ?? null);
    } catch (error) {
      app.log.error({ err: error }, "Durable event relay seed failed.");
    }
  }

  const { runArtifactRetentionSweep, runAppDiagnosticsRetentionSweep, executeDatabaseRetentionSweep } =
    createRetentionSweeps(app, { config, store, appDiagnosticsService });

  await app.register(cookie);
  await app.register(compress, {
    threshold: 1024,
    encodings: ["br", "gzip"]
  });
  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      fileSize: Math.max(imageArtifactMaxBytes, paneCliUploadMaxBytes, paneArtifactUploadMaxBytes, voiceTranscriptionMaxBytes, config.videoSourceMaxBytes) + 1,
      files: turnArtifactMaxCount + 1,
      fields: 4,
      parts: turnArtifactMaxCount + 5
    }
  });
  await app.register(rateLimit, {
    max: config.apiRateLimitMax,
    timeWindow: "1 minute",
    keyGenerator: (request) => (request.mobileDevice ? `mobile:${request.mobileDevice.id}` : requestIpForLog(request) ?? "unknown") // C4: per phone; the mobile gate ran first
  });
  const defaultRouteRateLimitOptions = {
    config: {
      rateLimit: {
        max: config.apiRateLimitMax,
        timeWindow: "1 minute"
      }
    }
  };
  const defaultWebsocketRateLimitOptions = {
    ...defaultRouteRateLimitOptions,
    websocket: true as const
  };
  await app.register(websocket, {
    options: {
      // Playwright injects its page utility script (hundreds of KB) over the CLI
      // browser CDP proxy; 64 KiB would close that socket with 1009.
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: {
        threshold: 1024
      }
    }
  });
  app.addContentTypeParser(
    /^video\/webm(?:\s*;\s*codecs=(?:vp8|vp9))?$/i,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  const sessionAccess = createSessionAccess({ store });
  // Connector tokens and copilot mailbox passwords: sealed with the dedicated connector key; older values open with the
  // secrets they were sealed with (SPACE_CONNECTOR_SECRET, else the session secret).
  const connectorCrypto = createConnectorCrypto({ key: readConnectorKey(config.connectorKeyFile), legacySecrets: [process.env.SPACE_CONNECTOR_SECRET, auth.sessionSecret] });
  const userRoleCache = sessionAccess.roleCache;

  app.addHook("onRequest", async (request, reply) => {
    observability.onRequest(request);
    request.requestIdForSpace = request.id;
    request.traceContext = traceContextForRawRequest(request.raw);
    requestTraceContexts.remember(request.id, request.traceContext);
    reply.header("x-request-id", request.id);
    const sessionUser = requestSessionUser(request, auth.sessionSecret);
    // A proof session the broker signed without a scope (before scopes existed, or MEDIA_CAPTURE's) counts as UI_PROOF.
    if (sessionUser?.id === "user:operator-proof" && !sessionUser.brokerScope) sessionUser.brokerScope = "UI_PROOF";
    // An agent's broker session reaches only the routes of its scope (packages/contracts/src/broker-scopes.ts), checked on
    // the route the router matched (an unmatched URL is refused); a read-only session writes nothing.
    if (sessionUser?.brokerScope && (!request.routeOptions.url
      || !brokerScopeAllows(sessionUser.brokerScope, request.method, `${request.routeOptions.url}?${new URLSearchParams(request.query as Record<string, string>)}`))) {
      return sendApiError(reply, 403, "BROKER_SCOPE_DENIED", "This agent session may not call this route.");
    }
    // Every read-only session writes nothing: the broker's proof sessions and the capture sessions space_screenshot signs
    // for its caller's own id (security addendum step 4). App Diagnostics sessions keep exactly their own diagnostics
    // writes; the APP_DIAGNOSTICS gate below allows those and refuses the rest.
    if (sessionUser?.proofScope === "READ_ONLY" && sessionUser.automationScope !== "APP_DIAGNOSTICS" && !["GET", "HEAD"].includes(request.method)) {
      return sendApiError(reply, 403, "READ_ONLY_SESSION", "This read-only session cannot change anything.");
    }
    // A used operator session slides to a fresh 30-day expiry; an older cookie moves to it on its next request
    // (security addendum step 12). Agent, proof and capture sessions are never renewed.
    if (sessionUser && !sessionUser.brokerScope && !sessionUser.proofScope && !sessionUser.automationScope) {
      const renewed = renewSessionIfDue(request.cookies[cookieName], auth.sessionSecret);
      if (renewed) reply.setCookie(cookieName, renewed, { httpOnly: true, secure: auth.secureCookies, sameSite: "lax", path: "/", maxAge: operatorSessionTtlSeconds });
    }
    if (sessionUser) {
      if (sessionUser.id === "user:operator-proof") {
        // It acts in the operator's rooms; the audit log still names the agent session (request-audit.ts).
        request.sessionPrincipal = sessionUser.id;
        await sessionAccess.actAsOperator(sessionUser, auth.operatorEmail);
      }
      const resolved = await sessionAccess.resolve(sessionUser, request.log);
      if (resolved) request.user = resolved;
    }
  });
  installMobileGate(app, { sessionSecret: auth.sessionSecret }); // A phone's channel session (ADR-013): right after the session, before any plugin's own hooks.
  app.addHook("onResponse", async (request, reply) => {
    observability.onResponse(request, reply);
  });

  // Count error responses by their stable code; payloads are never logged.
  app.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode >= 400) observability.observeErrorResponse(reply.statusCode, payload);
    return payload;
  });

  app.addHook("onClose", async () => {
    observability.close();
    if (sessionRevocationRetry) clearTimeout(sessionRevocationRetry);
    defaultSessionRevocationStore.detachPersistence();
    await sessionRevocationRepository?.dispose();
    await spaceControl.close();
    await workerReadinessChecker.dispose?.();
    stopTaskTitleEvents();
    await taskTitles.close();
    await canonicalSearch?.close();
    await memoryEmbeddingBackfill?.close();
    if (artifactRetentionTimer) clearInterval(artifactRetentionTimer);
    if (appDiagnosticsRetentionTimer) clearInterval(appDiagnosticsRetentionTimer);
    if (durableEventPollTimer) clearInterval(durableEventPollTimer);
    if (systemAnalyticsSampleTimer) clearInterval(systemAnalyticsSampleTimer);
    if (systemAnalyticsRollupTimer) clearInterval(systemAnalyticsRollupTimer);
    if (dbRetentionTimer) clearInterval(dbRetentionTimer);
    opencodeModelBenchService.stopDailyRefresh();
    stopTrackingPublishedEvents();
    await cliTerminalManager.closeAll();
    await browserSessionManager.closeAll();
    await appDiagnosticsService.dispose();
    await healthMonitor.dispose();
    await systemAnalyticsService.dispose();
    await streamingService.dispose();
    await demoProjectsService.dispose();
    defaultSessionRevocationStore.close();
  });

  app.addHook("onClose", async () => {
    await roomAgentChat.abortAll();
    roomAgentMonitor.stop();
    await roomAgentMonitorRepository.dispose();
  });

  app.addHook("onReady", async () => { await registryWarm; });
  app.addHook("onReady", async () => {
    // A dev instance starts from a copy of stable's data and must not replay its schedules and watches.
    if (config.instanceJobs["space-control-ticks"]) await spaceControl.start();
    if (config.roomAgentMonitorEnabled && (options.startRoomAgentMonitor ?? !options.store)) roomAgentMonitor.start();
    canonicalSearch?.start();
    memoryEmbeddingBackfill?.start();
    healthMonitor.start();
    if (options.agentToolsOptions?.rootWriterCommand) {
      // Not awaited: the root writer fsyncs, and a disk stall (VM backup, 3/11 promote q-20261103-141018-5a2a) must not hit the 10 s onReady limit.
      void projectRoutingState(store, options.agentToolsOptions).catch((error) => {
        app.log.warn({ err: error }, "Projecting routing state failed on startup; continuing.");
      });
    }
    await appDiagnosticsService.initialize();
    await streamingService.initialize();
    // Demo Projects initializes on first use; an optional feature must never block or crash API startup.
    appDiagnosticsRetentionTimer = setInterval(
      () => void runAppDiagnosticsRetentionSweep(),
      5 * 60 * 1000
    );
    appDiagnosticsRetentionTimer.unref();
    if (browserSessionManager.recoverCaptureJobs) {
      try {
        const recovery = await browserSessionManager.recoverCaptureJobs();
        if (recovery.failedSegments > 0 || recovery.requeuedJobs.length > 0) {
          app.log.info(recovery, "Browser capture startup recovery completed.");
        }
      } catch (error) {
        app.log.error({ err: error }, "Browser capture startup recovery failed.");
      }
    }
    try {
      const recovery = await roomAgentService.recoverPending(20);
      if (recovery.scanned > 0) {
        const log = recovery.failed > 0 ? app.log.warn.bind(app.log) : app.log.info.bind(app.log);
        log(recovery, "Room Agent startup recovery completed.");
      }
    } catch (error) {
      app.log.error({ err: error }, "Room Agent startup recovery failed.");
    }
    // Chat turns live in this process; an answer a stopped process left RUNNING ends as INTERRUPTED.
    try {
      const interrupted = await store.interruptRoomAgentChatTurns("\n\n(stopped: the server restarted)");
      if (interrupted > 0) app.log.info({ interrupted }, "Room Agent chat answers interrupted by the restart were closed.");
    } catch (error) {
      app.log.warn({ err: error }, "Room Agent chat recovery failed.");
    }
    await runArtifactRetentionSweep();
    artifactRetentionTimer = setInterval(() => void runArtifactRetentionSweep(), 15 * 60 * 1000);
    artifactRetentionTimer.unref();
    // A Chat run accepted in PostgreSQL whose Temporal workflow never started stays
    // QUEUED forever, and a RUNNING run whose workflow ended without an outcome stays
    // RUNNING. Fail both honestly (stranded-chat-runs.ts); never touch a run Temporal still runs.
    strandedRunTimer = setInterval(() => void sweepStrandedChatRuns().catch((error) =>
      app.log.warn({ err: error }, "Stranded Chat run sweep failed.")), 2 * 60 * 1000);
    strandedRunTimer.unref();
    await seedDurableEventRelay();
    durableEventPollTimer = setInterval(() => void runDurableEventPoll(), 1000);
    durableEventPollTimer.unref();
    if (store instanceof PostgresSpaceStore) {
      void taskTitles.start().catch(() => app.log.warn({event:"task_titles.start_failed"},"Task metadata startup deferred."));
    }
    // Like the model bench refresh, the default collectors do not scan the
    // host's processes and CLI history inside test runs (routes still sample
    // on demand); an injected analytics service keeps its schedule.
    if (options.systemAnalyticsService || (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true")) {
      void systemAnalyticsService.sample().catch((error) => {
        app.log.error({ err: error }, "Initial system analytics sample failed.");
      });
      systemAnalyticsSampleTimer = setInterval(
        () => void systemAnalyticsService.sample().catch((error) => app.log.error({ err: error }, "System analytics sample failed.")),
        10_000
      );
      systemAnalyticsSampleTimer.unref();
      systemAnalyticsRollupTimer = setInterval(
        () => void systemAnalyticsService.rollupAndSweep().catch((error) => app.log.error({ err: error }, "System analytics rollup failed.")),
        60_000
      );
      systemAnalyticsRollupTimer.unref();
      void systemAnalyticsService.backfill().catch((error) => {
        app.log.error({ err: error }, "System analytics backfill failed.");
      });
    }
    if (config.enableDbSweep && store instanceof PostgresSpaceStore) {
      void executeDatabaseRetentionSweep();
      dbRetentionTimer = setInterval(() => void executeDatabaseRetentionSweep(), 15 * 60 * 1000);
      dbRetentionTimer.unref();
    }
  });

  // USER accounts may only touch rooms they own and what is inside them, checked centrally for every route.
  // assertRoomAccess is declared further down; the hook runs after it exists.
  const assertOwnedRoomOrPaneRoute = createOwnedResourceGuard({
    assertRoomAccess: (roomId, user) => assertRoomAccess(roomId, user),
    paneRoomId: async (paneId) => (await getPaneById(store, paneId)).roomId,
    artifactRoomId: async (artifactId) => (await store.getArtifact(artifactId)).roomId,
    shareOf: roomShares.shareOf, paneOwner: roomShares.explicitPaneOwner
  });

  const publicBrowserOrigins = t3PublicOrigins(config.browserEvidenceTargetOrigin);
  app.addHook("preHandler", async (request, reply) => {
    if (publicPaths.has(request.routeOptions.url ?? request.url)) {
      return;
    }
    if (isInternalApiRequest(request)) {
      // Internal callers (worker, gateway) run on this host: the token alone never opens these routes from elsewhere
      // (security addendum step 9; request.ip is the real client behind the web proxy and nginx).
      if (isLoopbackRequest(request) && secureTokenMatches(config.internalApiToken, request.headers[internalTokenHeader])) {
        return;
      }
      const disabled = !config.internalApiToken;
      return sendApiError(
        reply,
        disabled ? 404 : 401,
        disabled ? "NOT_FOUND" : "INTERNAL_AUTH_REQUIRED",
        disabled ? "Internal API route is not available." : "Internal API authentication is required."
      );
    }
    if (requestRoutePath(request)==="/api/cli/control/mcp") {
      const claims=verifyControlToken(agentTokenSecret(config),request.headers[controlTokenHeader]);
      if(!claims)return sendApiError(reply,401,"CONTROL_TOKEN_INVALID","An active Space control token is required.");
      // A Harness agent acts for its open Harness pane (harness-agent-tokens.ts); every other token for its CLI session.
      if(isHarnessAgentSessionId(claims.cliSessionId)){
        if(!await harnessAgentPrincipal(store,claims))return sendApiError(reply,403,"CONTROL_SESSION_INACTIVE","The Harness pane is no longer eligible for control.");
      }else{
        const session=await store.getPaneCliSession(claims.cliSessionId);
        if(!session||!supportsControlRuntime({mode:"TERMINAL",terminalRuntimeId:session.runtimeId} as any)||!session.isActive||session.purpose!=="NORMAL"||session.roomId!==claims.roomId||session.paneId!==claims.paneId||["EXITED","ERROR"].includes(session.status))
          return sendApiError(reply,403,"CONTROL_SESSION_INACTIVE","CLI session is no longer eligible for control.");
      }
      const actorId=((await controlRepository.get("grant","shared",claims.roomId))?.value as {actorId?:string}|undefined)?.actorId;
      if(!actorId)return sendApiError(reply,403,"CONTROL_NOT_GRANTED","The operator has not enabled CLI control in this room. The operator turns it on by asking this room's Room Agent or Nous to allow CLI control (access.cli) and confirming.");
      if(!await cliUserHosting.controlActorAllowed(claims.paneId,actorId))return sendApiError(reply,403,"CONTROL_PANE_NOT_GRANTED","CLI control acts as the operator who allowed it, so it is not available in a pane another account opened.");
      request.user=await controlUser(actorId);controlCliRooms.set(request,claims.roomId);return;
    }
    if (isCliBrowserBridgeRequest(request)) {
      return;
    }
    const routePath = requestRoutePath(request);
    if (routePath.startsWith("/api/") && !request.user) {
      return sendApiError(reply, 401, "UNAUTHENTICATED", "Authentication is required.");
    }
    const refused = request.user?.role === "USER" ? await assertOwnedRoomOrPaneRoute(request, routePath) : null;
    if (refused) return sendApiError(reply, refused.status, refused.code, refused.message);
    if (
      request.user?.automationScope === "APP_DIAGNOSTICS" &&
      routePath.startsWith("/api/") &&
      !isAllowedAppDiagnosticsAutomationMutation(request)
    ) {
      return sendApiError(
        reply,
        403,
        "AUTOMATION_SCOPE_READ_ONLY",
        "App diagnostics automation cannot mutate this resource."
      );
    }
    if (request.user && requiresSameSiteBrowser(request, routePath) && isOtherSiteBrowserRequest(request, publicBrowserOrigins)) {
      // The page that was refused, so a client on an origin the API does not accept can be found (2026-10-19 403 loop).
      request.log.warn({ origin: String(request.headers.origin ?? "").slice(0, 200) || null, secFetchSite: request.headers["sec-fetch-site"] ?? null, route: routePath }, "origin rejected");
      return sendApiError(reply, 403, "ORIGIN_REJECTED", "Requests from another site cannot use this Space session.");
    }
    if (request.user && requiresCsrf(request)) {
      const submittedToken = request.headers[csrfHeaderName];
      if (!harnessSameOriginRequest(request, routePath) && !verifyCsrfToken(request.cookies[cookieName], submittedToken, auth.sessionSecret)) {
        return sendApiError(reply, 403, "CSRF_INVALID", "A valid CSRF token is required for this action.");
      }
    }
  });

  registerApiErrorHandler(app);

  // The platform routes: health, desktop releases, metrics, auth session, first setup, waitlist, app diagnostics settings, activity log (platform-routes-wiring.ts).
  const { setupOwnerVoiceRuntime, setupVoiceCredentials } = await registerPlatformRoutes(app, { apiStartedAt, config, appVersionReader, store, appDiagnosticsService,
    browserSessionManager, workerReadinessChecker, cliTerminalManager, defaultRouteRateLimitOptions, observability, auth, userRoleCache, options, publicCredentialHost,
    setupConnections, setupConnectionCheckRuns, streamingService, sourceControlService, visibleCliRuntimeIds, agentSessionHistoryService, healthMonitor,
    toolbarUsageProvider, antigravityUsageProvider, apiProviderAccountsProvider, installTelemetry, activityLogService });

  // The workspace tool routes: demo projects, T3 Code, games, Dots and Dot Home, plugins, source control, worktrees, Harness, files, databases (workspace-routes-wiring.ts).
  const { demoProjectsService } = await registerWorkspaceRoutes(app, { store, config, auth, options, appDiagnosticsService, claudeUsageProvider, cliChatRuntimeState,
    cliModelsExecutor, cliRuntimeRegistryCache, codexGoals, dotsRepository, dotMemoryRepository, dotHomeRepository, spaceAgentAdapter, sourceControlService,
    worktreeService, publicBrowserOrigins, defaultRouteRateLimitOptions });

  // Sign-in support, auth and admin user routes; then the user's own tool routes, the shared gateway repository's close between them (user-routes-wiring.ts).
  const { googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef } = registerSignInRoutes(app, { store, config, auth,
    browserSessionManager, persistRevocation, userRoleCache, nousRef, connectorCrypto, eventBus, notificationService, sessionAccess, defaultRouteRateLimitOptions, mailCopilotGoogle: options.mailCopilotGoogle, mailCopilotGmailFetch: options.mailCopilotGmailFetch, passwordResetMail: options.passwordResetMail, mailCampaigns: () => mailCampaignsService });

  app.addHook("onClose", async () => { await sharedGatewayRepository?.dispose(); });
  const { gatewayAdminService, reopenClosedPane, taskBrief } = registerUserToolRoutes(app, { store, config, options, auth, nousRef, cliTerminalManager, cliRuntimeVisibility,
    codexParity, unifiedCliTaskRegistry, agentSessionHistoryService, visibleCliRuntimeIds, hostStatsProvider, systemServicesProvider, installTelemetry,
    readDashboardAgents, gatewayRepositoryFor, roomPaneController, commandRoomCli, spaceControl, controlUser, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions, gatewayVaultKey: vaultKeyReader(store, () => vault) });

  // The room routes: room access, the room list, shares, proof rooms with their controllers, room management and its account stores (room-routes-wiring.ts).
  const { assertRoomAccess, youtubePlaybackStore, youtubeAccountStore, browserAccountStore } = registerRoomRoutes(app, { config, store, options, eventBus,
    activityLogService, browserSessionManager, cliRuntimeRegistryCache, cliRuntimeVisibility, cliTerminalManager, codexCliModeDefaultsService, controlQuota,
    controlSend, defaultRouteRateLimitOptions, inspectRoomCli, readDashboardAgents, roomPaneController, roomShares, visibleCliRuntimeIds, assertPaneMayClose });

  // The CLI routes: egress and VPN, runtimes, agent tools, release trains, CLI accounts, pane CLI and managed plans (cli-routes-wiring.ts).
  const { readDeepSeekHarnessMaintenanceStatus, readCliVpnApplications, openCliLogin } = registerCliRoutes(app, { store, config, options, auth, eventBus, observability,
    cliTerminalManager, cliRuntimeVisibility, cliRuntimeRegistryCache, cliUserHosting, roomShares, roomCoordination, controlRepository, controlUser,
    codexCliModeDefaultsService, codexSocketControlFactory, inspectRoomCli, readClaudeLiveTurns, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions,
    cliVpnBroker, deepSeekHarnessServiceController, cliVpnSessionPidResolver, cliVpnSessionRestarter, assertRootAdmin, assertPaneCliRuntimeEnabled,
    cliPaneReopener, cliAccountBalancer, assertRoomAccess, assertCliHttpMutationControl, waitForCodexThreadSettings, readPaneNativeModelSettings,
    applyNativePaneModel, readPaneCliModelSettings, resolveOpenCodeServerControl, readPaneOpenCodeModelSettings, applyOpenCodePaneSelection,
    assertNoManagedModelMutation, roomPaneController, removeGeminiAccountProfileState, removeClaudeAccountProfileState, removeCopilotAccountProfileState,
    removeCursorAccountProfileState, removeKimiAccountProfileState, deletingCliAccountProfileKeys, cliAccountProfileKey, readCliAccountProfileDetails,
    cliAccountIdentityCacheTtlMs, cliAccountIdentityCache, readCachedCliAccountIdentity, invalidateCliAccountIdentity, gatewayCliAccounts });

  // The pane routes: the pane stream routes, the pane browser accounts with their YouTube maps, the pane routes (pane-routes-wiring.ts).
  const { browserControlActivity, youtubeSessionStarts, youtubeAccountOperations, withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount,
    paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn, effectivePaneProfileId, previousCopilotPane, geminiAccountEmails,
    browserAccountChoices } = registerPaneRoutesWiring(app, { config, store, eventBus, browserSessionManager, cliTerminalManager, cliRuntimeVisibility,
    taskTitleRepository, taskTitleProviders, taskTitles, roomPaneCommands, spaceControl, roomAgentService, assertRootAdmin, defaultRouteRateLimitOptions,
    defaultWebsocketRateLimitOptions, assertRoomAccess, youtubePlaybackStore, readDeepSeekHarnessMaintenanceStatus, roomShares, cliPaneReopener,
    resumePreviousJobCopilotSession, nousRef, readClaudeLiveTurns, youtubeAccountStore, browserAccountStore, readCachedCliAccountIdentity,
    googleAccountBrowserStatuses, assertPaneMayClose });

  // The notification and copilot pane routes: Job and Mail Copilot, the notification routes and watches, the copilot-style panes (copilot-pane-routes-wiring.ts).
  const { jobApplyRepository, jobApplyService, mailCopilotService, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService,
    appStudioService, securityCopilotService, monitoringCopilotService, mailCampaignsService, videoService } = registerCopilotPaneRoutes(app, { store, config, auth,
    eventBus, options, defaultRouteRateLimitOptions, connectorCrypto, connectorServiceRef, notificationsRepository, notificationService, notificationPrune,
    stopMorningBatches, stopNotificationProducers, roomOwner, telegramIntegrationManager, roomPaneController, cliTerminalManager, assertRoomAccess, nousRef,
    railCli, controlInvoke, toolbarUsageProvider, reopenClosedPane, taskBrief,
    // The Vault is registered just below; Mail Campaigns reads its repository only per send.
    vault: { get repository() { return vault.repository; } } });
  // The browser routes: the Vault, the CLI browser bridge and CDP proxy, the census, pane browsers and their frames, agent actions, pane CLI sessions (browser-routes-wiring.ts).
  const { vault } = registerBrowserRoutes(app, { config, auth, store, eventBus, options, browserSessionManager, cliRuntimeVisibility, browserControlActivity, nousRef,
    defaultRouteRateLimitOptions, connectorCrypto, effectivePaneProfileId, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService, videoService,
    appStudioService, securityCopilotService, monitoringCopilotService, mailCampaignsService, jobApplyService, mailCopilotService, geminiAccountEmails,
    readGeminiAccountProfileDetails, youtubePlaybackStore, youtubeAccountStore, browserAccountStore, youtubeSessionStarts, youtubeAccountOperations, withYouTubeAccountLock,
    youtubeAccountOwner, selectedGoogleBrowserAccount, paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn, browserAccountChoices, previousCopilotPane,
    notificationService, roomActionExecutor, deletingCliAccountProfileKeys, cliAccountProfileKey, codexCliModeDefaultsService, spaceAgentAdapter, cliRuntimeRegistryCache,
    cliTerminalManager, assertCliHttpMutationControl, resolveOpenCodeServerControl, resumePaneCliTask, spaceControl, assertRootAdmin, assertPaneCliRuntimeEnabled,
    cliAccountBalancer, cliPaneReopener, claudeDirectPins, resolveCliSessionAccountProfile, cliUserHosting, loadNativeCliModels, vaultKeySaved: gatewayKeyJoiner(gatewayAdminService, app.log), vaultKeysReconcile: gatewayVaultKeyReconciler(gatewayAdminService, app.log) });

  // The Space Control routes, then the Dot Goals: repository, concurrent-task check, service and routes (space-control-dot-goals-wiring.ts).
  const { spaceControlRoutes, dotGoalsRepository, dotAtCapacity, dotGoalService } = registerSpaceControlAndDotGoalRoutes(app, { config, store, auth, options,
    spaceControl, controlCliRooms, controlUser, dotsRepository, spaceAgentAdapter, defaultRouteRateLimitOptions });
  let strandedRunTimer: NodeJS.Timeout | null = null;
  app.addHook("onClose", async () => { if (strandedRunTimer) clearInterval(strandedRunTimer); });
  // Session-level balancing: panes on Auto move to another account when theirs runs out.
  const cliAccountAutoSwitch = createCliAccountAutoSwitch({
    balancer: cliAccountBalancer,
    getPane: async (paneId) => { try { return await store.getPane(paneId); } catch { return null; } },
    activeSession: async (paneId) => (await store.getActivePaneCliSession(paneId)) ?? null,
    screenText: async (session) => (await cliTerminalManager.observeRoomScreen(session.sessionId)).text,
    restart: async (pane, session, profileId, launchMode, note) => {
      const traceId = makeSpaceId("trace");
      await cliTerminalManager.interrupt(session.sessionId, { content: note, traceId });
      await store.updatePaneCliSession(session.sessionId,
        { status: "EXITED", statusReason: "Account ran out of quota; Space moved the pane to another account.", isActive: false, endedAt: nowIso() }, traceId);
      await cliTerminalManager.ensurePaneControlReady(pane, traceId, { accountProfileId: profileId, launchMode });
    },
    log: (event, detail) => app.log.info({ event, ...detail }, "CLI account Auto")
  });
  // Operator order 2026-10-20: Claude panes at their account's usage limit move to Space Gateway and continue (claude-limit-move.ts).
  const claudeLimitMove = createClaudeLimitMove(claudeLimitMoveDeps({ store, monitor: roomAgentMonitorRepository, pinnedDirect: (paneId) => claudeDirectPins.has(paneId),
    inspect: (pane, fresh) => roomPaneController.inspect(pane, { fresh }), paneReports: () => nousRef.current?.paneReports, onEvent: roomAgentMonitorOnEvent, paceHolds: controlPaceHolds(controlRepository, async () => true), // nous_msg:3d047588 (7/11): no pace cap; a held pane gets continue once at once.
    gatewayProfileReady: async () => Boolean((await gatewayCliAccounts.gatewayProfile("cli:claude"))?.ready), gatewayAccounts: () => resolveGatewayAdminService().listAccounts(),
    switchAccount: async (pane, session, profile, options) => { const done = await switchClaudePaneAccount(claudeAccountSwitchDeps, pane, session, profile, makeSpaceId("trace"), options); roomCliObservationCache.delete(pane.id); return done; },
    notifications: notificationService, answer: (pane, input) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, ...input, when: "NOW" }, makeSpaceId("trace")),
    onAttention: (event) => { void roomAgentAutopilot.handle(event); }, log: (event, detail) => app.log.info({ event, ...detail }, "Claude usage limit move"), notice: async (owner, key, line) => { await nousRef.current?.service.notice(owner, key, line); } }));
  let cliAccountAutoSwitchTimer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
    cliAccountAutoSwitchTimer = setInterval(() => { void cliAccountAutoSwitch.tick(); void claudeLimitMove.tick(); }, 30_000);
    cliAccountAutoSwitchTimer.unref();
  });
  app.addHook("onClose", async () => { if (cliAccountAutoSwitchTimer) clearInterval(cliAccountAutoSwitchTimer); });
  // The Dot routes: the stranded Chat run sweep, the Dot services, channels and proactive notices, the Dot tool gateway (dot-routes-wiring.ts).
  const { sweepStrandedChatRuns, dotEvalsRepository } = registerDotRoutes(app, { config, store, options, auth, eventBus, cookieName, defaultRouteRateLimitOptions,
    dotsAuthenticatedOwner, dotsRepository, dotGoalsRepository, dotHomeRepository, dotGoalService, dotMemoryService, dotAtCapacity, autoRouteFactsLoader,
    browserSessionManager, browserAccountStore, youtubeAccountOwner, cliRuntimeVisibility, connectorCrypto, connectorServiceRef, connectorStateTools, roomPaneCommands,
    spaceAgentAdapter, spaceControl, controlUser, spaceControlRoutes, vault, designService, videoService,
    // Declared further down; read only when a Dot runs an MCP tool.
    executeMcpToolWithPolicy: (input, request) => executeMcpToolWithPolicy(input, request) });
  app.post("/api/control/v1/grant", defaultRouteRateLimitOptions, async request=>{
    if(!request.user||request.user.role!=="ADMIN"||request.user.automationScope)throw new SpaceConflictError("Only the operator may grant control access.");
    const input=z.object({roomId:z.string().min(1),enabled:z.boolean()}).strict().parse(request.body);
    await store.getRoom(input.roomId);const actor=await controlUser(request.user.id,request.user.email);
    const previous=await controlRepository.get("grant","shared",input.roomId);
    if(!await controlRepository.write({kind:"grant",actorId:"shared",key:input.roomId,roomId:input.roomId,version:(previous?.version??0)+1,value:{actorId:input.enabled?actor.id:null}},previous?.version??0))throw new SpaceConflictError("Control grant changed.");
    return {roomId:input.roomId,enabled:input.enabled};
  });

  registerRoomAgentRoutes(app, {
    store, controlRepository, controlUser, roomAgentService, chat: roomAgentChat, routeOptions: defaultRouteRateLimitOptions,
    monitor: { repository: roomAgentMonitorRepository, forget: (roomId) => roomAgentMonitor.forget(roomId), sentToNous: roomAgentEventRouting.sentToNous,
      changed: async (event) => roomAgentMonitorOnEvent(event),
      // The operator's own answer needs no guardrail: it is the operator's approval.
      answer: async (event, input) => {
        const pane = await store.getPane(event.paneId!);
        if (pane.roomId !== event.roomId || pane.mode !== "TERMINAL") throw new SpaceConflictError("Only CLI panes can be answered from the Room Agent.");
        const observed = await roomPaneController.inspect(pane, { fresh: true });
        if (!observed.sessionId) throw new SpaceConflictError("The pane has no running CLI.");
        await commandRoomCli(pane, input.decline
          ? { type: "cli_command", paneId: pane.id, expectedSessionId: observed.sessionId, key: "ESCAPE", when: "NOW" }
          : { type: "cli_command", paneId: pane.id, expectedSessionId: observed.sessionId, answer: input.answer!.trim(), submit: input.submit,
            ...(observed.promptFingerprint ? { expectedPromptFingerprint: observed.promptFingerprint } : {}), when: "NOW" }, makeSpaceId("trace"));
      } }
  });

  // The conversation routes: the agent pane, voice, Live, the Research Council, Nous (set on nousRef), voice attachments, turns, events (conversation-routes-wiring.ts).
  registerConversationRoutes(app, { config, store, eventBus, auth, options, nousRef, browserSessionManager, cliTerminalManager, cliRuntimeVisibility, roomPaneController,
    commandRoomCli, assertRoomAccess, readDashboardAgents, roomAgentService, roomAgentTools, roomCoordination, roomAgentMonitorRepository, controlRepository, controlInvoke,
    railCli, vault, paneBrowserAccounts, browserControlActivity, cliUpdateAllRunner, codexResetCreditsService, telegramPersistence, telegramSecrets, youtubePlaybackStore, notificationService, claudeUsageProvider,
    canonicalMemory, apiProviderAccountsProvider, healthMonitor, systemServicesProvider, systemAnalyticsService, gatewayAdminService, jobApplyRepository, jobApplyService,
    mailCopilotService, marketingCopilotService, freelanceCopilotService, designService, appStudioService, videoService, securityCopilotService, monitoringCopilotService,
    mailCampaignsService, spaceAgentAdapter, codexHistoryAccessCoordinator, setupOwnerVoiceRuntime, setupVoiceCredentials, decisionsService, turnStarter, codexTurnStarter,
    roomShares, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions, cliRuntimeRegistryCache });

  const { executeMcpToolWithPolicy } = registerAdminPlatformRoutes(app, { store, config, eventBus, options, streamingService, streamingBotService, decisionsService,
    systemAnalyticsService, opencodeModelBenchService, cliRuntimeVisibility, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider,
    toolbarUsageProvider, codexResetCreditsService, toolbarCliSessionStatsProvider, toolbarHostMemoryProvider, toolbarModelStatsCollector,
    codexLbSpeedDefaultsProvider, codexLbSpeedDefaultUpdater, toolbarCliSessionReaper, toolbarCliSessionTerminator, toolbarKernelCacheReclaimer,
    codexHistoryPurgeService, cliSessionCleanupService, codexHistoryAccessCoordinator, sharedCliTaskPurgePreviews, telegramIntegrationManager,
    cliMaintenanceManager, cliUpdateAllRunner, notificationService, activityLogService, openCliLogin, releasePublishingManager, sourceControlPublishingManager,
    cliRuntimeRegistryCache, publicCredentialHost, memoryEmbeddingGenerator, canonicalMemory, canonicalSearch, memoryGraphService, memoryEmbeddingBackfill,
    dotMemoryRepository, codexGoals, browserEvidenceCapture, defaultRouteRateLimitOptions });
  registerSwarmRoutes(app, {
    store, eventBus, config, workerReadinessChecker, spaceAgentAdapter,
    routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  // The admin routes: admin integration, the memory graph, admin operations (admin-routes-wiring.ts).
  registerAdminRoutes(app, { config, store, spaceCapabilityInventoryCollector, defaultRouteRateLimitOptions, memoryGraphService, memoryConsolidationCoordinator,
    memoryMutationCoordinator, apiStartedAt, auth, observability, workerReadinessChecker, storageReadinessChecker, cliRuntimeVisibility, healthMonitor,
    systemTopologyService, serviceRestarter, serviceRestartCooldownPath });

  return app;
}
