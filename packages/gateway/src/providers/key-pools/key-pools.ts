import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GATEWAY_FREE_GRANTS, GATEWAY_KEYLESS_KEY, GATEWAY_POOL_FREE_MODELS, type GatewayFreeGrant, type GatewayProvider, type GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { requestOrigin } from "../../client-detect.js";
import { gatewayError, gatewayErrors } from "../../errors.js";
import { claudeCostUsd, costUsd } from "../../pricing/pricing.js";
import { ClaudeStreamInspector, claudeResponseUsage, type ClaudeUsageTokens } from "../claude/stream.js";
import { isClaudeCodeRequest } from "../claude/api-key.js";
import { checkKeyLimits, PolicyRejection } from "../../policy.js";
import { readBounded } from "../../proxy-util.js";
import type { RequestLogWriter } from "../../request-log-writer.js";
import { selectAccount } from "../../router/balancer.js";
import { parseRetryAfter } from "../../router/retry.js";
import { GOOGLE_AI_KEY_PATTERN } from "../google-ai/embeddings.js";
import type { GatewayRouteHelpers } from "../../server.js";
import type { ModelChecks } from "./model-checks.js";
import { createAdminGuard } from "../../admin/codex-sign-in.js";
import { BEDROCK_KEY, bedrockKeyFrom, bedrockMessages, CLOUD_CLAUDE_MODELS, UpstreamRefusal, VERTEX_KEY, vertexKeyFrom, vertexMessages,
  type ClaudePoolRequest, type ClaudePoolUpstream } from "./cloud-claude.js";

/**
 * API-key pools for OpenAI-compatible providers (operator decision 2026-10-12: key pools, no dialect translation).
 * A client points its OpenAI base URL at `/pools/<provider>/v1` with its gateway key; each request goes to one of
 * the provider keys in the pool, and moves to another key when one is rejected, out of credit, rate limited or
 * failing before any output. Bodies pass through unchanged: these providers speak the client's own dialect.
 */
export interface KeyPoolProvider {
  provider: Extract<GatewayProvider, "OPENAI_API" | "OPENROUTER" | "DEEPSEEK" | "GROQ" | "NVIDIA" | "CLOUDFLARE_AI" | "GOOGLE_AI" | "ADAPTION" | "AMD_TOKEN_LAB" | "INCEPTION" | "JINA" | "MIXEDBREAD" | "AGENTROUTER" | "FREEAI" | "AZURE_OPENAI" | "ZAI" | "SILICONFLOW" | "OVH" | "MISTRAL" | "BEDROCK" | "VERTEX">;
  label: string;
  /** With `{account}` in a URL the key is stored as `<account>:<token>`: the account fills the URL and only the token is sent (Cloudflare). */
  baseUrl: string;
  keyPattern: RegExp;
  /** A request that needs a valid key but spends nothing (the key check when it is added, and Test); a Claude pool's `messages` builds its own. */
  checkUrl?: string;
  /** A check sent as a POST of this JSON body, for a provider whose only key-checked request is a real one (a few tokens). */
  checkBody?: Record<string, unknown>;
  /** What the check's JSON answer must also hold, for a check whose status alone proves nothing. */
  checkOk?: (payload: unknown) => boolean;
  /** Statuses of a real-request check that still prove the key: the provider read it and then refused the request (a throttled key's 429). */
  checkAccepts?: readonly number[];
  /** A catalog that is not `<baseUrl>/models` in the OpenAI list shape (Cloudflare): its URL and its model ids (null: not the expected shape). */
  models?: { url: string; ids: (payload: unknown) => string[] | null; windows?: (payload: unknown) => Record<string, number> };
  /** Cooldown of a key the provider throttled without saying for how long. */
  cooldownSeconds?: number;
  /** Sends the calling client's own User-Agent: AgentRouter serves only the CLIs it knows, and the gateway never makes one up. */
  forwardsUserAgent?: boolean;
  /** A model that answers 410 or 404 leaves /models and auto until it answers 200 again (model-checks.ts; the free pools). */
  hidesDeadModels?: boolean;
  /** The header that carries the key instead of `authorization: Bearer` (Azure's `api-key`). */
  keyHeader?: string;
  /** The moment (ISO, UTC) a granted credit with a card behind it ends: from then the pool answers 402 and auto moves on (Azure). */
  creditUntil?: string;
  /** The stored key from what was pasted or kept in the Vault, when that holds more than the key (Azure: endpoint and key); null: none found. */
  keyFrom?: (pasted: string) => string | null;
  /** Needs no key (OVH's anonymous access): its one account holds GATEWAY_KEYLESS_KEY and no key header is sent. */
  keyless?: boolean;
  /** A Claude pool (Bedrock, Vertex): serves only `/messages` and builds each upstream request from the stored key (cloud-claude.ts). */
  messages?: (input: ClaudePoolRequest) => Promise<ClaudePoolUpstream>;
  /** The only models it sends and lists (Bedrock's and Vertex's Claude endpoints have no Models API). */
  fixedModels?: readonly string[];
  /** Spends a cloud credit with a card behind it: refused unless GATEWAY_FREE_GRANTS records the credit in dollars, and from 90% of it spent. */
  spendsGrant?: boolean;
}

