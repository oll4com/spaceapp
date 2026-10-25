import { z } from "zod";

// Marketing Copilot pane: promotes SpaceApp on the operator's own accounts through the pane's managed
// browser, with a CLI agent session that plans, writes and (once approved) publishes. Pane metadata holds
// pane-level settings and the operator's current view (the CLI account lives in the pane's CLI session,
// like Job and Mail Copilot); campaigns, posts, memory and rules are per-owner records.
export const MARKETING_COPILOT_PANE_MODE = "MARKETING_COPILOT" as const;

/**
 * How far the agent acts alone. ASSIST: drafts and review requests only, nothing is published without the
 * operator's approval. RULES: publishes alone only under rules the operator approved. FULL: publishes on its
 * own judgement. A channel's cap lowers the level for that channel whatever the pane's level is.
 */
export const MARKETING_COPILOT_AUTONOMY_LEVELS = ["ASSIST", "RULES", "FULL"] as const;
export const marketingCopilotAutonomySchema = z.enum(MARKETING_COPILOT_AUTONOMY_LEVELS);
export type MarketingCopilotAutonomy = z.infer<typeof marketingCopilotAutonomySchema>;

export const MARKETING_CHANNELS = ["X", "LINKEDIN", "REDDIT", "HACKER_NEWS", "PRODUCT_HUNT", "DEVTO", "BLOG", "YOUTUBE", "GITHUB"] as const;
export const marketingChannelSchema = z.enum(MARKETING_CHANNELS);
export type MarketingChannel = z.infer<typeof marketingChannelSchema>;

export const MARKETING_CHANNEL_LABELS: Record<MarketingChannel, string> = {
  X: "X", LINKEDIN: "LinkedIn", REDDIT: "Reddit", HACKER_NEWS: "Hacker News", PRODUCT_HUNT: "Product Hunt",
  DEVTO: "dev.to", BLOG: "Blog", YOUTUBE: "YouTube", GITHUB: "GitHub"
};

export const marketingChannelSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The highest autonomy this channel allows; the effective level is the lower of this and the pane's. */
  autonomyCap: marketingCopilotAutonomySchema,
  /** At most `posts` publications per `perDays` days on this channel, whatever the autonomy level. */
  posts: z.number().int().min(0).max(50),
  perDays: z.number().int().min(1).max(90)
}).strict();
export type MarketingChannelSettings = z.infer<typeof marketingChannelSettingsSchema>;

// Communities that punish self-promotion (Hacker News, Reddit, Product Hunt) stay reviewed by default.
export const MARKETING_CHANNEL_DEFAULTS: Record<MarketingChannel, MarketingChannelSettings> = {
  X: { enabled: true, autonomyCap: "FULL", posts: 3, perDays: 1 },
  LINKEDIN: { enabled: true, autonomyCap: "FULL", posts: 1, perDays: 1 },
  REDDIT: { enabled: true, autonomyCap: "ASSIST", posts: 1, perDays: 7 },
  HACKER_NEWS: { enabled: true, autonomyCap: "ASSIST", posts: 1, perDays: 7 },
  PRODUCT_HUNT: { enabled: true, autonomyCap: "ASSIST", posts: 1, perDays: 30 },
  DEVTO: { enabled: true, autonomyCap: "FULL", posts: 2, perDays: 7 },
  BLOG: { enabled: true, autonomyCap: "FULL", posts: 2, perDays: 7 },
  YOUTUBE: { enabled: true, autonomyCap: "FULL", posts: 1, perDays: 7 },
  GITHUB: { enabled: true, autonomyCap: "FULL", posts: 3, perDays: 7 }
};

const channel = (id: MarketingChannel) => marketingChannelSettingsSchema.default(() => ({ ...MARKETING_CHANNEL_DEFAULTS[id] }));
export const marketingChannelsSettingsSchema = z.object({
  X: channel("X"), LINKEDIN: channel("LINKEDIN"), REDDIT: channel("REDDIT"), HACKER_NEWS: channel("HACKER_NEWS"),
  PRODUCT_HUNT: channel("PRODUCT_HUNT"), DEVTO: channel("DEVTO"), BLOG: channel("BLOG"), YOUTUBE: channel("YOUTUBE"), GITHUB: channel("GITHUB")
}).strict();
export type MarketingChannelsSettings = z.infer<typeof marketingChannelsSettingsSchema>;

