import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpGatewayStatus, McpServer } from "@space/contracts";
import { hashMcpSchema } from "@space/runtime";
import type { SpaceApiConfig } from "../src/config.js";
import { discoverMcpCatalog, executeMcpTool, runMcpDiscoverySmoke } from "../src/mcp.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const readonlyMcpPath = fileURLToPath(new URL("../../../scripts/space-readonly-mcp.mjs", import.meta.url));
const readonlyMcpToolInputSchema = {
  type: "object",
  properties: {
    worktree: { type: "string", maxLength: 220 }
  },
  additionalProperties: false
};
const readonlyMcpToolSchemaHash = hashMcpSchema(readonlyMcpToolInputSchema);

function baseConfig(overrides: Partial<SpaceApiConfig> = {}): SpaceApiConfig {
  return {
    host: "127.0.0.1",
    port: 4910,
    version: "0.1.0",
    runtimeStore: "memory",
    databaseUrl: null,
    temporalAddress: "127.0.0.1:7233",
    temporalNamespace: "default",
    temporalTaskQueue: "space-agent-turns",
    enableDummyTurns: false,
    enableCodexTurns: false,
    codexLbConfigured: false,
    codexLbBaseUrl: null,
    codexLbKeyFile: null,
    codexLbKeyName: null,
    codexAppServerEnabled: false,
    codexAppServerCommand: "codex",
    codexAppServerTransport: "stdio",
    codexAppServerSocketPath: null,
    codexAppServerWebsocketUrl: null,
    codexAppServerSchemaDir: null,
    codexAppServerHome: null,
    codexAppServerKeyFile: null,
    codexAppServerKeyEnv: "OPENAI_API_KEY",
    codexAppServerAllowStdioSpawn: false,
    codexAppServerAllowTurnSmoke: false,
    mcpDiscoverySmokeEnabled: false,
    mcpServerConfigs: [],
    mcpConfigError: null,
    mcpToolExecutionEnabled: false,
    mcpToolBridgeEnabled: false,
    mcpAllowlistedSchemaHashes: [],
    mcpToolExecutionTimeoutMs: 10_000,
    browserEvidenceEnabled: true,
    browserEvidenceChromePath: "/usr/bin/google-chrome",
    browserEvidenceArtifactRoot: join(tmpdir(), "space-api-test-artifacts"),
    browserEvidenceTargetOrigin: "http://127.0.0.1:4911",
    browserEvidenceTimeoutMs: 20_000,
    ...overrides
  };
}

function gatewayStatus(overrides: Partial<McpGatewayStatus> = {}): McpGatewayStatus {
  return {
    id: "mcp-gateway",
    status: "DISABLED",
    statusReason: "disabled",
    targetSpecVersion: "2025-11-25",
    approvalMode: "DISABLED",
    serverCount: 1,
    toolCount: 0,
    lastDiscoveryAt: null,
    ...overrides
  };
}

function configuredServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "local-filesystem",
    displayName: "Local filesystem",
    transport: "stdio",
    status: "DISABLED",
    statusReason: "Configured but discovery execution is disabled.",
    schemaVersion: "2025-11-25",
    configHash: "sha256:test-config",
    toolCount: 0,
    lastDiscoveredAt: null,
    ...overrides
  };
}

function enabledStdioConfig(overrides: Partial<SpaceApiConfig> = {}): SpaceApiConfig {
  return baseConfig({
    mcpDiscoverySmokeEnabled: true,
    mcpServerConfigs: [
      {
        id: "test-stdio",
        displayName: "Test stdio",
        transport: "stdio",
        command: process.execPath,
        args: [fixturePath],
        enabled: true
      }
    ],
    ...overrides
  });
}

