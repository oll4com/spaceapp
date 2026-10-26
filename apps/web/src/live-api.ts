import type { ManagedPlanExecution, StartPlanExecutionRequest, PlanExecutionControlRequest, PlanStageOverrideRequest } from "@space/contracts";
import type { AppDeviceSession } from "@space/contracts";
import type { ClientErrorReport } from "./client-error-reporter.js";
import type { LiveHistorySnapshot, PersistedLiveTurn } from "./features/live-pane/live-history-sync.js";
import type { SetupVoiceProvider } from "./features/setup-connections/SetupVoiceConnection.js";
import type { SetupDraft, SetupPlan, SetupRun, SetupTask, SetupReadinessReceipt, SetupExecutionEvent, SetupFeature, SetupFeatureId, SetupAvailability } from "@space/contracts";
import type { LiveRoomContext } from "@space/contracts";
import type { DesignAsset, DesignBrandKit, DesignBrandKitInput, DesignEvent, DesignFormat, DesignNetwork, DesignPaneMetadata, DesignRequest, DesignRequestCreate, DesignTemplateId, DesignView } from "@space/contracts";
import type { AppStudioEvent, AppStudioPaneMetadata, AppStudioPreview, AppStudioRunStatus } from "@space/contracts";
import type { SecurityCopilotPaneMetadata, SecurityEvent, SecurityMemory } from "@space/contracts";
import type { SecurityCopilotState, SecurityFindingView, SecurityRunView } from "./features/security-copilot-pane/types.js";
import type { VideoAsset, VideoAssetKind, VideoEvent, VideoJob, VideoPaneMetadata, VideoRequest, VideoRequestCreateInput, VideoRequestStatus, VideoView } from "@space/contracts";
import type { SetupClientRuntimeFeatureId, SetupClientRuntimeChallenge, SetupClientRuntimeObservation } from "@space/contracts";
import type { MaintenancePlanRequest, MaintenanceApplyRequest, MaintenanceAutopilotStatus, MaintenanceAutopilotScheduleUpdate } from "@space/contracts";
import { singleFlightRequest } from "./single-flight-request.js";
import type { TaskTitleSettings, TaskTitleCandidateStatus } from "@space/contracts";
import type { VaultHandoffKey, VaultPendingSecret, VaultSignupGrant, VaultSignupGrantRequest, VaultAuditRecord, VaultItemMetadata, VaultItemRecord, VaultItemRecordInput, VaultKdfParams, VaultRecovery, VaultSymmetricEnvelope, VaultTransportEnvelope } from "@space/contracts";
import type {
  DemoAccountsResponse,
  DemoConnection,
  DemoConnectionProvider,
  DemoOperation,
  DemoOperationListResponse,
  DemoRun,
  DemoSelection,
  DemoSelectionInput,
  DemoSheetsTarget,
  DemoStartRunInput,
  DemoStateResponse,
  DemoTestRun,
  DemoTestRunListResponse,
  DemoVariantFileContent,
  DemoVariantFilesResponse,
  DemoLogsResponse,
  CliProviderSettingsResponse,
  T3CodeAdminResult,
  T3CodeBindingUpdate,
  T3CodePaneMetadata,
  T3CodeServiceStatus,
  RestartT3CodeInput,
  UpdateT3CodeEnabledInput
} from "@space/contracts";
import type { SystemHealthSnapshot, SystemHealthHistory, SystemHealthRange, SystemTopologySnapshot, SpaceConfigBundle, ImportConfigResult, ImportConfigMode } from "@space/contracts";
import type {
  DatabaseCatalog,
  DatabaseConnection,
  DatabaseDiscoveryItem,
  DatabaseExecuteSqlRequest,
  DatabaseExecuteSqlResponse,
  DatabaseTableDataQuery,
  DatabaseTableDataResponse,
  CreateDatabaseConnectionInput,
  UpdateDatabaseConnectionInput
} from "@space/contracts";
import type { YouTubeAccounts, YouTubeAccountSelection } from "./features/browser-pane/youtube-accounts.js";
export interface GoogleAccountSummary {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  isPrimary: boolean;
  browserStatus: GoogleBrowserStatus;
  /** Why the browser state is what it is; only a Google check yields CONNECTED. */
  browserStatusReason?: string;
  browserCheckedAt?: string | null;
  browserConnectedAt?: string | null;
}
export type GoogleBrowserStatus = "NOT_CONNECTED" | "CONNECTED" | "REAUTHENTICATION_REQUIRED" | "UNKNOWN";
export interface GoogleBrowserCheckSummary {
  status: GoogleBrowserStatus;
  reason: string;
  checkedAt: string | null;
  connectedAt: string | null;
}
import type { YouTubePlayback } from "./features/browser-pane/youtube-playback.js";
import type {
  Artifact,
  AgentPaneHistoryItem,
  AgentPaneSession,
  ActivityLogEvent,
  ActivityLogSettings,
  AppDiagnosticsSegmentListQuery,
  AppDiagnosticsSegmentMetadata,
  AppDiagnosticsStatus,
  DeployQueueReport,
  ReleasesReport,
  ReleaseActionResponse,
  AppDiagnosticsVideoLease,
  CollaborationMode,
  AgentRuntimeRegistry,
  AdminOperationRun,
  AdminUserItem,
  AdminUserListResponse,
  UserInvite,
  UserInviteRole,
  RoomShare,
  RoomShareListResponse,
  RoomSharePermission,
  AuditEvent,
  AuthMe,
  AuthUser,
  BrowserEvidenceCapture,
  BrowserEvidenceViewport,
  BrowserBookmarkImportResponse,
  BrowserBookmarkListResponse,
  AcquireBrowserControlInput,
  BrowserCaptureJob,
  BrowserCaptureMetrics,
  BrowserCaptureJobResponse,
  BrowserCaptureSegmentListResponse,
  BrowserCaptureTimelineResponse,
  BrowserControlLease,
  BrowserControlLeaseActionInput,
  BrowserControlLeaseResponse,
  BrowserDiagnosticsResponse,
  BrowserFrame,
  BrowserFrameToken,
  BrowserRuntimeInput,
  BrowserHandoffRequestResponse,
  JobApplication,
  JobApplicationCreate,
  JobApplicationStatus,
  JobApplicationUpdate,
  JobApplicationField,
  JobApplyEvent,
  JobApplyMemory,
  JobApplyMemoryCreate,
  JobApplyMemoryQuery,
  JobApplyMemoryUpdate,
  JobApplyReviewDecision,
  JobApplyRunView,
  JobApplyDiscoverRequest,
  JobApplyDiscoverResult,
  JobApplyMailboxInput,
  JobApplyMailCheckResult,
  JobApplyPaneMetadata,
  MailAccountSummary,
  MailComposeInput,
  MailCopilotEvent,
  MailCopilotMemory,
  MailCopilotMemoryCreate,
  MailCopilotMemoryQuery,
  MailCopilotMemoryUpdate,
  MailCopilotPaneMetadata,
  MarketingBookmark,
  MarketingCopilotPaneMetadata,
  MarketingCampaign,
  MarketingEvent,
  MarketingMemory,
  MarketingMetric,
  MarketingPost,
  MarketingRule,
  MarketingRunView,
  FreelanceAccount,
  FreelanceAccountUpdate,
  FreelanceCopilotPaneMetadata,
  FreelanceEvent,
  FreelanceFunnel,
  FreelanceLead,
  FreelanceLeadDecision,
  FreelanceMemory,
  FreelanceMessage,
  FreelanceMessageReviewDecision,
  FreelanceRule,
  FreelanceRunView,
  MailCopilotReviewDecision,
  MailCopilotRunView,
  MailRule,
  MailHabitSender,
  MailActionLogEntry,
  MailCopilotFixRequest,
  MailFixRequestView,
  MailRuleDecision,
  MailRuleProposal,
  MailCopilotView,
  MailCopilotViewInput,
  MailLabel,
  MailThread,
  MailThreadAction,
  MailThreadsPage,
  JobApplyProfile,
  JobApplyResetResult,
  JobApplyStats,
  JobApplyProfileUpdate,
  BrowserPageListResponse,
  BrowserPageSummary,
  BrowserSessionViewport,
  BrowserStreamMode as ContractBrowserStreamMode,
  BrowserStreamTicketResponse,
  BrowserToolActionResult,
  Capability,
  ClipboardItem,
  ClipboardSource,
  SharedChatMessage,
  SendSharedChatMessageInput,
  CouncilModelsResponse,
  CouncilRun,
  CouncilRunSummary,
  CreateCouncilRunInput,
  NousDecision,
  NousDecisionAnswerInput,
  NousMessage,
  NousAttachment,
  NousOverview,
  NousPaneBoard,
  NousPaneBoardAnswerInput,
  NousPaneBoardAnswerResult,
  NousAway,
  NousAwayGrant,
  NousSettings,
  NousState,
  ListSharedChatMessagesQuery,
  AuditChainEntry,
  ListAuditChainQuery,
  AuditVerifyResponse,
  CreateClipboardItemRequest,
  UpdatePlanProgressRequest,
  CreateTaskItemRequest,
  CreateRoomPanesRequest,
  DeleteRoomAgentFilesResponse,
  DeleteRoomMediaResponse,
  CliSessionCleanupExecuteRequest,
  CliSessionCleanupPreviewResponse,
  CliSessionCleanupResponse,
  CliSessionReapResponse,
  CliLoginResponse,
  CliMaintenanceAuthHandoff,
  CliMaintenanceEvent,
  CliTerminalClientEventInput,
  CliTerminalClientEventResponse,
  CliRuntimeDisablePreview,
  CliVpnConnection,
  CliGlobalEgressStatus,
  CliEgressRouteId,
  CliVpnProfileId,
  CliVpnRoutingStatus,
  CliMaintenanceRequest,
  CliUpdateAllDetection,
  CliUpdateAllRequest,
  CliUpdateAllResult,
  CliRuntimeSettingsResponse,
  AgentToolsCatalogResponse,
  AgentToolAssignment,
  AgentToolLaunchTaskInput,
  AgentToolLaunchTaskResponse,
  ApplyAgentToolsInput,
  ApplyAgentToolsResult,
  UpdateAgentToolAssignmentInput,
  RestartCliRuntimeVpnSessionsResult,
  CliRuntimeRestartSessionsResult,
  CliRuntimeRestartAllResult,
  HarnessMaintenanceRestartResult,
  UpdateHarnessEnabledInput,
  UpdateHarnessEnabledResult,
  CreateCliAccountProfileInput,
  CreateCliAccountProfileResponse,
  CliAccountProfileDetailsResponse,
  CliAccountIdentitiesResponse,
  ListCliAccountProfilesResponse,
  RemoveCliAccountProfileResponse,
  UpdateCliAccountProfileInput,
  UpdateCliAccountProfileResponse,
  CliSessionStats,
  ToolbarModelStats,
  CliTaskHistoryResponse,
  CodexEnvironment,
  AgentSessionHistoryItem,
  AgentSessionHistoryResponse,
  SystemServicesResponse,
  SystemAnalyticsCliSessionsResponse,
  SystemAnalyticsInstallsResponse,
  SystemAnalyticsModelsResponse,
  SystemAnalyticsOverviewResponse,
  SystemAnalyticsProcessesResponse,
  SystemAnalyticsRange,
  SystemAnalyticsTokenRoute,
  SystemAnalyticsResourcesResponse,
  OpencodeBenchResponse,
  CodexHistoryPurgeExecuteRequest,
  CodexHistoryPurgePreviewResponse,
  CodexHistoryPurgeResponse,
  CodexResetCreditAvailability,
  CodexResetCreditRedemptionResponse,
  CodexLbSpeedDefaultsResponse,
  CodexLbSpeedTier,
  GatewayAccount,
  GatewayAccountList,
  GatewayApiKey,
  GatewayApiKeyCreateRequest,
  GatewayApiKeyCreatedResponse,
  GatewayApiKeyList,
  GatewayApiKeyUpdateRequest,
  GatewayRequestLogList,
  GatewayRequestLog,
  GatewayRequestLogFacets,
  GatewayRequestLogFilter,
  GatewayDashboard,
  GatewayDashboardRange,
  GatewayHealth,
  GatewayAccountDetail,
  GatewayAccountUpdateRequest,
  GatewayApiKeyDetail,
  GatewayHeadroomHistory,
  GatewayHeadroomLifetime,
  GatewayHeadroomSession,
  GatewayReport,
  GatewayCompressionStats,
  GatewaySettings,
  GatewaySettingsUpdateRequest,
  GatewayStatus,
  GatewayClaudeApiKeyUse,
  GatewayAnthropicAdminStatus,
  GatewayAnthropicBillingReport,
  CodexUsageAccountList,
  AntigravityUsageAccountList,
  ClaudeUsageAccountList,
  ApiProviderAccountList,
  CodexAppServerHandshakeCheck,
  CodexAppServerStatus,
  CodexAppServerTurnSmokeCheck,
  CodexHistoryResponse,
  CodexHistoryItem,
  CodexThreadResponse,
  CreateMemoryConsolidationInput,
  CreateReleasePreviewInput,
  CreateReleaseRequest,
  CreateMemoryChangeSetInput,
  CreateMemoryNodeChangeSetInput,
  CreateMemoryRollbackInput,
  Event,
  ImportCandidate,
  ImportCandidateDecisionResult,
  ImportSourceKind,
  ImportTargetKind,
  HostMemoryDetails,
  LaunchReadiness,
  McpDiscoverySmokeCheck,
  McpGatewayStatus,
  McpServer,
  McpTool,
  McpToolExecutionResult,
  MemoryEmbeddingSmokeCheck,
  MemoryEntry,
  MemoryChangeKind,
  MemoryChangeSet,
  MemoryChangeSetSummary,
  MemoryCalendarQuery,
  MemoryCalendarRecord,
  MemoryCalendarResponse,
  MemoryChangeStatus,
  MemoryConsolidationCommandResponse,
  MemoryConsolidationDetail,
  MemoryGraphIssue,
  MemoryGraphNode,
  MemoryGraphNodeDetail,
  MemoryGraphNodeType,
  MemoryGraphOverviewPayload,
  MemoryGraphPayload,
  MemoryIssueSeverity,
  MemoryIssueStatus,
  MemoryIssueType,
  PatchMemoryIssueInput,
  MemoryLifecycleStatus,
  MemoryReclaimResponse,
  MemorySearchMode,
  MemorySearchStatus,
  MemoryVectorReadiness,
  Model,
  MovePaneResult,
  ObservabilitySnapshot,
  Pane,
  PermissionMode,
  PaneBrowserSessionResponse,
  PaneCapabilityMatrix,
  PaneCliSessionResponse,
  PaneCliModelSettings,
  PaneCliModelSettingsStatus,
  PaneCliTurnActivityResponse,
  VncPresetListResponse,
  VncTarget,
  PaneCliUploadSource,
  PaneCliUploadResponse,
  PaneCliWebSocketToken,
  Provider,
  ProviderSettings,
  UserSettings,
  ProviderValidationResult,
  CreateProviderInput,
  CreateBrowserCaptureJobRequest,
  CreateBrowserPageInput,
  ResumePaneCliSessionResponse,
  ReleasePreview,
  Room,
  UpdatePaneCliModelSettingsResult,
  UpdateCliRuntimeSettingInput,
  UpdateCliRuntimeSettingResult,
  UpdateCliRuntimeVpnInput,
  UpdateCliRuntimeVpnResult,
  UpdateHarnessVpnResult,
  UpdateCliGlobalEgressResult,
  ReviewCheck,
  ReviewDecision,
  ReviewDiffSummary,
  ReviewRoomState,
  RoomCliActivityResponse,
  RoomPanesResult,
  RoomPaneLayoutResult,
  RoomAgentEvent,
  RoomAgentSession,
  Skill,
  SetupClaimInput,
  SetupClaimResponse,
  SetupConnection,
  SetupConnectionCheckReplay,
  SetupConnectionCheckRun,
  SetupOverview,
  SetupStarterRoomResponse,
  SetupStatus,
  StorageReadiness,
  StreamingCatalogResponse,
  StreamingDisconnectAuthorizationResponse,
  StreamingOAuthProvider,
  StreamingOAuthStartResponse,
  StreamingOverlaySettings,
  StreamingOverlaySnapshot,
  StreamingPlatformAccount,
  StreamingVerifyAccountResponse,
  StreamingBotActivity,
  StreamingBotReviewedMemory,
  StreamingModerationAction,
  CreateStreamingBotMemoryInput,
  UpdateStreamingBotMemoryInput,
  StreamingBotMcpExecuteResponse,
  StreamingBotSettings,
  StreamingBotStatus,
  StreamingBotTestInput,
  UpdateStreamingBotSettingsInput,
  SourceControlConnection,
  SourceControlProvider,
  SwarmLock,
  SwarmMessage,
  SwarmReconcile,
  SwarmReconcileDecision,
  SwarmState,
  SwarmTask,
  SwarmTaskRole,
  SwarmTaskStatus,
  TaskItem,
  TaskStatus,
  TaskSource,
  TelegramIntegrationStatus,
  TelegramPairingResponse,
  Turn,
  TurnRuntime,
  TurnStartResult,
  UpdateRoomInput,
  UpdatePaneLayoutInput,
  UpdateTelegramIntegrationInput,
  UserLink,
  UserLinkCategory,
  InspectUserLinkResponse,
  CreateUserLinkRequest,
  UpdateUserLinkRequest,
  UpdateProviderInput,
  UpdateProviderSettingsInput,
  UpdateUserSettingsInput,
  UpdateStreamingOverlaySettingsInput,
  VoiceRealtimeSessionRequest,
  VoiceRealtimeSessionResponse,
  VoiceRealtimeHistoryItem,
  VoiceTranscriptionSettings,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel,
  VoiceTranscriptionResponse,
  OpenAiModelsResponse,
  WorkerReadiness,
  FileListResponse,
  FileReadResponse,
  FileSearchResponse,
  FileDiskUsageResponse,
  DiskStats
} from "@space/contracts";
import { SpaceApiError } from "./runtime/SpaceRuntime.js";
import { reportCoreApiFailure, reportCoreApiSuccess } from "./core-api-state.js";
import { consumeAuthBootstrap } from "./auth-bootstrap-cache.js";
import { noteServerModules } from "./features/pane-visibility/server-modules.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "./cli-runtime-visibility-events.js";

import { gatewayLogFilterParams } from "./features/space-gateway/gateway-log-query.js";

export { SpaceApiError } from "./runtime/SpaceRuntime.js";

export type CodexThreadPresentation = "raw" | "chat";

export interface LivePersonalMemoryItem {
  id: string;
  key: string;
  value: string;
  category?: "core" | "profile" | "preference" | "fact" | "instruction" | "note";
  createdAt: string;
  updatedAt: string;
}

export interface CliMaintenanceReplayPayload {
  run: AdminOperationRun;
  events: CliMaintenanceEvent[];
  authHandoffs: CliMaintenanceAuthHandoff[];
}

export interface CliMaintenanceRecoveryPayload {
  status: "NOOP" | "OPENED" | "FAILED";
  room: Room | null;
  handoffs: CliMaintenanceAuthHandoff[];
  loginPanes: Array<{
    handoffId: string;
    runtimeId: string;
    paneId: string | null;
    status: "OPENED" | "FAILED";
    safeErrorCode: string | null;
  }>;
}

const cliTerminalBrowserClientIdStorageKey = "space.cliTerminal.browserClientId.v1";
const cliTerminalTabLineageIdStorageKey = "space.cliTerminal.tabLineageId.v1";
const cliTerminalControlLeaseHeaderName = "x-space-cli-control-lease-id";
const cliTerminalBrowserClientHeaderName = "x-space-cli-browser-client-id";
const cliTerminalTabLineageHeaderName = "x-space-cli-tab-lineage-id";
const cliTerminalPageClientHeaderName = "x-space-cli-page-client-id";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let volatileCliTerminalBrowserClientId: string | null = null;
let volatileCliTerminalTabLineageId: string | null = null;
let volatileCliTerminalPageClientId: string | null = null;
const cliTerminalControlLeaseByPane = new Map<string, string>();

function cliTerminalBrowserClientId(): string {
  try {
    const stored = window.localStorage.getItem(cliTerminalBrowserClientIdStorageKey);
    if (stored && uuidPattern.test(stored)) return stored;
    const created = window.crypto.randomUUID();
    window.localStorage.setItem(cliTerminalBrowserClientIdStorageKey, created);
    return created;
  } catch {
    volatileCliTerminalBrowserClientId ??= window.crypto.randomUUID();
    return volatileCliTerminalBrowserClientId;
  }
}

function cliTerminalTabLineageId(): string {
  try {
    const stored = window.sessionStorage.getItem(cliTerminalTabLineageIdStorageKey);
    if (stored && uuidPattern.test(stored)) return stored;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(cliTerminalTabLineageIdStorageKey, created);
    return created;
  } catch {
    volatileCliTerminalTabLineageId ??= window.crypto.randomUUID();
    return volatileCliTerminalTabLineageId;
  }
}

function cliTerminalPageClientId(): string {
  volatileCliTerminalPageClientId ??= window.crypto.randomUUID();
  return volatileCliTerminalPageClientId;
}

function cliTerminalControlHeaders(paneId: string): Record<string, string> | undefined {
  const leaseId = cliTerminalControlLeaseByPane.get(paneId);
  if (!leaseId) return undefined;
  return {
    [cliTerminalControlLeaseHeaderName]: leaseId,
    [cliTerminalBrowserClientHeaderName]: cliTerminalBrowserClientId(),
    [cliTerminalTabLineageHeaderName]: cliTerminalTabLineageId(),
    [cliTerminalPageClientHeaderName]: cliTerminalPageClientId()
  };
}

/** `GET /api/video/tools`: what `space-video-tools-setup.mjs --status` reports (ok, the missing tools, an error). */
export interface VideoToolsStatus { ok?: boolean; missing?: string[]; error?: string; [key: string]: unknown }
/** A CC BY track `POST .../video/music/search` found: the attribution line is what the licence asks for. */
export interface VideoMusicResult { title: string; artist: string | null; url: string; license: string | null; attribution: string }
/** A request with its result assets as the API views them (the asset ids, poster, size, description, credits). */
export interface VideoRequestView {
  request: VideoRequest;
  assets: Array<Pick<VideoAsset, "artifactId" | "thumbnailArtifactId" | "label" | "formatId" | "width" | "height" | "durationSec" | "mimeType" | "kind" | "description" | "madeBy" | "credits" | "parentAssetId" | "createdAt"> & { assetId: string; replacedBy: string | null }>;
}
interface Paginated<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

interface CsrfPayload {
  csrfToken: string;
  headerName: string;
}

export interface ReadyzPayload {
  ok: boolean;
  apiStartedAt?: string;
  dependencies: {
    store: string;
    runtimeStore: string;
    eventBus: string;
    temporal: string;
    worker: string;
    cliHost: string;
    cliAdminHost: string;
    browserHost: string;
    browserHostBuildCommit: string | null;
    browserHostCaptureMetrics: BrowserCaptureMetrics | null;
    codexTurns: string;
    codexLb: string;
  };
}

export interface HarnessHealth {
  ok: boolean;
  status: number;
  checkedAt: string;
  durationMs: number;
}

export interface AppVersionStatus {
  appRelease: string;
  currentCommit: string | null;
  shortCommit: string | null;
  currentBranch: string | null;
  dirty: boolean;
  athensTag: string | null;
  githubLatest: string | null;
  githubTagUrl: string | null;
  updateAvailable: boolean;
  behindCount: number;
  checkedAt: string | null;
  /** Present only on public installations (run-spaceapp). */
  updateCommand?: string | null;
}

export interface ServiceRestartResponse {
  status: "ACCEPTED";
  scope: "CORE";
  services: ["space-worker.service", "space-api.service", "space-web.service"];
  requestedAt: string;
  cooldownUntil: string;
  apiStartedAt: string;
}

export interface McpPayload {
  data: Capability[];
  gateway: McpGatewayStatus;
  servers: McpServer[];
  tools: McpTool[];
  /** CLI agents' MCP dispatcher backends, from the inventory job; null until it has run. */
  dispatcher?: { backendCount: number; staleIds: string[]; checkedAt: string | null } | null;
  pagination: Paginated<Capability>["pagination"];
}

export interface MemoryPayload extends Paginated<MemoryEntry> {
  search: MemorySearchStatus;
}

export interface MemoryGraphResponse {
  data: MemoryGraphPayload;
  pagination: Paginated<MemoryGraphNode>["pagination"];
}

export interface MemoryGraphOverviewResponse {
  data: MemoryGraphOverviewPayload;
}

export interface MemoryCalendarResponseEnvelope {
  data: MemoryCalendarResponse;
}

export type { MemoryCalendarQuery, MemoryCalendarRecord, MemoryCalendarResponse };

export interface MemoryGraphIssuesResponse extends Paginated<MemoryGraphIssue> {}

export interface MemoryChangeSetListResponse {
  data: MemoryChangeSetSummary[];
  pagination: { page: number; pageSize: number; hasNext: boolean };
  mutationsEnabled: boolean;
}

export type CreateMemoryChangeSetRequest = Omit<CreateMemoryChangeSetInput, "actorUserId">;
export type ReviewMemoryChangeSetRequest =
  | { status: "APPROVED" }
  | { status: "REJECTED"; statusReason: string };

export interface MemoryMutationCommandResponse {
  status: "SCHEDULED" | "ALREADY_SCHEDULED";
  workflowId: string;
  runId: string | null;
}

export interface BrowserStatusPayload {
  enabled: boolean;
  statusReason: string;
  defaultUrl: string;
  checkedAt: string;
}

export type BrowserStreamMode = ContractBrowserStreamMode;
export type BrowserPageSummaryPayload = BrowserPageSummary;
export type BrowserPageListPayload = BrowserPageListResponse;
export type BrowserControlLeasePayload = BrowserControlLease;
export type BrowserControlPayload = BrowserControlLeaseResponse;
export type BrowserCaptureJobPayload = BrowserCaptureJob;
export type BrowserCaptureSegmentListPayload = BrowserCaptureSegmentListResponse;
export type BrowserCaptureTimelinePayload = BrowserCaptureTimelineResponse;
export type BrowserDiagnosticsPayload = BrowserDiagnosticsResponse;

/** `GET /api/artifacts/:id/metadata`: `embedded` holds a PNG's text chunks, `design` its parsed `spaceapp:design` JSON. */
export interface ArtifactMetadataPayload {
  artifact: { id: string; filename: string; mimeType: string; byteSize: number; sha256: string; createdAt: string; roomId: string | null; metadata: Record<string, unknown> };
  image: { width: number; height: number } | null;
  embedded: Record<string, string>;
  design: Record<string, unknown> | null;
}

export interface BrowserRecordingManifestPayload {
  durationMs: number;
  intervalMs?: number;
  fps: number;
  frameCount: number;
  startedAt: string;
  finishedAt: string;
}

export interface ConfigurationInspectResult {
  valid: boolean;
  version: string;
  exportedAt: string;
  source: {
    instance: string;
    exportedBy: string;
    appVersion?: string;
  };
  summary: {
    roomsCount: number;
    panesCount: number;
    hasUserSettings: boolean;
    userLinksCount: number;
    clipboardItemsCount: number;
    taskItemsCount: number;
    cliRuntimeSettingsCount: number;
    hasCodexCliModeDefaults: boolean;
    providersCount: number;
    apiKeysCount?: number;
    credentialsCount?: number;
  };
  secrets: {
    encrypted: boolean;
    plaintextApiKeys: boolean;
    cliAuthRuntimes: string[];
  };
  /** What this host lacks for the backup (folders, CLIs, account profiles, provider endpoints). */
  warnings: string[];
  missingProjectRoots: string[];
  rooms: Array<{
    id: string;
    name: string;
    order: number;
    panesCount: number;
  }>;
}

export interface ConfigurationCliLogin {
  runtimeId: string;
  displayName: string;
  exportable: boolean;
  loggedIn: boolean;
  rotatesRefreshToken: boolean;
}

export type BrowserInputPayload = BrowserRuntimeInput;

export interface CliClipboardDebugReportInput {
  paneId: string;
  severity: "info" | "good" | "bad";
  title: string;
  detail: string;
  trace: Array<{
    severity: "info" | "good" | "bad";
    title: string;
    detail: string;
    at: string;
  }>;
  sessionId?: string | null;
  url?: string | null;
  userAgent?: string | null;
  activeElement?: string | null;
  documentHasFocus?: boolean;
  visibilityState?: string | null;
  clipboardApi?: {
    read: boolean;
    readText: boolean;
    write: boolean;
    writeText: boolean;
  };
}

let csrfToken: string | null = null;
let csrfHeaderName = "x-space-csrf-token";

export function eventStreamUrl(query?: { roomId?: string; replayLimit?: number }): string {
  const params = new URLSearchParams();
  if (query?.roomId) params.set("roomId", query.roomId);
  if (query?.replayLimit !== undefined) params.set("replayLimit", String(query.replayLimit));
  const suffix = params.toString();
  return `/api/events/stream${suffix ? `?${suffix}` : ""}`;
}

interface ApiErrorPayload {
  error: {
    code?: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

function isApiErrorPayload(payload: unknown): payload is ApiErrorPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
  );
}

function formatApiError(payload: unknown, fallback: string): string {
  if (!isApiErrorPayload(payload)) {
    return fallback;
  }
  return payload.error.code ? `${payload.error.code}: ${payload.error.message}` : payload.error.message;
}

