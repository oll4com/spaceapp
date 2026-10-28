import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayCompressionRow, GatewayCompressionSignalRow, GatewayRequestLogInsert } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { compressAnthropicBodyAsync, type AsyncBlockRunner, type CompressionCache, type RawBlockRegistry } from "../../compression/engine.js";
import { outputPolicyText, requestOutputPolicy, withAnthropicOutputPolicy } from "../../compression/output-policy.js";
import { effectiveCompression, requestCompressionMode } from "../../compression/provider-settings.js";
import { compressionDetail, compressionRows, compressionSignalRows } from "../../compression/recorder.js";
import { gatewayError, gatewayErrors, type GatewayErrorEnvelope } from "../../errors.js";
import { assertModelAllowed, checkKeyLimits, PolicyRejection } from "../../policy.js";
import { claudeCostUsd } from "../../pricing/pricing.js";
import { StickyStore } from "../../accounts/sticky-store.js";
import { requestOrigin } from "../../client-detect.js";
import { hashKey, header, readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { permanentFailureCodes, selectAccount, USAGE_LIMIT_REACHED, type SelectionResult, type UpstreamError } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { apiBudgetMessage, DAILY_ALLOWANCE_REACHED, MONTHLY_BUDGET_REACHED, type createApiBudgetPacer } from "./api-budget.js";
import { claudeCreditsExhausted, isClaudeApiKeyAccount, isClaudeCodeRequest } from "./api-key.js";
import { buildClaudeUpstreamHeaders, CLAUDE_API_BASE_URL, type ClaudeUpstreamAuth } from "./headers.js";
import { ClaudeStreamInspector, claudeResponseUsage, readClaudeRateLimitHeaders, type ClaudeUsageTokens } from "./stream.js";

/**
 * Anthropic Messages proxy (`/v1/messages`, `/v1/messages/count_tokens`) over pooled Claude subscription accounts:
 * pick an account, swap in its token, stream the reply through, and move to another account when a failure
 * happens before any content reached the client. A conversation stays on one account while it can, because the
 * prompt cache belongs to the account.
 */
const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

export interface ClaudeProxyOptions {
  pool: AccountPool;
  logs: RequestLogWriter;
  settings: () => Promise<GatewaySettings>;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAccountAttempts?: number;
  preOutputBufferBytes?: number;
  compression?: { run: AsyncBlockRunner; cache?: CompressionCache; rawBlocks?: RawBlockRegistry; record: (rows: GatewayCompressionRow[]) => Promise<void>;
    recordSignals?: (rows: GatewayCompressionSignalRow[]) => Promise<void> };
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
  /** Session affinity for the prompt cache; without it bindings live in memory only. */
  sticky?: StickyStore;
  /** The API-key account's pace to the monthly budget; without it only the keys' own caps apply. */
  apiBudget?: Pick<ReturnType<typeof createApiBudgetPacer>, "read" | "record">;
}

type FailureKind = "rate_limit" | "transient" | "permanent" | "surface";

interface UpstreamFailure {
  kind: FailureKind;
  status: number;
  code: string;
  message: string;
  error: UpstreamError;
  body: string | null;
}

function parseClaudeError(text: string, status: number, headers: Headers | null): UpstreamFailure {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  const error = (payload.error && typeof payload.error === "object" ? payload.error : {}) as Record<string, unknown>;
  const code = typeof error.type === "string" ? error.type : status >= 500 ? "api_error" : `http_${status}`;
  const message = typeof error.message === "string" ? error.message : text.slice(0, 300) || `Upstream returned HTTP ${status}`;
  const limits = headers ? readClaudeRateLimitHeaders(headers) : null;
  const retryAfter = Number(headers?.get("retry-after") ?? Number.NaN);
  const upstreamError: UpstreamError = {
    message,
    resetsAt: limits?.rejected && limits.resetAt !== null ? limits.resetAt : undefined,
    resetsInSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
  };
  // Every reply to a subscription token carries the unified rate-limit headers, and a real limit says "rejected".
  // A bare 429 without them (Anthropic's answer to a request that does not come from Claude Code) is about the
  // request, not the account: it goes back to the client and blocks no account.
  const requestRejected = status === 429 && headers !== null && headers.get("anthropic-ratelimit-unified-status") === null
    && upstreamError.resetsInSeconds === undefined;
  let kind: FailureKind;
  if (requestRejected) kind = "surface";
  else if (status === 429 || code === "rate_limit_error") kind = "rate_limit";
  else if (status === 401 || code === "authentication_error") kind = "permanent";
  else if (status >= 500 || code === "overloaded_error" || code === "api_error") kind = "transient";
  else kind = "surface";
  return { kind, status, code, message, error: upstreamError, body: text || null };
}

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * The request with Anthropic told to drop the thinking blocks an edited history invalidated (preserved thinking), or
 * null when thinking is off or the client chose its own binding behaviour. Omitted thinking runs adaptive on the
 * models that run this check.
 */
export function withStaleThinkingDropped(body: Record<string, unknown>): Record<string, unknown> | null {
  const thinking = (body.thinking ?? { type: "adaptive" }) as Record<string, unknown>;
  if (typeof thinking !== "object" || (thinking.type !== "adaptive" && thinking.type !== "enabled") || thinking.block_binding !== undefined) return null;
  return { ...body, thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } } };
}

