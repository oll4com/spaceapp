import { applyUnmanagedCodexModelSettings, assertUnmanagedPlanPane } from "./plan-execution-mutations.js";
import { registerPlanExecutionRoutes } from "./plan-execution-routes.js";
import { claudePaneManagedTurnDriver, claudePlanTarget } from "./plan-execution-claude-driver.js";
import { registerDotsRoutes, validateSessionDotOwner } from "./dots-routes.js";
import { dotConversationContext, dotRuntimeFor, registerDotHomeRoutes } from "./dot-home.js";
import { createDotProactiveService, createProactiveDecider } from "./dot-proactive.js";
import { dotDeveloperContext, findRoomOwnerDot, registerDotToolGatewayRoutes, sessionDotIdentity } from "./dot-tools-gateway.js";
import { createDotGoalService, createDotGoalWorkflowCoordinator, registerDotGoalRoutes } from "./dot-goals.js";
import { sweepStrandedChatRuns as sweepStrandedChatRunsOnce } from "./stranded-chat-runs.js";
import { createDotScheduleService, registerDotScheduleRoutes } from "./dot-schedules.js";
import { createDotComputerService, registerDotComputerRoutes } from "./dot-computer.js";
import { createDotDelegationService } from "./dot-delegations.js";
import { describeCoverage, readAttachments } from "./attachment-readers.js";
import { PostgresChannelsRepository, type ChannelsRepository, PostgresDotEvalsRepository, type DotEvalsRepository, PostgresAutoRouteShadowRepository, PostgresConnectorAccountsRepository, PostgresJobApplyRepository, PostgresDotDelegationsRepository, type AutoRouteShadowRepository, PostgresDotDeliverablesRepository, PostgresDotGoalsRepository, PostgresDotMemoryRepository, PostgresDotSchedulesRepository, PostgresDotsRepository, PostgresDotHomeRepository } from "@space/db";
import { createDotMemoryService, registerDotMemoryRoutes } from "./dot-memory.js";
import { InMemoryRoomAgentMonitorRepository, PostgresRoomAgentMonitorRepository, type RoomAgentMonitorRepository } from "@space/db";
import { InMemorySpaceNotificationsRepository, PostgresSpaceNotificationsRepository, type SpaceNotificationsRepository } from "@space/db";
import { createNotificationService } from "./notifications/service.js";
import { settleBrowserHandoffNotifications, startBrowserHandoffNotifications } from "./notifications/browser-handoff.js";
import { createFcmSender, loadFcmServiceAccount, type FcmSender } from "./notifications/fcm.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import { mailCopilotEventNotifies, notifyMailCopilotEvent } from "./mail-copilot/notify.js";
import { createMailCopilotKickoff } from "./mail-copilot/kickoff.js";
import { registerCouncil } from "./council/wiring.js";
import { registerNous, type NousWiring } from "./nous/wiring.js";
import { createRoomAgentEventRouting } from "./room-agent-event-routing.js";
import type { NousRunner } from "./nous/service.js";
import type { PaneSummaryRunner } from "./nous/pane-board.js";
import { createRoomAgentMonitor } from "./room-agent-monitor.js";
import { createDotDeliverablesService, registerDotDeliverableRoutes } from "./dot-deliverables.js";
import { createConnectorCrypto, createConnectorService, readConnectorKey, createGoogleConnector, createMicrosoftConnector, registerConnectorRoutes } from "./dot-connectors.js";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { cliResourceHealth } from "./cli-resource-health.js";
import { registerReviewRoutes } from "./review-routes.js";
import { registerSwarmRoutes } from "./swarm-routes.js";
import { getPaneById, getLatestRoomEvent, PaneClosedConflictError, assertCliPaneCompatible, assertBrowserPaneCompatible, assertNormalCliSession, isBrowserPane, isCliPane } from "./pane-guards.js";
import { registerTelegramRoutes } from "./telegram-routes.js";
import { registerConfigurationRoutes } from "./configuration-routes.js";
import { createPublicCredentialHost } from "./cli-auth-transfer.js";
import { registerStreamingAdminRoutes } from "./streaming-admin-routes.js";
import { registerStreamingBotRoutes } from "./streaming-bot-routes.js";
import { createMcpToolExecutor } from "./mcp-tool-executor.js";
import { recordAudit } from "./request-audit.js";
import { registerUserLinkRoutes } from "./user-link-routes.js";
import { registerTaskItemRoutes } from "./task-item-routes.js";
import { registerClipboardRoutes } from "./clipboard-routes.js";
import { registerClientErrorRoutes } from "./client-error-routes.js";
import { createInstallTelemetry } from "./install-telemetry.js";
import { registerFirstAnswerWatch, registerInstallTelemetryRoutes } from "./install-telemetry-routes.js";
import { registerAdminUserRoutes } from "./admin-user-routes.js";
import { createSessionAccess } from "./session-access.js";
import { createGatewayCodexResetCreditsService, createGatewayCodexUsageProvider, registerCodexQuotaResetWatch } from "./gateway/gateway-codex-services.js";
import { registerGatewayDownWatch } from "./gateway/gateway-down-watch.js";
import { registerMemoryMaintenanceFailureWatch } from "./memory-maintenance-watch.js";
import { emailsOutOfRotation } from "./gateway/account-rotation.js";
import { createCliBrowserCdpProxy } from "./cli-browser-cdp.js";
import { InMemoryJobApplyRepository } from "./job-apply/memory-repository.js";
import { createImapMailboxFactory, type MailboxFactory } from "./job-apply/mailbox.js";
import { scheduleJobApplyMailTriage } from "./job-apply/mail-triage-timer.js";
import { createJobApplyService, jobApplyNeedsYouAsk, type JobApplyGoogleAccess, type JobApplyService } from "./job-apply/service.js";
import { registerJobApplyRoutes } from "./job-apply/routes.js";
import { registerMailCopilotRoutes } from "./mail-copilot/routes.js";
import { createMailCopilotService, type MailCopilotGoogleAccess } from "./mail-copilot/service.js";
import { isCliBridgeRoutePath } from "./cli-bridge-paths.js";
import { createMailCopilotSync } from "./mail-copilot/sync.js";
import { InMemoryMailCopilotRepository, PostgresMailCopilotRepository, type MailCopilotRepository } from "@space/db";
import { registerMarketingCopilot, type MarketingCopilotWiring } from "./marketing-copilot/wiring.js";
import { registerFreelanceCopilot, type FreelanceCopilotWiring } from "./freelance-copilot/wiring.js";
import { dotDesignRequest, registerDesign, type DesignWiring } from "./design/wiring.js";
import { dotVideoRequest, registerVideo, type VideoWiring } from "./video/wiring.js";
import { registerAppStudio, type AppStudioWiring } from "./app-studio/wiring.js";
import { registerSecurityCopilot, type SecurityCopilotWiring } from "./security-copilot/wiring.js"; import { registerMonitoringCopilot, type MonitoringCopilotWiring } from "./monitoring-copilot/wiring.js";
import { collectStorageReadiness } from "./storage-readiness.js";
import { resumeRoomCliFromMenu, selectRoomCliMenuRow } from "./room-cli-menu.js";
import { createGatewayCliAccounts } from "./gateway/gateway-cli-accounts.js";
import { createGatewayAdminService, type GatewayAdminService } from "./gateway/gateway-service.js";
import { registerGatewayAdminRoutes } from "./gateway/gateway-routes.js";
import { registerTraceRoutes } from "./trace-routes.js";
import { apiLoggerOptions } from "./request-logging.js";
export { redactRequestUrlForLog } from "./request-logging.js";
import { registerArtifactReadRoutes } from "./artifact-read-routes.js";
import { sendApiError } from "./http-errors.js";
import { registerInstanceReleaseRoutes } from "./instance-release-routes.js";
import type { ReleasesOptions } from "./instance-releases.js";
import { sweepExpiredBrowserArtifacts, localArtifactFilePath } from "./artifact-storage.js";
export { sweepExpiredBrowserArtifacts, type BrowserArtifactRetentionSweepResult } from "./artifact-storage.js";
import { withStagedBufferUpload, withPersistedUpload } from "./multipart-upload.js";
import { recordUploadedArtifact } from "./upload-record.js";
import { cliUsageLimited, createCliDashboardActivityReader, readDashboardActivity, type DashboardActivityDetail, type DashboardStatus } from "./agents-dashboard.js";
import { createRoomAgentSnapshotProvider } from "./room-agent-snapshot.js";
import { startPaneCli } from "./nous/copilot-control.js";
import { createDashboardCliProofController } from "./agents-dashboard-proof.js";
import { PostgresSessionRevocationRepository } from "@space/db";
import { registerAppSignIn } from "./app-signin.js";
import { brokerScopeAllows, DOT_TOOL_GATEWAY_VERSION, dotWorkspacePath, slackAppUrl, summarizeAutoRouteShadow } from "@space/contracts";
import { findCodexWriterThreads } from "./codex-thread-writer.js";
import { createCliRenderAiController } from "./cli-render-ai-proof.js";
import { controlExecuteSchema, controlOperationSchema, SPACE_CONTROL_VERSION } from "@space/contracts";
import { cliProfileUsageSchema, type CliProfileUsage } from "@space/contracts";
import { createCliAccountBalancer, type CliAccountBalancer } from "./cli-account-balancer.js";
import { createCliAccountAutoSwitch } from "./cli-account-auto-switch.js";
import { controlTokenHeader, verifyControlToken } from "./space-control-token.js";
import { harnessAgentPrincipal, isHarnessAgentSessionId } from "./harness-agent-tokens.js";
import { PANE_CATALOG_VERSION, paneCountsSchema, PANE_TYPES, isAgentRuntimeReady } from "@space/contracts";
import { controlSkills, controlSkillsPage, controlResourceRoutes, controlPublishInput } from "./space-control-resources.js";
import { captureControlSettingsSnapshot, restoreControlSettingsSnapshot, executeControlPluginAction } from "./space-control-settings.js";
import { createSpaceControl, supportsControlRuntime } from "./space-control.js";
import { createCaptureTerminalFit, createControlScreenshotCapture } from "./space-control-capture.js";
import { registerSpaceControlRoutes } from "./space-control-routes.js";
import { pluginsService } from "./plugins-service.js";
import { InMemorySourceControlRepository, PostgresSourceControlRepository } from "@space/db";
import { SourceControlService } from "./source-control/service.js";
import { registerSourceControlRoutes } from "./source-control/routes.js";
import { WorktreeService } from "./worktrees/worktree-service.js";
import { registerWorktreeRoutes } from "./worktrees/worktree-routes.js";
import { GitControlError } from "./source-control/errors.js";
import { registerVault, type VaultOverrides } from "./vault/wiring.js";
import { assertVaultBrowserActionAllowed } from "./vault/protection.js";
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
import { InMemorySystemHealthRepository, PostgresSystemHealthRepository } from "@space/db";
import { YouTubeAccountStore, privatePaneProfileId, youtubeAccountProfileKey } from "./youtube-accounts.js";
import type { PaneBrowserSessionResponse } from "@space/contracts";
import { YouTubePlaybackStore, youtubeBrowserPlayback } from "./youtube-playback-state.js";
import type { MemoryEmbeddingBackfill } from "./memory-embedding-backfill.js";
import { createMemoryEmbeddingIndexing } from "./memory-embedding-indexing.js";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { execFile, spawn } from "./safe-child-process.js";
import { createNativeCliModelCatalog, findNativeCliModel, inspectedNativeModelId, nativeCliCatalogBufferBytes, nativeCliConfirmedModel, nativeCliConfirmedReasoning, switchNativeCliModel, switchNativeCliReasoning, withOmpSessionModel } from "./cli-native-model-picker.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { z, ZodError } from "zod";
import {
  buildCodexAppServerProcessEnv,
  createCodexAppServerControlService,
  createCodexAppServerSocketControlService,
  type CodexAppServerSocketControlService,
  type CodexAppServerSocketModelOption
} from "@space/codex-app-server";
import type { BrowserHostActorContext } from "@space/browser-host";
import {
  agentPaneGoalSchema,
  harnessMaintenanceStatusSchema,
  cliRuntimeVpnStatusSchema,
  cliGlobalEgressStatusSchema,
  cliToggleRuntimeIds,
  cliToggleRuntimeIdSchema,
  type CliToggleRuntimeId,
  cliVpnConnectionSchema,
  type ApiProviderAccountList,
  systemServicesResponseSchema,
  codexThreadIdSchema,
  agentToolLaunchTaskInputSchema,
  agentToolLaunchTaskResponseSchema,
  cliLoginResponseSchema,
  cliModelIdentifierSchema,
  imageArtifactMaxBytes,
  isAgentFileArtifact,
  isRoomMediaArtifact,
  paneCliUploadMaxBytes,
  reasoningEffortSchema,
  resumePaneCliSessionResponseSchema,
  type AgentRuntime,
  type CliSessionStats,
  type CliRuntimeSetting,
  type CliRuntimeVpnStatus,
  type CliGlobalEgressStatus,
  type CodexEnvironment,
  type CodexLbSpeedDefaultsResponse,
  type CodexLbSpeedTier,
  type AntigravityUsageAccountList,
  type ClaudeUsageAccountList,
  type CodexUsageAccountList,
  type Event,
  providerSwitchTargetsSchema,
  publicWaitlistRequestSchema,
  publicWaitlistResponseSchema,
  voiceTranscriptionMaxBytes,
  type StorageReadiness,
  type HostMemoryDetails,
  type PaneCliSession,
  type PaneCliModelSettings,
  type Pane,
  turnArtifactMaxCount,
  eventSchema,
  resolveJobApplyPaneMetadata,
  type JobApplyRun,
  type MailCopilotRun,
  type AuthUser,
  type Room,
  type RoomAgentEvent,
  cliSessionReapResponseSchema,
  cliSessionStatsSchema,
  hostMemoryDetailsSchema,
  memoryReclaimResponseSchema,
  type MemoryReclaimResponse
} from "@space/contracts";
import {
  InMemoryActivityLogRepository,
  InMemoryAppDiagnosticsRepository,
  InMemorySystemAnalyticsRepository,
  InMemoryStreamingRepository,
  InMemoryStreamingBotRepository,
  PostgresActivityLogRepository,
  PostgresAppDiagnosticsRepository,
  PostgresSystemAnalyticsRepository,
  PostgresStreamingRepository,
  PostgresStreamingBotRepository,
  PostgresSpaceStore,
  InMemoryDemoProjectsRepository,
  InMemoryGatewayRepository,
  PostgresGatewayRepository,
  PostgresDemoProjectsRepository,
  type GatewayRepository
} from "@space/db";
import {
  InMemorySpaceStore,
  InMemoryTelegramPersistence,
  SpaceConflictError,
  SpaceEventBus,
  SpaceFeatureDisabledError,
  SpaceNotFoundError,
  TelegramApiError,
  TelegramIntegrationError,
  TelegramIntegrationManager,
  TelegramSecretStore,
  createCanonicalSpaceMemoryBridge,
  createCodexGoalsAdapter,
  makeSpaceId,
  nowIso,
  redactMemoryText,
  type CanonicalMemoryBridge,
  type CodexGoalsAdapter,
  type GoogleAccount,
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
  signedSessionPayload,
  signOAuthState,
  signSession,
  verifyOAuthState,
  verifyCsrfToken,
  verifySession,
  type AuthConfig
} from "./auth.js";
import {
  AppDiagnosticsService,
  AppDiagnosticsServiceError
} from "./app-diagnostics.js";
import { ActivityLogService } from "./activity-log.js";
import { registerBenchmarkRoutes } from "./benchmark-routes.js";
import { registerChessBenchmarkRoutes } from "./chess/chess-routes.js";
import { pickClaudeProfile } from "./chess/chess-players.js";
import { createWorkerCliMoveRunner } from "./chess/chess-cli.js";
import { registerAsteroidsDirectorRoutes } from "./asteroids-director.js";
import { registerPluginRoutes } from "./plugins-routes.js";
import { registerFilesRoutes } from "./files-routes.js";
import { registerDatabasesRoutes } from "./databases/databases-routes.js";
import { FilesystemError } from "./filesystem-error.js";
import { registerDemoProjectsRoutes } from "./demo-projects/routes.js";
import { DemoProjectsService } from "./demo-projects/service.js";
import { DemoCredentialStore } from "./demo-projects/credentials.js";
import { t3PublicOrigins } from "./t3code/access.js";
import { isOtherSiteBrowserRequest, isOtherSiteUpgradeRequest, requiresSameSiteBrowser } from "./http-origin-guard.js";
import { registerT3Bindings } from "./t3code/bindings.js";
import { registerT3Gateway } from "./t3code/gateway.js";
import { registerT3LegacyRetirement } from "./t3code/legacy.js";
import { registerT3StaticAssets, t3StartupAssets } from "./t3code/static-assets.js";
import { t3InlineBootstrapSupported } from "./t3code/upstream.js";
import { createT3CodeServiceController, registerT3CodeAdminRoutes, type T3CodeServiceController } from "./t3code/service-control.js";
import { harnessRoleAllowed, harnessSameOriginRequest, isHarnessRootHttpPath, registerHarnessRoutes, readHarnessTaskTitle, renameHarnessTaskTitle } from "./harness-proxy.js";
import { createActiveAgentCountProvider } from "./active-agent-count.js";
import { createAutoRouteFactsLoader, createPriceCatalogLoader } from "./auto-route-facts.js";
import { createDotEvalService, registerDotEvalRoutes } from "./dot-evals.js";
import { createDotChannelService, registerDotChannelRoutes } from "./dot-channels.js";
import { createDotLiveService, registerDotLiveRoutes } from "./dot-live.js";
import { createSlackClient, parseSlackEnvelope, verifySlackSignature } from "./channel-slack.js";
import { createBotFrameworkVerifier, createTeamsClient, parseTeamsActivity } from "./channel-teams.js";
import { createRoomCoordination } from "./room-coordination.js";
import { projectRoutingState } from "./tool-routing.js";
import { registerAgentToolRoutingRoutes } from "./agent-tool-routing-routes.js";
import {
  agentFileMaxBytes,
  cliAgentFilesApiBaseUrl,
  persistAgentFile,
  type AgentFileDocxNormalizer
} from "./cli-agent-files.js";
import {
  createBrowserEvidenceCapture,
  type BrowserEvidenceCaptureHandler
} from "./browser-evidence.js";
import { BrowserControlHeldError } from "./browser-errors.js";
import { withHostBoundBrowserInput } from "./browser-input-client.js";
import { withBrowserPageLifecycle } from "./browser-page-lifecycle.js";
import {
  createConfiguredBrowserSessionManager,
  type BrowserSessionManagerWithHostHealth
} from "./browser-host-proxy.js";
import {
  googleBrowserProfilePathFor, sharedCliProfilePathFor, type BrowserSessionManager, type PaneProfileAdoptionResult
} from "./browser-sessions.js";
import { cliAccountBrowserStatus, readGoogleBrowserCheck, summarizeGoogleBrowserStatus, type GoogleBrowserStatusSummary } from "./google-browser-session-check.js";
import {
  codexDirectParityCodexHome,
  codexDirectParityCwd,
  isClaudeDirectParityRuntime,
  isDirectOperatorParityRuntime,
  isCodexDirectParityRuntime,
  isDeepSeekDirectParityRuntime,
  isOpenCodeDirectParityRuntime
} from "./cli-parity.js";
import { createRoomPaneController, type RoomPaneObservation, type RoomCommandAction } from "./room-pane-control.js";
import { openCodeCurrentSelectionWithSource, openCodeTuiSelection } from "./cli-opencode-model-picker.js";
import { openCodeTaskTimeline } from "./room-task-telemetry.js";
import { roomOpenCodeTerminalState, roomPromptFingerprint, roomTerminalCommands, roomTerminalState, roomTerminalMode, roomTerminalInterruptKey } from "./room-terminal-screen.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import { fetchOpenCodeAgentNames, fetchOpenCodeSessionMessages, sendOpenCodePrompt } from "@space/opencode-control";
import { findCodexTaskTimeline, findCodexCliPlanState } from "./codex-rollout-diagnostics.js";
import type { CodexResetCreditsService } from "./codex-reset-credits.js";
import {
  CodexParityNotFoundError,
  createCodexParityService,
  type CodexParityService
} from "./codex-parity.js";
import { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";
import { AgentSessionHistoryService } from "./agent-session-history.js";
import {
  CliRuntimeDisableConfirmationStaleError,
  CliRuntimeVisibilityPolicy
} from "./cli-runtime-visibility.js";
import {
  countRuntimeProcesses as countRuntimeProcessesDefault,
  sweepRuntimeProcesses as sweepRuntimeProcessesDefault,
  type RuntimeProcessSweepResult
} from "./cli-runtime-process-sweeper.js";
import {
  CliVpnBrokerClient,
  CliVpnError,
  type CliVpnBroker
} from "./cli-vpn.js";
import {
  readOpenCodeNativeSessionId,
  readOpenCodeNativeSessionIdFromProcessTree
} from "./opencode-native-session.js";
import {
  geminiNativeConversationIdPattern,
  normalizeGeminiPaneId,
  readGeminiNativeConversationIdFromProcessTree,
  readGeminiPaneConversation,
  writeGeminiPaneConversation
} from "./gemini-native-session.js";
import { hasExactNativeTaskResume, resolveNativeTaskResume } from "./cli-native-task-resume.js";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";
import { verifyGeminiPaneSession } from "./gemini-session-verification.js";
import { loadGeminiNativeTurns } from "./gemini-native-turns.js";
import { QuietRequestLogController } from "./request-log-policy.js";
import { createClaudeNativeRefRecorder, expireClaudeNativeTurns, loadClaudeNativeTurns, type ClaudeNativeTurns } from "./claude-native-turns.js";
import { switchClaudePaneAccount, type ClaudeAccountSwitchDeps } from "./claude-account-switch.js";
import { CLAUDE_GATEWAY_PROFILE, claudeLimitMoveDeps, createClaudeDirectPins, createClaudeLimitMove } from "./claude-limit-move.js";
import { createCliPaneReopener } from "./cli-pane-reopen.js";
import { createCliRuntimePaneRestorer } from "./cli-runtime-pane-restore.js";
import {
  abortOpenCodeSession,
  fetchOpenCodeCurrentModel,
  fetchOpenCodeSessionIsTurnActive,
  fetchOpenCodeSessionModels,
  openCodeServerIsHealthy,
  parseOpenCodeCompositeModelId,
  readOpenCodeServerControl,
  readOpenCodeSessionTurnActive,
  openCodeSpaceChatStateRoot,
  opencodeServerControlPath,
  resolveOpenCodeTitleFallbackControl,
  switchOpenCodeSessionModel,
  type OpenCodeServerControl
} from "@space/opencode-control";
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
  findAvailableCodexThreadId,
  findSafeCodexThreadId,
  findSafeCodexThreadResumeSettings,
  resolveCodexCliLaunchSettings,
  resolveCodexThreadRuntimeSettings,
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
  isCliRuntimeLoginLaunchable,
  isCliRuntimeTerminalLaunchable,
  observeCliRuntimeCredential,
  registerCliRuntimeCacheInvalidation
} from "./cli-runtimes.js";
import {
  CliMaintenanceError,
  CliMaintenanceManager
} from "./cli-maintenance.js";
import { createCliUpdateAllRunner, type CliUpdateAllRunner } from "./cli-maintenance.js";
import {
  MaintenanceAutopilot,
  createCliMaintenanceAutopilotSteps,
  createMemoryReliefStep,
  createStorageCleanupStep
} from "./maintenance-autopilot.js";
import { registerMaintenanceAutopilotRoutes } from "./maintenance-autopilot-routes.js";
import { registerCliMaintenanceRoutes } from "./cli-maintenance-routes.js";
import { registerCliEgressRoutes } from "./cli-egress-routes.js";
import { type AgentToolsOptions } from "./agent-tools.js";
import { getApiConfig, type SpaceApiConfig } from "./config.js";
import {
  cliChatProviderEnabledByRuntimeToggle,
  cliChatRuntimeName,
  cliRuntimeModelsChatProviderAdapter
} from "./chat-providers.js";
import { createOpenCodeSession, openCodeSessionExists, opencodeDirectParityRoot } from "@space/opencode-control";
import type { OwnerSetupBootstrap } from "./owner-setup.js";
import {
  createSetupConnectionsService,
  type SetupConnectionsService
} from "./setup-connections.js";
import {
  SetupConnectionCheckRunManager
} from "./setup-connection-check-runs.js";
import { createHostStatsProvider, type HostStatsProvider } from "./host-stats.js";
import {
  createSystemServicesProvider,
  resetFailedSystemUnits,
  runSystemServicesCollector,
  type SystemServicesRunner
} from "./service-services.js";
import {
  collectCliSessionStats,
  createCliSessionStatsProvider,
  createHostMemoryDetailsProvider,
  runKernelCacheReclaim,
  type InvalidatableProvider,
  type KernelCacheReclaimResult
} from "./toolbar-system-services.js";
import { createAntigravityUsageAccountProvider, discoverAntigravityProfiles } from "./antigravity-usage-services.js";
import { anthropicMonthSpendUsd, claudeGatewayApiKeyUsage, claudeProfileUsageSchema, createClaudeUsageAccountProvider } from "./claude-usage-services.js";
import type { ClaudeProfileUsage } from "./claude-usage.js";
import { createApiProviderAccountProvider } from "./api-provider-balance-services.js";
import {
  createToolbarModelStatsCollector,
  type ToolbarModelStatsCollector
} from "./toolbar-model-stats.js";
import { SystemAnalyticsService, tokenUsageSourcesFor, type SystemAnalyticsLiveSession } from "./system-analytics-service.js";
import { OpencodeModelBenchService, openCode2Models } from "./opencode-model-bench.js";
import { StreamingCredentialStore } from "./streaming-credential-store.js";
import { formatStreamingBotLiveMetrics } from "@space/streaming";
import {
  StreamingService,
  StreamingServiceError,
  StreamingSettingsVersionConflictError
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
  SourceControlPublishingError,
  SourceControlPublishingManager
} from "./source-control-publishing.js";
import {
  ReleasePublishingError,
  ReleasePublishingManager
} from "./release-publishing.js";
import { createAppVersionReader } from "./app-version.js";
import { createMemoryEmbedding } from "./memory-embedding-smoke.js";
import { registerMemoryGraphRoutes } from "./memory-graph-routes.js";
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
import { registerProviderRoutes } from "./provider-routes.js";
import { registerLinkInspectRoutes } from "./link-inspect-routes.js";
import { registerCliAccountRoutes } from "./cli-account-routes.js";
import { registerCliRuntimeRoutes, registerCliRuntimeSettingsRoutes } from "./cli-runtime-routes.js";
import { registerPaneCliRoutes } from "./pane-cli-route-group.js";
import {
  cliModelReasoningEffortSchema, CodexRuntimeModelSettingsUnconfirmedError, canonicalCodexAdvertisedModelId,
  type CodexRuntimeModelSettings
} from "./codex-model-settings.js";
import { registerPaneRoutes } from "./pane-routes.js";
import { registerPaneStreamRoutes, registerPaneBrowserFrameRoutes } from "./pane-stream-routes.js";
import { type PaneBrowserAccountControl, registerPaneBrowserRoutes } from "./pane-browser-routes.js";
import { registerBrowserCensusRoutes } from "./browser-census-routes.js";
import type { PaneBrowserAccount } from "./pane-browser-account.js";
import { registerCliBrowserBridgeRoutes } from "./cli-browser-bridge-routes.js";
import { agentTokenSecret } from "./cli-browser-bridge.js";
import { registerInternalAgentActionRoutes } from "./internal-agent-action-routes.js";
import { registerPaneCliSessionRoutes } from "./pane-cli-session-routes.js";
import { safeBrowserObservationUrl, safeBrowserObservationText } from "./browser-observation.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import { type CliAccountProfileRuntimeId, isCliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import { CliTerminalControlRequiredError, parseCliHttpControlAuthority } from "./cli-http-control.js";
import { registerAgentPaneRoutes } from "./agent-pane-routes.js";
import { registerRoomAgentRoutes } from "./room-agent-routes.js";
import { registerLiveRoutes } from "./live-routes.js";
import { registerVoiceRoutes, registerVoiceAttachmentRoutes } from "./voice-routes.js";
import { buildVoiceTranscriptionSettings } from "./voice-settings.js";
import { registerEventRoutes } from "./event-routes.js";
import { registerTurnRoutes } from "./turn-routes.js";
import { registerCliAuthHandoffRoutes } from "./cli-auth-handoff-routes.js";
import { registerCodexHistoryPurgeRoutes } from "./codex-history-purge-routes.js";
import { registerAdminToolbarRoutes, registerProviderSwitchRoutes } from "./admin-toolbar-routes.js";
import { registerSystemAnalyticsRoutes } from "./system-analytics-routes.js";
import { registerReleaseRoutes } from "./release-routes.js";
import { registerSourceControlConnectionRoutes } from "./source-control-connection-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { providerRouteResponse } from "./codex-provider-route.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { isSemanticMemoryReady, searchDefaultSpaceMemory, type SpaceMemorySearcher } from "./memory-search.js";
export { type SpaceMemorySearcher } from "./memory-search.js";
import { registerSharedTaskRoutes } from "./shared-task-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import {
  paneArtifactUploadMaxBytes, sniffImageMime, buildGenericUserUploadStorage, isVideoMimeType, inferUploadMimeType
} from "./upload-media.js";
import { registerBrowserEvidenceRoutes } from "./browser-evidence-routes.js";
import { registerAdminIntegrationRoutes, registerAdminOperationsRoutes } from "./admin-ops-routes.js";
import { collectDefaultSpaceCapabilityInventory, type SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
export { type SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
import { registerProofRoomRoutes } from "./proof-room-routes.js";
import { observeMemoryWorkers } from "./host-metrics.js"; import { registerMetricsScrape } from "./metrics-scrape.js";
import { type DashboardAgentsSample, registerRoomListRoutes, registerRoomManagementRoutes } from "./room-routes.js";
import { createOwnedResourceGuard } from "./owned-resource-access.js";
import { createRoomShareAccess, registerRoomShareRoutes } from "./room-shares.js";
import { createCliUserHosting } from "./cli-user-hosts.js";
import { registerAgentSessionHistoryRoutes, registerAgentSessionThreadRoutes } from "./agent-session-routes.js";
import { buildSharedCliTaskContext } from "./codex-history-titles.js";
export { buildSharedCliTaskContext } from "./codex-history-titles.js";
import { registerActivityLogRoutes } from "./activity-log-routes.js";
import { registerAppDiagnosticsSettingsRoutes, registerAppDiagnosticsCaptureRoutes } from "./app-diagnostics-routes.js";
import { cookieValueFromHeader, isLoopbackRequest, requestIpForLog, requestPathname, requestRoutePath, secureTokenMatches } from "./request-helpers.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerDesktopReleaseRoutes } from "./desktop-release-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerSharedChatRoutes } from "./shared-chat-routes.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import {
  extractGenericPaneTitleCandidate
} from "./pane-title-generator.js";
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
import { TurnStarterDisabledError, createCodexAppServerTurnStarter, createTurnStarter, type TurnStarter } from "./turns.js";
import {
  getLocalVoiceProviderStatus,
  getLiveAudioProvidersStatus
} from "./voice-transcription.js";
import { createWorkerReadinessChecker, type WorkerReadinessChecker } from "./worker-readiness.js";
import { createDecisionsService, type DecisionsService } from "./decisions-service.js";
import { registerFirstSetup, type FirstSetupAppOptions } from "./setup-wiring.js";

export interface CreateAppOptions extends FirstSetupAppOptions {
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
  mailCopilotGmailFetch?: typeof fetch;
  mailCopilotRepository?: MailCopilotRepository;
  vault?: VaultOverrides; marketingCopilotRepository?: MarketingCopilotWiring["repository"]; marketingCopilotKickoff?: MarketingCopilotWiring["kickoff"]; marketingCopilotScheduler?: boolean; marketingCopilotMetrics?: boolean; freelanceCopilotRepository?: FreelanceCopilotWiring["repository"]; freelanceCopilotKickoff?: FreelanceCopilotWiring["kickoff"]; freelanceCopilotScheduler?: boolean; freelanceCopilotMailboxes?: FreelanceCopilotWiring["mailboxes"];
  /** Tests replace the Design pane's repository, gateway client, template renderer and CLI kickoff. */
  designRepository?: DesignWiring["repository"]; designGenerate?: DesignWiring["generate"]; designRender?: DesignWiring["render"]; designKickoff?: DesignWiring["kickoff"]; appStudioRepository?: AppStudioWiring["repository"]; appStudioKickoff?: AppStudioWiring["kickoff"]; securityCopilotRepository?: SecurityCopilotWiring["repository"]; securityCopilotFeeds?: SecurityCopilotWiring["feeds"]; securityCopilotKickoff?: SecurityCopilotWiring["kickoff"]; securityCopilotWatch?: boolean; monitoringCopilotRepository?: MonitoringCopilotWiring["repository"]; monitoringCopilotCollector?: MonitoringCopilotWiring["collector"]; monitoringCopilotKickoff?: MonitoringCopilotWiring["kickoff"]; monitoringCopilotWatch?: boolean; videoRepository?: VideoWiring["repository"]; videoEngine?: VideoWiring["engine"]; videoKickoff?: VideoWiring["kickoff"];
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
  toolbarCliSessionTerminator?: (sessionId: string) => Promise<boolean>;
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
  cliUpdateAllRunner?: CliUpdateAllRunner;
  cliRecoveryLoginOpener?: (input: {
    roomId: string;
    runtimeId: string;
    requestId: string;
  }) => Promise<{ paneId: string }>;
  removeGeminiAccountProfileState?: (profileId: string) => Promise<void>;
  readGeminiAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  removeClaudeAccountProfileState?: (profileId: string) => Promise<void>;
  readClaudeAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readClaudeAccountProfileUsage?: (profileId: string) => Promise<ClaudeProfileUsage>;
  removeCopilotAccountProfileState?: (profileId: string) => Promise<void>;
  readCopilotAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null }>;
  removeCursorAccountProfileState?: (profileId: string) => Promise<void>;
  readCursorAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readCopilotAccountProfileUsage?: (profileId: string) => Promise<CliProfileUsage>;
  removeKimiAccountProfileState?: (profileId: string) => Promise<void>;
  readKimiAccountProfileDetails?: (profileId: string) => Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null }>;
  readKimiAccountProfileUsage?: (profileId: string) => Promise<CliProfileUsage>;
  cliAccountBalancer?: CliAccountBalancer;
  releasePublishingManager?: ReleasePublishingManager;
  auth?: AuthConfig;
  config?: SpaceApiConfig;
  setup?: OwnerSetupBootstrap | null;
  setupConnections?: SetupConnectionsService;
  setupConnectionCheckRuns?: SetupConnectionCheckRunManager;
}

const publicWaitlistBodyLimitBytes = 2 * 1024;
const publicPaths = new Set([
  "/healthz",
  "/metrics", "/api/metrics/scrape",
  "/readyz",
  "/version",
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/google/start",
  "/api/auth/google/callback",
  "/api/auth/google/credential",
  "/api/auth/desktop-handoff", "/api/auth/app-handoff",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/logout",
  "/api/setup/status",
  "/api/setup/claim",
  "/api/auth/invites/accept",
  "/api/public/waitlist",
  "/api/demo-projects/preview/:runId/:token",
  "/api/demo-projects/preview/:runId/:token/*",
  // Demo connector routes: authenticated via x-demo-run-token header inside the route handler
  "/api/demo-projects/runs/:runId/connector/status",
  "/api/demo-projects/runs/:runId/connector/accounts",
  "/api/demo-projects/runs/:runId/connector/accounts/:accountId",
  "/api/demo-projects/runs/:runId/connector/operations",
  "/api/demo-projects/runs/:runId/connector/operations/:id/retry",
  // Desktop client release and auto-update routes
  "/api/desktop/latest",
  "/api/desktop/update.ps1",
  "/api/desktop/update.bat",
  "/api/desktop/install.sh",
  "/api/desktop/download/:filename",
  "/api/admin/streaming/providers/:provider/oauth/authorize",
  "/api/admin/streaming/providers/:provider/oauth/callback",
  // Slack and Teams deliveries: verified by their signatures inside the routes.
  "/api/channels/slack/events",
  "/api/channels/teams/messages"
]);
const internalApiPrefix = "/api/internal/";
const internalTokenHeader = "x-space-internal-token";
const execFileAsync = promisify(execFile);

const codexThreadSettingsConfirmationAttempts = 12;
const codexThreadSettingsConfirmationIntervalMs = 250;

const emptyToolbarActionSchema = z.object({}).strict();

const minimumKernelCacheReclaimBytes = 256 * 1024 * 1024;

function invalidateToolbarProvider(provider: unknown): void {
  const invalidate = (provider as { invalidate?: unknown } | null)?.invalidate;
  if (typeof invalidate === "function") invalidate.call(provider);
}

function isInternalApiRequest(request: FastifyRequest): boolean {
  return requestRoutePath(request).startsWith(internalApiPrefix);
}

function isCliBrowserBridgeRequest(request: FastifyRequest): boolean {
  return isCliBridgeRoutePath(requestRoutePath(request));
}

const appDiagnosticsAutomationMutationRoutes = new Set([
  "PATCH /api/admin/app-diagnostics",
  "POST /api/app-diagnostics/event-batches",
  "POST /api/admin/app-diagnostics/video-leases",
  "POST /api/admin/app-diagnostics/video-leases/:leaseId/heartbeats",
  "DELETE /api/admin/app-diagnostics/video-leases/:leaseId",
  "POST /api/admin/app-diagnostics/video-segments/:leaseId/:sequence",
  "POST /api/cli/client-events"
]);

function isAllowedAppDiagnosticsAutomationMutation(request: FastifyRequest): boolean {
  if (request.method === "GET") return true;
  const route = request.routeOptions.url ?? requestPathname(request);
  return appDiagnosticsAutomationMutationRoutes.has(`${request.method} ${route}`);
}


export interface DatabaseRetentionSweepResult {
  deletedChunks: number;
  batches: number;
}

// Closed panes are never pruned here (Record Retention Invariant 2026-10-20): only POST /api/admin/panes/prune deletes them.
export async function runDatabaseRetentionSweep(input: {
  store: SpaceStore;
  olderThanDays?: number;
  batchLimit?: number;
  maxBatches?: number;
}): Promise<DatabaseRetentionSweepResult> {
  const olderThanDays = input.olderThanDays ?? 7;
  const batchLimit = input.batchLimit ?? 500;
  const maxBatches = input.maxBatches ?? 10;
  let totalDeletedChunks = 0;
  let totalBatches = 0;

  const pruneChunksFn = (input.store as {
    pruneExpiredCliTranscriptChunks?: (opts?: {
      olderThanDays?: number;
      batchSize?: number;
    }) => Promise<{ deletedChunks: number }> | { deletedChunks: number };
  }).pruneExpiredCliTranscriptChunks;

  if (typeof pruneChunksFn === "function") {
    let chunkBatches = 0;
    while (chunkBatches < maxBatches) {
      const result = await pruneChunksFn.call(input.store, {
        olderThanDays,
        batchSize: batchLimit
      });
      totalDeletedChunks += result.deletedChunks;
      chunkBatches += 1;
      if (result.deletedChunks < batchLimit) break;
    }
    totalBatches = Math.max(totalBatches, chunkBatches);
  }

  return {
    deletedChunks: totalDeletedChunks,
    batches: totalBatches
  };
}

async function loadCodexPrimaryTaskRequest(codexParity: CodexParityService, threadId: string): Promise<string | null> {
  try {
    const conversation = await codexParity.getThread(threadId, { presentation: "chat" });
    const visibleUserRequest = conversation.items.find(
      (item) => item.kind === "message" && item.role === "user" && item.content.trim()
    )?.content.trim();
    if (visibleUserRequest) return visibleUserRequest;
  } catch {
    // Some older history entries no longer have a readable rollout; keep their indexed prompt as a fallback.
  }
  const thread = await codexParity.getHistoryThread(threadId);
  return thread.firstUserMessage?.trim() || null;
}

async function availableNativeCodexThreadId(
  codexParity: CodexParityService,
  threadId: string | null
): Promise<string | null> {
  if (!threadId) return null;
  try {
    await codexParity.getHistoryThread(threadId);
    return threadId;
  } catch (error) {
    if (error instanceof CodexParityNotFoundError) return null;
    throw error;
  }
}

function paneTitleFromCliTaskTitle(title: string): string {
  const nextTitle = title.trim().slice(0, 120);
  return nextTitle || "Resumed CLI task";
}

async function resolvePaneCodexThreadId(input: {
  store: SpaceStore;
  session: PaneCliSession;
  traceId: string;
  findThreadId?: CodexThreadFinder;
}): Promise<string | null> {
  if (input.session.codexThreadId) return input.session.codexThreadId;
  if (!isCodexDirectParityRuntime(input.session.runtimeId)) return null;
  const codexThreadId = await findAvailableCodexThreadId({
    store: input.store,
    paneId: input.session.paneId,
    sessionId: input.session.sessionId,
    cwd: input.session.cwd ?? codexDirectParityCwd,
    findThreadId: input.findThreadId
  });
  if (!codexThreadId) return null;
  try {
    await input.store.claimPaneCliCodexThread(input.session.sessionId, codexThreadId, "AUTO", input.traceId);
    return codexThreadId;
  } catch (error) {
    if (error instanceof SpaceConflictError) {
      return null;
    }
    throw error;
  }
}

const opencodeTitleSyncMaxTitleLength = 120;

export async function runCodexPaneTitleSync(input: {
  store: SpaceStore;
  codexParity: CodexParityService;
  findThreadId?: CodexThreadFinder;
  eventBus: SpaceEventBus;
  traceIdPrefix?: string;
}): Promise<number> {
  const sessions = await input.store.listActivePaneCliSessions("cli:codex");
  let updatedCount = 0;
  for (const session of sessions) {
    if (session.purpose !== "NORMAL") continue;
    let threadId: string | null;
    try {
      threadId = await resolvePaneCodexThreadId({
        store: input.store,
        session,
        traceId: `${input.traceIdPrefix ?? "req:codex-title-sync"}:${session.sessionId}`,
        findThreadId: input.findThreadId
      });
    } catch {
      continue;
    }
    if (!threadId) continue;
    let nativeTitle: string | null;
    try {
      const thread = await input.codexParity.getHistoryThread(threadId);
      nativeTitle = thread.title?.trim() ?? null;
    } catch {
      continue;
    }
    if (!nativeTitle || nativeTitle === "Untitled") continue;
    nativeTitle = nativeTitle.slice(0, opencodeTitleSyncMaxTitleLength);
    const pane = await getPaneById(input.store, session.paneId).catch(() => null);
    if (!pane || pane.title === nativeTitle) continue;
    const traceId = `${input.traceIdPrefix ?? "req:codex-title-sync"}:${session.sessionId}`;
    if (pane.titleSource === "manual") {
      try {
        await input.codexParity.renameThread(threadId, pane.title);
      } catch {
        // Native thread may be unavailable; keep the pane title as-is.
      }
      if (session.cliTaskRevisionId) {
        await input.store.updateCliTaskRevision(
          session.cliTaskRevisionId,
          { displayTitle: pane.title },
          traceId
        );
      }
      updatedCount += 1;
      const latestEvent = await getLatestRoomEvent(input.store, pane.roomId);
      if (latestEvent) input.eventBus.publish(latestEvent);
      continue;
    }
    const updatedPane = await input.store.updatePane(pane.id, { title: nativeTitle }, traceId);
    if (session.cliTaskRevisionId) {
      await input.store.updateCliTaskRevision(
        session.cliTaskRevisionId,
        { displayTitle: nativeTitle },
        traceId
      );
    }
    updatedCount += 1;
    const latestEvent = await getLatestRoomEvent(input.store, updatedPane.roomId);
    if (latestEvent) input.eventBus.publish(latestEvent);
  }
  return updatedCount;
}

const genericTitleSyncRuntimeIds = cliToggleRuntimeIds.filter(
  (runtimeId) => runtimeId !== "cli:opencode" && runtimeId !== "cli:codex"
);

/**
 * Mirrors the OpenCode native-title poller for every CLI runtime that has no
 * dedicated native title source: the pane title follows the task's first user
 * message (captured by the unified CLI task registry) as soon as one becomes
 * meaningful. Pinned (manual) or AI-generated titles are never overwritten.
 */
export async function runGenericCliPaneTitleSync(input: {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  traceIdPrefix?: string;
}): Promise<number> {
  const sessions = await input.store.listActivePaneCliSessionsForRuntimes(genericTitleSyncRuntimeIds);
  let updatedCount = 0;
  for (const session of sessions) {
    if (session.purpose !== "NORMAL") continue;
    const pane = await getPaneById(input.store, session.paneId).catch(() => null);
    if (!pane || pane.titleSource !== "auto") continue;
    let revision: Awaited<ReturnType<SpaceStore["getCliTaskRevision"]>> = null;
    if (session.cliTaskRevisionId) {
      try {
        revision = await input.store.getCliTaskRevision(session.cliTaskRevisionId);
      } catch {
        revision = null;
      }
    }
    let transcript: Parameters<typeof extractGenericPaneTitleCandidate>[1] = [];
    try {
      transcript = await input.store.listPaneCliTranscriptChunks(session.sessionId, 48);
    } catch {
      transcript = [];
    }
    const candidate = extractGenericPaneTitleCandidate(revision?.firstUserMessage, transcript);
    if (!candidate || candidate === pane.title) continue;
    const traceId = `${input.traceIdPrefix ?? "req:generic-title-sync"}:${session.sessionId}`;
    const updatedPane = await input.store.updatePane(
      pane.id,
      { title: candidate, titleSource: "auto" },
      traceId
    );
    if (session.cliTaskRevisionId) {
      await input.store.updateCliTaskRevision(
        session.cliTaskRevisionId,
        { displayTitle: candidate },
        traceId
      );
    }
    updatedCount += 1;
    const latestEvent = await getLatestRoomEvent(input.store, updatedPane.roomId);
    if (latestEvent) input.eventBus.publish(latestEvent);
  }
  return updatedCount;
}

function frameworkHttpErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 429:
      return "RATE_LIMITED";
    default:
      return "HTTP_ERROR";
  }
}

function getFrameworkClientError(error: unknown): { statusCode: number; code: string; message: string } | null {
  const candidate = error as { statusCode?: unknown; message?: unknown };
  const statusCode = candidate.statusCode;
  if (!Number.isInteger(statusCode) || typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  const message = typeof candidate.message === "string" && candidate.message.trim()
    ? candidate.message
    : "The request could not be completed.";
  return {
    statusCode,
    code: frameworkHttpErrorCode(statusCode),
    message
  };
}

function requiresCsrf(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }
  const routeUrl = requestRoutePath(request);
  return (
    routeUrl.startsWith("/api/") &&
    routeUrl !== "/api/auth/login" &&
    routeUrl !== "/api/auth/google/credential" && routeUrl !== "/api/auth/desktop-handoff" && routeUrl !== "/api/auth/app-handoff" &&
    routeUrl !== "/api/voice/realtime/history/search" &&
    routeUrl !== "/api/voice/realtime/logs" &&
    routeUrl !== "/api/voice/client-error" &&
    !routeUrl.startsWith("/api/asteroids/benchmark/")
  ) || isHarnessRootHttpPath(routeUrl);
}

function resolveDemoPublicOrigin(request: { headers: Record<string, unknown> }, config: SpaceApiConfig): string {
  if (config.demoProjectsPublicOrigin) return config.demoProjectsPublicOrigin;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers["host"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? "https";
  if (typeof host === "string" && host.length > 0) return `${String(proto).split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
  return `http://127.0.0.1:${config.port}`;
}

function createDemoProjectsService(input: {
  config: SpaceApiConfig;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): DemoProjectsService {
  const { config } = input;
  const repository =
    config.runtimeStore === "postgres" && config.databaseUrl
      ? PostgresDemoProjectsRepository.fromConnectionString(config.databaseUrl, {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        })
      : new InMemoryDemoProjectsRepository();
  const portStart = Math.min(config.demoProjectsPortStart, 65_500);
  const portEnd = Math.max(portStart + 1, Math.min(config.demoProjectsPortEnd, 65_535));
  return new DemoProjectsService({
    repository,
    demoRoot: config.demoProjectsRoot,
    varRoot: config.demoProjectsVarRoot,
    apiPort: config.port,
    publicOrigin: config.demoProjectsPublicOrigin,
    portRangeStart: portStart,
    portRangeEnd: portEnd,
    healthTimeoutMs: config.demoProjectsHealthTimeoutMs,
    credentialStore: new DemoCredentialStore(`${config.demoProjectsVarRoot.replace(/\/+$/, "")}/secrets`),
    log: input.log
  });
}

function createDefaultStore(config: SpaceApiConfig): SpaceStore {
  if (config.runtimeStore === "postgres") {
    if (!config.databaseUrl) {
      throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
    }
    return PostgresSpaceStore.fromConnectionString(config.databaseUrl, {
      codexLbConfigured: config.codexLbConfigured,
      codexLbBaseUrl: config.codexLbBaseUrl,
      mcpServerConfigs: config.mcpServerConfigs ?? [],
      mcpConfigError: config.mcpConfigError ?? null
    }, {
      idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
      connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
    });
  }

  return new InMemorySpaceStore({
    codexLbConfigured: config.codexLbConfigured,
    codexLbBaseUrl: config.codexLbBaseUrl,
    mcpServerConfigs: config.mcpServerConfigs ?? [],
    mcpConfigError: config.mcpConfigError ?? null
  });
}

function createDefaultAppDiagnosticsService(
  config: SpaceApiConfig,
  store: SpaceStore
): AppDiagnosticsService {
  const persistent = store instanceof PostgresSpaceStore;
  const repository = persistent
    ? PostgresAppDiagnosticsRepository.fromConnectionString(
        config.databaseUrl ?? (() => {
          throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
        })(),
        {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        }
      )
    : new InMemoryAppDiagnosticsRepository();
  return new AppDiagnosticsService({
    repository,
    root: persistent
      ? config.appDiagnosticsRoot
      : join(tmpdir(), `space-app-diagnostics-${process.pid}-${crypto.randomUUID()}`),
    cleanupRootOnDispose: !persistent
  });
}

function createDefaultActivityLogService(config: SpaceApiConfig, store: SpaceStore): ActivityLogService {
  const persistent = store instanceof PostgresSpaceStore;
  const repository = persistent
    ? PostgresActivityLogRepository.fromConnectionString(
        config.databaseUrl ?? (() => {
          throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
        })(),
        {
          max: 2,
          idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
          connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
        }
      )
    : new InMemoryActivityLogRepository();
  return new ActivityLogService({ repository });
}


export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const apiStartedAt = new Date().toISOString();
  const config = options.config ?? getApiConfig(process.env);
  const decisionsService = options.decisionsService ?? createDecisionsService();
  const removeGeminiAccountProfileState = options.removeGeminiAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    await execFileAsync(join(commandRoot, "gemini-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readGeminiAccountProfileDetails = options.readGeminiAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "gemini-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const removeClaudeAccountProfileState = options.removeClaudeAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readClaudeAccountProfileDetails = options.readClaudeAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const readClaudeAccountProfileUsage = options.readClaudeAccountProfileUsage ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "claude-vscode-parity"), ["usage-info", profileId], {
      timeout: 25_000,
      maxBuffer: 16 * 1024
    });
    return claudeProfileUsageSchema.parse(JSON.parse(stdout));
  });
  const removeCopilotAccountProfileState = options.removeCopilotAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readCopilotAccountProfileDetails = options.readCopilotAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable(),
      login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).nullable().optional()
    }).strict().parse(JSON.parse(stdout));
  });
  const removeCursorAccountProfileState = options.removeCursorAccountProfileState ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    await execFileAsync(join(commandRoot, "cursor-vscode-parity"), ["remove-profile", profileId], {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    });
  });
  const readCursorAccountProfileDetails = options.readCursorAccountProfileDetails ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "cursor-vscode-parity"), ["profile-info", profileId], {
      timeout: 12_000,
      maxBuffer: 16 * 1024
    });
    return z.object({
      authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]),
      email: z.string().email().nullable()
    }).strict().parse(JSON.parse(stdout));
  });
  const runAccountWrapper = async (command: string, args: string[], timeout: number) =>
    (await execFileAsync(join(config.cliCommandPath ?? "/opt/spaceapp/bin", command), args, { timeout, maxBuffer: 16 * 1024 })).stdout;
  const removeKimiAccountProfileState = options.removeKimiAccountProfileState ?? (async (profileId: string) => {
    await runAccountWrapper("kimi-vscode-parity", ["remove-profile", profileId], 15_000);
  });
  const readKimiAccountProfileDetails = options.readKimiAccountProfileDetails ?? (async (profileId: string) =>
    z.object({ authStatus: z.enum(["CONNECTED", "NOT_CONNECTED", "UNAVAILABLE"]), email: z.string().email().nullable() }).strict()
      .parse(JSON.parse(await runAccountWrapper("kimi-vscode-parity", ["profile-info", profileId], 12_000))));
  const readKimiAccountProfileUsage = options.readKimiAccountProfileUsage ?? (async (profileId: string) =>
    cliProfileUsageSchema.parse(JSON.parse(await runAccountWrapper("kimi-vscode-parity", ["usage-info", profileId], 20_000))));
  const deletingCliAccountProfileKeys = new Set<string>();
  const cliAccountProfileKey = (runtimeId: string, profileId: string) => `${runtimeId}/${profileId}`;
  const readCliAccountProfileDetails = (runtimeId: CliAccountProfileRuntimeId, profileId: string) =>
    runtimeId === "cli:gemini"
      ? readGeminiAccountProfileDetails(profileId)
      : runtimeId === "cli:claude"
        ? readClaudeAccountProfileDetails(profileId)
        : runtimeId === "cli:copilot"
          ? readCopilotAccountProfileDetails(profileId)
          : runtimeId === "cli:kimi"
            ? readKimiAccountProfileDetails(profileId)
            : readCursorAccountProfileDetails(profileId);
  // The linked-accounts view reads every profile's sign-in identity; a short cache keeps
  // repeated menu opens from spawning one native probe per profile each time.
  const cliAccountIdentityCacheTtlMs = 30_000;
  const cliAccountIdentityCache = new Map<string, { expiresAt: number; value: Promise<{ authStatus: "CONNECTED" | "NOT_CONNECTED" | "UNAVAILABLE"; email: string | null; login?: string | null }> }>();
  const readCachedCliAccountIdentity = (runtimeId: CliAccountProfileRuntimeId, profileId: string) => {
    const key = cliAccountProfileKey(runtimeId, profileId);
    const cached = cliAccountIdentityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = readCliAccountProfileDetails(runtimeId, profileId)
      .catch(() => ({ authStatus: "UNAVAILABLE" as const, email: null }));
    cliAccountIdentityCache.set(key, { expiresAt: Date.now() + cliAccountIdentityCacheTtlMs, value });
    return value;
  };
  const invalidateCliAccountIdentity = (runtimeId: string, profileId: string) => {
    cliAccountIdentityCache.delete(cliAccountProfileKey(runtimeId, profileId));
  };
  const appVersionReader = createAppVersionReader({
    appVersionEnv: process.env.SPACE_APP_VERSION,
    publicDistribution: process.env.SPACE_PUBLIC_DISTRIBUTION === "true"
  });
  const auth = options.auth ?? getAuthConfig(process.env);
  const store = options.store ?? createDefaultStore(config);
  const readCopilotAccountProfileUsage = options.readCopilotAccountProfileUsage ?? (async (profileId: string) => {
    const commandRoot = config.cliCommandPath ?? "/opt/spaceapp/bin";
    const { stdout } = await execFileAsync(join(commandRoot, "copilot-vscode-parity"), ["usage-info", profileId], {
      timeout: 20_000,
      maxBuffer: 16 * 1024
    });
    return cliProfileUsageSchema.parse(JSON.parse(stdout));
  });
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
      timeoutMs: config.browserEvidenceTimeoutMs
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
  const createCliModelsExecutor = (runtimeId: string) => {
    const modelsFile = `/opt/spaceapp/var/${runtimeId.replace("cli:", "")}-models.last-good.json`;
    let modelsCache: { raw: string; at: number } | null = null;
    const readModelsFile = async (): Promise<string | null> => {
      try {
        const parsed = JSON.parse(await readFile(modelsFile, "utf8")) as { models?: unknown };
        return typeof parsed.models === "string" && parsed.models.trim() ? parsed.models : null;
      } catch {
        return null;
      }
    };
    const runModels = (): Promise<string> => new Promise((resolve, reject) => {
      const isDeepSeek = runtimeId === "cli:deepseek";
      const child = isDeepSeek
        ? spawn("/usr/bin/sudo", [
            "-n", "-u", "spaceapp-user", "--",
            "/opt/spaceapp/bin/deepseek-vscode-parity", "--run-inner", "models"
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }
          })
        : spawn("/usr/bin/sudo", [
            "-n", "/opt/spaceapp/bin/space-cli-vpn-broker", "exec", runtimeId, "models"
          ], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }
          });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${runtimeId} model catalog request timed out.`));
      }, 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        // A CLI advertises its whole catalog here (Reasonix returns 300+ rows);
        // the bound only guards against an unbounded stream, not against size.
        if (stdout.length > nativeCliCatalogBufferBytes) child.kill("SIGTERM");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 || !stdout.trim()) {
          reject(new Error(stderr.trim() || `${runtimeId} model catalog command failed (exit ${code ?? "unknown"}).`));
          return;
        }
        resolve(stdout);
      });
    });
    return async (): Promise<string> => {
      if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.raw;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const stdout = await runModels();
          if (!stdout.trim()) throw new Error(`Empty ${runtimeId} model catalog.`);
          modelsCache = { raw: stdout, at: Date.now() };
          try {
            await writeFile(modelsFile, JSON.stringify({ models: stdout, at: new Date().toISOString() }), "utf8");
          } catch {
            // Best-effort persistence; the live catalog remains authoritative.
          }
          return stdout;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (modelsCache) return modelsCache.raw;
      const persisted = await readModelsFile();
      if (persisted) return persisted;
      throw new Error(lastError instanceof Error ? lastError.message : `${runtimeId} model catalog is unavailable.`);
    };
  };
  // One cached catalog per runtime, shared by Chat panes and the Chess benchmark.
  const cliModelsExecutors = new Map<string, () => Promise<string>>();
  const cliModelsExecutor = (runtimeId: string) => {
    let executor = cliModelsExecutors.get(runtimeId);
    if (!executor) {
      executor = createCliModelsExecutor(runtimeId);
      cliModelsExecutors.set(runtimeId, executor);
    }
    return executor;
  };
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
  const codexParity =
    options.codexParity ??
    createCodexParityService({
      codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
      threadRenameCommand: config.codexAppServerCommand,
      codexLbBaseUrl: config.codexLbBaseUrl,
      codexLbKeyFile: config.codexLbKeyFile, ...(config.instance === "dev" ? { environmentInspectorCommand: null } : {}) // dev cannot sudo
    });

  const unifiedCliTaskRegistry = new UnifiedCliTaskRegistry(store, {
    resolveNativeTaskRef: async (session) => {
      if (session.runtimeId === "cli:codex") {
        return (options.findCodexThreadId ?? findSafeCodexThreadId)({
          paneId: session.paneId, sessionId: session.sessionId, cwd: session.cwd
        });
      }
      if (session.runtimeId === "cli:opencode") {
        return readOpenCodeNativeSessionId(session.sessionId, options.opencodeStateRoot);
      }
      if (session.runtimeId === "cli:gemini") {
        if (session.codexThreadId && geminiNativeConversationIdPattern.test(session.codexThreadId)) {
          return session.codexThreadId;
        }
        const fromFile = await readGeminiPaneConversation(session.paneId);
        if (fromFile) return fromFile;
        const pids = await cliTerminalManager.activeSessionPids([session]);
        const rootPid = pids.get(session.sessionId) ?? null;
        return rootPid ? readGeminiNativeConversationIdFromProcessTree(rootPid) : null;
      }
      if (session.runtimeId === "cli:claude") {
        const pids = await cliTerminalManager.activeSessionPids([session]);
        const native = await loadClaudeNativeTurns({
          paneId: session.paneId, sessionId: session.sessionId, rootPid: pids.get(session.sessionId) ?? null
        });
        return native?.nativeSessionId ?? null;
      }
      return null;
    }
  });
  const agentSessionHistoryService = new AgentSessionHistoryService({
    codexParity,
    unifiedCliTaskRegistry,
    codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
    maxAgeDays: 7,
    verifyRolloutExistence: true
  });
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
    onTaskInput: (paneId) => { expireClaudeNativeTurns(paneId); taskTitleInputNotifier?.(paneId); },
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
  // Dashboard and live agent counts poll every Claude pane; one launcher read per session
  // serves every room request and browser tab for a few seconds.
  const claudeLiveTurnsCache = new Map<string, { expires: number; value: Promise<ClaudeNativeTurns | null> }>();
  const readClaudeLiveTurns = (session: PaneCliSession, { fresh = false }: { fresh?: boolean } = {}): Promise<ClaudeNativeTurns | null> => {
    const now = Date.now();
    const cached = claudeLiveTurnsCache.get(session.sessionId);
    if (!fresh && cached && cached.expires > now) return cached.value;
    for (const [key, entry] of claudeLiveTurnsCache) if (entry.expires <= now) claudeLiveTurnsCache.delete(key);
    const value = cliTerminalManager.activeSessionPids([session]).catch(() => null)
      .then(pids => loadClaudeNativeTurns({ paneId: session.paneId, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null }, { fresh }))
      .then(async native => {
        if (native) await recordClaudeNativeRef(session, native).catch(() => undefined);
        return native;
      });
    claudeLiveTurnsCache.set(session.sessionId, { expires: now + 4_000, value });
    return value;
  };
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
  cliRuntimeRegistryCache = createCliRuntimeRegistryCache(config, { probeCredentialStatus: publicCredentialHost?.status });
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
    terminateSession: options.cliRuntimeSessionTerminator ?? ((sessionId) => cliTerminalManager.interrupt(sessionId)),
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
  const hostStatsProvider =
    options.hostStatsProvider ??
    createHostStatsProvider({
      apiStartedAt,
      cliHosts: [
        {
          hostId: "main",
          enabled: config.cliEnabled,
          health: () => cliTerminalManager.hostHealth("cli:codex")
        },
        {
          hostId: "root",
          enabled: config.cliRootEnabled,
          health: () => cliTerminalManager.hostHealth("cli:root")
        }
      ]
    });
  const antigravityUsageProvider =
    options.antigravityUsageProvider ??
    createAntigravityUsageAccountProvider({
      profileLabels: async () => {
        try {
          const list = await Promise.resolve(store.listCliAccountProfiles("cli:gemini"));
          return new Map(list.map((p: { profileId: string; displayName: string }) => [p.profileId, p.displayName]));
        } catch {
          return new Map();
        }
      },
      hiddenEmails: async () => emailsOutOfRotation(await gatewayRepositoryFor().listAccounts(), "ANTIGRAVITY", Date.now())
    });
  const claudeUsageProvider = options.claudeUsageProvider ?? createClaudeUsageAccountProvider({
    listProfiles: async () => store.listCliAccountProfiles("cli:claude"),
    readUsage: readClaudeAccountProfileUsage,
    gatewayAccounts: () => gatewayRepositoryFor().listAccounts(),
    gatewaySettings: () => gatewayRepositoryFor().getSettings(),
    gatewayAccountUsage: (accountId) => claudeGatewayApiKeyUsage(gatewayRepositoryFor(), accountId, Date.now()),
    anthropicMonthUsd: async () => anthropicMonthSpendUsd(await resolveGatewayAdminService().anthropicBilling(new Date().getUTCDate()), Date.now())
  });
  const apiProviderAccountsProvider =
    options.apiProviderAccountsProvider ??
    createApiProviderAccountProvider({ anthropic: { billing: () => resolveGatewayAdminService().anthropicBilling(31), settings: () => gatewayRepositoryFor().getSettings(),
      usage: () => gatewayRepositoryFor().listAnthropicUsage("2000-01-01", new Date().toISOString().slice(0, 10)) } });
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
  const gatewayCliAccounts = createGatewayCliAccounts({
    gateway: { serves: (provider) => resolveGatewayAdminService().serves(provider) },
    profileExists: async (runtimeId, profileId) => isCliAccountProfileRuntimeId(runtimeId)
      && Boolean(await store.getCliAccountProfile(runtimeId, profileId))
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
  const toolbarCliSessionStatsProvider =
    options.toolbarCliSessionStatsProvider ??
    createCliSessionStatsProvider({
      collect: async () => {
        const hosts = [
          { hostId: "main" as const, enabled: config.cliEnabled, runtimeId: "cli:codex" },
          { hostId: "root" as const, enabled: config.cliRootEnabled, runtimeId: "cli:root" }
        ].filter((host) => host.enabled);
        const settled = await Promise.all(hosts.map(async (host) => {
          try {
            return { ok: true as const, hostId: host.hostId, health: await cliTerminalManager.hostHealth(host.runtimeId) };
          } catch {
            return { ok: false as const, hostId: host.hostId };
          }
        }));
        if (hosts.length > 0 && settled.every((host) => !host.ok)) {
          throw new Error("Space CLI hosts are unavailable.");
        }
        return collectCliSessionStats({
          hosts: settled.flatMap((host) => host.ok ? [{ hostId: host.hostId, health: host.health }] : [])
        });
      }
    });
  const systemServicesProvider =
    options.systemServicesProvider ??
    createSystemServicesProvider({ collect: runSystemServicesCollector });
  const toolbarHostMemoryProvider =
    options.toolbarHostMemoryProvider ??
    createHostMemoryDetailsProvider({
      cliSessions: () => toolbarCliSessionStatsProvider(),
      resolveSessionTitle: async (paneId) => {
        try {
          const task = await unifiedCliTaskRegistry.findLatestTaskForPane(paneId);
          return task?.title ?? null;
        } catch {
          return null;
        }
      }
    });
  const toolbarCliSessionReaper = options.toolbarCliSessionReaper ?? (() => cliTerminalManager.reapDetachedSessions());
  const toolbarCliSessionTerminator = options.toolbarCliSessionTerminator ?? ((sessionId: string) => cliTerminalManager.interrupt(sessionId));
  const toolbarModelStatsCollector = options.toolbarModelStatsCollector
    ?? createToolbarModelStatsCollector({ store });
  const systemAnalyticsService = options.systemAnalyticsService ?? new SystemAnalyticsService({
    repository: store instanceof PostgresSpaceStore
      ? PostgresSystemAnalyticsRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemorySystemAnalyticsRepository(),
    store,
    stateRoot: options.opencodeStateRoot,
    codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
    tokenUsage: tokenUsageSourcesFor(gatewayRepositoryFor, config.instanceJobs["token-usage-claude"]),
    liveSessions: async () => {
      const health = await Promise.all([
        cliTerminalManager.hostHealth("cli:codex").catch(() => null),
        config.cliRootEnabled ? cliTerminalManager.hostHealth("cli:root").catch(() => null) : Promise.resolve(null)
      ]);
      const unique = new Map<string, SystemAnalyticsLiveSession>();
      for (const session of health.flatMap((entry) => entry?.sessions ?? [])) {
        unique.set(session.cliSessionId, {
          cliSessionId: session.cliSessionId,
          paneId: session.paneId,
          roomId: session.roomId,
          runtimeId: session.runtimeId,
          codexThreadId: session.codexThreadId,
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort,
          pid: session.pid,
          status: session.status,
          attachmentCount: session.attachmentCount,
          startedAt: session.startedAt,
          detachedAt: session.detachedAt,
          endedAt: session.endedAt
        });
      }
      return [...unique.values()];
    }
  });
  const opencodeModelBenchService = options.opencodeModelBenchService ?? new OpencodeModelBenchService({
    execVerbose: publicCredentialHost
      ? (provider) => publicCredentialHost.openCodeModels(provider).then((stdout) => openCode2Models(stdout, provider)).catch(() => [])
      : undefined,
    repository: store instanceof PostgresSpaceStore
      ? PostgresSystemAnalyticsRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemorySystemAnalyticsRepository()
  });
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    opencodeModelBenchService.startDailyRefresh();
  }
  const healthRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresSystemHealthRepository.fromConnectionString(config.databaseUrl)
    : new InMemorySystemHealthRepository();
  const healthMonitor = options.healthMonitor ?? new SystemHealthMonitor({
    repository: healthRepository,
    requests: () => observability.recentSnapshot(),
    onError: () => app.log.warn("System health history sample could not be retained."),
    checks: [
      { id: "cli-resource-guard", label: "CLI resource protection", collect: () => cliResourceHealth() },
      { id: "api", label: "Space API", collect: async () => ({ status: "healthy", detail: "API is responding", values: [
        { label: "Uptime", value: `${Math.round(process.uptime())} s` },
        { label: "Node.js", value: process.version },
        { label: "Heap", value: `${Math.round(process.memoryUsage().heapUsed / 1024 ** 2)} MiB` },
      ] }) },
      { id: "database", label: "Database", collect: async () => {
        await healthRepository.probe();
        return { status: "healthy", detail: config.runtimeStore === "postgres" ? "PostgreSQL query succeeded" : "In-memory store", values: [] };
      } },
      { id: "worker", label: "Temporal & worker", collect: async () => {
        const w = await workerReadinessChecker();
        return { status: w.status === "RUNNING" ? "healthy" : "critical",
          detail: w.status === "RUNNING" ? "Temporal reachable with workflow and activity pollers" : "Worker is not ready",
          values: [ { label: "Workflow pollers", value: String(w.workflowPollerCount) }, { label: "Activity pollers", value: String(w.activityPollerCount) },
            { label: "Workflow backlog", value: w.workflowBacklogCount === null ? "Unavailable" : String(w.workflowBacklogCount) },
            { label: "Activity backlog", value: w.activityBacklogCount === null ? "Unavailable" : String(w.activityBacklogCount) } ] };
      } },
      ...[{ id: "cli-host", label: "CLI host", enabled: config.cliEnabled, runtime: "cli:codex" },
        { id: "admin-host", label: "Admin CLI host", enabled: config.cliRootEnabled, runtime: "cli:root" }].map(h => ({
          id: h.id, label: h.label, collect: async () => {
            if (!h.enabled) return { status: "disabled" as const, detail: "Not enabled", values: [] };
            const result = await cliTerminalManager.hostHealth(h.runtime).catch(() => null);
            return { status: result ? "healthy" as const : "critical" as const, detail: result ? "Host is responding" : "Host is unreachable", values: [] };
          }
        })),
      { id: "browser-host", label: "Browser host", collect: async () => {
        if (!config.browserSessionsEnabled) return { status: "disabled", detail: "Not enabled", values: [] };
        if (config.browserHostTransport !== "unix") return { status: "healthy", detail: "In-process browser runtime", values: [] };
        const result = await browserSessionManager.browserHostHealth?.().catch(() => null);
        return { status: result ? "healthy" : "critical", detail: result ? "Browser host is responding" : "Browser host is unreachable", values: [] };
      } },
      { id: "storage", label: "Storage readiness", collect: async () => {
        const st = await storageReadinessChecker();
        return { status: st.status === "VERIFIED" ? "healthy" : st.status === "WARN" ? "warning" : "critical",
          detail: st.statusReason.slice(0, 500), values: [{ label: "Dedicated volume", value: st.dedicatedAppVolume ? "Yes" : "No" },
          { label: "Minimum free space", value: `${Math.round(st.minimumRecommendedFreeBytes / 1024 ** 3)} GiB` }] };
      } },
      { id: "mcp", label: "MCP gateway", collect: async () => {
        const g = await store.getMcpGatewayStatus();
        return { status: g.status === "VERIFIED" ? "healthy" : g.status === "ERROR" ? "critical" : "unavailable",
          detail: "Latest gateway verification", values: [{ label: "Servers", value: String(g.serverCount) }, { label: "Tools", value: String(g.toolCount) }, { label: "Last discovery", value: g.lastDiscoveryAt ?? "Unavailable" }] };
      } },
      { id: "provider", label: "Active provider", collect: async () => {
        const targets = await readToolbarProviderTargets(); const current = targets.data.find(p => p.isCurrent);
        return { status: current?.health === "HEALTHY" ? "healthy" : current?.health === "UNAVAILABLE" ? "critical" : current?.health === "DEGRADED" ? "warning" : "unavailable",
          detail: current ? `${current.displayName} · Latest provider verification` : "No active provider", values: [] };
      } },
    ]
  });
  const systemTopologyService: SystemTopologyService = options.systemTopologyService ?? new SystemTopologyService({
    getHealthSnapshot: () => healthMonitor.snapshot(),
    includeOperatorInfrastructure: !config.publicDistribution
  });
  const streamingBotService: StreamingBotService = options.streamingBotService ?? new StreamingBotService({
    botRepository: store instanceof PostgresSpaceStore
      ? PostgresStreamingBotRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingBotRepository(),
    streamingRepository: store instanceof PostgresSpaceStore
      ? PostgresStreamingRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingRepository(),
    store,
    youtubeDailyBudget: config.streamingYoutubeDailyQuotaBudget,
    credentialStore: new StreamingCredentialStore(config.streamingSecretRoot),
    liveMetrics: async () => formatStreamingBotLiveMetrics(await streamingService.overlaySnapshot())
  });
  const streamingService: StreamingService = options.streamingService ?? new StreamingService({
    repository: store instanceof PostgresSpaceStore
      ? PostgresStreamingRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingRepository(),
    credentialStore: new StreamingCredentialStore(
      store instanceof PostgresSpaceStore
        ? config.streamingSecretRoot
        : join(tmpdir(), `space-streaming-secrets-${process.pid}-${nanoid(8)}`)
    ),
    store,
    activeAgentCountProvider: createActiveAgentCountProvider({
      store,
      isCliTurnActive: async (session) => {
        if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
          const stateRoot = options.opencodeStateRoot ?? opencodeDirectParityRoot + "/state";
          const control = await readOpenCodeServerControl(session.sessionId, stateRoot);
          if (control) {
            if (!control.directory && session.cwd) control.directory = session.cwd;
            if (await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId, session.cwd ?? undefined).catch(() => false)) return true;
          }
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (isCodexDirectParityRuntime(session.runtimeId)) {
          const active = (await cliTerminalManager.getCurrentTurnActivity(session.sessionId)).status === "RUNNING";
          if (active) return true;
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (session.runtimeId === "cli:gemini") {
          const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
          const rootPid = pids?.get(session.sessionId) ?? null;
          const native = await loadGeminiNativeTurns({ paneId: session.paneId, sessionId: session.sessionId, rootPid }).catch(() => null);
          if (native?.turns.length && native.turns.at(-1)!.status === "RUNNING") return true;
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (isDeepSeekDirectParityRuntime(session.runtimeId)) {
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (isClaudeDirectParityRuntime(session.runtimeId)) {
          const native = await readClaudeLiveTurns(session).catch(() => null);
          if (native) return native.busy;
        }
        const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
        return roomTerminalState(screen.text) === "RUNNING";
      }
    }),
    youtubeDailyQuotaBudget: config.streamingYoutubeDailyQuotaBudget,
    cleanupCredentialRootOnDispose: !(store instanceof PostgresSpaceStore),
    botTickerProvider: () => streamingBotService.botTicker()
  });
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
  const findCodexThreadRuntimeSettings = async (input: {
    threadId: string;
    cwd: string | null;
    sessionId: string;
    models: CodexAppServerSocketModelOption[];
  }) => {
    const findStateSettings = options.findCodexThreadResumeSettings ?? findSafeCodexThreadResumeSettings;
    const stateSettings = await findStateSettings({
      threadId: input.threadId,
      cwd: input.cwd
    });
    if (stateSettings && stateSettings.reasoningEffort !== null) return stateSettings;
    const transcript = await store.listPaneCliTranscriptChunks(input.sessionId, 48);
    const transcriptSettings = await resolveCodexThreadRuntimeSettings({
      transcript: transcript.map((chunk) => chunk.content).join(""),
      threadId: input.threadId,
      cwd: input.cwd,
      fallback: async () => null
    });
    if (!stateSettings) return transcriptSettings;
    if (!transcriptSettings?.reasoningEffort) return stateSettings;
    const stateModelId = canonicalCodexAdvertisedModelId(stateSettings.modelId, input.models);
    const transcriptModelId = canonicalCodexAdvertisedModelId(transcriptSettings.modelId, input.models);
    return stateModelId && stateModelId === transcriptModelId
      ? { ...stateSettings, reasoningEffort: transcriptSettings.reasoningEffort }
      : stateSettings;
  };
  const waitForCodexThreadSettings = async (input: {
    threadId: string;
    cwd: string | null;
    sessionId: string;
    modelId: string;
    reasoningEffort: string;
    models: CodexAppServerSocketModelOption[];
  }) => {
    let observed: CodexRuntimeModelSettings | null = null;
    for (let attempt = 0; attempt < codexThreadSettingsConfirmationAttempts; attempt += 1) {
      const runtimeSettings = await findCodexThreadRuntimeSettings(input);
      observed = runtimeSettings;
      const confirmedModelId = canonicalCodexAdvertisedModelId(runtimeSettings?.modelId ?? null, input.models);
      if (confirmedModelId === input.modelId && runtimeSettings?.reasoningEffort === input.reasoningEffort) return;
      if (attempt < codexThreadSettingsConfirmationAttempts - 1) {
        await new Promise((resolveConfirmation) => setTimeout(resolveConfirmation, codexThreadSettingsConfirmationIntervalMs));
      }
    }
    throw new CodexRuntimeModelSettingsUnconfirmedError({
      stage: "THREAD_CONFIRMATION",
      expected: { modelId: input.modelId, reasoningEffort: input.reasoningEffort },
      observed,
      attempts: codexThreadSettingsConfirmationAttempts
    });
  };
  const loadNativeCliModels = createNativeCliModelCatalog();
  const readScreenNativeModelSettings = async (session: PaneCliSession): Promise<PaneCliModelSettings> => {
    const runtime = findRuntime(await cliRuntimeRegistryCache.read(), session.runtimeId);
    if (!runtime?.detectedCommandPath || !isDirectOperatorParityRuntime(session.runtimeId)) {
      throw new SpaceConflictError("This CLI does not expose a model catalog.");
    }
    const [models, screen] = await Promise.all([
      loadNativeCliModels(
        runtime.detectedCommandPath,
        findCliRuntimeDescriptor(session.runtimeId)?.accountProfileEnv ? session.accountProfileId : null
      ),
      cliTerminalManager.observeRoomScreen(session.sessionId, true)
    ]);
    // A pane is pinned to its model at launch, which need not be the catalog's first entry.
    const modelId = nativeCliConfirmedModel(screen.text, models, session.runtimeId)
      ?? (models.some(model => model.id === session.modelId) ? session.modelId : null)
      ?? null;
    const model = models.find(entry => entry.id === modelId);
    return {
      sessionId: session.sessionId, threadId: null, models, controlMode: "NATIVE",
      current: modelId ? { modelId, reasoningEffort: nativeCliConfirmedReasoning(screen.text, session.runtimeId, model)
        ?? (session.modelId === modelId && model?.supportedReasoningEfforts.includes(session.reasoningEffort ?? '') ? session.reasoningEffort! : 'unknown') } : null,
      isTurnActive: roomTerminalState(screen.text) === "RUNNING"
    };
  };
  const readPaneNativeModelSettings = (session: PaneCliSession) => withOmpSessionModel(readScreenNativeModelSettings(session), session, cliTerminalManager, store);
  /** Switches a native-picker CLI to an advertised model and effort with screen readback, then
   * records it on the session and the pane (the pane's next session starts on it). Callers serialize. */
  const applyNativePaneModel = async (input: {
    pane: Pane;
    active: PaneCliSession;
    modelId: string;
    reasoningEffort: string;
    traceId: string;
    assertControl: (current: PaneCliSession) => Promise<void>;
  }) => {
    const { pane, active, traceId } = input;
    const before = await readPaneNativeModelSettings(active);
    let model = before.models.find((entry) => entry.id === input.modelId);
    if (!model || !model.supportedReasoningEfforts.includes(input.reasoningEffort)) {
      throw new SpaceConflictError("The selected model settings are not advertised by this CLI.");
    }
    if (active.runtimeId === 'cli:gemini' && model.reasoningOptions?.length) {
      const variantId = model.id.replace(/-(low|medium|high)$/, `-${input.reasoningEffort}`);
      model = before.models.find(entry => entry.id === variantId) ?? model;
    }
    if (before.isTurnActive) throw new SpaceConflictError("Wait for this CLI turn to finish before changing models.");
    const assertCurrent = async () => {
      const current = await store.getActivePaneCliSession(pane.id);
      if (!current?.isActive || current.sessionId !== active.sessionId || current.status === "EXITED" || current.status === "ERROR") {
        throw new SpaceConflictError("The CLI session changed during the model switch.");
      }
      await input.assertControl(current);
    };
    let step = 0;
    await switchNativeCliModel({ model, effort: input.reasoningEffort, runtimeId: active.runtimeId, assertCurrent,
      read: () => cliTerminalManager.observeRoomScreen(active.sessionId, true),
      readUndimmed: () => cliTerminalManager.observeRoomScreenUndimmed(active.sessionId),
      write: (data) => cliTerminalManager.sendInput(active.sessionId, data, traceId, null, `model-picker:${traceId}:${step++}`)
    });
    // Preserve the confirmed model even if its separate effort command fails.
    await store.updatePaneCliSession(active.sessionId, { modelId: model.id, reasoningEffort: "unknown" }, traceId);
    // Gemini, OMP, Claude and Droid apply the effort together with the model.
    if (active.runtimeId !== 'cli:gemini' && active.runtimeId !== 'cli:omp' && active.runtimeId !== 'cli:claude' && active.runtimeId !== 'cli:droid') await switchNativeCliReasoning({ model, effort: input.reasoningEffort, runtimeId: active.runtimeId, assertCurrent,
      read: () => cliTerminalManager.observeRoomScreen(active.sessionId, true),
      write: data => cliTerminalManager.sendInput(active.sessionId, data, traceId, null, `reasoning-picker:${traceId}:${step++}`)
    });
    await assertCurrent();
    const current = { modelId: model.id, reasoningEffort: input.reasoningEffort };
    const updated = await store.updatePaneCliSession(active.sessionId, current, traceId);
    const paneEffort = reasoningEffortSchema.safeParse(input.reasoningEffort);
    if (paneEffort.success) {
      // A pick belongs to this pane: its next session (restart, resume) starts on it.
      await store.updatePane(pane.id, { modelId: model.id, reasoningEffort: paneEffort.data }, traceId);
    }
    return { before, current, updated };
  };
  const readPaneCliModelSettings = async (pane: Pane, session: PaneCliSession, traceId: string) => {
    if (!isCodexDirectParityRuntime(session.runtimeId)) {
      throw new SpaceConflictError("Model switching is available only for Codex CLI panes.");
    }
    let refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? session;
    const socketPath = codexPrivateAppServerSocketPath(refreshedSession);
    const directAvailable = await codexSessionSocketProbe(socketPath);
    if (!directAvailable) {
      throw new SpaceFeatureDisabledError(
        "CODEX_SESSION_CONTROL_UNAVAILABLE",
        "Live Codex model control is unavailable; the current CLI session was left unchanged."
      );
    }
    const directControl = codexSocketControlFactory(socketPath);
    let models: CodexAppServerSocketModelOption[];
    try {
      models = await directControl.listModels();
    } catch {
      throw new SpaceFeatureDisabledError(
        "CODEX_SESSION_CONTROL_UNAVAILABLE",
        "Live Codex model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!models.length) {
      throw new SpaceFeatureDisabledError("CODEX_MODEL_CATALOG_UNAVAILABLE", "Codex did not advertise any selectable models.");
    }
    // The TUI can restore a task without replacing its Space CLI session.
    // Its confirmed selection outranks persisted ownership and writer locks.
    // undefined means an older multiplexer; null means a selection is pending.
    const primaryThreadId = await directControl.readCurrentThreadId?.();
    let threadId = primaryThreadId !== undefined ? primaryThreadId : await resolvePaneCodexThreadId({
      store, session: refreshedSession, traceId, findThreadId: options.findCodexThreadId
    });
    if (primaryThreadId === undefined) refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? refreshedSession;
    // A fresh TUI already owns a native thread before its first message is
    // persisted. Resolve only this app-server's kernel-held writer lock; never
    // drive its composer with /model or Enter to change settings.
    if (primaryThreadId === undefined && !threadId && directControl.readThreadSettings) {
      const candidates = await (options.findCodexModelControlThreads ?? findCodexWriterThreads)({
        codexHome: codexDirectParityCodexHome, paneId: pane.id, sessionId: session.sessionId
      });
      if (candidates.length === 1) threadId = candidates[0]!;
    }
    // A just-started or just-resumed Codex can reject thread/read briefly;
    // report it like an unavailable catalog instead of a server error.
    const nativeSettings = threadId && directControl.readThreadSettings
      ? await directControl.readThreadSettings(threadId).catch(() => {
          throw new SpaceFeatureDisabledError(
            "CODEX_SESSION_CONTROL_UNAVAILABLE",
            "Live Codex model control is unavailable; the current CLI session was left unchanged."
          );
        })
      : null;
    const isSessionOwnedThread = refreshedSession.codexThreadId === threadId;
    if (nativeSettings && nativeSettings.cwd !== refreshedSession.cwd && !isSessionOwnedThread && primaryThreadId !== threadId) {
      throw new SpaceConflictError("Codex model control did not confirm this pane's working directory.");
    }
    const runtimeSettings = nativeSettings ?? (threadId
      ? await findCodexThreadRuntimeSettings({
          threadId,
          cwd: refreshedSession.cwd,
          sessionId: refreshedSession.sessionId,
          models
        })
      : null);
    const effectiveModelId = runtimeSettings ? runtimeSettings.modelId : refreshedSession.modelId;
    const effectiveReasoningEffort = runtimeSettings ? runtimeSettings.reasoningEffort : refreshedSession.reasoningEffort;
    const currentModelId = canonicalCodexAdvertisedModelId(effectiveModelId, models);
    const currentReasoningEffort = cliModelReasoningEffortSchema.safeParse(effectiveReasoningEffort).data;
    const persistedCombinationIsAdvertised = runtimeSettings !== null || Boolean(
      currentModelId &&
      currentReasoningEffort &&
      models.some(
        (model) => model.id === currentModelId && model.supportedReasoningEfforts.includes(currentReasoningEffort)
      )
    );
    const current = currentModelId && currentReasoningEffort && persistedCombinationIsAdvertised
      ? { modelId: currentModelId, reasoningEffort: currentReasoningEffort }
      : null;
    const screen = await cliTerminalManager.observeRoomScreen(refreshedSession.sessionId, true).catch(() => null);
    const screenIsRunning = screen ? roomTerminalState(screen.text) === "RUNNING" : false;
    const activity = threadId
      ? await cliTerminalManager.getCurrentTurnActivity(refreshedSession.sessionId)
      : { status: "PENDING" as const, turnId: null };
    return {
      settings: {
        sessionId: refreshedSession.sessionId,
        threadId,
        current,
        models,
        controlMode: "DIRECT" as const,
        isTurnActive: Boolean(nativeSettings?.isTurnActive || activity.status === "RUNNING" || screenIsRunning)
      },
      activity,
      directControl,
      primaryThreadId,
      controlCwd: nativeSettings?.cwd ?? refreshedSession.cwd,
      session: refreshedSession
    };
  };
  const readOpenCodeServerControlFromMapping = async (spaceSessionId: string, stateRoot?: string): Promise<OpenCodeServerControl | null> => {
    const resolvedStateRoot = stateRoot ?? join(opencodeDirectParityRoot, "state");
    const safeName = spaceSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    const mappingPath = join(resolvedStateRoot, "opencode", "space-cli-sessions", `${safeName}.json`);
    try {
      const text = await readFile(mappingPath, "utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const nativeSessionId = typeof parsed.nativeSessionId === "string" ? parsed.nativeSessionId : "";
      if (!/^ses_[A-Za-z0-9]+$/.test(nativeSessionId)) return null;
      const fallback = await resolveOpenCodeTitleFallbackControl(resolvedStateRoot);
      if (!fallback) return null;
      return {
        ...fallback,
        spaceSessionId,
        nativeSessionId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt
      };
    } catch {
      return null;
    }
  };
  const resolveOpenCodeServerControl = async (session: PaneCliSession): Promise<OpenCodeServerControl> => {
    let control = await readOpenCodeServerControl(session.sessionId, options.opencodeStateRoot);
    if (!control) {
      control = await readOpenCodeServerControlFromMapping(session.sessionId, options.opencodeStateRoot);
    }
    if (!control || !(await openCodeServerIsHealthy(control))) {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "Live OpenCode model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!control.directory && session.cwd) {
      control.directory = session.cwd;
    }
    return control;
  };
  const openCodeChatControlPromises = new Map<string, Promise<OpenCodeServerControl>>();
  // Dev runs as stable's user: it must never read stable's OpenCode access files or reach stable's shared server.
  const assertChatOpenCodeHere = () => { if (config.instance === "dev") throw new SpaceFeatureDisabledError("OPENCODE_SESSION_CONTROL_UNAVAILABLE", "OpenCode Chat is unavailable on dev: it runs only on the stable instance."); };
  const resolveChatOpenCodeCatalogControl = async (): Promise<OpenCodeServerControl> => {
    assertChatOpenCodeHere();
    const stateRoot = options.opencodeStateRoot ?? opencodeDirectParityRoot + "/state";
    const sharedControl = await resolveOpenCodeTitleFallbackControl(stateRoot);
    if (sharedControl && await openCodeServerIsHealthy(sharedControl)) return sharedControl;
    throw new SpaceFeatureDisabledError(
      "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
      "Live OpenCode model control is unavailable; the Chat provider catalog could not be loaded."
    );
  };
  const resolveChatPaneOpenCodeControl = async (spaceAgentSessionId: string): Promise<OpenCodeServerControl> => {
    assertChatOpenCodeHere();
    if (!/^agent_session:[A-Za-z0-9_-]+$/.test(spaceAgentSessionId)) {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "OpenCode Chat requires a valid isolated Space agent session."
      );
    }
    let targetDirectory = "/etc";
    try {
      const session = await store.getSpaceAgentSession(spaceAgentSessionId);
      if (session) {
        const pane = await store.getPane(session.paneId);
        if (pane?.cwd && pane.cwd.startsWith("/") && pane.cwd !== "/etc") {
          targetDirectory = pane.cwd;
        } else {
          const room = await store.getRoom(session.roomId);
          if (room?.projectPath && room.projectPath.startsWith("/")) {
            targetDirectory = room.projectPath;
          }
        }
      }
    } catch {
      // Best-effort lookup
    }
    const existing = await readOpenCodeServerControl(spaceAgentSessionId, openCodeSpaceChatStateRoot);
    if (
      existing &&
      (!existing.directory || existing.directory === targetDirectory) &&
      await openCodeServerIsHealthy(existing) &&
      await openCodeSessionExists(existing, existing.nativeSessionId)
    ) return existing;

    const inFlight = openCodeChatControlPromises.get(spaceAgentSessionId);
    if (inFlight) return inFlight;
    const createControl = (async () => {
      const sharedControl = await resolveChatOpenCodeCatalogControl();
      const nativeSessionId = await createOpenCodeSession(
        sharedControl,
        `Space Chat ${spaceAgentSessionId.slice(-12)}`,
        targetDirectory
      );
      if (!nativeSessionId) {
        throw new SpaceFeatureDisabledError(
          "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
          "OpenCode could not create an isolated session for this Chat task."
        );
      }
      const control: OpenCodeServerControl = {
        ...sharedControl,
        spaceSessionId: spaceAgentSessionId,
        nativeSessionId,
        directory: targetDirectory,
        updatedAt: new Date().toISOString()
      };
      const controlPath = opencodeServerControlPath(spaceAgentSessionId, openCodeSpaceChatStateRoot);
      const temporaryPath = `${controlPath}.${process.pid}.${nanoid(8)}.tmp`;
      await mkdir(dirname(controlPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, JSON.stringify(control, null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, controlPath);
      const stored = await readOpenCodeServerControl(spaceAgentSessionId, openCodeSpaceChatStateRoot);
      if (!stored || stored.nativeSessionId !== nativeSessionId) {
        throw new SpaceFeatureDisabledError(
          "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
          "The isolated OpenCode Chat session could not be persisted."
        );
      }
      return stored;
    })();
    openCodeChatControlPromises.set(spaceAgentSessionId, createControl);
    try {
      return await createControl;
    } finally {
      openCodeChatControlPromises.delete(spaceAgentSessionId);
    }
  };
  const readPaneOpenCodeModelSettings = async (pane: Pane, session: PaneCliSession, traceId: string) => {
    const control = await resolveOpenCodeServerControl(session);
    const refreshedSession = (await store.getPaneCliSession(session.sessionId)) ?? session;
    let models: PaneCliModelSettings["models"];
    try {
      const descriptors = await fetchOpenCodeSessionModels(control, session.cwd ?? '/etc');
      const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId);
      const currentModelId = currentModel ? `${currentModel.providerID}/${currentModel.id}` : null;
      models = descriptors.flatMap((descriptor) => {
        const optionId = `${descriptor.providerId}/${descriptor.modelId}`;
        if (!cliModelIdentifierSchema.safeParse(optionId).success) return [];
        const listedVariants = descriptor.variants.length > 0 ? descriptor.variants : [];
        return [{
          id: optionId,
          displayName: descriptor.displayName,
          description: descriptor.providerName ?? descriptor.providerId,
          isDefault: optionId === currentModelId,
          defaultReasoningEffort:
            descriptor.defaultVariant ?? listedVariants[0] ?? "default",
          supportedReasoningEfforts: ["default", ...listedVariants.filter(variant => variant !== "default")],
          reasoningOptions: (listedVariants.length ? ["default", ...listedVariants.filter(variant => variant !== "default")] : []).map((reasoningEffort) => ({ reasoningEffort }))
        }];
      // Space Gateway's models first, so a picker search finds them ahead of the hundreds of OpenRouter rows.
      }).sort((left, right) => Number(!left.id.startsWith("space-gateway")) - Number(!right.id.startsWith("space-gateway")));
    } catch {
      throw new SpaceFeatureDisabledError(
        "OPENCODE_SESSION_CONTROL_UNAVAILABLE",
        "Live OpenCode model control is unavailable; the current CLI session was left unchanged."
      );
    }
    if (!models.length) {
      throw new SpaceFeatureDisabledError("OPENCODE_MODEL_CATALOG_UNAVAILABLE", "OpenCode did not advertise any selectable models.");
    }
    const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
    const currentModelOption = currentModel
      ? models.find(
          (model) => model.id === `${currentModel.providerID}/${currentModel.id}`
        ) ?? null
      : null;
    const nativeScreen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => null);
    const nativeCurrent = nativeScreen ? openCodeTuiSelection(nativeScreen.text, models) : null;
    const serverCurrent = currentModel
      ? {
          modelId: `${currentModel.providerID}/${currentModel.id}`,
          reasoningEffort: currentModelOption && currentModel.variant
            ? (currentModelOption.supportedReasoningEfforts.includes(currentModel.variant)
              ? currentModel.variant
              : currentModelOption.defaultReasoningEffort)
            : "default"
        }
      : null;
    const currentSelection = openCodeCurrentSelectionWithSource(refreshedSession.modelId, serverCurrent, nativeCurrent, models, refreshedSession.reasoningEffort);
    const current = currentSelection.current;
    if (current?.modelId && (refreshedSession.modelId !== current.modelId || refreshedSession.reasoningEffort !== current.reasoningEffort)) {
      try {
        await store.updatePaneCliSession(refreshedSession.sessionId, {
          modelId: current.modelId,
          reasoningEffort: current.reasoningEffort ?? "default"
        }, traceId);
        await store.updatePane(pane.id, {
          modelId: current.modelId
        }, traceId);
      } catch {}
    }
    const screen = await cliTerminalManager.observeRoomScreen(session.sessionId, true).catch(() => null);
    const screenIsRunning = screen ? roomTerminalState(screen.text) === "RUNNING" : false;
    const serverTurnActive = await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId);
    const isTurnActive = Boolean(serverTurnActive || screenIsRunning);
    return {
      settings: {
        sessionId: refreshedSession.sessionId,
        threadId: null,
        current,
        models,
        controlMode: "OPENCODE" as const,
        isTurnActive,
        // A session-default reading means the picker can only show the pane's
        // persisted default: the CLI's real model was not readable yet.
        ...(currentSelection.source ? { currentSource: currentSelection.source } : {})
      },
      session: refreshedSession
    };
  };
  const applyOpenCodePaneSelection = async (
    pane: Pane, session: PaneCliSession, model: PaneCliModelSettings["models"][number], effort: string,
    traceId: string, assertControl?: (current: PaneCliSession) => Promise<void>,
    allModels?: PaneCliModelSettings["models"]
  ) => cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
    if (!model.supportedReasoningEfforts.includes(effort)) throw new SpaceConflictError("This reasoning level is not advertised by OpenCode.");
    const control = await resolveOpenCodeServerControl(session);
    const turnActive = await readOpenCodeSessionTurnActive(control, control.nativeSessionId);
    if (turnActive !== false) throw new SpaceConflictError(turnActive ? "Wait for the OpenCode turn to finish before changing model settings." : "OpenCode did not report whether a turn is running; try again.");
    const assertCurrent = async () => {
      const current = await store.getActivePaneCliSession(pane.id);
      if (!current?.isActive || current.sessionId !== session.sessionId || current.status === "EXITED" || current.status === "ERROR") {
        throw new SpaceConflictError("The OpenCode session changed during model selection.");
      }
      await assertControl?.(current);
    };
    // OpenCode 2's TUI follows the server's session model live, so the server switch below is the whole change.
    await assertCurrent();
    const ref = parseOpenCodeCompositeModelId(model.id)!;
    try {
      await switchOpenCodeSessionModel(control, control.nativeSessionId, ref.providerId, ref.modelId, effort,
        model.supportedReasoningEfforts.filter(value => value !== "default"));
    } catch {
      throw new SpaceConflictError("OpenCode server rejected the model switch. Reopen the picker to refresh its current settings.");
    }
    // The server applies selections asynchronously and the TUI menu markers
    // can be graphics-wrapped: confirm the settled server model AND effort
    // with retries before persisting anything.
    const serverSelectionMatches = async (): Promise<boolean> => {
      const confirmed = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
      if (!confirmed || `${confirmed.providerID}/${confirmed.id}` !== model.id) return false;
      const serverEffort = !confirmed.variant ? "default"
        : (model.supportedReasoningEfforts.includes(confirmed.variant) ? confirmed.variant : model.defaultReasoningEffort);
      return serverEffort === effort;
    };
    let serverConfirmed = await serverSelectionMatches();
    for (let i = 0; i < 30 && !serverConfirmed; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      serverConfirmed = await serverSelectionMatches();
    }
    if (!serverConfirmed) {
      throw new SpaceConflictError("OpenCode server did not confirm the selected model. Reopen the picker to refresh its current settings.");
    }
    await store.updatePaneCliSession(session.sessionId, {modelId:model.id,reasoningEffort:effort}, traceId);
    try { await store.updatePane(pane.id, {modelId:model.id}, traceId); } catch {}
  });
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
  async function resumePaneCliTask(pane: Pane, input: { taskId?: string; threadId?: string; accountProfileId?: string | null }, traceId: string, request?: FastifyRequest, requireNative = false) {
    const active = await store.getActivePaneCliSession(pane.id);
    const targetRuntimeId = pane.terminalRuntimeId ?? "cli:codex";
    await cliRuntimeVisibility.assertEnabled(targetRuntimeId);
    const sourceTaskReference = input.taskId ?? input.threadId;
    if (!sourceTaskReference) throw new SpaceNotFoundError("Space CLI task reference was not provided.");
    const sourceTask = await unifiedCliTaskRegistry.getTask(sourceTaskReference, await visibleCliRuntimeIds());
    if (requireNative && sourceTask.session.roomId !== pane.roomId) throw new SpaceConflictError("Room Agent can resume only tasks belonging to this room.");
    const paneTitle = paneTitleFromCliTaskTitle(sourceTask.title);
    const registry = await discoverAgentRuntimes(config);
    const runtime = findRuntime(registry, targetRuntimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${targetRuntimeId} was not found.`);
    }
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    if (!isCliRuntimeTerminalLaunchable(runtime)) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, {
        runtimeId: runtime.id,
        status: runtime.status
      });
    }
    if (active?.purpose === "LOGIN") {
      throw new SpaceConflictError("Cancel or complete CLI login before resuming a CLI task in this pane.");
    }
    const parsedNativeThreadId = codexThreadIdSchema.safeParse(sourceTask.revision.nativeTaskRef);
    const nativeThreadId = await availableNativeCodexThreadId(
      codexParity,
      runtime.id === "cli:codex" && sourceTask.runtimeId === "cli:codex" && parsedNativeThreadId.success
        ? parsedNativeThreadId.data
        : null
    );
    // Exact task-history resume for every other runtime comes from its registered resolver.
    const nativeResume = await resolveNativeTaskResume(runtime.id, { sourceTask, pane });
    const exactNativeResume = Boolean(nativeThreadId || nativeResume);
    if (requireNative && !exactNativeResume) throw new SpaceConflictError("Exact native resume is unavailable; the existing pane was preserved.");
    const mode = exactNativeResume
      ? "NATIVE_RESUME" as const
      : sourceTask.runtimeId === runtime.id
        ? "SPACE_FALLBACK" as const
        : "CROSS_RUNTIME_SHARE" as const;

    const resumeOperation = async () => {
      const stoppedSessionIds = new Set<string>();
      const stopSession = async (sessionId: string, statusReason: string) => {
        if (stoppedSessionIds.has(sessionId)) return;
        stoppedSessionIds.add(sessionId);
        await cliTerminalManager.interrupt(sessionId);
        await store.updatePaneCliSession(
          sessionId,
          { status: "EXITED", statusReason, isActive: false, endedAt: nowIso() },
          traceId
        );
      };

      if (nativeThreadId) {
        const threadOwner = await store.getActivePaneCliSessionByCodexThreadId(nativeThreadId);
        let owner = threadOwner;
        if (!owner) {
          for (const candidate of await store.listActivePaneCliSessions("cli:codex")) {
            if (candidate.status !== "RUNNING") continue;
            const heldThread = await (options.findCodexThreadId ?? findSafeCodexThreadId)({
              paneId: candidate.paneId, sessionId: candidate.sessionId, cwd: candidate.cwd
            });
            if (heldThread === nativeThreadId) { owner = candidate; break; }
          }
        }
        if (owner && (owner.status === "RUNNING" || owner.status === "IDLE")) {
          if (request) await assertRoomAccess(owner.roomId, request.user);
          if (requireNative && owner.roomId !== pane.roomId) {
            throw new SpaceConflictError("The task is already active in another room.");
          }
          const ownerPane = await store.getPane(owner.paneId);
          if (ownerPane.isClosed) throw new SpaceConflictError("The task is still active in a closed pane. Reopen that pane to continue.");
          return resumePaneCliSessionResponseSchema.parse({
            ...(await buildPaneCliSessionResponse({
              store, runtime, sessionId: owner.sessionId, includeWebsocket: false,
              tokenTtlMs: config.cliTokenTtlMs,
              issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
            })),
            pane: ownerPane, mode: "NATIVE_RESUME", focusExisting: true
          });
        }
      }
      if (active) {
        await stopSession(active.sessionId, "CLI session replaced to resume a previous task.");
      }

      const allocatedAtNs = process.hrtime.bigint();
      const nextSessionId = makeSpaceId("cli_session");
      const sameRuntime = sourceTask.runtimeId === runtime.id;
      // A Job Copilot pane continuing an earlier copilot's task keeps the CLI account that task ran on, while it exists.
      const sourceAccountProfileId = pane.mode === "JOB_APPLY" && sameRuntime && sourceTask.session.accountProfileId && isCliAccountProfileRuntimeId(runtime.id)
        && await store.getCliAccountProfile(runtime.id, sourceTask.session.accountProfileId) ? sourceTask.session.accountProfileId : null;
      const allocatedSession = await store.createPaneCliSession(
        {
          sessionId: nextSessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          runtimeId: runtime.id,
          providerId: runtime.providerId,
          agentId: runtime.agentId,
          modelId: sameRuntime
            ? sourceTask.revision.modelId ?? pane.modelId ?? runtime.defaultModelId
            : pane.modelId ?? runtime.defaultModelId,
          reasoningEffort: sameRuntime ? sourceTask.revision.reasoningEffort : pane.reasoningEffort,
          launchMode: exactNativeResume ? "RESUME" : "FRESH",
          cwd: sameRuntime ? sourceTask.revision.cwd ?? pane.cwd ?? "/etc" : pane.cwd ?? "/etc",
          codexThreadId: null,
          cliTaskId: sourceTask.taskId,
          ...(input.accountProfileId !== undefined ? { accountProfileId: input.accountProfileId }
            : sourceAccountProfileId ? { accountProfileId: sourceAccountProfileId } : {}),
          status: "IDLE",
          statusReason: "CLI session allocated; waiting for terminal transport attach."
        },
        traceId
      );
      cliTerminalManager.recordSessionAllocation(allocatedSession.sessionId, allocatedAtNs);

      if (nativeResume?.afterAllocate) {
        await nativeResume.afterAllocate(pane.id);
      }

      if (nativeThreadId) {
        await store.claimPaneCliCodexThread(
          allocatedSession.sessionId,
          nativeThreadId,
          "HISTORY_TRANSFER",
          traceId
        );
      }
      let session = (await store.getPaneCliSession(allocatedSession.sessionId)) ?? allocatedSession;
      if (session.cliTaskRevisionId) {
        await store.updateCliTaskRevision(
          session.cliTaskRevisionId,
          {
            displayTitle: paneTitle,
            firstUserMessage: sourceTask.firstUserMessage,
            preview: sourceTask.preview,
            cwd: session.cwd,
            modelId: session.modelId,
            reasoningEffort: session.reasoningEffort,
            ...(nativeThreadId
              ? { nativeTaskRef: nativeThreadId }
              : nativeResume?.persistAsNativeTaskRef
                ? { nativeTaskRef: nativeResume.ref }
                : {})
          },
          traceId
        );
      }
      await store.appendPaneCliTranscriptChunk(
        {
          sessionId: session.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          sequence: 0,
          stream: "system",
          content: exactNativeResume
            ? `Resuming ${sourceTask.title} from exact ${runtime.displayName} task history.`
            : `Loaded bounded untrusted context from Space CLI task ${sourceTask.title} into a fresh ${runtime.displayName} session.`
        },
        traceId
      );
      if (!exactNativeResume) {
        const sharedContext = buildSharedCliTaskContext({
          sourceTaskId: sourceTask.taskId,
          sourceRuntimeLabel: sourceTask.providerLabel,
          sourceTitle: sourceTask.title,
          sourceFirstUserMessage: sourceTask.firstUserMessage,
          targetRuntimeLabel: runtime.displayName,
          transcript: sourceTask.transcript
        });
        await cliTerminalManager.sendInput(
          session.sessionId,
          sharedContext,
          traceId,
          null,
          `shared-history:${sourceTask.taskId}:${session.sessionId}`
        );
        session = (await store.getPaneCliSession(session.sessionId)) ?? session;
      }
      const updatedPane = await store.updatePane(
        pane.id,
        // A copilot, Design or App Studio pane keeps its own title; its name (e.g. "Cody") is the pane name either way.
        { ...(pane.mode === "TERMINAL" ? { title: paneTitle } : {}), cwd: session.cwd, terminalRuntimeId: runtime.id },
        traceId
      );
      const latestEvent = await getLatestRoomEvent(store, updatedPane.roomId);
      if (latestEvent) eventBus.publish(latestEvent);

      if (request) await recordAudit(store, request, {
        action: "pane.cli.resume",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          runtimeId: runtime.id,
          sessionId: session.sessionId,
          mode,
          sourceTaskId: sourceTask.taskId,
          sourceRevisionId: sourceTask.revision.revisionId,
          targetRevisionId: session.cliTaskRevisionId,
          sourceRuntimeId: sourceTask.runtimeId,
          codexThreadId: nativeThreadId,
          ...nativeResume?.auditMetadata
        }
      });
      return resumePaneCliSessionResponseSchema.parse({
        ...(await buildPaneCliSessionResponse({
          store,
          runtime,
          sessionId: session.sessionId,
          includeWebsocket: Boolean(request),
          tokenTtlMs: config.cliTokenTtlMs,
          issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
        })),
        pane: updatedPane,
        mode
      });
    };

    return nativeThreadId
      ? codexHistoryAccessCoordinator.withHistoryAttachment(resumeOperation)
      : resumeOperation();
  }

  async function roomCliSession(pane: Pane, expectedSessionId?: string) {
    await assertPaneCliRuntimeEnabled(pane);
    if (!isCliPane(pane) || pane.terminalRuntimeId === "cli:root") throw new SpaceConflictError("Room CLI controls require an AI terminal.");
    if ((await store.getPane(pane.id)).isClosed) throw new SpaceConflictError("Reopen the pane before controlling its CLI.");
    let session = await store.getActivePaneCliSession(pane.id);
    if (!session) {
      session = (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
    }
    if (!session || session.purpose !== "NORMAL" || (expectedSessionId && session.sessionId !== expectedSessionId)) throw new SpaceConflictError("The target CLI session is unavailable or changed.");
    return session;
  }
  async function roomOpenCodeInspection(control: OpenCodeServerControl) {
    const [messages, busy] = await Promise.all([
      fetchOpenCodeSessionMessages(control, control.nativeSessionId, 512).catch(() => { throw new SpaceConflictError("OpenCode task history is unavailable."); }),
      fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId)
    ]);
    const tasks = openCodeTaskTimeline(messages, busy, nowIso());

    const transcriptLines: string[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = (msg as any).info?.role === "user" ? "User" : (msg as any).info?.role === "assistant" ? "Assistant" : null;
      if (!role) continue;
      const parts = Array.isArray((msg as any).parts) ? (msg as any).parts : [];
      const textParts = parts
        .filter((p: any) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text.trim())
        .filter(Boolean);
      if (textParts.length > 0) {
        transcriptLines.push(`[${role}]\n${textParts.join("\n")}`);
      }
    }
    const transcript = transcriptLines.join("\n\n");
    return { tasks, transcript };
  }
  async function roomOpenCodeTasks(control: OpenCodeServerControl) {
    return (await roomOpenCodeInspection(control)).tasks;
  }
  const roomCliObservationCache = new Map<string, { expires: number; data: RoomPaneObservation }>();
  async function inspectRoomCli(pane: Pane, freshness?: { fresh?: boolean }): Promise<RoomPaneObservation> {
    const cached = roomCliObservationCache.get(pane.id);
    if (!freshness?.fresh && cached && cached.expires > Date.now()) {
      return cached.data;
    }
    const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
    const rawTaskRef = session?.codexThreadId?.trim();
    const base: RoomPaneObservation = { paneId: pane.id, paneName: pane.paneName ?? null, title: pane.title, runtimeId: pane.terminalRuntimeId ?? null,
      sessionId: session?.sessionId ?? null, state: "UNKNOWN", nativeTaskRef: rawTaskRef && rawTaskRef.length > 0 ? rawTaskRef : null,
      modelId: session?.modelId ?? pane.modelId ?? null, nativeMode: null, checkedAt: nowIso(), tasks: [] };
    if (!session || session.purpose !== "NORMAL") return base;
    const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(error=>{if(pane.isClosed||["EXITED","ERROR"].includes(session.status))return {text:""};throw error;});
    base.text = redactMemoryText(screen.text);
    base.promptFingerprint = roomPromptFingerprint(base.text);
    base.commands = roomTerminalCommands(screen.text);
    const rawState = roomTerminalState(screen.text);
    let claudeNative: Awaited<ReturnType<typeof loadClaudeNativeTurns>> = null;
    base.state = pane.isClosed || session.status === "EXITED" ? "EXITED" : session.status === "ERROR" ? "ERROR" : (rawState === "UNKNOWN" && screen.text.trim() === "" && session.runtimeId !== "cli:gemini" ? "IDLE" : rawState);
    if (isCodexDirectParityRuntime(session.runtimeId)) {
      base.tasks = session.codexThreadId ? await findCodexTaskTimeline({ codexHome: codexDirectParityCodexHome,
        threadId: session.codexThreadId }) : [];
      const settings = await readPaneCliModelSettings(pane, session, "room-observation").catch(() => null);
      if (settings) { base.models = settings.settings.models; base.modelId = settings.settings.current?.modelId ?? null;
        base.configuredModelId = pane.modelId; base.effectiveModelId = base.modelId; base.modelVerificationStatus = base.modelId ? "VERIFIED" : "UNKNOWN";
        if (base.state !== "EXITED" && base.state !== "ERROR") base.state = settings.settings.isTurnActive ? "RUNNING" : base.state === "WAITING_FOR_INPUT" ? base.state : "IDLE"; }
      base.modes = ["default", "plan"];
    } else if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
      const control = await resolveOpenCodeServerControl(session).catch(() => null);
      if (control) {
        base.nativeTaskRef = control.nativeSessionId;
        const inspection = await roomOpenCodeInspection(control).catch(() => null);
        if (inspection) {
          base.tasks = inspection.tasks;
          if (inspection.transcript && inspection.transcript.trim().length > 0) {
            base.text = redactMemoryText(inspection.transcript);
          }
        }
        const settings = await readPaneOpenCodeModelSettings(pane, session, "room-observation").catch(() => null);
        if (settings) {
          base.models = settings.settings.models; base.modelId = settings.settings.current?.modelId ?? null;
          base.configuredModelId = pane.modelId; base.effectiveModelId = base.modelId; base.modelVerificationStatus = base.modelId ? "VERIFIED" : "UNKNOWN";
        }
        const modes = await fetchOpenCodeAgentNames(control).catch(() => []);
        if (modes.length) base.modes = modes;
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          const terminalMode = roomOpenCodeTerminalState(screen.text, settings?.settings?.isTurnActive ?? false, base.modes ?? []);
          base.state = settings?.settings?.isTurnActive
            ? "RUNNING"
            : (terminalMode === "WAITING_FOR_INPUT" || rawState === "WAITING_FOR_INPUT")
            ? "WAITING_FOR_INPUT"
            : (terminalMode === "IDLE" || Boolean(control))
            ? "IDLE"
            : "UNKNOWN";
        }
      }
    } else if (session.runtimeId === "cli:gemini") {
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const rootPid = pids?.get(session.sessionId) ?? null;
      let catalog: Array<{ id: string; displayName: string }> = [];
      const runtime = findRuntime(await cliRuntimeRegistryCache.read(), session.runtimeId);
      if (runtime?.detectedCommandPath) {
        const loadedModels = await Promise.race([
          loadNativeCliModels(runtime.detectedCommandPath, session.accountProfileId),
          new Promise<Awaited<ReturnType<typeof loadNativeCliModels>>>((r) => setTimeout(() => r([]), 2000))
        ]).catch(() => []);
        catalog = loadedModels;
        base.models = loadedModels;
      }
      const usageList = await Promise.race([
        antigravityUsageProvider(),
        new Promise<{ data: any[] }>((r) => setTimeout(() => r({ data: [] }), 1500))
      ]).catch(() => ({ data: [] }));
      const fallbackVerification = {
        configuredModelId: session?.modelId ?? pane.modelId ?? null,
        effectiveModelId: null,
        modelVerificationStatus: "UNVERIFIED" as const,
        accountProfileId: session?.accountProfileId ?? "main",
        accountEmail: null,
        accountVerificationStatus: "UNVERIFIED" as const,
        verificationEvidence: { fallback: true },
        nativeTaskRef: null
      };
      const verified = await Promise.race([
        verifyGeminiPaneSession({
          pane,
          session,
          rootPid,
          screenText: screen.text,
          catalog,
          usageAccounts: usageList.data
        }),
        new Promise<any>((r) => setTimeout(() => r(fallbackVerification), 2000))
      ]).catch(() => fallbackVerification);

      if (verified.nativeTaskRef) {
        base.nativeTaskRef = verified.nativeTaskRef;
        const taskModel = verified.effectiveModelId ?? verified.configuredModelId ?? base.modelId;
        base.tasks = [{
          taskId: verified.nativeTaskRef,
          title: pane.title,
          status: "UNKNOWN",
          timing: { startedAt: session.startedAt ?? null, completedAt: null, durationMs: null, source: "OBSERVED", observedAt: nowIso() },
          modelsUsed: taskModel ? [{
            providerId: null,
            modelId: taskModel,
            reasoningEffort: null,
            turnId: null,
            startedAt: null,
            completedAt: null,
            source: "OBSERVED" as const
          }] : []
        }];
      }

      const native = await loadGeminiNativeTurns({ paneId: pane.id, sessionId: session.sessionId, rootPid }, { fresh: freshness?.fresh === true }).catch(() => null);
      if (native) {
        base.nativeTaskRef = native.conversationId;
        base.tasks = native.turns.map(({ finalResponse: _response, inputText: _input, aborted: _aborted, ...task }) => task);
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          const latest = native.turns.at(-1);
          if (latest?.status === "RUNNING" || rawState === "RUNNING") {
            base.state = "RUNNING";
          } else if (rawState === "WAITING_FOR_INPUT" || latest?.status === "INTERRUPTED" || latest?.aborted) {
            base.state = "WAITING_FOR_INPUT";
          } else if (latest?.status === "COMPLETED" || rawState === "UNKNOWN") {
            base.state = "IDLE";
          }
        }
      }

      base.configuredModelId = verified.configuredModelId;
      base.effectiveModelId = verified.effectiveModelId;
      base.modelVerificationStatus = verified.modelVerificationStatus;
      base.accountProfileId = verified.accountProfileId;
      base.accountEmail = verified.accountEmail;
      base.accountVerificationStatus = verified.accountVerificationStatus;
      base.verificationEvidence = verified.verificationEvidence as unknown as Record<string, unknown>;

      base.modelId = verified.effectiveModelId ?? verified.configuredModelId ?? base.modelId;
      base.modes = ["default", "plan"];
    } else if (isDeepSeekDirectParityRuntime(session.runtimeId)) {
      if (base.state !== "EXITED" && base.state !== "ERROR") {
        base.state = rawState === "RUNNING" ? "RUNNING" : rawState === "WAITING_FOR_INPUT" ? "WAITING_FOR_INPUT" : "IDLE";
      }
      base.modes = ["workspace", "read-only", "yolo", "plan"];
    } else if (isClaudeDirectParityRuntime(session.runtimeId)) {
      const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
      const native = claudeNative = await loadClaudeNativeTurns({
        paneId: pane.id, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null
      }, { fresh: freshness?.fresh === true }).catch(() => null);
      if (native) {
        base.nativeTaskRef = native.nativeSessionId;
        base.tasks = native.tasks;
        base.modelId = native.modelId ?? base.modelId;
        await recordClaudeNativeRef(session, native).catch(() => undefined);
        // Claude's own session status is authoritative over screen heuristics.
        if (base.state !== "EXITED" && base.state !== "ERROR") {
          base.state = native.busy ? "RUNNING" : base.state === "RUNNING" ? "IDLE" : base.state;
        }
      }
    }
    if (session.runtimeId === "cli:claude") base.modes = ["default", "plan", "accept edits", "bypass permissions", "auto"];
    if (session.runtimeId === "cli:omp" || session.runtimeId === "cli:droid") base.modes = ["build", "plan"];
    if (session.runtimeId === "cli:qoder") base.modes = ["yolo", "auto mode", "don't ask", "default", "accept edits", "plan"];
    base.modelId = await inspectedNativeModelId(session, readPaneNativeModelSettings, cliTerminalManager) ?? base.modelId;
    base.nativeMode = roomTerminalMode(session.runtimeId, screen.text, base.modes);
    base.usageLimited = cliUsageLimited(screen.text, claudeNative, session.startedAt);
    roomCliObservationCache.set(pane.id, { expires: Date.now() + 15_000, data: base });
    return base;
  }
  async function commandRoomCli(pane: Pane, action: RoomCommandAction, traceId: string): Promise<Record<string, unknown>> {
    roomCliObservationCache.delete(pane.id);
    const session = await roomCliSession(pane, action.expectedSessionId);
    const startMs = Date.now();
    // One key per command: Nous's trace is per turn, so a second answer or key to the same pane in a turn was dropped (review 2026-10-24).
    const inputKey = `${traceId}:${randomUUID()}`;
    const COMMAND_WATCHDOG_TIMEOUT_MS = 8000;

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdogPromise = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(() => {
        reject(new Error("COMMAND_WATCHDOG_TIMEOUT"));
      }, COMMAND_WATCHDOG_TIMEOUT_MS);
    });

    const mutationPromise = cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
      await roomCliSession(pane, action.expectedSessionId);
      const before = await cliTerminalManager.observeRoomScreen(session.sessionId);
      if (action.answer !== undefined) {
        // Answer only the question that was inspected; a changed screen means a different question.
        const fingerprint = roomPromptFingerprint(redactMemoryText(before.text));
        if (action.expectedPromptFingerprint && action.expectedPromptFingerprint !== fingerprint)
          throw new SpaceConflictError("The pane's question changed since it was inspected; inspect it again before answering.");
        if (!action.expectedPromptFingerprint && roomTerminalState(before.text) !== "WAITING_FOR_INPUT")
          throw new SpaceConflictError("The pane is not waiting for an answer; inspect it again.");
        // Text with Enter is a prompt; a single key ("1", "y") or text without Enter goes as keys, for menus.
        if (action.submit !== false && action.answer.length > 1) {
          await submitCliPrompt(cliTerminalManager, session.sessionId, action.answer, traceId, `${inputKey}:answer`,
            { assertCurrent: () => roomCliSession(pane, action.expectedSessionId) });
        } else {
          if (action.answer) await cliTerminalManager.sendInput(session.sessionId, action.answer, traceId, null, `${inputKey}:answer`);
          if (action.submit !== false) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await roomCliSession(pane, action.expectedSessionId);
            await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-answer`);
          }
        }
      }
      if (action.command) {
        await cliTerminalManager.sendInput(session.sessionId, action.command, traceId, null, `${inputKey}:command`);
        // Let native paste/burst detection finish before Enter. Otherwise
        // Codex retains even a short slash command as an unsubmitted line.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await roomCliSession(pane, action.expectedSessionId);
        await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-command`);
        // Antigravity / Gemini CLI displays an interactive autocomplete menu for slash
        // commands. The first Enter selects the menu item into the input line; a second
        // Enter is required to submit the command.
        if (action.command.startsWith("/") && session.runtimeId === "cli:gemini") {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await roomCliSession(pane, action.expectedSessionId);
          await cliTerminalManager.sendInput(session.sessionId, "\r", traceId, null, `${inputKey}:submit-command-confirm`);
        }
      }
      if (action.key) {
        const keys = { UP: "\u001b[A", DOWN: "\u001b[B", LEFT: "\u001b[D", RIGHT: "\u001b[C", ENTER: "\r", ESCAPE: "\u001b", TAB: "\t", SHIFT_TAB: "\u001b[Z" };
        await cliTerminalManager.sendInput(session.sessionId, keys[action.key], traceId, null, `${inputKey}:key`);
      }
      let screen = before;
      const typed = Boolean(action.command || action.key || action.answer !== undefined);
      for (let attempt = 0; typed && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await roomCliSession(pane, action.expectedSessionId);
        screen = await cliTerminalManager.observeRoomScreen(session.sessionId);
        if (screen.revision !== before.revision) break;
      }
      if (typed && screen.revision === before.revision) throw new SpaceConflictError("CLI command produced no observable response.");
      if (/unknown command|unrecognized command|invalid slash command/i.test(screen.text)) throw new SpaceConflictError("The CLI rejected the command.");
      if (action.selection) screen = await selectRoomCliMenuRow({ screen, selection: action.selection, command: action.command,
        send: (data, step) => cliTerminalManager.sendInput(session.sessionId, data, traceId, null, `${inputKey}:${step}`),
        observe: async () => { await roomCliSession(pane, action.expectedSessionId); return cliTerminalManager.observeRoomScreen(session.sessionId); } });
      return { sessionId: session.sessionId, command: action.command, selection: action.selection ?? null,
        key: action.key ?? null, answered: action.answer !== undefined, state: roomTerminalState(screen.text), text: redactMemoryText(screen.text), checkedAt: nowIso() };
    });

    try {
      return await Promise.race([mutationPromise, watchdogPromise]);
    } catch (error) {
      if (error instanceof Error && error.message === "COMMAND_WATCHDOG_TIMEOUT") {
        const interruptKey = roomTerminalInterruptKey(session.runtimeId);
        await cliTerminalManager.sendInput(session.sessionId, interruptKey, traceId, null, `${inputKey}:watchdog:interrupt`).catch(() => {});
        await cliTerminalManager.sendInput(session.sessionId, "\u001b", traceId, null, `${inputKey}:watchdog:esc`).catch(() => {});
        const cmdName = action.command ? `command "${action.command}"` : (action.key ? `key "${action.key}"` : "operation");
        const alertMessage = `Room Watchdog: Auto-killed hanging ${cmdName} in pane "${pane.title}" (${session.runtimeId}) after 8s to prevent room freeze.`;
        const watchdogEvent = eventSchema.parse({
          id: makeSpaceId("event"),
          roomId: pane.roomId,
          paneId: pane.id,
          turnId: null,
          workflowId: null,
          traceId,
          type: "ROOM_WATCHDOG_ALERT",
          message: alertMessage,
          payload: {
            kind: "ROOM_FREEZE_PREVENTED",
            source: "commandRoomCli",
            roomId: pane.roomId,
            paneId: pane.id,
            paneTitle: pane.title,
            runtimeId: session.runtimeId,
            command: action.command ?? action.key ?? null,
            durationMs: Date.now() - startMs,
            killedAt: nowIso()
          },
          createdAt: nowIso()
        });
        const recorded = await Promise.resolve(store.recordRoomEvent(watchdogEvent)).catch(() => null);
        eventBus.publish(recorded ?? watchdogEvent);
        throw new SpaceConflictError(alertMessage);
      }
      throw error;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }
  }
  const assertNoManagedModelMutation = (paneId: string) => assertUnmanagedPlanPane(store, paneId);
  const claudeAccountSwitchDeps: ClaudeAccountSwitchDeps = { store, inspect: (target) => inspectRoomCli(target, { fresh: true }), now: nowIso, interrupt: (id) => cliTerminalManager.interrupt(id),
    resume: (target, input, trace) => resumePaneCliTask(target, input, trace, undefined, true), ensureReady: (target, trace, selection) => cliTerminalManager.ensurePaneControlReady(target, trace, selection) };
  const roomPaneController = createRoomPaneController({
    store, chat: spaceAgentAdapter, listRuntimes: () => cliTerminalManager.listRuntimes(),
    isEnabled: (runtimeId) => cliRuntimeVisibility.isEnabled(runtimeId),
    chatTypes: () => spaceAgentAdapter.listRoomChatTypes?.() ?? Promise.resolve([]),
    async chatTasks(pane) {
      const session = await store.getActiveSpaceAgentSession(pane.id);
      if (!session) return [];
      if (session.selectedProviderId?.includes("opencode")) {
        const control = await readOpenCodeServerControl(session.sessionId, openCodeSpaceChatStateRoot);
        return control ? roomOpenCodeTasks(control) : [];
      }
      return session.threadId ? findCodexTaskTimeline({ codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex", threadId: session.threadId }) : [];
    },
    inspectCli: inspectRoomCli, commandCli: commandRoomCli,
    async configureCli(pane, action, traceId) {
      const session = await roomCliSession(pane, action.expectedSessionId);
      if (action.modelId || action.reasoningEffort) {
        await assertNoManagedModelMutation(pane.id);
        if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
          const control = await resolveOpenCodeServerControl(session);
          const before = await readPaneOpenCodeModelSettings(pane, session, traceId);
          const modelId = action.modelId ?? before.settings.current?.modelId;
          const model = before.settings.models.find((entry) => entry.id === modelId);
          const ref = modelId ? parseOpenCodeCompositeModelId(modelId) : null;
          if (!model || !ref) throw new SpaceConflictError("The model is not advertised by this CLI.");
          const reasoning = action.reasoningEffort ?? model.defaultReasoningEffort;
          await applyOpenCodePaneSelection(pane, session, model, reasoning, traceId, undefined, before.settings.models);
          const after = await readPaneOpenCodeModelSettings(pane, session, traceId);
          if (after.settings.current?.modelId !== model.id) throw new SpaceConflictError("OpenCode model readback did not confirm the requested model.");
          await store.updatePaneCliSession(session.sessionId, { modelId: model.id, reasoningEffort: reasoning }, traceId);
        } else if (isCodexDirectParityRuntime(session.runtimeId)) {
          await applyUnmanagedCodexModelSettings(store,pane.id,{
            inspect: async () => {
              const before = await readPaneCliModelSettings(pane, session, traceId);
              const modelId = action.modelId ?? before.settings.current?.modelId;
              const model = before.settings.models.find((entry) => entry.id === modelId);
              const reasoning = action.reasoningEffort ?? before.settings.current?.reasoningEffort ?? model?.defaultReasoningEffort;
              if (!model || !reasoning || !model.supportedReasoningEfforts.includes(reasoning)) throw new SpaceConflictError("The model/reasoning combination is not advertised by this CLI.");
              return {before,model,reasoning};
            },
            assertCurrent: async ({before}) => {
              const current = await roomCliSession(pane, action.expectedSessionId);
              // Like the pane picker: a fresh TUI's task reaches the DB only after its first turn is saved.
              const liveThreadId = before.primaryThreadId !== undefined ? await before.directControl.readCurrentThreadId?.() : current.codexThreadId;
              if (liveThreadId !== before.settings.threadId || current.cwd !== session.cwd)
                throw new SpaceConflictError("The native Codex thread changed before model control.");
            },
            updateSettings: async ({before,model,reasoning},beforeSend) => {
              if (before.settings.threadId) await before.directControl.updateThreadSettings({
                threadId: before.settings.threadId, model: model.id, reasoningEffort: reasoning, beforeSend });
            },
            updateRouter: async ({before,model,reasoning}) => {
              // Keep the TUI's collaboration-mode router in sync with this explicit
              // selection while managed creation is excluded from the pane.
              // The fence checked the live thread; the router guards the DB's (null until a fresh TUI's first turn is saved).
              await cliTerminalManager.updateCodexNativeModelSettings({ sessionId: session.sessionId,
                expectedThreadId: before.session.codexThreadId, models: before.settings.models, modelId: model.id, reasoningEffort: reasoning, traceId });
            },
            finish: async ({before,model,reasoning}) => {
              if (before.settings.threadId) await waitForCodexThreadSettings({ threadId: before.settings.threadId, cwd: session.cwd, sessionId: session.sessionId, modelId: model.id, reasoningEffort: reasoning, models: before.settings.models });
              await store.updatePaneCliSession(session.sessionId, { modelId: model.id, reasoningEffort: reasoning }, traceId);
            }
          });
        } else if (session.runtimeId === "cli:omp") {
          const command = `/switch ${action.modelId}${action.reasoningEffort && action.reasoningEffort !== "none" ? `:${action.reasoningEffort}` : ""}`;
          await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command, when: action.when }, traceId);
          if (action.modelId) await store.updatePaneCliSession(session.sessionId, { modelId: action.modelId, reasoningEffort: action.reasoningEffort }, traceId);
        } else if (session.runtimeId === "cli:cursor") {
          await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command: `/model ${action.modelId}`, when: action.when }, traceId);
          if (action.modelId) await store.updatePaneCliSession(session.sessionId, { modelId: action.modelId }, traceId);
        } else {
          // Same verified native switch as the pane picker (screen readback, pane pick persisted);
          // the plain /model menu stays the fallback while a turn runs or the catalog lacks the model.
          const isClaude = session.runtimeId === "cli:claude";
          const before = (action.modelId || isClaude) && isDirectOperatorParityRuntime(session.runtimeId)
            ? await readPaneNativeModelSettings(session).catch(() => null) : null;
          const requested = action.modelId ?? (isClaude ? before?.current?.modelId : undefined);
          const model = before && requested ? findNativeCliModel(before.models, requested, session.runtimeId) : undefined;
          const reasoning = model ? action.reasoningEffort ?? model.defaultReasoningEffort ?? before?.current?.reasoningEffort : undefined;
          if (before && model && reasoning && model.supportedReasoningEfforts.includes(reasoning) && !before.isTurnActive) {
            await cliTerminalManager.runSerializedTerminalMutation(session.sessionId, () => applyNativePaneModel({
              pane, active: session, modelId: model.id, reasoningEffort: reasoning, traceId,
              assertControl: async (current) => { if (current.sessionId !== session.sessionId) throw new SpaceConflictError("The CLI session changed during the model switch."); }
            }));
          } else if (isClaude) {
            // Claude's /model menu lists families, never ids, and Enter there saves the profile's shared default.
            throw new SpaceConflictError(!before ? "The Claude model catalog is unavailable; try again shortly."
              : before.isTurnActive ? "Claude is working; change its model after the current turn."
              : `Claude offers ${before.models.map((entry) => `${entry.id} (${entry.supportedReasoningEfforts.join("/")})`).join(", ")}.`);
          } else await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
            command: "/model", selection: action.modelId ?? action.reasoningEffort, when: action.when }, traceId);
        }
      }
      if (action.nativeMode) {
        const mode = action.nativeMode.toLowerCase() === "build" && session.runtimeId === "cli:codex" ? "default" : action.nativeMode.toLowerCase();
        const codexSettings = isCodexDirectParityRuntime(session.runtimeId)
          ? await readPaneCliModelSettings(pane, session, traceId) : null;
        const before = await inspectRoomCli(pane);
        if (before.nativeMode !== mode) {
          if (before.modes && !before.modes.includes(mode)) throw new SpaceConflictError("The requested mode is not advertised by this CLI.");
          if (mode === "plan" && ["cli:codex", "cli:gemini", "cli:qwen"].includes(session.runtimeId)) {
            await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId, command: "/plan", when: action.when }, traceId);
          } else if ((session.runtimeId === "cli:omp" || session.runtimeId === "cli:qoder") && (mode === "plan" || before.nativeMode === "plan")) {
            // Plan is a /plan toggle here; Shift+Tab changes thinking effort (Oh My Pi) or permissions (Qoder).
            await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId, command: "/plan", when: action.when }, traceId);
          } else {
            if (!before.nativeMode) throw new SpaceConflictError("The current native mode is not visible; inspect the CLI menu before switching.");
            let previous = before.nativeMode;
            for (let attempt = 0; attempt < 8; attempt++) {
              await roomCliSession(pane, action.expectedSessionId);
              await cliTerminalManager.sendInput(session.sessionId, "\u001b[Z", traceId, null, `${traceId}:mode:${attempt}`);
              let changed: string | null = null;
              for (let poll = 0; poll < 15; poll++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                await roomCliSession(pane, action.expectedSessionId);
                const screen = await cliTerminalManager.observeRoomScreen(session.sessionId);
                changed = roomTerminalMode(session.runtimeId, screen.text, before.modes);
                if (changed && changed !== previous) break;
              }
              if (!changed || changed === previous) throw new SpaceConflictError("The CLI did not confirm a mode change; no further cycle keys were sent.");
              if (changed === mode || changed === before.nativeMode) break;
              previous = changed;
            }
          }
          let after = await inspectRoomCli(pane);
          for (let poll = 0; after.nativeMode !== mode && poll < 20; poll++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await roomCliSession(pane, action.expectedSessionId);
            after = await inspectRoomCli(pane);
          }
          if (after.nativeMode !== mode) throw new SpaceConflictError("CLI mode readback is unconfirmed; inspect the current pane before retrying.");
          // Native collaboration presets can restore a different model/effort
          // when cycling. A mode-only request must retain the user's selection.
          if (codexSettings?.settings.current) {
            await roomCliSession(pane, action.expectedSessionId);
            const { modelId, reasoningEffort } = codexSettings.settings.current;
            const threadId = codexSettings.settings.threadId;
            if (threadId) await codexSettings.directControl.updateThreadSettings({ threadId, model: modelId, reasoningEffort });
            if (threadId && mode === "plan") {
              // The model picker can emit Default collaboration settings. Keep
              // the router's manual pair and refresh the native Plan composer
              // through its own command instead of cycling back through Default.
              await commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: session.sessionId,
                command: "/plan", when: action.when }, traceId);
            } else {
              await cliTerminalManager.updateCodexNativeModelSettings({ sessionId: session.sessionId,
                expectedThreadId: threadId, modelId, reasoningEffort, models: codexSettings.settings.models, traceId });
            }
            if (threadId) {
              await waitForCodexThreadSettings({ threadId, cwd: session.cwd, sessionId: session.sessionId,
                modelId, reasoningEffort, models: codexSettings.settings.models });
            }
            if ((await inspectRoomCli(pane)).nativeMode !== mode) throw new SpaceConflictError("Restoring model settings changed the requested native mode.");
          }
        }
      }
      if (action.accountProfileId !== undefined) {
        if (session.runtimeId === "cli:gemini") {
          const targetProfile = action.accountProfileId;
          if (targetProfile && targetProfile !== "main") {
            const profiles = await discoverAntigravityProfiles();
            if (!profiles.some((p) => p.profileId === targetProfile)) {
              throw new SpaceConflictError(`Antigravity account profile "${targetProfile}" is not found.`);
            }
          }
          if (session.accountProfileId !== targetProfile) {
            let convId = await readGeminiPaneConversation(pane.id).catch(() => null);
            if (!convId && session.codexThreadId && geminiNativeConversationIdPattern.test(session.codexThreadId.trim())) {
              convId = session.codexThreadId.trim();
            }
            if (!convId) {
              const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
              const rootPid = pids?.get(session.sessionId) ?? null;
              if (rootPid) {
                convId = await readGeminiNativeConversationIdFromProcessTree(rootPid).catch(() => null);
              }
            }
            if (convId) {
              await writeGeminiPaneConversation(pane.id, convId);
            }
            if (session.isActive && session.status !== "EXITED") {
              const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
              const rootPid = pids?.get(session.sessionId) ?? null;
              if (rootPid) {
                try { process.kill(rootPid, "SIGTERM"); } catch {}
              }
              await store.updatePaneCliSession(
                session.sessionId,
                { status: "EXITED", isActive: false, endedAt: nowIso(), statusReason: "Account profile switched" },
                traceId
              );
              const cleanId = normalizeGeminiPaneId(pane.id);
              await unlink(`/opt/spaceapp/var/gemini-pane-conversations/pane-${cleanId}.json`).catch(() => {});
              await unlink(`/opt/spaceapp/var/gemini-pane-conversations/pane-pane:${cleanId}.json`).catch(() => {});
              await cliTerminalManager.ensurePaneControlReady(pane, traceId, { accountProfileId: targetProfile });
            } else {
              await store.updatePaneCliSession(session.sessionId, { accountProfileId: targetProfile }, traceId);
            }
          }
        } else if (session.runtimeId === "cli:claude") {
          if (await switchClaudePaneAccount(claudeAccountSwitchDeps, pane, session, action.accountProfileId, traceId)) roomCliObservationCache.delete(pane.id);
        } else {
          throw new SpaceConflictError("Account profile switching is supported on Gemini and Claude Code panes.");
        }
      }
      return { observation: await inspectRoomCli(pane) };
    },
    async startCli(pane, traceId) {
      const session = await cliTerminalManager.ensurePaneControlReady(pane, traceId);
      roomCliObservationCache.delete(pane.id);
      return { sessionId: session.sessionId, state: session.status };
    },
    async resumeCli(pane, taskId, traceId) {
      if (pane.terminalRuntimeId && !isCodexDirectParityRuntime(pane.terminalRuntimeId) && !isOpenCodeDirectParityRuntime(pane.terminalRuntimeId)) {
        const source = taskId ? await unifiedCliTaskRegistry.getTask(taskId, [pane.terminalRuntimeId]) : null;
        if (source && source.session.roomId !== pane.roomId) throw new SpaceConflictError("Room Agent can resume only tasks belonging to this room.");
        if (source && hasExactNativeTaskResume(pane.terminalRuntimeId)) {
          // Runtimes with a registered native task resolver (cli-native-task-resume.ts) resume that exact
          // task like Codex and OpenCode; the native /resume menu stays the fallback when no ref is available.
          try {
            const result = await resumePaneCliTask(pane, { taskId: source.taskId }, traceId, undefined, true);
            const resumed = await cliTerminalManager.ensurePaneControlReady(result.pane, traceId);
            return { paneId: pane.id, sessionId: resumed.sessionId, mode: result.mode, state: resumed.status };
          } catch (error) {
            if (!(error instanceof SpaceConflictError) || !error.message.startsWith("Exact native resume is unavailable")) throw error;
          }
        }
        const ready = await cliTerminalManager.ensurePaneControlReady(pane, traceId);
        return resumeRoomCliFromMenu({ paneId: pane.id, ready, source, command: (selection) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id,
          expectedSessionId: ready.sessionId, command: "/resume", ...(selection ? { selection } : {}), when: "AFTER_TURN" }, traceId) });
      }
      const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id,1))[0];
      const ref = taskId ?? session?.cliTaskId;
      if (!ref) throw new SpaceConflictError("Inspect task history and choose an existing native task to resume.");
      const result = await resumePaneCliTask(pane, { taskId: ref }, traceId, undefined, true);
      const ready = await cliTerminalManager.ensurePaneControlReady(result.pane, traceId);
      return { paneId: pane.id, sessionId: ready.sessionId, mode: result.mode, state: ready.status };
    },
    async interruptCli(pane, traceId) {
      const active = await store.getActivePaneCliSession(pane.id);
      if (!active || active.status === "EXITED" || pane.isClosed) return { interrupted: false, state: "EXITED" };
      const session = await roomCliSession(pane);
      let interrupted = false;
      if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
        const control = await resolveOpenCodeServerControl(session);
        await abortOpenCodeSession(control, control.nativeSessionId);
        interrupted = true;
      } else if (isCodexDirectParityRuntime(session.runtimeId)) {
        const before = await readPaneCliModelSettings(pane, session, traceId).catch(() => null);
        if (before?.settings.threadId && before.activity?.turnId && before.settings.isTurnActive) {
          try {
            await before.directControl.interruptTurn({ threadId: before.settings.threadId, turnId: before.activity.turnId });
            interrupted = true;
          } catch {}
        }
        if (!interrupted) {
          await cliTerminalManager.sendInput(session.sessionId, "\u001b", traceId, null, `${traceId}:interrupt:esc`);
          interrupted = true;
        }
      } else {
        const key = roomTerminalInterruptKey(session.runtimeId);
        await cliTerminalManager.sendInput(session.sessionId, key, traceId, null, `${traceId}:interrupt:1`);
        interrupted = true;
      }
      return { sessionId: session.sessionId, interrupted, observation: await inspectRoomCli(pane) };
    }
  });

  const roomActionExecutor =
    options.roomActionExecutor ??
    createRoomActionExecutor({
      store,
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
    discover: () => cliRuntimeRegistryCache.readStaleWhileRefreshing(),
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
    const response = await app.inject({method,url,headers:{cookie:`${cookieName}=${token}`,
      [csrfHeaderName]:createCsrfToken(token,auth.sessionSecret)!,...(payload===undefined?{}:{"content-type":"application/json"})},
      ...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
    const body = response.headers["content-type"]?.includes("application/json") ? response.json() : {content:response.body.slice(0,100_000),mimeType:response.headers["content-type"]};
    if(response.statusCode>=400)throw new SpaceConflictError(body.error?.message??"Protected control failed.");
    return body;
  }
  const controlCliRooms = new WeakMap<FastifyRequest,string>();
  async function controlQuota(pane:Pane){
    if(pane.mode==="TERMINAL"&&pane.terminalRuntimeId==="cli:gemini"){
      const session=await store.getActivePaneCliSession(pane.id)??(await store.listPaneCliSessions(pane.id,1))[0];
      const pids = session ? await cliTerminalManager.activeSessionPids([session]).catch(() => null) : null;
      const rootPid = session ? (pids?.get(session.sessionId) ?? null) : null;
      const usageList = await antigravityUsageProvider().catch(() => ({ data: [] }));
      const verified = await verifyGeminiPaneSession({
        pane,
        session,
        rootPid,
        usageAccounts: usageList.data
      });

      const activeProfileId = verified.accountProfileId;
      const account = activeProfileId
        ? (usageList.data.find(a => a.id === activeProfileId) ||
           (verified.accountEmail ? usageList.data.find(a => a.email === verified.accountEmail) : undefined))
        : undefined;

      const windows: Array<{window:string; remainingPercent:number|null; resetAt:string|null}> = [];
      if(account?.gemini?.fiveHourRemainingPercent!==null&&account?.gemini?.fiveHourRemainingPercent!==undefined){
        windows.push({window:"5h",remainingPercent:account.gemini.fiveHourRemainingPercent,resetAt:account.gemini.fiveHourResetAt??null});
      }
      if(account?.gemini?.weeklyRemainingPercent!==null&&account?.gemini?.weeklyRemainingPercent!==undefined){
        windows.push({window:"weekly",remainingPercent:account.gemini.weeklyRemainingPercent,resetAt:account.gemini.weeklyResetAt??null});
      }
      const isConnected = account?.status === "CONNECTED";
      const hasQuota = (account?.gemini?.fiveHourRemainingPercent ?? 0) > 0;
      const isVerified = verified.accountVerificationStatus === "VERIFIED";
      const allowed = Boolean(activeProfileId) && isConnected && hasQuota;
      const reason = !activeProfileId
        ? "Google account profile is unknown."
        : !account
        ? `Google account profile "${activeProfileId}" has no quota data.`
        : account.status === "UNLICENSED"
        ? "Google account is unlicensed."
        : (account.gemini?.fiveHourRemainingPercent === 0)
        ? "Google Gemini 5-hour quota is exhausted."
        : !isVerified
        ? `Google account profile "${activeProfileId}" has available quota, but is unverified on live process.`
        : windows.length
        ? "Google account quota is available."
        : "Google account quota windows are unknown.";

      return {
        paneId: pane.id,
        sessionId: session?.sessionId ?? null,
        runtimeId: "cli:gemini",
        accountProfileId: activeProfileId,
        accountEmail: verified.accountEmail ?? account?.email ?? null,
        accountVerificationStatus: verified.accountVerificationStatus,
        configuredModelId: verified.configuredModelId,
        effectiveModelId: verified.effectiveModelId,
        modelVerificationStatus: verified.modelVerificationStatus,
        email: verified.accountEmail ?? account?.email ?? null,
        tier: account?.tier ?? null,
        status: account?.status ?? "UNKNOWN",
        gemini: account?.gemini ?? null,
        claude: account?.claude ?? null,
        windows,
        blocked: !allowed,
        allowed,
        reason,
        verificationEvidence: verified.verificationEvidence
      };
    }
    if(pane.mode!=="TERMINAL"||pane.terminalRuntimeId!=="cli:codex")throw new SpaceConflictError("Native quota requires a Codex or Gemini CLI pane.");
    const session=await store.getActivePaneCliSession(pane.id)??(await store.listPaneCliSessions(pane.id,1))[0];
    if(!session)throw new SpaceConflictError("Codex session identity is unavailable.");
    const observed=await readPaneCliModelSettings(pane,session,"control-quota");
    const quota=await observed.directControl.readRateLimits?.();
    if(!quota)throw new SpaceConflictError("Native quota source is unavailable for this runtime.");
    return {...quota,paneId:pane.id,sessionId:session.sessionId,nativeTaskRef:observed.settings.threadId,
      allowed:quota.windows.length>0&&!quota.blocked,reason:quota.blocked?"Native account quota is exhausted.":quota.windows.length?"Native account quota is available.":"Native quota windows are unknown."};
  }
  const controlSend = async(pane: Pane, text: string, traceId: string) => {
    roomCliObservationCache.delete(pane.id);
    try {
    if(pane.mode==="CHAT"){
      // Control request IDs can occupy all 128 characters. The native Chat
      // workflow adds room/pane prefixes, so derive a bounded stable trace.
      const chatTraceId=createHash("sha256").update(JSON.stringify([traceId,pane.id])).digest("hex").slice(0,32);
      const result=await spaceAgentAdapter.sendMessage({pane,content:text,traceId:chatTraceId});
      return {sessionId:result.session.binding.sessionId,state:result.session.runStatus,submitted:true};
    }
    if(text.length>20_000)throw new SpaceConflictError("CLI prompts support at most 20,000 characters per turn.");
    const session=await roomCliSession(pane);
    if(isOpenCodeDirectParityRuntime(session.runtimeId)){
      const control=await resolveOpenCodeServerControl(session);
      const turnActive=await readOpenCodeSessionTurnActive(control,control.nativeSessionId);if(turnActive!==false)throw new SpaceConflictError(turnActive?"OpenCode already has an active turn.":"OpenCode did not report whether a turn is running; try again.");
      if(!(await sendOpenCodePrompt(control,control.nativeSessionId,text)))throw new SpaceConflictError("OpenCode rejected prompt injection.");
      for(let attempt=0;attempt<2;attempt++){
        await new Promise(r=>setTimeout(r,30));
        if(await fetchOpenCodeSessionIsTurnActive(control,control.nativeSessionId)){
          return {sessionId:session.sessionId,nativeTaskRef:control.nativeSessionId,state:"RUNNING",submitted:true};
        }
      }
      return {sessionId:session.sessionId,nativeTaskRef:control.nativeSessionId,state:"RUNNING",submitted:true};
    }
    if(isCodexDirectParityRuntime(session.runtimeId)){
      return cliTerminalManager.runSerializedTerminalMutation(session.sessionId,async()=>{
        const before=await readPaneCliModelSettings(pane,session,traceId).catch(()=>null);
        if(before?.settings?.isTurnActive)throw new SpaceConflictError("Codex already has an active turn.");
        if(before?.settings?.threadId){
          const turn=await before.directControl.startTurn({threadId:before.settings.threadId,prompt:text,
            ...(before.settings.current?{model:before.settings.current.modelId,reasoningEffort:before.settings.current.reasoningEffort}:{}),
            clientUserMessageId:`space-control:${traceId}:${pane.id}`.slice(0,200)});
          return {sessionId:session.sessionId,nativeTaskRef:before.settings.threadId,turnId:turn.turnId,state:turn.status,submitted:true};
        }
        await submitCliPrompt(cliTerminalManager,session.sessionId,text,traceId,`${traceId}:${pane.id}`);
        return {sessionId:session.sessionId,nativeTaskRef:before?.settings?.threadId??session.sessionId,state:"RUNNING",submitted:true};
      });
    }
    return cliTerminalManager.runSerializedTerminalMutation(session.sessionId,async()=>{
      const observed=await inspectRoomCli(pane);
      if(observed.state==="RUNNING")throw new SpaceConflictError("CLI already has an active turn.");
      await submitCliPrompt(cliTerminalManager,session.sessionId,text,traceId,`${traceId}:${pane.id}`,{waitForComposer:true,gapMs:40});
      return {sessionId:session.sessionId,nativeTaskRef:observed.nativeTaskRef??session.sessionId,state:"RUNNING",submitted:true};
    });
    } finally {
      roomCliObservationCache.delete(pane.id);
      dashboardAgentsCache.delete(pane.roomId);
    }
  };
  const paneStateCache = new Map<string, { expires: number; data: Record<string, unknown> | null }>();
  const dashboardAgentsCache = new Map<string, { expires: number; data: { data: Pane[]; activity: Record<string, DashboardStatus>; details: Record<string, DashboardActivityDetail>; sampledAt: string } }>();
  const readCliDashboardActivity = createCliDashboardActivityReader({
    screenText: async session => (await cliTerminalManager.observeRoomScreen(session.sessionId)).text,
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
  const readDashboardAgents = async (roomId: string): Promise<DashboardAgentsSample> => {
    const cached = dashboardAgentsCache.get(roomId);
    if (cached && cached.expires > Date.now()) return cached.data;
    const data = (await store.listPanes(roomId)).filter(pane => !pane.isClosed);
    const { activity, details } = await readDashboardActivity(data, store, readCliDashboardActivity);
    if (Object.values(details).some((detail) => detail?.status === "done")) installTelemetry.firstAnswer.observe();
    const result = { data, activity, details, sampledAt: nowIso() };
    dashboardAgentsCache.set(roomId, { expires: Date.now() + 2500, data: result });
    return result;
  };
  const roomAgentSnapshots = createRoomAgentSnapshotProvider({ listPanes: async roomId => store.listPanes(roomId), readActivity: readDashboardAgents });
  // A rail-tab CLI pane's headless start and whether its session record has a live host process (Space Control and Nous).
  const railCli = { start: (pane: Pane) => roomPaneController.start(pane, makeSpaceId("trace")), hostRunning: async (session: PaneCliSession) => (await cliTerminalManager.activeSessionPids([session]).catch(() => new Map())).has(session.sessionId) };
  const spaceControl = createSpaceControl({store,repository:controlRepository,controller:roomPaneController,decisionsService,phase:2,pluginsService,queueDisconnected:true,
    startRailCli: (actor, pane) => startPaneCli({ invoke: controlInvoke, store, ...railCli }, actor.id, pane),
    captureScreenshot: process.env.VITEST === "true" ? undefined : createControlScreenshotCapture({ instance: config.instance, cookieName, sessionSecret: auth.sessionSecret, artifactRoot: config.browserEvidenceArtifactRoot, resolveUser: controlUser, createArtifact: async (input) => store.createArtifact(input),
      fitTerminals: createCaptureTerminalFit({ getRoom: async (id) => store.getRoom(id), getPane: async (id) => store.getPane(id),
        fitPaneTerminal: (paneId, cols, rows) => cliTerminalManager.fitPaneTerminal(paneId, cols, rows), recordAuditEvent: async (input) => store.recordAuditEvent(input) }) }),
    publish:async roomId=>{const event=await getLatestRoomEvent(store,roomId);if(event)eventBus.publish(event);},
    publishEvent: (event) => eventBus.publish(event),
    resolveActor: controlUser,
    checkQuota:controlQuota,
    requireClientAcknowledgement:true,
    describePaneTypes: async (roomId?: string) => {
      const entries = await roomPaneCommands.catalog();
      const types = PANE_TYPES.map((def) => {
        const entry = entries.find((e) => e.definition.typeId === def.typeId);
        return {
          typeId: def.typeId,
          label: def.label,
          kind: def.mode === "TERMINAL" ? `CLI:${(def as { runtimeId?: string }).runtimeId ?? def.typeId}` : def.mode,
          countsKey: def.typeId,
          available: entry?.available ?? false,
          ...(entry?.available ? {} : { reason: entry?.reason ?? "Unavailable." })
        };
      });
      let roomCap: number | null = null;
      if (roomId) {
        try { roomCap = (await store.getRoom(roomId)).paneCap; } catch {}
      }
      return { types, roomCap };
    },
    inspectPaneState: async(pane: Pane) => {
      const cached = paneStateCache.get(pane.id);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      const doInspect = async (): Promise<Record<string, unknown> | null> => {
        if (pane.mode === "YOUTUBE") {
          try {
            const pb = await youtubePlaybackStore.getByPaneId(pane.id);
            const effectiveTitle = pb?.title || (pane.title && !/^YouTube( \d+)?$/i.test(pane.title) ? pane.title : null);
            if (effectiveTitle || pb?.videoId) {
              return {
                mediaTitle: effectiveTitle,
                mediaVideoId: pb?.videoId || null,
                mediaSeconds: pb?.seconds || 0
              };
            }
          } catch {}
          return null;
        }
        if (pane.mode === "TERMINAL" && pane.terminalRuntimeId === "cli:gemini") {
          const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
          const pids = session ? await cliTerminalManager.activeSessionPids([session]).catch(() => null) : null;
          const rootPid = session ? (pids?.get(session.sessionId) ?? null) : null;
          const usageList = await Promise.race([
            antigravityUsageProvider(),
            new Promise<{ data: any[] }>((r) => setTimeout(() => r({ data: [] }), 1500))
          ]).catch(() => ({ data: [] }));
          let catalog: Array<{ id: string; displayName: string }> = [];
          const runtime = findRuntime(await cliRuntimeRegistryCache.read(), pane.terminalRuntimeId);
          if (runtime?.detectedCommandPath) {
            catalog = await Promise.race([
              loadNativeCliModels(runtime.detectedCommandPath, session?.accountProfileId),
              new Promise<Array<{ id: string; displayName: string }>>((r) => setTimeout(() => r([]), 2000))
            ]).catch(() => []);
          }
          const fallbackVerification = {
            configuredModelId: session?.modelId ?? pane.modelId ?? null,
            effectiveModelId: null,
            modelVerificationStatus: "UNVERIFIED",
            accountProfileId: session?.accountProfileId ?? "main",
            accountEmail: null,
            accountVerificationStatus: "UNVERIFIED",
            verificationEvidence: {}
          };
          const verified = await Promise.race([
            verifyGeminiPaneSession({
              pane,
              session,
              rootPid,
              catalog,
              usageAccounts: usageList.data
            }),
            new Promise<typeof fallbackVerification>((r) => setTimeout(() => r(fallbackVerification), 2000))
          ]).catch(() => fallbackVerification);
          return {
            configuredModelId: verified.configuredModelId,
            effectiveModelId: verified.effectiveModelId,
            modelVerificationStatus: verified.modelVerificationStatus,
            accountProfileId: verified.accountProfileId,
            accountEmail: verified.accountEmail,
            accountVerificationStatus: verified.accountVerificationStatus,
            verificationEvidence: verified.verificationEvidence as unknown as Record<string, unknown>
          };
        }
        if (pane.mode === "TERMINAL" && isOpenCodeDirectParityRuntime(pane.terminalRuntimeId)) {
          const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
          if (session) {
            const control = await resolveOpenCodeServerControl(session).catch(() => null);
            if (control) {
              const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
              if (currentModel) {
                const liveModelId = `${currentModel.providerID}/${currentModel.id}`;
                return {
                  configuredModelId: session.modelId ?? pane.modelId ?? liveModelId,
                  effectiveModelId: liveModelId,
                  modelVerificationStatus: "VERIFIED"
                };
              }
            }
          }
          return {
            configuredModelId: session?.modelId ?? pane.modelId ?? null,
            effectiveModelId: null,
            modelVerificationStatus: "UNKNOWN"
          };
        }
        return null;
      };
      const data = await Promise.race([
        doInspect(),
        new Promise<null>((r) => setTimeout(() => r(null), 2500))
      ]).catch(() => null);
      paneStateCache.set(pane.id, { expires: Date.now() + 15_000, data });
      return data;
    },
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
    integration:async(actor,roomId,action)=>{
      await controlUser(actor.id);
      if(action.kind==="resource"){
        if(action.operation==="access.cli")return controlInvoke(actor.id,"POST","/api/control/v1/grant",{roomId,enabled:z.boolean().parse(action.input.enabled)});
        if(action.operation==="panes.split"){
          const pane=await store.getPane(z.string().min(1).parse(action.id));
          if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
          if(pane.mode==="TERMINAL"&&!supportsControlRuntime(pane))throw new SpaceConflictError("Control is not supported for this runtime.");
          const input=z.object({direction:z.enum(["horizontal","vertical"])}).strict().parse(action.input);
          return controlInvoke(actor.id,"POST","/api/panes",{roomId,title:pane.title,mode:pane.mode,
            terminalRuntimeId:pane.terminalRuntimeId,providerId:pane.providerId,modelId:pane.modelId,vncTarget:pane.vncTarget,
            split:{parentId:pane.id,direction:input.direction,size:50}});
        }
        if(["browser.back","browser.forward","browser.reload","browser.content"].includes(action.operation)){
          const pane=await store.getPane(z.string().min(1).parse(action.id));
          if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
          assertBrowserPaneCompatible(pane);
          const context={holderType:"OPERATOR" as const,holderId:actor.id};
          if(action.operation==="browser.content"){
            // The Vault fence covers in-process reads too (Room Agent, Nous): no page text while a fill is in the page.
            if(await vault.protection.ownerOf(pane.id)&&!(await vault.protection.release(pane.id)))throw new SpaceConflictError("This browser holds a Vault fill: its page is not read until it shows the next page.");
            const result=await browserSessionManager.action(pane,{type:"extract_text"},makeSpaceId("trace"),context);
            return {paneId:pane.id,text:safeBrowserObservationText(result.text),currentUrl:safeBrowserObservationUrl(result.session.currentUrl)};
          }
          if(!browserSessionManager.acquireControl||!browserSessionManager.input||!browserSessionManager.releaseControl)throw new SpaceConflictError("Browser navigation control is unavailable.");
          const session=await store.getActivePaneBrowserSession(pane.id);
          const existing=session?await store.getActiveBrowserControlLease(session.sessionId):null;
          const traceId=makeSpaceId("trace");
          const lease=await browserSessionManager.acquireControl(pane,{...context,ttlSeconds:30,reason:"Operator Space control"},traceId,context);
          try{
            const result=await browserSessionManager.input(pane,{type:"NAVIGATION",leaseId:lease.leaseId,action:action.operation.slice(8).toUpperCase() as "BACK"|"FORWARD"|"RELOAD"},traceId,context);
            return {paneId:pane.id,currentUrl:safeBrowserObservationUrl(result.session.currentUrl),state:result.session.status};
          }finally{if(existing?.leaseId!==lease.leaseId)await browserSessionManager.releaseControl(pane,{leaseId:lease.leaseId},traceId,context);}
        }
        if(action.operation==="skills.read")return controlSkills(action.id);
        if(action.operation==="panes.open"){
          const recordDebugIncident = async (incident: Record<string, unknown>) => {
            try {
              const dir = "/opt/spaceapp/var/live-voice-logs";
              await mkdir(dir, { recursive: true });
              await appendFile(`${dir}/debug-incidents.jsonl`, JSON.stringify(incident) + "\n", "utf8");
            } catch (err) {
              console.warn("Failed to write debug incident log:", err);
            }
          };

          const isDebug = Boolean((action.input as any)?.debug);
          const originalCounts = paneCountsSchema.parse(action.input.counts);
          const supportedTypeIds = new Set(PANE_TYPES.map(t => t.typeId));
          for(const [id,count] of Object.entries(originalCounts)) {
            if(count>0&&!supportedTypeIds.has(id as any)) {
              const err = `Unsupported pane runtime requested: '${id}'. Supported types: ${Array.from(supportedTypeIds).join(', ')}`;
              if (isDebug) {
                const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                const diagnosis = {
                  incidentId,
                  timestamp: new Date().toISOString(),
                  operation: "panes.open",
                  roomId,
                  counts: originalCounts,
                  failureReason: err,
                  probableCause: `Pane type '${id}' is not in the system catalog`,
                  recommendedFix: `Choose from supported pane types: ${Array.from(supportedTypeIds).join(', ')}`,
                  agentHandoffPrompt: `Space agent incident report ${incidentId}: Requested invalid pane type '${id}' in room ${roomId}.`
                };
                void recordDebugIncident(diagnosis);
                return { status: "FAILED", isError: true, error: err, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
              }
              throw new SpaceConflictError(err);
            }
          }

          // Fast visible path: parallel preflights (room + panes + runtimes in one round).
          const [room, allPanes, registry, enabledIds] = await Promise.all([
            store.getRoom(roomId),
            store.listPanes(roomId, false),
            cliRuntimeRegistryCache.read().catch(() => ({ data: [] })),
            cliRuntimeVisibility.enabledRuntimeIds().catch(() => [])
          ]);
          const activePanes = allPanes.filter(p => !p.isClosed);
          const totalRequested = Object.values(originalCounts).reduce((s, c) => s + (typeof c === "number" ? c : 0), 0);
          const slots = Math.max(0, room.paneCap - activePanes.length);
          if (slots <= 0) {
            const overMsg = `Room capacity exceeded: room currently has ${activePanes.length} open panes, maximum capacity is ${room.paneCap} panes. No free slots for ${totalRequested} requested panes.`;
            const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const diagnosis = {
              incidentId,
              timestamp: new Date().toISOString(),
              operation: "panes.open",
              roomId,
              counts: originalCounts,
              roomCapacity: { currentOpen: activePanes.length, maxAllowed: room.paneCap, requested: totalRequested, freeSlots: 0 },
              failureReason: overMsg,
              probableCause: `Room maximum capacity of ${room.paneCap} panes has been reached.`,
              recommendedFix: `Close unused panes or adjust paneCap in settings.`,
              agentHandoffPrompt: `Space agent incident report ${incidentId}: Room ${roomId} capacity exceeded (${activePanes.length}/${room.paneCap} panes). Cannot open ${totalRequested} new panes. Close idle panes.`
            };
            void recordDebugIncident(diagnosis);
            if (isDebug) {
              return { status: "FAILED", isError: true, error: overMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
            }
            throw new SpaceConflictError(overMsg);
          }
          // Fill-up-to-cap: clip counts in catalog order when request exceeds free slots.
          let counts: Record<string, number> = { ...(originalCounts as Record<string, number>) };
          let clipped = false;
          if (totalRequested > slots) {
            const effective: Record<string, number> = {};
            let remaining = slots;
            for (const t of PANE_TYPES) {
              const asked = (originalCounts as Record<string, number>)[t.typeId] ?? 0;
              if (!asked || asked <= 0) continue;
              if (remaining <= 0) break;
              const take = Math.min(asked, remaining);
              if (take > 0) effective[t.typeId] = take;
              remaining -= take;
            }
            counts = effective;
            clipped = true;
          }

          // Preflight CLI runtimes readiness check (effective counts only).
          // Default policy: unavailable types are treated as non-existent — drop them
          // silently and open the rest instead of failing the whole batch.
          const enabledSet = new Set(enabledIds);
          const runtimesMap = new Map(registry.data.map((r: any) => [r.id, r]));
          const droppedUnavailable: Array<{ typeId: string; label: string; reason: string }> = [];

          for (const [id, count] of Object.entries(counts)) {
            if (!count || count <= 0) continue;
            const def = PANE_TYPES.find(p => p.typeId === id);
            if (def?.runtimeId) {
              const runtime = runtimesMap.get(def.runtimeId);
              if (!enabledSet.has(def.runtimeId) || (runtime && !isAgentRuntimeReady(runtime))) {
                droppedUnavailable.push({ typeId: id, label: def.label, reason: "Unavailable." });
                delete counts[id];
                continue;
              }
            }
          }
          if (Object.keys(counts).length === 0) {
            throw new SpaceConflictError(`Nothing to open: all requested pane types are currently unavailable.`);
          }

          const geminiGateway = counts.gemini ? await gatewayCliAccounts.openProfileId("cli:gemini", (action.input as any)?.accountProfileId) : null;
          let selectedGeminiAccount: { id: string; email: string | null; remainingPercent: number | null } | null = geminiGateway ? { id: geminiGateway, email: null, remainingPercent: null } : null;
          if (!geminiGateway && counts.gemini && counts.gemini > 0) {
            const usageList = await antigravityUsageProvider().catch(() => ({ data: [] }));
            const availableAccounts = usageList.data.filter((acc) => {
              const isConnected = acc.status === "CONNECTED";
              const rem5h = acc.gemini?.fiveHourRemainingPercent ?? 0;
              const remWeekly = acc.gemini?.weeklyRemainingPercent ?? 0;
              return isConnected && rem5h > 0 && remWeekly > 0;
            });
            const requestedProfileId = typeof (action.input as any)?.accountProfileId === "string" ? (action.input as any).accountProfileId : null;
            if (requestedProfileId) {
              const match = availableAccounts.find((a) => a.id === requestedProfileId);
              if (!match) {
                const requestedAcc = usageList.data.find((a) => a.id === requestedProfileId);
                const reason = requestedAcc ? `Account ${requestedProfileId} quota exhausted or status is ${requestedAcc.status}.` : `Account ${requestedProfileId} not found.`;
                const errMsg = `Requested Gemini Google account is not available: ${reason}`;
                if (isDebug) {
                  const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                  const diagnosis = {
                    incidentId,
                    timestamp: new Date().toISOString(),
                    operation: "panes.open",
                    roomId,
                    counts,
                    failureReason: errMsg,
                    probableCause: "Gemini account quota exhausted or account disconnected",
                    recommendedFix: "Select another connected Google account or wait for quota reset",
                    agentHandoffPrompt: `Space agent incident report ${incidentId}: Gemini account ${requestedProfileId} unavailable in room ${roomId}. ${reason}`
                  };
                  void recordDebugIncident(diagnosis);
                  return { status: "FAILED", isError: true, error: errMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
                }
                throw new SpaceConflictError(errMsg);
              }
              selectedGeminiAccount = { id: match.id, email: match.email, remainingPercent: match.gemini?.fiveHourRemainingPercent ?? null };
            } else {
              if (availableAccounts.length === 0) {
                const exhaustedReset = usageList.data.find((a) => a.status === "CONNECTED" && a.gemini?.fiveHourResetAt)?.gemini?.fiveHourResetAt;
                const resetMsg = exhaustedReset ? ` (next reset at ${exhaustedReset})` : "";
                const errMsg = `No Google account with available quota/tokens found for Gemini CLI${resetMsg}. Fallback: wait for quota reset or check licenses.`;
                if (isDebug) {
                  const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                  const diagnosis = {
                    incidentId,
                    timestamp: new Date().toISOString(),
                    operation: "panes.open",
                    roomId,
                    counts,
                    failureReason: errMsg,
                    probableCause: "All Gemini Google accounts have exhausted their 5h or weekly quotas",
                    recommendedFix: "Wait for quota reset or connect additional Google accounts in Space App",
                    agentHandoffPrompt: `Space agent incident report ${incidentId}: All Google accounts exhausted for Gemini CLI in room ${roomId}.${resetMsg}`
                  };
                  void recordDebugIncident(diagnosis);
                  return { status: "FAILED", isError: true, error: errMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
                }
                throw new SpaceConflictError(errMsg);
              }
              availableAccounts.sort((a, b) => (b.gemini?.fiveHourRemainingPercent ?? 0) - (a.gemini?.fiveHourRemainingPercent ?? 0));
              const best = availableAccounts[0]!;
              selectedGeminiAccount = { id: best.id, email: best.email, remainingPercent: best.gemini?.fiveHourRemainingPercent ?? null };
            }
          }

          let batchResult: any;
          try {
            batchResult = await roomPaneCommands.execute(roomId,actor.id,{requestId:makeSpaceId("control_open"),catalogVersion:PANE_CATALOG_VERSION,action:{type:"OPEN_PANES",counts}},makeSpaceId("trace"));
          } catch (err: any) {
            const errDetail = err?.message || String(err);
            const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const diagnosis = {
              incidentId,
              timestamp: new Date().toISOString(),
              operation: "panes.open",
              roomId,
              counts,
              failureReason: errDetail,
              probableCause: errDetail.includes("capped") ? "Room maximum pane limit reached" :
                             errDetail.includes("disabled") ? "Target CLI runtime is disabled in settings" :
                             errDetail.includes("login") || errDetail.includes("OAuth") ? "Target CLI requires OAuth authentication" :
                             "Room pane command execution failed",
              recommendedFix: errDetail.includes("capped") ? "Close unused panes" :
                              errDetail.includes("disabled") ? "Enable runtime in CLI settings" :
                              "Check server logs and runtime configuration",
              agentHandoffPrompt: `Space agent incident report ${incidentId}: Failed to open panes ${JSON.stringify(counts)} in room ${roomId}. Error: ${errDetail}.`
            };
            void recordDebugIncident(diagnosis);
            if (isDebug) {
              return { status: "FAILED", isError: true, error: errDetail, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
            }
            throw err;
          }

          const taskPrompt = typeof (action.input as any)?.taskPrompt === "string" ? (action.input as any).taskPrompt :
            typeof (action.input as any)?.prompt === "string" ? (action.input as any).prompt : null;
          let taskDelivered = false;
          let promptResult: unknown = null;
          if (selectedGeminiAccount && batchResult?.data) {
            const createdPanes = Array.isArray(batchResult.data) ? batchResult.data : [];
            const geminiPanes = createdPanes.filter((p: Pane) => p.terminalRuntimeId === "cli:gemini");
            if (geminiPanes.length > 0) {
              if (taskPrompt) {
                // Explicit task: bind accounts in parallel, deliver prompt once. Still parallel, not sequential.
                const bindings = await Promise.all(geminiPanes.map(async (p: Pane) => {
                  try {
                    const cliSession = await cliTerminalManager.ensurePaneControlReady(p, makeSpaceId("trace"), { accountProfileId: selectedGeminiAccount.id });
                    await store.updatePaneCliSession(cliSession.sessionId, { accountProfileId: selectedGeminiAccount.id }, makeSpaceId("trace"));
                    return { paneId: p.id, ok: true, sessionId: cliSession.sessionId };
                  } catch (err) {
                    return { paneId: p.id, ok: false, error: (err as Error)?.message ?? String(err) };
                  }
                }));
                const firstOk = bindings.find((b: any) => b?.ok);
                if (firstOk) {
                  try {
                    const target = geminiPanes.find((p: Pane) => p.id === (firstOk as any).paneId) ?? geminiPanes[0]!;
                    promptResult = await controlSend(target, taskPrompt, makeSpaceId("trace"));
                    taskDelivered = true;
                  } catch {}
                }
              } else {
                // Fast visible path: do not block MCP response on CLI spawn. Bind lazily in background.
                void (async () => {
                  await Promise.all(geminiPanes.map(async (p: Pane) => {
                    try {
                      const cliSession = await cliTerminalManager.ensurePaneControlReady(p, makeSpaceId("trace"), { accountProfileId: selectedGeminiAccount.id });
                      await store.updatePaneCliSession(cliSession.sessionId, { accountProfileId: selectedGeminiAccount.id }, makeSpaceId("trace"));
                    } catch {}
                  }));
                })().catch(() => {});
              }
            }
          }

          const createdPanes = Array.isArray(batchResult?.data) ? batchResult.data : [];
          const rawYoutubeUrl = typeof (action.input as any)?.youtubeUrl === "string" ? (action.input as any).youtubeUrl.trim() : null;
          const rawVideoTitle = typeof (action.input as any)?.videoTitle === "string" ? (action.input as any).videoTitle.trim() : null;
          if (rawYoutubeUrl && createdPanes.length > 0) {
            const ytPanes = createdPanes.filter((p: Pane) => p.mode === "YOUTUBE");
            if (ytPanes.length > 0) {
              // Parallel, best-effort; cheap metadata only, no playback blocking.
              await Promise.all(ytPanes.map(async (yp: Pane) => {
                const pb = youtubeBrowserPlayback(rawYoutubeUrl, rawVideoTitle);
                if (pb) {
                  try {
                    const ypRoom = await store.getRoom(yp.roomId);
                    const ownerId = ypRoom.kind === "AGENT_PROOF" ? `${actor.id}:proof:${yp.roomId}` : actor.id;
                    await youtubePlaybackStore.save(ownerId, yp.id, pb);
                  } catch {}
                }
                if (rawVideoTitle) {
                  try {
                    await store.updatePane(yp.id, { title: rawVideoTitle.slice(0, 100) }, makeSpaceId("trace"));
                  } catch {}
                }
              }));
            }
          }

          const totalOpened = Array.isArray(batchResult?.data) ? batchResult.data.length : 0;
          return {
            ...batchResult,
            skipped: [...(Array.isArray(batchResult?.skipped) ? batchResult.skipped : []), ...droppedUnavailable],
            ...(selectedGeminiAccount ? { selectedGoogleAccount: selectedGeminiAccount, taskDelivered, promptResult } : {}),
            fill: {
              requested: totalRequested,
              opened: totalOpened,
              clipped,
              freeSlotsBefore: slots,
              effectiveCounts: counts,
              originalCounts,
            },
            ...(isDebug ? { debug: true, diagnosticStatus: "PASSED" } : {})
          };
        }
        if(action.operation==="media.publish" || action.operation==="files.publish"){
          const input=controlPublishInput.parse(action.input);
          const buffer=input.text!==undefined?Buffer.from(input.text):Buffer.from(input.base64!,"base64");
          return withStagedBufferUpload(config.browserEvidenceArtifactRoot, {buffer,filename:input.filename,mimeType:input.mimeType}, async upload => {
            if(action.operation==="files.publish"){
              const artifact=await persistAgentFile({store,artifactRoot:config.browserEvidenceArtifactRoot,roomId,paneId:null,cliSessionId:null,runtimeId:"space-control",originalFilename:input.filename,
                declaredMimeType:input.mimeType,sourcePath:upload.sourcePath,traceId:makeSpaceId("trace")});
              eventBus.publish(artifact.event); return {id:artifact.artifact.id,mimeType:artifact.artifact.mimeType};
            }
            const mimeType=sniffImageMime(upload.sample)??inferUploadMimeType(input.filename,input.mimeType);
            const storage=buildGenericUserUploadStorage({artifactRoot:config.browserEvidenceArtifactRoot,roomId,originalFilename:input.filename});
            const result=await withPersistedUpload(config.browserEvidenceArtifactRoot,upload,storage.filePath,pinnedPath =>
              recordUploadedArtifact(store,{roomId,paneId:null,kind:mimeType.startsWith("image/")?"IMAGE":isVideoMimeType(mimeType)?"VIDEO":"EXPORT",mimeType,
                storageUri:storage.storageUri,sha256:upload.sha256,byteSize:upload.byteSize,
                metadata:{source:"USER_UPLOAD",originalFilename:input.filename,storedFilename:storage.storedFilename,uploadedBy:actor.id}},makeSpaceId("trace"),pinnedPath));
            eventBus.publish(result.event);return {id:result.artifact.id,mimeType:result.artifact.mimeType};
          });
        }
        if(action.operation.startsWith("ops.")){
          const toolIds={"ops.status":"space-readonly:space_status","ops.logs":"space-readonly:space_logs","ops.test":"space_ops:space_scoped_test","ops.verify":"space_ops:space_live_verify","ops.proof":"space-readonly:space_authenticated_ui_proof"} as const; // The API's MCP registry (SPACE_MCP_SERVERS_JSON) serves the read-only ops tools as space-readonly.
          const toolId=toolIds[action.operation as keyof typeof toolIds];
          if(!toolId)throw new SpaceConflictError("Unknown protected operation.");
          return controlInvoke(actor.id,"POST","/api/mcp/tools/execute",{roomId,toolId,arguments:action.input,
            ...(action.approvalReason?{approvalReason:action.approvalReason}:{})});
        }
        if(action.operation==="asteroids.control"){
          const input=z.object({action:z.enum(["start","pause","reset","telemetry"]).default("telemetry"),modelId:z.string().trim().min(1).optional()}).strict().parse(action.input);
          if(input.action==="pause")throw new SpaceConflictError("Asteroids pause has no verified execution adapter; no game state was changed.");
          if(input.action==="reset")return controlInvoke(actor.id,"POST","/api/asteroids/benchmark/championship/reset");
          if(input.action==="start"){
            if(!input.modelId)throw new SpaceConflictError("Choose an explicit configured model before starting the Asteroids benchmark.");
            return controlInvoke(actor.id,"POST","/api/asteroids/benchmark/runs",{mode:"championship",contestants:[input.modelId,"baseline/scripted-pilot"],rounds:1});
          }
          return controlInvoke(actor.id,"GET","/api/asteroids/benchmark/championship");
        }
        if(action.operation==="settings.snapshot"){
          return captureControlSettingsSnapshot({actor,roomId,input:action.input,repository:controlRepository,
            inspect:()=>spaceControl.inspect(actor,{roomId,section:"SETTINGS",offset:0,limit:100})});
        }
        if(action.operation==="settings.rollback"){
          return restoreControlSettingsSnapshot({actor,roomId,input:action.input,repository:controlRepository,
            store,pluginsService});
        }
        if(action.operation==="settings.plugins"){
          return executeControlPluginAction({actor,roomId,input:action.input,repository:controlRepository,
            pluginsService});
        }
        const route=controlResourceRoutes[action.operation];
        if(!route)throw new SpaceConflictError("Resource operation has no available adapter.");
        if (["tasks.delete", "links.delete", "files.delete", "media.delete"].includes(action.operation)) {
          const isConfirmed = Boolean(
            (action.input as any)?.confirm === true ||
            (action.input as any)?.confirmed === true ||
            action.approvalReason
          );
          if (!isConfirmed) {
            throw new SpaceConflictError(`Destructive operation ${action.operation} requires explicit confirmation (confirm: true) or approvalReason.`);
          }
        }
        if(route.scope==="pane"){
          const pane=await store.getPane(z.string().min(1).parse(action.id));
          if(pane.roomId!==roomId)throw new SpaceConflictError("Pane is outside this room.");
          if(pane.mode==="TERMINAL"&&!supportsControlRuntime(pane))throw new SpaceConflictError("This CLI adapter is not supported.");
          if(typeof action.input.terminalRuntimeId==="string"&&!supportsControlRuntime({mode:"TERMINAL",terminalRuntimeId:action.input.terminalRuntimeId} as any))throw new SpaceConflictError("Unsupported CLI runtime.");
        }
        if(route.scope==="artifact"){
          const item=await store.getArtifact(z.string().min(1).parse(action.id));
          if(item.roomId!==roomId)throw new SpaceConflictError("Artifact is outside this room.");
        }
        const effectiveId = action.id ?? (typeof (action.input as any)?.id === "string" ? (action.input as any).id : undefined);
        if(route.path.includes(":id")&&!effectiveId)throw new SpaceConflictError("Resource ID is required.");
        let targetUrl = route.path.replace(":id",encodeURIComponent(effectiveId??""));
        if (route.method === "GET" && action.input && Object.keys(action.input).length > 0) {
          const queryParams = new URLSearchParams();
          for (const [key, value] of Object.entries(action.input)) {
            if (value !== undefined && value !== null) queryParams.set(key, String(value));
          }
          const qs = queryParams.toString();
          if (qs) targetUrl += (targetUrl.includes("?") ? "&" : "?") + qs;
        }
        const invokeBody = route.method === "GET" ? undefined : { ...(action.input as any) };
        if (action.operation === "panes.update" && invokeBody && "accountProfileId" in invokeBody && (await store.getPane(effectiveId!)).mode === "TERMINAL") {
          throw new SpaceConflictError("panes.update does not change a CLI pane's account: use configure with accountProfileId on the pane.");
        }
        if (invokeBody && route.path.includes(":id") && "id" in invokeBody) {
          delete invokeBody.id;
        }
        if (invokeBody && ("confirm" in invokeBody || "confirmed" in invokeBody)) {
          delete invokeBody.confirm;
          delete invokeBody.confirmed;
        }
        return controlInvoke(actor.id,route.method,targetUrl,invokeBody);
      }
      if(action.kind==="cli"){
        const runtimeId=cliToggleRuntimeIdSchema.parse(action.runtimeId);
        const preview=action.enabled?null:await cliRuntimeVisibility.createDisablePreview(runtimeId);
        return controlInvoke(actor.id,"PATCH",`/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}`,
          {enabled:action.enabled,...(preview?{confirmationToken:preview.confirmationToken}:{})});
      }
      if(action.kind==="vpn"){
        if(action.operation==="rotate"){
          if(!action.profile)throw new SpaceConflictError("Choose an available VPN profile.");
          return controlInvoke(actor.id,"POST",`/api/cli/egress/profiles/${action.profile}/random-city`);
        }
        const runtimeId=cliToggleRuntimeIdSchema.parse(action.runtimeId);
        return controlInvoke(actor.id,"PATCH",`/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}/vpn`,{enabled:action.enabled});
      }
      throw new SpaceConflictError("Unsupported integration action.");
    },
    inspectExtra:async(actor,input)=>{
      await controlUser(actor.id);
      if(input.section==="ROOMS")return store.listRooms();
      if(input.section==="SKILLS")return controlSkillsPage(await store.listSkills(),input);
      if(input.section==="QUOTA"){
        if(input.paneId){const pane=await store.getPane(input.paneId);if(pane.roomId!==input.roomId)throw new SpaceConflictError("Pane is outside this room.");return controlQuota(pane);}
        const antiUsage = await antigravityUsageProvider().catch(()=>({data:[]}));
        return {
          accounts:await toolbarUsageProvider(),
          antigravityAccounts:antiUsage.data,
          paneBinding:"Inspect QUOTA with paneId for native per-session limits. Account totals alone do not authorize automatic continuation."
        };
      }
      if(input.section==="RUNTIMES")return {settings:await store.listCliRuntimeSettings(),runtimes:await discoverAgentRuntimes(config)};
      if(input.section==="VPN")return (await readCliVpnApplications(await store.listCliRuntimeSettings())).egress;
      if(input.section==="FILES"||input.section==="MEDIA")return (await store.listArtifacts({roomId:input.roomId,page:Math.floor(input.offset/input.limit)+1,pageSize:input.limit,sortOrder:"desc"}))
        .filter(item=>input.section==="FILES"?isAgentFileArtifact(item):isRoomMediaArtifact(item))
        .map(item=>({id:item.id,kind:item.kind,mimeType:item.mimeType,createdAt:item.createdAt}));
      if(input.section==="SYSTEM_HEALTH"){
        const snapshot = await healthMonitor.snapshot();
        return {
          sampledAt: snapshot.sampledAt,
          uptimeSeconds: Math.round(process.uptime()),
          memoryHeapMiB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
          metrics: snapshot.metrics,
          services: snapshot.services,
          requests: snapshot.requests
        };
      }
      if(input.section==="PLUGINS"){
        const plugins = await pluginsService.getPlugins();
        return {
          count: plugins.length,
          plugins: plugins.map(p => ({
            id: p.id,
            name: p.displayName,
            description: p.description,
            connected: p.connection.status === "CONNECTED",
            status: p.connection.status,
            error: p.connection.error ?? null
          }))
        };
      }
      if(input.section==="MODULES"){
        return {
          version: SPACE_CONTROL_VERSION,
          navigationGroups: ["workspace", "create", "tools", "docks"],
          docks: [
            { id: "surface-health", label: "System Health", scope: "installation" },
            { id: "system-resources", label: "System Resources", scope: "installation" },
            { id: "surface-cli", label: "CLI Runtimes", scope: "installation" },
            { id: "quick-links", label: "Quick Links", scope: "room" },
            { id: "clip-tool", label: "Clipboard Dock", scope: "operator" },
            { id: "plugins", label: "Plugins Management", scope: "installation" },
            { id: "voice-input", label: "Voice Settings", scope: "browser" },
            { id: "appearance", label: "UI Theme & Scale", scope: "room" }
          ],
          features: {
            roomAgent: true,
            voiceAssistant: true,
            multiRuntimeCli: true,
            screenCapture: true,
            watches: true,
            dryRun: true,
            settingsRollback: true
          }
        };
      }
      if(input.section==="VOICE"){
        const transcription = buildVoiceTranscriptionSettings(config);
        const providers = await getLiveAudioProvidersStatus(config).catch(() => ({ providers: [] }));
        const local = await getLocalVoiceProviderStatus(config).catch(() => ({ status: "unavailable" }));
        return { transcription, providers, local };
      }
      if(input.section==="LINKS"){
        const query = { page: Math.floor(input.offset / input.limit) + 1, pageSize: input.limit, isQuick: undefined };
        const owner = await store.upsertUser(actor as any);
        const result = await store.listUserLinks(owner.id, query);
        return {
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize
        };
      }
      if(input.section==="TASKS"){
        const query = { page: Math.floor(input.offset / input.limit) + 1, pageSize: input.limit, ...(input.query ? { q: input.query } : {}) };
        const owner = await store.upsertUser(actor as any);
        const result = await store.listTaskItems(owner.id, query);
        return {
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize
        };
      }
      if(input.section==="SETTINGS"){
        let cli: any[] = [];
        try { cli = await store.listCliRuntimeSettings(); } catch {}
        let providers: any = null;
        try { providers = await store.getProviderSettings(); } catch {}
        let tools: any[] = [];
        try { tools = await store.listAgentToolAssignments(); } catch {}
        let taskTitles: any = null;
        try { taskTitles = await taskTitleRepository.getSettings(); } catch {}
        let plugins: any[] = [];
        try { plugins = await pluginsService.getPlugins(); } catch {}
        let voice: any = null;
        try { voice = buildVoiceTranscriptionSettings(config); } catch {}
        let room: any = null;
        if (input.roomId) { try { room = await store.getRoom(input.roomId); } catch {} }
        let layout: any = null;
        if (input.roomId) { try { layout = await spaceControl.layout(input.roomId); } catch {} }

        const sanitizedProviders = providers ? {
          defaultProviderId: providers.defaultProviderId,
          providers: (providers.providers || []).map((p: any) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            configured: Boolean(p.hasKey || p.configured || p.apiKeyConfigured),
            models: p.models ?? []
          }))
        } : null;

        return {
          cli,
          providers: sanitizedProviders,
          tools,
          taskTitles,
          plugins: plugins.map((p: any) => ({
            id: p.id,
            name: p.displayName,
            connected: p.connection?.status === "CONNECTED",
            status: p.connection?.status ?? "disconnected"
          })),
          voice,
          voiceScope: "SERVER_TRANSCRIPTION_CAPABILITIES_NOT_BROWSER_PREFERENCES",
          appearance: {
            theme: null,
            themeStatus: "BROWSER_LOCAL_NOT_OBSERVED",
            layoutColumns: room?.paneLayoutColumns ?? null,
            layoutMode: (layout as any)?.mode ?? null
          },
          diagnostics: {
            appDebugEnabled: process.env.APP_DEBUG === "1",
            hasBrowserEvidence: Boolean(config.browserEvidenceTargetOrigin)
          }
        };
      }
      return {supported:false,section:input.section};
    }
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
          content:ok?`Completed ${operation.results.length} controls.`:operation.results.map(r=>r.detail).join("\n").slice(0,4000)},undefined,"RUNNING");
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
    repository: notificationsRepository, eventBus,
    nous: { held: async (owner) => Boolean(await nousRef.current?.active(owner)), raised: (notification) => nousRef.current?.notification(notification), holdsCopilotQuestions: async (owner) => Boolean(await nousRef.current?.holdsCopilotQuestions(owner)), autoAnswer: async (record) => await nousRef.current?.autoAnswer(record) ?? null },
    userSettings: (userId) => Promise.resolve(store.getUserSettings(userId)),
    recordRoomEvent: (input) => Promise.resolve(store.recordRoomEvent(input)),
    push: options.notificationPush !== undefined ? options.notificationPush : await loadFcmServiceAccount(config.fcmServiceAccountFile).then((account) => account && createFcmSender(account)),
    log: { warn: (meta, message) => app.log.warn(meta, message) }
  });
  const notificationPrune = setInterval(() => { void notificationService.prune().catch((error: unknown) => app.log.warn({ err: error }, "Notification prune failed.")); }, 3_600_000);
  notificationPrune.unref();
  const stopMorningBatches = notificationService.startMorningBatches(async () => [...new Set((await store.listRooms()).map((room) => room.ownerUserId).filter((id): id is string => Boolean(id)))]);
  const roomOwner = async (roomId: string): Promise<string | null> => (await Promise.resolve(store.getRoom(roomId)).catch(() => null))?.ownerUserId ?? null;
  const stopNotificationProducers = eventBus.subscribe((event) => {
    if (event.type !== "ROOM_WATCHDOG_ALERT" || !event.roomId) return;
    const roomId = event.roomId;
    void (async () => {
      const owner = await roomOwner(roomId);
      if (!owner) return;
      await notificationService.raise({
        ownerUserId: owner, roomId, paneId: event.paneId ?? null, source: "ROOM_WATCHDOG", kind: event.type, severity: "URGENT", title: "Room watchdog alert",
        body: event.message.slice(0, 2000), link: { roomId, ...(event.paneId ? { paneId: event.paneId } : {}) }, dedupeKey: `event:${event.id}`, payload: {}, telegram: null
      });
    })().catch((error: unknown) => app.log.warn({ err: error, eventId: event.id }, "Notification producer failed."));
  });
  const roomAgentEventRouting = createRoomAgentEventRouting({ roomOwner, nousActive: async (owner) => Boolean(await nousRef.current?.active(owner)),
    notifications: notificationService, telegram: roomAgentMonitorRepository, log: { warn: (details, message) => app.log.warn(details, message) } });
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
    complete: async (systemPrompt, content) => completeRoomAgentPrompt({ systemPrompt, content, codexLbBaseUrl: config.codexLbBaseUrl,
      codexLbKeyFile: config.codexLbKeyFile, modelSelection: await roomAgentModelSelection(), timeoutMs: 45_000, runOpenCode }),
    coordinate: (event) => roomCoordination.coordinate(event, { owner: roomOwner, chat: roomAgentChat, send: roomAgentService.send }),
    onEvent: (event) => roomAgentMonitorOnEvent(event),
    deferTo: async (event) => Boolean(await nousRef.current?.handles(event)),
    log: { warn: (details, message) => app.log.warn(details, message) }
  });
  const roomAgentMonitor = createRoomAgentMonitor({
    repository: roomAgentMonitorRepository,
    listRooms: async () => store.listRooms(),
    readActivity: readDashboardAgents,
    onEvent: (event) => roomAgentMonitorOnEvent(event),
    readOverlaps: roomCoordination.readOverlaps,
    onAttention: (event) => { void roomAgentAutopilot.handle(event); },
    onAttentionSweep: (roomIds) => roomAgentAutopilot.sweep(roomIds),
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

  async function readCodexEnvironmentSpaceStats(): Promise<NonNullable<CodexEnvironment["spaceStats"]>> {
    const checkedAt = new Date().toISOString();
    const rooms = await store.listRooms();
    const panes = (await Promise.all(rooms.map((room) => store.listPanes(room.id)))).flat();
    const chatPanes = panes.filter((pane) => pane.mode === "CHAT");
    const agentPaneSessions = await Promise.all(
      chatPanes.map(async (pane) => {
        const session = await store.getActiveSpaceAgentSession(pane.id);
        if (!session?.isActive) {
          return { hasSession: false, isRunning: false };
        }
        const latestRun = await store.getLatestSpaceAgentRun(session.sessionId);
        return {
          hasSession: true,
          isRunning: session.status === "RUNNING" || latestRun?.status === "QUEUED" || latestRun?.status === "RUNNING"
        };
      })
    );

    return {
      roomCount: rooms.length,
      agentPaneCount: agentPaneSessions.filter((session) => session.hasSession).length,
      activeAgentPaneCount: agentPaneSessions.filter((session) => session.isRunning).length,
      cliPaneCount: panes.filter((pane) => pane.mode === "TERMINAL").length,
      chatPaneCount: chatPanes.length,
      browserPaneCount: panes.filter((pane) => pane.mode === "BROWSER").length,
      checkedAt
    };
  }

  async function readCodexEnvironmentHostStats(): Promise<CodexEnvironment["hostStats"] | undefined> {
    try {
      return await hostStatsProvider();
    } catch (error) {
      app.log.warn({ err: error }, "Codex environment host stats collection failed.");
      return undefined;
    }
  }

  // Successful fast requests are the bulk of the journal (badge and dashboard
  // polls) and pushed everything else out within a day. Log only errors and
  // slow requests; SPACE_API_REQUEST_LOG=all restores Fastify's per-request lines.
  const app = Fastify({
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
  let artifactRetentionSweepRunning = false;
  let appDiagnosticsRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let appDiagnosticsRetentionSweepRunning = false;
  let durableEventPollTimer: ReturnType<typeof setInterval> | null = null;
  let systemAnalyticsSampleTimer: ReturnType<typeof setInterval> | null = null;
  let systemAnalyticsRollupTimer: ReturnType<typeof setInterval> | null = null;
  let dbRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let dbRetentionSweepRunning = false;

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

  async function runArtifactRetentionSweep() {
    if (artifactRetentionSweepRunning) return;
    artifactRetentionSweepRunning = true;
    try {
      const result = await sweepExpiredBrowserArtifacts({ store, artifactRoot: config.browserEvidenceArtifactRoot });
      if (result.softDeleted > 0 || result.fileErrors.length > 0) {
        app.log.info(
          {
            softDeleted: result.softDeleted,
            filesRemoved: result.filesRemoved,
            fileErrorCount: result.fileErrors.length,
            fileErrorArtifactIds: result.fileErrors.map((entry) => entry.artifactId)
          },
          "Browser artifact retention sweep completed."
        );
      }
    } catch (error) {
      app.log.error({ err: error }, "Browser artifact retention sweep failed.");
    } finally {
      artifactRetentionSweepRunning = false;
    }
  }

  async function runAppDiagnosticsRetentionSweep() {
    if (appDiagnosticsRetentionSweepRunning) return;
    appDiagnosticsRetentionSweepRunning = true;
    try {
      const result = await appDiagnosticsService.sweepExpired();
      if (result.segmentsDeleted > 0 || result.leasesDeleted > 0 || result.capturesDeleted > 0) {
        app.log.info(result, "App diagnostics retention sweep completed.");
      }
    } catch (error) {
      app.log.error({ err: error }, "App diagnostics retention sweep failed.");
    } finally {
      appDiagnosticsRetentionSweepRunning = false;
    }
  }

  async function executeDatabaseRetentionSweep() {
    if (!config.enableDbSweep) return;
    if (dbRetentionSweepRunning) return;
    dbRetentionSweepRunning = true;
    try {
      const result = await runDatabaseRetentionSweep({ store });
      if (result.deletedChunks > 0) {
        app.log.info(
          { deletedChunks: result.deletedChunks, batches: result.batches },
          "Database retention sweep completed."
        );
      }
    } catch (error) {
      app.log.error({ err: error }, "Database retention sweep failed.");
    } finally {
      dbRetentionSweepRunning = false;
    }
  }

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
    keyGenerator: (request) => requestIpForLog(request) ?? "unknown"
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
    let sessionUser = verifySession(request.cookies[cookieName], auth.sessionSecret);
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
        sessionUser.id = "user:operator";
      }
      const resolved = await sessionAccess.resolve(sessionUser, request.log);
      if (resolved) request.user = resolved;
    }
  });

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

  app.addHook("onReady", async () => {
    // A dev instance starts from a copy of stable's data and must not replay its schedules and watches.
    if (config.instanceJobs["space-control-ticks"]) await spaceControl.start();
    if (config.roomAgentMonitorEnabled && (options.startRoomAgentMonitor ?? !options.store)) roomAgentMonitor.start();
    canonicalSearch?.start();
    memoryEmbeddingBackfill?.start();
    healthMonitor.start();
    if (options.agentToolsOptions?.rootWriterCommand) {
      try {
        await projectRoutingState(store, options.agentToolsOptions);
      } catch (error) {
        app.log.warn({ err: error }, "Projecting routing state failed on startup; continuing.");
      }
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FilesystemError) {
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof GitControlError) return sendApiError(reply, error.statusCode, error.code, error.message);
    if (error instanceof StreamingSettingsVersionConflictError) {
      request.log.info({ requestId: request.requestIdForSpace, currentVersion: error.currentVersion }, "streaming overlay settings conflicted");
      return sendApiError(reply, 409, "STREAMING_SETTINGS_CONFLICT", error.message, { currentVersion: error.currentVersion });
    }
    if (error instanceof StreamingServiceError) {
      request.log.info({ errorCode: error.code, requestId: request.requestIdForSpace }, "streaming request rejected");
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof ZodError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request rejected");
      return sendApiError(reply, 422, "VALIDATION_ERROR", "Invalid request data.", error.flatten());
    }
    if (error instanceof SpaceNotFoundError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request target not found");
      return sendApiError(reply, 404, "NOT_FOUND", error.message);
    }
    if (error instanceof AppDiagnosticsServiceError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "App diagnostics request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof TelegramIntegrationError) {
      request.log.info({ errorCode: error.code, requestId: request.requestIdForSpace }, "Telegram integration request rejected");
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof SourceControlPublishingError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "Source-control publishing request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof CliMaintenanceError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "CLI maintenance request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof ReleasePublishingError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "Space release publishing request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof TelegramApiError) {
      request.log.warn({ errorCode: error.code, requestId: request.requestIdForSpace }, "Telegram API request failed");
      const statusCode = error.statusCode === 429 ? 429 : error.permanent ? 422 : 502;
      const message = error.permanent
        ? "Telegram rejected the bot or destination. Verify the bot token and permissions."
        : "Telegram is temporarily unavailable. Try again shortly.";
      return sendApiError(reply, statusCode, error.code, message, error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : undefined);
    }
    if (error instanceof BrowserControlHeldError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "browser control held by operator");
      return sendApiError(reply, 409, error.errorCode, error.message, error.details);
    }
    if (error instanceof CodexRuntimeModelSettingsUnconfirmedError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "Codex runtime model settings unconfirmed");
      return sendApiError(reply, 409, error.errorCode, error.message, error.details);
    }
    if (error instanceof CliTerminalControlRequiredError) {
      request.log.info(
        { requestId: request.requestIdForSpace },
        "CLI HTTP mutation rejected because terminal control is held by another page"
      );
      return sendApiError(reply, 409, error.errorCode, error.message);
    }
    if (error instanceof PaneClosedConflictError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "closed pane request conflicted");
      return sendApiError(reply, 409, "PANE_CLOSED", error.message);
    }
    if (error instanceof CliRuntimeDisableConfirmationStaleError) {
      request.log.info({ requestId: request.requestIdForSpace }, "CLI runtime disable confirmation is stale");
      return sendApiError(reply, 409, error.errorCode, error.message, error.preview);
    }
    if (error instanceof CliVpnError) {
      request.log.warn(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "CLI VPN request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof SpaceConflictError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request conflicted");
      return sendApiError(reply, 409, "CONFLICT", error.message);
    }
    if (error instanceof SpaceFeatureDisabledError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace, ...(error.errorCode === "BROWSER_HOST_UNAVAILABLE" ? { hostError: error.details } : {}) }, "request blocked by feature gate");
      const statusCode =
        error.errorCode === "SPACE_AGENT_PERMISSION_FIXED_FULL_ACCESS" ||
        error.errorCode === "SPACE_AGENT_MODEL_CONFIG_NOT_ADVERTISED" ||
        error.errorCode === "CODEX_MASTER_DISABLED"
          ? 409
          : 503;
      return sendApiError(reply, statusCode, error.errorCode, error.message, error.details);
    }
    if (error instanceof TurnStarterDisabledError) {
      request.log.warn({ err: error, requestId: request.requestIdForSpace }, "request blocked by turn starter gate");
      return sendApiError(reply, 503, "TURN_STARTER_DISABLED", error.message);
    }
    const frameworkClientError = getFrameworkClientError(error);
    if (frameworkClientError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request rejected by framework");
      return sendApiError(reply, frameworkClientError.statusCode, frameworkClientError.code, frameworkClientError.message);
    }
    request.log.error({ err: error, requestId: request.requestIdForSpace }, "request failed");
    return sendApiError(reply, 500, "INTERNAL_ERROR", "The request could not be completed.");
  });

  registerHealthRoutes(app, {
    apiStartedAt, config, appVersionReader, store, appDiagnosticsService, browserSessionManager,
    workerReadinessChecker, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions
  });
  if (config.optionalModules.has("desktop-updates")) registerDesktopReleaseRoutes(app, { routeOptions: defaultRouteRateLimitOptions }); registerMetricsScrape(app, { tokenFile: config.metricsTokenFile, routeOptions: defaultRouteRateLimitOptions, render: () => { observeMemoryWorkers(); return observability.renderPrometheus(); } });
  // Aggregate metrics only (route templates, codes, categories, process and
  // queue gauges). Served to local/private-network scrapers and signed-in
  // administrators; clients that reach the API from the public internet
  // (including through the trusted proxy) are refused.
  app.get("/metrics", defaultRouteRateLimitOptions, async (request, reply) => {
    // A LAN client is not trusted: with a 0.0.0.0 bind any host on the network could scrape (review F12).
    const administrator = request.user?.role === "ADMIN" || request.user?.role === "OPERATOR";
    if (!administrator && !isLoopbackRequest(request)) {
      return sendApiError(reply, 403, "METRICS_FORBIDDEN", "Metrics are available to local scrapers and administrators only.");
    }
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    observeMemoryWorkers();
    return observability.renderPrometheus();
  });

  app.get("/api/auth/me", defaultRouteRateLimitOptions, async (request, reply) => {
    const setupStatus = auth.devLogin
      ? { setupRequired: false }
      : await store.getOwnerSetupStatus();
    let user = request.user;
    if (user && store.getControlActor) {
      const dbActor = await store.getControlActor(user.id);
      if (dbActor) {
        userRoleCache.set(user.id, { role: dbActor.role, cachedAt: Date.now() });
        const cookieUser = verifySession(request.cookies[cookieName], auth.sessionSecret);
        const needsCookieRefresh = !cookieUser || cookieUser.role !== dbActor.role;
        user = {
          ...user,
          email: dbActor.email,
          role: dbActor.role,
          googleId: dbActor.googleId ?? null,
          avatarUrl: dbActor.avatarUrl ?? null
        };
        if (needsCookieRefresh && auth.sessionSecret) {
          // A role change re-signs the session but keeps it the same session: its issue time and the client's CSRF token.
          const current = request.cookies[cookieName];
          const token = signSession(user, auth.sessionSecret, Date.now(), { iat: signedSessionPayload(current, auth.sessionSecret)?.iat,
            lc: createCsrfToken(current, auth.sessionSecret) ?? undefined });
          reply.setCookie(cookieName, token, {
            httpOnly: true,
            secure: auth.secureCookies,
            sameSite: "lax",
            path: "/",
            maxAge: operatorSessionTtlSeconds
          });
        }
      }
    }
    const settings = user ? await store.getUserSettings(user.id) : null;
    return {
      user,
      isAuthenticated: Boolean(user),
      isSetupRequired: setupStatus.setupRequired,
      googleAuthEnabled: Boolean(auth.googleClientId), optionalModules: [...config.optionalModules],
      settings
    };
  });

  const { setupOwnerVoiceRuntime, setupVoiceCredentials } = await registerFirstSetup(app, { options, config, store, auth, publicCredentialHost,
    setupConnections, setupConnectionCheckRuns, routeOptions: defaultRouteRateLimitOptions, streamingService, sourceControlService,
    browserSessionManager, visibleCliRuntimeIds, agentSessionHistoryService, readSystemHealth: () => healthMonitor.snapshot(),
    quotaProviders: { codex: toolbarUsageProvider, antigravity: antigravityUsageProvider, api: apiProviderAccountsProvider },
    onOwnerClaimed: () => installTelemetry.setupCompleted.observe() });

  if (config.optionalModules.has("waitlist")) app.post(
    "/api/public/waitlist",
    {
      bodyLimit: publicWaitlistBodyLimitBytes,
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
    },
    async (request, reply) => {
      const input = parseBody(publicWaitlistRequestSchema, request.body);
      let outcome: "CREATED" | "DUPLICATE" | "HONEYPOT";
      if (input.website) {
        outcome = "HONEYPOT";
      } else {
        try {
          outcome = await store.upsertPublicWaitlistSignup({ email: input.email, source: input.source });
        } catch {
          request.log.warn(
            { event: "public.waitlist.submission", outcome: "FAILED" },
            "Public waitlist submission failed."
          );
          return sendApiError(reply, 500, "INTERNAL_ERROR", "The request could not be completed.");
        }
      }
      request.log.info(
        { event: "public.waitlist.submission", outcome },
        "Public waitlist submission accepted."
      );
      return reply.status(202).send(publicWaitlistResponseSchema.parse({ status: "ACCEPTED" }));
    }
  );

  app.get("/api/auth/csrf", defaultRouteRateLimitOptions, async (request, reply) => {
    const csrfToken = createCsrfToken(request.cookies[cookieName], auth.sessionSecret);
    if (!csrfToken) {
      return sendApiError(reply, 401, "UNAUTHENTICATED", "Authentication is required.");
    }
    return { csrfToken, headerName: csrfHeaderName };
  });

  registerAppDiagnosticsSettingsRoutes(app, {
    store, appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions
  });

  registerActivityLogRoutes(app, { store, activityLogService, routeOptions: defaultRouteRateLimitOptions });

  const demoProjectsService = createDemoProjectsService({
    config,
    log: (event, detail) => app.log.info({ ...detail, event }, "demo projects")
  });

  registerDemoProjectsRoutes(app, {
    service: demoProjectsService,
    enabled: config.demoProjectsEnabled,
    rateLimitOptions: defaultRouteRateLimitOptions,
    sessionToken: (request) => request.cookies[cookieName] ?? "",
    ownerId: async (request) => (await store.upsertUser(request.user!)).id,
    resolvePublicOrigin: (request) => resolveDemoPublicOrigin(request, config)
  });

  // T3 Code: the feature flag scopes only these encapsulated T3 namespaces.
  // The configured public UI origin is accepted alongside the derived one, as
  // for voice sessions, because the TLS/web proxy hides the browser origin.
  const t3Origins = t3PublicOrigins(config.browserEvidenceTargetOrigin, config.demoProjectsPublicOrigin);
  const t3Bindings = await registerT3Bindings(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret, store, publicOrigins: t3Origins,
    socketPath: config.t3CodeSocketPath, healthTimeoutMs: config.t3CodeHealthTimeoutMs, agentTokens: { config } });
  await registerT3Gateway(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret, store, publicOrigins: t3Origins,
    socketPath: config.t3CodeSocketPath, timeoutMs: config.t3CodeProxyTimeoutMs,
    documentBootstrap: t3Bindings.openForDocument, inlineBootstrapEnabled: t3InlineBootstrapSupported, startupAssets: () => t3StartupAssets() });
  await registerT3StaticAssets(app, { enabled: config.t3CodeEnabled, sessionSecret: auth.sessionSecret });
  await registerT3LegacyRetirement(app);
  registerT3CodeAdminRoutes(app, {
    featureEnabled: config.t3CodeEnabled,
    controller: options.t3CodeServiceController ?? createT3CodeServiceController(),
    socketPath: config.t3CodeSocketPath,
    healthTimeoutMs: config.t3CodeHealthTimeoutMs,
    routeOptions: defaultRouteRateLimitOptions,
    audit: (request, action, metadata) => recordAudit(store, request, { action, targetType: "managed_service", targetId: "space-t3code.service", metadata })
  });

  if (config.optionalModules.has("games")) registerBenchmarkRoutes(app, defaultRouteRateLimitOptions, {
    // Claude pilots fly on the signed-in account with the most quota left, like chess and T3 Code.
    claudeProfile: async () => pickClaudeProfile((await claudeUsageProvider()).data)
  });
  if (config.optionalModules.has("games")) registerChessBenchmarkRoutes(app, defaultRouteRateLimitOptions, {
    // Chess CLI moves run in the worker: CLI processes must never live in the space-api cgroup.
    runCliMove: createWorkerCliMoveRunner(),
    cli: {
      listModels: (runtimeId) => cliModelsExecutor(runtimeId)(),
      // A chess player must also be signed in (Kimi and Autohand can be enabled but not connected).
      state: async (runtimeId) => {
        const state = await cliChatRuntimeState(runtimeId);
        if (!state.enabled) return state;
        const runtime = findRuntime(await cliRuntimeRegistryCache.read(), runtimeId);
        return runtime?.authState === "READY" ? state : { enabled: false, reason: runtime?.authReason ?? "Sign-in required." };
      }
    },
    // Claude moves go to the signed-in account with the most quota left, like T3 Code.
    claudeProfile: async () => pickClaudeProfile((await claudeUsageProvider()).data),
    autoResume: options.resumeChessTournament === true
  });

  if (config.optionalModules.has("games")) registerAsteroidsDirectorRoutes(app, defaultRouteRateLimitOptions);

  if (dotsRepository) app.addHook("onClose", () => dotsRepository.dispose());
  if (dotMemoryRepository) app.addHook("onClose", () => dotMemoryRepository.dispose());
  if (dotHomeRepository) app.addHook("onClose", () => dotHomeRepository.dispose());
  registerDotsRoutes(app, {
    repository: dotsRepository, routeOptions: defaultRouteRateLimitOptions,
    // Goals and schedules have dedicated Stage 4 routes; their Stage 2 collections live under /collections.
    dedicatedResources: ["goals", "schedules"],
    nativeGoals: async () => (await codexGoals.list()).map(goal => agentPaneGoalSchema.parse({
      threadId: goal.threadId, goalId: goal.goalId, objective: goal.title, status: goal.status,
      tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: goal.createdAt, updatedAt: goal.updatedAt
    })),
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });

  registerDotHomeRoutes(app, {
    repository: dotHomeRepository, routeOptions: defaultRouteRateLimitOptions,
    modelChoices: spaceAgentAdapter.listModelChoices ? () => spaceAgentAdapter.listModelChoices!() : undefined,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });

  const personalGitOwner = async (request: FastifyRequest) => {
    if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", "Sign in to use personal Source Control.", 401);
    return (await store.upsertUser(request.user)).id;
  };
  registerPluginRoutes(app, defaultRouteRateLimitOptions, {
    service: sourceControlService,
    owner: personalGitOwner
  }, { recordAudit: (request, input) => recordAudit(store, request, input) });
  registerSourceControlRoutes(app, { service: sourceControlService, store, rateLimitOptions: defaultRouteRateLimitOptions, authenticatedOwner: personalGitOwner });
  registerWorktreeRoutes(app, {
    service: worktreeService,
    rateLimitOptions: defaultRouteRateLimitOptions,
    authorizeDestructive: (request) => request.user?.role === "ADMIN" || request.user?.role === "OPERATOR"
  });
  app.addHook("onClose", async () => { await sourceControlService.close(); });

  registerHarnessRoutes(app, config, store, {
    agentTokens: { config },
    authorizeUpgrade: (upgradeRequest) => {
      const user = verifySession(cookieValueFromHeader(upgradeRequest.headers.cookie, cookieName), auth.sessionSecret);
      return !isOtherSiteUpgradeRequest(upgradeRequest.headers, publicBrowserOrigins) && Boolean(user) && harnessRoleAllowed(user?.role)
        // The Harness is a UI pane: a proof session may open it, an admin action's session never.
        && (!user?.brokerScope || user.brokerScope === "UI_PROOF") && !(user?.id === "user:operator-proof" && user.proofScope);
    }
  });

  registerFilesRoutes(app, { hostModeEnabled: config.filesHostModeEnabled, store });
  registerDatabasesRoutes(app);

  registerAppDiagnosticsCaptureRoutes(app, { appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions });

  async function googleAccountBrowserStatuses(accounts: GoogleAccount[]): Promise<Map<string, GoogleBrowserStatusSummary>> {
    const active = accounts.length ? await store.listActivePaneBrowserSessions() : [];
    return new Map(await Promise.all(accounts.map(async (account): Promise<[string, GoogleBrowserStatusSummary]> => {
      const path = googleBrowserProfilePathFor(config.browserSessionsProfileRoot, account.ownerUserId, account.id);
      // Only a definite ENOENT means "no profile"; other stat errors stay Unknown.
      const profileExists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      const check = profileExists ? await readGoogleBrowserCheck(path).catch(() => null) : null;
      const activeUrls = active.filter(candidate => candidate.profileId === `google-account:${account.id}`).map(candidate => candidate.currentUrl);
      return [account.id, summarizeGoogleBrowserStatus({ profileExists, check, activeUrls })];
    })));
  }
  const dotsAuthenticatedOwner = async (request: FastifyRequest) => {
    if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
      throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
    }
    return (await store.upsertUser(request.user)).id;
  };
  const oauthRedirectBase = (request: FastifyRequest) => {
    const forwardedProto = request.headers["x-forwarded-proto"];
    const forwardedHost = request.headers["x-forwarded-host"];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers["host"] ?? `127.0.0.1:${config.port}`;
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? (auth.secureCookies === true ? "https" : "http");
    return `${String(proto).split(",")[0]!.trim()}://${String(host).split(",")[0]!.trim()}`;
  };
  const connectorStateTools = {
    sign: (value: string) => signOAuthState(value, auth.sessionSecret),
    verify: (token: string | undefined) => verifyOAuthState(token, auth.sessionSecret),
    sessionHash: (request: FastifyRequest) => createHash("sha256").update(request.cookies[cookieName] ?? "").digest("hex"),
    redirectUri: (request: FastifyRequest, provider: "GOOGLE" | "MICROSOFT") => provider === "GOOGLE"
      ? auth.googleRedirectUri || `${oauthRedirectBase(request)}/api/auth/google/callback`
      : process.env.SPACE_MICROSOFT_REDIRECT_URI || `${oauthRedirectBase(request)}/api/connectors/microsoft/callback`,
    secureCookies: auth.secureCookies
  };
  // The connector service is created with the other Dot services; the sign-in callback reaches it through this reference.
  const connectorServiceRef: { current: ReturnType<typeof createConnectorService> | null } = { current: null };
  registerAuthRoutes(app, {
    config, auth, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    googleAccountBrowserStatuses, dotsAuthenticatedOwner, connectorStateTools, connectorServiceRef, persistRevocation, appSignIn: registerAppSignIn(app, { store, sessionSecret: auth.sessionSecret, routeOptions: defaultRouteRateLimitOptions, persistRevocation, revocations: defaultSessionRevocationStore, databaseUrl: store instanceof PostgresSpaceStore ? config.databaseUrl : null })
  });

  registerAdminUserRoutes(app, {
    store, userRoleCache, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input),
    multiUserEnabled: config.multiUserEnabled === true,
    revokeUserSessions: (userId) => persistRevocation(defaultSessionRevocationStore.revokeUser(userId)).finally(() => sessionAccess.forget(userId))
  });

  app.addHook("onClose", async () => { await sharedGatewayRepository?.dispose(); });
  let gatewayAdminService = options.gatewayAdminService;
  if (!gatewayAdminService) {
    gatewayAdminService = createGatewayAdminService({ repository: gatewayRepositoryFor(), gatewayUrl: config.gatewayUrl, internalToken: config.gatewayAdminToken || config.internalApiToken });
  }
  registerGatewayAdminRoutes(app, {
    service: gatewayAdminService, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerClipboardRoutes(app, {
    store, routeOptions: defaultRouteRateLimitOptions
  });

  registerClientErrorRoutes(app);
  registerInstallTelemetryRoutes(app, { onActive: (fields) => installTelemetry.active.observe(fields) });
  registerFirstAnswerWatch(app, { reporter: installTelemetry.firstAnswer, rooms: async () => store.listRooms(), readRoom: readDashboardAgents });

  registerTraceRoutes(app, { store, routeOptions: defaultRouteRateLimitOptions });

  registerSharedChatRoutes(app, {
    auth, store, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions
  });

  registerTaskItemRoutes(app, { store, routeOptions: defaultRouteRateLimitOptions, recordAudit: (request, input) => recordAudit(store, request, input),
    schedules: config.instanceJobs["task-schedules"] ? { inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }),
      answer: (pane, input) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, ...input, when: "NOW" }, makeSpaceId("trace")), reopen: async (pane, owner) => spaceControl.execute(await controlUser(owner), controlExecuteSchema.parse({ roomId: pane.roomId, requestId: makeSpaceId("task_reopen"), actions: [{ kind: "pane", operation: pane.mode === "TERMINAL" ? "reopen" : "start", target: { paneIds: [pane.id], state: "ALL" }, when: "NOW" }] })), notice: async (owner, key, line) => { await nousRef.current?.service.notice(owner, key, line); } } : null });

  registerLinkInspectRoutes(app, { routeOptions: defaultRouteRateLimitOptions });

  registerUserLinkRoutes(app, {
    store, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerAgentSessionHistoryRoutes(app, {
    store, codexParity, unifiedCliTaskRegistry, agentSessionHistoryService, visibleCliRuntimeIds,
    routeOptions: defaultRouteRateLimitOptions
  });

  app.get("/api/system/services", defaultRouteRateLimitOptions, async () => {
    return systemServicesResponseSchema.parse(await systemServicesProvider());
  });

  app.post("/api/system/services/reset-failed", defaultRouteRateLimitOptions, async (request) => {
    const body = (request.body && typeof request.body === "object") ? (request.body as { unit?: string }) : undefined;
    const unit = typeof body?.unit === "string" ? body.unit.trim() : undefined;
    return await resetFailedSystemUnits(unit);
  });

  registerAgentSessionThreadRoutes(app, {
    store, codexParity, unifiedCliTaskRegistry, cliRuntimeVisibility, visibleCliRuntimeIds,
    readCodexEnvironmentSpaceStats, readCodexEnvironmentHostStats, routeOptions: defaultRouteRateLimitOptions
  });

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
    assertRoomAccess, cliRenderAi, youtubePlaybackStore, youtubeAccountStore, browserAccountStore
  });

  function assertCliVpnAvailable(): void {
    if (!config.cliVpnEnabled) {
      throw new CliVpnError("VPN_FEATURE_DISABLED", "CLI VPN routing is not enabled on this Space installation.", 503);
    }
  }

  async function runningDeepSeekHarnessPid(): Promise<number> {
    const pid = await deepSeekHarnessServiceController.mainPid();
    if (!pid) {
      throw new CliVpnError("HARNESS_UNAVAILABLE", "DeepSeek Harness is not running.", 503);
    }
    return pid;
  }

  // Status displays share a short-lived egress inspection; isolation gates
  // (assertDeepSeekHarnessIsolated) always read the broker directly.
  function inspectCliVpnStatus(runtimes: Parameters<CliVpnBroker["inspectRuntimes"]>[0]) {
    return cliVpnBroker.inspectRuntimesCached
      ? cliVpnBroker.inspectRuntimesCached(runtimes)
      : cliVpnBroker.inspectRuntimes(runtimes);
  }

  async function assertDeepSeekHarnessIsolated(pid: number): Promise<void> {
    const inspection = await cliVpnBroker.inspectRuntimes([{ runtimeId: "cli:harness", pids: [pid] }]);
    const harness = inspection.runtimes.find((runtime) => runtime.runtimeId === "cli:harness");
    if (!harness?.isolatedPids.includes(pid)) {
      throw new CliVpnError(
        "HARNESS_NETWORK_ISOLATION_FAILED",
        "DeepSeek Harness did not enter its protected network namespace.",
        502
      );
    }
  }

  async function readDeepSeekHarnessMaintenanceStatus() {
    if (!config.harnessEnabled) {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: false,
        vpnEnabled: false,
        effectiveMode: "DIRECT",
        isolated: false,
        pid: null
      });
    }
    const pid = await deepSeekHarnessServiceController.mainPid().catch(() => null);
    if (!config.cliVpnEnabled) {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled: false,
        effectiveMode: "DIRECT",
        isolated: false,
        pid
      });
    }
    try {
      const inspection = await inspectCliVpnStatus([{ runtimeId: "cli:harness", pids: pid ? [pid] : [] }]);
      const harness = inspection.runtimes.find((runtime) => runtime.runtimeId === "cli:harness");
      const vpnEnabled = harness?.mode === "vpn";
      const isolated = Boolean(pid && harness?.isolatedPids.includes(pid));
      const selectedConnection = inspection.selectedRoute === "direct"
        ? null
        : inspection.profiles[inspection.selectedRoute];
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled,
        effectiveMode: vpnEnabled
          ? isolated && selectedConnection?.status === "CONNECTED" ? "VPN" : "BLOCKED"
          : "DIRECT",
        isolated,
        pid
      });
    } catch {
      return harnessMaintenanceStatusSchema.parse({
        runtimeId: "cli:harness",
        enabled: Boolean(pid),
        vpnEnabled: false,
        effectiveMode: "BLOCKED",
        isolated: false,
        pid
      });
    }
  }

  function unavailableCliVpnConnection(error: unknown) {
    const toolingUnavailable = error instanceof CliVpnError && error.code === "TOOLING_UNAVAILABLE";
    return cliVpnConnectionSchema.parse({
      profileConfigured: false,
      status: "ERROR",
      endpoint: null,
      dnsServers: [],
      profileFingerprint: null,
      relay: null,
      egressIpv4: null,
      egressIpv6: null,
      lastHandshakeAt: null,
      lastVerifiedAt: null,
      lastVerificationCode: toolingUnavailable ? "TOOLING_UNAVAILABLE" : "APPLY_FAILED",
      updatedAt: nowIso()
    });
  }

  async function readCliVpnApplications(settings: readonly CliRuntimeSetting[]): Promise<{
    connection: ReturnType<typeof unavailableCliVpnConnection> | undefined;
    applications: CliRuntimeVpnStatus[];
    egress: CliGlobalEgressStatus;
  }> {
    const sessionGroups = await Promise.all(cliToggleRuntimeIds.map(async (runtimeId) => ({
      runtimeId,
      sessions: await store.listActivePaneCliSessions(runtimeId)
    })));
    if (!config.cliVpnEnabled) {
      const unavailable = unavailableCliVpnConnection(new CliVpnError("TOOLING_UNAVAILABLE", "CLI egress is disabled.", 503));
      const applications = sessionGroups.map(({ runtimeId, sessions }) => cliRuntimeVpnStatusSchema.parse({
        runtimeId,
        effectiveMode: "DIRECT",
        appliedSessionIds: sessions.map((session) => session.sessionId),
        restartRequiredSessionIds: []
      }));
      return {
        connection: undefined,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: false,
          selectedRoute: "direct",
          directEgressIpv4: null,
          removedProfiles: [],
          profiles: { greece: unavailable, thailand: unavailable, mullvad: unavailable, nord: unavailable },
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: "direct",
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    }
    const allSessions = sessionGroups.flatMap((group) => group.sessions);
    const pidBySessionId = await cliVpnSessionPidResolver(allSessions);
    try {
      const inspection = await inspectCliVpnStatus(sessionGroups.map(({ runtimeId, sessions }) => ({
        runtimeId,
        pids: sessions.flatMap((session) => {
          const pid = pidBySessionId.get(session.sessionId);
          return pid ? [pid] : [];
        })
      })));
      const inspectionByRuntime = new Map(inspection.runtimes.map((item) => [item.runtimeId, item]));
      const selectedConnection = inspection.selectedRoute === "direct"
        ? inspection.profiles.greece
        : inspection.profiles[inspection.selectedRoute];
      const settingByRuntime = new Map(settings.map((setting) => [setting.runtimeId, setting]));
      const applications = sessionGroups.map(({ runtimeId, sessions }) => {
        const inspected = inspectionByRuntime.get(runtimeId);
        const isolatedPids = new Set(inspected?.isolatedPids ?? []);
        const runningSessions = sessions.filter((session) => pidBySessionId.has(session.sessionId));
        const vpnEnabled = settingByRuntime.get(runtimeId)?.vpnEnabled === true;
        const vpnRequested = vpnEnabled && inspection.selectedRoute !== "direct";
        const routeReady = !vpnRequested || selectedConnection.status === "CONNECTED";
        const runtimeUsesVpn = inspected?.mode === "vpn";
        const appliedSessionIds = vpnRequested && routeReady && runtimeUsesVpn
          ? runningSessions.filter((session) => isolatedPids.has(pidBySessionId.get(session.sessionId)!)).map((session) => session.sessionId)
          : vpnRequested
            ? []
            : runningSessions.map((session) => session.sessionId);
        const restartRequiredSessionIds = vpnRequested && routeReady && runtimeUsesVpn
          ? runningSessions.filter((session) => !isolatedPids.has(pidBySessionId.get(session.sessionId)!)).map((session) => session.sessionId)
          : [];
        return cliRuntimeVpnStatusSchema.parse({
          runtimeId,
          effectiveMode: !vpnRequested ? "DIRECT" : routeReady && runtimeUsesVpn ? "VPN" : "BLOCKED",
          appliedSessionIds,
          restartRequiredSessionIds
        });
      });
      return {
        connection: inspection.connection,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: true,
          selectedRoute: inspection.selectedRoute,
          directEgressIpv4: inspection.directEgressIpv4,
          removedProfiles: inspection.removedProfiles,
          profiles: inspection.profiles,
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: inspectionByRuntime.get(application.runtimeId)?.routeId ?? (application.effectiveMode === "VPN" ? inspection.selectedRoute : "direct"),
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    } catch (error) {
      const unavailable = unavailableCliVpnConnection(error);
      const fallbackRoute = settings.some((setting) => setting.vpnEnabled) ? "greece" : "direct";
      const applications = sessionGroups.map(({ runtimeId, sessions }) => cliRuntimeVpnStatusSchema.parse({
        runtimeId,
        effectiveMode: fallbackRoute === "direct" ? "DIRECT" : "BLOCKED",
        appliedSessionIds: fallbackRoute === "direct" ? sessions.map((session) => session.sessionId) : [],
        restartRequiredSessionIds: fallbackRoute === "direct" ? [] : sessions.map((session) => session.sessionId)
      }));
      return {
        connection: unavailable,
        applications,
        egress: cliGlobalEgressStatusSchema.parse({
          supported: true,
          selectedRoute: fallbackRoute,
          directEgressIpv4: null,
          removedProfiles: [],
          profiles: { greece: unavailable, thailand: unavailable, mullvad: unavailable, nord: unavailable },
          applications: applications.map((application) => ({
            runtimeId: application.runtimeId,
            routeId: fallbackRoute,
            appliedSessionIds: application.appliedSessionIds,
            restartRequiredSessionIds: application.restartRequiredSessionIds
          })),
          checkedAt: nowIso()
        })
      };
    }
  }

  registerCliRuntimeCacheInvalidation(app, () => cliRuntimeRegistryCache.invalidate());
  registerCliRuntimeRoutes(app, {
    config, store, cliRuntimeRegistryCache, cliVpnBroker, deepSeekHarnessServiceController,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, runningDeepSeekHarnessPid,
    assertDeepSeekHarnessIsolated, readDeepSeekHarnessMaintenanceStatus, readCliVpnApplications,
    userRegistry: cliUserHosting.userRegistry
  });

  registerAgentToolRoutingRoutes(app, {
    store, agentToolsOptions: options.agentToolsOptions, routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  roomCoordination.registerRoutes(app, defaultRouteRateLimitOptions);
  registerInstanceReleaseRoutes(app, { store, releases: options.releasesOptions, managedHere: config.instance === "stable", routeOptions: defaultRouteRateLimitOptions,
    sessionSecret: auth.sessionSecret, grantStateFile: process.env.VITEST === "true" ? null : join(dirname(config.cliAccountBalancerStateFile), "queue-operator-grants.json") });

  app.post("/api/agent-tools/launch", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Launching agent tool tasks requires the ADMIN role.");
    }
    const input = parseBody(agentToolLaunchTaskInputSchema, request.body ?? {});
    const registry = await discoverAgentRuntimes(config);
    const runtime = findRuntime(registry, input.runtimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${input.runtimeId} was not found.`);
    }
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    await cliRuntimeVisibility.assertEnabled(input.runtimeId);
    let pane: Pane;
    let reusedPane: boolean;
    if (input.paneId) {
      pane = await getPaneById(store, input.paneId);
      if (pane.roomId !== input.roomId) {
        throw new SpaceConflictError("The pane does not belong to the requested room.");
      }
      if (pane.mode !== "TERMINAL") {
        throw new SpaceConflictError("Agent tool tasks require a TERMINAL pane.");
      }
      reusedPane = true;
    } else {
      pane = await store.createPane({
        roomId: input.roomId,
        title: "Agent Tools task",
        mode: "TERMINAL",
        terminalRuntimeId: input.runtimeId
      }, request.requestIdForSpace);
      reusedPane = false;
    }
    const session = await cliTerminalManager.ensurePaneControlReady(pane, request.requestIdForSpace);
    await cliTerminalManager.sendInput(
      session.sessionId,
      input.taskText,
      request.requestIdForSpace,
      null,
      `agent-tools-launch:${pane.id}:${input.taskText.slice(0, 40)}`
    );
    const response = await buildPaneCliSessionResponse({
      store,
      runtime,
      sessionId: session.sessionId,
      includeWebsocket: true,
      includeTranscript: false,
      tokenTtlMs: config.cliTokenTtlMs,
      issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
    });
    return agentToolLaunchTaskResponseSchema.parse({
      pane,
      session: response,
      loaded: true,
      reusedPane
    });
  });

  registerCliEgressRoutes(app, {
    store, config, cliVpnBroker, assertCliVpnAvailable, readCliVpnApplications,
    routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });

  registerCliRuntimeSettingsRoutes(app, {
    config, store, cliVpnBroker, cliVpnSessionPidResolver, cliVpnSessionRestarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions, assertCliVpnAvailable, readCliVpnApplications
  });

  const openCliLogin = async (
    request: FastifyRequest,
    roomId: string,
    runtimeId: string
  ) => {
    const startedAtMs = Date.now();
    await cliRuntimeVisibility.assertEnabled(runtimeId);
    await store.getRoom(roomId);

    const loginRuntimeIds = new Set([
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:qwen",
      "cli:autohand",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek",
      "cli:cursor",
      "cli:copilot"
    ]);
    if (!loginRuntimeIds.has(runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${runtimeId} does not support terminal login.`);
    }

    const registry = await cliRuntimeRegistryCache.read();
    const runtime = findRuntime(registry, runtimeId);
    if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${runtimeId} was not found.`);
    if (!runtime.capabilities.includes("CLI") || !isCliRuntimeLoginLaunchable(runtime)) {
      throw new SpaceFeatureDisabledError("CLI_LOGIN_UNAVAILABLE", runtime.authReason, {
        runtimeId: runtime.id,
        authState: runtime.authState
      });
    }

    let pane: Pane | null = null;
    let latestLoginSession: PaneCliSession | null = null;
    for (const candidate of await store.listPanes(roomId)) {
      if (candidate.mode !== "TERMINAL" || candidate.terminalRuntimeId !== runtime.id) continue;
      const activeCandidateSession = await store.getActivePaneCliSession(candidate.id);
      if (activeCandidateSession?.purpose === "NORMAL") continue;
      const candidateLoginSession = (await store.listPaneCliSessions(candidate.id, 20))
        .find((session) => session.runtimeId === runtime.id && session.purpose === "LOGIN");
      if (!candidateLoginSession) continue;
      pane = candidate;
      latestLoginSession = candidateLoginSession;
      break;
    }

    const reused = pane !== null;
    if (!pane) {
      await cliRuntimeVisibility.assertEnabled(runtime.id);
      pane = await store.createPane(
        {
          roomId,
          title: runtime.displayName,
          mode: "TERMINAL",
          terminalRuntimeId: runtime.id,
          cwd: "/etc"
        },
        request.requestIdForSpace
      );
      const latestEvent = await getLatestRoomEvent(store, roomId);
      if (latestEvent) eventBus.publish(latestEvent);
    }

    const reusableSession = latestLoginSession?.isActive &&
      latestLoginSession.status !== "EXITED" && latestLoginSession.status !== "ERROR"
      ? latestLoginSession
      : null;
    await cliRuntimeVisibility.assertEnabled(runtime.id);
    const allocatedAtNs = reusableSession ? null : process.hrtime.bigint();
    const session = reusableSession ?? await store.createPaneCliSession(
      {
        paneId: pane.id,
        roomId: pane.roomId,
        runtimeId: runtime.id,
        providerId: runtime.providerId,
        agentId: runtime.agentId,
        modelId: null,
        reasoningEffort: pane.reasoningEffort,
        launchMode: "FRESH",
        purpose: "LOGIN",
        cwd: "/etc",
        codexThreadId: null,
        status: "IDLE",
        statusReason: "CLI login allocated; waiting for terminal transport attach."
      },
      request.requestIdForSpace
    );
    if (allocatedAtNs !== null) cliTerminalManager.recordSessionAllocation(session.sessionId, allocatedAtNs);
    cliTerminalManager.scheduleLoginTimeout(session);

    await recordAudit(store, request, {
      action: "room.cli.login",
      targetType: "runtime",
      targetId: runtime.id,
      metadata: {
        runtimeId: runtime.id,
        outcome: reusableSession ? "REUSED_ACTIVE" : reused ? "RETRIED" : "OPENED",
        durationMs: Math.min(300_000, Date.now() - startedAtMs)
      }
    });

    return cliLoginResponseSchema.parse({
      pane,
      session: await buildPaneCliSessionResponse({
        store,
        runtime,
        sessionId: session.sessionId,
        includeWebsocket: true,
        includeTranscript: false,
        tokenTtlMs: config.cliTokenTtlMs,
        issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
      }),
      reused
    });
  };
  registerCliAccountRoutes(app, {
    removeGeminiAccountProfileState, removeClaudeAccountProfileState, removeCopilotAccountProfileState,
    removeCursorAccountProfileState, deletingCliAccountProfileKeys, cliAccountProfileKey,
    readCliAccountProfileDetails, cliAccountIdentityCacheTtlMs, cliAccountIdentityCache, readCachedCliAccountIdentity,
    invalidateCliAccountIdentity, store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions,
    openCliLogin, gatewayCliAccounts, cliAccountBalancer, removeKimiAccountProfileState
  });

  app.get("/api/cli/codex-defaults", defaultRouteRateLimitOptions, async () => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    return codexCliModeDefaultsService.read();
  });

  registerPaneCliRoutes(app, {
    config, store, observability, cliRuntimeRegistryCache, cliTerminalManager, cliRuntimeVisibility, assertRootAdmin,
    assertPaneCliRuntimeEnabled, cliPaneReopener, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions, cliAccountBalancer, repository: controlRepository,
    assertRoomAccess, paneOwner: roomShares.explicitPaneOwner, assertCliHttpMutationControl,
    waitForCodexThreadSettings, readPaneNativeModelSettings, applyNativePaneModel, readPaneCliModelSettings,
    resolveOpenCodeServerControl, readPaneOpenCodeModelSettings, applyOpenCodePaneSelection, roomOpenCodeTasks,
    assertNoManagedModelMutation, roomPaneController
  });

  const planExecutionTarget = async (owner: string, paneId: string, expectedSessionId?: string) => {
    const actor = await controlUser(owner);
    if (actor.role !== "ADMIN") throw new SpaceConflictError("Managed execution requires current administrator access.");
    const pane = await getPaneById(store, paneId);
    await assertRoomAccess(pane.roomId, actor);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const session = await store.getActivePaneCliSession(pane.id);
    if (!session || !session.isActive || session.status !== "RUNNING" || (expectedSessionId && session.sessionId !== expectedSessionId) ||
        !(isCodexDirectParityRuntime(session.runtimeId) || isClaudeDirectParityRuntime(session.runtimeId)))
      throw new SpaceConflictError("Managed execution requires the same running Codex or Claude Code session.");
    assertNormalCliSession(session);
    if (isClaudeDirectParityRuntime(session.runtimeId)) return claudePlanTarget(session, (options) => readClaudeLiveTurns(session, options));
    let threadId = await resolvePaneCodexThreadId({store,session,traceId:"managed-plan",findThreadId:options.findCodexThreadId});
    if (!threadId && session.cwd) {
      // Fresh TUI threads have a writer lock before their first persisted turn.
      // Bind only the single writer owned by this exact pane/session, confirmed
      // by that session's private native socket and working directory.
      const candidates = await (options.findCodexModelControlThreads ?? findCodexWriterThreads)({
        codexHome: codexDirectParityCodexHome, paneId: pane.id, sessionId: session.sessionId
      });
      if (candidates.length === 1) {
        const native = await codexSocketControlFactory(codexPrivateAppServerSocketPath(session)).readThread?.(candidates[0]!);
        if (native && native.id === candidates[0] && native.cwd === session.cwd && ['idle','active'].includes(native.status)) {
          await store.claimPaneCliCodexThread(session.sessionId,native.id,"AUTO","managed-plan");
          threadId = native.id;
        }
      }
    }
    if (!threadId || !session.cwd) throw new SpaceConflictError("The Codex session has no confirmed native thread and working directory.");
    return {paneId:pane.id,sessionId:session.sessionId,threadId,cwd:session.cwd};
  };
  registerPlanExecutionRoutes(app, {
    store,
    autoStart: config.instanceJobs["managed-plan-controller"],
    maxStageAttempts: config.planStageMaxAttempts,
    target: planExecutionTarget,
    assertStartControl: async (request, target) => {
      const session = await store.getActivePaneCliSession(target.paneId);
      if (!session || session.sessionId !== target.sessionId) throw new SpaceConflictError("The CLI session changed.");
      await assertCliHttpMutationControl(request, session);
    },
    resolve: async execution => {
      const target = await planExecutionTarget(execution.ownerUserId,execution.paneId,execution.sessionId);
      if (target.threadId !== execution.threadId || target.cwd !== execution.cwd)
        throw new SpaceConflictError("Managed execution identity changed.");
      const session = await store.getPaneCliSession(execution.sessionId);
      if (!session || session.paneId !== execution.paneId) throw new SpaceConflictError("Managed session was not found.");
      if (isClaudeDirectParityRuntime(session.runtimeId)) return claudePaneManagedTurnDriver({ store, terminal: cliTerminalManager, pane: await getPaneById(store, session.paneId),
        session, executionId: execution.id, cwd: target.cwd, readTurns: readClaudeLiveTurns, inspect: inspectRoomCli, settings: readPaneNativeModelSettings, applyModel: applyNativePaneModel, log: (fields, message) => app.log.warn(fields, message) });
      return codexSocketControlFactory(codexPrivateAppServerSocketPath(session));
    },
    publish: async event => {
      eventBus.publish(await store.publishManagedPlanExecutionEvent(event));
    }
  });

  const browserControlActivity = registerPaneStreamRoutes(app, {
    config, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions
  });

  const youtubeSessionStarts = new Map<string, Promise<PaneBrowserSessionResponse>>();
  const youtubeAccountOperations = new Map<string, Promise<unknown>>();
  registerPaneRoutes(app, {
    config, store, eventBus, browserSessionManager, cliTerminalManager, cliRuntimeVisibility, taskTitleRepository,
    taskTitleProviders, taskTitles, roomPaneCommands, spaceControl, roomAgentService, assertRootAdmin,
    routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, youtubePlaybackStore,
    readDeepSeekHarnessMaintenanceStatus, youtubeSessionStarts, youtubeAccountOperations,
    initializeNewPaneGoogleAccount: async (userId, pane) => { await roomShares.notePaneCreator(pane, userId); await initializeNewPaneGoogleAccount(userId, pane); },
    cliPaneReopener, resumePreviousJobCopilotSession,
    rememberCliNativeRef: async (session) => { if (isClaudeDirectParityRuntime(session.runtimeId)) await readClaudeLiveTurns(session); }
  });

  // Job Copilot pane: per-owner candidate profile, sealed mailbox credential, tracker, memory, fields, events and runs.
  const jobApplyRepository = config.databaseUrl ? PostgresJobApplyRepository.fromConnectionString(config.databaseUrl) : new InMemoryJobApplyRepository();
  app.addHook("onClose", () => jobApplyRepository.dispose());
  app.addHook("onClose", () => notificationsRepository.dispose());
  app.addHook("onClose", () => { clearInterval(notificationPrune); stopMorningBatches(); stopNotificationProducers(); });
  app.addHook("onClose", startBrowserHandoffNotifications({ store, notifications: notificationService, eventBus, roomOwner, log: app.log }));
  const jobApplyPaneRooms = new Map<string, string>();
  const jobApplyService = options.jobApplyService ?? createJobApplyService({
    repository: jobApplyRepository,
    crypto: connectorCrypto,
    store,
    artifactRoot: config.browserEvidenceArtifactRoot,
    jobApplyRoot: config.jobApplyRoot,
    mailboxes: options.jobApplyMailboxes ?? createImapMailboxFactory(),
    // Gmail and Calendar of the Google account chosen in the pane, through the owner's Google connector.
    google: () => options.jobApplyGoogle ?? connectorServiceRef.current,
    gmailFetch: options.jobApplyGmailFetch, notifications: () => notificationService,
    // Every activity event reaches the pane's room over the event stream; "needs you" moments and run
    // summaries also go to Telegram when the pane settings ask for it.
    onEvent: (event) => {
      void (async () => {
        if (!event.paneId) return;
        let roomId = jobApplyPaneRooms.get(event.paneId) ?? null;
        let pane: Pane | null = null;
        if (!roomId) {
          pane = await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
          roomId = pane?.roomId ?? null;
          if (roomId) jobApplyPaneRooms.set(event.paneId, roomId);
        }
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `job-apply:${event.id}`,
          type: "JOB_APPLY_UPDATED", message: event.message, payload: { event }, createdAt: event.createdAt
        }));
        // A question answered, a review decided or a handoff resolved closes its "needs you" notification.
        const needsYouKey = (kind: string, id: unknown) => `job-apply:${kind}:${String(id ?? event.id)}`;
        const resolves = event.type === "ANSWERED" ? needsYouKey("question", event.payload.questionId) : event.type === "REVIEW_DECIDED" ? needsYouKey("review", event.payload.reviewId)
          : event.type === "HANDOFF_RESOLVED" ? needsYouKey("handoff", event.paneId) : null;
        if (resolves) {
          const owner = await roomOwner(roomId);
          if (owner) await notificationService.resolve(owner, resolves);
          return;
        }
        // Mail triage reaches Telegram only when an application email asks for something.
        const mailNeedsYou = event.type === "MAIL" && event.payload.category === "ACTION_NEEDED";
        // A posting parked as NEEDS_USER logs a QUESTION without a questionId: nothing to answer, nothing resolves it (its real question notifies).
        if (!mailNeedsYou && (!["HANDOFF_REQUESTED", "QUESTION", "REVIEW_REQUESTED", "RUN_FINISHED", "RUN_STOPPED"].includes(event.type) || (event.type === "QUESTION" && typeof event.payload.questionId !== "string"))) return;
        pane ??= await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
        if (!pane || pane.mode !== "JOB_APPLY") return;
        // "Needs you" moments and run summaries are notifications; the pane's own toggles decide in-app and Telegram.
        const notifications = resolveJobApplyPaneMetadata(pane.jobApplyMetadata).settings.notifications;
        if (!notifications.inApp && !notifications.telegram) return;
        const owner = await roomOwner(roomId);
        if (!owner) return;
        const needsYou = mailNeedsYou || event.type === "HANDOFF_REQUESTED" || event.type === "QUESTION" || event.type === "REVIEW_REQUESTED";
        const raised = await notificationService.raise({ ownerUserId: owner, roomId, paneId: event.paneId, source: "JOB_COPILOT", kind: event.type, severity: needsYou ? "ATTENTION" : "INFO",
          title: needsYou ? `${pane.title} needs you` : `${pane.title}: ${event.type === "RUN_FINISHED" ? "run finished" : "run stopped"}`,
          body: event.message.slice(0, 2000), link: { roomId, paneId: event.paneId, target: `job-apply-event:${event.id}` },
          dedupeKey: !needsYou ? null : event.type === "QUESTION" ? needsYouKey("question", event.payload.questionId) : event.type === "REVIEW_REQUESTED" ? needsYouKey("review", event.payload.reviewId)
            : event.type === "HANDOFF_REQUESTED" ? needsYouKey("handoff", event.paneId) : `job-apply:${event.type}:${event.id}`, payload: { eventId: event.id, ...jobApplyNeedsYouAsk(event) }, telegram: false });
        if (!notifications.telegram || raised.payload.heldForNous) return; // a question held for Nous reaches Telegram only through its release (Ask Last step 7)
        await telegramIntegrationManager.notify(`Job Copilot (${pane.title}): ${event.message}`).catch((error: unknown) => {
          app.log.warn({ err: error, paneId: event.paneId }, "Job Copilot Telegram notification failed");
        });
      })().catch((error: unknown) => app.log.warn({ err: error }, "Job Copilot event listener failed"));
    }
  });
  // Job Copilot mail triage every 15 minutes (stable only; a dev copy would act on real Gmail).
  scheduleJobApplyMailTriage(app, { enabled: config.instanceJobs["job-apply-mail-triage"] && options.jobApplyMailTriage !== false && config.optionalModules.has("job-copilot"), triage: (onError) => jobApplyService.triageMailForAllOwners(onError) });
  if (config.optionalModules.has("job-copilot")) registerJobApplyRoutes(app, jobApplyService, {
    store, ...(config.instanceJobs["job-apply-mail-triage"] ? { inspect: (pane: Pane) => roomPaneController.inspect(pane, { fresh: true }), log: app.log } : {}),
    routeOptions: defaultRouteRateLimitOptions,
    // The run's kickoff goes through the pane CLI input path Room Agent uses (typed line + Enter).
    kickoff: options.jobApplyKickoff ?? (async (pane, run, discover) => {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session || session.purpose !== "NORMAL" || !session.isActive || session.status === "EXITED" || session.status === "ERROR") {
        throw new SpaceConflictError("Open the copilot's terminal first: the pane has no running CLI session to receive the run.");
      }
      const prompt = `Job Copilot run ${run.id} started in this pane. Read the space-job-applications skill (SKILL.md), then ${discover ? "first find new postings, because nothing queued can be taken now (the queue is empty or every posting waits for an employer limit): follow references/discovery.md (space_job_discover_search with the operator's PREFERENCE filters, score each against the CV) and queue each one scoring 3 or more with space_job_application_start status QUEUED; then " : ""}loop: call space_jobapply space_job_next until it returns done=true (without MCP tools in this session, call them on demand: JSON {"serverId","toolName","arguments"} on stdin to space-capability call); for each application follow the skill's steps (space_job_memory_recall before asking, space_job_fields_record on every step, evidence before VERIFIED) and close it with space_job_report.`;
      const traceId = `job-apply:${run.id}`;
      await cliTerminalManager.runSerializedTerminalMutation(session.sessionId, async () => {
        await submitCliPrompt(cliTerminalManager, session.sessionId, prompt, traceId, `${traceId}:kickoff`);
      });
    }),
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Job Copilot.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    assertPaneAccess: async (request, pane) => { await assertRoomAccess(pane.roomId, request.user); },
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "job_apply", targetId, metadata })
  });
  // Mail Copilot pane: settings and the operator's view live on the pane; the mailbox is the owner's Google accounts;
  // memory, activity (the agent's work queue) and runs are per owner. Events reach the room stream and, when the
  // copilot needs the operator, the notification system.
  const mailCopilotRepository = options.mailCopilotRepository ?? (config.databaseUrl ? PostgresMailCopilotRepository.fromConnectionString(config.databaseUrl) : new InMemoryMailCopilotRepository());
  app.addHook("onClose", () => mailCopilotRepository.dispose());
  const mailCopilotPaneRooms = new Map<string, string>();
  const mailCopilotKickoff = createMailCopilotKickoff({ store, terminal: cliTerminalManager, send: options.mailCopilotKickoff, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: (pane) => roomPaneController.start(pane, makeSpaceId("trace")) });
  const mailCopilotService = createMailCopilotService({
    kickoff: mailCopilotKickoff,
    google: () => options.mailCopilotGoogle ?? connectorServiceRef.current,
    gmailFetch: options.mailCopilotGmailFetch,
    repository: mailCopilotRepository, resolveNotice: (owner, key) => notificationService.resolve(owner, key),
    onEvent: (event) => {
      void (async () => {
        if (!event.paneId) return;
        let roomId = mailCopilotPaneRooms.get(event.paneId) ?? null;
        let pane: Pane | null = null;
        if (!roomId) {
          pane = await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
          roomId = pane?.roomId ?? null;
          if (roomId) mailCopilotPaneRooms.set(event.paneId, roomId);
        }
        if (!roomId) return;
        eventBus.publish(eventSchema.parse({
          id: makeSpaceId("event"), roomId, paneId: event.paneId, turnId: null, workflowId: null, traceId: `mail-copilot:${event.id}`,
          type: "MAIL_COPILOT_UPDATED", message: event.message, payload: { eventId: event.id, type: event.type, threadId: event.threadId, accountEmail: event.accountEmail }, createdAt: event.createdAt
        }));
        if (!mailCopilotEventNotifies(event)) return;
        pane ??= await Promise.resolve(store.getPane(event.paneId)).catch(() => null);
        const owner = pane?.mode === "MAIL_COPILOT" ? await roomOwner(roomId) : null;
        if (pane && owner) await notifyMailCopilotEvent(event, { roomId, pane, owner, notifications: notificationService });
      })().catch((error: unknown) => app.log.warn({ err: error }, "Mail Copilot event listener failed"));
    }
  });
  registerNotificationRoutes(app, notificationService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to read notifications.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    parseBody,
    parseQuery
  });
  // New mail: Gmail history polling for every open Mail Copilot pane (stable only, like Job Copilot's mail triage).
  const mailCopilotSync = createMailCopilotSync({ service: mailCopilotService, store, log: app.log });
  app.addHook("onReady", async () => {
    if (config.instanceJobs["mail-copilot-sync"] && options.mailCopilotSync !== false && config.optionalModules.has("mail-copilot")) mailCopilotSync.start();
  });
  app.addHook("onClose", async () => mailCopilotSync.stop());
  registerCodexQuotaResetWatch(app, { enabled: config.instanceJobs["codex-quota-reset-notify"], usage: toolbarUsageProvider, store, notifications: notificationService });
  registerGatewayDownWatch(app, { enabled: config.instanceJobs["gateway-down-notify"], gatewayUrl: config.gatewayUrl, store, notifications: notificationService });
  registerMemoryMaintenanceFailureWatch(app, { enabled: config.instanceJobs["memory-maintenance-notify"] && config.memoryGraphEnabled && config.memoryMaintenanceEnabled,
    address: config.temporalAddress, namespace: config.temporalNamespace, store, notifications: notificationService });
  if (config.optionalModules.has("mail-copilot")) registerMailCopilotRoutes(app, mailCopilotService, {
    store,
    routeOptions: defaultRouteRateLimitOptions,
    kickoff: mailCopilotKickoff.send,
    authenticatedOwner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Mail Copilot.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    },
    assertPaneAccess: async (request, pane) => { await assertRoomAccess(pane.roomId, request.user); },
    parseBody,
    parseQuery,
    audit: (request, action, targetId, metadata) => recordAudit(store, request, { action, targetType: "mail_copilot", targetId, metadata })
  });
  const paneBrowserAccounts: { current: PaneBrowserAccountControl | null } = { current: null };
  // The copilot-style panes (Marketing, Freelance, Design, App Studio, Video, Security Copilot) share one route auth: the room's access, the audit row's target type, the signed-in owner.
  const paneModuleAuth = (targetType: string, product: string) => ({ assertPaneAccess: async (request: FastifyRequest, pane: Pane) => { await assertRoomAccess(pane.roomId, request.user); },
    audit: (request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>) => recordAudit(store, request, { action, targetType, targetId, metadata }),
    authenticatedOwner: async (request: FastifyRequest) => { if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", `Sign in to use ${product}.`, 401); return (await store.upsertUser(request.user)).id; } });
  const marketingCopilotService = !config.optionalModules.has("marketing-copilot") ? undefined : registerMarketingCopilot(app, { store, eventBus, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), paneBrowserAccounts, artifactRoot: config.browserEvidenceArtifactRoot, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.marketingCopilotRepository, kickoff: options.marketingCopilotKickoff, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, notifications: notificationService, roomOwner, scheduler: config.instanceJobs["marketing-copilot-scheduler"] && options.marketingCopilotScheduler !== false, metrics: config.instanceJobs["marketing-copilot-metrics"] && options.marketingCopilotMetrics !== false, notice: (owner, key, line) => nousRef.current?.service.notice(owner, key, line), ...paneModuleAuth("marketing_copilot", "Marketing Copilot") });
  const freelanceCopilotService = !config.optionalModules.has("freelance-copilot") ? undefined : registerFreelanceCopilot(app, { store, eventBus, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.freelanceCopilotRepository, kickoff: options.freelanceCopilotKickoff, crypto: connectorCrypto, mailboxes: options.freelanceCopilotMailboxes ?? createImapMailboxFactory(), routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, notifications: notificationService, roomOwner, scheduler: config.instanceJobs["freelance-copilot-scheduler"] && options.freelanceCopilotScheduler !== false, ...paneModuleAuth("freelance_copilot", "Freelance Copilot") });

  const designService = !config.optionalModules.has("design") ? undefined : registerDesign(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.designRepository,
    generate: options.designGenerate, render: options.designRender, kickoff: options.designKickoff, notifications: notificationService, roomOwner, artifactRoot: config.browserEvidenceArtifactRoot,
    brandRoot: fileURLToPath(new URL("../../web/public/brand", import.meta.url)), gatewayUrl: config.gatewayUrl, gatewayKeyFile: config.designGatewayKeyFile,
    routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log,
    marketingPostExists: marketingCopilotService ? async (owner, postId) => Boolean(await marketingCopilotService.getPost(owner, postId).catch(() => null)) : undefined,
    attachToMarketingPost: marketingCopilotService ? async (owner, postId, assets) => { await marketingCopilotService.attachAssets(owner, postId, assets); } : undefined,
    invoke: controlInvoke, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: (pane) => roomPaneController.start(pane, makeSpaceId("trace")), ...paneModuleAuth("design", "the Design pane") });
  const appStudioService = !config.optionalModules.has("app-studio") ? undefined : registerAppStudio(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.appStudioRepository, kickoff: options.appStudioKickoff, notifications: notificationService, artifactRoot: config.browserEvidenceArtifactRoot, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), ...paneModuleAuth("app_studio", "App Studio") });
  const securityCopilotService = !config.optionalModules.has("security-copilot") ? undefined : registerSecurityCopilot(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.securityCopilotRepository, feeds: options.securityCopilotFeeds, kickoff: options.securityCopilotKickoff, notifications: notificationService, watch: config.instanceJobs["security-copilot-watch"] && options.securityCopilotWatch !== false, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), ...paneModuleAuth("security_copilot", "the Security Copilot") }); const monitoringCopilotService = !config.optionalModules.has("monitoring-copilot") ? undefined : registerMonitoringCopilot(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.monitoringCopilotRepository, collector: options.monitoringCopilotCollector, kickoff: options.monitoringCopilotKickoff, notifications: notificationService, watch: config.instanceJobs["monitoring-copilot-watch"] && options.monitoringCopilotWatch !== false, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), ...paneModuleAuth("monitoring_copilot", "the Monitoring Copilot") });

  const videoService = !config.optionalModules.has("video") ? undefined : registerVideo(app, { store, eventBus, terminal: cliTerminalManager, databaseUrl: config.databaseUrl, repository: options.videoRepository,
    engine: options.videoEngine, kickoff: options.videoKickoff, notifications: notificationService, roomOwner, artifactRoot: config.browserEvidenceArtifactRoot, workRoot: config.videoWorkRoot, toolsDir: config.videoToolsDir,
    sourceMaxBytes: config.videoSourceMaxBytes, routeOptions: defaultRouteRateLimitOptions, parseBody, parseQuery, log: app.log, invoke: controlInvoke, inspect: (pane) => roomPaneController.inspect(pane, { fresh: true }), start: (pane) => roomPaneController.start(pane, makeSpaceId("trace")), marketingPostExists: marketingCopilotService ? async (owner, postId) => Boolean(await marketingCopilotService.getPost(owner, postId).catch(() => null)) : undefined,
    attachToMarketingPost: marketingCopilotService ? async (owner, postId, assets) => { await marketingCopilotService.attachAssets(owner, postId, assets); } : undefined, ...paneModuleAuth("video", "the Video pane") });
  const vault = registerVault(app, { config, auth, store, browser: browserSessionManager, routeOptions: defaultRouteRateLimitOptions, overrides: options.vault, paneAccount: effectivePaneProfileId, crypto: connectorCrypto,
    // The CDP proxy is made below; it is asked only per fill, long after start.
    documentDirty: (paneId, targetId, document) => cliBrowserCdpProxy.documentDirty(paneId, targetId, document) });
  registerCliBrowserBridgeRoutes(app, {
    options, config, store, eventBus, browserSessionManager, cliRuntimeVisibility, controlActivity: browserControlActivity, vault, nous: nousRef,
    routeOptions: defaultRouteRateLimitOptions, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService, videoService, appStudioService, securityCopilotService, monitoringCopilotService, jobApplyService: config.optionalModules.has("job-copilot") ? jobApplyService : undefined, mailCopilotService: config.optionalModules.has("mail-copilot") ? mailCopilotService : undefined
  });

  async function withYouTubeAccountLock<T>(paneId: string, operation: () => Promise<T>): Promise<T> {
    const next = (youtubeAccountOperations.get(paneId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    youtubeAccountOperations.set(paneId, next);
    try { return await next; } finally { if (youtubeAccountOperations.get(paneId) === next) youtubeAccountOperations.delete(paneId); }
  }
  async function youtubeAccountOwner(userId: string, pane: Pane) {
    return (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF" ? `${userId}:proof:${pane.roomId}` : userId;
  }

  async function selectedGoogleBrowserAccount(userId: string, pane: Pane, profileId: string | null) {
    if (!profileId?.startsWith("google_account:")) return undefined;
    if ((await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") throw new SpaceConflictError("Real Google accounts are unavailable in proof rooms.");
    const account = (await store.listGoogleAccounts(userId)).find(account => account.id === profileId);
    if (!account) throw new SpaceNotFoundError("The selected Google account is no longer available.");
    return account;
  }
  async function paneGoogleAccountSelection(userId: string, pane: Pane): Promise<string | null> {
    const owner = await youtubeAccountOwner(userId, pane);
    const selectionStore = pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore;
    return selectionStore.get(owner, pane.id);
  }
  /** Legacy scope of a stored pane profile id ("profile:<room>:<pane>[:<key>]"). */
  function paneProfileKeyOf(profileId: string): string | null {
    const key = profileId.split(":")[3];
    return key && /^[a-f0-9]{64}$/.test(key) ? key : null;
  }
  // What a pane opens: its explicit choice, else the user's primary Google account (one shared profile for every pane, Freelance
  // included since 2026-10-21: the Browser Host starts the account's Chrome with its routes), else the pane's own profile. `choice`: one tab's account.
  async function resolvePaneBrowserAccount(userId: string, pane: Pane, choice?: string | null): Promise<PaneBrowserAccount> {
    const selectedProfileId = choice !== undefined ? choice : await paneGoogleAccountSelection(userId, pane);
    if (selectedProfileId === privatePaneProfileId) return { selectedProfileId, profileKey: null };
    const account = await selectedGoogleBrowserAccount(userId, pane, selectedProfileId);
    if (account) return { selectedProfileId, account, profileKey: null };
    if (selectedProfileId !== null) {
      if (!await store.getCliAccountProfile("cli:gemini", selectedProfileId)) {
        throw new SpaceConflictError("The selected Google account is no longer available. Choose another account.");
      }
      const key = youtubeAccountProfileKey(await youtubeAccountOwner(userId, pane), selectedProfileId)!;
      // A CLI (Gemini) account is one Chrome profile for all of the user's panes; proof rooms stay per pane.
      // The per-pane key stays alongside so an older Browser Host keeps the pane's own legacy profile.
      if ((await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") return { selectedProfileId, profileKey: key };
      return { selectedProfileId, profileKey: key, sharedProfileKey: key };
    }
    if ((await store.getRoom(pane.roomId)).kind !== "AGENT_PROOF") {
      const primary = (await store.listGoogleAccounts(userId)).find(candidate => candidate.isPrimary);
      if (primary) return { selectedProfileId: null, account: primary, profileKey: null };
    }
    return { selectedProfileId: null, profileKey: null };
  }
  // Before a pane opens: when its own profile is verifiably signed in to one of the
  // user's Google accounts, that sign-in moves once into the account's shared profile
  // so every Browser and YouTube pane reuses it.
  async function adoptPaneSignIn(userId: string, pane: Pane, resolved: PaneBrowserAccount, actor: BrowserHostActorContext): Promise<PaneBrowserAccount> {
    if (resolved.selectedProfileId === privatePaneProfileId || resolved.sharedProfileKey || (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") return resolved;
    const byDefault = Boolean(resolved.account) && resolved.selectedProfileId === null;
    const active = await store.getActivePaneBrowserSession(pane.id);
    if (active) {
      // A running pane keeps its profile until it next opens fresh; a reconnect (or a new
      // primary account) never swaps it silently.
      if (byDefault && active.profileId.startsWith("profile:")) return { selectedProfileId: null, profileKey: paneProfileKeyOf(active.profileId) };
      if (byDefault && active.profileId.startsWith("google-account:")) {
        const running = (await store.listGoogleAccounts(userId)).find(candidate => `google-account:${candidate.id}` === active.profileId);
        if (running) return { selectedProfileId: null, account: running, profileKey: null };
      }
      return resolved;
    }
    // Without the Browser Host move (older host), prefer the pane's own profile unless the shared one is verified.
    const ownProfileUnlessShared = async (): Promise<PaneBrowserAccount> => {
      if (!byDefault || !resolved.account) return resolved;
      const check = await readGoogleBrowserCheck(googleBrowserProfilePathFor(config.browserSessionsProfileRoot, userId, resolved.account.id)).catch(() => null);
      return check?.status === "CONNECTED" ? resolved : { selectedProfileId: null, profileKey: null };
    };
    if (!browserSessionManager.adoptPaneGoogleProfile) return ownProfileUnlessShared();
    const accounts = await store.listGoogleAccounts(userId);
    if (!accounts.length) return resolved;
    let profileKey: string | null = resolved.profileKey;
    if (resolved.account && resolved.selectedProfileId !== null) {
      // An explicit account choice: look at the pane profile it used before, if any.
      const prior = await store.getLatestPaneBrowserSession(pane.id);
      if (!prior?.profileId.startsWith("profile:")) return resolved;
      profileKey = paneProfileKeyOf(prior.profileId);
    }
    let adoption: PaneProfileAdoptionResult;
    try {
      // An explicit account choice may only receive that account's sign-in.
      const wanted = resolved.account && resolved.selectedProfileId !== null ? { accountId: resolved.account.id } : {};
      adoption = await browserSessionManager.adoptPaneGoogleProfile({ ownerUserId: userId, roomId: pane.roomId, paneId: pane.id, profileKey, ...wanted }, actor);
    } catch (error) {
      app.log.warn({ err: error, paneId: pane.id }, "Pane Google sign-in adoption failed; opening the current selection.");
      return ownProfileUnlessShared();
    }
    const owner = await youtubeAccountOwner(userId, pane);
    const selectionStore = pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore;
    const verified = adoption.accountId ? accounts.find(candidate => candidate.id === adoption.accountId &&
      (resolved.selectedProfileId === null || candidate.id === resolved.account?.id)) : undefined;
    if (verified && (adoption.result === "ADOPTED" || adoption.result === "ALREADY_CONNECTED")) {
      await selectionStore.save(owner, pane.id, verified.id);
      return { selectedProfileId: verified.id, account: verified, profileKey: null };
    }
    if (adoption.result === "TARGET_IN_USE" && (!resolved.account || resolved.selectedProfileId === null)) {
      // The shared profile is busy right now; keep this pane's own signed-in profile and retry next time.
      return { selectedProfileId: resolved.selectedProfileId, profileKey };
    }
    if (adoption.result === "OTHER_ACCOUNT" && resolved.account && resolved.selectedProfileId === null) {
      // Signed in to a Google account that is not linked to this user: keep that pane private.
      await selectionStore.save(owner, pane.id, privatePaneProfileId);
      return { selectedProfileId: privatePaneProfileId, profileKey: null };
    }
    return resolved;
  }
  /** The account a pane opens with; the primary account when nothing was chosen. */
  async function effectivePaneProfileId(userId: string, pane: Pane): Promise<string | null> {
    try {
      const resolved = await resolvePaneBrowserAccount(userId, pane);
      return resolved.account?.id ?? resolved.selectedProfileId;
    } catch { return null; }
  }
  // The newest closed Job/Marketing/Freelance Copilot pane of the room and kind (pruning keeps it): a new one continues its browser
  // account, tabs and view (Job Copilot also its terminal). shortcut: same room only; look across rooms if that becomes common.
  async function previousCopilotPane(pane: Pane): Promise<Pane | null> {
    if (pane.mode !== "JOB_APPLY" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT") return null;
    const closed = (await store.listPanes(pane.roomId, true)).filter((entry) => entry.mode === pane.mode && entry.isClosed && entry.id !== pane.id);
    return closed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0] ?? null;
  }
  async function initializeNewPaneGoogleAccount(userId: string, pane: Pane): Promise<void> {
    if (pane.mode !== "BROWSER" && pane.mode !== "YOUTUBE" && pane.mode !== "JOB_APPLY" && pane.mode !== "MARKETING_COPILOT" && pane.mode !== "FREELANCE_COPILOT") return;
    const owner = await youtubeAccountOwner(userId, pane);
    const room = await store.getRoom(pane.roomId);
    const accounts = room.kind === "AGENT_PROOF" ? [] : await store.listGoogleAccounts(userId);
    let initial = accounts.find(account => account.isPrimary)?.id ?? null;
    if (room.kind !== "AGENT_PROOF") {
      // The account the previous copilot pane of this kind used, while it is still linked.
      const previous = await previousCopilotPane(pane);
      const chosen = previous ? await browserAccountStore.get(owner, previous.id) : null;
      if (chosen && (!chosen.startsWith("google_account:") || accounts.some(account => account.id === chosen))) initial = chosen;
    }
    await (pane.mode === "YOUTUBE" ? youtubeAccountStore : browserAccountStore).initializeSelection(owner, pane.id, initial);
  }
  // Gemini account emails for the account menus (they merge a Gemini account with the
  // linked Google account of the same email). An email rarely changes, so a menu waits
  // only briefly for the native probe and otherwise keeps the last known email.
  const geminiBrowserEmails = new Map<string, { email: string | null; expiresAt: number }>();
  async function geminiAccountEmails(profileIds: string[]): Promise<Map<string, string | null>> {
    const stale = profileIds.filter(profileId => (geminiBrowserEmails.get(profileId)?.expiresAt ?? 0) <= Date.now());
    if (stale.length) {
      let next = 0;
      const refresh = Promise.all(Array.from({ length: Math.min(4, stale.length) }, async () => {
        while (next < stale.length) {
          const profileId = stale[next++]!;
          const { email } = await readCachedCliAccountIdentity("cli:gemini", profileId);
          const known = geminiBrowserEmails.get(profileId)?.email ?? null;
          geminiBrowserEmails.set(profileId, { email: email ?? known, expiresAt: Date.now() + (email ? 10 * 60_000 : 60_000) });
        }
      }));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([refresh, new Promise(resolve => { timer = setTimeout(resolve, 1_500); timer.unref?.(); })]);
      clearTimeout(timer);
    }
    return new Map(profileIds.map(profileId => [profileId, geminiBrowserEmails.get(profileId)?.email ?? null]));
  }
  /** Sign-in state of the one shared Chrome profile every pane opens for a Gemini account. */
  async function geminiAccountBrowserStatus(userId: string, profileId: string) {
    try { return await cliAccountBrowserStatus(sharedCliProfilePathFor(config.browserSessionsProfileRoot, youtubeAccountProfileKey(userId, profileId)!)); }
    catch { return "UNKNOWN" as const; }
  }
  async function browserAccountChoices(userId: string, pane: Pane) {
    const gemini = await store.listCliAccountProfiles("cli:gemini");
    // Proof rooms open per-pane profiles and never see real account identities.
    const proofRoom = (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF";
    const accounts = proofRoom ? [] : await store.listGoogleAccounts(userId);
    const [statuses, emails, geminiStatuses] = await Promise.all([
      googleAccountBrowserStatuses(accounts),
      proofRoom ? new Map<string, string | null>() : geminiAccountEmails(gemini.map(profile => profile.profileId)),
      proofRoom ? [] : Promise.all(gemini.map(profile => geminiAccountBrowserStatus(userId, profile.profileId)))
    ]);
    return [...accounts.map(account => ({
      profileId: account.id,
      displayName: `Google account · ${account.displayName || account.email}`,
      label: account.displayName || account.email,
      email: account.email,
      browserStatus: statuses.get(account.id)!.browserStatus
    })), ...gemini.map(({ profileId, displayName }, index) => ({
      profileId,
      displayName: `Gemini account · ${displayName}`,
      label: displayName,
      ...(proofRoom ? {} : { email: emails.get(profileId) ?? null, browserStatus: geminiStatuses[index]! })
    }))];
  }

  // CLI agents attach element-level automation to a pane browser through this proxy; operator control drops it.
  const cliBrowserCdpProxy = createCliBrowserCdpProxy({
    store,
    config,
    isBrowserPane,
    assertRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.assertEnabled(runtimeId),
    vaultProtection: vault.protection,
    log: app.log,
    onConnected: (request, resolution) => {
      browserControlActivity.noteAgent(resolution.pane.id, resolution.claims.paneId);
      return recordAudit(store, request, {
        action: "pane.cli.browser_cdp_attach",
        targetType: "pane",
        targetId: resolution.pane.id,
        metadata: { roomId: resolution.claims.roomId, cliPaneId: resolution.claims.paneId, cliSessionId: resolution.claims.cliSessionId, sessionId: resolution.session.sessionId }
      });
    }
  });
  cliBrowserCdpProxy.register(app, defaultRouteRateLimitOptions); vault.protection.onProtected((paneId) => cliBrowserCdpProxy.closeForPane(paneId, "VAULT_PROTECTED", "This browser is protected for the Vault."));

  registerBrowserCensusRoutes(app, { store, browserSessionManager, controlActivity: browserControlActivity, cdpConnectionCount: (paneId) => cliBrowserCdpProxy.connectionCount(paneId), geminiEmails: geminiAccountEmails, routeOptions: defaultRouteRateLimitOptions });
  paneBrowserAccounts.current = registerPaneBrowserRoutes(app, {
    config, readGeminiAccountProfileDetails, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions, cliBrowserCdpProxy,
    controlActivity: browserControlActivity, youtubePlaybackStore, youtubeAccountStore, browserAccountStore, youtubeSessionStarts, youtubeAccountOperations,
    withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount, paneGoogleAccountSelection,
    resolvePaneBrowserAccount, adoptPaneSignIn, effectivePaneProfileId, browserAccountChoices, previousCopilotPane, videoEngine: options.videoEngine,
    onJobCopilotAccountSelected: async (userId, email) => { await jobApplyService.setGoogleAccount(userId, email); },
    onControlReleased: (paneId) => void settleBrowserHandoffNotifications({ store, notifications: notificationService }, paneId)
      .catch((error: unknown) => app.log.warn({ err: error, paneId }, "Browser handoff notifications could not be settled after a release."))
  });

  registerInternalAgentActionRoutes(app, {
    config, store, browserSessionManager, cliRuntimeVisibility, roomActionExecutor, vaultProtection: vault.protection,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerPaneBrowserFrameRoutes(app, {
    store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions, youtubeSessionStarts,
    youtubeAccountOperations
  });

  registerPaneCliSessionRoutes(app, {
    config, deletingCliAccountProfileKeys, cliAccountProfileKey, store, eventBus, codexCliModeDefaultsService,
    spaceAgentAdapter, cliRuntimeRegistryCache, cliTerminalManager, assertCliHttpMutationControl,
    cliRuntimeVisibility, resolveOpenCodeServerControl, resumePaneCliTask, spaceControl, assertRootAdmin,
    assertPaneCliRuntimeEnabled, routeOptions: defaultRouteRateLimitOptions, cliAccountBalancer, cliPaneReopener, claudeDirectPins,
    onUserCliHost: cliUserHosting.onUserCliHost
  });

  const spaceControlRoutes = registerSpaceControlRoutes(app,spaceControl,{cliRoom:request=>controlCliRooms.get(request)??null,resolveActor:controlUser});
  const dotGoalsRepository = dotsRepository && config.databaseUrl ? PostgresDotGoalsRepository.fromConnectionString(config.databaseUrl) : null;
  if (dotGoalsRepository) app.addHook("onClose", () => dotGoalsRepository.dispose());
  /** Autonomous work (Goal steps, schedules) respects each Dot's concurrent-task limit; the user's own sends never do. */
  async function dotAtCapacity(input: { sessionId: string; dotId: string; roomId: string }): Promise<boolean> {
    if (!dotsRepository) return false;
    const owner = (await store.getRoom(input.roomId)).ownerUserId;
    const dot = owner ? await dotsRepository.get(owner, input.dotId) : null;
    if (!dot) return false;
    return await dotsRepository.countActiveDotRuns(input.dotId, input.sessionId) >= dot.workLimits.maxConcurrentTasks;
  }
  const dotGoalService = dotsRepository && dotGoalsRepository ? createDotGoalService({
    store, dots: dotsRepository, goals: dotGoalsRepository,
    workflow: options.dotGoalWorkflow ?? createDotGoalWorkflowCoordinator({ enabled: config.enableCodexTurns, address: config.temporalAddress,
      namespace: config.temporalNamespace, taskQueue: config.temporalTaskQueue }),
    sendStep: async ({ paneId, sessionId, ownerUserId, content, requestKey }) => {
      const pane = await getPaneById(store, paneId);
      const result = await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: ownerUserId, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
      if (!result.submission) throw new SpaceConflictError(result.session.statusReason ?? "The Goal step could not start.");
      return { runId: result.submission.runId };
    },
    interrupt: async (paneId, reason) => { await spaceAgentAdapter.interrupt({ pane: await getPaneById(store, paneId), reason }); },
    submission: async (paneId, requestKey) => {
      const run = await store.getSpaceAgentSubmission(paneId, requestKey);
      return run ? { runId: run.runId, status: run.status } : null;
    },
    atCapacity: dotAtCapacity,
    supportsGoalTools: (session) => config.dotToolGatewayEnabled && (!session.selectedProviderId || session.selectedProviderId === "codex")
      && session.permissionMode !== "ask_for_approval",
    audit: (request, action, roomId, metadata) => request ? recordAudit(store, request, { action, targetType: "room", targetId: roomId, metadata }) : Promise.resolve()
  }) : null;
  registerDotGoalRoutes(app, dotGoalService, dotGoalsRepository ? { goals: dotGoalsRepository } : null, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
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
    inspect: (pane, fresh) => roomPaneController.inspect(pane, { fresh }), paneReports: () => nousRef.current?.paneReports, onEvent: roomAgentMonitorOnEvent,
    gatewayProfileReady: async () => Boolean((await gatewayCliAccounts.gatewayProfile("cli:claude"))?.ready), gatewayAccounts: () => resolveGatewayAdminService().listAccounts(),
    switchToGateway: async (pane, session) => { await switchClaudePaneAccount(claudeAccountSwitchDeps, pane, session, CLAUDE_GATEWAY_PROFILE, makeSpaceId("trace")); roomCliObservationCache.delete(pane.id); },
    answer: (pane, input) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, ...input, when: "NOW" }, makeSpaceId("trace")),
    onAttention: (event) => { void roomAgentAutopilot.handle(event); }, log: (event, detail) => app.log.info({ event, ...detail }, "Claude usage limit move") }));
  let cliAccountAutoSwitchTimer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
    cliAccountAutoSwitchTimer = setInterval(() => { void cliAccountAutoSwitch.tick(); void claudeLimitMove.tick(); }, 30_000);
    cliAccountAutoSwitchTimer.unref();
  });
  app.addHook("onClose", async () => { if (cliAccountAutoSwitchTimer) clearInterval(cliAccountAutoSwitchTimer); });
  async function sweepStrandedChatRuns(): Promise<void> {
    if (!dotsRepository || !config.enableCodexTurns) return;
    // One Temporal connection per sweep, opened only when a candidate run needs
    // checking. If Temporal is unreachable, every run of this sweep stays as it is.
    const temporal: { client: Client | null; connection: Connection | null; unreachable: boolean } =
      { client: null, connection: null, unreachable: false };
    try {
      await sweepStrandedChatRunsOnce({
        repository: dotsRepository, store, now: nowIso,
        warn: (fields, message) => app.log.warn(fields, message),
        workflowState: async (workflowId) => {
          if (temporal.unreachable) return "UNKNOWN";
          try {
            if (!temporal.client) {
              temporal.connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "5s" })
                .catch((error: unknown) => { temporal.unreachable = true; throw error; });
              temporal.client = new Client({ connection: temporal.connection, namespace: config.temporalNamespace });
            }
            return (await temporal.client.workflow.getHandle(workflowId).describe()).status.name === "RUNNING" ? "RUNNING" : "CLOSED";
          } catch (error) {
            return error instanceof WorkflowNotFoundError ? "NOT_FOUND" : "UNKNOWN";
          }
        }
      });
    } finally { await temporal.connection?.close(); }
  }
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
  // Stage 7: Auto runs in shadow mode; ADMINs see what it would have chosen and how those tasks went.
  const autoRouteShadowRepository = options.autoRouteShadowRepository
    ?? (config.databaseUrl ? PostgresAutoRouteShadowRepository.fromConnectionString(config.databaseUrl) : null);
  if (autoRouteShadowRepository && !options.autoRouteShadowRepository) app.addHook("onClose", () => autoRouteShadowRepository.dispose());
  app.get("/api/dots/auto-routing/shadow", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Auto routing evidence requires ADMIN.");
    const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict().safeParse(request.query ?? {});
    if (!query.success) return sendApiError(reply, 400, "INVALID_QUERY", "days must be a whole number from 1 to 90.");
    if (!autoRouteShadowRepository) return sendApiError(reply, 503, "AUTO_ROUTING_UNAVAILABLE", "Auto routing evidence needs the database.");
    const since = new Date(Date.now() - query.data.days * 86_400_000).toISOString();
    const [runs, facts] = await Promise.all([autoRouteShadowRepository.recent(since, 5_000), autoRouteFactsLoader?.().catch(() => null) ?? null]);
    return { since, ...summarizeAutoRouteShadow(runs, facts?.prices ?? null) };
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
  // Stage 6: Slack and Teams conversations with Dots. Configured per installation; inbound requests are verified by signature.
  const channelsRepository = options.channelsRepository
    ?? (dotsRepository && dotGoalsRepository && config.databaseUrl ? PostgresChannelsRepository.fromConnectionString(config.databaseUrl) : null);
  if (channelsRepository && !options.channelsRepository) app.addHook("onClose", () => channelsRepository.dispose());
  const slackSigningSecret = process.env.SPACE_SLACK_SIGNING_SECRET || null;
  const slackClient = slackSigningSecret && process.env.SPACE_SLACK_BOT_TOKEN ? createSlackClient({ botToken: process.env.SPACE_SLACK_BOT_TOKEN }) : null;
  const teamsAppId = process.env.SPACE_TEAMS_APP_ID || null;
  const teamsClient = teamsAppId && process.env.SPACE_TEAMS_APP_PASSWORD
    ? createTeamsClient({ appId: teamsAppId, appPassword: process.env.SPACE_TEAMS_APP_PASSWORD, tenant: process.env.SPACE_TEAMS_TENANT || null }) : null;
  const appOrigin = (() => {
    if (process.env.SPACE_PUBLIC_ORIGIN) return process.env.SPACE_PUBLIC_ORIGIN.replace(/\/$/, "");
    try { return auth.googleRedirectUri ? new URL(auth.googleRedirectUri).origin : null; } catch { return null; }
  })();
  const dotChannelService = config.optionalModules.has("channels") && channelsRepository && dotsRepository && dotGoalsRepository && dotGoalService ? createDotChannelService({
    repo: channelsRepository, slack: slackClient, teams: teamsClient,
    providers: [
      { provider: "SLACK", configured: Boolean(slackClient), reason: slackClient ? null : "Slack needs an app on this server (SPACE_SLACK_SIGNING_SECRET and SPACE_SLACK_BOT_TOKEN).",
        appUrl: slackClient ? slackAppUrl(process.env.SPACE_SLACK_APP_ID) : null },
      { provider: "TEAMS", configured: Boolean(teamsClient), reason: teamsClient ? null : "Teams needs a bot registration on this server (SPACE_TEAMS_APP_ID and SPACE_TEAMS_APP_PASSWORD)." }
    ],
    store, dots: dotsRepository,
    pickRoom: async (owner) => {
      const rooms = (await store.listRooms(owner)).filter((room) => room.kind === "WORKSPACE" && room.ownerUserId === owner);
      return rooms.sort((a, b) => a.order - b.order)[0]?.id ?? null;
    },
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId }) => {
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The channel conversation could not start.");
      return { sessionId: session.binding.sessionId };
    },
    send: async ({ paneId, sessionId, owner, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane: await getPaneById(store, paneId), sessionId, content, operatorUserId: owner, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
    },
    pendingApprovals: async (owner, dotId, sessionId) => ((await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? [])
      .map((item) => ({ invocationId: item.invocationId, summary: item.approvalSummary ?? item.toolId })),
    goalFor: async (owner, dotId, sessionId) => {
      const goal = (await dotGoalsRepository.list(owner, dotId, sessionId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return goal ? { goalId: goal.goalId, status: goal.status, statusReason: goal.statusReason ?? null, createdAt: goal.createdAt, updatedAt: goal.updatedAt } : null;
    },
    answerGoal: async (owner, dotId, goalId, text) => {
      await dotGoalService.steer(owner, dotId, goalId, { text: text.slice(0, 4000) }, null);
      await dotGoalService.control(owner, dotId, goalId, { action: "RESUME" }, null);
    },
    appOrigin,
    log: (message, error) => app.log.warn({ err: error }, message)
  }) : null;
  registerDotChannelRoutes(app, dotChannelService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: dotsAuthenticatedOwner,
    verifySlack: slackSigningSecret ? (input) => verifySlackSignature({ ...input, signingSecret: slackSigningSecret }) : null,
    parseSlack: parseSlackEnvelope,
    verifyTeams: teamsAppId && teamsClient ? createBotFrameworkVerifier({ appId: teamsAppId }) : null,
    parseTeams: parseTeamsActivity,
    log: (message, error) => app.log.warn({ err: error }, message)
  });
  // Stage 6: Live hands work to a Dot, answers or steers its Goal, and asks how it is going, in that Dot's own conversation.
  const dotLiveService = dotsRepository && dotGoalsRepository && dotGoalService ? createDotLiveService({
    store, dots: dotsRepository,
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId }) => {
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The Dot's conversation could not start.");
      return { sessionId: session.binding.sessionId };
    },
    send: async ({ pane, sessionId, owner, content, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: owner, clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    },
    openGoal: async (sessionId) => {
      const goal = await dotGoalsRepository.openForSession(sessionId);
      return goal ? { goalId: goal.goalId, status: goal.status, objective: goal.objective, statusReason: goal.statusReason ?? null,
        steps: goal.usage.steps, maxSteps: goal.budget.maxSteps } : null;
    },
    steerGoal: async (owner, dotId, goalId, text, resume) => {
      await dotGoalService.steer(owner, dotId, goalId, { text: text.slice(0, 4000) }, null);
      if (resume) await dotGoalService.control(owner, dotId, goalId, { action: "RESUME" }, null);
    },
    pendingApprovals: async (owner, dotId, sessionId) => ((await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? [])
      .map((item) => ({ summary: item.approvalSummary ?? item.toolId })),
    watch: async (owner, roomId, paneId) => ((await spaceControl.watches(await controlUser(owner), roomId, "register", { paneId })) as { id?: string })?.id ?? null,
    isChannelSession: channelsRepository ? async (sessionId) => Boolean(await channelsRepository.threadForSession(sessionId, "SLACK")
      ?? await channelsRepository.threadForSession(sessionId, "TEAMS")) : undefined
  }) : null;
  registerDotLiveRoutes(app, dotLiveService, { routeOptions: defaultRouteRateLimitOptions, authenticatedOwner: dotsAuthenticatedOwner });
  // Stage 7: frozen evaluation datasets run on the real runtime, started explicitly by an ADMIN for one of their Dots.
  const dotEvalRunnerId = `api:${randomBytes(12).toString("hex")}`;
  const dotEvalsRepository = options.dotEvalsRepository
    ?? (dotsRepository && dotGoalsRepository && config.databaseUrl ? PostgresDotEvalsRepository.fromConnectionString(config.databaseUrl) : null);
  if (dotEvalsRepository && !options.dotEvalsRepository) {
    app.addHook("onClose", () => dotEvalsRepository.dispose());
    // Cases left open by a stopped API process are closed, never resumed silently, and their Goals are cancelled.
    app.addHook("onReady", async () => {
      const abandoned = await dotEvalsRepository.abandon(dotEvalRunnerId, "The server restarted during the evaluation.").catch(() => []);
      for (const item of abandoned) {
        if (item.goalId && dotGoalService) await dotGoalService.control(item.ownerUserId, item.dotId, item.goalId, { action: "CANCEL" }, null).catch(() => undefined);
      }
    });
  }
  const evalMimeTypes: Record<string, string> = { csv: "text/csv", md: "text/markdown", pdf: "application/pdf", png: "image/png",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const dotEvalService = dotEvalsRepository && dotsRepository && dotGoalsRepository && dotGoalService && dotDelegationService ? createDotEvalService({
    datasetsRoot: process.env.SPACE_EVALS_ROOT || fileURLToPath(new URL("../../../evals/", import.meta.url)),
    evals: dotEvalsRepository,
    available: async (owner) => {
      const accounts = connectorService ? (await connectorService.status(owner).catch(() => null))?.accounts ?? [] : [];
      const capabilities = new Set(accounts.flatMap((account) => account.capabilities));
      const channels = dotChannelService ? await dotChannelService.available(owner).catch(() => []) : [];
      return new Set([...(capabilities.has("MAIL_READ") ? ["connector:mail-read"] : []), ...(capabilities.has("MAIL_COMPOSE") ? ["connector:mail-compose"] : []),
        ...(capabilities.has("CALENDAR") ? ["connector:calendar"] : []), ...channels]);
    },
    openPane: async ({ roomId, title }) => {
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const [input] = await roomPaneCommands.resolve(roomId, [{ mode: "CHAT" }]);
      const [pane] = await store.createPanes([{ ...input!, title }], makeSpaceId("trace"));
      for (const event of (await store.listEvents(roomId)).filter((event) => event.type === "PANE_CREATED" && event.paneId === pane!.id)) eventBus.publish(event);
      return pane!;
    },
    startSession: async ({ pane, owner, dotId, modelConfigId }) => {
      // A new conversation per case. Space tool writes wait for approval through the gateway while the case runs;
      // the runtime itself works in the sandboxed workspace mode when the installation allows it.
      const session = await spaceAgentAdapter.createOrRestoreSession({ pane, dotId, ownerUserId: owner, sessionId: null,
        ...(modelConfigId ? { selectedModelConfigId: modelConfigId } : {}) });
      if (!session.binding.sessionId || session.dotId !== dotId) throw new SpaceConflictError("The evaluation conversation could not start.");
      await spaceAgentAdapter.updateSettings({ pane, permissionMode: "approve_for_me" }).catch(() => undefined);
      return { sessionId: session.binding.sessionId };
    },
    uploadFixture: async ({ roomId, owner, name, data }) => {
      const mimeType = evalMimeTypes[name.split(".").pop() ?? ""] ?? "application/octet-stream";
      const storage = buildGenericUserUploadStorage({ artifactRoot: config.browserEvidenceArtifactRoot, roomId, originalFilename: name });
      await mkdir(dirname(storage.filePath), { recursive: true });
      await writeFile(storage.filePath, data, { flag: "wx" });
      try {
        const result = await store.createArtifact({ roomId, paneId: null, kind: mimeType.startsWith("image/") ? "IMAGE" : "EXPORT", mimeType,
          storageUri: storage.storageUri, sha256: createHash("sha256").update(data).digest("hex"), byteSize: data.length,
          metadata: { source: "USER_UPLOAD", originalFilename: name, storedFilename: storage.storedFilename, uploadedBy: owner, evaluation: true } }, makeSpaceId("trace"));
        eventBus.publish(result.event);
        return result.artifact.id;
      } catch (error) { await unlink(storage.filePath).catch(() => undefined); throw error; }
    },
    send: async ({ pane, sessionId, owner, content, artifactIds, requestKey }) => {
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, artifactIds, operatorUserId: owner, clientRequestId: requestKey, traceId: makeSpaceId("trace") });
    },
    createGoal: (owner, dotId, input) => dotGoalService.create(owner, dotId, input, null),
    goalStatus: async (goalId) => (await dotGoalsRepository.get(goalId))?.status ?? null,
    cancelGoal: async (owner, dotId, goalId) => { await dotGoalService.control(owner, dotId, goalId, { action: "CANCEL" }, null); },
    latestRunStatus: async (sessionId) => (await store.getLatestSpaceAgentRun(sessionId))?.status ?? null,
    interrupt: async (pane) => { await spaceAgentAdapter.interrupt({ pane }); },
    runnerId: dotEvalRunnerId,
    declinePending: async (owner, dotId, sessionId) => {
      for (const pending of (await dotsRepository.listPendingApprovals(owner, dotId, sessionId)) ?? []) {
        const decided = await dotsRepository.decideToolApproval(owner, dotId, pending.invocationId, "DECLINE", owner);
        const payload = decided?.payload as { kind?: string; scheduleId?: string } | undefined;
        if (payload?.kind === "schedule" && payload.scheduleId && dotScheduleService) {
          await dotScheduleService.control(owner, dotId, payload.scheduleId, { action: "CANCEL" }).catch(() => undefined);
        }
      }
    },
    log: (message, error) => app.log.warn({ err: error }, message)
  }) : null;
  registerDotEvalRoutes(app, dotEvalService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: dotsAuthenticatedOwner,
    ownsDot: async (owner, dotId) => Boolean(dotsRepository && await dotsRepository.get(owner, dotId)),
    ownsRoom: async (owner, roomId) => (await Promise.resolve(store.getRoom(roomId)).catch(() => null))?.ownerUserId === owner
  });
  registerDotComputerRoutes(app, dotComputerService, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
  // Stage 8: the Dot writes to the user on its own about new email and upcoming events (read-only checks).
  const dotProactiveModel = process.env.SPACE_DOT_PROACTIVE_MODEL || "gpt-5.6-sol";
  const dotProactiveService = dotHomeRepository && dotsRepository && connectorService ? createDotProactiveService({
    home: dotHomeRepository, dots: dotsRepository,
    accounts: async (owner) => (await connectorService.status(owner)).accounts,
    connectorTool: (owner, toolId, args) => connectorService.tool(owner, toolId, args),
    timeZone: async (owner) => (await store.getUserSettings(owner)).dateTime.timeZone,
    alsoSlack: dotChannelService ? (owner, notice) => dotChannelService.notifyOwner(owner, notice) : undefined,
    usage: { model: dotProactiveModel, prices: createPriceCatalogLoader(config.modelPriceCatalogPath ?? null),
      record: (owner, entry) => dotHomeRepository.addProactiveUsage(owner, entry) },
    decide: createProactiveDecider({ baseUrl: config.codexLbBaseUrl, model: dotProactiveModel,
      apiKey: async () => config.codexLbKeyFile ? (await readFile(config.codexLbKeyFile, "utf8").catch(() => "")).trim() || null : null }),
    log: (message, detail) => app.log.warn(detail, message)
  }) : null;
  let dotProactiveTimer: NodeJS.Timeout | null = null;
  let dotChannelTimer: NodeJS.Timeout | null = null;
  let dotScheduleTimer: NodeJS.Timeout | null = null;
  let dotDelegationTimer: NodeJS.Timeout | null = null;
  let dotGoalReconcileTimer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    if (!config.enableCodexTurns || !config.instanceJobs["dot-schedules"]) return;
    if (dotScheduleService) {
      dotScheduleTimer = setInterval(() => void dotScheduleService.tick().catch((error) => app.log.warn({ err: error }, "Dot schedule tick failed.")), 30_000);
      dotScheduleTimer.unref();
    }
    if (dotProactiveService) {
      dotProactiveTimer = setInterval(() => void dotProactiveService.tick().catch((error) => app.log.warn({ err: error }, "Dot proactive tick failed.")), 5 * 60_000);
      dotProactiveTimer.unref();
    }
    if (dotChannelService) {
      // Slack and Teams: answers, Goal questions and approval notices, and messages that waited for a busy Dot.
      dotChannelTimer = setInterval(() => void dotChannelService.sweep().catch((error) => app.log.warn({ err: error }, "Channel sweep failed.")), 15_000);
      dotChannelTimer.unref();
    }
    if (dotDelegationService) {
      // Delegated Goals report their outcome to the delegating conversation; a busy conversation is retried.
      dotDelegationTimer = setInterval(() => void dotDelegationService.reportOutcomes().catch((error) => app.log.warn({ err: error }, "Dot delegation reports failed.")), 60_000);
      dotDelegationTimer.unref();
    }
    if (dotGoalService) {
      const reconcile = () => void dotGoalService.reconcile().then((restarted) => {
        if (restarted) app.log.warn({ restarted }, "Restarted drivers for open Dot Goals.");
      }).catch((error) => app.log.warn({ err: error }, "Dot Goal reconciliation failed."));
      setTimeout(reconcile, 60_000).unref();
      dotGoalReconcileTimer = setInterval(reconcile, 5 * 60_000);
      dotGoalReconcileTimer.unref();
    }
  });
  app.addHook("onClose", async () => { if (dotScheduleTimer) clearInterval(dotScheduleTimer); if (dotGoalReconcileTimer) clearInterval(dotGoalReconcileTimer);
    if (dotDelegationTimer) clearInterval(dotDelegationTimer); if (dotChannelTimer) clearInterval(dotChannelTimer);
    if (dotProactiveTimer) clearInterval(dotProactiveTimer); });
  const installedMcpRegistryPath = "/opt/spaceapp/bin/tool-routing-current/mcp-registry.json";
  const mcpResultRoot = resolve(config.browserEvidenceArtifactRoot, "mcp-executions");
  registerDotToolGatewayRoutes(app, dotsRepository ? {
    store, repository: dotsRepository,
    resolveActor: (userId) => controlUser(userId),
    callControl: (actor, tool, args) => spaceControlRoutes.call(actor, tool, args),
    catalogContext: async ({ roomId, role, ownerUserId }) => {
      const [servers, tools, sessions, registry, connectors, channels] = await Promise.all([
        store.listMcpServers(), store.listMcpTools(), roomId ? store.listActivePaneBrowserSessions(roomId) : Promise.resolve([]),
        readFile(installedMcpRegistryPath, "utf8").then((text) => JSON.parse(text) as { servers?: Array<{ id?: unknown; description?: unknown }> })
          .catch(() => ({ servers: [] })),
        connectorService && ownerUserId ? connectorService.catalog(ownerUserId).catch(() => null) : Promise.resolve(null),
        dotChannelService && ownerUserId ? dotChannelService.status(ownerUserId).catch(() => null) : Promise.resolve(null)
      ]);
      const serverById = new Map(servers.map((server) => [server.id, server]));
      return {
        role,
        ...(channels ? { channels: channels.providers.map((provider) => ({ provider: provider.provider, configured: provider.configured,
          linked: channels.identities.some((identity) => identity.provider === provider.provider) })) } : {}),
        ...(connectors ?? (connectorService ? { connectorAccounts: [], connectorProviders: { google: Boolean(connectorService.client("GOOGLE")),
          microsoft: Boolean(connectorService.client("MICROSOFT")) } } : {})),
        browserSessionsEnabled: config.browserSessionsEnabled && config.browserToolBridgeEnabled,
        browserPaneIds: sessions.map((session) => session.paneId),
        mcpTools: tools.map((tool) => {
          const server = serverById.get(tool.serverId);
          return { toolId: tool.id, serverName: server?.displayName ?? tool.serverId, name: tool.name,
            available: config.mcpToolBridgeEnabled && tool.status === "VERIFIED" && server?.status === "VERIFIED",
            approvalRequired: tool.approvalRequired,
            statusReason: config.mcpToolBridgeEnabled ? tool.statusReason : "The Space MCP tool bridge is disabled." };
        }),
        installedMcpServers: (registry.servers ?? []).flatMap((server) =>
          typeof server.id === "string" && typeof server.description === "string" ? [{ serverId: server.id, description: server.description }] : [])
      };
    },
    executeMcp: async (input, request) => {
      if (!config.mcpToolBridgeEnabled) return { status: "BLOCKED", message: "The Space MCP tool bridge is disabled.", artifactLocalPath: null };
      const result = await executeMcpToolWithPolicy(input, request);
      const localPath = result.artifact?.metadata && typeof (result.artifact.metadata as Record<string, unknown>).localPath === "string"
        ? (result.artifact.metadata as Record<string, string>).localPath : null;
      return { status: result.status, message: result.message, artifactLocalPath: localPath ?? null };
    },
    readMcpResult: async (localPath) => {
      const path = resolve(localPath);
      if (!path.startsWith(`${mcpResultRoot}/`)) return { message: "The MCP result is stored as a Space artifact." };
      const text = await readFile(path, "utf8");
      return (JSON.parse(text) as { result?: unknown }).result ?? null;
    },
    executeBrowser: async (input, request) => {
      if (!config.browserSessionsEnabled || !config.browserToolBridgeEnabled) throw new SpaceFeatureDisabledError("BROWSER_TOOL_BRIDGE_DISABLED", "Managed browser tools are disabled.");
      const browserPane = await getPaneById(store, input.targetPaneId);
      assertBrowserPaneCompatible(browserPane);
      if (browserPane.roomId !== input.roomId) throw new SpaceNotFoundError(`Browser pane ${browserPane.id} was not found in room ${input.roomId}.`);
      await assertVaultBrowserActionAllowed(vault.protection, browserPane.id, input.action.type);
      const actionResult = await browserSessionManager.action(browserPane, input.action, request.requestIdForSpace,
        { holderType: "AGENT", holderId: input.agentSessionId });
      await recordAudit(store, request, { action: "pane.browser.agent_action.executed", targetType: "pane", targetId: browserPane.id,
        metadata: { roomId: input.roomId, agentSessionId: input.agentSessionId, sessionId: actionResult.session.sessionId, actionType: input.action.type, via: "dot-gateway" } });
      return { sessionId: actionResult.session.sessionId, paneId: actionResult.session.paneId, actionType: input.action.type,
        viewport: actionResult.session.viewport, currentUrl: safeBrowserObservationUrl(actionResult.session.currentUrl),
        title: actionResult.session.title ? redactMemoryText(actionResult.session.title).slice(0, 500) : null,
        text: safeBrowserObservationText(actionResult.text), capturedAt: actionResult.frame?.capturedAt ?? actionResult.session.lastFrameAt };
    },
    goalTool: dotGoalService ? (sessionId, toolId, args) => dotGoalService.tool(sessionId, toolId, args) : undefined,
    computerBrowser: dotComputerService ? (session, owner, args) => dotComputerService.browser(session, owner, args) : undefined,
    delegate: dotDelegationService ? (session, owner, args) => dotDelegationService.delegate(session, owner, args) : undefined, designRequest: designService && dotDesignRequest(designService), videoRequest: videoService && dotVideoRequest(videoService),
    memoryTool: dotMemoryService ? (session, owner, toolId, args) => dotMemoryService.tool(session, owner, toolId, args) : undefined,
    memoryScope: dotMemoryService ? (owner, dotId, memoryId) => dotMemoryService.scope(owner, dotId, memoryId) : undefined,
    publishDeliverable: dotDeliverablesService ? (owner, dotId, input) => dotDeliverablesService.publish(owner, dotId,
      { path: input.path, roomId: input.roomId }, "DOT", null, input.expectedSha256) : undefined,
    deliverableFingerprint: dotDeliverablesService ? (owner, dotId, path) => dotDeliverablesService.fingerprint(owner, dotId, path) : undefined,
    connectorTool: connectorService ? (owner, toolId, args) => connectorService.tool(owner, toolId, args) : undefined,
    confirmExternalActions: async (owner) => dotHomeRepository ? (await dotHomeRepository.settings(owner)).confirmExternalActions : true,
    scheduleTool: dotScheduleService ? (session, owner, args) => dotScheduleService.tool(session, owner, args) : undefined,
    decideSchedule: dotScheduleService ? async (owner, dotId, scheduleId, decision) => {
      const schedule = await dotScheduleService.control(owner, dotId, scheduleId, { action: decision === "APPROVE" ? "CONFIRM" : "CANCEL" });
      return { status: schedule.status, nextRunAt: schedule.nextRunAt };
    } : undefined,
    evaluationSession: dotEvalsRepository ? (sessionId) => dotEvalsRepository.isRunningSession(sessionId) : undefined,
    channelTool: dotChannelService ? async (session, owner, toolId, args) => {
      try { return await dotChannelService.toolSend(session, owner, toolId, args); }
      catch (error) { return { status: "BLOCKED" as const, statusReason: `Sending failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` }; }
    } : undefined,
    continueAfterApproval: async ({ sessionId, paneId, ownerUserId, content, requestKey }) => {
      const pane = await getPaneById(store, paneId);
      const active = await store.getActiveSpaceAgentSession(pane.id);
      if (active?.sessionId !== sessionId) return false;
      await spaceAgentAdapter.sendMessage({ pane, sessionId, content, operatorUserId: ownerUserId, clientRequestId: requestKey,
        traceId: makeSpaceId("trace") });
      return true;
    },
    audit: (request, action, roomId, metadata) => recordAudit(store, request, { action, targetType: "room", targetId: roomId, metadata })
  } : null, {
    routeOptions: defaultRouteRateLimitOptions,
    authenticatedOwner: async request => {
      if (!request.user || !verifySession(request.cookies[cookieName], auth.sessionSecret)) {
        throw new GitControlError("UNAUTHENTICATED", "Sign in to use Dots.", 401);
      }
      return (await store.upsertUser(request.user)).id;
    }
  });
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
  nousRef.current = registerNous(app, { config, vault, browser: browserSessionManager, ...(options.telegramIntegrationManager ? {} : { telegram: { persistence: telegramPersistence, secrets: telegramSecrets } }), autonomous: config.instanceJobs.nous, planControllerRunning: config.instanceJobs["managed-plan-controller"], auth, store, parseBody, parseQuery, routeOptions: defaultRouteRateLimitOptions, readActivity: readDashboardAgents, railCli, youtubePlayback: (paneId) => youtubePlaybackStore.getByPaneId(paneId),
    roomTools: roomAgentTools, inspectPane: (pane) => roomPaneController.inspect(pane, { fresh: true }), releaseTrain: roomCoordination.releaseTrain, notifications: notificationService, runner: options.nousRunner, vaultBrokerReinstall: options.vaultBrokerReinstall, monitorEvents: roomAgentMonitorRepository,
    answerCli: (pane, input, traceId) => commandRoomCli(pane, { type: "cli_command", paneId: pane.id, expectedSessionId: input.sessionId, answer: input.answer, submit: true, ...(input.fingerprint ? { expectedPromptFingerprint: input.fingerprint } : {}), when: "NOW" }, traceId), pressKeys: (sessionId, keys, traceId) => cliTerminalManager.runSerializedTerminalMutation(sessionId, () => cliTerminalManager.sendInput(sessionId, keys, traceId, null, `${traceId}:keys:${randomUUID()}`)), activeSessionPids: (sessions) => cliTerminalManager.activeSessionPids(sessions), ops: { health: healthMonitor, services: systemServicesProvider, tokenUsage: (range) => systemAnalyticsService.models(range, "all"), gateway: () => gatewayAdminService!.status(), ...(gatewayAdminService ? { gatewayAdmin: gatewayAdminService } : {}) },
    copilots: { mail: mailCopilotService, marketing: marketingCopilotService, freelance: freelanceCopilotService, job: jobApplyService, design: designService, appStudio: appStudioService, video: videoService, security: securityCopilotService, monitoring: monitoringCopilotService }, invoke: controlInvoke, eventBus, health: healthMonitor, controlRepository, sessionPids: (sessions) => cliTerminalManager.activeSessionPids(sessions), apiBaseUrl: cliAgentFilesApiBaseUrl(config), claudeUsageProvider, paneBoardJob: config.instanceJobs["nous-pane-board"], paneBoardRunner: options.paneBoardRunner, council: councilService, liveHistory });

  registerVoiceAttachmentRoutes(app, { config, store, routeOptions: defaultRouteRateLimitOptions });

  registerTurnRoutes(app, {
    config, store, eventBus, turnStarter, codexTurnStarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerEventRoutes(app, { store, eventBus, routeOptions: defaultRouteRateLimitOptions, roomShares });

  async function readToolbarProviderTargets() {
    const [providers, settings] = await Promise.all([store.listProviders(), store.getProviderSettings()]);
    const data = providers.map((provider) => {
      const route = providerRouteResponse(provider);
      const backingProviderId = provider.backingProviderId ?? (provider.type === "CODEX_LB" || provider.type === "SPACE_GATEWAY" ? "codex-lb" : provider.id);
      const supported = backingProviderId === "codex-lb" && route.routeMode !== null;
      const health = provider.status === "VERIFIED" ? "HEALTHY" : provider.status === "ERROR" ? "UNAVAILABLE" : "UNKNOWN";
      // Codex runs through Space Gateway; the codex-lb route these providers named is retired.
      const canSwitch = false;
      const reason = supported ? "Codex runs through Space Gateway." : "Provider does not expose a supported Space Gateway route.";
      return {
        providerId: provider.id,
        displayName: provider.displayName,
        isCurrent: provider.id === settings.defaultProviderId,
        canSwitch,
        health,
        reason
      };
    }).sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent) || left.displayName.localeCompare(right.displayName));
    return providerSwitchTargetsSchema.parse({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 },
      checkedAt: nowIso()
    });
  }
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
  let toolbarCleanupInFlight = false;
  async function performToolbarCliReap() {
    const before = cliSessionStatsSchema.parse(await toolbarCliSessionStatsProvider());
    const reaped = await toolbarCliSessionReaper();
    const killedSessionIds = [...new Set(reaped.killedSessions.map((session) => session.cliSessionId))].slice(0, 500);
    const killed = new Set(killedSessionIds);
    const estimatedReclaimedBytes = before.sessions.reduce(
      (total, session) => total + (killed.has(session.sessionId) ? session.rssBytes : 0),
      0
    );
    invalidateToolbarProvider(toolbarCliSessionStatsProvider);
    invalidateToolbarProvider(toolbarHostMemoryProvider);
    return cliSessionReapResponseSchema.parse({
      status: reaped.failedHostCount > 0 ? "PARTIAL" : killedSessionIds.length > 0 ? "COMPLETED" : "NOOP",
      killedSessionIds,
      skippedCount: Math.max(Math.trunc(reaped.skippedCount), 0),
      estimatedReclaimedBytes,
      completedAt: nowIso()
    });
  }
  /**
   * Memory reclaim stops a detached CLI only when its pane is closed or gone.
   * A pane that is still open (another room, minimized, browser closed) keeps
   * its agent running; an uncertain pane lookup also protects the session.
   */
  async function performClosedPaneCliReap() {
    const before = cliSessionStatsSchema.parse(await toolbarCliSessionStatsProvider());
    const killedSessionIds: string[] = [];
    let protectedSessionCount = 0;
    let failedCount = 0;
    let estimatedReclaimedBytes = 0;
    for (const session of before.sessions.filter((candidate) => candidate.cleanupEligible)) {
      let paneOpen = true;
      try {
        paneOpen = !(await store.getPane(session.paneId)).isClosed;
      } catch (error) {
        paneOpen = !(error instanceof SpaceNotFoundError);
      }
      if (paneOpen) {
        protectedSessionCount += 1;
        continue;
      }
      try {
        if (await toolbarCliSessionTerminator(session.sessionId)) {
          killedSessionIds.push(session.sessionId);
          estimatedReclaimedBytes += session.rssBytes;
        }
      } catch {
        failedCount += 1;
      }
    }
    invalidateToolbarProvider(toolbarCliSessionStatsProvider);
    invalidateToolbarProvider(toolbarHostMemoryProvider);
    return {
      status: failedCount > 0 ? "PARTIAL" as const : killedSessionIds.length > 0 ? "COMPLETED" as const : "NOOP" as const,
      killedSessionIds: killedSessionIds.slice(0, 500),
      protectedSessionCount,
      estimatedReclaimedBytes
    };
  }
  app.post(
    "/api/admin/cli-session-reaps",
    { config: { rateLimit: { max: 4, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI session cleanup requires the ADMIN role.");
      }
      parseBody(emptyToolbarActionSchema, request.body ?? {});
      if (toolbarCleanupInFlight) throw new SpaceConflictError("A toolbar cleanup action is already running.");
      toolbarCleanupInFlight = true;
      try {
        const result = await performToolbarCliReap();
        await recordAudit(store, request, {
          action: "admin.cli_sessions.reaped",
          targetType: "cli_sessions",
          targetId: "space-managed",
          metadata: {
            status: result.status,
            killedCount: result.killedSessionIds.length,
            skippedCount: result.skippedCount,
            estimatedReclaimedBytes: result.estimatedReclaimedBytes
          }
        });
        return result;
      } finally {
        toolbarCleanupInFlight = false;
      }
    }
  );
  app.post(
    "/api/admin/memory-reclaims",
    { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Memory cleanup requires the ADMIN role.");
      }
      parseBody(emptyToolbarActionSchema, request.body ?? {});
      if (toolbarCleanupInFlight) throw new SpaceConflictError("A toolbar cleanup action is already running.");
      toolbarCleanupInFlight = true;
      try {
        const before = hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider());
        const cli = await performClosedPaneCliReap();
        const kernelCache: KernelCacheReclaimResult = !before.pressure.isUnderPressure
          ? { status: "SKIPPED_LOW_PRESSURE", reclaimedBytes: 0, message: null }
          : !before.pressure.canDropPageCache || before.memory.reclaimableBytes < minimumKernelCacheReclaimBytes
            ? { status: "SKIPPED_SMALL_CACHE", reclaimedBytes: 0, message: null }
            : await toolbarKernelCacheReclaimer();
        invalidateToolbarProvider(toolbarHostMemoryProvider);
        let after = before;
        let afterCollectionFailed = false;
        try {
          after = hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider());
        } catch {
          afterCollectionFailed = true;
        }
        const didWork = cli.killedSessionIds.length > 0 || kernelCache.status === "CLEARED";
        const status: MemoryReclaimResponse["status"] =
          cli.status === "PARTIAL" || kernelCache.status === "FAILED" || afterCollectionFailed
            ? "PARTIAL"
            : didWork
              ? "COMPLETED"
              : "NOOP";
        const result = memoryReclaimResponseSchema.parse({
          status,
          cli: {
            killedSessionIds: cli.killedSessionIds,
            estimatedReclaimedBytes: cli.estimatedReclaimedBytes,
            protectedSessionCount: cli.protectedSessionCount
          },
          kernelCache,
          before: before.memory,
          after: after.memory,
          completedAt: nowIso()
        });
        await recordAudit(store, request, {
          action: "admin.memory.reclaimed",
          targetType: "host_memory",
          targetId: "vm207",
          metadata: {
            status: result.status,
            killedCliCount: result.cli.killedSessionIds.length,
            protectedCliCount: cli.protectedSessionCount,
            estimatedCliReclaimedBytes: result.cli.estimatedReclaimedBytes,
            kernelCacheStatus: result.kernelCache.status,
            kernelCacheReclaimedBytes: result.kernelCache.reclaimedBytes
          }
        });
        return result;
      } finally {
        toolbarCleanupInFlight = false;
      }
    }
  );
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
  const maintenanceAutopilotTesting = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const recordAutopilotAudit = async (actorId: string, action: string, targetId: string, metadata: Record<string, unknown>) => {
    try {
      await store.recordAuditEvent({
        actorUserId: actorId,
        traceId: `maintenance_autopilot:${randomUUID()}`,
        action,
        targetType: "maintenance_autopilot",
        targetId,
        metadata: { ...metadata, source: "maintenance_autopilot" }
      });
    } catch (error) {
      app.log.warn({ err: error, action }, "Maintenance autopilot audit event could not be recorded");
    }
  };
  const maintenanceAutopilot = options.maintenanceAutopilot ?? new MaintenanceAutopilot({
    stateFile: maintenanceAutopilotTesting ? null : config.maintenanceAutopilotStateFile,
    steps: {
      cleanup: createStorageCleanupStep({
        anyCliEnabled: async () => (await cliRuntimeVisibility.enabledRuntimeIds()).length > 0,
        withExclusive: (operation) => codexHistoryAccessCoordinator.withExclusivePurge(operation),
        protectedThreadIds: () => Promise.resolve(store.listActiveManagedCodexThreadIds()),
        codexEnabled: () => cliRuntimeVisibility.isEnabled("cli:codex"),
        service: cliSessionCleanupService,
        audit: (result, actorId) => recordAutopilotAudit(actorId, "admin.cli_sessions.cleaned", result.previewId, {
          status: result.status,
          cleaned: result.cleaned,
          totalBytes: result.totalBytes,
          failures: result.failures
        })
      }),
      memory: createMemoryReliefStep({
        acquire: () => {
          if (toolbarCleanupInFlight) return false;
          toolbarCleanupInFlight = true;
          return true;
        },
        release: () => { toolbarCleanupInFlight = false; },
        readMemory: async () => hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider()),
        stopClosedPaneClis: () => performClosedPaneCliReap(),
        reclaimPageCache: async () => {
          try {
            return await toolbarKernelCacheReclaimer();
          } finally {
            invalidateToolbarProvider(toolbarHostMemoryProvider);
          }
        },
        minimumReclaimBytes: minimumKernelCacheReclaimBytes,
        audit: (result, actorId) => recordAutopilotAudit(actorId, "admin.memory.reclaimed", "vm207", {
          status: result.status,
          killedCliCount: result.stoppedCliCount,
          kernelCacheStatus: result.status,
          kernelCacheReclaimedBytes: result.reclaimedBytes
        })
      }),
      ...createCliMaintenanceAutopilotSteps({
        manager: cliMaintenanceManager,
        updateAll: cliUpdateAllRunner,
        listCliRuntimeSettings: async () => store.listCliRuntimeSettings(),
        onUpdateAll: (result, actorId) => recordAutopilotAudit(actorId, "cli_maintenance.update_all_completed", `autopilot:${Date.now().toString(36)}`, {
          mode: result.mode,
          overallStatus: result.overallStatus,
          runtimeCount: result.runtimes.length,
          scope: result.scope,
          reinstall: result.reinstall
        })
      })
    },
    onRunFinished: (run, actorId) => recordAutopilotAudit(actorId, "admin.maintenance_autopilot.finished", run.id, {
      trigger: run.trigger,
      status: run.status,
      steps: run.steps.map((step) => ({ id: step.id, status: step.status }))
    }),
    onError: (error, message) => app.log.warn({ err: error }, message)
  });
  if (!options.maintenanceAutopilot && !maintenanceAutopilotTesting && config.instanceJobs["maintenance-autopilot"]) maintenanceAutopilot.startScheduler();
  app.addHook("onClose", () => maintenanceAutopilot.stop());
  registerMaintenanceAutopilotRoutes(app, {
    autopilot: maintenanceAutopilot,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerCliAuthHandoffRoutes(app, {
    options, store, activityLogService, cliMaintenanceManager, eventBus, openCliLogin
  });
  app.post(
    "/api/admin/panes/prune",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Pane pruning requires the ADMIN role.");
      }
      const body = (request.body as { olderThanHours?: number; roomId?: string; batchSize?: number } | undefined) ?? {};
      const olderThanHours = typeof body.olderThanHours === "number" ? Math.max(0, body.olderThanHours) : 24;
      const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : undefined;
      const batchSize = typeof body.batchSize === "number" ? Math.max(1, Math.min(body.batchSize, 5000)) : undefined;
      const pruneFn = (store as {
        pruneClosedPanes?: (opts?: { olderThanHours?: number; roomId?: string; batchSize?: number }) => Promise<{ deletedPanes: number }>;
      }).pruneClosedPanes;
      if (typeof pruneFn !== "function") {
        return reply.send({ deletedPanes: 0, olderThanHours, roomId });
      }
      const result = await pruneFn.call(store, { olderThanHours, roomId, batchSize });
      await recordAudit(store, request, {
        action: "pane.prune",
        targetType: "panes",
        targetId: roomId ?? "global",
        metadata: { olderThanHours, roomId, deletedPanes: result.deletedPanes }
      });
      return reply.send({ ...result, olderThanHours, roomId });
    }
  );
  registerReleaseRoutes(app, { store, releasePublishingManager });
  registerSourceControlConnectionRoutes(app, { store, sourceControlPublishingManager });
  registerSettingsRoutes(app, { store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions });

  registerConfigurationRoutes(app, { store, config, runtimes: cliRuntimeRegistryCache, credentialHost: publicCredentialHost,
    routeOptions: defaultRouteRateLimitOptions, recordAudit: (request, input) => recordAudit(store, request, input) });

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
  registerSwarmRoutes(app, {
    store, eventBus, config, workerReadinessChecker, spaceAgentAdapter,
    routeOptions: defaultRouteRateLimitOptions,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerAdminIntegrationRoutes(app, {
    config, store, spaceCapabilityInventoryCollector, routeOptions: defaultRouteRateLimitOptions
  });
  registerMemoryGraphRoutes(app, {
    config,
    service: memoryGraphService,
    store,
    consolidationCoordinator: memoryConsolidationCoordinator,
    mutationCoordinator: memoryMutationCoordinator,
    recordAudit: (request, input) => recordAudit(store, request, input)
  });
  registerAdminOperationsRoutes(app, {
    apiStartedAt, config, auth, store, observability, workerReadinessChecker, storageReadinessChecker,
    cliRuntimeVisibility, healthMonitor, systemTopologyService, serviceRestarter, serviceRestartCooldownPath,
    routeOptions: defaultRouteRateLimitOptions
  });

  return app;
}
