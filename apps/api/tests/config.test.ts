import { describe, expect, it } from "vitest";
import { getApiConfig } from "../src/config.js";
import { readFileSync } from "node:fs";

describe("Space API config", () => {
  it("uses its own package version without npm or with stale parent npm metadata", () => {
    const expected = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    expect(getApiConfig({}).version).toBe(expected);
    expect(getApiConfig({ npm_package_version: "0.0.1" }).version).toBe(expected);
  });

  it("parses MCP server configs while keeping execution fail-closed", () => {
    const config = getApiConfig({
      SPACE_MCP_SERVERS_JSON: JSON.stringify([
        {
          id: "filesystem-readonly",
          displayName: "Filesystem Readonly",
          transport: "stdio",
          command: "space-mcp-filesystem",
          args: ["--readonly"],
          enabled: true
        }
      ])
    });

    expect(config.mcpConfigError).toBeNull();
    expect(config.mcpServerConfigs).toEqual([
      expect.objectContaining({
        id: "filesystem-readonly",
        transport: "stdio",
        command: "space-mcp-filesystem",
        enabled: true
      })
    ]);
  });

  it("fails closed on invalid MCP server config without throwing", () => {
    const config = getApiConfig({
      SPACE_MCP_SERVERS_JSON: "{broken-json"
    });

    expect(config.mcpServerConfigs).toEqual([]);
    expect(config.mcpConfigError).toContain("SPACE_MCP_SERVERS_JSON");
  });

  it("uses bounded Postgres pool defaults and accepts explicit API overrides", () => {
    const defaults = getApiConfig({});
    expect(defaults.databasePoolMax).toBe(10);
    expect(defaults.databasePoolIdleTimeoutMs).toBe(30000);
    expect(defaults.databasePoolConnectionTimeoutMs).toBe(5000);

    const configured = getApiConfig({
      SPACE_DATABASE_POOL_MAX: "24",
      SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS: "45000",
      SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS: "7000"
    });
    expect(configured.databasePoolMax).toBe(24);
    expect(configured.databasePoolIdleTimeoutMs).toBe(45000);
    expect(configured.databasePoolConnectionTimeoutMs).toBe(7000);
  });

  it("keeps memory embedding smoke disabled by default while parsing explicit settings", () => {
    const defaults = getApiConfig({});
    expect(defaults.memoryEmbeddingSmokeEnabled).toBe(false);
    expect(defaults.memoryEmbeddingProvider).toBeNull();
    expect(defaults.memoryEmbeddingModel).toBeNull();
    expect(defaults.memoryEmbeddingDimensions).toBe(1536);
    expect(defaults.memoryEmbeddingBaseUrl).toBe("https://api.openai.com/v1");
    expect(defaults.memoryEmbeddingKeyFile).toBeNull();
    expect(defaults.memoryEmbeddingKeyName).toBeNull();
    expect(defaults.memoryEmbeddingTimeoutMs).toBe(10000);

    const configured = getApiConfig({
      SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
      SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
      SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
      SPACE_MEMORY_EMBEDDING_DIMENSIONS: "99999",
      SPACE_MEMORY_EMBEDDING_BASE_URL: "https://api.openai.com/v1/",
      SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-openai-embedding.key",
      SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-openai-embedding",
      SPACE_MEMORY_EMBEDDING_TIMEOUT_MS: "99999"
    });
    expect(configured.memoryEmbeddingSmokeEnabled).toBe(true);
    expect(configured.memoryEmbeddingProvider).toBe("openai");
    expect(configured.memoryEmbeddingModel).toBe("text-embedding-3-small");
    expect(configured.memoryEmbeddingDimensions).toBe(4096);
    expect(configured.memoryEmbeddingBaseUrl).toBe("https://api.openai.com/v1/");
    expect(configured.memoryEmbeddingKeyFile).toBe("/opt/spaceapp/secrets/space-openai-embedding.key");
    expect(configured.memoryEmbeddingKeyName).toBe("space-openai-embedding");
    expect(configured.memoryEmbeddingTimeoutMs).toBe(30000);
  });

  it("keeps the memory graph disabled by default and parses its isolated snapshot root", () => {
    const defaults = getApiConfig({});
    expect(defaults.memoryGraphEnabled).toBe(false);
    expect(defaults.memoryMaintenanceEnabled).toBe(false);
    expect(defaults.memoryMutationsEnabled).toBe(false);
    expect(defaults.memoryGraphRoot).toBe("/opt/spaceapp/var/memory-graph");
    expect(defaults.spaceMemoryLockPath).toBe(`${defaults.spaceMemoryMonthlyPath}.lock`);

    const configured = getApiConfig({
      SPACE_MEMORY_GRAPH_ENABLED: "true",
      SPACE_MEMORY_MAINTENANCE_ENABLED: "true",
      SPACE_MEMORY_MUTATIONS_ENABLED: "true",
      SPACE_MEMORY_GRAPH_ROOT: "/tmp/space-memory-graph",
      SPACE_GEMINI_MEMORY_INDEX_PATH: "/tmp/index.md",
      SPACE_GEMINI_MEMORY_MONTHLY_PATH: "/tmp/monthly.md",
      SPACE_GEMINI_MEMORY_LOCK_PATH: "/tmp/canonical-memory.lock"
    });
    expect(configured.memoryGraphEnabled).toBe(true);
    expect(configured.memoryMaintenanceEnabled).toBe(true);
    expect(configured.memoryMutationsEnabled).toBe(true);
    expect(configured.memoryGraphRoot).toBe("/tmp/space-memory-graph");
    expect(configured.spaceMemoryIndexPath).toBe("/tmp/index.md");
    expect(configured.spaceMemoryMonthlyPath).toBe("/tmp/monthly.md");
    expect(configured.spaceMemoryLockPath).toBe("/tmp/canonical-memory.lock");
  });

  it("keeps voice transcription disabled by default and parses explicit OpenAI settings", () => {
    const defaults = getApiConfig({});
    expect(defaults.voiceTranscriptionEnabled).toBe(false);
    expect(defaults.voiceTranscriptionBaseUrl).toBe("https://api.openai.com/v1");
    expect(defaults.voiceTranscriptionKeyFile).toBeNull();
    expect(defaults.voiceTranscriptionModel).toBe("gpt-live-1");
    expect(defaults.voiceTranscriptionDelay).toBe("minimal");
    expect(defaults.voiceTranscriptionTimeoutMs).toBe(15000);
    expect(defaults.voiceTranscriptionMaxDurationMs).toBe(60000);

    const configured = getApiConfig({
      SPACE_VOICE_TRANSCRIPTION_ENABLED: "true",
      SPACE_VOICE_TRANSCRIPTION_BASE_URL: "https://api.openai.com/v1/",
      SPACE_VOICE_TRANSCRIPTION_KEY_FILE: "/opt/spaceapp/secrets/space-openai-voice.key",
      SPACE_VOICE_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
      SPACE_VOICE_TRANSCRIPTION_DELAY: "high",
      SPACE_VOICE_TRANSCRIPTION_TIMEOUT_MS: "99999",
      SPACE_VOICE_TRANSCRIPTION_MAX_DURATION_MS: "999999"
    });
    expect(configured.voiceTranscriptionEnabled).toBe(true);
    expect(configured.voiceTranscriptionBaseUrl).toBe("https://api.openai.com/v1/");
    expect(configured.voiceTranscriptionKeyFile).toBe("/opt/spaceapp/secrets/space-openai-voice.key");
    expect(configured.voiceTranscriptionModel).toBe("gpt-4o-mini-transcribe");
    expect(configured.voiceTranscriptionDelay).toBe("high");
    expect(configured.voiceTranscriptionTimeoutMs).toBe(60000);
    expect(configured.voiceTranscriptionMaxDurationMs).toBe(300000);
  });

  it("keeps Space-native agent panes disabled by default and parses explicit gates without Coder config", () => {
    const defaults = getApiConfig({});
    expect(defaults.agentPaneEnabled).toBe(false);
    expect(defaults.enableCodexTurns).toBe(false);
    expect(defaults.codexAppServerEnabled).toBe(false);
    expect(defaults.codexAppServerAllowStdioSpawn).toBe(false);
    expect(defaults.codexAppServerAllowTurnExecution).toBe(false);
    expect(defaults.apiRateLimitMax).toBe(3000);

    const configured = getApiConfig({
      SPACE_AGENT_PANE_ENABLED: "true",
      SPACE_ENABLE_CODEX_TURNS: "true",
      SPACE_CODEX_APP_SERVER_ENABLED: "true",
      SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
      SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
      SPACE_API_RATE_LIMIT_MAX: "5000"
    });

    expect(configured.agentPaneEnabled).toBe(true);
    expect(configured.enableCodexTurns).toBe(true);
    expect(configured.codexAppServerEnabled).toBe(true);
    expect(configured.codexAppServerAllowStdioSpawn).toBe(true);
    expect(configured.codexAppServerAllowTurnExecution).toBe(true);
    expect(configured.apiRateLimitMax).toBe(5000);
    expect(JSON.stringify(configured)).not.toContain("192.0.2.216");
  });

  it("keeps CLI runtimes disabled by default and parses controlled command gates", () => {
    const defaults = getApiConfig({});
    expect(defaults.cliEnabled).toBe(false);
    expect(defaults.cliCommandPath).toBeNull();
    expect(defaults.cliRuntimeCommands).toEqual({
      codex: "codex-vscode-parity",
      claude: "claude-vscode-parity",
      gemini: "gemini-vscode-parity",
      opencode: "opencode-vscode-parity",
      autohand: "autohand-vscode-parity",
      qwen: "qwen-vscode-parity",
      kimi: "kimi-vscode-parity",
      grok: "grok-vscode-parity",
      deepseek: "deepseek-vscode-parity",
      hermes: "hermes-vscode-parity",
      omp: "omp-vscode-parity",
      qoder: "qoder-vscode-parity",
      muse: "muse-vscode-parity",
      droid: "droid-vscode-parity",
      cursor: "cursor-vscode-parity",
      copilot: "copilot-vscode-parity"
    });
    expect(defaults.cliCodexDefaultModel).toBeNull();
    expect(defaults.cliCodexDefaultReasoningEffort).toBeNull();
    expect(defaults.cliCredentialSmoke).toEqual({
      codex: false,
      claude: false,
      gemini: false,
      opencode: false,
      autohand: false,
      qwen: false,
      kimi: false,
      grok: false,
      deepseek: false,
      hermes: false,
      cursor: false,
      copilot: false,
      omp: false,
      qoder: false,
      muse: false,
      droid: false
    });
    expect(defaults.cliKimiLoginBootstrapEnabled).toBe(false);
    expect(defaults.cliGrokLoginBootstrapEnabled).toBe(false);
    expect(defaults.cliTokenTtlMs).toBe(60000);
    expect(defaults.cliRootEnabled).toBe(false);
    expect(defaults.cliAdminHostSocketPath).toBe("/run/space-admin-pane-host/pane-host.sock");

    const configured = getApiConfig({
      SPACE_CLI_ENABLED: "true",
      SPACE_CLI_COMMAND_PATH: "/opt/spaceapp/bin",
      SPACE_CLI_TOKEN_TTL_MS: "999999",
      SPACE_CLI_CODEX_COMMAND: "space-codex",
      SPACE_CLI_CODEX_DEFAULT_MODEL: "gpt-configured",
      SPACE_CLI_CODEX_DEFAULT_REASONING_EFFORT: "ultra",
      SPACE_CLI_CLAUDE_COMMAND: "space-claude",
      SPACE_CLI_GEMINI_COMMAND: "space-gemini",
      SPACE_CLI_GEMINI_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_OPENCODE_COMMAND: "space-opencode",
      SPACE_CLI_QWEN_COMMAND: "space-qwen",
      SPACE_CLI_QWEN_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_KIMI_COMMAND: "space-kimi",
      SPACE_CLI_KIMI_LOGIN_BOOTSTRAP: "true",
      SPACE_CLI_GROK_COMMAND: "space-grok",
      SPACE_CLI_GROK_LOGIN_BOOTSTRAP: "true",
      SPACE_CLI_GROK_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_DEEPSEEK_COMMAND: "space-deepseek",
      SPACE_CLI_DEEPSEEK_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_CLAUDE_CREDENTIAL_SMOKE: "true",
      SPACE_CLI_ROOT_ENABLED: "true",
      SPACE_CLI_ADMIN_HOST_SOCKET: "/run/test-admin/pane-host.sock"
    });

    expect(configured.cliEnabled).toBe(true);
    expect(configured.cliCommandPath).toBe("/opt/spaceapp/bin");
    expect(configured.cliTokenTtlMs).toBe(300000);
    expect(configured.cliRuntimeCommands.codex).toBe("space-codex");
    expect(configured.cliCodexDefaultModel).toBe("gpt-configured");
    expect(configured.cliCodexDefaultReasoningEffort).toBe("ultra");
    expect(configured.cliCredentialSmoke.codex).toBe(true);
    expect(configured.cliCredentialSmoke.claude).toBe(true);
    expect(configured.cliRuntimeCommands.gemini).toBe("space-gemini");
    expect(configured.cliCredentialSmoke.gemini).toBe(true);
    expect(configured.cliRuntimeCommands.qwen).toBe("space-qwen");
    expect(configured.cliCredentialSmoke.qwen).toBe(true);
    expect(configured.cliRuntimeCommands.kimi).toBe("space-kimi");
    expect(configured.cliCredentialSmoke.kimi).toBe(false);
    expect(configured.cliKimiLoginBootstrapEnabled).toBe(true);
    expect(configured.cliRuntimeCommands.grok).toBe("space-grok");
    expect(configured.cliCredentialSmoke.grok).toBe(true);
    expect(configured.cliRuntimeCommands.deepseek).toBe("space-deepseek");
    expect(configured.cliCredentialSmoke.deepseek).toBe(true);
    expect(configured.cliGrokLoginBootstrapEnabled).toBe(true);
    expect(configured.cliRootEnabled).toBe(true);
    expect(configured.cliAdminHostSocketPath).toBe("/run/test-admin/pane-host.sock");
  });

  it("keeps managed browser sessions disabled by default and parses demo gates", () => {
    const defaults = getApiConfig({});
    expect(defaults.browserSessionsEnabled).toBe(false);
    expect(defaults.browserSessionsChromePath).toBe("/usr/bin/google-chrome");
    expect(defaults.browserSessionsProfileRoot).toBe("/opt/spaceapp/var/artifacts/browser-profiles");
    expect(defaults.browserSessionsDefaultUrl).toBe("https://www.google.com/");
    expect(defaults.browserSessionsTokenTtlMs).toBe(60000);
    expect(defaults.browserToolBridgeEnabled).toBe(false);
    expect(defaults.browserHostTransport).toBe("in-process");
    expect(defaults.browserHostSocketPath).toBe("/run/space-browser-host/browser-host.sock");
    expect(defaults.internalApiToken).toBeNull();

    const configured = getApiConfig({
      SPACE_ARTIFACT_ROOT: "/opt/spaceapp/var/artifacts",
      SPACE_BROWSER_SESSIONS_ENABLED: "true",
      SPACE_BROWSER_SESSIONS_CHROME_PATH: "/usr/bin/google-chrome-stable",
      SPACE_BROWSER_SESSIONS_PROFILE_ROOT: "/opt/spaceapp/var/browser-profiles",
      SPACE_BROWSER_SESSIONS_DEFAULT_URL: "https://www.google.com/",
      SPACE_BROWSER_SESSIONS_TOKEN_TTL_MS: "999999",
      SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
      SPACE_BROWSER_HOST_TRANSPORT: "unix",
      SPACE_BROWSER_HOST_SOCKET: "/run/test-browser-host/browser.sock",
      SPACE_INTERNAL_API_TOKEN: "test-internal-token"
    });

    expect(configured.browserSessionsEnabled).toBe(true);
    expect(configured.browserSessionsChromePath).toBe("/usr/bin/google-chrome-stable");
    expect(configured.browserSessionsProfileRoot).toBe("/opt/spaceapp/var/browser-profiles");
    expect(configured.browserSessionsDefaultUrl).toBe("https://www.google.com/");
    expect(configured.browserSessionsTokenTtlMs).toBe(300000);
    expect(configured.browserToolBridgeEnabled).toBe(true);
    expect(configured.browserHostTransport).toBe("unix");
    expect(configured.browserHostSocketPath).toBe("/run/test-browser-host/browser.sock");
    expect(configured.internalApiToken).toBe("test-internal-token");
  });
});
