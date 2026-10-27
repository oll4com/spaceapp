import { getApiConfig, type SpaceApiConfig } from "./config.js";
import { T3EnvValidationError } from "./t3-env.js";
import { cliRuntimeDescriptors } from "./cli-runtime-descriptors.js";

export type ApiConfigKey = keyof SpaceApiConfig;
type Exposure = "public" | "sensitive" | "secret";
type Validation = "boolean" | "positive-integer" | "parser" | "derived";
interface ConfigField {
  scope: "api";
  sources: readonly string[];
  exposure: Exposure;
  validation: Validation;
  deprecatedSources: readonly string[];
}
function field(sources: readonly string[], exposure: Exposure, validation: Validation): ConfigField {
  return { scope: "api", sources, exposure, validation, deprecatedSources: [] };
}

// Metadata only. The existing parser and runtime descriptors own defaults.
// Sources are in parser order; some are dependencies, not aliases. No source
// is marked deprecated without an established migration policy.
export const apiConfigRegistry = {
  instance: field(["SPACE_INSTANCE"], "public", "parser"),
  instanceJobs: field(["SPACE_INSTANCE", "SPACE_INSTANCE_ENABLED_JOBS"], "public", "derived"),
  host: field(["SPACE_API_HOST"], "sensitive", "parser"),
  port: field(["SPACE_API_PORT"], "public", "positive-integer"),
  version: field(["npm_package_version"], "public", "parser"),
  runtimeStore: field(["SPACE_RUNTIME_STORE"], "public", "parser"),
  databaseUrl: field(["SPACE_DATABASE_URL"], "secret", "parser"),
  databasePoolMax: field(["SPACE_DATABASE_POOL_MAX"], "public", "positive-integer"),
  databasePoolIdleTimeoutMs: field(["SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS"], "public", "positive-integer"),
  databasePoolConnectionTimeoutMs: field(["SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS"], "public", "positive-integer"),
  temporalAddress: field(["SPACE_TEMPORAL_ADDRESS"], "sensitive", "parser"),
  temporalNamespace: field(["SPACE_TEMPORAL_NAMESPACE"], "public", "parser"),
  temporalTaskQueue: field(["SPACE_TEMPORAL_TASK_QUEUE"], "public", "parser"),
  enableDummyTurns: field(["SPACE_ENABLE_DUMMY_TURNS"], "public", "boolean"),
  enableCodexTurns: field(["SPACE_ENABLE_CODEX_TURNS"], "public", "boolean"),
  agentPaneEnabled: field(["SPACE_AGENT_PANE_ENABLED"], "public", "boolean"),
  codexLbConfigured: field(["SPACE_GATEWAY_BASE_URL", "SPACE_CODEX_LB_BASE_URL", "SPACE_GATEWAY_KEY_FILE", "SPACE_CODEX_LB_KEY_FILE"], "public", "derived"),
  codexLbBaseUrl: field(["SPACE_GATEWAY_BASE_URL", "SPACE_CODEX_LB_BASE_URL"], "sensitive", "parser"),
  codexLbKeyFile: field(["SPACE_GATEWAY_KEY_FILE", "SPACE_CODEX_LB_KEY_FILE"], "sensitive", "parser"),
  codexLbKeyName: field(["SPACE_GATEWAY_KEY_NAME", "SPACE_CODEX_LB_KEY_NAME"], "sensitive", "parser"),
  gatewayUrl: field(["SPACE_GATEWAY_URL"], "public", "parser"),
  codexAppServerEnabled: field(["SPACE_CODEX_APP_SERVER_ENABLED"], "public", "boolean"),
  codexAppServerCommand: field(["SPACE_CODEX_APP_SERVER_COMMAND"], "sensitive", "parser"),
  codexAppServerTransport: field(["SPACE_CODEX_APP_SERVER_TRANSPORT"], "sensitive", "parser"),
  codexAppServerSocketPath: field(["SPACE_CODEX_APP_SERVER_SOCKET"], "sensitive", "parser"),
  codexAppServerWebsocketUrl: field(["SPACE_CODEX_APP_SERVER_WEBSOCKET_URL"], "sensitive", "parser"),
  codexAppServerSchemaDir: field(["SPACE_CODEX_APP_SERVER_SCHEMA_DIR"], "sensitive", "parser"),
  codexAppServerHome: field(["SPACE_CODEX_APP_SERVER_HOME"], "sensitive", "parser"),
  codexAppServerKeyFile: field(["SPACE_CODEX_APP_SERVER_KEY_FILE"], "sensitive", "parser"),
  codexAppServerKeyEnv: field(["SPACE_CODEX_APP_SERVER_KEY_ENV"], "sensitive", "parser"),
  codexAppServerAllowStdioSpawn: field(["SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN"], "sensitive", "boolean"),
  codexAppServerAllowTurnExecution: field(["SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION"], "sensitive", "boolean"),
  codexAppServerAllowTurnSmoke: field(["SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE"], "sensitive", "boolean"),
  cliEnabled: field(["SPACE_CLI_ENABLED"], "public", "boolean"),
  cliCommandPath: field(["SPACE_CLI_COMMAND_PATH"], "sensitive", "parser"),
  cliWorkspaceRoot: field(["SPACE_CLI_WORKSPACE_ROOT","SPACE_ARTIFACT_ROOT"], "sensitive", "parser"),
  cliTokenTtlMs: field(["SPACE_CLI_TOKEN_TTL_MS"], "public", "positive-integer"),
  cliHostSocketPath: field(["SPACE_CLI_HOST_SOCKET"], "sensitive", "parser"),
  cliMaxRunningSessions: field(["SPACE_CLI_MAX_RUNNING_SESSIONS"], "public", "positive-integer"),
  cliRootEnabled: field(["SPACE_CLI_ROOT_ENABLED"], "public", "boolean"),
  cliAdminHostSocketPath: field(["SPACE_CLI_ADMIN_HOST_SOCKET"], "sensitive", "parser"),
  cliHostSocketsFile: field(["SPACE_CLI_HOST_SOCKETS_FILE"], "sensitive", "parser"),
  cliCodexDefaultModel: field(["SPACE_CLI_CODEX_DEFAULT_MODEL"], "public", "parser"),
  cliCodexDefaultReasoningEffort: field(["SPACE_CLI_CODEX_DEFAULT_REASONING_EFFORT"], "public", "parser"),
  cliRuntimeCommands: field(cliRuntimeDescriptors.flatMap(runtime => runtime.commandEnv ? [runtime.commandEnv] : []), "sensitive", "parser"),
  cliVpnEnabled: field(["SPACE_CLI_VPN_ENABLED"], "public", "boolean"),
  cliVpnLauncherPath: field(["SPACE_CLI_VPN_LAUNCHER"], "sensitive", "parser"),
  cliCredentialSmoke: field(cliRuntimeDescriptors.flatMap(runtime => runtime.credentialSmokeEnv ? [runtime.credentialSmokeEnv] : []), "public", "boolean"),
  cliLoginBootstrap: field(cliRuntimeDescriptors.flatMap(runtime => runtime.loginBootstrapEnv ? [runtime.loginBootstrapEnv] : []), "public", "boolean"),
  cliMaintenanceRepairEnabled: field(["SPACE_CLI_MAINTENANCE_REPAIR_ENABLED"], "public", "boolean"),
  cliKimiLoginBootstrapEnabled: field(["SPACE_CLI_KIMI_LOGIN_BOOTSTRAP"], "public", "boolean"),
  cliGrokLoginBootstrapEnabled: field(["SPACE_CLI_GROK_LOGIN_BOOTSTRAP"], "public", "boolean"),
  cliClaudeLoginBootstrapEnabled: field(["SPACE_CLI_CLAUDE_LOGIN_BOOTSTRAP"], "public", "boolean"),
  cliChatTurnsEnabled: field(["SPACE_ENABLE_CLI_CHAT_TURNS"], "public", "boolean"),
  cliChatTurnRuntimeIds: field(["SPACE_CLI_CHAT_TURN_RUNTIME_IDS"], "public", "parser"),
  mcpServerConfigs: field(["SPACE_MCP_SERVERS_JSON"], "secret", "parser"),
  mcpConfigError: field(["SPACE_MCP_SERVERS_JSON"], "public", "derived"),
  mcpDiscoverySmokeEnabled: field(["SPACE_MCP_DISCOVERY_SMOKE_ENABLED"], "public", "boolean"),
  mcpToolExecutionEnabled: field(["SPACE_MCP_TOOL_EXECUTION_ENABLED"], "public", "boolean"),
  mcpToolBridgeEnabled: field(["SPACE_MCP_TOOL_BRIDGE_ENABLED"], "public", "boolean"),
  mcpAllowlistedSchemaHashes: field(["SPACE_MCP_ALLOWLISTED_SCHEMA_HASHES"], "public", "parser"),
  mcpToolExecutionTimeoutMs: field(["SPACE_MCP_TOOL_EXECUTION_TIMEOUT_MS"], "public", "positive-integer"),
  memoryEmbeddingSmokeEnabled: field(["SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED"], "public", "boolean"),
  memoryEmbeddingProvider: field(["SPACE_MEMORY_EMBEDDING_PROVIDER"], "public", "parser"),
  memoryEmbeddingModel: field(["SPACE_MEMORY_EMBEDDING_MODEL"], "public", "parser"),
  memoryEmbeddingDimensions: field(["SPACE_MEMORY_EMBEDDING_DIMENSIONS"], "public", "positive-integer"),
  memoryEmbeddingBaseUrl: field(["SPACE_MEMORY_EMBEDDING_BASE_URL"], "sensitive", "parser"),
  memoryEmbeddingKeyFile: field(["SPACE_MEMORY_EMBEDDING_KEY_FILE"], "sensitive", "parser"),
  designGatewayKeyFile: field(["SPACE_DESIGN_GATEWAY_KEY_FILE"], "sensitive", "parser"),
  videoWorkRoot: field(["SPACE_VIDEO_WORK_ROOT"], "sensitive", "parser"),
  videoToolsDir: field(["SPACE_VIDEO_TOOLS_DIR"], "sensitive", "parser"),
  videoSourceMaxBytes: field(["SPACE_VIDEO_SOURCE_MAX_BYTES"], "public", "parser"),
  connectorKeyFile: field(["SPACE_CONNECTOR_KEY_FILE"], "sensitive", "parser"),
  memoryEmbeddingKeyName: field(["SPACE_MEMORY_EMBEDDING_KEY_NAME"], "sensitive", "parser"),
  memoryEmbeddingTimeoutMs: field(["SPACE_MEMORY_EMBEDDING_TIMEOUT_MS"], "public", "positive-integer"),
  memoryGraphEnabled: field(["SPACE_MEMORY_GRAPH_ENABLED"], "public", "boolean"),
  memoryMaintenanceEnabled: field(["SPACE_MEMORY_MAINTENANCE_ENABLED"], "public", "boolean"),
  memoryMutationsEnabled: field(["SPACE_MEMORY_MUTATIONS_ENABLED"], "public", "boolean"),
  memoryGraphRoot: field(["SPACE_MEMORY_GRAPH_ROOT"], "sensitive", "parser"),
  voiceTranscriptionEnabled: field(["SPACE_VOICE_TRANSCRIPTION_ENABLED"], "public", "boolean"),
  voiceTranscriptionBaseUrl: field(["SPACE_VOICE_TRANSCRIPTION_BASE_URL"], "sensitive", "parser"),
  voiceTranscriptionKeyFile: field(["SPACE_VOICE_TRANSCRIPTION_KEY_FILE"], "sensitive", "parser"),
  voiceTranscriptionModel: field(["SPACE_VOICE_TRANSCRIPTION_MODEL"], "public", "parser"),
  voiceTranscriptionVoice: field(["SPACE_VOICE_NAME"], "public", "parser"),
  voiceTranscriptionDelay: field(["SPACE_VOICE_TRANSCRIPTION_DELAY"], "public", "parser"),
  voiceTranscriptionTimeoutMs: field(["SPACE_VOICE_TRANSCRIPTION_TIMEOUT_MS"], "public", "positive-integer"),
  voiceTranscriptionMaxDurationMs: field(["SPACE_VOICE_TRANSCRIPTION_MAX_DURATION_MS"], "public", "positive-integer"),
  googleVoiceKeyFile: field(["SPACE_GOOGLE_VOICE_KEY_FILE","SPACE_GEMINI_VOICE_KEY_FILE"], "sensitive", "parser"),
  fcmServiceAccountFile: field(["SPACE_FCM_SERVICE_ACCOUNT_FILE"], "sensitive", "parser"),
  googleVoiceApiKey: field(["GEMINI_API_KEY","GOOGLE_API_KEY"], "secret", "parser"),
  googleVoiceBaseUrl: field(["SPACE_GOOGLE_VOICE_BASE_URL"], "sensitive", "parser"),
  awsVoiceKeyFile: field(["SPACE_AWS_VOICE_KEY_FILE"], "sensitive", "parser"),
  awsAccessKeyId: field(["AWS_ACCESS_KEY_ID"], "secret", "parser"),
  awsSecretAccessKey: field(["AWS_SECRET_ACCESS_KEY"], "secret", "parser"),
  awsRegion: field(["AWS_REGION","AWS_DEFAULT_REGION"], "public", "parser"),
  localVoiceProviderUrl: field(["SPACE_LOCAL_VOICE_PROVIDER_URL"], "sensitive", "parser"),
  localVoiceProviderToken: field(["SPACE_LOCAL_VOICE_PROVIDER_TOKEN"], "secret", "parser"),
  vercelVoiceKeyFile: field(["SPACE_VERCEL_VOICE_KEY_FILE","SPACE_VERCEL_AI_GATEWAY_KEY_FILE"], "sensitive", "parser"),
  vercelVoiceApiKey: field(["AI_GATEWAY_API_KEY","VERCEL_AI_GATEWAY_API_KEY"], "secret", "parser"),
  vercelVoiceBaseUrl: field(["SPACE_VERCEL_VOICE_BASE_URL"], "sensitive", "parser"),
  liveModelPolicy: field(["SPACE_LIVE_MODEL_POLICY_JSON","SPACE_LIVE_DAILY_BUDGET_USD","SPACE_LIVE_COST_MODE"], "sensitive", "parser"),
  liveJevAccelerationEnabled: field(["SPACE_LIVE_JEV_ACCELERATION_ENABLED"], "public", "boolean"),
  spaceMemoryIndexPath: field(["SPACE_MEMORY_INDEX_PATH","SPACE_GEMINI_MEMORY_INDEX_PATH"], "sensitive", "parser"),
  spaceMemoryMonthlyPath: field(["SPACE_MEMORY_MONTHLY_PATH","SPACE_GEMINI_MEMORY_MONTHLY_PATH"], "sensitive", "parser"),
  spaceMemoryLockPath: field(["SPACE_MEMORY_LOCK_PATH","SPACE_GEMINI_MEMORY_LOCK_PATH","SPACE_MEMORY_MONTHLY_PATH","SPACE_GEMINI_MEMORY_MONTHLY_PATH"], "sensitive", "parser"),
  codexGoalsDbPath: field(["SPACE_CODEX_GOALS_DB_PATH"], "sensitive", "parser"),
  browserEvidenceEnabled: field(["SPACE_BROWSER_EVIDENCE_ENABLED"], "public", "boolean"),
  browserEvidenceChromePath: field(["SPACE_BROWSER_CHROME_PATH"], "sensitive", "parser"),
  browserEvidenceArtifactRoot: field(["SPACE_ARTIFACT_ROOT"], "sensitive", "parser"),
  browserEvidenceTargetOrigin: field(["SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN"], "sensitive", "parser"),
  browserEvidenceTimeoutMs: field(["SPACE_BROWSER_EVIDENCE_TIMEOUT_MS"], "public", "positive-integer"),
  appDiagnosticsRoot: field(["SPACE_APP_DIAGNOSTICS_ROOT"], "sensitive", "parser"),
  maintenanceAutopilotStateFile: field(["SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE"], "sensitive", "parser"),
  cliAccountBalancerStateFile: field(["SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE", "SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE"], "sensitive", "parser"),
  browserSessionsEnabled: field(["SPACE_BROWSER_SESSIONS_ENABLED"], "public", "boolean"),
  browserSessionsChromePath: field(["SPACE_BROWSER_SESSIONS_CHROME_PATH","SPACE_BROWSER_CHROME_PATH"], "sensitive", "parser"),
  browserSessionsXvfbPath: field(["SPACE_BROWSER_SESSIONS_XVFB_PATH"], "sensitive", "parser"),
  browserSessionsXvfbEnabled: field(["SPACE_BROWSER_SESSIONS_XVFB_ENABLED"], "public", "boolean"),
  browserSessionsProfileRoot: field(["SPACE_BROWSER_SESSIONS_PROFILE_ROOT","SPACE_ARTIFACT_ROOT"], "sensitive", "parser"),
  jobApplyRoot: field(["SPACE_JOB_APPLY_ROOT","SPACE_ARTIFACT_ROOT"], "sensitive", "parser"),
  browserSessionsDefaultUrl: field(["SPACE_BROWSER_SESSIONS_DEFAULT_URL"], "sensitive", "parser"),
  browserSessionsTokenTtlMs: field(["SPACE_BROWSER_SESSIONS_TOKEN_TTL_MS"], "public", "positive-integer"),
  browserSessionsAudioEnabled: field(["SPACE_BROWSER_SESSIONS_AUDIO_ENABLED"], "public", "boolean"),
  browserSessionsPulseServer: field(["SPACE_BROWSER_SESSIONS_PULSE_SERVER"], "sensitive", "parser"),
  browserSessionsPulseSink: field(["SPACE_BROWSER_SESSIONS_PULSE_SINK"], "public", "parser"),
  browserSessionsYouTubeAdBlockEnabled: field(["SPACE_BROWSER_SESSIONS_YOUTUBE_AD_BLOCK_ENABLED"], "public", "boolean"),
  browserToolBridgeEnabled: field(["SPACE_BROWSER_TOOL_BRIDGE_ENABLED"], "public", "boolean"),
  browserHostTransport: field(["SPACE_BROWSER_HOST_TRANSPORT"], "public", "parser"),
  browserHostSocketPath: field(["SPACE_BROWSER_HOST_SOCKET"], "sensitive", "parser"),
  swarmExecutionEnabled: field(["SPACE_SWARM_EXECUTION_ENABLED"], "public", "boolean"),
  internalApiToken: field(["SPACE_INTERNAL_API_TOKEN"], "secret", "parser"),
  agentTokenSecret: field(["SPACE_AGENT_TOKEN_SECRET"], "secret", "parser"),
  gatewayAdminToken: field(["SPACE_GATEWAY_ADMIN_TOKEN"], "secret", "parser"),
  apiRateLimitMax: field(["SPACE_API_RATE_LIMIT_MAX"], "public", "positive-integer"),
  telegramSecretRoot: field(["SPACE_TELEGRAM_SECRET_ROOT"], "sensitive", "parser"),
  streamingSecretRoot: field(["SPACE_STREAMING_SECRET_ROOT"], "sensitive", "parser"),
  streamingYoutubeDailyQuotaBudget: field(["SPACE_STREAMING_YOUTUBE_DAILY_QUOTA_BUDGET"], "public", "positive-integer"),
  demoProjectsEnabled: field(["SPACE_DEMO_PROJECTS_ENABLED"], "public", "boolean"),
  demoProjectsRoot: field(["SPACE_DEMO_PROJECTS_ROOT"], "sensitive", "parser"),
  projectsRoot: field(["SPACE_PROJECTS_ROOT"], "sensitive", "parser"),
  filesHostModeEnabled: field(["SPACE_FILES_HOST_MODE"], "public", "parser"),
  installRoot: field(["SPACE_INSTALL_ROOT"], "sensitive", "parser"),
  demoProjectsVarRoot: field(["SPACE_DEMO_PROJECTS_VAR_ROOT"], "sensitive", "parser"),
  demoProjectsPortStart: field(["SPACE_DEMO_PROJECTS_PORT_START"], "public", "positive-integer"),
  demoProjectsPortEnd: field(["SPACE_DEMO_PROJECTS_PORT_END"], "public", "positive-integer"),
  demoProjectsHealthTimeoutMs: field(["SPACE_DEMO_PROJECTS_HEALTH_TIMEOUT_MS"], "public", "positive-integer"),
  demoProjectsPublicOrigin: field(["SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN"], "sensitive", "parser"),
  agentToolsWriterCommand: field(["SPACE_PUBLIC_DISTRIBUTION","SPACE_AGENT_TOOLS_WRITER"], "sensitive", "derived"),
  roomAgentMonitorEnabled: field(["SPACE_ROOM_AGENT_MONITOR_ENABLED"], "public", "boolean"),
  roomAgentAutopilotEnabled: field(["SPACE_ROOM_AGENT_AUTOPILOT_ENABLED"], "public", "boolean"),
  roomPaneCommandsEnabled: field(["SPACE_ROOM_PANE_COMMANDS_ENABLED"], "public", "boolean"),
  harnessEnabled: field(["SPACE_HARNESS_ENABLED"], "public", "boolean"),
  harnessOrigin: field(["SPACE_HARNESS_ORIGIN"], "sensitive", "parser"),
  vncPresets: field(["SPACE_VNC_PRESETS"], "sensitive", "parser"),
  trustedProxies: field(["SPACE_TRUSTED_PROXIES"], "sensitive", "parser"),
  optionalModules: field(["SPACE_OPTIONAL_MODULES", "SPACE_PUBLIC_DISTRIBUTION"], "public", "derived"),
  harnessHealthTimeoutMs: field(["SPACE_HARNESS_HEALTH_TIMEOUT_MS"], "public", "positive-integer"),
  harnessProxyTimeoutMs: field(["SPACE_HARNESS_PROXY_TIMEOUT_MS"], "public", "positive-integer"),
  t3CodeEnabled: field(["SPACE_T3CODE_ENABLED"], "public", "boolean"),
  t3CodeSocketPath: field(["SPACE_T3CODE_SOCKET"], "sensitive", "parser"),
  t3CodeProxyTimeoutMs: field(["SPACE_T3CODE_PROXY_TIMEOUT_MS"], "public", "positive-integer"),
  t3CodeHealthTimeoutMs: field(["SPACE_T3CODE_HEALTH_TIMEOUT_MS"], "public", "positive-integer"),
  enableDbSweep: field(["SPACE_ENABLE_DB_SWEEP"], "public", "boolean"),
  // "disabled" turns the gateway off; any other value keeps it on.
  dotToolGatewayEnabled: field(["SPACE_DOT_TOOL_GATEWAY"], "public", "parser"),
  dotWorkspaceRoot: field(["SPACE_DOT_WORKSPACE_ROOT"], "sensitive", "parser"),
  modelPriceCatalogPath: field(["SPACE_MODEL_PRICE_CATALOG"], "sensitive", "parser"),
  planStageMaxAttempts: field(["SPACE_PLAN_STAGE_MAX_ATTEMPTS"], "public", "positive-integer"),
  // Off only for the public distribution when SPACEAPP_WORKFLOWS_ENABLED=false (no workflow worker).
  workflowsEnabled: field(["SPACE_PUBLIC_DISTRIBUTION", "SPACEAPP_WORKFLOWS_ENABLED"], "public", "derived"),
  publicDistribution: field(["SPACE_PUBLIC_DISTRIBUTION"], "public", "derived"),
  // Invites and per-user sign-in (plan clipboard:VrMJ14wJPmVs); off until each user has an isolated CLI container.
  multiUserEnabled: field(["SPACE_MULTI_USER_ENABLED"], "public", "boolean"),
} satisfies Partial<Record<ApiConfigKey, ConfigField>>;

