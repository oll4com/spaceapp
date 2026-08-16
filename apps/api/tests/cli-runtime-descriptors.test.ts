import { describe, expect, it } from "vitest";
import {
  cliRuntimeDescriptors,
  findCliRuntimeDescriptor
} from "../src/cli-runtime-descriptors.js";
import { cliRunLifecycleAdapters } from "../src/cli-run-lifecycle-adapters.js";

describe("CLI runtime descriptors", () => {
  it("requires verified credential observation and smoke support for Space-managed setup connections", () => {
    expect(cliRuntimeDescriptors).toHaveLength(12);
    for (const descriptor of cliRuntimeDescriptors) {
      if (descriptor.id === "cli:gemini") {
        expect(descriptor.credentialObservationAction).toBeNull();
        expect(descriptor.credentialSmokeMarker).toBeNull();
        continue;
      }
      expect(descriptor.credentialObservationAction, descriptor.id).toBe("credential-observation");
      expect(descriptor.credentialSmokeMarker, descriptor.id).toBe(`SPACE_${descriptor.key.toUpperCase()}_OK`);
    }
  });

  it("keeps every non-root CLI in the canonical Space UI order", () => {
    expect(cliRuntimeDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "cli:opencode",
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:autohand",
      "cli:qwen",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek",
      "cli:cursor",
      "cli:copilot",
      "cli:github"
    ]);
    expect(cliRuntimeDescriptors.map(({ id, authMode, missingAuthState, loginAction }) => ({
      id,
      authMode,
      missingAuthState,
      loginAction
    }))).toEqual([
      { id: "cli:opencode", authMode: "MANAGED", missingAuthState: "UNAVAILABLE", loginAction: null },
      { id: "cli:codex", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:claude", authMode: "MANAGED", missingAuthState: "UNAVAILABLE", loginAction: null },
      { id: "cli:gemini", authMode: "NONE", missingAuthState: "UNAVAILABLE", loginAction: null },
      { id: "cli:autohand", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" },
      { id: "cli:qwen", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" },
      { id: "cli:kimi", authMode: "BROWSER_OAUTH", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:grok", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:deepseek", authMode: "API_KEY", missingAuthState: "SETUP_REQUIRED", loginAction: "login" },
      { id: "cli:cursor", authMode: "BROWSER_OAUTH", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:copilot", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" },
      { id: "cli:github", authMode: "DEVICE_CODE", missingAuthState: "LOGIN_REQUIRED", loginAction: "login" }
    ]);
  });

  it("requires an explicit fail-closed run lifecycle adapter for every CLI descriptor", () => {
    expect(cliRunLifecycleAdapters.map((adapter) => adapter.runtimeId)).toEqual(
      cliRuntimeDescriptors.map((descriptor) => descriptor.id)
    );
    expect(cliRunLifecycleAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtimeId: "cli:codex", completionStrategy: "CODEX_ROLLOUT" }),
      expect.objectContaining({ runtimeId: "cli:opencode", completionStrategy: "OPENCODE_NATIVE_STATUS" }),
      expect.objectContaining({ runtimeId: "cli:claude", completionStrategy: "UNAVAILABLE_FAIL_CLOSED" })
    ]));
    expect(cliRunLifecycleAdapters.every((adapter) => adapter.tracksRunStarts)).toBe(true);
  });

  it("defines OpenCode as the first setup connection with the free DeepSeek V4 Flash default model", () => {
    expect(cliRuntimeDescriptors[0]).toMatchObject({
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
      loginAction: null,
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_OPENCODE_OK",
      stateRoot: "/var/lib/spaceapp-user/.codex/space-opencode",
      tempDir: "/var/lib/spaceapp-user/.codex/space-opencode/tmp",
      environment: {
        XDG_CONFIG_HOME: "/var/lib/spaceapp-user/.config",
        XDG_DATA_HOME: "/var/lib/spaceapp-user/.codex/space-opencode/data",
        XDG_CACHE_HOME: "/var/lib/spaceapp-user/.codex/space-opencode/cache",
        XDG_STATE_HOME: "/var/lib/spaceapp-user/.codex/space-opencode/state"
      },
      nativeResumeArgs: ["--continue"],
      defaultModelId: "opencode/deepseek-v4-flash-free"
    });
  });

  it("defines isolated Autohand setup with fixed OpenRouter and no native resume", () => {
    expect(findCliRuntimeDescriptor("cli:autohand")).toMatchObject({
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
      loginAction: "login",
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_AUTOHAND_OK",
      stateRoot: "/var/lib/spaceapp-user/.codex/space-autohand",
      tempDir: "/var/lib/spaceapp-user/.codex/space-autohand/tmp",
      environment: {
        AUTOHAND_HOME: "/var/lib/spaceapp-user/.codex/space-autohand"
      },
      nativeResumeArgs: null,
      defaultModelId: "openrouter/auto"
    });
  });

  it("routes the stable Gemini runtime id directly to official Antigravity native authentication", () => {
    expect(findCliRuntimeDescriptor("cli:gemini")).toMatchObject({
      key: "gemini",
      id: "cli:gemini",
      providerId: "google",
      agentName: "Gemini CLI",
      commandName: "gemini-vscode-parity",
      commandEnv: "SPACE_CLI_GEMINI_COMMAND",
      credentialSmokeEnv: "SPACE_CLI_GEMINI_CREDENTIAL_SMOKE",
      authMode: "NONE",
      missingAuthState: "UNAVAILABLE",
      loginAction: null,
      credentialObservationAction: null,
      credentialSmokeMarker: null,
      loginBootstrapEnv: null,
      loginBootstrapRuntimeEnv: null,
      stateRoot: "/var/lib/spaceapp-user/.codex/space-gemini",
      tempDir: "/var/lib/spaceapp-user/.codex/space-gemini/tmp",
      environment: {},
      nativeResumeArgs: ["--continue"]
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

  it("defines DeepSeek as provider-catalog text chat without a Space model default", () => {
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
      defaultModelId: null
    });
  });

  it("defines isolated Cursor browser OAuth and native recovery", () => {
    expect(findCliRuntimeDescriptor("cli:cursor")).toMatchObject({
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
      loginAction: "login",
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_CURSOR_OK",
      stateRoot: "/var/lib/spaceapp-user/.codex/space-cursor",
      tempDir: "/var/lib/spaceapp-user/.codex/space-cursor/tmp",
      environment: {
        CURSOR_CONFIG_DIR: "/var/lib/spaceapp-user/.codex/space-cursor",
        AGENT_CLI_CREDENTIAL_STORE: "file"
      },
      nativeResumeArgs: ["--continue"]
    });
  });

  it("defines isolated GitHub Copilot device login and native recovery", () => {
    expect(findCliRuntimeDescriptor("cli:copilot")).toMatchObject({
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
      loginAction: "login",
      credentialObservationAction: "credential-observation",
      credentialSmokeMarker: "SPACE_COPILOT_OK",
      stateRoot: "/var/lib/spaceapp-user/.codex/space-copilot",
      tempDir: "/var/lib/spaceapp-user/.codex/space-copilot/tmp",
      environment: {
        COPILOT_HOME: "/var/lib/spaceapp-user/.codex/space-copilot"
      },
      nativeResumeArgs: ["--continue"]
    });
  });
});
