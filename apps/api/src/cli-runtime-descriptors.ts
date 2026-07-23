import type { AgentRuntimeAuthMode, AgentRuntimeAuthState } from "@space/contracts";

export type CliRuntimeKey = "codex" | "claude" | "gemini" | "opencode" | "qwen" | "kimi" | "grok" | "deepseek";

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

export interface CliRuntimeLayout {
  publicDistribution: boolean;
  runtimeHome: string;
  codexHome: string;
  providerRoots: Readonly<Record<CliRuntimeKey, string>>;
}

export type CliRuntimeAuthPolicy = Pick<
  CliRuntimeDescriptor,
  "authMode" | "missingAuthState" | "missingAuthReason" | "loginAction"
>;

export function resolveOpenCodeAuthPolicy(
  env: Record<string, string | undefined> = process.env
): CliRuntimeAuthPolicy {
  if (env.SPACE_PUBLIC_DISTRIBUTION === "true") {
    return {
      authMode: "API_KEY",
      missingAuthState: "SETUP_REQUIRED",
      missingAuthReason: "OpenCode provider authentication is required. Open the official login flow to continue.",
      loginAction: "login"
    };
  }
  return {
    authMode: "MANAGED",
    missingAuthState: "UNAVAILABLE",
    missingAuthReason: "OpenCode managed credentials have not been verified by the operator.",
    loginAction: null
  };
}

export function resolveCliRuntimeLayout(
  env: Record<string, string | undefined> = process.env
): CliRuntimeLayout {
  const publicDistribution = env.SPACE_PUBLIC_DISTRIBUTION === "true";
  const runtimeHome = publicDistribution ? "/var/lib/spaceapp-cli" : "/var/lib/spaceapp-user";
  const codexHome = publicDistribution
    ? `${runtimeHome}/providers/codex`
    : `${runtimeHome}/.codex`;
  const providerRoot = (key: CliRuntimeKey, legacyName = `space-${key}`) =>
    publicDistribution ? `${runtimeHome}/providers/${key}` : `${codexHome}/${legacyName}`;

  return {
    publicDistribution,
    runtimeHome,
    codexHome,
    providerRoots: {
      codex: codexHome,
      claude: providerRoot("claude", "space-claude-legacy"),
      gemini: providerRoot("gemini"),
      opencode: providerRoot("opencode"),
      qwen: providerRoot("qwen"),
      kimi: providerRoot("kimi"),
      grok: providerRoot("grok"),
      deepseek: providerRoot("deepseek")
    }
  };
}

const cliRuntimeLayout = resolveCliRuntimeLayout();
const { runtimeHome, codexHome, providerRoots } = cliRuntimeLayout;
const parityCwdLabel = cliRuntimeLayout.publicDistribution ? "container workspace" : "/etc cwd";
const openCodeAuthPolicy = resolveOpenCodeAuthPolicy();

