import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
  AcquireBrowserControlInput,
  BrowserCaptureJob,
  BrowserCaptureOptions,
  BrowserControlLease,
  BrowserControlLeaseActionInput,
  BrowserFrame,
  BrowserSessionViewport,
  BrowserStreamMode,
  BrowserToolActionInput,
  BrowserToolActionResult,
  Pane,
  PaneBrowserSessionResponse
} from "@space/contracts";
import { BrowserHostError } from "./errors.js";
import { BrowserHostFrameDecoder, encodeBrowserHostFrame } from "./framing.js";
import type {
  BrowserHostActionContext,
  BrowserHostActorContext,
  BrowserHostAudioChunk,
  BrowserHostAudioStreamHandle,
  BrowserHostBinaryFrame,
  BrowserHostCaptureContext,
  BrowserHostDiagnostics,
  BrowserHostHealth,
  BrowserHostPageList,
  BrowserHostRuntimeInput,
  BrowserHostStartInput,
  BrowserHostStreamHandle,
  BrowserHostStreamHints,
  BrowserHostStreamProfile
} from "./types.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  socket: Socket;
}

export class BrowserHostClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private decoder = new BrowserHostFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streamListeners = new Map<string, (frame: BrowserHostBinaryFrame) => void | Promise<void>>();
  private readonly earlyFrames = new Map<string, BrowserHostBinaryFrame[]>();
  private readonly audioListeners = new Map<string, (chunk: BrowserHostAudioChunk) => void | Promise<void>>();
  private readonly earlyAudio = new Map<string, BrowserHostAudioChunk[]>();

  constructor(private readonly options: {
    socketPath: string;
    requestTimeoutMs?: number;
    healthTimeoutMs?: number;
    connectTimeoutMs?: number;
    closeTimeoutMs?: number;
  }) {}

  health(): Promise<BrowserHostHealth> { return this.request("health", {}, this.options.healthTimeoutMs) as Promise<BrowserHostHealth>; }
  startOrRestore(input: BrowserHostStartInput, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> { return this.request("startOrRestore", { input, context }) as Promise<PaneBrowserSessionResponse>; }
  getActive(pane: Pane): Promise<PaneBrowserSessionResponse | null> { return this.request("getActive", { pane }) as Promise<PaneBrowserSessionResponse | null>; }
  navigate(pane: Pane, url: string, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> { return this.request("navigate", { pane, url, traceId, context }) as Promise<PaneBrowserSessionResponse>; }
  setViewport(pane: Pane, viewport: BrowserSessionViewport, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> { return this.request("setViewport", { pane, viewport, traceId, context }) as Promise<PaneBrowserSessionResponse>; }
  setStreamMode(pane: Pane, mode: BrowserStreamMode, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> { return this.request("setStreamMode", { pane, mode, traceId, context }) as Promise<PaneBrowserSessionResponse>; }
  action(pane: Pane, input: BrowserToolActionInput, traceId: string, context?: BrowserHostActionContext): Promise<BrowserToolActionResult> {
    const timeoutMs = input.type === "record"
      ? Math.min(45 * 60_000, input.durationMs + Math.min(10 * 60_000, input.durationMs * 2) + 60_000)
      : undefined;
    return this.request("action", { pane, input, traceId, context }, timeoutMs) as Promise<BrowserToolActionResult>;
  }
  captureFrame(sessionId: string): Promise<BrowserFrame> { return this.request("captureFrame", { sessionId }) as Promise<BrowserFrame>; }
  async stopPane(paneId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void> { await this.request("stopPane", { paneId, traceId, context }); }
  async stopRoom(roomId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void> { await this.request("stopRoom", { roomId, traceId, context }); }
  listPages(pane: Pane): Promise<BrowserHostPageList> { return this.request("listPages", { pane }) as Promise<BrowserHostPageList>; }
  createPage(pane: Pane, url: string | undefined, activate: boolean, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList> { return this.request("createPage", { pane, url, activate, traceId, context }) as Promise<BrowserHostPageList>; }
  activatePage(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList> { return this.request("activatePage", { pane, pageId, traceId, context }) as Promise<BrowserHostPageList>; }
  closePage(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList> { return this.request("closePage", { pane, pageId, traceId, context }) as Promise<BrowserHostPageList>; }
  acquireControl(pane: Pane, input: AcquireBrowserControlInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease> { return this.request("acquireControl", { pane, input, traceId, context }) as Promise<BrowserControlLease>; }
  heartbeatControl(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease> { return this.request("heartbeatControl", { pane, input, traceId, context }) as Promise<BrowserControlLease>; }
  releaseControl(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease> { return this.request("releaseControl", { pane, input, traceId, context }) as Promise<BrowserControlLease>; }
  async dispatchInput(pane: Pane, input: BrowserHostRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<void> { await this.request("dispatchInput", { pane, input, traceId, context }); }
  input(pane: Pane, input: BrowserHostRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> { return this.request("input", { pane, input, traceId, context }) as Promise<PaneBrowserSessionResponse>; }
  createCapture(pane: Pane, options: BrowserCaptureOptions, context: BrowserHostCaptureContext): Promise<BrowserCaptureJob> { return this.request("createCapture", { pane, options, context }) as Promise<BrowserCaptureJob>; }
  getCapture(pane: Pane, jobId: string): Promise<BrowserCaptureJob> { return this.request("getCapture", { pane, jobId }) as Promise<BrowserCaptureJob>; }
  stopCapture(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob> { return this.request("stopCapture", { pane, jobId, traceId, context }) as Promise<BrowserCaptureJob>; }
  cancelCapture(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob> { return this.request("cancelCapture", { pane, jobId, traceId, context }) as Promise<BrowserCaptureJob>; }
  diagnostics(pane: Pane, includeNetwork: boolean, limit: number): Promise<BrowserHostDiagnostics> { return this.request("diagnostics", { pane, includeNetwork, limit }) as Promise<BrowserHostDiagnostics>; }

  async startFrameStream(
    sessionId: string,
    mode: BrowserStreamMode,
    onFrame: (frame: BrowserHostBinaryFrame) => void | Promise<void>,
    hints: BrowserHostStreamHints = {}
  ): Promise<BrowserHostStreamHandle> {
    const started = await this.request("startFrameStream", { sessionId, mode, hints }) as { id: string; profile: BrowserHostStreamProfile };
    this.streamListeners.set(started.id, onFrame);
    for (const frame of this.earlyFrames.get(started.id) ?? []) void onFrame(frame);
    this.earlyFrames.delete(started.id);
    let stopped = false;
    return {
      ...started,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.streamListeners.delete(started.id);
        this.earlyFrames.delete(started.id);
        await this.request("stopFrameStream", { subscriptionId: started.id });
      }
    };
  }

  async startAudioStream(
    sessionId: string,
    onChunk: (chunk: BrowserHostAudioChunk) => void | Promise<void>
  ): Promise<BrowserHostAudioStreamHandle> {
    const started = await this.request("startAudioStream", { sessionId }) as { id: string; sampleRate: number; channels: number; format: "s16le" };
    this.audioListeners.set(started.id, onChunk);
    for (const chunk of this.earlyAudio.get(started.id) ?? []) void onChunk(chunk);
    this.earlyAudio.delete(started.id);
    let stopped = false;
    return {
      ...started,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.audioListeners.delete(started.id);
        this.earlyAudio.delete(started.id);
        await this.request("stopAudioStream", { subscriptionId: started.id });
      }
    };
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy();
          resolve();
        }, this.options.closeTimeoutMs ?? 1_000);
        timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.end();
      });
    }
    this.rejectPending(new BrowserHostError("BROWSER_HOST_TRANSPORT_CLOSED", "Browser host transport closed."));
    this.streamListeners.clear();
    this.earlyFrames.clear();
    this.audioListeners.clear();
    this.earlyAudio.clear();
  }

  private async request(method: string, params: Record<string, unknown>, timeoutOverrideMs?: number): Promise<unknown> {
    const socket = await this.connect();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutOverrideMs ?? this.options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BrowserHostError(
          "BROWSER_HOST_TIMEOUT",
          `Browser host ${method} request timed out after ${timeoutMs}ms.`,
          { method, timeoutMs }
        ));
        // The server processes requests serially per connection. If a request
        // hung (e.g. a CDP call against a crashed Chrome), every later request
        // on the same socket would keep timing out. Drop the socket so the
        // next request reconnects on a fresh, unblocked connection.
        if (this.socket === socket && !socket.destroyed) socket.destroy();
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, socket });
      socket.write(encodeBrowserHostFrame({ kind: "request", requestId, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.decoder = new BrowserHostFrameDecoder();
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new BrowserHostError("BROWSER_HOST_CONNECT_TIMEOUT", "Timed out connecting to the Browser Host."));
      }, this.options.connectTimeoutMs ?? 3_000);
      timer.unref();
      const onError = (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        reject(new BrowserHostError("BROWSER_HOST_UNAVAILABLE", "Could not connect to the Browser Host.", { causeCode: error.code }));
      };
      const onConnect = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        this.socket = socket;
        this.installSocketHandlers(socket);
        resolve(socket);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  private installSocketHandlers(socket: Socket): void {
    socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) this.handleMessage(message);
      } catch (error) { socket.destroy(error as Error); }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      // Reject only the requests that were in flight on this connection. The
      // client may have already reconnected on a fresh socket after a timeout
      // drop, so the stale connection must not tear those pending requests down.
      this.rejectPendingFor(socket, new BrowserHostError("BROWSER_HOST_TRANSPORT_CLOSED", "Browser host transport closed."));
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const envelope = message as Record<string, unknown>;
    if (envelope.kind === "response" && typeof envelope.requestId === "string") {
      const pending = this.pending.get(envelope.requestId);
      if (!pending) return;
      this.pending.delete(envelope.requestId);
      clearTimeout(pending.timer);
      if (envelope.ok === true) pending.resolve(envelope.result);
      else {
        const error = (envelope.error ?? {}) as Record<string, unknown>;
        pending.reject(new BrowserHostError(
          typeof error.code === "string" ? error.code : "BROWSER_HOST_REQUEST_FAILED",
          typeof error.message === "string" ? error.message : "Browser host request failed.",
          error.details
        ));
      }
      return;
    }
    if (envelope.kind !== "event" || typeof envelope.subscriptionId !== "string") return;
    const event = (envelope.event ?? {}) as Record<string, unknown>;
    const dataBase64 = event.dataBase64;
    if (typeof dataBase64 !== "string") return;
    const data = Buffer.from(dataBase64, "base64");
    const audioListener = this.audioListeners.get(envelope.subscriptionId);
    if (audioListener) {
      const chunk = { ...event, data } as unknown as BrowserHostAudioChunk;
      delete (chunk as unknown as Record<string, unknown>).dataBase64;
      void audioListener(chunk);
      return;
    }
    const frame = { ...event, data } as unknown as BrowserHostBinaryFrame;
    delete (frame as unknown as Record<string, unknown>).dataBase64;
    const listener = this.streamListeners.get(envelope.subscriptionId);
    if (listener) void listener(frame);
    else {
      const queued = this.earlyFrames.get(envelope.subscriptionId) ?? [];
      if (queued.length < 4) queued.push(frame);
      this.earlyFrames.set(envelope.subscriptionId, queued);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectPendingFor(socket: Socket, error: Error): void {
    const keys: string[] = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      keys.push(requestId);
    }
    for (const key of keys) this.pending.delete(key);
  }
}
