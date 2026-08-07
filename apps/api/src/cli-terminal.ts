import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import {
  CliHostClient,
  CliHostError,
  type CliHostAttachInput,
  type CliHostAttachResult,
  type CliHostEvent,
  type CliHostEventListener,
  type CliHostHealth,
  type CliHostIdentity,
  type CliHostInputResult,
  type CliHostReapResult,
  type CliHostSessionSummary
} from "@space/cli-host";
import {
  canStartAgentRuntimeLogin,
  cliToggleRuntimeIdSchema,
  reasoningEffortSchema,
  paneCliWebSocketClientMessageSchema,
  paneCliWebSocketServerMessageSchema,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type CliTerminalTelemetryOutcome,
  type CliTerminalTelemetryReason,
  type CodexCliModeDefaultPair,
  type Pane,
  type PaneCliClientMode,
  type PaneCliSession,
  type PaneCliTerminalControlLease,
  type PaneCliTerminalControlState,
  type PaneCliTranscriptChunk,
  type PaneCliTurnActivityResponse,
  type PaneCliWebSocketClientMessage,
  type PaneCliWebSocketServerMessage,
  type PaneCliWebSocketToken
} from "@space/contracts";
import {
  SpaceConflictError,
  SpaceFeatureDisabledError,
  SpaceNotFoundError,
  nowIso,
  redactMemoryText,
  type SpaceStore
} from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import {
  cliAgentFilesApiBaseUrl,
  cliAgentFilesEnabled,
  issueCliAgentFilesToken
} from "./cli-agent-files.js";
import { cliBrowserBridgeApiBaseUrl, cliBrowserBridgeEnabled, issueCliBrowserBridgeToken } from "./cli-browser-bridge.js";
import {
  codexDirectParityCodexHome,
  codexDirectParityCwd,
  codexDirectParityHome,
  isDirectOperatorParityRuntime,
  isCodexDirectParityRuntime,
  resolveDirectOperatorParityCwd
} from "./cli-parity.js";
import { findCliRuntimeDescriptor } from "./cli-runtime-descriptors.js";
import { opencodeNativeSessionIdPattern } from "./opencode-native-session.js";
import {
  activeCliSessionObserverRuntime,
  isCliRuntimeTerminalLaunchable
} from "./cli-runtimes.js";
import {
  findCurrentCodexCliTurnActivity,
  findRecentCodexCliTurnActivity,
  findRecentNullAgentMessageDiagnostic,
  type CodexCliTurnActivity
} from "./codex-rollout-diagnostics.js";

const execFileAsync = promisify(execFile);
const codexThreadUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codexModelIdPattern = /^[A-Za-z0-9._:-]+$/;
const codexReasoningEffortPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const codexThreadBindRetryMs = 4_000;
const codexThreadBindMaxMs = 30_000;
const cliTurnMarkerTtlMs = 15 * 60_000;
const cliStartupReadyTimeoutMs = 15_000;
const cliLoginTimeoutMs = 15 * 60_000;
const cliLoginObservationIntervalMs = 1_000;
const cliCredentialObservationTimeoutMs = 5_000;
const cliCredentialSmokeTimeoutMs = 190_000;
const cliCredentialNotReadyObservation = "NOT_READY";
const cliHostMainConnectionCount = 32;
const codexInputReadySettleMs = 100;
const codexModelSelectionTimeoutMs = 8_000;
const codexModelCommandSubmitDelayMs = 150;
const codexModelNavigationRepaintSettleMs = 25;
const qwenAuthBootstrapSettleMs = 250;
const cliHostOutputBatchDelayMs = 20;
const cliHostOutputBatchMaxBytes = 32 * 1024;
const cliTerminalControlLeaseTtlSeconds = 30;
const cliTerminalControlHeartbeatIntervalMs = 10_000;
const cliTerminalControlReconnectGraceSeconds = 5;
const codexHomeKey = "\u001b[H";
const codexArrowDownKey = "\u001b[B";
const codexControlAnsiPattern = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

function cliControlDeniedTelemetryReason(code: string): CliTerminalTelemetryReason {
  if (code === "CLI_CONTROL_REQUIRED") return "CONTROL_REQUIRED";
  if (code === "CLI_LEASE_STALE") return "LEASE_STALE";
  if (code === "CLI_CONTROL_HELD") return "CONTROL_HELD";
  if (code === "CLI_OBSERVER_MUTATION_DENIED") return "OBSERVER_DENIED";
  if (code === "CLI_PROTOCOL_REQUIRED") return "PROTOCOL_REQUIRED";
  return "UNKNOWN";
}

