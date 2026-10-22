import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayCompressionRow, GatewayCompressionSignalRow, GatewayRepository, GatewayRequestLogInsert } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { StickyStore } from "../../accounts/sticky-store.js";
import { requestOrigin } from "../../client-detect.js";
import { compressGeminiBodyAsync, type AsyncBlockRunner, type CompressionCache, type RawBlockRegistry } from "../../compression/engine.js";
import { outputPolicyText, requestOutputPolicy, withGeminiOutputPolicy } from "../../compression/output-policy.js";
import { effectiveCompression, requestCompressionMode, type EffectiveCompression } from "../../compression/provider-settings.js";
import { compressionDetail, compressionRows, compressionSignalRows } from "../../compression/recorder.js";
import type { TokenizerKind } from "../../compression/tokenizer.js";
import { geminiCostUsd } from "../../pricing/pricing.js";
import { hashKey, header, readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { CODE_ASSIST_BASE_URL, quotaGroupForModel } from "./code-assist.js";
import { ANTIGRAVITY_CLIENT_ID } from "./oauth.js";
import { createAntigravityPoolAccess } from "./pool-access.js";
import { CodeAssistStreamInspector, type GeminiUsage } from "./stream.js";

/**
 * Antigravity through Space Gateway. The CLI is pointed here with `CLOUD_CODE_URL=http://127.0.0.1:4920/antigravity`.
 * Model calls (`generateContent`, `streamGenerateContent`) go to a pooled account chosen by the model's quota group,
 * with the request's `project` rewritten to that account's Code Assist project, and move to another account when one
 * runs out of quota before any content reached the client. Every other call (settings, trajectories, experiments,
 * quota) goes upstream unchanged with the client's own sign-in, because it belongs to that account.
 * Only clients signed in to Antigravity as one of the pool's Google accounts are balanced; any other signed-in client
 * passes straight through with its own sign-in, so routing Antigravity here never breaks a profile outside the pool.
 * Balanced model calls get context compression of their tool results (`compressGeminiBodyAsync`) while it is ON.
 */
const MODEL_METHODS = new Set(["generateContent", "streamGenerateContent"]);
const IDENTITY_CACHE_MS = 10 * 60_000;
const hopByHop = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection",
  "host", "content-length", "accept-encoding"]);

type Json = Record<string, unknown>;

export interface AntigravityProxyOptions {
  pool: AccountPool;
  repository: GatewayRepository;
  logs: RequestLogWriter;
  settings: () => Promise<GatewaySettings>;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAccountAttempts?: number;
  sticky?: StickyStore;
  /** Google token -> identity; defaults to Google's tokeninfo endpoint. */
  verifyIdentity?: (accessToken: string) => Promise<{ subject: string | null; email: string | null; clientId: string | null } | null>;
  /** Context compression (the Headroom rewrite); absent means requests are never compressed. */
  compression?: { run: AsyncBlockRunner; cache?: CompressionCache; rawBlocks?: RawBlockRegistry; record: (rows: GatewayCompressionRow[]) => Promise<void>;
    recordSignals?: (rows: GatewayCompressionSignalRow[]) => Promise<void> };
}

/** Token estimates by model family: Claude models through Antigravity count as Claude, GPT models with o200k. */
function tokenizerForModel(model: string | null): TokenizerKind {
  const name = (model ?? "").toLowerCase();
  return name.includes("claude") ? "claude" : name.startsWith("gpt") ? "o200k" : "gemini";
}

async function googleTokenInfo(accessToken: string, fetchImpl: typeof fetch) {
  try {
    const response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const info = await response.json() as Json;
    return { subject: typeof info.sub === "string" ? info.sub : null, email: typeof info.email === "string" ? info.email : null,
      clientId: typeof info.azp === "string" ? info.azp : typeof info.aud === "string" ? info.aud : null };
  } catch {
    return null;
  }
}

