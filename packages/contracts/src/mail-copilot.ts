import { z } from "zod";

// Mail Copilot pane: a native Gmail client over the operator's Google connector accounts and a CLI
// agent session that sees the same mailboxes. Pane metadata holds pane-level settings and the operator's
// current view (the CLI account lives in the pane's CLI session, like Job Copilot); memory, events, rules,
// reviews and sync cursors are per-owner records.
export const MAIL_COPILOT_PANE_MODE = "MAIL_COPILOT" as const;

/**
 * How far the agent acts alone. ASSIST: drafts and review requests only, the operator sends.
 * RULES: sends and triages alone only under rules the operator approved. FULL: acts on its own judgement.
 */
export const MAIL_COPILOT_AUTONOMY_LEVELS = ["ASSIST", "RULES", "FULL"] as const;
export const mailCopilotAutonomySchema = z.enum(MAIL_COPILOT_AUTONOMY_LEVELS);
export type MailCopilotAutonomy = z.infer<typeof mailCopilotAutonomySchema>;

const emailSchema = z.string().trim().min(3).max(320);

export const mailCopilotPaneSettingsSchema = z.object({
  autonomy: mailCopilotAutonomySchema.default("ASSIST"),
  /** The copilot opens no new work item while paused; the mail client keeps working. */
  paused: z.boolean().default(false),
  /** Google accounts this pane works with; empty means every account allowed for Space. */
  accounts: z.array(emailSchema).max(20).default([]),
  /** How far back a fresh run looks for untriaged inbox mail. */
  backlogHours: z.number().int().min(1).max(24 * 14).default(24),
  /** Hard cap on messages the agent may send per hour, whatever the autonomy level. */
  sendsPerHour: z.number().int().min(0).max(200).default(20),
  /** Appended to replies the agent drafts; null keeps Gmail's own signature out of the draft text. */
  signature: z.string().max(2000).nullable().default(null),
  /** Which moments raise notifications for this pane. */
  notifications: z.object({
    newMail: z.boolean().default(true),
    needsYou: z.boolean().default(true),
    telegram: z.boolean().default(false),
    /** Accounts whose new mail raises no notification (the copilot still sees it). */
    mutedAccounts: z.array(emailSchema).max(20).default([])
  }).strict().default({ newMail: true, needsYou: true, telegram: false, mutedAccounts: [] })
}).strict();
export type MailCopilotPaneSettings = z.infer<typeof mailCopilotPaneSettingsSchema>;

/** What the operator looks at in the pane; the agent reads it to act on "this email". */
export const mailCopilotViewSchema = z.object({
  account: z.union([z.literal("all"), emailSchema]).default("all"),
  labelId: z.string().min(1).max(200).default("INBOX"),
  threadId: z.string().min(1).max(200).nullable().default(null),
  messageId: z.string().min(1).max(200).nullable().default(null),
  query: z.string().max(500).nullable().default(null),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type MailCopilotView = z.infer<typeof mailCopilotViewSchema>;

export const mailCopilotPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: mailCopilotPaneSettingsSchema,
  view: mailCopilotViewSchema.optional()
}).strict();
export type MailCopilotPaneMetadata = z.infer<typeof mailCopilotPaneMetadataSchema>;

export function defaultMailCopilotPaneMetadata(): MailCopilotPaneMetadata {
  return mailCopilotPaneMetadataSchema.parse({ version: 1, settings: {} });
}

/** Panes created before the column existed, or never configured, read as defaults. */
export function resolveMailCopilotPaneMetadata(metadata: MailCopilotPaneMetadata | null | undefined): MailCopilotPaneMetadata {
  return metadata ? mailCopilotPaneMetadataSchema.parse(metadata) : defaultMailCopilotPaneMetadata();
}

// Memory kinds the copilot learns from the operator: who people are, how the operator writes,
// reusable replies, facts, lessons from edits and rejections, and standing preferences.
export const MAIL_COPILOT_MEMORY_KINDS = ["CONTACT", "STYLE", "TEMPLATE", "FACT", "LESSON", "PREFERENCE"] as const;
export const mailCopilotMemoryKindSchema = z.enum(MAIL_COPILOT_MEMORY_KINDS);
export type MailCopilotMemoryKind = z.infer<typeof mailCopilotMemoryKindSchema>;

