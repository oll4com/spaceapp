import { NOUS_ATTACHMENTS_MARKER, nousRequestStatusSchema, type ClipboardItem, type NousDecision, type NousMessage, type NousOperatorRequest, type NousRequestStatus, type NousTurnOutcome,
  nousDecisionRunsWhen, type RequestDonePayload, type SpaceNotification } from "@space/contracts";
import type { NousAnswerLink, NousNote, NousRepository, NousTurnOutcomes } from "@space/db";
import type { NotificationService } from "../notifications/service.js";
import { titleWords } from "./pane-notices.js";
import { closedRequestsOf, OPEN_REQUEST_PREFIX, openRequestsOf, reopenedAtOf, REQUEST_DONE_NOTE_PREFIX, requestDoneReceiptKey } from "./request-done.js";

/**
 * The Requests tab (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): every message the operator sent Nous, newest first, with how
 * it ended. Links are exact: a Done record or receipt naming the message, the turn that answered it or its plan; the outcome Nous reported
 * for it (the turn's facts keep the message ids); an open request it left PENDING; an open decision on its plan; the answer that covered it. Words decide (request-done.ts's
 * 60 % rule) only for a message with no exact link at all, i.e. the rows from before 31/10.
 */
export interface NousRequestLinks {
  answers: NousAnswerLink[];
  /** Oldest first. */
  turns: NousTurnOutcomes[];
  /** REQUEST_DONE records, newest first. */
  done: SpaceNotification[];
  notes: NousNote[];
  openDecisions: NousDecision[];
}
type PlanInfo = Pick<ClipboardItem, "progressPercentage" | "isCompleted" | "executionStatus"> | null;
export type NousRequestPlans = Map<string, PlanInfo>;

const DONE_KEY = "nous:done:";
const payloadOf = (record: SpaceNotification) => record.payload as Partial<RequestDonePayload>;
const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
const textOf = (content: string) => { const at = content.indexOf(NOUS_ATTACHMENTS_MARKER); return (at < 0 ? content : content.slice(0, at)).trim(); };
// Search (operator 6/11 13:02 BKK): case and accents folded, so «αιτηματα» finds «αιτήματα».
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const open = (plan: PlanInfo | undefined) => Boolean(plan && !plan.isCompleted && plan.executionStatus !== "COMPLETED" && plan.progressPercentage < 100);
const completed = (plan: PlanInfo | undefined) => Boolean(plan && !open(plan));

// Built once per links object (requestPlanIds and deriveNousRequests read the same derive's links, never changed once built).
const indexes = new WeakMap<NousRequestLinks, ReturnType<typeof buildIndex>>();
function index(links: NousRequestLinks) {
  let built = indexes.get(links);
  if (!built) { built = buildIndex(links); indexes.set(links, built); }
  return built;
}
/** Which turns answered which messages, the outcomes reported for each message and the plans linked to it. */
function buildIndex(links: NousRequestLinks) {
  const turnMessages = new Map<string, string[]>();
  for (const answer of links.answers) if (answer.turnId && !answer.interim) for (const id of answer.replyTo) push(turnMessages, answer.turnId, id);
  const outcomes = new Map<string, Array<{ endedAt: string; items: NousTurnOutcome[] }>>();
  const plans = new Map<string, string[]>();
  for (const turn of links.turns) {
    // Outcomes from before 31/10 carry no message ids: they cover the messages their turn's answer named.
    const perMessage = new Map<string, NousTurnOutcome[]>();
    for (const item of turn.outcomes) for (const id of item.messageIds ?? turnMessages.get(turn.turnId) ?? []) push(perMessage, id, item);
    for (const [id, items] of perMessage) {
      push(outcomes, id, { endedAt: turn.endedAt, items });
      for (const item of items) if (item.plan) push(plans, id, item.plan);
    }
  }
  // A request Nous left PENDING stays open until closed (operator 31/10 10:17 BKK): its message reads In progress, its plan is linked.
  const openMessages = new Set<string>();
  for (const entry of openRequestsOf(links.notes)) if (entry.messageId) { openMessages.add(entry.messageId); if (entry.plan) push(plans, entry.messageId, entry.plan); }
  // A closed one (space_open_requests close, a Done record, its later outcome) ends the PENDING that opened it (operator 31/10 13:03 BKK: closed requests read In progress).
  const closedAt = new Map<string, string>();
  // An explicit DROPPED close (space_open_requests) ends a request without a Done record; any other close without one leaves it Not done.
  const dropped = new Set<string>();
  for (const entry of closedRequestsOf(links.notes)) if (entry.messageId) {
    if (entry.closedAt! > (closedAt.get(entry.messageId) ?? "")) closedAt.set(entry.messageId, entry.closedAt!);
    if (entry.closedReason?.startsWith("DROPPED")) dropped.add(entry.messageId);
    if (entry.plan) push(plans, entry.messageId, entry.plan);
  }
  // A plan Nous created in an operator turn belongs to the messages that turn answered (request-done.ts's plan mark).
  for (const note of links.notes) {
    if (!note.key.startsWith(`${REQUEST_DONE_NOTE_PREFIX}plan:`)) continue;
    try {
      const mark = JSON.parse(note.text) as { planId?: unknown; operatorTurn?: unknown };
      if (typeof mark.planId === "string" && typeof mark.operatorTurn === "string") for (const id of turnMessages.get(mark.operatorTurn) ?? []) push(plans, id, mark.planId);
    } catch { /* a mark that does not parse links nothing */ }
  }
  return { turnMessages, outcomes, plans, openMessages, closedAt, dropped };
}

