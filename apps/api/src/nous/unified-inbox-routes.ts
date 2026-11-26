import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  heldForNous, needsYou, needsYouAsk, needsYouPlace, OPERATOR_UPDATE_KIND, unifiedBadgeCounts, unifiedInboxActInputSchema, unifiedInboxQuerySchema,
  unifiedNoticeIdSchema, type NotificationAnswerResult, type NotificationListQuery, type NotificationStatus, type NousDecision, type NousDecisionAnswerInput,
  type NousOperatorRequest, type NousRequestStatus, type SpaceNotification, type UnifiedInboxActResult, type UnifiedInboxPage, type UnifiedNoticeItem,
  type UnifiedNoticeSource
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";

type InboxLine = { key: string; text: string; at: string | null };
export interface UnifiedInboxDeps {
  routeOptions: Record<string, unknown>;
  owner(request: FastifyRequest): Promise<string>;
  assertPerson(request: FastifyRequest): void;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  notifications: {
    list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
    get(owner: string, id: string): Promise<SpaceNotification | null>;
    setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">, payload?: Record<string, unknown>, reason?: string): Promise<SpaceNotification | null>;
  };
  /** Nous's decisions (the open ones first); only OPEN ones are shown. */
  decisions(owner: string): Promise<NousDecision[]>;
  answerDecision(owner: string, id: string, input: NousDecisionAnswerInput): Promise<NousDecision>;
  /** Nous's own inbox (NousState.inboxItems): its work queue, shown read-only under «Σε εξέλιξη». */
  inbox(owner: string): Promise<InboxLine[]>;
  requests?: { page(owner: string, options: { before?: string; limit: number; status?: NousRequestStatus; since?: string; q?: string }): Promise<{ requests: NousOperatorRequest[]; hasMore: boolean }> };
  /** The pane board's needs-you answer (POST /api/notifications/:id/answer): the same checks, routing and ledger. */
  answerNeedsYou(request: FastifyRequest, id: string, input: { option?: string; text?: string; always?: boolean }): Promise<NotificationAnswerResult>;
}

const PAGE = 200;
const SOURCE: Partial<Record<SpaceNotification["source"], UnifiedNoticeSource>> = { NOUS: "NOUS", MONITORING_COPILOT: "MONITORING", SECURITY_COPILOT: "SECURITY",
  AGENT: "AGENT", ROOM_AGENT: "AGENT", BROWSER_HANDOFF: "AGENT", COUNCIL: "AGENT", ROOM_WATCHDOG: "SYSTEM", SYSTEM: "SYSTEM" };
const label = (source: string) => source.charAt(0) + source.slice(1).toLowerCase().replace(/_/g, " ");
const isDone = (record: SpaceNotification) => record.source === "NOUS" && record.kind === "REQUEST_DONE";
const waits = (record: SpaceNotification) => record.status === "OPEN" || record.status === "READ";
const planOf = (record: SpaceNotification) => typeof record.payload.planId === "string" ? record.payload.planId : null;

/** A notification as the unified card: needs-you waits for an answer, Done for «Ελήφθη», updates and alerts are read. */
export function noticeOfNotification(record: SpaceNotification): UnifiedNoticeItem {
  const base = { id: `notification:${record.id}`, priority: record.severity, source: SOURCE[record.source] ?? "COPILOT", sourceLabel: label(record.source), title: record.title,
    body: record.body, createdAt: record.createdAt, updatedAt: record.updatedAt, target: { roomId: record.roomId, paneId: record.paneId, planId: planOf(record) },
    record: { notification: record } } as const;
  const read = record.status === "OPEN" ? "UNREAD" as const : record.status === "READ" ? "READ" as const : "RESOLVED" as const;
  if (needsYou(record) && waits(record)) {
    const ask = needsYouAsk(record);
    // 3/11: «Μετάβαση σε pane» only for what needs the operator's own hands there; every other ask is answered on the card.
    const actions = needsYouPlace(record) === "PANE" ? { type: "GO_TO_PANE" as const }
      : ask.options?.length ? { type: "CHOICE" as const, options: ask.options, ...(ask.recommended ? { recommended: ask.recommended } : {}) } : { type: "TEXT_INPUT" as const };
    return { ...base, kind: "ACTION_REQUIRED", status: "ACTION_PENDING", actions };
  }
  if (isDone(record)) return { ...base, kind: "COMPLETED", status: read, ...(waits(record) ? { actions: { type: "ACKNOWLEDGE" as const } } : {}) };
  return { ...base, kind: record.source === "NOUS" && record.kind === OPERATOR_UPDATE_KIND ? "UPDATE" : "ALERT", status: read };
}