function defaultChannels(): MarketingChannelsSettings {
  return Object.fromEntries(MARKETING_CHANNELS.map((id) => [id, { ...MARKETING_CHANNEL_DEFAULTS[id] }])) as MarketingChannelsSettings;
}

export const marketingCopilotPaneSettingsSchema = z.object({
  autonomy: marketingCopilotAutonomySchema.default("ASSIST"),
  /** The copilot opens no new work item while paused; the browser and the drafts keep working. */
  paused: z.boolean().default(false),
  channels: marketingChannelsSettingsSchema.default(defaultChannels),
  /**
   * A new SpaceApp version proposes a release campaign for the operator to approve. Declared with the pane
   * row so the Browser Host, which parses rows with the contracts loaded at its start, needs no new restart.
   */
  releaseCampaigns: z.boolean().default(true),
  /** Which moments raise notifications for this pane. */
  notifications: z.object({
    needsYou: z.boolean().default(true),
    published: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ needsYou: true, published: true, telegram: false })
}).strict();
export type MarketingCopilotPaneSettings = z.infer<typeof marketingCopilotPaneSettingsSchema>;

/** What the operator looks at in the pane; the agent reads it to act on "this post". */
export const marketingCopilotViewSchema = z.object({
  campaignId: z.string().min(1).max(200).nullable().default(null),
  postId: z.string().min(1).max(200).nullable().default(null),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type MarketingCopilotView = z.infer<typeof marketingCopilotViewSchema>;

export const marketingCopilotPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: marketingCopilotPaneSettingsSchema,
  view: marketingCopilotViewSchema.optional()
}).strict();
export type MarketingCopilotPaneMetadata = z.infer<typeof marketingCopilotPaneMetadataSchema>;

export function defaultMarketingCopilotPaneMetadata(): MarketingCopilotPaneMetadata {
  return marketingCopilotPaneMetadataSchema.parse({ version: 1, settings: {} });
}

/** Panes created before the column existed, or never configured, read as defaults. */
export function resolveMarketingCopilotPaneMetadata(metadata: MarketingCopilotPaneMetadata | null | undefined): MarketingCopilotPaneMetadata {
  return metadata ? marketingCopilotPaneMetadataSchema.parse(metadata) : defaultMarketingCopilotPaneMetadata();
}

/** The autonomy that applies on a channel: the lower of the pane's level and the channel's cap. */
export function effectiveMarketingAutonomy(settings: MarketingCopilotPaneSettings, channelId: MarketingChannel): MarketingCopilotAutonomy {
  const cap = settings.channels[channelId].autonomyCap;
  return MARKETING_COPILOT_AUTONOMY_LEVELS[Math.min(MARKETING_COPILOT_AUTONOMY_LEVELS.indexOf(settings.autonomy), MARKETING_COPILOT_AUTONOMY_LEVELS.indexOf(cap))]!;
}

// ---- records: campaigns, posts, memory, activity, runs, rules ------------------------------------
const isoDateTime = z.string().datetime({ offset: true });
const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const marketingCampaignIdSchema = idOf("mktcamp");
export const marketingPostIdSchema = idOf("mktpost");
export const marketingMemoryIdSchema = idOf("mktmem");
export const marketingEventIdSchema = idOf("mktevt");
export const marketingRunIdSchema = idOf("mktrun");
export const marketingRuleIdSchema = idOf("mktrule");
export const marketingQuestionIdSchema = idOf("mktq");

