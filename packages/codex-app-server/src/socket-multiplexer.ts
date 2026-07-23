import { unwatchFile, watchFile } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  codexCliModeDefaultsProjectionSchema,
  type CodexCliModeDefaultPair,
  type CodexCliModeDefaultsProjection
} from "@space/contracts";
import {
  assertCodexAppServerSocketRpcMethodAllowed,
  codexAppServerSocketMaxPayloadBytes
} from "./index.js";

type JsonRpcId = number | string | null;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

type ClientState = {
  id: number;
  socket: WebSocket;
  clientName: string | null;
  primaryReplacementEligible: boolean;
  initializeRequested: boolean;
};

type PendingRequest = {
  clientId: number | null;
  clientRequestId: JsonRpcId;
  method: string;
};

type InitializeWaiter = {
  clientId: number;
  clientRequestId: JsonRpcId;
};

export const codexAppServerMultiplexerMaxBufferBytes = codexAppServerSocketMaxPayloadBytes;

const readOnlySecondaryRpcMethods = new Set(["thread/list", "thread/read"]);

type MessageFailureKind = "binary_message" | "message_too_large" | "invalid_json" | "invalid_message";

class MessageRejectionError extends Error {
  constructor(
    readonly failureKind: MessageFailureKind,
    readonly messageBytes: number
  ) {
    super(failureKind);
  }
}

export type CodexAppServerMultiplexerDiagnostic = {
  schemaVersion: "CodexAppServerMultiplexerDiagnosticV1";
  observedAt: string;
  event: "codex_app_server_multiplexer_transport_failure" | "codex_app_server_multiplexer_transport_closed";
  branch: "upstream_message" | "upstream_error" | "upstream_close" | "client_message" | "client_error" | "primary_client_close";
  failureKind: MessageFailureKind | "transport_error" | "transport_closed" | "primary_client_closed";
  maxBufferBytes: number;
  activeClientCount: number;
  messageBytes?: number;
  clientId?: number;
  clientRole?: "primary" | "secondary";
  errorName?: string;
  errorCode?: string;
  closeCode?: number;
  closeReasonBytes?: number;
};

export type CodexAppServerSocketMultiplexerOptions = {
  upstreamPath: string;
  listenPath: string;
  maxBufferBytes?: number;
  onPrimaryInitialized?: () => void;
  onDiagnostic?: (event: CodexAppServerMultiplexerDiagnostic) => void;
  defaultsProjectionPath?: string;
  projectionPollIntervalMs?: number;
  primaryReplacementTimeoutMs?: number;
};

export type CodexAppServerSocketMultiplexer = {
  close(): Promise<void>;
};

function messageIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseJsonRpcMessage(data: RawData, maxBufferBytes: number): JsonRpcMessage {
  const buffer = rawDataBuffer(data);
  if (buffer.byteLength > maxBufferBytes) {
    throw new MessageRejectionError("message_too_large", buffer.byteLength);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new MessageRejectionError("invalid_json", buffer.byteLength);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MessageRejectionError("invalid_message", buffer.byteLength);
  }
  return parsed as JsonRpcMessage;
}

function websocketErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code.slice(0, 120) : undefined;
}

function websocketErrorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name.slice(0, 120) : undefined;
}

function isPayloadLimitError(error: unknown): boolean {
  return websocketErrorCode(error) === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
}

