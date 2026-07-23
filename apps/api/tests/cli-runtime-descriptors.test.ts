import { describe, expect, it } from "vitest";
import {
  cliRuntimeDescriptors,
  findCliRuntimeDescriptor,
  resolveOpenCodeAuthPolicy,
  resolveCliRuntimeLayout
} from "../src/cli-runtime-descriptors.js";
import { resolveCliParityLayout } from "../src/cli-parity.js";

describe("CLI runtime descriptors", () => {
  it("keeps every non-root CLI in the canonical Space UI order", () => {
    expect(cliRuntimeDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:opencode",
      "cli:qwen",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek"
    ]);
    expect(cliRuntimeDescriptors.map(({ id, authMode, missingAuthState, loginAction }) => ({
      id,
      authMode,
      missingAuthState,
      loginAction
    }))).toEqual([
      { id: "cli:codex", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:claude", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" },
      { id: "cli:gemini", authMode: "BROWSER_OAUTH", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:opencode", authMode: "MANAGED", missingAuthState: "UNAVAILABLE", loginAction: null },
      { id: "cli:qwen", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" },
      { id: "cli:kimi", authMode: "BROWSER_OAUTH", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:grok", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:deepseek", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" }
    ]);
  });

  it("defines public-safe Claude Code authentication without private routing labels", () => {
    expect(findCliRuntimeDescriptor("cli:claude")).toMatchObject({
      key: "claude",
      id: "cli:claude",
      providerId: "anthropic",
      providerName: "Anthropic",
      agentName: "Claude Code CLI",
      commandName: "claude-vscode-parity",
      credentialSmokeEnv: "SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE",
      authMode: "API_KEY",
      missingAuthState: "SETUP_REQUIRED",
      loginAction: "login"
    });
  });

  it("maps every public runtime to generic container-owned state and workspace roots", () => {
    const runtime = resolveCliRuntimeLayout({ SPACE_PUBLIC_DISTRIBUTION: "true" });
    expect(runtime).toMatchObject({
      runtimeHome: "/var/lib/spaceapp-cli",
      codexHome: "/var/lib/spaceapp-cli/providers/codex"
    });
    expect(runtime.providerRoots).toEqual({
      codex: "/var/lib/spaceapp-cli/providers/codex",
      claude: "/var/lib/spaceapp-cli/providers/claude",
      gemini: "/var/lib/spaceapp-cli/providers/gemini",
      opencode: "/var/lib/spaceapp-cli/providers/opencode",
      qwen: "/var/lib/spaceapp-cli/providers/qwen",
      kimi: "/var/lib/spaceapp-cli/providers/kimi",
      grok: "/var/lib/spaceapp-cli/providers/grok",
      deepseek: "/var/lib/spaceapp-cli/providers/deepseek"
    });
    expect(resolveCliParityLayout({ SPACE_PUBLIC_DISTRIBUTION: "true" })).toMatchObject({
      cwd: "/workspaces",
      home: "/var/lib/spaceapp-cli",
      codexHome: "/var/lib/spaceapp-cli/providers/codex",
      claudeRoot: "/var/lib/spaceapp-cli/providers/claude",
      deepseekRoot: "/var/lib/spaceapp-cli/providers/deepseek"
    });
    expect(resolveOpenCodeAuthPolicy({ SPACE_PUBLIC_DISTRIBUTION: "true" })).toEqual({
      authMode: "API_KEY",
      missingAuthState: "SETUP_REQUIRED",
      missingAuthReason: "OpenCode provider authentication is required. Open the official login flow to continue.",
      loginAction: "login"
    });
  });

  it("defines Gemini browser authentication without a special bootstrap mode", () => {
    expect(findCliRuntimeDescriptor("cli:gemini")).toMatchObject({
      key: "gemini",
      id: "cli:gemini",
      providerId: "google",
      agentName: "Gemini CLI",
      commandName: "gemini-vscode-parity",
      commandEnv: "SPACE_CLI_GEMINI_COMMAND",
      credentialSmokeEnv: "SPACE_CLI_GEMINI_CREDENTIAL_SMOKE",
      authMode: "BROWSER_OAUTH",
      missingAuthState: "LOGIN_REQUIRED",
      loginAction: "login",
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_GEMINI_OK",
      loginBootstrapEnv: null,
      loginBootstrapRuntimeEnv: null,
      stateRoot: "/var/lib/spaceapp-user/.codex/space-gemini",
      tempDir: "/var/lib/spaceapp-user/.codex/space-gemini/tmp",
      environment: {
        GEMINI_CLI_HOME: "/var/lib/spaceapp-user/.codex/space-gemini"
      },
      nativeResumeArgs: ["--resume", "latest"]
    });
  });

  it("defines isolated Qwen Coding Plan environment and native recovery", () => {
    expect(findCliRuntimeDescriptor("cli:qwen")).toMatchObject({
      key: "qwen",
      id: "cli:qwen",
      providerId: "alibaba",
      agentName: "Qwen Code CLI",
      commandName: "qwen-vscode-parity",
      commandEnv: "SPACE_CLI_QWEN_COMMAND",
      credentialSmokeEnv: "SPACE_CLI_QWEN_CREDENTIAL_SMOKE",
      authMode: "API_KEY",
      missingAuthState: "SETUP_REQUIRED",
      loginAction: "login",
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_QWEN_OK",
      loginBootstrapEnv: null,
      stateRoot: "/var/lib/spaceapp-user/.codex/space-qwen",
      tempDir: "/var/lib/spaceapp-user/.codex/space-qwen/tmp",
      environment: {
        QWEN_HOME: "/var/lib/spaceapp-user/.codex/space-qwen",
        QWEN_RUNTIME_DIR: "/var/lib/spaceapp-user/.codex/space-qwen/runtime"
      },
      nativeResumeArgs: ["--continue"]
    });
  });

  it("defines DeepSeek as fixed-model text chat without native resume", () => {
    expect(findCliRuntimeDescriptor("cli:deepseek")).toMatchObject({
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
      loginAction: "login",
      stateRoot: "/var/lib/spaceapp-user/.codex/space-deepseek",
      tempDir: "/var/lib/spaceapp-user/.codex/space-deepseek/tmp",
      environment: {
        DEEPSEEK_HOME: "/var/lib/spaceapp-user/.codex/space-deepseek"
      },
      nativeResumeArgs: null,
      defaultModelId: "deepseek-v4-flash"
    });
  });
});