export const MARKETING_CAMPAIGN_STATUSES = ["PROPOSED", "ACTIVE", "DONE", "CANCELLED"] as const;
export const marketingCampaignStatusSchema = z.enum(MARKETING_CAMPAIGN_STATUSES);
export const marketingCampaignSchema = z.object({
  id: marketingCampaignIdSchema,
  ownerUserId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  goal: z.string().max(2000).nullable(),
  channels: z.array(marketingChannelSchema).max(MARKETING_CHANNELS.length),
  status: marketingCampaignStatusSchema,
  startsAt: isoDateTime.nullable(),
  endsAt: isoDateTime.nullable(),
  /** PROPOSED by the agent (or the release hook), ACTIVE once the operator approves; the operator's own start ACTIVE. */
  proposedBy: z.enum(["AGENT", "USER", "RELEASE"]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MarketingCampaign = z.infer<typeof marketingCampaignSchema>;
export const marketingCampaignCreateSchema = z.object({
  /** A ready plan (MARKETING_CAMPAIGN_TEMPLATES): its brief goes to the copilot when the campaign starts. */
  templateId: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).optional(),
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(2000).nullable().optional(),
  channels: z.array(marketingChannelSchema).max(MARKETING_CHANNELS.length).default([]),
  startsAt: isoDateTime.nullable().optional(),
  endsAt: isoDateTime.nullable().optional()
}).strict();
export type MarketingCampaignCreate = z.infer<typeof marketingCampaignCreateSchema>;
export const marketingCampaignDecisionSchema = z.object({ decision: z.enum(["approve", "complete", "cancel"]) }).strict();

export const MARKETING_POST_KINDS = ["POST", "THREAD", "ARTICLE", "VIDEO", "LAUNCH", "REPLY", "RELEASE_NOTE"] as const;
export const marketingPostKindSchema = z.enum(MARKETING_POST_KINDS);
export type MarketingPostKind = z.infer<typeof marketingPostKindSchema>;
/**
 * DRAFT → IN_REVIEW (the agent asks) → APPROVED (only the operator approves) → PUBLISHING → PUBLISHED | FAILED.
 * REJECTED is final; "revise" sends a reviewed post back to DRAFT with the operator's note.
 */
export const MARKETING_POST_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHING", "PUBLISHED", "FAILED", "REJECTED"] as const;
export const marketingPostStatusSchema = z.enum(MARKETING_POST_STATUSES);
export type MarketingPostStatus = z.infer<typeof marketingPostStatusSchema>;
/**
 * A generated image or video the post carries: a pane-owned file, never an Agent File unless the operator asks. With
 * `artifactId` it is a capture in the owner's room Media (space_screenshot): the server sets path and kind from it.
 */
export const marketingAssetSchema = z.object({
  path: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(200),
  kind: z.enum(["IMAGE", "VIDEO", "FILE"]),
  artifactId: z.string().trim().min(1).max(200).optional()
}).strict();
export type MarketingAsset = z.infer<typeof marketingAssetSchema>;
/** What the agent sends: a file with its kind, or just a captured artifact and a label. */
export const marketingAssetInputSchema = z.union([marketingAssetSchema,
  z.object({ artifactId: z.string().trim().min(1).max(200), label: z.string().trim().min(1).max(200) }).strict()]);
export type MarketingAssetInput = z.infer<typeof marketingAssetInputSchema>;
export const marketingPostSchema = z.object({
  id: marketingPostIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  campaignId: marketingCampaignIdSchema.nullable(),
  channel: marketingChannelSchema,
  kind: marketingPostKindSchema,
  /** Where on the channel: a subreddit ("r/selfhosted"), a repository, a Product Hunt page. */
  target: z.string().max(300).nullable(),
  title: z.string().max(300).nullable(),
  body: z.string().min(1).max(40_000),
  assets: z.array(marketingAssetSchema).max(10),
  status: marketingPostStatusSchema,
  scheduledAt: isoDateTime.nullable(),
  /** The operator's note from the last review (revise / reject). */
  reviewNote: z.string().max(2000).nullable(),
  /** The approved rule the post was published under (RULES autonomy). */
  ruleId: marketingRuleIdSchema.nullable(),
  publishedUrl: z.string().max(2000).nullable(),
  publishedAt: isoDateTime.nullable(),
  evidence: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.number()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MarketingPost = z.infer<typeof marketingPostSchema>;
export const marketingPostCreateSchema = z.object({
  campaignId: marketingCampaignIdSchema.nullable().optional(),
  channel: marketingChannelSchema,
  kind: marketingPostKindSchema.default("POST"),
  target: z.string().trim().min(1).max(300).nullable().optional(),
  title: z.string().trim().min(1).max(300).nullable().optional(),
  body: z.string().trim().min(1).max(40_000),
  assets: z.array(marketingAssetInputSchema).max(10).default([]),
  scheduledAt: isoDateTime.nullable().optional()
}).strict();
export type MarketingPostCreate = z.infer<typeof marketingPostCreateSchema>;
export const marketingPostUpdateSchema = marketingPostCreateSchema.omit({ channel: true, kind: true }).partial().strict();
export type MarketingPostUpdate = z.infer<typeof marketingPostUpdateSchema>;
export const marketingPostListQuerySchema = z.object({
  status: z.union([marketingPostStatusSchema, z.array(marketingPostStatusSchema).max(MARKETING_POST_STATUSES.length)]).optional(),
  channel: marketingChannelSchema.optional(),
  campaignId: marketingCampaignIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
}).strict();
/** approve (as written), edit (the operator's version is approved and learned), revise (back to the agent with a note), reject (final). */
export const marketingPostReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "edit", "revise", "reject"]),
  title: z.string().trim().min(1).max(300).nullable().optional(),
  body: z.string().trim().min(1).max(40_000).optional(),
  scheduledAt: isoDateTime.nullable().optional(),
  note: z.string().trim().max(2000).optional()
}).strict().refine((input) => input.decision !== "revise" || Boolean(input.note), "Tell the copilot what to change.");
export type MarketingPostReviewDecision = z.infer<typeof marketingPostReviewDecisionSchema>;