/** Claude Code sends a session id header; older clients carry the session in `metadata.user_id`. */
function stickySource(request: FastifyRequest, body: Record<string, unknown>): { source: string; raw: string } | null {
  const session = header(request, "x-claude-code-session-id");
  if (session) return { source: "x-claude-code-session-id", raw: session };
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : null;
  const userId = typeof metadata?.user_id === "string" ? metadata.user_id : null;
  if (!userId) return null;
  const sessionPart = /session_([0-9a-f-]{8,})/i.exec(userId)?.[1];
  return { source: "metadata.user_id", raw: sessionPart ?? userId };
}

/**
 * The answer when every pooled account is at its limit. The balancer's "Try again in 300s" caps the wait at five
 * minutes, which reads as a short hiccup while a 5-hour window can be hours away; Claude Code shows this text as is.
 */
export function claudePoolLimitMessage(accounts: number, resetsAt: number | null | undefined, nowSeconds: number,
  timeZone?: string): string {
  const subject = accounts === 1 ? "The Claude account in Space Gateway reached its usage limit" : `All ${accounts} Claude accounts in Space Gateway reached their usage limit`;
  if (resetsAt === null || resetsAt === undefined || resetsAt <= nowSeconds) return `${subject}.`;
  const minutes = Math.ceil((resetsAt - nowSeconds) / 60);
  const wait = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const at = new Date(resetsAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) });
  return `${subject}. ${accounts === 1 ? "It is" : "The first one is"} back in ${wait} (at ${at}).`;
}

/** Anthropic clients read `{ type: "error", error: { type, message } }`. */
function anthropicError(envelope: GatewayErrorEnvelope) {
  return { type: "error", error: { type: envelope.error.type, message: envelope.error.message, code: envelope.error.code } };
}

