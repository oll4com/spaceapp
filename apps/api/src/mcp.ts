import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CreateArtifactInput,
  type CreateMcpToolExecutionInput,
  mcpDiscoverySmokeResultSchema,
  mcpServerSchema,
  mcpToolSchema,
  type McpDiscoverySmokeResult,
  type McpGatewayStatus,
  type McpServer,
  type McpServerConfig,
  type McpTool
} from "@space/contracts";
import { hashMcpSchema, makeSpaceId, nowIso, redactArtifactMetadata } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";

export interface McpDiscoverySmokeContext {
  gatewayStatus: McpGatewayStatus;
  servers: McpServer[];
}

export interface McpDiscoverySmokeOptions {
  now?: Date;
  performDiscovery?: () => Promise<{ serverCount: number; toolCount: number }>;
}

export interface McpDiscoveryCatalog {
  servers: McpServer[];
  tools: McpTool[];
}

export type McpToolExecutionArtifactInput = Pick<CreateArtifactInput, "kind" | "mimeType" | "storageUri" | "sha256" | "byteSize" | "metadata">;

export interface McpToolExecutionContext {
  gatewayStatus: McpGatewayStatus;
  server: McpServer;
  tool: McpTool;
}

export interface McpToolExecutionCapture {
  executionId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  isError: boolean;
  artifact: McpToolExecutionArtifactInput;
}

export interface DiscoverMcpCatalogOptions {
  timeoutMs?: number;
}

export interface ExecuteMcpToolOptions {
  artifactRoot: string;
  timeoutMs?: number;
}

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingJsonRpcRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const defaultDiscoveryTimeoutMs = 5_000;
const maxMcpResultArtifactBytes = 512 * 1024;
const maxJsonRpcOutputBytes = 1024 * 1024;
const allowedMcpEnvKeys = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"];

class McpDiscoveryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDiscoveryExecutionError";
  }
}

class McpToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolExecutionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new McpDiscoveryExecutionError(message);
  }
  return value;
}

function asToolName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new McpDiscoveryExecutionError("MCP tools/list returned an invalid tool name.");
  }
  return value;
}

function buildMcpProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    allowedMcpEnvKeys.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
}

function assertSafeCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new McpDiscoveryExecutionError("MCP stdio command is invalid.");
  }
  return trimmed;
}

function assertSafeArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    if (arg.includes("\0")) {
      throw new McpDiscoveryExecutionError("MCP stdio argument is invalid.");
    }
    return arg;
  });
}

function findEnabledServerConfig(config: SpaceApiConfig, serverId: string): NonNullable<SpaceApiConfig["mcpServerConfigs"]>[number] {
  const serverConfig = (config.mcpServerConfigs ?? []).find((item) => item.id === serverId && item.enabled);
  if (!serverConfig) {
    throw new McpToolExecutionError("Enabled MCP server config was not found.");
  }
  if (serverConfig.transport !== "stdio") {
    throw new McpToolExecutionError("Only stdio MCP tool execution is supported in this slice.");
  }
  if (!serverConfig.command) {
    throw new McpToolExecutionError("MCP stdio command is missing.");
  }
  return serverConfig;
}

function mcpConfigHash(config: McpServerConfig): string {
  return hashMcpSchema({
    id: config.id,
    displayName: config.displayName,
    transport: config.transport,
    command: config.command ?? null,
    args: config.args,
    url: config.url ?? null,
    enabled: config.enabled
  });
}