// Memory kinds the copilot keeps: SpaceApp's voice, facts it may claim, who it talks to, each channel's
// rules and norms (a subreddit's self-promotion policy), reusable structures, lessons from edits, preferences.
export const MARKETING_MEMORY_KINDS = ["BRAND_VOICE", "FACT", "AUDIENCE", "CHANNEL_RULE", "TEMPLATE", "LESSON", "PREFERENCE"] as const;
export const marketingMemoryKindSchema = z.enum(MARKETING_MEMORY_KINDS);
export type MarketingMemoryKind = z.infer<typeof marketingMemoryKindSchema>;
export const marketingMemorySchema = z.object({
  id: marketingMemoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: marketingMemoryKindSchema,
  /** One memory per kind, key and channel. */
  key: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(4000),
  channel: marketingChannelSchema.nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  source: z.enum(["USER", "AGENT", "LEARNED"]),
  uses: z.number().int().min(0),
  pinned: z.boolean(),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MarketingMemory = z.infer<typeof marketingMemorySchema>;
export const marketingMemoryCreateSchema = z.object({
  kind: marketingMemoryKindSchema,
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  channel: marketingChannelSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  pinned: z.boolean().default(false)
}).strict();
export type MarketingMemoryCreate = z.infer<typeof marketingMemoryCreateSchema>;
export const marketingMemoryUpdateSchema = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  pinned: z.boolean().optional()
}).strict();
export const marketingMemoryQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  kinds: z.array(marketingMemoryKindSchema).max(MARKETING_MEMORY_KINDS.length).optional(),
  channel: marketingChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
}).strict();
export type MarketingMemoryQuery = z.infer<typeof marketingMemoryQuerySchema>;

