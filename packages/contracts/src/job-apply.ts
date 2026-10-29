import { z } from "zod";
import { connectorCapabilitySchema } from "./dot-connectors.js";
import { copilotAccountProfileIdSchema } from "./copilot.js";

// Job Applications pane: one pane owns a managed browser session (live view,
// operator handoff) and a CLI agent session. Pane metadata holds only pane-level
// settings; the candidate profile, mailbox and tracker are per-owner records.
export const JOB_APPLY_PANE_MODE = "JOB_APPLY" as const;

export const JOB_APPLY_SITES = ["linkedin", "greenhouse", "ashby", "lever", "workday", "indeed", "other"] as const;
export const jobApplySiteSchema = z.enum(JOB_APPLY_SITES);
export type JobApplySite = z.infer<typeof jobApplySiteSchema>;

// Conservative defaults: LinkedIn bans automation fast; ATS boards tolerate more.
export const JOB_APPLY_DEFAULT_DAILY_CAPS: Readonly<Record<JobApplySite, number>> = Object.freeze({
  linkedin: 25, greenhouse: 60, ashby: 60, lever: 60, workday: 40, indeed: 40, other: 40
});

export const jobApplySubmitModeSchema = z.enum(["AUTO", "REVIEW"]);
export type JobApplySubmitMode = z.infer<typeof jobApplySubmitModeSchema>;

const dailyCapSchema = z.number().int().min(0).max(500);
export const jobApplyPaneSettingsSchema = z.object({
  submitMode: jobApplySubmitModeSchema.default("AUTO"),
  dailyCaps: z.object({
    linkedin: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.linkedin),
    greenhouse: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.greenhouse),
    ashby: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.ashby),
    lever: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.lever),
    workday: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.workday),
    indeed: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.indeed),
    other: dailyCapSchema.default(JOB_APPLY_DEFAULT_DAILY_CAPS.other)
  }).strict().default({ ...JOB_APPLY_DEFAULT_DAILY_CAPS }),
  minDelayMs: z.number().int().min(0).max(3_600_000).default(120_000),
  maxDelayMs: z.number().int().min(0).max(3_600_000).default(240_000),
  paused: z.boolean().default(false),
  /** Where "needs you" moments (handoff, question, review) and run summaries are delivered. */
  notifications: z.object({
    inApp: z.boolean().default(true),
    telegram: z.boolean().default(false)
  }).strict().default({ inApp: true, telegram: false })
}).strict().refine(value => value.minDelayMs <= value.maxDelayMs, "Minimum delay must not exceed the maximum delay.");
export type JobApplyPaneSettings = z.infer<typeof jobApplyPaneSettingsSchema>;

/** A CLI account profile id ("main", a named profile or "space-gateway"); shared with every copilot pane. */
export const jobCopilotAccountProfileIdSchema = copilotAccountProfileIdSchema;

// Part of the pane row: the Browser Host parses pane rows with the contracts it loaded at start
// (ADR-011 item 13), so a new key here breaks its browser starts until a guarded host restart.
// The pane's CLI account lives in its CLI session, never here.
export const jobApplyPaneMetadataSchema = z.object({
  version: z.literal(1),
  settings: jobApplyPaneSettingsSchema
}).strict();
export type JobApplyPaneMetadata = z.infer<typeof jobApplyPaneMetadataSchema>;

export function defaultJobApplyPaneMetadata(): JobApplyPaneMetadata {
  return jobApplyPaneMetadataSchema.parse({ version: 1, settings: {} });
}

/** Panes created before the column existed, or never configured, read as defaults. */
export function resolveJobApplyPaneMetadata(metadata: JobApplyPaneMetadata | null | undefined): JobApplyPaneMetadata {
  return metadata ? jobApplyPaneMetadataSchema.parse(metadata) : defaultJobApplyPaneMetadata();
}

// Tracker contract. "Filled" never counts as applied: VERIFIED requires evidence
// (confirmation page screenshot artifact and/or a confirmation email).
export const JOB_APPLICATION_STATUSES = ["QUEUED", "FILLING", "NEEDS_USER", "SUBMITTED", "VERIFIED", "FAILED"] as const;
export const jobApplicationStatusSchema = z.enum(JOB_APPLICATION_STATUSES);
export type JobApplicationStatus = z.infer<typeof jobApplicationStatusSchema>;

const jobApplicationIdSchema = z.string().regex(/^jobapp:[A-Za-z0-9_-]{6,80}$/);
const artifactIdSchema = z.string().regex(/^artifact:[A-Za-z0-9_-]{6,80}$/);
const isoDateTime = z.string().datetime({ offset: true });