export const cliRuntimeDescriptors: readonly CliRuntimeDescriptor[] = [
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
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: codexHome,
    tempDir: `${codexHome}/tmp`,
    environment: { CODEX_HOME: codexHome },
    nativeResumeArgs: null,
    defaultModelId: null,
    credentialVerifiedReason: `Codex CLI direct VS Code/Codex parity wrapper, ${parityCwdLabel}, and credential smoke are verified.`,
    loginBootstrapReason: null
  },
  {
    key: "claude",
    id: "cli:claude",
    providerId: "anthropic",
    providerName: "Anthropic",
    agentName: "Claude Code CLI",
    commandName: "claude-vscode-parity",
    commandEnv: "SPACE_CLI_CLAUDE_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE",
    authMode: "API_KEY",
    missingAuthState: "SETUP_REQUIRED",
    missingAuthReason: "Claude Code authentication is required. Add an Anthropic API key or use the official login flow.",
    loginAction: "login",
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: providerRoots.claude,
    tempDir: `${providerRoots.claude}/tmp`,
    environment: { CLAUDE_CONFIG_DIR: providerRoots.claude, DISABLE_UPDATES: "1" },
    nativeResumeArgs: ["--resume"],
    defaultModelId: null,
    credentialVerifiedReason: `Claude Code direct Anthropic parity wrapper, ${parityCwdLabel}, and credential smoke are verified.`,
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
    authMode: "BROWSER_OAUTH",
    missingAuthState: "LOGIN_REQUIRED",
    missingAuthReason: "Gemini CLI Google OAuth login is required. Open its terminal-only login in Space to continue.",
    loginAction: "login",
    credentialObservationAction: "credential-observation",
    credentialSmokeMarker: "SPACE_GEMINI_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: providerRoots.gemini,
    tempDir: `${providerRoots.gemini}/tmp`,
    environment: { GEMINI_CLI_HOME: providerRoots.gemini },
    nativeResumeArgs: ["--resume", "latest"],
    defaultModelId: null,
    credentialVerifiedReason: `Gemini CLI direct operator parity wrapper, Google browser OAuth, ${parityCwdLabel}, MCP access, and credential smoke are verified.`,
    loginBootstrapReason: null
  },
  {
    key: "opencode",
    id: "cli:opencode",
    providerId: "opencode",
    providerName: "OpenCode",
    agentName: "OpenCode CLI",
    commandName: "opencode-vscode-parity",
    commandEnv: "SPACE_CLI_OPENCODE_COMMAND",
    credentialSmokeEnv: "SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE",
    ...openCodeAuthPolicy,
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: providerRoots.opencode,
    tempDir: `${providerRoots.opencode}/tmp`,
    environment: {
      XDG_CONFIG_HOME: cliRuntimeLayout.publicDistribution
        ? `${providerRoots.opencode}/config`
        : `${runtimeHome}/.config`,
      XDG_DATA_HOME: `${providerRoots.opencode}/data`,
      XDG_CACHE_HOME: `${providerRoots.opencode}/cache`,
      XDG_STATE_HOME: `${providerRoots.opencode}/state`
    },
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: `OpenCode CLI direct operator parity wrapper, ${parityCwdLabel}, MCP access, and credential smoke are verified.`,
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
    stateRoot: providerRoots.qwen,
    tempDir: `${providerRoots.qwen}/tmp`,
    environment: {
      QWEN_HOME: providerRoots.qwen,
      QWEN_RUNTIME_DIR: `${providerRoots.qwen}/runtime`
    },
    nativeResumeArgs: ["--continue"],
    defaultModelId: null,
    credentialVerifiedReason: `Qwen Code CLI direct operator parity wrapper, selected provider credentials, ${parityCwdLabel}, MCP access, and credential smoke are verified.`,
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
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: "SPACE_CLI_KIMI_LOGIN_BOOTSTRAP",
    loginBootstrapRuntimeEnv: "SPACE_KIMI_LOGIN_BOOTSTRAP",
    stateRoot: providerRoots.kimi,
    tempDir: `${providerRoots.kimi}/tmp`,
    environment: { KIMI_CODE_HOME: providerRoots.kimi },
    nativeResumeArgs: ["--session"],
    defaultModelId: null,
    credentialVerifiedReason: `Kimi Code subscription direct operator parity wrapper, ${parityCwdLabel}, MCP access, and credential smoke are verified.`,
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
    credentialObservationAction: null,
    credentialSmokeMarker: null,
    loginBootstrapEnv: "SPACE_CLI_GROK_LOGIN_BOOTSTRAP",
    loginBootstrapRuntimeEnv: "SPACE_GROK_LOGIN_BOOTSTRAP",
    stateRoot: providerRoots.grok,
    tempDir: `${providerRoots.grok}/tmp`,
    environment: { GROK_HOME: providerRoots.grok },
    nativeResumeArgs: ["--resume"],
    defaultModelId: null,
    credentialVerifiedReason: `Grok Build account direct operator parity wrapper, ${parityCwdLabel}, MCP access, and credential smoke are verified.`,
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
    credentialObservationAction: null,
    credentialSmokeMarker: "SPACE_DEEPSEEK_OK",
    loginBootstrapEnv: null,
    loginBootstrapRuntimeEnv: null,
    stateRoot: providerRoots.deepseek,
    tempDir: `${providerRoots.deepseek}/tmp`,
    environment: { DEEPSEEK_HOME: providerRoots.deepseek },
    nativeResumeArgs: null,
    defaultModelId: "deepseek-v4-flash",
    credentialVerifiedReason: "DeepSeek CLI 0.1.1 text-chat wrapper, fixed deepseek-v4-flash model, and credential smoke are verified.",
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
    cliRuntimeDescriptors.map((descriptor) => [
      descriptor.key,
      env[descriptor.credentialSmokeEnv] === "true" ||
        (descriptor.key === "claude" && env.SPACE_CLI_CLAUDE_LEGACY_CREDENTIAL_SMOKE === "true")
    ])
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
