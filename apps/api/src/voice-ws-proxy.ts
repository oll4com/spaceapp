import { randomUUID } from "node:crypto";
import type { WebSocket, RawData } from "ws";

// Centralized transport safety limits, not model, price or personal defaults.
export const voiceProxyLimits = {
  ticketTtlMs: 120_000,
  maxPending: 256,
  maxPendingPerOwner: 16,
  maxFrameBytes: 64 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxBufferedMessages: 128,
  connectTimeoutMs: 15_000
};

export interface VoiceProxyTicket {
  ownerId: string;
  origin: string;
  wsUrl: string;
  provider: string;
  subprotocols?: string[];
  token?: string;
}

export class VoiceProxyTickets {
  private readonly tickets = new Map<string, VoiceProxyTicket & { expiresAt: number }>();
  constructor(private readonly limits = voiceProxyLimits, private readonly now = Date.now) {}
  private prune() {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id);
  }
  create(ticket: VoiceProxyTicket): string {
    this.prune();
    if (!ticket.ownerId || !ticket.origin) throw new Error("An authenticated owner and origin are required for voice sessions.");
    if (this.tickets.size >= this.limits.maxPending || [...this.tickets.values()].filter(entry => entry.ownerId === ticket.ownerId).length >= this.limits.maxPendingPerOwner) {
      throw new Error("Too many pending voice sessions. Connect or wait for existing sessions to expire.");
    }
    const id = `vws_${randomUUID()}`;
    this.tickets.set(id, { ...ticket, expiresAt: this.now() + this.limits.ticketTtlMs });
    return id;
  }
  take(id: string, ownerId: string, origin: string): VoiceProxyTicket | undefined {
    this.prune();
    const ticket = this.tickets.get(id);
    // A foreign caller cannot consume someone else's ticket.
    if (!ticket || ticket.ownerId !== ownerId || ticket.origin !== origin) return undefined;
    this.tickets.delete(id);
    return ticket;
  }
  clear() { this.tickets.clear(); }
}

/** Relay bytes unchanged. Diagnostics contain counts/reasons, never payloads. */
export function relayVoiceSockets(client: WebSocket, upstream: WebSocket, options: {
  limits?: typeof voiceProxyLimits;
  // `upstreamCloseCode` is the numeric WebSocket close code the provider sent
  // (1007 payload rejected, 1008 policy, ...). It is a small integer, never the
  // provider's close reason text, so it is safe to log while staying diagnosable.
  onClose?: (metadata: { reason: string; clientMessages: number; upstreamMessages: number; upstreamCloseCode: number | null }) => void;
} = {}): () => void {
  const limits = options.limits ?? voiceProxyLimits;
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];
  let pendingBytes = 0;
  let stopped = false;
  let clientMessages = 0;
  let upstreamMessages = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timer.unref?.(); timers.add(timer); return timer;
  };
  const closeSocket = (socket: WebSocket, code: number, reason: string) => {
    if (socket.readyState === 3) return;
    if (socket.readyState === 0) { socket.terminate(); return; }
    socket.close(code, reason);
    const timer = later(() => { if (socket.readyState !== 3) socket.terminate(); }, 1000);
    socket.once("close", () => { clearTimeout(timer); timers.delete(timer); });
  };
  const stop = (reason: string, code = 1011, metadata: { upstreamCloseCode?: number | null } = {}) => {
    if (stopped) return;
    stopped = true;
    pending.length = 0; pendingBytes = 0;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    closeSocket(client, code, reason);
    closeSocket(upstream, code, reason);
    options.onClose?.({ reason, clientMessages, upstreamMessages, upstreamCloseCode: metadata.upstreamCloseCode ?? null });
  };
  const timeout = later(() => stop("upstream_connect_timeout"), limits.connectTimeoutMs);
  const size = (data: RawData) => Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
  const send = (target: WebSocket, data: RawData, isBinary: boolean) => {
    if (stopped) return;
    if (target.readyState !== 1) { stop("relay_peer_unavailable"); return; }
    if (size(data) > limits.maxFrameBytes || target.bufferedAmount + size(data) > limits.maxBufferedBytes) {
      stop("voice_transport_limit", 1009); return;
    }
    try { target.send(data, { binary: isBinary }, error => { if (error) stop("relay_send_failed"); }); }
    catch { stop("relay_send_failed"); }
  };
  upstream.on("open", () => {
    clearTimeout(timeout); timers.delete(timeout);
    if (stopped) return;
    for (const item of pending) send(upstream, item.data, item.isBinary);
    pending.length = 0; pendingBytes = 0;
  });
  client.on("message", (data: RawData, isBinary: boolean) => {
    if (stopped) return;
    clientMessages++;
    if (size(data) > limits.maxFrameBytes) { stop("voice_frame_too_large", 1009); return; }
    if (upstream.readyState === 0) {
      if (pending.length >= limits.maxBufferedMessages || pendingBytes + size(data) > limits.maxBufferedBytes) {
        stop("voice_connect_buffer_limit", 1009); return;
      }
      pending.push({ data, isBinary }); pendingBytes += size(data);
    } else send(upstream, data, isBinary);
  });
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    if (stopped) return;
    upstreamMessages++;
    send(client, data, isBinary);
  });
  // Never copy provider close reasons or connection errors into logs: these
  // may contain URLs, credentials or private instruction fragments.
  client.on("close", () => stop("client_closed", 1000));
  // A provider/upstream close is not a normal client shutdown.  Forwarding
  // code 1000 made the browser report a misleading clean disconnect and
  // prevented the Live pane from distinguishing relay failure from End.
  upstream.on("close", (code: number) => {
    // Keep the numeric close code only; provider reasons may echo private content.
    stop("upstream_closed", 1011, { upstreamCloseCode: Number.isInteger(code) ? code : null });
  });
  client.on("error", () => stop("client_error"));
  upstream.on("error", () => stop("upstream_error"));
  return () => stop("server_shutdown", 1001);
}