// Activity events: what arrived, what the operator did, what the agent did, asked and proposed.
export const MAIL_COPILOT_EVENT_TYPES = [
  "MAIL_RECEIVED", "USER_ACTION", "TRIAGED", "DRAFTED", "REPLIED", "SENT", "ARCHIVED", "TRASHED", "LABELED", "STARRED", "SKIPPED",
  "NEEDS_USER", "QUESTION", "ANSWERED", "REVIEW_REQUESTED", "REVIEW_DECIDED", "RULE_PROPOSED", "RULE_DECIDED", "RULE_APPLIED",
  "SYNC_RESET", "NOTE", "RUN_STARTED", "RUN_PAUSED", "RUN_RESUMED", "RUN_STOPPED", "RUN_FINISHED",
  /** A work item the run loop made from an untriaged inbox conversation (the backlog scan). */
  "TRIAGE",
  /** A rule the server learned from consistent operator actions, and one it retired when the operator acted otherwise. */
  "RULE_LEARNED", "RULE_RETIRED",
  /** The operator (or a learned FIX rule) handed a mail to the copilot to check and fix what it needs; and its outcome. */
  "FIX_REQUESTED", "FIXED"
] as const;
export const mailCopilotEventTypeSchema = z.enum(MAIL_COPILOT_EVENT_TYPES);
export type MailCopilotEventType = z.infer<typeof mailCopilotEventTypeSchema>;

export const MAIL_COPILOT_RUN_STATUSES = ["IDLE", "RUNNING", "PAUSED", "STOPPED"] as const;
export const mailCopilotRunStatusSchema = z.enum(MAIL_COPILOT_RUN_STATUSES);
export type MailCopilotRunStatus = z.infer<typeof mailCopilotRunStatusSchema>;

// Rules: a condition on a message and the action the agent may take alone once the operator approved the rule.
export const mailRuleConditionSchema = z.object({
  /** The sender's exact address (case-insensitive). */
  fromAddress: z.string().trim().min(3).max(320).optional(),
  /** Case-insensitive substring of the From header (address or display name). */
  fromContains: z.string().trim().min(1).max(200).optional(),
  /** Sender domain, e.g. "example.com" (subdomains match). */
  domain: z.string().trim().min(1).max(200).optional(),
  /** Any of these Gmail label ids on the message. */
  labelAny: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  /** Case-insensitive regular expression tested against the subject. */
  subjectPattern: z.string().min(1).max(300).optional(),
  hasAttachment: z.boolean().optional()
}).strict().refine((condition) => Object.keys(condition).length > 0, "A rule needs at least one condition.");
export type MailRuleCondition = z.infer<typeof mailRuleConditionSchema>;

export const MAIL_RULE_ACTION_TYPES = ["REPLY", "ARCHIVE", "LABEL", "MOVE", "STAR", "TRASH", "MARK_READ", "FIX"] as const;
export const mailRuleActionSchema = z.object({
  type: z.enum(MAIL_RULE_ACTION_TYPES),
  /** REPLY: the TEMPLATE memory the reply follows. */
  templateMemoryId: z.string().regex(/^mailmem:[A-Za-z0-9_-]{6,80}$/).optional(),
  /** LABEL / MOVE: the Gmail label ids to add (MOVE also leaves the inbox); the copilot may add only these. */
  labels: z.array(z.string().min(1).max(200)).max(10).optional()
}).strict();
export type MailRuleAction = z.infer<typeof mailRuleActionSchema>;

