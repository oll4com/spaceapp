import { existsSync } from "node:fs";
import { apiPackageVersion } from "./package-version.js";
import { dirname, join } from "node:path";
import {
  cliChatTurnDefaultRuntimeIds,
  DOT_WORKSPACE_ROOT,
  mcpServerConfigListSchema,
  voiceTranscriptionModelSchema,
  voiceModelVoiceSchema,
  instanceBackgroundJobEnabled,
  instanceBackgroundJobs,
  type InstanceBackgroundJob,
  type McpServerConfig,
  type SpaceInstance,
  type VoiceTranscriptionModel,
  type VoiceModelVoice,
  type VncPreset,
  vncPresetSchema
} from "@space/contracts";
import { resolveCanonicalSpaceMemoryPaths } from "@space/runtime";
import {
  configuredCliCredentialSmoke,
  configuredCliLoginBootstrap,
  configuredCliRuntimeCommands,
  type CliRuntimeKey
} from "./cli-runtime-descriptors.js";
import { parseLiveModelPolicy, type LiveModelPolicy } from "./live-model-policy.js";
import { validateT3ApiEnv } from "./t3-env.js";

export interface SpaceApiConfig {
  t3CodeEnabled: boolean;
  t3CodeSocketPath: string;
  t3CodeProxyTimeoutMs: number;
  t3CodeHealthTimeoutMs: number;
  instance: SpaceInstance;
  /** Jobs that would repeat copied stable work; a dev instance runs only those it opts into. */
  instanceJobs: Record<InstanceBackgroundJob, boolean>;
  host: string;
  port: number;
  version: string;
  runtimeStore: "memory" | "postgres";
  databaseUrl: string | null;
  databasePoolMax: number;
  databasePoolIdleTimeoutMs: number;
  databasePoolConnectionTimeoutMs: number;
  enableDbSweep: boolean;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  workflowsEnabled?: boolean;
  /** The public SpaceApp installer (run-spaceapp) runs this API; CLIs there run as an unprivileged user. */
  publicDistribution?: boolean;
  /** Invites and per-user sign-in (plan clipboard:VrMJ14wJPmVs); off until each user gets an isolated CLI container. */
  multiUserEnabled?: boolean;
  enableDummyTurns: boolean;
  enableCodexTurns: boolean;
  agentPaneEnabled: boolean;
  codexLbConfigured: boolean;
  codexLbBaseUrl: string | null;
  codexLbKeyFile: string | null;
  codexLbKeyName: string | null;
  /** Space Gateway base URL (the native account load balancer service). */
  gatewayUrl: string;
  codexAppServerEnabled: boolean;
  codexAppServerCommand: string;
  codexAppServerTransport: string;
  codexAppServerSocketPath: string | null;
  codexAppServerWebsocketUrl: string | null;
  codexAppServerSchemaDir: string | null;
  codexAppServerHome: string | null;
  /** Space Dots Stage 7: the operator's versioned model price list. */
  modelPriceCatalogPath?: string | null;
  codexAppServerKeyFile: string | null;
  codexAppServerKeyEnv: string;
  codexAppServerAllowStdioSpawn: boolean;
  codexAppServerAllowTurnExecution: boolean;
  codexAppServerAllowTurnSmoke: boolean;
  cliEnabled: boolean;
  cliCommandPath: string | null;
  cliWorkspaceRoot: string;
  cliTokenTtlMs: number;
  cliHostSocketPath: string;
  /** Unlimited when null; a dev instance caps its own pane host. */
  cliMaxRunningSessions: number | null;
  cliRootEnabled: boolean;
  cliAdminHostSocketPath: string;
  /** Multi-user: JSON map of user id to that user's pane host socket (cli-user-hosts.ts). */
  cliHostSocketsFile: string | null;
  cliCodexDefaultModel: string | null;
  cliCodexDefaultReasoningEffort: string | null;
  cliRuntimeCommands: Record<CliRuntimeKey, string>;
  cliVpnEnabled: boolean;
  cliVpnLauncherPath: string;
  cliCredentialSmoke: Record<CliRuntimeKey, boolean>;
  cliLoginBootstrap: Record<CliRuntimeKey, boolean>;
  cliMaintenanceRepairEnabled: boolean;
  cliKimiLoginBootstrapEnabled: boolean;
  cliGrokLoginBootstrapEnabled: boolean;
  cliClaudeLoginBootstrapEnabled: boolean;
  cliChatTurnsEnabled: boolean;
  cliChatTurnRuntimeIds: string[];
  mcpServerConfigs?: McpServerConfig[];
  mcpConfigError?: string | null;
  mcpDiscoverySmokeEnabled?: boolean;
  mcpToolExecutionEnabled: boolean;
  mcpToolBridgeEnabled: boolean;
  mcpAllowlistedSchemaHashes: string[];
  mcpToolExecutionTimeoutMs: number;
  memoryEmbeddingSmokeEnabled: boolean;
  memoryEmbeddingProvider: string | null;
  memoryEmbeddingModel: string | null;
  memoryEmbeddingDimensions: number;
  memoryEmbeddingBaseUrl: string;
  memoryEmbeddingKeyFile: string | null;
  /** The Design pane's Space Gateway key (`space-admin-action design-key`): image models only, a daily cost cap. */
  designGatewayKeyFile: string;
  /** The Video pane's engine files (one folder per pane; never /tmp) and its pinned tools (venv, models, auto-editor). */
  videoWorkRoot: string;
  videoToolsDir: string;
  /** The Studio's source upload cap; nginx allows 500 MB. */
  videoSourceMaxBytes: number;
  /** The dedicated key that seals connector tokens and copilot mailbox passwords (hardening plan step 9). */
  connectorKeyFile: string;
  memoryEmbeddingKeyName: string | null;
  memoryEmbeddingTimeoutMs: number;
  memoryGraphEnabled: boolean;
  memoryMaintenanceEnabled: boolean;
  memoryMutationsEnabled: boolean;
  memoryGraphRoot: string;
  voiceTranscriptionEnabled: boolean;
  voiceTranscriptionBaseUrl: string;
  voiceTranscriptionKeyFile: string | null;
  voiceTranscriptionModel: VoiceTranscriptionModel;
  voiceTranscriptionVoice: VoiceModelVoice;
  voiceTranscriptionDelay: "minimal" | "low" | "medium" | "high" | "xhigh";
  voiceTranscriptionTimeoutMs: number;
  voiceTranscriptionMaxDurationMs: number;
  googleVoiceKeyFile: string | null;
  /** Firebase service account key (JSON) for FCM pushes to the Android app; null keeps push off (dev). */
  fcmServiceAccountFile: string | null;
  googleVoiceApiKey: string | null;
  googleVoiceBaseUrl: string;
  awsVoiceKeyFile: string | null;
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
  awsRegion: string;
  localVoiceProviderUrl: string;
  localVoiceProviderToken: string | null;
  vercelVoiceKeyFile: string | null;
  vercelVoiceApiKey: string | null;
  vercelVoiceBaseUrl: string;
  liveModelPolicy: LiveModelPolicy;
  liveJevAccelerationEnabled: boolean;
  spaceMemoryIndexPath: string;
  spaceMemoryMonthlyPath: string;
  spaceMemoryLockPath: string;
  codexGoalsDbPath: string;
  browserEvidenceEnabled: boolean;
  browserEvidenceChromePath: string;
  browserEvidenceArtifactRoot: string;
  browserEvidenceTargetOrigin: string;
  browserEvidenceTimeoutMs: number;
  appDiagnosticsRoot: string;
  maintenanceAutopilotStateFile: string;
  /** Auto (session-level balancing) panes and exhausted CLI accounts; beside the maintenance state by default. */
  cliAccountBalancerStateFile: string;
  browserSessionsEnabled: boolean;
  browserSessionsChromePath: string;
  browserSessionsXvfbPath: string;
  browserSessionsXvfbEnabled: boolean;
  browserSessionsProfileRoot: string;
  jobApplyRoot: string;
  browserSessionsDefaultUrl: string;
  browserSessionsTokenTtlMs: number;
  browserSessionsAudioEnabled: boolean;
  browserSessionsPulseServer: string;
  browserSessionsPulseSink: string;
  browserSessionsYouTubeAdBlockEnabled: boolean;
  browserToolBridgeEnabled: boolean;
  /** Space Dots Stage 3 native tool gateway; SPACE_DOT_TOOL_GATEWAY=disabled is the kill switch. */
  dotToolGatewayEnabled: boolean;
  /** Root of every Dot's private workspace (Stage 4). */
  dotWorkspaceRoot: string;
  browserHostTransport: "in-process" | "unix";
  browserHostSocketPath: string;
  swarmExecutionEnabled: boolean;
  internalApiToken: string | null;
  /** Signs the agents' bridge, Agent Files and control tokens; falls back to the internal token until it is set. */
  agentTokenSecret?: string | null;
  /** Space Gateway's admin credential; falls back to the internal token until both sides set it. */
  gatewayAdminToken?: string | null;
  apiRateLimitMax: number;
  telegramSecretRoot: string;
  streamingSecretRoot: string;
  streamingYoutubeDailyQuotaBudget: number;
  demoProjectsEnabled: boolean;
  demoProjectsRoot: string;
  /** Default parent for named projects created from the UI. */
  projectsRoot: string;
  /** SPACE_FILES_HOST_MODE=disabled turns off file-manager Admin (host) Mode for every role. */
  filesHostModeEnabled: boolean;
  /** Live installation checkout; projects are never created inside it except under projectsRoot. */
  installRoot: string;
  demoProjectsVarRoot: string;
  demoProjectsPortStart: number;
  demoProjectsPortEnd: number;
  demoProjectsHealthTimeoutMs: number;
  demoProjectsPublicOrigin: string | null;
  agentToolsWriterCommand: string | null;
  roomPaneCommandsEnabled: boolean;
  /** Server-side Room Agent monitor of every room's panes (on unless SPACE_ROOM_AGENT_MONITOR_ENABLED=false). */
  roomAgentMonitorEnabled: boolean;
  /** The Room Agent answers its panes' prompts by itself (on unless SPACE_ROOM_AGENT_AUTOPILOT_ENABLED=false). */
  roomAgentAutopilotEnabled: boolean;
  harnessEnabled: boolean;
  harnessOrigin: string;
  /** VNC pane presets from SPACE_VNC_PRESETS (JSON array); none by default, so public installs list no operator hosts. */
  vncPresets: VncPreset[];
  trustedProxies: string[];
  optionalModules: ReadonlySet<OptionalModuleId>;
  harnessHealthTimeoutMs: number;
  harnessProxyTimeoutMs: number;
  /** Managed plan executions: native turns one stage may start before the execution fails (PLAN_STAGE_ATTEMPT_LIMIT). */
  planStageMaxAttempts: number;
}

