import { z } from "zod";
import { keyCountWithin } from "./record-rules.js";
import { orderedRange } from "./range-rules.js";

// Mail Campaigns (operator request 2026-10-29, plan clipboard:IJ2ovfLg1Lbw): bulk mail (newsletters, offers, outreach) beside the
// Mail Copilot. Senders, versioned templates, lists, contacts with one health per address, global suppressions, campaigns and their
// per-recipient send log are per-owner records (migration 0264); no field lives in the Mail Copilot's pane metadata.
// A campaign reaches third parties only after a person approves its exact fingerprint.

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}:[A-Za-z0-9_-]{6,80}$`));
export const mailSenderIdSchema = idOf("msender");
export const mailTemplateIdSchema = idOf("mtpl");
export const mailListIdSchema = idOf("mlist");
export const mailContactIdSchema = idOf("mcontact");
export const mailCampaignIdSchema = idOf("mcamp");
export const mailCampaignCheckIdSchema = idOf("mcheck");
export const mailCampaignEventIdSchema = idOf("mcevt");
const isoDateTime = z.string().datetime({ offset: true });

// ---- addresses ---------------------------------------------------------------------------------

/**
 * One address per mailbox: trimmed, `mailto:` and angle brackets dropped, lower-case, the domain in ASCII (punycode). No Gmail
 * dot or plus folding: every other provider treats those as different mailboxes. Null when it is not `local@domain.tld`.
 */
export function normalizeMailAddress(raw: string): string | null {
  let value = String(raw ?? "").trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  let domain = value.slice(at + 1).replace(/\.$/, "");
  if (/[^\x21-\x7e]/.test(domain)) {
    try { domain = new URL(`http://${domain}`).hostname; } catch { return null; }
  }
  value = `${local}@${domain}`;
  if (value.length > 254 || local.length > 64) return null;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return null;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(domain)) return null;
  return value;
}
/** The domain part of a normalized address. */
export const mailAddressDomain = (address: string) => address.slice(address.lastIndexOf("@") + 1);
export const mailAddressSchema = z.string().trim().min(3).max(320).transform((value, context) => {
  const normalized = normalizeMailAddress(value);
  if (!normalized) { context.addIssue({ code: "custom", message: "Not an e-mail address (local@domain.tld)." }); return z.NEVER; }
  return normalized;
});
/** A suppression covers one address or a whole domain (`@shop.example`). */
export function normalizeSuppressionPattern(raw: string): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value.startsWith("@")) {
    const domain = normalizeMailAddress(`x${value}`);
    return domain ? `@${mailAddressDomain(domain)}` : null;
  }
  return normalizeMailAddress(value);
}
/** Whether a pattern list covers an address (its exact address or its domain). */
export function mailSuppressed(patterns: ReadonlySet<string>, address: string): boolean {
  return patterns.has(address) || patterns.has(`@${mailAddressDomain(address)}`);
}

// ---- senders -------------------------------------------------------------------------------------

/**
 * How a sender's mail leaves. GMAIL_DELEGATED: a Google Workspace domain through domain-wide delegation; GMAIL_CONNECTOR: one of the
 * owner's connected Google accounts (its verified Send-as); SMTP: submission to our own mail server, the password a kept Vault key.
 */
export const MAIL_SENDER_ROUTES = ["GMAIL_DELEGATED", "GMAIL_CONNECTOR", "SMTP"] as const;
export const mailSenderRouteSchema = z.enum(MAIL_SENDER_ROUTES);
export type MailSenderRoute = z.infer<typeof mailSenderRouteSchema>;
export const MAIL_SENDER_STATUSES = ["SETUP", "ACTIVE", "PAUSED", "DISABLED"] as const;
export const mailSenderStatusSchema = z.enum(MAIL_SENDER_STATUSES);
export type MailSenderStatus = z.infer<typeof mailSenderStatusSchema>;

/** Daily sends per warm-up stage; a new sender starts at stage 0 and moves up after clean days. */
export const MAIL_WARMUP_DAILY = [50, 100, 200, 400, 800, 1500, 3000] as const;

