import { spawn } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  asRecord,
  buildCodexAppServerProcessEnv,
  parseCodexAppServerJsonRpcLine,
  runCodexAppServerStdioTurnSession,
  stringField,
  type CodexAppServerProcessEnv,
  type CodexAppServerStdioProcessFactory,
  type CodexAppServerJsonRpcMessage,
  type CodexAppServerTurnSessionState
} from "@space/codex-app-server";
import {
  codexAppServerHandshakeResultSchema,
  codexAppServerSchemaManifestSchema,
  codexAppServerStatusSchema,
  codexAppServerTurnSmokeInputSchema,
  codexAppServerTurnSmokeResultSchema,
  codexAppServerTransportSchema
} from "@space/contracts";
import type { z } from "zod";
import type { SpaceApiConfig } from "./config.js";

export type CodexAppServerStatus = z.infer<typeof codexAppServerStatusSchema>;
export type CodexAppServerSchemaManifest = z.infer<typeof codexAppServerSchemaManifestSchema>;
export type CodexAppServerHandshakeResult = z.infer<typeof codexAppServerHandshakeResultSchema>;
export type CodexAppServerTurnSmokeInput = z.infer<typeof codexAppServerTurnSmokeInputSchema>;
export type CodexAppServerTurnSmokeResult = z.infer<typeof codexAppServerTurnSmokeResultSchema>;

interface StatusOptions {
  now?: Date;
  schemaManifest?: CodexAppServerSchemaManifest | null;
}

interface HandshakeOptions {
  now?: Date;
  schemaManifest?: CodexAppServerSchemaManifest | null;
  performStdioHandshake?: () => Promise<Record<string, unknown>>;
}

type TurnSmokeExecution = CodexAppServerTurnSessionState;

interface TurnSmokeOptions {
  now?: Date;
  schemaManifest?: CodexAppServerSchemaManifest | null;
  performStdioTurnSmoke?: (input: CodexAppServerTurnSmokeInput) => Promise<TurnSmokeExecution>;
}

function baseStatus(
  config: SpaceApiConfig,
  options: StatusOptions | undefined,
  fields: Omit<
    CodexAppServerStatus,
    "id" | "command" | "socketPath" | "websocketUrl" | "schemasGenerated" | "schemaManifest" | "lastCheckedAt"
  >
): CodexAppServerStatus {
  return codexAppServerStatusSchema.parse({
    id: "codex-app-server",
    command: config.codexAppServerCommand || null,
    socketPath: config.codexAppServerSocketPath,
    websocketUrl: config.codexAppServerWebsocketUrl,
    schemasGenerated: Boolean(options?.schemaManifest),
    schemaManifest: options?.schemaManifest ?? null,
    lastCheckedAt: (options?.now ?? new Date()).toISOString(),
    ...fields
  });
}

export function loadCodexAppServerSchemaManifest(schemaDir: string | null): CodexAppServerSchemaManifest | null {
  if (!schemaDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(`${schemaDir}/manifest.json`, "utf8"));
    return codexAppServerSchemaManifestSchema.parse(parsed);
  } catch {
    return null;
  }
}

function isLoopbackWebsocketUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