export function noticeOfDecision(decision: NousDecision): UnifiedNoticeItem {
  return { id: `decision:${decision.id}`, kind: "ACTION_REQUIRED", status: decision.status === "OPEN" ? "ACTION_PENDING" : "RESOLVED", priority: "ATTENTION", source: "NOUS",
    sourceLabel: "Nous", title: decision.title, body: decision.body, createdAt: decision.createdAt, updatedAt: decision.answeredAt ?? decision.createdAt,
    target: { roomId: decision.refs.roomId ?? null, paneId: decision.refs.paneId ?? null, planId: decision.refs.planId ?? null },
    actions: { type: "APPROVAL", options: decision.options, ...(decision.recommendation ? { recommended: decision.recommendation } : {}) }, record: { decision } };
}

export function noticeOfRequest(request: NousOperatorRequest): UnifiedNoticeItem {
  const at = request.doneAt ?? request.answeredAt ?? request.createdAt;
  return { id: `request:${request.messageId}`, kind: request.status === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED",
    status: request.status === "IN_PROGRESS" || request.status === "WAITS_FOR_YOU" ? "READ" : "RESOLVED", priority: "INFO", source: "NOUS", sourceLabel: "Nous",
    title: request.text.split("\n")[0]!.slice(0, 200), body: request.doneSummary ?? request.text, createdAt: request.createdAt, updatedAt: at,
    target: { planId: request.planId ?? null, requestId: request.messageId, ticketId: request.tickets?.[0] ?? null }, record: { request } };
}

export const noticeOfInbox = (line: InboxLine): UnifiedNoticeItem => ({ id: `inbox:${line.key}`, kind: "INTERNAL_QUEUE", status: "READ", priority: "INFO", source: "NOUS",
  sourceLabel: "Nous", title: line.text.split("\n")[0]!.slice(0, 200), body: line.text, createdAt: line.at ?? "", updatedAt: line.at ?? "", record: { inbox: line } });

const newestFirst = (left: UnifiedNoticeItem, right: UnifiedNoticeItem) => right.createdAt.localeCompare(left.createdAt);