function isUnsafeRequest(url: string, init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(method) &&
    url !== "/api/auth/login" &&
    url !== "/api/auth/google/credential" &&
    url !== "/api/setup/claim";
}

function isFormDataBody(body: BodyInit | null | undefined): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function looksLikeJsonPayload(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (typeof response.text !== "function") {
    if (typeof response.json === "function") {
      return response.json();
    }
    return null;
  }
  const raw = await response.text();
  if (!raw) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json") || looksLikeJsonPayload(raw)) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function formatHttpFailure(status: number, payload: unknown): string {
  if (isApiErrorPayload(payload)) {
    return formatApiError(payload, `Request failed: ${status}`);
  }
  if (status === 413) {
    return "UPLOAD_TOO_LARGE: Request exceeded the live proxy or API upload size limit.";
  }
  if (typeof payload === "object" && payload !== null) {
    if ("error" in payload && typeof (payload as { error: unknown }).error === "string") {
      return (payload as { error: string }).error;
    }
    if ("message" in payload && typeof (payload as { message: unknown }).message === "string") {
      return (payload as { message: string }).message;
    }
  }
  if (typeof payload === "string") {
    const compact = payload.replace(/\s+/g, " ").trim();
    if (compact.startsWith("<!doctype html") || compact.startsWith("<html")) {
      return `Request failed: ${status} (received HTML error page from the proxy or web server).`;
    }
    if (compact.length > 0) {
      return `Request failed: ${status} (${compact.slice(0, 180)})`;
    }
  }
  return `Request failed: ${status}`;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function upstreamTransportError(error: unknown): SpaceApiError | unknown {
  if (isAbortError(error)) return error;
  return new SpaceApiError("UPSTREAM_UNAVAILABLE: Space API request failed before a response.", {
    code: "UPSTREAM_UNAVAILABLE",
    status: 0
  });
}

async function fetchCsrfToken(): Promise<string> {
  const requestStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch("/api/auth/csrf", { credentials: "include" });
  } catch (error) {
    reportCoreApiFailure(requestStartedAt);
    throw upstreamTransportError(error);
  }
  const payload = await readResponsePayload(response);
  reportCoreApiResponse(response, payload, requestStartedAt);
  if (!response.ok) {
    throw new SpaceApiError(formatHttpFailure(response.status, payload), { status: response.status });
  }
  const parsed = payload as CsrfPayload;
  csrfHeaderName = parsed.headerName;
  csrfToken = parsed.csrfToken;
  return parsed.csrfToken;
}

function reportCoreApiResponse(response: Response, payload: unknown, requestStartedAt: number) {
  if (response.ok) {
    reportCoreApiSuccess();
    return;
  }
  if (response.status === 502 || (isApiErrorPayload(payload) && payload.error.code === "UPSTREAM_UNAVAILABLE")) {
    reportCoreApiFailure(requestStartedAt);
  }
}

/** Per item: when it was added and last changed, and how many successful fills used it. */
export interface VaultItemStats { addedAt: string; changedAt: string; uses: number; lastUsedAt: string | null }

export interface VaultStateResponse {
  ownerUserId: string;
  enrolled: boolean;
  brokerAvailable: boolean;
  /** The dock's switch: agents and Nous may use the Vault. */
  agentAccess: boolean;
  /** Items the current delegation hands to them. */
  delegatedItems: number;
  /** Logins waiting in the inbox until this dock is unlocked. */
  pendingItems?: number;
  vault: { vaultId: string; epoch: number; delegationGeneration: number; kdf: VaultKdfParams; unlockKeyVersion: number; hasRecovery: boolean; auditSeq: number } | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {})
  };
  const hasContentType = Object.keys(headers).some((header) => header.toLowerCase() === "content-type");
  if (init?.body !== undefined && !hasContentType && !isFormDataBody(init.body as BodyInit)) {
    headers["Content-Type"] = "application/json";
  }
  if (isUnsafeRequest(url, init)) {
    headers[csrfHeaderName] = csrfToken ?? (await fetchCsrfToken());
  }

  const requestStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (error) {
    reportCoreApiFailure(requestStartedAt);
    throw upstreamTransportError(error);
  }

  const payload = await readResponsePayload(response);
  reportCoreApiResponse(response, payload, requestStartedAt);
  if (response.status === 401 || response.status === 403) {
    csrfToken = null;
    resetCliRuntimeSettingsCache();
  }
  if (!response.ok) {
    if (isApiErrorPayload(payload)) {
      throw new SpaceApiError(formatApiError(payload, `Request failed: ${response.status}`), {
        code: payload.error.code,
        status: response.status,
        requestId: payload.error.requestId,
        details: payload.error.details
      });
    }
    throw new SpaceApiError(formatHttpFailure(response.status, payload), { status: response.status });
  }
  return payload as T;
}

