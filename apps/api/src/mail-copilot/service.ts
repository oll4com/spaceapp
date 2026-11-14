import { randomBytes } from "node:crypto";
import {
  MAIL_SYSTEM_LABELS, mailRuleMatches, mailSubjectKey, mailSubjectKeyPattern, mailThreadActionLabels, resolveMailCopilotPaneMetadata, type ConnectorCapability, type MailActionRecord, type MailOperatorAction, type MailRule, type MailRuleDecision, type MailRuleProposal, type MailRuleSubject, type MailAccountSummary, type MailComposeInput, type MailCopilotEvent,
  type MailCopilotEventInput, type MailCopilotEventType, type MailCopilotMemory, type MailCopilotMemoryCreate, type MailCopilotMemoryQuery, type MailCopilotMemoryUpdate,
  type MailActionLogEntry, type MailCopilotFixRequest, type MailFixRequestView, type MailCopilotPaneMetadata, type MailCopilotPendingItem, type MailHabitLevel, type MailHabits, type MailHabitSender, type MailCopilotReviewDecision, type MailCopilotRsvpRequest, type MailCopilotRun, type MailCopilotRunView, type MailLabel,
  type MailMessage, type MailThread, type MailThreadAction, type MailThreadLabel, type MailThreadLabels, type MailThreadSummary, type MailThreadsPage, type MailThreadsQuery, type Pane
} from "@space/contracts";
import type { MailCopilotRepository } from "@space/db";
import type { RailAnswerBy } from "@space/db";
import { forbiddenByMemoryText, forbiddingMemory, MEMORY_HITS_NOTE, questionMemoryHits, reviewRequiringMemories } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { GmailMailboxError } from "../job-apply/gmail-mailbox.js";
import { asksAboutAssessment, asksForAction, asksToSchedule } from "../job-apply/mail-triage.js";
import { operatorOrder, operatorOrderOverride, type OperatorMessageRefs } from "../copilot-operator-order.js";
import { exclusiveJobLabels, jobLabelIdsOf } from "../job-apply/gmail-organize.js";
import { createGmailClient, mapLimited, type GmailClient, type GmailJson } from "./gmail-client.js";
import { classifyThreadChange, jobLabelChange, netThreadChanges, type GmailHistoryEntry } from "./history.js";
import type { MailCopilotKickoff } from "./kickoff.js";
import { buildMime, header, parseParticipants, parsePayload, type MimeAttachment } from "./gmail-mime.js";
import { sanitizeMailHtml } from "./html-sanitizer.js";
import { decodeEntities } from "../job-apply/gmail-mailbox.js";
import { linksMissingFromText } from "../mail-html-text.js";
import { mailCopilotNoticeKey } from "./notify.js";
import { RESET_ASK, resetRefusal } from "../signin-readback.js";
import type { SiteSignin } from "@space/contracts";

/** The owner's Google connector: every account allowed for Space and an access token per capability. */
export interface MailCopilotGoogleAccess {
  googleConfigured: boolean;
  googleAccounts(owner: string): Promise<Array<{ email: string; capabilities: ConnectorCapability[] }>>;
  googleAccessToken(owner: string, email: string, capability: ConnectorCapability): Promise<string>;
  /** The connector gateway's tools; the copilot calls only `calendar.respond`, after the operator approved the answer. */
  tool?(owner: string, toolId: string, args: Record<string, unknown>): Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
}
type MailCopilotRsvp = { response: "accepted" | "declined" | "tentative"; eventId?: string; iCalUID?: string; comment?: string };
const RSVP_LABEL = { accepted: "Yes", declined: "No", tentative: "Maybe" } as const;

export interface MailCopilotServiceOptions {
  google(): MailCopilotGoogleAccess | null;
  /** The stored sign-in record of a site (domain): a support mail about the password of a site whose sign-in works is refused (nous_msg:fe72e061). */
  siteSignin?(owner: string, domain: string): Promise<SiteSignin | null>;
  gmailFetch?: typeof fetch;
  /** The copilot's memory, activity feed / work queue and runs. */
  repository: MailCopilotRepository;
  /** Every activity event, for the room stream and notifications. */
  onEvent?(event: MailCopilotEvent): void;
  /** Closes a Space notification by its dedupe key (a NEEDS_USER mail the operator handled no longer needs them). */
  resolveNotice?(owner: string, dedupeKey: string): Promise<unknown>;
  /** Starts a run for new work nobody pressed Start for (a mail sent to the copilot to fix). */
  kickoff?: MailCopilotKickoff;
  /** One line to Nous's inbox; `urgent` reaches it within seconds. */
  notice?(owner: string, key: string, line: string, urgent?: boolean): Promise<unknown> | unknown;
  /** The operator's messages to Nous: a review's operatorOrder is checked against them. */
  operatorMessages?: OperatorMessageRefs;
  now?(): string;
}

export interface MailEventContext { paneId?: string | null; runId?: string | null }
const NEXT_POLL_MS = 2_000;
const NEXT_MAX_WAIT_MS = 120_000;
/** A TAKEN item nobody reported for this long goes back to the queue (a crashed CLI). */
const TAKEN_STALE_MS = 30 * 60_000;
/** A RUNNING run with no activity this long, whose CLI sits at an empty prompt, lost its agent: it gets its kickoff again. */
const RUN_IDLE_MS = 10 * 60_000;
/** A thread with one of these was decided once; SKIPPED is undecided and comes back in the next daily run. */
const DECIDED_TYPES: MailCopilotEventType[] = ["TRIAGED", "REPLIED", "DRAFTED", "ARCHIVED", "TRASHED", "LABELED", "NEEDS_USER", "FIXED"];
/** Senders a copilot never answers on its own. */
/** A delivery failure notice (a mail from mailer-daemon or postmaster). */
const isBounce = (event: MailCopilotEvent) => /^(mailer-daemon|postmaster)@/i.test(String((event.payload.from as { address?: string } | undefined)?.address ?? ""));
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const addressesIn = (value: unknown) => [...new Set(JSON.stringify(value ?? null).toLowerCase().match(ADDRESS) ?? [])];
/** Score (audit 6/11): a mailer-daemon mail bounced our send only when it names one of `sentTo` or no address at all (Hetzner's tco@ was an internal forward). */
const bouncedFor = (events: MailCopilotEvent[], sentTo: string[]) => events.some((event) => {
  if (!isBounce(event)) return false;
  const named = addressesIn(event.payload.snippet).filter((address) => !/^(mailer-daemon|postmaster)@/.test(address));
  return !named.length || named.some((address) => sentTo.includes(address));
});
// shortcut: a short list of shared mail providers, whose domain says nothing about the recipient; add one when a decision's recipient is on another.
const SHARED_MAIL_DOMAIN = /@(gmail|googlemail|yahoo|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|pm|gmx|yandex|zoho|mail)\.[a-z.]+$/;
const AUTOMATED_SENDER = /(^|[.<@-])(no-?reply|do-?not-?reply|noreply|notifications?|newsletter|mailer-daemon|postmaster|bounce)([.>@-]|$)/i;
/**
 * Operator P0 1/11 03:15 BKK: the accountant's mails of 31/10 (a ΓΕΜΗ deadline that day) and the ΓΕΜΗ notice waited 7 hours while the
 * copilot was down and the operator slept. Mail from these senders (no-reply ones too), or non-automated mail naming a deadline, reaches
 * Nous at once, whatever the copilot does. shortcut: a fixed list of government and bank domains; make it a setting when the operator names others.
 */
const IMPORTANT_SENDER_DOMAINS = ["gov.gr", "businessportal.gr", "gsis.gr", "aade.gr", "efka.gr", "nbg.gr", "piraeusbank.gr", "eurobank.gr", "alpha.gr", "alphabank.gr", "optimabank.gr", "revolut.com"];
const DEADLINE_WORDS = /σημερα|προθεσμι|ληγει|ληγουν|ληξη|επειγ|\bdeadline|\btoday\b|\burgent/;
/** Why a new mail is important by itself (its sender's domain, or a deadline in a person's mail), else null. */
export function importantMailSignal(fromAddress: string, text: string, automated: boolean): string | null {
  const domain = fromAddress.split("@")[1]?.toLowerCase() ?? "";
  if (IMPORTANT_SENDER_DOMAINS.some((entry) => domain === entry || domain.endsWith(`.${entry}`))) return `a government or bank sender (${domain})`;
  return !automated && DEADLINE_WORDS.test(text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()) ? "it names a deadline" : null;
}
/**
 * R23-1 (1/11 00:07-00:52 UTC: five "Important mail" lines for Proxmox's "vzdump backup status: backup successful" from info@example.invalid, read as
 * "the operator wrote to"): a host's own system mail (vzdump, cron, package and monitoring notices) is important only when it reports a failure.
 * Returns why it is important (a failure), false for routine system mail, null for any other mail.
 */