const hostSchema = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const vaultKeyIdSchema = z.string().regex(/^vault_key:[A-Za-z0-9_-]{6,80}$/);
/** Space's own DKIM signature on an SMTP sender's mail: d= the sender's domain, s= the selector, the private key a kept Vault key. */
export const mailSenderDkimSchema = z.object({ selector: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/), vaultKeyId: vaultKeyIdSchema }).strict();
/** Secrets live in the Vault as kept keys (server-readable, never in agent context): the service-account JSON or the SMTP password. */
export const mailSenderRouteConfigSchema = z.discriminatedUnion("route", [
  z.object({ route: z.literal("GMAIL_DELEGATED"), subject: mailAddressSchema, vaultKeyId: vaultKeyIdSchema }).strict(),
  z.object({ route: z.literal("GMAIL_CONNECTOR"), account: mailAddressSchema }).strict(),
  z.object({ route: z.literal("SMTP"), host: hostSchema, port: z.union([z.literal(465), z.literal(587)]), username: z.string().trim().min(1).max(320),
    vaultKeyId: vaultKeyIdSchema, dkim: mailSenderDkimSchema.optional() }).strict()
]);
export type MailSenderRouteConfig = z.infer<typeof mailSenderRouteConfigSchema>;

export const mailSenderSchema = z.object({
  id: mailSenderIdSchema,
  ownerUserId: z.string().min(1),
  address: z.string(),
  displayName: z.string().max(120),
  domain: z.string(),
  config: mailSenderRouteConfigSchema,
  replyTo: z.string().nullable(),
  /** The sender's physical/postal identity line every message's footer carries. */
  footerAddress: z.string().max(300),
  status: mailSenderStatusSchema,
  warmup: z.object({ stage: z.number().int().min(0).max(MAIL_WARMUP_DAILY.length), since: isoDateTime }).strict(),
  caps: z.object({ perMinute: z.number().int().min(1).max(60), perDay: z.number().int().min(1).max(100_000) }).strict(),
  /** Whether campaigns may use it; consumer @gmail.com senders start off with the reason. */
  bulk: z.boolean(),
  bulkNote: z.string().max(300).nullable(),
  createdBy: z.string().max(200),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailSender = z.infer<typeof mailSenderSchema>;

/** Consumer Google mail (Google caps it near 500 a day; operator rule 21/10: no bulk from @gmail.com). */
export const consumerMailDomain = (domain: string) => domain === "gmail.com" || domain === "googlemail.com";

export const mailSenderCreateSchema = z.object({
  address: mailAddressSchema,
  displayName: z.string().trim().min(1).max(120),
  config: mailSenderRouteConfigSchema,
  replyTo: mailAddressSchema.nullable().default(null),
  footerAddress: z.string().trim().min(3).max(300),
  caps: z.object({ perMinute: z.number().int().min(1).max(60).default(1), perDay: z.number().int().min(1).max(100_000).default(500) }).strict().default({ perMinute: 1, perDay: 500 })
}).strict();
export type MailSenderCreate = z.infer<typeof mailSenderCreateSchema>;
export const mailSenderUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  replyTo: mailAddressSchema.nullable().optional(),
  footerAddress: z.string().trim().min(3).max(300).optional(),
  status: mailSenderStatusSchema.optional(),
  caps: z.object({ perMinute: z.number().int().min(1).max(60), perDay: z.number().int().min(1).max(100_000) }).strict().optional(),
  /** SMTP senders only; null stops Space's own signature. */
  dkim: mailSenderDkimSchema.nullable().optional()
}).strict();
export type MailSenderUpdate = z.infer<typeof mailSenderUpdateSchema>;

// ---- templates -----------------------------------------------------------------------------------

export const MAIL_TEMPLATE_LANGUAGES = ["el", "en"] as const;
export const mailTemplateLanguageSchema = z.enum(MAIL_TEMPLATE_LANGUAGES);
const variableNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/);
export const mailTemplateVariableSchema = z.object({ name: variableNameSchema, default: z.string().max(500).nullable().default(null), required: z.boolean().default(false) }).strict();
export type MailTemplateVariable = z.infer<typeof mailTemplateVariableSchema>;
export const mailMadeBySchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("AGENT"), runtime: z.string().max(80), model: z.string().max(120), paneId: z.string().max(200).nullable() }).strict(),
  z.object({ by: z.literal("OPERATOR") }).strict(),
  z.object({ by: z.literal("NOUS"), model: z.string().max(120) }).strict()
]);
export type MailMadeBy = z.infer<typeof mailMadeBySchema>;

