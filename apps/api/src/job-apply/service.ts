import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canTransitionJobApplication,
  fieldBecomesAnswerMemory,
  jobApplicationCreateSchema,
  jobApplicationFieldSchema,
  jobApplicationQueueHolds,
  jobApplicationSchema,
  jobApplicationUpdateSchema,
  jobApplyCandidateSchema,
  jobApplyEventSchema,
  jobApplyMailboxConfigSchema,
  jobApplyMailboxConnected,
  JOB_APPLY_IMPORTED_URL_PREFIX,
  JOB_APPLY_MAIL_CATEGORIES,
  JOB_APPLY_MAIL_LABELS,
  JOB_APPLY_MAIL_ROOT_LABEL,
  JOB_APPLY_NO_CONFIRMATION_NOTE,
  JOB_APPLY_UNRECORDED_ROLE,
  jobApplyMemoryCreateSchema,
  jobApplyMemoryQuerySchema,
  jobApplyMemorySchema,
  jobApplyMemoryUpdateSchema,
  jobApplyProfileSchema,
  jobApplyProfileUpdateSchema,
  jobApplyQaEntrySchema,
  jobApplyRunSchema,
  jobApplySiteFromBoard,
  jobPostingFromUrl,
  normalizeJobApplyKey,
  resolveJobApplyPaneMetadata,
  type Artifact,
  type ConnectorCapability,
  type JobApplication,
  type JobApplicationCreate,
  type JobApplicationField,
  type JobApplicationFieldInput,
  type JobApplicationStatus,
  type JobApplicationUpdate,
  type JobApplyEvent,
  type JobApplyDiscoverRequest,
  type JobApplyDiscoverySite,
  type JobApplyEventInput,
  type JobApplyEventType,
  type JobApplyGoogleAccount,
  type JobApplyGoogleMailAccount,
  type JobApplyMailboxInput,
  type JobApplyMailCategory,
  type JobApplyMailOrganizeInput,
  type JobApplyMailTriageResult,
  type JobApplyMemory,
  type JobApplyMemoryCreate,
  type JobApplyMemoryQuery,
  type JobApplyMemoryUpdate,
  type JobApplyPaneMetadata,
  type JobApplyPendingItem,
  type JobApplyProfile,
  type JobApplyProfileUpdate,
  type JobApplyReportOutcome,
  type JobApplyReviewDecision,
  type JobApplyRun,
  type JobApplyRunCounters,
  type JobApplyRunView,
  type JobApplyResetResult,
  type JobApplySite,
  type JobApplyStats
} from "@space/contracts";
import type { JobApplicationFieldRecord, JobApplicationRecord, JobApplyEventRecord, JobApplyMemoryRecord, JobApplyProfileRecord, JobApplyRepository, JobApplyRunRecord } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { localArtifactFilePath } from "../artifact-storage.js";
import { readAttachment, type AttachmentReaderOptions } from "../attachment-readers.js";
import type { ConnectorCrypto } from "../dot-connectors.js";
import { createDiscovery, type Discovery } from "./discovery.js";
import { CONFIRMATION_SEARCH_TERMS, companyKey, GmailMailboxError, matchConfirmationEmail, openGmailMailbox, searchGmail } from "./gmail-mailbox.js";
import { ensureJobApplyLabels, gmailMessageText, labelGmailMessages, unlabelGmailMessages, listGmailTriageMessages } from "./gmail-organize.js";
import { classifyApplicationMail, digestQuery, displaySender, isApplicationMail, isJobDigest, matchApplicationCompany, senderAddress, triageQuery } from "./mail-triage.js";
import { extractCode, extractLinksFromText, type MailboxFactory, type MailboxMessageSummary, type MailboxReader } from "./mailbox.js";

/** The owner's Google connector (Space Dots), used for the one Google account Job Copilot works with. */
export interface JobApplyGoogleAccess {
  /** Whether this server can ask Google for access (Google sign-in configured). */
  googleConfigured: boolean;
  /** Every Google account the owner allowed for Space, with what each allowed. */
  googleAccounts(owner: string): Promise<Array<{ email: string; capabilities: ConnectorCapability[] }>>;
  googleCapabilities(owner: string, email: string): Promise<ConnectorCapability[]>;
  googleAccessToken(owner: string, email: string, capability: ConnectorCapability): Promise<string>;
  /** Connector gateway tools (mail.search, mail.read, mail.draft, calendar.list, calendar.create). */
  tool(owner: string, toolId: string, args: Record<string, unknown>): Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
}

export interface JobApplyServiceOptions {
  repository: JobApplyRepository;
  crypto: ConnectorCrypto;
  store: Pick<SpaceStore, "getArtifact">;
  artifactRoot: string;
  /** Extracted CV text and read cache live here, outside any agent workspace. */
  jobApplyRoot: string;
  mailboxes: MailboxFactory;
  /** Reader worker and limits; tests point `workerPath` at the TypeScript worker. */
  readerOptions?: Pick<AttachmentReaderOptions, "workerPath" | "timeoutMs" | "memoryLimitBytes">;
  now?: () => string;
  /** Every recorded activity event, after it is stored (live broadcast, notifications). */
  onEvent?: (event: JobApplyEvent) => void;
  /** Public ATS board search; tests inject a fake fetch. */
  discovery?: Discovery;
  /** Gmail and Calendar of the Google account chosen in the pane; resolved late because connectors start after this service. */
  google?: () => JobApplyGoogleAccess | null;
  /** Gmail API fetch; tests inject a fake. */
  gmailFetch?: typeof fetch;
}

export class JobApplyMailboxError extends SpaceConflictError {}

/** Where an application update came from: the pane and run the agent is working in. */
export interface JobApplyEventContext { paneId?: string | null; runId?: string | null }

const MAX_CV_TEXT = 200_000;
const APPLIED_STATUSES: JobApplicationStatus[] = ["SUBMITTED", "VERIFIED"];
const STATUS_EVENT: Partial<Record<JobApplicationStatus, JobApplyEventType>> = {
  FILLING: "STARTED", NEEDS_USER: "QUESTION", SUBMITTED: "SUBMITTED", VERIFIED: "VERIFIED", FAILED: "FAILED", QUEUED: "NOTE"
};

function toProfile(record: JobApplyProfileRecord, google: JobApplyGoogleAccount | null, googleAccounts: JobApplyGoogleMailAccount[], googleAvailable: boolean): JobApplyProfile {
  return jobApplyProfileSchema.parse({
    ownerUserId: record.ownerUserId,
    candidate: jobApplyCandidateSchema.parse(record.candidate ?? {}),
    qaBank: (record.qaBank ?? []).flatMap((entry) => { const parsed = jobApplyQaEntrySchema.safeParse(entry); return parsed.success ? [parsed.data] : []; }),
    cvArtifactId: record.cvArtifactId,
    coverLetterArtifactId: record.coverLetterArtifactId,
    cvTextChars: record.cvText?.length ?? 0,
    mailbox: record.mailbox ? jobApplyMailboxConfigSchema.parse(record.mailbox) : null,
    mailboxVerifiedAt: record.mailboxVerifiedAt,
    google,
    googleAccounts,
    googleAvailable,
    campaignStartedAt: record.campaignStartedAt ?? null,
    updatedAt: record.updatedAt
  });
}