const SYSTEM_MAIL = /\bvzdump\b|--notification-mode|^cron\b|\bcron <|new software packages available|\[(?:firing|resolved)\b|\balertmanager\b|\bsmartd\b|\bunattended-upgrades?\b|\blogwatch\b|\bfail2ban\b/i;
const SYSTEM_FAILURE = /\bfail(?:ed|ure|s)?\b|\berrors?\b|\baborted\b|\bcritical\b|\[firing\b|\bdown\b|\bunreachable\b/i;
export function systemMailVerdict(subject: string, snippet: string): string | false | null {
  if (!SYSTEM_MAIL.test(`${subject}\n${snippet}`)) return null;
  return SYSTEM_FAILURE.test(`${subject}\n${snippet}`) ? "system mail reporting a failure" : false;
}
/** R23-1: a memory that marks an address as the operator's own (an alias, a mailbox of theirs), so it is never "a correspondent". */
const OWN_ADDRESS = /\b(?:operator'?s|my|his|own)\s+(?:own\s+)?(?:address|mailbox|alias|account|e-?mail)\b|\balias\b|δικ[όήοηή]\s/i;
/** A copilot that does not move: kicked again after this long with mail waiting; a kick that brought nothing is retried after RUN_IDLE_MS (the kickoff's own resend gap). */
const STALL_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const senderAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const senderDomain = (from: string) => senderAddress(from).split("@").at(-1)?.trim() ?? "";
/** R12-6: promises in a reply that bind the operator outside the mailbox, and the words a memory allowing that act uses. */
const OUTSIDE_ACTS = [
  { act: "a phone call", says: /\b(?:we|i)(?:'ll|\s+will|\s+shall)\s+(?:give\s+you\s+a\s+)?(?:call|phone|ring)\b|\bcall\s+you\s+back\b|θα\s+σας\s+(?:καλέσ|καλεσ|τηλεφων)/iu,
    allows: /\bcall|\bphone|τηλεφ|καλ[έε]σ/iu },
  { act: "a visit", says: /\b(?:we|i)(?:'ll|\s+will|\s+shall)\s+(?:visit|come\s+(?:by|over|to))\b|θα\s+(?:σας\s+)?επισκεφ|θα\s+[έε]ρθουμε/iu, allows: /\bvisit|\bcome\s+by|επισκ|[έε]ρθ/iu },
  { act: "a payment", says: /\b(?:we|i)(?:'ll|\s+will|\s+shall)\s+(?:pay|refund|transfer|reimburse)\b|θα\s+(?:σας\s+)?(?:πληρ[ώω]σ|επιστρ[έε]ψουμε\s+τα\s+χρ[ήη]ματα|καταθ[έε]σ)/iu,
    allows: /\bpay|\brefund|\btransfer|reimburs|πληρ|επιστροφ|επιστρ[έε]ψ|καταθ/iu }];
const NEGATION = /\b(?:never|not|no|don'?t)\b|μην|δεν|ποτ[έε]|όχι/iu;
/** 2/11 (McArthur/WIM): a memory about replies to rejections, receipts or closed roles; it never speaks of a thread that asks to schedule. */
const REJECTION_RULE = /\breject|\bmov(?:e|ing) forward\b|\bthanks? for applying\b|\bconfirm\w* (?:an |the |your )?application|\bkeep you in mind\b|\bfill(?:ed)? (?:a |the )?(?:role|position)|απ[όο]ρριψ/iu;
/** B (2/11): a draft of ours on a thread not sent this long after it was made brings Nous one line; drafts older than DRAFT_WATCH_MS are left. */
const DRAFT_UNSENT_MS = 15 * 60_000;
const DRAFT_WATCH_MS = 48 * 3_600_000;
/** A pane action and the operator action it is in the log. */
const LOGGED_ACTION: Partial<Record<MailThreadAction["action"], MailOperatorAction>> = {
  archive: "ARCHIVE", unarchive: "UNARCHIVE", trash: "TRASH", untrash: "UNTRASH", star: "STAR", unstar: "UNSTAR", label: "LABEL", unlabel: "UNLABEL", move: "MOVE"
};
/** An Undo within this window removes the operator's own action from the log instead of recording the reverse. */
const UNDO_WINDOW_MS = 15 * 60_000;
// No UNLABEL: taking a label off is always recorded, so the thread's label history keeps when it went on and when it came off (operator 3/11).
const UNDOES: Partial<Record<MailOperatorAction, MailOperatorAction>> = { UNARCHIVE: "ARCHIVE", UNTRASH: "TRASH", UNSTAR: "STAR" };
/** The thread actions that change its labels; their answer carries the thread's labels after the change. */
const LABEL_ACTIONS: ReadonlySet<MailThreadAction["action"]> = new Set(["label", "unlabel", "move"]);
/** The user labels (Gmail's Label_ ids, by name) among a thread's label ids. */
export function userLabelsOf(all: ReadonlyArray<{ id: string; name: string; type: string }>, ids: Iterable<string>): MailThreadLabel[] {
  const own = new Set(ids);
  return all.filter((label) => label.type === "user" && own.has(label.id)).map(({ id, name }) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name));
}
/** Labels Gmail names by fixed ids; anything else may be a label's name and is looked up per account. */
const FIXED_LABEL = /^(INBOX|STARRED|IMPORTANT|SENT|DRAFT|SPAM|TRASH|UNREAD|CHAT|CATEGORY_[A-Z]+|Label_\d+)$/;
const headersOf = (message: GmailJson) => (message.payload as { headers?: unknown } | undefined)?.headers;
/** What Gmail's history tells about mailbox changes (new mail, and everything done to mail in any client). */
const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;
/** shortcut: one sync reads at most this much history and continues next tick; raise it if bulk actions lag behind. */
const SYNC_MAX_PAGES = 4;
const SYNC_MAX_THREADS = 300;
/** A change history shows within this window of Space's own write of the same action on the thread is that write. */
const SPACE_WRITE_WINDOW_MS = 15 * 60_000;
/** Job Copilot files mail under these labels; those changes are Space's own. */
const JOB_COPILOT_LABEL_PREFIX = "Job Applications/";
/** The first look at a mailbox: conversations of the last 30 days, 100 per tick, read as inferred habits. */
const BACKFILL_QUERY = "in:anywhere newer_than:30d -in:spam -in:drafts -in:chats -in:sent";
const BACKFILL_THREADS_PER_TICK = 100;
/** How far back habits look. */
const HABIT_WINDOW_MS = 180 * 24 * 3_600_000;
/** Where the operator put a mail: the decisions a share is counted over (a reply, a star or emptying the trash comes on top). */
const DISPOSITIONS: ReadonlySet<MailOperatorAction> = new Set(["ARCHIVE", "TRASH", "MOVE", "LABEL", "SPAM"]);
const HABIT_VERB: Record<MailOperatorAction, string> = {
  ARCHIVE: "archived", UNARCHIVE: "moved back to the inbox", TRASH: "trashed", UNTRASH: "restored from trash", DELETE: "deleted for good", MOVE: "moved to", LABEL: "labeled", UNLABEL: "removed the label",
  STAR: "starred", UNSTAR: "unstarred", SPAM: "reported as spam", NOT_SPAM: "marked not spam", REPLY: "replied to", FORWARD: "forwarded", FIX: "sent to the copilot to fix"
};
/** A rule is learned from at least this many observed operator actions of one kind on one sender, this consistent, in this window. */
const LEARN_MIN_ACTIONS = 3;
const LEARN_MIN_SHARE = 0.9;
const LEARN_WINDOW_MS = 90 * 24 * 3_600_000;
/** shortcut: at most this many learned rules per account and day (a bulk clean-up would otherwise make dozens); raise it if the operator wants faster learning. */
const LEARN_MAX_PER_DAY = 10;
/** What the server may learn a rule for: where mail goes, reversibly; never a reply, a send or a permanent deletion (a star needs no rule). */
const LEARNABLE: Partial<Record<MailOperatorAction, "ARCHIVE" | "MOVE" | "LABEL" | "TRASH" | "FIX">> = { ARCHIVE: "ARCHIVE", MOVE: "MOVE", LABEL: "LABEL", TRASH: "TRASH", FIX: "FIX" };
/** The operator's action that takes a rule's action back: it counts against the rule. */
const REVERSES: Partial<Record<MailOperatorAction, MailOperatorAction[]>> = { UNARCHIVE: ["ARCHIVE", "MOVE"], UNTRASH: ["TRASH"], UNLABEL: ["LABEL", "MOVE"] };
/** The operator's actions that settle a conversation: its waiting triage items close. */
const HANDLES_MAIL: ReadonlySet<MailOperatorAction> = new Set(["ARCHIVE", "TRASH", "DELETE", "MOVE", "SPAM", "REPLY", "FORWARD", "FIX"]);
/** The action log keeps a year. */
const ACTION_RETENTION_MS = 365 * 24 * 3_600_000;

/** The accounts a pane works with: the chosen ones, else every account allowed for Space. */
/** A conversation as the agent gets it: text without the HTML, plus the HTML's links the text misses. */
export function agentThread<T extends { messages: MailMessage[] }>(thread: T): T & { messages: Array<MailMessage & { links: Array<{ text: string; url: string }> }> } {
  return { ...thread, messages: thread.messages.map((message) => ({ ...message, html: null, links: message.html ? linksMissingFromText(message.html, message.text) : [] })) };
}

export function paneAccountEmails(pane: Pane | null, accounts: ReadonlyArray<{ email: string }>): string[] {
  const chosen = pane?.mode === "MAIL_COPILOT" ? resolveMailCopilotPaneMetadata(pane.mailCopilotMetadata).settings.accounts : [];
  const all = accounts.map((account) => account.email);
  return chosen.length ? all.filter((email) => chosen.includes(email)) : all;
}

function accessOf(capabilities: readonly ConnectorCapability[]): MailAccountSummary["access"] {
  return capabilities.includes("MAIL_ORGANIZE") ? "full" : capabilities.includes("MAIL_READ") ? "read" : "none";
}
function gmailError(account: string, error: unknown): Error {
  if (error instanceof GmailMailboxError) return new SpaceConflictError(`${account}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}
/** As Gmail answers: a reply goes from the "Send mail as" address the mail was sent to, anything else from the default one; the account itself when Gmail lists none. */
async function senderFor(client: GmailClient, account: string, headers: unknown): Promise<{ from: string; fromName?: string }> {
  const aliases = await client.sendAs().catch(() => []);
  const recipients = new Set(parseParticipants([header(headers, "To"), header(headers, "Cc")].filter(Boolean).join(", ")).map((entry) => entry.address));
  const alias = aliases.find((entry) => recipients.has(entry.email)) ?? aliases.find((entry) => entry.isDefault);
  return alias ? { from: alias.email, fromName: alias.name } : { from: account };
}
/** The inbox messages dated since `since` (ISO), read by date when Gmail's history no longer reaches back (DATA-001).
 * Gmail's `after:` takes whole seconds; a message seen twice is skipped by its MAIL_RECEIVED event. */
async function inboxSince(client: GmailClient, since: string): Promise<Map<string, { id: string; threadId: string }>> {
  const from = Date.parse(since);
  const added = new Map<string, { id: string; threadId: string }>();
  if (!Number.isFinite(from)) return added;
  let pageToken: string | undefined;
  do {
    const page = await client.listThreads({ labelIds: ["INBOX"], q: `after:${Math.floor(from / 1000)}`, pageToken, maxResults: 500 });
    const threads = await mapLimited(page.ids, 4, (id) => client.thread(id, "metadata"));
    for (const thread of threads) for (const message of (thread.messages as GmailJson[] | undefined) ?? []) {
      if (typeof message.id === "string" && typeof message.threadId === "string" && ((message.labelIds as string[] | undefined) ?? []).includes("INBOX")
        && Number(message.internalDate) >= from) added.set(message.id, { id: message.id, threadId: message.threadId });
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return added;
}

function iso(internalDate: unknown): string | null {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}
/** Unified paging: one Gmail page token per account, carried as one opaque token. */
function encodeCursor(tokens: Record<string, string>): string | null {
  return Object.keys(tokens).length ? Buffer.from(JSON.stringify(tokens), "utf8").toString("base64url") : null;
}
function decodeCursor(token: string | undefined): Record<string, string> {
  if (!token) return {};
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** One kind of mail's actions in words: "moved to Clients 4 of 5 (80%); replied to once". */
export function habitWords(level: MailHabitLevel, limit = Infinity): string {
  return level.actions.slice(0, limit).map((entry) => {
    const target = entry.labels.length ? ` ${entry.labels.map((label) => label.name).join(", ")}` : "";
    const counted = entry.observed ? (entry.share !== null ? `${entry.observed} of ${level.decisions} (${Math.round(entry.share * 100)}%)` : entry.observed === 1 ? "once" : `${entry.observed} times`) : "";
    const inferred = entry.inferred ? `${counted ? ", plus " : ""}${entry.inferred} inferred from the mailbox` : "";
    return `${HABIT_VERB[entry.action]}${target} ${counted}${inferred}`.replace(/\s+/g, " ").trim();
  }).join("; ");
}
/** How many of a sender's actions the operator was seen doing (in the pane or in Gmail), as opposed to inferred. */
const observedOf = (habit: MailHabitSender) => habit.level.actions.reduce((sum, entry) => sum + entry.observed, 0);
/** Groups action rows into one habit level: per action and labels, observed and inferred counts, share of the decisions, last time. */
function habitLevel(kind: MailHabitLevel["level"], key: string, rows: readonly MailActionRecord[], names: ReadonlyMap<string, string>): MailHabitLevel | null {
  if (!rows.length) return null;
  const groups = new Map<string, MailHabitLevel["actions"][number]>();
  for (const row of rows) {
    const id = `${row.action}|${[...row.labelIds].sort().join(",")}`;
    const group = groups.get(id) ?? { action: row.action, labels: row.labelIds.map((label) => ({ id: label, name: names.get(label) ?? label })), observed: 0, inferred: 0, share: null, lastAt: row.occurredAt };
    if (row.source === "BACKFILL") group.inferred += 1; else group.observed += 1;
    if (row.occurredAt > group.lastAt) group.lastAt = row.occurredAt;
    groups.set(id, group);
  }
  const actions = [...groups.values()];
  const decisions = actions.filter((entry) => DISPOSITIONS.has(entry.action)).reduce((sum, entry) => sum + entry.observed, 0);
  for (const entry of actions) entry.share = decisions && DISPOSITIONS.has(entry.action) ? Math.round((entry.observed / decisions) * 100) / 100 : null;
  actions.sort((left, right) => Number(DISPOSITIONS.has(right.action)) - Number(DISPOSITIONS.has(left.action)) || right.observed - left.observed || right.inferred - left.inferred || right.lastAt.localeCompare(left.lastAt));
  return { level: kind, key, decisions, actions };
}

export function createMailCopilotService(options: MailCopilotServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const { repository } = options;
  const starting = new Map<string, Promise<boolean>>();
  /** Per pane: kicks tried in the current stall, when the last went, whether Nous was told. */
  const stalls = new Map<string, { attempts: number; at: number; told: boolean }>();
  /** B (2/11): drafts and policy blocks Nous was told of, and each thread's last block. shortcut: in memory, an API restart tells each once more. */
  const toldUnsent = new Set<string>();
  const blockedThreads = new Map<string, string>();
  /** R23-1: the owner's connected accounts and their send-as aliases, read once in 10 minutes. */
  const own = new Map<string, { at: number; addresses: Promise<Set<string>> }>();
  function ownAddresses(owner: string): Promise<Set<string>> {
    const cached = own.get(owner);
    if (cached && Date.parse(now()) - cached.at < 10 * 60_000) return cached.addresses;
    const addresses = (async () => {
      const accounts = await allowedAccounts(owner, null).catch(() => []);
      const lists = await mapLimited(accounts, 4, async (account) => [account.email.toLowerCase(),
        ...(await clientFor(owner, account.email).then((client) => client.sendAs()).catch(() => [])).map((alias) => alias.email)]);
      return new Set(lists.flat());
    })();
    own.set(owner, { at: Date.parse(now()), addresses });
    return addresses;
  }
  /**
   * A person Space knows the operator deals with: they wrote to them in the last 90 days, or the copilot keeps a contact memory of them.
   * Never the operator's own address (R23-1): a connected account, its send-as alias, or one the copilot's memory marks as theirs.
   */
  async function knownCorrespondent(owner: string, address: string): Promise<string | null> {
    if ((await ownAddresses(owner)).has(address)) return null;
    const memories = (await repository.listMemory(owner, { contactEmail: address, kinds: ["CONTACT", "FACT"] })).filter((entry) => entry.contactEmail?.toLowerCase() === address);
    if (memories.some((entry) => OWN_ADDRESS.test(entry.text))) return null;
    const wrote = (await repository.listActions(owner, { fromAddress: address, actions: ["REPLY", "FORWARD"], actors: ["OPERATOR"],
      since: new Date(Date.parse(now()) - 90 * 86_400_000).toISOString(), limit: 1 }))[0];
    if (wrote) return `the operator wrote to ${address} on ${wrote.occurredAt.slice(0, 10)}`;
    const memory = memories.find((entry) => entry.kind === "CONTACT");
    return memory ? `the copilot's memory ${memory.id} knows them: ${memory.text.slice(0, 160)}` : null;
  }
  const deciding = new Map<string, Promise<{ decision: MailCopilotReviewDecision["decision"]; sent: { messageId: string; threadId: string } | null }>>();

  /** The rule memory that requires the operator to read this review (`reviewRequiringMemories`), or null. */
  async function requiredMemory(owner: string, draft: MailComposeInput | undefined, message: string, account: string | null | undefined) {
    const address = draft?.to[0] ? senderAddress(draft.to[0]).toLowerCase() : undefined;
    const [memory] = await reviewRequiringMemories((query) => repository.listMemory(owner, { query, kinds: ["FACT", "LESSON", "PREFERENCE"], contactEmail: address,
      domain: address ? senderDomain(address) : undefined }), `${draft?.subject ?? ""} ${message.replace(/^Review: /, "")}`,
    [address, account].filter((value): value is string => Boolean(value)));
    return memory ?? null;
  }
  async function record(owner: string, input: MailCopilotEventInput & MailEventContext & { type: MailCopilotEventType; status?: "PENDING" | "TAKEN" | "DONE" | null }): Promise<MailCopilotEvent> {
    const event = await repository.createEvent({
      ownerUserId: owner, paneId: input.paneId ?? null, runId: input.runId ?? null, accountEmail: input.accountEmail ?? null, threadId: input.threadId ?? null, messageId: input.messageId ?? null,
      type: input.type, status: input.status ?? null, message: input.message, payload: input.payload ?? {}
    });
    try { options.onEvent?.(event); } catch { /* listeners never break the write */ }
    return event;
  }
  const paneSettings = (pane: Pane | null): MailCopilotPaneMetadata["settings"] => resolveMailCopilotPaneMetadata(pane?.mailCopilotMetadata).settings;

  async function allowedAccounts(owner: string, pane: Pane | null): Promise<Array<{ email: string; capabilities: ConnectorCapability[]; inPane: boolean }>> {
    const google = options.google();
    if (!google?.googleConfigured) return [];
    const accounts = await google.googleAccounts(owner).catch(() => []);
    const inPane = new Set(paneAccountEmails(pane, accounts));
    return accounts.map((account) => ({ ...account, inPane: inPane.has(account.email) }));
  }
  async function clientFor(owner: string, email: string, capability: ConnectorCapability = "MAIL_READ"): Promise<GmailClient> {
    const google = options.google();
    if (!google?.googleConfigured) throw new SpaceConflictError("Google access is unavailable on this server.");
    const token = await google.googleAccessToken(owner, email, capability).catch(() => {
      throw new SpaceConflictError(`${email} has not allowed ${capability === "MAIL_ORGANIZE" ? "full Gmail access" : "reading its Gmail"} for Space. Allow it in Setup → Accounts.`);
    });
    return createGmailClient({ accessToken: token, fetchImpl: options.gmailFetch });
  }
  /** The connector that answers invitations for `email`; names the re-consent when the account never allowed Google Calendar (12/11). */
  async function calendarAccess(owner: string, email: string) {
    const google = options.google();
    if (!google?.googleConfigured || !google.tool) throw new SpaceConflictError("Google Calendar is unavailable on this server.");
    const account = (await allowedAccounts(owner, null)).find((entry) => entry.email === email);
    if (!account?.capabilities.includes("CALENDAR")) {
      throw new SpaceConflictError(`${email} has not allowed Google Calendar for Space, so the copilot cannot answer invitations. Allow Gmail & Calendar again for it in Job Copilot Setup → Google account.`);
    }
    return google as MailCopilotGoogleAccess & Required<Pick<MailCopilotGoogleAccess, "tool">>;
  }
  /** The pane's accounts with Gmail read access, or the one named; refuses an account outside the pane. */
  /** The file parts of one of the account's messages (a Gmail draft holding a CV, say), as parsePayload lists them. */
  async function attachmentsOf(client: GmailClient, account: string, messageId: string) {
    const message = await client.message(messageId, "full").catch((error) => { throw gmailError(account, error); });
    return parsePayload(message.payload as Record<string, unknown> | undefined).attachments;
  }
  /** R12-5: a review or question the copilot's own memory forbids (scoped to the correspondent, or about the same words) is never raised. */
  async function refuseForbidden(owner: string, item: string, counterpart?: string, account?: string, scheduling = false, order?: string, review = false): Promise<string | undefined> {
    const address = counterpart ? senderAddress(counterpart).toLowerCase() : undefined;
    const memory = await forbiddingMemory(async (query) => (await repository.listMemory(owner, { query, kinds: ["FACT", "LESSON", "PREFERENCE"], contactEmail: address,
      domain: address ? senderDomain(address) : undefined })).filter((found) => !scheduling || !REJECTION_RULE.test(`${found.key ?? ""} ${found.text}`)), item, (found) => Boolean(address && (found.contactEmail || found.domain)),
      [address, account].filter((value): value is string => Boolean(value)), review);
    if (memory && !order) throw new SpaceConflictError(forbiddenByMemoryText("Mail Copilot", memory));
    return memory && order ? operatorOrderOverride(order, memory.id) : undefined;
  }
  /**
   * R12-6 (29/10 09:2x BKK: mailrev:tmL-VVdJEC-3 asked "approve only if you or someone will call" while mailmem:ayKBBtka7V3t said what to
   * write to example.invalid orders): a reply promising a call, a visit or a payment needs a memory about the recipient or the account that allows
   * it; else it is refused, naming the stored policy for that mail when one exists.
   */
  /** nous_msg:fe72e061 (Upwork 7/11): a mail to a site about its password or a reset while the stored sign-in works waits for the operator's order. */
  async function refuseWorkingSigninSupport(owner: string, draft: MailComposeInput, order?: string): Promise<void> {
    if (!options.siteSignin || !(RESET_ASK.test(`${draft.subject}\n${draft.text}`) || /password|κωδικ/i.test(draft.subject))) return;
    for (const domain of new Set(draft.to.map((to) => senderDomain(senderAddress(to).toLowerCase())).filter((domain) => domain.includes(".")))) {
      const guard = resetRefusal(await options.siteSignin(owner, domain).catch(() => null), order);
      if (guard.refusal) throw new SpaceConflictError(`${guard.refusal} Nothing was recorded.`);
    }
  }
  async function refuseCommitment(owner: string, draft: MailComposeInput, scheduling = false): Promise<void> {
    // A thread that asks to arrange a call is answered with the call: that is the reply it asked for, not an outside promise.
    const act = OUTSIDE_ACTS.find((rule) => rule.says.test(draft.text) && !(scheduling && rule.act === "a phone call"));
    if (!act) return;
    const recipient = senderAddress(draft.to[0] ?? "").toLowerCase();
    const domains = [...new Set([senderDomain(recipient), senderDomain(draft.account)].filter((domain) => domain.includes(".")))];
    const kinds: MailCopilotMemory["kind"][] = ["FACT", "LESSON", "PREFERENCE", "TEMPLATE"];
    // The memories naming the domains, and the recipient's and the account's own (the search reads no account).
    const about = [...await repository.listMemory(owner, { query: domains.join(" or "), kinds }),
      ...await repository.listMemory(owner, { contactEmail: recipient, domain: senderDomain(recipient), kinds })]
      .filter((memory) => memory.contactEmail === recipient || (memory.domain && domains.includes(memory.domain)) || memory.accountEmail === draft.account
        || domains.some((domain) => `${memory.key ?? ""} ${memory.text}`.toLowerCase().includes(domain)));
    if (about.some((memory) => act.allows.test(`${memory.key ?? ""} ${memory.text}`) && !NEGATION.test(`${memory.key ?? ""} ${memory.text}`))) return;
    const subject = new Set(draft.subject.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));
    const overlap = (memory: MailCopilotMemory) => `${memory.key ?? ""} ${memory.text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => subject.has(word)).length;
    const policy = about.sort((left, right) => overlap(right) - overlap(left))[0];
    throw new SpaceConflictError(`Not raised: the reply commits the operator to ${act.act} ("${draft.text.match(act.says)![0]}"), and no memory for ${domains.join(" or ") || "this mail"} allows it. `
      + (policy ? `Write what ${policy.id} says for this mail instead: "${policy.text.replace(/\s+/g, " ").slice(0, 300)}". ` : "Leave the promise out, or ask the operator with space_mail_question_ask. ")
      + "Nothing was recorded.");
  }
  /** B (2/11): a reply a rule blocked brings Nous ONE line naming the thread and the rule; the draft watch names it again. */
  async function tellBlocked(owner: string, draft: MailComposeInput, error: unknown): Promise<void> {
    if (!(error instanceof SpaceConflictError)) return;
    const thread = `${draft.account}:${draft.threadId ?? draft.subject}`;
    blockedThreads.set(thread, error.message);
    if (toldUnsent.has(`blocked:${thread}`)) return;
    toldUnsent.add(`blocked:${thread}`);
    await Promise.resolve(options.notice?.(owner, `mail-send-blocked:${thread}`, `Mail Copilot reply blocked by policy, NOT sent: "${draft.subject}" → ${draft.to.join(", ")} (${draft.account}, thread ${draft.threadId ?? "new"}). `
      + `${error.message} Read the thread (space_mail_read ${draft.account} thread ${draft.threadId ?? "?"}): if the rule does not fit this mail, have the reply sent; never tell the operator it was answered.`, true)).catch(() => undefined);
  }
  /**
   * B (2/11: the McArthur/WIM reply sat as a Gmail draft 23:15-03:22 UTC while Nous told the operator it was answered): a draft the copilot made on a
   * thread that is not sent 15 minutes on (at once when a rule blocked its review), with no review open or rejected for it and still in Gmail, brings
   * Nous ONE line naming the thread, the draft and the block.
   */
  async function watchDrafts(owner: string): Promise<void> {
    if (!options.notice) return;
    const at = Date.parse(now());
    const events = await repository.listEvents(owner, { types: ["DRAFTED", "SENT", "REVIEW_REQUESTED", "REVIEW_DECIDED", "NOTE"], since: new Date(at - DRAFT_WATCH_MS).toISOString() });
    for (const draft of events.filter((event) => event.type === "DRAFTED" && typeof event.payload.draftId === "string" && event.accountEmail && event.threadId)) {
      const draftId = String(draft.payload.draftId);
      const block = blockedThreads.get(`${draft.accountEmail}:${draft.threadId}`);
      if (toldUnsent.has(`draft:${draftId}`) || (!block && at - Date.parse(draft.createdAt) < DRAFT_UNSENT_MS)) continue;
      const later = events.filter((event) => event.threadId === draft.threadId && event.createdAt >= draft.createdAt);
      const decided = new Map(later.filter((event) => event.type === "REVIEW_DECIDED").map((event) => [event.payload.reviewId, event.payload.decision]));
      if (later.some((event) => event.type === "SENT" || (event.type === "REVIEW_REQUESTED" && [undefined, "reject"].includes(decided.get(event.payload.reviewId) as string | undefined)))
        || events.some((event) => event.type === "NOTE" && event.payload.draftId === draftId && event.payload.deleted)) continue;
      // Sent or discarded in Gmail itself: Gmail no longer holds the draft.
      const gone = await clientFor(owner, draft.accountEmail!).then((client) => client.draftMessageId(draftId)).then(() => false, (error: unknown) => error instanceof GmailMailboxError && error.status === 404);
      toldUnsent.add(`draft:${draftId}`);
      if (gone) continue;
      await Promise.resolve(options.notice(owner, `mail-draft-unsent:${draftId}`, `Mail Copilot draft NOT sent: ${draft.message.replace(/^The copilot drafted: /, "")} (${draft.accountEmail}, thread ${draft.threadId}, `
        + `draft ${draftId}) has sat unsent since ${draft.createdAt.slice(11, 16)} UTC with no review open for it. ${block ? `Its review was blocked: ${block} ` : ""}`
        + `Read the thread (space_mail_read ${draft.accountEmail} thread ${draft.threadId}), then have it sent (a review you or the operator approve) or deleted; until a sent message shows, never say it was answered.`, true)).catch(() => undefined);
    }
  }
  async function mailAccounts(owner: string, pane: Pane | null, account: string): Promise<string[]> {
    const accounts = (await allowedAccounts(owner, pane)).filter((entry) => entry.inPane && entry.capabilities.includes("MAIL_READ"));
    if (account === "all") return accounts.map((entry) => entry.email);
    if (!accounts.some((entry) => entry.email === account)) throw new SpaceConflictError(`${account} is not a mail account of this pane.`);
    return [account];
  }

  async function threadSummary(account: string, thread: GmailJson): Promise<MailThreadSummary | null> {
    const messages = (thread.messages as GmailJson[] | undefined) ?? [];
    const newest = messages[messages.length - 1];
    if (!newest) return null;
    const labels = new Set(messages.flatMap((message) => (message.labelIds as string[] | undefined) ?? []));
    const headers = (newest.payload as { headers?: unknown } | undefined)?.headers;
    const first = messages[0]!;
    const hasAttachment = messages.some((message) => {
      const parts = ((message.payload as { parts?: Array<{ filename?: string }> } | undefined)?.parts ?? []);
      return parts.some((part) => part.filename);
    });
    return {
      account, threadId: String(thread.id ?? newest.threadId ?? ""), messageId: String(newest.id ?? ""),
      from: parseParticipants(header(headers, "From"))[0] ?? { name: "", address: "" },
      subject: header((first.payload as { headers?: unknown } | undefined)?.headers, "Subject").slice(0, 1000),
      snippet: decodeEntities(String(newest.snippet ?? "")).slice(0, 500), receivedAt: iso(newest.internalDate),
      unread: labels.has("UNREAD"), starred: labels.has("STARRED"), hasAttachment, messageCount: messages.length,
      labelIds: [...labels]
    };
  }

  function toMessage(account: string, message: GmailJson, loadImages: boolean): MailMessage {
    const payload = message.payload as Record<string, unknown> | undefined;
    const headers = (payload as { headers?: unknown } | undefined)?.headers;
    const parsed = parsePayload(payload);
    const messageId = String(message.id ?? "");
    const byCid = new Map(parsed.attachments.filter((attachment) => attachment.contentId).map((attachment) => [attachment.contentId!, attachment.attachmentId]));
    const sanitized = parsed.html ? sanitizeMailHtml(parsed.html, { loadImages, cidUrl: (cid) => {
      const attachmentId = byCid.get(cid);
      return attachmentId ? `/api/mail-copilot/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?account=${encodeURIComponent(account)}&inline=1` : null;
    } }) : null;
    const labelIds = (message.labelIds as string[] | undefined) ?? [];
    return {
      account, messageId, threadId: String(message.threadId ?? ""),
      from: parseParticipants(header(headers, "From"))[0] ?? { name: "", address: "" },
      to: parseParticipants(header(headers, "To")), cc: parseParticipants(header(headers, "Cc")), replyTo: parseParticipants(header(headers, "Reply-To")),
      subject: header(headers, "Subject").slice(0, 1000), receivedAt: iso(message.internalDate),
      rfcMessageId: header(headers, "Message-ID").slice(0, 1000) || null, references: header(headers, "References") || null,
      labelIds, unread: labelIds.includes("UNREAD"), starred: labelIds.includes("STARRED"),
      text: parsed.text, html: sanitized?.html ?? null, blockedImages: sanitized?.blockedImages ?? false, attachments: parsed.attachments
    };
  }

  const RULE_ACTION_FOR: Record<string, MailRule["action"]["type"]> = { send: "REPLY" };
  /**
   * The gate on what the copilot sends (organizing is never gated). ASSIST: the agent drafts and asks. RULES: only
   * under an approved rule of the owner that names this action and matches the message (the rule's use is recorded).
   * FULL: on its own judgement.
   */
  type GateContext = { paneId: string | null; accountEmail: string | null; threadId: string | null; messageId?: string | null };
  async function authorize(owner: string, pane: Pane | null, action: string, ruleId: string | undefined, subject: () => Promise<MailRuleSubject | null>, context: GateContext): Promise<void> {
    const autonomy = paneSettings(pane).autonomy;
    if (autonomy === "FULL") return;
    if (autonomy === "ASSIST") throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: autonomy is Assist, so the copilot cannot ${action} on its own; ask with space_mail_review_request.`);
    if (!ruleId) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: autonomy is Rules; name the approved rule (ruleId) that covers ${action}, or ask with space_mail_review_request.`);
    const rule = await repository.getRule(owner, ruleId);
    if (!rule || rule.status !== "APPROVED") throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule ${ruleId} is not an approved rule of the operator.`);
    if (rule.accountEmail && context.accountEmail && rule.accountEmail !== context.accountEmail) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" belongs to ${rule.accountEmail}.`);
    if (rule.action.type !== RULE_ACTION_FOR[action]) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" allows ${rule.action.type}, not ${action}.`);
    const facts = await subject();
    if (!facts || !mailRuleMatches(rule.condition, facts)) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" does not match this message; ask with space_mail_review_request.`);
    await repository.updateRule(owner, rule.id, { appliedCount: rule.appliedCount + 1, lastAppliedAt: now() });
    await record(owner, { ...context, type: "RULE_APPLIED", message: `Rule "${rule.name}" let the copilot ${action}`, payload: { ruleId: rule.id, action } });
  }
  /** The facts a rule is checked against, from a message's metadata. Gmail's metadata format carries no parts, so attachments read false here. */
  function ruleSubject(message: GmailJson): MailRuleSubject {
    const headers = headersOf(message);
    const parts = ((message.payload as { parts?: Array<{ filename?: string }> } | undefined)?.parts ?? []);
    return { from: header(headers, "From"), subject: header(headers, "Subject"), labelIds: (message.labelIds as string[] | undefined) ?? [], hasAttachment: parts.some((part) => part.filename) };
  }
  /** The message a conversation is about: the newest one someone else sent (the operator's own reply is not the correspondent). */
  /** The account and every address the owner sends as: never the correspondent (13/11 cbc40ebc: a reply from the send-as alias ntheo@ was logged as the correspondent, so the Score never saw the Vultr send). */
  const mine = async (owner: string, account: string) => new Set([account, ...await ownAddresses(owner)].map((address) => address.toLowerCase()));
  function correspondent(messages: GmailJson[], own: ReadonlySet<string>): GmailJson | null {
    return [...messages].reverse().find((message) => !own.has(senderAddress(header(headersOf(message), "From")))) ?? messages.at(-1) ?? null;
  }
  /** One row of the per-account action log; a failed write never fails the action itself. */
  async function logAction(owner: string, input: { accountEmail: string; threadId: string; messageId?: string | null; action: MailOperatorAction; labelIds?: string[]; facts: Pick<MailRuleSubject, "from" | "subject"> | null;
    actor: MailActionRecord["actor"]; source: MailActionRecord["source"]; ruleId?: string | null; occurredAt?: string }): Promise<MailActionRecord | null> {
    const address = input.facts ? senderAddress(input.facts.from) : "";
    return repository.recordAction({ ownerUserId: owner, accountEmail: input.accountEmail, threadId: input.threadId, messageId: input.messageId ?? null, action: input.action, labelIds: input.labelIds ?? [],
      fromAddress: address.includes("@") ? address.slice(0, 320) : null, fromDomain: address.includes("@") ? senderDomain(address).slice(0, 200) : null,
      subject: input.facts ? input.facts.subject.slice(0, 1000) : null, subjectKey: input.facts ? mailSubjectKey(input.facts.subject) || null : null,
      actor: input.actor, source: input.source, ruleId: input.ruleId ?? null, ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}) }).catch(() => null);
  }
  /**
   * What the operator did in Gmail web, on the phone or in another client, read from history: one action log row
   * per thread and action, with the correspondent and subject. Space's own writes (the pane, the copilot, Job
   * Copilot's filing) are already in the log or carry Job Copilot's labels, so they are not counted twice.
   */
  async function learnFromHistory(owner: string, email: string, client: GmailClient, entries: GmailHistoryEntry[], paneId: string | null): Promise<number> {
    const changes = netThreadChanges(entries).filter((change) => classifyThreadChange(change).length);
    if (!changes.length) return 0;
    const ignored = changes.some((change) => [...change.added, ...change.removed].some((label) => label.startsWith("Label_")))
      ? new Set((await client.labels()).filter((label) => label.name.startsWith(JOB_COPILOT_LABEL_PREFIX)).map((label) => label.id)) : new Set<string>();
    const since = new Date(Date.parse(now()) - SPACE_WRITE_WINDOW_MS).toISOString();
    const logged = await mapLimited(changes, 4, async (change): Promise<number> => {
      const recent = await repository.listActions(owner, { accountEmail: email, threadId: change.threadId, since });
      const job = jobLabelChange(change, ignored);
      if (job.added.length || job.removed.length) return logJobFiling(owner, email, client, change.threadId, job, recent);
      const fresh = classifyThreadChange(change, ignored).filter((entry) => !recent.some((row) => row.action === entry.action || (entry.action === "REPLY" && row.action === "FORWARD")));
      if (!fresh.length) return 0;
      let facts: MailRuleSubject | null = null;
      let messages: GmailJson[] = [];
      let own: ReadonlySet<string> = new Set([email]);
      if (change.deleted) {
        // A deleted message has no metadata left; the log or the new-mail event still knows who sent it.
        const known = (await repository.listActions(owner, { accountEmail: email, threadId: change.threadId, limit: 1 }))[0];
        const received = known ? null : (await repository.listEvents(owner, { accountEmail: email, threadId: change.threadId, types: ["MAIL_RECEIVED"], limit: 1 }))[0];
        const from = known?.fromAddress ?? String((received?.payload.from as { address?: string } | undefined)?.address ?? "");
        facts = from || known?.subject || received ? { from, subject: known?.subject ?? String(received?.payload.subject ?? ""), labelIds: [], hasAttachment: false } : null;
        // A deleted message Space never saw (a draft, mail older than the log) says nothing about the operator's habits.
        if (!facts) return 0;
      } else {
        messages = await client.thread(change.threadId, "metadata").then((thread) => (thread.messages as GmailJson[] | undefined) ?? [], () => []);
        const message = correspondent(messages, own = await mine(owner, email));
        facts = message ? ruleSubject(message) : null;
      }
      let count = 0;
      for (const entry of fresh) {
        let action = entry.action;
        let messageId: string | null = null;
        if (action === "REPLY") {
          // A sent message is a reply or a forward of someone's mail; a new message of the operator's own is no action on mail.
          const sent = messages.find((message) => change.sent.includes(String(message.id ?? "")));
          const subject = sent ? header(headersOf(sent), "Subject") : "";
          const answered = messages.some((message) => !own.has(senderAddress(header(headersOf(message), "From"))));
          if (/^\s*fwd?\s*:/i.test(subject)) action = "FORWARD";
          else if (!answered) continue;
          messageId = sent ? String(sent.id ?? "") || null : null;
        }
        const row = await logAction(owner, { accountEmail: email, threadId: change.threadId, messageId, action, labelIds: entry.labelIds, facts, actor: "OPERATOR", source: "GMAIL" });
        if (!row) continue;
        count += 1;
        await learnRules(owner, row, paneId).catch(() => undefined);
        if (HANDLES_MAIL.has(row.action)) await closeHandledItems(owner, email, change.threadId).catch(() => undefined);
      }
      return count;
    });
    return logged.reduce((sum, count) => sum + count, 0);
  }
  /**
   * Job Copilot's filing (its triage, its one-label rule) seen in history, as the thread's label history (actor SPACE): only the
   * labels no row of the last minutes already holds (the operator's own Move to a Job Applications label is recorded by the pane).
   */
  async function logJobFiling(owner: string, email: string, client: GmailClient, threadId: string, job: { added: string[]; removed: string[] }, recent: MailActionRecord[]): Promise<number> {
    const held = (actions: MailOperatorAction[], label: string) => recent.some((row) => actions.includes(row.action) && row.labelIds.includes(label));
    const changes = [["LABEL", job.added.filter((label) => !held(["LABEL", "MOVE"], label))], ["UNLABEL", job.removed.filter((label) => !held(["UNLABEL"], label))]] as const;
    if (changes.every(([, labels]) => !labels.length)) return 0;
    const message = correspondent(await client.thread(threadId, "metadata").then((thread) => (thread.messages as GmailJson[] | undefined) ?? [], () => []), await mine(owner, email));
    let count = 0;
    for (const [action, labelIds] of changes) {
      if (labelIds.length && await logAction(owner, { accountEmail: email, threadId, action, labelIds, facts: message ? ruleSubject(message) : null, actor: "SPACE", source: "GMAIL" })) count += 1;
    }
    return count;
  }
  /**
   * One step of the first look at an account's mailbox: where each conversation of the last 30 days ended up says
   * what the operator does with that kind of mail (trash, a label without the inbox = moved, out of the inbox =
   * archived, starred). Rows are BACKFILL: an inbox-skipping Gmail filter looks like an archive, so they are hints
   * for the copilot and never make a rule. Continues through `backfillPageToken`; done when the window is read.
   */
  async function backfillStep(owner: string, email: string, client: GmailClient, pageToken: string | null): Promise<number> {
    const page = await client.listThreads({ q: BACKFILL_QUERY, pageToken: pageToken ?? undefined, maxResults: BACKFILL_THREADS_PER_TICK });
    const userLabels = await client.labels();
    const jobLabels = new Set(userLabels.filter((label) => label.name.startsWith(JOB_COPILOT_LABEL_PREFIX)).map((label) => label.id));
    const counts = await mapLimited(page.ids, 4, async (threadId): Promise<number> => {
      const messages = await client.thread(threadId, "metadata").then((thread) => (thread.messages as GmailJson[] | undefined) ?? [], () => []);
      const own = await mine(owner, email);
      const message = correspondent(messages, own);
      // Conversations only of the operator's own mail say nothing about how they handle mail they receive.
      if (!message || own.has(senderAddress(header(headersOf(message), "From")))) return 0;
      const labels = new Set(messages.flatMap((entry) => (entry.labelIds as string[] | undefined) ?? []));
      const filed = [...labels].filter((label) => /^Label_\d+$/.test(label) && !jobLabels.has(label));
      const actions: Array<{ action: MailOperatorAction; labelIds: string[] }> = [];
      if (labels.has("TRASH")) actions.push({ action: "TRASH", labelIds: [] });
      else if (filed.length) actions.push({ action: labels.has("INBOX") ? "LABEL" : "MOVE", labelIds: filed });
      else if (!labels.has("INBOX") && ![...labels].some((label) => jobLabels.has(label))) actions.push({ action: "ARCHIVE", labelIds: [] });
      if (labels.has("STARRED")) actions.push({ action: "STAR", labelIds: [] });
      const occurredAt = iso(messages.at(-1)?.internalDate) ?? undefined;
      for (const entry of actions) await logAction(owner, { accountEmail: email, threadId, action: entry.action, labelIds: entry.labelIds, facts: ruleSubject(message), actor: "OPERATOR", source: "BACKFILL", occurredAt });
      return actions.length;
    });
    await repository.setSyncState(owner, email, page.nextPageToken ? { backfillPageToken: page.nextPageToken } : { backfillPageToken: null, backfillDoneAt: now() });
    return counts.reduce((sum, count) => sum + count, 0);
  }
  /**
   * How the operator handled mail like this on this account: by the sender, by the sender with this subject's
   * shape, and by the sender's domain, from the action log (observed in the pane and in Gmail, inferred from the
   * first look). Only the operator's own actions count, never the copilot's.
   */
  /** The account's label names for the labels these rows name (Gmail is asked only when there are any). */
  async function labelNames(owner: string, account: string, rows: readonly MailActionRecord[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (rows.some((row) => row.labelIds.length)) {
      for (const label of await clientFor(owner, account).then((client) => client.labels()).catch(() => [])) names.set(label.id, label.name);
    }
    return names;
  }
  async function habitsFor(owner: string, account: string, input: { from: string; subject?: string | null }): Promise<MailHabits> {
    const sender = senderAddress(input.from);
    const domain = senderDomain(sender);
    const subjectKey = input.subject ? mailSubjectKey(input.subject) || null : null;
    const since = new Date(Date.parse(now()) - HABIT_WINDOW_MS).toISOString();
    const [bySender, byDomain] = await Promise.all([
      // Every action of the habit window (until 31/10 the newest 500 a sender or domain).
      sender.includes("@") ? repository.listActions(owner, { accountEmail: account, fromAddress: sender, actors: ["OPERATOR"], since }) : Promise.resolve([]),
      domain ? repository.listActions(owner, { accountEmail: account, fromDomain: domain, actors: ["OPERATOR"], since }) : Promise.resolve([])
    ]);
    const names = await labelNames(owner, account, [...bySender, ...byDomain]);
    const levels = [
      habitLevel("sender", sender, bySender, names),
      subjectKey ? habitLevel("subject", `${sender} · ${subjectKey}`, bySender.filter((row) => row.subjectKey === subjectKey), names) : null,
      habitLevel("domain", domain, byDomain, names)
    ].filter((entry): entry is MailHabitLevel => Boolean(entry));
    return {
      account, sender, domain, subjectKey,
      summary: levels.map((entry) => `${entry.level === "subject" ? `Same sender and subject shape "${subjectKey}"` : entry.key} on ${account}: ${habitWords(entry)}`),
      levels,
      examples: bySender.map((row) => ({ action: row.action, subject: row.subject, source: row.source, at: row.occurredAt }))
    };
  }
  /**
   * Learned rules: after each observed operator action, a consistent habit (3 or more times, 90% of the decisions
   * on that sender, or on that sender with this subject's shape, in 90 days) becomes an APPROVED rule of that
   * account (operator decision 2026-10-14), and a learned rule the operator now contradicts (takes the copilot's
   * rule action back, or acts otherwise often enough) is retired. A rule once learned is never learned again.
   */
  async function learnRules(owner: string, row: MailActionRecord, paneId: string | null): Promise<void> {
    if (row.actor !== "OPERATOR" || row.source === "BACKFILL" || !row.fromAddress) return;
    const since = new Date(Date.parse(now()) - LEARN_WINDOW_MS).toISOString();
    const rows = (await repository.listActions(owner, { accountEmail: row.accountEmail, fromAddress: row.fromAddress, actors: ["OPERATOR"], since })).filter((entry) => entry.source !== "BACKFILL");
    const rules = (await repository.listRules(owner, { accountEmail: row.accountEmail })).filter((rule) => rule.accountEmail === row.accountEmail);
    const sameLabels = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((label) => right.includes(label));
    /** How consistently the rows in scope do `type` (with these labels): matches over the decisions of that kind, reversals counting against. */
    const consistency = (scope: MailActionRecord[], type: string, labels: readonly string[]) => {
      // A hand-off to the copilot comes on top of where the mail went: counted over the conversations the operator handled.
      if (type === "FIX") {
        const threads = new Set(scope.map((entry) => entry.threadId));
        const fixed = new Set(scope.filter((entry) => entry.action === "FIX").map((entry) => entry.threadId));
        return { matches: fixed.size, decisions: threads.size, share: threads.size ? fixed.size / threads.size : 0 };
      }
      const matches = scope.filter((entry) => LEARNABLE[entry.action] === type && sameLabels(entry.labelIds, labels)).length;
      const against = scope.filter((entry) => (REVERSES[entry.action] ?? []).includes(type as MailOperatorAction)).length;
      const decisions = scope.filter((entry) => DISPOSITIONS.has(entry.action)).length + against;
      return { matches, decisions, share: decisions ? matches / decisions : 0 };
    };
    const facts = (entry: MailActionRecord): MailRuleSubject => ({ from: entry.fromAddress ?? "", subject: entry.subject ?? "", labelIds: [], hasAttachment: false });
    // Contradictions: a reversal of what a learned rule just did, or a habit that is no longer consistent.
    const lastAgent = REVERSES[row.action] ? (await repository.listActions(owner, { accountEmail: row.accountEmail, threadId: row.threadId, actors: ["AGENT"], limit: 1 }))[0] : undefined;
    // A FIX rule's mail is handled by the copilot afterwards, so the operator's later actions on it are no contradiction; the Rules tab retires it.
    for (const rule of rules.filter((entry) => entry.status === "APPROVED" && entry.proposedBy === "LEARNED" && entry.action.type !== "FIX" && entry.condition.fromAddress === row.fromAddress)) {
      const scope = rows.filter((entry) => mailRuleMatches(rule.condition, facts(entry)));
      const taken = Boolean(lastAgent?.ruleId === rule.id && (REVERSES[row.action] ?? []).includes(lastAgent.action));
      const { share } = consistency(scope, rule.action.type, rule.action.labels ?? []);
      if (!taken && share >= LEARN_MIN_SHARE) continue;
      await repository.updateRule(owner, rule.id, { status: "RETIRED", decidedAt: now() });
      await record(owner, { paneId, type: "RULE_RETIRED", accountEmail: rule.accountEmail, threadId: row.threadId,
        message: `Rule retired: ${rule.name} (${taken ? "you took back what it did" : `you now do this ${Math.round(share * 100)}% of the time`})`, payload: { ruleId: rule.id, name: rule.name, reason: taken ? "REVERSED" : "INCONSISTENT" } });
    }
    const type = LEARNABLE[row.action];
    if (!type) return;
    const subjectScope = row.subjectKey ? rows.filter((entry) => entry.subjectKey === row.subjectKey) : [];
    const candidates = [
      { scope: rows, condition: { fromAddress: row.fromAddress } },
      ...(row.subjectKey ? [{ scope: subjectScope, condition: { fromAddress: row.fromAddress, subjectPattern: mailSubjectKeyPattern(row.subjectKey) } }] : [])
    ];
    const chosen = candidates.find((candidate) => {
      const stats = consistency(candidate.scope, type, row.labelIds);
      return stats.matches >= LEARN_MIN_ACTIONS && stats.share >= LEARN_MIN_SHARE;
    });
    if (!chosen) return;
    const action = { type, ...(type === "MOVE" || type === "LABEL" ? { labels: row.labelIds } : {}) };
    const known = rules.some((rule) => JSON.stringify(rule.condition) === JSON.stringify(chosen.condition) && rule.action.type === type && sameLabels(rule.action.labels ?? [], action.labels ?? []));
    if (known) return;
    const today = await repository.listEvents(owner, { accountEmail: row.accountEmail, types: ["RULE_LEARNED"], since: new Date(Date.parse(now()) - 24 * 3_600_000).toISOString(), limit: LEARN_MAX_PER_DAY });
    if (today.length >= LEARN_MAX_PER_DAY) return;
    const stats = consistency(chosen.scope, type, row.labelIds);
    const labelNames = action.labels?.length ? await clientFor(owner, row.accountEmail).then((client) => client.labels()).then((labels) => action.labels!.map((id) => labels.find((label) => label.id === id)?.name ?? id), () => action.labels!) : [];
    const what = type === "MOVE" ? `Move to ${labelNames.join(", ")}` : type === "LABEL" ? `Label ${labelNames.join(", ")}` : type === "ARCHIVE" ? "Archive" : type === "FIX" ? "Send to the copilot to fix" : "Trash";
    const about = chosen.condition.subjectPattern ? ` about "${row.subject?.slice(0, 80) ?? row.subjectKey}"` : "";
    const rule = await repository.createRule({ ownerUserId: owner, accountEmail: row.accountEmail, name: `${what} mail from ${row.fromAddress}${about}`.slice(0, 200), condition: chosen.condition, action, status: "APPROVED",
      confidence: Math.round(stats.share * 100) / 100, proposedBy: "LEARNED",
      evidence: [`You did this ${stats.matches} of ${stats.decisions} times on ${row.accountEmail} in the last 90 days`, ...chosen.scope.filter((entry) => LEARNABLE[entry.action] === type).slice(0, 3).map((entry) => `${entry.occurredAt.slice(0, 10)}: ${entry.subject ?? "(no subject)"} (${entry.source === "GMAIL" ? "in Gmail" : "in the pane"})`.slice(0, 300))] });
    await record(owner, { paneId, type: "RULE_LEARNED", accountEmail: rule.accountEmail, threadId: row.threadId, message: `Rule learned from your actions: ${rule.name}`, payload: { ruleId: rule.id, name: rule.name, condition: rule.condition, action: rule.action } });
  }
  /**
   * A conversation the operator already handled (or handed to the copilot to fix) needs no triage: its waiting
   * MAIL_RECEIVED and TRIAGE items close, so the copilot does not spend a turn on mail that is already done.
   */
  async function closeHandledItems(owner: string, account: string, threadId: string): Promise<void> {
    const waiting = await repository.listEvents(owner, { accountEmail: account, threadId, types: ["MAIL_RECEIVED", "TRIAGE"], status: ["PENDING"] });
    for (const item of waiting) await repository.setItemStatus(owner, item.id, "DONE");
    // Needs you as questions (plan clipboard:5AQvaoSR-IZa): a mail the copilot left to the operator stops asking once they handled it.
    if (options.resolveNotice) for (const asked of await repository.listEvents(owner, { accountEmail: account, threadId, types: ["NEEDS_USER"] })) {
      await options.resolveNotice(owner, mailCopilotNoticeKey(asked.id));
    }
  }
  /** The copilot's questions about a hand-off (same conversation, or asked while it was being worked on) with the operator's answers. */
  function exchangesFor(request: MailCopilotEvent, until: string | null, questions: MailCopilotEvent[], answers: MailCopilotEvent[]): MailFixRequestView["exchanges"] {
    return questions.filter((question) => question.createdAt >= request.createdAt && (!until || question.createdAt <= until)
      && (question.threadId ? question.threadId === request.threadId : question.paneId === request.paneId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((question) => {
        const answer = answers.find((entry) => entry.payload.questionId === question.payload.questionId);
        return { question: String(question.payload.question ?? question.message), askedAt: question.createdAt, answer: answer ? String(answer.payload.answer ?? "") : null, answeredAt: answer?.createdAt ?? null };
      });
  }
  /** A LESSON memory per sender and kind of mail (the latest fix wins): what the operator asked, what they decided, what fixed it. */
  async function rememberFix(owner: string, item: MailCopilotEvent, summary: string): Promise<MailCopilotMemory> {
    const from = item.payload.from as { address?: string; name?: string } | null | undefined;
    const address = from?.address?.toLowerCase() || null;
    const subject = String(item.payload.subject ?? "");
    const [questions, answers] = await Promise.all([repository.listEvents(owner, { types: ["QUESTION"], since: item.createdAt }), repository.listEvents(owner, { types: ["ANSWERED"], since: item.createdAt })]);
    const decided = exchangesFor(item, null, questions, answers).filter((entry) => entry.answer).map((entry) => `asked "${entry.question.slice(0, 300)}", the operator answered "${entry.answer!.slice(0, 300)}"`);
    const text = [`"${subject}"${address ? ` from ${address}` : ""} was sent to the copilot to fix${item.payload.note ? ` with the request "${String(item.payload.note).slice(0, 400)}"` : ""}.`,
      decided.length ? `The copilot ${decided.join("; ")}.` : "", `What fixed it: ${summary}`].filter(Boolean).join(" ").slice(0, 4000);
    return repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: `fix: ${mailSubjectKey(subject) || subject.slice(0, 200)}`.slice(0, 300), text, contactEmail: address, domain: address ? senderDomain(address) || null : null,
      accountEmail: item.accountEmail, tags: ["fix"], source: "LEARNED", confidence: 0.8, pinned: false });
  }
  /** Label names (the unified view's ids) become this account's label ids. */
  async function resolveLabelIds(client: GmailClient, ids: string[]): Promise<string[]> {
    if (ids.every((id) => FIXED_LABEL.test(id))) return ids;
    const labels = await client.labels();
    return ids.map((id) => labels.find((label) => label.id === id)?.id ?? labels.find((label) => label.name === id)?.id ?? id);
  }

  return {
    /** Every Google account allowed for Space, what it grants, whether this pane uses it and its inbox unread count. */
    async accounts(owner: string, pane: Pane | null): Promise<MailAccountSummary[]> {
      const accounts = await allowedAccounts(owner, pane);
      return mapLimited(accounts, 4, async (account): Promise<MailAccountSummary> => {
        const access = accessOf(account.capabilities);
        if (access === "none" || !account.inPane) return { email: account.email, access, inPane: account.inPane, unread: null, error: null };
        try {
          return { email: account.email, access, inPane: true, unread: await (await clientFor(owner, account.email)).labelUnread("INBOX"), error: null };
        } catch (error) {
          return { email: account.email, access, inPane: true, unread: null, error: gmailError(account.email, error).message.slice(0, 300) };
        }
      });
    },
    /** System labels in rail order, then the account's own labels; unread counts for the inbox and user labels. */
    async labels(owner: string, pane: Pane | null, account: string): Promise<MailLabel[]> {
      const emails = await mailAccounts(owner, pane, account);
      const perAccount = await mapLimited(emails, 3, async (email) => {
        const client = await clientFor(owner, email);
        const labels = await client.labels().catch((error) => { throw gmailError(email, error); });
        const unread = new Map<string, number | null>();
        await mapLimited(labels.filter((label) => label.id === "INBOX" || label.type === "user"), 6, async (label) => { unread.set(label.id, await client.labelUnread(label.id)); });
        return { labels, unread };
      });
      const merged = new Map<string, MailLabel>();
      for (const { id, name } of MAIL_SYSTEM_LABELS) merged.set(id, { id, name, type: "system", unread: null });
      for (const { labels, unread } of perAccount) {
        for (const label of labels) {
          const existing = merged.get(label.id) ?? (label.type === "system" ? null : merged.get(label.name));
          const count = unread.get(label.id) ?? null;
          if (existing) {
            existing.unread = count === null && existing.unread === null ? null : (existing.unread ?? 0) + (count ?? 0);
          } else if (label.type !== "system") {
            // User labels merge by name across accounts, keyed by name so the unified view shows one row.
            merged.set(label.name, { id: label.name, name: label.name, type: "user", unread: count });
          }
        }
      }
      return [...merged.values()].filter((label) => label.type === "system" ? MAIL_SYSTEM_LABELS.some((entry) => entry.id === label.id) : true);
    },
    /** One page of threads of one account or, unified, of every account of the pane, newest first. */
    async threads(owner: string, pane: Pane | null, query: MailThreadsQuery): Promise<MailThreadsPage> {
      const emails = await mailAccounts(owner, pane, query.account);
      const cursors = decodeCursor(query.pageToken);
      const nextCursors: Record<string, string> = {};
      const errors: MailThreadsPage["errors"] = [];
      const perAccount = query.account === "all" ? Math.max(5, Math.ceil(query.max / Math.max(1, emails.length))) : query.max;
      const pages = await mapLimited(emails, 3, async (email): Promise<MailThreadSummary[]> => {
        if (query.pageToken && !cursors[email]) return [];
        try {
          const client = await clientFor(owner, email);
          // Gmail's user labels differ per account; a label named across accounts resolves by name.
          let labelIds: string[] | undefined = query.labelId === "ALL" ? undefined : [query.labelId];
          if (labelIds && !MAIL_SYSTEM_LABELS.some((entry) => entry.id === query.labelId)) {
            const own = (await client.labels()).find((label) => label.id === query.labelId || label.name === query.labelId);
            if (!own) return [];
            labelIds = [own.id];
          }
          const page = await client.listThreads({ labelIds, q: query.q, pageToken: cursors[email], maxResults: perAccount });
          if (page.nextPageToken) nextCursors[email] = page.nextPageToken;
          const threads = await mapLimited(page.ids, 6, (id) => client.thread(id, "metadata"));
          const summaries = (await Promise.all(threads.map((thread) => threadSummary(email, thread)))).filter((thread): thread is MailThreadSummary => Boolean(thread));
          const all = summaries.some((row) => row.labelIds.some((id) => id.startsWith("Label_"))) ? await client.labels() : [];
          return summaries.map((row) => ({ ...row, labels: userLabelsOf(all, row.labelIds) }));
        } catch (error) {
          errors.push({ account: email, message: gmailError(email, error).message.slice(0, 300) });
          return [];
        }
      });
      const threads = pages.flat().sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""));
      // Every account's page whole: every cursor moved past its threads, so a cut here skipped them for good (until 31/10).
      return { threads, nextPageToken: encodeCursor(nextCursors), errors };
    },
    /** A thread with every message: text for the agent, sanitized HTML for the reader, attachments to download. */
    async thread(owner: string, pane: Pane | null, account: string, threadId: string, loadImages = false): Promise<MailThread> {
      const [email] = await mailAccounts(owner, pane, account);
      const client = await clientFor(owner, email!);
      // R25-2b (30/10, 1/11: an id no connected account opened as a thread): Gmail opens a thread only by its first message's id, so a
      // later message's id is read as that message's thread; any other 404 stays Gmail's own answer.
      const found = await client.thread(threadId, "full").then((thread) => ({ thread, id: threadId }), async (error) => {
        const id = error instanceof GmailMailboxError && error.status === 404 ? await client.message(threadId, "metadata").then((message) => message.threadId, () => null) : null;
        if (typeof id !== "string" || id === threadId) throw gmailError(email!, error);
        return { thread: await client.thread(id, "full").catch((again) => { throw gmailError(email!, again); }), id };
      });
      const messages = ((found.thread.messages as GmailJson[] | undefined) ?? []).map((message) => toMessage(email!, message, loadImages));
      if (!messages.length) throw new SpaceNotFoundError(`Thread ${threadId} was not found.`);
      return { account: email!, threadId: found.id, subject: messages[0]!.subject, messages };
    },
    /**
     * Archive, trash, star, read, labels and a move to a label on a whole thread (full access). Organizing is the
     * copilot's own job at every autonomy (operator 2026-10-27; only sending is gated). Everything but read marks lands
     * in the account's action log (actor AGENT for the copilot), which the copilot learns from.
     */
    async modify(owner: string, pane: Pane | null, threadId: string, rawInput: MailThreadAction, by: "operator" | "agent" = "operator", ruleId?: string): Promise<{ labels?: MailThreadLabel[] }> {
      await mailAccounts(owner, pane, rawInput.account);
      const client = await clientFor(owner, rawInput.account, "MAIL_ORGANIZE");
      const input: MailThreadAction = rawInput.labelIds?.length ? { ...rawInput, labelIds: await resolveLabelIds(client, rawInput.labelIds).catch((error) => { throw gmailError(rawInput.account, error); }) } : rawInput;
      const logged = LOGGED_ACTION[input.action];
      // Read after the change: the correspondent for the log, and the labels a label action answers with.
      let after: Promise<GmailJson[]> | null = null;
      const messages = () => after ??= client.thread(threadId, "metadata").then((thread) => (thread.messages as GmailJson[] | undefined) ?? [], (error: unknown) => { throw gmailError(input.account, error); });
      const subject = () => messages().then(async (list) => {
        const message = correspondent(list, await mine(owner, input.account));
        return message ? ruleSubject(message) : null;
      });
      const labelsNow = async () => LABEL_ACTIONS.has(input.action)
        ? { labels: userLabelsOf(await client.labels(), (await messages()).flatMap((message) => (message.labelIds as string[] | undefined) ?? [])) } : {};
      // Job labels the one-label rule took off with this write (only those the thread had): the same hand took them off.
      let siblings: string[] = [];
      try {
        if (input.action === "trash" || input.action === "untrash") await client.trashThread(threadId, input.action === "untrash");
        else {
          let change = mailThreadActionLabels(input);
          const asked = change.removeLabelIds;
          if (!change.addLabelIds.length && !change.removeLabelIds.length) throw new SpaceConflictError("Name the labels to add or remove.");
          // One Job Applications label a thread (operator 3/11): a label or move to one takes the others off in the same write.
          let held = new Set<string>();
          if (change.addLabelIds.some((id) => /^Label_/.test(id))) {
            change = exclusiveJobLabels(change, jobLabelIdsOf(await client.labels()));
            if (logged && change.removeLabelIds.some((id) => !asked.includes(id))) {
              held = new Set(((await client.thread(threadId, "metadata")).messages as GmailJson[] | undefined ?? []).flatMap((message) => (message.labelIds as string[] | undefined) ?? []));
            }
          }
          await client.modifyThread(threadId, change);
          siblings = change.removeLabelIds.filter((id) => held.has(id) && !asked.includes(id));
        }
      } catch (error) {
        throw gmailError(input.account, error);
      }
      if (!logged) return {};
      // The operator's Undo takes their own action back out of the log; it was never a habit.
      const undone = by === "operator" ? UNDOES[logged] : undefined;
      if (undone) {
        const since = new Date(Date.parse(now()) - UNDO_WINDOW_MS).toISOString();
        const recent = (await repository.listActions(owner, { accountEmail: input.account, threadId, actions: [undone], since, limit: 1 }).catch(() => []))[0];
        if (recent?.actor === "OPERATOR") {
          await repository.deleteActions(owner, [recent.id]).catch(() => 0);
          return {};
        }
      }
      const actor = by === "agent" ? "AGENT" : "OPERATOR";
      const facts = await subject().catch(() => null);
      const row = await logAction(owner, { accountEmail: input.account, threadId, action: logged, labelIds: input.labelIds, facts, actor, source: "PANE", ruleId });
      if (siblings.length) await logAction(owner, { accountEmail: input.account, threadId, action: "UNLABEL", labelIds: siblings, facts, actor, source: "PANE", ruleId }).catch(() => null);
      if (row) await learnRules(owner, row, pane?.id ?? null).catch(() => undefined);
      if (by === "operator" && HANDLES_MAIL.has(logged)) await closeHandledItems(owner, input.account, threadId).catch(() => undefined);
      return labelsNow().catch(() => ({}));
    },
    /** An open thread's labels now and every recorded add and removal of a label, newest first, with the label names (the reader's "Label history"). */
    async threadLabels(owner: string, pane: Pane | null, account: string, threadId: string): Promise<MailThreadLabels> {
      const [email] = await mailAccounts(owner, pane, account);
      const client = await clientFor(owner, email!);
      const [thread, all] = await Promise.all([client.thread(threadId, "metadata"), client.labels()]).catch((error: unknown) => { throw gmailError(email!, error); });
      const names = new Map(all.map((label) => [label.id, label.name]));
      const rows = await repository.listActions(owner, { accountEmail: email, threadId, actions: ["MOVE", "LABEL", "UNLABEL"] });
      return { labels: userLabelsOf(all, ((thread.messages as GmailJson[] | undefined) ?? []).flatMap((message) => (message.labelIds as string[] | undefined) ?? [])),
        history: rows.map((row) => ({ ...row, labelNames: row.labelIds.map((label) => names.get(label) ?? label) })) };
    },
    /** Sends a new message, a reply or a forward from one of the pane's accounts; replies carry the threading headers. The agent is held to the pane's autonomy and the hourly cap. */
    async send(owner: string, pane: Pane | null, input: MailComposeInput, by: "operator" | "agent" | "review" = "operator", ruleId?: string,
      /** A review's files: copied from that message, refused when they are no longer the ones the operator approved. */
      attach?: { from: string; approved: Array<{ filename: string; size: number }> }): Promise<{ messageId: string; threadId: string }> {
      await mailAccounts(owner, pane, input.account);
      const client = await clientFor(owner, input.account, "MAIL_ORGANIZE");
      const original = input.inReplyToMessageId ? await client.message(input.inReplyToMessageId, "metadata").catch((error) => { throw gmailError(input.account, error); }) : null;
      if (by === "agent") {
        if (input.to.some((address) => AUTOMATED_SENDER.test(address))) throw new SpaceConflictError("That address is an automated sender; the copilot never replies to it.");
        await authorize(owner, pane, "send", ruleId, async () => original ? ruleSubject(original) : null, { paneId: pane?.id ?? null, accountEmail: input.account, threadId: input.threadId ?? null, messageId: input.inReplyToMessageId ?? null });
        const cap = paneSettings(pane).sendsPerHour;
        const sentLastHour = await repository.listEvents(owner, { types: ["SENT"], since: new Date(Date.parse(now()) - 3_600_000).toISOString() });
        if (sentLastHour.length >= cap) throw new SpaceConflictError(`The pane's cap of ${cap} sends per hour is reached; ask the operator or wait.`);
      }
      const headers = (original?.payload as { headers?: unknown } | undefined)?.headers;
      const inReplyTo = header(headers, "Message-ID") || null;
      const references = header(headers, "References") || null;
      const sender = await senderFor(client, input.account, headers);
      let files: MimeAttachment[] = [];
      if (attach) {
        const parts = await attachmentsOf(client, input.account, attach.from);
        const names = (list: Array<{ filename: string; size: number }>) => list.map((file) => `${file.filename} (${file.size})`).sort().join(", ");
        if (names(parts) !== names(attach.approved)) {
          throw new SpaceConflictError(`The attachments of ${attach.from} changed since the review (${names(attach.approved)} approved, ${names(parts) || "none"} now); nothing was sent. Ask for a new review.`);
        }
        // shortcut: the files ride in the JSON raw body of messages.send (fine for CVs and letters); above ~5 MB in all use Gmail's media upload.
        files = await Promise.all(parts.map(async (part) => ({ filename: part.filename, mimeType: part.mimeType,
          data: await client.attachment(attach.from, part.attachmentId).catch((error) => { throw gmailError(input.account, error); }) })));
      }
      const raw = buildMime({ ...sender, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, inReplyTo, references, attachments: files });
      let sent: { id: string; threadId: string };
      try {
        sent = await client.send(raw, input.threadId);
      } catch (error) {
        throw gmailError(input.account, error);
      }
      await record(owner, { paneId: pane?.id ?? null, type: "SENT", accountEmail: input.account, threadId: sent.threadId, messageId: sent.id,
        message: `${by === "agent" ? "The copilot sent" : "You sent"}: ${input.subject || "(no subject)"} → ${input.to.join(", ")}`, payload: { by, from: sender.from, to: input.to, cc: input.cc, reply: Boolean(input.inReplyToMessageId), ...(files.length ? { attachments: files.map((file) => file.filename) } : {}) } });
      // Replies and forwards join the action log (a forward names no correspondent: the forwarded mail is in its body).
      const kind: MailOperatorAction | null = /^\s*fwd?\s*:/i.test(input.subject) ? "FORWARD" : original ? "REPLY" : null;
      if (kind) await logAction(owner, { accountEmail: input.account, threadId: sent.threadId, messageId: sent.id, action: kind, facts: original ? ruleSubject(original) : { from: "", subject: input.subject },
        actor: by === "agent" ? "AGENT" : "OPERATOR", source: "PANE", ruleId });
      if (kind === "REPLY" && by !== "agent") await closeHandledItems(owner, input.account, sent.threadId).catch(() => undefined);
      // A reply the operator wrote themselves teaches the copilot how they answer: a learn item for the next run.
      if (by === "operator" && pane && original) {
        await record(owner, { paneId: pane.id, type: "USER_ACTION", status: "PENDING", accountEmail: input.account, threadId: sent.threadId, messageId: input.inReplyToMessageId ?? null,
          message: `You replied: ${input.subject || "(no subject)"} → ${input.to.join(", ")}`, payload: { action: "reply", to: input.to, subject: input.subject, text: input.text.slice(0, 4000), from: header(headers, "From"), originalSubject: header(headers, "Subject") } });
      }
      return { messageId: sent.id, threadId: sent.threadId };
    },
    /** Saves a Gmail draft (full access) so the operator can finish it in the pane or in Gmail. */
    async draft(owner: string, pane: Pane | null, input: MailComposeInput): Promise<{ draftId: string; messageId: string }> {
      await mailAccounts(owner, pane, input.account);
      const client = await clientFor(owner, input.account, "MAIL_ORGANIZE");
      // A reply draft carries the threading headers too, or Gmail starts a new thread despite the threadId.
      const original = input.inReplyToMessageId ? await client.message(input.inReplyToMessageId, "metadata").catch((error) => { throw gmailError(input.account, error); }) : null;
      const headers = (original?.payload as { headers?: unknown } | undefined)?.headers;
      const raw = buildMime({ ...await senderFor(client, input.account, headers), to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text,
        inReplyTo: header(headers, "Message-ID") || null, references: header(headers, "References") || null });
      try {
        const draft = await client.createDraft(raw, input.threadId);
        return { draftId: draft.id, messageId: draft.messageId };
      } catch (error) {
        throw gmailError(input.account, error);
      }
    },
    /** Deletes a draft the copilot saved itself (its DRAFTED event names it) and nobody changed since; every other draft is the operator's. */
    async deleteDraft(owner: string, pane: Pane, account: string, draftId: string): Promise<void> {
      await mailAccounts(owner, pane, account);
      // shortcut: only the newest 500 copilot drafts of the account are found; page the events if older ones must go.
      const drafted = (await repository.listEvents(owner, { accountEmail: account, types: ["DRAFTED"] })).find((event) => event.payload.draftId === draftId);
      if (!drafted) throw new SpaceConflictError("The copilot did not save that draft; only the operator deletes it.");
      const client = await clientFor(owner, account, "MAIL_ORGANIZE");
      const current = await client.draftMessageId(draftId).catch((error) => { throw gmailError(account, error); });
      // Drafts saved before 2026-10-26 carry no message id: those are deleted as saved.
      if (typeof drafted.payload.draftMessageId === "string" && current !== drafted.payload.draftMessageId) throw new SpaceConflictError("That draft changed after the copilot saved it (the operator may have edited it); only the operator deletes it now.");
      await client.deleteDraft(draftId).catch((error) => { throw gmailError(account, error); });
      await record(owner, { paneId: pane.id, type: "NOTE", accountEmail: account, threadId: drafted.threadId, message: `The copilot deleted its draft: ${drafted.message.replace(/^The copilot drafted: /, "")}`, payload: { draftId, deleted: true } });
    },
    /** Gmail's Delete for any mail or draft, allowed at every autonomy (operator decision 2026-10-26): a message goes to the Trash (30 days), a draft is discarded. */
    async deleteMail(owner: string, pane: Pane, input: { account: string; messageId?: string; draftId?: string }): Promise<void> {
      await mailAccounts(owner, pane, input.account);
      const client = await clientFor(owner, input.account, "MAIL_ORGANIZE");
      if (input.draftId) {
        await client.deleteDraft(input.draftId).catch((error) => { throw gmailError(input.account, error); });
        await record(owner, { paneId: pane.id, type: "NOTE", accountEmail: input.account, message: "The copilot discarded a draft", payload: { draftId: input.draftId, deleted: true } });
        return;
      }
      const message = await client.message(input.messageId!, "metadata").catch((error) => { throw gmailError(input.account, error); });
      await client.trashMessage(input.messageId!).catch((error) => { throw gmailError(input.account, error); });
      const facts = ruleSubject(message);
      await record(owner, { paneId: pane.id, type: "TRASHED", accountEmail: input.account, threadId: String(message.threadId ?? "") || null, messageId: input.messageId!,
        message: `The copilot deleted: ${facts.subject || "(no subject)"} from ${facts.from || "?"}`, payload: { action: "delete", from: facts.from, subject: facts.subject } });
    },
    /** One attachment's bytes and type, for download or inline display. */
    async attachment(owner: string, pane: Pane | null, account: string, messageId: string, attachmentId: string, filename?: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
      const [email] = await mailAccounts(owner, pane, account);
      const client = await clientFor(owner, email!);
      try {
        const message = await client.message(messageId, "full");
        const files = parsePayload(message.payload as Record<string, unknown> | undefined).attachments;
        // R25-2 (7 days to 1/11: 9 "Attachment was not found"): Gmail gives an attachment a new id on every fetch, so an id from an
        // earlier read may be missing here; the caller's file name finds it when exactly one attachment has it, read by this fetch's id.
        const named = filename ? files.filter((entry) => entry.filename === filename) : [];
        const meta = files.find((entry) => entry.attachmentId === attachmentId) ?? (named.length === 1 ? named[0] : undefined);
        if (!meta) throw new SpaceNotFoundError("Attachment was not found.");
        return { data: await client.attachment(messageId, meta.attachmentId), filename: meta.filename, mimeType: meta.mimeType };
      } catch (error) {
        throw gmailError(email!, error);
      }
    },
    record,
    // ---- memory -------------------------------------------------------------------------------
    listMemory: (owner: string, query: MailCopilotMemoryQuery) => repository.listMemory(owner, query),
    /** Recall before drafting: the memories about the sender, their domain and the subject, counted as used. */
    async recallMemory(owner: string, input: { query?: string; contactEmail?: string; domain?: string; kinds?: MailCopilotMemory["kind"][]; limit?: number }): Promise<MailCopilotMemory[]> {
      // Every memory that matches, best first, and every pinned one (until 31/10 20 and 20), unless the agent asks for fewer.
      const scoped = await repository.listMemory(owner, { query: input.query, kinds: input.kinds, contactEmail: input.contactEmail, domain: input.domain, ...(input.limit ? { limit: input.limit } : {}) });
      const pinned = await repository.listMemory(owner, { pinnedOnly: true, kinds: input.kinds });
      const merged = [...new Map([...pinned, ...scoped].map((memory) => [memory.id, memory])).values()];
      await repository.touchMemories(owner, merged.map((memory) => memory.id));
      return merged;
    },
    rememberMemory: (owner: string, input: MailCopilotMemoryCreate) => repository.upsertMemory({ ownerUserId: owner, kind: input.kind, key: input.key ?? null, text: input.text, contactEmail: input.contactEmail ?? null,
      domain: input.domain ?? null, accountEmail: input.accountEmail ?? null, tags: input.tags, source: input.source, confidence: input.confidence, pinned: input.pinned }),
    updateMemory: (owner: string, id: string, patch: MailCopilotMemoryUpdate) => repository.updateMemory(owner, id, patch),
    forgetMemory: (owner: string, id: string) => repository.deleteMemory(owner, id),
    listEvents: (owner: string, filter: { paneId?: string; accountEmail?: string; threadId?: string; types?: string[]; since?: string; limit?: number }) => repository.listEvents(owner, filter),
    // ---- runs and the work loop ---------------------------------------------------------------
    async pendingItems(owner: string, paneId: string | null): Promise<MailCopilotPendingItem[]> {
      const events = await repository.listEvents(owner, { paneId, types: ["QUESTION", "ANSWERED", "REVIEW_REQUESTED", "REVIEW_DECIDED"] });
      const done = new Set(events.filter((event) => event.type === "ANSWERED" || event.type === "REVIEW_DECIDED").map((event) => String(event.payload.questionId ?? event.payload.reviewId ?? "")));
      return events.filter((event) => (event.type === "QUESTION" && !done.has(String(event.payload.questionId))) || (event.type === "REVIEW_REQUESTED" && !done.has(String(event.payload.reviewId))))
        .map((event) => ({ id: String(event.type === "QUESTION" ? event.payload.questionId : event.payload.reviewId), kind: event.type === "QUESTION" ? "QUESTION" as const : "REVIEW" as const, eventId: event.id,
          accountEmail: event.accountEmail, threadId: event.threadId, message: event.message, payload: event.payload, createdAt: event.createdAt }));
    },
    async runView(owner: string, paneId: string): Promise<MailCopilotRunView> {
      const run = await repository.getActiveRun(paneId);
      return { run: run && run.ownerUserId === owner ? run : null, status: run && run.ownerUserId === owner ? run.status : "IDLE", pending: await this.pendingItems(owner, paneId), backlog: await repository.countPendingItems(owner) };
    },
    async startRun(owner: string, paneId: string): Promise<{ run: MailCopilotRun; kickoff: boolean; resumed: boolean }> {
      const active = await repository.getActiveRun(paneId);
      if (active && active.ownerUserId !== owner) throw new SpaceConflictError("Another user's run is active in this pane.");
      if (active?.status === "RUNNING") return { run: active, kickoff: !active.kickoffSentAt, resumed: false };
      if (active?.status === "PAUSED") {
        const resumed = (await repository.updateRun(owner, active.id, { status: "RUNNING", pausedAt: null, lastActivityAt: now() }))!;
        await record(owner, { paneId, runId: resumed.id, type: "RUN_RESUMED", message: "Run resumed" });
        return { run: resumed, kickoff: !resumed.kickoffSentAt, resumed: true };
      }
      const run = await repository.createRun({ ownerUserId: owner, paneId, status: "RUNNING" });
      await record(owner, { paneId, runId: run.id, type: "RUN_STARTED", message: "Run started: the copilot works through new mail and the backlog" });
      return { run, kickoff: true, resumed: false };
    },
    async markKickoff(owner: string, runId: string): Promise<void> { await repository.updateRun(owner, runId, { kickoffSentAt: now(), lastActivityAt: now() }); },
    async pauseRun(owner: string, paneId: string): Promise<MailCopilotRun> {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      if (run.status === "PAUSED") return run;
      const paused = (await repository.updateRun(owner, run.id, { status: "PAUSED", pausedAt: now(), lastActivityAt: now() }))!;
      await record(owner, { paneId, runId: run.id, type: "RUN_PAUSED", message: "Run paused" });
      return paused;
    },
    async stopRun(owner: string, paneId: string): Promise<MailCopilotRun> {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      const stopped = (await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now(), currentEventId: null }))!;
      await record(owner, { paneId, runId: run.id, type: "RUN_STOPPED", message: `Run stopped: ${summarize(run.counters)}` });
      return stopped;
    },
    /**
     * The agent's loop: waits (up to `waitMs`) until the run is RUNNING and a work item exists. Work items are
     * PENDING events (new mail, learn items) and, when none wait, untriaged inbox conversations of the pane's
     * accounts newer than `backlogHours`, each made into a TRIAGE item once. Hands out one item with its context.
     */
    async nextItem(owner: string, pane: Pane, input: { waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      let scanned = false;
      for (;;) {
        const run = await repository.getActiveRun(pane.id);
        if (!run || run.ownerUserId !== owner) return { done: true as const, reason: "NO_RUN" as const, item: null };
        const settings = paneSettings(pane);
        if (run.status === "RUNNING" && !settings.paused) {
          let item = await repository.takeNextItem(owner, pane.id, TAKEN_STALE_MS);
          if (!item && !scanned) {
            scanned = true;
            await this.scanBacklog(owner, pane, run.id).catch((error: unknown) => record(owner, { paneId: pane.id, runId: run.id, type: "NOTE", message: `Backlog scan failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000) }));
            item = await repository.takeNextItem(owner, pane.id, TAKEN_STALE_MS);
          }
          if (item) {
            const counters = { ...run.counters, taken: run.counters.taken + 1 };
            await repository.updateRun(owner, run.id, { currentEventId: item.id, counters, lastActivityAt: now() });
            return { done: false as const, item, run: { ...run, counters }, autonomy: settings.autonomy, context: await this.itemContext(owner, pane, item) };
          }
          if (scanned && (await repository.countPendingItems(owner)) === 0) {
            const finished = (await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now(), currentEventId: null }))!;
            await record(owner, { paneId: pane.id, runId: run.id, type: "RUN_FINISHED", message: `Run finished: ${summarize(run.counters)}` });
            return { done: true as const, reason: "QUEUE_EMPTY" as const, item: null, run: finished };
          }
        }
        if (Date.now() >= deadline) return { done: false as const, waiting: true as const, reason: run.status === "PAUSED" ? "PAUSED" as const : settings.paused ? "SETTINGS_PAUSED" as const : "EMPTY" as const, item: null, run };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    /**
     * Untriaged inbox conversations of the pane's accounts within the backlog window become TRIAGE items, once per thread.
     * The daily run's scan (`wholeInbox`) takes every inbox conversation, automated senders included, that no item decided
     * yet and none waits for.
     */
    async scanBacklog(owner: string, pane: Pane, runId: string | null, wholeInbox = false): Promise<number> {
      const settings = paneSettings(pane);
      const since = Date.parse(now()) - settings.backlogHours * 3_600_000;
      const threads: MailThreadSummary[] = [];
      // Per account, page by page (the unified view keeps only `max` threads of a page while every account's cursor moves on): the
      // backlog scan every inbox conversation of the backlog window (until 31/10 the newest 25 of all accounts), the daily scan every one
      // (until 31/10 the first 1,000 an account).
      for (const account of await mailAccounts(owner, pane, "all")) {
        let pageToken: string | undefined;
        do {
          const page = await this.threads(owner, pane, { account, labelId: "INBOX", max: 50, ...(pageToken ? { pageToken } : {}) });
          threads.push(...page.threads);
          pageToken = page.nextPageToken ?? undefined;
          // Newest first: past the window's start the rest is older still.
          if (!wholeInbox && page.threads.some((thread) => thread.receivedAt && Date.parse(thread.receivedAt) < since)) break;
        } while (pageToken);
      }
      let created = 0;
      for (const thread of threads) {
        if (!wholeInbox && (!thread.receivedAt || Date.parse(thread.receivedAt) < since || AUTOMATED_SENDER.test(thread.from.address))) continue;
        const seen = wholeInbox
          ? (await repository.listEvents(owner, { accountEmail: thread.account, threadId: thread.threadId, types: ["TRIAGE", "MAIL_RECEIVED", "FIX_REQUESTED", ...DECIDED_TYPES] }))
            .filter((event) => DECIDED_TYPES.includes(event.type) || event.status === "PENDING" || event.status === "TAKEN")
          : await repository.listEvents(owner, { accountEmail: thread.account, threadId: thread.threadId, types: ["TRIAGE", "MAIL_RECEIVED", "TRIAGED", "REPLIED", "DRAFTED", "ARCHIVED", "TRASHED", "LABELED", "SKIPPED", "NEEDS_USER"], limit: 1 });
        if (seen.length) continue;
        await record(owner, { paneId: pane.id, runId, type: "TRIAGE", status: "PENDING", accountEmail: thread.account, threadId: thread.threadId, messageId: thread.messageId,
          message: `Triage: ${thread.subject || "(no subject)"} from ${thread.from.name || thread.from.address}`, payload: { from: thread.from, subject: thread.subject, snippet: thread.snippet, labelIds: thread.labelIds, receivedAt: thread.receivedAt } });
        created += 1;
      }
      return created;
    },
    /** What the agent needs for one item: the conversation as text and the memories about its sender. */
    async itemContext(owner: string, pane: Pane, item: MailCopilotEvent) {
      if (!item.accountEmail || !item.threadId) return { thread: null, memories: [] as MailCopilotMemory[], habits: null };
      const thread = await this.thread(owner, pane, item.accountEmail, item.threadId).catch(() => null);
      // The correspondent, never the operator's own reply at the end of the thread.
      const newest = thread ? [...thread.messages].reverse().find((message) => message.from.address.toLowerCase() !== item.accountEmail) ?? thread.messages.at(-1) ?? null : null;
      const memories = newest ? await this.recallMemory(owner, { query: newest.subject, contactEmail: newest.from.address, domain: senderDomain(newest.from.address) }) : [];
      // How the operator handled this sender and this kind of mail before, on this account: the copilot's main guide.
      const habits = newest ? await habitsFor(owner, item.accountEmail, { from: newest.from.address, subject: newest.subject }).catch(() => null) : null;
      return { thread: thread ? agentThread(thread) : null, memories, habits };
    },
    async reportItem(owner: string, pane: Pane, input: { eventId: string; outcome: "replied" | "drafted" | "archived" | "labeled" | "skipped" | "needs_user" | "learned" | "fixed"; summary: string; memoryIds: string[] }) {
      const item = await repository.getEvent(owner, input.eventId);
      if (!item || item.status === null) throw new SpaceNotFoundError(`Work item ${input.eventId} was not found.`);
      if (item.status === "DONE") throw new SpaceConflictError("That item was already reported.");
      // C (2/11): "replied" only with a message Space sent in the thread since the item came; a draft is "drafted" (DRAFT, not sent).
      const sent = input.outcome === "replied" && item.threadId ? (await repository.listEvents(owner, { types: ["SENT"], threadId: item.threadId })).find((event) => event.createdAt >= item.createdAt) : undefined;
      if (input.outcome === "replied" && !sent?.messageId) throw new SpaceConflictError(`Not recorded: Space sent no message in this thread since ${item.createdAt.slice(0, 16)} UTC, so it is not replied. `
        + "Report it as drafted (DRAFT, not sent) or raise a review; nothing was recorded.");
      await repository.setItemStatus(owner, item.id, "DONE");
      const run = await repository.getActiveRun(pane.id);
      const counterKey = { replied: "replied", drafted: "drafted", archived: "archived", labeled: "labeled", skipped: "skipped", needs_user: "needsUser", learned: "skipped", fixed: "fixed" }[input.outcome] as keyof MailCopilotRun["counters"];
      if (run && run.ownerUserId === owner) await repository.updateRun(owner, run.id, { counters: { ...run.counters, [counterKey]: run.counters[counterKey] + 1 }, currentEventId: null, lastActivityAt: now() });
      const type: MailCopilotEventType = { replied: "REPLIED", drafted: "DRAFTED", archived: "ARCHIVED", labeled: "LABELED", skipped: "SKIPPED", needs_user: "NEEDS_USER", learned: "TRIAGED", fixed: "FIXED" }[input.outcome] as MailCopilotEventType;
      await repository.touchMemories(owner, input.memoryIds);
      // A fixed hand-off teaches the copilot how this kind of mail is fixed, with what the operator asked and decided.
      const lesson = item.type === "FIX_REQUESTED" && input.outcome === "fixed" ? await rememberFix(owner, item, input.summary).catch(() => null) : null;
      const message = sent ? `${input.summary} (sent: ${sent.messageId})` : input.outcome === "drafted" && !/^DRAFT, not sent/i.test(input.summary) ? `DRAFT, not sent: ${input.summary}` : input.summary;
      return record(owner, { paneId: pane.id, runId: run?.id ?? null, type, accountEmail: item.accountEmail, threadId: item.threadId, messageId: item.messageId, message,
        payload: { itemId: item.id, outcome: input.outcome, memoryIds: input.memoryIds, ...(lesson ? { lessonMemoryId: lesson.id } : {}) } });
    },
    // ---- questions and reviews ---------------------------------------------------------------
    async askQuestion(owner: string, pane: Pane, input: { question: string; options?: string[]; accountEmail?: string; threadId?: string; afterMemory?: boolean }) {
      // The same question still open in this pane (an agent's retry) is the same card, never a second one.
      const open = (await this.pendingItems(owner, pane.id)).find((item) => item.kind === "QUESTION" && item.payload.question === input.question && item.threadId === (input.threadId ?? null));
      if (open) return { questionId: open.id, answered: false as const };
      await refuseForbidden(owner, input.question, undefined, undefined, (await this.threadAsks(owner, pane, input.accountEmail, input.threadId)).asks);
      // R13-5 (Job's item 34 for Mail): the copilot's own memories that may answer it come back first, nothing asked.
      // Every memory a question word finds, up to the memory list's page of 200 (until 31/10 five a word).
      const memoryHits = input.afterMemory ? [] : await questionMemoryHits((query) => repository.listMemory(owner, { query, kinds: ["CONTACT", "FACT", "LESSON", "PREFERENCE"] }), input.question);
      if (memoryHits.length) return { questionId: null, answered: false as const, memoryHits, note: MEMORY_HITS_NOTE };
      const questionId = `mailq:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, type: "QUESTION", accountEmail: input.accountEmail ?? null, threadId: input.threadId ?? null, message: `Needs you: ${input.question}`,
        payload: { questionId, question: input.question, options: input.options ?? [] } });
      return { questionId, answered: false as const };
    },
    /** by NOUS: Nous, the mind of SpaceApp, answered for the operator (its answer is the agent's memory, not the operator's voice). */
    async answerQuestion(owner: string, pane: Pane, input: { questionId: string; answer: string }, by: "USER" | "NOUS" = "USER") {
      const events = await repository.listEvents(owner, { types: ["QUESTION"] });
      const question = events.find((event) => event.payload.questionId === input.questionId);
      if (!question) throw new SpaceNotFoundError("The question was not found.");
      const memory = await repository.upsertMemory({ ownerUserId: owner, kind: "FACT", key: String(question.payload.question).toLowerCase().slice(0, 300), text: input.answer, contactEmail: null,
        domain: null, accountEmail: null, tags: ["question"], source: by === "NOUS" ? "AGENT" : "USER", confidence: 0.9, pinned: false });
      await record(owner, { paneId: pane.id, type: "ANSWERED", accountEmail: question.accountEmail, threadId: question.threadId, message: `${by === "NOUS" ? "Nous" : "You"} answered: ${input.answer.slice(0, 200)}`, payload: { questionId: input.questionId, answer: input.answer, memoryId: memory.id, answeredBy: by } });
      return { memory };
    },
    async waitForAnswer(owner: string, input: { questionId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const answered = (await repository.listEvents(owner, { types: ["ANSWERED"] })).find((event) => event.payload.questionId === input.questionId);
        if (answered) return { answered: true as const, answer: String(answered.payload.answer ?? ""), answeredAt: answered.createdAt };
        if (Date.now() >= deadline) return { answered: false as const, answer: null };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    /**
     * A (2/11): whether the thread's newest mail from the other side asks to schedule a call, interview or meeting, (3/11) asks the candidate
     * to write or confirm, or (5/11) is about a test or assessment to act on (`asks`; false when unread). `ownOnly` (5/11 BlooMind, thread
     * 1a1a6dd84e85adcd: our own application with the CV, refused by a rejection memory): the thread was read and holds only the account's own
     * mail (drafts, sent), so it answers no rejection, closing or receipt.
     */
    async threadAsks(owner: string, pane: Pane, account?: string, threadId?: string | null): Promise<{ asks: boolean; ownOnly: boolean }> {
      if (!account || !threadId) return { asks: false, ownOnly: false };
      const thread = await this.thread(owner, pane, account, threadId).catch(() => null);
      const inbound = thread ? [...thread.messages].reverse().find((message) => message.from.address.toLowerCase() !== thread.account.toLowerCase()) : undefined;
      const text = inbound ? `${inbound.subject}\n${inbound.text}` : "";
      return { asks: Boolean(inbound && (asksToSchedule(text) || asksForAction(text) || asksAboutAssessment(text))), ownOnly: Boolean(thread && !inbound) };
    },
    /** The agent's reply waits for the operator: approve (the server sends it), edit (sends the edit, learns the difference) or reject. */
    async requestReview(owner: string, pane: Pane, input: { draft: MailComposeInput; summary: string; reasoning?: string; operatorOrder?: string; attachmentsFrom?: string }) {
      await mailAccounts(owner, pane, input.draft.account);
      // BlooMind 5/11 (thread 1a1a6dd84e85adcd: a Gmail draft with the CV attached): the files of that message go out with the approved reply.
      const files = input.attachmentsFrom ? (await attachmentsOf(await clientFor(owner, input.draft.account), input.draft.account, input.attachmentsFrom))
        .map((file) => ({ filename: file.filename, mimeType: file.mimeType, size: file.size })) : [];
      if (input.attachmentsFrom && !files.length) throw new SpaceConflictError(`${input.attachmentsFrom} holds no attachments; nothing was recorded.`);
      const order = await operatorOrder(options.operatorMessages, owner, input.operatorOrder);
      const { asks: scheduling, ownOnly } = await this.threadAsks(owner, pane, input.draft.account, input.draft.threadId);
      let overrides: string | undefined;
      try {
        overrides = await refuseForbidden(owner, `${input.draft.subject} ${input.summary}`, input.draft.to[0], input.draft.account, scheduling || ownOnly, order, true);
        await refuseCommitment(owner, input.draft, scheduling);
        await refuseWorkingSigninSupport(owner, input.draft, order);
      } catch (error) { await tellBlocked(owner, input.draft, error); throw error; }
      // R12-4: a reply an approved REPLY rule covers (the recipient as its sender, the subject without "Re:") recommends Approve on the card.
      const facts = { from: input.draft.to[0] ?? "", subject: input.draft.subject.replace(/^(?:re|aw|απ)\s*:\s*/iu, ""), labelIds: [], hasAttachment: false };
      const vouched = (await repository.listRules(owner, { status: ["APPROVED"], accountEmail: input.draft.account }))
        .some((rule) => rule.action.type === "REPLY" && mailRuleMatches(rule.condition, facts)) ? "RULE" : null;
      const reviewId = `mailrev:${randomBytes(9).toString("base64url")}`;
      const message = `Review: ${input.summary}${overrides ? ` (${overrides})` : ""}${files.length ? ` [attachments: ${files.map((file) => file.filename).join(", ")}]` : ""}`;
      // Nous 13/11 (mailrev:lddyXCl-tHDS, Akamai credits, held for Nous under "May send" against mailmem:SLvZ9IZgCRc4): a review a rule memory
      // says the operator reads first goes to the operator's Needs you, never held for Nous (isNousApproval reads `operatorReads`).
      const operatorReads = await requiredMemory(owner, input.draft, message, input.draft.account).catch(() => null);
      await record(owner, { paneId: pane.id, type: "REVIEW_REQUESTED", accountEmail: input.draft.account, threadId: input.draft.threadId ?? null, messageId: input.draft.inReplyToMessageId ?? null,
        message, payload: { reviewId, draft: input.draft, ...(operatorReads ? { operatorReads: operatorReads.id } : {}),
          ...(files.length ? { attachmentsFrom: input.attachmentsFrom, attachments: files } : {}),
          reasoning: [overrides, input.reasoning].filter(Boolean).join("\n") || null,
          ...(order ? { operatorOrder: order } : {}), ...(vouched ? { vouched } : {}) } });
      return { reviewId, ...(overrides ? { overrides } : {}) };
    },
    /** An answer to a calendar invitation waits for the operator like a reply (Nous 12/11): the server answers only once it is approved. */
    async requestRsvp(owner: string, pane: Pane, input: MailCopilotRsvpRequest) {
      const { account, summary, threadId, ...rsvp } = input;
      await mailAccounts(owner, pane, account);
      await calendarAccess(owner, account);
      const reviewId = `mailrev:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, type: "REVIEW_REQUESTED", accountEmail: account, threadId: threadId ?? null,
        message: `Review: answer "${RSVP_LABEL[rsvp.response]}" to the invitation: ${summary}`, payload: { reviewId, rsvp, reasoning: null } });
      return { reviewId };
    },
    /**
     * Nous 13/11 (mailrev:oLB398mFW7pu went out under maySend): the rule memory that requires this review (funding mail: "the operator reads
     * it before it goes out"), read with the words and addresses it was raised with; null when none does or the review is unknown.
     */
    /** The draft a review sends, for a Nous decision's "What it sends" (operator 13/11 21:43 BKK: "show everything" showed nothing); null when unknown or an RSVP. */
    async reviewDraft(owner: string, reviewId: string) {
      const review = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"] })).find((event) => event.payload.reviewId === reviewId);
      const draft = review?.payload.draft as MailComposeInput | undefined;
      if (!draft) return null;
      const files = (review!.payload.attachments as Array<{ filename: string }> | undefined) ?? [];
      return { headers: [["From", draft.account], ["To", draft.to.join(", ")], ["Cc", (draft.cc ?? []).join(", ")], ["Bcc", (draft.bcc ?? []).join(", ")], ["Subject", draft.subject],
        ["Attachments", files.map((file) => file.filename).join(", ")]] as Array<[string, string]>, body: draft.text };
    },
    async reviewRequiredBy(owner: string, reviewId: string) {
      const review = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"] })).find((event) => event.payload.reviewId === reviewId);
      return review ? requiredMemory(owner, review.payload.draft as MailComposeInput | undefined, review.message, review.accountEmail) : null;
    },
    /**
     * One decision and one Gmail send per review (stable 2026-10-17: one approval went to Hetzner twice, 9 s apart): a decided
     * review answers its recorded decision, and a decision already running is shared by the calls that arrive meanwhile.
     * shortcut: the in-flight guard is per process; the API runs one, a second process would need a database claim.
     */
    async decideReview(owner: string, pane: Pane, input: MailCopilotReviewDecision, by?: RailAnswerBy) {
      const key = `${owner}\u0000${input.reviewId}`;
      const running = deciding.get(key);
      if (running) return running;
      const decision = this.decideReviewOnce(owner, pane, input, by).finally(() => deciding.delete(key));
      deciding.set(key, decision);
      return decision;
    },
    /** `by`: who ran it when not the rail itself (RailAnswerBy), so the decision ledger never scores it as the operator's rail answer (goal 7365014c). */
    async decideReviewOnce(owner: string, pane: Pane, input: MailCopilotReviewDecision, by?: RailAnswerBy) {
      const decided = (await repository.listEvents(owner, { types: ["REVIEW_DECIDED"] })).find((event) => event.payload.reviewId === input.reviewId);
      if (decided) return { decision: decided.payload.decision as MailCopilotReviewDecision["decision"], sent: (decided.payload.sent ?? null) as { messageId: string; threadId: string } | null };
      const review = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"] })).find((event) => event.payload.reviewId === input.reviewId);
      if (!review) throw new SpaceNotFoundError("The review was not found.");
      const rsvp = review.payload.rsvp as MailCopilotRsvp | undefined;
      if (rsvp && review.accountEmail) {
        let answered: unknown = null;
        if (input.decision !== "reject") {
          const comment = input.decision === "edit" && input.text?.trim() ? input.text.trim() : rsvp.comment;
          const outcome = await (await calendarAccess(owner, review.accountEmail)).tool(owner, "calendar.respond", { ...rsvp, ...(comment ? { comment } : {}), account: review.accountEmail });
          if (outcome.status === "BLOCKED") throw new SpaceConflictError(outcome.statusReason);
          answered = outcome.result;
        }
        await record(owner, { paneId: pane.id, type: "REVIEW_DECIDED", accountEmail: review.accountEmail, threadId: review.threadId,
          message: answered ? `You approved the calendar answer; "${RSVP_LABEL[rsvp.response]}" was sent` : `You rejected the calendar answer${input.note ? `: ${input.note}` : ""}`,
          payload: { reviewId: input.reviewId, decision: input.decision, note: input.note ?? null, sent: null, answered, ...(by ? { by } : {}) } });
        if (answered && review.threadId) await closeHandledItems(owner, review.accountEmail, review.threadId).catch(() => undefined);
        return { decision: input.decision, sent: null };
      }
      const draft = review.payload.draft as MailComposeInput;
      let sent: { messageId: string; threadId: string } | null = null;
      if (input.decision !== "reject") {
        const text = input.decision === "edit" && input.text !== undefined ? input.text : draft.text;
        const files = review.payload.attachments as Array<{ filename: string; size: number }> | undefined;
        sent = await this.send(owner, pane, { ...draft, text }, "review", undefined,
          typeof review.payload.attachmentsFrom === "string" && files ? { from: review.payload.attachmentsFrom, approved: files } : undefined);
        if (input.decision === "edit" && text !== draft.text) {
          await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, text: `For "${draft.subject.slice(0, 120)}" to ${draft.to.join(", ")} the operator changed the reply. Copilot draft:\n${draft.text.slice(0, 1200)}\n\nOperator's version:\n${text.slice(0, 1200)}`,
            contactEmail: draft.to[0] ?? null, domain: draft.to[0] ? senderDomain(draft.to[0]) : null, accountEmail: draft.account, tags: ["review-edit"], source: "LEARNED", confidence: 0.7, pinned: false });
        }
      }
      await record(owner, { paneId: pane.id, type: "REVIEW_DECIDED", accountEmail: review.accountEmail, threadId: review.threadId, messageId: sent?.messageId ?? null,
        message: input.decision === "approve" ? "You approved the reply; it was sent" : input.decision === "edit" ? "You edited the reply; your version was sent" : `You rejected the reply${input.note ? `: ${input.note}` : ""}`,
        payload: { reviewId: input.reviewId, decision: input.decision, note: input.note ?? null, sent, ...(by ? { by } : {}) } });
      // 2/11 (ArcFusion: a NEEDS_USER card stayed in Needs you after its review was sent): a sent review settles its thread's waiting items and cards.
      if (sent && review.accountEmail && review.threadId) await closeHandledItems(owner, review.accountEmail, review.threadId).catch(() => undefined);
      return { decision: input.decision, sent };
    },
    // ---- rules --------------------------------------------------------------------------------
    listRules: (owner: string, filter?: { status?: MailRule["status"][]; accountEmail?: string | null }) => repository.listRules(owner, filter),
    /** The agent proposes a rule after seeing the operator act the same way on the same kind of mail; the operator decides it in the rail. */
    async proposeRule(owner: string, pane: Pane, proposal: MailRuleProposal): Promise<MailRule> {
      if (proposal.accountEmail) await mailAccounts(owner, pane, proposal.accountEmail);
      const rule = await repository.createRule({ ownerUserId: owner, accountEmail: proposal.accountEmail ?? null, name: proposal.name, condition: proposal.condition, action: proposal.action, status: "PROPOSED",
        confidence: proposal.confidence, evidence: proposal.evidence, proposedBy: "AGENT" });
      await record(owner, { paneId: pane.id, type: "RULE_PROPOSED", accountEmail: rule.accountEmail, message: `Rule proposed: ${rule.name}`, payload: { ruleId: rule.id, name: rule.name, condition: rule.condition, action: rule.action } });
      return rule;
    },
    /** The operator writes a rule directly: approved at once. */
    async createRule(owner: string, pane: Pane | null, proposal: MailRuleProposal): Promise<MailRule> {
      const rule = await repository.createRule({ ownerUserId: owner, accountEmail: proposal.accountEmail ?? null, name: proposal.name, condition: proposal.condition, action: proposal.action, status: "APPROVED",
        confidence: 1, evidence: proposal.evidence, proposedBy: "USER" });
      await record(owner, { paneId: pane?.id ?? null, type: "RULE_DECIDED", accountEmail: rule.accountEmail, message: `You added the rule: ${rule.name}`, payload: { ruleId: rule.id, decision: "approve" } });
      return rule;
    },
    async decideRule(owner: string, pane: Pane | null, id: string, input: MailRuleDecision, by?: RailAnswerBy): Promise<MailRule> {
      const rule = await repository.getRule(owner, id);
      if (!rule) throw new SpaceNotFoundError("The rule was not found.");
      const status = ({ approve: "APPROVED", reject: "REJECTED", retire: "RETIRED" } as const)[input.decision];
      const updated = (await repository.updateRule(owner, id, { status, decidedAt: now() }))!;
      // The decision lands in the pane that proposed the rule (that is where the notification and the Activity live).
      const proposal = (await repository.listEvents(owner, { types: ["RULE_PROPOSED"] })).find((event) => event.payload.ruleId === id);
      await record(owner, { paneId: pane?.id ?? proposal?.paneId ?? null, type: "RULE_DECIDED", accountEmail: rule.accountEmail, message: `You ${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "retired"} the rule: ${rule.name}`, payload: { ruleId: rule.id, decision: input.decision, ...(by ? { by } : {}) } });
      return updated;
    },
    // ---- new-mail sync ------------------------------------------------------------------------
    /**
     * Reads what arrived in one account's inbox since the last history id: every new message becomes a MAIL_RECEIVED
     * event (a work item unless the sender is automated). The first sync only records where to start; an expired
     * history id (Gmail keeps about a week: a restore from an older backup, a long outage) restarts from now with a
     * SYNC_RESET note after reading the inbox mail dated since the last sync, so the gap gets its items and notices (DATA-001).
     */
    async syncAccount(owner: string, pane: Pane, email: string): Promise<{ created: number; reset: boolean; learned: number }> {
      const state = await repository.getSyncState(owner, email);
      const client = await clientFor(owner, email);
      const restart = async () => repository.setSyncState(owner, email, { historyId: (await client.profile()).historyId || null, lastSyncedAt: now(), lastError: null, consecutiveFailures: 0 });
      // The first look at the mailbox runs alongside the sync until it read the last 30 days; a failed step is retried next tick.
      const backfill = async () => state?.backfillDoneAt ? 0 : backfillStep(owner, email, client, state?.backfillPageToken ?? null).catch(() => 0);
      /** Every new inbox message once: its MAIL_RECEIVED event (an item unless automated), FIX rule and important-mail notice. */
      const ingest = async (added: Map<string, { id: string; threadId: string }>): Promise<number> => {
        let created = 0;
        // New mail like the mail the operator keeps sending to the copilot to fix goes to the copilot on its own (a learned or written FIX rule).
        const fixRules = added.size ? (await repository.listRules(owner, { status: ["APPROVED"], accountEmail: email })).filter((rule) => rule.action.type === "FIX" && (rule.accountEmail === null || rule.accountEmail === email)) : [];
        for (const { id, threadId } of added.values()) {
          const seen = await repository.listEvents(owner, { accountEmail: email, threadId, types: ["MAIL_RECEIVED"] });
          if (seen.some((event) => event.messageId === id)) continue;
          const message = await client.message(id, "metadata");
          const facts = ruleSubject(message);
          const from = parseParticipants(facts.from)[0] ?? { name: "", address: "" };
          const automated = AUTOMATED_SENDER.test(from.address);
          const fixRule = fixRules.find((rule) => mailRuleMatches(rule.condition, facts));
          const snippet = decodeEntities(String(message.snippet ?? "")).slice(0, 500);
          // Score 6/11: `to` lets sentTo read a Bcc copy of our own SMTP send (crew@ via SMTP2GO, Bcc spaceappdv) as that send.
          const to = parseParticipants([header(headersOf(message), "To"), header(headersOf(message), "Cc")].filter(Boolean).join(", ")).map((entry) => entry.address.toLowerCase());
          await record(owner, { paneId: pane.id, type: "MAIL_RECEIVED", status: automated || fixRule ? null : "PENDING", accountEmail: email, threadId, messageId: id,
            message: `New mail: ${facts.subject || "(no subject)"} from ${from.name || from.address}`,
            payload: { from, to, subject: facts.subject, snippet, labelIds: facts.labelIds, receivedAt: iso(message.internalDate), automated } });
          const address = from.address.toLowerCase();
          const system = systemMailVerdict(facts.subject, snippet);
          const important = options.notice && address && address !== email.toLowerCase() && system !== false ? system ?? importantMailSignal(address, `${facts.subject}\n${snippet}`, automated)
            ?? (automated ? null : await knownCorrespondent(owner, address).catch(() => null)) : null;
          if (important) await Promise.resolve(options.notice!(owner, `important-mail:${email}:${id}`, `Important mail to ${email} (${important}) from ${from.name ? `${from.name} ` : ""}<${address}>, `
            + `${(iso(message.internalDate) ?? now()).slice(11, 16)} UTC: "${facts.subject || "(no subject)"}"${snippet ? `: ${snippet}` : ""}. Mail Copilot ${pane.paneName ?? pane.title} (${pane.id}) `
            + `${automated ? "skips automated senders" : "has it queued"}; the operator may be asleep: read it now (space_mail_read ${email} thread ${threadId}) and act, or see that the copilot does.`, true)).catch(() => undefined);
          if (fixRule) {
            await this.requestFix(owner, pane, { account: email, threadId, messageId: id, by: "rule", ruleId: fixRule.id, ruleName: fixRule.name, facts });
            fixRule.appliedCount += 1;
            await repository.updateRule(owner, fixRule.id, { appliedCount: fixRule.appliedCount, lastAppliedAt: now() });
          }
          created += 1;
        }
        return created;
      };
      if (!state?.historyId) { await restart(); return { created: 0, reset: false, learned: await backfill() }; }
      try {
        const added = new Map<string, { id: string; threadId: string }>();
        const entries: GmailHistoryEntry[] = [];
        const touched = new Set<string>();
        let latest = state.historyId;
        let pageToken: string | undefined;
        let pages = 0;
        do {
          const page = await client.history({ startHistoryId: state.historyId, historyTypes: HISTORY_TYPES, pageToken });
          const records = (page.history as GmailHistoryEntry[] | undefined) ?? [];
          for (const entry of records) {
            entries.push(entry);
            for (const { message } of entry.messagesAdded ?? []) if (message?.id && message.threadId && (message.labelIds ?? []).includes("INBOX")) added.set(message.id, { id: message.id, threadId: message.threadId });
            for (const { message } of [...entry.labelsAdded ?? [], ...entry.labelsRemoved ?? [], ...entry.messagesDeleted ?? []]) if (message?.threadId) touched.add(message.threadId);
          }
          pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
          pages += 1;
          // The mailbox's history id is the cursor once every page was read; a long history goes on next tick from the last record read.
          if (!pageToken && page.historyId) latest = String(page.historyId);
          if (pageToken && (pages >= SYNC_MAX_PAGES || touched.size >= SYNC_MAX_THREADS)) {
            latest = String(records.at(-1)?.id ?? latest);
            break;
          }
        } while (pageToken);
        const created = await ingest(added);
        const learned = await learnFromHistory(owner, email, client, entries, pane.id) + await backfill();
        await repository.setSyncState(owner, email, { historyId: latest, lastSyncedAt: now(), lastError: null, consecutiveFailures: 0 });
        return { created, reset: false, learned };
      } catch (error) {
        if (error instanceof GmailMailboxError && error.status === 404) {
          const cursor = (await client.profile()).historyId || null;
          const created = state.lastSyncedAt ? await ingest(await inboxSince(client, state.lastSyncedAt)) : 0;
          await repository.setSyncState(owner, email, { historyId: cursor, lastSyncedAt: now(), lastError: null, consecutiveFailures: 0 });
          await record(owner, { paneId: pane.id, type: "SYNC_RESET", accountEmail: email,
            message: `${email}: Gmail's history expired; new mail is followed from now on${state.lastSyncedAt ? `, and ${created} message${created === 1 ? "" : "s"} since ${state.lastSyncedAt.slice(0, 16)} UTC were read from the inbox` : ""}` });
          return { created, reset: true, learned: 0 };
        }
        await repository.setSyncState(owner, email, { lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000), consecutiveFailures: state.consecutiveFailures + 1 });
        throw gmailError(email, error);
      }
    },
    /**
     * "Send to AI": one conversation goes to the copilot to check and fix what it needs. The hand-off is an action of
     * the log (the operator's, so the copilot learns it; a learned FIX rule's own hand-offs are the copilot's) and a
     * FIX_REQUESTED work item; the run starts on its own when the pane can take it.
     */
    async requestFix(owner: string, pane: Pane, input: MailCopilotFixRequest & { by?: "operator" | "rule"; ruleId?: string; ruleName?: string; facts?: MailRuleSubject | null; messageId?: string }): Promise<{ event: MailCopilotEvent; runStarted: boolean }> {
      await mailAccounts(owner, pane, input.account);
      const by = input.by ?? "operator";
      const facts = input.facts !== undefined ? input.facts : await clientFor(owner, input.account).then((client) => client.thread(input.threadId, "metadata")).then(async (thread) => {
        const message = correspondent((thread.messages as GmailJson[] | undefined) ?? [], await mine(owner, input.account));
        return message ? ruleSubject(message) : null;
      }, (error: unknown) => { throw gmailError(input.account, error); });
      const row = await logAction(owner, { accountEmail: input.account, threadId: input.threadId, messageId: input.messageId ?? null, action: "FIX", facts,
        actor: by === "operator" ? "OPERATOR" : "AGENT", source: by === "operator" ? "PANE" : "SPACE", ruleId: input.ruleId ?? null });
      if (row && by === "operator") await learnRules(owner, row, pane.id).catch(() => undefined);
      await closeHandledItems(owner, input.account, input.threadId).catch(() => undefined);
      const from = facts ? parseParticipants(facts.from)[0] ?? null : null;
      const subject = facts?.subject || "(no subject)";
      const event = await record(owner, { paneId: pane.id, type: "FIX_REQUESTED", status: "PENDING", accountEmail: input.account, threadId: input.threadId, messageId: input.messageId ?? null,
        message: by === "operator" ? `You sent to the copilot to check and fix: ${subject}` : `Sent to the copilot to check and fix (rule "${input.ruleName ?? input.ruleId}"): ${subject}`,
        payload: { by, ruleId: input.ruleId ?? null, note: input.note ?? null, from, subject } });
      return { event, runStarted: await this.autostart(owner, pane).catch(() => false) };
    },
    /** Starts the pane's run for work nobody pressed Start for, when the pane is not paused, no run is paused and its CLI can take the kickoff. */
    async autostart(owner: string, pane: Pane, force = false): Promise<boolean> {
      // Hand-offs sent back to back share one start: a second kickoff would type the run's prompt into the CLI twice.
      const pending = starting.get(pane.id);
      if (pending) return pending;
      const start = this.startOnce(owner, pane, force).finally(() => starting.delete(pane.id));
      starting.set(pane.id, start);
      return start;
    },
    /** `force`: the kickoff goes in even when the run had it recently (a new CLI session never saw it). */
    async startOnce(owner: string, pane: Pane, force = false): Promise<boolean> {
      if (!options.kickoff || paneSettings(pane).paused) return false;
      const active = await repository.getActiveRun(pane.id);
      if (active?.status === "PAUSED" || (active && active.ownerUserId !== owner) || !(await options.kickoff.ready(pane))) return false;
      const started = await this.startRun(owner, pane.id);
      if (force || started.kickoff || Date.parse(now()) - Date.parse(started.run.lastActivityAt) >= RUN_IDLE_MS) {
        await options.kickoff.send(pane, started.run);
        await this.markKickoff(owner, started.run.id);
      }
      return true;
    },
    /**
     * The daily organize run (operator 2026-10-27): once a day from the pane's `dailyRunHour` in the owner's time zone,
     * when the pane is not paused and its CLI can take the kickoff, the whole inbox is scanned and the run starts.
     */
    async dailyRun(owner: string, pane: Pane, timeZone: string): Promise<boolean> {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(now())).map((part) => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      if (Number(parts.hour) < paneSettings(pane).dailyRunHour || paneSettings(pane).paused || !options.kickoff) return false;
      const marks = await repository.listEvents(owner, { paneId: pane.id, types: ["NOTE"], since: new Date(Date.parse(now()) - 48 * 3_600_000).toISOString() });
      if (marks.some((event) => event.payload.dailyRun === day)) return false;
      const active = await repository.getActiveRun(pane.id);
      if (active?.status === "PAUSED") return false;
      // The pane always runs (operator 2026-10-27): a stopped CLI is started first and the pass waits for its prompt.
      if (options.kickoff.startCli && options.kickoff.cliRunning && !(await options.kickoff.cliRunning(pane))) { await options.kickoff.startCli(pane); return false; }
      if (!(await options.kickoff.ready(pane))) return false;
      // The mark goes first: a failed scan is not retried every minute, and the run still takes the usual backlog.
      const mark = await record(owner, { paneId: pane.id, type: "NOTE", message: `Daily organize run ${day}: the whole inbox`, payload: { dailyRun: day } });
      await this.scanBacklog(owner, pane, active?.id ?? null, true).catch((error: unknown) => record(owner, { paneId: pane.id, type: "NOTE",
        message: `Daily inbox scan failed: ${error instanceof Error ? error.message : String(error)}`, payload: { dailyRunOf: mark.id } }));
      return this.autostart(owner, pane);
    },
    /**
     * The always-on copilot's minute check (operator P0 1/11: on 31/10 Cleo/Andy's run idled from 07:06 UTC and its CLI exited at 14:58;
     * nothing noticed for hours). A CLI that is not running starts again (Nous hears it once per start). Mail waiting with the run idle
     * 15 minutes gets the kickoff again; when two kicks bring nothing (or cannot go in), Nous gets ONE urgent line naming the pane and the mail.
     */
    async keepAlive(owner: string, pane: Pane, roomName: string): Promise<void> {
      await watchDrafts(owner).catch(() => undefined);
      const kickoff = options.kickoff;
      const active = await repository.getActiveRun(pane.id);
      if (!kickoff || paneSettings(pane).paused || active?.status === "PAUSED") { stalls.delete(pane.id); return; }
      const label = `Mail Copilot ${pane.paneName ?? pane.title} (${pane.id}) in room ${roomName}`;
      const waiting = await repository.listEvents(owner, { status: ["PENDING"] });
      if (kickoff.cliRunning && kickoff.startCli && !(await kickoff.cliRunning(pane))) {
        if (await kickoff.startCli(pane)) await Promise.resolve(options.notice?.(owner, `mail-copilot-cli:${pane.id}`, `Space started ${label} again: its CLI was not running`
          + ` (${waiting.length} mail item${waiting.length === 1 ? "" : "s"} waiting). The run's kickoff follows at its first empty prompt; if it does not come up, restart it (space_restart_pane).`)).catch(() => undefined);
        return;
      }
      // A CLI session that never got this run's kickoff (restarted by Space, Nous or the operator) gets it at its first empty prompt.
      if (waiting.length && await kickoff.newSession?.(pane).catch(() => false) && await this.autostart(owner, pane, true).catch(() => false)) { stalls.delete(pane.id); return; }
      // The run's status says nothing (31/10: RUNNING 13 hours, counters 0): only its last activity and what it took count.
      const at = Date.parse(now());
      const lastWork = active ? Date.parse(active.lastActivityAt) : 0;
      const stall = stalls.get(pane.id);
      if (!waiting.length || (stall && lastWork > stall.at)) stalls.delete(pane.id);
      const oldest = waiting.at(-1);
      if (!oldest || at - Date.parse(oldest.createdAt) < STALL_MS || at - lastWork < (stalls.has(pane.id) ? RUN_IDLE_MS : STALL_MS)) return;
      const state = stalls.get(pane.id) ?? { attempts: 0, at: 0, told: false };
      stalls.set(pane.id, state);
      if (state.attempts >= 2 && !state.told) {
        state.told = true;
        const why = await kickoff.stuck?.(pane).catch(() => null);
        await Promise.resolve(options.notice?.(owner, `mail-copilot-stalled:${pane.id}`, `URGENT: ${label} does not take the mail: ${state.attempts} kicks brought nothing`
          + `${why ? ` (${why})` : ""}; ${active ? `its run ${active.id} is ${active.status} but its last activity was ${active.lastActivityAt.slice(11, 16)} UTC and it took ${active.counters.taken} item${active.counters.taken === 1 ? "" : "s"}` : "it has no run"}. ${waiting.length} mail item${waiting.length === 1 ? "" : "s"} waiting: `
          + waiting.map((item) => { const from = item.payload.from as { address?: string } | undefined; return `${item.createdAt.slice(11, 16)} ${from?.address ?? item.accountEmail ?? ""} "${item.payload.subject ?? item.message}"`; }).join("; ")
          + `. Read the pane (space_read_pane) and get it going (space_restart_pane), or handle the important mail yourself (space_mail_read).`, true)).catch(() => undefined);
      }
      if (await this.autostart(owner, pane).catch(() => false)) { state.attempts += 1; state.at = Date.parse(now()); return; }
      // A CLI busy with a turn is not stuck; a refused kick (a draft, a usage limit, a menu) is a failed one.
      if ((await kickoff.stuck?.(pane).catch(() => null)) ?? null) { state.attempts += 1; state.at = at; }
    },
    /** New mail that made work items starts the pane's run on its own (operator 2026-10-27: the pane always runs). */
    async startForNewMail(owner: string, pane: Pane): Promise<boolean> {
      return (await repository.countPendingItems(owner)) > 0 && this.autostart(owner, pane);
    },
    syncState: (owner: string, email: string) => repository.getSyncState(owner, email),
    /** Every mail sent to the copilot to fix (Activity → Sent to AI), newest first: the request, the questions and answers, and the result. */
    async fixRequests(owner: string, pane: Pane | null, limit?: number): Promise<MailFixRequestView[]> {
      const accounts = await mailAccounts(owner, pane, "all");
      const requests = (await repository.listEvents(owner, { types: ["FIX_REQUESTED"] })).filter((event) => !event.accountEmail || accounts.includes(event.accountEmail)).slice(0, limit);
      if (!requests.length) return [];
      const since = requests.at(-1)!.createdAt;
      const [reports, questions, answers] = await Promise.all([
        repository.listEvents(owner, { types: ["FIXED", "NEEDS_USER", "SKIPPED", "REPLIED", "DRAFTED", "ARCHIVED", "LABELED", "TRIAGED"], since }),
        repository.listEvents(owner, { types: ["QUESTION"], since }),
        repository.listEvents(owner, { types: ["ANSWERED"], since })
      ]);
      return requests.map((request) => {
        const report = reports.find((event) => event.payload.itemId === request.id) ?? null;
        const from = request.payload.from as { address?: string } | null | undefined;
        return {
          id: request.id, account: request.accountEmail, threadId: request.threadId, subject: String(request.payload.subject ?? "(no subject)"), from: from?.address ?? null,
          note: typeof request.payload.note === "string" ? request.payload.note : null, by: request.payload.by === "rule" ? "rule" as const : "operator" as const,
          status: (request.status ?? "DONE") as MailFixRequestView["status"], requestedAt: request.createdAt,
          exchanges: exchangesFor(request, report?.createdAt ?? null, questions, answers),
          outcome: report ? { type: report.type, summary: report.message, at: report.createdAt } : null,
          memoryId: typeof report?.payload.lessonMemoryId === "string" ? report.payload.lessonMemoryId : null
        };
      });
    },
    /** The action log as the operator reads it back (Activity → Your actions), newest first, for the pane's accounts. */
    /** Replies and forwards logged on one thread since a time (Nous's double-send guard, queue item 27). */
    threadReplies: (owner: string, account: string, threadId: string, since: string) =>
      repository.listActions(owner, { accountEmail: account.toLowerCase(), threadId, actions: ["REPLY", "FORWARD"], since, limit: 5 }),
    /**
     * Nous Score's «sent means seen» from the store, no Gmail read: our newest send on a thread since a time (a logged reply or forward, our SENT
     * event, or a review the operator decided whose send went out: REVIEW_DECIDED with payload.sent; a review draft with no in-reply-to logs no
     * REPLY, 13/11 3fac478d), BOUNCED when a mailer-daemon mail came after it; null: none.
     */
    async threadSend(owner: string, account: string, threadId: string, since: string, recipients: string[] = []): Promise<"SENT" | "BOUNCED" | null> {
      const scope = { accountEmail: account.toLowerCase(), threadId, since };
      const [[reply], events] = await Promise.all([repository.listActions(owner, { ...scope, actions: ["REPLY", "FORWARD"], limit: 1 }),
        repository.listEvents(owner, { ...scope, types: ["SENT", "REVIEW_DECIDED"] })]);
      const sends = events.filter((event) => event.type === "SENT" || (event.payload.sent as { messageId?: unknown } | null)?.messageId);
      const at = [reply?.occurredAt, ...sends.map((event) => event.createdAt)].filter((time): time is string => !!time).sort().at(-1);
      if (!at) return null;
      const after = await repository.listEvents(owner, { ...scope, types: ["MAIL_RECEIVED"], since: at });
      return bouncedFor(after, addressesIn([recipients, reply?.fromAddress, sends.map((event) => [event.payload.to, event.payload.cc])])) ? "BOUNCED" : "SENT";
    },
    /**
     * Score's mail rule (goal 84ba917a, audit 6/11): our send since a time, in ANY thread of any account (null) or of `account`, to one of
     * `recipients` or, outside the shared mail providers, to their domain; from the store (our SENT events by their to/cc, replies and
     * forwards logged from Gmail by correspondent, and the copy of a send made outside Space (an SMTP script's Bcc) that reached a connected
     * account from one of the owner's addresses: an account, a send-as alias or their own domain). SENT names the first that no bounce for its
     * addresses followed, BOUNCED when every one bounced; null: none logged (a send outside Space with no copy in a connected account).
     */
    async sentTo(owner: string, account: string | null, recipients: string[], since: string): Promise<{ state: "SENT" | "BOUNCED"; account: string; threadId: string; messageId: string | null } | null> {
      const scope = account ? { accountEmail: account.toLowerCase() } : {};
      const wanted = recipients.map((address) => address.toLowerCase());
      const domains = wanted.filter((address) => !SHARED_MAIL_DOMAIN.test(address)).map((address) => address.slice(address.indexOf("@")));
      const ours = (address: string) => wanted.includes(address) || domains.some((domain) => address.endsWith(domain));
      const [events, replies, received, own] = await Promise.all([repository.listEvents(owner, { ...scope, types: ["SENT"], since }),
        repository.listActions(owner, { ...scope, actions: ["REPLY", "FORWARD"], since }), repository.listEvents(owner, { ...scope, types: ["MAIL_RECEIVED"], since }), ownAddresses(owner)]);
      const ownDomains = [...own].filter((address) => !SHARED_MAIL_DOMAIN.test(address)).map((address) => address.slice(address.indexOf("@")));
      const fromUs = (event: MailCopilotEvent) => {
        const address = String((event.payload.from as { address?: string } | undefined)?.address ?? "").toLowerCase();
        // A copy Space synced late still dates its send by Gmail's receipt time.
        return (own.has(address) || ownDomains.some((domain) => address.endsWith(domain))) && !(Date.parse(String(event.payload.receivedAt ?? "")) < Date.parse(since));
      };
      const sends = [...events.concat(received.filter(fromUs)).filter((event) => event.accountEmail && event.threadId)
        .map((event) => ({ account: event.accountEmail!, threadId: event.threadId!, messageId: event.messageId, at: event.createdAt, to: addressesIn([event.payload.to, event.payload.cc]) })),
        ...replies.filter((row) => row.fromAddress).map((row) => ({ account: row.accountEmail, threadId: row.threadId, messageId: row.messageId, at: row.occurredAt, to: [row.fromAddress!.toLowerCase()] }))]
        .filter((send) => send.to.some(ours));
      for (const { at, to, ...send } of sends) {
        const after = await repository.listEvents(owner, { accountEmail: send.account, threadId: send.threadId, types: ["MAIL_RECEIVED"], since: at });
        if (!bouncedFor(after, [...to, ...wanted])) return { state: "SENT", ...send };
      }
      const [first] = sends;
      return first ? { state: "BOUNCED", account: first.account, threadId: first.threadId, messageId: first.messageId } : null;
    },
    async actionLog(owner: string, pane: Pane | null, input: { account?: string; source?: MailActionRecord["source"]; limit: number }): Promise<MailActionLogEntry[]> {
      const accounts = await mailAccounts(owner, pane, input.account ?? "all");
      const rows = (await repository.listActions(owner, { accountEmail: input.account, sources: input.source ? [input.source] : undefined, ...(input.account ? { limit: input.limit } : {}) }))
        .filter((row) => accounts.includes(row.accountEmail)).slice(0, input.limit);
      const names = new Map(await Promise.all([...new Set(rows.map((row) => row.accountEmail))].map(async (account) => [account, await labelNames(owner, account, rows.filter((row) => row.accountEmail === account))] as const)));
      return rows.map((row) => ({ ...row, labelNames: row.labelIds.map((label) => names.get(row.accountEmail)?.get(label) ?? label) }));
    },
    /** The Memory tab's "Learned habits": per account of the pane, the senders whose mail the operator handled themselves first (most, then newest), then the inferred ones. */
    async habitList(owner: string, pane: Pane | null): Promise<MailHabitSender[]> {
      const accounts = await mailAccounts(owner, pane, "all");
      const since = new Date(Date.parse(now()) - HABIT_WINDOW_MS).toISOString();
      const perAccount = await mapLimited(accounts, 3, async (account) => {
        const rows = (await repository.listActions(owner, { accountEmail: account, actors: ["OPERATOR"], since })).filter((row) => row.fromAddress);
        const names = await labelNames(owner, account, rows);
        const bySender = new Map<string, MailActionRecord[]>();
        for (const row of rows) bySender.set(row.fromAddress!, [...bySender.get(row.fromAddress!) ?? [], row]);
        return [...bySender].map(([sender, senderRows]): MailHabitSender => {
          const level = habitLevel("sender", sender, senderRows, names)!;
          return { account, sender, summary: habitWords(level, Infinity), level, lastAt: senderRows[0]!.occurredAt };
        }).sort((left, right) => observedOf(right) - observedOf(left) || right.lastAt.localeCompare(left.lastAt));
      });
      return perAccount.flat();
    },
    /** Forget a sender on one account: their rows leave the log and the rules learned from them are retired. */
    async forgetHabits(owner: string, pane: Pane | null, input: { account: string; sender: string }): Promise<{ forgotten: number; retired: number }> {
      await mailAccounts(owner, pane, input.account);
      const sender = input.sender.trim().toLowerCase();
      // Every row of the sender (until 31/10 the newest 5,000: "forget" left the older ones).
      const rows = await repository.listActions(owner, { accountEmail: input.account, fromAddress: sender });
      const forgotten = await repository.deleteActions(owner, rows.map((row) => row.id));
      const rules = (await repository.listRules(owner, { status: ["APPROVED"], accountEmail: input.account }))
        .filter((rule) => rule.proposedBy === "LEARNED" && rule.accountEmail === input.account && rule.condition.fromAddress === sender);
      for (const rule of rules) {
        await repository.updateRule(owner, rule.id, { status: "RETIRED", decidedAt: now() });
        await record(owner, { paneId: pane?.id ?? null, type: "RULE_RETIRED", accountEmail: input.account, message: `Rule retired: ${rule.name} (you asked the copilot to forget ${sender})`, payload: { ruleId: rule.id, name: rule.name, reason: "FORGOTTEN" } });
      }
      return { forgotten, retired: rules.length };
    },
    /** How the operator handled mail from this sender (and of this subject's shape) on one of the pane's accounts. */
    async habits(owner: string, pane: Pane | null, input: { account: string; from: string; subject?: string | null }): Promise<MailHabits> {
      await mailAccounts(owner, pane, input.account);
      return habitsFor(owner, input.account, input);
    },
    /** Drops action log rows older than a year (every owner). */
    pruneActions: () => repository.pruneActions(new Date(Date.parse(now()) - ACTION_RETENTION_MS).toISOString()),
    async waitForReview(owner: string, input: { reviewId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const decided = (await repository.listEvents(owner, { types: ["REVIEW_DECIDED"] })).find((event) => event.payload.reviewId === input.reviewId);
        if (decided) return { decided: true as const, decision: String(decided.payload.decision), note: decided.payload.note ?? null, sent: decided.payload.sent ?? null,
          ...(decided.payload.answered ? { answered: decided.payload.answered } : {}) };
        if (Date.now() >= deadline) return { decided: false as const, decision: null };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    now
  };
  function summarize(counters: MailCopilotRun["counters"]): string {
    return `${counters.taken} taken, ${counters.replied} replied, ${counters.drafted} drafted, ${counters.archived} archived, ${counters.fixed} fixed, ${counters.skipped} skipped, ${counters.needsUser} need you`;
  }
}
export type MailCopilotService = ReturnType<typeof createMailCopilotService>;
