import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  inboxActInputSchema, inboxBadge, inboxDoneAllInputSchema, inboxPlainLine, inboxQuerySchema, inboxRequestNews, inboxTabOf, inboxThreadCounts, inboxThreadState, type InboxActInput, type InboxActResult, type InboxEvent, type InboxPage,
  type InboxThread, type InboxThreadView, type NotificationAnswerResult, type NotificationStatus, type NousDecision, type NousDecisionAnswerInput, type SpaceNotification
} from "@space/contracts";
import type { InboxRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { rankByWords } from "../nous/retrieval.js";
import type { InboxService } from "./service.js";

/**
 * «Εισερχόμενα» v2 step 2 (spec v2 §10, plan clipboard:aE7U1J_gU9OV): the Threads read, and the verbs on them. Every verb writes through the
 * source's own guarded path (the needs-you answer, Nous's decision answer or dismiss, the notification store); the Thread follows its records.
 */
export interface InboxRoutesDeps {
  routeOptions: Record<string, unknown>;
  owner(request: FastifyRequest): Promise<string>;
  assertPerson(request: FastifyRequest): void;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  repository: InboxRepository;
  inbox: Pick<InboxService, "syncRef" | "closeByOperator" | "seenProgress" | "badge">;
  notifications: {
    get(owner: string, id: string): Promise<SpaceNotification | null>;
    setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>, reason?: string): Promise<SpaceNotification | null>;
  };
  answerNeedsYou(request: FastifyRequest, id: string, input: { option?: string; text?: string; always?: boolean }): Promise<NotificationAnswerResult>;
  answerDecision(owner: string, id: string, input: NousDecisionAnswerInput): Promise<NousDecision>;
  dismissDecision(owner: string, id: string): Promise<NousDecision | null>;
}

const RANK = { URGENT: 2, ATTENTION: 1, INFO: 0 } as const;
const SEEN = new Set(["REPORT", "UPDATE", "ALERT"]);
const newest = (left: InboxThread, right: InboxThread) => right.lastEventAt.localeCompare(left.lastEventAt) || right.id.localeCompare(left.id);
const waits = (record: SpaceNotification) => record.status === "OPEN" || record.status === "READ";
const isDecision = (ref: string) => ref.startsWith("nous_decision:");
const isRequest = (ref: string) => ref.startsWith("nous_msg:");
const ALREADY = "Already answered.";

