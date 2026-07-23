import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { WebSocket } from "ws";
import {
  codexAppServerTurnStatusSchema,
  type CodexAppServerTurnSmokeResult
} from "@space/contracts";

export interface CodexAppServerJsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
}

export interface CodexAppServerTurnSessionState {
  threadId: string | null;
  turnId: string | null;
  turnStatus: CodexAppServerTurnSmokeResult["turnStatus"];
  goalStatus?: CodexThreadGoalStatus | null;
  notificationCount: number;
  completedNotificationSeen: boolean;
  agentMessageText: string;
}

export type CodexAppServerServerRequestHandler = (
  request: CodexAppServerJsonRpcMessage
) => unknown | Promise<unknown>;

export interface CodexAppServerTurnSessionReduceOptions {
  threadStartRequestId: number | string;
  turnStartRequestId: number | string;
}

export interface CodexAppServerClientInfo {
  name: string;
  title: string;
  version: string;
}

export type CodexPermissionMode = "ask_for_approval" | "approve_for_me" | "full_access";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export interface CodexPermissionParams {
  sandbox: CodexSandboxMode;
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: CodexApprovalsReviewer;
}

export interface CodexConfigRequirements {
  allowedApprovalPolicies?: CodexApprovalPolicy[] | null;
  allowedApprovalsReviewers?: CodexApprovalsReviewer[] | null;
  allowedSandboxModes?: CodexSandboxMode[] | null;
  allowedPermissionProfiles?: Record<string, boolean> | null;
  defaultPermissions?: string | null;
  [key: string]: unknown;
}

export type CodexAppServerAllowedRpcMethod =
  | "initialize"
  | "configRequirements/read"
  | "collaborationMode/list"
  | "model/list"
  | "thread/start"
  | "thread/resume"
  | "thread/settings/update"
  | "thread/read"
  | "turn/start"
  | "thread/goal/get"
  | "thread/goal/set"
  | "thread/goal/clear";

const allowedCodexAppServerRpcMethods = new Set<CodexAppServerAllowedRpcMethod>([
  "initialize",
  "configRequirements/read",
  "collaborationMode/list",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/settings/update",
  "thread/read",
  "turn/start",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear"
]);

export function assertCodexAppServerRpcMethodAllowed(
  method: string
): asserts method is CodexAppServerAllowedRpcMethod {
  if (!allowedCodexAppServerRpcMethods.has(method as CodexAppServerAllowedRpcMethod)) {
    throw new Error("Codex App Server RPC method is not allowed.");
  }
}

export function permissionParamsForMode(mode: CodexPermissionMode | null): CodexPermissionParams | null {
  if (mode === null) return null;
  if (mode === "ask_for_approval") {
    return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" };
  }
  if (mode === "approve_for_me") {
    return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "guardian_subagent" };
  }
  return { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" };
}

export function validatePermissionModeRequirements(
  mode: CodexPermissionMode | null,
  requirements: CodexConfigRequirements | null
): void {
  const params = permissionParamsForMode(mode);
  if (!params || !requirements) return;
  const allowed =
    (requirements.allowedApprovalPolicies === null ||
      requirements.allowedApprovalPolicies === undefined ||
      requirements.allowedApprovalPolicies.includes(params.approvalPolicy)) &&
    (requirements.allowedApprovalsReviewers === null ||
      requirements.allowedApprovalsReviewers === undefined ||
      requirements.allowedApprovalsReviewers.includes(params.approvalsReviewer)) &&
    (requirements.allowedSandboxModes === null ||
      requirements.allowedSandboxModes === undefined ||
      requirements.allowedSandboxModes.includes(params.sandbox));
  if (!allowed) {
    throw new Error("Codex permission mode is not allowed by runtime requirements.");
  }
}

export interface CodexAppServerProviderRoute {
  providerId: string;
  routeProfile?: "headroom" | "direct-primary" | "direct-auto" | "direct-fallback" | "openai-direct" | "custom" | null;
  backingProviderId?: string | null;
  baseUrl?: string | null;
}

export type CodexCollaborationMode = "default" | "plan";

export interface CodexCollaborationModePreset {
  name: string;
  mode: CodexCollaborationMode | null;
  model: string | null;
  reasoning_effort: string | null;
}

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexAppServerStdioProcess {
  stdin: {
    write(chunk: string): unknown;
  };
  stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type CodexAppServerStdioProcessFactory = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  }
) => CodexAppServerStdioProcess;

export interface RunCodexAppServerStdioTurnSessionOptions {
  command: string;
  cwd?: string;
  env: CodexAppServerProcessEnv;
  prompt: string;
  threadId?: string | null;
  ephemeral?: boolean;
  imageAttachments?: Array<{
    artifactId: string;
    mimeType: string;
    storageUri: string;
    sha256: string;
    path: string;
  }>;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string | null;
  permissionMode?: CodexPermissionMode | null;
  collaborationMode?: CodexCollaborationMode | null;
  requirementsValidator?: (requirements: CodexConfigRequirements | null) => void | Promise<void>;
  providerRoute?: CodexAppServerProviderRoute | null;
  serviceName?: string;
  clientInfo?: CodexAppServerClientInfo;
  timeoutMs?: number | null;
  goalObjective?: string | null;
  serverRequestHandler?: CodexAppServerServerRequestHandler;
  signal?: AbortSignal;
  spawnProcess?: CodexAppServerStdioProcessFactory;
  resumeTurnId?: string | null;
  recoveryMarker?: string;
  recoveryPrompt?: string;
  recoveryPollIntervalMs?: number;
  goalProgressGraceMs?: number;
  onCheckpoint?: (checkpoint: { threadId: string; turnId: string | null }) => void | Promise<void>;
}

export type CodexAppServerGoalAction =
  | { type: "get" }
  | {
      type: "set";
      objective?: string | null;
      status?: CodexThreadGoalStatus | null;
      tokenBudget?: number | null;
    }
  | { type: "clear" };

export interface RunCodexAppServerStdioGoalSessionOptions {
  command: string;
  cwd?: string;
  env: CodexAppServerProcessEnv;
  threadId?: string | null;
  action: CodexAppServerGoalAction;
  model?: string;
  modelProvider?: string;
  permissionMode?: CodexPermissionMode | null;
  serviceName?: string;
  clientInfo?: CodexAppServerClientInfo;
  requirementsValidator?: (requirements: CodexConfigRequirements | null) => void | Promise<void>;
  timeoutMs?: number;
  spawnProcess?: CodexAppServerStdioProcessFactory;
}

export interface CodexAppServerGoalSessionResult {
  threadId: string;
  goal: CodexThreadGoal | null;
  cleared: boolean | null;
}

export interface CodexAppServerControlServiceOptions {
  command: string;
  cwd?: string;
  env: CodexAppServerProcessEnv;
  clientInfo?: CodexAppServerClientInfo;
  timeoutMs?: number;
  spawnProcess?: CodexAppServerStdioProcessFactory;
}

export interface CodexAppServerSetGoalInput {
  threadId?: string | null;
  objective: string;
  status?: CodexThreadGoalStatus | null;
  tokenBudget?: number | null;
}

export interface CodexAppServerControlService {
  readConfigRequirements(): Promise<CodexConfigRequirements | null>;
  listModels(): Promise<CodexAppServerSocketModelOption[]>;
  listCollaborationModes(): Promise<CodexCollaborationModePreset[]>;
  setGoal(input: CodexAppServerSetGoalInput): Promise<CodexAppServerGoalSessionResult>;
  clearGoal(threadId: string): Promise<CodexAppServerGoalSessionResult>;
}

