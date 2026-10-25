import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayProvider, GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { requestOrigin } from "../../client-detect.js";
import { gatewayError, gatewayErrors } from "../../errors.js";
import { costUsd } from "../../pricing/pricing.js";
import { checkKeyLimits, PolicyRejection } from "../../policy.js";
import { readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { selectAccount } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";

/**
 * API-key pools for OpenAI-compatible providers (operator decision 2026-10-12: key pools, no dialect translation).
 * A client points its OpenAI base URL at `/pools/<provider>/v1` with its gateway key; each request goes to one of
 * the provider keys in the pool, and moves to another key when one is rejected, out of credit, rate limited or
 * failing before any output. Bodies pass through unchanged: these providers speak the client's own dialect.
 */
export interface KeyPoolProvider {
  provider: Extract<GatewayProvider, "OPENAI_API" | "OPENROUTER" | "DEEPSEEK">;
  label: string;
  baseUrl: string;
  keyPattern: RegExp;
  /** A request that needs a valid key but spends nothing (the key check when it is added, and Test). */
  checkUrl: string;
}

export const keyPoolProviders: Record<"openai" | "openrouter" | "deepseek", KeyPoolProvider> = {
  openai: { provider: "OPENAI_API", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.openai.com/v1/models" },
  openrouter: { provider: "OPENROUTER", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyPattern: /^sk-or-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://openrouter.ai/api/v1/key" },
  deepseek: { provider: "DEEPSEEK", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.deepseek.com/user/balance" }
};

export type KeyPoolSlug = keyof typeof keyPoolProviders;
export const keyPoolSlugFor = (provider: GatewayProvider): KeyPoolSlug | null =>
  (Object.entries(keyPoolProviders).find(([, entry]) => entry.provider === provider)?.[0] as KeyPoolSlug | undefined) ?? null;

/** Whether a key works, by the provider's free check request. */
export async function checkPoolKey(entry: KeyPoolProvider, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetchImpl(entry.checkUrl, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const usageNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

export interface PoolUsage { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null }

/**
 * Token usage from a Chat Completions or Responses payload (`usage` at the top or inside `response`), with the
 * cost in USD when the provider reports it (OpenRouter's `usage.cost`).
 */
export function readPoolUsage(payload: unknown): PoolUsage | null {
  const holder = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const response = holder?.response && typeof holder.response === "object" ? holder.response as Record<string, unknown> : null;
  const usage = (holder?.usage ?? response?.usage) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  return {
    inputTokens: usageNumber(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: usageNumber(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens: usageNumber(details?.cached_tokens),
    costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 && usage.cost < 1000 ? usage.cost : null
  };
}

export function registerKeyPoolRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: {
  pools: Partial<Record<KeyPoolSlug, AccountPool>>; logs: RequestLogWriter; settings: () => Promise<GatewaySettings>;
  fetchImpl?: typeof fetch; now?: () => number; maxAccountAttempts?: number; baseUrls?: Partial<Record<KeyPoolSlug, string>>;
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAccountAttempts ?? 3;

  function poolFor(request: FastifyRequest, reply: FastifyReply): { slug: KeyPoolSlug; entry: KeyPoolProvider; pool: AccountPool; baseUrl: string } | null {
    const slug = (request.params as { provider?: string }).provider as KeyPoolSlug;
    const entry = keyPoolProviders[slug];
    const pool = entry ? options.pools[slug] : undefined;
    if (!entry || !pool) {
      void reply.code(404).send(gatewayError("unknown_pool", "Space Gateway has no key pool with this name.", "invalid_request_error"));
      return null;
    }
    return { slug, entry, pool, baseUrl: (options.baseUrls?.[slug] ?? entry.baseUrl).replace(/\/+$/, "") };
  }

  /** The next key: round robin over usable keys in the gateway key's scope (or one key, for single-account routing). */
  async function nextAccount(pool: AccountPool, settings: GatewaySettings, scope: Set<string> | null, tried: Set<string>) {
    const accounts = (await pool.accounts()).filter((account) => (!scope || scope.has(account.id)) && !tried.has(account.id));
    const states = accounts.map((account) => pool.toBalancerState(account));
    const result = selectAccount(states, { now: now() / 1000, routingStrategy: settings.routingStrategy === "SINGLE_ACCOUNT" ? "SINGLE_ACCOUNT" : "ROUND_ROBIN" });
    for (const state of states) pool.absorb(state);
    return result.account ? accounts.find((account) => account.id === result.account!.accountId) : undefined;
  }

  /** Marks a key by the upstream's answer; returns whether another key may be tried. */
  async function recordFailure(pool: AccountPool, account: GatewayAccountRecord, status: number, text: string): Promise<boolean> {
    let error: { code?: unknown; type?: unknown; message?: unknown } = {};
    try { error = (JSON.parse(text) as { error?: typeof error }).error ?? {}; } catch { /* not JSON */ }
    const message = typeof error.message === "string" ? error.message.slice(0, 300) : `HTTP ${status}`;
    // A rejected key leaves rotation until it is added again; a 403 can be about one model, so the key stays usable.
    if (status === 401) { await pool.refreshRejectedToken(account, "token_invalidated"); return true; }
    if (status === 403) { await pool.markPermanentFailure(account, "token_invalidated", false); return true; }
    if (status === 402 || ["insufficient_quota", "credit_balance_exhausted"].includes(String(error.code)) || error.type === "insufficient_quota") {
      // Out of credit: the key stays out of rotation for a day, or until the operator tops it up and tests it.
      await pool.markQuotaExceeded(account, { message, resetsInSeconds: 24 * 3600 });
      return true;
    }
    if (status === 429) { await pool.markRateLimited(account, { message }); return true; }
    if (status >= 500) { pool.markTransientError(account.id); return true; }
    return false;
  }

  async function forward(request: FastifyRequest, reply: FastifyReply, path: "chat/completions" | "responses") {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const target = poolFor(request, reply);
    if (!target) return reply;
    const { entry, pool, baseUrl } = target;
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? { ...(request.body as Record<string, unknown>) } : null;
    if (!body) return reply.code(400).send(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error"));
    if (key.enforcedModel) body.model = key.enforcedModel;
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    if (!model) return reply.code(400).send(gatewayError("invalid_request", "Missing required field: model.", "invalid_request_error"));
    try {
      if (key.allowedModels.length > 0 && !key.allowedModels.includes(model)) {
        throw new PolicyRejection(403, gatewayError("model_not_allowed", `This API key does not have access to model '${model}'`, "invalid_request_error"));
      }
      checkKeyLimits(key, model, new Date(startedAt).toISOString());
    } catch (error) {
      if (error instanceof PolicyRejection) return reply.code(error.statusCode).send(error.envelope);
      throw error;
    }
    const settings = await options.settings();
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    const streaming = body.stream === true;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const tried = new Set<string>();
    const log = (account: GatewayAccountRecord | null, status: "success" | "error", errorCode: string | null, usage: PoolUsage | null,
      firstTokenAt: number | null) => {
      // The provider's own figure first; OpenAI models fall back to the OpenAI list prices. Unknown stays unknown.
      const cost = usage?.costUsd ?? (entry.provider === "OPENAI_API" ? costUsd(usage, model, null) : null);
      options.logs.add({
        requestId, requestedAt: new Date(startedAt).toISOString(), provider: entry.provider, accountId: account?.id ?? null, apiKeyId: key.id, model,
        reasoningEffort: null, serviceTier: null, transport: "http", upstreamTransport: "http", status, errorCode, latencyMs: now() - startedAt,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: null, costUsd: cost,
        compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, ...requestOrigin(request)
      });
      if (usage && options.settleKeyUsage) {
        void options.settleKeyUsage(key.id, { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costMicros: Math.round((cost ?? 0) * 1e6), model,
          at: new Date(startedAt).toISOString() }).catch(() => undefined);
      }
    };
    const controller = new AbortController();
    request.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    let last: { status: number; text: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = await nextAccount(pool, settings, scope, tried);
      if (!account) break;
      tried.add(account.id);
      pool.markSelected(account.id, reply.raw);
      let upstream: Response;
      try {
        const credentials = await pool.credentials(account);
        upstream = await fetchImpl(`${baseUrl}/${path}`, {
          method: "POST", body: JSON.stringify(body), signal: controller.signal,
          headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json", accept: streaming ? "text/event-stream" : "application/json",
            ...(entry.provider === "OPENROUTER" ? { "x-title": "Space Gateway" } : {}) }
        });
      } catch {
        if (controller.signal.aborted) return reply;
        pool.markTransientError(account.id);
        last = { status: 502, text: JSON.stringify(gatewayError("upstream_unavailable", `${entry.label} is unreachable.`)) };
        continue;
      }
      if (!upstream.ok) {
        const text = await readBounded(upstream);
        last = { status: upstream.status, text };
        if (await recordFailure(pool, account, upstream.status, text)) continue;
        break;
      }
      void pool.markSuccess(account.id).catch(() => undefined);
      void pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      if (!contentType.includes("text/event-stream") || !upstream.body) {
        const text = await upstream.text();
        let usage: PoolUsage | null = null;
        try { usage = readPoolUsage(JSON.parse(text)); } catch { /* passed through as is */ }
        log(account, "success", null, usage, null);
        return reply.code(upstream.status).header("content-type", contentType).header("x-request-id", requestId).send(text);
      }
      // A stream passes through as it arrives; its last usage-bearing event is logged.
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": contentType, "cache-control": "no-cache", "x-request-id": requestId, "x-accel-buffering": "no" });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let usage: PoolUsage | null = null;
      let firstTokenAt: number | null = null;
      let failed: string | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstTokenAt === null) firstTokenAt = now();
          reply.raw.write(value);
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:") || !line.includes("usage")) continue;
            try { usage = readPoolUsage(JSON.parse(line.slice(5).trim())) ?? usage; } catch { /* not JSON */ }
          }
          if (pending.length > 1024 * 1024) pending = "";
        }
      } catch {
        failed = controller.signal.aborted ? "client_closed" : "stream_incomplete";
      }
      reply.raw.end();
      log(account, failed ? "error" : "success", failed, usage, firstTokenAt);
      return reply;
    }
    log(null, "error", last ? `http_${last.status}` : "no_accounts", null, null);
    if (last) return reply.code(last.status).header("content-type", "application/json").header("x-request-id", requestId).send(last.text);
    return reply.code(503).send(gatewayErrors.noAccounts());
  }

  app.post("/pools/:provider/v1/chat/completions", (request, reply) => forward(request, reply, "chat/completions"));
  app.post("/pools/:provider/v1/responses", (request, reply) => forward(request, reply, "responses"));
  // The provider's model catalog through any usable key, so clients can list models from the pool URL.
  app.get("/pools/:provider/v1/models", async (request, reply) => {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const target = poolFor(request, reply);
    if (!target) return reply;
    const settings = await options.settings();
    const scope = request.gatewayApiKey!.accountScopeEnabled ? new Set(request.gatewayApiKey!.accountIds) : null;
    const tried = new Set<string>();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = await nextAccount(target.pool, settings, scope, tried);
      if (!account) break;
      tried.add(account.id);
      try {
        const credentials = await target.pool.credentials(account);
        const upstream = await fetchImpl(`${target.baseUrl}/models`, { headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(20_000) });
        const text = await readBounded(upstream, 16 * 1024 * 1024);
        if (upstream.ok) return reply.code(200).header("content-type", upstream.headers.get("content-type") ?? "application/json").send(text);
        if (!(await recordFailure(target.pool, account, upstream.status, text))) return reply.code(upstream.status).header("content-type", "application/json").send(text);
      } catch {
        target.pool.markTransientError(account.id);
      }
    }
    return reply.code(503).send(gatewayErrors.noAccounts());
  });
}
