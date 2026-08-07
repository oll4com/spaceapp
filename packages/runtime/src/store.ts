import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  adminOperationRunSchema,
  agentPaneBindingSchema,
  agentPaneStoredSessionSchema,
  agentToolAssignmentSchema,
  artifactSchema,
  authUserSchema,
  browserCaptureJobSchema,
  browserCaptureSegmentSchema,
  browserControlLeaseSchema,
  browserHandoffRequestSchema,
  clipboardItemSchema,
  cliMaintenanceAuthHandoffSchema,
  cliMaintenanceDiagnosticsSchema,
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
  createBrowserCaptureJobInputSchema,
  createBrowserCaptureSegmentInputSchema,
  createBrowserControlLeaseInputSchema,
  createBrowserHandoffRequestInputSchema,
  createMemoryChangeSetInputSchema,
  claimMemoryCommandInputSchema,
  createMemoryConsolidationFindingInputSchema,
  createMemoryConsolidationOperationInputSchema,
  createMemoryConsolidationRunInputSchema,
  idSchema,
  isAgentFileArtifact,
  isRoomMediaArtifact,
  isoDateTimeSchema,
  createPaneBrowserSessionInputSchema,
  createPaneCliSessionInputSchema,
  createPaneCliHostOutputInputSchema,
  createPaneCliTerminalControlLeaseInputSchema,
  createPaneCliTranscriptChunkInputSchema,
  createRoomAgentActionInputSchema,
  createRoomAgentMissionInputSchema,
  createRoomAgentRequestInputSchema,
  movePaneInputSchema,
  createSpaceAgentMessageInputSchema,
  createSpaceAgentRunInputSchema,
  createSpaceAgentSessionInputSchema,
  createProviderInputSchema,
  modelSchema,
  memoryChangeSetSchema,
  memoryChangeSetSummarySchema,
  linkMemoryCacheInputSchema,
  listClipboardItemsQuerySchema,
  listTaskItemsQuerySchema,
  taskItemSchema,
  updateTaskItemInputSchema,
  upsertTaskItemInputSchema,
  listUserLinksQuerySchema,
  listMemoryCacheLinksQuerySchema,
  memoryCacheLinkSchema,
  memoryCommandIdempotencySchema,
  memoryConsolidationFindingSchema,
  memoryConsolidationOperationSchema,
  memoryConsolidationRunSchema,
  memoryIssueStateSchema,
  paneBrowserSessionSchema,
  paneSchema,
  paneCliSessionSchema,
  paneCliTerminalControlLeaseSchema,
  paneCliCodexThreadOwnershipSchema,
  paneCliTranscriptChunkSchema,
  providerSettingsSchema,
  providerSchema,
  releasePreviewSchema,
  roomAgentActionRecordSchema,
  roomAgentMissionRecordSchema,
  roomAgentRequestRecordSchema,
  roomAgentTaskRunRecordSchema,
  roomAgentSupervisorQueueItemSchema,
  redactPersistedTranscriptContent,
  setupConnectionCheckEventSchema,
  setupConnectionCheckRunSchema,
  spaceAgentMessageRecordSchema,
  spaceAgentRunRecordSchema,
  spaceAgentSessionRecordSchema,
  sourceControlConnectionSchema,
  sourceControlProviderSchema,
  updateProviderInputSchema,
  updateProviderSettingsInputSchema,
  updateCodexCliModeDefaultsInputSchema,
  updateCliRuntimeSettingInputSchema,
  updateCliRuntimeVpnInputSchema,
  updateAdminOperationRunInputSchema,
  updateCliMaintenanceAuthHandoffInputSchema,
  updatePaneCliSessionInputSchema,
  updatePaneCliTerminalControlLeaseInputSchema,
  updateRoomAgentActionInputSchema,
  updateRoomAgentMissionInputSchema,
  upsertRoomAgentTaskRunInputSchema,
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
  updateSpaceAgentMessageInputSchema,
  updateSpaceAgentRunInputSchema,
  updateSpaceAgentSessionInputSchema,
  upsertAgentPaneStoredSessionInputSchema,
  updateAgentPaneBindingInputSchema,
  updateAgentToolAssignmentInputSchema,
  upsertAgentPaneBindingInputSchema,
  upsertClipboardItemInputSchema,
  updateUserLinkRequestSchema,
  userLinkSchema
} from "@space/contracts";
import type {
  AdminOperationRun,
  AgentPaneBinding,
  AgentPaneHistoryItem,
  AgentPaneStoredSession,
  AgentToolAssignment,
  Artifact,
  AuditEvent,
  BrowserCaptureJob,
  BrowserCaptureMetrics,
  BrowserCaptureSegment,
  BrowserControlLease,
  BrowserHandoffRequest,
  BrowserHandoffStatus,
  Capability,
  ClipboardItem,
  CliMaintenanceAuthHandoff,
  CliMaintenanceDiagnostics,
  CliMaintenanceEvent,
  CliRuntimeSetting,
  CliToggleRuntimeId,
  CreateUserLinkRequest,
  CodexAppServerHandshakeCheck,
  CodexAppServerTurnSmokeCheck,
  CodexCliModeDefaultPairs,
  CodexCliModeDefaults,
  CreateAuditEventInput,
  CreateAdminOperationRunInput,
  CreateArtifactInput,
  CreateBrowserCaptureJobInput,
  CreateBrowserCaptureSegmentInput,
  CreateBrowserControlLeaseInput,
  CreateBrowserHandoffRequestInput,
  CreateCliMaintenanceAuthHandoffInput,
  CreateCliMaintenanceEventInput,
  CreateImportCandidateInput,
  CreateMemoryChangeSetInput,
  CreateMemoryEntryInput,
  CreatePaneInput,
  CreatePaneBrowserSessionInput,
  CreatePaneCliSessionInput,
  CreatePaneCliHostOutputInput,
  CreatePaneCliTerminalControlLeaseInput,
  CreatePaneCliTranscriptChunkInput,
  CreateProviderInput,
  CreateRoomAgentActionInput,
  CreateRoomAgentMissionInput,
  CreateRoomAgentRequestInput,
  CreateReviewCheckInput,
  CreateReviewDecisionInput,
  CreateReviewDiffSummaryInput,
  CreateRoomInput,
  CreateSpaceAgentMessageInput,
  CreateSpaceAgentRunInput,
  CreateSpaceAgentSessionInput,
  CreateSkillProposalInput,
  CreateSwarmReconcileInput,
  CreateSwarmTaskInput,
  Event,
  ImportCandidate,
  ImportCandidateDecisionInput,
  ClaimSwarmLockInput,
  ListArtifactsQuery,
  ListClipboardItemsQuery,
  ListTaskItemsQuery,
  ListUserLinksQuery,
  ListImportCandidatesQuery,
  ListMemoryChangeSetsQuery,
  ListMemoryCacheLinksQuery,
  ListMemoryIssueStatesQuery,
  ListReviewChecksQuery,
  ListReviewDecisionsQuery,
  ListReviewDiffSummariesQuery,
  ListMemoryQuery,
  ListSwarmTasksQuery,
  MemoryEmbeddingSmokeCheck,
  MemoryChangeSet,
  MemoryChangeSetSummary,
  MemoryCacheLink,
  MemoryCommandClaim,
  MemoryCommandIdempotency,
  MemoryConsolidationFinding,
  MemoryConsolidationOperation,
  MemoryConsolidationRun,
  MemoryIssueState,
  MemoryVectorReadiness,
  MovePaneInput,
  MovePaneResult,
  McpDiscoverySmokeCheck,
  McpGatewayStatus,
  McpServerConfig,
  McpServer,
  McpTool,
  MemoryEntry,
  Model,
  Pane,
  PaneBrowserSession,
  PaneCliSession,
  PaneCliTerminalControlLease,
  PaneCliCodexThreadOwnership,
  PaneCliCodexThreadOwnershipSource,
  PaneCliTranscriptChunk,
  Provider,
  ProviderSettings,
  ProviderValidationResult,
  PublicWaitlistSource,
  ReleasePreview,
  SetupConnectionCheckEvent,
  SetupConnectionCheckRun,
  SetupConnectionState,
  SetupOnboarding,
  PostSwarmMessageInput,
  ReleaseSwarmLockInput,
  ReviewDecision,
  ReviewCheck,
  ReviewDiffSummary,
  Room,
  RoomCliActivity,
  RoomPaneLayoutResult,
  RoomAgentActionRecord,
  RoomAgentMissionRecord,
  RoomAgentRequestRecord,
  RoomAgentTaskRunRecord,
  RoomAgentSupervisorQueueItem,
  Skill,
  SpaceAgentMessageRecord,
  SpaceAgentRunRecord,
  SpaceAgentSessionRecord,
  SourceControlConnection,
  SourceControlProvider,
  SourceControlVerificationCode,
  SwarmLock,
  SwarmMessage,
  SwarmReconcile,
  SwarmState,
  SwarmTask,
  Turn,
  TurnRuntime,
  UpdateAgentPaneBindingInput,
  UpdateAdminOperationRunInput,
  UpdateAgentToolAssignmentInput,
  UpdateCliMaintenanceAuthHandoffInput,
  UpdateArtifactRetentionInput,
  UpdateUserLinkRequest,
  UpdateBrowserCaptureJobInput,
  UpdateBrowserCaptureSegmentInput,
  UpdateBrowserControlLeaseInput,
  UpdateBrowserHandoffRequestInput,
  UpdateMemoryChangeSetInput,
  UpdateMemoryConsolidationFindingInput,
  UpdateMemoryConsolidationOperationInput,
  UpdateMemoryConsolidationRunInput,
  UpdatePaneBrowserSessionInput,
  UpdatePaneCliSessionInput,
  UpdatePaneCliTerminalControlLeaseInput,
  UpdatePaneLayoutInput,
  UpdateRoomInput,
  UpdateProviderInput,
  UpdateProviderSettingsInput,
  UpdateCodexCliModeDefaultsInput,
  UpdateCliRuntimeSettingInput,
  UpdateCliRuntimeVpnInput,
  UpdateRoomAgentActionInput,
  UpdateRoomAgentMissionInput,
  UpdateSpaceAgentMessageInput,
  UpdateSpaceAgentRunInput,
  UpdateSpaceAgentSessionInput,
  UpdateSwarmTaskInput,
  UpdatePaneInput,
  UpdateTaskItemInput,
  UpsertClipboardItemInput,
  UpsertTaskItemInput,
  UpsertAgentPaneStoredSessionInput,
  UpsertRoomAgentTaskRunInput,
  UpsertAgentPaneBindingInput,
  AuthUser,
  TaskItem,
  UserLink,
  WorkflowRun
} from "@space/contracts";
import type {
  ClaimMemoryCommandInput,
  CreateMemoryConsolidationFindingInput,
  CreateMemoryConsolidationOperationInput,
  CreateMemoryConsolidationRunInput,
  LinkMemoryCacheInput,
  UpsertMemoryIssueStateInput
} from "@space/contracts";
import { hashMcpSchema } from "./mcp-policy.js";

export const ACTIVE_PANE_CAP = 16;
export const PANE_CLI_TRANSCRIPT_CHUNK_CAP = 200;
export type MaybePromise<T> = T | Promise<T>;

export interface CreateMemoryChangeSetOptions {
  id?: string;
}

export interface CreateQueuedTurnInput {
  roomId: string;
  paneId: string;
  workflowId: string;
  runId: string | null;
  taskQueue: string;
  traceId: string;
  prompt: string;
  artifactIds?: string[];
  runtime?: TurnRuntime;
  providerId: string | null;
  modelId: string | null;
}

export interface QueuedTurnRecord {
  turn: Turn;
  workflow: WorkflowRun;
  event: Event;
}

export interface EnqueueRoomAgentMissionInput {
  requestId: string;
  clientRequestId: string;
  content: string;
  supervisorWorkflowId: string;
  childWorkflowId: string;
  promptMessageId: string;
  responseMessageId: string;
  runId: string;
  queueItem: RoomAgentSupervisorQueueItem;
}

export interface RoomAgentEnqueueRecord {
  created: boolean;
  signaledAt: string | null;
  request: RoomAgentRequestRecord;
  mission: RoomAgentMissionRecord;
  promptMessage: SpaceAgentMessageRecord;
  responseMessage: SpaceAgentMessageRecord;
  run: SpaceAgentRunRecord;
  queueItem: RoomAgentSupervisorQueueItem;
}

export interface CompleteTurnInput {
  workflowId: string;
  traceId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface FailTurnInput extends CompleteTurnInput {
  reasonCode?: string;
}

export interface CompletedTurnRecord {
  turn: Turn;
  workflow: WorkflowRun;
  event: Event;
}

export interface CompleteSpaceAgentRunInput {
  runId: string;
  sessionId: string;
  responseMessageId: string;
  responseContent: string;
  finalResponse: string;
  codexThreadId: string | null;
  codexTurnId: string | null;
  sourceType: "CHAT" | "ROOM_AGENT";
  traceId: string;
  completedAt: string;
}

export interface CompletedSpaceAgentRunRecord {
  run: SpaceAgentRunRecord;
  session: SpaceAgentSessionRecord;
  responseMessage: SpaceAgentMessageRecord;
  event: Event;
}

export type CodexCliTurnMarkerStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "IGNORED" | "FAILED";

export interface CodexCliTurnMarkerRecord {
  markerId: string;
  sessionId: string;
  roomId: string;
  paneId: string;
  clientTurnMarker: string;
  status: CodexCliTurnMarkerStatus;
  codexThreadId: string | null;
  rolloutPath: string | null;
  completionEventId: string | null;
  submittedAt: string;
  completedAt: string | null;
  nextCheckAt: string;
  checkAttemptCount: number;
  lockedAt: string | null;
  lockedBy: string | null;
  safeErrorCode: string | null;
  updatedAt: string;
}

export interface CreateCodexCliTurnMarkerInput {
  sessionId: string;
  roomId: string;
  paneId: string;
  clientTurnMarker: string;
  submittedAt: string;
}

export interface CompleteCodexCliTurnMarkerInput {
  markerId: string;
  workerId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  rolloutPath: string;
  finalResponse: string;
  completedAt: string;
  traceId: string;
}

export type FailedTurnRecord = CompletedTurnRecord;

export type RecordCodexAppServerHandshakeInput = Omit<CodexAppServerHandshakeCheck, "checkId" | "checkedAt"> & {
  checkedAt?: string;
};

export type RecordCodexAppServerTurnSmokeInput = Omit<CodexAppServerTurnSmokeCheck, "checkId" | "checkedAt"> & {
  checkedAt?: string;
};

export type RecordMcpDiscoverySmokeInput = Omit<McpDiscoverySmokeCheck, "checkId" | "checkedAt"> & {
  checkedAt?: string;
};

export type RecordMemoryEmbeddingSmokeInput = Omit<MemoryEmbeddingSmokeCheck, "checkId" | "checkedAt"> & {
  checkedAt?: string;
};

export interface RecordMcpDiscoveryCatalogInput {
  servers: McpServer[];
  tools: McpTool[];
  discoveredAt?: string;
}

export interface McpDiscoveryCatalogRecord {
  gatewayStatus: McpGatewayStatus;
  servers: McpServer[];
  tools: McpTool[];
}

export interface MemoryEntryRecord {
  entry: MemoryEntry;
  event: Event;
}

export interface CreateMemoryEntryOptions {
  embedding?: number[];
}

export interface ListMemoryEntriesOptions {
  semanticReady?: boolean;
  queryEmbedding?: number[];
  limit?: number;
}

export interface SkillProposalRecord {
  skill: Skill;
  event: Event;
}

export interface ImportCandidateRecord {
  candidate: ImportCandidate;
  event: Event;
}

export interface ImportCandidateDecisionRecord {
  candidate: ImportCandidate;
  events: Event[];
  memoryEntry: MemoryEntry | null;
  skill: Skill | null;
}

export interface ReviewDecisionRecord {
  decision: ReviewDecision;
  event: Event;
}

export interface ReviewCheckRecord {
  check: ReviewCheck;
  event: Event;
}

export interface ReviewDiffSummaryRecord {
  diff: ReviewDiffSummary;
  event: Event;
}

export interface SwarmTaskRecord {
  task: SwarmTask;
  event: Event;
}

export interface SwarmLockRecord {
  lock: SwarmLock;
  event: Event;
}

export interface SwarmMessageRecord {
  message: SwarmMessage;
  event: Event;
}

export interface SwarmReconcileRecord {
  reconcile: SwarmReconcile;
  event: Event;
}

export interface ArtifactRecord {
  artifact: Artifact;
  event: Event;
}

type StoreEventInput = Omit<Event, "id" | "createdAt" | "workflowId"> & { workflowId?: string | null };

export interface ClipboardItemListResult {
  items: ClipboardItem[];
  total: number;
}

export interface TaskItemListResult {
  items: TaskItem[];
  total: number;
}

export interface UserLinkListResult {
  items: UserLink[];
  total: number;
}

export type StoreSortOrder = "asc" | "desc";

export interface StorePageResult<T> {
  items: T[];
  total: number;
}

export interface ListStorePageInput {
  roomId?: string;
  page: number;
  pageSize: number;
  sortOrder: StoreSortOrder;
}

export interface ListPaneCliTaskHistoryInput {
  page: number;
  pageSize: number;
  query?: string;
  runtimeIds?: string[];
}

export interface PaneCliTaskHistoryRecord {
  taskId: string;
  revision: CliTaskRevisionRecord;
  session: PaneCliSession;
  paneTitle: string;
  firstUserMessage: string;
  preview: string;
  recencyAt: string;
}

export interface CliTaskRecord {
  taskId: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CliTaskRevisionRecord {
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
  createdAt: string;
  updatedAt: string;
}

export type CreateCliTaskRevisionInput = Omit<CliTaskRevisionRecord, "createdAt" | "updatedAt" | "latestSpaceSessionId"> & {
  latestSpaceSessionId?: string | null;
};

export interface UpdateCliTaskRevisionInput {
  nativeTaskRef?: string | null;
  latestSpaceSessionId?: string | null;
  displayTitle?: string;
  firstUserMessage?: string;
  preview?: string;
  cwd?: string | null;
  modelId?: string | null;
  reasoningEffort?: PaneCliSession["reasoningEffort"];
}

export interface EventChange {
  sequence: string;
  event: Event;
}

export interface ListEventChangesInput {
  afterSequence: string | null;
  sortOrder: StoreSortOrder;
  limit: number;
}

export type CreateUserLinkInput = CreateUserLinkRequest & { ownerUserId: string };
export type CreateRoomStoreInput = CreateRoomInput & { kind?: Room["kind"] };

export interface PublicWaitlistSignupInput {
  email: string;
  source: PublicWaitlistSource;
}

export interface SourceControlConnectionRecord extends SourceControlConnection {
  secretRef: string | null;
}

export interface UpsertSourceControlConnectionInput {
  provider: SourceControlProvider;
  accountLogin: string | null;
  connectionStatus: SourceControlConnection["status"];
  secretRef: string | null;
  lastVerifiedAt: string | null;
  lastVerificationCode: SourceControlVerificationCode;
}

export type CreateReleasePreviewStoreInput = Omit<ReleasePreview, "id" | "createdAt">;
export interface ReleasePreviewRecord extends ReleasePreview {
  actorUserId: string | null;
}

export type PublicWaitlistSignupOutcome = "CREATED" | "DUPLICATE";

export interface OwnerSetupStatus {
  setupRequired: boolean;
  expiresAt: string | null;
}

export const currentSetupOnboardingVersion = 1;

export interface InitializeOwnerSetupInput {
  tokenHash: string;
  expiresAt: string;
}

export interface ClaimOwnerSetupInput {
  tokenHash: string;
  email: string;
  passwordHash: string;
  now: string;
}

export interface OwnerCredentials {
  user: AuthUser;
  passwordHash: string;
}

export interface OwnerSetupClaimResult {
  user: AuthUser;
  onboarding: SetupOnboarding;
}

export type PersistedSetupConnectionState = Exclude<SetupConnectionState, "CHECKING">;

export interface SetupConnectionVerification {
  connectionId: string;
  state: PersistedSetupConnectionState;
  reasonCode: string | null;
  fingerprintHash: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

export type UpsertSetupConnectionVerificationInput = SetupConnectionVerification;

export const createSetupConnectionCheckRunInputSchema = z.object({
  scope: setupConnectionCheckRunSchema.shape.scope,
  connectionIds: setupConnectionCheckRunSchema.shape.connectionIds,
  actorUserId: idSchema
}).strict().superRefine((input, context) => {
  if (new Set(input.connectionIds).size !== input.connectionIds.length) {
    context.addIssue({
      code: "custom",
      path: ["connectionIds"],
      message: "Setup connection ids must be unique."
    });
  }
  if (input.scope === "SINGLE" && input.connectionIds.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["connectionIds"],
      message: "A single-connection check run must contain exactly one connection."
    });
  }
});
export type CreateSetupConnectionCheckRunInput = z.infer<typeof createSetupConnectionCheckRunInputSchema>;

export const updateSetupConnectionCheckRunInputSchema = z.object({
  status: setupConnectionCheckRunSchema.shape.status.optional(),
  completedCount: setupConnectionCheckRunSchema.shape.completedCount.optional(),
  finishedAt: isoDateTimeSchema.nullable().optional()
}).strict();
export type UpdateSetupConnectionCheckRunInput = z.infer<typeof updateSetupConnectionCheckRunInputSchema>;

export const createSetupConnectionCheckEventInputSchema = setupConnectionCheckEventSchema.omit({
  id: true,
  sequence: true,
  createdAt: true
});
export type CreateSetupConnectionCheckEventInput = z.infer<typeof createSetupConnectionCheckEventInputSchema>;

export function updateSetupConnectionCheckRunRecord(
  existing: SetupConnectionCheckRun,
  input: UpdateSetupConnectionCheckRunInput,
  updatedAt = nowIso()
): SetupConnectionCheckRun {
  const parsed = updateSetupConnectionCheckRunInputSchema.parse(input);
  const next = setupConnectionCheckRunSchema.parse({
    ...existing,
    ...parsed,
    updatedAt
  });
  if (next.completedCount < existing.completedCount || next.completedCount > next.totalCount) {
    throw new Error("Setup connection check progress is invalid.");
  }
  if (existing.status === "COMPLETED" && next.status !== "COMPLETED") {
    throw new Error("A completed setup connection check run cannot be reopened.");
  }
  if (next.status === "COMPLETED" && (next.completedCount !== next.totalCount || next.finishedAt === null)) {
    throw new Error("A completed setup connection check run requires complete progress and a finish time.");
  }
  if (next.status === "RUNNING" && next.finishedAt !== null) {
    throw new Error("A running setup connection check run cannot have a finish time.");
  }
  return next;
}

export interface SpaceStore {
  upsertUser(user: AuthUser): MaybePromise<AuthUser>;
  initializeOwnerSetup(input: InitializeOwnerSetupInput): MaybePromise<OwnerSetupStatus>;
  getOwnerSetupStatus(): MaybePromise<OwnerSetupStatus>;
  claimOwnerSetup(input: ClaimOwnerSetupInput): MaybePromise<OwnerSetupClaimResult>;
  getOwnerOnboarding(): MaybePromise<SetupOnboarding>;
  ensureOwnerStarterRoom(traceId?: string): MaybePromise<{ room: Room; onboarding: SetupOnboarding }>;
  completeOwnerOnboarding(completedAt: string): MaybePromise<SetupOnboarding>;
  listSetupConnectionVerifications(): MaybePromise<SetupConnectionVerification[]>;
  getSetupConnectionVerification(connectionId: string): MaybePromise<SetupConnectionVerification | null>;
  upsertSetupConnectionVerification(
    input: UpsertSetupConnectionVerificationInput
  ): MaybePromise<SetupConnectionVerification>;
  createSetupConnectionCheckRun(
    input: CreateSetupConnectionCheckRunInput
  ): MaybePromise<SetupConnectionCheckRun>;
  getSetupConnectionCheckRun(runId: string): MaybePromise<SetupConnectionCheckRun | null>;
  listSetupConnectionCheckRuns(limit?: number): MaybePromise<SetupConnectionCheckRun[]>;
  updateSetupConnectionCheckRun(
    runId: string,
    input: UpdateSetupConnectionCheckRunInput
  ): MaybePromise<SetupConnectionCheckRun>;
  appendSetupConnectionCheckEvent(
    input: CreateSetupConnectionCheckEventInput
  ): MaybePromise<SetupConnectionCheckEvent>;
  listSetupConnectionCheckEvents(
    runId: string,
    afterSequence?: number,
    limit?: number
  ): MaybePromise<SetupConnectionCheckEvent[]>;
  getOwnerCredentials(): MaybePromise<OwnerCredentials | null>;
  updateOwnerPassword(passwordHash: string): MaybePromise<AuthUser>;
  upsertPublicWaitlistSignup(input: PublicWaitlistSignupInput): MaybePromise<PublicWaitlistSignupOutcome>;
  upsertClipboardItem(input: UpsertClipboardItemInput): MaybePromise<ClipboardItem>;
  getClipboardItem(ownerUserId: string, clipboardItemId: string): MaybePromise<ClipboardItem | null>;
  listClipboardItems(ownerUserId: string, query?: ListClipboardItemsQuery): MaybePromise<ClipboardItemListResult>;
  deleteClipboardItem(ownerUserId: string, clipboardItemId: string): MaybePromise<ClipboardItem>;
  clearClipboardItems(ownerUserId: string): MaybePromise<number>;
  upsertTaskItem(input: UpsertTaskItemInput): MaybePromise<TaskItem>;
  getTaskItem(ownerUserId: string, taskItemId: string): MaybePromise<TaskItem | null>;
  listTaskItems(ownerUserId: string, query?: ListTaskItemsQuery): MaybePromise<TaskItemListResult>;
  updateTaskItem(ownerUserId: string, taskItemId: string, input: UpdateTaskItemInput): MaybePromise<TaskItem>;
  deleteTaskItem(ownerUserId: string, taskItemId: string): MaybePromise<TaskItem>;
  clearTaskItems(ownerUserId: string): MaybePromise<number>;
  listUserLinks(ownerUserId: string, query?: ListUserLinksQuery): MaybePromise<UserLinkListResult>;
  createUserLink(input: CreateUserLinkInput): MaybePromise<UserLink>;
  updateUserLink(ownerUserId: string, linkId: string, input: UpdateUserLinkRequest): MaybePromise<UserLink>;
  deleteUserLink(ownerUserId: string, linkId: string): MaybePromise<UserLink>;
  listRooms(): MaybePromise<Room[]>;
  listRunningCliSessionCountsByRoom(runtimeIds?: string[]): MaybePromise<RoomCliActivity[]>;
  listCliRuntimeSettings(): MaybePromise<CliRuntimeSetting[]>;
  getCliRuntimeSetting(runtimeId: CliToggleRuntimeId): MaybePromise<CliRuntimeSetting>;
  updateCliRuntimeSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeSettingInput,
    updatedBy: string
  ): MaybePromise<CliRuntimeSetting>;
  updateCliRuntimeVpnSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeVpnInput,
    updatedBy: string
  ): MaybePromise<CliRuntimeSetting>;
  listAgentToolAssignments(): MaybePromise<AgentToolAssignment[]>;
  getAgentToolAssignment(toolId: string): MaybePromise<AgentToolAssignment | null>;
  updateAgentToolAssignment(
    toolId: string,
    input: UpdateAgentToolAssignmentInput,
    updatedBy: string
  ): MaybePromise<AgentToolAssignment>;
  deleteAgentToolAssignment(toolId: string): MaybePromise<AgentToolAssignment | null>;
  createAdminOperationRun(input: CreateAdminOperationRunInput): MaybePromise<AdminOperationRun>;
  getAdminOperationRun(runId: string): MaybePromise<AdminOperationRun | null>;
  listAdminOperationRuns(limit?: number): MaybePromise<AdminOperationRun[]>;
  updateAdminOperationRun(runId: string, input: UpdateAdminOperationRunInput): MaybePromise<AdminOperationRun>;
  appendCliMaintenanceEvent(input: CreateCliMaintenanceEventInput): MaybePromise<CliMaintenanceEvent>;
  listCliMaintenanceEvents(
    runId: string,
    afterSequence?: number,
    limit?: number
  ): MaybePromise<CliMaintenanceEvent[]>;
  createCliMaintenanceAuthHandoff(
    input: CreateCliMaintenanceAuthHandoffInput
  ): MaybePromise<CliMaintenanceAuthHandoff>;
  updateCliMaintenanceAuthHandoff(
    handoffId: string,
    input: UpdateCliMaintenanceAuthHandoffInput
  ): MaybePromise<CliMaintenanceAuthHandoff>;
  listCliMaintenanceAuthHandoffs(runId: string): MaybePromise<CliMaintenanceAuthHandoff[]>;
  listSourceControlConnections(): MaybePromise<SourceControlConnectionRecord[]>;
  getSourceControlConnection(provider: SourceControlProvider): MaybePromise<SourceControlConnectionRecord>;
  upsertSourceControlConnection(input: UpsertSourceControlConnectionInput): MaybePromise<SourceControlConnectionRecord>;
  createReleasePreview(input: CreateReleasePreviewStoreInput, actorUserId: string | null): MaybePromise<ReleasePreviewRecord>;
  getReleasePreview(previewId: string): MaybePromise<ReleasePreviewRecord | null>;
  getRoom(roomId: string): MaybePromise<Room>;
  createRoom(input: CreateRoomStoreInput, traceId?: string): MaybePromise<Room>;
  updateRoom(roomId: string, input: UpdateRoomInput, traceId?: string): MaybePromise<Room>;
  updateRoomPaneLayout(
    roomId: string,
    input: UpdatePaneLayoutInput,
    traceId?: string
  ): MaybePromise<RoomPaneLayoutResult>;
  reorderRooms(roomIds: string[], traceId?: string): MaybePromise<Room[]>;
  reorderPanes(roomId: string, paneIds: string[], traceId?: string): MaybePromise<Pane[]>;
  deleteRoom(roomId: string): MaybePromise<Room>;
  getPane(paneId: string): MaybePromise<Pane>;
  listPanes(roomId: string, includeClosed?: boolean): MaybePromise<Pane[]>;
  createPane(input: CreatePaneInput, traceId?: string): MaybePromise<Pane>;
  createPanes(inputs: CreatePaneInput[], traceId?: string): MaybePromise<Pane[]>;
  updatePane(paneId: string, input: UpdatePaneInput, traceId?: string): MaybePromise<Pane>;
  movePane(paneId: string, input: MovePaneInput, traceId?: string): MaybePromise<MovePaneResult>;
  getOrCreateRoomAgentPane(roomId: string, traceId?: string): MaybePromise<Pane>;
  getRoomAgentTranscriptClearedAt(roomId: string): MaybePromise<string | null>;
  clearRoomAgentTranscript(roomId: string, clearedAt: string, traceId?: string): MaybePromise<string>;
  getRoomAgentRequest(roomId: string, clientRequestId: string): MaybePromise<RoomAgentRequestRecord | null>;
  createRoomAgentRequest(input: CreateRoomAgentRequestInput, traceId?: string): MaybePromise<RoomAgentRequestRecord>;
  enqueueRoomAgentMission(input: EnqueueRoomAgentMissionInput, traceId?: string): MaybePromise<RoomAgentEnqueueRecord>;
  listUnsignaledRoomAgentEnqueues(limit?: number): MaybePromise<RoomAgentEnqueueRecord[]>;
  markRoomAgentMissionSignaled(roomId: string, clientRequestId: string): MaybePromise<void>;
  createRoomAgentMission(input: CreateRoomAgentMissionInput, traceId?: string): MaybePromise<RoomAgentMissionRecord>;
  updateRoomAgentMission(
    missionId: string,
    input: UpdateRoomAgentMissionInput,
    traceId?: string
  ): MaybePromise<RoomAgentMissionRecord>;
  getRoomAgentMission(roomId: string, missionId: string): MaybePromise<RoomAgentMissionRecord | null>;
  listRoomAgentMissions(roomId: string, limit?: number): MaybePromise<RoomAgentMissionRecord[]>;
  createRoomAgentAction(input: CreateRoomAgentActionInput, traceId?: string): MaybePromise<RoomAgentActionRecord>;
  updateRoomAgentAction(
    actionId: string,
    input: UpdateRoomAgentActionInput,
    traceId?: string
  ): MaybePromise<RoomAgentActionRecord>;
  getRoomAgentAction(missionId: string, actionId: string): MaybePromise<RoomAgentActionRecord | null>;
  listRoomAgentActions(missionId: string): MaybePromise<RoomAgentActionRecord[]>;
  upsertRoomAgentTaskRun(input: UpsertRoomAgentTaskRunInput, traceId?: string): MaybePromise<RoomAgentTaskRunRecord>;
  getRoomAgentTaskRun(missionId: string, stepId: string): MaybePromise<RoomAgentTaskRunRecord | null>;
  listRoomAgentTaskRuns(missionId: string): MaybePromise<RoomAgentTaskRunRecord[]>;
  getAgentPaneBinding(paneId: string): MaybePromise<AgentPaneBinding | null>;
  listAgentPaneHistory(roomId?: string): MaybePromise<AgentPaneHistoryItem[]>;
  upsertAgentPaneStoredSession(input: UpsertAgentPaneStoredSessionInput, traceId?: string): MaybePromise<AgentPaneStoredSession>;
  upsertAgentPaneBinding(input: UpsertAgentPaneBindingInput, traceId?: string): MaybePromise<AgentPaneBinding>;
  updateAgentPaneBinding(paneId: string, input: UpdateAgentPaneBindingInput, traceId?: string): MaybePromise<AgentPaneBinding>;
  getActiveSpaceAgentSession(paneId: string): MaybePromise<SpaceAgentSessionRecord | null>;
  getSpaceAgentSession(sessionId: string): MaybePromise<SpaceAgentSessionRecord | null>;
  listSpaceAgentHistory(roomId?: string): MaybePromise<AgentPaneHistoryItem[]>;
  createSpaceAgentSession(input: CreateSpaceAgentSessionInput, traceId?: string): MaybePromise<SpaceAgentSessionRecord>;
  updateSpaceAgentSession(
    sessionId: string,
    input: UpdateSpaceAgentSessionInput,
    traceId?: string
  ): MaybePromise<SpaceAgentSessionRecord>;
  listSpaceAgentMessages(sessionId: string, limit?: number): MaybePromise<SpaceAgentMessageRecord[]>;
  countSpaceAgentMessages(sessionId: string): MaybePromise<number>;
  createSpaceAgentMessage(input: CreateSpaceAgentMessageInput, traceId?: string): MaybePromise<SpaceAgentMessageRecord>;
  updateSpaceAgentMessage(
    messageId: string,
    input: UpdateSpaceAgentMessageInput,
    traceId?: string
  ): MaybePromise<SpaceAgentMessageRecord>;
  createSpaceAgentRun(input: CreateSpaceAgentRunInput, traceId?: string): MaybePromise<SpaceAgentRunRecord>;
  updateSpaceAgentRun(runId: string, input: UpdateSpaceAgentRunInput, traceId?: string): MaybePromise<SpaceAgentRunRecord>;
  updateSpaceAgentRunByWorkflowId(
    workflowId: string,
    input: UpdateSpaceAgentRunInput,
    traceId?: string
  ): MaybePromise<SpaceAgentRunRecord>;
  completeSpaceAgentRun(input: CompleteSpaceAgentRunInput): MaybePromise<CompletedSpaceAgentRunRecord>;
  getLatestSpaceAgentRun(sessionId: string): MaybePromise<SpaceAgentRunRecord | null>;
  getActivePaneCliSession(paneId: string): MaybePromise<PaneCliSession | null>;
  getActivePaneCliSessionByCodexThreadId(codexThreadId: string): MaybePromise<PaneCliSession | null>;
  getLatestPaneCliSessionByCodexThreadId(codexThreadId: string): MaybePromise<PaneCliSession | null>;
  listPaneCliSessions(paneId: string, limit?: number): MaybePromise<PaneCliSession[]>;
  listActivePaneCliSessions(runtimeId: string): MaybePromise<PaneCliSession[]>;
  getCliTask(taskId: string): MaybePromise<CliTaskRecord | null>;
  getCliTaskRevision(revisionId: string): MaybePromise<CliTaskRevisionRecord | null>;
  getCliTaskRevisionByNativeRef(runtimeId: string, nativeTaskRef: string): MaybePromise<CliTaskRevisionRecord | null>;
  createCliTaskRevision(input: CreateCliTaskRevisionInput, traceId?: string): MaybePromise<CliTaskRevisionRecord>;
  updateCliTaskRevision(
    revisionId: string,
    input: UpdateCliTaskRevisionInput,
    traceId?: string
  ): MaybePromise<CliTaskRevisionRecord>;
  listPaneCliTaskHistory(input: ListPaneCliTaskHistoryInput): MaybePromise<StorePageResult<PaneCliTaskHistoryRecord>>;
  listInactivePaneCliTaskIds(): MaybePromise<string[]>;
  hideInactivePaneCliTasks(taskIds: string[]): MaybePromise<string[]>;
  restorePaneCliTasks(taskIds: string[]): MaybePromise<void>;
  getPaneTitlesByCodexThreadIds(codexThreadIds: string[]): MaybePromise<Map<string, string>>;
  getPaneCliSession(sessionId: string): MaybePromise<PaneCliSession | null>;
  getActivePaneCliTerminalControlLease(sessionId: string): MaybePromise<PaneCliTerminalControlLease | null>;
  getPaneCliTerminalControlLease(leaseId: string): MaybePromise<PaneCliTerminalControlLease | null>;
  createPaneCliTerminalControlLease(
    input: CreatePaneCliTerminalControlLeaseInput
  ): MaybePromise<PaneCliTerminalControlLease>;
  updatePaneCliTerminalControlLease(
    leaseId: string,
    input: UpdatePaneCliTerminalControlLeaseInput
  ): MaybePromise<PaneCliTerminalControlLease>;
  getPaneCliCodexThreadOwnership(codexThreadId: string): MaybePromise<PaneCliCodexThreadOwnership | null>;
  claimPaneCliCodexThread(
    sessionId: string,
    codexThreadId: string,
    source: Exclude<PaneCliCodexThreadOwnershipSource, "MIGRATION">,
    traceId?: string
  ): MaybePromise<PaneCliCodexThreadOwnership>;
  createPaneCliSession(input: CreatePaneCliSessionInput, traceId?: string): MaybePromise<PaneCliSession>;
  updatePaneCliSession(sessionId: string, input: UpdatePaneCliSessionInput, traceId?: string): MaybePromise<PaneCliSession>;
  touchPaneCliSessionActivity(sessionId: string, traceId?: string): MaybePromise<void>;
  appendPaneCliTranscriptChunk(
    input: CreatePaneCliTranscriptChunkInput,
    traceId?: string
  ): MaybePromise<PaneCliTranscriptChunk>;
  appendPaneCliTranscriptChunkAtNextSequence(
    input: Omit<CreatePaneCliTranscriptChunkInput, "sequence">,
    traceId?: string
  ): MaybePromise<PaneCliTranscriptChunk>;
  appendPaneCliHostOutputChunk(input: CreatePaneCliHostOutputInput, traceId?: string): MaybePromise<PaneCliTranscriptChunk>;
  getPaneCliHostOutputCursor(sessionId: string, generationId: string): MaybePromise<number>;
  listPaneCliTranscriptChunks(sessionId: string, limit?: number): MaybePromise<PaneCliTranscriptChunk[]>;
  listManagedCodexThreadIds(): MaybePromise<string[]>;
  listActiveManagedCodexThreadIds(): MaybePromise<string[]>;
  createCodexCliTurnMarker(input: CreateCodexCliTurnMarkerInput): MaybePromise<CodexCliTurnMarkerRecord>;
  claimCodexCliTurnMarkers(input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }): MaybePromise<CodexCliTurnMarkerRecord[]>;
  deferCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    codexThreadId?: string | null;
    rolloutPath?: string | null;
    nextCheckAt: string;
    safeErrorCode?: string | null;
    now: string;
  }): MaybePromise<void>;
  completeCodexCliTurnMarker(input: CompleteCodexCliTurnMarkerInput): MaybePromise<CodexCliTurnMarkerRecord>;
  finishCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    status: "IGNORED" | "FAILED";
    safeErrorCode: string;
    now: string;
  }): MaybePromise<void>;
  getActivePaneBrowserSession(paneId: string): MaybePromise<PaneBrowserSession | null>;
  getPaneBrowserSession(sessionId: string): MaybePromise<PaneBrowserSession | null>;
  getLatestPaneBrowserSession(paneId: string): MaybePromise<PaneBrowserSession | null>;
  listActivePaneBrowserSessions(roomId?: string): MaybePromise<PaneBrowserSession[]>;
  createPaneBrowserSession(input: CreatePaneBrowserSessionInput, traceId?: string): MaybePromise<PaneBrowserSession>;
  updatePaneBrowserSession(
    sessionId: string,
    input: UpdatePaneBrowserSessionInput,
    traceId?: string
  ): MaybePromise<PaneBrowserSession>;
  getActiveBrowserControlLease(sessionId: string): MaybePromise<BrowserControlLease | null>;
  getBrowserControlLease(leaseId: string): MaybePromise<BrowserControlLease | null>;
  createBrowserControlLease(input: CreateBrowserControlLeaseInput): MaybePromise<BrowserControlLease>;
  updateBrowserControlLease(leaseId: string, input: UpdateBrowserControlLeaseInput): MaybePromise<BrowserControlLease>;
  getBrowserCaptureJob(jobId: string): MaybePromise<BrowserCaptureJob | null>;
  listBrowserCaptureJobs(sessionId: string): MaybePromise<BrowserCaptureJob[]>;
  getBrowserCaptureMetrics?(): MaybePromise<BrowserCaptureMetrics>;
  createBrowserCaptureJob(input: CreateBrowserCaptureJobInput): MaybePromise<BrowserCaptureJob>;
  updateBrowserCaptureJob(jobId: string, input: UpdateBrowserCaptureJobInput): MaybePromise<BrowserCaptureJob>;
  getBrowserCaptureSegment(segmentId: string): MaybePromise<BrowserCaptureSegment | null>;
  listBrowserCaptureSegments(jobId: string): MaybePromise<BrowserCaptureSegment[]>;
  createBrowserCaptureSegment(input: CreateBrowserCaptureSegmentInput): MaybePromise<BrowserCaptureSegment>;
  updateBrowserCaptureSegment(
    segmentId: string,
    input: UpdateBrowserCaptureSegmentInput
  ): MaybePromise<BrowserCaptureSegment>;
  getActiveBrowserHandoffRequest(sessionId: string): MaybePromise<BrowserHandoffRequest | null>;
  getBrowserHandoffRequest(handoffRequestId: string): MaybePromise<BrowserHandoffRequest | null>;
  listBrowserHandoffRequests(roomId?: string): MaybePromise<BrowserHandoffRequest[]>;
  createBrowserHandoffRequest(input: CreateBrowserHandoffRequestInput): MaybePromise<BrowserHandoffRequest>;
  updateBrowserHandoffRequest(
    handoffRequestId: string,
    input: UpdateBrowserHandoffRequestInput
  ): MaybePromise<BrowserHandoffRequest>;
  recordTurnQueued(input: CreateQueuedTurnInput): MaybePromise<QueuedTurnRecord>;
  recordWorkflowRunId(workflowId: string, runId: string | null): MaybePromise<WorkflowRun>;
  recordTurnCompleted(input: CompleteTurnInput): MaybePromise<CompletedTurnRecord>;
  recordTurnFailed(input: FailTurnInput): MaybePromise<FailedTurnRecord>;
  listTurns(roomId?: string): MaybePromise<Turn[]>;
  listTurnsPage(input: ListStorePageInput): MaybePromise<StorePageResult<Turn>>;
  listEvents(roomId?: string): MaybePromise<Event[]>;
  getLatestEvent(roomId: string): MaybePromise<Event | null>;
  listEventsPage(input: ListStorePageInput): MaybePromise<StorePageResult<Event>>;
  listEventChanges(input: ListEventChangesInput): MaybePromise<EventChange[]>;
  recordAuditEvent(input: CreateAuditEventInput): MaybePromise<AuditEvent>;
  listAuditEvents(): MaybePromise<AuditEvent[]>;
  listProviders(): MaybePromise<Provider[]>;
  getProviderSettings(): MaybePromise<ProviderSettings>;
  updateProviderSettings(input: UpdateProviderSettingsInput): MaybePromise<ProviderSettings>;
  getCodexCliModeDefaults(): MaybePromise<CodexCliModeDefaults>;
  initializeCodexCliModeDefaults(input: CodexCliModeDefaultPairs): MaybePromise<CodexCliModeDefaults>;
  updateCodexCliModeDefaults(input: UpdateCodexCliModeDefaultsInput): MaybePromise<CodexCliModeDefaults>;
  createProvider(input: CreateProviderInput): MaybePromise<Provider>;
  updateProvider(providerId: string, input: UpdateProviderInput): MaybePromise<Provider>;
  recordProviderValidation(input: ProviderValidationResult): MaybePromise<ProviderValidationResult>;
  getLatestProviderValidation(providerId: string): MaybePromise<ProviderValidationResult | null>;
  replaceProviderModels(providerId: string, models: Model[]): MaybePromise<Model[]>;
  getMcpGatewayStatus(): MaybePromise<McpGatewayStatus>;
  listMcpServers(): MaybePromise<McpServer[]>;
  listMcpTools(): MaybePromise<McpTool[]>;
  recordMcpDiscoveryCatalog(input: RecordMcpDiscoveryCatalogInput): MaybePromise<McpDiscoveryCatalogRecord>;
  recordMcpDiscoverySmoke(input: RecordMcpDiscoverySmokeInput): MaybePromise<McpDiscoverySmokeCheck>;
  getLatestMcpDiscoverySmoke(): MaybePromise<McpDiscoverySmokeCheck | null>;
  recordMemoryEmbeddingSmoke(input: RecordMemoryEmbeddingSmokeInput): MaybePromise<MemoryEmbeddingSmokeCheck>;
  getLatestMemoryEmbeddingSmoke(): MaybePromise<MemoryEmbeddingSmokeCheck | null>;
  getMemoryVectorReadiness(expectedDimensions: number): MaybePromise<MemoryVectorReadiness>;
  recordCodexAppServerHandshake(input: RecordCodexAppServerHandshakeInput): MaybePromise<CodexAppServerHandshakeCheck>;
  getLatestCodexAppServerHandshake(): MaybePromise<CodexAppServerHandshakeCheck | null>;
  recordCodexAppServerTurnSmoke(input: RecordCodexAppServerTurnSmokeInput): MaybePromise<CodexAppServerTurnSmokeCheck>;
  getLatestCodexAppServerTurnSmoke(): MaybePromise<CodexAppServerTurnSmokeCheck | null>;
  listModels(): MaybePromise<Model[]>;
  listCapabilities(): MaybePromise<Capability[]>;
  listSkills(): MaybePromise<Skill[]>;
  createSkillProposal(input: CreateSkillProposalInput, traceId?: string): MaybePromise<SkillProposalRecord>;
  listImportCandidates(query?: ListImportCandidatesQuery): MaybePromise<ImportCandidate[]>;
  createImportCandidate(input: CreateImportCandidateInput, traceId?: string): MaybePromise<ImportCandidateRecord>;
  decideImportCandidate(
    candidateId: string,
    input: ImportCandidateDecisionInput,
    traceId?: string
  ): MaybePromise<ImportCandidateDecisionRecord>;
  createMemoryEntry(input: CreateMemoryEntryInput, traceId?: string, options?: CreateMemoryEntryOptions): MaybePromise<MemoryEntryRecord>;
  listMemoryEntries(query?: ListMemoryQuery, options?: ListMemoryEntriesOptions): MaybePromise<MemoryEntry[]>;
  linkMemoryCacheRecord(input: LinkMemoryCacheInput): MaybePromise<MemoryCacheLink>;
  getMemoryCacheLink(memoryRecordId: string): MaybePromise<MemoryCacheLink | null>;
  listMemoryCacheLinks(query?: ListMemoryCacheLinksQuery): MaybePromise<MemoryCacheLink[]>;
  upsertMemoryIssueState(input: UpsertMemoryIssueStateInput): MaybePromise<MemoryIssueState>;
  getMemoryIssueState(issueId: string): MaybePromise<MemoryIssueState | null>;
  listMemoryIssueStates(query?: ListMemoryIssueStatesQuery): MaybePromise<MemoryIssueState[]>;
  createMemoryConsolidationRun(input: CreateMemoryConsolidationRunInput): MaybePromise<MemoryConsolidationRun>;
  getMemoryConsolidationRun(runId: string): MaybePromise<MemoryConsolidationRun>;
  updateMemoryConsolidationRun(runId: string, input: UpdateMemoryConsolidationRunInput): MaybePromise<MemoryConsolidationRun>;
  createMemoryConsolidationFinding(input: CreateMemoryConsolidationFindingInput): MaybePromise<MemoryConsolidationFinding>;
  updateMemoryConsolidationFinding(
    findingId: string,
    input: UpdateMemoryConsolidationFindingInput
  ): MaybePromise<MemoryConsolidationFinding>;
  listMemoryConsolidationFindings(runId: string, limit?: number): MaybePromise<MemoryConsolidationFinding[]>;
  createMemoryConsolidationOperation(input: CreateMemoryConsolidationOperationInput): MaybePromise<MemoryConsolidationOperation>;
  updateMemoryConsolidationOperation(
    operationId: string,
    input: UpdateMemoryConsolidationOperationInput
  ): MaybePromise<MemoryConsolidationOperation>;
  listMemoryConsolidationOperations(runId: string, limit?: number): MaybePromise<MemoryConsolidationOperation[]>;
  claimMemoryCommand(input: ClaimMemoryCommandInput): MaybePromise<MemoryCommandClaim>;
  createMemoryChangeSet(
    input: CreateMemoryChangeSetInput,
    traceId?: string,
    options?: CreateMemoryChangeSetOptions
  ): MaybePromise<MemoryChangeSet>;
  getMemoryChangeSet(changeSetId: string): MaybePromise<MemoryChangeSet>;
  updateMemoryChangeSet(changeSetId: string, input: UpdateMemoryChangeSetInput): MaybePromise<MemoryChangeSet>;
  listMemoryChangeSets(query?: ListMemoryChangeSetsQuery): MaybePromise<MemoryChangeSetSummary[]>;
  createArtifact(input: CreateArtifactInput, traceId?: string): MaybePromise<ArtifactRecord>;
  getArtifact(artifactId: string): MaybePromise<Artifact>;
  listArtifacts(query?: ListArtifactsQuery): MaybePromise<Artifact[]>;
  updateArtifactRetention(artifactId: string, input: UpdateArtifactRetentionInput): MaybePromise<Artifact>;
  deleteExpiredBrowserArtifacts(at?: string): MaybePromise<Artifact[]>;
  deleteArtifact(artifactId: string): MaybePromise<Artifact>;
  createReviewDecision(input: CreateReviewDecisionInput, traceId?: string): MaybePromise<ReviewDecisionRecord>;
  listReviewDecisions(query?: ListReviewDecisionsQuery): MaybePromise<ReviewDecision[]>;
  createReviewCheck(input: CreateReviewCheckInput, traceId?: string): MaybePromise<ReviewCheckRecord>;
  listReviewChecks(query?: ListReviewChecksQuery): MaybePromise<ReviewCheck[]>;
  createReviewDiffSummary(input: CreateReviewDiffSummaryInput, traceId?: string): MaybePromise<ReviewDiffSummaryRecord>;
  listReviewDiffSummaries(query?: ListReviewDiffSummariesQuery): MaybePromise<ReviewDiffSummary[]>;
  listSwarmTasks(query?: ListSwarmTasksQuery): MaybePromise<SwarmTask[]>;
  createSwarmTask(input: CreateSwarmTaskInput, traceId?: string): MaybePromise<SwarmTaskRecord>;
  updateSwarmTask(taskId: string, input: UpdateSwarmTaskInput, traceId?: string): MaybePromise<SwarmTaskRecord>;
  claimSwarmLock(input: ClaimSwarmLockInput, traceId?: string): MaybePromise<SwarmLockRecord>;
  releaseSwarmLock(lockId: string, input?: ReleaseSwarmLockInput, traceId?: string): MaybePromise<SwarmLockRecord>;
  postSwarmMessage(input: PostSwarmMessageInput, traceId?: string): MaybePromise<SwarmMessageRecord>;
  createSwarmReconcile(input: CreateSwarmReconcileInput, traceId?: string): MaybePromise<SwarmReconcileRecord>;
  getSwarmState(roomId?: string): MaybePromise<SwarmState>;
}