export const jobApplicationSchema = z.object({
  id: jobApplicationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).nullable(),
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(300),
  ats: jobApplySiteSchema,
  url: z.string().url().max(2000),
  status: jobApplicationStatusSchema,
  evidenceArtifactIds: z.array(artifactIdSchema).max(20).default([]),
  externalConfirmation: z.string().trim().max(500).nullable().default(null),
  notes: z.string().max(4000).nullable().default(null),
  appliedAt: isoDateTime.nullable().default(null),
  /** Order inside the pane queue while QUEUED; null once taken or never queued through the copilot. */
  queuePosition: z.number().int().min(0).nullable().default(null),
  /** A QUEUED posting deferred until an employer-side limit expires; space_job_next serves it from this time on. */
  notBefore: isoDateTime.nullable().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type JobApplication = z.infer<typeof jobApplicationSchema>;

/** Deferred: QUEUED with a notBefore still in the future (an employer limit has not expired yet). */
export function isDeferredJobApplication(application: Pick<JobApplication, "status" | "notBefore">, nowIso: string = new Date().toISOString()): boolean {
  return application.status === "QUEUED" && Boolean(application.notBefore) && Date.parse(application.notBefore!) > Date.parse(nowIso);
}
/**
 * The queue the copilot may take from now: deferred rows wait for their date, and a deferred row holds every other
 * queued posting of its company (case-insensitive), so a limit is not spent again on another posting.
 */
export function jobApplicationQueueHolds<T extends Pick<JobApplication, "status" | "notBefore" | "company">>(queue: T[], nowIso: string = new Date().toISOString()) {
  const holds = new Map<string, string>();
  for (const row of queue) {
    if (!isDeferredJobApplication(row, nowIso)) continue;
    const key = row.company.trim().toLowerCase();
    const until = holds.get(key);
    if (!until || row.notBefore! > until) holds.set(key, row.notBefore!);
  }
  return { holds, eligible: queue.filter((row) => !holds.has(row.company.trim().toLowerCase())) };
}

/** Rows imported from an earlier campaign tracker carry a synthetic URL and their original id in the notes. */
export const JOB_APPLY_IMPORTED_URL_PREFIX = "https://space.local/imported/";
export const JOB_APPLY_UNRECORDED_ROLE = "Title not recorded";
/** Note a sent application gets when Check with Gmail found no confirmation email for it. */
export const JOB_APPLY_NO_CONFIRMATION_NOTE = "no confirmation email found";
export function isImportedJobApplication(application: Pick<JobApplication, "url">): boolean {
  return application.url.startsWith(JOB_APPLY_IMPORTED_URL_PREFIX);
}
/**
 * The real posting of an imported row, rebuilt from the earlier tracker's id: LinkedIn "linkedin_<job id>",
 * Greenhouse "<board token>_<job id>", Ashby "<organization>_<posting uuid>". Null when the id says nothing.
 */
export function importedJobPostingUrl(application: Pick<JobApplication, "url" | "notes" | "ats">): string | null {
  if (!isImportedJobApplication(application)) return null;
  const id = /imported id: ([^\s|]+)/.exec(application.notes ?? "")?.[1] ?? decodeURIComponent(application.url.split("/").pop() ?? "");
  const linkedin = /^linkedin_(\d{6,})$/.exec(id);
  if (linkedin) return `https://www.linkedin.com/jobs/view/${linkedin[1]}/`;
  const greenhouse = /^([a-z0-9][a-z0-9-]{0,80})_(\d{5,})$/i.exec(id);
  if (greenhouse && application.ats === "greenhouse") return `https://job-boards.greenhouse.io/${greenhouse[1]}/jobs/${greenhouse[2]}`;
  const ashby = /^([a-z0-9][a-z0-9.-]{0,80})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id);
  if (ashby && application.ats === "ashby") return `https://jobs.ashbyhq.com/${ashby[1]}/${ashby[2]}`;
  return null;
}

export const jobApplicationTransitions: Readonly<Record<JobApplicationStatus, ReadonlyArray<JobApplicationStatus>>> = Object.freeze({
  QUEUED: ["FILLING", "FAILED"],
  // Back to QUEUED (with notBefore) when an employer-side limit stops the application until a later date.
  FILLING: ["NEEDS_USER", "SUBMITTED", "FAILED", "QUEUED"],
  NEEDS_USER: ["FILLING", "SUBMITTED", "FAILED", "QUEUED"],
  SUBMITTED: ["VERIFIED", "FAILED"],
  VERIFIED: [],
  FAILED: ["QUEUED"]
});

export function canTransitionJobApplication(from: JobApplicationStatus, to: JobApplicationStatus): boolean {
  return from === to || jobApplicationTransitions[from].includes(to);
}

// ---------------------------------------------------------------------------
// Candidate profile, mailbox and tracker records (per owner user).
// ---------------------------------------------------------------------------
const shortText = (max: number) => z.string().trim().max(max).nullable().default(null);
const stringList = z.array(z.string().trim().min(1).max(120)).max(100).default([]);

export const jobApplyExperienceSchema = z.object({
  company: z.string().trim().max(200).default(""),
  title: z.string().trim().max(200).default(""),
  start: shortText(40),
  end: shortText(40),
  summary: z.string().trim().max(2000).default("")
}).strict();

export const jobApplyEducationSchema = z.object({
  school: z.string().trim().max(200).default(""),
  degree: z.string().trim().max(200).default(""),
  field: z.string().trim().max(200).default(""),
  start: shortText(40),
  end: shortText(40)
}).strict();

/** The candidate's postal address for forms that require one (identity data like phone: profile only, never memory). */
export const jobApplyPostalAddressSchema = z.object({
  line1: shortText(200),
  line2: shortText(200),
  city: shortText(120),
  region: shortText(120),
  postalCode: shortText(40),
  country: shortText(100)
}).strict();
export type JobApplyPostalAddress = z.infer<typeof jobApplyPostalAddressSchema>;

