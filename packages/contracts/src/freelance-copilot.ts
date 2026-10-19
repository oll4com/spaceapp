import { z } from "zod";
import { marketingWordingIssues } from "./marketing-copilot.js";

// Freelance Copilot pane: finds clients for oll4.com on freelance platforms (Upwork, Contra, Fiverr, Toptal, Arc,
// Braintrust) through the pane's managed browser, with a CLI agent session that qualifies leads, writes and sends
// proposals and answers clients; the operator takes over when a client wants to go ahead (CLIENT_READY).
// Operator decisions 2026-10-14 (clipboard PLAN clipboard:EFWug5E7pVln): fully autonomous by default, one Plesk
// mailbox work@example.invalid with one alias per platform. Pane metadata holds pane-level settings and the operator's
// view (the CLI account lives in the pane's CLI session, like the other copilots); the rest is per-owner records.
export const FREELANCE_COPILOT_PANE_MODE = "FREELANCE_COPILOT" as const;

/** ASSIST: drafts and reviews only. RULES: sends alone under approved rules. FULL: sends on its own judgement. */
export const FREELANCE_COPILOT_AUTONOMY_LEVELS = ["ASSIST", "RULES", "FULL"] as const;
export const freelanceCopilotAutonomySchema = z.enum(FREELANCE_COPILOT_AUTONOMY_LEVELS);
export type FreelanceCopilotAutonomy = z.infer<typeof freelanceCopilotAutonomySchema>;

export const FREELANCE_CHANNELS = ["UPWORK", "CONTRA", "FIVERR", "TOPTAL", "ARC", "BRAINTRUST"] as const;
export const freelanceChannelSchema = z.enum(FREELANCE_CHANNELS);
export type FreelanceChannel = z.infer<typeof freelanceChannelSchema>;

export const FREELANCE_CHANNEL_LABELS: Record<FreelanceChannel, string> = {
  UPWORK: "Upwork", CONTRA: "Contra", FIVERR: "Fiverr", TOPTAL: "Toptal", ARC: "Arc", BRAINTRUST: "Braintrust"
};
/** Where the operator (or the copilot, through the pane browser) signs in on each platform. */
export const FREELANCE_CHANNEL_LOGIN_URLS: Record<FreelanceChannel, string> = {
  UPWORK: "https://www.upwork.com/ab/account-security/login", CONTRA: "https://contra.com/log-in", FIVERR: "https://www.fiverr.com/login",
  TOPTAL: "https://www.toptal.com/users/login", ARC: "https://arc.dev/login", BRAINTRUST: "https://app.usebraintrust.com/login/"
};
/** Hosts a sent proposal's or message's URL may be on, per channel (subdomains included). */
export const FREELANCE_CHANNEL_HOSTS: Record<FreelanceChannel, readonly string[]> = {
  UPWORK: ["upwork.com"], CONTRA: ["contra.com"], FIVERR: ["fiverr.com"], TOPTAL: ["toptal.com"], ARC: ["arc.dev"], BRAINTRUST: ["usebraintrust.com", "braintrust.com"]
};
/**
 * Platforms whose account signs in only with "Continue with Google" on the pane's Google account (operator rule 2026-10-17):
 * never the email/password form or the alias.
 */
export const FREELANCE_GOOGLE_SIGN_IN_CHANNELS: readonly FreelanceChannel[] = ["UPWORK"];
/** The Plesk alias each platform account signs up with; all of them deliver into work@example.invalid. */
export const FREELANCE_CHANNEL_ALIASES: Record<FreelanceChannel, string> = {
  UPWORK: "upwork@example.invalid", CONTRA: "contra@example.invalid", FIVERR: "fiverr@example.invalid", TOPTAL: "toptal@example.invalid", ARC: "arc@example.invalid", BRAINTRUST: "braintrust@example.invalid"
};

/**
 * Where the pane browser's traffic leaves from: the CLI VPN routes (Settings → CLI VPN route) through a SOCKS5 proxy
 * in each VPN namespace (space-browser-egress@<namespace>.service), or this server ("direct"). A route that is down
 * fails closed: the page does not load rather than leaving from another country.
 */