export class SpaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceConflictError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceNotFoundError";
  }
}

const browserHandoffTransitions: Record<BrowserHandoffStatus, readonly BrowserHandoffStatus[]> = {
  REQUESTED: ["REQUESTED", "ACCEPTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: ["ACCEPTED", "COMPLETED", "EXPIRED", "CANCELLED"],
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["EXPIRED"],
  CANCELLED: ["CANCELLED"]
};

export function assertBrowserHandoffTransition(
  current: BrowserHandoffStatus,
  next: BrowserHandoffStatus
): void {
  if (!browserHandoffTransitions[current].includes(next)) {
    throw new SpaceConflictError(`Browser handoff cannot transition from ${current} to ${next}.`);
  }
}

export class SpaceFeatureDisabledError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "SpaceFeatureDisabledError";
  }
}

export const nowIso = () => new Date().toISOString();
export const makeSpaceId = (prefix: string) => `${prefix}:${nanoid(12)}`;
export const hashPrompt = (prompt: string) => createHash("sha256").update(prompt).digest("hex");

export function redactMemoryText(value: string): string {
  return redactPersistedTranscriptContent(value);
}

const cliMaintenanceSensitiveKeyPattern =
  /(?:authorization|cookie|credential|password|refresh[_-]?token|access[_-]?token|session|secret|api[_-]?key)/i;
const cliMaintenanceSensitiveValuePatterns = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bspace_session=[^;\s]+/gi
];

function redactCliMaintenanceString(value: string): string {
  let redacted = value;
  for (const pattern of cliMaintenanceSensitiveValuePatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted.length <= 2_000 ? redacted : `${redacted.slice(0, 1_980)}…[TRUNCATED]`;
}

export function redactCliMaintenanceDiagnostics(
  value: Record<string, unknown>
): CliMaintenanceDiagnostics {
  const seen = new WeakSet<object>();
  let remainingEntries = 128;
  let remainingCharacters = 9_000;
  const sanitize = (candidate: unknown, depth: number): unknown => {
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") return candidate;
    if (typeof candidate === "string") {
      const safe = redactCliMaintenanceString(candidate);
      const bounded = safe.slice(0, Math.max(0, Math.min(2_000, remainingCharacters)));
      remainingCharacters -= bounded.length;
      return bounded;
    }
    if (typeof candidate === "bigint") return candidate.toString().slice(0, 80);
    if (depth >= 6 || remainingEntries <= 0 || remainingCharacters <= 0) return null;
    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) return "[REDACTED_CIRCULAR]";
      seen.add(candidate);
      return candidate.slice(0, 64).map((entry) => {
        remainingEntries -= 1;
        return sanitize(entry, depth + 1);
      });
    }
    if (typeof candidate === "object") {
      if (seen.has(candidate)) return "[REDACTED_CIRCULAR]";
      seen.add(candidate);
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(candidate).slice(0, 64)) {
        if (remainingEntries <= 0 || remainingCharacters <= 0) break;
        remainingEntries -= 1;
        const safeKey = key.slice(0, Math.max(1, Math.min(80, remainingCharacters)));
        remainingCharacters -= safeKey.length;
        result[safeKey] = cliMaintenanceSensitiveKeyPattern.test(key)
          ? "[REDACTED]"
          : sanitize(entry, depth + 1);
      }
      return result;
    }
    return `[UNSUPPORTED_${typeof candidate}]`;
  };
  return cliMaintenanceDiagnosticsSchema.parse(sanitize(value, 0));
}

const memoryChangeStatusTransitions: Record<MemoryChangeSet["status"], readonly MemoryChangeSet["status"][]> = {
  PROPOSED: ["APPROVED", "REJECTED"],
  APPROVED: ["APPLYING", "REJECTED"],
  APPLYING: ["APPLIED", "FAILED"],
  APPLIED: [],
  FAILED: [],
  ROLLED_BACK: [],
  REJECTED: []
};

export function assertMemoryChangeStatusTransition(
  current: MemoryChangeSet["status"],
  next: MemoryChangeSet["status"]
): void {
  if (!memoryChangeStatusTransitions[current].includes(next)) {
    throw new SpaceConflictError(`Memory change set cannot transition from ${current} to ${next}.`);
  }
}

const memoryConsolidationRunTransitions: Record<MemoryConsolidationRun["status"], readonly MemoryConsolidationRun["status"][]> = {
  QUEUED: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: []
};

export function assertMemoryConsolidationRunTransition(
  current: MemoryConsolidationRun["status"],
  next: MemoryConsolidationRun["status"]
): void {
  if (!memoryConsolidationRunTransitions[current].includes(next)) {
    throw new SpaceConflictError(`Memory consolidation cannot transition from ${current} to ${next}.`);
  }
}

const memoryConsolidationFindingTransitions: Record<
  MemoryConsolidationFinding["status"],
  readonly MemoryConsolidationFinding["status"][]
> = {
  OPEN: ["APPLIED", "SKIPPED"],
  APPLIED: [],
  SKIPPED: []
};

export function assertMemoryConsolidationFindingTransition(
  current: MemoryConsolidationFinding["status"],
  next: MemoryConsolidationFinding["status"]
): void {
  if (!memoryConsolidationFindingTransitions[current].includes(next)) {
    throw new SpaceConflictError(`Memory consolidation finding cannot transition from ${current} to ${next}.`);
  }
}

const memoryConsolidationOperationTransitions: Record<
  MemoryConsolidationOperation["status"],
  readonly MemoryConsolidationOperation["status"][]
> = {
  PROPOSED: ["APPLYING", "SKIPPED"],
  APPLYING: ["APPLIED", "FAILED"],
  APPLIED: [],
  SKIPPED: [],
  FAILED: []
};

export function assertMemoryConsolidationOperationTransition(
  current: MemoryConsolidationOperation["status"],
  next: MemoryConsolidationOperation["status"]
): void {
  if (!memoryConsolidationOperationTransitions[current].includes(next)) {
    throw new SpaceConflictError(`Memory consolidation operation cannot transition from ${current} to ${next}.`);
  }
}

export function hashMemorySnapshot(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

export function normalizeMemoryChangeSetInput(input: CreateMemoryChangeSetInput): CreateMemoryChangeSetInput {
  const parsed = createMemoryChangeSetInputSchema.parse(input);
  if (hashMemorySnapshot(parsed.beforeSnapshot) !== parsed.beforeContentHash) {
    throw new SpaceConflictError("Memory change-set before snapshot does not match its content hash.");
  }
  if (hashMemorySnapshot(parsed.afterSnapshot) !== parsed.afterContentHash) {
    throw new SpaceConflictError("Memory change-set after snapshot does not match its content hash.");
  }
  return parsed;
}

export function memoryChangeSetMatchesInput(
  changeSet: MemoryChangeSet,
  input: CreateMemoryChangeSetInput
): boolean {
  const parsed = normalizeMemoryChangeSetInput(input);
  return changeSet.kind === parsed.kind &&
    changeSet.sourcePath === parsed.sourcePath &&
    JSON.stringify(changeSet.recordIds) === JSON.stringify(Array.from(new Set(parsed.recordIds))) &&
    JSON.stringify(changeSet.resolvesIssueIds) === JSON.stringify(Array.from(new Set(parsed.resolvesIssueIds))) &&
    changeSet.expectedSourceHash === parsed.expectedSourceHash &&
    changeSet.beforeContentHash === parsed.beforeContentHash &&
    changeSet.afterContentHash === parsed.afterContentHash &&
    changeSet.beforeSnapshot === parsed.beforeSnapshot &&
    changeSet.afterSnapshot === parsed.afterSnapshot &&
    changeSet.reason === redactMemoryText(parsed.reason) &&
    changeSet.actorUserId === parsed.actorUserId &&
    changeSet.rollbackOfChangeSetId === (parsed.rollbackOfChangeSetId ?? null);
}

export function assertMemoryRollbackTarget(input: CreateMemoryChangeSetInput, target: MemoryChangeSet): void {
  if (target.status !== "APPLIED" || target.rolledBackByChangeSetId) {
    throw new SpaceConflictError(`Memory change set ${target.id} is not eligible for rollback.`);
  }
  if (
    input.sourcePath !== target.sourcePath ||
    input.expectedSourceHash !== target.resultingSourceHash ||
    input.beforeContentHash !== target.afterContentHash ||
    input.afterContentHash !== target.beforeContentHash ||
    input.beforeSnapshot !== target.afterSnapshot ||
    input.afterSnapshot !== target.beforeSnapshot
  ) {
    throw new SpaceConflictError(`Memory rollback ${target.id} must exactly reverse its target snapshots and hashes.`);
  }
}

function isFiniteVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function assertMemorySearchModeEnabled(query: ListMemoryQuery, options: ListMemoryEntriesOptions = {}): void {
  if (query.searchMode === "semantic" && !(options.semanticReady === true && isFiniteVector(options.queryEmbedding))) {
    throw new SpaceFeatureDisabledError(
      "MEMORY_SEMANTIC_DISABLED",
      "Semantic memory search is disabled until an embedding provider passes smoke validation.",
      {
        searchMode: "semantic",
        requiredSmoke: "embedding-provider"
      }
    );
  }
}

function normalizeAllowedTools(allowedTools: readonly string[] = []): string[] {
  return Array.from(new Set(allowedTools.map((tool) => redactMemoryText(tool.trim())).filter(Boolean))).sort();
}

export function normalizeSkillProposalInput(input: CreateSkillProposalInput): CreateSkillProposalInput {
  return {
    displayName: redactMemoryText(input.displayName.trim()),
    version: redactMemoryText(input.version.trim()),
    triggerDescription: redactMemoryText(input.triggerDescription.trim()),
    body: redactMemoryText(input.body.trim()),
    allowedTools: normalizeAllowedTools(input.allowedTools)
  };
}

export function hashSkillProposal(input: CreateSkillProposalInput): string {
  const normalized = normalizeSkillProposalInput(input);
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex")}`;
}

export function normalizeImportCandidateInput(input: CreateImportCandidateInput): CreateImportCandidateInput {
  const memoryScope = input.memoryScope ?? "ROOM";
  const provenance = input.provenance ?? "explicit-import-gate";
  const skillVersion = input.skillVersion ?? "0.1.0";
  const allowedTools = input.allowedTools ?? [];

  return {
    sourceKind: input.sourceKind,
    targetKind: input.targetKind,
    sourceRef: redactMemoryText(input.sourceRef.trim()),
    roomId: input.targetKind === "MEMORY" && memoryScope === "ROOM" ? input.roomId ?? null : null,
    memoryScope,
    title: redactMemoryText(input.title.trim()),
    body: redactMemoryText(input.body.trim()),
    provenance: redactMemoryText(provenance.trim()),
    skillVersion: redactMemoryText(skillVersion.trim()),
    skillTriggerDescription: input.skillTriggerDescription ? redactMemoryText(input.skillTriggerDescription.trim()) : undefined,
    allowedTools: normalizeAllowedTools(allowedTools)
  };
}

export function redactArtifactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[REDACTED_DEPTH]";
  }
  if (typeof value === "string") {
    return redactMemoryText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactArtifactMetadata(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        redactMemoryText(key),
        redactArtifactMetadata(item, depth + 1)
      ])
    );
  }
  return value;
}

export function normalizeArtifactInput(input: CreateArtifactInput): CreateArtifactInput {
  return {
    roomId: input.roomId ?? null,
    paneId: input.paneId ?? null,
    turnId: input.turnId ?? null,
    workflowId: input.workflowId ?? null,
    kind: input.kind,
    mimeType: redactMemoryText(input.mimeType.trim()),
    storageUri: redactMemoryText(input.storageUri.trim()),
    sha256: input.sha256.trim(),
    byteSize: input.byteSize,
    metadata: redactArtifactMetadata(input.metadata ?? {}) as Record<string, unknown>,
    expiresAt: input.expiresAt ?? null,
    pinnedAt: input.pinnedAt ?? null,
    deletedAt: input.deletedAt ?? null
  };
}

function uniqueSpaceIds(ids: readonly string[] = []): string[] {
  return Array.from(new Set(ids)).sort();
}

export function normalizeSwarmTaskInput(input: CreateSwarmTaskInput): CreateSwarmTaskInput {
  return {
    roomId: input.roomId,
    parentTaskId: input.parentTaskId ?? null,
    role: input.role ?? "WORKER",
    title: redactMemoryText(input.title.trim()),
    goal: redactMemoryText(input.goal.trim()),
    assignee: input.assignee ? redactMemoryText(input.assignee.trim()) : null,
    dependsOnTaskIds: uniqueSpaceIds(input.dependsOnTaskIds ?? [])
  };
}

export function normalizeSwarmTaskUpdate(input: UpdateSwarmTaskInput): UpdateSwarmTaskInput {
  return {
    status: input.status,
    assignee: input.assignee === undefined ? undefined : input.assignee === null ? null : redactMemoryText(input.assignee.trim()),
    dependsOnTaskIds: input.dependsOnTaskIds ? uniqueSpaceIds(input.dependsOnTaskIds) : undefined,
    lockIds: input.lockIds ? uniqueSpaceIds(input.lockIds) : undefined,
    resultSummary:
      input.resultSummary === undefined ? undefined : input.resultSummary === null ? null : redactMemoryText(input.resultSummary.trim())
  };
}

export function normalizeSwarmLockInput(input: ClaimSwarmLockInput): ClaimSwarmLockInput {
  return {
    roomId: input.roomId,
    taskId: input.taskId ?? null,
    resource: redactMemoryText(input.resource.trim()),
    holder: redactMemoryText(input.holder.trim()),
    reason: redactMemoryText(input.reason.trim())
  };
}

export function normalizeSwarmMessageInput(input: PostSwarmMessageInput): PostSwarmMessageInput {
  return {
    roomId: input.roomId,
    taskId: input.taskId ?? null,
    fromRole: input.fromRole,
    toRole: input.toRole ?? null,
    body: redactMemoryText(input.body.trim())
  };
}

export function normalizeSwarmReconcileInput(input: CreateSwarmReconcileInput): CreateSwarmReconcileInput {
  return {
    roomId: input.roomId,
    taskIds: uniqueSpaceIds(input.taskIds),
    decision: input.decision,
    summary: redactMemoryText(input.summary.trim()),
    nextSteps: redactMemoryText((input.nextSteps ?? "").trim())
  };
}

const swarmExecutionDisabled = {
  executionStatus: "DISABLED" as const,
  statusReason: "Swarm execution is control-plane only until worker/agent smoke is explicitly approved and verified."
};

export const defaultPaneTitles = [
  "Planner",
  "Builder",
  "Reviewer",
  "Ops",
  "Browser QA",
  "Verifier",
  "Memory",
  "Swarm"
];

export interface SpaceStoreSnapshot {
  rooms: Room[];
  panes: Pane[];
  clipboardItems: Array<{ ownerUserId: string; item: ClipboardItem }>;
  taskItems: Array<{ ownerUserId: string; item: TaskItem }>;
  userLinks: Array<{ ownerUserId: string; item: UserLink }>;
  roomAgentRequests: RoomAgentRequestRecord[];
  roomAgentMissions: RoomAgentMissionRecord[];
  roomAgentActions: RoomAgentActionRecord[];
  roomAgentTaskRuns: RoomAgentTaskRunRecord[];
  agentPaneBindings: AgentPaneBinding[];
  agentPaneSessions: AgentPaneStoredSession[];
  spaceAgentSessions: SpaceAgentSessionRecord[];
  spaceAgentMessages: SpaceAgentMessageRecord[];
  spaceAgentRuns: SpaceAgentRunRecord[];
  paneCliSessions: PaneCliSession[];
  paneCliTerminalControlLeases: PaneCliTerminalControlLease[];
  cliTasks: CliTaskRecord[];
  cliTaskRevisions: CliTaskRevisionRecord[];
  paneCliTranscriptChunks: PaneCliTranscriptChunk[];
  paneCliCodexThreadOwnerships: PaneCliCodexThreadOwnership[];
  workflows: WorkflowRun[];
  turns: Turn[];
  events: Event[];
  auditEvents: AuditEvent[];
  codexAppServerHandshakeChecks: CodexAppServerHandshakeCheck[];
  codexAppServerTurnSmokeChecks: CodexAppServerTurnSmokeCheck[];
  providers: Provider[];
  providerSettings: ProviderSettings;
  codexCliModeDefaults: CodexCliModeDefaults | null;
  cliRuntimeSettings: CliRuntimeSetting[];
  agentToolAssignments: AgentToolAssignment[];
  adminOperationRuns: AdminOperationRun[];
  cliMaintenanceEvents: CliMaintenanceEvent[];
  cliMaintenanceAuthHandoffs: CliMaintenanceAuthHandoff[];
  sourceControlConnections: SourceControlConnectionRecord[];
  releasePreviews: ReleasePreviewRecord[];
  models: Model[];
  capabilities: Capability[];
  mcpGatewayStatus: McpGatewayStatus;
  mcpServers: McpServer[];
  mcpTools: McpTool[];
  mcpDiscoverySmokeChecks: McpDiscoverySmokeCheck[];
  memoryEmbeddingSmokeChecks: MemoryEmbeddingSmokeCheck[];
  skills: Skill[];
  memoryEntries: MemoryEntry[];
  memoryCacheLinks: MemoryCacheLink[];
  memoryIssueStates: MemoryIssueState[];
  memoryConsolidationRuns: MemoryConsolidationRun[];
  memoryConsolidationFindings: MemoryConsolidationFinding[];
  memoryConsolidationOperations: MemoryConsolidationOperation[];
  memoryCommandIdempotency: MemoryCommandIdempotency[];
  memoryChangeSets: MemoryChangeSet[];
  artifacts: Artifact[];
  reviewDecisions: ReviewDecision[];
  reviewChecks: ReviewCheck[];
  reviewDiffs: ReviewDiffSummary[];
  swarmTasks: SwarmTask[];
  swarmLocks: SwarmLock[];
  swarmMessages: SwarmMessage[];
  swarmReconciles: SwarmReconcile[];
}

export interface StaticCatalogOptions {
  codexLbConfigured?: boolean;
  codexLbBaseUrl?: string | null;
  mcpServerConfigs?: readonly McpServerConfig[];
  mcpConfigError?: string | null;
  codexSkillRoots?: readonly string[];
  codexPluginSkillRoots?: readonly string[];
}

const mcpTargetSpecVersion = "2025-11-25";
const defaultProviderId = "headroom-gateway";
const defaultTitleGenerationReasoningEffort: ProviderSettings["titleGenerationReasoningEffort"] = "low";
const spaceDefaultMcpMetadata: Array<Pick<McpServer, "id" | "displayName" | "transport">> = [
  { id: "capturelab", displayName: "CaptureLab", transport: "stdio" },
  { id: "devtools", displayName: "DevTools", transport: "stdio" },
  { id: "olla", displayName: "Olla", transport: "stdio" },
  { id: "summary_tools", displayName: "Summary Tools", transport: "stdio" }
];

function maxIso(values: Array<string | null>): string | null {
  const filtered = values.filter((value): value is string => Boolean(value));
  return filtered.length ? filtered.sort().at(-1) ?? null : null;
}

export function buildMcpGatewayStatusFromCatalog(
  servers: readonly McpServer[],
  tools: readonly McpTool[],
  targetSpecVersion = mcpTargetSpecVersion
): McpGatewayStatus {
  const hasError = servers.some((server) => server.status === "ERROR") || tools.some((tool) => tool.status === "ERROR");
  const hasVerifiedMetadata =
    servers.some((server) => server.status === "VERIFIED") || tools.some((tool) => tool.status === "VERIFIED");
  const status = hasError ? "ERROR" : hasVerifiedMetadata ? "VERIFIED" : "DISABLED";
  return {
    id: "mcp-gateway",
    status,
    statusReason:
      status === "ERROR"
        ? "MCP discovery metadata contains an error; tool execution remains disabled."
        : status === "VERIFIED"
          ? "MCP discovery metadata is persisted; tool execution remains disabled until approvals and allowlists pass."
          : "MCP discovery metadata is not verified; tool execution is disabled.",
    targetSpecVersion,
    approvalMode: "DISABLED",
    serverCount: servers.length,
    toolCount: tools.length,
    lastDiscoveryAt: maxIso(servers.map((server) => server.lastDiscoveredAt))
  };
}

export function normalizeMcpDiscoveryCatalog(input: RecordMcpDiscoveryCatalogInput): McpDiscoveryCatalogRecord {
  const discoveredAt = input.discoveredAt ?? nowIso();
  const toolCounts = new Map<string, number>();
  for (const tool of input.tools) {
    toolCounts.set(tool.serverId, (toolCounts.get(tool.serverId) ?? 0) + 1);
  }
  const serverIds = new Set(input.servers.map((server) => server.id));
  const missingServer = input.tools.find((tool) => !serverIds.has(tool.serverId));
  if (missingServer) {
    throw new SpaceConflictError(`MCP tool ${missingServer.id} references unknown server ${missingServer.serverId}.`);
  }

  const servers = input.servers.map((server) => ({
    ...server,
    toolCount: toolCounts.get(server.id) ?? 0,
    lastDiscoveredAt: server.lastDiscoveredAt ?? discoveredAt
  }));
  const tools = [...input.tools];
  return {
    gatewayStatus: buildMcpGatewayStatusFromCatalog(servers, tools),
    servers,
    tools
  };
}