/** Gmail clips a message past ~102 KB; templates stay well under it. */
export const MAIL_TEMPLATE_HTML_MAX = 90_000;
export const mailTemplateContentSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  preheader: z.string().trim().max(200).default(""),
  /** Empty: a plain-text mail (the HTML part is the text, escaped, line for line). */
  html: z.string().max(MAIL_TEMPLATE_HTML_MAX).default(""),
  /** Every campaign mail carries a plain-text part. */
  text: z.string().trim().min(1).max(50_000),
  variables: z.array(mailTemplateVariableSchema).max(30).default([])
}).strict();
export type MailTemplateContent = z.infer<typeof mailTemplateContentSchema>;
/** A change to a template: only the fields given (no defaults, so a missing field never resets one). */
export const mailTemplateContentPatchSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  preheader: z.string().trim().max(200).optional(),
  html: z.string().max(MAIL_TEMPLATE_HTML_MAX).optional(),
  text: z.string().trim().min(1).max(50_000).optional(),
  variables: z.array(mailTemplateVariableSchema).max(30).optional()
}).strict();

export const mailTemplateVersionSchema = mailTemplateContentSchema.extend({
  templateId: mailTemplateIdSchema,
  version: z.number().int().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  madeBy: mailMadeBySchema,
  createdAt: isoDateTime
}).strict();
export type MailTemplateVersion = z.infer<typeof mailTemplateVersionSchema>;
export const mailTemplateSchema = z.object({
  id: mailTemplateIdSchema,
  ownerUserId: z.string().min(1),
  name: z.string().max(120),
  language: mailTemplateLanguageSchema,
  currentVersion: z.number().int().min(1),
  paneId: z.string().max(200).nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailTemplate = z.infer<typeof mailTemplateSchema>;
export const mailTemplateCreateSchema = mailTemplateContentSchema.extend({
  name: z.string().trim().min(1).max(120),
  language: mailTemplateLanguageSchema
}).strict();
export type MailTemplateCreate = z.infer<typeof mailTemplateCreateSchema>;

/** The canonical text a template version's fingerprint hashes (sha256 in the server): every field a recipient sees. */
export function mailTemplateFingerprintInput(content: MailTemplateContent): string {
  return JSON.stringify(["mail-template/1", content.subject, content.preheader, content.html, content.text,
    content.variables.map((variable) => [variable.name, variable.default, variable.required])]);
}

const VARIABLE_PATTERN = /\{\{\s*([a-z][a-zA-Z0-9_]{0,39})\s*\}\}/g;
/** The variable names a template's subject, preheader, HTML and text use. */
export function mailTemplateVariablesUsed(content: Pick<MailTemplateContent, "subject" | "preheader" | "html" | "text">): string[] {
  const names = new Set<string>();
  for (const part of [content.subject, content.preheader, content.html, content.text]) for (const match of part.matchAll(VARIABLE_PATTERN)) names.add(match[1]!);
  return [...names];
}
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * A template version with a recipient's values: `{{name}}` only, escaped in HTML, CR/LF dropped in the subject. A variable the template
 * uses but does not declare, or a required one without a value or default, is an error (nothing half-filled goes out).
 */
export function renderMailTemplate(content: MailTemplateContent, values: Readonly<Record<string, string | null | undefined>>): { subject: string; preheader: string; html: string; text: string } {
  const declared = new Map(content.variables.map((variable) => [variable.name, variable]));
  const value = (name: string) => {
    const variable = declared.get(name);
    if (!variable) throw new Error(`The template uses {{${name}}} but does not declare it.`);
    const given = values[name];
    const filled = given !== undefined && given !== null && given !== "";
    if (!filled && (variable.required || variable.default === null)) throw new Error(`No value for {{${name}}}.`);
    return filled ? String(given) : variable.default!;
  };
  const fill = (part: string, html: boolean) => part.replace(VARIABLE_PATTERN, (_, name: string) => html ? escapeHtml(value(name)) : value(name));
  return { subject: fill(content.subject, false).replace(/[\r\n]+/g, " "), preheader: fill(content.preheader, false), html: fill(content.html, true), text: fill(content.text, false) };
}

// ---- lists, contacts, health, suppressions --------------------------------------------------------

/**
 * Why we may mail a list. CONSENT: subscribed; CUSTOMER: bought from us (soft opt-in, Greek law 3471/2006 art. 11(3), similar products
 * only); B2B: business outreach to role addresses; CONTACT: people who wrote to us; IMPORTED: unknown origin. B2B and IMPORTED are capped low.
 * NO_CONSENT (Nous decision 29/10): kept and visible, never mailed in bulk (e.g. registered shop users who never bought).
 */
export const MAIL_CONSENT_BASES = ["CONSENT", "CUSTOMER", "B2B", "CONTACT", "IMPORTED", "NO_CONSENT"] as const;
export const mailConsentBasisSchema = z.enum(MAIL_CONSENT_BASES);
export type MailConsentBasis = z.infer<typeof mailConsentBasisSchema>;
/** Daily sends per owner for a campaign whose lists include this basis (null: only the sender's caps). */
export function consentDailyCap(basis: MailConsentBasis): number | null {
  return basis === "NO_CONSENT" ? 0 : basis === "B2B" || basis === "IMPORTED" ? 100 : null;
}
export const MAIL_LIST_SOURCES = ["MANUAL", "CSV", "CS_CART", "MAILBOX", "MAIL_THREAD", "AGENT"] as const;
export const mailListSourceSchema = z.enum(MAIL_LIST_SOURCES);
export type MailListSource = z.infer<typeof mailListSourceSchema>;

export const MAIL_HEALTH_STATUSES = ["VALID", "RISKY", "UNKNOWN", "INVALID", "BOUNCED", "COMPLAINED", "UNSUBSCRIBED"] as const;
export const mailHealthSchema = z.enum(MAIL_HEALTH_STATUSES);
export type MailHealth = z.infer<typeof mailHealthSchema>;
/** Whether a campaign may mail an address of this health (the rest are skipped at send time). */
export const healthSendable = (health: MailHealth) => health === "VALID" || health === "RISKY" || health === "UNKNOWN";

export const mailListSchema = z.object({
  id: mailListIdSchema,
  ownerUserId: z.string().min(1),
  name: z.string().max(120),
  description: z.string().max(1000),
  source: mailListSourceSchema,
  consentBasis: mailConsentBasisSchema,
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailList = z.infer<typeof mailListSchema>;
export const mailListCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  source: mailListSourceSchema.default("MANUAL"),
  consentBasis: mailConsentBasisSchema
}).strict();
export type MailListCreate = z.infer<typeof mailListCreateSchema>;
/** Counts per health status of a list's members, and how many are suppressed. */
export const mailListHealthSchema = z.object({
  listId: mailListIdSchema,
  members: z.number().int().min(0),
  byHealth: z.partialRecord(mailHealthSchema, z.number().int().min(0)),
  suppressed: z.number().int().min(0),
  sendable: z.number().int().min(0)
}).strict();
export type MailListHealth = z.infer<typeof mailListHealthSchema>;

const attributesSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.string().max(500)).refine(...keyCountWithin(0, 40, "At most 40 attributes."));
export const mailContactSchema = z.object({
  id: mailContactIdSchema,
  ownerUserId: z.string().min(1),
  address: z.string(),
  domain: z.string(),
  name: z.string().max(200),
  attributes: attributesSchema,
  health: mailHealthSchema,
  healthReasons: z.array(z.string().max(200)).max(10),
  healthCheckedAt: isoDateTime.nullable(),
  softBounces: z.number().int().min(0),
  lastEngagedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailContact = z.infer<typeof mailContactSchema>;
export const mailContactInputSchema = z.object({
  address: mailAddressSchema,
  name: z.string().trim().max(200).default(""),
  attributes: attributesSchema.default({})
}).strict();
export type MailContactInput = z.infer<typeof mailContactInputSchema>;
export const mailContactHealthPatchSchema = z.object({
  health: mailHealthSchema,
  reasons: z.array(z.string().max(200)).max(10).default([]),
  softBounces: z.number().int().min(0).optional(),
  engagedAt: isoDateTime.optional()
}).strict();
export type MailContactHealthPatch = z.infer<typeof mailContactHealthPatchSchema>;

export const MAIL_SUPPRESSION_REASONS = ["UNSUBSCRIBE", "HARD_BOUNCE", "COMPLAINT", "DO_NOT_CONTACT", "MANUAL"] as const;
export const mailSuppressionReasonSchema = z.enum(MAIL_SUPPRESSION_REASONS);
export type MailSuppressionReason = z.infer<typeof mailSuppressionReasonSchema>;
export const mailSuppressionSchema = z.object({
  ownerUserId: z.string().min(1),
  pattern: z.string(),
  reason: mailSuppressionReasonSchema,
  source: z.string().max(200),
  note: z.string().max(500),
  createdAt: isoDateTime
}).strict();
export type MailSuppression = z.infer<typeof mailSuppressionSchema>;
export const mailSuppressionInputSchema = z.object({
  pattern: z.string().trim().min(3).max(320).transform((value, context) => {
    const normalized = normalizeSuppressionPattern(value);
    if (!normalized) { context.addIssue({ code: "custom", message: "Not an address or @domain." }); return z.NEVER; }
    return normalized;
  }),
  reason: mailSuppressionReasonSchema,
  source: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).default("")
}).strict();
export type MailSuppressionInput = z.infer<typeof mailSuppressionInputSchema>;

// ---- campaigns -----------------------------------------------------------------------------------

export const MAIL_CAMPAIGN_STATUSES = ["DRAFT", "TESTING", "IN_REVIEW", "APPROVED", "SENDING", "PAUSED", "DONE", "STOPPED"] as const;
export const mailCampaignStatusSchema = z.enum(MAIL_CAMPAIGN_STATUSES);
export type MailCampaignStatus = z.infer<typeof mailCampaignStatusSchema>;
/** States in which the campaign's fingerprint is bound by an approval. */
export const MAIL_CAMPAIGN_APPROVED_STATES: readonly MailCampaignStatus[] = ["APPROVED", "SENDING", "PAUSED"];

const hourSchema = z.number().int().min(0).max(24);
export const mailCampaignScheduleSchema = z.object({
  startAt: isoDateTime.nullable().default(null),
  timeZone: z.string().min(1).max(64).default("Europe/Athens"),
  /** ISO weekdays 1 (Monday) … 7 (Sunday) on which mail goes out. */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5]),
  fromHour: hourSchema.default(9),
  toHour: hourSchema.default(18)
}).strict().refine(...orderedRange("fromHour", "toHour", { message: "fromHour must be before toHour", path: ["toHour"] }, true));
export type MailCampaignSchedule = z.infer<typeof mailCampaignScheduleSchema>;
export const mailCampaignPacingSchema = z.object({
  perMinute: z.number().int().min(1).max(60).default(1),
  perDay: z.number().int().min(1).max(100_000).default(300),
  /** At most one mail per this many seconds (e.g. 360: one every 6 minutes). */
  intervalSeconds: z.number().int().min(60).max(86_400).optional(),
  /** Stop (pause) after more than this many hard bounces, whatever the rate. */
  maxHardBounces: z.number().int().min(1).max(100_000).optional()
}).strict();
export type MailCampaignPacing = z.infer<typeof mailCampaignPacingSchema>;