/** Truthful facts the agent may use; anything missing is "unknown", never guessed silently. */
export const jobApplyCandidateSchema = z.object({
  fullName: shortText(200),
  email: z.string().trim().email().max(320).nullable().default(null),
  phone: shortText(60),
  address: jobApplyPostalAddressSchema.nullable().default(null),
  location: shortText(200),
  country: shortText(100),
  linkedinUrl: z.string().trim().url().max(500).nullable().default(null),
  githubUrl: z.string().trim().url().max(500).nullable().default(null),
  websiteUrl: z.string().trim().url().max(500).nullable().default(null),
  headline: shortText(300),
  summary: z.string().trim().max(4000).nullable().default(null),
  workAuthorization: shortText(300),
  needsSponsorship: z.boolean().nullable().default(null),
  willingToRelocate: z.boolean().nullable().default(null),
  salaryExpectation: shortText(200),
  /** Salary answers go this far below the market median, or a posting's range midpoint (operator rule 2026-10-25). */
  salaryBelowMarketPercent: z.number().int().min(0).max(50).default(10),
  noticePeriod: shortText(120),
  yearsOfExperience: z.number().int().min(0).max(80).nullable().default(null),
  skills: stringList,
  languages: stringList,
  experience: z.array(jobApplyExperienceSchema).max(40).default([]),
  education: z.array(jobApplyEducationSchema).max(20).default([]),
  extra: z.record(z.string().trim().min(1).max(120), z.string().trim().max(2000)).default({})
}).strict();
export type JobApplyCandidate = z.infer<typeof jobApplyCandidateSchema>;

export const jobApplyQaSourceSchema = z.enum(["PROFILE", "CV", "USER", "AGENT"]);
export const jobApplyQaEntrySchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().max(4000),
  source: jobApplyQaSourceSchema.default("USER"),
  updatedAt: isoDateTime
}).strict();
export type JobApplyQaEntry = z.infer<typeof jobApplyQaEntrySchema>;

export const jobApplyMailboxConfigSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(320)
}).strict();
export type JobApplyMailboxConfig = z.infer<typeof jobApplyMailboxConfigSchema>;

/** The password is accepted once and sealed server-side; it never appears in a response. */
export const jobApplyMailboxInputSchema = jobApplyMailboxConfigSchema.extend({
  password: z.string().min(1).max(1000)
}).strict();
export type JobApplyMailboxInput = z.infer<typeof jobApplyMailboxInputSchema>;

/**
 * The Google account Job Copilot works with: the pane browser opens it, and the copilot reads mail
 * (codes, links, recruiter replies), drafts replies and keeps the calendar through the owner's
 * Google connector. `capabilities` is what the owner allowed Space for that account (empty until
 * Google access is allowed); `available` is false when this server has no Google sign-in.
 */
export const jobApplyGoogleAccountSchema = z.object({
  email: z.string().trim().min(3).max(320),
  capabilities: z.array(connectorCapabilitySchema).max(4),
  available: z.boolean()
}).strict();
export type JobApplyGoogleAccount = z.infer<typeof jobApplyGoogleAccountSchema>;
/** A Google account allowed for Space and what it allowed; Job Copilot reads mail from every one with MAIL_READ. */
export const jobApplyGoogleMailAccountSchema = z.object({
  email: z.string().trim().min(3).max(320),
  capabilities: z.array(connectorCapabilitySchema).max(4)
}).strict();
export type JobApplyGoogleMailAccount = z.infer<typeof jobApplyGoogleMailAccountSchema>;
export const jobApplyGoogleAccountInputSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320).nullable() }).strict();
export type JobApplyGoogleAccountInput = z.infer<typeof jobApplyGoogleAccountInputSchema>;

export const jobApplyProfileSchema = z.object({
  ownerUserId: z.string().min(1).max(200),
  candidate: jobApplyCandidateSchema,
  qaBank: z.array(jobApplyQaEntrySchema).max(500),
  cvArtifactId: artifactIdSchema.nullable(),
  coverLetterArtifactId: artifactIdSchema.nullable(),
  cvTextChars: z.number().int().min(0),
  mailbox: jobApplyMailboxConfigSchema.nullable(),
  mailboxVerifiedAt: isoDateTime.nullable(),
  google: jobApplyGoogleAccountSchema.nullable().default(null),
  /** Every Google account allowed for Space; the copilot reads codes, links and mail from all with MAIL_READ. */
  googleAccounts: z.array(jobApplyGoogleMailAccountSchema).max(20).default([]),
  /** Whether this server can ask Google for access (Google sign-in configured). */
  googleAvailable: z.boolean().default(false),
  /** The last "Reset and start over": totals count from here; earlier applications are archived history. */
  campaignStartedAt: isoDateTime.nullable().default(null),
  updatedAt: isoDateTime
}).strict();
export type JobApplyProfile = z.infer<typeof jobApplyProfileSchema>;

/** Whether the copilot can read verification mail: Gmail of a Google account allowed for Space, or an IMAP mailbox. */
export function jobApplyMailboxConnected(profile: Pick<JobApplyProfile, "mailbox" | "google"> & { googleAccounts?: JobApplyProfile["googleAccounts"] }): boolean {
  return profile.mailbox !== null || Boolean(profile.google?.capabilities.includes("MAIL_READ"))
    || Boolean(profile.googleAccounts?.some((account) => account.capabilities.includes("MAIL_READ")));
}

