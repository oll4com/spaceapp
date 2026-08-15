import type {
  Artifact,
  AgentPaneHistoryItem,
  AgentPaneSession,
  ActivityLogEvent,
  ActivityLogSettings,
  AppDiagnosticsSegmentListQuery,
  AppDiagnosticsSegmentMetadata,
  AppDiagnosticsStatus,
  AppDiagnosticsVideoLease,
  CollaborationMode,
  AgentRuntimeRegistry,
  AdminOperationRun,
  AuditEvent,
  AuthMe,
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
  ListSharedChatMessagesQuery,
  AuditChainEntry,
  ListAuditChainQuery,
  AuditVerifyResponse,
  CreateClipboardItemRequest,
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
  CreateCliAccountProfileInput,
  CreateCliAccountProfileResponse,
  CliAccountProfileDetailsResponse,
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
  SystemAnalyticsModelsResponse,
  SystemAnalyticsOverviewResponse,
  SystemAnalyticsProcessesResponse,
  SystemAnalyticsRange,
  SystemAnalyticsResourcesResponse,
  CodexCliModeDefaultsResponse,
  CodexHistoryPurgeExecuteRequest,
  CodexHistoryPurgePreviewResponse,
  CodexHistoryPurgeResponse,
  CodexResetCreditAvailability,
  CodexResetCreditRedemptionResponse,
  CodexLbSpeedDefaultsResponse,
  CodexLbSpeedTier,
  CodexUsageAccountList,
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
  PaneCliUploadSource,
  PaneCliUploadResponse,
  PaneCliWebSocketToken,
  Provider,
  ProviderSettings,
  ProviderSwitchResponse,
  ProviderSwitchTargets,
  ProviderValidationResult,
  CreateProviderInput,
  CreateBrowserCaptureJobRequest,
  CreateBrowserPageInput,
  ResumePaneCliSessionResponse,
  ReleasePreview,
  Room,
  UpdatePaneCliModelSettingsResult,
  UpdateCodexCliModeDefaultsInput,
  UpdateCliRuntimeSettingInput,
  UpdateCliRuntimeSettingResult,
  UpdateCliRuntimeVpnInput,
  UpdateCliRuntimeVpnResult,
  UpdateCliGlobalEgressResult,
  ReviewCheck,
  ReviewDecision,
  ReviewDiffSummary,
  ReviewRoomState,
  RoomCliActivityResponse,
  RoomPanesResult,
  RoomPaneLayoutResult,
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
  TelegramIntegrationStatus,
  TelegramPairingResponse,
  Turn,
  TurnRuntime,
  TurnStartResult,
  UpdateRoomInput,
  UpdatePaneLayoutInput,
  UpdateTelegramIntegrationInput,
  UserLink,
  CreateUserLinkRequest,
  UpdateUserLinkRequest,
  UpdateProviderInput,
  UpdateProviderSettingsInput,
  UpdateStreamingOverlaySettingsInput,
  VoiceRealtimeSessionResponse,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel,
  VoiceTranscriptionResponse,
  VoiceTranscriptionSettings,
  WorkerReadiness
} from "@space/contracts";
import { SpaceApiError } from "./runtime/SpaceRuntime.js";
import { reportCoreApiFailure, reportCoreApiSuccess } from "./core-api-availability.js";

export { SpaceApiError } from "./runtime/SpaceRuntime.js";

export type CodexThreadPresentation = "raw" | "chat";

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

