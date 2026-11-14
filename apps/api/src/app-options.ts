// The options createApp takes, kept out of the composition root app.ts (EXT-G-4, composition-root budget).
import type { registerSignInRoutes } from "./user-routes-wiring.js";
import type {
  ChannelsRepository,
  DotEvalsRepository,
  AutoRouteShadowRepository,
  RoomAgentMonitorRepository,
  SpaceNotificationsRepository,
  MailCopilotRepository
} from "@space/db";
import type { FcmSender } from "./notifications/fcm.js";
import type { NousRunner } from "./nous/service.js";
import type { PaneSummaryRunner } from "./nous/pane-board.js";
import type { MailboxFactory } from "./job-apply/mailbox.js";
import type { JobApplyGoogleAccess, JobApplyService } from "./job-apply/service.js";
import type { MailCopilotGoogleAccess } from "./mail-copilot/service.js";
import type { MarketingCopilotWiring } from "./marketing-copilot/wiring.js";
import type { FreelanceCopilotWiring } from "./freelance-copilot/wiring.js";
import type { DesignWiring } from "./design/wiring.js";
import type { VideoWiring } from "./video/wiring.js";
import type { AppStudioWiring } from "./app-studio/wiring.js";
import type { SecurityCopilotWiring } from "./security-copilot/wiring.js";
import type { MonitoringCopilotWiring } from "./monitoring-copilot/wiring.js";
import type { GatewayAdminService } from "./gateway/gateway-service.js";
import type { ReleasesOptions } from "./instance-releases.js";
import type { findCodexWriterThreads } from "./codex-thread-writer.js";
import type { CliAccountProfileCommandOptions } from "./cli-account-profile-commands.js";
import type { CliAccountBalancer } from "./cli-account-balancer.js";
import type { SourceControlService } from "./source-control/service.js";
import type { VaultOverrides } from "./vault/wiring.js";
import type { SystemHealthMonitor } from "./system-health-service.js";
import type { SystemTopologyService } from "./system-topology-service.js";
import type { MemoryEmbeddingBackfill } from "./memory-embedding-backfill.js";
import type { CodexAppServerSocketControlService } from "@space/codex-app-server";
import type {
  CliToggleRuntimeId,
  ApiProviderAccountList,
  AgentRuntime,
  CliSessionStats,
  CodexLbSpeedDefaultsResponse,
  CodexLbSpeedTier,
  AntigravityUsageAccountList,
  ClaudeUsageAccountList,
  CodexUsageAccountList,
  StorageReadiness,
  HostMemoryDetails,
  PaneCliSession,
  Pane,
  JobApplyRun,
  MailCopilotRun
} from "@space/contracts";
import type { SpaceEventBus, TelegramIntegrationManager, CanonicalMemoryBridge, CodexGoalsAdapter, SpaceStore } from "@space/runtime";
import type { AuthConfig } from "./auth.js";
import type { AppDiagnosticsService } from "./app-diagnostics.js";
import type { ActivityLogService } from "./activity-log.js";
import type { T3CodeServiceController } from "./t3code/service-control.js";
import type { AgentFileDocxNormalizer } from "./cli-agent-files.js";
import type { BrowserEvidenceCaptureHandler } from "./browser-evidence.js";
import type { BrowserSessionManager } from "./browser-sessions.js";
import type { CodexResetCreditsService } from "./codex-reset-credits.js";
import type { CodexParityService } from "./codex-parity.js";
import type { RuntimeProcessSweepResult } from "./cli-runtime-process-sweeper.js";
import type { CliVpnBroker } from "./cli-vpn.js";
import type { CodexLbSpeedModelId } from "./codex-lb-speed-defaults.js";
import type { CodexCliModeDefaultsService } from "./codex-cli-mode-defaults.js";
import type { CodexHistoryAccessCoordinator, CodexHistoryPurgeService } from "./codex-history-purge.js";
import type { CliSessionCleanupService } from "./cli-session-cleanup.js";
import type {
  CliHostGateway,
  CliHostReapAggregate,
  CodexCliCurrentTurnActivityFinder,
  CodexCliTurnActivityFinder,
  CodexThreadFinder,
  CodexThreadResumeSettingsFinder
} from "./cli-terminal.js";
import type { CliMaintenanceManager, CliUpdateAllRunner } from "./cli-maintenance.js";
import type { MaintenanceAutopilot } from "./maintenance-autopilot.js";
import type { AgentToolsOptions } from "./agent-tools.js";
import type { SpaceApiConfig } from "./config.js";
import type { OwnerSetupBootstrap } from "./owner-setup.js";
import type { SetupConnectionsService } from "./setup-connections.js";
import type { SetupConnectionCheckRunManager } from "./setup-connection-check-runs.js";
import type { HostStatsProvider } from "./host-stats.js";
import type { SystemServicesRunner } from "./service-services.js";
import type { InvalidatableProvider, KernelCacheReclaimResult } from "./toolbar-system-services.js";
import type { ToolbarModelStatsCollector } from "./toolbar-model-stats.js";
import type { SystemAnalyticsService } from "./system-analytics-service.js";
import type { OpencodeModelBenchService } from "./opencode-model-bench.js";
import type { StreamingService } from "./streaming-service.js";
import type { StreamingBotService } from "./streaming-bot-service.js";
import type { CoreServiceRestarter, DeepSeekHarnessServiceController } from "./service-restarts.js";
import type { SourceControlPublishingManager } from "./source-control-publishing.js";
import type { ReleasePublishingManager } from "./release-publishing.js";
import type { MemoryGraphApiService } from "./memory-graph-service.js";
import type { MemoryConsolidationCoordinator } from "./memory-consolidation-coordinator.js";
import type { MemoryMutationCoordinator } from "./memory-mutation-coordinator.js";
import type { SpaceMemorySearcher } from "./memory-search.js";
import type { SpaceCapabilityInventoryCollector } from "./space-capability-inventory.js";
import type { SpaceAgentAdapter, SpaceAgentControl } from "./space-agent.js";
import type { RoomAgentWorkflowCoordinator } from "./room-agent.js";
import type { RoomAgentChatModel } from "./room-agent-chat.js";
import type { RoomActionExecutor } from "./room-actions.js";
import type { RoomPlanInventoryProvider } from "./room-plan-inventory.js";
import type { RoomTaskEvaluator } from "./room-task-evaluator.js";
import type { TurnStarter } from "./turns.js";
import type { WorkerReadinessChecker } from "./worker-readiness.js";
import type { DecisionsService } from "./decisions-service.js";
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
