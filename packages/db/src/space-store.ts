import pg from "pg";
import { createHash } from "node:crypto";
import {
  adminOperationRunSchema,
  agentPaneBindingSchema,
  agentPaneStoredSessionSchema,
  auditEventSchema,
  artifactSchema,
  authUserSchema,
  browserCaptureJobSchema,
  browserCaptureSegmentSchema,
  browserControlLeaseSchema,
  buildCodexAppServerTurnWorkflowId,
  buildRoomAgentSupervisorWorkflowId,
  browserHandoffRequestSchema,
  clipboardItemSchema,
  cliMaintenanceAuthHandoffSchema,
  cliMaintenanceEventSchema,
  cliRuntimeSettingSchema,
  cliToggleRuntimeIdSchema,
  cliToggleRuntimeIds,
  codexCliModeDefaultsSchema,
  codexCliModeDefaultPairsSchema,
  createAdminOperationRunInputSchema,
  createCliMaintenanceAuthHandoffInputSchema,
  createCliMaintenanceEventInputSchema,
  createUserLinkRequestSchema,
  codexAppServerHandshakeCheckSchema,
  codexAppServerTurnSmokeCheckSchema,
  createPaneBrowserSessionInputSchema,
  createBrowserCaptureJobInputSchema,
  createBrowserCaptureSegmentInputSchema,
  createBrowserControlLeaseInputSchema,
  createBrowserHandoffRequestInputSchema,
  createPaneCliSessionInputSchema,
  createPaneCliHostOutputInputSchema,
  createPaneCliTerminalControlLeaseInputSchema,
  createPaneCliTranscriptChunkInputSchema,
  createRoomAgentActionInputSchema,
  createRoomAgentMissionInputSchema,
  createRoomAgentRequestInputSchema,
  createProviderInputSchema,
  createSpaceAgentMessageInputSchema,
  createSpaceAgentRunInputSchema,
  createSpaceAgentSessionInputSchema,
  eventSchema,
  importCandidateSchema,
  idSchema,
  claimMemoryCommandInputSchema,
  createMemoryConsolidationFindingInputSchema,
  createMemoryConsolidationOperationInputSchema,
  createMemoryConsolidationRunInputSchema,
  linkMemoryCacheInputSchema,
  listClipboardItemsQuerySchema,
  listUserLinksQuerySchema,
  listMemoryCacheLinksQuerySchema,
  memoryCacheLinkSchema,
  memoryCommandIdempotencySchema,
  memoryConsolidationFindingSchema,
  memoryConsolidationOperationSchema,
  memoryConsolidationRunSchema,
  memoryIssueStateSchema,
  memoryEmbeddingSmokeCheckSchema,
  memoryVectorReadinessSchema,
  memoryEntrySchema,
  memoryChangeSetSchema,
  memoryChangeSetSummarySchema,
  mcpDiscoverySmokeCheckSchema,
  mcpServerSchema,
  mcpToolSchema,
  movePaneInputSchema,
  modelSchema,
  paneSchema,
  paneBrowserSessionSchema,
  paneCliSessionSchema,
  paneCliTerminalControlLeaseSchema,
  paneCliCodexThreadOwnershipSchema,
  paneCliTranscriptChunkSchema,
  providerSchema,
  providerSettingsSchema,
  providerValidationResultSchema,
  releasePreviewSchema,
  reviewCheckSchema,
  reviewDiffSummarySchema,
  roomSchema,
  roomAgentActionRecordSchema,
  roomAgentMissionRecordSchema,
  roomAgentRequestRecordSchema,
  roomAgentTaskRunRecordSchema,
  roomAgentSupervisorQueueItemSchema,
  setupConnectionCheckEventSchema,
  setupConnectionCheckRunSchema,
  spaceAgentMessageRecordSchema,
  spaceAgentRunRecordSchema,
  spaceAgentSessionRecordSchema,
  sourceControlConnectionSchema,
  sourceControlProviderSchema,
  updatePaneCliSessionInputSchema,
  updatePaneCliTerminalControlLeaseInputSchema,
  updatePaneBrowserSessionInputSchema,
  updateBrowserCaptureJobInputSchema,
  updateBrowserCaptureSegmentInputSchema,
  updateBrowserControlLeaseInputSchema,
  updateBrowserHandoffRequestInputSchema,
  updateMemoryChangeSetInputSchema,
  updateMemoryConsolidationFindingInputSchema,
  updateMemoryConsolidationOperationInputSchema,
  updateMemoryConsolidationRunInputSchema,
  upsertMemoryIssueStateInputSchema,
  updateArtifactRetentionInputSchema,
  updateProviderInputSchema,
  updateProviderSettingsInputSchema,
  updateCodexCliModeDefaultsInputSchema,
  updateCliRuntimeSettingInputSchema,
  updateCliRuntimeVpnInputSchema,
  updateAdminOperationRunInputSchema,
  updateCliMaintenanceAuthHandoffInputSchema,
  swarmLockSchema,
  swarmMessageSchema,
  swarmReconcileSchema,
  swarmStateSchema,
  swarmTaskSchema,
  turnSchema,
  updateSpaceAgentMessageInputSchema,
  updateSpaceAgentRunInputSchema,
  updateSpaceAgentSessionInputSchema,
  updateRoomAgentActionInputSchema,
  updateRoomAgentMissionInputSchema,
  upsertRoomAgentTaskRunInputSchema,
  upsertAgentPaneStoredSessionInputSchema,
  updateAgentPaneBindingInputSchema,
  upsertAgentPaneBindingInputSchema,
  upsertClipboardItemInputSchema,
  updateUserLinkRequestSchema,
  userLinkSchema,
  workflowRunSchema,
  type AgentPaneBinding,
  type AdminOperationRun,
  type AgentPaneHistoryItem,
  type AgentPaneStoredSession,
  type AuditEvent,
  type Artifact,
  type BrowserCaptureJob,
  type BrowserCaptureSegment,
  type BrowserControlLease,
  type BrowserHandoffRequest,
  type AuthUser,
  type Capability,
  type ClipboardItem,
  type CliMaintenanceAuthHandoff,
  type CliMaintenanceEvent,
  type CliRuntimeSetting,
  type CliToggleRuntimeId,
  type CreateUserLinkRequest,
  type CodexAppServerHandshakeCheck,
  type CodexAppServerTurnSmokeCheck,
  type CodexCliModeDefaultPairs,
  type CodexCliModeDefaults,
  type CreateAuditEventInput,
  type CreateAdminOperationRunInput,
  type CreateArtifactInput,
  type CreateBrowserCaptureJobInput,
  type CreateBrowserCaptureSegmentInput,
  type CreateBrowserControlLeaseInput,
  type CreateBrowserHandoffRequestInput,
  type CreateCliMaintenanceAuthHandoffInput,
  type CreateCliMaintenanceEventInput,
  type CreateImportCandidateInput,
  type CreateMemoryChangeSetInput,
  type ClaimMemoryCommandInput,
  type CreateMemoryConsolidationFindingInput,
  type CreateMemoryConsolidationOperationInput,
  type CreateMemoryConsolidationRunInput,
  type CreateMemoryEntryInput,
  type CreatePaneInput,
  type CreatePaneBrowserSessionInput,
  type CreatePaneCliSessionInput,
  type CreatePaneCliHostOutputInput,
  type CreatePaneCliTerminalControlLeaseInput,
  type CreatePaneCliTranscriptChunkInput,
  type CreateProviderInput,
  type CreateReviewCheckInput,
  type CreateReviewDecisionInput,
  type CreateReviewDiffSummaryInput,
  type CreateRoomAgentActionInput,
  type CreateRoomAgentMissionInput,
  type CreateRoomAgentRequestInput,
  type CreateSpaceAgentMessageInput,
  type CreateSpaceAgentRunInput,
  type CreateSpaceAgentSessionInput,
  type CreateSkillProposalInput,
  type CreateSwarmReconcileInput,
  type CreateSwarmTaskInput,
  type Event,
  type ImportCandidate,
  type ImportCandidateDecisionInput,
  type ClaimSwarmLockInput,
  type ListArtifactsQuery,
  type ListClipboardItemsQuery,
  type ListUserLinksQuery,
  type ListImportCandidatesQuery,
  type ListMemoryChangeSetsQuery,
  type ListMemoryCacheLinksQuery,
  type ListMemoryIssueStatesQuery,
  type ListReviewChecksQuery,
  type ListReviewDecisionsQuery,
  type ListReviewDiffSummariesQuery,
  type ListMemoryQuery,
  type ListSwarmTasksQuery,
  type MemoryEmbeddingSmokeCheck,
  type MemoryChangeSet,
  type MemoryChangeSetSummary,
  type LinkMemoryCacheInput,
  type MemoryCacheLink,
  type MemoryCommandClaim,
  type MemoryCommandIdempotency,
  type MemoryConsolidationFinding,
  type MemoryConsolidationOperation,
  type MemoryConsolidationRun,
  type MemoryIssueState,
  type MemoryVectorReadiness,
  type MemoryEntry,
  type McpDiscoverySmokeCheck,
  type McpGatewayStatus,
  type McpServer,
  type McpTool,
  type Model,
  type MovePaneInput,
  type MovePaneResult,
  type Pane,
  type PaneBrowserSession,
  type PaneCliSession,
  type PaneCliTerminalControlLease,
  type PaneCliCodexThreadOwnership,
  type PaneCliCodexThreadOwnershipSource,
  type PaneCliTranscriptChunk,
  type PostSwarmMessageInput,
  type Provider,
  type ProviderSettings,
  type ProviderValidationResult,
  type ReleasePreview,
  type SetupConnectionCheckEvent,
  type SetupConnectionCheckRun,
  type ReleaseSwarmLockInput,
  type ReviewCheck,
  type ReviewDecision,
  type ReviewDiffSummary,
  type Room,
  type RoomCliActivity,
  type RoomPaneLayoutResult,
  type RoomAgentActionRecord,
  type RoomAgentMissionRecord,
  type RoomAgentRequestRecord,
  type RoomAgentTaskRunRecord,
  type Skill,
  type SpaceAgentMessageRecord,
  type SpaceAgentRunRecord,
  type SpaceAgentSessionRecord,
  type SourceControlProvider,
  type SwarmLock,
  type SwarmMessage,
  type SwarmReconcile,
  type SwarmState,
  type SwarmTask,
  type Turn,
  type UpdateAgentPaneBindingInput,
  type UpdateAdminOperationRunInput,
  type UpdateCliMaintenanceAuthHandoffInput,
  type UpdateArtifactRetentionInput,
  type UpdateUserLinkRequest,
  type UpdateBrowserCaptureJobInput,
  type UpdateBrowserCaptureSegmentInput,
  type UpdateBrowserControlLeaseInput,
  type UpdateBrowserHandoffRequestInput,
  type UpdateMemoryChangeSetInput,
  type UpdateMemoryConsolidationFindingInput,
  type UpdateMemoryConsolidationOperationInput,
  type UpdateMemoryConsolidationRunInput,
  type UpsertMemoryIssueStateInput,
  type UpdatePaneBrowserSessionInput,
  type UpdatePaneCliSessionInput,
  type UpdatePaneCliTerminalControlLeaseInput,
  type UpdatePaneLayoutInput,
  type UpdateRoomInput,
  type UpdateProviderInput,
  type UpdateProviderSettingsInput,
  type UpdateCodexCliModeDefaultsInput,
  type UpdateCliRuntimeSettingInput,
  type UpdateCliRuntimeVpnInput,
  type UpdateSpaceAgentMessageInput,
  type UpdateSpaceAgentRunInput,
  type UpdateSpaceAgentSessionInput,
  type UpdateRoomAgentActionInput,
  type UpdateRoomAgentMissionInput,
  type UpdateSwarmTaskInput,
  type UpdatePaneInput,
  type UpsertClipboardItemInput,
  type UpsertAgentPaneStoredSessionInput,
  type UpsertRoomAgentTaskRunInput,
  type UpsertAgentPaneBindingInput,
  type UserLink,
  type WorkflowRun
} from "@space/contracts";
import {
  ACTIVE_PANE_CAP,
  PANE_CLI_TRANSCRIPT_CHUNK_CAP,
  SpaceConflictError,
  assertBrowserHandoffTransition,
  assertMemorySearchModeEnabled,
  assertMemoryChangeStatusTransition,
  assertMemoryConsolidationFindingTransition,
  assertMemoryConsolidationOperationTransition,
  assertMemoryConsolidationRunTransition,
  assertMemoryRollbackTarget,
  SpaceNotFoundError,
  createStaticCatalog,
  defaultUserLinks,
  defaultPaneTitles,
  hashPrompt,
  makeSpaceId,
  nowIso,
  buildMcpGatewayStatusFromCatalog,
  normalizeMcpDiscoveryCatalog,
  normalizeArtifactInput,
  normalizeImportCandidateInput,
  normalizeMemoryChangeSetInput,
  memoryChangeSetMatchesInput,
  normalizeSwarmLockInput,
  normalizeSwarmMessageInput,
  normalizeSwarmReconcileInput,
  normalizeSwarmTaskInput,
  normalizeSwarmTaskUpdate,
  normalizeTelegramTaskTitle,
  hashSkillProposal,
  normalizeSkillProposalInput,
  replaceMcpCapabilities,
  redactArtifactMetadata,
  redactCliMaintenanceDiagnostics,
  redactMemoryText,
  type CompleteTurnInput,
  type ClipboardItemListResult,
  type CreateUserLinkInput,
  type CompleteSpaceAgentRunInput,
  type CompleteCodexCliTurnMarkerInput,
  type CompletedTurnRecord,
  type CompletedSpaceAgentRunRecord,
  type CodexCliTurnMarkerRecord,
  type CreateCodexCliTurnMarkerInput,
  type CreateMemoryEntryOptions,
  type CreateMemoryChangeSetOptions,
  type CreateQueuedTurnInput,
  type CreateRoomStoreInput,
  type EnqueueRoomAgentMissionInput,
  type FailedTurnRecord,
  type FailTurnInput,
  type EventChange,
  type ListMemoryEntriesOptions,
  type ListStorePageInput,
  type ListEventChangesInput,
  type QueuedTurnRecord,
  type PublicWaitlistSignupInput,
  type PublicWaitlistSignupOutcome,
  type CreateReleasePreviewStoreInput,
  type ReleasePreviewRecord,
  type RoomAgentEnqueueRecord,
  type RecordCodexAppServerHandshakeInput,
  type RecordCodexAppServerTurnSmokeInput,
  type RecordMemoryEmbeddingSmokeInput,
  type RecordMcpDiscoveryCatalogInput,
  type RecordMcpDiscoverySmokeInput,
  type McpDiscoveryCatalogRecord,
  type MemoryEntryRecord,
  type ArtifactRecord,
  type ImportCandidateDecisionRecord,
  type ImportCandidateRecord,
  type ReviewCheckRecord,
  type ReviewDecisionRecord,
  type ReviewDiffSummaryRecord,
  type SkillProposalRecord,
  type SwarmLockRecord,
  type SwarmMessageRecord,
  type SwarmReconcileRecord,
  type SwarmTaskRecord,
  type SpaceStore,
  type SourceControlConnectionRecord,
  type StorePageResult,
  type PaneCliTaskHistoryRecord,
  type CliTaskRecord,
  type CliTaskRevisionRecord,
  type CreateCliTaskRevisionInput,
  type ClaimOwnerSetupInput,
  type InitializeOwnerSetupInput,
  type OwnerCredentials,
  type OwnerSetupClaimResult,
  type OwnerSetupStatus,
  type PersistedSetupConnectionState,
  type SetupConnectionVerification,
  type CreateSetupConnectionCheckEventInput,
  type CreateSetupConnectionCheckRunInput,
  type UpdateSetupConnectionCheckRunInput,
  type UpsertSetupConnectionVerificationInput,
  createSetupConnectionCheckEventInputSchema,
  createSetupConnectionCheckRunInputSchema,
  currentSetupOnboardingVersion,
  updateSetupConnectionCheckRunRecord,
  type UpdateCliTaskRevisionInput,
  type UserLinkListResult,
  type UpsertSourceControlConnectionInput,
  type StaticCatalogOptions
} from "@space/runtime";
import type { SetupOnboarding } from "@space/contracts";
import type { TelegramOutboxPersistence, TelegramPersistence } from "@space/runtime";
import { PostgresTelegramPersistence } from "./telegram-persistence.js";

const { Pool } = pg;

export interface PgQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release?(): void;
}

export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike>;
}

export interface PostgresPoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function createSpacePgPool(
  connectionString: string,
  poolOptions: PostgresPoolOptions = {},
  defaultMax = 10
): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: poolOptions.max ?? defaultMax,
    idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? 5_000,
    onConnect: (client) => {
      client.on("error", (error: Error) => {
        console.error("[db] Postgres pool client connection error:", error?.message ?? error);
      });
    }
  });
  pool.on("error", (error: Error) => {
    console.error("[db] Postgres pool connection error:", error?.message ?? error);
  });
  return pool;
}

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  kind: Room["kind"];
  order: number;
  paneLayoutColumns: Room["paneLayoutColumns"];
  paneCap: number;
  traceId: string;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type ClipboardItemRow = {
  id: string;
  text: string;
  source: ClipboardItem["source"];
  title: string | null;
  roomId: string | null;
  paneId: string | null;
  paneTitle: string | null;
  occurrenceCount: number;
  characterCount: number;
  createdAt: Date | string;
  lastUsedAt: Date | string;
};

type UserLinkRow = Omit<UserLink, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

type PaneRow = {
  id: string;
  roomId: string;
  title: string;
  mode: Pane["mode"];
  status: Pane["status"];
  providerId: string | null;
  modelId: string | null;
  terminalRuntimeId: string | null;
  reasoningEffort: Pane["reasoningEffort"];
  cwd: string | null;
  order: number;
  columnSpan: number;
  isMaximized: boolean;
  isMinimized: boolean;
  isClosed: boolean;
  split: Pane["split"];
  createdAt: Date | string;
  updatedAt: Date | string;
};

type AgentPaneBindingRow = {
  paneId: string;
  source: AgentPaneBinding["source"];
  coderChatId: string | null;
  status: AgentPaneBinding["status"];
  title: string;
  selectedModelConfigId: string | null;
  selectedProviderName: string | null;
  selectedModelName: string | null;
  selectedReasoningKey: string | null;
  selectedToolIds: string[] | null;
  lastSyncedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type AgentPaneHistoryRow = AgentPaneBindingRow & {
  roomId: string;
  paneTitle: string;
  paneIsClosed: boolean;
};

type AgentPaneStoredSessionRow = {
  paneId: string;
  roomId: string;
  source: AgentPaneStoredSession["source"];
  coderChatId: string;
  status: AgentPaneStoredSession["status"];
  title: string;
  selectedModelConfigId: string | null;
  selectedProviderName: string | null;
  selectedModelName: string | null;
  selectedReasoningKey: string | null;
  selectedToolIds: string[] | null;
  lastSyncedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type SpaceAgentSessionRow = {
  sessionId: string;
  paneId: string;
  roomId: string;
  source: SpaceAgentSessionRecord["source"];
  status: SpaceAgentSessionRecord["status"];
  title: string;
  threadId: string | null;
  selectedProviderId: string | null;
  selectedModelId: string | null;
  selectedModelConfigId: string | null;
  selectedProviderName: string | null;
  selectedModelName: string | null;
  selectedReasoningKey: string | null;
  selectedToolIds: string[] | null;
  permissionMode: SpaceAgentSessionRecord["permissionMode"];
  collaborationMode: SpaceAgentSessionRecord["collaborationMode"];
  isActive: boolean;
  lastSyncedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type SpaceAgentMessageRow = {
  messageId: string;
  sessionId: string;
  runId: string | null;
  role: SpaceAgentMessageRecord["role"];
  content: string;
  status: SpaceAgentMessageRecord["status"];
  createdAt: Date | string;
  updatedAt: Date | string;
};

type SpaceAgentRunRow = {
  runId: string;
  sessionId: string;
  paneId: string;
  roomId: string;
  workflowId: string;
  temporalRunId: string | null;
  codexThreadId: string | null;
  codexTurnId: string | null;
  status: SpaceAgentRunRecord["status"];
  promptMessageId: string;
  responseMessageId: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

type RoomAgentRequestRow = Omit<RoomAgentRequestRecord, "createdAt"> & { createdAt: Date | string };
type RoomAgentRequestWithPayloadRow = RoomAgentRequestRow & { turnPayload: unknown; signaledAt: Date | string | null };
type RoomAgentMissionRow = Omit<
  RoomAgentMissionRecord,
  "queuedAt" | "startedAt" | "completedAt" | "pausedAt" | "lastProgressAt" | "updatedAt"
> & {
  queuedAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  pausedAt: Date | string | null;
  lastProgressAt: Date | string | null;
  updatedAt: Date | string;
};
type RoomAgentActionRow = Omit<RoomAgentActionRecord, "createdAt" | "updatedAt" | "completedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};
type RoomAgentTaskRunRow = {
  runId: string;
  missionId: string;
  roomId: string;
  stepId: string;
  paneId: string;
  label: string;
  instruction: string;
  status: RoomAgentTaskRunRecord["status"];
  resultPayload: Omit<RoomAgentTaskRunRecord, "runId" | "missionId" | "roomId" | "stepId" | "paneId" | "label" | "instruction" | "status" | "queuedAt" | "startedAt" | "firstResponseAt" | "completedAt" | "updatedAt">;
  queuedAt: Date | string;
  startedAt: Date | string | null;
  firstResponseAt: Date | string | null;
  completedAt: Date | string | null;
  updatedAt: Date | string;
};

type PaneCliSessionRow = {
  sessionId: string;
  paneId: string;
  roomId: string;
  runtimeId: string;
  providerId: string;
  agentId: string;
  modelId: string | null;
  reasoningEffort: PaneCliSession["reasoningEffort"];
  launchMode: PaneCliSession["launchMode"];
  purpose: PaneCliSession["purpose"];
  cwd: string | null;
  codexThreadId: string | null;
  cliTaskId: string | null;
  cliTaskRevisionId: string | null;
  status: PaneCliSession["status"];
  statusReason: string | null;
  exitCode: number | null;
  isActive: boolean;
  startedAt: Date | string;
  updatedAt: Date | string;
  endedAt: Date | string | null;
};

type PaneCliTerminalControlLeaseRow = Omit<
  PaneCliTerminalControlLease,
  "acquiredAt" | "heartbeatAt" | "expiresAt" | "releasedAt"
> & {
  acquiredAt: Date | string;
  heartbeatAt: Date | string;
  expiresAt: Date | string;
  releasedAt: Date | string | null;
};

type PaneCliTaskHistoryRow = PaneCliSessionRow & {
  taskId: string;
  revisionId: string;
  revisionRuntimeId: string;
  revisionProviderId: string;
  revisionAgentId: string;
  nativeTaskRef: string | null;
  sourceRevisionId: string | null;
  latestSpaceSessionId: string | null;
  displayTitle: string;
  revisionFirstUserMessage: string;
  revisionPreview: string;
  revisionCwd: string | null;
  revisionModelId: string | null;
  revisionReasoningEffort: PaneCliSession["reasoningEffort"];
  revisionCreatedAt: Date | string;
  revisionUpdatedAt: Date | string;
  paneTitle: string;
  firstUserMessage: string;
  preview: string;
  recencyAt: Date | string;
  total: number | string;
};

type CliTaskRow = {
  taskId: string;
  currentRevisionId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type CliTaskRevisionRow = {
  revisionId: string;
  taskId: string;
  runtimeId: string;
  providerId: string;
  agentId: string;
  nativeTaskRef: string | null;
  sourceRevisionId: string | null;
  latestSpaceSessionId: string | null;
  displayTitle: string;
  firstUserMessage: string;
  preview: string;
  cwd: string | null;
  modelId: string | null;
  reasoningEffort: PaneCliSession["reasoningEffort"];
  createdAt: Date | string;
  updatedAt: Date | string;
};

type PaneCliTranscriptChunkRow = {
  chunkId: string;
  sessionId: string;
  paneId: string;
  roomId: string;
  sequence: number;
  stream: PaneCliTranscriptChunk["stream"];
  content: string;
  byteLength: number;
  hostGenerationId?: string | null;
  hostOutputSequence?: number | string | null;
  createdAt: Date | string;
};

type CodexCliTurnMarkerRow = Omit<
  CodexCliTurnMarkerRecord,
  "checkAttemptCount" | "submittedAt" | "completedAt" | "nextCheckAt" | "lockedAt" | "updatedAt"
> & {
  checkAttemptCount: number | string;
  submittedAt: Date | string;
  completedAt: Date | string | null;
  nextCheckAt: Date | string;
  lockedAt: Date | string | null;
  updatedAt: Date | string;
};

type PaneCliCodexThreadOwnershipRow = {
  threadId: string;
  roomId: string;
  paneId: string;
  cliSessionId: string;
  source: PaneCliCodexThreadOwnership["source"];
  createdAt: Date | string;
  updatedAt: Date | string;
};

type PaneBrowserSessionRow = {
  sessionId: string;
  paneId: string;
  roomId: string;
  ownerAgentId: string | null;
  agentNumber: number;
  profileId: string;
  profilePath: string;
  viewport: PaneBrowserSession["viewport"];
  targetUrl: string | null;
  currentUrl: string | null;
  title: string | null;
  status: PaneBrowserSession["status"];
  statusReason: string | null;
  lastFrameAt: Date | string | null;
  streamMode: PaneBrowserSession["streamMode"];
  resolvedStreamMode: PaneBrowserSession["resolvedStreamMode"];
  runtimeState: PaneBrowserSession["runtimeState"];
  capacityState: PaneBrowserSession["capacityState"];
  controlState: PaneBrowserSession["controlState"];
  pages: PaneBrowserSession["pages"];
  activePageId: string | null;
  workerHeartbeatAt: Date | string | null;
  queuePosition: number | null;
  restoreScrollX: number | null;
  restoreScrollY: number | null;
  restoreVideoPaused: boolean | null;
  isActive: boolean;
  startedAt: Date | string;
  updatedAt: Date | string;
  endedAt: Date | string | null;
};

type BrowserControlLeaseRow = Omit<BrowserControlLease, "acquiredAt" | "heartbeatAt" | "expiresAt" | "releasedAt"> & {
  acquiredAt: Date | string;
  heartbeatAt: Date | string;
  expiresAt: Date | string;
  releasedAt: Date | string | null;
};

type BrowserCaptureJobRow = Omit<BrowserCaptureJob, "queuedAt" | "startedAt" | "updatedAt" | "completedAt"> & {
  queuedAt: Date | string;
  startedAt: Date | string | null;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

type BrowserCaptureSegmentRow = Omit<
  BrowserCaptureSegment,
  "byteSize" | "lastFrameSequence" | "startedAt" | "updatedAt" | "finalizedAt"
> & {
  byteSize: number | string;
  lastFrameSequence: number | string | null;
  startedAt: Date | string;
  updatedAt: Date | string;
  finalizedAt: Date | string | null;
};

type BrowserHandoffRequestRow = Omit<
  BrowserHandoffRequest,
  "requestedAt" | "expiresAt" | "acceptedAt" | "completedAt" | "expiredAt" | "cancelledAt" | "updatedAt"
> & {
  requestedAt: Date | string;
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  completedAt: Date | string | null;
  expiredAt: Date | string | null;
  cancelledAt: Date | string | null;
  updatedAt: Date | string;
};

type WorkflowRunRow = {
  workflowId: string;
  runId: string | null;
  type: WorkflowRun["type"];
  taskQueue: string;
  status: WorkflowRun["status"];
  roomId: string | null;
  paneId: string | null;
  traceId: string;
  startedAt: Date | string;
  closedAt: Date | string | null;
};

type TurnRow = {
  id: string;
  roomId: string;
  paneId: string | null;
  workflowId: string | null;
  providerId: string | null;
  modelId: string | null;
  status: Turn["status"];
  prompt?: string | null;
  promptHash: string;
  artifactIds?: string[] | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type EventRow = {
  id: string;
  roomId: string | null;
  paneId: string | null;
  turnId: string | null;
  workflowId: string | null;
  traceId: string;
  type: Event["type"];
  message: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
};

type EventChangeRow = EventRow & {
  relaySequence: number | string;
};

type AuditEventRow = {
  id: string;
  actorUserId: string | null;
  traceId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
};

type ProviderValidationCheckRow = {
  providerId: string;
  status: ProviderValidationResult["status"];
  code: ProviderValidationResult["code"];
  statusReason: string;
  maskedKeyPrefix: string | null;
  credentialLabel: string | null;
  modelCount: number | null;
  checkedAt: Date | string;
};

type ProviderRow = {
  id: string;
  displayName: string;
  type: Provider["type"];
  status: Provider["status"];
  statusReason: string | null;
  maskedKeyPrefix: string | null;
  baseUrl: string | null;
  healthCheckedAt: Date | string | null;
  routeProfile: Provider["routeProfile"];
  backingProviderId: string | null;
  credentialRef: string | null;
  isBuiltIn: boolean;
};

type ProviderSettingsRow = {
  defaultProviderId: string;
  titleGenerationModelId: string | null;
  titleGenerationReasoningEffort: ProviderSettings["titleGenerationReasoningEffort"];
  updatedAt: Date | string;
};

type CodexCliModeDefaultsRow = {
  buildModelId: string;
  buildReasoningEffort: string;
  planModelId: string;
  planReasoningEffort: string;
  runtimeInitialized: boolean;
  updatedAt: Date | string;
};

type CliRuntimeSettingRow = {
  runtimeId: string;
  enabled: boolean;
  vpnEnabled: boolean;
  updatedAt: Date | string;
  updatedBy: string | null;
};

type AdminOperationRunRow = {
  id: string;
  operationType: AdminOperationRun["operationType"];
  status: AdminOperationRun["status"];
  actorUserId: string | null;
  summary: string;
  result: Record<string, unknown>;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  updatedAt: Date | string;
};

type SetupConnectionCheckRunRow = Omit<
  SetupConnectionCheckRun,
  "totalCount" | "completedCount" | "createdAt" | "updatedAt" | "finishedAt"
> & {
  totalCount: number | string;
  completedCount: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  finishedAt: Date | string | null;
};

type SetupConnectionCheckEventRow = Omit<
  SetupConnectionCheckEvent,
  "sequence" | "createdAt"
> & {
  sequence: number | string;
  createdAt: Date | string;
};

type CliMaintenanceEventRow = Omit<CliMaintenanceEvent, "createdAt"> & {
  createdAt: Date | string;
};

type CliMaintenanceAuthHandoffRow = Omit<
  CliMaintenanceAuthHandoff,
  "createdAt" | "updatedAt" | "completedAt"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

type SourceControlConnectionRow = {
  provider: SourceControlProvider;
  repositoryOwner: "oll4com";
  repositoryName: "space";
  accountLogin: string | null;
  connectionStatus: SourceControlConnectionRecord["status"];
  secretRef: string | null;
  lastVerifiedAt: Date | string | null;
  lastVerificationCode: SourceControlConnectionRecord["lastVerificationCode"];
  updatedAt: Date | string;
};

type ReleasePreviewRow = {
  id: string;
  actorUserId: string | null;
  tag: string;
  notes: string;
  sourceCommit: string;
  previousTag: string | null;
  remoteMainCommits: ReleasePreview["remoteMainCommits"];
  expiresAt: Date | string;
  createdAt: Date | string;
};

type ModelRow = {
  id: string;
  providerId: string;
  displayName: string;
  status: Model["status"];
  capabilities: Record<string, unknown>;
};

type CodexAppServerHandshakeCheckRow = {
  checkId: string;
  actorUserId: string | null;
  traceId: string;
  status: CodexAppServerHandshakeCheck["status"];
  code: CodexAppServerHandshakeCheck["code"];
  message: string;
  transport: CodexAppServerHandshakeCheck["transport"];
  schemasGenerated: boolean;
  schemaManifest: CodexAppServerHandshakeCheck["schemaManifest"];
  serverInfo: Record<string, unknown> | null;
  startedAt: Date | string;
  finishedAt: Date | string;
  durationMs: number;
  checkedAt: Date | string;
};

type CodexAppServerTurnSmokeCheckRow = {
  checkId: string;
  actorUserId: string | null;
  traceId: string;
  status: CodexAppServerTurnSmokeCheck["status"];
  code: CodexAppServerTurnSmokeCheck["code"];
  message: string;
  transport: CodexAppServerTurnSmokeCheck["transport"];
  schemasGenerated: boolean;
  schemaManifest: CodexAppServerTurnSmokeCheck["schemaManifest"];
  model: string | null;
  threadId: string | null;
  turnId: string | null;
  turnStatus: CodexAppServerTurnSmokeCheck["turnStatus"];
  notificationCount: number;
  completedNotificationSeen: boolean;
  startedAt: Date | string;
  finishedAt: Date | string;
  durationMs: number;
  checkedAt: Date | string;
};

type McpDiscoverySmokeCheckRow = {
  checkId: string;
  actorUserId: string | null;
  traceId: string;
  status: McpDiscoverySmokeCheck["status"];
  code: McpDiscoverySmokeCheck["code"];
  message: string;
  targetSpecVersion: string;
  discoveryEnabled: boolean;
  serverCount: number;
  toolCount: number;
  startedAt: Date | string;
  finishedAt: Date | string;
  durationMs: number;
  checkedAt: Date | string;
};

type MemoryEmbeddingSmokeCheckRow = {
  checkId: string;
  actorUserId: string | null;
  traceId: string;
  status: MemoryEmbeddingSmokeCheck["status"];
  code: MemoryEmbeddingSmokeCheck["code"];
  message: string;
  smokeEnabled: boolean;
  provider: string | null;
  model: string | null;
  dimensions: number;
  pgvectorReady: boolean;
  embeddingProviderReady: boolean;
  startedAt: Date | string;
  finishedAt: Date | string;
  durationMs: number;
  checkedAt: Date | string;
};

type McpServerRow = {
  id: string;
  displayName: string;
  transport: McpServer["transport"];
  status: McpServer["status"];
  statusReason: string;
  schemaVersion: string;
  configHash: string;
  toolCount: number;
  lastDiscoveredAt: Date | string | null;
};

type McpToolRow = {
  id: string;
  serverId: string;
  name: string;
  riskLevel: McpTool["riskLevel"];
  schemaHash: string;
  approvalRequired: boolean;
  status: McpTool["status"];
  statusReason: string;
};

type MemoryEntryRow = {
  id: string;
  scope: MemoryEntry["scope"];
  roomId: string | null;
  title: string;
  body: string;
  provenance: string;
  createdAt: Date | string;
};

type MemoryCacheLinkRow = {
  memoryRecordId: string;
  canonicalMemoryId: string;
  linkSource: MemoryCacheLink["linkSource"];
  linkedAt: Date | string;
};
type MemoryCacheLinkCandidateRow = {
  memoryRecordId: string;
  canonicalMemoryId: string | null;
  linkSource: MemoryCacheLink["linkSource"] | null;
  linkedAt: Date | string | null;
};

type MemoryIssueStateRow = Omit<MemoryIssueState, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MemoryConsolidationRunRow = Omit<MemoryConsolidationRun, "createdAt" | "startedAt" | "completedAt" | "updatedAt"> & {
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  updatedAt: Date | string;
};

type MemoryConsolidationFindingRow = Omit<MemoryConsolidationFinding, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MemoryConsolidationOperationRow = Omit<MemoryConsolidationOperation, "createdAt" | "updatedAt" | "appliedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  appliedAt: Date | string | null;
};

type MemoryCommandIdempotencyRow = Omit<MemoryCommandIdempotency, "createdAt"> & {
  createdAt: Date | string;
};

type ArtifactRow = {
  id: string;
  roomId: string | null;
  paneId: string | null;
  turnId: string | null;
  workflowId: string | null;
  kind: Artifact["kind"];
  mimeType: string;
  storageUri: string;
  sha256: string;
  byteSize: number | string;
  metadata: Record<string, unknown>;
  expiresAt: Date | string | null;
  pinnedAt: Date | string | null;
  deletedAt: Date | string | null;
  createdAt: Date | string;
};

type SkillRow = {
  id: string;
  displayName: string;
  version: string;
  status: Skill["status"];
  statusReason: string | null;
  triggerDescription: string;
  body: string;
  allowedTools: string[];
  contentHash: string;
  source: Skill["source"];
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

type ImportCandidateRow = {
  id: string;
  sourceKind: ImportCandidate["sourceKind"];
  targetKind: ImportCandidate["targetKind"];
  status: ImportCandidate["status"];
  statusReason: string | null;
  sourceRef: string;
  roomId: string | null;
  memoryScope: ImportCandidate["memoryScope"];
  title: string;
  body: string;
  provenance: string;
  skillVersion: string | null;
  skillTriggerDescription: string | null;
  allowedTools: string[];
  importedMemoryId: string | null;
  importedSkillId: string | null;
  createdAt: Date | string;
  decidedAt: Date | string | null;
};

type MemoryChangeSetRow = {
  id: string;
  kind: MemoryChangeSet["kind"];
  status: MemoryChangeSet["status"];
  sourcePath: string;
  recordIds: string[];
  resolvesIssueIds: string[];
  expectedSourceHash: string;
  resultingSourceHash: string | null;
  beforeContentHash: string;
  afterContentHash: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  reason: string;
  statusReason: string | null;
  actorUserId: string;
  traceId: string;
  rollbackOfChangeSetId: string | null;
  rolledBackByChangeSetId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  appliedAt: Date | string | null;
  failedAt: Date | string | null;
  rolledBackAt: Date | string | null;
};

type MemoryChangeSetSummaryRow = Omit<MemoryChangeSetRow, "beforeSnapshot" | "afterSnapshot">;

type ReviewDecisionRow = {
  id: string;
  roomId: string;
  workflowId: string | null;
  decision: ReviewDecision["decision"];
  summary: string;
  evidenceArtifactIds: string[];
  rollbackNote: string;
  createdAt: Date | string;
};

type ReviewCheckRow = {
  id: string;
  roomId: string;
  reviewDecisionId: string | null;
  name: string;
  status: ReviewCheck["status"];
  command: string | null;
  summary: string;
  artifactIds: string[];
  metadata: Record<string, unknown>;
  createdAt: Date | string;
};

type ReviewDiffSummaryRow = {
  id: string;
  roomId: string;
  reviewDecisionId: string | null;
  title: string;
  filePath: string;
  status: ReviewDiffSummary["status"];
  additions: number | string;
  deletions: number | string;
  patchArtifactId: string | null;
  summary: string;
  createdAt: Date | string;
};

type SwarmTaskRow = {
  id: string;
  roomId: string;
  parentTaskId: string | null;
  role: SwarmTask["role"];
  title: string;
  goal: string;
  status: SwarmTask["status"];
  assignee: string | null;
  dependsOnTaskIds: string[];
  lockIds: string[];
  resultSummary: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

type SwarmLockRow = {
  id: string;
  roomId: string;
  taskId: string | null;
  resource: string;
  status: SwarmLock["status"];
  holder: string;
  reason: string;
  createdAt: Date | string;
  releasedAt: Date | string | null;
};

type SwarmMessageRow = {
  id: string;
  roomId: string;
  taskId: string | null;
  fromRole: SwarmMessage["fromRole"];
  toRole: SwarmMessage["toRole"];
  body: string;
  createdAt: Date | string;
};

type SwarmReconcileRow = {
  id: string;
  roomId: string;
  taskIds: string[];
  decision: SwarmReconcile["decision"];
  summary: string;
  nextSteps: string;
  createdAt: Date | string;
};

type CountRow = { count: string | number };
type OrderRow = { nextOrder: string | number };

const roomSelect = `
  SELECT
    id,
    name,
    description,
    kind,
    room_order AS "order",
    pane_layout_columns AS "paneLayoutColumns",
    pane_cap AS "paneCap",
    trace_id AS "traceId",
    archived_at AS "archivedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM rooms
`;

const clipboardItemSelect = `
  SELECT
    id,
    text,
    source,
    title,
    room_id AS "roomId",
    pane_id AS "paneId",
    pane_title AS "paneTitle",
    occurrence_count AS "occurrenceCount",
    character_count AS "characterCount",
    created_at AS "createdAt",
    last_used_at AS "lastUsedAt"
  FROM clipboard_items
`;

const userLinkSelect = `
  SELECT
    id,
    title,
    description,
    url,
    open_mode AS "openMode",
    is_quick AS "isQuick",
    sort_order AS "sortOrder",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM user_links
`;

const paneSelect = `
  SELECT
    id,
    room_id AS "roomId",
    title,
    mode,
    status,
    provider_id AS "providerId",
    model_id AS "modelId",
    terminal_runtime_id AS "terminalRuntimeId",
    reasoning_effort AS "reasoningEffort",
    cwd,
    pane_order AS "order",
    column_span AS "columnSpan",
    is_maximized AS "isMaximized",
    is_minimized AS "isMinimized",
    is_closed AS "isClosed",
    split,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM panes
`;

const agentPaneBindingSelect = `
  SELECT
    pane_id AS "paneId",
    source,
    coder_chat_id AS "coderChatId",
    status,
    title,
    selected_model_config_id AS "selectedModelConfigId",
    selected_provider_name AS "selectedProviderName",
    selected_model_name AS "selectedModelName",
    selected_reasoning_key AS "selectedReasoningKey",
    selected_tool_ids AS "selectedToolIds",
    last_synced_at AS "lastSyncedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM pane_agent_bindings
`;

const spaceAgentSessionSelect = `
  SELECT
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    source,
    status,
    title,
    thread_id AS "threadId",
    selected_provider_id AS "selectedProviderId",
    selected_model_id AS "selectedModelId",
    selected_model_config_id AS "selectedModelConfigId",
    selected_provider_name AS "selectedProviderName",
    selected_model_name AS "selectedModelName",
    selected_reasoning_key AS "selectedReasoningKey",
    selected_tool_ids AS "selectedToolIds",
    permission_mode AS "permissionMode",
    collaboration_mode AS "collaborationMode",
    is_active AS "isActive",
    last_synced_at AS "lastSyncedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM space_agent_sessions
`;

const spaceAgentMessageSelect = `
  SELECT
    message_id AS "messageId",
    session_id AS "sessionId",
    run_id AS "runId",
    role,
    content,
    status,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM space_agent_messages
`;

const spaceAgentRunSelect = `
  SELECT
    run_id AS "runId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    workflow_id AS "workflowId",
    temporal_run_id AS "temporalRunId",
    codex_thread_id AS "codexThreadId",
    codex_turn_id AS "codexTurnId",
    status,
    prompt_message_id AS "promptMessageId",
    response_message_id AS "responseMessageId",
    error_code AS "errorCode",
    error_message AS "errorMessage",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
  FROM space_agent_runs
`;

const paneCliSessionSelect = `
  SELECT
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    runtime_id AS "runtimeId",
    provider_id AS "providerId",
    agent_id AS "agentId",
    model_id AS "modelId",
    reasoning_effort AS "reasoningEffort",
    launch_mode AS "launchMode",
    purpose,
    cwd,
    codex_thread_id AS "codexThreadId",
    cli_task_id AS "cliTaskId",
    cli_task_revision_id AS "cliTaskRevisionId",
    status,
    status_reason AS "statusReason",
    exit_code AS "exitCode",
    is_active AS "isActive",
    started_at AS "startedAt",
    updated_at AS "updatedAt",
    ended_at AS "endedAt"
  FROM pane_cli_sessions
`;

const paneCliTerminalControlLeaseSelect = `
  SELECT
    lease_id AS "leaseId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    user_id AS "userId",
    browser_client_id AS "browserClientId",
    tab_lineage_id AS "tabLineageId",
    page_client_id AS "pageClientId",
    status,
    acquired_at AS "acquiredAt",
    heartbeat_at AS "heartbeatAt",
    expires_at AS "expiresAt",
    released_at AS "releasedAt"
  FROM pane_cli_terminal_control_leases
`;

const cliTaskSelect = `
  SELECT
    task_id AS "taskId",
    current_revision_id AS "currentRevisionId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM cli_tasks
`;

const cliTaskRevisionSelect = `
  SELECT
    revision_id AS "revisionId",
    task_id AS "taskId",
    runtime_id AS "runtimeId",
    provider_id AS "providerId",
    agent_id AS "agentId",
    native_task_ref AS "nativeTaskRef",
    source_revision_id AS "sourceRevisionId",
    latest_space_session_id AS "latestSpaceSessionId",
    display_title AS "displayTitle",
    first_user_message AS "firstUserMessage",
    preview,
    cwd,
    model_id AS "modelId",
    reasoning_effort AS "reasoningEffort",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM cli_task_revisions
`;

const paneCliTranscriptChunkSelect = `
  SELECT
    chunk_id AS "chunkId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    sequence,
    stream,
    content,
    byte_length AS "byteLength",
    host_generation_id AS "hostGenerationId",
    host_output_sequence AS "hostOutputSequence",
    created_at AS "createdAt"
  FROM pane_cli_transcript_chunks
`;

const paneCliCodexThreadOwnershipSelect = `
  SELECT
    thread_id AS "threadId",
    room_id AS "roomId",
    pane_id AS "paneId",
    cli_session_id AS "cliSessionId",
    source,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM pane_cli_codex_thread_ownerships
`;

const codexCliTurnMarkerSelect = `
  SELECT
    marker_id AS "markerId",
    session_id AS "sessionId",
    room_id AS "roomId",
    pane_id AS "paneId",
    client_turn_marker AS "clientTurnMarker",
    status,
    codex_thread_id AS "codexThreadId",
    rollout_path AS "rolloutPath",
    completion_event_id AS "completionEventId",
    submitted_at AS "submittedAt",
    completed_at AS "completedAt",
    next_check_at AS "nextCheckAt",
    check_attempt_count AS "checkAttemptCount",
    locked_at AS "lockedAt",
    locked_by AS "lockedBy",
    safe_error_code AS "safeErrorCode",
    updated_at AS "updatedAt"
  FROM codex_cli_turn_markers
`;

const paneBrowserSessionSelect = `
  SELECT
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    owner_agent_id AS "ownerAgentId",
    agent_number AS "agentNumber",
    profile_id AS "profileId",
    profile_path AS "profilePath",
    viewport,
    target_url AS "targetUrl",
    current_url AS "currentUrl",
    title,
    status,
    status_reason AS "statusReason",
    last_frame_at AS "lastFrameAt",
    stream_mode AS "streamMode",
    resolved_stream_mode AS "resolvedStreamMode",
    runtime_state AS "runtimeState",
    capacity_state AS "capacityState",
    control_state AS "controlState",
    pages,
    active_page_id AS "activePageId",
    worker_heartbeat_at AS "workerHeartbeatAt",
    queue_position AS "queuePosition",
    restore_scroll_x AS "restoreScrollX",
    restore_scroll_y AS "restoreScrollY",
    restore_video_paused AS "restoreVideoPaused",
    is_active AS "isActive",
    started_at AS "startedAt",
    updated_at AS "updatedAt",
    ended_at AS "endedAt"
  FROM pane_browser_sessions
`;

const browserControlLeaseSelect = `
  SELECT
    lease_id AS "leaseId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    holder_type AS "holderType",
    holder_id AS "holderId",
    status,
    reason,
    acquired_at AS "acquiredAt",
    heartbeat_at AS "heartbeatAt",
    expires_at AS "expiresAt",
    released_at AS "releasedAt"
  FROM browser_control_leases
`;

const browserCaptureJobSelect = `
  SELECT
    job_id AS "jobId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    requested_by_type AS "requestedByType",
    requested_by_id AS "requestedById",
    status,
    capture_options AS options,
    progress_percent AS "progressPercent",
    status_reason AS "statusReason",
    artifact_ids AS "artifactIds",
    queued_at AS "queuedAt",
    started_at AS "startedAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
  FROM browser_capture_jobs
`;

const browserCaptureSegmentSelect = `
  SELECT
    segment_id AS "segmentId",
    job_id AS "jobId",
    session_id AS "sessionId",
    segment_sequence AS sequence,
    status,
    artifact_id AS "artifactId",
    storage_uri AS "storageUri",
    sha256,
    byte_size AS "byteSize",
    duration_ms AS "durationMs",
    frame_count AS "frameCount",
    last_frame_sequence AS "lastFrameSequence",
    status_reason AS "statusReason",
    started_at AS "startedAt",
    updated_at AS "updatedAt",
    finalized_at AS "finalizedAt"
  FROM browser_capture_segments
`;

const browserHandoffRequestSelect = `
  SELECT
    handoff_request_id AS "handoffRequestId",
    session_id AS "sessionId",
    pane_id AS "paneId",
    room_id AS "roomId",
    requested_by_type AS "requestedByType",
    requested_by_id AS "requestedById",
    reason,
    status,
    operator_user_id AS "operatorUserId",
    operator_email AS "operatorEmail",
    operator_role AS "operatorRole",
    control_lease_id AS "controlLeaseId",
    requested_at AS "requestedAt",
    expires_at AS "expiresAt",
    accepted_at AS "acceptedAt",
    completed_at AS "completedAt",
    expired_at AS "expiredAt",
    cancelled_at AS "cancelledAt",
    updated_at AS "updatedAt"
  FROM browser_handoff_requests
`;

const eventSelect = `
  SELECT
    id,
    room_id AS "roomId",
    pane_id AS "paneId",
    turn_id AS "turnId",
    workflow_id AS "workflowId",
    trace_id AS "traceId",
    event_type AS type,
    message,
    payload,
    created_at AS "createdAt"
  FROM events
`;

const workflowRunSelect = `
  SELECT
    workflow_id AS "workflowId",
    run_id AS "runId",
    type,
    task_queue AS "taskQueue",
    status,
    room_id AS "roomId",
    pane_id AS "paneId",
    trace_id AS "traceId",
    started_at AS "startedAt",
    closed_at AS "closedAt"
  FROM workflows
`;

const turnSelect = `
  SELECT
    id,
    room_id AS "roomId",
    pane_id AS "paneId",
    workflow_id AS "workflowId",
    provider_id AS "providerId",
    model_id AS "modelId",
    status,
    prompt,
    prompt_hash AS "promptHash",
    (
      SELECT COALESCE(jsonb_agg(artifacts.id ORDER BY artifacts.created_at ASC), '[]'::jsonb)
      FROM artifacts
      WHERE artifacts.turn_id = turns.id
    ) AS "artifactIds",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM turns
`;

const auditEventSelect = `
  SELECT
    id,
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    action,
    target_type AS "targetType",
    target_id AS "targetId",
    metadata,
    created_at AS "createdAt"
  FROM audit_events
`;

const providerValidationSelect = `
  SELECT
    provider_id AS "providerId",
    status,
    code,
    status_reason AS "statusReason",
    masked_key_prefix AS "maskedKeyPrefix",
    credential_label AS "credentialLabel",
    model_count AS "modelCount",
    checked_at AS "checkedAt"
  FROM provider_validation_checks
`;

const providerSelect = `
  SELECT
    id,
    display_name AS "displayName",
    provider_type AS type,
    status,
    status_reason AS "statusReason",
    masked_key_prefix AS "maskedKeyPrefix",
    base_url AS "baseUrl",
    health_checked_at AS "healthCheckedAt",
    route_profile AS "routeProfile",
    backing_provider_id AS "backingProviderId",
    credential_ref AS "credentialRef",
    is_builtin AS "isBuiltIn"
  FROM providers
`;

const providerSettingsSelect = `
  SELECT
    default_provider_id AS "defaultProviderId",
    title_generation_model_id AS "titleGenerationModelId",
    title_generation_reasoning_effort AS "titleGenerationReasoningEffort",
    updated_at AS "updatedAt"
  FROM provider_settings
`;

const codexCliModeDefaultsSelect = `
  SELECT
    build_model_id AS "buildModelId",
    build_reasoning_effort AS "buildReasoningEffort",
    plan_model_id AS "planModelId",
    plan_reasoning_effort AS "planReasoningEffort",
    runtime_initialized AS "runtimeInitialized",
    updated_at AS "updatedAt"
  FROM codex_cli_mode_defaults
`;

const cliRuntimeSettingsSelect = `
  SELECT
    runtime_id AS "runtimeId",
    enabled,
    vpn_enabled AS "vpnEnabled",
    updated_at AS "updatedAt",
    updated_by AS "updatedBy"
  FROM cli_runtime_settings
`;

const adminOperationRunsSelect = `
  SELECT
    id,
    operation_type AS "operationType",
    status,
    actor_user_id AS "actorUserId",
    summary,
    result,
    created_at AS "createdAt",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    updated_at AS "updatedAt"
  FROM admin_operation_runs
`;

const setupConnectionCheckRunsSelect = `
  SELECT
    id,
    scope,
    connection_ids AS "connectionIds",
    status,
    total_count AS "totalCount",
    completed_count AS "completedCount",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    finished_at AS "finishedAt"
  FROM space_setup_connection_check_runs
`;

const setupConnectionCheckEventsSelect = `
  SELECT
    id,
    run_id AS "runId",
    sequence,
    connection_id AS "connectionId",
    stage,
    state,
    functional_state AS "functionalState",
    live_verification_state AS "liveVerificationState",
    reason_code AS "reasonCode",
    created_at AS "createdAt"
  FROM space_setup_connection_check_events
`;

const cliMaintenanceEventsSelect = `
  SELECT
    id,
    run_id AS "runId",
    sequence,
    runtime_id AS "runtimeId",
    phase,
    state,
    severity,
    code,
    message,
    attempt,
    installed_version AS "installedVersion",
    available_version AS "availableVersion",
    target_version AS "targetVersion",
    duration_ms AS "durationMs",
    outcome,
    rollback,
    diagnostics,
    created_at AS "createdAt"
  FROM cli_maintenance_events
`;

const cliMaintenanceAuthHandoffsSelect = `
  SELECT
    id,
    run_id AS "runId",
    runtime_id AS "runtimeId",
    room_id AS "roomId",
    status,
    attempt_count AS "attemptCount",
    safe_error_code AS "safeErrorCode",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
  FROM cli_maintenance_auth_handoffs
`;

const sourceControlConnectionsSelect = `
  SELECT
    provider,
    repository_owner AS "repositoryOwner",
    repository_name AS "repositoryName",
    account_login AS "accountLogin",
    connection_status AS "connectionStatus",
    secret_ref AS "secretRef",
    last_verified_at AS "lastVerifiedAt",
    last_verification_code AS "lastVerificationCode",
    updated_at AS "updatedAt"
  FROM source_control_connections
`;

const releasePreviewsSelect = `
  SELECT
    id,
    actor_user_id AS "actorUserId",
    tag,
    notes,
    source_commit AS "sourceCommit",
    previous_tag AS "previousTag",
    remote_main_commits AS "remoteMainCommits",
    expires_at AS "expiresAt",
    created_at AS "createdAt"
  FROM release_previews
`;

const codexAppServerHandshakeCheckSelect = `
  SELECT
    id AS "checkId",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    status,
    code,
    message,
    transport,
    schemas_generated AS "schemasGenerated",
    schema_manifest AS "schemaManifest",
    server_info AS "serverInfo",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    duration_ms AS "durationMs",
    checked_at AS "checkedAt"
  FROM codex_app_server_handshake_checks
`;

const codexAppServerTurnSmokeCheckSelect = `
  SELECT
    id AS "checkId",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    status,
    code,
    message,
    transport,
    schemas_generated AS "schemasGenerated",
    schema_manifest AS "schemaManifest",
    model,
    thread_id AS "threadId",
    turn_id AS "turnId",
    turn_status AS "turnStatus",
    notification_count AS "notificationCount",
    completed_notification_seen AS "completedNotificationSeen",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    duration_ms AS "durationMs",
    checked_at AS "checkedAt"
  FROM codex_app_server_turn_smoke_checks
`;

const mcpDiscoverySmokeCheckSelect = `
  SELECT
    id AS "checkId",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    status,
    code,
    message,
    target_spec_version AS "targetSpecVersion",
    discovery_enabled AS "discoveryEnabled",
    server_count AS "serverCount",
    tool_count AS "toolCount",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    duration_ms AS "durationMs",
    checked_at AS "checkedAt"
  FROM mcp_discovery_smoke_checks
`;

const memoryEmbeddingSmokeCheckSelect = `
  SELECT
    id AS "checkId",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    status,
    code,
    message,
    smoke_enabled AS "smokeEnabled",
    provider,
    model,
    dimensions,
    pgvector_ready AS "pgvectorReady",
    embedding_provider_ready AS "embeddingProviderReady",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    duration_ms AS "durationMs",
    checked_at AS "checkedAt"
  FROM memory_embedding_smoke_checks
`;

const mcpServerSelect = `
  SELECT
    id,
    display_name AS "displayName",
    transport,
    status,
    status_reason AS "statusReason",
    schema_version AS "schemaVersion",
    config_hash AS "configHash",
    tool_count AS "toolCount",
    last_discovered_at AS "lastDiscoveredAt"
  FROM mcp_servers
`;

const mcpToolSelect = `
  SELECT
    id,
    server_id AS "serverId",
    name,
    risk_level AS "riskLevel",
    schema_hash AS "schemaHash",
    approval_required AS "approvalRequired",
    status,
    status_reason AS "statusReason"
  FROM mcp_tools
`;

const memoryEntrySelect = `
  SELECT
    id,
    scope,
    room_id AS "roomId",
    title,
    body,
    provenance,
    created_at AS "createdAt"
  FROM memory_records
`;

const memoryCacheLinkSelect = `
  SELECT
    id AS "memoryRecordId",
    canonical_memory_id AS "canonicalMemoryId",
    canonical_link_source AS "linkSource",
    canonical_linked_at AS "linkedAt"
  FROM memory_records
`;

const memoryIssueStateSelect = `
  SELECT
    issue_id AS "issueId",
    issue_type AS "issueType",
    record_id AS "recordId",
    source_hash AS "sourceHash",
    status,
    reason,
    actor_user_id AS "actorUserId",
    version,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM memory_graph_issue_states
`;

const memoryConsolidationRunSelect = `
  SELECT
    id,
    mode,
    trigger_kind AS "triggerKind",
    status,
    workflow_id AS "workflowId",
    dedupe_key AS "dedupeKey",
    source_hash AS "sourceHash",
    actor_user_id AS "actorUserId",
    progress_completed AS "progressCompleted",
    progress_total AS "progressTotal",
    finding_count AS "findingCount",
    applied_operation_count AS "appliedOperationCount",
    skipped_operation_count AS "skippedOperationCount",
    failed_operation_count AS "failedOperationCount",
    metrics,
    model_id AS "modelId",
    ai_verified AS "aiVerified",
    ai_evidence AS "aiEvidence",
    status_reason AS "statusReason",
    created_at AS "createdAt",
    started_at AS "startedAt",
    completed_at AS "completedAt",
    updated_at AS "updatedAt"
  FROM memory_consolidation_runs
`;

const memoryConsolidationFindingSelect = `
  SELECT
    id,
    run_id AS "runId",
    issue_id AS "issueId",
    finding_type AS "findingType",
    severity,
    status,
    confidence,
    record_ids AS "recordIds",
    source_path AS "sourcePath",
    evidence,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM memory_consolidation_findings
`;

const memoryConsolidationOperationSelect = `
  SELECT
    id,
    run_id AS "runId",
    finding_id AS "findingId",
    operation_kind AS "operationKind",
    status,
    record_ids AS "recordIds",
    change_set_id AS "changeSetId",
    reason,
    status_reason AS "statusReason",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    applied_at AS "appliedAt"
  FROM memory_consolidation_operations
`;

const memoryChangeSetSelect = `
  SELECT
    id,
    kind,
    status,
    source_path AS "sourcePath",
    record_ids AS "recordIds",
    resolves_issue_ids AS "resolvesIssueIds",
    expected_source_hash AS "expectedSourceHash",
    resulting_source_hash AS "resultingSourceHash",
    before_content_hash AS "beforeContentHash",
    after_content_hash AS "afterContentHash",
    before_snapshot AS "beforeSnapshot",
    after_snapshot AS "afterSnapshot",
    reason,
    status_reason AS "statusReason",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    rollback_of_change_set_id AS "rollbackOfChangeSetId",
    rolled_back_by_change_set_id AS "rolledBackByChangeSetId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    applied_at AS "appliedAt",
    failed_at AS "failedAt",
    rolled_back_at AS "rolledBackAt"
  FROM memory_graph_change_sets
`;

const memoryChangeSetSummarySelect = `
  SELECT
    id,
    kind,
    status,
    source_path AS "sourcePath",
    record_ids AS "recordIds",
    resolves_issue_ids AS "resolvesIssueIds",
    expected_source_hash AS "expectedSourceHash",
    resulting_source_hash AS "resultingSourceHash",
    before_content_hash AS "beforeContentHash",
    after_content_hash AS "afterContentHash",
    reason,
    status_reason AS "statusReason",
    actor_user_id AS "actorUserId",
    trace_id AS "traceId",
    rollback_of_change_set_id AS "rollbackOfChangeSetId",
    rolled_back_by_change_set_id AS "rolledBackByChangeSetId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    applied_at AS "appliedAt",
    failed_at AS "failedAt",
    rolled_back_at AS "rolledBackAt"
  FROM memory_graph_change_sets
`;

const artifactSelect = `
  SELECT
    id,
    room_id AS "roomId",
    pane_id AS "paneId",
    turn_id AS "turnId",
    workflow_id AS "workflowId",
    kind,
    mime_type AS "mimeType",
    storage_uri AS "storageUri",
    sha256,
    byte_size AS "byteSize",
    metadata,
    expires_at AS "expiresAt",
    pinned_at AS "pinnedAt",
    deleted_at AS "deletedAt",
    created_at AS "createdAt"
  FROM artifacts
`;

const reviewDecisionSelect = `
  SELECT
    id,
    room_id AS "roomId",
    workflow_id AS "workflowId",
    decision,
    summary,
    evidence_artifact_ids AS "evidenceArtifactIds",
    rollback_note AS "rollbackNote",
    created_at AS "createdAt"
  FROM review_decisions
`;

const reviewCheckSelect = `
  SELECT
    id,
    room_id AS "roomId",
    review_decision_id AS "reviewDecisionId",
    name,
    status,
    command,
    summary,
    artifact_ids AS "artifactIds",
    metadata,
    created_at AS "createdAt"
  FROM review_checks
`;

const reviewDiffSummarySelect = `
  SELECT
    id,
    room_id AS "roomId",
    review_decision_id AS "reviewDecisionId",
    title,
    file_path AS "filePath",
    status,
    additions,
    deletions,
    patch_artifact_id AS "patchArtifactId",
    summary,
    created_at AS "createdAt"
  FROM review_diff_summaries
`;

const swarmTaskSelect = `
  SELECT
    id,
    room_id AS "roomId",
    parent_task_id AS "parentTaskId",
    role,
    title,
    goal,
    status,
    assignee,
    depends_on_task_ids AS "dependsOnTaskIds",
    lock_ids AS "lockIds",
    result_summary AS "resultSummary",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    completed_at AS "completedAt"
  FROM swarm_tasks
`;

const swarmLockSelect = `
  SELECT
    id,
    room_id AS "roomId",
    task_id AS "taskId",
    resource,
    status,
    holder,
    reason,
    created_at AS "createdAt",
    released_at AS "releasedAt"
  FROM swarm_locks
`;

const swarmMessageSelect = `
  SELECT
    id,
    room_id AS "roomId",
    task_id AS "taskId",
    from_role AS "fromRole",
    to_role AS "toRole",
    body,
    created_at AS "createdAt"
  FROM swarm_messages
`;

const swarmReconcileSelect = `
  SELECT
    id,
    room_id AS "roomId",
    task_ids AS "taskIds",
    decision,
    summary,
    next_steps AS "nextSteps",
    created_at AS "createdAt"
  FROM swarm_reconciles
`;

const skillSelect = `
  SELECT
    id,
    display_name AS "displayName",
    version,
    status,
    CASE
      WHEN status = 'DISABLED' THEN 'Operator proposal recorded; execution remains disabled until review and allowlists pass.'
      ELSE NULL
    END AS "statusReason",
    trigger_description AS "triggerDescription",
    body,
    allowed_tools AS "allowedTools",
    content_hash AS "contentHash",
    source,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM skills
`;

const importCandidateSelect = `
  SELECT
    id,
    source_kind AS "sourceKind",
    target_kind AS "targetKind",
    status,
    status_reason AS "statusReason",
    source_ref AS "sourceRef",
    room_id AS "roomId",
    memory_scope AS "memoryScope",
    title,
    body,
    provenance,
    skill_version AS "skillVersion",
    skill_trigger_description AS "skillTriggerDescription",
    allowed_tools AS "allowedTools",
    imported_memory_id AS "importedMemoryId",
    imported_skill_id AS "importedSkillId",
    created_at AS "createdAt",
    decided_at AS "decidedAt"
  FROM import_candidates
`;

function toIso(value: Date | string): string;
function toIso(value: Date | string | null): string | null;
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseVectorDimensions(formattedType: string | null | undefined): number | null {
  const match = formattedType?.match(/^vector\((\d+)\)$/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMemoryVectorReadiness(input: Omit<MemoryVectorReadiness, "id" | "checkedAt">): MemoryVectorReadiness {
  return memoryVectorReadinessSchema.parse({
    id: "memory-vector-readiness",
    checkedAt: nowIso(),
    ...input
  });
}

function mapRoom(row: RoomRow): Room {
  return roomSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    order: row.order,
    paneLayoutColumns: row.paneLayoutColumns,
    paneCap: row.paneCap,
    traceId: row.traceId,
    archivedAt: toIso(row.archivedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapClipboardItem(row: ClipboardItemRow): ClipboardItem {
  return clipboardItemSchema.parse({
    ...row,
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIso(row.lastUsedAt)
  });
}

function mapUserLink(row: UserLinkRow): UserLink {
  return userLinkSchema.parse({ ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) });
}

function mapPane(row: PaneRow): Pane {
  return paneSchema.parse({
    id: row.id,
    roomId: row.roomId,
    title: row.title,
    mode: row.mode,
    status: row.status,
    providerId: row.providerId,
    modelId: row.modelId,
    terminalRuntimeId: row.terminalRuntimeId,
    reasoningEffort: row.reasoningEffort,
    cwd: row.cwd,
    order: row.order,
    columnSpan: row.columnSpan,
    isMaximized: row.isMaximized,
    isMinimized: row.isMinimized,
    isClosed: row.isClosed,
    split: row.split,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapAgentPaneBinding(row: AgentPaneBindingRow): AgentPaneBinding {
  return agentPaneBindingSchema.parse({
    paneId: row.paneId,
    source: row.source,
    sessionId: null,
    coderChatId: row.coderChatId,
    status: row.status,
    title: row.title,
    selectedModelConfigId: row.selectedModelConfigId,
    selectedProviderName: row.selectedProviderName,
    selectedModelName: row.selectedModelName,
    selectedReasoningKey: row.selectedReasoningKey,
    selectedToolIds: row.selectedToolIds,
    lastSyncedAt: toIso(row.lastSyncedAt)
  });
}

function mapAgentPaneStoredSession(row: AgentPaneStoredSessionRow): AgentPaneStoredSession {
  return agentPaneStoredSessionSchema.parse({
    paneId: row.paneId,
    roomId: row.roomId,
    source: row.source,
    sessionId: null,
    coderChatId: row.coderChatId,
    status: row.status,
    title: row.title,
    selectedModelConfigId: row.selectedModelConfigId,
    selectedProviderName: row.selectedProviderName,
    selectedModelName: row.selectedModelName,
    selectedReasoningKey: row.selectedReasoningKey,
    selectedToolIds: row.selectedToolIds,
    lastSyncedAt: toIso(row.lastSyncedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapAgentPaneHistory(row: AgentPaneHistoryRow): AgentPaneHistoryItem {
  return {
    paneId: row.paneId,
    roomId: row.roomId,
    source: row.source,
    sessionId: null,
    coderChatId: row.coderChatId,
    status: row.status,
    title: row.title,
    selectedModelConfigId: row.selectedModelConfigId,
    selectedProviderName: row.selectedProviderName,
    selectedModelName: row.selectedModelName,
    selectedReasoningKey: row.selectedReasoningKey,
    selectedToolIds: row.selectedToolIds,
    lastSyncedAt: toIso(row.lastSyncedAt),
    paneTitle: row.paneTitle,
    paneIsClosed: row.paneIsClosed,
    updatedAt: toIso(row.updatedAt)
  };
}

function mapSpaceAgentSession(row: SpaceAgentSessionRow): SpaceAgentSessionRecord {
  return spaceAgentSessionRecordSchema.parse({
    sessionId: row.sessionId,
    paneId: row.paneId,
    roomId: row.roomId,
    source: row.source,
    status: row.status,
    title: row.title,
    threadId: row.threadId,
    selectedProviderId: row.selectedProviderId,
    selectedModelId: row.selectedModelId,
    selectedModelConfigId: row.selectedModelConfigId,
    selectedProviderName: row.selectedProviderName,
    selectedModelName: row.selectedModelName,
    selectedReasoningKey: row.selectedReasoningKey,
    selectedToolIds: row.selectedToolIds,
    permissionMode: row.permissionMode,
    collaborationMode: row.collaborationMode,
    isActive: row.isActive,
    lastSyncedAt: toIso(row.lastSyncedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapSpaceAgentMessage(row: SpaceAgentMessageRow): SpaceAgentMessageRecord {
  return spaceAgentMessageRecordSchema.parse({
    messageId: row.messageId,
    sessionId: row.sessionId,
    runId: row.runId,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapSpaceAgentRun(row: SpaceAgentRunRow): SpaceAgentRunRecord {
  return spaceAgentRunRecordSchema.parse({
    runId: row.runId,
    sessionId: row.sessionId,
    paneId: row.paneId,
    roomId: row.roomId,
    workflowId: row.workflowId,
    temporalRunId: row.temporalRunId,
    codexThreadId: row.codexThreadId,
    codexTurnId: row.codexTurnId,
    status: row.status,
    promptMessageId: row.promptMessageId,
    responseMessageId: row.responseMessageId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: toIso(row.completedAt)
  });
}

function mapCliTask(row: CliTaskRow): CliTaskRecord {
  return {
    taskId: row.taskId,
    currentRevisionId: row.currentRevisionId,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!
  };
}

function mapCliTaskRevision(row: CliTaskRevisionRow): CliTaskRevisionRecord {
  return {
    ...row,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!
  };
}

function mapRoomAgentRequest(row: RoomAgentRequestRow): RoomAgentRequestRecord {
  return roomAgentRequestRecordSchema.parse({
    ...row,
    createdAt: toIso(row.createdAt)
  });
}

function mapRoomAgentMission(row: RoomAgentMissionRow): RoomAgentMissionRecord {
  return roomAgentMissionRecordSchema.parse({
    ...row,
    queuedAt: toIso(row.queuedAt),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    pausedAt: toIso(row.pausedAt),
    totalPausedMs: Number(row.totalPausedMs),
    lastProgressAt: toIso(row.lastProgressAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapRoomAgentAction(row: RoomAgentActionRow): RoomAgentActionRecord {
  return roomAgentActionRecordSchema.parse({
    ...row,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: toIso(row.completedAt)
  });
}

function mapRoomAgentTaskRun(row: RoomAgentTaskRunRow): RoomAgentTaskRunRecord {
  return roomAgentTaskRunRecordSchema.parse({
    ...row.resultPayload,
    ...row,
    resultPayload: undefined,
    queuedAt: toIso(row.queuedAt),
    startedAt: toIso(row.startedAt),
    firstResponseAt: toIso(row.firstResponseAt),
    completedAt: toIso(row.completedAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapPaneCliSession(row: PaneCliSessionRow): PaneCliSession {
  return paneCliSessionSchema.parse({
    sessionId: row.sessionId,
    paneId: row.paneId,
    roomId: row.roomId,
    runtimeId: row.runtimeId,
    providerId: row.providerId,
    agentId: row.agentId,
    modelId: row.modelId,
    reasoningEffort: row.reasoningEffort,
    launchMode: row.launchMode,
    purpose: row.purpose,
    cwd: row.cwd,
    codexThreadId: row.codexThreadId,
    cliTaskId: row.cliTaskId,
    cliTaskRevisionId: row.cliTaskRevisionId,
    status: row.status,
    statusReason: row.statusReason,
    exitCode: row.exitCode,
    isActive: row.isActive,
    startedAt: toIso(row.startedAt),
    updatedAt: toIso(row.updatedAt),
    endedAt: toIso(row.endedAt)
  });
}

function mapPaneCliTerminalControlLease(row: PaneCliTerminalControlLeaseRow): PaneCliTerminalControlLease {
  return paneCliTerminalControlLeaseSchema.parse({
    ...row,
    acquiredAt: toIso(row.acquiredAt),
    heartbeatAt: toIso(row.heartbeatAt),
    expiresAt: toIso(row.expiresAt),
    releasedAt: toIso(row.releasedAt)
  });
}

function mapPaneCliTranscriptChunk(row: PaneCliTranscriptChunkRow): PaneCliTranscriptChunk {
  return paneCliTranscriptChunkSchema.parse({
    chunkId: row.chunkId,
    sessionId: row.sessionId,
    paneId: row.paneId,
    roomId: row.roomId,
    sequence: row.sequence,
    stream: row.stream,
    content: row.content,
    byteLength: row.byteLength,
    hostGenerationId: row.hostGenerationId ?? null,
    hostOutputSequence:
      row.hostOutputSequence === null || row.hostOutputSequence === undefined ? null : Number(row.hostOutputSequence),
    createdAt: toIso(row.createdAt)
  });
}

function mapCodexCliTurnMarker(row: CodexCliTurnMarkerRow): CodexCliTurnMarkerRecord {
  return {
    ...row,
    checkAttemptCount: Number(row.checkAttemptCount),
    submittedAt: toIso(row.submittedAt)!,
    completedAt: toIso(row.completedAt),
    nextCheckAt: toIso(row.nextCheckAt)!,
    lockedAt: toIso(row.lockedAt),
    updatedAt: toIso(row.updatedAt)!
  };
}

function mapPaneCliCodexThreadOwnership(row: PaneCliCodexThreadOwnershipRow): PaneCliCodexThreadOwnership {
  return paneCliCodexThreadOwnershipSchema.parse({
    ...row,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapPaneBrowserSession(row: PaneBrowserSessionRow): PaneBrowserSession {
  return paneBrowserSessionSchema.parse({
    sessionId: row.sessionId,
    paneId: row.paneId,
    roomId: row.roomId,
    ownerAgentId: row.ownerAgentId,
    agentNumber: row.agentNumber,
    profileId: row.profileId,
    profilePath: row.profilePath,
    viewport: row.viewport,
    targetUrl: row.targetUrl,
    currentUrl: row.currentUrl,
    title: row.title,
    status: row.status,
    statusReason: row.statusReason,
    lastFrameAt: toIso(row.lastFrameAt),
    streamMode: row.streamMode,
    resolvedStreamMode: row.resolvedStreamMode,
    runtimeState: row.runtimeState,
    capacityState: row.capacityState,
    controlState: row.controlState,
    pages: row.pages ?? [],
    activePageId: row.activePageId,
    workerHeartbeatAt: toIso(row.workerHeartbeatAt),
    queuePosition: row.queuePosition,
    restoreScrollX: row.restoreScrollX,
    restoreScrollY: row.restoreScrollY,
    restoreVideoPaused: row.restoreVideoPaused,
    isActive: row.isActive,
    startedAt: toIso(row.startedAt),
    updatedAt: toIso(row.updatedAt),
    endedAt: toIso(row.endedAt)
  });
}

function mapBrowserControlLease(row: BrowserControlLeaseRow): BrowserControlLease {
  return browserControlLeaseSchema.parse({
    ...row,
    acquiredAt: toIso(row.acquiredAt),
    heartbeatAt: toIso(row.heartbeatAt),
    expiresAt: toIso(row.expiresAt),
    releasedAt: toIso(row.releasedAt)
  });
}

function mapBrowserCaptureJob(row: BrowserCaptureJobRow): BrowserCaptureJob {
  return browserCaptureJobSchema.parse({
    ...row,
    artifactIds: Array.isArray(row.artifactIds) ? row.artifactIds : [],
    queuedAt: toIso(row.queuedAt),
    startedAt: toIso(row.startedAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: toIso(row.completedAt)
  });
}

function mapBrowserCaptureSegment(row: BrowserCaptureSegmentRow): BrowserCaptureSegment {
  return browserCaptureSegmentSchema.parse({
    ...row,
    byteSize: Number(row.byteSize),
    lastFrameSequence: row.lastFrameSequence === null ? null : Number(row.lastFrameSequence),
    startedAt: toIso(row.startedAt),
    updatedAt: toIso(row.updatedAt),
    finalizedAt: toIso(row.finalizedAt)
  });
}

function mapBrowserHandoffRequest(row: BrowserHandoffRequestRow): BrowserHandoffRequest {
  return browserHandoffRequestSchema.parse({
    ...row,
    requestedAt: toIso(row.requestedAt),
    expiresAt: toIso(row.expiresAt),
    acceptedAt: toIso(row.acceptedAt),
    completedAt: toIso(row.completedAt),
    expiredAt: toIso(row.expiredAt),
    cancelledAt: toIso(row.cancelledAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapEvent(row: EventRow): Event {
  return eventSchema.parse({
    id: row.id,
    roomId: row.roomId,
    paneId: row.paneId,
    turnId: row.turnId,
    workflowId: row.workflowId,
    traceId: row.traceId,
    type: row.type,
    message: row.message,
    payload: row.payload,
    createdAt: toIso(row.createdAt)
  });
}

function mapEventChange(row: EventChangeRow): EventChange {
  return {
    sequence: String(row.relaySequence),
    event: mapEvent(row)
  };
}

function mapWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return workflowRunSchema.parse({
    workflowId: row.workflowId,
    runId: row.runId,
    type: row.type,
    taskQueue: row.taskQueue,
    status: row.status,
    roomId: row.roomId,
    paneId: row.paneId,
    traceId: row.traceId,
    startedAt: toIso(row.startedAt),
    closedAt: toIso(row.closedAt)
  });
}

function mapTurn(row: TurnRow): Turn {
  return turnSchema.parse({
    id: row.id,
    roomId: row.roomId,
    paneId: row.paneId,
    workflowId: row.workflowId,
    providerId: row.providerId,
    modelId: row.modelId,
    status: row.status,
    prompt: row.prompt ?? null,
    promptHash: row.promptHash,
    artifactIds: row.artifactIds ?? [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return auditEventSchema.parse({
    id: row.id,
    actorUserId: row.actorUserId,
    traceId: row.traceId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt)
  });
}

function mapProviderValidation(row: ProviderValidationCheckRow): ProviderValidationResult {
  return providerValidationResultSchema.parse({
    providerId: row.providerId,
    status: row.status,
    code: row.code,
    statusReason: row.statusReason,
    checkedAt: toIso(row.checkedAt),
    maskedKeyPrefix: row.maskedKeyPrefix,
    credentialLabel: row.credentialLabel,
    modelCount: row.modelCount
  });
}

function mapProvider(row: ProviderRow): Provider {
  return providerSchema.parse({
    id: row.id,
    displayName: row.displayName,
    type: row.type,
    status: row.status,
    statusReason: row.statusReason,
    healthCheckedAt: toIso(row.healthCheckedAt),
    maskedKeyPrefix: row.maskedKeyPrefix,
    baseUrl: row.baseUrl,
    routeProfile: row.routeProfile,
    backingProviderId: row.backingProviderId,
    credentialRef: row.credentialRef,
    isBuiltIn: row.isBuiltIn
  });
}

function mapProviderSettings(row: ProviderSettingsRow): ProviderSettings {
  return providerSettingsSchema.parse({
    defaultProviderId: row.defaultProviderId,
    titleGenerationModelId: row.titleGenerationModelId,
    titleGenerationReasoningEffort: row.titleGenerationReasoningEffort,
    updatedAt: toIso(row.updatedAt)
  });
}

function mapCodexCliModeDefaults(row: CodexCliModeDefaultsRow): CodexCliModeDefaults {
  return codexCliModeDefaultsSchema.parse({
    build: { modelId: row.buildModelId, reasoningEffort: row.buildReasoningEffort },
    plan: { modelId: row.planModelId, reasoningEffort: row.planReasoningEffort },
    updatedAt: toIso(row.updatedAt)
  });
}

function mapCliRuntimeSetting(row: CliRuntimeSettingRow): CliRuntimeSetting {
  return cliRuntimeSettingSchema.parse({
    runtimeId: row.runtimeId,
    enabled: row.enabled,
    vpnEnabled: row.vpnEnabled,
    updatedAt: toIso(row.updatedAt),
    updatedBy: row.updatedBy
  });
}

function mapAdminOperationRun(row: AdminOperationRunRow): AdminOperationRun {
  return adminOperationRunSchema.parse({
    ...row,
    createdAt: toIso(row.createdAt),
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapSetupConnectionCheckRun(row: SetupConnectionCheckRunRow): SetupConnectionCheckRun {
  return setupConnectionCheckRunSchema.parse({
    ...row,
    totalCount: Number(row.totalCount),
    completedCount: Number(row.completedCount),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    finishedAt: toIso(row.finishedAt)
  });
}

function mapSetupConnectionCheckEvent(row: SetupConnectionCheckEventRow): SetupConnectionCheckEvent {
  return setupConnectionCheckEventSchema.parse({
    ...row,
    sequence: Number(row.sequence),
    createdAt: toIso(row.createdAt)
  });
}

function mapCliMaintenanceEvent(row: CliMaintenanceEventRow): CliMaintenanceEvent {
  return cliMaintenanceEventSchema.parse({
    ...row,
    sequence: Number(row.sequence),
    createdAt: toIso(row.createdAt)
  });
}

function mapCliMaintenanceAuthHandoff(row: CliMaintenanceAuthHandoffRow): CliMaintenanceAuthHandoff {
  return cliMaintenanceAuthHandoffSchema.parse({
    ...row,
    attemptCount: Number(row.attemptCount),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: toIso(row.completedAt)
  });
}

function mapSourceControlConnection(row: SourceControlConnectionRow): SourceControlConnectionRecord {
  return {
    ...sourceControlConnectionSchema.parse({
      provider: row.provider,
      repositoryOwner: row.repositoryOwner,
      repositoryName: row.repositoryName,
      accountLogin: row.accountLogin,
      status: row.connectionStatus,
      secretConfigured: row.secretRef !== null,
      lastVerifiedAt: toIso(row.lastVerifiedAt),
      lastVerificationCode: row.lastVerificationCode,
      updatedAt: toIso(row.updatedAt)
    }),
    secretRef: row.secretRef
  };
}

function mapReleasePreview(row: ReleasePreviewRow): ReleasePreviewRecord {
  return {
    ...releasePreviewSchema.parse({
      id: row.id,
      tag: row.tag,
      notes: row.notes,
      sourceCommit: row.sourceCommit,
      previousTag: row.previousTag,
      remoteMainCommits: row.remoteMainCommits,
      expiresAt: toIso(row.expiresAt),
      createdAt: toIso(row.createdAt)
    }),
    actorUserId: row.actorUserId
  };
}

function modelCapabilityBoolean(capabilities: Record<string, unknown>, key: string): boolean {
  return capabilities[key] === true;
}

function modelCapabilityNumber(capabilities: Record<string, unknown>, key: string): number | null {
  const value = capabilities[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function modelReasoningEffort(capabilities: Record<string, unknown>): Model["defaultReasoningEffort"] {
  const value = capabilities.defaultReasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : null;
}

function modelRuntimeId(capabilities: Record<string, unknown>): string | null {
  const value = capabilities.runtimeId;
  return typeof value === "string" && value.trim() ? value : null;
}

function modelCapabilities(model: Model): Record<string, unknown> {
  return {
    runtimeId: model.runtimeId,
    contextWindow: model.contextWindow,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsRealtime: model.supportsRealtime,
    supportsReasoning: model.supportsReasoning,
    defaultReasoningEffort: model.defaultReasoningEffort
  };
}

function mapModel(row: ModelRow): Model {
  return modelSchema.parse({
    id: row.id,
    providerId: row.providerId,
    runtimeId: modelRuntimeId(row.capabilities),
    displayName: row.displayName,
    status: row.status,
    contextWindow: modelCapabilityNumber(row.capabilities, "contextWindow"),
    supportsTools: modelCapabilityBoolean(row.capabilities, "supportsTools"),
    supportsVision: modelCapabilityBoolean(row.capabilities, "supportsVision"),
    supportsRealtime: modelCapabilityBoolean(row.capabilities, "supportsRealtime"),
    supportsReasoning: modelCapabilityBoolean(row.capabilities, "supportsReasoning"),
    defaultReasoningEffort: modelReasoningEffort(row.capabilities)
  });
}

function mapCodexAppServerHandshakeCheck(row: CodexAppServerHandshakeCheckRow): CodexAppServerHandshakeCheck {
  return codexAppServerHandshakeCheckSchema.parse({
    id: "codex-app-server",
    checkId: row.checkId,
    actorUserId: row.actorUserId,
    traceId: row.traceId,
    status: row.status,
    code: row.code,
    message: row.message,
    transport: row.transport,
    schemasGenerated: row.schemasGenerated,
    schemaManifest: row.schemaManifest,
    serverInfo: row.serverInfo,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    durationMs: row.durationMs,
    checkedAt: toIso(row.checkedAt)
  });
}

function mapCodexAppServerTurnSmokeCheck(row: CodexAppServerTurnSmokeCheckRow): CodexAppServerTurnSmokeCheck {
  return codexAppServerTurnSmokeCheckSchema.parse({
    id: "codex-app-server",
    checkId: row.checkId,
    actorUserId: row.actorUserId,
    traceId: row.traceId,
    status: row.status,
    code: row.code,
    message: row.message,
    transport: row.transport,
    schemasGenerated: row.schemasGenerated,
    schemaManifest: row.schemaManifest,
    model: row.model,
    threadId: row.threadId,
    turnId: row.turnId,
    turnStatus: row.turnStatus,
    notificationCount: row.notificationCount,
    completedNotificationSeen: row.completedNotificationSeen,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    durationMs: row.durationMs,
    checkedAt: toIso(row.checkedAt)
  });
}

function mapMcpDiscoverySmokeCheck(row: McpDiscoverySmokeCheckRow): McpDiscoverySmokeCheck {
  return mcpDiscoverySmokeCheckSchema.parse({
    id: "mcp-gateway",
    checkId: row.checkId,
    actorUserId: row.actorUserId,
    traceId: row.traceId,
    status: row.status,
    code: row.code,
    message: row.message,
    targetSpecVersion: row.targetSpecVersion,
    discoveryEnabled: row.discoveryEnabled,
    serverCount: row.serverCount,
    toolCount: row.toolCount,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    durationMs: row.durationMs,
    checkedAt: toIso(row.checkedAt)
  });
}

function mapMemoryEmbeddingSmokeCheck(row: MemoryEmbeddingSmokeCheckRow): MemoryEmbeddingSmokeCheck {
  return memoryEmbeddingSmokeCheckSchema.parse({
    id: "memory-embedding-smoke",
    checkId: row.checkId,
    actorUserId: row.actorUserId,
    traceId: row.traceId,
    status: row.status,
    code: row.code,
    message: row.message,
    smokeEnabled: row.smokeEnabled,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    pgvectorReady: row.pgvectorReady,
    embeddingProviderReady: row.embeddingProviderReady,
    startedAt: toIso(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    durationMs: row.durationMs,
    checkedAt: toIso(row.checkedAt)
  });
}

function toPgVectorLiteral(embedding: readonly number[] | undefined): string | null {
  if (!embedding) return null;
  if (!embedding.length || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Memory embedding must be a non-empty finite vector.");
  }
  return `[${embedding.join(",")}]`;
}

function mapMcpServer(row: McpServerRow): McpServer {
  return mcpServerSchema.parse({
    id: row.id,
    displayName: row.displayName,
    transport: row.transport,
    status: row.status,
    statusReason: row.statusReason,
    schemaVersion: row.schemaVersion,
    configHash: row.configHash,
    toolCount: row.toolCount,
    lastDiscoveredAt: toIso(row.lastDiscoveredAt)
  });
}

function mapMcpTool(row: McpToolRow): McpTool {
  return mcpToolSchema.parse({
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    riskLevel: row.riskLevel,
    schemaHash: row.schemaHash,
    approvalRequired: row.approvalRequired,
    status: row.status,
    statusReason: row.statusReason
  });
}

function mapMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  return memoryEntrySchema.parse({
    id: row.id,
    scope: row.scope,
    roomId: row.roomId,
    title: row.title,
    body: row.body,
    provenance: row.provenance,
    createdAt: toIso(row.createdAt)
  });
}

function mapMemoryCacheLink(row: MemoryCacheLinkRow): MemoryCacheLink {
  return memoryCacheLinkSchema.parse({ ...row, linkedAt: toIso(row.linkedAt) });
}

function mapMemoryIssueState(row: MemoryIssueStateRow): MemoryIssueState {
  return memoryIssueStateSchema.parse({ ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) });
}

function mapMemoryConsolidationRun(row: MemoryConsolidationRunRow): MemoryConsolidationRun {
  return memoryConsolidationRunSchema.parse({
    ...row,
    progressCompleted: Number(row.progressCompleted),
    progressTotal: Number(row.progressTotal),
    findingCount: Number(row.findingCount),
    appliedOperationCount: Number(row.appliedOperationCount),
    skippedOperationCount: Number(row.skippedOperationCount),
    failedOperationCount: Number(row.failedOperationCount),
    metrics: row.metrics ?? {},
    aiEvidence: row.aiEvidence ?? {},
    createdAt: toIso(row.createdAt),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapMemoryConsolidationFinding(row: MemoryConsolidationFindingRow): MemoryConsolidationFinding {
  return memoryConsolidationFindingSchema.parse({
    ...row,
    confidence: Number(row.confidence),
    recordIds: Array.isArray(row.recordIds) ? row.recordIds : [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  });
}

function mapMemoryConsolidationOperation(row: MemoryConsolidationOperationRow): MemoryConsolidationOperation {
  return memoryConsolidationOperationSchema.parse({
    ...row,
    recordIds: Array.isArray(row.recordIds) ? row.recordIds : [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    appliedAt: toIso(row.appliedAt)
  });
}

function mapMemoryCommandIdempotency(row: MemoryCommandIdempotencyRow): MemoryCommandIdempotency {
  return memoryCommandIdempotencySchema.parse({
    commandScope: row.commandScope,
    actorKey: row.actorKey,
    idempotencyKeyHash: row.idempotencyKeyHash,
    requestHash: row.requestHash,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    workflowId: row.workflowId,
    createdAt: toIso(row.createdAt)
  });
}

function mapArtifact(row: ArtifactRow): Artifact {
  return artifactSchema.parse({
    id: row.id,
    roomId: row.roomId,
    paneId: row.paneId,
    turnId: row.turnId,
    workflowId: row.workflowId,
    kind: row.kind,
    mimeType: row.mimeType,
    storageUri: row.storageUri,
    sha256: row.sha256,
    byteSize: Number(row.byteSize),
    metadata: row.metadata ?? {},
    expiresAt: toIso(row.expiresAt),
    pinnedAt: toIso(row.pinnedAt),
    deletedAt: toIso(row.deletedAt),
    createdAt: toIso(row.createdAt)
  });
}

function mapSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    displayName: row.displayName,
    version: row.version,
    status: row.status,
    statusReason: row.statusReason,
    triggerDescription: row.triggerDescription,
    body: row.body,
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
    contentHash: row.contentHash,
    source: row.source,
    createdAt: row.createdAt ? toIso(row.createdAt) : null,
    updatedAt: row.updatedAt ? toIso(row.updatedAt) : null
  };
}

function mapImportCandidate(row: ImportCandidateRow): ImportCandidate {
  return importCandidateSchema.parse({
    id: row.id,
    sourceKind: row.sourceKind,
    targetKind: row.targetKind,
    status: row.status,
    statusReason: row.statusReason,
    sourceRef: row.sourceRef,
    roomId: row.roomId,
    memoryScope: row.memoryScope,
    title: row.title,
    body: row.body,
    provenance: row.provenance,
    skillVersion: row.skillVersion,
    skillTriggerDescription: row.skillTriggerDescription,
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
    importedMemoryId: row.importedMemoryId,
    importedSkillId: row.importedSkillId,
    createdAt: toIso(row.createdAt),
    decidedAt: toIso(row.decidedAt)
  });
}

function mapMemoryChangeSet(row: MemoryChangeSetRow): MemoryChangeSet {
  return memoryChangeSetSchema.parse({
    ...row,
    recordIds: Array.isArray(row.recordIds) ? row.recordIds : [],
    resolvesIssueIds: Array.isArray(row.resolvesIssueIds) ? row.resolvesIssueIds : [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    appliedAt: toIso(row.appliedAt),
    failedAt: toIso(row.failedAt),
    rolledBackAt: toIso(row.rolledBackAt)
  });
}

function mapMemoryChangeSetSummary(row: MemoryChangeSetSummaryRow): MemoryChangeSetSummary {
  return memoryChangeSetSummarySchema.parse({
    ...row,
    recordIds: Array.isArray(row.recordIds) ? row.recordIds : [],
    resolvesIssueIds: Array.isArray(row.resolvesIssueIds) ? row.resolvesIssueIds : [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    appliedAt: toIso(row.appliedAt),
    failedAt: toIso(row.failedAt),
    rolledBackAt: toIso(row.rolledBackAt)
  });
}

function mapReviewDecision(row: ReviewDecisionRow): ReviewDecision {
  return {
    id: row.id,
    roomId: row.roomId,
    workflowId: row.workflowId,
    decision: row.decision,
    summary: row.summary,
    evidenceArtifactIds: Array.isArray(row.evidenceArtifactIds) ? row.evidenceArtifactIds : [],
    rollbackNote: row.rollbackNote,
    createdAt: toIso(row.createdAt)
  };
}

function mapReviewCheck(row: ReviewCheckRow): ReviewCheck {
  return reviewCheckSchema.parse({
    id: row.id,
    roomId: row.roomId,
    reviewDecisionId: row.reviewDecisionId,
    name: row.name,
    status: row.status,
    command: row.command,
    summary: row.summary,
    artifactIds: Array.isArray(row.artifactIds) ? row.artifactIds : [],
    metadata: row.metadata ?? {},
    createdAt: toIso(row.createdAt)
  });
}

function mapReviewDiffSummary(row: ReviewDiffSummaryRow): ReviewDiffSummary {
  return reviewDiffSummarySchema.parse({
    id: row.id,
    roomId: row.roomId,
    reviewDecisionId: row.reviewDecisionId,
    title: row.title,
    filePath: row.filePath,
    status: row.status,
    additions: Number(row.additions),
    deletions: Number(row.deletions),
    patchArtifactId: row.patchArtifactId,
    summary: row.summary,
    createdAt: toIso(row.createdAt)
  });
}

function mapSwarmTask(row: SwarmTaskRow): SwarmTask {
  return swarmTaskSchema.parse({
    id: row.id,
    roomId: row.roomId,
    parentTaskId: row.parentTaskId,
    role: row.role,
    title: row.title,
    goal: row.goal,
    status: row.status,
    assignee: row.assignee,
    dependsOnTaskIds: Array.isArray(row.dependsOnTaskIds) ? row.dependsOnTaskIds : [],
    lockIds: Array.isArray(row.lockIds) ? row.lockIds : [],
    resultSummary: row.resultSummary,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: toIso(row.completedAt)
  });
}

function mapSwarmLock(row: SwarmLockRow): SwarmLock {
  return swarmLockSchema.parse({
    id: row.id,
    roomId: row.roomId,
    taskId: row.taskId,
    resource: row.resource,
    status: row.status,
    holder: row.holder,
    reason: row.reason,
    createdAt: toIso(row.createdAt),
    releasedAt: toIso(row.releasedAt)
  });
}

function mapSwarmMessage(row: SwarmMessageRow): SwarmMessage {
  return swarmMessageSchema.parse({
    id: row.id,
    roomId: row.roomId,
    taskId: row.taskId,
    fromRole: row.fromRole,
    toRole: row.toRole,
    body: row.body,
    createdAt: toIso(row.createdAt)
  });
}

function mapSwarmReconcile(row: SwarmReconcileRow): SwarmReconcile {
  return swarmReconcileSchema.parse({
    id: row.id,
    roomId: row.roomId,
    taskIds: Array.isArray(row.taskIds) ? row.taskIds : [],
    decision: row.decision,
    summary: row.summary,
    nextSteps: row.nextSteps,
    createdAt: toIso(row.createdAt)
  });
}

function firstOrNotFound<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) {
    throw new SpaceNotFoundError(message);
  }
  return row;
}

function countValue(rows: CountRow[]): number {
  return Number.parseInt(String(rows[0]?.count ?? 0), 10);
}

function codexFinalResponseFromMetadata(metadata: Record<string, unknown> | undefined): string | null {
  const codex = metadata?.codexAppServer;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return null;
  const value = (codex as Record<string, unknown>).agentMessageText;
  return typeof value === "string" && value.trim() ? value : null;
}

function orderValue(rows: OrderRow[]): number {
  return Number.parseInt(String(rows[0]?.nextOrder ?? 0), 10);
}

export class PostgresSpaceStore implements SpaceStore {
  private providers: Provider[];
  private models: Model[];
  private capabilities: Capability[];
  private mcpGatewayStatus: McpGatewayStatus;
  private mcpServers: McpServer[];
  private mcpTools: McpTool[];
  private skills: Skill[];

  constructor(
    private readonly pool: PgPoolLike,
    options: StaticCatalogOptions = {}
  ) {
    const catalog = createStaticCatalog(options);
    this.providers = catalog.providers;
    this.models = catalog.models;
    this.capabilities = catalog.capabilities;
    this.mcpGatewayStatus = catalog.mcpGatewayStatus;
    this.mcpServers = catalog.mcpServers;
    this.mcpTools = catalog.mcpTools;
    this.skills = catalog.skills;
  }

  static fromConnectionString(
    connectionString: string,
    options: StaticCatalogOptions = {},
    poolOptions: PostgresPoolOptions = {}
  ): PostgresSpaceStore {
    return new PostgresSpaceStore(createSpacePgPool(connectionString, poolOptions), options);
  }

  createTelegramPersistence(): TelegramPersistence & TelegramOutboxPersistence {
    return new PostgresTelegramPersistence(this.pool);
  }

  async upsertUser(user: AuthUser): Promise<AuthUser> {
    const result = await this.pool.query<AuthUser>(
      `
        WITH updated_email AS (
          UPDATE users
          SET
            role = $3,
            updated_at = $4
          WHERE lower(email) = lower($2)
          RETURNING id, email, role
        ),
        inserted AS (
          INSERT INTO users (id, email, role, updated_at)
          SELECT $1, $2, $3, $4
          WHERE NOT EXISTS (SELECT 1 FROM updated_email)
          ON CONFLICT (id)
          DO UPDATE SET
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            updated_at = EXCLUDED.updated_at
          RETURNING id, email, role
        )
        SELECT id, email, role FROM updated_email
        UNION ALL
        SELECT id, email, role FROM inserted
        LIMIT 1
      `,
      [user.id, user.email, user.role, nowIso()]
    );
    return result.rows[0] ?? user;
  }

  async initializeOwnerSetup(input: InitializeOwnerSetupInput): Promise<OwnerSetupStatus> {
    await this.pool.query(
      `
        INSERT INTO space_owner_setup (
          singleton,
          setup_token_hash,
          setup_token_expires_at,
          updated_at
        )
        VALUES (true, $1, $2, now())
        ON CONFLICT (singleton) DO NOTHING
      `,
      [input.tokenHash, input.expiresAt]
    );
    return this.getOwnerSetupStatus();
  }

  async getOwnerSetupStatus(): Promise<OwnerSetupStatus> {
    const result = await this.pool.query<{
      ownerUserId: string | null;
      expiresAt: Date | string | null;
    }>(
      `
        SELECT
          owner_user_id AS "ownerUserId",
          setup_token_expires_at AS "expiresAt"
        FROM space_owner_setup
        WHERE singleton = true
      `
    );
    const row = result.rows[0];
    return {
      setupRequired: !row?.ownerUserId,
      expiresAt: row?.ownerUserId || !row?.expiresAt ? null : toIso(row.expiresAt)
    };
  }

  async claimOwnerSetup(input: ClaimOwnerSetupInput): Promise<OwnerSetupClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const setup = await client.query<{
        tokenHash: string | null;
        expiresAt: Date | string | null;
        ownerUserId: string | null;
      }>(
        `
          SELECT
            setup_token_hash AS "tokenHash",
            setup_token_expires_at AS "expiresAt",
            owner_user_id AS "ownerUserId"
          FROM space_owner_setup
          WHERE singleton = true
          FOR UPDATE
        `
      );
      const row = setup.rows[0];
      if (row?.ownerUserId) {
        throw new SpaceConflictError("SpaceApp owner setup is already claimed.");
      }
      if (!row || row.tokenHash !== input.tokenHash) {
        throw new SpaceConflictError("The SpaceApp setup token is not valid.");
      }
      if (!row.expiresAt || Date.parse(input.now) >= Date.parse(toIso(row.expiresAt))) {
        throw new SpaceConflictError("The SpaceApp setup token has expired.");
      }
      const owner = authUserSchema.parse({
        id: "user:owner",
        email: input.email,
        role: "ADMIN"
      });
      await client.query(
        `
          INSERT INTO users (id, email, role, password_hash, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id)
          DO UPDATE SET
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            password_hash = EXCLUDED.password_hash,
            updated_at = EXCLUDED.updated_at
        `,
        [owner.id, owner.email, owner.role, input.passwordHash, input.now]
      );
      const starterRoom = await this.createStarterRoom(client, makeSpaceId("trace"));
      await client.query(
        `
          UPDATE space_owner_setup
          SET
            setup_token_hash = NULL,
            setup_token_expires_at = NULL,
            owner_user_id = $1,
            claimed_at = $2,
            onboarding_version = $3,
            onboarding_completed_at = NULL,
            starter_room_id = $4,
            updated_at = $2
          WHERE singleton = true
        `,
        [owner.id, input.now, currentSetupOnboardingVersion, starterRoom.id]
      );
      await client.query("COMMIT");
      return {
        user: owner,
        onboarding: {
          onboardingVersion: currentSetupOnboardingVersion,
          isComplete: false,
          completedAt: null,
          starterRoomId: starterRoom.id
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async getOwnerOnboarding(): Promise<SetupOnboarding> {
    const result = await this.pool.query<{
      ownerUserId: string | null;
      onboardingVersion: number | string;
      onboardingCompletedAt: Date | string | null;
      starterRoomId: string | null;
    }>(
      `
        SELECT
          owner_user_id AS "ownerUserId",
          onboarding_version AS "onboardingVersion",
          onboarding_completed_at AS "onboardingCompletedAt",
          starter_room_id AS "starterRoomId"
        FROM space_owner_setup
        WHERE singleton = true
      `
    );
    const row = result.rows[0];
    if (!row?.ownerUserId) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    return {
      onboardingVersion: Number.parseInt(String(row.onboardingVersion), 10),
      isComplete: row.onboardingCompletedAt !== null,
      completedAt: row.onboardingCompletedAt === null ? null : toIso(row.onboardingCompletedAt),
      starterRoomId: row.starterRoomId
    };
  }

  async ensureOwnerStarterRoom(traceId = makeSpaceId("trace")): Promise<{ room: Room; onboarding: SetupOnboarding }> {
    return this.withTransaction(async (client) => {
      const setup = await client.query<{
        ownerUserId: string | null;
        starterRoomId: string | null;
      }>(
        `
          SELECT
            owner_user_id AS "ownerUserId",
            starter_room_id AS "starterRoomId"
          FROM space_owner_setup
          WHERE singleton = true
          FOR UPDATE
        `
      );
      const row = setup.rows[0];
      if (!row?.ownerUserId) {
        throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
      }

      let room: Room | null = null;
      if (row.starterRoomId) {
        const existing = await client.query<RoomRow>(`${roomSelect} WHERE id = $1`, [row.starterRoomId]);
        room = existing.rows[0] ? mapRoom(existing.rows[0]) : null;
      }
      if (!room) {
        room = await this.createStarterRoom(client, traceId);
        await client.query(
          `
            UPDATE space_owner_setup
            SET starter_room_id = $1, updated_at = now()
            WHERE singleton = true
          `,
          [room.id]
        );
      }

      const onboarding = await client.query<{
        onboardingVersion: number | string;
        onboardingCompletedAt: Date | string | null;
        starterRoomId: string | null;
      }>(
        `
          SELECT
            onboarding_version AS "onboardingVersion",
            onboarding_completed_at AS "onboardingCompletedAt",
            starter_room_id AS "starterRoomId"
          FROM space_owner_setup
          WHERE singleton = true
        `
      );
      const state = onboarding.rows[0]!;
      return {
        room,
        onboarding: {
          onboardingVersion: Number.parseInt(String(state.onboardingVersion), 10),
          isComplete: state.onboardingCompletedAt !== null,
          completedAt: state.onboardingCompletedAt === null ? null : toIso(state.onboardingCompletedAt),
          starterRoomId: state.starterRoomId
        }
      };
    });
  }

  async completeOwnerOnboarding(completedAt: string): Promise<SetupOnboarding> {
    const parsedCompletedAt = toIso(completedAt);
    const result = await this.pool.query<{
      onboardingVersion: number | string;
      onboardingCompletedAt: Date | string;
      starterRoomId: string | null;
    }>(
      `
        UPDATE space_owner_setup
        SET
          onboarding_version = $1,
          onboarding_completed_at = $2,
          updated_at = $2
        WHERE singleton = true
          AND owner_user_id IS NOT NULL
        RETURNING
          onboarding_version AS "onboardingVersion",
          onboarding_completed_at AS "onboardingCompletedAt",
          starter_room_id AS "starterRoomId"
      `,
      [currentSetupOnboardingVersion, parsedCompletedAt]
    );
    const row = firstOrNotFound(result.rows, "SpaceApp owner setup has not been claimed.");
    return {
      onboardingVersion: Number.parseInt(String(row.onboardingVersion), 10),
      isComplete: true,
      completedAt: toIso(row.onboardingCompletedAt),
      starterRoomId: row.starterRoomId
    };
  }

  async listSetupConnectionVerifications(): Promise<SetupConnectionVerification[]> {
    const result = await this.pool.query<{
      connectionId: string;
      state: PersistedSetupConnectionState;
      reasonCode: string | null;
      fingerprintHash: string | null;
      verifiedAt: Date | string | null;
      updatedAt: Date | string;
    }>(
      `
        SELECT
          connection_id AS "connectionId",
          state,
          reason_code AS "reasonCode",
          fingerprint_hash AS "fingerprintHash",
          verified_at AS "verifiedAt",
          updated_at AS "updatedAt"
        FROM space_setup_connection_verifications
        ORDER BY connection_id ASC
      `
    );
    return result.rows.map((row) => ({
      ...row,
      verifiedAt: row.verifiedAt === null ? null : toIso(row.verifiedAt),
      updatedAt: toIso(row.updatedAt)
    }));
  }

  async getSetupConnectionVerification(
    connectionId: string
  ): Promise<SetupConnectionVerification | null> {
    const result = await this.pool.query<{
      connectionId: string;
      state: PersistedSetupConnectionState;
      reasonCode: string | null;
      fingerprintHash: string | null;
      verifiedAt: Date | string | null;
      updatedAt: Date | string;
    }>(
      `
        SELECT
          connection_id AS "connectionId",
          state,
          reason_code AS "reasonCode",
          fingerprint_hash AS "fingerprintHash",
          verified_at AS "verifiedAt",
          updated_at AS "updatedAt"
        FROM space_setup_connection_verifications
        WHERE connection_id = $1
      `,
      [connectionId]
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          verifiedAt: row.verifiedAt === null ? null : toIso(row.verifiedAt),
          updatedAt: toIso(row.updatedAt)
        }
      : null;
  }

  async upsertSetupConnectionVerification(
    input: UpsertSetupConnectionVerificationInput
  ): Promise<SetupConnectionVerification> {
    const result = await this.pool.query<{
      connectionId: string;
      state: PersistedSetupConnectionState;
      reasonCode: string | null;
      fingerprintHash: string | null;
      verifiedAt: Date | string | null;
      updatedAt: Date | string;
    }>(
      `
        INSERT INTO space_setup_connection_verifications (
          connection_id,
          state,
          reason_code,
          fingerprint_hash,
          verified_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (connection_id)
        DO UPDATE SET
          state = EXCLUDED.state,
          reason_code = EXCLUDED.reason_code,
          fingerprint_hash = EXCLUDED.fingerprint_hash,
          verified_at = EXCLUDED.verified_at,
          updated_at = EXCLUDED.updated_at
        RETURNING
          connection_id AS "connectionId",
          state,
          reason_code AS "reasonCode",
          fingerprint_hash AS "fingerprintHash",
          verified_at AS "verifiedAt",
          updated_at AS "updatedAt"
      `,
      [
        input.connectionId,
        input.state,
        input.reasonCode,
        input.fingerprintHash,
        input.verifiedAt,
        input.updatedAt
      ]
    );
    const row = firstOrNotFound(result.rows, `Setup connection ${input.connectionId} was not found.`);
    return {
      ...row,
      verifiedAt: row.verifiedAt === null ? null : toIso(row.verifiedAt),
      updatedAt: toIso(row.updatedAt)
    };
  }

  async createSetupConnectionCheckRun(
    input: CreateSetupConnectionCheckRunInput
  ): Promise<SetupConnectionCheckRun> {
    const parsed = createSetupConnectionCheckRunInputSchema.parse(input);
    const runId = makeSpaceId("setup_check_run");
    const timestamp = nowIso();
    const result = await this.pool.query<SetupConnectionCheckRunRow>(
      `
        INSERT INTO space_setup_connection_check_runs (
          id,
          scope,
          connection_ids,
          actor_user_id,
          status,
          total_count,
          completed_count,
          created_at,
          updated_at,
          finished_at
        )
        VALUES ($1, $2, $3, $4, 'RUNNING', $5, 0, $6, $6, NULL)
        RETURNING
          id,
          scope,
          connection_ids AS "connectionIds",
          status,
          total_count AS "totalCount",
          completed_count AS "completedCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          finished_at AS "finishedAt"
      `,
      [
        runId,
        parsed.scope,
        parsed.connectionIds,
        parsed.actorUserId,
        parsed.connectionIds.length,
        timestamp
      ]
    );
    return mapSetupConnectionCheckRun(
      firstOrNotFound(result.rows, `Setup connection check run ${runId} was not created.`)
    );
  }

  async getSetupConnectionCheckRun(runId: string): Promise<SetupConnectionCheckRun | null> {
    const parsedRunId = idSchema.parse(runId);
    const result = await this.pool.query<SetupConnectionCheckRunRow>(
      `${setupConnectionCheckRunsSelect} WHERE id = $1`,
      [parsedRunId]
    );
    return result.rows[0] ? mapSetupConnectionCheckRun(result.rows[0]) : null;
  }

  async listSetupConnectionCheckRuns(limit = 50): Promise<SetupConnectionCheckRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Setup connection check run limit is invalid.");
    }
    const result = await this.pool.query<SetupConnectionCheckRunRow>(
      `${setupConnectionCheckRunsSelect} ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapSetupConnectionCheckRun);
  }

  async updateSetupConnectionCheckRun(
    runId: string,
    input: UpdateSetupConnectionCheckRunInput
  ): Promise<SetupConnectionCheckRun> {
    const parsedRunId = idSchema.parse(runId);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<SetupConnectionCheckRunRow>(
        `${setupConnectionCheckRunsSelect} WHERE id = $1 FOR UPDATE`,
        [parsedRunId]
      );
      const current = mapSetupConnectionCheckRun(
        firstOrNotFound(currentResult.rows, `Setup connection check run ${parsedRunId} was not found.`)
      );
      const next = updateSetupConnectionCheckRunRecord(current, input);
      const result = await client.query<SetupConnectionCheckRunRow>(
        `
          UPDATE space_setup_connection_check_runs
          SET
            status = $2,
            completed_count = $3,
            updated_at = $4,
            finished_at = $5
          WHERE id = $1
          RETURNING
            id,
            scope,
            connection_ids AS "connectionIds",
            status,
            total_count AS "totalCount",
            completed_count AS "completedCount",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            finished_at AS "finishedAt"
        `,
        [parsedRunId, next.status, next.completedCount, next.updatedAt, next.finishedAt]
      );
      return mapSetupConnectionCheckRun(
        firstOrNotFound(result.rows, `Setup connection check run ${parsedRunId} was not updated.`)
      );
    });
  }

  async appendSetupConnectionCheckEvent(
    input: CreateSetupConnectionCheckEventInput
  ): Promise<SetupConnectionCheckEvent> {
    const parsed = createSetupConnectionCheckEventInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const runResult = await client.query<{ connectionIds: string[] }>(
        `
          SELECT connection_ids AS "connectionIds"
          FROM space_setup_connection_check_runs
          WHERE id = $1
          FOR SHARE
        `,
        [parsed.runId]
      );
      if (!runResult.rows[0]?.connectionIds.includes(parsed.connectionId)) {
        throw new SpaceNotFoundError(`Setup connection check run ${parsed.runId} was not found.`);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [parsed.runId]);
      const createdAt = nowIso();
      const result = await client.query<SetupConnectionCheckEventRow>(
        `
          INSERT INTO space_setup_connection_check_events (
            id,
            run_id,
            sequence,
            connection_id,
            stage,
            state,
            functional_state,
            live_verification_state,
            reason_code,
            created_at
          )
          SELECT
            $1,
            $2,
            COALESCE(MAX(sequence), 0) + 1,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9
          FROM space_setup_connection_check_events
          WHERE run_id = $2
          RETURNING
            id,
            run_id AS "runId",
            sequence,
            connection_id AS "connectionId",
            stage,
            state,
            functional_state AS "functionalState",
            live_verification_state AS "liveVerificationState",
            reason_code AS "reasonCode",
            created_at AS "createdAt"
        `,
        [
          makeSpaceId("setup_check_event"),
          parsed.runId,
          parsed.connectionId,
          parsed.stage,
          parsed.state,
          parsed.functionalState,
          parsed.liveVerificationState,
          parsed.reasonCode,
          createdAt
        ]
      );
      return mapSetupConnectionCheckEvent(
        firstOrNotFound(result.rows, `Setup connection check event for ${parsed.runId} was not created.`)
      );
    });
  }

  async listSetupConnectionCheckEvents(
    runId: string,
    afterSequence = 0,
    limit = 500
  ): Promise<SetupConnectionCheckEvent[]> {
    const parsedRunId = idSchema.parse(runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Setup connection check event cursor is invalid.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Setup connection check event limit is invalid.");
    }
    const result = await this.pool.query<SetupConnectionCheckEventRow>(
      `${setupConnectionCheckEventsSelect}
       WHERE run_id = $1 AND sequence > $2
       ORDER BY sequence ASC, id ASC
       LIMIT $3`,
      [parsedRunId, afterSequence, limit]
    );
    return result.rows.map(mapSetupConnectionCheckEvent);
  }

  async getOwnerCredentials(): Promise<OwnerCredentials | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      role: AuthUser["role"];
      passwordHash: string;
    }>(
      `
        SELECT
          users.id,
          users.email,
          users.role,
          users.password_hash AS "passwordHash"
        FROM space_owner_setup
        INNER JOIN users ON users.id = space_owner_setup.owner_user_id
        WHERE space_owner_setup.singleton = true
          AND users.password_hash IS NOT NULL
      `
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      user: authUserSchema.parse({ id: row.id, email: row.email, role: row.role }),
      passwordHash: row.passwordHash
    };
  }

  async updateOwnerPassword(passwordHash: string): Promise<AuthUser> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      role: AuthUser["role"];
    }>(
      `
        UPDATE users
        SET password_hash = $1, updated_at = now()
        WHERE id = (
          SELECT owner_user_id
          FROM space_owner_setup
          WHERE singleton = true
        )
        RETURNING id, email, role
      `,
      [passwordHash]
    );
    const row = result.rows[0];
    if (!row) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    return authUserSchema.parse(row);
  }

  async upsertPublicWaitlistSignup(input: PublicWaitlistSignupInput): Promise<PublicWaitlistSignupOutcome> {
    const email = input.email.trim();
    const normalizedEmail = email.toLowerCase();
    const result = await this.pool.query<{ outcome: PublicWaitlistSignupOutcome }>(
      `
        WITH inserted AS (
          INSERT INTO public_waitlist_signups (
            email,
            consented_at,
            source,
            created_at
          )
          VALUES ($1, clock_timestamp(), $2, clock_timestamp())
          ON CONFLICT (email) DO NOTHING
          RETURNING email
        )
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM inserted) THEN 'CREATED'
          ELSE 'DUPLICATE'
        END::text AS outcome
      `,
      [normalizedEmail, input.source]
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome !== "CREATED" && outcome !== "DUPLICATE") {
      throw new Error("Public waitlist upsert returned an invalid outcome.");
    }
    return outcome;
  }

  async upsertClipboardItem(input: UpsertClipboardItemInput): Promise<ClipboardItem> {
    const parsed = upsertClipboardItemInputSchema.parse(input);
    const contentHash = createHash("sha256").update(parsed.text).digest("hex");
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [parsed.ownerUserId]);
      const result = await client.query<ClipboardItemRow>(
        `
          INSERT INTO clipboard_items (
            id, owner_user_id, content_hash, text, source, title, room_id, pane_id, pane_title,
            occurrence_count, character_count, created_at, last_used_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, char_length($4), clock_timestamp(), clock_timestamp())
          ON CONFLICT (owner_user_id, content_hash)
          DO UPDATE SET
            text = EXCLUDED.text,
            source = EXCLUDED.source,
            title = EXCLUDED.title,
            room_id = EXCLUDED.room_id,
            pane_id = EXCLUDED.pane_id,
            pane_title = EXCLUDED.pane_title,
            occurrence_count = clipboard_items.occurrence_count + 1,
            character_count = EXCLUDED.character_count,
            last_used_at = clock_timestamp()
          RETURNING
            id,
            text,
            source,
            title,
            room_id AS "roomId",
            pane_id AS "paneId",
            pane_title AS "paneTitle",
            occurrence_count AS "occurrenceCount",
            character_count AS "characterCount",
            created_at AS "createdAt",
            last_used_at AS "lastUsedAt"
        `,
        [
          makeSpaceId("clipboard"),
          parsed.ownerUserId,
          contentHash,
          parsed.text,
          parsed.source,
          parsed.title ?? null,
          parsed.roomId ?? null,
          parsed.paneId ?? null,
          parsed.paneTitle ?? null
        ]
      );
      await client.query(
        `
          DELETE FROM clipboard_items
          WHERE owner_user_id = $1
            AND id NOT IN (
              SELECT id
              FROM clipboard_items
              WHERE owner_user_id = $1
              ORDER BY last_used_at DESC, id DESC
              LIMIT 100
            )
        `,
        [parsed.ownerUserId]
      );
      return mapClipboardItem(firstOrNotFound(result.rows, "Clipboard item was not stored."));
    });
  }

  async getClipboardItem(ownerUserId: string, clipboardItemId: string): Promise<ClipboardItem | null> {
    const result = await this.pool.query<ClipboardItemRow>(
      `${clipboardItemSelect} WHERE owner_user_id = $1 AND id = $2 LIMIT 1`,
      [ownerUserId, clipboardItemId]
    );
    return result.rows[0] ? mapClipboardItem(result.rows[0]) : null;
  }

  async listClipboardItems(
    ownerUserId: string,
    query: ListClipboardItemsQuery = { page: 1, pageSize: 25 }
  ): Promise<ClipboardItemListResult> {
    const parsed = listClipboardItemsQuerySchema.parse(query);
    const conditions = ["owner_user_id = $1"];
    const values: unknown[] = [ownerUserId];
    if (parsed.source) {
      values.push(parsed.source);
      conditions.push(`source = $${values.length}`);
    }
    if (parsed.q) {
      const escapedSearch = parsed.q.replace(/[\\%_]/g, "\\$&");
      values.push(`%${escapedSearch}%`);
      conditions.push(`text ILIKE $${values.length} ESCAPE '\\'`);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const countResult = await this.pool.query<CountRow>(
      `SELECT count(*) AS count FROM clipboard_items ${where}`,
      values
    );
    const pageValues = [...values, parsed.pageSize, (parsed.page - 1) * parsed.pageSize];
    const itemsResult = await this.pool.query<ClipboardItemRow>(
      `${clipboardItemSelect} ${where} ORDER BY last_used_at DESC, id DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    return {
      items: itemsResult.rows.map(mapClipboardItem),
      total: Number.parseInt(String(countResult.rows[0]?.count ?? 0), 10)
    };
  }

  async deleteClipboardItem(ownerUserId: string, clipboardItemId: string): Promise<ClipboardItem> {
    const result = await this.pool.query<ClipboardItemRow>(
      `
        DELETE FROM clipboard_items
        WHERE owner_user_id = $1 AND id = $2
        RETURNING
          id,
          text,
          source,
          room_id AS "roomId",
          pane_id AS "paneId",
          pane_title AS "paneTitle",
          occurrence_count AS "occurrenceCount",
          character_count AS "characterCount",
          created_at AS "createdAt",
          last_used_at AS "lastUsedAt"
      `,
      [ownerUserId, clipboardItemId]
    );
    return mapClipboardItem(
      firstOrNotFound(result.rows, `Clipboard item ${clipboardItemId} was not found.`)
    );
  }

  async clearClipboardItems(ownerUserId: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM clipboard_items WHERE owner_user_id = $1", [ownerUserId]);
    return result.rowCount ?? 0;
  }

  private async initializeUserLinks(ownerUserId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user-links:${ownerUserId}`]);
      const initialized = await client.query(
        `INSERT INTO user_link_libraries (owner_user_id) VALUES ($1) ON CONFLICT (owner_user_id) DO NOTHING RETURNING owner_user_id`,
        [ownerUserId]
      );
      if (!initialized.rowCount) return;
      for (const [sortOrder, seed] of defaultUserLinks.entries()) {
        await client.query(
          `INSERT INTO user_links (id, owner_user_id, title, description, url, open_mode, is_quick, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [makeSpaceId("link"), ownerUserId, seed.title, seed.description, seed.url, seed.openMode, seed.isQuick, sortOrder]
        );
      }
    });
  }

  async listUserLinks(ownerUserId: string, query: ListUserLinksQuery = { isQuick: undefined, page: 1, pageSize: 25 }): Promise<UserLinkListResult> {
    await this.initializeUserLinks(ownerUserId);
    const parsed = listUserLinksQuerySchema.parse(query);
    const conditions = ["owner_user_id = $1"];
    const values: unknown[] = [ownerUserId];
    if (parsed.isQuick !== undefined) {
      values.push(parsed.isQuick);
      conditions.push(`is_quick = $${values.length}`);
    }
    if (parsed.q) {
      values.push(`%${parsed.q.replace(/[\\%_]/g, "\\$&")}%`);
      conditions.push(`(title ILIKE $${values.length} ESCAPE '\\' OR description ILIKE $${values.length} ESCAPE '\\')`);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const count = await this.pool.query<CountRow>(`SELECT count(*) AS count FROM user_links ${where}`, values);
    const pageValues = [...values, parsed.pageSize, (parsed.page - 1) * parsed.pageSize];
    const items = await this.pool.query<UserLinkRow>(
      `${userLinkSelect} ${where} ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues
    );
    return { items: items.rows.map(mapUserLink), total: Number.parseInt(String(count.rows[0]?.count ?? 0), 10) };
  }

  async createUserLink(input: CreateUserLinkInput): Promise<UserLink> {
    const { ownerUserId, ...request } = input;
    const parsed = createUserLinkRequestSchema.parse(request);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user-links:${ownerUserId}`]);
      const duplicate = await client.query(`SELECT id FROM user_links WHERE owner_user_id = $1 AND url = $2 LIMIT 1`, [ownerUserId, parsed.url]);
      if (duplicate.rows.length) throw new SpaceConflictError("A link with this URL already exists.");
      const order = await client.query<OrderRow>(`SELECT COALESCE(max(sort_order), -1) + 1 AS "nextOrder" FROM user_links WHERE owner_user_id = $1`, [ownerUserId]);
      const result = await client.query<UserLinkRow>(
        `INSERT INTO user_links (id, owner_user_id, title, description, url, open_mode, is_quick, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, description, url, open_mode AS "openMode", is_quick AS "isQuick", sort_order AS "sortOrder", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [makeSpaceId("link"), ownerUserId, parsed.title, parsed.description, parsed.url, parsed.openMode, parsed.isQuick, Number(order.rows[0]?.nextOrder ?? 0)]
      );
      return mapUserLink(firstOrNotFound(result.rows, "Link was not stored."));
    });
  }

  async updateUserLink(ownerUserId: string, linkId: string, input: UpdateUserLinkRequest): Promise<UserLink> {
    const parsed = updateUserLinkRequestSchema.parse(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`user-links:${ownerUserId}`]);
      const current = await client.query<UserLinkRow>(`${userLinkSelect} WHERE owner_user_id = $1 AND id = $2 LIMIT 1`, [ownerUserId, linkId]);
      const existing = current.rows[0];
      if (!existing) throw new SpaceNotFoundError(`Link ${linkId} was not found.`);
      const next = userLinkSchema.parse({ ...mapUserLink(existing), ...parsed, updatedAt: nowIso() });
      const duplicate = await client.query(`SELECT id FROM user_links WHERE owner_user_id = $1 AND url = $2 AND id <> $3 LIMIT 1`, [ownerUserId, next.url, linkId]);
      if (duplicate.rows.length) throw new SpaceConflictError("A link with this URL already exists.");
      const result = await client.query<UserLinkRow>(
        `UPDATE user_links SET title = $3, description = $4, url = $5, open_mode = $6, is_quick = $7, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2
         RETURNING id, title, description, url, open_mode AS "openMode", is_quick AS "isQuick", sort_order AS "sortOrder", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [ownerUserId, linkId, next.title, next.description, next.url, next.openMode, next.isQuick]
      );
      return mapUserLink(firstOrNotFound(result.rows, `Link ${linkId} was not found.`));
    });
  }

  async deleteUserLink(ownerUserId: string, linkId: string): Promise<UserLink> {
    const result = await this.pool.query<UserLinkRow>(
      `DELETE FROM user_links WHERE owner_user_id = $1 AND id = $2
       RETURNING id, title, description, url, open_mode AS "openMode", is_quick AS "isQuick", sort_order AS "sortOrder", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [ownerUserId, linkId]
    );
    return mapUserLink(firstOrNotFound(result.rows, `Link ${linkId} was not found.`));
  }

  async listRooms(): Promise<Room[]> {
    const result = await this.pool.query<RoomRow>(`${roomSelect} ORDER BY room_order ASC, created_at ASC`);
    return result.rows.map(mapRoom);
  }

  async listRunningCliSessionCountsByRoom(runtimeIds?: string[]): Promise<RoomCliActivity[]> {
    const result = await this.pool.query<{ roomId: string; runningCliCount: number | string }>(
      `
        SELECT
          r.id AS "roomId",
          COUNT(s.session_id)::integer AS "runningCliCount"
        FROM rooms r
        LEFT JOIN pane_cli_sessions s
          ON s.room_id = r.id
         AND s.status = 'RUNNING'
         AND ($1::text[] IS NULL OR s.runtime_id = ANY($1::text[]))
        GROUP BY r.id, r.room_order, r.created_at
        ORDER BY r.room_order ASC, r.created_at ASC
      `,
      [runtimeIds ?? null]
    );
    return result.rows.map((row) => ({
      roomId: row.roomId,
      runningCliCount: Number(row.runningCliCount)
    }));
  }

  async listCliRuntimeSettings(): Promise<CliRuntimeSetting[]> {
    const result = await this.pool.query<CliRuntimeSettingRow>(`${cliRuntimeSettingsSelect} ORDER BY runtime_id ASC`);
    const stored = new Map(result.rows.map((row) => [row.runtimeId, mapCliRuntimeSetting(row)]));
    return cliToggleRuntimeIds.map((runtimeId) => stored.get(runtimeId) ?? cliRuntimeSettingSchema.parse({
      runtimeId,
      enabled: true,
      vpnEnabled: false,
      updatedAt: "1970-01-01T00:00:00.000Z",
      updatedBy: null
    }));
  }

  async getCliRuntimeSetting(runtimeId: CliToggleRuntimeId): Promise<CliRuntimeSetting> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const result = await this.pool.query<CliRuntimeSettingRow>(`${cliRuntimeSettingsSelect} WHERE runtime_id = $1`, [parsedRuntimeId]);
    return result.rows[0] ? mapCliRuntimeSetting(result.rows[0]) : cliRuntimeSettingSchema.parse({
      runtimeId: parsedRuntimeId,
      enabled: true,
      vpnEnabled: false,
      updatedAt: "1970-01-01T00:00:00.000Z",
      updatedBy: null
    });
  }

  async updateCliRuntimeSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeSettingInput,
    updatedBy: string
  ): Promise<CliRuntimeSetting> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const parsed = updateCliRuntimeSettingInputSchema.parse(input);
    const actorId = idSchema.parse(updatedBy);
    const updatedAt = nowIso();
    const result = await this.pool.query<CliRuntimeSettingRow>(
      `
        INSERT INTO cli_runtime_settings (runtime_id, enabled, updated_at, updated_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (runtime_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
        RETURNING
          runtime_id AS "runtimeId",
          enabled,
          vpn_enabled AS "vpnEnabled",
          updated_at AS "updatedAt",
          updated_by AS "updatedBy"
      `,
      [parsedRuntimeId, parsed.enabled, updatedAt, actorId]
    );
    return mapCliRuntimeSetting(firstOrNotFound(result.rows, `CLI runtime setting ${parsedRuntimeId} was not updated.`));
  }

  async updateCliRuntimeVpnSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeVpnInput,
    updatedBy: string
  ): Promise<CliRuntimeSetting> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const parsed = updateCliRuntimeVpnInputSchema.parse(input);
    const actorId = idSchema.parse(updatedBy);
    const updatedAt = nowIso();
    const result = await this.pool.query<CliRuntimeSettingRow>(
      `
        INSERT INTO cli_runtime_settings (runtime_id, enabled, vpn_enabled, updated_at, updated_by)
        VALUES ($1, true, $2, $3, $4)
        ON CONFLICT (runtime_id) DO UPDATE SET
          vpn_enabled = EXCLUDED.vpn_enabled,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
        RETURNING
          runtime_id AS "runtimeId",
          enabled,
          vpn_enabled AS "vpnEnabled",
          updated_at AS "updatedAt",
          updated_by AS "updatedBy"
      `,
      [parsedRuntimeId, parsed.enabled, updatedAt, actorId]
    );
    return mapCliRuntimeSetting(firstOrNotFound(result.rows, `CLI VPN setting ${parsedRuntimeId} was not updated.`));
  }

  async createAdminOperationRun(input: CreateAdminOperationRunInput): Promise<AdminOperationRun> {
    const parsed = createAdminOperationRunInputSchema.parse(input);
    const runId = makeSpaceId("admin_run");
    const timestamp = nowIso();
    const result = await this.pool.query<AdminOperationRunRow>(
      `
        INSERT INTO admin_operation_runs (
          id, operation_type, status, actor_user_id, summary, result,
          created_at, started_at, finished_at, updated_at
        )
        VALUES ($1, $2, 'QUEUED', $3, $4, $5, $6, NULL, NULL, $6)
        RETURNING
          id,
          operation_type AS "operationType",
          status,
          actor_user_id AS "actorUserId",
          summary,
          result,
          created_at AS "createdAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt"
      `,
      [runId, parsed.operationType, parsed.actorUserId, parsed.summary, parsed.result ?? {}, timestamp]
    );
    return mapAdminOperationRun(firstOrNotFound(result.rows, `Admin operation ${runId} was not created.`));
  }

  async getAdminOperationRun(runId: string): Promise<AdminOperationRun | null> {
    const parsedRunId = idSchema.parse(runId);
    const result = await this.pool.query<AdminOperationRunRow>(`${adminOperationRunsSelect} WHERE id = $1`, [parsedRunId]);
    return result.rows[0] ? mapAdminOperationRun(result.rows[0]) : null;
  }

  async listAdminOperationRuns(limit = 50): Promise<AdminOperationRun[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    const result = await this.pool.query<AdminOperationRunRow>(
      `${adminOperationRunsSelect} ORDER BY created_at DESC, id DESC LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(mapAdminOperationRun);
  }

  async updateAdminOperationRun(runId: string, input: UpdateAdminOperationRunInput): Promise<AdminOperationRun> {
    const parsedRunId = idSchema.parse(runId);
    const parsed = updateAdminOperationRunInputSchema.parse(input);
    const existing = await this.getAdminOperationRun(parsedRunId);
    if (!existing) throw new SpaceNotFoundError(`Admin operation ${parsedRunId} was not found.`);
    const next = adminOperationRunSchema.parse({
      ...existing,
      ...parsed,
      updatedAt: nowIso()
    });
    const result = await this.pool.query<AdminOperationRunRow>(
      `
        UPDATE admin_operation_runs
        SET status = $2,
            summary = $3,
            result = $4,
            started_at = $5,
            finished_at = $6,
            updated_at = $7
        WHERE id = $1
        RETURNING
          id,
          operation_type AS "operationType",
          status,
          actor_user_id AS "actorUserId",
          summary,
          result,
          created_at AS "createdAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          updated_at AS "updatedAt"
      `,
      [parsedRunId, next.status, next.summary, next.result, next.startedAt, next.finishedAt, next.updatedAt]
    );
    return mapAdminOperationRun(firstOrNotFound(result.rows, `Admin operation ${parsedRunId} was not updated.`));
  }

  async appendCliMaintenanceEvent(input: CreateCliMaintenanceEventInput): Promise<CliMaintenanceEvent> {
    const parsed = createCliMaintenanceEventInputSchema.parse({
      ...input,
      diagnostics: redactCliMaintenanceDiagnostics(input.diagnostics)
    });
    return this.withTransaction(async (client) => {
      const runResult = await client.query<{ operationType: AdminOperationRun["operationType"] }>(
        `SELECT operation_type AS "operationType" FROM admin_operation_runs WHERE id = $1 FOR SHARE`,
        [parsed.runId]
      );
      const operationType = runResult.rows[0]?.operationType;
      if (!operationType?.startsWith("CLI_MAINTENANCE_")) {
        throw new SpaceNotFoundError(`CLI maintenance run ${parsed.runId} was not found.`);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [parsed.runId]);
      const result = await client.query<CliMaintenanceEventRow>(
        `
          INSERT INTO cli_maintenance_events (
            id, run_id, sequence, runtime_id, phase, state, severity, code, message,
            attempt, installed_version, available_version, target_version, duration_ms,
            outcome, rollback, diagnostics, created_at
          )
          SELECT
            $1,
            $2,
            COALESCE(MAX(sequence), 0) + 1,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17
          FROM cli_maintenance_events
          WHERE run_id = $2
          RETURNING
            id,
            run_id AS "runId",
            sequence,
            runtime_id AS "runtimeId",
            phase,
            state,
            severity,
            code,
            message,
            attempt,
            installed_version AS "installedVersion",
            available_version AS "availableVersion",
            target_version AS "targetVersion",
            duration_ms AS "durationMs",
            outcome,
            rollback,
            diagnostics,
            created_at AS "createdAt"
        `,
        [
          makeSpaceId("cli_maintenance_event"),
          parsed.runId,
          parsed.runtimeId,
          parsed.phase,
          parsed.state,
          parsed.severity,
          parsed.code,
          parsed.message,
          parsed.attempt,
          parsed.installedVersion,
          parsed.availableVersion,
          parsed.targetVersion,
          parsed.durationMs,
          parsed.outcome,
          parsed.rollback,
          parsed.diagnostics,
          nowIso()
        ]
      );
      return mapCliMaintenanceEvent(
        firstOrNotFound(result.rows, `CLI maintenance event for ${parsed.runId} was not created.`)
      );
    });
  }

  async listCliMaintenanceEvents(
    runId: string,
    afterSequence = 0,
    limit = 500
  ): Promise<CliMaintenanceEvent[]> {
    const parsedRunId = idSchema.parse(runId);
    const parsedAfterSequence = Math.max(0, Math.trunc(afterSequence));
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const result = await this.pool.query<CliMaintenanceEventRow>(
      `${cliMaintenanceEventsSelect}
       WHERE run_id = $1 AND sequence > $2
       ORDER BY sequence ASC, id ASC
       LIMIT $3`,
      [parsedRunId, parsedAfterSequence, boundedLimit]
    );
    return result.rows.map(mapCliMaintenanceEvent);
  }

  async createCliMaintenanceAuthHandoff(
    input: CreateCliMaintenanceAuthHandoffInput
  ): Promise<CliMaintenanceAuthHandoff> {
    const parsed = createCliMaintenanceAuthHandoffInputSchema.parse(input);
    const run = await this.getAdminOperationRun(parsed.runId);
    if (!run || !run.operationType.startsWith("CLI_MAINTENANCE_")) {
      throw new SpaceNotFoundError(`CLI maintenance run ${parsed.runId} was not found.`);
    }
    const timestamp = nowIso();
    const result = await this.pool.query<CliMaintenanceAuthHandoffRow>(
      `
        INSERT INTO cli_maintenance_auth_handoffs (
          id, run_id, runtime_id, room_id, status, attempt_count,
          safe_error_code, created_at, updated_at, completed_at
        )
        VALUES ($1, $2, $3, $4, 'PENDING', 0, NULL, $5, $5, NULL)
        RETURNING
          id,
          run_id AS "runId",
          runtime_id AS "runtimeId",
          room_id AS "roomId",
          status,
          attempt_count AS "attemptCount",
          safe_error_code AS "safeErrorCode",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
      [makeSpaceId("cli_auth_handoff"), parsed.runId, parsed.runtimeId, parsed.roomId, timestamp]
    );
    return mapCliMaintenanceAuthHandoff(
      firstOrNotFound(result.rows, `CLI auth handoff for ${parsed.runtimeId} was not created.`)
    );
  }

  async updateCliMaintenanceAuthHandoff(
    handoffId: string,
    input: UpdateCliMaintenanceAuthHandoffInput
  ): Promise<CliMaintenanceAuthHandoff> {
    const parsedHandoffId = idSchema.parse(handoffId);
    const parsed = updateCliMaintenanceAuthHandoffInputSchema.parse(input);
    const existingResult = await this.pool.query<CliMaintenanceAuthHandoffRow>(
      `${cliMaintenanceAuthHandoffsSelect} WHERE id = $1`,
      [parsedHandoffId]
    );
    const existing = mapCliMaintenanceAuthHandoff(
      firstOrNotFound(existingResult.rows, `CLI auth handoff ${parsedHandoffId} was not found.`)
    );
    const timestamp = nowIso();
    const nextStatus = parsed.status ?? existing.status;
    const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(nextStatus);
    const next = cliMaintenanceAuthHandoffSchema.parse({
      ...existing,
      ...parsed,
      status: nextStatus,
      updatedAt: timestamp,
      completedAt: terminal ? (existing.completedAt ?? timestamp) : null
    });
    const result = await this.pool.query<CliMaintenanceAuthHandoffRow>(
      `
        UPDATE cli_maintenance_auth_handoffs
        SET room_id = $2,
            status = $3,
            attempt_count = $4,
            safe_error_code = $5,
            updated_at = $6,
            completed_at = $7
        WHERE id = $1
        RETURNING
          id,
          run_id AS "runId",
          runtime_id AS "runtimeId",
          room_id AS "roomId",
          status,
          attempt_count AS "attemptCount",
          safe_error_code AS "safeErrorCode",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
      [
        parsedHandoffId,
        next.roomId,
        next.status,
        next.attemptCount,
        next.safeErrorCode,
        next.updatedAt,
        next.completedAt
      ]
    );
    return mapCliMaintenanceAuthHandoff(
      firstOrNotFound(result.rows, `CLI auth handoff ${parsedHandoffId} was not updated.`)
    );
  }

  async listCliMaintenanceAuthHandoffs(runId: string): Promise<CliMaintenanceAuthHandoff[]> {
    const parsedRunId = idSchema.parse(runId);
    const result = await this.pool.query<CliMaintenanceAuthHandoffRow>(
      `${cliMaintenanceAuthHandoffsSelect}
       WHERE run_id = $1
       ORDER BY created_at ASC, id ASC`,
      [parsedRunId]
    );
    return result.rows.map(mapCliMaintenanceAuthHandoff);
  }

  async listSourceControlConnections(): Promise<SourceControlConnectionRecord[]> {
    const result = await this.pool.query<SourceControlConnectionRow>(
      `${sourceControlConnectionsSelect} ORDER BY provider ASC`
    );
    const stored = new Map(result.rows.map((row) => [row.provider, mapSourceControlConnection(row)]));
    return (["gitea", "github"] as const).map((provider) => stored.get(provider) ?? this.defaultSourceControlConnection(provider));
  }

  async getSourceControlConnection(provider: SourceControlProvider): Promise<SourceControlConnectionRecord> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const result = await this.pool.query<SourceControlConnectionRow>(
      `${sourceControlConnectionsSelect} WHERE provider = $1`,
      [parsedProvider]
    );
    return result.rows[0] ? mapSourceControlConnection(result.rows[0]) : this.defaultSourceControlConnection(parsedProvider);
  }

  private defaultSourceControlConnection(provider: SourceControlProvider): SourceControlConnectionRecord {
    return {
      ...sourceControlConnectionSchema.parse({
        provider,
        repositoryOwner: "oll4com",
        repositoryName: "space",
        accountLogin: null,
        status: "DISCONNECTED",
        secretConfigured: false,
        lastVerifiedAt: null,
        lastVerificationCode: "NOT_VERIFIED",
        updatedAt: "1970-01-01T00:00:00.000Z"
      }),
      secretRef: null
    };
  }

  async upsertSourceControlConnection(input: UpsertSourceControlConnectionInput): Promise<SourceControlConnectionRecord> {
    const provider = sourceControlProviderSchema.parse(input.provider);
    const secretRef = input.secretRef === null
      ? null
      : /^source_control_(?:gitea|github)_[A-Za-z0-9_-]{8,96}$/.test(input.secretRef)
        ? input.secretRef
        : (() => {
            throw new Error("Invalid source-control secret reference.");
          })();
    const repositoryName = "space";
    const updatedAt = nowIso();
    const result = await this.pool.query<SourceControlConnectionRow>(
      `
        INSERT INTO source_control_connections (
          provider, repository_owner, repository_name, account_login, connection_status,
          secret_ref, last_verified_at, last_verification_code, updated_at
        )
        VALUES ($1, 'oll4com', $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (provider) DO UPDATE SET
          repository_owner = EXCLUDED.repository_owner,
          repository_name = EXCLUDED.repository_name,
          account_login = EXCLUDED.account_login,
          connection_status = EXCLUDED.connection_status,
          secret_ref = EXCLUDED.secret_ref,
          last_verified_at = EXCLUDED.last_verified_at,
          last_verification_code = EXCLUDED.last_verification_code,
          updated_at = EXCLUDED.updated_at
        RETURNING
          provider,
          repository_owner AS "repositoryOwner",
          repository_name AS "repositoryName",
          account_login AS "accountLogin",
          connection_status AS "connectionStatus",
          secret_ref AS "secretRef",
          last_verified_at AS "lastVerifiedAt",
          last_verification_code AS "lastVerificationCode",
          updated_at AS "updatedAt"
      `,
      [
        provider,
        repositoryName,
        input.accountLogin,
        input.connectionStatus,
        secretRef,
        input.lastVerifiedAt,
        input.lastVerificationCode,
        updatedAt
      ]
    );
    return mapSourceControlConnection(firstOrNotFound(result.rows, `Source-control connection ${provider} was not updated.`));
  }

  async createReleasePreview(
    input: CreateReleasePreviewStoreInput,
    actorUserId: string | null
  ): Promise<ReleasePreviewRecord> {
    const preview = releasePreviewSchema.parse({
      ...input,
      id: makeSpaceId("release_preview"),
      createdAt: nowIso()
    });
    const parsedActorUserId = actorUserId === null ? null : idSchema.parse(actorUserId);
    const result = await this.pool.query<ReleasePreviewRow>(
      `
        INSERT INTO release_previews (
          id, actor_user_id, tag, notes, source_commit, previous_tag,
          remote_main_commits, expires_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          id,
          actor_user_id AS "actorUserId",
          tag,
          notes,
          source_commit AS "sourceCommit",
          previous_tag AS "previousTag",
          remote_main_commits AS "remoteMainCommits",
          expires_at AS "expiresAt",
          created_at AS "createdAt"
      `,
      [
        preview.id,
        parsedActorUserId,
        preview.tag,
        preview.notes,
        preview.sourceCommit,
        preview.previousTag,
        preview.remoteMainCommits,
        preview.expiresAt,
        preview.createdAt
      ]
    );
    return mapReleasePreview(firstOrNotFound(result.rows, `Release preview ${preview.id} was not created.`));
  }

  async getReleasePreview(previewId: string): Promise<ReleasePreviewRecord | null> {
    const parsedPreviewId = idSchema.parse(previewId);
    const result = await this.pool.query<ReleasePreviewRow>(`${releasePreviewsSelect} WHERE id = $1`, [parsedPreviewId]);
    return result.rows[0] ? mapReleasePreview(result.rows[0]) : null;
  }

  async getRoom(roomId: string): Promise<Room> {
    const result = await this.pool.query<RoomRow>(`${roomSelect} WHERE id = $1`, [roomId]);
    return mapRoom(firstOrNotFound(result.rows, `Room ${roomId} was not found.`));
  }

  async createRoom(input: CreateRoomStoreInput, traceId = makeSpaceId("trace")): Promise<Room> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const roomId = makeSpaceId("room");
      const orderResult = await client.query<OrderRow>("SELECT COALESCE(MAX(room_order), -1) + 1 AS \"nextOrder\" FROM rooms");
      const nextOrder = Number.parseInt(String(orderResult.rows[0]?.nextOrder ?? 0), 10);
      const roomResult = await client.query<RoomRow>(
        `
          INSERT INTO rooms (id, name, description, room_order, pane_cap, trace_id, created_at, updated_at, kind)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
          RETURNING
            id,
            name,
            description,
            kind,
            room_order AS "order",
            pane_layout_columns AS "paneLayoutColumns",
            pane_cap AS "paneCap",
            trace_id AS "traceId",
            archived_at AS "archivedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [roomId, input.name, input.description ?? null, nextOrder, ACTIVE_PANE_CAP, traceId, timestamp, input.kind ?? "WORKSPACE"]
      );
      const room = mapRoom(firstOrNotFound(roomResult.rows, `Room ${roomId} was not created.`));
      await this.appendEvent(client, {
        roomId: room.id,
        paneId: null,
        turnId: null,
        traceId,
        type: "ROOM_CREATED",
        message: `Room ${room.name} created.`,
        payload: { initialPaneCount: input.initialPaneCount }
      });

      for (let index = 0; index < input.initialPaneCount; index += 1) {
        const title = defaultPaneTitles[index] ?? `Agent ${index + 1}`;
        const mode = index === 4 ? "BROWSER" : "CHAT";
        const pane = await this.insertPane(client, { roomId: room.id, title, mode }, index, traceId, timestamp);
        await this.appendEvent(client, {
          roomId: room.id,
          paneId: pane.id,
          turnId: null,
          traceId,
          type: "PANE_CREATED",
          message: `Pane ${pane.title} created.`,
          payload: { mode: pane.mode }
        });
      }

      return room;
    });
  }

  async updateRoom(roomId: string, input: UpdateRoomInput, traceId = makeSpaceId("trace")): Promise<Room> {
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, roomId);
      const result = await client.query<RoomRow>(
        `
          UPDATE rooms
          SET
            name = $2,
            description = COALESCE($3, description),
            trace_id = $4,
            updated_at = $5
          WHERE id = $1
          RETURNING
            id,
            name,
            description,
            kind,
            room_order AS "order",
            pane_layout_columns AS "paneLayoutColumns",
            pane_cap AS "paneCap",
            trace_id AS "traceId",
            archived_at AS "archivedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [roomId, input.name, input.description ?? null, traceId, nowIso()]
      );
      return mapRoom(firstOrNotFound(result.rows, `Room ${roomId} was not updated.`));
    });
  }

  async updateRoomPaneLayout(
    roomId: string,
    input: UpdatePaneLayoutInput,
    traceId = makeSpaceId("trace")
  ): Promise<RoomPaneLayoutResult> {
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, roomId);
      const timestamp = nowIso();
      const roomResult = await client.query<RoomRow>(
        `
          UPDATE rooms
          SET
            pane_layout_columns = $2,
            trace_id = $3,
            updated_at = $4
          WHERE id = $1
          RETURNING
            id,
            name,
            description,
            kind,
            room_order AS "order",
            pane_layout_columns AS "paneLayoutColumns",
            pane_cap AS "paneCap",
            trace_id AS "traceId",
            archived_at AS "archivedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [roomId, input.paneLayoutColumns, traceId, timestamp]
      );
      await client.query(
        `
          UPDATE panes
          SET
            column_span = 1,
            is_maximized = false,
            updated_at = $2
          WHERE room_id = $1 AND is_closed = false
        `,
        [roomId, timestamp]
      );
      const paneResult = await client.query<PaneRow>(
        `${paneSelect} WHERE room_id = $1 AND is_closed = false ORDER BY pane_order ASC, created_at ASC`,
        [roomId]
      );
      return {
        room: mapRoom(firstOrNotFound(roomResult.rows, `Room ${roomId} was not updated.`)),
        panes: paneResult.rows.map(mapPane)
      };
    });
  }

  async reorderRooms(roomIds: string[], traceId = makeSpaceId("trace")): Promise<Room[]> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<{ id: string }>("SELECT id FROM rooms FOR UPDATE");
      const currentIds = currentResult.rows.map((row) => row.id);
      const nextIds = new Set(roomIds);
      if (roomIds.length !== currentIds.length || nextIds.size !== roomIds.length || currentIds.some((roomId) => !nextIds.has(roomId))) {
        throw new SpaceConflictError("Room reorder payload must include every room exactly once.");
      }

      await client.query(
        `
          WITH ordered AS (
            SELECT id, ordinality - 1 AS room_order
            FROM unnest($1::text[]) WITH ORDINALITY AS item(id, ordinality)
          )
          UPDATE rooms
          SET
            room_order = -ordered.room_order - 1,
            trace_id = $2
          FROM ordered
          WHERE rooms.id = ordered.id
        `,
        [roomIds, traceId]
      );
      await client.query("UPDATE rooms SET room_order = -room_order - 1");

      const result = await client.query<RoomRow>(`${roomSelect} ORDER BY room_order ASC, created_at ASC`);
      return result.rows.map(mapRoom);
    });
  }

  async reorderPanes(roomId: string, paneIds: string[], traceId = makeSpaceId("trace")): Promise<Pane[]> {
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, roomId);
      const currentResult = await client.query<{ id: string }>(
        "SELECT id FROM panes WHERE room_id = $1 AND is_closed = false FOR UPDATE",
        [roomId]
      );
      const currentIds = currentResult.rows.map((row) => row.id);
      const nextIds = new Set(paneIds);
      if (
        paneIds.length !== currentIds.length ||
        nextIds.size !== paneIds.length ||
        currentIds.some((paneId) => !nextIds.has(paneId))
      ) {
        throw new SpaceConflictError("Pane reorder payload must include every active pane of the room exactly once.");
      }

      await client.query(
        `
          WITH ordered AS (
            SELECT id, ordinality - 1 AS pane_order
            FROM unnest($2::text[]) WITH ORDINALITY AS item(id, ordinality)
          )
          UPDATE panes
          SET
            pane_order = -ordered.pane_order - 1
          FROM ordered
          WHERE panes.id = ordered.id AND panes.room_id = $1
        `,
        [roomId, paneIds]
      );
      await client.query(
        "UPDATE panes SET pane_order = -pane_order - 1 WHERE room_id = $1 AND is_closed = false",
        [roomId]
      );

      const result = await client.query<PaneRow>(
        `${paneSelect} WHERE room_id = $1 AND is_closed = false ORDER BY pane_order ASC, created_at ASC`,
        [roomId]
      );
      return result.rows.map(mapPane);
    });
  }

  async deleteRoom(roomId: string): Promise<Room> {
    return this.withTransaction(async (client) => {
      const room = await this.getRoomForUpdate(client, roomId);
      await client.query("DELETE FROM rooms WHERE id = $1", [roomId]);
      await client.query(
        `
          WITH ordered AS (
            SELECT id, row_number() OVER (ORDER BY room_order ASC, created_at ASC) - 1 AS next_order
            FROM rooms
          )
          UPDATE rooms
          SET room_order = ordered.next_order
          FROM ordered
          WHERE rooms.id = ordered.id
        `
      );
      return room;
    }, { deadlockRetries: 1 });
  }

  async listPanes(roomId: string, includeClosed = false): Promise<Pane[]> {
    await this.getRoom(roomId);
    const result = await this.pool.query<PaneRow>(
      `${paneSelect} WHERE room_id = $1 AND ($2::boolean OR is_closed = false) ORDER BY pane_order ASC`,
      [roomId, includeClosed]
    );
    return result.rows.map(mapPane);
  }

  async getPane(paneId: string): Promise<Pane> {
    const result = await this.pool.query<PaneRow>(`${paneSelect} WHERE id = $1`, [paneId]);
    return mapPane(firstOrNotFound(result.rows, `Pane ${paneId} was not found.`));
  }

  async createPane(input: CreatePaneInput, traceId = makeSpaceId("trace")): Promise<Pane> {
    return this.withTransaction(async (client) => {
      const room = await this.getRoomForUpdate(client, input.roomId);
      const activeResult = await client.query<CountRow>("SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false", [
        input.roomId
      ]);
      const activeCount = countValue(activeResult.rows);
      if (activeCount >= room.paneCap) {
        throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
      }

      const timestamp = nowIso();
      const pane = await this.insertPane(client, input, await this.getNextOpenPaneOrder(client, input.roomId), traceId, timestamp);
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [input.roomId, timestamp]);
      await this.appendEvent(client, {
        roomId: input.roomId,
        paneId: pane.id,
        turnId: null,
        traceId,
        type: "PANE_CREATED",
        message: `Pane ${pane.title} created.`,
        payload: { mode: pane.mode }
      });
      return pane;
    });
  }

  async createPanes(inputs: CreatePaneInput[], traceId = makeSpaceId("trace")): Promise<Pane[]> {
    if (inputs.length === 0) return [];
    const roomId = inputs[0]!.roomId;
    if (inputs.some((input) => input.roomId !== roomId)) {
      throw new SpaceConflictError("A pane batch must target one room.");
    }

    return this.withTransaction(async (client) => {
      const room = await this.getRoomForUpdate(client, roomId);
      const activeResult = await client.query<CountRow>(
        "SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false",
        [roomId]
      );
      const activeCount = countValue(activeResult.rows);
      if (activeCount + inputs.length > room.paneCap) {
        throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
      }

      const timestamp = nowIso();
      const firstOrder = await this.getNextOpenPaneOrder(client, roomId);
      const panes: Pane[] = [];
      for (const [index, input] of inputs.entries()) {
        const order = firstOrder + index;
        const pane = await this.insertPane(
          client,
          { ...input, title: `${input.title} ${order + 1}` },
          order,
          traceId,
          timestamp
        );
        panes.push(pane);
        await this.appendEvent(client, {
          roomId,
          paneId: pane.id,
          turnId: null,
          traceId,
          type: "PANE_CREATED",
          message: `Pane ${pane.title} created.`,
          payload: { mode: pane.mode }
        });
      }
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [roomId, timestamp]);
      return panes;
    });
  }

  async getOrCreateRoomAgentPane(roomId: string, traceId = makeSpaceId("trace")): Promise<Pane> {
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, roomId);
      const existingResult = await client.query<PaneRow>(
        `
          SELECT
            p.id,
            p.room_id AS "roomId",
            p.title,
            p.mode,
            p.status,
            p.provider_id AS "providerId",
            p.model_id AS "modelId",
            p.terminal_runtime_id AS "terminalRuntimeId",
            p.reasoning_effort AS "reasoningEffort",
            p.cwd,
            p.pane_order AS "order",
            p.column_span AS "columnSpan",
            p.is_maximized AS "isMaximized",
            p.is_minimized AS "isMinimized",
            p.is_closed AS "isClosed",
            p.split,
            p.created_at AS "createdAt",
            p.updated_at AS "updatedAt"
          FROM room_agent_bindings b
          JOIN panes p ON p.id = b.pane_id
          WHERE b.room_id = $1
        `,
        [roomId]
      );
      if (existingResult.rows[0]) return mapPane(existingResult.rows[0]);

      const timestamp = nowIso();
      const inserted = await this.insertPane(
        client,
        {
          roomId,
          title: "Room Agent",
          mode: "CHAT",
          modelId: "gpt-5.6-sol"
        },
        0,
        traceId,
        timestamp
      );
      const paneResult = await client.query<PaneRow>(
        `
          UPDATE panes
          SET status = 'CLOSED',
              reasoning_effort = 'high',
              is_closed = true,
              updated_at = $2
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            title,
            mode,
            status,
            provider_id AS "providerId",
            model_id AS "modelId",
            terminal_runtime_id AS "terminalRuntimeId",
            reasoning_effort AS "reasoningEffort",
            cwd,
            pane_order AS "order",
            column_span AS "columnSpan",
            is_maximized AS "isMaximized",
            is_minimized AS "isMinimized",
            is_closed AS "isClosed",
            split,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [inserted.id, timestamp]
      );
      const pane = mapPane(firstOrNotFound(paneResult.rows, `Room agent pane ${inserted.id} was not initialized.`));
      await client.query(
        `
          INSERT INTO room_agent_bindings (room_id, pane_id, created_at, updated_at)
          VALUES ($1, $2, $3, $3)
        `,
        [roomId, pane.id, timestamp]
      );
      return pane;
    });
  }

  async getRoomAgentRequest(roomId: string, clientRequestId: string): Promise<RoomAgentRequestRecord | null> {
    const result = await this.pool.query<RoomAgentRequestRow>(
      `
        SELECT
          request_id AS "requestId",
          room_id AS "roomId",
          session_id AS "sessionId",
          mission_id AS "missionId",
          request_kind AS "requestKind",
          client_request_id AS "clientRequestId",
          prompt_message_id AS "promptMessageId",
          response_message_id AS "responseMessageId",
          created_at AS "createdAt"
        FROM room_agent_requests
        WHERE room_id = $1 AND client_request_id = $2
      `,
      [roomId, clientRequestId]
    );
    return result.rows[0] ? mapRoomAgentRequest(result.rows[0]) : null;
  }

  async getRoomAgentTranscriptClearedAt(roomId: string): Promise<string | null> {
    const result = await this.pool.query<{ transcriptClearedAt: Date | string | null }>(
      `SELECT transcript_cleared_at AS "transcriptClearedAt" FROM room_agent_bindings WHERE room_id = $1`,
      [roomId]
    );
    return toIso(result.rows[0]?.transcriptClearedAt ?? null);
  }

  async clearRoomAgentTranscript(roomId: string, clearedAt: string, _traceId = makeSpaceId("trace")): Promise<string> {
    const result = await this.pool.query<{ transcriptClearedAt: Date | string }>(
      `
        UPDATE room_agent_bindings
        SET transcript_cleared_at = $2, updated_at = $2
        WHERE room_id = $1
        RETURNING transcript_cleared_at AS "transcriptClearedAt"
      `,
      [roomId, clearedAt]
    );
    const value = result.rows[0]?.transcriptClearedAt;
    if (!value) throw new SpaceNotFoundError(`Room agent binding was not found in room ${roomId}.`);
    return toIso(value)!;
  }

  async createRoomAgentRequest(
    input: CreateRoomAgentRequestInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentRequestRecord> {
    const parsed = createRoomAgentRequestInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, parsed.roomId);
      const existingResult = await client.query<RoomAgentRequestRow>(
        `
          SELECT
            request_id AS "requestId",
            room_id AS "roomId",
            session_id AS "sessionId",
            mission_id AS "missionId",
            request_kind AS "requestKind",
            client_request_id AS "clientRequestId",
            prompt_message_id AS "promptMessageId",
            response_message_id AS "responseMessageId",
            created_at AS "createdAt"
          FROM room_agent_requests
          WHERE room_id = $1 AND client_request_id = $2
        `,
        [parsed.roomId, parsed.clientRequestId]
      );
      if (existingResult.rows[0]) {
        throw new SpaceConflictError(
          `Room agent request ${parsed.clientRequestId} already exists in room ${parsed.roomId}.`
        );
      }
      const result = await client.query<RoomAgentRequestRow>(
        `
          INSERT INTO room_agent_requests (
            request_id,
            room_id,
            session_id,
            mission_id,
            request_kind,
            client_request_id,
            prompt_message_id,
            response_message_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            request_id AS "requestId",
            room_id AS "roomId",
            session_id AS "sessionId",
            mission_id AS "missionId",
            request_kind AS "requestKind",
            client_request_id AS "clientRequestId",
            prompt_message_id AS "promptMessageId",
            response_message_id AS "responseMessageId",
            created_at AS "createdAt"
        `,
        [
          parsed.requestId,
          parsed.roomId,
          parsed.sessionId,
          parsed.missionId,
          parsed.requestKind,
          parsed.clientRequestId,
          parsed.promptMessageId,
          parsed.responseMessageId
        ]
      );
      return mapRoomAgentRequest(firstOrNotFound(result.rows, `Room agent request ${parsed.requestId} was not created.`));
    });
  }

  async enqueueRoomAgentMission(
    input: EnqueueRoomAgentMissionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentEnqueueRecord> {
    const queueItem = roomAgentSupervisorQueueItemSchema.parse(input.queueItem);
    const sessionId = queueItem.turn.agentSessionId;
    const agentRunId = queueItem.turn.agentRunId;
    if (!sessionId || !agentRunId) throw new SpaceNotFoundError("Room agent enqueue requires a durable session and run.");
    if (
      queueItem.missionId !== queueItem.turn.roomAgentMissionId ||
      agentRunId !== input.runId ||
      queueItem.turn.agentUserMessageId !== input.promptMessageId ||
      queueItem.turn.agentAssistantMessageId !== input.responseMessageId
    ) {
      throw new SpaceConflictError("Room agent enqueue identifiers do not match the durable queue item.");
    }

    const promptInput = createSpaceAgentMessageInputSchema.parse({
      messageId: input.promptMessageId,
      sessionId,
      role: "user",
      content: input.content,
      status: "COMPLETED"
    });
    return this.withTransaction(async (client) => {
      await this.getRoomForUpdate(client, queueItem.turn.roomId);
      const existingResult = await client.query<RoomAgentRequestWithPayloadRow>(
        `
          SELECT
            request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
            mission_id AS "missionId", request_kind AS "requestKind",
            client_request_id AS "clientRequestId", prompt_message_id AS "promptMessageId",
            response_message_id AS "responseMessageId", turn_payload AS "turnPayload", signaled_at AS "signaledAt",
            created_at AS "createdAt"
          FROM room_agent_requests
          WHERE room_id = $1 AND client_request_id = $2
          FOR UPDATE
        `,
        [queueItem.turn.roomId, input.clientRequestId]
      );
      const existingRow = existingResult.rows[0];
      if (existingRow) {
        const request = mapRoomAgentRequest(existingRow);
        const storedQueueItem = roomAgentSupervisorQueueItemSchema.parse(existingRow.turnPayload);
        const missionResult = await client.query<RoomAgentMissionRow>(
          `
            SELECT
              mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
              workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
              queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
              paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
              last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
            FROM room_agent_missions
            WHERE mission_id = $1 OR request_id = $2
          `,
          [request.missionId, request.requestId]
        );
        const promptResult = await client.query<SpaceAgentMessageRow>(`${spaceAgentMessageSelect} WHERE message_id = $1`, [
          request.promptMessageId
        ]);
        const responseResult = await client.query<SpaceAgentMessageRow>(`${spaceAgentMessageSelect} WHERE message_id = $1`, [
          request.responseMessageId
        ]);
        const runResult = await client.query<SpaceAgentRunRow>(
          `${spaceAgentRunSelect} WHERE prompt_message_id = $1 AND response_message_id = $2`,
          [request.promptMessageId, request.responseMessageId]
        );
        return {
          created: false,
          signaledAt: toIso(existingRow.signaledAt),
          request,
          mission: mapRoomAgentMission(firstOrNotFound(missionResult.rows, `Room agent mission for ${request.requestId} was not found.`)),
          promptMessage: mapSpaceAgentMessage(firstOrNotFound(promptResult.rows, `Room agent prompt ${request.promptMessageId} was not found.`)),
          responseMessage: mapSpaceAgentMessage(firstOrNotFound(responseResult.rows, `Room agent response ${request.responseMessageId} was not found.`)),
          run: mapSpaceAgentRun(firstOrNotFound(runResult.rows, `Room agent run for ${request.requestId} was not found.`)),
          queueItem: storedQueueItem
        };
      }

      const sessionResult = await client.query<SpaceAgentSessionRow>(
        `${spaceAgentSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = mapSpaceAgentSession(firstOrNotFound(sessionResult.rows, `Space agent session ${sessionId} was not found.`));
      if (session.roomId !== queueItem.turn.roomId || session.paneId !== queueItem.turn.paneId) {
        throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found in room ${queueItem.turn.roomId}.`);
      }
      const linkedMissionResult = await client.query<RoomAgentMissionRow>(
        `
          SELECT
            mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
            workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
            queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
            paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
            last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
          FROM room_agent_missions
          WHERE room_id = $1 AND mission_id = $2
          FOR UPDATE
        `,
        [queueItem.turn.roomId, queueItem.missionId]
      );
      let linkedMission = linkedMissionResult.rows[0] ? mapRoomAgentMission(linkedMissionResult.rows[0]) : null;
      if (linkedMission && !["QUEUED", "RUNNING", "PAUSED"].includes(linkedMission.status)) {
        throw new SpaceConflictError(`Room agent mission ${linkedMission.id} no longer accepts follow-up requests.`);
      }
      if (linkedMission && "pendingCompletion" in linkedMission.executionState) {
        const { pendingCompletion: _completed, ...executionState } = linkedMission.executionState;
        const continuedAt = nowIso();
        const continuedResult = await client.query<RoomAgentMissionRow>(
          `
            UPDATE room_agent_missions
            SET execution_state = $3::jsonb,
                completed_at = NULL,
                status_reason = $4,
                last_progress_at = $5,
                updated_at = $5
            WHERE mission_id = $1 AND room_id = $2
            RETURNING
              mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
              workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
              queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
              paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
              last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
          `,
          [
            linkedMission.id,
            linkedMission.roomId,
            JSON.stringify(executionState),
            linkedMission.status === "PAUSED"
              ? "Follow-up queued for the paused Room Agent goal."
              : "Follow-up queued for the active Room Agent goal.",
            continuedAt
          ]
        );
        linkedMission = mapRoomAgentMission(firstOrNotFound(
          continuedResult.rows,
          `Room agent mission ${linkedMission.id} was not extended.`
        ));
      }
      const responseInput = createSpaceAgentMessageInputSchema.parse({
        messageId: input.responseMessageId,
        sessionId,
        role: "assistant",
        content: linkedMission
          ? "Follow-up received for the active Room Agent goal. I will continue with it in this conversation."
          : "Queued for the Room Agent supervisor.",
        status: "RUNNING"
      });
      const runInput = createSpaceAgentRunInputSchema.parse({
        runId: input.runId,
        sessionId,
        paneId: queueItem.turn.paneId,
        roomId: queueItem.turn.roomId,
        workflowId: input.childWorkflowId,
        temporalRunId: null,
        status: "QUEUED",
        promptMessageId: promptInput.messageId,
        responseMessageId: responseInput.messageId,
        codexThreadId: queueItem.turn.agentThreadId ?? null,
        codexTurnId: null
      });
      const requestInput = createRoomAgentRequestInputSchema.parse({
        requestId: input.requestId,
        roomId: queueItem.turn.roomId,
        sessionId,
        missionId: linkedMission?.id ?? null,
        requestKind: linkedMission ? "FOLLOW_UP" : "MISSION",
        clientRequestId: input.clientRequestId,
        promptMessageId: promptInput.messageId,
        responseMessageId: responseInput.messageId
      });
      const missionInput = linkedMission ? null : createRoomAgentMissionInputSchema.parse({
        id: queueItem.missionId,
        requestId: requestInput.requestId,
        roomId: queueItem.turn.roomId,
        sessionId,
        workflowId: input.supervisorWorkflowId,
        status: "QUEUED",
        currentPaneId: null,
        statusReason: "Mission queued behind any active room work."
      });
      const timestamp = nowIso();
      const insertMessage = async (message: typeof promptInput | typeof responseInput) => {
        const result = await client.query<SpaceAgentMessageRow>(
          `
            INSERT INTO space_agent_messages (message_id, session_id, run_id, role, content, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
            RETURNING
              message_id AS "messageId", session_id AS "sessionId", run_id AS "runId", role, content, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
          `,
          [message.messageId, sessionId, input.runId, message.role, message.content, message.status, timestamp]
        );
        return mapSpaceAgentMessage(firstOrNotFound(result.rows, `Room agent message ${message.messageId} was not stored.`));
      };
      const promptMessage = await insertMessage(promptInput);
      const responseMessage = await insertMessage(responseInput);
      const requestResult = await client.query<RoomAgentRequestRow>(
        `
          INSERT INTO room_agent_requests (
            request_id, room_id, session_id, mission_id, request_kind,
            client_request_id, prompt_message_id, response_message_id, turn_payload
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          RETURNING
            request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
            mission_id AS "missionId", request_kind AS "requestKind",
            client_request_id AS "clientRequestId", prompt_message_id AS "promptMessageId",
            response_message_id AS "responseMessageId", created_at AS "createdAt"
        `,
        [requestInput.requestId, requestInput.roomId, requestInput.sessionId, requestInput.missionId,
          requestInput.requestKind, requestInput.clientRequestId, requestInput.promptMessageId,
          requestInput.responseMessageId, JSON.stringify(queueItem)]
      );
      let request = mapRoomAgentRequest(firstOrNotFound(requestResult.rows, `Room agent request ${requestInput.requestId} was not created.`));
      const missionResult = missionInput ? await client.query<RoomAgentMissionRow>(
        `
          INSERT INTO room_agent_missions (
            mission_id, request_id, room_id, session_id, workflow_id, status, current_pane_id, status_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
            workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
            queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
            paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
            last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
        `,
        [missionInput.id, missionInput.requestId, missionInput.roomId, missionInput.sessionId, missionInput.workflowId,
          missionInput.status, missionInput.currentPaneId, missionInput.statusReason]
      ) : null;
      const mission = linkedMission ?? mapRoomAgentMission(firstOrNotFound(
        missionResult?.rows ?? [],
        `Room agent mission ${missionInput?.id ?? queueItem.missionId} was not created.`
      ));
      if (!linkedMission) {
        await client.query(`UPDATE room_agent_requests SET mission_id = $2 WHERE request_id = $1`, [request.requestId, mission.id]);
        request = roomAgentRequestRecordSchema.parse({ ...request, missionId: mission.id });
      }
      const runResult = await client.query<SpaceAgentRunRow>(
        `
          INSERT INTO space_agent_runs (
            run_id, session_id, pane_id, room_id, workflow_id, temporal_run_id, codex_thread_id, codex_turn_id,
            status, prompt_message_id, response_message_id, error_code, error_message, created_at, updated_at, completed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15)
          RETURNING
            run_id AS "runId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            workflow_id AS "workflowId", temporal_run_id AS "temporalRunId", codex_thread_id AS "codexThreadId",
            codex_turn_id AS "codexTurnId", status, prompt_message_id AS "promptMessageId",
            response_message_id AS "responseMessageId", error_code AS "errorCode", error_message AS "errorMessage",
            created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
        `,
        [runInput.runId, runInput.sessionId, runInput.paneId, runInput.roomId, runInput.workflowId,
          runInput.temporalRunId ?? null, runInput.codexThreadId ?? null, runInput.codexTurnId ?? null, runInput.status,
          runInput.promptMessageId, runInput.responseMessageId, runInput.errorCode ?? null, runInput.errorMessage ?? null,
          timestamp, runInput.completedAt ?? null]
      );
      const run = mapSpaceAgentRun(firstOrNotFound(runResult.rows, `Room agent run ${runInput.runId} was not stored.`));
      await client.query(
        `UPDATE space_agent_sessions SET status = 'RUNNING', last_synced_at = $2, updated_at = $2 WHERE session_id = $1`,
        [sessionId, timestamp]
      );
      return { created: true, signaledAt: null, request, mission, promptMessage, responseMessage, run, queueItem };
    });
  }

  async markRoomAgentMissionSignaled(roomId: string, clientRequestId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE room_agent_requests SET signaled_at = $3 WHERE room_id = $1 AND client_request_id = $2`,
      [roomId, clientRequestId, nowIso()]
    );
    if (!result.rowCount) throw new SpaceNotFoundError(`Room agent request ${clientRequestId} was not found in room ${roomId}.`);
  }

  async listUnsignaledRoomAgentEnqueues(limit = 20): Promise<RoomAgentEnqueueRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query<RoomAgentRequestWithPayloadRow>(
      `
        SELECT
          r.request_id AS "requestId", r.room_id AS "roomId", r.session_id AS "sessionId",
          r.mission_id AS "missionId", r.request_kind AS "requestKind",
          r.client_request_id AS "clientRequestId", r.prompt_message_id AS "promptMessageId",
          r.response_message_id AS "responseMessageId", r.turn_payload AS "turnPayload",
          r.signaled_at AS "signaledAt", r.created_at AS "createdAt"
        FROM room_agent_requests r
        JOIN room_agent_missions m ON m.mission_id = r.mission_id OR (r.mission_id IS NULL AND m.request_id = r.request_id)
        WHERE r.signaled_at IS NULL AND m.status IN ('QUEUED', 'RUNNING', 'PAUSED') AND r.turn_payload IS NOT NULL
        ORDER BY m.queued_at ASC
        LIMIT $1
      `,
      [boundedLimit]
    );
    return Promise.all(
      result.rows.map((row) => {
        const queueItem = roomAgentSupervisorQueueItemSchema.parse(row.turnPayload);
        return this.enqueueRoomAgentMission({
          requestId: row.requestId,
          clientRequestId: row.clientRequestId,
          content: "Durable Room Agent startup recovery.",
          supervisorWorkflowId: buildRoomAgentSupervisorWorkflowId(row.roomId),
          childWorkflowId: buildCodexAppServerTurnWorkflowId(queueItem.turn),
          promptMessageId: row.promptMessageId,
          responseMessageId: row.responseMessageId,
          runId: queueItem.turn.agentRunId ?? "agent_run:missing",
          queueItem
        });
      })
    );
  }

  async createRoomAgentMission(
    input: CreateRoomAgentMissionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentMissionRecord> {
    const parsed = createRoomAgentMissionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const requestResult = await client.query<{ requestId: string }>(
        `
          SELECT request_id AS "requestId"
          FROM room_agent_requests
          WHERE request_id = $1 AND room_id = $2 AND session_id = $3
          FOR UPDATE
        `,
        [parsed.requestId, parsed.roomId, parsed.sessionId]
      );
      if (!requestResult.rows[0]) throw new SpaceNotFoundError(`Room agent request ${parsed.requestId} was not found.`);
      const result = await client.query<RoomAgentMissionRow>(
        `
          INSERT INTO room_agent_missions (
            mission_id,
            request_id,
            room_id,
            session_id,
            workflow_id,
            status,
            current_pane_id,
            status_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            mission_id AS id,
            request_id AS "requestId",
            room_id AS "roomId",
            session_id AS "sessionId",
            workflow_id AS "workflowId",
            status,
            current_pane_id AS "currentPaneId",
            status_reason AS "statusReason",
            queued_at AS "queuedAt",
            started_at AS "startedAt",
            completed_at AS "completedAt",
            paused_at AS "pausedAt",
            total_paused_ms::float8 AS "totalPausedMs",
            last_progress_at AS "lastProgressAt",
            execution_state AS "executionState",
            updated_at AS "updatedAt"
        `,
        [
          parsed.id,
          parsed.requestId,
          parsed.roomId,
          parsed.sessionId,
          parsed.workflowId,
          parsed.status,
          parsed.currentPaneId,
          parsed.statusReason
        ]
      );
      return mapRoomAgentMission(firstOrNotFound(result.rows, `Room agent mission ${parsed.id} was not created.`));
    });
  }

  async updateRoomAgentMission(
    missionId: string,
    input: UpdateRoomAgentMissionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentMissionRecord> {
    const parsed = updateRoomAgentMissionInputSchema.parse(input);
    const result = await this.pool.query<RoomAgentMissionRow>(
      `
        UPDATE room_agent_missions
        SET status = COALESCE($2, status),
            current_pane_id = CASE WHEN $3::boolean THEN $4 ELSE current_pane_id END,
            status_reason = COALESCE($5, status_reason),
            started_at = CASE WHEN $6::boolean THEN $7 ELSE started_at END,
            completed_at = CASE WHEN $8::boolean THEN $9 ELSE completed_at END,
            paused_at = CASE WHEN $10::boolean THEN $11 ELSE paused_at END,
            total_paused_ms = COALESCE($12, total_paused_ms),
            last_progress_at = CASE WHEN $13::boolean THEN $14 ELSE last_progress_at END,
            execution_state = CASE WHEN $15::boolean THEN $16::jsonb ELSE execution_state END,
            updated_at = $17
        WHERE mission_id = $1
        RETURNING
          mission_id AS id,
          request_id AS "requestId",
          room_id AS "roomId",
          session_id AS "sessionId",
          workflow_id AS "workflowId",
          status,
          current_pane_id AS "currentPaneId",
          status_reason AS "statusReason",
          queued_at AS "queuedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          paused_at AS "pausedAt",
          total_paused_ms::float8 AS "totalPausedMs",
          last_progress_at AS "lastProgressAt",
          execution_state AS "executionState",
          updated_at AS "updatedAt"
      `,
      [
        missionId,
        parsed.status ?? null,
        "currentPaneId" in parsed,
        parsed.currentPaneId ?? null,
        parsed.statusReason ?? null,
        "startedAt" in parsed,
        parsed.startedAt ?? null,
        "completedAt" in parsed,
        parsed.completedAt ?? null,
        "pausedAt" in parsed,
        parsed.pausedAt ?? null,
        parsed.totalPausedMs ?? null,
        "lastProgressAt" in parsed,
        parsed.lastProgressAt ?? null,
        "executionState" in parsed,
        JSON.stringify(parsed.executionState ?? {}),
        nowIso()
      ]
    );
    return mapRoomAgentMission(firstOrNotFound(result.rows, `Room agent mission ${missionId} was not found.`));
  }

  async getRoomAgentMission(roomId: string, missionId: string): Promise<RoomAgentMissionRecord | null> {
    const result = await this.pool.query<RoomAgentMissionRow>(
      `
        SELECT
          mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
          workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
          queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
          paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
          last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
        FROM room_agent_missions
        WHERE room_id = $1 AND mission_id = $2
      `,
      [roomId, missionId]
    );
    return result.rows[0] ? mapRoomAgentMission(result.rows[0]) : null;
  }

  async listRoomAgentMissions(roomId: string, limit?: number): Promise<RoomAgentMissionRecord[]> {
    await this.getRoom(roomId);
    const boundedLimit = limit === undefined ? null : Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<RoomAgentMissionRow>(
      `
        SELECT * FROM (
          SELECT
            mission_id AS id, request_id AS "requestId", room_id AS "roomId", session_id AS "sessionId",
            workflow_id AS "workflowId", status, current_pane_id AS "currentPaneId", status_reason AS "statusReason",
            queued_at AS "queuedAt", started_at AS "startedAt", completed_at AS "completedAt",
            paused_at AS "pausedAt", total_paused_ms::float8 AS "totalPausedMs",
            last_progress_at AS "lastProgressAt", execution_state AS "executionState", updated_at AS "updatedAt"
          FROM room_agent_missions
          WHERE room_id = $1
          ORDER BY queued_at DESC
          LIMIT COALESCE($2, 2147483647)
        ) recent_missions
        ORDER BY "queuedAt" ASC
      `,
      [roomId, boundedLimit]
    );
    return result.rows.map(mapRoomAgentMission);
  }

  async createRoomAgentAction(
    input: CreateRoomAgentActionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentActionRecord> {
    const parsed = createRoomAgentActionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const missionResult = await client.query<{ id: string }>(
        `SELECT mission_id AS id FROM room_agent_missions WHERE mission_id = $1 AND room_id = $2 FOR UPDATE`,
        [parsed.missionId, parsed.roomId]
      );
      if (!missionResult.rows[0]) throw new SpaceNotFoundError(`Room agent mission ${parsed.missionId} was not found.`);
      const existingResult = await client.query<{ actionId: string }>(
        `SELECT action_id AS "actionId" FROM room_agent_actions WHERE idempotency_key = $1`,
        [parsed.idempotencyKey]
      );
      if (existingResult.rows[0]) throw new SpaceConflictError(`Room agent action ${parsed.idempotencyKey} already exists.`);
      const result = await client.query<RoomAgentActionRow>(
        `
          INSERT INTO room_agent_actions (
            action_id,
            mission_id,
            room_id,
            pane_id,
            idempotency_key,
            action_type,
            status,
            request_payload,
            evidence,
            attempt_count,
            status_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            action_id AS "actionId",
            mission_id AS "missionId",
            room_id AS "roomId",
            pane_id AS "paneId",
            idempotency_key AS "idempotencyKey",
            action_type AS "actionType",
            status,
            request_payload AS "requestPayload",
            evidence,
            attempt_count AS "attemptCount",
            status_reason AS "statusReason",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            completed_at AS "completedAt"
        `,
        [
          parsed.actionId,
          parsed.missionId,
          parsed.roomId,
          parsed.paneId,
          parsed.idempotencyKey,
          parsed.actionType,
          parsed.status,
          JSON.stringify(parsed.requestPayload),
          JSON.stringify(parsed.evidence),
          parsed.attemptCount,
          parsed.statusReason
        ]
      );
      return mapRoomAgentAction(firstOrNotFound(result.rows, `Room agent action ${parsed.actionId} was not created.`));
    });
  }

  async updateRoomAgentAction(
    actionId: string,
    input: UpdateRoomAgentActionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentActionRecord> {
    const parsed = updateRoomAgentActionInputSchema.parse(input);
    const result = await this.pool.query<RoomAgentActionRow>(
      `
        UPDATE room_agent_actions
        SET pane_id = CASE WHEN $2::boolean THEN $3 ELSE pane_id END,
            status = COALESCE($4, status),
            evidence = COALESCE($5::jsonb, evidence),
            attempt_count = COALESCE($6, attempt_count),
            status_reason = COALESCE($7, status_reason),
            completed_at = CASE WHEN $8::boolean THEN $9 ELSE completed_at END,
            updated_at = $10
        WHERE action_id = $1
        RETURNING
          action_id AS "actionId",
          mission_id AS "missionId",
          room_id AS "roomId",
          pane_id AS "paneId",
          idempotency_key AS "idempotencyKey",
          action_type AS "actionType",
          status,
          request_payload AS "requestPayload",
          evidence,
          attempt_count AS "attemptCount",
          status_reason AS "statusReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
      [
        actionId,
        "paneId" in parsed,
        parsed.paneId ?? null,
        parsed.status ?? null,
        parsed.evidence === undefined ? null : JSON.stringify(parsed.evidence),
        parsed.attemptCount ?? null,
        parsed.statusReason ?? null,
        "completedAt" in parsed,
        parsed.completedAt ?? null,
        nowIso()
      ]
    );
    return mapRoomAgentAction(firstOrNotFound(result.rows, `Room agent action ${actionId} was not found.`));
  }

  async getRoomAgentAction(missionId: string, actionId: string): Promise<RoomAgentActionRecord | null> {
    const result = await this.pool.query<RoomAgentActionRow>(
      `
        SELECT
          action_id AS "actionId", mission_id AS "missionId", room_id AS "roomId", pane_id AS "paneId",
          idempotency_key AS "idempotencyKey", action_type AS "actionType", status, request_payload AS "requestPayload",
          evidence, attempt_count AS "attemptCount", status_reason AS "statusReason", created_at AS "createdAt",
          updated_at AS "updatedAt", completed_at AS "completedAt"
        FROM room_agent_actions
        WHERE mission_id = $1 AND action_id = $2
      `,
      [missionId, actionId]
    );
    return result.rows[0] ? mapRoomAgentAction(result.rows[0]) : null;
  }

  async listRoomAgentActions(missionId: string): Promise<RoomAgentActionRecord[]> {
    const missionResult = await this.pool.query<{ id: string }>(
      `SELECT mission_id AS id FROM room_agent_missions WHERE mission_id = $1`,
      [missionId]
    );
    if (!missionResult.rows[0]) throw new SpaceNotFoundError(`Room agent mission ${missionId} was not found.`);
    const result = await this.pool.query<RoomAgentActionRow>(
      `
        SELECT
          action_id AS "actionId",
          mission_id AS "missionId",
          room_id AS "roomId",
          pane_id AS "paneId",
          idempotency_key AS "idempotencyKey",
          action_type AS "actionType",
          status,
          request_payload AS "requestPayload",
          evidence,
          attempt_count AS "attemptCount",
          status_reason AS "statusReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM room_agent_actions
        WHERE mission_id = $1
        ORDER BY created_at ASC
      `,
      [missionId]
    );
    return result.rows.map(mapRoomAgentAction);
  }

  async upsertRoomAgentTaskRun(
    input: UpsertRoomAgentTaskRunInput,
    _traceId = makeSpaceId("trace")
  ): Promise<RoomAgentTaskRunRecord> {
    const parsed = upsertRoomAgentTaskRunInputSchema.parse(input);
    const resultPayload = {
      state: parsed.state,
      modelId: parsed.modelId,
      reasoningEffort: parsed.reasoningEffort,
      qualityScore: parsed.qualityScore,
      qualityUnavailableReason: parsed.qualityUnavailableReason,
      reliabilityScore: parsed.reliabilityScore,
      combinedScore: parsed.combinedScore,
      rubric: parsed.rubric,
      queueMs: parsed.queueMs,
      firstResponseMs: parsed.firstResponseMs,
      executionMs: parsed.executionMs,
      totalMs: parsed.totalMs,
      retries: parsed.retries,
      recoveries: parsed.recoveries,
      stalls: parsed.stalls,
      verificationSummary: parsed.verificationSummary
    };
    const result = await this.pool.query<RoomAgentTaskRunRow>(
      `
        INSERT INTO room_agent_task_runs (
          run_id, mission_id, room_id, step_id, pane_id, label, instruction, status,
          result_payload, queued_at, started_at, first_response_at, completed_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (mission_id, step_id) DO UPDATE SET
          pane_id = EXCLUDED.pane_id,
          label = EXCLUDED.label,
          instruction = EXCLUDED.instruction,
          status = EXCLUDED.status,
          result_payload = EXCLUDED.result_payload,
          started_at = COALESCE(room_agent_task_runs.started_at, EXCLUDED.started_at),
          first_response_at = COALESCE(room_agent_task_runs.first_response_at, EXCLUDED.first_response_at),
          completed_at = EXCLUDED.completed_at,
          updated_at = EXCLUDED.updated_at
        RETURNING
          run_id AS "runId", mission_id AS "missionId", room_id AS "roomId", step_id AS "stepId",
          pane_id AS "paneId", label, instruction, status, result_payload AS "resultPayload",
          queued_at AS "queuedAt", started_at AS "startedAt", first_response_at AS "firstResponseAt",
          completed_at AS "completedAt", updated_at AS "updatedAt"
      `,
      [
        parsed.runId, parsed.missionId, parsed.roomId, parsed.stepId, parsed.paneId, parsed.label,
        parsed.instruction, parsed.status, JSON.stringify(resultPayload), parsed.queuedAt, parsed.startedAt,
        parsed.firstResponseAt, parsed.completedAt, nowIso()
      ]
    );
    return mapRoomAgentTaskRun(firstOrNotFound(result.rows, `Room agent task run ${parsed.stepId} was not persisted.`));
  }

  async getRoomAgentTaskRun(missionId: string, stepId: string): Promise<RoomAgentTaskRunRecord | null> {
    const result = await this.pool.query<RoomAgentTaskRunRow>(
      `SELECT run_id AS "runId", mission_id AS "missionId", room_id AS "roomId", step_id AS "stepId",
        pane_id AS "paneId", label, instruction, status, result_payload AS "resultPayload",
        queued_at AS "queuedAt", started_at AS "startedAt", first_response_at AS "firstResponseAt",
        completed_at AS "completedAt", updated_at AS "updatedAt"
       FROM room_agent_task_runs WHERE mission_id = $1 AND step_id = $2`,
      [missionId, stepId]
    );
    return result.rows[0] ? mapRoomAgentTaskRun(result.rows[0]) : null;
  }

  async listRoomAgentTaskRuns(missionId: string): Promise<RoomAgentTaskRunRecord[]> {
    const result = await this.pool.query<RoomAgentTaskRunRow>(
      `SELECT run_id AS "runId", mission_id AS "missionId", room_id AS "roomId", step_id AS "stepId",
        pane_id AS "paneId", label, instruction, status, result_payload AS "resultPayload",
        queued_at AS "queuedAt", started_at AS "startedAt", first_response_at AS "firstResponseAt",
        completed_at AS "completedAt", updated_at AS "updatedAt"
       FROM room_agent_task_runs WHERE mission_id = $1 ORDER BY queued_at ASC, step_id ASC`,
      [missionId]
    );
    return result.rows.map(mapRoomAgentTaskRun);
  }

  async updatePane(paneId: string, input: UpdatePaneInput, traceId = makeSpaceId("trace")): Promise<Pane> {
    return this.withTransaction(async (client) => {
      const current = await this.getPaneForUpdate(client, paneId);
      let nextOpenOrder: number | null = null;
      if (input.isClosed === false && current.isClosed) {
        const room = await this.getRoomForUpdate(client, current.roomId);
        const activeResult = await client.query<CountRow>("SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false", [
          current.roomId
        ]);
        if (countValue(activeResult.rows) >= room.paneCap) {
          throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
        }
        nextOpenOrder = await this.getNextOpenPaneOrder(client, current.roomId);
      }

      const timestamp = nowIso();
      const reopening = input.isClosed === false && current.isClosed;
      const isMinimized = reopening
        ? false
        : input.isMaximized === true
          ? false
          : input.isMinimized ?? current.isMinimized;
      const isMaximized = reopening
        ? false
        : input.isMinimized === true
          ? false
          : input.isMaximized ?? current.isMaximized;
      const updated: Pane = {
        ...current,
        ...input,
        providerId: input.providerId === undefined ? current.providerId : input.providerId,
        modelId: input.modelId === undefined ? current.modelId : input.modelId,
        terminalRuntimeId:
          (input.mode ?? current.mode) === "TERMINAL"
            ? input.terminalRuntimeId === undefined
              ? current.terminalRuntimeId
              : input.terminalRuntimeId
            : null,
        cwd: input.cwd === undefined ? current.cwd : input.cwd,
        order: nextOpenOrder ?? current.order,
        split: input.split === undefined ? current.split : input.split,
        isMaximized,
        isMinimized,
        updatedAt: timestamp
      };

      const result = await client.query<PaneRow>(
        `
          UPDATE panes
          SET title = $2,
              mode = $3,
              status = $4,
              provider_id = $5,
              model_id = $6,
              terminal_runtime_id = $7,
              reasoning_effort = $8,
              cwd = $9,
              pane_order = $10,
              column_span = $11,
              is_maximized = $12,
              is_minimized = $13,
              is_closed = $14,
              split = $15,
              updated_at = $16
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            title,
            mode,
            status,
            provider_id AS "providerId",
            model_id AS "modelId",
            terminal_runtime_id AS "terminalRuntimeId",
            reasoning_effort AS "reasoningEffort",
            cwd,
            pane_order AS "order",
            column_span AS "columnSpan",
            is_maximized AS "isMaximized",
            is_minimized AS "isMinimized",
            is_closed AS "isClosed",
            split,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          paneId,
          updated.title,
          updated.mode,
          updated.status,
          updated.providerId,
          updated.modelId,
          updated.terminalRuntimeId,
          updated.reasoningEffort,
          updated.cwd,
          updated.order,
          updated.columnSpan,
          updated.isMaximized,
          updated.isMinimized,
          updated.isClosed,
          JSON.stringify(updated.split),
          timestamp
        ]
      );
      const pane = mapPane(firstOrNotFound(result.rows, `Pane ${paneId} was not found.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [pane.roomId, timestamp]);
      await this.appendEvent(client, {
        roomId: pane.roomId,
        paneId: pane.id,
        turnId: null,
        traceId,
        type: pane.isClosed ? "PANE_CLOSED" : "PANE_UPDATED",
        message: `Pane ${pane.title} ${pane.isClosed ? "closed" : "updated"}.`,
        payload: { status: pane.status, mode: pane.mode }
      });
      return pane;
    });
  }

  async movePane(paneId: string, input: MovePaneInput, traceId = makeSpaceId("trace")): Promise<MovePaneResult> {
    const parsed = movePaneInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const current = await this.getPaneForUpdate(client, paneId);
      if (current.isClosed) {
        throw new SpaceConflictError(`Pane ${current.title} is already closed and cannot be moved.`);
      }
      if (parsed.targetRoomId === current.roomId) {
        throw new SpaceConflictError("Choose a different room before moving this pane.");
      }

      const lockedRooms = new Map<string, Room>();
      for (const roomId of [current.roomId, parsed.targetRoomId].sort()) {
        if (!lockedRooms.has(roomId)) {
          lockedRooms.set(roomId, await this.getRoomForUpdate(client, roomId));
        }
      }
      const targetRoom = lockedRooms.get(parsed.targetRoomId)!;
      const activeResult = await client.query<CountRow>("SELECT count(*) AS count FROM panes WHERE room_id = $1 AND is_closed = false", [
        parsed.targetRoomId
      ]);
      if (countValue(activeResult.rows) >= targetRoom.paneCap) {
        throw new SpaceConflictError(`Room ${targetRoom.id} is capped at ${targetRoom.paneCap} active panes.`);
      }

      const timestamp = nowIso();
      const sourcePane = current;
      const targetSplit = { parentId: null, direction: null, size: null };
      const targetResult = await client.query<PaneRow>(
        `
          UPDATE panes
          SET room_id = $2,
              pane_order = $3,
              column_span = 1,
              is_maximized = false,
              is_minimized = false,
              split = $4,
              updated_at = $5
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            title,
            mode,
            status,
            provider_id AS "providerId",
            model_id AS "modelId",
            terminal_runtime_id AS "terminalRuntimeId",
            reasoning_effort AS "reasoningEffort",
            cwd,
            pane_order AS "order",
            column_span AS "columnSpan",
            is_maximized AS "isMaximized",
            is_minimized AS "isMinimized",
            is_closed AS "isClosed",
            split,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          current.id,
          parsed.targetRoomId,
          await this.getNextOpenPaneOrder(client, parsed.targetRoomId),
          JSON.stringify(targetSplit),
          timestamp
        ]
      );
      const targetPane = mapPane(firstOrNotFound(targetResult.rows, `Pane ${current.id} was not updated.`));
      await this.reassignPaneRoomReferences(client, current.id, targetPane.roomId, timestamp);
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [sourcePane.roomId, timestamp]);
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [targetPane.roomId, timestamp]);
      await this.appendEvent(client, {
        roomId: sourcePane.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "PANE_UPDATED",
        message: `Pane ${sourcePane.title} moved to another room.`,
        payload: {
          status: targetPane.status,
          mode: targetPane.mode,
          move: {
            action: "source_reassigned",
            sourcePaneId: sourcePane.id,
            sourceRoomId: sourcePane.roomId,
            targetPaneId: targetPane.id,
            targetRoomId: targetPane.roomId
          }
        }
      });
      await this.appendEvent(client, {
        roomId: targetPane.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "PANE_UPDATED",
        message: `Pane ${targetPane.title} moved from another room.`,
        payload: {
          status: targetPane.status,
          mode: targetPane.mode,
          move: {
            action: "target_received",
            sourcePaneId: sourcePane.id,
            sourceRoomId: sourcePane.roomId,
            targetPaneId: targetPane.id,
            targetRoomId: targetPane.roomId
          }
        }
      });

      return {
        sourcePane,
        targetPane,
        sourceRoomId: sourcePane.roomId,
        targetRoomId: targetPane.roomId
      };
    });
  }

  async getAgentPaneBinding(paneId: string): Promise<AgentPaneBinding | null> {
    const result = await this.pool.query<AgentPaneBindingRow>(`${agentPaneBindingSelect} WHERE pane_id = $1`, [paneId]);
    return result.rows[0] ? mapAgentPaneBinding(result.rows[0]) : null;
  }

  async listAgentPaneHistory(roomId?: string): Promise<AgentPaneHistoryItem[]> {
    const result = await this.pool.query<AgentPaneHistoryRow>(
      `
        WITH session_history AS (
          SELECT
            s.pane_id,
            s.room_id,
            s.source,
            s.coder_chat_id,
            COALESCE(active.status, s.status) AS status,
            s.title,
            s.selected_model_config_id,
            s.selected_provider_name,
            s.selected_model_name,
            s.selected_reasoning_key,
            s.selected_tool_ids,
            s.last_synced_at,
            s.created_at,
            s.updated_at
          FROM pane_agent_sessions s
          LEFT JOIN pane_agent_bindings active
            ON active.pane_id = s.pane_id
           AND active.coder_chat_id = s.coder_chat_id
          UNION ALL
          SELECT
            b.pane_id,
            p.room_id,
            b.source,
            b.coder_chat_id,
            b.status,
            b.title,
            b.selected_model_config_id,
            b.selected_provider_name,
            b.selected_model_name,
            b.selected_reasoning_key,
            b.selected_tool_ids,
            b.last_synced_at,
            b.created_at,
            b.updated_at
          FROM pane_agent_bindings b
          JOIN panes p ON p.id = b.pane_id
          WHERE b.coder_chat_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM pane_agent_sessions s
              WHERE s.pane_id = b.pane_id
                AND s.coder_chat_id = b.coder_chat_id
            )
        )
        SELECT
          h.pane_id AS "paneId",
          h.room_id AS "roomId",
          h.source,
          h.coder_chat_id AS "coderChatId",
          h.status,
          h.title,
          h.selected_model_config_id AS "selectedModelConfigId",
          h.selected_provider_name AS "selectedProviderName",
          h.selected_model_name AS "selectedModelName",
          h.selected_reasoning_key AS "selectedReasoningKey",
          h.selected_tool_ids AS "selectedToolIds",
          h.last_synced_at AS "lastSyncedAt",
          h.created_at AS "createdAt",
          h.updated_at AS "updatedAt",
          p.title AS "paneTitle",
          p.is_closed AS "paneIsClosed"
        FROM session_history h
        LEFT JOIN panes p ON p.id = h.pane_id
        WHERE ($1::text IS NULL OR h.room_id = $1)
        ORDER BY h.updated_at DESC
        LIMIT 100
      `,
      [roomId ?? null]
    );
    return result.rows.map(mapAgentPaneHistory);
  }

  async upsertAgentPaneStoredSession(
    input: UpsertAgentPaneStoredSessionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<AgentPaneStoredSession> {
    const parsed = upsertAgentPaneStoredSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const pane = await this.getPaneForUpdate(client, parsed.paneId);
      if (pane.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
      }
      const timestamp = nowIso();
      const result = await client.query<AgentPaneStoredSessionRow>(
        `
          INSERT INTO pane_agent_sessions (
            pane_id,
            room_id,
            source,
            coder_chat_id,
            status,
            title,
            selected_model_config_id,
            selected_provider_name,
            selected_model_name,
            selected_reasoning_key,
            selected_tool_ids,
            last_synced_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
          ON CONFLICT (pane_id, coder_chat_id)
          DO UPDATE SET
            room_id = EXCLUDED.room_id,
            source = EXCLUDED.source,
            status = EXCLUDED.status,
            title = EXCLUDED.title,
            selected_model_config_id = EXCLUDED.selected_model_config_id,
            selected_provider_name = EXCLUDED.selected_provider_name,
            selected_model_name = EXCLUDED.selected_model_name,
            selected_reasoning_key = EXCLUDED.selected_reasoning_key,
            selected_tool_ids = EXCLUDED.selected_tool_ids,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = EXCLUDED.updated_at
          RETURNING
            pane_id AS "paneId",
            room_id AS "roomId",
            source,
            coder_chat_id AS "coderChatId",
            status,
            title,
            selected_model_config_id AS "selectedModelConfigId",
            selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName",
            selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds",
            last_synced_at AS "lastSyncedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          parsed.paneId,
          parsed.roomId,
          parsed.source,
          parsed.coderChatId,
          parsed.status,
          parsed.title,
          parsed.selectedModelConfigId,
          parsed.selectedProviderName,
          parsed.selectedModelName,
          parsed.selectedReasoningKey,
          parsed.selectedToolIds,
          parsed.lastSyncedAt ?? null,
          timestamp
        ]
      );
      return mapAgentPaneStoredSession(firstOrNotFound(result.rows, `Agent session ${parsed.coderChatId} was not stored.`));
    });
  }

  private async persistStoredSessionForBinding(client: PgClientLike, binding: AgentPaneBinding): Promise<void> {
    if (!binding.coderChatId) return;
    const pane = await this.getPaneForUpdate(client, binding.paneId);
    await client.query(
      `
        INSERT INTO pane_agent_sessions (
          pane_id,
          room_id,
          source,
          coder_chat_id,
          status,
          title,
          selected_model_config_id,
          selected_provider_name,
          selected_model_name,
          selected_reasoning_key,
          selected_tool_ids,
          last_synced_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        ON CONFLICT (pane_id, coder_chat_id)
        DO UPDATE SET
          room_id = EXCLUDED.room_id,
          source = EXCLUDED.source,
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          selected_model_config_id = EXCLUDED.selected_model_config_id,
          selected_provider_name = EXCLUDED.selected_provider_name,
          selected_model_name = EXCLUDED.selected_model_name,
          selected_reasoning_key = EXCLUDED.selected_reasoning_key,
          selected_tool_ids = EXCLUDED.selected_tool_ids,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        binding.paneId,
        pane.roomId,
        binding.source,
        binding.coderChatId,
        binding.status,
        binding.title,
        binding.selectedModelConfigId,
        binding.selectedProviderName,
        binding.selectedModelName,
        binding.selectedReasoningKey,
        binding.selectedToolIds,
        binding.lastSyncedAt,
        nowIso()
      ]
    );
  }

  async upsertAgentPaneBinding(
    input: UpsertAgentPaneBindingInput,
    _traceId = makeSpaceId("trace")
  ): Promise<AgentPaneBinding> {
    const parsed = upsertAgentPaneBindingInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      await this.getPaneForUpdate(client, parsed.paneId);
      const timestamp = nowIso();
      const result = await client.query<AgentPaneBindingRow>(
        `
          INSERT INTO pane_agent_bindings (
            pane_id,
            source,
            coder_chat_id,
            status,
            title,
            selected_model_config_id,
            selected_provider_name,
            selected_model_name,
            selected_reasoning_key,
            selected_tool_ids,
            last_synced_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
          ON CONFLICT (pane_id)
          DO UPDATE SET
            source = EXCLUDED.source,
            coder_chat_id = EXCLUDED.coder_chat_id,
            status = EXCLUDED.status,
            title = EXCLUDED.title,
            selected_model_config_id = EXCLUDED.selected_model_config_id,
            selected_provider_name = EXCLUDED.selected_provider_name,
            selected_model_name = EXCLUDED.selected_model_name,
            selected_reasoning_key = EXCLUDED.selected_reasoning_key,
            selected_tool_ids = EXCLUDED.selected_tool_ids,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = EXCLUDED.updated_at
          RETURNING
            pane_id AS "paneId",
            source,
            coder_chat_id AS "coderChatId",
            status,
            title,
            selected_model_config_id AS "selectedModelConfigId",
            selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName",
            selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds",
            last_synced_at AS "lastSyncedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          parsed.paneId,
          parsed.source,
          parsed.coderChatId,
          parsed.status,
          parsed.title,
          parsed.selectedModelConfigId,
          parsed.selectedProviderName,
          parsed.selectedModelName,
          parsed.selectedReasoningKey,
          parsed.selectedToolIds,
          parsed.lastSyncedAt,
          timestamp
        ]
      );
      const binding = mapAgentPaneBinding(firstOrNotFound(result.rows, `Agent binding for pane ${parsed.paneId} was not created.`));
      await this.persistStoredSessionForBinding(client, binding);
      return binding;
    });
  }

  async updateAgentPaneBinding(
    paneId: string,
    input: UpdateAgentPaneBindingInput,
    _traceId = makeSpaceId("trace")
  ): Promise<AgentPaneBinding> {
    const parsed = updateAgentPaneBindingInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      await this.getPaneForUpdate(client, paneId);
      const currentResult = await client.query<AgentPaneBindingRow>(`${agentPaneBindingSelect} WHERE pane_id = $1 FOR UPDATE`, [paneId]);
      const current = mapAgentPaneBinding(firstOrNotFound(currentResult.rows, `Agent binding for pane ${paneId} was not found.`));
      const updated = agentPaneBindingSchema.parse({
        ...current,
        ...parsed,
        coderChatId: parsed.coderChatId === undefined ? current.coderChatId : parsed.coderChatId,
        selectedModelConfigId:
          parsed.selectedModelConfigId === undefined ? current.selectedModelConfigId : parsed.selectedModelConfigId,
        selectedProviderName:
          parsed.selectedProviderName === undefined ? current.selectedProviderName : parsed.selectedProviderName,
        selectedModelName: parsed.selectedModelName === undefined ? current.selectedModelName : parsed.selectedModelName,
        selectedReasoningKey:
          parsed.selectedReasoningKey === undefined ? current.selectedReasoningKey : parsed.selectedReasoningKey,
        selectedToolIds: parsed.selectedToolIds === undefined ? current.selectedToolIds : parsed.selectedToolIds,
        lastSyncedAt: parsed.lastSyncedAt === undefined ? current.lastSyncedAt : parsed.lastSyncedAt
      });
      const timestamp = nowIso();
      const result = await client.query<AgentPaneBindingRow>(
        `
          UPDATE pane_agent_bindings
          SET coder_chat_id = $2,
              status = $3,
              title = $4,
              selected_model_config_id = $5,
              selected_provider_name = $6,
              selected_model_name = $7,
              selected_reasoning_key = $8,
              selected_tool_ids = $9,
              last_synced_at = $10,
              updated_at = $11
          WHERE pane_id = $1
          RETURNING
            pane_id AS "paneId",
            source,
            coder_chat_id AS "coderChatId",
            status,
            title,
            selected_model_config_id AS "selectedModelConfigId",
            selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName",
            selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds",
            last_synced_at AS "lastSyncedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          paneId,
          updated.coderChatId,
          updated.status,
          updated.title,
          updated.selectedModelConfigId,
          updated.selectedProviderName,
          updated.selectedModelName,
          updated.selectedReasoningKey,
          updated.selectedToolIds,
          updated.lastSyncedAt,
          timestamp
        ]
      );
      const binding = mapAgentPaneBinding(firstOrNotFound(result.rows, `Agent binding for pane ${paneId} was not updated.`));
      await this.persistStoredSessionForBinding(client, binding);
      return binding;
    });
  }

  async getActiveSpaceAgentSession(paneId: string): Promise<SpaceAgentSessionRecord | null> {
    const result = await this.pool.query<SpaceAgentSessionRow>(
      `${spaceAgentSessionSelect} WHERE pane_id = $1 AND is_active = true LIMIT 1`,
      [paneId]
    );
    return result.rows[0] ? mapSpaceAgentSession(result.rows[0]) : null;
  }

  async getSpaceAgentSession(sessionId: string): Promise<SpaceAgentSessionRecord | null> {
    const result = await this.pool.query<SpaceAgentSessionRow>(`${spaceAgentSessionSelect} WHERE session_id = $1`, [sessionId]);
    return result.rows[0] ? mapSpaceAgentSession(result.rows[0]) : null;
  }

  async listSpaceAgentHistory(roomId?: string): Promise<AgentPaneHistoryItem[]> {
    const result = await this.pool.query<SpaceAgentSessionRow & { paneTitle: string | null; paneIsClosed: boolean | null }>(
      `
        SELECT
          s.session_id AS "sessionId",
          s.pane_id AS "paneId",
          s.room_id AS "roomId",
          s.source,
          s.status,
          s.title,
          s.thread_id AS "threadId",
          s.selected_provider_id AS "selectedProviderId",
          s.selected_model_id AS "selectedModelId",
          s.selected_model_config_id AS "selectedModelConfigId",
          s.selected_provider_name AS "selectedProviderName",
          s.selected_model_name AS "selectedModelName",
          s.selected_reasoning_key AS "selectedReasoningKey",
          s.selected_tool_ids AS "selectedToolIds",
          s.is_active AS "isActive",
          s.last_synced_at AS "lastSyncedAt",
          s.created_at AS "createdAt",
          s.updated_at AS "updatedAt",
          p.title AS "paneTitle",
          p.is_closed AS "paneIsClosed"
        FROM space_agent_sessions s
        LEFT JOIN panes p ON p.id = s.pane_id
        WHERE ($1::text IS NULL OR s.room_id = $1)
        ORDER BY s.updated_at DESC
        LIMIT 100
      `,
      [roomId ?? null]
    );
    return result.rows.map((row) => ({
      paneId: row.paneId,
      roomId: row.roomId,
      source: "SPACE" as const,
      sessionId: row.sessionId,
      coderChatId: null,
      status: row.status,
      title: row.title,
      selectedModelConfigId: row.selectedModelConfigId,
      selectedProviderName: row.selectedProviderName,
      selectedModelName: row.selectedModelName,
      selectedReasoningKey: row.selectedReasoningKey,
      selectedToolIds: row.selectedToolIds,
      lastSyncedAt: toIso(row.lastSyncedAt),
      paneTitle: row.paneTitle,
      paneIsClosed: row.paneIsClosed ?? true,
      updatedAt: toIso(row.updatedAt)
    }));
  }

  async createSpaceAgentSession(
    input: CreateSpaceAgentSessionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<SpaceAgentSessionRecord> {
    const parsed = createSpaceAgentSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const pane = await this.getPaneForUpdate(client, parsed.paneId);
      if (pane.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
      }
      const timestamp = nowIso();
      const sessionId = parsed.sessionId ?? makeSpaceId("agent_session");
      const isActive = parsed.isActive ?? true;
      if (isActive) {
        await client.query(`UPDATE space_agent_sessions SET is_active = false, updated_at = $2 WHERE pane_id = $1`, [
          parsed.paneId,
          timestamp
        ]);
      }
      const result = await client.query<SpaceAgentSessionRow>(
        `
          INSERT INTO space_agent_sessions (
            session_id,
            pane_id,
            room_id,
            source,
            status,
            title,
            thread_id,
            selected_provider_id,
            selected_model_id,
            selected_model_config_id,
            selected_provider_name,
            selected_model_name,
            selected_reasoning_key,
            selected_tool_ids,
            permission_mode,
            collaboration_mode,
            is_active,
            last_synced_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'SPACE', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
          ON CONFLICT (session_id)
          DO UPDATE SET
            pane_id = EXCLUDED.pane_id,
            room_id = EXCLUDED.room_id,
            status = EXCLUDED.status,
            title = EXCLUDED.title,
            thread_id = EXCLUDED.thread_id,
            selected_provider_id = EXCLUDED.selected_provider_id,
            selected_model_id = EXCLUDED.selected_model_id,
            selected_model_config_id = EXCLUDED.selected_model_config_id,
            selected_provider_name = EXCLUDED.selected_provider_name,
            selected_model_name = EXCLUDED.selected_model_name,
            selected_reasoning_key = EXCLUDED.selected_reasoning_key,
            selected_tool_ids = EXCLUDED.selected_tool_ids,
            permission_mode = EXCLUDED.permission_mode,
            collaboration_mode = EXCLUDED.collaboration_mode,
            is_active = EXCLUDED.is_active,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = EXCLUDED.updated_at
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            source,
            status,
            title,
            thread_id AS "threadId",
            selected_provider_id AS "selectedProviderId",
            selected_model_id AS "selectedModelId",
            selected_model_config_id AS "selectedModelConfigId",
            selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName",
            selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds",
            permission_mode AS "permissionMode",
            collaboration_mode AS "collaborationMode",
            is_active AS "isActive",
            last_synced_at AS "lastSyncedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.status ?? "READY",
          parsed.title,
          parsed.threadId ?? null,
          parsed.selectedProviderId ?? null,
          parsed.selectedModelId ?? null,
          parsed.selectedModelConfigId ?? parsed.selectedModelId ?? null,
          parsed.selectedProviderName ?? null,
          parsed.selectedModelName ?? null,
          parsed.selectedReasoningKey ?? null,
          parsed.selectedToolIds ?? null,
          parsed.permissionMode ?? null,
          parsed.collaborationMode ?? null,
          isActive,
          parsed.lastSyncedAt ?? null,
          timestamp
        ]
      );
      return mapSpaceAgentSession(firstOrNotFound(result.rows, `Space agent session ${sessionId} was not stored.`));
    });
  }

  async updateSpaceAgentSession(
    sessionId: string,
    input: UpdateSpaceAgentSessionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<SpaceAgentSessionRecord> {
    const parsed = updateSpaceAgentSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<SpaceAgentSessionRow>(
        `${spaceAgentSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [sessionId]
      );
      const current = mapSpaceAgentSession(firstOrNotFound(currentResult.rows, `Space agent session ${sessionId} was not found.`));
      const paneId = parsed.paneId ?? current.paneId;
      const roomId = parsed.roomId ?? current.roomId;
      const pane = await this.getPaneForUpdate(client, paneId);
      if (pane.roomId !== roomId) {
        throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
      }
      const isActive = parsed.isActive === undefined ? current.isActive : parsed.isActive;
      const timestamp = nowIso();
      if (isActive) {
        await client.query(
          `UPDATE space_agent_sessions SET is_active = false, updated_at = $3 WHERE pane_id = $1 AND session_id <> $2`,
          [paneId, sessionId, timestamp]
        );
      }
      const result = await client.query<SpaceAgentSessionRow>(
        `
          UPDATE space_agent_sessions
          SET pane_id = $2,
              room_id = $3,
              status = $4,
              title = $5,
              thread_id = $6,
              selected_provider_id = $7,
              selected_model_id = $8,
              selected_model_config_id = $9,
              selected_provider_name = $10,
              selected_model_name = $11,
              selected_reasoning_key = $12,
              selected_tool_ids = $13,
              permission_mode = $14,
              collaboration_mode = $15,
              is_active = $16,
              last_synced_at = $17,
              updated_at = $18
          WHERE session_id = $1
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            source,
            status,
            title,
            thread_id AS "threadId",
            selected_provider_id AS "selectedProviderId",
            selected_model_id AS "selectedModelId",
            selected_model_config_id AS "selectedModelConfigId",
            selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName",
            selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds",
            permission_mode AS "permissionMode",
            collaboration_mode AS "collaborationMode",
            is_active AS "isActive",
            last_synced_at AS "lastSyncedAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          sessionId,
          paneId,
          roomId,
          parsed.status ?? current.status,
          parsed.title ?? current.title,
          parsed.threadId === undefined ? current.threadId : parsed.threadId,
          parsed.selectedProviderId === undefined ? current.selectedProviderId : parsed.selectedProviderId,
          parsed.selectedModelId === undefined ? current.selectedModelId : parsed.selectedModelId,
          parsed.selectedModelConfigId === undefined ? current.selectedModelConfigId : parsed.selectedModelConfigId,
          parsed.selectedProviderName === undefined ? current.selectedProviderName : parsed.selectedProviderName,
          parsed.selectedModelName === undefined ? current.selectedModelName : parsed.selectedModelName,
          parsed.selectedReasoningKey === undefined ? current.selectedReasoningKey : parsed.selectedReasoningKey,
          parsed.selectedToolIds === undefined ? current.selectedToolIds : parsed.selectedToolIds,
          parsed.permissionMode === undefined ? current.permissionMode : parsed.permissionMode,
          parsed.collaborationMode === undefined ? current.collaborationMode : parsed.collaborationMode,
          isActive,
          parsed.lastSyncedAt === undefined ? current.lastSyncedAt : parsed.lastSyncedAt,
          timestamp
        ]
      );
      return mapSpaceAgentSession(firstOrNotFound(result.rows, `Space agent session ${sessionId} was not updated.`));
    });
  }

  async listSpaceAgentMessages(sessionId: string, limit?: number): Promise<SpaceAgentMessageRecord[]> {
    const boundedLimit = limit === undefined ? null : Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<SpaceAgentMessageRow>(
      `
        SELECT * FROM (
          ${spaceAgentMessageSelect}
          WHERE session_id = $1
          ORDER BY created_at DESC
          LIMIT COALESCE($2, 2147483647)
        ) recent_messages
        ORDER BY "createdAt" ASC
      `,
      [sessionId, boundedLimit]
    );
    return result.rows.map(mapSpaceAgentMessage);
  }

  async countSpaceAgentMessages(sessionId: string): Promise<number> {
    const result = await this.pool.query<CountRow>(
      `SELECT count(*) AS count FROM space_agent_messages WHERE session_id = $1`,
      [sessionId]
    );
    return countValue(result.rows);
  }

  async createSpaceAgentMessage(
    input: CreateSpaceAgentMessageInput,
    _traceId = makeSpaceId("trace")
  ): Promise<SpaceAgentMessageRecord> {
    const parsed = createSpaceAgentMessageInputSchema.parse(input);
    const timestamp = nowIso();
    const messageId = parsed.messageId ?? makeSpaceId("agent_msg");
    const result = await this.pool.query<SpaceAgentMessageRow>(
      `
        INSERT INTO space_agent_messages (
          message_id,
          session_id,
          run_id,
          role,
          content,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        RETURNING
          message_id AS "messageId",
          session_id AS "sessionId",
          run_id AS "runId",
          role,
          content,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [messageId, parsed.sessionId, parsed.runId ?? null, parsed.role, parsed.content, parsed.status ?? "COMPLETED", timestamp]
    );
    return mapSpaceAgentMessage(firstOrNotFound(result.rows, `Space agent message ${messageId} was not stored.`));
  }

  async updateSpaceAgentMessage(
    messageId: string,
    input: UpdateSpaceAgentMessageInput,
    _traceId = makeSpaceId("trace")
  ): Promise<SpaceAgentMessageRecord> {
    const parsed = updateSpaceAgentMessageInputSchema.parse(input);
    const currentResult = await this.pool.query<SpaceAgentMessageRow>(`${spaceAgentMessageSelect} WHERE message_id = $1`, [messageId]);
    const current = mapSpaceAgentMessage(firstOrNotFound(currentResult.rows, `Space agent message ${messageId} was not found.`));
    const result = await this.pool.query<SpaceAgentMessageRow>(
      `
        UPDATE space_agent_messages
        SET run_id = $2,
            content = $3,
            status = $4,
            updated_at = $5
        WHERE message_id = $1
        RETURNING
          message_id AS "messageId",
          session_id AS "sessionId",
          run_id AS "runId",
          role,
          content,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        messageId,
        parsed.runId === undefined ? current.runId : parsed.runId,
        parsed.content ?? current.content,
        parsed.status ?? current.status,
        nowIso()
      ]
    );
    return mapSpaceAgentMessage(firstOrNotFound(result.rows, `Space agent message ${messageId} was not updated.`));
  }

  async createSpaceAgentRun(input: CreateSpaceAgentRunInput, _traceId = makeSpaceId("trace")): Promise<SpaceAgentRunRecord> {
    const parsed = createSpaceAgentRunInputSchema.parse(input);
    const timestamp = nowIso();
    const runId = parsed.runId ?? makeSpaceId("agent_run");
    const result = await this.pool.query<SpaceAgentRunRow>(
      `
        INSERT INTO space_agent_runs (
          run_id,
          session_id,
          pane_id,
          room_id,
          workflow_id,
          temporal_run_id,
          codex_thread_id,
          codex_turn_id,
          status,
          prompt_message_id,
          response_message_id,
          error_code,
          error_message,
          created_at,
          updated_at,
          completed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15)
        RETURNING
          run_id AS "runId",
          session_id AS "sessionId",
          pane_id AS "paneId",
          room_id AS "roomId",
          workflow_id AS "workflowId",
          temporal_run_id AS "temporalRunId",
          codex_thread_id AS "codexThreadId",
          codex_turn_id AS "codexTurnId",
          status,
          prompt_message_id AS "promptMessageId",
          response_message_id AS "responseMessageId",
          error_code AS "errorCode",
          error_message AS "errorMessage",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
      [
        runId,
        parsed.sessionId,
        parsed.paneId,
        parsed.roomId,
        parsed.workflowId,
        parsed.temporalRunId ?? null,
        parsed.codexThreadId ?? null,
        parsed.codexTurnId ?? null,
        parsed.status,
        parsed.promptMessageId,
        parsed.responseMessageId,
        parsed.errorCode ?? null,
        parsed.errorMessage ?? null,
        timestamp,
        parsed.completedAt ?? null
      ]
    );
    await this.updateSpaceAgentMessage(parsed.promptMessageId, { runId });
    await this.updateSpaceAgentMessage(parsed.responseMessageId, { runId });
    return mapSpaceAgentRun(firstOrNotFound(result.rows, `Space agent run ${runId} was not stored.`));
  }

  async updateSpaceAgentRun(runId: string, input: UpdateSpaceAgentRunInput, _traceId = makeSpaceId("trace")): Promise<SpaceAgentRunRecord> {
    const parsed = updateSpaceAgentRunInputSchema.parse(input);
    const currentResult = await this.pool.query<SpaceAgentRunRow>(`${spaceAgentRunSelect} WHERE run_id = $1`, [runId]);
    const current = mapSpaceAgentRun(firstOrNotFound(currentResult.rows, `Space agent run ${runId} was not found.`));
    const terminal = parsed.status === "COMPLETED" || parsed.status === "FAILED" || parsed.status === "INTERRUPTED";
    const result = await this.pool.query<SpaceAgentRunRow>(
      `
        UPDATE space_agent_runs
        SET temporal_run_id = $2,
            codex_thread_id = $3,
            codex_turn_id = $4,
            status = $5,
            error_code = $6,
            error_message = $7,
            updated_at = $8,
            completed_at = $9
        WHERE run_id = $1
        RETURNING
          run_id AS "runId",
          session_id AS "sessionId",
          pane_id AS "paneId",
          room_id AS "roomId",
          workflow_id AS "workflowId",
          temporal_run_id AS "temporalRunId",
          codex_thread_id AS "codexThreadId",
          codex_turn_id AS "codexTurnId",
          status,
          prompt_message_id AS "promptMessageId",
          response_message_id AS "responseMessageId",
          error_code AS "errorCode",
          error_message AS "errorMessage",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
      `,
      [
        runId,
        parsed.temporalRunId === undefined ? current.temporalRunId : parsed.temporalRunId,
        parsed.codexThreadId === undefined ? current.codexThreadId : parsed.codexThreadId,
        parsed.codexTurnId === undefined ? current.codexTurnId : parsed.codexTurnId,
        parsed.status ?? current.status,
        parsed.errorCode === undefined ? current.errorCode : parsed.errorCode,
        parsed.errorMessage === undefined ? current.errorMessage : parsed.errorMessage,
        nowIso(),
        parsed.completedAt === undefined ? (terminal ? nowIso() : current.completedAt) : parsed.completedAt
      ]
    );
    return mapSpaceAgentRun(firstOrNotFound(result.rows, `Space agent run ${runId} was not updated.`));
  }

  async updateSpaceAgentRunByWorkflowId(
    workflowId: string,
    input: UpdateSpaceAgentRunInput,
    traceId = makeSpaceId("trace")
  ): Promise<SpaceAgentRunRecord> {
    const result = await this.pool.query<SpaceAgentRunRow>(`${spaceAgentRunSelect} WHERE workflow_id = $1`, [workflowId]);
    const run = mapSpaceAgentRun(firstOrNotFound(result.rows, `Space agent run for workflow ${workflowId} was not found.`));
    return this.updateSpaceAgentRun(run.runId, input, traceId);
  }

  async completeSpaceAgentRun(input: CompleteSpaceAgentRunInput): Promise<CompletedSpaceAgentRunRecord> {
    return this.withTransaction(async (client) => {
      const runResult = await client.query<SpaceAgentRunRow>(`${spaceAgentRunSelect} WHERE run_id = $1 FOR UPDATE`, [input.runId]);
      const currentRun = mapSpaceAgentRun(firstOrNotFound(runResult.rows, `Space agent run ${input.runId} was not found.`));
      const sessionResult = await client.query<SpaceAgentSessionRow>(
        `${spaceAgentSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [input.sessionId]
      );
      const currentSession = mapSpaceAgentSession(
        firstOrNotFound(sessionResult.rows, `Space agent session ${input.sessionId} was not found.`)
      );
      const messageResult = await client.query<SpaceAgentMessageRow>(
        `${spaceAgentMessageSelect} WHERE message_id = $1 FOR UPDATE`,
        [input.responseMessageId]
      );
      const currentMessage = mapSpaceAgentMessage(
        firstOrNotFound(messageResult.rows, `Space agent response message ${input.responseMessageId} was not found.`)
      );
      const promptMessageResult = input.sourceType === "ROOM_AGENT"
        ? await client.query<SpaceAgentMessageRow>(
            `${spaceAgentMessageSelect} WHERE message_id = $1 FOR UPDATE`,
            [currentRun.promptMessageId]
          )
        : null;
      const promptMessage = promptMessageResult
        ? mapSpaceAgentMessage(
            firstOrNotFound(promptMessageResult.rows, `Space agent prompt message ${currentRun.promptMessageId} was not found.`)
          )
        : null;
      if (
        currentRun.sessionId !== input.sessionId ||
        currentRun.responseMessageId !== input.responseMessageId ||
        currentSession.sessionId !== currentRun.sessionId ||
        currentMessage.sessionId !== currentRun.sessionId ||
        (promptMessage && (promptMessage.sessionId !== currentRun.sessionId || promptMessage.role !== "user"))
      ) {
        throw new SpaceConflictError("Space agent completion records do not belong to the same run.");
      }
      const roomAgentTaskTitle = normalizeTelegramTaskTitle(promptMessage?.content ?? "", "Room Agent task");

      const updatedMessage = await client.query<SpaceAgentMessageRow>(
        `
          UPDATE space_agent_messages
          SET content = $2, status = 'COMPLETED', updated_at = $3
          WHERE message_id = $1
          RETURNING
            message_id AS "messageId", session_id AS "sessionId", run_id AS "runId",
            role, content, status, created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [input.responseMessageId, input.responseContent, input.completedAt]
      );
      const updatedRun = await client.query<SpaceAgentRunRow>(
        `
          UPDATE space_agent_runs
          SET status = 'COMPLETED', codex_thread_id = $2, codex_turn_id = $3,
              error_code = NULL, error_message = NULL, completed_at = $4, updated_at = $4
          WHERE run_id = $1
          RETURNING
            run_id AS "runId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            workflow_id AS "workflowId", temporal_run_id AS "temporalRunId",
            codex_thread_id AS "codexThreadId", codex_turn_id AS "codexTurnId", status,
            prompt_message_id AS "promptMessageId", response_message_id AS "responseMessageId",
            error_code AS "errorCode", error_message AS "errorMessage",
            created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
        `,
        [input.runId, input.codexThreadId, input.codexTurnId, input.completedAt]
      );
      const updatedSession = await client.query<SpaceAgentSessionRow>(
        `
          UPDATE space_agent_sessions
          SET status = 'READY', thread_id = $2, last_synced_at = $3, updated_at = $3
          WHERE session_id = $1
          RETURNING
            session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId", source, status, title,
            thread_id AS "threadId", selected_provider_id AS "selectedProviderId", selected_model_id AS "selectedModelId",
            selected_model_config_id AS "selectedModelConfigId", selected_provider_name AS "selectedProviderName",
            selected_model_name AS "selectedModelName", selected_reasoning_key AS "selectedReasoningKey",
            selected_tool_ids AS "selectedToolIds", permission_mode AS "permissionMode",
            collaboration_mode AS "collaborationMode", is_active AS "isActive",
            last_synced_at AS "lastSyncedAt", created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [input.sessionId, input.codexThreadId, input.completedAt]
      );
      const event = await this.appendEvent(client, {
        roomId: currentRun.roomId,
        paneId: currentRun.paneId,
        turnId: null,
        workflowId: null,
        traceId: input.traceId,
        type: "TURN_COMPLETED",
        message: "Codex turn completed.",
        payload: {
          status: "COMPLETED",
          runId: currentRun.runId,
          sourceType: input.sourceType,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId
        }
      });
      await client.query(
        `
          INSERT INTO telegram_notification_outbox (
            delivery_id, integration_generation, source_key, source_type,
            room_id, pane_id, turn_id, room_name, pane_title, agent_label, task_title, final_response,
            completed_at, status, available_at, created_at, updated_at
          )
          SELECT
            $1, i.generation, $2, $3,
            r.id, p.id, NULL, r.name, p.title,
            CASE
              WHEN $3 = 'ROOM_AGENT' THEN 'Room Agent'
              ELSE 'Agent ' || (
                SELECT count(*)::text
                FROM panes AS numbered_pane
                WHERE numbered_pane.room_id = p.room_id
                  AND (numbered_pane.is_closed = false OR numbered_pane.id = p.id)
                  AND (
                    numbered_pane.pane_order < p.pane_order
                    OR (numbered_pane.pane_order = p.pane_order AND numbered_pane.id <= p.id)
                  )
              )
            END,
            CASE WHEN $3 = 'ROOM_AGENT' THEN $4 ELSE p.title END,
            $5, $6, 'PENDING', $6, $6, $6
          FROM telegram_integrations i
          JOIN rooms r ON r.id = $7
          JOIN panes p ON p.id = $8
          WHERE i.id = 'global'
            AND i.connection_status = 'CONNECTED'
            AND i.is_enabled = true
            AND i.enabled_at IS NOT NULL
            AND $6 >= i.enabled_at
            AND char_length($5) > 0
          ON CONFLICT (source_key) DO NOTHING
        `,
        [
          makeSpaceId("telegram_delivery"),
          `space_agent_run:${currentRun.runId}`,
          input.sourceType,
          roomAgentTaskTitle,
          input.finalResponse,
          input.completedAt,
          currentRun.roomId,
          currentRun.paneId
        ]
      );
      return {
        run: mapSpaceAgentRun(firstOrNotFound(updatedRun.rows, `Space agent run ${input.runId} was not completed.`)),
        session: mapSpaceAgentSession(
          firstOrNotFound(updatedSession.rows, `Space agent session ${input.sessionId} was not completed.`)
        ),
        responseMessage: mapSpaceAgentMessage(
          firstOrNotFound(updatedMessage.rows, `Space agent response message ${input.responseMessageId} was not completed.`)
        ),
        event
      };
    });
  }

  async getLatestSpaceAgentRun(sessionId: string): Promise<SpaceAgentRunRecord | null> {
    const result = await this.pool.query<SpaceAgentRunRow>(
      `${spaceAgentRunSelect} WHERE session_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [sessionId]
    );
    return result.rows[0] ? mapSpaceAgentRun(result.rows[0]) : null;
  }

  async getActivePaneCliSession(paneId: string): Promise<PaneCliSession | null> {
    const result = await this.pool.query<PaneCliSessionRow>(
      `${paneCliSessionSelect} WHERE pane_id = $1 AND is_active = true LIMIT 1`,
      [paneId]
    );
    return result.rows[0] ? mapPaneCliSession(result.rows[0]) : null;
  }

  async getActivePaneCliSessionByCodexThreadId(codexThreadId: string): Promise<PaneCliSession | null> {
    const result = await this.pool.query<PaneCliSessionRow>(
      `${paneCliSessionSelect} WHERE codex_thread_id = $1 AND is_active = true ORDER BY started_at ASC, updated_at ASC, session_id ASC LIMIT 1`,
      [codexThreadId]
    );
    return result.rows[0] ? mapPaneCliSession(result.rows[0]) : null;
  }

  async getLatestPaneCliSessionByCodexThreadId(codexThreadId: string): Promise<PaneCliSession | null> {
    const result = await this.pool.query<PaneCliSessionRow>(
      `${paneCliSessionSelect} WHERE codex_thread_id = $1 ORDER BY updated_at DESC, started_at DESC, session_id DESC LIMIT 1`,
      [codexThreadId]
    );
    return result.rows[0] ? mapPaneCliSession(result.rows[0]) : null;
  }

  async listPaneCliSessions(paneId: string, limit = 20): Promise<PaneCliSession[]> {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const result = await this.pool.query<PaneCliSessionRow>(
      `${paneCliSessionSelect} WHERE pane_id = $1 ORDER BY started_at DESC, updated_at DESC, is_active DESC, session_id DESC LIMIT $2`,
      [paneId, boundedLimit]
    );
    return result.rows.map(mapPaneCliSession);
  }

  async listActivePaneCliSessions(runtimeId: string): Promise<PaneCliSession[]> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const result = await this.pool.query<PaneCliSessionRow>(
      `${paneCliSessionSelect}
       WHERE runtime_id = $1 AND is_active = true AND status = 'RUNNING'
       ORDER BY started_at ASC`,
      [parsedRuntimeId]
    );
    return result.rows.map(mapPaneCliSession);
  }

  async getCliTask(taskId: string): Promise<CliTaskRecord | null> {
    const result = await this.pool.query<CliTaskRow>(`${cliTaskSelect} WHERE task_id = $1`, [taskId]);
    return result.rows[0] ? mapCliTask(result.rows[0]) : null;
  }

  async getCliTaskRevision(revisionId: string): Promise<CliTaskRevisionRecord | null> {
    const result = await this.pool.query<CliTaskRevisionRow>(
      `${cliTaskRevisionSelect} WHERE revision_id = $1`,
      [revisionId]
    );
    return result.rows[0] ? mapCliTaskRevision(result.rows[0]) : null;
  }

  async getCliTaskRevisionByNativeRef(
    runtimeId: string,
    nativeTaskRef: string
  ): Promise<CliTaskRevisionRecord | null> {
    const result = await this.pool.query<CliTaskRevisionRow>(
      `${cliTaskRevisionSelect} WHERE runtime_id = $1 AND native_task_ref = $2`,
      [runtimeId, nativeTaskRef]
    );
    return result.rows[0] ? mapCliTaskRevision(result.rows[0]) : null;
  }

  async createCliTaskRevision(
    input: CreateCliTaskRevisionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<CliTaskRevisionRecord> {
    const revisionId = idSchema.parse(input.revisionId);
    const taskId = idSchema.parse(input.taskId);
    if (input.nativeTaskRef && !/^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(input.nativeTaskRef)) {
      throw new SpaceConflictError("CLI native task reference is invalid.");
    }
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      await client.query(
        `INSERT INTO cli_tasks (task_id, current_revision_id, created_at, updated_at)
         VALUES ($1, NULL, $2, $2)
         ON CONFLICT (task_id) DO NOTHING`,
        [taskId, timestamp]
      );
      if (input.sourceRevisionId) {
        const source = await client.query<{ taskId: string }>(
          `SELECT task_id AS "taskId" FROM cli_task_revisions WHERE revision_id = $1 FOR UPDATE`,
          [input.sourceRevisionId]
        );
        if (source.rows[0]?.taskId !== taskId) {
          throw new SpaceConflictError("CLI task revision source must belong to the same logical task.");
        }
      }
      if (input.nativeTaskRef) {
        const owner = await client.query<{ revisionId: string; taskId: string }>(
          `SELECT revision_id AS "revisionId", task_id AS "taskId"
           FROM cli_task_revisions
           WHERE runtime_id = $1 AND native_task_ref = $2
           FOR UPDATE`,
          [input.runtimeId, input.nativeTaskRef]
        );
        if (owner.rows[0] && owner.rows[0].taskId !== taskId) {
          throw new SpaceConflictError(`CLI native task reference is already registered for ${input.runtimeId}.`);
        }
        if (owner.rows[0]) {
          await client.query(
            `UPDATE cli_task_revisions SET native_task_ref = NULL, updated_at = $2 WHERE revision_id = $1`,
            [owner.rows[0].revisionId, timestamp]
          );
        }
      }
      const result = await client.query<CliTaskRevisionRow>(
        `INSERT INTO cli_task_revisions (
           revision_id, task_id, runtime_id, provider_id, agent_id, native_task_ref,
           source_revision_id, latest_space_session_id, display_title, first_user_message,
           preview, cwd, model_id, reasoning_effort, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15
         )
         RETURNING
           revision_id AS "revisionId", task_id AS "taskId", runtime_id AS "runtimeId",
           provider_id AS "providerId", agent_id AS "agentId", native_task_ref AS "nativeTaskRef",
           source_revision_id AS "sourceRevisionId", latest_space_session_id AS "latestSpaceSessionId",
           display_title AS "displayTitle", first_user_message AS "firstUserMessage", preview, cwd,
           model_id AS "modelId", reasoning_effort AS "reasoningEffort",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          revisionId,
          taskId,
          input.runtimeId,
          input.providerId,
          input.agentId,
          input.nativeTaskRef ?? null,
          input.sourceRevisionId ?? null,
          input.latestSpaceSessionId ?? null,
          input.displayTitle,
          input.firstUserMessage,
          input.preview,
          input.cwd ?? null,
          input.modelId ?? null,
          input.reasoningEffort,
          timestamp
        ]
      );
      await client.query(
        `UPDATE cli_tasks SET current_revision_id = $2, updated_at = $3 WHERE task_id = $1`,
        [taskId, revisionId, timestamp]
      );
      return mapCliTaskRevision(firstOrNotFound(result.rows, `CLI task revision ${revisionId} was not stored.`));
    });
  }

  async updateCliTaskRevision(
    revisionId: string,
    input: UpdateCliTaskRevisionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<CliTaskRevisionRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<CliTaskRevisionRow>(
        `${cliTaskRevisionSelect} WHERE revision_id = $1 FOR UPDATE`,
        [revisionId]
      );
      const current = mapCliTaskRevision(
        firstOrNotFound(currentResult.rows, `CLI task revision ${revisionId} was not found.`)
      );
      const timestamp = nowIso();
      if (input.nativeTaskRef) {
        if (!/^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(input.nativeTaskRef)) {
          throw new SpaceConflictError("CLI native task reference is invalid.");
        }
        const owner = await client.query<{ revisionId: string; taskId: string }>(
          `SELECT revision_id AS "revisionId", task_id AS "taskId"
           FROM cli_task_revisions
           WHERE runtime_id = $1 AND native_task_ref = $2 AND revision_id <> $3
           FOR UPDATE`,
          [current.runtimeId, input.nativeTaskRef, revisionId]
        );
        if (owner.rows[0] && owner.rows[0].taskId !== current.taskId) {
          throw new SpaceConflictError(`CLI native task reference is already registered for ${current.runtimeId}.`);
        }
        if (owner.rows[0]) {
          await client.query(
            `UPDATE cli_task_revisions SET native_task_ref = NULL, updated_at = $2 WHERE revision_id = $1`,
            [owner.rows[0].revisionId, timestamp]
          );
        }
      }
      const result = await client.query<CliTaskRevisionRow>(
        `UPDATE cli_task_revisions SET
           native_task_ref = CASE WHEN $2 THEN $3 ELSE native_task_ref END,
           latest_space_session_id = CASE WHEN $4 THEN $5 ELSE latest_space_session_id END,
           display_title = CASE WHEN $6 THEN $7 ELSE display_title END,
           first_user_message = CASE WHEN $8 THEN $9 ELSE first_user_message END,
           preview = CASE WHEN $10 THEN $11 ELSE preview END,
           cwd = CASE WHEN $12 THEN $13 ELSE cwd END,
           model_id = CASE WHEN $14 THEN $15 ELSE model_id END,
           reasoning_effort = CASE WHEN $16 THEN $17 ELSE reasoning_effort END,
           updated_at = $18
         WHERE revision_id = $1
         RETURNING
           revision_id AS "revisionId", task_id AS "taskId", runtime_id AS "runtimeId",
           provider_id AS "providerId", agent_id AS "agentId", native_task_ref AS "nativeTaskRef",
           source_revision_id AS "sourceRevisionId", latest_space_session_id AS "latestSpaceSessionId",
           display_title AS "displayTitle", first_user_message AS "firstUserMessage", preview, cwd,
           model_id AS "modelId", reasoning_effort AS "reasoningEffort",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          revisionId,
          input.nativeTaskRef !== undefined,
          input.nativeTaskRef ?? null,
          input.latestSpaceSessionId !== undefined,
          input.latestSpaceSessionId ?? null,
          input.displayTitle !== undefined,
          input.displayTitle ?? null,
          input.firstUserMessage !== undefined,
          input.firstUserMessage ?? null,
          input.preview !== undefined,
          input.preview ?? null,
          input.cwd !== undefined,
          input.cwd ?? null,
          input.modelId !== undefined,
          input.modelId ?? null,
          input.reasoningEffort !== undefined,
          input.reasoningEffort ?? null,
          timestamp
        ]
      );
      await client.query(`UPDATE cli_tasks SET updated_at = $2 WHERE task_id = $1`, [current.taskId, timestamp]);
      return mapCliTaskRevision(firstOrNotFound(result.rows, `CLI task revision ${revisionId} was not updated.`));
    });
  }

  async listPaneCliTaskHistory(input: {
    page: number;
    pageSize: number;
    query?: string;
    runtimeIds?: string[];
  }): Promise<{ items: PaneCliTaskHistoryRecord[]; total: number }> {
    const page = Math.max(1, Math.trunc(input.page));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize)));
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const offset = (page - 1) * pageSize;
    const result = await this.pool.query<PaneCliTaskHistoryRow>(
      `
        WITH tasks AS (
          SELECT
            task.task_id AS "taskId",
            revision.revision_id AS "revisionId",
            revision.runtime_id AS "revisionRuntimeId",
            revision.provider_id AS "revisionProviderId",
            revision.agent_id AS "revisionAgentId",
            revision.native_task_ref AS "nativeTaskRef",
            revision.source_revision_id AS "sourceRevisionId",
            revision.latest_space_session_id AS "latestSpaceSessionId",
            revision.display_title AS "displayTitle",
            revision.first_user_message AS "revisionFirstUserMessage",
            revision.preview AS "revisionPreview",
            revision.cwd AS "revisionCwd",
            revision.model_id AS "revisionModelId",
            revision.reasoning_effort AS "revisionReasoningEffort",
            revision.created_at AS "revisionCreatedAt",
            revision.updated_at AS "revisionUpdatedAt",
            s.session_id AS "sessionId",
            s.pane_id AS "paneId",
            s.room_id AS "roomId",
            s.runtime_id AS "runtimeId",
            s.provider_id AS "providerId",
            s.agent_id AS "agentId",
            s.model_id AS "modelId",
            s.reasoning_effort AS "reasoningEffort",
            s.launch_mode AS "launchMode",
            s.cwd,
            s.codex_thread_id AS "codexThreadId",
            s.cli_task_id AS "cliTaskId",
            s.cli_task_revision_id AS "cliTaskRevisionId",
            s.status,
            s.status_reason AS "statusReason",
            s.exit_code AS "exitCode",
            s.is_active AS "isActive",
            s.started_at AS "startedAt",
            s.updated_at AS "updatedAt",
            s.ended_at AS "endedAt",
            coalesce(nullif(trim(revision.display_title), ''), p.title) AS "paneTitle",
            coalesce(nullif(trim(revision.first_user_message), ''), first_input.content, '') AS "firstUserMessage",
            coalesce(nullif(trim(revision.preview), ''), latest_output.content, first_input.content, '') AS preview,
            greatest(revision.updated_at, coalesce(latest_chunk.created_at, s.updated_at)) AS "recencyAt"
          FROM cli_tasks task
          JOIN cli_task_revisions revision ON revision.revision_id = task.current_revision_id
          JOIN pane_cli_sessions s ON s.session_id = revision.latest_space_session_id
          JOIN panes p ON p.id = s.pane_id
          LEFT JOIN LATERAL (
            SELECT content
            FROM pane_cli_transcript_chunks
            WHERE session_id = s.session_id AND stream = 'stdin' AND length(trim(content)) > 0
            ORDER BY sequence ASC, created_at ASC
            LIMIT 1
          ) first_input ON true
          LEFT JOIN LATERAL (
            SELECT content
            FROM pane_cli_transcript_chunks
            WHERE session_id = s.session_id AND stream IN ('stdout', 'stderr') AND length(trim(content)) > 0
            ORDER BY sequence DESC, created_at DESC
            LIMIT 1
          ) latest_output ON true
          LEFT JOIN LATERAL (
            SELECT created_at
            FROM pane_cli_transcript_chunks
            WHERE session_id = s.session_id
            ORDER BY sequence DESC, created_at DESC
            LIMIT 1
          ) latest_chunk ON true
          WHERE s.purpose = 'NORMAL'
            AND task.history_hidden_at IS NULL
            AND (
              length(trim(coalesce(revision.first_user_message, first_input.content, ''))) > 0
              OR revision.native_task_ref IS NOT NULL
            )
            AND ($1 = '' OR position($1 in lower(
              coalesce(nullif(trim(revision.display_title), ''), p.title) || E'\n' ||
              coalesce(nullif(trim(revision.first_user_message), ''), first_input.content, '') || E'\n' ||
              coalesce(nullif(trim(revision.preview), ''), latest_output.content, '')
            )) > 0)
            AND ($2::text[] IS NULL OR revision.runtime_id = ANY($2::text[]))
        )
        SELECT tasks.*, count(*) OVER() AS total
        FROM tasks
        ORDER BY "recencyAt" DESC, "sessionId" DESC
        LIMIT $3 OFFSET $4
      `,
      [query, input.runtimeIds ?? null, pageSize, offset]
    );
    const items = result.rows.map((row) => ({
      taskId: row.taskId,
      revision: mapCliTaskRevision({
        revisionId: row.revisionId,
        taskId: row.taskId,
        runtimeId: row.revisionRuntimeId,
        providerId: row.revisionProviderId,
        agentId: row.revisionAgentId,
        nativeTaskRef: row.nativeTaskRef,
        sourceRevisionId: row.sourceRevisionId,
        latestSpaceSessionId: row.latestSpaceSessionId,
        displayTitle: row.displayTitle,
        firstUserMessage: row.revisionFirstUserMessage,
        preview: row.revisionPreview,
        cwd: row.revisionCwd,
        modelId: row.revisionModelId,
        reasoningEffort: row.revisionReasoningEffort,
        createdAt: row.revisionCreatedAt,
        updatedAt: row.revisionUpdatedAt
      }),
      session: mapPaneCliSession(row),
      paneTitle: row.paneTitle,
      firstUserMessage: row.firstUserMessage,
      preview: row.preview,
      recencyAt: toIso(row.recencyAt)!
    }));
    if (items.length > 0 || offset === 0) {
      return { items, total: Number(result.rows[0]?.total ?? 0) };
    }
    const count = await this.pool.query<{ total: number | string }>(
      `
        SELECT count(*) AS total
        FROM cli_tasks task
        JOIN cli_task_revisions revision ON revision.revision_id = task.current_revision_id
        JOIN pane_cli_sessions s ON s.session_id = revision.latest_space_session_id
        JOIN panes p ON p.id = s.pane_id
        LEFT JOIN LATERAL (
          SELECT content
          FROM pane_cli_transcript_chunks
          WHERE session_id = s.session_id AND stream = 'stdin' AND length(trim(content)) > 0
          ORDER BY sequence ASC, created_at ASC
          LIMIT 1
        ) first_input ON true
        LEFT JOIN LATERAL (
          SELECT content
          FROM pane_cli_transcript_chunks
          WHERE session_id = s.session_id AND stream IN ('stdout', 'stderr') AND length(trim(content)) > 0
          ORDER BY sequence DESC, created_at DESC
          LIMIT 1
        ) latest_output ON true
        WHERE s.purpose = 'NORMAL'
          AND task.history_hidden_at IS NULL
          AND (
            length(trim(coalesce(revision.first_user_message, first_input.content, ''))) > 0
            OR revision.native_task_ref IS NOT NULL
          )
          AND ($1 = '' OR position($1 in lower(
            coalesce(nullif(trim(revision.display_title), ''), p.title) || E'\n' ||
            coalesce(nullif(trim(revision.first_user_message), ''), first_input.content, '') || E'\n' ||
            coalesce(nullif(trim(revision.preview), ''), latest_output.content, '')
          )) > 0)
          AND ($2::text[] IS NULL OR revision.runtime_id = ANY($2::text[]))
      `,
      [query, input.runtimeIds ?? null]
    );
    return { items, total: Number(count.rows[0]?.total ?? 0) };
  }

  async listInactivePaneCliTaskIds(): Promise<string[]> {
    const result = await this.pool.query<{ taskId: string }>(
      `
        SELECT task.task_id AS "taskId"
        FROM cli_tasks task
        JOIN cli_task_revisions revision ON revision.revision_id = task.current_revision_id
        JOIN pane_cli_sessions current_session ON current_session.session_id = revision.latest_space_session_id
        LEFT JOIN LATERAL (
          SELECT content
          FROM pane_cli_transcript_chunks
          WHERE session_id = current_session.session_id
            AND stream = 'stdin'
            AND length(trim(content)) > 0
          ORDER BY sequence ASC, created_at ASC
          LIMIT 1
        ) first_input ON true
        WHERE task.history_hidden_at IS NULL
          AND current_session.purpose = 'NORMAL'
          AND (
            length(trim(coalesce(revision.first_user_message, first_input.content, ''))) > 0
            OR revision.native_task_ref IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM pane_cli_sessions active_session
            WHERE active_session.cli_task_id = task.task_id
              AND active_session.is_active = true
          )
        ORDER BY task.task_id
        LIMIT 100001
      `
    );
    if (result.rows.length > 100_000) {
      throw new SpaceConflictError("Shared CLI task history purge candidate limit exceeded.");
    }
    return result.rows.map((row) => row.taskId);
  }

  async hideInactivePaneCliTasks(taskIds: string[]): Promise<string[]> {
    const boundedTaskIds = [...new Set(taskIds.map((taskId) => idSchema.parse(taskId)))].sort();
    if (boundedTaskIds.length > 100_000) {
      throw new SpaceConflictError("Shared CLI task history purge candidate limit exceeded.");
    }
    if (boundedTaskIds.length === 0) return [];
    const result = await this.pool.query<{ taskId: string }>(
      `
        UPDATE cli_tasks task
        SET history_hidden_at = $2
        WHERE task.task_id = ANY($1::text[])
          AND task.history_hidden_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pane_cli_sessions active_session
            WHERE active_session.cli_task_id = task.task_id
              AND active_session.is_active = true
          )
        RETURNING task.task_id AS "taskId"
      `,
      [boundedTaskIds, nowIso()]
    );
    return result.rows.map((row) => row.taskId).sort();
  }

  async restorePaneCliTasks(taskIds: string[]): Promise<void> {
    const boundedTaskIds = [...new Set(taskIds.map((taskId) => idSchema.parse(taskId)))].sort();
    if (boundedTaskIds.length > 100_000) {
      throw new SpaceConflictError("Shared CLI task history purge candidate limit exceeded.");
    }
    if (boundedTaskIds.length === 0) return;
    await this.pool.query(
      `UPDATE cli_tasks SET history_hidden_at = NULL WHERE task_id = ANY($1::text[])`,
      [boundedTaskIds]
    );
  }

  async getPaneTitlesByCodexThreadIds(codexThreadIds: string[]): Promise<Map<string, string>> {
    const uniqueThreadIds = [...new Set(codexThreadIds.filter(Boolean))];
    if (!uniqueThreadIds.length) return new Map();
    const result = await this.pool.query<{ codexThreadId: string; title: string }>(
      `
        SELECT DISTINCT ON (s.codex_thread_id)
          s.codex_thread_id AS "codexThreadId",
          p.title
        FROM pane_cli_sessions s
        JOIN panes p ON p.id = s.pane_id
        WHERE s.codex_thread_id = ANY($1::text[])
          AND length(trim(p.title)) > 0
        ORDER BY s.codex_thread_id, s.updated_at DESC, s.started_at DESC, s.session_id DESC
      `,
      [uniqueThreadIds]
    );
    return new Map(result.rows.map((row) => [row.codexThreadId, row.title]));
  }

  async getPaneCliSession(sessionId: string): Promise<PaneCliSession | null> {
    const result = await this.pool.query<PaneCliSessionRow>(`${paneCliSessionSelect} WHERE session_id = $1`, [sessionId]);
    return result.rows[0] ? mapPaneCliSession(result.rows[0]) : null;
  }

  async getActivePaneCliTerminalControlLease(sessionId: string): Promise<PaneCliTerminalControlLease | null> {
    await this.pool.query(
      `
        UPDATE pane_cli_terminal_control_leases
        SET status = 'EXPIRED', released_at = COALESCE(released_at, clock_timestamp())
        WHERE session_id = $1 AND status = 'ACTIVE' AND expires_at <= clock_timestamp()
      `,
      [sessionId]
    );
    const result = await this.pool.query<PaneCliTerminalControlLeaseRow>(
      `${paneCliTerminalControlLeaseSelect}
       WHERE session_id = $1 AND status = 'ACTIVE' AND expires_at > clock_timestamp()
       ORDER BY acquired_at DESC
       LIMIT 1`,
      [sessionId]
    );
    return result.rows[0] ? mapPaneCliTerminalControlLease(result.rows[0]) : null;
  }

  async getPaneCliTerminalControlLease(leaseId: string): Promise<PaneCliTerminalControlLease | null> {
    await this.pool.query(
      `
        UPDATE pane_cli_terminal_control_leases
        SET status = 'EXPIRED', released_at = COALESCE(released_at, clock_timestamp())
        WHERE lease_id = $1 AND status = 'ACTIVE' AND expires_at <= clock_timestamp()
      `,
      [leaseId]
    );
    const result = await this.pool.query<PaneCliTerminalControlLeaseRow>(
      `${paneCliTerminalControlLeaseSelect} WHERE lease_id = $1`,
      [leaseId]
    );
    return result.rows[0] ? mapPaneCliTerminalControlLease(result.rows[0]) : null;
  }

  async createPaneCliTerminalControlLease(
    input: CreatePaneCliTerminalControlLeaseInput
  ): Promise<PaneCliTerminalControlLease> {
    const parsed = createPaneCliTerminalControlLeaseInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneCliSessionRow>(
        `${paneCliSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [parsed.sessionId]
      );
      const session = mapPaneCliSession(
        firstOrNotFound(sessionResult.rows, `CLI session ${parsed.sessionId} was not found.`)
      );
      if (session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`CLI session ${parsed.sessionId} was not found.`);
      }
      await client.query(
        `
          UPDATE pane_cli_terminal_control_leases
          SET status = 'EXPIRED', released_at = COALESCE(released_at, clock_timestamp())
          WHERE session_id = $1 AND status = 'ACTIVE' AND expires_at <= clock_timestamp()
        `,
        [parsed.sessionId]
      );
      const activeResult = await client.query<PaneCliTerminalControlLeaseRow>(
        `${paneCliTerminalControlLeaseSelect}
         WHERE session_id = $1 AND status = 'ACTIVE'
         LIMIT 1
         FOR UPDATE`,
        [parsed.sessionId]
      );
      const active = activeResult.rows[0] ? mapPaneCliTerminalControlLease(activeResult.rows[0]) : null;
      if (parsed.expectedActiveLeaseId === null ? active !== null : active?.leaseId !== parsed.expectedActiveLeaseId) {
        throw new SpaceConflictError(`CLI terminal control for session ${parsed.sessionId} changed before acquisition.`);
      }
      const leaseId = parsed.leaseId ?? makeSpaceId("cli_terminal_lease");
      if (active) {
        await client.query(
          `
            UPDATE pane_cli_terminal_control_leases
            SET status = 'REVOKED', released_at = COALESCE(released_at, clock_timestamp())
            WHERE lease_id = $1 AND status = 'ACTIVE'
          `,
          [active.leaseId]
        );
      }
      const result = await client.query<PaneCliTerminalControlLeaseRow>(
        `
          WITH lease_clock AS (
            SELECT clock_timestamp() AS acquired_at
          )
          INSERT INTO pane_cli_terminal_control_leases (
            lease_id, session_id, pane_id, room_id, user_id,
            browser_client_id, tab_lineage_id, page_client_id, status,
            acquired_at, heartbeat_at, expires_at, released_at
          )
          SELECT
            $1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE',
            lease_clock.acquired_at,
            lease_clock.acquired_at,
            lease_clock.acquired_at + ($9::integer * interval '1 second'),
            NULL
          FROM lease_clock
          RETURNING
            lease_id AS "leaseId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            user_id AS "userId", browser_client_id AS "browserClientId",
            tab_lineage_id AS "tabLineageId", page_client_id AS "pageClientId", status,
            acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt", expires_at AS "expiresAt",
            released_at AS "releasedAt"
        `,
        [
          leaseId,
          parsed.sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.userId,
          parsed.browserClientId,
          parsed.tabLineageId,
          parsed.pageClientId,
          parsed.ttlSeconds
        ]
      );
      return mapPaneCliTerminalControlLease(
        firstOrNotFound(result.rows, `CLI terminal control lease ${leaseId} was not stored.`)
      );
    }, { deadlockRetries: 1 });
  }

  async updatePaneCliTerminalControlLease(
    leaseId: string,
    input: UpdatePaneCliTerminalControlLeaseInput
  ): Promise<PaneCliTerminalControlLease> {
    const parsed = updatePaneCliTerminalControlLeaseInputSchema.parse(input);
    const outcome = await this.withTransaction(async (client) => {
      const currentResult = await client.query<PaneCliTerminalControlLeaseRow>(
        `${paneCliTerminalControlLeaseSelect} WHERE lease_id = $1 FOR UPDATE`,
        [leaseId]
      );
      let current = mapPaneCliTerminalControlLease(
        firstOrNotFound(currentResult.rows, `CLI terminal control lease ${leaseId} was not found.`)
      );
      const expiredResult = await client.query<PaneCliTerminalControlLeaseRow>(
        `
          UPDATE pane_cli_terminal_control_leases
          SET status = 'EXPIRED', released_at = COALESCE(released_at, clock_timestamp())
          WHERE lease_id = $1 AND status = 'ACTIVE' AND expires_at <= clock_timestamp()
          RETURNING
            lease_id AS "leaseId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            user_id AS "userId", browser_client_id AS "browserClientId",
            tab_lineage_id AS "tabLineageId", page_client_id AS "pageClientId", status,
            acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt", expires_at AS "expiresAt",
            released_at AS "releasedAt"
        `,
        [leaseId]
      );
      if (expiredResult.rows[0]) current = mapPaneCliTerminalControlLease(expiredResult.rows[0]);
      if (current.status !== parsed.expectedStatus) return { lease: current, updated: false as const };

      const status = parsed.status ?? current.status;
      const result = await client.query<PaneCliTerminalControlLeaseRow>(
        `
          WITH lease_clock AS (
            SELECT clock_timestamp() AS now_at
          )
          UPDATE pane_cli_terminal_control_leases AS lease
          SET status = $2,
              heartbeat_at = CASE
                WHEN $3::integer IS NULL THEN lease.heartbeat_at
                ELSE lease_clock.now_at
              END,
              expires_at = CASE
                WHEN $3::integer IS NULL THEN lease.expires_at
                ELSE lease_clock.now_at + ($3::integer * interval '1 second')
              END,
              released_at = CASE
                WHEN $2 = 'ACTIVE' THEN NULL
                ELSE COALESCE(lease.released_at, lease_clock.now_at)
              END
          FROM lease_clock
          WHERE lease.lease_id = $1 AND lease.status = $4
          RETURNING
            lease.lease_id AS "leaseId", lease.session_id AS "sessionId",
            lease.pane_id AS "paneId", lease.room_id AS "roomId",
            lease.user_id AS "userId", lease.browser_client_id AS "browserClientId",
            lease.tab_lineage_id AS "tabLineageId", lease.page_client_id AS "pageClientId", lease.status,
            lease.acquired_at AS "acquiredAt", lease.heartbeat_at AS "heartbeatAt",
            lease.expires_at AS "expiresAt", lease.released_at AS "releasedAt"
        `,
        [leaseId, status, parsed.ttlSeconds ?? null, parsed.expectedStatus]
      );
      const row = result.rows[0];
      return row
        ? { lease: mapPaneCliTerminalControlLease(row), updated: true as const }
        : { lease: current, updated: false as const };
    }, { deadlockRetries: 1 });
    if (!outcome.updated) {
      throw new SpaceConflictError(`CLI terminal control lease ${leaseId} is no longer active.`);
    }
    return outcome.lease;
  }

  async getPaneCliCodexThreadOwnership(codexThreadId: string): Promise<PaneCliCodexThreadOwnership | null> {
    const result = await this.pool.query<PaneCliCodexThreadOwnershipRow>(
      `${paneCliCodexThreadOwnershipSelect} WHERE thread_id = $1`,
      [codexThreadId]
    );
    return result.rows[0] ? mapPaneCliCodexThreadOwnership(result.rows[0]) : null;
  }

  async claimPaneCliCodexThread(
    sessionId: string,
    codexThreadId: string,
    source: Exclude<PaneCliCodexThreadOwnershipSource, "MIGRATION">,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneCliCodexThreadOwnership> {
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneCliSessionRow>(
        `${paneCliSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = mapPaneCliSession(firstOrNotFound(sessionResult.rows, `CLI session ${sessionId} was not found.`));
      const ownershipResult = await client.query<PaneCliCodexThreadOwnershipRow>(
        `${paneCliCodexThreadOwnershipSelect} WHERE thread_id = $1 FOR UPDATE`,
        [codexThreadId]
      );
      const current = ownershipResult.rows[0] ? mapPaneCliCodexThreadOwnership(ownershipResult.rows[0]) : null;
      if (source === "AUTO" && current && current.cliSessionId !== sessionId) {
        throw new SpaceConflictError(
          `Codex thread ${codexThreadId} is permanently owned by CLI session ${current.cliSessionId}; use explicit history resume to transfer it.`
        );
      }
      const timestamp = nowIso();
      await client.query(
        `UPDATE pane_cli_sessions SET codex_thread_id = NULL, updated_at = $3 WHERE codex_thread_id = $1 AND session_id <> $2`,
        [codexThreadId, sessionId, timestamp]
      );
      await client.query(`UPDATE pane_cli_sessions SET codex_thread_id = $2, updated_at = $3 WHERE session_id = $1`, [
        sessionId,
        codexThreadId,
        timestamp
      ]);
      if (session.cliTaskId && session.cliTaskRevisionId) {
        if (source === "HISTORY_TRANSFER") {
          await client.query(
            `UPDATE cli_task_revisions
             SET native_task_ref = NULL, updated_at = $4
             WHERE runtime_id = $1 AND native_task_ref = $2 AND revision_id <> $3`,
            [session.runtimeId, codexThreadId, session.cliTaskRevisionId, timestamp]
          );
        } else {
          await client.query(
            `UPDATE cli_task_revisions
             SET native_task_ref = NULL, updated_at = $4
             WHERE task_id = $1 AND runtime_id = $2 AND native_task_ref = $3 AND revision_id <> $5`,
            [session.cliTaskId, session.runtimeId, codexThreadId, timestamp, session.cliTaskRevisionId]
          );
        }
        await client.query(
          `UPDATE cli_task_revisions
           SET native_task_ref = $2, latest_space_session_id = $3, updated_at = $4
           WHERE revision_id = $1 AND task_id = $5`,
          [session.cliTaskRevisionId, codexThreadId, session.sessionId, timestamp, session.cliTaskId]
        );
        await client.query(`UPDATE cli_tasks SET updated_at = $2 WHERE task_id = $1`, [session.cliTaskId, timestamp]);
      }
      if (source === "AUTO" && session.codexThreadId && session.codexThreadId !== codexThreadId) {
        await client.query(
          `DELETE FROM pane_cli_codex_thread_ownerships WHERE thread_id = $1 AND cli_session_id = $2 AND source = 'HISTORY_TRANSFER'`,
          [session.codexThreadId, sessionId]
        );
      }
      const result = await client.query<PaneCliCodexThreadOwnershipRow>(
        `
          INSERT INTO pane_cli_codex_thread_ownerships (
            thread_id, room_id, pane_id, cli_session_id, source, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $6)
          ON CONFLICT (thread_id)
          DO UPDATE SET
            room_id = EXCLUDED.room_id,
            pane_id = EXCLUDED.pane_id,
            cli_session_id = EXCLUDED.cli_session_id,
            source = EXCLUDED.source,
            updated_at = EXCLUDED.updated_at
          RETURNING
            thread_id AS "threadId",
            room_id AS "roomId",
            pane_id AS "paneId",
            cli_session_id AS "cliSessionId",
            source,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [codexThreadId, session.roomId, session.paneId, sessionId, source, timestamp]
      );
      return mapPaneCliCodexThreadOwnership(
        firstOrNotFound(result.rows, `Codex thread ownership ${codexThreadId} was not stored.`)
      );
    }, { deadlockRetries: 1 });
  }

  async createPaneCliSession(input: CreatePaneCliSessionInput, _traceId = makeSpaceId("trace")): Promise<PaneCliSession> {
    const parsed = createPaneCliSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const pane = await this.getPaneForUpdate(client, parsed.paneId);
      if (pane.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
      }
      if (pane.mode !== "TERMINAL") {
        throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; CLI sessions require TERMINAL panes.`);
      }
      if (pane.isClosed) {
        throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
      }
      const timestamp = nowIso();
      const sessionId = parsed.sessionId ?? makeSpaceId("cli_session");
      const cliTaskId = parsed.purpose === "NORMAL" ? parsed.cliTaskId ?? sessionId : null;
      const cliTaskRevisionId = parsed.purpose === "NORMAL" ? parsed.cliTaskRevisionId ?? sessionId : null;
      let sourceRevisionId: string | null = null;
      if (parsed.purpose === "NORMAL" && cliTaskId && cliTaskRevisionId) {
        if (parsed.cliTaskId) {
          const task = await client.query<CliTaskRow>(`${cliTaskSelect} WHERE task_id = $1 FOR UPDATE`, [cliTaskId]);
          if (!task.rows[0]) throw new SpaceNotFoundError(`CLI task ${cliTaskId} was not found.`);
          sourceRevisionId = task.rows[0].currentRevisionId;
        } else {
          await client.query(
            `INSERT INTO cli_tasks (task_id, current_revision_id, created_at, updated_at)
             VALUES ($1, NULL, $2, $2)
             ON CONFLICT (task_id) DO NOTHING`,
            [cliTaskId, timestamp]
          );
        }
        if (parsed.cliTaskRevisionId) {
          const revision = await client.query<{ taskId: string }>(
            `SELECT task_id AS "taskId" FROM cli_task_revisions WHERE revision_id = $1 FOR UPDATE`,
            [cliTaskRevisionId]
          );
          if (revision.rows[0]?.taskId !== cliTaskId) {
            throw new SpaceConflictError("CLI task revision does not belong to the selected logical task.");
          }
        } else {
          await client.query(
            `INSERT INTO cli_task_revisions (
               revision_id, task_id, runtime_id, provider_id, agent_id, native_task_ref,
               source_revision_id, latest_space_session_id, display_title, first_user_message,
               preview, cwd, model_id, reasoning_effort, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, '', '', $9, $10, $11, $12, $12)`,
            [
              cliTaskRevisionId,
              cliTaskId,
              parsed.runtimeId,
              parsed.providerId,
              parsed.agentId,
              parsed.codexThreadId ?? null,
              sourceRevisionId,
              pane.title,
              parsed.cwd ?? null,
              parsed.modelId ?? null,
              parsed.reasoningEffort,
              timestamp
            ]
          );
        }
      }
      const isActive = parsed.isActive ?? true;
      if (isActive) {
        await client.query(`UPDATE pane_cli_sessions SET is_active = false, updated_at = $2 WHERE pane_id = $1`, [
          parsed.paneId,
          timestamp
        ]);
      }
      if (isActive && parsed.codexThreadId) {
        await this.assertActiveCodexThreadAvailable(client, sessionId, parsed.codexThreadId);
      }
      const result = await client.query<PaneCliSessionRow>(
        `
          INSERT INTO pane_cli_sessions (
            session_id,
            pane_id,
            room_id,
            runtime_id,
            provider_id,
            agent_id,
            model_id,
            reasoning_effort,
            launch_mode,
            purpose,
            cwd,
            codex_thread_id,
            cli_task_id,
            cli_task_revision_id,
            status,
            status_reason,
            exit_code,
            is_active,
            started_at,
            updated_at,
            ended_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL, $17, $18, $18, NULL)
          ON CONFLICT (session_id)
          DO UPDATE SET
            pane_id = EXCLUDED.pane_id,
            room_id = EXCLUDED.room_id,
            runtime_id = EXCLUDED.runtime_id,
            provider_id = EXCLUDED.provider_id,
            agent_id = EXCLUDED.agent_id,
            model_id = EXCLUDED.model_id,
            reasoning_effort = EXCLUDED.reasoning_effort,
            launch_mode = EXCLUDED.launch_mode,
            purpose = EXCLUDED.purpose,
            cwd = EXCLUDED.cwd,
            codex_thread_id = COALESCE(EXCLUDED.codex_thread_id, pane_cli_sessions.codex_thread_id),
            cli_task_id = COALESCE(EXCLUDED.cli_task_id, pane_cli_sessions.cli_task_id),
            cli_task_revision_id = COALESCE(EXCLUDED.cli_task_revision_id, pane_cli_sessions.cli_task_revision_id),
            status = EXCLUDED.status,
            status_reason = EXCLUDED.status_reason,
            exit_code = EXCLUDED.exit_code,
            is_active = EXCLUDED.is_active,
            updated_at = EXCLUDED.updated_at,
            ended_at = EXCLUDED.ended_at
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            runtime_id AS "runtimeId",
            provider_id AS "providerId",
            agent_id AS "agentId",
            model_id AS "modelId",
            reasoning_effort AS "reasoningEffort",
            launch_mode AS "launchMode",
            purpose,
            cwd,
            codex_thread_id AS "codexThreadId",
            cli_task_id AS "cliTaskId",
            cli_task_revision_id AS "cliTaskRevisionId",
            status,
            status_reason AS "statusReason",
            exit_code AS "exitCode",
            is_active AS "isActive",
            started_at AS "startedAt",
            updated_at AS "updatedAt",
            ended_at AS "endedAt"
        `,
        [
          sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.runtimeId,
          parsed.providerId,
          parsed.agentId,
          parsed.modelId ?? null,
          parsed.reasoningEffort,
          parsed.launchMode,
          parsed.purpose,
          parsed.cwd ?? null,
          parsed.codexThreadId ?? null,
          cliTaskId,
          cliTaskRevisionId,
          parsed.status ?? "IDLE",
          parsed.statusReason ?? null,
          isActive,
          timestamp
        ]
      );
      const stored = mapPaneCliSession(firstOrNotFound(result.rows, `CLI session ${sessionId} was not stored.`));
      if (cliTaskId && cliTaskRevisionId) {
        await client.query(
          `UPDATE cli_task_revisions SET latest_space_session_id = $2, updated_at = $3 WHERE revision_id = $1`,
          [cliTaskRevisionId, sessionId, timestamp]
        );
        await client.query(
          `UPDATE cli_tasks
           SET current_revision_id = $2, updated_at = $3, history_hidden_at = NULL
           WHERE task_id = $1`,
          [cliTaskId, cliTaskRevisionId, timestamp]
        );
      }
      return stored;
    }, { deadlockRetries: 1 });
  }

  async updatePaneCliSession(
    sessionId: string,
    input: UpdatePaneCliSessionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneCliSession> {
    const parsed = updatePaneCliSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<PaneCliSessionRow>(
        `${paneCliSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [sessionId]
      );
      const current = mapPaneCliSession(firstOrNotFound(currentResult.rows, `CLI session ${sessionId} was not found.`));
      const timestamp = nowIso();
      const terminal = parsed.status === "EXITED" || parsed.status === "ERROR";
      const isActive = parsed.isActive === undefined ? current.isActive : parsed.isActive;
      if (isActive) {
        await client.query(
          `UPDATE pane_cli_sessions SET is_active = false, updated_at = $3 WHERE pane_id = $1 AND session_id <> $2`,
          [current.paneId, sessionId, timestamp]
        );
      }
      const nextCodexThreadId = parsed.codexThreadId === undefined ? current.codexThreadId : parsed.codexThreadId;
      if (isActive && nextCodexThreadId) {
        await this.assertActiveCodexThreadAvailable(client, sessionId, nextCodexThreadId);
      }
      const result = await client.query<PaneCliSessionRow>(
        `
          UPDATE pane_cli_sessions
          SET status = $2,
              status_reason = $3,
              exit_code = $4,
              is_active = $5,
              updated_at = $6,
              ended_at = $7,
              codex_thread_id = $8,
              model_id = $9,
              reasoning_effort = $10,
              launch_mode = $11,
              cli_task_id = $12,
              cli_task_revision_id = $13
          WHERE session_id = $1
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            runtime_id AS "runtimeId",
            provider_id AS "providerId",
            agent_id AS "agentId",
            model_id AS "modelId",
            reasoning_effort AS "reasoningEffort",
            launch_mode AS "launchMode",
            purpose,
            cwd,
            codex_thread_id AS "codexThreadId",
            cli_task_id AS "cliTaskId",
            cli_task_revision_id AS "cliTaskRevisionId",
            status,
            status_reason AS "statusReason",
            exit_code AS "exitCode",
            is_active AS "isActive",
            started_at AS "startedAt",
            updated_at AS "updatedAt",
            ended_at AS "endedAt"
        `,
        [
          sessionId,
          parsed.status ?? current.status,
          parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
          parsed.exitCode === undefined ? current.exitCode : parsed.exitCode,
          isActive,
          timestamp,
          parsed.endedAt === undefined ? (terminal ? timestamp : current.endedAt) : parsed.endedAt,
          nextCodexThreadId,
          parsed.modelId === undefined ? current.modelId : parsed.modelId,
          parsed.reasoningEffort ?? current.reasoningEffort,
          parsed.launchMode ?? current.launchMode,
          parsed.cliTaskId === undefined ? current.cliTaskId : parsed.cliTaskId,
          parsed.cliTaskRevisionId === undefined ? current.cliTaskRevisionId : parsed.cliTaskRevisionId
        ]
      );
      const updated = mapPaneCliSession(firstOrNotFound(result.rows, `CLI session ${sessionId} was not updated.`));
      if (updated.cliTaskId && updated.cliTaskRevisionId) {
        if (nextCodexThreadId) {
          await client.query(
            `UPDATE cli_task_revisions
             SET native_task_ref = NULL, updated_at = $3
             WHERE task_id = $1 AND runtime_id = $2 AND native_task_ref = $4 AND revision_id <> $5`,
            [updated.cliTaskId, updated.runtimeId, timestamp, nextCodexThreadId, updated.cliTaskRevisionId]
          );
        }
        await client.query(
          `UPDATE cli_task_revisions revision
           SET latest_space_session_id = $2,
               native_task_ref = CASE WHEN $3::text IS NULL THEN revision.native_task_ref ELSE $3 END,
               updated_at = $4
           FROM cli_tasks task
           WHERE revision.revision_id = $1
             AND task.task_id = revision.task_id
             AND task.current_revision_id = revision.revision_id`,
          [updated.cliTaskRevisionId, updated.sessionId, nextCodexThreadId, timestamp]
        );
      }
      return updated;
    }, { deadlockRetries: 1 });
  }

  async appendPaneCliTranscriptChunk(
    input: CreatePaneCliTranscriptChunkInput,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneCliTranscriptChunk> {
    const parsed = createPaneCliTranscriptChunkInputSchema.parse(input);
    return this.appendPaneCliTranscriptChunkInternal(parsed, false);
  }

  async appendPaneCliTranscriptChunkAtNextSequence(
    input: Omit<CreatePaneCliTranscriptChunkInput, "sequence">,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneCliTranscriptChunk> {
    const parsed = createPaneCliTranscriptChunkInputSchema.parse({ ...input, sequence: 0 });
    return this.appendPaneCliTranscriptChunkInternal(parsed, true);
  }

  private async updateCliTaskRevisionTranscript(
    client: PgClientLike,
    session: PaneCliSession,
    stream: PaneCliTranscriptChunk["stream"],
    content: string,
    timestamp: string
  ): Promise<void> {
    if (!session.cliTaskId || !session.cliTaskRevisionId || stream === "system" || !content.trim()) return;
    await client.query(
      `UPDATE cli_task_revisions revision
       SET first_user_message = CASE
             WHEN $3 = 'stdin' AND length(trim(revision.first_user_message)) = 0 THEN $4
             ELSE revision.first_user_message
           END,
           preview = CASE
             WHEN $3 IN ('stdout', 'stderr') THEN $4
             WHEN length(trim(revision.preview)) = 0 THEN $4
             ELSE revision.preview
           END,
           updated_at = $5
       FROM cli_tasks task
       WHERE revision.revision_id = $2
         AND revision.task_id = $1
         AND task.task_id = revision.task_id
         AND task.current_revision_id = revision.revision_id`,
      [session.cliTaskId, session.cliTaskRevisionId, stream, content.trim(), timestamp]
    );
    await client.query(`UPDATE cli_tasks SET updated_at = $2 WHERE task_id = $1`, [session.cliTaskId, timestamp]);
  }

  private async appendPaneCliTranscriptChunkInternal(
    input: CreatePaneCliTranscriptChunkInput,
    allocateNextSequence: boolean
  ): Promise<PaneCliTranscriptChunk> {
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneCliSessionRow>(
        `${paneCliSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [input.sessionId]
      );
      const session = mapPaneCliSession(firstOrNotFound(sessionResult.rows, `CLI session ${input.sessionId} was not found.`));
      if (session.paneId !== input.paneId) {
        throw new SpaceNotFoundError(`CLI session ${input.sessionId} was not found.`);
      }
      const sequence = allocateNextSequence
        ? Number((await client.query<{ nextSequence: number | string }>(
            `SELECT coalesce(max(sequence), -1) + 1 AS "nextSequence" FROM pane_cli_transcript_chunks WHERE session_id = $1`,
            [input.sessionId]
          )).rows[0]?.nextSequence ?? 0)
        : input.sequence;
      const parsed = createPaneCliTranscriptChunkInputSchema.parse({ ...input, sequence });
      const timestamp = nowIso();
      const chunkId = parsed.chunkId ?? makeSpaceId("cli_chunk");
      const byteLength = parsed.byteLength ?? Buffer.byteLength(parsed.content, "utf8");
      const result = await client.query<PaneCliTranscriptChunkRow>(
        `
          INSERT INTO pane_cli_transcript_chunks (
            chunk_id,
            session_id,
            pane_id,
            room_id,
            sequence,
            stream,
            content,
            byte_length,
            created_at,
            host_generation_id,
            host_output_sequence
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            chunk_id AS "chunkId",
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            sequence,
            stream,
            content,
            byte_length AS "byteLength",
            host_generation_id AS "hostGenerationId",
            host_output_sequence AS "hostOutputSequence",
            created_at AS "createdAt"
        `,
        [
          chunkId,
          parsed.sessionId,
          parsed.paneId,
          session.roomId,
          parsed.sequence,
          parsed.stream,
          parsed.content,
          byteLength,
          timestamp,
          parsed.hostGenerationId,
          parsed.hostOutputSequence
        ]
      );
      await this.updateCliTaskRevisionTranscript(client, session, parsed.stream, parsed.content, timestamp);
      await client.query(
        `
          DELETE FROM pane_cli_transcript_chunks
          WHERE session_id = $1
            AND chunk_id NOT IN (
              SELECT chunk_id
              FROM pane_cli_transcript_chunks
              WHERE session_id = $1
              ORDER BY sequence DESC, created_at DESC
              LIMIT $2
            )
        `,
        [parsed.sessionId, PANE_CLI_TRANSCRIPT_CHUNK_CAP]
      );
      return mapPaneCliTranscriptChunk(firstOrNotFound(result.rows, `CLI transcript chunk ${chunkId} was not stored.`));
    });
  }

  async appendPaneCliHostOutputChunk(
    input: CreatePaneCliHostOutputInput,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneCliTranscriptChunk> {
    const parsed = createPaneCliHostOutputInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneCliSessionRow>(
        `${paneCliSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [parsed.sessionId]
      );
      const session = mapPaneCliSession(firstOrNotFound(sessionResult.rows, `CLI session ${parsed.sessionId} was not found.`));
      if (session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`CLI session ${parsed.sessionId} was not found.`);
      }
      const existing = await client.query<PaneCliTranscriptChunkRow>(
        `${paneCliTranscriptChunkSelect} WHERE session_id = $1 AND host_generation_id = $2 AND host_output_sequence = $3 LIMIT 1`,
        [parsed.sessionId, parsed.generationId, parsed.outputSequence]
      );
      if (existing.rows[0]) return mapPaneCliTranscriptChunk(existing.rows[0]);
      const sequenceResult = await client.query<{ nextSequence: number | string }>(
        `SELECT coalesce(max(sequence), -1) + 1 AS "nextSequence" FROM pane_cli_transcript_chunks WHERE session_id = $1`,
        [parsed.sessionId]
      );
      const sequence = Number(sequenceResult.rows[0]?.nextSequence ?? 0);
      const timestamp = nowIso();
      const chunkId = makeSpaceId("cli_chunk");
      const byteLength = parsed.byteLength ?? Buffer.byteLength(parsed.content, "utf8");
      const result = await client.query<PaneCliTranscriptChunkRow>(
        `
          INSERT INTO pane_cli_transcript_chunks (
            chunk_id, session_id, pane_id, room_id, sequence, stream, content, byte_length,
            created_at, host_generation_id, host_output_sequence
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            chunk_id AS "chunkId",
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            sequence,
            stream,
            content,
            byte_length AS "byteLength",
            host_generation_id AS "hostGenerationId",
            host_output_sequence AS "hostOutputSequence",
            created_at AS "createdAt"
        `,
        [
          chunkId,
          parsed.sessionId,
          parsed.paneId,
          session.roomId,
          sequence,
          parsed.stream,
          parsed.content,
          byteLength,
          timestamp,
          parsed.generationId,
          parsed.outputSequence
        ]
      );
      await this.updateCliTaskRevisionTranscript(client, session, parsed.stream, parsed.content, timestamp);
      await client.query(
        `
          DELETE FROM pane_cli_transcript_chunks
          WHERE session_id = $1
            AND chunk_id NOT IN (
              SELECT chunk_id FROM pane_cli_transcript_chunks
              WHERE session_id = $1
              ORDER BY sequence DESC, created_at DESC
              LIMIT $2
            )
        `,
        [parsed.sessionId, PANE_CLI_TRANSCRIPT_CHUNK_CAP]
      );
      return mapPaneCliTranscriptChunk(firstOrNotFound(result.rows, `CLI transcript chunk ${chunkId} was not stored.`));
    });
  }

  async getPaneCliHostOutputCursor(sessionId: string, generationId: string): Promise<number> {
    const result = await this.pool.query<{ cursor: number | string }>(
      `
        SELECT coalesce(max(host_output_sequence), -1) AS cursor
        FROM pane_cli_transcript_chunks
        WHERE session_id = $1 AND host_generation_id = $2
      `,
      [sessionId, generationId]
    );
    return Number(result.rows[0]?.cursor ?? -1);
  }

  async listPaneCliTranscriptChunks(sessionId: string, limit = PANE_CLI_TRANSCRIPT_CHUNK_CAP): Promise<PaneCliTranscriptChunk[]> {
    const cappedLimit = Math.max(0, Math.min(Math.trunc(limit), PANE_CLI_TRANSCRIPT_CHUNK_CAP));
    if (cappedLimit === 0) return [];
    const result = await this.pool.query<PaneCliTranscriptChunkRow>(
      `
        SELECT *
        FROM (
          ${paneCliTranscriptChunkSelect}
          WHERE session_id = $1
          ORDER BY sequence DESC, created_at DESC
          LIMIT $2
        ) recent
        ORDER BY sequence ASC, "createdAt" ASC
      `,
      [sessionId, cappedLimit]
    );
    return result.rows.map(mapPaneCliTranscriptChunk);
  }

  async listManagedCodexThreadIds(): Promise<string[]> {
    const result = await this.pool.query<{ threadId: string }>(
      `
        SELECT thread_id AS "threadId"
        FROM pane_cli_codex_thread_ownerships
        UNION
        SELECT thread_id AS "threadId"
        FROM space_agent_sessions
        WHERE source = 'SPACE' AND thread_id IS NOT NULL
        ORDER BY "threadId"
      `
    );
    return result.rows.map((row) => row.threadId);
  }

  async listActiveManagedCodexThreadIds(): Promise<string[]> {
    const result = await this.pool.query<{ threadId: string }>(
      `
        SELECT codex_thread_id AS "threadId"
        FROM pane_cli_sessions
        WHERE is_active = true AND codex_thread_id IS NOT NULL
        UNION
        SELECT thread_id AS "threadId"
        FROM space_agent_sessions
        WHERE is_active = true AND thread_id IS NOT NULL
        ORDER BY "threadId"
      `
    );
    return result.rows.map((row) => row.threadId);
  }

  async createCodexCliTurnMarker(input: CreateCodexCliTurnMarkerInput): Promise<CodexCliTurnMarkerRecord> {
    const markerId = makeSpaceId("codex_cli_turn");
    const inserted = await this.pool.query<CodexCliTurnMarkerRow>(
      `
        INSERT INTO codex_cli_turn_markers (
          marker_id, session_id, room_id, pane_id, client_turn_marker,
          status, codex_thread_id, submitted_at, next_check_at, updated_at
        )
        SELECT $1, s.session_id, s.room_id, s.pane_id, $2,
               'PENDING', s.codex_thread_id, $3, $3, $3
        FROM pane_cli_sessions s
        WHERE s.session_id = $4 AND s.room_id = $5 AND s.pane_id = $6
        ON CONFLICT (session_id, client_turn_marker) DO NOTHING
        RETURNING
          marker_id AS "markerId", session_id AS "sessionId", room_id AS "roomId", pane_id AS "paneId",
          client_turn_marker AS "clientTurnMarker", status, codex_thread_id AS "codexThreadId",
          rollout_path AS "rolloutPath", completion_event_id AS "completionEventId",
          submitted_at AS "submittedAt", completed_at AS "completedAt", next_check_at AS "nextCheckAt",
          check_attempt_count AS "checkAttemptCount", locked_at AS "lockedAt", locked_by AS "lockedBy",
          safe_error_code AS "safeErrorCode", updated_at AS "updatedAt"
      `,
      [markerId, input.clientTurnMarker, input.submittedAt, input.sessionId, input.roomId, input.paneId]
    );
    if (inserted.rows[0]) return mapCodexCliTurnMarker(inserted.rows[0]);
    const existing = await this.pool.query<CodexCliTurnMarkerRow>(
      `${codexCliTurnMarkerSelect} WHERE session_id = $1 AND client_turn_marker = $2`,
      [input.sessionId, input.clientTurnMarker]
    );
    return mapCodexCliTurnMarker(
      firstOrNotFound(existing.rows, `Codex CLI turn marker ${input.clientTurnMarker} was not stored.`)
    );
  }

  async claimCodexCliTurnMarkers(input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }): Promise<CodexCliTurnMarkerRecord[]> {
    return this.withTransaction(async (client) => {
      const result = await client.query<CodexCliTurnMarkerRow>(
        `
          WITH stale AS (
            UPDATE codex_cli_turn_markers
            SET status = 'PENDING', locked_at = NULL, locked_by = NULL,
                safe_error_code = 'CODEX_CLI_MARKER_STALE_LOCK_RECOVERED', updated_at = $1
            WHERE status = 'PROCESSING' AND locked_at < $2
            RETURNING marker_id
          ),
          candidates AS (
            SELECT marker_id
            FROM codex_cli_turn_markers
            WHERE status = 'PENDING' AND next_check_at <= $1
            ORDER BY next_check_at ASC, submitted_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $3
          )
          UPDATE codex_cli_turn_markers m
          SET status = 'PROCESSING', locked_at = $1, locked_by = $4,
              check_attempt_count = check_attempt_count + 1, updated_at = $1
          FROM candidates
          WHERE m.marker_id = candidates.marker_id
          RETURNING
            m.marker_id AS "markerId", m.session_id AS "sessionId", m.room_id AS "roomId", m.pane_id AS "paneId",
            m.client_turn_marker AS "clientTurnMarker", m.status, m.codex_thread_id AS "codexThreadId",
            m.rollout_path AS "rolloutPath", m.completion_event_id AS "completionEventId",
            m.submitted_at AS "submittedAt", m.completed_at AS "completedAt", m.next_check_at AS "nextCheckAt",
            m.check_attempt_count AS "checkAttemptCount", m.locked_at AS "lockedAt", m.locked_by AS "lockedBy",
            m.safe_error_code AS "safeErrorCode", m.updated_at AS "updatedAt"
        `,
        [input.now, input.staleBefore, Math.max(1, Math.min(input.limit, 50)), input.workerId]
      );
      return result.rows.map(mapCodexCliTurnMarker);
    });
  }

  async deferCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    codexThreadId?: string | null;
    rolloutPath?: string | null;
    nextCheckAt: string;
    safeErrorCode?: string | null;
    now: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE codex_cli_turn_markers
        SET status = 'PENDING',
            codex_thread_id = CASE WHEN $3::boolean THEN $4 ELSE codex_thread_id END,
            rollout_path = CASE WHEN $5::boolean THEN $6 ELSE rollout_path END,
            next_check_at = $7, locked_at = NULL, locked_by = NULL,
            safe_error_code = $8, updated_at = $9
        WHERE marker_id = $1 AND status = 'PROCESSING' AND locked_by = $2
      `,
      [
        input.markerId,
        input.workerId,
        input.codexThreadId !== undefined,
        input.codexThreadId ?? null,
        input.rolloutPath !== undefined,
        input.rolloutPath ?? null,
        input.nextCheckAt,
        input.safeErrorCode ?? null,
        input.now
      ]
    );
  }

  async completeCodexCliTurnMarker(input: CompleteCodexCliTurnMarkerInput): Promise<CodexCliTurnMarkerRecord> {
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<CodexCliTurnMarkerRow>(
        `${codexCliTurnMarkerSelect} WHERE marker_id = $1 FOR UPDATE`,
        [input.markerId]
      );
      const current = mapCodexCliTurnMarker(
        firstOrNotFound(currentResult.rows, `Codex CLI turn marker ${input.markerId} was not found.`)
      );
      if (current.status !== "PROCESSING" || current.lockedBy !== input.workerId) {
        throw new SpaceConflictError(`Codex CLI turn marker ${input.markerId} is not claimed by this worker.`);
      }
      const event = await this.appendEvent(client, {
        roomId: current.roomId,
        paneId: current.paneId,
        turnId: null,
        workflowId: null,
        traceId: input.traceId,
        type: "TURN_COMPLETED",
        message: "Codex terminal turn completed.",
        payload: {
          status: "COMPLETED",
          sourceType: "TERMINAL",
          markerId: current.markerId,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId
        }
      });
      await client.query(
        `
          INSERT INTO telegram_notification_outbox (
            delivery_id, integration_generation, source_key, source_type,
            room_id, pane_id, turn_id, room_name, pane_title, agent_label, task_title, final_response,
            completed_at, status, available_at, created_at, updated_at
          )
          SELECT
            $1, i.generation, $2, 'TERMINAL',
            r.id, p.id, NULL, r.name, p.title,
            'Agent ' || (
              SELECT count(*)::text
              FROM panes AS numbered_pane
              WHERE numbered_pane.room_id = p.room_id
                AND (numbered_pane.is_closed = false OR numbered_pane.id = p.id)
                AND (
                  numbered_pane.pane_order < p.pane_order
                  OR (numbered_pane.pane_order = p.pane_order AND numbered_pane.id <= p.id)
                )
            ),
            p.title, $3,
            $4, 'PENDING', $4, $4, $4
          FROM telegram_integrations i
          JOIN rooms r ON r.id = $5
          JOIN panes p ON p.id = $6
          WHERE i.id = 'global' AND i.connection_status = 'CONNECTED' AND i.is_enabled = true
            AND i.enabled_at IS NOT NULL AND $4 >= i.enabled_at
            AND char_length($3) > 0
          ON CONFLICT (source_key) DO NOTHING
        `,
        [
          makeSpaceId("telegram_delivery"),
          `codex_cli_marker:${current.markerId}`,
          input.finalResponse,
          input.completedAt,
          current.roomId,
          current.paneId
        ]
      );
      const updated = await client.query<CodexCliTurnMarkerRow>(
        `
          UPDATE codex_cli_turn_markers
          SET status = 'COMPLETED', codex_thread_id = $2, rollout_path = $3,
              completion_event_id = $4, completed_at = $5,
              locked_at = NULL, locked_by = NULL, safe_error_code = NULL, updated_at = $5
          WHERE marker_id = $1
          RETURNING
            marker_id AS "markerId", session_id AS "sessionId", room_id AS "roomId", pane_id AS "paneId",
            client_turn_marker AS "clientTurnMarker", status, codex_thread_id AS "codexThreadId",
            rollout_path AS "rolloutPath", completion_event_id AS "completionEventId",
            submitted_at AS "submittedAt", completed_at AS "completedAt", next_check_at AS "nextCheckAt",
            check_attempt_count AS "checkAttemptCount", locked_at AS "lockedAt", locked_by AS "lockedBy",
            safe_error_code AS "safeErrorCode", updated_at AS "updatedAt"
        `,
        [input.markerId, input.codexThreadId, input.rolloutPath, event.id, input.completedAt]
      );
      return mapCodexCliTurnMarker(
        firstOrNotFound(updated.rows, `Codex CLI turn marker ${input.markerId} was not completed.`)
      );
    });
  }

  async finishCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    status: "IGNORED" | "FAILED";
    safeErrorCode: string;
    now: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE codex_cli_turn_markers
        SET status = $3, locked_at = NULL, locked_by = NULL, safe_error_code = $4, updated_at = $5
        WHERE marker_id = $1 AND status = 'PROCESSING' AND locked_by = $2
      `,
      [input.markerId, input.workerId, input.status, input.safeErrorCode, input.now]
    );
  }

  async getActivePaneBrowserSession(paneId: string): Promise<PaneBrowserSession | null> {
    const result = await this.pool.query<PaneBrowserSessionRow>(
      `${paneBrowserSessionSelect} WHERE pane_id = $1 AND is_active = true LIMIT 1`,
      [paneId]
    );
    return result.rows[0] ? mapPaneBrowserSession(result.rows[0]) : null;
  }

  async getPaneBrowserSession(sessionId: string): Promise<PaneBrowserSession | null> {
    const result = await this.pool.query<PaneBrowserSessionRow>(`${paneBrowserSessionSelect} WHERE session_id = $1`, [sessionId]);
    return result.rows[0] ? mapPaneBrowserSession(result.rows[0]) : null;
  }

  async getLatestPaneBrowserSession(paneId: string): Promise<PaneBrowserSession | null> {
    const result = await this.pool.query<PaneBrowserSessionRow>(
      `${paneBrowserSessionSelect} WHERE pane_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [paneId]
    );
    return result.rows[0] ? mapPaneBrowserSession(result.rows[0]) : null;
  }

  async listActivePaneBrowserSessions(roomId?: string): Promise<PaneBrowserSession[]> {
    const result = await this.pool.query<PaneBrowserSessionRow>(
      `${paneBrowserSessionSelect} WHERE is_active = true AND ($1::text IS NULL OR room_id = $1) ORDER BY started_at ASC`,
      [roomId ?? null]
    );
    return result.rows.map(mapPaneBrowserSession);
  }

  async createPaneBrowserSession(input: CreatePaneBrowserSessionInput, _traceId = makeSpaceId("trace")): Promise<PaneBrowserSession> {
    const parsed = createPaneBrowserSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const pane = await this.getPaneForUpdate(client, parsed.paneId);
      if (pane.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
      }
      if (pane.mode !== "BROWSER" && pane.mode !== "YOUTUBE") {
        throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; browser sessions require BROWSER or YOUTUBE panes.`);
      }
      if (pane.isClosed) {
        throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
      }
      const timestamp = nowIso();
      const sessionId = parsed.sessionId ?? makeSpaceId("browser_session");
      const isActive = parsed.isActive ?? true;
      if (isActive) {
        await client.query(
          `
            UPDATE pane_browser_sessions
            SET is_active = false, status = 'CLOSED', updated_at = $2, ended_at = $2
            WHERE pane_id = $1 AND is_active = true
          `,
          [parsed.paneId, timestamp]
        );
      }
      const result = await client.query<PaneBrowserSessionRow>(
        `
          INSERT INTO pane_browser_sessions (
            session_id,
            pane_id,
            room_id,
            owner_agent_id,
            agent_number,
            profile_id,
            profile_path,
            viewport,
            target_url,
            current_url,
            title,
            status,
            status_reason,
            last_frame_at,
            stream_mode,
            resolved_stream_mode,
            runtime_state,
            capacity_state,
            control_state,
            pages,
            active_page_id,
            worker_heartbeat_at,
            queue_position,
            is_active,
            started_at,
            updated_at,
            ended_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $24, NULL
          )
          ON CONFLICT (session_id)
          DO UPDATE SET
            pane_id = EXCLUDED.pane_id,
            room_id = EXCLUDED.room_id,
            owner_agent_id = EXCLUDED.owner_agent_id,
            agent_number = EXCLUDED.agent_number,
            profile_id = EXCLUDED.profile_id,
            profile_path = EXCLUDED.profile_path,
            viewport = EXCLUDED.viewport,
            target_url = EXCLUDED.target_url,
            current_url = EXCLUDED.current_url,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            status_reason = EXCLUDED.status_reason,
            stream_mode = EXCLUDED.stream_mode,
            resolved_stream_mode = EXCLUDED.resolved_stream_mode,
            runtime_state = EXCLUDED.runtime_state,
            capacity_state = EXCLUDED.capacity_state,
            control_state = EXCLUDED.control_state,
            pages = EXCLUDED.pages,
            active_page_id = EXCLUDED.active_page_id,
            worker_heartbeat_at = EXCLUDED.worker_heartbeat_at,
            queue_position = EXCLUDED.queue_position,
            is_active = EXCLUDED.is_active,
            updated_at = EXCLUDED.updated_at,
            ended_at = EXCLUDED.ended_at
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            owner_agent_id AS "ownerAgentId",
            agent_number AS "agentNumber",
            profile_id AS "profileId",
            profile_path AS "profilePath",
            viewport,
            target_url AS "targetUrl",
            current_url AS "currentUrl",
            title,
            status,
            status_reason AS "statusReason",
            last_frame_at AS "lastFrameAt",
            stream_mode AS "streamMode",
            resolved_stream_mode AS "resolvedStreamMode",
            runtime_state AS "runtimeState",
            capacity_state AS "capacityState",
            control_state AS "controlState",
            pages,
            active_page_id AS "activePageId",
            worker_heartbeat_at AS "workerHeartbeatAt",
            queue_position AS "queuePosition",
            restore_scroll_x AS "restoreScrollX",
            restore_scroll_y AS "restoreScrollY",
            restore_video_paused AS "restoreVideoPaused",
            is_active AS "isActive",
            started_at AS "startedAt",
            updated_at AS "updatedAt",
            ended_at AS "endedAt"
        `,
        [
          sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.ownerAgentId ?? null,
          parsed.agentNumber,
          parsed.profileId,
          parsed.profilePath,
          parsed.viewport,
          parsed.targetUrl ?? null,
          parsed.currentUrl ?? null,
          parsed.title ?? null,
          parsed.status ?? "STARTING",
          parsed.statusReason ?? null,
          parsed.streamMode ?? "AUTO",
          parsed.resolvedStreamMode ?? "PREVIEW",
          parsed.runtimeState ?? "STARTING",
          parsed.capacityState ?? "AVAILABLE",
          parsed.controlState ?? "UNCONTROLLED",
          JSON.stringify(parsed.pages ?? []),
          parsed.activePageId ?? null,
          parsed.workerHeartbeatAt ?? null,
          parsed.queuePosition ?? null,
          isActive,
          timestamp
        ]
      );
      return mapPaneBrowserSession(firstOrNotFound(result.rows, `Browser session ${sessionId} was not stored.`));
    });
  }

  async updatePaneBrowserSession(
    sessionId: string,
    input: UpdatePaneBrowserSessionInput,
    _traceId = makeSpaceId("trace")
  ): Promise<PaneBrowserSession> {
    const parsed = updatePaneBrowserSessionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<PaneBrowserSessionRow>(
        `${paneBrowserSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [sessionId]
      );
      const current = mapPaneBrowserSession(firstOrNotFound(currentResult.rows, `Browser session ${sessionId} was not found.`));
      const timestamp = nowIso();
      const terminal = parsed.status === "CLOSED" || parsed.status === "ERROR";
      const isActive = parsed.isActive === undefined ? current.isActive : parsed.isActive;
      if (isActive) {
        await client.query(
          `
            UPDATE pane_browser_sessions
            SET is_active = false, status = 'CLOSED', updated_at = $3, ended_at = $3
            WHERE pane_id = $1 AND session_id <> $2 AND is_active = true
          `,
          [current.paneId, sessionId, timestamp]
        );
      }
      const result = await client.query<PaneBrowserSessionRow>(
        `
          UPDATE pane_browser_sessions
          SET viewport = $2,
              target_url = $3,
              current_url = $4,
              title = $5,
              status = $6,
              status_reason = $7,
              last_frame_at = $8,
              stream_mode = $9,
              resolved_stream_mode = $10,
              runtime_state = $11,
              capacity_state = $12,
              control_state = $13,
              pages = $14,
              active_page_id = $15,
              worker_heartbeat_at = $16,
              queue_position = $17,
              restore_scroll_x = $18,
              restore_scroll_y = $19,
              restore_video_paused = $20,
              is_active = $21,
              updated_at = $22,
              ended_at = $23
          WHERE session_id = $1
          RETURNING
            session_id AS "sessionId",
            pane_id AS "paneId",
            room_id AS "roomId",
            owner_agent_id AS "ownerAgentId",
            agent_number AS "agentNumber",
            profile_id AS "profileId",
            profile_path AS "profilePath",
            viewport,
            target_url AS "targetUrl",
            current_url AS "currentUrl",
            title,
            status,
            status_reason AS "statusReason",
            last_frame_at AS "lastFrameAt",
            stream_mode AS "streamMode",
            resolved_stream_mode AS "resolvedStreamMode",
            runtime_state AS "runtimeState",
            capacity_state AS "capacityState",
            control_state AS "controlState",
            pages,
            active_page_id AS "activePageId",
            worker_heartbeat_at AS "workerHeartbeatAt",
            queue_position AS "queuePosition",
            restore_scroll_x AS "restoreScrollX",
            restore_scroll_y AS "restoreScrollY",
            restore_video_paused AS "restoreVideoPaused",
            is_active AS "isActive",
            started_at AS "startedAt",
            updated_at AS "updatedAt",
            ended_at AS "endedAt"
        `,
        [
          sessionId,
          parsed.viewport ?? current.viewport,
          parsed.targetUrl === undefined ? current.targetUrl : parsed.targetUrl,
          parsed.currentUrl === undefined ? current.currentUrl : parsed.currentUrl,
          parsed.title === undefined ? current.title : parsed.title,
          parsed.status ?? current.status,
          parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
          parsed.lastFrameAt === undefined ? current.lastFrameAt : parsed.lastFrameAt,
          parsed.streamMode ?? current.streamMode,
          parsed.resolvedStreamMode ?? current.resolvedStreamMode,
          parsed.runtimeState ?? current.runtimeState,
          parsed.capacityState ?? current.capacityState,
          parsed.controlState ?? current.controlState,
          JSON.stringify(parsed.pages ?? current.pages),
          parsed.activePageId === undefined ? current.activePageId : parsed.activePageId,
          parsed.workerHeartbeatAt === undefined ? current.workerHeartbeatAt : parsed.workerHeartbeatAt,
          parsed.queuePosition === undefined ? current.queuePosition : parsed.queuePosition,
          parsed.restoreScrollX === undefined ? current.restoreScrollX : parsed.restoreScrollX,
          parsed.restoreScrollY === undefined ? current.restoreScrollY : parsed.restoreScrollY,
          parsed.restoreVideoPaused === undefined ? current.restoreVideoPaused : parsed.restoreVideoPaused,
          isActive,
          timestamp,
          parsed.endedAt === undefined ? (terminal ? timestamp : current.endedAt) : parsed.endedAt
        ]
      );
      return mapPaneBrowserSession(firstOrNotFound(result.rows, `Browser session ${sessionId} was not updated.`));
    });
  }

  async getActiveBrowserControlLease(sessionId: string): Promise<BrowserControlLease | null> {
    const result = await this.pool.query<BrowserControlLeaseRow>(
      `${browserControlLeaseSelect} WHERE session_id = $1 AND status = 'ACTIVE' AND expires_at > $2 LIMIT 1`,
      [sessionId, nowIso()]
    );
    return result.rows[0] ? mapBrowserControlLease(result.rows[0]) : null;
  }

  async getBrowserControlLease(leaseId: string): Promise<BrowserControlLease | null> {
    const result = await this.pool.query<BrowserControlLeaseRow>(`${browserControlLeaseSelect} WHERE lease_id = $1`, [leaseId]);
    return result.rows[0] ? mapBrowserControlLease(result.rows[0]) : null;
  }

  async createBrowserControlLease(input: CreateBrowserControlLeaseInput): Promise<BrowserControlLease> {
    const parsed = createBrowserControlLeaseInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneBrowserSessionRow>(
        `${paneBrowserSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [parsed.sessionId]
      );
      const session = mapPaneBrowserSession(
        firstOrNotFound(sessionResult.rows, `Browser session ${parsed.sessionId} was not found.`)
      );
      if (session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
      }
      const timestamp = nowIso();
      await client.query(
        `
          UPDATE browser_control_leases
          SET status = CASE WHEN expires_at <= $2 THEN 'EXPIRED' ELSE 'REVOKED' END,
              released_at = $2
          WHERE session_id = $1 AND status = 'ACTIVE'
        `,
        [parsed.sessionId, timestamp]
      );
      const leaseId = parsed.leaseId ?? makeSpaceId("browser_lease");
      const expiresAt = new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString();
      const result = await client.query<BrowserControlLeaseRow>(
        `
          INSERT INTO browser_control_leases (
            lease_id, session_id, pane_id, room_id, holder_type, holder_id, status, reason,
            acquired_at, heartbeat_at, expires_at, released_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $8, $9, NULL)
          RETURNING
            lease_id AS "leaseId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            holder_type AS "holderType", holder_id AS "holderId", status, reason,
            acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt", expires_at AS "expiresAt",
            released_at AS "releasedAt"
        `,
        [
          leaseId,
          parsed.sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.holderType,
          parsed.holderId,
          parsed.reason ?? null,
          timestamp,
          expiresAt
        ]
      );
      await client.query(
        "UPDATE pane_browser_sessions SET control_state = $2, updated_at = $3 WHERE session_id = $1",
        [parsed.sessionId, parsed.holderType === "OPERATOR" ? "OPERATOR" : "AGENT", timestamp]
      );
      return mapBrowserControlLease(firstOrNotFound(result.rows, `Browser control lease ${leaseId} was not stored.`));
    });
  }

  async updateBrowserControlLease(
    leaseId: string,
    input: UpdateBrowserControlLeaseInput
  ): Promise<BrowserControlLease> {
    const parsed = updateBrowserControlLeaseInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<BrowserControlLeaseRow>(
        `${browserControlLeaseSelect} WHERE lease_id = $1 FOR UPDATE`,
        [leaseId]
      );
      const current = mapBrowserControlLease(
        firstOrNotFound(currentResult.rows, `Browser control lease ${leaseId} was not found.`)
      );
      const timestamp = nowIso();
      const status = parsed.status ?? current.status;
      const isTerminal = status !== "ACTIVE";
      const result = await client.query<BrowserControlLeaseRow>(
        `
          UPDATE browser_control_leases
          SET status = $2,
              reason = $3,
              heartbeat_at = $4,
              expires_at = $5,
              released_at = $6
          WHERE lease_id = $1
          RETURNING
            lease_id AS "leaseId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            holder_type AS "holderType", holder_id AS "holderId", status, reason,
            acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt", expires_at AS "expiresAt",
            released_at AS "releasedAt"
        `,
        [
          leaseId,
          status,
          parsed.reason === undefined ? current.reason : parsed.reason,
          parsed.ttlSeconds === undefined ? current.heartbeatAt : timestamp,
          parsed.ttlSeconds === undefined
            ? current.expiresAt
            : new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString(),
          isTerminal ? current.releasedAt ?? timestamp : null
        ]
      );
      if (isTerminal) {
        await client.query(
          `
            UPDATE pane_browser_sessions
            SET control_state = 'UNCONTROLLED', updated_at = $2
            WHERE session_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM browser_control_leases
                WHERE session_id = $1 AND status = 'ACTIVE' AND lease_id <> $3
              )
          `,
          [current.sessionId, timestamp, leaseId]
        );
      }
      return mapBrowserControlLease(firstOrNotFound(result.rows, `Browser control lease ${leaseId} was not updated.`));
    });
  }

  async getBrowserCaptureJob(jobId: string): Promise<BrowserCaptureJob | null> {
    const result = await this.pool.query<BrowserCaptureJobRow>(`${browserCaptureJobSelect} WHERE job_id = $1`, [jobId]);
    return result.rows[0] ? mapBrowserCaptureJob(result.rows[0]) : null;
  }

  async listBrowserCaptureJobs(sessionId: string): Promise<BrowserCaptureJob[]> {
    const result = await this.pool.query<BrowserCaptureJobRow>(
      `${browserCaptureJobSelect} WHERE session_id = $1 ORDER BY queued_at DESC`,
      [sessionId]
    );
    return result.rows.map(mapBrowserCaptureJob);
  }

  async getBrowserCaptureMetrics() {
    type MetricRow = { status: string; count: string | number };
    const [jobResult, segmentResult] = await Promise.all([
      this.pool.query<MetricRow>(
        `
          SELECT job.status, COUNT(*)::integer AS count
          FROM browser_capture_jobs job
          INNER JOIN pane_browser_sessions browser_session ON browser_session.session_id = job.session_id
          WHERE browser_session.is_active = true
          GROUP BY job.status
        `
      ),
      this.pool.query<MetricRow>(
        `
          SELECT segment.status, COUNT(*)::integer AS count
          FROM browser_capture_segments segment
          INNER JOIN browser_capture_jobs job ON job.job_id = segment.job_id
          INNER JOIN pane_browser_sessions browser_session ON browser_session.session_id = job.session_id
          WHERE browser_session.is_active = true
          GROUP BY segment.status
        `
      )
    ]);
    const metrics = {
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
    };
    for (const row of jobResult.rows) {
      if (row.status in metrics.jobs) metrics.jobs[row.status as keyof typeof metrics.jobs] = Number(row.count);
    }
    for (const row of segmentResult.rows) {
      if (row.status in metrics.segments) metrics.segments[row.status as keyof typeof metrics.segments] = Number(row.count);
    }
    return metrics;
  }

  async createBrowserCaptureJob(input: CreateBrowserCaptureJobInput): Promise<BrowserCaptureJob> {
    const parsed = createBrowserCaptureJobInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneBrowserSessionRow>(
        `${paneBrowserSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [parsed.sessionId]
      );
      const session = mapPaneBrowserSession(
        firstOrNotFound(sessionResult.rows, `Browser session ${parsed.sessionId} was not found.`)
      );
      if (session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
      }
      const jobId = parsed.jobId ?? makeSpaceId("browser_capture");
      const timestamp = nowIso();
      const result = await client.query<BrowserCaptureJobRow>(
        `
          INSERT INTO browser_capture_jobs (
            job_id, session_id, pane_id, room_id, requested_by_type, requested_by_id, status,
            capture_options, progress_percent, status_reason, artifact_ids, queued_at, started_at, updated_at, completed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', $7, 0, NULL, '[]'::jsonb, $8, NULL, $8, NULL)
          RETURNING
            job_id AS "jobId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            requested_by_type AS "requestedByType", requested_by_id AS "requestedById", status,
            capture_options AS options, progress_percent AS "progressPercent", status_reason AS "statusReason",
            artifact_ids AS "artifactIds", queued_at AS "queuedAt", started_at AS "startedAt",
            updated_at AS "updatedAt", completed_at AS "completedAt"
        `,
        [
          jobId,
          parsed.sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.requestedByType,
          parsed.requestedById,
          JSON.stringify(parsed.options),
          timestamp
        ]
      );
      return mapBrowserCaptureJob(firstOrNotFound(result.rows, `Browser capture job ${jobId} was not stored.`));
    });
  }

  async updateBrowserCaptureJob(jobId: string, input: UpdateBrowserCaptureJobInput): Promise<BrowserCaptureJob> {
    const parsed = updateBrowserCaptureJobInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<BrowserCaptureJobRow>(
        `${browserCaptureJobSelect} WHERE job_id = $1 FOR UPDATE`,
        [jobId]
      );
      const current = mapBrowserCaptureJob(
        firstOrNotFound(currentResult.rows, `Browser capture job ${jobId} was not found.`)
      );
      const timestamp = nowIso();
      const status = parsed.status ?? current.status;
      const isTerminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
      const result = await client.query<BrowserCaptureJobRow>(
        `
          UPDATE browser_capture_jobs
          SET status = $2,
              progress_percent = $3,
              status_reason = $4,
              artifact_ids = $5,
              started_at = $6,
              updated_at = $7,
              completed_at = $8
          WHERE job_id = $1
          RETURNING
            job_id AS "jobId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            requested_by_type AS "requestedByType", requested_by_id AS "requestedById", status,
            capture_options AS options, progress_percent AS "progressPercent", status_reason AS "statusReason",
            artifact_ids AS "artifactIds", queued_at AS "queuedAt", started_at AS "startedAt",
            updated_at AS "updatedAt", completed_at AS "completedAt"
        `,
        [
          jobId,
          status,
          parsed.progressPercent ?? (status === "COMPLETED" ? 100 : current.progressPercent),
          parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
          JSON.stringify(parsed.artifactIds === undefined ? current.artifactIds : Array.from(new Set(parsed.artifactIds))),
          parsed.startedAt === undefined ? (status === "RUNNING" ? current.startedAt ?? timestamp : current.startedAt) : parsed.startedAt,
          timestamp,
          parsed.completedAt === undefined ? (isTerminal ? current.completedAt ?? timestamp : current.completedAt) : parsed.completedAt
        ]
      );
      return mapBrowserCaptureJob(firstOrNotFound(result.rows, `Browser capture job ${jobId} was not updated.`));
    });
  }

  async getBrowserCaptureSegment(segmentId: string): Promise<BrowserCaptureSegment | null> {
    const result = await this.pool.query<BrowserCaptureSegmentRow>(
      `${browserCaptureSegmentSelect} WHERE segment_id = $1`,
      [segmentId]
    );
    return result.rows[0] ? mapBrowserCaptureSegment(result.rows[0]) : null;
  }

  async listBrowserCaptureSegments(jobId: string): Promise<BrowserCaptureSegment[]> {
    const result = await this.pool.query<BrowserCaptureSegmentRow>(
      `${browserCaptureSegmentSelect} WHERE job_id = $1 ORDER BY segment_sequence ASC`,
      [jobId]
    );
    return result.rows.map(mapBrowserCaptureSegment);
  }

  async createBrowserCaptureSegment(input: CreateBrowserCaptureSegmentInput): Promise<BrowserCaptureSegment> {
    const parsed = createBrowserCaptureSegmentInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const jobResult = await client.query<BrowserCaptureJobRow>(
        `${browserCaptureJobSelect} WHERE job_id = $1 FOR UPDATE`,
        [parsed.jobId]
      );
      const job = mapBrowserCaptureJob(
        firstOrNotFound(jobResult.rows, `Browser capture job ${parsed.jobId} was not found.`)
      );
      if (job.sessionId !== parsed.sessionId) {
        throw new SpaceNotFoundError(`Browser capture job ${parsed.jobId} was not found.`);
      }
      if (job.options.kind !== "RECORDING") {
        throw new SpaceConflictError(`Browser capture job ${parsed.jobId} does not support recording segments.`);
      }
      const sequenceResult = await client.query<{ nextSequence: number | string }>(
        "SELECT COALESCE(MAX(segment_sequence), -1) + 1 AS \"nextSequence\" FROM browser_capture_segments WHERE job_id = $1",
        [parsed.jobId]
      );
      const sequence = parsed.sequence ?? Number(sequenceResult.rows[0]?.nextSequence ?? 0);
      const segmentId = parsed.segmentId ?? makeSpaceId("browser_segment");
      const timestamp = nowIso();
      const result = await client.query<BrowserCaptureSegmentRow>(
        `
          INSERT INTO browser_capture_segments (
            segment_id, job_id, session_id, segment_sequence, status, artifact_id, storage_uri, sha256,
            byte_size, duration_ms, frame_count, last_frame_sequence, status_reason, started_at, updated_at, finalized_at
          )
          VALUES ($1, $2, $3, $4, 'OPEN', NULL, NULL, NULL, 0, 0, 0, NULL, NULL, $5, $5, NULL)
          RETURNING
            segment_id AS "segmentId", job_id AS "jobId", session_id AS "sessionId", segment_sequence AS sequence,
            status, artifact_id AS "artifactId", storage_uri AS "storageUri", sha256, byte_size AS "byteSize",
            duration_ms AS "durationMs", frame_count AS "frameCount", last_frame_sequence AS "lastFrameSequence",
            status_reason AS "statusReason", started_at AS "startedAt", updated_at AS "updatedAt",
            finalized_at AS "finalizedAt"
        `,
        [segmentId, parsed.jobId, parsed.sessionId, sequence, timestamp]
      );
      return mapBrowserCaptureSegment(
        firstOrNotFound(result.rows, `Browser capture segment ${segmentId} was not stored.`)
      );
    });
  }

  async updateBrowserCaptureSegment(
    segmentId: string,
    input: UpdateBrowserCaptureSegmentInput
  ): Promise<BrowserCaptureSegment> {
    const parsed = updateBrowserCaptureSegmentInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<BrowserCaptureSegmentRow>(
        `${browserCaptureSegmentSelect} WHERE segment_id = $1 FOR UPDATE`,
        [segmentId]
      );
      const current = mapBrowserCaptureSegment(
        firstOrNotFound(currentResult.rows, `Browser capture segment ${segmentId} was not found.`)
      );
      const status = parsed.status ?? current.status;
      if (current.status !== "OPEN" && status !== current.status && !(current.status === "FINALIZED" && status === "DISCARDED")) {
        throw new SpaceConflictError(`Browser capture segment cannot transition from ${current.status} to ${status}.`);
      }
      const timestamp = nowIso();
      const isTerminal = status !== "OPEN";
      const result = await client.query<BrowserCaptureSegmentRow>(
        `
          UPDATE browser_capture_segments
          SET status = $2,
              artifact_id = $3,
              storage_uri = $4,
              sha256 = $5,
              byte_size = $6,
              duration_ms = $7,
              frame_count = $8,
              last_frame_sequence = $9,
              status_reason = $10,
              updated_at = $11,
              finalized_at = $12
          WHERE segment_id = $1
          RETURNING
            segment_id AS "segmentId", job_id AS "jobId", session_id AS "sessionId", segment_sequence AS sequence,
            status, artifact_id AS "artifactId", storage_uri AS "storageUri", sha256, byte_size AS "byteSize",
            duration_ms AS "durationMs", frame_count AS "frameCount", last_frame_sequence AS "lastFrameSequence",
            status_reason AS "statusReason", started_at AS "startedAt", updated_at AS "updatedAt",
            finalized_at AS "finalizedAt"
        `,
        [
          segmentId,
          status,
          parsed.artifactId === undefined ? current.artifactId : parsed.artifactId,
          parsed.storageUri === undefined ? current.storageUri : parsed.storageUri,
          parsed.sha256 === undefined ? current.sha256 : parsed.sha256,
          parsed.byteSize ?? current.byteSize,
          parsed.durationMs ?? current.durationMs,
          parsed.frameCount ?? current.frameCount,
          parsed.lastFrameSequence === undefined ? current.lastFrameSequence : parsed.lastFrameSequence,
          parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
          timestamp,
          parsed.finalizedAt === undefined ? (isTerminal ? current.finalizedAt ?? timestamp : null) : parsed.finalizedAt
        ]
      );
      return mapBrowserCaptureSegment(
        firstOrNotFound(result.rows, `Browser capture segment ${segmentId} was not updated.`)
      );
    });
  }

  async getActiveBrowserHandoffRequest(sessionId: string): Promise<BrowserHandoffRequest | null> {
    const result = await this.pool.query<BrowserHandoffRequestRow>(
      `${browserHandoffRequestSelect} WHERE session_id = $1 AND status IN ('REQUESTED', 'ACCEPTED') AND expires_at > $2 LIMIT 1`,
      [sessionId, nowIso()]
    );
    return result.rows[0] ? mapBrowserHandoffRequest(result.rows[0]) : null;
  }

  async getBrowserHandoffRequest(handoffRequestId: string): Promise<BrowserHandoffRequest | null> {
    const result = await this.pool.query<BrowserHandoffRequestRow>(
      `${browserHandoffRequestSelect} WHERE handoff_request_id = $1`,
      [handoffRequestId]
    );
    return result.rows[0] ? mapBrowserHandoffRequest(result.rows[0]) : null;
  }

  async listBrowserHandoffRequests(roomId?: string): Promise<BrowserHandoffRequest[]> {
    const result = await this.pool.query<BrowserHandoffRequestRow>(
      `${browserHandoffRequestSelect} WHERE ($1::text IS NULL OR room_id = $1) ORDER BY requested_at DESC`,
      [roomId ?? null]
    );
    return result.rows.map(mapBrowserHandoffRequest);
  }

  async createBrowserHandoffRequest(input: CreateBrowserHandoffRequestInput): Promise<BrowserHandoffRequest> {
    const parsed = createBrowserHandoffRequestInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const sessionResult = await client.query<PaneBrowserSessionRow>(
        `${paneBrowserSessionSelect} WHERE session_id = $1 FOR UPDATE`,
        [parsed.sessionId]
      );
      const session = mapPaneBrowserSession(
        firstOrNotFound(sessionResult.rows, `Browser session ${parsed.sessionId} was not found.`)
      );
      if (session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
        throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
      }
      const timestamp = nowIso();
      await client.query(
        `
          UPDATE browser_handoff_requests
          SET status = 'EXPIRED', expired_at = $2, updated_at = $2
          WHERE session_id = $1 AND status IN ('REQUESTED', 'ACCEPTED') AND expires_at <= $2
        `,
        [parsed.sessionId, timestamp]
      );
      const activeResult = await client.query<{ handoffRequestId: string }>(
        `
          SELECT handoff_request_id AS "handoffRequestId"
          FROM browser_handoff_requests
          WHERE session_id = $1 AND status IN ('REQUESTED', 'ACCEPTED')
          LIMIT 1
        `,
        [parsed.sessionId]
      );
      if (activeResult.rows[0]) {
        throw new SpaceConflictError(`Browser session ${parsed.sessionId} already has an active handoff request.`);
      }
      const handoffRequestId = parsed.handoffRequestId ?? makeSpaceId("browser_handoff");
      const expiresAt = new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString();
      const result = await client.query<BrowserHandoffRequestRow>(
        `
          INSERT INTO browser_handoff_requests (
            handoff_request_id, session_id, pane_id, room_id, requested_by_type, requested_by_id, reason, status,
            operator_user_id, operator_email, operator_role, control_lease_id, requested_at, expires_at,
            accepted_at, completed_at, expired_at, cancelled_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'REQUESTED', NULL, NULL, NULL, NULL, $8, $9, NULL, NULL, NULL, NULL, $8)
          RETURNING
            handoff_request_id AS "handoffRequestId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            requested_by_type AS "requestedByType", requested_by_id AS "requestedById", reason, status,
            operator_user_id AS "operatorUserId", operator_email AS "operatorEmail", operator_role AS "operatorRole",
            control_lease_id AS "controlLeaseId", requested_at AS "requestedAt", expires_at AS "expiresAt",
            accepted_at AS "acceptedAt", completed_at AS "completedAt", expired_at AS "expiredAt",
            cancelled_at AS "cancelledAt", updated_at AS "updatedAt"
        `,
        [
          handoffRequestId,
          parsed.sessionId,
          parsed.paneId,
          parsed.roomId,
          parsed.requestedByType,
          parsed.requestedById,
          parsed.reason,
          timestamp,
          expiresAt
        ]
      );
      const handoff = mapBrowserHandoffRequest(
        firstOrNotFound(result.rows, `Browser handoff request ${handoffRequestId} was not stored.`)
      );
      await this.appendEvent(client, {
        roomId: handoff.roomId,
        paneId: handoff.paneId,
        turnId: null,
        traceId: handoff.handoffRequestId,
        type: "BROWSER_HANDOFF_REQUESTED",
        message: "Browser session requires operator control.",
        payload: {
          handoffRequestId: handoff.handoffRequestId,
          browserSessionId: handoff.sessionId,
          status: handoff.status
        }
      });
      return handoff;
    });
  }

  async updateBrowserHandoffRequest(
    handoffRequestId: string,
    input: UpdateBrowserHandoffRequestInput
  ): Promise<BrowserHandoffRequest> {
    const parsed = updateBrowserHandoffRequestInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<BrowserHandoffRequestRow>(
        `${browserHandoffRequestSelect} WHERE handoff_request_id = $1 FOR UPDATE`,
        [handoffRequestId]
      );
      const current = mapBrowserHandoffRequest(
        firstOrNotFound(currentResult.rows, `Browser handoff request ${handoffRequestId} was not found.`)
      );
      assertBrowserHandoffTransition(current.status, parsed.status);
      if (parsed.status === "ACCEPTED") {
        const operatorResult = await client.query<AuthUser>(
          "SELECT id, email, role FROM users WHERE id = $1",
          [parsed.operatorUserId]
        );
        const operator = operatorResult.rows[0];
        if (!operator) {
          throw new SpaceNotFoundError(`Authenticated operator ${parsed.operatorUserId ?? "unknown"} was not found.`);
        }
        if (operator.email !== parsed.operatorEmail || operator.role !== parsed.operatorRole) {
          throw new SpaceConflictError("Browser handoff operator identity does not match the authenticated user.");
        }
      }
      if (parsed.controlLeaseId) {
        const leaseResult = await client.query<{ leaseId: string }>(
          "SELECT lease_id AS \"leaseId\" FROM browser_control_leases WHERE lease_id = $1 AND session_id = $2",
          [parsed.controlLeaseId, current.sessionId]
        );
        if (!leaseResult.rows[0]) {
          throw new SpaceNotFoundError(`Browser control lease ${parsed.controlLeaseId} was not found.`);
        }
      }
      const timestamp = nowIso();
      const result = await client.query<BrowserHandoffRequestRow>(
        `
          UPDATE browser_handoff_requests
          SET status = $2,
              reason = $3,
              operator_user_id = $4,
              operator_email = $5,
              operator_role = $6,
              control_lease_id = $7,
              accepted_at = $8,
              completed_at = $9,
              expired_at = $10,
              cancelled_at = $11,
              updated_at = $12
          WHERE handoff_request_id = $1
          RETURNING
            handoff_request_id AS "handoffRequestId", session_id AS "sessionId", pane_id AS "paneId", room_id AS "roomId",
            requested_by_type AS "requestedByType", requested_by_id AS "requestedById", reason, status,
            operator_user_id AS "operatorUserId", operator_email AS "operatorEmail", operator_role AS "operatorRole",
            control_lease_id AS "controlLeaseId", requested_at AS "requestedAt", expires_at AS "expiresAt",
            accepted_at AS "acceptedAt", completed_at AS "completedAt", expired_at AS "expiredAt",
            cancelled_at AS "cancelledAt", updated_at AS "updatedAt"
        `,
        [
          handoffRequestId,
          parsed.status,
          parsed.reason ?? current.reason,
          parsed.operatorUserId ?? current.operatorUserId,
          parsed.operatorEmail ?? current.operatorEmail,
          parsed.operatorRole ?? current.operatorRole,
          parsed.controlLeaseId === undefined ? current.controlLeaseId : parsed.controlLeaseId,
          parsed.status === "ACCEPTED" ? current.acceptedAt ?? timestamp : current.acceptedAt,
          parsed.status === "COMPLETED" ? current.completedAt ?? timestamp : current.completedAt,
          parsed.status === "EXPIRED" ? current.expiredAt ?? timestamp : current.expiredAt,
          parsed.status === "CANCELLED" ? current.cancelledAt ?? timestamp : current.cancelledAt,
          timestamp
        ]
      );
      return mapBrowserHandoffRequest(
        firstOrNotFound(result.rows, `Browser handoff request ${handoffRequestId} was not updated.`)
      );
    });
  }

  async recordTurnQueued(input: CreateQueuedTurnInput): Promise<QueuedTurnRecord> {
    return this.withTransaction(async (client) => {
      const room = await this.getRoomForUpdate(client, input.roomId);
      const pane = await this.getPaneForUpdate(client, input.paneId);
      if (pane.roomId !== room.id) {
        throw new SpaceNotFoundError(`Pane ${input.paneId} was not found.`);
      }

      const timestamp = nowIso();
      const workflowResult = await client.query<WorkflowRunRow>(
        `
          INSERT INTO workflows (
            workflow_id,
            run_id,
            type,
            task_queue,
            status,
            room_id,
            pane_id,
            trace_id,
            started_at,
            closed_at
          )
          VALUES ($1, $2, 'AGENT_TURN', $3, 'PENDING', $4, $5, $6, $7, NULL)
          RETURNING
            workflow_id AS "workflowId",
            run_id AS "runId",
            type,
            task_queue AS "taskQueue",
            status,
            room_id AS "roomId",
            pane_id AS "paneId",
            trace_id AS "traceId",
            started_at AS "startedAt",
            closed_at AS "closedAt"
        `,
        [input.workflowId, input.runId, input.taskQueue, input.roomId, input.paneId, input.traceId, timestamp]
      );
      const workflow = mapWorkflowRun(firstOrNotFound(workflowResult.rows, `Workflow ${input.workflowId} was not created.`));

      const turnId = makeSpaceId("turn");
      const turnResult = await client.query<TurnRow>(
        `
          INSERT INTO turns (
            id,
            room_id,
            pane_id,
            workflow_id,
            provider_id,
            model_id,
            status,
            prompt,
            prompt_hash,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', $7, $8, $9, $9)
          RETURNING
            id,
            room_id AS "roomId",
            pane_id AS "paneId",
            workflow_id AS "workflowId",
            provider_id AS "providerId",
            model_id AS "modelId",
            status,
            prompt,
            prompt_hash AS "promptHash",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          turnId,
          input.roomId,
          input.paneId,
          workflow.workflowId,
          input.providerId,
          input.modelId,
          input.prompt,
          hashPrompt(input.prompt),
          timestamp
        ]
      );
      const artifactIds = Array.from(new Set(input.artifactIds ?? []));
      if (artifactIds.length) {
        const linkedArtifacts = await client.query<{ id: string }>(
          `
            UPDATE artifacts
            SET turn_id = $1,
                workflow_id = $2
            WHERE id = ANY($3::text[])
            RETURNING id
          `,
          [turnId, workflow.workflowId, artifactIds]
        );
        if (linkedArtifacts.rowCount !== artifactIds.length) {
          const linkedIds = new Set(linkedArtifacts.rows.map((row) => row.id));
          const missingId = artifactIds.find((artifactId) => !linkedIds.has(artifactId)) ?? artifactIds[0];
          throw new SpaceNotFoundError(`Artifact ${missingId} was not found.`);
        }
      }
      const turn = { ...mapTurn(firstOrNotFound(turnResult.rows, `Turn ${turnId} was not created.`)), artifactIds };

      await client.query("UPDATE panes SET status = 'QUEUED', updated_at = $2 WHERE id = $1", [input.paneId, timestamp]);
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [input.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: input.roomId,
        paneId: input.paneId,
        turnId: turn.id,
        workflowId: workflow.workflowId,
        traceId: input.traceId,
        type: "TURN_STARTED",
        message: "Turn queued for Temporal workflow.",
        payload: {
          status: turn.status,
          runtime: input.runtime ?? "DUMMY_TEMPORAL",
          workflowId: workflow.workflowId,
          runId: workflow.runId,
          providerId: turn.providerId,
          modelId: turn.modelId,
          artifactIds,
          artifactCount: artifactIds.length
        }
      });

      return { turn, workflow, event };
    });
  }

  async recordWorkflowRunId(workflowId: string, runId: string | null): Promise<WorkflowRun> {
    const result = await this.pool.query<WorkflowRunRow>(
      `
        UPDATE workflows
        SET run_id = $2
        WHERE workflow_id = $1
        RETURNING
          workflow_id AS "workflowId",
          run_id AS "runId",
          type,
          task_queue AS "taskQueue",
          status,
          room_id AS "roomId",
          pane_id AS "paneId",
          trace_id AS "traceId",
          started_at AS "startedAt",
          closed_at AS "closedAt"
      `,
      [workflowId, runId]
    );
    return mapWorkflowRun(firstOrNotFound(result.rows, `Workflow ${workflowId} was not found.`));
  }

  async recordTurnCompleted(input: CompleteTurnInput): Promise<CompletedTurnRecord> {
    return this.withTransaction(async (client) => {
      const workflowResult = await client.query<WorkflowRunRow>(`${workflowRunSelect} WHERE workflow_id = $1 FOR UPDATE`, [
        input.workflowId
      ]);
      const currentWorkflow = mapWorkflowRun(firstOrNotFound(workflowResult.rows, `Workflow ${input.workflowId} was not found.`));

      const turnResult = await client.query<TurnRow>(`${turnSelect} WHERE workflow_id = $1 FOR UPDATE`, [input.workflowId]);
      const currentTurn = mapTurn(firstOrNotFound(turnResult.rows, `Turn for workflow ${input.workflowId} was not found.`));

      const timestamp = nowIso();
      const completedWorkflowResult = await client.query<WorkflowRunRow>(
        `
          UPDATE workflows
          SET status = 'COMPLETED',
              closed_at = $2
          WHERE workflow_id = $1
          RETURNING
            workflow_id AS "workflowId",
            run_id AS "runId",
            type,
            task_queue AS "taskQueue",
            status,
            room_id AS "roomId",
            pane_id AS "paneId",
            trace_id AS "traceId",
            started_at AS "startedAt",
            closed_at AS "closedAt"
        `,
        [input.workflowId, timestamp]
      );
      const workflow = mapWorkflowRun(
        firstOrNotFound(completedWorkflowResult.rows, `Workflow ${input.workflowId} was not completed.`)
      );

      const completedTurnResult = await client.query<TurnRow>(
        `
          UPDATE turns
          SET status = 'COMPLETED',
              updated_at = $2
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            pane_id AS "paneId",
            workflow_id AS "workflowId",
            provider_id AS "providerId",
            model_id AS "modelId",
            status,
            prompt,
            prompt_hash AS "promptHash",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [currentTurn.id, timestamp]
      );
      const turn = {
        ...mapTurn(firstOrNotFound(completedTurnResult.rows, `Turn ${currentTurn.id} was not completed.`)),
        artifactIds: currentTurn.artifactIds
      };

      if (turn.paneId) {
        await client.query("UPDATE panes SET status = 'COMPLETE', updated_at = $2 WHERE id = $1", [turn.paneId, timestamp]);
      }
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [turn.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: turn.roomId,
        paneId: turn.paneId,
        turnId: turn.id,
        workflowId: workflow.workflowId,
        traceId: input.traceId || currentWorkflow.traceId,
        type: "TURN_COMPLETED",
        message: input.message,
        payload: {
          status: turn.status,
          workflowId: workflow.workflowId,
          runId: workflow.runId,
          metadata: input.metadata ?? {}
        }
      });

      const finalResponse = codexFinalResponseFromMetadata(input.metadata);
      if (finalResponse) {
        await client.query(
          `
            INSERT INTO telegram_notification_outbox (
              delivery_id, integration_generation, source_key, source_type,
              room_id, pane_id, turn_id, room_name, pane_title, agent_label, task_title, final_response,
              completed_at, status, available_at, created_at, updated_at
            )
            SELECT
              $1, i.generation, $2, 'CHAT',
              r.id, p.id, $3, r.name, COALESCE(p.title, 'Codex Chat'),
              CASE
                WHEN p.id IS NULL THEN 'Agent 1'
                ELSE 'Agent ' || (
                  SELECT count(*)::text
                  FROM panes AS numbered_pane
                  WHERE numbered_pane.room_id = p.room_id
                    AND (numbered_pane.is_closed = false OR numbered_pane.id = p.id)
                    AND (
                      numbered_pane.pane_order < p.pane_order
                      OR (numbered_pane.pane_order = p.pane_order AND numbered_pane.id <= p.id)
                    )
                )
              END,
              COALESCE(p.title, 'Codex Chat'), $4,
              $5, 'PENDING', $5, $5, $5
            FROM telegram_integrations i
            JOIN rooms r ON r.id = $6
            LEFT JOIN panes p ON p.id = $7
            WHERE i.id = 'global' AND i.connection_status = 'CONNECTED' AND i.is_enabled = true
              AND i.enabled_at IS NOT NULL AND $5 >= i.enabled_at
            ON CONFLICT (source_key) DO NOTHING
          `,
          [
            makeSpaceId("telegram_delivery"),
            `turn:${turn.id}`,
            turn.id,
            finalResponse,
            timestamp,
            turn.roomId,
            turn.paneId
          ]
        );
      }

      return { turn, workflow, event };
    });
  }

  async recordTurnFailed(input: FailTurnInput): Promise<FailedTurnRecord> {
    return this.withTransaction(async (client) => {
      const workflowResult = await client.query<WorkflowRunRow>(`${workflowRunSelect} WHERE workflow_id = $1 FOR UPDATE`, [
        input.workflowId
      ]);
      const currentWorkflow = mapWorkflowRun(firstOrNotFound(workflowResult.rows, `Workflow ${input.workflowId} was not found.`));

      const turnResult = await client.query<TurnRow>(`${turnSelect} WHERE workflow_id = $1 FOR UPDATE`, [input.workflowId]);
      const currentTurn = mapTurn(firstOrNotFound(turnResult.rows, `Turn for workflow ${input.workflowId} was not found.`));

      const timestamp = nowIso();
      const failedWorkflowResult = await client.query<WorkflowRunRow>(
        `
          UPDATE workflows
          SET status = 'FAILED',
              closed_at = $2
          WHERE workflow_id = $1
          RETURNING
            workflow_id AS "workflowId",
            run_id AS "runId",
            type,
            task_queue AS "taskQueue",
            status,
            room_id AS "roomId",
            pane_id AS "paneId",
            trace_id AS "traceId",
            started_at AS "startedAt",
            closed_at AS "closedAt"
        `,
        [input.workflowId, timestamp]
      );
      const workflow = mapWorkflowRun(firstOrNotFound(failedWorkflowResult.rows, `Workflow ${input.workflowId} was not failed.`));

      const failedTurnResult = await client.query<TurnRow>(
        `
          UPDATE turns
          SET status = 'FAILED',
              updated_at = $2
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            pane_id AS "paneId",
            workflow_id AS "workflowId",
            provider_id AS "providerId",
            model_id AS "modelId",
            status,
            prompt,
            prompt_hash AS "promptHash",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [currentTurn.id, timestamp]
      );
      const turn = {
        ...mapTurn(firstOrNotFound(failedTurnResult.rows, `Turn ${currentTurn.id} was not failed.`)),
        artifactIds: currentTurn.artifactIds
      };

      if (turn.paneId) {
        await client.query("UPDATE panes SET status = 'ERROR', updated_at = $2 WHERE id = $1", [turn.paneId, timestamp]);
      }
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [turn.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: turn.roomId,
        paneId: turn.paneId,
        turnId: turn.id,
        workflowId: workflow.workflowId,
        traceId: input.traceId || currentWorkflow.traceId,
        type: "TURN_FAILED",
        message: input.message,
        payload: {
          status: turn.status,
          workflowId: workflow.workflowId,
          runId: workflow.runId,
          reasonCode: input.reasonCode ?? null,
          metadata: input.metadata ?? {}
        }
      });

      return { turn, workflow, event };
    });
  }

  async listTurns(roomId?: string): Promise<Turn[]> {
    const result = roomId
      ? await this.pool.query<TurnRow>(`${turnSelect} WHERE room_id = $1 ORDER BY created_at DESC, id DESC`, [roomId])
      : await this.pool.query<TurnRow>(`${turnSelect} ORDER BY created_at DESC, id DESC`);
    return result.rows.map(mapTurn);
  }

  async listTurnsPage(input: ListStorePageInput): Promise<StorePageResult<Turn>> {
    const direction = input.sortOrder === "asc" ? "ASC" : "DESC";
    const offset = (input.page - 1) * input.pageSize;
    const where = input.roomId ? " WHERE room_id = $1" : "";
    const countValues = input.roomId ? [input.roomId] : [];
    const pageValues = input.roomId
      ? [input.roomId, input.pageSize, offset]
      : [input.pageSize, offset];
    const limitParameter = input.roomId ? 2 : 1;
    const offsetParameter = input.roomId ? 3 : 2;
    const [countResult, pageResult] = await Promise.all([
      this.pool.query<CountRow>(`SELECT count(*) AS count FROM turns${where}`, countValues),
      this.pool.query<TurnRow>(
        `${turnSelect}${where} ORDER BY created_at ${direction}, id ${direction} LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        pageValues
      )
    ]);
    return { items: pageResult.rows.map(mapTurn), total: countValue(countResult.rows) };
  }

  async listEvents(roomId?: string): Promise<Event[]> {
    const result = roomId
      ? await this.pool.query<EventRow>(`${eventSelect} WHERE room_id = $1 ORDER BY created_at ASC, id ASC`, [roomId])
      : await this.pool.query<EventRow>(`${eventSelect} ORDER BY created_at ASC, id ASC`);
    return result.rows.map(mapEvent);
  }

  async getLatestEvent(roomId: string): Promise<Event | null> {
    const result = await this.pool.query<EventRow>(
      `${eventSelect} WHERE room_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [roomId]
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async listEventsPage(input: ListStorePageInput): Promise<StorePageResult<Event>> {
    const direction = input.sortOrder === "asc" ? "ASC" : "DESC";
    const offset = (input.page - 1) * input.pageSize;
    const where = input.roomId ? " WHERE room_id = $1" : "";
    const countValues = input.roomId ? [input.roomId] : [];
    const pageValues = input.roomId
      ? [input.roomId, input.pageSize, offset]
      : [input.pageSize, offset];
    const limitParameter = input.roomId ? 2 : 1;
    const offsetParameter = input.roomId ? 3 : 2;
    const [countResult, pageResult] = await Promise.all([
      this.pool.query<CountRow>(`SELECT count(*) AS count FROM events${where}`, countValues),
      this.pool.query<EventRow>(
        `${eventSelect}${where} ORDER BY created_at ${direction}, id ${direction} LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        pageValues
      )
    ]);
    return { items: pageResult.rows.map(mapEvent), total: countValue(countResult.rows) };
  }

  async listEventChanges(input: ListEventChangesInput): Promise<EventChange[]> {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const values: unknown[] = [];
    let where = "";
    if (input.afterSequence !== null) {
      values.push(input.afterSequence);
      where = ` WHERE relay_sequence > $${values.length}::bigint`;
    }
    values.push(limit);
    const direction = input.sortOrder === "desc" ? "DESC" : "ASC";
    const result = await this.pool.query<EventChangeRow>(
      `
        SELECT
          id,
          room_id AS "roomId",
          pane_id AS "paneId",
          turn_id AS "turnId",
          workflow_id AS "workflowId",
          trace_id AS "traceId",
          event_type AS type,
          message,
          payload,
          created_at AS "createdAt",
          relay_sequence AS "relaySequence"
        FROM events${where}
        ORDER BY relay_sequence ${direction}
        LIMIT $${values.length}
      `,
      values
    );
    return result.rows.map(mapEventChange);
  }

  async recordAuditEvent(input: CreateAuditEventInput): Promise<AuditEvent> {
    const auditId = makeSpaceId("audit");
    const result = await this.pool.query<AuditEventRow>(
      `
        INSERT INTO audit_events (id, actor_user_id, trace_id, action, target_type, target_id, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id,
          actor_user_id AS "actorUserId",
          trace_id AS "traceId",
          action,
          target_type AS "targetType",
          target_id AS "targetId",
          metadata,
          created_at AS "createdAt"
      `,
      [
        auditId,
        input.actorUserId,
        input.traceId,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso()
      ]
    );
    return mapAuditEvent(firstOrNotFound(result.rows, `Audit event ${auditId} was not created.`));
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEventRow>(`${auditEventSelect} ORDER BY created_at DESC LIMIT 500`);
    return result.rows.map(mapAuditEvent);
  }

  async listProviders(): Promise<Provider[]> {
    const [providerRows, validationRows] = await Promise.all([
      this.pool.query<ProviderRow>(`${providerSelect} ORDER BY is_builtin DESC, display_name ASC`),
      this.pool.query<ProviderValidationCheckRow>(
        `
          SELECT DISTINCT ON (provider_id)
            provider_id AS "providerId",
            status,
            code,
            status_reason AS "statusReason",
            masked_key_prefix AS "maskedKeyPrefix",
            credential_label AS "credentialLabel",
            model_count AS "modelCount",
            checked_at AS "checkedAt"
          FROM provider_validation_checks
          ORDER BY provider_id, checked_at DESC, created_at DESC
        `
      )
    ]);
    const latestByProvider = new Map(validationRows.rows.map((row) => [row.providerId, mapProviderValidation(row)]));
    const providersById = new Map<string, Provider>();
    for (const provider of this.providers) {
      providersById.set(provider.id, provider);
    }
    for (const row of providerRows.rows) {
      const provider = mapProvider(row);
      providersById.set(provider.id, provider);
    }
    return [...providersById.values()].map((provider) => {
      const latest = latestByProvider.get(provider.id);
      if (!latest) return provider;
      return {
        ...provider,
        status: latest.status,
        statusReason: latest.statusReason,
        healthCheckedAt: latest.checkedAt,
        maskedKeyPrefix: latest.maskedKeyPrefix
      };
    });
  }

  async getProviderSettings(): Promise<ProviderSettings> {
    const result = await this.pool.query<ProviderSettingsRow>(`${providerSettingsSelect} WHERE id = 'global' LIMIT 1`);
    if (result.rows[0]) return mapProviderSettings(result.rows[0]);
    return providerSettingsSchema.parse({
      defaultProviderId: "headroom-gateway",
      titleGenerationModelId: null,
      titleGenerationReasoningEffort: "low",
      updatedAt: nowIso()
    });
  }

  async updateProviderSettings(input: UpdateProviderSettingsInput): Promise<ProviderSettings> {
    const parsed = updateProviderSettingsInputSchema.parse(input);
    const current = await this.getProviderSettings();
    const defaultProviderId = parsed.defaultProviderId ?? current.defaultProviderId;
    const providers = await this.listProviders();
    if (!providers.some((provider) => provider.id === defaultProviderId)) {
      throw new SpaceNotFoundError(`Provider ${defaultProviderId} was not found.`);
    }
    const titleGenerationModelId =
      parsed.titleGenerationModelId === undefined ? current.titleGenerationModelId : parsed.titleGenerationModelId;
    if (titleGenerationModelId) {
      const models = await this.listModels();
      if (!models.some((model) => model.id === titleGenerationModelId)) {
        throw new SpaceNotFoundError(`Model ${titleGenerationModelId} was not found.`);
      }
    }
    const titleGenerationReasoningEffort =
      parsed.titleGenerationReasoningEffort ?? current.titleGenerationReasoningEffort ?? "low";
    const timestamp = nowIso();
    const result = await this.pool.query<ProviderSettingsRow>(
      `
        INSERT INTO provider_settings (
          id,
          default_provider_id,
          title_generation_model_id,
          title_generation_reasoning_effort,
          updated_at
        )
        VALUES ('global', $1, $2, $3, $4)
        ON CONFLICT (id)
        DO UPDATE SET
          default_provider_id = EXCLUDED.default_provider_id,
          title_generation_model_id = EXCLUDED.title_generation_model_id,
          title_generation_reasoning_effort = EXCLUDED.title_generation_reasoning_effort,
          updated_at = EXCLUDED.updated_at
        RETURNING
          default_provider_id AS "defaultProviderId",
          title_generation_model_id AS "titleGenerationModelId",
          title_generation_reasoning_effort AS "titleGenerationReasoningEffort",
          updated_at AS "updatedAt"
      `,
      [defaultProviderId, titleGenerationModelId, titleGenerationReasoningEffort, timestamp]
    );
    return mapProviderSettings(firstOrNotFound(result.rows, "Provider settings were not updated."));
  }

  async getCodexCliModeDefaults(): Promise<CodexCliModeDefaults> {
    const result = await this.pool.query<CodexCliModeDefaultsRow>(
      `${codexCliModeDefaultsSelect} WHERE id = 'global' LIMIT 1`
    );
    if (result.rows[0]) return mapCodexCliModeDefaults(result.rows[0]);
    throw new SpaceNotFoundError("Codex CLI mode defaults were not initialized from a provider catalog.");
  }

  async initializeCodexCliModeDefaults(input: CodexCliModeDefaultPairs): Promise<CodexCliModeDefaults> {
    const parsed = codexCliModeDefaultPairsSchema.parse(input);
    const timestamp = nowIso();
    const result = await this.pool.query<CodexCliModeDefaultsRow>(
      `
        INSERT INTO codex_cli_mode_defaults (
          id,
          build_model_id,
          build_reasoning_effort,
          plan_model_id,
          plan_reasoning_effort,
          runtime_initialized,
          updated_at
        )
        VALUES ('global', $1, $2, $3, $4, true, $5)
        ON CONFLICT (id)
        DO UPDATE SET
          build_model_id = CASE WHEN NOT codex_cli_mode_defaults.runtime_initialized THEN EXCLUDED.build_model_id ELSE codex_cli_mode_defaults.build_model_id END,
          build_reasoning_effort = CASE WHEN NOT codex_cli_mode_defaults.runtime_initialized THEN EXCLUDED.build_reasoning_effort ELSE codex_cli_mode_defaults.build_reasoning_effort END,
          plan_model_id = CASE WHEN NOT codex_cli_mode_defaults.runtime_initialized THEN EXCLUDED.plan_model_id ELSE codex_cli_mode_defaults.plan_model_id END,
          plan_reasoning_effort = CASE WHEN NOT codex_cli_mode_defaults.runtime_initialized THEN EXCLUDED.plan_reasoning_effort ELSE codex_cli_mode_defaults.plan_reasoning_effort END,
          runtime_initialized = true,
          updated_at = CASE WHEN NOT codex_cli_mode_defaults.runtime_initialized THEN EXCLUDED.updated_at ELSE codex_cli_mode_defaults.updated_at END
        RETURNING
          build_model_id AS "buildModelId",
          build_reasoning_effort AS "buildReasoningEffort",
          plan_model_id AS "planModelId",
          plan_reasoning_effort AS "planReasoningEffort",
          runtime_initialized AS "runtimeInitialized",
          updated_at AS "updatedAt"
      `,
      [
        parsed.build.modelId,
        parsed.build.reasoningEffort,
        parsed.plan.modelId,
        parsed.plan.reasoningEffort,
        timestamp
      ]
    );
    return mapCodexCliModeDefaults(firstOrNotFound(result.rows, "Codex CLI mode defaults were not initialized."));
  }

  async updateCodexCliModeDefaults(input: UpdateCodexCliModeDefaultsInput): Promise<CodexCliModeDefaults> {
    const parsed = updateCodexCliModeDefaultsInputSchema.parse(input);
    const timestamp = nowIso();
    const result = await this.pool.query<CodexCliModeDefaultsRow>(
      `
        UPDATE codex_cli_mode_defaults
        SET
          build_model_id = CASE WHEN $1 = 'build' THEN $2 ELSE build_model_id END,
          build_reasoning_effort = CASE WHEN $1 = 'build' THEN $3 ELSE build_reasoning_effort END,
          plan_model_id = CASE WHEN $1 = 'plan' THEN $2 ELSE plan_model_id END,
          plan_reasoning_effort = CASE WHEN $1 = 'plan' THEN $3 ELSE plan_reasoning_effort END,
          runtime_initialized = true,
          updated_at = $4
        WHERE id = 'global'
        RETURNING
          build_model_id AS "buildModelId",
          build_reasoning_effort AS "buildReasoningEffort",
          plan_model_id AS "planModelId",
          plan_reasoning_effort AS "planReasoningEffort",
          runtime_initialized AS "runtimeInitialized",
          updated_at AS "updatedAt"
      `,
      [parsed.mode, parsed.modelId, parsed.reasoningEffort, timestamp]
    );
    return mapCodexCliModeDefaults(firstOrNotFound(result.rows, "Codex CLI mode defaults were not updated."));
  }

  async createProvider(input: CreateProviderInput): Promise<Provider> {
    const parsed = createProviderInputSchema.parse(input);
    const providers = await this.listProviders();
    if (providers.some((provider) => provider.id === parsed.id)) {
      throw new SpaceConflictError(`Provider ${parsed.id} already exists.`);
    }
    const timestamp = nowIso();
    const result = await this.pool.query<ProviderRow>(
      `
        INSERT INTO providers (
          id,
          display_name,
          provider_type,
          status,
          status_reason,
          masked_key_prefix,
          base_url,
          health_checked_at,
          route_profile,
          backing_provider_id,
          credential_ref,
          is_builtin,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'DISABLED', $4, NULL, $5, NULL, $6, $7, $8, false, $9, $9)
        RETURNING
          id,
          display_name AS "displayName",
          provider_type AS type,
          status,
          status_reason AS "statusReason",
          masked_key_prefix AS "maskedKeyPrefix",
          base_url AS "baseUrl",
          health_checked_at AS "healthCheckedAt",
          route_profile AS "routeProfile",
          backing_provider_id AS "backingProviderId",
          credential_ref AS "credentialRef",
          is_builtin AS "isBuiltIn"
      `,
      [
        parsed.id,
        parsed.displayName,
        parsed.type,
        "Custom provider metadata is saved. Run validation before using it for chat sends.",
        parsed.baseUrl ?? null,
        parsed.routeProfile ?? "custom",
        parsed.backingProviderId ?? null,
        parsed.credentialRef ?? null,
        timestamp
      ]
    );
    return mapProvider(firstOrNotFound(result.rows, `Provider ${parsed.id} was not created.`));
  }

  async updateProvider(providerId: string, input: UpdateProviderInput): Promise<Provider> {
    const parsed = updateProviderInputSchema.parse(input);
    const providers = await this.listProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new SpaceNotFoundError(`Provider ${providerId} was not found.`);
    }
    if (provider.isBuiltIn) {
      throw new SpaceConflictError(`Provider ${providerId} is built-in and cannot be edited.`);
    }
    const next = providerSchema.parse({
      ...provider,
      ...parsed,
      routeProfile: parsed.routeProfile === undefined ? provider.routeProfile : parsed.routeProfile,
      backingProviderId: parsed.backingProviderId === undefined ? provider.backingProviderId : parsed.backingProviderId,
      credentialRef: parsed.credentialRef === undefined ? provider.credentialRef : parsed.credentialRef,
      status: "DISABLED",
      statusReason: "Custom provider metadata changed. Run validation before using it for chat sends.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      isBuiltIn: false
    });
    const timestamp = nowIso();
    const result = await this.pool.query<ProviderRow>(
      `
        UPDATE providers
        SET
          display_name = $2,
          provider_type = $3,
          status = 'DISABLED',
          status_reason = $4,
          masked_key_prefix = NULL,
          base_url = $5,
          health_checked_at = NULL,
          route_profile = $6,
          backing_provider_id = $7,
          credential_ref = $8,
          updated_at = $9
        WHERE id = $1 AND is_builtin = false
        RETURNING
          id,
          display_name AS "displayName",
          provider_type AS type,
          status,
          status_reason AS "statusReason",
          masked_key_prefix AS "maskedKeyPrefix",
          base_url AS "baseUrl",
          health_checked_at AS "healthCheckedAt",
          route_profile AS "routeProfile",
          backing_provider_id AS "backingProviderId",
          credential_ref AS "credentialRef",
          is_builtin AS "isBuiltIn"
      `,
      [
        providerId,
        next.displayName,
        next.type,
        next.statusReason,
        next.baseUrl,
        next.routeProfile,
        next.backingProviderId,
        next.credentialRef,
        timestamp
      ]
    );
    return mapProvider(firstOrNotFound(result.rows, `Provider ${providerId} was not updated.`));
  }

  async recordProviderValidation(input: ProviderValidationResult): Promise<ProviderValidationResult> {
    const checkId = makeSpaceId("provider_check");
    const result = await this.pool.query<ProviderValidationCheckRow>(
      `
        INSERT INTO provider_validation_checks (
          id,
          provider_id,
          status,
          code,
          status_reason,
          masked_key_prefix,
          credential_label,
          model_count,
          checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          provider_id AS "providerId",
          status,
          code,
          status_reason AS "statusReason",
          masked_key_prefix AS "maskedKeyPrefix",
          credential_label AS "credentialLabel",
          model_count AS "modelCount",
          checked_at AS "checkedAt"
      `,
      [
        checkId,
        input.providerId,
        input.status,
        input.code,
        input.statusReason,
        input.maskedKeyPrefix,
        input.credentialLabel,
        input.modelCount,
        input.checkedAt
      ]
    );
    return mapProviderValidation(firstOrNotFound(result.rows, `Provider validation ${checkId} was not recorded.`));
  }

  async getLatestProviderValidation(providerId: string): Promise<ProviderValidationResult | null> {
    const result = await this.pool.query<ProviderValidationCheckRow>(
      `${providerValidationSelect} WHERE provider_id = $1 ORDER BY checked_at DESC, created_at DESC LIMIT 1`,
      [providerId]
    );
    return result.rows[0] ? mapProviderValidation(result.rows[0]) : null;
  }

  async replaceProviderModels(providerId: string, models: Model[]): Promise<Model[]> {
    return this.withTransaction(async (client) => {
      const providers = await this.listProviders();
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider) {
        throw new SpaceNotFoundError(`Provider ${providerId} was not found.`);
      }
      const timestamp = nowIso();
      await client.query(
        `
          INSERT INTO providers (
            id,
            display_name,
            provider_type,
            status,
            status_reason,
            masked_key_prefix,
            base_url,
            health_checked_at,
            route_profile,
            backing_provider_id,
            credential_ref,
            is_builtin,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $8)
          ON CONFLICT (id)
          DO UPDATE SET
            display_name = EXCLUDED.display_name,
            provider_type = EXCLUDED.provider_type,
            status = EXCLUDED.status,
            status_reason = EXCLUDED.status_reason,
            masked_key_prefix = EXCLUDED.masked_key_prefix,
            base_url = EXCLUDED.base_url,
            health_checked_at = EXCLUDED.health_checked_at,
            route_profile = EXCLUDED.route_profile,
            backing_provider_id = EXCLUDED.backing_provider_id,
            credential_ref = EXCLUDED.credential_ref,
            is_builtin = EXCLUDED.is_builtin,
            updated_at = EXCLUDED.updated_at
        `,
        [
          provider.id,
          provider.displayName,
          provider.type,
          "VERIFIED",
          "Provider credential smoke passed; execution remains gated separately.",
          provider.maskedKeyPrefix,
          provider.baseUrl,
          timestamp,
          provider.routeProfile,
          provider.backingProviderId,
          provider.credentialRef,
          provider.isBuiltIn
        ]
      );
      await client.query("DELETE FROM models WHERE provider_id = $1", [providerId]);

      const savedModels: Model[] = [];
      const seenIds = new Set<string>();
      for (const model of models) {
        const parsed = modelSchema.parse({ ...model, providerId });
        if (seenIds.has(parsed.id)) continue;
        seenIds.add(parsed.id);
        const result = await client.query<ModelRow>(
          `
            INSERT INTO models (
              id,
              provider_id,
              display_name,
              status,
              capabilities,
              pricing_snapshot,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)
            ON CONFLICT (id)
            DO UPDATE SET
              provider_id = EXCLUDED.provider_id,
              display_name = EXCLUDED.display_name,
              status = EXCLUDED.status,
              capabilities = EXCLUDED.capabilities,
              updated_at = EXCLUDED.updated_at
            RETURNING
              id,
              provider_id AS "providerId",
              display_name AS "displayName",
              status,
              capabilities
          `,
          [
            parsed.id,
            parsed.providerId,
            parsed.displayName,
            parsed.status,
            JSON.stringify(modelCapabilities(parsed)),
            timestamp
          ]
        );
        savedModels.push(mapModel(firstOrNotFound(result.rows, `Model ${parsed.id} was not recorded.`)));
      }
      return savedModels;
    });
  }

  async recordCodexAppServerHandshake(input: RecordCodexAppServerHandshakeInput): Promise<CodexAppServerHandshakeCheck> {
    const checkId = makeSpaceId("codex_handshake");
    const checkedAt = input.checkedAt ?? input.finishedAt;
    const result = await this.pool.query<CodexAppServerHandshakeCheckRow>(
      `
        INSERT INTO codex_app_server_handshake_checks (
          id,
          actor_user_id,
          trace_id,
          status,
          code,
          message,
          transport,
          schemas_generated,
          schema_manifest,
          server_info,
          started_at,
          finished_at,
          duration_ms,
          checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING
          id AS "checkId",
          actor_user_id AS "actorUserId",
          trace_id AS "traceId",
          status,
          code,
          message,
          transport,
          schemas_generated AS "schemasGenerated",
          schema_manifest AS "schemaManifest",
          server_info AS "serverInfo",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          duration_ms AS "durationMs",
          checked_at AS "checkedAt"
      `,
      [
        checkId,
        input.actorUserId,
        input.traceId,
        input.status,
        input.code,
        input.message,
        input.transport,
        input.schemasGenerated,
        input.schemaManifest ? JSON.stringify(input.schemaManifest) : null,
        input.serverInfo ? JSON.stringify(input.serverInfo) : null,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
        checkedAt
      ]
    );
    return mapCodexAppServerHandshakeCheck(
      firstOrNotFound(result.rows, `Codex App Server handshake check ${checkId} was not recorded.`)
    );
  }

  async getLatestCodexAppServerHandshake(): Promise<CodexAppServerHandshakeCheck | null> {
    const result = await this.pool.query<CodexAppServerHandshakeCheckRow>(
      `${codexAppServerHandshakeCheckSelect} ORDER BY checked_at DESC, created_at DESC LIMIT 1`
    );
    return result.rows[0] ? mapCodexAppServerHandshakeCheck(result.rows[0]) : null;
  }

  async recordCodexAppServerTurnSmoke(input: RecordCodexAppServerTurnSmokeInput): Promise<CodexAppServerTurnSmokeCheck> {
    const checkId = makeSpaceId("codex_turn_smoke");
    const checkedAt = input.checkedAt ?? input.finishedAt;
    const result = await this.pool.query<CodexAppServerTurnSmokeCheckRow>(
      `
        INSERT INTO codex_app_server_turn_smoke_checks (
          id,
          actor_user_id,
          trace_id,
          status,
          code,
          message,
          transport,
          schemas_generated,
          schema_manifest,
          model,
          thread_id,
          turn_id,
          turn_status,
          notification_count,
          completed_notification_seen,
          started_at,
          finished_at,
          duration_ms,
          checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING
          id AS "checkId",
          actor_user_id AS "actorUserId",
          trace_id AS "traceId",
          status,
          code,
          message,
          transport,
          schemas_generated AS "schemasGenerated",
          schema_manifest AS "schemaManifest",
          model,
          thread_id AS "threadId",
          turn_id AS "turnId",
          turn_status AS "turnStatus",
          notification_count AS "notificationCount",
          completed_notification_seen AS "completedNotificationSeen",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          duration_ms AS "durationMs",
          checked_at AS "checkedAt"
      `,
      [
        checkId,
        input.actorUserId,
        input.traceId,
        input.status,
        input.code,
        input.message,
        input.transport,
        input.schemasGenerated,
        input.schemaManifest ? JSON.stringify(input.schemaManifest) : null,
        input.model,
        input.threadId,
        input.turnId,
        input.turnStatus,
        input.notificationCount,
        input.completedNotificationSeen,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
        checkedAt
      ]
    );
    return mapCodexAppServerTurnSmokeCheck(
      firstOrNotFound(result.rows, `Codex App Server turn smoke check ${checkId} was not recorded.`)
    );
  }

  async getLatestCodexAppServerTurnSmoke(): Promise<CodexAppServerTurnSmokeCheck | null> {
    const result = await this.pool.query<CodexAppServerTurnSmokeCheckRow>(
      `${codexAppServerTurnSmokeCheckSelect} ORDER BY checked_at DESC, created_at DESC LIMIT 1`
    );
    return result.rows[0] ? mapCodexAppServerTurnSmokeCheck(result.rows[0]) : null;
  }

  async recordMcpDiscoverySmoke(input: RecordMcpDiscoverySmokeInput): Promise<McpDiscoverySmokeCheck> {
    const checkId = makeSpaceId("mcp_discovery_smoke");
    const checkedAt = input.checkedAt ?? input.finishedAt;
    const result = await this.pool.query<McpDiscoverySmokeCheckRow>(
      `
        INSERT INTO mcp_discovery_smoke_checks (
          id,
          actor_user_id,
          trace_id,
          status,
          code,
          message,
          target_spec_version,
          discovery_enabled,
          server_count,
          tool_count,
          started_at,
          finished_at,
          duration_ms,
          checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING
          id AS "checkId",
          actor_user_id AS "actorUserId",
          trace_id AS "traceId",
          status,
          code,
          message,
          target_spec_version AS "targetSpecVersion",
          discovery_enabled AS "discoveryEnabled",
          server_count AS "serverCount",
          tool_count AS "toolCount",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          duration_ms AS "durationMs",
          checked_at AS "checkedAt"
      `,
      [
        checkId,
        input.actorUserId,
        input.traceId,
        input.status,
        input.code,
        input.message,
        input.targetSpecVersion,
        input.discoveryEnabled,
        input.serverCount,
        input.toolCount,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
        checkedAt
      ]
    );
    return mapMcpDiscoverySmokeCheck(
      firstOrNotFound(result.rows, `MCP discovery smoke check ${checkId} was not recorded.`)
    );
  }

  async getLatestMcpDiscoverySmoke(): Promise<McpDiscoverySmokeCheck | null> {
    const result = await this.pool.query<McpDiscoverySmokeCheckRow>(
      `${mcpDiscoverySmokeCheckSelect} ORDER BY checked_at DESC, created_at DESC LIMIT 1`
    );
    return result.rows[0] ? mapMcpDiscoverySmokeCheck(result.rows[0]) : null;
  }

  async recordMemoryEmbeddingSmoke(input: RecordMemoryEmbeddingSmokeInput): Promise<MemoryEmbeddingSmokeCheck> {
    const checkId = makeSpaceId("memory_embed_smoke");
    const checkedAt = input.checkedAt ?? input.finishedAt;
    const result = await this.pool.query<MemoryEmbeddingSmokeCheckRow>(
      `
        INSERT INTO memory_embedding_smoke_checks (
          id,
          actor_user_id,
          trace_id,
          status,
          code,
          message,
          smoke_enabled,
          provider,
          model,
          dimensions,
          pgvector_ready,
          embedding_provider_ready,
          started_at,
          finished_at,
          duration_ms,
          checked_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING
          id AS "checkId",
          actor_user_id AS "actorUserId",
          trace_id AS "traceId",
          status,
          code,
          message,
          smoke_enabled AS "smokeEnabled",
          provider,
          model,
          dimensions,
          pgvector_ready AS "pgvectorReady",
          embedding_provider_ready AS "embeddingProviderReady",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          duration_ms AS "durationMs",
          checked_at AS "checkedAt"
      `,
      [
        checkId,
        input.actorUserId,
        input.traceId,
        input.status,
        input.code,
        input.message,
        input.smokeEnabled,
        input.provider,
        input.model,
        input.dimensions,
        input.pgvectorReady,
        input.embeddingProviderReady,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
        checkedAt
      ]
    );
    return mapMemoryEmbeddingSmokeCheck(
      firstOrNotFound(result.rows, `Memory embedding smoke check ${checkId} was not recorded.`)
    );
  }

  async getLatestMemoryEmbeddingSmoke(): Promise<MemoryEmbeddingSmokeCheck | null> {
    const result = await this.pool.query<MemoryEmbeddingSmokeCheckRow>(
      `${memoryEmbeddingSmokeCheckSelect} ORDER BY checked_at DESC, created_at DESC LIMIT 1`
    );
    return result.rows[0] ? mapMemoryEmbeddingSmokeCheck(result.rows[0]) : null;
  }

  async getMemoryVectorReadiness(expectedDimensions: number): Promise<MemoryVectorReadiness> {
    const extension = await this.pool.query<{ extensionVersion: string | null }>(
      `SELECT extversion AS "extensionVersion" FROM pg_extension WHERE extname = 'vector' LIMIT 1`
    );
    const extensionVersion = extension.rows[0]?.extensionVersion ?? null;

    if (!extensionVersion) {
      return buildMemoryVectorReadiness({
        status: "ERROR",
        code: "PGVECTOR_EXTENSION_MISSING",
        message: "Postgres is active, but the pgvector extension is not installed.",
        runtimeStore: "postgres",
        extensionInstalled: false,
        extensionVersion: null,
        embeddingColumnReady: false,
        embeddingDimensions: null,
        expectedDimensions,
        vectorIndexReady: false
      });
    }

    const column = await this.pool.query<{ formattedType: string | null }>(
      `
        SELECT format_type(a.atttypid, a.atttypmod) AS "formattedType"
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        WHERE c.relname = 'memory_records'
          AND a.attname = 'embedding'
          AND NOT a.attisdropped
        LIMIT 1
      `
    );
    const embeddingDimensions = parseVectorDimensions(column.rows[0]?.formattedType);

    if (!embeddingDimensions) {
      return buildMemoryVectorReadiness({
        status: "ERROR",
        code: "MEMORY_EMBEDDING_COLUMN_MISSING",
        message: "memory_records.embedding is missing or is not a pgvector column.",
        runtimeStore: "postgres",
        extensionInstalled: true,
        extensionVersion,
        embeddingColumnReady: false,
        embeddingDimensions: null,
        expectedDimensions,
        vectorIndexReady: false
      });
    }

    if (embeddingDimensions !== expectedDimensions) {
      return buildMemoryVectorReadiness({
        status: "ERROR",
        code: "MEMORY_EMBEDDING_DIMENSIONS_MISMATCH",
        message: `memory_records.embedding is vector(${embeddingDimensions}), but config expects vector(${expectedDimensions}).`,
        runtimeStore: "postgres",
        extensionInstalled: true,
        extensionVersion,
        embeddingColumnReady: true,
        embeddingDimensions,
        expectedDimensions,
        vectorIndexReady: false
      });
    }

    const index = await this.pool.query<{ vectorIndexReady: boolean }>(
      `SELECT to_regclass('idx_memory_records_embedding_hnsw') IS NOT NULL AS "vectorIndexReady"`
    );
    const vectorIndexReady = index.rows[0]?.vectorIndexReady === true;
    if (!vectorIndexReady) {
      return buildMemoryVectorReadiness({
        status: "ERROR",
        code: "MEMORY_VECTOR_INDEX_MISSING",
        message: "memory_records.embedding has no HNSW vector index yet.",
        runtimeStore: "postgres",
        extensionInstalled: true,
        extensionVersion,
        embeddingColumnReady: true,
        embeddingDimensions,
        expectedDimensions,
        vectorIndexReady: false
      });
    }

    return buildMemoryVectorReadiness({
      status: "VERIFIED",
      code: "MEMORY_VECTOR_READY",
      message: "pgvector extension, memory embedding column and HNSW vector index are ready.",
      runtimeStore: "postgres",
      extensionInstalled: true,
      extensionVersion,
      embeddingColumnReady: true,
      embeddingDimensions,
      expectedDimensions,
      vectorIndexReady: true
    });
  }

  async listModels(): Promise<Model[]> {
    const result = await this.pool.query<ModelRow>(
      `
        SELECT
          id,
          provider_id AS "providerId",
          display_name AS "displayName",
          status,
          capabilities
        FROM models
        ORDER BY provider_id ASC, display_name ASC, id ASC
      `
    );
    return result.rows.length ? result.rows.map(mapModel) : [...this.models];
  }

  async listCapabilities(): Promise<Capability[]> {
    return replaceMcpCapabilities(this.capabilities, await this.getMcpGatewayStatus(), await this.listMcpTools());
  }

  async getMcpGatewayStatus(): Promise<McpGatewayStatus> {
    const servers = await this.readPersistedMcpServers();
    if (servers.length === 0) {
      return this.mcpGatewayStatus;
    }
    return buildMcpGatewayStatusFromCatalog(servers, await this.readPersistedMcpTools(), this.mcpGatewayStatus.targetSpecVersion);
  }

  async listMcpServers(): Promise<McpServer[]> {
    const servers = await this.readPersistedMcpServers();
    return servers.length ? servers : [...this.mcpServers];
  }

  async listMcpTools(): Promise<McpTool[]> {
    return this.readPersistedMcpTools();
  }

  async recordMcpDiscoveryCatalog(input: RecordMcpDiscoveryCatalogInput): Promise<McpDiscoveryCatalogRecord> {
    const normalized = normalizeMcpDiscoveryCatalog(input);
    return this.withTransaction(async (client) => {
      const servers: McpServer[] = [];
      for (const server of normalized.servers) {
        const result = await client.query<McpServerRow>(
          `
            INSERT INTO mcp_servers (
              id,
              display_name,
              transport,
              status,
              status_reason,
              schema_version,
              config_hash,
              tool_count,
              last_discovered_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id)
            DO UPDATE SET
              display_name = EXCLUDED.display_name,
              transport = EXCLUDED.transport,
              status = EXCLUDED.status,
              status_reason = EXCLUDED.status_reason,
              schema_version = EXCLUDED.schema_version,
              config_hash = EXCLUDED.config_hash,
              tool_count = EXCLUDED.tool_count,
              last_discovered_at = EXCLUDED.last_discovered_at,
              updated_at = EXCLUDED.updated_at
            RETURNING
              id,
              display_name AS "displayName",
              transport,
              status,
              status_reason AS "statusReason",
              schema_version AS "schemaVersion",
              config_hash AS "configHash",
              tool_count AS "toolCount",
              last_discovered_at AS "lastDiscoveredAt"
          `,
          [
            server.id,
            server.displayName,
            server.transport,
            server.status,
            server.statusReason,
            server.schemaVersion,
            server.configHash,
            server.toolCount,
            server.lastDiscoveredAt,
            nowIso()
          ]
        );
        servers.push(mapMcpServer(firstOrNotFound(result.rows, `MCP server ${server.id} was not recorded.`)));
      }

      const tools: McpTool[] = [];
      for (const tool of normalized.tools) {
        const result = await client.query<McpToolRow>(
          `
            INSERT INTO mcp_tools (
              id,
              server_id,
              name,
              risk_level,
              schema_hash,
              approval_required,
              status,
              status_reason,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id)
            DO UPDATE SET
              server_id = EXCLUDED.server_id,
              name = EXCLUDED.name,
              risk_level = EXCLUDED.risk_level,
              schema_hash = EXCLUDED.schema_hash,
              approval_required = EXCLUDED.approval_required,
              status = EXCLUDED.status,
              status_reason = EXCLUDED.status_reason,
              updated_at = EXCLUDED.updated_at
            RETURNING
              id,
              server_id AS "serverId",
              name,
              risk_level AS "riskLevel",
              schema_hash AS "schemaHash",
              approval_required AS "approvalRequired",
              status,
              status_reason AS "statusReason"
          `,
          [
            tool.id,
            tool.serverId,
            tool.name,
            tool.riskLevel,
            tool.schemaHash,
            tool.approvalRequired,
            tool.status,
            tool.statusReason,
            nowIso()
          ]
        );
        tools.push(mapMcpTool(firstOrNotFound(result.rows, `MCP tool ${tool.id} was not recorded.`)));
      }

      return {
        gatewayStatus: buildMcpGatewayStatusFromCatalog(servers, tools, this.mcpGatewayStatus.targetSpecVersion),
        servers,
        tools
      };
    });
  }

  async listSkills(): Promise<Skill[]> {
    const result = await this.pool.query<SkillRow>(`${skillSelect} ORDER BY updated_at DESC`);
    return [...result.rows.map(mapSkill), ...this.skills];
  }

  async createSkillProposal(input: CreateSkillProposalInput, traceId = makeSpaceId("trace")): Promise<SkillProposalRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeSkillProposalInput(input);
      const skillId = makeSpaceId("skill");
      const result = await client.query<SkillRow>(
        `
          INSERT INTO skills (
            id,
            display_name,
            version,
            status,
            trigger_description,
            body,
            allowed_tools,
            content_hash,
            source,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'DISABLED', $4, $5, $6, $7, 'OPERATOR_PROPOSAL', $8, $8)
          RETURNING
            id,
            display_name AS "displayName",
            version,
            status,
            'Operator proposal recorded; execution remains disabled until review and allowlists pass.' AS "statusReason",
            trigger_description AS "triggerDescription",
            body,
            allowed_tools AS "allowedTools",
            content_hash AS "contentHash",
            source,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [
          skillId,
          normalized.displayName,
          normalized.version,
          normalized.triggerDescription,
          normalized.body,
          JSON.stringify(normalized.allowedTools),
          hashSkillProposal(normalized),
          timestamp
        ]
      );
      const skill = mapSkill(firstOrNotFound(result.rows, `Skill ${skillId} was not created.`));
      const event = await this.appendEvent(client, {
        roomId: null,
        paneId: null,
        turnId: null,
        traceId,
        type: "SKILL_PROPOSED",
        message: `Skill ${skill.displayName} proposed.`,
        payload: {
          skillId: skill.id,
          status: skill.status,
          contentHash: skill.contentHash,
          allowedToolCount: skill.allowedTools.length
        }
      });
      return { skill, event };
    });
  }

  async listImportCandidates(
    query: ListImportCandidatesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): Promise<ImportCandidate[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.targetKind) {
      values.push(query.targetKind);
      where.push(`target_kind = $${values.length}`);
    }
    const result = await this.pool.query<ImportCandidateRow>(
      `${importCandidateSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`,
      values
    );
    return result.rows.map(mapImportCandidate);
  }

  async createImportCandidate(input: CreateImportCandidateInput, traceId = makeSpaceId("trace")): Promise<ImportCandidateRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeImportCandidateInput(input);
      if (normalized.targetKind === "MEMORY" && normalized.memoryScope === "ROOM") {
        await this.getRoomForUpdate(client, normalized.roomId ?? "");
      }
      const candidateId = makeSpaceId("import");
      const result = await client.query<ImportCandidateRow>(
        `
          INSERT INTO import_candidates (
            id,
            source_kind,
            target_kind,
            status,
            status_reason,
            source_ref,
            room_id,
            memory_scope,
            title,
            body,
            provenance,
            skill_version,
            skill_trigger_description,
            allowed_tools,
            created_at
          )
          VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING
            id,
            source_kind AS "sourceKind",
            target_kind AS "targetKind",
            status,
            status_reason AS "statusReason",
            source_ref AS "sourceRef",
            room_id AS "roomId",
            memory_scope AS "memoryScope",
            title,
            body,
            provenance,
            skill_version AS "skillVersion",
            skill_trigger_description AS "skillTriggerDescription",
            allowed_tools AS "allowedTools",
            imported_memory_id AS "importedMemoryId",
            imported_skill_id AS "importedSkillId",
            created_at AS "createdAt",
            decided_at AS "decidedAt"
        `,
        [
          candidateId,
          normalized.sourceKind,
          normalized.targetKind,
          "Awaiting explicit operator import or reject decision. Source content is copied; Space does not follow live Codex paths.",
          normalized.sourceRef,
          normalized.targetKind === "MEMORY" && normalized.memoryScope === "ROOM" ? normalized.roomId ?? null : null,
          normalized.memoryScope,
          normalized.title,
          normalized.body,
          normalized.provenance,
          normalized.targetKind === "SKILL" ? normalized.skillVersion : null,
          normalized.targetKind === "SKILL" ? normalized.skillTriggerDescription ?? null : null,
          JSON.stringify(normalized.targetKind === "SKILL" ? normalized.allowedTools : []),
          timestamp
        ]
      );
      const candidate = mapImportCandidate(firstOrNotFound(result.rows, `Import candidate ${candidateId} was not created.`));
      const event = await this.appendEvent(client, {
        roomId: candidate.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "IMPORT_CANDIDATE_CREATED",
        message: `Import candidate ${candidate.title} staged.`,
        payload: {
          importCandidateId: candidate.id,
          sourceKind: candidate.sourceKind,
          targetKind: candidate.targetKind,
          status: candidate.status
        }
      });
      return { candidate, event };
    });
  }

  async decideImportCandidate(
    candidateId: string,
    input: ImportCandidateDecisionInput,
    traceId = makeSpaceId("trace")
  ): Promise<ImportCandidateDecisionRecord> {
    return this.withTransaction(async (client) => {
      const locked = await client.query<ImportCandidateRow>(
        `${importCandidateSelect} WHERE id = $1 FOR UPDATE`,
        [candidateId]
      );
      const candidate = mapImportCandidate(firstOrNotFound(locked.rows, `Import candidate ${candidateId} was not found.`));
      if (candidate.status !== "PENDING") {
        throw new SpaceConflictError(`Import candidate ${candidateId} is already ${candidate.status}.`);
      }

      const timestamp = nowIso();
      let memoryEntry: MemoryEntry | null = null;
      let skill: Skill | null = null;
      const events: Event[] = [];

      if (input.decision === "IMPORT") {
        if (candidate.targetKind === "MEMORY") {
          if (candidate.memoryScope === "ROOM") {
            await this.getRoomForUpdate(client, candidate.roomId ?? "");
          }
          const memoryId = makeSpaceId("memory");
          const memoryResult = await client.query<MemoryEntryRow>(
            `
              INSERT INTO memory_records (id, scope, room_id, title, body, provenance, embedding, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)
              RETURNING
                id,
                scope,
                room_id AS "roomId",
                title,
                body,
                provenance,
                created_at AS "createdAt"
            `,
            [
              memoryId,
              candidate.memoryScope,
              candidate.memoryScope === "ROOM" ? candidate.roomId : null,
              candidate.title,
              candidate.body,
              `${candidate.provenance}; imported from ${candidate.sourceKind}:${candidate.sourceRef}`,
              timestamp
            ]
          );
          memoryEntry = mapMemoryEntry(firstOrNotFound(memoryResult.rows, `Memory entry ${memoryId} was not imported.`));
          if (memoryEntry.roomId) {
            await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [memoryEntry.roomId, timestamp]);
          }
          events.push(
            await this.appendEvent(client, {
              roomId: memoryEntry.roomId,
              paneId: null,
              turnId: null,
              traceId,
              type: "MEMORY_SAVED",
              message: `Memory ${memoryEntry.title} imported.`,
              payload: {
                memoryId: memoryEntry.id,
                scope: memoryEntry.scope,
                provenance: memoryEntry.provenance,
                importCandidateId: candidate.id
              }
            })
          );
        } else {
          const normalizedSkill = normalizeSkillProposalInput({
            displayName: candidate.title,
            version: candidate.skillVersion ?? "0.1.0",
            triggerDescription: candidate.skillTriggerDescription ?? "Imported through explicit Space gate.",
            body: candidate.body,
            allowedTools: candidate.allowedTools
          });
          const skillId = makeSpaceId("skill");
          const skillResult = await client.query<SkillRow>(
            `
              INSERT INTO skills (
                id,
                display_name,
                version,
                status,
                trigger_description,
                body,
                allowed_tools,
                content_hash,
                source,
                created_at,
                updated_at
              )
              VALUES ($1, $2, $3, 'DISABLED', $4, $5, $6, $7, 'OPERATOR_PROPOSAL', $8, $8)
              RETURNING
                id,
                display_name AS "displayName",
                version,
                status,
                'Operator proposal recorded; execution remains disabled until review and allowlists pass.' AS "statusReason",
                trigger_description AS "triggerDescription",
                body,
                allowed_tools AS "allowedTools",
                content_hash AS "contentHash",
                source,
                created_at AS "createdAt",
                updated_at AS "updatedAt"
            `,
            [
              skillId,
              normalizedSkill.displayName,
              normalizedSkill.version,
              normalizedSkill.triggerDescription,
              normalizedSkill.body,
              JSON.stringify(normalizedSkill.allowedTools),
              hashSkillProposal(normalizedSkill),
              timestamp
            ]
          );
          skill = mapSkill(firstOrNotFound(skillResult.rows, `Skill ${skillId} was not imported.`));
          events.push(
            await this.appendEvent(client, {
              roomId: null,
              paneId: null,
              turnId: null,
              traceId,
              type: "SKILL_PROPOSED",
              message: `Skill ${skill.displayName} imported as proposal.`,
              payload: {
                skillId: skill.id,
                status: skill.status,
                contentHash: skill.contentHash,
                allowedToolCount: skill.allowedTools.length,
                importCandidateId: candidate.id
              }
            })
          );
        }
      }

      const status = input.decision === "IMPORT" ? "IMPORTED" : "REJECTED";
      const statusReason =
        input.decision === "IMPORT"
          ? "Imported through explicit Space gate; source content is now a native Space copy."
          : input.reason;
      const updatedResult = await client.query<ImportCandidateRow>(
        `
          UPDATE import_candidates
          SET
            status = $2,
            status_reason = $3,
            imported_memory_id = $4,
            imported_skill_id = $5,
            decided_at = $6
          WHERE id = $1
          RETURNING
            id,
            source_kind AS "sourceKind",
            target_kind AS "targetKind",
            status,
            status_reason AS "statusReason",
            source_ref AS "sourceRef",
            room_id AS "roomId",
            memory_scope AS "memoryScope",
            title,
            body,
            provenance,
            skill_version AS "skillVersion",
            skill_trigger_description AS "skillTriggerDescription",
            allowed_tools AS "allowedTools",
            imported_memory_id AS "importedMemoryId",
            imported_skill_id AS "importedSkillId",
            created_at AS "createdAt",
            decided_at AS "decidedAt"
        `,
        [candidate.id, status, statusReason, memoryEntry?.id ?? null, skill?.id ?? null, timestamp]
      );
      const updated = mapImportCandidate(firstOrNotFound(updatedResult.rows, `Import candidate ${candidate.id} was not updated.`));
      events.push(
        await this.appendEvent(client, {
          roomId: updated.roomId,
          paneId: null,
          turnId: null,
          traceId,
          type: "IMPORT_CANDIDATE_DECIDED",
          message: `Import candidate ${updated.title} ${updated.status.toLowerCase()}.`,
          payload: {
            importCandidateId: updated.id,
            status: updated.status,
            importedMemoryId: updated.importedMemoryId,
            importedSkillId: updated.importedSkillId
          }
        })
      );
      return { candidate: updated, events, memoryEntry, skill };
    });
  }

  async createMemoryEntry(
    input: CreateMemoryEntryInput,
    traceId = makeSpaceId("trace"),
    options: CreateMemoryEntryOptions = {}
  ): Promise<MemoryEntryRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      if (input.scope === "ROOM") {
        await this.getRoomForUpdate(client, input.roomId ?? "");
      }
      const memoryId = makeSpaceId("memory");
      const result = await client.query<MemoryEntryRow>(
        `
          INSERT INTO memory_records (id, scope, room_id, title, body, provenance, embedding, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
          RETURNING
            id,
            scope,
            room_id AS "roomId",
            title,
            body,
            provenance,
            created_at AS "createdAt"
        `,
        [
          memoryId,
          input.scope,
          input.scope === "ROOM" ? input.roomId ?? null : null,
          redactMemoryText(input.title),
          redactMemoryText(input.body),
          redactMemoryText(input.provenance),
          toPgVectorLiteral(options.embedding),
          timestamp
        ]
      );
      const entry = mapMemoryEntry(firstOrNotFound(result.rows, `Memory entry ${memoryId} was not recorded.`));
      if (entry.roomId) {
        await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [entry.roomId, timestamp]);
      }
      const event = await this.appendEvent(client, {
        roomId: entry.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "MEMORY_SAVED",
        message: `Memory ${entry.title} saved.`,
        payload: { memoryId: entry.id, scope: entry.scope, provenance: entry.provenance }
      });
      return { entry, event };
    });
  }

  async listMemoryEntries(
    query: ListMemoryQuery = { page: 1, pageSize: 25, sortOrder: "desc" },
    options: ListMemoryEntriesOptions = {}
  ): Promise<MemoryEntry[]> {
    assertMemorySearchModeEnabled(query, options);
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.scope) {
      values.push(query.scope);
      where.push(`scope = $${values.length}`);
    }
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    if (query.searchMode === "keyword" && query.q) {
      values.push(`%${query.q}%`);
      const index = values.length;
      where.push(`(title ILIKE $${index} OR body ILIKE $${index} OR provenance ILIKE $${index})`);
    }
    let orderBy = "created_at DESC";
    if (query.searchMode === "semantic") {
      values.push(toPgVectorLiteral(options.queryEmbedding) ?? "");
      const index = values.length;
      where.push("embedding IS NOT NULL");
      orderBy = `embedding <=> $${index}::vector ASC, created_at DESC`;
    }
    let limitClause = "";
    if (options.limit !== undefined) {
      values.push(Math.max(1, Math.min(500, Math.trunc(options.limit))));
      limitClause = ` LIMIT $${values.length}`;
    }
    const result = await this.pool.query<MemoryEntryRow>(
      `${memoryEntrySelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy}${limitClause}`,
      values
    );
    return result.rows.map(mapMemoryEntry);
  }

  async linkMemoryCacheRecord(input: LinkMemoryCacheInput): Promise<MemoryCacheLink> {
    const parsed = linkMemoryCacheInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryCacheLinkCandidateRow>(
        `${memoryCacheLinkSelect} WHERE id = $1 FOR UPDATE`,
        [parsed.memoryRecordId]
      );
      const current = firstOrNotFound(currentResult.rows, `Memory cache record ${parsed.memoryRecordId} was not found.`);
      if (current.canonicalMemoryId) {
        const existing = mapMemoryCacheLink(current as MemoryCacheLinkRow);
        if (existing.canonicalMemoryId === parsed.canonicalMemoryId) return existing;
        throw new SpaceConflictError(`Memory cache record ${parsed.memoryRecordId} is already linked.`);
      }
      const timestamp = nowIso();
      const result = await client.query<MemoryCacheLinkRow>(
        `
          UPDATE memory_records
          SET canonical_memory_id = $2, canonical_link_source = $3, canonical_linked_at = $4
          WHERE id = $1 AND canonical_memory_id IS NULL
          RETURNING
            id AS "memoryRecordId",
            canonical_memory_id AS "canonicalMemoryId",
            canonical_link_source AS "linkSource",
            canonical_linked_at AS "linkedAt"
        `,
        [parsed.memoryRecordId, parsed.canonicalMemoryId, parsed.linkSource, timestamp]
      );
      return mapMemoryCacheLink(firstOrNotFound(result.rows, `Memory cache record ${parsed.memoryRecordId} was not linked.`));
    });
  }

  async getMemoryCacheLink(memoryRecordId: string): Promise<MemoryCacheLink | null> {
    const result = await this.pool.query<MemoryCacheLinkRow>(
      `${memoryCacheLinkSelect} WHERE id = $1 AND canonical_memory_id IS NOT NULL`,
      [memoryRecordId]
    );
    return result.rows[0] ? mapMemoryCacheLink(result.rows[0]) : null;
  }

  async listMemoryCacheLinks(query: ListMemoryCacheLinksQuery = { limit: 500 }): Promise<MemoryCacheLink[]> {
    const parsed = listMemoryCacheLinksQuerySchema.parse(query);
    const values: unknown[] = [];
    const filters = ["canonical_memory_id IS NOT NULL"];
    if (parsed.memoryRecordIds) {
      values.push(parsed.memoryRecordIds);
      filters.push(`id = ANY($${values.length}::text[])`);
    }
    values.push(parsed.limit);
    const result = await this.pool.query<MemoryCacheLinkRow>(
      `${memoryCacheLinkSelect}
       WHERE ${filters.join(" AND ")}
       ORDER BY canonical_linked_at DESC, id ASC
       LIMIT $${values.length}`,
      values
    );
    return result.rows.map(mapMemoryCacheLink);
  }

  async upsertMemoryIssueState(input: UpsertMemoryIssueStateInput): Promise<MemoryIssueState> {
    const parsed = upsertMemoryIssueStateInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryIssueStateRow>(
        `${memoryIssueStateSelect} WHERE issue_id = $1 FOR UPDATE`,
        [parsed.issueId]
      );
      const current = currentResult.rows[0] ? mapMemoryIssueState(currentResult.rows[0]) : null;
      if (current && parsed.expectedVersion !== current.version) {
        throw new SpaceConflictError(`Memory issue ${parsed.issueId} changed before this update.`);
      }
      if (!current && parsed.expectedVersion !== undefined) {
        throw new SpaceConflictError(`Memory issue ${parsed.issueId} has no version ${parsed.expectedVersion}.`);
      }
      const timestamp = nowIso();
      const reason = parsed.reason ? redactMemoryText(parsed.reason) : null;
      if (!current) {
        const result = await client.query<MemoryIssueStateRow>(
          `
            INSERT INTO memory_graph_issue_states (
              issue_id, issue_type, record_id, source_hash, status, reason,
              actor_user_id, version, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)
            RETURNING
              issue_id AS "issueId", issue_type AS "issueType", record_id AS "recordId",
              source_hash AS "sourceHash", status, reason, actor_user_id AS "actorUserId",
              version, created_at AS "createdAt", updated_at AS "updatedAt"
          `,
          [parsed.issueId, parsed.issueType, parsed.recordId, parsed.sourceHash, parsed.status, reason, parsed.actorUserId, timestamp]
        );
        return mapMemoryIssueState(firstOrNotFound(result.rows, `Memory issue ${parsed.issueId} was not recorded.`));
      }
      const result = await client.query<MemoryIssueStateRow>(
        `
          UPDATE memory_graph_issue_states
          SET issue_type = $2, record_id = $3, source_hash = $4, status = $5,
              reason = $6, actor_user_id = $7, version = version + 1, updated_at = $8
          WHERE issue_id = $1 AND version = $9
          RETURNING
            issue_id AS "issueId", issue_type AS "issueType", record_id AS "recordId",
            source_hash AS "sourceHash", status, reason, actor_user_id AS "actorUserId",
            version, created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [parsed.issueId, parsed.issueType, parsed.recordId, parsed.sourceHash, parsed.status, reason, parsed.actorUserId, timestamp, current.version]
      );
      return mapMemoryIssueState(firstOrNotFound(result.rows, `Memory issue ${parsed.issueId} changed before this update.`));
    });
  }

  async getMemoryIssueState(issueId: string): Promise<MemoryIssueState | null> {
    const result = await this.pool.query<MemoryIssueStateRow>(`${memoryIssueStateSelect} WHERE issue_id = $1`, [issueId]);
    return result.rows[0] ? mapMemoryIssueState(result.rows[0]) : null;
  }

  async listMemoryIssueStates(
    query: ListMemoryIssueStatesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): Promise<MemoryIssueState[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.issueIds) {
      values.push(query.issueIds);
      where.push(`issue_id = ANY($${values.length}::text[])`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.recordId) {
      values.push(query.recordId);
      where.push(`record_id = $${values.length}`);
    }
    const offset = (query.page - 1) * query.pageSize;
    values.push(query.pageSize, offset);
    const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<MemoryIssueStateRow>(
      `${memoryIssueStateSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at ${direction}, issue_id ${direction} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map(mapMemoryIssueState);
  }

  async createMemoryConsolidationRun(input: CreateMemoryConsolidationRunInput): Promise<MemoryConsolidationRun> {
    const parsed = createMemoryConsolidationRunInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const runId = makeSpaceId("memory_consolidation");
      const result = await client.query<MemoryConsolidationRunRow>(
        `
          INSERT INTO memory_consolidation_runs (
            id, mode, trigger_kind, status, workflow_id, dedupe_key, source_hash, actor_user_id,
            progress_completed, progress_total, finding_count, applied_operation_count,
            skipped_operation_count, failed_operation_count, metrics, model_id, ai_verified,
            ai_evidence, status_reason, created_at, started_at, completed_at, updated_at
          )
          VALUES (
            $1, $2, $3, 'QUEUED', $4, $5, $6, $7,
            0, 0, 0, 0,
            0, 0, '{}'::jsonb, NULL, false,
            '{}'::jsonb, NULL, $8, NULL, NULL, $8
          )
          ON CONFLICT (dedupe_key)
          DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
          RETURNING
            id, mode, trigger_kind AS "triggerKind", status, workflow_id AS "workflowId",
            dedupe_key AS "dedupeKey", source_hash AS "sourceHash", actor_user_id AS "actorUserId",
            progress_completed AS "progressCompleted", progress_total AS "progressTotal",
            finding_count AS "findingCount", applied_operation_count AS "appliedOperationCount",
            skipped_operation_count AS "skippedOperationCount", failed_operation_count AS "failedOperationCount",
            metrics, model_id AS "modelId", ai_verified AS "aiVerified", ai_evidence AS "aiEvidence",
            status_reason AS "statusReason", created_at AS "createdAt", started_at AS "startedAt",
            completed_at AS "completedAt", updated_at AS "updatedAt"
        `,
        [runId, parsed.mode, parsed.triggerKind, parsed.workflowId, parsed.dedupeKey, parsed.sourceHash, parsed.actorUserId, timestamp]
      );
      const run = mapMemoryConsolidationRun(firstOrNotFound(result.rows, `Memory consolidation ${runId} was not recorded.`));
      if (
        run.dedupeKey !== parsed.dedupeKey ||
        run.mode !== parsed.mode ||
        run.triggerKind !== parsed.triggerKind ||
        run.workflowId !== parsed.workflowId ||
        run.sourceHash !== parsed.sourceHash ||
        run.actorUserId !== parsed.actorUserId
      ) {
        throw new SpaceConflictError("Memory consolidation dedupe key already exists.");
      }
      return run;
    });
  }

  async getMemoryConsolidationRun(runId: string): Promise<MemoryConsolidationRun> {
    const result = await this.pool.query<MemoryConsolidationRunRow>(`${memoryConsolidationRunSelect} WHERE id = $1`, [runId]);
    return mapMemoryConsolidationRun(firstOrNotFound(result.rows, `Memory consolidation ${runId} was not found.`));
  }

  async updateMemoryConsolidationRun(
    runId: string,
    input: UpdateMemoryConsolidationRunInput
  ): Promise<MemoryConsolidationRun> {
    const parsed = updateMemoryConsolidationRunInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryConsolidationRunRow>(
        `${memoryConsolidationRunSelect} WHERE id = $1 FOR UPDATE`,
        [runId]
      );
      const current = mapMemoryConsolidationRun(firstOrNotFound(currentResult.rows, `Memory consolidation ${runId} was not found.`));
      assertMemoryConsolidationRunTransition(current.status, parsed.status);
      const timestamp = nowIso();
      const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(parsed.status);
      const updated = memoryConsolidationRunSchema.parse({
        ...current,
        ...parsed,
        statusReason: parsed.statusReason === undefined
          ? current.statusReason
          : parsed.statusReason === null ? null : redactMemoryText(parsed.statusReason),
        startedAt: parsed.status === "RUNNING" ? current.startedAt ?? timestamp : current.startedAt,
        completedAt: terminal ? current.completedAt ?? timestamp : current.completedAt,
        updatedAt: timestamp
      });
      const result = await client.query<MemoryConsolidationRunRow>(
        `
          UPDATE memory_consolidation_runs
          SET status = $2, source_hash = $3, progress_completed = $4, progress_total = $5,
              finding_count = $6, applied_operation_count = $7, skipped_operation_count = $8,
              failed_operation_count = $9, metrics = $10::jsonb, model_id = $11,
              ai_verified = $12, ai_evidence = $13::jsonb, status_reason = $14,
              started_at = $15, completed_at = $16, updated_at = $17
          WHERE id = $1
          RETURNING
            id, mode, trigger_kind AS "triggerKind", status, workflow_id AS "workflowId",
            dedupe_key AS "dedupeKey", source_hash AS "sourceHash", actor_user_id AS "actorUserId",
            progress_completed AS "progressCompleted", progress_total AS "progressTotal",
            finding_count AS "findingCount", applied_operation_count AS "appliedOperationCount",
            skipped_operation_count AS "skippedOperationCount", failed_operation_count AS "failedOperationCount",
            metrics, model_id AS "modelId", ai_verified AS "aiVerified", ai_evidence AS "aiEvidence",
            status_reason AS "statusReason", created_at AS "createdAt", started_at AS "startedAt",
            completed_at AS "completedAt", updated_at AS "updatedAt"
        `,
        [
          runId, updated.status, updated.sourceHash, updated.progressCompleted, updated.progressTotal,
          updated.findingCount, updated.appliedOperationCount, updated.skippedOperationCount,
          updated.failedOperationCount, JSON.stringify(updated.metrics), updated.modelId,
          updated.aiVerified, JSON.stringify(updated.aiEvidence), updated.statusReason,
          updated.startedAt, updated.completedAt, updated.updatedAt
        ]
      );
      return mapMemoryConsolidationRun(firstOrNotFound(result.rows, `Memory consolidation ${runId} was not updated.`));
    });
  }

  async createMemoryConsolidationFinding(
    input: CreateMemoryConsolidationFindingInput
  ): Promise<MemoryConsolidationFinding> {
    const parsed = createMemoryConsolidationFindingInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const runResult = await client.query<MemoryConsolidationRunRow>(
        `${memoryConsolidationRunSelect} WHERE id = $1 FOR UPDATE`,
        [parsed.runId]
      );
      const run = mapMemoryConsolidationRun(firstOrNotFound(runResult.rows, `Memory consolidation ${parsed.runId} was not found.`));
      if (run.status !== "RUNNING") throw new SpaceConflictError(`Memory consolidation ${run.id} is not running.`);
      if (parsed.issueId) {
        const existingResult = await client.query<MemoryConsolidationFindingRow>(
          `${memoryConsolidationFindingSelect} WHERE run_id = $1 AND issue_id = $2`,
          [parsed.runId, parsed.issueId]
        );
        if (existingResult.rows[0]) return mapMemoryConsolidationFinding(existingResult.rows[0]);
      }
      const timestamp = nowIso();
      const findingId = makeSpaceId("memory_finding");
      const result = await client.query<MemoryConsolidationFindingRow>(
        `
          INSERT INTO memory_consolidation_findings (
            id, run_id, issue_id, finding_type, severity, status, confidence,
            record_ids, source_path, evidence, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7::jsonb, $8, $9, $10, $10)
          RETURNING
            id, run_id AS "runId", issue_id AS "issueId", finding_type AS "findingType",
            severity, status, confidence, record_ids AS "recordIds", source_path AS "sourcePath",
            evidence, created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [
          findingId, parsed.runId, parsed.issueId, parsed.findingType, parsed.severity,
          parsed.confidence, JSON.stringify(parsed.recordIds), parsed.sourcePath,
          redactMemoryText(parsed.evidence), timestamp
        ]
      );
      return mapMemoryConsolidationFinding(firstOrNotFound(result.rows, `Memory finding ${findingId} was not recorded.`));
    });
  }

  async updateMemoryConsolidationFinding(
    findingId: string,
    input: UpdateMemoryConsolidationFindingInput
  ): Promise<MemoryConsolidationFinding> {
    const parsed = updateMemoryConsolidationFindingInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryConsolidationFindingRow>(
        `${memoryConsolidationFindingSelect} WHERE id = $1 FOR UPDATE`,
        [findingId]
      );
      const current = mapMemoryConsolidationFinding(firstOrNotFound(currentResult.rows, `Memory finding ${findingId} was not found.`));
      assertMemoryConsolidationFindingTransition(current.status, parsed.status);
      const result = await client.query<MemoryConsolidationFindingRow>(
        `
          UPDATE memory_consolidation_findings SET status = $2, updated_at = $3 WHERE id = $1
          RETURNING
            id, run_id AS "runId", issue_id AS "issueId", finding_type AS "findingType",
            severity, status, confidence, record_ids AS "recordIds", source_path AS "sourcePath",
            evidence, created_at AS "createdAt", updated_at AS "updatedAt"
        `,
        [findingId, parsed.status, nowIso()]
      );
      return mapMemoryConsolidationFinding(firstOrNotFound(result.rows, `Memory finding ${findingId} was not updated.`));
    });
  }

  async listMemoryConsolidationFindings(runId: string, limit = 500): Promise<MemoryConsolidationFinding[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<MemoryConsolidationFindingRow>(
      `${memoryConsolidationFindingSelect} WHERE run_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
      [runId, boundedLimit]
    );
    return result.rows.map(mapMemoryConsolidationFinding);
  }

  async createMemoryConsolidationOperation(
    input: CreateMemoryConsolidationOperationInput
  ): Promise<MemoryConsolidationOperation> {
    const parsed = createMemoryConsolidationOperationInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const runResult = await client.query<MemoryConsolidationRunRow>(
        `${memoryConsolidationRunSelect} WHERE id = $1 FOR UPDATE`,
        [parsed.runId]
      );
      const run = mapMemoryConsolidationRun(firstOrNotFound(runResult.rows, `Memory consolidation ${parsed.runId} was not found.`));
      if (run.status !== "RUNNING") throw new SpaceConflictError(`Memory consolidation ${run.id} is not running.`);
      if (parsed.findingId) {
        const findingResult = await client.query<MemoryConsolidationFindingRow>(
          `${memoryConsolidationFindingSelect} WHERE id = $1 AND run_id = $2`,
          [parsed.findingId, parsed.runId]
        );
        firstOrNotFound(findingResult.rows, `Memory finding ${parsed.findingId} was not found.`);
      }
      const timestamp = nowIso();
      const operationId = makeSpaceId("memory_operation");
      const result = await client.query<MemoryConsolidationOperationRow>(
        `
          INSERT INTO memory_consolidation_operations (
            id, run_id, finding_id, operation_kind, status, record_ids,
            change_set_id, reason, status_reason, created_at, updated_at, applied_at
          )
          VALUES ($1, $2, $3, $4, 'PROPOSED', $5::jsonb, NULL, $6, NULL, $7, $7, NULL)
          RETURNING
            id, run_id AS "runId", finding_id AS "findingId", operation_kind AS "operationKind",
            status, record_ids AS "recordIds", change_set_id AS "changeSetId", reason,
            status_reason AS "statusReason", created_at AS "createdAt", updated_at AS "updatedAt",
            applied_at AS "appliedAt"
        `,
        [operationId, parsed.runId, parsed.findingId, parsed.operationKind, JSON.stringify(parsed.recordIds), redactMemoryText(parsed.reason), timestamp]
      );
      return mapMemoryConsolidationOperation(firstOrNotFound(result.rows, `Memory operation ${operationId} was not recorded.`));
    });
  }

  async updateMemoryConsolidationOperation(
    operationId: string,
    input: UpdateMemoryConsolidationOperationInput
  ): Promise<MemoryConsolidationOperation> {
    const parsed = updateMemoryConsolidationOperationInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryConsolidationOperationRow>(
        `${memoryConsolidationOperationSelect} WHERE id = $1 FOR UPDATE`,
        [operationId]
      );
      const current = mapMemoryConsolidationOperation(firstOrNotFound(currentResult.rows, `Memory operation ${operationId} was not found.`));
      assertMemoryConsolidationOperationTransition(current.status, parsed.status);
      const changeSetId = parsed.changeSetId === undefined ? current.changeSetId : parsed.changeSetId;
      if (
        parsed.status === "APPLIED" &&
        ["NORMALIZE_MARKER", "ARCHIVE_EXACT_DUPLICATE", "ARCHIVE_SUPERSEDED"].includes(current.operationKind) &&
        !changeSetId
      ) {
        throw new SpaceConflictError(`Memory consolidation operation ${operationId} requires an audited change set.`);
      }
      if (changeSetId) {
        const changeSetResult = await client.query<MemoryChangeSetRow>(`${memoryChangeSetSelect} WHERE id = $1`, [changeSetId]);
        firstOrNotFound(changeSetResult.rows, `Memory change set ${changeSetId} was not found.`);
      }
      const timestamp = nowIso();
      const statusReason = parsed.statusReason === undefined
        ? current.statusReason
        : parsed.statusReason === null ? null : redactMemoryText(parsed.statusReason);
      const result = await client.query<MemoryConsolidationOperationRow>(
        `
          UPDATE memory_consolidation_operations
          SET status = $2, change_set_id = $3, status_reason = $4, updated_at = $5,
              applied_at = CASE WHEN $2 = 'APPLIED' THEN $5 ELSE applied_at END
          WHERE id = $1
          RETURNING
            id, run_id AS "runId", finding_id AS "findingId", operation_kind AS "operationKind",
            status, record_ids AS "recordIds", change_set_id AS "changeSetId", reason,
            status_reason AS "statusReason", created_at AS "createdAt", updated_at AS "updatedAt",
            applied_at AS "appliedAt"
        `,
        [operationId, parsed.status, changeSetId, statusReason, timestamp]
      );
      return mapMemoryConsolidationOperation(firstOrNotFound(result.rows, `Memory operation ${operationId} was not updated.`));
    });
  }

  async listMemoryConsolidationOperations(runId: string, limit = 500): Promise<MemoryConsolidationOperation[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<MemoryConsolidationOperationRow>(
      `${memoryConsolidationOperationSelect} WHERE run_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
      [runId, boundedLimit]
    );
    return result.rows.map(mapMemoryConsolidationOperation);
  }

  async claimMemoryCommand(input: ClaimMemoryCommandInput): Promise<MemoryCommandClaim> {
    const parsed = claimMemoryCommandInputSchema.parse(input);
    const timestamp = nowIso();
    const result = await this.pool.query<MemoryCommandIdempotencyRow>(
      `
        INSERT INTO memory_command_idempotency (
          command_scope, actor_key, idempotency_key_hash, request_hash,
          resource_type, resource_id, workflow_id, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (command_scope, actor_key, idempotency_key_hash)
        DO UPDATE SET command_scope = EXCLUDED.command_scope
        RETURNING
          command_scope AS "commandScope", actor_key AS "actorKey",
          idempotency_key_hash AS "idempotencyKeyHash", request_hash AS "requestHash",
          resource_type AS "resourceType", resource_id AS "resourceId",
          workflow_id AS "workflowId", created_at AS "createdAt",
          (xmax = 0) AS "created"
      `,
      [
        parsed.commandScope, parsed.actorKey, parsed.idempotencyKeyHash, parsed.requestHash,
        parsed.resourceType, parsed.resourceId, parsed.workflowId, timestamp
      ]
    );
    const raw = firstOrNotFound(result.rows, "Memory command idempotency claim was not recorded.") as MemoryCommandIdempotencyRow & {
      created?: boolean;
    };
    const record = mapMemoryCommandIdempotency(raw);
    if (
      record.requestHash !== parsed.requestHash ||
      record.resourceType !== parsed.resourceType ||
      record.resourceId !== parsed.resourceId ||
      record.workflowId !== parsed.workflowId
    ) {
      throw new SpaceConflictError("Memory command idempotency key was reused with a different request.");
    }
    return { record, created: raw.created === true };
  }

  async createMemoryChangeSet(
    input: CreateMemoryChangeSetInput,
    traceId = makeSpaceId("trace"),
    options: CreateMemoryChangeSetOptions = {}
  ): Promise<MemoryChangeSet> {
    const parsed = normalizeMemoryChangeSetInput(input);
    return this.withTransaction(async (client) => {
      const changeSetId = options.id ? idSchema.parse(options.id) : makeSpaceId("memory_change");
      const existingResult = await client.query<MemoryChangeSetRow>(
        `${memoryChangeSetSelect} WHERE id = $1 FOR UPDATE`,
        [changeSetId]
      );
      if (existingResult.rows[0]) {
        const existing = mapMemoryChangeSet(existingResult.rows[0]);
        if (memoryChangeSetMatchesInput(existing, parsed)) return existing;
        throw new SpaceConflictError(`Memory change set ${changeSetId} already exists with different immutable input.`);
      }
      if (parsed.rollbackOfChangeSetId) {
        const targetResult = await client.query<MemoryChangeSetRow>(
          `${memoryChangeSetSelect} WHERE id = $1 FOR UPDATE`,
          [parsed.rollbackOfChangeSetId]
        );
        const target = mapMemoryChangeSet(
          firstOrNotFound(targetResult.rows, `Memory change set ${parsed.rollbackOfChangeSetId} was not found.`)
        );
        assertMemoryRollbackTarget(parsed, target);
      }
      const timestamp = nowIso();
      const result = await client.query<MemoryChangeSetRow>(
        `
          INSERT INTO memory_graph_change_sets (
            id, kind, status, source_path, record_ids, resolves_issue_ids,
            expected_source_hash, resulting_source_hash, before_content_hash, after_content_hash,
            before_snapshot, after_snapshot, reason, status_reason, actor_user_id, trace_id,
            rollback_of_change_set_id, rolled_back_by_change_set_id,
            created_at, updated_at, applied_at, failed_at, rolled_back_at
          )
          VALUES (
            $1, $2, 'PROPOSED', $3, $4, $5,
            $6, NULL, $7, $8,
            $9, $10, $11, NULL, $12, $13,
            $14, NULL,
            $15, $15, NULL, NULL, NULL
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING
            id, kind, status, source_path AS "sourcePath", record_ids AS "recordIds",
            resolves_issue_ids AS "resolvesIssueIds", expected_source_hash AS "expectedSourceHash",
            resulting_source_hash AS "resultingSourceHash", before_content_hash AS "beforeContentHash",
            after_content_hash AS "afterContentHash", before_snapshot AS "beforeSnapshot",
            after_snapshot AS "afterSnapshot", reason, status_reason AS "statusReason",
            actor_user_id AS "actorUserId", trace_id AS "traceId",
            rollback_of_change_set_id AS "rollbackOfChangeSetId",
            rolled_back_by_change_set_id AS "rolledBackByChangeSetId",
            created_at AS "createdAt", updated_at AS "updatedAt", applied_at AS "appliedAt",
            failed_at AS "failedAt", rolled_back_at AS "rolledBackAt"
        `,
        [
          changeSetId,
          parsed.kind,
          parsed.sourcePath,
          JSON.stringify(Array.from(new Set(parsed.recordIds))),
          JSON.stringify(Array.from(new Set(parsed.resolvesIssueIds))),
          parsed.expectedSourceHash,
          parsed.beforeContentHash,
          parsed.afterContentHash,
          parsed.beforeSnapshot,
          parsed.afterSnapshot,
          redactMemoryText(parsed.reason),
          parsed.actorUserId,
          traceId,
          parsed.rollbackOfChangeSetId ?? null,
          timestamp
        ]
      );
      if (result.rows[0]) return mapMemoryChangeSet(result.rows[0]);
      const racedResult = await client.query<MemoryChangeSetRow>(`${memoryChangeSetSelect} WHERE id = $1`, [changeSetId]);
      const raced = mapMemoryChangeSet(
        firstOrNotFound(racedResult.rows, `Memory change set ${changeSetId} was not recorded.`)
      );
      if (memoryChangeSetMatchesInput(raced, parsed)) return raced;
      throw new SpaceConflictError(`Memory change set ${changeSetId} already exists with different immutable input.`);
    });
  }

  async getMemoryChangeSet(changeSetId: string): Promise<MemoryChangeSet> {
    const result = await this.pool.query<MemoryChangeSetRow>(`${memoryChangeSetSelect} WHERE id = $1`, [changeSetId]);
    return mapMemoryChangeSet(firstOrNotFound(result.rows, `Memory change set ${changeSetId} was not found.`));
  }

  async updateMemoryChangeSet(changeSetId: string, input: UpdateMemoryChangeSetInput): Promise<MemoryChangeSet> {
    const parsed = updateMemoryChangeSetInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<MemoryChangeSetRow>(`${memoryChangeSetSelect} WHERE id = $1 FOR UPDATE`, [changeSetId]);
      const current = mapMemoryChangeSet(firstOrNotFound(currentResult.rows, `Memory change set ${changeSetId} was not found.`));
      assertMemoryChangeStatusTransition(current.status, parsed.status);
      const timestamp = nowIso();

      if (current.kind === "ROLLBACK" && parsed.status === "APPLIED") {
        const targetResult = await client.query<MemoryChangeSetRow>(
          `${memoryChangeSetSelect} WHERE id = $1 FOR UPDATE`,
          [current.rollbackOfChangeSetId]
        );
        const target = mapMemoryChangeSet(
          firstOrNotFound(targetResult.rows, `Memory change set ${current.rollbackOfChangeSetId} was not found.`)
        );
        if (target.status !== "APPLIED" || target.rolledBackByChangeSetId) {
          throw new SpaceConflictError(`Memory change set ${target.id} is not eligible for rollback.`);
        }
        if (parsed.resultingSourceHash !== target.expectedSourceHash) {
          throw new SpaceConflictError(`Memory rollback ${current.id} did not restore its target source hash.`);
        }
        await client.query(
          `
            UPDATE memory_graph_change_sets
            SET status = 'ROLLED_BACK', rolled_back_by_change_set_id = $2, rolled_back_at = $3, updated_at = $3
            WHERE id = $1
          `,
          [target.id, current.id, timestamp]
        );
      }

      const result = await client.query<MemoryChangeSetRow>(
        `
          UPDATE memory_graph_change_sets
          SET
            status = $2,
            resulting_source_hash = COALESCE($3, resulting_source_hash),
            status_reason = COALESCE($4, status_reason),
            updated_at = $5,
            applied_at = CASE WHEN $2 = 'APPLIED' THEN $5 ELSE applied_at END,
            failed_at = CASE WHEN $2 = 'FAILED' THEN $5 ELSE failed_at END
          WHERE id = $1
          RETURNING
            id, kind, status, source_path AS "sourcePath", record_ids AS "recordIds",
            resolves_issue_ids AS "resolvesIssueIds", expected_source_hash AS "expectedSourceHash",
            resulting_source_hash AS "resultingSourceHash", before_content_hash AS "beforeContentHash",
            after_content_hash AS "afterContentHash", before_snapshot AS "beforeSnapshot",
            after_snapshot AS "afterSnapshot", reason, status_reason AS "statusReason",
            actor_user_id AS "actorUserId", trace_id AS "traceId",
            rollback_of_change_set_id AS "rollbackOfChangeSetId",
            rolled_back_by_change_set_id AS "rolledBackByChangeSetId",
            created_at AS "createdAt", updated_at AS "updatedAt", applied_at AS "appliedAt",
            failed_at AS "failedAt", rolled_back_at AS "rolledBackAt"
        `,
        [
          changeSetId,
          parsed.status,
          parsed.resultingSourceHash ?? null,
          parsed.statusReason ? redactMemoryText(parsed.statusReason) : null,
          timestamp
        ]
      );
      return mapMemoryChangeSet(firstOrNotFound(result.rows, `Memory change set ${changeSetId} was not updated.`));
    });
  }

  async listMemoryChangeSets(
    query: ListMemoryChangeSetsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): Promise<MemoryChangeSetSummary[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    const addFilter = (column: string, value: unknown) => {
      values.push(value);
      where.push(`${column} = $${values.length}`);
    };
    if (query.kind) addFilter("kind", query.kind);
    if (query.status) addFilter("status", query.status);
    if (query.sourcePath) addFilter("source_path", query.sourcePath);
    if (query.recordId) {
      values.push(query.recordId);
      where.push(`record_ids ? $${values.length}`);
    }
    if (query.issueId) {
      values.push(query.issueId);
      where.push(`resolves_issue_ids ? $${values.length}`);
    }
    if (query.rollbackOfChangeSetId) addFilter("rollback_of_change_set_id", query.rollbackOfChangeSetId);
    const offset = (query.page - 1) * query.pageSize;
    values.push(query.pageSize, offset);
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<MemoryChangeSetSummaryRow>(
      `${memoryChangeSetSummarySelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}, id ${orderDirection} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return result.rows.map(mapMemoryChangeSetSummary);
  }

  async createArtifact(input: CreateArtifactInput, traceId = makeSpaceId("trace")): Promise<ArtifactRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeArtifactInput(input);
      if (normalized.roomId) {
        await this.getRoomForUpdate(client, normalized.roomId);
      }
      const artifactId = makeSpaceId("artifact");
      const result = await client.query<ArtifactRow>(
        `
          INSERT INTO artifacts (
            id,
            room_id,
            pane_id,
            turn_id,
            workflow_id,
            kind,
            mime_type,
            storage_uri,
            sha256,
            byte_size,
            metadata,
            expires_at,
            pinned_at,
            deleted_at,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING
            id,
            room_id AS "roomId",
            pane_id AS "paneId",
            turn_id AS "turnId",
            workflow_id AS "workflowId",
            kind,
            mime_type AS "mimeType",
            storage_uri AS "storageUri",
            sha256,
            byte_size AS "byteSize",
            metadata,
            expires_at AS "expiresAt",
            pinned_at AS "pinnedAt",
            deleted_at AS "deletedAt",
            created_at AS "createdAt"
        `,
        [
          artifactId,
          normalized.roomId,
          normalized.paneId,
          normalized.turnId,
          normalized.workflowId,
          normalized.kind,
          normalized.mimeType,
          normalized.storageUri,
          normalized.sha256,
          normalized.byteSize,
          JSON.stringify(normalized.metadata),
          normalized.expiresAt ?? null,
          normalized.pinnedAt ?? null,
          normalized.deletedAt ?? null,
          timestamp
        ]
      );
      const artifact = mapArtifact(firstOrNotFound(result.rows, `Artifact ${artifactId} was not recorded.`));
      if (artifact.roomId) {
        await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [artifact.roomId, timestamp]);
      }
      const event = await this.appendEvent(client, {
        roomId: artifact.roomId,
        paneId: artifact.paneId,
        turnId: artifact.turnId,
        workflowId: artifact.workflowId,
        traceId,
        type: "ARTIFACT_CREATED",
        message: `Artifact ${artifact.kind} registered.`,
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          storageUri: artifact.storageUri,
          byteSize: artifact.byteSize
        }
      });
      return { artifact, event };
    });
  }

  async listArtifacts(query: ListArtifactsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): Promise<Artifact[]> {
    const where: string[] = ["deleted_at IS NULL"];
    const values: unknown[] = [];
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    if (query.paneId) {
      values.push(query.paneId);
      where.push(`pane_id = $${values.length}`);
    }
    if (query.workflowId) {
      values.push(query.workflowId);
      where.push(`workflow_id = $${values.length}`);
    }
    if (query.kind) {
      values.push(query.kind);
      where.push(`kind = $${values.length}`);
    }
    if (query.collection === "AGENT_FILES") {
      where.push("storage_uri LIKE 'space-artifact://agent-files/%'");
    }
    if (query.collection === "ROOM_MEDIA") {
      where.push(
        "(storage_uri LIKE 'space-artifact://user-uploads/%' OR " +
        "storage_uri LIKE 'space-artifact://cli-uploads/%' OR " +
        "(storage_uri LIKE 'space-artifact://browser-evidence/%' AND kind IN ('IMAGE', 'SCREENSHOT', 'VIDEO')))"
      );
    }
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<ArtifactRow>(
      `${artifactSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}`,
      values
    );
    return result.rows.map(mapArtifact);
  }

  async getArtifact(artifactId: string): Promise<Artifact> {
    const result = await this.pool.query<ArtifactRow>(`${artifactSelect} WHERE id = $1`, [artifactId]);
    return mapArtifact(firstOrNotFound(result.rows, `Artifact ${artifactId} was not found.`));
  }

  async updateArtifactRetention(artifactId: string, input: UpdateArtifactRetentionInput): Promise<Artifact> {
    const parsed = updateArtifactRetentionInputSchema.parse(input);
    return this.withTransaction(async (client) => {
      const currentResult = await client.query<ArtifactRow>(`${artifactSelect} WHERE id = $1 FOR UPDATE`, [artifactId]);
      const current = mapArtifact(firstOrNotFound(currentResult.rows, `Artifact ${artifactId} was not found.`));
      const result = await client.query<ArtifactRow>(
        `
          UPDATE artifacts
          SET expires_at = $2, pinned_at = $3, deleted_at = $4
          WHERE id = $1
          RETURNING
            id, room_id AS "roomId", pane_id AS "paneId", turn_id AS "turnId", workflow_id AS "workflowId",
            kind, mime_type AS "mimeType", storage_uri AS "storageUri", sha256, byte_size AS "byteSize", metadata,
            expires_at AS "expiresAt", pinned_at AS "pinnedAt", deleted_at AS "deletedAt", created_at AS "createdAt"
        `,
        [
          artifactId,
          parsed.expiresAt === undefined ? current.expiresAt : parsed.expiresAt,
          parsed.pinnedAt === undefined ? current.pinnedAt : parsed.pinnedAt,
          parsed.deletedAt === undefined ? current.deletedAt : parsed.deletedAt
        ]
      );
      return mapArtifact(firstOrNotFound(result.rows, `Artifact ${artifactId} was not updated.`));
    });
  }

  async deleteExpiredBrowserArtifacts(at = nowIso()): Promise<Artifact[]> {
    const result = await this.pool.query<ArtifactRow>(
      `
        UPDATE artifacts
        SET deleted_at = $1
        WHERE expires_at IS NOT NULL
          AND expires_at <= $1
          AND pinned_at IS NULL
          AND deleted_at IS NULL
        RETURNING
          id, room_id AS "roomId", pane_id AS "paneId", turn_id AS "turnId", workflow_id AS "workflowId",
          kind, mime_type AS "mimeType", storage_uri AS "storageUri", sha256, byte_size AS "byteSize", metadata,
          expires_at AS "expiresAt", pinned_at AS "pinnedAt", deleted_at AS "deletedAt", created_at AS "createdAt"
      `,
      [at]
    );
    return result.rows.map(mapArtifact);
  }

  async deleteArtifact(artifactId: string): Promise<Artifact> {
    return this.withTransaction(async (client) => {
      const result = await client.query<ArtifactRow>(`${artifactSelect} WHERE id = $1 FOR UPDATE`, [artifactId]);
      const artifact = mapArtifact(firstOrNotFound(result.rows, `Artifact ${artifactId} was not found.`));
      await client.query("DELETE FROM artifacts WHERE id = $1", [artifactId]);
      if (artifact.roomId) {
        await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [artifact.roomId, nowIso()]);
      }
      return artifact;
    });
  }

  async createReviewDecision(input: CreateReviewDecisionInput, traceId = makeSpaceId("trace")): Promise<ReviewDecisionRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      await this.getRoomForUpdate(client, input.roomId);
      const reviewDecisionId = makeSpaceId("review");
      const evidenceArtifactIds = Array.from(new Set(input.evidenceArtifactIds));
      const result = await client.query<ReviewDecisionRow>(
        `
          INSERT INTO review_decisions (
            id,
            room_id,
            workflow_id,
            decision,
            summary,
            evidence_artifact_ids,
            rollback_note,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            id,
            room_id AS "roomId",
            workflow_id AS "workflowId",
            decision,
            summary,
            evidence_artifact_ids AS "evidenceArtifactIds",
            rollback_note AS "rollbackNote",
            created_at AS "createdAt"
        `,
        [
          reviewDecisionId,
          input.roomId,
          input.workflowId ?? null,
          input.decision,
          redactMemoryText(input.summary),
          JSON.stringify(evidenceArtifactIds),
          redactMemoryText(input.rollbackNote),
          timestamp
        ]
      );
      const decision = mapReviewDecision(firstOrNotFound(result.rows, `Review decision ${reviewDecisionId} was not recorded.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [decision.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: decision.roomId,
        paneId: null,
        turnId: null,
        workflowId: decision.workflowId,
        traceId,
        type: "REVIEW_DECISION_CREATED",
        message: `Review decision ${decision.decision} recorded.`,
        payload: {
          reviewDecisionId: decision.id,
          decision: decision.decision,
          evidenceArtifactCount: decision.evidenceArtifactIds.length
        }
      });
      return { decision, event };
    });
  }

  async listReviewDecisions(query: ListReviewDecisionsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): Promise<ReviewDecision[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<ReviewDecisionRow>(
      `${reviewDecisionSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}`,
      values
    );
    return result.rows.map(mapReviewDecision);
  }

  async createReviewCheck(input: CreateReviewCheckInput, traceId = makeSpaceId("trace")): Promise<ReviewCheckRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      await this.getRoomForUpdate(client, input.roomId);
      const reviewCheckId = makeSpaceId("review_check");
      const artifactIds = Array.from(new Set(input.artifactIds));
      const result = await client.query<ReviewCheckRow>(
        `
          INSERT INTO review_checks (
            id,
            room_id,
            review_decision_id,
            name,
            status,
            command,
            summary,
            artifact_ids,
            metadata,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING
            id,
            room_id AS "roomId",
            review_decision_id AS "reviewDecisionId",
            name,
            status,
            command,
            summary,
            artifact_ids AS "artifactIds",
            metadata,
            created_at AS "createdAt"
        `,
        [
          reviewCheckId,
          input.roomId,
          input.reviewDecisionId ?? null,
          redactMemoryText(input.name),
          input.status,
          input.command ? redactMemoryText(input.command) : null,
          redactMemoryText(input.summary),
          JSON.stringify(artifactIds),
          JSON.stringify(redactArtifactMetadata(input.metadata ?? {})),
          timestamp
        ]
      );
      const check = mapReviewCheck(firstOrNotFound(result.rows, `Review check ${reviewCheckId} was not recorded.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [check.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: check.roomId,
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId,
        type: "REVIEW_CHECK_RECORDED",
        message: `Review check ${check.status} recorded.`,
        payload: {
          reviewCheckId: check.id,
          reviewDecisionId: check.reviewDecisionId,
          status: check.status,
          artifactCount: check.artifactIds.length
        }
      });
      return { check, event };
    });
  }

  async listReviewChecks(query: ListReviewChecksQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): Promise<ReviewCheck[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    if (query.reviewDecisionId) {
      values.push(query.reviewDecisionId);
      where.push(`review_decision_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<ReviewCheckRow>(
      `${reviewCheckSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}`,
      values
    );
    return result.rows.map(mapReviewCheck);
  }

  async createReviewDiffSummary(input: CreateReviewDiffSummaryInput, traceId = makeSpaceId("trace")): Promise<ReviewDiffSummaryRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      await this.getRoomForUpdate(client, input.roomId);
      const reviewDiffId = makeSpaceId("review_diff");
      const result = await client.query<ReviewDiffSummaryRow>(
        `
          INSERT INTO review_diff_summaries (
            id,
            room_id,
            review_decision_id,
            title,
            file_path,
            status,
            additions,
            deletions,
            patch_artifact_id,
            summary,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
            id,
            room_id AS "roomId",
            review_decision_id AS "reviewDecisionId",
            title,
            file_path AS "filePath",
            status,
            additions,
            deletions,
            patch_artifact_id AS "patchArtifactId",
            summary,
            created_at AS "createdAt"
        `,
        [
          reviewDiffId,
          input.roomId,
          input.reviewDecisionId ?? null,
          redactMemoryText(input.title),
          input.filePath,
          input.status,
          input.additions,
          input.deletions,
          input.patchArtifactId ?? null,
          redactMemoryText(input.summary),
          timestamp
        ]
      );
      const diff = mapReviewDiffSummary(firstOrNotFound(result.rows, `Review diff ${reviewDiffId} was not recorded.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [diff.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: diff.roomId,
        paneId: null,
        turnId: null,
        workflowId: null,
        traceId,
        type: "REVIEW_DIFF_RECORDED",
        message: `Review diff ${diff.status} recorded.`,
        payload: {
          reviewDiffId: diff.id,
          reviewDecisionId: diff.reviewDecisionId,
          status: diff.status,
          additions: diff.additions,
          deletions: diff.deletions,
          patchArtifactId: diff.patchArtifactId
        }
      });
      return { diff, event };
    });
  }

  async listReviewDiffSummaries(
    query: ListReviewDiffSummariesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): Promise<ReviewDiffSummary[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    if (query.reviewDecisionId) {
      values.push(query.reviewDecisionId);
      where.push(`review_decision_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<ReviewDiffSummaryRow>(
      `${reviewDiffSummarySelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}`,
      values
    );
    return result.rows.map(mapReviewDiffSummary);
  }

  async listSwarmTasks(query: ListSwarmTasksQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): Promise<SwarmTask[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.roomId) {
      values.push(query.roomId);
      where.push(`room_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.role) {
      values.push(query.role);
      where.push(`role = $${values.length}`);
    }
    const orderDirection = query.sortOrder === "asc" ? "ASC" : "DESC";
    const result = await this.pool.query<SwarmTaskRow>(
      `${swarmTaskSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ${orderDirection}`,
      values
    );
    return result.rows.map(mapSwarmTask);
  }

  async createSwarmTask(input: CreateSwarmTaskInput, traceId = makeSpaceId("trace")): Promise<SwarmTaskRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeSwarmTaskInput(input);
      await this.getRoomForUpdate(client, normalized.roomId);
      if (normalized.parentTaskId) {
        await this.getSwarmTaskForUpdate(client, normalized.parentTaskId, normalized.roomId);
      }
      for (const dependencyId of normalized.dependsOnTaskIds) {
        await this.getSwarmTaskForUpdate(client, dependencyId, normalized.roomId);
      }
      const taskId = makeSpaceId("swarm_task");
      const result = await client.query<SwarmTaskRow>(
        `
          INSERT INTO swarm_tasks (
            id,
            room_id,
            parent_task_id,
            role,
            title,
            goal,
            status,
            assignee,
            depends_on_task_ids,
            lock_ids,
            result_summary,
            created_at,
            updated_at,
            completed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'PLANNED', $7, $8, '[]'::jsonb, NULL, $9, $9, NULL)
          RETURNING
            id,
            room_id AS "roomId",
            parent_task_id AS "parentTaskId",
            role,
            title,
            goal,
            status,
            assignee,
            depends_on_task_ids AS "dependsOnTaskIds",
            lock_ids AS "lockIds",
            result_summary AS "resultSummary",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            completed_at AS "completedAt"
        `,
        [
          taskId,
          normalized.roomId,
          normalized.parentTaskId ?? null,
          normalized.role,
          normalized.title,
          normalized.goal,
          normalized.assignee ?? null,
          JSON.stringify(normalized.dependsOnTaskIds),
          timestamp
        ]
      );
      const task = mapSwarmTask(firstOrNotFound(result.rows, `Swarm task ${taskId} was not created.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [task.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: task.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_TASK_CREATED",
        message: `Swarm task ${task.title} created.`,
        payload: {
          taskId: task.id,
          role: task.role,
          status: task.status,
          parentTaskId: task.parentTaskId,
          dependencyCount: task.dependsOnTaskIds.length
        }
      });
      return { task, event };
    });
  }

  async updateSwarmTask(taskId: string, input: UpdateSwarmTaskInput, traceId = makeSpaceId("trace")): Promise<SwarmTaskRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const current = await this.getSwarmTaskForUpdate(client, taskId);
      const normalized = normalizeSwarmTaskUpdate(input);
      const dependsOnTaskIds = normalized.dependsOnTaskIds ?? current.dependsOnTaskIds;
      const lockIds = normalized.lockIds ?? current.lockIds;
      for (const dependencyId of dependsOnTaskIds) {
        await this.getSwarmTaskForUpdate(client, dependencyId, current.roomId);
      }
      for (const lockId of lockIds) {
        await this.getSwarmLockForUpdate(client, lockId, current.roomId);
      }
      const status = normalized.status ?? current.status;
      const completedAt = status === "DONE" ? current.completedAt ?? timestamp : normalized.status ? null : current.completedAt;
      const result = await client.query<SwarmTaskRow>(
        `
          UPDATE swarm_tasks
          SET
            status = $2,
            assignee = $3,
            depends_on_task_ids = $4,
            lock_ids = $5,
            result_summary = $6,
            updated_at = $7,
            completed_at = $8
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            parent_task_id AS "parentTaskId",
            role,
            title,
            goal,
            status,
            assignee,
            depends_on_task_ids AS "dependsOnTaskIds",
            lock_ids AS "lockIds",
            result_summary AS "resultSummary",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            completed_at AS "completedAt"
        `,
        [
          current.id,
          status,
          normalized.assignee === undefined ? current.assignee : normalized.assignee,
          JSON.stringify(dependsOnTaskIds),
          JSON.stringify(lockIds),
          normalized.resultSummary === undefined ? current.resultSummary : normalized.resultSummary,
          timestamp,
          completedAt
        ]
      );
      const task = mapSwarmTask(firstOrNotFound(result.rows, `Swarm task ${taskId} was not updated.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [task.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: task.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_TASK_UPDATED",
        message: `Swarm task ${task.title} updated.`,
        payload: {
          taskId: task.id,
          role: task.role,
          status: task.status,
          lockCount: task.lockIds.length,
          dependencyCount: task.dependsOnTaskIds.length
        }
      });
      return { task, event };
    });
  }

  async claimSwarmLock(input: ClaimSwarmLockInput, traceId = makeSpaceId("trace")): Promise<SwarmLockRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeSwarmLockInput(input);
      await this.getRoomForUpdate(client, normalized.roomId);
      if (normalized.taskId) {
        await this.getSwarmTaskForUpdate(client, normalized.taskId, normalized.roomId);
      }
      const existing = await client.query<SwarmLockRow>(
        `${swarmLockSelect} WHERE room_id = $1 AND resource = $2 AND status = 'ACTIVE' FOR UPDATE`,
        [normalized.roomId, normalized.resource]
      );
      if (existing.rows[0]) {
        const conflict = mapSwarmLock(existing.rows[0]);
        throw new SpaceConflictError(`Swarm resource ${normalized.resource} is already locked by ${conflict.holder}.`);
      }
      const lockId = makeSpaceId("swarm_lock");
      const result = await client.query<SwarmLockRow>(
        `
          INSERT INTO swarm_locks (id, room_id, task_id, resource, status, holder, reason, created_at, released_at)
          VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, NULL)
          RETURNING
            id,
            room_id AS "roomId",
            task_id AS "taskId",
            resource,
            status,
            holder,
            reason,
            created_at AS "createdAt",
            released_at AS "releasedAt"
        `,
        [lockId, normalized.roomId, normalized.taskId ?? null, normalized.resource, normalized.holder, normalized.reason, timestamp]
      );
      const lock = mapSwarmLock(firstOrNotFound(result.rows, `Swarm lock ${lockId} was not created.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [lock.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: lock.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_LOCK_CLAIMED",
        message: `Swarm lock claimed for ${lock.resource}.`,
        payload: { lockId: lock.id, taskId: lock.taskId, resource: lock.resource, holder: lock.holder }
      });
      return { lock, event };
    });
  }

  async releaseSwarmLock(
    lockId: string,
    input: ReleaseSwarmLockInput = { reason: "Released by operator." },
    traceId = makeSpaceId("trace")
  ): Promise<SwarmLockRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const current = await this.getSwarmLockForUpdate(client, lockId);
      if (current.status !== "ACTIVE") {
        throw new SpaceConflictError(`Swarm lock ${lockId} is already ${current.status}.`);
      }
      const result = await client.query<SwarmLockRow>(
        `
          UPDATE swarm_locks
          SET status = 'RELEASED',
              released_at = $2
          WHERE id = $1
          RETURNING
            id,
            room_id AS "roomId",
            task_id AS "taskId",
            resource,
            status,
            holder,
            reason,
            created_at AS "createdAt",
            released_at AS "releasedAt"
        `,
        [lockId, timestamp]
      );
      const lock = mapSwarmLock(firstOrNotFound(result.rows, `Swarm lock ${lockId} was not released.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [lock.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: lock.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_LOCK_RELEASED",
        message: `Swarm lock released for ${lock.resource}.`,
        payload: {
          lockId: lock.id,
          resource: lock.resource,
          holder: lock.holder,
          releaseReason: redactMemoryText(input.reason)
        }
      });
      return { lock, event };
    });
  }

  async postSwarmMessage(input: PostSwarmMessageInput, traceId = makeSpaceId("trace")): Promise<SwarmMessageRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeSwarmMessageInput(input);
      await this.getRoomForUpdate(client, normalized.roomId);
      if (normalized.taskId) {
        await this.getSwarmTaskForUpdate(client, normalized.taskId, normalized.roomId);
      }
      const messageId = makeSpaceId("swarm_msg");
      const result = await client.query<SwarmMessageRow>(
        `
          INSERT INTO swarm_messages (id, room_id, task_id, from_role, to_role, body, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING
            id,
            room_id AS "roomId",
            task_id AS "taskId",
            from_role AS "fromRole",
            to_role AS "toRole",
            body,
            created_at AS "createdAt"
        `,
        [
          messageId,
          normalized.roomId,
          normalized.taskId ?? null,
          normalized.fromRole,
          normalized.toRole ?? null,
          normalized.body,
          timestamp
        ]
      );
      const message = mapSwarmMessage(firstOrNotFound(result.rows, `Swarm message ${messageId} was not created.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [message.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: message.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_MESSAGE_POSTED",
        message: `Swarm message posted by ${message.fromRole}.`,
        payload: { messageId: message.id, taskId: message.taskId, fromRole: message.fromRole, toRole: message.toRole }
      });
      return { message, event };
    });
  }

  async createSwarmReconcile(input: CreateSwarmReconcileInput, traceId = makeSpaceId("trace")): Promise<SwarmReconcileRecord> {
    return this.withTransaction(async (client) => {
      const timestamp = nowIso();
      const normalized = normalizeSwarmReconcileInput(input);
      await this.getRoomForUpdate(client, normalized.roomId);
      for (const taskId of normalized.taskIds) {
        await this.getSwarmTaskForUpdate(client, taskId, normalized.roomId);
      }
      const reconcileId = makeSpaceId("swarm_reconcile");
      const result = await client.query<SwarmReconcileRow>(
        `
          INSERT INTO swarm_reconciles (id, room_id, task_ids, decision, summary, next_steps, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING
            id,
            room_id AS "roomId",
            task_ids AS "taskIds",
            decision,
            summary,
            next_steps AS "nextSteps",
            created_at AS "createdAt"
        `,
        [
          reconcileId,
          normalized.roomId,
          JSON.stringify(normalized.taskIds),
          normalized.decision,
          normalized.summary,
          normalized.nextSteps,
          timestamp
        ]
      );
      const reconcile = mapSwarmReconcile(firstOrNotFound(result.rows, `Swarm reconcile ${reconcileId} was not created.`));
      await client.query("UPDATE rooms SET updated_at = $2 WHERE id = $1", [reconcile.roomId, timestamp]);
      const event = await this.appendEvent(client, {
        roomId: reconcile.roomId,
        paneId: null,
        turnId: null,
        traceId,
        type: "SWARM_RECONCILED",
        message: `Swarm reconcile ${reconcile.decision.toLowerCase()} recorded.`,
        payload: { reconcileId: reconcile.id, taskIds: reconcile.taskIds, decision: reconcile.decision }
      });
      return { reconcile, event };
    });
  }

  async getSwarmState(roomId?: string): Promise<SwarmState> {
    if (roomId) {
      await this.getRoom(roomId);
    }
    const taskQuery: ListSwarmTasksQuery = { page: 1, pageSize: 100, sortOrder: "desc", roomId };
    const taskPromise = this.listSwarmTasks(taskQuery);
    const lockPromise = roomId
      ? this.pool.query<SwarmLockRow>(`${swarmLockSelect} WHERE room_id = $1 ORDER BY status ASC, created_at DESC`, [roomId])
      : this.pool.query<SwarmLockRow>(`${swarmLockSelect} ORDER BY status ASC, created_at DESC`);
    const messagePromise = roomId
      ? this.pool.query<SwarmMessageRow>(`${swarmMessageSelect} WHERE room_id = $1 ORDER BY created_at DESC`, [roomId])
      : this.pool.query<SwarmMessageRow>(`${swarmMessageSelect} ORDER BY created_at DESC`);
    const reconcilePromise = roomId
      ? this.pool.query<SwarmReconcileRow>(`${swarmReconcileSelect} WHERE room_id = $1 ORDER BY created_at DESC`, [roomId])
      : this.pool.query<SwarmReconcileRow>(`${swarmReconcileSelect} ORDER BY created_at DESC`);
    const [tasks, locks, messages, reconciles] = await Promise.all([
      taskPromise,
      lockPromise,
      messagePromise,
      reconcilePromise
    ]);
    return swarmStateSchema.parse({
      tasks,
      locks: locks.rows.map(mapSwarmLock),
      messages: messages.rows.map(mapSwarmMessage),
      reconciles: reconciles.rows.map(mapSwarmReconcile),
      executionStatus: "DISABLED",
      statusReason: "Swarm execution is control-plane only until worker/agent smoke is explicitly approved and verified."
    });
  }

  private async readPersistedMcpServers(): Promise<McpServer[]> {
    const result = await this.pool.query<McpServerRow>(`${mcpServerSelect} ORDER BY id ASC`);
    return result.rows.map(mapMcpServer);
  }

  private async readPersistedMcpTools(): Promise<McpTool[]> {
    const result = await this.pool.query<McpToolRow>(`${mcpToolSelect} ORDER BY server_id ASC, name ASC`);
    return result.rows.map(mapMcpTool);
  }

  async dispose(): Promise<void> {
    const maybeEnd = (this.pool as PgPoolLike & { end?: () => Promise<void> }).end;
    if (maybeEnd) {
      await maybeEnd.call(this.pool);
    }
  }

  private async getRoomForUpdate(client: PgClientLike, roomId: string): Promise<Room> {
    const result = await client.query<RoomRow>(`${roomSelect} WHERE id = $1 FOR UPDATE`, [roomId]);
    return mapRoom(firstOrNotFound(result.rows, `Room ${roomId} was not found.`));
  }

  private async getPaneForUpdate(client: PgClientLike, paneId: string): Promise<Pane> {
    const result = await client.query<PaneRow>(`${paneSelect} WHERE id = $1 FOR UPDATE`, [paneId]);
    return mapPane(firstOrNotFound(result.rows, `Pane ${paneId} was not found.`));
  }

  private async getNextOpenPaneOrder(client: PgClientLike, roomId: string): Promise<number> {
    const result = await client.query<OrderRow>(
      `SELECT COALESCE(MAX(pane_order), -1) + 1 AS "nextOrder" FROM panes WHERE room_id = $1 AND is_closed = false`,
      [roomId]
    );
    return orderValue(result.rows);
  }

  private async reassignPaneRoomReferences(
    client: PgClientLike,
    paneId: string,
    targetRoomId: string,
    timestamp: string
  ): Promise<void> {
    await client.query(`UPDATE pane_agent_sessions SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE space_agent_sessions SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE space_agent_runs SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE pane_cli_sessions SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE pane_cli_terminal_control_leases SET room_id = $2 WHERE pane_id = $1`, [
      paneId,
      targetRoomId
    ]);
    await client.query(`UPDATE pane_cli_transcript_chunks SET room_id = $2 WHERE pane_id = $1`, [paneId, targetRoomId]);
    await client.query(`UPDATE pane_cli_codex_thread_ownerships SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE pane_browser_sessions SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [
      paneId,
      targetRoomId,
      timestamp
    ]);
    await client.query(`UPDATE workflows SET room_id = $2 WHERE pane_id = $1`, [paneId, targetRoomId]);
    await client.query(`UPDATE turns SET room_id = $2, updated_at = $3 WHERE pane_id = $1`, [paneId, targetRoomId, timestamp]);
    await client.query(`UPDATE events SET room_id = $2 WHERE pane_id = $1`, [paneId, targetRoomId]);
    await client.query(`UPDATE artifacts SET room_id = $2 WHERE pane_id = $1`, [paneId, targetRoomId]);
  }

  private async assertActiveCodexThreadAvailable(client: PgClientLike, sessionId: string, codexThreadId: string): Promise<void> {
    const result = await client.query<PaneCliSessionRow>(
      `${paneCliSessionSelect} WHERE codex_thread_id = $1 AND is_active = true AND session_id <> $2 ORDER BY started_at ASC, updated_at ASC, session_id ASC LIMIT 1 FOR UPDATE`,
      [codexThreadId, sessionId]
    );
    const owner = result.rows[0] ? mapPaneCliSession(result.rows[0]) : null;
    if (owner) {
      throw new SpaceConflictError(`Codex thread ${codexThreadId} is already owned by active CLI session ${owner.sessionId}.`);
    }
  }

  private async getSwarmTaskForUpdate(client: PgClientLike, taskId: string, roomId?: string): Promise<SwarmTask> {
    const result = roomId
      ? await client.query<SwarmTaskRow>(`${swarmTaskSelect} WHERE id = $1 AND room_id = $2 FOR UPDATE`, [taskId, roomId])
      : await client.query<SwarmTaskRow>(`${swarmTaskSelect} WHERE id = $1 FOR UPDATE`, [taskId]);
    return mapSwarmTask(firstOrNotFound(result.rows, `Swarm task ${taskId} was not found.`));
  }

  private async getSwarmLockForUpdate(client: PgClientLike, lockId: string, roomId?: string): Promise<SwarmLock> {
    const result = roomId
      ? await client.query<SwarmLockRow>(`${swarmLockSelect} WHERE id = $1 AND room_id = $2 FOR UPDATE`, [lockId, roomId])
      : await client.query<SwarmLockRow>(`${swarmLockSelect} WHERE id = $1 FOR UPDATE`, [lockId]);
    return mapSwarmLock(firstOrNotFound(result.rows, `Swarm lock ${lockId} was not found.`));
  }

  private async createStarterRoom(client: PgClientLike, traceId: string): Promise<Room> {
    const timestamp = nowIso();
    const roomId = makeSpaceId("room");
    const orderResult = await client.query<OrderRow>(
      "SELECT COALESCE(MAX(room_order), -1) + 1 AS \"nextOrder\" FROM rooms"
    );
    const result = await client.query<RoomRow>(
      `
        INSERT INTO rooms (id, name, description, room_order, pane_cap, trace_id, created_at, updated_at, kind)
        VALUES ($1, 'Getting Started', 'SpaceApp setup and connection workspace.', $2, $3, $4, $5, $5, 'WORKSPACE')
        RETURNING
          id,
          name,
          description,
          kind,
          room_order AS "order",
          pane_layout_columns AS "paneLayoutColumns",
          pane_cap AS "paneCap",
          trace_id AS "traceId",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        roomId,
        Number.parseInt(String(orderResult.rows[0]?.nextOrder ?? 0), 10),
        ACTIVE_PANE_CAP,
        traceId,
        timestamp
      ]
    );
    const room = mapRoom(firstOrNotFound(result.rows, `Room ${roomId} was not created.`));
    await this.appendEvent(client, {
      roomId: room.id,
      paneId: null,
      turnId: null,
      traceId,
      type: "ROOM_CREATED",
      message: `Room ${room.name} created.`,
      payload: { initialPaneCount: 0 }
    });
    return room;
  }

  private async insertPane(
    client: PgClientLike,
    input: CreatePaneInput,
    order: number,
    _traceId: string,
    timestamp: string
  ): Promise<Pane> {
    const paneId = makeSpaceId("pane");
    const split = input.split ?? { parentId: null, direction: null, size: null };
    const result = await client.query<PaneRow>(
      `
        INSERT INTO panes (
          id,
          room_id,
          title,
          mode,
          status,
          provider_id,
          model_id,
          terminal_runtime_id,
          reasoning_effort,
          cwd,
          pane_order,
          column_span,
          is_maximized,
          is_minimized,
          is_closed,
          split,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'IDLE', $5, $6, $7, 'medium', $8, $9, 1, false, false, false, $10, $11, $11)
        RETURNING
          id,
          room_id AS "roomId",
          title,
          mode,
          status,
          provider_id AS "providerId",
          model_id AS "modelId",
          terminal_runtime_id AS "terminalRuntimeId",
          reasoning_effort AS "reasoningEffort",
          cwd,
          pane_order AS "order",
          column_span AS "columnSpan",
          is_maximized AS "isMaximized",
          is_minimized AS "isMinimized",
          is_closed AS "isClosed",
          split,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        paneId,
        input.roomId,
        input.title,
        input.mode,
        input.providerId ?? null,
        input.modelId ?? null,
        input.terminalRuntimeId ?? null,
        input.cwd ?? null,
        order,
        JSON.stringify(split),
        timestamp
      ]
    );
    return mapPane(firstOrNotFound(result.rows, `Pane ${paneId} was not created.`));
  }

  private async appendEvent(
    client: PgClientLike,
    input: Omit<Event, "id" | "createdAt" | "workflowId"> & { workflowId?: string | null }
  ): Promise<Event> {
    const eventId = makeSpaceId("event");
    const result = await client.query<EventRow>(
      `
        INSERT INTO events (id, room_id, pane_id, turn_id, workflow_id, trace_id, event_type, message, payload, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id,
          room_id AS "roomId",
          pane_id AS "paneId",
          turn_id AS "turnId",
          workflow_id AS "workflowId",
          trace_id AS "traceId",
          event_type AS type,
          message,
          payload,
          created_at AS "createdAt"
      `,
      [
        eventId,
        input.roomId,
        input.paneId,
        input.turnId,
        input.workflowId ?? null,
        input.traceId,
        input.type,
        input.message,
        JSON.stringify(input.payload),
        nowIso()
      ]
    );
    return mapEvent(firstOrNotFound(result.rows, `Event ${eventId} was not created.`));
  }

  private async withTransaction<T>(
    work: (client: PgClientLike) => Promise<T>,
    options: { deadlockRetries?: number } = {}
  ): Promise<T> {
    const deadlockRetries = Math.max(0, Math.trunc(options.deadlockRetries ?? 0));
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        const isDeadlock =
          typeof error === "object" && error !== null && "code" in error && error.code === "40P01";
        if (!isDeadlock || attempt >= deadlockRetries) {
          throw error;
        }
      } finally {
        client.release?.();
      }
    }
  }
}

export function validateArtifactShapeForStore(input: unknown) {
  return artifactSchema.parse(input);
}
