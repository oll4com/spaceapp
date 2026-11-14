import { createHash } from "node:crypto";
import { z } from "zod";
import { nousMessageIdSchema, requestDonePayloadSchema, type ClipboardItem, type NousRequestOutcome, type NousRequestStatus, type RequestDonePayload, type SpaceNotification } from "@space/contracts";
import type { NousRepository } from "@space/db";
import type { NotificationService } from "../notifications/service.js";
import { titleWords } from "./pane-notices.js";
import { waitsOnOperatorClaim } from "./pane-watch.js";
import type { NousTurnItem } from "./turn-items.js";
import { emitMakeEvent } from "../make-webhooks.js";

/** Internal provenance and delivery receipts survive conversation clearing, notification pruning and API restarts. */
export const REQUEST_DONE_NOTE_PREFIX = "request-done:";
export const requestDoneArgsSchema = requestDonePayloadSchema.omit({ planId: true }).extend({
  plan: z.string().max(160).regex(/^clipboard:[A-Za-z0-9_-]+$/).optional(),
  id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/).optional().describe("Without a plan: the id of the operator message it answers (the [nous_msg:…] before it in \"Operator messages to answer\"). Keep it on retries in later turns; separate requests get separate ids.")
});
type Args = z.infer<typeof requestDoneArgsSchema>;
type PlanMark = { planId: string; title: string; operatorTurn: string; reminded?: boolean };
/** How far back a Done record counts for the outcome check and the duplicate refusal (operator 31/10 00:07 BKK). */
const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The share of `words` (at least two) found in `other`. */
export const overlap = (words: Set<string>, other: string | Set<string>) => {
  if (words.size < 2) return 0;
  const found = typeof other === "string" ? titleWords(other) : other;
  let shared = 0;
  for (const word of words) if (found.has(word)) shared += 1;
  return shared / words.size;
};
const payloadOf = (record: SpaceNotification) => record.payload as Partial<RequestDonePayload>;
/** The durable note that a request (its plan, id or turn) reached Done: it outlives the record's 30-day retention after Got it. */
export const requestDoneReceiptKey = (identity: string) => `${REQUEST_DONE_NOTE_PREFIX}sent:${createHash("sha256").update(identity).digest("hex")}`;

/**
 * An operator request Nous reported PENDING, open until a Done record or its later real outcome closes it (operator 31/10 10:17 BKK:
 * about 80 PENDING requests in 30 hours, most without an id or plan, and nothing brought them back, so finished ones never reached Done).
 */
export interface NousOpenRequest {
  key: string; messageId: string | null; requestId?: string; summary: string; plan?: string; pane?: string; tickets?: string[];
  turnId: string; openedAt: string; reportedAt: string;
  /** The evidence of the last "looks finished" line Nous handled: the same evidence comes once. */
  evidence?: string;
  /** The last turn that acted on it (hold A, plan clipboard:ZWJJdBgHm64Z): a step sent naming it, its wait recorded. */
  actedAt?: string;
  /** R21-5: the closed or gone pane whose line Nous handled: the same pane comes once. */
  paneGone?: string;
  /** Closed requests keep their note (nous_notes is class A): when and why it closed. */
  closedAt?: string; closedReason?: string;
  /** space_open_requests reopen: this close no longer counts; the note stays as the audit line. */
  reopenedAt?: string; reopenNote?: string;
  /** The fresh request a reopen opened: its message's older closes, receipts and Done records no longer count (requests.ts). */
  reopens?: boolean;
}
/** space_open_requests' close: one request a call (operator 9/11 nous_msg:a45dfd55: 35 closed in one call, 7 of the 20 "done" were not). */
export interface NousOpenRequestClose { key?: string; messageId?: string; outcome: "SELF" | "HELPER" | "OPERATOR" | "DROPPED"; note: string; done?: boolean; where?: RequestDonePayload["where"]; verified?: string }
/** Per close item: closed (one or more open requests, or a message with none), already done or closed the same way, no open request, or refused. */
export interface NousCloseCounts { closed: number; alreadyDone: number; notOpen: number; errors: string[] }
/** An outcome as space_nous_outcome reports it, with the operator message it answers. */
export type NousReportedOutcome = NousRequestOutcome & { id?: string; plan?: string; pane?: string; tickets?: string[]; answerOnly?: boolean; messageIds?: string[] };
export const OPEN_REQUEST_PREFIX = `${REQUEST_DONE_NOTE_PREFIX}open:`;
const OPEN_DAILY_KEY = `${REQUEST_DONE_NOTE_PREFIX}open-daily`;
const OPEN_BACKFILL_KEY = `${REQUEST_DONE_NOTE_PREFIX}open-backfill`;
const OPEN_CLEANUP_KEY = `${REQUEST_DONE_NOTE_PREFIX}open-cleanup`;
/** An open request with nothing new for this long comes back in the day's one batched line (and counts as "no act" in the REVIEW). */
export const OPEN_QUIET_MS = 6 * 3_600_000;
const BACKFILL_MS = 7 * 86_400_000;
const clipWords = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** A close's evidence: done's verified, DROPPED's reason, a reopen's note (operator 9/11 nous_msg:a45dfd55: closes judged from records only). */
export const CLOSE_EVIDENCE_MIN = 20;