export const FREELANCE_EGRESS_ROUTES = ["direct", "greece", "thailand", "mullvad", "nord"] as const;
export const freelanceEgressRouteSchema = z.enum(FREELANCE_EGRESS_ROUTES);
export type FreelanceEgressRoute = z.infer<typeof freelanceEgressRouteSchema>;
export const FREELANCE_EGRESS_LABELS: Record<FreelanceEgressRoute, string> = {
  direct: "This server", greece: "Greece WireGuard", thailand: "Thailand", mullvad: "Mullvad", nord: "NordVPN"
};
/** The SOCKS5 proxy of each VPN route: the namespace's eth0 address (scripts/cli-vpn-broker.mjs) and port 1080. */
export const FREELANCE_EGRESS_PROXIES: Record<Exclude<FreelanceEgressRoute, "direct">, string> = {
  greece: "10.254.241.2:1080", thailand: "10.254.242.2:1080", mullvad: "10.254.243.2:1080", nord: "10.254.244.2:1080"
};
/** More hosts a platform loads its sign-in and pages from, routed with it. */
export const FREELANCE_CHANNEL_EXTRA_HOSTS: Partial<Record<FreelanceChannel, readonly string[]>> = {
  UPWORK: ["upwork.co", "upworkstatic.com"], FIVERR: ["fiverr-res.cloudinary.com", "fiverrcdn.com"]
};

export const freelanceChannelSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The route this platform leaves from; "pane" follows the pane's route for other sites. */
  egress: z.union([freelanceEgressRouteSchema, z.literal("pane")]).default("pane"),
  /** The highest autonomy this channel allows; the effective level is the lower of this and the pane's. */
  autonomyCap: freelanceCopilotAutonomySchema,
  /** At most this many proposals and messages a day on this channel, whatever the autonomy level. */
  dailyCap: z.number().int().min(0).max(100)
}).strict();
export type FreelanceChannelSettings = z.infer<typeof freelanceChannelSettingsSchema>;

// Operator decision 2026-10-14: every channel FULL (the ban risk of automated sending is the operator's).
export const FREELANCE_CHANNEL_DEFAULTS: Record<FreelanceChannel, FreelanceChannelSettings> = {
  UPWORK: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 20 },
  CONTRA: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 20 },
  FIVERR: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 20 },
  TOPTAL: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 10 },
  ARC: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 10 },
  BRAINTRUST: { enabled: true, egress: "pane", autonomyCap: "FULL", dailyCap: 10 }
};

const channel = (id: FreelanceChannel) => freelanceChannelSettingsSchema.default(() => ({ ...FREELANCE_CHANNEL_DEFAULTS[id] }));
export const freelanceChannelsSettingsSchema = z.object({
  UPWORK: channel("UPWORK"), CONTRA: channel("CONTRA"), FIVERR: channel("FIVERR"), TOPTAL: channel("TOPTAL"), ARC: channel("ARC"), BRAINTRUST: channel("BRAINTRUST")
}).strict();
export type FreelanceChannelsSettings = z.infer<typeof freelanceChannelsSettingsSchema>;
function defaultChannels(): FreelanceChannelsSettings {
  return Object.fromEntries(FREELANCE_CHANNELS.map((id) => [id, { ...FREELANCE_CHANNEL_DEFAULTS[id] }])) as FreelanceChannelsSettings;
}

// Every setting later phases use is declared here: the Browser Host parses pane rows with the contracts it loaded
// at its start, so a new key would need another guarded restart.
export const freelanceCopilotPaneSettingsSchema = z.object({
  autonomy: freelanceCopilotAutonomySchema.default("FULL"),
  /** The copilot opens no new work item and sends nothing while paused. */
  paused: z.boolean().default(false),
  channels: freelanceChannelsSettingsSchema.default(defaultChannels),
  /** Upwork Connects the copilot may spend on proposals (0: no limit). */
  connectsBudget: z.object({
    perDay: z.number().int().min(0).max(1000).default(120),
    perMonth: z.number().int().min(0).max(20000).default(2000)
  }).strict().default({ perDay: 120, perMonth: 2000 }),
  /** No hourly bid below this (USD); a lower one needs the operator. */
  rateFloorHourly: z.number().min(0).max(1000).default(35),
  /** Follow up on a proposal nobody answered, 3 and 7 days after it went out. */
  followUps: z.boolean().default(true),
  /**
   * Where the pane browser's traffic leaves from for every site a platform does not route itself. Thailand matches
   * the accounts' declared country (operator decision 2026-10-14).
   */
  browserEgress: freelanceEgressRouteSchema.default("thailand"),
  /** Which moments raise notifications for this pane. */
  notifications: z.object({
    needsYou: z.boolean().default(true),
    clientReady: z.boolean().default(true),
    telegram: z.boolean().default(true)
  }).strict().default({ needsYou: true, clientReady: true, telegram: true })
}).strict();
export type FreelanceCopilotPaneSettings = z.infer<typeof freelanceCopilotPaneSettingsSchema>;

