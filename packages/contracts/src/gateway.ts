import { z } from "zod";
import { atLeastOneField } from "./update-rules.js";

/**
 * Space Gateway: the native TypeScript account load balancer (codex-lb rewrite) with built-in context
 * compression (Headroom rewrite). These schemas are the admin view; credentials never appear in them.
 */

export const gatewayProviderSchema = z.enum([
  "CODEX", "CLAUDE", "ANTIGRAVITY", "COPILOT", "OPENAI_API", "ANTHROPIC_API", "DEEPSEEK", "OPENROUTER", "GOOGLE_AI", "KIMI", "QWEN",
  // Free OpenAI-compatible key pools (operator 5/11 14:34 BKK).
  "NVIDIA", "GROQ", "CLOUDFLARE_AI",
  // Adaption Labs: granted credits (6/11, 1,500 credits that never expire, no card on file), an OpenAI-compatible key pool like the free ones.
  "ADAPTION",
  // AMD Token Lab: granted points (6/11, no card on file), an OpenAI-compatible key pool like Adaption.
  "AMD_TOKEN_LAB",
  // Granted free tokens (operator 7/11 10:53 BKK, nous_msg:c1272a0c): Inception Labs (Mercury chat, 100M), Jina AI (embeddings and rerank, 10M),
  // Mixedbread (embeddings, $5) and AgentRouter ($149.78, a third-party relay that sees prompts).
  "INCEPTION", "JINA", "MIXEDBREAD", "AGENTROUTER",
  // Free.ai (7/11, Cleo's audit): free chat that answers even without a key (its startup program is in progress); a third party that sees prompts.
  "FREEAI",
  // Azure OpenAI (7/11, nous_msg:32dc26ee): $200 Microsoft for Startups credit until 5 Feb 2027 on a pay-as-you-go plan with a card behind it.
  "AZURE_OPENAI",
  // Free sign-ups (7/11, nous_msg:c1272a0c, new-signups.md): Z.AI's free GLM Flash models and SiliconFlow's $0 models (neither account has a card),
  // OVHcloud AI Endpoints' anonymous access (no key, 2 requests a minute per IP).
  "ZAI", "SILICONFLOW", "OVH",
  // Mistral La Plateforme's free tier (7/11, nous_msg:d9b67550): every model, rate limited, no card (its free tier may train on prompts).
  "MISTRAL",
  // Claude on the clouds' credits (plan clipboard:qIOxhbvXfHyT step 3): Amazon Bedrock (AWS Activate) and Google Vertex AI (Google for Startups).
  // A card is behind both, so their pools refuse until GATEWAY_FREE_GRANTS records the credit, and from 90% of it spent (key-pools.ts).
  "BEDROCK", "VERTEX",
  // Make AI on the Make Startup Program's credits through the space-ai-relay scenario (plan clipboard:F1nJVLcoWdd- step 4): BACKGROUND keys only, off until configured.
  "MAKE"
]);
/** The providers whose API keys Space Gateway takes (`POST /api/admin/gateway/api-key/add`). */
export const GATEWAY_API_KEY_PROVIDERS = ["OPENAI_API", "OPENROUTER", "DEEPSEEK", "NVIDIA", "GROQ", "CLOUDFLARE_AI", "CLAUDE", "GOOGLE_AI", "ADAPTION", "AMD_TOKEN_LAB", "INCEPTION", "JINA", "MIXEDBREAD", "AGENTROUTER", "FREEAI", "AZURE_OPENAI", "ZAI", "SILICONFLOW", "OVH", "MISTRAL", "BEDROCK", "VERTEX"] as const;
export type GatewayApiKeyProvider = (typeof GATEWAY_API_KEY_PROVIDERS)[number];
/**
 * Operator 7/11 10:53 BKK (nous_msg:c1272a0c, «σε όσα έχουμε λάβει tokens ... να μπαίνουν απευθείας στο spaceapp gateway χωρίς να σε ρωτήσω»):
 * the free and granted key pools a key an agent saves in the Vault joins on its own, by the words of its label. Paid pools (OpenAI, OpenRouter,
 * DeepSeek, Claude) stay a person's choice. The gateway's own key check (pattern, then a request that spends nothing) decides; a wrong match is refused there.
 */
const GATEWAY_FREE_KEY_LABELS: Array<[GatewayApiKeyProvider, RegExp]> = [["INCEPTION", /\binception\b|\bmercury\b/i], ["JINA", /\bjina\b/i],
  ["MIXEDBREAD", /\bmixedbread\b|\bmxbai\b/i], ["AGENTROUTER", /\bagent ?router\b/i], ["FREEAI", /\bfree\.ai\b|\bfreeai\b/i], ["AZURE_OPENAI", /\bazure openai\b|\baoai\b/i], ["ZAI", /\bz\.ai\b|\bzai\b|\bzhipu\b/i],
  ["SILICONFLOW", /\bsilicon ?flow\b/i], ["MISTRAL", /\bmistral\b|\bcodestral\b/i], ["BEDROCK", /\bbedrock\b/i], ["VERTEX", /\bvertex\b/i],
  ["ADAPTION", /\badaption\b/i], ["AMD_TOKEN_LAB", /\bamd\b|token ?lab/i], ["GROQ", /\bgroq\b/i], ["NVIDIA", /\bnvidia\b|\bnvapi\b/i],
  ["CLOUDFLARE_AI", /\bcloudflare\b.*\b(?:workers ai|ai)\b/i], ["GOOGLE_AI", /(?<![./~])\bgemini\b|\bai studio\b/i]];
export const gatewayFreeKeyProviderOf = (label: string): GatewayApiKeyProvider | null => {
  const matched = GATEWAY_FREE_KEY_LABELS.filter(([, words]) => words.test(label));
  // One provider only: a label naming two (say "Jina key for the Gemini test") is left to a person.
  return matched.length === 1 ? matched[0]![0] : null;
};

/** Same states as codex-lb accounts. */
export const gatewayAccountStatusSchema = z.enum(["ACTIVE", "RATE_LIMITED", "QUOTA_EXCEEDED", "PAUSED", "REAUTH_REQUIRED", "DEACTIVATED"]);

/**
 * Free plans never serve gateway traffic (operator rule 2026-10-13): an account whose plan is or becomes free is
 * paused with this reason, and resuming it is refused until a sign-in on a paid plan replaces the free one.
 */
export const GATEWAY_FREE_PLAN_PAUSE_REASON = "Free plan: paused automatically and never used. Sign in again on a paid plan, then resume.";