export const jobApplyProfileUpdateSchema = z.object({
  candidate: jobApplyCandidateSchema.optional(),
  qaBank: z.array(jobApplyQaEntrySchema).max(500).optional(),
  cvArtifactId: artifactIdSchema.nullable().optional(),
  coverLetterArtifactId: artifactIdSchema.nullable().optional()
}).strict();
export type JobApplyProfileUpdate = z.infer<typeof jobApplyProfileUpdateSchema>;

export const jobApplicationCreateSchema = z.object({
  paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).nullable().optional(),
  company: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(300),
  ats: jobApplySiteSchema,
  url: z.string().trim().url().max(2000),
  status: jobApplicationStatusSchema.default("QUEUED"),
  notes: z.string().max(4000).nullable().optional()
}).strict();
export type JobApplicationCreate = z.infer<typeof jobApplicationCreateSchema>;

export const jobApplicationUpdateSchema = z.object({
  status: jobApplicationStatusSchema.optional(),
  notes: z.string().max(4000).nullable().optional(),
  evidenceArtifactIds: z.array(artifactIdSchema).max(20).optional(),
  externalConfirmation: z.string().trim().max(500).nullable().optional(),
  appliedAt: isoDateTime.nullable().optional(),
  /** With status QUEUED: defer the posting until this time (an employer limit); null clears a deferral. */
  notBefore: isoDateTime.nullable().optional(),
  company: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(300).optional()
}).strict();
export type JobApplicationUpdate = z.infer<typeof jobApplicationUpdateSchema>;

export const jobApplicationListQuerySchema = z.object({
  status: jobApplicationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200)
}).strict();

/** The browser's IANA zone: the per-day history is counted in the operator's own days. */
export const jobApplyStatsQuerySchema = z.object({
  tz: z.string().min(1).max(64).refine((zone) => {
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
  }, "Unknown time zone").default("UTC")
}).strict();
const jobApplyDayCountsSchema = z.object({
  applied: z.number().int().min(0),
  verified: z.number().int().min(0),
  failed: z.number().int().min(0)
}).strict();
const jobApplyEarlierCountsSchema = z.object({ sent: z.number().int().min(0), failed: z.number().int().min(0) }).strict();
/** Applications since the first day (or the last reset), per day, and the earlier history kept apart. */
export const jobApplyStatsSchema = z.object({
  campaignStartedAt: z.string().nullable(),
  /** YYYY-MM-DD in the requested zone: the reset day, else the first day with an application. */
  firstDay: z.string().nullable(),
  today: jobApplyDayCountsSchema,
  totals: jobApplyDayCountsSchema.extend({ needsUser: z.number().int().min(0) }),
  /** Newest first. */
  days: z.array(jobApplyDayCountsSchema.extend({ day: z.string() })),
  earlier: z.object({ imported: jobApplyEarlierCountsSchema, archived: jobApplyEarlierCountsSchema }).strict()
}).strict();
export type JobApplyStats = z.infer<typeof jobApplyStatsSchema>;

/** "Reset and start over": the expected campaign start makes a repeated click a no-op (409), never a second reset. */
export const jobApplyResetRequestSchema = z.object({
  confirm: z.literal("RESET"),
  expectedCampaignStartedAt: isoDateTime.nullable()
}).strict();
export const jobApplyResetResultSchema = z.object({
  campaignStartedAt: isoDateTime,
  /** Queued, in-progress and waiting postings closed as FAILED (kept, and can be queued again). */
  closed: z.number().int().min(0),
  runsStopped: z.number().int().min(0)
}).strict();
export type JobApplyResetResult = z.infer<typeof jobApplyResetResultSchema>;

export const jobApplyCsvImportRequestSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).nullable().optional()
}).strict();
export const jobApplyMailCheckResultSchema = z.object({
  checked: z.number().int().min(0),
  confirmed: z.number().int().min(0),
  unconfirmed: z.number().int().min(0),
  accounts: z.array(z.string()).max(20)
}).strict();
export type JobApplyMailCheckResult = z.infer<typeof jobApplyMailCheckResultSchema>;

/**
 * Mail triage: application emails are filed under Gmail labels. Confirmations and rejections are archived;
 * a request to take a test or an interview (ACTION_NEEDED) and every other application mail (OTHER: questions,
 * offers, surveys, unknown) stay in the inbox.
 */
