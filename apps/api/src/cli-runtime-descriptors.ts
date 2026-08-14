import type { AgentRuntimeAuthMode, AgentRuntimeAuthState } from "@space/contracts";

export type CliRuntimeKey =
  | "codex"
  | "claude"
  | "gemini"
  | "opencode"
  | "autohand"
  | "qwen"
  | "kimi"
  | "grok"
  | "deepseek"
  | "cursor"
  | "copilot";

export interface CliRuntimeDescriptor {
  key: CliRuntimeKey;
  id: `cli:${CliRuntimeKey}`;
  providerId: string;
  providerName: string;
  agentName: string;
  commandName: string;
  commandEnv: string;
  credentialSmokeEnv: string;
  authMode: AgentRuntimeAuthMode;
  missingAuthState: Exclude<AgentRuntimeAuthState, "READY">;
  missingAuthReason: string;
  loginAction: "login" | null;
  credentialObservationAction: "credential-observation" | null;
  credentialSmokeMarker: `SPACE_${string}_OK` | null;
  loginBootstrapEnv: string | null;
  loginBootstrapRuntimeEnv: string | null;
  stateRoot: string;
  tempDir: string;
  environment: Readonly<Record<string, string>>;
  nativeResumeArgs: readonly string[] | null;
  defaultModelId: string | null;
  credentialVerifiedReason: string;
  loginBootstrapReason: string | null;
}

const proxmoxHome = "/var/lib/spaceapp-user";
const codexHome = `${proxmoxHome}/.codex`;