/** The unified «Εισερχόμενα» (plan clipboard:aE7U1J_gU9OV D1-D3): GET a view of the existing records, POST an act on the one an item shows. */
export function registerUnifiedInboxRoutes(app: FastifyInstance, deps: UnifiedInboxDeps): void {
  const { routeOptions } = deps;

  /** Every record of a notification query, a page at a time (what still waits is read whole: no count cuts it). */
  async function every(owner: string, query: Omit<NotificationListQuery, "limit" | "before">): Promise<SpaceNotification[]> {
    const out: SpaceNotification[] = [];
    for (let before: string | undefined; ;) {
      const page = await deps.notifications.list(owner, { ...query, limit: PAGE, ...(before ? { before } : {}) });
      out.push(...page);
      if (page.length < PAGE || page.at(-1)!.createdAt === before) return out;
      before = page.at(-1)!.createdAt;
    }
  }
  async function inProgress(owner: string): Promise<UnifiedNoticeItem[]> {
    const requests: NousOperatorRequest[] = [];
    for (let before: string | undefined; deps.requests;) {
      const page = await deps.requests.page(owner, { limit: PAGE, status: "IN_PROGRESS", ...(before ? { before } : {}) });
      requests.push(...page.requests);
      if (!page.hasMore || !page.requests.length) break;
      before = page.requests.at(-1)!.messageId;
    }
    return [...(await deps.inbox(owner)).map(noticeOfInbox), ...requests.map(noticeOfRequest)].sort(newestFirst);
  }

  /** What waits, read whole: the counts and the badge come from it, so every client shows the same numbers. */
  async function waiting(owner: string) {
    const [needs, decisions, open, done, progress] = await Promise.all([every(owner, { status: "NEEDS_YOU" }), deps.decisions(owner),
      every(owner, { status: "OPEN" }), every(owner, { status: "WAITING", source: "NOUS", kind: "REQUEST_DONE" }), inProgress(owner)]);
    const action = [...needs.map(noticeOfNotification), ...decisions.filter((decision) => decision.status === "OPEN").map(noticeOfDecision)].sort(newestFirst);
    // A held-for-Nous record and a needs-you record off its pane are nobody's yet (pendingOf, the NEEDS_YOU query).
    const unread = open.filter((record) => !needsYou(record) && !isDone(record) && !heldForNous(record)).map(noticeOfNotification);
    const completed = done.map(noticeOfNotification);
    const shown = [...action, ...completed, ...unread];
    const badge = shown.filter(unifiedBadgeCounts).length;
    return { action, unread, completed, progress, badge, attention: action.length > 0,
      counts: { ALL: shown.length, ACTION: action.length, COMPLETED: completed.length, UPDATES: unread.length, IN_PROGRESS: progress.length } };
  }

  /** A page of notification history (`keep` picks its records); the cursor is the oldest raw record's time, so a page may hold fewer. */
  async function history(owner: string, query: Omit<NotificationListQuery, "before" | "limit">, keep: (record: SpaceNotification) => boolean,
    limit: number, before?: string, since?: string): Promise<{ items: UnifiedNoticeItem[]; before: string | null }> {
    const page = await deps.notifications.list(owner, { ...query, limit, ...(before && !Number.isNaN(Date.parse(before)) ? { before: new Date(before).toISOString() } : {}) });
    const inside = since ? page.filter((record) => record.createdAt >= since) : page;
    return { items: inside.filter(keep).map(noticeOfNotification), before: page.length < limit || inside.length < page.length ? null : page.at(-1)!.createdAt };
  }

  app.get("/api/nous/unified-inbox", routeOptions, async (request): Promise<UnifiedInboxPage> => {
    const owner = await deps.owner(request);
    const { filter, before, limit, q, since } = deps.parseQuery(unifiedInboxQuerySchema, request.query);
    const summary = await waiting(owner);
    const head = { counts: summary.counts, badge: summary.badge, attention: summary.attention };
    if (filter === "ARCHIVE") {
      const page = deps.requests ? await deps.requests.page(owner, { limit, ...(before ? { before } : {}), ...(since ? { since } : {}), ...(q?.trim() ? { q } : {}) }) : { requests: [], hasMore: false };
      return { ...head, items: page.requests.map(noticeOfRequest), before: page.hasMore && page.requests.length ? page.requests.at(-1)!.messageId : null };
    }
    if (filter === "COMPLETED") return { ...head, ...await history(owner, { status: "ALL", source: "NOUS", kind: "REQUEST_DONE" }, () => true, limit, before, since) };
    if (filter === "UPDATES") return { ...head, ...await history(owner, { status: "ALL" }, (record) => !needsYou(record) && !isDone(record) && !heldForNous(record), limit, before, since) };
    if (filter === "ACTION") return { ...head, items: summary.action, before: null };
    if (filter === "IN_PROGRESS") return { ...head, items: summary.progress, before: null };
    // «Όλα»: what still waits on the operator, read whole; «Ελήφθη» and Mark read move a card out of it into its history.
    return { ...head, items: [...summary.action, ...[...summary.completed, ...summary.unread].sort(newestFirst)], before: null };
  });

  app.post("/api/nous/unified-inbox/:id/act", routeOptions, async (request): Promise<UnifiedInboxActResult> => {
    const owner = await deps.owner(request);
    const id = unifiedNoticeIdSchema.parse((request.params as { id?: unknown }).id);
    const input = deps.parseBody(unifiedInboxActInputSchema, request.body);
    const [type, ...rest] = id.split(":");
    const recordId = rest.join(":");
    let item: UnifiedNoticeItem | null;
    let display: string | null = null;
    if (type === "notification") {
      const record = await deps.notifications.get(owner, recordId);
      if (!record) throw new SpaceNotFoundError("That notice does not exist.");
      if (input.action === "ANSWER") {
        const result = await deps.answerNeedsYou(request, recordId, { ...(input.option ? { option: input.option } : {}), ...(input.text ? { text: input.text } : {}), ...(input.always ? { always: true } : {}) });
        display = result.display;
        item = result.notification ? noticeOfNotification(result.notification) : null;
      } else {
        // The store moves status only forward. DISMISS («It no longer needs me» on a needs-you card) keeps the record (retention): acknowledged, marked dismissed.
        const next = input.action === "MARK_READ" ? (record.status === "OPEN" ? "READ" : null) : waits(record) ? "ACKED" : null;
        const updated = next ? await deps.notifications.setStatus(owner, recordId, next, input.action === "DISMISS" ? { dismissed: { at: new Date().toISOString() } } : undefined,
          `${input.action === "MARK_READ" ? "read" : input.action === "DISMISS" ? "dismissed" : "acknowledged"} in the unified inbox`) : record;
        item = updated ? noticeOfNotification(updated) : null;
      }
    } else if (type === "decision") {
      if (input.action !== "ANSWER") throw new SpaceConflictError("A decision waits for your answer.");
      deps.assertPerson(request);
      const choice = input.option?.toUpperCase();
      const answer: NousDecisionAnswerInput = choice === "APPROVE" || choice === "DECLINE" ? { answer: choice, ...(input.text ? { text: input.text } : {}), ...(input.always && choice === "APPROVE" ? { always: true } : {}) }
        : { answer: "ANSWER", text: [input.option, input.text].filter(Boolean).join(": ") };
      item = noticeOfDecision(await deps.answerDecision(owner, recordId, answer));
    } else {
      throw new SpaceConflictError("Nous's queue and your requests are shown here; they are answered in the conversation.");
    }
    const summary = await waiting(owner);
    return { item, display, badge: summary.badge, attention: summary.attention };
  });
}
