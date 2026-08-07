import { join } from "node:path";
import { mcpServerConfigListSchema, type McpServerConfig } from "@space/contracts";
import { resolveCanonicalGeminiMemoryPaths } from "@space/runtime";
import {
  configuredCliCredentialSmoke,
  configuredCliLoginBootstrap,
  configuredCliRuntimeCommands,
  type CliRuntimeKey
} from "./cli-runtime-descriptors.js";

export interface SpaceApiConfig {
  host: string;
  port: number;
  version: string;
  runtimeStore: "memory" | "postgres";
  databaseUrl: string | null;
  databasePoolMax: number;
  databasePoolIdleTimeoutMs: number;
  databasePoolConnectionTimeoutMs: number;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  enableDummyTurns: boolean;
  enableCodexTurns: boolean;
  agentPaneEnabled: boolean;
  codexLbConfigured: boolean;
  codexLbBaseUrl: string | null;
  codexLbKeyFile: string | null;
  codexLbKeyName: string | null;
  codexAppServerEnabled: boolean;
  codexAppServerCommand: string;
  codexAppServerTransport: string;
  codexAppServerSocketPath: string | null;
  codexAppServerWebsocketUrl: string | null;
  codexAppServerSchemaDir: string | null;
  codexAppServerHome: string | null;
  codexAppServerKeyFile: string | null;
  codexAppServerKeyEnv: string;
  codexAppServerAllowStdioSpawn: boolean;
  codexAppServerAllowTurnExecution: boolean;
  codexAppServerAllowTurnSmoke: boolean;
  codexRouteCommand: string;
  codexRouteSwitchEnabled: boolean;
  cliEnabled: boolean;
  cliCommandPath: string | null;
  cliWorkspaceRoot: string;
  cliTokenTtlMs: number;
  cliHostSocketPath: string;
  cliRootEnabled: boolean;
  cliAdminHostSocketPath: string;
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
  memoryEmbeddingKeyName: string | null;
  memoryEmbeddingTimeoutMs: number;
  memoryGraphEnabled: boolean;
  memoryMaintenanceEnabled: boolean;
  memoryMutationsEnabled: boolean;
  memoryGraphRoot: string;
  voiceTranscriptionEnabled: boolean;
  voiceTranscriptionBaseUrl: string;
  voiceTranscriptionKeyFile: string | null;
  voiceTranscriptionModel: "gpt-realtime-whisper" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1";
  voiceTranscriptionDelay: "minimal" | "low" | "medium" | "high" | "xhigh";
  voiceTranscriptionTimeoutMs: number;
  voiceTranscriptionMaxDurationMs: number;
  geminiMemoryIndexPath: string;
  geminiMemoryMonthlyPath: string;
  geminiMemoryLockPath: string;
  codexGoalsDbPath: string;
  browserEvidenceEnabled: boolean;
  browserEvidenceChromePath: string;
  browserEvidenceArtifactRoot: string;
  browserEvidenceTargetOrigin: string;
  browserEvidenceTimeoutMs: number;
  appDiagnosticsRoot: string;
  browserSessionsEnabled: boolean;
  browserSessionsChromePath: string;
  browserSessionsXvfbPath: string;
  browserSessionsXvfbEnabled: boolean;
  browserSessionsProfileRoot: string;
  browserSessionsDefaultUrl: string;
  browserSessionsTokenTtlMs: number;
  browserSessionsAudioEnabled: boolean;
  browserSessionsPulseServer: string;
  browserSessionsPulseSink: string;
  browserToolBridgeEnabled: boolean;
  browserHostTransport: "in-process" | "unix";
  browserHostSocketPath: string;
  swarmExecutionEnabled: boolean;
  internalApiToken: string | null;
  apiRateLimitMax: number;
  telegramSecretRoot: string;
  agentToolsWriterCommand: string | null;
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

function parseVoiceTranscriptionModel(raw: string | undefined): SpaceApiConfig["voiceTranscriptionModel"] {
  if (raw === "gpt-4o-transcribe" || raw === "gpt-4o-mini-transcribe" || raw === "whisper-1") return raw;
  return "gpt-realtime-whisper";
}

export function getApiConfig(env: NodeJS.ProcessEnv): SpaceApiConfig {
  const runtimeStore = env.SPACE_RUNTIME_STORE === "postgres" ? "postgres" : "memory";
  const mcpConfig = parseMcpServerConfigs(env.SPACE_MCP_SERVERS_JSON);
  const artifactRoot = env.SPACE_ARTIFACT_ROOT || "/opt/spaceapp/var/artifacts";
  const geminiMemoryPaths = resolveCanonicalGeminiMemoryPaths(env);
  return {
    host: env.SPACE_API_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.SPACE_API_PORT ?? "4910", 10),
    version: env.npm_package_version ?? "0.1.0",
    runtimeStore,
    databaseUrl: env.SPACE_DATABASE_URL ?? null,
    databasePoolMax: Math.min(parsePositiveInt(env.SPACE_DATABASE_POOL_MAX, 10), 100),
    databasePoolIdleTimeoutMs: Math.min(parsePositiveInt(env.SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS, 30000), 300000),
    databasePoolConnectionTimeoutMs: Math.min(
      parsePositiveInt(env.SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS, 5000),
      30000
    ),
    temporalAddress: env.SPACE_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    temporalNamespace: env.SPACE_TEMPORAL_NAMESPACE ?? "default",
    temporalTaskQueue: env.SPACE_TEMPORAL_TASK_QUEUE ?? "space-agent-turns",
    enableDummyTurns: env.SPACE_ENABLE_DUMMY_TURNS === "true",
    enableCodexTurns: env.SPACE_ENABLE_CODEX_TURNS === "true",
    agentPaneEnabled: env.SPACE_AGENT_PANE_ENABLED === "true",
    codexLbConfigured: Boolean(env.SPACE_CODEX_LB_BASE_URL && env.SPACE_CODEX_LB_KEY_FILE),
    codexLbBaseUrl: env.SPACE_CODEX_LB_BASE_URL || null,
    codexLbKeyFile: env.SPACE_CODEX_LB_KEY_FILE || null,
    codexLbKeyName: env.SPACE_CODEX_LB_KEY_NAME || null,
    codexAppServerEnabled: env.SPACE_CODEX_APP_SERVER_ENABLED === "true",
    codexAppServerCommand: env.SPACE_CODEX_APP_SERVER_COMMAND || "/opt/spaceapp/bin/codex-vscode-parity",
    codexAppServerTransport: env.SPACE_CODEX_APP_SERVER_TRANSPORT || "stdio",
    codexAppServerSocketPath: env.SPACE_CODEX_APP_SERVER_SOCKET || null,
    codexAppServerWebsocketUrl: env.SPACE_CODEX_APP_SERVER_WEBSOCKET_URL || null,
    codexAppServerSchemaDir: env.SPACE_CODEX_APP_SERVER_SCHEMA_DIR || null,
    codexAppServerHome: env.SPACE_CODEX_APP_SERVER_HOME || "/var/lib/spaceapp-user/.codex",
    codexAppServerKeyFile: env.SPACE_CODEX_APP_SERVER_KEY_FILE || null,
    codexAppServerKeyEnv: env.SPACE_CODEX_APP_SERVER_KEY_ENV || "OPENAI_API_KEY",
    codexAppServerAllowStdioSpawn: env.SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN === "true",
    codexAppServerAllowTurnExecution: env.SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION === "true",
    codexAppServerAllowTurnSmoke: env.SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE === "true",
    codexRouteCommand: env.SPACE_CODEX_ROUTE_COMMAND || "/opt/spaceapp/bin/codex-vscode-parity",
    codexRouteSwitchEnabled: env.SPACE_CODEX_ROUTE_SWITCH_ENABLED === "true",
    cliEnabled: env.SPACE_CLI_ENABLED === "true",
    cliCommandPath: env.SPACE_CLI_COMMAND_PATH || null,
    cliWorkspaceRoot: env.SPACE_CLI_WORKSPACE_ROOT || join(artifactRoot, "cli-workspaces"),
    cliTokenTtlMs: Math.min(parsePositiveInt(env.SPACE_CLI_TOKEN_TTL_MS, 60000), 5 * 60 * 1000),
    cliHostSocketPath: env.SPACE_CLI_HOST_SOCKET || "/run/space-codex-pane-host/pane-host.sock",
    cliRootEnabled: env.SPACE_CLI_ROOT_ENABLED === "true",
    cliAdminHostSocketPath: env.SPACE_CLI_ADMIN_HOST_SOCKET || "/run/space-admin-pane-host/pane-host.sock",
    cliCodexDefaultModel: env.SPACE_CLI_CODEX_DEFAULT_MODEL || null,
    cliCodexDefaultReasoningEffort: env.SPACE_CLI_CODEX_DEFAULT_REASONING_EFFORT || null,
    cliRuntimeCommands: configuredCliRuntimeCommands(env),
    cliVpnEnabled: env.SPACE_CLI_VPN_ENABLED === "true",
    cliVpnLauncherPath: env.SPACE_CLI_VPN_LAUNCHER || "/opt/spaceapp/bin/space-cli-vpn-launcher",
    cliCredentialSmoke: configuredCliCredentialSmoke(env),
    cliLoginBootstrap: configuredCliLoginBootstrap(env),
    cliMaintenanceRepairEnabled: env.SPACE_CLI_MAINTENANCE_REPAIR_ENABLED === "true",
    cliKimiLoginBootstrapEnabled: env.SPACE_CLI_KIMI_LOGIN_BOOTSTRAP === "true",
    cliGrokLoginBootstrapEnabled: env.SPACE_CLI_GROK_LOGIN_BOOTSTRAP === "true",
    mcpServerConfigs: mcpConfig.configs,
    mcpConfigError: mcpConfig.error,
    mcpDiscoverySmokeEnabled: env.SPACE_MCP_DISCOVERY_SMOKE_ENABLED === "true",
    mcpToolExecutionEnabled: env.SPACE_MCP_TOOL_EXECUTION_ENABLED === "true",
    mcpToolBridgeEnabled: env.SPACE_MCP_TOOL_BRIDGE_ENABLED === "true",
    mcpAllowlistedSchemaHashes: parseCsvList(env.SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES),
    mcpToolExecutionTimeoutMs: Number.parseInt(env.SPACE_MCP_TOOL_EXECUTION_TIMEOUT_MS ?? "10000", 10),
    memoryEmbeddingSmokeEnabled: env.SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED === "true",
    memoryEmbeddingProvider: env.SPACE_MEMORY_EMBEDDING_PROVIDER || null,
    memoryEmbeddingModel: env.SPACE_MEMORY_EMBEDDING_MODEL || null,
    memoryEmbeddingDimensions: Math.min(parsePositiveInt(env.SPACE_MEMORY_EMBEDDING_DIMENSIONS, 1536), 4096),
    memoryEmbeddingBaseUrl: env.SPACE_MEMORY_EMBEDDING_BASE_URL || "https://api.openai.com/v1",
    memoryEmbeddingKeyFile: env.SPACE_MEMORY_EMBEDDING_KEY_FILE || null,
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
    voiceTranscriptionDelay: parseVoiceTranscriptionDelay(env.SPACE_VOICE_TRANSCRIPTION_DELAY),
    voiceTranscriptionTimeoutMs: Math.min(parsePositiveInt(env.SPACE_VOICE_TRANSCRIPTION_TIMEOUT_MS, 15000), 60000),
    voiceTranscriptionMaxDurationMs: Math.min(parsePositiveInt(env.SPACE_VOICE_TRANSCRIPTION_MAX_DURATION_MS, 60000), 5 * 60 * 1000),
    geminiMemoryIndexPath: geminiMemoryPaths.indexPath,
    geminiMemoryMonthlyPath: geminiMemoryPaths.monthlyPath,
    geminiMemoryLockPath: geminiMemoryPaths.lockPath,
    codexGoalsDbPath: env.SPACE_CODEX_GOALS_DB_PATH || "/var/lib/spaceapp-user/.codex/goals_1.sqlite",
    browserEvidenceEnabled: env.SPACE_BROWSER_EVIDENCE_ENABLED !== "false",
    browserEvidenceChromePath: env.SPACE_BROWSER_CHROME_PATH || "/usr/bin/google-chrome",
    browserEvidenceArtifactRoot: artifactRoot,
    browserEvidenceTargetOrigin: env.SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN || "http://127.0.0.1:4911",
    browserEvidenceTimeoutMs: Number.parseInt(env.SPACE_BROWSER_EVIDENCE_TIMEOUT_MS ?? "20000", 10),
    appDiagnosticsRoot: env.SPACE_APP_DIAGNOSTICS_ROOT || "/opt/spaceapp/var/app-diagnostics",
    browserSessionsEnabled: env.SPACE_BROWSER_SESSIONS_ENABLED === "true",
    browserSessionsChromePath: env.SPACE_BROWSER_SESSIONS_CHROME_PATH || env.SPACE_BROWSER_CHROME_PATH || "/usr/bin/google-chrome",
    browserSessionsXvfbPath: env.SPACE_BROWSER_SESSIONS_XVFB_PATH || "/usr/bin/Xvfb",
    browserSessionsXvfbEnabled: env.SPACE_BROWSER_SESSIONS_XVFB_ENABLED !== "false",
    browserSessionsProfileRoot: env.SPACE_BROWSER_SESSIONS_PROFILE_ROOT || join(artifactRoot, "browser-profiles"),
    browserSessionsDefaultUrl: env.SPACE_BROWSER_SESSIONS_DEFAULT_URL || "https://www.example.invalid/",
    browserSessionsTokenTtlMs: Math.min(parsePositiveInt(env.SPACE_BROWSER_SESSIONS_TOKEN_TTL_MS, 60000), 5 * 60 * 1000),
    browserSessionsAudioEnabled: env.SPACE_BROWSER_SESSIONS_AUDIO_ENABLED !== "false",
    browserSessionsPulseServer: env.SPACE_BROWSER_SESSIONS_PULSE_SERVER || "unix:/run/pulse/native",
    browserSessionsPulseSink: env.SPACE_BROWSER_SESSIONS_PULSE_SINK || "space_audio",
    browserToolBridgeEnabled: env.SPACE_BROWSER_TOOL_BRIDGE_ENABLED === "true",
    browserHostTransport: env.SPACE_BROWSER_HOST_TRANSPORT === "unix" ? "unix" : "in-process",
    browserHostSocketPath: env.SPACE_BROWSER_HOST_SOCKET || "/run/space-browser-host/browser-host.sock",
    swarmExecutionEnabled: env.SPACE_SWARM_EXECUTION_ENABLED === "true",
    internalApiToken: env.SPACE_INTERNAL_API_TOKEN || null,
    apiRateLimitMax: Math.min(parsePositiveInt(env.SPACE_API_RATE_LIMIT_MAX, 3000), 20000),
    telegramSecretRoot: env.SPACE_TELEGRAM_SECRET_ROOT || "/opt/spaceapp/secrets/telegram",
    agentToolsWriterCommand: env.SPACE_AGENT_TOOLS_WRITER || "/opt/spaceapp/bin/space-agent-tools-writer"
  };
}