/**
 * The first answer (`final`: the first not interim), in list order, that replies to a message or started at or after it, in O(log n): per id the
 * first index naming it, and the running maximum of startedAt, whose first index reaching a time is the first answer started then or later.
 */
function firstAnswers(answers: NousAnswerLink[]) {
  const lists = [false, true].map((final) => {
    const kept = answers.filter((answer) => !final || !answer.interim);
    const byId = new Map<string, number>();
    const reach: string[] = [];
    kept.forEach((answer, at) => {
      for (const id of answer.replyTo) if (!byId.has(id)) byId.set(id, at);
      reach.push(at && reach[at - 1]! > answer.startedAt ? reach[at - 1]! : answer.startedAt);
    });
    return { kept, byId, reach };
  });
  return (id: string, from: string, final: boolean): NousAnswerLink | undefined => {
    const { kept, byId, reach } = lists[final ? 1 : 0]!;
    let low = 0;
    for (let high = reach.length; low < high;) { const mid = (low + high) >> 1; if (reach[mid]! >= from) high = mid; else low = mid + 1; }
    return kept[Math.min(byId.get(id) ?? Infinity, low)];
  };
}

/**
 * request-done.ts's 60 % rule through the records' words (CPU report 12/11: comparing every unclaimed record with every old message was the
 * derive's largest cost): the first record, in list order, written at or after `from` whose words (at least two) are 60 % in `text`.
 */
function wordMatcher(records: SpaceNotification[], skip: (record: SpaceNotification) => boolean) {
  const sizes: number[] = [];
  const postings = new Map<string, number[]>();
  records.forEach((record, at) => {
    const words = skip(record) ? new Set<string>() : titleWords(String(payloadOf(record).request ?? ""));
    sizes.push(words.size);
    if (words.size >= 2) for (const word of words) push(postings, word, at);
  });
  return (text: Set<string>, from: string): SpaceNotification | undefined => {
    const shared = new Map<number, number>();
    for (const word of text) for (const at of postings.get(word) ?? []) shared.set(at, (shared.get(at) ?? 0) + 1);
    let first = Infinity;
    for (const [at, count] of shared) if (at < first && count / sizes[at]! >= 0.6 && records[at]!.createdAt >= from) first = at;
    return records[first];
  };
}

/** The plans the page's messages are linked to, so their progress is read once. */
export function requestPlanIds(messages: NousMessage[], links: NousRequestLinks): string[] {
  const { plans } = index(links);
  return [...new Set(messages.flatMap((message) => plans.get(message.id) ?? []))];
}

/**
 * `latestOperatorAt`: the operator's newest message overall; null when a newer one exists than the given messages (an earlier page).
 * `untrackedPending`: a PENDING outcome with no open request counts as in progress (the one-time cleanup judges messages without their open requests).
 */
