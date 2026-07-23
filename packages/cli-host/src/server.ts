import { execFileSync } from "node:child_process";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { CliHostError, CliHostSessionRegistry } from "./session-registry.js";
import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing.js";
import type { CliHostAttachInput, CliHostEvent, CliHostIdentity } from "./types.js";

type CliHostMethod = "inspect" | "attach" | "input" | "resize" | "detach" | "terminate" | "reapDetached";

interface CliHostRequest {
  kind: "request";
  requestId: string;
  method: CliHostMethod;
  params: Record<string, unknown>;
}

interface ConnectionAttachment {
  identity: CliHostIdentity;
  attachmentId: string;
}

export interface CliHostServer {
  socketPath: string;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): CliHostRequest {
  if (!isRecord(value) || value.kind !== "request" || typeof value.requestId !== "string" || typeof value.method !== "string") {
    throw new CliHostError("CLI_HOST_BAD_REQUEST", "CLI host IPC request envelope is invalid.");
  }
  if (!["inspect", "attach", "input", "resize", "detach", "terminate", "reapDetached"].includes(value.method)) {
    throw new CliHostError("CLI_HOST_BAD_REQUEST", `Unsupported CLI host IPC method ${value.method}.`);
  }
  return {
    kind: "request",
    requestId: value.requestId,
    method: value.method as CliHostMethod,
    params: isRecord(value.params) ? value.params : {}
  };
}

function requireIdentity(params: Record<string, unknown>): CliHostIdentity {
  const identity = params.identity;
  if (!isRecord(identity)) throw new CliHostError("CLI_HOST_BAD_REQUEST", "CLI host identity is required.");
  for (const field of ["cliSessionId", "paneId", "roomId", "runtimeId"] as const) {
    if (typeof identity[field] !== "string" || !identity[field]) {
      throw new CliHostError("CLI_HOST_BAD_REQUEST", `CLI host identity ${field} is invalid.`);
    }
  }
  for (const field of ["codexThreadId", "modelId", "reasoningEffort"] as const) {
    if (identity[field] !== null && typeof identity[field] !== "string") {
      throw new CliHostError("CLI_HOST_BAD_REQUEST", `CLI host identity ${field} is invalid.`);
    }
  }
  return identity as unknown as CliHostIdentity;
}

function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(encodeLengthPrefixedJson(value));
}

function sendError(socket: Socket, requestId: string, error: unknown): void {
  const code = error instanceof CliHostError ? error.code : "CLI_HOST_INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "CLI host request failed.";
  send(socket, { kind: "response", requestId, ok: false, error: { code, message } });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const current = await stat(socketPath);
    if (!current.isSocket()) {
      throw new Error(`Refusing to replace non-socket CLI host path ${socketPath}.`);
    }
    await assertSocketIsStale(socketPath);
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertSocketIsStale(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      reject(new CliHostError("CLI_HOST_ALREADY_RUNNING", `A CLI host is already listening on ${socketPath}.`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
}

export async function createCliHostServer(options: {
  socketPath: string;
  socketMode?: number;
  registry: CliHostSessionRegistry;
}): Promise<CliHostServer> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(options.socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleConnection(socket, options.registry);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.socketPath);
  });
  await chmod(options.socketPath, options.socketMode ?? 0o600);
  return {
    socketPath: options.socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}

function handleConnection(socket: Socket, registry: CliHostSessionRegistry): void {
  const decoder = new LengthPrefixedJsonDecoder();
  const attachments = new Map<string, ConnectionAttachment>();
  let queue = Promise.resolve();
  socket.on("data", (chunk) => {
    let messages: unknown[];
    try {
      messages = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (error) {
      sendError(socket, "protocol", error);
      socket.destroy();
      return;
    }
    for (const message of messages) {
      queue = queue.then(() => handleRequest(socket, registry, attachments, message)).catch(() => undefined);
    }
  });
  const cleanup = () => {
    for (const attachment of attachments.values()) {
      registry.detach(attachment.identity, attachment.attachmentId);
    }
    attachments.clear();
  };
  socket.once("close", cleanup);
  socket.once("error", () => undefined);
}

async function handleRequest(
  socket: Socket,
  registry: CliHostSessionRegistry,
  attachments: Map<string, ConnectionAttachment>,
  raw: unknown
): Promise<void> {
  let request: CliHostRequest;
  try {
    request = parseRequest(raw);
  } catch (error) {
    sendError(socket, isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : "unknown", error);
    return;
  }
  try {
    let result: unknown;
    if (request.method === "inspect") {
      result = request.params.identity ? await registry.inspectAsync(requireIdentity(request.params)) : {
        hostPid: process.pid,
        startedAt: cliHostStartedAt,
        buildCommit: cliHostBuildCommit,
        sessions: registry.inspectAll()
      };
    } else if (request.method === "attach") {
      const identity = requireIdentity(request.params);
      const earlyEvents: CliHostEvent[] = [];
      let ready = false;
      const attached = await registry.attach(
        {
          identity,
          spawn: request.params.spawn as CliHostAttachInput["spawn"],
          afterSequence: typeof request.params.afterSequence === "number" ? request.params.afterSequence : -1
        },
        (event) => {
          if (!ready) earlyEvents.push(event);
          else send(socket, { kind: "event", attachmentId: attached.attachmentId, event });
        }
      );
      attachments.set(attached.attachmentId, { identity, attachmentId: attached.attachmentId });
      result = attached;
      send(socket, { kind: "response", requestId: request.requestId, ok: true, result });
      ready = true;
      for (const event of earlyEvents) send(socket, { kind: "event", attachmentId: attached.attachmentId, event });
      return;
    } else if (request.method === "input") {
      const identity = requireIdentity(request.params);
      const attachmentId = String(request.params.attachmentId ?? "");
      const idempotencyKey = request.params.idempotencyKey;
      if (
        idempotencyKey !== undefined &&
        (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 240)
      ) {
        throw new CliHostError("CLI_HOST_BAD_REQUEST", "CLI host input idempotency key is invalid.");
      }
      result = await registry.input(
        identity,
        attachmentId,
        String(request.params.data ?? ""),
        request.params.display === "hidden" ? "hidden" : "visible",
        idempotencyKey
      );
    } else if (request.method === "resize") {
      const identity = requireIdentity(request.params);
      const attachmentId = String(request.params.attachmentId ?? "");
      await registry.resize(identity, attachmentId, Number(request.params.cols), Number(request.params.rows));
      result = { ok: true };
    } else if (request.method === "detach") {
      const identity = requireIdentity(request.params);
      const attachmentId = String(request.params.attachmentId ?? "");
      result = registry.detach(identity, attachmentId);
      attachments.delete(attachmentId);
    } else if (request.method === "terminate") {
      result = registry.terminate(requireIdentity(request.params));
    } else {
      result = registry.reapDetachedSessions();
    }
    send(socket, { kind: "response", requestId: request.requestId, ok: true, result });
  } catch (error) {
    sendError(socket, request.requestId, error);
  }
}

const cliHostStartedAt = new Date().toISOString();
const cliHostBuildCommit = readCliHostBuildCommit();

function readCliHostBuildCommit(): string | null {
  const configured = process.env.SPACE_CLI_HOST_BUILD_COMMIT?.trim();
  if (configured) return configured;
  try {
    return execFileSync("git", ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