function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(new Set(raw.split(",").map((value) => value.trim()).filter(Boolean)));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseVoiceTranscriptionDelay(raw: string | undefined): SpaceApiConfig["voiceTranscriptionDelay"] {
  return raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh" ? raw : "minimal";
}

function parseMcpServerConfigs(raw: string | undefined): { configs: McpServerConfig[]; error: string | null } {
  if (!raw) {
    return { configs: [], error: null };
  }
  try {
    const parsed = mcpServerConfigListSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { configs: [], error: "SPACE_MCP_SERVERS_JSON failed schema validation; MCP discovery remains disabled." };
    }
    return { configs: parsed.data, error: null };
  } catch {
    return { configs: [], error: "SPACE_MCP_SERVERS_JSON is not valid JSON; MCP discovery remains disabled." };
  }
}

function parseVoiceTranscriptionModel(raw: string | undefined): VoiceTranscriptionModel {
  const parsed = voiceTranscriptionModelSchema.safeParse(raw);
  return parsed.success ? parsed.data : "gpt-live-1";
}

function parseVoiceTranscriptionVoice(raw: string | undefined): VoiceModelVoice {
  const parsed = voiceModelVoiceSchema.safeParse(raw);
  return parsed.success ? parsed.data : "alloy";
}

/** Space Gateway listens on loopback by default; an override must be a plain http(s) origin. */
function parseGatewayUrl(raw: string | undefined): string {
  const value = raw?.trim() || "http://127.0.0.1:4920";
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("SPACE_GATEWAY_URL must be an http(s) origin.");
  }
  return url.origin;
}

