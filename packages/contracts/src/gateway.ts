import { z } from "zod";

/**
 * Space Gateway: the native TypeScript account load balancer (codex-lb rewrite) with built-in context
 * compression (Headroom rewrite). These schemas are the admin view; credentials never appear in them.
 */

export const gatewayProviderSchema = z.enum([
  "CODEX", "CLAUDE", "ANTIGRAVITY", "COPILOT", "OPENAI_API", "ANTHROPIC_API", "DEEPSEEK", "OPENROUTER", "GOOGLE_AI", "KIMI", "QWEN"
]);

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
  createdAt: isoSchema
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
}).strict().refine((input) => Object.keys(input).length > 0, { message: "Nothing to update." });

/** Operator preferences of an account; `paused` pauses or resumes it. An empty alias clears it. */
export const gatewayAccountUpdateRequestSchema = z.object({
  paused: z.boolean().optional(),
  alias: z.string().trim().max(80).nullable().optional().transform((value) => (value === "" ? null : value)),
  warmupEnabled: z.boolean().optional()
}).strict().refine((input) => Object.keys(input).length > 0, { message: "Nothing to update." });

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
   * account (paid per token); the accounts take over again at their next reset. Off: the key is never used.
   */
  claudeApiKeyFallback: z.boolean(),
  /** Limit warm-up: one tiny request right after a confirmed window reset, so the next window starts counting at once. */
  warmupEnabled: z.boolean(),
  warmupWindows: gatewayWindowChoiceSchema,
  warmupModel: z.string().trim().min(1).max(128),
  warmupPrompt: z.string().trim().min(1).max(512),
  warmupCooldownSeconds: z.number().int().min(60).max(7 * 86_400),
  warmupMinAvailablePercent: z.number().gt(0).max(100),
  /** LAN listener: ENV follows /opt/spaceapp/.env; OFF and ON override it. Applied by a reload. */
  lanMode: gatewayLanModeSchema,
  lanHost: z.string().trim().min(7).max(45).nullable(),
  lanPort: z.number().int().min(1024).max(65535).nullable(),
  lanAllowedSources: z.array(z.string().trim().min(7).max(49)).max(20),
  updatedAt: isoSchema
}).strict();

export const gatewaySettingsUpdateRequestSchema = gatewaySettingsSchema.omit({ updatedAt: true }).partial().strict()
  .refine((input) => Object.keys(input).length > 0, { message: "Nothing to update." });

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
  compressionTokensSaved: z.number().int().min(0)
}).strict();

export const gatewayReportSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.array(gatewayReportRowSchema).max(400),
  models: z.array(gatewayReportRowSchema).max(500),
  accounts: z.array(gatewayReportRowSchema).max(1000),
  totals: gatewayReportRowSchema
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
export const gatewayApiKeyListSchema = z.object({ data: z.array(gatewayApiKeySchema).max(1000) }).strict();

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
export type GatewayAccount = z.infer<typeof gatewayAccountSchema>;
export type GatewayApiKeyLimit = z.infer<typeof gatewayApiKeyLimitSchema>;
export type GatewayApiKey = z.infer<typeof gatewayApiKeySchema>;
export type GatewayApiKeyCreateRequest = z.infer<typeof gatewayApiKeyCreateRequestSchema>;
export type GatewayApiKeyUpdateRequest = z.input<typeof gatewayApiKeyUpdateRequestSchema>;
export type GatewayAccountUpdateRequest = z.input<typeof gatewayAccountUpdateRequestSchema>;
export type GatewayApiKeyCreatedResponse = z.infer<typeof gatewayApiKeyCreatedResponseSchema>;
export type GatewaySettings = z.infer<typeof gatewaySettingsSchema>;
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
export type GatewayAccountList = z.infer<typeof gatewayAccountListSchema>;
export type GatewayApiKeyList = z.infer<typeof gatewayApiKeyListSchema>;
export type GatewayReportRow = z.infer<typeof gatewayReportRowSchema>;
export type GatewayReport = z.infer<typeof gatewayReportSchema>;
export type GatewayCompressionStats = z.infer<typeof gatewayCompressionStatsSchema>;