describe("MCP discovery smoke", () => {
  it("fails closed without running discovery until explicitly enabled", async () => {
    let didRun = false;
    const result = await runMcpDiscoverySmoke(
      baseConfig(),
      {
        gatewayStatus: gatewayStatus(),
        servers: []
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => {
          didRun = true;
          return { serverCount: 1, toolCount: 1 };
        }
      }
    );

    expect(didRun).toBe(false);
    expect(result).toMatchObject({
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      discoveryEnabled: false,
      toolCount: 0
    });
  });

  it("fails closed on invalid MCP config before discovery can run", async () => {
    const result = await runMcpDiscoverySmoke(
      baseConfig({ mcpConfigError: "invalid" }),
      {
        gatewayStatus: gatewayStatus({ status: "ERROR", statusReason: "invalid" }),
        servers: []
      },
      { now: new Date("2026-06-26T00:00:00.000Z") }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "CONFIG_INVALID",
      discoveryEnabled: false
    });
  });

  it("fails closed when enabled but no configured servers exist", async () => {
    let didRun = false;
    const result = await runMcpDiscoverySmoke(
      baseConfig({ mcpDiscoverySmokeEnabled: true }),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ configHash: "unconfigured" })]
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => {
          didRun = true;
          return { serverCount: 1, toolCount: 1 };
        }
      }
    );

    expect(didRun).toBe(false);
    expect(result).toMatchObject({
      status: "DISABLED",
      code: "NO_CONFIGURED_SERVERS",
      discoveryEnabled: true,
      serverCount: 0,
      toolCount: 0
    });
  });

  it("fails closed when enabled but no discovery performer is wired", async () => {
    const result = await runMcpDiscoverySmoke(
      enabledStdioConfig(),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
      },
      { now: new Date("2026-06-26T00:00:00.000Z") }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "DISCOVERY_NOT_IMPLEMENTED",
      discoveryEnabled: true,
      serverCount: 1,
      toolCount: 0
    });
  });

  it("reports injected discovery success without providing a default runner", async () => {
    const result = await runMcpDiscoverySmoke(
      enabledStdioConfig(),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => ({ serverCount: 1, toolCount: 2 })
      }
    );

    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "DISCOVERY_OK",
      discoveryEnabled: true,
      serverCount: 1,
      toolCount: 2
    });
  });

  it("reports injected discovery failure without leaking exception details", async () => {
    const result = await runMcpDiscoverySmoke(
      enabledStdioConfig(),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => {
          throw new Error("raw discovery failure detail");
        }
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "DISCOVERY_FAILED",
      discoveryEnabled: true,
      serverCount: 1,
      toolCount: 0
    });
    expect(JSON.stringify(result)).not.toContain("raw discovery failure detail");
  });

  it("discovers stdio tool schemas with initialize, initialized notification, and tools/list only", async () => {
    const context = {
      gatewayStatus: gatewayStatus(),
      servers: [
        configuredServer({
          id: "test-stdio",
          displayName: "Test stdio",
          configHash: `sha256:${"a".repeat(64)}`
        })
      ]
    };
    const catalog = await discoverMcpCatalog(enabledStdioConfig(), context, { timeoutMs: 2_000 });

    expect(catalog.servers).toEqual([
      expect.objectContaining({
        id: "test-stdio",
        displayName: "Test stdio",
        status: "VERIFIED",
        toolCount: 1
      })
    ]);
    expect(catalog.tools).toEqual([
      expect.objectContaining({
        id: "test-stdio:list_files",
        serverId: "test-stdio",
        name: "list_files",
        riskLevel: "R2",
        schemaHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        approvalRequired: true,
        status: "VERIFIED"
      })
    ]);
  });

  it("does not spawn discovery for disabled configs", async () => {
    const result = await runMcpDiscoverySmoke(
      enabledStdioConfig({
        mcpServerConfigs: [
          {
            id: "test-stdio",
            displayName: "Test stdio",
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath, "fail-init"],
            enabled: false
          }
        ]
      }),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => {
          throw new Error("disabled config should not execute");
        }
      }
    );

    expect(result).toMatchObject({
      status: "DISABLED",
      code: "NO_CONFIGURED_SERVERS",
      discoveryEnabled: true,
      toolCount: 0
    });
  });

  it("keeps HTTP MCP discovery fail-closed in this slice", async () => {
    await expect(
      discoverMcpCatalog(
        enabledStdioConfig({
          mcpServerConfigs: [
            {
              id: "remote-http",
              displayName: "Remote HTTP",
              transport: "http",
              url: "https://mcp.example.invalid",
              enabled: true
            }
          ]
        }),
        {
          gatewayStatus: gatewayStatus(),
          servers: [configuredServer({ id: "remote-http", displayName: "Remote HTTP", transport: "http" })]
        },
        { timeoutMs: 2_000 }
      )
    ).rejects.toThrow("Only stdio MCP discovery is supported");
  });

  it("redacts raw MCP process errors from smoke results", async () => {
    const result = await runMcpDiscoverySmoke(
      enabledStdioConfig({
        mcpServerConfigs: [
          {
            id: "test-stdio",
            displayName: "Test stdio",
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath, "fail-init"],
            enabled: true
          }
        ]
      }),
      {
        gatewayStatus: gatewayStatus(),
        servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
      },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performDiscovery: async () => {
          const catalog = await discoverMcpCatalog(
            enabledStdioConfig({
              mcpServerConfigs: [
                {
                  id: "test-stdio",
                  displayName: "Test stdio",
                  transport: "stdio",
                  command: process.execPath,
                  args: [fixturePath, "fail-init"],
                  enabled: true
                }
              ]
            }),
            {
              gatewayStatus: gatewayStatus(),
              servers: [configuredServer({ id: "test-stdio", displayName: "Test stdio" })]
            },
            { timeoutMs: 2_000 }
          );
          return { serverCount: catalog.servers.length, toolCount: catalog.tools.length };
        }
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "DISCOVERY_FAILED",
      toolCount: 0
    });
    expect(JSON.stringify(result)).not.toContain("raw-token-value-that-must-not-leak");
  });

  it("executes approved stdio tool calls and captures a redacted result artifact", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-mcp-exec-"));
    const config = enabledStdioConfig({
      mcpToolExecutionEnabled: true,
      browserEvidenceArtifactRoot: artifactRoot,
      mcpServerConfigs: [
        {
          id: "test-stdio",
          displayName: "Test stdio",
          transport: "stdio",
          command: process.execPath,
          args: [fixturePath, "call-ok"],
          enabled: true
        }
      ]
    });
    const context = {
      gatewayStatus: gatewayStatus({ status: "VERIFIED", approvalMode: "ALLOWLISTED" }),
      servers: [
        configuredServer({
          id: "test-stdio",
          displayName: "Test stdio",
          status: "VERIFIED",
          configHash: `sha256:${"a".repeat(64)}`
        })
      ]
    };
    const catalog = await discoverMcpCatalog(config, context, { timeoutMs: 2_000 });
    const capture = await executeMcpTool(
      config,
      {
        gatewayStatus: context.gatewayStatus,
        server: catalog.servers[0],
        tool: catalog.tools[0]
      },
      {
        toolId: "test-stdio:list_files",
        arguments: { path: "/tmp" },
        approvalReason: "Operator approved safe read-only smoke."
      },
      { artifactRoot, timeoutMs: 2_000 }
    );

    expect(capture).toMatchObject({
      isError: false,
      artifact: {
        kind: "MCP_RESULT",
        mimeType: "application/json",
        storageUri: expect.stringContaining("space-artifact://mcp-executions/")
      }
    });
    expect(capture.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    const artifactPath = capture.artifact.metadata.localPath;
    expect(typeof artifactPath).toBe("string");
    const artifactBody = await readFile(String(artifactPath), "utf8");
    expect(artifactBody).toContain("listed /tmp");
    expect(artifactBody).not.toContain("raw-credential-value-that-must-not-leak");
    expect(artifactBody).toContain("[REDACTED]");
  });

  // The readonly Space MCP server is a private operations script; the public export does not ship it.
  it.skipIf(!existsSync(readonlyMcpPath))("discovers and executes the production readonly Space MCP smoke server", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-readonly-mcp-exec-"));
    const config = enabledStdioConfig({
      mcpToolExecutionEnabled: true,
      mcpAllowlistedSchemaHashes: [readonlyMcpToolSchemaHash],
      mcpServerConfigs: [
        {
          id: "space-readonly",
          displayName: "Space readonly",
          transport: "stdio",
          command: process.execPath,
          args: [readonlyMcpPath],
          enabled: true
        }
      ]
    });
    const context = {
      gatewayStatus: gatewayStatus({ status: "VERIFIED", approvalMode: "ALLOWLISTED" }),
      servers: [
        configuredServer({
          id: "space-readonly",
          displayName: "Space readonly",
          status: "VERIFIED",
          configHash: `sha256:${"b".repeat(64)}`
        })
      ]
    };
    const catalog = await discoverMcpCatalog(config, context, { timeoutMs: 2_000 });
    expect(catalog.tools).toHaveLength(3);
    expect(catalog.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "space-readonly:space_status",
        schemaHash: readonlyMcpToolSchemaHash,
        riskLevel: "R0",
        approvalRequired: false,
        status: "VERIFIED"
      })
    ]));

    const capture = await executeMcpTool(
      config,
      {
        gatewayStatus: context.gatewayStatus,
        server: catalog.servers[0],
        tool: catalog.tools[0]
      },
      {
        toolId: "space-readonly:space_status",
        arguments: { worktree: "/opt/spaceapp" },
        approvalReason: "Operator approved read-only Space MCP smoke."
      },
      { artifactRoot, timeoutMs: 2_000 }
    );

    expect(capture).toMatchObject({
      isError: false,
      artifact: {
        kind: "MCP_RESULT",
        mimeType: "application/json"
      }
    });
    const artifactPath = capture.artifact.metadata.localPath;
    expect(typeof artifactPath).toBe("string");
    const artifactBody = await readFile(String(artifactPath), "utf8");
    expect(artifactBody).toContain('"liveCommit"');
    expect(artifactBody).toContain('"distPermissionsOk"');
  });
});