/** What the operator looks at in the pane; the agent reads it to act on "this lead". */
export const freelanceCopilotViewSchema = z.object({
  leadId: z.string().min(1).max(200).nullable().default(null),
  messageId: z.string().min(1).max(200).nullable().default(null),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type FreelanceCopilotView = z.infer<typeof freelanceCopilotViewSchema>;

export const freelanceCopilotPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: freelanceCopilotPaneSettingsSchema,
  view: freelanceCopilotViewSchema.optional()
}).strict();
export type FreelanceCopilotPaneMetadata = z.infer<typeof freelanceCopilotPaneMetadataSchema>;

export function defaultFreelanceCopilotPaneMetadata(): FreelanceCopilotPaneMetadata {
  return freelanceCopilotPaneMetadataSchema.parse({ version: 1, settings: {} });
}
/** Panes created before the column existed, or never configured, read as defaults. */
export function resolveFreelanceCopilotPaneMetadata(metadata: FreelanceCopilotPaneMetadata | null | undefined): FreelanceCopilotPaneMetadata {
  return metadata ? freelanceCopilotPaneMetadataSchema.parse(metadata) : defaultFreelanceCopilotPaneMetadata();
}
/** The autonomy that applies on a channel: the lower of the pane's level and the channel's cap. */
export function effectiveFreelanceAutonomy(settings: FreelanceCopilotPaneSettings, channelId: FreelanceChannel): FreelanceCopilotAutonomy {
  const cap = settings.channels[channelId].autonomyCap;
  return FREELANCE_COPILOT_AUTONOMY_LEVELS[Math.min(FREELANCE_COPILOT_AUTONOMY_LEVELS.indexOf(settings.autonomy), FREELANCE_COPILOT_AUTONOMY_LEVELS.indexOf(cap))]!;
}

// ---- records: leads, messages, accounts, memory, activity, runs, rules ---------------------------
const isoDateTime = z.string().datetime({ offset: true });
const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const freelanceLeadIdSchema = idOf("fllead");
export const freelanceMessageIdSchema = idOf("flmsg");
export const freelanceMemoryIdSchema = idOf("flmem");
export const freelanceEventIdSchema = idOf("flevt");
export const freelanceRunIdSchema = idOf("flrun");
export const freelanceRuleIdSchema = idOf("flrule");
export const freelanceQuestionIdSchema = idOf("flq");

/**
 * NEW (found) → QUALIFIED (worth a proposal) | SKIPPED → PROPOSED (proposal sent) → TALKING (the client answered)
 * → CLIENT_READY (the client wants to go ahead: the operator takes over) → WON | LOST.
 */