export function registerInboxRoutes(app: FastifyInstance, deps: InboxRoutesDeps): void {
  const { routeOptions, repository, inbox } = deps;

  function viewFrom(thread: InboxThread, events: InboxEvent[]) {
    const state = inboxThreadState(events, thread.title);
    // Plan LkwKdOOh2mXK step 1: what waits only on Nous or an agent is held (a folded line), never the operator's card or count.
    const held = !thread.closedAt && state.waitingFor === "NOUS" && !state.unseen && !state.openRequest;
    const openRequest = !thread.closedAt && state.openRequest;
    // Plan clipboard:JD8EbQgQdRls: the Thread's tab and the kind of its news, said once here for every client.
    const tabbed = { ...thread, openRequest, news: state.news };
    const tabs = thread.closedAt ? {} : { tab: inboxTabOf(tabbed), ...(state.news ? { news: state.news } : {}), ...(inboxRequestNews(tabbed) && inboxTabOf(tabbed) === "REQUESTS" ? { requestNews: true } : {}),
      // The Done card's text (summary and its Checked line), so no client reads the Thread's events for it.
      ...(state.news === "REPORT" ? { report: events.findLast((event) => event.type === "REPORT")!.body } : {}) };
    return { events, state, view: (asks: InboxEvent[]): InboxThreadView => ({ ...thread, now: inboxPlainLine(thread.now), openAsks: asks, ...(held ? { held } : {}), ...(openRequest ? { openRequest } : {}), ...tabs }) };
  }
  async function load(owner: string, thread: InboxThread) {
    return viewFrom(thread, await repository.events(owner, thread.id));
  }
  const view = async (owner: string, thread: InboxThread) => { const loaded = await load(owner, thread); return loaded.view(loaded.state.openAsks); };
  async function views(owner: string, threads: readonly InboxThread[]): Promise<InboxThreadView[]> {
    if (!threads.length) return [];
    const byThread = await repository.eventsOfThreads(owner, threads.map((thread) => thread.id));
    return threads.map((thread) => { const loaded = viewFrom(thread, byThread.get(thread.id) ?? []); return loaded.view(loaded.state.openAsks); });
  }
  async function found(owner: string, id: string) {
    const thread = await repository.thread(owner, id);
    if (!thread) throw new SpaceNotFoundError("That thread does not exist.");
    return thread;
  }

  app.get("/api/inbox", routeOptions, async (request): Promise<InboxPage> => {
    const owner = await deps.owner(request);
    const { cursor, limit, q, since, tab } = deps.parseQuery(inboxQuerySchema, request.query);
    const open = await views(owner, await repository.threads(owner, { open: true }));
    const badge = inboxBadge(open);
    const operator = open.filter((thread) => thread.waitingFor === "OPERATOR");
    // Operator 16/11 12:41: every open request of his is In progress, news or not (its news is seen with «All new OK»).
    const unseen = open.filter((thread) => thread.waitingFor !== "OPERATOR" && thread.unseen && !thread.openRequest).sort(newest);
    const working = open.filter((thread) => thread.waitingFor !== "OPERATOR" && (!thread.unseen || thread.openRequest) && !thread.held).sort(newest);
    const held = open.filter((thread) => thread.waitingFor !== "OPERATOR" && !thread.unseen && thread.held).sort(newest);
    const counted = (name: InboxThreadView["tab"]) => open.filter((thread) => thread.tab === name && inboxThreadCounts(thread)).length;
    const summary = { operator: operator.length, unseen: unseen.length, working: working.length, held: held.length,
      tabs: { needs: operator.length, done: counted("DONE"), updates: counted("UPDATES") + open.filter((thread) => thread.requestNews).length, requests: working.length } };
    if (q?.trim()) {
      // Every Thread's words, ranked; no count cuts it (closed Threads inside the History period).
      const ranked = rankByWords(await repository.threadTexts(owner, since), (entry) => entry.text, q);
      return { ...badge, summary, cursor: null, threads: await views(owner, ranked.map(({ doc }) => doc.thread)) };
    }
    const firstAsk = (thread: InboxThreadView) => thread.openAsks.find((ask) => ask.ask?.forOperator)?.at ?? thread.lastEventAt;
    operator.sort((left, right) => RANK[right.priority] - RANK[left.priority] || firstAsk(left).localeCompare(firstAsk(right)));
    const [at, id] = cursor?.split("|") ?? [];
    const closed = await repository.closedThreads(owner, { limit, ...(at && id ? { after: { at, id } } : {}), ...(since ? { since } : {}), ...(tab === "UPDATES" ? { holding: "UPDATE" as const } : {}) });
    const last = closed.at(-1);
    return { ...badge, summary, cursor: closed.length === limit && last ? `${last.lastEventAt}|${last.id}` : null,
      // The open Threads come with the first page; the next pages carry closed ones only.
      threads: [...(cursor ? [] : [...operator, ...unseen, ...working, ...held]), ...closed.map((thread) => ({ ...thread, now: inboxPlainLine(thread.now), openAsks: [] }))] };
  });

  app.get("/api/inbox/threads/:id", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { events, state, view: of } = await load(owner, await found(owner, String((request.params as { id?: unknown }).id ?? "")));
    return { thread: of(state.openAsks), events };
  });

  /** One verb on one Thread; the refs it wrote to, to sync. */
  async function act(request: FastifyRequest, owner: string, thread: InboxThread, input: InboxActInput): Promise<{ refs: string[]; display: string | null; close: boolean; seen?: boolean }> {
    const { events, state } = await load(owner, thread);
    if (input.verb === "APPROVE" || input.verb === "DECLINE" || input.verb === "ANSWER") {
      const ask = state.openAsks.find((event) => event.ref === input.askId);
      // An ask this Thread once held but no longer waits on was answered elsewhere: the client's tap still lands as done.
      if (!ask?.ref && input.askId && events.some((event) => event.ref === input.askId)) {
        // Words for a card that closed meanwhile still go to Nous (answerNeedsYou forwards them); a tap is just done.
        if (input.text?.trim() && !isDecision(input.askId)) return { refs: [input.askId], display: (await deps.answerNeedsYou(request, input.askId, { ...(input.option ? { option: input.option } : {}), text: input.text })).display, close: false };
        return { refs: [input.askId], display: ALREADY, close: false };
      }
      if (!ask?.ref) throw new SpaceConflictError("That ask no longer waits for an answer.");
      try {
        if (isDecision(ask.ref)) {
          deps.assertPerson(request);
          const answer: NousDecisionAnswerInput = input.verb === "ANSWER" ? { answer: "ANSWER", text: [input.option, input.text].filter(Boolean).join(": ") }
            : { answer: input.verb, ...(input.text ? { text: input.text } : {}), ...(input.always && input.verb === "APPROVE" ? { always: true } : {}) };
          await deps.answerDecision(owner, ask.ref, answer);
          return { refs: [ask.ref], display: null, close: false };
        }
        // A card's answers are its own options: Approve and Decline pick the one they name.
        const option = input.option ?? (input.verb === "ANSWER" ? undefined
          : ask.ask?.options.find((entry) => (input.verb === "APPROVE" ? /^(approve|yes|go)/i : /^(decline|reject|no)/i).test(entry)));
        if (!option && !input.text) throw new SpaceConflictError("Pick one of this question's answers or write one.");
        const result = await deps.answerNeedsYou(request, ask.ref, { ...(option ? { option } : {}), ...(input.text ? { text: input.text } : {}), ...(input.always ? { always: true } : {}) });
        return { refs: [ask.ref], display: result.display, close: false };
      } catch (error) {
        // The source says it was answered already (a stale Thread still held the ask): catch the Thread up; any other refusal stands.
        if (!(error instanceof SpaceConflictError)) throw error;
        await inbox.syncRef(owner, ask.ref);
        if ((await load(owner, thread)).state.openAsks.some((event) => event.ref === ask.ref)) throw error;
        return { refs: [], display: ALREADY, close: false };
      }
    }
    if (input.verb === "DONE" && state.openAsks.some((event) => event.ask?.forOperator)) throw new SpaceConflictError("Something on this thread still waits for your answer.");
    const refs: string[] = [];
    const dismissed = input.verb === "DISMISS" ? { dismissed: { at: new Date().toISOString() } } : undefined;
    // DISMISS (E3, confirmed in the client) cancels every open ask: a decision closes unanswered, a card is acknowledged as dismissed.
    for (const ask of input.verb === "DISMISS" ? state.openAsks : []) {
      if (!ask.ref || isRequest(ask.ref)) continue;
      if (isDecision(ask.ref)) { deps.assertPerson(request); await deps.dismissDecision(owner, ask.ref); }
      else await ackIfWaiting(owner, ask.ref, dismissed, "dismissed in the inbox");
      refs.push(ask.ref);
    }
    // What the Thread reported (Done, updates, alerts) and still waits on the operator's eyes is acknowledged.
    for (const ref of new Set(events.filter((event) => SEEN.has(event.type) && event.ref && !isDecision(event.ref) && !isRequest(event.ref)).map((event) => event.ref!))) {
      if (await ackIfWaiting(owner, ref, dismissed, input.verb === "DONE" ? "done in the inbox" : "dismissed in the inbox")) refs.push(ref);
    }
    // «All new OK» or Done on a request Nous still works on (16/11): its news is seen, the request stays in progress.
    return { refs, display: null, close: input.verb === "DISMISS" || !state.openRequest, seen: true };
  }
  async function ackIfWaiting(owner: string, id: string, payload: Record<string, unknown> | undefined, reason: string) {
    const record = await deps.notifications.get(owner, id);
    return record && waits(record) ? Boolean(await deps.notifications.setStatus(owner, id, "ACKED", payload, reason)) : false;
  }
  async function settle(owner: string, threadId: string, done: { refs: string[]; close: boolean; seen?: boolean }, notRelevant = false) {
    for (const ref of done.refs) await inbox.syncRef(owner, ref);
    if (done.close) await inbox.closeByOperator(owner, threadId, notRelevant);
    // Seen on a request still in progress: its progress lines are seen too, the request stays under Requests.
    else if (done.seen) await inbox.seenProgress(owner, threadId);
  }

  app.post("/api/inbox/threads/:id/act", routeOptions, async (request): Promise<InboxActResult> => {
    const owner = await deps.owner(request);
    const thread = await found(owner, String((request.params as { id?: unknown }).id ?? ""));
    const input = deps.parseBody(inboxActInputSchema, request.body);
    const done = await act(request, owner, thread, input);
    await settle(owner, thread.id, done, input.verb === "DISMISS");
    const after = await repository.thread(owner, thread.id);
    return { ...await inbox.badge(owner), thread: after ? await view(owner, after) : null, display: done.display };
  });

  /** «Όλα Done» on a selection: what still waits for an answer is skipped, not closed. */
  app.post("/api/inbox/done-all", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { ids } = deps.parseBody(inboxDoneAllInputSchema, request.body);
    const done: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const thread = await repository.thread(owner, id);
      if (!thread || thread.closedAt) { skipped.push(id); continue; }
      try {
        await settle(owner, id, await act(request, owner, thread, { verb: "DONE" }));
        done.push(id);
      } catch (error) {
        if (!(error instanceof SpaceConflictError)) throw error;
        skipped.push(id);
      }
    }
    return { ...await inbox.badge(owner), done, skipped };
  });
}