function toApplication(record: JobApplicationRecord): JobApplication {
  return jobApplicationSchema.parse(record);
}
function toMemory(record: JobApplyMemoryRecord): JobApplyMemory {
  return jobApplyMemorySchema.parse(record);
}
function toField(record: JobApplicationFieldRecord): JobApplicationField {
  return jobApplicationFieldSchema.parse(record);
}
function toEvent(record: JobApplyEventRecord): JobApplyEvent {
  return jobApplyEventSchema.parse(record);
}
function toRun(record: JobApplyRunRecord): JobApplyRun {
  return jobApplyRunSchema.parse({ ...record, counters: { taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0, ...record.counters } });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Earlier-tracker outcomes: sent (a claim, SUBMITTED), queued, and not sent (FAILED, with what happened). */
const CSV_SENT_OUTCOMES = new Set(["applied", "submitted", "verified"]);
const CSV_QUEUED_OUTCOMES = new Set(["queued", "pending"]);
const CSV_NOT_SENT_OUTCOMES: Record<string, string> = {
  failed: "failed", rejected: "rejected", no_form: "no application form found", form_no_submit: "form filled, not submitted",
  form_done_no_submit: "form completed, not submitted", err: "the attempt ended in an error", error: "the attempt ended in an error"
};
const NEXT_JOB_POLL_MS = 2_000;
const NEXT_JOB_MAX_WAIT_MS = 120_000;

// Function words carry no topic: two questions match only through the words that are left.
const ANSWER_STOP_WORDS = new Set(("a an the is are am be been was were do does did you your yours have has had of in on at to for with by from as or and "
  + "if any this that these those what which who whom how many much please kindly will would can could shall should may might now currently").split(" "));
function answerTerms(text: string): Set<string> {
  return new Set(normalizeJobApplyKey(text).split(" ").filter((word) => word && !ANSWER_STOP_WORDS.has(word)));
}

/**
 * Exact normalized key first; otherwise a stored question about the same topic: nearly the same content words
 * (Jaccard >= 0.8), or every content word of the shorter question appears in the longer one (3+ words, or covering
 * 60% of it). "German proficiency" never answers "pronouns"; "...in the United States" never answers "...in Australia".
 */
export function matchAnswerMemory(memories: JobApplyMemory[], question: string): JobApplyMemory | null {
  const asked = normalizeJobApplyKey(question);
  if (!asked) return null;
  const exact = memories.find((memory) => memory.key === asked);
  if (exact) return exact;
  const askedTerms = answerTerms(asked);
  if (!askedTerms.size) return null;
  let best: JobApplyMemory | null = null;
  let bestScore = 0;
  for (const memory of memories) {
    if (!memory.key) continue;
    const keyTerms = answerTerms(memory.key);
    if (!keyTerms.size) continue;
    const shared = [...keyTerms].filter((term) => askedTerms.has(term)).length;
    const jaccard = shared / new Set([...keyTerms, ...askedTerms]).size;
    const [small, large] = keyTerms.size <= askedTerms.size ? [keyTerms, askedTerms] : [askedTerms, keyTerms];
    const contained = shared === small.size && (small.size >= 3 || small.size / large.size >= 0.6);
    if (jaccard < 0.8 && !contained) continue;
    const score = jaccard + shared / 1000;
    if (score > bestScore) { best = memory; bestScore = score; }
  }
  return best;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") { field += "\""; index += 1; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

export function createJobApplyService(options: JobApplyServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const { repository, crypto } = options;
  const discovery = options.discovery ?? createDiscovery();

  async function profileRecord(owner: string): Promise<JobApplyProfileRecord> {
    return (await repository.getProfile(owner)) ?? repository.upsertProfile(owner, {});
  }

  async function record(owner: string, input: JobApplyEventInput & JobApplyEventContext & { type: JobApplyEventType }): Promise<JobApplyEvent> {
    const event = toEvent(await repository.createEvent({
      ownerUserId: owner, paneId: input.paneId ?? null, applicationId: input.applicationId ?? null, runId: input.runId ?? null,
      type: input.type, message: input.message.slice(0, 1000), payload: input.payload ?? {}, artifactId: input.artifactId ?? null
    }));
    try {
      options.onEvent?.(event);
    } catch {
      // Listeners never break the write.
    }
    return event;
  }

  /** The v1 Q&A bank becomes ANSWER memories once; the bank is then empty and memory is the only answer source. */
  const migratedQaOwners = new Set<string>();
  async function ensureQaBankMigrated(owner: string): Promise<void> {
    if (migratedQaOwners.has(owner)) return;
    migratedQaOwners.add(owner);
    const profile = await profileRecord(owner);
    const entries = (profile.qaBank ?? []).flatMap((entry) => { const parsed = jobApplyQaEntrySchema.safeParse(entry); return parsed.success ? [parsed.data] : []; });
    if (entries.length === 0) return;
    for (const entry of entries) {
      const key = normalizeJobApplyKey(entry.question);
      if (!key || !entry.answer.trim()) continue;
      await repository.upsertMemoryByKey({ ownerUserId: owner, kind: "ANSWER", key, text: entry.answer.trim(), site: null, company: null, tags: ["qa-bank"],
        source: entry.source, confidence: entry.source === "USER" || entry.source === "PROFILE" ? 0.95 : 0.75, pinned: false });
    }
    await repository.upsertProfile(owner, { qaBank: [] });
  }

  /** Active space_job_next pollers per pane: a Start with none waiting must send the kickoff prompt again. */
  const nextJobWaiters = new Map<string, number>();
  function summarizeCounters(counters: Record<string, number>): string {
    return `${counters.submitted ?? 0} submitted, ${counters.verified ?? 0} verified, ${counters.failed ?? 0} failed, ${counters.needsUser ?? 0} need you`;
  }

  async function rememberAnswerFromField(owner: string, application: JobApplicationRecord, field: JobApplicationFieldInput): Promise<void> {
    if (!fieldBecomesAnswerMemory(field) || !field.value) return;
    await repository.upsertMemoryByKey({ ownerUserId: owner, kind: "ANSWER", key: normalizeJobApplyKey(field.label), text: field.value.trim().slice(0, 4000),
      site: null, company: null, tags: ["form", application.ats], source: field.source,
      confidence: field.source === "USER" || field.source === "PROFILE" ? 0.95 : 0.7, pinned: false });
  }

  /** The note a question or review left on a parked application, so leaving NEEDS_USER gives the earlier note back. */
  const REVIEW_NOTE = "Review before submit";
  /** The copilot still works on a posting while its pane's active run has it as the current application. */
  async function copilotOn(owner: string, applicationId: string, paneId: string | null): Promise<boolean> {
    const run = paneId ? await repository.getActiveRun(paneId) : null;
    return run?.ownerUserId === owner && run.currentApplicationId === applicationId;
  }

  async function notesBeforeParking(owner: string, application: JobApplicationRecord): Promise<string | null | undefined> {
    if (application.status !== "NEEDS_USER" || !application.notes) return undefined;
    const events = await repository.listEvents(owner, { applicationId: application.id, limit: 200 });
    const parking = events.find((event) => (event.type === "QUESTION" && String(event.payload.question ?? "").slice(0, 4000) === application.notes)
      || (event.type === "REVIEW_REQUESTED" && application.notes === REVIEW_NOTE));
    if (!parking) return undefined;
    return typeof parking.payload.previousNotes === "string" ? parking.payload.previousNotes : null;
  }

  async function googleAccount(owner: string, record: JobApplyProfileRecord): Promise<JobApplyGoogleAccount | null> {
    if (!record.googleEmail) return null;
    const google = options.google?.() ?? null;
    return { email: record.googleEmail, capabilities: google ? await google.googleCapabilities(owner, record.googleEmail).catch(() => []) : [], available: Boolean(google?.googleConfigured) };
  }
  /** Every Google account allowed for Space; Job Copilot reads mail from all that allowed it. */
  async function googleMailAccounts(owner: string): Promise<JobApplyGoogleMailAccount[]> {
    const google = options.google?.() ?? null;
    return google ? await google.googleAccounts(owner).catch(() => []) : [];
  }
  async function profileOf(owner: string, record: JobApplyProfileRecord): Promise<JobApplyProfile> {
    const [google, accounts] = await Promise.all([googleAccount(owner, record), googleMailAccounts(owner)]);
    return toProfile(record, google, accounts, Boolean(options.google?.()?.googleConfigured));
  }
  /** A connector refusal in Job Copilot words: access is allowed again from the pane's Setup, not a Dot's Tools view. */
  function googleAccessError(email: string, error: unknown): JobApplyMailboxError {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "CONNECTOR_RECONNECT" || code === "CONNECTOR_NEEDS_CONNECTION" || (error instanceof GmailMailboxError && error.status === 401)) {
      return new JobApplyMailboxError(`Google access for ${email} is missing or expired. Allow Gmail & Calendar again in Job Copilot Setup → Google account.`);
    }
    return new JobApplyMailboxError(`Gmail could not be read: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
  }
  /** Reads one Google account's Gmail, turning connector and Gmail failures into Job Copilot errors. */
  async function readGmail<T>(owner: string, email: string, read: (reader: MailboxReader) => Promise<T>): Promise<T> {
    const google = options.google?.() ?? null;
    if (!google) throw new JobApplyMailboxError("Google access is unavailable on this server.");
    try {
      return await read(openGmailMailbox({ accessToken: await google.googleAccessToken(owner, email, "MAIL_READ"), fetchImpl: options.gmailFetch }));
    } catch (error) {
      throw googleAccessError(email, error);
    }
  }

  /**
   * Reads every mailbox the copilot may use: the Gmail of each Google account that allowed reading mail (the
   * chosen account first) and the IMAP mailbox. Messages carry their account and come newest first; one
   * lapsed account does not hide the others, and only when none answers is its error raised.
   */
  async function readMailboxes<T extends MailboxMessageSummary>(owner: string, read: (reader: MailboxReader) => Promise<T[]>, limit: number): Promise<Array<T & { account: string }>> {
    const record = await profileRecord(owner);
    const gmail = (await googleMailAccounts(owner)).filter((account) => account.capabilities.includes("MAIL_READ")).map((account) => account.email)
      .sort((left, right) => Number(right === record.googleEmail) - Number(left === record.googleEmail));
    const imap = Boolean(record.mailbox && record.mailboxPasswordEncrypted);
    if (!gmail.length && !imap) await openMailbox(owner);
    const reads: Array<Promise<Array<T & { account: string }>>> = gmail.map(async (email) => (await readGmail(owner, email, read)).map((message) => ({ ...message, account: email })));
    if (imap) {
      reads.push((async () => {
        const reader = await openMailbox(owner);
        try {
          const user = jobApplyMailboxConfigSchema.parse(record.mailbox).user;
          return (await read(reader)).map((message) => ({ ...message, account: user }));
        } finally {
          await reader.close().catch(() => undefined);
        }
      })());
    }
    const settled = await Promise.allSettled(reads);
    const answered = settled.filter((result): result is PromiseFulfilledResult<Array<T & { account: string }>> => result.status === "fulfilled");
    if (!answered.length) throw (settled[0] as PromiseRejectedResult).reason;
    const seen = new Set<string>();
    return answered.flatMap((result) => result.value)
      .sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""))
      // The same message read through Gmail and through IMAP of the same address counts once.
      .filter((message) => { const key = `${message.from}\u0000${message.subject}\u0000${message.receivedAt}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, limit);
  }

  async function openMailbox(owner: string): Promise<MailboxReader> {
    const record = await profileRecord(owner);
    if (!record.mailbox || !record.mailboxPasswordEncrypted) {
      throw new JobApplyMailboxError(record.googleEmail
        ? `Allow Gmail access for ${record.googleEmail} in Job Copilot Setup → Google account, or connect a mailbox there.`
        : "Allow Gmail for a Google account in Job Copilot Setup → Google account, or connect a mailbox there.");
    }
    const config = jobApplyMailboxConfigSchema.parse(record.mailbox);
    let password: string;
    try {
      password = crypto.open(record.mailboxPasswordEncrypted);
    } catch {
      throw new JobApplyMailboxError("The saved mailbox password cannot be read any more. Reconnect the mailbox.");
    }
    try {
      return await options.mailboxes.open(config, password);
    } catch (error) {
      throw new JobApplyMailboxError(`Mailbox connection failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
    }
  }

  async function assertTransition(owner: string, id: string, next: JobApplicationStatus | undefined, patch: JobApplicationUpdate) {
    const current = await repository.getApplication(owner, id);
    if (!current) throw new SpaceNotFoundError(`Application ${id} was not found.`);
    if (next && !canTransitionJobApplication(current.status as JobApplicationStatus, next)) {
      throw new SpaceConflictError(`Application ${id} cannot move from ${current.status} to ${next}.`);
    }
    if (next === "VERIFIED") {
      const evidence = patch.evidenceArtifactIds ?? current.evidenceArtifactIds;
      const confirmation = patch.externalConfirmation === undefined ? current.externalConfirmation : patch.externalConfirmation;
      if (evidence.length === 0 && !confirmation) {
        throw new SpaceConflictError("VERIFIED needs evidence: a confirmation screenshot artifact or a confirmation reference.");
      }
    }
    return current;
  }

  return {
    /** The construction options, so a caller can derive a service with extra listeners. */
    options,
    async getProfile(owner: string): Promise<JobApplyProfile> {
      return profileOf(owner, await profileRecord(owner));
    },
    async updateProfile(owner: string, input: JobApplyProfileUpdate): Promise<JobApplyProfile> {
      const update = jobApplyProfileUpdateSchema.parse(input);
      const patch: Parameters<JobApplyRepository["upsertProfile"]>[1] = {};
      if (update.candidate) patch.candidate = update.candidate;
      if (update.qaBank) patch.qaBank = update.qaBank;
      if (update.cvArtifactId !== undefined) patch.cvArtifactId = update.cvArtifactId;
      if (update.coverLetterArtifactId !== undefined) patch.coverLetterArtifactId = update.coverLetterArtifactId;
      return profileOf(owner, await repository.upsertProfile(owner, patch));
    },
    /** Extracts the CV text (PDF, DOCX, text) from an Agent Files artifact and remembers both. */
    async importCv(owner: string, artifactId: string): Promise<{ profile: JobApplyProfile; coverage: string; textPreview: string }> {
      let artifact: Artifact;
      try {
        artifact = await options.store.getArtifact(artifactId);
      } catch {
        throw new SpaceNotFoundError(`Artifact ${artifactId} was not found.`);
      }
      if (artifact.deletedAt) throw new SpaceNotFoundError(`Artifact ${artifactId} was deleted.`);
      const sourcePath = localArtifactFilePath({ artifactRoot: options.artifactRoot, artifact });
      const ownerDir = join(options.jobApplyRoot, owner.replace(/[^A-Za-z0-9_-]/g, "_"));
      await mkdir(join(ownerDir, "reads"), { recursive: true, mode: 0o750 });
      const filename = typeof artifact.metadata.originalFilename === "string" ? artifact.metadata.originalFilename : artifact.id;
      const result = await readAttachment(
        { artifactId: artifact.id, sourcePath, filename, mimeType: artifact.mimeType, byteSize: artifact.byteSize, sha256: artifact.sha256 },
        { outputDir: join(ownerDir, "reads"), cacheDir: join(options.jobApplyRoot, "read-cache"), maxChars: MAX_CV_TEXT, ...options.readerOptions }
      );
      if (result.coverage.status === "UNAVAILABLE" || !result.outputPath) {
        throw new SpaceConflictError(`The CV could not be read (${result.coverage.reason ?? "no text"}). Use a PDF, DOCX or text file.`);
      }
      const text = (await readFile(result.outputPath, "utf8")).slice(0, MAX_CV_TEXT);
      const record = await repository.upsertProfile(owner, { cvArtifactId: artifact.id, cvText: text });
      return { profile: await profileOf(owner, record), coverage: result.coverage.status, textPreview: text.slice(0, 1200) };
    },
    async cvText(owner: string): Promise<{ artifactId: string | null; path: string | null; text: string | null }> {
      const record = await profileRecord(owner);
      let path: string | null = null;
      if (record.cvArtifactId) {
        try {
          path = localArtifactFilePath({ artifactRoot: options.artifactRoot, artifact: await options.store.getArtifact(record.cvArtifactId) });
        } catch {
          path = null;
        }
      }
      return { artifactId: record.cvArtifactId, path, text: record.cvText };
    },
    async artifactPath(artifactId: string): Promise<string | null> {
      try {
        return localArtifactFilePath({ artifactRoot: options.artifactRoot, artifact: await options.store.getArtifact(artifactId) });
      } catch {
        return null;
      }
    },
    async setMailbox(owner: string, input: JobApplyMailboxInput): Promise<JobApplyProfile> {
      const { password, ...config } = input;
      let reader: MailboxReader;
      try {
        reader = await options.mailboxes.open(config, password);
      } catch (error) {
        throw new JobApplyMailboxError(`Mailbox connection failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
      }
      await reader.close().catch(() => undefined);
      const record = await repository.upsertProfile(owner, { mailbox: config, mailboxPasswordEncrypted: crypto.seal(password), mailboxVerifiedAt: now() });
      return profileOf(owner, record);
    },
    async testMailbox(owner: string): Promise<{ ok: true; verifiedAt: string; recent: MailboxMessageSummary[] }> {
      const recent = await readMailboxes(owner, (reader) => reader.recent({ limit: 3 }), 3);
      const verifiedAt = now();
      await repository.upsertProfile(owner, { mailboxVerifiedAt: verifiedAt });
      return { ok: true, verifiedAt, recent };
    },
    async clearMailbox(owner: string): Promise<JobApplyProfile> {
      return profileOf(owner, await repository.upsertProfile(owner, { mailbox: null, mailboxPasswordEncrypted: null, mailboxVerifiedAt: null }));
    },
    /** The Google account the copilot works with (mail and calendar through the owner's Google connector); null forgets it. */
    async setGoogleAccount(owner: string, email: string | null): Promise<JobApplyProfile> {
      return profileOf(owner, await repository.upsertProfile(owner, { googleEmail: email ? email.trim().toLowerCase() : null }));
    },
    /**
     * Gmail and Calendar of the copilot's Google account: mail.search, mail.read, mail.draft, calendar.list and
     * calendar.create through the connector gateway. Mail is never sent and events invite nobody from here.
     */
    async googleTool(owner: string, toolId: "mail.search" | "mail.read" | "mail.draft" | "calendar.list" | "calendar.create", args: Record<string, unknown>): Promise<unknown> {
      const record = await profileRecord(owner);
      const google = options.google?.() ?? null;
      if (!google) throw new SpaceConflictError("Google access is unavailable on this server.");
      const capability: ConnectorCapability = toolId.startsWith("calendar.") ? "CALENDAR" : toolId === "mail.draft" ? "MAIL_COMPOSE" : "MAIL_READ";
      const what = capability === "CALENDAR" ? "calendar" : capability === "MAIL_COMPOSE" ? "drafting email" : "reading email";
      const allowed = (await googleMailAccounts(owner)).filter((account) => account.capabilities.includes(capability)).map((account) => account.email);
      const { account: named, ...rest } = args;
      const requested = typeof named === "string" && named.trim() ? named.trim().toLowerCase() : null;
      if (requested && !allowed.includes(requested)) {
        throw new SpaceConflictError(`${requested} has not allowed ${what} for Space. Allow Gmail & Calendar for it in Job Copilot Setup → Google account.`);
      }
      if (!allowed.length) {
        throw new SpaceConflictError(record.googleEmail
          ? `${record.googleEmail} has not allowed ${what} for Space. Allow Gmail & Calendar in Job Copilot Setup → Google account.`
          : `No Google account has allowed ${what} for Space. Allow Gmail & Calendar for one in Job Copilot Setup → Google account.`);
      }
      const call = async (email: string) => {
        const outcome = await google.tool(owner, toolId, { ...rest, account: email });
        if (outcome.status === "COMPLETED") return outcome.result as Record<string, unknown>;
        // The connector words a lapsed grant for Dots ("Reconnect it in the Tools view").
        throw new SpaceConflictError(/expired or was revoked/.test(outcome.statusReason)
          ? `Google access for ${email} expired or was revoked. Allow Gmail & Calendar again in Job Copilot Setup → Google account.`
          : outcome.statusReason);
      };
      // A search without a named account spans every account that allowed reading mail.
      if (toolId === "mail.search" && !requested && allowed.length > 1) {
        const settled = await Promise.allSettled(allowed.map(async (email) => ({ email, result: await call(email) })));
        const answered = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
        if (!answered.length) throw (settled[0] as PromiseRejectedResult).reason;
        const limit = typeof rest.limit === "number" ? rest.limit : 10;
        const messages = answered.flatMap(({ email, result }) => ((result.messages as Array<Record<string, unknown>> | undefined) ?? []).map((message): Record<string, unknown> => ({ account: email, ...message })))
          .sort((left, right) => String(right.receivedAt ?? "").localeCompare(String(left.receivedAt ?? ""))).slice(0, limit);
        const failed = settled.flatMap((entry, index) => entry.status === "rejected" ? [{ account: allowed[index]!, reason: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }] : []);
        return { accounts: answered.map(({ email }) => email), untrusted: answered[0]!.result.untrusted, messages, ...(failed.length ? { failed } : {}) };
      }
      // Otherwise the named account, else the chosen one when it allowed this, else the first that did.
      return call(requested ?? (record.googleEmail && allowed.includes(record.googleEmail) ? record.googleEmail : allowed[0]!));
    },
    /**
     * Check with Gmail: every SUBMITTED row without evidence is looked up among the confirmation emails in the Gmail
     * of each Google account that allowed reading mail. A matching email (company named, sent within days of the
     * application) makes the row VERIFIED with that email as its confirmation; the others stay SUBMITTED and say so.
     */
    async checkWithMail(owner: string, context: JobApplyEventContext = {}): Promise<{ checked: number; confirmed: number; unconfirmed: number; accounts: string[] }> {
      const google = options.google?.() ?? null;
      const accounts = (await googleMailAccounts(owner)).filter((account) => account.capabilities.includes("MAIL_READ")).map((account) => account.email);
      if (!google || !accounts.length) throw new JobApplyMailboxError("Allow Gmail for a Google account in Job Copilot Setup → Google account first.");
      const candidates = (await repository.listApplications(owner, { status: "SUBMITTED", limit: 2000 }))
        .filter((row) => row.appliedAt && !row.externalConfirmation && row.evidenceArtifactIds.length === 0);
      if (!candidates.length) return { checked: 0, confirmed: 0, unconfirmed: 0, accounts };
      const sentTimes = candidates.map((row) => Date.parse(row.appliedAt!));
      const gmailDay = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "/");
      const query = `after:${gmailDay(Math.min(...sentTimes) - 2 * 86_400_000)} before:${gmailDay(Math.max(...sentTimes) + 8 * 86_400_000)} {${CONFIRMATION_SEARCH_TERMS}}`;
      const searches = await Promise.allSettled(accounts.map(async (email) => {
        try {
          const hits = await searchGmail({ accessToken: await google.googleAccessToken(owner, email, "MAIL_READ"), query, max: 1000, fetchImpl: options.gmailFetch });
          return hits.map((hit) => ({ ...hit, account: email }));
        } catch (error) {
          throw googleAccessError(email, error);
        }
      }));
      if (searches.every((search) => search.status === "rejected")) throw (searches[0] as PromiseRejectedResult).reason;
      const hits = searches.flatMap((search) => search.status === "fulfilled" ? search.value : []);
      const searched = accounts.filter((_email, index) => searches[index]!.status === "fulfilled");
      const checkedOn = now().slice(0, 10);
      let confirmed = 0;
      for (const row of candidates) {
        const hit = matchConfirmationEmail(row, hits);
        // One current mail-check note: earlier results and the import's "not checked yet" give way to this one.
        const notes = (row.notes ?? "").split(" | ").filter(Boolean).map((segment) => segment.replace(/; no confirmation email checked yet$/, ""))
          .filter((segment) => !segment.startsWith(JOB_APPLY_NO_CONFIRMATION_NOTE) && !segment.startsWith("confirmation email "));
        if (hit) {
          confirmed += 1;
          const day = hit.receivedAt?.slice(0, 10) ?? checkedOn;
          await repository.updateApplication(owner, row.id, { status: "VERIFIED", externalConfirmation: `Gmail ${hit.account}: "${hit.subject}" ${day}`.slice(0, 500),
            notes: [...notes, `confirmation email ${day}`].join(" | ").slice(0, 4000) });
        } else {
          await repository.updateApplication(owner, row.id, { notes: [...notes, `${JOB_APPLY_NO_CONFIRMATION_NOTE} (checked ${checkedOn})`].join(" | ").slice(0, 4000) });
        }
      }
      const result = { checked: candidates.length, confirmed, unconfirmed: candidates.length - confirmed, accounts: searched };
      await record(owner, { ...context, type: "NOTE", payload: result,
        message: `Checked ${result.checked} sent applications against Gmail (${searched.join(", ")}): ${confirmed} confirmed by email, ${result.unconfirmed} without a confirmation email.` });
      return result;
    },
    /**
     * Files messages under a Job Applications label (MAIL_ORGANIZE): confirmations and rejections leave the inbox
     * unless `archive` is false; action-needed mail and NONE (labels taken off) leave it only with `archive: true`.
     * The copilot uses this for mail the rules missed.
     */
    async organizeMail(owner: string, input: JobApplyMailOrganizeInput, context: JobApplyEventContext = {}): Promise<{ account: string; category: JobApplyMailOrganizeInput["category"]; label: string | null; organized: number; archived: boolean }> {
      const google = options.google?.() ?? null;
      if (!google) throw new SpaceConflictError("Google access is unavailable on this server.");
      const profile = await profileRecord(owner);
      const allowed = (await googleMailAccounts(owner)).filter((account) => account.capabilities.includes("MAIL_ORGANIZE")).map((account) => account.email);
      const account = input.account ?? (profile.googleEmail && allowed.includes(profile.googleEmail) ? profile.googleEmail : allowed[0]);
      if (!account || !allowed.includes(account)) {
        throw new SpaceConflictError(`${input.account ?? profile.googleEmail ?? "No Google account"} has not allowed organizing mail for Space. Allow Gmail & Calendar again in Job Copilot Setup → Google account.`);
      }
      const category = input.category;
      const archive = input.archive ?? (category === "CONFIRMATION" || category === "REJECTION");
      try {
        const accessToken = await google.googleAccessToken(owner, account, "MAIL_ORGANIZE");
        const labels = await ensureJobApplyLabels({ accessToken, fetchImpl: options.gmailFetch });
        if (category === "NONE") await unlabelGmailMessages({ accessToken, fetchImpl: options.gmailFetch, messageIds: input.messageIds, labelIds: [...(archive ? ["INBOX"] : []), ...Object.values(labels)] });
        else await labelGmailMessages({ accessToken, fetchImpl: options.gmailFetch, messageIds: input.messageIds, labelId: labels[category], archive, replaceLabelIds: Object.values(labels) });
      } catch (error) {
        throw googleAccessError(account, error);
      }
      const label = category === "NONE" ? null : JOB_APPLY_MAIL_LABELS[category];
      const count = `${input.messageIds.length} email${input.messageIds.length === 1 ? "" : "s"}`;
      await record(owner, { ...context, type: "MAIL", payload: { category, count: input.messageIds.length, account, archived: archive },
        message: label ? `${archive ? "Archived" : "Labeled"} ${count} under ${label}` : archive ? `Archived ${count} without the ${JOB_APPLY_MAIL_ROOT_LABEL} labels` : `Removed the ${JOB_APPLY_MAIL_ROOT_LABEL} labels from ${count}` });
      return { account, category, label, organized: input.messageIds.length, archived: archive };
    },
    /**
     * One triage pass over the inbox of every Google account that allowed reading and organizing mail: recent
     * application mail is classified, filed under the Job Applications labels and, for receipts, stale codes and
     * rejections, archived. Action-needed mail stays in the inbox and becomes a MAIL event that the rail and
     * Telegram show. Messages already under a Job Applications label are skipped, so passes are idempotent.
     * Job-alert digests leave the inbox without a Job Applications label.
     */
    async triageMail(owner: string, context: JobApplyEventContext = {}): Promise<JobApplyMailTriageResult> {
      const google = options.google?.() ?? null;
      const accounts = (await googleMailAccounts(owner)).filter((account) => account.capabilities.includes("MAIL_READ") && account.capabilities.includes("MAIL_ORGANIZE")).map((account) => account.email);
      const result: JobApplyMailTriageResult = { accounts: [], scanned: 0, confirmations: 0, rejections: 0, actionNeeded: 0, skipped: 0, digests: 0 };
      if (!google || !accounts.length) return result;
      // Recent tracker rows name the companies whose own recruiters may write (imported history included).
      const applications = (await repository.listApplications(owner, { limit: 2000 })).filter((row) => row.status !== "QUEUED")
        .sort((left, right) => (right.appliedAt ?? right.updatedAt).localeCompare(left.appliedAt ?? left.updatedAt));
      const companies = [...new Map(applications.map((row) => [companyKey(row.company), row])).values()].filter((row) => companyKey(row.company).length >= 4);
      const paneId = context.paneId ?? (await repository.listEvents(owner, { limit: 50 })).find((event) => event.paneId)?.paneId ?? null;
      const nowMs = Date.parse(now());
      for (const email of accounts) {
        try {
          const accessToken = await google.googleAccessToken(owner, email, "MAIL_ORGANIZE");
          const labels = await ensureJobApplyLabels({ accessToken, fetchImpl: options.gmailFetch });
          const ours = new Set(Object.values(labels));
          const messages = (await listGmailTriageMessages({ accessToken, fetchImpl: options.gmailFetch, query: triageQuery(companies.slice(0, 60).map((row) => row.company)), max: 50 }))
            .filter((message) => !message.labelIds.some((label) => ours.has(label)) && isApplicationMail(message, companies));
          const filed: Record<JobApplyMailCategory, string[]> = { CONFIRMATION: [], REJECTION: [], ACTION_NEEDED: [] };
          const notices: Array<JobApplyEventInput & JobApplyEventContext & { type: JobApplyEventType }> = [];
          for (const message of messages.slice(0, 25)) {
            result.scanned += 1;
            const text = await gmailMessageText({ accessToken, fetchImpl: options.gmailFetch, messageId: message.messageId, max: 6000 }).catch(() => message.snippet);
            const category = classifyApplicationMail({ ...message, text }, nowMs);
            if (!category) { result.skipped += 1; continue; }
            filed[category].push(message.messageId);
            const application = matchApplicationCompany(message, companies);
            const sender = displaySender(message.from);
            if (category === "ACTION_NEEDED") {
              notices.push({ paneId, applicationId: application?.id ?? null, type: "MAIL",
                message: `Action needed: ${message.subject || "(no subject)"} from ${sender}`.slice(0, 1000),
                payload: { category, account: email, messageId: message.messageId, from: senderAddress(message.from), subject: message.subject.slice(0, 300), receivedAt: message.receivedAt } });
            } else if (category === "REJECTION" && application) {
              notices.push({ paneId, applicationId: application.id, type: "MAIL",
                message: `Rejection email from ${sender}: ${message.subject || "(no subject)"}`.slice(0, 1000),
                payload: { category, account: email, messageId: message.messageId, subject: message.subject.slice(0, 300), receivedAt: message.receivedAt } });
            }
          }
          // Labels first: a message is announced only once it carries its label, so a failed pass never repeats a notice.
          for (const category of JOB_APPLY_MAIL_CATEGORIES) {
            await labelGmailMessages({ accessToken, fetchImpl: options.gmailFetch, messageIds: filed[category], labelId: labels[category], archive: category !== "ACTION_NEEDED" });
          }
          for (const notice of notices) await record(owner, notice);
          const digests = (await listGmailTriageMessages({ accessToken, fetchImpl: options.gmailFetch, query: digestQuery(), max: 50 })).filter(isJobDigest).map((message) => message.messageId);
          await unlabelGmailMessages({ accessToken, fetchImpl: options.gmailFetch, messageIds: digests, labelIds: ["INBOX", ...ours] });
          result.digests += digests.length;
          result.confirmations += filed.CONFIRMATION.length;
          result.rejections += filed.REJECTION.length;
          result.actionNeeded += filed.ACTION_NEEDED.length;
          result.accounts.push(email);
          const archived = filed.CONFIRMATION.length + filed.REJECTION.length + digests.length;
          if (archived) {
            const parts = [filed.CONFIRMATION.length ? `${filed.CONFIRMATION.length} confirmation${filed.CONFIRMATION.length === 1 ? "" : "s"}` : "",
              filed.REJECTION.length ? `${filed.REJECTION.length} rejection${filed.REJECTION.length === 1 ? "" : "s"}` : "",
              digests.length ? `${digests.length} job alert${digests.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
            await record(owner, { paneId, type: "MAIL", payload: { category: "ARCHIVED", account: email, confirmations: filed.CONFIRMATION.length, rejections: filed.REJECTION.length, digests: digests.length },
              message: `Archived ${parts} from ${email}${filed.CONFIRMATION.length + filed.REJECTION.length ? ` under ${JOB_APPLY_MAIL_ROOT_LABEL}` : ""}` });
          }
        } catch (error) {
          // One lapsed account does not stop the others; the next pass tries again.
          if (accounts.length === 1) throw googleAccessError(email, error);
        }
      }
      return result;
    },
    /** The periodic pass: every owner whose Job Copilot works with a Google account. Errors stay per owner. */
    async triageMailForAllOwners(onError?: (owner: string, error: unknown) => void): Promise<number> {
      let owners = 0;
      for (const owner of await repository.listGoogleProfileOwners()) {
        try {
          await this.triageMail(owner);
          owners += 1;
        } catch (error) {
          onError?.(owner, error);
        }
      }
      return owners;
    },
    /** Polls the mailbox for a code until `timeoutMs`; the agent only ever receives the code. */
    async waitForCode(owner: string, input: { fromContains?: string | null; subjectContains?: string | null; pattern: string; since?: string | null; timeoutMs: number; pollMs?: number }) {
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, "i");
      } catch {
        throw new SpaceConflictError("pattern must be a valid regular expression.");
      }
      const deadline = Date.now() + Math.min(input.timeoutMs, 180_000);
      const pollMs = Math.max(2_000, input.pollMs ?? 8_000);
      for (;;) {
        const messages = await readMailboxes(owner, (reader) => reader.texts({ fromContains: input.fromContains, subjectContains: input.subjectContains, since: input.since, limit: 10 }), 30);
        for (const message of messages) {
          const code = extractCode(message.text, regex);
          if (code) return { code, from: message.from, subject: message.subject, receivedAt: message.receivedAt, account: message.account };
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      }
    },
    async findLink(owner: string, input: { fromContains?: string | null; subjectContains?: string | null; urlContains?: string | null; since?: string | null; timeoutMs: number; pollMs?: number }) {
      const deadline = Date.now() + Math.min(input.timeoutMs, 180_000);
      const pollMs = Math.max(2_000, input.pollMs ?? 8_000);
      for (;;) {
        const messages = await readMailboxes(owner, (reader) => reader.texts({ fromContains: input.fromContains, subjectContains: input.subjectContains, since: input.since, limit: 10 }), 30);
        for (const message of messages) {
          const [link] = extractLinksFromText(message.text, input.urlContains);
          if (link) return { link, from: message.from, subject: message.subject, receivedAt: message.receivedAt, account: message.account };
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      }
    },
    async recentMail(owner: string, input: { fromContains?: string | null; subjectContains?: string | null; since?: string | null; limit: number }) {
      const limit = Math.min(input.limit, 20);
      return readMailboxes(owner, (reader) => reader.recent({ ...input, limit }), limit);
    },
    async listApplications(owner: string, filter: { status?: JobApplicationStatus; limit: number }): Promise<JobApplication[]> {
      return (await repository.listApplications(owner, filter)).map(toApplication);
    },
    /**
     * "Reset and start over": counting starts again now. Nothing is deleted: open runs stop, queued and in-progress
     * postings close as FAILED with a note (they can be queued again), and earlier applications become archived history
     * that still guards against applying twice. The compare-and-set comes first, so a repeated click changes nothing.
     */
    async resetCampaign(owner: string, input: { expectedCampaignStartedAt: string | null }, context: JobApplyEventContext = {}): Promise<JobApplyResetResult> {
      const campaignStartedAt = await repository.resetCampaign(owner, input.expectedCampaignStartedAt);
      if (!campaignStartedAt) throw new SpaceConflictError("Job Copilot was already reset meanwhile; reload it and check before resetting again.");
      let runsStopped = 0;
      for (const run of await repository.listActiveRuns(owner)) {
        await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now(), currentApplicationId: null });
        await record(owner, { paneId: run.paneId, runId: run.id, type: "RUN_STOPPED", message: `Run stopped by reset: ${summarizeCounters(run.counters)}`, payload: { counters: run.counters, reset: true } });
        runsStopped += 1;
      }
      const closedNote = `Closed by reset on ${campaignStartedAt.slice(0, 10)}`;
      let closed = 0;
      for (const status of ["NEEDS_USER", "FILLING", "QUEUED"] as const) {
        for (const row of await repository.listApplications(owner, { status, limit: 2000 })) {
          await this.updateApplication(owner, row.id, { status: "FAILED", notes: (row.notes ? `${row.notes} | ${closedNote}` : closedNote).slice(0, 4000) }, context);
          closed += 1;
        }
      }
      await record(owner, { ...context, type: "NOTE", message: `Started over: counting from ${campaignStartedAt.slice(0, 10)}; ${closed} open posting${closed === 1 ? "" : "s"} closed, ${runsStopped} run${runsStopped === 1 ? "" : "s"} stopped. Nothing was deleted.`,
        payload: { campaignStartedAt, closed, runsStopped } });
      return { campaignStartedAt, closed, runsStopped };
    },
    /** Totals since the first day, per-day history in the operator's zone, and the earlier history kept apart. */
    async stats(owner: string, tz: string): Promise<JobApplyStats> {
      const campaignStartedAt = (await repository.getProfile(owner))?.campaignStartedAt ?? null;
      let rows: Awaited<ReturnType<JobApplyRepository["applicationStats"]>>;
      try {
        rows = await repository.applicationStats(owner, { tz, since: campaignStartedAt, importedUrlPrefix: JOB_APPLY_IMPORTED_URL_PREFIX });
      } catch (error) {
        // Postgres names its zones after the same tz database, but a version skew can reject a zone Intl accepts.
        if ((error as { code?: string }).code === "22023") throw new SpaceConflictError(`The time zone ${tz} is not known to the database.`);
        throw error;
      }
      const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const totals = { applied: 0, verified: 0, failed: 0, needsUser: 0 };
      const days = new Map<string, { day: string; applied: number; verified: number; failed: number }>();
      const earlier = { imported: { sent: 0, failed: 0 }, archived: { sent: 0, failed: 0 } };
      for (const row of rows) {
        const sent = row.status === "SUBMITTED" || row.status === "VERIFIED";
        if (row.scope !== "CURRENT") {
          const bucket = row.scope === "IMPORTED" ? earlier.imported : earlier.archived;
          if (sent) bucket.sent += row.count;
          if (row.status === "FAILED") bucket.failed += row.count;
          continue;
        }
        if (row.status === "NEEDS_USER") totals.needsUser += row.count;
        if (!sent && row.status !== "FAILED") continue;
        const day = days.get(row.day) ?? { day: row.day, applied: 0, verified: 0, failed: 0 };
        days.set(row.day, day);
        for (const target of [day, totals]) {
          if (sent) target.applied += row.count;
          if (row.status === "VERIFIED") target.verified += row.count;
          if (row.status === "FAILED") target.failed += row.count;
        }
      }
      const history = [...days.values()].sort((left, right) => right.day.localeCompare(left.day));
      const today = days.get(dayOf.format(new Date(now())));
      return {
        campaignStartedAt,
        firstDay: campaignStartedAt ? dayOf.format(new Date(campaignStartedAt)) : history.at(-1)?.day ?? null,
        today: { applied: today?.applied ?? 0, verified: today?.verified ?? 0, failed: today?.failed ?? 0 },
        totals,
        days: history,
        earlier
      };
    },
    async getApplication(owner: string, id: string): Promise<JobApplication> {
      const record = await repository.getApplication(owner, id);
      if (!record) throw new SpaceNotFoundError(`Application ${id} was not found.`);
      return toApplication(record);
    },
    /** Same URL twice is the same application: the existing row is returned instead of a duplicate. */
    async createApplication(owner: string, raw: JobApplicationCreate, context: JobApplyEventContext = {}): Promise<{ application: JobApplication; created: boolean }> {
      const input = jobApplicationCreateSchema.parse(raw);
      const existing = await repository.getApplicationByUrl(owner, input.url);
      if (existing) return { application: toApplication(existing), created: false };
      const created = await repository.createApplication({ ownerUserId: owner, paneId: input.paneId ?? null, company: input.company, role: input.role,
        ats: input.ats, url: input.url, status: input.status, notes: input.notes ?? null,
        queuePosition: input.status === "QUEUED" ? await repository.nextQueuePosition(owner) : null });
      if (input.status === "QUEUED") {
        await record(owner, { ...context, paneId: context.paneId ?? input.paneId ?? null, applicationId: created.id, type: "NOTE", message: `Queued ${created.company} · ${created.role}`, payload: { url: created.url, ats: created.ats } });
      }
      return { application: toApplication(created), created: true };
    },
    async updateApplication(owner: string, id: string, raw: JobApplicationUpdate, context: JobApplyEventContext = {}): Promise<JobApplication> {
      const update = jobApplicationUpdateSchema.parse(raw);
      const current = await assertTransition(owner, id, update.status, update);
      if (update.status === "SUBMITTED" && current.status !== "SUBMITTED" && await repository.countFields(owner, id) === 0) {
        throw new SpaceConflictError("SUBMITTED needs the form snapshot: record the filled fields of the final step with space_job_fields_record first.");
      }
      if (update.notBefore && (update.status ?? current.status) !== "QUEUED") {
        throw new SpaceConflictError("notBefore defers a queued posting: send it with status QUEUED.");
      }
      const patch: Parameters<JobApplyRepository["updateApplication"]>[2] = { ...update };
      // A deferral belongs to the queue: taking, sending or failing the posting clears it.
      if (update.status && update.status !== "QUEUED" && current.notBefore) patch.notBefore = null;
      // Stamped when the posting is sent, not again when the send is verified later (the day it counts for).
      if (update.status && APPLIED_STATUSES.includes(update.status) && !APPLIED_STATUSES.includes(current.status as JobApplicationStatus)
        && update.appliedAt === undefined) patch.appliedAt = now();
      if (update.status && update.status !== "QUEUED" && current.queuePosition !== null) patch.queuePosition = null;
      if (update.status === "QUEUED" && current.status !== "QUEUED") patch.queuePosition = await repository.nextQueuePosition(owner);
      if (update.status && update.status !== "NEEDS_USER" && update.notes === undefined) {
        const earlier = await notesBeforeParking(owner, current);
        if (earlier !== undefined) patch.notes = earlier;
      }
      const updated = await repository.updateApplication(owner, id, patch);
      if (!updated) throw new SpaceNotFoundError(`Application ${id} was not found.`);
      const changed = update.status && update.status !== current.status ? update.status : null;
      const eventType = changed ? STATUS_EVENT[changed] : null;
      if (changed && eventType) {
        const label = `${updated.company} · ${updated.role}`;
        const message = changed === "FILLING" ? `Filling ${label}`
          : changed === "NEEDS_USER" ? `Needs you: ${update.notes ?? updated.notes ?? label}`
          : changed === "SUBMITTED" ? `Submitted ${label}`
          : changed === "VERIFIED" ? `Verified ${label}${updated.externalConfirmation ? ` (${updated.externalConfirmation})` : ""}`
          : changed === "FAILED" ? `Failed ${label}: ${update.notes ?? updated.notes ?? "no reason recorded"}`
          : updated.notBefore ? `Deferred ${label} until ${updated.notBefore.slice(0, 10)}${updated.notes ? `: ${updated.notes}` : ""}`
          : `Re-queued ${label}`;
        await record(owner, { ...context, paneId: context.paneId ?? updated.paneId ?? null, applicationId: updated.id, type: eventType, message,
          payload: { status: changed, from: current.status }, artifactId: changed === "VERIFIED" ? updated.evidenceArtifactIds[0] ?? null : null });
      }
      return toApplication(updated);
    },
    /** Daily cap and spacing for one site from the pane settings and the tracker; with a company, its employer-limit hold too. */
    async pacing(owner: string, site: JobApplySite, metadata: JobApplyPaneMetadata | null | undefined, company?: string | null) {
      const settings = resolveJobApplyPaneMetadata(metadata).settings;
      const dayStart = new Date(now());
      dayStart.setUTCHours(0, 0, 0, 0);
      const todayCount = await repository.countApplications(owner, site, APPLIED_STATUSES, dayStart.toISOString());
      const latest = (await repository.listApplications(owner, { limit: 50 }))
        .filter((row) => row.ats === site && APPLIED_STATUSES.includes(row.status as JobApplicationStatus))
        .map((row) => row.appliedAt ?? row.updatedAt)
        .sort()
        .at(-1) ?? null;
      const cap = settings.dailyCaps[site];
      const spacingUntil = latest ? new Date(new Date(latest).getTime() + settings.minDelayMs).toISOString() : null;
      const companyHoldUntil = company ? jobApplicationQueueHolds((await repository.listQueue(owner, null)).map(toApplication), now()).holds.get(company.trim().toLowerCase()) ?? null : null;
      const allowed = !settings.paused && todayCount < cap && (!spacingUntil || spacingUntil <= now()) && !companyHoldUntil;
      return { site, allowed, paused: settings.paused, todayCount, dailyCap: cap,
        nextAllowedAt: settings.paused ? null : todayCount >= cap ? "tomorrow" : companyHoldUntil ?? (spacingUntil && spacingUntil > now() ? spacingUntil : null),
        ...(companyHoldUntil ? { companyHoldUntil, reason: `company limit until ${companyHoldUntil.slice(0, 10)}` } : {}),
        minDelayMs: settings.minDelayMs, maxDelayMs: settings.maxDelayMs, submitMode: settings.submitMode };
    },
    // ---- queue ------------------------------------------------------------
    async listQueue(owner: string, paneId: string | null): Promise<JobApplication[]> {
      return (await repository.listQueue(owner, paneId)).map(toApplication);
    },
    /** Pasted posting URLs become QUEUED rows; unknown or duplicate URLs are reported, never silently dropped. */
    async addToQueue(owner: string, paneId: string | null, urls: string[], context: JobApplyEventContext = {}) {
      const queued: JobApplication[] = [];
      let existing = 0;
      const rejected: string[] = [];
      for (const raw of urls) {
        const posting = jobPostingFromUrl(raw);
        if (!posting) { rejected.push(raw.slice(0, 200)); continue; }
        const result = await this.createApplication(owner, { ...posting, paneId, status: "QUEUED" }, context);
        if (result.created) queued.push(result.application); else existing += 1;
      }
      return { queued, existing, rejected };
    },
    async reorderQueue(owner: string, applicationIds: string[]): Promise<JobApplication[]> {
      await repository.setQueueOrder(owner, applicationIds);
      return (await repository.listQueue(owner, null)).map(toApplication);
    },
    async removeFromQueue(owner: string, id: string): Promise<void> {
      const existing = await repository.getApplication(owner, id);
      if (!existing) throw new SpaceNotFoundError(`Application ${id} was not found.`);
      if (existing.status !== "QUEUED") throw new SpaceConflictError("Only queued applications can be removed; others are history.");
      await repository.deleteQueuedApplication(owner, id);
    },

    // ---- memory -----------------------------------------------------------
    async listMemory(owner: string, raw: JobApplyMemoryQuery): Promise<JobApplyMemory[]> {
      await ensureQaBankMigrated(owner);
      const query = jobApplyMemoryQuerySchema.parse(raw);
      return (await repository.listMemory(owner, { query: query.query ?? null, site: query.site ?? null, company: query.company ?? null,
        kinds: query.kinds, keys: query.keys?.map(normalizeJobApplyKey).filter(Boolean), pinnedOnly: query.pinnedOnly, limit: query.limit })).map(toMemory);
    },
    /** A recall counts as a use: recalled memories rank higher next time and show "used" in the rail. */
    async recallMemory(owner: string, raw: JobApplyMemoryQuery): Promise<JobApplyMemory[]> {
      const memories = await this.listMemory(owner, raw);
      await repository.touchMemory(owner, memories.map((memory) => memory.id), now());
      return memories;
    },
    async memoryCount(owner: string): Promise<number> {
      await ensureQaBankMigrated(owner);
      return repository.countMemory(owner);
    },
    /** Keyed memories (answers) refresh the existing row for the same key and scope; free facts are new rows. */
    async rememberMemory(owner: string, raw: JobApplyMemoryCreate): Promise<JobApplyMemory> {
      await ensureQaBankMigrated(owner);
      const input = jobApplyMemoryCreateSchema.parse(raw);
      const base = { ownerUserId: owner, kind: input.kind, text: input.text, site: input.site ?? null, company: input.company ?? null, tags: input.tags ?? [],
        source: input.source ?? "AGENT", confidence: input.confidence ?? (input.source === "USER" || input.source === "PROFILE" ? 0.95 : 0.8), pinned: input.pinned ?? false };
      const key = input.key ? normalizeJobApplyKey(input.key) : input.kind === "ANSWER" ? null : null;
      if (input.kind === "ANSWER" && !key) throw new SpaceConflictError("ANSWER memories need the question as key.");
      return toMemory(key ? await repository.upsertMemoryByKey({ ...base, key }) : await repository.createMemory({ ...base, key: null }));
    },
    async updateMemory(owner: string, id: string, raw: JobApplyMemoryUpdate): Promise<JobApplyMemory> {
      const patch = jobApplyMemoryUpdateSchema.parse(raw);
      const updated = await repository.updateMemory(owner, id, { ...patch, ...(patch.key !== undefined ? { key: patch.key ? normalizeJobApplyKey(patch.key) : null } : {}) });
      if (!updated) throw new SpaceNotFoundError(`Memory ${id} was not found.`);
      return toMemory(updated);
    },
    async forgetMemory(owner: string, id: string): Promise<void> {
      if (!await repository.deleteMemory(owner, id)) throw new SpaceNotFoundError(`Memory ${id} was not found.`);
    },
    /**
     * Answer-bank lookup for one form question: full-text search finds candidates, and only a candidate about the same
     * question (matchAnswerMemory) answers it. The top search hit alone is never an answer: it once answered
     * "German proficiency" with the saved answer to "pronouns".
     */
    async answerFor(owner: string, question: string, scope: { site?: JobApplySite | null; company?: string | null } = {}): Promise<JobApplyMemory | null> {
      const key = normalizeJobApplyKey(question);
      if (!key) return null;
      // The normalized key (300 characters) is the search text too: a question may be longer than the recall query allows.
      const candidates = await this.listMemory(owner, { kinds: ["ANSWER"], keys: [key], query: key, site: scope.site ?? undefined, company: scope.company ?? undefined, limit: 20 });
      const match = matchAnswerMemory(candidates, question);
      if (match) await repository.touchMemory(owner, [match.id], now());
      return match;
    },

    // ---- fields -----------------------------------------------------------
    async listFields(owner: string, applicationId: string): Promise<JobApplicationField[]> {
      return (await repository.listFields(owner, applicationId)).map(toField);
    },
    /** Idempotent per step+label. Non-personal answers also refresh the answer bank for the next form. */
    async recordFields(owner: string, applicationId: string, fields: JobApplicationFieldInput[], context: JobApplyEventContext = {}): Promise<JobApplicationField[]> {
      const application = await repository.getApplication(owner, applicationId);
      if (!application) throw new SpaceNotFoundError(`Application ${applicationId} was not found.`);
      const filledAt = now();
      const records = await repository.upsertFields(owner, applicationId, fields.map((field) => ({
        stepIndex: field.stepIndex, stepTitle: field.stepTitle ?? null, label: field.label, fieldType: field.fieldType, refHint: field.refHint ?? null,
        value: field.fieldType === "file" ? (field.value ?? null)?.split("/").pop() ?? null : field.value ?? null, source: field.source, verifiedAt: field.verified ? filledAt : null
      })), filledAt);
      for (const field of fields) await rememberAnswerFromField(owner, application, field);
      const steps = [...new Set(fields.map((field) => field.stepTitle ?? `step ${field.stepIndex + 1}`))];
      const uploads = fields.filter((field) => field.fieldType === "file" && field.value);
      await record(owner, { ...context, paneId: context.paneId ?? application.paneId ?? null, applicationId, type: uploads.length === fields.length ? "UPLOAD" : "FIELD_FILLED",
        message: uploads.length === fields.length ? `Uploaded ${uploads.map((field) => field.value?.split("/").pop()).join(", ")}` : `Filled ${fields.length} field${fields.length === 1 ? "" : "s"} on ${steps.join(", ")}`,
        payload: { count: fields.length, steps, labels: fields.map((field) => field.label).slice(0, 50) } });
      return records.map(toField);
    },
    /** An operator edit is the truth: the field becomes USER-sourced and the answer bank learns it. */
    async editField(owner: string, id: string, value: string | null): Promise<JobApplicationField> {
      const updated = await repository.updateField(owner, id, { value, source: "USER" });
      if (!updated) throw new SpaceNotFoundError(`Field ${id} was not found.`);
      const application = await repository.getApplication(owner, updated.applicationId);
      if (application) await rememberAnswerFromField(owner, application, { stepIndex: updated.stepIndex, label: updated.label, fieldType: updated.fieldType as JobApplicationFieldInput["fieldType"], value, source: "USER" });
      return toField(updated);
    },

    // ---- events -----------------------------------------------------------
    async logEvent(owner: string, input: JobApplyEventInput & JobApplyEventContext): Promise<JobApplyEvent> {
      if (input.applicationId && !await repository.getApplication(owner, input.applicationId)) throw new SpaceNotFoundError(`Application ${input.applicationId} was not found.`);
      return record(owner, { ...input, type: input.type });
    },
    async listEvents(owner: string, filter: { applicationId?: string; runId?: string; paneId?: string; since?: string; limit: number }): Promise<JobApplyEvent[]> {
      return (await repository.listEvents(owner, filter)).map(toEvent);
    },

    // ---- run supervisor -----------------------------------------------------
    /** Questions and reviews the operator has not answered yet, newest first. */
    async pendingItems(owner: string, paneId: string | null): Promise<JobApplyPendingItem[]> {
      // Only question/review events: a busy pane logs hundreds of other events an hour, which pushed open questions out of the window.
      const events = await repository.listEvents(owner, { ...(paneId ? { paneId } : {}), types: ["QUESTION", "REVIEW_REQUESTED"], limit: 1000 });
      // Answers from every pane: before 2026-10-16 an answer was filed under the posting's pane, not always the pane that asked.
      const oldest = events.at(-1)?.createdAt;
      const settled = oldest ? await repository.listEvents(owner, { types: ["ANSWERED", "REVIEW_DECIDED"], since: new Date(Date.parse(oldest) - 1).toISOString(), limit: 1000 }) : [];
      const answered = new Set<string>();
      for (const event of settled) {
        if ((event.type === "ANSWERED" && typeof event.payload.questionId === "string") || (event.type === "REVIEW_DECIDED" && typeof event.payload.reviewId === "string")) {
          answered.add(String(event.payload.questionId ?? event.payload.reviewId));
        }
      }
      const items = events.flatMap((event) => {
        const id = event.type === "QUESTION" ? event.payload.questionId : event.type === "REVIEW_REQUESTED" ? event.payload.reviewId : null;
        if (typeof id !== "string" || answered.has(id)) return [];
        return [{ kind: event.type === "QUESTION" ? "QUESTION" as const : "REVIEW" as const, id, applicationId: event.applicationId, message: event.message, payload: event.payload, createdAt: event.createdAt }];
      });
      // A posting already sent or closed (for one, by a reset) has nothing left to answer for.
      const closed = new Set<string>();
      for (const applicationId of new Set(items.flatMap((item) => item.applicationId ? [item.applicationId] : []))) {
        const status = (await repository.getApplication(owner, applicationId))?.status;
        if (status === "SUBMITTED" || status === "VERIFIED" || status === "FAILED") closed.add(applicationId);
      }
      return items.filter((item) => !item.applicationId || !closed.has(item.applicationId));
    },
    async runView(owner: string, paneId: string): Promise<JobApplyRunView> {
      const active = await repository.getActiveRun(paneId);
      const run = active && active.ownerUserId === owner ? toRun(active) : null;
      const [queue, current, pending] = await Promise.all([
        this.listQueue(owner, paneId),
        run?.currentApplicationId ? repository.getApplication(owner, run.currentApplicationId) : Promise.resolve(null),
        this.pendingItems(owner, paneId)
      ]);
      return { run, status: run?.status ?? "IDLE", queue, current: current ? toApplication(current) : null, pending };
    },
    /** Start or resume the pane's run. `kickoff` is true when the agent is not polling space_job_next and needs the prompt. */
    async startRun(owner: string, paneId: string): Promise<{ run: JobApplyRun; kickoff: boolean; resumed: boolean }> {
      const active = await repository.getActiveRun(paneId);
      if (active && active.ownerUserId !== owner) throw new SpaceConflictError("Another owner's run is active in this pane.");
      const polling = (nextJobWaiters.get(paneId) ?? 0) > 0;
      if (active?.status === "RUNNING") return { run: toRun(active), kickoff: !polling, resumed: false };
      if (active?.status === "PAUSED") {
        const resumed = await repository.updateRun(owner, active.id, { status: "RUNNING", pausedAt: null, lastActivityAt: now() });
        await record(owner, { paneId, runId: active.id, type: "RUN_RESUMED", message: "Run resumed", payload: { counters: active.counters } });
        return { run: toRun(resumed!), kickoff: !polling, resumed: true };
      }
      const queue = await repository.listQueue(owner, paneId);
      if (queue.length === 0) throw new SpaceConflictError("Queue a posting before starting the copilot.");
      const { eligible, holds } = jobApplicationQueueHolds(queue.map(toApplication), now());
      if (eligible.length === 0) throw new SpaceConflictError(`Every queued posting waits for an employer limit; the next one is free on ${[...holds.values()].sort()[0]!.slice(0, 10)}.`);
      const run = await repository.createRun({ ownerUserId: owner, paneId, status: "RUNNING" });
      await record(owner, { paneId, runId: run.id, type: "RUN_STARTED", message: `Run started: ${eligible.length} queued`, payload: { queued: eligible.length } });
      return { run: toRun(run), kickoff: true, resumed: false };
    },
    async markKickoff(owner: string, runId: string): Promise<void> {
      await repository.updateRun(owner, runId, { kickoffSentAt: now() });
    },
    async pauseRun(owner: string, paneId: string): Promise<JobApplyRun> {
      const active = await repository.getActiveRun(paneId);
      if (!active || active.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      if (active.status === "PAUSED") return toRun(active);
      const paused = await repository.updateRun(owner, active.id, { status: "PAUSED", pausedAt: now(), lastActivityAt: now() });
      await record(owner, { paneId, runId: active.id, type: "RUN_PAUSED", message: "Run paused: the copilot finishes the current application and waits", payload: { counters: active.counters } });
      return toRun(paused!);
    },
    async stopRun(owner: string, paneId: string): Promise<JobApplyRun> {
      const active = await repository.getActiveRun(paneId);
      if (!active || active.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      const stopped = await repository.updateRun(owner, active.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now(), currentApplicationId: null });
      await record(owner, { paneId, runId: active.id, type: "RUN_STOPPED", message: `Run stopped: ${summarizeCounters(active.counters)}`, payload: { counters: active.counters } });
      return toRun(stopped!);
    },
    /**
     * The agent's loop: waits (up to `waitMs`) until the run is RUNNING, the queue has a posting and
     * pacing allows its site, then takes it (FILLING) and returns the task packet. `done` ends the loop.
     */
    async nextJob(owner: string, paneId: string, input: { waitMs: number; metadata: JobApplyPaneMetadata | null | undefined }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_JOB_MAX_WAIT_MS);
      nextJobWaiters.set(paneId, (nextJobWaiters.get(paneId) ?? 0) + 1);
      try {
        for (;;) {
          const run = await repository.getActiveRun(paneId);
          if (!run || run.ownerUserId !== owner) return { done: true as const, reason: "NO_RUN" as const, application: null };
          let waitReason: "PAUSED" | "PACING" | "SETTINGS_PAUSED" = "PAUSED";
          let nextAllowedAt: string | null = null;
          if (run.status === "RUNNING") {
            const all = await repository.listQueue(owner, paneId);
            // Deferred postings (an employer limit) and the rest of their company wait for their date.
            const { eligible, holds } = jobApplicationQueueHolds(all.map(toApplication), now());
            const queue = all.filter((row) => eligible.some((entry) => entry.id === row.id));
            if (queue.length === 0) {
              const nextDeferredAt = [...holds.values()].sort()[0] ?? null;
              const finished = await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now(), currentApplicationId: null });
              const deferred = all.length > 0 && nextDeferredAt ? `; ${all.length} deferred, the next on ${nextDeferredAt.slice(0, 10)}` : "";
              await record(owner, { paneId, runId: run.id, type: "RUN_FINISHED", message: `Run finished: ${summarizeCounters(run.counters)}${deferred}`, payload: { counters: run.counters, deferred: all.length, nextDeferredAt } });
              return all.length > 0
                ? { done: true as const, reason: "QUEUE_DEFERRED" as const, nextDeferredAt, application: null, run: toRun(finished!) }
                : { done: true as const, reason: "QUEUE_EMPTY" as const, application: null, run: toRun(finished!) };
            }
            const settings = resolveJobApplyPaneMetadata(input.metadata).settings;
            if (settings.paused) {
              waitReason = "SETTINGS_PAUSED";
            } else {
              const checked = new Map<JobApplySite, Awaited<ReturnType<typeof this.pacing>>>();
              let picked: JobApplicationRecord | null = null;
              for (const candidate of queue) {
                const site = candidate.ats as JobApplySite;
                const pacing = checked.get(site) ?? await this.pacing(owner, site, input.metadata);
                checked.set(site, pacing);
                if (pacing.allowed) { picked = candidate; break; }
                if (pacing.nextAllowedAt && pacing.nextAllowedAt !== "tomorrow" && (!nextAllowedAt || pacing.nextAllowedAt < nextAllowedAt)) nextAllowedAt = pacing.nextAllowedAt;
              }
              if (picked) {
                const counters = { ...run.counters, taken: (run.counters.taken ?? 0) + 1 };
                await repository.updateRun(owner, run.id, { currentApplicationId: picked.id, counters, lastActivityAt: now() });
                const application = await this.updateApplication(owner, picked.id, { status: "FILLING" }, { paneId, runId: run.id });
                return { done: false as const, ...(await this.taskPacket(owner, application, settings, { ...run, counters }, queue.length - 1)) };
              }
              waitReason = "PACING";
            }
          }
          if (Date.now() >= deadline) return { done: false as const, waiting: true as const, reason: waitReason, nextAllowedAt, application: null, run: toRun(run) };
          await sleep(Math.min(NEXT_JOB_POLL_MS, Math.max(0, deadline - Date.now())));
        }
      } finally {
        const remaining = (nextJobWaiters.get(paneId) ?? 1) - 1;
        if (remaining > 0) nextJobWaiters.set(paneId, remaining); else nextJobWaiters.delete(paneId);
      }
    },
    /** Everything the agent needs for one posting: profile facts, CV path, scoped memories and the answer bank. */
    async taskPacket(owner: string, application: JobApplication, settings: JobApplyPaneMetadata["settings"], run: JobApplyRunRecord, remaining: number) {
      const [profile, cv, memories, answers] = await Promise.all([
        this.getProfile(owner), this.cvText(owner),
        this.listMemory(owner, { site: application.ats, company: application.company, limit: 20 }),
        this.listMemory(owner, { kinds: ["ANSWER"], site: application.ats, company: application.company, limit: 40 })
      ]);
      await repository.touchMemory(owner, [...new Set([...memories, ...answers].map((memory) => memory.id))], now());
      const coverLetterPath = profile.coverLetterArtifactId ? await this.artifactPath(profile.coverLetterArtifactId) : null;
      const { experience, education, extra, ...facts } = profile.candidate;
      return {
        application,
        run: { id: run.id, counters: run.counters as JobApplyRunCounters, remaining },
        settings: { submitMode: settings.submitMode, minDelayMs: settings.minDelayMs, maxDelayMs: settings.maxDelayMs, dailyCap: settings.dailyCaps[application.ats as JobApplySite] },
        candidate: { ...facts, experience: experience.slice(0, 10), education: education.slice(0, 6), extra },
        cv: { artifactId: cv.artifactId, path: cv.path, chars: cv.text?.length ?? 0 },
        coverLetter: { artifactId: profile.coverLetterArtifactId, path: coverLetterPath },
        mailboxConnected: jobApplyMailboxConnected(profile),
        google: profile.google,
        googleAccounts: profile.googleAccounts,
        memories: memories.filter((memory) => memory.kind !== "ANSWER"),
        answers: answers.map((memory) => ({ id: memory.id, question: memory.key, answer: memory.text, source: memory.source, confidence: memory.confidence, site: memory.site }))
      };
    },
    /** Closes one job: the outcome must match the tracker row the agent already updated. */
    async reportJob(owner: string, paneId: string, input: { runId?: string; applicationId: string; outcome: JobApplyReportOutcome; summary: string }) {
      const run = input.runId ? await repository.getRun(owner, input.runId) : await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceNotFoundError("The run was not found.");
      const application = await repository.getApplication(owner, input.applicationId);
      if (!application) throw new SpaceNotFoundError(`Application ${input.applicationId} was not found.`);
      const expected: Record<JobApplyReportOutcome, JobApplicationStatus[]> = {
        submitted: ["SUBMITTED", "VERIFIED"], verified: ["VERIFIED"], failed: ["FAILED"], needs_user: ["NEEDS_USER"], skipped: ["FAILED", "QUEUED"]
      };
      if (!expected[input.outcome].includes(application.status as JobApplicationStatus)) {
        throw new SpaceConflictError(`Outcome ${input.outcome} does not match the tracker (${application.status}); call space_job_application_update first.`);
      }
      const counters: JobApplyRunCounters = { taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0, ...run.counters };
      if (input.outcome === "verified") { counters.verified += 1; counters.submitted += 1; }
      else if (input.outcome === "submitted") counters.submitted += 1;
      else if (input.outcome === "failed") counters.failed += 1;
      else if (input.outcome === "needs_user") counters.needsUser += 1;
      const updated = await repository.updateRun(owner, run.id, { counters, currentApplicationId: run.currentApplicationId === application.id ? null : run.currentApplicationId, lastActivityAt: now() });
      await record(owner, { paneId, runId: run.id, applicationId: application.id, type: "NOTE", message: `Reported ${input.outcome.replace("_", " ")}: ${input.summary}`, payload: { outcome: input.outcome } });
      const remaining = (await repository.listQueue(owner, paneId)).length;
      return { run: toRun(updated!), remaining, status: updated!.status };
    },

    // ---- questions and reviews ----------------------------------------------
    async askQuestion(owner: string, applicationId: string, input: { question: string; options?: string[]; label?: string }, context: JobApplyEventContext = {}) {
      const application = await repository.getApplication(owner, applicationId);
      if (!application) throw new SpaceNotFoundError(`Application ${applicationId} was not found.`);
      const known = await this.answerFor(owner, input.question, { site: application.ats as JobApplySite, company: application.company });
      if (known) {
        // Answers from memory leave a trace, so a wrong match can be found afterwards.
        await record(owner, { ...context, paneId: context.paneId ?? application.paneId ?? null, applicationId, type: "NOTE",
          message: `Answered from memory: ${input.question.slice(0, 200)}`,
          payload: { autoAnswered: true, question: input.question.slice(0, 1000), memoryId: known.id, memoryKey: known.key, answer: known.text.slice(0, 500) } });
        return { questionId: null, answered: true as const, answer: known.text, source: known.source, memoryId: known.id };
      }
      const questionId = `jobq:${randomBytes(9).toString("base64url")}`;
      const parks = application.status === "FILLING" || application.status === "QUEUED";
      if (parks) await repository.updateApplication(owner, applicationId, { status: "NEEDS_USER", notes: input.question.slice(0, 4000), queuePosition: null });
      await record(owner, { ...context, paneId: context.paneId ?? application.paneId ?? null, applicationId, type: "QUESTION", message: `Needs you: ${input.question}`,
        payload: { questionId, question: input.question, options: input.options ?? [], label: input.label ?? null, ...(parks ? { previousNotes: application.notes } : {}) } });
      return { questionId, answered: false as const };
    },
    async answerQuestion(owner: string, applicationId: string, input: { questionId: string; answer: string }, context: JobApplyEventContext = {}) {
      const events = await repository.listEvents(owner, { applicationId, types: ["QUESTION"], limit: 200 });
      const question = events.find((event) => event.type === "QUESTION" && event.payload.questionId === input.questionId);
      if (!question) throw new SpaceNotFoundError("The question was not found.");
      // A question may run to 1000 characters; the memory key is the normalized question, which keeps 300 (as answerFor looks it up).
      const memory = await this.rememberMemory(owner, { kind: "ANSWER", key: normalizeJobApplyKey(String(question.payload.question)), text: input.answer, source: "USER", tags: ["question"] });
      const application = await repository.getApplication(owner, applicationId);
      // The copilot gives up waiting after a while and moves on: a later answer sends the posting back to the queue.
      if (application?.status === "NEEDS_USER" && !await copilotOn(owner, applicationId, question.paneId ?? application.paneId)) {
        await this.updateApplication(owner, applicationId, { status: "QUEUED" }, context);
      } else if (application?.status === "NEEDS_USER") {
        const earlier = await notesBeforeParking(owner, application);
        await repository.updateApplication(owner, applicationId, { status: "FILLING", ...(earlier !== undefined ? { notes: earlier } : {}) });
      }
      await record(owner, { ...context, paneId: context.paneId ?? question.paneId ?? application?.paneId ?? null, applicationId, type: "ANSWERED", message: `You answered: ${input.answer.slice(0, 200)}`,
        payload: { questionId: input.questionId, answer: input.answer, memoryId: memory.id } });
      return { memory };
    },
    async waitForAnswer(owner: string, applicationId: string, input: { questionId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_JOB_MAX_WAIT_MS);
      for (;;) {
        const events = await repository.listEvents(owner, { applicationId, types: ["ANSWERED"], limit: 200 });
        const answered = events.find((event) => event.type === "ANSWERED" && event.payload.questionId === input.questionId);
        if (answered) return { answered: true as const, answer: String(answered.payload.answer ?? ""), answeredAt: answered.createdAt };
        if (Date.now() >= deadline) return { answered: false as const, answer: null };
        await sleep(Math.min(NEXT_JOB_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    async requestReview(owner: string, applicationId: string, input: { fields: Array<{ label: string; value: string | null }>; note?: string }, context: JobApplyEventContext = {}) {
      const application = await repository.getApplication(owner, applicationId);
      if (!application) throw new SpaceNotFoundError(`Application ${applicationId} was not found.`);
      const reviewId = `jobrev:${randomBytes(9).toString("base64url")}`;
      const parks = application.status === "FILLING";
      if (parks) await repository.updateApplication(owner, applicationId, { status: "NEEDS_USER", notes: REVIEW_NOTE });
      await record(owner, { ...context, paneId: context.paneId ?? application.paneId ?? null, applicationId, type: "REVIEW_REQUESTED",
        message: `Review before submit: ${application.company} · ${application.role}${input.note ? ` (${input.note})` : ""}`,
        payload: { reviewId, fields: input.fields.slice(0, 200), note: input.note ?? null, ...(parks ? { previousNotes: application.notes } : {}) } });
      return { reviewId };
    },
    async decideReview(owner: string, applicationId: string, input: JobApplyReviewDecision, context: JobApplyEventContext = {}) {
      const events = await repository.listEvents(owner, { applicationId, types: ["REVIEW_REQUESTED"], limit: 200 });
      const review = events.find((event) => event.type === "REVIEW_REQUESTED" && event.payload.reviewId === input.reviewId);
      if (!review) throw new SpaceNotFoundError("The review was not found.");
      const application = await repository.getApplication(owner, applicationId);
      // As with answers: with no copilot on the posting, it goes back to the queue, or fails when the operator rejected it.
      if (application?.status === "NEEDS_USER" && !await copilotOn(owner, applicationId, review.paneId ?? application.paneId)) {
        await this.updateApplication(owner, applicationId, input.decision === "reject"
          ? { status: "FAILED", notes: `You rejected the submission${input.note ? `: ${input.note}` : ""}` } : { status: "QUEUED" }, context);
      } else if (application?.status === "NEEDS_USER") {
        const earlier = await notesBeforeParking(owner, application);
        await repository.updateApplication(owner, applicationId, { status: "FILLING", ...(earlier !== undefined ? { notes: earlier } : {}) });
      }
      for (const edit of input.edits ?? []) {
        if (edit.value) await rememberAnswerFromField(owner, application!, { stepIndex: 0, label: edit.label, fieldType: "text", value: edit.value, source: "USER" });
      }
      await record(owner, { ...context, paneId: context.paneId ?? review.paneId ?? application?.paneId ?? null, applicationId, type: "REVIEW_DECIDED",
        message: input.decision === "approve" ? "You approved the submission" : input.decision === "edit" ? `You corrected ${input.edits?.length ?? 0} field(s)` : `You rejected the submission${input.note ? `: ${input.note}` : ""}`,
        payload: { reviewId: input.reviewId, decision: input.decision, edits: input.edits ?? [], note: input.note ?? null } });
      return { decision: input.decision };
    },
    async waitForReview(owner: string, applicationId: string, input: { reviewId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_JOB_MAX_WAIT_MS);
      for (;;) {
        const events = await repository.listEvents(owner, { applicationId, types: ["REVIEW_DECIDED"], limit: 200 });
        const decided = events.find((event) => event.type === "REVIEW_DECIDED" && event.payload.reviewId === input.reviewId);
        if (decided) return { decided: true as const, decision: String(decided.payload.decision), edits: Array.isArray(decided.payload.edits) ? decided.payload.edits : [], note: decided.payload.note ?? null };
        if (Date.now() >= deadline) return { decided: false as const, decision: null, edits: [], note: null };
        await sleep(Math.min(NEXT_JOB_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },

    // ---- discovery ----------------------------------------------------------
    /** Scans the requested boards plus every board token remembered as a SITE memory tagged board-token ("<ats>:<token>"). */
    async discover(owner: string, input: JobApplyDiscoverRequest) {
      const remembered = await repository.listMemory(owner, { kinds: ["SITE"], limit: 200 });
      const extra = remembered.flatMap((memory) => {
        if (!memory.tags.includes("board-token")) return [];
        const match = /^(greenhouse|lever|ashby):([a-z0-9][a-z0-9._-]{0,80})$/i.exec(memory.text.trim());
        return match ? [{ ats: match[1]!.toLowerCase() as JobApplyDiscoverySite, token: match[2]! }] : [];
      });
      return discovery.search(input, extra, async (url) => (await repository.getApplicationByUrl(owner, url)) !== null);
    },

    /**
     * Imports the operator's earlier campaign tracker (id,company,board,role,geo,source,status,applied_date,notes,...).
     * What the earlier tracker says is a claim: a sent application becomes SUBMITTED, never VERIFIED (that needs a
     * confirmation page or email); attempts it recorded as not sent become FAILED; rows without a known outcome are skipped.
     */
    async importCsv(owner: string, csv: string, paneId: string | null): Promise<{ imported: number; skipped: number; duplicates: number }> {
      const rows = parseCsv(csv);
      const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
      const column = (name: string) => header.indexOf(name);
      if (column("company") < 0 || column("status") < 0) throw new SpaceConflictError("CSV needs at least company and status columns.");
      let imported = 0, skipped = 0, duplicates = 0;
      for (const row of rows.slice(1)) {
        const cell = (name: string) => { const index = column(name); return index >= 0 ? (row[index] ?? "").trim() : ""; };
        const company = cell("company");
        const id = cell("id");
        const board = cell("board") || cell("source");
        const roleText = cell("role") || "Unknown role";
        if (!company) { skipped += 1; continue; }
        // Earlier campaigns recorded board + job id instead of a URL; this synthetic one is the row's identity on re-import
        // (built exactly as the first import did). The site also looks at shifted columns and the id ("linkedin_…").
        const identitySite = jobApplySiteFromBoard(`${board} ${cell("source")}`, cell("url"));
        const ats = identitySite !== "other" ? identitySite : jobApplySiteFromBoard(`${cell("status")} ${id}`, cell("url"));
        const url = cell("url") || `${JOB_APPLY_IMPORTED_URL_PREFIX}${encodeURIComponent(board || identitySite)}/${encodeURIComponent(id || `${company}-${roleText}`)}`;
        if (await repository.getApplicationByUrl(owner, url)) { duplicates += 1; continue; }
        // Some campaigns shifted columns: the outcome then sits in source, and status holds a board or the date.
        const outcome = [cell("status"), cell("source")].map((value) => value.toLowerCase())
          .find((value) => CSV_SENT_OUTCOMES.has(value) || CSV_QUEUED_OUTCOMES.has(value) || Object.hasOwn(CSV_NOT_SENT_OUTCOMES, value));
        if (!outcome) { skipped += 1; continue; }
        const sent = CSV_SENT_OUTCOMES.has(outcome);
        const mapped: JobApplicationStatus = sent ? "SUBMITTED" : CSV_QUEUED_OUTCOMES.has(outcome) ? "QUEUED" : "FAILED";
        const appliedDate = [cell("applied_date"), cell("status")].find((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)));
        const claim = sent ? (outcome === "verified" || /verified/i.test(cell("notes")) ? "earlier tracker said verified; no confirmation email checked yet" : "earlier tracker said applied")
          : mapped === "FAILED" ? `earlier tracker: ${CSV_NOT_SENT_OUTCOMES[outcome]}` : "";
        const role = cell("role") && !/^Job \d+$/.test(cell("role")) ? cell("role") : JOB_APPLY_UNRECORDED_ROLE;
        const record = await repository.createApplication({ ownerUserId: owner, paneId, company, role: role.slice(0, 300), ats, url: url.slice(0, 2000),
          status: "QUEUED", notes: [cell("notes"), cell("geo") ? `geo: ${cell("geo")}` : "", id ? `imported id: ${id}` : "", claim].filter(Boolean).join(" | ").slice(0, 4000) || null });
        await repository.updateApplication(owner, record.id, { status: mapped,
          appliedAt: appliedDate ? new Date(appliedDate).toISOString() : mapped === "QUEUED" ? null : record.createdAt, externalConfirmation: null });
        imported += 1;
      }
      return { imported, skipped, duplicates };
    }
  };
}
export type JobApplyService = ReturnType<typeof createJobApplyService>;