export type CodexAppServerSocketRpcMethod =
  | "initialize"
  | "model/list"
  | "thread/list"
  | "thread/read"
  | "thread/settings/update"
  | "turn/interrupt"
  | "turn/start";

const allowedCodexAppServerSocketRpcMethods = new Set<CodexAppServerSocketRpcMethod>([
  "initialize",
  "model/list",
  "thread/list",
  "thread/read",
  "thread/settings/update",
  "turn/interrupt",
  "turn/start"
]);

export function assertCodexAppServerSocketRpcMethodAllowed(
  method: string
): asserts method is CodexAppServerSocketRpcMethod {
  if (!allowedCodexAppServerSocketRpcMethods.has(method as CodexAppServerSocketRpcMethod)) {
    throw new Error("Codex App Server socket RPC method is not allowed.");
  }
}

export interface CodexAppServerSocketControlServiceOptions {
  socketPath: string;
  clientInfo?: CodexAppServerClientInfo;
  timeoutMs?: number;
}

export const codexAppServerSocketMaxPayloadBytes = 16 * 1_024 * 1_024;

export type CodexReasoningEffort = string;

const codexModelIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const codexReasoningIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function boundedProviderText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function providerReasoningEffort(value: unknown): CodexReasoningEffort | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return codexReasoningIdentifierPattern.test(normalized) ? normalized : null;
}

export interface CodexAppServerSocketModelOption {
  id: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  defaultReasoningEffort: CodexReasoningEffort;
  supportedReasoningEfforts: CodexReasoningEffort[];
  reasoningOptions?: Array<{ reasoningEffort: CodexReasoningEffort; description?: string }>;
}

export interface CodexAppServerSocketStartTurnInput {
  threadId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  clientUserMessageId: string;
}

export interface CodexAppServerSocketStartedTurn {
  turnId: string;
  status: Exclude<CodexAppServerTurnSmokeResult["turnStatus"], null>;
}

export interface CodexAppServerSocketControlService {
  listModels(): Promise<CodexAppServerSocketModelOption[]>;
  updateThreadSettings(input: { threadId: string; model: string; reasoningEffort: CodexReasoningEffort }): Promise<void>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  startTurn(input: CodexAppServerSocketStartTurnInput): Promise<CodexAppServerSocketStartedTurn>;
}

export interface CodexAppServerProcessCredential {
  name: string;
  value: string;
}

export interface BuildCodexAppServerProcessEnvOptions {
  baseEnv: NodeJS.ProcessEnv;
  codexHome: string;
  credential: CodexAppServerProcessCredential | null;
}

declare const codexAppServerProcessEnvBrand: unique symbol;

export type CodexAppServerProcessEnv = Readonly<NodeJS.ProcessEnv> & {
  readonly [codexAppServerProcessEnvBrand]: true;
};

const builtCodexAppServerProcessEnvs = new WeakSet<object>();

const inheritedCodexAppServerEnvKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP"
] as const;

const supportedProviderCredentialEnvNames = new Set([
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_LB_API_KEY"
]);

function assertProviderCredentialEnvName(name: string): void {
  if (!supportedProviderCredentialEnvNames.has(name)) {
    throw new Error("Codex App Server provider credential environment variable is not allowed.");
  }
}

export function buildCodexAppServerProcessEnv({
  baseEnv,
  codexHome,
  credential
}: BuildCodexAppServerProcessEnvOptions): CodexAppServerProcessEnv {
  if (!codexHome) {
    throw new Error("Codex App Server home is required.");
  }
  if (!isAbsolute(codexHome)) {
    throw new Error("Codex App Server home must be absolute.");
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of inheritedCodexAppServerEnvKeys) {
    const value = baseEnv[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  const resolvedCodexHome = resolve(codexHome);
  const isSharedVsCodeCodexHome = basename(resolvedCodexHome) === ".codex";
  childEnv.HOME = isSharedVsCodeCodexHome ? dirname(resolvedCodexHome) : resolvedCodexHome;
  childEnv.CODEX_HOME = resolvedCodexHome;
  if (isSharedVsCodeCodexHome) {
    childEnv.TMPDIR = join(resolvedCodexHome, "tmp");
    childEnv.TMP = childEnv.TMPDIR;
    childEnv.TEMP = childEnv.TMPDIR;
  } else {
    childEnv.XDG_CACHE_HOME = join(resolvedCodexHome, "cache");
    childEnv.XDG_CONFIG_HOME = join(resolvedCodexHome, "config");
    childEnv.XDG_DATA_HOME = join(resolvedCodexHome, "data");
  }

  if (credential) {
    assertProviderCredentialEnvName(credential.name);
    childEnv[credential.name] = credential.value;
  }
  const processEnv = Object.freeze(childEnv) as CodexAppServerProcessEnv;
  builtCodexAppServerProcessEnvs.add(processEnv);
  return processEnv;
}

export function initialCodexAppServerTurnSessionState(): CodexAppServerTurnSessionState {
  return {
    threadId: null,
    turnId: null,
    turnStatus: null,
    goalStatus: null,
    notificationCount: 0,
    completedNotificationSeen: false,
    agentMessageText: ""
  };
}

export function parseCodexAppServerJsonRpcLine(line: string): CodexAppServerJsonRpcMessage {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex App Server JSON-RPC line must be an object.");
  }
  return parsed as CodexAppServerJsonRpcMessage;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveCodexAppServerRequestUserInput(
  request: CodexAppServerJsonRpcMessage
): { answers: Record<string, { answers: string[] }> } {
  if (request.method !== "item/tool/requestUserInput") {
    throw new Error("Codex App Server user-input resolver received an unsupported request.");
  }

  const params = asRecord(request.params);
  const questions = Array.isArray(params?.questions) ? params.questions.slice(0, 3) : [];
  const answers = Object.fromEntries(
    questions.flatMap((value) => {
      const question = asRecord(value);
      const id = stringField(question, "id");
      if (!id) return [];
      return [[id, { answers: [] }]];
    })
  );

  return { answers };
}

export function turnStatusField(record: Record<string, unknown> | null): CodexAppServerTurnSmokeResult["turnStatus"] {
  const parsed = codexAppServerTurnStatusSchema.safeParse(record?.status);
  return parsed.success ? parsed.data : null;
}

function applyTurnRecord(
  state: CodexAppServerTurnSessionState,
  turn: Record<string, unknown> | null
): CodexAppServerTurnSessionState {
  return {
    ...state,
    turnId: stringField(turn, "id") ?? state.turnId,
    turnStatus: turnStatusField(turn) ?? state.turnStatus
  };
}

const maxAgentMessageTextLength = 20_000;

function cappedAgentMessageText(value: string): string {
  return value.length > maxAgentMessageTextLength ? value.slice(0, maxAgentMessageTextLength) : value;
}

function appendAgentMessageText(state: CodexAppServerTurnSessionState, text: string): CodexAppServerTurnSessionState {
  if (!text) return state;
  return {
    ...state,
    agentMessageText: cappedAgentMessageText(`${state.agentMessageText}${text}`)
  };
}

function applyCompletedAgentMessage(
  state: CodexAppServerTurnSessionState,
  item: Record<string, unknown> | null
): CodexAppServerTurnSessionState {
  if (stringField(item, "type") !== "agentMessage") return state;
  const text = stringField(item, "text");
  if (!text) return state;
  return {
    ...state,
    agentMessageText: cappedAgentMessageText(text)
  };
}

export function reduceCodexAppServerTurnSessionState(
  state: CodexAppServerTurnSessionState,
  message: CodexAppServerJsonRpcMessage,
  options: CodexAppServerTurnSessionReduceOptions
): CodexAppServerTurnSessionState {
  let next = { ...state };

  if (message.method) {
    next = { ...next, notificationCount: next.notificationCount + 1 };
    if (message.method === "turn/started" || message.method === "turn/completed") {
      const params = asRecord(message.params);
      const turn = asRecord(params?.turn);
      next = applyTurnRecord(
        {
          ...next,
          threadId: stringField(params, "threadId") ?? next.threadId
        },
        turn
      );
      if (message.method === "turn/completed") {
        next = { ...next, completedNotificationSeen: true };
      } else {
        next = { ...next, completedNotificationSeen: false, agentMessageText: "" };
      }
    }
    if (message.method === "thread/goal/updated") {
      const params = asRecord(message.params);
      const goal = asRecord(params?.goal);
      const status = stringField(goal, "status") as CodexThreadGoalStatus | null;
      if (status && threadGoalStatuses.has(status)) {
        next = { ...next, goalStatus: status };
      }
    }
    if (message.method === "item/agentMessage/delta") {
      const params = asRecord(message.params);
      const delta = stringField(params, "delta");
      if (delta) {
        next = appendAgentMessageText(next, delta);
      }
    }
    if (message.method === "item/completed") {
      const params = asRecord(message.params);
      next = applyCompletedAgentMessage(next, asRecord(params?.item));
    }
  }

  if (message.id === options.threadStartRequestId && !message.error) {
    const result = asRecord(message.result);
    const thread = asRecord(result?.thread);
    next = { ...next, threadId: stringField(thread, "id") ?? next.threadId };
  }

  if (message.id === options.turnStartRequestId && !message.error) {
    const result = asRecord(message.result);
    next = applyTurnRecord(next, asRecord(result?.turn));
  }

  return next;
}

export function isCodexAppServerTurnSessionComplete(state: CodexAppServerTurnSessionState): boolean {
  return state.turnStatus === "completed" && (state.goalStatus == null || state.goalStatus === "complete");
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  }
): CodexAppServerStdioProcess {
  return spawn(command, args, options) as CodexAppServerStdioProcess;
}

function chunkToUtf8(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

interface CodexAppServerProtocolClient {
  isClosed(): boolean;
  request(method: CodexAppServerAllowedRpcMethod, params?: Record<string, unknown>): Promise<unknown>;
  waitForNotification(method: string): Promise<CodexAppServerJsonRpcMessage>;
}

interface CodexAppServerProtocolOptions {
  command: string;
  cwd?: string;
  env: CodexAppServerProcessEnv;
  clientInfo?: CodexAppServerClientInfo;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  spawnProcess?: CodexAppServerStdioProcessFactory;
  serverRequestHandler?: CodexAppServerServerRequestHandler;
}

function protocolCancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Codex App Server session was cancelled.");
}

function assertProtocolOptions(options: CodexAppServerProtocolOptions): void {
  if (!options.command.trim()) {
    throw new Error("Codex App Server command is required.");
  }
  if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)) {
    throw new Error("Codex App Server process environment is required.");
  }
  if (!builtCodexAppServerProcessEnvs.has(options.env)) {
    throw new Error("Codex App Server process environment must be built by the allowlist builder.");
  }
}

