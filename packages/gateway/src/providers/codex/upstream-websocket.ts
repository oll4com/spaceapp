import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
import { isTerminalEvent } from "./stream.js";

/**
 * Codex Responses over WebSocket to ChatGPT, after codex-lb `proxy_websocket.py` (MIT, Soju06/codex-lb): the same
 * events as the SSE stream, one JSON text frame each, after a `response.create` frame that carries the request.
 */
export const RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06";
/** codex-lb `UPSTREAM_WS_TRANSPORT_FAILURE_TTL_SECONDS`: after a failed open, WebSocket stays off for 60 s. */
export const UPSTREAM_WS_FAILURE_TTL_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
/** One upstream event (a final `response.completed` carries the whole output). */
const MAX_UPSTREAM_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export const upstreamWebSocketUrl = (httpUrl: string) => httpUrl.replace(/^http/i, "ws");

/** The HTTP upstream headers for a WebSocket open: no body headers, and the WebSocket beta added once. */
export function upstreamWebSocketHeaders(httpHeaders: Record<string, string>): Record<string, string> {
  const headers = { ...httpHeaders };
  delete headers.accept;
  delete headers["content-type"];
  const beta = (headers["openai-beta"] ?? "").split(",").map((token) => token.trim()).filter((token) => token && token !== "responses=experimental");
  if (!beta.includes(RESPONSES_WEBSOCKETS_BETA)) beta.push(RESPONSES_WEBSOCKETS_BETA);
  headers["openai-beta"] = beta.join(", ");
  return headers;
}

/**
 * A failed WebSocket open. `transport` marks failures of the transport itself (timeout, network, 5xx, an edge
 * challenge), which turn WebSocket off for a while; an answer such as 401 or 429 is about the account instead.
 */
export class UpstreamHandshakeError extends Error {
  constructor(readonly status: number, readonly body: string | null, message: string, readonly transport: boolean) {
    super(message);
  }
}

/** Process-wide upstream WebSocket health (codex-lb's single failure timestamp). */
export class UpstreamWebSocketHealth {
  private failedAt: number | null = null;
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = UPSTREAM_WS_FAILURE_TTL_MS) {}
  markFailure() { this.failedAt = this.now(); }
  markSuccess() { this.failedAt = null; }
  coolingDown() { return this.failedAt !== null && this.now() - this.failedAt < this.ttlMs; }
}

export interface OpenedUpstream {
  socket: WebSocket;
  /** `x-codex-turn-state` from the handshake, sent again on later reconnects. */
  turnState: string | null;
  headers: IncomingHttpHeaders;
}

const edgeChallenge = (body: string | null) => Boolean(body && /<html|cf-chl|challenge-platform|just a moment/i.test(body));

export function openUpstreamWebSocket(url: string, headers: Record<string, string>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OpenedUpstream> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new UpstreamHandshakeError(0, null, "The request was cancelled.", false)); return; }
    const socket = new WebSocket(url, { headers, handshakeTimeout: options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS, perMessageDeflate: true,
      maxPayload: MAX_UPSTREAM_MESSAGE_BYTES, followRedirects: false });
    let upgradeHeaders: IncomingHttpHeaders = {};
    let settled = false;
    const fail = (error: UpstreamHandshakeError) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      socket.terminate();
      reject(error);
    };
    const abort = () => fail(new UpstreamHandshakeError(0, null, "The request was cancelled.", false));
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("upgrade", (response) => { upgradeHeaders = response.headers; });
    socket.once("unexpected-response", (request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { if (size < MAX_ERROR_BODY_BYTES) { chunks.push(chunk); size += chunk.byteLength; } });
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        const body = Buffer.concat(chunks).toString("utf8").slice(0, MAX_ERROR_BODY_BYTES) || null;
        fail(new UpstreamHandshakeError(status, body, `Upstream answered the WebSocket open with HTTP ${status}.`,
          status >= 500 || status === 426 || edgeChallenge(body)));
      });
      response.on("error", () => fail(new UpstreamHandshakeError(response.statusCode ?? 502, null, "The upstream WebSocket answer was cut off.", true)));
      request.destroy();
    });
    socket.once("error", (error) => fail(new UpstreamHandshakeError(0, null, error.message || "Request to upstream failed.", true)));
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      const turnState = upgradeHeaders["x-codex-turn-state"];
      resolve({ socket, turnState: typeof turnState === "string" ? turnState : null, headers: upgradeHeaders });
    });
  });
}

/** Rate-limit headers of a handshake, readable like a fetch response's. */
export function handshakeHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) if (typeof value === "string") out.set(name, value);
  return out;
}

const encoder = new TextEncoder();

/**
 * One request over an open upstream WebSocket, as an SSE `Response`, so a client that asked over HTTP gets the
 * same stream (`event: <type>` / `data: <json>`). The socket closes after the terminal event.
 */
export function webSocketResponse(opened: OpenedUpstream, frame: string): Response {
  const { socket } = opened;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on("message", (data, isBinary) => {
        if (finished || isBinary) return;
        const text = data.toString();
        let payload: Record<string, unknown> | null = null;
        try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* forwarded as is */ }
        const type = typeof payload?.type === "string" ? payload.type : "message";
        const line = payload && text.includes("\n") ? JSON.stringify(payload) : text;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${line}\n\n`));
        if (isTerminalEvent(type)) {
          finished = true;
          controller.close();
          socket.close(1000);
        }
      });
      socket.on("close", (code) => {
        if (finished) return;
        finished = true;
        controller.error(new Error(`Upstream websocket closed before response.completed (close_code=${code})`));
      });
      socket.on("error", (error) => {
        if (finished) return;
        finished = true;
        controller.error(error);
      });
      socket.send(frame);
    },
    cancel() {
      finished = true;
      socket.terminate();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The `response.create` frame for a request body: no `stream` or `background` (codex-lb). */
export function responseCreateFrame(body: Record<string, unknown>): string {
  const rest = { ...body };
  delete rest.stream;
  delete rest.background;
  delete rest.type;
  return JSON.stringify({ type: "response.create", ...rest });
}
