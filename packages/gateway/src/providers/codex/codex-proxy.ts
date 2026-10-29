import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayCompressionMode, GatewayOutputPolicy, GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayCompressionRow, GatewayCompressionSignalRow, GatewayRequestLogInsert } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { gatewayError, gatewayErrors } from "../../errors.js";
import { applyRequestPolicy, checkKeyLimits, PolicyRejection, type PolicyResult } from "../../policy.js";
import { compressResponsesBodyAsync, type AsyncBlockRunner, type CompressionCache, type RawBlockRegistry } from "../../compression/engine.js";
import { outputPolicyText, requestOutputPolicy, withResponsesOutputPolicy } from "../../compression/output-policy.js";
import { effectiveCompression, requestCompressionMode } from "../../compression/provider-settings.js";
import { compressionDetail, compressionRows, compressionSignalRows } from "../../compression/recorder.js";
import { costUsd } from "../../pricing/pricing.js";
import { StickyStore } from "../../accounts/sticky-store.js";
import { hashKey, header, readBounded } from "../../proxy-util.js";
import { detectClient, requestOrigin } from "../../client-detect.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { selectAccount, USAGE_LIMIT_REACHED, permanentFailureCodes, type UpstreamError } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { ChatRequestError, ChatStreamTranslator, chatToResponses, normalizeResponsesRequest, responseToChatCompletion } from "./chat.js";
import { buildCodexUpstreamHeaders } from "./headers.js";
import type { CodexModelPlans } from "./model-plans.js";
import { readCodexRateLimitHeaders, readResponseUsage, ResponseStreamInspector } from "./stream.js";
import { CODEX_UPSTREAM_BASE_URL } from "./usage.js";
import { registerCodexWebSocketRoutes, type CodexWebSocketRegistry } from "./codex-websocket.js";
import { handshakeHeaders, openUpstreamWebSocket, responseCreateFrame, UpstreamHandshakeError, upstreamWebSocketHeaders, upstreamWebSocketUrl,
  UpstreamWebSocketHealth, webSocketResponse } from "./upstream-websocket.js";

/**
 * Codex Responses proxy (`/backend-api/codex/responses`, `/v1/responses`), after codex-lb's proxy service
 * (MIT, Soju06/codex-lb): pick an account, swap in its credentials, stream the reply through, and move to another
 * account when a failure happens before the client has seen any output.
 */
const rateLimitCodes = new Set(["rate_limit_exceeded", USAGE_LIMIT_REACHED]);
const quotaCodes = new Set(["insufficient_quota", "usage_not_included", "quota_exceeded"]);
const transientCodes = new Set(["server_error", "upstream_error", "stream_incomplete", "overloaded_error", "server_is_overloaded"]);
const usageLimitMessage = /usage limit|you've hit your limit|purchase more credits/i;
/** WebSocket open answers about the account, not the transport (codex-lb `_AUTO_WEBSOCKET_HANDSHAKE_NON_FALLBACK_STATUSES`). */
export const accountHandshakeStatuses = new Set([401, 404, 429]);

export interface CodexProxyOptions {
  pool: AccountPool;
  logs: RequestLogWriter;
  settings: () => Promise<GatewaySettings>;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAccountAttempts?: number;
  preOutputBufferBytes?: number;
  /** Context compression (the Headroom rewrite); absent means requests are never compressed. */
  compression?: { run: AsyncBlockRunner; cache?: CompressionCache; rawBlocks?: RawBlockRegistry; record: (rows: GatewayCompressionRow[]) => Promise<void>;
    recordSignals?: (rows: GatewayCompressionSignalRow[]) => Promise<void> };
  /** Conversation affinity; without it bindings live in memory only. */
  sticky?: { threads: StickyStore; continuations: StickyStore };
  /** Per-model default speed (the codex-lb speed map); a request without service_tier gets its model's default. */
  speedDefaults?: () => Promise<Record<string, string>>;
  /** Which plans offer which models; without it every account may serve every model. */
  modelPlans?: CodexModelPlans;
  /** Counts a finished request against the key's limits. */
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
  /** Client WebSocket sessions (Codex `responses_websockets`); without it the WebSocket routes are not served. */
  webSockets?: CodexWebSocketRegistry;
  /** Upstream WebSocket health shared by every request; tests pass their own clock. */
  upstreamWebSocketHealth?: UpstreamWebSocketHealth;
  /** Opens upstream WebSockets; tests replace it. */
  openWebSocket?: typeof openUpstreamWebSocket;
}