function hasValidWebsocketUrl(rawUrl: string | null): rawUrl is string {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

function resolveCodexAppServerKeyFile(config: SpaceApiConfig): string | null {
  return config.codexAppServerKeyFile ?? config.codexLbKeyFile;
}

function readCodexAppServerKeyFile(keyFile: string): string {
  return readFileSync(keyFile, "utf8").trim();
}

export function getCodexAppServerStatus(config: SpaceApiConfig, options?: StatusOptions): CodexAppServerStatus {
  const schemaManifest =
    options?.schemaManifest === undefined
      ? loadCodexAppServerSchemaManifest(config.codexAppServerSchemaDir)
      : options.schemaManifest;
  const statusOptions = { ...options, schemaManifest };
  const transportParse = codexAppServerTransportSchema.safeParse(config.codexAppServerTransport);
  const transport = transportParse.success ? transportParse.data : "off";

  if (!config.codexAppServerEnabled) {
    return baseStatus(config, statusOptions, {
      status: "DISABLED",
      reasonCode: "DISABLED_BY_DEFAULT",
      statusReason: "Codex App Server adapter is disabled by default. No Codex process is spawned or connected.",
      transport
    });
  }

  if (!transportParse.success) {
    return baseStatus(config, statusOptions, {
      status: "ERROR",
      reasonCode: "INVALID_TRANSPORT",
      statusReason: "SPACE_CODEX_APP_SERVER_TRANSPORT must be one of stdio, unix, websocket, or off.",
      transport
    });
  }

  if (!config.codexAppServerCommand.trim()) {
    return baseStatus(config, statusOptions, {
      status: "ERROR",
      reasonCode: "INVALID_COMMAND",
      statusReason: "SPACE_CODEX_APP_SERVER_COMMAND must name the pinned Codex command to use.",
      transport
    });
  }

  if (transport === "off") {
    return baseStatus(config, statusOptions, {
      status: "DISABLED",
      reasonCode: "TRANSPORT_OFF",
      statusReason: "Codex App Server transport is explicitly off. No Codex process is spawned or connected.",
      transport
    });
  }

  if (transport === "unix" && config.codexAppServerSocketPath && !isAbsolute(config.codexAppServerSocketPath)) {
    return baseStatus(config, statusOptions, {
      status: "ERROR",
      reasonCode: "SOCKET_PATH_NOT_ABSOLUTE",
      statusReason: "Custom Codex App Server Unix socket paths must be absolute.",
      transport
    });
  }

  if (config.codexAppServerHome && !isAbsolute(config.codexAppServerHome)) {
    return baseStatus(config, statusOptions, {
      status: "ERROR",
      reasonCode: "HOME_PATH_NOT_ABSOLUTE",
      statusReason: "SPACE_CODEX_APP_SERVER_HOME must be an absolute path when set.",
      transport
    });
  }

  const keyFile = resolveCodexAppServerKeyFile(config);
  if (keyFile && !isAbsolute(keyFile)) {
    return baseStatus(config, statusOptions, {
      status: "ERROR",
      reasonCode: "KEY_FILE_PATH_NOT_ABSOLUTE",
      statusReason: "Codex App Server key file paths must be absolute when configured.",
      transport
    });
  }
  if (keyFile) {
    let key = "";
    try {
      key = readCodexAppServerKeyFile(keyFile);
    } catch {
      return baseStatus(config, statusOptions, {
        status: "ERROR",
        reasonCode: "KEY_FILE_UNREADABLE",
        statusReason: "Codex App Server key file is not readable by the Space API service.",
        transport
      });
    }
    if (!key) {
      return baseStatus(config, statusOptions, {
        status: "ERROR",
        reasonCode: "KEY_FILE_EMPTY",
        statusReason: "Codex App Server key file is empty.",
        transport
      });
    }
  }

  if (transport === "websocket") {
    if (!config.codexAppServerWebsocketUrl) {
      return baseStatus(config, statusOptions, {
        status: "ERROR",
        reasonCode: "WEBSOCKET_URL_REQUIRED",
        statusReason: "WebSocket transport requires SPACE_CODEX_APP_SERVER_WEBSOCKET_URL.",
        transport
      });
    }
    if (!hasValidWebsocketUrl(config.codexAppServerWebsocketUrl)) {
      return baseStatus(config, statusOptions, {
        status: "ERROR",
        reasonCode: "WEBSOCKET_URL_INVALID",
        statusReason: "Codex App Server WebSocket URL must use ws:// or wss://.",
        transport
      });
    }
    if (!isLoopbackWebsocketUrl(config.codexAppServerWebsocketUrl)) {
      return baseStatus(config, statusOptions, {
        status: "ERROR",
        reasonCode: "WEBSOCKET_NON_LOOPBACK_FORBIDDEN",
        statusReason: "Non-loopback Codex App Server WebSocket transport is forbidden in Space v1. Use stdio or Unix socket.",
        transport
      });
    }
  }

  return baseStatus(config, statusOptions, {
    status: "READY",
    reasonCode: "CONFIG_SAFE",
    statusReason: `Configured for ${transport} transport but not connected; no Codex App Server execution smoke has been run.`,
    transport
  });
}

export function buildCodexAppServerChildEnv(
  config: SpaceApiConfig,
  baseEnv: NodeJS.ProcessEnv
): CodexAppServerProcessEnv {
  const codexHome = resolve(config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex");
  const keyFile = resolveCodexAppServerKeyFile(config);
  const credential = keyFile && (!codexHome || basename(codexHome) !== ".codex")
    ? { name: config.codexAppServerKeyEnv, value: readCodexAppServerKeyFile(keyFile) }
    : null;
  return buildCodexAppServerProcessEnv({ baseEnv, codexHome, credential });
}

function handshakeResult(
  input: Omit<CodexAppServerHandshakeResult, "id" | "startedAt" | "finishedAt" | "durationMs" | "serverInfo"> & {
    startedAt: Date;
    finishedAt: Date;
    serverInfo?: Record<string, unknown> | null;
  }
): CodexAppServerHandshakeResult {
  return codexAppServerHandshakeResultSchema.parse({
    id: "codex-app-server",
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    serverInfo: input.serverInfo ?? null,
    status: input.status,
    code: input.code,
    message: input.message,
    transport: input.transport
  });
}

export async function runCodexAppServerHandshake(
  config: SpaceApiConfig,
  options: HandshakeOptions = {}
): Promise<CodexAppServerHandshakeResult> {
  const startedAt = options.now ?? new Date();
  const finish = () => new Date();
  const status = getCodexAppServerStatus(config, { schemaManifest: options.schemaManifest });

  if (status.status === "DISABLED") {
    return handshakeResult({
      status: "DISABLED",
      code: "ADAPTER_DISABLED",
      message: "Codex App Server adapter is disabled.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (status.status === "ERROR") {
    return handshakeResult({
      status: "ERROR",
      code: "CONFIG_UNSAFE",
      message: status.statusReason,
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!status.schemasGenerated) {
    return handshakeResult({
      status: "ERROR",
      code: "SCHEMAS_MISSING",
      message: "Version-matched Codex App Server schemas must be generated before handshake smoke.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (status.transport !== "stdio") {
    return handshakeResult({
      status: "ERROR",
      code: "TRANSPORT_NOT_IMPLEMENTED",
      message: "Only stdio handshake smoke is implemented in this slice.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!config.codexAppServerAllowStdioSpawn) {
    return handshakeResult({
      status: "ERROR",
      code: "STDIO_SPAWN_NOT_ENABLED",
      message: "SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN=true is required before spawning Codex App Server.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  try {
    const serverInfo = await (options.performStdioHandshake ?? (() => performCodexAppServerStdioHandshake(config)))();
    return handshakeResult({
      status: "VERIFIED",
      code: "HANDSHAKE_OK",
      message: "Codex App Server stdio initialize handshake completed.",
      transport: status.transport,
      startedAt,
      finishedAt: finish(),
      serverInfo
    });
  } catch {
    return handshakeResult({
      status: "ERROR",
      code: "HANDSHAKE_FAILED",
      message: "Codex App Server stdio initialize handshake failed.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }
}

function turnSmokeResult(
  input: Omit<
    CodexAppServerTurnSmokeResult,
    "id" | "startedAt" | "finishedAt" | "durationMs" | "threadId" | "turnId" | "turnStatus" | "notificationCount" | "completedNotificationSeen"
  > & {
    startedAt: Date;
    finishedAt: Date;
    threadId?: string | null;
    turnId?: string | null;
    turnStatus?: CodexAppServerTurnSmokeResult["turnStatus"];
    notificationCount?: number;
    completedNotificationSeen?: boolean;
  }
): CodexAppServerTurnSmokeResult {
  return codexAppServerTurnSmokeResultSchema.parse({
    id: "codex-app-server",
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    threadId: input.threadId ?? null,
    turnId: input.turnId ?? null,
    turnStatus: input.turnStatus ?? null,
    notificationCount: input.notificationCount ?? 0,
    completedNotificationSeen: input.completedNotificationSeen ?? false,
    status: input.status,
    code: input.code,
    message: input.message,
    transport: input.transport
  });
}

export async function runCodexAppServerTurnSmoke(
  config: SpaceApiConfig,
  input: CodexAppServerTurnSmokeInput,
  options: TurnSmokeOptions = {}
): Promise<CodexAppServerTurnSmokeResult> {
  const parsedInput = codexAppServerTurnSmokeInputSchema.parse(input);
  const startedAt = options.now ?? new Date();
  const finish = () => new Date();
  const status = getCodexAppServerStatus(config, { schemaManifest: options.schemaManifest });

  if (status.status === "DISABLED") {
    return turnSmokeResult({
      status: "DISABLED",
      code: "ADAPTER_DISABLED",
      message: "Codex App Server adapter is disabled.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (status.status === "ERROR") {
    return turnSmokeResult({
      status: "ERROR",
      code: "CONFIG_UNSAFE",
      message: status.statusReason,
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!status.schemasGenerated) {
    return turnSmokeResult({
      status: "ERROR",
      code: "SCHEMAS_MISSING",
      message: "Version-matched Codex App Server schemas must be generated before thread and turn smoke.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (status.transport !== "stdio") {
    return turnSmokeResult({
      status: "ERROR",
      code: "TRANSPORT_NOT_IMPLEMENTED",
      message: "Only stdio thread and turn smoke is implemented in this slice.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!config.codexAppServerAllowStdioSpawn) {
    return turnSmokeResult({
      status: "ERROR",
      code: "STDIO_SPAWN_NOT_ENABLED",
      message: "SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN=true is required before spawning Codex App Server.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!config.codexAppServerAllowTurnSmoke) {
    return turnSmokeResult({
      status: "ERROR",
      code: "TURN_SMOKE_NOT_ENABLED",
      message: "SPACE_CODEX_APP_SERVER_ALLOW_TURN_SMOKE=true is required before starting a real Codex thread and turn.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }

  try {
    const execution = await (options.performStdioTurnSmoke ?? ((smokeInput) => performCodexAppServerStdioTurnSmoke(config, smokeInput)))(
      parsedInput
    );
    if (!execution.threadId) {
      return turnSmokeResult({
        status: "ERROR",
        code: "THREAD_START_FAILED",
        message: "Codex App Server thread/start did not return a thread id.",
        transport: status.transport,
        startedAt,
        finishedAt: finish(),
        ...execution
      });
    }
    if (!execution.turnId) {
      return turnSmokeResult({
        status: "ERROR",
        code: "TURN_START_FAILED",
        message: "Codex App Server turn/start did not return a turn id.",
        transport: status.transport,
        startedAt,
        finishedAt: finish(),
        ...execution
      });
    }
    if (!execution.completedNotificationSeen || execution.turnStatus !== "completed") {
      return turnSmokeResult({
        status: "ERROR",
        code: "TURN_COMPLETION_FAILED",
        message: "Codex App Server turn did not complete successfully during smoke.",
        transport: status.transport,
        startedAt,
        finishedAt: finish(),
        ...execution
      });
    }
    return turnSmokeResult({
      status: "VERIFIED",
      code: "TURN_COMPLETED",
      message: "Codex App Server thread/start and turn/start smoke completed.",
      transport: status.transport,
      startedAt,
      finishedAt: finish(),
      ...execution
    });
  } catch {
    return turnSmokeResult({
      status: "ERROR",
      code: "TURN_COMPLETION_FAILED",
      message: "Codex App Server thread and turn smoke failed.",
      transport: status.transport,
      startedAt,
      finishedAt: finish()
    });
  }
}

export function performCodexAppServerStdioHandshake(config: SpaceApiConfig): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.codexAppServerCommand, ["app-server"], {
      cwd: process.cwd(),
      env: buildCodexAppServerChildEnv(config, process.env),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Codex App Server initialize handshake timed out."));
    }, 10000);

    function finish(error: Error | null, result?: Record<string, unknown>) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) {
        reject(error);
      } else {
        resolve(result ?? {});
      }
    }

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`Codex App Server exited before initialize completed. stderr=${stderrBuffer.slice(0, 512)}`));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = parseCodexAppServerJsonRpcLine(line) as CodexAppServerJsonRpcMessage;
            if (message.id === 0) {
              if (message.error) {
                finish(new Error(message.error.message ?? "Codex App Server initialize returned an error."));
              } else {
                const result = asRecord(message.result);
                finish(null, {
                  userAgent: stringField(result, "userAgent"),
                  platformFamily: stringField(result, "platformFamily"),
                  platformOs: stringField(result, "platformOs")
                });
              }
            }
          } catch {
            finish(new Error("Codex App Server returned invalid JSON during initialize."));
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "space",
            title: "Space",
            version: "0.1.0"
          }
        }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  });
}

export function performCodexAppServerStdioTurnSmoke(
  config: SpaceApiConfig,
  input: CodexAppServerTurnSmokeInput,
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    spawnProcess?: CodexAppServerStdioProcessFactory;
  } = {}
): Promise<TurnSmokeExecution> {
  const parsedInput = codexAppServerTurnSmokeInputSchema.parse(input);
  return runCodexAppServerStdioTurnSession({
    command: config.codexAppServerCommand,
    cwd: process.cwd(),
    env: buildCodexAppServerChildEnv(config, options.baseEnv ?? process.env),
    prompt: parsedInput.prompt,
    model: parsedInput.model,
    serviceName: "space-capability",
    clientInfo: {
      name: "space",
      title: "Space",
      version: "0.1.0"
    },
    timeoutMs: 60000,
    spawnProcess: options.spawnProcess
  });
}
