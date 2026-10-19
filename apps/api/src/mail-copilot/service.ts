import { randomBytes } from "node:crypto";
import {
  MAIL_SYSTEM_LABELS, mailRuleMatches, mailSubjectKey, mailSubjectKeyPattern, mailThreadActionLabels, resolveMailCopilotPaneMetadata, type ConnectorCapability, type MailActionRecord, type MailOperatorAction, type MailRule, type MailRuleDecision, type MailRuleProposal, type MailRuleSubject, type MailAccountSummary, type MailComposeInput, type MailCopilotEvent,
  type MailCopilotEventInput, type MailCopilotEventType, type MailCopilotMemory, type MailCopilotMemoryCreate, type MailCopilotMemoryQuery, type MailCopilotMemoryUpdate,
  type MailActionLogEntry, type MailCopilotFixRequest, type MailFixRequestView, type MailCopilotPaneMetadata, type MailCopilotPendingItem, type MailHabitLevel, type MailHabits, type MailHabitSender, type MailCopilotReviewDecision, type MailCopilotRun, type MailCopilotRunView, type MailLabel,
  type MailMessage, type MailThread, type MailThreadAction, type MailThreadSummary, type MailThreadsPage, type MailThreadsQuery, type Pane
} from "@space/contracts";
import type { MailCopilotRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { GmailMailboxError } from "../job-apply/gmail-mailbox.js";
import { createGmailClient, mapLimited, type GmailClient, type GmailJson } from "./gmail-client.js";
import { classifyThreadChange, netThreadChanges, type GmailHistoryEntry } from "./history.js";
import type { MailCopilotKickoff } from "./kickoff.js";
import { buildMime, header, parseParticipants, parsePayload } from "./gmail-mime.js";
import { sanitizeMailHtml } from "./html-sanitizer.js";
import { decodeEntities } from "../job-apply/gmail-mailbox.js";

/** The owner's Google connector: every account allowed for Space and an access token per capability. */
export interface MailCopilotGoogleAccess {
  googleConfigured: boolean;
  googleAccounts(owner: string): Promise<Array<{ email: string; capabilities: ConnectorCapability[] }>>;
  googleAccessToken(owner: string, email: string, capability: ConnectorCapability): Promise<string>;
}

export interface MailCopilotServiceOptions {
  google(): MailCopilotGoogleAccess | null;
  gmailFetch?: typeof fetch;
  /** The copilot's memory, activity feed / work queue and runs. */
  repository: MailCopilotRepository;
  /** Every activity event, for the room stream and notifications. */
  onEvent?(event: MailCopilotEvent): void;
  /** Starts a run for new work nobody pressed Start for (a mail sent to the copilot to fix). */
  kickoff?: MailCopilotKickoff;
  now?(): string;
}

export interface MailEventContext { paneId?: string | null; runId?: string | null }
const NEXT_POLL_MS = 2_000;
const NEXT_MAX_WAIT_MS = 120_000;
/** A TAKEN item nobody reported for this long goes back to the queue (a crashed CLI). */
const TAKEN_STALE_MS = 30 * 60_000;
/** The backlog scan looks at this many newest inbox conversations per account. */
const BACKLOG_SCAN_LIMIT = 25;
/** Senders a copilot never answers on its own. */
const AUTOMATED_SENDER = /(^|[.<@-])(no-?reply|do-?not-?reply|noreply|notifications?|newsletter|mailer-daemon|postmaster|bounce)([.>@-]|$)/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const senderAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const senderDomain = (from: string) => senderAddress(from).split("@").at(-1)?.trim() ?? "";
/** A pane action and the operator action it is in the log. */
const LOGGED_ACTION: Partial<Record<MailThreadAction["action"], MailOperatorAction>> = {
  archive: "ARCHIVE", unarchive: "UNARCHIVE", trash: "TRASH", untrash: "UNTRASH", star: "STAR", unstar: "UNSTAR", label: "LABEL", unlabel: "UNLABEL", move: "MOVE"
};
/** An Undo within this window removes the operator's own action from the log instead of recording the reverse. */
const UNDO_WINDOW_MS = 15 * 60_000;
const UNDOES: Partial<Record<MailOperatorAction, MailOperatorAction>> = { UNARCHIVE: "ARCHIVE", UNTRASH: "TRASH", UNLABEL: "LABEL", UNSTAR: "STAR" };
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
export function habitWords(level: MailHabitLevel, limit = 4): string {
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
  const deciding = new Map<string, Promise<{ decision: MailCopilotReviewDecision["decision"]; sent: { messageId: string; threadId: string } | null }>>();

  async function record(owner: string, input: MailCopilotEventInput & MailEventContext & { type: MailCopilotEventType; status?: "PENDING" | "TAKEN" | "DONE" | null }): Promise<MailCopilotEvent> {
    const event = await repository.createEvent({
      ownerUserId: owner, paneId: input.paneId ?? null, runId: input.runId ?? null, accountEmail: input.accountEmail ?? null, threadId: input.threadId ?? null, messageId: input.messageId ?? null,
      type: input.type, status: input.status ?? null, message: input.message.slice(0, 1000), payload: input.payload ?? {}
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
  /** The pane's accounts with Gmail read access, or the one named; refuses an account outside the pane. */
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
      labelIds: [...labels].slice(0, 50)
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
      rfcMessageId: header(headers, "Message-ID").slice(0, 1000) || null, references: header(headers, "References").slice(0, 20_000) || null,
      labelIds: labelIds.slice(0, 50), unread: labelIds.includes("UNREAD"), starred: labelIds.includes("STARRED"),
      text: parsed.text, html: sanitized?.html ?? null, blockedImages: sanitized?.blockedImages ?? false, attachments: parsed.attachments
    };
  }

  const RULE_ACTION_FOR: Record<string, MailRule["action"]["type"]> = { send: "REPLY", archive: "ARCHIVE", label: "LABEL", move: "MOVE", trash: "TRASH", star: "STAR", read: "MARK_READ" };
  /**
   * ASSIST: the agent drafts and asks. RULES: only under an approved rule of the owner that names this action and
   * matches the message (the rule's use is recorded). FULL: on its own judgement.
   */
  type GateContext = { paneId: string | null; accountEmail: string | null; threadId: string | null; messageId?: string | null };
  async function authorize(owner: string, pane: Pane | null, action: string, ruleId: string | undefined, subject: () => Promise<MailRuleSubject | null>, context: GateContext, labelIds: readonly string[] = []): Promise<void> {
    const autonomy = paneSettings(pane).autonomy;
    if (autonomy === "FULL") return;
    if (autonomy === "ASSIST") throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: autonomy is Assist, so the copilot cannot ${action} on its own; ask with space_mail_review_request.`);
    if (!ruleId) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: autonomy is Rules; name the approved rule (ruleId) that covers ${action}, or ask with space_mail_review_request.`);
    const rule = await repository.getRule(owner, ruleId);
    if (!rule || rule.status !== "APPROVED") throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule ${ruleId} is not an approved rule of the operator.`);
    if (rule.accountEmail && context.accountEmail && rule.accountEmail !== context.accountEmail) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" belongs to ${rule.accountEmail}.`);
    if (rule.action.type !== RULE_ACTION_FOR[action]) throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" allows ${rule.action.type}, not ${action}.`);
    if ((rule.action.type === "LABEL" || rule.action.type === "MOVE") && (!labelIds.length || !labelIds.every((label) => rule.action.labels?.includes(label)))) {
      throw new SpaceConflictError(`MAIL_NEEDS_REVIEW: rule "${rule.name}" allows only the labels ${(rule.action.labels ?? []).join(", ") || "(none named)"}.`);
    }
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
  function correspondent(messages: GmailJson[], account: string): GmailJson | null {
    return [...messages].reverse().find((message) => senderAddress(header(headersOf(message), "From")) !== account) ?? messages.at(-1) ?? null;
  }
  /** One row of the per-account action log; a failed write never fails the action itself. */
  async function logAction(owner: string, input: { accountEmail: string; threadId: string; messageId?: string | null; action: MailOperatorAction; labelIds?: string[]; facts: Pick<MailRuleSubject, "from" | "subject"> | null;
    actor: MailActionRecord["actor"]; source: MailActionRecord["source"]; ruleId?: string | null; occurredAt?: string }): Promise<MailActionRecord | null> {
    const address = input.facts ? senderAddress(input.facts.from) : "";
    return repository.recordAction({ ownerUserId: owner, accountEmail: input.accountEmail, threadId: input.threadId, messageId: input.messageId ?? null, action: input.action, labelIds: (input.labelIds ?? []).slice(0, 20),
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
    const ignored = changes.some((change) => change.added.some((label) => label.startsWith("Label_")))
      ? new Set((await client.labels()).filter((label) => label.name.startsWith(JOB_COPILOT_LABEL_PREFIX)).map((label) => label.id)) : new Set<string>();
    const since = new Date(Date.parse(now()) - SPACE_WRITE_WINDOW_MS).toISOString();
    const logged = await mapLimited(changes, 4, async (change): Promise<number> => {
      const recent = await repository.listActions(owner, { accountEmail: email, threadId: change.threadId, since, limit: 50 });
      const fresh = classifyThreadChange(change, ignored).filter((entry) => !recent.some((row) => row.action === entry.action || (entry.action === "REPLY" && row.action === "FORWARD")));
      if (!fresh.length) return 0;
      let facts: MailRuleSubject | null = null;
      let messages: GmailJson[] = [];
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
        const message = correspondent(messages, email);
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
          const answered = messages.some((message) => senderAddress(header(headersOf(message), "From")) !== email);
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
      const message = correspondent(messages, email);
      // Conversations only of the operator's own mail say nothing about how they handle mail they receive.
      if (!message || senderAddress(header(headersOf(message), "From")) === email) return 0;
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
      sender.includes("@") ? repository.listActions(owner, { accountEmail: account, fromAddress: sender, actors: ["OPERATOR"], since, limit: 500 }) : Promise.resolve([]),
      domain ? repository.listActions(owner, { accountEmail: account, fromDomain: domain, actors: ["OPERATOR"], since, limit: 500 }) : Promise.resolve([])
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
      examples: bySender.slice(0, 5).map((row) => ({ action: row.action, subject: row.subject, source: row.source, at: row.occurredAt }))
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
    const rows = (await repository.listActions(owner, { accountEmail: row.accountEmail, fromAddress: row.fromAddress, actors: ["OPERATOR"], since, limit: 500 })).filter((entry) => entry.source !== "BACKFILL");
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
    const waiting = await repository.listEvents(owner, { accountEmail: account, threadId, types: ["MAIL_RECEIVED", "TRIAGE"], status: ["PENDING"], limit: 20 });
    for (const item of waiting) await repository.setItemStatus(owner, item.id, "DONE");
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
    const [questions, answers] = await Promise.all([repository.listEvents(owner, { types: ["QUESTION"], since: item.createdAt, limit: 100 }), repository.listEvents(owner, { types: ["ANSWERED"], since: item.createdAt, limit: 100 })]);
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
        await mapLimited(labels.filter((label) => label.id === "INBOX" || label.type === "user").slice(0, 40), 6, async (label) => { unread.set(label.id, await client.labelUnread(label.id)); });
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
          return (await Promise.all(threads.map((thread) => threadSummary(email, thread)))).filter((thread): thread is MailThreadSummary => Boolean(thread));
        } catch (error) {
          errors.push({ account: email, message: gmailError(email, error).message.slice(0, 300) });
          return [];
        }
      });
      const threads = pages.flat().sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""));
      return { threads: query.account === "all" ? threads.slice(0, query.max) : threads, nextPageToken: encodeCursor(nextCursors), errors };
    },
    /** A thread with every message: text for the agent, sanitized HTML for the reader, attachments to download. */
    async thread(owner: string, pane: Pane | null, account: string, threadId: string, loadImages = false): Promise<MailThread> {
      const [email] = await mailAccounts(owner, pane, account);
      const client = await clientFor(owner, email!);
      const thread = await client.thread(threadId, "full").catch((error) => { throw gmailError(email!, error); });
      const messages = ((thread.messages as GmailJson[] | undefined) ?? []).map((message) => toMessage(email!, message, loadImages));
      if (!messages.length) throw new SpaceNotFoundError(`Thread ${threadId} was not found.`);
      return { account: email!, threadId, subject: messages[0]!.subject, messages };
    },
    /**
     * Archive, trash, star, read, labels and a move to a label on a whole thread (full access). The agent is held to
     * the pane's autonomy. Everything but read marks lands in the account's action log, which the copilot learns from.
     */
    async modify(owner: string, pane: Pane | null, threadId: string, rawInput: MailThreadAction, by: "operator" | "agent" = "operator", ruleId?: string): Promise<void> {
      await mailAccounts(owner, pane, rawInput.account);
      const client = await clientFor(owner, rawInput.account, "MAIL_ORGANIZE");
      const input: MailThreadAction = rawInput.labelIds?.length ? { ...rawInput, labelIds: await resolveLabelIds(client, rawInput.labelIds).catch((error) => { throw gmailError(rawInput.account, error); }) } : rawInput;
      const context = { paneId: pane?.id ?? null, accountEmail: input.account, threadId };
      const logged = LOGGED_ACTION[input.action];
      let facts: Promise<MailRuleSubject | null> | null = null;
      const subject = () => facts ??= client.thread(threadId, "metadata").then((thread) => {
        const message = correspondent((thread.messages as GmailJson[] | undefined) ?? [], input.account);
        return message ? ruleSubject(message) : null;
      }, (error: unknown) => { throw gmailError(input.account, error); });
      if (by === "agent" && input.action !== "read" && input.action !== "unread" && input.action !== "star" && input.action !== "unstar") {
        await authorize(owner, pane, input.action, ruleId, subject, context, input.labelIds);
      }
      try {
        if (input.action === "trash" || input.action === "untrash") await client.trashThread(threadId, input.action === "untrash");
        else {
          const change = mailThreadActionLabels(input);
          if (!change.addLabelIds.length && !change.removeLabelIds.length) throw new SpaceConflictError("Name the labels to add or remove.");
          await client.modifyThread(threadId, change);
        }
      } catch (error) {
        throw gmailError(input.account, error);
      }
      if (!logged) return;
      // The operator's Undo takes their own action back out of the log; it was never a habit.
      const undone = by === "operator" ? UNDOES[logged] : undefined;
      if (undone) {
        const since = new Date(Date.parse(now()) - UNDO_WINDOW_MS).toISOString();
        const recent = (await repository.listActions(owner, { accountEmail: input.account, threadId, actions: [undone], since, limit: 1 }).catch(() => []))[0];
        if (recent?.actor === "OPERATOR" && (undone !== "LABEL" || recent.labelIds.some((label) => input.labelIds?.includes(label)))) {
          await repository.deleteActions(owner, [recent.id]).catch(() => 0);
          return;
        }
      }
      const row = await logAction(owner, { accountEmail: input.account, threadId, action: logged, labelIds: input.labelIds, facts: await subject().catch(() => null), actor: by === "agent" ? "AGENT" : "OPERATOR", source: "PANE", ruleId });
      if (row) await learnRules(owner, row, pane?.id ?? null).catch(() => undefined);
      if (by === "operator" && HANDLES_MAIL.has(logged)) await closeHandledItems(owner, input.account, threadId).catch(() => undefined);
    },
    /** Sends a new message, a reply or a forward from one of the pane's accounts; replies carry the threading headers. The agent is held to the pane's autonomy and the hourly cap. */
    async send(owner: string, pane: Pane | null, input: MailComposeInput, by: "operator" | "agent" | "review" = "operator", ruleId?: string): Promise<{ messageId: string; threadId: string }> {
      await mailAccounts(owner, pane, input.account);
      const client = await clientFor(owner, input.account, "MAIL_ORGANIZE");
      const original = input.inReplyToMessageId ? await client.message(input.inReplyToMessageId, "metadata").catch((error) => { throw gmailError(input.account, error); }) : null;
      if (by === "agent") {
        if (input.to.some((address) => AUTOMATED_SENDER.test(address))) throw new SpaceConflictError("That address is an automated sender; the copilot never replies to it.");
        await authorize(owner, pane, "send", ruleId, async () => original ? ruleSubject(original) : null, { paneId: pane?.id ?? null, accountEmail: input.account, threadId: input.threadId ?? null, messageId: input.inReplyToMessageId ?? null });
        const cap = paneSettings(pane).sendsPerHour;
        const sentLastHour = await repository.listEvents(owner, { types: ["SENT"], since: new Date(Date.parse(now()) - 3_600_000).toISOString(), limit: 500 });
        if (sentLastHour.length >= cap) throw new SpaceConflictError(`The pane's cap of ${cap} sends per hour is reached; ask the operator or wait.`);
      }
      const headers = (original?.payload as { headers?: unknown } | undefined)?.headers;
      const inReplyTo = header(headers, "Message-ID") || null;
      const references = header(headers, "References") || null;
      const raw = buildMime({ from: input.account, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, inReplyTo, references });
      let sent: { id: string; threadId: string };
      try {
        sent = await client.send(raw, input.threadId);
      } catch (error) {
        throw gmailError(input.account, error);
      }
      await record(owner, { paneId: pane?.id ?? null, type: "SENT", accountEmail: input.account, threadId: sent.threadId, messageId: sent.id,
        message: `${by === "agent" ? "The copilot sent" : "You sent"}: ${input.subject || "(no subject)"} → ${input.to.join(", ")}`, payload: { by, to: input.to, cc: input.cc, reply: Boolean(input.inReplyToMessageId) } });
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
      const raw = buildMime({ from: input.account, to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text,
        inReplyTo: header(headers, "Message-ID") || null, references: header(headers, "References") || null });
      try {
        const draft = await client.createDraft(raw, input.threadId);
        return { draftId: draft.id, messageId: draft.messageId };
      } catch (error) {
        throw gmailError(input.account, error);
      }
    },
    /** One attachment's bytes and type, for download or inline display. */
    async attachment(owner: string, pane: Pane | null, account: string, messageId: string, attachmentId: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
      const [email] = await mailAccounts(owner, pane, account);
      const client = await clientFor(owner, email!);
      try {
        const message = await client.message(messageId, "full");
        const meta = parsePayload(message.payload as Record<string, unknown> | undefined).attachments.find((entry) => entry.attachmentId === attachmentId);
        if (!meta) throw new SpaceNotFoundError("Attachment was not found.");
        return { data: await client.attachment(messageId, attachmentId), filename: meta.filename, mimeType: meta.mimeType };
      } catch (error) {
        throw gmailError(email!, error);
      }
    },
    record,
    // ---- memory -------------------------------------------------------------------------------
    listMemory: (owner: string, query: MailCopilotMemoryQuery) => repository.listMemory(owner, query),
    /** Recall before drafting: the memories about the sender, their domain and the subject, counted as used. */
    async recallMemory(owner: string, input: { query?: string; contactEmail?: string; domain?: string; kinds?: MailCopilotMemory["kind"][]; limit?: number }): Promise<MailCopilotMemory[]> {
      const scoped = await repository.listMemory(owner, { query: input.query, kinds: input.kinds, contactEmail: input.contactEmail, domain: input.domain, limit: input.limit ?? 20 });
      const pinned = await repository.listMemory(owner, { pinnedOnly: true, kinds: input.kinds, limit: 20 });
      const merged = [...new Map([...pinned, ...scoped].map((memory) => [memory.id, memory])).values()];
      await repository.touchMemories(owner, merged.map((memory) => memory.id));
      return merged;
    },
    rememberMemory: (owner: string, input: MailCopilotMemoryCreate) => repository.upsertMemory({ ownerUserId: owner, kind: input.kind, key: input.key ?? null, text: input.text, contactEmail: input.contactEmail ?? null,
      domain: input.domain ?? null, accountEmail: input.accountEmail ?? null, tags: input.tags, source: input.source, confidence: input.confidence, pinned: input.pinned }),
    updateMemory: (owner: string, id: string, patch: MailCopilotMemoryUpdate) => repository.updateMemory(owner, id, patch),
    forgetMemory: (owner: string, id: string) => repository.deleteMemory(owner, id),
    listEvents: (owner: string, filter: { paneId?: string; threadId?: string; since?: string; limit: number }) => repository.listEvents(owner, filter),
    // ---- runs and the work loop ---------------------------------------------------------------
    async pendingItems(owner: string, paneId: string | null): Promise<MailCopilotPendingItem[]> {
      const events = await repository.listEvents(owner, { paneId, types: ["QUESTION", "ANSWERED", "REVIEW_REQUESTED", "REVIEW_DECIDED"], limit: 300 });
      const done = new Set(events.filter((event) => event.type === "ANSWERED" || event.type === "REVIEW_DECIDED").map((event) => String(event.payload.questionId ?? event.payload.reviewId ?? "")));
      return events.filter((event) => (event.type === "QUESTION" && !done.has(String(event.payload.questionId))) || (event.type === "REVIEW_REQUESTED" && !done.has(String(event.payload.reviewId))))
        .map((event) => ({ id: String(event.type === "QUESTION" ? event.payload.questionId : event.payload.reviewId), kind: event.type === "QUESTION" ? "QUESTION" as const : "REVIEW" as const, eventId: event.id,
          accountEmail: event.accountEmail, threadId: event.threadId, message: event.message, payload: event.payload, createdAt: event.createdAt })).slice(0, 100);
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
    async markKickoff(owner: string, runId: string): Promise<void> { await repository.updateRun(owner, runId, { kickoffSentAt: now() }); },
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
    /** Untriaged inbox conversations of the pane's accounts within the backlog window become TRIAGE items, once per thread. */
    async scanBacklog(owner: string, pane: Pane, runId: string | null): Promise<number> {
      const settings = paneSettings(pane);
      const since = Date.parse(now()) - settings.backlogHours * 3_600_000;
      const page = await this.threads(owner, pane, { account: "all", labelId: "INBOX", max: BACKLOG_SCAN_LIMIT });
      let created = 0;
      for (const thread of page.threads) {
        if (!thread.receivedAt || Date.parse(thread.receivedAt) < since || AUTOMATED_SENDER.test(thread.from.address)) continue;
        const seen = await repository.listEvents(owner, { accountEmail: thread.account, threadId: thread.threadId, types: ["TRIAGE", "MAIL_RECEIVED", "TRIAGED", "REPLIED", "DRAFTED", "ARCHIVED", "TRASHED", "LABELED", "SKIPPED", "NEEDS_USER"], limit: 1 });
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
      return { thread: thread ? { ...thread, messages: thread.messages.map((message) => ({ ...message, html: null })) } : null, memories, habits };
    },
    async reportItem(owner: string, pane: Pane, input: { eventId: string; outcome: "replied" | "drafted" | "archived" | "labeled" | "skipped" | "needs_user" | "learned" | "fixed"; summary: string; memoryIds: string[] }) {
      const item = await repository.getEvent(owner, input.eventId);
      if (!item || item.status === null) throw new SpaceNotFoundError(`Work item ${input.eventId} was not found.`);
      if (item.status === "DONE") throw new SpaceConflictError("That item was already reported.");
      await repository.setItemStatus(owner, item.id, "DONE");
      const run = await repository.getActiveRun(pane.id);
      const counterKey = { replied: "replied", drafted: "drafted", archived: "archived", labeled: "labeled", skipped: "skipped", needs_user: "needsUser", learned: "skipped", fixed: "fixed" }[input.outcome] as keyof MailCopilotRun["counters"];
      if (run && run.ownerUserId === owner) await repository.updateRun(owner, run.id, { counters: { ...run.counters, [counterKey]: run.counters[counterKey] + 1 }, currentEventId: null, lastActivityAt: now() });
      const type: MailCopilotEventType = { replied: "REPLIED", drafted: "DRAFTED", archived: "ARCHIVED", labeled: "LABELED", skipped: "SKIPPED", needs_user: "NEEDS_USER", learned: "TRIAGED", fixed: "FIXED" }[input.outcome] as MailCopilotEventType;
      await repository.touchMemories(owner, input.memoryIds);
      // A fixed hand-off teaches the copilot how this kind of mail is fixed, with what the operator asked and decided.
      const lesson = item.type === "FIX_REQUESTED" && input.outcome === "fixed" ? await rememberFix(owner, item, input.summary).catch(() => null) : null;
      return record(owner, { paneId: pane.id, runId: run?.id ?? null, type, accountEmail: item.accountEmail, threadId: item.threadId, messageId: item.messageId, message: input.summary,
        payload: { itemId: item.id, outcome: input.outcome, memoryIds: input.memoryIds, ...(lesson ? { lessonMemoryId: lesson.id } : {}) } });
    },
    // ---- questions and reviews ---------------------------------------------------------------
    async askQuestion(owner: string, pane: Pane, input: { question: string; options?: string[]; accountEmail?: string; threadId?: string }) {
      // The same question still open in this pane (an agent's retry) is the same card, never a second one.
      const open = (await this.pendingItems(owner, pane.id)).find((item) => item.kind === "QUESTION" && item.payload.question === input.question && item.threadId === (input.threadId ?? null));
      if (open) return { questionId: open.id, answered: false as const };
      const questionId = `mailq:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, type: "QUESTION", accountEmail: input.accountEmail ?? null, threadId: input.threadId ?? null, message: `Needs you: ${input.question}`,
        payload: { questionId, question: input.question, options: input.options ?? [] } });
      return { questionId, answered: false as const };
    },
    /** by NOUS: Nous, the mind of SpaceApp, answered for the operator (its answer is the agent's memory, not the operator's voice). */
    async answerQuestion(owner: string, pane: Pane, input: { questionId: string; answer: string }, by: "USER" | "NOUS" = "USER") {
      const events = await repository.listEvents(owner, { types: ["QUESTION"], limit: 300 });
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
        const answered = (await repository.listEvents(owner, { types: ["ANSWERED"], limit: 300 })).find((event) => event.payload.questionId === input.questionId);
        if (answered) return { answered: true as const, answer: String(answered.payload.answer ?? ""), answeredAt: answered.createdAt };
        if (Date.now() >= deadline) return { answered: false as const, answer: null };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    /** The agent's reply waits for the operator: approve (the server sends it), edit (sends the edit, learns the difference) or reject. */
    async requestReview(owner: string, pane: Pane, input: { draft: MailComposeInput; summary: string; reasoning?: string }) {
      await mailAccounts(owner, pane, input.draft.account);
      const reviewId = `mailrev:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, type: "REVIEW_REQUESTED", accountEmail: input.draft.account, threadId: input.draft.threadId ?? null, messageId: input.draft.inReplyToMessageId ?? null,
        message: `Review: ${input.summary}`, payload: { reviewId, draft: input.draft, reasoning: input.reasoning ?? null } });
      return { reviewId };
    },
    /**
     * One decision and one Gmail send per review (stable 2026-10-17: one approval went to Hetzner twice, 9 s apart): a decided
     * review answers its recorded decision, and a decision already running is shared by the calls that arrive meanwhile.
     * shortcut: the in-flight guard is per process; the API runs one, a second process would need a database claim.
     */
    async decideReview(owner: string, pane: Pane, input: MailCopilotReviewDecision) {
      const key = `${owner}\u0000${input.reviewId}`;
      const running = deciding.get(key);
      if (running) return running;
      const decision = this.decideReviewOnce(owner, pane, input).finally(() => deciding.delete(key));
      deciding.set(key, decision);
      return decision;
    },
    async decideReviewOnce(owner: string, pane: Pane, input: MailCopilotReviewDecision) {
      const decided = (await repository.listEvents(owner, { types: ["REVIEW_DECIDED"], limit: 300 })).find((event) => event.payload.reviewId === input.reviewId);
      if (decided) return { decision: decided.payload.decision as MailCopilotReviewDecision["decision"], sent: (decided.payload.sent ?? null) as { messageId: string; threadId: string } | null };
      const review = (await repository.listEvents(owner, { types: ["REVIEW_REQUESTED"], limit: 300 })).find((event) => event.payload.reviewId === input.reviewId);
      if (!review) throw new SpaceNotFoundError("The review was not found.");
      const draft = review.payload.draft as MailComposeInput;
      let sent: { messageId: string; threadId: string } | null = null;
      if (input.decision !== "reject") {
        const text = input.decision === "edit" && input.text !== undefined ? input.text : draft.text;
        sent = await this.send(owner, pane, { ...draft, text }, "review");
        if (input.decision === "edit" && text !== draft.text) {
          await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, text: `For "${draft.subject.slice(0, 120)}" to ${draft.to.join(", ")} the operator changed the reply. Copilot draft:\n${draft.text.slice(0, 1200)}\n\nOperator's version:\n${text.slice(0, 1200)}`,
            contactEmail: draft.to[0] ?? null, domain: draft.to[0] ? senderDomain(draft.to[0]) : null, accountEmail: draft.account, tags: ["review-edit"], source: "LEARNED", confidence: 0.7, pinned: false });
        }
      }
      await record(owner, { paneId: pane.id, type: "REVIEW_DECIDED", accountEmail: review.accountEmail, threadId: review.threadId, messageId: sent?.messageId ?? null,
        message: input.decision === "approve" ? "You approved the reply; it was sent" : input.decision === "edit" ? "You edited the reply; your version was sent" : `You rejected the reply${input.note ? `: ${input.note}` : ""}`,
        payload: { reviewId: input.reviewId, decision: input.decision, note: input.note ?? null, sent } });
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
    async decideRule(owner: string, pane: Pane | null, id: string, input: MailRuleDecision): Promise<MailRule> {
      const rule = await repository.getRule(owner, id);
      if (!rule) throw new SpaceNotFoundError("The rule was not found.");
      const status = ({ approve: "APPROVED", reject: "REJECTED", retire: "RETIRED" } as const)[input.decision];
      const updated = (await repository.updateRule(owner, id, { status, decidedAt: now() }))!;
      // The decision lands in the pane that proposed the rule (that is where the notification and the Activity live).
      const proposal = (await repository.listEvents(owner, { types: ["RULE_PROPOSED"], limit: 300 })).find((event) => event.payload.ruleId === id);
      await record(owner, { paneId: pane?.id ?? proposal?.paneId ?? null, type: "RULE_DECIDED", accountEmail: rule.accountEmail, message: `You ${input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "retired"} the rule: ${rule.name}`, payload: { ruleId: rule.id, decision: input.decision } });
      return updated;
    },
    // ---- new-mail sync ------------------------------------------------------------------------
    /**
     * Reads what arrived in one account's inbox since the last history id: every new message becomes a MAIL_RECEIVED
     * event (a work item unless the sender is automated). The first sync only records where to start; an expired
     * history id (Gmail keeps about a week) restarts from now with a SYNC_RESET note.
     */
    async syncAccount(owner: string, pane: Pane, email: string): Promise<{ created: number; reset: boolean; learned: number }> {
      const state = await repository.getSyncState(owner, email);
      const client = await clientFor(owner, email);
      const restart = async () => repository.setSyncState(owner, email, { historyId: (await client.profile()).historyId || null, lastSyncedAt: now(), lastError: null, consecutiveFailures: 0 });
      // The first look at the mailbox runs alongside the sync until it read the last 30 days; a failed step is retried next tick.
      const backfill = async () => state?.backfillDoneAt ? 0 : backfillStep(owner, email, client, state?.backfillPageToken ?? null).catch(() => 0);
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
        let created = 0;
        // New mail like the mail the operator keeps sending to the copilot to fix goes to the copilot on its own (a learned or written FIX rule).
        const fixRules = added.size ? (await repository.listRules(owner, { status: ["APPROVED"], accountEmail: email })).filter((rule) => rule.action.type === "FIX" && (rule.accountEmail === null || rule.accountEmail === email)) : [];
        for (const { id, threadId } of added.values()) {
          const seen = await repository.listEvents(owner, { accountEmail: email, threadId, types: ["MAIL_RECEIVED"], limit: 50 });
          if (seen.some((event) => event.messageId === id)) continue;
          const message = await client.message(id, "metadata");
          const facts = ruleSubject(message);
          const from = parseParticipants(facts.from)[0] ?? { name: "", address: "" };
          const automated = AUTOMATED_SENDER.test(from.address);
          const fixRule = fixRules.find((rule) => mailRuleMatches(rule.condition, facts));
          await record(owner, { paneId: pane.id, type: "MAIL_RECEIVED", status: automated || fixRule ? null : "PENDING", accountEmail: email, threadId, messageId: id,
            message: `New mail: ${facts.subject || "(no subject)"} from ${from.name || from.address}`,
            payload: { from, subject: facts.subject, snippet: decodeEntities(String(message.snippet ?? "")).slice(0, 500), labelIds: facts.labelIds, receivedAt: iso(message.internalDate), automated } });
          if (fixRule) {
            await this.requestFix(owner, pane, { account: email, threadId, messageId: id, by: "rule", ruleId: fixRule.id, ruleName: fixRule.name, facts });
            fixRule.appliedCount += 1;
            await repository.updateRule(owner, fixRule.id, { appliedCount: fixRule.appliedCount, lastAppliedAt: now() });
          }
          created += 1;
        }
        const learned = await learnFromHistory(owner, email, client, entries, pane.id) + await backfill();
        await repository.setSyncState(owner, email, { historyId: latest, lastSyncedAt: now(), lastError: null, consecutiveFailures: 0 });
        return { created, reset: false, learned };
      } catch (error) {
        if (error instanceof GmailMailboxError && error.status === 404) {
          await restart();
          await record(owner, { paneId: pane.id, type: "SYNC_RESET", accountEmail: email, message: `${email}: Gmail's history expired; new mail is followed from now on` });
          return { created: 0, reset: true, learned: 0 };
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
      const facts = input.facts !== undefined ? input.facts : await clientFor(owner, input.account).then((client) => client.thread(input.threadId, "metadata")).then((thread) => {
        const message = correspondent((thread.messages as GmailJson[] | undefined) ?? [], input.account);
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
    async autostart(owner: string, pane: Pane): Promise<boolean> {
      // Hand-offs sent back to back share one start: a second kickoff would type the run's prompt into the CLI twice.
      const pending = starting.get(pane.id);
      if (pending) return pending;
      const start = this.startOnce(owner, pane).finally(() => starting.delete(pane.id));
      starting.set(pane.id, start);
      return start;
    },
    async startOnce(owner: string, pane: Pane): Promise<boolean> {
      if (!options.kickoff || paneSettings(pane).paused) return false;
      const active = await repository.getActiveRun(pane.id);
      if (active?.status === "PAUSED" || (active && active.ownerUserId !== owner) || !(await options.kickoff.ready(pane))) return false;
      const started = await this.startRun(owner, pane.id);
      if (started.kickoff) {
        await options.kickoff.send(pane, started.run);
        await this.markKickoff(owner, started.run.id);
      }
      return true;
    },
    syncState: (owner: string, email: string) => repository.getSyncState(owner, email),
    /** Every mail sent to the copilot to fix (Activity → Sent to AI), newest first: the request, the questions and answers, and the result. */
    async fixRequests(owner: string, pane: Pane | null, limit = 50): Promise<MailFixRequestView[]> {
      const accounts = await mailAccounts(owner, pane, "all");
      const requests = (await repository.listEvents(owner, { types: ["FIX_REQUESTED"], limit: 200 })).filter((event) => !event.accountEmail || accounts.includes(event.accountEmail)).slice(0, limit);
      if (!requests.length) return [];
      const since = requests.at(-1)!.createdAt;
      const [reports, questions, answers] = await Promise.all([
        repository.listEvents(owner, { types: ["FIXED", "NEEDS_USER", "SKIPPED", "REPLIED", "DRAFTED", "ARCHIVED", "LABELED", "TRIAGED"], since, limit: 500 }),
        repository.listEvents(owner, { types: ["QUESTION"], since, limit: 500 }),
        repository.listEvents(owner, { types: ["ANSWERED"], since, limit: 500 })
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
    async actionLog(owner: string, pane: Pane | null, input: { account?: string; source?: MailActionRecord["source"]; limit: number }): Promise<MailActionLogEntry[]> {
      const accounts = await mailAccounts(owner, pane, input.account ?? "all");
      const rows = (await repository.listActions(owner, { accountEmail: input.account, sources: input.source ? [input.source] : undefined, limit: input.account ? input.limit : 500 }))
        .filter((row) => accounts.includes(row.accountEmail)).slice(0, input.limit);
      const names = new Map(await Promise.all([...new Set(rows.map((row) => row.accountEmail))].map(async (account) => [account, await labelNames(owner, account, rows.filter((row) => row.accountEmail === account))] as const)));
      return rows.map((row) => ({ ...row, labelNames: row.labelIds.map((label) => names.get(row.accountEmail)?.get(label) ?? label) }));
    },
    /** The Memory tab's "Learned habits": per account of the pane, the senders whose mail the operator handled themselves first (most, then newest), then the inferred ones. */
    async habitList(owner: string, pane: Pane | null): Promise<MailHabitSender[]> {
      const accounts = await mailAccounts(owner, pane, "all");
      const since = new Date(Date.parse(now()) - HABIT_WINDOW_MS).toISOString();
      const perAccount = await mapLimited(accounts, 3, async (account) => {
        const rows = (await repository.listActions(owner, { accountEmail: account, actors: ["OPERATOR"], since, limit: 2000 })).filter((row) => row.fromAddress);
        const names = await labelNames(owner, account, rows);
        const bySender = new Map<string, MailActionRecord[]>();
        for (const row of rows) bySender.set(row.fromAddress!, [...bySender.get(row.fromAddress!) ?? [], row]);
        return [...bySender].map(([sender, senderRows]): MailHabitSender => {
          const level = habitLevel("sender", sender, senderRows, names)!;
          return { account, sender, summary: habitWords(level, 3), level, lastAt: senderRows[0]!.occurredAt };
        }).sort((left, right) => observedOf(right) - observedOf(left) || right.lastAt.localeCompare(left.lastAt)).slice(0, 50);
      });
      return perAccount.flat();
    },
    /** Forget a sender on one account: their rows leave the log and the rules learned from them are retired. */
    async forgetHabits(owner: string, pane: Pane | null, input: { account: string; sender: string }): Promise<{ forgotten: number; retired: number }> {
      await mailAccounts(owner, pane, input.account);
      const sender = input.sender.trim().toLowerCase();
      const rows = await repository.listActions(owner, { accountEmail: input.account, fromAddress: sender, limit: 5000 });
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
        const decided = (await repository.listEvents(owner, { types: ["REVIEW_DECIDED"], limit: 300 })).find((event) => event.payload.reviewId === input.reviewId);
        if (decided) return { decided: true as const, decision: String(decided.payload.decision), note: decided.payload.note ?? null, sent: decided.payload.sent ?? null };
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