// Activity: what the operator asked for, what the agent drafted, asked, proposed and published.
export const MARKETING_EVENT_TYPES = [
  "BRIEF", "POST_DRAFTED", "REVIEW_REQUESTED", "REVIEW_DECIDED", "PUBLISHING", "PUBLISHED", "PUBLISH_FAILED",
  "QUESTION", "ANSWERED", "NEEDS_USER", "CAMPAIGN_PROPOSED", "CAMPAIGN_DECIDED", "RULE_PROPOSED", "RULE_DECIDED", "RULE_APPLIED",
  "METRICS", "NOTE", "RUN_STARTED", "RUN_PAUSED", "RUN_RESUMED", "RUN_STOPPED"
] as const;
export const marketingEventTypeSchema = z.enum(MARKETING_EVENT_TYPES);
export type MarketingEventType = z.infer<typeof marketingEventTypeSchema>;
export const marketingEventSchema = z.object({
  id: marketingEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  runId: marketingRunIdSchema.nullable(),
  postId: marketingPostIdSchema.nullable(),
  campaignId: marketingCampaignIdSchema.nullable(),
  type: marketingEventTypeSchema,
  /** Work-item state of a BRIEF the agent still has to handle; null for plain activity. */
  status: z.enum(["PENDING", "TAKEN", "DONE"]).nullable(),
  message: z.string().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type MarketingEvent = z.infer<typeof marketingEventSchema>;
export const marketingEventListQuerySchema = z.object({
  paneId: paneIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
/** The operator asks the copilot for something ("a launch thread for 0.2.5"); it becomes a work item. */
export const marketingBriefSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  campaignId: marketingCampaignIdSchema.nullable().optional(),
  channels: z.array(marketingChannelSchema).max(MARKETING_CHANNELS.length).default([])
}).strict();

export const marketingRunCountersSchema = z.object({
  taken: z.number().int().min(0).default(0),
  drafted: z.number().int().min(0).default(0),
  published: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  needsUser: z.number().int().min(0).default(0)
}).strict();
export type MarketingRunCounters = z.infer<typeof marketingRunCountersSchema>;
export const marketingRunSchema = z.object({
  id: marketingRunIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema,
  status: z.enum(["RUNNING", "PAUSED", "STOPPED"]),
  counters: marketingRunCountersSchema,
  kickoffSentAt: isoDateTime.nullable(),
  startedAt: isoDateTime,
  stoppedAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MarketingRun = z.infer<typeof marketingRunSchema>;
/** Something waiting for the operator in the rail. */
export const marketingPendingItemSchema = z.object({
  kind: z.enum(["REVIEW", "QUESTION", "CAMPAIGN", "RULE"]),
  id: z.string().min(1).max(200),
  message: z.string().max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type MarketingPendingItem = z.infer<typeof marketingPendingItemSchema>;
export const marketingRunViewSchema = z.object({
  run: marketingRunSchema.nullable(),
  status: z.enum(["IDLE", "RUNNING", "PAUSED", "STOPPED"]),
  pending: z.array(marketingPendingItemSchema).max(200),
  /** Briefs not yet taken plus approved posts that are due. */
  backlog: z.number().int().min(0)
}).strict();
export type MarketingRunView = z.infer<typeof marketingRunViewSchema>;

export const marketingQuestionAskSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  postId: marketingPostIdSchema.optional()
}).strict();
export const marketingQuestionAnswerSchema = z.object({ questionId: marketingQuestionIdSchema, answer: z.string().trim().min(1).max(4000) }).strict();

/** RULES autonomy: the agent may publish alone a post matching an approved rule (channel, kinds, campaign). */
export const MARKETING_RULE_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "RETIRED"] as const;
export const marketingRuleSchema = z.object({
  id: marketingRuleIdSchema,
  ownerUserId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  channel: marketingChannelSchema,
  /** Empty: every kind of post on the channel. */
  kinds: z.array(marketingPostKindSchema).max(MARKETING_POST_KINDS.length),
  campaignId: marketingCampaignIdSchema.nullable(),
  status: z.enum(MARKETING_RULE_STATUSES),
  evidence: z.array(z.string().max(300)).max(20),
  proposedBy: z.enum(["AGENT", "USER"]),
  appliedCount: z.number().int().min(0),
  lastAppliedAt: isoDateTime.nullable(),
  decidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MarketingRule = z.infer<typeof marketingRuleSchema>;
export const marketingRuleProposalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: marketingChannelSchema,
  kinds: z.array(marketingPostKindSchema).max(MARKETING_POST_KINDS.length).default([]),
  campaignId: marketingCampaignIdSchema.nullable().optional(),
  evidence: z.array(z.string().trim().min(1).max(300)).max(20).default([])
}).strict();
export type MarketingRuleProposal = z.infer<typeof marketingRuleProposalSchema>;
export const marketingRuleDecisionSchema = z.object({ decision: z.enum(["approve", "reject", "retire"]) }).strict();

export function marketingRuleMatches(rule: Pick<MarketingRule, "channel" | "kinds" | "campaignId">, post: Pick<MarketingPost, "channel" | "kind" | "campaignId">): boolean {
  return rule.channel === post.channel && (rule.kinds.length === 0 || rule.kinds.includes(post.kind)) && (rule.campaignId === null || rule.campaignId === post.campaignId);
}

/** Hosts a published post's URL may be on, per channel (subdomains such as www. or old. included). */
export const MARKETING_CHANNEL_HOSTS: Record<MarketingChannel, readonly string[]> = {
  X: ["x.com", "twitter.com"], LINKEDIN: ["linkedin.com"], REDDIT: ["reddit.com"], HACKER_NEWS: ["news.ycombinator.com"],
  PRODUCT_HUNT: ["producthunt.com"], DEVTO: ["dev.to"], BLOG: ["spaceapp.dev"], YOUTUBE: ["youtube.com", "youtu.be"], GITHUB: ["github.com"]
};
/** Whether a URL is an https page of the channel: the evidence a publication needs. */
export function marketingUrlMatchesChannel(raw: string, channelId: MarketingChannel): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return MARKETING_CHANNEL_HOSTS[channelId].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
export const marketingPublishBeginSchema = z.object({ postId: marketingPostIdSchema }).strict();
export const marketingPublishDoneSchema = z.object({
  postId: marketingPostIdSchema,
  url: z.string().trim().min(1).max(2000),
  /** A screenshot of the published post taken through the pane browser (a path the API's browser evidence store returned). */
  screenshotPath: z.string().trim().min(1).max(500).optional()
}).strict();
export const marketingPublishFailedSchema = z.object({ postId: marketingPostIdSchema, reason: z.string().trim().min(1).max(1000) }).strict();

// Unqualified absolute claims SpaceApp's public documents never make (the same rules as
// scripts/check-public-claims.mjs ABSOLUTE_RULES; a contracts test keeps the two lists equal).
export const MARKETING_ABSOLUTE_RULES: ReadonlyArray<{ id: string; pattern: RegExp; allow?: RegExp }> = [
  { id: "zero-latency", pattern: /\bzero[- ]latency\b/i },
  { id: "crosstalk", pattern: /\b(?:zero|no)[- ]cross[- ]?talk\b/i },
  { id: "instant", pattern: /\binstant(?:ly|aneous(?:ly)?)?\b(?!-UI)/i },
  { id: "sub-millisecond-bound", pattern: /\bsub-\d+(?:\.\d+)?\s?(?:ms|milliseconds?)\b/i },
  { id: "hundred-percent", pattern: /\b100\s?%\s+(?:parity|free|isolat\w*|reliab\w*|uptime|compatib\w*|secure|safe|complete)/i },
  { id: "speed-superlative", pattern: /\b(?:ultra[- ]fast|blazing(?:ly)?[- ]fast|lightning[- ]fast)\b/i },
  { id: "zero-downtime", pattern: /\bzero[- ]downtime\b/i },
  { id: "guarantee", pattern: /\bguarantee(?:s|d)?\b/i, allow: /\b(?:no|not|never|without)\b[^.]{0,48}\bguarantee|\bguarantee[^.]{0,24}\b(?:is|are) not\b/i },
  { id: "exactly-once", pattern: /\bexactly[- ]once\b/i, allow: /\b(?:no|not|never|without)\b[^.]{0,48}\bexactly[- ]once|\bexactly[- ]once[^.]{0,32}\b(?:is|are) not\b/i },
  { id: "seamless", pattern: /\bseamless(?:ly)?\b/i },
  { id: "never-lose", pattern: /\bnever (?:lose|loses|lost|drops?)\b/i }
];
export const MARKETING_LATENCY_RULE = {
  number: /\b\d+(?:[.,]\d+)?\s?(?:ms|milliseconds?)\b/i,
  context: /\b(?:latency|switch\w*|fast(?:er)?|speed|respon\w*|p9\d|per snip|load\w*|render\w*|open(?:s|ing)?)\b/i,
  qualifier: /\]\(|\b(?:target|goal|gate|budget|unverified|not (?:verified|benchmarked|measured)|estimate[sd]?)\b/i
};
/** The unqualified absolute or latency claims a post makes, by rule id, line by line like the public-claims check. */
export function marketingWordingIssues(text: string): string[] {
  const issues = new Set<string>();
  for (const line of text.split("\n")) {
    for (const rule of MARKETING_ABSOLUTE_RULES) if (rule.pattern.test(line) && !rule.allow?.test(line)) issues.add(rule.id);
    if (MARKETING_LATENCY_RULE.number.test(line) && MARKETING_LATENCY_RULE.context.test(line) && !MARKETING_LATENCY_RULE.qualifier.test(line)) issues.add("latency-number");
  }
  return [...issues];
}

// ---- analytics -------------------------------------------------------------------------------------
/** One daily value of a public metric (GitHub stars, npm downloads, ...), per owner. */
export const marketingMetricSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(1).max(40),
  key: z.string().min(1).max(80),
  value: z.number()
}).strict();
export type MarketingMetric = z.infer<typeof marketingMetricSchema>;
/** The agent's reading of a published post's engagement (likes, comments, views, upvotes, ...). */
export const marketingPostMetricsRecordSchema = z.object({
  postId: marketingPostIdSchema,
  metrics: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.number().min(0).max(1e12)).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 12, "Report 1 to 12 metrics.")
}).strict();