function initializedParams(options: CodexAppServerProtocolOptions): Record<string, unknown> {
  return {
    clientInfo: options.clientInfo ?? {
      name: "space",
      title: "Space",
      version: "0.1.0"
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false
    }
  };
}

function remoteRpcError(
  method: CodexAppServerAllowedRpcMethod,
  remoteError: CodexAppServerJsonRpcMessage["error"]
): Error {
  if (method === "thread/resume" && /thread[^\n]{0,80}not found/i.test(remoteError?.message ?? "")) {
    return new Error("Codex App Server thread not found.");
  }
  return new Error(`Codex App Server ${method} returned an error.`);
}

function runCodexAppServerStdioProtocol<T>(
  options: CodexAppServerProtocolOptions,
  operation: (client: CodexAppServerProtocolClient) => Promise<T>,
  onNotification?: (message: CodexAppServerJsonRpcMessage) => void
): Promise<T> {
  try {
    assertProtocolOptions(options);
  } catch (error) {
    return Promise.reject(error);
  }
  if (options.signal?.aborted) {
    return Promise.reject(protocolCancellationError(options.signal));
  }

  return new Promise<T>((resolve, reject) => {
    const child = (options.spawnProcess ?? defaultSpawnProcess)(options.command.trim(), ["app-server"], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let settled = false;
    let nextRequestId = 0;
    let pendingRequest: {
      id: number;
      method: CodexAppServerAllowedRpcMethod;
      resolve(value: unknown): void;
      reject(error: Error): void;
    } | null = null;
    const notificationWaiters = new Map<
      string,
      Array<{ resolve(message: CodexAppServerJsonRpcMessage): void; reject(error: Error): void }>
    >();
    const timeout = options.timeoutMs === null
      ? null
      : setTimeout(() => {
          finish(new Error("Codex App Server thread and turn session timed out."));
        }, options.timeoutMs ?? 60000);
    const abortListener = () => finish(protocolCancellationError(options.signal!));

    function send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function finish(error: Error | null, value?: T): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortListener);
      child.kill("SIGTERM");
      if (error) {
        pendingRequest?.reject(error);
        for (const waiters of notificationWaiters.values()) {
          for (const waiter of waiters) waiter.reject(error);
        }
        reject(error);
      } else {
        resolve(value as T);
      }
    }

    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) {
      abortListener();
      return;
    }

    const client: CodexAppServerProtocolClient = {
      isClosed() {
        return settled;
      },
      request(method, params) {
        try {
          assertCodexAppServerRpcMethodAllowed(method);
        } catch (error) {
          return Promise.reject(error);
        }
        if (settled) return Promise.reject(new Error("Codex App Server protocol session is closed."));
        if (pendingRequest) {
          return Promise.reject(new Error("Codex App Server protocol requests must be sequential."));
        }
        const id = nextRequestId++;
        return new Promise<unknown>((resolveRequest, rejectRequest) => {
          pendingRequest = {
            id,
            method,
            resolve: resolveRequest,
            reject: rejectRequest
          };
          send(params === undefined ? { method, id } : { method, id, params });
        });
      },
      waitForNotification(method) {
        if (settled) return Promise.reject(new Error("Codex App Server protocol session is closed."));
        return new Promise<CodexAppServerJsonRpcMessage>((resolveNotification, rejectNotification) => {
          const waiters = notificationWaiters.get(method) ?? [];
          waiters.push({ resolve: resolveNotification, reject: rejectNotification });
          notificationWaiters.set(method, waiters);
        });
      }
    };

    function handleMessage(message: CodexAppServerJsonRpcMessage): void {
      if (message.method) {
        if (message.id !== undefined) {
          if (!options.serverRequestHandler) {
            finish(new Error("Codex App Server sent an unsupported server request."));
            return;
          }
          void Promise.resolve()
            .then(() => options.serverRequestHandler!(message))
            .then((result) => {
              if (!settled) send({ id: message.id, result: result ?? null });
            })
            .catch(() => finish(new Error("Codex App Server server request handling failed.")));
          return;
        }
        onNotification?.(message);
        const waiters = notificationWaiters.get(message.method);
        if (waiters?.length) {
          notificationWaiters.delete(message.method);
          for (const waiter of waiters) waiter.resolve(message);
        }
        return;
      }
      if (message.id === undefined || !pendingRequest || message.id !== pendingRequest.id) {
        finish(new Error("Codex App Server returned an unexpected response."));
        return;
      }
      const request = pendingRequest;
      pendingRequest = null;
      if (message.error) {
        request.reject(remoteRpcError(request.method, message.error));
      } else {
        request.resolve(message.result);
      }
    }

    child.once("error", () => finish(new Error("Codex App Server process could not be started.")));
    child.once("exit", () => {
      if (!settled) finish(new Error("Codex App Server exited before the protocol sequence completed."));
    });
    child.stderr.on("data", () => {
      // Stderr is intentionally discarded so remote details cannot escape the process boundary.
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunkToUtf8(chunk);
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(parseCodexAppServerJsonRpcLine(line));
          } catch {
            finish(new Error("Codex App Server returned invalid JSON during the protocol sequence."));
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    void (async () => {
      try {
        await client.request("initialize", initializedParams(options));
        send({ method: "initialized", params: {} });
        finish(null, await operation(client));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Codex App Server protocol sequence failed."));
      }
    })();
  });
}

function isApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  if (value === "untrusted" || value === "on-request" || value === "never") return true;
  const granular = asRecord(asRecord(value)?.granular);
  return Boolean(
    granular &&
    typeof granular.sandbox_approval === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.skill_approval === "boolean" &&
    typeof granular.request_permissions === "boolean" &&
    typeof granular.mcp_elicitations === "boolean"
  );
}

function isNullableArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(predicate));
}

function parseConfigRequirementsResult(result: unknown): CodexConfigRequirements | null {
  const record = asRecord(result);
  if (!record || !("requirements" in record)) {
    throw new Error("Codex runtime requirements response was invalid.");
  }
  if (record.requirements === null) return null;
  const requirements = asRecord(record.requirements);
  if (!requirements) throw new Error("Codex runtime requirements response was invalid.");
  const permissionProfiles = requirements.allowedPermissionProfiles;
  const permissionProfileRecord = permissionProfiles === undefined || permissionProfiles === null
    ? null
    : asRecord(permissionProfiles);
  if (
    !isNullableArrayOf(requirements.allowedApprovalPolicies, isApprovalPolicy) ||
    !isNullableArrayOf(
      requirements.allowedApprovalsReviewers,
      (value) => value === "user" || value === "auto_review" || value === "guardian_subagent"
    ) ||
    !isNullableArrayOf(
      requirements.allowedSandboxModes,
      (value) => value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ) ||
    (permissionProfiles !== undefined && permissionProfiles !== null && !permissionProfileRecord) ||
    (permissionProfileRecord && Object.values(permissionProfileRecord).some((value) => typeof value !== "boolean")) ||
    (requirements.defaultPermissions !== undefined &&
      requirements.defaultPermissions !== null &&
      typeof requirements.defaultPermissions !== "string")
  ) {
    throw new Error("Codex runtime requirements response was invalid.");
  }
  return requirements as CodexConfigRequirements;
}

async function readFreshRequirements(
  client: CodexAppServerProtocolClient,
  permissionMode: CodexPermissionMode | null,
  validator?: (requirements: CodexConfigRequirements | null) => void | Promise<void>
): Promise<CodexConfigRequirements | null> {
  let requirements: CodexConfigRequirements | null;
  try {
    requirements = parseConfigRequirementsResult(await client.request("configRequirements/read"));
  } catch {
    if (permissionMode !== null) {
      throw new Error("Codex runtime requirements could not be validated.");
    }
    return null;
  }
  await validator?.(requirements);
  validatePermissionModeRequirements(permissionMode, requirements);
  return requirements;
}

function parseCollaborationModes(result: unknown): CodexCollaborationModePreset[] {
  const record = asRecord(result);
  if (!record || !Array.isArray(record.data)) {
    throw new Error("Codex collaboration modes response was invalid.");
  }
  return record.data.map((value) => {
    const preset = asRecord(value);
    const mode = preset?.mode;
    const model = preset?.model;
    const effort = preset?.reasoning_effort;
    if (
      !preset ||
      typeof preset.name !== "string" ||
      (mode !== null && mode !== "default" && mode !== "plan") ||
      (model !== null && typeof model !== "string") ||
      (effort !== null && typeof effort !== "string")
    ) {
      throw new Error("Codex collaboration modes response was invalid.");
    }
    return {
      name: preset.name,
      mode,
      model,
      reasoning_effort: effort
    } as CodexCollaborationModePreset;
  });
}

async function collaborationParams(
  client: CodexAppServerProtocolClient,
  mode: CodexCollaborationMode | null,
  fallbackModel?: string,
  fallbackEffort?: string | null
): Promise<Record<string, unknown> | null> {
  if (mode === null) return null;
  const presets = parseCollaborationModes(await client.request("collaborationMode/list", {}));
  const preset = presets.find((candidate) => candidate.mode === mode);
  const model = preset?.model ?? fallbackModel;
  if (!preset || !model) {
    throw new Error("Codex collaboration mode is not available.");
  }
  return {
    mode,
    settings: {
      model,
      reasoning_effort: preset.reasoning_effort ?? fallbackEffort ?? null,
      developer_instructions: null
    }
  };
}

function inputParams(options: RunCodexAppServerStdioTurnSessionOptions): Array<Record<string, string | string[]>> {
  return [
    { type: "text", text: options.prompt, text_elements: [] },
    ...(options.imageAttachments ?? []).map((attachment) => ({
      type: "localImage",
      path: attachment.path
    }))
  ];
}

function threadRuntimeParams(options: RunCodexAppServerStdioTurnSessionOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.model) {
    params.model = options.model;
  }
  if (options.modelProvider) {
    params.modelProvider = options.modelProvider;
  }
  return params;
}

function permissionRuntimeParams(permissionMode: CodexPermissionMode | null): Record<string, unknown> {
  const params = permissionParamsForMode(permissionMode);
  return params ? { ...params } : {};
}

function turnRuntimeParams(options: RunCodexAppServerStdioTurnSessionOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.model) {
    params.model = options.model;
  }
  if (options.reasoningEffort) {
    params.effort = options.reasoningEffort;
  }
  return params;
}

function turnStartParams(
  threadId: string,
  options: RunCodexAppServerStdioTurnSessionOptions,
  collaborationMode: Record<string, unknown> | null
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId,
    input: inputParams(options),
    ...turnRuntimeParams(options)
  };
  if (collaborationMode) params.collaborationMode = collaborationMode;
  return params;
}

function recoveredTurns(result: unknown): Array<Record<string, unknown>> {
  const thread = asRecord(asRecord(result)?.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.map((turn) => asRecord(turn)).filter((turn): turn is Record<string, unknown> => Boolean(turn));
}

function recoveredTurn(result: unknown, turnId: string): Record<string, unknown> | null {
  return recoveredTurns(result).find((turn) => stringField(turn, "id") === turnId) ?? null;
}

function latestRecoveredCompletedTurn(result: unknown): Record<string, unknown> | null {
  const turns = recoveredTurns(result);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turnStatusField(turns[index] ?? null) === "completed") return turns[index] ?? null;
  }
  return null;
}

function latestRecoveredInProgressTurn(result: unknown): Record<string, unknown> | null {
  const turns = recoveredTurns(result);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turnStatusField(turns[index] ?? null) === "inProgress") return turns[index] ?? null;
  }
  return null;
}