function writeMessage(socket: WebSocket, message: JsonRpcMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function responseForClient(message: JsonRpcMessage, id: JsonRpcId): JsonRpcMessage {
  const response = { ...message, id };
  delete response.method;
  delete response.params;
  return response;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, name: string): string | null {
  const value = record?.[name];
  return typeof value === "string" && value ? value : null;
}

type RuntimeMode = "build" | "plan";

function runtimeMode(params: unknown): RuntimeMode | null {
  const collaborationMode = asRecord(asRecord(params)?.collaborationMode);
  const mode = collaborationMode?.mode;
  if (mode === "default") return "build";
  if (mode === "plan") return "plan";
  return null;
}

function runtimePair(params: unknown): CodexCliModeDefaultPair | null {
  const record = asRecord(params);
  const collaborationSettings = asRecord(asRecord(record?.collaborationMode)?.settings);
  const modelId = stringField(record, "model") ?? stringField(collaborationSettings, "model");
  const reasoningEffort = stringField(record, "effort") ?? stringField(collaborationSettings, "reasoning_effort");
  return modelId && reasoningEffort ? { modelId, reasoningEffort } : null;
}

function rewriteModeParams(params: unknown, pair: CodexCliModeDefaultPair): Record<string, unknown> {
  const record = { ...(asRecord(params) ?? {}) };
  record.model = pair.modelId;
  record.effort = pair.reasoningEffort;
  const collaborationMode = asRecord(record.collaborationMode);
  if (collaborationMode) {
    record.collaborationMode = {
      ...collaborationMode,
      settings: {
        ...(asRecord(collaborationMode.settings) ?? {}),
        model: pair.modelId,
        reasoning_effort: pair.reasoningEffort
      }
    };
  }
  return record;
}

function rewriteCollaborationModes(
  message: JsonRpcMessage,
  projection: CodexCliModeDefaultsProjection | null
): JsonRpcMessage {
  if (!projection) return message;
  const result = asRecord(message.result);
  if (!result || !Array.isArray(result.data)) return message;
  return {
    ...message,
    result: {
      ...result,
      data: result.data.map((value) => {
        const preset = asRecord(value);
        const mode = preset?.mode === "default" ? "build" : preset?.mode === "plan" ? "plan" : null;
        if (!preset || !mode) return value;
        const pair = projection.defaults[mode];
        return {
          ...preset,
          model: pair.modelId,
          reasoning_effort: pair.reasoningEffort
        };
      })
    }
  };
}

function samePair(left: CodexCliModeDefaultPair | null, right: CodexCliModeDefaultPair): boolean {
  return left?.modelId === right.modelId && left.reasoningEffort === right.reasoningEffort;
}

export async function startCodexAppServerSocketMultiplexer(
  options: CodexAppServerSocketMultiplexerOptions
): Promise<CodexAppServerSocketMultiplexer> {
  if (!isAbsolute(options.upstreamPath) || !isAbsolute(options.listenPath)) {
    throw new Error("Codex App Server multiplexer socket paths must be absolute.");
  }
  if (options.upstreamPath === options.listenPath) {
    throw new Error("Codex App Server multiplexer sockets must be distinct.");
  }
  if (options.defaultsProjectionPath && !isAbsolute(options.defaultsProjectionPath)) {
    throw new Error("Codex App Server multiplexer projection path must be absolute.");
  }

  const maxBufferBytes = Math.max(1_024, options.maxBufferBytes ?? codexAppServerMultiplexerMaxBufferBytes);
  const primaryReplacementTimeoutMs = Math.max(1, options.primaryReplacementTimeoutMs ?? 10_000);
  const upstream = new WebSocket(`ws+unix://${options.upstreamPath}:/rpc`, {
    maxPayload: maxBufferBytes,
    perMessageDeflate: false
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      upstream.off("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      upstream.off("error", onError);
      resolve();
    };
    upstream.once("error", onError);
    upstream.once("open", onOpen);
  });

  await rm(options.listenPath, { force: true });
  const server: Server = createServer();
  const websocketServer = new WebSocketServer({
    server,
    maxPayload: maxBufferBytes,
    perMessageDeflate: false
  });
  const clients = new Map<number, ClientState>();
  const pending = new Map<string, PendingRequest>();
  const serverRequestIds = new Set<string>();
  const initializeWaiters: InitializeWaiter[] = [];
  let nextClientId = 0;
  let nextUpstreamRequestId = 1_000_000_000;
  let primaryClientId: number | null = null;
  let initializeUpstreamId: number | null = null;
  let cachedInitializeResponse: JsonRpcMessage | null = null;
  let upstreamInitialized = false;
  let primaryInitializedNotified = false;
  let closing = false;
  let primaryReplacementTimer: ReturnType<typeof setTimeout> | null = null;
  let serverClosePromise: Promise<void> | null = null;
  let projection: CodexCliModeDefaultsProjection | null = null;
  let projectionRefreshTail: Promise<void> = Promise.resolve();
  let currentThreadId: string | null = null;
  let currentMode: RuntimeMode | null = null;
  let currentPair: CodexCliModeDefaultPair | null = null;
  let manualPair: CodexCliModeDefaultPair | null = null;
  let preserveThreadPairUntilModeSwitch = false;
  let turnActive = false;
  let deferredPair: CodexCliModeDefaultPair | null = null;

  function nextRequestId(): number {
    const id = nextUpstreamRequestId;
    nextUpstreamRequestId += 1;
    if (nextUpstreamRequestId >= Number.MAX_SAFE_INTEGER) nextUpstreamRequestId = 1_000_000_000;
    return id;
  }

  function client(clientId: number): ClientState | undefined {
    return clients.get(clientId);
  }

  function emitDiagnostic(
    event: Omit<CodexAppServerMultiplexerDiagnostic, "schemaVersion" | "observedAt" | "maxBufferBytes" | "activeClientCount">
  ): void {
    try {
      options.onDiagnostic?.({
        schemaVersion: "CodexAppServerMultiplexerDiagnosticV1",
        observedAt: new Date().toISOString(),
        maxBufferBytes,
        activeClientCount: clients.size,
        ...event
      });
    } catch {
      // Diagnostics must never change transport behavior.
    }
  }

  function closeWithHandshake(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    if (socket.readyState === WebSocket.CLOSED) return;
    const forceClose = setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, 1_000);
    forceClose.unref();
  }

  function closeClients(code: number, reason: string): void {
    for (const state of clients.values()) closeWithHandshake(state.socket, code, reason);
    clients.clear();
  }

  function clearPrimaryReplacementTimer(): void {
    if (primaryReplacementTimer === null) return;
    clearTimeout(primaryReplacementTimer);
    primaryReplacementTimer = null;
  }

  function startPrimaryReplacementTimer(): void {
    clearPrimaryReplacementTimer();
    const timer = setTimeout(() => {
      if (primaryReplacementTimer !== timer || primaryClientId !== null || closing) return;
      primaryReplacementTimer = null;
      void closeServer();
      closeWithHandshake(upstream, 1001, "Primary Codex client replacement timed out.");
      closeClients(1001, "Primary Codex client replacement timed out.");
    }, primaryReplacementTimeoutMs);
    timer.unref();
    primaryReplacementTimer = timer;
  }

  function closeForUpstreamFailure(code: number, reason: string): void {
    clearPrimaryReplacementTimer();
    void closeServer();
    primaryClientId = null;
    closeClients(code, reason);
  }

  function closeServer(): Promise<void> {
    if (!serverClosePromise) {
      serverClosePromise = new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return serverClosePromise;
  }

  function projectionPair(mode = currentMode): CodexCliModeDefaultPair | null {
    return mode && projection ? projection.defaults[mode] : null;
  }

  function sendInternalSettings(pair: CodexCliModeDefaultPair): void {
    if (!currentThreadId || upstream.readyState !== WebSocket.OPEN) return;
    const upstreamId = nextRequestId();
    pending.set(messageIdKey(upstreamId), {
      clientId: null,
      clientRequestId: upstreamId,
      method: "thread/settings/update"
    });
    currentPair = pair;
    writeMessage(upstream, {
      id: upstreamId,
      method: "thread/settings/update",
      params: {
        threadId: currentThreadId,
        model: pair.modelId,
        effort: pair.reasoningEffort
      }
    });
  }

  function scheduleProjectionPair(pair: CodexCliModeDefaultPair): void {
    if (turnActive) {
      deferredPair = pair;
      return;
    }
    deferredPair = null;
    if (!samePair(currentPair, pair)) sendInternalSettings(pair);
  }

  async function refreshProjection(applyToThread: boolean): Promise<void> {
    if (!options.defaultsProjectionPath) return;
    try {
      const next = codexCliModeDefaultsProjectionSchema.parse(
        JSON.parse(await readFile(options.defaultsProjectionPath, "utf8"))
      );
      if (projection?.revision === next.revision) return;
      projection = next;
      if (
        applyToThread &&
        currentMode &&
        currentThreadId &&
        !manualPair &&
        !preserveThreadPairUntilModeSwitch
      ) {
        scheduleProjectionPair(next.defaults[currentMode]);
      }
    } catch {
      // Keep the last valid projection. Atomic writers may briefly expose no readable replacement.
    }
  }

  function queueProjectionRefresh(): void {
    projectionRefreshTail = projectionRefreshTail.then(
      () => refreshProjection(true),
      () => refreshProjection(true)
    );
  }

  function resetThreadState(preservePair: boolean, threadId: string | null): void {
    currentThreadId = threadId;
    currentMode = null;
    currentPair = null;
    manualPair = null;
    preserveThreadPairUntilModeSwitch = preservePair;
    turnActive = false;
    deferredPair = null;
  }

  function rewriteRuntimeMessage(message: JsonRpcMessage): JsonRpcMessage {
    const params = asRecord(message.params);
    const threadId = stringField(params, "threadId");
    if (threadId) currentThreadId = threadId;

    if (message.method === "thread/start") {
      resetThreadState(false, threadId);
      return message;
    }
    if (message.method === "thread/resume" || message.method === "thread/fork") {
      resetThreadState(true, threadId);
      return message;
    }
    if (message.method !== "thread/settings/update" && message.method !== "turn/start") return message;

    const mode = runtimeMode(params);
    if (!mode) {
      const pair = runtimePair(params);
      if (pair) {
        manualPair = pair;
        currentPair = pair;
      }
      return message;
    }

    const switched = currentMode !== null && currentMode !== mode;
    if (currentMode === null) currentMode = mode;
    if (switched) {
      currentMode = mode;
      manualPair = null;
      preserveThreadPairUntilModeSwitch = false;
    }

    if (preserveThreadPairUntilModeSwitch && !switched) {
      currentPair = runtimePair(params) ?? currentPair;
      return message;
    }

    const pair = manualPair ?? projectionPair(mode);
    if (!pair) return message;
    if (turnActive && switched) {
      deferredPair = pair;
      return currentPair ? { ...message, params: rewriteModeParams(params, currentPair) } : message;
    }
    currentPair = pair;
    deferredPair = null;
    return { ...message, params: rewriteModeParams(params, pair) };
  }

  function routeInitializeResponse(message: JsonRpcMessage): void {
    cachedInitializeResponse = { ...message };
    delete cachedInitializeResponse.id;
    for (const waiter of initializeWaiters.splice(0)) {
      const state = client(waiter.clientId);
      if (state) writeMessage(state.socket, responseForClient(cachedInitializeResponse, waiter.clientRequestId));
    }
    initializeUpstreamId = null;
  }

  function handleUpstreamMessage(message: JsonRpcMessage): void {
    if (message.method) {
      if (message.method === "turn/started") {
        turnActive = true;
        currentThreadId = stringField(asRecord(message.params), "threadId") ?? currentThreadId;
      } else if (message.method === "turn/completed") {
        turnActive = false;
        currentThreadId = stringField(asRecord(message.params), "threadId") ?? currentThreadId;
        if (deferredPair) {
          const pair = deferredPair;
          deferredPair = null;
          sendInternalSettings(pair);
        }
      }
      if (message.id !== undefined) {
        if (primaryClientId === null) return;
        const primary = client(primaryClientId);
        if (!primary) return;
        serverRequestIds.add(messageIdKey(message.id));
        writeMessage(primary.socket, message);
        return;
      }
      for (const state of clients.values()) writeMessage(state.socket, message);
      return;
    }
    if (message.id === undefined) return;
    if (initializeUpstreamId !== null && message.id === initializeUpstreamId) {
      routeInitializeResponse(message);
      return;
    }
    const key = messageIdKey(message.id);
    const request = pending.get(key);
    if (!request) return;
    pending.delete(key);
    if (request.method === "thread/start" || request.method === "thread/resume" || request.method === "thread/fork") {
      currentThreadId = stringField(asRecord(asRecord(message.result)?.thread), "id") ?? currentThreadId;
    }
    if (request.clientId === null) return;
    const state = client(request.clientId);
    if (state) {
      const response = request.method === "collaborationMode/list"
        ? rewriteCollaborationModes(message, projection)
        : message;
      writeMessage(state.socket, responseForClient(response, request.clientRequestId));
    }
  }

  function sendInitialize(clientId: number, message: JsonRpcMessage): void {
    if (message.id === undefined) return;
    const waiter = { clientId, clientRequestId: message.id };
    if (cachedInitializeResponse) {
      const state = client(clientId);
      if (state) writeMessage(state.socket, responseForClient(cachedInitializeResponse, message.id));
      return;
    }
    initializeWaiters.push(waiter);
    if (initializeUpstreamId !== null) return;
    initializeUpstreamId = nextRequestId();
    writeMessage(upstream, { ...message, id: initializeUpstreamId });
  }

  function handleClientMessage(state: ClientState, message: JsonRpcMessage): void {
    if (message.method === "initialize") {
      if (state.initializeRequested) {
        state.socket.close(1008, "Client role is already initialized.");
        return;
      }
      state.initializeRequested = true;
      state.clientName = stringField(asRecord(asRecord(message.params)?.clientInfo), "name");
      sendInitialize(state.id, message);
      return;
    }
    if (message.method === "initialized") {
      if (
        primaryClientId === null &&
        primaryReplacementTimer !== null &&
        state.primaryReplacementEligible &&
        state.initializeRequested &&
        cachedInitializeResponse
      ) {
        primaryClientId = state.id;
        state.primaryReplacementEligible = false;
        clearPrimaryReplacementTimer();
      }
      if (!upstreamInitialized && state.id === primaryClientId) {
        upstreamInitialized = true;
        writeMessage(upstream, message);
        if (!primaryInitializedNotified) {
          primaryInitializedNotified = true;
          options.onPrimaryInitialized?.();
        }
      }
      return;
    }
    if (message.method) {
      if (message.id === undefined) {
        if (state.id !== primaryClientId) {
          state.socket.close(1008, "Secondary notifications are not allowed.");
          return;
        }
        writeMessage(upstream, message);
        return;
      }
      if (state.id !== primaryClientId) {
        try {
          if (state.clientName === "space") {
            assertCodexAppServerSocketRpcMethodAllowed(message.method);
          } else if (!readOnlySecondaryRpcMethods.has(message.method)) {
            throw new Error("Secondary picker RPC method is not allowed.");
          }
        } catch {
          state.socket.close(1008, "RPC method is not allowed.");
          return;
        }
      }
      const upstreamId = nextRequestId();
      pending.set(messageIdKey(upstreamId), {
        clientId: state.id,
        clientRequestId: message.id,
        method: message.method
      });
      writeMessage(upstream, { ...rewriteRuntimeMessage(message), id: upstreamId });
      return;
    }
    if (
      state.id === primaryClientId &&
      message.id !== undefined &&
      serverRequestIds.delete(messageIdKey(message.id))
    ) {
      writeMessage(upstream, message);
    }
  }

  upstream.on("message", (data, isBinary) => {
    try {
      if (isBinary) throw new MessageRejectionError("binary_message", rawDataBuffer(data).byteLength);
      handleUpstreamMessage(parseJsonRpcMessage(data, maxBufferBytes));
    } catch (error) {
      const rejection = error instanceof MessageRejectionError ? error : null;
      const failureKind = rejection?.failureKind ?? "transport_error";
      const closeCode = failureKind === "message_too_large" ? 1009 : failureKind === "transport_error" ? 1011 : 1007;
      emitDiagnostic({
        event: "codex_app_server_multiplexer_transport_failure",
        branch: "upstream_message",
        failureKind,
        ...(rejection ? { messageBytes: rejection.messageBytes } : {}),
        ...(!rejection ? { errorName: websocketErrorName(error), errorCode: websocketErrorCode(error) } : {})
      });
      closeWithHandshake(upstream, closeCode, "Multiplexer rejected upstream message.");
      closeForUpstreamFailure(closeCode, "Upstream app-server message rejected.");
    }
  });
  upstream.on("close", (code, reason) => {
    if (closing) return;
    emitDiagnostic({
      event: "codex_app_server_multiplexer_transport_closed",
      branch: "upstream_close",
      failureKind: "transport_closed",
      closeCode: code,
      closeReasonBytes: reason.byteLength
    });
    closeForUpstreamFailure(code === 1009 ? 1009 : 1011, "Upstream app-server transport closed.");
  });
  upstream.on("error", (error) => {
    if (closing) return;
    const payloadLimit = isPayloadLimitError(error);
    emitDiagnostic({
      event: "codex_app_server_multiplexer_transport_failure",
      branch: "upstream_error",
      failureKind: payloadLimit ? "message_too_large" : "transport_error",
      errorName: websocketErrorName(error),
      errorCode: websocketErrorCode(error)
    });
    closeForUpstreamFailure(payloadLimit ? 1009 : 1011, payloadLimit
      ? "Upstream app-server message exceeded limit."
      : "Upstream app-server transport failed.");
  });

  websocketServer.on("connection", (socket) => {
    const awaitingPrimaryReplacement = primaryClientId === null && primaryReplacementTimer !== null;
    const state: ClientState = {
      id: ++nextClientId,
      socket,
      clientName: null,
      primaryReplacementEligible: awaitingPrimaryReplacement,
      initializeRequested: false
    };
    clients.set(state.id, state);
    if (primaryClientId === null && !awaitingPrimaryReplacement) primaryClientId = state.id;
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new MessageRejectionError("binary_message", rawDataBuffer(data).byteLength);
        handleClientMessage(state, parseJsonRpcMessage(data, maxBufferBytes));
      } catch (error) {
        const rejection = error instanceof MessageRejectionError ? error : null;
        const failureKind = rejection?.failureKind ?? "transport_error";
        const closeCode = failureKind === "message_too_large" ? 1009 : failureKind === "transport_error" ? 1011 : 1007;
        emitDiagnostic({
          event: "codex_app_server_multiplexer_transport_failure",
          branch: "client_message",
          failureKind,
          clientId: state.id,
          clientRole: state.id === primaryClientId ? "primary" : "secondary",
          ...(rejection ? { messageBytes: rejection.messageBytes } : {}),
          ...(!rejection ? { errorName: websocketErrorName(error), errorCode: websocketErrorCode(error) } : {})
        });
        closeWithHandshake(socket, closeCode, "Multiplexer rejected client message.");
      }
    });
    socket.on("close", (code, reason) => {
      clients.delete(state.id);
      for (const [id, request] of pending) {
        if (request.clientId === state.id) pending.delete(id);
      }
      for (let index = initializeWaiters.length - 1; index >= 0; index -= 1) {
        if (initializeWaiters[index]?.clientId === state.id) initializeWaiters.splice(index, 1);
      }
      if (primaryClientId === state.id) {
        primaryClientId = null;
        serverRequestIds.clear();
        if (!closing) {
          emitDiagnostic({
            event: "codex_app_server_multiplexer_transport_closed",
            branch: "primary_client_close",
            failureKind: "primary_client_closed",
            clientId: state.id,
            clientRole: "primary",
            closeCode: code,
            closeReasonBytes: reason.byteLength
          });
          startPrimaryReplacementTimer();
        }
      }
    });
    socket.on("error", (error) => {
      if (closing) return;
      emitDiagnostic({
        event: "codex_app_server_multiplexer_transport_failure",
        branch: "client_error",
        failureKind: isPayloadLimitError(error) ? "message_too_large" : "transport_error",
        clientId: state.id,
        clientRole: state.id === primaryClientId ? "primary" : "secondary",
        errorName: websocketErrorName(error),
        errorCode: websocketErrorCode(error)
      });
    });
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
    server.listen(options.listenPath);
  });

  await refreshProjection(false);
  const projectionListener = () => queueProjectionRefresh();
  if (options.defaultsProjectionPath) {
    watchFile(options.defaultsProjectionPath, {
      interval: Math.max(10, options.projectionPollIntervalMs ?? 250),
      persistent: false
    }, projectionListener);
  }

  return {
    async close() {
      if (closing) return;
      closing = true;
      clearPrimaryReplacementTimer();
      if (options.defaultsProjectionPath) unwatchFile(options.defaultsProjectionPath, projectionListener);
      await projectionRefreshTail;
      closeClients(1001, "Multiplexer shutting down.");
      closeWithHandshake(upstream, 1001, "Multiplexer shutting down.");
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
      await closeServer();
      await rm(options.listenPath, { force: true });
    }
  };
}