class StdioJsonRpcClient {
  private buffer = "";
  private outputBytes = 0;
  private nextId = 1;
  private exited = false;
  private readonly pending = new Map<JsonRpcId, PendingJsonRpcRequest>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly serverId: string
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.once("error", () => this.failAll("MCP stdio process could not be started."));
    child.once("exit", () => {
      this.exited = true;
      this.failAll("MCP stdio process exited before discovery completed.");
    });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcMessage> {
    const id = this.nextId;
    this.nextId += 1;

    const message = await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new McpDiscoveryExecutionError(`MCP discovery timed out for ${this.serverId}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpDiscoveryExecutionError("MCP stdio process did not accept input."));
      }
    });

    if (message.error !== undefined) {
      throw new McpDiscoveryExecutionError("MCP JSON-RPC request failed.");
    }
    return message;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (!this.exited) {
      this.child.stdin.end();
      this.kill();
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin.writable) {
      throw new McpDiscoveryExecutionError("MCP stdio process is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength;
    if (this.outputBytes > maxJsonRpcOutputBytes) {
      this.kill();
      this.failAll("MCP discovery output exceeded the bounded limit.");
      return;
    }

    this.buffer += chunk.toString("utf8");
    while (this.buffer.includes("\n")) {
      const newlineIndex = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleStderr(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength;
    if (this.outputBytes > maxJsonRpcOutputBytes) {
      this.kill();
      this.failAll("MCP discovery output exceeded the bounded limit.");
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.failAll("MCP stdio process returned invalid JSON-RPC.");
      return;
    }

    const id = parsed.id;
    if (typeof id !== "number" && typeof id !== "string") {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(parsed);
  }

  private failAll(message: string): void {
    const error = new McpDiscoveryExecutionError(message);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private kill(): void {
    if (!this.exited) {
      this.child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (!this.exited) {
          this.child.kill("SIGKILL");
        }
      }, 1_000);
      forceKill.unref();
    }
  }
}

function finishResult(
  input: Omit<McpDiscoverySmokeResult, "id" | "startedAt" | "finishedAt" | "durationMs"> & {
    startedAt: Date;
    finishedAt: Date;
  }
): McpDiscoverySmokeResult {
  return mcpDiscoverySmokeResultSchema.parse({
    id: "mcp-gateway",
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    status: input.status,
    code: input.code,
    message: input.message,
    targetSpecVersion: input.targetSpecVersion,
    discoveryEnabled: input.discoveryEnabled,
    serverCount: input.serverCount,
    toolCount: input.toolCount
  });
}

export async function runMcpDiscoverySmoke(
  config: SpaceApiConfig,
  context: McpDiscoverySmokeContext,
  options: McpDiscoverySmokeOptions = {}
): Promise<McpDiscoverySmokeResult> {
  const startedAt = options.now ?? new Date();
  const finish = () => new Date();
  const discoveryEnabled = config.mcpDiscoverySmokeEnabled === true;
  const targetSpecVersion = context.gatewayStatus.targetSpecVersion;

  if (config.mcpConfigError || context.gatewayStatus.status === "ERROR") {
    return finishResult({
      status: "ERROR",
      code: "CONFIG_INVALID",
      message: "MCP server config is invalid; discovery smoke is disabled.",
      targetSpecVersion,
      discoveryEnabled: false,
      serverCount: context.gatewayStatus.serverCount,
      toolCount: 0,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!discoveryEnabled) {
    return finishResult({
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      message: "SPACE_MCP_DISCOVERY_SMOKE_ENABLED=true is required before MCP discovery smoke can run.",
      targetSpecVersion,
      discoveryEnabled: false,
      serverCount: context.gatewayStatus.serverCount,
      toolCount: 0,
      startedAt,
      finishedAt: finish()
    });
  }

  const enabledServerConfigs = (config.mcpServerConfigs ?? []).filter((serverConfig) => serverConfig.enabled);
  if (enabledServerConfigs.length === 0) {
    return finishResult({
      status: "DISABLED",
      code: "NO_CONFIGURED_SERVERS",
      message: "No configured MCP server is available for discovery smoke.",
      targetSpecVersion,
      discoveryEnabled,
      serverCount: 0,
      toolCount: 0,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!options.performDiscovery) {
    return finishResult({
      status: "ERROR",
      code: "DISCOVERY_NOT_IMPLEMENTED",
      message: "MCP discovery execution is not implemented in this slice.",
      targetSpecVersion,
      discoveryEnabled,
      serverCount: enabledServerConfigs.length,
      toolCount: 0,
      startedAt,
      finishedAt: finish()
    });
  }

  try {
    const discovered = await options.performDiscovery();
    return finishResult({
      status: "VERIFIED",
      code: "DISCOVERY_OK",
      message: "MCP discovery smoke completed.",
      targetSpecVersion,
      discoveryEnabled,
      serverCount: discovered.serverCount,
      toolCount: discovered.toolCount,
      startedAt,
      finishedAt: finish()
    });
  } catch {
    return finishResult({
      status: "ERROR",
      code: "DISCOVERY_FAILED",
      message: "MCP discovery smoke failed.",
      targetSpecVersion,
      discoveryEnabled,
      serverCount: enabledServerConfigs.length,
      toolCount: 0,
      startedAt,
      finishedAt: finish()
    });
  }
}

export async function discoverMcpCatalog(
  config: SpaceApiConfig,
  context: McpDiscoverySmokeContext,
  options: DiscoverMcpCatalogOptions = {}
): Promise<McpDiscoveryCatalog> {
  const timeoutMs = options.timeoutMs ?? defaultDiscoveryTimeoutMs;
  const enabledConfigs = (config.mcpServerConfigs ?? []).filter((serverConfig) => serverConfig.enabled);
  const unsupported = enabledConfigs.find((serverConfig) => serverConfig.transport !== "stdio");
  if (unsupported) {
    throw new McpDiscoveryExecutionError("Only stdio MCP discovery is supported in this slice.");
  }
  if (enabledConfigs.length === 0) {
    throw new McpDiscoveryExecutionError("No enabled MCP stdio server is configured for discovery.");
  }

  const contextServers = new Map(context.servers.map((server) => [server.id, server]));
  const discoveredAt = new Date().toISOString();
  const servers: McpServer[] = [];
  const tools: McpTool[] = [];

  for (const serverConfig of enabledConfigs) {
    if (!serverConfig.command) {
      throw new McpDiscoveryExecutionError("MCP stdio command is missing.");
    }
    const command = assertSafeCommand(serverConfig.command);
    const args = assertSafeArgs(serverConfig.args);
    const child = spawn(command, args, {
      stdio: "pipe",
      shell: false,
      env: buildMcpProcessEnv(),
      windowsHide: true
    });
    const client = new StdioJsonRpcClient(child, serverConfig.id);

    try {
      // MCP 2025-11-25 requires initialize first, then notifications/initialized before normal requests.
      // Sources: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
      //          https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
      //          https://modelcontextprotocol.io/specification/2025-11-25/server/tools
      const initialize = await client.request(
        "initialize",
        {
          protocolVersion: context.gatewayStatus.targetSpecVersion,
          capabilities: {},
          clientInfo: {
            name: "space-capability",
            version: config.version
          }
        },
        timeoutMs
      );
      asRecord(initialize.result, "MCP initialize returned an invalid result.");
      client.notify("notifications/initialized");

      const toolsList = await client.request("tools/list", {}, timeoutMs);
      const toolsResult = asRecord(toolsList.result, "MCP tools/list returned an invalid result.");
      const rawTools = toolsResult.tools;
      if (!Array.isArray(rawTools)) {
        throw new McpDiscoveryExecutionError("MCP tools/list result did not include a tools array.");
      }

      const serverTools = rawTools.map((rawTool) => {
        const toolRecord = asRecord(rawTool, "MCP tools/list returned an invalid tool record.");
        const name = asToolName(toolRecord.name);
        const inputSchema = toolRecord.inputSchema ?? {};
        const nativeReadonlyTool = serverConfig.id === "space-readonly" && [
          "space_status",
          "space_logs",
          "space_authenticated_ui_proof"
        ].includes(name);
        return mcpToolSchema.parse({
          id: `${serverConfig.id}:${name}`,
          serverId: serverConfig.id,
          name,
          riskLevel: nativeReadonlyTool ? "R0" : "R2",
          schemaHash: hashMcpSchema(inputSchema),
          approvalRequired: !nativeReadonlyTool,
          status: "VERIFIED",
          statusReason: "Schema metadata captured by stdio discovery; execution remains disabled."
        });
      });

      servers.push(
        mcpServerSchema.parse({
          id: serverConfig.id,
          displayName: serverConfig.displayName,
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Discovery metadata captured; tool execution remains disabled until approvals and allowlists pass.",
          schemaVersion: context.gatewayStatus.targetSpecVersion,
          configHash: contextServers.get(serverConfig.id)?.configHash ?? mcpConfigHash(serverConfig),
          toolCount: serverTools.length,
          lastDiscoveredAt: discoveredAt
        })
      );
      tools.push(...serverTools);
    } finally {
      client.close();
    }
  }

  return { servers, tools };
}

export async function executeMcpTool(
  config: SpaceApiConfig,
  context: McpToolExecutionContext,
  input: CreateMcpToolExecutionInput,
  options: ExecuteMcpToolOptions
): Promise<McpToolExecutionCapture> {
  const timeoutMs = options.timeoutMs ?? config.mcpToolExecutionTimeoutMs;
  const serverConfig = findEnabledServerConfig(config, context.server.id);
  const command = assertSafeCommand(serverConfig.command ?? "");
  const args = assertSafeArgs(serverConfig.args);
  const startedAt = nowIso();
  const executionId = makeSpaceId("mcp_exec");
  const child = spawn(command, args, {
    stdio: "pipe",
    shell: false,
    env: buildMcpProcessEnv(),
    windowsHide: true
  });
  const client = new StdioJsonRpcClient(child, serverConfig.id);

  try {
    const initialize = await client.request(
      "initialize",
      {
        protocolVersion: context.gatewayStatus.targetSpecVersion,
        capabilities: {},
        clientInfo: {
          name: "space-capability",
          version: config.version
        }
      },
      timeoutMs
    );
    asRecord(initialize.result, "MCP initialize returned an invalid result.");
    client.notify("notifications/initialized");

    const toolResult = await client.request(
      "tools/call",
      {
        name: context.tool.name,
        arguments: input.arguments
      },
      timeoutMs
    );
    const resultRecord = asRecord(toolResult.result, "MCP tools/call returned an invalid result.");
    const finishedAt = nowIso();
    const artifactDir = join(options.artifactRoot, "mcp-executions", executionId.replace(/[^A-Za-z0-9_-]/g, "_"));
    const filename = "result.json";
    const sanitizedResult = redactArtifactMetadata(resultRecord);
    const body = JSON.stringify(
      {
        executionId,
        serverId: context.server.id,
        toolId: context.tool.id,
        toolName: context.tool.name,
        startedAt,
        finishedAt,
        isError: resultRecord.isError === true,
        result: sanitizedResult
      },
      null,
      2
    );
    const buffer = Buffer.from(body, "utf8");
    if (buffer.byteLength > maxMcpResultArtifactBytes) {
      throw new McpToolExecutionError("MCP tool result exceeded the artifact size limit.");
    }

    await mkdir(artifactDir, { recursive: true, mode: 0o750 });
    await writeFile(join(artifactDir, filename), buffer, { mode: 0o640 });
    return {
      executionId,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      isError: resultRecord.isError === true,
      artifact: {
        kind: "MCP_RESULT",
        mimeType: "application/json",
        storageUri: `space-artifact://mcp-executions/${encodeURIComponent(executionId)}/${filename}`,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        byteSize: buffer.byteLength,
        metadata: redactArtifactMetadata({
          mcpExecutionId: executionId,
          serverId: context.server.id,
          toolId: context.tool.id,
          toolName: context.tool.name,
          schemaHash: context.tool.schemaHash,
          localPath: join(artifactDir, filename)
        }) as Record<string, unknown>
      }
    };
  } finally {
    client.close();
  }
}