export const JOB_APPLY_MAIL_CATEGORIES = ["CONFIRMATION", "REJECTION", "ACTION_NEEDED", "OTHER"] as const;
export const jobApplyMailCategorySchema = z.enum(JOB_APPLY_MAIL_CATEGORIES);
export type JobApplyMailCategory = z.infer<typeof jobApplyMailCategorySchema>;
export const JOB_APPLY_MAIL_ROOT_LABEL = "Job Applications";
export const JOB_APPLY_MAIL_LABELS: Record<JobApplyMailCategory, string> = {
  CONFIRMATION: "Job Applications/Confirmations",
  REJECTION: "Job Applications/Rejections",
  ACTION_NEEDED: "Job Applications/Action needed",
  OTHER: "Job Applications/Other"
};
/** Organize categories: NONE takes the Job Applications labels off mail filed by mistake (archived only with `archive: true`). */
export const JOB_APPLY_MAIL_ORGANIZE_CATEGORIES = [...JOB_APPLY_MAIL_CATEGORIES, "NONE"] as const;
export const jobApplyMailOrganizeSchema = z.object({
  messageIds: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  category: z.enum(JOB_APPLY_MAIL_ORGANIZE_CATEGORIES),
  /** Defaults to true for confirmations and rejections; action-needed, other and NONE mail leave the inbox only when true. */
  archive: z.boolean().optional(),
  account: z.string().trim().toLowerCase().email().max(320).optional()
}).strict();
export type JobApplyMailOrganizeInput = z.infer<typeof jobApplyMailOrganizeSchema>;
/** The deadline (or interview time) the copilot read in a test or interview mail when Space found none or a wrong one. */
export const jobApplyMailDeadlineSchema = z.object({
  threadId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  dueAt: isoDateTime
}).strict();
export type JobApplyMailDeadlineInput = z.infer<typeof jobApplyMailDeadlineSchema>;
export const jobApplyMailTriageResultSchema = z.object({
  accounts: z.array(z.string()).max(20),
  scanned: z.number().int().min(0),
  confirmations: z.number().int().min(0),
  rejections: z.number().int().min(0),
  actionNeeded: z.number().int().min(0),
  other: z.number().int().min(0),
  skipped: z.number().int().min(0),
  /** Job-alert digests archived without a Job Applications label. */
  digests: z.number().int().min(0)
}).strict();
export type JobApplyMailTriageResult = z.infer<typeof jobApplyMailTriageResultSchema>;

export const jobApplyCsvImportResultSchema = z.object({
  imported: z.number().int().min(0),
  skipped: z.number().int().min(0),
  duplicates: z.number().int().min(0)
}).strict();

/** Board names used by the operator's earlier campaigns map onto the tracker's ATS set. */
export function jobApplySiteFromBoard(board: string | null | undefined, url?: string | null): JobApplySite {
  const text = `${board ?? ""} ${url ?? ""}`.toLowerCase();
  if (text.includes("linkedin")) return "linkedin";
  if (text.includes("greenhouse") || text.includes("gh-")) return "greenhouse";
  if (text.includes("ashby")) return "ashby";
  if (text.includes("lever")) return "lever";
  if (text.includes("workday") || text.includes("myworkdayjobs")) return "workday";
  if (text.includes("indeed")) return "indeed";
  return "other";
}

// ---------------------------------------------------------------------------
// Pasted posting URLs become queue rows before the agent has opened them.
// ---------------------------------------------------------------------------
export interface JobPostingFromUrl {
  url: string;
  ats: JobApplySite;
  company: string;
  role: string;
}

function titleCase(token: string): string {
  return token.split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * Company and role placeholders from the URL alone (board slug, posting id). The agent replaces
 * them with the real posting title and company when it opens the page (`space_job_application_update`).
 * Returns null for anything that is not an http(s) URL.
 */
export function jobPostingFromUrl(raw: string): JobPostingFromUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const url = parsed.toString().slice(0, 2000);
  const ats = jobApplySiteFromBoard(null, url);
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const last = segments.at(-1) ?? "";
  let company: string | null = null;
  let role: string | null = null;
  if (ats === "greenhouse") {
    // boards.greenhouse.io/<board>/jobs/<id>, job-boards.greenhouse.io/<board>/jobs/<id>, …/embed/job_app?for=<board>&token=<id>
    const board = parsed.searchParams.get("for") ?? segments.find((segment) => segment !== "embed" && segment !== "jobs" && !/^\d+$/.test(segment)) ?? null;
    const id = parsed.searchParams.get("token") ?? segments.find((segment) => /^\d{4,}$/.test(segment)) ?? null;
    company = board ? titleCase(board) : null;
    role = id ? `Posting ${id}` : null;
  } else if (ats === "ashby" || ats === "lever") {
    // jobs.ashbyhq.com/<company>/<uuid>, jobs.lever.co/<company>/<uuid>
    company = segments[0] ? titleCase(segments[0]) : null;
    role = segments[1] ? `Posting ${segments[1].slice(0, 8)}` : null;
  } else if (ats === "linkedin") {
    const id = segments.find((segment) => /^\d{6,}$/.test(segment)) ?? parsed.searchParams.get("currentJobId");
    const slug = segments.find((segment) => /-\d{6,}$/.test(segment))?.replace(/-\d{6,}$/, "");
    company = "LinkedIn posting";
    role = slug ? titleCase(slug) : id ? `Posting ${id}` : null;
  } else if (ats === "workday") {
    // <tenant>.wd<n>.myworkdayjobs.com/<site>/job/<location>/<slug>_<req-id>
    company = titleCase(host.split(".")[0] ?? "");
    const slug = last.replace(/_[A-Z0-9-]+$/i, "");
    role = slug ? titleCase(slug) : null;
  } else if (ats === "indeed") {
    company = "Indeed posting";
    const key = parsed.searchParams.get("jk") ?? parsed.searchParams.get("vjk");
    role = key ? `Posting ${key}` : null;
  }
  if (!company) {
    const labels = host.replace(/^(www|jobs|careers|boards|apply)\./, "").split(".");
    company = titleCase(labels.length > 1 ? labels[labels.length - 2]! : labels[0]!);
  }
  if (!role) role = last && !/^\d+$/.test(last) ? titleCase(last.replace(/\.[a-z]+$/i, "")).slice(0, 300) : "Posting";
  return { url, ats, company: company.slice(0, 200) || "Unknown company", role: role.slice(0, 300) || "Posting" };
}