export function isGatewayFreePlan(planType: string | null | undefined): boolean {
  const plan = (planType ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return plan === "free" || plan === "free_workspace";
}

export const gatewayRoutingStrategySchema = z.enum([
  "CAPACITY_WEIGHTED", "RELATIVE_AVAILABILITY", "USAGE_WEIGHTED", "ROUND_ROBIN", "FILL_FIRST", "SEQUENTIAL_DRAIN", "RESET_DRAIN", "SINGLE_ACCOUNT"
]);

export const gatewayTrafficClassSchema = z.enum(["INTERACTIVE", "BACKGROUND", "TRANSLATION"]);
// Off or On. Shadow (measure without sending) was removed on 2026-10-13 (migration 0172); statistics keep its history.
export const gatewayCompressionModeSchema = z.enum(["OFF", "ON"]);
export const gatewayCompressionProfileSchema = z.enum(["CACHE", "TOKEN"]);
/**
 * Output policy: response rules Space Gateway adds to an agent's system prompt (plan clipboard:1QB_tqacF15X, B2).
 * CONCISE = terse replies with the payload verbatim (after caveman v3.2.0, Apache-2.0), LEAN = the smallest complete
 * change (after ponytail v5.2.0, MIT), BOTH = concise then lean. Measured 2026-10-13: LEAN cuts Claude Code cost 15%
 * and Antigravity 17% with quality unchanged; nothing helped Codex.
 */
export const gatewayOutputPolicySchema = z.enum(["OFF", "CONCISE", "LEAN", "BOTH"]);
/** Providers whose compression and output policy can differ from the global settings. */
export const gatewayCompressionProviderIdSchema = z.enum(["CLAUDE", "CODEX", "ANTIGRAVITY"]);
/** One provider's compression settings; a missing field inherits the global setting (output policy: Off). */
export const gatewayCompressionProviderSettingsSchema = z.object({
  mode: gatewayCompressionModeSchema,
  profile: gatewayCompressionProfileSchema,
  codeText: gatewayCompressionModeSchema,
  timeBudgetMs: z.number().int().min(10).max(5000),
  outputPolicy: gatewayOutputPolicySchema
}).partial().strict();
export const gatewayCompressionProvidersSchema = z.object({
  CLAUDE: gatewayCompressionProviderSettingsSchema,
  CODEX: gatewayCompressionProviderSettingsSchema,
  ANTIGRAVITY: gatewayCompressionProviderSettingsSchema
}).partial().strict();
/**
 * The provider routes Nous's "Space" provider tries, first to last (operator 3/11 15:03 BKK and 8/11): each route is a
 * Space Gateway pool and the runtime that drives it. CLAUDE_OPENCODE is the Claude API-key account run by OpenCode, never by Claude Code
 * (operator rule 27/10: the API budget is only for use outside Claude Code). ANTIGRAVITY is Gemini Argon, ANTIGRAVITY_FLASH Gemini 3.8 Flash and ANTIGRAVITY_CLAUDE the Claude models of Antigravity (8/11).
 * Inside a route the pool's own account routing (fill-first) still picks the account; this order only says which route a turn tries next when one has no room.
 */
export const GATEWAY_PROVIDER_ROUTES = ["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE", "BEDROCK", "VERTEX"] as const;
export const gatewayProviderRouteSchema = z.enum(GATEWAY_PROVIDER_ROUTES);
export type GatewayProviderRoute = z.infer<typeof gatewayProviderRouteSchema>;
/** The subscription routes. */
const SUBSCRIPTION_ROUTES: ReadonlySet<GatewayProviderRoute> = new Set(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE"]);
export const GATEWAY_FREE_ROUTES: ReadonlySet<GatewayProviderRoute> = new Set([]);
/**
 * The free models of a pool whose catalog mixes free and paid and whose account has no card (new-signups.md 7/11, each provider's pricing page):
 * the pool serves only these and its supported models tag them free, the rest paid. SiliconFlow: only the five billed $0.0000 on 7/11.
 */
export const GATEWAY_POOL_FREE_MODELS: Partial<Record<GatewayProvider, readonly string[]>> = {
  ZAI: ["glm-4.5-flash", "glm-4.7-flash", "glm-4.6v-flash"],
  SILICONFLOW: ["Qwen/Qwen3-8B", "Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen3.5-9B", "google/gemma-4-12B-it", "openai/gpt-oss-20b"]
};
/** Whether a pool's model is free: its free list, OVH's anonymous access (all free), OpenRouter's `:free` ids; null where nothing says. */
export const gatewayPoolModelFree = (provider: GatewayProvider, id: string): boolean | null =>
  provider === "OVH" || provider === "MISTRAL" ? true : GATEWAY_POOL_FREE_MODELS[provider]?.includes(id) ?? (id.endsWith(":free") || null);
/** The stored "key" of a pool that needs none (OVH): one account, and no key header is sent. */
export const GATEWAY_KEYLESS_KEY = "keyless-anonymous-access";
/** Claude on cloud credits (plan clipboard:qIOxhbvXfHyT step 3): right after the subscriptions, off until a person turns one on, never for Claude Code. */
export const CLOUD_CREDIT_ROUTES: ReadonlySet<GatewayProviderRoute> = new Set(["BEDROCK", "VERTEX"]);
/** Free routes of unvetted third parties that see prompts: a stored order takes them in after its last free route, not before the others. */
const GATEWAY_RELAY_ROUTES: ReadonlySet<GatewayProviderRoute> = new Set([]);
/** The default provider order: Claude, Codex, Claude via OpenCode, Gemini Argon, Gemini 3.8 Flash and Claude (Antigravity); cloud credits off. */
export const GATEWAY_DEFAULT_PROVIDER_ORDER: Array<{ route: GatewayProviderRoute; enabled: boolean }> = GATEWAY_PROVIDER_ROUTES
  .map((route) => ({ route, enabled: !CLOUD_CREDIT_ROUTES.has(route) }));
export const gatewayProviderOrderSchema = z.array(z.object({ route: gatewayProviderRouteSchema, enabled: z.boolean() }).strict())
  .length(GATEWAY_PROVIDER_ROUTES.length).refine((order) => new Set(order.map((entry) => entry.route)).size === order.length, "Each provider route once.");
/**
 * A stored order read whole: unknown routes dropped, missing subscription ones appended on, cloud credit routes off.
 */
export function gatewayProviderOrderOf(value: unknown): Array<{ route: GatewayProviderRoute; enabled: boolean }> {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set<GatewayProviderRoute>();
  const kept = rows.flatMap((row) => {
    const parsed = z.object({ route: gatewayProviderRouteSchema, enabled: z.boolean() }).safeParse(row);
    if (!parsed.success || seen.has(parsed.data.route)) return [];
    seen.add(parsed.data.route);
    return [parsed.data];
  });
  if (!kept.length) return GATEWAY_DEFAULT_PROVIDER_ORDER.map((entry) => ({ ...entry }));
  const missing = GATEWAY_PROVIDER_ROUTES.filter((route) => !seen.has(route));
  const after = kept.reduce((last, entry, index) => (SUBSCRIPTION_ROUTES.has(entry.route) ? index + 1 : last), 0);
  const missingSubs = missing.filter((route) => SUBSCRIPTION_ROUTES.has(route)).map((route) => ({ route, enabled: true }));
  const missingCredits = missing.filter((route) => CLOUD_CREDIT_ROUTES.has(route)).map((route) => ({ route, enabled: false }));
  const missingOthers = missing.filter((route) => !SUBSCRIPTION_ROUTES.has(route) && !CLOUD_CREDIT_ROUTES.has(route)).map((route) => ({ route, enabled: true }));
  return [...kept.slice(0, after), ...missingSubs, ...missingCredits, ...kept.slice(after), ...missingOthers];
}
export const gatewayLimitTypeSchema = z.enum(["TOTAL_TOKENS", "INPUT_TOKENS", "OUTPUT_TOKENS", "COST_USD"]);
export const gatewayLimitWindowSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
export const gatewayReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export const gatewayTimeFormatSchema = z.enum(["12H", "24H"]);
/** Which usage windows a view or the warm-up covers: 5h (PRIMARY), weekly (SECONDARY) or both. */
export const gatewayWindowChoiceSchema = z.enum(["PRIMARY", "SECONDARY", "BOTH"]);
export const gatewayStreamTransportSchema = z.enum(["DEFAULT", "HTTP", "WEBSOCKET"]);
export const gatewayLanModeSchema = z.enum(["ENV", "OFF", "ON"]);

const isoSchema = z.string().max(40);
const gatewayIdSchema = z.string().regex(/^gw_[a-z]+:[a-f0-9]{32}$/);

export const gatewayUsageWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100).nullable(),
  resetAt: isoSchema.nullable(),
  windowMinutes: z.number().int().min(1).max(60 * 24 * 31).nullable()
}).strict();

export const gatewayAccountSchema = z.object({
  id: gatewayIdSchema,
  provider: gatewayProviderSchema,
  label: z.string().min(1).max(120),
  /** A name the operator chose; shown instead of the label. */
  alias: z.string().min(1).max(80).nullable(),
  email: z.string().max(320).nullable(),
  planType: z.string().max(40).nullable(),
  status: gatewayAccountStatusSchema,
  statusReason: z.string().max(500).nullable(),
  priority: z.number().int().min(0).max(1000),
  warmupEnabled: z.boolean(),
  resetCreditsAvailable: z.number().int().min(0).nullable(),
  primaryWindow: gatewayUsageWindowSchema,
  secondaryWindow: gatewayUsageWindowSchema,
  /** Separate quotas inside one account (Antigravity: Gemini models and Claude/GPT models). */
  quotaGroups: z.array(z.object({
    key: z.string().min(1).max(80),
    primaryWindow: gatewayUsageWindowSchema,
    secondaryWindow: gatewayUsageWindowSchema
  }).strict()).max(10).optional(),
  lastRefreshAt: isoSchema.nullable(),
  lastUsedAt: isoSchema.nullable(),
  createdAt: isoSchema,
  /** The weekly used % when the account's pace day began (ms), for `gatewayPaceDay`; null when it could not be read. */
  paceDayStart: z.object({ at: z.number(), usedPercent: z.number().min(0).max(100) }).strict().nullable().optional(),
  /** A free key pool's models hidden because they answered 410 (end of life) or 404 (not served to the key), with when (model-checks.ts). */
  hiddenModels: z.array(z.object({ model: z.string().min(1).max(200), status: z.number().int(), reason: z.string().max(300).nullable(), since: isoSchema.nullable() })
    .strict()).optional()
}).strict();

export const gatewayApiKeyLimitSchema = z.object({
  limitType: gatewayLimitTypeSchema,
  limitWindow: gatewayLimitWindowSchema,
  maxValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currentValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  modelFilter: z.string().max(120).nullable(),
  resetAt: isoSchema
}).strict();

export const gatewayApiKeySchema = z.object({
  id: gatewayIdSchema,
  name: z.string().min(1).max(120),
  keyPrefix: z.string().min(4).max(20),
  isActive: z.boolean(),
  trafficClass: gatewayTrafficClassSchema,
  allowedModels: z.array(z.string().min(1).max(120)).max(100),
  enforcedModel: z.string().max(120).nullable(),
  allowedReasoningEfforts: z.array(gatewayReasoningEffortSchema).max(8),
  enforcedReasoningEffort: gatewayReasoningEffortSchema.nullable(),
  accountScopeEnabled: z.boolean(),
  accountIds: z.array(gatewayIdSchema).max(500),
  compressionOverride: gatewayCompressionModeSchema.nullable(),
  /** Overrides the provider's output policy for this key (OFF keeps Space's own jobs out of it); null follows the provider. */
  outputPolicyOverride: gatewayOutputPolicySchema.nullable(),
  limits: z.array(gatewayApiKeyLimitSchema).max(20),
  expiresAt: isoSchema.nullable(),
  lastUsedAt: isoSchema.nullable(),
  createdAt: isoSchema
}).strict();

export const gatewayApiKeyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trafficClass: gatewayTrafficClassSchema.default("INTERACTIVE"),
  allowedModels: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  enforcedModel: z.string().trim().min(1).max(120).nullable().default(null),
  allowedReasoningEfforts: z.array(gatewayReasoningEffortSchema).max(8).default([]),
  enforcedReasoningEffort: gatewayReasoningEffortSchema.nullable().default(null),
  accountIds: z.array(gatewayIdSchema).max(500).default([]),
  compressionOverride: gatewayCompressionModeSchema.nullable().default(null),
  outputPolicyOverride: gatewayOutputPolicySchema.nullable().default(null),
  limits: z.array(z.object({
    limitType: gatewayLimitTypeSchema,
    limitWindow: gatewayLimitWindowSchema,
    maxValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    modelFilter: z.string().trim().min(1).max(120).nullable().default(null)
  }).strict()).max(20).default([]),
  expiresAt: isoSchema.nullable().default(null)
}).strict();

const gatewayApiKeyLimitInputSchema = z.object({
  limitType: gatewayLimitTypeSchema,
  limitWindow: gatewayLimitWindowSchema,
  /** COST_USD limits are micro-dollars. */
  maxValue: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  modelFilter: z.string().trim().min(1).max(120).nullable().default(null)
}).strict();

/**
 * Changes a key. `accountIds` and `limits` replace the current sets; a limit with the same type, window and model
 * filter keeps its usage unless `resetUsage` is set.
 */
export const gatewayApiKeyUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  trafficClass: gatewayTrafficClassSchema.optional(),
  allowedModels: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  enforcedModel: z.string().trim().min(1).max(120).nullable().optional(),
  allowedReasoningEfforts: z.array(gatewayReasoningEffortSchema).max(8).optional(),
  enforcedReasoningEffort: gatewayReasoningEffortSchema.nullable().optional(),
  accountIds: z.array(gatewayIdSchema).max(500).optional(),
  compressionOverride: gatewayCompressionModeSchema.nullable().optional(),
  outputPolicyOverride: gatewayOutputPolicySchema.nullable().optional(),
  limits: z.array(gatewayApiKeyLimitInputSchema).max(20).optional(),
  expiresAt: isoSchema.nullable().optional(),
  resetUsage: z.boolean().optional()
}).strict().refine(...atLeastOneField("Nothing to update."));