// ---- bookmarks -------------------------------------------------------------------------------------
/** A page the pane browser opens in a new tab with one Google account (operator request 2026-10-16); null: the pane's own. */
export const marketingBookmarkIdSchema = idOf("mktbm");
const bookmarkUrlSchema = z.string().trim().max(2048).url().refine((url) => /^https?:\/\//i.test(url), "Use an http or https address.");
export const marketingBookmarkSchema = z.object({
  id: marketingBookmarkIdSchema,
  ownerUserId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  url: bookmarkUrlSchema,
  profileId: z.string().min(1).max(200).nullable(),
  /** The account's address as the operator chose it, so the list and the agent name it without the account list. */
  accountLabel: z.string().min(1).max(320).nullable(),
  createdAt: isoDateTime
}).strict();
export type MarketingBookmark = z.infer<typeof marketingBookmarkSchema>;
export const marketingBookmarkCreateSchema = z.object({
  url: bookmarkUrlSchema,
  title: z.string().trim().min(1).max(200).optional(),
  profileId: z.string().trim().min(1).max(200).nullable().default(null),
  accountLabel: z.string().trim().min(1).max(320).nullable().default(null)
}).strict();
export type MarketingBookmarkCreate = z.infer<typeof marketingBookmarkCreateSchema>;

// ---- campaign templates ---------------------------------------------------------------------------
/**
 * Ready campaign plans the operator starts from the Posts tab (the agent's playbooks in the skill's
 * references/campaigns.md follow the same ids). The brief is what the copilot receives when the campaign starts.
 */
export const MARKETING_CAMPAIGN_TEMPLATES = [
  { id: "release", name: "Release announcement", channels: ["X", "LINKEDIN", "GITHUB", "DEVTO"],
    goal: "Tell users and builders what the new SpaceApp version brings and how to upgrade.",
    brief: "Plan a release announcement: GitHub release notes, an X thread, a LinkedIn post and a dev.to article about the version's most useful changes, grounded in the release notes and the capabilities spec." },
  { id: "product-hunt", name: "Product Hunt launch", channels: ["PRODUCT_HUNT", "X", "LINKEDIN"],
    goal: "Launch SpaceApp on Product Hunt with a clear story and a prepared launch day.",
    brief: "Prepare the Product Hunt launch kit: tagline (60 characters), description, the maker's first comment, gallery images, and launch-day posts for X and LinkedIn. Ask for the launch date." },
  { id: "show-hn", name: "Show HN", channels: ["HACKER_NEWS"],
    goal: "Show SpaceApp to Hacker News honestly: what it is, why it exists, how to try it.",
    brief: "Draft a Show HN submission (plain title under 80 characters) and the maker's first comment: who built it and why, what it does, how to try it, what is not done yet." },
  { id: "weekly-tip", name: "Weekly tip", channels: ["X", "LINKEDIN"],
    goal: "One practical SpaceApp tip a week that shows a real workflow.",
    brief: "Draft this week's tip: one concrete SpaceApp workflow (rooms, panes, copilots, skills) as a short X post and a LinkedIn post, scheduled a day apart." },
  { id: "demo-video", name: "Demo video", channels: ["YOUTUBE", "X"],
    goal: "A short video that shows SpaceApp running several AI coding agents side by side.",
    brief: "Plan and produce a short demo video with the space-hyperframes skill (script, scenes, captions), then the YouTube title and description and an X post that links to it." }
] as const satisfies ReadonlyArray<{ id: string; name: string; channels: readonly MarketingChannel[]; goal: string; brief: string }>;
export type MarketingCampaignTemplateId = (typeof MARKETING_CAMPAIGN_TEMPLATES)[number]["id"];
export const marketingCampaignTemplateIdSchema = z.enum(MARKETING_CAMPAIGN_TEMPLATES.map((template) => template.id) as [MarketingCampaignTemplateId, ...MarketingCampaignTemplateId[]]);