export function deriveNousRequests(messages: NousMessage[], links: NousRequestLinks, planInfo: NousRequestPlans,
  latestOperatorAt: string | null = messages[0]?.createdAt ?? null, untrackedPending = false): NousOperatorRequest[] {
  const { turnMessages, outcomes, plans, openMessages, closedAt, dropped } = index(links);
  const receipts = new Map(links.notes.filter((note) => note.key.startsWith(`${REQUEST_DONE_NOTE_PREFIX}sent:`)).map((note) => [note.key, note.updatedAt]));
  const reopened = reopenedAtOf(links.notes);
  const identity = (record: SpaceNotification) => record.dedupeKey?.startsWith(DONE_KEY) ? record.dedupeKey.slice(DONE_KEY.length) : null;
  // A record named by a message or a turn's id is that request's; only the others are left to words.
  const claimed = (record: SpaceNotification) => { const id = identity(record); return Boolean(id && (id.startsWith("nous_msg:") || turnMessages.has(id))); };
  // Indexed once (stable 4/11: scanning every turn, Done record and answer for each message held the API's main thread ~1 s a call).
  const messageTurns = new Map<string, string[]>();
  for (const [turnId, ids] of turnMessages) for (const id of new Set(ids)) push(messageTurns, id, turnId);
  // The first Done record whose identity or plan is a value; "-N" (one of several requests in a message) is cut only to name the message.
  const doneByValue = new Map<string, number>();
  const doneByMessage = new Map<string, number>();
  links.done.forEach((record, at) => {
    for (const value of [identity(record), payloadOf(record).planId]) if (typeof value === "string" && value) {
      if (!doneByValue.has(value)) doneByValue.set(value, at);
      const base = value.replace(/-\d+$/, "");
      if (!doneByMessage.has(base)) doneByMessage.set(base, at);
    }
  });
  let byWords: ReturnType<typeof wordMatcher> | undefined;
  const answerOf = firstAnswers(links.answers);
  return messages.map((message) => {
    const id = message.id;
    const turns = messageTurns.get(id) ?? [];
    const linkedPlans = [...new Set(plans.get(id) ?? [])];
    // A plan-keyed Done or receipt is one request of that plan: it covers this message only once the plan is completed (9/11: an open
    // Upwork plan's record read two not-done Braintrust messages Done); while the plan is open the message reads In progress.
    const donePlans = linkedPlans.filter((planId) => completed(planInfo.get(planId)));
    // A reopened message (space_open_requests reopen): what recorded it before then no longer counts.
    const since = reopened.get(id);
    // Exact: the record's identity is this message (one of several requests in it: "-N"), a turn that answered it or a completed plan linked to it.
    const exact = Math.min(doneByValue.get(id) ?? Infinity, doneByMessage.get(id) ?? Infinity, ...[...turns, ...donePlans].map((value) => doneByValue.get(value) ?? Infinity));
    let done: SpaceNotification | undefined = since && links.done[exact] && links.done[exact]!.createdAt <= since ? undefined : links.done[exact];
    const reported = outcomes.get(id) ?? [];
    if (!done && !since && !reported.length && !linkedPlans.length) {
      byWords ??= wordMatcher(links.done, claimed);
      done = byWords(titleWords(textOf(message.content)), message.createdAt);
    }
    const receipted = !done && [id, ...turns, ...donePlans].some((value) => { const at = receipts.get(requestDoneReceiptKey(value)); return at !== undefined && (!since || at > since); });
    const last = reported.at(-1);
    const latest = last?.items.map((item) => item.outcome) ?? [];
    // An OPERATOR outcome waits while the decision that turn asked is open, or until the operator writes again (their reply is the answer).
    const asked = last !== undefined && latest.includes("OPERATOR") && (latestOperatorAt === null || latestOperatorAt > last.endedAt
      ? links.openDecisions.some((decision) => decision.createdAt >= message.createdAt && decision.createdAt <= last.endedAt) : true);
    const plan = linkedPlans.find((planId) => open(planInfo.get(planId))) ?? linkedPlans.find((planId) => planInfo.get(planId));
    const waits = links.openDecisions.some((decision) => decision.refs.planId !== undefined && linkedPlans.includes(decision.refs.planId));
    // In progress only through its open request (every operator PENDING opens one since 31/10; a close or Done ends it): a PENDING never tracked reads
    // Not done (operator 31/10 16:12 BKK: 99 messages read In progress, 11 open requests existed; 6/11: never Answered). HELPER without a Done record is Not done too.
    const closed = closedAt.get(id);
    const pending = untrackedPending && latest.includes("PENDING") && !(closed && closed >= last!.endedAt);
    const covered = answerOf(id, message.createdAt, true)?.createdAt ?? reported[0]?.endedAt;
    // The Score's first answer: an operator turn's space_reply_now reaches the chat before its final answer (operator 20/10 «answer me at once, then continue»).
    const replied = answerOf(id, message.createdAt, false)?.createdAt;
    // Answered only for a pure question: its latest outcome items are all answerOnly (operator 6/11 nous_msg:2c610048: an answer is not completion).
    // A message with a plan reads Answered: the Plans tab follows it, Requests only what still waits here in the chat (operator 11/11 09:10 BKK
    // nous_msg:bd13f6b2, after 144 In progress, ~131 held by open plans).
    const answered = Boolean(last?.items.every((item) => item.answerOnly)) || dropped.has(id) || Boolean(plan);
    const status: NousRequestStatus = done || receipted ? "DONE"
      : asked || waits ? "WAITS_FOR_YOU"
      : pending || openMessages.has(id) ? "IN_PROGRESS"
      : answered ? "ANSWERED"
      : covered || closed || last ? "NOT_DONE" : "NOT_ANSWERED";
    const payload = done ? payloadOf(done) : null;
    return {
      messageId: id, createdAt: message.createdAt, text: textOf(message.content), status,
      ...(payload?.summary ? { doneSummary: payload.summary } : {}), ...(payload?.where ? { where: payload.where } : {}), ...(payload?.tickets?.length ? { tickets: payload.tickets } : {}),
      ...(plan ? { planId: plan, planPercent: planInfo.get(plan)!.progressPercentage } : payload?.planId ? { planId: payload.planId } : {}),
      ...(covered ? { answeredAt: covered } : {}), ...(replied ?? covered ? { repliedAt: [replied, covered].filter(Boolean).sort()[0] } : {}), ...(done ? { doneAt: done.createdAt } : {})
    };
  });
}