function recoveredTurnWithMarker(result: unknown, marker: string): Record<string, unknown> | null {
  const turns = recoveredTurns(result);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] ?? null;
    if (turn && JSON.stringify(turn).includes(marker)) return turn;
  }
  return null;
}

function promptWithRecoveryMarker(prompt: string, marker: string | undefined): string {
  if (!marker || prompt.includes(marker)) return prompt;
  return [
    prompt,
    "",
    `<space-durable-turn marker="${marker}">Internal recovery marker; do not mention it in your response.</space-durable-turn>`
  ].join("\n");
}

function recoveredAgentMessageText(turn: Record<string, unknown>): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return cappedAgentMessageText(
    items
      .map((item) => asRecord(item))
      .filter((item) => stringField(item, "type") === "agentMessage")
      .map((item) => stringField(item, "text") ?? "")
      .filter(Boolean)
      .join("\n")
  );
}

function recoveredTurnState(
  threadId: string,
  turn: Record<string, unknown>,
  completedNotificationSeen: boolean
): CodexAppServerTurnSessionState {
  return {
    threadId,
    turnId: stringField(turn, "id"),
    turnStatus: turnStatusField(turn),
    goalStatus: null,
    notificationCount: completedNotificationSeen ? 1 : 0,
    completedNotificationSeen,
    agentMessageText: recoveredAgentMessageText(turn)
  };
}

function recoveryDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function runCodexAppServerStdioTurnSession(
  options: RunCodexAppServerStdioTurnSessionOptions
): Promise<CodexAppServerTurnSessionState> {
  let session = initialCodexAppServerTurnSessionState();
  const normalizedObjective = normalizedGoalObjective(options.goalObjective);
  const goalObjective = normalizedObjective
    ? promptWithRecoveryMarker(normalizedObjective, options.recoveryMarker)
    : null;
  let resolveGoalCompletion: (() => void) | null = null;
  let rejectGoalCompletion: ((error: Error) => void) | null = null;
  let checkpointTail = Promise.resolve();
  let checkpointFailure: Error | null = null;
  const checkpointedGoalTurnIds = new Set<string>();
  let goalProgressObservedAt = Date.now();

  const maybeCompleteGoalSession = () => {
    if (
      resolveGoalCompletion &&
      session.completedNotificationSeen &&
      session.goalStatus &&
      terminalThreadGoalStatuses.has(session.goalStatus)
    ) {
      const resolve = resolveGoalCompletion;
      resolveGoalCompletion = null;
      rejectGoalCompletion = null;
      resolve();
    }
  };

  return runCodexAppServerStdioProtocol(
    options,
    async (client) => {
      const permissionMode = options.permissionMode ?? null;
      await readFreshRequirements(client, permissionMode, options.requirementsValidator);
      const collaboration = await collaborationParams(
        client,
        options.collaborationMode ?? null,
        options.model,
        options.reasoningEffort
      );
      let threadId = options.threadId ?? null;
      if (threadId) {
        const result = asRecord(await client.request("thread/resume", {
          threadId,
          ...threadRuntimeParams(options),
          ...permissionRuntimeParams(permissionMode)
        }));
        threadId = stringField(asRecord(result?.thread), "id");
      } else {
        const result = asRecord(await client.request("thread/start", {
          ephemeral: options.ephemeral ?? true,
          serviceName: options.serviceName ?? "space-capability",
          ...threadRuntimeParams(options),
          ...permissionRuntimeParams(permissionMode)
        }));
        threadId = stringField(asRecord(result?.thread), "id");
      }
      if (!threadId) {
        throw new Error("Codex App Server thread response did not include a thread id.");
      }
      session = { ...session, threadId };
      let recoveryTurnId = options.resumeTurnId ?? null;
      await options.onCheckpoint?.({ threadId, turnId: recoveryTurnId });

      if (!recoveryTurnId && options.threadId && options.recoveryMarker) {
        const result = await client.request("thread/read", { threadId, includeTurns: true });
        const markedTurn = recoveredTurnWithMarker(result, options.recoveryMarker);
        recoveryTurnId = markedTurn ? stringField(markedTurn, "id") : null;
        if (recoveryTurnId) {
          await options.onCheckpoint?.({ threadId, turnId: recoveryTurnId });
        }
      }

      if (recoveryTurnId) {
        const recoveryDeadlineMs = options.timeoutMs === null
          ? null
          : Date.now() + (options.timeoutMs ?? 60_000);
        let recoveredCompletedTurn = false;
        while (recoveryDeadlineMs === null || Date.now() < recoveryDeadlineMs) {
          const result = await client.request("thread/read", { threadId, includeTurns: true });
          const turn = recoveredTurn(result, recoveryTurnId);
          if (!turn) break;
          const status = turnStatusField(turn);
          if (status === "completed") {
            session = recoveredTurnState(threadId, turn, true);
            recoveredCompletedTurn = true;
            if (!goalObjective) return session;
            break;
          }
          if (status === "interrupted" || status === "failed") {
            session = recoveredTurnState(threadId, turn, false);
            break;
          }
          await recoveryDelay(Math.max(25, options.recoveryPollIntervalMs ?? 250));
        }
        if (
          !recoveredCompletedTurn &&
          session.turnStatus !== "interrupted" &&
          session.turnStatus !== "failed"
        ) {
          throw new Error("Codex App Server durable turn recovery timed out.");
        }
      }

      if (goalObjective) {
        const goalThreadSettings = {
          ...turnRuntimeParams(options),
          ...(collaboration ? { collaborationMode: collaboration } : {})
        };
        if (!recoveryTurnId && Object.keys(goalThreadSettings).length > 0) {
          await client.request("thread/settings/update", { threadId, ...goalThreadSettings });
        }
        const goalCompletion = new Promise<void>((resolveGoal, rejectGoal) => {
          resolveGoalCompletion = resolveGoal;
          rejectGoalCompletion = rejectGoal;
        });
        let goal: CodexThreadGoal | null = null;
        let awaitingInitialGoalTurn = false;
        const notificationCountBeforeGoalRead = session.notificationCount;
        if (options.threadId) {
          const result = asRecord(await client.request("thread/goal/get", { threadId }));
          goal = parseThreadGoal(result?.goal);
        }
        const goalProgressObservedDuringRead = session.notificationCount > notificationCountBeforeGoalRead;
        const samePersistedGoal = Boolean(goal && goal.objective === goalObjective);
        if (samePersistedGoal && goal && terminalThreadGoalStatuses.has(goal.status)) {
          const result = await client.request("thread/read", { threadId, includeTurns: true });
          const latestCompletedTurn = latestRecoveredCompletedTurn(result);
          if (latestCompletedTurn) {
            session = recoveredTurnState(threadId, latestCompletedTurn, true);
          } else {
            session = {
              ...session,
              threadId,
              turnStatus: "completed",
              completedNotificationSeen: true
            };
          }
        }
        const reattachActiveGoal = Boolean(
          samePersistedGoal &&
          goal?.status === "active" &&
          goal.objective === goalObjective
        );
        const recoverTerminalGoal = Boolean(
          samePersistedGoal &&
          goal &&
          terminalThreadGoalStatuses.has(goal.status)
        );
        if (reattachActiveGoal && !goalProgressObservedDuringRead) {
          session = {
            ...session,
            turnStatus: null,
            completedNotificationSeen: false,
            agentMessageText: ""
          };
        }
        if (!reattachActiveGoal && !recoverTerminalGoal) {
          if ((options.imageAttachments?.length ?? 0) > 0 && !recoveryTurnId) {
            const seedTurnOptions = {
              ...options,
              prompt: promptWithRecoveryMarker(
                "Ingest the attached images as context for the next Goal. Do not analyze them, take actions, or begin the user's task in this turn. Reply only that the attachments are ready.",
                options.recoveryMarker
              )
            };
            const completed = client.waitForNotification("turn/completed");
            const turnRequest = client
              .request("turn/start", turnStartParams(threadId, seedTurnOptions, collaboration))
              .then(async (turnResponse) => {
                const turnResult = asRecord(turnResponse);
                const responseState = applyTurnRecord(session, asRecord(turnResult?.turn));
                if (!responseState.turnId) {
                  throw new Error("Codex App Server turn/start response did not include a turn id.");
                }
                if (!checkpointedGoalTurnIds.has(responseState.turnId)) {
                  checkpointedGoalTurnIds.add(responseState.turnId);
                  await options.onCheckpoint?.({ threadId, turnId: responseState.turnId });
                }
                return { responseState };
              });
            const [{ responseState }] = await Promise.all([turnRequest, completed]);
            session = {
              ...responseState,
              ...session,
              threadId: session.threadId ?? responseState.threadId,
              turnId: session.turnId ?? responseState.turnId,
              turnStatus: session.turnStatus ?? responseState.turnStatus
            };
          }
          session = {
            ...session,
            turnId: null,
            turnStatus: null,
            goalStatus: null,
            completedNotificationSeen: false,
            agentMessageText: ""
          };
          awaitingInitialGoalTurn = true;
          const result = asRecord(await client.request("thread/goal/set", {
            threadId,
            objective: goalObjective,
            status: "active",
            tokenBudget: null
          }));
          goal = parseThreadGoal(result?.goal);
        }
        session = {
          ...session,
          threadId,
          goalStatus: session.goalStatus ?? goal?.status ?? null
        };
        goalProgressObservedAt = Date.now();

        const driveGoalProgress = async () => {
          const graceMs = Math.max(1, options.goalProgressGraceMs ?? 5_000);
          const pollMs = Math.min(1_000, graceMs);
          const confirmationMs = Math.min(100, pollMs);
          const continuationPrompt = promptWithRecoveryMarker(
            "Continue working toward the active Goal. If no Goal turn has started yet, begin now. Inspect durable progress first, do not repeat completed work, and mark the Goal complete only after every requirement is finished.",
            options.recoveryMarker
          );
          const waitForGoalCompletionOrDelay = (ms: number) => Promise.race([
            goalCompletion,
            recoveryDelay(ms)
          ]);

          while (resolveGoalCompletion && !client.isClosed()) {
            if (checkpointFailure) throw checkpointFailure;
            const remainingGraceMs = graceMs - (Date.now() - goalProgressObservedAt);
            if (remainingGraceMs > 0) {
              await waitForGoalCompletionOrDelay(Math.min(pollMs, remainingGraceMs));
              continue;
            }
            if (session.goalStatus !== "active") {
              await waitForGoalCompletionOrDelay(pollMs);
              continue;
            }

            const durableResult = await client.request("thread/read", { threadId, includeTurns: true });
            if (!resolveGoalCompletion || client.isClosed()) return;
            if (checkpointFailure) throw checkpointFailure;
            const durableActiveTurn = latestRecoveredInProgressTurn(durableResult);
            if (durableActiveTurn) {
              session = {
                ...applyTurnRecord(session, durableActiveTurn),
                completedNotificationSeen: false,
                agentMessageText: recoveredAgentMessageText(durableActiveTurn)
              };
              const durableTurnId = stringField(durableActiveTurn, "id");
              if (durableTurnId && !checkpointedGoalTurnIds.has(durableTurnId)) {
                checkpointedGoalTurnIds.add(durableTurnId);
                await options.onCheckpoint?.({ threadId, turnId: durableTurnId });
              }
              goalProgressObservedAt = Date.now();
              continue;
            }
            if (session.turnStatus === "inProgress" && session.turnId) {
              const durableCurrentTurn = recoveredTurn(durableResult, session.turnId);
              const durableCurrentStatus = turnStatusField(durableCurrentTurn);
              if (!durableCurrentTurn || durableCurrentStatus === "inProgress") {
                goalProgressObservedAt = Date.now();
                continue;
              }
              session = {
                ...recoveredTurnState(
                  threadId,
                  durableCurrentTurn,
                  durableCurrentStatus === "completed"
                ),
                goalStatus: session.goalStatus,
                notificationCount: session.notificationCount
              };
            }
            if (Date.now() - goalProgressObservedAt < graceMs) continue;
            await waitForGoalCompletionOrDelay(confirmationMs);
            if (!resolveGoalCompletion || client.isClosed()) return;
            if (checkpointFailure) throw checkpointFailure;
            if (
              session.goalStatus !== "active" ||
              session.turnStatus === "inProgress" ||
              Date.now() - goalProgressObservedAt < graceMs
            ) {
              continue;
            }

            const fallbackPrompt = awaitingInitialGoalTurn && !session.turnId
              ? goalObjective
              : continuationPrompt;
            session = {
              ...session,
              turnId: null,
              turnStatus: null,
              completedNotificationSeen: false,
              agentMessageText: ""
            };
            const turnOptions = {
              ...options,
              prompt: fallbackPrompt,
              imageAttachments: []
            };
            const turnResult = asRecord(await client.request(
              "turn/start",
              turnStartParams(threadId, turnOptions, collaboration)
            ));
            const responseState = applyTurnRecord(session, asRecord(turnResult?.turn));
            if (!responseState.turnId) {
              throw new Error("Codex App Server Goal fallback turn/start response did not include a turn id.");
            }
            awaitingInitialGoalTurn = false;
            session = {
              ...responseState,
              ...session,
              threadId: session.threadId ?? responseState.threadId,
              turnId: session.turnId ?? responseState.turnId,
              turnStatus: session.turnStatus ?? responseState.turnStatus
            };
            if (!checkpointedGoalTurnIds.has(responseState.turnId)) {
              checkpointedGoalTurnIds.add(responseState.turnId);
              await options.onCheckpoint?.({ threadId, turnId: responseState.turnId });
            }
            goalProgressObservedAt = Date.now();
          }
        };

        maybeCompleteGoalSession();
        await Promise.all([goalCompletion, driveGoalProgress()]);
        await checkpointTail;
        if (checkpointFailure) throw checkpointFailure;
        return session;
      }

      const basePrompt = recoveryTurnId
        ? options.recoveryPrompt ?? "Continue only unfinished work after the Space worker restarted. Inspect durable progress before acting, and do not repeat completed actions."
        : options.prompt;
      const turnOptions = {
        ...options,
        prompt: promptWithRecoveryMarker(basePrompt, options.recoveryMarker)
      };
      const completed = client.waitForNotification("turn/completed");
      const turnRequest = client
        .request("turn/start", turnStartParams(threadId, turnOptions, collaboration))
        .then(async (turnResponse) => {
          const turnResult = asRecord(turnResponse);
          const responseState = applyTurnRecord(session, asRecord(turnResult?.turn));
          if (!responseState.turnId) {
            throw new Error("Codex App Server turn/start response did not include a turn id.");
          }
          await options.onCheckpoint?.({ threadId, turnId: responseState.turnId });
          return { turnResponse, responseState };
        });
      const [{ responseState }] = await Promise.all([turnRequest, completed]);
      session = {
        ...responseState,
        ...session,
        threadId: session.threadId ?? responseState.threadId,
        turnId: session.turnId ?? responseState.turnId,
        turnStatus: session.turnStatus ?? responseState.turnStatus
      };
      return session;
    },
    (message) => {
      session = reduceCodexAppServerTurnSessionState(session, message, {
        threadStartRequestId: -1,
        turnStartRequestId: -1
      });
      if (goalObjective && message.method) {
        goalProgressObservedAt = Date.now();
      }
      if (goalObjective && message.method === "turn/started" && session.threadId && session.turnId) {
        const checkpoint = { threadId: session.threadId, turnId: session.turnId };
        if (checkpointedGoalTurnIds.has(checkpoint.turnId)) {
          maybeCompleteGoalSession();
          return;
        }
        checkpointedGoalTurnIds.add(checkpoint.turnId);
        checkpointTail = checkpointTail
          .then(() => options.onCheckpoint?.(checkpoint))
          .then(() => undefined)
          .catch((error) => {
            const failure = error instanceof Error ? error : new Error("Codex App Server checkpoint failed.");
            checkpointFailure = failure;
            rejectGoalCompletion?.(failure);
          });
      }
      maybeCompleteGoalSession();
    }
  );
}