export const mailCampaignApprovalSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  at: isoDateTime,
  by: z.string().max(200),
  /** RAIL: a person in the pane or Needs you; NOUS: an approved Nous decision (its id). */
  via: z.enum(["RAIL", "NOUS"]),
  decisionId: z.string().max(200).nullable()
}).strict();
export type MailCampaignApproval = z.infer<typeof mailCampaignApprovalSchema>;

export const mailCampaignSchema = z.object({
  id: mailCampaignIdSchema,
  ownerUserId: z.string().min(1),
  paneId: z.string().max(200).nullable(),
  name: z.string().max(160),
  goal: z.string().max(1000),
  templateId: mailTemplateIdSchema,
  templateVersion: z.number().int().min(1),
  senderId: mailSenderIdSchema,
  listIds: z.array(mailListIdSchema).min(1),
  schedule: mailCampaignScheduleSchema,
  pacing: mailCampaignPacingSchema,
  status: mailCampaignStatusSchema,
  /** The fingerprint of what would go out now (template version, sender, lists and eligible count, schedule, pacing). */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  approval: mailCampaignApprovalSchema.nullable(),
  /** Frozen at approval: who gets it and why the rest do not. */
  audience: z.object({ eligible: z.number().int().min(0), skipped: z.record(z.string(), z.number().int().min(0)) }).strict().nullable(),
  /** The owner's own mailboxes test copies go to (no approval needed). */
  testSeeds: z.array(z.string()),
  pauseReason: z.string().max(500).nullable(),
  createdBy: z.string().max(200),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type MailCampaign = z.infer<typeof mailCampaignSchema>;
export const mailCampaignCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  goal: z.string().trim().max(1000).default(""),
  templateId: mailTemplateIdSchema,
  templateVersion: z.number().int().min(1).optional(),
  senderId: mailSenderIdSchema,
  listIds: z.array(mailListIdSchema).min(1),
  schedule: mailCampaignScheduleSchema.default({ startAt: null, timeZone: "Europe/Athens", days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 18 }),
  pacing: mailCampaignPacingSchema.default({ perMinute: 1, perDay: 300 }),
  testSeeds: z.array(mailAddressSchema).default([])
}).strict();
export type MailCampaignCreate = z.infer<typeof mailCampaignCreateSchema>;
/** A change to a draft campaign: only the fields given (no defaults, so a missing field never resets one). */
export const mailCampaignUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  goal: z.string().trim().max(1000).optional(),
  templateId: mailTemplateIdSchema.optional(),
  templateVersion: z.number().int().min(1).optional(),
  senderId: mailSenderIdSchema.optional(),
  listIds: z.array(mailListIdSchema).min(1).optional(),
  schedule: mailCampaignScheduleSchema.optional(),
  pacing: mailCampaignPacingSchema.optional(),
  testSeeds: z.array(mailAddressSchema).optional()
}).strict();
export type MailCampaignUpdate = z.infer<typeof mailCampaignUpdateSchema>;
export const mailCampaignDecisionSchema = z.object({ decision: z.enum(["approve", "decline", "pause", "resume", "stop"]), note: z.string().trim().max(500).optional() }).strict();
export type MailCampaignDecision = z.infer<typeof mailCampaignDecisionSchema>;