// ---------------------------------------------------------------------------
// Job Copilot v2: dedicated memory, per-application field storage, activity
// events and the run supervisor. All records are per owner; never Dot memory.
// ---------------------------------------------------------------------------
export const JOB_APPLY_MEMORY_KINDS = ["FACT", "ANSWER", "SITE", "COMPANY", "LESSON", "PREFERENCE"] as const;
export const jobApplyMemoryKindSchema = z.enum(JOB_APPLY_MEMORY_KINDS);
export type JobApplyMemoryKind = z.infer<typeof jobApplyMemoryKindSchema>;

const memoryIdSchema = z.string().regex(/^jobmem:[A-Za-z0-9_-]{6,80}$/);
const memoryTagSchema = z.string().trim().min(1).max(60);
const memoryTagsSchema = z.array(memoryTagSchema).max(20).default([]);

export const jobApplyMemorySchema = z.object({
  id: memoryIdSchema,
  ownerUserId: z.string().min(1).max(200),
  kind: jobApplyMemoryKindSchema,
  /** Normalized question/label for answer-bank lookups; null for free facts and lessons. */
  key: z.string().trim().min(1).max(300).nullable(),
  text: z.string().trim().min(1).max(4000),
  site: jobApplySiteSchema.nullable(),
  company: z.string().trim().min(1).max(200).nullable(),
  tags: memoryTagsSchema,
  source: jobApplyQaSourceSchema,
  confidence: z.number().min(0).max(1),
  uses: z.number().int().min(0),
  pinned: z.boolean(),
  lastUsedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type JobApplyMemory = z.infer<typeof jobApplyMemorySchema>;

export const jobApplyMemoryCreateSchema = z.object({
  kind: jobApplyMemoryKindSchema,
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  site: jobApplySiteSchema.nullable().optional(),
  company: z.string().trim().min(1).max(200).nullable().optional(),
  tags: memoryTagsSchema.optional(),
  source: jobApplyQaSourceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional()
}).strict();
export type JobApplyMemoryCreate = z.infer<typeof jobApplyMemoryCreateSchema>;

export const jobApplyMemoryUpdateSchema = z.object({
  kind: jobApplyMemoryKindSchema.optional(),
  key: z.string().trim().min(1).max(300).nullable().optional(),
  text: z.string().trim().min(1).max(4000).optional(),
  site: jobApplySiteSchema.nullable().optional(),
  company: z.string().trim().min(1).max(200).nullable().optional(),
  tags: memoryTagsSchema.optional(),
  source: jobApplyQaSourceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional()
}).strict();
export type JobApplyMemoryUpdate = z.infer<typeof jobApplyMemoryUpdateSchema>;

/** Arrays from JSON bodies, comma lists from query strings. */
const kindList = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((part) => part.trim()).filter(Boolean) : value,
  z.array(jobApplyMemoryKindSchema).max(6)
);
export const jobApplyMemoryQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  site: jobApplySiteSchema.optional(),
  company: z.string().trim().min(1).max(200).optional(),
  kinds: kindList.optional(),
  /** Exact answer-bank keys to fetch (normalized labels of a form); unioned with the text query. */
  keys: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  pinnedOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20)
}).strict();
export type JobApplyMemoryQuery = z.infer<typeof jobApplyMemoryQuerySchema>;

/** Lower-case, punctuation folded, collapsed whitespace: the lookup key of answers and labels. */
export function normalizeJobApplyKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 300);
}

// Field storage: every filled control of every step, so each submission has its form snapshot.
export const JOB_APPLICATION_FIELD_TYPES = ["text", "select", "radio", "checkbox", "file", "textarea", "date"] as const;
export const jobApplicationFieldTypeSchema = z.enum(JOB_APPLICATION_FIELD_TYPES);
export type JobApplicationFieldType = z.infer<typeof jobApplicationFieldTypeSchema>;