export const optionalModuleIds = [
  "games", "job-copilot", "mail-copilot", "marketing-copilot", "freelance-copilot", "design", "app-studio", "video", "security-copilot", "channels", "telegram", "waitlist", "desktop-updates"
] as const;
export type OptionalModuleId = (typeof optionalModuleIds)[number];

// Modules beyond the coding workspace. Public installs start with none of them (review F14,
// operator decision 2026-10-14); SPACE_OPTIONAL_MODULES=all, none or a comma list overrides.
export function parseOptionalModules(raw: string | undefined, publicDistribution: boolean): ReadonlySet<OptionalModuleId> {
  const value = raw?.trim().toLowerCase() || (publicDistribution ? "none" : "all");
  if (value === "all") return new Set(optionalModuleIds);
  if (value === "none") return new Set();
  return new Set(optionalModuleIds.filter((id) => value.split(",").map((part) => part.trim()).includes(id)));
}

export function getApiConfig(env: NodeJS.ProcessEnv): SpaceApiConfig {
  // Variables in the T3 Env schema are read only from its normalized result.
  const valid = validateT3ApiEnv(env);
  const runtimeStore = valid.SPACE_RUNTIME_STORE;
  const mcpConfig = parseMcpServerConfigs(env.SPACE_MCP_SERVERS_JSON);
  const artifactRoot = env.SPACE_ARTIFACT_ROOT || "/opt/spaceapp/var/artifacts";
  const spaceMemoryPaths = resolveCanonicalSpaceMemoryPaths(env);
  return {
    t3CodeEnabled: valid.SPACE_T3CODE_ENABLED !== "false",
    t3CodeSocketPath: valid.SPACE_T3CODE_SOCKET,
    t3CodeProxyTimeoutMs: valid.SPACE_T3CODE_PROXY_TIMEOUT_MS,
    t3CodeHealthTimeoutMs: valid.SPACE_T3CODE_HEALTH_TIMEOUT_MS,
    instance: valid.SPACE_INSTANCE,
    instanceJobs: Object.fromEntries(instanceBackgroundJobs.map((job) => [job, instanceBackgroundJobEnabled(
      { SPACE_INSTANCE: valid.SPACE_INSTANCE, SPACE_INSTANCE_ENABLED_JOBS: env.SPACE_INSTANCE_ENABLED_JOBS }, job)])) as Record<InstanceBackgroundJob, boolean>,
    host: valid.SPACE_API_HOST,
    port: valid.SPACE_API_PORT,
    version: apiPackageVersion,
    runtimeStore,
    databaseUrl: valid.SPACE_DATABASE_URL ?? null,
    databasePoolMax: Math.min(valid.SPACE_DATABASE_POOL_MAX ?? 10, 100),
    databasePoolIdleTimeoutMs: Math.min(valid.SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS ?? 30000, 300000),
    databasePoolConnectionTimeoutMs: Math.min(valid.SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS ?? 5000, 30000),
    enableDbSweep: valid.SPACE_ENABLE_DB_SWEEP !== "false" && valid.SPACE_ENABLE_DB_SWEEP !== "0",
    temporalAddress: valid.SPACE_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    temporalNamespace: valid.SPACE_TEMPORAL_NAMESPACE ?? "default",
    temporalTaskQueue: valid.SPACE_TEMPORAL_TASK_QUEUE ?? "space-agent-turns",
    // Only the public small profile turns workflows off; private installations always require the worker.
    workflowsEnabled: !(env.SPACE_PUBLIC_DISTRIBUTION === "true" && env.SPACEAPP_WORKFLOWS_ENABLED === "false"),
    publicDistribution: env.SPACE_PUBLIC_DISTRIBUTION === "true",
    multiUserEnabled: env.SPACE_MULTI_USER_ENABLED === "true",
    enableDummyTurns: valid.SPACE_ENABLE_DUMMY_TURNS === "true",
    enableCodexTurns: valid.SPACE_ENABLE_CODEX_TURNS === "true",
    agentPaneEnabled: valid.SPACE_AGENT_PANE_ENABLED === "true",
    // Space Gateway's OpenAI-compatible endpoint and Space's key for it; SPACE_CODEX_LB_* are the names from
    // before codex-lb was retired and still work.
    codexLbConfigured: Boolean((env.SPACE_GATEWAY_BASE_URL || env.SPACE_CODEX_LB_BASE_URL) && (env.SPACE_GATEWAY_KEY_FILE || env.SPACE_CODEX_LB_KEY_FILE)),
    codexLbBaseUrl: env.SPACE_GATEWAY_BASE_URL || env.SPACE_CODEX_LB_BASE_URL || null,
    codexLbKeyFile: env.SPACE_GATEWAY_KEY_FILE || env.SPACE_CODEX_LB_KEY_FILE || null,
    codexLbKeyName: env.SPACE_GATEWAY_KEY_NAME || env.SPACE_CODEX_LB_KEY_NAME || null,
    gatewayUrl: parseGatewayUrl(env.SPACE_GATEWAY_URL),
    codexAppServerEnabled: env.SPACE_CODEX_APP_SERVER_ENABLED === "true",
    codexAppServerCommand: env.SPACE_CODEX_APP_SERVER_COMMAND || "/opt/spaceapp/bin/codex-vscode-parity",
    codexAppServerTransport: env.SPACE_CODEX_APP_SERVER_TRANSPORT || "stdio",
    codexAppServerSocketPath: env.SPACE_CODEX_APP_SERVER_SOCKET || null,
    codexAppServerWebsocketUrl: env.SPACE_CODEX_APP_SERVER_WEBSOCKET_URL || null,
    codexAppServerSchemaDir: env.SPACE_CODEX_APP_SERVER_SCHEMA_DIR || null,
    codexAppServerHome: env.SPACE_CODEX_APP_SERVER_HOME || "/var/lib/spaceapp-user/.codex",
    modelPriceCatalogPath: env.SPACE_MODEL_PRICE_CATALOG || null,
    codexAppServerKeyFile: env.SPACE_CODEX_APP_SERVER_KEY_FILE || null,
    codexAppServerKeyEnv: env.SPACE_CODEX_APP_SERVER_KEY_ENV || "OPENAI_API_KEY",
    codexAppServerAllowStdioSpawn: env.SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN === "true",
    codexAppServerAllowTurnExecution: env.SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION === "true",
    codexAppServerAllowTurnSmoke: env.SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE === "true",
    cliEnabled: valid.SPACE_CLI_ENABLED === "true",
    cliCommandPath: valid.SPACE_CLI_COMMAND_PATH ?? null,
    cliWorkspaceRoot: valid.SPACE_CLI_WORKSPACE_ROOT ?? join(artifactRoot, "cli-workspaces"),
    cliTokenTtlMs: Math.min(valid.SPACE_CLI_TOKEN_TTL_MS ?? 60000, 5 * 60 * 1000),
    cliHostSocketPath: valid.SPACE_CLI_HOST_SOCKET ?? "/run/space-codex-pane-host/pane-host.sock",
    cliMaxRunningSessions: valid.SPACE_CLI_MAX_RUNNING_SESSIONS ?? null,
    cliRootEnabled: valid.SPACE_CLI_ROOT_ENABLED === "true",
    cliAdminHostSocketPath: valid.SPACE_CLI_ADMIN_HOST_SOCKET ?? "/run/space-admin-pane-host/pane-host.sock",
    cliHostSocketsFile: env.SPACE_CLI_HOST_SOCKETS_FILE || null,
    cliCodexDefaultModel: env.SPACE_CLI_CODEX_DEFAULT_MODEL || null,
    cliCodexDefaultReasoningEffort: env.SPACE_CLI_CODEX_DEFAULT_REASONING_EFFORT || null,
    cliRuntimeCommands: configuredCliRuntimeCommands(env),
    cliVpnEnabled: valid.SPACE_CLI_VPN_ENABLED === "true",
    cliVpnLauncherPath: env.SPACE_CLI_VPN_LAUNCHER || "/opt/spaceapp/bin/space-cli-vpn-launcher",
    cliCredentialSmoke: configuredCliCredentialSmoke(env),
    cliLoginBootstrap: configuredCliLoginBootstrap(env),
    cliMaintenanceRepairEnabled: valid.SPACE_CLI_MAINTENANCE_REPAIR_ENABLED === "true",
    cliKimiLoginBootstrapEnabled: env.SPACE_CLI_KIMI_LOGIN_BOOTSTRAP === "true",
    cliGrokLoginBootstrapEnabled: env.SPACE_CLI_GROK_LOGIN_BOOTSTRAP === "true",
    cliClaudeLoginBootstrapEnabled: env.SPACE_CLI_CLAUDE_LOGIN_BOOTSTRAP === "true",
    cliChatTurnsEnabled: env.SPACE_ENABLE_CLI_CHAT_TURNS === "true",
    cliChatTurnRuntimeIds: parseCsvList(
      env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS ?? cliChatTurnDefaultRuntimeIds.join(",")
    ),
    mcpServerConfigs: mcpConfig.configs,
    mcpConfigError: mcpConfig.error,
    mcpDiscoverySmokeEnabled: env.SPACE_MCP_DISCOVERY_SMOKE_ENABLED === "true",
    mcpToolExecutionEnabled: env.SPACE_MCP_TOOL_EXECUTION_ENABLED === "true",
    mcpToolBridgeEnabled: env.SPACE_MCP_TOOL_BRIDGE_ENABLED === "true",
    mcpAllowlistedSchemaHashes: parseCsvList(env.SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES),
    mcpToolExecutionTimeoutMs: Number.parseInt(env.SPACE_MCP_TOOL_EXECUTION_TIMEOUT_MS ?? "10000", 10),
    memoryEmbeddingSmokeEnabled: env.SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED === "true",
    memoryEmbeddingProvider: env.SPACE_MEMORY_EMBEDDING_PROVIDER || null,
    // Space Gateway's default is the local bge-m3 (on this server's CPU: no key, nothing leaves it; plan clipboard:o7SATwaOHqca).
    // .env.example's text-embedding-3-small reads as that default there, so the switch needs no .env edit; other models override.
    // shortcut: text-embedding-3-small through Space Gateway cannot be picked in .env any more; add an explicit override if wanted.
    memoryEmbeddingModel: env.SPACE_MEMORY_EMBEDDING_PROVIDER === "codex-lb" && [undefined, "", "text-embedding-3-small"].includes(env.SPACE_MEMORY_EMBEDDING_MODEL)
      ? "bge-m3" : env.SPACE_MEMORY_EMBEDDING_MODEL || null,
    memoryEmbeddingDimensions: Math.min(parsePositiveInt(env.SPACE_MEMORY_EMBEDDING_DIMENSIONS, 1536), 4096),
    memoryEmbeddingBaseUrl: env.SPACE_MEMORY_EMBEDDING_BASE_URL || "https://api.openai.com/v1",
    memoryEmbeddingKeyFile: env.SPACE_MEMORY_EMBEDDING_KEY_FILE || null,
    designGatewayKeyFile: env.SPACE_DESIGN_GATEWAY_KEY_FILE || "/opt/spaceapp/secrets/space-design.key",
    // Next to the artifact root (stable /opt/spaceapp/var/video, dev /opt/spaceapp-dev/var/video): the dev API may write only under its own var.
    videoWorkRoot: env.SPACE_VIDEO_WORK_ROOT || join(dirname(artifactRoot), "video"),
    videoToolsDir: env.SPACE_VIDEO_TOOLS_DIR || "/opt/spaceapp/var/models/video",
    videoSourceMaxBytes: Number.parseInt(env.SPACE_VIDEO_SOURCE_MAX_BYTES || "", 10) || 480 * 1024 * 1024,
    // Dev never reads stable's key: it has its own under its var directory.
    connectorKeyFile: env.SPACE_CONNECTOR_KEY_FILE || (env.SPACE_INSTANCE === "dev" ? "/opt/spaceapp-dev/var/connector/space-connector.key" : "/opt/spaceapp/secrets/space-connector.key"),
    memoryEmbeddingKeyName: env.SPACE_MEMORY_EMBEDDING_KEY_NAME || null,
    memoryEmbeddingTimeoutMs: Math.min(parsePositiveInt(env.SPACE_MEMORY_EMBEDDING_TIMEOUT_MS, 10000), 30000),
    memoryGraphEnabled: env.SPACE_MEMORY_GRAPH_ENABLED === "true",
    memoryMaintenanceEnabled: env.SPACE_MEMORY_MAINTENANCE_ENABLED === "true",
    memoryMutationsEnabled: env.SPACE_MEMORY_MUTATIONS_ENABLED === "true",
    memoryGraphRoot: env.SPACE_MEMORY_GRAPH_ROOT || "/opt/spaceapp/var/memory-graph",
    voiceTranscriptionEnabled: env.SPACE_VOICE_TRANSCRIPTION_ENABLED === "true",
    voiceTranscriptionBaseUrl: env.SPACE_VOICE_TRANSCRIPTION_BASE_URL || "https://api.openai.com/v1",
    voiceTranscriptionKeyFile: env.SPACE_VOICE_TRANSCRIPTION_KEY_FILE || null,
    voiceTranscriptionModel: parseVoiceTranscriptionModel(env.SPACE_VOICE_TRANSCRIPTION_MODEL),
    voiceTranscriptionVoice: parseVoiceTranscriptionVoice(env.SPACE_VOICE_NAME),
    voiceTranscriptionDelay: parseVoiceTranscriptionDelay(env.SPACE_VOICE_TRANSCRIPTION_DELAY),
    voiceTranscriptionTimeoutMs: Math.min(parsePositiveInt(env.SPACE_VOICE_TRANSCRIPTION_TIMEOUT_MS, 15000), 60000),
    voiceTranscriptionMaxDurationMs: Math.min(parsePositiveInt(env.SPACE_VOICE_TRANSCRIPTION_MAX_DURATION_MS, 60000), 5 * 60 * 1000),
    googleVoiceKeyFile: env.SPACE_GOOGLE_VOICE_KEY_FILE || env.SPACE_GEMINI_VOICE_KEY_FILE || null,
    fcmServiceAccountFile: env.SPACE_FCM_SERVICE_ACCOUNT_FILE || null,
    googleVoiceApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null,
    googleVoiceBaseUrl: env.SPACE_GOOGLE_VOICE_BASE_URL || "https://generativelanguage.googleapis.com",
    awsVoiceKeyFile: env.SPACE_AWS_VOICE_KEY_FILE || null,
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID || null,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY || null,
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
    localVoiceProviderUrl: env.SPACE_LOCAL_VOICE_PROVIDER_URL || "http://192.168.10.213:8765",
    localVoiceProviderToken: env.SPACE_LOCAL_VOICE_PROVIDER_TOKEN || null,
    vercelVoiceKeyFile: env.SPACE_VERCEL_VOICE_KEY_FILE || env.SPACE_VERCEL_AI_GATEWAY_KEY_FILE || null,
    vercelVoiceApiKey: env.AI_GATEWAY_API_KEY || env.VERCEL_AI_GATEWAY_API_KEY || null,
    vercelVoiceBaseUrl: env.SPACE_VERCEL_VOICE_BASE_URL || "https://ai-gateway.vercel.sh",
    liveModelPolicy: parseLiveModelPolicy(env.SPACE_LIVE_MODEL_POLICY_JSON, env.SPACE_LIVE_DAILY_BUDGET_USD, env.SPACE_LIVE_COST_MODE),
    liveJevAccelerationEnabled: env.SPACE_LIVE_JEV_ACCELERATION_ENABLED === "true",
    spaceMemoryIndexPath: spaceMemoryPaths.indexPath,
    spaceMemoryMonthlyPath: spaceMemoryPaths.monthlyPath,
    spaceMemoryLockPath: spaceMemoryPaths.lockPath,
    codexGoalsDbPath: env.SPACE_CODEX_GOALS_DB_PATH || "/var/lib/spaceapp-user/.codex/goals_1.sqlite",
    browserEvidenceEnabled: env.SPACE_BROWSER_EVIDENCE_ENABLED !== "false",
    browserEvidenceChromePath: env.SPACE_BROWSER_CHROME_PATH || "/usr/bin/google-chrome",
    browserEvidenceArtifactRoot: artifactRoot,
    browserEvidenceTargetOrigin: env.SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN || "http://127.0.0.1:4911",
    browserEvidenceTimeoutMs: Number.parseInt(env.SPACE_BROWSER_EVIDENCE_TIMEOUT_MS ?? "20000", 10),
    appDiagnosticsRoot: env.SPACE_APP_DIAGNOSTICS_ROOT || "/opt/spaceapp/var/app-diagnostics",
    maintenanceAutopilotStateFile: env.SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE || "/opt/spaceapp/var/maintenance-autopilot/state.json",
    cliAccountBalancerStateFile: env.SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE
      || join(dirname(dirname(env.SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE || "/opt/spaceapp/var/maintenance-autopilot/state.json")), "cli-account-balancer", "state.json"),
    browserSessionsEnabled: env.SPACE_BROWSER_SESSIONS_ENABLED === "true",
    browserSessionsChromePath: env.SPACE_BROWSER_SESSIONS_CHROME_PATH || env.SPACE_BROWSER_CHROME_PATH || "/usr/bin/google-chrome",
    browserSessionsXvfbPath: env.SPACE_BROWSER_SESSIONS_XVFB_PATH || "/usr/bin/Xvfb",
    browserSessionsXvfbEnabled: env.SPACE_BROWSER_SESSIONS_XVFB_ENABLED !== "false",
    browserSessionsProfileRoot: env.SPACE_BROWSER_SESSIONS_PROFILE_ROOT || join(artifactRoot, "browser-profiles"),
    jobApplyRoot: env.SPACE_JOB_APPLY_ROOT || join(artifactRoot, "job-apply"),
    browserSessionsDefaultUrl: env.SPACE_BROWSER_SESSIONS_DEFAULT_URL || "https://www.google.com/",
    browserSessionsTokenTtlMs: Math.min(parsePositiveInt(env.SPACE_BROWSER_SESSIONS_TOKEN_TTL_MS, 60000), 5 * 60 * 1000),
    browserSessionsAudioEnabled: env.SPACE_BROWSER_SESSIONS_AUDIO_ENABLED !== "false",
    browserSessionsPulseServer: env.SPACE_BROWSER_SESSIONS_PULSE_SERVER || "unix:/run/pulse/native",
    browserSessionsPulseSink: env.SPACE_BROWSER_SESSIONS_PULSE_SINK || "space_audio",
    browserSessionsYouTubeAdBlockEnabled: env.SPACE_BROWSER_SESSIONS_YOUTUBE_AD_BLOCK_ENABLED !== "false",
    browserToolBridgeEnabled: env.SPACE_BROWSER_TOOL_BRIDGE_ENABLED === "true",
    dotToolGatewayEnabled: env.SPACE_DOT_TOOL_GATEWAY !== "disabled",
    dotWorkspaceRoot: env.SPACE_DOT_WORKSPACE_ROOT?.startsWith("/") ? env.SPACE_DOT_WORKSPACE_ROOT : DOT_WORKSPACE_ROOT,
    browserHostTransport: env.SPACE_BROWSER_HOST_TRANSPORT === "unix" ? "unix" : "in-process",
    browserHostSocketPath: env.SPACE_BROWSER_HOST_SOCKET || "/run/space-browser-host/browser-host.sock",
    swarmExecutionEnabled: env.SPACE_SWARM_EXECUTION_ENABLED === "true",
    internalApiToken: env.SPACE_INTERNAL_API_TOKEN || null,
    // One secret per purpose (security addendum step 9); unset, each falls back to the internal token, so nothing changes.
    agentTokenSecret: env.SPACE_AGENT_TOKEN_SECRET || null,
    gatewayAdminToken: env.SPACE_GATEWAY_ADMIN_TOKEN || null,
    apiRateLimitMax: Math.min(parsePositiveInt(env.SPACE_API_RATE_LIMIT_MAX, 3000), 20000),
    telegramSecretRoot: env.SPACE_TELEGRAM_SECRET_ROOT || "/opt/spaceapp/secrets/telegram",
    streamingSecretRoot: env.SPACE_STREAMING_SECRET_ROOT || "/opt/spaceapp/var/streaming-secrets",
    streamingYoutubeDailyQuotaBudget: Math.min(parsePositiveInt(env.SPACE_STREAMING_YOUTUBE_DAILY_QUOTA_BUDGET, 8000), 10000),
    demoProjectsEnabled: valid.SPACE_DEMO_PROJECTS_ENABLED !== "false",
    demoProjectsRoot: valid.SPACE_DEMO_PROJECTS_ROOT ?? "/opt/spaceapp/demos",
    projectsRoot: valid.SPACE_PROJECTS_ROOT ?? "/opt/spaceapp/projects",
    filesHostModeEnabled: valid.SPACE_FILES_HOST_MODE !== "disabled",
    installRoot: valid.SPACE_INSTALL_ROOT ?? "/opt/spaceapp",
    demoProjectsVarRoot: valid.SPACE_DEMO_PROJECTS_VAR_ROOT ?? "/opt/spaceapp/var/demo-projects",
    demoProjectsPortStart: Math.min(valid.SPACE_DEMO_PROJECTS_PORT_START ?? 4930, 65000),
    demoProjectsPortEnd: Math.min(valid.SPACE_DEMO_PROJECTS_PORT_END ?? 4999, 65500),
    demoProjectsHealthTimeoutMs: Math.min(valid.SPACE_DEMO_PROJECTS_HEALTH_TIMEOUT_MS ?? 15000, 60000),
    demoProjectsPublicOrigin: valid.SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN ?? null,
    agentToolsWriterCommand:
      env.SPACE_PUBLIC_DISTRIBUTION === "true" ||
      env.SPACE_AGENT_TOOLS_WRITER === "disabled" ||
      env.SPACE_AGENT_TOOLS_WRITER === "none"
        ? null
        : (env.SPACE_AGENT_TOOLS_WRITER || (existsSync("/opt/spaceapp/bin/space-agent-tools-writer") ? "/opt/spaceapp/bin/space-agent-tools-writer" : null)),
    roomAgentMonitorEnabled: env.SPACE_ROOM_AGENT_MONITOR_ENABLED !== "false",
    roomAgentAutopilotEnabled: env.SPACE_ROOM_AGENT_AUTOPILOT_ENABLED !== "false",
    roomPaneCommandsEnabled: env.SPACE_ROOM_PANE_COMMANDS_ENABLED === "true",
    // No default upstream address (review F11): without SPACE_HARNESS_ORIGIN the harness stays off.
    harnessEnabled: env.SPACE_HARNESS_ENABLED === "true" && Boolean(env.SPACE_HARNESS_ORIGIN),
    harnessOrigin: env.SPACE_HARNESS_ORIGIN || "",
    vncPresets: env.SPACE_VNC_PRESETS?.trim() ? vncPresetSchema.array().max(32).parse(JSON.parse(env.SPACE_VNC_PRESETS)) : [],
    trustedProxies: (env.SPACE_TRUSTED_PROXIES ?? "").split(",").map((address) => address.trim()).filter(Boolean),
    optionalModules: parseOptionalModules(env.SPACE_OPTIONAL_MODULES, env.SPACE_PUBLIC_DISTRIBUTION === "true"),
    harnessHealthTimeoutMs: Math.min(parsePositiveInt(env.SPACE_HARNESS_HEALTH_TIMEOUT_MS, 3000), 15000),
    harnessProxyTimeoutMs: Math.min(parsePositiveInt(env.SPACE_HARNESS_PROXY_TIMEOUT_MS, 30000), 120000),
    planStageMaxAttempts: valid.SPACE_PLAN_STAGE_MAX_ATTEMPTS ?? 20
  };
}
