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
  provider: KeyPoolProvider["provider"] | Extract<GatewayProvider, "CLAUDE" | "GOOGLE_AI">;
  label: string;
  keyPattern: RegExp;
  planType: string;
  check: (apiKey: string, fetchImpl: typeof fetch) => Promise<{ ok: boolean; status: number }>;
  keyFrom?: (pasted: string) => string | null;
}

const poolEntry = (entry: KeyPoolProvider): ApiKeyProviderEntry => ({
  provider: entry.provider, label: entry.label, keyPattern: entry.keyPattern, planType: "api", check: (apiKey, fetchImpl) => checkPoolKey(entry, apiKey, fetchImpl),
  keyFrom: entry.keyFrom
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

/**
 * The providers whose accounts a `<who>-free-pools` gateway key may reach (scripts/space-admin-action.mjs FREE_POOL_PROVIDERS): a new account of
 * one joins those keys at once (7/11: Inception joined at 12:05Z and no free-pools key reached it, so Nous and the panes could not use it).
 */
export const FREE_POOL_KEY_PROVIDERS: ReadonlySet<GatewayProvider> = new Set(["NVIDIA", "GROQ", "CLOUDFLARE_AI", "ADAPTION", "AMD_TOKEN_LAB", "INCEPTION",
  "JINA", "MIXEDBREAD", "AGENTROUTER", "FREEAI", "AZURE_OPENAI", "ZAI", "SILICONFLOW", "OVH", "MISTRAL", "GOOGLE_AI", "OPENROUTER"]);
/** Never on Nous's `nous-free-pools` key (space-admin-action NOUS_FREE_POOL_PROVIDERS): relays, embedding pools, Mistral's training free tier. */
export const NOUS_FREE_POOL_KEY_EXCLUDED: ReadonlySet<GatewayProvider> = new Set(["AGENTROUTER", "FREEAI", "JINA", "MIXEDBREAD", "MISTRAL"]);

function entryFor(provider: unknown): ApiKeyProviderEntry | null {
  if (provider === "CLAUDE") return claudeEntry;
  if (provider === "GOOGLE_AI") return googleAiEntry;
  const slug = typeof provider === "string" ? keyPoolSlugFor(provider as GatewayProvider) : null;
  return slug ? poolEntry(keyPoolProviders[slug]) : null;
}

/**
 * Provider API keys as gateway accounts: OpenAI (embeddings and its key pool), OpenRouter, DeepSeek and the free pools (key pools),
 * Claude (the per-token fallback behind the subscription accounts) and Google AI (Gemini embeddings). The key is checked with the provider's
 * free check request, stored encrypted, and identified only by a hash prefix and its last four characters.
 */
export function registerApiKeyAccountRoutes(app: FastifyInstance, options: {
  repository: GatewayRepository; pools: Partial<Record<ApiKeyProviderEntry["provider"], AccountPool>>; cipher: () => CredentialCipher | null;
  internalToken: string | null; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const guard = createAdminGuard(options.internalToken);
  const now = options.now ?? Date.now;
  // Whether a key is already an account (the API's Vault reconcile, 7/11: keys saved before their pool existed never joined): by the stored
  // key's hash, so nothing is sent to the provider and an account's label stays as it is.
  app.post("/__space-gateway/admin/api-key/known", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = (request.body ?? {}) as { provider?: unknown; apiKey?: unknown };
    const entry = entryFor(body.provider);
    if (!entry || typeof body.apiKey !== "string") return reply.code(422).send({ error: { code: "unsupported_provider", message: "Name a key-pool provider and a key." } });
    const apiKey = (entry.keyFrom ? entry.keyFrom(body.apiKey.trim()) : body.apiKey.trim()) ?? "";
    const externalAccountId = `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
    return { known: (await options.repository.listAccounts()).some((account) => account.provider === entry.provider && account.externalAccountId === externalAccountId) };
  });
  app.post("/__space-gateway/admin/api-key/add", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = (request.body ?? {}) as { provider?: unknown; apiKey?: unknown; label?: unknown; sourceRef?: unknown };
    const entry = entryFor(body.provider);
    const pool = entry ? options.pools[entry.provider] : undefined;
    if (!entry || !pool) return reply.code(422).send({ error: { code: "unsupported_provider", message: "API keys can be added for OpenAI, OpenRouter, DeepSeek, Groq, NVIDIA, Cloudflare Workers AI, Adaption Labs, AMD Token Lab, Inception Labs, Jina AI, Mixedbread, AgentRouter, Free.ai, Azure OpenAI, Z.AI, SiliconFlow, OVHcloud AI Endpoints (no key), Mistral, Claude on Amazon Bedrock, Claude on Google Vertex AI, Claude and Google AI." } });
    const pasted = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiKey = (entry.keyFrom ? entry.keyFrom(pasted) : pasted) ?? "";
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
    // A new free or granted pool's account joins every `<who>-free-pools` key (Nous's, OpenCode's), as space-admin-action
    // gateway-free-pools-key-sync does by hand: 7/11 Inception joined and stayed out of reach until that ran.
    if (!existing && FREE_POOL_KEY_PROVIDERS.has(entry.provider)) {
      for (const key of await options.repository.listApiKeys()) {
        if (key.name === "nous-free-pools" && NOUS_FREE_POOL_KEY_EXCLUDED.has(entry.provider)) continue;
        if (/(^|-)free-pools$/.test(key.name) && !key.accountIds.includes(saved.id)) await options.repository.updateApiKey(key.id, { accountIds: [...key.accountIds, saved.id] });
      }
    }
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