function totalInput(usage: ClaudeUsageTokens): number | null {
  if (usage.inputTokens === null) return null;
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

export function registerClaudeProxyRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: ClaudeProxyOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = (options.upstreamBaseUrl ?? CLAUDE_API_BASE_URL).replace(/\/+$/, "");
  const maxAttempts = options.maxAccountAttempts ?? 3;
  const bufferLimit = options.preOutputBufferBytes ?? 4 * 1024 * 1024;
  /** conversation key hash -> account, so the prompt cache keeps hitting. */
  const stickyAccounts = options.sticky ?? new StickyStore({ provider: "CLAUDE", kind: "PROMPT_CACHE" });

  const queryOf = (request: FastifyRequest) => {
    const index = request.url.indexOf("?");
    return index >= 0 ? request.url.slice(index) : "";
  };

  const authFor = (account: GatewayAccountRecord): ClaudeUpstreamAuth => (isClaudeApiKeyAccount(account) ? "api-key" : "bearer");

  /**
   * The subscription accounts come first, sticky binding included. With the Claude API key fallback on, the API-key
   * account serves only while none of them can; every request decides again, so the accounts take over at the first
   * request after one of them resets. A conversation never binds to the key: its prompt cache is not worth staying.
   * Claude Code never reaches the key (`keyAllowed` false): it gets the subscription pool's own limit answer.
   */
  async function pickAccount(settings: GatewaySettings, scope: Set<string> | null, tried: Set<string>, stickyHash: string | null, keyAllowed: boolean) {
    const candidates = (await options.pool.accounts()).filter((account) => (!scope || scope.has(account.id)) && !tried.has(account.id));
    const accounts = candidates.filter((account) => !isClaudeApiKeyAccount(account));
    const states = accounts.map((candidate) => options.pool.toBalancerState(candidate));
    const pooled = accounts.filter((candidate) => candidate.status !== "PAUSED" && candidate.status !== "DEACTIVATED").length;
    const stickyId = stickyHash ? await stickyAccounts.get(stickyHash) : undefined;
    const stickyState = stickyId ? states.find((state) => state.accountId === stickyId) : undefined;
    if (stickyState) {
      const check = selectAccount([stickyState], { now: now() / 1000, routingStrategy: "SINGLE_ACCOUNT", allowUsageExhaustionError: false });
      const used = Math.max(stickyState.usedPercent ?? 0, stickyState.secondaryUsedPercent ?? 0);
      if (check.account && used < settings.stickyReallocationBudgetThresholdPercent) {
        return { account: accounts.find((candidate) => candidate.id === stickyState.accountId), result: null, pooled, fallback: false };
      }
    }
    const result = selectAccount(states, { now: now() / 1000, routingStrategy: settings.routingStrategy, preferEarlierReset: settings.preferEarlierReset, weeklyPace: true });
    for (const state of states) options.pool.absorb(state);
    const account = result.account ? accounts.find((candidate) => candidate.id === result.account!.accountId) : undefined;
    if (account || !settings.claudeApiKeyFallback || !keyAllowed) return { account, result, pooled, fallback: false };
    const keys = candidates.filter(isClaudeApiKeyAccount);
    const pace = keys.length ? await options.apiBudget?.read() : null;
    if (pace?.stop) return { account: undefined, result: { account: null, errorCode: pace.stop, errorMessage: apiBudgetMessage(pace) } as SelectionResult, pooled, fallback: false };
    const keyStates = keys.map((candidate) => options.pool.toBalancerState(candidate));
    const pick = selectAccount(keyStates, { now: now() / 1000, routingStrategy: "ROUND_ROBIN", allowUsageExhaustionError: false });
    for (const state of keyStates) options.pool.absorb(state);
    const key = pick.account ? keys.find((candidate) => candidate.id === pick.account!.accountId) : undefined;
    return { account: key, result, pooled, fallback: Boolean(key) };
  }

  async function messages(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const requestId = header(request, "x-request-id") ?? `req_${randomUUID().replace(/-/g, "")}`;
    const input = request.body;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply.code(400).send(anthropicError(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error")));
    }
    const body: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    if (key.enforcedModel) body.model = key.enforcedModel;
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    // These models 400 on thinking "disabled" (Qoder's WebFetch side call sends it); without the field they run adaptive.
    if (model && /^claude-(fable-5|mythos-5|opus-5-5|sonnet-5-5)/.test(model) && (body.thinking as { type?: unknown } | undefined)?.type === "disabled") delete body.thinking;
    try {
      assertModelAllowed(key, model);
      checkKeyLimits(key, model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(anthropicError(error.envelope));
      throw error;
    }

    const settings = await options.settings();
    const effective = effectiveCompression(settings, "CLAUDE");
    const compressionMode = requestCompressionMode(effective, key.compressionOverride, header(request, "x-space-gateway-compression"));
    const origin = requestOrigin(request);
    const keyAllowed = !isClaudeCodeRequest(request.headers);
    const outputPolicy = requestOutputPolicy({ policy: effective.outputPolicy, key, clientName: origin.clientName,
      headerValue: header(request, "x-space-gateway-output-policy") });
    let compressionSaved: number | null = null;
    let compressionMeasured: { before: number; after: number } | null = null;
    let detail: GatewayRequestLogInsert["compressionDetail"] = null;
    let outgoing = body;
    const sticky = stickySource(request, body);
    const stickyHash = sticky ? hashKey(`claude:${sticky.raw}`) : null;
    if (compressionMode !== "OFF" && options.compression) {
      try {
        const outcome = await compressAnthropicBodyAsync(body, { run: options.compression.run, cache: options.compression.cache,
          timeBudgetMs: effective.timeBudgetMs, codeText: effective.codeText, profile: effective.profile,
          sessionKey: stickyHash ?? undefined, rawBlocks: options.compression.rawBlocks });
        if (outcome.tokensBefore > 0) compressionMeasured = { before: outcome.tokensBefore, after: outcome.tokensAfter };
        if (compressionMode === "ON" && outcome.modified) {
          outgoing = outcome.body;
          compressionSaved = outcome.tokensBefore - outcome.tokensAfter;
        }
        void options.compression.record(compressionRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "CLAUDE" }))
          .catch(() => undefined);
        void options.compression.recordSignals?.(compressionSignalRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "CLAUDE" }))
          .catch(() => undefined);
        detail = compressionDetail(outcome);
      } catch {
        // Compression never blocks a request: the original body goes upstream.
      }
    }
    const policyText = outputPolicyText(outputPolicy);
    const withPolicy = policyText ? withAnthropicOutputPolicy(outgoing, policyText) : null;
    if (withPolicy) {
      outgoing = withPolicy;
      detail = { ...(detail ?? { strategies: [], waste: {} }), outputPolicy };
    }
    let upstreamBody = JSON.stringify(outgoing);
    let extraBetas: string[] = [];
    // A conversation that already has a cache binding: a large cache write now means its cached prefix was lost.
    const continuing = stickyHash ? (await stickyAccounts.get(stickyHash)) !== undefined : false;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const tried = new Set<string>();
    const controller = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    const upstreamUrl = `${baseUrl}/v1/messages${queryOf(request)}`;

    const baseLog = (): Omit<GatewayRequestLogInsert, "status" | "errorCode" | "errorMessage"> => ({
      requestId, requestedAt: new Date(startedAt).toISOString(), provider: "CLAUDE", accountId: null, apiKeyId: key.id,
      model: model ?? "unknown", reasoningEffort: null, requestedServiceTier: null, serviceTier: null, transport: "http", upstreamTransport: "http",
      latencyMs: null, firstTokenMs: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null,
      compressionTokensSaved: null, stickyKeySource: sticky?.source ?? null, stickyKind: stickyHash ? "PROMPT_CACHE" : null,
      stickyKeyHash: stickyHash ? stickyHash.slice(0, 16) : null, ...origin,
      compressionTokensBefore: compressionMeasured?.before ?? null, compressionTokensAfter: compressionMeasured?.after ?? null,
      compressionDetail: detail
    });

    let lastFailure: UpstreamFailure | null = null;
    let retryWith = null as { account: GatewayAccountRecord; fallback: boolean } | null;
    let upstreamRequestId: string | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { account, result, pooled, fallback }: Awaited<ReturnType<typeof pickAccount>> = retryWith ? { ...retryWith, result: null, pooled: 0 }
        : await pickAccount(settings, scope, tried, stickyHash, keyAllowed);
      retryWith = null;
      if (!account) {
        if (attempt === 0 && result) {
          const budget = result.errorCode === MONTHLY_BUDGET_REACHED || result.errorCode === DAILY_ALLOWANCE_REACHED;
          const limited = budget || result.errorCode === USAGE_LIMIT_REACHED;
          const status = limited ? 429 : 503;
          const message = budget ? result.errorMessage! : limited ? claudePoolLimitMessage(pooled, result.resetsAt, now() / 1000)
            : result.errorMessage ?? gatewayErrors.noAccounts().error.message;
          options.logs.add({ ...baseLog(), status: "error", errorCode: result.errorCode ?? "no_accounts", errorMessage: message, latencyMs: now() - startedAt });
          return reply.code(status).send(anthropicError(gatewayError(result.errorCode ?? "no_accounts", message,
            status === 429 ? "rate_limit_error" : "api_error")));
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
        continue;
      }

      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: "POST", body: upstreamBody, signal: controller.signal,
          headers: buildClaudeUpstreamHeaders(request.headers, credentials.accessToken, body.stream === true ? "text/event-stream" : "application/json", authFor(account),
            extraBetas)
        });
      } catch (error) {
        if (controller.signal.aborted) return reply;
        options.pool.markTransientError(account.id);
        lastFailure = { kind: "transient", status: 502, code: "upstream_unavailable", message: error instanceof Error ? error.message : "Upstream unavailable",
          error: {}, body: null };
        continue;
      }

      const passive = readClaudeRateLimitHeaders(upstream.headers);
      void options.pool.recordUsage(account.id, {
        primaryUsedPercent: passive.fiveHourUsedPercent, secondaryUsedPercent: passive.weeklyUsedPercent,
        primaryResetAt: passive.fiveHourResetAt, secondaryResetAt: passive.weeklyResetAt,
        primaryWindowMinutes: FIVE_HOURS_MINUTES, secondaryWindowMinutes: WEEK_MINUTES
      }).catch(() => undefined);

      if (!upstream.ok) {
        const failure = parseClaudeError(await readBounded(upstream), upstream.status, upstream.headers);
        lastFailure = failure;
        // Used-up prepaid credits: the key leaves routing as any used-up quota does, and Anthropic's answer goes to the client.
        if (fallback && claudeCreditsExhausted(failure.status, failure.message)) await options.pool.markQuotaExceeded(account, failure.error);
        // A client that edits its history (Qoder) would fail every later turn the same way: once more on the same
        // account, with the stale thinking blocks dropped as the error itself suggests.
        const dropped = extraBetas.length === 0 && failure.status === 400 && failure.message.includes("bound to a different conversation")
          ? withStaleThinkingDropped(outgoing) : null;
        if (dropped) {
          upstreamBody = JSON.stringify(dropped);
          extraBetas = [THINKING_BINDING_BETA];
          retryWith = { account, fallback };
          attempt -= 1;
          continue;
        }
        if (failure.kind === "surface") break;
        const renewed = await recordFailure(account, failure);
        // The same account once more, with its refreshed token: it does not count as another attempt.
        if (renewed) { retryWith = { account: renewed, fallback }; attempt -= 1; }
        continue;
      }

      upstreamRequestId = upstream.headers.get("request-id");
      if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const text = await upstream.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { /* passed through as is */ }
        const usage = claudeResponseUsage(parsed);
        const responseModel = parsed && typeof (parsed as { model?: unknown }).model === "string" ? (parsed as { model: string }).model : model;
        finish(account, usage, responseModel, null, null);
        if (stickyHash && !fallback) stickyAccounts.set(stickyHash, account.id);
        void options.pool.markSuccess(account.id).catch(() => undefined);
        reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json").header("x-request-id", requestId);
        if (upstreamRequestId) reply.header("request-id", upstreamRequestId);
        return reply.send(text);
      }

      // Stream: hold the start of the reply until content begins, so a failure before that can still move accounts.
      const reader = upstream.body!.getReader();
      const inspector = new ClaudeStreamInspector();
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      let committed = false;
      let firstTokenAt: number | null = null;
      const commit = () => {
        committed = true;
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-request-id": requestId,
          "x-accel-buffering": "no", ...(upstreamRequestId ? { "request-id": upstreamRequestId } : {}) });
        for (const chunk of held) reply.raw.write(chunk);
        held.length = 0;
      };
      let movedOn = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const startedOutput = inspector.push(value);
          if (startedOutput && firstTokenAt === null) firstTokenAt = now();
          if (committed) { reply.raw.write(value); continue; }
          held.push(value);
          heldBytes += value.byteLength;
          if (inspector.status === "failed" && !inspector.outputStarted) {
            const failure = parseClaudeError(JSON.stringify({ error: { type: inspector.errorType, message: inspector.errorMessage } }), 200, null);
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
          finish(account, inspector.usage, inspector.model ?? model, firstTokenAt, "client_closed");
          return reply;
        }
        if (!committed) {
          options.pool.markTransientError(account.id);
          lastFailure = { kind: "transient", status: 502, code: "stream_incomplete", message: error instanceof Error ? error.message : "Stream interrupted", error: {}, body: null };
          continue;
        }
        reply.raw.end();
        finish(account, inspector.usage, inspector.model ?? model, firstTokenAt, "stream_incomplete");
        return reply;
      }
      if (movedOn) continue;
      if (!committed) commit();
      reply.raw.end();
      const failed = inspector.status === "failed" ? inspector.errorType ?? "api_error" : inspector.status === "unterminated" ? "stream_incomplete" : null;
      finish(account, inspector.usage, inspector.model ?? model, firstTokenAt, failed, inspector.errorMessage);
      if (stickyHash && !fallback) stickyAccounts.set(stickyHash, account.id);
      if (!failed) void options.pool.markSuccess(account.id).catch(() => undefined);
      return reply;
    }

    // Every attempt failed before any content reached the client.
    const failure = lastFailure ?? { kind: "transient" as const, status: 503, code: "no_accounts", message: gatewayErrors.noAccounts().error.message, error: {}, body: null };
    // The row names the account that answered last (null only when none was tried): "no account" rows hid upstream answers.
    options.logs.add({ ...baseLog(), accountId: [...tried].at(-1) ?? null, status: "error", errorCode: failure.code, errorMessage: failure.message, latencyMs: now() - startedAt });
    if (failure.kind === "surface" && failure.body) {
      return reply.code(failure.status).header("content-type", "application/json").header("x-request-id", requestId).send(failure.body);
    }
    const status = failure.kind === "rate_limit" ? 429 : failure.status >= 400 ? failure.status : 502;
    return reply.code(status).header("x-request-id", requestId).send(anthropicError(gatewayError(failure.code, failure.message,
      status === 429 ? "rate_limit_error" : "api_error")));

    /** Records a failed attempt; the account to retry on when its rejected access token (HTTP 401) was refreshed. */
    async function recordFailure(account: GatewayAccountRecord, failure: UpstreamFailure): Promise<GatewayAccountRecord | null> {
      const code = failure.code in permanentFailureCodes ? failure.code : "token_invalidated";
      if (failure.kind === "permanent" && failure.status === 401) return options.pool.refreshRejectedToken(account, code);
      if (failure.kind === "rate_limit") await options.pool.markRateLimited(account, failure.error);
      else if (failure.kind === "permanent") await options.pool.markPermanentFailure(account, code);
      else options.pool.markTransientError(account.id);
      return null;
    }

    /** Headroom's bust rule: on a continuing conversation, cache writes above half of the cache traffic. Null without cache traffic. */
    function cacheBust(usage: ClaudeUsageTokens): boolean | null {
      const read = usage.cacheReadInputTokens ?? 0;
      const write = usage.cacheCreationInputTokens ?? 0;
      if (read + write === 0) return null;
      return continuing && write > 0.5 * (read + write);
    }

    function finish(account: GatewayAccountRecord, usage: ClaudeUsageTokens, responseModel: string | null, firstTokenAt: number | null,
      errorCode: string | null, errorMessage: string | null = null) {
      const cost = claudeCostUsd(usage, responseModel);
      if (isClaudeApiKeyAccount(account)) options.apiBudget?.record(cost);
      const inputTokens = totalInput(usage);
      if (inputTokens !== null && options.settleKeyUsage) {
        void options.settleKeyUsage(key.id, {
          inputTokens, outputTokens: usage.outputTokens ?? 0, costMicros: Math.round((cost ?? 0) * 1e6), model: responseModel, at: new Date(startedAt).toISOString()
        }).catch(() => undefined);
      }
      options.logs.add({
        ...baseLog(), accountId: account.id, planType: account.planType, model: responseModel ?? "unknown", status: errorCode ? "error" : "success",
        errorCode, errorMessage: errorCode ? errorMessage : null, latencyMs: now() - startedAt,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, inputTokens, cachedInputTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens, outputTokens: usage.outputTokens, costUsd: cost, compressionTokensSaved: compressionSaved,
        cacheBust: cacheBust(usage), upstreamRequestId: upstreamRequestId && /^[\w-]{1,120}$/.test(upstreamRequestId) ? upstreamRequestId : null
      });
      void options.pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
    }
  }

  /** The usable accounts for free calls: subscription accounts first, the API-key account last, only with the fallback on and never for Claude Code. */
  async function usableAccounts(scope: Set<string> | null, request: FastifyRequest): Promise<GatewayAccountRecord[]> {
    const settings = await options.settings();
    const keyAllowed = settings.claudeApiKeyFallback && !isClaudeCodeRequest(request.headers);
    return (await options.pool.accounts()).filter((account) => (!scope || scope.has(account.id))
      && account.status !== "PAUSED" && account.status !== "DEACTIVATED" && account.status !== "REAUTH_REQUIRED"
      && (keyAllowed || !isClaudeApiKeyAccount(account)))
      .sort((left, right) => Number(isClaudeApiKeyAccount(left)) - Number(isClaudeApiKeyAccount(right)));
  }

  /** Token counting costs no quota; any usable account answers it. */
  async function countTokens(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const key = request.gatewayApiKey!;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const accounts = await usableAccounts(scope, request);
    let body: Record<string, unknown> = request.body && typeof request.body === "object" ? { ...(request.body as Record<string, unknown>) } : {};
    if (key.enforcedModel) body.model = key.enforcedModel;
    // Counting is free upstream, but it still names a model: the key's allowlist and spent limits apply as on /v1/messages.
    try {
      assertModelAllowed(key, typeof body.model === "string" && body.model.trim() ? body.model.trim() : null);
      checkKeyLimits(key, typeof body.model === "string" ? body.model.trim() || null : null, new Date().toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(anthropicError(error.envelope));
      throw error;
    }
    // The count must match what /v1/messages sends, so Claude Code's context accounting includes the output policy.
    const policyText = outputPolicyText(requestOutputPolicy({ policy: effectiveCompression(await options.settings(), "CLAUDE").outputPolicy, key,
      clientName: requestOrigin(request).clientName, headerValue: header(request, "x-space-gateway-output-policy") }));
    body = (policyText ? withAnthropicOutputPolicy(body, policyText) : null) ?? body;
    for (const account of accounts.slice(0, 2)) {
      try {
        const credentials = await options.pool.credentials(account);
        const upstream = await fetchImpl(`${baseUrl}/v1/messages/count_tokens${queryOf(request)}`, {
          method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
          headers: buildClaudeUpstreamHeaders(request.headers, credentials.accessToken, "application/json", authFor(account))
        });
        if (upstream.status >= 500) continue;
        return reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json").send(await upstream.text());
      } catch {
        // Try the next account.
      }
    }
    return reply.code(503).send(anthropicError(gatewayError("no_accounts", gatewayErrors.noAccounts().error.message, "api_error")));
  }

  /** Anthropic model list (`GET /v1/models` from Anthropic clients), from any usable account. */
  async function models(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const accounts = await usableAccounts(null, request);
    for (const account of accounts.slice(0, 2)) {
      try {
        const credentials = await options.pool.credentials(account);
        const upstream = await fetchImpl(`${baseUrl}/v1/models${queryOf(request)}`, {
          method: "GET", signal: AbortSignal.timeout(15_000), headers: buildClaudeUpstreamHeaders(request.headers, credentials.accessToken, "application/json", authFor(account))
        });
        if (upstream.status >= 500) continue;
        return reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json").send(await upstream.text());
      } catch {
        // Try the next account.
      }
    }
    return reply.code(503).send(anthropicError(gatewayError("no_accounts", gatewayErrors.noAccounts().error.message, "api_error")));
  }

  app.post("/v1/messages", messages);
  app.post("/v1/messages/count_tokens", countTokens);
  return { models };
}