export interface BrowserRecordingManifestPayload {
  durationMs: number;
  intervalMs?: number;
  fps: number;
  frameCount: number;
  startedAt: string;
  finishedAt: string;
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
    throw new Error(formatHttpFailure(response.status, payload));
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

const cliRuntimeRegistryCacheTtlMs = 10_000;
const cliRuntimeRegistryStaleTtlMs = 30 * 60_000;
const cliRuntimeRegistryRequestTimeoutMs = 8_000;
let cliRuntimeRegistryCache: { value: AgentRuntimeRegistry; expiresAt: number; staleUntil: number } | null = null;
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

function invalidateCliRuntimes(): void {
  if (cliRuntimeRegistryCache) cliRuntimeRegistryCache.expiresAt = 0;
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
  if (cliRuntimeSettingsCache) cliRuntimeSettingsCache.expiresAt = 0;
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
  const includeTranscript = options.includeTranscript !== false;
  const compactTranscript = options.compactTranscript === true;
  const key = activeCliSessionFlightKey(paneId, includeTranscript, compactTranscript);
  const existing = activeCliSessionFlights.get(key);
  if (existing) return existing;
  const params = new URLSearchParams();
  if (!includeTranscript) params.set("includeTranscript", "false");
  if (compactTranscript) params.set("compactTranscript", "true");
  const query = params.toString();
  const flight = request<PaneCliSessionResponse | null>(
    `/api/panes/${encodeURIComponent(paneId)}/cli/session${query ? `?${query}` : ""}`
  ).finally(() => {
    if (activeCliSessionFlights.get(key) === flight) activeCliSessionFlights.delete(key);
  });
  activeCliSessionFlights.set(key, flight);
  return flight;
}

export const api = {
  readyz: () => request<ReadyzPayload>("/readyz"),
  appVersion: () => request<AppVersionStatus>("/api/app/version"),
  eventStreamUrl,
  me: () => request<AuthMe>("/api/auth/me"),
  setupStatus: () => request<SetupStatus>("/api/setup/status"),
  claimSetup: (input: SetupClaimInput) =>
    request<SetupClaimResponse>("/api/setup/claim", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  setupOverview: () => request<SetupOverview>("/api/setup/overview"),
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
    });
  },
  logout: async () => {
    const result = await request<{ ok: true }>("/api/auth/logout", { method: "POST" });
    csrfToken = null;
    resetCliRuntimeSettingsCache();
    return result;
  },
  clipboardItems: (query: { q?: string; source?: ClipboardSource; includeCompleted?: boolean; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.source) params.set("source", query.source);
    if (query.includeCompleted !== undefined) params.set("includeCompleted", String(query.includeCompleted));
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
  taskItems: (query: { q?: string; status?: TaskStatus; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status) params.set("status", query.status);
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
  links: (query: { q?: string; isQuick?: boolean; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.isQuick !== undefined) params.set("isQuick", String(query.isQuick));
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<UserLink>>(`/api/links${suffix ? `?${suffix}` : ""}`);
  },
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
  rooms: (query: { page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set("page", String(query.page));
    if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
    const suffix = params.toString();
    return request<Paginated<Room>>(`/api/rooms${suffix ? `?${suffix}` : ""}`);
  },
  roomCliActivity: () => request<RoomCliActivityResponse>("/api/rooms/cli-activity"),
  createRoom: (name: string, initialPaneCount: number, reason?: string) =>
    request<Room>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, initialPaneCount, reason: reason?.trim() || undefined })
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
  sendRoomAgentMessage: (roomId: string, content: string, clientRequestId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/messages`, {
      method: "POST",
      body: JSON.stringify({ content, clientRequestId })
    }),
  stopRoomAgent: (roomId: string, reason: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/stop`, {
      method: "POST",
      body: JSON.stringify({ reason })
    }),
  controlRoomAgent: (roomId: string, input: { action: "PAUSE"; reason: string } | { action: "RESUME" }) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/control`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  clearRoomAgentTranscript: (roomId: string) =>
    request<RoomAgentSession>(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/transcript`, {
      method: "DELETE"
    }),
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
  agentSessions: (input?: { page?: number; pageSize?: number; includeArchived?: boolean; q?: string }) => {
    const params = new URLSearchParams();
    if (input) {
      if (input.page !== undefined) params.set("page", String(input.page));
      if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
      if (input.includeArchived) params.set("includeArchived", "true");
      if (input.q) params.set("q", input.q);
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
  recoveryCliTask: (paneId: string) =>
    request<CliTaskHistoryResponse>(`/api/panes/${encodeURIComponent(paneId)}/cli/recovery-task`),
  codexThread: (threadId: string, presentation?: CodexThreadPresentation) =>
    request<CodexThreadResponse>(
      `/api/codex/threads/${encodeURIComponent(threadId)}${presentation ? `?presentation=${encodeURIComponent(presentation)}` : ""}`
    ),
  codexEnvironment: () => request<CodexEnvironment>("/api/codex/environment"),
  toolbarUsageAccounts: () => request<CodexUsageAccountList>("/api/admin/codex-usage-accounts"),
  toolbarResetCredits: () => request<CodexResetCreditAvailability>("/api/admin/codex-reset-credits"),
  redeemToolbarResetCredit: (accountId: string, idempotencyKey: string) =>
    request<CodexResetCreditRedemptionResponse>(
      `/api/admin/codex-reset-credits/${encodeURIComponent(accountId)}/redemptions`,
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey }),
      }
    ),
  toolbarCliSessions: () => request<CliSessionStats>("/api/admin/cli-sessions"),
  toolbarModelStats: (_roomId: string, windowMinutes: number) =>
    request<ToolbarModelStats>(
      `/api/admin/toolbar-model-stats?windowMinutes=${encodeURIComponent(String(windowMinutes))}`
    ),
  systemAnalyticsOverview: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsOverviewResponse>(`/api/admin/system-analytics/overview?range=${encodeURIComponent(range)}`),
  systemAnalyticsModels: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsModelsResponse>(`/api/admin/system-analytics/models?range=${encodeURIComponent(range)}`),
  systemAnalyticsResources: (range: SystemAnalyticsRange) =>
    request<SystemAnalyticsResourcesResponse>(`/api/admin/system-analytics/resources?range=${encodeURIComponent(range)}`),
  systemAnalyticsProcesses: (input: {
    page?: number;
    pageSize?: number;
    sort?: "rss" | "cpu" | "pid" | "uptime" | "name";
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
  reapToolbarCliSessions: () => request<CliSessionReapResponse>("/api/admin/cli-session-reaps", {
    method: "POST",
    body: JSON.stringify({})
  }),
  toolbarHostMemory: () => request<HostMemoryDetails>("/api/admin/host-memory"),
  reclaimToolbarMemory: () => request<MemoryReclaimResponse>("/api/admin/memory-reclaims", {
    method: "POST",
    body: JSON.stringify({})
  }),
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
  toolbarProviderTargets: () => request<ProviderSwitchTargets>("/api/admin/provider-switch-targets"),
  switchToolbarProvider: (providerId: string) => request<ProviderSwitchResponse>("/api/admin/provider-switches", {
    method: "POST",
    body: JSON.stringify({ providerId })
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
    request<Paginated<Pane>>(
      `/api/panes?roomId=${encodeURIComponent(roomId)}${options.includeClosed ? "&includeClosed=true" : ""}`
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
  createAgentSession: (
    paneId: string,
    input: {
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
  sendAgentMessage: (paneId: string, content: string, selectedModelConfigId?: string | null, selectedToolIds?: string[], artifactIds?: string[]) =>
    request<AgentPaneSession>(`/api/panes/${encodeURIComponent(paneId)}/agent/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(selectedModelConfigId ? { selectedModelConfigId } : {}),
        ...(selectedToolIds ? { selectedToolIds } : {}),
        ...(artifactIds?.length ? { artifactIds } : {})
      })
    }),
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
  listCliAccountProfiles: (runtimeId: string) =>
    request<ListCliAccountProfilesResponse>(`/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles`),
  createCliAccountProfile: async (input: CreateCliAccountProfileInput) => {
    const result = await request<CreateCliAccountProfileResponse>(
      `/api/cli/runtimes/${encodeURIComponent(input.runtimeId)}/account-profiles`,
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    );
    invalidateCliRuntimeSettings();
    return result;
  },
  updateCliAccountProfile: async (runtimeId: string, profileId: string, input: UpdateCliAccountProfileInput) => {
    const result = await request<UpdateCliAccountProfileResponse>(
      `/api/cli/runtimes/${encodeURIComponent(runtimeId)}/account-profiles/${encodeURIComponent(profileId)}`,
      { method: "PATCH", body: JSON.stringify(input) }
    );
    invalidateCliRuntimeSettings();
    return result;
  },
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
    return result;
  },
  agentToolsCatalog: () => request<AgentToolsCatalogResponse>("/api/agent-tools/catalog"),
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
    invalidateCliRuntimes();
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
  codexCliModeDefaults: () => request<CodexCliModeDefaultsResponse>("/api/cli/codex-defaults"),
  updateCodexCliModeDefaults: (input: UpdateCodexCliModeDefaultsInput) =>
    request<CodexCliModeDefaultsResponse>("/api/cli/codex-defaults", {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  reportCliClientEvent: (input: CliTerminalClientEventInput) =>
    request<CliTerminalClientEventResponse>("/api/cli/client-events", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  activeCliSession: (
    paneId: string,
    options: { includeTranscript?: boolean; compactTranscript?: boolean } = {}
  ) => loadActiveCliSession(paneId, options),
  cliModelSettings: (paneId: string) =>
    request<PaneCliModelSettings>(`/api/panes/${encodeURIComponent(paneId)}/cli/model-settings`),
  cliModelSettingsStatus: (paneId: string) =>
    request<PaneCliModelSettingsStatus>(`/api/panes/${encodeURIComponent(paneId)}/cli/model-settings/status`),
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
  setBrowserViewport: (paneId: string, viewport: BrowserSessionViewport) =>
    request<PaneBrowserSessionResponse>(`/api/panes/${encodeURIComponent(paneId)}/browser/viewport`, {
      method: "POST",
      body: JSON.stringify({ viewport })
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
    const params = new URLSearchParams({ sessionId: ticket.sessionId, token: ticket.token, mode });
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
    return request<Paginated<Turn>>(`/api/turns${suffix ? `?${suffix}` : ""}`);
  },
  events: (query?: { roomId?: string; page?: number; pageSize?: number; sortOrder?: "asc" | "desc" }) => {
    const params = new URLSearchParams();
    if (query?.roomId) params.set("roomId", query.roomId);
    if (query?.page) params.set("page", String(query.page));
    if (query?.pageSize) params.set("pageSize", String(query.pageSize));
    if (query?.sortOrder) params.set("sortOrder", query.sortOrder);
    const suffix = params.toString();
    return request<Paginated<Event>>(`/api/events${suffix ? `?${suffix}` : ""}`);
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
  createVoiceRealtimeCall: (input: {
    offerSdp: string;
    model: VoiceTranscriptionModel;
    language: VoiceTranscriptionLanguage;
    delay: VoiceTranscriptionDelay;
  }) =>
    request<VoiceRealtimeSessionResponse>("/api/voice/realtime/calls", {
      method: "POST",
      body: JSON.stringify(input)
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
    source: "USER_UPLOAD" | "CLIPBOARD" | "DROP" | "SCREEN_CAPTURE";
    files: File[];
  }) => {
    const params = new URLSearchParams({ roomId: input.roomId, source: input.source });
    if (input.paneId) params.set("paneId", input.paneId);
    const form = new FormData();
    input.files.forEach((file) => form.append("file", file, file.name || "upload"));
    return request<{ artifacts: Artifact[] }>(`/api/artifacts/file-uploads?${params.toString()}`, {
      method: "POST",
      body: form
    });
  },
  captureScreen: (input: { roomId: string; paneId?: string | null; viewport?: BrowserEvidenceViewport }) =>
    request<BrowserEvidenceCapture & { artifact: Artifact }>(`/api/rooms/${encodeURIComponent(input.roomId)}/screen-capture`, {
      method: "POST",
      body: JSON.stringify({
        paneId: input.paneId ?? null,
        viewport: input.viewport ?? "desktop"
      })
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
  launchReadiness: () => request<LaunchReadiness>("/api/admin/launch-readiness"),
  observability: () => request<ObservabilitySnapshot>("/api/admin/observability"),
  worker: () => request<WorkerReadiness>("/api/admin/worker")
};