const rows = (value: unknown): Record<string, unknown>[] | null =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : null;
const field = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);
const stringsOf = (list: Record<string, unknown>[] | null, key: string) => list?.flatMap((row) => (typeof row[key] === "string" ? [row[key] as string] : [])) ?? null;

/**
 * The free tiers (operator 5/11 14:34 BKK: only 100% free, no card), as their docs stated on 5/11, which the cooldowns rely on:
 * - Groq: per model about 30 requests a minute, 1,000-14,400 a day and token caps (openai/gpt-oss-20b: 1,000 a day, 8,000 tokens a minute);
 *   a 429 carries Retry-After and "try again in …".
 * Left out: GitHub Models (retired by GitHub on 30/7/2026; models.github.ai answers every request with 200 "OK") and Cerebras (its API
 * needs a payment method, against the operator's no-card rule).
 * - NVIDIA (build.nvidia.com): about 40 requests a minute; `/v1/models` answers without a key, so the check lists the key's NVCF functions.
 *   Free-tier chat can take over 2 minutes: the pool sets no timeout of its own (Node's fetch waits up to 300 s for a non-streamed answer's
 *   headers, a stream has no cap). Some catalog models are end of life and answer 410 (a per-model refusal, never the key's fault).
 * - Cloudflare Workers AI: 10,000 neurons a day, reset at 00:00 UTC; the key is `<32-hex account id>:<API token>`.
 * - Gemini API free tier (6/11, goal d844e0cc): Flash models only (gemini-3-flash-preview, 3.1-flash-lite, 3.5-flash answered 200; Pro has no
 *   free quota, 2.5 is closed to new keys), through Google's OpenAI-compatible endpoint, which takes AI Studio's `AIza…` and `AQ.…` keys as Bearer.
 *   shortcut: Gemini's 429 is per model but cools the whole key, move to per-model cooldowns when Gemini carries real traffic.
 * - Adaption Labs (6/11): 1,500 granted credits (1 credit = $1, never expire, no card on file), vLLM behind an OpenAI-compatible API; on 6/11
 *   deepseek-v4-flash answered in under a second, glm-5.2 timed out (504 after 60 s).
 * - AMD Token Lab (6/11): granted points, no card on file, OpenAI-compatible; DeepSeek-V4-Flash answered on 6/11, `/models` spends nothing.
 * - Inception Labs and Jina AI (7/11, granted free tokens: 100M and 10M): both answer `/models` without any key (proves nothing), and their
 *   only key-checked lists refused the real keys on stable (Inception's batches 403, Jina's classifiers 500), so the check is one tiny real
 *   request (a 1-token chat, a one-word embedding), 401 to a wrong key. Jina serves embeddings and rerank only (no chat route on /pools/space).
 * - Mixedbread (7/11, $5 granted): embeddings only, no /models; the check lists the key's files. AgentRouter (7/11, $149.78 granted): a
 *   third-party relay (it sees prompts) on new-api, checked on its billing endpoint; it answered "unauthorized client detected" to a plain
 *   server request on 7/11 even for /models, and the gateway does not pose as another client to get past that. Neither is probed daily.
 * A 429 cools only that key: for Retry-After's seconds, else the "try again in" of its message, else until 00:00 UTC when it names a daily
 * cap, else `cooldownSeconds`; the pool moves to the next key and the Space provider's auto to the next route.
 * - Z.AI, SiliconFlow and OVHcloud AI Endpoints (7/11, new-signups.md): Z.AI's and SiliconFlow's accounts have no card, so each pool sends and
 *   lists only its free models (GATEWAY_POOL_FREE_MODELS; SiliconFlow went $0.0001 into overdraft from one paid probe). OVH answers without a
 *   key, 2 requests a minute per IP. None is probed daily (a probe would spend SiliconFlow's paid models and use up OVH's two a minute).
 */