export const FREELANCE_LEAD_STATUSES = ["NEW", "QUALIFIED", "SKIPPED", "PROPOSED", "TALKING", "CLIENT_READY", "WON", "LOST"] as const;
export const freelanceLeadStatusSchema = z.enum(FREELANCE_LEAD_STATUSES);
export type FreelanceLeadStatus = z.infer<typeof freelanceLeadStatusSchema>;
/** The statuses the agent sets itself; CLIENT_READY has its own tool and WON is the operator's. */
export const FREELANCE_AGENT_LEAD_STATUSES = ["NEW", "QUALIFIED", "SKIPPED", "PROPOSED", "TALKING", "LOST"] as const;
export const freelanceLeadSchema = z.object({
  id: freelanceLeadIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  channel: freelanceChannelSchema,
  /** The job post, request or conversation on the platform. */
  url: z.string().max(2000).nullable(),
  /** The platform's own id (an Upwork job id): one lead per channel and id. */
  externalId: z.string().max(200).nullable(),
  title: z.string().min(1).max(300),
  client: z.string().max(300).nullable(),
  description: z.string().max(20_000).nullable(),
  /** As the post states it: "$1,500 fixed", "$40-70/h". */
  budget: z.string().max(200).nullable(),
  /** The copilot's fit score, 0-100. */
  score: z.number().int().min(0).max(100).nullable(),
  status: freelanceLeadStatusSchema,
  /** When a follow-up is due (null: none). */
  nextActionAt: isoDateTime.nullable(),
  /** USD, entered when the lead is won. */
  contractValue: z.number().min(0).max(10_000_000).nullable(),
  notes: z.string().max(4000).nullable(),
  /** Client facts (payment verified, proposals so far, hire rate, total spent, posted at) and scam signals. */
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type FreelanceLead = z.infer<typeof freelanceLeadSchema>;
export const freelanceLeadCreateSchema = z.object({
  channel: freelanceChannelSchema,
  url: z.string().trim().url().max(2000).nullable().optional(),
  externalId: z.string().trim().min(1).max(200).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  client: z.string().trim().min(1).max(300).nullable().optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  budget: z.string().trim().max(200).nullable().optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
  status: z.enum(["NEW", "QUALIFIED", "SKIPPED"]).default("NEW"),
  notes: z.string().trim().max(4000).nullable().optional(),
  facts: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).default({})
}).strict();
export type FreelanceLeadCreate = z.infer<typeof freelanceLeadCreateSchema>;
export const freelanceLeadUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  client: z.string().trim().min(1).max(300).nullable().optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  budget: z.string().trim().max(200).nullable().optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
  status: z.enum(FREELANCE_AGENT_LEAD_STATUSES).optional(),
  nextActionAt: isoDateTime.nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  facts: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional()
}).strict();
export type FreelanceLeadUpdate = z.infer<typeof freelanceLeadUpdateSchema>;
/** The operator closes a lead (won with its value, lost) or hands it back to the copilot. */
export const freelanceLeadDecisionSchema = z.object({
  decision: z.enum(["won", "lost", "reopen"]),
  contractValue: z.number().min(0).max(10_000_000).optional(),
  note: z.string().trim().max(2000).optional()
}).strict();
export type FreelanceLeadDecision = z.infer<typeof freelanceLeadDecisionSchema>;

export const FREELANCE_MESSAGE_KINDS = ["PROPOSAL", "MESSAGE", "FOLLOW_UP", "APPLICATION"] as const;
export const freelanceMessageKindSchema = z.enum(FREELANCE_MESSAGE_KINDS);
export type FreelanceMessageKind = z.infer<typeof freelanceMessageKindSchema>;
/**
 * Outgoing: DRAFT → IN_REVIEW (the agent asks) → APPROVED (only the operator approves) → SENDING → SENT | FAILED;
 * REJECTED is final. Incoming client messages are RECEIVED.
 */