/** Operator preferences of an account; `paused` pauses or resumes it. An empty alias clears it. */
export const gatewayAccountUpdateRequestSchema = z.object({
  paused: z.boolean().optional(),
  alias: z.string().trim().max(80).nullable().optional().transform((value) => (value === "" ? null : value)),
  warmupEnabled: z.boolean().optional()
}).strict().refine(...atLeastOneField("Nothing to update."));

/** The plain key is returned exactly once, at creation. */
export const gatewayApiKeyCreatedResponseSchema = z.object({
  key: gatewayApiKeySchema,
  plainKey: z.string().regex(/^sk-sgw-[A-Za-z0-9_-]{32,64}$/)
}).strict();

export const gatewaySettingsSchema = z.object({
  routingStrategy: gatewayRoutingStrategySchema,
  stickyThreadsEnabled: z.boolean(),
  preferEarlierReset: z.boolean(),
  planPriority: z.array(z.string().min(1).max(40)).max(20),
  stickyReallocationBudgetThresholdPercent: z.number().min(0).max(100),
  exhaustionFloorPercent: z.number().min(0).max(50),
  /** Fill first: % of the last available Claude subscription account's 5-hour window kept for Nous's OPERATOR and DECISION turns (default 20, 0 off). */
  claudeReservePercent: z.number().min(0).max(100),
  /**
   * How new work picks a Claude Max or Codex subscription account (operator 3/11 13:09 BKK). FILL_FIRST: one account until
   * about 93% of its 5 hours, then the next, so the resets come apart; fresh windows open in weekly use-it-or-lose-it order,
   * none past 95% of its week unless it resets within 24 h, and the Claude account with most room is kept for Nous's OPERATOR and DECISION turns.
   * WEEKLY_PACE: the account furthest under its weekly pace (2026-10-27).
   */
  subscriptionRouting: z.enum(["FILL_FIRST", "WEEKLY_PACE"]),
  compressionMode: gatewayCompressionModeSchema,
  compressionProfile: gatewayCompressionProfileSchema,
  /** Code and prose compression (lossless folds, CodeAware, TextCrusher); ON applies while compressionMode is ON. */
  compressionCodeText: gatewayCompressionModeSchema,
  compressionTimeBudgetMs: z.number().int().min(10).max(5000),
  /**
   * Per-provider compression and output policy over the settings above (an update replaces the whole object). A
   * key's compression override still wins for the mode.
   */
  compressionProviders: gatewayCompressionProvidersSchema,
  requestLogRetentionDays: z.number().int().min(1).max(365),
  /** Display preferences for the admin views. */
  displayTimeFormat: gatewayTimeFormatSchema,
  displayAccountWindows: gatewayWindowChoiceSchema,
  displayBurnProjection: z.boolean(),
  /** How Codex streams are carried upstream; DEFAULT is the gateway's own choice (HTTP until WebSocket ships). */
  upstreamStreamTransport: gatewayStreamTransportSchema,
  /** How long a prompt cache key stays on the account that served it. */
  promptCacheTtlSeconds: z.number().int().min(60).max(7 * 86_400),
  /** An imported sign-in never replaces an account with the same email but a different upstream account. */
  importWithoutOverwrite: z.boolean(),
  /**
   * Claude API key fallback: when every pooled Claude account is out of quota, requests go through a Claude API-key
   * account (paid per token); the accounts take over again at their next reset. Off: the key is never used. Claude Code never
   * uses it (operator rule 2026-10-27).
   */
  claudeApiKeyFallback: z.boolean(),
  /** Nous's "Space" provider tries these routes in this order (GATEWAY_PROVIDER_ROUTES); an update replaces the whole list. */
  providerOrder: gatewayProviderOrderSchema,
  /**
   * What the operator may spend on the Anthropic API each month (operator request 2026-10-24); the Claude API-key account
   * shows this month's Anthropic bill as a share of it. Null: not set.
   */
  anthropicMonthlyBudgetUsd: z.number().positive().max(10_000_000).nullable(),
  /**
   * The organization's Claude Console credit grants in total (operator request 2026-10-24); the API providers tab shows
   * them minus Anthropic's recorded bill, as the Console's remaining balance. Null: not set.
   */
  anthropicCreditsUsd: z.number().positive().max(10_000_000).nullable(),
  /** Limit warm-up: one tiny request right after a confirmed window reset, so the next window starts counting at once. */
  warmupEnabled: z.boolean(),
  warmupWindows: gatewayWindowChoiceSchema,
  warmupModel: z.string().trim().min(1).max(128),
  warmupPrompt: z.string().trim().min(1).max(512),
  warmupCooldownSeconds: z.number().int().min(60).max(7 * 86_400),
  warmupMinAvailablePercent: z.number().gt(0).max(100),
  /** LAN listener: ENV follows the install root's .env; OFF and ON override it. Applied by a reload. */
  lanMode: gatewayLanModeSchema,
  lanHost: z.string().trim().min(7).max(45).nullable(),
  lanPort: z.number().int().min(1024).max(65535).nullable(),
  lanAllowedSources: z.array(z.string().trim().min(7).max(49)).max(20),
  updatedAt: isoSchema
}).strict();

export const gatewaySettingsUpdateRequestSchema = gatewaySettingsSchema.omit({ updatedAt: true }).partial().strict()
  .refine(...atLeastOneField("Nothing to update."));

export const gatewayRequestLogSchema = z.object({
  id: z.string().max(80),
  requestId: z.string().max(120),
  requestedAt: isoSchema,
  provider: gatewayProviderSchema,
  accountId: gatewayIdSchema.nullable(),
  apiKeyId: gatewayIdSchema.nullable(),
  model: z.string().max(160),
  reasoningEffort: z.string().max(20).nullable(),
  serviceTier: z.string().max(40).nullable(),
  transport: z.string().max(40).nullable(),
  status: z.string().max(40),
  errorCode: z.string().max(120).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  firstTokenMs: z.number().int().min(0).nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  cachedInputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  reasoningTokens: z.number().int().min(0).nullable(),
  costUsd: z.number().min(0).nullable(),
  compressionTokensSaved: z.number().int().min(0).nullable(),
  stickyKind: z.string().max(40).nullable(),
  stickyKeyHash: z.string().max(16).nullable(),
  planType: z.string().max(40).nullable(),
  requestedServiceTier: z.string().max(40).nullable(),
  upstreamTransport: z.string().max(40).nullable(),
  errorMessage: z.string().max(1000).nullable(),
  stickyKeySource: z.string().max(40).nullable(),
  /** Prompt-cache writes (Anthropic `cache_creation_input_tokens`). */
  cacheCreationTokens: z.number().int().min(0).nullable(),
  /** The client program, detected from the user agent (Codex CLI, Claude Code, ...). */
  clientName: z.string().max(80).nullable(),
  /** The project a request belongs to, from the `x-space-project` header. */
  project: z.string().max(200).nullable(),
  /** Context tokens before and after compression, when compression ran. */
  compressionTokensBefore: z.number().int().min(0).nullable(),
  compressionTokensAfter: z.number().int().min(0).nullable(),
  /** `limit_warmup` for the gateway's own warm-up requests, which statistics leave out; null for client traffic. */
  source: z.string().max(40).nullable(),
  /** A Claude request on a continuing conversation that rewrote more than half of its prompt cache (Headroom's bust rule). */
  cacheBust: z.boolean().nullable(),
  /** Which compressors changed the request and the waste signals found in its tool output (tokens). */
  compressionDetail: z.object({
    strategies: z.array(z.string().max(40)).max(10),
    waste: z.record(z.string().max(40), z.number().int().min(0)),
    /** The output policy the gateway added to the request's system prompt, when one was. */
    outputPolicy: gatewayOutputPolicySchema.optional()
  }).strict().nullable(),
  /** The Anthropic `request-id` of a Claude request; Claude Code stores it as the message's `requestId`. */
  upstreamRequestId: z.string().max(120).nullable().optional()
}).strict();

export const gatewayRequestLogListSchema = z.object({
  data: z.array(gatewayRequestLogSchema).max(500),
  nextCursor: z.string().max(200).nullable()
}).strict();

/** How a request ended, for filters and error rates. */
export const gatewayLogStatusCategorySchema = z.enum(["SUCCESS", "RATE_LIMITED", "QUOTA", "CLIENT_CLOSED", "ERROR"]);

export const gatewayRequestLogFilterSchema = z.object({
  /** Request id, account, key, model, client or error. */
  q: z.string().trim().min(1).max(200).optional(),
  from: isoSchema.optional(),
  to: isoSchema.optional(),
  accountIds: z.array(gatewayIdSchema).max(100).optional(),
  apiKeyIds: z.array(gatewayIdSchema).max(100).optional(),
  models: z.array(z.string().min(1).max(160)).max(100).optional(),
  providers: z.array(gatewayProviderSchema).max(20).optional(),
  statuses: z.array(gatewayLogStatusCategorySchema).max(5).optional(),
  clients: z.array(z.string().min(1).max(80)).max(50).optional()
}).strict();

const gatewayFacetSchema = z.object({ value: z.string().max(200), count: z.number().int().min(0) }).strict();

/** The values present in a time range, with counts, for the request log filters. */
export const gatewayRequestLogFacetsSchema = z.object({
  models: z.array(gatewayFacetSchema).max(500),
  providers: z.array(gatewayFacetSchema).max(20),
  statuses: z.array(gatewayFacetSchema).max(5),
  accounts: z.array(gatewayFacetSchema).max(1000),
  apiKeys: z.array(gatewayFacetSchema).max(1000),
  clients: z.array(gatewayFacetSchema).max(100)
}).strict();

const gatewayTimingSchema = z.object({
  samples: z.number().int().min(0),
  averageMs: z.number().min(0).nullable(),
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable()
}).strict();

/** Request-log totals for one group (a model, an account, a day, ...). Latency counts successful requests only. */
export const gatewayUsageAggregateSchema = z.object({
  key: z.string().max(200),
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  rateLimited: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  cacheCreationTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  compressionTokensSaved: z.number().int().min(0),
  latency: gatewayTimingSchema,
  ttft: gatewayTimingSchema,
  lastAt: isoSchema.nullable()
}).strict();

export const gatewayServiceStateSchema = z.enum(["RUNNING", "DRAINING", "UNREACHABLE", "NOT_INSTALLED"]);

/**
 * The Claude API key account of Space Gateway and what went through it (operator request 2026-10-13: the key must
 * never serve while a subscription account can). Polled by the ADMIN rail to raise an alert on first use.
 */