async function requestWithTimeout<T>(url: string, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<T>(url, { signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw new SpaceApiError(timeoutMessage, { code: "REQUEST_TIMEOUT", status: 0 });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

const cliRuntimeRegistryStorageKey = "space.cliRuntimeRegistry.cache.v1";
const cliRuntimeRegistryCacheTtlMs = 10_000;
const cliRuntimeRegistryStaleTtlMs = 120 * 60_000;
const cliRuntimeRegistryRequestTimeoutMs = 8_000;

function readStoredCliRuntimeRegistry(): AgentRuntimeRegistry | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem(cliRuntimeRegistryStorageKey)
      ?? window.sessionStorage?.getItem(cliRuntimeRegistryStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentRuntimeRegistry;
    if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
      return parsed;
    }
  } catch {
    // Ignore storage parse error
  }
  return null;
}

function writeStoredCliRuntimeRegistry(registry: AgentRuntimeRegistry): void {
  try {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify(registry);
    window.localStorage?.setItem(cliRuntimeRegistryStorageKey, payload);
  } catch {
    // Session or private mode storage quota fallback.
  }
}

const initialStoredCliRegistry = readStoredCliRuntimeRegistry();
let cliRuntimeRegistryCache: { value: AgentRuntimeRegistry; expiresAt: number; staleUntil: number } | null =
  initialStoredCliRegistry
    ? {
        value: initialStoredCliRegistry,
        // Already expired: the first read still answers from storage but refreshes it, so a login or key added
        // since the last visit shows up (a fresh window here kept the stored state on every reload).
        expiresAt: 0,
        staleUntil: Date.now() + cliRuntimeRegistryStaleTtlMs
      }
    : null;
let cliRuntimeRegistryFlight: Promise<AgentRuntimeRegistry> | null = null;

function startCliRuntimeRegistryFlight(): Promise<AgentRuntimeRegistry> {
  if (cliRuntimeRegistryFlight) return cliRuntimeRegistryFlight;
  cliRuntimeRegistryFlight = requestWithTimeout<AgentRuntimeRegistry>(
    "/api/cli/runtimes",
    cliRuntimeRegistryRequestTimeoutMs,
    "CLI runtimes request timed out. Please retry."
  )
    .then((value) => {
      const fetchedAt = Date.now();
      cliRuntimeRegistryCache = {
        value,
        expiresAt: fetchedAt + cliRuntimeRegistryCacheTtlMs,
        staleUntil: fetchedAt + cliRuntimeRegistryStaleTtlMs
      };
      writeStoredCliRuntimeRegistry(value);
      return value;
    })
    .finally(() => {
      cliRuntimeRegistryFlight = null;
    });
  return cliRuntimeRegistryFlight;
}

function loadCliRuntimes(options: { allowStale?: boolean } = {}): Promise<AgentRuntimeRegistry> {
  const now = Date.now();
  if (cliRuntimeRegistryCache && now < cliRuntimeRegistryCache.expiresAt) {
    return Promise.resolve(cliRuntimeRegistryCache.value);
  }
  const flight = startCliRuntimeRegistryFlight();
  if (options.allowStale && cliRuntimeRegistryCache && now < cliRuntimeRegistryCache.staleUntil) {
    void flight.catch(() => undefined);
    return Promise.resolve(cliRuntimeRegistryCache.value);
  }
  return flight;
}

function warmCliRuntimes(): void {
  if (cliRuntimeRegistryCache || cliRuntimeRegistryFlight) return;
  void startCliRuntimeRegistryFlight().catch(() => undefined);
}

function cliRuntimesSnapshot(): AgentRuntimeRegistry | null {
  return cliRuntimeRegistryCache?.value ?? null;
}

function applyCliRuntimeVisibility(detail?: { runtimeId?: string; enabled?: boolean }): void {
  if (cliRuntimeRegistryCache) {
    cliRuntimeRegistryCache.expiresAt = 0;
    cliRuntimeRegistryCache.staleUntil = 0;
    if (detail?.runtimeId && detail.enabled === false && Array.isArray(cliRuntimeRegistryCache.value?.data)) {
      cliRuntimeRegistryCache.value = {
        ...cliRuntimeRegistryCache.value,
        data: cliRuntimeRegistryCache.value.data.filter((runtime) => runtime.id !== detail.runtimeId)
      };
      writeStoredCliRuntimeRegistry(cliRuntimeRegistryCache.value);
    }
  }
  if (!detail || detail.enabled !== false) {
    try {
      if (typeof window !== "undefined") {
        window.localStorage?.removeItem(cliRuntimeRegistryStorageKey);
        window.sessionStorage?.removeItem(cliRuntimeRegistryStorageKey);
      }
    } catch {
      // Ignore storage errors
    }
  }
  void startCliRuntimeRegistryFlight().catch(() => undefined);
}

function invalidateCliRuntimes(change?: { runtimeId?: string; enabled?: boolean }): void {
  if (change?.runtimeId && change.enabled !== undefined) {
    applyCliRuntimeVisibility(change);
    return;
  }
  if (cliRuntimeRegistryCache) {
    cliRuntimeRegistryCache.expiresAt = 0;
    cliRuntimeRegistryCache.staleUntil = 0;
  }
  try {
    if (typeof window !== "undefined") {
      window.localStorage?.removeItem(cliRuntimeRegistryStorageKey);
      window.sessionStorage?.removeItem(cliRuntimeRegistryStorageKey);
    }
  } catch {
    // Ignore storage errors
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, (event: globalThis.Event) => {
    const change = readCliRuntimeVisibilityChange(event);
    if (!change) return;
    applyCliRuntimeVisibility(change);
  });
}

const cliRuntimeSettingsCacheTtlMs = 10_000;
const cliRuntimeSettingsRequestTimeoutMs = 8_000;
let cliRuntimeSettingsCache: { value: CliRuntimeSettingsResponse; expiresAt: number } | null = null;
let cliRuntimeSettingsFlight: Promise<CliRuntimeSettingsResponse> | null = null;
let cliRuntimeSettingsCacheGeneration = 0;

function startCliRuntimeSettingsFlight(): Promise<CliRuntimeSettingsResponse> {
  if (cliRuntimeSettingsFlight) return cliRuntimeSettingsFlight;
  const generation = cliRuntimeSettingsCacheGeneration;
  const flight = requestWithTimeout<CliRuntimeSettingsResponse>(
    "/api/cli/runtime-settings",
    cliRuntimeSettingsRequestTimeoutMs,
    "CLI runtime settings request timed out. Please retry."
  )
    .then((value) => {
      if (generation === cliRuntimeSettingsCacheGeneration) {
        cliRuntimeSettingsCache = {
          value,
          expiresAt: Date.now() + cliRuntimeSettingsCacheTtlMs
        };
      }
      return value;
    })
    .finally(() => {
      if (cliRuntimeSettingsFlight === flight) cliRuntimeSettingsFlight = null;
    });
  cliRuntimeSettingsFlight = flight;
  return flight;
}

function loadCliRuntimeSettings(options: { forceRefresh?: boolean } = {}): Promise<CliRuntimeSettingsResponse> {
  if (
    !options.forceRefresh
    && cliRuntimeSettingsCache
    && Date.now() < cliRuntimeSettingsCache.expiresAt
  ) {
    return Promise.resolve(cliRuntimeSettingsCache.value);
  }
  return startCliRuntimeSettingsFlight();
}

function warmCliRuntimeSettings(): void {
  if (
    cliRuntimeSettingsFlight
    || (cliRuntimeSettingsCache && Date.now() < cliRuntimeSettingsCache.expiresAt)
  ) return;
  void startCliRuntimeSettingsFlight().catch(() => undefined);
}

function cliRuntimeSettingsSnapshot(): CliRuntimeSettingsResponse | null {
  return cliRuntimeSettingsCache?.value ?? null;
}

function invalidateCliRuntimeSettings(): void {
  cliRuntimeSettingsCacheGeneration += 1;
  if (cliRuntimeSettingsCache) cliRuntimeSettingsCache.expiresAt = 0;
  cliRuntimeSettingsFlight = null;
}

function resetCliRuntimeSettingsCache(): void {
  cliRuntimeSettingsCacheGeneration += 1;
  cliRuntimeSettingsCache = null;
  cliRuntimeSettingsFlight = null;
}

const activeCliSessionFlights = new Map<string, Promise<PaneCliSessionResponse | null>>();

function activeCliSessionFlightKey(
  paneId: string,
  includeTranscript: boolean,
  compactTranscript: boolean
): string {
  return `${paneId}\u0000${includeTranscript ? "1" : "0"}\u0000${compactTranscript ? "c" : "f"}`;
}

function loadActiveCliSession(
  paneId: string,
  options: { includeTranscript?: boolean; compactTranscript?: boolean } = {}
): Promise<PaneCliSessionResponse | null> {
  // Optimistic panes exist only in the client until createRoomPanes returns.
  if (paneId.startsWith("pane:optimistic-")) return Promise.resolve(null);
  const includeTranscript = options.includeTranscript !== false;
  const compactTranscript = options.compactTranscript === true;
  const key = activeCliSessionFlightKey(paneId, includeTranscript, compactTranscript);
  const existing = activeCliSessionFlights.get(key);
  if (existing) return existing;
  const params = new URLSearchParams();
  if (!includeTranscript) params.set("includeTranscript", "false");
  if (compactTranscript) params.set("compactTranscript", "true");
  const query = params.toString();
  const flight = requestWithTimeout<PaneCliSessionResponse | null>(
    `/api/panes/${encodeURIComponent(paneId)}/cli/session${query ? `?${query}` : ""}`,
    8_000,
    "Active CLI session request timed out."
  ).finally(() => {
    if (activeCliSessionFlights.get(key) === flight) activeCliSessionFlights.delete(key);
  });
  activeCliSessionFlights.set(key, flight);
  return flight;
}

function clearActiveCliSessionFlight(paneId: string): void {
  for (const key of activeCliSessionFlights.keys()) {
    if (key.startsWith(`${paneId}\u0000`)) {
      activeCliSessionFlights.delete(key);
    }
  }
}

function createDeduplicatedFlight<T>(fetcher: () => Promise<T>, ttlMs = 15_000) {
  let cache: { value: T; expiresAt: number } | null = null;
  let flight: Promise<T> | null = null;

  return (force = false): Promise<T> => {
    if (!force && cache && Date.now() < cache.expiresAt) {
      return Promise.resolve(cache.value);
    }
    if (flight) return flight;
    flight = fetcher()
      .then((val) => {
        cache = { value: val, expiresAt: Date.now() + ttlMs };
        return val;
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  };
}

let installActivityReported = false;

function createKeyedDeduplicatedFlight<T>(fetcher: (key: string) => Promise<T>, ttlMs = 15_000) {
  const caches = new Map<string, { value: T; expiresAt: number }>();
  const flights = new Map<string, Promise<T>>();

  return {
    load(key: string, force = false): Promise<T> {
      if (!force) {
        const cached = caches.get(key);
        if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value);
      }
      const active = flights.get(key);
      if (active) return active;
      const flight = fetcher(key)
        .then((value) => {
          caches.set(key, { value, expiresAt: Date.now() + ttlMs });
          return value;
        })
        .finally(() => {
          if (flights.get(key) === flight) flights.delete(key);
        });
      flights.set(key, flight);
      return flight;
    },
    invalidate(key?: string): void {
      if (key === undefined) caches.clear();
      else caches.delete(key);
    }
  };
}

const fetchCodexEnvironment = createDeduplicatedFlight(() => request<CodexEnvironment>("/api/codex/environment"), 15_000);
const fetchToolbarUsageAccounts = createDeduplicatedFlight(() => request<CodexUsageAccountList>("/api/admin/codex-usage-accounts"), 15_000);
const fetchToolbarAntigravityUsageAccounts = createDeduplicatedFlight(() => request<AntigravityUsageAccountList>("/api/admin/antigravity-usage-accounts"), 15_000);
const fetchToolbarClaudeUsageAccounts = createDeduplicatedFlight(() => request<ClaudeUsageAccountList>("/api/admin/claude-usage-accounts"), 15_000);
const fetchToolbarApiProviderAccounts = createDeduplicatedFlight(() => request<ApiProviderAccountList>("/api/admin/api-provider-accounts"), 15_000);
const fetchToolbarCliSessions = createDeduplicatedFlight(() => request<CliSessionStats>("/api/admin/cli-sessions"), 10_000);
const fetchCliAccountProfiles = createKeyedDeduplicatedFlight(
  (runtimeId) => request<ListCliAccountProfilesResponse>(`/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles`),
  15_000
);

if (typeof window !== "undefined") {
  window.addEventListener("space:cli-account-profiles-change", () => fetchCliAccountProfiles.invalidate());
}

export const api = {
  healthPing: () => request<{ ok: boolean }>("/healthz", { cache: "no-store" }),
  systemHealth: (userView = false) => request<SystemHealthSnapshot>(userView ? "/api/system-health" : "/api/admin/system-analytics/health", { cache: "no-store" }),
  systemHealthHistory: (range: SystemHealthRange) => request<SystemHealthHistory>(`/api/admin/system-analytics/health/history?range=${encodeURIComponent(range)}`),
  systemTopology: () => request<SystemTopologySnapshot>("/api/admin/system-analytics/topology", { cache: "no-store" }),
  readyz: () => request<ReadyzPayload>("/readyz"),
  ensureProject: (input: { name?: string; path?: string }) =>
    request<{ ok: boolean; path: string; name: string }>("/api/projects/ensure", { method: "POST", body: JSON.stringify(input) }),
  appVersion: () => request<AppVersionStatus>("/api/app/version"),
  reportClientError: (report: ClientErrorReport) =>
    request<null>("/api/client-errors", { method: "POST", body: JSON.stringify(report) }),
  // The API forwards this only in public installations whose owner turned telemetry on, at most once a day.
  // shortcut: sent once per page load, so a tab left open for days counts only on the day it loaded; add a daily timer if that matters.
  reportInstallActivity: () => {
    if (installActivityReported) return Promise.resolve(null);
    installActivityReported = true;
    return request<null>("/api/telemetry/active", { method: "POST", body: JSON.stringify({
      screen: `${window.screen.width}x${window.screen.height}`,
      dpr: String(Math.round(window.devicePixelRatio * 100) / 100),
      lang: navigator.language.split("-").slice(0, 2).join("-")
    }) }).catch(() => null);
  },
  harnessHealth: () => singleFlightRequest("harness-health", () => request<HarnessHealth>("/api/harness/healthz")),
  harnessUrl: "/api/harness/",
  eventStreamUrl,
  me: () => Promise.resolve(consumeAuthBootstrap() ?? request<AuthMe>("/api/auth/me")).then(noteServerModules),
  setupStatus: () => request<SetupStatus>("/api/setup/status"),
  claimSetup: (input: SetupClaimInput) =>
    request<SetupClaimResponse>("/api/setup/claim", {
      method: "POST",
      body: JSON.stringify(input)
    }).then(noteServerModules),
  setupOverview: () => request<SetupOverview>("/api/setup/overview"),
  askSetupAssistant: (question: string, signal?: AbortSignal) => request<{ available: boolean; modelId: string | null; message: string }>("/api/setup/assistant", { method: "POST", body: JSON.stringify({ question }), signal }),
  beginSetupCaptureCheck: (draftRevision: number) => request<{ checkId: string; colors: string[] }>("/api/setup/capture/checks", { method: "POST", body: JSON.stringify({ draftRevision }) }),
  beginSetupClientRuntimeCheck: (featureId: SetupClientRuntimeFeatureId, draftRevision: number, signal?: AbortSignal) => request<SetupClientRuntimeChallenge>("/api/setup/client-runtime/checks", { method: "POST", signal, body: JSON.stringify({ featureId, draftRevision }) }),
  completeSetupClientRuntimeCheck: (checkId: string, observation: SetupClientRuntimeObservation, signal?: AbortSignal) => request<{ verified: boolean }>(`/api/setup/client-runtime/checks/${encodeURIComponent(checkId)}/complete`, { method: "POST", signal, body: JSON.stringify(observation) }),
  cancelSetupClientRuntimeCheck: async (checkId: string) => { await request(`/api/setup/client-runtime/checks/${encodeURIComponent(checkId)}`, { method: "DELETE" }); },
  completeSetupCaptureCheck: (checkId: string, rgba: string) => request<{ verified: boolean }>(`/api/setup/capture/checks/${encodeURIComponent(checkId)}/complete`, { method: "POST", body: JSON.stringify({ rgba }) }),
  cancelSetupCaptureCheck: async (checkId: string) => { await request(`/api/setup/capture/checks/${encodeURIComponent(checkId)}`, { method: "DELETE" }); },
  getSetupServiceChoices: (featureId: SetupFeatureId) => request<{ choices: Array<{ id: string; label: string }> }>(`/api/setup/services/${encodeURIComponent(featureId)}/choices`),
  checkSetupService: (featureId: SetupFeatureId, draftRevision: number, choiceId: string) => request<{ verified: boolean }>(`/api/setup/services/${encodeURIComponent(featureId)}/check`, { method: "POST", body: JSON.stringify({ draftRevision, choiceId }) }),
  getSetupVoiceProviders: () => request<{ providers: SetupVoiceProvider[] }>("/api/setup/voice/providers"),
  saveSetupVoiceCredential: (input: Record<string, string>) => request<{ configured: boolean; credentialRef: string }>("/api/setup/voice/credentials", { method: "POST", body: JSON.stringify(input) }),
  startSetupVoiceCheck: (draftRevision: number) => request<{ checkId: string; websocketUrl: string; sampleRate: 16000 }>("/api/setup/voice/checks", { method: "POST", body: JSON.stringify({ draftRevision }) }),
  getSetupCatalog: () => request<{ protocolVersion: 2; catalogVersion: string; features: Array<SetupFeature & { availability: SetupAvailability; reasonCode: string | null }> }>("/api/setup/catalog"),
  getSetupFreeModels: () => request<{ selectedModelId: string | null; checkedAt: string | null; models: Array<{ id: string; anonymousAvailable: boolean; setupPassed: number; latencyMs: number }>; selectable?: boolean }>("/api/setup/free-models"),
  selectSetupFreeModel: (modelId: string | null) => request<{ modelId: string | null; verified: boolean }>("/api/setup/free-model", { method: "POST", body: JSON.stringify({ modelId }) }),
  getSetupFreeModel: () => request<{ choice: "AUTO_BEST_FREE"; modelId: string | null; verified: boolean }>("/api/setup/free-model"),
  getSetupDraft: () => request<SetupDraft | (Pick<SetupDraft, "ownerId" | "protocolVersion" | "persona" | "level" | "requestedFeatureIds" | "connectionChoices" | "catalogVersion"> & { id: null; revision: null })>("/api/setup/draft"),
  saveSetupDraft: (input: Pick<SetupDraft, "persona" | "level" | "requestedFeatureIds" | "connectionChoices"> & { expectedRevision: number | null }) =>
    request<SetupDraft>("/api/setup/draft", { method: "PUT", body: JSON.stringify(input) }),
  createSetupPlan: (draftRevision: number) =>
    request<SetupPlan>("/api/setup/plan", { method: "POST", body: JSON.stringify({ draftRevision }) }),
  startSetupRun: (plan: Pick<SetupPlan, "id" | "planDigest">, idempotencyKey: string) =>
    request<SetupRun>("/api/setup/runs", { method: "POST", body: JSON.stringify({ planId: plan.id, planDigest: plan.planDigest, idempotencyKey }) }),
  getSetupRun: (runId: string) => request<{ run: SetupRun; plan: SetupPlan; tasks: SetupTask[]; receipts: SetupReadinessReceipt[] }>(`/api/setup/runs/${encodeURIComponent(runId)}`),
  getCurrentSetup: () => request<{ run: SetupRun | null; plan: SetupPlan | null; completedRunId: string | null; tasks: SetupTask[]; receipts: SetupReadinessReceipt[] }>("/api/setup/current"),
  getSetupRunEvents: (runId: string, after = 0) => request<{ events: SetupExecutionEvent[] }>(`/api/setup/runs/${encodeURIComponent(runId)}/events?after=${after}`),
  retrySetupRun: (runId: string, taskIds: string[], expectedRunRevision: number) =>
    request<{ run: SetupRun }>(`/api/setup/runs/${encodeURIComponent(runId)}/retry`, { method: "POST", body: JSON.stringify({ taskIds, expectedRunRevision }) }),
  pauseSetupRun: (runId: string) =>
    request<{ run: SetupRun }>(`/api/setup/runs/${encodeURIComponent(runId)}/pause`, { method: "POST", body: "{}" }),
  resumeSetupRun: (runId: string) =>
    request<{ run: SetupRun }>(`/api/setup/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body: "{}" }),
  reconcileSetupTask: (runId: string, taskId: string) =>
    request<{ run: SetupRun; plan: SetupPlan; tasks: SetupTask[]; receipts: SetupReadinessReceipt[] }>(
      `/api/setup/runs/${encodeURIComponent(runId)}/reconcile`, { method: "POST", body: JSON.stringify({ taskId }) }),
  finishSetupRun: (run: Pick<SetupRun, "id">, plan: Pick<SetupPlan, "draftRevision" | "planDigest">) =>
    request<SetupOverview>("/api/setup/finish", { method: "POST", body: JSON.stringify({ runId: run.id, draftRevision: plan.draftRevision, planDigest: plan.planDigest }) }),
  setupStarterRoom: () =>
    request<SetupStarterRoomResponse>("/api/setup/starter-room", { method: "POST" }),
  startSetupConnectionChecks: () =>
    request<SetupConnectionCheckRun>("/api/setup/connection-check-runs", { method: "POST" }),
  startSetupConnectionCheck: (connectionId: string) =>
    request<SetupConnectionCheckRun>(
      `/api/setup/connections/${encodeURIComponent(connectionId)}/check-runs`,
      { method: "POST" }
    ),
  getSetupConnectionCheckReplay: (runId: string, afterSequence = 0) =>
    request<SetupConnectionCheckReplay>(
      `/api/setup/connection-check-runs/${encodeURIComponent(runId)}/replay?afterSequence=${Math.max(0, Math.trunc(afterSequence))}`
    ),
  openSetupConnectionCheckStream: (runId: string, afterSequence = 0) => {
    if (typeof window.EventSource === "undefined") return null;
    return new window.EventSource(
      `/api/setup/connection-check-runs/${encodeURIComponent(runId)}/stream?afterSequence=${Math.max(0, Math.trunc(afterSequence))}`,
      { withCredentials: true }
    );
  },
  verifySetupConnection: (connectionId: string) =>
    request<SetupConnection>(
      `/api/setup/connections/${encodeURIComponent(connectionId)}/verify`,
      { method: "POST" }
    ),
  verifyAllSetupConnections: () =>
    request<SetupOverview>("/api/setup/connections/verify-all", { method: "POST" }),
  finishSetup: () => request<SetupOverview>("/api/setup/finish", { method: "POST" }),
  login: (email: string, password: string) => {
    resetCliRuntimeSettingsCache();
    return request<AuthMe>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }).then(noteServerModules);
  },
  logout: async () => {
    const result = await request<{ ok: true }>("/api/auth/logout", { method: "POST" });
    csrfToken = null;
    resetCliRuntimeSettingsCache();
    return result;
  },
  googleLoginWithCredential: (credential: string) => {
    resetCliRuntimeSettingsCache();
    return request<AuthMe>("/api/auth/google/credential", {
      method: "POST",
      body: JSON.stringify({ credential })
    }).then(noteServerModules);
  },
  configureGoogleOAuth: (input: { clientId: string; clientSecret: string }) =>
    request<{ ok: true; googleAuthEnabled: boolean }>("/api/auth/google/configure", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  unlinkGoogleAccount: () =>
    request<{ ok: true }>("/api/auth/google/unlink", {
      method: "POST"
    }),
  listGoogleAccounts: () => request<{ accounts: GoogleAccountSummary[] }>("/api/auth/google/accounts"),
  setPrimaryGoogleAccount: (id: string) => request<{ account: GoogleAccountSummary }>(`/api/auth/google/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ isPrimary: true })
  }),
  removeGoogleAccount: (id: string) => request<{ ok: true }>(`/api/auth/google/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAppDevices: () => request<{ devices: AppDeviceSession[] }>("/api/auth/devices"),
  revokeAppDevice: (id: string) => request<{ device: AppDeviceSession }>(`/api/auth/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({}) }),
  checkGoogleAccountBrowser: (id: string) => request<{ account: GoogleAccountSummary; check: GoogleBrowserCheckSummary }>(`/api/auth/google/accounts/${encodeURIComponent(id)}/browser-check`, {
    method: "POST", body: JSON.stringify({})
  }),
  listAdminUsers: () =>
    request<AdminUserListResponse>("/api/admin/users"),
  updateUserRole: (userId: string, role: AuthUser["role"]) =>
    request<{ user: AdminUserItem }>(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role })
    }),
  // Multi-user accounts: these answer 404 MULTI_USER_DISABLED unless SPACE_MULTI_USER_ENABLED=true.
  listUserInvites: () => request<{ invites: UserInvite[] }>("/api/admin/users/invites"),
  createUserInvite: (input: { email: string; role: UserInviteRole }) =>
    request<{ invite: UserInvite; token: string }>("/api/admin/users/invites", { method: "POST", body: JSON.stringify(input) }),
  revokeUserInvite: (inviteId: string) =>
    request<{ id: string; revoked: true }>(`/api/admin/users/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }),
  setUserDisabled: (userId: string, disabled: boolean) =>
    request<{ id: string; disabled: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/disabled`, {
      method: "PATCH",
      body: JSON.stringify({ disabled })
    }),
  // Room sharing, also behind SPACE_MULTI_USER_ENABLED; only the room's owner gets an answer.
  roomShares: (roomId: string) => request<RoomShareListResponse>(`/api/rooms/${encodeURIComponent(roomId)}/shares`),
  addRoomShare: (roomId: string, email: string, permission: RoomSharePermission) =>
    request<RoomShare>(`/api/rooms/${encodeURIComponent(roomId)}/shares`, { method: "PUT", body: JSON.stringify({ email, permission }) }),
  setRoomShare: (roomId: string, userId: string, permission: RoomSharePermission) =>
    request<RoomShare>(`/api/rooms/${encodeURIComponent(roomId)}/shares/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ permission }) }),
  removeRoomShare: (roomId: string, userId: string) =>
    request<{ removed: true }>(`/api/rooms/${encodeURIComponent(roomId)}/shares/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  acceptUserInvite: (token: string, password: string) => {
    resetCliRuntimeSettingsCache();
    return request<AuthMe>("/api/auth/invites/accept", {
      method: "POST",
      body: JSON.stringify({ token, password })
    }).then(noteServerModules);
  },
  clipboardItems: (query: { q?: string; source?: ClipboardSource; includeCompleted?: boolean; paneId?: string; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.source) params.set("source", query.source);
    if (query.includeCompleted !== undefined) params.set("includeCompleted", String(query.includeCompleted));
    if (query.paneId) params.set("paneId", query.paneId);
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<ClipboardItem>>(`/api/clipboard-items${suffix ? `?${suffix}` : ""}`);
  },
  createClipboardItem: (input: CreateClipboardItemRequest) =>
    request<ClipboardItem>("/api/clipboard-items", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  setClipboardItemCompleted: (clipboardItemId: string, completed: boolean) =>
    request<ClipboardItem>(`/api/clipboard-items/${encodeURIComponent(clipboardItemId)}`, {
      method: "PATCH",
      body: JSON.stringify({ completed })
    }),
  panePlanExecution: (paneId: string) =>
    request<ManagedPlanExecution | null>(`/api/panes/${encodeURIComponent(paneId)}/plan-executions`),
  planExecution: (executionId: string) =>
    request<ManagedPlanExecution>(`/api/plan-executions/${encodeURIComponent(executionId)}`),
  startPlanExecution: (paneId: string, input: StartPlanExecutionRequest) =>
    request<ManagedPlanExecution>(`/api/panes/${encodeURIComponent(paneId)}/plan-executions`, {
      method: "POST", headers: cliTerminalControlHeaders(paneId), body: JSON.stringify(input)
    }),
  controlPlanExecution: (executionId: string, input: PlanExecutionControlRequest, paneId: string) =>
    request<ManagedPlanExecution>(`/api/plan-executions/${encodeURIComponent(executionId)}/control`, {
      method: "POST", headers: cliTerminalControlHeaders(paneId), body: JSON.stringify(input)
    }),
  overridePlanExecutionStage: (executionId: string, stageId: string, input: PlanStageOverrideRequest, paneId: string) =>
    request<ManagedPlanExecution>(`/api/plan-executions/${encodeURIComponent(executionId)}/stages/${encodeURIComponent(stageId)}/override`, {
      method: "PATCH", headers: cliTerminalControlHeaders(paneId), body: JSON.stringify(input)
    }),
  updatePlanProgress: (clipboardItemId: string, input: UpdatePlanProgressRequest) =>
    request<ClipboardItem>(`/api/clipboard-items/${encodeURIComponent(clipboardItemId)}/progress`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  updateClipboardNoteText: (clipboardItemId: string, text: string) =>
    request<ClipboardItem>(`/api/clipboard-items/${encodeURIComponent(clipboardItemId)}/text`, {
      method: "PATCH",
      body: JSON.stringify({ text })
    }),
  deleteClipboardItem: (clipboardItemId: string) =>
    request<{ id: string; deleted: true }>(`/api/clipboard-items/${encodeURIComponent(clipboardItemId)}`, {
      method: "DELETE"
    }),
  clearClipboardItems: () =>
    request<{ deletedCount: number }>("/api/clipboard-items", { method: "DELETE" }),
  sharedChatMessages: (
    query: { limit?: number; before?: string; senderType?: "user" | "agent" | "system"; roomId?: string } = {}
  ) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.before) params.set("before", query.before);
    if (query.senderType) params.set("senderType", query.senderType);
    if (query.roomId) params.set("roomId", query.roomId);
    const suffix = params.toString();
    return request<{ data: SharedChatMessage[]; nextCursor: string | null }>(
      `/api/shared-chat/messages${suffix ? `?${suffix}` : ""}`
    );
  },
  sendSharedChatMessage: (input: SendSharedChatMessageInput) =>
    request<SharedChatMessage>("/api/shared-chat/messages", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  auditChainEntries: (query: { limit?: number; beforeSeq?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.beforeSeq !== undefined) params.set("beforeSeq", String(query.beforeSeq));
    const suffix = params.toString();
    return request<{ data: AuditChainEntry[]; nextCursor: string | null }>(
      `/api/audit/entries${suffix ? `?${suffix}` : ""}`
    );
  },
  auditVerify: () => request<AuditVerifyResponse>("/api/audit/verify"),
  clearSharedChat: () =>
    request<{ deletedCount: number }>("/api/shared-chat/messages", { method: "DELETE" }),
  // Vault (plan clipboard:vEYtT6-bEN0J): ciphertext, public keys and metadata only; the dock decrypts locally.
  vaultState: () => request<VaultStateResponse>("/api/space-vault/state"),
  vaultBroker: () => request<{ publicKey: string; keyVersion: number }>("/api/space-vault/broker"),
  vaultEnroll: (body: unknown) => request<{ vaultId: string; epoch: number }>("/api/space-vault/enroll", { method: "POST", body: JSON.stringify(body) }),
  vaultUnlockChallenge: () => request<{ challenge: string; epoch: number; expiresAt: string; vaultId: string; passwordEnvelope: VaultSymmetricEnvelope; kdf: VaultKdfParams; unlockKeyVersion: number }>(
    "/api/space-vault/unlock/challenge", { method: "POST", body: "{}" }),
  vaultUnlock: (body: { challenge: string; replyPublicKey: string; signature: string }) =>
    request<{ sealedServerShare: VaultTransportEnvelope; epoch: number }>("/api/space-vault/unlock", { method: "POST", body: JSON.stringify(body) }),
  vaultLock: () => request<{ epoch: number }>("/api/space-vault/lock", { method: "POST", body: "{}" }),
  vaultItems: () => request<{ items: VaultItemMetadata[]; stats?: Record<string, VaultItemStats> }>("/api/space-vault/items"),
  vaultItem: (id: string) => request<{ item: VaultItemRecord }>(`/api/space-vault/items/${encodeURIComponent(id)}`),
  vaultItemRecords: () => request<{ items: VaultItemRecord[] }>("/api/space-vault/item-records"),
  vaultSaveItems: (items: VaultItemRecordInput[]) => request<{ saved: number; refused: number }>("/api/space-vault/items", { method: "PUT", body: JSON.stringify({ items }) }),
  // Deletes, the recovery envelope, the password envelope and the inbox key carry the unlocked dock's signature (vault-client.ts signVaultOperatorRequest).
  vaultDeleteItems: (body: { ids: string[]; epoch: number; operatorSignature: string }) => request<{ deleted: number }>("/api/space-vault/items/delete", { method: "POST", body: JSON.stringify(body) }),
  vaultSiteCheck: (origins: string[]) => request<{ results: Array<{ origin: string; status: "OK" | "NO_DNS" | "UNREACHABLE" | "LOCAL"; detail: string | null }> }>(
    "/api/space-vault/site-check", { method: "POST", body: JSON.stringify({ origins }) }),
  vaultSaveItem: (item: VaultItemRecordInput) => request<{ item: VaultItemRecord }>(`/api/space-vault/items/${encodeURIComponent(item.metadata.id)}`, { method: "PUT", body: JSON.stringify(item) }),
  vaultRotatePassword: (body: unknown) => request<{ epoch: number }>("/api/space-vault/password", { method: "POST", body: JSON.stringify(body) }),
  vaultSetRecovery: (body: VaultRecovery & { epoch: number; operatorSignature: string }) => request<{ recovery: true }>("/api/space-vault/recovery", { method: "PUT", body: JSON.stringify(body) }),
  vaultRecovery: () => request<{ recovery: VaultRecovery | null }>("/api/space-vault/recovery"),
  vaultInbox: () => request<{ inbox: { publicKey: string; privateKeyEnvelope: VaultSymmetricEnvelope } | null }>("/api/space-vault/inbox"),
  vaultSetInbox: (body: { publicKey: string; privateKeyEnvelope: VaultSymmetricEnvelope; epoch: number; operatorSignature: string }) =>
    request<{ inbox: true }>("/api/space-vault/inbox", { method: "PUT", body: JSON.stringify(body) }),
  vaultPending: () => request<{ pending: VaultPendingSecret[] }>("/api/space-vault/pending"),
  vaultDeletePending: (id: string) => request<{ deleted: true }>(`/api/space-vault/pending/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Off revokes: the answer then carries the new generation and epoch. */
  vaultSetAgentAccess: (enabled: boolean) => request<{ agentAccess: boolean; generation?: number; epoch?: number }>("/api/space-vault/agent-access", { method: "PUT", body: JSON.stringify({ enabled }) }),
  vaultRevoke: () => request<{ generation: number; epoch: number }>("/api/space-vault/revoke", { method: "POST", body: "{}" }),
  vaultDelegate: (body: unknown) => request<{ generation: number }>("/api/space-vault/delegations", { method: "POST", body: JSON.stringify(body) }),
  vaultSignupGrants: () => request<{ grants: VaultSignupGrant[] }>("/api/space-vault/signup-grants"),
  vaultCreateSignupGrant: (body: VaultSignupGrantRequest) => request<{ grant: VaultSignupGrant }>("/api/space-vault/signup-grants", { method: "POST", body: JSON.stringify(body) }),
  vaultRevokeSignupGrant: (id: string) => request<{ revoked: true }>(`/api/space-vault/signup-grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // API keys handed to agents (plan clipboard:-qvpC_Q0rAVg): the value goes in once and never comes back out here.
  vaultHandoffKeys: () => request<{ keys: VaultHandoffKey[] }>("/api/space-vault/keys"),
  vaultCreateHandoffKey: (body: { label: string; value: string; expiresInHours: number }) => request<{ key: VaultHandoffKey }>("/api/space-vault/keys", { method: "POST", body: JSON.stringify(body) }),
  vaultDeleteHandoffKey: (id: string) => request<{ deleted: true }>(`/api/space-vault/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  vaultAudit: (beforeSeq?: number) => request<{ entries: Array<{ id: string; seq: number; event: VaultAuditRecord; createdAt: string }>; nextBeforeSeq: number | null }>(
    `/api/space-vault/audit?limit=50${beforeSeq ? `&beforeSeq=${beforeSeq}` : ""}`),
  councilModels: () => request<CouncilModelsResponse>("/api/council/models"),
  councilRuns: () => request<{ runs: CouncilRunSummary[] }>("/api/council/runs"),
  councilRun: (id: string) => request<{ run: CouncilRun }>(`/api/council/runs/${encodeURIComponent(id)}`),
  createCouncilRun: (input: CreateCouncilRunInput) =>
    request<{ run: CouncilRun }>("/api/council/runs", { method: "POST", body: JSON.stringify(input) }),
  councilRunAction: (id: string, action: "answers" | "changes" | "approve" | "stop" | "cancel" | "resume" | "another-round" | "clipboard-plan", body?: unknown) =>
    request<{ run: CouncilRun }>(`/api/council/runs/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
  deleteCouncilRun: (id: string) => request<void>(`/api/council/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  nous: () => request<{ state: NousState }>("/api/nous"),
  nousMessages: () => request<{ messages: NousMessage[]; waiting?: string[]; attachments?: Record<string, NousAttachment[]> }>("/api/nous/messages"),
  sendNousMessage: (content: string, attachmentIds: string[] = []) => request<{ message: NousMessage; attachments?: NousAttachment[] }>("/api/nous/messages",
    { method: "POST", body: JSON.stringify(attachmentIds.length ? { content, attachmentIds } : { content }) }),
  uploadNousAttachments: (files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("file", file, file.name || "upload"));
    return request<{ attachments: NousAttachment[] }>("/api/nous/attachments", { method: "POST", body: form });
  },
  deleteNousAttachment: (id: string) => request<{ removed: boolean }>(`/api/nous/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  nousAttachmentUrl: (id: string, mode?: "preview" | "download") =>
    `/api/nous/attachments/${encodeURIComponent(id)}${mode === "preview" ? "?preview=1" : mode === "download" ? "?download=1" : ""}`,
  clearNousMessages: () => request<{ cleared: number }>("/api/nous/messages", { method: "DELETE" }),
  stopNous: () => request<{ stopped: boolean }>("/api/nous/stop", { method: "POST" }),
  updateNousSettings: (input: Partial<NousSettings>) => request<{ settings: NousSettings }>("/api/nous/settings", { method: "PATCH", body: JSON.stringify(input) }),
  /** Away mode's Settings switch (plan clipboard:B7eTUHTJYg3X): start or end it, or change its grant. */
  setNousAway: (input: { away: boolean; grant?: NousAwayGrant[] }) => request<{ away: NousAway | null }>("/api/nous/away", { method: "POST", body: JSON.stringify(input) }),
  nousOverview: () => request<{ overview: NousOverview }>("/api/nous/overview"),
  nousDecisions: () => request<{ decisions: NousDecision[] }>("/api/nous/decisions"),
  /** Nous's pane board (plan clipboard:Y9cgKVHFaHrr): every open pane by room with its live line, items and reply box. */
  nousPaneBoard: () => request<{ board: NousPaneBoard }>("/api/nous/pane-board"),
  refreshNousPaneBoard: (paneId?: string) => request<{ started: boolean }>("/api/nous/pane-board/refresh", { method: "POST", body: JSON.stringify(paneId ? { paneId } : {}) }),
  answerNousPane: (paneId: string, input: NousPaneBoardAnswerInput) =>
    request<NousPaneBoardAnswerResult>(`/api/nous/pane-board/${encodeURIComponent(paneId)}/answer`, { method: "POST", body: JSON.stringify(input) }),
  answerNousDecision: (id: string, input: NousDecisionAnswerInput) =>
    request<{ decision: NousDecision }>(`/api/nous/decisions/${encodeURIComponent(id)}/answer`, { method: "POST", body: JSON.stringify(input) }),
  /** "Show everything": the texts a decision sends, read whole from the files Nous named (operator request 2026-10-21). */
  nousDecisionFiles: (id: string) =>
    request<{ files: Array<{ ref: string; text: string | null; total: number | null; truncated: boolean; error?: string }> }>(`/api/nous/decisions/${encodeURIComponent(id)}/files`),
  nousDecisionFeedback: (id: string, couldHaveDecided: boolean) =>
    request<{ decision: NousDecision }>(`/api/nous/decisions/${encodeURIComponent(id)}/feedback`, { method: "POST", body: JSON.stringify({ couldHaveDecided }) }),
  taskItems: (query: { q?: string; status?: TaskStatus; source?: TaskSource; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
    if (query.source) params.set("source", query.source);
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<TaskItem>>(`/api/task-items${suffix ? `?${suffix}` : ""}`);
  },
  createTaskItem: (input: CreateTaskItemRequest) =>
    request<TaskItem>("/api/task-items", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateTaskItem: (taskItemId: string, input: { title?: string; objective?: string; status?: TaskStatus }) =>
    request<TaskItem>(`/api/task-items/${encodeURIComponent(taskItemId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  deleteTaskItem: (taskItemId: string) =>
    request<{ id: string; deleted: true }>(`/api/task-items/${encodeURIComponent(taskItemId)}`, {
      method: "DELETE"
    }),
  clearTaskItems: () =>
    request<{ deletedCount: number }>("/api/task-items", { method: "DELETE" }),
  links: (query: { q?: string; category?: UserLinkCategory; isQuick?: boolean; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.category) params.set("category", query.category);
    if (query.isQuick !== undefined) params.set("isQuick", String(query.isQuick));
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<UserLink>>(`/api/links${suffix ? `?${suffix}` : ""}`);
  },
  inspectLink: (url: string) => request<InspectUserLinkResponse>(`/api/links/inspect?url=${encodeURIComponent(url)}`),
  createLink: (input: CreateUserLinkRequest) => request<UserLink>("/api/links", { method: "POST", body: JSON.stringify(input) }),
  updateLink: (linkId: string, input: UpdateUserLinkRequest) => request<UserLink>(`/api/links/${encodeURIComponent(linkId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteLink: (linkId: string) => request<{ id: string; deleted: true }>(`/api/links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  telegramIntegration: () => request<TelegramIntegrationStatus>("/api/integrations/telegram"),
  createTelegramPairing: (botToken: string) =>
    request<TelegramPairingResponse>("/api/integrations/telegram/pairings", {
      method: "POST",
      body: JSON.stringify({ botToken })
    }),
  checkTelegramPairing: (pairingId: string) =>
    request<TelegramIntegrationStatus>(
      `/api/integrations/telegram/pairings/${encodeURIComponent(pairingId)}/check`,
      { method: "POST" }
    ),
  sendTelegramTestDelivery: () =>
    request<TelegramIntegrationStatus>("/api/integrations/telegram/test-deliveries", { method: "POST" }),
  updateTelegramIntegration: (input: UpdateTelegramIntegrationInput) =>
    request<TelegramIntegrationStatus>("/api/integrations/telegram", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  disconnectTelegramIntegration: () =>
    request<TelegramIntegrationStatus>("/api/integrations/telegram", { method: "DELETE" }),
  rooms: (query: { page?: number; pageSize?: number; all?: boolean; ownerUserId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    if (query.all !== undefined) params.set("all", String(query.all));
    if (query.ownerUserId !== undefined) params.set("ownerUserId", query.ownerUserId);
    const suffix = params.toString();
    return singleFlightRequest(`rooms:${suffix}`, () =>
      request<Paginated<Room>>(`/api/rooms${suffix ? `?${suffix}` : ""}`)
    );
  },
  dashboardAgents: (roomId: string) => requestWithTimeout<{
    data: Pane[];
    activity: Record<string, "working" | "waiting" | "done" | "idle">;
    details?: Record<string, { status: "working" | "waiting" | "done" | "idle"; reason?: string | null; since?: string | null; modelId?: string | null; source?: "native" | "screen" | "session" | "run" }>;
    sampledAt?: string;
  }>(`/api/rooms/${encodeURIComponent(roomId)}/dashboard-agents`, 15_000, "Agent activity refresh timed out."),
  roomCliActivity: (query: { all?: boolean; ownerUserId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.all !== undefined) params.set("all", String(query.all));
    if (query.ownerUserId !== undefined) params.set("ownerUserId", query.ownerUserId);
    const suffix = params.toString();
    return request<RoomCliActivityResponse>(`/api/rooms/cli-activity${suffix ? `?${suffix}` : ""}`);
  },
  createRoom: (name: string, initialPaneCount: number, reason?: string, projectPath?: string | null) =>
    request<Room>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name,
        initialPaneCount,
        reason: reason?.trim() || undefined,
        projectPath: projectPath ?? "/opt/spaceapp"
      })
    }),
  reorderRooms: (roomIds: string[]) =>
    request<Room[]>("/api/rooms/reorder", {
      method: "POST",
      body: JSON.stringify({ roomIds })
    }),
  reorderPanes: (roomId: string, paneIds: string[]) =>
    request<Pane[]>(`/api/rooms/${encodeURIComponent(roomId)}/panes/reorder`, {
      method: "POST",
      body: JSON.stringify({ paneIds })
    }),
  updateRoom: (roomId: string, input: UpdateRoomInput) =>
    request<Room>(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  updateRoomPaneLayout: (roomId: string, input: UpdatePaneLayoutInput) =>
    request<RoomPaneLayoutResult>(`/api/rooms/${encodeURIComponent(roomId)}/pane-layout`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  deleteRoom: (roomId: string) =>
    request<{ ok: true; roomId: string }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE"
    }),
  roomAgentHistory: (roomId: string) =>
    request<Paginated<AgentPaneHistoryItem>>(`/api/rooms/${encodeURIComponent(roomId)}/agent-history`),
  roomAgent: (roomId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent`),
  inspectRoomMission: (roomId: string) =>
    request<{ roomId: string; snapshot: RoomAgentSession["missionSnapshot"] }>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/missions`),
  startRoomAgentMission: (roomId: string, objective: string, clientRequestId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/missions`, {
      method: "POST", body: JSON.stringify({ objective, clientRequestId })
    }),
  sendRoomAgentMessage: (roomId: string, content: string, clientRequestId: string, selectedBrowserPaneId?: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/messages`, {
      method: "POST",
      body: JSON.stringify({ content, clientRequestId, selectedBrowserPaneId })
    }),
  acknowledgeRoomAgentCommand: (roomId: string, clientRequestId: string, ok: boolean) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/commands/${encodeURIComponent(clientRequestId)}/ack`, {
      method: "POST", body: JSON.stringify({ ok })
    }),
  stopRoomAgent: (roomId: string, reason: string, expectedMissionId?: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/stop`, {
      method: "POST",
      body: JSON.stringify({ reason, expectedMissionId })
    }),
  controlRoomAgent: (roomId: string, input: ({ action: "PAUSE"; reason: string } | { action: "RESUME" }) & { expectedMissionId?: string }) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/control`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  clearRoomAgentTranscript: (roomId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/transcript`, {
      method: "DELETE"
    }),
  setRoomAgentMonitor: (roomId: string, settings: { enabled?: boolean; autopilot?: boolean }) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/monitor`, {
      method: "PATCH", body: JSON.stringify(settings)
    }),
  acknowledgeRoomAgentEvent: (roomId: string, eventId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/events/${encodeURIComponent(eventId)}/ack`, {
      method: "POST", body: JSON.stringify({})
    }),
  answerRoomAgentEvent: (roomId: string, eventId: string, input: { answer?: string; submit?: boolean; decline?: boolean }) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/events/${encodeURIComponent(eventId)}/answer`, {
      method: "POST", body: JSON.stringify(input)
    }),
  roomAgentPending: () => request<{ rooms: Record<string, number>; latest: RoomAgentEvent[]; roomNames?: Record<string, string> }>("/api/room-agent/pending"),
  // Space notifications: what waits for the user, the newest records, read / acknowledge, and a test.
  notificationsPending: () => request<import("@space/contracts").NotificationsPending>("/api/notifications/pending", { cache: "no-store" }),
  notifications: (query: { status?: "OPEN" | "ALL" | "NEEDS_YOU"; source?: string; limit?: number; before?: string } = {}) =>
    request<{ notifications: import("@space/contracts").SpaceNotification[] }>(`/api/notifications?${new URLSearchParams({ ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}), ...(query.limit ? { limit: String(query.limit) } : {}), ...(query.before ? { before: query.before } : {}) })}`, { cache: "no-store" }),
  notification: (id: string) => request<{ notification: import("@space/contracts").SpaceNotification }>(`/api/notifications/${encodeURIComponent(id)}`, { cache: "no-store" }),
  markNotificationRead: (id: string) => request<{ notification: import("@space/contracts").SpaceNotification }>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
  ackNotification: (id: string) => request<{ notification: import("@space/contracts").SpaceNotification }>(`/api/notifications/${encodeURIComponent(id)}/ack`, { method: "POST" }),
  readAllNotifications: () => request<{ read: number }>("/api/notifications/read-all", { method: "POST" }),
  testNotification: () => request<{ notification: import("@space/contracts").SpaceNotification }>("/api/notifications/test", { method: "POST" }),
  // The Android app's FCM token while "Push notifications on this device" is on; `available` says whether the server can push.
  registerPushDevice: (device: import("@space/contracts").PushDeviceRegistration) => request<{ registered: true; available: boolean }>("/api/notifications/push-devices", { method: "POST", body: JSON.stringify(device) }),
  removePushDevice: (token: string) => request<{ removed: boolean }>("/api/notifications/push-devices", { method: "DELETE", body: JSON.stringify({ token }) }),
  codexHistory: (
    input:
      | number
      | {
          page?: number;
          pageSize?: number;
          limit?: number;
          includeArchived?: boolean;
          dedupeTitles?: boolean;
          q?: string;
        } = 50,
    includeArchived = false
  ) => {
    const params = new URLSearchParams();
    if (typeof input === "number") {
      params.set("limit", String(input));
      if (includeArchived) params.set("includeArchived", "true");
    } else {
      if (input.page !== undefined) params.set("page", String(input.page));
      if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.includeArchived) params.set("includeArchived", "true");
      if (input.dedupeTitles) params.set("dedupeTitles", "true");
      if (input.q) params.set("q", input.q);
    }
    return request<CodexHistoryResponse>(`/api/codex/history?${params.toString()}`);
  },
  unifiedCliTasks: (input?: {
    page?: number;
    pageSize?: number;
    includeArchived?: boolean;
    q?: string;
  }) => {
    const params = new URLSearchParams();
    if (input) {
      if (input.page !== undefined) params.set("page", String(input.page));
      if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
      if (input.includeArchived) params.set("includeArchived", "true");
      if (input.q) params.set("q", input.q);
    }
    return request<CliTaskHistoryResponse>(`/api/cli/tasks?${params.toString()}`);
  },
  agentSessions: (input?: {
    page?: number;
    pageSize?: number;
    includeArchived?: boolean;
    q?: string;
    interval?: "all" | "today" | "24h" | "3d" | "7d";
    status?: "all" | "active" | "completed";
  }) => {
    const params = new URLSearchParams();
    if (input) {
      if (input.page !== undefined) params.set("page", String(input.page));
      if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
      if (input.includeArchived) params.set("includeArchived", "true");
      if (input.q) params.set("q", input.q);
      if (input.interval && input.interval !== "all") params.set("interval", input.interval);
      if (input.status && input.status !== "all") params.set("status", input.status);
    }
    return request<AgentSessionHistoryResponse>(`/api/agent/sessions?${params.toString()}`);
  },
  agentSessionRename: (threadId: string, title: string) =>
    request<CodexHistoryItem>(`/api/agent/sessions/codex/${encodeURIComponent(threadId)}/rename`, {
      method: "POST",
      body: JSON.stringify({ title })
    }),
  agentSessionArchive: (threadId: string) =>
    request<CodexHistoryItem>(`/api/agent/sessions/codex/${encodeURIComponent(threadId)}/archive`, {
      method: "POST"
    }),
  listSystemServices: () => request<SystemServicesResponse>(`/api/system/services`),
  resetFailedSystemServices: (unit?: string) =>
    request<{ success: boolean; reset: string }>("/api/system/services/reset-failed", {
      method: "POST",
      body: JSON.stringify(unit ? { unit } : {})
    }),
  recoveryCliTask: (paneId: string) =>
    requestWithTimeout<CliTaskHistoryResponse>(
      `/api/panes/${encodeURIComponent(paneId)}/cli/recovery-task`,
      8_000,
      "Recovery CLI task request timed out."
    ),
  codexThread: (threadId: string, presentation?: CodexThreadPresentation) =>
    request<CodexThreadResponse>(
      `/api/codex/threads/${encodeURIComponent(threadId)}${presentation ? `?presentation=${encodeURIComponent(presentation)}` : ""}`
    ),
  codexEnvironment: (force?: boolean) => fetchCodexEnvironment(force),
  toolbarUsageAccounts: (force?: boolean) => fetchToolbarUsageAccounts(force),
  toolbarAntigravityUsageAccounts: (force?: boolean) => fetchToolbarAntigravityUsageAccounts(force),
  toolbarClaudeUsageAccounts: (force?: boolean) => fetchToolbarClaudeUsageAccounts(force),
  toolbarApiProviderAccounts: (force?: boolean) => fetchToolbarApiProviderAccounts(force),
  toolbarResetCredits: () => request<CodexResetCreditAvailability>("/api/admin/codex-reset-credits"),
  redeemToolbarResetCredit: (accountId: string, idempotencyKey: string) =>
    request<CodexResetCreditRedemptionResponse>(
      `/api/admin/codex-reset-credits/${encodeURIComponent(accountId)}/redemptions`,
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
      }
    ),
  toolbarCliSessions: (force?: boolean) => fetchToolbarCliSessions(force),
  toolbarModelStats: (_roomId: string, windowMinutes: number) =>
    request<ToolbarModelStats>(
      `/api/admin/toolbar-model-stats?windowMinutes=${encodeURIComponent(String(windowMinutes))}`
    ),
  systemAnalyticsOverview: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsOverviewResponse>(`/api/admin/system-analytics/overview?range=${encodeURIComponent(range)}`),
  systemAnalyticsModels: (range: SystemAnalyticsRange, route: SystemAnalyticsTokenRoute = "all") =>
    request<SystemAnalyticsModelsResponse>(`/api/admin/system-analytics/models?range=${encodeURIComponent(range)}${route === "all" ? "" : `&route=${route}`}`),
  systemAnalyticsResources: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsResourcesResponse>(`/api/admin/system-analytics/resources?range=${encodeURIComponent(range)}`),
  systemAnalyticsProcesses: (input: {
    page?: number;
    pageSize?: number;
    sort?: "rss" | "cpu" | "pid" | "uptime" | "name" | "state" | "threads";
    direction?: "asc" | "desc";
    query?: string;
    ownership?: "ALL" | "SPACE_CLI" | "SPACE_SHARED" | "OTHER";
  } = {}) => {
    const params = new URLSearchParams();
    if (input.page !== undefined) params.set("page", String(input.page));
    if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
    if (input.sort) params.set("sort", input.sort);
    if (input.direction) params.set("direction", input.direction);
    if (input.query) params.set("query", input.query);
    if (input.ownership) params.set("ownership", input.ownership);
    return request<SystemAnalyticsProcessesResponse>(`/api/admin/system-analytics/processes?${params.toString()}`);
  },
  systemAnalyticsCliSessions: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsCliSessionsResponse>(`/api/admin/system-analytics/cli-sessions?range=${encodeURIComponent(range)}`),
  systemAnalyticsInstalls: () => request<SystemAnalyticsInstallsResponse>("/api/admin/system-analytics/installs"),
  opencodeBench: (range: SystemAnalyticsRange = "7d", refresh = false) =>
    request<OpencodeBenchResponse>(`/api/admin/system-analytics/opencode-bench?range=${encodeURIComponent(range)}${refresh ? "&refresh=true" : ""}`),
  opencodeBenchProbe: (provider: string, model: string) =>
    request<any>(`/api/admin/system-analytics/opencode-bench/probe/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`),
  reapToolbarCliSessions: () => request<CliSessionReapResponse>("/api/admin/cli-session-reaps", {
    method: "POST",
    body: JSON.stringify({})
  }),
  toolbarHostMemory: () => request<HostMemoryDetails>("/api/admin/host-memory"),
  reclaimToolbarMemory: () => request<MemoryReclaimResponse>("/api/admin/memory-reclaims", {
    method: "POST",
    body: JSON.stringify({})
  }),
  gatewayStatus: () => request<GatewayStatus>("/api/admin/gateway/status"),
  gatewayClaudeApiKeyUse: () => request<GatewayClaudeApiKeyUse>("/api/admin/gateway/claude-api-key"),
  gatewayAnthropicAdmin: () => request<GatewayAnthropicAdminStatus>("/api/admin/gateway/anthropic-admin"),
  saveGatewayAnthropicAdminKey: (adminKey: string) =>
    request<GatewayAnthropicAdminStatus>("/api/admin/gateway/anthropic-admin", { method: "PUT", body: JSON.stringify({ adminKey }) }),
  removeGatewayAnthropicAdminKey: () => request<{ removed: boolean }>("/api/admin/gateway/anthropic-admin", { method: "DELETE" }),
  syncGatewayAnthropicBilling: () => request<GatewayAnthropicAdminStatus>("/api/admin/gateway/anthropic-admin/sync", { method: "POST", body: JSON.stringify({}) }),
  gatewayAnthropicBilling: (days: number) => request<GatewayAnthropicBillingReport>(`/api/admin/gateway/anthropic-billing?days=${days}`),
  gatewayAccounts: () => request<GatewayAccountList>("/api/admin/gateway/accounts"),
  setGatewayAccountPaused: (accountId: string, paused: boolean) =>
    request<GatewayAccount>(`/api/admin/gateway/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  gatewayApiKeys: () => request<GatewayApiKeyList>("/api/admin/gateway/keys"),
  createGatewayApiKey: (input: Partial<GatewayApiKeyCreateRequest> & { name: string }) =>
    request<GatewayApiKeyCreatedResponse>("/api/admin/gateway/keys", { method: "POST", body: JSON.stringify(input) }),
  updateGatewayApiKey: (keyId: string, patch: GatewayApiKeyUpdateRequest) =>
    request<GatewayApiKey>(`/api/admin/gateway/keys/${encodeURIComponent(keyId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteGatewayApiKey: (keyId: string) =>
    request<{ id: string; deleted: true }>(`/api/admin/gateway/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" }),
  gatewayRequestLogs: (query: { limit?: number; cursor?: string | null; filter?: GatewayRequestLogFilter } = {}) => {
    const params = gatewayLogFilterParams(query.filter);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    const suffix = params.toString();
    return request<GatewayRequestLogList>(`/api/admin/gateway/logs${suffix ? `?${suffix}` : ""}`);
  },
  gatewayRequestLog: (logId: string) => request<GatewayRequestLog>(`/api/admin/gateway/logs/${encodeURIComponent(logId)}`),
  gatewayRequestLogFacets: (range: { from?: string; to?: string } = {}) => {
    const params = gatewayLogFilterParams(range);
    const suffix = params.toString();
    return request<GatewayRequestLogFacets>(`/api/admin/gateway/logs/facets${suffix ? `?${suffix}` : ""}`);
  },
  gatewayDashboard: (range: GatewayDashboardRange) => request<GatewayDashboard>(`/api/admin/gateway/dashboard?range=${encodeURIComponent(range)}`),
  gatewayHealth: () => request<GatewayHealth>("/api/admin/gateway/health"),
  gatewayAccountDetail: (accountId: string) => request<GatewayAccountDetail>(`/api/admin/gateway/accounts/${encodeURIComponent(accountId)}`),
  updateGatewayAccount: (accountId: string, patch: GatewayAccountUpdateRequest) =>
    request<GatewayAccount>(`/api/admin/gateway/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  exportGatewayAccount: (accountId: string) => request<{ accountId: string; email: string | null; planType: string | null; status: string; authJson: string }>(
    `/api/admin/gateway/accounts/${encodeURIComponent(accountId)}/export`, { method: "POST", body: JSON.stringify({ confirm: true }) }),
  gatewayApiKeyDetail: (keyId: string) => request<GatewayApiKeyDetail>(`/api/admin/gateway/keys/${encodeURIComponent(keyId)}`),
  regenerateGatewayApiKey: (keyId: string) =>
    request<GatewayApiKeyCreatedResponse>(`/api/admin/gateway/keys/${encodeURIComponent(keyId)}/regenerate`, { method: "POST", body: JSON.stringify({}) }),
  gatewaySettings: () => request<GatewaySettings>("/api/admin/gateway/settings"),
  gatewayCompressionStats: (hours = 24) => request<GatewayCompressionStats>(`/api/admin/gateway/compression-stats?hours=${hours}`),
  gatewayCompressionSession: () => request<GatewayHeadroomSession>("/api/admin/gateway/compression/session"),
  gatewayCompressionLifetime: () => request<GatewayHeadroomLifetime>("/api/admin/gateway/compression/lifetime"),
  gatewayCompressionHistory: () => request<GatewayHeadroomHistory>("/api/admin/gateway/compression/history"),
  gatewayReport: (from: string, to: string) =>
    request<GatewayReport>(`/api/admin/gateway/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  startGatewayCodexDeviceSignIn: () => request<{ flowId: string; verificationUrl: string; userCode: string; intervalSeconds: number; expiresInSeconds: number }>(
    "/api/admin/gateway/codex/device", { method: "POST", body: JSON.stringify({}) }),
  pollGatewayCodexDeviceSignIn: (flowId: string) => request<{ status: "PENDING" | "EXPIRED" | "CONNECTED"; account?: { id: string; label: string } }>(
    `/api/admin/gateway/codex/device/${encodeURIComponent(flowId)}/poll`, { method: "POST", body: JSON.stringify({}) }),
  startGatewayCodexBrowserSignIn: () => request<{ flowId: string; authorizationUrl: string }>(
    "/api/admin/gateway/codex/browser", { method: "POST", body: JSON.stringify({}) }),
  completeGatewayCodexBrowserSignIn: (flowId: string, callbackUrl: string) => request<{ status: "CONNECTED"; account: { id: string; label: string } }>(
    `/api/admin/gateway/codex/browser/${encodeURIComponent(flowId)}/complete`, { method: "POST", body: JSON.stringify({ callbackUrl }) }),
  startGatewayClaudeSignIn: () => request<{ flowId: string; authorizationUrl: string }>(
    "/api/admin/gateway/claude/browser", { method: "POST", body: JSON.stringify({}) }),
  completeGatewayClaudeSignIn: (flowId: string, code: string) => request<{ status: "CONNECTED"; account: { id: string; label: string } }>(
    `/api/admin/gateway/claude/browser/${encodeURIComponent(flowId)}/complete`, { method: "POST", body: JSON.stringify({ code }) }),
  gatewayAntigravityProfiles: () => request<{ data: Array<{ profileId: string; email: string | null; inGateway: boolean }> }>(
    "/api/admin/gateway/antigravity/profiles"),
  importGatewayAntigravityProfile: (profileId: string) => request<{ status: "CONNECTED"; account: { id: string; label: string } }>(
    "/api/admin/gateway/antigravity/import", { method: "POST", body: JSON.stringify({ profileId }) }),
  addGatewayOpenAiApiKey: (input: { provider?: "OPENAI_API" | "OPENROUTER" | "DEEPSEEK" | "CLAUDE" | "GOOGLE_AI"; apiKey?: string; useSpaceKey?: boolean; label?: string }) =>
    request<{ status: "CONNECTED"; account: { id: string; label: string } }>(
      "/api/admin/gateway/api-key/add", { method: "POST", body: JSON.stringify({ provider: "OPENAI_API", ...input }) }),
  importGatewayCodexAuthJson: (authJson: string) => request<{ status: "CONNECTED"; account: { id: string; label: string } }>(
    "/api/admin/gateway/codex/import", { method: "POST", body: JSON.stringify({ authJson }) }),
  refreshGatewayAccountUsage: (accountId: string) => request<{ status: string }>(
    `/api/admin/gateway/accounts/${encodeURIComponent(accountId)}/usage`, { method: "POST", body: JSON.stringify({}) }),
  testGatewayAccount: (accountId: string, model?: string) => request<{ ok: boolean; model: string; status: number; latencyMs: number; error: string | null }>(
    `/api/admin/gateway/accounts/${encodeURIComponent(accountId)}/test`, { method: "POST", body: JSON.stringify(model ? { model } : {}) }),
  useGatewayResetCredit: (accountId: string, idempotencyKey: string) => request<{ outcome: string; windowsReset: number }>(
    `/api/admin/gateway/accounts/${encodeURIComponent(accountId)}/reset-credit`, { method: "POST", body: JSON.stringify({ idempotencyKey }) }),
  deleteGatewayAccount: (accountId: string) => request<{ id: string; deleted: true }>(
    `/api/admin/gateway/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),
  updateGatewaySettings: (patch: GatewaySettingsUpdateRequest) =>
    request<GatewaySettings>("/api/admin/gateway/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  reloadGateway: () => request<{ status: string }>("/api/admin/gateway/reload", { method: "POST", body: JSON.stringify({}) }),
  codexLbSpeedDefaults: () => request<CodexLbSpeedDefaultsResponse>("/api/admin/codex-lb-speed-defaults"),
  updateCodexLbSpeedDefault: (
    modelId: CodexLbSpeedDefaultsResponse["models"][number]["modelId"],
    tier: CodexLbSpeedTier
  ) => request<CodexLbSpeedDefaultsResponse>(`/api/admin/codex-lb-speed-defaults/${encodeURIComponent(modelId)}`, {
    method: "PATCH",
    body: JSON.stringify({ tier })
  }),
  previewCodexHistoryPurge: () => request<CodexHistoryPurgePreviewResponse>("/api/admin/codex-history-purge-previews", {
    method: "POST",
    body: JSON.stringify({})
  }),
  executeCodexHistoryPurge: (
    previewId: string,
    confirmation: CodexHistoryPurgeExecuteRequest["confirmation"]
  ) => request<CodexHistoryPurgeResponse>("/api/admin/codex-history-purges", {
    method: "POST",
    body: JSON.stringify({ previewId, confirmation })
  }),
  previewCliSessionCleanup: () => request<CliSessionCleanupPreviewResponse>("/api/admin/cli-session-cleanup-previews", {
    method: "POST",
    body: JSON.stringify({})
  }),
  executeCliSessionCleanup: (
    previewId: string,
    confirmation: CliSessionCleanupExecuteRequest["confirmation"]
  ) => request<CliSessionCleanupResponse>("/api/admin/cli-session-cleanups", {
    method: "POST",
    body: JSON.stringify({ previewId, confirmation })
  }),
  restartCoreServices: () =>
    request<ServiceRestartResponse>("/api/admin/service-restarts", {
      method: "POST",
      body: JSON.stringify({ scope: "CORE" })
    }),
  streamingCatalog: () =>
    request<StreamingCatalogResponse>("/api/admin/streaming/catalog"),
  startStreamingOAuth: (provider: StreamingOAuthProvider) =>
    request<StreamingOAuthStartResponse>(
      `/api/admin/streaming/providers/${encodeURIComponent(provider)}/oauth/start`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  verifyStreamingAccount: (accountId: string) =>
    request<StreamingVerifyAccountResponse>(
      `/api/admin/streaming/accounts/${encodeURIComponent(accountId)}/verify`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  removeStreamingAccount: (accountId: string) =>
    request<{ account: StreamingPlatformAccount }>(
      `/api/admin/streaming/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE" }
    ),
  disconnectStreamingAuthorization: (authorizationId: string) =>
    request<StreamingDisconnectAuthorizationResponse>(
      `/api/admin/streaming/authorizations/${encodeURIComponent(authorizationId)}`,
      { method: "DELETE" }
    ),
  updateStreamingOverlaySettings: (input: UpdateStreamingOverlaySettingsInput) =>
    request<StreamingOverlaySettings>("/api/admin/streaming/overlay-settings", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  streamingOverlaySnapshot: () =>
    request<StreamingOverlaySnapshot>("/api/admin/streaming/overlay-snapshot"),
  streamingBotSettings: () =>
    request<{ settings: StreamingBotSettings; memoryCount: number }>("/api/admin/streaming/bot/settings"),
  streamingBotModels: () =>
    request<{ models: Array<{ kind: "API" | "CLI"; providerId: string; modelId: string; label: string; available: boolean; reason: string | null }> }>("/api/admin/streaming/bot/models"),
  updateStreamingBotSettings: (input: UpdateStreamingBotSettingsInput) =>
    request<StreamingBotSettings>("/api/admin/streaming/bot/settings", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  pauseStreamingBot: () =>
    request<StreamingBotSettings>("/api/admin/streaming/bot/pause", { method: "POST", body: JSON.stringify({}) }),
  resumeStreamingBot: () =>
    request<StreamingBotSettings>("/api/admin/streaming/bot/resume", { method: "POST", body: JSON.stringify({}) }),
  streamingBotStatus: () =>
    request<StreamingBotStatus>("/api/admin/streaming/bot/status"),
  streamingBotActivity: (limit = 50) =>
    request<{ data: StreamingBotActivity[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } }>(
      `/api/admin/streaming/bot/activity?limit=${Math.max(1, Math.min(limit, 200))}`
    ),
  testStreamingBot: (input: StreamingBotTestInput) =>
    request<{ reply: string | null; errorCode: string | null; model: string | null }>("/api/admin/streaming/bot/test", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  clearStreamingBotMemory: () =>
    request<{ removed: number }>("/api/admin/streaming/bot/memory/clear", {
      method: "POST",
      body: JSON.stringify({})
    }),
  searchStreamingBotMemory: (query: string, limit = 20) =>
    request<{ entries: Array<{ id: string; title: string; body: string; createdAt: string }> }>(
      `/api/admin/streaming/bot/memory/search?q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(limit, 50))}`
    ),
  streamingBotMemory: (status: "PENDING" | "APPROVED", query = "") =>
    request<{ entries: StreamingBotReviewedMemory[] }>(`/api/admin/streaming/bot/memory?status=${status}&q=${encodeURIComponent(query)}`),
  createStreamingBotMemory: (input: CreateStreamingBotMemoryInput) =>
    request<StreamingBotReviewedMemory>("/api/admin/streaming/bot/memory", { method: "POST", body: JSON.stringify(input) }),
  updateStreamingBotMemory: (id: string, input: UpdateStreamingBotMemoryInput) =>
    request<StreamingBotReviewedMemory>(`/api/admin/streaming/bot/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteStreamingBotMemory: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/streaming/bot/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  streamingModerationActions: () =>
    request<{ actions: StreamingModerationAction[] }>("/api/admin/streaming/bot/moderation"),
  streamingLiveContext: () =>
    request<{ generatedAt: string; bot: unknown; metrics: unknown[]; messages: unknown[]; targets: unknown[]; moderation: unknown[]; memory: unknown[]; knowledge: unknown[] }>("/api/admin/streaming/live-context"),
  streamingLiveAction: (input: { action: "REPLY"; platform: "YOUTUBE" | "TWITCH"; message: string } |
    { action: "PAUSE" } | { action: "TIMEOUT"; activityId: string; durationSeconds: 300 | 1800 } |
    { action: "UNDO"; moderationActionId: string }) =>
    request<{ ok: boolean; result: unknown }>("/api/admin/streaming/live-action", { method: "POST", body: JSON.stringify(input) }),
  timeoutStreamingModerationReview: (id: string, durationSeconds: 300 | 1800) =>
    request<StreamingModerationAction>(`/api/admin/streaming/bot/moderation/${encodeURIComponent(id)}/timeout`, { method: "POST", body: JSON.stringify({ durationSeconds }) }),
  undoStreamingModerationAction: (id: string) =>
    request<StreamingModerationAction>(`/api/admin/streaming/bot/moderation/${encodeURIComponent(id)}/undo`, { method: "POST", body: "{}" }),
  listCliMaintenanceRuns: () =>
    request<{ data: AdminOperationRun[] }>("/api/admin/cli-maintenance/runs"),
  getCliMaintenanceReplay: (runId: string, afterSequence = 0) =>
    request<CliMaintenanceReplayPayload>(
      `/api/admin/cli-maintenance/runs/${encodeURIComponent(runId)}/replay?afterSequence=${Math.max(0, Math.trunc(afterSequence))}`
    ),
  openCliMaintenanceStream: (runId: string, afterSequence = 0) => {
    if (typeof window.EventSource === "undefined") return null;
    return new window.EventSource(
      `/api/admin/cli-maintenance/runs/${encodeURIComponent(runId)}/stream?afterSequence=${Math.max(0, Math.trunc(afterSequence))}`,
      { withCredentials: true }
    );
  },
  cliMaintenanceExportUrl: (runId: string) =>
    `/api/admin/cli-maintenance/runs/${encodeURIComponent(runId)}/export`,
  openCliMaintenanceRecovery: () =>
    request<CliMaintenanceRecoveryPayload>("/api/admin/cli-maintenance/auth-handoffs/open", {
      method: "POST",
      body: JSON.stringify({})
    }),
  startCliMaintenance: (input: CliMaintenanceRequest) =>
    request<AdminOperationRun>("/api/admin/cli-maintenance/runs", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  maintenanceAutopilotStatus: () => request<MaintenanceAutopilotStatus>("/api/admin/maintenance-autopilot"),
  startMaintenanceAutopilot: () => request<MaintenanceAutopilotStatus>("/api/admin/maintenance-autopilot/runs", { method: "POST", body: JSON.stringify({}) }),
  updateMaintenanceAutopilotSchedule: (input: MaintenanceAutopilotScheduleUpdate) =>
    request<MaintenanceAutopilotStatus>("/api/admin/maintenance-autopilot/schedule", { method: "PUT", body: JSON.stringify(input) }),
  createMaintenancePlan: (input: MaintenancePlanRequest) => request<AdminOperationRun>("/api/admin/cli-maintenance/plans", { method: "POST", body: JSON.stringify(input) }),
  applyMaintenancePlan: (planId: string, input: MaintenanceApplyRequest) => request<AdminOperationRun>(`/api/admin/cli-maintenance/plans/${encodeURIComponent(planId)}/apply`, { method: "POST", body: JSON.stringify(input) }),
  detectCliUpdateAll: () =>
    request<CliUpdateAllDetection>("/api/admin/cli-maintenance/update-all/detect"),
  runCliUpdateAll: (input: CliUpdateAllRequest) =>
    request<CliUpdateAllResult>("/api/admin/cli-maintenance/update-all/run", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createReleasePreview: (input: CreateReleasePreviewInput) =>
    request<ReleasePreview>("/api/admin/releases/previews", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  publishRelease: (input: CreateReleaseRequest) =>
    request<AdminOperationRun>("/api/admin/releases", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  listReleaseRuns: () =>
    request<{ data: AdminOperationRun[] }>("/api/admin/releases/runs"),
  listSourceControlConnections: () =>
    request<{ data: SourceControlConnection[] }>("/api/admin/source-control/connections"),
  replaceSourceControlConnection: (provider: SourceControlProvider, token: string) =>
    request<SourceControlConnection>(
      `/api/admin/source-control/connections/${encodeURIComponent(provider)}`,
      { method: "PUT", body: JSON.stringify({ token }) }
    ),
  verifySourceControlConnection: (provider: SourceControlProvider) =>
    request<SourceControlConnection>(
      `/api/admin/source-control/connections/${encodeURIComponent(provider)}/verifications`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  disconnectSourceControlConnection: (provider: SourceControlProvider) =>
    request<SourceControlConnection>(
      `/api/admin/source-control/connections/${encodeURIComponent(provider)}`,
      { method: "DELETE" }
    ),
  panes: (roomId: string, options: { includeClosed?: boolean } = {}) =>
    singleFlightRequest(
      `panes:${roomId}:${options.includeClosed ? "closed" : "open"}`,
      () => request<Paginated<Pane>>(
        `/api/panes?roomId=${encodeURIComponent(roomId)}${options.includeClosed ? "&includeClosed=true" : ""}`
      )
    ),
  createPane: (
    roomId: string,
    title: string,
    mode: Pane["mode"],
    options: {
      providerId?: string | null;
      modelId?: string | null;
      cwd?: string | null;
      terminalRuntimeId?: string | null;
      vncTarget?: VncTarget | null;
      split?: Pane["split"];
    } = {}
  ) =>
    request<Pane>("/api/panes", {
      method: "POST",
      body: JSON.stringify({ roomId, title, mode, ...options })
    }),
  createRoomPanes: (roomId: string, input: CreateRoomPanesRequest) =>
    request<RoomPanesResult>(`/api/rooms/${encodeURIComponent(roomId)}/panes`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updatePane: (paneId: string, input: Partial<Pane>) =>
    request<Pane>(`/api/panes/${encodeURIComponent(paneId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  movePane: (paneId: string, targetRoomId: string) =>
    request<MovePaneResult>(`/api/panes/${encodeURIComponent(paneId)}/move`, {
      method: "POST",
      body: JSON.stringify({ targetRoomId })
    }),
  taskTitleSettings: () => request<TaskTitleSettings>("/api/settings/task-titles"),
  updateTaskTitleSettings: (settings: TaskTitleSettings) => request<TaskTitleSettings>("/api/settings/task-titles", {method:"PATCH",body:JSON.stringify(settings)}),
  taskTitleAvailability: () => request<{candidates:TaskTitleCandidateStatus[]}>("/api/settings/task-titles/availability"),
  bindHarnessTitleSession:(paneId:string,sessionId:string)=>request<Pane>(`/api/panes/${encodeURIComponent(paneId)}/title/harness-session`,{method:"POST",body:JSON.stringify({sessionId})}),
  setPaneTitlePreference: (paneId:string,candidateId:string|null) => request<Pane>(`/api/panes/${encodeURIComponent(paneId)}/title/preference`,{method:"PATCH",body:JSON.stringify({candidateId})}),
  generatePaneTitle: (paneId: string) =>
    request<Pane>(`/api/panes/${encodeURIComponent(paneId)}/title/generate`, {
      method: "POST"
    }),
  paneCapabilities: (paneId: string) =>
    request<PaneCapabilityMatrix>(`/api/panes/${encodeURIComponent(paneId)}/capabilities`),
  closePane: (paneId: string) =>
    request<Pane>(`/api/panes/${encodeURIComponent(paneId)}`, {
      method: "DELETE"
    }),
  agentSession: (paneId: string) => request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent-session`),
  dots: () => request<{ dots: import("@space/contracts").DotProfile[] }>("/api/dots"),
  dotCollection: (dotId: string, resource: import("@space/contracts").DotResource) =>
    request<import("@space/contracts").DotCollection>(`/api/dots/${encodeURIComponent(dotId)}/collections/${resource}`),
  dotTools: (dotId: string, roomId?: string | null) =>
    request<{ dotId: string; tools: import("@space/contracts").DotToolSummary[]; total: number; available: number }>(
      `/api/dots/${encodeURIComponent(dotId)}/tools${roomId ? `?roomId=${encodeURIComponent(roomId)}` : ""}`),
  dotApprovals: (dotId: string, sessionId: string) =>
    request<{ dotId: string; items: import("@space/contracts").DotToolInvocation[] }>(
      `/api/dots/${encodeURIComponent(dotId)}/approvals?sessionId=${encodeURIComponent(sessionId)}`),
  decideDotApproval: (dotId: string, invocationId: string, decision: "APPROVE" | "DECLINE") =>
    request<{ invocation: import("@space/contracts").DotToolInvocation; continued: boolean }>(
      `/api/dots/${encodeURIComponent(dotId)}/approvals/${encodeURIComponent(invocationId)}`, { method: "POST", body: JSON.stringify({ decision }) }),
  dotGoals: (dotId: string, sessionId?: string | null) =>
    request<{ dotId: string; items: import("@space/contracts").DotGoal[] }>(
      `/api/dots/${encodeURIComponent(dotId)}/goals${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  createDotGoal: (dotId: string, input: { sessionId: string; objective: string; milestones: string[]; criteria: string[]; budget: { maxSteps: number; maxMinutes: number } }) =>
    request<{ goal: import("@space/contracts").DotGoal }>(`/api/dots/${encodeURIComponent(dotId)}/goals`, { method: "POST", body: JSON.stringify(input) }),
  controlDotGoal: (dotId: string, goalId: string, action: "PAUSE" | "RESUME" | "CANCEL") =>
    request<{ goal: import("@space/contracts").DotGoal }>(`/api/dots/${encodeURIComponent(dotId)}/goals/${encodeURIComponent(goalId)}/control`,
      { method: "POST", body: JSON.stringify({ action }) }),
  steerDotGoal: (dotId: string, goalId: string, text: string) =>
    request<{ goal: import("@space/contracts").DotGoal }>(`/api/dots/${encodeURIComponent(dotId)}/goals/${encodeURIComponent(goalId)}/steer`,
      { method: "POST", body: JSON.stringify({ text }) }),
  dotSchedules: (dotId: string) =>
    request<{ dotId: string; items: import("@space/contracts").DotSchedule[] }>(`/api/dots/${encodeURIComponent(dotId)}/schedules`),
  createDotSchedule: (dotId: string, input: import("@space/contracts").CreateDotScheduleInput) =>
    request<{ schedule: import("@space/contracts").DotSchedule }>(`/api/dots/${encodeURIComponent(dotId)}/schedules`, { method: "POST", body: JSON.stringify(input) }),
  controlDotSchedule: (dotId: string, scheduleId: string, action: "CONFIRM" | "PAUSE" | "RESUME" | "CANCEL") =>
    request<{ schedule: import("@space/contracts").DotSchedule }>(`/api/dots/${encodeURIComponent(dotId)}/schedules/${encodeURIComponent(scheduleId)}/control`,
      { method: "POST", body: JSON.stringify({ action }) }),
  updateDot: (dotId: string, input: import("@space/contracts").UpdateDotProfile) =>
    request<{ dot: import("@space/contracts").DotProfile }>(`/api/dots/${encodeURIComponent(dotId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  dotFeed: (dotId: string, page: { before?: string; after?: string; limit?: number; roomId?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (page.before) params.set("before", page.before);
    if (page.after) params.set("after", page.after);
    if (page.limit) params.set("limit", String(page.limit));
    if (page.roomId) params.set("roomId", page.roomId);
    const query = params.toString();
    return request<import("@space/contracts").DotFeed>(`/api/dots/${encodeURIComponent(dotId)}/feed${query ? `?${query}` : ""}`);
  },
  markDotFeedRead: (dotId: string, cursor: string, roomId?: string | null) =>
    request<{ unread: number }>(`/api/dots/${encodeURIComponent(dotId)}/feed/read`, { method: "POST", body: JSON.stringify({ cursor, ...(roomId ? { roomId } : {}) }) }),
  dotSettings: () => request<{ settings: import("@space/contracts").DotUserSettings }>("/api/dots/settings"),
  updateDotSettings: (input: import("@space/contracts").UpdateDotUserSettings) =>
    request<{ settings: import("@space/contracts").DotUserSettings }>("/api/dots/settings", { method: "PUT", body: JSON.stringify(input) }),
  dotModels: () => request<import("@space/contracts").DotModelChoices>("/api/dots/models"),
  dotProactiveUsage: (days = 7) => request<import("@space/contracts").DotProactiveUsage>(`/api/dots/proactive/usage?days=${days}`),
  dotMemories: (dotId: string, query: { scope?: import("@space/contracts").DotMemoryScope; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.scope) params.set("scope", query.scope);
    if (query.q?.trim()) params.set("q", query.q.trim());
    return request<{ dotId: string; items: import("@space/contracts").DotMemory[] }>(
      `/api/dots/${encodeURIComponent(dotId)}/memories${params.size ? `?${params}` : ""}`);
  },
  createDotMemory: (dotId: string, input: { text: string; scope: import("@space/contracts").DotMemoryScope; roomId?: string }) =>
    request<{ memory: import("@space/contracts").DotMemory }>(`/api/dots/${encodeURIComponent(dotId)}/memories`, { method: "POST", body: JSON.stringify(input) }),
  updateDotMemory: (dotId: string, memoryId: string, text: string) =>
    request<{ memory: import("@space/contracts").DotMemory }>(`/api/dots/${encodeURIComponent(dotId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: "PATCH", body: JSON.stringify({ text }) }),
  deleteDotMemory: (dotId: string, memoryId: string) =>
    request<{ memoryId: string; deleted: boolean }>(`/api/dots/${encodeURIComponent(dotId)}/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" }),
  connectors: () => request<import("@space/contracts").ConnectorsStatus>("/api/connectors"),
  channels: () => request<import("@space/contracts").ChannelsStatus>("/api/channels"),
  askDotFromLive: (input: { roomId: string; dot: string; text: string; liveSessionId: string; requestId: string }) =>
    request<{ status: string; dot?: string; paneId?: string; watchId?: string | null; message: string }>("/api/dots/live/requests",
      { method: "POST", body: JSON.stringify(input) }),
  dotLiveStatus: (roomId: string, dot: string) =>
    request<{ status: string; dot?: string; message: string }>(`/api/dots/live/status?roomId=${encodeURIComponent(roomId)}&dot=${encodeURIComponent(dot)}`),
  createChannelLinkCode: () => request<{ code: string; expiresAt: string }>("/api/channels/link-codes", { method: "POST", body: "{}" }),
  unlinkChannelIdentity: (identityId: string) =>
    request<{ identityId: string; unlinked: boolean }>(`/api/channels/identities/${encodeURIComponent(identityId)}`, { method: "DELETE" }),
  /** A one-use consent URL (10 minutes) for another browser, from a `/api/connectors/:provider/start` URL with a login hint. */
  connectorConsentLink: (startUrl: string) => request<{ url: string; expiresAt: string }>(`${startUrl}&link=1`, { cache: "no-store" }),
  disconnectConnector: (accountId: string) =>
    request<{ accountId: string; disconnected: boolean }>(`/api/connectors/${encodeURIComponent(accountId)}`, { method: "DELETE" }),
  dotWorkspace: (dotId: string, folder = "") =>
    request<import("@space/contracts").DotWorkspaceFolder>(`/api/dots/${encodeURIComponent(dotId)}/workspace${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  dotDeliverables: (dotId: string) =>
    request<{ dotId: string; items: import("@space/contracts").DotDeliverable[] }>(`/api/dots/${encodeURIComponent(dotId)}/deliverables`),
  publishDotDeliverable: (dotId: string, input: { path: string; roomId: string }) =>
    request<{ deliverable: import("@space/contracts").DotDeliverable; unchanged: boolean }>(`/api/dots/${encodeURIComponent(dotId)}/deliverables`,
      { method: "POST", body: JSON.stringify(input) }),
  dotComputer: (dotId: string) => request<import("@space/contracts").DotComputer>(`/api/dots/${encodeURIComponent(dotId)}/computer`),
  stopDotComputer: (dotId: string, sessionId?: string | null) =>
    request<import("@space/contracts").DotComputerStopResult>(`/api/dots/${encodeURIComponent(dotId)}/computer/stop`,
      { method: "POST", body: JSON.stringify(sessionId ? { sessionId } : {}) }),
  dotEvalRuns: (dotId: string) => request<{ runs: import("@space/contracts").DotEvalRunSummary[] }>(`/api/dots/${encodeURIComponent(dotId)}/evals`),
  startDotEval: (dotId: string, input: { dataset: "dots-v1"; split: "tuning" | "holdout" | "all"; roomId: string; modelConfigId?: string }) =>
    request<{ evalRunId: string; paneId: string; cases: number; skipped: number }>(`/api/dots/${encodeURIComponent(dotId)}/evals`,
      { method: "POST", body: JSON.stringify(input) }),
  dotEvalReport: (dotId: string, evalRunId: string) =>
    request<import("@space/contracts").DotEvalReport>(`/api/dots/${encodeURIComponent(dotId)}/evals/${encodeURIComponent(evalRunId)}`),
  stopDotEval: (dotId: string, evalRunId: string) =>
    request<{ stopped: boolean }>(`/api/dots/${encodeURIComponent(dotId)}/evals/${encodeURIComponent(evalRunId)}/stop`, { method: "POST", body: "{}" }),
  dotToolInvocations: (dotId: string) =>
    request<{ dotId: string; items: import("@space/contracts").DotToolInvocation[]; limit: number; offset: number }>(
      `/api/dots/${encodeURIComponent(dotId)}/tool-invocations?limit=20`),
  createAgentSession: (
    paneId: string,
    input: {
      dotId?: string;
      title?: string;
      sessionId?: string | null;
      threadId?: string | null;
      selectedModelConfigId?: string | null;
      selectedToolIds?: string[] | null;
    } = {}
  ) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent-session`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  sendAgentMessage: (paneId: string, content: string, selectedModelConfigId?: string | null, selectedToolIds?: string[], artifactIds?: string[], clientRequestId?: string, acceptance?: import("@space/contracts").TaskAcceptance, context?: { sessionId?: string; dotId?: string }) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        ...context,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(selectedModelConfigId ? { selectedModelConfigId } : {}),
        ...(selectedToolIds ? { selectedToolIds } : {}),
        ...(artifactIds?.length ? { artifactIds } : {})
      })
    }),
  prepareAgentRetry: (paneId: string) => request<{ content: string; artifacts: Artifact[]; acceptance?: import("@space/contracts").TaskAcceptance }>(
    `/api/panes/${encodeURIComponent(paneId)}/agent/prepare-retry`, { method: "POST", body: "{}" }
  ),
  interruptAgent: (paneId: string) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/interrupt`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  updateAgentSettings: (
    paneId: string,
    input: {
      title?: string;
      selectedModelConfigId?: string | null;
      selectedToolIds?: string[] | null;
      permissionMode?: PermissionMode | null;
      collaborationMode?: CollaborationMode;
      fullAccessConfirmed?: boolean;
    }
  ) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/settings`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  updateAgentGoal: (paneId: string, objective: string) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/goal`, {
      method: "PUT",
      body: JSON.stringify({ objective })
    }),
  clearAgentGoal: (paneId: string) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/goal`, {
      method: "DELETE"
    }),
  cliRuntimes: (options?: { allowStale?: boolean }) => loadCliRuntimes(options),
  cliRuntimesSnapshot,
  warmCliRuntimes,
  invalidateCliRuntimes,
  cliRuntimeSettings: (options?: { forceRefresh?: boolean }) => loadCliRuntimeSettings(options),
  cliRuntimeSettingsSnapshot,
  warmCliRuntimeSettings,
  invalidateCliRuntimeSettings,
  resetCliRuntimeSettingsCache,
  cliProviderSettings: () => request<CliProviderSettingsResponse>("/api/cli/providers"),
  updateCliProviderSetting: (providerId: string, enabled: boolean) =>
    request<CliProviderSettingsResponse>(`/api/cli/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    }),
  updateAllCliProviders: (enabled: boolean) =>
    request<CliProviderSettingsResponse>("/api/cli/providers/toggle-all", {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  cliRuntimeRestart: async (runtimeId: string) => {
    const result = await request<CliRuntimeRestartSessionsResult>(`/api/admin/cli/runtime/${encodeURIComponent(runtimeId)}/restart`, {
      method: "POST"
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  cliRuntimeRestartAll: async () => {
    const result = await request<CliRuntimeRestartAllResult>("/api/admin/cli/runtime/restart-all", {
      method: "POST"
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  restartHarness: async () => {
    const result = await request<HarnessMaintenanceRestartResult>("/api/admin/harness/restart", { method: "POST" });
    invalidateCliRuntimeSettings();
    return result;
  },
  updateHarnessEnabled: async (input: UpdateHarnessEnabledInput) => {
    const result = await request<UpdateHarnessEnabledResult>("/api/admin/harness/enabled", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  listCliAccountProfiles: (runtimeId: string, options: { forceRefresh?: boolean } = {}) =>
    fetchCliAccountProfiles.load(runtimeId, options.forceRefresh),
  createCliAccountProfile: async (input: CreateCliAccountProfileInput) => {
    const result = await request<CreateCliAccountProfileResponse>(
      `/api/cli/runtimes/${encodeURIComponent(input.runtimeId)}/account-profiles`,
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    );
    invalidateCliRuntimeSettings();
    fetchCliAccountProfiles.invalidate(input.runtimeId);
    return result;
  },
  updateCliAccountProfile: async (runtimeId: string, profileId: string, input: UpdateCliAccountProfileInput) => {
    const result = await request<UpdateCliAccountProfileResponse>(
      `/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles/${encodeURIComponent(profileId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    );
    invalidateCliRuntimeSettings();
    fetchCliAccountProfiles.invalidate(runtimeId);
    return result;
  },
  cliAccountIdentities: (refresh = false) =>
    request<CliAccountIdentitiesResponse>(`/api/cli/account-identities${refresh ? "?refresh=1" : ""}`),
  cliAccountBalance: (runtimeId: string) =>
    request<import("@space/contracts").CliAccountBalance>(`/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-balance`),
  getCliAccountProfileDetails: (runtimeId: string, profileId: string) =>
    request<CliAccountProfileDetailsResponse>(
      `/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles/${encodeURIComponent(profileId)}/details`
    ),
  removeCliAccountProfile: async (runtimeId: string, profileId: string) => {
    const result = await request<RemoveCliAccountProfileResponse>(
      `/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles/${encodeURIComponent(profileId)}`,
      { method: "DELETE" }
    );
    invalidateCliRuntimeSettings();
    fetchCliAccountProfiles.invalidate(runtimeId);
    return result;
  },
  modelCapabilities: () => request<{ profiles: import("@space/contracts").ModelCapabilityProfileV1[]; state: import("@space/contracts").ToolRoutingStateV1 }>("/api/model-capabilities"),
  effectiveToolRouting: (runtimeId: string, modelId: string) => request<import("@space/contracts").EffectiveToolPlanV1>(
    "/api/agent-tools/effective?" + new URLSearchParams({ runtimeId, modelId })),
  saveToolRouting: (input: { expectedRevision: number; enabledRuntimeIds: string[]; overrides: import("@space/contracts").ToolRoutingOverride[] }) =>
    request<import("@space/contracts").ToolRoutingStateV1>("/api/agent-tools/policies", { method: "PUT", body: JSON.stringify(input) }),
  agentToolsCatalog: () => request<AgentToolsCatalogResponse>("/api/agent-tools/catalog"),
  agentToolsUsage: () => request<import("./features/agent-tools/agent-tools-usage.js").AgentToolsUsage>("/api/agent-tools/usage"),
  updateAgentToolAssignment: (toolId: string, input: UpdateAgentToolAssignmentInput) =>
    request<AgentToolAssignment>(`/api/agent-tools/assignments/${encodeURIComponent(toolId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  deleteAgentToolAssignment: (toolId: string) =>
    request<{ toolId: string; deleted: true }>(`/api/agent-tools/assignments/${encodeURIComponent(toolId)}`, {
      method: "DELETE"
    }),
  applyAgentTools: (assignments: ApplyAgentToolsInput["assignments"]) =>
    request<ApplyAgentToolsResult>("/api/agent-tools/apply", {
      method: "POST",
      body: JSON.stringify({ assignments })
    }),
  agentToolLaunchTask: (input: AgentToolLaunchTaskInput) =>
    request<AgentToolLaunchTaskResponse>("/api/agent-tools/launch", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  cliGlobalEgress: () => request<CliGlobalEgressStatus>("/api/cli/egress"),
  updateCliGlobalEgress: async (routeId: CliEgressRouteId) => {
    const result = await request<UpdateCliGlobalEgressResult>("/api/cli/egress/route", {
      method: "PUT",
      body: JSON.stringify({ routeId })
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  replaceCliEgressProfile: async (profileId: CliVpnProfileId, config: string) => {
    const result = await request<CliVpnConnection>(`/api/cli/egress/profiles/${encodeURIComponent(profileId)}`, {
      method: "PUT",
      body: JSON.stringify({ config })
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  verifyCliEgressProfile: async (profileId: CliVpnProfileId) => {
    const result = await request<CliVpnConnection>(`/api/cli/egress/profiles/${encodeURIComponent(profileId)}/verify`, {
      method: "POST",
      body: JSON.stringify({})
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  removeCliEgressProfile: async (profileId: CliVpnProfileId) => {
    const result = await request<CliVpnConnection>(`/api/cli/egress/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
    invalidateCliRuntimeSettings();
    return result;
  },
  rotateCliMullvadCity: async () => {
    const result = await request<CliVpnConnection>("/api/cli/egress/profiles/mullvad/random-city", { method: "POST", body: JSON.stringify({}) });
    invalidateCliRuntimeSettings();
    return result;
  },
  rotateCliNordCity: async () => {
    const result = await request<CliVpnConnection>("/api/cli/egress/profiles/nord/random-city", { method: "POST", body: JSON.stringify({}) });
    invalidateCliRuntimeSettings();
    return result;
  },
  cliVpnRoutingStatus: () => request<CliVpnRoutingStatus>("/api/cli/vpn/routing-status"),
  cliVpnStatus: () => request<CliVpnConnection>("/api/cli/vpn"),
  replaceCliVpnProfile: async (config: string) => {
    const result = await request<CliVpnConnection>("/api/cli/vpn/profile", {
      method: "PUT",
      body: JSON.stringify({ config })
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  verifyCliVpnProfile: async () => {
    const result = await request<CliVpnConnection>("/api/cli/vpn/verify", {
      method: "POST",
      body: JSON.stringify({})
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  removeCliVpnProfile: async () => {
    const result = await request<CliVpnConnection>("/api/cli/vpn/profile", { method: "DELETE" });
    invalidateCliRuntimeSettings();
    return result;
  },
  appDiagnosticsStatus: () => request<AppDiagnosticsStatus>("/api/app-diagnostics"),
  deployQueue: () => request<DeployQueueReport>("/api/admin/deploy-queue", { cache: "no-store" }),
  releases: () => request<ReleasesReport>("/api/admin/releases", { cache: "no-store" }),
  promoteRelease: () => request<ReleaseActionResponse>("/api/admin/releases/promote", { method: "POST" }),
  approveHotfix: (ticketId: string) =>
    request<ReleaseActionResponse>(`/api/admin/releases/hotfixes/${encodeURIComponent(ticketId)}/approve`, { method: "POST" }),
  updateAppDiagnosticsStatus: (isEnabled: boolean) =>
    request<AppDiagnosticsStatus>("/api/admin/app-diagnostics", {
      method: "PATCH",
      body: JSON.stringify({ isEnabled })
    }),
  activityLog: (query?: {
    roomId?: string;
    action?: string;
    actorUserId?: string;
    hasReason?: boolean;
    page?: number;
    pageSize?: number;
  }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    if (query?.action) params.set("action", query.action);
    if (query?.actorUserId) params.set("actorUserId", query.actorUserId);
    if (query?.hasReason !== undefined) params.set("hasReason", String(query.hasReason));
    if (query?.page) params.set("page", String(query.page));
    if (query?.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<ActivityLogEvent>>(`/api/activity-log${suffix ? `?${suffix}` : ""}`);
  },
  activityLogSettings: () => request<ActivityLogSettings>("/api/activity-log/settings"),
  updateActivityLogSettings: (enabled: boolean) =>
    request<ActivityLogSettings>("/api/admin/activity-log/settings", {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    }),
  acquireAppDiagnosticsVideoLease: (input: { clientId: string; pageClientId: string }) =>
    request<AppDiagnosticsVideoLease>("/api/admin/app-diagnostics/video-leases", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  heartbeatAppDiagnosticsVideoLease: (leaseId: string, captureId: string) =>
    request<AppDiagnosticsVideoLease>(
      `/api/admin/app-diagnostics/video-leases/${encodeURIComponent(leaseId)}/heartbeats`,
      {
        method: "POST",
        body: JSON.stringify({ captureId })
      }
    ),
  releaseAppDiagnosticsVideoLease: (leaseId: string) =>
    request<AppDiagnosticsVideoLease>(
      `/api/admin/app-diagnostics/video-leases/${encodeURIComponent(leaseId)}`,
      { method: "DELETE" }
    ),
  uploadAppDiagnosticsVideoSegment: (
    input: {
      leaseId: string;
      sequence: number;
      startedAt: string;
      endedAt: string;
      firstEventSequence: number;
      lastEventSequence: number;
      mimeType: string;
    },
    bytes: Uint8Array
  ) => {
    const query = new URLSearchParams({
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      firstEventSequence: String(input.firstEventSequence),
      lastEventSequence: String(input.lastEventSequence)
    });
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return request<AppDiagnosticsSegmentMetadata>(
      `/api/admin/app-diagnostics/video-segments/${encodeURIComponent(input.leaseId)}/${input.sequence}?${query}`,
      {
        method: "POST",
        headers: { "Content-Type": "video/webm" },
        body
      }
    );
  },
  appDiagnosticsSegments: (query: AppDiagnosticsSegmentListQuery = { page: 1, pageSize: 25 }) => {
    const params = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
      ...(query.captureId ? { captureId: query.captureId } : {}),
      ...(query.kind ? { kind: query.kind } : {})
    });
    return request<{
      data: AppDiagnosticsSegmentMetadata[];
      pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
    }>(`/api/admin/app-diagnostics/segments?${params}`);
  },
  cliRuntimeDisablePreview: (runtimeId: string) =>
    request<CliRuntimeDisablePreview>(
      `/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}/disable-preview`,
      { method: "POST", body: JSON.stringify({}) }
    ),
  updateCliRuntimeSetting: async (runtimeId: string, input: UpdateCliRuntimeSettingInput) => {
    const result = await request<UpdateCliRuntimeSettingResult>(
      `/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    );
    invalidateCliRuntimes({ runtimeId, enabled: result.setting.enabled });
    invalidateCliRuntimeSettings();
    return result;
  },
  updateCliRuntimeVpn: async (runtimeId: string, input: UpdateCliRuntimeVpnInput) => {
    const result = await request<UpdateCliRuntimeVpnResult>(
      `/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}/vpn`,
      { method: "PATCH", body: JSON.stringify(input) }
    );
    invalidateCliRuntimeSettings();
    return result;
  },
  updateHarnessVpn: async (input: UpdateCliRuntimeVpnInput) => {
    const result = await request<UpdateHarnessVpnResult>("/api/admin/harness/vpn", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
    invalidateCliRuntimeSettings();
    return result;
  },
  restartCliRuntimeVpnSessions: async (runtimeId: string) => {
    const result = await request<RestartCliRuntimeVpnSessionsResult>(
      `/api/cli/runtime-settings/${encodeURIComponent(runtimeId)}/vpn/restart-required`,
      { method: "POST", body: JSON.stringify({}) }
    );
    invalidateCliRuntimeSettings();
    return result;
  },
  cliLogin: async (roomId: string, runtimeId: string) => {
    const result = await request<CliLoginResponse>(`/api/rooms/${encodeURIComponent(roomId)}/cli-login`, {
      method: "POST",
      body: JSON.stringify({ runtimeId })
    });
    invalidateCliRuntimes();
    invalidateCliRuntimeSettings();
    return result;
  },
  reportCliClientEvent: (input: CliTerminalClientEventInput) =>
    request<CliTerminalClientEventResponse>("/api/cli/client-events", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  activeCliSession: (
    paneId: string,
    options: { includeTranscript?: boolean; compactTranscript?: boolean } = {}
  ) => loadActiveCliSession(paneId, options),
  clearActiveCliSessionFlight: (paneId: string) => clearActiveCliSessionFlight(paneId),
  cliModelSettings: (paneId: string) =>
    request<PaneCliModelSettings>(`/api/panes/${encodeURIComponent(paneId)}/cli/model-settings`),
  cliModelSettingsStatus: (paneId: string) =>
    requestWithTimeout<PaneCliModelSettingsStatus>(
      `/api/panes/${encodeURIComponent(paneId)}/cli/model-settings/status`,
      8_000,
      "CLI model settings status request timed out."
    ),
  setCliTerminalControlLease: (paneId: string, leaseId: string | null) => {
    if (leaseId) cliTerminalControlLeaseByPane.set(paneId, leaseId);
    else cliTerminalControlLeaseByPane.delete(paneId);
  },
  updateCliModelSettings: (
    paneId: string,
    input: {
      expectedSessionId: string;
      modelId: string;
      reasoningEffort: string;
      continueActiveTurn?: boolean;
    }
  ) =>
    request<UpdatePaneCliModelSettingsResult>(`/api/panes/${encodeURIComponent(paneId)}/cli/model-settings`, {
      method: "PATCH",
      headers: cliTerminalControlHeaders(paneId),
      body: JSON.stringify(input)
    }),
  cliTurnActivity: (paneId: string, marker: string) =>
    request<PaneCliTurnActivityResponse>(
      `/api/panes/${encodeURIComponent(paneId)}/cli/turn-activity?marker=${encodeURIComponent(marker)}`
    ),
  paneWorkingTime: (paneId: string) =>
    request<{ paneId: string; cumulativeWorkingMs: number; isWorking: boolean; state: string }>(
      `/api/panes/${encodeURIComponent(paneId)}/working-time`
    ),
  createCliSession: (
    paneId: string,
    input: {
      runtimeId: string;
      accountProfileId?: string | null;
      modelId?: string | null;
      reasoningEffort?: Pane["reasoningEffort"];
      cwd?: string | null;
      forceRestart?: boolean;
      resume?: boolean;
      includeTranscript?: boolean;
    }
  ) =>
    request<PaneCliSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/cli/session`, {
      method: "POST",
      headers: cliTerminalControlHeaders(paneId),
      body: JSON.stringify(input)
    }),
  resumeCliSession: (paneId: string, input: { taskId: string } | { threadId: string }) =>
    request<ResumePaneCliSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/cli/resume`, {
      method: "POST",
      headers: cliTerminalControlHeaders(paneId),
      body: JSON.stringify(input)
    }),
  interruptCliSession: (paneId: string, reason?: string) =>
    request<PaneCliSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/cli/interrupt`, {
      method: "POST",
      headers: cliTerminalControlHeaders(paneId),
      body: JSON.stringify(reason ? { reason } : {})
    }),
  abortCliTurn: (paneId: string) =>
    request<{ ok: true; isTurnActive: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/cli/turn-abort`, {
      method: "POST",
      headers: cliTerminalControlHeaders(paneId)
    }),
  submitLocalCliDraft: (paneId: string, input: { submissionId: string; expectedSessionId: string; text: string; imagePaths?: string[]; imageOffsets?: number[] }) =>
    request<{ submissionId: string; sessionId: string; status: "SENT" | "UNCERTAIN" | "REJECTED"; reason?: string }>(`/api/panes/${encodeURIComponent(paneId)}/cli/local-composer/submissions`, {
      method: "POST", headers: cliTerminalControlHeaders(paneId), body: JSON.stringify(input)
    }),
  localCliSubmission: (paneId: string, submissionId: string) =>
    request<{ submissionId: string; sessionId: string | null; status: "SENT" | "UNCERTAIN" | "REJECTED" | "NOT_FOUND"; reason?: string }>(`/api/panes/${encodeURIComponent(paneId)}/cli/local-composer/submissions/${encodeURIComponent(submissionId)}`),
  uploadCliFiles: (input: { paneId: string; source: PaneCliUploadSource; files: File[] }) => {
    const params = new URLSearchParams({ source: input.source });
    const form = new FormData();
    input.files.forEach((file) => form.append("file", file, file.name || "upload"));
    return request<PaneCliUploadResponse>(`/api/panes/${encodeURIComponent(input.paneId)}/cli/uploads?${params.toString()}`, {
      method: "POST",
      headers: cliTerminalControlHeaders(input.paneId),
      body: form
    });
  },
  reportCliClipboardDebug: ({ paneId, ...input }: CliClipboardDebugReportInput) =>
    request<{ ok: true; requestId: string }>(`/api/panes/${encodeURIComponent(paneId)}/cli/clipboard-debug`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  cliTerminalWebSocketUrl: (
    ticket: PaneCliWebSocketToken,
    options: {
      clientMode?: "INTERACTIVE" | "OBSERVER";
      leaseId?: string | null;
      initialCols?: number;
      initialRows?: number;
    } = {}
  ) => {
    const params = new URLSearchParams({
      sessionId: ticket.sessionId,
      token: ticket.token
    });
    const hasInitialCols = options.initialCols !== undefined;
    const hasInitialRows = options.initialRows !== undefined;
    if (hasInitialCols !== hasInitialRows) {
      throw new RangeError("Initial terminal columns and rows must be provided together.");
    }
    if (hasInitialCols && hasInitialRows) {
      if (
        !Number.isInteger(options.initialCols) ||
        options.initialCols! < 2 ||
        options.initialCols! > 400 ||
        !Number.isInteger(options.initialRows) ||
        options.initialRows! < 2 ||
        options.initialRows! > 200
      ) {
        throw new RangeError("Initial terminal geometry is outside the supported bounds.");
      }
      params.set("initialCols", String(options.initialCols));
      params.set("initialRows", String(options.initialRows));
    }
    if (typeof window === "undefined") {
      return `/api/panes/${encodeURIComponent(ticket.paneId)}/cli/terminal?${params.toString()}`;
    }
    params.set("protocolVersion", "2");
    params.set("browserClientId", cliTerminalBrowserClientId());
    params.set("tabLineageId", cliTerminalTabLineageId());
    params.set("pageClientId", cliTerminalPageClientId());
    params.set("clientMode", options.clientMode ?? "INTERACTIVE");
    if (options.leaseId) params.set("leaseId", options.leaseId);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/panes/${encodeURIComponent(ticket.paneId)}/cli/terminal?${params.toString()}`;
  },
  browserStatus: () => request<BrowserStatusPayload>("/api/browser/status"),
  youtubeAccounts: (paneId: string) => request<YouTubeAccounts>(`/api/panes/${encodeURIComponent(paneId)}/youtube/accounts`),
  browserAccounts: (paneId: string) => request<YouTubeAccounts>(`/api/panes/${encodeURIComponent(paneId)}/browser/accounts`),
  selectBrowserAccount: (paneId: string, profileId: string | null, options: { signIn?: boolean } = {}) =>
    request<YouTubeAccountSelection>(`/api/panes/${encodeURIComponent(paneId)}/browser/accounts`, { method: "PUT", body: JSON.stringify(options.signIn ? { profileId, signIn: true } : { profileId }) }),
  selectYouTubeAccount: (paneId: string, profileId: string | null, options: { signIn?: boolean } = {}) =>
    request<YouTubeAccountSelection>(`/api/panes/${encodeURIComponent(paneId)}/youtube/accounts`, { method: "PUT", body: JSON.stringify(options.signIn ? { profileId, signIn: true } : { profileId }) }),
  youtubePlayback: (paneId: string) => request<{ playback: YouTubePlayback | null }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/playback`),
  saveYouTubePlayback: (paneId: string, playback: YouTubePlayback) =>
    request<{ ok: true }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/playback`, { method: "PUT", body: JSON.stringify(playback), keepalive: true }),
  watchYouTube: (paneId: string) => request<{ currentUrl: string | null }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/watch`, { method: "POST", body: "{}" }),
  youtubeVideoText: (paneId: string, videoId: string, kind: "summary" | "transcript") =>
    request<{ text: string; model: string }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/summary`, { method: "POST", body: JSON.stringify({ videoId, kind }) }),
  /** The YouTube pane's Download: the video at full resolution into the Video library; `rightsConfirmed` is the operator's click. */
  youtubeDownload: (paneId: string, videoId: string, title: string) =>
    request<{ job: VideoJob }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/download`, { method: "POST", body: JSON.stringify({ videoId, title: title.slice(0, 200), rightsConfirmed: true }) }),
  /** The download's job; the server answers when it ends or after 20 s. */
  youtubeDownloadJob: (paneId: string, jobId: string) =>
    request<{ job: VideoJob }>(`/api/panes/${encodeURIComponent(paneId)}/youtube/download/${encodeURIComponent(jobId)}`, { cache: "no-store" }),
  browserSession: (paneId: string) => request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/session`),
  startBrowserSession: (
    paneId: string,
    input: { viewport?: BrowserSessionViewport; targetUrl?: string | null; ownerAgentId?: string | null; streamMode?: BrowserStreamMode; includeInitialFrame?: boolean } = {}
  ) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/session`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateBrowserSession: (paneId: string, input: { viewport?: BrowserSessionViewport; targetUrl?: string; streamMode?: BrowserStreamMode }) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/session`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  navigateBrowser: (paneId: string, url: string) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/navigate`, {
      method: "POST",
      body: JSON.stringify({ url })
    }),
  setBrowserViewport: (paneId: string, viewport: BrowserSessionViewport, dimensions?: { width: number; height: number }) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/viewport`, {
      method: "POST",
      body: JSON.stringify({ viewport, dimensions })
    }),
  browserAction: (
    paneId: string,
    input:
      | { type: "screenshot" | "extract_text"; sessionId?: string }
      | { type: "click"; x: number; y: number; sessionId?: string }
      | { type: "type"; text: string; sessionId?: string }
      | { type: "scroll"; deltaX?: number; deltaY: number; sessionId?: string }
      | { type: "navigate"; url: string; sessionId?: string }
      | { type: "set_viewport"; viewport: BrowserSessionViewport; sessionId?: string }
      | { type: "diagnostics"; includeNetwork?: boolean; limit?: number; sessionId?: string }
      | { type: "record"; durationMs?: number; intervalMs?: number; format?: "frames" | "gif" | "webm" | "both"; sessionId?: string }
  ) =>
    request<BrowserToolActionResult>(`/api/panes/${encodeURIComponent(paneId)}/browser/action`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  browserFrame: (paneId: string, sessionId: string) => {
    const params = new URLSearchParams({ sessionId });
    return request<BrowserFrame>(`/api/panes/${encodeURIComponent(paneId)}/browser/frame?${params.toString()}`);
  },
  browserBookmarks: (paneId: string) => request<BrowserBookmarkListResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/bookmarks`),
  addBrowserBookmark: (paneId: string, input: { title?: string; url?: string } = {}) =>
    request<BrowserBookmarkListResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/bookmarks`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  openBrowserBookmark: (paneId: string, bookmarkId: string) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/bookmarks/open`, {
      method: "POST",
      body: JSON.stringify({ bookmarkId })
    }),
  importBrowserBookmarks: (paneId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name || "Bookmarks");
    return request<BrowserBookmarkImportResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/bookmarks/import`, {
      method: "POST",
      body: form
    });
  },
  browserBookmarksExportUrl: (paneId: string) => `/api/panes/${encodeURIComponent(paneId)}/browser/bookmarks/export`,
  stopBrowserSession: (paneId: string) =>
    request<{ ok: true; paneId: string }>(`/api/panes/${encodeURIComponent(paneId)}/browser/stop`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  browserFrameWebSocketUrl: (ticket: BrowserFrameToken) => {
    const params = new URLSearchParams({
      sessionId: ticket.sessionId,
      token: ticket.token
    });
    if (typeof window === "undefined") {
      return `/api/panes/${encodeURIComponent(ticket.paneId)}/browser/frames?${params.toString()}`;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/panes/${encodeURIComponent(ticket.paneId)}/browser/frames?${params.toString()}`;
  },
  browserStreamWebSocketUrl: (ticket: BrowserFrameToken, mode: BrowserStreamMode = "AUTO") => {
    const params = new URLSearchParams({ sessionId: ticket.sessionId, token: ticket.token, mode, frameAck: "1" });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (!window.location.host) {
      return `/api/panes/${encodeURIComponent(ticket.paneId)}/browser/stream?${params.toString()}`;
    }
    return `${protocol}//${window.location.host}/api/panes/${encodeURIComponent(ticket.paneId)}/browser/stream?${params.toString()}`;
  },
  browserStreamTicket: (paneId: string) =>
    request<BrowserStreamTicketResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/stream-ticket`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  browserAudioWebSocketUrl: (ticket: BrowserFrameToken) => {
    const params = new URLSearchParams({ sessionId: ticket.sessionId, token: ticket.token });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (!window.location.host) {
      return `/api/panes/${encodeURIComponent(ticket.paneId)}/browser/audio?${params.toString()}`;
    }
    return `${protocol}//${window.location.host}/api/panes/${encodeURIComponent(ticket.paneId)}/browser/audio?${params.toString()}`;
  },
  browserAudioStreamTicket: (paneId: string) =>
    request<BrowserStreamTicketResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/audio-ticket`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  vncPresets: () => request<VncPresetListResponse>("/api/vnc-presets"),
  vncStreamWebSocketUrl: (paneId: string, host: string, port: number) => {
    const params = new URLSearchParams({ host, port: String(port) });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    if (!window.location.host) {
      return `/api/panes/${encodeURIComponent(paneId)}/vnc/stream?${params.toString()}`;
    }
    return `${protocol}//${window.location.host}/api/panes/${encodeURIComponent(paneId)}/vnc/stream?${params.toString()}`;
  },
  browserPages: (paneId: string) =>
    request<BrowserPageListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/pages`),
  createBrowserPage: (paneId: string, input: CreateBrowserPageInput = { activate: true }) =>
    request<BrowserPageListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/pages`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  activateBrowserPage: (paneId: string, pageId: string) =>
    request<BrowserPageListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/pages/${encodeURIComponent(pageId)}/activate`, {
      method: "POST"
    }),
  closeBrowserPage: (paneId: string, pageId: string) =>
    request<BrowserPageListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/pages/${encodeURIComponent(pageId)}/close`, {
      method: "POST"
    }),
  setBrowserPageAccount: (paneId: string, pageId: string, profileId: string | null, options: { signIn?: boolean } = {}) =>
    request<BrowserPageListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/pages/${encodeURIComponent(pageId)}/account`, {
      method: "POST",
      body: JSON.stringify(options.signIn ? { profileId, signIn: true } : { profileId })
    }),
  acquireBrowserControl: (paneId: string, input: AcquireBrowserControlInput) =>
    request<BrowserControlPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/control/acquire`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  heartbeatBrowserControl: (paneId: string, input: BrowserControlLeaseActionInput) =>
    request<BrowserControlPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/control/heartbeat`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  releaseBrowserControl: (paneId: string, input: BrowserControlLeaseActionInput) =>
    request<BrowserControlPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/control/release`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  browserHandoff: (paneId: string) =>
    request<BrowserHandoffRequestResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/handoff`),
  createBrowserCapture: (paneId: string, input: CreateBrowserCaptureJobRequest) =>
    request<BrowserCaptureJobResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  browserCapture: (paneId: string, jobId: string) =>
    request<BrowserCaptureJobResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures/${encodeURIComponent(jobId)}`),
  browserCaptureSegments: (paneId: string, jobId: string) =>
    request<BrowserCaptureSegmentListPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures/${encodeURIComponent(jobId)}/segments`),
  browserCaptureTimeline: (paneId: string, jobId: string) =>
    request<BrowserCaptureTimelinePayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures/${encodeURIComponent(jobId)}/timeline`),
  stopBrowserCapture: (paneId: string, jobId: string) =>
    request<BrowserCaptureJobResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures/${encodeURIComponent(jobId)}/stop`, {
      method: "POST"
    }),
  cancelBrowserCapture: (paneId: string, jobId: string) =>
    request<BrowserCaptureJobResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/captures/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    }),
  browserDiagnostics: (paneId: string, input: { includeNetwork?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    params.set("includeNetwork", String(input.includeNetwork ?? true));
    params.set("limit", String(input.limit ?? 100));
    return request<BrowserDiagnosticsPayload>(`/api/panes/${encodeURIComponent(paneId)}/browser/diagnostics?${params.toString()}`);
  },
  browserInput: (paneId: string, input: BrowserInputPayload) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/input`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  turns: (query?: { roomId?: string }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    const suffix = params.toString();
    return singleFlightRequest(`turns:${suffix}`, () =>
      request<Paginated<Turn>>(`/api/turns${suffix ? `?${suffix}` : ""}`)
    );
  },
  events: (query?: { roomId?: string; page?: number; pageSize?: number; sortOrder?: "asc" | "desc" }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    if (query?.page) params.set("page", String(query.page));
    if (query?.pageSize) params.set("pageSize", String(query.pageSize));
    if (query?.sortOrder) params.set("sortOrder", query.sortOrder);
    const suffix = params.toString();
    return singleFlightRequest(`events:${suffix}`, () =>
      request<Paginated<Event>>(`/api/events${suffix ? `?${suffix}` : ""}`)
    );
  },
  audit: (query?: { page?: number; pageSize?: number }) => {
    const params = new URLSearchParams();
    if (query?.page) params.set("page", String(query.page));
    if (query?.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<AuditEvent>>(`/api/admin/audit${suffix ? `?${suffix}` : ""}`);
  },
  createTurn: (input: { roomId: string; paneId: string; prompt: string; runtime?: TurnRuntime; artifactIds?: string[] }) =>
    request<TurnStartResult>("/api/turns", {
      method: "POST",
      body: JSON.stringify({
        roomId: input.roomId,
        paneId: input.paneId,
        prompt: input.prompt,
        artifactIds: input.artifactIds ?? [],
        runtime: input.runtime ?? "DUMMY_TEMPORAL"
      })
    }),
  memory: (query?: { roomId?: string; q?: string; scope?: MemoryEntry["scope"]; searchMode?: MemorySearchMode }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    if (query?.q) params.set("q", query.q);
    if (query?.scope) params.set("scope", query.scope);
    if (query?.searchMode && query.searchMode !== "keyword") params.set("searchMode", query.searchMode);
    const suffix = params.toString();
    return request<MemoryPayload>(`/api/memory${suffix ? `?${suffix}` : ""}`);
  },
  createMemory: (input: {
    scope: MemoryEntry["scope"];
    roomId?: string | null;
    title: string;
    body: string;
    provenance: string;
  }) =>
    request<MemoryEntry>("/api/memory", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  memoryGraph: (query: {
    q?: string;
    nodeType?: MemoryGraphNodeType;
    scope?: MemoryEntry["scope"];
    roomId?: string;
    sourcePath?: string;
    lifecycleStatus?: MemoryLifecycleStatus;
    month?: string;
    relationMode?: "CLUSTERED" | "RELATIONS";
    page?: number;
    pageSize?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.nodeType) params.set("nodeType", query.nodeType);
    if (query.scope) params.set("scope", query.scope);
    if (query.roomId) params.set("roomId", query.roomId);
    if (query.sourcePath) params.set("sourcePath", query.sourcePath);
    if (query.lifecycleStatus) params.set("lifecycleStatus", query.lifecycleStatus);
    if (query.month) params.set("month", query.month);
    if (query.relationMode) params.set("relationMode", query.relationMode);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<MemoryGraphResponse>(`/api/admin/memory/graph${suffix ? `?${suffix}` : ""}`);
  },
  memoryGraphOverview: (query: {
    q?: string;
    nodeType?: MemoryGraphNodeType;
    scope?: MemoryEntry["scope"];
    roomId?: string;
    sourcePath?: string;
    lifecycleStatus?: MemoryLifecycleStatus;
    month?: string;
    relationMode?: "CLUSTERED" | "RELATIONS";
  } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.nodeType) params.set("nodeType", query.nodeType);
    if (query.scope) params.set("scope", query.scope);
    if (query.roomId) params.set("roomId", query.roomId);
    if (query.sourcePath) params.set("sourcePath", query.sourcePath);
    if (query.lifecycleStatus) params.set("lifecycleStatus", query.lifecycleStatus);
    if (query.month) params.set("month", query.month);
    if (query.relationMode) params.set("relationMode", query.relationMode);
    const suffix = params.toString();
    return request<MemoryGraphOverviewResponse>(`/api/admin/memory/graph/overview${suffix ? `?${suffix}` : ""}`);
  },
  memoryCalendar: (query: MemoryCalendarQuery = {}) => {
    const params = new URLSearchParams();
    if (query.year) params.set("year", String(query.year));
    if (query.month) params.set("month", query.month);
    if (query.date) params.set("date", query.date);
    const suffix = params.toString();
    return request<MemoryCalendarResponseEnvelope>(`/api/admin/memory/calendar${suffix ? `?${suffix}` : ""}`);
  },
  memoryGraphNode: (nodeId: string) =>
    request<MemoryGraphNodeDetail>(`/api/admin/memory/nodes/${encodeURIComponent(nodeId)}`),
  createMemoryNodeChangeSet: (nodeId: string, input: CreateMemoryNodeChangeSetInput, idempotencyKey: string) =>
    request<MemoryChangeSetSummary>(`/api/admin/memory/nodes/${encodeURIComponent(nodeId)}/change-sets`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  memoryGraphIssues: (query: {
    type?: MemoryIssueType;
    severity?: MemoryIssueSeverity;
    status?: MemoryIssueStatus;
    recordId?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.severity) params.set("severity", query.severity);
    if (query.status) params.set("status", query.status);
    if (query.recordId) params.set("recordId", query.recordId);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<MemoryGraphIssuesResponse>(`/api/admin/memory/issues${suffix ? `?${suffix}` : ""}`);
  },
  updateMemoryGraphIssue: (issueId: string, input: PatchMemoryIssueInput) =>
    request<MemoryGraphIssue>(`/api/admin/memory/issues/${encodeURIComponent(issueId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  createMemoryConsolidation: (input: CreateMemoryConsolidationInput, idempotencyKey: string) =>
    request<MemoryConsolidationCommandResponse>("/api/admin/memory/consolidations", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  memoryConsolidation: (runId: string) =>
    request<MemoryConsolidationDetail>(`/api/admin/memory/consolidations/${encodeURIComponent(runId)}`),
  memoryChangeSets: (query: {
    kind?: MemoryChangeKind;
    status?: MemoryChangeStatus;
    sourcePath?: string;
    recordId?: string;
    issueId?: string;
    rollbackOfChangeSetId?: string;
    page?: number;
    pageSize?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.status) params.set("status", query.status);
    if (query.sourcePath) params.set("sourcePath", query.sourcePath);
    if (query.recordId) params.set("recordId", query.recordId);
    if (query.issueId) params.set("issueId", query.issueId);
    if (query.rollbackOfChangeSetId) params.set("rollbackOfChangeSetId", query.rollbackOfChangeSetId);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<MemoryChangeSetListResponse>(`/api/admin/memory/change-sets${suffix ? `?${suffix}` : ""}`);
  },
  memoryChangeSet: (changeSetId: string) =>
    request<MemoryChangeSet>(`/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`),
  createMemoryChangeSet: (input: CreateMemoryChangeSetRequest, idempotencyKey: string) =>
    request<MemoryChangeSetSummary>("/api/admin/memory/change-sets", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  reviewMemoryChangeSet: (changeSetId: string, input: ReviewMemoryChangeSetRequest) =>
    request<MemoryChangeSetSummary>(`/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  createMemoryRollback: (changeSetId: string, input: CreateMemoryRollbackInput, idempotencyKey: string) =>
    request<MemoryChangeSetSummary>(`/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/rollbacks`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  executeMemoryChangeSet: (changeSetId: string, idempotencyKey: string) =>
    request<MemoryMutationCommandResponse>(`/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/executions`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({})
    }),
  reconcileMemoryChangeSet: (changeSetId: string, idempotencyKey: string) =>
    request<MemoryMutationCommandResponse>(`/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconciliations`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({})
    }),
  createSkill: (input: {
    displayName: string;
    version?: string;
    triggerDescription: string;
    body: string;
    allowedTools: string[];
  }) =>
    request<Skill>("/api/skills", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  imports: () => request<Paginated<ImportCandidate>>("/api/imports"),
  createImportCandidate: (input: {
    sourceKind: ImportSourceKind;
    targetKind: ImportTargetKind;
    sourceRef: string;
    roomId?: string | null;
    memoryScope: MemoryEntry["scope"];
    title: string;
    body: string;
    provenance: string;
    skillVersion?: string;
    skillTriggerDescription?: string;
    allowedTools: string[];
  }) =>
    request<ImportCandidate>("/api/imports", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  decideImportCandidate: (candidateId: string, input: { decision: "IMPORT" | "REJECT"; reason?: string }) =>
    request<ImportCandidateDecisionResult>(`/api/imports/${encodeURIComponent(candidateId)}/decision`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  providers: () => request<Paginated<Provider>>("/api/providers"),
  providerSettings: () => request<ProviderSettings>("/api/provider-settings"),
  updateProviderSettings: (input: UpdateProviderSettingsInput) =>
    request<ProviderSettings>("/api/provider-settings", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  userSettings: () => request<UserSettings>("/api/user-settings"),
  updateUserSettings: (input: UpdateUserSettingsInput) =>
    request<UserSettings>("/api/user-settings", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  createProvider: (input: CreateProviderInput) =>
    request<Provider>("/api/providers", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateProvider: (providerId: string, input: UpdateProviderInput) =>
    request<Provider>(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  voiceTranscriptionSettings: () => request<VoiceTranscriptionSettings>("/api/voice/transcription/settings"),
  openAiModels: () => request<OpenAiModelsResponse>("/api/voice/openai-models"),
  liveAudioProviders: () => request<{ providers: any[] }>("/api/voice/providers"),
  createVoiceRealtimeCall: (input: VoiceRealtimeSessionRequest) =>
    request<VoiceRealtimeSessionResponse>("/api/voice/realtime/calls", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  getLiveHistory: () => request<LiveHistorySnapshot>("/api/live/history"),
  saveLiveHistory: (turns: Array<{ item: PersistedLiveTurn; epoch: number }>, expectedOwnerId: string) => request<{ receipts: Array<{ id: string; sessionId: string; accepted: boolean }> }>("/api/live/history/turns", { method: "POST", body: JSON.stringify({ turns, expectedOwnerId }) }),
  getLiveRoomContext: (roomId: string, signal?: AbortSignal) =>
    request<LiveRoomContext>(`/api/live/context/${encodeURIComponent(roomId)}`, { signal }),
  getLiveRoomActivity: (roomId: string) =>
    request<LiveRoomContext>(`/api/live/context/${encodeURIComponent(roomId)}?fresh=true`),
  triageVoiceIntent: (query: string, roomId?: string, explicitModel?: string) =>
    request<{ available: boolean; degraded?: boolean; reason?: string; route?: string | null; ambiguous?: number | null; model?: string | null; latencyMs?: number; intent?: string; complexity?: string; toolFamily?: string; cacheHit?: boolean }>("/api/voice/realtime/triage", {
      method: "POST", body: JSON.stringify({ query, roomId, explicitModel })
    }),
  getVoiceRealtimePolicy: () =>
    request<{ revision: string; source: "environment" | "empty"; mode: "economy" | "balanced" | "quality"; dailyBudgetUsd: number | null; models: Array<Record<string, unknown>> }>("/api/voice/realtime/policy"),
  localVoiceStatus: () => request<Record<string, unknown>>("/api/voice/local/status"),
  createLocalVoiceSession: (input: { paneId: string; language: string; opening?: string; prompt?: string }) =>
    request<Record<string, unknown>>("/api/voice/local/sessions", {
      method: "POST",
      body: JSON.stringify({ pane_id: input.paneId, user_id: "space-operator", language: input.language, opening: input.opening, prompt: input.prompt })
    }),
  transcribeVoiceAudio: (input: { audio: Blob; filename: string; model: VoiceTranscriptionModel; language: VoiceTranscriptionLanguage }) => {
    const form = new FormData();
    form.append("file", input.audio, input.filename);
    form.append("model", input.model);
    form.append("language", input.language);
    return request<VoiceTranscriptionResponse>("/api/voice/transcriptions", {
      method: "POST",
      body: form
    });
  },
  models: () => request<Paginated<Model>>("/api/models"),
  validateProvider: (providerId: string) =>
    request<ProviderValidationResult>(`/api/providers/${encodeURIComponent(providerId)}/validate`, {
      method: "POST"
    }),
  mcp: () => request<McpPayload>("/api/mcp"),
  latestMcpDiscoverySmoke: () => request<{ data: McpDiscoverySmokeCheck | null }>("/api/admin/mcp/discovery-smoke"),
  runMcpDiscoverySmoke: () =>
    request<McpDiscoverySmokeCheck>("/api/admin/mcp/discovery-smoke", {
      method: "POST"
    }),
  latestMemoryEmbeddingSmoke: () => request<{ data: MemoryEmbeddingSmokeCheck | null }>("/api/admin/memory/embedding-smoke"),
  memoryVectorReadiness: () => request<{ data: MemoryVectorReadiness }>("/api/admin/memory/vector-readiness"),
  runMemoryEmbeddingSmoke: () =>
    request<MemoryEmbeddingSmokeCheck>("/api/admin/memory/embedding-smoke", {
      method: "POST"
    }),
  codexAppServer: () => request<CodexAppServerStatus>("/api/admin/codex-app-server"),
  latestCodexAppServerHandshake: () => request<{ data: CodexAppServerHandshakeCheck | null }>("/api/admin/codex-app-server/handshake"),
  latestCodexAppServerTurnSmoke: () => request<{ data: CodexAppServerTurnSmokeCheck | null }>("/api/admin/codex-app-server/turn-smoke"),
  storage: () => request<StorageReadiness>("/api/admin/storage"),
  runCodexAppServerHandshake: () =>
    request<CodexAppServerHandshakeCheck>("/api/admin/codex-app-server/handshake", {
      method: "POST"
    }),
  runCodexAppServerTurnSmoke: (input?: { prompt?: string; model?: string }) =>
    request<CodexAppServerTurnSmokeCheck>("/api/admin/codex-app-server/turn-smoke", {
      method: "POST",
      body: JSON.stringify(input ?? {})
    }),
  executeMcpTool: (input: { toolId: string; arguments?: Record<string, unknown>; approvalReason?: string }) =>
    request<McpToolExecutionResult>("/api/mcp/tools/execute", {
      method: "POST",
      body: JSON.stringify({
        toolId: input.toolId,
        arguments: input.arguments ?? {},
        approvalReason: input.approvalReason
      })
    }),
  skills: () => request<Paginated<Skill>>("/api/skills"),
  artifacts: (query?: { roomId?: string; paneId?: string; kind?: Artifact["kind"]; collection?: "ROOM_MEDIA" | "AGENT_FILES"; page?: number; pageSize?: number; sortOrder?: "asc" | "desc" }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    if (query?.paneId) params.set("paneId", query.paneId);
    if (query?.kind) params.set("kind", query.kind);
    if (query?.collection) params.set("collection", query.collection);
    if (query?.page) params.set("page", String(query.page));
    if (query?.pageSize) params.set("pageSize", String(query.pageSize));
    if (query?.sortOrder) params.set("sortOrder", query.sortOrder);
    const suffix = params.toString();
    return request<Paginated<Artifact>>(`/api/artifacts${suffix ? `?${suffix}` : ""}`);
  },
  artifactFileUrl: (artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/file`,
  /** The Details dialog: the record, an image's measured size and the metadata a PNG carries inside. */
  artifactMetadata: (artifactId: string) => request<ArtifactMetadataPayload>(`/api/artifacts/${encodeURIComponent(artifactId)}/metadata`),
  agentFilePreviewUrl: (artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/preview`,
  agentFileDownloadUrl: (artifactId: string) => `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
  browserRecordingManifest: (artifactId: string) =>
    request<BrowserRecordingManifestPayload>(`/api/artifacts/${encodeURIComponent(artifactId)}/file`),
  updateArtifactRetention: (artifactId: string, input: { expiresAt?: string | null; pinnedAt?: string | null }) =>
    request<Artifact>(`/api/artifacts/${encodeURIComponent(artifactId)}/retention`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  deleteArtifact: (artifactId: string) =>
    request<{ ok: true; artifactId: string }>(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
      method: "DELETE"
    }),
  deleteRoomMedia: (roomId: string) =>
    request<DeleteRoomMediaResponse>(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
      method: "DELETE"
    }),
  deleteRoomAgentFiles: (roomId: string) =>
    request<DeleteRoomAgentFilesResponse>(`/api/rooms/${encodeURIComponent(roomId)}/agent-files`, {
      method: "DELETE"
    }),
  createArtifact: (input: {
    roomId?: string | null;
    paneId?: string | null;
    turnId?: string | null;
    workflowId?: string | null;
    kind: Artifact["kind"];
    mimeType: string;
    storageUri: string;
    sha256: string;
    byteSize: number;
    metadata: Record<string, unknown>;
  }) =>
    request<Artifact>("/api/artifacts", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  uploadImages: (input: {
    roomId: string;
    paneId?: string | null;
    source: "USER_UPLOAD" | "CLIPBOARD" | "DROP" | "SCREEN_CAPTURE";
    files: File[];
  }) => {
    const params = new URLSearchParams({ roomId: input.roomId, source: input.source });
    if (input.paneId) params.set("paneId", input.paneId);
    const form = new FormData();
    input.files.forEach((file) => form.append("file", file, file.name || "image"));
    return request<{ artifacts: Artifact[] }>(`/api/artifacts/uploads?${params.toString()}`, {
      method: "POST",
      body: form
    });
  },
  uploadPaneFiles: (input: {
    roomId: string;
    paneId?: string | null;
    source: "USER_UPLOAD" | "CLIPBOARD" | "DROP" | "SCREEN_CAPTURE" | "LIVE_RECORDING";
    files: File[];
    signal?: AbortSignal;
  }) => {
    const params = new URLSearchParams({ roomId: input.roomId, source: input.source });
    if (input.paneId) params.set("paneId", input.paneId);
    const form = new FormData();
    input.files.forEach((file) => form.append("file", file, file.name || "upload"));
    return request<{ artifacts: Artifact[] }>(`/api/artifacts/file-uploads?${params.toString()}`, {
      method: "POST",
      body: form,
      signal: input.signal
    });
  },
  uploadAgentFiles: (input: { roomId: string; files: File[]; folder?: string }) => {
    const form = new FormData();
    if (input.folder) form.append("folder", input.folder);
    input.files.forEach((file) => form.append("file", file, file.name || "agent-file"));
    return request<{ artifacts: Artifact[] }>(`/api/rooms/${encodeURIComponent(input.roomId)}/agent-files/uploads`, {
      method: "POST",
      body: form
    });
  },
  liveSearch: (input: { query: string; limit?: number }) =>
    request<{ results: Array<{ title: string; snippet: string; url?: string }> }>("/api/live/search", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  liveFetchUrl: (input: { url: string; maxChars?: number }) =>
    request<{ url: string; title: string; text: string }>("/api/live/fetch-url", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  getLivePersonalMemory: () => request<{ items: LivePersonalMemoryItem[]; revision?: number }>("/api/live/personal-memory"),
  reviewLivePersonalMemory: () => request<{ revision: number; conflicts: Array<{ key: string; items: Array<{ id: string; key: string; value: string; category: string; updatedAt: string }> }> }>("/api/live/personal-memory/review"),
  saveLivePersonalMemory: (input: { key: string; value: string; category?: string; id?: string; expectedRevision?: number }) =>
    request<{ item: LivePersonalMemoryItem; revision?: number }>("/api/live/personal-memory", { method: "POST", body: JSON.stringify(input) }),
  deleteLivePersonalMemory: (id: string, expectedRevision?: number) =>
    request<{ ok: boolean; deletedCount?: number; revision?: number }>(`/api/live/personal-memory/${encodeURIComponent(id)}${expectedRevision === undefined ? "" : `?expectedRevision=${expectedRevision}`}`, { method: "DELETE" }),
  analyzeLiveAttachment: (input: { file: File; model: string; prompt?: string; provider?: string }) => {
    const form = new FormData();
    form.append("file", input.file, input.file.name || "attachment");
    form.append("model", input.model);
    if (input.prompt) form.append("prompt", input.prompt);
    if (input.provider) form.append("provider", input.provider);
    return request<{ text: string }>("/api/voice/realtime/attachments", { method: "POST", body: form });
  },
  delegateVoiceIntent: (input: { query: string; roomId?: string; tools?: Array<Record<string, unknown>> }) =>
    request<{ toolCall: { name: string; args: Record<string, unknown> } | null; message: string | null }>("/api/voice/realtime/delegate", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  captureScreen: (input: { roomId: string; paneId?: string | null; viewport?: BrowserEvidenceViewport }) =>
    request<BrowserEvidenceCapture & { artifact: Artifact }>(`/api/rooms/${encodeURIComponent(input.roomId)}/screen-capture`, {
      method: "POST",
      body: JSON.stringify({
        paneId: input.paneId ?? null,
        viewport: input.viewport ?? "desktop"
      })
    }),
  screenshotControlMcp: (roomId: string, options?: { format?: string; quality?: number; maxWidth?: number; maxHeight?: number; query?: string }) =>
    request<{ status: string; detail: string; evidence: Record<string, unknown> }>("/api/control/v1/screenshot", {
      method: "POST",
      body: JSON.stringify({ roomId, ...options })
    }),
  captureBrowserEvidence: (input: { roomId: string; paneId?: string | null; viewport: BrowserEvidenceViewport }) =>
    request<BrowserEvidenceCapture>("/api/browser/evidence-smoke", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  reviews: (query?: { roomId?: string }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    const suffix = params.toString();
    return request<Paginated<ReviewDecision>>(`/api/reviews${suffix ? `?${suffix}` : ""}`);
  },
  reviewState: (query?: { roomId?: string }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    const suffix = params.toString();
    return request<ReviewRoomState>(`/api/reviews/state${suffix ? `?${suffix}` : ""}`);
  },
  createReview: (input: {
    roomId: string;
    workflowId?: string | null;
    decision: ReviewDecision["decision"];
    summary: string;
    evidenceArtifactIds: string[];
    rollbackNote: string;
  }) =>
    request<ReviewDecision>("/api/reviews", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createReviewCheck: (input: {
    roomId: string;
    reviewDecisionId?: string | null;
    name: string;
    status: ReviewCheck["status"];
    command?: string | null;
    summary: string;
    artifactIds: string[];
    metadata: Record<string, unknown>;
  }) =>
    request<ReviewCheck>("/api/review-checks", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createReviewDiff: (input: {
    roomId: string;
    reviewDecisionId?: string | null;
    title: string;
    filePath: string;
    status: ReviewDiffSummary["status"];
    additions: number;
    deletions: number;
    patchArtifactId?: string | null;
    summary: string;
  }) =>
    request<ReviewDiffSummary>("/api/review-diffs", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  swarm: (roomId?: string | null) => {
    const params = new URLSearchParams();
    if (roomId) params.set("roomId", roomId);
    const suffix = params.toString();
    return request<SwarmState>(`/api/swarm${suffix ? `?${suffix}` : ""}`);
  },
  createSwarmTask: (input: {
    roomId: string;
    parentTaskId?: string | null;
    role: SwarmTaskRole;
    title: string;
    goal: string;
    assignee?: string | null;
    dependsOnTaskIds?: string[];
  }) =>
    request<SwarmTask>("/api/swarm/tasks", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateSwarmTask: (taskId: string, input: {
    status?: SwarmTaskStatus;
    assignee?: string | null;
    dependsOnTaskIds?: string[];
    lockIds?: string[];
    resultSummary?: string | null;
  }) =>
    request<SwarmTask>(`/api/swarm/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  claimSwarmLock: (input: {
    roomId: string;
    taskId?: string | null;
    resource: string;
    holder: string;
    reason: string;
  }) =>
    request<SwarmLock>("/api/swarm/locks", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  releaseSwarmLock: (lockId: string, reason: string) =>
    request<SwarmLock>(`/api/swarm/locks/${encodeURIComponent(lockId)}/release`, {
      method: "POST",
      body: JSON.stringify({ reason })
    }),
  postSwarmMessage: (input: {
    roomId: string;
    taskId?: string | null;
    fromRole: SwarmTaskRole;
    toRole?: SwarmTaskRole | null;
    body: string;
  }) =>
    request<SwarmMessage>("/api/swarm/messages", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createSwarmReconcile: (input: {
    roomId: string;
    taskIds: string[];
    decision: SwarmReconcileDecision;
    summary: string;
    nextSteps: string;
  }) =>
    request<SwarmReconcile>("/api/swarm/reconciles", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  admin: () =>
    request<{
      status: string;
      mode: string;
      storageWarning: string;
    }>("/api/admin"),
  callControlMcp: async (method: string, params?: Record<string, unknown>, id?: string | number) => {
    const doCall = () =>
      request<any>("/api/control/v1/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: id ?? Date.now(), method, params })
      });
    try {
      return await doCall();
    } catch (err: any) {
      if (err?.code === "UPSTREAM_UNAVAILABLE" || err?.status === 502 || err?.status === 503 || String(err?.message).includes("UPSTREAM_UNAVAILABLE")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await doCall();
      }
      throw err;
    }
  },
  executeControlMcp: async (roomId: string, actions: any[], expectedRevision?: string, waitForCompletion: boolean = true, requestId: string = `voice_${crypto.randomUUID()}`) => {
    const doCall = () =>
      request<any>("/api/control/v1/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "space_execute",
            arguments: {
              roomId,
              requestId,
              expectedRevision,
              waitForCompletion,
              actions
            }
          }
        })
      });
    try {
      return await doCall();
    } catch (err: any) {
      if (err?.code === "UPSTREAM_UNAVAILABLE" || err?.status === 502 || err?.status === 503 || String(err?.message).includes("UPSTREAM_UNAVAILABLE")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await doCall();
      }
      throw err;
    }
  },
  inspectControlMcp: async (roomId: string, section: string = "STATE", paneId?: string) => {
    const args: Record<string, unknown> = {
      roomId,
      section: section || "STATE"
    };
    if (typeof paneId === "string" && paneId.trim().length > 0) {
      args.paneId = paneId.trim();
    }
    const doCall = () =>
      request<any>("/api/control/v1/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "space_inspect",
            arguments: args
          }
        })
      });
    try {
      return await doCall();
    } catch (err: any) {
      if (err?.code === "UPSTREAM_UNAVAILABLE" || err?.status === 502 || err?.status === 503 || String(err?.message).includes("UPSTREAM_UNAVAILABLE")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await doCall();
      }
      throw err;
    }
  },
  callControlMcpTool: async (name: string, args: Record<string, unknown> = {}) => {
    const doCall = () =>
      request<any>("/api/control/v1/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name,
            arguments: args
          }
        })
      });
    try {
      return await doCall();
    } catch (err: any) {
      if (err?.code === "UPSTREAM_UNAVAILABLE" || err?.status === 502 || err?.status === 503 || String(err?.message).includes("UPSTREAM_UNAVAILABLE")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await doCall();
      }
      throw err;
    }
  },
  reportLiveVoiceLog: (payload: { roomId?: string; event: string; role?: string; text?: string; toolCall?: unknown; detail?: unknown; timestamp?: string }) =>
    request<{ ok: boolean }>("/api/voice/realtime/logs", {
      method: "POST",
      body: JSON.stringify(payload)
    }).catch(() => ({ ok: false })),
  clearVoiceRealtimeLogs: (roomId: string) =>
    request<{ ok: boolean; clearedRoomId?: string; epoch?: number }>(
      `/api/voice/realtime/logs/${encodeURIComponent(roomId)}`,
      { method: "DELETE" }
    ).catch(() => ({ ok: false })),
  getVoiceRealtimeHistory: (roomId: string, limit = 50) =>
    request<{ ok: boolean; roomId: string; items: VoiceRealtimeHistoryItem[] }>(
      `/api/voice/realtime/history/${encodeURIComponent(roomId)}?limit=${limit}`
    ).catch(() => ({ ok: false, roomId, items: [] as VoiceRealtimeHistoryItem[] })),
  searchVoiceRealtimeHistory: (query: string, roomId?: string, limit = 10) =>
    request<{ ok: boolean; results: Array<Record<string, unknown>> }>(
      "/api/voice/realtime/history/search",
      {
        method: "POST",
        body: JSON.stringify({ query, roomId, limit })
      }
    ).catch(() => ({ ok: false, results: [] })),
  watchesControlMcp: async (roomId: string, operation: string = "list", params: Record<string, unknown> = {}) => {
    return request<any>("/api/control/v1/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "space_watches",
          arguments: {
            roomId,
            operation,
            ...params
          }
        }
      })
    });
  },
  getPendingWatches: async (roomId?: string) => {
    return request<any[]>(`/api/control/v1/watches/pending${roomId ? `?roomId=${encodeURIComponent(roomId)}` : ""}`);
  },
  ackWatch: async (roomId: string, id: string) => {
    return request<any>("/api/control/v1/watches/ack", {
      method: "POST",
      body: JSON.stringify({ roomId, id })
    });
  },
  demoState: () => request<DemoStateResponse>("/api/demo-projects/state", { cache: "no-store" }),
  demoSaveSelection: (input: DemoSelectionInput) =>
    request<{ selection: DemoSelection }>("/api/demo-projects/selection", { method: "PUT", body: JSON.stringify(input) }),
  demoStartRun: (input: DemoStartRunInput) =>
    request<{ run: DemoRun }>("/api/demo-projects/runs", { method: "POST", body: JSON.stringify(input) }),
  demoStopRun: (runId: string) =>
    request<{ run: DemoRun }>(`/api/demo-projects/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" }),
  demoRestartRun: (runId: string) =>
    request<{ run: DemoRun }>(`/api/demo-projects/runs/${encodeURIComponent(runId)}/restart`, { method: "POST" }),
  demoRunLogs: (runId: string, since = 0) =>
    request<DemoLogsResponse>(`/api/demo-projects/runs/${encodeURIComponent(runId)}/logs?since=${since}`, { cache: "no-store" }),
  demoVariantFiles: (variantId: string, projectId?: string) =>
    request<DemoVariantFilesResponse>(
      `/api/demo-projects/files?variantId=${encodeURIComponent(variantId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
      { cache: "no-store" }
    ),
  demoVariantFile: (variantId: string, path: string, projectId?: string) =>
    request<DemoVariantFileContent>(
      `/api/demo-projects/files/content?variantId=${encodeURIComponent(variantId)}&path=${encodeURIComponent(path)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
      { cache: "no-store" }
    ),
  demoSaveConnectionSettings: (provider: DemoConnectionProvider, input: Record<string, unknown>) =>
    request<{ connections: DemoConnection[] }>(`/api/demo-projects/connections/${provider}/settings`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  demoAuthorizeConnection: (provider: DemoConnectionProvider) =>
    request<{ authorizationUrl: string; expiresAt: string; redirectUri: string }>(
      `/api/demo-projects/connections/${provider}/authorize`,
      { method: "POST" }
    ),
  demoDisconnectConnection: (provider: DemoConnectionProvider) =>
    request<{ connections: DemoConnection[] }>(`/api/demo-projects/connections/${provider}`, { method: "DELETE" }),
  demoSelectSheet: (input: { spreadsheet: string; tab?: string | null }) =>
    request<{ sheets: DemoSheetsTarget }>("/api/demo-projects/sheets/target", { method: "PUT", body: JSON.stringify(input) }),
  demoCreateSheet: (input: { title?: string | null; tab?: string | null }) =>
    request<{ sheets: DemoSheetsTarget }>("/api/demo-projects/sheets/create", { method: "POST", body: JSON.stringify(input) }),
  demoVerifySheet: () => request<{ sheets: DemoSheetsTarget }>("/api/demo-projects/sheets/verify", { method: "POST" }),
  demoOperations: (projectId?: string) =>
    request<DemoOperationListResponse>(
      `/api/demo-projects/operations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      { cache: "no-store" }
    ),
  demoRetryOperation: (id: string) =>
    request<{ operation: DemoOperation }>(`/api/demo-projects/operations/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      body: JSON.stringify({ attemptNow: true })
    }),
  demoAccounts: (query: { projectId: string; variantId: string; mode: "SAMPLE" | "LIVE"; search?: string; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams({
      projectId: query.projectId,
      variantId: query.variantId,
      mode: query.mode,
      page: String(query.page ?? 1),
      pageSize: String(query.pageSize ?? 10)
    });
    if (query.search) params.set("search", query.search);
    return request<DemoAccountsResponse>(`/api/demo-projects/accounts?${params.toString()}`, { cache: "no-store" });
  },
  demoRunTests: (input: { projectId?: string; variantId?: string }) =>
    request<{ testRun: DemoTestRun }>("/api/demo-projects/tests/run", { method: "POST", body: JSON.stringify(input) }),
  demoTests: (projectId?: string) =>
    request<DemoTestRunListResponse>(
      `/api/demo-projects/tests${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      { cache: "no-store" }
    ),
  // T3 Code pane: binding endpoints inside the authenticated pane namespace.
  t3CodeStatus: (paneId: string) =>
    request<T3CodeServiceStatus>(`/api/t3code/panes/${encodeURIComponent(paneId)}/app/__space/status`, { cache: "no-store" }),
  t3CodeBinding: (paneId: string) =>
    request<{ version: 1; paneId: string; metadata: T3CodePaneMetadata | null }>(
      `/api/t3code/panes/${encodeURIComponent(paneId)}/app/__space/binding`, { cache: "no-store" }),
  t3CodeSaveSelection: (paneId: string, input: T3CodeBindingUpdate) =>
    request<{ version: 1; paneId: string; metadata: T3CodePaneMetadata }>(
      `/api/t3code/panes/${encodeURIComponent(paneId)}/app/__space/binding/selection`, { method: "POST", body: JSON.stringify(input) }),
  t3CodeAdminStatus: () => request<T3CodeAdminResult>("/api/admin/t3code/service", { cache: "no-store" }),
  updateT3CodeEnabled: (input: UpdateT3CodeEnabledInput) =>
    request<T3CodeAdminResult>("/api/admin/t3code/enabled", { method: "PATCH", body: JSON.stringify(input) }),
  restartT3Code: (input: RestartT3CodeInput = {}) =>
    request<T3CodeAdminResult>("/api/admin/t3code/restart", { method: "POST", body: JSON.stringify(input) }),
  // Job Applications pane: per-owner profile, mailbox and tracker; per-pane settings.
  jobApplyProfile: () => request<{ profile: JobApplyProfile }>("/api/job-apply/profile", { cache: "no-store" }),
  updateJobApplyProfile: (input: JobApplyProfileUpdate) =>
    request<{ profile: JobApplyProfile }>("/api/job-apply/profile", { method: "PATCH", body: JSON.stringify(input) }),
  importJobApplyCv: (input: { artifactId: string }) =>
    request<{ profile: JobApplyProfile; coverage: string; textPreview: string }>("/api/job-apply/profile/cv", { method: "POST", body: JSON.stringify(input) }),
  setJobApplyMailbox: (input: JobApplyMailboxInput) =>
    request<{ profile: JobApplyProfile }>("/api/job-apply/mailbox", { method: "PUT", body: JSON.stringify(input) }),
  testJobApplyMailbox: () =>
    request<{ ok: true; verifiedAt: string; recent: Array<{ from: string; subject: string; receivedAt: string | null; snippet: string }> }>("/api/job-apply/mailbox/test", { method: "POST", body: "{}" }),
  clearJobApplyMailbox: () => request<{ profile: JobApplyProfile }>("/api/job-apply/mailbox", { method: "DELETE" }),
  resetJobApply: (expectedCampaignStartedAt: string | null) =>
    request<{ reset: JobApplyResetResult }>("/api/job-apply/reset", { method: "POST", body: JSON.stringify({ confirm: "RESET", expectedCampaignStartedAt }) }),
  jobApplyStats: (tz: string) => request<{ stats: JobApplyStats }>(`/api/job-apply/stats?tz=${encodeURIComponent(tz)}`, { cache: "no-store" }),
  jobApplications: (status?: JobApplicationStatus) =>
    request<{ applications: JobApplication[] }>(`/api/job-apply/applications?limit=1000${status ? `&status=${encodeURIComponent(status)}` : ""}`, { cache: "no-store" }),
  createJobApplication: (input: JobApplicationCreate) =>
    request<{ application: JobApplication; created: boolean }>("/api/job-apply/applications", { method: "POST", body: JSON.stringify(input) }),
  updateJobApplication: (id: string, input: JobApplicationUpdate) =>
    request<{ application: JobApplication }>(`/api/job-apply/applications/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  checkJobApplyMail: (paneId: string) =>
    request<JobApplyMailCheckResult>("/api/job-apply/applications/check-mail", { method: "POST", body: JSON.stringify({ paneId }) }),
  importJobApplyCsv: (input: { csv: string; paneId?: string | null }) =>
    request<{ imported: number; skipped: number; duplicates: number }>("/api/job-apply/applications/import-csv", { method: "POST", body: JSON.stringify(input) }),
  jobApplySettings: (paneId: string) =>
    request<{ metadata: JobApplyPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/settings`, { cache: "no-store" }),
  updateJobApplySettings: (paneId: string, metadata: JobApplyPaneMetadata) =>
    request<{ metadata: JobApplyPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  // Mail Copilot: pane settings (autonomy, accounts, notifications, agent) and the operator's current view.
  mailCopilotSettings: (paneId: string) =>
    request<{ metadata: MailCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/settings`, { cache: "no-store" }),
  updateMailCopilotSettings: (paneId: string, metadata: MailCopilotPaneMetadata) =>
    request<{ metadata: MailCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  // Design pane: settings and view, the Studio's renders and generations, the library, requests and brand kits.
  designSettings: (paneId: string) =>
    request<{ metadata: DesignPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/design/settings`, { cache: "no-store" }),
  updateDesignSettings: (paneId: string, metadata: DesignPaneMetadata) =>
    request<{ metadata: DesignPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/design/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  updateDesignView: (paneId: string, view: Partial<Omit<DesignView, "updatedAt">>) =>
    request<{ view: DesignView }>(`/api/panes/${encodeURIComponent(paneId)}/design/view`, { method: "PUT", body: JSON.stringify(view) }),
  designFormats: () => request<{ formats: Array<DesignFormat & { networkLabel: string }> }>("/api/design/formats", { cache: "no-store" }),
  designRender: (paneId: string, input: { templateId: DesignTemplateId; formatId: string; params?: Record<string, unknown>; backgroundAssetId?: string | null; brandKitId?: string | null; requestId?: string | null; label?: string | null }) =>
    request<{ asset: DesignAsset }>(`/api/panes/${encodeURIComponent(paneId)}/design/render`, { method: "POST", body: JSON.stringify(input) }),
  designGenerate: (paneId: string, input: { engine: "NANO_BANANA" | "NANO_BANANA_PRO" | "GPT_IMAGE"; prompt: string; formatId: string; requestId?: string | null; label?: string | null }) =>
    request<{ asset: DesignAsset; text: string | null }>(`/api/panes/${encodeURIComponent(paneId)}/design/generate`, { method: "POST", body: JSON.stringify(input) }),
  designAssets: (paneId: string, query: { network?: DesignNetwork; formatId?: string; brandKitId?: string; requestId?: string; limit?: number } = {}) =>
    request<{ assets: DesignAsset[] }>(`/api/panes/${encodeURIComponent(paneId)}/design/assets?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { cache: "no-store" }),
  uploadDesignAsset: (paneId: string, file: Blob, fields: { formatId: string; label?: string; parentAssetId?: string; requestId?: string }) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    form.append("file", file, "design.png");
    return request<{ asset: DesignAsset }>(`/api/panes/${encodeURIComponent(paneId)}/design/assets`, { method: "POST", body: form });
  },
  designVariants: (paneId: string, assetId: string, input: { formatIds?: string[]; params?: Record<string, unknown>; requestId?: string | null }) =>
    request<{ assets: DesignAsset[] }>(`/api/panes/${encodeURIComponent(paneId)}/design/assets/${encodeURIComponent(assetId)}/variants`, { method: "POST", body: JSON.stringify(input) }),
  deleteDesignAsset: (paneId: string, assetId: string) =>
    request<{ deleted: true }>(`/api/panes/${encodeURIComponent(paneId)}/design/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }),
  designRequests: (paneId: string) =>
    request<{ requests: DesignRequest[] }>(`/api/panes/${encodeURIComponent(paneId)}/design/requests`, { cache: "no-store" }),
  createDesignRequest: (paneId: string, input: Partial<DesignRequestCreate> & { brief: string }) =>
    request<{ request: DesignRequest }>(`/api/panes/${encodeURIComponent(paneId)}/design/requests`, { method: "POST", body: JSON.stringify(input) }),
  deliverDesignRequest: (paneId: string, requestId: string, input: { assetIds?: string[]; message?: string | null } = {}) =>
    request<{ request: DesignRequest }>(`/api/panes/${encodeURIComponent(paneId)}/design/requests/${encodeURIComponent(requestId)}/deliver`, { method: "POST", body: JSON.stringify(input) }),
  cancelDesignRequest: (paneId: string, requestId: string) =>
    request<{ request: DesignRequest }>(`/api/panes/${encodeURIComponent(paneId)}/design/requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST", body: "{}" }),
  answerDesignRequest: (paneId: string, requestId: string, answer: string) =>
    request<{ request: DesignRequest }>(`/api/panes/${encodeURIComponent(paneId)}/design/requests/${encodeURIComponent(requestId)}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  /** A design request from another pane (Marketing Copilot's "Make graphic"), routed to the owner's Design pane. */
  requestDesignFromPane: (fromPaneId: string, input: Partial<DesignRequestCreate> & { brief: string }) =>
    request<{ request: DesignRequest; designPaneId: string | null }>("/api/design/requests", { method: "POST", body: JSON.stringify({ ...input, fromPaneId }) }),
  designEvents: (paneId: string, limit = 100) =>
    request<{ events: DesignEvent[] }>(`/api/panes/${encodeURIComponent(paneId)}/design/events?limit=${limit}`, { cache: "no-store" }),
  designBrandKits: () => request<{ brandKits: DesignBrandKit[] }>("/api/design/brand-kits", { cache: "no-store" }),
  // Video pane: settings and view, the Studio's sources, the library, music, jobs, requests and activity.
  videoFormats: () => request<{ formats: DesignFormat[] }>("/api/video/formats", { cache: "no-store" }),
  videoTools: () => request<{ tools: VideoToolsStatus }>("/api/video/tools", { cache: "no-store" }),
  videoSettings: (paneId: string) =>
    request<{ metadata: VideoPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/video/settings`, { cache: "no-store" }),
  updateVideoSettings: (paneId: string, metadata: VideoPaneMetadata) =>
    request<{ metadata: VideoPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/video/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  updateVideoView: (paneId: string, view: Partial<Omit<VideoView, "updatedAt">>) =>
    request<{ view: VideoView }>(`/api/panes/${encodeURIComponent(paneId)}/video/view`, { method: "PUT", body: JSON.stringify(view) }),
  uploadVideoSource: (paneId: string, file: File, fields: { label?: string; description?: string; requestId?: string } = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    form.append("file", file, file.name || "source");
    return request<{ asset: VideoAsset; probe: Record<string, unknown> }>(`/api/panes/${encodeURIComponent(paneId)}/video/sources`, { method: "POST", body: form });
  },
  videoAssets: (paneId: string, query: { formatId?: string; kind?: VideoAssetKind; requestId?: string; limit?: number } = {}) =>
    request<{ assets: VideoAsset[] }>(`/api/panes/${encodeURIComponent(paneId)}/video/assets?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { cache: "no-store" }),
  deleteVideoAsset: (paneId: string, assetId: string) =>
    request<{ deleted: true }>(`/api/panes/${encodeURIComponent(paneId)}/video/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" }),
  /** Deletes a video or audio file for good: out of the library and Media (an Agent File the library points at stays in Agent Files). */
  deleteVideoFile: (paneId: string, artifactId: string) =>
    request<{ deleted: true; removedAssets: number; keptInAgentFiles: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/video/files/${encodeURIComponent(artifactId)}`, { method: "DELETE" }),
  /** Copies a video or audio file into Agent Files › Media / Video on the server. */
  saveVideoToAgentFiles: (paneId: string, artifactId: string) =>
    request<{ artifact: Artifact; folder: string; alreadyThere: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/video/files/${encodeURIComponent(artifactId)}/agent-file`, { method: "POST", body: "{}" }),
  videoMusicSearch: (paneId: string, input: { query: string; limit?: number }) =>
    request<{ results: VideoMusicResult[] }>(`/api/panes/${encodeURIComponent(paneId)}/video/music/search`, { method: "POST", body: JSON.stringify(input) }),
  videoMusicFetch: (paneId: string, input: { url: string; title?: string; artist?: string; attribution: string }) =>
    request<{ asset: VideoAsset }>(`/api/panes/${encodeURIComponent(paneId)}/video/music/fetch`, { method: "POST", body: JSON.stringify(input) }),
  uploadVideoMusic: (paneId: string, file: File, fields: { label?: string; credits?: string } = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
    form.append("file", file, file.name || "music");
    return request<{ asset: VideoAsset }>(`/api/panes/${encodeURIComponent(paneId)}/video/music`, { method: "POST", body: form });
  },
  videoJob: (paneId: string, jobId: string) => request<{ job: VideoJob }>(`/api/panes/${encodeURIComponent(paneId)}/video/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" }),
  videoRequests: (paneId: string, query: { status?: VideoRequestStatus; limit?: number } = {}) =>
    request<{ requests: VideoRequest[] }>(`/api/panes/${encodeURIComponent(paneId)}/video/requests?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { cache: "no-store" }),
  createVideoRequest: (paneId: string, input: VideoRequestCreateInput) =>
    request<VideoRequestView & { videoPaneId: string | null; runStarted: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/video/requests`, { method: "POST", body: JSON.stringify(input) }),
  videoRequest: (paneId: string, requestId: string) =>
    request<VideoRequestView & { events: VideoEvent[] }>(`/api/panes/${encodeURIComponent(paneId)}/video/requests/${encodeURIComponent(requestId)}`, { cache: "no-store" }),
  approveVideoRequest: (paneId: string, requestId: string, input: { assetIds?: string[]; message?: string | null } = {}) =>
    request<VideoRequestView>(`/api/panes/${encodeURIComponent(paneId)}/video/requests/${encodeURIComponent(requestId)}/approve`, { method: "POST", body: JSON.stringify(input) }),
  cancelVideoRequest: (paneId: string, requestId: string) =>
    request<VideoRequestView>(`/api/panes/${encodeURIComponent(paneId)}/video/requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST", body: "{}" }),
  answerVideoRequest: (paneId: string, requestId: string, answer: string) =>
    request<VideoRequestView>(`/api/panes/${encodeURIComponent(paneId)}/video/requests/${encodeURIComponent(requestId)}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  videoEvents: (paneId: string, limit = 100) =>
    request<{ events: VideoEvent[] }>(`/api/panes/${encodeURIComponent(paneId)}/video/events?limit=${limit}`, { cache: "no-store" }),
  // App Studio pane: settings, everything the pane shows in one read, briefs, answers and the run.
  appStudioState: (paneId: string) =>
    request<{ metadata: AppStudioPaneMetadata; run: { status: AppStudioRunStatus; paused: boolean; openQuestions: number; pendingBriefs: number }; previews: AppStudioPreview[]; events: AppStudioEvent[] }>(
      `/api/panes/${encodeURIComponent(paneId)}/app-studio/state`, { cache: "no-store" }),
  updateAppStudioSettings: (paneId: string, metadata: AppStudioPaneMetadata) =>
    request<{ metadata: AppStudioPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/app-studio/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  createAppStudioBrief: (paneId: string, text: string) =>
    request<{ brief: AppStudioEvent; kickoffSent: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/app-studio/briefs`, { method: "POST", body: JSON.stringify({ text }) }),
  answerAppStudioQuestion: (paneId: string, questionId: string, answer: string) =>
    request<{ question: AppStudioEvent }>(`/api/panes/${encodeURIComponent(paneId)}/app-studio/questions/${encodeURIComponent(questionId)}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  // Security Copilot pane: everything the pane shows in one read, settings, briefs, answers, reviews, findings, memory and "Check now".
  securityCopilotState: (paneId: string) => request<SecurityCopilotState>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/state`, { cache: "no-store" }),
  updateSecurityCopilotSettings: (paneId: string, metadata: SecurityCopilotPaneMetadata) =>
    request<{ metadata: SecurityCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  createSecurityCopilotBrief: (paneId: string, text: string) =>
    request<{ brief: SecurityEvent; kickoffSent: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/briefs`, { method: "POST", body: JSON.stringify({ text }) }),
  answerSecurityCopilotQuestion: (paneId: string, questionId: string, answer: string) =>
    request<{ question: SecurityEvent }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/questions/${encodeURIComponent(questionId)}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  decideSecurityCopilotReview: (paneId: string, reviewId: string, approve: boolean, note?: string) =>
    request<{ review: SecurityEvent }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/reviews/${encodeURIComponent(reviewId)}/decide`, { method: "POST", body: JSON.stringify({ approve, ...(note ? { note } : {}) }) }),
  updateSecurityCopilotFinding: (paneId: string, findingId: string, status: SecurityFindingView["status"], note: string) =>
    request<{ finding: SecurityFindingView }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/findings/${encodeURIComponent(findingId)}`, { method: "PATCH", body: JSON.stringify({ status, note }) }),
  securityCopilotMemory: (paneId: string) => request<{ memories: SecurityMemory[] }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/memory`, { cache: "no-store" }),
  createSecurityCopilotMemory: (paneId: string, input: { kind: SecurityMemory["kind"]; key?: string; text: string; pinned?: boolean }) =>
    request<{ memory: SecurityMemory }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/memory`, { method: "POST", body: JSON.stringify(input) }),
  deleteSecurityCopilotMemory: (paneId: string, memoryId: string) =>
    request<{ deleted: true }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/memory/${encodeURIComponent(memoryId)}`, { method: "DELETE" }),
  securityCopilotRun: (paneId: string, action: "start" | "pause" | "stop") =>
    request<SecurityRunView & { kickoffSent: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/run/${action}`, { method: "POST", body: "{}" }),
  checkSecurityCopilotNow: (paneId: string) =>
    request<{ owners: number; newFindings: number; kicked: number }>(`/api/panes/${encodeURIComponent(paneId)}/security-copilot/watch`, { method: "POST", body: "{}" }),
  createDesignBrandKit: (input: DesignBrandKitInput) => request<{ brandKit: DesignBrandKit }>("/api/design/brand-kits", { method: "POST", body: JSON.stringify(input) }),
  updateDesignBrandKit: (id: string, input: Partial<DesignBrandKitInput>) =>
    request<{ brandKit: DesignBrandKit }>(`/api/design/brand-kits/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteDesignBrandKit: (id: string) => request<{ deleted: true }>(`/api/design/brand-kits/${encodeURIComponent(id)}`, { method: "DELETE" }),
  marketingCopilotSettings: (paneId: string) =>
    request<{ metadata: MarketingCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/settings`, { cache: "no-store" }),
  updateMarketingCopilotSettings: (paneId: string, metadata: MarketingCopilotPaneMetadata) =>
    request<{ metadata: MarketingCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  marketingCopilotRun: (paneId: string) =>
    request<MarketingRunView>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/run`, { cache: "no-store" }),
  marketingCopilotRunAction: (paneId: string, action: "start" | "pause" | "stop") =>
    request<MarketingRunView & { kickoffSent?: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/run/${action}`, { method: "POST", body: "{}" }),
  createMarketingBrief: (paneId: string, input: { text: string; campaignId?: string | null; channels?: string[] }) =>
    request<{ brief: MarketingEvent }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/briefs`, { method: "POST", body: JSON.stringify(input) }),
  marketingEvents: (paneId: string, limit = 150) =>
    request<{ events: MarketingEvent[] }>(`/api/marketing-copilot/events?paneId=${encodeURIComponent(paneId)}&limit=${limit}`, { cache: "no-store" }),
  answerMarketingQuestion: (paneId: string, input: { questionId: string; answer: string }) =>
    request<{ memory: MarketingMemory }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/answer`, { method: "POST", body: JSON.stringify(input) }),
  marketingPosts: () => request<{ posts: MarketingPost[] }>("/api/marketing-copilot/posts?limit=300", { cache: "no-store" }),
  decideMarketingPost: (paneId: string, postId: string, input: { decision: "approve" | "edit" | "revise" | "reject"; title?: string | null; body?: string; scheduledAt?: string | null; note?: string }) =>
    request<{ post: MarketingPost }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/posts/${encodeURIComponent(postId)}/review`, { method: "POST", body: JSON.stringify(input) }),
  retryMarketingPost: (paneId: string, postId: string) =>
    request<{ post: MarketingPost }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/posts/${encodeURIComponent(postId)}/retry`, { method: "POST", body: "{}" }),
  marketingCampaigns: () => request<{ campaigns: MarketingCampaign[] }>("/api/marketing-copilot/campaigns", { cache: "no-store" }),
  createMarketingCampaign: (paneId: string, input: { name: string; goal?: string | null; channels?: string[] }) =>
    request<{ campaign: MarketingCampaign }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/campaigns`, { method: "POST", body: JSON.stringify(input) }),
  decideMarketingCampaign: (paneId: string, campaignId: string, decision: "approve" | "complete" | "cancel") =>
    request<{ campaign: MarketingCampaign }>(`/api/marketing-copilot/campaigns/${encodeURIComponent(campaignId)}/decide?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: JSON.stringify({ decision }) }),
  marketingRules: () => request<{ rules: MarketingRule[] }>("/api/marketing-copilot/rules", { cache: "no-store" }),
  decideMarketingRule: (ruleId: string, decision: "approve" | "reject" | "retire") =>
    request<{ rule: MarketingRule }>(`/api/marketing-copilot/rules/${encodeURIComponent(ruleId)}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
  marketingMemory: (query: { query?: string; limit?: number } = {}) =>
    request<{ memories: MarketingMemory[] }>(`/api/marketing-copilot/memory?limit=${query.limit ?? 100}${query.query ? `&query=${encodeURIComponent(query.query)}` : ""}`, { cache: "no-store" }),
  rememberMarketingMemory: (input: { kind: MarketingMemory["kind"]; text: string; key?: string | null; channel?: MarketingMemory["channel"]; pinned?: boolean }) =>
    request<{ memory: MarketingMemory }>("/api/marketing-copilot/memory", { method: "POST", body: JSON.stringify(input) }),
  updateMarketingMemory: (id: string, patch: { text?: string; pinned?: boolean }) =>
    request<{ memory: MarketingMemory }>(`/api/marketing-copilot/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  marketingAnalytics: () => request<{ metrics: MarketingMetric[]; topPosts: MarketingPost[]; published: number }>("/api/marketing-copilot/analytics", { cache: "no-store" }),
  forgetMarketingMemory: (id: string) => request<{ forgotten: boolean }>(`/api/marketing-copilot/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  marketingBookmarks: () => request<{ bookmarks: MarketingBookmark[] }>("/api/marketing-copilot/bookmarks", { cache: "no-store" }),
  createMarketingBookmark: (input: { url: string; title?: string; profileId: string | null; accountLabel: string | null }) =>
    request<{ bookmark: MarketingBookmark }>("/api/marketing-copilot/bookmarks", { method: "POST", body: JSON.stringify(input) }),
  deleteMarketingBookmark: (id: string) => request<{ deleted: boolean }>(`/api/marketing-copilot/bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  openMarketingBookmark: (paneId: string, id: string) =>
    request<{ bookmark: MarketingBookmark }>(`/api/panes/${encodeURIComponent(paneId)}/marketing-copilot/bookmarks/${encodeURIComponent(id)}/open`, { method: "POST", body: "{}" }),
  freelanceCopilotSettings: (paneId: string) =>
    request<{ metadata: FreelanceCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/settings`, { cache: "no-store" }),
  updateFreelanceCopilotSettings: (paneId: string, metadata: FreelanceCopilotPaneMetadata) =>
    request<{ metadata: FreelanceCopilotPaneMetadata }>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/settings`, { method: "PUT", body: JSON.stringify(metadata) }),
  freelanceCopilotRun: (paneId: string) => request<FreelanceRunView>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/run`, { cache: "no-store" }),
  freelanceCopilotRunAction: (paneId: string, action: "start" | "pause" | "stop") =>
    request<FreelanceRunView & { kickoffSent?: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/run/${action}`, { method: "POST", body: "{}" }),
  createFreelanceBrief: (paneId: string, input: { text: string; leadId?: string | null }) =>
    request<{ brief: FreelanceEvent }>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/briefs`, { method: "POST", body: JSON.stringify(input) }),
  freelanceEvents: (paneId: string, limit = 150) =>
    request<{ events: FreelanceEvent[] }>(`/api/freelance-copilot/events?paneId=${encodeURIComponent(paneId)}&limit=${limit}`, { cache: "no-store" }),
  answerFreelanceQuestion: (paneId: string, input: { questionId: string; answer: string }) =>
    request<{ memory: FreelanceMemory }>(`/api/panes/${encodeURIComponent(paneId)}/freelance-copilot/answer`, { method: "POST", body: JSON.stringify(input) }),
  freelanceLeads: () => request<{ leads: FreelanceLead[] }>("/api/freelance-copilot/leads?limit=300", { cache: "no-store" }),
  freelanceLead: (leadId: string) => request<{ lead: FreelanceLead; messages: FreelanceMessage[] }>(`/api/freelance-copilot/leads/${encodeURIComponent(leadId)}`, { cache: "no-store" }),
  decideFreelanceLead: (paneId: string, leadId: string, input: FreelanceLeadDecision) =>
    request<{ lead: FreelanceLead }>(`/api/freelance-copilot/leads/${encodeURIComponent(leadId)}/decide?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: JSON.stringify(input) }),
  decideFreelanceMessage: (paneId: string, messageId: string, input: FreelanceMessageReviewDecision) =>
    request<{ message: FreelanceMessage }>(`/api/freelance-copilot/messages/${encodeURIComponent(messageId)}/review?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: JSON.stringify(input) }),
  retryFreelanceMessage: (paneId: string, messageId: string) =>
    request<{ message: FreelanceMessage }>(`/api/freelance-copilot/messages/${encodeURIComponent(messageId)}/retry?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: "{}" }),
  freelanceAccounts: () => request<{ accounts: FreelanceAccount[] }>("/api/freelance-copilot/accounts", { cache: "no-store" }),
  updateFreelanceAccount: (paneId: string, input: FreelanceAccountUpdate) =>
    request<{ account: FreelanceAccount }>(`/api/freelance-copilot/accounts?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: JSON.stringify(input) }),
  freelanceMailbox: () => request<{ connected: boolean; config: { host: string; port: number; secure: boolean; user: string } | null; lastUid: number | null; updatedAt: string | null }>("/api/freelance-copilot/mailbox", { cache: "no-store" }),
  connectFreelanceMailbox: (input: { host: string; port: number; secure: boolean; user: string; password: string }) =>
    request<{ connected: boolean }>("/api/freelance-copilot/mailbox", { method: "PUT", body: JSON.stringify(input) }),
  disconnectFreelanceMailbox: () => request<{ removed: boolean }>("/api/freelance-copilot/mailbox", { method: "DELETE" }),
  freelanceFunnel: () => request<FreelanceFunnel>("/api/freelance-copilot/funnel", { cache: "no-store" }),
  decideFreelanceRule: (paneId: string, ruleId: string, decision: "approve" | "reject" | "retire") =>
    request<{ rule: FreelanceRule }>(`/api/freelance-copilot/rules/${encodeURIComponent(ruleId)}/decide?paneId=${encodeURIComponent(paneId)}`, { method: "POST", body: JSON.stringify({ decision }) }),
  freelanceMemory: (query: { query?: string; limit?: number } = {}) =>
    request<{ memories: FreelanceMemory[] }>(`/api/freelance-copilot/memory?limit=${query.limit ?? 100}${query.query ? `&query=${encodeURIComponent(query.query)}` : ""}`, { cache: "no-store" }),
  rememberFreelanceMemory: (input: { kind: FreelanceMemory["kind"]; text: string; key?: string | null; channel?: FreelanceMemory["channel"]; pinned?: boolean }) =>
    request<{ memory: FreelanceMemory }>("/api/freelance-copilot/memory", { method: "POST", body: JSON.stringify(input) }),
  updateFreelanceMemory: (id: string, patch: { text?: string; pinned?: boolean }) =>
    request<{ memory: FreelanceMemory }>(`/api/freelance-copilot/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  forgetFreelanceMemory: (id: string) => request<{ forgotten: boolean }>(`/api/freelance-copilot/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updateMailCopilotView: (paneId: string, view: MailCopilotViewInput) =>
    request<{ view: MailCopilotView | null }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/view`, { method: "PUT", body: JSON.stringify(view) }),
  // The mailbox of the pane's Google accounts (owner-scoped; paneId narrows to the pane's chosen accounts).
  mailAccounts: (paneId?: string) =>
    request<{ accounts: MailAccountSummary[] }>(`/api/mail-copilot/accounts${paneId ? `?paneId=${encodeURIComponent(paneId)}` : ""}`, { cache: "no-store" }),
  mailLabels: (paneId: string | undefined, account: string) =>
    request<{ labels: MailLabel[] }>(`/api/mail-copilot/labels?${new URLSearchParams({ account, ...(paneId ? { paneId } : {}) })}`, { cache: "no-store" }),
  mailThreads: (paneId: string | undefined, query: { account: string; labelId: string; q?: string; pageToken?: string; max?: number }) =>
    request<MailThreadsPage>(`/api/mail-copilot/threads?${new URLSearchParams({ account: query.account, labelId: query.labelId, ...(query.q ? { q: query.q } : {}),
      ...(query.pageToken ? { pageToken: query.pageToken } : {}), ...(query.max ? { max: String(query.max) } : {}), ...(paneId ? { paneId } : {}) })}`, { cache: "no-store" }),
  mailThread: (paneId: string | undefined, account: string, threadId: string, images = false) =>
    request<{ thread: MailThread }>(`/api/mail-copilot/threads/${encodeURIComponent(threadId)}?${new URLSearchParams({ account, images: images ? "1" : "0", ...(paneId ? { paneId } : {}) })}`, { cache: "no-store" }),
  modifyMailThread: (paneId: string | undefined, threadId: string, input: MailThreadAction) =>
    request<{ ok: true }>(`/api/mail-copilot/threads/${encodeURIComponent(threadId)}/modify`, { method: "POST", body: JSON.stringify({ ...input, ...(paneId ? { paneId } : {}) }) }),
  sendMail: (paneId: string | undefined, input: MailComposeInput) =>
    request<{ messageId: string; threadId: string }>("/api/mail-copilot/messages/send", { method: "POST", body: JSON.stringify({ ...input, ...(paneId ? { paneId } : {}) }) }),
  saveMailDraft: (paneId: string | undefined, input: MailComposeInput) =>
    request<{ draftId: string; messageId: string }>("/api/mail-copilot/drafts", { method: "POST", body: JSON.stringify({ ...input, ...(paneId ? { paneId } : {}) }) }),
  // The copilot's run, activity, questions, reviews and memory (the rail).
  mailCopilotRun: (paneId: string) => request<MailCopilotRunView>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/run`, { cache: "no-store" }),
  startMailCopilotRun: (paneId: string) => request<MailCopilotRunView & { kickoffSent: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/run/start`, { method: "POST", body: "{}" }),
  pauseMailCopilotRun: (paneId: string) => request<MailCopilotRunView>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/run/pause`, { method: "POST", body: "{}" }),
  stopMailCopilotRun: (paneId: string) => request<MailCopilotRunView>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/run/stop`, { method: "POST", body: "{}" }),
  requestMailFix: (paneId: string, input: MailCopilotFixRequest) =>
    request<{ event: { id: string }; runStarted: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/fix`, { method: "POST", body: JSON.stringify(input) }),
  mailFixRequests: (paneId: string) => request<{ requests: MailFixRequestView[] }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/fix-requests`, { cache: "no-store" }),
  mailActions: (paneId: string, query: { account?: string; source?: MailActionLogEntry["source"]; limit?: number } = {}) =>
    request<{ actions: MailActionLogEntry[] }>(`/api/mail-copilot/actions?${new URLSearchParams({ paneId, ...(query.account ? { account: query.account } : {}), ...(query.source ? { source: query.source } : {}), ...(query.limit ? { limit: String(query.limit) } : {}) })}`, { cache: "no-store" }),
  syncMailCopilot: (paneId: string) => request<{ accounts: number; created: number }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/sync`, { method: "POST", body: "{}" }),
  mailCopilotEvents: (query: { paneId?: string; threadId?: string; since?: string; limit?: number } = {}) =>
    request<{ events: MailCopilotEvent[] }>(`/api/mail-copilot/events?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))}`, { cache: "no-store" }),
  answerMailQuestion: (paneId: string, input: { questionId: string; answer: string }) =>
    request<{ memory: MailCopilotMemory }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/answer`, { method: "POST", body: JSON.stringify(input) }),
  decideMailReview: (paneId: string, input: MailCopilotReviewDecision) =>
    request<{ decision: string; sent: { messageId: string; threadId: string } | null }>(`/api/panes/${encodeURIComponent(paneId)}/mail-copilot/review`, { method: "POST", body: JSON.stringify(input) }),
  mailMemory: (query: Partial<MailCopilotMemoryQuery> = {}) =>
    request<{ memories: MailCopilotMemory[] }>(`/api/mail-copilot/memory?${new URLSearchParams({ ...(query.query ? { query: query.query } : {}), ...(query.kinds?.length ? { kinds: query.kinds.join(",") } : {}),
      ...(query.pinnedOnly ? { pinnedOnly: "true" } : {}), ...(query.limit ? { limit: String(query.limit) } : {}) })}`, { cache: "no-store" }),
  rememberMailMemory: (input: MailCopilotMemoryCreate) => request<{ memory: MailCopilotMemory }>("/api/mail-copilot/memory", { method: "POST", body: JSON.stringify(input) }),
  updateMailMemory: (id: string, input: MailCopilotMemoryUpdate) => request<{ memory: MailCopilotMemory }>(`/api/mail-copilot/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  mailRules: (query: { status?: MailRule["status"][] } = {}) =>
    request<{ rules: MailRule[] }>(`/api/mail-copilot/rules${query.status?.length ? `?status=${query.status.join(",")}` : ""}`, { cache: "no-store" }),
  createMailRule: (input: MailRuleProposal) => request<{ rule: MailRule }>("/api/mail-copilot/rules", { method: "POST", body: JSON.stringify(input) }),
  decideMailRule: (id: string, input: MailRuleDecision) => request<{ rule: MailRule }>(`/api/mail-copilot/rules/${encodeURIComponent(id)}/decide`, { method: "POST", body: JSON.stringify(input) }),
  forgetMailMemory: (id: string) => request<{ forgotten: boolean }>(`/api/mail-copilot/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mailHabits: (paneId: string) => request<{ habits: MailHabitSender[] }>(`/api/mail-copilot/habits?${new URLSearchParams({ paneId })}`, { cache: "no-store" }),
  forgetMailHabits: (paneId: string, account: string, sender: string) =>
    request<{ forgotten: number; retired: number }>(`/api/mail-copilot/habits?${new URLSearchParams({ paneId, account, sender })}`, { method: "DELETE" }),
  mailAttachmentUrl: (paneId: string | undefined, account: string, messageId: string, attachmentId: string) =>
    `/api/mail-copilot/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?${new URLSearchParams({ account, ...(paneId ? { paneId } : {}) })}`,
  // Job Copilot v2: run supervisor, queue, memory, fields, activity, questions and reviews.
  jobApplyRun: (paneId: string) => request<JobApplyRunView>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/run`, { cache: "no-store" }),
  startJobApplyRun: (paneId: string) =>
    request<JobApplyRunView & { kickoffSent: boolean }>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/run/start`, { method: "POST", body: "{}" }),
  pauseJobApplyRun: (paneId: string) => request<JobApplyRunView>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/run/pause`, { method: "POST", body: "{}" }),
  stopJobApplyRun: (paneId: string) => request<JobApplyRunView>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/run/stop`, { method: "POST", body: "{}" }),
  addJobApplyQueue: (paneId: string, urls: string[]) =>
    request<{ queued: JobApplication[]; existing: number; rejected: string[] }>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/queue`, { method: "POST", body: JSON.stringify({ urls }) }),
  discoverJobApplyPostings: (paneId: string, input: Partial<JobApplyDiscoverRequest>) =>
    request<JobApplyDiscoverResult>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/discover`, { method: "POST", body: JSON.stringify(input) }),
  reorderJobApplyQueue: (paneId: string, applicationIds: string[]) =>
    request<{ queue: JobApplication[] }>(`/api/panes/${encodeURIComponent(paneId)}/job-apply/queue/order`, { method: "PUT", body: JSON.stringify({ applicationIds }) }),
  removeJobApplication: (id: string) => request<{ removed: true }>(`/api/job-apply/applications/${encodeURIComponent(id)}`, { method: "DELETE" }),
  jobApplyFields: (applicationId: string) =>
    request<{ fields: JobApplicationField[] }>(`/api/job-apply/applications/${encodeURIComponent(applicationId)}/fields`, { cache: "no-store" }),
  editJobApplyField: (id: string, value: string | null) =>
    request<{ field: JobApplicationField }>(`/api/job-apply/fields/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ value }) }),
  jobApplyMemory: (query: Partial<JobApplyMemoryQuery> = {}) => {
    const params = new URLSearchParams();
    if (query.query) params.set("query", query.query);
    if (query.site) params.set("site", query.site);
    if (query.company) params.set("company", query.company);
    if (query.kinds && query.kinds.length > 0) params.set("kinds", query.kinds.join(","));
    if (query.pinnedOnly) params.set("pinnedOnly", "true");
    if (query.limit) params.set("limit", String(query.limit));
    const text = params.toString();
    return request<{ memories: JobApplyMemory[]; total: number }>(`/api/job-apply/memory${text ? `?${text}` : ""}`, { cache: "no-store" });
  },
  rememberJobApplyMemory: (input: JobApplyMemoryCreate) =>
    request<{ memory: JobApplyMemory }>("/api/job-apply/memory", { method: "POST", body: JSON.stringify(input) }),
  updateJobApplyMemory: (id: string, input: JobApplyMemoryUpdate) =>
    request<{ memory: JobApplyMemory }>(`/api/job-apply/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  forgetJobApplyMemory: (id: string) => request<{ forgotten: true }>(`/api/job-apply/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  jobApplyEvents: (query: { paneId?: string; applicationId?: string; runId?: string; since?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
    const text = params.toString();
    return request<{ events: JobApplyEvent[] }>(`/api/job-apply/events${text ? `?${text}` : ""}`, { cache: "no-store" });
  },
  answerJobApplyQuestion: (applicationId: string, input: { questionId: string; answer: string }) =>
    request<{ memory: JobApplyMemory }>(`/api/job-apply/applications/${encodeURIComponent(applicationId)}/answer`, { method: "POST", body: JSON.stringify(input) }),
  decideJobApplyReview: (applicationId: string, input: JobApplyReviewDecision) =>
    request<{ decision: string }>(`/api/job-apply/applications/${encodeURIComponent(applicationId)}/review`, { method: "POST", body: JSON.stringify(input) }),
  launchReadiness: () => request<LaunchReadiness>("/api/admin/launch-readiness"),
  observability: () => request<ObservabilitySnapshot>("/api/admin/observability"),
  worker: () => request<WorkerReadiness>("/api/admin/worker"),

  // Native File Manager API
  filesList: (query: { path?: string; showHidden?: boolean; mode?: "user" | "admin" } = {}) => {
    const params = new URLSearchParams();
    if (query.path) params.set("path", query.path);
    if (query.showHidden !== undefined) params.set("showHidden", String(query.showHidden));
    if (query.mode) params.set("mode", query.mode);
    return request<FileListResponse>(`/api/files/list?${params.toString()}`, { cache: "no-store" });
  },
  filesDiskUsage: () =>
    request<FileDiskUsageResponse>("/api/files/disk-usage", { cache: "no-store" }),
  filesRead: (query: { path: string; mode?: "user" | "admin"; raw?: boolean }) => {
    const params = new URLSearchParams({ path: query.path });
    if (query.mode) params.set("mode", query.mode);
    if (query.raw) params.set("raw", "true");
    return request<FileReadResponse>(`/api/files/read?${params.toString()}`, { cache: "no-store" });
  },
  filesWrite: (input: { path: string; content: string; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; path: string; size: number; mtime: string }>("/api/files/write", {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  filesCreate: (input: { path: string; type: "file" | "directory"; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; path: string; name: string; isDirectory: boolean; mtime: string }>("/api/files/create", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  filesRename: (input: { oldPath: string; newPath: string; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; oldPath: string; newPath: string }>("/api/files/rename", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  filesChmod: (input: { path: string; octalPermissions: string; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; path: string; mode: number; permissions: string; octalPermissions: string }>(
      "/api/files/chmod",
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    ),
  filesDelete: (input: { path: string; recursive?: boolean; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; path: string }>("/api/files/delete", {
      method: "DELETE",
      body: JSON.stringify(input)
    }),
  filesSearch: (query: { path?: string; query: string; mode?: "user" | "admin"; limit?: number }) => {
    const params = new URLSearchParams({ query: query.query });
    if (query.path) params.set("path", query.path);
    if (query.mode) params.set("mode", query.mode);
    if (query.limit) params.set("limit", String(query.limit));
    return request<FileSearchResponse>(`/api/files/search?${params.toString()}`, { cache: "no-store" });
  },
  filesUpload: (formData: FormData) =>
    request<{ ok: boolean; uploadedCount: number; files: string[] }>("/api/files/upload", {
      method: "POST",
      body: formData
    }),
  exportConfigurationUrl: "/api/configuration/export",
  exportConfiguration: (options?: { includeClosedPanes?: boolean; includeApiKeys?: boolean; includeCredentials?: boolean; passphrase?: string; cliAuthRuntimes?: string[] }) =>
    options && (options.includeClosedPanes || options.includeApiKeys || options.includeCredentials)
      ? request<SpaceConfigBundle>("/api/configuration/export", {
          method: "POST",
          body: JSON.stringify(options)
        })
      : request<SpaceConfigBundle>("/api/configuration/export", { cache: "no-store" }),
  configurationCliLogins: () => request<{ items: ConfigurationCliLogin[] }>("/api/configuration/cli-logins", { cache: "no-store" }),
  inspectConfiguration: (bundle: unknown) =>
    request<ConfigurationInspectResult>("/api/configuration/inspect", {
      method: "POST",
      body: JSON.stringify({ bundle })
    }),
  importConfiguration: (input: {
    bundle: unknown;
    mode?: ImportConfigMode;
    confirmReplace?: boolean;
    targetUserId?: string;
    importApiKeys?: boolean;
    importCredentials?: boolean;
    passphrase?: string;
    cliAuthRuntimes?: string[];
    cliAuthConflict?: "backup-and-replace" | "skip-if-logged-in";
    pathRewrite?: { from: string; to: string };
  }) =>
    request<ImportConfigResult>("/api/configuration/import", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  // Database Manager API methods
  databasesListConnections: (options?: { projectPath?: string | null; mode?: "user" | "admin" }) => {
    const params = new URLSearchParams();
    if (options?.projectPath) params.set("projectPath", options.projectPath);
    if (options?.mode) params.set("mode", options.mode);
    return request<{ ok: boolean; connections: DatabaseConnection[] }>(`/api/databases/connections?${params.toString()}`);
  },
  databasesGetConnection: (id: string, mode?: "user" | "admin") =>
    request<{ ok: boolean; connection: DatabaseConnection }>(`/api/databases/connections/${encodeURIComponent(id)}${mode ? `?mode=${mode}` : ""}`),
  databasesCreateConnection: (input: CreateDatabaseConnectionInput) =>
    request<{ ok: boolean; connection: DatabaseConnection }>("/api/databases/connections", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  databasesUpdateConnection: (id: string, input: UpdateDatabaseConnectionInput, mode?: "user" | "admin") =>
    request<{ ok: boolean; connection: DatabaseConnection }>(`/api/databases/connections/${encodeURIComponent(id)}${mode ? `?mode=${mode}` : ""}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  databasesDeleteConnection: (id: string, mode?: "user" | "admin") =>
    request<{ ok: boolean }>(`/api/databases/connections/${encodeURIComponent(id)}${mode ? `?mode=${mode}` : ""}`, {
      method: "DELETE"
    }),
  databasesTestConnection: (input: CreateDatabaseConnectionInput) =>
    request<{ ok: boolean; version?: string; error?: string }>("/api/databases/connections/test", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  databasesDiscover: (roomId?: string, projectPath?: string) => {
    const params = new URLSearchParams();
    if (projectPath) params.set("projectPath", projectPath);
    const url = roomId ? `/api/rooms/${encodeURIComponent(roomId)}/databases/discover?${params.toString()}` : `/api/rooms/any/databases/discover?${params.toString()}`;
    return request<{ ok: boolean; discovered: DatabaseDiscoveryItem[] }>(url);
  },
  databasesGetCatalog: (connectionId: string, database?: string, mode?: "user" | "admin") => {
    const params = new URLSearchParams();
    if (database) params.set("database", database);
    if (mode) params.set("mode", mode);
    return request<{ ok: boolean; catalog: DatabaseCatalog }>(`/api/databases/connections/${encodeURIComponent(connectionId)}/catalog?${params.toString()}`);
  },
  databasesGetTableData: (connectionId: string, tableName: string, query: DatabaseTableDataQuery & { mode?: "user" | "admin" }) => {
    const params = new URLSearchParams();
    if (query.schema) params.set("schema", query.schema);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("pageSize", String(query.pageSize));
    if (query.sortColumn) params.set("sortColumn", query.sortColumn);
    if (query.sortDirection) params.set("sortDirection", query.sortDirection);
    if (query.search) params.set("search", query.search);
    if (query.filterColumn) params.set("filterColumn", query.filterColumn);
    if (query.filterValue) params.set("filterValue", query.filterValue);
    if (query.filterOp) params.set("filterOp", query.filterOp);
    if (query.mode) params.set("mode", query.mode);
    return request<{ ok: boolean } & DatabaseTableDataResponse>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}/data?${params.toString()}`
    );
  },
  databasesInsertRow: (connectionId: string, tableName: string, body: { schema?: string; values: Record<string, unknown>; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}/rows${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  databasesUpdateRow: (connectionId: string, tableName: string, body: { schema?: string; keys: Record<string, unknown>; values: Record<string, unknown>; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}/rows${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "PUT", body: JSON.stringify(body) }
    ),
  databasesDeleteRow: (connectionId: string, tableName: string, body: { schema?: string; keys: Record<string, unknown>; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; affectedRows: number }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}/rows${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "DELETE", body: JSON.stringify(body) }
    ),
  databasesCreateTable: (connectionId: string, body: { schema?: string; tableName: string; columns: Array<{ name: string; type: string; nullable?: boolean; defaultValue?: string; isPrimaryKey?: boolean }>; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; message?: string }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  databasesAlterTable: (connectionId: string, tableName: string, body: { action: "ADD_COLUMN" | "DROP_COLUMN" | "ADD_INDEX" | "DROP_INDEX"; schema?: string; column?: { name: string; type: string; nullable?: boolean; defaultValue?: string }; columnName?: string; index?: { name: string; columns: string[]; unique?: boolean }; indexName?: string; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; message?: string }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}/structure${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "PUT", body: JSON.stringify(body) }
    ),
  databasesDropTable: (connectionId: string, tableName: string, schema?: string, mode?: "user" | "admin") => {
    const params = new URLSearchParams();
    if (schema) params.set("schema", schema);
    if (mode) params.set("mode", mode);
    return request<{ ok: boolean; message?: string }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/tables/${encodeURIComponent(tableName)}?${params.toString()}`,
      { method: "DELETE" }
    );
  },
  databasesExecuteSql: (body: DatabaseExecuteSqlRequest & { mode?: "user" | "admin" }) =>
    request<DatabaseExecuteSqlResponse>(`/api/databases/sessions/execute${body.mode ? `?mode=${body.mode}` : ""}`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  databasesCancelSql: (sessionId: string, connectionId: string) =>
    request<{ ok: boolean }>(`/api/databases/sessions/${encodeURIComponent(sessionId)}/cancel?connectionId=${encodeURIComponent(connectionId)}`, {
      method: "POST"
    }),
  databasesImport: (connectionId: string, body: { format: "SQL" | "CSV"; table?: string; schema?: string; content: string; mode?: "user" | "admin" }) =>
    request<{ ok: boolean; importedRows: number; message?: string }>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/transfers/import${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  databasesExport: (connectionId: string, body: { format: "SQL" | "CSV"; table?: string; schema?: string; includeStructure?: boolean; includeData?: boolean; mode?: "user" | "admin" }) =>
    request<string>(
      `/api/databases/connections/${encodeURIComponent(connectionId)}/transfers/export${body.mode ? `?mode=${body.mode}` : ""}`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  /** A video request from a pane the operator works in (the Live pane); the Video pane of the room delivers it as Media. */
  requestVideoFromPane: (paneId: string, input: import("@space/contracts").VideoRequestCreateInput) =>
    request<{ request: import("@space/contracts").VideoRequest; assets: unknown[]; videoPaneId: string | null; runStarted: boolean }>("/api/video/requests", {
      method: "POST",
      body: JSON.stringify({ fromPaneId: paneId, ...input })
    })
};