export const FREELANCE_MESSAGE_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "SENDING", "SENT", "FAILED", "REJECTED", "RECEIVED"] as const;
export const freelanceMessageStatusSchema = z.enum(FREELANCE_MESSAGE_STATUSES);
export type FreelanceMessageStatus = z.infer<typeof freelanceMessageStatusSchema>;
export const freelanceBidSchema = z.object({
  type: z.enum(["HOURLY", "FIXED"]),
  /** USD per hour (HOURLY) or in total (FIXED). */
  amount: z.number().min(0).max(10_000_000)
}).strict();
export type FreelanceBid = z.infer<typeof freelanceBidSchema>;
export const freelanceMessageSchema = z.object({
  id: freelanceMessageIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  leadId: freelanceLeadIdSchema,
  channel: freelanceChannelSchema,
  direction: z.enum(["OUT", "IN"]),
  kind: freelanceMessageKindSchema,
  body: z.string().min(1).max(20_000),
  bid: freelanceBidSchema.nullable(),
  /** Upwork Connects the proposal costs. */
  connects: z.number().int().min(0).max(1000).nullable(),
  status: freelanceMessageStatusSchema,
  reviewNote: z.string().max(2000).nullable(),
  ruleId: freelanceRuleIdSchema.nullable(),
  sentUrl: z.string().max(2000).nullable(),
  sentAt: isoDateTime.nullable(),
  evidence: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type FreelanceMessage = z.infer<typeof freelanceMessageSchema>;
export const freelanceMessageCreateSchema = z.object({
  leadId: freelanceLeadIdSchema,
  kind: freelanceMessageKindSchema.default("PROPOSAL"),
  body: z.string().trim().min(1).max(20_000),
  bid: freelanceBidSchema.nullable().optional(),
  connects: z.number().int().min(0).max(1000).nullable().optional()
}).strict();
export type FreelanceMessageCreate = z.infer<typeof freelanceMessageCreateSchema>;
export const freelanceMessageUpdateSchema = freelanceMessageCreateSchema.omit({ leadId: true, kind: true }).partial().strict();
export type FreelanceMessageUpdate = z.infer<typeof freelanceMessageUpdateSchema>;
/** A client's message the agent read on the platform (or in a notification mail). */
export const freelanceIncomingSchema = z.object({
  leadId: freelanceLeadIdSchema,
  body: z.string().trim().min(1).max(20_000),
  url: z.string().trim().url().max(2000).optional(),
  receivedAt: isoDateTime.optional()
}).strict();
export const freelanceMessageReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "edit", "revise", "reject"]),
  body: z.string().trim().min(1).max(20_000).optional(),
  note: z.string().trim().max(2000).optional()
}).strict().refine((input) => input.decision !== "revise" || Boolean(input.note), "Tell the copilot what to change.");
export type FreelanceMessageReviewDecision = z.infer<typeof freelanceMessageReviewDecisionSchema>;
export const freelanceSendBeginSchema = z.object({ messageId: freelanceMessageIdSchema }).strict();
export const freelanceSendDoneSchema = z.object({
  messageId: freelanceMessageIdSchema,
  url: z.string().trim().min(1).max(2000),
  /** A screenshot of the sent proposal or message taken through the pane browser. */
  screenshotPath: z.string().trim().min(1).max(500).optional()
}).strict();
export const freelanceSendFailedSchema = z.object({ messageId: freelanceMessageIdSchema, reason: z.string().trim().min(1).max(1000) }).strict();
/** The client wants to go ahead: what was agreed so far, for the operator who takes over. */
export const freelanceClientReadySchema = z.object({
  leadId: freelanceLeadIdSchema,
  summary: z.string().trim().min(1).max(2000)
}).strict();

