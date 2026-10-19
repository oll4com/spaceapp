import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool, CredentialRefresher } from "../../accounts/account-pool.js";
import { requestOrigin } from "../../client-detect.js";
import { gatewayError, gatewayErrors } from "../../errors.js";
import { checkKeyLimits, PolicyRejection } from "../../policy.js";
import { readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { selectAccount } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { classifyGoogleAiFailure, GEMINI_EMBEDDING_MODELS, geminiEmbed, googleRetrySeconds, readGeminiEmbeddingRequest, type GeminiEmbeddingRequest } from "../google-ai/embeddings.js";

/**
 * OpenAI API key accounts and `/v1/embeddings` over them, as codex-lb served embeddings for Space memory (ChatGPT
 * subscriptions have no embeddings). Requests go to the least-troubled key and move to another key on rate limits,
 * 5xx and rejected keys. Gemini embedding models go to the Google AI key accounts instead (google-ai/embeddings.ts), with
 * the gateway's optional `task_type` (RETRIEVAL_DOCUMENT, RETRIEVAL_QUERY...), which is never sent to OpenAI.
 */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/** Per 1M input tokens. */
const embeddingPrices: Record<string, number> = { "text-embedding-3-small": 0.02, "text-embedding-3-large": 0.13, "text-embedding-ada-002": 0.1,
  "gemini-embedding-001": 0.15 };

export const apiKeyRefresher: CredentialRefresher = { needsRefresh: () => false, refresh: async (credentials) => credentials };

export function registerEmbeddingsRoute(app: FastifyInstance, helpers: GatewayRouteHelpers, options: {
  pool: AccountPool; logs: RequestLogWriter; settings: () => Promise<GatewaySettings>; upstreamBaseUrl?: string; fetchImpl?: typeof fetch;
  /** Google AI key accounts, for the Gemini embedding models. */
  googlePool?: AccountPool; googleBaseUrl?: string;
  now?: () => number; maxAccountAttempts?: number;
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = (options.upstreamBaseUrl ?? OPENAI_API_BASE_URL).replace(/\/+$/, "");
  const maxAttempts = options.maxAccountAttempts ?? 3;

  app.post("/v1/embeddings", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await helpers.authenticate(request, reply))) return reply;
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
    const google = GEMINI_EMBEDDING_MODELS.has(model);
    const pool = google ? options.googlePool : options.pool;
    let gemini: GeminiEmbeddingRequest | null = null;
    if (google) {
      const parsed = readGeminiEmbeddingRequest(body);
      if ("error" in parsed) return reply.code(400).send(gatewayError("invalid_request", parsed.error, "invalid_request_error"));
      gemini = parsed;
    } else {
      delete body.task_type;
    }
    if (!pool) return reply.code(503).send(gatewayErrors.noAccounts());
    const settings = await options.settings();
    const requestId = `emb_${randomUUID().replace(/-/g, "")}`;
    const scope = key.accountScopeEnabled ? new Set(key.accountIds) : null;
    const tried = new Set<string>();
    const log = (account: GatewayAccountRecord | null, status: "success" | "error", errorCode: string | null, inputTokens: number | null) => {
      const price = embeddingPrices[model];
      options.logs.add({
        requestId, requestedAt: new Date(startedAt).toISOString(), provider: google ? "GOOGLE_AI" : "OPENAI_API", accountId: account?.id ?? null, apiKeyId: key.id, model,
        reasoningEffort: null, serviceTier: null, transport: "http", upstreamTransport: "http", status, errorCode, latencyMs: now() - startedAt,
        firstTokenMs: null, inputTokens, cachedInputTokens: null, outputTokens: inputTokens === null ? null : 0, reasoningTokens: null,
        costUsd: inputTokens !== null && price !== undefined ? (inputTokens / 1e6) * price : null, compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null,
        ...requestOrigin(request)
      });
    };
    const settle = (inputTokens: number | null) => {
      if (inputTokens === null || !options.settleKeyUsage) return;
      const price = embeddingPrices[model] ?? 0;
      void options.settleKeyUsage(key.id, { inputTokens, outputTokens: 0, costMicros: Math.round(inputTokens * price), model, at: new Date(startedAt).toISOString() })
        .catch(() => undefined);
    };
    let last: { status: number; text: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const accounts = (await pool.accounts()).filter((account) => (!scope || scope.has(account.id)) && !tried.has(account.id));
      const states = accounts.map((account) => pool.toBalancerState(account));
      const result = selectAccount(states, { now: now() / 1000, routingStrategy: settings.routingStrategy === "SINGLE_ACCOUNT" ? "SINGLE_ACCOUNT" : "ROUND_ROBIN" });
      for (const state of states) pool.absorb(state);
      const account = result.account ? accounts.find((item) => item.id === result.account!.accountId) : undefined;
      if (!account) break;
      tried.add(account.id);
      pool.markSelected(account.id, reply.raw);
      if (gemini) {
        let result: Awaited<ReturnType<typeof geminiEmbed>>;
        try {
          result = await geminiEmbed((await pool.credentials(account)).accessToken, model, gemini, { fetchImpl, baseUrl: options.googleBaseUrl });
        } catch {
          pool.markTransientError(account.id);
          last = { status: 502, text: JSON.stringify(gatewayError("upstream_unavailable", "The embeddings provider is unreachable.")) };
          continue;
        }
        if (!result.ok) {
          last = { status: result.status, text: result.text };
          const kind = classifyGoogleAiFailure(result.status, result.text);
          let message = `Google AI answered HTTP ${result.status}`;
          try { message = String((JSON.parse(result.text) as { error?: { message?: unknown } }).error?.message ?? message).slice(0, 300); } catch { /* not JSON */ }
          if (kind === "rejected") { await pool.refreshRejectedToken(account, "token_invalidated"); continue; }
          if (kind === "quota") { await pool.markQuotaExceeded(account, { message, resetsInSeconds: 24 * 3600 }); continue; }
          if (kind === "rate_limit") { await pool.markRateLimited(account, { message, resetsInSeconds: googleRetrySeconds(result.text, now()) ?? undefined }); continue; }
          if (kind === "transient") { pool.markTransientError(account.id); continue; }
          break;
        }
        log(account, "success", null, result.inputTokens);
        settle(result.inputTokens);
        void pool.markSuccess(account.id).catch(() => undefined);
        void pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
        const tokens = result.inputTokens ?? 0;
        return reply.header("x-request-id", requestId).send({ object: "list", model,
          data: result.vectors.map((embedding, index) => ({ object: "embedding", index, embedding })), usage: { prompt_tokens: tokens, total_tokens: tokens } });
      }
      let upstream: Response;
      try {
        const credentials = await pool.credentials(account);
        upstream = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" }
        });
      } catch {
        pool.markTransientError(account.id);
        last = { status: 502, text: JSON.stringify(gatewayError("upstream_unavailable", "The embeddings provider is unreachable.")) };
        continue;
      }
      if (!upstream.ok) {
        const text = await readBounded(upstream);
        last = { status: upstream.status, text };
        if (upstream.status === 401) { await pool.refreshRejectedToken(account, "token_invalidated"); continue; }
        if (upstream.status === 429) {
          // A key without credit stays out of rotation (quota exceeded); a plain rate limit backs off briefly.
          let error: { code?: unknown; type?: unknown; message?: unknown } = {};
          try { error = (JSON.parse(text) as { error?: typeof error }).error ?? {}; } catch { /* not JSON */ }
          const message = typeof error.message === "string" ? error.message.slice(0, 300) : "Rate limited";
          if (["insufficient_quota", "credit_balance_exhausted"].includes(String(error.code)) || error.type === "insufficient_quota") {
            await pool.markQuotaExceeded(account, { message, resetsInSeconds: 24 * 3600 });
          } else {
            await pool.markRateLimited(account, { message });
          }
          continue;
        }
        if (upstream.status >= 500) { pool.markTransientError(account.id); continue; }
        break;
      }
      const text = await upstream.text();
      let inputTokens: number | null = null;
      try {
        const usage = (JSON.parse(text) as { usage?: { prompt_tokens?: unknown } }).usage;
        inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null;
      } catch { /* passed through as is */ }
      log(account, "success", null, inputTokens);
      settle(inputTokens);
      void pool.markSuccess(account.id).catch(() => undefined);
      void pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
      return reply.code(upstream.status).header("content-type", upstream.headers.get("content-type") ?? "application/json").header("x-request-id", requestId).send(text);
    }
    log(null, "error", last ? `http_${last.status}` : "no_accounts", null);
    if (last) return reply.code(last.status).header("content-type", "application/json").send(last.text);
    return reply.code(503).send(gatewayErrors.noAccounts());
  });
}