export type FailureKind = "rate_limit" | "quota" | "transient" | "permanent" | "surface";

/** What compression and the output policy read from a request's key. */
export interface CodexRequestKey {
  name: string;
  compressionOverride: GatewayCompressionMode | null;
  outputPolicyOverride?: GatewayOutputPolicy | null;
}

export interface UpstreamFailure {
  kind: FailureKind;
  status: number;
  code: string;
  message: string;
  error: UpstreamError;
  body: string | null;
}

function classify(code: string, message: string, status: number): FailureKind {
  if (code in permanentFailureCodes) return "permanent";
  if (rateLimitCodes.has(code)) return "rate_limit";
  if (quotaCodes.has(code)) return "quota";
  if (usageLimitMessage.test(message)) return "rate_limit";
  if (transientCodes.has(code) || status >= 500 || /selected model is at capacity/i.test(message)) return "transient";
  if (status === 429) return "transient";
  if (status === 401) return "permanent";
  return "surface";
}

export function parseUpstreamError(text: string, status: number): UpstreamFailure {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  const error = (payload.error && typeof payload.error === "object" ? payload.error : payload) as Record<string, unknown>;
  const code = String(error.code ?? error.type ?? (status === 401 ? "token_invalidated" : status >= 500 ? "upstream_error" : `http_${status}`));
  const message = typeof error.message === "string" ? error.message : text.slice(0, 300) || `Upstream returned HTTP ${status}`;
  const resetsAt = typeof error.resets_at === "number" ? error.resets_at : undefined;
  const resetsInSeconds = typeof error.resets_in_seconds === "number" ? error.resets_in_seconds : undefined;
  return { kind: classify(code, message, status), status, code, message, error: { message, resetsAt, resetsInSeconds }, body: text || null };
}

/** Records a failed attempt; the account to retry on when its rejected access token (HTTP 401) was refreshed. */
export async function recordCodexFailure(pool: AccountPool, account: GatewayAccountRecord, failure: UpstreamFailure): Promise<GatewayAccountRecord | null> {
  const code = failure.code in permanentFailureCodes ? failure.code : "token_invalidated";
  if (failure.kind === "permanent" && failure.status === 401) return pool.refreshRejectedToken(account, code);
  if (failure.kind === "rate_limit") await pool.markRateLimited(account, failure.error);
  else if (failure.kind === "quota") await pool.markQuotaExceeded(account, failure.error);
  else if (failure.kind === "permanent") await pool.markPermanentFailure(account, code);
  else pool.markTransientError(account.id);
  return null;
}