/** Each platform account: registration state and the alias it signs in with (never passwords or codes). */
export const FREELANCE_ACCOUNT_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "NEEDS_OPERATOR", "ACTIVE", "BLOCKED"] as const;
export const freelanceAccountSchema = z.object({
  ownerUserId: z.string().min(1).max(200),
  channel: freelanceChannelSchema,
  status: z.enum(FREELANCE_ACCOUNT_STATUSES),
  email: z.string().max(200).nullable(),
  profileUrl: z.string().max(2000).nullable(),
  notes: z.string().max(2000).nullable(),
  updatedAt: isoDateTime
}).strict();
export type FreelanceAccount = z.infer<typeof freelanceAccountSchema>;
export const freelanceAccountUpdateSchema = z.object({
  channel: freelanceChannelSchema,
  status: z.enum(FREELANCE_ACCOUNT_STATUSES).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  profileUrl: z.string().trim().url().max(2000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
}).strict();
export type FreelanceAccountUpdate = z.infer<typeof freelanceAccountUpdateSchema>;

// Memory: the operator's profile and case studies, facts it may claim, prices, each platform's rules, proposal
// templates, lessons from edits, preferences and what it knows about clients.
export const FREELANCE_MEMORY_KINDS = ["PROFILE", "FACT", "CASE_STUDY", "PRICING", "CHANNEL_RULE", "TEMPLATE", "LESSON", "PREFERENCE", "CLIENT"] as const;
export const freelanceMemoryKindSchema = z.enum(FREELANCE_MEMORY_KINDS);
export type FreelanceMemoryKind = z.infer<typeof freelanceMemoryKindSchema>;
export const freelanceMemorySchema = z.object({
  id: freelanceMemoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: freelanceMemoryKindSchema,
  key: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(4000),
  channel: freelanceChannelSchema.nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  source: z.enum(["USER", "AGENT", "LEARNED"]),
  uses: z.number().int().min(0),
  pinned: z.boolean(),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type FreelanceMemory = z.infer<typeof freelanceMemorySchema>;
export const freelanceMemoryCreateSchema = z.object({
  kind: freelanceMemoryKindSchema,
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  channel: freelanceChannelSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  pinned: z.boolean().default(false)
}).strict();
export type FreelanceMemoryCreate = z.infer<typeof freelanceMemoryCreateSchema>;
export const freelanceMemoryUpdateSchema = z.object({ text: z.string().trim().min(1).max(4000).optional(), pinned: z.boolean().optional() }).strict();
export const freelanceMemoryQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  kinds: z.array(freelanceMemoryKindSchema).max(FREELANCE_MEMORY_KINDS.length).optional(),
  channel: freelanceChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
}).strict();
export type FreelanceMemoryQuery = z.infer<typeof freelanceMemoryQuerySchema>;

// Activity. BRIEF (the operator's request) and MAIL (a new mail in work@example.invalid) are the agent's work items.
export const FREELANCE_EVENT_TYPES = [
  "BRIEF", "MAIL", "LEAD_ADDED", "LEAD_UPDATED", "MESSAGE_DRAFTED", "MESSAGE_RECEIVED", "REVIEW_REQUESTED", "REVIEW_DECIDED", "SENDING", "SENT", "SEND_FAILED",
  "CLIENT_READY", "LEAD_DECIDED", "ACCOUNT_UPDATED", "QUESTION", "ANSWERED", "NEEDS_USER", "RULE_PROPOSED", "RULE_DECIDED", "RULE_APPLIED",
  "DIGEST", "NOTE", "RUN_STARTED", "RUN_PAUSED", "RUN_RESUMED", "RUN_STOPPED"
] as const;
export const freelanceEventTypeSchema = z.enum(FREELANCE_EVENT_TYPES);
export type FreelanceEventType = z.infer<typeof freelanceEventTypeSchema>;
export const freelanceEventSchema = z.object({
  id: freelanceEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  runId: freelanceRunIdSchema.nullable(),
  leadId: freelanceLeadIdSchema.nullable(),
  messageId: freelanceMessageIdSchema.nullable(),
  type: freelanceEventTypeSchema,
  /** Work-item state of a BRIEF or MAIL the agent still has to handle; null for plain activity. */
  status: z.enum(["PENDING", "TAKEN", "DONE"]).nullable(),
  message: z.string().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type FreelanceEvent = z.infer<typeof freelanceEventSchema>;
export const freelanceEventListQuerySchema = z.object({
  paneId: paneIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
export const freelanceBriefSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  leadId: freelanceLeadIdSchema.nullable().optional(),
  channels: z.array(freelanceChannelSchema).max(FREELANCE_CHANNELS.length).default([])
}).strict();

export const freelanceRunCountersSchema = z.object({
  taken: z.number().int().min(0).default(0),
  drafted: z.number().int().min(0).default(0),
  sent: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  needsUser: z.number().int().min(0).default(0)
}).strict();
export type FreelanceRunCounters = z.infer<typeof freelanceRunCountersSchema>;
export const freelanceRunSchema = z.object({
  id: freelanceRunIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema,
  status: z.enum(["RUNNING", "PAUSED", "STOPPED"]),
  counters: freelanceRunCountersSchema,
  kickoffSentAt: isoDateTime.nullable(),
  startedAt: isoDateTime,
  stoppedAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type FreelanceRun = z.infer<typeof freelanceRunSchema>;
/** Something waiting for the operator in the rail. */
export const freelancePendingItemSchema = z.object({
  kind: z.enum(["CLIENT_READY", "REVIEW", "QUESTION", "RULE", "ACCOUNT"]),
  id: z.string().min(1).max(200),
  message: z.string().max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type FreelancePendingItem = z.infer<typeof freelancePendingItemSchema>;
export const freelanceRunViewSchema = z.object({
  run: freelanceRunSchema.nullable(),
  status: z.enum(["IDLE", "RUNNING", "PAUSED", "STOPPED"]),
  pending: z.array(freelancePendingItemSchema).max(200),
  /** Briefs and mails not yet taken plus follow-ups and approved messages that are due. */
  backlog: z.number().int().min(0)
}).strict();
export type FreelanceRunView = z.infer<typeof freelanceRunViewSchema>;

export const freelanceQuestionAskSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  leadId: freelanceLeadIdSchema.optional()
}).strict();
export const freelanceQuestionAnswerSchema = z.object({ questionId: freelanceQuestionIdSchema, answer: z.string().trim().min(1).max(4000) }).strict();

/** RULES autonomy: the agent may send alone a message matching an approved rule (channel and kinds). */
export const FREELANCE_RULE_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "RETIRED"] as const;
export const freelanceRuleSchema = z.object({
  id: freelanceRuleIdSchema,
  ownerUserId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  channel: freelanceChannelSchema,
  /** Empty: every kind of message on the channel. */
  kinds: z.array(freelanceMessageKindSchema).max(FREELANCE_MESSAGE_KINDS.length),
  status: z.enum(FREELANCE_RULE_STATUSES),
  evidence: z.array(z.string().max(300)).max(20),
  proposedBy: z.enum(["AGENT", "USER"]),
  appliedCount: z.number().int().min(0),
  lastAppliedAt: isoDateTime.nullable(),
  decidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type FreelanceRule = z.infer<typeof freelanceRuleSchema>;
export const freelanceRuleProposalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: freelanceChannelSchema,
  kinds: z.array(freelanceMessageKindSchema).max(FREELANCE_MESSAGE_KINDS.length).default([]),
  evidence: z.array(z.string().trim().min(1).max(300)).max(20).default([])
}).strict();
export type FreelanceRuleProposal = z.infer<typeof freelanceRuleProposalSchema>;
export const freelanceRuleDecisionSchema = z.object({ decision: z.enum(["approve", "reject", "retire"]) }).strict();
export function freelanceRuleMatches(rule: Pick<FreelanceRule, "channel" | "kinds">, message: Pick<FreelanceMessage, "channel" | "kind">): boolean {
  return rule.channel === message.channel && (rule.kinds.length === 0 || rule.kinds.includes(message.kind));
}

/** Whether a URL is an https page of the channel: the evidence a sent proposal or message needs. */
export function freelanceUrlMatchesChannel(raw: string, channelId: FreelanceChannel): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return FREELANCE_CHANNEL_HOSTS[channelId].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// ---- wording and scam checks ------------------------------------------------------------------------
/** Links a message may carry before a contract: the platform itself, the operator's own sites and code. */
const FREELANCE_ALLOWED_LINK_HOSTS = ["oll4.com", "spaceapp.dev", "github.com", "loom.com", "npmjs.com"];
const OFF_PLATFORM_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "email-address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: "phone-number", pattern: /(?:\+|\b00)\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/ },
  { id: "messenger", pattern: /\b(?:telegram|whats\s?app|skype|discord|wechat|viber)\b/i },
  { id: "off-platform-payment", pattern: /\b(?:pay(?:ment)?\s+(?:me\s+)?(?:directly|outside|off[- ]platform)|paypal|western union|wire (?:me|it) directly)\b/i }
];
/**
 * What keeps a message from going out on its own: unqualified absolute claims (the Marketing Copilot rules), and
 * before a contract (lead not WON) contact or payment outside the platform and links off the allowed hosts.
 * A proposal's hourly bid under the floor is flagged too.
 */
export function freelanceWordingIssues(text: string, input: { channel: FreelanceChannel; contracted: boolean; bid?: FreelanceBid | null; rateFloorHourly?: number }): string[] {
  const issues = new Set(marketingWordingIssues(text));
  if (!input.contracted) {
    for (const rule of OFF_PLATFORM_RULES) if (rule.pattern.test(text)) issues.add(rule.id);
    const allowed = [...FREELANCE_CHANNEL_HOSTS[input.channel], ...FREELANCE_ALLOWED_LINK_HOSTS];
    for (const match of text.matchAll(/https?:\/\/[^\s)<>"']+/gi)) {
      let host = "";
      try { host = new URL(match[0]).hostname.toLowerCase(); } catch { issues.add("outside-link"); continue; }
      if (!allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))) issues.add("outside-link");
    }
  }
  if (input.bid?.type === "HOURLY" && input.bid.amount < (input.rateFloorHourly ?? 35)) issues.add("below-rate-floor");
  return [...issues];
}

/** Signs of a scam in a job post or a client's message (Research Council 2026-10-14): such leads need the operator. */
export const FREELANCE_SCAM_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "move-to-messenger", pattern: /\b(?:telegram|whats\s?app|wechat|skype)\b/i },
  { id: "unpaid-test", pattern: /\b(?:unpaid|free)\s+(?:test|trial|sample)\b|\btest task\b[^.]{0,60}\b(?:unpaid|free|no pay)/i },
  { id: "cheque-or-equipment", pattern: /\b(?:cheque|check deposit|buy (?:the )?equipment|purchase (?:the )?equipment|gift cards?)\b/i },
  { id: "crypto-only", pattern: /\b(?:paid|pay(?:ment)?) (?:only )?in (?:crypto|usdt|bitcoin|btc|eth)\b|\bcrypto only\b/i },
  { id: "account-use", pattern: /\b(?:use|rent|borrow) (?:your|ur) (?:upwork |fiverr )?account\b|\baccount (?:rental|sharing)\b/i }
];
export function freelanceScamSignals(text: string): string[] {
  return FREELANCE_SCAM_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

// ---- mailbox --------------------------------------------------------------------------------------
/** The IMAP mailbox (work@example.invalid) the copilot reads codes, job alerts and client notifications from. */
export const freelanceMailboxConfigSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(200)
}).strict();
export type FreelanceMailboxConfig = z.infer<typeof freelanceMailboxConfigSchema>;
export const freelanceMailboxInputSchema = freelanceMailboxConfigSchema.extend({ password: z.string().min(1).max(500) }).strict();
export type FreelanceMailboxInput = z.infer<typeof freelanceMailboxInputSchema>;
/** Which platform a mail comes from: its sender's domain (donotreply@upwork.com is Upwork). */
export function freelanceChannelOfSender(from: string): FreelanceChannel | null {
  const host = from.toLowerCase().split("@").pop()?.replace(/[>\s]+$/, "") ?? "";
  return FREELANCE_CHANNELS.find((id) => FREELANCE_CHANNEL_HOSTS[id].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) ?? null;
}