const threadGoalStatuses = new Set<CodexThreadGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

const terminalThreadGoalStatuses = new Set<CodexThreadGoalStatus>([
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

function normalizedGoalObjective(value: string | null | undefined): string | null {
  const objective = value?.trim() ?? "";
  if (!objective) return null;
  return objective;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseThreadGoal(value: unknown): CodexThreadGoal | null {
  if (value === null) return null;
  const goal = asRecord(value);
  const threadId = stringField(goal, "threadId");
  const objective = stringField(goal, "objective");
  const status = stringField(goal, "status") as CodexThreadGoalStatus | null;
  const tokensUsed = numberField(goal, "tokensUsed");
  const timeUsedSeconds = numberField(goal, "timeUsedSeconds");
  const createdAt = numberField(goal, "createdAt");
  const updatedAt = numberField(goal, "updatedAt");
  const tokenBudgetValue = goal?.tokenBudget;
  if (
    !threadId ||
    !objective ||
    !status ||
    !threadGoalStatuses.has(status) ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    createdAt === null ||
    updatedAt === null ||
    (tokenBudgetValue !== null && (typeof tokenBudgetValue !== "number" || !Number.isFinite(tokenBudgetValue)))
  ) {
    throw new Error("Codex App Server goal response was invalid.");
  }
  return {
    threadId,
    objective,
    status,
    tokenBudget: tokenBudgetValue as number | null,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt
  };
}

function goalSetParams(threadId: string, action: Extract<CodexAppServerGoalAction, { type: "set" }>) {
  const params: Record<string, unknown> = { threadId };
  if (action.objective !== undefined) params.objective = action.objective;
  if (action.status !== undefined) params.status = action.status;
  if (action.tokenBudget !== undefined) params.tokenBudget = action.tokenBudget;
  return params;
}

export async function runCodexAppServerStdioGoalSession(
  options: RunCodexAppServerStdioGoalSessionOptions
): Promise<CodexAppServerGoalSessionResult> {
  return runCodexAppServerStdioProtocol(options, async (client) => {
    const permissionMode = options.permissionMode ?? null;
    await readFreshRequirements(client, permissionMode, options.requirementsValidator);
    let threadId = options.threadId ?? null;
    if (!threadId) {
      const result = asRecord(await client.request("thread/start", {
        ephemeral: false,
        serviceName: options.serviceName ?? "space-agent-goal",
        ...(options.model ? { model: options.model } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        ...permissionRuntimeParams(permissionMode)
      }));
      threadId = stringField(asRecord(result?.thread), "id");
    }
    if (!threadId) throw new Error("Codex App Server thread response did not include a thread id.");

    if (options.action.type === "clear") {
      const result = asRecord(await client.request("thread/goal/clear", { threadId }));
      if (typeof result?.cleared !== "boolean") {
        throw new Error("Codex App Server goal response was invalid.");
      }
      return { threadId, goal: null, cleared: result.cleared };
    }
    const method = options.action.type === "get" ? "thread/goal/get" : "thread/goal/set";
    const params = options.action.type === "get"
      ? { threadId }
      : goalSetParams(threadId, options.action);
    const result = asRecord(await client.request(method, params));
    if (!result || !("goal" in result)) {
      throw new Error("Codex App Server goal response was invalid.");
    }
    return { threadId, goal: parseThreadGoal(result.goal), cleared: null };
  });
}

interface CodexAppServerSocketProtocolClient {
  request(method: CodexAppServerSocketRpcMethod, params?: Record<string, unknown>): Promise<unknown>;
}

function socketInitializedParams(options: CodexAppServerSocketControlServiceOptions): Record<string, unknown> {
  return {
    clientInfo: options.clientInfo ?? {
      name: "space",
      title: "Space",
      version: "0.1.0"
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false
    }
  };
}

function socketRemoteRpcError(method: CodexAppServerSocketRpcMethod): Error {
  return new Error(`Codex App Server ${method} returned an error.`);
}

function runCodexAppServerSocketProtocol<T>(
  options: CodexAppServerSocketControlServiceOptions,
  operation: (client: CodexAppServerSocketProtocolClient) => Promise<T>
): Promise<T> {
  if (!options.socketPath.trim()) {
    return Promise.reject(new Error("Codex App Server socket path is required."));
  }
  if (!isAbsolute(options.socketPath)) {
    return Promise.reject(new Error("Codex App Server socket path must be absolute."));
  }

  return new Promise<T>((resolveProtocol, rejectProtocol) => {
    const socket = new WebSocket(`ws+unix://${options.socketPath}:/rpc`, {
      maxPayload: codexAppServerSocketMaxPayloadBytes,
      perMessageDeflate: false
    });
    let settled = false;
    let connected = false;
    let nextRequestId = 0;
    let pending: {
      id: number;
      method: CodexAppServerSocketRpcMethod;
      resolve(value: unknown): void;
      reject(error: Error): void;
    } | null = null;
    const timeout = setTimeout(
      () => finish(new Error("Codex App Server socket request timed out.")),
      Math.max(1, options.timeoutMs ?? 5_000)
    );

    function finish(error: Error | null, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) {
        pending?.reject(error);
        rejectProtocol(error);
      } else {
        resolveProtocol(value as T);
      }
    }

    function send(message: unknown): void {
      socket.send(JSON.stringify(message));
    }

    const client: CodexAppServerSocketProtocolClient = {
      request(method, params) {
        try {
          assertCodexAppServerSocketRpcMethodAllowed(method);
        } catch (error) {
          return Promise.reject(error);
        }
        if (settled) return Promise.reject(new Error("Codex App Server socket session is closed."));
        if (pending) return Promise.reject(new Error("Codex App Server socket requests must be sequential."));
        const id = nextRequestId++;
        return new Promise<unknown>((resolveRequest, rejectRequest) => {
          pending = { id, method, resolve: resolveRequest, reject: rejectRequest };
          send(params === undefined ? { method, id } : { method, id, params });
        });
      }
    };

    function handleMessage(message: CodexAppServerJsonRpcMessage): void {
      if (message.method) {
        if (message.id !== undefined) {
          finish(new Error("Codex App Server socket sent an unsupported server request."));
        }
        return;
      }
      if (message.id === undefined || !pending || message.id !== pending.id) {
        finish(new Error("Codex App Server socket returned an unexpected response."));
        return;
      }
      const request = pending;
      pending = null;
      if (message.error) request.reject(socketRemoteRpcError(request.method));
      else request.resolve(message.result);
    }

    socket.once("open", () => {
      connected = true;
      void (async () => {
        try {
          await client.request("initialize", socketInitializedParams(options));
          send({ method: "initialized", params: {} });
          finish(null, await operation(client));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Codex App Server socket request failed."));
        }
      })();
    });
    socket.once("error", () => {
      finish(new Error(
        connected
          ? "Codex App Server socket connection failed."
          : "Codex App Server socket could not be connected."
      ));
    });
    socket.once("close", () => {
      if (!settled) finish(new Error("Codex App Server socket closed before the request completed."));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        finish(new Error("Codex App Server socket returned an unsupported binary message."));
        return;
      }
      try {
        handleMessage(parseCodexAppServerJsonRpcLine(data.toString()));
      } catch {
        finish(new Error("Codex App Server socket returned invalid JSON."));
      }
    });
  });
}

function parseSocketModelOption(value: unknown): CodexAppServerSocketModelOption {
  const model = asRecord(value);
  const id = stringField(model, "model") ?? stringField(model, "id");
  const displayName = boundedProviderText(model?.displayName, 160);
  const defaultReasoningEffort = providerReasoningEffort(model?.defaultReasoningEffort);
  const reasoningOptionsById = new Map<CodexReasoningEffort, { reasoningEffort: CodexReasoningEffort; description?: string }>();
  if (Array.isArray(model?.supportedReasoningEfforts)) {
    for (const option of model.supportedReasoningEfforts) {
      const record = asRecord(option);
      const reasoningEffort = providerReasoningEffort(record?.reasoningEffort ?? option);
      if (!reasoningEffort || reasoningOptionsById.has(reasoningEffort)) continue;
      reasoningOptionsById.set(reasoningEffort, {
        reasoningEffort,
        description: boundedProviderText(record?.description, 500)
      });
    }
  }
  const reasoningOptions = [...reasoningOptionsById.values()];
  if (
    !id ||
    !codexModelIdentifierPattern.test(id) ||
    !displayName ||
    typeof model?.isDefault !== "boolean" ||
    !defaultReasoningEffort ||
    !reasoningOptionsById.has(defaultReasoningEffort)
  ) {
    throw new Error("Codex App Server model/list response was invalid.");
  }
  return {
    id,
    displayName,
    description: boundedProviderText(model?.description, 500),
    isDefault: model.isDefault,
    defaultReasoningEffort,
    supportedReasoningEfforts: reasoningOptions.map((option) => option.reasoningEffort),
    reasoningOptions
  };
}

function parseSocketModelPage(result: unknown): { data: CodexAppServerSocketModelOption[]; nextCursor: string | null } {
  const record = asRecord(result);
  if (!record || !Array.isArray(record.data)) {
    throw new Error("Codex App Server model/list response was invalid.");
  }
  const nextCursor = record.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    throw new Error("Codex App Server model/list response was invalid.");
  }
  return {
    data: record.data.map(parseSocketModelOption),
    nextCursor: typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null
  };
}

function requiredSocketIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`Codex App Server ${label} is invalid.`);
  }
  return normalized;
}