export const MAIL_RULE_STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "RETIRED"] as const;
export const mailRuleStatusSchema = z.enum(MAIL_RULE_STATUSES);
export const mailRuleIdSchema = z.string().regex(/^mailrule:[A-Za-z0-9_-]{6,80}$/);
export const mailRuleSchema = z.object({
  id: mailRuleIdSchema,
  ownerUserId: z.string().min(1),
  /** The account the rule applies to; null means every account of the owner. */
  accountEmail: z.string().max(320).nullable(),
  name: z.string().min(1).max(200),
  condition: mailRuleConditionSchema,
  action: mailRuleActionSchema,
  status: mailRuleStatusSchema,
  confidence: z.number().min(0).max(1),
  /** What the proposal rests on: short lines (an operator action, a thread) the operator reads before approving. */
  evidence: z.array(z.string().max(300)).max(20),
  /** LEARNED: the server made it from consistent operator actions on one account. */
  proposedBy: z.enum(["AGENT", "USER", "LEARNED"]),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  appliedCount: z.number().int().min(0),
  lastAppliedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type MailRule = z.infer<typeof mailRuleSchema>;
/** The agent proposes after seeing the same operator action on the same kind of mail; the operator creates one directly (APPROVED). */
export const mailRuleProposalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  accountEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  condition: mailRuleConditionSchema,
  action: mailRuleActionSchema,
  confidence: z.number().min(0).max(1).default(0.7),
  evidence: z.array(z.string().trim().min(1).max(300)).max(20).default([])
}).strict();
export type MailRuleProposal = z.infer<typeof mailRuleProposalSchema>;
export const mailRuleDecisionSchema = z.object({ decision: z.enum(["approve", "reject", "retire"]) }).strict();
export type MailRuleDecision = z.infer<typeof mailRuleDecisionSchema>;
/** Sync state of one Gmail account: the last history id Space saw, so new mail is read incrementally. */
export const mailCopilotSyncStateSchema = z.object({
  ownerUserId: z.string().min(1),
  accountEmail: z.string().max(320),
  historyId: z.string().max(40).nullable(),
  lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().max(1000).nullable(),
  consecutiveFailures: z.number().int().min(0),
  /** The first look at the mailbox (the last 30 days, inferred habits) runs in steps: where it continues, and when it finished. */
  backfillPageToken: z.string().max(4000).nullable(),
  backfillDoneAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type MailCopilotSyncState = z.infer<typeof mailCopilotSyncStateSchema>;

/** The message facts a rule is checked against; the server builds them from Gmail metadata, the UI from a thread row. */
export interface MailRuleSubject {
  from: string;
  subject: string;
  labelIds: readonly string[];
  hasAttachment: boolean;
}

function senderAddress(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}
function senderDomain(from: string): string {
  return senderAddress(from).split("@").at(-1)?.trim() ?? "";
}

/** Whether every condition of the rule holds for the message (pure; shared by the server gate and the UI preview). */
export function mailRuleMatches(condition: MailRuleCondition, message: MailRuleSubject): boolean {
  const from = message.from.toLowerCase();
  if (condition.fromAddress !== undefined && senderAddress(message.from) !== condition.fromAddress.toLowerCase()) return false;
  if (condition.fromContains !== undefined && !from.includes(condition.fromContains.toLowerCase())) return false;
  if (condition.domain !== undefined) {
    const domain = condition.domain.toLowerCase().replace(/^@/, "");
    const actual = senderDomain(message.from);
    if (actual !== domain && !actual.endsWith(`.${domain}`)) return false;
  }
  if (condition.labelAny !== undefined && !condition.labelAny.some((label) => message.labelIds.includes(label))) return false;
  if (condition.subjectPattern !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(condition.subjectPattern, "i");
    } catch {
      return false;
    }
    if (!pattern.test(message.subject)) return false;
  }
  if (condition.hasAttachment !== undefined && condition.hasAttachment !== message.hasAttachment) return false;
  return true;
}

/** The pane reports what the operator looks at; the server stamps `updatedAt`. */
export const mailCopilotViewInputSchema = mailCopilotViewSchema.omit({ updatedAt: true });
export type MailCopilotViewInput = z.infer<typeof mailCopilotViewInputSchema>;

/** Where Mail Copilot asks Google for an account's mail: full Gmail access on top of what Space already has. */
export const MAIL_COPILOT_CONSENT_CAPABILITIES = ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"] as const;
export function mailCopilotConsentUrl(loginHint?: string | null): string {
  const params = new URLSearchParams({ capabilities: MAIL_COPILOT_CONSENT_CAPABILITIES.join(","), source: "mail-copilot" });
  if (loginHint) params.set("loginHint", loginHint);
  return `/api/connectors/google/start?${params.toString()}`;
}

// ---- The mailbox as the pane and the agent see it (one shape for every account) -----------------

export const mailAccountSummarySchema = z.object({
  email: emailSchema,
  /** What Space may do with the account's Gmail; "full" (gmail.modify) is what the mailbox needs. */
  access: z.enum(["full", "read", "none"]),
  /** Whether this pane works with the account (Setup → Accounts). */
  inPane: z.boolean(),
  /** INBOX unread count when the account answered; null when it did not. */
  unread: z.number().int().min(0).nullable(),
  error: z.string().max(300).nullable()
}).strict();
export type MailAccountSummary = z.infer<typeof mailAccountSummarySchema>;

export const mailLabelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  type: z.enum(["system", "user"]),
  unread: z.number().int().min(0).nullable()
}).strict();
export type MailLabel = z.infer<typeof mailLabelSchema>;