// ---- browser egress ---------------------------------------------------------------------------------
const pacTarget = (route: FreelanceEgressRoute) => route === "direct" ? "DIRECT" : `SOCKS5 ${FREELANCE_EGRESS_PROXIES[route]}`;
/** The route a platform leaves from, its own or the pane's. */
export function freelanceChannelEgress(settings: Pick<FreelanceCopilotPaneSettings, "browserEgress" | "channels">, channelId: FreelanceChannel): FreelanceEgressRoute {
  const own = settings.channels[channelId].egress;
  return own === "pane" ? settings.browserEgress : own;
}
/**
 * The pane browser's proxy auto-config: each platform's hosts to its route, everything else to the pane's route,
 * localhost direct. Never a DIRECT fallback after a proxy: a route that is down fails closed. Null when every
 * route is direct (no proxy at all).
 */
export function freelanceEgressPac(settings: Pick<FreelanceCopilotPaneSettings, "browserEgress" | "channels">): string | null {
  const rules = FREELANCE_CHANNELS.flatMap((id) => [...FREELANCE_CHANNEL_HOSTS[id], ...(FREELANCE_CHANNEL_EXTRA_HOSTS[id] ?? [])].map((host) => [host, pacTarget(freelanceChannelEgress(settings, id))] as const));
  const fallback = pacTarget(settings.browserEgress);
  if (fallback === "DIRECT" && rules.every(([, target]) => target === "DIRECT")) return null;
  return [
    "function FindProxyForURL(url, host) {",
    "  host = host.toLowerCase();",
    "  if (host === \"localhost\" || host === \"127.0.0.1\" || host === \"[::1]\") return \"DIRECT\";",
    `  var rules = ${JSON.stringify(rules)};`,
    "  for (var i = 0; i < rules.length; i++) { var d = rules[i][0]; if (host === d || dnsDomainIs(host, \".\" + d)) return rules[i][1]; }",
    `  return ${JSON.stringify(fallback)};`,
    "}"
  ].join("\n");
}

// ---- funnel -----------------------------------------------------------------------------------------
export const freelanceFunnelSchema = z.object({
  channels: z.record(z.string(), z.object({
    leads: z.number().int().min(0), proposed: z.number().int().min(0), talking: z.number().int().min(0),
    clientReady: z.number().int().min(0), won: z.number().int().min(0), lost: z.number().int().min(0), sent: z.number().int().min(0)
  }).strict()),
  connectsToday: z.number().int().min(0),
  connectsMonth: z.number().int().min(0),
  revenue: z.number().min(0),
  firstSentAt: isoDateTime.nullable()
}).strict();
export type FreelanceFunnel = z.infer<typeof freelanceFunnelSchema>;