const fieldIdSchema = z.string().regex(/^jobfield:[A-Za-z0-9_-]{6,80}$/);
export const jobApplicationFieldSchema = z.object({
  id: fieldIdSchema,
  applicationId: jobApplicationIdSchema,
  ownerUserId: z.string().min(1).max(200),
  stepIndex: z.number().int().min(0).max(50),
  stepTitle: z.string().trim().min(1).max(200).nullable(),
  label: z.string().trim().min(1).max(300),
  fieldType: jobApplicationFieldTypeSchema,
  refHint: z.string().trim().min(1).max(200).nullable(),
  /** Never passwords or codes; file fields store the file name. */
  value: z.string().max(4000).nullable(),
  source: jobApplyQaSourceSchema,
  filledAt: isoDateTime,
  verifiedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type JobApplicationField = z.infer<typeof jobApplicationFieldSchema>;

export const jobApplicationFieldInputSchema = z.object({
  stepIndex: z.number().int().min(0).max(50).default(0),
  stepTitle: z.string().trim().min(1).max(200).nullable().optional(),
  label: z.string().trim().min(1).max(300),
  fieldType: jobApplicationFieldTypeSchema.default("text"),
  refHint: z.string().trim().min(1).max(200).nullable().optional(),
  value: z.string().max(4000).nullable().optional(),
  source: jobApplyQaSourceSchema.default("AGENT"),
  verified: z.boolean().optional()
}).strict();
export type JobApplicationFieldInput = z.infer<typeof jobApplicationFieldInputSchema>;
export const jobApplicationFieldsRecordSchema = z.object({
  fields: z.array(jobApplicationFieldInputSchema).min(1).max(200)
}).strict();

/** Labels whose values stay out of the answer bank: identity, contact, uploads, secrets, one-time codes. */
const PERSONAL_FIELD_LABEL = /\b(first|last|full|given|family|sur)?\s?name\b|\be-?mail\b|\bphone\b|\bmobile\b|\btelephone\b|\baddress\b|\bcity\b|\bzip\b|\bpostal\b|\bstreet\b|\bpassword\b|\bpasscode\b|\botp\b|\b(security|verification|confirmation)\s+code\b|\bcode\b|\bresume\b|\bcv\b|\bcover\s+letter\b|\bupload\b|\bssn\b|\bsocial security\b|\bpassport\b|\bdate of birth\b|\bbirth\s*date\b|\bdob\b|\bcaptcha\b/i;
export function isPersonalJobApplyFieldLabel(label: string): boolean {
  return PERSONAL_FIELD_LABEL.test(label);
}

/** Whether a recorded field should refresh an ANSWER memory: a real answer to a non-personal question. */
export function fieldBecomesAnswerMemory(field: Pick<JobApplicationFieldInput, "label" | "fieldType" | "value">): boolean {
  if (!field.value || field.fieldType === "file" || field.value.trim().length === 0) return false;
  if (isPersonalJobApplyFieldLabel(field.label)) return false;
  return normalizeJobApplyKey(field.label).length >= 4;
}

// Activity events: the rail's timeline and the live broadcast.
export const JOB_APPLY_EVENT_TYPES = [
  "STARTED", "STEP", "FIELD_FILLED", "UPLOAD", "SUBMITTED", "VERIFIED", "FAILED", "HANDOFF_REQUESTED", "HANDOFF_RESOLVED",
  "QUESTION", "ANSWERED", "REVIEW_REQUESTED", "REVIEW_DECIDED", "NOTE", "SCREENSHOT",
  "RUN_STARTED", "RUN_PAUSED", "RUN_RESUMED", "RUN_STOPPED", "RUN_FINISHED", "MAIL"
] as const;
export const jobApplyEventTypeSchema = z.enum(JOB_APPLY_EVENT_TYPES);
export type JobApplyEventType = z.infer<typeof jobApplyEventTypeSchema>;

const eventIdSchema = z.string().regex(/^jobevt:[A-Za-z0-9_-]{6,80}$/);
const runIdSchema = z.string().regex(/^jobrun:[A-Za-z0-9_-]{6,80}$/);
export const jobApplyEventSchema = z.object({
  id: eventIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/).nullable(),
  applicationId: jobApplicationIdSchema.nullable(),
  runId: runIdSchema.nullable(),
  type: jobApplyEventTypeSchema,
  message: z.string().trim().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).default({}),
  artifactId: artifactIdSchema.nullable(),
  createdAt: isoDateTime
}).strict();
export type JobApplyEvent = z.infer<typeof jobApplyEventSchema>;

export const jobApplyEventInputSchema = z.object({
  applicationId: jobApplicationIdSchema.nullable().optional(),
  type: jobApplyEventTypeSchema.default("NOTE"),
  message: z.string().trim().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()).optional(),
  artifactId: artifactIdSchema.nullable().optional()
}).strict();
export type JobApplyEventInput = z.infer<typeof jobApplyEventInputSchema>;

export const jobApplyEventListQuerySchema = z.object({
  applicationId: jobApplicationIdSchema.optional(),
  runId: runIdSchema.optional(),
  since: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

// Run supervisor: one active run per pane; the queue is the ordered QUEUED rows of the pane's owner.
export const JOB_APPLY_RUN_STATUSES = ["IDLE", "RUNNING", "PAUSED", "STOPPED"] as const;
export const jobApplyRunStatusSchema = z.enum(JOB_APPLY_RUN_STATUSES);
export type JobApplyRunStatus = z.infer<typeof jobApplyRunStatusSchema>;

export const jobApplyRunCountersSchema = z.object({
  taken: z.number().int().min(0).default(0),
  submitted: z.number().int().min(0).default(0),
  verified: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  needsUser: z.number().int().min(0).default(0)
}).strict();
export type JobApplyRunCounters = z.infer<typeof jobApplyRunCountersSchema>;

export const jobApplyRunSchema = z.object({
  id: runIdSchema,
  ownerUserId: z.string().min(1).max(200),
  paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/),
  status: jobApplyRunStatusSchema,
  counters: jobApplyRunCountersSchema,
  currentApplicationId: jobApplicationIdSchema.nullable(),
  kickoffSentAt: isoDateTime.nullable(),
  startedAt: isoDateTime,
  pausedAt: isoDateTime.nullable(),
  stoppedAt: isoDateTime.nullable(),
  lastActivityAt: isoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type JobApplyRun = z.infer<typeof jobApplyRunSchema>;

export const jobApplyQueueReorderSchema = z.object({
  applicationIds: z.array(jobApplicationIdSchema).min(1).max(500)
}).strict();
export const jobApplyQueueAddSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2000)).min(1).max(100)
}).strict();

// Run loop tools: the agent pulls work with space_job_next and closes it with space_job_report.
export const JOB_APPLY_REPORT_OUTCOMES = ["submitted", "verified", "failed", "needs_user", "skipped"] as const;
export const jobApplyReportOutcomeSchema = z.enum(JOB_APPLY_REPORT_OUTCOMES);
export type JobApplyReportOutcome = z.infer<typeof jobApplyReportOutcomeSchema>;