function parseStartedSocketTurn(result: unknown): CodexAppServerSocketStartedTurn {
  const turn = asRecord(asRecord(result)?.turn);
  const turnId = stringField(turn, "id");
  const status = turnStatusField(turn);
  if (!turnId || !status) {
    throw new Error("Codex App Server turn/start response was invalid.");
  }
  return { turnId, status };
}

export function createCodexAppServerSocketControlService(
  options: CodexAppServerSocketControlServiceOptions
): CodexAppServerSocketControlService {
  return {
    listModels: () => runCodexAppServerSocketProtocol(options, async (client) => {
      const models = new Map<string, CodexAppServerSocketModelOption>();
      let cursor: string | null = null;
      do {
        const page = parseSocketModelPage(await client.request("model/list", {
          includeHidden: false,
          cursor,
          limit: 100
        }));
        for (const model of page.data) {
          if (!models.has(model.id)) models.set(model.id, model);
        }
        if (models.size > 200) throw new Error("Codex App Server model/list response was too large.");
        cursor = page.nextCursor;
      } while (cursor);
      if (!models.size) throw new Error("Codex App Server model/list response was empty.");
      return [...models.values()];
    }),
    updateThreadSettings: (input) => runCodexAppServerSocketProtocol(options, async (client) => {
      const reasoningEffort = providerReasoningEffort(input.reasoningEffort);
      if (!reasoningEffort) throw new Error("Codex App Server reasoning effort is invalid.");
      await client.request("thread/settings/update", {
        threadId: requiredSocketIdentifier(input.threadId, "thread id"),
        model: requiredSocketIdentifier(input.model, "model"),
        effort: reasoningEffort
      });
    }),
    interruptTurn: (input) => runCodexAppServerSocketProtocol(options, async (client) => {
      await client.request("turn/interrupt", {
        threadId: requiredSocketIdentifier(input.threadId, "thread id"),
        turnId: requiredSocketIdentifier(input.turnId, "turn id")
      });
    }),
    startTurn: (input) => runCodexAppServerSocketProtocol(options, async (client) => {
      const prompt = input.prompt.trim();
      if (!prompt || prompt.length > 20_000) throw new Error("Codex App Server continuation prompt is invalid.");
      const reasoningEffort = input.reasoningEffort === undefined
        ? undefined
        : providerReasoningEffort(input.reasoningEffort);
      if (input.reasoningEffort !== undefined && !reasoningEffort) {
        throw new Error("Codex App Server reasoning effort is invalid.");
      }
      const params: Record<string, unknown> = {
        threadId: requiredSocketIdentifier(input.threadId, "thread id"),
        input: [{ type: "text", text: prompt, text_elements: [] }],
        clientUserMessageId: requiredSocketIdentifier(input.clientUserMessageId, "client user message id")
      };
      if (input.model !== undefined) params.model = requiredSocketIdentifier(input.model, "model");
      if (reasoningEffort !== undefined) params.effort = reasoningEffort;
      return parseStartedSocketTurn(await client.request("turn/start", params));
    })
  };
}

export function createCodexAppServerControlService(
  options: CodexAppServerControlServiceOptions
): CodexAppServerControlService {
  return {
    readConfigRequirements: () => runCodexAppServerStdioProtocol(
      options,
      async (client) => parseConfigRequirementsResult(await client.request("configRequirements/read"))
    ),
    listModels: () => runCodexAppServerStdioProtocol(options, async (client) => {
      const models = new Map<string, CodexAppServerSocketModelOption>();
      let cursor: string | null = null;
      do {
        const page = parseSocketModelPage(await client.request("model/list", {
          includeHidden: false,
          cursor,
          limit: 100
        }));
        for (const model of page.data) {
          if (!models.has(model.id)) models.set(model.id, model);
        }
        if (models.size > 200) throw new Error("Codex App Server model/list response was too large.");
        cursor = page.nextCursor;
      } while (cursor);
      if (!models.size) throw new Error("Codex App Server model/list response was empty.");
      return [...models.values()];
    }),
    listCollaborationModes: () => runCodexAppServerStdioProtocol(
      options,
      async (client) => parseCollaborationModes(await client.request("collaborationMode/list", {}))
    ),
    setGoal: (input) => runCodexAppServerStdioGoalSession({
      ...options,
      threadId: input.threadId,
      action: {
        type: "set",
        objective: input.objective,
        status: input.status,
        tokenBudget: input.tokenBudget
      }
    }),
    clearGoal: (threadId) => runCodexAppServerStdioGoalSession({
      ...options,
      threadId,
      action: { type: "clear" }
    })
  };
}