// Completeness is enforced by config-registry.test.ts, not by the type
// checker: a new SpaceApiConfig field must not fail every concurrent build in
// the merge queue. Unregistered fields are described as sensitive (redacted).
const unregisteredField: ConfigField = { scope: "api", sources: [], exposure: "sensitive", validation: "parser", deprecatedSources: [] };
const registered = apiConfigRegistry as Partial<Record<ApiConfigKey, ConfigField>>;
const keys = Object.keys(apiConfigRegistry) as ApiConfigKey[];
const metadataFor = (key: ApiConfigKey): ConfigField => registered[key] ?? unregisteredField;

/** Configuration fields the parser exposes without registry metadata. */
export function unregisteredApiConfigKeys(): ApiConfigKey[] {
  return (Object.keys(getApiConfig({})) as ApiConfigKey[]).filter(key => !registered[key]).sort();
}

/** Reference values use an empty environment, never the caller's secrets. */
export function describeApiConfiguration() {
  const defaults = getApiConfig({});
  return (Object.keys(defaults) as ApiConfigKey[]).map(key => {
    const metadata = metadataFor(key);
    const value = defaults[key];
    return {
      key, ...metadata, registered: Boolean(registered[key]),
      defaultValue: metadata.exposure === "public" || value == null ? value : "[REDACTED]"
    };
  });
}

