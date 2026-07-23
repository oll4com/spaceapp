import { execFileSync } from "node:child_process";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { BrowserHostError } from "./errors.js";
import { BrowserHostFrameDecoder, encodeBrowserHostFrame } from "./framing.js";
import type { BrowserHostBinaryFrame, BrowserHostMethod, BrowserHostRequestHandler, BrowserHostStreamHandle } from "./types.js";

interface BrowserHostRequest {
  kind: "request";
  requestId: string;
  method: BrowserHostMethod;
  params: Record<string, unknown>;
}

export interface BrowserHostServer {
  socketPath: string;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): BrowserHostRequest {
  if (!isRecord(value) || value.kind !== "request" || typeof value.requestId !== "string" || typeof value.method !== "string") {
    throw new BrowserHostError("BROWSER_HOST_BAD_REQUEST", "Browser host IPC request envelope is invalid.");
  }
  const methods: BrowserHostMethod[] = [
    "health", "startOrRestore", "getActive", "navigate", "setViewport", "setStreamMode", "action", "captureFrame", "stopPane",
    "stopRoom", "listPages", "createPage", "activatePage", "closePage", "acquireControl", "heartbeatControl", "releaseControl",
    "dispatchInput", "input", "createCapture", "getCapture", "stopCapture", "cancelCapture", "diagnostics", "startFrameStream", "stopFrameStream"
  ];
  if (!methods.includes(value.method as BrowserHostMethod)) {
    throw new BrowserHostError("BROWSER_HOST_BAD_REQUEST", `Unsupported Browser host IPC method ${value.method}.`);
  }
  return {
    kind: "request",
    requestId: value.requestId,
    method: value.method as BrowserHostMethod,
    params: isRecord(value.params) ? value.params : {}
  };
}

function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(encodeBrowserHostFrame(value));
}

function serializedError(error: unknown) {
  if (error instanceof BrowserHostError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof Error) {
    const candidate = error as Error & { errorCode?: unknown; details?: unknown };
    const code = typeof candidate.errorCode === "string"
      ? candidate.errorCode
      : error.name === "SpaceNotFoundError"
        ? "BROWSER_HOST_NOT_FOUND"
        : error.name === "SpaceConflictError"
          ? "BROWSER_HOST_CONFLICT"
          : "BROWSER_HOST_INTERNAL_ERROR";
    return { code, message: error.message, details: candidate.details };
  }
  return { code: "BROWSER_HOST_INTERNAL_ERROR", message: "Browser host request failed." };
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const current = await stat(socketPath);
    if (!current.isSocket()) throw new Error(`Refusing to replace non-socket Browser host path ${socketPath}.`);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        reject(new BrowserHostError("BROWSER_HOST_ALREADY_RUNNING", `A Browser host is already listening on ${socketPath}.`));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
        else reject(error);
      });
    });
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createBrowserHostServer(options: {
  socketPath: string;
  socketMode?: number;
  handler: BrowserHostRequestHandler;
}): Promise<BrowserHostServer> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(options.socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleConnection(socket, options.handler);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
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

function handleConnection(socket: Socket, handler: BrowserHostRequestHandler): void {
  const decoder = new BrowserHostFrameDecoder();
  const streams = new Map<string, BrowserHostStreamHandle>();
  let queue = Promise.resolve();
  socket.on("data", (chunk) => {
    let messages: unknown[];
    try {
      messages = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (error) {
      send(socket, { kind: "response", requestId: "protocol", ok: false, error: serializedError(error) });
      socket.destroy();
      return;
    }
    for (const message of messages) queue = queue.then(() => handleRequest(socket, handler, streams, message)).catch(() => undefined);
  });
  socket.once("close", () => {
    for (const stream of streams.values()) void stream.stop();
    streams.clear();
  });
  socket.once("error", () => undefined);
}

async function handleRequest(
  socket: Socket,
  handler: BrowserHostRequestHandler,
  streams: Map<string, BrowserHostStreamHandle>,
  raw: unknown
): Promise<void> {
  let request: BrowserHostRequest;
  try {
    request = parseRequest(raw);
  } catch (error) {
    send(socket, { kind: "response", requestId: isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : "unknown", ok: false, error: serializedError(error) });
    return;
  }
  try {
    let result: unknown;
    if (request.method === "health") {
      result = await handler.health();
    } else if (request.method === "startFrameStream") {
      let streamId: string | null = null;
      const earlyFrames: BrowserHostBinaryFrame[] = [];
      const stream = await handler.startFrameStream(request.params, (frame: BrowserHostBinaryFrame) => {
        if (!streamId) {
          if (earlyFrames.length < 4) earlyFrames.push(frame);
          return;
        }
        send(socket, {
          kind: "event",
          subscriptionId: streamId,
          event: { ...frame, dataBase64: frame.data.toString("base64"), data: undefined }
        });
      });
      streamId = stream.id;
      streams.set(stream.id, stream);
      result = { id: stream.id, profile: stream.profile };
      for (const frame of earlyFrames) {
        send(socket, {
          kind: "event",
          subscriptionId: stream.id,
          event: { ...frame, dataBase64: frame.data.toString("base64"), data: undefined }
        });
      }
    } else if (request.method === "stopFrameStream") {
      const id = String(request.params.subscriptionId ?? "");
      const stream = streams.get(id);
      if (stream) await stream.stop();
      streams.delete(id);
      result = { stopped: Boolean(stream) };
    } else {
      result = await handler.request(request.method, request.params);
    }
    send(socket, { kind: "response", requestId: request.requestId, ok: true, result });
  } catch (error) {
    send(socket, { kind: "response", requestId: request.requestId, ok: false, error: serializedError(error) });
  }
}

export function readBrowserHostBuildCommit(): string | null {
  const configured = process.env.SPACE_BROWSER_HOST_BUILD_COMMIT?.trim();
  if (configured) return configured;
  try {
    return execFileSync("git", ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