export function registerCodexProxyRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: CodexProxyOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const upstreamUrl = `${(options.upstreamBaseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/, "")}/codex/responses`;
  const maxAttempts = options.maxAccountAttempts ?? 3;
  const bufferLimit = options.preOutputBufferBytes ?? 4 * 1024 * 1024;
  /** previous_response_id hash -> owning account (hard continuation affinity). */
  const responseOwners = options.sticky?.continuations ?? new StickyStore({ provider: "CODEX", kind: "CONTINUATION" });
  /** prompt cache / session key hash -> account (soft sticky threads). */
  const stickyAccounts = options.sticky?.threads ?? new StickyStore({ provider: "CODEX", kind: "STICKY_THREAD" });
  const webSocketHealth = options.upstreamWebSocketHealth ?? new UpstreamWebSocketHealth(now);
  const openWebSocket = options.openWebSocket ?? openUpstreamWebSocket;

  const recordFailure = (account: GatewayAccountRecord, failure: UpstreamFailure) => recordCodexFailure(options.pool, account, failure);

  /** Passive usage from `x-codex-*` headers (an HTTP reply or a WebSocket handshake). */
  function recordPassiveUsage(accountId: string, headers: Headers) {
    const passive = readCodexRateLimitHeaders(headers);
    const nowSeconds = now() / 1000;
    void options.pool.recordUsage(accountId, {
      primaryUsedPercent: passive.primaryUsedPercent, secondaryUsedPercent: passive.secondaryUsedPercent,
      primaryResetAt: passive.primaryResetAfterSeconds !== null ? new Date((nowSeconds + passive.primaryResetAfterSeconds) * 1000).toISOString() : null,
      secondaryResetAt: passive.secondaryResetAfterSeconds !== null ? new Date((nowSeconds + passive.secondaryResetAfterSeconds) * 1000).toISOString() : null,
      primaryWindowMinutes: passive.primaryWindowMinutes, secondaryWindowMinutes: passive.secondaryWindowMinutes
    }).catch(() => undefined);
  }

  /**
   * Context compression and the output policy of a request body, under Codex's settings (the global ones overlaid by
   * the provider's) and the key's overrides. Never throws; on any failure the original body is used.
   */
  async function compressRequest(body: Record<string, unknown>, request: FastifyRequest, key: CodexRequestKey, settings: GatewaySettings, startedAt: number,
    sessionKey: string | null = null) {
    const result: { outgoing: Record<string, unknown>; saved: number | null; measured: { before: number; after: number } | null;
      detail: GatewayRequestLogInsert["compressionDetail"] } = { outgoing: body, saved: null, measured: null, detail: null };
    const effective = effectiveCompression(settings, "CODEX");
    const compressionMode = requestCompressionMode(effective, key.compressionOverride, header(request, "x-space-gateway-compression"));
    const outputPolicy = requestOutputPolicy({ policy: effective.outputPolicy, key, clientName: detectClient(request.headers),
      headerValue: header(request, "x-space-gateway-output-policy") });
    if (compressionMode !== "OFF" && options.compression) await compressInto(result, body, compressionMode, effective, startedAt, sessionKey);
    const policyText = outputPolicyText(outputPolicy);
    const withPolicy = policyText ? withResponsesOutputPolicy(result.outgoing, policyText) : null;
    if (withPolicy) {
      result.outgoing = withPolicy;
      result.detail = { ...(result.detail ?? { strategies: [], waste: {} }), outputPolicy };
    }
    return result;
  }

  async function compressInto(result: { outgoing: Record<string, unknown>; saved: number | null; measured: { before: number; after: number } | null;
    detail: GatewayRequestLogInsert["compressionDetail"] }, body: Record<string, unknown>, compressionMode: "ON",
    effective: ReturnType<typeof effectiveCompression>, startedAt: number, sessionKey: string | null) {
    if (!options.compression) return;
    try {
      const outcome = await compressResponsesBodyAsync(body, { run: options.compression.run, cache: options.compression.cache,
        timeBudgetMs: effective.timeBudgetMs, codeText: effective.codeText, profile: effective.profile,
        sessionKey: sessionKey ?? undefined, rawBlocks: options.compression.rawBlocks });
      if (outcome.tokensBefore > 0) result.measured = { before: outcome.tokensBefore, after: outcome.tokensAfter };
      if (compressionMode === "ON" && outcome.modified) {
        result.outgoing = outcome.body;
        result.saved = outcome.tokensBefore - outcome.tokensAfter;
      }
      void options.compression.record(compressionRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "CODEX" }))
        .catch(() => undefined);
      void options.compression.recordSignals?.(compressionSignalRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "CODEX" }))
        .catch(() => undefined);
      result.detail = compressionDetail(outcome);
    } catch {
      // Compression never blocks a request: the original body goes upstream.
    }
  }

  /** Settles a finished request against its key and writes its log entry. */
  function finishRequest(input: { key: { id: string }; account: GatewayAccountRecord; inspector: ResponseStreamInspector; firstTokenAt: number | null;
    forcedError: string | null; policy: PolicyResult; startedAt: number; baseLog: Omit<GatewayRequestLogInsert, "status" | "errorCode" | "errorMessage">;
    compressionSaved: number | null }) {
    const { account, inspector, firstTokenAt, forcedError, policy, startedAt } = input;
    const outcome = inspector.outcome;
    const ok = forcedError === null && outcome.status === "success";
    const cost = costUsd(outcome.usage, outcome.model ?? policy.model, outcome.serviceTier ?? policy.serviceTier);
    if (outcome.usage && options.settleKeyUsage) {
      void options.settleKeyUsage(input.key.id, {
        inputTokens: outcome.usage.inputTokens ?? 0, outputTokens: outcome.usage.outputTokens ?? 0, costMicros: Math.round((cost ?? 0) * 1e6),
        model: outcome.model ?? policy.model, at: new Date(startedAt).toISOString()
      }).catch(() => undefined);
    }
    options.logs.add({
      ...input.baseLog, accountId: account.id, planType: account.planType, model: outcome.model ?? policy.model ?? "unknown",
      serviceTier: outcome.serviceTier ?? policy.serviceTier, status: ok ? "success" : "error",
      errorCode: forcedError ?? (ok ? null : outcome.errorCode ?? outcome.status), errorMessage: ok ? null : outcome.errorMessage,
      latencyMs: now() - startedAt, firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      inputTokens: outcome.usage?.inputTokens ?? null, cachedInputTokens: outcome.usage?.cachedInputTokens ?? null,
      outputTokens: outcome.usage?.outputTokens ?? null, reasoningTokens: outcome.usage?.reasoningTokens ?? null,
      costUsd: cost, compressionTokensSaved: input.compressionSaved
    });
    void options.pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
  }

  /**
   * Upstream transport for a request from an HTTP client: WebSocket when the setting asks for it and no recent
   * WebSocket failure turned it off (codex-lb's 60 s cooldown); HTTP otherwise, and always by default.
   */
  const promoteToWebSocket = (settings: GatewaySettings) => settings.upstreamStreamTransport === "WEBSOCKET" && !webSocketHealth.coolingDown();

  /** A request that names no speed gets its model's default; "fast" then goes upstream as priority. */
  async function withSpeedDefault(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!options.speedDefaults || body.service_tier !== undefined || typeof body.model !== "string") return body;
    const defaults = await options.speedDefaults().catch(() => ({} as Record<string, string>));
    return defaults[body.model] === "fast" ? { ...body, service_tier: "fast" } : body;
  }

  /**
   * The account for one attempt: the continuation owner when there is one, else the sticky thread's account while
   * it has budget, else the routing strategy's pick. `none` explains an empty pool.
   */
  async function pickAccount(settings: GatewaySettings, scope: Set<string> | null, tried: Set<string>, stickyHash: string | null,
    ownerAccountId: string | null, model: string | null): Promise<{ account?: GatewayAccountRecord; none?: { errorCode: string | null; errorMessage: string | null } }> {
    const inScope = (await options.pool.accounts()).filter((account) => (!scope || scope.has(account.id)) && !tried.has(account.id));
    if (ownerAccountId) return { account: inScope.find((candidate) => candidate.id === ownerAccountId) };
    const accounts = options.modelPlans ? options.modelPlans.eligible(inScope, model) : inScope;
    if (accounts.length === 0 && inScope.length > 0) {
      return { none: { errorCode: "no_plan_support_for_model", errorMessage: `No accounts with a plan supporting model '${model}'` } };
    }
    const states = accounts.map((candidate) => options.pool.toBalancerState(candidate));
    const stickyId = stickyHash && settings.stickyThreadsEnabled ? await stickyAccounts.get(stickyHash) : undefined;
    const stickyState = stickyId ? states.find((state) => state.accountId === stickyId) : undefined;
    if (stickyState) {
      const check = selectAccount([stickyState], { now: now() / 1000, routingStrategy: "SINGLE_ACCOUNT", allowUsageExhaustionError: false });
      const used = Math.max(stickyState.usedPercent ?? 0, stickyState.secondaryUsedPercent ?? 0);
      if (check.account && used < settings.stickyReallocationBudgetThresholdPercent) {
        return { account: accounts.find((candidate) => candidate.id === stickyState.accountId) };
      }
    }
    const result = selectAccount(states, {
      now: now() / 1000, routingStrategy: settings.routingStrategy, planPriority: settings.planPriority, preferEarlierReset: settings.preferEarlierReset, weeklyPace: true
    });
    for (const state of states) options.pool.absorb(state);
    if (!result.account) return { none: { errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null } };
    return { account: accounts.find((candidate) => candidate.id === result.account!.accountId) };
  }

  async function handle(request: FastifyRequest, reply: FastifyReply, dialect: "responses" | "v1-responses" | "chat") {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const requestId = header(request, "x-request-id") ?? `req_${randomUUID().replace(/-/g, "")}`;
    const input = request.body;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply.code(400).send(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error"));
    }
    let policy: PolicyResult;
    const chatBody = dialect === "chat" ? input as Record<string, unknown> : null;
    try {
      const responsesBody = await withSpeedDefault(chatBody ? chatToResponses(chatBody)
        : normalizeResponsesRequest(input as Record<string, unknown>, { openAiStyle: dialect === "v1-responses" }));
      policy = applyRequestPolicy(responsesBody, key);
      checkKeyLimits(key, policy.model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(error.envelope);
      if (error instanceof ChatRequestError) return reply.code(400).send(gatewayError("invalid_request", error.message, "invalid_request_error"));
      throw error;
    }
    const clientStreams = chatBody ? chatBody.stream === true : policy.body.stream === true;
    const includeUsage = Boolean((chatBody?.stream_options as { include_usage?: unknown } | undefined)?.include_usage);
    const settings = await options.settings();
    const stickySource = typeof policy.body.prompt_cache_key === "string" ? "prompt_cache_key"
      : header(request, "session_id") ? "session_id" : header(request, "x-codex-session-id") ? "x-codex-session-id" : null;
    const stickyRaw = stickySource === "prompt_cache_key" ? String(policy.body.prompt_cache_key) : stickySource ? header(request, stickySource) : null;
    const stickyHash = stickyRaw ? hashKey(`codex:${stickyRaw}`) : null;
    const compressed = await compressRequest(policy.body, request, key, settings, startedAt, stickyHash);
    const { outgoing, saved: compressionSaved, measured: compressionMeasured, detail } = compressed;
    const upstreamBody = JSON.stringify({ ...outgoing, stream: true });
    let upstreamTransport: "http" | "websocket" = "http";
    const previousResponseId = typeof policy.body.previous_response_id === "string" ? policy.body.previous_response_id : null;
    const ownerAccountId = previousResponseId ? await responseOwners.get(hashKey(`codex-response:${previousResponseId}`)) ?? null : null;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const tried = new Set<string>();
    const controller = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    const origin = requestOrigin(request);

    const baseLog = (): Omit<GatewayRequestLogInsert, "status" | "errorCode" | "errorMessage"> => ({
      requestId, requestedAt: new Date(startedAt).toISOString(), provider: "CODEX", accountId: null, apiKeyId: key.id,
      model: policy.model ?? "unknown", reasoningEffort: policy.reasoningEffort, requestedServiceTier: policy.requestedServiceTier,
      serviceTier: policy.serviceTier, transport: "http", upstreamTransport, latencyMs: null, firstTokenMs: null, inputTokens: null,
      cachedInputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, compressionTokensSaved: null,
      stickyKeySource: stickySource, stickyKind: ownerAccountId ? "CONTINUATION" : stickyHash ? "STICKY_THREAD" : null,
      stickyKeyHash: stickyHash ? stickyHash.slice(0, 16) : null, ...origin,
      compressionTokensBefore: compressionMeasured?.before ?? null, compressionTokensAfter: compressionMeasured?.after ?? null,
      compressionDetail: detail
    });

    let lastFailure: UpstreamFailure | null = null;
    let retryWith: GatewayAccountRecord | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { account, none } = retryWith ? { account: retryWith, none: undefined } : await pickAccount(settings, scope, tried, stickyHash, ownerAccountId, policy.model);
      retryWith = null;
      if (!account) {
        if (attempt === 0 && none) {
          const status = none.errorCode === USAGE_LIMIT_REACHED ? 429 : 503;
          options.logs.add({ ...baseLog(), status: "error", errorCode: none.errorCode ?? "no_accounts", errorMessage: none.errorMessage, latencyMs: now() - startedAt });
          return reply.code(status).send(gatewayError(none.errorCode ?? "no_accounts", none.errorMessage ?? gatewayErrors.noAccounts().error.message,
            status === 429 ? "rate_limit_error" : "server_error"));
        }
        break;
      }
      tried.add(account.id);
      options.pool.markSelected(account.id, reply.raw);

      let credentials;
      try {
        credentials = await options.pool.credentials(account);
      } catch (error) {
        lastFailure = { kind: "permanent", status: 401, code: String((error as { code?: unknown }).code ?? "credential_error"),
          message: error instanceof Error ? error.message : "Account credentials are unavailable.", error: {}, body: null };
        if (ownerAccountId) break;
        continue;
      }

      const upstreamHeaders = buildCodexUpstreamHeaders(request.headers, credentials.accessToken, credentials.upstreamAccountId);
      let upstream: Response | null = null;
      upstreamTransport = "http";
      if (promoteToWebSocket(settings)) {
        // HTTP to WebSocket promotion: the same events, carried over a one-request upstream WebSocket.
        try {
          const opened = await openWebSocket(upstreamWebSocketUrl(upstreamUrl), upstreamWebSocketHeaders(upstreamHeaders), { signal: controller.signal });
          webSocketHealth.markSuccess();
          recordPassiveUsage(account.id, handshakeHeaders(opened.headers));
          upstream = webSocketResponse(opened, responseCreateFrame(outgoing));
          upstreamTransport = "websocket";
        } catch (error) {
          if (controller.signal.aborted) return reply;
          if (error instanceof UpstreamHandshakeError && accountHandshakeStatuses.has(error.status)) {
            // About the account (codex-lb never falls back on 401, 404 or 429): handled like the same HTTP answer.
            upstream = new Response(error.body ?? "", { status: error.status });
            upstreamTransport = "websocket";
          } else if (!(error instanceof UpstreamHandshakeError) || error.transport) {
            // The transport failed, not the account: HTTP for this request and, for 60 s, every other one.
            webSocketHealth.markFailure();
          }
        }
      }
      if (!upstream) {
        try {
          upstream = await fetchImpl(upstreamUrl, { method: "POST", body: upstreamBody, signal: controller.signal, headers: upstreamHeaders });
        } catch (error) {
          if (controller.signal.aborted) return reply;
          options.pool.markTransientError(account.id);
          lastFailure = { kind: "transient", status: 502, code: "upstream_unavailable", message: error instanceof Error ? error.message : "Upstream unavailable",
            error: {}, body: null };
          if (ownerAccountId) break;
          continue;
        }
        recordPassiveUsage(account.id, upstream.headers);
      }

      if (!upstream.ok) {
        const failure = parseUpstreamError(await readBounded(upstream), upstream.status);
        lastFailure = failure;
        if (failure.kind === "surface") break;
        retryWith = await recordFailure(account, failure);
        // The same account once more, with its refreshed token: it does not count as another attempt.
        if (retryWith) { attempt -= 1; continue; }
        if (ownerAccountId) break;
        continue;
      }

      // Stream: hold the start of the reply until output begins, so a failure before that can still move accounts.
      const reader = upstream.body!.getReader();
      const inspector = new ResponseStreamInspector();
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      let committed = false;
      let firstTokenAt: number | null = null;
      const translator = chatBody ? new ChatStreamTranslator(policy.model ?? "unknown", Math.floor(startedAt / 1000), includeUsage) : null;
      const forward = (chunk: Uint8Array) => {
        const out = translator ? translator.push(chunk) : chunk;
        if (out.byteLength > 0) reply.raw.write(out);
      };
      const commit = () => {
        committed = true;
        if (!clientStreams) return;
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-request-id": requestId,
          "x-accel-buffering": "no" });
        for (const chunk of held) forward(chunk);
        held.length = 0;
      };
      let movedOn = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const startedOutput = inspector.push(value);
          if (startedOutput && firstTokenAt === null) firstTokenAt = now();
          if (committed) {
            if (clientStreams) forward(value);
            continue;
          }
          held.push(value);
          heldBytes += value.byteLength;
          const failedEarly = inspector.outcome.status === "failed" && !inspector.outputStarted;
          if (failedEarly && !ownerAccountId) {
            const failure = parseUpstreamError(JSON.stringify({ error: { code: inspector.outcome.errorCode, message: inspector.outcome.errorMessage } }), 200);
            if (failure.kind !== "surface" && attempt + 1 < maxAttempts) {
              await reader.cancel().catch(() => undefined);
              lastFailure = failure;
              await recordFailure(account, failure);
              movedOn = true;
              break;
            }
          }
          if (inspector.outputStarted || heldBytes > bufferLimit) commit();
        }
      } catch (error) {
        if (controller.signal.aborted) {
          finish(account, inspector, firstTokenAt, "client_closed");
          return reply;
        }
        if (!committed && !ownerAccountId) {
          options.pool.markTransientError(account.id);
          lastFailure = { kind: "transient", status: 502, code: "stream_incomplete", message: error instanceof Error ? error.message : "Stream interrupted", error: {}, body: null };
          continue;
        }
        if (clientStreams && committed) {
          if (translator) reply.raw.write(translator.finish());
          reply.raw.end();
        }
        finish(account, inspector, firstTokenAt, "stream_incomplete");
        return reply;
      }
      if (movedOn) continue;

      if (!committed) commit();
      finish(account, inspector, firstTokenAt, null);
      if (inspector.outcome.responseId) responseOwners.set(hashKey(`codex-response:${inspector.outcome.responseId}`), account.id);
      if (stickyHash) stickyAccounts.set(stickyHash, account.id);
      if (inspector.outcome.status === "success") void options.pool.markSuccess(account.id).catch(() => undefined);
      if (clientStreams) {
        if (translator) reply.raw.write(translator.finish());
        reply.raw.end();
        return reply;
      }
      if (inspector.outcome.status === "success" && inspector.finalResponse) {
        const body = chatBody ? responseToChatCompletion(inspector.finalResponse, policy.model ?? "unknown", Math.floor(startedAt / 1000)) : inspector.finalResponse;
        return reply.header("x-request-id", requestId).send(body);
      }
      return reply.code(502).header("x-request-id", requestId).send(gatewayError(inspector.outcome.errorCode ?? "upstream_error",
        inspector.outcome.errorMessage ?? "The upstream response did not complete."));
    }

    // Every attempt failed before any output reached the client.
    const failure = lastFailure ?? { kind: "transient" as const, status: 503, code: "no_accounts", message: gatewayErrors.noAccounts().error.message, error: {}, body: null };
    // The row names the account that answered last (null only when none was tried): "no account" rows hid upstream answers.
    options.logs.add({ ...baseLog(), accountId: [...tried].at(-1) ?? null, status: "error", errorCode: failure.code, errorMessage: failure.message, latencyMs: now() - startedAt });
    if (failure.kind === "surface" && failure.body) {
      return reply.code(failure.status).header("content-type", "application/json").header("x-request-id", requestId).send(failure.body);
    }
    const status = failure.kind === "rate_limit" || failure.kind === "quota" ? 429 : failure.status >= 400 ? failure.status : 502;
    return reply.code(status).header("x-request-id", requestId).send(gatewayError(failure.code, failure.message, status === 429 ? "rate_limit_error" : "server_error"));

    function finish(account: GatewayAccountRecord, inspector: ResponseStreamInspector, firstTokenAt: number | null, forcedError: string | null) {
      finishRequest({ key, account, inspector, firstTokenAt, forcedError, policy, startedAt, baseLog: baseLog(), compressionSaved });
    }
  }

  /**
   * Remote context compaction (`/responses/compact`), after codex-lb: a JSON request and reply, moved to another
   * account on rate limits, 5xx and dead credentials.
   */
  async function compact(request: FastifyRequest, reply: FastifyReply, openAiStyle: boolean) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const requestId = header(request, "x-request-id") ?? `req_${randomUUID().replace(/-/g, "")}`;
    const input = request.body;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply.code(400).send(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error"));
    }
    let policy: PolicyResult;
    try {
      policy = applyRequestPolicy(await withSpeedDefault(normalizeResponsesRequest(input as Record<string, unknown>, { openAiStyle, compact: true })), key);
      checkKeyLimits(key, policy.model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(error.envelope);
      if (error instanceof ChatRequestError) return reply.code(400).send(gatewayError("invalid_request", error.message, "invalid_request_error"));
      throw error;
    }
    const settings = await options.settings();
    const body = { ...policy.body };
    delete body.stream;
    const upstreamBody = JSON.stringify(body);
    const stickyRaw = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : header(request, "session_id") ?? header(request, "x-codex-session-id");
    const stickyHash = stickyRaw ? hashKey(`codex:${stickyRaw}`) : null;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const tried = new Set<string>();
    const log = (fields: Partial<GatewayRequestLogInsert> & Pick<GatewayRequestLogInsert, "status" | "errorCode">) => options.logs.add({
      requestId, requestedAt: new Date(startedAt).toISOString(), provider: "CODEX", accountId: null, apiKeyId: key.id, model: policy.model ?? "unknown",
      reasoningEffort: policy.reasoningEffort, requestedServiceTier: policy.requestedServiceTier, serviceTier: policy.serviceTier, transport: "http",
      upstreamTransport: "http", latencyMs: now() - startedAt, firstTokenMs: null, inputTokens: null, cachedInputTokens: null, outputTokens: null,
      reasoningTokens: null, costUsd: null, compressionTokensSaved: null, stickyKeySource: null, stickyKind: stickyHash ? "STICKY_THREAD" : null,
      stickyKeyHash: stickyHash ? stickyHash.slice(0, 16) : null, errorMessage: null, ...requestOrigin(request), ...fields
    });
    let lastFailure: UpstreamFailure | null = null;
    let retryWith: GatewayAccountRecord | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { account, none } = retryWith ? { account: retryWith, none: undefined } : await pickAccount(settings, scope, tried, stickyHash, null, policy.model);
      retryWith = null;
      if (!account) {
        if (attempt === 0 && none) {
          const status = none.errorCode === USAGE_LIMIT_REACHED ? 429 : 503;
          log({ status: "error", errorCode: none.errorCode ?? "no_accounts", errorMessage: none.errorMessage });
          return reply.code(status).send(gatewayError(none.errorCode ?? "no_accounts", none.errorMessage ?? gatewayErrors.noAccounts().error.message,
            status === 429 ? "rate_limit_error" : "server_error"));
        }
        break;
      }
      tried.add(account.id);
      options.pool.markSelected(account.id, reply.raw);
      let upstream: Response;
      try {
        const credentials = await options.pool.credentials(account);
        upstream = await fetchImpl(`${upstreamUrl}/compact`, {
          method: "POST", body: upstreamBody, signal: AbortSignal.timeout(300_000),
          headers: buildCodexUpstreamHeaders(request.headers, credentials.accessToken, credentials.upstreamAccountId, "application/json")
        });
      } catch (error) {
        options.pool.markTransientError(account.id);
        lastFailure = { kind: "transient", status: 502, code: "upstream_unavailable", message: error instanceof Error ? error.message : "Upstream unavailable", error: {}, body: null };
        continue;
      }
      if (!upstream.ok) {
        const failure = parseUpstreamError(await readBounded(upstream), upstream.status);
        lastFailure = failure;
        if (failure.kind === "surface") break;
        retryWith = await recordFailure(account, failure);
        if (retryWith) attempt -= 1;
        continue;
      }
      const text = await upstream.text();
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* passed through as is */ }
      const usage = readResponseUsage(parsed);
      const model = typeof parsed?.model === "string" ? parsed.model : policy.model;
      const cost = costUsd(usage, model, policy.serviceTier);
      if (usage && options.settleKeyUsage) {
        void options.settleKeyUsage(key.id, { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
          costMicros: Math.round((cost ?? 0) * 1e6), model, at: new Date(startedAt).toISOString() }).catch(() => undefined);
      }
      log({ status: "success", errorCode: null, accountId: account.id, planType: account.planType, model: model ?? "unknown", inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, costUsd: cost });
      if (stickyHash) stickyAccounts.set(stickyHash, account.id);
      void options.pool.markSuccess(account.id).catch(() => undefined);
      void options.pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
      return reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json").header("x-request-id", requestId).send(text);
    }
    const failure = lastFailure ?? { kind: "transient" as const, status: 503, code: "no_accounts", message: gatewayErrors.noAccounts().error.message, error: {}, body: null };
    log({ accountId: [...tried].at(-1) ?? null, status: "error", errorCode: failure.code, errorMessage: failure.message });
    if (failure.kind === "surface" && failure.body) {
      return reply.code(failure.status).header("content-type", "application/json").header("x-request-id", requestId).send(failure.body);
    }
    const status = failure.kind === "rate_limit" || failure.kind === "quota" ? 429 : failure.status >= 400 ? failure.status : 502;
    return reply.code(status).header("x-request-id", requestId).send(gatewayError(failure.code, failure.message, status === 429 ? "rate_limit_error" : "server_error"));
  }

  app.post("/backend-api/codex/responses/compact", (request, reply) => compact(request, reply, false));
  app.post("/v1/responses/compact", (request, reply) => compact(request, reply, true));
  app.post("/backend-api/codex/responses", (request, reply) => handle(request, reply, "responses"));
  app.post("/v1/responses", (request, reply) => handle(request, reply, "v1-responses"));
  app.post("/v1/chat/completions", (request, reply) => handle(request, reply, "chat"));

  if (options.webSockets) {
    registerCodexWebSocketRoutes(app, helpers, {
      options, now, upstreamUrl, maxAttempts, bufferLimit, health: webSocketHealth, openWebSocket, registry: options.webSockets,
      pickAccount, recordFailure, parseUpstreamError, recordPassiveUsage, withSpeedDefault, compressRequest, finishRequest, responseOwners, stickyAccounts
    });
  }
}