/** The canonical text a campaign's fingerprint hashes: everything the approval covers. */
export function mailCampaignFingerprintInput(input: { templateFingerprint: string; sender: Pick<MailSender, "id" | "address" | "displayName" | "config">;
  listIds: readonly string[]; eligible: number; schedule: MailCampaignSchedule; pacing: MailCampaignPacing; contentHash?: string }): string {
  const { route } = input.sender.config;
  // List order is the send priority, so it counts; contentHash covers every recipient's rendered mail (what the operator browsed).
  return JSON.stringify(["mail-campaign/2", input.templateFingerprint, input.sender.id, input.sender.address, input.sender.displayName, route,
    [...input.listIds], input.eligible, input.schedule.startAt, input.schedule.timeZone, [...input.schedule.days].sort(), input.schedule.fromHour,
    input.schedule.toHour, input.pacing.perMinute, input.pacing.perDay, input.pacing.intervalSeconds ?? null, input.pacing.maxHardBounces ?? null, input.contentHash ?? null]);
}

export const MAIL_SEND_STATUSES = ["PENDING", "SENDING", "SENT", "SKIPPED", "FAILED", "UNKNOWN"] as const;
export const mailSendStatusSchema = z.enum(MAIL_SEND_STATUSES);
export type MailSendStatus = z.infer<typeof mailSendStatusSchema>;
export const mailCampaignSendSchema = z.object({
  campaignId: mailCampaignIdSchema,
  contactId: mailContactIdSchema,
  ownerUserId: z.string().min(1),
  address: z.string(),
  status: mailSendStatusSchema,
  skipReason: z.string().max(200).nullable(),
  messageId: z.string().max(400).nullable(),
  providerId: z.string().max(200).nullable(),
  attempts: z.number().int().min(0),
  /** Send order: the index of the first campaign list holding the recipient (0 goes first). */
  priority: z.number().int().min(0),
  /** SHA-256 of the recipient's rendered subject, HTML and text at approval: a mail that would differ is never sent on that approval. */
  renderHash: z.string().max(64).nullable(),
  nextAttemptAt: isoDateTime.nullable(),
  sentAt: isoDateTime.nullable(),
  error: z.string().max(500).nullable(),
  bounce: z.object({ at: isoDateTime, kind: z.enum(["HARD", "SOFT"]), code: z.string().max(40) }).strict().nullable(),
  complainedAt: isoDateTime.nullable(),
  repliedAt: isoDateTime.nullable(),
  unsubscribedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime
}).strict();
export type MailCampaignSend = z.infer<typeof mailCampaignSendSchema>;
export const mailCampaignStatsSchema = z.object({
  byStatus: z.partialRecord(mailSendStatusSchema, z.number().int().min(0)),
  bounced: z.object({ hard: z.number().int().min(0), soft: z.number().int().min(0) }).strict(),
  complained: z.number().int().min(0),
  replied: z.number().int().min(0),
  unsubscribed: z.number().int().min(0)
}).strict();
export type MailCampaignStats = z.infer<typeof mailCampaignStatsSchema>;

