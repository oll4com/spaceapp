import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayApiKeyRecord, GatewayRequestLogInsert } from "@space/db";
import WebSocket, { type RawData } from "ws";
import type { StickyStore } from "../../accounts/sticky-store.js";
import { requestOrigin } from "../../client-detect.js";
import { gatewayErrors } from "../../errors.js";
import { applyRequestPolicy, checkKeyLimits, PolicyRejection, type PolicyResult } from "../../policy.js";
import { hashKey, header } from "../../proxy-util.js";
import { USAGE_LIMIT_REACHED } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { ChatRequestError, normalizeResponsesRequest } from "./chat.js";
import type { CodexProxyOptions, CodexRequestKey, UpstreamFailure } from "./codex-proxy.js";
import { buildCodexUpstreamHeaders } from "./headers.js";
import { isTerminalEvent, readCodexRateLimitEvent, ResponseStreamInspector } from "./stream.js";
import { handshakeHeaders, type openUpstreamWebSocket, responseCreateFrame, UpstreamHandshakeError, upstreamWebSocketHeaders, upstreamWebSocketUrl,
  type UpstreamWebSocketHealth } from "./upstream-websocket.js";

/**
 * Codex Responses over a client WebSocket (`responses_websockets`), after codex-lb's WebSocket proxy (MIT,
 * Soju06/codex-lb): `response.create` frames in, the upstream's event frames out. Each client socket keeps one
 * upstream socket for its account, so `previous_response_id` (which ChatGPT keeps per connection with store=false)
 * keeps working across turns. Requests on a socket run one at a time; a failure before any output moves the
 * request to another account, as over HTTP.
 */
export const CLIENT_IDLE_TIMEOUT_MS = 120_000;
const KEEPALIVE_MS = 10_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 600_000;
/** codex-lb `upstream_response_create_max_bytes`. */
const MAX_CREATE_BYTES = 15 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 128 * 1024 * 1024;
const PREVIOUS_RESPONSE_MISSING = "Previous response was not found; retry without previous_response_id.";
const TRANSPORT_UNAVAILABLE = "Upstream websocket transport is unavailable; retry over HTTP.";
const TURN_STATE = Symbol("codexTurnState");

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const rawText = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf8");
const rawBuffer = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data));

export interface CodexWebSocketTiming { idleMs: number; keepaliveMs: number; upstreamIdleMs: number }

/** Open client sessions, for live activity and for a drain that lets running responses finish. */
export class CodexWebSocketRegistry {
  private sessions = new Set<CodexWebSocketSession>();
  private draining = false;
  private drained: (() => void) | null = null;
  constructor(readonly timing: CodexWebSocketTiming = { idleMs: CLIENT_IDLE_TIMEOUT_MS, keepaliveMs: KEEPALIVE_MS, upstreamIdleMs: UPSTREAM_IDLE_TIMEOUT_MS }) {}
  /** Open client WebSockets (Headroom "Active WebSockets"). */
  active() { return this.sessions.size; }
  /** Open upstream relays (Headroom "Relay tasks"). */
  relays() { let open = 0; for (const session of this.sessions) if (session.hasUpstream()) open += 1; return open; }
  isDraining() { return this.draining; }
  add(session: CodexWebSocketSession) { this.sessions.add(session); }
  remove(session: CodexWebSocketSession) {
    this.sessions.delete(session);
    if (this.draining && this.sessions.size === 0) this.drained?.();
  }
  /** Idle sessions close now (1012); busy ones after their current response. Resolves when every session is gone. */
  drain(): Promise<void> {
    this.draining = true;
    if (this.sessions.size === 0) return Promise.resolve();
    const done = new Promise<void>((resolve) => { this.drained = resolve; });
    for (const session of this.sessions) session.drain();
    return done;
  }
}

