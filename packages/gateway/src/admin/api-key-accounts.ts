import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GatewayProvider } from "@space/contracts";
import type { GatewayRepository } from "@space/db";
import type { AccountPool, StoredCredentials } from "../accounts/account-pool.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { CLAUDE_API_KEY_PATTERN, CLAUDE_API_KEY_PLAN, checkClaudeApiKey } from "../providers/claude/api-key.js";
import { checkGoogleAiKey, GOOGLE_AI_KEY_PATTERN } from "../providers/google-ai/embeddings.js";
import { checkPoolKey, keyPoolProviders, keyPoolSlugFor, type KeyPoolProvider } from "../providers/key-pools/key-pools.js";
import { createAdminGuard, publicAccountSummary, type ProviderAccountActions } from "./codex-sign-in.js";

/** A provider whose API keys become gateway accounts: the key's shape, its free check, and the plan it is filed under. */
interface ApiKeyProviderEntry {
  provider: Extract<GatewayProvider, "OPENAI_API" | "OPENROUTER" | "DEEPSEEK" | "CLAUDE" | "GOOGLE_AI">;
  label: string;
  keyPattern: RegExp;
  planType: string;
  check: (apiKey: string, fetchImpl: typeof fetch) => Promise<{ ok: boolean; status: number }>;
}

const poolEntry = (entry: KeyPoolProvider): ApiKeyProviderEntry => ({
  provider: entry.provider, label: entry.label, keyPattern: entry.keyPattern, planType: "api", check: (apiKey, fetchImpl) => checkPoolKey(entry, apiKey, fetchImpl)
});

/**
 * The Claude key is not a pool: with the `claudeApiKeyFallback` setting on, the Claude proxy uses it only while every
 * pooled subscription account is out of quota.
 */
const claudeEntry: ApiKeyProviderEntry = {
  provider: "CLAUDE", label: "Claude", keyPattern: CLAUDE_API_KEY_PATTERN, planType: CLAUDE_API_KEY_PLAN,
  check: (apiKey, fetchImpl) => checkClaudeApiKey(apiKey, fetchImpl)
};

/** Google AI (Gemini API) keys serve the Gemini embedding models of `/v1/embeddings` (Space Memory). */
export const googleAiEntry: ApiKeyProviderEntry = {
  provider: "GOOGLE_AI", label: "Google AI", keyPattern: GOOGLE_AI_KEY_PATTERN, planType: "api", check: (apiKey, fetchImpl) => checkGoogleAiKey(apiKey, fetchImpl)
};

function entryFor(provider: unknown): ApiKeyProviderEntry | null {
  if (provider === "CLAUDE") return claudeEntry;
  if (provider === "GOOGLE_AI") return googleAiEntry;
  const slug = typeof provider === "string" ? keyPoolSlugFor(provider as GatewayProvider) : null;
  return slug ? poolEntry(keyPoolProviders[slug]) : null;
}

/**
 * Provider API keys as gateway accounts: OpenAI (embeddings and its key pool), OpenRouter and DeepSeek (key pools),
 * Claude (the per-token fallback behind the subscription accounts) and Google AI (Gemini embeddings). The key is checked with the provider's
 * free check request, stored encrypted, and identified only by a hash prefix and its last four characters.
 */
export function registerApiKeyAccountRoutes(app: FastifyInstance, options: {
  repository: GatewayRepository; pools: Partial<Record<ApiKeyProviderEntry["provider"], AccountPool>>; cipher: () => CredentialCipher | null;
  internalToken: string | null; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const guard = createAdminGuard(options.internalToken);
  const now = options.now ?? Date.now;
  app.post("/__space-gateway/admin/api-key/add", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = (request.body ?? {}) as { provider?: unknown; apiKey?: unknown; label?: unknown; sourceRef?: unknown };
    const entry = entryFor(body.provider);
    const pool = entry ? options.pools[entry.provider] : undefined;
    if (!entry || !pool) return reply.code(422).send({ error: { code: "unsupported_provider", message: "API keys can be added for OpenAI, OpenRouter, DeepSeek, Claude and Google AI." } });
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!entry.keyPattern.test(apiKey)) return reply.code(422).send({ error: { code: "invalid_api_key", message: `This does not look like a ${entry.label} API key.` } });
    const cipher = options.cipher();
    if (!cipher) return reply.code(503).send({ error: { code: "credential_key_missing", message: "The Space Gateway encryption key is missing. Redeploy Space to create it." } });
    const check = await entry.check(apiKey, options.fetchImpl ?? fetch);
    if (!check.ok) {
      return reply.code(check.status === 0 || check.status >= 500 ? 502 : 422)
        .send({ error: { code: "api_key_rejected", message: check.status === 0 ? `${entry.label} could not be reached.` : `${entry.label} rejected the key (HTTP ${check.status}).` } });
    }
    const externalAccountId = `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : `${entry.label} API key …${apiKey.slice(-4)}`;
    const sourceRef = typeof body.sourceRef === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.sourceRef) ? body.sourceRef : null;
    const existing = (await options.repository.listAccounts()).find((account) => account.provider === entry.provider && account.externalAccountId === externalAccountId);
    const boundId = existing?.id ?? `gw_account:${randomBytes(16).toString("hex")}`;
    const credentials: StoredCredentials = { accessToken: apiKey, refreshToken: null, idToken: null, upstreamAccountId: null, accessExpiresAtMs: null };
    const saved = await options.repository.upsertAccount({ accountId: boundId, provider: entry.provider, label, email: null, externalAccountId, planType: entry.planType,
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), boundId), credentialsExpiresAt: null, source: "API_KEY", sourceRef,
      lastRefreshAt: new Date(now()).toISOString() });
    pool.signedIn(saved.id);
    return { status: "CONNECTED", account: publicAccountSummary(saved) };
  });
}

/** Test (the provider's free check request) for API key accounts; there are no usage windows to refresh. */
export function apiKeyAccountActions(options: { entry: KeyPoolProvider | ApiKeyProviderEntry; pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number }): ProviderAccountActions {
  const now = options.now ?? Date.now;
  const entry = "check" in options.entry ? options.entry : poolEntry(options.entry);
  return {
    async test(account) {
      const startedAt = now();
      const credentials = await options.pool.credentials(account);
      const check = await entry.check(credentials.accessToken, options.fetchImpl ?? fetch);
      if (check.ok) await options.pool.markSuccess(account.id);
      return { ok: check.ok, model: null, status: check.status || 502, latencyMs: now() - startedAt,
        error: check.ok ? null : `${entry.label} answered HTTP ${check.status}` };
    },
    async refreshUsage() { /* API keys have no usage windows. */ }
  };
}

/** The OpenAI API key accounts' actions (embeddings and the OpenAI key pool). */
export const openAiApiAccountActions = (options: { pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number }) =>
  apiKeyAccountActions({ ...options, entry: keyPoolProviders.openai });