// ---- deliverability checks and the feed ------------------------------------------------------------

export const MAIL_CHECK_KINDS = ["DNS", "DNSBL", "LINT", "SPAMASSASSIN", "AUTH_VERIFIER", "SEED", "POSTMASTER"] as const;
export const mailCheckKindSchema = z.enum(MAIL_CHECK_KINDS);
export type MailCheckKind = z.infer<typeof mailCheckKindSchema>;
export const mailCheckStatusSchema = z.enum(["PASS", "WARN", "FAIL"]);
export type MailCheckStatus = z.infer<typeof mailCheckStatusSchema>;
export const mailCampaignCheckSchema = z.object({
  id: mailCampaignCheckIdSchema,
  ownerUserId: z.string().min(1),
  campaignId: mailCampaignIdSchema.nullable(),
  senderId: mailSenderIdSchema.nullable(),
  kind: mailCheckKindSchema,
  status: mailCheckStatusSchema,
  score: z.number().nullable(),
  /** What was checked, the findings and the concrete fixes (bounded JSON, no recipient addresses). */
  details: z.record(z.string(), z.unknown()),
  fingerprint: z.string().max(64).nullable(),
  createdAt: isoDateTime
}).strict();
export type MailCampaignCheck = z.infer<typeof mailCampaignCheckSchema>;