export const jobApplyNextRequestSchema = z.object({
  waitMs: z.number().int().min(0).max(120_000).default(60_000)
}).strict();
export const jobApplyReportRequestSchema = z.object({
  runId: runIdSchema.optional(),
  applicationId: jobApplicationIdSchema,
  outcome: jobApplyReportOutcomeSchema,
  summary: z.string().trim().min(1).max(2000)
}).strict();

const questionIdSchema = z.string().regex(/^jobq:[A-Za-z0-9_-]{6,80}$/);
const reviewIdSchema = z.string().regex(/^jobrev:[A-Za-z0-9_-]{6,80}$/);
export const jobApplyQuestionAskSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  /** Which form control the answer is for, so the Fields tab can show it. */
  label: z.string().trim().min(1).max(300).optional()
}).strict();
export const jobApplyQuestionWaitSchema = z.object({
  questionId: questionIdSchema,
  waitMs: z.number().int().min(0).max(120_000).default(60_000)
}).strict();
export const jobApplyQuestionAnswerSchema = z.object({
  questionId: questionIdSchema,
  answer: z.string().trim().min(1).max(4000)
}).strict();
export const jobApplyReviewFieldSchema = z.object({
  label: z.string().trim().min(1).max(300),
  value: z.string().max(4000).nullable().default(null)
}).strict();
export const jobApplyReviewRequestSchema = z.object({
  fields: z.array(jobApplyReviewFieldSchema).min(1).max(200),
  note: z.string().trim().min(1).max(1000).optional()
}).strict();
export const jobApplyReviewWaitSchema = z.object({
  reviewId: reviewIdSchema,
  waitMs: z.number().int().min(0).max(120_000).default(60_000)
}).strict();
export const JOB_APPLY_REVIEW_DECISIONS = ["approve", "edit", "reject"] as const;
export const jobApplyReviewDecideSchema = z.object({
  reviewId: reviewIdSchema,
  decision: z.enum(JOB_APPLY_REVIEW_DECISIONS),
  /** Corrected values the agent must apply before submitting (decision "edit"). */
  edits: z.array(jobApplyReviewFieldSchema).max(200).optional(),
  note: z.string().trim().max(1000).optional()
}).strict();
export type JobApplyReviewDecision = z.infer<typeof jobApplyReviewDecideSchema>;

/** What the operator still owes the copilot: unanswered questions and undecided reviews. */
export const jobApplyPendingItemSchema = z.object({
  kind: z.enum(["QUESTION", "REVIEW"]),
  id: z.string().min(1).max(120),
  applicationId: jobApplicationIdSchema.nullable(),
  message: z.string().min(1).max(1000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime
}).strict();
export type JobApplyPendingItem = z.infer<typeof jobApplyPendingItemSchema>;

export const jobApplyRunViewSchema = z.object({
  run: jobApplyRunSchema.nullable(),
  status: jobApplyRunStatusSchema,
  queue: z.array(jobApplicationSchema),
  current: jobApplicationSchema.nullable(),
  pending: z.array(jobApplyPendingItemSchema)
}).strict();
export type JobApplyRunView = z.infer<typeof jobApplyRunViewSchema>;

// Discovery: public ATS job boards (JSON, no auth) searched by board token; results are deduped against the tracker.
export const JOB_APPLY_DISCOVERY_SITES = ["greenhouse", "lever", "ashby"] as const;
export const jobApplyDiscoverySiteSchema = z.enum(JOB_APPLY_DISCOVERY_SITES);
export type JobApplyDiscoverySite = z.infer<typeof jobApplyDiscoverySiteSchema>;

const boardTokenSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/i);
export const jobApplyDiscoverRequestSchema = z.object({
  /** Title keywords; every word must appear in the title (case-insensitive). Empty returns every posting. */
  query: z.string().trim().max(300).optional(),
  sites: z.array(jobApplyDiscoverySiteSchema).min(1).max(3).default([...JOB_APPLY_DISCOVERY_SITES]),
  /** Board tokens (company slugs) to scan, in addition to the ones remembered as SITE memories tagged board-token. */
  tokens: z.array(boardTokenSchema).max(40).default([]),
  location: z.string().trim().max(120).optional(),
  remote: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();
export type JobApplyDiscoverRequest = z.infer<typeof jobApplyDiscoverRequestSchema>;

export const jobApplyDiscoveredPostingSchema = z.object({
  url: z.string().url().max(2000),
  ats: jobApplyDiscoverySiteSchema,
  board: z.string().min(1).max(120),
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(300),
  location: z.string().max(200).nullable(),
  remote: z.boolean().nullable(),
  postedAt: isoDateTime.nullable(),
  /** Already in the tracker (same URL): shown but not queued again. */
  tracked: z.boolean()
}).strict();
export type JobApplyDiscoveredPosting = z.infer<typeof jobApplyDiscoveredPostingSchema>;

export const jobApplyDiscoverResultSchema = z.object({
  postings: z.array(jobApplyDiscoveredPostingSchema),
  scanned: z.array(z.object({ ats: jobApplyDiscoverySiteSchema, board: z.string(), count: z.number().int().min(0), error: z.string().nullable() })),
  truncated: z.boolean()
}).strict();
export type JobApplyDiscoverResult = z.infer<typeof jobApplyDiscoverResultSchema>;