class CliLoginConnectionReconciledError extends Error {
  constructor() {
    super("CLI login lifecycle was reconciled from the persistent host.");
    this.name = "CliLoginConnectionReconciledError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexStartupProgressIndex(output: string): number {
  const normalized = output.replace(codexControlAnsiPattern, "").toLowerCase();
  return Math.max(
    normalized.lastIndexOf("starting mcp servers"),
    normalized.lastIndexOf("reconnecting"),
    normalized.lastIndexOf("connecting")
  );
}

function latestCodexModelState(output: string): {
  status: string;
  headerEndIndex: number;
  normalizedOutput: string;
} | null {
  const normalized = output.replace(codexControlAnsiPattern, "").toLowerCase();
  const latestHeaderIndex = normalized.lastIndexOf("openai codex");
  if (latestHeaderIndex < 0) return null;
  const latestScreen = normalized.slice(latestHeaderIndex);
  let state: { status: string; headerEndIndex: number; normalizedOutput: string } | null = null;
  for (const match of latestScreen.matchAll(
    /\bmodel:\s*([a-z0-9][a-z0-9._:-]*)(?:\s+[a-z0-9][a-z0-9._:-]*)?\s+\/(?:[ \t]*\r?\n[ \t]*)?model\b/g
  )) {
    if (!match[1] || match.index === undefined) continue;
    state = {
      status: match[1],
      headerEndIndex: latestHeaderIndex + match.index + match[0].length,
      normalizedOutput: normalized
    };
  }
  return state;
}

function codexStartupBusy(output: string): boolean {
  const modelState = latestCodexModelState(output);
  const normalized = modelState?.normalizedOutput ?? output.replace(codexControlAnsiPattern, "").toLowerCase();
  return modelState?.status === "loading" || codexStartupProgressIndex(normalized) > normalized.lastIndexOf("›");
}

export function codexInputReady(output: string): boolean {
  const modelState = latestCodexModelState(output);
  if (!modelState) {
    const normalized = output.replace(codexControlAnsiPattern, "").toLowerCase();
    const promptIndex = normalized.lastIndexOf("›");
    return normalized.lastIndexOf("openai codex") < 0 &&
      promptIndex >= 0 &&
      promptIndex > codexStartupProgressIndex(normalized);
  }
  if (modelState.status === "loading") return false;
  const promptIndex = modelState.normalizedOutput.lastIndexOf("›");
  return promptIndex > modelState.headerEndIndex &&
    promptIndex > codexStartupProgressIndex(modelState.normalizedOutput);
}

function qwenAuthBootstrapReady(output: string): boolean {
  const normalized = output.replace(codexControlAnsiPattern, "").replaceAll("\r", "").toLowerCase();
  const promptIndex = normalized.lastIndexOf("type your message or @path/to/file");
  return promptIndex >= 0 && normalized.lastIndexOf("yolo mode") > promptIndex;
}

interface TicketRecord {
  paneId: string;
  sessionId: string;
  expiresAtMs: number;
}

interface CliTerminalSocketContext {
  protocolVersion: 1 | 2;
  userId: string;
  clientId: string | null;
  browserClientId: string | null;
  tabLineageId: string | null;
  pageClientId: string | null;
  clientMode: PaneCliClientMode;
  requestedLeaseId: string | null;
  proofScope: "READ_ONLY" | null;
  leaseId: string | null;
  requestId: string;
  connectionOrder: number;
  detached: boolean;
}

interface CliTerminalResolvedControl {
  controlState: PaneCliTerminalControlState;
  lease: PaneCliTerminalControlLease | null;
}

interface CliHostOutputBatch {
  generationId: string;
  outputSequence: number;
  stream: "stdout" | "stderr";
  content: string;
  byteLength: number;
}

interface ManagedCliSession {
  identity: CliHostIdentity;
  attachmentId: string;
  attachmentRecovery: Promise<void> | null;
  generationId: string;
  paneId: string;
  roomId: string;
  sessionId: string;
  runtimeId: string;
  purpose: PaneCliSession["purpose"];
  credentialObservation: string | null;
  credentialSmokeRetryObservation: string | null;
  qwenAuthBootstrapTimer: ReturnType<typeof setTimeout> | null;
  qwenAuthBootstrapSent: boolean;
  cwd: string | null;
  sockets: Set<WebSocket>;
  clientSockets: Map<string, { socket: WebSocket; connectionOrder: number }>;
  socketClients: Map<WebSocket, CliTerminalSocketContext>;
  legacyControllerSocket: WebSocket | null;
  socketReplayBuffers: Map<WebSocket, string[]>;
  closed: boolean;
  detached: boolean;
  transportReady: boolean;
  inputReady: boolean;
  codexModelControlReady: boolean;
  startupOutput: string;
  pendingHostEvents: CliHostEvent[];
  pendingHostOutput: CliHostOutputBatch | null;
  hostOutputQueue: CliHostOutputBatch[];
  hostOutputFlushTimer: ReturnType<typeof setTimeout> | null;
  nextTranscriptSequence: number;
  persistQueue: Promise<void>;
  controlQueue: Promise<void>;
  controlOutput: string;
  controlOutputRevision: number;
  reportedNullAgentMessageTurns: Set<string>;
  nullAgentMessageCheckSinceMs: number | null;
  nullAgentMessageCheckUntilMs: number;
  nullAgentMessageCheckInputText: string | null;
  nullAgentMessageCheckTimer: ReturnType<typeof setTimeout> | null;
  codexThreadId: string | null;
  codexThreadBindSinceMs: number | null;
  codexThreadBindUntilMs: number;
  codexThreadBindTimer: ReturnType<typeof setTimeout> | null;
  turnMarkers: Map<string, CliTurnMarker>;
}

export interface CodexCliModelSelectionOption {
  id: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly string[];
}

interface CodexCliModelCommandStep {
  type: "command";
  input: "/model";
}

interface CodexCliModelSelectStep {
  type: "select";
  index: number;
  targetLabels: string[];
  menuLabels?: string[];
}

type CodexCliModelNavigationStep = CodexCliModelCommandStep | CodexCliModelSelectStep;

function isAdvancedCodexReasoningEffort(effort: string): boolean {
  return effort === "max" || effort === "ultra";
}

function uniqueLabels(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function codexReasoningEffortLabel(effort: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[effort] ?? effort;
}

function modelLabels(model: CodexCliModelSelectionOption): string[] {
  return uniqueLabels([model.id, model.displayName]);
}

function reasoningLabels(effort: string): string[] {
  return uniqueLabels([
    codexReasoningEffortLabel(effort),
    effort,
    ...(effort === "xhigh" ? ["Extra high"] : [])
  ]);
}

function menuLabels(models: readonly CodexCliModelSelectionOption[]): string[] {
  return uniqueLabels(models.flatMap(modelLabels));
}

function reasoningMenuLabels(efforts: readonly string[], includeMoreReasoning: boolean): string[] {
  return uniqueLabels([
    ...efforts.flatMap(reasoningLabels),
    ...(includeMoreReasoning ? ["More reasoning"] : [])
  ]);
}

export function buildCodexCliPreThreadModelNavigation(input: {
  models: readonly CodexCliModelSelectionOption[];
  modelId: string;
  reasoningEffort: string;
}): CodexCliModelNavigationStep[] {
  const selectedModel = input.models.find((model) => model.id === input.modelId);
  if (!selectedModel || !selectedModel.supportedReasoningEfforts.includes(input.reasoningEffort)) {
    throw new SpaceConflictError("The selected model and reasoning effort are not available in the Codex terminal menu.");
  }

  const steps: CodexCliModelNavigationStep[] = [{ type: "command", input: "/model" }];
  const autoModels = input.models.filter((model) => model.id.startsWith("codex-auto-"));
  const ordinaryModels = input.models.filter((model) => !model.id.startsWith("codex-auto-"));
  const selectedAutoIndex = autoModels.findIndex((model) => model.id === input.modelId);

  if (autoModels.length && selectedAutoIndex < 0) {
    steps.push({
      type: "select",
      index: autoModels.length,
      targetLabels: ["All models"],
      menuLabels: uniqueLabels([...menuLabels(autoModels), "All models"])
    });
  }

  const selectableModels = selectedAutoIndex >= 0 ? autoModels : ordinaryModels;
  const modelIndex = selectableModels.findIndex((model) => model.id === input.modelId);
  if (modelIndex < 0) {
    throw new SpaceConflictError("The selected model is not available in the Codex terminal menu.");
  }
  steps.push({
    type: "select",
    index: modelIndex,
    targetLabels: modelLabels(selectedModel),
    menuLabels: menuLabels(selectableModels)
  });

  const hasAdvancedEffort = selectedModel.supportedReasoningEfforts.some(isAdvancedCodexReasoningEffort);
  const appliesImmediately = selectedAutoIndex >= 0
    ? !hasAdvancedEffort
    : selectedModel.supportedReasoningEfforts.length === 1 && !hasAdvancedEffort;
  if (appliesImmediately) {
    const immediateEffort = selectedAutoIndex >= 0
      ? selectedModel.defaultReasoningEffort
      : selectedModel.supportedReasoningEfforts[0];
    if (immediateEffort !== input.reasoningEffort) {
      throw new SpaceConflictError("The requested reasoning effort cannot be selected from the Codex terminal menu.");
    }
    return steps;
  }

  const standardEfforts = selectedModel.supportedReasoningEfforts.filter(
    (effort) => !isAdvancedCodexReasoningEffort(effort)
  );
  if (!isAdvancedCodexReasoningEffort(input.reasoningEffort)) {
    const effortIndex = standardEfforts.indexOf(input.reasoningEffort);
    steps.push({
      type: "select",
      index: effortIndex,
      targetLabels: reasoningLabels(input.reasoningEffort),
      menuLabels: reasoningMenuLabels(standardEfforts, hasAdvancedEffort)
    });
    return steps;
  }

  steps.push({
    type: "select",
    index: standardEfforts.length,
    targetLabels: ["More reasoning"],
    menuLabels: reasoningMenuLabels(standardEfforts, true)
  });
  const advancedEfforts = selectedModel.supportedReasoningEfforts.filter(isAdvancedCodexReasoningEffort);
  steps.push({
    type: "select",
    index: advancedEfforts.indexOf(input.reasoningEffort),
    targetLabels: reasoningLabels(input.reasoningEffort),
    menuLabels: reasoningMenuLabels(advancedEfforts, false)
  });
  return steps;
}

function codexControlRows(output: string): string[] {
  return output
    .replace(codexControlAnsiPattern, "")
    .replace(/\r(?!\n)/g, "\n")
    .split(/\r?\n/)
    .map((row) => row.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trimEnd())
    .filter((row) => row.trim().length > 0);
}

function rowContainsTarget(row: string, targetLabels: readonly string[]): boolean {
  return targetLabels.some((label) => {
    const escaped = escapeRegularExpression(label.trim());
    if (!escaped) return false;
    return new RegExp(`(?:^|[\\s›❯>])${escaped}(?=$|[\\s·•:;—–()…]|\\.{3})`, "i").test(row);
  });
}

export function codexControlMenuHasTarget(output: string, targetLabels: readonly string[]): boolean {
  return codexControlRows(output).some((row) => rowContainsTarget(row, targetLabels));
}

export function codexControlMenuHighlightsTarget(output: string, targetLabels: readonly string[]): boolean {
  const rows = codexControlRows(output);
  return targetLabels.some((label) => {
    const escaped = escapeRegularExpression(label.trim());
    if (!escaped) return false;
    const highlightedTargetPattern = new RegExp(
      `[›❯>]\\s+(?:\\d+\\s*[.)]\\s*)?${escaped}(?=$|[\\s·•:;—–()…]|\\.{3})`,
      "i"
    );
    // Responsive terminal repaints can join adjacent visual menu rows without a newline.
    return rows.some((row) => highlightedTargetPattern.test(row));
  });
}

interface CliTurnMarker {
  markerAtMs: number;
  turnId: string | null;
  expiresAtMs: number;
}

interface ManagedCliSessionAttach {
  managed: ManagedCliSession;
  transcriptSeed: PaneCliTranscriptChunk[] | null;
  spawned: boolean;
  restoredTransport: boolean;
  recreatedAfterHostLoss: boolean;
  replayContinuity: "COMPLETE" | "TRUNCATED";
}

interface CliSessionAllocationRecord {
  allocatedAtNs: bigint;
  recordedAtNs: bigint;
}

const cliSessionAllocationRetentionNs = 10n * 60n * 1_000_000_000n;
const maxPendingCliSessionAllocations = 2_048;

export interface CliEnvironmentContext {
  roomId?: string | null;
  paneId?: string | null;
  cliSessionId?: string | null;
  runtimeId?: string | null;
  purpose?: PaneCliSession["purpose"] | null;
  cwd?: string | null;
  sessionAllocatedMonotonicNs?: string | null;
}

interface CliTerminalConnection {
  handleMessage(raw: WebSocket.RawData): Promise<void>;
  detach(): Promise<void>;
}

export interface CliLoginVerificationEvidence {
  fingerprintHash: string;
}

export interface CliTerminalManagerOptions {
  store: SpaceStore;
  config: SpaceApiConfig;
  discoverRuntimes: () => Promise<AgentRuntimeRegistry>;
  findCodexThreadId?: CodexThreadFinder;
  findCodexThreadResumeSettings?: CodexThreadResumeSettingsFinder;
  findCodexCliTurnActivity?: CodexCliTurnActivityFinder;
  findCurrentCodexCliTurnActivity?: CodexCliCurrentTurnActivityFinder;
  findRecentNullAgentMessageDiagnostic?: typeof findRecentNullAgentMessageDiagnostic;
  hostClient?: CliHostGateway;
  adminHostClient?: CliHostGateway;
  startupReadyTimeoutMs?: number;
  modelSelectionTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginObservationIntervalMs?: number;
  codexBuildDefaultsProvider?: () => Promise<CodexCliModeDefaultPair>;
  onLoginSucceeded?: (
    loginSession: PaneCliSession,
    evidence?: CliLoginVerificationEvidence
  ) => Promise<string>;
  onLoginFailed?: (
    loginSession: PaneCliSession,
    outcome: "CANCELLED" | "TIMEOUT" | "PROVIDER_FAILURE"
  ) => Promise<void>;
  onTelemetry?: (event: CliTerminalManagerTelemetryEvent) => void;
}

export interface CliTerminalManagerTelemetryEvent {
  event:
    | "SOCKET_ATTACHED"
    | "SOCKET_DETACHED"
    | "RECONNECT_GRACE_STARTED"
    | "CONTROL_ACQUIRED"
    | "CONTROL_RENEWED"
    | "CONTROL_RELEASED"
    | "CONTROL_TAKEN_OVER"
    | "CONTROL_DENIED";
  outcome: CliTerminalTelemetryOutcome;
  reason: CliTerminalTelemetryReason;
  paneId: string;
  roomId: string;
  sessionId: string;
  runtimeId: string;
  protocolVersion?: 1 | 2;
  clientMode?: PaneCliClientMode;
  controlState?: PaneCliTerminalControlState;
  socketCount: number;
  requestId?: string;
}

export interface CliHostGateway {
  health(): Promise<CliHostHealth>;
  inspect(identity: CliHostIdentity): Promise<CliHostSessionSummary | null>;
  attach(input: CliHostAttachInput, listener?: CliHostEventListener): Promise<CliHostAttachResult>;
  input(
    identity: CliHostIdentity,
    attachmentId: string,
    data: string,
    display?: "visible" | "hidden",
    idempotencyKey?: string
  ): Promise<CliHostInputResult | void>;
  resize(identity: CliHostIdentity, attachmentId: string, cols: number, rows: number): Promise<void>;
  detach(identity: CliHostIdentity, attachmentId: string): Promise<boolean>;
  terminate(identity: CliHostIdentity): Promise<boolean>;
  reapDetached?(): Promise<CliHostReapResult>;
  close(): Promise<void>;
}

export interface CliHostReapAggregate {
  killedSessions: Array<{ hostId: "main" | "root"; cliSessionId: string }>;
  skippedCount: number;
  failedHostCount: number;
}

interface FindSafeCodexThreadIdInput {
  codexHome?: string;
  paneId: string;
  sessionId: string;
  cwd: string | null;
}

export type CodexThreadFinder = (input: FindSafeCodexThreadIdInput) => Promise<string | null>;

export interface FindCodexCliTurnActivityInput {
  codexHome: string;
  threadId: string;
  markerAtMs: number;
  turnId: string | null;
  inputMarker?: string;
}

export type CodexCliTurnActivityFinder = (input: FindCodexCliTurnActivityInput) => Promise<CodexCliTurnActivity>;

export type CodexCliCurrentTurnActivityFinder = (input: {
  codexHome: string;
  threadId: string;
}) => Promise<CodexCliTurnActivity>;

export interface FindSafeCodexThreadResumeSettingsInput {
  codexHome?: string;
  threadId: string;
  cwd: string | null;
}

export interface CodexThreadResumeSettings {
  modelId: string;
  reasoningEffort: string | null;
}

export type CodexThreadResumeSettingsFinder = (
  input: FindSafeCodexThreadResumeSettingsInput
) => Promise<CodexThreadResumeSettings | null>;

const codexCliAnsiEscapePattern = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findLatestCodexCliTranscriptModelSettings(
  transcript: string,
  cwd: string | null
): CodexThreadResumeSettings | null {
  if (!cwd) return null;
  const normalized = transcript.replace(codexCliAnsiEscapePattern, " ").replace(/\s+/g, " ");
  const pattern = new RegExp(
    `([A-Za-z0-9._:-]{1,160})\\s+([A-Za-z0-9][A-Za-z0-9._-]{0,79})\\s*[·•]\\s*${escapeRegularExpression(cwd)}(?:\\s|$)`,
    "gi"
  );
  let latest: CodexThreadResumeSettings | null = null;
  for (const match of normalized.matchAll(pattern)) {
    latest = { modelId: match[1]!, reasoningEffort: match[2]! };
  }
  return latest;
}

export async function resolveCodexThreadRuntimeSettings(input: {
  transcript: string;
  threadId: string;
  cwd: string | null;
  codexHome?: string;
  fallback?: CodexThreadResumeSettingsFinder;
}): Promise<CodexThreadResumeSettings | null> {
  const terminalSettings = findLatestCodexCliTranscriptModelSettings(input.transcript, input.cwd);
  if (terminalSettings) return terminalSettings;
  const fallback = input.fallback ?? findSafeCodexThreadResumeSettings;
  return fallback({
    ...(input.codexHome ? { codexHome: input.codexHome } : {}),
    threadId: input.threadId,
    cwd: input.cwd
  });
}

type CliSpawnSession = Pick<PaneCliSession, "codexThreadId" | "modelId"> & {
  purpose?: PaneCliSession["purpose"];
  reasoningEffort?: PaneCliSession["reasoningEffort"];
  launchMode?: PaneCliSession["launchMode"];
  codexForkThreadId?: string | null;
  codexResumeModelId?: string | null;
  codexResumeReasoningEffort?: string | null;
  nativeTaskRef?: string | null;
};

export function supportsNativeCliResume(runtimeId: string): boolean {
  return Boolean(findCliRuntimeDescriptor(runtimeId)?.nativeResumeArgs);
}

export function resolveCodexCliLaunchSettings(
  config: Pick<SpaceApiConfig, "cliCodexDefaultModel" | "cliCodexDefaultReasoningEffort">,
  pane: Pick<Pane, "modelId" | "reasoningEffort">,
  selection: { modelId?: string | null; reasoningEffort?: string } = {}
): { modelId: string; reasoningEffort: Pane["reasoningEffort"] } | null {
  const persistedModelId = pane.modelId && codexModelIdPattern.test(pane.modelId) ? pane.modelId : null;
  const modelId = selection.modelId ?? config.cliCodexDefaultModel ?? persistedModelId;
  const reasoningEffort =
    selection.reasoningEffort ??
    (selection.modelId !== undefined && selection.modelId !== null && persistedModelId
      ? pane.reasoningEffort
      : config.cliCodexDefaultReasoningEffort) ??
    (persistedModelId ? pane.reasoningEffort : null);
  if (!modelId || !codexModelIdPattern.test(modelId)) return null;
  const persistedReasoningEffort = reasoningEffortSchema.safeParse(reasoningEffort).data;
  if (!persistedReasoningEffort || !codexReasoningEffortPattern.test(persistedReasoningEffort)) return null;
  return { modelId, reasoningEffort: persistedReasoningEffort };
}

function parseSocketData(raw: WebSocket.RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

const terminalOutputFrameMaxBytes = 8 * 1024;
const terminalReplayFramesPerYield = 16;

function chunkTerminalOutput(data: string): string[] {
  if (Buffer.byteLength(data, "utf8") <= terminalOutputFrameMaxBytes) return [data];
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  for (const symbol of data) {
    const symbolBytes = Buffer.byteLength(symbol, "utf8");
    if (chunkBytes > 0 && chunkBytes + symbolBytes > terminalOutputFrameMaxBytes) {
      chunks.push(data.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += symbolBytes;
    index += symbol.length;
  }
  if (chunkStart < data.length) chunks.push(data.slice(chunkStart));
  return chunks.length ? chunks : [data];
}

function sanitizeCliTerminalInput(runtimeId: string, data: string): string {
  return isCodexDirectParityRuntime(runtimeId) ? data.replaceAll("\0", "") : data;
}

function normalizedLocale(value: string | undefined): string {
  if (!value || value === "undefined" || value === "null") return "C.UTF-8";
  return value;
}

export function buildCliEnvironment(config: SpaceApiConfig, context: CliEnvironmentContext = {}): Record<string, string | undefined> {
  if (context.runtimeId === "cli:root") {
    const agentFilesToken = context.purpose === "LOGIN" ? null : issueCliAgentFilesToken(config, context);
    const commandPath = config.cliCommandPath ?? "/opt/spaceapp/bin";
    return {
      HOME: "/root",
      LANG: normalizedLocale(process.env.LANG),
      LC_ALL: normalizedLocale(process.env.LC_ALL),
      LOGNAME: "root",
      PATH: `${commandPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      SHELL: "/bin/bash",
      SPACE_AGENT_CHANNEL: "CLI",
      SPACE_AGENT_FILES_ENABLED: agentFilesToken ? "true" : cliAgentFilesEnabled(config) ? "unavailable" : "false",
      SPACE_AGENT_FILES_ENDPOINT: agentFilesToken ? `${cliAgentFilesApiBaseUrl(config)}/api/cli/agent-files` : undefined,
      SPACE_AGENT_FILES_TOKEN: agentFilesToken ?? undefined,
      SPACE_AGENT_RUNTIME_ID: context.runtimeId ?? undefined,
      SPACE_CLI_RUNTIME_ID: context.runtimeId ?? undefined,
      SPACE_CLI_SESSION_ID: context.cliSessionId ?? undefined,
      SPACE_PANE_ID: context.paneId ?? undefined,
      SPACE_ROOM_ID: context.roomId ?? undefined,
      TERM: "xterm-256color",
      USER: "root"
    };
  }
  const commandPath = config.cliCommandPath ?? "/usr/local/bin";
  const runtimeDescriptor = findCliRuntimeDescriptor(context.runtimeId);
  const directCodexParity = isCodexDirectParityRuntime(context.runtimeId);
  const directOperatorParity = isDirectOperatorParityRuntime(context.runtimeId);
  const managedHome = config.codexAppServerHome ?? undefined;
  const home = directOperatorParity ? codexDirectParityHome : managedHome ?? process.env.HOME;
  const tempDir = runtimeDescriptor?.tempDir ?? (managedHome ? join(managedHome, "tmp") : undefined);
  const user = directOperatorParity ? "spaceapp-user" : process.env.USER && process.env.USER !== "root" ? process.env.USER : "space";
  const logname = directOperatorParity ? "spaceapp-user" : process.env.LOGNAME && process.env.LOGNAME !== "root" ? process.env.LOGNAME : user;
  const shell =
    process.env.SHELL && !process.env.SHELL.endsWith("/nologin") && !process.env.SHELL.endsWith("/false")
      ? process.env.SHELL
      : "/bin/bash";
  const env: Record<string, string | undefined> = {
    COLORTERM: "truecolor",
    CODEX_MCP_SESSION_ID: directOperatorParity ? context.cliSessionId ?? undefined : undefined,
    HOME: home,
    LANG: normalizedLocale(process.env.LANG),
    LC_ALL: normalizedLocale(process.env.LC_ALL),
    LOGNAME: logname,
    PATH: `${commandPath}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    SPACE_AGENT_CHANNEL: "CLI",
    SPACE_AGENT_RUNTIME_ID: context.runtimeId ?? undefined,
    SPACE_CLI_RUNTIME_ID: context.runtimeId ?? undefined,
    SPACE_CLI_SESSION_ALLOCATED_MONOTONIC_NS: directCodexParity ? context.sessionAllocatedMonotonicNs ?? undefined : undefined,
    SPACE_CLI_SESSION_ID: context.cliSessionId ?? undefined,
    SPACE_CODEX_PER_SESSION_APP_SERVER: directCodexParity ? "1" : undefined,
    SPACE_CLI_WORKSPACE: context.cwd ?? undefined,
    SPACE_PANE_ID: context.paneId ?? undefined,
    SPACE_ROOM_ID: context.roomId ?? undefined,
    SHELL: shell,
    TERM: "xterm-256color",
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    USER: user
  };
  if (home) {
    if (runtimeDescriptor) Object.assign(env, runtimeDescriptor.environment);
    else env.CODEX_HOME = home;
  }
  if (runtimeDescriptor?.loginBootstrapRuntimeEnv && config.cliLoginBootstrap[runtimeDescriptor.key]) {
    env[runtimeDescriptor.loginBootstrapRuntimeEnv] = "1";
  }
  const cliBrowserBridgeToken = context.purpose === "LOGIN" ? null : issueCliBrowserBridgeToken(config, context);
  if (cliBrowserBridgeToken) {
    const apiBaseUrl = cliBrowserBridgeApiBaseUrl(config);
    env.SPACE_BROWSER_BRIDGE_ENABLED = "true";
    env.SPACE_BROWSER_CONTEXT_ENDPOINT = `${apiBaseUrl}/api/cli/browser/context`;
    env.SPACE_BROWSER_SESSION_ENDPOINT = `${apiBaseUrl}/api/cli/browser/session`;
    env.SPACE_BROWSER_ACTION_ENDPOINT = `${apiBaseUrl}/api/cli/browser/actions`;
    env.SPACE_BROWSER_COMMAND_ENDPOINT = `${apiBaseUrl}/api/cli/browser/commands`;
    env.SPACE_BROWSER_ACTION_TOKEN = cliBrowserBridgeToken;
  } else {
    env.SPACE_BROWSER_BRIDGE_ENABLED = cliBrowserBridgeEnabled(config) ? "unavailable" : "false";
  }
  const cliAgentFilesToken = context.purpose === "LOGIN" ? null : issueCliAgentFilesToken(config, context);
  if (cliAgentFilesToken) {
    env.SPACE_AGENT_FILES_ENABLED = "true";
    env.SPACE_AGENT_FILES_ENDPOINT = `${cliAgentFilesApiBaseUrl(config)}/api/cli/agent-files`;
    env.SPACE_AGENT_FILES_TOKEN = cliAgentFilesToken;
  } else {
    env.SPACE_AGENT_FILES_ENABLED = cliAgentFilesEnabled(config) ? "unavailable" : "false";
  }
  const keyFile = config.codexAppServerKeyFile ?? config.codexLbKeyFile;
  if (!directOperatorParity && keyFile) {
    env[config.codexAppServerKeyEnv] = readFileSync(keyFile, "utf8").trim();
  }
  return env;
}

export function buildCliSpawnArgs(runtime: AgentRuntime, session?: CliSpawnSession | null): string[] {
  const runtimeDescriptor = findCliRuntimeDescriptor(runtime.id);
  if (session?.purpose === "LOGIN") {
    if (runtimeDescriptor?.loginAction !== "login") {
      throw new SpaceFeatureDisabledError(
        "CLI_LOGIN_UNAVAILABLE",
        `CLI runtime ${runtime.id} does not support terminal login.`
      );
    }
    return [runtimeDescriptor.loginAction];
  }
  if (
    session?.launchMode === "RESUME" &&
    runtime.id === "cli:opencode" &&
    session.nativeTaskRef &&
    opencodeNativeSessionIdPattern.test(session.nativeTaskRef)
  ) {
    return ["--session", session.nativeTaskRef];
  }
  if (session?.launchMode === "RESUME" && runtimeDescriptor?.nativeResumeArgs) {
    return [...runtimeDescriptor.nativeResumeArgs];
  }
  if (runtime.id === "cli:codex" || runtime.commandName === "codex") {
    const threadId = session?.codexForkThreadId ?? session?.codexThreadId;
    if (threadId) {
      const isFork = Boolean(session?.codexForkThreadId);
      const args = [isFork ? "fork" : "resume"];
      const modelId = isFork
        ? session?.codexResumeModelId ?? session?.modelId
        : session?.codexResumeModelId;
      const reasoningEffort = isFork
        ? session?.codexResumeReasoningEffort ?? session?.reasoningEffort
        : session?.codexResumeReasoningEffort;
      if (modelId && codexModelIdPattern.test(modelId)) {
        args.push("--model", modelId);
        if (
          reasoningEffort &&
          codexReasoningEffortPattern.test(reasoningEffort)
        ) {
          args.push("--config", `model_reasoning_effort=${reasoningEffort}`);
        }
      }
      args.push("--no-alt-screen", threadId);
      return args;
    }
    if (
      !session?.modelId ||
      !codexModelIdPattern.test(session.modelId) ||
      !session.reasoningEffort ||
      !codexReasoningEffortPattern.test(session.reasoningEffort)
    ) {
      throw new SpaceFeatureDisabledError(
        "CLI_CODEX_DEFAULTS_UNRESOLVED",
        "A fresh Codex CLI session requires a resolved model and reasoning effort."
      );
    }
    return [
      "--model",
      session.modelId,
      "--config",
      `model_reasoning_effort=${session.reasoningEffort}`,
      "--no-alt-screen"
    ];
  }
  return [];
}

export function buildCliProcessLaunch(
  config: Pick<SpaceApiConfig, "cliVpnEnabled" | "cliVpnLauncherPath">,
  runtime: Pick<AgentRuntime, "id" | "detectedCommandPath">,
  args: string[]
): { command: string; args: string[] } {
  const runtimeId = cliToggleRuntimeIdSchema.safeParse(runtime.id);
  if (config.cliVpnEnabled && runtimeId.success) {
    return {
      command: config.cliVpnLauncherPath,
      args: [runtimeId.data, ...args]
    };
  }
  return { command: runtime.detectedCommandPath ?? "", args };
}

function isCliSessionRuntimeAttachable(runtime: AgentRuntime, session: Pick<PaneCliSession, "purpose">): boolean {
  return session.purpose === "LOGIN"
    ? (canStartAgentRuntimeLogin(runtime) || isCliRuntimeTerminalLaunchable(runtime)) &&
      findCliRuntimeDescriptor(runtime.id)?.loginAction === "login"
    : isCliRuntimeTerminalLaunchable(runtime);
}

function sqliteQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeCodexRuntimeKey(paneId: string, sessionId: string): string {
  return `${paneId}--${sessionId}`.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function codexPrivateAppServerSocketPath(session: Pick<PaneCliSession, "paneId" | "sessionId">): string {
  return join(
    codexDirectParityCodexHome,
    "space-app-servers",
    safeCodexRuntimeKey(session.paneId, session.sessionId),
    "app-server.sock"
  );
}

export async function findSafeCodexThreadId(input: FindSafeCodexThreadIdInput): Promise<string | null> {
  if (!input.cwd) return null;
  const codexHome = input.codexHome ?? codexDirectParityCodexHome;
  const stateDbPath = join(codexHome, "state_5.sqlite");
  const rolloutRoot = `${join(codexHome, "space-codex-homes", safeCodexRuntimeKey(input.paneId, input.sessionId), "sessions")}/`;
  const quotedRolloutRoot = sqliteQuote(rolloutRoot);
  const sql = `
    SELECT id
    FROM threads
    WHERE cwd = ${sqliteQuote(input.cwd)}
      AND coalesce(archived, 0) = 0
      AND thread_source = 'user'
      AND agent_path IS NULL
      AND substr(rollout_path, 1, length(${quotedRolloutRoot})) = ${quotedRolloutRoot}
    ORDER BY
      coalesce(recency_at_ms, updated_at_ms, created_at_ms, 0) DESC,
      coalesce(updated_at_ms, created_at_ms, 0) DESC,
      id DESC
    LIMIT 1
  `;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, sql], {
      timeout: 1_500,
      maxBuffer: 64 * 1024
    });
    const rows = JSON.parse(String(stdout || "[]")) as Array<{ id?: unknown }>;
    const ids = rows.map((row) => (typeof row.id === "string" ? row.id : "")).filter((id) => codexThreadUuidPattern.test(id));
    return ids.length === 1 ? ids[0] ?? null : null;
  } catch {
    return null;
  }
}

export async function findSafeCodexThreadResumeSettings(
  input: FindSafeCodexThreadResumeSettingsInput
): Promise<CodexThreadResumeSettings | null> {
  if (!input.cwd || !codexThreadUuidPattern.test(input.threadId)) return null;
  const codexHome = input.codexHome ?? codexDirectParityCodexHome;
  const stateDbPath = join(codexHome, "state_5.sqlite");
  const sql = `
    SELECT model, reasoning_effort
    FROM threads
    WHERE id = ${sqliteQuote(input.threadId)}
      AND cwd = ${sqliteQuote(input.cwd)}
      AND coalesce(archived, 0) = 0
      AND thread_source = 'user'
      AND agent_path IS NULL
    LIMIT 2
  `;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, sql], {
      timeout: 1_500,
      maxBuffer: 64 * 1024
    });
    const rows = JSON.parse(String(stdout || "[]")) as Array<{ model?: unknown; reasoning_effort?: unknown }>;
    if (rows.length !== 1) return null;
    const modelId = rows[0]?.model;
    const reasoningEffort = rows[0]?.reasoning_effort;
    if (typeof modelId !== "string" || !codexModelIdPattern.test(modelId)) return null;
    if (reasoningEffort === null || reasoningEffort === undefined || reasoningEffort === "") {
      return { modelId, reasoningEffort: null };
    }
    if (typeof reasoningEffort !== "string" || !codexReasoningEffortPattern.test(reasoningEffort)) return null;
    return { modelId, reasoningEffort };
  } catch {
    return null;
  }
}

export async function findAvailableCodexThreadId(input: {
  store: SpaceStore;
  paneId: string;
  sessionId: string;
  cwd: string | null;
  findThreadId?: CodexThreadFinder;
}): Promise<string | null> {
  const findThreadId = input.findThreadId ?? findSafeCodexThreadId;
  const codexThreadId = await findThreadId({
    paneId: input.paneId,
    sessionId: input.sessionId,
    cwd: input.cwd
  });
  if (!codexThreadId) return null;
  const ownership = await input.store.getPaneCliCodexThreadOwnership(codexThreadId);
  if (ownership && ownership.cliSessionId !== input.sessionId) return null;
  const owner = await input.store.getActivePaneCliSessionByCodexThreadId(codexThreadId);
  return !owner || owner.sessionId === input.sessionId ? codexThreadId : null;
}

function socketIsOpen(socket: WebSocket): boolean {
  return socket.readyState === 1;
}

function cliHostSessionUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "CLI_HOST_SESSION_NOT_FOUND";
}