export const MAIL_CAMPAIGN_EVENT_TYPES = ["CREATED", "UPDATED", "TEST_SENT", "LAB", "REVIEW_REQUESTED", "APPROVED", "DECLINED", "BACK_TO_REVIEW",
  "STARTED", "PAUSED", "RESUMED", "STOPPED", "DONE", "AUTO_PAUSED", "SENDER", "LIST", "IMPORT", "SUPPRESSION", "HEALTH", "NOTE"] as const;
export const mailCampaignEventTypeSchema = z.enum(MAIL_CAMPAIGN_EVENT_TYPES);
export type MailCampaignEventType = z.infer<typeof mailCampaignEventTypeSchema>;
export const mailCampaignEventSchema = z.object({
  id: mailCampaignEventIdSchema,
  ownerUserId: z.string().min(1),
  campaignId: mailCampaignIdSchema.nullable(),
  type: mailCampaignEventTypeSchema,
  message: z.string().max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type MailCampaignEvent = z.infer<typeof mailCampaignEventSchema>;

// ---- what the operator reads before approving ------------------------------------------------------

/** Every mail a campaign would send now, one row per recipient in send order; `fingerprint` is what an Approve binds. */
export interface MailCampaignPreview {
  fingerprint: string; total: number; matched: number; skipped: Record<string, number>; status: MailCampaignStatus;
  items: Array<{ index: number; contactId: string; address: string; name: string; priority: number; subject: string }>;
}
/** One recipient's complete mail as it would leave, with the recipients before and after it. */
export interface MailCampaignPreviewMail {
  fingerprint: string; index: number; total: number; previous: string | null; next: string | null; contactId: string; to: string; name: string; priority: number;
  from: string; replyTo: string | null; subject: string; preheader: string; html: string; text: string; renderHash: string;
}