export const mailParticipantSchema = z.object({ name: z.string().max(300), address: z.string().max(320) }).strict();
export type MailParticipant = z.infer<typeof mailParticipantSchema>;

export const mailThreadSummarySchema = z.object({
  account: emailSchema,
  threadId: z.string().min(1).max(200),
  /** The newest message of the thread. */
  messageId: z.string().min(1).max(200),
  from: mailParticipantSchema,
  subject: z.string().max(1000),
  snippet: z.string().max(500),
  receivedAt: z.string().datetime({ offset: true }).nullable(),
  unread: z.boolean(),
  starred: z.boolean(),
  hasAttachment: z.boolean(),
  messageCount: z.number().int().min(1),
  labelIds: z.array(z.string()).max(50)
}).strict();
export type MailThreadSummary = z.infer<typeof mailThreadSummarySchema>;

export const mailThreadsQuerySchema = z.object({
  /** One account, or "all" for the unified view over the pane's accounts. */
  account: z.union([z.literal("all"), emailSchema]).default("all"),
  labelId: z.string().min(1).max(200).default("INBOX"),
  /** Gmail search syntax; with a query the label still scopes the search unless it is ALL. */
  q: z.string().trim().max(500).optional(),
  pageToken: z.string().max(4000).optional(),
  max: z.number().int().min(1).max(50).default(25)
}).strict();
export type MailThreadsQuery = z.infer<typeof mailThreadsQuerySchema>;

export const mailThreadsPageSchema = z.object({
  threads: z.array(mailThreadSummarySchema),
  nextPageToken: z.string().nullable(),
  /** Accounts that did not answer, with why; the page still holds the others. */
  errors: z.array(z.object({ account: emailSchema, message: z.string().max(300) }).strict())
}).strict();
export type MailThreadsPage = z.infer<typeof mailThreadsPageSchema>;

export const mailAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(400),
  filename: z.string().max(300),
  mimeType: z.string().max(200),
  size: z.number().int().min(0),
  /** Content-ID of an inline image, so the reader can map `cid:` references. */
  contentId: z.string().max(300).nullable()
}).strict();
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

export const mailMessageSchema = z.object({
  account: emailSchema,
  messageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  from: mailParticipantSchema,
  to: z.array(mailParticipantSchema).max(100),
  cc: z.array(mailParticipantSchema).max(100),
  replyTo: z.array(mailParticipantSchema).max(20),
  subject: z.string().max(1000),
  receivedAt: z.string().datetime({ offset: true }).nullable(),
  /** RFC 2822 Message-ID header, for threading replies. */
  rfcMessageId: z.string().max(1000).nullable(),
  references: z.string().max(20_000).nullable(),
  labelIds: z.array(z.string()).max(50),
  unread: z.boolean(),
  starred: z.boolean(),
  /** Plain text (the text/plain part, or the HTML as text); what the agent reads. */
  text: z.string().max(200_000),
  /** Sanitized HTML for the reader, null when the message has no HTML part. */
  html: z.string().max(2_000_000).nullable(),
  /** The sanitized HTML references remote images that were not loaded. */
  blockedImages: z.boolean(),
  attachments: z.array(mailAttachmentSchema).max(100)
}).strict();
export type MailMessage = z.infer<typeof mailMessageSchema>;

export const mailThreadSchema = z.object({
  account: emailSchema,
  threadId: z.string().min(1).max(200),
  subject: z.string().max(1000),
  messages: z.array(mailMessageSchema).max(200)
}).strict();
export type MailThread = z.infer<typeof mailThreadSchema>;

const addressListSchema = z.array(z.string().trim().email().max(320)).max(50);
export const mailComposeInputSchema = z.object({
  account: emailSchema,
  to: addressListSchema.min(1),
  cc: addressListSchema.default([]),
  bcc: addressListSchema.default([]),
  subject: z.string().max(1000),
  text: z.string().max(100_000),
  /** Reply or forward: the thread the message joins and the message it answers (threading headers come from it). */
  threadId: z.string().min(1).max(200).optional(),
  inReplyToMessageId: z.string().min(1).max(200).optional()
}).strict();
export type MailComposeInput = z.infer<typeof mailComposeInputSchema>;