export function createNousRequests(deps: {
  repository: Pick<NousRepository, "listOperatorMessages" | "listAnswerLinks" | "listTurnOutcomes" | "listNotes" | "listDecisions">;
  notifications: Pick<NotificationService, "list">;
  plan(owner: string, id: string): Promise<ClipboardItem | null>;
}) {
  /** The Done records written since `since`, newest first (paged 200 at a time). */
  async function doneSince(owner: string, since: string): Promise<SpaceNotification[]> {
    const records: SpaceNotification[] = [];
    for (let before: string | undefined, page = 0; page < 20; page += 1) {
      const batch = await deps.notifications.list(owner, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE", limit: 200, ...(before ? { before } : {}) });
      records.push(...batch.filter((record) => record.createdAt >= since));
      if (batch.length < 200 || batch.at(-1)!.createdAt < since) break;
      before = batch.at(-1)!.createdAt;
    }
    return records;
  }
  // CPU report 12/11: every derive read all ~1,900 operator messages again. They never change once written (inserted DONE, never updated or
  // deleted), so each owner's stay here, newest first, and a derive reads only those written since the newest kept one.
  const kept = new Map<string, NousMessage[]>();
  async function operatorMessages(owner: string): Promise<NousMessage[]> {
    const old = kept.get(owner) ?? [];
    // created_at is the insert's transaction start, so a row that commits late can sort behind one already read: the last 10 minutes are read again.
    const from = old[0] && new Date(Date.parse(old[0].createdAt) - 600_000).toISOString();
    const messages: NousMessage[] = [];
    for (let before: string | undefined; ;) {
      const rows = await deps.repository.listOperatorMessages(owner, { ...(before ? { before } : {}), ...(from ? { since: from } : {}), limit: 500 });
      messages.push(...rows);
      if (rows.length < 500) break;
      before = rows.at(-1)!.id;
    }
    if (from) messages.push(...old.filter((message) => message.createdAt < from));
    kept.set(owner, messages);
    return messages;
  }
  // The dock's badge and tab poll every 20 s and Nous reads the counts each turn: calls that meet share one derive.
  const running = new Map<string, Promise<NousOperatorRequest[]>>();
  /** Every operator message, newest first; `withOpen` false judges them without their open requests. */
  function derive(owner: string, withOpen = true): Promise<NousOperatorRequest[]> {
    const key = `${owner}|${withOpen}`;
    let pending = running.get(key);
    if (!pending) {
      pending = deriveNow(owner, withOpen).finally(() => running.delete(key));
      running.set(key, pending);
    }
    return pending;
  }
  async function deriveNow(owner: string, withOpen: boolean): Promise<NousOperatorRequest[]> {
    const messages = await operatorMessages(owner);
    if (!messages.length) return [];
    const since = messages.at(-1)!.createdAt;
    const [answers, turns, done, notes, openDecisions] = await Promise.all([deps.repository.listAnswerLinks(owner, since), deps.repository.listTurnOutcomes(owner, since),
      doneSince(owner, since), deps.repository.listNotes(owner), deps.repository.listDecisions(owner, { statuses: ["OPEN"] })
        .then((open) => open.filter((decision) => !nousDecisionRunsWhen(decision)))]);
    const links = { answers, turns, done, notes: withOpen ? notes : notes.filter((note) => !note.key.startsWith(OPEN_REQUEST_PREFIX)), openDecisions };
    const plans: NousRequestPlans = new Map(await Promise.all(requestPlanIds(messages, links).map(async (id) => [id, await deps.plan(owner, id).catch(() => null)] as const)));
    return deriveNousRequests(messages, links, plans, messages[0]!.createdAt, !withOpen);
  }
  return {
    /**
     * `counts` cover every message (the tab's status filter, operator 31/10 13:03 BKK); `status` filters the page. `since` is the owner's
     * History period (history-period-routes.ts): a Done or Answered request older than it leaves the tab; one still open stays.
     * `q` keeps the requests whose text or Done summary holds any of its words (operator 6/11 «την μια ή πολλες»); counts follow it.
     */
    async page(owner: string, options: { before?: string; limit: number; status?: NousRequestStatus; since?: string; q?: string }):
      Promise<{ requests: NousOperatorRequest[]; hasMore: boolean; counts: Record<NousRequestStatus, number> }> {
      let all = (await derive(owner)).filter((request) => !options.since || (request.status !== "DONE" && request.status !== "ANSWERED")
        || Date.parse(request.createdAt) >= Date.parse(options.since));
      const words = fold(options.q ?? "").split(/\s+/u).filter(Boolean);
      if (words.length) all = all.filter((request) => { const text = fold(`${request.text}\n${request.doneSummary ?? ""}`); return words.some((word) => text.includes(word)); });
      const counts = Object.fromEntries(nousRequestStatusSchema.options.map((status) => [status, 0])) as Record<NousRequestStatus, number>;
      for (const request of all) counts[request.status] += 1;
      const at = options.before ? all.findIndex((request) => request.messageId === options.before) : -1;
      const rest = (options.before ? (at < 0 ? [] : all.slice(at + 1)) : all).filter((request) => !options.status || request.status === options.status);
      return { requests: rest.slice(0, options.limit), hasMore: rest.length > options.limit, counts };
    },

    /** The operator's messages written since `since`, as the tab reads them (the Score's response times). */
    since: async (owner: string, since: string) => (await derive(owner)).filter((request) => request.createdAt >= since),

    /** These messages' status as the tab reads it, without their own open requests (request-done.ts's one-time cleanup, 31/10). */
    async statuses(owner: string, ids: string[]): Promise<Map<string, NousRequestStatus>> {
      const wanted = new Set(ids);
      return new Map((await derive(owner, false)).filter((request) => wanted.has(request.messageId)).map((request) => [request.messageId, request.status]));
    }
  };
}
export type NousRequests = ReturnType<typeof createNousRequests>;
