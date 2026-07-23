import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { encodeLengthPrefixedJson, LengthPrefixedJsonDecoder } from "./framing.js";
import { CliHostError } from "./session-registry.js";
import type {
  CliHostAttachInput,
  CliHostAttachResult,
  CliHostEvent,
  CliHostEventListener,
  CliHostIdentity,
  CliHostInputResult,
  CliHostReapResult,
  CliHostSessionSummary
} from "./types.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

// The host retains at most 8 MiB of raw PTY output, but JSON escaping and replay
// metadata can make a valid attach response substantially larger on the wire.
const maximumCliHostResponseFrameBytes = 64 * 1024 * 1024;

export interface CliHostHealth {
  hostPid: number;
  startedAt: string;
  buildCommit: string | null;
  sessions: CliHostSessionSummary[];
}

export class CliHostClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private decoder = new LengthPrefixedJsonDecoder(maximumCliHostResponseFrameBytes);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, CliHostEventListener>();
  private readonly earlyEvents = new Map<string, CliHostEvent[]>();

  constructor(private readonly options: { socketPath: string }) {}

  async health(): Promise<CliHostHealth> {
    return this.request("inspect", {}) as Promise<CliHostHealth>;
  }

  async inspect(identity: CliHostIdentity): Promise<CliHostSessionSummary | null> {
    return this.request("inspect", { identity }) as Promise<CliHostSessionSummary | null>;
  }

  async attach(input: CliHostAttachInput, listener?: CliHostEventListener): Promise<CliHostAttachResult> {
    const attached = (await this.request("attach", input as unknown as Record<string, unknown>)) as CliHostAttachResult;
    if (listener) {
      this.listeners.set(attached.attachmentId, listener);
      for (const event of this.earlyEvents.get(attached.attachmentId) ?? []) listener(event);
      this.earlyEvents.delete(attached.attachmentId);
    }
    return attached;
  }

  async input(
    identity: CliHostIdentity,
    attachmentId: string,
    data: string,
    display: "visible" | "hidden" = "visible",
    idempotencyKey?: string
  ): Promise<CliHostInputResult> {
    return this.request("input", { identity, attachmentId, data, display, idempotencyKey }) as Promise<CliHostInputResult>;
  }

  async resize(identity: CliHostIdentity, attachmentId: string, cols: number, rows: number): Promise<void> {
    await this.request("resize", { identity, attachmentId, cols, rows });
  }

  async detach(identity: CliHostIdentity, attachmentId: string): Promise<boolean> {
    const detached = (await this.request("detach", { identity, attachmentId })) as boolean;
    this.listeners.delete(attachmentId);
    this.earlyEvents.delete(attachmentId);
    return detached;
  }

  async terminate(identity: CliHostIdentity): Promise<boolean> {
    return this.request("terminate", { identity }) as Promise<boolean>;
  }

  async reapDetached(): Promise<CliHostReapResult> {
    return this.request("reapDetached", {}) as Promise<CliHostReapResult>;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      });
    }
    this.rejectPending(new CliHostError("CLI_HOST_TRANSPORT_CLOSED", "CLI host transport closed."));
    this.listeners.clear();
    this.earlyEvents.clear();
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = await this.connect();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      socket.write(encodeLengthPrefixedJson({ kind: "request", requestId, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.decoder = new LengthPrefixedJsonDecoder(maximumCliHostResponseFrameBytes);
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        this.socket = socket;
        this.installSocketHandlers(socket);
        resolve(socket);
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private installSocketHandlers(socket: Socket): void {
    socket.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        socket.destroy(error as Error);
        return;
      }
      for (const message of messages) this.handleMessage(message);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.rejectPending(new CliHostError("CLI_HOST_TRANSPORT_CLOSED", "CLI host transport closed."));
    });
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const envelope = message as Record<string, unknown>;
    if (envelope.kind === "response" && typeof envelope.requestId === "string") {
      const pending = this.pending.get(envelope.requestId);
      if (!pending) return;
      this.pending.delete(envelope.requestId);
      if (envelope.ok === true) pending.resolve(envelope.result);
      else {
        const error = (envelope.error ?? {}) as Record<string, unknown>;
        pending.reject(
          new CliHostError(
            typeof error.code === "string" ? error.code : "CLI_HOST_REQUEST_FAILED",
            typeof error.message === "string" ? error.message : "CLI host request failed."
          )
        );
      }
      return;
    }
    if (envelope.kind !== "event" || typeof envelope.attachmentId !== "string") return;
    const event = envelope.event as CliHostEvent;
    const listener = this.listeners.get(envelope.attachmentId);
    if (listener) listener(event);
    else {
      const queued = this.earlyEvents.get(envelope.attachmentId) ?? [];
      queued.push(event);
      this.earlyEvents.set(envelope.attachmentId, queued);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