export const mailThreadActionSchema = z.object({
  account: emailSchema,
  action: z.enum(["archive", "unarchive", "trash", "untrash", "star", "unstar", "read", "unread", "label", "unlabel", "move"]),
  /** label / unlabel / move: the Gmail label ids (or a label's name, resolved per account). */
  labelIds: z.array(z.string().min(1).max(200)).max(10).optional()
}).strict();
export type MailThreadAction = z.infer<typeof mailThreadActionSchema>;

/** The Gmail label changes behind one action; archive leaves the inbox, read clears UNREAD, and so on. */
export function mailThreadActionLabels(input: Pick<MailThreadAction, "action" | "labelIds">): { addLabelIds: string[]; removeLabelIds: string[] } {
  switch (input.action) {
    case "archive": return { addLabelIds: [], removeLabelIds: ["INBOX"] };
    case "unarchive": return { addLabelIds: ["INBOX"], removeLabelIds: [] };
    case "star": return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar": return { addLabelIds: [], removeLabelIds: ["STARRED"] };
    case "read": return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "unread": return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "label": return { addLabelIds: input.labelIds ?? [], removeLabelIds: [] };
    case "unlabel": return { addLabelIds: [], removeLabelIds: input.labelIds ?? [] };
    case "move": return { addLabelIds: input.labelIds ?? [], removeLabelIds: ["INBOX"] };
    default: return { addLabelIds: [], removeLabelIds: [] };
  }
}

/** Gmail's fixed labels in the order the rail shows them; everything else is a user label. */
export const MAIL_SYSTEM_LABELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "INBOX", name: "Inbox" }, { id: "STARRED", name: "Starred" }, { id: "IMPORTANT", name: "Important" }, { id: "SENT", name: "Sent" },
  { id: "DRAFT", name: "Drafts" }, { id: "ALL", name: "All mail" }, { id: "SPAM", name: "Spam" }, { id: "TRASH", name: "Trash" }
];

// ---- What the operator does to mail, per account: the copilot learns its habits from this log -------------

/** One thing done to a conversation: archive, trash, a move to a label (folder), a star, spam, a reply… */
/** FIX: handed to the copilot to check and fix what the mail needs ("Send to AI"). */
export const MAIL_OPERATOR_ACTIONS = ["ARCHIVE", "UNARCHIVE", "TRASH", "UNTRASH", "DELETE", "MOVE", "LABEL", "UNLABEL", "STAR", "UNSTAR", "SPAM", "NOT_SPAM", "REPLY", "FORWARD", "FIX"] as const;
export const mailOperatorActionSchema = z.enum(MAIL_OPERATOR_ACTIONS);
export type MailOperatorAction = z.infer<typeof mailOperatorActionSchema>;
export const mailActionRecordSchema = z.object({
  id: z.string().regex(/^mailact:[A-Za-z0-9_-]{6,80}$/),
  ownerUserId: z.string().min(1).max(200),
  accountEmail: z.string().max(320),
  threadId: z.string().min(1).max(200),
  messageId: z.string().max(200).nullable(),
  action: mailOperatorActionSchema,
  labelIds: z.array(z.string().min(1).max(200)).max(20),
  /** The correspondent: who sent the mail acted on (for a reply, whom it answers). */
  fromAddress: z.string().max(320).nullable(),
  fromDomain: z.string().max(200).nullable(),
  subject: z.string().max(1000).nullable(),
  subjectKey: z.string().max(200).nullable(),
  /** Who did it: the operator, the copilot, or another part of Space (Job Copilot's triage). */
  actor: z.enum(["OPERATOR", "AGENT", "SPACE"]),
  /** How Space knows: a pane action, Gmail's history (web, phone) or the initial look at the mailbox (inferred). */
  source: z.enum(["PANE", "GMAIL", "BACKFILL", "SPACE"]),
  ruleId: z.string().max(100).nullable(),
  occurredAt: z.string().datetime({ offset: true })
}).strict();
export type MailActionRecord = z.infer<typeof mailActionRecordSchema>;