function cliHostLaneIndex(sessionId: string, laneCount: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % laneCount;
}

export class CliTerminalManager {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly sessions = new Map<string, ManagedCliSession>();
  private readonly terminalMutationQueues = new Map<string, Promise<void>>();
  private readonly sessionAttachPromises = new Map<string, Promise<ManagedCliSessionAttach>>();
  private readonly sessionAllocations = new Map<string, CliSessionAllocationRecord>();
  private readonly loginTimeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly loginObservationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hostClient: CliHostGateway;
  private readonly hostClients: readonly CliHostGateway[];
  private readonly adminHostClient: CliHostGateway;
  private nextSocketConnectionOrder = 0;

  constructor(private readonly options: CliTerminalManagerOptions) {
    this.hostClient = options.hostClient ?? new CliHostClient({ socketPath: options.config.cliHostSocketPath });
    this.hostClients = options.hostClient
      ? [this.hostClient]
      : [
          this.hostClient,
          ...Array.from(
            { length: cliHostMainConnectionCount - 1 },
            () => new CliHostClient({ socketPath: options.config.cliHostSocketPath })
          )
        ];
    this.adminHostClient = options.adminHostClient ?? new CliHostClient({ socketPath: options.config.cliAdminHostSocketPath });
  }

  private reportTelemetry(
    managed: ManagedCliSession,
    event: CliTerminalManagerTelemetryEvent["event"],
    outcome: CliTerminalTelemetryOutcome,
    reason: CliTerminalTelemetryReason,
    details: Partial<Pick<
      CliTerminalManagerTelemetryEvent,
      "protocolVersion" | "clientMode" | "controlState" | "requestId"
    >> = {}
  ): void {
    try {
      this.options.onTelemetry?.({
        event,
        outcome,
        reason,
        paneId: managed.paneId,
        roomId: managed.roomId,
        sessionId: managed.sessionId,
        runtimeId: managed.runtimeId,
        socketCount: managed.sockets.size,
        ...details
      });
    } catch {
      // Telemetry is best-effort and must never disturb an active terminal.
    }
  }

  hostHealth(runtimeId = "cli:codex"): Promise<CliHostHealth> {
    return this.hostForRuntime(runtimeId).health();
  }

  async inspectSessionHost(session: PaneCliSession): Promise<CliHostSessionSummary | null> {
    const identity = await this.buildHostIdentity(session);
    return this.hostForRuntime(session.runtimeId, session.sessionId).inspect(identity);
  }

  async reconcileNormalSessionHostState(session: PaneCliSession): Promise<PaneCliSession> {
    if (session.purpose !== "NORMAL") return session;
    let inspected: CliHostSessionSummary | null;
    try {
      inspected = await this.inspectSessionHost(session);
    } catch (error) {
      if (cliHostSessionUnavailable(error)) return session;
      throw error;
    }
    if (!inspected || inspected.status === "RUNNING") return session;
    return this.persistClosedNormalHostSession(session, inspected);
  }

  recordSessionAllocation(sessionId: string, allocatedAtNs = process.hrtime.bigint()): void {
    if (!sessionId || allocatedAtNs < 0n) throw new Error("CLI session allocation marker is invalid.");
    const recordedAtNs = process.hrtime.bigint();
    this.pruneSessionAllocations(recordedAtNs);
    this.sessionAllocations.delete(sessionId);
    while (this.sessionAllocations.size >= maxPendingCliSessionAllocations) {
      const oldestSessionId = this.sessionAllocations.keys().next().value;
      if (typeof oldestSessionId !== "string") break;
      this.sessionAllocations.delete(oldestSessionId);
    }
    this.sessionAllocations.set(sessionId, { allocatedAtNs, recordedAtNs });
  }

  scheduleLoginTimeout(session: PaneCliSession): void {
    this.clearLoginTimeout(session.sessionId);
    if (session.purpose !== "LOGIN" || !session.isActive || session.status === "EXITED" || session.status === "ERROR") return;
    const timeoutMs = this.options.loginTimeoutMs ?? cliLoginTimeoutMs;
    const startedAtMs = Date.parse(session.startedAt);
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
    const timer = setTimeout(() => {
      this.loginTimeoutTimers.delete(session.sessionId);
      const managed = this.sessions.get(session.sessionId) ?? null;
      void this.failLoginSession(session.sessionId, "TIMEOUT", managed, true).catch(() => undefined);
    }, Math.max(0, timeoutMs - elapsedMs));
    timer.unref?.();
    this.loginTimeoutTimers.set(session.sessionId, timer);
  }

  private clearLoginTimeout(sessionId: string): void {
    const timer = this.loginTimeoutTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.loginTimeoutTimers.delete(sessionId);
  }

  private clearLoginObservation(sessionId: string): void {
    const timer = this.loginObservationTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.loginObservationTimers.delete(sessionId);
  }

  private clearQwenAuthBootstrap(managed: ManagedCliSession): void {
    if (managed.qwenAuthBootstrapTimer !== null) clearTimeout(managed.qwenAuthBootstrapTimer);
    managed.qwenAuthBootstrapTimer = null;
  }

  private scheduleQwenAuthBootstrap(managed: ManagedCliSession): void {
    if (
      managed.closed ||
      managed.purpose !== "LOGIN" ||
      managed.runtimeId !== "cli:qwen" ||
      managed.qwenAuthBootstrapSent ||
      managed.qwenAuthBootstrapTimer !== null ||
      !qwenAuthBootstrapReady(managed.controlOutput)
    ) {
      return;
    }
    const generationId = managed.generationId;
    managed.qwenAuthBootstrapTimer = setTimeout(() => {
      managed.qwenAuthBootstrapTimer = null;
      if (
        managed.closed ||
        managed.qwenAuthBootstrapSent ||
        managed.generationId !== generationId ||
        !qwenAuthBootstrapReady(managed.controlOutput)
      ) {
        return;
      }
      managed.qwenAuthBootstrapSent = true;
      void this.hostForRuntime(managed.runtimeId, managed.sessionId).input(
        managed.identity,
        managed.attachmentId,
        "/auth\r",
        "hidden",
        `qwen-auth-bootstrap:${managed.sessionId}:${generationId}`
      ).catch(() => undefined);
    }, qwenAuthBootstrapSettleMs);
    managed.qwenAuthBootstrapTimer.unref?.();
  }

  private controlledCredentialActionEnvironment(): NodeJS.ProcessEnv {
    return {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color"
    };
  }

  private async readCredentialObservation(runtime: AgentRuntime): Promise<string | null> {
    const descriptor = findCliRuntimeDescriptor(runtime.id);
    if (!descriptor?.credentialObservationAction || !runtime.detectedCommandPath) return null;
    try {
      const launch = buildCliProcessLaunch(this.options.config, runtime, [descriptor.credentialObservationAction]);
      const { stdout } = await execFileAsync(launch.command, launch.args, {
        encoding: "utf8",
        env: this.controlledCredentialActionEnvironment(),
        timeout: cliCredentialObservationTimeoutMs,
        maxBuffer: 256
      });
      if (
        stdout === `${cliCredentialNotReadyObservation}\n` ||
        stdout === `${cliCredentialNotReadyObservation}\r\n`
      ) {
        return cliCredentialNotReadyObservation;
      }
      return /^(?:OBSERVATION:[0-9a-f]{64}|OBSERVATION:MISSING)\r?\n$/.test(stdout)
        ? stdout.trim()
        : null;
    } catch {
      return null;
    }
  }

  private async runCredentialSmoke(runtime: AgentRuntime): Promise<boolean> {
    const descriptor = findCliRuntimeDescriptor(runtime.id);
    if (!descriptor?.credentialSmokeMarker || !runtime.detectedCommandPath) return false;
    try {
      const launch = buildCliProcessLaunch(this.options.config, runtime, ["credential-smoke"]);
      const { stdout } = await execFileAsync(launch.command, launch.args, {
        encoding: "utf8",
        env: this.controlledCredentialActionEnvironment(),
        timeout: cliCredentialSmokeTimeoutMs,
        maxBuffer: 1_024
      });
      return stdout === `${descriptor.credentialSmokeMarker}\n` || stdout === `${descriptor.credentialSmokeMarker}\r\n`;
    } catch {
      return false;
    }
  }

  private scheduleLoginObservation(managed: ManagedCliSession, runtime: AgentRuntime): void {
    this.clearLoginObservation(managed.sessionId);
    if (managed.closed || !managed.credentialObservation) return;
    const timer = setTimeout(() => {
      this.loginObservationTimers.delete(managed.sessionId);
      void this.observeLoginCredentials(managed, runtime).catch(() => {
        if (!managed.closed) this.scheduleLoginObservation(managed, runtime);
      });
    }, this.options.loginObservationIntervalMs ?? cliLoginObservationIntervalMs);
    timer.unref?.();
    this.loginObservationTimers.set(managed.sessionId, timer);
  }

  private async observeLoginCredentials(managed: ManagedCliSession, runtime: AgentRuntime): Promise<void> {
    if (managed.closed) return;
    const observation = await this.readCredentialObservation(runtime);
    if (
      !observation ||
      observation === managed.credentialSmokeRetryObservation
    ) {
      this.scheduleLoginObservation(managed, runtime);
      return;
    }
    if (!await this.runCredentialSmoke(runtime)) {
      if (managed.credentialSmokeRetryObservation !== observation) {
        this.broadcast(managed, {
          type: "output",
          stream: "stdout",
          data: "\r\nCredential verification did not succeed. Update the provider setup and retry in this terminal.\r\n"
        });
      }
      managed.credentialSmokeRetryObservation = observation;
      this.scheduleLoginObservation(managed, runtime);
      return;
    }
    const verifiedObservation = await this.readCredentialObservation(runtime);
    if (verifiedObservation !== observation) {
      this.broadcast(managed, {
        type: "output",
        stream: "stdout",
        data: "\r\nCredentials changed during verification. SpaceApp is retrying with the latest provider state.\r\n"
      });
      managed.credentialSmokeRetryObservation = observation;
      this.scheduleLoginObservation(managed, runtime);
      return;
    }
    managed.credentialObservation = verifiedObservation;
    managed.credentialSmokeRetryObservation = null;
    await this.completeObservedLogin(managed);
  }

  private async completeObservedLogin(managed: ManagedCliSession): Promise<void> {
    if (!this.closeManagedLoginSession(managed)) return;
    try {
      await this.hostForRuntime(managed.runtimeId, managed.sessionId).terminate(managed.identity);
    } catch (error) {
      if (!cliHostSessionUnavailable(error)) {
        // Credential verification already succeeded; a concurrently exiting TUI is safe to reconcile below.
      }
    }
    await this.finishObservedLogin(managed);
  }

  private async finishObservedLogin(managed: ManagedCliSession): Promise<void> {
    try {
      await this.options.store.updatePaneCliSession(
        managed.sessionId,
        {
          status: "EXITED",
          statusReason: "CLI credentials verified; starting a normal session in this pane.",
          exitCode: 0,
          isActive: false,
          endedAt: nowIso()
        },
        "req:cli-login-verification"
      );
      const loginSession = await this.options.store.getPaneCliSession(managed.sessionId);
      if (!loginSession || !this.options.onLoginSucceeded) throw new Error("CLI login completion handler is unavailable.");
      const fingerprintHash = managed.credentialObservation?.match(
        /^OBSERVATION:([0-9a-f]{64})$/
      )?.[1];
      if (!fingerprintHash) throw new Error("CLI credential fingerprint evidence is unavailable.");
      const sessionId = await this.options.onLoginSucceeded(loginSession, { fingerprintHash });
      this.broadcast(managed, { type: "session_replaced", sessionId });
      return;
    } catch {
      // Report a fixed failure below without exposing provider output or credential material.
    }
    try {
      await this.options.store.updatePaneCliSession(
        managed.sessionId,
        {
          status: "ERROR",
          statusReason: "CLI credentials changed, but their smoke verification could not complete.",
          isActive: false
        },
        "req:cli-login-verification"
      );
    } catch {
      // The fixed client-facing error below remains safe if status persistence is unavailable.
    }
    try {
      this.broadcast(managed, {
        type: "status",
        status: "ERROR",
        statusReason: "CLI credentials changed, but their smoke verification could not complete.",
        exitCode: null
      });
    } catch {
      // The login session is already closed; there is no additional state to expose.
    }
  }

  async reapDetachedSessions(): Promise<CliHostReapAggregate> {
    const hosts = [
      { hostId: "main" as const, enabled: this.options.config.cliEnabled, client: this.hostClient },
      { hostId: "root" as const, enabled: this.options.config.cliRootEnabled, client: this.adminHostClient }
    ].filter((host) => host.enabled);
    const settled = await Promise.all(hosts.map(async (host) => {
      if (!host.client.reapDetached) throw new Error(`CLI host ${host.hostId} does not support detached-session reaping.`);
      return { hostId: host.hostId, result: await host.client.reapDetached() };
    }).map(async (request) => {
      try {
        return { ok: true as const, value: await request };
      } catch {
        return { ok: false as const };
      }
    }));
    return {
      killedSessions: settled.flatMap((entry) => entry.ok
        ? entry.value.result.killedSessions.map((session) => ({ hostId: entry.value.hostId, cliSessionId: session.cliSessionId }))
        : []),
      skippedCount: settled.reduce((count, entry) => count + (entry.ok ? entry.value.result.skippedCount : 0), 0),
      failedHostCount: settled.filter((entry) => !entry.ok).length
    };
  }

  private hostForRuntime(runtimeId: string, sessionId?: string): CliHostGateway {
    if (runtimeId === "cli:root") return this.adminHostClient;
    if (!sessionId || this.hostClients.length === 1) return this.hostClient;
    return this.hostClients[cliHostLaneIndex(sessionId, this.hostClients.length)] ?? this.hostClient;
  }

  private pruneSessionAllocations(nowNs = process.hrtime.bigint()): void {
    for (const [sessionId, allocation] of this.sessionAllocations) {
      if (nowNs - allocation.recordedAtNs <= cliSessionAllocationRetentionNs) break;
      this.sessionAllocations.delete(sessionId);
    }
  }

  private sessionAllocationMonotonicNs(sessionId: string): string | undefined {
    this.pruneSessionAllocations();
    return this.sessionAllocations.get(sessionId)?.allocatedAtNs.toString();
  }