export const gatewayClaudeApiKeyUseSchema = z.object({
  fallbackEnabled: z.boolean(),
  account: z.object({
    id: gatewayIdSchema,
    label: z.string().max(200),
    status: gatewayAccountStatusSchema,
    createdAt: isoSchema,
    lastUsedAt: isoSchema.nullable(),
    requests: z.number().int().min(0),
    costUsd: z.number().min(0)
  }).strict().nullable(),
  checkedAt: isoSchema
}).strict();

/** An Anthropic API key behind a Claude API-key account, as the Admin API names it. */
export const gatewayAnthropicUpstreamKeySchema = z.object({
  accountId: gatewayIdSchema,
  apiKeyId: z.string().max(120),
  keyName: z.string().max(200),
  /** Empty for the organization's default workspace (the reports' `workspace_id: null`). */
  workspaceId: z.string().max(120)
}).strict();

/**
 * The operator's Anthropic Admin API key (operator request 2026-10-18): sealed by Space Gateway, never returned; only
 * its hint and the last sync of the organization's cost and usage reports.
 */
export const gatewayAnthropicAdminStatusSchema = z.object({
  configured: z.boolean(),
  keyHint: z.string().max(40).nullable(),
  savedAt: isoSchema.nullable(),
  lastSyncAt: isoSchema.nullable(),
  lastError: z.string().max(300).nullable(),
  upstream: z.array(gatewayAnthropicUpstreamKeySchema).max(20)
}).strict();

export const gatewayAnthropicAdminKeySaveRequestSchema = z.object({
  adminKey: z.string().trim().regex(/^sk-ant-admin01-[A-Za-z0-9_-]{20,300}$/, "This does not look like an Anthropic Admin API key (sk-ant-admin01-...).")
}).strict();

const gatewayAnthropicBillingModelSchema = z.object({
  model: z.string().max(160),
  /** Anthropic's token charge for the model in the gateway keys' workspaces. */
  billedUsd: z.number().min(0),
  /** The same tokens (Anthropic's counts) at Space Gateway's list prices. */
  listUsd: z.number().min(0),
  /** billed / list over the 7 days ending this day (what the caps use); null while too little was used to tell. */
  factor: z.number().min(0).nullable(),
  gatewayEstimateUsd: z.number().min(0),
  gatewayBilledUsd: z.number().min(0)
}).strict();

/** One UTC day of the Anthropic bill next to Space Gateway's estimate for its Claude API-key accounts. */
export const gatewayAnthropicBillingDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Anthropic has posted this day's cost; until then its charges read 0 and the caps use the last 7 days' factor. */
  reported: z.boolean(),
  /** Every workspace and cost type of the organization. */
  organizationUsd: z.number().min(0),
  /** Charges of the workspaces the gateway's Claude API keys belong to (their other users included). */
  workspaceUsd: z.number().min(0),
  /** What Space Gateway estimated at list prices for its Claude API-key accounts. */
  gatewayEstimateUsd: z.number().min(0),
  /** The estimate times each model's factor: what the daily COST_USD caps count. */
  gatewayBilledUsd: z.number().min(0),
  models: z.array(gatewayAnthropicBillingModelSchema).max(50)
}).strict();

export const gatewayAnthropicBillingReportSchema = z.object({
  status: gatewayAnthropicAdminStatusSchema,
  days: z.array(gatewayAnthropicBillingDaySchema).max(31)
}).strict();

/** The Claude API-key account's pace to the monthly budget (Space Gateway, plan clipboard:nUloPOH3blDT step 6). */
export const gatewayApiBudgetPaceSchema = z.object({
  budgetUsd: z.number().min(0),
  monthSpentUsd: z.number().min(0),
  remainingUsd: z.number(),
  daysLeft: z.number().int().min(1).max(31),
  allowanceTodayUsd: z.number().min(0),
  todaySpentUsd: z.number().min(0),
  stop: z.enum(["MONTHLY_BUDGET_REACHED", "DAILY_ALLOWANCE_REACHED"]).nullable()
}).strict();
export type GatewayApiBudgetPace = z.infer<typeof gatewayApiBudgetPaceSchema>;

export const gatewayStatusSchema = z.object({
  service: z.object({
    state: gatewayServiceStateSchema,
    version: z.string().max(80).nullable(),
    startedAt: isoSchema.nullable(),
    inFlightRequests: z.number().int().min(0).nullable(),
    listen: z.string().max(120).nullable(),
    error: z.string().max(500).nullable()
  }).strict(),
  accounts: z.object({
    total: z.number().int().min(0),
    active: z.number().int().min(0),
    byProvider: z.array(z.object({ provider: gatewayProviderSchema, total: z.number().int().min(0), active: z.number().int().min(0) }).strict()).max(20)
  }).strict(),
  apiKeys: z.object({ total: z.number().int().min(0), active: z.number().int().min(0) }).strict(),
  last24h: z.object({
    requests: z.number().int().min(0),
    errors: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.number().min(0),
    compressionTokensSaved: z.number().int().min(0)
  }).strict(),
  settings: gatewaySettingsSchema,
  /** Null without a monthly budget or without Anthropic billing; absent from older gateways. */
  apiBudget: gatewayApiBudgetPaceSchema.nullable().optional(),
  checkedAt: isoSchema
}).strict();

export const gatewayReportRowSchema = z.object({
  key: z.string().max(200),
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
  reasoningReported: z.number().int().min(0),
  costUsd: z.number().min(0),
  compressionTokensSaved: z.number().int().min(0),
  /** 429 refusals (rate or usage limit), from the daily savings rollups: days, models, providers and totals; accounts have none. */
  rateLimited: z.number().int().min(0).optional()
}).strict();

const reportDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lostAmount = { lostPercent: z.number().min(0), lostTokens: z.number().int().min(0), lostCostUsd: z.number().min(0),
  /** Windows lost without a measured rate (no gateway traffic that week or any other): their tokens and value are not in the sums. */
  unpriced: z.number().int().min(0) };

/** One past weekly window of an account (or quota group): the share unused at its reset, in tokens and API value at the account's measured rate. */
export const gatewayLostWindowSchema = z.object({
  accountId: gatewayIdSchema,
  label: z.string().max(120),
  provider: gatewayProviderSchema,
  planType: z.string().max(40).nullable(),
  quotaKey: z.string().max(80),
  /** The UTC Monday of the reset's week. */
  week: reportDaySchema,
  resetAt: isoSchema,
  lastSampleAt: isoSchema,
  usedPercent: z.number().min(0).max(100),
  lostPercent: z.number().min(0).max(100),
  /** Tokens (input with cache, plus output) and API value per 1 % of the window; null without traffic to measure it. */
  tokensPerPercent: z.number().min(0).nullable(),
  costUsdPerPercent: z.number().min(0).nullable(),
  /** "own": the window's own 7 days; "nearest": the account's nearest measured window; null: unpriced. */
  rateFrom: z.enum(["own", "nearest"]).nullable(),
  lostTokens: z.number().int().min(0).nullable(),
  lostCostUsd: z.number().min(0).nullable()
}).strict();

export const gatewayLostTokensSchema = z.object({
  from: reportDaySchema,
  to: reportDaySchema,
  windows: z.array(gatewayLostWindowSchema),
  /** Per week and provider, oldest first. */
  weeks: z.array(z.object({ week: reportDaySchema, provider: gatewayProviderSchema, windows: z.number().int().min(0), ...lostAmount }).strict()),
  totals: z.object({ windows: z.number().int().min(0), ...lostAmount,
    /** Past resets left out: no sample within 6 hours before them (an account no longer polled), so what was unused is unknown. */
    unobserved: z.number().int().min(0) }).strict()
}).strict();

export const gatewayReportSchema = z.object({
  from: reportDaySchema,
  to: reportDaySchema,
  days: z.array(gatewayReportRowSchema).max(400),
  models: z.array(gatewayReportRowSchema).max(500),
  accounts: z.array(gatewayReportRowSchema).max(1000),
  providers: z.array(gatewayReportRowSchema),
  totals: gatewayReportRowSchema,
  /** Space-pool requests one provider refused and another was tried for (one request id logged on both). */
  fallbacks: z.array(z.object({ fromProvider: z.string().max(40), toProvider: z.string().max(40), requests: z.number().int().min(0),
    served: z.number().int().min(0) }).strict()),
  /** Every account's (and quota group's) 5-hour and weekly windows now: used share and reset time. */
  windows: z.array(z.object({ accountId: gatewayIdSchema, label: z.string().max(120), provider: gatewayProviderSchema, status: gatewayAccountStatusSchema,
    quotaKey: z.string().max(80), primary: gatewayUsageWindowSchema, secondary: gatewayUsageWindowSchema }).strict()),
  lost: gatewayLostTokensSchema
}).strict();

const gatewayCompressionTotalsSchema = z.object({
  requests: z.number().int().min(0),
  modifiedRequests: z.number().int().min(0),
  blocks: z.number().int().min(0),
  rejectedBlocks: z.number().int().min(0),
  errorBlocks: z.number().int().min(0),
  timedOut: z.number().int().min(0),
  originalTokens: z.number().int().min(0),
  compressedTokens: z.number().int().min(0),
  tokensSaved: z.number().int().min(0),
  savingsPercent: z.number().min(0).max(100),
  averageOverheadMs: z.number().min(0),
  maxOverheadMs: z.number().min(0)
}).strict();

/** Compression statistics (Headroom-equivalent) over a window, for applied (ON) and measured-only (SHADOW) traffic. */
export const gatewayCompressionStatsSchema = z.object({
  hours: z.number().int().min(1).max(24 * 90),
  applied: gatewayCompressionTotalsSchema,
  shadow: gatewayCompressionTotalsSchema,
  /** Applied compression per provider. */
  byProvider: z.array(z.object({ provider: z.string().max(40), requests: z.number().int().min(0), modifiedRequests: z.number().int().min(0),
    originalTokens: z.number().int().min(0), compressedTokens: z.number().int().min(0), tokensSaved: z.number().int().min(0),
    savingsPercent: z.number().min(0).max(100) }).strict()).max(20),
  byStrategy: z.array(z.object({ mode: z.enum(["SHADOW", "ON"]), strategy: z.string().max(40), blocks: z.number().int().min(0),
    rejectedBlocks: z.number().int().min(0), errorBlocks: z.number().int().min(0), tokensSaved: z.number().int().min(0),
    savingsPercent: z.number().min(0).max(100) }).strict()).max(40),
  history: z.array(z.object({ hour: isoSchema, appliedSaved: z.number().int().min(0), shadowSaved: z.number().int().min(0),
    requests: z.number().int().min(0) }).strict()).max(24 * 90)
}).strict();