function forwardHeaders(inbound: Record<string, string | string[] | undefined>, accessToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(inbound)) {
    if (raw === undefined) continue;
    const lowered = key.toLowerCase();
    if (hopByHop.has(lowered) || lowered.startsWith("x-forwarded-") || lowered.startsWith("x-space-gateway-")) continue;
    headers[lowered] = Array.isArray(raw) ? raw.join(", ") : raw;
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

function bearer(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  const match = /^Bearer\s+(\S+)$/i.exec(Array.isArray(value) ? value[0] ?? "" : value ?? "");
  return match ? match[1]! : null;
}

export function registerAntigravityProxyRoutes(app: FastifyInstance, options: AntigravityProxyOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = (options.upstreamBaseUrl ?? CODE_ASSIST_BASE_URL).replace(/\/+$/, "");
  const maxAttempts = options.maxAccountAttempts ?? 3;
  const sticky = options.sticky ?? new StickyStore({ provider: "ANTIGRAVITY", kind: "PROMPT_CACHE" });
  const verify = options.verifyIdentity ?? ((token: string) => googleTokenInfo(token, fetchImpl));
  const identities = new Map<string, { at: number; allowed: boolean }>();
  const { pick, ...access } = createAntigravityPoolAccess({ pool: options.pool, repository: options.repository, sticky, now });

  /** Whether the client's Google sign-in is one of the pool's accounts (and was issued to the Antigravity client). */
  async function pooled(token: string): Promise<boolean> {
    const key = hashKey(token);
    const cached = identities.get(key);
    if (cached && now() - cached.at < IDENTITY_CACHE_MS) return cached.allowed;
    const identity = await verify(token);
    const accounts = await options.pool.accounts();
    const allowed = Boolean(identity && (identity.clientId === null || identity.clientId === ANTIGRAVITY_CLIENT_ID) && accounts.some((account) =>
      (identity.subject && account.externalAccountId === identity.subject) || (identity.email && account.email?.toLowerCase() === identity.email.toLowerCase())));
    if (identities.size > 1000) identities.clear();
    identities.set(key, { at: now(), allowed });
    return allowed;
  }

  async function passthrough(request: FastifyRequest, reply: FastifyReply, upstreamPath: string, body: Buffer | undefined, logCall = false) {
    const startedAt = now();
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${baseUrl}${upstreamPath}`, { method: request.method, headers: forwardHeaders(request.headers, null),
        body: body && body.length > 0 ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(300_000) });
    } catch {
      return reply.code(502).send({ error: { code: 502, message: "Code Assist is unreachable.", status: "UNAVAILABLE" } });
    }
    reply.hijack();
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, name) => { if (!hopByHop.has(name) && name !== "content-encoding") headers[name] = value; });
    reply.raw.writeHead(upstream.status, headers);
    const inspector = logCall ? new CodeAssistStreamInspector() : null;
    let firstTokenAt: number | null = null;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (inspector?.push(value) && firstTokenAt === null) firstTokenAt = now();
        reply.raw.write(value);
      }
    }
    reply.raw.end();
    inspector?.end();
    if (inspector) {
      let requested: string | null = null;
      try { const model = (JSON.parse(body!.toString("utf8")) as Json).model; requested = typeof model === "string" ? model : null; } catch { /* not JSON */ }
      const model = inspector.model ?? requested ?? "unknown";
      const usage = inspector.usage;
      const failed = !upstream.ok || (inspector.errorStatus !== null && !inspector.outputStarted);
      options.logs.add({
        requestId: `req_${randomUUID().replace(/-/g, "")}`, requestedAt: new Date(startedAt).toISOString(), provider: "ANTIGRAVITY", accountId: null,
        apiKeyId: null, model, reasoningEffort: null, serviceTier: null, transport: "http", status: failed ? "error" : "success",
        errorCode: failed ? `http_${inspector.errorStatus ?? upstream.status}` : null, latencyMs: now() - startedAt,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, inputTokens: usage?.promptTokens ?? null,
        cachedInputTokens: usage?.cachedTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.thoughtsTokens ?? null,
        costUsd: geminiCostUsd(usage, model), compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, ...requestOrigin(request)
      });
    }
    return reply;
  }

  /**
   * Context compression of a model call's body under Antigravity's settings (the global ones overlaid by the
   * provider's), then the output policy on agent turns. Never throws; on any failure the original body is used.
   */
  async function compressRequest(body: Json, model: string | null, sessionKey: string | null, request: FastifyRequest, settings: GatewaySettings,
    startedAt: number) {
    const result: { outgoing: Json; saved: number | null; measured: { before: number; after: number } | null;
      detail: GatewayRequestLogInsert["compressionDetail"] } = { outgoing: body, saved: null, measured: null, detail: null };
    const effective = effectiveCompression(settings, "ANTIGRAVITY");
    // Antigravity calls carry the client's own Google sign-in, not a gateway key: there is no key override.
    const compressionMode = requestCompressionMode(effective, null, header(request, "x-space-gateway-compression"));
    const outputPolicy = requestOutputPolicy({ policy: effective.outputPolicy, key: null, clientName: requestOrigin(request).clientName,
      headerValue: header(request, "x-space-gateway-output-policy") });
    if (compressionMode !== "OFF" && options.compression) await compressInto(result, body, model, sessionKey, compressionMode, effective, startedAt);
    const policyText = outputPolicyText(outputPolicy);
    const withPolicy = policyText ? withGeminiOutputPolicy(result.outgoing, policyText) : null;
    if (withPolicy) {
      result.outgoing = withPolicy;
      result.detail = { ...(result.detail ?? { strategies: [], waste: {} }), outputPolicy };
    }
    return result;
  }

  async function compressInto(result: { outgoing: Json; saved: number | null; measured: { before: number; after: number } | null;
    detail: GatewayRequestLogInsert["compressionDetail"] }, body: Json, model: string | null, sessionKey: string | null,
    compressionMode: "ON", effective: EffectiveCompression, startedAt: number) {
    if (!options.compression) return;
    try {
      const outcome = await compressGeminiBodyAsync(body, { run: options.compression.run, cache: options.compression.cache, tokenizer: tokenizerForModel(model),
        timeBudgetMs: effective.timeBudgetMs, codeText: effective.codeText, profile: effective.profile,
        sessionKey: sessionKey ?? undefined, rawBlocks: options.compression.rawBlocks });
      if (outcome.tokensBefore > 0) result.measured = { before: outcome.tokensBefore, after: outcome.tokensAfter };
      if (compressionMode === "ON" && outcome.modified) {
        result.outgoing = outcome.body;
        result.saved = outcome.tokensBefore - outcome.tokensAfter;
      }
      void options.compression.record(compressionRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "ANTIGRAVITY" }))
        .catch(() => undefined);
      void options.compression.recordSignals?.(compressionSignalRows(outcome, { at: new Date(startedAt).toISOString(), mode: compressionMode, provider: "ANTIGRAVITY" }))
        .catch(() => undefined);
      result.detail = compressionDetail(outcome);
    } catch {
      // Compression never blocks a request: the original body goes upstream.
    }
  }

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: { code: 401, message: "Antigravity is not signed in.", status: "UNAUTHENTICATED" } });
    const upstreamPath = request.url.replace(/^\/antigravity/, "") || "/";
    const raw = Buffer.isBuffer(request.body) ? request.body : undefined;
    const method = /^\/v1internal:([A-Za-z]+)/.exec(upstreamPath)?.[1] ?? "";
    if (request.method !== "POST" || !MODEL_METHODS.has(method) || !raw) return passthrough(request, reply, upstreamPath, raw);
    // A model call on an account outside the pool goes through as it is, but is logged so its tokens still count.
    if (!(await pooled(token))) return passthrough(request, reply, upstreamPath, raw, true);

    let body: Json;
    try { body = JSON.parse(raw.toString("utf8")) as Json; } catch { return passthrough(request, reply, upstreamPath, raw); }
    const startedAt = now();
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    const model = typeof body.model === "string" ? body.model : null;
    const group = quotaGroupForModel(model);
    const inner = body.request && typeof body.request === "object" ? body.request as Json : {};
    const sessionId = typeof inner.sessionId === "string" ? inner.sessionId : null;
    const stickyHash = sessionId ? hashKey(`antigravity:${sessionId}`) : null;
    const settings = await options.settings();
    const compressed = await compressRequest(body, model, stickyHash, request, settings, startedAt);
    const tried = new Set<string>();
    const origin = requestOrigin(request);
    const log = (account: GatewayAccountRecord | null, status: "success" | "error", errorCode: string | null, usage: GeminiUsage | null, extra: { firstTokenMs?: number | null; model?: string | null; errorMessage?: string | null } = {}) =>
      options.logs.add({
        requestId, requestedAt: new Date(startedAt).toISOString(), provider: "ANTIGRAVITY", accountId: account?.id ?? null, apiKeyId: null,
        model: extra.model ?? model ?? "unknown", reasoningEffort: null, serviceTier: null, transport: "http", upstreamTransport: "http", status, errorCode,
        errorMessage: extra.errorMessage ?? null, latencyMs: now() - startedAt, firstTokenMs: extra.firstTokenMs ?? null,
        inputTokens: usage?.promptTokens ?? null, cachedInputTokens: usage?.cachedTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        reasoningTokens: usage?.thoughtsTokens ?? null, costUsd: geminiCostUsd(usage, extra.model ?? model), compressionTokensSaved: account ? compressed.saved : null, planType: account?.planType ?? null,
        stickyKeySource: sessionId ? "request.sessionId" : null, stickyKind: stickyHash ? "PROMPT_CACHE" : null, stickyKeyHash: stickyHash ? stickyHash.slice(0, 16) : null,
        ...origin, compressionTokensBefore: compressed.measured?.before ?? null, compressionTokensAfter: compressed.measured?.after ?? null,
        compressionDetail: compressed.detail
      });

    let lastError: { status: number; body: string; headers: Headers | null } | null = null;
    /** An account whose rejected access token was just refreshed: the request tries it once more. */
    let retryWith: GatewayAccountRecord | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = retryWith ?? await pick(group, tried, stickyHash, settings);
      if (retryWith) attempt -= 1;
      retryWith = null;
      if (!account) break;
      tried.add(account.id);
      options.pool.markSelected(account.id, reply.raw);
      let credentials;
      try {
        credentials = await options.pool.credentials(account);
      } catch (error) {
        lastError = { status: 401, body: JSON.stringify({ error: { code: 401, message: error instanceof Error ? error.message : "Account sign-in is unavailable.", status: "UNAUTHENTICATED" } }), headers: null };
        continue;
      }
      const outgoing = JSON.stringify({ ...compressed.outgoing, project: credentials.upstreamAccountId ?? body.project });
      let upstream: Response;
      try {
        upstream = await fetchImpl(`${baseUrl}${upstreamPath}`, { method: "POST", body: outgoing, headers: forwardHeaders(request.headers, credentials.accessToken),
          signal: AbortSignal.timeout(600_000) });
      } catch {
        options.pool.markTransientError(account.id);
        lastError = { status: 502, body: JSON.stringify({ error: { code: 502, message: "Code Assist is unreachable.", status: "UNAVAILABLE" } }), headers: null };
        continue;
      }
      if (!upstream.ok) {
        const text = await readBounded(upstream);
        lastError = { status: upstream.status, body: text, headers: upstream.headers };
        if (await recordFailure(account, upstream.status, text)) continue;
        break;
      }

      const inspector = new CodeAssistStreamInspector();
      const reader = upstream.body!.getReader();
      const held: Uint8Array[] = [];
      let committed = false;
      let firstTokenAt: number | null = null;
      const commit = () => {
        committed = true;
        reply.hijack();
        const headers: Record<string, string> = {};
        upstream.headers.forEach((value, name) => { if (!hopByHop.has(name) && name !== "content-encoding") headers[name] = value; });
        reply.raw.writeHead(upstream.status, headers);
        for (const chunk of held) reply.raw.write(chunk);
        held.length = 0;
      };
      let movedOn = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (inspector.push(value) && firstTokenAt === null) firstTokenAt = now();
          if (committed) { reply.raw.write(value); continue; }
          held.push(value);
          if (inspector.errorStatus !== null && !inspector.outputStarted && attempt + 1 < maxAttempts) {
            const failoverable = await recordFailure(account, inspector.errorStatus, JSON.stringify({ error: { code: inspector.errorStatus, message: inspector.errorMessage } }));
            if (failoverable) { await reader.cancel().catch(() => undefined); movedOn = true; break; }
          }
          if (inspector.outputStarted) commit();
        }
      } catch {
        if (!committed) { options.pool.markTransientError(account.id); continue; }
        reply.raw.end();
        log(account, "error", "stream_incomplete", inspector.usage, { firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, model: inspector.model });
        return reply;
      }
      if (movedOn) continue;
      inspector.end();
      if (!committed) commit();
      reply.raw.end();
      const failed = inspector.errorStatus !== null && !inspector.outputStarted;
      log(account, failed ? "error" : "success", failed ? `http_${inspector.errorStatus}` : null, inspector.usage,
        { firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, model: inspector.model, errorMessage: failed ? inspector.errorMessage : null });
      if (!failed) {
        if (stickyHash) sticky.set(stickyHash, account.id);
        void options.pool.markSuccess(account.id).catch(() => undefined);
      }
      void options.pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
      return reply;
    }

    const status = lastError?.status ?? 503;
    log(null, "error", lastError ? `http_${status}` : "no_accounts", null);
    if (lastError) return reply.code(status).header("content-type", "application/json").send(lastError.body);
    return reply.code(503).send({ error: { code: 503, message: "No Antigravity account in Space Gateway can serve this model right now.", status: "UNAVAILABLE" } });

    /** Notes what the failure says about the account; returns whether another account may serve the request. */
    async function recordFailure(account: GatewayAccountRecord, status: number, text: string): Promise<boolean> {
      const outcome = await access.recordFailure(account, group, status, text);
      if (outcome.retryWith !== undefined) retryWith = outcome.retryWith;
      return outcome.failover;
    }
  }

  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 32 * 1024 * 1024 }, (_request, payload, done) => done(null, payload));
    scope.all("/antigravity/*", handle);
  });
}