export interface ConfigurationIssue {
  key: ApiConfigKey;
  code: "INVALID_BOOLEAN" | "INVALID_INTEGER" | "INVALID_STRUCTURE" | "INVALID_RANGE";
  sources: readonly string[];
}

/** Advisory preflight; does not replace parsing or change running services.
 * The API itself fails fast on an invalid environment (T3 Env); this reports
 * every affected registry key by name without echoing configured values. */
export function validateApiConfiguration(env: NodeJS.ProcessEnv): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const add = (key: ApiConfigKey, code: ConfigurationIssue["code"]) => {
    if (!issues.some(issue => issue.key === key && issue.code === code)) issues.push({ key, code, sources: metadataFor(key).sources });
  };
  for (const key of keys) {
    const field = metadataFor(key);
    const values = field.sources.map(source => env[source]).filter(value => value !== undefined);
    if (field.validation === "boolean" && values.some(value => value !== "true" && value !== "false")) {
      add(key, "INVALID_BOOLEAN");
    }
    if (field.validation === "positive-integer" && values.some(value => !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      add(key, "INVALID_INTEGER");
    }
  }
  // Fail-fast env validation stops at invalid variables. Report them, then
  // evaluate the remaining structured settings without the rejected ones.
  let config: SpaceApiConfig | null = null;
  let remaining: NodeJS.ProcessEnv = { ...env };
  for (let attempt = 0; attempt < 5 && !config; attempt += 1) {
    try {
      config = getApiConfig(remaining);
    } catch (error) {
      if (!(error instanceof T3EnvValidationError) || !error.fields.length) throw error;
      for (const source of error.fields) {
        delete remaining[source];
        for (const key of keys) {
          const field = metadataFor(key);
          if (!field.sources.includes(source) || issues.some(issue => issue.key === key)) continue;
          add(key, field.validation === "boolean" ? "INVALID_BOOLEAN" : field.validation === "positive-integer" ? "INVALID_INTEGER" : "INVALID_STRUCTURE");
        }
      }
      remaining = { ...remaining };
    }
  }
  if (config?.mcpConfigError) add("mcpServerConfigs", "INVALID_STRUCTURE");
  if (config?.liveModelPolicy.revision === "invalid") add("liveModelPolicy", "INVALID_STRUCTURE");
  if (config && Number.isFinite(config.port) && (config.port < 1 || config.port > 65535)) add("port", "INVALID_RANGE");
  const portStart = Number(env.SPACE_DEMO_PROJECTS_PORT_START ?? 4930);
  const portEnd = Number(env.SPACE_DEMO_PROJECTS_PORT_END ?? 4999);
  if (Number.isFinite(portStart) && Number.isFinite(portEnd) && portEnd < portStart) add("demoProjectsPortEnd", "INVALID_RANGE");
  return issues;
}