export const gatewayDashboardRangeSchema = z.enum(["24h", "7d", "28d"]);
/** codex-lb latency states: ok, degraded (over a threshold or 5% errors), unavailable (no sample), stale (old sample). */
export const gatewaySignalStatusSchema = z.enum(["OK", "DEGRADED", "UNAVAILABLE", "STALE"]);

const gatewayErrorSummarySchema = z.object({
  minutes: z.number().int().min(1),
  requests: z.number().int().min(0),
  errors: z.number().int().min(0),
  errorRate: z.number().min(0).max(1).nullable(),
  topError: z.object({ code: z.string().max(120), count: z.number().int().min(0) }).strict().nullable()
}).strict();

/** One account in a capacity pool, in Plus-equivalent credits (Plus = 1, Pro Lite = 5, Pro = 20 per window). */
export const gatewayPoolAccountSchema = z.object({
  accountId: gatewayIdSchema,
  label: z.string().max(120),
  planType: z.string().max(40).nullable(),
  status: gatewayAccountStatusSchema,
  capacityCredits: z.number().min(0),
  remainingCredits: z.number().min(0),
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetAt: isoSchema.nullable()
}).strict();

export const gatewayPoolWindowSchema = z.object({
  capacityCredits: z.number().min(0),
  remainingCredits: z.number().min(0),
  remainingPercent: z.number().min(0).max(100).nullable(),
  /** The earliest reset among the pool's accounts. */
  resetAt: isoSchema.nullable(),
  /** Projected account-equivalents used by the end of the window at the current pace (codex-lb burn projection). */
  burnAccounts: z.number().min(0).nullable(),
  accounts: z.array(gatewayPoolAccountSchema).max(1000)
}).strict();

export const gatewayPoolSchema = z.object({
  provider: gatewayProviderSchema,
  accounts: z.number().int().min(0),
  primary: gatewayPoolWindowSchema,
  secondary: gatewayPoolWindowSchema
}).strict();

export const gatewayLatencyRowSchema = z.object({
  key: z.string().max(400),
  label: z.string().max(200),
  provider: gatewayProviderSchema.nullable(),
  model: z.string().max(160).nullable(),
  serviceTier: z.string().max(40).nullable(),
  apiKeyId: gatewayIdSchema.nullable(),
  samples: z.number().int().min(0),
  errors: z.number().int().min(0),
  errorRate: z.number().min(0).max(1),
  averageMs: z.number().min(0).nullable(),
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable(),
  ttftP50Ms: z.number().min(0).nullable(),
  ttftP95Ms: z.number().min(0).nullable(),
  status: gatewaySignalStatusSchema,
  detail: z.string().max(200)
}).strict();

export const gatewayLiveAccountSchema = z.object({
  accountId: gatewayIdSchema,
  label: z.string().max(120),
  planType: z.string().max(40).nullable(),
  provider: gatewayProviderSchema,
  /** Requests in flight now (from the gateway), or null when the gateway does not report it. */
  activeRequests: z.number().int().min(0).nullable(),
  requests: z.number().int().min(0),
  tokens: z.number().int().min(0),
  lastAt: isoSchema.nullable(),
  model: z.string().max(160).nullable(),
  transport: z.string().max(40).nullable(),
  state: z.enum(["LIVE", "RECENT"])
}).strict();

/** The Dashboard: everything codex-lb's dashboard shows, over 24 hours, 7 days or 28 days. */
export const gatewayDashboardSchema = z.object({
  range: gatewayDashboardRangeSchema,
  from: isoSchema,
  to: isoSchema,
  bucketSeconds: z.number().int().min(60),
  generatedAt: isoSchema,
  totals: gatewayUsageAggregateSchema,
  /** Average per day (7d, 28d) or per hour (24h). */
  perPeriod: z.object({ unit: z.enum(["hour", "day"]), requests: z.number().min(0), costUsd: z.number().min(0), tokens: z.number().min(0) }).strict(),
  errorRate: gatewayErrorSummarySchema,
  errorRate7d: gatewayErrorSummarySchema,
  errorRate5m: gatewayErrorSummarySchema,
  trend: z.array(z.object({ t: isoSchema, requests: z.number().int().min(0), errors: z.number().int().min(0), tokens: z.number().int().min(0),
    costUsd: z.number().min(0) }).strict()).max(200),
  topKeys: z.array(z.object({ apiKeyId: z.string().max(80), name: z.string().max(120), requests: z.number().int().min(0), costUsd: z.number().min(0) }).strict()).max(6),
  topModels: z.array(z.object({ model: z.string().max(200), requests: z.number().int().min(0), costUsd: z.number().min(0) }).strict()).max(6),
  latencyByModel: z.array(gatewayLatencyRowSchema).max(20),
  routes: z.array(gatewayLatencyRowSchema).max(20),
  pools: z.array(gatewayPoolSchema).max(20),
  live: z.array(gatewayLiveAccountSchema).max(50),
  recent: z.array(gatewayRequestLogSchema).max(20)
}).strict();

/** Health signals: each keeps its last 30 samples (now, p50, p95). */
export const gatewayHealthSignalSchema = z.object({
  key: z.enum(["gateway", "database", "upstream", "lan", "internet", "compression"]),
  label: z.string().max(80),
  status: gatewaySignalStatusSchema,
  nowMs: z.number().min(0).nullable(),
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable(),
  samples: z.number().int().min(0),
  sparkline: z.array(z.number().min(0)).max(30),
  warnMs: z.number().min(0).nullable(),
  criticalMs: z.number().min(0).nullable(),
  detail: z.string().max(300),
  updatedAt: isoSchema.nullable()
}).strict();

export const gatewayHealthSchema = z.object({
  signals: z.array(gatewayHealthSignalSchema).max(10),
  generatedAt: isoSchema
}).strict();

const gatewayTotalsSchema = z.object({
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0)
}).strict();

const gatewayTrendPointSchema = z.object({ t: isoSchema, value: z.number().min(0).max(100) }).strict();

export const gatewayAccountDetailSchema = z.object({
  account: gatewayAccountSchema,
  /** All requests ever served (daily rollups), and the last 7 days (request logs). */
  lifetime: gatewayTotalsSchema,
  last7d: gatewayUsageAggregateSchema,
  /** Remaining percent per hour over 7 days; `secondaryScheduled` is the even-burn weekly plan line. */
  trend: z.object({
    primary: z.array(gatewayTrendPointSchema).max(200),
    secondary: z.array(gatewayTrendPointSchema).max(200),
    secondaryScheduled: z.array(gatewayTrendPointSchema).max(200)
  }).strict(),
  tokenStatus: z.object({
    accessExpiresAt: isoSchema.nullable(),
    /** null when the gateway did not answer (it alone can read the sign-in). */
    refreshStored: z.boolean().nullable(),
    idTokenParsed: z.boolean().nullable(),
    lastRefreshAt: isoSchema.nullable(),
    source: z.string().max(40)
  }).strict(),
  lastWarmup: z.object({
    window: z.enum(["PRIMARY", "SECONDARY"]),
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "SKIPPED"]),
    model: z.string().max(160).nullable(),
    attemptedAt: isoSchema,
    errorCode: z.string().max(120).nullable()
  }).strict().nullable()
}).strict();

export const gatewayApiKeyDetailSchema = z.object({
  key: gatewayApiKeySchema,
  lifetime: gatewayTotalsSchema,
  last7d: gatewayUsageAggregateSchema,
  costByAccount: z.array(z.object({ accountId: z.string().max(80), label: z.string().max(120), requests: z.number().int().min(0),
    costUsd: z.number().min(0), deleted: z.boolean() }).strict()).max(1000),
  /** Hourly tokens and cost over 7 days. */
  trend: z.array(z.object({ t: isoSchema, tokens: z.number().int().min(0), costUsd: z.number().min(0), requests: z.number().int().min(0) }).strict()).max(200),
  pooled: z.object({ primaryRemainingPercent: z.number().min(0).max(100).nullable(), secondaryRemainingPercent: z.number().min(0).max(100).nullable(),
    accounts: z.number().int().min(0) }).strict()
}).strict();

const count = z.number().int().min(0);
const amount = z.number().min(0);
const percentValue = z.number().min(0).max(100);
const msTiming = z.object({ averageMs: amount.nullable(), p50Ms: amount.nullable(), p95Ms: amount.nullable(), minMs: amount.nullable(), maxMs: amount.nullable(), samples: count }).strict();

export const gatewayHeadroomRequestsSchema = z.object({ total: count, completed: count, failed: count, rateLimited: count, cached: count }).strict();

/** Prompt-cache impact, after Headroom: token-level hit rate, busts, and dollars at each provider's cache prices. */
export const gatewayPrefixCacheSchema = z.object({
  requests: count,
  hitRequests: count,
  readTokens: count,
  writeTokens: count,
  uncachedTokens: count,
  hitRatePercent: percentValue,
  busts: count,
  bustTokens: count,
  savedUsd: amount,
  writePremiumUsd: amount,
  netUsd: z.number(),
  byProvider: z.array(z.object({ provider: z.string().max(40), requests: count, readTokens: count, writeTokens: count, readDiscountPercent: percentValue,
    writePremiumPercent: amount, busts: count, netUsd: z.number() }).strict()).max(20),
  /** Why a conversation that had a cache read none the next time (kept request logs). */
  misses: z.object({ ttlExpiry: count, accountSwitch: count, prefixChange: count }).strict()
}).strict();

const gatewayClientUsageSchema = z.object({
  key: z.string().max(200), requests: count, beforeTokens: count, afterTokens: count, savedTokens: count, outputTokens: count,
  savingsPercent: percentValue, shareOfSavedPercent: percentValue, shareOfRequestsPercent: percentValue
}).strict();

const gatewayModelSavingsSchema = z.object({ model: z.string().max(160), requests: count, savedTokens: count, sentTokens: count, reductionPercent: percentValue }).strict();