/** A mail sent to the copilot to check and fix, as the pane follows it: the request, the copilot's questions with the operator's answers, and the result. */
export interface MailFixRequestView {
  id: string;
  account: string | null;
  threadId: string | null;
  subject: string;
  from: string | null;
  /** What the operator asked (the note of "Send to AI"), if anything. */
  note: string | null;
  /** operator: the operator's click; rule: a FIX rule sent it on its own. */
  by: "operator" | "rule";
  status: "PENDING" | "TAKEN" | "DONE";
  requestedAt: string;
  exchanges: Array<{ question: string; askedAt: string; answer: string | null; answeredAt: string | null }>;
  /** The copilot's report: FIXED, NEEDS_USER, SKIPPED…, with its summary. */
  outcome: { type: MailCopilotEventType; summary: string; at: string } | null;
  /** The memory the fix taught the copilot (how this kind of mail is fixed), when it was fixed. */
  memoryId: string | null;
}
/** One row of the action log as the pane shows it, with the account's label names. */
export type MailActionLogEntry = MailActionRecord & { labelNames: string[] };
/** How the operator handled one kind of mail on one account: per action (and labels) how often, and when last. */
export interface MailHabitLevel {
  level: "sender" | "subject" | "domain";
  key: string;
  /** Decisions counted (where mail went: archive, trash, move, label, spam); observed ones only. */
  decisions: number;
  actions: Array<{ action: MailOperatorAction; labels: Array<{ id: string; name: string }>; observed: number; inferred: number; share: number | null; lastAt: string }>;
}
/** What the copilot gets with each mail: the operator's habits with its sender, subject shape and domain on that account. */
export interface MailHabits {
  account: string;
  sender: string;
  domain: string;
  subjectKey: string | null;
  /** One line per level for a quick read, e.g. "anna@acme.com on info@example.invalid: moved to Clients 4 of 5 (80%); replied to once". */
  summary: string[];
  levels: MailHabitLevel[];
  examples: Array<{ action: MailOperatorAction; subject: string | null; source: MailActionRecord["source"]; at: string }>;
}
/** One sender's habit on one account, as the Memory tab lists it. */
export interface MailHabitSender {
  account: string;
  sender: string;
  summary: string;
  level: MailHabitLevel;
  lastAt: string;
}

const REPLY_PREFIX = /^\s*(re|fwd?|aw|wg|απ|σχετ|πρθ)\s*(\[\d+\])?\s*:\s*/iu;
/**
 * The shape of a subject, so mail of one kind groups together: lowercase, reply prefixes dropped, every run of
 * digits as "0" ("[Olla] [Ticket - #34470872]" → "[olla] [ticket - #0]").
 */
export function mailSubjectKey(subject: string): string {
  let text = subject.normalize("NFC").trim();
  for (let next = text.replace(REPLY_PREFIX, ""); next !== text; next = text.replace(REPLY_PREFIX, "")) text = next;
  return text.toLowerCase().replace(/\d+/g, "0").replace(/\s+/g, " ").trim().slice(0, 200);
}
/** A rule's subject pattern for a subject key: the start of the subject, any digits where the key has "0" (fits the 300-character limit). */
export function mailSubjectKeyPattern(key: string): string {
  const words = key.split(" ").filter(Boolean);
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/0/g, "\\d+");
  let pattern = "^(?:(?:re|fwd?|aw|wg|απ|σχετ)\\s*:\\s*)*";
  for (const [index, word] of words.entries()) {
    const next = `${pattern}${index ? "\\s+" : ""}${escape(word)}`;
    if (next.length > 300) break;
    pattern = next;
  }
  return pattern;
}

// ---- The agent's side: memory, activity, runs, questions and reviews ---------------------------------

const mailMemoryIdSchema = z.string().regex(/^mailmem:[A-Za-z0-9_-]{6,80}$/);
const mailEventIdSchema = z.string().regex(/^mailevt:[A-Za-z0-9_-]{6,80}$/);
const mailRunIdSchema = z.string().regex(/^mailrun:[A-Za-z0-9_-]{6,80}$/);
const paneIdSchema = z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/);
const isoDateTime = z.string().datetime({ offset: true });

