import { randomBytes } from "node:crypto";
import {
  effectiveFreelanceAutonomy, freelanceChannelAlias, freelanceChannelSettings, FREELANCE_CHANNEL_LABELS, FREELANCE_CHANNELS, freelanceChannelOfSender, freelanceMailboxConfigSchema, freelanceRuleMatches,
  freelanceScamSignals, freelanceUrlMatchesChannel, freelanceWordingIssues, resolveFreelanceCopilotPaneMetadata,
  type FreelanceAccount, type FreelanceAccountUpdate, type FreelanceChannel, type FreelanceEvent, type FreelanceEventType, type FreelanceFunnel, type FreelanceLead, type FreelanceLeadCreate,
  type FreelanceLeadDecision, type FreelanceLeadUpdate, type FreelanceMailboxInput, type FreelanceMemoryCreate, type FreelanceMemoryQuery, type FreelanceMessage, type FreelanceMessageCreate,
  type FreelanceMessageReviewDecision, type FreelanceMessageUpdate, type FreelancePendingItem, type FreelanceRule, type FreelanceRuleProposal, type FreelanceRun, type FreelanceRunView, type Pane
} from "@space/contracts";
import type { FreelanceCopilotRepository } from "@space/db";
import type { RailAnswerBy } from "@space/db";
import { forbiddenByMemoryText, forbiddingMemory, MEMORY_HITS_NOTE, questionMemoryHits } from "@space/db";
import type { PinnedMemoryHit } from "../nous/operator-facts.js";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { operatorOrder, operatorOrderOverride, type OperatorMessageRefs } from "../copilot-operator-order.js";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { extractCode, extractLinksFromText, isReportSender, type MailboxFactory, type MailboxReader } from "../job-apply/mailbox.js";

export interface FreelanceCopilotServiceOptions {
  /** Leads, messages, accounts, memory, activity, runs, rules and the mailbox. */
  repository: FreelanceCopilotRepository;
  /** Seals the mailbox password; only the server opens it. */
  crypto: ConnectorCrypto;
  /** Opens the IMAP mailbox (the Job Copilot reader). */
  mailboxes: MailboxFactory;
  /** Every activity event, for the room stream and notifications. */
  onEvent?(event: FreelanceEvent): void;
  now?(): string;
  /** Plan clipboard:7L5KyWp3kQsP step 3: the operator's pinned Space Memory entries sharing a question's words (their rules answer it). */
  operatorMemory?(question: string): Promise<PinnedMemoryHit[]>;
  /** The operator's messages to Nous: a review's operatorOrder is checked against them. */
  operatorMessages?: OperatorMessageRefs;
}

/** The owner's own freelance sites, set per instance (stable: deploy/space-api.service; review EXT-C-F18 R2). */
export function freelanceSite(env: NodeJS.ProcessEnv = process.env) {
  return { aliasDomain: env.SPACE_FREELANCE_ALIAS_DOMAIN?.trim() || null,
    linkHosts: (env.SPACE_FREELANCE_LINK_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) };
}

const NEXT_POLL_MS = 2_000;
const NEXT_MAX_WAIT_MS = 120_000;
/** A work item nobody reported for this long goes back to the queue (a crashed CLI). */
const TAKEN_STALE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const FOLLOW_UP_DAYS = [3, 4];
/** Six weeks without a contract: change niche or channel (Research Council stop rule). */
const STOP_RULE_MS = 42 * DAY_MS;
/** Where pollMail files DMARC reports (imapflow adds the server's namespace prefix). */
const REPORT_FOLDER = "DMARC";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface EventInput { paneId?: string | null; runId?: string | null; leadId?: string | null; messageId?: string | null; type: FreelanceEventType; status?: "PENDING" | "TAKEN" | "DONE" | null; message: string; payload?: Record<string, unknown> }

/**
 * Freelance Copilot: briefs and new mails become work items; the agent finds and qualifies leads, drafts
 * proposals and messages, and sends one only through `beginSend`, the one gate where the pane's settings apply:
 * the pane not paused, the channel on and under its daily cap, the Connects budget, the wording (no unqualified
 * claims; before a contract no contact or payment off the platform and no outside links; no hourly bid under the
 * floor), no scam signals on the lead, the client not handed to the operator yet, and the effective autonomy.
 * Whatever the operator approved goes out. When a client wants to go ahead the lead becomes CLIENT_READY and the
 * operator takes over.
 */