/** Headroom's Session view: since the current gateway worker started. */
export const gatewayHeadroomSessionSchema = z.object({
  since: isoSchema.nullable(),
  generatedAt: isoSchema,
  compressionMode: gatewayCompressionModeSchema,
  /** True when only the newest requests were read (very long sessions). */
  sampled: z.boolean(),
  requests: gatewayHeadroomRequestsSchema,
  live: z.object({ activeRequests: count, activeWebSockets: count, relayTasks: count, compressionQueue: count }).strict().nullable(),
  tokens: z.object({
    input: count, output: count, cachedInput: count, cacheWrites: count, compressedBefore: count, compressedAfter: count, saved: count, shadowSaved: count,
    /** Saved tokens out of all input before compression. */
    savingsPercent: percentValue,
    /** Saved tokens out of the tool output that compression worked on. */
    activeSavingsPercent: percentValue
  }).strict(),
  performance: z.object({
    overhead: msTiming,
    ttfb: msTiming,
    latency: msTiming,
    /** Tokens per second: input forwarded per request second, and output per generation second (after the first token). */
    throughput: z.object({ forwardP50: amount.nullable(), forwardP95: amount.nullable(), generationP50: amount.nullable(), generationP95: amount.nullable() }).strict(),
    stages: z.array(z.object({ name: z.string().max(60), runs: count, averageMs: amount, maxMs: amount }).strict()).max(40)
  }).strict(),
  waste: z.array(z.object({ name: z.string().max(40), tokens: count }).strict()).max(20),
  savingsOverTime: z.array(z.object({ t: isoSchema, saved: count, shadowSaved: count, requests: count }).strict()).max(24 * 31),
  prefixCache: gatewayPrefixCacheSchema,
  compressionVsCache: z.object({ savedTokens: count, lostToBustTokens: count, netTokens: z.number().int() }).strict(),
  agents: z.array(gatewayClientUsageSchema).max(100),
  providers: z.array(z.object({ provider: z.string().max(40), requests: count }).strict()).max(20),
  models: z.array(gatewayModelSavingsSchema).max(100),
  recent: z.array(gatewayRequestLogSchema).max(25),
  rateLimits: z.array(z.object({ accountId: gatewayIdSchema, label: z.string().max(120), planType: z.string().max(40).nullable(), primary: gatewayUsageWindowSchema,
    secondary: gatewayUsageWindowSchema, resetCredits: count.nullable() }).strict()).max(200),
  poolWeekly: z.object({ remainingPercent: percentValue.nullable(), remainingCredits: amount, capacityCredits: amount, resetAt: isoSchema.nullable() }).strict().nullable()
}).strict();

/** Headroom's Lifetime view: everything recorded, from the daily rollups. */
export const gatewayHeadroomLifetimeSchema = z.object({
  since: z.string().max(10).nullable(),
  generatedAt: isoSchema,
  requests: gatewayHeadroomRequestsSchema,
  tokens: z.object({ input: count, output: count, attemptedInput: count, saved: count, shadowSaved: count, savingsPercent: percentValue.nullable() }).strict(),
  cost: z.object({ apiCostUsd: amount, compressionSavedUsd: amount, cacheSavedUsd: amount, unpricedRequests: count }).strict(),
  prefixCache: z.object({ requests: count, cachedRequests: count, hitRatePercent: percentValue.nullable(), readTokens: count, writeTokens: count, busts: count,
    bustTokens: count, ttlMinutes: count }).strict(),
  misses: z.object({ ttlExpiry: count, accountSwitch: count, prefixChange: count }).strict(),
  waste: z.array(z.object({ name: z.string().max(40), tokens: count }).strict()).max(20),
  providers: z.array(z.object({ provider: z.string().max(40), requests: count, inputTokens: count, outputTokens: count, savedTokens: count }).strict()).max(20),
  clients: z.array(gatewayClientUsageSchema).max(100),
  models: z.array(z.object({ model: z.string().max(160), requests: count, inputTokens: count, outputTokens: count, savedTokens: count }).strict()).max(101),
  projects: z.array(z.object({ project: z.string().max(200), requests: count, savedTokens: count, savedUsd: amount, inputTokens: count, inputCostUsd: amount,
    lastDay: z.string().max(10), savingsPercent: percentValue }).strict()).max(50)
}).strict();

export const gatewayHistorySeriesSchema = z.enum(["daily", "weekly", "monthly"]);

const gatewayHistoryBucketSchema = z.object({
  key: z.string().max(10),
  savedTokens: count, savedUsd: amount, inputTokens: count, apiCostUsd: amount, requests: count,
  cumulativeSavedTokens: count, cumulativeSavedUsd: amount, cumulativeApiCostUsd: amount,
  byModel: z.array(z.object({ model: z.string().max(160), savedTokens: count, savedUsd: amount, apiCostUsd: amount }).strict()).max(6)
}).strict();

/** Headroom's Historical view: savings by day, week (Monday) and month. */
export const gatewayHeadroomHistorySchema = z.object({
  generatedAt: isoSchema,
  lifetime: z.object({ savedTokens: count, savedUsd: amount, activeDays: count, averagePerDay: amount, averagePerWeek: amount, averagePerMonth: amount }).strict(),
  series: z.object({ daily: z.array(gatewayHistoryBucketSchema).max(4000), weekly: z.array(gatewayHistoryBucketSchema).max(600), monthly: z.array(gatewayHistoryBucketSchema).max(150) }).strict(),
  models: z.array(z.object({ model: z.string().max(160), savedTokens: count, apiCostUsd: amount, savedUsd: amount, costWithoutUsd: amount }).strict()).max(200),
  retention: z.object({ requestLogDays: count, rollups: z.literal("kept") }).strict()
}).strict();

export const gatewayAccountListSchema = z.object({ data: z.array(gatewayAccountSchema).max(1000) }).strict();
/** Every key pool's supported models as the gateway lists them live through its first active key (`models` null, with `error`, when it could not). */
export const gatewayPoolModelsSchema = z.object({
  data: z.array(z.object({ provider: gatewayProviderSchema, models: z.array(z.string()).nullable(), error: z.string().nullable() }).strict()),
  fetchedAt: isoSchema
}).strict();
export type GatewayPoolModels = z.infer<typeof gatewayPoolModelsSchema>;
/**
 * Startup programs whose granted credits a Space Gateway pool spends: their Nous › Startup programs rows show that pool's supported models.
 * shortcut: keyed by the data panes' program ids; becomes a program field once Nous renames ids or a program spends more than one pool.
 */
export const GATEWAY_PROGRAM_PROVIDERS: Readonly<Record<string, GatewayProvider>> = {
  "nvidia-nim": "NVIDIA", "amd-ventures-startups": "AMD_TOKEN_LAB", "inception-labs-free-tokens": "INCEPTION", "jina-ai-free-tokens": "JINA",
  "mixedbread-starter-credits": "MIXEDBREAD", "agentrouter-free-credits": "AGENTROUTER", "freeai-startup": "FREEAI"
};
export const gatewayApiKeyListSchema = z.object({ data: z.array(gatewayApiKeySchema).max(1000) }).strict();

/**
 * The free tokens and credits each Space Gateway pool spends (operator 7/11, nous_msg:d9b67550: "a record of the free tokens we have and of
 * those already spent"): a grant has an amount from its start (the program's approval); a free tier has no balance, only its provider's limits.
 * shortcut: amounts as the programs and providers stated them on 7/11 (Nous › Startup programs); a program field once one changes often.
 */
export interface GatewayFreeGrant { amount: number | null; unit: "tokens" | "usd"; since: string; validUntil?: string; program?: string; note: string;
  /** A dollar grant whose provider reports no cost: its list price per million tokens, so "left" is an estimate (said so) instead of unknown. */
  pricePerMillion?: { input: number; output: number } }
export const GATEWAY_FREE_GRANTS: Partial<Record<GatewayProvider, GatewayFreeGrant>> = {
  INCEPTION: { amount: 100_000_000, unit: "tokens", since: "2026-11-06", program: "inception-labs-free-tokens", note: "Mercury models (chat)" },
  JINA: { amount: 10_000_000, unit: "tokens", since: "2026-11-06", program: "jina-ai-free-tokens", note: "embeddings and rerank" },
  FREEAI: { amount: 15_000_000, unit: "tokens", since: "2026-11-07", program: "freeai-startup", note: "chat; third party that sees prompts" },
  ADAPTION: { amount: 1_500, unit: "usd", since: "2026-11-06", note: "1,500 credits (1 credit = $1), never expire" },
  AGENTROUTER: { amount: 149.78, unit: "usd", since: "2026-11-06", program: "agentrouter-free-credits", note: "third-party relay that sees prompts" },
  MIXEDBREAD: { amount: 5, unit: "usd", since: "2026-11-06", program: "mixedbread-starter-credits", note: "embeddings" },
  AZURE_OPENAI: { amount: 200, unit: "usd", since: "2026-11-07", validUntil: "2027-02-05", note: "Azure credit; a card is behind it, the pool stops on 5 Feb 2027",
    // Its one deployment, gpt-5-mini, at Azure's list price (Global Standard, 7/11).
    pricePerMillion: { input: 0.25, output: 2 } },
  AMD_TOKEN_LAB: { amount: null, unit: "usd", since: "2026-11-06", program: "amd-ventures-startups", note: "granted points (amount not stated)" }
};
/** The free tiers without a balance: what limits them instead. */
export const GATEWAY_FREE_TIERS: Partial<Record<GatewayProvider, string>> = {
  GROQ: "free tier: per-model requests and tokens per minute and day", NVIDIA: "free tier: about 40 requests a minute",
  CLOUDFLARE_AI: "free tier: 10,000 neurons a day (00:00 UTC)", GOOGLE_AI: "Gemini API free tier: Flash models, per-model daily caps",
  OPENROUTER: "only the :free models (no credit spent)", ZAI: "free GLM Flash models only", SILICONFLOW: "free models only (needs a non-negative balance)",
  OVH: "anonymous access: 2 requests a minute", MISTRAL: "La Plateforme free tier: every model, rate limited (about 1 request a second)"
};
export const gatewayFreeLedgerRowSchema = z.object({
  provider: gatewayProviderSchema,
  label: z.string().max(120),
  kind: z.enum(["GRANT", "FREE_TIER"]),
  /** The grant (null amount: not stated); null for a free tier. */
  granted: z.object({ amount: z.number().nonnegative().nullable(), unit: z.enum(["tokens", "usd"]) }).strict().nullable(),
  since: z.string().max(10).nullable(),
  validUntil: z.string().max(10).nullable(),
  /** Since the grant began (a free tier: the last 30 days), from the gateway's daily sums. */
  spent: z.object({ requests: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative(), /** costUsd is the list-price estimate (the provider reports none). */ estimated: z.boolean().optional() }).strict(),
  /** What is left in the grant's unit; null when the grant has no amount or the provider reports no cost for a dollar grant. */
  left: z.number().nullable(),
  leftPercent: z.number().min(0).max(100).nullable(),
  lastUsedAt: z.string().max(40).nullable(),
  /** ACTIVE accounts serving it now. */
  accounts: z.number().int().nonnegative(),
  models: z.array(z.string().max(200)).max(200),
  note: z.string().max(300)
}).strict();
export type GatewayFreeLedgerRow = z.infer<typeof gatewayFreeLedgerRowSchema>;
export const gatewayFreeLedgerSchema = z.object({ rows: z.array(gatewayFreeLedgerRowSchema).max(60), at: z.string().max(40) }).strict();
export type GatewayFreeLedger = z.infer<typeof gatewayFreeLedgerSchema>;