  issueTicket(paneId: string, sessionId: string, ttlMs: number): PaneCliWebSocketToken {
    this.pruneTickets();
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + ttlMs;
    this.tickets.set(token, { paneId, sessionId, expiresAtMs });
    return {
      paneId,
      sessionId,
      token,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  handleSocket(socket: WebSocket, input: {
    paneId: string;
    pane: Pane | Promise<Pane>;
    sessionId: string;
    token: string;
    clientId?: string;
    protocolVersion?: 2;
    browserClientId?: string;
    tabLineageId?: string;
    pageClientId?: string;
    clientMode?: PaneCliClientMode;
    requestedLeaseId?: string;
    initialCols?: number;
    initialRows?: number;
    userId: string;
    proofScope?: "READ_ONLY";
    requestId: string;
  }) {
    const connectionPromise = this.openConnection(socket, {
      ...input,
      connectionOrder: ++this.nextSocketConnectionOrder
    });
    let operationQueue = Promise.resolve();
    let detachQueued = false;

    socket.on("message", (raw) => {
      operationQueue = operationQueue
        .then(async () => (await connectionPromise).handleMessage(raw))
        .catch((error: unknown) => this.closeWithError(socket, error));
    });
    const queueDetach = () => {
      if (detachQueued) return;
      detachQueued = true;
      operationQueue = operationQueue
        .then(async () => (await connectionPromise).detach())
        .catch(() => undefined);
    };
    socket.on("close", queueDetach);
    socket.on("error", queueDetach);
    void connectionPromise.catch((error: unknown) => this.closeWithError(socket, error));
  }

  async interrupt(
    sessionId: string,
    transcript?: { content: string; traceId: string }
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId);
    if (managed && !managed.closed) {
      if (managed.purpose === "LOGIN") {
        return this.failLoginSession(sessionId, "CANCELLED", managed, true);
      }
      await this.flushHostOutput(managed);
      if (transcript) {
        await this.appendTranscript(managed, "system", transcript.content, transcript.traceId);
      }
      let interrupted: boolean;
      try {
        interrupted = await this.terminateManagedHostSession(managed);
      } catch (error) {
        if (!cliHostSessionUnavailable(error)) throw error;
        interrupted = false;
        await this.closeUnavailableHostSession(managed);
      }
      await managed.persistQueue;
      return interrupted;
    }
    const session = await this.options.store.getPaneCliSession(sessionId);
    if (!session) return false;
    if (session.purpose === "LOGIN") {
      return this.failLoginSession(sessionId, "CANCELLED", null, true);
    }
    let interrupted: boolean;
    try {
      const host = this.hostForRuntime(session.runtimeId, session.sessionId);
      interrupted = await this.terminateHostSession(host, await this.buildHostIdentity(session));
    } catch (error) {
      if (!cliHostSessionUnavailable(error)) throw error;
      interrupted = false;
    }
    if (transcript) {
      await this.options.store.appendPaneCliTranscriptChunkAtNextSequence(
        {
          sessionId: session.sessionId,
          paneId: session.paneId,
          roomId: session.roomId,
          stream: "system",
          content: transcript.content
        },
        transcript.traceId
      );
    }
    return interrupted;
  }

  async replaceSessionForPolicyRestart(
    sessionId: string,
    runtime: AgentRuntime,
    traceId: string,
    createReplacement: () => Promise<PaneCliSession>
  ): Promise<PaneCliSession> {
    const previousManaged = this.sessions.get(sessionId) ?? null;
    const interrupted = await this.interrupt(sessionId, {
      content: "CLI session stopped for an explicit network policy restart.",
      traceId
    });
    if (!interrupted) {
      const previous = await this.options.store.getPaneCliSession(sessionId);
      if (previous) {
        const inspected = await this.hostForRuntime(previous.runtimeId, previous.sessionId).inspect(
          await this.buildHostIdentity(previous)
        ).catch((error: unknown) => {
          if (cliHostSessionUnavailable(error)) return null;
          throw error;
        });
        if (inspected?.status === "RUNNING") {
          throw new SpaceConflictError(`CLI session ${sessionId} is still running and was not replaced.`);
        }
      }
    }

    const replacement = await createReplacement();
    await this.getOrSpawnSession(replacement, runtime, traceId);
    if (previousManaged) {
      this.broadcast(previousManaged, { type: "session_replaced", sessionId: replacement.sessionId });
    }
    return replacement;
  }

  listRuntimes(): Promise<AgentRuntimeRegistry> {
    return this.options.discoverRuntimes();
  }

  async activeSessionPids(sessions: readonly PaneCliSession[]): Promise<Map<string, number>> {
    const resolved = await Promise.all(sessions.map(async (session) => {
      try {
        const summary = await this.hostForRuntime(session.runtimeId, session.sessionId).inspect(
          await this.buildHostIdentity(session)
        );
        return summary?.status === "RUNNING" ? [session.sessionId, summary.pid] as const : null;
      } catch {
        return null;
      }
    }));
    return new Map(resolved.filter((item): item is readonly [string, number] => item !== null));
  }

  async ensurePaneTransportReady(
    pane: Pane,
    traceId: string,
    selection: { modelId?: string | null; reasoningEffort?: string } = {}
  ): Promise<PaneCliSession> {
    if (pane.mode !== "TERMINAL") throw new SpaceConflictError(`Pane ${pane.id} is not a terminal pane.`);
    const runtimeId = pane.terminalRuntimeId ?? "cli:codex";
    const registry = await this.options.discoverRuntimes();
    const runtime = registry.data.find((candidate) => candidate.id === runtimeId);
    if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${runtimeId} was not found.`);
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    if (!isCliRuntimeTerminalLaunchable(runtime) || !runtime.detectedCommandPath) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, { runtimeId: runtime.id });
    }
    let session = await this.options.store.getActivePaneCliSession(pane.id);
    if (!session) {
      let modelId = pane.modelId ?? runtime.defaultModelId;
      let reasoningEffort = pane.reasoningEffort;
      if (isCodexDirectParityRuntime(runtime.id)) {
        const buildDefaults = this.options.codexBuildDefaultsProvider
          ? await this.options.codexBuildDefaultsProvider()
          : {
              modelId: this.options.config.cliCodexDefaultModel,
              reasoningEffort: this.options.config.cliCodexDefaultReasoningEffort
            };
        const resolved = resolveCodexCliLaunchSettings(
          {
            cliCodexDefaultModel: buildDefaults.modelId,
            cliCodexDefaultReasoningEffort: buildDefaults.reasoningEffort
          },
          pane,
          selection
        );
        if (!resolved) {
          throw new SpaceFeatureDisabledError(
            "CLI_CODEX_DEFAULTS_UNRESOLVED",
            "Codex CLI launch defaults could not be resolved."
          );
        }
        modelId = resolved.modelId;
        reasoningEffort = resolved.reasoningEffort;
        if (pane.modelId !== modelId || pane.reasoningEffort !== reasoningEffort) {
          await this.options.store.updatePane(pane.id, { modelId, reasoningEffort }, traceId);
        }
      }
      const cwd = isDirectOperatorParityRuntime(runtime.id)
        ? resolveDirectOperatorParityCwd(pane.cwd, this.options.config.cliWorkspaceRoot)
        : pane.cwd ?? this.options.config.cliWorkspaceRoot;
      if (!isDirectOperatorParityRuntime(runtime.id)) {
        await mkdir(cwd, { recursive: true, mode: 0o750 });
      }
      const allocatedAtNs = process.hrtime.bigint();
      session = await this.options.store.createPaneCliSession({
        paneId: pane.id,
        roomId: pane.roomId,
        runtimeId: runtime.id,
        providerId: runtime.providerId,
        agentId: runtime.agentId,
        modelId,
        reasoningEffort,
        launchMode: "FRESH",
        cwd,
        codexThreadId: null,
        status: "IDLE",
        statusReason: "CLI session allocated by Room Agent; preparing the independent pane host."
      }, traceId);
      this.recordSessionAllocation(session.sessionId, allocatedAtNs);
    }
    await this.sendInput(session.sessionId, "", traceId, null, `room-agent-create:${pane.id}`);
    const managed = this.sessions.get(session.sessionId);
    if (!managed) throw new SpaceConflictError(`CLI session ${session.sessionId} detached before its transport became ready.`);
    return (await this.options.store.getPaneCliSession(session.sessionId)) ?? session;
  }

  async ensurePaneControlReady(pane: Pane, traceId: string): Promise<PaneCliSession> {
    const session = await this.ensurePaneTransportReady(pane, traceId);
    const managed = this.sessions.get(session.sessionId);
    if (!managed) throw new SpaceConflictError(`CLI session ${session.sessionId} detached before it became ready for input.`);
    await this.waitForInputReady(managed);
    return (await this.options.store.getPaneCliSession(session.sessionId)) ?? session;
  }

  async sendInput(
    sessionId: string,
    data: string,
    traceId: string,
    turnMarker: string | null = null,
    inputIdempotencyKey?: string
  ): Promise<{ turnMarker: string | null; markerAtMs: number }> {
    const session = await this.options.store.getPaneCliSession(sessionId);
    if (!session) throw new SpaceNotFoundError(`CLI session ${sessionId} was not found.`);
    if (session.purpose !== "NORMAL") {
      throw new SpaceConflictError("CLI login sessions accept input only from their authenticated terminal WebSocket.");
    }
    if (!session.isActive || session.status === "EXITED") {
      throw new SpaceConflictError(`CLI session ${sessionId} is not active.`);
    }
    const registry = await this.options.discoverRuntimes();
    const runtime = registry.data.find((candidate) => candidate.id === session.runtimeId);
    if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${session.runtimeId} was not found.`);
    if (!isCliSessionRuntimeAttachable(runtime, session) || !runtime.detectedCommandPath) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, { runtimeId: runtime.id });
    }

    const activateTransport = (candidate: ManagedCliSession) => {
      candidate.transportReady = true;
      const pendingHostEvents = candidate.pendingHostEvents.splice(0);
      for (const event of pendingHostEvents) this.handleHostEvent(candidate, event);
      if (candidate.closed) throw new SpaceConflictError(`CLI session ${sessionId} closed before input could be sent.`);
    };
    let managed = (await this.getOrSpawnSession(session, runtime, traceId)).managed;
    activateTransport(managed);
    const terminalData = sanitizeCliTerminalInput(managed.runtimeId, data);
    if (data.length > 0 && terminalData.length === 0) {
      return { turnMarker: null, markerAtMs: Date.now() };
    }
    if (terminalData.length > 0) await this.waitForInputReady(managed);
    await this.flushHostOutput(managed);

    const sendToHost = (candidate: ManagedCliSession) => {
      const host = this.hostForRuntime(candidate.runtimeId, candidate.sessionId);
      return inputIdempotencyKey
        ? host.input(candidate.identity, candidate.attachmentId, terminalData, "visible", inputIdempotencyKey)
        : host.input(candidate.identity, candidate.attachmentId, terminalData, "visible");
    };
    let inputResult;
    try {
      inputResult = await sendToHost(managed);
    } catch (error) {
      if (!(error instanceof CliHostError) || error.code !== "CLI_HOST_ATTACHMENT_NOT_FOUND") throw error;
      managed.detached = true;
      managed.transportReady = false;
      if (this.sessions.get(session.sessionId) === managed) this.sessions.delete(session.sessionId);
      managed = (await this.getOrSpawnSession(session, runtime, traceId)).managed;
      activateTransport(managed);
      if (terminalData.length > 0) await this.waitForInputReady(managed);
      await this.flushHostOutput(managed);
      inputResult = await sendToHost(managed);
    }
    const markerAtMs = inputResult?.acceptedAtMs ?? Date.now();
    if (session.purpose === "NORMAL" && turnMarker) {
      this.pruneTurnMarkers(managed);
      managed.turnMarkers.set(turnMarker, {
        markerAtMs,
        turnId: null,
        expiresAtMs: markerAtMs + cliTurnMarkerTtlMs
      });
    }
    if (session.purpose === "NORMAL" && inputResult?.accepted !== false) {
      await this.appendTranscript(managed, "stdin", terminalData, traceId);
    }
    if (session.purpose === "NORMAL" && inputResult?.accepted !== false && terminalData.trim()) {
      this.scheduleCodexNullAgentMessageCheck(managed, markerAtMs - 1000, terminalData);
      this.scheduleCodexThreadBind(managed, markerAtMs - 1000);
    }
    if (terminalData.trim()) {
      await this.options.store.touchPaneCliSessionActivity(sessionId, traceId);
    }
    return { turnMarker, markerAtMs };
  }

  async updateCodexPreThreadModelSettings(input: {
    sessionId: string;
    models: readonly CodexCliModelSelectionOption[];
    modelId: string;
    reasoningEffort: string;
    traceId: string;
  }): Promise<void> {
    const session = await this.options.store.getPaneCliSession(input.sessionId);
    if (!session) throw new SpaceNotFoundError(`CLI session ${input.sessionId} was not found.`);
    if (!session.isActive || session.status === "EXITED" || session.status === "ERROR") {
      throw new SpaceConflictError(`CLI session ${input.sessionId} is not active.`);
    }
    if (!isCodexDirectParityRuntime(session.runtimeId) || session.codexThreadId) {
      throw new SpaceConflictError("Pre-thread model control requires a running Codex CLI session without a bound thread.");
    }
    const registry = await this.options.discoverRuntimes();
    const runtime = registry.data.find((candidate) => candidate.id === session.runtimeId);
    if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${session.runtimeId} was not found.`);
    if (!isCliRuntimeTerminalLaunchable(runtime) || !runtime.detectedCommandPath) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, { runtimeId: runtime.id });
    }

    const managed = (await this.getOrSpawnSession(session, runtime, input.traceId)).managed;
    if (!managed.transportReady) {
      managed.transportReady = true;
      const pendingHostEvents = managed.pendingHostEvents.splice(0);
      for (const event of pendingHostEvents) this.handleHostEvent(managed, event);
    }
    if (managed.closed) throw new SpaceConflictError(`CLI session ${input.sessionId} closed before model control started.`);
    await this.waitForCodexModelControlReady(managed);

    const navigation = buildCodexCliPreThreadModelNavigation(input);
    const operation = managed.controlQueue.then(async () => {
      const host = this.hostForRuntime(managed.runtimeId, managed.sessionId);
      let inputIndex = 0;
      const sendHiddenInput = async (data: string) => {
        const result = await host.input(
          managed.identity,
          managed.attachmentId,
          data,
          "hidden",
          `space-model-select:${input.sessionId}:${input.traceId}:${inputIndex++}`.slice(0, 240)
        );
        if (result?.accepted === false) {
          throw new SpaceConflictError("Codex terminal input was not accepted during model control.");
        }
      };
      try {
        for (const step of navigation) {
          if (step.type === "command") {
            managed.controlOutput = "";
            const outputRevisionBeforeCommand = managed.controlOutputRevision;
            const commandSentAtMs = Date.now();
            await sendHiddenInput(step.input);
            await this.waitForCodexControlOutputAfter(managed, outputRevisionBeforeCommand);
            // Codex treats a slash command and Enter arriving in one burst as pasted multiline text.
            const remainingSubmitDelayMs = codexModelCommandSubmitDelayMs - (Date.now() - commandSentAtMs);
            if (remainingSubmitDelayMs > 0) await delay(remainingSubmitDelayMs);
            await sendHiddenInput("\r");
            continue;
          }

          await this.waitForCodexControlMenu(managed, step.menuLabels ?? step.targetLabels);
          if (codexControlMenuHighlightsTarget(managed.controlOutput, step.targetLabels)) {
            managed.controlOutput = "";
            await sendHiddenInput("\r");
            continue;
          }

          managed.controlOutput = "";
          await sendHiddenInput(codexHomeKey);
          // Let the TUI render Home before sending indexed navigation. Rapid key bursts
          // can be coalesced into cursor-position-only deltas that omit the target label.
          await delay(codexModelNavigationRepaintSettleMs);
          for (let offset = 0; offset < step.index; offset += 1) {
            const outputRevisionBeforeArrow = managed.controlOutputRevision;
            await sendHiddenInput(codexArrowDownKey);
            await this.waitForCodexControlOutputAfter(managed, outputRevisionBeforeArrow);
            await delay(codexModelNavigationRepaintSettleMs);
          }
          await this.waitForCodexControlHighlight(managed, step.targetLabels);
          managed.controlOutput = "";
          await sendHiddenInput("\r");
        }
        await this.waitForCodexModelChange(managed, input.modelId, input.reasoningEffort);
      } catch (error) {
        await host.input(managed.identity, managed.attachmentId, "\u001b\u001b\u001b", "hidden").catch(() => undefined);
        if (error instanceof SpaceConflictError) throw error;
        throw new SpaceConflictError("Codex did not apply the requested pre-thread model settings.");
      }
    });
    managed.controlQueue = operation.catch(() => undefined);
    await operation;
  }

  async getTurnActivity(
    sessionId: string,
    marker: string,
    recovery?: { markerAtMs: number; turnId?: string | null; inputMarker?: string }
  ): Promise<PaneCliTurnActivityResponse & { lastActivityAtMs?: number }> {
    const unavailable = { marker, status: "UNAVAILABLE" as const, turnId: null };
    let managed = this.sessions.get(sessionId);
    if ((!managed || managed.closed) && recovery) {
      const session = await this.options.store.getPaneCliSession(sessionId);
      if (!session || !session.isActive || session.status === "EXITED") return unavailable;
      const registry = await this.options.discoverRuntimes();
      const runtime = registry.data.find((candidate) => candidate.id === session.runtimeId);
      if (!runtime || !isCliRuntimeTerminalLaunchable(runtime) || !runtime.detectedCommandPath) return unavailable;
      managed = (await this.getOrSpawnSession(session, runtime, "req:cli-turn-recovery")).managed;
      managed.transportReady = true;
    }
    if (!managed || managed.closed || !isCodexDirectParityRuntime(managed.runtimeId)) return unavailable;

    this.pruneTurnMarkers(managed);
    if (!managed.turnMarkers.has(marker) && recovery) {
      managed.turnMarkers.set(marker, {
        markerAtMs: recovery.markerAtMs,
        turnId: recovery.turnId ?? null,
        expiresAtMs: Math.max(Date.now() + 60_000, recovery.markerAtMs + cliTurnMarkerTtlMs)
      });
    }
    const tracked = managed.turnMarkers.get(marker);
    if (!tracked) return unavailable;

    if (!managed.codexThreadId) {
      const session = await this.options.store.getPaneCliSession(sessionId);
      if (!session) return unavailable;
      const bound = await this.bindCodexThreadIdBeforeResume(session, "req:cli-turn-activity");
      managed.codexThreadId = bound.codexThreadId;
      if (!managed.codexThreadId) return { marker, status: "PENDING", turnId: null };
    }

    try {
      const findActivity = this.options.findCodexCliTurnActivity ?? findRecentCodexCliTurnActivity;
      const activity = await findActivity({
        codexHome: codexDirectParityCodexHome,
        threadId: managed.codexThreadId,
        markerAtMs: tracked.markerAtMs,
        turnId: tracked.turnId,
        inputMarker: recovery?.inputMarker
      });
      tracked.turnId = activity.turnId ?? tracked.turnId;
      return {
        marker,
        status: activity.status,
        turnId: tracked.turnId,
        ...(activity.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: activity.lastActivityAtMs })
      };
    } catch {
      return unavailable;
    }
  }

  async getCurrentTurnActivity(sessionId: string): Promise<CodexCliTurnActivity> {
    let session = await this.options.store.getPaneCliSession(sessionId);
    if (!session || !session.isActive || session.status === "EXITED" || !isCodexDirectParityRuntime(session.runtimeId)) {
      return { status: "PENDING", turnId: null };
    }
    if (!session.codexThreadId) {
      session = await this.bindCodexThreadIdBeforeResume(session, "req:cli-current-turn-activity");
    }
    if (!session.codexThreadId) return { status: "PENDING", turnId: null };
    return (this.options.findCurrentCodexCliTurnActivity ?? findCurrentCodexCliTurnActivity)({
      codexHome: codexDirectParityCodexHome,
      threadId: session.codexThreadId
    });
  }

  async closeAll(): Promise<void> {
    for (const timer of this.loginTimeoutTimers.values()) clearTimeout(timer);
    this.loginTimeoutTimers.clear();
    for (const timer of this.loginObservationTimers.values()) clearTimeout(timer);
    this.loginObservationTimers.clear();
    const managedSessions = [...this.sessions.values()];
    for (const managed of managedSessions) {
      this.clearQwenAuthBootstrap(managed);
      await this.detachTransport(managed).catch(() => undefined);
      await managed.persistQueue.catch(() => undefined);
      for (const socket of managed.sockets) {
        if (socketIsOpen(socket)) socket.close(1001, "API server closing");
      }
    }
    this.sessions.clear();
    this.tickets.clear();
    await Promise.all(
      [...new Set([...this.hostClients, this.adminHostClient])].map((client) => client.close())
    );
  }

  private async openConnection(
    socket: WebSocket,
    input: {
      paneId: string;
      pane: Pane | Promise<Pane>;
      sessionId: string;
      token: string;
      clientId?: string;
      protocolVersion?: 2;
      browserClientId?: string;
      tabLineageId?: string;
      pageClientId?: string;
      clientMode?: PaneCliClientMode;
      requestedLeaseId?: string;
      initialCols?: number;
      initialRows?: number;
      userId: string;
      proofScope?: "READ_ONLY";
      requestId: string;
      connectionOrder: number;
    }
  ): Promise<CliTerminalConnection> {
    this.consumeTicket(input.token, input.paneId, input.sessionId);
    const pane = await input.pane;
    const session = await this.options.store.getPaneCliSession(input.sessionId);
    if (!session) {
      throw new SpaceNotFoundError(`CLI session ${input.sessionId} was not found.`);
    }
    if (session.paneId !== pane.id || session.roomId !== pane.roomId) {
      throw new SpaceConflictError("CLI session does not belong to this pane.");
    }
    if (!session.isActive || session.status === "EXITED" || session.status === "ERROR") {
      throw new SpaceConflictError("CLI session is not active.");
    }

    const readOnlyObserver = input.proofScope === "READ_ONLY";
    const runtime = readOnlyObserver
      ? activeCliSessionObserverRuntime(this.options.config, session.runtimeId)
      : (await this.options.discoverRuntimes()).data.find((candidate) => candidate.id === session.runtimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${session.runtimeId} was not found.`);
    }
    if (
      !isCliSessionRuntimeAttachable(runtime, session) ||
      (!readOnlyObserver && !runtime.detectedCommandPath)
    ) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime?.statusReason ?? "CLI runtime is not enabled.", {
        runtimeId: session.runtimeId
      });
    }

    let attach: ManagedCliSessionAttach;
    try {
      attach = await this.getOrSpawnSession(
        session,
        runtime,
        input.requestId,
        socket,
        input.initialCols !== undefined && input.initialRows !== undefined
          ? { cols: input.initialCols, rows: input.initialRows }
          : undefined,
        { existingOnly: readOnlyObserver }
      );
    } catch (error) {
      if (!(error instanceof CliLoginConnectionReconciledError)) throw error;
      return {
        handleMessage: async () => undefined,
        detach: async () => undefined
      };
    }
    const managed = attach.managed;
    const protocolVersion = input.protocolVersion === 2 ? 2 : 1;
    const client: CliTerminalSocketContext = {
      protocolVersion,
      userId: input.userId,
      clientId: input.clientId ?? null,
      browserClientId: input.browserClientId ?? input.clientId ?? null,
      tabLineageId: input.tabLineageId ?? null,
      pageClientId: input.pageClientId ?? null,
      clientMode: input.proofScope === "READ_ONLY"
        ? "OBSERVER"
        : input.clientMode ?? "INTERACTIVE",
      requestedLeaseId: input.requestedLeaseId ?? null,
      proofScope: input.proofScope ?? null,
      leaseId: null,
      requestId: input.requestId,
      connectionOrder: input.connectionOrder,
      detached: false
    };
    managed.socketClients.set(socket, client);
    try {
      const control = await this.enqueueTerminalMutation(
        managed.sessionId,
        () => this.resolveInitialControl(managed, client)
      );
      const shouldReplay = !attach.spawned || attach.restoredTransport || attach.recreatedAfterHostLoss;
      if (shouldReplay) managed.socketReplayBuffers.set(socket, []);
      managed.sockets.add(socket);
      if (protocolVersion === 1 && (
        !managed.legacyControllerSocket ||
        !socketIsOpen(managed.legacyControllerSocket) ||
        (managed.socketClients.get(managed.legacyControllerSocket)?.connectionOrder ?? -1) <= input.connectionOrder
      )) {
        managed.legacyControllerSocket = socket;
      }
      if (input.clientId) {
        const current = managed.clientSockets.get(input.clientId);
        if (!current || current.connectionOrder <= input.connectionOrder) {
          managed.clientSockets.set(input.clientId, { socket, connectionOrder: input.connectionOrder });
        }
      }
      this.reportTelemetry(
        managed,
        "SOCKET_ATTACHED",
        "SUCCESS",
        attach.spawned ? "INITIAL_ATTACH" : "SESSION_REFRESH",
        {
          protocolVersion,
          clientMode: client.clientMode,
          controlState: control.controlState,
          requestId: input.requestId
        }
      );
      this.sendReady(socket, managed, client, control);
      if (shouldReplay) await this.replayTranscript(managed, socket, attach.transcriptSeed ?? undefined);
      managed.transportReady = true;
      const pendingHostEvents = managed.pendingHostEvents.splice(0);
      for (const event of pendingHostEvents) this.handleHostEvent(managed, event);
      if (!managed.closed) {
        this.send(socket, {
          type: "status",
          status: "RUNNING",
          statusReason:
            attach.replayContinuity === "TRUNCATED"
              ? "CLI terminal reconnected with a truncated replay."
              : attach.restoredTransport
                ? "CLI terminal transport restored after API restart; persisted transcript replayed."
                : attach.recreatedAfterHostLoss
                  ? "CLI host process recreated with exact resume after host loss."
                  : "Attached to CLI process.",
          replayContinuity: attach.replayContinuity
        });
      }

      return {
        handleMessage: (raw) => this.enqueueTerminalMutation(
          managed.sessionId,
          () => this.handleClientMessage(managed, socket, client, raw)
        ),
        detach: async () => {
          await this.detachClient(managed, socket, client);
          if (managed.sockets.size === 0) await this.detachTransport(managed);
        }
      };
    } catch (error) {
      await this.detachClient(managed, socket, client);
      if (managed.sockets.size === 0) await this.detachTransport(managed).catch(() => undefined);
      throw error;
    }
  }

  private unregisterSocket(managed: ManagedCliSession, socket: WebSocket, clientId?: string): void {
    managed.sockets.delete(socket);
    managed.socketReplayBuffers.delete(socket);
    managed.socketClients.delete(socket);
    if (managed.legacyControllerSocket === socket) {
      managed.legacyControllerSocket = [...managed.socketClients.entries()]
        .filter(([, client]) => client.protocolVersion === 1 && !client.detached)
        .sort((left, right) => right[1].connectionOrder - left[1].connectionOrder)[0]?.[0] ?? null;
    }
    if (clientId && managed.clientSockets.get(clientId)?.socket === socket) {
      managed.clientSockets.delete(clientId);
    }
  }

  private consumeTicket(token: string, paneId: string, sessionId: string) {
    this.pruneTickets();
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.paneId !== paneId || ticket.sessionId !== sessionId || ticket.expiresAtMs <= Date.now()) {
      throw new SpaceFeatureDisabledError("CLI_WS_TOKEN_INVALID", "CLI WebSocket token is invalid or expired.", {
        paneId,
        sessionId
      });
    }
  }

  private pruneTickets() {
    const now = Date.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) {
        this.tickets.delete(token);
      }
    }
  }

  private async getOrSpawnSession(
    session: PaneCliSession,
    runtime: AgentRuntime,
    traceId: string,
    initialSocket?: WebSocket,
    initialGeometry?: { cols: number; rows: number },
    options: { existingOnly?: boolean } = {}
  ): Promise<ManagedCliSessionAttach> {
    const inFlight = this.sessionAttachPromises.get(session.sessionId);
    if (inFlight) {
      const attached = await inFlight;
      return { ...attached, transcriptSeed: null, spawned: false };
    }
    const existing = this.sessions.get(session.sessionId);
    if (existing && !existing.closed && !existing.detached) {
      return {
        managed: existing,
        transcriptSeed: null,
        spawned: false,
        restoredTransport: false,
        recreatedAfterHostLoss: false,
        replayContinuity: "COMPLETE"
      };
    }

    const attach = this.createOrRestoreSession(
      session,
      runtime,
      traceId,
      initialSocket,
      initialGeometry,
      options
    );
    this.sessionAttachPromises.set(session.sessionId, attach);
    try {
      return await attach;
    } finally {
      if (this.sessionAttachPromises.get(session.sessionId) === attach) {
        this.sessionAttachPromises.delete(session.sessionId);
      }
    }
  }

  private async createOrRestoreSession(
    session: PaneCliSession,
    runtime: AgentRuntime,
    traceId: string,
    initialSocket?: WebSocket,
    initialGeometry?: { cols: number; rows: number },
    options: { existingOnly?: boolean } = {}
  ): Promise<ManagedCliSessionAttach> {
    const transcript = session.purpose === "LOGIN"
      ? []
      : await this.options.store.listPaneCliTranscriptChunks(session.sessionId);
    const startupOutput = transcript
      .filter((chunk) => chunk.stream === "stdout" || chunk.stream === "stderr")
      .map((chunk) => chunk.content)
      .join("")
      .slice(-16_000);
    const codexForkThreadId = options.existingOnly
      ? null
      : await this.codexHistoryTransferForkThreadId(session);
    const baseSession = codexForkThreadId ? { ...session, codexThreadId: null } : session;
    const baseIdentity = await this.buildHostIdentity(baseSession);
    const hostClient = this.hostForRuntime(session.runtimeId, session.sessionId);
    const inspected = await hostClient.inspect(baseIdentity);
    if (!inspected && options.existingOnly) {
      throw new SpaceNotFoundError(
        `Running CLI host session ${session.sessionId} was not found for a read-only observer.`
      );
    }
    const restoredTransport = inspected?.status === "RUNNING";
    if (inspected && !restoredTransport) {
      if (session.purpose === "LOGIN") {
        await this.reconcileClosedLoginHostSession(session, inspected, initialSocket);
        throw new CliLoginConnectionReconciledError();
      }
      await this.persistClosedNormalHostSession(session, inspected);
      throw new SpaceConflictError(`CLI host session ${session.sessionId} is ${inspected.status}.`);
    }
    const credentialObservation = session.purpose === "LOGIN"
      ? await this.readCredentialObservation(runtime)
      : null;
    if (
      session.purpose === "LOGIN" &&
      findCliRuntimeDescriptor(runtime.id)?.credentialObservationAction &&
      !credentialObservation
    ) {
      throw new SpaceFeatureDisabledError(
        "CLI_LOGIN_OBSERVATION_UNAVAILABLE",
        `CLI runtime ${runtime.id} could not start its controlled credential observation.`
      );
    }
    const restoringAfterHostLoss = !inspected && session.status === "RUNNING";
    const boundSession = codexForkThreadId
      ? baseSession
      : restoringAfterHostLoss
        ? await this.bindCodexThreadIdBeforeResume(session, traceId)
        : session;
    const nativeTaskRef = session.cliTaskRevisionId
      ? (await this.options.store.getCliTaskRevision(session.cliTaskRevisionId))?.nativeTaskRef ?? null
      : null;
    const baseSpawnSession: CliSpawnSession = codexForkThreadId
      ? await this.withCodexHistoryForkSettings(session, codexForkThreadId)
      : restoringAfterHostLoss
        ? await this.withCodexResumeSettings(boundSession)
        : boundSession;
    const spawnSession: CliSpawnSession = { ...baseSpawnSession, nativeTaskRef };
    const env = buildCliEnvironment(this.options.config, {
      roomId: session.roomId,
      paneId: session.paneId,
      cliSessionId: session.sessionId,
      runtimeId: session.runtimeId,
      purpose: session.purpose,
      cwd: session.cwd ?? this.options.config.cliWorkspaceRoot,
      sessionAllocatedMonotonicNs: inspected ? undefined : this.sessionAllocationMonotonicNs(session.sessionId)
    });
    if (env.TMPDIR && !isDirectOperatorParityRuntime(session.runtimeId)) {
      await mkdir(env.TMPDIR, { recursive: true });
    }
    const identity: CliHostIdentity = {
      cliSessionId: boundSession.sessionId,
      paneId: boundSession.paneId,
      roomId: boundSession.roomId,
      runtimeId: boundSession.runtimeId,
      codexThreadId: spawnSession.codexThreadId,
      modelId: spawnSession.codexResumeModelId ?? spawnSession.modelId,
      reasoningEffort: spawnSession.codexResumeReasoningEffort ?? boundSession.reasoningEffort
    };
    const pendingHostEvents: CliHostEvent[] = [];
    let managed: ManagedCliSession | null = null;
    const listener: CliHostEventListener = (event) => {
      if (!managed || !managed.transportReady) pendingHostEvents.push(event);
      else this.handleHostEvent(managed, event);
    };
    const afterSequence = inspected
      ? await this.options.store.getPaneCliHostOutputCursor(session.sessionId, inspected.generationId)
      : -1;
    const processLaunch = buildCliProcessLaunch(
      this.options.config,
      runtime,
      buildCliSpawnArgs(runtime, spawnSession)
    );
    const attachInput: CliHostAttachInput = {
      identity,
      spawn: inspected
        ? undefined
        : {
            command: processLaunch.command,
            args: processLaunch.args,
            cwd: session.cwd ?? this.options.config.cliWorkspaceRoot,
            env,
            cols: initialGeometry?.cols ?? 100,
            rows: initialGeometry?.rows ?? 30
          },
      afterSequence
    };
    let replayContinuity: ManagedCliSessionAttach["replayContinuity"] = "COMPLETE";
    let hostAttach: CliHostAttachResult;
    try {
      hostAttach = await hostClient.attach(attachInput, listener);
    } catch (error) {
      if (!(error instanceof CliHostError) || error.code !== "CLI_HOST_REPLAY_GAP" || !inspected) throw error;
      replayContinuity = "TRUNCATED";
      hostAttach = await hostClient.attach(
        {
          identity,
          afterSequence: Math.max(-1, inspected.nextOutputSequence - 1)
        },
        listener
      );
    }
    this.sessionAllocations.delete(session.sessionId);
    const eventsAfterReplay = [...hostAttach.replay, ...pendingHostEvents];
    pendingHostEvents.splice(0, pendingHostEvents.length, ...eventsAfterReplay);
    const restoredInputReady =
      !isCodexDirectParityRuntime(session.runtimeId) ||
      Boolean(
        inspected &&
        !codexStartupBusy(startupOutput) &&
        Date.now() - Date.parse(inspected.startedAt) >= (this.options.startupReadyTimeoutMs ?? cliStartupReadyTimeoutMs)
      );
    const restoredCodexModelControlReady =
      !isCodexDirectParityRuntime(session.runtimeId) ||
      Boolean(
        inspected &&
        !codexStartupBusy(startupOutput) &&
        (
          codexInputReady(startupOutput) ||
          findLatestCodexCliTranscriptModelSettings(startupOutput, session.cwd)
        ) &&
        Date.now() - Date.parse(inspected.startedAt) >= (this.options.startupReadyTimeoutMs ?? cliStartupReadyTimeoutMs)
      );
    managed = {
      identity: {
        cliSessionId: hostAttach.session.cliSessionId,
        paneId: hostAttach.session.paneId,
        roomId: hostAttach.session.roomId,
        runtimeId: hostAttach.session.runtimeId,
        codexThreadId: hostAttach.session.codexThreadId,
        modelId: hostAttach.session.modelId,
        reasoningEffort: hostAttach.session.reasoningEffort
      },
      attachmentId: hostAttach.attachmentId,
      attachmentRecovery: null,
      generationId: hostAttach.session.generationId,
      paneId: session.paneId,
      roomId: session.roomId,
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      purpose: session.purpose,
      credentialObservation,
      credentialSmokeRetryObservation: null,
      qwenAuthBootstrapTimer: null,
      qwenAuthBootstrapSent: false,
      cwd: session.cwd,
      sockets: new Set(initialSocket ? [initialSocket] : []),
      clientSockets: new Map(),
      socketClients: new Map(),
      legacyControllerSocket: null,
      socketReplayBuffers: new Map(),
      closed: false,
      detached: false,
      transportReady: false,
      inputReady: restoredInputReady,
      codexModelControlReady: restoredCodexModelControlReady,
      startupOutput,
      pendingHostEvents,
      pendingHostOutput: null,
      hostOutputQueue: [],
      hostOutputFlushTimer: null,
      nextTranscriptSequence: (transcript.at(-1)?.sequence ?? -1) + 1,
      persistQueue: Promise.resolve(),
      controlQueue: Promise.resolve(),
      controlOutput: "",
      controlOutputRevision: 0,
      reportedNullAgentMessageTurns: new Set(),
      nullAgentMessageCheckSinceMs: null,
      nullAgentMessageCheckUntilMs: 0,
      nullAgentMessageCheckInputText: null,
      nullAgentMessageCheckTimer: null,
      codexThreadId: spawnSession.codexThreadId,
      codexThreadBindSinceMs: null,
      codexThreadBindUntilMs: 0,
      codexThreadBindTimer: null,
      turnMarkers: new Map()
    };
    const attachedManaged = managed as ManagedCliSession;
    this.sessions.set(session.sessionId, attachedManaged);
    if (session.purpose === "LOGIN") {
      this.scheduleLoginTimeout(session);
      this.scheduleLoginObservation(attachedManaged, runtime);
    }
    if (codexForkThreadId && !attachedManaged.codexThreadId) {
      const startedAtMs = Date.parse(hostAttach.session.startedAt);
      this.startImmediateCodexThreadBind(
        attachedManaged,
        Number.isFinite(startedAtMs) ? startedAtMs - 1_000 : Date.now() - 1_000
      );
    }

    await this.options.store.updatePaneCliSession(
      session.sessionId,
      {
        status: "RUNNING",
        launchMode: "FRESH",
        statusReason:
          replayContinuity === "TRUNCATED"
            ? "CLI terminal reattached after earlier unpersisted output exceeded the host replay window."
            : restoredTransport
              ? "CLI terminal transport reattached to the independent pane host."
              : codexForkThreadId
                ? "CLI process forked from selected Codex history because its original app-server is unavailable."
                : session.launchMode === "RESUME"
                  ? "CLI process attached in native task resume mode."
                : restoringAfterHostLoss
                  ? "CLI host process was recreated with exact Codex thread, model, and reasoning resume settings."
                  : "CLI process attached to the independent pane host.",
        isActive: true
      },
      traceId
    );
    await this.appendTranscript(
      attachedManaged,
      "system",
      replayContinuity === "TRUNCATED"
        ? `${runtime.displayName} terminal reconnected; earlier unpersisted output was outside the host replay window.`
        : restoredTransport
          ? `${runtime.displayName} terminal transport reattached to the independent pane host.`
          : codexForkThreadId
            ? `${runtime.displayName} forked the selected history into a recoverable local task.`
            : restoringAfterHostLoss
              ? `${runtime.displayName} host process recreated with exact resume after host loss.`
              : `${runtime.displayName} process attached to the independent pane host.`,
      traceId
    );

    return {
      managed: attachedManaged,
      transcriptSeed: transcript,
      spawned: !inspected,
      restoredTransport,
      recreatedAfterHostLoss: restoringAfterHostLoss,
      replayContinuity
    };
  }

  private async bindCodexThreadIdBeforeResume(session: PaneCliSession, traceId: string): Promise<PaneCliSession> {
    if (!isCodexDirectParityRuntime(session.runtimeId) || session.codexThreadId) return session;
    const codexThreadId = await findAvailableCodexThreadId({
      store: this.options.store,
      paneId: session.paneId,
      sessionId: session.sessionId,
      cwd: codexDirectParityCwd,
      findThreadId: this.options.findCodexThreadId
    });
    if (!codexThreadId) return session;
    try {
      await this.options.store.claimPaneCliCodexThread(session.sessionId, codexThreadId, "AUTO", traceId);
      return (await this.options.store.getPaneCliSession(session.sessionId)) ?? session;
    } catch (error) {
      if (error instanceof SpaceConflictError) {
        return session;
      }
      throw error;
    }
  }

  private async codexHistoryTransferForkThreadId(session: PaneCliSession): Promise<string | null> {
    if (!isCodexDirectParityRuntime(session.runtimeId) || !session.codexThreadId) return null;
    const ownership = await this.options.store.getPaneCliCodexThreadOwnership(session.codexThreadId);
    return ownership?.source === "HISTORY_TRANSFER" && ownership.cliSessionId === session.sessionId
      ? session.codexThreadId
      : null;
  }

  private async withCodexHistoryForkSettings(
    session: PaneCliSession,
    codexForkThreadId: string
  ): Promise<CliSpawnSession> {
    const settings = await this.withCodexResumeSettings(session);
    return {
      ...settings,
      codexThreadId: null,
      codexForkThreadId
    };
  }

  private async withCodexResumeSettings(session: PaneCliSession): Promise<CliSpawnSession> {
    if (!isCodexDirectParityRuntime(session.runtimeId) || !session.codexThreadId) return session;
    const findResumeSettings = this.options.findCodexThreadResumeSettings ?? findSafeCodexThreadResumeSettings;
    try {
      const settings = await findResumeSettings({
        threadId: session.codexThreadId,
        cwd: codexDirectParityCwd
      });
      if (!settings) return session;
      return {
        ...session,
        codexResumeModelId: settings.modelId,
        codexResumeReasoningEffort: settings.reasoningEffort
      };
    } catch {
      return session;
    }
  }

  private enqueueTerminalMutation<T>(
    sessionId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const previous = this.terminalMutationQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = next.then(() => undefined, () => undefined);
    this.terminalMutationQueues.set(sessionId, settled);
    void settled.then(() => {
      if (this.terminalMutationQueues.get(sessionId) === settled) {
        this.terminalMutationQueues.delete(sessionId);
      }
    });
    return next;
  }

  runSerializedTerminalMutation<T>(
    sessionIds: string | readonly string[],
    operation: () => Promise<T> | T
  ): Promise<T> {
    const orderedSessionIds = [...new Set(typeof sessionIds === "string" ? [sessionIds] : sessionIds)].sort();
    const run = (index: number): Promise<T> => {
      const sessionId = orderedSessionIds[index];
      return sessionId
        ? this.enqueueTerminalMutation(sessionId, () => run(index + 1))
        : Promise.resolve().then(operation);
    };
    return run(0);
  }

  private leaseBelongsToClient(
    lease: PaneCliTerminalControlLease,
    client: CliTerminalSocketContext
  ): boolean {
    return client.protocolVersion === 2 &&
      client.browserClientId !== null &&
      client.tabLineageId !== null &&
      client.pageClientId !== null &&
      lease.userId === client.userId &&
      lease.browserClientId === client.browserClientId &&
      lease.tabLineageId === client.tabLineageId &&
      lease.pageClientId === client.pageClientId;
  }

  private createControlLease(
    managed: ManagedCliSession,
    client: CliTerminalSocketContext,
    expectedActiveLeaseId: string | null
  ): Promise<PaneCliTerminalControlLease> | PaneCliTerminalControlLease {
    if (!client.browserClientId || !client.tabLineageId || !client.pageClientId) {
      throw new SpaceConflictError("Protocol-v2 CLI control requires page identity.");
    }
    return this.options.store.createPaneCliTerminalControlLease({
      sessionId: managed.sessionId,
      paneId: managed.paneId,
      roomId: managed.roomId,
      userId: client.userId,
      browserClientId: client.browserClientId,
      tabLineageId: client.tabLineageId,
      pageClientId: client.pageClientId,
      expectedActiveLeaseId,
      ttlSeconds: cliTerminalControlLeaseTtlSeconds
    });
  }

  private async resolveInitialControl(
    managed: ManagedCliSession,
    client: CliTerminalSocketContext
  ): Promise<CliTerminalResolvedControl> {
    if (client.protocolVersion !== 2) return { controlState: "AVAILABLE", lease: null };
    if (client.clientMode === "OBSERVER" || client.proofScope === "READ_ONLY") {
      return { controlState: "OBSERVER", lease: null };
    }

    let active = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
    if (active) {
      if (client.requestedLeaseId !== active.leaseId || !this.leaseBelongsToClient(active, client)) {
        this.reportTelemetry(managed, "CONTROL_DENIED", "DENIED", "CONTROL_HELD", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: "HELD_BY_OTHER",
          requestId: client.requestId
        });
        return { controlState: "HELD_BY_OTHER", lease: active };
      }
      try {
        active = await this.options.store.updatePaneCliTerminalControlLease(active.leaseId, {
          expectedStatus: "ACTIVE",
          ttlSeconds: cliTerminalControlLeaseTtlSeconds
        });
        client.leaseId = active.leaseId;
        this.reportTelemetry(managed, "CONTROL_RENEWED", "SUCCESS", "CONTROL_RENEWED", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: "CONTROLLER",
          requestId: client.requestId
        });
        return { controlState: "CONTROLLER", lease: active };
      } catch {
        const latest = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
        this.reportTelemetry(managed, "CONTROL_DENIED", "DENIED", latest ? "RACE_LOST" : "LEASE_STALE", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: latest ? "HELD_BY_OTHER" : "AVAILABLE",
          requestId: client.requestId
        });
        return latest
          ? { controlState: "HELD_BY_OTHER", lease: latest }
          : { controlState: "AVAILABLE", lease: null };
      }
    }

    try {
      const acquired = await this.createControlLease(managed, client, null);
      client.leaseId = acquired.leaseId;
      this.reportTelemetry(managed, "CONTROL_ACQUIRED", "SUCCESS", "CONTROL_ACQUIRED", {
        protocolVersion: client.protocolVersion,
        clientMode: client.clientMode,
        controlState: "CONTROLLER",
        requestId: client.requestId
      });
      return { controlState: "CONTROLLER", lease: acquired };
    } catch (error) {
      const raced = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
      if (!raced) throw error;
      this.reportTelemetry(managed, "CONTROL_DENIED", "DENIED", "RACE_LOST", {
        protocolVersion: client.protocolVersion,
        clientMode: client.clientMode,
        controlState: "HELD_BY_OTHER",
        requestId: client.requestId
      });
      return { controlState: "HELD_BY_OTHER", lease: raced };
    }
  }

  private sendReady(
    socket: WebSocket,
    managed: ManagedCliSession,
    client: CliTerminalSocketContext,
    control: CliTerminalResolvedControl
  ): void {
    if (client.protocolVersion !== 2) {
      this.send(socket, {
        type: "ready",
        paneId: managed.paneId,
        sessionId: managed.sessionId,
        runtimeId: managed.runtimeId
      });
      return;
    }
    this.send(socket, {
      type: "ready",
      paneId: managed.paneId,
      sessionId: managed.sessionId,
      runtimeId: managed.runtimeId,
      protocolVersion: 2,
      clientMode: client.clientMode,
      controlState: control.controlState,
      ...(control.controlState === "CONTROLLER" && control.lease
        ? {
            leaseId: control.lease.leaseId,
            expiresAt: control.lease.expiresAt
          }
        : {}),
      ...(control.controlState === "HELD_BY_OTHER" && control.lease
        ? {
            holderPageClientId: control.lease.pageClientId,
            expiresAt: control.lease.expiresAt
          }
        : {}),
      heartbeatIntervalMs: cliTerminalControlHeartbeatIntervalMs
    });
    this.sendControlState(socket, control.controlState, control.lease);
  }

  private sendControlState(
    socket: WebSocket,
    controlState: PaneCliTerminalControlState,
    lease: PaneCliTerminalControlLease | null
  ): void {
    this.send(socket, {
      type: "control_state",
      controlState,
      ...(lease
        ? {
            leaseId: lease.leaseId,
            holderPageClientId: controlState === "HELD_BY_OTHER" ? lease.pageClientId : undefined,
            expiresAt: lease.expiresAt
          }
        : {})
    });
  }

  private async broadcastControlStates(managed: ManagedCliSession): Promise<void> {
    const active = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
    for (const [socket, client] of managed.socketClients) {
      if (client.protocolVersion !== 2 || !socketIsOpen(socket)) continue;
      if (client.clientMode === "OBSERVER" || client.proofScope === "READ_ONLY") {
        client.leaseId = null;
        this.sendControlState(socket, "OBSERVER", null);
      } else if (active && this.leaseBelongsToClient(active, client)) {
        client.leaseId = active.leaseId;
        this.sendControlState(socket, "CONTROLLER", active);
      } else {
        client.leaseId = null;
        this.sendControlState(socket, active ? "HELD_BY_OTHER" : "AVAILABLE", active);
      }
    }
  }

  private sendControlDenied(
    managed: ManagedCliSession,
    client: CliTerminalSocketContext,
    socket: WebSocket,
    code: string,
    message: string
  ): void {
    this.reportTelemetry(managed, "CONTROL_DENIED", "DENIED", cliControlDeniedTelemetryReason(code), {
      protocolVersion: client.protocolVersion,
      clientMode: client.clientMode,
      controlState: client.clientMode === "OBSERVER"
        ? "OBSERVER"
        : client.leaseId
          ? "CONTROLLER"
          : "AVAILABLE",
      requestId: client.requestId
    });
    this.send(socket, { type: "control_denied", code, message });
  }

  private async activeLeaseForClient(
    managed: ManagedCliSession,
    client: CliTerminalSocketContext,
    leaseId: string
  ): Promise<PaneCliTerminalControlLease | null> {
    const active = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
    return active && active.leaseId === leaseId && this.leaseBelongsToClient(active, client)
      ? active
      : null;
  }

  private async handleControlMessage(
    managed: ManagedCliSession,
    socket: WebSocket,
    client: CliTerminalSocketContext,
    message: Extract<PaneCliWebSocketClientMessage, {
      type: "control_upgrade" | "control_request" | "control_takeover" | "control_heartbeat" | "control_release";
    }>
  ): Promise<void> {
    if (client.protocolVersion !== 2) {
      this.sendControlDenied(managed, client, socket, "CLI_PROTOCOL_REQUIRED", "CLI control requires protocol version 2.");
      return;
    }
    if (message.type === "control_upgrade") {
      if (client.proofScope === "READ_ONLY") {
        this.sendControlDenied(managed, client, socket, "CLI_OBSERVER_MUTATION_DENIED", "Observer clients cannot request terminal control.");
        return;
      }
      client.clientMode = "INTERACTIVE";
      this.send(socket, { type: "control_upgraded" });
      return;
    }
    if (client.clientMode === "OBSERVER" || client.proofScope === "READ_ONLY") {
      this.sendControlDenied(managed, client, socket, "CLI_OBSERVER_MUTATION_DENIED", "Observer clients cannot request terminal control.");
      return;
    }

    if (message.type === "control_request") {
      const active = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
      if (active) {
        if (!this.leaseBelongsToClient(active, client)) {
          this.sendControlDenied(managed, client, socket, "CLI_CONTROL_HELD", "CLI terminal control is held by another page.");
          this.sendControlState(socket, "HELD_BY_OTHER", active);
          return;
        }
        const renewed = await this.options.store.updatePaneCliTerminalControlLease(active.leaseId, {
          expectedStatus: "ACTIVE",
          ttlSeconds: cliTerminalControlLeaseTtlSeconds
        });
        client.leaseId = renewed.leaseId;
        this.reportTelemetry(managed, "CONTROL_RENEWED", "SUCCESS", "CONTROL_RENEWED", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: "CONTROLLER",
          requestId: client.requestId
        });
        this.send(socket, { type: "control_granted", leaseId: renewed.leaseId, expiresAt: renewed.expiresAt });
        await this.broadcastControlStates(managed);
        return;
      }
      try {
        const acquired = await this.createControlLease(managed, client, null);
        client.leaseId = acquired.leaseId;
        this.reportTelemetry(managed, "CONTROL_ACQUIRED", "SUCCESS", "CONTROL_ACQUIRED", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: "CONTROLLER",
          requestId: client.requestId
        });
        this.send(socket, { type: "control_granted", leaseId: acquired.leaseId, expiresAt: acquired.expiresAt });
        await this.broadcastControlStates(managed);
      } catch (error) {
        const raced = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
        if (!raced) throw error;
        this.sendControlDenied(managed, client, socket, "CLI_CONTROL_HELD", "CLI terminal control is held by another page.");
        this.sendControlState(socket, "HELD_BY_OTHER", raced);
      }
      return;
    }

    if (message.type === "control_takeover") {
      const previous = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
      if (!previous || previous.leaseId !== message.expectedLeaseId) {
        this.sendControlDenied(managed, client, socket, "CLI_LEASE_STALE", "CLI terminal control changed before takeover.");
        return;
      }
      let acquired: PaneCliTerminalControlLease;
      try {
        acquired = await this.createControlLease(managed, client, previous.leaseId);
      } catch (error) {
        const latest = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
        if (!latest || latest.leaseId !== previous.leaseId) {
          this.sendControlDenied(managed, client, socket, "CLI_LEASE_STALE", "CLI terminal control changed before takeover.");
          return;
        }
        throw error;
      }
      for (const [currentSocket, current] of managed.socketClients) {
        if (current.leaseId !== previous.leaseId && !this.leaseBelongsToClient(previous, current)) continue;
        current.leaseId = null;
        this.send(currentSocket, {
          type: "control_revoked",
          leaseId: previous.leaseId,
          reason: "TAKEN_OVER"
        });
      }
      client.leaseId = acquired.leaseId;
      this.reportTelemetry(managed, "CONTROL_TAKEN_OVER", "SUCCESS", "TAKEN_OVER", {
        protocolVersion: client.protocolVersion,
        clientMode: client.clientMode,
        controlState: "CONTROLLER",
        requestId: client.requestId
      });
      this.send(socket, { type: "control_granted", leaseId: acquired.leaseId, expiresAt: acquired.expiresAt });
      await this.broadcastControlStates(managed);
      return;
    }

    const active = await this.activeLeaseForClient(managed, client, message.leaseId);
    if (!active) {
      client.leaseId = null;
      this.sendControlDenied(managed, client, socket, "CLI_LEASE_STALE", "CLI terminal control lease is stale.");
      return;
    }
    if (message.type === "control_heartbeat") {
      try {
        const renewed = await this.options.store.updatePaneCliTerminalControlLease(active.leaseId, {
          expectedStatus: "ACTIVE",
          ttlSeconds: cliTerminalControlLeaseTtlSeconds
        });
        client.leaseId = renewed.leaseId;
        this.reportTelemetry(managed, "CONTROL_RENEWED", "SUCCESS", "CONTROL_RENEWED", {
          protocolVersion: client.protocolVersion,
          clientMode: client.clientMode,
          controlState: "CONTROLLER",
          requestId: client.requestId
        });
      } catch {
        client.leaseId = null;
        this.sendControlDenied(managed, client, socket, "CLI_LEASE_STALE", "CLI terminal control lease is stale.");
      }
      return;
    }

    try {
      await this.options.store.updatePaneCliTerminalControlLease(active.leaseId, {
        expectedStatus: "ACTIVE",
        status: "RELEASED"
      });
    } catch {
      client.leaseId = null;
      this.sendControlDenied(managed, client, socket, "CLI_LEASE_STALE", "CLI terminal control lease is stale.");
      return;
    }
    this.reportTelemetry(managed, "CONTROL_RELEASED", "SUCCESS", "CONTROL_RELEASED", {
      protocolVersion: client.protocolVersion,
      clientMode: client.clientMode,
      controlState: "AVAILABLE",
      requestId: client.requestId
    });
    for (const current of managed.socketClients.values()) {
      if (current.leaseId === active.leaseId) current.leaseId = null;
    }
    await this.broadcastControlStates(managed);
  }

  private async authorizeHostMutation(
    managed: ManagedCliSession,
    socket: WebSocket,
    client: CliTerminalSocketContext,
    leaseId: string | undefined,
    mutation: "input" | "resize" | "interrupt"
  ): Promise<boolean> {
    if (client.protocolVersion === 1) {
      if (await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId)) {
        this.sendControlDenied(managed, client, socket, "CLI_CONTROL_REQUIRED", "Terminal control is held by a protocol-v2 page.");
        return false;
      }
      if (mutation === "resize" && managed.legacyControllerSocket !== socket) return false;
      if (mutation !== "resize") managed.legacyControllerSocket = socket;
      return true;
    }
    if (client.clientMode === "OBSERVER" || client.proofScope === "READ_ONLY" || !leaseId) {
      this.sendControlDenied(managed, client, socket, "CLI_CONTROL_REQUIRED", "Take control before mutating the terminal.");
      return false;
    }
    const active = await this.activeLeaseForClient(managed, client, leaseId);
    if (!active) {
      client.leaseId = null;
      this.sendControlDenied(managed, client, socket, "CLI_CONTROL_REQUIRED", "Take control before mutating the terminal.");
      return false;
    }
    client.leaseId = active.leaseId;
    return true;
  }

  private async detachClient(
    managed: ManagedCliSession,
    socket: WebSocket,
    client: CliTerminalSocketContext
  ): Promise<void> {
    if (client.detached) return;
    client.detached = true;
    const leaseId = client.leaseId;
    this.unregisterSocket(managed, socket, client.clientId ?? undefined);
    this.reportTelemetry(managed, "SOCKET_DETACHED", "INFO", "CLIENT_DETACH", {
      protocolVersion: client.protocolVersion,
      clientMode: client.clientMode,
      controlState: client.clientMode === "OBSERVER"
        ? "OBSERVER"
        : leaseId
          ? "CONTROLLER"
          : "AVAILABLE",
      requestId: client.requestId
    });
    if (
      leaseId &&
      ![...managed.socketClients.values()].some((current) =>
        current.leaseId === leaseId &&
        current.userId === client.userId &&
        current.pageClientId === client.pageClientId
      )
    ) {
      const active = await this.options.store.getActivePaneCliTerminalControlLease(managed.sessionId);
      if (active && active.leaseId === leaseId && this.leaseBelongsToClient(active, client)) {
        try {
          await this.options.store.updatePaneCliTerminalControlLease(active.leaseId, {
            expectedStatus: "ACTIVE",
            ttlSeconds: cliTerminalControlReconnectGraceSeconds
          });
          this.reportTelemetry(managed, "RECONNECT_GRACE_STARTED", "INFO", "RECONNECT_GRACE", {
            protocolVersion: client.protocolVersion,
            clientMode: client.clientMode,
            controlState: "CONTROLLER",
            requestId: client.requestId
          });
        } catch {
          // A concurrent release or takeover already settled authority.
        }
      }
    }
  }

  private async handleClientMessage(
    managed: ManagedCliSession,
    socket: WebSocket,
    client: CliTerminalSocketContext,
    raw: WebSocket.RawData
  ): Promise<void> {
    if (client.detached) return;
    if (managed.closed) {
      this.send(socket, { type: "error", code: "CLI_SESSION_CLOSED", message: "CLI session is closed." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(parseSocketData(raw));
    } catch {
      this.send(socket, { type: "error", code: "BAD_MESSAGE", message: "WebSocket message must be valid JSON." });
      return;
    }
    const parsed = paneCliWebSocketClientMessageSchema.safeParse(payload);
    if (!parsed.success) {
      this.send(socket, { type: "error", code: "BAD_MESSAGE", message: "WebSocket message failed schema validation." });
      return;
    }
    if (
      parsed.data.type === "control_upgrade" ||
      parsed.data.type === "control_request" ||
      parsed.data.type === "control_takeover" ||
      parsed.data.type === "control_heartbeat" ||
      parsed.data.type === "control_release"
    ) {
      await this.handleControlMessage(managed, socket, client, parsed.data);
      return;
    }
    if (parsed.data.type === "input") {
      const message = parsed.data;
      if (!await this.authorizeHostMutation(managed, socket, client, message.leaseId, "input")) return;
      const terminalData = sanitizeCliTerminalInput(managed.runtimeId, message.data);
      if (!terminalData) return;
      const receivedAtMs = Date.now();
      const diagnosticSinceMs = receivedAtMs - 1000;
      const hiddenInput = message.display === "hidden";
      await this.flushHostOutput(managed);
      const inputResult = await this.withFreshHostAttachment(managed, () =>
        this.hostForRuntime(managed.runtimeId, managed.sessionId).input(
          managed.identity,
          managed.attachmentId,
          terminalData,
          message.display
        )
      );
      const markerAtMs = inputResult?.acceptedAtMs ?? receivedAtMs;
      if (managed.purpose === "NORMAL" && message.turnMarker && inputResult?.accepted !== false) {
        this.pruneTurnMarkers(managed);
        managed.turnMarkers.set(message.turnMarker, {
          markerAtMs,
          turnId: null,
          expiresAtMs: markerAtMs + cliTurnMarkerTtlMs
        });
        if (isCodexDirectParityRuntime(managed.runtimeId)) {
          await this.options.store.createCodexCliTurnMarker({
            sessionId: managed.sessionId,
            roomId: managed.roomId,
            paneId: managed.paneId,
            clientTurnMarker: message.turnMarker,
            submittedAt: new Date(markerAtMs).toISOString()
          });
        }
        this.scheduleCodexThreadBind(managed, diagnosticSinceMs);
      }
      if (!hiddenInput && managed.purpose !== "LOGIN") {
        await this.appendTranscript(managed, "stdin", terminalData);
      }
      if (!hiddenInput && managed.purpose !== "LOGIN" && terminalData.trim()) {
        this.scheduleCodexNullAgentMessageCheck(managed, diagnosticSinceMs, terminalData);
        this.scheduleCodexThreadBind(managed, diagnosticSinceMs);
      }
      return;
    }
    if (parsed.data.type === "resize") {
      const message = parsed.data;
      if (!await this.authorizeHostMutation(managed, socket, client, message.leaseId, "resize")) return;
      await this.withFreshHostAttachment(managed, () =>
        this.hostForRuntime(managed.runtimeId, managed.sessionId).resize(
          managed.identity,
          managed.attachmentId,
          message.cols,
          message.rows
        )
      );
      return;
    }
    if (!await this.authorizeHostMutation(managed, socket, client, parsed.data.leaseId, "interrupt")) return;
    await this.flushHostOutput(managed);
    if (managed.purpose === "LOGIN") {
      await this.failLoginSession(managed.sessionId, "CANCELLED", managed, true);
      return;
    }
    await this.appendTranscript(managed, "system", "Interrupt requested from terminal WebSocket.");
    try {
      await this.terminateManagedHostSession(managed);
    } catch (error) {
      if (!cliHostSessionUnavailable(error)) throw error;
      await this.closeUnavailableHostSession(managed);
    }
  }

  private async withFreshHostAttachment<T>(managed: ManagedCliSession, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof CliHostError) || error.code !== "CLI_HOST_ATTACHMENT_NOT_FOUND") throw error;
      await this.recoverHostAttachment(managed);
      return operation();
    }
  }

  private async recoverHostAttachment(managed: ManagedCliSession): Promise<void> {
    if (managed.attachmentRecovery) return managed.attachmentRecovery;
    const recovery = this.replaceHostAttachment(managed);
    managed.attachmentRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (managed.attachmentRecovery === recovery) managed.attachmentRecovery = null;
    }
  }

  private async replaceHostAttachment(managed: ManagedCliSession): Promise<void> {
    if (managed.closed) throw new SpaceConflictError(`CLI session ${managed.sessionId} closed before its attachment could recover.`);
    const host = this.hostForRuntime(managed.runtimeId, managed.sessionId);
    await this.flushHostOutput(managed);
    await host.detach(managed.identity, managed.attachmentId).catch(() => false);
    const inspected = await host.inspect(managed.identity);
    if (!inspected || inspected.status !== "RUNNING") {
      throw new SpaceNotFoundError(`Running CLI host session ${managed.sessionId} was not found during attachment recovery.`);
    }

    managed.transportReady = false;
    const pendingHostEvents: CliHostEvent[] = [];
    const listener: CliHostEventListener = (event) => {
      if (!managed.transportReady) pendingHostEvents.push(event);
      else this.handleHostEvent(managed, event);
    };
    const afterSequence = await this.options.store.getPaneCliHostOutputCursor(managed.sessionId, inspected.generationId);
    let replayContinuity: ManagedCliSessionAttach["replayContinuity"] = "COMPLETE";
    let attached: CliHostAttachResult;
    try {
      attached = await host.attach({ identity: managed.identity, afterSequence }, listener);
    } catch (error) {
      if (!(error instanceof CliHostError) || error.code !== "CLI_HOST_REPLAY_GAP") throw error;
      replayContinuity = "TRUNCATED";
      attached = await host.attach(
        { identity: managed.identity, afterSequence: Math.max(-1, inspected.nextOutputSequence - 1) },
        listener
      );
    }
    if (managed.closed) {
      await host.detach(managed.identity, attached.attachmentId).catch(() => false);
      throw new SpaceConflictError(`CLI session ${managed.sessionId} closed during attachment recovery.`);
    }

    const generationChanged = managed.generationId !== attached.session.generationId;
    managed.identity = {
      cliSessionId: attached.session.cliSessionId,
      paneId: attached.session.paneId,
      roomId: attached.session.roomId,
      runtimeId: attached.session.runtimeId,
      codexThreadId: attached.session.codexThreadId,
      modelId: attached.session.modelId,
      reasoningEffort: attached.session.reasoningEffort
    };
    managed.attachmentId = attached.attachmentId;
    managed.generationId = attached.session.generationId;
    if (generationChanged) {
      this.clearQwenAuthBootstrap(managed);
      managed.qwenAuthBootstrapSent = false;
      managed.controlOutput = "";
    }
    managed.detached = false;
    managed.transportReady = true;
    this.sessions.set(managed.sessionId, managed);
    for (const event of [...attached.replay, ...pendingHostEvents]) this.handleHostEvent(managed, event);
    await this.flushHostOutput(managed);
    this.broadcast(managed, {
      type: "status",
      status: "RUNNING",
      statusReason: "CLI terminal attachment recovered without restarting the process.",
      replayContinuity
    });
  }

  private serialize(message: PaneCliWebSocketServerMessage): string[] {
    if (message.type === "output" && message.data.length > 0) {
      return chunkTerminalOutput(message.data).map((chunk) =>
        JSON.stringify(paneCliWebSocketServerMessageSchema.parse({ ...message, data: chunk }))
      );
    }
    return [JSON.stringify(paneCliWebSocketServerMessageSchema.parse(message))];
  }

  private sendSerialized(socket: WebSocket, frames: readonly string[]): void {
    if (!socketIsOpen(socket)) return;
    for (const frame of frames) socket.send(frame);
  }

  private send(socket: WebSocket, message: PaneCliWebSocketServerMessage) {
    this.sendSerialized(socket, this.serialize(message));
  }

  private broadcast(managed: ManagedCliSession, message: PaneCliWebSocketServerMessage) {
    const frames = this.serialize(message);
    for (const socket of managed.sockets) {
      const replayBuffer = managed.socketReplayBuffers.get(socket);
      if (replayBuffer) replayBuffer.push(...frames);
      else this.sendSerialized(socket, frames);
    }
  }

  private async replayTranscript(
    managed: ManagedCliSession,
    socket: WebSocket,
    transcriptSeed?: readonly PaneCliTranscriptChunk[]
  ): Promise<void> {
    const needsInitialFlush = Boolean(managed.pendingHostOutput || managed.hostOutputQueue?.length);
    const initialFlush = this.flushHostOutput(managed);
    const replayPrerequisite = needsInitialFlush ? initialFlush : managed.persistQueue;
    const transcriptReplay = this.enqueuePersistence(managed, async () => {
      const transcript = transcriptSeed ?? await this.options.store.listPaneCliTranscriptChunks(managed.sessionId);
      let framesSinceYield = 0;
      for (const chunk of transcript) {
        if (chunk.stream !== "stdout" && chunk.stream !== "stderr") continue;
        if (!chunk.content) continue;
        const frames = this.serialize({ type: "output", stream: chunk.stream, data: chunk.content });
        this.sendSerialized(socket, frames);
        framesSinceYield += frames.length;
        if (framesSinceYield >= terminalReplayFramesPerYield) {
          framesSinceYield = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }, replayPrerequisite, false);
    await transcriptReplay;
    const replayBuffer = managed.socketReplayBuffers.get(socket) ?? [];
    managed.socketReplayBuffers.delete(socket);
    this.sendSerialized(socket, replayBuffer);
  }

  private closeWithError(socket: WebSocket, error: unknown) {
    const message = error instanceof Error ? error.message : "CLI terminal attach failed.";
    this.send(socket, { type: "error", code: "CLI_TERMINAL_ATTACH_FAILED", message });
    if (socketIsOpen(socket)) {
      socket.close(1008, "CLI terminal unavailable");
    }
  }

  private async appendTranscript(
    managed: ManagedCliSession,
    stream: "stdin" | "stdout" | "stderr" | "system",
    content: string,
    traceId = "req:cli-terminal"
  ): Promise<void> {
    if (managed.purpose === "LOGIN") return;
    return this.enqueuePersistence(managed, () => this.appendTranscriptNow(managed, stream, content, traceId));
  }

  private async appendTranscriptNow(
    managed: ManagedCliSession,
    stream: "stdin" | "stdout" | "stderr" | "system",
    content: string,
    traceId: string
  ): Promise<void> {
    if (managed.purpose === "LOGIN") return;
    for (const chunk of chunkTerminalOutput(content)) {
      const redacted = redactMemoryText(chunk);
      if (!redacted) continue;
      const sequence = managed.nextTranscriptSequence;
      await this.options.store.appendPaneCliTranscriptChunk(
        {
          sessionId: managed.sessionId,
          paneId: managed.paneId,
          roomId: managed.roomId,
          sequence,
          stream,
          content: redacted,
          byteLength: Buffer.byteLength(redacted, "utf8")
        },
        traceId
      );
      managed.nextTranscriptSequence = sequence + 1;
    }
  }

  private bufferHostOutput(managed: ManagedCliSession, event: Extract<CliHostEvent, { type: "output" }>): void {
    if (managed.purpose === "LOGIN") return;
    const content = redactMemoryText(event.data) || "[redacted CLI host output]";
    const byteLength = Buffer.byteLength(content, "utf8");
    const pending = managed.pendingHostOutput;
    if (
      pending &&
      (
        pending.generationId !== event.generationId ||
        pending.stream !== event.stream ||
        pending.byteLength + byteLength > cliHostOutputBatchMaxBytes
      )
    ) {
      void this.flushHostOutput(managed).catch(() => undefined);
    }

    if (managed.pendingHostOutput) {
      managed.pendingHostOutput.content += content;
      managed.pendingHostOutput.byteLength += byteLength;
      managed.pendingHostOutput.outputSequence = event.sequence;
    } else {
      managed.pendingHostOutput = {
        generationId: event.generationId,
        outputSequence: event.sequence,
        stream: event.stream,
        content,
        byteLength
      };
    }

    if (managed.pendingHostOutput.byteLength >= cliHostOutputBatchMaxBytes) {
      void this.flushHostOutput(managed).catch(() => undefined);
      return;
    }
    if (managed.hostOutputFlushTimer === null) {
      managed.hostOutputFlushTimer = setTimeout(() => {
        void this.flushHostOutput(managed).catch(() => undefined);
      }, cliHostOutputBatchDelayMs);
    }
  }

  private flushHostOutput(managed: ManagedCliSession): Promise<void> {
    if (managed.purpose === "LOGIN") {
      if (managed.hostOutputFlushTimer !== null) clearTimeout(managed.hostOutputFlushTimer);
      managed.hostOutputFlushTimer = null;
      managed.pendingHostOutput = null;
      managed.hostOutputQueue.length = 0;
      return Promise.resolve();
    }
    if (managed.hostOutputFlushTimer !== null) {
      clearTimeout(managed.hostOutputFlushTimer);
      managed.hostOutputFlushTimer = null;
    }
    const pending = managed.pendingHostOutput;
    const hostOutputQueue = managed.hostOutputQueue ?? (managed.hostOutputQueue = []);
    if (pending) {
      managed.pendingHostOutput = null;
      hostOutputQueue.push(pending);
    }
    const flushThrough = hostOutputQueue.at(-1);
    if (!flushThrough) return Promise.resolve();
    return this.enqueuePersistence(
      managed,
      () => this.persistHostOutputThrough(managed, flushThrough),
      managed.persistQueue,
      false
    );
  }

  private async persistHostOutputThrough(
    managed: ManagedCliSession,
    flushThrough: CliHostOutputBatch
  ): Promise<void> {
    const hostOutputQueue = managed.hostOutputQueue ?? (managed.hostOutputQueue = []);
    if (!hostOutputQueue.includes(flushThrough)) return;
    while (hostOutputQueue.length > 0) {
      const queued = hostOutputQueue[0];
      if (!queued) return;
      const content = redactMemoryText(queued.content);
      const chunk = await this.options.store.appendPaneCliHostOutputChunk(
        {
          sessionId: managed.sessionId,
          paneId: managed.paneId,
          roomId: managed.roomId,
          generationId: queued.generationId,
          outputSequence: queued.outputSequence,
          stream: queued.stream,
          content,
          byteLength: Buffer.byteLength(content, "utf8")
        },
        "req:cli-host-output"
      );
      managed.nextTranscriptSequence = Math.max(managed.nextTranscriptSequence, chunk.sequence + 1);
      hostOutputQueue.shift();
      if (queued === flushThrough) return;
    }
  }

  private enqueuePersistence(
    managed: ManagedCliSession,
    operation: () => Promise<unknown>,
    prerequisite: Promise<unknown> = managed.persistQueue,
    drainHostOutput = true
  ): Promise<void> {
    const next = prerequisite.then(async () => {
      if (drainHostOutput) {
        const flushThrough = managed.hostOutputQueue?.at(-1);
        if (flushThrough) await this.persistHostOutputThrough(managed, flushThrough);
      }
      await operation();
    });
    managed.persistQueue = next.catch(() => undefined);
    return next;
  }

  private handleHostEvent(managed: ManagedCliSession, event: CliHostEvent): void {
    if (managed.closed) return;
    if (event.type === "output") {
      managed.controlOutput = `${managed.controlOutput}${event.data}`.slice(-16_000);
      if (event.data.length > 0) managed.controlOutputRevision += 1;
      this.scheduleQwenAuthBootstrap(managed);
      if (!managed.codexModelControlReady && isCodexDirectParityRuntime(managed.runtimeId)) {
        managed.startupOutput = `${managed.startupOutput}${event.data}`.slice(-16_000);
      }
      this.broadcast(managed, { type: "output", stream: event.stream, data: event.data });
      this.bufferHostOutput(managed, event);
      return;
    }
    if (managed.purpose === "LOGIN") {
      if (event.status === "EXITED" && event.exitCode === 0) {
        this.handleSuccessfulLoginExit(managed);
      } else {
        void this.failLoginSession(managed.sessionId, "PROVIDER_FAILURE", managed, false).catch(() => undefined);
      }
      return;
    }
    managed.closed = true;
    this.sessions.delete(managed.sessionId);
    managed.controlOutput = "";
    managed.startupOutput = "";
    void this.flushHostOutput(managed).catch(() => undefined);
    const persisted = this.enqueuePersistence(managed, async () => {
      await this.options.store.updatePaneCliSession(
        managed.sessionId,
        {
          status: event.status,
          statusReason: event.statusReason,
          exitCode: event.exitCode,
          isActive: false,
          endedAt: nowIso()
        },
        "req:cli-host-status"
      );
      await this.appendTranscriptNow(managed, "system", event.statusReason, "req:cli-host-status");
    });
    void persisted.catch(() => undefined);
    this.broadcast(managed, {
      type: "status",
      status: event.status,
      statusReason: event.statusReason,
      exitCode: event.exitCode
    });
  }

  private closeManagedLoginSession(managed: ManagedCliSession): boolean {
    if (managed.closed) return false;
    managed.closed = true;
    this.clearLoginTimeout(managed.sessionId);
    this.clearLoginObservation(managed.sessionId);
    this.clearQwenAuthBootstrap(managed);
    if (this.sessions.get(managed.sessionId) === managed) this.sessions.delete(managed.sessionId);
    managed.controlOutput = "";
    managed.startupOutput = "";
    managed.pendingHostOutput = null;
    managed.hostOutputQueue.length = 0;
    if (managed.hostOutputFlushTimer !== null) clearTimeout(managed.hostOutputFlushTimer);
    managed.hostOutputFlushTimer = null;
    return true;
  }

  private handleSuccessfulLoginExit(managed: ManagedCliSession): void {
    if (!this.closeManagedLoginSession(managed)) return;
    const persisted = (async () => {
      await this.options.store.updatePaneCliSession(
        managed.sessionId,
        {
          status: "EXITED",
          statusReason: "CLI login completed; verifying credentials.",
          exitCode: 0,
          isActive: false,
          endedAt: nowIso()
        },
        "req:cli-login-verification"
      );
      const loginSession = await this.options.store.getPaneCliSession(managed.sessionId);
      if (!loginSession || !this.options.onLoginSucceeded) {
        throw new Error("CLI login completion handler is unavailable.");
      }
      const sessionId = await this.options.onLoginSucceeded(loginSession);
      this.broadcast(managed, { type: "session_replaced", sessionId });
    })();
    void persisted.catch(async () => {
      try {
        await this.options.store.updatePaneCliSession(
          managed.sessionId,
          {
            status: "ERROR",
            statusReason: "CLI login completed, but its credential smoke could not be verified.",
            isActive: false
          },
          "req:cli-login-verification"
        );
      } catch {
        // The fixed client-facing error below remains safe even if status persistence is unavailable.
      }
      this.broadcast(managed, {
        type: "status",
        status: "ERROR",
        statusReason: "CLI login completed, but its credential smoke could not be verified.",
        exitCode: null
      });
    });
  }

  private async reconcileClosedLoginHostSession(
    session: PaneCliSession,
    hostSession: CliHostSessionSummary,
    socket?: WebSocket
  ): Promise<void> {
    this.clearLoginTimeout(session.sessionId);
    const completedSuccessfully = hostSession.status === "EXITED" && hostSession.exitCode === 0;
    if (completedSuccessfully) {
      await this.options.store.updatePaneCliSession(
        session.sessionId,
        {
          status: "EXITED",
          statusReason: "CLI login completed; verifying credentials after terminal reconnect.",
          exitCode: 0,
          isActive: false,
          endedAt: hostSession.endedAt ?? nowIso()
        },
        "req:cli-login-verification"
      );
      try {
        if (!this.options.onLoginSucceeded) throw new Error("CLI login completion handler is unavailable.");
        const normalSessionId = await this.options.onLoginSucceeded(session);
        if (socket) this.send(socket, { type: "session_replaced", sessionId: normalSessionId });
        return;
      } catch {
        await this.options.store.updatePaneCliSession(
          session.sessionId,
          {
            status: "ERROR",
            statusReason: "CLI login completed, but its credential smoke could not be verified.",
            isActive: false
          },
          "req:cli-login-verification"
        );
        if (socket) {
          this.send(socket, {
            type: "status",
            status: "ERROR",
            statusReason: "CLI login completed, but its credential smoke could not be verified.",
            exitCode: null
          });
        }
        return;
      }
    }

    const statusReason = session.runtimeId === "cli:kimi"
      ? "Kimi Code OAuth is stored, but functional subscription access could not be verified. Check subscription entitlement and retry in this pane."
      : "CLI login did not complete. Retry login in this pane.";
    await this.options.store.updatePaneCliSession(
      session.sessionId,
      {
        status: "ERROR",
        statusReason,
        exitCode: null,
        isActive: false,
        endedAt: hostSession.endedAt ?? nowIso()
      },
      "req:cli-login-lifecycle"
    );
    await this.options.onLoginFailed?.(session, "PROVIDER_FAILURE");
    if (socket) {
      this.send(socket, { type: "status", status: "ERROR", statusReason, exitCode: null });
    }
  }

  private async persistClosedNormalHostSession(
    session: PaneCliSession,
    hostSession: CliHostSessionSummary
  ): Promise<PaneCliSession> {
    return this.options.store.updatePaneCliSession(
      session.sessionId,
      {
        status: hostSession.status,
        statusReason: hostSession.statusReason ?? "CLI process exited.",
        exitCode: hostSession.exitCode,
        isActive: false,
        endedAt: hostSession.endedAt ?? nowIso()
      },
      "req:cli-host-status-reconcile"
    );
  }

  private async failLoginSession(
    sessionId: string,
    outcome: "CANCELLED" | "TIMEOUT" | "PROVIDER_FAILURE",
    managed: ManagedCliSession | null,
    terminateHost: boolean
  ): Promise<boolean> {
    if (managed && !this.closeManagedLoginSession(managed)) return false;
    this.clearLoginTimeout(sessionId);
    this.clearLoginObservation(sessionId);
    const session = await this.options.store.getPaneCliSession(sessionId);
    if (!session || session.purpose !== "LOGIN" || !session.isActive) return false;

    let terminated = false;
    if (terminateHost) {
      try {
        terminated = await this.hostForRuntime(session.runtimeId, session.sessionId).terminate(
          managed?.identity ?? await this.buildHostIdentity(session)
        );
      } catch (error) {
        if (!cliHostSessionUnavailable(error)) throw error;
      }
    }

    const statusReason = outcome === "CANCELLED"
      ? "CLI login cancelled by operator."
      : outcome === "TIMEOUT"
        ? "CLI login timed out after 15 minutes. Retry login in this pane."
        : session.runtimeId === "cli:kimi"
          ? "Kimi Code OAuth is stored, but functional subscription access could not be verified. Check subscription entitlement and retry in this pane."
          : "CLI login did not complete. Retry login in this pane.";
    const status = outcome === "CANCELLED" ? "EXITED" : "ERROR";
    await this.options.store.updatePaneCliSession(
      session.sessionId,
      {
        status,
        statusReason,
        exitCode: null,
        isActive: false,
        endedAt: nowIso()
      },
      "req:cli-login-lifecycle"
    );
    if (managed) {
      this.broadcast(managed, { type: "status", status, statusReason, exitCode: null });
    }
    await this.options.onLoginFailed?.(session, outcome);
    return terminated;
  }

  private async terminateManagedHostSession(managed: ManagedCliSession): Promise<boolean> {
    const host = this.hostForRuntime(managed.runtimeId, managed.sessionId);
    const interrupted = await this.terminateHostSession(host, managed.identity);
    if (interrupted || managed.closed) return interrupted;

    const hostSession = await host.inspect(managed.identity);
    if (managed.closed) return interrupted;
    if (!hostSession) {
      await this.closeUnavailableHostSession(managed);
      return interrupted;
    }
    if (hostSession.status !== "RUNNING") {
      this.handleHostEvent(managed, {
        type: "status",
        status: hostSession.status,
        statusReason: hostSession.statusReason ?? "CLI process exited.",
        exitCode: hostSession.exitCode ?? (hostSession.status === "EXITED" ? 0 : 1),
        signal: hostSession.signal
      });
    }
    return interrupted;
  }

  private async terminateHostSession(host: CliHostGateway, identity: CliHostIdentity): Promise<boolean> {
    try {
      return await host.terminate(identity);
    } catch (error) {
      if (!(error instanceof CliHostError) || error.code !== "CLI_HOST_IDENTITY_MISMATCH") throw error;
      const hostSession = (await host.health()).sessions.find(
        (candidate) => candidate.cliSessionId === identity.cliSessionId
      );
      if (
        !hostSession ||
        hostSession.paneId !== identity.paneId ||
        hostSession.runtimeId !== identity.runtimeId ||
        hostSession.roomId === identity.roomId
      ) {
        throw error;
      }
      return host.terminate({
        cliSessionId: hostSession.cliSessionId,
        paneId: hostSession.paneId,
        roomId: hostSession.roomId,
        runtimeId: hostSession.runtimeId,
        codexThreadId: hostSession.codexThreadId,
        modelId: hostSession.modelId,
        reasoningEffort: hostSession.reasoningEffort
      });
    }
  }

  private async closeUnavailableHostSession(managed: ManagedCliSession): Promise<void> {
    if (managed.closed) return;
    const statusReason = "CLI host session was unavailable when interrupt was requested.";
    managed.closed = true;
    if (this.sessions.get(managed.sessionId) === managed) this.sessions.delete(managed.sessionId);
    this.broadcast(managed, {
      type: "status",
      status: "EXITED",
      statusReason,
      exitCode: null
    });
    await this.flushHostOutput(managed);
    await this.enqueuePersistence(managed, async () => {
      await this.options.store.updatePaneCliSession(
        managed.sessionId,
        {
          status: "EXITED",
          statusReason,
          exitCode: null,
          isActive: false,
          endedAt: nowIso()
        },
        "req:cli-host-status"
      );
      await this.appendTranscriptNow(managed, "system", statusReason, "req:cli-host-status");
    });
  }

  private async detachTransport(managed: ManagedCliSession): Promise<void> {
    if (managed.detached) return;
    managed.detached = true;
    if (this.sessions.get(managed.sessionId) === managed) this.sessions.delete(managed.sessionId);
    await this.flushHostOutput(managed);
    try {
      await this.hostForRuntime(managed.runtimeId, managed.sessionId).detach(managed.identity, managed.attachmentId);
    } finally {
      managed.transportReady = false;
      await this.flushHostOutput(managed);
    }
  }

  private async waitForInputReady(managed: ManagedCliSession): Promise<void> {
    if (managed.inputReady || !isCodexDirectParityRuntime(managed.runtimeId)) return;
    const timeoutMs = this.options.startupReadyTimeoutMs ?? cliStartupReadyTimeoutMs;
    if (timeoutMs <= 0) return;
    await this.waitForStableCodexReady(managed, timeoutMs);
  }

  private async waitForCodexModelControlReady(managed: ManagedCliSession): Promise<void> {
    if (managed.codexModelControlReady) return;
    await this.waitForStableCodexReady(
      managed,
      this.options.startupReadyTimeoutMs ?? cliStartupReadyTimeoutMs
    );
  }

  private async waitForStableCodexReady(managed: ManagedCliSession, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let readySinceMs: number | null = null;
    while (!managed.codexModelControlReady && !managed.closed && Date.now() < deadline) {
      const nowMs = Date.now();
      if (codexInputReady(managed.startupOutput)) {
        readySinceMs ??= nowMs;
        if (nowMs - readySinceMs >= codexInputReadySettleMs) {
          managed.inputReady = true;
          managed.codexModelControlReady = true;
          managed.startupOutput = "";
          return;
        }
      } else {
        readySinceMs = null;
      }
      await delay(Math.min(25, Math.max(1, deadline - nowMs)));
    }
    if (managed.codexModelControlReady) return;
    if (managed.closed) throw new SpaceConflictError(`CLI session ${managed.sessionId} closed before it became ready for input.`);
    throw new SpaceConflictError(`CLI session ${managed.sessionId} did not become ready for input before the startup timeout.`);
  }

  private codexControlWasRejected(output: string): boolean {
    return output.includes("Model selection is disabled") ||
      output.includes("Models are being updated") ||
      output.includes("Failed to save default model");
  }

  private async waitForCodexControlState(
    managed: ManagedCliSession,
    predicate: (output: string) => boolean,
    timeoutMessage: string
  ): Promise<void> {
    const deadline = Date.now() + (this.options.modelSelectionTimeoutMs ?? codexModelSelectionTimeoutMs);
    while (!managed.closed && Date.now() < deadline) {
      if (this.codexControlWasRejected(managed.controlOutput)) {
        throw new SpaceConflictError("Codex rejected the requested pre-thread model settings.");
      }
      if (predicate(managed.controlOutput)) return;
      await delay(25);
    }
    if (managed.closed) throw new SpaceConflictError(`CLI session ${managed.sessionId} closed during model control.`);
    throw new SpaceConflictError(timeoutMessage);
  }

  private waitForCodexControlMenu(managed: ManagedCliSession, menuLabels: readonly string[]): Promise<void> {
    return this.waitForCodexControlState(
      managed,
      (output) => codexControlMenuHasTarget(output, menuLabels),
      "Codex did not display the expected pre-thread model menu."
    );
  }

  private waitForCodexControlOutputAfter(managed: ManagedCliSession, revision: number): Promise<void> {
    return this.waitForCodexControlState(
      managed,
      (output) => managed.controlOutputRevision > revision && output.length > 0,
      "Codex did not render terminal output after the /model command."
    );
  }

  private waitForCodexControlHighlight(managed: ManagedCliSession, targetLabels: readonly string[]): Promise<void> {
    return this.waitForCodexControlState(
      managed,
      (output) => codexControlMenuHighlightsTarget(output, targetLabels),
      "Codex did not highlight the requested pre-thread model setting."
    );
  }

  private waitForCodexModelChange(managed: ManagedCliSession, modelId: string, reasoningEffort: string): Promise<void> {
    const normalizedModelId = modelId.toLocaleLowerCase("en-US");
    const normalizedReasoningEffort = reasoningEffort.toLocaleLowerCase("en-US");
    return this.waitForCodexControlState(
      managed,
      (output) => {
        const normalized = codexControlRows(output).join(" ").toLocaleLowerCase("en-US");
        return normalized.includes("model changed")
          && normalized.includes(`${normalizedModelId} ${normalizedReasoningEffort}`);
      },
      "Codex did not confirm the requested pre-thread model settings."
    );
  }

  private pruneTurnMarkers(managed: ManagedCliSession) {
    const now = Date.now();
    for (const [marker, tracked] of managed.turnMarkers) {
      if (tracked.expiresAtMs <= now) managed.turnMarkers.delete(marker);
    }
  }

  private async buildHostIdentity(session: PaneCliSession): Promise<CliHostIdentity> {
    return {
      cliSessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      runtimeId: session.runtimeId,
      codexThreadId: session.codexThreadId,
      modelId: session.modelId,
      reasoningEffort: session.reasoningEffort
    };
  }

  private scheduleCodexNullAgentMessageCheck(managed: ManagedCliSession, sinceMs: number, inputText: string): void {
    if (!isCodexDirectParityRuntime(managed.runtimeId)) return;
    const trimmedInput = inputText.trim();
    if (trimmedInput.length >= 3) {
      managed.nullAgentMessageCheckInputText = trimmedInput.slice(0, 500);
    }
    managed.nullAgentMessageCheckSinceMs =
      managed.nullAgentMessageCheckSinceMs === null ? sinceMs : Math.min(managed.nullAgentMessageCheckSinceMs, sinceMs);
    managed.nullAgentMessageCheckUntilMs = Math.max(managed.nullAgentMessageCheckUntilMs, Date.now() + 10 * 60_000);
    if (!managed.nullAgentMessageCheckTimer) {
      this.armCodexNullAgentMessageCheck(managed, 25_000);
    }
  }

  private armCodexNullAgentMessageCheck(managed: ManagedCliSession, delayMs: number): void {
    managed.nullAgentMessageCheckTimer = setTimeout(() => {
      managed.nullAgentMessageCheckTimer = null;
      void this.runCodexNullAgentMessageCheck(managed).catch(() => undefined);
    }, delayMs);
    managed.nullAgentMessageCheckTimer.unref?.();
  }

  private async runCodexNullAgentMessageCheck(managed: ManagedCliSession): Promise<void> {
    const sinceMs = managed.nullAgentMessageCheckSinceMs;
    if (managed.closed || sinceMs === null) {
      managed.nullAgentMessageCheckSinceMs = null;
      managed.nullAgentMessageCheckUntilMs = 0;
      managed.nullAgentMessageCheckInputText = null;
      return;
    }
    await this.surfaceCodexNullAgentMessageDiagnostic(managed, sinceMs);
    if (!managed.closed && Date.now() < managed.nullAgentMessageCheckUntilMs) {
      this.armCodexNullAgentMessageCheck(managed, 15_000);
      return;
    }
    managed.nullAgentMessageCheckSinceMs = null;
    managed.nullAgentMessageCheckUntilMs = 0;
    managed.nullAgentMessageCheckInputText = null;
  }

  private scheduleCodexThreadBind(managed: ManagedCliSession, sinceMs: number): void {
    if (!isCodexDirectParityRuntime(managed.runtimeId) || managed.codexThreadId) return;
    managed.codexThreadBindSinceMs =
      managed.codexThreadBindSinceMs === null ? sinceMs : Math.min(managed.codexThreadBindSinceMs, sinceMs);
    managed.codexThreadBindUntilMs = Math.max(managed.codexThreadBindUntilMs, Date.now() + codexThreadBindMaxMs);
    if (!managed.codexThreadBindTimer) {
      this.armCodexThreadBind(managed);
    }
  }

  private startImmediateCodexThreadBind(managed: ManagedCliSession, sinceMs: number): void {
    this.scheduleCodexThreadBind(managed, sinceMs);
    if (managed.codexThreadBindTimer) {
      clearTimeout(managed.codexThreadBindTimer);
      managed.codexThreadBindTimer = null;
    }
    void this.runCodexThreadBind(managed).catch(() => undefined);
  }

  private armCodexThreadBind(managed: ManagedCliSession): void {
    managed.codexThreadBindTimer = setTimeout(() => {
      managed.codexThreadBindTimer = null;
      void this.runCodexThreadBind(managed).catch(() => undefined);
    }, codexThreadBindRetryMs);
    managed.codexThreadBindTimer.unref?.();
  }

  private async runCodexThreadBind(managed: ManagedCliSession): Promise<void> {
    const sinceMs = managed.codexThreadBindSinceMs;
    if (managed.closed || managed.codexThreadId || sinceMs === null) {
      managed.codexThreadBindSinceMs = null;
      managed.codexThreadBindUntilMs = 0;
      return;
    }
    const codexThreadId = await findAvailableCodexThreadId({
      store: this.options.store,
      paneId: managed.paneId,
      sessionId: managed.sessionId,
      cwd: codexDirectParityCwd,
      findThreadId: this.options.findCodexThreadId
    });
    if (codexThreadId) {
      try {
        await this.options.store.claimPaneCliCodexThread(
          managed.sessionId,
          codexThreadId,
          "AUTO",
          "req:cli-codex-thread-bind"
        );
        managed.codexThreadId = codexThreadId;
      } catch (error) {
        if (!(error instanceof SpaceConflictError)) {
          throw error;
        }
      }
      managed.codexThreadBindSinceMs = null;
      managed.codexThreadBindUntilMs = 0;
      return;
    }
    if (!managed.closed && Date.now() < managed.codexThreadBindUntilMs) {
      this.armCodexThreadBind(managed);
      return;
    }
    managed.codexThreadBindSinceMs = null;
    managed.codexThreadBindUntilMs = 0;
  }

  private async surfaceCodexNullAgentMessageDiagnostic(managed: ManagedCliSession, sinceMs: number): Promise<void> {
    if (managed.closed || !managed.codexThreadId) return;
    const diagnostic = await (
      this.options.findRecentNullAgentMessageDiagnostic ?? findRecentNullAgentMessageDiagnostic
    )({
      codexHome: codexDirectParityCodexHome,
      threadId: managed.codexThreadId,
      cwd: codexDirectParityCwd,
      inputText: managed.nullAgentMessageCheckInputText,
      sinceMs
    });
    if (!diagnostic) return;
    const diagnosticKey = diagnostic.turnId ?? `${diagnostic.rolloutPath}:${diagnostic.completedAt ?? "unknown"}`;
    if (managed.reportedNullAgentMessageTurns.has(diagnosticKey)) return;
    managed.reportedNullAgentMessageTurns.add(diagnosticKey);
    await this.appendTranscript(managed, "system", diagnostic.message, "req:cli-null-agent-message");
    await this.options.store.updatePaneCliSession(
      managed.sessionId,
      {
        status: "RUNNING",
        statusReason: diagnostic.message,
        isActive: true
      },
      "req:cli-null-agent-message"
    );
    this.broadcast(managed, {
      type: "status",
      status: "RUNNING",
      statusReason: diagnostic.message,
      exitCode: null
    });
    this.broadcast(managed, {
      type: "error",
      code: "CODEX_EMPTY_ASSISTANT_MESSAGE",
      message: diagnostic.message
    });
  }
}