export const cliRuntimeDescriptors: readonly CliRuntimeDescriptor[] = [
  {
    key: "opencode",
    id: "cli:opencode",
    providerId: "opencode",
    providerName: "OpenCode",
    agentName: "OpenCode CLI",
    commandName: "opencode-vscode-parity",
    commandEnv: "SPACE_CLI_OPENCODE_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE",
    authMode: "MANAGED",
    missingAuthState: "UNAVAILABLE",
    missingAuthReason: "OpenCode managed credentials have not been verified by the operator.",
    loginAction: null,
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_OPENCODE_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-opencode`,
    tempDir: `${codexHome}/space-opencode/tmp`,
    environment: {
      XDG_CONFIG_HOME: `${proxmoxHome}/.config`,
      XDG_DATA_HOME: `${codexHome}/space-opencode/data`,
      XDG_CACHE_HOME: `${codexHome}/space-opencode/cache`,
      XDG_STATE_HOME: `${codexHome}/space-opencode/state`
    },
    nativeResumeArgs: ["--continue"],
    defaultModelId: "opencode/deepseek-v4-flash-free",
    credentialVerifiedReason: "OpenCode CLI direct operator parity wrapper, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "codex",
    id: "cli:codex",
    providerId: "codex",
    providerName: "Codex",
    agentName: "Codex CLI",
    commandName: "codex-vscode-parity",
    commandEnv: "SPACE_CLI_CODEX_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_CODEX_CREDENTIAL_SMOKE",
    authMode: "DEVICE_CODE",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "Codex CLI sign-in is required. Open its device-code login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_CODEX_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: codexHome,
    tempDir: `${codexHome}/tmp`,
    environment: { CODEX_HOME: codexHome },
    nativeResumeArgs: null,
    defaultModelId: null,
    credentialVerifiedReason: "Codex CLI direct VS Code/Codex parity wrapper, /etc cwd, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "claude",
    id: "cli:claude",
    providerId: "anthropic",
    providerName: "Claude Code via Legacy",
    agentName: "Claude Code CLI",
    commandName: "claude-vscode-parity",
    commandEnv: "SPACE_CLI_CLAUDE_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_CLAUDE_LEGACY_CREDENTIAL_SMOKE",
    authMode: "MANAGED",
    missingAuthState: "UNAVAILABLE",
    missingAuthReason: "Claude Code managed credentials have not been verified by the operator.",
    loginAction: null,
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_CLAUDE_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-claude-legacy`,
    tempDir: `${codexHome}/space-claude-legacy/tmp`,
    environment: { CLAUDE_CONFIG_DIR: `${codexHome}/space-claude-legacy` },
    nativeResumeArgs: ["--resume"],
    defaultModelId: null,
    credentialVerifiedReason: "Claude Code via Legacy direct operator parity wrapper, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "gemini",
    id: "cli:gemini",
    providerId: "google",
    providerName: "Google Gemini",
    agentName: "Gemini CLI",
    commandName: "gemini-vscode-parity",
    commandEnv: "SPACE_CLI_GEMINI_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_GEMINI_CREDENTIAL_SMOKE",
    authMode: "NONE",
    missingAuthState: "UNAVAILABLE",
    missingAuthReason: "The official Google Antigravity CLI executable is unavailable.",
    loginAction: null,
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-gemini`,
    tempDir: `${codexHome}/space-gemini/tmp`,
    environment: {},
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: "The official Google Antigravity CLI is installed; authentication is handled natively inside the CLI.",
    loginBootstrapReason: null
  },
  {
    key: "autohand",
    id: "cli:autohand",
    providerId: "openrouter",
    providerName: "OpenRouter",
    agentName: "Autohand Code CLI",
    commandName: "autohand-vscode-parity",
    commandEnv: "SPACE_CLI_AUTOHAND_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_AUTOHAND_CREDENTIAL_SMOKE",
    authMode: "API_KEY",
    missingAuthState: "SETUP_REQUIRED",
    missingAuthReason: "Autohand account and OpenRouter API key setup are required. Open its protected setup terminal in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_AUTOHAND_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-autohand`,
    tempDir: `${codexHome}/space-autohand/tmp`,
    environment: { AUTOHAND_HOME: `${codexHome}/space-autohand` },
    nativeResumeArgs: null,
    defaultModelId: "openrouter/auto",
    credentialVerifiedReason: "Autohand Code CLI patched distribution, isolated account and OpenRouter credentials, /etc parity, approved MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "qwen",
    id: "cli:qwen",
    providerId: "alibaba",
    providerName: "Alibaba Coding Plan International",
    agentName: "Qwen Code CLI",
    commandName: "qwen-vscode-parity",
    commandEnv: "SPACE_CLI_QWEN_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_QWEN_CREDENTIAL_SMOKE",
    authMode: "API_KEY",
    missingAuthState: "SETUP_REQUIRED",
    missingAuthReason: "Qwen Code provider setup is required. Open its terminal and use the official /auth menu.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_QWEN_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-qwen`,
    tempDir: `${codexHome}/space-qwen/tmp`,
    environment: {
      QWEN_HOME: `${codexHome}/space-qwen`,
      QWEN_RUNTIME_DIR: `${codexHome}/space-qwen/runtime`
    },
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: "Qwen Code CLI direct operator parity wrapper, selected provider credentials, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "kimi",
    id: "cli:kimi",
    providerId: "kimi-code",
    providerName: "Kimi Code Subscription",
    agentName: "Kimi Code CLI",
    commandName: "kimi-vscode-parity",
    commandEnv: "SPACE_CLI_KIMI_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_KIMI_CREDENTIAL_SMOKE",
    authMode: "BROWSER_OAUTH",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "Kimi Code OAuth login is required. Open its login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_KIMI_OK",
    loginBootstrapEnv: "SPACE_CLI_KIMI_LOGIN_BOOTSTRAP",
    loginBootstrapRuntimeEnv: "SPACE_KIMI_LOGIN_BOOTSTRAP",
    stateRoot: `${codexHome}/space-kimi`,
    tempDir: `${codexHome}/space-kimi/tmp`,
    environment: { KIMI_CODE_HOME: `${codexHome}/space-kimi` },
    nativeResumeArgs: ["--session"],
    defaultModelId: null,
    credentialVerifiedReason: "Kimi Code subscription direct operator parity wrapper, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: "Kimi Code CLI is enabled only for first-run Kimi Code OAuth login; subscription credential smoke is still pending."
  },
  {
    key: "grok",
    id: "cli:grok",
    providerId: "xai",
    providerName: "Grok Build",
    agentName: "Grok Build CLI",
    commandName: "grok-vscode-parity",
    commandEnv: "SPACE_CLI_GROK_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_GROK_CREDENTIAL_SMOKE",
    authMode: "DEVICE_CODE",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "Grok Build sign-in is required. Open its device-code login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_GROK_OK",
    loginBootstrapEnv: "SPACE_CLI_GROK_LOGIN_BOOTSTRAP",
    loginBootstrapRuntimeEnv: "SPACE_GROK_LOGIN_BOOTSTRAP",
    stateRoot: `${codexHome}/space-grok`,
    tempDir: `${codexHome}/space-grok/tmp`,
    environment: { GROK_HOME: `${codexHome}/space-grok` },
    nativeResumeArgs: ["--resume"],
    defaultModelId: null,
    credentialVerifiedReason: "Grok Build account direct operator parity wrapper, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: "Grok Build CLI is enabled only for first-run xAI device-code login; account credential smoke is still pending."
  },
  {
    key: "deepseek",
    id: "cli:deepseek",
    providerId: "deepseek",
    providerName: "DeepSeek",
    agentName: "DeepSeek CLI",
    commandName: "deepseek-vscode-parity",
    commandEnv: "SPACE_CLI_DEEPSEEK_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_DEEPSEEK_CREDENTIAL_SMOKE",
    authMode: "API_KEY",
    missingAuthState: "SETUP_REQUIRED",
    missingAuthReason: "DeepSeek API key setup is required. Open its protected setup terminal in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_DEEPSEEK_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-deepseek`,
    tempDir: `${codexHome}/space-deepseek/tmp`,
    environment: { DEEPSEEK_HOME: `${codexHome}/space-deepseek` },
    nativeResumeArgs: null,
    defaultModelId: null,
    credentialVerifiedReason: "DeepSeek CLI 0.1.1 text-chat wrapper, live provider model catalog, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "cursor",
    id: "cli:cursor",
    providerId: "cursor",
    providerName: "Cursor",
    agentName: "Cursor CLI",
    commandName: "cursor-vscode-parity",
    commandEnv: "SPACE_CLI_CURSOR_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_CURSOR_CREDENTIAL_SMOKE",
    authMode: "BROWSER_OAUTH",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "Cursor CLI OAuth login is required. Open its browser login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_CURSOR_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-cursor`,
    tempDir: `${codexHome}/space-cursor/tmp`,
    environment: {
      CURSOR_CONFIG_DIR: `${codexHome}/space-cursor`,
      AGENT_CLI_CREDENTIAL_STORE: "file"
    },
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: "Cursor CLI direct operator parity wrapper, browser OAuth, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  },
  {
    key: "copilot",
    id: "cli:copilot",
    providerId: "github",
    providerName: "GitHub",
    agentName: "GitHub Copilot CLI",
    commandName: "copilot-vscode-parity",
    commandEnv: "SPACE_CLI_COPILOT_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_COPILOT_CREDENTIAL_SMOKE",
    authMode: "DEVICE_CODE",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "GitHub Copilot CLI login is required. Open its device-code login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_COPILOT_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: `${codexHome}/space-copilot`,
    tempDir: `${codexHome}/space-copilot/tmp`,
    environment: { COPILOT_HOME: `${codexHome}/space-copilot` },
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: "GitHub Copilot CLI direct operator parity wrapper, GitHub device login, /etc cwd, MCP access, and credential smoke are verified.",
    loginBootstrapReason: null
  }
];

const descriptorById = new Map(cliRuntimeDescriptors.map((descriptor) => [descriptor.id, descriptor]));

export function findCliRuntimeDescriptor(runtimeId: string | null | undefined): CliRuntimeDescriptor | null {
  if (!runtimeId) return null;
  return descriptorById.get(runtimeId as `cli:${CliRuntimeKey}`) ?? null;
}

export function configuredCliRuntimeCommands(env: NodeJS.ProcessEnv): Record<CliRuntimeKey, string> {
  return Object.fromEntries(
    cliRuntimeDescriptors.map((descriptor) => [descriptor.key, env[descriptor.commandEnv] || descriptor.commandName])
  ) as Record<CliRuntimeKey, string>;
}

export function configuredCliCredentialSmoke(env: NodeJS.ProcessEnv): Record<CliRuntimeKey, boolean> {
  return Object.fromEntries(
    cliRuntimeDescriptors.map((descriptor) => [descriptor.key, env[descriptor.credentialSmokeEnv] === "true"])
  ) as Record<CliRuntimeKey, boolean>;
}

export function configuredCliLoginBootstrap(env: NodeJS.ProcessEnv): Record<CliRuntimeKey, boolean> {
  return Object.fromEntries(
    cliRuntimeDescriptors.map((descriptor) => [
      descriptor.key,
      descriptor.loginBootstrapEnv ? env[descriptor.loginBootstrapEnv] === "true" : false
    ])
  ) as Record<CliRuntimeKey, boolean>;
}