const trimZeros = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
const compactNumber = (value: number) => value >= 1e6 ? `${trimZeros((value / 1e6).toFixed(2))}M` : value >= 1e3 ? `${trimZeros((value / 1e3).toFixed(1))}k` : String(Math.round(value));
const dollars = (value: number) => `$${value >= 1000 ? value.toFixed(0) : value.toFixed(2)}`;
/** One line for a ledger row, the same everywhere (Gateway Accounts, Nous Quotas, Nous's world): "100M tokens granted · 12.3k used · 99.99M left". */
export function gatewayFreeLedgerLine(row: GatewayFreeLedgerRow): string {
  const used = row.spent.tokens ? `${compactNumber(row.spent.tokens)} tokens${row.spent.costUsd > 0 ? ` (${row.spent.estimated ? "about " : ""}${dollars(row.spent.costUsd)})` : ""}` : "nothing";
  const last = row.lastUsedAt ? ` · last used ${row.lastUsedAt.slice(0, 10)}` : "";
  if (row.kind === "FREE_TIER") return `Free tier · ${used} used in 30 days${last} · ${row.note}`;
  const grant = row.granted?.amount == null ? "granted (amount not stated)" : row.granted.unit === "tokens" ? `${compactNumber(row.granted.amount)} tokens granted` : `${dollars(row.granted.amount)} granted`;
  const left = row.left === null ? (row.granted?.unit === "usd" && row.granted.amount !== null ? " · left: the provider reports no cost" : "")
    : ` · ${row.granted?.unit === "tokens" ? `${compactNumber(row.left)} tokens` : `${row.spent.estimated ? "about " : ""}${dollars(row.left)}`} left${row.leftPercent !== null ? ` (${Math.round(row.leftPercent)}%)` : ""}`;
  return `${grant} · ${used} used${left}${row.validUntil ? ` · until ${row.validUntil}` : ""}${last}`;
}

export type GatewayProvider = z.infer<typeof gatewayProviderSchema>;
export type GatewayAccountStatus = z.infer<typeof gatewayAccountStatusSchema>;
export type GatewayRoutingStrategy = z.infer<typeof gatewayRoutingStrategySchema>;
export type GatewayTrafficClass = z.infer<typeof gatewayTrafficClassSchema>;
export type GatewayCompressionMode = z.infer<typeof gatewayCompressionModeSchema>;
export type GatewayCompressionProfile = z.infer<typeof gatewayCompressionProfileSchema>;
export type GatewayOutputPolicy = z.infer<typeof gatewayOutputPolicySchema>;
export type GatewayCompressionProviderId = z.infer<typeof gatewayCompressionProviderIdSchema>;
export type GatewayCompressionProviderSettings = z.infer<typeof gatewayCompressionProviderSettingsSchema>;
export type GatewayCompressionProviders = z.infer<typeof gatewayCompressionProvidersSchema>;
export type GatewayLimitType = z.infer<typeof gatewayLimitTypeSchema>;
export type GatewayLimitWindow = z.infer<typeof gatewayLimitWindowSchema>;
export type GatewayReasoningEffort = z.infer<typeof gatewayReasoningEffortSchema>;
export type GatewayUsageWindow = z.infer<typeof gatewayUsageWindowSchema>;

export const GATEWAY_PACE_BAND = 5;
export interface GatewayWeekPace { usedPercent: number | null; passedPercent: number; points: number | null; resetAt: string; pace: "AHEAD" | "ON" | "UNDER" | null }
/**
 * A subscription account's weekly pace (operator rule 2026-10-27, plan clipboard:nUloPOH3blDT: every account's week used, none run
 * out before its reset): `points` = 7-day used % minus the share of the week passed; AHEAD past +5 runs out early, UNDER past -5
 * leaves tokens unused. The week is the 7-day window that holds data, whichever slot it sits in. Null without a live week.
 */
export function gatewayWeekPace(account: { primaryWindow: GatewayUsageWindow; secondaryWindow: GatewayUsageWindow }, at: number): GatewayWeekPace | null {
  const week = [account.secondaryWindow, account.primaryWindow].find((window) => window.windowMinutes === 10_080 && (window.usedPercent !== null || window.resetAt !== null));
  const reset = Date.parse(week?.resetAt ?? "");
  if (!week?.resetAt || !Number.isFinite(reset) || reset <= at) return null;
  const passedPercent = Math.round(Math.min(100, Math.max(0, 100 * (1 - (reset - at) / (10_080 * 60_000)))));
  const points = week.usedPercent === null ? null : Math.round(week.usedPercent - passedPercent);
  return { usedPercent: week.usedPercent, passedPercent, points, resetAt: week.resetAt,
    pace: points === null ? null : points > GATEWAY_PACE_BAND ? "AHEAD" : points < -GATEWAY_PACE_BAND ? "UNDER" : "ON" };
}
/**
 * Share of a pool's quota still free when the last of its periods resets (plan clipboard:mjpENip0ilmC: the pane account menus' "54% free"
 * and Nous's provider advice compute the same figure), and the share free now (`now`). The pool's pace is the sum of its accounts' paces
 * since each period began, spent at each moment on the accounts with room, the one resetting first first (operator 7/11
 * nous_msg:e768734b: «43%» counted each account at its own pace, so the load of the 3 spent accounts never moved to the 2 with room).
 * An account at its limit takes nothing more until it resets; each fresh period before the pool's last reset counts what it leaves free.
 * shortcut: extrapolates the average pace since each period began (an account that hit its limit early understates the demand, and an
 * account that already took a spent one's load counts it again in the sum); keep a pool usage history if a recent-days pace is wanted.
 */
export function quotaLeftAtReset(periods: Array<{ remaining: number | null | undefined; resetAt: string | null | undefined; periodMs: number }>, at: number): QuotaLeftAtReset | null {
  const counted = periods.flatMap((period) => {
    const resetMs = Date.parse(period.resetAt ?? "");
    // Each period at least an hour long, so the first minutes do not extrapolate wildly and the loop below always ends.
    return period.remaining == null || !(resetMs > at) ? [] : [{ remaining: period.remaining, room: period.remaining, resetMs, periodMs: Math.max(period.periodMs, 3_600_000) }];
  });
  if (!counted.length) return null;
  const accounts = counted.length;
  const last = Math.max(...counted.map((period) => period.resetMs));
  const pace = counted.reduce((sum, { remaining, resetMs, periodMs }) => sum + (100 - remaining) / Math.max(at - (resetMs - periodMs), 3_600_000), 0);
  let free = 0;
  for (let now = at; now < last;) {
    const next = Math.min(...counted.map((period) => period.resetMs));
    let load = pace * (next - now);
    for (const period of [...counted].sort((left, right) => left.resetMs - right.resetMs)) {
      const spent = Math.min(period.room, load);
      period.room -= spent;
      load -= spent;
    }
    now = next;
    for (const period of counted) {
      if (period.resetMs !== now || now >= last) continue;
      free += period.room;
      period.room = 100;
      period.resetMs += period.periodMs;
    }
  }
  free += counted.reduce((sum, period) => sum + period.room, 0);
  // gatewayWeekPace's points for any period length: used minus the share of the period passed.
  const ahead = counted.reduce((sum, { remaining, resetMs, periodMs }) => sum + 100 - remaining - 100 * Math.min(1, Math.max(0, (at - (resetMs - periodMs)) / periodMs)), 0);
  const points = Math.round(ahead / accounts);
  // Fresh periods can hold more than one period's worth: the figure stays a share, at most all of it.
  return { percent: Math.min(100, free / accounts), now: counted.reduce((sum, period) => sum + period.remaining, 0) / accounts, accounts,
    resetAt: new Date(last).toISOString(), points, pace: points > GATEWAY_PACE_BAND ? "AHEAD" : points < -GATEWAY_PACE_BAND ? "UNDER" : "ON" };
}
export interface QuotaLeftAtReset { percent: number; now: number; accounts: number; resetAt: string; points: number; pace: "AHEAD" | "ON" | "UNDER" }

const PACE_DAY_MS = 86_400_000;
export interface GatewayPaceDay { dayStartAt: number; daysLeft: number; allowancePercent: number; usedTodayPercent: number; capped: boolean }
/**
 * Today's share of an account's week (plan clipboard:DotwYXVD2N3n, goal d844e0cc: no account at 100% before its reset): the allowance is
 * (100 - used % when the day began) / days left, the days counted back from the weekly reset so the last one is its last 24 hours, which
 * is never capped. `dayStart` is the used % read when the day began; one read for another day (it just turned, the reset moved) or none
 * starts the day at the use seen now. A spent week (100%) is the usage limit's, never held. Times in ms; null without a live week.
 */
export function gatewayPaceDay(week: { usedPercent: number | null | undefined; resetAt: number | null | undefined }, dayStart: { at: number; usedPercent: number } | null | undefined, at: number): GatewayPaceDay | null {
  if (week.usedPercent == null || week.resetAt == null || !(week.resetAt > at)) return null;
  const daysLeft = Math.ceil((week.resetAt - at) / PACE_DAY_MS);
  const dayStartAt = week.resetAt - daysLeft * PACE_DAY_MS;
  const start = dayStart && Math.abs(dayStart.at - dayStartAt) < PACE_DAY_MS / 24 ? Math.min(dayStart.usedPercent, week.usedPercent) : week.usedPercent;
  const allowancePercent = (100 - start) / daysLeft;
  const usedTodayPercent = week.usedPercent - start;
  return { dayStartAt, daysLeft, allowancePercent, usedTodayPercent, capped: daysLeft > 1 && week.usedPercent < 100 && usedTodayPercent >= allowancePercent };
}