/** The operator message an outcome answers: the one Nous named (a "-N" suffix is one of several requests in it), else the oldest the turn answers. */
export function outcomeMessageIds(id: string | undefined, replyTo: readonly string[]): string[] {
  const named = id?.replace(/-\d+$/, "");
  return named && nousMessageIdSchema.safeParse(named).success ? [named] : replyTo.slice(0, 1);
}
/** The text a send, a brief, an execute prompt or a new plan gives its pane or plan; null for every other act. */
function dispatchText(act: { name: string; args: Record<string, unknown> }): string | null {
  const { name, args } = act;
  if (name === "space_send_to_pane" || name === "space_copilot_brief") return String(args.text ?? "");
  if (name === "space_plan_create") return `${String(args.title ?? "")}\n${String(args.text ?? "")}`;
  if (name !== "space_execute" || !Array.isArray(args.actions)) return null;
  const prompts = (args.actions as Array<Record<string, unknown>>).filter((action) => action.kind === "pane" && action.operation === "prompt");
  return prompts.length ? prompts.map((action) => String(action.text ?? "")).join("\n") : null;
}
/**
 * Operator 6/11 nous_msg:2c610048 (a spaceship background answered as a question and never done): the answerOnly outcomes whose message this
 * turn sent work for, i.e. a successful send, brief, execute prompt or new plan naming the message (its id or its first 8 characters), or any
 * of them in a turn answering only that message. Their summaries; a dispatched task is PENDING, never an answered question.
 */
// shortcut: with several messages a dispatch counts only when its text names the message id (first 8 hex), upgrade when dispatch tools carry messageId.
export function dispatchedAnswerOnly(requests: ReadonlyArray<{ summary: string; id?: string; answerOnly?: boolean }>,
  acts: ReadonlyArray<{ name: string; args: Record<string, unknown>; ok: boolean }>, replyTo: readonly string[]): string[] {
  const texts = acts.flatMap((act) => { const text = act.ok ? dispatchText(act) : null; return text === null ? [] : [text]; });
  if (!texts.length) return [];
  return requests.filter((request) => request.answerOnly && outcomeMessageIds(request.id, replyTo).some((id) =>
    replyTo.length === 1 && replyTo[0] === id || texts.some((text) => text.includes(id.slice(0, "nous_msg:".length + 8)))))
    .map((request) => request.summary);
}
// Each note parsed once per text (CPU report 12/11: a Requests derive parsed every open-request note six times, ~60 ms a call). Callers get
// shallow copies, so a nested value (tickets) is shared with the cache and must not be changed in place.
const parsedRequests = new Map<string, { text: string; entry: NousOpenRequest | null }>();
function requestsOf(notes: Array<{ key: string; text: string }>, closed: boolean): NousOpenRequest[] {
  return notes.flatMap((note) => {
    if (!note.key.startsWith(OPEN_REQUEST_PREFIX)) return [];
    let parsed = parsedRequests.get(note.key);
    if (parsed?.text !== note.text) {
      let entry: NousOpenRequest | null = null;
      try { entry = JSON.parse(note.text) as NousOpenRequest; } catch { /* a note that does not parse is no request */ }
      parsed = { text: note.text, entry: typeof entry?.summary === "string" ? entry : null };
      parsedRequests.set(note.key, parsed);
    }
    const entry = parsed.entry;
    return entry && Boolean(entry.closedAt) === closed && !entry.reopenedAt ? [{ ...entry, key: note.key }] : [];
  });
}
export const openRequestsOf = (notes: Array<{ key: string; text: string }>) => requestsOf(notes, false);
/** The panes that work on an open operator request: Space Gateway never holds their requests (operator rule 31/10, plan clipboard:DotwYXVD2N3n). */
export const priorityPanesOf = (notes: Array<{ key: string; text: string }>) =>
  [...new Set(openRequestsOf(notes).flatMap((entry) => entry.pane && /^pane:[A-Za-z0-9_-]{1,64}$/.test(entry.pane) ? [entry.pane] : []))];
export const closedRequestsOf = (notes: Array<{ key: string; text: string }>) => requestsOf(notes, true);
/** Each operator message's latest reopen (its fresh request's openedAt): what closed or recorded it before then no longer counts. */
export function reopenedAtOf(notes: Array<{ key: string; text: string }>): Map<string, string> {
  const at = new Map<string, string>();
  for (const entry of [...requestsOf(notes, false), ...requestsOf(notes, true)]) {
    if (entry.reopens && entry.messageId && entry.openedAt > (at.get(entry.messageId) ?? "")) at.set(entry.messageId, entry.openedAt);
  }
  return at;
}
/** D: the open requests with no outcome and no act for OPEN_QUIET_MS (the REVIEW's "no act for 6 h"). */
export const quietRequestsOf = (notes: Array<{ key: string; text: string }>, now: number) =>
  openRequestsOf(notes).filter((entry) => now - Date.parse([entry.reportedAt, entry.actedAt ?? ""].sort().at(-1)!) >= OPEN_QUIET_MS);
/** The same request: its plan, a shared ticket, its exact id, or 60 % of its words. */
function sameRequest(entry: NousOpenRequest, ref: { summary: string; id?: string; plan?: string; tickets?: string[] }, text = ref.summary): boolean {
  return (ref.plan !== undefined && entry.plan === ref.plan) || (ref.tickets ?? []).some((ticket) => entry.tickets?.includes(ticket))
    || (ref.id !== undefined && (ref.id === entry.requestId || ref.id === entry.messageId)) || overlap(titleWords(entry.summary), text) >= 0.6;
}
const recordLine = (record: SpaceNotification) => `notification ${record.id} (${record.createdAt.slice(0, 16).replace("T", " ")} UTC, "${String(payloadOf(record).request ?? record.body).slice(0, 120)}")`;

