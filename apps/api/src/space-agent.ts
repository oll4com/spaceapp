import { Client, Connection } from "@temporalio/client";
import {
  permissionParamsForMode,
  validatePermissionModeRequirements,
  type CodexAppServerControlService,
  type CodexAppServerSocketModelOption,
  type CodexCollaborationModePreset,
  type CodexConfigRequirements
} from "@space/codex-app-server";
import {
  agentPaneSessionSchema,
  cliReasoningEffortSchema,
  type AgentPaneGoal,
  type AgentPaneBinding,
  type AgentPaneHistoryItem,
  type AgentPaneMessage,
  type AgentPaneModelOption,
  type AgentPaneSession,
  type AgentPaneToolOption,
  type Artifact,
  type CollaborationMode,
  type DummyTurnInput,
  imageArtifactMimeTypeSchema,
  type Pane,
  type PaneBrowserSession,
  type PermissionMode,
  type SpaceAgentSessionRecord
} from "@space/contracts";
import { SpaceFeatureDisabledError, makeSpaceId, nowIso, redactMemoryText, type SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { TurnStarterDisabledError, type TurnStarter } from "./turns.js";

export interface SpaceAgentAdapterInput {
  pane: Pane;
}

export interface SpaceAgentCreateInput extends SpaceAgentAdapterInput {
  title?: string;
  sessionId?: string | null;
  threadId?: string | null;
  selectedModelConfigId?: string | null;
  selectedToolIds?: string[] | null;
}

export interface SpaceAgentSendInput extends SpaceAgentAdapterInput {
  content: string;
  operatorUserId?: string;
  selectedModelConfigId?: string;
  selectedToolIds?: string[];
  artifactIds?: string[];
  traceId: string;
}

export interface SpaceAgentInterruptInput extends SpaceAgentAdapterInput {
  reason?: string;
}

export interface SpaceAgentSettingsInput extends SpaceAgentAdapterInput {
  title?: string;
  selectedModelConfigId?: string | null;
  selectedToolIds?: string[] | null;
  permissionMode?: PermissionMode | null;
  collaborationMode?: CollaborationMode;
}

export interface SpaceAgentGoalInput extends SpaceAgentAdapterInput {
  objective: string;
}

export interface SpaceAgentMutationResult {
  binding: AgentPaneBinding;
  session: AgentPaneSession;
}

export interface SpaceAgentAdapter {
  loadSession(input: SpaceAgentAdapterInput): Promise<AgentPaneSession>;
  createOrRestoreSession(input: SpaceAgentCreateInput): Promise<AgentPaneSession>;
  sendMessage(input: SpaceAgentSendInput): Promise<SpaceAgentMutationResult>;
  interrupt(input: SpaceAgentInterruptInput): Promise<SpaceAgentMutationResult>;
  updateSettings(input: SpaceAgentSettingsInput): Promise<SpaceAgentMutationResult>;
  setGoal(input: SpaceAgentGoalInput): Promise<SpaceAgentMutationResult>;
  clearGoal(input: SpaceAgentAdapterInput): Promise<SpaceAgentMutationResult>;
}

export type SpaceAgentControl = Pick<
  CodexAppServerControlService,
  "readConfigRequirements" | "listModels" | "listCollaborationModes" | "setGoal" | "clearGoal"
>;

export type SpaceAgentGoalReader = (threadId: string) => Promise<AgentPaneGoal | null>;

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1).toLowerCase()}` : value;
}

function reasoningLabel(reasoningKey: string | null): string | null {
  if (!reasoningKey) return null;
  return reasoningKey === "none" ? "No extra reasoning" : `${titleCase(reasoningKey)} reasoning`;
}

const modelConfigIdPrefix = "codex-v1|";
const modelSelectionUnavailableReason =
  "The selected model and reasoning configuration is not advertised by the current Codex model catalog.";

function modelConfigId(modelId: string, reasoningKey: string): string {
  return `${modelConfigIdPrefix}${modelId}|${reasoningKey}`;
}

function closedRuntimeGate(config: SpaceApiConfig): string | null {
  if (!config.agentPaneEnabled) return "SPACE_AGENT_PANE_ENABLED must be true before native pane agents can run.";
  if (!config.enableCodexTurns) return "SPACE_ENABLE_CODEX_TURNS must be true before native pane agents can run.";
  if (!config.codexAppServerEnabled) return "SPACE_CODEX_APP_SERVER_ENABLED must be true before native pane agents can run.";
  if (config.codexAppServerTransport !== "stdio") return "Space agent runtime currently supports only stdio Codex App Server turns.";
  if (!config.codexAppServerAllowStdioSpawn) return "SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN must be true before native pane agents can run.";
  if (!config.codexAppServerAllowTurnExecution) {
    return "SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION must be true before native pane agents can run.";
  }
  return null;
}

function modelOptions(catalog: CodexAppServerSocketModelOption[]): AgentPaneModelOption[] {
  return catalog.flatMap((model): AgentPaneModelOption[] =>
    model.supportedReasoningEfforts.map((reasoningKey) => ({
      id: modelConfigId(model.id, reasoningKey),
      displayName: model.displayName,
      providerId: null,
      providerName: null,
      model: model.id,
      reasoningKey,
      reasoningLabel: reasoningLabel(reasoningKey),
      isDefault: model.isDefault && reasoningKey === model.defaultReasoningEffort
    }))
  );
}

function toolOptionsFromStore(
  servers: Awaited<ReturnType<SpaceStore["listMcpServers"]>>,
  tools: Awaited<ReturnType<SpaceStore["listMcpTools"]>>
): AgentPaneToolOption[] {
  const serverById = new Map(servers.map((server) => [server.id, server]));
  if (!tools.length) {
    return servers.map((server) => {
      const isAvailable = server.status === "VERIFIED";
      return {
        id: server.id,
        displayName: server.displayName,
        description: `${server.displayName} MCP server tools.`,
        category: "mcp",
        slug: server.id,
        availability: isAvailable ? "default_on" : "default_off",
        authType: server.transport,
        authConnected: isAvailable,
        enabled: isAvailable,
        isAvailable,
        statusReason: isAvailable ? null : server.statusReason,
        isForceOn: false
      };
    });
  }
  return tools.map((tool) => {
    const server = serverById.get(tool.serverId);
    const isAvailable = tool.status === "VERIFIED" && server?.status === "VERIFIED";
    return {
      id: tool.id,
      displayName: tool.name,
      description: `${server?.displayName ?? tool.serverId} MCP tool.`,
      category: "mcp",
      slug: tool.name,
      availability: isAvailable && !tool.approvalRequired ? "default_on" : "default_off",
      authType: server?.transport ?? null,
      authConnected: server?.status === "VERIFIED",
      enabled: isAvailable && !tool.approvalRequired,
      isAvailable,
      statusReason: isAvailable ? null : tool.statusReason || server?.statusReason || "MCP tool is unavailable.",
      isForceOn: false
    };
  });
}

const memoryToolOptions: AgentPaneToolOption[] = [
  {
    id: "memory:search",
    displayName: "Memory search",
    description: "Search canonical Space operational memory.",
    category: "memory",
    slug: "memory.search",
    availability: "force_on",
    authType: "space-memory",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  },
  {
    id: "memory:save",
    displayName: "Memory save",
    description: "Save approved notes to canonical Space memory.",
    category: "memory",
    slug: "memory.save",
    availability: "force_on",
    authType: "space-memory",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  }
];

const clipboardToolOptions: AgentPaneToolOption[] = [
  {
    id: "clipboard:list",
    displayName: "Clipboard list",
    description: "List the authenticated operator's private Space clipboard history when requested.",
    category: "memory",
    slug: "clipboard.list",
    availability: "force_on",
    authType: "space-clipboard",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  },
  {
    id: "clipboard:get",
    displayName: "Clipboard get",
    description: "Read one private Space clipboard item by id when the operator requests it.",
    category: "memory",
    slug: "clipboard.get",
    availability: "force_on",
    authType: "space-clipboard",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  },
  {
    id: "clipboard:save",
    displayName: "Clipboard save",
    description: "Save an operator-requested agent note to the private Space clipboard.",
    category: "memory",
    slug: "clipboard.save",
    availability: "force_on",
    authType: "space-clipboard",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  },
  {
    id: "clipboard:save-plan",
    displayName: "Clipboard save plan",
    description: "Save the full plan an agent designed to the private Space clipboard so it can be dragged into any CLI pane.",
    category: "memory",
    slug: "clipboard.save-plan",
    availability: "force_on",
    authType: "space-clipboard",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  }
];

const skillToolOptions: AgentPaneToolOption[] = [
  {
    id: "skills:list",
    displayName: "Skill list",
    description: "Discover the installed Space agent skills.",
    category: "skills",
    slug: "skills.list",
    availability: "force_on",
    authType: "space-skills",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  },
  {
    id: "skills:read",
    displayName: "Skill read",
    description: "Read an installed Space agent skill.",
    category: "skills",
    slug: "skills.read",
    availability: "force_on",
    authType: "space-skills",
    authConnected: true,
    enabled: true,
    isAvailable: true,
    statusReason: null,
    isForceOn: true
  }
];

const browserToolDefinitions: Array<{ id: string; displayName: string; slug: string; description: string }> = [
  { id: "browser:navigate", displayName: "Browser navigate", slug: "browser.navigate", description: "Navigate one managed browser tab without affecting parallel browser panes." },
  { id: "browser:screenshot", displayName: "Browser screenshot", slug: "browser.screenshot", description: "Capture a browser screenshot as a Space artifact with seven-day retention and Pin support." },
  { id: "browser:extract_text", displayName: "Browser extract text", slug: "browser.extract_text", description: "Extract sanitized visible text from the active managed browser tab." },
  { id: "browser:click", displayName: "Browser click", slug: "browser.click", description: "Click coordinates in the active tab while respecting exclusive operator control." },
  { id: "browser:type", displayName: "Browser type", slug: "browser.type", description: "Type into the active tab while respecting exclusive operator control." },
  { id: "browser:scroll", displayName: "Browser scroll", slug: "browser.scroll", description: "Scroll the active managed browser tab." },
  { id: "browser:set_viewport", displayName: "Browser viewport", slug: "browser.set_viewport", description: "Switch the managed browser between desktop, tablet, and mobile viewport profiles." },
  { id: "browser:diagnostics", displayName: "Browser diagnostics", slug: "browser.diagnostics", description: "Read sanitized console, network, error, frame, and navigation timeline diagnostics." },
  { id: "browser:record", displayName: "Browser recording", slug: "browser.record", description: "Record bounded WebM and frame evidence for frame-by-frame debugging across parallel browser panes." }
];

const browserToolIds = new Set(browserToolDefinitions.map((tool) => tool.id));

function browserToolOptionsFromSessions(config: SpaceApiConfig, sessions: PaneBrowserSession[]): AgentPaneToolOption[] {
  const statusReason = !config.browserSessionsEnabled
    ? "Managed browser sessions are disabled."
    : sessions.length === 0
      ? "Open a Browser pane in this room to enable this tool."
      : null;
  return browserToolDefinitions.map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    description: tool.description,
    category: "browser",
    slug: tool.slug,
    availability: "default_off",
    authType: "space-browser",
    authConnected: statusReason === null,
    enabled: statusReason === null,
    isAvailable: statusReason === null,
    statusReason,
    isForceOn: false
  }));
}

function truncateForPrompt(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function safeBrowserUrl(raw: string | null): string {
  if (!raw) return "about:blank";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(auth|credential|key|pass|secret|session|token)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return truncateForPrompt(url.toString(), 500);
  } catch {
    return truncateForPrompt(redactMemoryText(raw), 500);
  }
}

function safePromptText(value: string | null, maxLength: number): string {
  return value ? truncateForPrompt(redactMemoryText(value).replace(/\s+/g, " ").trim(), maxLength) : "";
}

function selectedBrowserToolIds(selectedToolIds: string[] | null | undefined): string[] {
  return Array.from(new Set((selectedToolIds ?? []).filter((toolId) => browserToolIds.has(toolId))));
}

function clipboardToolContext(selectedToolIds: string[] | null | undefined): string | null {
  const selected = Array.from(
    new Set((selectedToolIds ?? []).filter((toolId) => toolId.startsWith("clipboard:")))
  );
  if (!selected.length) return null;
  return [
    "Space private clipboard tools selected:",
    `tools=${selected.join(", ")}`,
    "Use these tools only when the operator explicitly asks to list, read, or save Space clipboard history or a designed plan. Never add clipboard history to an ordinary prompt.",
    "To request a clipboard action, include one fenced block named space-clipboard-actions with JSON only:",
    '```space-clipboard-actions\n{"version":1,"actions":[{"toolId":"clipboard:list","action":{"type":"list","pageSize":10}}]}\n```',
    "Action bodies: clipboard:list uses type=list with optional q/source/pageSize; clipboard:get uses type=get with clipboardItemId; clipboard:save uses type=save with text; clipboard:save-plan uses type=save-plan with text and an optional title.",
    "V1 allows at most 3 actions per turn. clipboard:save creates an AGENT_NOTE and accepts at most 10,000 characters. clipboard:save-plan stores a PLAN (the full designed plan) and accepts up to 100,000 characters. CLI agents do not have clipboard API access."
  ].join("\n");
}

function browserToolContext(selectedToolIds: string[] | null | undefined, sessions: PaneBrowserSession[]): string | null {
  const selected = selectedBrowserToolIds(selectedToolIds);
  const activeSessions = sessions.filter((session) => session.isActive && session.status !== "CLOSED").slice(0, 8);
  if (!selected.length || !activeSessions.length) return null;
  const sessionLines = activeSessions.map((session) => {
    const title = safePromptText(session.title, 120);
    const parts = [
      `agent=${session.agentNumber}`,
      `pane=${session.paneId}`,
      `session=${session.sessionId}`,
      `viewport=${session.viewport}`,
      `stream=${session.streamMode}/${session.resolvedStreamMode}`,
      `control=${session.controlState}`,
      `tabs=${session.pages.length}`,
      `status=${session.status}`,
      `url=${safeBrowserUrl(session.currentUrl ?? session.targetUrl)}`
    ];
    if (title) parts.push(`title=${title}`);
    return `- ${parts.join("; ")}`;
  });
  return [
    "Space managed browser tools selected:",
    `tools=${selected.join(", ")}`,
    "Use only Space-scoped managed browser actions: navigate, screenshot, extract_text, click, type, scroll, set_viewport, diagnostics, record.",
    "To request browser actions, include one fenced block named space-browser-actions with JSON only:",
    '```space-browser-actions\n{"version":1,"actions":[{"toolId":"browser:extract_text","targetPaneId":"pane:id","action":{"type":"extract_text"}}]}\n```',
    "The toolId must match the action type, targetPaneId must be a listed browser pane, and a single turn may request at most 3 actions.",
    "Diagnostics and recordings return sanitized console/network summaries and Space artifact paths only. Do not request raw browser internals, browser cookies, localStorage, stream tickets, profile paths, or private network targets.",
    "Up to eight sessions may stay active, with four simultaneous live or recording workloads. Prefer SILENT or PREVIEW for unattended background work and request INTERACTIVE or REALTIME only when visual response is needed.",
    "If a site requires human login, CAPTCHA, or lock handoff, pause agent input and ask the operator to join that same visible browser pane. Resume only after operator control is released.",
    "Active browser sessions in this room:",
    ...sessionLines
  ].join("\n");
}

function isImageTurnArtifact(artifact: Artifact): boolean {
  return artifact.kind === "IMAGE" && imageArtifactMimeTypeSchema.safeParse(artifact.mimeType).success;
}

function artifactContext(artifacts: Artifact[]): string | null {
  if (!artifacts.length) return null;
  const lines = artifacts.slice(0, 8).map((artifact) => {
    const originalFilename = typeof artifact.metadata.originalFilename === "string" ? artifact.metadata.originalFilename : "upload";
    return `- ${artifact.id}: ${originalFilename}; kind=${artifact.kind}; mime=${artifact.mimeType}; bytes=${artifact.byteSize}; uri=${artifact.storageUri}`;
  });
  return [
    "Attached Space artifacts for this user message:",
    ...lines,
    "Use image artifacts directly when available. For other file kinds, use the artifact id/uri as the safe Space reference; do not guess raw file contents unless a mediated file-reading tool exposes them."
  ].join("\n");
}

function promptWithAgentContexts(content: string, contexts: Array<string | null>): string {
  const activeContexts = contexts.filter((context): context is string => Boolean(context));
  const normalizedContent = content.trim();
  if (!activeContexts.length) return normalizedContent;
  if (!normalizedContent) return activeContexts.join("\n\n");
  return `${activeContexts.join("\n\n")}\n\nUser prompt:\n${normalizedContent}`;
}

function selectedModelFromOptions(
  options: AgentPaneModelOption[],
  catalog: CodexAppServerSocketModelOption[],
  selectedModelConfigId: string | null,
  strict: boolean
): { selectedModel: AgentPaneModelOption | null; modelSelectionGate: string | null } {
  if (selectedModelConfigId === null) {
    return {
      selectedModel: options.find((option) => option.isDefault) ?? options[0] ?? null,
      modelSelectionGate: null
    };
  }

  const exact = options.find((option) => option.id === selectedModelConfigId);
  if (exact) return { selectedModel: exact, modelSelectionGate: null };

  const legacyCandidates = new Map<string, AgentPaneModelOption>();
  for (const legacyModel of catalog) {
    if (legacyModel.id !== selectedModelConfigId) continue;
    const legacyDefault = options.find(
      (option) => option.model === legacyModel.id && option.reasoningKey === legacyModel.defaultReasoningEffort
    );
    if (legacyDefault) legacyCandidates.set(legacyDefault.id, legacyDefault);
  }
  for (const option of options) {
    if (
      option.model &&
      option.reasoningKey &&
      `${option.model}:${option.reasoningKey}` === selectedModelConfigId
    ) {
      legacyCandidates.set(option.id, option);
    }
  }
  if (legacyCandidates.size === 1) {
    return { selectedModel: legacyCandidates.values().next().value ?? null, modelSelectionGate: null };
  }

  if (!strict) {
    return { selectedModel: null, modelSelectionGate: modelSelectionUnavailableReason };
  }

  throw new SpaceFeatureDisabledError(
    "SPACE_AGENT_MODEL_CONFIG_NOT_ADVERTISED",
    modelSelectionUnavailableReason
  );
}

function selectedSessionFields(select: {
  selectedModel: AgentPaneModelOption | null;
  selectedTools: string[];
}, fallback?: SpaceAgentSessionRecord) {
  return {
    selectedProviderId: null,
    selectedModelId: select.selectedModel?.model ?? fallback?.selectedModelId ?? null,
    selectedModelConfigId: select.selectedModel?.id ?? fallback?.selectedModelConfigId ?? null,
    selectedProviderName: null,
    selectedModelName: select.selectedModel
      ? select.selectedModel.model ?? select.selectedModel.displayName
      : fallback?.selectedModelName ?? null,
    selectedReasoningKey: select.selectedModel?.reasoningKey ?? fallback?.selectedReasoningKey ?? null,
    selectedToolIds: select.selectedTools
  };
}

function bindingFromSession(session: SpaceAgentSessionRecord): AgentPaneBinding {
  return {
    paneId: session.paneId,
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
    lastSyncedAt: session.lastSyncedAt
  };
}

function mapMessage(message: Awaited<ReturnType<SpaceStore["listSpaceAgentMessages"]>>[number]): AgentPaneMessage {
  return {
    id: message.messageId,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt
  };
}

function persistentTranscriptContext(
  messages: Awaited<ReturnType<SpaceStore["listSpaceAgentMessages"]>>,
  excludedMessageIds: Set<string>
): string | null {
  const priorMessages = messages
    .filter((message) => !excludedMessageIds.has(message.messageId))
    .filter((message) => message.status === "COMPLETED" && message.content.trim())
    .slice(-12);
  if (!priorMessages.length) return null;

  const lines = priorMessages.map((message) => {
    const content = safePromptText(message.content, message.role === "tool" ? 900 : 1200);
    return `- ${message.role}: ${content}`;
  });
  return [
    "Space persistent conversation context:",
    "Recent completed messages in this agent pane are below. Use them as continuity context for this turn.",
    ...lines
  ].join("\n").slice(0, 9000);
}

function runStatusFromRecord(
  session: SpaceAgentSessionRecord,
  run: Awaited<ReturnType<SpaceStore["getLatestSpaceAgentRun"]>>
): AgentPaneSession["runStatus"] {
  if (session.status === "BLOCKED") return "BLOCKED";
  if (!run) return session.status === "RUNNING" ? "RUNNING" : "IDLE";
  if (run.status === "QUEUED") return "QUEUED";
  if (run.status === "RUNNING") return "RUNNING";
  if (run.status === "FAILED") return "ERROR";
  if (run.status === "INTERRUPTED") return "IDLE";
  return "IDLE";
}

function historyFromNativeAndLegacy(nativeHistory: AgentPaneHistoryItem[], legacyHistory: AgentPaneHistoryItem[]): AgentPaneHistoryItem[] {
  return [...nativeHistory, ...legacyHistory]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, 100);
}

function toReasoningEffort(value: string | null): DummyTurnInput["reasoningEffort"] {
  const parsed = cliReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const permissionCopy: Record<PermissionMode, { label: string; description: string }> = {
  ask_for_approval: {
    label: "Ask for approval",
    description: "Work in the workspace and ask before sensitive actions."
  },
  approve_for_me: {
    label: "Approve for me",
    description: "Use the guardian reviewer for workspace approval requests."
  },
  full_access: {
    label: "Full access",
    description: "Run without sandbox restrictions or approval prompts."
  }
};

function fullAccessRequirementsGate(requirements: CodexConfigRequirements | null): string | null {
  try {
    validatePermissionModeRequirements("full_access", requirements);
    return null;
  } catch {
    return "Full access is disabled by Codex runtime requirements.";
  }
}

function permissionOptions(
  requirements: CodexConfigRequirements | null,
  unavailableReason: string | null
): AgentPaneSession["permissionOptions"] {
  const mode = "full_access" as const;
  const params = permissionParamsForMode(mode)!;
  const statusReason = unavailableReason ?? fullAccessRequirementsGate(requirements);
  return [{
    mode,
    ...permissionCopy[mode],
    sandbox: params.sandbox as "workspace-write" | "danger-full-access",
    approvalPolicy: params.approvalPolicy as "on-request" | "never",
    reviewer: params.approvalsReviewer as "user" | "guardian_subagent",
    isAvailable: statusReason === null,
    statusReason
  }];
}

function permissionState(): AgentPaneSession["permissionState"] {
  const mode = "full_access" as const;
  const params = permissionParamsForMode(mode)!;
  return {
    mode,
    effectiveMode: mode,
    isInherited: false,
    sandbox: params.sandbox as "workspace-write" | "danger-full-access",
    approvalPolicy: params.approvalPolicy as "on-request" | "never",
    reviewer: params.approvalsReviewer as "user" | "guardian_subagent",
    statusReason: "Full access is fixed for Chat tasks."
  };
}

interface SpaceAgentRuntimeCapabilities {
  requirements: CodexConfigRequirements | null;
  collaborationModes: CodexCollaborationModePreset[];
}

interface SpaceAgentModelCatalogResult {
  catalog: CodexAppServerSocketModelOption[];
  error: string | null;
}

type SpaceAgentModelCatalogSnapshot = () => Promise<SpaceAgentModelCatalogResult>;

interface SpaceAgentRuntimeCapabilitiesResult {
  value: SpaceAgentRuntimeCapabilities | null;
  error: string | null;
}

interface SpaceAgentOperationContext {
  modelCatalogSnapshot: SpaceAgentModelCatalogSnapshot;
  runtimeCapabilities: Promise<SpaceAgentRuntimeCapabilitiesResult>;
}

export function createSpaceAgentAdapter(options: {
  store: SpaceStore;
  config: SpaceApiConfig;
  codexTurnStarter: TurnStarter;
  codexAgentControl?: SpaceAgentControl | null;
  readGoal?: SpaceAgentGoalReader;
  requirementsCacheTtlMs?: number;
}): SpaceAgentAdapter {
  const { store, config, codexTurnStarter, codexAgentControl, readGoal } = options;
  let cachedRuntimeCapabilities: { value: SpaceAgentRuntimeCapabilities; expiresAt: number } | null = null;

  function createModelCatalogSnapshot(): SpaceAgentModelCatalogSnapshot {
    let pending: Promise<SpaceAgentModelCatalogResult> | null = null;
    return () => {
      pending ??= codexAgentControl
        ? codexAgentControl.listModels()
            .then((catalog) => ({ catalog, error: null }))
            .catch(() => ({ catalog: [], error: "Codex model catalog is unavailable." }))
        : Promise.resolve({ catalog: [], error: "Codex model catalog control is unavailable." });
      return pending;
    };
  }

  async function runtimeCapabilities(): Promise<SpaceAgentRuntimeCapabilities> {
    if (cachedRuntimeCapabilities && cachedRuntimeCapabilities.expiresAt > Date.now()) {
      return cachedRuntimeCapabilities.value;
    }
    if (!codexAgentControl) {
      throw new Error("Codex agent runtime control is unavailable.");
    }
    const [requirements, collaborationModes] = await Promise.all([
      codexAgentControl.readConfigRequirements(),
      codexAgentControl.listCollaborationModes()
    ]);
    const value = { requirements, collaborationModes };
    cachedRuntimeCapabilities = {
      value,
      expiresAt: Date.now() + (options.requirementsCacheTtlMs ?? 30_000)
    };
    return value;
  }

  function createOperationContext(): SpaceAgentOperationContext {
    const runtimeCapabilitiesSnapshot = runtimeCapabilities()
      .then((value) => ({ value, error: null }))
      .catch(() => ({ value: null, error: "Codex runtime requirements are unavailable." }));
    const modelCatalogSnapshot = createModelCatalogSnapshot();
    void modelCatalogSnapshot();
    return {
      modelCatalogSnapshot,
      runtimeCapabilities: runtimeCapabilitiesSnapshot
    };
  }

  async function selection(
    roomId: string,
    modelCatalogSnapshot: SpaceAgentModelCatalogSnapshot,
    selectedModelConfigId?: string | null,
    selectedToolIds?: string[] | null,
    strictModelSelection = false
  ) {
    const [catalogResult, mcpServers, mcpTools, browserSessions] = await Promise.all([
      modelCatalogSnapshot(),
      store.listMcpServers(),
      store.listMcpTools(),
      store.listActivePaneBrowserSessions(roomId)
    ]);
    const modelList = modelOptions(catalogResult.catalog);
    const modelSelection = catalogResult.error
      ? { selectedModel: null, modelSelectionGate: null }
      : selectedModelFromOptions(
          modelList,
          catalogResult.catalog,
          selectedModelConfigId ?? null,
          strictModelSelection
        );
    const tools = [
      ...memoryToolOptions,
      ...clipboardToolOptions,
      ...skillToolOptions,
      ...toolOptionsFromStore(mcpServers, mcpTools),
      ...browserToolOptionsFromSessions(config, browserSessions)
    ];
    const forceToolIds = tools.filter((tool) => tool.isForceOn).map((tool) => tool.id);
    const defaultToolIds = tools.filter((tool) => tool.enabled).map((tool) => tool.id);
    const availableToolIds = new Set(tools.filter((tool) => tool.isAvailable).map((tool) => tool.id));
    const requestedToolIds = (selectedToolIds == null ? defaultToolIds : selectedToolIds).filter((toolId) => availableToolIds.has(toolId));
    const selectedTools = Array.from(new Set([...requestedToolIds, ...forceToolIds]));
    return {
      modelCatalog: catalogResult.catalog,
      modelList,
      selectedModel: modelSelection.selectedModel,
      modelCatalogGate: catalogResult.error ?? (modelList.length ? null : "Codex model catalog did not advertise a selectable model."),
      modelSelectionGate: modelSelection.modelSelectionGate,
      tools,
      selectedTools,
      browserSessions
    };
  }

  async function selectionForExistingSession(
    session: SpaceAgentSessionRecord,
    input: SpaceAgentCreateInput,
    modelCatalogSnapshot: SpaceAgentModelCatalogSnapshot
  ) {
    return selection(
      input.pane.roomId,
      modelCatalogSnapshot,
      input.selectedModelConfigId === undefined ? session.selectedModelConfigId : input.selectedModelConfigId,
      input.selectedToolIds === undefined ? session.selectedToolIds : input.selectedToolIds,
      input.selectedModelConfigId !== undefined
    );
  }

  async function ensureSession(
    input: SpaceAgentCreateInput,
    modelCatalogSnapshot: SpaceAgentModelCatalogSnapshot
  ): Promise<SpaceAgentSessionRecord> {
    const runtimeGate = closedRuntimeGate(config);
    const forceNewSession = input.sessionId === null;
    if (input.sessionId) {
      const existing = await store.getSpaceAgentSession(input.sessionId);
      if (!existing || existing.roomId !== input.pane.roomId) {
        throw new SpaceFeatureDisabledError("SPACE_AGENT_SESSION_UNAUTHORIZED", "Space agent session is not available in this room.");
      }
      const select = await selectionForExistingSession(existing, input, modelCatalogSnapshot);
      const gate = runtimeGate ?? select.modelCatalogGate ?? select.modelSelectionGate;
      const status = gate ? "BLOCKED" : existing.status === "RUNNING" ? "RUNNING" : "READY";
      return store.updateSpaceAgentSession(existing.sessionId, {
        paneId: input.pane.id,
        roomId: input.pane.roomId,
        isActive: true,
        status,
        title: input.title ?? existing.title,
        threadId: input.threadId === undefined ? existing.threadId : input.threadId,
        ...selectedSessionFields(select, existing),
        permissionMode: "full_access",
        lastSyncedAt: nowIso()
      });
    }

    const active = forceNewSession ? null : await store.getActiveSpaceAgentSession(input.pane.id);
    if (active) {
      const select = await selectionForExistingSession(active, input, modelCatalogSnapshot);
      const gate = runtimeGate ?? select.modelCatalogGate ?? select.modelSelectionGate;
      const status = gate ? "BLOCKED" : active.status === "RUNNING" ? "RUNNING" : "READY";
      return store.updateSpaceAgentSession(active.sessionId, {
        status,
        title: input.title ?? active.title,
        threadId: input.threadId === undefined ? active.threadId : input.threadId,
        ...selectedSessionFields(select, active),
        permissionMode: "full_access",
        lastSyncedAt: nowIso()
      });
    }

    const select = await selection(
      input.pane.roomId,
      modelCatalogSnapshot,
      input.selectedModelConfigId,
      input.selectedToolIds,
      input.selectedModelConfigId !== undefined
    );
    const gate = runtimeGate ?? select.modelCatalogGate ?? select.modelSelectionGate;
    const status = gate ? "BLOCKED" : "READY";
    return store.createSpaceAgentSession({
      paneId: input.pane.id,
      roomId: input.pane.roomId,
      status,
      title: input.title ?? input.pane.title,
      threadId: input.threadId ?? null,
      ...selectedSessionFields(select),
      permissionMode: "full_access",
      isActive: true,
      lastSyncedAt: nowIso()
    });
  }

  function sessionGateState(
    session: SpaceAgentSessionRecord,
    select: Awaited<ReturnType<typeof selection>>,
    runtimeResult: SpaceAgentRuntimeCapabilitiesResult
  ) {
    const availablePermissionOptions = permissionOptions(runtimeResult.value?.requirements ?? null, runtimeResult.error);
    const fullAccessOption = availablePermissionOptions[0] ?? null;
    const permissionGate = fullAccessOption && !fullAccessOption.isAvailable
      ? fullAccessOption.statusReason ?? "Full access is unavailable."
      : null;
    const collaborationGate =
      session.collaborationMode === "plan" &&
      !runtimeResult.value?.collaborationModes.some((mode) => mode.mode === "plan")
        ? runtimeResult.error ?? "Plan mode is unavailable in this Codex runtime."
        : null;
    const nonSelectionGate =
      closedRuntimeGate(config) ?? select.modelCatalogGate ?? permissionGate ?? collaborationGate;
    return {
      availablePermissionOptions,
      nonSelectionGate,
      gate: nonSelectionGate ?? select.modelSelectionGate
    };
  }

  async function buildSession(
    session: SpaceAgentSessionRecord,
    operation: SpaceAgentOperationContext
  ): Promise<AgentPaneSession> {
    const [, runtimeResult] = await Promise.all([
      operation.modelCatalogSnapshot(),
      operation.runtimeCapabilities
    ]);
    const currentSession = (await store.getSpaceAgentSession(session.sessionId)) ?? session;
    const select = await selection(
      currentSession.roomId,
      operation.modelCatalogSnapshot,
      currentSession.selectedModelConfigId,
      currentSession.selectedToolIds
    );
    const gates = sessionGateState(currentSession, select, runtimeResult);
    const statusSession =
      gates.gate && currentSession.status !== "BLOCKED"
        ? await store.updateSpaceAgentSession(currentSession.sessionId, {
            status: "BLOCKED",
            lastSyncedAt: nowIso()
          })
        : currentSession;
    const projectedStatus: SpaceAgentSessionRecord["status"] = gates.gate
      ? "BLOCKED"
      : statusSession.status === "RUNNING"
        ? "RUNNING"
        : "READY";
    const projectedSession = {
      ...statusSession,
      status: projectedStatus,
      permissionMode: "full_access" as const,
      collaborationMode: statusSession.collaborationMode ?? "default",
      ...selectedSessionFields(select, select.modelSelectionGate ? undefined : statusSession)
    };
    const [messages, latestRun, nativeHistory, legacyHistory, goal] = await Promise.all([
      store.listSpaceAgentMessages(projectedSession.sessionId, 500),
      store.getLatestSpaceAgentRun(projectedSession.sessionId),
      store.listSpaceAgentHistory(projectedSession.roomId),
      store.listAgentPaneHistory(projectedSession.roomId),
      projectedSession.threadId && readGoal
        ? readGoal(projectedSession.threadId).catch(() => null)
        : Promise.resolve(null)
    ]);
    const statusReason = gates.gate ?? (latestRun?.errorMessage ? latestRun.errorMessage : "Space agent session is ready.");
    const runStatus = runStatusFromRecord(projectedSession, latestRun);
    const canSend =
      !gates.gate && runStatus !== "RUNNING" && runStatus !== "QUEUED" && runStatus !== "INTERRUPTING";
    return agentPaneSessionSchema.parse({
      binding: bindingFromSession(projectedSession),
      threadId: projectedSession.threadId,
      messages: messages.map(mapMessage),
      runStatus,
      statusReason,
      modelOptions: select.modelList,
      modelCatalog: select.modelCatalog,
      selectedModelConfigId: projectedSession.selectedModelConfigId,
      toolOptions: select.tools,
      selectedToolIds: select.selectedTools,
      permissionMode: projectedSession.permissionMode,
      collaborationMode: projectedSession.collaborationMode,
      permissionState: permissionState(),
      permissionOptions: gates.availablePermissionOptions,
      goal,
      history: historyFromNativeAndLegacy(nativeHistory, legacyHistory),
      capabilities: {
        canSend,
        canInterrupt:
          !gates.gate && Boolean(latestRun && (latestRun.status === "QUEUED" || latestRun.status === "RUNNING")),
        canSelectModel: !gates.nonSelectionGate && select.modelList.length > 0,
        canSelectTools: !gates.gate,
        supportsTools: true
      }
    });
  }

  async function loadSession(input: SpaceAgentAdapterInput): Promise<AgentPaneSession> {
    const operation = createOperationContext();
    const session = await ensureSession({ pane: input.pane }, operation.modelCatalogSnapshot);
    return buildSession(session, operation);
  }

  async function createOrRestoreSession(input: SpaceAgentCreateInput): Promise<AgentPaneSession> {
    const operation = createOperationContext();
    const session = await ensureSession(input, operation.modelCatalogSnapshot);
    return buildSession(session, operation);
  }

  async function sendMessage(input: SpaceAgentSendInput): Promise<SpaceAgentMutationResult> {
    const operation = createOperationContext();
    let session = await ensureSession({
      pane: input.pane,
      selectedModelConfigId: input.selectedModelConfigId,
      selectedToolIds: input.selectedToolIds
    }, operation.modelCatalogSnapshot);
    const sendSelection = await selection(
      input.pane.roomId,
      operation.modelCatalogSnapshot,
      session.selectedModelConfigId,
      session.selectedToolIds
    );
    const sendGates = sessionGateState(session, sendSelection, await operation.runtimeCapabilities);
    if (sendGates.gate) {
      session = await store.updateSpaceAgentSession(session.sessionId, { status: "BLOCKED", lastSyncedAt: nowIso() });
      const blocked = await buildSession(session, operation);
      return { binding: blocked.binding, session: blocked };
    }

    const userMessage = await store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: input.content,
      status: "COMPLETED"
    });
    const assistantMessage = await store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const requestedArtifactIds = Array.from(new Set(input.artifactIds ?? [])).slice(0, 8);
    const attachedArtifacts = requestedArtifactIds.length
      ? (await store.listArtifacts({ page: 1, pageSize: 100, sortOrder: "desc", roomId: input.pane.roomId })).filter((artifact) => {
          return requestedArtifactIds.includes(artifact.id) && (!artifact.paneId || artifact.paneId === input.pane.id);
        })
      : [];

    const turnInput: DummyTurnInput = {
      roomId: input.pane.roomId,
      paneId: input.pane.id,
      prompt: promptWithAgentContexts(input.content, [
        clipboardToolContext(sendSelection.selectedTools),
        artifactContext(attachedArtifacts)
      ]),
      artifactIds: attachedArtifacts.filter(isImageTurnArtifact).map((artifact) => artifact.id),
      providerId: null,
      modelId: session.selectedModelId === "codex-app-server-default" ? null : session.selectedModelId,
      reasoningEffort: toReasoningEffort(session.selectedReasoningKey),
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      agentThreadId: session.threadId,
      operatorUserId: input.operatorUserId,
      selectedToolIds: session.selectedToolIds ?? [],
      permissionMode: "full_access",
      collaborationMode: session.collaborationMode ?? "default",
      traceId: input.traceId
    };
    const planned = codexTurnStarter.plan(turnInput);
    const run = await store.createSpaceAgentRun({
      sessionId: session.sessionId,
      paneId: input.pane.id,
      roomId: input.pane.roomId,
      workflowId: planned.workflowId,
      temporalRunId: planned.runId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId,
      codexThreadId: session.threadId,
      codexTurnId: null
    });
    session = await store.updateSpaceAgentSession(session.sessionId, { status: "RUNNING", lastSyncedAt: nowIso() });

    try {
      const started = await codexTurnStarter.start(turnInput);
      if (started.runId !== run.temporalRunId) {
        await store.updateSpaceAgentRun(run.runId, { temporalRunId: started.runId, status: "QUEUED" });
      }
    } catch (error) {
      const message =
        error instanceof TurnStarterDisabledError
          ? error.message
          : "Space agent runtime unavailable. Temporal or Codex App Server could not start the run.";
      await store.updateSpaceAgentRun(run.runId, {
        status: "FAILED",
        errorCode: "SPACE_AGENT_RUNTIME_UNAVAILABLE",
        errorMessage: message
      });
      await store.updateSpaceAgentMessage(assistantMessage.messageId, { status: "FAILED", content: message });
      session = await store.updateSpaceAgentSession(session.sessionId, { status: "BLOCKED", lastSyncedAt: nowIso() });
      throw new SpaceFeatureDisabledError("SPACE_AGENT_RUNTIME_UNAVAILABLE", message);
    }

    const nextSession = await buildSession(session, operation);
    return { binding: nextSession.binding, session: nextSession };
  }

  async function interrupt(input: SpaceAgentInterruptInput): Promise<SpaceAgentMutationResult> {
    const operation = createOperationContext();
    const session = await ensureSession({ pane: input.pane }, operation.modelCatalogSnapshot);
    const run = await store.getLatestSpaceAgentRun(session.sessionId);
    if (run && (run.status === "QUEUED" || run.status === "RUNNING")) {
      try {
        const connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "5s" });
        try {
          const client = new Client({ connection, namespace: config.temporalNamespace });
          await client.workflow.getHandle(run.workflowId).cancel();
        } finally {
          await connection.close();
        }
      } catch {
        // The DB/UI state still records the operator interrupt. Temporal cancellation is best-effort for stdio activities.
      }
      await store.updateSpaceAgentRun(run.runId, {
        status: "INTERRUPTED",
        errorCode: "INTERRUPTED",
        errorMessage: input.reason ?? "Operator interrupted the Space agent run."
      });
      await store.updateSpaceAgentMessage(run.responseMessageId, {
        status: "INTERRUPTED",
        content: input.reason ?? "Interrupted by operator."
      });
    }
    const ready = await store.updateSpaceAgentSession(session.sessionId, { status: "READY", lastSyncedAt: nowIso() });
    const nextSession = await buildSession(ready, operation);
    return { binding: nextSession.binding, session: nextSession };
  }

  async function updateSettings(input: SpaceAgentSettingsInput): Promise<SpaceAgentMutationResult> {
    if (input.permissionMode !== undefined && input.permissionMode !== "full_access") {
      throw new SpaceFeatureDisabledError(
        "SPACE_AGENT_PERMISSION_FIXED_FULL_ACCESS",
        "Chat tasks always use Full access. Other permission modes cannot be selected."
      );
    }
    const operation = createOperationContext();
    if (input.permissionMode === "full_access") {
      const runtimeResult = await operation.runtimeCapabilities;
      if (!runtimeResult.value) {
        throw new SpaceFeatureDisabledError(
          "CODEX_PERMISSION_REQUIREMENTS_UNAVAILABLE",
          "Explicit permission overrides require current Codex runtime requirements."
        );
      }
      if (fullAccessRequirementsGate(runtimeResult.value.requirements)) {
        throw new SpaceFeatureDisabledError(
          "CODEX_PERMISSION_MODE_DISALLOWED",
          "Full access is disabled by Codex runtime requirements."
        );
      }
    }
    if (input.collaborationMode === "plan") {
      const runtimeResult = await operation.runtimeCapabilities;
      if (!runtimeResult.value) {
        throw new SpaceFeatureDisabledError(
          "CODEX_COLLABORATION_MODES_UNAVAILABLE",
          "Plan mode requires current Codex collaboration capabilities."
        );
      }
      if (!runtimeResult.value.collaborationModes.some((mode) => mode.mode === "plan")) {
        throw new SpaceFeatureDisabledError("CODEX_PLAN_MODE_UNAVAILABLE", "Plan mode is unavailable in this Codex runtime.");
      }
    }
    let session = await ensureSession({
      pane: input.pane,
      title: input.title,
      selectedModelConfigId: input.selectedModelConfigId,
      selectedToolIds: input.selectedToolIds
    }, operation.modelCatalogSnapshot);
    if (input.collaborationMode !== undefined) {
      session = await store.updateSpaceAgentSession(session.sessionId, {
        collaborationMode: input.collaborationMode,
        permissionMode: "full_access",
        lastSyncedAt: nowIso()
      });
    }
    const nextSession = await buildSession(session, operation);
    return { binding: nextSession.binding, session: nextSession };
  }

  async function setGoal(input: SpaceAgentGoalInput): Promise<SpaceAgentMutationResult> {
    if (!codexAgentControl) {
      throw new SpaceFeatureDisabledError("CODEX_GOAL_CONTROL_UNAVAILABLE", "Codex goal control is unavailable.");
    }
    const operation = createOperationContext();
    let session = await ensureSession({ pane: input.pane }, operation.modelCatalogSnapshot);
    const result = await codexAgentControl.setGoal({ threadId: session.threadId, objective: input.objective });
    if (result.threadId !== session.threadId) {
      session = await store.updateSpaceAgentSession(session.sessionId, {
        threadId: result.threadId,
        lastSyncedAt: nowIso()
      });
    }
    const nextSession = await buildSession(session, operation);
    return { binding: nextSession.binding, session: nextSession };
  }

  async function clearGoal(input: SpaceAgentAdapterInput): Promise<SpaceAgentMutationResult> {
    const operation = createOperationContext();
    const session = await ensureSession({ pane: input.pane }, operation.modelCatalogSnapshot);
    if (session.threadId) {
      if (!codexAgentControl) {
        throw new SpaceFeatureDisabledError("CODEX_GOAL_CONTROL_UNAVAILABLE", "Codex goal control is unavailable.");
      }
      await codexAgentControl.clearGoal(session.threadId);
    }
    const nextSession = await buildSession(session, operation);
    return { binding: nextSession.binding, session: nextSession };
  }

  return {
    loadSession,
    createOrRestoreSession,
    sendMessage,
    interrupt,
    updateSettings,
    setGoal,
    clearGoal
  };
}