export const MAIL_COPILOT_MEMORY_SOURCES = ["USER", "AGENT", "LEARNED"] as const;
export const mailCopilotMemorySourceSchema = z.enum(MAIL_COPILOT_MEMORY_SOURCES);
export const mailCopilotMemorySchema = z.object({
  id: mailMemoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: mailCopilotMemoryKindSchema,
  /** One memory per key and scope (a contact's address, a template name, a style facet). */
  key: z.string().min(1).max(300).nullable(),
  text: z.string().min(1).max(4000),
  contactEmail: z.string().max(320).nullable(),
  domain: z.string().max(200).nullable(),
  accountEmail: z.string().max(320).nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20),
  source: mailCopilotMemorySourceSchema,
  confidence: z.number().min(0).max(1),
  uses: z.number().int().min(0),
  pinned: z.boolean(),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailCopilotMemory = z.infer<typeof mailCopilotMemorySchema>;

export const mailCopilotMemoryCreateSchema = z.object({
  kind: mailCopilotMemoryKindSchema,
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  contactEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  domain: z.string().trim().toLowerCase().min(1).max(200).nullable().optional(),
  accountEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  source: mailCopilotMemorySourceSchema.default("AGENT"),
  confidence: z.number().min(0).max(1).default(0.8),
  pinned: z.boolean().default(false)
}).strict();
export type MailCopilotMemoryCreate = z.infer<typeof mailCopilotMemoryCreateSchema>;

export const mailCopilotMemoryUpdateSchema = z.object({
  kind: mailCopilotMemoryKindSchema.optional(),
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional()
}).strict();
export type MailCopilotMemoryUpdate = z.infer<typeof mailCopilotMemoryUpdateSchema>;

export const mailCopilotMemoryQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  kinds: z.array(mailCopilotMemoryKindSchema).max(6).optional(),
  contactEmail: z.string().trim().toLowerCase().max(320).optional(),
  domain: z.string().trim().toLowerCase().max(200).optional(),
  pinnedOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();
export type MailCopilotMemoryQuery = z.infer<typeof mailCopilotMemoryQuerySchema>;

/** Work-item state of an event: a MAIL_RECEIVED, TRIAGE or USER_ACTION row the agent still has to handle. */
export const MAIL_COPILOT_ITEM_STATUSES = ["PENDING", "TAKEN", "DONE"] as const;
export const mailCopilotItemStatusSchema = z.enum(MAIL_COPILOT_ITEM_STATUSES);

export const mailCopilotEventSchema = z.object({
  id: mailEventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema.nullable(),
  runId: mailRunIdSchema.nullable(),
  accountEmail: z.string().max(320).nullable(),
  threadId: z.string().max(200).nullable(),
  messageId: z.string().max(200).nullable(),
  type: mailCopilotEventTypeSchema,
  status: mailCopilotItemStatusSchema.nullable(),
  message: z.string().trim().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTime
}).strict();
export type MailCopilotEvent = z.infer<typeof mailCopilotEventSchema>;

export const mailCopilotEventInputSchema = z.object({
  type: mailCopilotEventTypeSchema.default("NOTE"),
  message: z.string().trim().min(1).max(1000),
  accountEmail: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  threadId: z.string().trim().min(1).max(200).nullable().optional(),
  messageId: z.string().trim().min(1).max(200).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
}).strict();
export type MailCopilotEventInput = z.infer<typeof mailCopilotEventInputSchema>;

/** "Send to AI": the operator hands one conversation to the copilot to check and fix what it needs. */
export const mailCopilotFixRequestSchema = z.object({
  account: emailSchema,
  threadId: z.string().min(1).max(200),
  /** What the copilot should look at or fix (optional). */
  note: z.string().trim().max(2000).optional()
}).strict();
export type MailCopilotFixRequest = z.infer<typeof mailCopilotFixRequestSchema>;

/** The action log as the operator reads it back (Activity → Your actions). */
export const mailActionListQuerySchema = z.object({
  paneId: paneIdSchema.optional(),
  account: emailSchema.optional(),
  source: z.enum(["PANE", "GMAIL", "BACKFILL", "SPACE"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

export const mailCopilotEventListQuerySchema = z.object({
  paneId: paneIdSchema.optional(),
  threadId: z.string().min(1).max(200).optional(),
  since: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

export const mailCopilotRunCountersSchema = z.object({
  taken: z.number().int().min(0).default(0),
  replied: z.number().int().min(0).default(0),
  drafted: z.number().int().min(0).default(0),
  archived: z.number().int().min(0).default(0),
  labeled: z.number().int().min(0).default(0),
  skipped: z.number().int().min(0).default(0),
  needsUser: z.number().int().min(0).default(0),
  fixed: z.number().int().min(0).default(0)
}).strict();
export type MailCopilotRunCounters = z.infer<typeof mailCopilotRunCountersSchema>;

export const mailCopilotRunSchema = z.object({
  id: mailRunIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: paneIdSchema,
  status: z.enum(["RUNNING", "PAUSED", "STOPPED"]),
  counters: mailCopilotRunCountersSchema,
  currentEventId: mailEventIdSchema.nullable(),
  kickoffSentAt: isoDateTime.nullable(),
  startedAt: isoDateTime,
  pausedAt: isoDateTime.nullable(),
  stoppedAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailCopilotRun = z.infer<typeof mailCopilotRunSchema>;

/** Something waiting for the operator in the rail: a question or a review the agent asked for. */
export const mailCopilotPendingItemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["QUESTION", "REVIEW"]),
  eventId: mailEventIdSchema,
  accountEmail: z.string().max(320).nullable(),
  threadId: z.string().max(200).nullable(),
  message: z.string().max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type MailCopilotPendingItem = z.infer<typeof mailCopilotPendingItemSchema>;

export const mailCopilotRunViewSchema = z.object({
  run: mailCopilotRunSchema.nullable(),
  status: mailCopilotRunStatusSchema,
  pending: z.array(mailCopilotPendingItemSchema).max(100),
  /** Work items still waiting for the agent (not yet taken). */
  backlog: z.number().int().min(0)
}).strict();
export type MailCopilotRunView = z.infer<typeof mailCopilotRunViewSchema>;

export const MAIL_COPILOT_REPORT_OUTCOMES = ["replied", "drafted", "archived", "labeled", "skipped", "needs_user", "learned", "fixed"] as const;
export const mailCopilotReportOutcomeSchema = z.enum(MAIL_COPILOT_REPORT_OUTCOMES);
export const mailCopilotNextRequestSchema = z.object({ waitMs: z.number().int().min(0).max(120_000).default(60_000) }).strict();
export const mailCopilotReportRequestSchema = z.object({
  eventId: mailEventIdSchema,
  outcome: mailCopilotReportOutcomeSchema,
  summary: z.string().trim().min(1).max(1000),
  memoryIds: z.array(mailMemoryIdSchema).max(20).default([])
}).strict();

export const mailCopilotQuestionAskSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  accountEmail: z.string().trim().toLowerCase().email().max(320).optional(),
  threadId: z.string().trim().min(1).max(200).optional()
}).strict();
export const mailCopilotQuestionWaitSchema = z.object({ questionId: z.string().regex(/^mailq:[A-Za-z0-9_-]{6,80}$/), waitMs: z.number().int().min(0).max(120_000).default(60_000) }).strict();
export const mailCopilotQuestionAnswerSchema = z.object({ questionId: z.string().regex(/^mailq:[A-Za-z0-9_-]{6,80}$/), answer: z.string().trim().min(1).max(4000) }).strict();

/** A reply the agent wants to send: the operator approves, edits (the edit is learned) or rejects it in the rail. */
export const mailCopilotReviewRequestSchema = z.object({
  draft: mailComposeInputSchema,
  summary: z.string().trim().min(1).max(1000),
  /** Why the agent answers this way (what it recalled), shown with the draft. */
  reasoning: z.string().max(2000).optional()
}).strict();
export const mailCopilotReviewWaitSchema = z.object({ reviewId: z.string().regex(/^mailrev:[A-Za-z0-9_-]{6,80}$/), waitMs: z.number().int().min(0).max(120_000).default(60_000) }).strict();
export const MAIL_COPILOT_REVIEW_DECISIONS = ["approve", "edit", "reject"] as const;
export const mailCopilotReviewDecideSchema = z.object({
  reviewId: z.string().regex(/^mailrev:[A-Za-z0-9_-]{6,80}$/),
  decision: z.enum(MAIL_COPILOT_REVIEW_DECISIONS),
  /** edit: the text the operator sends instead; the difference becomes a lesson. */
  text: z.string().max(100_000).optional(),
  note: z.string().max(1000).optional()
}).strict();
export type MailCopilotReviewDecision = z.infer<typeof mailCopilotReviewDecideSchema>;