function buildMcpCapabilities(gatewayStatus: McpGatewayStatus, tools: readonly McpTool[]): Capability[] {
  return [
    {
      id: "mcp-gateway",
      kind: "MCP_SERVER" as const,
      displayName: "Space MCP Gateway",
      status: gatewayStatus.status,
      statusReason: gatewayStatus.statusReason,
      requiresApproval: true
    },
    ...tools.map((tool) => ({
      id: tool.id,
      kind: "MCP_TOOL" as const,
      displayName: tool.name,
      status: tool.status,
      statusReason: tool.statusReason,
      requiresApproval: tool.approvalRequired
    }))
  ];
}

export function replaceMcpCapabilities(
  capabilities: readonly Capability[],
  gatewayStatus: McpGatewayStatus,
  tools: readonly McpTool[]
): Capability[] {
  return [
    ...capabilities.filter((capability) => capability.kind !== "MCP_SERVER" && capability.kind !== "MCP_TOOL"),
    ...buildMcpCapabilities(gatewayStatus, tools)
  ];
}

function buildMcpConfigHash(config: McpServerConfig): string {
  return hashMcpSchema({
    id: config.id,
    displayName: config.displayName,
    transport: config.transport,
    command: config.command ?? null,
    args: config.args,
    url: config.url ?? null,
    enabled: config.enabled
  });
}

function buildMcpMetadataHash(id: string): string {
  return `sha256:${createHash("sha256").update(`space-mcp-metadata:${id}`).digest("hex")}`;
}

function withSpaceMcpMetadata(configuredServers: readonly McpServer[], configuredServerIds: ReadonlySet<string>): McpServer[] {
  if (!configuredServerIds.has("space-readonly")) {
    return [...configuredServers];
  }
  const serversById = new Map(configuredServers.map((server) => [server.id, server]));
  for (const metadata of spaceDefaultMcpMetadata) {
    if (serversById.has(metadata.id)) continue;
    serversById.set(metadata.id, {
      ...metadata,
      status: "DISABLED",
      statusReason: "Space Codex MCP metadata is visible for operator context only; execution requires discovery smoke, schema allowlist, and approval policy.",
      schemaVersion: mcpTargetSpecVersion,
      configHash: buildMcpMetadataHash(metadata.id),
      toolCount: 0,
      lastDiscoveredAt: null
    });
  }
  return [...serversById.values()];
}

function buildMcpCatalog(options: Pick<StaticCatalogOptions, "mcpServerConfigs" | "mcpConfigError">): {
  mcpGatewayStatus: McpGatewayStatus;
  mcpServers: McpServer[];
  mcpTools: McpTool[];
} {
  const configError = options.mcpConfigError?.trim();
  if (configError) {
    const mcpServers: McpServer[] = [
      {
        id: "mcp-gateway",
        displayName: "Space MCP Gateway",
        transport: "stdio",
        status: "ERROR",
        statusReason: "MCP server config is invalid; discovery and tool execution are disabled.",
        schemaVersion: mcpTargetSpecVersion,
        configHash: "invalid-config",
        toolCount: 0,
        lastDiscoveredAt: null
      }
    ];
    return {
      mcpServers,
      mcpTools: [],
      mcpGatewayStatus: {
        id: "mcp-gateway",
        status: "ERROR",
        statusReason: "MCP server config is invalid; discovery and tool execution are disabled.",
        targetSpecVersion: mcpTargetSpecVersion,
        approvalMode: "DISABLED",
        serverCount: mcpServers.length,
        toolCount: 0,
        lastDiscoveryAt: null
      }
    };
  }

  const configuredServers = options.mcpServerConfigs ?? [];
  if (configuredServers.length === 0) {
    const mcpServers: McpServer[] = [
      {
        id: "mcp-gateway",
        displayName: "Space MCP Gateway",
        transport: "stdio",
        status: "DISABLED",
        statusReason: "Gateway registry exists, but no MCP server has passed discovery smoke.",
        schemaVersion: mcpTargetSpecVersion,
        configHash: "unconfigured",
        toolCount: 0,
        lastDiscoveredAt: null
      }
    ];
    return {
      mcpServers,
      mcpTools: [],
      mcpGatewayStatus: {
        id: "mcp-gateway",
        status: "DISABLED",
        statusReason: "MCP discovery and tool execution are disabled until explicit server config, schema capture, and allowlist smoke pass.",
        targetSpecVersion: mcpTargetSpecVersion,
        approvalMode: "DISABLED",
        serverCount: mcpServers.length,
        toolCount: 0,
        lastDiscoveryAt: null
      }
    };
  }

  const configuredMcpServers: McpServer[] = configuredServers.map((config) => ({
    id: config.id,
    displayName: config.displayName,
    transport: config.transport,
    status: "DISABLED",
    statusReason: "MCP server config is loaded, but discovery smoke has not run.",
    schemaVersion: mcpTargetSpecVersion,
    configHash: buildMcpConfigHash(config),
    toolCount: 0,
    lastDiscoveredAt: null
  }));
  const mcpServers = withSpaceMcpMetadata(
    configuredMcpServers,
    new Set(configuredServers.map((config) => config.id))
  );
  return {
    mcpServers,
    mcpTools: [],
    mcpGatewayStatus: {
      id: "mcp-gateway",
      status: "DISABLED",
      statusReason: `${mcpServers.length} MCP server config(s) loaded, but discovery and tool execution are disabled until smoke and approvals pass.`,
      targetSpecVersion: mcpTargetSpecVersion,
      approvalMode: "DISABLED",
      serverCount: mcpServers.length,
      toolCount: 0,
      lastDiscoveryAt: null
    }
  };
}

const defaultCodexSkillRoots = ["/var/lib/spaceapp-user/.codex/skills"];
const defaultCodexPluginSkillRoots = ["/var/lib/spaceapp-user/.codex/plugins/cache/personal"];
const codexSkillBodyMaxLength = 18_000;
const codexSkillSearchMaxDepth = 8;
const legacySpaceHostNamePattern = new RegExp(`${"vm"}${"207"}`, "gi");
const legacySpaceHostAddressPattern = new RegExp(`10\\.100\\.0\\.${"207"}`, "g");

function redactSpaceHostReference(value: string): string {
  return value.replace(legacySpaceHostNamePattern, "Space host").replace(legacySpaceHostAddressPattern, "Space host");
}

function safeSkillId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-:]+|[-:]+$/g, "")
      .slice(0, 160) || "codex-skill"
  );
}

function titleFromSkillId(value: string): string {
  return value
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function parseSkillFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return {};
  const frontmatter = markdown.slice(3, end).split(/\r?\n/);
  const parsed: Record<string, string> = {};
  for (const line of frontmatter) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) parsed[key] = value;
  }
  return parsed;
}

function collectSkillMarkdownFiles(root: string, depth = 0): string[] {
  if (depth > codexSkillSearchMaxDepth || !existsSync(root)) return [];
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return [];
  }
  if (rootStat.isFile()) {
    return basename(root) === "SKILL.md" ? [root] : [];
  }
  if (!rootStat.isDirectory()) return [];

  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry === ".git") continue;
    files.push(...collectSkillMarkdownFiles(join(root, entry), depth + 1));
  }
  return files;
}

function pluginPrefixForSkill(root: string, filePath: string): string | null {
  const relative = filePath.startsWith(root) ? filePath.slice(root.length).replace(/^\/+/, "") : filePath;
  const parts = relative.split("/").filter(Boolean);
  const skillsIndex = parts.indexOf("skills");
  if (skillsIndex > 0) {
    return safeSkillId(parts.slice(0, skillsIndex).filter((part) => !/^\d+\.\d+\.\d+/.test(part)).join(":"));
  }
  return null;
}