export const keyPoolProviders: Record<"openai" | "openrouter" | "deepseek" | "groq" | "nvidia" | "cloudflare" | "gemini" | "adaption" | "amd" | "inception" | "jina" | "mixedbread" | "agentrouter" | "freeai" | "azure" | "zai" | "siliconflow" | "ovh" | "mistral" | "bedrock" | "vertex", KeyPoolProvider> = {
  openai: { provider: "OPENAI_API", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.openai.com/v1/models" },
  openrouter: { provider: "OPENROUTER", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyPattern: /^sk-or-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://openrouter.ai/api/v1/key" },
  deepseek: { provider: "DEEPSEEK", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.deepseek.com/user/balance" },
  groq: { provider: "GROQ", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyPattern: /^gsk_[A-Za-z0-9]{20,200}$/,
    checkUrl: "https://api.groq.com/openai/v1/models", cooldownSeconds: 60, hidesDeadModels: true },
  nvidia: { provider: "NVIDIA", label: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", keyPattern: /^nvapi-[A-Za-z0-9_-]{20,200}$/,
    checkUrl: "https://api.nvcf.nvidia.com/v2/nvcf/functions", cooldownSeconds: 60, hidesDeadModels: true },
  cloudflare: { provider: "CLOUDFLARE_AI", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
    keyPattern: /^[a-f0-9]{32}:[A-Za-z0-9_-]{30,80}$/,
    // The account's own catalog checks the token, the account id and the Workers AI permission at once, and spends nothing.
    checkUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/models/search?task=Text%20Generation&per_page=1",
    checkOk: (payload) => field(payload, "success") === true,
    // shortcut: one page of 100 (39 text models on 5/11), page through result_info when Cloudflare lists more.
    models: { url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/models/search?task=Text%20Generation&per_page=100",
      ids: (payload) => stringsOf(rows(field(payload, "result")), "name"),
      // Each model's window (its `context_window` property), listed as `context_window` like Groq's rows for the Space provider's limits.
      windows: (payload) => Object.fromEntries((rows(field(payload, "result")) ?? []).flatMap((row) => {
        const value = Number(rows(row.properties)?.find((property) => property.property_id === "context_window")?.value);
        return typeof row.name === "string" && value > 0 ? [[row.name, value]] : [];
      })) }, cooldownSeconds: 60, hidesDeadModels: true },
  gemini: { provider: "GOOGLE_AI", label: "Google AI", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPattern: GOOGLE_AI_KEY_PATTERN, checkUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    // Its OpenAI list names models `models/<id>`; chat takes the bare id.
    models: { url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
      ids: (payload) => stringsOf(rows(field(payload, "data")), "id")?.map((id) => id.replace(/^models\//, "")) ?? null }, cooldownSeconds: 60, hidesDeadModels: true },
  adaption: { provider: "ADAPTION", label: "Adaption Labs", baseUrl: "https://api.prod.adaptionlabs.ai/api/v1", keyPattern: /^pt_live_[A-Za-z0-9_-]{20,200}$/,
    checkUrl: "https://api.prod.adaptionlabs.ai/api/v1/models", cooldownSeconds: 60, hidesDeadModels: true },
  amd: { provider: "AMD_TOKEN_LAB", label: "AMD Token Lab", baseUrl: "https://api.tokenlab.amd.com/v1", keyPattern: /^tl-[A-Za-z0-9_-]{20,200}$/,
    checkUrl: "https://api.tokenlab.amd.com/v1/models", cooldownSeconds: 60, hidesDeadModels: true },
  inception: { provider: "INCEPTION", label: "Inception Labs", baseUrl: "https://api.inceptionlabs.ai/v1", keyPattern: /^sk_[A-Za-z0-9_-]{20,300}$/,
    // mercury-2 answers 404 model_not_found to the granted key (stable 7/11: the key never joined); a wrong key is 401 before any model check,
    // so a throttled 429 proves the key too (the free tier's per-minute cap).
    checkUrl: "https://api.inceptionlabs.ai/v1/chat/completions", checkAccepts: [429],
    checkBody: { model: "mercury-3", messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }, cooldownSeconds: 60, hidesDeadModels: true },
  jina: { provider: "JINA", label: "Jina AI", baseUrl: "https://api.jina.ai/v1", keyPattern: /^jina_[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.jina.ai/v1/embeddings", checkBody: { model: "jina-embeddings-v3", input: ["ok"] }, cooldownSeconds: 60,
    // Its catalog says "jina-ai/jina-embeddings-v3"; embeddings and rerank take the bare id.
    models: { url: "https://api.jina.ai/v1/models", ids: (payload) => stringsOf(rows(field(payload, "data")), "id")?.map((id) => id.replace(/^jina-ai\//, "")) ?? null } },
  // shortcut: Mixedbread's key prefix is not documented, so any token shape passes and the check decides; pin it once a key is seen.
  mixedbread: { provider: "MIXEDBREAD", label: "Mixedbread", baseUrl: "https://api.mixedbread.com/v1", keyPattern: /^[A-Za-z0-9_-]{20,300}$/,
    checkUrl: "https://api.mixedbread.com/v1/files", cooldownSeconds: 60 },
  agentrouter: { provider: "AGENTROUTER", label: "AgentRouter", baseUrl: "https://agentrouter.org/v1", keyPattern: /^sk-[A-Za-z0-9]{20,300}$/,
    checkUrl: "https://agentrouter.org/v1/dashboard/billing/subscription", cooldownSeconds: 60, forwardsUserAgent: true },
  // shortcut: Free.ai answers chat and /models without any key and refuses none (7/11), so its check proves nothing and its key shape is
  // unknown; pin both once Free.ai refuses a wrong key somewhere.
  freeai: { provider: "FREEAI", label: "Free.ai", baseUrl: "https://api.free.ai/v1", keyPattern: /^[A-Za-z0-9_.-]{16,300}$/,
    checkUrl: "https://api.free.ai/v1/models", cooldownSeconds: 60,
    // `{models: [{id, type}]}`: its self-hosted chat models only; external models (`self_hosted: false`) are not served by its chat endpoint.
    models: { url: "https://api.free.ai/v1/models", ids: (payload) => stringsOf(rows(field(payload, "models"))?.filter((row) => row.type === "chat" && row.self_hosted !== false) ?? null, "id") } },
  // Azure OpenAI (7/11, nous_msg:32dc26ee): `<resource>:<key>`, the v1 API at the resource's own host with its `api-key` header. A model is a
  // deployment name, so the list is the resource's deployments (v1's /models lists every base model it could deploy).
  azure: { provider: "AZURE_OPENAI", label: "Azure OpenAI", baseUrl: "https://{account}.openai.azure.com/openai/v1",
    keyPattern: /^[a-z0-9][a-z0-9-]{1,62}:[A-Za-z0-9]{32,100}$/, keyHeader: "api-key",
    // Microsoft for Startups credit ends 4/8/2027 04:44 UTC (plan clipboard:dkmX-VVYx-SX T3a); the rest of that day a card would pay.
    creditUntil: "2027-08-04T04:44:00Z", cooldownSeconds: 60,
    checkUrl: "https://{account}.openai.azure.com/openai/v1/models",
    models: { url: "https://{account}.openai.azure.com/openai/deployments?api-version=2022-12-01", ids: (payload) => stringsOf(rows(field(payload, "data")), "id") },
    keyFrom: azureKeyFrom },
  // shortcut: Z.AI's key shape (`<id>.<secret>`) is not pinned, so the check decides; pin it once a key is seen.
  zai: { provider: "ZAI", label: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", keyPattern: /^[A-Za-z0-9_.-]{20,300}$/,
    checkUrl: "https://api.z.ai/api/paas/v4/models", cooldownSeconds: 60 },
  // /v1/user/info answers 410 (code 20092, deprecated) since 11/2026; /v1/models needs the key (401 without) and spends nothing.
  siliconflow: { provider: "SILICONFLOW", label: "SiliconFlow", baseUrl: "https://api.siliconflow.com/v1", keyPattern: /^sk-[A-Za-z0-9]{20,300}$/,
    checkUrl: "https://api.siliconflow.com/v1/models", cooldownSeconds: 60 },
  // Mistral La Plateforme's free tier (7/11): every model, rate limited (a 429 cools the key), no card; its catalog needs the key (401 without).
  mistral: { provider: "MISTRAL", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyPattern: /^[A-Za-z0-9_-]{24,200}$/,
    checkUrl: "https://api.mistral.ai/v1/models", checkAccepts: [429], cooldownSeconds: 30, hidesDeadModels: true },
  ovh: { provider: "OVH", label: "OVHcloud AI Endpoints", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    keyPattern: new RegExp(`^${GATEWAY_KEYLESS_KEY}$`), keyless: true, checkUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models", cooldownSeconds: 60 },
  // Claude on the clouds' credits (plan clipboard:qIOxhbvXfHyT step 3): Bedrock waits on AWS Activate (case 179368413500454), Vertex on Google for
  // Startups. The key check is an empty Messages request: 400 (no messages) after the key is read, so it spends nothing; a throttled 429 proves it too.
  // shortcut: a cloud that validates the body before the key would pass a wrong key here; its first real request (401) then takes the key out.
  bedrock: { provider: "BEDROCK", label: "Claude on Amazon Bedrock", baseUrl: "https://bedrock-mantle.{region}.api.aws/anthropic/v1", keyPattern: BEDROCK_KEY,
    keyFrom: bedrockKeyFrom, messages: bedrockMessages, fixedModels: CLOUD_CLAUDE_MODELS, spendsGrant: true, cooldownSeconds: 60,
    checkBody: { model: "claude-haiku-5-5", max_tokens: 1, messages: [] }, checkAccepts: [400, 429] },
  vertex: { provider: "VERTEX", label: "Claude on Google Vertex AI", baseUrl: "https://aiplatform.googleapis.com/v1", keyPattern: VERTEX_KEY,
    keyFrom: vertexKeyFrom, messages: vertexMessages, fixedModels: CLOUD_CLAUDE_MODELS, spendsGrant: true, cooldownSeconds: 60,
    checkBody: { model: "claude-haiku-5-5", max_tokens: 1, messages: [] }, checkAccepts: [400, 429] }
};

/** Azure's portal shows Endpoint and Key apart: `https://<resource>.openai.azure.com/` (or `.cognitiveservices.`) and its first key-shaped word. */
export function azureKeyFrom(pasted: string): string | null {
  if (/^[a-z0-9][a-z0-9-]{1,62}:[A-Za-z0-9]{32,100}$/.test(pasted)) return pasted;
  const resource = /https:\/\/([a-z0-9][a-z0-9-]{1,62})\.(?:openai|cognitiveservices)\.azure\.com/i.exec(pasted)?.[1]?.toLowerCase();
  const key = /(?<![A-Za-z0-9])[A-Za-z0-9]{32,100}(?![A-Za-z0-9])/.exec(pasted)?.[0];
  return resource && key ? `${resource}:${key}` : null;
}
/** The key's header: Bearer, the provider's own (Azure's `api-key`), or none (OVH's anonymous access). */
const keyHeaders = (entry: KeyPoolProvider, token: string): Record<string, string> =>
  entry.keyless ? {} : entry.keyHeader ? { [entry.keyHeader]: token } : { authorization: `Bearer ${token}` };

/** The URL and Bearer token for a stored key: `<account>:<token>` fills `{account}` (Cloudflare); any other key goes as it is. */
export function poolUpstream(url: string, apiKey: string): { url: string; token: string } {
  if (!url.includes("{account}")) return { url, token: apiKey };
  const at = apiKey.indexOf(":");
  return { url: url.replaceAll("{account}", apiKey.slice(0, at)), token: apiKey.slice(at + 1) };
}

/** A pool's model ids as its catalog lists them through one key (the daily probe and the supported-models list), or the HTTP status. */
export async function catalogIds(entry: KeyPoolProvider, apiKey: string, fetchImpl: typeof fetch, baseUrl = entry.baseUrl): Promise<{ ids: string[] } | { status: number }> {
  if (entry.fixedModels) return { ids: [...entry.fixedModels] };
  const catalog = poolUpstream(entry.models?.url ?? `${baseUrl}/models`, apiKey);
  const listed = await fetchImpl(catalog.url, { headers: { ...keyHeaders(entry, catalog.token), accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!listed.ok) return { status: listed.status };
  let payload: unknown = null;
  try { payload = JSON.parse(await readBounded(listed, 16 * 1024 * 1024)); } catch { /* not JSON: no ids */ }
  const ids = entry.models ? entry.models.ids(payload) : stringsOf(rows(field(payload, "data")), "id");
  // A pool without a card: its free models first (Z.AI's own list leaves them out), then the paid ones it lists.
  const free = GATEWAY_POOL_FREE_MODELS[entry.provider] ?? [];
  return ids ? { ids: [...new Set([...free, ...ids])] } : { status: 502 };
}
const DAILY_CAP = /per day|daily|\bRPD\b|\bTPD\b|86400|neurons/i;
/** Seconds of a key's 429 cooldown (see the registry's note); undefined leaves it to the balancer (the message's "try again in", else its backoff). */
export function poolCooldownSeconds(entry: KeyPoolProvider, retryAfter: string | null, message: string, nowMs: number): number | undefined {
  const header = Number(retryAfter);
  if (retryAfter && Number.isFinite(header) && header > 0) return header;
  if (parseRetryAfter(message) !== null) return undefined;
  if (DAILY_CAP.test(message)) return Math.ceil((Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1) - nowMs) / 1000);
  return entry.cooldownSeconds;
}

export type KeyPoolSlug = keyof typeof keyPoolProviders;
/** A provider error saying the key has no credit (OpenAI: code credit_balance_exhausted or insufficient_quota, type insufficient_quota). */
const outOfCredit = (error: { code?: unknown; type?: unknown } | undefined) =>
  Boolean(error) && (["insufficient_quota", "credit_balance_exhausted"].includes(String(error!.code)) || error!.type === "insufficient_quota");
export const keyPoolSlugFor = (provider: GatewayProvider): KeyPoolSlug | null =>
  (Object.entries(keyPoolProviders).find(([, entry]) => entry.provider === provider)?.[0] as KeyPoolSlug | undefined) ?? null;

/** Whether a key works, by the provider's free check request. */
export async function checkPoolKey(entry: KeyPoolProvider, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const built = entry.messages ? await entry.messages({ apiKey, body: entry.checkBody ?? {}, streaming: false, headers: {}, fetchImpl }) : null;
    const { url, token } = poolUpstream(entry.checkUrl ?? "", apiKey);
    const response = await fetchImpl(built?.url ?? url, { signal: AbortSignal.timeout(15_000),
      ...(entry.checkBody ? { method: "POST", body: built?.body ?? JSON.stringify(entry.checkBody) } : {}),
      headers: { ...(built?.headers ?? keyHeaders(entry, token)), accept: "application/json", ...(entry.checkBody ? { "content-type": "application/json" } : {}) } });
    if (!response.ok || !entry.checkOk) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: response.ok || Boolean(entry.checkAccepts?.includes(response.status)), status: response.status };
    }
    return { ok: entry.checkOk(await response.json().catch(() => null)), status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof UpstreamRefusal ? error.status : 0 };
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
    // Jina's rerank answers only total_tokens (all of it input).
    inputTokens: usageNumber(usage.prompt_tokens ?? usage.input_tokens ?? usage.total_tokens),
    outputTokens: usageNumber(usage.completion_tokens ?? usage.output_tokens),
    cachedInputTokens: usageNumber(details?.cached_tokens),
    costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 && usage.cost < 1000 ? usage.cost : null
  };
}

/** A Claude pool's usage: input counts the cache reads and writes too (as the Claude routes log it), and the cost at Anthropic's list price. */
function claudePoolUsage(usage: ClaudeUsageTokens, model: string): PoolUsage {
  const cost = claudeCostUsd(usage, model);
  return { inputTokens: usage.inputTokens === null ? null : usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    outputTokens: usage.outputTokens, cachedInputTokens: usage.cacheReadInputTokens,
    // shortcut: Anthropic's list price +10% (the clouds' regional premium) for every request so the credit cap errs early; use each cloud's billed cost once a credit lands.
    costUsd: cost === null ? null : cost * 1.1 };
}
/**
 * A credit pool stops at 90% of its grant spent: a technical bound, because its spend is a list-price estimate and the request log reaches the
 * daily sums about a second late, so the rest absorbs requests in flight and price drift and the card is never charged.
 */
const CREDIT_STOP = 0.9;

export function registerKeyPoolRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: {
  pools: Partial<Record<KeyPoolSlug, AccountPool>>; logs: RequestLogWriter; settings: () => Promise<GatewaySettings>;
  fetchImpl?: typeof fetch; now?: () => number; maxAccountAttempts?: number; baseUrls?: Partial<Record<KeyPoolSlug, string>>;
  settleKeyUsage?: (keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) => Promise<void>;
  checks?: ModelChecks; internalToken?: string | null;
  /** The credit grants (GATEWAY_FREE_GRANTS) and what a provider has spent since a day (the gateway's daily sums); without them a credit pool refuses. */
  grants?: Partial<Record<GatewayProvider, GatewayFreeGrant>>; creditSpent?: (provider: GatewayProvider, sinceDay: string) => Promise<number>;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hidden = (entry: KeyPoolProvider, model: string) => Boolean(entry.hidesDeadModels && options.checks?.isDead(entry.provider, model));
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
  /** AgentRouter's 401 "unauthorized client detected" refuses the calling client, not the key: a 502 the caller fails over from, the key untouched. */
  const clientRefusal = (entry: KeyPoolProvider, status: number, text: string) => entry.forwardsUserAgent && status === 401 && /unauthorized client/i.test(text)
    ? { status: 502, text: JSON.stringify(gatewayError("upstream_client_refused", `${entry.label} serves only the clients it knows and refused this one.`)) } : null;
  const clientAgent = (entry: KeyPoolProvider, request: FastifyRequest): Record<string, string> =>
    entry.forwardsUserAgent && request.headers["user-agent"] ? { "user-agent": String(request.headers["user-agent"]) } : {};

  async function recordFailure(entry: KeyPoolProvider, pool: AccountPool, account: GatewayAccountRecord, status: number, text: string,
    retryAfter: string | null): Promise<boolean> {
    let error: { code?: unknown; type?: unknown; message?: unknown } = {};
    // OpenAI's `{error}`, or Cloudflare's `{errors: [...]}`.
    // Gemini wraps its error in a one-element array.
    try { const json = JSON.parse(text) as unknown; const parsed = (Array.isArray(json) ? json[0] : json) as { error?: typeof error; errors?: Array<typeof error> };
      error = parsed?.error ?? parsed?.errors?.[0] ?? {}; } catch { /* not JSON */ }
    const message = typeof error.message === "string" ? error.message.slice(0, 300) : `HTTP ${status}`;
    // A rejected key leaves rotation until it is added again; a 403 can be about one model, so the key stays usable.
    if (status === 401) { await pool.refreshRejectedToken(account, "token_invalidated"); return true; }
    if (status === 403) { await pool.markPermanentFailure(account, "token_invalidated", false); return true; }
    if (status === 402 || outOfCredit(error)) {
      // Out of credit: the key stays out of rotation for a day, or until the operator tops it up and tests it.
      await pool.markQuotaExceeded(account, { message, resetsInSeconds: 24 * 3600 });
      return true;
    }
    if (status === 429) {
      await pool.markRateLimited(account, { message, resetsInSeconds: poolCooldownSeconds(entry, retryAfter, message, now()) });
      return true;
    }
    if (status >= 500) { pool.markTransientError(account.id); return true; }
    return false;
  }

  /** Why a credit pool may not spend now (code and message), or null. */
  async function creditRefusal(entry: KeyPoolProvider): Promise<[string, string] | null> {
    const grant = (options.grants ?? GATEWAY_FREE_GRANTS)[entry.provider];
    if (!grant?.amount || grant.unit !== "usd" || !options.creditSpent) {
      return ["credit_not_recorded", `${entry.label} has no credit recorded in Space Gateway; a card would pay, so it sends nothing there.`];
    }
    if (grant.validUntil && new Date(now()).toISOString().slice(0, 10) > grant.validUntil) {
      return ["credit_expired", `${entry.label}'s credit ended on ${grant.validUntil}; past it a card pays, so Space Gateway stopped using it.`];
    }
    const spent = await options.creditSpent(entry.provider, grant.since);
    return spent >= grant.amount * CREDIT_STOP
      ? ["credit_spent", `${entry.label} has spent about $${spent.toFixed(2)} of its $${grant.amount} credit; Space Gateway stops at ${CREDIT_STOP * 100}% so the card is never charged.`] : null;
  }

  async function forward(request: FastifyRequest, reply: FastifyReply, path: "chat/completions" | "responses" | "embeddings" | "rerank" | "messages") {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const target = poolFor(request, reply);
    if (!target) return reply;
    const { entry, pool, baseUrl } = target;
    if (Boolean(entry.messages) !== (path === "messages")) {
      return reply.code(404).send(gatewayError("unknown_route", `${entry.label}'s pool does not serve /${path}.`, "invalid_request_error"));
    }
    // Operator rule 7/11 (nous_msg:21ec89e5): the cloud credits never serve Claude Code, which runs on the Claude subscriptions alone.
    if (entry.spendsGrant && isClaudeCodeRequest(request.headers)) {
      return reply.code(403).send(gatewayError("client_not_allowed", `${entry.label} does not serve Claude Code; Claude Code runs on the Claude subscriptions.`, "invalid_request_error"));
    }
    if (entry.creditUntil && now() >= Date.parse(entry.creditUntil)) {
      return reply.code(402).send(gatewayError("credit_expired", `${entry.label}'s credit ended on ${entry.creditUntil}; past it a card pays, so Space Gateway stopped using it.`));
    }
    const key = request.gatewayApiKey!;
    const startedAt = now();
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? { ...(request.body as Record<string, unknown>) } : null;
    if (!body) return reply.code(400).send(gatewayError("invalid_request", "The request body must be a JSON object.", "invalid_request_error"));
    if (key.enforcedModel) body.model = key.enforcedModel;
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    if (!model) return reply.code(400).send(gatewayError("invalid_request", "Missing required field: model.", "invalid_request_error"));
    // A fast-mode `speed` has no list price for every model, so a credit pool takes standard speed only.
    if (entry.fixedModels && (!entry.fixedModels.includes(model) || body.speed !== undefined)) {
      return reply.code(400).send(gatewayError("model_not_listed", `${entry.label} sends only ${entry.fixedModels.join(", ")}, at standard speed.`, "invalid_request_error"));
    }
    if (entry.spendsGrant) {
      const refused = await creditRefusal(entry);
      if (refused) return reply.code(402).send(gatewayError(refused[0], refused[1]));
    }
    const free = GATEWAY_POOL_FREE_MODELS[entry.provider];
    if (free && !free.includes(model)) {
      return reply.code(403).send(gatewayError("model_not_free", `${entry.label} has no card behind it, so Space Gateway sends it only its free models: ${free.join(", ")}.`, "invalid_request_error"));
    }
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
    const requestId = request.id;
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
    // A chat answer tells whether the model lives (only 410, 404 and 200 count; the store writes only a change).
    const note = (status: number, reason: string | null) => {
      if (path === "chat/completions" && entry.hidesDeadModels) void options.checks?.record(entry.provider, model, status, reason?.slice(0, 300) ?? null).catch(() => undefined);
    };
    let last: { status: number; text: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = await nextAccount(pool, settings, scope, tried);
      if (!account) break;
      tried.add(account.id);
      pool.markSelected(account.id, reply.raw);
      let upstream: Response;
      try {
        const apiKey = (await pool.credentials(account)).accessToken;
        const built = entry.messages ? await entry.messages({ apiKey, body, streaming, headers: request.headers, fetchImpl }) : null;
        const { url, token } = poolUpstream(`${baseUrl}/${path}`, apiKey);
        upstream = await fetchImpl(built?.url ?? url, {
          method: "POST", body: built?.body ?? JSON.stringify(body), signal: controller.signal,
          headers: { ...(built?.headers ?? keyHeaders(entry, token)), "content-type": "application/json", accept: streaming ? "text/event-stream" : "application/json",
            // Mixedbread answers an empty 400 to an x-request-id that is no UUID (stable 7/11); the gateway's ids are req_<hex>.
            ...(entry.provider === "MIXEDBREAD" ? {} : { "x-request-id": requestId }),
            ...clientAgent(entry, request),
            ...(entry.provider === "OPENROUTER" ? { "x-title": "Space Gateway" } : {}) }
        });
      } catch (error) {
        if (controller.signal.aborted) return reply;
        if (error instanceof UpstreamRefusal) {
          last = { status: error.status, text: error.text };
          if (await recordFailure(entry, pool, account, error.status, error.text, null)) continue;
          break;
        }
        pool.markTransientError(account.id);
        last = { status: 502, text: JSON.stringify(gatewayError("upstream_unavailable", `${entry.label} is unreachable.`)) };
        continue;
      }
      if (!upstream.ok) {
        const text = await readBounded(upstream);
        const refused = clientRefusal(entry, upstream.status, text);
        last = refused ?? { status: upstream.status, text };
        note(last.status, last.text);
        if (refused) break;
        // A 410 (an end-of-life model) and other request errors are the model's or the request's, never the key's: passed through as is.
        if (await recordFailure(entry, pool, account, upstream.status, text, upstream.headers.get("retry-after"))) continue;
        break;
      }
      void pool.markSuccess(account.id).catch(() => undefined);
      void pool.touch(account.id, new Date(startedAt).toISOString()).catch(() => undefined);
      note(200, null);
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      if (!contentType.includes("text/event-stream") || !upstream.body) {
        const text = await upstream.text();
        let usage: PoolUsage | null = null;
        try { const payload: unknown = JSON.parse(text); usage = entry.messages ? claudePoolUsage(claudeResponseUsage(payload), model) : readPoolUsage(payload); } catch { /* passed through as is */ }
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
      let quotaMessage: string | null = null;
      // A Claude pool's stream is Anthropic SSE: its usage comes in message_start and message_delta.
      const claude = entry.messages ? new ClaudeStreamInspector() : null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstTokenAt === null) firstTokenAt = now();
          reply.raw.write(value);
          if (claude) { claude.push(value); continue; }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:") || !/usage|insufficient_quota|credit_balance_exhausted/.test(line)) continue;
            try {
              type StreamError = { code?: unknown; type?: unknown; message?: unknown };
              const event = JSON.parse(line.slice(5).trim()) as { error?: StreamError; response?: { error?: StreamError } };
              usage = readPoolUsage(event) ?? usage;
              // OpenAI answers 200 and fails the stream for a key without credit (29/10, every Nous turn on the OpenAI pool):
              // event "error" {error: {code: credit_balance_exhausted}}, then response.failed {response: {error: {type: insufficient_quota}}}.
              const error = event.error ?? event.response?.error;
              if (outOfCredit(error)) quotaMessage = typeof error!.message === "string" ? error!.message.slice(0, 300) : String(error!.code ?? error!.type);
            } catch { /* not JSON */ }
          }
          if (pending.length > 1024 * 1024) pending = "";
        }
      } catch {
        failed = controller.signal.aborted ? "client_closed" : "stream_incomplete";
      }
      reply.raw.end();
      if (claude) {
        usage = claudePoolUsage(claude.usage, model);
        if (claude.status === "failed") failed ??= claude.errorType ?? "stream_error";
      }
      if (quotaMessage) {
        failed ??= "insufficient_quota";
        await pool.markQuotaExceeded(account, { message: quotaMessage, resetsInSeconds: 24 * 3600 }).catch(() => undefined);
      }
      log(account, failed ? "error" : "success", failed, usage, firstTokenAt);
      return reply;
    }
    log(null, "error", last ? `http_${last.status}` : "no_accounts", null, null);
    if (last) return reply.code(last.status).header("content-type", "application/json").header("x-request-id", requestId).send(last.text);
    return reply.code(503).send(gatewayErrors.noAccounts());
  }

  app.post("/pools/:provider/v1/chat/completions", (request, reply) => forward(request, reply, "chat/completions"));
  app.post("/pools/:provider/v1/responses", (request, reply) => forward(request, reply, "responses"));
  // Embeddings and rerank (Jina AI, 7/11; OpenAI-shaped embeddings on the other pools too).
  app.post("/pools/:provider/v1/embeddings", (request, reply) => forward(request, reply, "embeddings"));
  app.post("/pools/:provider/v1/rerank", (request, reply) => forward(request, reply, "rerank"));
  // The Claude pools' Anthropic Messages API (Bedrock, Vertex).
  app.post("/pools/:provider/v1/messages", (request, reply) => forward(request, reply, "messages"));
  // Every pool's supported models through its first active key (the Gateway accounts view and the Nous programs rows; the API caches them).
  const guard = createAdminGuard(options.internalToken ?? null);
  app.post("/__space-gateway/admin/pool-models", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const asked = (request.body as { providers?: unknown } | null)?.providers;
    const slugs = (Object.keys(keyPoolProviders) as KeyPoolSlug[]).filter((slug) => options.pools[slug] && (!Array.isArray(asked) || asked.includes(keyPoolProviders[slug].provider)));
    const data = await Promise.all(slugs.map(async (slug) => {
      const entry = keyPoolProviders[slug], pool = options.pools[slug]!;
      const account = (await pool.accounts()).find((candidate) => candidate.status === "ACTIVE");
      if (!account) return { provider: entry.provider, models: null, error: "No active key." };
      const listed = await catalogIds(entry, (await pool.credentials(account)).accessToken, fetchImpl, (options.baseUrls?.[slug] ?? entry.baseUrl).replace(/\/+$/, ""))
        .catch(() => ({ status: 0 }));
      return "ids" in listed ? { provider: entry.provider, models: listed.ids.filter((id) => !hidden(entry, id)), error: null }
        : { provider: entry.provider, models: null, error: listed.status ? `${entry.label} answered HTTP ${listed.status} to its model list.` : `${entry.label} could not be reached.` };
    }));
    return { data, fetchedAt: new Date(now()).toISOString() };
  });
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
      if (target.entry.fixedModels) return { object: "list", data: target.entry.fixedModels.map((id) => ({ id, object: "model", owned_by: target.entry.label })) };
      try {
        const catalog = target.entry.models;
        const { url, token } = poolUpstream(catalog?.url ?? `${target.baseUrl}/models`, (await target.pool.credentials(account)).accessToken);
        const upstream = await fetchImpl(url, { headers: { ...keyHeaders(target.entry, token), accept: "application/json", ...clientAgent(target.entry, request) },
          signal: AbortSignal.timeout(20_000) });
        const text = await readBounded(upstream, 16 * 1024 * 1024);
        const free = GATEWAY_POOL_FREE_MODELS[target.entry.provider];
        if (upstream.ok && free) return { object: "list", data: free.map((id) => ({ id, object: "model", owned_by: target.entry.label })) };
        if (upstream.ok && !catalog) {
          let list: { data?: unknown } | null = null;
          if (target.entry.hidesDeadModels) try { list = JSON.parse(text) as { data?: unknown }; } catch { /* passed through as is */ }
          if (list && Array.isArray(list.data)) {
            return { ...list, data: list.data.filter((row: { id?: unknown }) => !(typeof row?.id === "string" && hidden(target.entry, row.id))) };
          }
          return reply.code(200).header("content-type", upstream.headers.get("content-type") ?? "application/json").send(text);
        }
        if (upstream.ok) {
          // Cloudflare's `result[].name` in the OpenAI list shape.
          let ids: string[] | null = null;
          let windows: Record<string, number> = {};
          try { const payload: unknown = JSON.parse(text); ids = catalog!.ids(payload); windows = catalog!.windows?.(payload) ?? {}; } catch { /* not JSON */ }
          return ids ? { object: "list", data: ids.filter((id) => !hidden(target.entry, id))
            .map((id) => ({ id, object: "model", owned_by: target.entry.label, ...(windows[id] ? { context_window: windows[id] } : {}) })) }
            : reply.code(502).send(gatewayError("upstream_invalid", `${target.entry.label} answered its model catalog in an unknown shape.`));
        }
        const refused = clientRefusal(target.entry, upstream.status, text);
        if (refused) return reply.code(refused.status).header("content-type", "application/json").send(refused.text);
        if (!(await recordFailure(target.entry, target.pool, account, upstream.status, text, upstream.headers.get("retry-after")))) {
          return reply.code(upstream.status).header("content-type", "application/json").send(text);
        }
      } catch {
        target.pool.markTransientError(account.id);
      }
    }
    return reply.code(503).send(gatewayErrors.noAccounts());
  });
}