export function createNousRequestDone(deps: {
  notes: Pick<NousRepository, "listNotes" | "setNote" | "listTurnFacts" | "listAnswerLinks">;
  notifications: Pick<NotificationService, "list" | "raise">;
  plan(owner: string, id: string): Promise<ClipboardItem | null>;
  /** A plan whose Done was refused because it waits on the operator: open, under 100 %, waitsOn OPERATOR, so its Needs you item rises (plan-needs-you.ts). */
  holdForOperator?(owner: string, plan: ClipboardItem, what: string): Promise<void>;
  notice(owner: string, key: string, line: string, onDone?: () => Promise<void>, options?: { onDiscard?: () => Promise<void>; items?: NousTurnItem[] }): Promise<void>;
  /** The pane's done or failed report since `since` ("Andy reported done: …"), null when it has none. */
  paneFinished?(owner: string, paneId: string, since: string): Promise<string | null>;
  /** R21-5: false when the pane is closed or gone, null when it cannot be read now. */
  paneOpen?(paneId: string): Promise<boolean | null>;
  /** The ticket deployed and its commit is on stable's main. */
  ticketOnStable?(ticketId: string): Promise<boolean>;
  /** A merge-queue ticket's summary ("Promote dev …"), null when it is not found. */
  ticketSummary?(ticketId: string): Promise<string | null>;
  /** The Requests tab's status of these operator messages, judged without their open requests (requests.ts). */
  requestStatus?(owner: string, messageIds: string[]): Promise<Map<string, NousRequestStatus>>;
  now?: () => number;
}) {
  // Calls in concurrent Nous turns cannot both produce a receipt or overwrite a plan's reminder mark.
  const locks = new Map<string, Promise<unknown>>();
  async function serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const next = (locks.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
    locks.set(owner, next);
    try { return await next; } finally { if (locks.get(owner) === next) locks.delete(owner); }
  }
  const receiptKey = requestDoneReceiptKey;
  const marks = async (owner: string) => new Map((await deps.notes.listNotes(owner)).map((note) => [note.key, note.text]));
  const now = () => deps.now?.() ?? Date.now();
  const recent = async (owner: string, windowMs = DONE_WINDOW_MS) => {
    const since = now() - windowMs;
    const records: SpaceNotification[] = [];
    for (let before: string | undefined, page = 0; page < 10; page += 1) {
      const batch = await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE", limit: 200, ...(before ? { before } : {}) });
      records.push(...batch.filter((record) => Date.parse(record.createdAt) >= since));
      if (batch.length < 200 || Date.parse(batch.at(-1)!.createdAt) < since) break;
      before = batch.at(-1)!.createdAt;
    }
    return records;
  };
  const doneMatches = (record: SpaceNotification, request: { summary: string; id?: string; plan?: string }) => {
    const earlier = payloadOf(record);
    return (request.plan !== undefined && (earlier.planId === request.plan || record.dedupeKey === `nous:done:${request.plan}`))
      || (request.id !== undefined && record.dedupeKey === `nous:done:${request.id}`)
      || overlap(titleWords(request.summary), `${earlier.request ?? ""} ${earlier.summary ?? ""}`) >= 0.6;
  };
  const save = (owner: string, entry: NousOpenRequest) => { const { key, ...rest } = entry; return deps.notes.setNote(owner, key, JSON.stringify(rest)); };
  /** Never a delete: the note stays with its data, marked closed. */
  const close = (owner: string, entry: NousOpenRequest, reason: string) => save(owner, { ...entry, closedAt: new Date(now()).toISOString(), closedReason: clipWords(reason, 300) });
  /**
   * One reported outcome against the open requests: a PENDING one opens (or refreshes the same open request); any other outcome of the
   * same request closes it (its real end: done, the operator's, a pane's). Only an operator turn's PENDING request bound to an operator
   * message opens one (31/10: the backfill opened 478, mostly decision, inbox and standing turns'); other turns only refresh or close.
   */
  function apply(open: NousOpenRequest[], item: NousReportedOutcome, turnId: string, at: string, operatorTurn: boolean): { write?: NousOpenRequest; remove?: NousOpenRequest } {
    const messageId = item.messageIds?.[0] ?? null;
    const match = open.find((entry) => (messageId === null || entry.messageId === null || entry.messageId === messageId || entry.plan === item.plan) && sameRequest(entry, item));
    if (item.outcome !== "PENDING") {
      if (!match) return {};
      open.splice(open.indexOf(match), 1);
      return { remove: match };
    }
    if (!match && (!operatorTurn || messageId === null)) return {};
    const tickets = [...new Set([...(match?.tickets ?? []), ...(item.tickets ?? [])])];
    const entry: NousOpenRequest = match
      ? { ...match, summary: item.summary, reportedAt: at, ...(item.plan ? { plan: item.plan } : {}), ...(item.pane ? { pane: item.pane } : {}), ...(tickets.length ? { tickets } : {}) }
      : { key: `${OPEN_REQUEST_PREFIX}${createHash("sha256").update(`${messageId ?? turnId}|${item.summary}|${at}`).digest("hex").slice(0, 24)}`, messageId,
        ...(item.id ? { requestId: item.id } : {}), summary: item.summary, ...(item.plan ? { plan: item.plan } : {}), ...(item.pane ? { pane: item.pane } : {}),
        ...(tickets.length ? { tickets } : {}), turnId, openedAt: at, reportedAt: at };
    if (match) open[open.indexOf(match)] = entry; else open.push(entry);
    return { write: entry };
  }
  // A line waiting in Nous's inbox is not sent again each minute (a re-sent line restarts the inbox's batch window).
  const inFlight = new Set<string>();
  async function nudge(owner: string, key: string, line: string, onDone: () => Promise<void>, items?: NousTurnItem[]) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    await deps.notice(owner, key, line, async () => { inFlight.delete(key); await onDone(); }, { onDiscard: async () => { inFlight.delete(key); }, ...(items ? { items } : {}) });
  }
  async function evidenceOf(owner: string, entry: NousOpenRequest): Promise<string | null> {
    const plan = entry.plan ? await deps.plan(owner, entry.plan).catch(() => null) : null;
    if (plan && (plan.progressPercentage >= 100 || plan.executionStatus === "COMPLETED")) return `plan ${plan.id} is ${plan.progressPercentage}% (${plan.executionStatus.toLowerCase()})`;
    const pane = entry.pane && deps.paneFinished ? await deps.paneFinished(owner, entry.pane, entry.openedAt).catch(() => null) : null;
    if (pane) return pane;
    for (const ticket of entry.tickets ?? []) if (await deps.ticketOnStable?.(ticket).catch(() => false)) return `ticket ${ticket} is live on stable`;
    return null;
  }
  /** Once: every operator turn's PENDING outcome of the last 7 days with no Done record opens, bound to its turn's operator message; later outcomes close as today. */
  async function backfill(owner: string): Promise<void> {
    const since = new Date(now() - BACKFILL_MS).toISOString();
    const [turns, answers, done, notes] = await Promise.all([deps.notes.listTurnFacts(owner, since), deps.notes.listAnswerLinks(owner, since), recent(owner, BACKFILL_MS), deps.notes.listNotes(owner)]);
    const turnMessages = new Map(answers.filter((answer) => answer.turnId && answer.replyTo.length && !answer.interim).map((answer) => [answer.turnId!, answer.replyTo]));
    const open = openRequestsOf(notes);
    const writes = new Map<string, NousOpenRequest>();
    const removes = new Map<string, NousOpenRequest>();
    for (const turn of turns) for (const item of turn.outcomes) {
      const bound = { ...item, messageIds: item.messageIds ?? (turnMessages.get(turn.turnId) ?? []).slice(0, 1) };
      if (item.outcome === "PENDING" && done.some((record) => doneMatches(record, item))) continue;
      const change = apply(open, bound, turn.turnId, turn.endedAt, turn.reason === "OPERATOR");
      if (change.write) { writes.set(change.write.key, change.write); removes.delete(change.write.key); }
      if (change.remove) { const opened = writes.delete(change.remove.key); if (!opened) removes.set(change.remove.key, change.remove); }
    }
    for (const entry of writes.values()) await save(owner, entry);
    for (const entry of removes.values()) await close(owner, entry, `outcome reported in the backfill`);
    await deps.notes.setNote(owner, OPEN_BACKFILL_KEY, new Date(now()).toISOString());
  }
  /**
   * Once, after the first backfill (31/10: 478 opened, most of them decision, inbox and standing turns' long finished): closes, silently,
   * every open request with no operator message or opened by another turn kind, and every backfilled one whose message the Requests tab
   * reads as done or answered.
   */
  async function cleanup(owner: string, backfilledAt: string | undefined): Promise<void> {
    const open = openRequestsOf(await deps.notes.listNotes(owner));
    const since = open.reduce((first, entry) => entry.openedAt < first ? entry.openedAt : first, new Date(now()).toISOString());
    const reasons = new Map((await deps.notes.listTurnFacts(owner, new Date(Date.parse(since) - 86_400_000).toISOString())).map((turn) => [turn.turnId, turn.reason]));
    const kept: NousOpenRequest[] = [];
    for (const entry of open) {
      const reason = reasons.get(entry.turnId);
      if (entry.messageId === null || (reason !== undefined && reason !== "OPERATOR")) await close(owner, entry, "backfill: not an operator request");
      else if (backfilledAt && entry.openedAt <= backfilledAt) kept.push(entry);
    }
    const statuses = kept.length && deps.requestStatus ? await deps.requestStatus(owner, [...new Set(kept.map((entry) => entry.messageId!))]) : new Map<string, NousRequestStatus>();
    for (const entry of kept) if (["DONE", "ANSWERED"].includes(statuses.get(entry.messageId!) ?? "")) await close(owner, entry, "already done");
    await deps.notes.setNote(owner, OPEN_CLEANUP_KEY, new Date(now()).toISOString());
  }

  /** A Done record closes the open requests it matches: id, plan, a shared ticket, or 60 % of the open request's words in its request and summary. */
  async function closeOpen(owner: string, args: Args): Promise<void> {
    const text = `${args.request} ${args.summary}`;
    for (const entry of openRequestsOf(await deps.notes.listNotes(owner))) {
      if (sameRequest(entry, { summary: args.summary, ...(args.id ? { id: args.id } : {}), ...(args.plan ? { plan: args.plan } : {}), ...(args.tickets ? { tickets: args.tickets } : {}) }, text)) {
        await close(owner, entry, "recorded in Done");
      }
    }
  }

  /** space_request_done's record, unlocked: callers hold the owner's lock. */
  async function writeDone(owner: string, args: Args, origin?: string): Promise<{ ok: boolean; display: string; result: string; refused?: boolean }> {
    const identity = args.plan ?? args.id ?? origin;
    if (!identity) return { ok: false, display: "The request needs an identity", result: "Give the original request id for a request without a plan." };
    // Operator 13/11 14:39 BKK: six decisions left to them reached Done, where Got it buries them. What waits on them is a Needs you, never Done.
    const held = args.plan ? await deps.plan(owner, args.plan).catch(() => null) : null;
    const claim = waitsOnOperatorClaim([args.request, args.summary, args.verified].filter(Boolean).join("\n"));
    if (claim || held?.waitsOn?.kind === "OPERATOR") {
      const what = held?.waitsOn?.kind === "OPERATOR" ? held.waitsOn.what : claim!;
      if (held) await deps.holdForOperator?.(owner, held, what);
      return { ok: false, refused: true, display: "Waits on the operator: not Done",
        result: `Not recorded in Done: it leaves decisions or answers to the operator ("${clipWords(what, 160)}"). `
          + (held ? `${held.id} stays open under 100 % waiting on the operator. Ask them now with space_notify_operator with plan ${held.id} (a question, its options `
              + `and your recommendation; Approve / Reject for a yes/no); record Done once they have answered and the work is finished.`
            : "Ask them with space_notify_operator (with the plan if there is one); record Done once they have answered and the work is finished.") };
    }
    const key = receiptKey(identity);
    const saved = (await marks(owner)).get(key);
    if (saved) return { ok: true, display: "This request is already in Done", result: `Already recorded: ${saved}. The operator was not alerted again.` };
    const dedupeKey = `nous:done:${identity}`;
    // Covers a restart between raising the record and writing its delivery receipt, including an already ACKED record.
    const existing = (await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE", dedupeKey, limit: 1 }))[0];
    const { plan, id: _id, ...rest } = args;
    // 30/10: three turns recorded one Needs-you fix at 16:17, 16:27:16 and 16:27:32 UTC. A record of the last 24 h with the same
    // plan, a shared ticket or a summary sharing 60 % of its words is the same request: it is already in Done.
    if (!existing) {
      const words = titleWords(args.summary);
      // 31/10 00:33 BKK: a promote carries many requests; only a feature ticket makes two records one request.
      const tickets: string[] = [];
      for (const ticket of args.tickets ?? []) if (!/^Promote dev\b/i.test(await deps.ticketSummary?.(ticket).catch(() => null) ?? "")) tickets.push(ticket);
      const twin = (await recent(owner)).find((record) => {
        const earlier = payloadOf(record);
        return (plan !== undefined && earlier.planId === plan) || tickets.some((ticket) => earlier.tickets?.includes(ticket))
          || overlap(words, String(earlier.summary ?? "")) >= 0.6;
      });
      if (twin) await closeOpen(owner, args);
      if (twin) return { ok: false, refused: true, display: "Already in Done", result: `Already in Done: ${recordLine(twin)} records this request; nothing was recorded again.` };
    }
    const payload = requestDonePayloadSchema.parse({ ...rest, ...(plan ? { planId: plan } : {}) });
    await closeOpen(owner, args);
    const record = existing ?? await deps.notifications.raise({ ownerUserId: owner, roomId: null, paneId: null, source: "NOUS", kind: "REQUEST_DONE",
      severity: "ATTENTION", title: "Your request is done", body: args.verified ? `${args.summary}\nChecked: ${args.verified}` : args.summary, link: { surface: "nous", target: "done" }, dedupeKey, payload, telegram: null });
    if (!existing) emitMakeEvent(owner, "done", record.id, { id: record.id, summary: args.summary, planId: plan ?? null, tickets: args.tickets ?? [], verified: args.verified ?? null });
    await deps.notes.setNote(owner, key, record.id);
    return { ok: true, display: "Recorded the completed request in Done", result: `Notification ${record.id}. The operator can acknowledge it with Got it.` };
  }

  return {
    /** space_nous_outcome's requests (bound to their operator message): an operator turn's PENDING ones open, other outcomes of an open request close it. */
    async reported(owner: string, turnId: string, outcomes: NousReportedOutcome[], reason?: string): Promise<void> {
      await serial(owner, async () => {
        const open = openRequestsOf(await deps.notes.listNotes(owner));
        const at = new Date(now()).toISOString();
        for (const item of outcomes) {
          const change = apply(open, item, turnId, at, reason === "OPERATOR");
          if (change.write) await save(owner, change.write);
          if (change.remove) await close(owner, change.remove, `outcome ${item.outcome}`);
        }
      });
    },

    /** space_open_requests: every open request, newest first. */
    async openList(owner: string): Promise<NousOpenRequest[]> {
      return openRequestsOf(await deps.notes.listNotes(owner)).sort((left, right) => right.openedAt.localeCompare(left.openedAt));
    },

    /**
     * space_open_requests' close (the tool passes one item a call), by key or operator message, with no Done notification; a SELF or
     * HELPER close with `done` and this turn's `verified` writes one Done record per request (the note is its summary); DROPPED names why.
     */
    async closeMany(owner: string, items: NousOpenRequestClose[]): Promise<{ closed: number; done: number; lines: string[]; counts: NousCloseCounts }> {
      return serial(owner, async () => {
        const notes = await deps.notes.listNotes(owner);
        let open = openRequestsOf(notes);
        let closed = 0, done = 0;
        const lines: string[] = [];
        const counts: NousCloseCounts = { closed: 0, alreadyDone: 0, notOpen: 0, errors: [] };
        const refused = (line: string) => { lines.push(line); counts.errors.push(line); };
        // closeFile 6/11 (nous_msg:72999c27): a repeat of the same close answers already done instead of writing a second closed note.
        const closedBefore = new Set(closedRequestsOf(notes).flatMap((entry) => entry.messageId ? [`${entry.messageId}|${entry.closedReason?.split(":")[0]}`] : []));
        const receipts = new Set(notes.filter((note) => note.key.startsWith(`${REQUEST_DONE_NOTE_PREFIX}sent:`)).map((note) => note.key));
        // Nous 6/11 (801 Not done rows, nous_msg:1ac34ccd): a message with no open request is closed by its own closed note, its Done a receipt with no alert.
        const unopened = items.flatMap((item) => item.messageId && !open.some((entry) => entry.closedAt === undefined && entry.messageId === item.messageId) ? [item.messageId] : []);
        const statuses = unopened.length && deps.requestStatus ? await deps.requestStatus(owner, [...new Set(unopened)]) : new Map<string, NousRequestStatus>();
        for (const item of items) {
          const ref = item.key ?? item.messageId ?? "?";
          if (Boolean(item.key) === Boolean(item.messageId)) { refused(`${ref}: give its key or its messageId (one of them)`); continue; }
          if (item.done && (item.outcome === "OPERATOR" || item.outcome === "DROPPED")) { refused(`${ref}: done takes SELF or HELPER`); continue; }
          if (item.done && !item.where) { refused(`${ref}: done needs where (stable, dev or no code)`); continue; }
          if (item.done && (item.verified?.trim().length ?? 0) < CLOSE_EVIDENCE_MIN) { refused(`${ref}: done needs verified: what you checked in this turn on the real surface and what it showed (${CLOSE_EVIDENCE_MIN}+ characters); nothing was closed`); continue; }
          if (item.outcome === "DROPPED" && item.note.trim().length < CLOSE_EVIDENCE_MIN) { refused(`${ref}: DROPPED needs a note naming why it is no longer wanted (${CLOSE_EVIDENCE_MIN}+ characters); nothing was closed`); continue; }
          const short = item.key?.replace(OPEN_REQUEST_PREFIX, "");
          const targets = open.filter((entry) => entry.closedAt === undefined && (short ? entry.key === `${OPEN_REQUEST_PREFIX}${short}` : entry.messageId === item.messageId));
          if (!targets.length && item.messageId && statuses.has(item.messageId)) {
            if (statuses.get(item.messageId) === "DONE" || (item.done && receipts.has(receiptKey(item.messageId)))) { lines.push(`${ref}: already done`); counts.alreadyDone += 1; continue; }
            if (!item.done && closedBefore.has(`${item.messageId}|${item.outcome}`)) { lines.push(`${ref}: already closed ${item.outcome}`); counts.alreadyDone += 1; continue; }
            const at = new Date(now()).toISOString();
            await save(owner, { key: `${OPEN_REQUEST_PREFIX}${createHash("sha256").update(`${item.messageId}|close|${at}`).digest("hex").slice(0, 24)}`, messageId: item.messageId,
              summary: clipWords(item.note, 300), turnId: "space_open_requests", openedAt: at, reportedAt: at, closedAt: at, closedReason: clipWords(`${item.outcome}: ${item.note}`, 300) });
            closed += 1; counts.closed += 1;
            closedBefore.add(`${item.messageId}|${item.outcome}`);
            if (item.done) { await deps.notes.setNote(owner, receiptKey(item.messageId), `closed ${at} with no alert: ${clipWords(item.note, 300)}`); receipts.add(receiptKey(item.messageId)); done += 1; }
            lines.push(`${ref}: closed (no open request)${item.done ? ", recorded as done with no alert" : ""}`);
            continue;
          }
          if (!targets.length) { lines.push(`${ref}: no open request`); counts.notOpen += 1; continue; }
          counts.closed += 1;
          for (const entry of targets) {
            await close(owner, entry, `${item.outcome}: ${item.note}`);
            entry.closedAt = new Date(now()).toISOString();
            if (entry.messageId) closedBefore.add(`${entry.messageId}|${item.outcome}`);
            closed += 1;
            if (!item.done) continue;
            const id = entry.requestId ?? entry.messageId ?? undefined;
            const result = await writeDone(owner, { request: clipWords(entry.summary, 300), summary: clipWords(item.note, 600), where: item.where!, ...(item.verified ? { verified: item.verified } : {}),
              ...(entry.plan ? { plan: entry.plan } : id ? { id } : {}), ...(entry.tickets?.length ? { tickets: entry.tickets } : {}) }, entry.key);
            if (result.ok) done += 1;
            else counts.errors.push(`${ref}: closed, Done not recorded: ${clipWords(result.result, 200)}`);
            lines.push(`${ref}: ${result.result}`);
          }
          // A Done record also closes the open requests it matches.
          if (item.done) open = openRequestsOf(await deps.notes.listNotes(owner));
        }
        return { closed, done, lines, counts };
      });
    },

    /**
     * space_open_requests reopen (operator 6/11 nous_msg:2c610048, 9/11 nous_msg:a45dfd55): a message closed but not done goes back to work.
     * Its closes stay as notes marked reopened (the audit line), its own Done receipt goes, and a fresh open request carries the note;
     * no Done record and no other message's note is touched.
     */
    async reopen(owner: string, messageId: string, note: string): Promise<{ ok: boolean; line: string }> {
      return serial(owner, async () => {
        const notes = await deps.notes.listNotes(owner);
        if (openRequestsOf(notes).some((entry) => entry.messageId === messageId)) return { ok: false, line: `${messageId}: already open, nothing reopened` };
        if (deps.requestStatus && !(await deps.requestStatus(owner, [messageId])).has(messageId)) return { ok: false, line: `${messageId}: no such operator message, nothing reopened` };
        const at = new Date(now()).toISOString();
        const reason = clipWords(note, 300);
        const closes = closedRequestsOf(notes).filter((entry) => entry.messageId === messageId);
        for (const entry of closes) await save(owner, { ...entry, reopenedAt: at, reopenNote: reason });
        await deps.notes.setNote(owner, receiptKey(messageId), null);
        await save(owner, { key: `${OPEN_REQUEST_PREFIX}${createHash("sha256").update(`${messageId}|reopen|${at}`).digest("hex").slice(0, 24)}`, messageId,
          summary: reason, turnId: "space_open_requests:reopen", openedAt: at, reportedAt: at, reopens: true });
        return { ok: true, line: `${messageId}: reopened (${closes.length} close${closes.length === 1 ? "" : "s"} kept as reopened); it reads In progress until it is really done` };
      });
    },

    /** Called only after a successful space_plan_create, with the server's turn reason, never a model-supplied flag. */
    async created(owner: string, plan: ClipboardItem, turnId: string, reason?: string): Promise<void> {
      if (reason !== "OPERATOR") return;
      await serial(owner, async () => {
        const key = `${REQUEST_DONE_NOTE_PREFIX}plan:${plan.id}`;
        if ((await marks(owner)).has(key)) return;
        await deps.notes.setNote(owner, key, JSON.stringify({ planId: plan.id, title: plan.title ?? "Your request", operatorTurn: turnId } satisfies PlanMark));
      });
    },

    async run(owner: string, args: Args, origin?: string): Promise<{ ok: boolean; display: string; result: string; refused?: boolean }> {
      return serial(owner, () => writeDone(owner, args, origin));
    },

    /**
     * The completed requests of an operator turn that have no Done record of the last 24 h: none with their id or plan, and none
     * whose request and summary hold 60 % of their words (operator 31/10 00:07 BKK: everything completed goes to Done).
     */
    async unrecorded<T extends { summary: string; id?: string; plan?: string }>(owner: string, requests: T[]): Promise<T[]> {
      if (!requests.length) return [];
      const records = await recent(owner);
      return requests.filter((request) => !records.some((record) => {
        const earlier = payloadOf(record);
        return (request.plan !== undefined && (earlier.planId === request.plan || record.dedupeKey === `nous:done:${request.plan}`))
          || (request.id !== undefined && record.dedupeKey === `nous:done:${request.id}`)
          || overlap(titleWords(request.summary), `${earlier.request ?? ""} ${earlier.summary ?? ""}`) >= 0.6;
      }));
    },

    /**
     * Corrections 13/11 (nous_msg:4258ef8d read Done with LiveKit's work, 04ced2b1 with the public-host disk's, 1b58b47e with Settings ⓘ's): a request
     * reported with no id or plan takes the id of the open request it matches (one this turn answers first, else the newest), or of one its
     * Done record closed in Done's 24 h window (the outcome reported again after that record), never simply the message this turn answers.
     */
    async named<T extends { summary: string; id?: string; plan?: string; tickets?: string[] }>(owner: string, requests: T[], replyTo: readonly string[]): Promise<T[]> {
      if (requests.every((request) => request.id || request.plan)) return requests;
      const notes = await deps.notes.listNotes(owner);
      const since = new Date(now() - DONE_WINDOW_MS).toISOString();
      const answered = (entry: NousOpenRequest) => Number(replyTo.includes(entry.messageId!));
      const ordered = (entries: NousOpenRequest[]) => entries.filter((entry) => entry.messageId)
        .sort((left, right) => answered(right) - answered(left) || right.openedAt.localeCompare(left.openedAt));
      const known = [...ordered(openRequestsOf(notes)), ...ordered(closedRequestsOf(notes).filter((entry) => entry.closedReason === "recorded in Done" && entry.closedAt! >= since))];
      return requests.map((request) => {
        const entry = request.id || request.plan ? undefined : known.find((candidate) => sameRequest(candidate, request));
        return entry ? { ...request, id: entry.requestId ?? entry.messageId! } : request;
      });
    },

    /**
     * The stable minute tick: one inbox key per completed operator plan, closed durably after Nous handles the line; then the open
     * requests: one line per request that looks finished (its plan at 100 %, its pane's done or failed report, its ticket live on
     * stable), and once a day one line for those with nothing new for 6 hours.
     */
    /** C: the evidence that an open request looks finished (its plan at 100 %, its pane's done report, its ticket on stable), or null. */
    evidence: (owner: string, entry: NousOpenRequest) => evidenceOf(owner, entry),
    /**
     * Queue 1002 (8/11: requests sat 6+ hours bound to panes of a closed room): an open request whose pane is closed or gone follows the pane a
     * successful send naming its message (first 8 hex), request id or plan gave the work to, so its later lines read that pane.
     */
    async rebound(owner: string, sends: ReadonlyArray<{ paneId: string; text: string }>): Promise<void> {
      await serial(owner, async () => {
        for (const entry of openRequestsOf(await deps.notes.listNotes(owner))) {
          const refs = [entry.messageId?.slice(0, "nous_msg:".length + 8), entry.requestId, entry.plan].filter((ref): ref is string => Boolean(ref));
          const to = entry.pane ? sends.find((send) => send.paneId !== entry.pane && refs.some((ref) => send.text.includes(ref))) : undefined;
          if (!to || await deps.paneOpen?.(entry.pane!).catch(() => null) !== false) continue;
          await save(owner, { ...entry, pane: to.paneId, paneGone: undefined });
        }
      });
    },
    /** Hold A: the turn acted on these open requests (their keys); the REVIEW's "no act for 6 h" counts from then. */
    async acted(owner: string, keys: string[]): Promise<void> {
      await serial(owner, async () => {
        const at = new Date(now()).toISOString();
        for (const entry of openRequestsOf(await deps.notes.listNotes(owner)).filter((item) => keys.includes(item.key))) await save(owner, { ...entry, actedAt: at });
      });
    },

    async tick(owner: string): Promise<void> {
      await serial(owner, async () => {
        if (!(await marks(owner)).has(OPEN_BACKFILL_KEY)) await backfill(owner);
        const before = await marks(owner);
        if (!before.has(OPEN_CLEANUP_KEY)) await cleanup(owner, before.get(OPEN_BACKFILL_KEY));
        const notes = await marks(owner);
        for (const [key, text] of notes) {
          if (!key.startsWith(`${REQUEST_DONE_NOTE_PREFIX}plan:`)) continue;
          const mark = JSON.parse(text) as PlanMark;
          if (mark.reminded || notes.has(receiptKey(mark.planId))) continue;
          const plan = await deps.plan(owner, mark.planId);
          if (!plan || (plan.progressPercentage < 100 && plan.executionStatus !== "COMPLETED")) continue;
          const existing = await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE", dedupeKey: `nous:done:${mark.planId}`, limit: 1 });
          if (existing.length) continue;
          await deps.notice(owner, `request-done:${mark.planId}`, `The operator's request "${mark.title.slice(0, 160)}" (${mark.planId}) is done: write its summary with space_request_done when it is live where they use it.`,
            async () => { await deps.notes.setNote(owner, key, JSON.stringify({ ...mark, reminded: true })); });
        }
        const open = openRequestsOf([...notes].map(([key, text]) => ({ key, text })));
        const quiet: NousOpenRequest[] = [];
        // R22-4 (1/11: nous_msg:cc96… read "lost its pane" while its plan 93WlxXgZhOkv was COMPLETED and "looks finished" was said): a request
        // that looks finished, or shares its message or plan with one said to look finished in this tick, never also reads "lost its pane".
        const evidences = new Map<string, string | null>();
        for (const entry of open) evidences.set(entry.key, await evidenceOf(owner, entry));
        const refsOf = (entry: NousOpenRequest) => [entry.messageId, entry.plan].filter((ref): ref is string => Boolean(ref));
        const toldFinished = new Set(open.flatMap((entry) => evidences.get(entry.key) && evidences.get(entry.key) !== entry.evidence ? refsOf(entry) : []));
        for (const entry of open) {
          const evidence = evidences.get(entry.key) ?? null;
          const ref = entry.requestId ?? entry.messageId;
          if (evidence && evidence !== entry.evidence) {
            const line = `Request "${clipWords(entry.summary, 140)}"${ref ? ` (${ref})` : ""} looks finished: ${clipWords(evidence, 140)}; `
              + "record it with space_request_done or keep it PENDING with a reason (space_nous_outcome).";
            // Hold A: the turn that carries this line acts on it before it may answer NOTHING_NEW (31/10 11:18 UTC: consumed with nothing done).
            await nudge(owner, `request-open:${entry.key.slice(OPEN_REQUEST_PREFIX.length)}`, line, async () => {
              const current = openRequestsOf(await deps.notes.listNotes(owner)).find((item) => item.key === entry.key);
              if (current) await save(owner, { ...current, evidence });
            }, [{ key: `request:${entry.key}`, kind: "REQUEST", line, requestKey: entry.key, ...(entry.messageId ? { messageId: entry.messageId } : {}),
              ...(entry.plan ? { plan: entry.plan } : {}), ...(entry.pane ? { pane: entry.pane } : {}) }]);
          } else if (!evidence && !refsOf(entry).some((item) => toldFinished.has(item)) && entry.pane && entry.paneGone !== entry.pane
            && await deps.paneOpen?.(entry.pane).catch(() => null) === false) {
            // R21-5 (REVIEW 1/11: a725f601 sat 6+ hours on a closed pane): a request whose pane closed or went is an item at once.
            const pane = entry.pane;
            const line = `Request "${clipWords(entry.summary, 140)}"${ref ? ` (${ref})` : ""} lost its pane: ${pane} is closed or gone. Reopen it `
              + `(space_execute {"kind":"pane","operation":"reopen","target":{"paneIds":["${pane}"]}}) or reassign the request to another pane naming ${ref ?? "it"} `
              + "(space_open_panes, space_send_to_pane), or record it done or what it waits on (space_request_done, space_nous_outcome).";
            await nudge(owner, `request-pane:${entry.key.slice(OPEN_REQUEST_PREFIX.length)}`, line, async () => {
              const current = openRequestsOf(await deps.notes.listNotes(owner)).find((item) => item.key === entry.key);
              if (current) await save(owner, { ...current, paneGone: pane });
            }, [{ key: `request:${entry.key}`, kind: "REQUEST", line, requestKey: entry.key, ...(entry.messageId ? { messageId: entry.messageId } : {}),
              ...(entry.plan ? { plan: entry.plan } : {}), pane }]);
          } else if (now() - Date.parse(entry.reportedAt) >= OPEN_QUIET_MS) quiet.push(entry);
        }
        const today = new Date(now()).toISOString().slice(0, 10);
        if (quiet.length && notes.get(OPEN_DAILY_KEY) !== today) {
          const oldest = quiet.reduce((first, entry) => entry.openedAt < first.openedAt ? entry : first);
          await nudge(owner, "request-open:daily", `${quiet.length} open request${quiet.length === 1 ? "" : "s"} of the operator's had nothing new for 6 hours (oldest ${oldest.openedAt.slice(0, 16).replace("T", " ")} UTC: `
            + `"${clipWords(oldest.summary, 100)}"). Read them with space_open_requests; record each finished one with space_request_done, re-report the rest PENDING with what they wait on, `
            + "or close one with its real outcome in space_nous_outcome.", async () => { await deps.notes.setNote(owner, OPEN_DAILY_KEY, today); });
        }
      });
    }
  };
}
export type NousRequestDone = ReturnType<typeof createNousRequestDone>;