/**
 * Reserves only when needed (operator 5/11 nous_msg:3723fc28 «αν ξερουμε οτι γινονται reset οι λογαριασμοι τότε δεν προστατευουμε κανενα 3% …
 * ξοδευονται και αυτα»): the one computation of every floor, cap and reserve of a pool (the Gateway's exhaustion floor, fill-first weekly cap
 * and operator reserve, Nous Pro's room, Nous's room for its spend mode). `base` is kept only for the work the pool's room cannot carry
 * until the next reset of any of its windows, its own included: the shortfall in points, at most `base`; a reset that comes first makes
 * it 0 and every account spends to 100%. Times in any one unit; a window whose reset passed has all its room.
 * shortcut: each window's pace is its average since it began (at least a tenth of the window) and the pool's is their sum, with every
 * account's percent worth the same; keep a pool usage history if a recent pace or plan sizes are wanted.
 */
export function neededReservePercent(windows: ReadonlyArray<{ used: number | null | undefined; resetAt: number | null | undefined; length: number }>, base: number, now: number): number {
  let relief = Infinity, burn = 0, room = 0;
  for (const { used, resetAt, length } of windows) {
    const live = resetAt != null && resetAt > now;
    room += live || resetAt == null ? 100 - Math.min(100, Math.max(0, used ?? 0)) : 100;
    if (!live) continue;
    relief = Math.min(relief, resetAt);
    burn += Math.max(0, used ?? 0) / Math.max(now - (resetAt - length), length / 10);
  }
  return base <= 0 || burn <= 0 ? 0 : Math.min(base, Math.max(0, burn * (relief - now) - room));
}

/**
 * Codex weekly reset credits (operator 2/11 15:38 BKK, brief 20261102-codex-reset-credits): each one gives its account a fresh week,
 * so a pool of `accounts` holds `weekPercent` more of its week than its windows show. Null when no account has a credit.
 */
export interface QuotaResetCredits { credits: number; accounts: number; weekPercent: number }
export function quotaResetCredits(accounts: ReadonlyArray<{ resetCredits?: number | null }>): QuotaResetCredits | null {
  const credits = accounts.reduce((sum, account) => sum + Math.max(0, account.resetCredits ?? 0), 0);
  return credits > 0 ? { credits, accounts: accounts.length, weekPercent: Math.round((100 * credits) / accounts.length) } : null;
}
/** "+4 resets (≈ +200% of a week)": the pickers, the Quotas cards, Accounts & quotas and Nous's lines say it alike. */
export const quotaResetCreditsText = (credits: QuotaResetCredits): string =>
  `+${credits.credits} reset${credits.credits === 1 ? "" : "s"} (≈ +${credits.weekPercent}% of a week)`;

type WeeklyQuotaSample = {
  weeklyRemainingPercent?: number | null;
  weeklyResetAt?: string | null;
  fiveHourRemainingPercent?: number | null;
  fiveHourResetAt?: string | null;
};
type AntigravityGroupSample = WeeklyQuotaSample & { id?: string };
/**
 * An Antigravity account's quota group by id: from `groups` when the account lists them (authoritative, so a group Google stopped
 * reporting is absent), else from the older fixed `gemini`/`claude` fields.
 */
export function antigravityAccountGroup<T extends WeeklyQuotaSample>(
  account: { gemini?: T; claude?: T; groups?: Array<T & { id: string }> },
  group: string,
): T | undefined {
  if (account.groups) return account.groups.find((candidate) => candidate.id === group);
  return group === "gemini" ? account.gemini : group === "claude" ? account.claude : undefined;
}

/**
 * A subscription CLI's weekly quota still free at its reset (plan clipboard:FDitYcI63D9R): the one figure the pane account menus, the
 * Quotas cards, Resources → Accounts & quotas and the usage routes (`atReset`, read by the Nous app) show. Claude and Antigravity count
 * their connected accounts, Codex every account; Antigravity per quota group id (`antigravityAccountGroup`), both "Gemini" and
 * "Claude · GPT" when `group` is null.
 */
export function subscriptionQuotaAtReset(
  provider: "claude" | "codex" | "antigravity",
  accounts: Array<WeeklyQuotaSample & { status?: string; gemini?: WeeklyQuotaSample; claude?: WeeklyQuotaSample; groups?: Array<AntigravityGroupSample & { id: string }>; resetCredits?: number | null }>,
  at: number,
  group: string | null = null,
): Array<QuotaLeftAtReset & { scope: string | null; resetCredits?: QuotaResetCredits }> {
  const counted = provider === "codex" ? accounts : accounts.filter((account) => account.status === "CONNECTED");
  const scopes: Array<[(account: (typeof accounts)[number]) => WeeklyQuotaSample | undefined, string | null]> = provider !== "antigravity"
    ? [[(account) => account, null]]
    : group ? [[(account) => antigravityAccountGroup(account, group), null]] : [[(account) => account.gemini, "Gemini"], [(account) => account.claude, "Claude · GPT"]];
  // Codex reset credits ride on the figure: each is one more fresh week the pool can still spend (operator 2/11 15:38 BKK).
  const credits = provider === "codex" ? quotaResetCredits(counted) : null;
  return scopes.flatMap(([week, scope]) => {
    const left = quotaLeftAtReset(counted.map((account) => {
      const sample = week(account);
      // Google AI Pro meters Gemini models on a 5-hour window without a weekly limit; use the 5-hour window when no week is reported.
      const hasWeek = sample?.weeklyRemainingPercent != null && sample?.weeklyResetAt != null;
      return hasWeek || provider !== "antigravity"
        ? { remaining: sample?.weeklyRemainingPercent, resetAt: sample?.weeklyResetAt, periodMs: 10_080 * 60_000 }
        : { remaining: sample?.fiveHourRemainingPercent, resetAt: sample?.fiveHourResetAt, periodMs: 300 * 60_000 };
    }), at);
    return left ? [{ ...left, scope, ...(credits ? { resetCredits: credits } : {}) }] : [];
  });
}
export type GatewayAccount = z.infer<typeof gatewayAccountSchema>;
export type GatewayApiKeyLimit = z.infer<typeof gatewayApiKeyLimitSchema>;
export type GatewayApiKey = z.infer<typeof gatewayApiKeySchema>;
export type GatewayApiKeyCreateRequest = z.infer<typeof gatewayApiKeyCreateRequestSchema>;
export type GatewayApiKeyUpdateRequest = z.input<typeof gatewayApiKeyUpdateRequestSchema>;
export type GatewayAccountUpdateRequest = z.input<typeof gatewayAccountUpdateRequestSchema>;
export type GatewayApiKeyCreatedResponse = z.infer<typeof gatewayApiKeyCreatedResponseSchema>;
export type GatewaySettings = z.infer<typeof gatewaySettingsSchema>;
export type GatewayProviderOrder = z.infer<typeof gatewayProviderOrderSchema>;
export type GatewaySettingsUpdateRequest = z.infer<typeof gatewaySettingsUpdateRequestSchema>;
export type GatewayRequestLog = z.infer<typeof gatewayRequestLogSchema>;
export type GatewayRequestLogList = z.infer<typeof gatewayRequestLogListSchema>;
export type GatewayLogStatusCategory = z.infer<typeof gatewayLogStatusCategorySchema>;
export type GatewayRequestLogFilter = z.infer<typeof gatewayRequestLogFilterSchema>;
export type GatewayRequestLogFacets = z.infer<typeof gatewayRequestLogFacetsSchema>;
export type GatewayUsageAggregate = z.infer<typeof gatewayUsageAggregateSchema>;
export type GatewayTimeFormat = z.infer<typeof gatewayTimeFormatSchema>;
export type GatewayWindowChoice = z.infer<typeof gatewayWindowChoiceSchema>;
export type GatewayStreamTransport = z.infer<typeof gatewayStreamTransportSchema>;
export type GatewayLanMode = z.infer<typeof gatewayLanModeSchema>;
export type GatewayDashboardRange = z.infer<typeof gatewayDashboardRangeSchema>;
export type GatewaySignalStatus = z.infer<typeof gatewaySignalStatusSchema>;
export type GatewayPoolAccount = z.infer<typeof gatewayPoolAccountSchema>;
export type GatewayPoolWindow = z.infer<typeof gatewayPoolWindowSchema>;
export type GatewayPool = z.infer<typeof gatewayPoolSchema>;
export type GatewayLatencyRow = z.infer<typeof gatewayLatencyRowSchema>;
export type GatewayLiveAccount = z.infer<typeof gatewayLiveAccountSchema>;
export type GatewayDashboard = z.infer<typeof gatewayDashboardSchema>;
export type GatewayHealthSignal = z.infer<typeof gatewayHealthSignalSchema>;
export type GatewayHealth = z.infer<typeof gatewayHealthSchema>;
export type GatewayAccountDetail = z.infer<typeof gatewayAccountDetailSchema>;
export type GatewayPrefixCache = z.infer<typeof gatewayPrefixCacheSchema>;
export type GatewayHeadroomSession = z.infer<typeof gatewayHeadroomSessionSchema>;
export type GatewayHeadroomLifetime = z.infer<typeof gatewayHeadroomLifetimeSchema>;
export type GatewayHistorySeries = z.infer<typeof gatewayHistorySeriesSchema>;
export type GatewayHeadroomHistory = z.infer<typeof gatewayHeadroomHistorySchema>;
export type GatewayApiKeyDetail = z.infer<typeof gatewayApiKeyDetailSchema>;
export type GatewayServiceState = z.infer<typeof gatewayServiceStateSchema>;
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;
export type GatewayClaudeApiKeyUse = z.infer<typeof gatewayClaudeApiKeyUseSchema>;
export type GatewayAnthropicUpstreamKey = z.infer<typeof gatewayAnthropicUpstreamKeySchema>;
export type GatewayAnthropicAdminStatus = z.infer<typeof gatewayAnthropicAdminStatusSchema>;
export type GatewayAnthropicBillingDay = z.infer<typeof gatewayAnthropicBillingDaySchema>;
export type GatewayAnthropicBillingReport = z.infer<typeof gatewayAnthropicBillingReportSchema>;
export type GatewayAccountList = z.infer<typeof gatewayAccountListSchema>;
export type GatewayApiKeyList = z.infer<typeof gatewayApiKeyListSchema>;
export type GatewayReportRow = z.infer<typeof gatewayReportRowSchema>;
export type GatewayReport = z.infer<typeof gatewayReportSchema>;
export type GatewayLostWindow = z.infer<typeof gatewayLostWindowSchema>;
export type GatewayLostTokens = z.infer<typeof gatewayLostTokensSchema>;
export type GatewayCompressionStats = z.infer<typeof gatewayCompressionStatsSchema>;