function buildCodexFilesystemSkill(filePath: string, idPrefix: string | null): Skill | null {
  let markdown: string;
  try {
    markdown = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const metadata = parseSkillFrontmatter(markdown);
  const folderName = basename(filePath === "SKILL.md" ? filePath : filePath.split("/").slice(-2, -1)[0] ?? "codex-skill");
  const baseId = safeSkillId(metadata.name || folderName);
  const id = idPrefix ? safeSkillId(`${idPrefix}:${baseId}`) : baseId;
  const displayName = redactSpaceHostReference(
    redactMemoryText(metadata.name ? titleFromSkillId(metadata.name) : titleFromSkillId(baseId))
  ).slice(0, 160);
  const triggerDescription = redactSpaceHostReference(
    redactMemoryText(metadata.description || `Use the ${displayName} Codex skill when its trigger applies.`)
  ).slice(0, 500);
  const body = redactSpaceHostReference(redactMemoryText(markdown)).slice(0, codexSkillBodyMaxLength);
  const normalized = normalizeSkillProposalInput({
    displayName,
    version: "filesystem",
    triggerDescription,
    body,
    allowedTools: []
  });
  return {
    id,
    ...normalized,
    status: "VERIFIED",
    statusReason: "Read-only Codex skill discovered from the shared Space skill registry.",
    contentHash: hashSkillProposal(normalized),
    source: "CODEX_SKILL",
    createdAt: null,
    updatedAt: null
  };
}

function discoverCodexFilesystemSkills(options: StaticCatalogOptions): Skill[] {
  const skillsById = new Map<string, Skill>();
  const coreRoots = options.codexSkillRoots ?? defaultCodexSkillRoots;
  for (const root of coreRoots) {
    for (const filePath of collectSkillMarkdownFiles(root)) {
      const skill = buildCodexFilesystemSkill(filePath, null);
      if (skill && !skillsById.has(skill.id)) skillsById.set(skill.id, skill);
    }
  }

  const pluginRoots = options.codexPluginSkillRoots ?? defaultCodexPluginSkillRoots;
  for (const root of pluginRoots) {
    for (const filePath of collectSkillMarkdownFiles(root)) {
      const skill = buildCodexFilesystemSkill(filePath, pluginPrefixForSkill(root, filePath));
      if (skill && !skillsById.has(skill.id)) skillsById.set(skill.id, skill);
    }
  }
  return [...skillsById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function createStaticCatalog(options: StaticCatalogOptions = {}) {
  const codexConfigured = options.codexLbConfigured === true;

  const providers: Provider[] = [
    {
      id: "headroom-gateway",
      displayName: "Headroom Gateway",
      type: "CODEX_LB",
      status: "DISABLED",
      statusReason: codexConfigured
        ? "Headroom route is registered, but Space keeps it disabled until an explicit credential smoke passes."
        : "Dedicated Space Codex-LB key has not been verified yet.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: "https://headroom.example.invalid:8787/v1",
      routeProfile: "headroom",
      backingProviderId: "codex-lb",
      credentialRef: null,
      isBuiltIn: true
    },
    {
      id: "direct-246-primary",
      displayName: "Direct .246 Primary",
      type: "CODEX_LB",
      status: "DISABLED",
      statusReason: codexConfigured
        ? "Direct .246 route is registered, but Space keeps it disabled until an explicit credential smoke passes."
        : "Dedicated Space Codex-LB key has not been verified yet.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: "http://192.0.2.246:2455/v1",
      routeProfile: "direct-primary",
      backingProviderId: "codex-lb",
      credentialRef: null,
      isBuiltIn: true
    },
    {
      id: "direct-auto-failover",
      displayName: "Direct Auto Failover",
      type: "CODEX_LB",
      status: "DISABLED",
      statusReason: codexConfigured
        ? "Direct auto-failover route is registered, but Space keeps it disabled until an explicit credential smoke passes."
        : "Dedicated Space Codex-LB key has not been verified yet.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: options.codexLbBaseUrl ?? "http://127.0.0.1:2458/v1",
      routeProfile: "direct-auto",
      backingProviderId: "codex-lb",
      credentialRef: null,
      isBuiltIn: true
    },
    {
      id: "strict-234-direct",
      displayName: "Strict .234 Direct",
      type: "CODEX_LB",
      status: "DISABLED",
      statusReason: codexConfigured
        ? "Strict .234 route is registered, but Space keeps it disabled until an explicit credential smoke passes."
        : "Dedicated Space Codex-LB key has not been verified yet.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: "http://192.0.2.234:2455/v1",
      routeProfile: "direct-fallback",
      backingProviderId: "codex-lb",
      credentialRef: null,
      isBuiltIn: true
    },
    {
      id: "openai-chatgpt-plus-pro",
      displayName: "OpenAI / ChatGPT Plus-Pro",
      type: "OPENAI",
      status: "DISABLED",
      statusReason: "OpenAI direct route remains disabled until an explicit Space credential/config smoke passes.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: "https://api.openai.com/v1",
      routeProfile: "openai-direct",
      backingProviderId: "openai",
      credentialRef: null,
      isBuiltIn: true
    },
    {
      id: "codex-lb",
      displayName: "Codex-LB",
      type: "CODEX_LB",
      status: "DISABLED",
      statusReason: codexConfigured
        ? "Codex-LB config is present, but Space keeps the provider disabled until an explicit credential smoke passes."
        : "Dedicated Space Codex-LB key has not been verified yet.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: options.codexLbBaseUrl ?? null,
      routeProfile: "custom",
      backingProviderId: null,
      credentialRef: null,
      isBuiltIn: false
    },
    {
      id: "anthropic",
      displayName: "Anthropic",
      type: "ANTHROPIC",
      status: "DISABLED",
      statusReason: "Provider adapter exists only as a fail-closed placeholder until credentials pass smoke.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: null,
      routeProfile: "custom",
      backingProviderId: null,
      credentialRef: null,
      isBuiltIn: false
    },
    {
      id: "local",
      displayName: "Local Models",
      type: "LOCAL",
      status: "DISABLED",
      statusReason: "No local model runtime has been verified for Space.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: null,
      routeProfile: "custom",
      backingProviderId: null,
      credentialRef: null,
      isBuiltIn: false
    }
  ];

  const models: Model[] = [];

  const mcpCatalog = buildMcpCatalog(options);

  const planningSkill = normalizeSkillProposalInput({
    displayName: "Planning",
    version: "0.1.0",
    triggerDescription: "Break large work into verifiable slices.",
    body: "Plan work as small, verifiable implementation slices with tests and rollback notes.",
    allowedTools: []
  });
  const browserProofSkill = normalizeSkillProposalInput({
    displayName: "Browser Proof",
    version: "0.1.0",
    triggerDescription: "Requires Playwright pool integration and browser artifacts.",
    body: "Collect screenshot, DOM, console and network evidence for browser-facing work after browser workers are enabled.",
    allowedTools: ["browser.captureScreenshot", "browser.collectConsole"]
  });

  const skills: Skill[] = [
    {
      id: "planning",
      ...planningSkill,
      status: "VERIFIED",
      statusReason: "Static Space bootstrap skill.",
      contentHash: hashSkillProposal(planningSkill),
      source: "STATIC",
      createdAt: null,
      updatedAt: null
    },
    {
      id: "browser-proof",
      ...browserProofSkill,
      status: "DISABLED",
      statusReason: "Requires Playwright pool integration and browser artifacts.",
      contentHash: hashSkillProposal(browserProofSkill),
      source: "STATIC",
      createdAt: null,
      updatedAt: null
    },
    ...discoverCodexFilesystemSkills(options)
  ];

  const capabilities: Capability[] = [
    ...providers.map((provider) => ({
      id: provider.id,
      kind: "PROVIDER" as const,
      displayName: provider.displayName,
      status: provider.status,
      statusReason: provider.statusReason,
      requiresApproval: false
    })),
    ...buildMcpCapabilities(mcpCatalog.mcpGatewayStatus, mcpCatalog.mcpTools),
    {
      id: "memory-registry",
      kind: "MEMORY_SCOPE",
      displayName: "Space Memory Registry",
      status: "VERIFIED",
      statusReason: "Explicit saves and keyword fallback search are enabled; embeddings are pending.",
      requiresApproval: false
    },
    {
      id: "browser-pool",
      kind: "BROWSER_POOL",
      displayName: "Playwright Browser Pool",
      status: "DISABLED",
      statusReason: "Browser workers are blocked until dedicated storage and browser install are complete.",
      requiresApproval: false
    }
  ];

  return { providers, models, capabilities, ...mcpCatalog, skills };
}

interface InMemoryClipboardRecord {
  ownerUserId: string;
  contentHash: string;
  sequence: number;
  item: ClipboardItem;
}

interface InMemoryTaskItemRecord {
  ownerUserId: string;
  contentHash: string;
  sequence: number;
  item: TaskItem;
}

interface InMemoryUserLinkRecord {
  ownerUserId: string;
  item: UserLink;
}

export const defaultUserLinks = [
  { title: "Codex LB", description: "Codex load-balancer dashboard and account routing.", url: "https://codex-lb.example.invalid:2455/", openMode: "EMBEDDED" as const, isQuick: true },
  { title: "Headroom", description: "Headroom capacity and routing dashboard.", url: "https://headroom.example.invalid:8787/dashboard", openMode: "EMBEDDED" as const, isQuick: true },
  { title: "Will Codex Quota Reset?", description: "Track Codex quota reset timing.", url: "https://www.willcodexquotareset.com/", openMode: "EMBEDDED" as const, isQuick: false },
  { title: "OpenAI Status", description: "Official OpenAI service status.", url: "https://status.openai.com/", openMode: "NEW_TAB" as const, isQuick: false }
];

export class InMemorySpaceStore implements SpaceStore {
  private rooms = new Map<string, Room>();
  private panes = new Map<string, Pane>();
  private roomAgentPaneIds = new Map<string, string>();
  private roomAgentTranscriptClearedAt = new Map<string, string>();
  private roomAgentRequests = new Map<string, RoomAgentRequestRecord>();
  private roomAgentMissions = new Map<string, RoomAgentMissionRecord>();
  private roomAgentActions = new Map<string, RoomAgentActionRecord>();
  private roomAgentTaskRuns = new Map<string, RoomAgentTaskRunRecord>();
  private roomAgentEnqueues = new Map<string, RoomAgentEnqueueRecord>();
  private agentPaneBindings = new Map<string, AgentPaneBinding>();
  private agentPaneSessions = new Map<string, AgentPaneStoredSession>();
  private spaceAgentSessions = new Map<string, SpaceAgentSessionRecord>();
  private spaceAgentMessages = new Map<string, SpaceAgentMessageRecord>();
  private spaceAgentRuns = new Map<string, SpaceAgentRunRecord>();
  private paneCliSessions = new Map<string, PaneCliSession>();
  private paneCliTerminalControlLeases = new Map<string, PaneCliTerminalControlLease>();
  private cliTasks = new Map<string, CliTaskRecord>();
  private cliTaskRevisions = new Map<string, CliTaskRevisionRecord>();
  private hiddenPaneCliTaskIds = new Set<string>();
  private paneCliTranscriptChunks = new Map<string, PaneCliTranscriptChunk>();
  private paneCliCodexThreadOwnerships = new Map<string, PaneCliCodexThreadOwnership>();
  private codexCliTurnMarkers = new Map<string, CodexCliTurnMarkerRecord>();
  private paneBrowserSessions = new Map<string, PaneBrowserSession>();
  private browserControlLeases = new Map<string, BrowserControlLease>();
  private browserCaptureJobs = new Map<string, BrowserCaptureJob>();
  private browserCaptureSegments = new Map<string, BrowserCaptureSegment>();
  private browserHandoffRequests = new Map<string, BrowserHandoffRequest>();
  private workflows = new Map<string, WorkflowRun>();
  private turns = new Map<string, Turn>();
  private events: Event[] = [];
  private eventRelaySequences = new Map<string, string>();
  private lastEventRelaySequence = 0n;
  private auditEvents: AuditEvent[] = [];
  private codexAppServerHandshakeChecks: CodexAppServerHandshakeCheck[] = [];
  private codexAppServerTurnSmokeChecks: CodexAppServerTurnSmokeCheck[] = [];
  private users = new Map<string, AuthUser>();
  private userPasswordHashes = new Map<string, string>();
  private ownerSetup: {
    tokenHash: string | null;
    expiresAt: string | null;
    ownerUserId: string | null;
    onboardingVersion: number;
    onboardingCompletedAt: string | null;
    starterRoomId: string | null;
  } | null = null;
  private setupConnectionVerifications = new Map<string, SetupConnectionVerification>();
  private setupConnectionCheckRuns = new Map<string, SetupConnectionCheckRun>();
  private setupConnectionCheckEvents = new Map<string, SetupConnectionCheckEvent>();
  private publicWaitlistSignups = new Map<string, PublicWaitlistSignupInput>();
  private clipboardItems = new Map<string, InMemoryClipboardRecord>();
  private clipboardSequence = 0;
  private taskItems = new Map<string, InMemoryTaskItemRecord>();
  private taskSequence = 0;
  private userLinks = new Map<string, InMemoryUserLinkRecord>();
  private initializedUserLinkLibraries = new Set<string>();
  private providers: Provider[];
  private providerSettings: ProviderSettings;
  private codexCliModeDefaults: CodexCliModeDefaults | null = null;
  private cliRuntimeSettings = new Map<CliToggleRuntimeId, CliRuntimeSetting>();
  private agentToolAssignments = new Map<string, AgentToolAssignment>();
  private adminOperationRuns = new Map<string, AdminOperationRun>();
  private cliMaintenanceEvents = new Map<string, CliMaintenanceEvent>();
  private cliMaintenanceAuthHandoffs = new Map<string, CliMaintenanceAuthHandoff>();
  private sourceControlConnections = new Map<SourceControlProvider, SourceControlConnectionRecord>();
  private releasePreviews = new Map<string, ReleasePreviewRecord>();
  private readonly cliRuntimeSettingsDefaultUpdatedAt = nowIso();
  private codexCliModeDefaultsRuntimeInitialized = false;
  private providerValidations = new Map<string, ProviderValidationResult[]>();
  private models: Model[];
  private capabilities: Capability[];
  private mcpGatewayStatus: McpGatewayStatus;
  private mcpServers: McpServer[];
  private mcpTools: McpTool[];
  private mcpDiscoverySmokeChecks: McpDiscoverySmokeCheck[] = [];
  private memoryEmbeddingSmokeChecks: MemoryEmbeddingSmokeCheck[] = [];
  private skills: Skill[];
  private importCandidates: ImportCandidate[] = [];
  private memoryEntries: MemoryEntry[] = [];
  private memoryCacheLinks = new Map<string, MemoryCacheLink>();
  private memoryIssueStates = new Map<string, MemoryIssueState>();
  private memoryConsolidationRuns = new Map<string, MemoryConsolidationRun>();
  private memoryConsolidationFindings = new Map<string, MemoryConsolidationFinding>();
  private memoryConsolidationOperations = new Map<string, MemoryConsolidationOperation>();
  private memoryCommandIdempotency = new Map<string, MemoryCommandIdempotency>();
  private memoryChangeSets: MemoryChangeSet[] = [];
  private artifacts: Artifact[] = [];
  private reviewDecisions: ReviewDecision[] = [];
  private reviewChecks: ReviewCheck[] = [];
  private reviewDiffs: ReviewDiffSummary[] = [];
  private swarmTasks: SwarmTask[] = [];
  private swarmLocks: SwarmLock[] = [];
  private swarmMessages: SwarmMessage[] = [];
  private swarmReconciles: SwarmReconcile[] = [];

  constructor(options: StaticCatalogOptions = {}) {
    const catalog = createStaticCatalog(options);
    this.providers = catalog.providers;
    this.models = catalog.models;
    this.mcpGatewayStatus = catalog.mcpGatewayStatus;
    this.mcpServers = catalog.mcpServers;
    this.mcpTools = catalog.mcpTools;
    this.skills = catalog.skills;
    this.capabilities = catalog.capabilities;
    this.providerSettings = providerSettingsSchema.parse({
      defaultProviderId,
      titleGenerationModelId: null,
      titleGenerationReasoningEffort: defaultTitleGenerationReasoningEffort,
      updatedAt: nowIso()
    });
  }

  snapshot(): SpaceStoreSnapshot {
    const snapshotTimestamp = nowIso();
    for (const [leaseId, lease] of this.paneCliTerminalControlLeases) {
      if (lease.status !== "ACTIVE" || lease.expiresAt > snapshotTimestamp) continue;
      this.paneCliTerminalControlLeases.set(leaseId, paneCliTerminalControlLeaseSchema.parse({
        ...lease,
        status: "EXPIRED",
        releasedAt: lease.releasedAt ?? snapshotTimestamp
      }));
    }
    return {
      rooms: this.listRooms(),
      panes: [...this.panes.values()],
      clipboardItems: [...this.clipboardItems.values()].map((record) => ({
        ownerUserId: record.ownerUserId,
        item: { ...record.item }
      })),
      taskItems: [...this.taskItems.values()].map((record) => ({
        ownerUserId: record.ownerUserId,
        item: { ...record.item }
      })),
      userLinks: [...this.userLinks.values()].map((record) => ({
        ownerUserId: record.ownerUserId,
        item: { ...record.item }
      })),
      roomAgentRequests: [...this.roomAgentRequests.values()],
      roomAgentMissions: [...this.roomAgentMissions.values()],
      roomAgentActions: [...this.roomAgentActions.values()],
      roomAgentTaskRuns: [...this.roomAgentTaskRuns.values()],
      agentPaneBindings: [...this.agentPaneBindings.values()],
      agentPaneSessions: [...this.agentPaneSessions.values()],
      spaceAgentSessions: [...this.spaceAgentSessions.values()],
      spaceAgentMessages: [...this.spaceAgentMessages.values()],
      spaceAgentRuns: [...this.spaceAgentRuns.values()],
      paneCliSessions: [...this.paneCliSessions.values()],
      paneCliTerminalControlLeases: [...this.paneCliTerminalControlLeases.values()],
      cliTasks: [...this.cliTasks.values()],
      cliTaskRevisions: [...this.cliTaskRevisions.values()],
      paneCliTranscriptChunks: [...this.paneCliTranscriptChunks.values()],
      paneCliCodexThreadOwnerships: [...this.paneCliCodexThreadOwnerships.values()],
      workflows: [...this.workflows.values()],
      turns: this.listTurns(),
      events: [...this.events],
      auditEvents: [...this.auditEvents],
      codexAppServerHandshakeChecks: [...this.codexAppServerHandshakeChecks],
      codexAppServerTurnSmokeChecks: [...this.codexAppServerTurnSmokeChecks],
      providers: [...this.providers],
      providerSettings: this.providerSettings,
      codexCliModeDefaults: this.codexCliModeDefaults,
      cliRuntimeSettings: this.listCliRuntimeSettings(),
      agentToolAssignments: this.listAgentToolAssignments(),
      adminOperationRuns: this.listAdminOperationRuns(500),
      cliMaintenanceEvents: [...this.cliMaintenanceEvents.values()]
        .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)),
      cliMaintenanceAuthHandoffs: [...this.cliMaintenanceAuthHandoffs.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
      sourceControlConnections: this.listSourceControlConnections(),
      releasePreviews: [...this.releasePreviews.values()],
      models: [...this.models],
      capabilities: [...this.capabilities],
      mcpGatewayStatus: this.mcpGatewayStatus,
      mcpServers: [...this.mcpServers],
      mcpTools: [...this.mcpTools],
      mcpDiscoverySmokeChecks: [...this.mcpDiscoverySmokeChecks],
      memoryEmbeddingSmokeChecks: [...this.memoryEmbeddingSmokeChecks],
      skills: [...this.skills],
      memoryEntries: [...this.memoryEntries],
      memoryCacheLinks: [...this.memoryCacheLinks.values()],
      memoryIssueStates: [...this.memoryIssueStates.values()],
      memoryConsolidationRuns: [...this.memoryConsolidationRuns.values()],
      memoryConsolidationFindings: [...this.memoryConsolidationFindings.values()],
      memoryConsolidationOperations: [...this.memoryConsolidationOperations.values()],
      memoryCommandIdempotency: [...this.memoryCommandIdempotency.values()],
      memoryChangeSets: [...this.memoryChangeSets],
      artifacts: [...this.artifacts],
      reviewDecisions: [...this.reviewDecisions],
      reviewChecks: [...this.reviewChecks],
      reviewDiffs: [...this.reviewDiffs],
      swarmTasks: [...this.swarmTasks],
      swarmLocks: [...this.swarmLocks],
      swarmMessages: [...this.swarmMessages],
      swarmReconciles: [...this.swarmReconciles]
    };
  }

  upsertUser(user: AuthUser): AuthUser {
    const existing = [...this.users.values()].find((candidate) => candidate.email.toLowerCase() === user.email.toLowerCase());
    const persisted = existing ? { ...user, id: existing.id } : user;
    this.users.set(persisted.id, persisted);
    return persisted;
  }

  initializeOwnerSetup(input: InitializeOwnerSetupInput): OwnerSetupStatus {
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash)) {
      throw new Error("Owner setup token hash must be a SHA-256 hex digest.");
    }
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error("Owner setup expiry must be an ISO timestamp.");
    }
    if (!this.ownerSetup) {
      this.ownerSetup = {
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ownerUserId: null,
        onboardingVersion: currentSetupOnboardingVersion,
        onboardingCompletedAt: null,
        starterRoomId: null
      };
    }
    return this.getOwnerSetupStatus();
  }

  getOwnerSetupStatus(): OwnerSetupStatus {
    return {
      setupRequired: !this.ownerSetup?.ownerUserId,
      expiresAt: this.ownerSetup?.ownerUserId ? null : this.ownerSetup?.expiresAt ?? null
    };
  }

  claimOwnerSetup(input: ClaimOwnerSetupInput): OwnerSetupClaimResult {
    if (this.ownerSetup?.ownerUserId) {
      throw new SpaceConflictError("SpaceApp owner setup is already claimed.");
    }
    if (!this.ownerSetup || this.ownerSetup.tokenHash !== input.tokenHash) {
      throw new SpaceConflictError("The SpaceApp setup token is not valid.");
    }
    if (Date.parse(input.now) >= Date.parse(this.ownerSetup.expiresAt ?? "")) {
      throw new SpaceConflictError("The SpaceApp setup token has expired.");
    }
    const owner = authUserSchema.parse({
      id: "user:owner",
      email: input.email,
      role: "ADMIN"
    });
    const starterRoom = this.createRoom({
      name: "Getting Started",
      description: "SpaceApp setup and connection workspace.",
      initialPaneCount: 0
    });
    this.users.set(owner.id, owner);
    this.userPasswordHashes.set(owner.id, input.passwordHash);
    this.ownerSetup = {
      tokenHash: null,
      expiresAt: null,
      ownerUserId: owner.id,
      onboardingVersion: currentSetupOnboardingVersion,
      onboardingCompletedAt: null,
      starterRoomId: starterRoom.id
    };
    return { user: owner, onboarding: this.getOwnerOnboarding() };
  }

  getOwnerOnboarding(): SetupOnboarding {
    if (!this.ownerSetup?.ownerUserId) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    return {
      onboardingVersion: this.ownerSetup.onboardingVersion,
      isComplete: this.ownerSetup.onboardingCompletedAt !== null,
      completedAt: this.ownerSetup.onboardingCompletedAt,
      starterRoomId: this.ownerSetup.starterRoomId
    };
  }

  ensureOwnerStarterRoom(traceId = makeSpaceId("trace")): { room: Room; onboarding: SetupOnboarding } {
    if (!this.ownerSetup?.ownerUserId) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    const existing = this.ownerSetup.starterRoomId
      ? this.rooms.get(this.ownerSetup.starterRoomId)
      : null;
    const room = existing ?? this.createRoom(
      {
        name: "Getting Started",
        description: "SpaceApp setup and connection workspace.",
        initialPaneCount: 0
      },
      traceId
    );
    this.ownerSetup.starterRoomId = room.id;
    return { room, onboarding: this.getOwnerOnboarding() };
  }

  completeOwnerOnboarding(completedAt: string): SetupOnboarding {
    if (!this.ownerSetup?.ownerUserId) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    this.ownerSetup.onboardingVersion = currentSetupOnboardingVersion;
    this.ownerSetup.onboardingCompletedAt = isoDateTimeSchema.parse(completedAt);
    return this.getOwnerOnboarding();
  }

  listSetupConnectionVerifications(): SetupConnectionVerification[] {
    return [...this.setupConnectionVerifications.values()]
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  }

  getSetupConnectionVerification(connectionId: string): SetupConnectionVerification | null {
    return this.setupConnectionVerifications.get(connectionId) ?? null;
  }

  upsertSetupConnectionVerification(
    input: UpsertSetupConnectionVerificationInput
  ): SetupConnectionVerification {
    if (!/^[a-z0-9][a-z0-9:_-]{0,159}$/.test(input.connectionId)) {
      throw new Error("Setup connection id is invalid.");
    }
    if (!["CONNECTED", "NEEDS_SETUP", "UNAVAILABLE"].includes(input.state)) {
      throw new Error("Setup connection verification state is invalid.");
    }
    if (input.reasonCode !== null && !/^[A-Z0-9_]{1,80}$/.test(input.reasonCode)) {
      throw new Error("Setup connection reason code is invalid.");
    }
    if (input.fingerprintHash !== null && !/^[a-f0-9]{64}$/.test(input.fingerprintHash)) {
      throw new Error("Setup connection fingerprint must be a SHA-256 hex digest.");
    }
    const persisted = {
      ...input,
      verifiedAt: input.verifiedAt === null ? null : isoDateTimeSchema.parse(input.verifiedAt),
      updatedAt: isoDateTimeSchema.parse(input.updatedAt)
    };
    this.setupConnectionVerifications.set(persisted.connectionId, persisted);
    return persisted;
  }

  createSetupConnectionCheckRun(
    input: CreateSetupConnectionCheckRunInput
  ): SetupConnectionCheckRun {
    const parsed = createSetupConnectionCheckRunInputSchema.parse(input);
    const timestamp = nowIso();
    const run = setupConnectionCheckRunSchema.parse({
      id: makeSpaceId("setup_check_run"),
      scope: parsed.scope,
      connectionIds: parsed.connectionIds,
      status: "RUNNING",
      totalCount: parsed.connectionIds.length,
      completedCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null
    });
    this.setupConnectionCheckRuns.set(run.id, run);
    return run;
  }

  getSetupConnectionCheckRun(runId: string): SetupConnectionCheckRun | null {
    return this.setupConnectionCheckRuns.get(idSchema.parse(runId)) ?? null;
  }

  listSetupConnectionCheckRuns(limit = 50): SetupConnectionCheckRun[] {
    const boundedLimit = z.number().int().min(1).max(500).parse(Math.trunc(limit));
    return [...this.setupConnectionCheckRuns.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, boundedLimit);
  }

  updateSetupConnectionCheckRun(
    runId: string,
    input: UpdateSetupConnectionCheckRunInput
  ): SetupConnectionCheckRun {
    const parsedRunId = idSchema.parse(runId);
    const existing = this.setupConnectionCheckRuns.get(parsedRunId);
    if (!existing) {
      throw new SpaceNotFoundError(`Setup connection check run ${parsedRunId} was not found.`);
    }
    const run = updateSetupConnectionCheckRunRecord(existing, input);
    this.setupConnectionCheckRuns.set(parsedRunId, run);
    return run;
  }

  appendSetupConnectionCheckEvent(
    input: CreateSetupConnectionCheckEventInput
  ): SetupConnectionCheckEvent {
    const parsed = createSetupConnectionCheckEventInputSchema.parse(input);
    const run = this.setupConnectionCheckRuns.get(parsed.runId);
    if (!run || !run.connectionIds.includes(parsed.connectionId)) {
      throw new SpaceNotFoundError(`Setup connection check run ${parsed.runId} was not found.`);
    }
    const sequence = [...this.setupConnectionCheckEvents.values()]
      .filter((event) => event.runId === parsed.runId)
      .reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
    const event = setupConnectionCheckEventSchema.parse({
      ...parsed,
      id: makeSpaceId("setup_check_event"),
      sequence,
      createdAt: nowIso()
    });
    this.setupConnectionCheckEvents.set(event.id, event);
    return event;
  }

  listSetupConnectionCheckEvents(
    runId: string,
    afterSequence = 0,
    limit = 500
  ): SetupConnectionCheckEvent[] {
    const parsedRunId = idSchema.parse(runId);
    const parsedAfterSequence = z.number().int().min(0).parse(afterSequence);
    const boundedLimit = z.number().int().min(1).max(1_000).parse(Math.trunc(limit));
    return [...this.setupConnectionCheckEvents.values()]
      .filter((event) => event.runId === parsedRunId && event.sequence > parsedAfterSequence)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .slice(0, boundedLimit);
  }

  getOwnerCredentials(): OwnerCredentials | null {
    const ownerUserId = this.ownerSetup?.ownerUserId;
    if (!ownerUserId) return null;
    const user = this.users.get(ownerUserId);
    const passwordHash = this.userPasswordHashes.get(ownerUserId);
    return user && passwordHash ? { user, passwordHash } : null;
  }

  updateOwnerPassword(passwordHash: string): AuthUser {
    const credentials = this.getOwnerCredentials();
    if (!credentials) {
      throw new SpaceConflictError("SpaceApp owner setup has not been claimed.");
    }
    this.userPasswordHashes.set(credentials.user.id, passwordHash);
    return credentials.user;
  }

  upsertPublicWaitlistSignup(input: PublicWaitlistSignupInput): PublicWaitlistSignupOutcome {
    const email = input.email.trim();
    const normalizedEmail = email.toLowerCase();
    if (this.publicWaitlistSignups.has(normalizedEmail)) return "DUPLICATE";
    this.publicWaitlistSignups.set(normalizedEmail, { email, source: input.source });
    return "CREATED";
  }

  upsertClipboardItem(input: UpsertClipboardItemInput): ClipboardItem {
    const parsed = upsertClipboardItemInputSchema.parse(input);
    const contentHash = createHash("sha256").update(parsed.text).digest("hex");
    const existing = [...this.clipboardItems.values()].find(
      (record) => record.ownerUserId === parsed.ownerUserId && record.contentHash === contentHash
    );
    const timestamp = nowIso();
    const item = clipboardItemSchema.parse({
      id: existing?.item.id ?? makeSpaceId("clipboard"),
      text: parsed.text,
      source: parsed.source,
      title: parsed.title ?? null,
      roomId: parsed.roomId ?? null,
      paneId: parsed.paneId ?? null,
      paneTitle: parsed.paneTitle ?? null,
      occurrenceCount: (existing?.item.occurrenceCount ?? 0) + 1,
      characterCount: Array.from(parsed.text).length,
      createdAt: existing?.item.createdAt ?? timestamp,
      lastUsedAt: timestamp
    });
    this.clipboardSequence += 1;
    this.clipboardItems.set(item.id, {
      ownerUserId: parsed.ownerUserId,
      contentHash,
      sequence: this.clipboardSequence,
      item
    });

    const stale = [...this.clipboardItems.values()]
      .filter((record) => record.ownerUserId === parsed.ownerUserId)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(100);
    for (const record of stale) this.clipboardItems.delete(record.item.id);
    return item;
  }

  getClipboardItem(ownerUserId: string, clipboardItemId: string): ClipboardItem | null {
    const record = this.clipboardItems.get(clipboardItemId);
    return record?.ownerUserId === ownerUserId ? record.item : null;
  }

  listClipboardItems(
    ownerUserId: string,
    query: ListClipboardItemsQuery = { page: 1, pageSize: 25 }
  ): ClipboardItemListResult {
    const parsed = listClipboardItemsQuerySchema.parse(query);
    const search = parsed.q?.toLocaleLowerCase() ?? null;
    const matching = [...this.clipboardItems.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .filter((record) => !parsed.source || record.item.source === parsed.source)
      .filter((record) => !search || record.item.text.toLocaleLowerCase().includes(search))
      .sort((left, right) => right.sequence - left.sequence);
    const offset = (parsed.page - 1) * parsed.pageSize;
    return {
      items: matching.slice(offset, offset + parsed.pageSize).map((record) => record.item),
      total: matching.length
    };
  }

  deleteClipboardItem(ownerUserId: string, clipboardItemId: string): ClipboardItem {
    const record = this.clipboardItems.get(clipboardItemId);
    if (!record || record.ownerUserId !== ownerUserId) {
      throw new SpaceNotFoundError(`Clipboard item ${clipboardItemId} was not found.`);
    }
    this.clipboardItems.delete(clipboardItemId);
    return record.item;
  }

  clearClipboardItems(ownerUserId: string): number {
    let deleted = 0;
    for (const [clipboardItemId, record] of this.clipboardItems.entries()) {
      if (record.ownerUserId !== ownerUserId) continue;
      this.clipboardItems.delete(clipboardItemId);
      deleted += 1;
    }
    return deleted;
  }

  upsertTaskItem(input: UpsertTaskItemInput): TaskItem {
    const parsed = upsertTaskItemInputSchema.parse(input);
    const contentHash = createHash("sha256").update(parsed.objective).digest("hex");
    const existing = [...this.taskItems.values()].find(
      (record) => record.ownerUserId === parsed.ownerUserId && record.contentHash === contentHash
    );
    const timestamp = nowIso();
    const item = taskItemSchema.parse({
      id: existing?.item.id ?? makeSpaceId("task"),
      title: parsed.title,
      objective: parsed.objective,
      status: parsed.status,
      source: parsed.source,
      roomId: parsed.roomId ?? null,
      paneId: parsed.paneId ?? null,
      paneTitle: parsed.paneTitle ?? null,
      occurrenceCount: (existing?.item.occurrenceCount ?? 0) + 1,
      characterCount: Array.from(parsed.objective).length,
      createdAt: existing?.item.createdAt ?? timestamp,
      lastUsedAt: timestamp
    });
    this.taskSequence += 1;
    this.taskItems.set(item.id, {
      ownerUserId: parsed.ownerUserId,
      contentHash,
      sequence: this.taskSequence,
      item
    });

    const stale = [...this.taskItems.values()]
      .filter((record) => record.ownerUserId === parsed.ownerUserId)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(100);
    for (const record of stale) this.taskItems.delete(record.item.id);
    return item;
  }

  getTaskItem(ownerUserId: string, taskItemId: string): TaskItem | null {
    const record = this.taskItems.get(taskItemId);
    return record?.ownerUserId === ownerUserId ? record.item : null;
  }

  listTaskItems(
    ownerUserId: string,
    query: ListTaskItemsQuery = { page: 1, pageSize: 25 }
  ): TaskItemListResult {
    const parsed = listTaskItemsQuerySchema.parse(query);
    const search = parsed.q?.toLocaleLowerCase() ?? null;
    const matching = [...this.taskItems.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .filter((record) => !parsed.status || record.item.status === parsed.status)
      .filter(
        (record) =>
          !search ||
          record.item.title.toLocaleLowerCase().includes(search) ||
          record.item.objective.toLocaleLowerCase().includes(search)
      )
      .sort((left, right) => right.sequence - left.sequence);
    const offset = (parsed.page - 1) * parsed.pageSize;
    return {
      items: matching.slice(offset, offset + parsed.pageSize).map((record) => record.item),
      total: matching.length
    };
  }

  updateTaskItem(ownerUserId: string, taskItemId: string, input: UpdateTaskItemInput): TaskItem {
    const parsed = updateTaskItemInputSchema.parse(input);
    const record = this.taskItems.get(taskItemId);
    if (!record || record.ownerUserId !== ownerUserId) {
      throw new SpaceNotFoundError(`Task item ${taskItemId} was not found.`);
    }
    const updated = taskItemSchema.parse({
      ...record.item,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.objective !== undefined ? { objective: parsed.objective } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      characterCount: parsed.objective !== undefined ? Array.from(parsed.objective).length : record.item.characterCount,
      lastUsedAt: nowIso()
    });
    record.item = updated;
    return updated;
  }

  deleteTaskItem(ownerUserId: string, taskItemId: string): TaskItem {
    const record = this.taskItems.get(taskItemId);
    if (!record || record.ownerUserId !== ownerUserId) {
      throw new SpaceNotFoundError(`Task item ${taskItemId} was not found.`);
    }
    this.taskItems.delete(taskItemId);
    return record.item;
  }

  clearTaskItems(ownerUserId: string): number {
    let deleted = 0;
    for (const [taskItemId, record] of this.taskItems.entries()) {
      if (record.ownerUserId !== ownerUserId) continue;
      this.taskItems.delete(taskItemId);
      deleted += 1;
    }
    return deleted;
  }

  private initializeUserLinks(ownerUserId: string) {
    if (this.initializedUserLinkLibraries.has(ownerUserId)) return;
    this.initializedUserLinkLibraries.add(ownerUserId);
    const timestamp = nowIso();
    defaultUserLinks.forEach((seed, sortOrder) => {
      const item = userLinkSchema.parse({ id: makeSpaceId("link"), ...seed, sortOrder, createdAt: timestamp, updatedAt: timestamp });
      this.userLinks.set(item.id, { ownerUserId, item });
    });
  }

  listUserLinks(ownerUserId: string, query: ListUserLinksQuery = { isQuick: undefined, page: 1, pageSize: 25 }): UserLinkListResult {
    this.initializeUserLinks(ownerUserId);
    const parsed = listUserLinksQuerySchema.parse(query);
    const search = parsed.q?.toLocaleLowerCase();
    const matching = [...this.userLinks.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .filter((record) => parsed.isQuick === undefined || record.item.isQuick === parsed.isQuick)
      .filter((record) => !search || `${record.item.title}\n${record.item.description}`.toLocaleLowerCase().includes(search))
      .sort((left, right) => left.item.sortOrder - right.item.sortOrder || left.item.createdAt.localeCompare(right.item.createdAt));
    const offset = (parsed.page - 1) * parsed.pageSize;
    return { items: matching.slice(offset, offset + parsed.pageSize).map((record) => record.item), total: matching.length };
  }

  createUserLink(input: CreateUserLinkInput): UserLink {
    const { ownerUserId, ...request } = input;
    const parsed = createUserLinkRequestSchema.parse(request);
    const duplicate = [...this.userLinks.values()].some((record) => record.ownerUserId === ownerUserId && record.item.url === parsed.url);
    if (duplicate) throw new SpaceConflictError("A link with this URL already exists.");
    const sortOrder = Math.max(-1, ...[...this.userLinks.values()].filter((record) => record.ownerUserId === ownerUserId).map((record) => record.item.sortOrder)) + 1;
    const timestamp = nowIso();
    const item = userLinkSchema.parse({ id: makeSpaceId("link"), ...parsed, sortOrder, createdAt: timestamp, updatedAt: timestamp });
    this.userLinks.set(item.id, { ownerUserId, item });
    return item;
  }

  updateUserLink(ownerUserId: string, linkId: string, input: UpdateUserLinkRequest): UserLink {
    const record = this.userLinks.get(linkId);
    if (!record || record.ownerUserId !== ownerUserId) throw new SpaceNotFoundError(`Link ${linkId} was not found.`);
    const parsed = updateUserLinkRequestSchema.parse(input);
    const item = userLinkSchema.parse({ ...record.item, ...parsed, updatedAt: nowIso() });
    const duplicate = [...this.userLinks.values()].some((candidate) => candidate.ownerUserId === ownerUserId && candidate.item.id !== linkId && candidate.item.url === item.url);
    if (duplicate) throw new SpaceConflictError("A link with this URL already exists.");
    this.userLinks.set(linkId, { ownerUserId, item });
    return item;
  }

  deleteUserLink(ownerUserId: string, linkId: string): UserLink {
    const record = this.userLinks.get(linkId);
    if (!record || record.ownerUserId !== ownerUserId) throw new SpaceNotFoundError(`Link ${linkId} was not found.`);
    this.userLinks.delete(linkId);
    return record.item;
  }

  listRooms(): Room[] {
    return [...this.rooms.values()].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  }

  listRunningCliSessionCountsByRoom(runtimeIds?: string[]): RoomCliActivity[] {
    const allowedRuntimeIds = runtimeIds ? new Set(runtimeIds) : null;
    const runningCounts = new Map<string, number>();
    for (const session of this.paneCliSessions.values()) {
      if (session.status !== "RUNNING") continue;
      if (allowedRuntimeIds && !allowedRuntimeIds.has(session.runtimeId)) continue;
      runningCounts.set(session.roomId, (runningCounts.get(session.roomId) ?? 0) + 1);
    }
    return this.listRooms().map((room) => ({
      roomId: room.id,
      runningCliCount: runningCounts.get(room.id) ?? 0
    }));
  }

  listCliRuntimeSettings(): CliRuntimeSetting[] {
    return cliToggleRuntimeIds.map((runtimeId) => this.getCliRuntimeSetting(runtimeId));
  }

  getCliRuntimeSetting(runtimeId: CliToggleRuntimeId): CliRuntimeSetting {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    return this.cliRuntimeSettings.get(parsedRuntimeId) ?? cliRuntimeSettingSchema.parse({
      runtimeId: parsedRuntimeId,
      enabled: true,
      vpnEnabled: false,
      updatedAt: this.cliRuntimeSettingsDefaultUpdatedAt,
      updatedBy: null
    });
  }

  updateCliRuntimeSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeSettingInput,
    updatedBy: string
  ): CliRuntimeSetting {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const parsed = updateCliRuntimeSettingInputSchema.parse(input);
    const setting = cliRuntimeSettingSchema.parse({
      runtimeId: parsedRuntimeId,
      enabled: parsed.enabled,
      vpnEnabled: this.getCliRuntimeSetting(parsedRuntimeId).vpnEnabled,
      updatedAt: nowIso(),
      updatedBy: idSchema.parse(updatedBy)
    });
    this.cliRuntimeSettings.set(parsedRuntimeId, setting);
    return setting;
  }

  updateCliRuntimeVpnSetting(
    runtimeId: CliToggleRuntimeId,
    input: UpdateCliRuntimeVpnInput,
    updatedBy: string
  ): CliRuntimeSetting {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const parsed = updateCliRuntimeVpnInputSchema.parse(input);
    const current = this.getCliRuntimeSetting(parsedRuntimeId);
    const setting = cliRuntimeSettingSchema.parse({
      ...current,
      vpnEnabled: parsed.enabled,
      updatedAt: nowIso(),
      updatedBy: idSchema.parse(updatedBy)
    });
    this.cliRuntimeSettings.set(parsedRuntimeId, setting);
    return setting;
  }

  listAgentToolAssignments(): AgentToolAssignment[] {
    return [...this.agentToolAssignments.values()].sort(
      (left, right) => left.toolId.localeCompare(right.toolId) || left.kind.localeCompare(right.kind)
    );
  }

  getAgentToolAssignment(toolId: string): AgentToolAssignment | null {
    return this.agentToolAssignments.get(idSchema.parse(toolId)) ?? null;
  }

  updateAgentToolAssignment(
    toolId: string,
    input: UpdateAgentToolAssignmentInput,
    updatedBy: string
  ): AgentToolAssignment {
    const parsedToolId = idSchema.parse(toolId);
    if (!parsedToolId) {
      throw new SpaceConflictError("Agent tool assignment requires a non-empty toolId.");
    }
    const parsed = updateAgentToolAssignmentInputSchema.parse(input);
    const existing = this.agentToolAssignments.get(parsedToolId);
    const assignment = agentToolAssignmentSchema.parse({
      toolId: parsedToolId,
      kind: existing?.kind ?? parsed.kind,
      scope: parsed.scope,
      runtimeIds: parsed.runtimeIds,
      updatedAt: nowIso(),
      updatedBy: idSchema.parse(updatedBy)
    });
    this.agentToolAssignments.set(parsedToolId, assignment);
    return assignment;
  }

  deleteAgentToolAssignment(toolId: string): AgentToolAssignment | null {
    const parsedToolId = idSchema.parse(toolId);
    const existing = this.agentToolAssignments.get(parsedToolId);
    if (!existing) return null;
    this.agentToolAssignments.delete(parsedToolId);
    return existing;
  }

  createAdminOperationRun(input: CreateAdminOperationRunInput): AdminOperationRun {
    const parsed = createAdminOperationRunInputSchema.parse(input);
    const timestamp = nowIso();
    const run = adminOperationRunSchema.parse({
      id: makeSpaceId("admin_run"),
      operationType: parsed.operationType,
      status: "QUEUED",
      actorUserId: parsed.actorUserId,
      summary: parsed.summary,
      result: parsed.result ?? {},
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp
    });
    this.adminOperationRuns.set(run.id, run);
    return run;
  }

  getAdminOperationRun(runId: string): AdminOperationRun | null {
    return this.adminOperationRuns.get(idSchema.parse(runId)) ?? null;
  }

  listAdminOperationRuns(limit = 50): AdminOperationRun[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return [...this.adminOperationRuns.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, boundedLimit);
  }

  updateAdminOperationRun(runId: string, input: UpdateAdminOperationRunInput): AdminOperationRun {
    const parsedRunId = idSchema.parse(runId);
    const existing = this.adminOperationRuns.get(parsedRunId);
    if (!existing) {
      throw new SpaceNotFoundError(`Admin operation ${parsedRunId} was not found.`);
    }
    const parsed = updateAdminOperationRunInputSchema.parse(input);
    const run = adminOperationRunSchema.parse({
      ...existing,
      ...parsed,
      updatedAt: nowIso()
    });
    this.adminOperationRuns.set(parsedRunId, run);
    return run;
  }

  appendCliMaintenanceEvent(input: CreateCliMaintenanceEventInput): CliMaintenanceEvent {
    const parsed = createCliMaintenanceEventInputSchema.parse({
      ...input,
      diagnostics: redactCliMaintenanceDiagnostics(input.diagnostics)
    });
    const run = this.adminOperationRuns.get(parsed.runId);
    if (!run || !run.operationType.startsWith("CLI_MAINTENANCE_")) {
      throw new SpaceNotFoundError(`CLI maintenance run ${parsed.runId} was not found.`);
    }
    const sequence = [...this.cliMaintenanceEvents.values()]
      .filter((event) => event.runId === parsed.runId)
      .reduce((highest, event) => Math.max(highest, event.sequence), 0) + 1;
    const event = cliMaintenanceEventSchema.parse({
      ...parsed,
      id: makeSpaceId("cli_maintenance_event"),
      sequence,
      createdAt: nowIso()
    });
    this.cliMaintenanceEvents.set(event.id, event);
    return event;
  }

  listCliMaintenanceEvents(runId: string, afterSequence = 0, limit = 500): CliMaintenanceEvent[] {
    const parsedRunId = idSchema.parse(runId);
    const parsedAfterSequence = z.number().int().min(0).parse(afterSequence);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    return [...this.cliMaintenanceEvents.values()]
      .filter((event) => event.runId === parsedRunId && event.sequence > parsedAfterSequence)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .slice(0, boundedLimit);
  }

  createCliMaintenanceAuthHandoff(input: CreateCliMaintenanceAuthHandoffInput): CliMaintenanceAuthHandoff {
    const parsed = createCliMaintenanceAuthHandoffInputSchema.parse(input);
    const run = this.adminOperationRuns.get(parsed.runId);
    if (!run || !run.operationType.startsWith("CLI_MAINTENANCE_")) {
      throw new SpaceNotFoundError(`CLI maintenance run ${parsed.runId} was not found.`);
    }
    const duplicate = [...this.cliMaintenanceAuthHandoffs.values()].find(
      (handoff) => handoff.runId === parsed.runId && handoff.runtimeId === parsed.runtimeId
    );
    if (duplicate) {
      throw new SpaceConflictError(`CLI auth handoff for ${parsed.runtimeId} already exists in ${parsed.runId}.`);
    }
    const timestamp = nowIso();
    const handoff = cliMaintenanceAuthHandoffSchema.parse({
      ...parsed,
      id: makeSpaceId("cli_auth_handoff"),
      status: "PENDING",
      attemptCount: 0,
      safeErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });
    this.cliMaintenanceAuthHandoffs.set(handoff.id, handoff);
    return handoff;
  }

  updateCliMaintenanceAuthHandoff(
    handoffId: string,
    input: UpdateCliMaintenanceAuthHandoffInput
  ): CliMaintenanceAuthHandoff {
    const parsedHandoffId = idSchema.parse(handoffId);
    const existing = this.cliMaintenanceAuthHandoffs.get(parsedHandoffId);
    if (!existing) {
      throw new SpaceNotFoundError(`CLI auth handoff ${parsedHandoffId} was not found.`);
    }
    const parsed = updateCliMaintenanceAuthHandoffInputSchema.parse(input);
    const timestamp = nowIso();
    const nextStatus = parsed.status ?? existing.status;
    const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(nextStatus);
    const handoff = cliMaintenanceAuthHandoffSchema.parse({
      ...existing,
      ...parsed,
      status: nextStatus,
      updatedAt: timestamp,
      completedAt: terminal ? (existing.completedAt ?? timestamp) : null
    });
    this.cliMaintenanceAuthHandoffs.set(handoff.id, handoff);
    return handoff;
  }

  listCliMaintenanceAuthHandoffs(runId: string): CliMaintenanceAuthHandoff[] {
    const parsedRunId = idSchema.parse(runId);
    return [...this.cliMaintenanceAuthHandoffs.values()]
      .filter((handoff) => handoff.runId === parsedRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  listSourceControlConnections(): SourceControlConnectionRecord[] {
    return (["gitea", "github"] as const).map((provider) => this.getSourceControlConnection(provider));
  }

  getSourceControlConnection(provider: SourceControlProvider): SourceControlConnectionRecord {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const existing = this.sourceControlConnections.get(parsedProvider);
    if (existing) return existing;
    const repositoryName = "space";
    return {
      ...sourceControlConnectionSchema.parse({
        provider: parsedProvider,
        repositoryOwner: "oll4com",
        repositoryName,
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

  upsertSourceControlConnection(input: UpsertSourceControlConnectionInput): SourceControlConnectionRecord {
    const provider = sourceControlProviderSchema.parse(input.provider);
    const secretRef = input.secretRef === null
      ? null
      : z.string().regex(/^source_control_(?:gitea|github)_[A-Za-z0-9_-]{8,96}$/).parse(input.secretRef);
    const connection = {
      ...sourceControlConnectionSchema.parse({
        provider,
        repositoryOwner: "oll4com",
        repositoryName: "space",
        accountLogin: input.accountLogin,
        status: input.connectionStatus,
        secretConfigured: secretRef !== null,
        lastVerifiedAt: input.lastVerifiedAt,
        lastVerificationCode: input.lastVerificationCode,
        updatedAt: nowIso()
      }),
      secretRef
    };
    this.sourceControlConnections.set(provider, connection);
    return connection;
  }

  createReleasePreview(input: CreateReleasePreviewStoreInput, actorUserId: string | null): ReleasePreviewRecord {
    const preview = releasePreviewSchema.parse({
      ...input,
      id: makeSpaceId("release_preview"),
      createdAt: nowIso()
    });
    const record = {
      ...preview,
      actorUserId: actorUserId === null ? null : idSchema.parse(actorUserId)
    };
    this.releasePreviews.set(record.id, record);
    return record;
  }

  getReleasePreview(previewId: string): ReleasePreviewRecord | null {
    return this.releasePreviews.get(idSchema.parse(previewId)) ?? null;
  }

  getRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new SpaceNotFoundError(`Room ${roomId} was not found.`);
    }
    return room;
  }

  createRoom(input: CreateRoomStoreInput, traceId = makeSpaceId("trace")): Room {
    const timestamp = nowIso();
    const room: Room = {
      id: makeSpaceId("room"),
      name: input.name,
      description: input.description ?? null,
      kind: input.kind ?? "WORKSPACE",
      order: this.rooms.size,
      paneLayoutColumns: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      paneCap: ACTIVE_PANE_CAP,
      traceId
    };

    this.rooms.set(room.id, room);
    this.appendEvent({
      roomId: room.id,
      paneId: null,
      turnId: null,
      traceId,
      type: "ROOM_CREATED",
      message: `Room ${room.name} created.`,
      payload: { initialPaneCount: input.initialPaneCount }
    });

    for (let index = 0; index < input.initialPaneCount; index += 1) {
      this.createPane(
        {
          roomId: room.id,
          title: defaultPaneTitles[index] ?? `Agent ${index + 1}`,
          mode: index === 4 ? "BROWSER" : "CHAT"
        },
        traceId
      );
    }

    return room;
  }

  updateRoom(roomId: string, input: UpdateRoomInput, traceId = makeSpaceId("trace")): Room {
    const room = this.getRoom(roomId);
    const updated: Room = {
      ...room,
      name: input.name,
      description: input.description ?? room.description,
      updatedAt: nowIso(),
      traceId
    };
    this.rooms.set(roomId, updated);
    return updated;
  }

  updateRoomPaneLayout(
    roomId: string,
    input: UpdatePaneLayoutInput,
    traceId = makeSpaceId("trace")
  ): RoomPaneLayoutResult {
    const room = this.getRoom(roomId);
    const timestamp = nowIso();
    const updatedRoom: Room = {
      ...room,
      paneLayoutColumns: input.paneLayoutColumns,
      updatedAt: timestamp,
      traceId
    };
    const updatedPanes = this.listPanes(roomId).map((pane) => ({
      ...pane,
      columnSpan: 1 as const,
      isMaximized: false,
      updatedAt: timestamp
    }));

    this.rooms.set(roomId, updatedRoom);
    for (const pane of updatedPanes) this.panes.set(pane.id, pane);

    return { room: updatedRoom, panes: updatedPanes };
  }

  reorderRooms(roomIds: string[], traceId = makeSpaceId("trace")): Room[] {
    const currentRooms = this.listRooms();
    const currentIds = currentRooms.map((room) => room.id);
    if (roomIds.length !== currentIds.length) {
      throw new SpaceConflictError("Room reorder payload must include every room exactly once.");
    }
    const nextIds = new Set(roomIds);
    if (nextIds.size !== roomIds.length || currentIds.some((roomId) => !nextIds.has(roomId))) {
      throw new SpaceConflictError("Room reorder payload must include every room exactly once.");
    }

    const timestamp = nowIso();
    roomIds.forEach((roomId, index) => {
      const room = this.getRoom(roomId);
      this.rooms.set(roomId, {
        ...room,
        order: index,
        updatedAt: room.updatedAt,
        traceId
      });
    });

    return this.listRooms();
  }

  reorderPanes(roomId: string, paneIds: string[], traceId = makeSpaceId("trace")): Pane[] {
    this.getRoom(roomId);
    const currentActive = this.listPanes(roomId, false);
    const currentIds = currentActive.map((pane) => pane.id);
    if (paneIds.length !== currentIds.length) {
      throw new SpaceConflictError("Pane reorder payload must include every active pane of the room exactly once.");
    }
    const nextIds = new Set(paneIds);
    if (nextIds.size !== paneIds.length || currentIds.some((paneId) => !nextIds.has(paneId))) {
      throw new SpaceConflictError("Pane reorder payload must include every active pane of the room exactly once.");
    }
    paneIds.forEach((paneId, index) => {
      const pane = this.getPane(paneId);
      this.panes.set(paneId, { ...pane, order: index });
    });
    return this.listPanes(roomId, false);
  }

  deleteRoom(roomId: string): Room {
    const room = this.getRoom(roomId);
    const paneIds = new Set(
      [...this.panes.values()].filter((pane) => pane.roomId === roomId).map((pane) => pane.id)
    );
    const turnIds = new Set(
      [...this.turns.values()].filter((turn) => turn.roomId === roomId).map((turn) => turn.id)
    );

    this.rooms.delete(roomId);
    this.listRooms().forEach((remainingRoom, index) => {
      this.rooms.set(remainingRoom.id, { ...remainingRoom, order: index });
    });
    for (const paneId of paneIds) {
      this.panes.delete(paneId);
      this.agentPaneBindings.delete(paneId);
    }
    this.agentPaneSessions = new Map(
      [...this.agentPaneSessions.entries()].filter(([, session]) => session.roomId !== roomId && !paneIds.has(session.paneId))
    );
    const removedSpaceSessionIds = new Set(
      [...this.spaceAgentSessions.values()]
        .filter((session) => session.roomId === roomId || paneIds.has(session.paneId))
        .map((session) => session.sessionId)
    );
    this.spaceAgentSessions = new Map(
      [...this.spaceAgentSessions.entries()].filter(([, session]) => !removedSpaceSessionIds.has(session.sessionId))
    );
    this.spaceAgentMessages = new Map(
      [...this.spaceAgentMessages.entries()].filter(([, message]) => !removedSpaceSessionIds.has(message.sessionId))
    );
    this.spaceAgentRuns = new Map(
      [...this.spaceAgentRuns.entries()].filter(([, run]) => !removedSpaceSessionIds.has(run.sessionId))
    );
    const removedCliSessionIds = new Set(
      [...this.paneCliSessions.values()]
        .filter((session) => session.roomId === roomId || paneIds.has(session.paneId))
        .map((session) => session.sessionId)
    );
    this.paneCliSessions = new Map(
      [...this.paneCliSessions.entries()].filter(([, session]) => !removedCliSessionIds.has(session.sessionId))
    );
    this.paneCliTerminalControlLeases = new Map(
      [...this.paneCliTerminalControlLeases.entries()].filter(
        ([, lease]) => !removedCliSessionIds.has(lease.sessionId)
      )
    );
    this.paneCliTranscriptChunks = new Map(
      [...this.paneCliTranscriptChunks.entries()].filter(([, chunk]) => !removedCliSessionIds.has(chunk.sessionId))
    );
    this.paneCliCodexThreadOwnerships = new Map(
      [...this.paneCliCodexThreadOwnerships.entries()].filter(
        ([, ownership]) => !removedCliSessionIds.has(ownership.cliSessionId)
      )
    );
    const removedBrowserSessionIds = new Set(
      [...this.paneBrowserSessions.values()]
        .filter((session) => session.roomId === roomId || paneIds.has(session.paneId))
        .map((session) => session.sessionId)
    );
    this.paneBrowserSessions = new Map(
      [...this.paneBrowserSessions.entries()].filter(([, session]) => !removedBrowserSessionIds.has(session.sessionId))
    );
    this.browserControlLeases = new Map(
      [...this.browserControlLeases.entries()].filter(([, lease]) => lease.roomId !== roomId && !paneIds.has(lease.paneId))
    );
    this.browserCaptureJobs = new Map(
      [...this.browserCaptureJobs.entries()].filter(([, job]) => job.roomId !== roomId && !paneIds.has(job.paneId))
    );
    this.browserCaptureSegments = new Map(
      [...this.browserCaptureSegments.entries()].filter(([, segment]) => !removedBrowserSessionIds.has(segment.sessionId))
    );
    this.browserHandoffRequests = new Map(
      [...this.browserHandoffRequests.entries()].filter(
        ([, handoff]) => handoff.roomId !== roomId && !paneIds.has(handoff.paneId)
      )
    );
    for (const turnId of turnIds) {
      this.turns.delete(turnId);
    }
    this.workflows = new Map(
      [...this.workflows.entries()].map(([workflowId, workflow]) => [
        workflowId,
        workflow.roomId === roomId || (workflow.paneId && paneIds.has(workflow.paneId))
          ? { ...workflow, roomId: workflow.roomId === roomId ? null : workflow.roomId, paneId: workflow.paneId && paneIds.has(workflow.paneId) ? null : workflow.paneId }
          : workflow
      ])
    );
    this.events = this.events.filter((event) => event.roomId !== roomId);
    this.memoryEntries = this.memoryEntries.filter((entry) => entry.roomId !== roomId);
    this.artifacts = this.artifacts.map((artifact) =>
      artifact.roomId === roomId || (artifact.paneId && paneIds.has(artifact.paneId)) || (artifact.turnId && turnIds.has(artifact.turnId))
        ? {
            ...artifact,
            roomId: artifact.roomId === roomId ? null : artifact.roomId,
            paneId: artifact.paneId && paneIds.has(artifact.paneId) ? null : artifact.paneId,
            turnId: artifact.turnId && turnIds.has(artifact.turnId) ? null : artifact.turnId
          }
        : artifact
    );
    this.importCandidates = this.importCandidates.map((candidate) =>
      candidate.roomId === roomId ? { ...candidate, roomId: null } : candidate
    );
    this.reviewDecisions = this.reviewDecisions.filter((decision) => decision.roomId !== roomId);
    this.reviewChecks = this.reviewChecks.filter((check) => check.roomId !== roomId);
    this.reviewDiffs = this.reviewDiffs.filter((diff) => diff.roomId !== roomId);
    this.swarmTasks = this.swarmTasks.filter((task) => task.roomId !== roomId);
    this.swarmLocks = this.swarmLocks.filter((lock) => lock.roomId !== roomId);
    this.swarmMessages = this.swarmMessages.filter((message) => message.roomId !== roomId);
    this.swarmReconciles = this.swarmReconciles.filter((reconcile) => reconcile.roomId !== roomId);
    this.roomAgentPaneIds.delete(roomId);
    this.roomAgentTranscriptClearedAt.delete(roomId);
    this.roomAgentRequests = new Map(
      [...this.roomAgentRequests.entries()].filter(([, request]) => request.roomId !== roomId)
    );
    const removedMissionIds = new Set(
      [...this.roomAgentMissions.values()].filter((mission) => mission.roomId === roomId).map((mission) => mission.id)
    );
    this.roomAgentMissions = new Map(
      [...this.roomAgentMissions.entries()].filter(([, mission]) => mission.roomId !== roomId)
    );
    this.roomAgentActions = new Map(
      [...this.roomAgentActions.entries()].filter(([, action]) => !removedMissionIds.has(action.missionId))
    );
    this.roomAgentTaskRuns = new Map(
      [...this.roomAgentTaskRuns.entries()].filter(([, run]) => !removedMissionIds.has(run.missionId))
    );

    return room;
  }

  listPanes(roomId: string, includeClosed = false): Pane[] {
    this.getRoom(roomId);
    return [...this.panes.values()]
      .filter((pane) => pane.roomId === roomId)
      .filter((pane) => includeClosed || !pane.isClosed)
      .sort((a, b) => a.order - b.order);
  }

  getPane(paneId: string): Pane {
    const pane = this.panes.get(paneId);
    if (!pane) {
      throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
    }
    return pane;
  }

  private nextOpenPaneOrder(roomId: string): number {
    return this.listPanes(roomId, false).reduce((maxOrder, pane) => Math.max(maxOrder, pane.order), -1) + 1;
  }

  createPane(input: CreatePaneInput, traceId = makeSpaceId("trace")): Pane {
    const room = this.getRoom(input.roomId);
    const existing = this.listPanes(input.roomId, false);
    if (existing.length >= room.paneCap) {
      throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
    }

    const timestamp = nowIso();
    const pane: Pane = {
      id: makeSpaceId("pane"),
      roomId: input.roomId,
      title: input.title,
      mode: input.mode,
      status: "IDLE",
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      terminalRuntimeId: input.terminalRuntimeId ?? null,
      reasoningEffort: "medium",
      cwd: input.cwd ?? null,
      order: this.nextOpenPaneOrder(input.roomId),
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.panes.set(pane.id, pane);
    this.touchRoom(input.roomId, timestamp);
    this.appendEvent({
      roomId: input.roomId,
      paneId: pane.id,
      turnId: null,
      traceId,
      type: "PANE_CREATED",
      message: `Pane ${pane.title} created.`,
      payload: { mode: pane.mode }
    });
    return pane;
  }

  createPanes(inputs: CreatePaneInput[], traceId = makeSpaceId("trace")): Pane[] {
    if (inputs.length === 0) return [];
    const roomId = inputs[0]!.roomId;
    if (inputs.some((input) => input.roomId !== roomId)) {
      throw new SpaceConflictError("A pane batch must target one room.");
    }
    const room = this.getRoom(roomId);
    const existing = this.listPanes(roomId, false);
    if (existing.length + inputs.length > room.paneCap) {
      throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
    }

    const timestamp = nowIso();
    const firstOrder = this.nextOpenPaneOrder(roomId);
    const panes = inputs.map((input, index): Pane => ({
      id: makeSpaceId("pane"),
      roomId,
      title: `${input.title} ${firstOrder + index + 1}`,
      mode: input.mode,
      status: "IDLE",
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      terminalRuntimeId: input.terminalRuntimeId ?? null,
      reasoningEffort: "medium",
      cwd: input.cwd ?? null,
      order: firstOrder + index,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: input.split ?? { parentId: null, direction: null, size: null },
      createdAt: timestamp,
      updatedAt: timestamp
    }));

    for (const pane of panes) {
      this.panes.set(pane.id, pane);
      this.appendEvent({
        roomId,
        paneId: pane.id,
        turnId: null,
        traceId,
        type: "PANE_CREATED",
        message: `Pane ${pane.title} created.`,
        payload: { mode: pane.mode }
      });
    }
    this.touchRoom(roomId, timestamp);
    return panes;
  }

  getOrCreateRoomAgentPane(roomId: string, _traceId = makeSpaceId("trace")): Pane {
    this.getRoom(roomId);
    const existingPaneId = this.roomAgentPaneIds.get(roomId);
    const existing = existingPaneId ? this.panes.get(existingPaneId) : null;
    if (existing) return existing;

    const timestamp = nowIso();
    const pane = paneSchema.parse({
      id: makeSpaceId("pane"),
      roomId,
      title: "Room Agent",
      mode: "CHAT",
      status: "CLOSED",
      providerId: null,
      modelId: "gpt-5.6-sol",
      terminalRuntimeId: null,
      reasoningEffort: "high",
      cwd: null,
      order: 0,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: true,
      split: { parentId: null, direction: null, size: null },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.panes.set(pane.id, pane);
    this.roomAgentPaneIds.set(roomId, pane.id);
    return pane;
  }

  getRoomAgentTranscriptClearedAt(roomId: string): string | null {
    this.getRoom(roomId);
    return this.roomAgentTranscriptClearedAt.get(roomId) ?? null;
  }

  clearRoomAgentTranscript(roomId: string, clearedAt: string, _traceId = makeSpaceId("trace")): string {
    this.getOrCreateRoomAgentPane(roomId);
    const normalized = new Date(clearedAt).toISOString();
    this.roomAgentTranscriptClearedAt.set(roomId, normalized);
    return normalized;
  }

  getRoomAgentRequest(roomId: string, clientRequestId: string): RoomAgentRequestRecord | null {
    return (
      [...this.roomAgentRequests.values()].find(
        (request) => request.roomId === roomId && request.clientRequestId === clientRequestId
      ) ?? null
    );
  }

  createRoomAgentRequest(input: CreateRoomAgentRequestInput, _traceId = makeSpaceId("trace")): RoomAgentRequestRecord {
    const parsed = createRoomAgentRequestInputSchema.parse(input);
    if (this.getRoomAgentRequest(parsed.roomId, parsed.clientRequestId)) {
      throw new SpaceConflictError(`Room agent request ${parsed.clientRequestId} already exists in room ${parsed.roomId}.`);
    }
    const session = this.spaceAgentSessions.get(parsed.sessionId);
    if (!session || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Space agent session ${parsed.sessionId} was not found in room ${parsed.roomId}.`);
    }
    const request = roomAgentRequestRecordSchema.parse({ ...parsed, createdAt: nowIso() });
    this.roomAgentRequests.set(request.requestId, request);
    return request;
  }

  createRoomAgentMission(input: CreateRoomAgentMissionInput, _traceId = makeSpaceId("trace")): RoomAgentMissionRecord {
    const parsed = createRoomAgentMissionInputSchema.parse(input);
    const request = this.roomAgentRequests.get(parsed.requestId);
    if (!request || request.roomId !== parsed.roomId || request.sessionId !== parsed.sessionId) {
      throw new SpaceNotFoundError(`Room agent request ${parsed.requestId} was not found.`);
    }
    const timestamp = nowIso();
    const mission = roomAgentMissionRecordSchema.parse({
      ...parsed,
      queuedAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp
    });
    this.roomAgentMissions.set(mission.id, mission);
    return mission;
  }

  enqueueRoomAgentMission(
    input: EnqueueRoomAgentMissionInput,
    _traceId = makeSpaceId("trace")
  ): RoomAgentEnqueueRecord {
    const queueItem = roomAgentSupervisorQueueItemSchema.parse(input.queueItem);
    const key = `${queueItem.turn.roomId}:${input.clientRequestId}`;
    const existing = this.roomAgentEnqueues.get(key);
    if (existing) {
      return {
        ...existing,
        created: false,
        mission: this.roomAgentMissions.get(existing.mission.id) ?? existing.mission
      };
    }

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
    const session = this.spaceAgentSessions.get(sessionId);
    if (!session || session.roomId !== queueItem.turn.roomId || session.paneId !== queueItem.turn.paneId) {
      throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found.`);
    }

    const timestamp = nowIso();
    const promptMessage = spaceAgentMessageRecordSchema.parse({
      messageId: input.promptMessageId,
      sessionId,
      runId: input.runId,
      role: "user",
      content: input.content,
      status: "COMPLETED",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    let linkedMission = this.roomAgentMissions.get(queueItem.missionId) ?? null;
    if (linkedMission && !["QUEUED", "RUNNING", "PAUSED"].includes(linkedMission.status)) {
      throw new SpaceConflictError(`Room agent mission ${linkedMission.id} no longer accepts follow-up requests.`);
    }
    if (linkedMission && "pendingCompletion" in linkedMission.executionState) {
      const { pendingCompletion: _completed, ...executionState } = linkedMission.executionState;
      linkedMission = this.updateRoomAgentMission(linkedMission.id, {
        completedAt: null,
        executionState,
        statusReason: linkedMission.status === "PAUSED"
          ? "Follow-up queued for the paused Room Agent goal."
          : "Follow-up queued for the active Room Agent goal."
      });
    }
    const requestKind = linkedMission ? "FOLLOW_UP" as const : "MISSION" as const;
    const responseMessage = spaceAgentMessageRecordSchema.parse({
      messageId: input.responseMessageId,
      sessionId,
      runId: input.runId,
      role: "assistant",
      content: linkedMission
        ? "Follow-up received for the active Room Agent goal. I will continue with it in this conversation."
        : "Queued for the Room Agent supervisor.",
      status: "RUNNING",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const request = roomAgentRequestRecordSchema.parse({
      requestId: input.requestId,
      roomId: queueItem.turn.roomId,
      sessionId,
      missionId: queueItem.missionId,
      requestKind,
      clientRequestId: input.clientRequestId,
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      createdAt: timestamp
    });
    const mission = linkedMission ?? roomAgentMissionRecordSchema.parse({
      id: queueItem.missionId,
      requestId: request.requestId,
      roomId: queueItem.turn.roomId,
      sessionId,
      workflowId: input.supervisorWorkflowId,
      status: "QUEUED",
      currentPaneId: null,
      statusReason: "Mission queued behind any active room work.",
      queuedAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp
    });
    const run = spaceAgentRunRecordSchema.parse({
      runId: input.runId,
      sessionId,
      paneId: queueItem.turn.paneId,
      roomId: queueItem.turn.roomId,
      workflowId: input.childWorkflowId,
      temporalRunId: null,
      codexThreadId: queueItem.turn.agentThreadId ?? null,
      codexTurnId: null,
      status: "QUEUED",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });
    const record: RoomAgentEnqueueRecord = {
      created: true,
      signaledAt: null,
      request,
      mission,
      promptMessage,
      responseMessage,
      run,
      queueItem
    };

    this.spaceAgentMessages.set(promptMessage.messageId, promptMessage);
    this.spaceAgentMessages.set(responseMessage.messageId, responseMessage);
    this.roomAgentRequests.set(request.requestId, request);
    if (!linkedMission) this.roomAgentMissions.set(mission.id, mission);
    this.spaceAgentRuns.set(run.runId, run);
    this.spaceAgentSessions.set(session.sessionId, {
      ...session,
      status: "RUNNING",
      lastSyncedAt: timestamp,
      updatedAt: timestamp
    });
    this.roomAgentEnqueues.set(key, record);
    return record;
  }

  markRoomAgentMissionSignaled(roomId: string, clientRequestId: string): void {
    const key = `${roomId}:${clientRequestId}`;
    const current = this.roomAgentEnqueues.get(key);
    if (!current) throw new SpaceNotFoundError(`Room agent request ${clientRequestId} was not found in room ${roomId}.`);
    this.roomAgentEnqueues.set(key, { ...current, signaledAt: nowIso() });
  }

  listUnsignaledRoomAgentEnqueues(limit = 20): RoomAgentEnqueueRecord[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return [...this.roomAgentEnqueues.values()]
      .map((record) => ({
        ...record,
        mission: this.roomAgentMissions.get(record.mission.id) ?? record.mission
      }))
      .filter((record) => record.signaledAt === null && ["QUEUED", "RUNNING", "PAUSED"].includes(record.mission.status))
      .sort((left, right) => left.mission.queuedAt.localeCompare(right.mission.queuedAt))
      .slice(0, boundedLimit);
  }

  updateRoomAgentMission(missionId: string, input: UpdateRoomAgentMissionInput): RoomAgentMissionRecord {
    const current = this.roomAgentMissions.get(missionId);
    if (!current) throw new SpaceNotFoundError(`Room agent mission ${missionId} was not found.`);
    const parsed = updateRoomAgentMissionInputSchema.parse(input);
    const updated = roomAgentMissionRecordSchema.parse({ ...current, ...parsed, updatedAt: nowIso() });
    this.roomAgentMissions.set(missionId, updated);
    return updated;
  }

  getRoomAgentMission(roomId: string, missionId: string): RoomAgentMissionRecord | null {
    this.getRoom(roomId);
    const mission = this.roomAgentMissions.get(missionId);
    return mission?.roomId === roomId ? mission : null;
  }

  listRoomAgentMissions(roomId: string, limit?: number): RoomAgentMissionRecord[] {
    this.getRoom(roomId);
    const missions = [...this.roomAgentMissions.values()]
      .filter((mission) => mission.roomId === roomId)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
    return limit === undefined ? missions : missions.slice(-Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  createRoomAgentAction(input: CreateRoomAgentActionInput, _traceId = makeSpaceId("trace")): RoomAgentActionRecord {
    const parsed = createRoomAgentActionInputSchema.parse(input);
    const mission = this.roomAgentMissions.get(parsed.missionId);
    if (!mission || mission.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Room agent mission ${parsed.missionId} was not found.`);
    }
    if ([...this.roomAgentActions.values()].some((action) => action.idempotencyKey === parsed.idempotencyKey)) {
      throw new SpaceConflictError(`Room agent action ${parsed.idempotencyKey} already exists.`);
    }
    const timestamp = nowIso();
    const action = roomAgentActionRecordSchema.parse({
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });
    this.roomAgentActions.set(action.actionId, action);
    return action;
  }

  updateRoomAgentAction(actionId: string, input: UpdateRoomAgentActionInput): RoomAgentActionRecord {
    const current = this.roomAgentActions.get(actionId);
    if (!current) throw new SpaceNotFoundError(`Room agent action ${actionId} was not found.`);
    const parsed = updateRoomAgentActionInputSchema.parse(input);
    const updated = roomAgentActionRecordSchema.parse({ ...current, ...parsed, updatedAt: nowIso() });
    this.roomAgentActions.set(actionId, updated);
    return updated;
  }

  getRoomAgentAction(missionId: string, actionId: string): RoomAgentActionRecord | null {
    const action = this.roomAgentActions.get(actionId);
    return action?.missionId === missionId ? action : null;
  }

  listRoomAgentActions(missionId: string): RoomAgentActionRecord[] {
    if (!this.roomAgentMissions.has(missionId)) {
      throw new SpaceNotFoundError(`Room agent mission ${missionId} was not found.`);
    }
    return [...this.roomAgentActions.values()]
      .filter((action) => action.missionId === missionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  upsertRoomAgentTaskRun(input: UpsertRoomAgentTaskRunInput): RoomAgentTaskRunRecord {
    const parsed = upsertRoomAgentTaskRunInputSchema.parse(input);
    const mission = this.roomAgentMissions.get(parsed.missionId);
    if (!mission || mission.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Room agent mission ${parsed.missionId} was not found.`);
    }
    const key = `${parsed.missionId}:${parsed.stepId}`;
    const current = this.roomAgentTaskRuns.get(key);
    const record = roomAgentTaskRunRecordSchema.parse({
      ...current,
      ...parsed,
      runId: current?.runId ?? parsed.runId,
      updatedAt: nowIso()
    });
    this.roomAgentTaskRuns.set(key, record);
    return record;
  }

  getRoomAgentTaskRun(missionId: string, stepId: string): RoomAgentTaskRunRecord | null {
    return this.roomAgentTaskRuns.get(`${missionId}:${stepId}`) ?? null;
  }

  listRoomAgentTaskRuns(missionId: string): RoomAgentTaskRunRecord[] {
    if (!this.roomAgentMissions.has(missionId)) throw new SpaceNotFoundError(`Room agent mission ${missionId} was not found.`);
    return [...this.roomAgentTaskRuns.values()]
      .filter((run) => run.missionId === missionId)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.stepId.localeCompare(right.stepId));
  }

  updatePane(paneId: string, input: UpdatePaneInput, traceId = makeSpaceId("trace")): Pane {
    const current = this.panes.get(paneId);
    if (!current) {
      throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
    }

    if (input.isClosed === false && current.isClosed) {
      const active = this.listPanes(current.roomId, false);
      const room = this.getRoom(current.roomId);
      if (active.length >= room.paneCap) {
        throw new SpaceConflictError(`Room ${room.id} is capped at ${room.paneCap} active panes.`);
      }
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
      order: reopening ? this.nextOpenPaneOrder(current.roomId) : current.order,
      isMaximized,
      isMinimized,
      updatedAt: timestamp
    };

    this.panes.set(paneId, updated);
    this.touchRoom(updated.roomId, timestamp);
    this.appendEvent({
      roomId: updated.roomId,
      paneId,
      turnId: null,
      traceId,
      type: updated.isClosed ? "PANE_CLOSED" : "PANE_UPDATED",
      message: `Pane ${updated.title} ${updated.isClosed ? "closed" : "updated"}.`,
      payload: { status: updated.status, mode: updated.mode }
    });

    return updated;
  }

  private reassignPaneRoomReferences(paneId: string, targetRoomId: string, timestamp: string): void {
    this.agentPaneSessions = new Map(
      [...this.agentPaneSessions.entries()].map(([key, session]) => [
        key,
        session.paneId === paneId ? { ...session, roomId: targetRoomId, updatedAt: timestamp } : session
      ])
    );
    this.spaceAgentSessions = new Map(
      [...this.spaceAgentSessions.entries()].map(([sessionId, session]) => [
        sessionId,
        session.paneId === paneId ? { ...session, roomId: targetRoomId, updatedAt: timestamp } : session
      ])
    );
    this.spaceAgentRuns = new Map(
      [...this.spaceAgentRuns.entries()].map(([runId, run]) => [
        runId,
        run.paneId === paneId ? { ...run, roomId: targetRoomId, updatedAt: timestamp } : run
      ])
    );
    this.paneCliSessions = new Map(
      [...this.paneCliSessions.entries()].map(([sessionId, session]) => [
        sessionId,
        session.paneId === paneId ? { ...session, roomId: targetRoomId, updatedAt: timestamp } : session
      ])
    );
    this.paneCliTerminalControlLeases = new Map(
      [...this.paneCliTerminalControlLeases.entries()].map(([leaseId, lease]) => [
        leaseId,
        lease.paneId === paneId ? { ...lease, roomId: targetRoomId } : lease
      ])
    );
    this.paneCliTranscriptChunks = new Map(
      [...this.paneCliTranscriptChunks.entries()].map(([chunkId, chunk]) => [
        chunkId,
        chunk.paneId === paneId ? { ...chunk, roomId: targetRoomId } : chunk
      ])
    );
    this.paneCliCodexThreadOwnerships = new Map(
      [...this.paneCliCodexThreadOwnerships.entries()].map(([threadId, ownership]) => [
        threadId,
        ownership.paneId === paneId ? { ...ownership, roomId: targetRoomId, updatedAt: timestamp } : ownership
      ])
    );
    this.paneBrowserSessions = new Map(
      [...this.paneBrowserSessions.entries()].map(([sessionId, session]) => [
        sessionId,
        session.paneId === paneId ? { ...session, roomId: targetRoomId, updatedAt: timestamp } : session
      ])
    );
    this.browserControlLeases = new Map(
      [...this.browserControlLeases.entries()].map(([leaseId, lease]) => [
        leaseId,
        lease.paneId === paneId ? { ...lease, roomId: targetRoomId } : lease
      ])
    );
    this.browserCaptureJobs = new Map(
      [...this.browserCaptureJobs.entries()].map(([jobId, job]) => [
        jobId,
        job.paneId === paneId ? { ...job, roomId: targetRoomId, updatedAt: timestamp } : job
      ])
    );
    this.browserHandoffRequests = new Map(
      [...this.browserHandoffRequests.entries()].map(([handoffRequestId, handoff]) => [
        handoffRequestId,
        handoff.paneId === paneId ? { ...handoff, roomId: targetRoomId, updatedAt: timestamp } : handoff
      ])
    );
    this.workflows = new Map(
      [...this.workflows.entries()].map(([workflowId, workflow]) => [
        workflowId,
        workflow.paneId === paneId ? { ...workflow, roomId: targetRoomId } : workflow
      ])
    );
    this.turns = new Map(
      [...this.turns.entries()].map(([turnId, turn]) => [
        turnId,
        turn.paneId === paneId ? { ...turn, roomId: targetRoomId, updatedAt: timestamp } : turn
      ])
    );
    this.events = this.events.map((event) => (event.paneId === paneId ? { ...event, roomId: targetRoomId } : event));
    this.artifacts = this.artifacts.map((artifact) =>
      artifact.paneId === paneId ? { ...artifact, roomId: targetRoomId } : artifact
    );
  }

  movePane(paneId: string, input: MovePaneInput, traceId = makeSpaceId("trace")): MovePaneResult {
    const current = this.panes.get(paneId);
    if (!current) {
      throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
    }
    if (current.isClosed) {
      throw new SpaceConflictError(`Pane ${current.title} is already closed and cannot be moved.`);
    }

    const parsed = movePaneInputSchema.parse(input);
    if (parsed.targetRoomId === current.roomId) {
      throw new SpaceConflictError("Choose a different room before moving this pane.");
    }

    const targetRoom = this.getRoom(parsed.targetRoomId);
    const targetOpenPanes = this.listPanes(parsed.targetRoomId, false);
    if (targetOpenPanes.length >= targetRoom.paneCap) {
      throw new SpaceConflictError(`Room ${targetRoom.id} is capped at ${targetRoom.paneCap} active panes.`);
    }

    const timestamp = nowIso();
    const sourcePane: Pane = { ...current };
    const targetPane: Pane = {
      ...current,
      roomId: parsed.targetRoomId,
      order: this.nextOpenPaneOrder(parsed.targetRoomId),
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      split: { parentId: null, direction: null, size: null },
      updatedAt: timestamp
    };

    this.panes.set(targetPane.id, targetPane);
    this.reassignPaneRoomReferences(targetPane.id, targetPane.roomId, timestamp);
    this.touchRoom(sourcePane.roomId, timestamp);
    this.touchRoom(targetPane.roomId, timestamp);

    this.appendEvent({
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
    this.appendEvent({
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
  }

  getAgentPaneBinding(paneId: string): AgentPaneBinding | null {
    return this.agentPaneBindings.get(paneId) ?? null;
  }

  private agentPaneSessionKey(paneId: string, coderChatId: string): string {
    return `${paneId}:${coderChatId}`;
  }

  private storedSessionFromBinding(binding: AgentPaneBinding, pane: Pane): UpsertAgentPaneStoredSessionInput | null {
    if (!binding.coderChatId) return null;
    return {
      paneId: binding.paneId,
      roomId: pane.roomId,
      source: binding.source,
      sessionId: null,
      coderChatId: binding.coderChatId,
      status: binding.status,
      title: binding.title,
      selectedModelConfigId: binding.selectedModelConfigId,
      selectedProviderName: binding.selectedProviderName,
      selectedModelName: binding.selectedModelName,
      selectedReasoningKey: binding.selectedReasoningKey,
      selectedToolIds: binding.selectedToolIds,
      lastSyncedAt: binding.lastSyncedAt
    };
  }

  listAgentPaneHistory(roomId?: string): AgentPaneHistoryItem[] {
    const activeByChatId = new Map<string, AgentPaneBinding>();
    for (const binding of this.agentPaneBindings.values()) {
      if (binding.coderChatId) activeByChatId.set(binding.coderChatId, binding);
    }
    return [...this.agentPaneSessions.values()]
      .filter((session) => !roomId || session.roomId === roomId)
      .map((session): AgentPaneHistoryItem => {
        const pane = this.panes.get(session.paneId);
        const active = activeByChatId.get(session.coderChatId);
        const status = active && active.paneId === session.paneId ? active.status : session.status;
        return {
          paneId: session.paneId,
          roomId: session.roomId,
          source: session.source,
          sessionId: session.sessionId,
          coderChatId: session.coderChatId,
          status,
          title: session.title,
          selectedModelConfigId: session.selectedModelConfigId,
          selectedProviderName: session.selectedProviderName,
          selectedModelName: session.selectedModelName,
          selectedReasoningKey: session.selectedReasoningKey,
          selectedToolIds: session.selectedToolIds,
          lastSyncedAt: session.lastSyncedAt,
          paneTitle: pane?.title ?? null,
          paneIsClosed: pane?.isClosed ?? true,
          updatedAt: session.updatedAt
        };
      })
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .slice(0, 100);
  }

  upsertAgentPaneStoredSession(
    input: UpsertAgentPaneStoredSessionInput,
    _traceId = makeSpaceId("trace")
  ): AgentPaneStoredSession {
    const parsed = upsertAgentPaneStoredSessionInputSchema.parse(input);
    const pane = this.panes.get(parsed.paneId);
    if (!pane || pane.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
    }
    if (!this.rooms.has(parsed.roomId)) {
      throw new SpaceNotFoundError(`Room ${parsed.roomId} was not found.`);
    }
    const key = this.agentPaneSessionKey(parsed.paneId, parsed.coderChatId);
    const current = this.agentPaneSessions.get(key);
    const timestamp = nowIso();
    const stored = agentPaneStoredSessionSchema.parse({
      ...parsed,
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    this.agentPaneSessions.set(key, stored);
    return stored;
  }

  private persistStoredSessionForBinding(binding: AgentPaneBinding): void {
    const pane = this.panes.get(binding.paneId);
    if (!pane) return;
    const input = this.storedSessionFromBinding(binding, pane);
    if (!input) return;
    this.upsertAgentPaneStoredSession(input);
  }

  upsertAgentPaneBinding(input: UpsertAgentPaneBindingInput, _traceId = makeSpaceId("trace")): AgentPaneBinding {
    const parsed = upsertAgentPaneBindingInputSchema.parse(input);
    if (!this.panes.has(parsed.paneId)) {
      throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
    }
    const binding = agentPaneBindingSchema.parse(parsed);
    this.agentPaneBindings.set(binding.paneId, binding);
    this.persistStoredSessionForBinding(binding);
    return binding;
  }

  updateAgentPaneBinding(
    paneId: string,
    input: UpdateAgentPaneBindingInput,
    _traceId = makeSpaceId("trace")
  ): AgentPaneBinding {
    const current = this.agentPaneBindings.get(paneId);
    if (!current) {
      throw new SpaceNotFoundError(`Agent binding for pane ${paneId} was not found.`);
    }
    const parsed = updateAgentPaneBindingInputSchema.parse(input);
    const binding = agentPaneBindingSchema.parse({
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
    this.agentPaneBindings.set(paneId, binding);
    this.persistStoredSessionForBinding(binding);
    return binding;
  }

  getActiveSpaceAgentSession(paneId: string): SpaceAgentSessionRecord | null {
    return [...this.spaceAgentSessions.values()].find((session) => session.paneId === paneId && session.isActive) ?? null;
  }

  getSpaceAgentSession(sessionId: string): SpaceAgentSessionRecord | null {
    return this.spaceAgentSessions.get(sessionId) ?? null;
  }

  listSpaceAgentHistory(roomId?: string): AgentPaneHistoryItem[] {
    return [...this.spaceAgentSessions.values()]
      .filter((session) => !roomId || session.roomId === roomId)
      .map((session): AgentPaneHistoryItem => {
        const pane = this.panes.get(session.paneId);
        return {
          paneId: session.paneId,
          roomId: session.roomId,
          source: "SPACE",
          sessionId: session.sessionId,
          coderChatId: null,
          status: session.status,
          title: session.title,
          selectedModelConfigId: session.selectedModelConfigId,
          selectedProviderName: session.selectedProviderName,
          selectedModelName: session.selectedModelName,
          selectedReasoningKey: session.selectedReasoningKey,
          selectedToolIds: session.selectedToolIds,
          lastSyncedAt: session.lastSyncedAt,
          paneTitle: pane?.title ?? null,
          paneIsClosed: pane?.isClosed ?? true,
          updatedAt: session.updatedAt
        };
      })
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .slice(0, 100);
  }

  createSpaceAgentSession(
    input: CreateSpaceAgentSessionInput,
    _traceId = makeSpaceId("trace")
  ): SpaceAgentSessionRecord {
    const parsed = createSpaceAgentSessionInputSchema.parse(input);
    const pane = this.panes.get(parsed.paneId);
    if (!pane || pane.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
    }
    if (!this.rooms.has(parsed.roomId)) {
      throw new SpaceNotFoundError(`Room ${parsed.roomId} was not found.`);
    }
    const timestamp = nowIso();
    const session = spaceAgentSessionRecordSchema.parse({
      ...parsed,
      sessionId: parsed.sessionId ?? makeSpaceId("agent_session"),
      source: "SPACE",
      status: parsed.status ?? "READY",
      threadId: parsed.threadId ?? null,
      selectedProviderId: parsed.selectedProviderId ?? null,
      selectedModelId: parsed.selectedModelId ?? null,
      selectedModelConfigId: parsed.selectedModelConfigId ?? parsed.selectedModelId ?? null,
      selectedProviderName: parsed.selectedProviderName ?? null,
      selectedModelName: parsed.selectedModelName ?? null,
      selectedReasoningKey: parsed.selectedReasoningKey ?? null,
      selectedToolIds: parsed.selectedToolIds ?? null,
      permissionMode: parsed.permissionMode ?? null,
      collaborationMode: parsed.collaborationMode ?? null,
      isActive: parsed.isActive ?? true,
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (session.isActive) {
      for (const [sessionId, existing] of this.spaceAgentSessions.entries()) {
        if (existing.paneId === session.paneId && existing.sessionId !== session.sessionId && existing.isActive) {
          this.spaceAgentSessions.set(sessionId, { ...existing, isActive: false, updatedAt: timestamp });
        }
      }
    }
    this.spaceAgentSessions.set(session.sessionId, session);
    return session;
  }

  updateSpaceAgentSession(
    sessionId: string,
    input: UpdateSpaceAgentSessionInput,
    _traceId = makeSpaceId("trace")
  ): SpaceAgentSessionRecord {
    const current = this.spaceAgentSessions.get(sessionId);
    if (!current) {
      throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found.`);
    }
    const parsed = updateSpaceAgentSessionInputSchema.parse(input);
    const nextPaneId = parsed.paneId ?? current.paneId;
    const nextRoomId = parsed.roomId ?? current.roomId;
    const pane = this.panes.get(nextPaneId);
    if (!pane || pane.roomId !== nextRoomId) {
      throw new SpaceNotFoundError(`Pane ${nextPaneId} was not found.`);
    }
    if (!this.rooms.has(nextRoomId)) {
      throw new SpaceNotFoundError(`Room ${nextRoomId} was not found.`);
    }
    const timestamp = nowIso();
    const updated = spaceAgentSessionRecordSchema.parse({
      ...current,
      ...parsed,
      paneId: nextPaneId,
      roomId: nextRoomId,
      threadId: parsed.threadId === undefined ? current.threadId : parsed.threadId,
      selectedProviderId: parsed.selectedProviderId === undefined ? current.selectedProviderId : parsed.selectedProviderId,
      selectedModelId: parsed.selectedModelId === undefined ? current.selectedModelId : parsed.selectedModelId,
      selectedModelConfigId:
        parsed.selectedModelConfigId === undefined ? current.selectedModelConfigId : parsed.selectedModelConfigId,
      selectedProviderName:
        parsed.selectedProviderName === undefined ? current.selectedProviderName : parsed.selectedProviderName,
      selectedModelName: parsed.selectedModelName === undefined ? current.selectedModelName : parsed.selectedModelName,
      selectedReasoningKey:
        parsed.selectedReasoningKey === undefined ? current.selectedReasoningKey : parsed.selectedReasoningKey,
      selectedToolIds: parsed.selectedToolIds === undefined ? current.selectedToolIds : parsed.selectedToolIds,
      permissionMode: parsed.permissionMode === undefined ? current.permissionMode : parsed.permissionMode,
      collaborationMode: parsed.collaborationMode === undefined ? current.collaborationMode : parsed.collaborationMode,
      isActive: parsed.isActive === undefined ? current.isActive : parsed.isActive,
      lastSyncedAt: parsed.lastSyncedAt === undefined ? current.lastSyncedAt : parsed.lastSyncedAt,
      updatedAt: timestamp
    });
    if (updated.isActive) {
      for (const [existingSessionId, existing] of this.spaceAgentSessions.entries()) {
        if (existing.paneId === updated.paneId && existing.sessionId !== updated.sessionId && existing.isActive) {
          this.spaceAgentSessions.set(existingSessionId, { ...existing, isActive: false, updatedAt: timestamp });
        }
      }
    }
    this.spaceAgentSessions.set(sessionId, updated);
    return updated;
  }

  listSpaceAgentMessages(sessionId: string, limit?: number): SpaceAgentMessageRecord[] {
    if (!this.spaceAgentSessions.has(sessionId)) {
      throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found.`);
    }
    const messages = [...this.spaceAgentMessages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return limit === undefined ? messages : messages.slice(-Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  countSpaceAgentMessages(sessionId: string): number {
    if (!this.spaceAgentSessions.has(sessionId)) {
      throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found.`);
    }
    return [...this.spaceAgentMessages.values()].filter((message) => message.sessionId === sessionId).length;
  }

  createSpaceAgentMessage(
    input: CreateSpaceAgentMessageInput,
    _traceId = makeSpaceId("trace")
  ): SpaceAgentMessageRecord {
    const parsed = createSpaceAgentMessageInputSchema.parse(input);
    if (!this.spaceAgentSessions.has(parsed.sessionId)) {
      throw new SpaceNotFoundError(`Space agent session ${parsed.sessionId} was not found.`);
    }
    const timestamp = nowIso();
    const message = spaceAgentMessageRecordSchema.parse({
      ...parsed,
      messageId: parsed.messageId ?? makeSpaceId("agent_msg"),
      runId: parsed.runId ?? null,
      status: parsed.status ?? "COMPLETED",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.spaceAgentMessages.set(message.messageId, message);
    return message;
  }

  updateSpaceAgentMessage(
    messageId: string,
    input: UpdateSpaceAgentMessageInput,
    _traceId = makeSpaceId("trace")
  ): SpaceAgentMessageRecord {
    const current = this.spaceAgentMessages.get(messageId);
    if (!current) {
      throw new SpaceNotFoundError(`Space agent message ${messageId} was not found.`);
    }
    const parsed = updateSpaceAgentMessageInputSchema.parse(input);
    const updated = spaceAgentMessageRecordSchema.parse({
      ...current,
      ...parsed,
      runId: parsed.runId === undefined ? current.runId : parsed.runId,
      updatedAt: nowIso()
    });
    this.spaceAgentMessages.set(messageId, updated);
    return updated;
  }

  createSpaceAgentRun(input: CreateSpaceAgentRunInput, _traceId = makeSpaceId("trace")): SpaceAgentRunRecord {
    const parsed = createSpaceAgentRunInputSchema.parse(input);
    const session = this.spaceAgentSessions.get(parsed.sessionId);
    if (!session || session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Space agent session ${parsed.sessionId} was not found.`);
    }
    if (!this.spaceAgentMessages.has(parsed.promptMessageId) || !this.spaceAgentMessages.has(parsed.responseMessageId)) {
      throw new SpaceNotFoundError("Space agent run messages were not found.");
    }
    const timestamp = nowIso();
    const run = spaceAgentRunRecordSchema.parse({
      ...parsed,
      runId: parsed.runId ?? makeSpaceId("agent_run"),
      temporalRunId: parsed.temporalRunId ?? null,
      codexThreadId: parsed.codexThreadId ?? null,
      codexTurnId: parsed.codexTurnId ?? null,
      errorCode: parsed.errorCode ?? null,
      errorMessage: parsed.errorMessage ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: parsed.completedAt ?? null
    });
    this.spaceAgentRuns.set(run.runId, run);
    this.updateSpaceAgentMessage(run.promptMessageId, { runId: run.runId });
    this.updateSpaceAgentMessage(run.responseMessageId, { runId: run.runId });
    return run;
  }

  updateSpaceAgentRun(runId: string, input: UpdateSpaceAgentRunInput, _traceId = makeSpaceId("trace")): SpaceAgentRunRecord {
    const current = this.spaceAgentRuns.get(runId);
    if (!current) {
      throw new SpaceNotFoundError(`Space agent run ${runId} was not found.`);
    }
    const parsed = updateSpaceAgentRunInputSchema.parse(input);
    const terminal = parsed.status === "COMPLETED" || parsed.status === "FAILED" || parsed.status === "INTERRUPTED";
    const updated = spaceAgentRunRecordSchema.parse({
      ...current,
      ...parsed,
      temporalRunId: parsed.temporalRunId === undefined ? current.temporalRunId : parsed.temporalRunId,
      codexThreadId: parsed.codexThreadId === undefined ? current.codexThreadId : parsed.codexThreadId,
      codexTurnId: parsed.codexTurnId === undefined ? current.codexTurnId : parsed.codexTurnId,
      errorCode: parsed.errorCode === undefined ? current.errorCode : parsed.errorCode,
      errorMessage: parsed.errorMessage === undefined ? current.errorMessage : parsed.errorMessage,
      updatedAt: nowIso(),
      completedAt: parsed.completedAt === undefined ? (terminal ? nowIso() : current.completedAt) : parsed.completedAt
    });
    this.spaceAgentRuns.set(runId, updated);
    return updated;
  }

  updateSpaceAgentRunByWorkflowId(
    workflowId: string,
    input: UpdateSpaceAgentRunInput,
    traceId = makeSpaceId("trace")
  ): SpaceAgentRunRecord {
    const run = [...this.spaceAgentRuns.values()].find((candidate) => candidate.workflowId === workflowId);
    if (!run) {
      throw new SpaceNotFoundError(`Space agent run for workflow ${workflowId} was not found.`);
    }
    return this.updateSpaceAgentRun(run.runId, input, traceId);
  }

  completeSpaceAgentRun(input: CompleteSpaceAgentRunInput): CompletedSpaceAgentRunRecord {
    const currentRun = this.spaceAgentRuns.get(input.runId);
    const currentSession = this.spaceAgentSessions.get(input.sessionId);
    const currentMessage = this.spaceAgentMessages.get(input.responseMessageId);
    if (!currentRun || currentRun.sessionId !== input.sessionId) {
      throw new SpaceNotFoundError(`Space agent run ${input.runId} was not found.`);
    }
    if (!currentSession || currentSession.sessionId !== currentRun.sessionId) {
      throw new SpaceNotFoundError(`Space agent session ${input.sessionId} was not found.`);
    }
    if (!currentMessage || currentMessage.sessionId !== input.sessionId || currentMessage.messageId !== currentRun.responseMessageId) {
      throw new SpaceNotFoundError(`Space agent response message ${input.responseMessageId} was not found.`);
    }
    const responseMessage = this.updateSpaceAgentMessage(input.responseMessageId, {
      content: input.responseContent,
      status: "COMPLETED"
    });
    const run = this.updateSpaceAgentRun(input.runId, {
      status: "COMPLETED",
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      errorCode: null,
      errorMessage: null,
      completedAt: input.completedAt
    });
    const session = this.updateSpaceAgentSession(input.sessionId, {
      status: "READY",
      threadId: input.codexThreadId,
      lastSyncedAt: input.completedAt
    });
    const event = this.appendEvent({
      roomId: run.roomId,
      paneId: run.paneId,
      turnId: null,
      workflowId: null,
      traceId: input.traceId,
      type: "TURN_COMPLETED",
      message: "Codex turn completed.",
      payload: {
        status: run.status,
        runId: run.runId,
        sourceType: input.sourceType,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId
      }
    });
    return { run, session, responseMessage, event };
  }

  getLatestSpaceAgentRun(sessionId: string): SpaceAgentRunRecord | null {
    if (!this.spaceAgentSessions.has(sessionId)) {
      throw new SpaceNotFoundError(`Space agent session ${sessionId} was not found.`);
    }
    return (
      [...this.spaceAgentRuns.values()]
        .filter((run) => run.sessionId === sessionId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    );
  }

  getActivePaneCliSession(paneId: string): PaneCliSession | null {
    return [...this.paneCliSessions.values()].find((session) => session.paneId === paneId && session.isActive) ?? null;
  }

  getActivePaneCliSessionByCodexThreadId(codexThreadId: string): PaneCliSession | null {
    return (
      [...this.paneCliSessions.values()]
        .filter((session) => session.isActive && session.codexThreadId === codexThreadId)
        .sort((left, right) => {
          if (left.startedAt !== right.startedAt) return left.startedAt.localeCompare(right.startedAt);
          if (left.updatedAt !== right.updatedAt) return left.updatedAt.localeCompare(right.updatedAt);
          return left.sessionId.localeCompare(right.sessionId);
        })[0] ?? null
    );
  }

  getLatestPaneCliSessionByCodexThreadId(codexThreadId: string): PaneCliSession | null {
    return (
      [...this.paneCliSessions.values()]
        .filter((session) => session.codexThreadId === codexThreadId)
        .sort((left, right) => {
          if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
          if (left.startedAt !== right.startedAt) return right.startedAt.localeCompare(left.startedAt);
          return right.sessionId.localeCompare(left.sessionId);
        })[0] ?? null
    );
  }

  getCliTask(taskId: string): CliTaskRecord | null {
    return this.cliTasks.get(taskId) ?? null;
  }

  getCliTaskRevision(revisionId: string): CliTaskRevisionRecord | null {
    return this.cliTaskRevisions.get(revisionId) ?? null;
  }

  getCliTaskRevisionByNativeRef(runtimeId: string, nativeTaskRef: string): CliTaskRevisionRecord | null {
    return [...this.cliTaskRevisions.values()].find(
      (revision) => revision.runtimeId === runtimeId && revision.nativeTaskRef === nativeTaskRef
    ) ?? null;
  }

  createCliTaskRevision(
    input: CreateCliTaskRevisionInput,
    _traceId = makeSpaceId("trace")
  ): CliTaskRevisionRecord {
    const revisionId = idSchema.parse(input.revisionId);
    const taskId = idSchema.parse(input.taskId);
    if (this.cliTaskRevisions.has(revisionId)) {
      throw new SpaceConflictError(`CLI task revision ${revisionId} already exists.`);
    }
    const sourceRevision = input.sourceRevisionId ? this.cliTaskRevisions.get(input.sourceRevisionId) : null;
    if (input.sourceRevisionId && (!sourceRevision || sourceRevision.taskId !== taskId)) {
      throw new SpaceConflictError("CLI task revision source must belong to the same logical task.");
    }
    if (input.nativeTaskRef) {
      const nativeOwner = this.getCliTaskRevisionByNativeRef(input.runtimeId, input.nativeTaskRef);
      if (nativeOwner && nativeOwner.taskId !== taskId) {
        throw new SpaceConflictError(`CLI native task reference is already registered for ${input.runtimeId}.`);
      }
      if (nativeOwner) {
        this.cliTaskRevisions.set(nativeOwner.revisionId, {
          ...nativeOwner,
          nativeTaskRef: null,
          updatedAt: nowIso()
        });
      }
    }
    const timestamp = nowIso();
    const currentTask = this.cliTasks.get(taskId);
    const task: CliTaskRecord = currentTask ?? {
      taskId,
      currentRevisionId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const revision: CliTaskRevisionRecord = {
      ...input,
      revisionId,
      taskId,
      nativeTaskRef: input.nativeTaskRef ?? null,
      sourceRevisionId: input.sourceRevisionId ?? null,
      latestSpaceSessionId: input.latestSpaceSessionId ?? null,
      cwd: input.cwd ?? null,
      modelId: input.modelId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.cliTaskRevisions.set(revisionId, revision);
    this.cliTasks.set(taskId, { ...task, currentRevisionId: revisionId, updatedAt: timestamp });
    return revision;
  }

  updateCliTaskRevision(
    revisionId: string,
    input: UpdateCliTaskRevisionInput,
    _traceId = makeSpaceId("trace")
  ): CliTaskRevisionRecord {
    const current = this.cliTaskRevisions.get(revisionId);
    if (!current) throw new SpaceNotFoundError(`CLI task revision ${revisionId} was not found.`);
    if (input.nativeTaskRef) {
      const owner = this.getCliTaskRevisionByNativeRef(current.runtimeId, input.nativeTaskRef);
      if (owner && owner.revisionId !== revisionId && owner.taskId !== current.taskId) {
        throw new SpaceConflictError(`CLI native task reference is already registered for ${current.runtimeId}.`);
      }
      if (owner && owner.revisionId !== revisionId) {
        this.cliTaskRevisions.set(owner.revisionId, { ...owner, nativeTaskRef: null, updatedAt: nowIso() });
      }
    }
    const timestamp = nowIso();
    const updated: CliTaskRevisionRecord = {
      ...current,
      ...input,
      nativeTaskRef: input.nativeTaskRef === undefined ? current.nativeTaskRef : input.nativeTaskRef,
      latestSpaceSessionId:
        input.latestSpaceSessionId === undefined ? current.latestSpaceSessionId : input.latestSpaceSessionId,
      updatedAt: timestamp
    };
    this.cliTaskRevisions.set(revisionId, updated);
    const task = this.cliTasks.get(current.taskId);
    if (task) this.cliTasks.set(task.taskId, { ...task, updatedAt: timestamp });
    return updated;
  }

  listPaneCliSessions(paneId: string, limit = 20): PaneCliSession[] {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    return [...this.paneCliSessions.values()]
      .filter((session) => session.paneId === paneId)
      .sort((left, right) => {
        if (left.startedAt !== right.startedAt) return right.startedAt.localeCompare(left.startedAt);
        if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
        if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
        return right.sessionId.localeCompare(left.sessionId);
      })
      .slice(0, boundedLimit);
  }

  listActivePaneCliSessions(runtimeId: string): PaneCliSession[] {
    return [...this.paneCliSessions.values()]
      .filter((session) => session.runtimeId === runtimeId && session.isActive && session.status === "RUNNING")
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  listPaneCliTaskHistory(input: ListPaneCliTaskHistoryInput): StorePageResult<PaneCliTaskHistoryRecord> {
    const page = Math.max(1, Math.trunc(input.page));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize)));
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const allowedRuntimeIds = input.runtimeIds ? new Set(input.runtimeIds) : null;
    const records = [...this.cliTasks.values()].flatMap((task) => {
      if (this.hiddenPaneCliTaskIds.has(task.taskId)) return [];
      const revision = task.currentRevisionId ? this.cliTaskRevisions.get(task.currentRevisionId) : null;
      if (!revision?.latestSpaceSessionId) return [];
      const session = this.paneCliSessions.get(revision.latestSpaceSessionId);
      if (!session || session.purpose !== "NORMAL") return [];
      if (allowedRuntimeIds && !allowedRuntimeIds.has(revision.runtimeId)) return [];
      const pane = this.panes.get(session.paneId);
      if (!pane) return [];
      const transcript = this.listPaneCliTranscriptChunks(session.sessionId);
      const transcriptFirstUserMessage = transcript.find(
        (chunk) => chunk.stream === "stdin" && chunk.content.trim()
      )?.content.trim();
      const firstUserMessage = revision.firstUserMessage.trim() || transcriptFirstUserMessage || "";
      if (!firstUserMessage && !revision.nativeTaskRef) return [];
      const transcriptPreview = [...transcript]
        .reverse()
        .find((chunk) => (chunk.stream === "stdout" || chunk.stream === "stderr") && chunk.content.trim())
        ?.content.trim();
      const preview = revision.preview.trim() || transcriptPreview || firstUserMessage;
      const recencyAt = [revision.updatedAt, transcript.at(-1)?.createdAt, session.updatedAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1)!;
      return [{
        taskId: task.taskId,
        revision,
        session,
        paneTitle: revision.displayTitle.trim() || pane.title,
        firstUserMessage,
        preview,
        recencyAt
      }];
    }).filter((record) => {
      if (!query) return true;
      return `${record.paneTitle}\n${record.firstUserMessage}\n${record.preview}`.toLocaleLowerCase().includes(query);
    }).sort((left, right) => {
      if (left.recencyAt !== right.recencyAt) return right.recencyAt.localeCompare(left.recencyAt);
      return right.taskId.localeCompare(left.taskId);
    });
    const start = (page - 1) * pageSize;
    return { items: records.slice(start, start + pageSize), total: records.length };
  }

  listInactivePaneCliTaskIds(): string[] {
    const taskIds: string[] = [];
    let page = 1;
    while (true) {
      const history = this.listPaneCliTaskHistory({ page, pageSize: 100 });
      for (const item of history.items) {
        const hasActiveSession = [...this.paneCliSessions.values()].some(
          (session) => session.cliTaskId === item.taskId && session.isActive
        );
        if (!hasActiveSession) taskIds.push(item.taskId);
      }
      if (page * 100 >= history.total) break;
      page += 1;
    }
    return [...new Set(taskIds)].sort();
  }

  hideInactivePaneCliTasks(taskIds: string[]): string[] {
    const hidden: string[] = [];
    for (const taskId of [...new Set(taskIds)].sort()) {
      if (!this.cliTasks.has(taskId) || this.hiddenPaneCliTaskIds.has(taskId)) continue;
      const hasActiveSession = [...this.paneCliSessions.values()].some(
        (session) => session.cliTaskId === taskId && session.isActive
      );
      if (hasActiveSession) continue;
      this.hiddenPaneCliTaskIds.add(taskId);
      hidden.push(taskId);
    }
    return hidden;
  }

  restorePaneCliTasks(taskIds: string[]): void {
    for (const taskId of taskIds) this.hiddenPaneCliTaskIds.delete(taskId);
  }

  getPaneTitlesByCodexThreadIds(codexThreadIds: string[]): Map<string, string> {
    const wanted = new Set(codexThreadIds.filter(Boolean));
    const selected = new Map<string, { title: string; session: PaneCliSession }>();
    for (const session of this.paneCliSessions.values()) {
      if (!session.codexThreadId || !wanted.has(session.codexThreadId)) continue;
      const pane = this.panes.get(session.paneId);
      if (!pane?.title.trim()) continue;
      const existing = selected.get(session.codexThreadId);
      if (
        !existing ||
        session.updatedAt.localeCompare(existing.session.updatedAt) > 0 ||
        (session.updatedAt === existing.session.updatedAt && session.startedAt.localeCompare(existing.session.startedAt) > 0) ||
        (session.updatedAt === existing.session.updatedAt &&
          session.startedAt === existing.session.startedAt &&
          session.sessionId.localeCompare(existing.session.sessionId) > 0)
      ) {
        selected.set(session.codexThreadId, { title: pane.title, session });
      }
    }
    return new Map([...selected.entries()].map(([threadId, entry]) => [threadId, entry.title]));
  }

  private assertActiveCodexThreadAvailable(sessionId: string, codexThreadId: string): void {
    const owner = this.getActivePaneCliSessionByCodexThreadId(codexThreadId);
    if (owner && owner.sessionId !== sessionId) {
      throw new SpaceConflictError(`Codex thread ${codexThreadId} is already owned by active CLI session ${owner.sessionId}.`);
    }
  }

  getPaneCliSession(sessionId: string): PaneCliSession | null {
    return this.paneCliSessions.get(sessionId) ?? null;
  }

  getActivePaneCliTerminalControlLease(sessionId: string): PaneCliTerminalControlLease | null {
    const active = [...this.paneCliTerminalControlLeases.values()].find(
      (lease) => lease.sessionId === sessionId && lease.status === "ACTIVE"
    );
    if (!active) return null;
    const timestamp = nowIso();
    if (active.expiresAt > timestamp) return active;
    const expired = paneCliTerminalControlLeaseSchema.parse({
      ...active,
      status: "EXPIRED",
      releasedAt: active.releasedAt ?? timestamp
    });
    this.paneCliTerminalControlLeases.set(expired.leaseId, expired);
    return null;
  }

  getPaneCliTerminalControlLease(leaseId: string): PaneCliTerminalControlLease | null {
    const lease = this.paneCliTerminalControlLeases.get(leaseId);
    if (!lease) return null;
    if (lease.status !== "ACTIVE" || lease.expiresAt > nowIso()) return lease;
    this.getActivePaneCliTerminalControlLease(lease.sessionId);
    return this.paneCliTerminalControlLeases.get(leaseId) ?? null;
  }

  createPaneCliTerminalControlLease(
    input: CreatePaneCliTerminalControlLeaseInput
  ): PaneCliTerminalControlLease {
    const parsed = createPaneCliTerminalControlLeaseInputSchema.parse(input);
    const session = this.paneCliSessions.get(parsed.sessionId);
    if (!session || session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`CLI session ${parsed.sessionId} was not found.`);
    }
    const active = this.getActivePaneCliTerminalControlLease(parsed.sessionId);
    if (parsed.expectedActiveLeaseId === null ? active !== null : active?.leaseId !== parsed.expectedActiveLeaseId) {
      throw new SpaceConflictError(`CLI terminal control for session ${parsed.sessionId} changed before acquisition.`);
    }
    const leaseId = parsed.leaseId ?? makeSpaceId("cli_terminal_lease");
    if (this.paneCliTerminalControlLeases.has(leaseId)) {
      throw new SpaceConflictError(`CLI terminal control lease ${leaseId} already exists.`);
    }
    const timestamp = nowIso();
    if (active) {
      this.paneCliTerminalControlLeases.set(active.leaseId, paneCliTerminalControlLeaseSchema.parse({
        ...active,
        status: "REVOKED",
        releasedAt: active.releasedAt ?? timestamp
      }));
    }
    const lease = paneCliTerminalControlLeaseSchema.parse({
      leaseId,
      sessionId: parsed.sessionId,
      paneId: parsed.paneId,
      roomId: parsed.roomId,
      userId: parsed.userId,
      browserClientId: parsed.browserClientId,
      tabLineageId: parsed.tabLineageId,
      pageClientId: parsed.pageClientId,
      status: "ACTIVE",
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1_000).toISOString(),
      releasedAt: null
    });
    this.paneCliTerminalControlLeases.set(lease.leaseId, lease);
    return lease;
  }

  updatePaneCliTerminalControlLease(
    leaseId: string,
    input: UpdatePaneCliTerminalControlLeaseInput
  ): PaneCliTerminalControlLease {
    const parsed = updatePaneCliTerminalControlLeaseInputSchema.parse(input);
    const current = this.getPaneCliTerminalControlLease(leaseId);
    if (!current) throw new SpaceNotFoundError(`CLI terminal control lease ${leaseId} was not found.`);
    if (current.status !== parsed.expectedStatus) {
      throw new SpaceConflictError(`CLI terminal control lease ${leaseId} is no longer active.`);
    }
    const timestamp = nowIso();
    const status = parsed.status ?? current.status;
    const updated = paneCliTerminalControlLeaseSchema.parse({
      ...current,
      status,
      heartbeatAt: parsed.ttlSeconds === undefined ? current.heartbeatAt : timestamp,
      expiresAt: parsed.ttlSeconds === undefined
        ? current.expiresAt
        : new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1_000).toISOString(),
      releasedAt: status === "ACTIVE" ? null : current.releasedAt ?? timestamp
    });
    this.paneCliTerminalControlLeases.set(leaseId, updated);
    return updated;
  }

  getPaneCliCodexThreadOwnership(codexThreadId: string): PaneCliCodexThreadOwnership | null {
    return this.paneCliCodexThreadOwnerships.get(codexThreadId) ?? null;
  }

  claimPaneCliCodexThread(
    sessionId: string,
    codexThreadId: string,
    source: Exclude<PaneCliCodexThreadOwnershipSource, "MIGRATION">,
    _traceId = makeSpaceId("trace")
  ): PaneCliCodexThreadOwnership {
    const session = this.paneCliSessions.get(sessionId);
    if (!session) throw new SpaceNotFoundError(`CLI session ${sessionId} was not found.`);
    const current = this.paneCliCodexThreadOwnerships.get(codexThreadId);
    if (source === "AUTO" && current && current.cliSessionId !== sessionId) {
      throw new SpaceConflictError(
        `Codex thread ${codexThreadId} is permanently owned by CLI session ${current.cliSessionId}; use explicit history resume to transfer it.`
      );
    }
    const timestamp = nowIso();
    if (source === "HISTORY_TRANSFER" && session.cliTaskRevisionId) {
      const nativeOwner = this.getCliTaskRevisionByNativeRef(session.runtimeId, codexThreadId);
      if (nativeOwner && nativeOwner.revisionId !== session.cliTaskRevisionId) {
        this.updateCliTaskRevision(nativeOwner.revisionId, { nativeTaskRef: null });
      }
    }
    for (const [existingSessionId, existing] of this.paneCliSessions.entries()) {
      if (existingSessionId !== sessionId && existing.codexThreadId === codexThreadId) {
        this.paneCliSessions.set(existingSessionId, { ...existing, codexThreadId: null, updatedAt: timestamp });
      }
    }
    const updatedSession = this.updatePaneCliSession(sessionId, { codexThreadId });
    if (source === "AUTO" && session.codexThreadId && session.codexThreadId !== codexThreadId) {
      const replacedOwnership = this.paneCliCodexThreadOwnerships.get(session.codexThreadId);
      if (replacedOwnership?.source === "HISTORY_TRANSFER" && replacedOwnership.cliSessionId === sessionId) {
        this.paneCliCodexThreadOwnerships.delete(session.codexThreadId);
      }
    }
    const ownership = paneCliCodexThreadOwnershipSchema.parse({
      threadId: codexThreadId,
      roomId: updatedSession.roomId,
      paneId: updatedSession.paneId,
      cliSessionId: updatedSession.sessionId,
      source,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    this.paneCliCodexThreadOwnerships.set(codexThreadId, ownership);
    return ownership;
  }

  createPaneCliSession(input: CreatePaneCliSessionInput, _traceId = makeSpaceId("trace")): PaneCliSession {
    const parsed = createPaneCliSessionInputSchema.parse(input);
    const pane = this.panes.get(parsed.paneId);
    if (!pane || pane.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
    }
    if (pane.mode !== "TERMINAL") {
      throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; CLI sessions require TERMINAL panes.`);
    }
    if (pane.isClosed) {
      throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
    }
    if (!this.rooms.has(parsed.roomId)) {
      throw new SpaceNotFoundError(`Room ${parsed.roomId} was not found.`);
    }
    const timestamp = nowIso();
    const sessionId = parsed.sessionId ?? makeSpaceId("cli_session");
    const cliTaskId = parsed.purpose === "NORMAL" ? parsed.cliTaskId ?? sessionId : null;
    const cliTaskRevisionId = parsed.purpose === "NORMAL" ? parsed.cliTaskRevisionId ?? sessionId : null;
    const sourceRevisionId = parsed.cliTaskId
      ? this.cliTasks.get(parsed.cliTaskId)?.currentRevisionId ?? null
      : null;
    if (cliTaskId && parsed.cliTaskId && !this.cliTasks.has(cliTaskId)) {
      throw new SpaceNotFoundError(`CLI task ${cliTaskId} was not found.`);
    }
    if (cliTaskRevisionId && parsed.cliTaskRevisionId) {
      const revision = this.cliTaskRevisions.get(cliTaskRevisionId);
      if (!revision || revision.taskId !== cliTaskId) {
        throw new SpaceConflictError("CLI task revision does not belong to the selected logical task.");
      }
    }
    const session = paneCliSessionSchema.parse({
      ...parsed,
      sessionId,
      modelId: parsed.modelId ?? null,
      cwd: parsed.cwd ?? null,
      codexThreadId: parsed.codexThreadId ?? null,
      cliTaskId,
      cliTaskRevisionId,
      status: parsed.status ?? "IDLE",
      statusReason: parsed.statusReason ?? null,
      exitCode: null,
      isActive: parsed.isActive ?? true,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null
    });
    if (session.isActive) {
      for (const [sessionId, existing] of this.paneCliSessions.entries()) {
        if (existing.paneId === session.paneId && existing.sessionId !== session.sessionId && existing.isActive) {
          this.paneCliSessions.set(sessionId, { ...existing, isActive: false, updatedAt: timestamp });
        }
      }
    }
    if (session.isActive && session.codexThreadId) {
      this.assertActiveCodexThreadAvailable(session.sessionId, session.codexThreadId);
    }
    this.paneCliSessions.set(session.sessionId, session);
    if (session.purpose === "NORMAL" && cliTaskId && cliTaskRevisionId) {
      this.hiddenPaneCliTaskIds.delete(cliTaskId);
      let revision = this.cliTaskRevisions.get(cliTaskRevisionId);
      if (!revision) {
        revision = this.createCliTaskRevision({
          revisionId: cliTaskRevisionId,
          taskId: cliTaskId,
          runtimeId: session.runtimeId,
          providerId: session.providerId,
          agentId: session.agentId,
          nativeTaskRef: session.codexThreadId,
          sourceRevisionId,
          displayTitle: pane.title,
          firstUserMessage: "",
          preview: "",
          cwd: session.cwd,
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort
        });
      }
      this.updateCliTaskRevision(revision.revisionId, {
        latestSpaceSessionId: session.sessionId,
        ...(session.codexThreadId ? { nativeTaskRef: session.codexThreadId } : {})
      });
    }
    return session;
  }

  updatePaneCliSession(
    sessionId: string,
    input: UpdatePaneCliSessionInput,
    _traceId = makeSpaceId("trace")
  ): PaneCliSession {
    const current = this.paneCliSessions.get(sessionId);
    if (!current) {
      throw new SpaceNotFoundError(`CLI session ${sessionId} was not found.`);
    }
    const parsed = updatePaneCliSessionInputSchema.parse(input);
    const timestamp = nowIso();
    const terminal = parsed.status === "EXITED" || parsed.status === "ERROR";
    const updated = paneCliSessionSchema.parse({
      ...current,
      ...parsed,
      statusReason: parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
      exitCode: parsed.exitCode === undefined ? current.exitCode : parsed.exitCode,
      isActive: parsed.isActive === undefined ? current.isActive : parsed.isActive,
      codexThreadId: parsed.codexThreadId === undefined ? current.codexThreadId : parsed.codexThreadId,
      cliTaskId: parsed.cliTaskId === undefined ? current.cliTaskId : parsed.cliTaskId,
      cliTaskRevisionId:
        parsed.cliTaskRevisionId === undefined ? current.cliTaskRevisionId : parsed.cliTaskRevisionId,
      updatedAt: timestamp,
      endedAt: parsed.endedAt === undefined ? (terminal ? timestamp : current.endedAt) : parsed.endedAt
    });
    if (updated.isActive) {
      for (const [existingSessionId, existing] of this.paneCliSessions.entries()) {
        if (existing.paneId === updated.paneId && existing.sessionId !== updated.sessionId && existing.isActive) {
          this.paneCliSessions.set(existingSessionId, { ...existing, isActive: false, updatedAt: timestamp });
        }
      }
    }
    if (updated.isActive && updated.codexThreadId) {
      this.assertActiveCodexThreadAvailable(updated.sessionId, updated.codexThreadId);
    }
    this.paneCliSessions.set(sessionId, updated);
    if (
      updated.cliTaskId &&
      updated.cliTaskRevisionId &&
      this.cliTasks.get(updated.cliTaskId)?.currentRevisionId === updated.cliTaskRevisionId
    ) {
      this.updateCliTaskRevision(updated.cliTaskRevisionId, {
        latestSpaceSessionId: updated.sessionId,
        ...(updated.codexThreadId ? { nativeTaskRef: updated.codexThreadId } : {})
      });
    }
    return updated;
  }

  touchPaneCliSessionActivity(
    sessionId: string,
    _traceId = makeSpaceId("trace")
  ): void {
    const current = this.paneCliSessions.get(sessionId);
    if (!current || current.status !== "RUNNING") return;
    this.paneCliSessions.set(sessionId, { ...current, updatedAt: nowIso() });
  }

  appendPaneCliTranscriptChunk(
    input: CreatePaneCliTranscriptChunkInput,
    _traceId = makeSpaceId("trace")
  ): PaneCliTranscriptChunk {
    const parsed = createPaneCliTranscriptChunkInputSchema.parse(input);
    const session = this.paneCliSessions.get(parsed.sessionId);
    const pane = this.panes.get(parsed.paneId);
    if (!session || session.paneId !== parsed.paneId || !pane) {
      throw new SpaceNotFoundError(`CLI session ${parsed.sessionId} was not found.`);
    }
    const byteLength = parsed.byteLength ?? Buffer.byteLength(parsed.content, "utf8");
    const chunk = paneCliTranscriptChunkSchema.parse({
      ...parsed,
      roomId: pane.roomId,
      chunkId: parsed.chunkId ?? makeSpaceId("cli_chunk"),
      byteLength,
      createdAt: nowIso()
    });
    this.paneCliTranscriptChunks.set(chunk.chunkId, chunk);
    if (session.cliTaskRevisionId && chunk.stream !== "system") {
      const revision = this.cliTaskRevisions.get(session.cliTaskRevisionId);
      if (revision) {
        this.updateCliTaskRevision(revision.revisionId, chunk.stream === "stdin"
          ? {
              firstUserMessage: revision.firstUserMessage || chunk.content.trim(),
              preview: revision.preview || chunk.content.trim()
            }
          : { preview: chunk.content.trim() || revision.preview });
      }
    }
    const chunks = [...this.paneCliTranscriptChunks.values()]
      .filter((candidate) => candidate.sessionId === chunk.sessionId)
      .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
    const overflow = chunks.length - PANE_CLI_TRANSCRIPT_CHUNK_CAP;
    if (overflow > 0) {
      for (const stale of chunks.slice(0, overflow)) {
        this.paneCliTranscriptChunks.delete(stale.chunkId);
      }
    }
    return chunk;
  }

  appendPaneCliTranscriptChunkAtNextSequence(
    input: Omit<CreatePaneCliTranscriptChunkInput, "sequence">,
    traceId = makeSpaceId("trace")
  ): PaneCliTranscriptChunk {
    const parsed = createPaneCliTranscriptChunkInputSchema.parse({ ...input, sequence: 0 });
    const sequence = this.listPaneCliTranscriptChunks(parsed.sessionId).reduce(
      (maximum, chunk) => Math.max(maximum, chunk.sequence),
      -1
    ) + 1;
    return this.appendPaneCliTranscriptChunk({ ...parsed, sequence }, traceId);
  }

  appendPaneCliHostOutputChunk(
    input: CreatePaneCliHostOutputInput,
    traceId = makeSpaceId("trace")
  ): PaneCliTranscriptChunk {
    const parsed = createPaneCliHostOutputInputSchema.parse(input);
    const existing = [...this.paneCliTranscriptChunks.values()].find(
      (chunk) =>
        chunk.sessionId === parsed.sessionId &&
        chunk.hostGenerationId === parsed.generationId &&
        chunk.hostOutputSequence === parsed.outputSequence
    );
    if (existing) return existing;
    const sequence = this.listPaneCliTranscriptChunks(parsed.sessionId).reduce(
      (maximum, chunk) => Math.max(maximum, chunk.sequence),
      -1
    ) + 1;
    return this.appendPaneCliTranscriptChunk(
      {
        sessionId: parsed.sessionId,
        paneId: parsed.paneId,
        roomId: parsed.roomId,
        sequence,
        stream: parsed.stream,
        content: parsed.content,
        byteLength: parsed.byteLength,
        hostGenerationId: parsed.generationId,
        hostOutputSequence: parsed.outputSequence
      },
      traceId
    );
  }

  getPaneCliHostOutputCursor(sessionId: string, generationId: string): number {
    if (!this.paneCliSessions.has(sessionId)) throw new SpaceNotFoundError(`CLI session ${sessionId} was not found.`);
    return [...this.paneCliTranscriptChunks.values()]
      .filter((chunk) => chunk.sessionId === sessionId && chunk.hostGenerationId === generationId)
      .reduce((maximum, chunk) => Math.max(maximum, chunk.hostOutputSequence ?? -1), -1);
  }

  listPaneCliTranscriptChunks(sessionId: string, limit = PANE_CLI_TRANSCRIPT_CHUNK_CAP): PaneCliTranscriptChunk[] {
    if (!this.paneCliSessions.has(sessionId)) {
      throw new SpaceNotFoundError(`CLI session ${sessionId} was not found.`);
    }
    const cappedLimit = Math.max(0, Math.min(Math.trunc(limit), PANE_CLI_TRANSCRIPT_CHUNK_CAP));
    const chunks = [...this.paneCliTranscriptChunks.values()]
      .filter((chunk) => chunk.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt));
    return cappedLimit === 0 ? [] : chunks.slice(-cappedLimit);
  }

  listManagedCodexThreadIds(): string[] {
    return [...new Set([
      ...this.paneCliCodexThreadOwnerships.keys(),
      ...[...this.spaceAgentSessions.values()]
        .map((session) => session.threadId)
        .filter((threadId): threadId is string => Boolean(threadId))
    ])].sort();
  }

  listActiveManagedCodexThreadIds(): string[] {
    return [...new Set([
      ...[...this.paneCliSessions.values()]
        .filter((session) => session.isActive)
        .map((session) => session.codexThreadId)
        .filter((threadId): threadId is string => Boolean(threadId)),
      ...[...this.spaceAgentSessions.values()]
        .filter((session) => session.isActive)
        .map((session) => session.threadId)
        .filter((threadId): threadId is string => Boolean(threadId))
    ])].sort();
  }

  createCodexCliTurnMarker(input: CreateCodexCliTurnMarkerInput): CodexCliTurnMarkerRecord {
    const session = this.paneCliSessions.get(input.sessionId);
    if (!session || session.roomId !== input.roomId || session.paneId !== input.paneId) {
      throw new SpaceNotFoundError(`CLI session ${input.sessionId} was not found.`);
    }
    const existing = [...this.codexCliTurnMarkers.values()].find(
      (marker) => marker.sessionId === input.sessionId && marker.clientTurnMarker === input.clientTurnMarker
    );
    if (existing) return existing;
    const marker: CodexCliTurnMarkerRecord = {
      markerId: makeSpaceId("codex_cli_turn"),
      sessionId: input.sessionId,
      roomId: input.roomId,
      paneId: input.paneId,
      clientTurnMarker: input.clientTurnMarker,
      status: "PENDING",
      codexThreadId: session.codexThreadId,
      rolloutPath: null,
      completionEventId: null,
      submittedAt: input.submittedAt,
      completedAt: null,
      nextCheckAt: input.submittedAt,
      checkAttemptCount: 0,
      lockedAt: null,
      lockedBy: null,
      safeErrorCode: null,
      updatedAt: input.submittedAt
    };
    this.codexCliTurnMarkers.set(marker.markerId, marker);
    return marker;
  }

  claimCodexCliTurnMarkers(input: {
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }): CodexCliTurnMarkerRecord[] {
    for (const [markerId, marker] of this.codexCliTurnMarkers) {
      if (marker.status === "PROCESSING" && marker.lockedAt && marker.lockedAt < input.staleBefore) {
        this.codexCliTurnMarkers.set(markerId, {
          ...marker,
          status: "PENDING",
          lockedAt: null,
          lockedBy: null,
          safeErrorCode: "CODEX_CLI_MARKER_STALE_LOCK_RECOVERED",
          updatedAt: input.now
        });
      }
    }
    const markers = [...this.codexCliTurnMarkers.values()]
      .filter((marker) => marker.status === "PENDING" && marker.nextCheckAt <= input.now)
      .sort((left, right) => left.nextCheckAt.localeCompare(right.nextCheckAt) || left.submittedAt.localeCompare(right.submittedAt))
      .slice(0, Math.max(1, Math.min(input.limit, 50)));
    return markers.map((marker) => {
      const claimed = {
        ...marker,
        status: "PROCESSING" as const,
        checkAttemptCount: marker.checkAttemptCount + 1,
        lockedAt: input.now,
        lockedBy: input.workerId,
        updatedAt: input.now
      };
      this.codexCliTurnMarkers.set(marker.markerId, claimed);
      return claimed;
    });
  }

  deferCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    codexThreadId?: string | null;
    rolloutPath?: string | null;
    nextCheckAt: string;
    safeErrorCode?: string | null;
    now: string;
  }): void {
    const marker = this.codexCliTurnMarkers.get(input.markerId);
    if (!marker || marker.status !== "PROCESSING" || marker.lockedBy !== input.workerId) return;
    this.codexCliTurnMarkers.set(input.markerId, {
      ...marker,
      status: "PENDING",
      codexThreadId: input.codexThreadId === undefined ? marker.codexThreadId : input.codexThreadId,
      rolloutPath: input.rolloutPath === undefined ? marker.rolloutPath : input.rolloutPath,
      nextCheckAt: input.nextCheckAt,
      lockedAt: null,
      lockedBy: null,
      safeErrorCode: input.safeErrorCode ?? null,
      updatedAt: input.now
    });
  }

  completeCodexCliTurnMarker(input: CompleteCodexCliTurnMarkerInput): CodexCliTurnMarkerRecord {
    const marker = this.codexCliTurnMarkers.get(input.markerId);
    if (!marker || marker.status !== "PROCESSING" || marker.lockedBy !== input.workerId) {
      throw new SpaceConflictError(`Codex CLI turn marker ${input.markerId} is not claimed by this worker.`);
    }
    const event = this.appendEvent({
      roomId: marker.roomId,
      paneId: marker.paneId,
      turnId: null,
      workflowId: null,
      traceId: input.traceId,
      type: "TURN_COMPLETED",
      message: "Codex terminal turn completed.",
      payload: {
        status: "COMPLETED",
        sourceType: "TERMINAL",
        markerId: marker.markerId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId
      }
    });
    const completed: CodexCliTurnMarkerRecord = {
      ...marker,
      status: "COMPLETED",
      codexThreadId: input.codexThreadId,
      rolloutPath: input.rolloutPath,
      completionEventId: event.id,
      completedAt: input.completedAt,
      lockedAt: null,
      lockedBy: null,
      safeErrorCode: null,
      updatedAt: input.completedAt
    };
    this.codexCliTurnMarkers.set(marker.markerId, completed);
    return completed;
  }

  finishCodexCliTurnMarker(input: {
    markerId: string;
    workerId: string;
    status: "IGNORED" | "FAILED";
    safeErrorCode: string;
    now: string;
  }): void {
    const marker = this.codexCliTurnMarkers.get(input.markerId);
    if (!marker || marker.status !== "PROCESSING" || marker.lockedBy !== input.workerId) return;
    this.codexCliTurnMarkers.set(input.markerId, {
      ...marker,
      status: input.status,
      lockedAt: null,
      lockedBy: null,
      safeErrorCode: input.safeErrorCode,
      updatedAt: input.now
    });
  }

  getActivePaneBrowserSession(paneId: string): PaneBrowserSession | null {
    return [...this.paneBrowserSessions.values()].find((session) => session.paneId === paneId && session.isActive) ?? null;
  }

  getPaneBrowserSession(sessionId: string): PaneBrowserSession | null {
    return this.paneBrowserSessions.get(sessionId) ?? null;
  }

  getLatestPaneBrowserSession(paneId: string): PaneBrowserSession | null {
    return (
      [...this.paneBrowserSessions.values()]
        .filter((session) => session.paneId === paneId)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))[0] ?? null
    );
  }

  listActivePaneBrowserSessions(roomId?: string): PaneBrowserSession[] {
    return [...this.paneBrowserSessions.values()]
      .filter((session) => session.isActive && (!roomId || session.roomId === roomId))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  createPaneBrowserSession(input: CreatePaneBrowserSessionInput, _traceId = makeSpaceId("trace")): PaneBrowserSession {
    const parsed = createPaneBrowserSessionInputSchema.parse(input);
    const pane = this.panes.get(parsed.paneId);
    if (!pane || pane.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Pane ${parsed.paneId} was not found.`);
    }
    if (pane.mode !== "BROWSER" && pane.mode !== "YOUTUBE") {
      throw new SpaceConflictError(`Pane ${pane.id} is ${pane.mode}; browser sessions require BROWSER or YOUTUBE panes.`);
    }
    if (pane.isClosed) {
      throw new SpaceConflictError(`Pane ${pane.id} is closed.`);
    }
    if (!this.rooms.has(parsed.roomId)) {
      throw new SpaceNotFoundError(`Room ${parsed.roomId} was not found.`);
    }
    const timestamp = nowIso();
    const session = paneBrowserSessionSchema.parse({
      ...parsed,
      sessionId: parsed.sessionId ?? makeSpaceId("browser_session"),
      ownerAgentId: parsed.ownerAgentId ?? null,
      targetUrl: parsed.targetUrl ?? null,
      currentUrl: parsed.currentUrl ?? null,
      title: parsed.title ?? null,
      status: parsed.status ?? "STARTING",
      statusReason: parsed.statusReason ?? null,
      lastFrameAt: null,
      isActive: parsed.isActive ?? true,
      startedAt: timestamp,
      updatedAt: timestamp,
      endedAt: null
    });
    if (session.isActive) {
      for (const [sessionId, existing] of this.paneBrowserSessions.entries()) {
        if (existing.paneId === session.paneId && existing.sessionId !== session.sessionId && existing.isActive) {
          this.paneBrowserSessions.set(sessionId, { ...existing, isActive: false, status: "CLOSED", updatedAt: timestamp, endedAt: timestamp });
        }
      }
    }
    this.paneBrowserSessions.set(session.sessionId, session);
    return session;
  }

  updatePaneBrowserSession(
    sessionId: string,
    input: UpdatePaneBrowserSessionInput,
    _traceId = makeSpaceId("trace")
  ): PaneBrowserSession {
    const current = this.paneBrowserSessions.get(sessionId);
    if (!current) {
      throw new SpaceNotFoundError(`Browser session ${sessionId} was not found.`);
    }
    const parsed = updatePaneBrowserSessionInputSchema.parse(input);
    const timestamp = nowIso();
    const terminal = parsed.status === "CLOSED" || parsed.status === "ERROR";
    const updated = paneBrowserSessionSchema.parse({
      ...current,
      ...parsed,
      targetUrl: parsed.targetUrl === undefined ? current.targetUrl : parsed.targetUrl,
      currentUrl: parsed.currentUrl === undefined ? current.currentUrl : parsed.currentUrl,
      title: parsed.title === undefined ? current.title : parsed.title,
      statusReason: parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
      lastFrameAt: parsed.lastFrameAt === undefined ? current.lastFrameAt : parsed.lastFrameAt,
      isActive: parsed.isActive === undefined ? current.isActive : parsed.isActive,
      updatedAt: timestamp,
      endedAt: parsed.endedAt === undefined ? (terminal ? timestamp : current.endedAt) : parsed.endedAt
    });
    if (updated.isActive) {
      for (const [existingSessionId, existing] of this.paneBrowserSessions.entries()) {
        if (existing.paneId === updated.paneId && existing.sessionId !== updated.sessionId && existing.isActive) {
          this.paneBrowserSessions.set(existingSessionId, {
            ...existing,
            isActive: false,
            status: "CLOSED",
            updatedAt: timestamp,
            endedAt: timestamp
          });
        }
      }
    }
    this.paneBrowserSessions.set(sessionId, updated);
    return updated;
  }

  getActiveBrowserControlLease(sessionId: string): BrowserControlLease | null {
    const timestamp = nowIso();
    const active = [...this.browserControlLeases.values()].find(
      (lease) => lease.sessionId === sessionId && lease.status === "ACTIVE"
    );
    if (!active) return null;
    if (active.expiresAt > timestamp) return active;
    this.updateBrowserControlLease(active.leaseId, { status: "EXPIRED" });
    return null;
  }

  getBrowserControlLease(leaseId: string): BrowserControlLease | null {
    return this.browserControlLeases.get(leaseId) ?? null;
  }

  createBrowserControlLease(input: CreateBrowserControlLeaseInput): BrowserControlLease {
    const parsed = createBrowserControlLeaseInputSchema.parse(input);
    const session = this.paneBrowserSessions.get(parsed.sessionId);
    if (!session || session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
    }
    const timestamp = nowIso();
    for (const [leaseId, current] of this.browserControlLeases.entries()) {
      if (current.sessionId === parsed.sessionId && current.status === "ACTIVE") {
        this.browserControlLeases.set(leaseId, {
          ...current,
          status: current.expiresAt <= timestamp ? "EXPIRED" : "REVOKED",
          releasedAt: timestamp
        });
      }
    }
    const lease = browserControlLeaseSchema.parse({
      leaseId: parsed.leaseId ?? makeSpaceId("browser_lease"),
      sessionId: parsed.sessionId,
      paneId: parsed.paneId,
      roomId: parsed.roomId,
      holderType: parsed.holderType,
      holderId: parsed.holderId,
      status: "ACTIVE",
      reason: parsed.reason ?? null,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString(),
      releasedAt: null
    });
    this.browserControlLeases.set(lease.leaseId, lease);
    this.updatePaneBrowserSession(session.sessionId, {
      controlState: lease.holderType === "OPERATOR" ? "OPERATOR" : "AGENT"
    });
    return lease;
  }

  updateBrowserControlLease(leaseId: string, input: UpdateBrowserControlLeaseInput): BrowserControlLease {
    const current = this.browserControlLeases.get(leaseId);
    if (!current) throw new SpaceNotFoundError(`Browser control lease ${leaseId} was not found.`);
    const parsed = updateBrowserControlLeaseInputSchema.parse(input);
    const timestamp = nowIso();
    const status = parsed.status ?? current.status;
    const isTerminal = status !== "ACTIVE";
    const updated = browserControlLeaseSchema.parse({
      ...current,
      status,
      reason: parsed.reason === undefined ? current.reason : parsed.reason,
      heartbeatAt: parsed.ttlSeconds === undefined ? current.heartbeatAt : timestamp,
      expiresAt:
        parsed.ttlSeconds === undefined
          ? current.expiresAt
          : new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString(),
      releasedAt: isTerminal ? current.releasedAt ?? timestamp : null
    });
    this.browserControlLeases.set(leaseId, updated);
    if (isTerminal) {
      const session = this.paneBrowserSessions.get(updated.sessionId);
      if (session && ![...this.browserControlLeases.values()].some(
        (lease) => lease.sessionId === updated.sessionId && lease.leaseId !== leaseId && lease.status === "ACTIVE"
      )) {
        this.updatePaneBrowserSession(updated.sessionId, { controlState: "UNCONTROLLED" });
      }
    }
    return updated;
  }

  getBrowserCaptureJob(jobId: string): BrowserCaptureJob | null {
    return this.browserCaptureJobs.get(jobId) ?? null;
  }

  listBrowserCaptureJobs(sessionId: string): BrowserCaptureJob[] {
    return [...this.browserCaptureJobs.values()]
      .filter((job) => job.sessionId === sessionId)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }

  getBrowserCaptureMetrics(): BrowserCaptureMetrics {
    const metrics: BrowserCaptureMetrics = {
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
    };
    const activeSessionIds = new Set(
      [...this.paneBrowserSessions.values()].filter((session) => session.isActive).map((session) => session.sessionId)
    );
    const activeJobs = [...this.browserCaptureJobs.values()].filter((job) => activeSessionIds.has(job.sessionId));
    const activeJobIds = new Set(activeJobs.map((job) => job.jobId));
    for (const job of activeJobs) metrics.jobs[job.status] += 1;
    for (const segment of this.browserCaptureSegments.values()) {
      if (activeJobIds.has(segment.jobId)) metrics.segments[segment.status] += 1;
    }
    return metrics;
  }

  createBrowserCaptureJob(input: CreateBrowserCaptureJobInput): BrowserCaptureJob {
    const parsed = createBrowserCaptureJobInputSchema.parse(input);
    const session = this.paneBrowserSessions.get(parsed.sessionId);
    if (!session || session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
    }
    const timestamp = nowIso();
    const job = browserCaptureJobSchema.parse({
      ...parsed,
      jobId: parsed.jobId ?? makeSpaceId("browser_capture"),
      status: "QUEUED",
      progressPercent: 0,
      statusReason: null,
      artifactIds: [],
      queuedAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null
    });
    this.browserCaptureJobs.set(job.jobId, job);
    return job;
  }

  updateBrowserCaptureJob(jobId: string, input: UpdateBrowserCaptureJobInput): BrowserCaptureJob {
    const current = this.browserCaptureJobs.get(jobId);
    if (!current) throw new SpaceNotFoundError(`Browser capture job ${jobId} was not found.`);
    const parsed = updateBrowserCaptureJobInputSchema.parse(input);
    const timestamp = nowIso();
    const status = parsed.status ?? current.status;
    const isTerminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
    const updated = browserCaptureJobSchema.parse({
      ...current,
      ...parsed,
      status,
      progressPercent: parsed.progressPercent ?? (status === "COMPLETED" ? 100 : current.progressPercent),
      statusReason: parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
      artifactIds: parsed.artifactIds === undefined ? current.artifactIds : Array.from(new Set(parsed.artifactIds)),
      startedAt: parsed.startedAt === undefined ? (status === "RUNNING" ? current.startedAt ?? timestamp : current.startedAt) : parsed.startedAt,
      updatedAt: timestamp,
      completedAt: parsed.completedAt === undefined ? (isTerminal ? current.completedAt ?? timestamp : current.completedAt) : parsed.completedAt
    });
    this.browserCaptureJobs.set(jobId, updated);
    return updated;
  }

  getBrowserCaptureSegment(segmentId: string): BrowserCaptureSegment | null {
    return this.browserCaptureSegments.get(segmentId) ?? null;
  }

  listBrowserCaptureSegments(jobId: string): BrowserCaptureSegment[] {
    return [...this.browserCaptureSegments.values()]
      .filter((segment) => segment.jobId === jobId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  createBrowserCaptureSegment(input: CreateBrowserCaptureSegmentInput): BrowserCaptureSegment {
    const parsed = createBrowserCaptureSegmentInputSchema.parse(input);
    const job = this.browserCaptureJobs.get(parsed.jobId);
    if (!job || job.sessionId !== parsed.sessionId) {
      throw new SpaceNotFoundError(`Browser capture job ${parsed.jobId} was not found.`);
    }
    if (job.options.kind !== "RECORDING") {
      throw new SpaceConflictError(`Browser capture job ${parsed.jobId} does not support recording segments.`);
    }
    const sequence = parsed.sequence ?? this.listBrowserCaptureSegments(parsed.jobId).reduce(
      (maximum, segment) => Math.max(maximum, segment.sequence),
      -1
    ) + 1;
    if (this.listBrowserCaptureSegments(parsed.jobId).some((segment) => segment.sequence === sequence)) {
      throw new SpaceConflictError(`Browser capture segment sequence ${sequence} already exists for job ${parsed.jobId}.`);
    }
    const timestamp = nowIso();
    const segment = browserCaptureSegmentSchema.parse({
      segmentId: parsed.segmentId ?? makeSpaceId("browser_segment"),
      jobId: parsed.jobId,
      sessionId: parsed.sessionId,
      sequence,
      status: "OPEN",
      artifactId: null,
      storageUri: null,
      sha256: null,
      byteSize: 0,
      durationMs: 0,
      frameCount: 0,
      lastFrameSequence: null,
      statusReason: null,
      startedAt: timestamp,
      updatedAt: timestamp,
      finalizedAt: null
    });
    this.browserCaptureSegments.set(segment.segmentId, segment);
    return segment;
  }

  updateBrowserCaptureSegment(
    segmentId: string,
    input: UpdateBrowserCaptureSegmentInput
  ): BrowserCaptureSegment {
    const current = this.browserCaptureSegments.get(segmentId);
    if (!current) throw new SpaceNotFoundError(`Browser capture segment ${segmentId} was not found.`);
    const parsed = updateBrowserCaptureSegmentInputSchema.parse(input);
    const status = parsed.status ?? current.status;
    if (current.status !== "OPEN" && status !== current.status && !(current.status === "FINALIZED" && status === "DISCARDED")) {
      throw new SpaceConflictError(`Browser capture segment cannot transition from ${current.status} to ${status}.`);
    }
    const timestamp = nowIso();
    const isTerminal = status !== "OPEN";
    const updated = browserCaptureSegmentSchema.parse({
      ...current,
      ...parsed,
      status,
      artifactId: parsed.artifactId === undefined ? current.artifactId : parsed.artifactId,
      storageUri: parsed.storageUri === undefined ? current.storageUri : parsed.storageUri,
      sha256: parsed.sha256 === undefined ? current.sha256 : parsed.sha256,
      lastFrameSequence: parsed.lastFrameSequence === undefined ? current.lastFrameSequence : parsed.lastFrameSequence,
      statusReason: parsed.statusReason === undefined ? current.statusReason : parsed.statusReason,
      updatedAt: timestamp,
      finalizedAt:
        parsed.finalizedAt === undefined ? (isTerminal ? current.finalizedAt ?? timestamp : null) : parsed.finalizedAt
    });
    this.browserCaptureSegments.set(segmentId, updated);
    return updated;
  }

  getActiveBrowserHandoffRequest(sessionId: string): BrowserHandoffRequest | null {
    const timestamp = nowIso();
    const active = [...this.browserHandoffRequests.values()].find(
      (handoff) => handoff.sessionId === sessionId && (handoff.status === "REQUESTED" || handoff.status === "ACCEPTED")
    );
    if (!active) return null;
    if (active.expiresAt > timestamp) return active;
    this.updateBrowserHandoffRequest(active.handoffRequestId, { status: "EXPIRED" });
    return null;
  }

  getBrowserHandoffRequest(handoffRequestId: string): BrowserHandoffRequest | null {
    return this.browserHandoffRequests.get(handoffRequestId) ?? null;
  }

  listBrowserHandoffRequests(roomId?: string): BrowserHandoffRequest[] {
    return [...this.browserHandoffRequests.values()]
      .filter((handoff) => !roomId || handoff.roomId === roomId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  createBrowserHandoffRequest(input: CreateBrowserHandoffRequestInput): BrowserHandoffRequest {
    const parsed = createBrowserHandoffRequestInputSchema.parse(input);
    const session = this.paneBrowserSessions.get(parsed.sessionId);
    if (!session || session.paneId !== parsed.paneId || session.roomId !== parsed.roomId) {
      throw new SpaceNotFoundError(`Browser session ${parsed.sessionId} was not found.`);
    }
    if (this.getActiveBrowserHandoffRequest(parsed.sessionId)) {
      throw new SpaceConflictError(`Browser session ${parsed.sessionId} already has an active handoff request.`);
    }
    const timestamp = nowIso();
    const handoff = browserHandoffRequestSchema.parse({
      handoffRequestId: parsed.handoffRequestId ?? makeSpaceId("browser_handoff"),
      sessionId: parsed.sessionId,
      paneId: parsed.paneId,
      roomId: parsed.roomId,
      requestedByType: parsed.requestedByType,
      requestedById: parsed.requestedById,
      reason: parsed.reason,
      status: "REQUESTED",
      operatorUserId: null,
      operatorEmail: null,
      operatorRole: null,
      controlLeaseId: null,
      requestedAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + parsed.ttlSeconds * 1000).toISOString(),
      acceptedAt: null,
      completedAt: null,
      expiredAt: null,
      cancelledAt: null,
      updatedAt: timestamp
    });
    this.browserHandoffRequests.set(handoff.handoffRequestId, handoff);
    this.appendEvent({
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
  }

  updateBrowserHandoffRequest(
    handoffRequestId: string,
    input: UpdateBrowserHandoffRequestInput
  ): BrowserHandoffRequest {
    const current = this.browserHandoffRequests.get(handoffRequestId);
    if (!current) throw new SpaceNotFoundError(`Browser handoff request ${handoffRequestId} was not found.`);
    const parsed = updateBrowserHandoffRequestInputSchema.parse(input);
    assertBrowserHandoffTransition(current.status, parsed.status);
    if (parsed.status === "ACCEPTED") {
      const operator = parsed.operatorUserId ? this.users.get(parsed.operatorUserId) : null;
      if (!operator) {
        throw new SpaceNotFoundError(`Authenticated operator ${parsed.operatorUserId ?? "unknown"} was not found.`);
      }
      if (operator.email !== parsed.operatorEmail || operator.role !== parsed.operatorRole) {
        throw new SpaceConflictError("Browser handoff operator identity does not match the authenticated user.");
      }
    }
    if (parsed.controlLeaseId) {
      const lease = this.browserControlLeases.get(parsed.controlLeaseId);
      if (!lease || lease.sessionId !== current.sessionId) {
        throw new SpaceNotFoundError(`Browser control lease ${parsed.controlLeaseId} was not found.`);
      }
    }
    const timestamp = nowIso();
    const updated = browserHandoffRequestSchema.parse({
      ...current,
      status: parsed.status,
      reason: parsed.reason ?? current.reason,
      operatorUserId: parsed.operatorUserId ?? current.operatorUserId,
      operatorEmail: parsed.operatorEmail ?? current.operatorEmail,
      operatorRole: parsed.operatorRole ?? current.operatorRole,
      controlLeaseId: parsed.controlLeaseId === undefined ? current.controlLeaseId : parsed.controlLeaseId,
      acceptedAt: parsed.status === "ACCEPTED" ? current.acceptedAt ?? timestamp : current.acceptedAt,
      completedAt: parsed.status === "COMPLETED" ? current.completedAt ?? timestamp : current.completedAt,
      expiredAt: parsed.status === "EXPIRED" ? current.expiredAt ?? timestamp : current.expiredAt,
      cancelledAt: parsed.status === "CANCELLED" ? current.cancelledAt ?? timestamp : current.cancelledAt,
      updatedAt: timestamp
    });
    this.browserHandoffRequests.set(handoffRequestId, updated);
    return updated;
  }

  recordTurnQueued(input: CreateQueuedTurnInput): QueuedTurnRecord {
    this.getRoom(input.roomId);
    const pane = this.panes.get(input.paneId);
    if (!pane || pane.roomId !== input.roomId) {
      throw new SpaceNotFoundError(`Pane ${input.paneId} was not found.`);
    }

    const timestamp = nowIso();
    const artifactIds = Array.from(new Set(input.artifactIds ?? []));
    const missingArtifactId = artifactIds.find((artifactId) => !this.artifacts.some((artifact) => artifact.id === artifactId));
    if (missingArtifactId) {
      throw new SpaceNotFoundError(`Artifact ${missingArtifactId} was not found.`);
    }
    const workflow: WorkflowRun = {
      workflowId: input.workflowId,
      runId: input.runId,
      type: "AGENT_TURN",
      taskQueue: input.taskQueue,
      status: "PENDING",
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      startedAt: timestamp,
      closedAt: null
    };
    const turn: Turn = {
      id: makeSpaceId("turn"),
      roomId: input.roomId,
      paneId: input.paneId,
      workflowId: input.workflowId,
      providerId: input.providerId,
      modelId: input.modelId,
      status: "QUEUED",
      prompt: input.prompt,
      promptHash: hashPrompt(input.prompt),
      artifactIds,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.workflows.set(workflow.workflowId, workflow);
    this.turns.set(turn.id, turn);
    if (artifactIds.length) {
      this.artifacts = this.artifacts.map((artifact) =>
        artifactIds.includes(artifact.id) ? { ...artifact, turnId: turn.id, workflowId: workflow.workflowId } : artifact
      );
    }
    this.panes.set(pane.id, { ...pane, status: "QUEUED", updatedAt: timestamp });
    this.touchRoom(input.roomId, timestamp);
    const event = this.appendEvent({
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
  }

  recordWorkflowRunId(workflowId: string, runId: string | null): WorkflowRun {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new SpaceNotFoundError(`Workflow ${workflowId} was not found.`);
    }
    const updated: WorkflowRun = {
      ...workflow,
      runId
    };
    this.workflows.set(workflowId, updated);
    return updated;
  }

  listTurns(roomId?: string): Turn[] {
    return [...this.turns.values()]
      .filter((turn) => !roomId || turn.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  listTurnsPage(input: ListStorePageInput): StorePageResult<Turn> {
    const order = input.sortOrder === "desc" ? -1 : 1;
    const turns = [...this.turns.values()]
      .filter((turn) => !input.roomId || turn.roomId === input.roomId)
      .sort((left, right) =>
        order * (left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      );
    const start = (input.page - 1) * input.pageSize;
    return { items: turns.slice(start, start + input.pageSize), total: turns.length };
  }

  recordTurnCompleted(input: CompleteTurnInput): CompletedTurnRecord {
    const workflow = this.workflows.get(input.workflowId);
    if (!workflow) {
      throw new SpaceNotFoundError(`Workflow ${input.workflowId} was not found.`);
    }
    const currentTurn = [...this.turns.values()].find((turn) => turn.workflowId === input.workflowId);
    if (!currentTurn) {
      throw new SpaceNotFoundError(`Turn for workflow ${input.workflowId} was not found.`);
    }

    const timestamp = nowIso();
    const completedWorkflow: WorkflowRun = {
      ...workflow,
      status: "COMPLETED",
      closedAt: timestamp
    };
    const completedTurn: Turn = {
      ...currentTurn,
      status: "COMPLETED",
      updatedAt: timestamp
    };

    this.workflows.set(completedWorkflow.workflowId, completedWorkflow);
    this.turns.set(completedTurn.id, completedTurn);
    if (completedTurn.paneId) {
      const pane = this.panes.get(completedTurn.paneId);
      if (pane) {
        this.panes.set(pane.id, { ...pane, status: "COMPLETE", updatedAt: timestamp });
      }
    }
    this.touchRoom(completedTurn.roomId, timestamp);
    const event = this.appendEvent({
      roomId: completedTurn.roomId,
      paneId: completedTurn.paneId,
      turnId: completedTurn.id,
      workflowId: completedWorkflow.workflowId,
      traceId: input.traceId,
      type: "TURN_COMPLETED",
      message: input.message,
      payload: {
        status: completedTurn.status,
        workflowId: completedWorkflow.workflowId,
        runId: completedWorkflow.runId,
        metadata: input.metadata ?? {}
      }
    });

    return { turn: completedTurn, workflow: completedWorkflow, event };
  }

  recordTurnFailed(input: FailTurnInput): FailedTurnRecord {
    const workflow = this.workflows.get(input.workflowId);
    if (!workflow) {
      throw new SpaceNotFoundError(`Workflow ${input.workflowId} was not found.`);
    }
    const currentTurn = [...this.turns.values()].find((turn) => turn.workflowId === input.workflowId);
    if (!currentTurn) {
      throw new SpaceNotFoundError(`Turn for workflow ${input.workflowId} was not found.`);
    }

    const timestamp = nowIso();
    const failedWorkflow: WorkflowRun = {
      ...workflow,
      status: "FAILED",
      closedAt: timestamp
    };
    const failedTurn: Turn = {
      ...currentTurn,
      status: "FAILED",
      updatedAt: timestamp
    };

    this.workflows.set(failedWorkflow.workflowId, failedWorkflow);
    this.turns.set(failedTurn.id, failedTurn);
    if (failedTurn.paneId) {
      const pane = this.panes.get(failedTurn.paneId);
      if (pane) {
        this.panes.set(pane.id, { ...pane, status: "ERROR", updatedAt: timestamp });
      }
    }
    this.touchRoom(failedTurn.roomId, timestamp);
    const event = this.appendEvent({
      roomId: failedTurn.roomId,
      paneId: failedTurn.paneId,
      turnId: failedTurn.id,
      workflowId: failedWorkflow.workflowId,
      traceId: input.traceId,
      type: "TURN_FAILED",
      message: input.message,
      payload: {
        status: failedTurn.status,
        workflowId: failedWorkflow.workflowId,
        runId: failedWorkflow.runId,
        reasonCode: input.reasonCode ?? null,
        metadata: input.metadata ?? {}
      }
    });

    return { turn: failedTurn, workflow: failedWorkflow, event };
  }

  listEvents(roomId?: string): Event[] {
    return this.events.filter((event) => !roomId || event.roomId === roomId);
  }

  getLatestEvent(roomId: string): Event | null {
    let latest: Event | null = null;
    for (const event of this.events) {
      if (event.roomId !== roomId) continue;
      if (!latest || (event.createdAt.localeCompare(latest.createdAt) || event.id.localeCompare(latest.id)) > 0) {
        latest = event;
      }
    }
    return latest;
  }

  listEventsPage(input: ListStorePageInput): StorePageResult<Event> {
    const order = input.sortOrder === "desc" ? -1 : 1;
    const events = this.events
      .filter((event) => !input.roomId || event.roomId === input.roomId)
      .sort((left, right) =>
        order * (left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      );
    const start = (input.page - 1) * input.pageSize;
    return { items: events.slice(start, start + input.pageSize), total: events.length };
  }

  listEventChanges(input: ListEventChangesInput): EventChange[] {
    const limit = Math.max(1, Math.min(input.limit, 500));
    const afterSequence = input.afterSequence === null ? null : BigInt(input.afterSequence);
    const direction = input.sortOrder === "desc" ? -1 : 1;
    return this.events
      .map((event): EventChange => ({ sequence: this.eventRelaySequences.get(event.id)!, event }))
      .filter((change) => afterSequence === null || BigInt(change.sequence) > afterSequence)
      .sort((left, right) => direction * (BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1))
      .slice(0, limit);
  }

  recordAuditEvent(input: CreateAuditEventInput): AuditEvent {
    const auditEvent: AuditEvent = {
      id: makeSpaceId("audit"),
      createdAt: nowIso(),
      ...input,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {}
    };
    this.auditEvents.push(auditEvent);
    return auditEvent;
  }

  listAuditEvents(): AuditEvent[] {
    return [...this.auditEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listProviders(): Provider[] {
    return [...this.providers];
  }

  getProviderSettings(): ProviderSettings {
    return this.providerSettings;
  }

  updateProviderSettings(input: UpdateProviderSettingsInput): ProviderSettings {
    const parsed = updateProviderSettingsInputSchema.parse(input);
    const defaultProviderId = parsed.defaultProviderId ?? this.providerSettings.defaultProviderId;
    if (!this.providers.some((provider) => provider.id === defaultProviderId)) {
      throw new SpaceNotFoundError(`Provider ${defaultProviderId} was not found.`);
    }
    const titleGenerationModelId =
      parsed.titleGenerationModelId === undefined ? this.providerSettings.titleGenerationModelId : parsed.titleGenerationModelId;
    if (titleGenerationModelId && !this.models.some((model) => model.id === titleGenerationModelId)) {
      throw new SpaceNotFoundError(`Model ${titleGenerationModelId} was not found.`);
    }
    this.providerSettings = providerSettingsSchema.parse({
      defaultProviderId,
      titleGenerationModelId,
      titleGenerationReasoningEffort:
        parsed.titleGenerationReasoningEffort ?? this.providerSettings.titleGenerationReasoningEffort ?? defaultTitleGenerationReasoningEffort,
      updatedAt: nowIso()
    });
    return this.providerSettings;
  }

  getCodexCliModeDefaults(): CodexCliModeDefaults {
    if (!this.codexCliModeDefaults) {
      throw new SpaceNotFoundError("Codex CLI mode defaults were not initialized from a provider catalog.");
    }
    return this.codexCliModeDefaults;
  }

  initializeCodexCliModeDefaults(input: CodexCliModeDefaultPairs): CodexCliModeDefaults {
    const parsed = codexCliModeDefaultPairsSchema.parse(input);
    if (this.codexCliModeDefaultsRuntimeInitialized && this.codexCliModeDefaults) return this.codexCliModeDefaults;
    this.codexCliModeDefaultsRuntimeInitialized = true;
    this.codexCliModeDefaults = codexCliModeDefaultsSchema.parse({ ...parsed, updatedAt: nowIso() });
    return this.codexCliModeDefaults;
  }

  updateCodexCliModeDefaults(input: UpdateCodexCliModeDefaultsInput): CodexCliModeDefaults {
    const parsed = updateCodexCliModeDefaultsInputSchema.parse(input);
    if (!this.codexCliModeDefaults) {
      throw new SpaceNotFoundError("Codex CLI mode defaults were not initialized from a provider catalog.");
    }
    const pair = { modelId: parsed.modelId, reasoningEffort: parsed.reasoningEffort };
    this.codexCliModeDefaultsRuntimeInitialized = true;
    this.codexCliModeDefaults = codexCliModeDefaultsSchema.parse({
      ...this.codexCliModeDefaults,
      [parsed.mode]: pair,
      updatedAt: nowIso()
    });
    return this.codexCliModeDefaults;
  }

  createProvider(input: CreateProviderInput): Provider {
    const parsed = createProviderInputSchema.parse(input);
    if (this.providers.some((provider) => provider.id === parsed.id)) {
      throw new SpaceConflictError(`Provider ${parsed.id} already exists.`);
    }
    const provider = providerSchema.parse({
      id: parsed.id,
      displayName: parsed.displayName,
      type: parsed.type,
      status: "DISABLED",
      statusReason: "Custom provider metadata is saved. Run validation before using it for chat sends.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      baseUrl: parsed.baseUrl ?? null,
      routeProfile: parsed.routeProfile ?? "custom",
      backingProviderId: parsed.backingProviderId ?? null,
      credentialRef: parsed.credentialRef ?? null,
      isBuiltIn: false
    });
    this.providers = [...this.providers, provider];
    return provider;
  }

  updateProvider(providerId: string, input: UpdateProviderInput): Provider {
    const parsed = updateProviderInputSchema.parse(input);
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new SpaceNotFoundError(`Provider ${providerId} was not found.`);
    }
    if (provider.isBuiltIn) {
      throw new SpaceConflictError(`Provider ${providerId} is built-in and cannot be edited.`);
    }
    const updated = providerSchema.parse({
      ...provider,
      ...parsed,
      status: "DISABLED",
      statusReason: "Custom provider metadata changed. Run validation before using it for chat sends.",
      healthCheckedAt: null,
      maskedKeyPrefix: null,
      routeProfile: parsed.routeProfile === undefined ? provider.routeProfile : parsed.routeProfile,
      backingProviderId: parsed.backingProviderId === undefined ? provider.backingProviderId : parsed.backingProviderId,
      credentialRef: parsed.credentialRef === undefined ? provider.credentialRef : parsed.credentialRef,
      isBuiltIn: false
    });
    this.providers = this.providers.map((candidate) => (candidate.id === providerId ? updated : candidate));
    if (this.providerSettings.defaultProviderId === providerId && updated.status !== "VERIFIED") {
      this.providerSettings = providerSettingsSchema.parse({ ...this.providerSettings, updatedAt: nowIso() });
    }
    return updated;
  }

  recordProviderValidation(input: ProviderValidationResult): ProviderValidationResult {
    const checks = this.providerValidations.get(input.providerId) ?? [];
    this.providerValidations.set(input.providerId, [input, ...checks]);
    this.providers = this.providers.map((provider) =>
      provider.id === input.providerId
        ? {
            ...provider,
            status: input.status,
            statusReason: input.statusReason,
            healthCheckedAt: input.checkedAt,
            maskedKeyPrefix: input.maskedKeyPrefix
          }
        : provider
    );
    return input;
  }

  getLatestProviderValidation(providerId: string): ProviderValidationResult | null {
    return this.providerValidations.get(providerId)?.[0] ?? null;
  }

  replaceProviderModels(providerId: string, models: Model[]): Model[] {
    const nextModels: Model[] = [];
    const seenIds = new Set<string>();
    for (const model of models) {
      const parsed = modelSchema.parse({ ...model, providerId });
      if (seenIds.has(parsed.id)) continue;
      seenIds.add(parsed.id);
      nextModels.push(parsed);
    }
    this.models = [...this.models.filter((model) => model.providerId !== providerId), ...nextModels];
    return [...nextModels];
  }

  recordCodexAppServerHandshake(input: RecordCodexAppServerHandshakeInput): CodexAppServerHandshakeCheck {
    const check: CodexAppServerHandshakeCheck = {
      ...input,
      checkId: makeSpaceId("codex_handshake"),
      checkedAt: input.checkedAt ?? input.finishedAt
    };
    this.codexAppServerHandshakeChecks.unshift(check);
    return check;
  }

  getLatestCodexAppServerHandshake(): CodexAppServerHandshakeCheck | null {
    return this.codexAppServerHandshakeChecks[0] ?? null;
  }

  recordCodexAppServerTurnSmoke(input: RecordCodexAppServerTurnSmokeInput): CodexAppServerTurnSmokeCheck {
    const check: CodexAppServerTurnSmokeCheck = {
      ...input,
      checkId: makeSpaceId("codex_turn_smoke"),
      checkedAt: input.checkedAt ?? input.finishedAt
    };
    this.codexAppServerTurnSmokeChecks.unshift(check);
    return check;
  }

  getLatestCodexAppServerTurnSmoke(): CodexAppServerTurnSmokeCheck | null {
    return this.codexAppServerTurnSmokeChecks[0] ?? null;
  }

  recordMcpDiscoverySmoke(input: RecordMcpDiscoverySmokeInput): McpDiscoverySmokeCheck {
    const check: McpDiscoverySmokeCheck = {
      ...input,
      checkId: makeSpaceId("mcp_discovery_smoke"),
      checkedAt: input.checkedAt ?? input.finishedAt
    };
    this.mcpDiscoverySmokeChecks.unshift(check);
    return check;
  }

  getLatestMcpDiscoverySmoke(): McpDiscoverySmokeCheck | null {
    return this.mcpDiscoverySmokeChecks[0] ?? null;
  }

  recordMemoryEmbeddingSmoke(input: RecordMemoryEmbeddingSmokeInput): MemoryEmbeddingSmokeCheck {
    const check: MemoryEmbeddingSmokeCheck = {
      ...input,
      checkId: makeSpaceId("memory_embed_smoke"),
      checkedAt: input.checkedAt ?? input.finishedAt
    };
    this.memoryEmbeddingSmokeChecks.unshift(check);
    return check;
  }

  getLatestMemoryEmbeddingSmoke(): MemoryEmbeddingSmokeCheck | null {
    return this.memoryEmbeddingSmokeChecks[0] ?? null;
  }

  getMemoryVectorReadiness(expectedDimensions: number): MemoryVectorReadiness {
    return {
      id: "memory-vector-readiness",
      status: "DISABLED",
      code: "VECTOR_STORE_NOT_POSTGRES",
      message: "Memory vector readiness requires SPACE_RUNTIME_STORE=postgres.",
      runtimeStore: "memory",
      extensionInstalled: false,
      extensionVersion: null,
      embeddingColumnReady: false,
      embeddingDimensions: null,
      expectedDimensions,
      vectorIndexReady: false,
      checkedAt: nowIso()
    };
  }

  listModels(): Model[] {
    return [...this.models];
  }

  listCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  getMcpGatewayStatus(): McpGatewayStatus {
    return this.mcpGatewayStatus;
  }

  listMcpServers(): McpServer[] {
    return [...this.mcpServers];
  }

  listMcpTools(): McpTool[] {
    return [...this.mcpTools];
  }

  recordMcpDiscoveryCatalog(input: RecordMcpDiscoveryCatalogInput): McpDiscoveryCatalogRecord {
    const record = normalizeMcpDiscoveryCatalog(input);
    this.mcpGatewayStatus = record.gatewayStatus;
    this.mcpServers = record.servers;
    this.mcpTools = record.tools;
    this.capabilities = replaceMcpCapabilities(this.capabilities, this.mcpGatewayStatus, this.mcpTools);
    return record;
  }

  listSkills(): Skill[] {
    return [...this.skills];
  }

  createSkillProposal(input: CreateSkillProposalInput, traceId = makeSpaceId("trace")): SkillProposalRecord {
    const timestamp = nowIso();
    const normalized = normalizeSkillProposalInput(input);
    const skill: Skill = {
      id: makeSpaceId("skill"),
      ...normalized,
      status: "DISABLED",
      statusReason: "Operator proposal recorded; execution remains disabled until review and allowlists pass.",
      contentHash: hashSkillProposal(normalized),
      source: "OPERATOR_PROPOSAL",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.skills.unshift(skill);
    const event = this.appendEvent({
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
  }

  listImportCandidates(query: ListImportCandidatesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): ImportCandidate[] {
    return this.importCandidates
      .filter((candidate) => !query.status || candidate.status === query.status)
      .filter((candidate) => !query.targetKind || candidate.targetKind === query.targetKind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createImportCandidate(input: CreateImportCandidateInput, traceId = makeSpaceId("trace")): ImportCandidateRecord {
    const timestamp = nowIso();
    const normalized = normalizeImportCandidateInput(input);
    if (normalized.targetKind === "MEMORY" && normalized.memoryScope === "ROOM") {
      this.getRoom(normalized.roomId ?? "");
    }
    const candidate: ImportCandidate = {
      id: makeSpaceId("import"),
      sourceKind: normalized.sourceKind,
      targetKind: normalized.targetKind,
      status: "PENDING",
      statusReason: "Awaiting explicit operator import or reject decision. Source content is copied; Space does not follow live Codex paths.",
      sourceRef: normalized.sourceRef,
      roomId: normalized.targetKind === "MEMORY" && normalized.memoryScope === "ROOM" ? normalized.roomId ?? null : null,
      memoryScope: normalized.memoryScope,
      title: normalized.title,
      body: normalized.body,
      provenance: normalized.provenance,
      skillVersion: normalized.targetKind === "SKILL" ? normalized.skillVersion : null,
      skillTriggerDescription: normalized.targetKind === "SKILL" ? normalized.skillTriggerDescription ?? null : null,
      allowedTools: normalized.targetKind === "SKILL" ? normalized.allowedTools : [],
      importedMemoryId: null,
      importedSkillId: null,
      createdAt: timestamp,
      decidedAt: null
    };
    this.importCandidates.unshift(candidate);
    const event = this.appendEvent({
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
  }

  decideImportCandidate(
    candidateId: string,
    input: ImportCandidateDecisionInput,
    traceId = makeSpaceId("trace")
  ): ImportCandidateDecisionRecord {
    const candidate = this.importCandidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new SpaceNotFoundError(`Import candidate ${candidateId} was not found.`);
    }
    if (candidate.status !== "PENDING") {
      throw new SpaceConflictError(`Import candidate ${candidateId} is already ${candidate.status}.`);
    }
    const timestamp = nowIso();
    let memoryEntry: MemoryEntry | null = null;
    let skill: Skill | null = null;
    const events: Event[] = [];

    if (input.decision === "IMPORT") {
      if (candidate.targetKind === "MEMORY") {
        const record = this.createMemoryEntry(
          {
            scope: candidate.memoryScope,
            roomId: candidate.memoryScope === "ROOM" ? candidate.roomId : null,
            title: candidate.title,
            body: candidate.body,
            provenance: `${candidate.provenance}; imported from ${candidate.sourceKind}:${candidate.sourceRef}`
          },
          traceId
        );
        memoryEntry = record.entry;
        events.push(record.event);
      } else {
        const record = this.createSkillProposal(
          {
            displayName: candidate.title,
            version: candidate.skillVersion ?? "0.1.0",
            triggerDescription: candidate.skillTriggerDescription ?? "Imported through explicit Space gate.",
            body: candidate.body,
            allowedTools: candidate.allowedTools
          },
          traceId
        );
        skill = record.skill;
        events.push(record.event);
      }
    }

    const updated: ImportCandidate = {
      ...candidate,
      status: input.decision === "IMPORT" ? "IMPORTED" : "REJECTED",
      statusReason:
        input.decision === "IMPORT"
          ? "Imported through explicit Space gate; source content is now a native Space copy."
          : input.reason,
      importedMemoryId: memoryEntry?.id ?? null,
      importedSkillId: skill?.id ?? null,
      decidedAt: timestamp
    };
    this.importCandidates = this.importCandidates.map((item) => (item.id === candidateId ? updated : item));
    const event = this.appendEvent({
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
    });
    events.push(event);
    return { candidate: updated, events, memoryEntry, skill };
  }

  createMemoryEntry(input: CreateMemoryEntryInput, traceId = makeSpaceId("trace"), _options: CreateMemoryEntryOptions = {}): MemoryEntryRecord {
    if (input.scope === "ROOM" && input.roomId) {
      this.getRoom(input.roomId);
    }
    const timestamp = nowIso();
    const entry: MemoryEntry = {
      id: makeSpaceId("memory"),
      scope: input.scope,
      roomId: input.scope === "ROOM" ? input.roomId ?? null : null,
      title: redactMemoryText(input.title),
      body: redactMemoryText(input.body),
      provenance: redactMemoryText(input.provenance),
      createdAt: timestamp
    };
    this.memoryEntries.unshift(entry);
    if (entry.roomId) {
      this.touchRoom(entry.roomId, timestamp);
    }
    const event = this.appendEvent({
      roomId: entry.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "MEMORY_SAVED",
      message: `Memory ${entry.title} saved.`,
      payload: { memoryId: entry.id, scope: entry.scope, provenance: entry.provenance }
    });
    return { entry, event };
  }

  listMemoryEntries(
    query: ListMemoryQuery = { page: 1, pageSize: 25, sortOrder: "desc" },
    options: ListMemoryEntriesOptions = {}
  ): MemoryEntry[] {
    assertMemorySearchModeEnabled(query, options);
    const needle = query.q?.toLowerCase();
    const entries = this.memoryEntries
      .filter((entry) => !query.scope || entry.scope === query.scope)
      .filter((entry) => !query.roomId || entry.roomId === query.roomId)
      .filter((entry) => {
        if (!needle) return true;
        return `${entry.title}\n${entry.body}\n${entry.provenance}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = options.limit === undefined ? null : Math.max(1, Math.min(500, Math.trunc(options.limit)));
    return limit === null ? entries : entries.slice(0, limit);
  }

  linkMemoryCacheRecord(input: LinkMemoryCacheInput): MemoryCacheLink {
    const parsed = linkMemoryCacheInputSchema.parse(input);
    if (!this.memoryEntries.some((entry) => entry.id === parsed.memoryRecordId)) {
      throw new SpaceNotFoundError(`Memory cache record ${parsed.memoryRecordId} was not found.`);
    }
    const existing = this.memoryCacheLinks.get(parsed.memoryRecordId);
    if (existing) {
      if (existing.canonicalMemoryId === parsed.canonicalMemoryId) return existing;
      throw new SpaceConflictError(`Memory cache record ${parsed.memoryRecordId} is already linked.`);
    }
    const link = memoryCacheLinkSchema.parse({ ...parsed, linkedAt: nowIso() });
    this.memoryCacheLinks.set(link.memoryRecordId, link);
    return link;
  }

  getMemoryCacheLink(memoryRecordId: string): MemoryCacheLink | null {
    return this.memoryCacheLinks.get(memoryRecordId) ?? null;
  }

  listMemoryCacheLinks(query: ListMemoryCacheLinksQuery = { limit: 500 }): MemoryCacheLink[] {
    const parsed = listMemoryCacheLinksQuerySchema.parse(query);
    const selectedIds = parsed.memoryRecordIds ? new Set(parsed.memoryRecordIds) : null;
    return [...this.memoryCacheLinks.values()]
      .filter((link) => !selectedIds || selectedIds.has(link.memoryRecordId))
      .sort((left, right) => right.linkedAt.localeCompare(left.linkedAt) || left.memoryRecordId.localeCompare(right.memoryRecordId))
      .slice(0, parsed.limit);
  }

  upsertMemoryIssueState(input: UpsertMemoryIssueStateInput): MemoryIssueState {
    const parsed = upsertMemoryIssueStateInputSchema.parse(input);
    if (!this.users.has(parsed.actorUserId)) {
      throw new SpaceNotFoundError(`User ${parsed.actorUserId} was not found.`);
    }
    const existing = this.memoryIssueStates.get(parsed.issueId);
    if (existing && parsed.expectedVersion !== existing.version) {
      throw new SpaceConflictError(`Memory issue ${parsed.issueId} changed before this update.`);
    }
    if (!existing && parsed.expectedVersion !== undefined) {
      throw new SpaceConflictError(`Memory issue ${parsed.issueId} has no version ${parsed.expectedVersion}.`);
    }
    const timestamp = nowIso();
    const state = memoryIssueStateSchema.parse({
      issueId: parsed.issueId,
      issueType: parsed.issueType,
      recordId: parsed.recordId,
      sourceHash: parsed.sourceHash,
      status: parsed.status,
      reason: parsed.reason ? redactMemoryText(parsed.reason) : null,
      actorUserId: parsed.actorUserId,
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    this.memoryIssueStates.set(state.issueId, state);
    return state;
  }

  getMemoryIssueState(issueId: string): MemoryIssueState | null {
    return this.memoryIssueStates.get(issueId) ?? null;
  }

  listMemoryIssueStates(
    query: ListMemoryIssueStatesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): MemoryIssueState[] {
    const offset = (query.page - 1) * query.pageSize;
    const selectedIssueIds = query.issueIds ? new Set(query.issueIds) : null;
    return [...this.memoryIssueStates.values()]
      .filter((state) => !selectedIssueIds || selectedIssueIds.has(state.issueId))
      .filter((state) => !query.status || state.status === query.status)
      .filter((state) => !query.recordId || state.recordId === query.recordId)
      .sort((left, right) => {
        const updatedOrder = left.updatedAt.localeCompare(right.updatedAt) || left.issueId.localeCompare(right.issueId);
        return query.sortOrder === "asc" ? updatedOrder : -updatedOrder;
      })
      .slice(offset, offset + query.pageSize);
  }

  createMemoryConsolidationRun(input: CreateMemoryConsolidationRunInput): MemoryConsolidationRun {
    const parsed = createMemoryConsolidationRunInputSchema.parse(input);
    if (parsed.actorUserId && !this.users.has(parsed.actorUserId)) {
      throw new SpaceNotFoundError(`User ${parsed.actorUserId} was not found.`);
    }
    const existing = [...this.memoryConsolidationRuns.values()].find((run) => run.dedupeKey === parsed.dedupeKey);
    if (existing) {
      if (
        existing.mode === parsed.mode &&
        existing.triggerKind === parsed.triggerKind &&
        existing.workflowId === parsed.workflowId &&
        existing.sourceHash === parsed.sourceHash &&
        existing.actorUserId === parsed.actorUserId
      ) return existing;
      throw new SpaceConflictError("Memory consolidation dedupe key already exists.");
    }
    if ([...this.memoryConsolidationRuns.values()].some((run) => run.workflowId === parsed.workflowId)) {
      throw new SpaceConflictError(`Memory consolidation workflow ${parsed.workflowId} already exists.`);
    }
    const timestamp = nowIso();
    const run = memoryConsolidationRunSchema.parse({
      id: makeSpaceId("memory_consolidation"),
      ...parsed,
      status: "QUEUED",
      progressCompleted: 0,
      progressTotal: 0,
      findingCount: 0,
      appliedOperationCount: 0,
      skippedOperationCount: 0,
      failedOperationCount: 0,
      metrics: {},
      modelId: null,
      aiVerified: false,
      aiEvidence: {},
      statusReason: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp
    });
    this.memoryConsolidationRuns.set(run.id, run);
    return run;
  }

  getMemoryConsolidationRun(runId: string): MemoryConsolidationRun {
    const run = this.memoryConsolidationRuns.get(runId);
    if (!run) throw new SpaceNotFoundError(`Memory consolidation ${runId} was not found.`);
    return run;
  }

  updateMemoryConsolidationRun(runId: string, input: UpdateMemoryConsolidationRunInput): MemoryConsolidationRun {
    const parsed = updateMemoryConsolidationRunInputSchema.parse(input);
    const current = this.getMemoryConsolidationRun(runId);
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
    this.memoryConsolidationRuns.set(runId, updated);
    return updated;
  }

  createMemoryConsolidationFinding(input: CreateMemoryConsolidationFindingInput): MemoryConsolidationFinding {
    const parsed = createMemoryConsolidationFindingInputSchema.parse(input);
    const run = this.getMemoryConsolidationRun(parsed.runId);
    if (run.status !== "RUNNING") {
      throw new SpaceConflictError(`Memory consolidation ${run.id} is not running.`);
    }
    const duplicate = parsed.issueId
      ? [...this.memoryConsolidationFindings.values()].find((finding) => finding.runId === run.id && finding.issueId === parsed.issueId)
      : null;
    if (duplicate) return duplicate;
    const timestamp = nowIso();
    const finding = memoryConsolidationFindingSchema.parse({
      ...parsed,
      id: makeSpaceId("memory_finding"),
      status: "OPEN",
      evidence: redactMemoryText(parsed.evidence),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.memoryConsolidationFindings.set(finding.id, finding);
    return finding;
  }

  updateMemoryConsolidationFinding(
    findingId: string,
    input: UpdateMemoryConsolidationFindingInput
  ): MemoryConsolidationFinding {
    const parsed = updateMemoryConsolidationFindingInputSchema.parse(input);
    const current = this.memoryConsolidationFindings.get(findingId);
    if (!current) throw new SpaceNotFoundError(`Memory consolidation finding ${findingId} was not found.`);
    assertMemoryConsolidationFindingTransition(current.status, parsed.status);
    const updated = memoryConsolidationFindingSchema.parse({ ...current, status: parsed.status, updatedAt: nowIso() });
    this.memoryConsolidationFindings.set(findingId, updated);
    return updated;
  }

  listMemoryConsolidationFindings(runId: string, limit = 500): MemoryConsolidationFinding[] {
    this.getMemoryConsolidationRun(runId);
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return [...this.memoryConsolidationFindings.values()]
      .filter((finding) => finding.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, boundedLimit);
  }

  createMemoryConsolidationOperation(input: CreateMemoryConsolidationOperationInput): MemoryConsolidationOperation {
    const parsed = createMemoryConsolidationOperationInputSchema.parse(input);
    const run = this.getMemoryConsolidationRun(parsed.runId);
    if (run.status !== "RUNNING") {
      throw new SpaceConflictError(`Memory consolidation ${run.id} is not running.`);
    }
    if (parsed.findingId) {
      const finding = this.memoryConsolidationFindings.get(parsed.findingId);
      if (!finding || finding.runId !== run.id) {
        throw new SpaceNotFoundError(`Memory consolidation finding ${parsed.findingId} was not found.`);
      }
    }
    const timestamp = nowIso();
    const operation = memoryConsolidationOperationSchema.parse({
      ...parsed,
      id: makeSpaceId("memory_operation"),
      status: "PROPOSED",
      changeSetId: null,
      reason: redactMemoryText(parsed.reason),
      statusReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      appliedAt: null
    });
    this.memoryConsolidationOperations.set(operation.id, operation);
    return operation;
  }

  updateMemoryConsolidationOperation(
    operationId: string,
    input: UpdateMemoryConsolidationOperationInput
  ): MemoryConsolidationOperation {
    const parsed = updateMemoryConsolidationOperationInputSchema.parse(input);
    const current = this.memoryConsolidationOperations.get(operationId);
    if (!current) throw new SpaceNotFoundError(`Memory consolidation operation ${operationId} was not found.`);
    assertMemoryConsolidationOperationTransition(current.status, parsed.status);
    const changeSetId = parsed.changeSetId === undefined ? current.changeSetId : parsed.changeSetId;
    if (changeSetId) this.getMemoryChangeSet(changeSetId);
    if (
      parsed.status === "APPLIED" &&
      ["NORMALIZE_MARKER", "ARCHIVE_EXACT_DUPLICATE", "ARCHIVE_SUPERSEDED"].includes(current.operationKind) &&
      !changeSetId
    ) {
      throw new SpaceConflictError(`Memory consolidation operation ${operationId} requires an audited change set.`);
    }
    const timestamp = nowIso();
    const updated = memoryConsolidationOperationSchema.parse({
      ...current,
      status: parsed.status,
      changeSetId,
      statusReason: parsed.statusReason === undefined
        ? current.statusReason
        : parsed.statusReason === null ? null : redactMemoryText(parsed.statusReason),
      updatedAt: timestamp,
      appliedAt: parsed.status === "APPLIED" ? current.appliedAt ?? timestamp : current.appliedAt
    });
    this.memoryConsolidationOperations.set(operationId, updated);
    return updated;
  }

  listMemoryConsolidationOperations(runId: string, limit = 500): MemoryConsolidationOperation[] {
    this.getMemoryConsolidationRun(runId);
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return [...this.memoryConsolidationOperations.values()]
      .filter((operation) => operation.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, boundedLimit);
  }

  claimMemoryCommand(input: ClaimMemoryCommandInput): MemoryCommandClaim {
    const parsed = claimMemoryCommandInputSchema.parse(input);
    const key = `${parsed.commandScope}\u0000${parsed.actorKey}\u0000${parsed.idempotencyKeyHash}`;
    const existing = this.memoryCommandIdempotency.get(key);
    if (existing) {
      const matches = existing.requestHash === parsed.requestHash &&
        existing.resourceType === parsed.resourceType &&
        existing.resourceId === parsed.resourceId &&
        existing.workflowId === parsed.workflowId;
      if (!matches) throw new SpaceConflictError("Memory command idempotency key was reused with a different request.");
      return { record: existing, created: false };
    }
    const record = memoryCommandIdempotencySchema.parse({ ...parsed, createdAt: nowIso() });
    this.memoryCommandIdempotency.set(key, record);
    return { record, created: true };
  }

  createMemoryChangeSet(
    input: CreateMemoryChangeSetInput,
    traceId = makeSpaceId("trace"),
    options: CreateMemoryChangeSetOptions = {}
  ): MemoryChangeSet {
    const parsed = normalizeMemoryChangeSetInput(input);
    if (!this.users.has(parsed.actorUserId)) {
      throw new SpaceNotFoundError(`User ${parsed.actorUserId} was not found.`);
    }
    const changeSetId = options.id ? idSchema.parse(options.id) : makeSpaceId("memory_change");
    const existing = this.memoryChangeSets.find((candidate) => candidate.id === changeSetId);
    if (existing) {
      if (memoryChangeSetMatchesInput(existing, parsed)) return existing;
      throw new SpaceConflictError(`Memory change set ${changeSetId} already exists with different immutable input.`);
    }
    const rollbackTarget = parsed.rollbackOfChangeSetId ? this.getMemoryChangeSet(parsed.rollbackOfChangeSetId) : null;
    if (rollbackTarget) assertMemoryRollbackTarget(parsed, rollbackTarget);
    const timestamp = nowIso();
    const changeSet = memoryChangeSetSchema.parse({
      id: changeSetId,
      kind: parsed.kind,
      status: "PROPOSED",
      sourcePath: parsed.sourcePath,
      recordIds: Array.from(new Set(parsed.recordIds)),
      resolvesIssueIds: Array.from(new Set(parsed.resolvesIssueIds)),
      expectedSourceHash: parsed.expectedSourceHash,
      resultingSourceHash: null,
      beforeContentHash: parsed.beforeContentHash,
      afterContentHash: parsed.afterContentHash,
      beforeSnapshot: parsed.beforeSnapshot,
      afterSnapshot: parsed.afterSnapshot,
      reason: redactMemoryText(parsed.reason),
      statusReason: null,
      actorUserId: parsed.actorUserId,
      traceId,
      rollbackOfChangeSetId: parsed.rollbackOfChangeSetId ?? null,
      rolledBackByChangeSetId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      appliedAt: null,
      failedAt: null,
      rolledBackAt: null
    });
    this.memoryChangeSets.unshift(changeSet);
    return changeSet;
  }

  getMemoryChangeSet(changeSetId: string): MemoryChangeSet {
    const changeSet = this.memoryChangeSets.find((candidate) => candidate.id === changeSetId);
    if (!changeSet) {
      throw new SpaceNotFoundError(`Memory change set ${changeSetId} was not found.`);
    }
    return changeSet;
  }

  updateMemoryChangeSet(changeSetId: string, input: UpdateMemoryChangeSetInput): MemoryChangeSet {
    const parsed = updateMemoryChangeSetInputSchema.parse(input);
    const current = this.getMemoryChangeSet(changeSetId);
    assertMemoryChangeStatusTransition(current.status, parsed.status);
    const timestamp = nowIso();

    if (current.kind === "ROLLBACK" && parsed.status === "APPLIED") {
      const rollbackTarget = this.getMemoryChangeSet(current.rollbackOfChangeSetId!);
      if (rollbackTarget.status !== "APPLIED" || rollbackTarget.rolledBackByChangeSetId) {
        throw new SpaceConflictError(`Memory change set ${rollbackTarget.id} is not eligible for rollback.`);
      }
      if (parsed.resultingSourceHash !== rollbackTarget.expectedSourceHash) {
        throw new SpaceConflictError(`Memory rollback ${current.id} did not restore its target source hash.`);
      }
      const rolledBackTarget = memoryChangeSetSchema.parse({
        ...rollbackTarget,
        status: "ROLLED_BACK",
        rolledBackByChangeSetId: current.id,
        rolledBackAt: timestamp,
        updatedAt: timestamp
      });
      this.memoryChangeSets = this.memoryChangeSets.map((candidate) =>
        candidate.id === rollbackTarget.id ? rolledBackTarget : candidate
      );
    }

    const updated = memoryChangeSetSchema.parse({
      ...current,
      status: parsed.status,
      resultingSourceHash: parsed.resultingSourceHash ?? current.resultingSourceHash,
      statusReason: parsed.statusReason ? redactMemoryText(parsed.statusReason) : current.statusReason,
      updatedAt: timestamp,
      appliedAt: parsed.status === "APPLIED" ? timestamp : current.appliedAt,
      failedAt: parsed.status === "FAILED" ? timestamp : current.failedAt
    });
    this.memoryChangeSets = this.memoryChangeSets.map((candidate) => candidate.id === changeSetId ? updated : candidate);
    return updated;
  }

  listMemoryChangeSets(
    query: ListMemoryChangeSetsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }
  ): MemoryChangeSetSummary[] {
    const offset = (query.page - 1) * query.pageSize;
    return this.memoryChangeSets
      .filter((changeSet) => !query.kind || changeSet.kind === query.kind)
      .filter((changeSet) => !query.status || changeSet.status === query.status)
      .filter((changeSet) => !query.sourcePath || changeSet.sourcePath === query.sourcePath)
      .filter((changeSet) => !query.recordId || changeSet.recordIds.includes(query.recordId))
      .filter((changeSet) => !query.issueId || changeSet.resolvesIssueIds.includes(query.issueId))
      .filter((changeSet) => !query.rollbackOfChangeSetId || changeSet.rollbackOfChangeSetId === query.rollbackOfChangeSetId)
      .sort((a, b) => {
        const createdOrder = a.createdAt.localeCompare(b.createdAt);
        const stableOrder = createdOrder || a.id.localeCompare(b.id);
        return query.sortOrder === "asc" ? stableOrder : -stableOrder;
      })
      .slice(offset, offset + query.pageSize)
      .map((changeSet) => memoryChangeSetSummarySchema.parse(changeSet));
  }

  createArtifact(input: CreateArtifactInput, traceId = makeSpaceId("trace")): ArtifactRecord {
    const normalized = normalizeArtifactInput(input);
    if (normalized.roomId) {
      this.getRoom(normalized.roomId);
    }
    const timestamp = nowIso();
    const artifact: Artifact = {
      id: makeSpaceId("artifact"),
      roomId: normalized.roomId ?? null,
      paneId: normalized.paneId ?? null,
      turnId: normalized.turnId ?? null,
      workflowId: normalized.workflowId ?? null,
      kind: normalized.kind,
      mimeType: normalized.mimeType,
      storageUri: normalized.storageUri,
      sha256: normalized.sha256,
      byteSize: normalized.byteSize,
      metadata: normalized.metadata,
      expiresAt: normalized.expiresAt ?? null,
      pinnedAt: normalized.pinnedAt ?? null,
      deletedAt: normalized.deletedAt ?? null,
      createdAt: timestamp
    };
    this.artifacts.unshift(artifact);
    if (artifact.roomId) {
      this.touchRoom(artifact.roomId, timestamp);
    }
    const event = this.appendEvent({
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
  }

  listArtifacts(query: ListArtifactsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): Artifact[] {
    return this.artifacts
      .filter((artifact) => artifact.deletedAt === null)
      .filter((artifact) => !query.roomId || artifact.roomId === query.roomId)
      .filter((artifact) => !query.paneId || artifact.paneId === query.paneId)
      .filter((artifact) => !query.workflowId || artifact.workflowId === query.workflowId)
      .filter((artifact) => !query.kind || artifact.kind === query.kind)
      .filter((artifact) => {
        if (query.collection === "AGENT_FILES") return isAgentFileArtifact(artifact);
        if (query.collection === "ROOM_MEDIA") return isRoomMediaArtifact(artifact);
        return true;
      })
      .sort((a, b) =>
        query.sortOrder === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
      );
  }

  getArtifact(artifactId: string): Artifact {
    const artifact = this.artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw new SpaceNotFoundError(`Artifact ${artifactId} was not found.`);
    }
    return artifact;
  }

  updateArtifactRetention(artifactId: string, input: UpdateArtifactRetentionInput): Artifact {
    const current = this.getArtifact(artifactId);
    const parsed = updateArtifactRetentionInputSchema.parse(input);
    const updated = artifactSchema.parse({
      ...current,
      expiresAt: parsed.expiresAt === undefined ? current.expiresAt : parsed.expiresAt,
      pinnedAt: parsed.pinnedAt === undefined ? current.pinnedAt : parsed.pinnedAt,
      deletedAt: parsed.deletedAt === undefined ? current.deletedAt : parsed.deletedAt
    });
    this.artifacts = this.artifacts.map((artifact) => artifact.id === artifactId ? updated : artifact);
    return updated;
  }

  deleteExpiredBrowserArtifacts(at = nowIso()): Artifact[] {
    const timestamp = isoDateTimeSchema.parse(at);
    const expired = this.artifacts.filter(
      (artifact) => artifact.expiresAt !== null && artifact.expiresAt <= timestamp && artifact.pinnedAt === null && artifact.deletedAt === null
    );
    this.artifacts = this.artifacts.map((artifact) =>
      expired.some((candidate) => candidate.id === artifact.id) ? { ...artifact, deletedAt: timestamp } : artifact
    );
    return expired.map((artifact) => ({ ...artifact, deletedAt: timestamp }));
  }

  deleteArtifact(artifactId: string): Artifact {
    const artifact = this.getArtifact(artifactId);
    this.artifacts = this.artifacts.filter((item) => item.id !== artifactId);
    if (artifact.roomId) {
      this.touchRoom(artifact.roomId, nowIso());
    }
    return artifact;
  }

  createReviewDecision(input: CreateReviewDecisionInput, traceId = makeSpaceId("trace")): ReviewDecisionRecord {
    this.getRoom(input.roomId);
    const timestamp = nowIso();
    const evidenceArtifactIds = Array.from(new Set(input.evidenceArtifactIds));
    const decision: ReviewDecision = {
      id: makeSpaceId("review"),
      roomId: input.roomId,
      workflowId: input.workflowId ?? null,
      decision: input.decision,
      summary: redactMemoryText(input.summary),
      evidenceArtifactIds,
      rollbackNote: redactMemoryText(input.rollbackNote),
      createdAt: timestamp
    };
    this.reviewDecisions.unshift(decision);
    this.touchRoom(decision.roomId, timestamp);
    const event = this.appendEvent({
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
  }

  listReviewDecisions(query: ListReviewDecisionsQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): ReviewDecision[] {
    return this.reviewDecisions
      .filter((decision) => !query.roomId || decision.roomId === query.roomId)
      .sort((a, b) =>
        query.sortOrder === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
      );
  }

  createReviewCheck(input: CreateReviewCheckInput, traceId = makeSpaceId("trace")): ReviewCheckRecord {
    this.getRoom(input.roomId);
    const timestamp = nowIso();
    const artifactIds = Array.from(new Set(input.artifactIds));
    const check: ReviewCheck = {
      id: makeSpaceId("review_check"),
      roomId: input.roomId,
      reviewDecisionId: input.reviewDecisionId ?? null,
      name: redactMemoryText(input.name),
      status: input.status,
      command: input.command ? redactMemoryText(input.command) : null,
      summary: redactMemoryText(input.summary),
      artifactIds,
      metadata: redactArtifactMetadata(input.metadata ?? {}) as Record<string, unknown>,
      createdAt: timestamp
    };
    this.reviewChecks.unshift(check);
    this.touchRoom(check.roomId, timestamp);
    const event = this.appendEvent({
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
  }

  listReviewChecks(query: ListReviewChecksQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): ReviewCheck[] {
    return this.reviewChecks
      .filter((check) => !query.roomId || check.roomId === query.roomId)
      .filter((check) => !query.reviewDecisionId || check.reviewDecisionId === query.reviewDecisionId)
      .filter((check) => !query.status || check.status === query.status)
      .sort((a, b) =>
        query.sortOrder === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
      );
  }

  createReviewDiffSummary(input: CreateReviewDiffSummaryInput, traceId = makeSpaceId("trace")): ReviewDiffSummaryRecord {
    this.getRoom(input.roomId);
    const timestamp = nowIso();
    const diff: ReviewDiffSummary = {
      id: makeSpaceId("review_diff"),
      roomId: input.roomId,
      reviewDecisionId: input.reviewDecisionId ?? null,
      title: redactMemoryText(input.title),
      filePath: input.filePath,
      status: input.status,
      additions: input.additions,
      deletions: input.deletions,
      patchArtifactId: input.patchArtifactId ?? null,
      summary: redactMemoryText(input.summary),
      createdAt: timestamp
    };
    this.reviewDiffs.unshift(diff);
    this.touchRoom(diff.roomId, timestamp);
    const event = this.appendEvent({
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
  }

  listReviewDiffSummaries(query: ListReviewDiffSummariesQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): ReviewDiffSummary[] {
    return this.reviewDiffs
      .filter((diff) => !query.roomId || diff.roomId === query.roomId)
      .filter((diff) => !query.reviewDecisionId || diff.reviewDecisionId === query.reviewDecisionId)
      .filter((diff) => !query.status || diff.status === query.status)
      .sort((a, b) =>
        query.sortOrder === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
      );
  }

  listSwarmTasks(query: ListSwarmTasksQuery = { page: 1, pageSize: 25, sortOrder: "desc" }): SwarmTask[] {
    return this.swarmTasks
      .filter((task) => !query.roomId || task.roomId === query.roomId)
      .filter((task) => !query.status || task.status === query.status)
      .filter((task) => !query.role || task.role === query.role)
      .sort((a, b) =>
        query.sortOrder === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
      );
  }

  createSwarmTask(input: CreateSwarmTaskInput, traceId = makeSpaceId("trace")): SwarmTaskRecord {
    const normalized = normalizeSwarmTaskInput(input);
    this.getRoom(normalized.roomId);
    if (normalized.parentTaskId) {
      this.getSwarmTaskInRoom(normalized.parentTaskId, normalized.roomId);
    }
    for (const dependencyId of normalized.dependsOnTaskIds) {
      this.getSwarmTaskInRoom(dependencyId, normalized.roomId);
    }
    const timestamp = nowIso();
    const task: SwarmTask = {
      id: makeSpaceId("swarm_task"),
      roomId: normalized.roomId,
      parentTaskId: normalized.parentTaskId ?? null,
      role: normalized.role,
      title: normalized.title,
      goal: normalized.goal,
      status: "PLANNED",
      assignee: normalized.assignee ?? null,
      dependsOnTaskIds: normalized.dependsOnTaskIds,
      lockIds: [],
      resultSummary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    };
    this.swarmTasks.unshift(task);
    this.touchRoom(task.roomId, timestamp);
    const event = this.appendEvent({
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
  }

  updateSwarmTask(taskId: string, input: UpdateSwarmTaskInput, traceId = makeSpaceId("trace")): SwarmTaskRecord {
    const current = this.getSwarmTask(taskId);
    const normalized = normalizeSwarmTaskUpdate(input);
    if (normalized.dependsOnTaskIds) {
      for (const dependencyId of normalized.dependsOnTaskIds) {
        this.getSwarmTaskInRoom(dependencyId, current.roomId);
      }
    }
    if (normalized.lockIds) {
      for (const lockId of normalized.lockIds) {
        this.getSwarmLockInRoom(lockId, current.roomId);
      }
    }
    const timestamp = nowIso();
    const nextStatus = normalized.status ?? current.status;
    const updated: SwarmTask = {
      ...current,
      status: nextStatus,
      assignee: normalized.assignee === undefined ? current.assignee : normalized.assignee,
      dependsOnTaskIds: normalized.dependsOnTaskIds ?? current.dependsOnTaskIds,
      lockIds: normalized.lockIds ?? current.lockIds,
      resultSummary: normalized.resultSummary === undefined ? current.resultSummary : normalized.resultSummary,
      updatedAt: timestamp,
      completedAt: nextStatus === "DONE" ? current.completedAt ?? timestamp : normalized.status ? null : current.completedAt
    };
    this.swarmTasks = this.swarmTasks.map((task) => (task.id === taskId ? updated : task));
    this.touchRoom(updated.roomId, timestamp);
    const event = this.appendEvent({
      roomId: updated.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "SWARM_TASK_UPDATED",
      message: `Swarm task ${updated.title} updated.`,
      payload: {
        taskId: updated.id,
        role: updated.role,
        status: updated.status,
        lockCount: updated.lockIds.length,
        dependencyCount: updated.dependsOnTaskIds.length
      }
    });
    return { task: updated, event };
  }

  claimSwarmLock(input: ClaimSwarmLockInput, traceId = makeSpaceId("trace")): SwarmLockRecord {
    const normalized = normalizeSwarmLockInput(input);
    this.getRoom(normalized.roomId);
    if (normalized.taskId) {
      this.getSwarmTaskInRoom(normalized.taskId, normalized.roomId);
    }
    const conflict = this.swarmLocks.find(
      (lock) => lock.roomId === normalized.roomId && lock.resource === normalized.resource && lock.status === "ACTIVE"
    );
    if (conflict) {
      throw new SpaceConflictError(`Swarm resource ${normalized.resource} is already locked by ${conflict.holder}.`);
    }
    const timestamp = nowIso();
    const lock: SwarmLock = {
      id: makeSpaceId("swarm_lock"),
      roomId: normalized.roomId,
      taskId: normalized.taskId ?? null,
      resource: normalized.resource,
      status: "ACTIVE",
      holder: normalized.holder,
      reason: normalized.reason,
      createdAt: timestamp,
      releasedAt: null
    };
    this.swarmLocks.unshift(lock);
    this.touchRoom(lock.roomId, timestamp);
    const event = this.appendEvent({
      roomId: lock.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "SWARM_LOCK_CLAIMED",
      message: `Swarm lock claimed for ${lock.resource}.`,
      payload: { lockId: lock.id, taskId: lock.taskId, resource: lock.resource, holder: lock.holder }
    });
    return { lock, event };
  }

  releaseSwarmLock(lockId: string, input: ReleaseSwarmLockInput = { reason: "Released by operator." }, traceId = makeSpaceId("trace")): SwarmLockRecord {
    const current = this.getSwarmLock(lockId);
    if (current.status !== "ACTIVE") {
      throw new SpaceConflictError(`Swarm lock ${lockId} is already ${current.status}.`);
    }
    const timestamp = nowIso();
    const releaseReason = redactMemoryText(input.reason.trim());
    const updated: SwarmLock = {
      ...current,
      status: "RELEASED",
      releasedAt: timestamp
    };
    this.swarmLocks = this.swarmLocks.map((lock) => (lock.id === lockId ? updated : lock));
    this.touchRoom(updated.roomId, timestamp);
    const event = this.appendEvent({
      roomId: updated.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "SWARM_LOCK_RELEASED",
      message: `Swarm lock released for ${updated.resource}.`,
      payload: { lockId: updated.id, resource: updated.resource, holder: updated.holder, releaseReason }
    });
    return { lock: updated, event };
  }

  postSwarmMessage(input: PostSwarmMessageInput, traceId = makeSpaceId("trace")): SwarmMessageRecord {
    const normalized = normalizeSwarmMessageInput(input);
    this.getRoom(normalized.roomId);
    if (normalized.taskId) {
      this.getSwarmTaskInRoom(normalized.taskId, normalized.roomId);
    }
    const timestamp = nowIso();
    const message: SwarmMessage = {
      id: makeSpaceId("swarm_msg"),
      roomId: normalized.roomId,
      taskId: normalized.taskId ?? null,
      fromRole: normalized.fromRole,
      toRole: normalized.toRole ?? null,
      body: normalized.body,
      createdAt: timestamp
    };
    this.swarmMessages.unshift(message);
    this.touchRoom(message.roomId, timestamp);
    const event = this.appendEvent({
      roomId: message.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "SWARM_MESSAGE_POSTED",
      message: `Swarm message posted by ${message.fromRole}.`,
      payload: { messageId: message.id, taskId: message.taskId, fromRole: message.fromRole, toRole: message.toRole }
    });
    return { message, event };
  }

  createSwarmReconcile(input: CreateSwarmReconcileInput, traceId = makeSpaceId("trace")): SwarmReconcileRecord {
    const normalized = normalizeSwarmReconcileInput(input);
    this.getRoom(normalized.roomId);
    for (const taskId of normalized.taskIds) {
      this.getSwarmTaskInRoom(taskId, normalized.roomId);
    }
    const timestamp = nowIso();
    const reconcile: SwarmReconcile = {
      id: makeSpaceId("swarm_reconcile"),
      roomId: normalized.roomId,
      taskIds: normalized.taskIds,
      decision: normalized.decision,
      summary: normalized.summary,
      nextSteps: normalized.nextSteps,
      createdAt: timestamp
    };
    this.swarmReconciles.unshift(reconcile);
    this.touchRoom(reconcile.roomId, timestamp);
    const event = this.appendEvent({
      roomId: reconcile.roomId,
      paneId: null,
      turnId: null,
      traceId,
      type: "SWARM_RECONCILED",
      message: `Swarm reconcile ${reconcile.decision.toLowerCase()} recorded.`,
      payload: { reconcileId: reconcile.id, taskIds: reconcile.taskIds, decision: reconcile.decision }
    });
    return { reconcile, event };
  }

  getSwarmState(roomId?: string): SwarmState {
    if (roomId) {
      this.getRoom(roomId);
    }
    const tasks = this.listSwarmTasks({ page: 1, pageSize: 100, sortOrder: "desc", roomId });
    return {
      tasks,
      locks: this.swarmLocks
        .filter((lock) => !roomId || lock.roomId === roomId)
        .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "ACTIVE" ? -1 : 1)),
      messages: this.swarmMessages
        .filter((message) => !roomId || message.roomId === roomId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      reconciles: this.swarmReconciles
        .filter((reconcile) => !roomId || reconcile.roomId === roomId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ...swarmExecutionDisabled
    };
  }

  appendEvent(input: StoreEventInput): Event {
    const event: Event = {
      id: makeSpaceId("event"),
      createdAt: nowIso(),
      ...input,
      workflowId: input.workflowId ?? null
    };
    this.events.push(event);
    this.lastEventRelaySequence += 1n;
    this.eventRelaySequences.set(event.id, this.lastEventRelaySequence.toString());
    return event;
  }

  private touchRoom(roomId: string, timestamp: string): void {
    const room = this.getRoom(roomId);
    this.rooms.set(roomId, { ...room, updatedAt: timestamp });
  }

  private getSwarmTask(taskId: string): SwarmTask {
    const task = this.swarmTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new SpaceNotFoundError(`Swarm task ${taskId} was not found.`);
    }
    return task;
  }

  private getSwarmTaskInRoom(taskId: string, roomId: string): SwarmTask {
    const task = this.getSwarmTask(taskId);
    if (task.roomId !== roomId) {
      throw new SpaceNotFoundError(`Swarm task ${taskId} was not found in room ${roomId}.`);
    }
    return task;
  }

  private getSwarmLock(lockId: string): SwarmLock {
    const lock = this.swarmLocks.find((item) => item.id === lockId);
    if (!lock) {
      throw new SpaceNotFoundError(`Swarm lock ${lockId} was not found.`);
    }
    return lock;
  }

  private getSwarmLockInRoom(lockId: string, roomId: string): SwarmLock {
    const lock = this.getSwarmLock(lockId);
    if (lock.roomId !== roomId) {
      throw new SpaceNotFoundError(`Swarm lock ${lockId} was not found in room ${roomId}.`);
    }
    return lock;
  }
}