export function createFreelanceCopilotService(options: FreelanceCopilotServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const { repository } = options;
  const settingsOf = (pane: Pane | null) => resolveFreelanceCopilotPaneMetadata(pane?.mode === "FREELANCE_COPILOT" ? pane.freelanceCopilotMetadata : null).settings;
  const ago = (ms: number) => new Date(Date.parse(now()) - ms).toISOString();
  const later = (ms: number) => new Date(Date.parse(now()) + ms).toISOString();

  async function record(owner: string, input: EventInput): Promise<FreelanceEvent> {
    const event = await repository.createEvent({ ownerUserId: owner, paneId: input.paneId ?? null, runId: input.runId ?? null, leadId: input.leadId ?? null, messageId: input.messageId ?? null,
      type: input.type, status: input.status ?? null, message: input.message, payload: input.payload ?? {} });
    try { options.onEvent?.(event); } catch { /* listeners never break the write */ }
    return event;
  }
  async function leadOf(owner: string, id: string): Promise<FreelanceLead> {
    const lead = await repository.getLead(owner, id);
    if (!lead) throw new SpaceNotFoundError(`Lead ${id} was not found.`);
    return lead;
  }
  async function messageOf(owner: string, id: string): Promise<FreelanceMessage> {
    const message = await repository.getMessage(owner, id);
    if (!message) throw new SpaceNotFoundError(`Message ${id} was not found.`);
    return message;
  }
  /** R12-5: a review or question the copilot's own memory forbids (scoped to the platform, or about the same words) is never raised. */
  async function refuseForbidden(owner: string, item: string, channel?: FreelanceMessage["channel"], itemIds: string[] = [], order?: string): Promise<string | undefined> {
    const memory = await forbiddingMemory((query) => repository.listMemory(owner, { query, kinds: ["FACT", "LESSON", "PREFERENCE", "CHANNEL_RULE", "CLIENT"], channel }), item,
      (found) => Boolean(channel && found.channel), itemIds);
    if (memory && !order) throw new SpaceConflictError(forbiddenByMemoryText("Freelance Copilot", memory));
    return memory && order ? operatorOrderOverride(order, memory.id) : undefined;
  }
  async function bumpRun(owner: string, paneId: string, counter: keyof FreelanceRun["counters"]): Promise<string | null> {
    const run = await repository.getActiveRun(paneId);
    if (!run || run.ownerUserId !== owner) return null;
    await repository.updateRun(owner, run.id, { counters: { ...run.counters, [counter]: run.counters[counter] + 1 }, lastActivityAt: now() });
    return run.id;
  }
  function issuesOf(pane: Pane | null, lead: FreelanceLead, message: Pick<FreelanceMessage, "body" | "bid">): string[] {
    const issues = freelanceWordingIssues(message.body, { channel: lead.channel, contracted: lead.status === "WON", bid: message.bid, rateFloorHourly: settingsOf(pane).rateFloorHourly, ownHosts: freelanceSite().linkHosts });
    if (Array.isArray(lead.payload.scamSignals) && lead.payload.scamSignals.length) issues.push("scam-signals");
    return issues;
  }
  const describe = (message: Pick<FreelanceMessage, "kind" | "channel">) => `${FREELANCE_CHANNEL_LABELS[message.channel]} ${message.kind.toLowerCase().replace("_", "-")}`;

  /** The sending gate (see the service comment); records a rule's use. Throws FREELANCE_* conflicts. */
  async function authorize(owner: string, pane: Pane, message: FreelanceMessage, lead: FreelanceLead): Promise<{ ruleId: string | null }> {
    const settings = settingsOf(pane);
    const label = FREELANCE_CHANNEL_LABELS[message.channel];
    if (settings.paused) throw new SpaceConflictError("FREELANCE_PAUSED: the pane is paused; nothing is sent until the operator resumes it.");
    const channel = freelanceChannelSettings(settings, message.channel);
    if (!channel.enabled) throw new SpaceConflictError(`FREELANCE_CHANNEL_OFF: ${label} is off in this pane's Setup.`);
    if (await repository.countSends(owner, message.channel, ago(DAY_MS)) >= channel.dailyCap) {
      throw new SpaceConflictError(`FREELANCE_LIMIT: ${label} allows ${channel.dailyCap} proposal(s) and message(s) a day; wait until the oldest of the last 24 hours ages out.`);
    }
    if (message.connects) {
      const { perDay, perMonth } = settings.connectsBudget;
      if (perDay > 0 && await repository.sumConnects(owner, ago(DAY_MS)) + message.connects > perDay) throw new SpaceConflictError(`FREELANCE_CONNECTS: the daily Connects budget (${perDay}) would be exceeded.`);
      if (perMonth > 0 && await repository.sumConnects(owner, ago(30 * DAY_MS)) + message.connects > perMonth) throw new SpaceConflictError(`FREELANCE_CONNECTS: the monthly Connects budget (${perMonth}) would be exceeded.`);
    }
    if (message.status === "APPROVED") return { ruleId: null };
    if (lead.status === "CLIENT_READY" || lead.status === "WON") throw new SpaceConflictError("FREELANCE_NEEDS_REVIEW: the operator has taken over this client; ask for a review with space_freelance_review_request.");
    const issues = issuesOf(pane, lead, message);
    if (issues.length) throw new SpaceConflictError(`FREELANCE_NEEDS_REVIEW: ${issues.join(", ")}; rewrite the message or ask for a review.`);
    const autonomy = effectiveFreelanceAutonomy(settings, message.channel);
    if (autonomy === "FULL") return { ruleId: null };
    if (autonomy === "ASSIST") throw new SpaceConflictError(`FREELANCE_NEEDS_REVIEW: autonomy on ${label} is Assist; ask for a review with space_freelance_review_request.`);
    const rule = (await repository.listRules(owner, ["APPROVED"])).find((candidate) => freelanceRuleMatches(candidate, message));
    if (!rule) throw new SpaceConflictError(`FREELANCE_NEEDS_REVIEW: autonomy on ${label} is Rules and no approved rule covers this ${message.kind.toLowerCase()}; ask for a review.`);
    await repository.updateRule(owner, rule.id, { appliedCount: rule.appliedCount + 1, lastAppliedAt: now() });
    await record(owner, { paneId: pane.id, leadId: lead.id, messageId: message.id, type: "RULE_APPLIED", message: `Rule "${rule.name}" let the copilot send on ${label}`, payload: { ruleId: rule.id } });
    return { ruleId: rule.id };
  }

  // ---- mailbox (the work mailbox) -----------------------------------------------------------------
  async function openMailbox(owner: string): Promise<MailboxReader> {
    const mailbox = await repository.getMailbox(owner);
    if (!mailbox) throw new SpaceConflictError("FREELANCE_MAILBOX: no mailbox is connected; the operator connects the work mailbox in the pane's Setup.");
    const context = connectorSealContext("freelance-mailbox", owner);
    const password = options.crypto.open(mailbox.passwordSealed, context);
    // A password sealed before the connector key (v1) is sealed again as v2 once read; without the key it stays as it is.
    if (mailbox.passwordSealed.startsWith("v1.")) {
      try { await repository.setMailbox(owner, { config: mailbox.config, passwordSealed: options.crypto.seal(password, context) }); } catch { /* stays v1 */ }
    }
    return options.mailboxes.open(mailbox.config, password);
  }
  async function withMailbox<T>(owner: string, read: (reader: MailboxReader) => Promise<T>): Promise<T> {
    const reader = await openMailbox(owner);
    try { return await read(reader); } finally { await reader.close().catch(() => undefined); }
  }
  async function pollUntil<T>(timeoutMs: number, attempt: () => Promise<T | null>): Promise<T | null> {
    const deadline = Date.now() + Math.min(timeoutMs, 180_000);
    for (;;) {
      const found = await attempt();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(8_000, Math.max(0, deadline - Date.now())));
    }
  }
  const sinceOf = (minutes: number | undefined) => ago((minutes ?? 30) * 60_000);

  async function followUpsDue(owner: string, pane: Pane | null): Promise<FreelanceLead[]> {
    const settings = settingsOf(pane);
    if (!settings.followUps) return [];
    return (await repository.listLeads(owner, { status: ["PROPOSED"], dueBefore: now() })).filter((lead) => freelanceChannelSettings(settings, lead.channel).enabled);
  }
  async function approvedDue(owner: string, pane: Pane | null): Promise<FreelanceMessage[]> {
    const settings = settingsOf(pane);
    const due: FreelanceMessage[] = [];
    for (const message of (await repository.listMessages(owner, { status: ["APPROVED"] })).reverse()) {
      if (!freelanceChannelSettings(settings, message.channel).enabled) continue;
      // 13/11 Dino/Emma (flmsg:OGcRFcyEljnY): a follow-up approved for later waits for its lead's follow-up time. Returned as SEND before it, it held
      // the run open with nothing the agent could do, so the agent stopped and the briefs that came after waited 13 h.
      const lead = message.kind === "FOLLOW_UP" ? await repository.getLead(owner, message.leadId) : null;
      if (lead?.nextActionAt && Date.parse(lead.nextActionAt) > Date.parse(now())) continue;
      due.push(message);
    }
    return due;
  }

  const service = {
    settingsOf,
    // ---- briefs (the operator's requests, the agent's work items) -----------------------------
    async createBrief(owner: string, pane: Pane | null, input: { text: string; leadId?: string | null; channels?: FreelanceChannel[]; /** R10-13: a brief Nous wrote. */ from?: "NOUS" }) {
      if (input.leadId) await leadOf(owner, input.leadId);
      return record(owner, { paneId: pane?.id ?? null, leadId: input.leadId ?? null, type: "BRIEF", status: "PENDING", message: input.text, payload: { text: input.text, channels: input.channels ?? [], ...(input.from ? { from: input.from } : {}) } });
    },
    // ---- leads --------------------------------------------------------------------------------
    listLeads: (owner: string, filter: Parameters<FreelanceCopilotRepository["listLeads"]>[1]) => repository.listLeads(owner, filter),
    getLead: leadOf,
    async leadDetail(owner: string, id: string) {
      return { lead: await leadOf(owner, id), messages: (await repository.listMessages(owner, { leadId: id })).reverse() };
    },
    /** A lead the agent found (or the operator added); the same platform id or URL on a channel returns the existing one. */
    async addLead(owner: string, pane: Pane | null, input: FreelanceLeadCreate, by: "AGENT" | "USER" = "AGENT") {
      const existing = await repository.findLead(owner, input.channel, { externalId: input.externalId ?? null, url: input.url ?? null });
      if (existing) return { lead: existing, duplicate: true, scamSignals: Array.isArray(existing.payload.scamSignals) ? existing.payload.scamSignals as string[] : [] };
      const scamSignals = freelanceScamSignals(`${input.title}\n${input.description ?? ""}`);
      const lead = await repository.createLead({ ownerUserId: owner, paneId: pane?.id ?? null, channel: input.channel, url: input.url ?? null, externalId: input.externalId ?? null, title: input.title,
        client: input.client ?? null, description: input.description ?? null, budget: input.budget ?? null, score: input.score ?? null, status: input.status, nextActionAt: null, contractValue: null,
        notes: input.notes ?? null, payload: { ...input.facts, ...(scamSignals.length ? { scamSignals } : {}), addedBy: by } });
      await record(owner, { paneId: pane?.id ?? null, leadId: lead.id, type: "LEAD_ADDED", message: `${by === "USER" ? "You added" : "Found"} a ${FREELANCE_CHANNEL_LABELS[lead.channel]} lead: ${lead.title}${scamSignals.length ? ` (scam signals: ${scamSignals.join(", ")})` : ""}`,
        payload: { status: lead.status, score: lead.score, scamSignals } });
      return { lead, duplicate: false, scamSignals };
    },
    async updateLead(owner: string, pane: Pane | null, id: string, patch: FreelanceLeadUpdate) {
      const current = await leadOf(owner, id);
      if (["CLIENT_READY", "WON"].includes(current.status) && patch.status) throw new SpaceConflictError("The operator has this client now; only the operator changes its status.");
      const { facts, ...rest } = patch;
      const lead = (await repository.updateLead(owner, id, { ...rest, ...(facts ? { payload: { ...current.payload, ...facts } } : {}) }))!;
      if (patch.status && patch.status !== current.status) {
        await record(owner, { paneId: pane?.id ?? null, leadId: id, type: "LEAD_UPDATED", message: `${FREELANCE_CHANNEL_LABELS[lead.channel]} lead "${lead.title}": ${current.status.toLowerCase()} → ${lead.status.toLowerCase()}`,
          payload: { from: current.status, to: lead.status } });
      }
      return lead;
    },
    /** The client wants to go ahead: the operator takes over (ATTENTION notification, Telegram when on). */
    async clientReady(owner: string, pane: Pane, input: { leadId: string; summary: string }) {
      const current = await leadOf(owner, input.leadId);
      if (["WON", "LOST"].includes(current.status)) throw new SpaceConflictError(`This lead is already ${current.status.toLowerCase()}.`);
      const lead = (await repository.updateLead(owner, input.leadId, { status: "CLIENT_READY", nextActionAt: null, payload: { ...current.payload, clientReadySummary: input.summary, clientReadyAt: now() } }))!;
      await record(owner, { paneId: pane.id, leadId: lead.id, type: "CLIENT_READY", message: `Client ready on ${FREELANCE_CHANNEL_LABELS[lead.channel]}: ${lead.title}. ${input.summary}`, payload: { url: lead.url, summary: input.summary } });
      return lead;
    },
    /** The operator closes a lead (won with its value, lost) or gives it back to the copilot (reopen). */
    async decideLead(owner: string, pane: Pane | null, id: string, input: FreelanceLeadDecision, by?: RailAnswerBy) {
      const current = await leadOf(owner, id);
      const status = ({ won: "WON", lost: "LOST", reopen: "TALKING" } as const)[input.decision];
      const lead = (await repository.updateLead(owner, id, { status, nextActionAt: null, ...(input.decision === "won" ? { contractValue: input.contractValue ?? current.contractValue } : {}),
        ...(input.note ? { notes: [current.notes, `Operator: ${input.note}`].filter(Boolean).join("\n").slice(0, 4000) } : {}) }))!;
      if (input.decision === "won" || input.decision === "lost") {
        await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, channel: lead.channel, tags: [`lead-${input.decision}`], source: "LEARNED", pinned: false,
          text: `${input.decision === "won" ? "Won" : "Lost"} on ${FREELANCE_CHANNEL_LABELS[lead.channel]}: "${lead.title}"${lead.budget ? ` (${lead.budget})` : ""}${input.contractValue ? `, contract $${input.contractValue}` : ""}${input.note ? `. Operator: ${input.note}` : ""}`.slice(0, 4000) });
      }
      await record(owner, { paneId: pane?.id ?? null, leadId: id, type: "LEAD_DECIDED", message: `You marked "${lead.title}" ${input.decision === "reopen" ? "back to the copilot" : input.decision}${input.contractValue ? ` ($${input.contractValue})` : ""}`,
        payload: { decision: input.decision, contractValue: input.contractValue ?? null, ...(by ? { by } : {}) } });
      return lead;
    },
    // ---- messages -----------------------------------------------------------------------------
    listMessages: (owner: string, filter: Parameters<FreelanceCopilotRepository["listMessages"]>[1]) => repository.listMessages(owner, filter),
    getMessage: messageOf,
    async createMessage(owner: string, pane: Pane | null, input: FreelanceMessageCreate) {
      const lead = await leadOf(owner, input.leadId);
      const message = await repository.createMessage({ ownerUserId: owner, paneId: pane?.id ?? null, leadId: lead.id, channel: lead.channel, direction: "OUT", kind: input.kind, body: input.body,
        bid: input.bid ?? null, connects: input.connects ?? null, status: "DRAFT", reviewNote: null, ruleId: null, sentUrl: null, sentAt: null, evidence: {} });
      const runId = pane ? await bumpRun(owner, pane.id, "drafted") : null;
      await record(owner, { paneId: pane?.id ?? null, runId, leadId: lead.id, messageId: message.id, type: "MESSAGE_DRAFTED", message: `Drafted a ${describe(message)} for "${lead.title}"` });
      return { message, wordingIssues: issuesOf(pane, lead, message) };
    },
    /** The agent edits its own drafts (and failed messages); messages in review wait for the operator. */
    async updateMessage(owner: string, pane: Pane | null, id: string, patch: FreelanceMessageUpdate) {
      const message = await repository.updateMessage(owner, id, patch, ["DRAFT", "FAILED"]);
      if (!message) throw new SpaceConflictError("Only a draft (or a failed message) can be edited; a message in review waits for the operator.");
      return { message, wordingIssues: issuesOf(pane, await leadOf(owner, message.leadId), message) };
    },
    /** A client's message the agent read: the lead moves to TALKING and its follow-ups stop. */
    async recordIncoming(owner: string, pane: Pane | null, input: { leadId: string; body: string; url?: string; receivedAt?: string }) {
      const lead = await leadOf(owner, input.leadId);
      const scamSignals = freelanceScamSignals(input.body);
      const message = await repository.createMessage({ ownerUserId: owner, paneId: pane?.id ?? null, leadId: lead.id, channel: lead.channel, direction: "IN", kind: "MESSAGE", body: input.body,
        bid: null, connects: null, status: "RECEIVED", reviewNote: null, ruleId: null, sentUrl: input.url ?? null, sentAt: input.receivedAt ?? now(), evidence: scamSignals.length ? { scamSignals } : {} });
      const advance = ["NEW", "QUALIFIED", "PROPOSED"].includes(lead.status);
      await repository.updateLead(owner, lead.id, { nextActionAt: null, ...(advance ? { status: "TALKING" as const } : {}),
        ...(scamSignals.length ? { payload: { ...lead.payload, scamSignals: [...new Set([...(Array.isArray(lead.payload.scamSignals) ? lead.payload.scamSignals as string[] : []), ...scamSignals])] } } : {}) });
      await record(owner, { paneId: pane?.id ?? null, leadId: lead.id, messageId: message.id, type: "MESSAGE_RECEIVED", message: `${lead.client ?? "The client"} wrote on ${FREELANCE_CHANNEL_LABELS[lead.channel]} about "${lead.title}"`,
        payload: { scamSignals } });
      return { message, scamSignals };
    },
    async requestReview(owner: string, pane: Pane | null, input: { messageId: string; summary?: string; operatorOrder?: string }) {
      const draft = await messageOf(owner, input.messageId);
      const order = await operatorOrder(options.operatorMessages, owner, input.operatorOrder);
      const overrides = await refuseForbidden(owner, `${(await leadOf(owner, draft.leadId)).title} ${input.summary ?? ""}`, draft.channel, [draft.id, draft.leadId], order);
      // R12-4: a message an approved rule covers, or one written for a Nous brief, carries Approve as the card's recommended answer.
      const vouched = (await repository.listRules(owner, ["APPROVED"])).some((rule) => freelanceRuleMatches(rule, draft)) ? "RULE"
        : (await repository.listEvents(owner, { paneId: pane?.id ?? draft.paneId, types: ["BRIEF"] })).some((brief) => brief.payload.from === "NOUS"
          && (brief.status === "TAKEN" || brief.leadId === draft.leadId)) ? "NOUS" : null;
      const message = await repository.updateMessage(owner, input.messageId, { reviewNote: null }, ["DRAFT", "FAILED"]).then((updated) => updated && repository.updateMessage(owner, input.messageId, { status: "IN_REVIEW" }));
      if (!message) throw new SpaceConflictError("Only a draft (or a failed message) can be sent for review.");
      const lead = await leadOf(owner, message.leadId);
      const wordingIssues = issuesOf(pane, lead, message);
      await record(owner, { paneId: pane?.id ?? message.paneId, leadId: lead.id, messageId: message.id, type: "REVIEW_REQUESTED", message: `Review: ${input.summary ?? `${describe(message)} for "${lead.title}"`}${overrides ? ` (${overrides})` : ""}`,
        payload: { wordingIssues, ...(order ? { operatorOrder: order } : {}), ...(vouched ? { vouched } : {}) } });
      return { message, wordingIssues, ...(overrides ? { overrides } : {}) };
    },
    /** The operator decides a message: approve, edit (their version is approved and learned), revise (back to the agent) or reject. */
    async decideReview(owner: string, pane: Pane | null, messageId: string, input: FreelanceMessageReviewDecision, by?: RailAnswerBy) {
      const current = await messageOf(owner, messageId);
      const patch = input.decision === "approve" || input.decision === "edit"
        ? { status: "APPROVED" as const, reviewNote: input.note ?? null, ...(input.decision === "edit" && input.body !== undefined ? { body: input.body } : {}) }
        : { status: input.decision === "revise" ? "DRAFT" as const : "REJECTED" as const, reviewNote: input.note ?? null };
      const message = await repository.updateMessage(owner, messageId, patch, ["DRAFT", "IN_REVIEW", "FAILED"]);
      if (!message) throw new SpaceConflictError("This message is no longer waiting for a decision.");
      const label = FREELANCE_CHANNEL_LABELS[message.channel];
      if (input.decision === "edit" && message.body !== current.body) {
        await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, channel: message.channel, tags: ["review-edit"], source: "LEARNED", pinned: false,
          text: `On ${label} the operator changed a ${message.kind.toLowerCase()}. Copilot draft:\n${current.body.slice(0, 1500)}\n\nOperator's version:\n${message.body.slice(0, 1500)}`.slice(0, 4000) });
      }
      if (input.decision === "reject" && input.note) {
        await repository.upsertMemory({ ownerUserId: owner, kind: "LESSON", key: null, channel: message.channel, tags: ["review-reject"], source: "LEARNED", pinned: false,
          text: `On ${label} the operator rejected a ${message.kind.toLowerCase()}: ${input.note}`.slice(0, 4000) });
      }
      if (input.decision === "revise") await service.createBrief(owner, pane, { text: `Revise the ${describe(message)} ${message.id}: ${input.note}`, leadId: message.leadId, channels: [message.channel] });
      const verb = { approve: "approved", edit: "edited and approved", revise: "sent back for changes", reject: "rejected" }[input.decision];
      await record(owner, { paneId: pane?.id ?? message.paneId, leadId: message.leadId, messageId: message.id, type: "REVIEW_DECIDED", message: `You ${verb} the ${describe(message)}${input.note ? `: ${input.note}` : ""}`,
        payload: { decision: input.decision, note: input.note ?? null, ...(by ? { by } : {}) } });
      return message;
    },
    /**
     * R24-3: the copilot closes its own message in review that went stale or a newer message replaced (`replacedBy`, newer and for the same
     * lead), with evidence; its review card resolves.
     */
    /** The message a review sends, for a Nous decision's "What it sends" (as Mail's reviewDraft); null when unknown. */
    async reviewDraft(owner: string, messageId: string) {
      const message = await repository.getMessage(owner, messageId);
      if (!message) return null;
      const lead = await repository.getLead(owner, message.leadId);
      return { headers: [["Channel", describe(message)], ["To", [lead?.client, lead?.title].filter(Boolean).join(": ")], ["Where", lead?.url ?? ""],
        ["Bid", message.bid ? `$${message.bid.amount} ${message.bid.type === "HOURLY" ? "per hour" : "fixed"}` : ""], ["Connects", message.connects === null ? "" : String(message.connects)]] as Array<[string, string]>, body: message.body };
    },
    async supersedeReview(owner: string, pane: Pane | null, input: { messageId: string; evidence: string; replacedBy?: string }) {
      const current = await messageOf(owner, input.messageId);
      if (input.replacedBy) {
        const newer = await messageOf(owner, input.replacedBy);
        if (newer.id === current.id || newer.leadId !== current.leadId || newer.createdAt <= current.createdAt) {
          throw new SpaceConflictError(`${newer.id} is not a newer message for the same lead than ${current.id}.`);
        }
      }
      const message = await repository.updateMessage(owner, input.messageId, { status: "SUPERSEDED", reviewNote: `Superseded: ${input.evidence}` }, ["IN_REVIEW"]);
      if (!message) throw new SpaceConflictError(`Only a message in review can be superseded; ${current.id} is ${current.status.toLowerCase().replace("_", " ")}.`);
      await record(owner, { paneId: pane?.id ?? message.paneId, leadId: message.leadId, messageId: message.id, type: "REVIEW_DECIDED",
        message: `The copilot closed the ${describe(message)} in review as superseded: ${input.evidence}`,
        payload: { decision: "superseded", note: input.evidence, replacedBy: input.replacedBy ?? null } });
      return message;
    },
    async waitForReview(owner: string, input: { messageId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const message = await messageOf(owner, input.messageId);
        if (message.status !== "IN_REVIEW") return { decided: true as const, status: message.status, note: message.reviewNote, message };
        if (Date.now() >= deadline) return { decided: false as const, status: message.status };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    // ---- sending: the gate, then evidence ------------------------------------------------------
    async beginSend(owner: string, pane: Pane, messageId: string) {
      const message = await messageOf(owner, messageId);
      if (message.direction !== "OUT" || !["APPROVED", "DRAFT", "FAILED"].includes(message.status)) throw new SpaceConflictError(`This message is ${message.status.toLowerCase().replace("_", " ")}; it cannot be sent now.`);
      const lead = await leadOf(owner, message.leadId);
      const { ruleId } = await authorize(owner, pane, message, lead);
      const sending = await repository.updateMessage(owner, messageId, { status: "SENDING", ruleId }, [message.status]);
      if (!sending) throw new SpaceConflictError("The message changed meanwhile; read it again.");
      const runId = await bumpRun(owner, pane.id, "taken");
      await record(owner, { paneId: pane.id, runId, leadId: lead.id, messageId, type: "SENDING", message: `Sending a ${describe(message)} for "${lead.title}"` });
      return sending;
    },
    /** A send counts only with its URL on the platform (and, when taken, a screenshot of it). */
    async finishSend(owner: string, pane: Pane, input: { messageId: string; url: string; screenshotPath?: string }) {
      const message = await messageOf(owner, input.messageId);
      if (message.status !== "SENDING") throw new SpaceConflictError("Begin the send first (space_freelance_send_begin).");
      if (!freelanceUrlMatchesChannel(input.url, message.channel)) throw new SpaceConflictError(`FREELANCE_EVIDENCE: ${input.url} is not an https page of ${FREELANCE_CHANNEL_LABELS[message.channel]}; report the sent proposal's or conversation's own URL.`);
      const sent = (await repository.updateMessage(owner, message.id, { status: "SENT", sentUrl: input.url, sentAt: now(),
        evidence: { ...message.evidence, url: input.url, screenshotPath: input.screenshotPath ?? null, reportedAt: now() } }, ["SENDING"]))!;
      const lead = await leadOf(owner, message.leadId);
      const followUps = Number(lead.payload.followUps ?? 0) + (message.kind === "FOLLOW_UP" ? 1 : 0);
      const opening = message.kind === "PROPOSAL" || message.kind === "APPLICATION";
      const waiting = opening || message.kind === "FOLLOW_UP";
      const nextActionAt = waiting && settingsOf(pane).followUps && followUps < FOLLOW_UP_DAYS.length ? later(FOLLOW_UP_DAYS[followUps]! * DAY_MS) : null;
      await repository.updateLead(owner, lead.id, { ...(opening && ["NEW", "QUALIFIED"].includes(lead.status) ? { status: "PROPOSED" as const } : {}), nextActionAt, payload: { ...lead.payload, followUps } });
      const runId = await bumpRun(owner, pane.id, "sent");
      await record(owner, { paneId: pane.id, runId, leadId: lead.id, messageId: message.id, type: "SENT", message: `Sent a ${describe(message)} for "${lead.title}"`, payload: { url: input.url, connects: message.connects } });
      return sent;
    },
    async failSend(owner: string, pane: Pane, input: { messageId: string; reason: string }) {
      const message = await repository.updateMessage(owner, input.messageId, { status: "FAILED", evidence: { failure: input.reason, failedAt: now() } }, ["SENDING"]);
      if (!message) throw new SpaceConflictError("This message is not being sent.");
      const runId = await bumpRun(owner, pane.id, "failed");
      await record(owner, { paneId: pane.id, runId, leadId: message.leadId, messageId: message.id, type: "SEND_FAILED", message: `Sending a ${describe(message)} failed: ${input.reason}`, payload: { reason: input.reason } });
      return message;
    },
    /** The operator retries a failed message: approved again, so the next run sends it. */
    async retryMessage(owner: string, pane: Pane | null, messageId: string) {
      const message = await repository.updateMessage(owner, messageId, { status: "APPROVED" }, ["FAILED"]);
      if (!message) throw new SpaceConflictError("Only a failed message can be retried.");
      await record(owner, { paneId: pane?.id ?? message.paneId, leadId: message.leadId, messageId, type: "REVIEW_DECIDED", message: `You approved a retry of the ${describe(message)}`, payload: { decision: "approve" } });
      return message;
    },
    // ---- platform accounts --------------------------------------------------------------------
    async listAccounts(owner: string): Promise<FreelanceAccount[]> {
      const stored = new Map((await repository.listAccounts(owner)).map((account) => [account.channel, account]));
      return FREELANCE_CHANNELS.map((channel) => stored.get(channel) ?? { ownerUserId: owner, channel, status: "NOT_STARTED", email: freelanceChannelAlias(channel, freelanceSite().aliasDomain), profileUrl: null, notes: null, updatedAt: now() });
    },
    async updateAccount(owner: string, pane: Pane | null, input: FreelanceAccountUpdate, by: "AGENT" | "USER") {
      const { channel, ...patch } = input;
      const account = await repository.upsertAccount(owner, channel, { ...patch, ...(patch.email === undefined && !(await repository.listAccounts(owner)).some((entry) => entry.channel === channel) ? { email: freelanceChannelAlias(channel, freelanceSite().aliasDomain) } : {}) });
      await record(owner, { paneId: pane?.id ?? null, type: account.status === "NEEDS_OPERATOR" ? "NEEDS_USER" : "ACCOUNT_UPDATED",
        message: `${FREELANCE_CHANNEL_LABELS[channel]} account: ${account.status.toLowerCase().replace("_", " ")}${account.notes ? ` (${account.notes})` : ""}${by === "USER" ? " (you)" : ""}`.slice(0, 1000),
        payload: { channel, status: account.status } });
      return account;
    },
    // ---- mailbox ------------------------------------------------------------------------------
    async mailboxStatus(owner: string) {
      const mailbox = await repository.getMailbox(owner);
      return { connected: Boolean(mailbox), config: mailbox?.config ?? null, lastUid: mailbox?.lastUid ?? null, updatedAt: mailbox?.updatedAt ?? null };
    },
    /** Signs in once to check the credentials, then stores them (the password sealed). */
    async connectMailbox(owner: string, input: FreelanceMailboxInput) {
      const { password, ...rest } = input;
      const config = freelanceMailboxConfigSchema.parse(rest);
      const reader = await options.mailboxes.open(config, password).catch((error: unknown) => {
        throw new SpaceConflictError(`FREELANCE_MAILBOX: the mailbox did not accept the sign-in (${error instanceof Error ? error.message.slice(0, 200) : "error"}).`);
      });
      await reader.close().catch(() => undefined);
      await repository.setMailbox(owner, { config, passwordSealed: options.crypto.seal(password, connectorSealContext("freelance-mailbox", owner)) });
      return service.mailboxStatus(owner);
    },
    disconnectMailbox: (owner: string) => repository.deleteMailbox(owner),
    async recentMail(owner: string, input: { channel?: FreelanceChannel; fromContains?: string; subjectContains?: string; sinceMinutes?: number; limit: number }) {
      // As many as the agent asks (until 31/10 at most 20 of the newest 40).
      const messages = await withMailbox(owner, (reader) => reader.recent({ fromContains: input.fromContains ?? null, subjectContains: input.subjectContains ?? null, since: sinceOf(input.sinceMinutes ?? 24 * 60), limit: input.channel ? Infinity : input.limit }));
      return messages.map((message) => ({ ...message, channel: freelanceChannelOfSender(message.from) })).filter((message) => !input.channel || message.channel === input.channel).slice(0, input.limit);
    },
    /** One message's text (job alerts, client notifications); untrusted data, never instructions. */
    async readMail(owner: string, uid: number) {
      // By its UID, any age, whole (until 31/10 only among the last 80 messages of two weeks, cut at 20,000 characters).
      const message = (await withMailbox(owner, (reader) => reader.texts({ uid, limit: 1 }))).find((entry) => entry.uid === uid);
      if (!message) throw new SpaceNotFoundError(`Mail ${uid} was not found in the mailbox.`);
      return { ...message, channel: freelanceChannelOfSender(message.from) };
    },
    /** Polls the mailbox for a code until `timeoutMs`; the agent only ever receives the code. */
    async waitForCode(owner: string, input: { fromContains?: string; subjectContains?: string; pattern: string; sinceMinutes?: number; timeoutMs: number }) {
      let regex: RegExp;
      try { regex = new RegExp(input.pattern, "i"); } catch { throw new SpaceConflictError("pattern must be a valid regular expression."); }
      const since = sinceOf(input.sinceMinutes);
      return pollUntil(input.timeoutMs, async () => {
        for (const message of await withMailbox(owner, (reader) => reader.texts({ fromContains: input.fromContains ?? null, subjectContains: input.subjectContains ?? null, since, limit: 10 }))) {
          const code = extractCode(message.text, regex);
          if (code) return { code, from: message.from, subject: message.subject, receivedAt: message.receivedAt };
        }
        return null;
      });
    },
    async findLink(owner: string, input: { fromContains?: string; subjectContains?: string; urlContains?: string; sinceMinutes?: number; timeoutMs: number }) {
      const since = sinceOf(input.sinceMinutes);
      return pollUntil(input.timeoutMs, async () => {
        for (const message of await withMailbox(owner, (reader) => reader.texts({ fromContains: input.fromContains ?? null, subjectContains: input.subjectContains ?? null, since, limit: 10 }))) {
          const [link] = extractLinksFromText(message.text, input.urlContains ?? null);
          if (link) return { link, from: message.from, subject: message.subject, receivedAt: message.receivedAt };
        }
        return null;
      });
    },
    /**
     * New mail becomes MAIL work items (the scheduler, every few minutes). The first poll only sets the cursor to the
     * newest message, so an old inbox does not flood the queue. Returns how many items it created.
     * DMARC reports (`isMailReport`) become no item: they are filed in the DMARC folder, \Seen, never deleted.
     */
    async pollMail(owner: string, pane: Pane): Promise<number> {
      const mailbox = await repository.getMailbox(owner);
      if (!mailbox) return 0;
      const lastUid = mailbox.lastUid;
      // MAIL items opened before this rule (stable 3/11: 19 DMARC reports, uids 221-239, blocked the copilot) close by the same rule.
      const openReports = (await repository.listEvents(owner, { types: ["MAIL"], status: ["PENDING", "TAKEN"] }))
        .filter((item) => typeof item.payload.uid === "number" && isReportSender({ from: String(item.payload.from ?? ""), subject: String(item.payload.subject ?? "") }));
      const { messages, reportUids, closing, filed } = await withMailbox(owner, async (reader) => {
        // Every mail of the week (until 31/10 its newest 30: a busier poll skipped the older new mail, the cursor jumping past it).
        const messages = await reader.recent({ since: ago(7 * DAY_MS) });
        const closing: FreelanceEvent[] = [];
        for (const item of openReports) {
          const uid = item.payload.uid as number;
          const found = messages.find((message) => message.uid === uid) ?? (await reader.recent({ uid })).find((message) => message.uid === uid);
          if (found?.report) closing.push(item);
        }
        const reportUids = [...new Set([...messages.filter((message) => message.report && lastUid !== null && (message.uid ?? 0) > lastUid).map((message) => message.uid!),
          ...closing.map((item) => item.payload.uid as number)])];
        // Domain reports for the deliverability reads (Mail Campaigns), never a client's mail: filed, not deleted.
        const filed = !reportUids.length ? null : !reader.moveTo ? "left in the inbox (this mailbox reader cannot move mail)"
          : await reader.moveTo(reportUids, REPORT_FOLDER).then(() => `moved to the ${REPORT_FOLDER} folder`,
            (error: unknown) => `left in the inbox (the move failed: ${error instanceof Error ? error.message : String(error)})`);
        return { messages, reportUids, closing, filed };
      });
      for (const item of closing) await repository.setEventStatus(owner, item.id, "DONE");
      if (filed) await record(owner, { paneId: pane.id, type: "NOTE", message: `Skipped ${reportUids.length} DMARC report mail${reportUids.length === 1 ? "" : "s"} (domain reports, not client mail): ${filed}.`,
        payload: { outcome: "skipped", uids: reportUids, itemIds: closing.map((item) => item.id) } });
      const newest = Math.max(0, ...messages.map((message) => message.uid ?? 0));
      if (lastUid === null) { if (newest) await repository.setMailboxCursor(owner, newest); return 0; }
      const fresh = messages.filter((message) => !message.report && (message.uid ?? 0) > lastUid).sort((left, right) => (left.uid ?? 0) - (right.uid ?? 0));
      for (const message of fresh) {
        const channel = freelanceChannelOfSender(message.from);
        await record(owner, { paneId: pane.id, type: "MAIL", status: "PENDING", message: `Mail${channel ? ` from ${FREELANCE_CHANNEL_LABELS[channel]}` : ""}: ${message.subject || "(no subject)"}`,
          payload: { uid: message.uid, from: message.from, subject: message.subject, receivedAt: message.receivedAt, channel, snippet: message.snippet.slice(0, 300) } });
      }
      if (newest > lastUid) await repository.setMailboxCursor(owner, newest);
      return fresh.length;
    },
    // ---- memory -------------------------------------------------------------------------------
    async recallMemory(owner: string, query: FreelanceMemoryQuery) {
      const merged = [...new Map([...(await repository.listMemory(owner, { ...query, query: undefined, limit: undefined })).filter((memory) => memory.pinned), ...await repository.listMemory(owner, query)]
        .map((memory) => [memory.id, memory])).values()];
      await repository.touchMemories(owner, merged.map((memory) => memory.id));
      return merged;
    },
    listMemory: (owner: string, query: FreelanceMemoryQuery) => repository.listMemory(owner, query),
    rememberMemory: (owner: string, input: FreelanceMemoryCreate, source: "USER" | "AGENT") => repository.upsertMemory({ ownerUserId: owner, kind: input.kind, key: input.key ?? null, text: input.text,
      channel: input.channel ?? null, tags: input.tags, source, pinned: input.pinned }),
    updateMemory: (owner: string, id: string, patch: { text?: string; pinned?: boolean }) => repository.updateMemory(owner, id, patch),
    forgetMemory: (owner: string, id: string) => repository.deleteMemory(owner, id),
    // ---- questions ----------------------------------------------------------------------------
    async askQuestion(owner: string, pane: Pane, input: { question: string; options?: string[]; leadId?: string; afterMemory?: boolean }) {
      await refuseForbidden(owner, input.question);
      // Plan clipboard:7L5KyWp3kQsP step 3: the operator's pinned Space Memory entries holding the question's words join the memories shown first.
      const pinned = !input.afterMemory && options.operatorMemory ? await options.operatorMemory(input.question).catch(() => []) : [];
      // R13-5 (Job's item 34 for Freelance): the copilot's own memories that may answer it come back first, nothing asked.
      // Every memory a question word finds, up to the memory list's page of 200 (until 31/10 five a word).
      const memoryHits = input.afterMemory ? [] : [...await questionMemoryHits((query) => repository.listMemory(owner, { query, kinds: ["PROFILE", "FACT", "PRICING", "CHANNEL_RULE", "LESSON", "PREFERENCE", "CLIENT"] }), input.question),
        ...pinned.map((entry) => ({ id: entry.id, key: `${entry.rule ? "Operator rule" : "Operator fact"} (Space Memory): ${entry.title}`, text: entry.body }))];
      if (memoryHits.length) return { questionId: null, memoryHits, note: MEMORY_HITS_NOTE };
      const questionId = `flq:${randomBytes(9).toString("base64url")}`;
      await record(owner, { paneId: pane.id, leadId: input.leadId ?? null, type: "QUESTION", message: `Needs you: ${input.question}`, payload: { questionId, question: input.question, options: input.options ?? [] } });
      return { questionId };
    },
    /** by NOUS: Nous, the mind of SpaceApp, answered for the operator (its answer is the agent's memory, not the operator's voice). */
    async answerQuestion(owner: string, pane: Pane | null, input: { questionId: string; answer: string }, by: "USER" | "NOUS" = "USER") {
      const question = (await repository.listEvents(owner, { types: ["QUESTION"] })).find((event) => event.payload.questionId === input.questionId);
      if (!question) throw new SpaceNotFoundError("The question was not found.");
      const memory = await repository.upsertMemory({ ownerUserId: owner, kind: "FACT", key: String(question.payload.question).toLowerCase().slice(0, 300), text: input.answer, channel: null, tags: ["question"], source: by === "NOUS" ? "AGENT" : "USER", pinned: false });
      await record(owner, { paneId: pane?.id ?? question.paneId, leadId: question.leadId, type: "ANSWERED", message: `${by === "NOUS" ? "Nous" : "You"} answered: ${input.answer.slice(0, 200)}`, payload: { questionId: input.questionId, answer: input.answer, memoryId: memory.id, answeredBy: by } });
      return { memory };
    },
    async waitForAnswer(owner: string, input: { questionId: string; waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const answered = (await repository.listEvents(owner, { types: ["ANSWERED"] })).find((event) => event.payload.questionId === input.questionId);
        if (answered) return { answered: true as const, answer: String(answered.payload.answer ?? "") };
        if (Date.now() >= deadline) return { answered: false as const, answer: null };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    // ---- rules --------------------------------------------------------------------------------
    listRules: (owner: string, status?: FreelanceRule["status"][]) => repository.listRules(owner, status),
    async proposeRule(owner: string, pane: Pane | null, proposal: FreelanceRuleProposal, by: "AGENT" | "USER") {
      const rule = await repository.createRule({ ownerUserId: owner, name: proposal.name, channel: proposal.channel, kinds: proposal.kinds, status: by === "USER" ? "APPROVED" : "PROPOSED", evidence: proposal.evidence, proposedBy: by });
      await record(owner, { paneId: pane?.id ?? null, type: by === "USER" ? "RULE_DECIDED" : "RULE_PROPOSED", message: by === "USER" ? `You added the rule: ${rule.name}` : `Rule proposed: ${rule.name}`, payload: { ruleId: rule.id } });
      return rule;
    },
    async decideRule(owner: string, pane: Pane | null, id: string, decision: "approve" | "reject" | "retire", by?: RailAnswerBy) {
      const rule = await repository.getRule(owner, id);
      if (!rule) throw new SpaceNotFoundError("The rule was not found.");
      const updated = (await repository.updateRule(owner, id, { status: ({ approve: "APPROVED", reject: "REJECTED", retire: "RETIRED" } as const)[decision], decidedAt: now() }))!;
      await record(owner, { paneId: pane?.id ?? null, type: "RULE_DECIDED", message: `You ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "retired"} the rule: ${rule.name}`, payload: { ruleId: id, decision, ...(by ? { by } : {}) } });
      return updated;
    },
    // ---- activity, pending items and runs ------------------------------------------------------
    listEvents: (owner: string, filter: { paneId?: string; types?: string[]; limit?: number }) => repository.listEvents(owner, filter),
    async pendingItems(owner: string, paneId: string | null): Promise<FreelancePendingItem[]> {
      const [ready, reviews, questions, rules, accounts] = await Promise.all([
        repository.listLeads(owner, { status: ["CLIENT_READY"] }),
        repository.listMessages(owner, { status: ["IN_REVIEW"] }),
        repository.listEvents(owner, { paneId, types: ["QUESTION", "ANSWERED"] }),
        repository.listRules(owner, ["PROPOSED"]),
        repository.listAccounts(owner)
      ]);
      const answered = new Set(questions.filter((event) => event.type === "ANSWERED").map((event) => String(event.payload.questionId)));
      const leads = new Map((await Promise.all([...new Set(reviews.map((message) => message.leadId))].map((id) => repository.getLead(owner, id)))).filter((lead): lead is FreelanceLead => Boolean(lead)).map((lead) => [lead.id, lead]));
      return [
        ...ready.map((lead) => ({ kind: "CLIENT_READY" as const, id: lead.id, message: `Client ready: ${lead.title}`, payload: { lead }, createdAt: lead.updatedAt })),
        ...reviews.map((message) => {
          const lead = leads.get(message.leadId);
          return { kind: "REVIEW" as const, id: message.id, message: `Review the ${describe(message)}${lead ? ` for "${lead.title}"` : ""}`, payload: { message, lead: lead ?? null, wordingIssues: lead ? issuesOf(null, lead, message) : [] }, createdAt: message.updatedAt };
        }),
        ...questions.filter((event) => event.type === "QUESTION" && !answered.has(String(event.payload.questionId))).map((event) => ({ kind: "QUESTION" as const, id: String(event.payload.questionId), message: event.message, payload: event.payload, createdAt: event.createdAt })),
        ...rules.map((rule) => ({ kind: "RULE" as const, id: rule.id, message: `Rule proposed: ${rule.name}`, payload: { rule }, createdAt: rule.createdAt })),
        ...accounts.filter((account) => account.status === "NEEDS_OPERATOR").map((account) => ({ kind: "ACCOUNT" as const, id: account.channel, message: `${FREELANCE_CHANNEL_LABELS[account.channel]} account needs you${account.notes ? `: ${account.notes}` : ""}`, payload: { account }, createdAt: account.updatedAt }))
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    followUpsDue,
    approvedDue,
    /** The pane's work: its briefs and new mail in `status`, approved messages and follow-ups that are due. */
    async backlog(owner: string, pane: Pane, status: Array<"PENDING" | "TAKEN"> = ["PENDING"]) {
      const items = await repository.listEvents(owner, { types: ["BRIEF", "MAIL"], status });
      const own = items.filter((item) => item.type !== "BRIEF" || !item.paneId || item.paneId === pane.id);
      return own.length + (await approvedDue(owner, pane)).length + (await followUpsDue(owner, pane)).length;
    },
    async runView(owner: string, pane: Pane): Promise<FreelanceRunView> {
      const run = await repository.getActiveRun(pane.id);
      const mine = run && run.ownerUserId === owner ? run : null;
      return { run: mine, status: mine?.status ?? "IDLE", pending: await service.pendingItems(owner, pane.id), backlog: await service.backlog(owner, pane) };
    },
    activeRun: (paneId: string) => repository.getActiveRun(paneId),
    async startRun(owner: string, paneId: string): Promise<{ run: FreelanceRun; kickoff: boolean }> {
      const active = await repository.getActiveRun(paneId);
      if (active && active.ownerUserId !== owner) throw new SpaceConflictError("Another user's run is active in this pane.");
      if (active?.status === "RUNNING") return { run: active, kickoff: !active.kickoffSentAt };
      if (active?.status === "PAUSED") {
        const resumed = (await repository.updateRun(owner, active.id, { status: "RUNNING", lastActivityAt: now() }))!;
        await record(owner, { paneId, runId: resumed.id, type: "RUN_RESUMED", message: "Run resumed" });
        return { run: resumed, kickoff: !resumed.kickoffSentAt };
      }
      const run = await repository.createRun({ ownerUserId: owner, paneId });
      await record(owner, { paneId, runId: run.id, type: "RUN_STARTED", message: "Run started: the copilot works through your briefs, new mail, approved messages and due follow-ups" });
      return { run, kickoff: true };
    },
    async markKickoff(owner: string, runId: string) { await repository.updateRun(owner, runId, { kickoffSentAt: now() }); },
    async pauseRun(owner: string, paneId: string) {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      if (run.status === "PAUSED") return run;
      const paused = (await repository.updateRun(owner, run.id, { status: "PAUSED", lastActivityAt: now() }))!;
      await record(owner, { paneId, runId: run.id, type: "RUN_PAUSED", message: "Run paused" });
      return paused;
    },
    async stopRun(owner: string, paneId: string, message = "Run stopped") {
      const run = await repository.getActiveRun(paneId);
      if (!run || run.ownerUserId !== owner) throw new SpaceConflictError("No run is active in this pane.");
      const stopped = (await repository.updateRun(owner, run.id, { status: "STOPPED", stoppedAt: now(), lastActivityAt: now() }))!;
      const { counters } = run;
      await record(owner, { paneId, runId: run.id, type: "RUN_STOPPED", message: `${message}: ${counters.drafted} drafted, ${counters.sent} sent, ${counters.failed} failed` });
      return stopped;
    },
    /**
     * The agent's loop: waits (up to `waitMs`) while the run is RUNNING for a work item: a brief or a new mail (oldest
     * first), then a message the operator approved, then a proposal whose follow-up is due. With none left the run
     * finishes (Start, a brief or the scheduler starts the next one).
     */
    async nextItem(owner: string, pane: Pane, input: { waitMs: number }) {
      const deadline = Date.now() + Math.min(input.waitMs, NEXT_MAX_WAIT_MS);
      for (;;) {
        const run = await repository.getActiveRun(pane.id);
        if (!run || run.ownerUserId !== owner) return { done: true as const, reason: "NO_RUN" as const };
        const settings = settingsOf(pane);
        if (run.status === "RUNNING" && !settings.paused) {
          const item = await repository.takeNextWorkItem(owner, pane.id, TAKEN_STALE_MS);
          if (item) {
            await bumpRun(owner, pane.id, "taken");
            const lead = item.leadId ? await repository.getLead(owner, item.leadId) : null;
            const memories = await service.recallMemory(owner, { query: item.message.slice(0, 300) });
            return { done: false as const, kind: item.type as "BRIEF" | "MAIL", item, lead, memories, autonomy: settings.autonomy };
          }
          const [approved] = await approvedDue(owner, pane);
          if (approved) return { done: false as const, kind: "SEND" as const, message: approved, lead: await repository.getLead(owner, approved.leadId) };
          const [followUp] = await followUpsDue(owner, pane);
          if (followUp) {
            // Taken off the due list while the agent writes it; finishSend sets the next one.
            await repository.updateLead(owner, followUp.id, { nextActionAt: null });
            return { done: false as const, kind: "FOLLOW_UP" as const, lead: followUp, messages: (await repository.listMessages(owner, { leadId: followUp.id })).reverse(),
              memories: await service.recallMemory(owner, { kinds: ["TEMPLATE", "CHANNEL_RULE", "LESSON"], channel: followUp.channel }) };
          }
          await service.stopRun(owner, pane.id, "Run finished");
          return { done: true as const, reason: "QUEUE_EMPTY" as const };
        }
        if (Date.now() >= deadline) return { done: false as const, waiting: true as const, reason: run.status === "PAUSED" ? "PAUSED" as const : "SETTINGS_PAUSED" as const };
        await sleep(Math.min(NEXT_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
    /** The agent closes a brief or mail: what it did, for the timeline. */
    async reportItem(owner: string, pane: Pane, input: { eventId: string; outcome: "done" | "needs_user" | "skipped"; summary: string; memoryIds?: string[] }) {
      const item = (await repository.listEvents(owner, { types: ["BRIEF", "MAIL"], status: ["TAKEN", "PENDING"] })).find((event) => event.id === input.eventId);
      if (!item) throw new SpaceNotFoundError(`Work item ${input.eventId} is not open.`);
      await repository.setEventStatus(owner, item.id, "DONE");
      if (input.memoryIds?.length) await repository.touchMemories(owner, input.memoryIds);
      const runId = input.outcome === "needs_user" ? await bumpRun(owner, pane.id, "needsUser") : (await repository.getActiveRun(pane.id))?.id ?? null;
      return record(owner, { paneId: pane.id, runId, leadId: item.leadId, type: input.outcome === "needs_user" ? "NEEDS_USER" : "NOTE", message: input.summary, payload: { itemId: item.id, outcome: input.outcome } });
    },
    /** A line in the pane's Activity from the agent; NEEDS_USER when it cannot go on alone. */
    note: (owner: string, pane: Pane, input: { message: string; leadId?: string; needsUser?: boolean }) =>
      record(owner, { paneId: pane.id, leadId: input.leadId ?? null, type: input.needsUser ? "NEEDS_USER" : "NOTE", message: input.message }),
    // ---- funnel and digest ---------------------------------------------------------------------
    async funnel(owner: string): Promise<FreelanceFunnel> {
      const [leads, sent] = await Promise.all([repository.listLeads(owner, {}), repository.listMessages(owner, { status: ["SENT"] })]);
      const channels: FreelanceFunnel["channels"] = {};
      for (const id of FREELANCE_CHANNELS) channels[id] = { leads: 0, proposed: 0, talking: 0, clientReady: 0, won: 0, lost: 0, sent: 0 };
      for (const lead of leads) {
        const row = channels[lead.channel]!;
        row.leads += 1;
        if (["PROPOSED", "TALKING", "CLIENT_READY", "WON", "LOST"].includes(lead.status)) row.proposed += 1;
        if (["TALKING", "CLIENT_READY", "WON"].includes(lead.status)) row.talking += 1;
        if (lead.status === "CLIENT_READY") row.clientReady += 1;
        if (lead.status === "WON") row.won += 1;
        if (lead.status === "LOST") row.lost += 1;
      }
      for (const message of sent) if (message.direction === "OUT") channels[message.channel]!.sent += 1;
      const firstSentAt = sent.filter((message) => message.direction === "OUT").map((message) => message.sentAt ?? message.updatedAt).sort()[0] ?? null;
      return { channels, connectsToday: await repository.sumConnects(owner, ago(DAY_MS)), connectsMonth: await repository.sumConnects(owner, ago(30 * DAY_MS)),
        revenue: leads.filter((lead) => lead.status === "WON").reduce((sum, lead) => sum + (lead.contractValue ?? 0), 0), firstSentAt };
    },
    /** Once a week: the funnel in one Activity line, with the six-week stop rule when no contract came yet. */
    async weeklyDigest(owner: string, pane: Pane) {
      const [last] = await repository.listEvents(owner, { types: ["DIGEST"], limit: 1 });
      if (last && Date.parse(now()) - Date.parse(last.createdAt) < 6.5 * DAY_MS) return null;
      const funnel = await service.funnel(owner);
      if (!funnel.firstSentAt) return null;
      const total = Object.values(funnel.channels).reduce((sum, row) => ({ sent: sum.sent + row.sent, talking: sum.talking + row.talking, won: sum.won + row.won }), { sent: 0, talking: 0, won: 0 });
      const stop = total.won === 0 && Date.parse(now()) - Date.parse(funnel.firstSentAt) >= STOP_RULE_MS;
      const digest = await record(owner, { paneId: pane.id, type: "DIGEST", message: `This week: ${total.sent} sent in total, ${total.talking} conversations, ${total.won} won ($${funnel.revenue}); ${funnel.connectsMonth} Connects in 30 days.`,
        payload: { digest: true, funnel } });
      if (stop) await record(owner, { paneId: pane.id, type: "NEEDS_USER", message: "Six weeks without a contract: change the niche or the channel (stop rule).", payload: { stopRule: true } });
      return digest;
    },
    now
  };
  return service;
}
export type FreelanceCopilotService = ReturnType<typeof createFreelanceCopilotService>;