export interface CodexWebSocketShared {
  options: CodexProxyOptions;
  now: () => number;
  upstreamUrl: string;
  maxAttempts: number;
  bufferLimit: number;
  health: UpstreamWebSocketHealth;
  openWebSocket: typeof openUpstreamWebSocket;
  registry: CodexWebSocketRegistry;
  pickAccount(settings: GatewaySettings, scope: Set<string> | null, tried: Set<string>, stickyHash: string | null, ownerAccountId: string | null,
    model: string | null): Promise<{ account?: GatewayAccountRecord; none?: { errorCode: string | null; errorMessage: string | null } }>;
  /** The account to retry on when its rejected access token was refreshed. */
  recordFailure(account: GatewayAccountRecord, failure: UpstreamFailure): Promise<GatewayAccountRecord | null>;
  parseUpstreamError(text: string, status: number): UpstreamFailure;
  recordPassiveUsage(accountId: string, headers: Headers): void;
  withSpeedDefault(body: Json): Promise<Json>;
  compressRequest(body: Json, request: FastifyRequest, key: CodexRequestKey, settings: GatewaySettings, startedAt: number, sessionKey?: string | null): Promise<{
    outgoing: Json; saved: number | null; measured: { before: number; after: number } | null; detail: GatewayRequestLogInsert["compressionDetail"] }>;
  finishRequest(input: { key: { id: string }; account: GatewayAccountRecord; inspector: ResponseStreamInspector; firstTokenAt: number | null; forcedError: string | null;
    policy: PolicyResult; startedAt: number; baseLog: Omit<GatewayRequestLogInsert, "status" | "errorCode" | "errorMessage">; compressionSaved: number | null }): void;
  responseOwners: StickyStore;
  stickyAccounts: StickyStore;
}

export function registerCodexWebSocketRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, shared: CodexWebSocketShared) {
  void app.register(async (scope) => {
    await scope.register(websocketPlugin, {
      options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: true },
      // Sessions still open when the server closes (after the drain timeout) are told to reconnect elsewhere.
      preClose(done) {
        for (const client of scope.websocketServer.clients) client.close(1012, "Server is draining");
        done();
      }
    });
    scope.websocketServer.on("headers", (headers: string[], request: { [TURN_STATE]?: string }) => {
      if (request[TURN_STATE]) headers.push(`x-codex-turn-state: ${request[TURN_STATE]}`);
    });
    const preValidation = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await helpers.authenticate(request, reply))) return;
      const settings = await shared.options.settings();
      // codex-lb answers 426 while WebSocket is off; the Codex CLI then uses HTTP for the session.
      if (settings.upstreamStreamTransport === "HTTP" || shared.health.coolingDown()) {
        return reply.code(426).send({ error: { message: TRANSPORT_UNAVAILABLE, type: "server_error", code: "websocket_upstream_transport_unavailable" } });
      }
      const presented = header(request, "x-codex-turn-state");
      (request.raw as { [TURN_STATE]?: string })[TURN_STATE] = presented && /^[\x21-\x7e]{1,256}$/.test(presented) ? presented : `turn_${randomUUID().replace(/-/g, "")}`;
    };
    for (const [path, route] of [["/backend-api/codex/responses", "codex"], ["/v1/responses", "v1"]] as const) {
      scope.get(path, { websocket: true, preValidation }, (socket, request) => new CodexWebSocketSession(socket, request, route, shared).start());
    }
  });
}

interface RequestContext {
  account: GatewayAccountRecord;
  canRetry: boolean;
  finish(inspector: ResponseStreamInspector, firstTokenAt: number | null, forcedError: string | null): void;
}

class CodexWebSocketSession {
  private upstream: { socket: WebSocket; accountId: string } | null = null;
  private upstreamTurnState: string | null = null;
  private queue: string[] = [];
  private busy = false;
  private closed = false;
  private draining = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private abortCurrent: (() => void) | null = null;
  private readonly key: GatewayApiKeyRecord;
  private readonly turnState: string;

  constructor(private readonly client: WebSocket, private readonly request: FastifyRequest, private readonly route: "codex" | "v1",
    private readonly shared: CodexWebSocketShared) {
    this.key = request.gatewayApiKey!;
    this.turnState = (request.raw as { [TURN_STATE]?: string })[TURN_STATE] ?? `turn_${randomUUID().replace(/-/g, "")}`;
  }

  start() {
    this.shared.registry.add(this);
    this.client.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.client.on("close", () => this.onClose());
    this.client.on("error", () => this.client.terminate());
    this.armIdle();
    if (this.shared.registry.isDraining()) this.drain();
  }

  hasUpstream() { return this.upstream !== null && this.upstream.socket.readyState === WebSocket.OPEN; }

  drain() {
    this.draining = true;
    if (!this.busy && this.queue.length === 0) this.closeClient(1012, "Server is draining");
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.busy || this.queue.length > 0 || this.closed) return;
    this.idleTimer = setTimeout(() => this.closeClient(1001, "Idle downstream websocket timeout"), this.shared.registry.timing.idleMs);
    this.idleTimer.unref();
  }

  private send(event: Json | string | Buffer, binary = false) {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(typeof event === "string" || Buffer.isBuffer(event) ? event : JSON.stringify(event), { binary });
  }

  /** codex-lb's request-level error frame. */
  private sendError(status: number, message: string, type: string, code: string) {
    this.send({ type: "error", status, error: { message, type, code } });
  }

  private closeClient(code: number, reason: string) {
    if (this.closed) return;
    if (this.client.readyState === WebSocket.OPEN) this.client.close(code, reason);
    else this.client.terminate();
  }

  private closeUpstream() {
    const current = this.upstream;
    this.upstream = null;
    if (current && current.socket.readyState <= WebSocket.OPEN) current.socket.close(1000);
  }

  private onMessage(data: RawData, isBinary: boolean) {
    if (this.closed) return;
    if (isBinary) {
      if (this.hasUpstream()) this.upstream!.socket.send(rawBuffer(data), { binary: true });
      return;
    }
    const text = rawText(data);
    const payload = obj(safeJson(text));
    if (payload?.type === "response.create") {
      if (this.draining) {
        this.sendError(503, gatewayErrors.draining().error.message, "server_error", "server_draining");
        return;
      }
      this.queue.push(text);
      void this.pump();
      return;
    }
    // Other frames (a cancel, for one) belong to the running response.
    if (this.hasUpstream()) { this.upstream!.socket.send(text); return; }
    if (payload) this.sendError(400, "WebSocket connection has no active upstream session", "invalid_request_error", "no_active_upstream");
    else this.sendError(400, "The frame is not valid JSON.", "invalid_request_error", "invalid_json");
  }

  private onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.queue = [];
    this.abortCurrent?.();
    this.closeUpstream();
    this.shared.registry.remove(this);
  }

  private async pump() {
    if (this.busy || this.closed) return;
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.draining) this.closeClient(1012, "Server is draining");
      else this.armIdle();
      return;
    }
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.run(next);
    } catch {
      this.sendError(500, "The request could not be processed.", "server_error", "internal_error");
    } finally {
      this.busy = false;
    }
    void this.pump();
  }

  private async run(text: string) {
    const { options, now } = this.shared;
    const startedAt = now();
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    if (Buffer.byteLength(text, "utf8") > MAX_CREATE_BYTES) {
      this.sendError(400, "response.create is too large for upstream websocket", "invalid_request_error", "payload_too_large");
      return;
    }
    const body = { ...(JSON.parse(text) as Json) };
    delete body.type;
    let policy: PolicyResult;
    try {
      policy = applyRequestPolicy(await this.shared.withSpeedDefault(normalizeResponsesRequest(body, { openAiStyle: this.route === "v1" })), this.key);
      checkKeyLimits(this.key, policy.model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) {
        const envelope = error.envelope.error;
        this.sendError(error.statusCode, envelope.message, envelope.type, envelope.code ?? "policy_rejected");
        return;
      }
      if (error instanceof ChatRequestError) { this.sendError(400, error.message, "invalid_request_error", "invalid_request"); return; }
      throw error;
    }
    const settings = await options.settings();
    const session = this.route === "codex" ? header(this.request, "session_id") ?? header(this.request, "x-codex-session-id") ?? header(this.request, "x-codex-conversation-id") : null;
    const promptCacheKey = typeof policy.body.prompt_cache_key === "string" ? policy.body.prompt_cache_key : null;
    // The raw-block registry needs the conversation, not the turn: the session or the prompt cache key.
    const conversationKey = session ? hashKey(`codex:${session}`) : promptCacheKey ? hashKey(`codex:${promptCacheKey}`) : null;
    const compressed = await this.shared.compressRequest(policy.body, this.request, this.key, settings, startedAt, conversationKey);
    const frame = responseCreateFrame(compressed.outgoing);
    const previousResponseId = typeof policy.body.previous_response_id === "string" ? policy.body.previous_response_id : null;
    const ownerAccountId = previousResponseId ? await this.shared.responseOwners.get(hashKey(`codex-response:${previousResponseId}`)) ?? null : null;

    // Affinity, as codex-lb: the client's turn state, then its session (Codex route), then the prompt cache key,
    // then this socket's own turn state.
    const clientTurnState = header(this.request, "x-codex-turn-state");
    const [stickySource, stickyHash] = clientTurnState ? ["x-codex-turn-state", hashKey(`codex-turn:${clientTurnState}`)]
      : session ? ["session_id", hashKey(`codex:${session}`)]
        : promptCacheKey ? ["prompt_cache_key", hashKey(`codex:${promptCacheKey}`)]
          : ["turn_state", hashKey(`codex-turn:${this.turnState}`)];
    const baseLog = (): Omit<GatewayRequestLogInsert, "status" | "errorCode" | "errorMessage"> => ({
      requestId, requestedAt: new Date(startedAt).toISOString(), provider: "CODEX", accountId: null, apiKeyId: this.key.id,
      model: policy.model ?? "unknown", reasoningEffort: policy.reasoningEffort, requestedServiceTier: policy.requestedServiceTier,
      serviceTier: policy.serviceTier, transport: "websocket", upstreamTransport: "websocket", latencyMs: null, firstTokenMs: null, inputTokens: null,
      cachedInputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, compressionTokensSaved: null,
      stickyKeySource: stickySource, stickyKind: ownerAccountId ? "CONTINUATION" : "STICKY_THREAD", stickyKeyHash: stickyHash.slice(0, 16),
      ...requestOrigin(this.request), compressionTokensBefore: compressed.measured?.before ?? null, compressionTokensAfter: compressed.measured?.after ?? null,
      compressionDetail: compressed.detail
    });

    const scope = this.key.accountScopeEnabled ? new Set(this.key.accountIds) : null;
    const tried = new Set<string>();
    let lastFailure: UpstreamFailure | null = null;
    let transportDown = false;
    let retryWith: GatewayAccountRecord | null = null;
    for (let attempt = 0; attempt < this.shared.maxAttempts && !this.closed; attempt += 1) {
      const { account, none } = retryWith ? { account: retryWith, none: undefined }
        : await this.shared.pickAccount(settings, scope, tried, stickyHash, ownerAccountId, policy.model);
      retryWith = null;
      if (!account) {
        if (attempt === 0 && none) {
          const status = none.errorCode === USAGE_LIMIT_REACHED ? 429 : 503;
          options.logs.add({ ...baseLog(), status: "error", errorCode: none.errorCode ?? "no_accounts", errorMessage: none.errorMessage, latencyMs: now() - startedAt });
          this.sendError(status, none.errorMessage ?? gatewayErrors.noAccounts().error.message, status === 429 ? "rate_limit_error" : "server_error",
            none.errorCode ?? "no_accounts");
          return;
        }
        break;
      }
      tried.add(account.id);
      const selection = new EventEmitter();
      options.pool.markSelected(account.id, selection);
      try {
        const opened = await this.upstreamFor(account);
        if ("failure" in opened) {
          lastFailure = opened.failure;
          if (opened.transport) { transportDown = true; break; }
          if (opened.failure.kind === "surface") break;
          retryWith = await this.shared.recordFailure(account, opened.failure);
          // The same account once more, with its refreshed token: it does not count as another attempt.
          if (retryWith) { attempt -= 1; continue; }
          if (ownerAccountId) break;
          continue;
        }
        const canRetry = !ownerAccountId && attempt + 1 < this.shared.maxAttempts;
        const result = await this.exchange(opened.socket, frame, {
          account, canRetry,
          finish: (inspector, firstTokenAt, forcedError) => {
            this.shared.finishRequest({ key: this.key, account, inspector, firstTokenAt, forcedError, policy, startedAt, baseLog: baseLog(),
              compressionSaved: compressed.saved });
            if (inspector.outcome.responseId) this.shared.responseOwners.set(hashKey(`codex-response:${inspector.outcome.responseId}`), account.id);
            this.shared.stickyAccounts.set(stickyHash, account.id);
            if (forcedError === null && inspector.outcome.status === "success") void options.pool.markSuccess(account.id).catch(() => undefined);
          }
        });
        if (!result.retry) return;
        lastFailure = result.retry;
        this.closeUpstream();
        await this.shared.recordFailure(account, result.retry);
      } finally {
        selection.emit("close");
      }
    }
    if (this.closed) return;

    // Every attempt failed before any output reached the client.
    const failure = lastFailure ?? { kind: "transient" as const, status: 503, code: "no_accounts", message: gatewayErrors.noAccounts().error.message, error: {}, body: null };
    options.logs.add({ ...baseLog(), accountId: [...tried].at(-1) ?? null, status: "error", errorCode: failure.code, errorMessage: failure.message, latencyMs: now() - startedAt });
    const status = failure.kind === "rate_limit" || failure.kind === "quota" ? 429 : failure.status >= 400 ? failure.status : 502;
    const upstreamError = failure.kind === "surface" && failure.body ? obj(obj(safeJson(failure.body))?.error) : null;
    if (upstreamError) this.send({ type: "error", status, error: upstreamError });
    else this.sendError(status, failure.message, status === 429 ? "rate_limit_error" : "server_error", failure.code);
    // Reconnecting gets a 426, so the client carries on over HTTP.
    if (transportDown) this.closeClient(1011, "Upstream websocket transport is unavailable");
  }

  /** The upstream socket for an account: this session's own when it belongs to the account, else a new one. */
  private async upstreamFor(account: GatewayAccountRecord): Promise<{ socket: WebSocket } | { failure: UpstreamFailure; transport: boolean }> {
    if (this.upstream && this.upstream.accountId === account.id && this.upstream.socket.readyState === WebSocket.OPEN) return this.upstream;
    this.closeUpstream();
    let credentials;
    try {
      credentials = await this.shared.options.pool.credentials(account);
    } catch (error) {
      return { failure: { kind: "permanent", status: 401, code: String((error as { code?: unknown }).code ?? "credential_error"),
        message: error instanceof Error ? error.message : "Account credentials are unavailable.", error: {}, body: null }, transport: false };
    }
    const headers = upstreamWebSocketHeaders(buildCodexUpstreamHeaders(this.request.headers, credentials.accessToken, credentials.upstreamAccountId));
    if (this.upstreamTurnState) headers["x-codex-turn-state"] = this.upstreamTurnState;
    try {
      const opened = await this.shared.openWebSocket(upstreamWebSocketUrl(this.shared.upstreamUrl), headers);
      this.shared.health.markSuccess();
      this.shared.recordPassiveUsage(account.id, handshakeHeaders(opened.headers));
      this.upstreamTurnState = opened.turnState ?? this.upstreamTurnState;
      const current = { socket: opened.socket, accountId: account.id };
      opened.socket.on("error", () => undefined);
      opened.socket.on("close", () => { if (this.upstream === current) this.upstream = null; });
      if (this.closed) { opened.socket.close(1000); return { failure: { kind: "surface", status: 499, code: "client_closed", message: "The client closed the connection.", error: {}, body: null }, transport: false }; }
      this.upstream = current;
      return current;
    } catch (error) {
      if (error instanceof UpstreamHandshakeError && !error.transport && error.status > 0) {
        return { failure: this.shared.parseUpstreamError(error.body ?? "", error.status), transport: false };
      }
      this.shared.health.markFailure();
      return { failure: { kind: "transient", status: 502, code: "upstream_unavailable", message: TRANSPORT_UNAVAILABLE, error: {}, body: null }, transport: true };
    }
  }

  /**
   * One request on an open upstream socket. Frames are held until output starts, so a failure before that (rate
   * limit, quota, a closed socket) can still move to another account without the client seeing anything.
   */
  private exchange(socket: WebSocket, frame: string, context: RequestContext): Promise<{ retry?: UpstreamFailure }> {
    const { now, registry, bufferLimit } = this.shared;
    return new Promise((resolve) => {
      const inspector = new ResponseStreamInspector();
      const held: Array<{ data: string | Buffer; binary: boolean }> = [];
      let heldBytes = 0;
      let committed = false;
      let firstTokenAt: number | null = null;
      let lastActivity = now();
      let idleTimedOut = false;
      let settled = false;
      const deliver = (data: string | Buffer, binary = false) => this.send(data, binary);
      const commit = () => {
        committed = true;
        for (const entry of held) deliver(entry.data, entry.binary);
        held.length = 0;
      };
      const hold = (data: string | Buffer, binary: boolean) => {
        if (committed) { deliver(data, binary); return; }
        held.push({ data, binary });
        heldBytes += data.length;
      };
      const settle = (result: { retry?: UpstreamFailure }) => {
        if (settled) return;
        settled = true;
        socket.off("message", onMessage);
        socket.off("close", onClose);
        clearInterval(keepalive);
        clearTimeout(idle);
        this.abortCurrent = null;
        resolve(result);
      };
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { idleTimedOut = true; socket.terminate(); }, registry.timing.upstreamIdleMs);
        idle.unref();
      };
      const onMessage = (data: RawData, isBinary: boolean) => {
        lastActivity = now();
        resetIdle();
        if (isBinary) { hold(rawBuffer(data), true); return; }
        let text = rawText(data);
        const payload = obj(safeJson(text));
        if (!payload) { hold(text, false); return; }
        const type = typeof payload.type === "string" ? payload.type : null;
        if (type === "codex.rate_limits") {
          const usage = readCodexRateLimitEvent(payload, now() / 1000);
          if (usage) this.recordUsage(context.account.id, usage);
          // codex-lb keeps codex.* events for Codex clients only.
          if (this.route === "v1") return;
        }
        const masked = maskPreviousResponseMissing(payload);
        if (masked) text = JSON.stringify(masked);
        if (inspector.pushEvent(masked ?? payload) && firstTokenAt === null) firstTokenAt = now();
        if (isTerminalEvent(type)) {
          if (inspector.outcome.status === "failed" && !inspector.outputStarted && context.canRetry) {
            const failure = this.shared.parseUpstreamError(JSON.stringify({ error: { code: inspector.outcome.errorCode, message: inspector.outcome.errorMessage } }), 200);
            if (failure.kind !== "surface") { settle({ retry: failure }); return; }
          }
          hold(text, false);
          if (!committed) commit();
          context.finish(inspector, firstTokenAt, null);
          settle({});
          return;
        }
        hold(text, false);
        if (!committed && (inspector.outputStarted || heldBytes > bufferLimit)) commit();
      };
      const onClose = (code: number) => {
        const message = idleTimedOut ? "Upstream stream idle timeout" : `Upstream websocket closed before response.completed (close_code=${code})`;
        const errorCode = idleTimedOut ? "stream_idle_timeout" : "stream_incomplete";
        if (!committed && context.canRetry && !idleTimedOut) {
          settle({ retry: { kind: "transient", status: 502, code: errorCode, message, error: {}, body: null } });
          return;
        }
        if (!committed) commit();
        deliver(JSON.stringify(failedResponse(inspector.outcome.responseId, errorCode, message, now())));
        context.finish(inspector, firstTokenAt, errorCode);
        settle({});
      };
      // codex-lb keepalives after 10 s of upstream silence: progress for a started response, a pending note otherwise.
      const keepalive = setInterval(() => {
        if (now() - lastActivity < registry.timing.keepaliveMs) return;
        lastActivity = now();
        if (committed && inspector.outcome.responseId) deliver(JSON.stringify({ type: "response.in_progress", response: { id: inspector.outcome.responseId, status: "in_progress" } }));
        else if (this.route === "codex") deliver(JSON.stringify({ type: "codex.keepalive", request_id: inspector.outcome.responseId, status: "pending_response_created" }));
      }, Math.max(250, Math.floor(registry.timing.keepaliveMs / 2)));
      keepalive.unref();
      let idle = setTimeout(() => undefined, 0);
      resetIdle();
      this.abortCurrent = () => {
        context.finish(inspector, firstTokenAt, "client_closed");
        settle({});
        socket.terminate();
      };
      socket.on("message", onMessage);
      socket.on("close", onClose);
      socket.send(frame, (error) => { if (error) socket.terminate(); });
    });
  }

  private recordUsage(accountId: string, usage: NonNullable<ReturnType<typeof readCodexRateLimitEvent>>) {
    const nowSeconds = this.shared.now() / 1000;
    void this.shared.options.pool.recordUsage(accountId, {
      primaryUsedPercent: usage.primaryUsedPercent, secondaryUsedPercent: usage.secondaryUsedPercent,
      primaryResetAt: usage.primaryResetAfterSeconds !== null ? new Date((nowSeconds + usage.primaryResetAfterSeconds) * 1000).toISOString() : null,
      secondaryResetAt: usage.secondaryResetAfterSeconds !== null ? new Date((nowSeconds + usage.secondaryResetAfterSeconds) * 1000).toISOString() : null,
      primaryWindowMinutes: usage.primaryWindowMinutes, secondaryWindowMinutes: usage.secondaryWindowMinutes
    }).catch(() => undefined);
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** codex-lb (upstream) masks a missing previous response, so the raw id never reaches the client. */
function maskPreviousResponseMissing(payload: Json): Json | null {
  const holder = payload.type === "response.failed" ? obj(payload.response) : payload;
  const error = obj(holder?.error);
  if (!holder || !error || error.code !== "previous_response_not_found") return null;
  const maskedError: Json = { ...error, message: PREVIOUS_RESPONSE_MISSING };
  delete maskedError.param;
  return payload.type === "response.failed" ? { ...payload, response: { ...holder, error: maskedError } } : { ...payload, error: maskedError };
}

/** codex-lb's turn-level failure event for a stream that ended without its terminal event. */
function failedResponse(responseId: string | null, code: string, message: string, nowMs: number): Json {
  return { type: "response.failed", response: { object: "response", status: "failed", error: { code, message }, incomplete_details: null,
    id: responseId ?? `resp_${randomUUID().replace(/-/g, "")}`, created_at: Math.floor(nowMs / 1000) } };
}
