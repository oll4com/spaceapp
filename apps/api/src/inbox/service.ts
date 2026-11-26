import {
  heldForNous, INBOX_NOT_RELEVANT, inboxBadge, MARKETING_CHANNEL_LABELS, inboxThreadState, needsYou, needsYouAsk, needsYouBrowserPage, needsYouPlace, NOTIFICATION_SOURCE_LABELS, nousDecisionKind, nousDecisionRunsWhen,
  OPERATOR_UPDATE_KIND, operatorUpdatePayloadSchema, type InboxAsk, type InboxEvent, type InboxOrigin, type InboxThread, type InboxThreadRefs, type NotificationListQuery,
  type MarketingChannel, type NousDecision, type NousDecisionStatus, type NousOperatorRequest, type SpaceNotification
} from "@space/contracts";
import type { InboxEventRow, InboxRepository, PaneReport } from "@space/db";

/**
 * Plan clipboard:LkwKdOOh2mXK step 8 (operator 16/11 12:05): «Marketing Copilot needs you (Marketing Copilot 13)» titled reviews Nous held. A question
 * or approval is named after what it is and who asks; whom it waits for is the ask's own. Hands and off-Space asks keep their title.
 */
export function askTitle(record: SpaceNotification): string {
  const asker = /\bneeds you(?:\s*\(([^()]+)\))?\s*$/i.exec(record.title);
  const place = needsYou(record) ? needsYouPlace(record) : null;
  if (!asker || !place || place === "PANE" || place === "OFF_SPACE") return record.title;
  const channel = MARKETING_CHANNEL_LABELS[(record.payload.review as { channel?: MarketingChannel } | undefined)?.channel as MarketingChannel];
  const what = record.kind === "REVIEW_REQUESTED" ? (channel ? `${channel} review` : "Review") : record.kind === "RULE_PROPOSED" ? "Rule proposal"
    : record.kind === "CAMPAIGN_PROPOSED" ? "Campaign proposal" : "Question";
  const who = asker[1]?.trim() || record.title.slice(0, asker.index).trim();
  return who ? `${what} from ${who}` : what;
}

/**
 * «Εισερχόμενα» v2 step 1 (spec v2 §2-§4, plan clipboard:aE7U1J_gU9OV): mirrors the records that execute (notifications, Nous's decisions, the
 * operator's requests) into Threads of append-only events. Shadow mode: nothing reads it yet; the sources stay the ones every act writes to.
 */
export interface InboxServiceDeps {
  repository: InboxRepository;
  notifications: {
    list(owner: string, query: NotificationListQuery): Promise<SpaceNotification[]>;
    get(owner: string, id: string): Promise<SpaceNotification | null>;
  };
  decisions: {
    list(owner: string, options: { statuses?: NousDecisionStatus[]; limit?: number; before?: string }): Promise<NousDecision[]>;
    get(owner: string, id: string): Promise<NousDecision | null>;
  };
  requests: { page(owner: string, options: { limit: number; before?: string }): Promise<{ requests: NousOperatorRequest[]; hasMore: boolean }> };
  /** Whether a pane is still open (a needs-you card on a closed pane is nobody's). */
  paneOpen(paneId: string): Promise<boolean>;
  /** Each pane's active plan (its newest report's planId). */
  panePlans(owner: string): Promise<Map<string, string>>;
  /** A plan's own title: a plan's Thread is named after it, not after whichever record opened it. */
  planTitle?(owner: string, planId: string): Promise<string | null>;
  now?: () => number;
  /** A Thread changed live (not in a backfill): the stream tells its owner's clients (step 2). */
  onChange?(owner: string, threadId: string): void;
  /** Spec v2 §7 (step 4): a Thread that alerted (waits on the operator, or new, at ATTENTION or more) no longer does: its phones' push goes. */
  onCleared?(owner: string, threadId: string, answered: boolean): void;
}

/** Spec v2 §7: what the phones, Telegram, the desktop and the toast alert for; INFO never alerts. */
export const inboxThreadAlerts = (thread: Pick<InboxThread, "closedAt" | "priority" | "waitingFor" | "unseen">) =>
  !thread.closedAt && thread.priority !== "INFO" && (thread.waitingFor === "OPERATOR" || thread.unseen);

/**
 * Plan clipboard:JD8EbQgQdRls §3: the one line a pane's own report on a plan adds to its request's Thread: a finished step, done, blocked or failed.
 * Null for the rest (started, a progress note without a step, turn ends, heartbeats): they stay with Nous.
 */
export function inboxProgressLine(report: Pick<PaneReport, "source" | "status" | "step" | "percent" | "summary">): string | null {
  const head = report.source !== "AGENT" ? null : report.status === "PROGRESS" ? (report.step ? `Step ${report.step}` : null)
    : ({ DONE: "Done", BLOCKED: "Blocked", FAILED: "Failed" } as Record<string, string>)[report.status] ?? null;
  return head ? `${head}${report.percent !== null ? ` · ${report.percent}%` : ""}: ${report.summary}` : null;
}

type Draft = Omit<InboxEvent, "id" | "threadId">;
interface Mirror {
  ref: string;
  opener: Draft;
  open: boolean;
  closer: Draft;
  /** §2.2 grouping, first match wins: its request, its plan, its decision's card, its pane's active plan, else its own Thread. */
  group: { requestId?: string; planId?: string; planNamed?: boolean; notificationId?: string; paneId?: string; dedupeKey?: string };
  thread: { title: string; origin: InboxOrigin; originLabel: string; refs: InboxThreadRefs; progress?: number | null };
}

// Technical: the sources' own page size (the notification list answers 200 at most).
const PAGE = 200;
const ORIGIN: Partial<Record<SpaceNotification["source"], InboxOrigin>> = { NOUS: "NOUS", AGENT: "AGENT", ROOM_AGENT: "AGENT", BROWSER_HANDOFF: "AGENT",
  COUNCIL: "AGENT", SYSTEM: "SYSTEM", ROOM_WATCHDOG: "SYSTEM" };
const PLAN_KEY = /^nous:(?:plan|done):(clipboard:[\w-]+)/;
const DONE_REQUEST = /^nous:done:(nous_msg:\S+)/;
const DECISION_CARD = /^nous:decision:(nous_decision:\S+)/;
/** Every event type that opens a ref (inboxThreadState's OPENS). */
const OPENS = new Set<InboxEvent["type"]>(["REQUEST", "ASK", "REPORT", "UPDATE", "ALERT"]);
const isDone = (record: SpaceNotification) => record.source === "NOUS" && record.kind === "REQUEST_DONE";
const waits = (record: SpaceNotification) => record.status === "OPEN" || record.status === "READ";
const planOf = (record: SpaceNotification) => typeof record.payload.planId === "string" ? record.payload.planId : PLAN_KEY.exec(record.dedupeKey ?? "")?.[1];
const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)) as T;
/** An operator request's own Thread (keyed by its message id), titled by the request. */
const isRequestThread = (thread: InboxThread) => thread.key.startsWith("nous_msg:");
const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? text).trim().slice(0, 200) || "(empty)";

/** What a Thread must append for one source record: its opener when it (re)opens, its closer when it settles, nothing when unchanged. */
export function mirrorChanges(rows: readonly InboxEvent[], mirror: Pick<Mirror, "opener" | "open" | "closer">, now: string): Draft[] {
  const lastOpen = rows.findLastIndex((row) => row.type === mirror.opener.type);
  const lastSettle = rows.findLastIndex((row) => row.type === "ANSWER" || row.type === "CLOSED");
  const isOpen = lastOpen >= 0 && lastSettle < lastOpen;
  if (mirror.open) {
    if (lastOpen < 0) return [mirror.opener];
    if (!isOpen) return [{ ...mirror.opener, at: now }];
    // Asked again when it turns to or from the operator (a hold ends, its pane closes): the newest ask of a ref is the one that counts.
    return mirror.opener.ask && rows[lastOpen]!.ask?.forOperator !== mirror.opener.ask.forOperator ? [{ ...mirror.opener, at: now }] : [];
  }
  if (lastOpen < 0) return [mirror.opener, mirror.closer];
  // 23/11 (operator: a stuck "Waiting for you" card): a card that lost its pane mirrors as an ALERT once settled, yet its ASK stays open; any opener counts.
  return rows.findLastIndex((row) => OPENS.has(row.type)) > lastSettle ? [mirror.closer] : [];
}

export function createInboxService(deps: InboxServiceDeps) {
  const { repository } = deps;
  const clock = deps.now ?? Date.now;
  const iso = () => new Date(clock()).toISOString();
  const queues = new Map<string, Promise<unknown>>();
  /** One sync at a time per owner: the event keys' counters and the Threads' refresh read what the last sync wrote. */
  function serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
    queues.set(owner, run.catch(() => undefined));
    return run;
  }

  async function notificationMirror(record: SpaceNotification, paneOpen: (id: string) => Promise<boolean>): Promise<Mirror | null> {
    if (record.dedupeKey?.startsWith("nous:decision:")) return null; // its decision is mirrored instead
    const label = NOTIFICATION_SOURCE_LABELS[record.source] ?? record.source;
    const planId = planOf(record);
    const title = askTitle(record);
    const base = { actor: label, title, body: record.body, priority: record.severity, ref: record.id };
    const target = (record.payload.review as { target?: string } | undefined)?.target; // plan LkwKdOOh2mXK step 5: one Thread per copilot and person
    // Step 10: one Thread per program, so a newer update (approved, then a new amount) supersedes the older one there and the badge counts it once.
    const program = record.kind === OPERATOR_UPDATE_KIND && typeof record.payload.programId === "string" ? record.payload.programId : null;
    // Plan clipboard:JD8EbQgQdRls §3: an update of Nous's that names its request (space_operator_update refs) joins that request's Thread.
    const updateOf = record.kind === OPERATOR_UPDATE_KIND && typeof record.payload.requestId === "string" ? record.payload.requestId : undefined;
    const group = defined({ planId, planNamed: true, paneId: record.paneId ?? undefined,
      dedupeKey: target ? `${record.source}:to:${target}` : program ? `nous:update:program:${program}` : record.dedupeKey ?? undefined,
      requestId: isDone(record) ? DONE_REQUEST.exec(record.dedupeKey ?? "")?.[1] : updateOf });
    const thread = { title, origin: ORIGIN[record.source] ?? "COPILOT" as InboxOrigin, originLabel: label,
      refs: defined({ planId, roomId: record.roomId ?? undefined, paneId: record.paneId ?? undefined }) };
    const settledAt = record.resolvedAt ?? record.updatedAt;
    if (needsYou(record)) {
      const asked = needsYouAsk(record);
      const place = needsYouPlace(record);
      // 17/11 (card 7454e78e): a closed pane's carried card has no pane yet is the operator's, as the pending count and Needs you list say.
      const forOperator = waits(record) && !heldForNous(record, clock()) && (/^nous:(?:plan|closed-pane):/.test(record.dedupeKey ?? "")
        || (record.paneId ? await paneOpen(record.paneId) : false));
      const ask: InboxAsk = defined({ open: waits(record), forOperator,
        kind: place === "PANE" ? "HANDS" as const : place === "OFF_SPACE" ? "OFF_SPACE" as const : /REVIEW|APPROVAL|PROPOSED/.test(record.kind) ? "APPROVAL" as const : "QUESTION" as const,
        options: asked.options ?? [], recommended: asked.recommended,
        // Operator 20/11 (Nous app, AWS WAF card from CLI Work/Nik): the browser pane holding the card's page (rule of 2/11), never the asking CLI.
        goToPane: place !== "PANE" ? undefined : needsYouBrowserPage(record)
          ?? (record.roomId && record.paneId ? defined({ roomId: record.roomId, paneId: record.paneId, target: record.link.target }) : undefined) });
      const closer: Draft = record.status === "ACKED" ? { ...base, type: "ANSWER", actor: "You", at: record.ackedAt ?? record.updatedAt }
        : { ...base, type: "CLOSED", at: settledAt };
      return { ref: record.id, opener: { ...base, type: "ASK", at: record.createdAt, ask }, open: waits(record), closer, group, thread };
    }
    if (isDone(record)) {
      return { ref: record.id, opener: { ...base, type: "REPORT", at: record.createdAt }, open: waits(record),
        closer: { ...base, type: "CLOSED", at: record.ackedAt ?? record.resolvedAt ?? record.updatedAt }, group, thread };
    }
    // shortcut: a held-for-Nous update stays out until its hold ends or it settles; its NOTE event (§2.1) comes with step 2.
    if (record.status === "OPEN" && heldForNous(record, clock())) return null;
    const type = record.source === "NOUS" && record.kind === OPERATOR_UPDATE_KIND ? "UPDATE" as const : "ALERT" as const;
    // R73 (operator 4/11): an update's full report and links open with its Thread, as the old Updates tab's "Full report" did.
    // shortcut: events are written once, so updates mirrored before 23/11 keep only their body; backfill if the operator asks for old reports.
    const update = type === "UPDATE" ? operatorUpdatePayloadSchema.safeParse(record.payload) : null;
    const body = update?.success ? [record.body, update.data.report, ...update.data.links.map((link) => `[${link.label}](${link.url})`)].filter(Boolean).join("\n\n") : record.body;
    return { ref: record.id, opener: { ...base, body, type, at: record.createdAt }, open: record.status === "OPEN",
      closer: { ...base, type: "CLOSED", at: record.readAt ?? record.ackedAt ?? record.updatedAt }, group, thread };
  }

  function decisionMirror(decision: NousDecision): Mirror {
    const base = { actor: "Nous", title: decision.title, body: decision.body, priority: "ATTENTION" as const, ref: decision.id };
    const ask: InboxAsk = defined({ open: decision.status === "OPEN", forOperator: decision.status === "OPEN" && nousDecisionRunsWhen(decision) === null,
      kind: decision.action ? "APPROVAL" as const : "QUESTION" as const, options: decision.options, action: decision.action?.type,
      recommended: decision.recommendation && decision.options.includes(decision.recommendation) ? decision.recommendation : undefined,
      always: nousDecisionKind(decision) ?? undefined, files: decision.refs.files, category: decision.category });
    const at = decision.answeredAt ?? decision.createdAt;
    const closer: Draft = decision.status === "CANCELLED" ? { ...base, type: "CLOSED", at }
      : { ...base, type: "ANSWER", actor: "You", title: decision.answer ?? decision.status, body: decision.outcome ?? "", at };
    return { ref: decision.id, opener: { ...base, type: "ASK", at: decision.createdAt, ask }, open: decision.status === "OPEN", closer,
      group: defined({ planId: decision.refs.planId, planNamed: true, notificationId: decision.refs.notificationId, paneId: decision.refs.paneId }),
      thread: { title: decision.title, origin: "NOUS", originLabel: "Nous",
        refs: defined({ planId: decision.refs.planId, roomId: decision.refs.roomId, paneId: decision.refs.paneId }) } };
  }

  function requestMirror(request: NousOperatorRequest): Mirror {
    const base = { ref: request.messageId, priority: "INFO" as const };
    return { ref: request.messageId, opener: { ...base, type: "REQUEST", actor: "You", title: firstLine(request.text), body: request.text, at: request.createdAt },
      // Not answered and not done yet both still wait on Nous (16/11: they closed at birth and never showed as requests).
      open: request.status !== "DONE" && request.status !== "ANSWERED",
      closer: { ...base, type: "CLOSED", actor: "Nous", title: (request.doneSummary ?? (request.status === "DONE" ? "Done" : "Answered")).slice(0, 200), body: request.doneSummary ?? "",
        at: request.doneAt ?? request.answeredAt ?? request.createdAt },
      // A request does not name a plan Thread into being: with none yet it is its own Thread, which later work on its plan joins.
      group: defined({ requestId: request.messageId, planId: request.planId, planNamed: false }),
      thread: { title: firstLine(request.text), origin: "OPERATOR", originLabel: "You", progress: request.planPercent ?? null,
        refs: defined({ requestId: request.messageId, planId: request.planId, ticketIds: request.tickets?.length ? request.tickets : undefined, requestStatus: request.status, where: request.where }) } };
  }

  async function resolve(owner: string, mirror: Mirror, panePlans: () => Promise<Map<string, string>>): Promise<InboxThread> {
    const { group } = mirror;
    if (group.requestId && group.requestId !== mirror.ref) { const thread = await repository.threadOfRef(owner, group.requestId); if (thread) return thread; }
    let request = false;
    // 17/11 (cards e90ddf3c, cd0e91ed): an ask filed in an operator request's Thread showed only as that request's subline; it gets its own.
    const fits = (thread: InboxThread | null) => !thread || !mirror.opener.ask || !isRequestThread(thread) ? thread : (request = true, null);
    if (group.planId) {
      const thread = fits(await repository.threadOfPlan(owner, group.planId));
      if (thread) return thread;
      if (group.planNamed && !request) return create(owner, `plan:${group.planId}`, mirror);
    }
    if (group.notificationId) { const thread = fits(await repository.threadOfRef(owner, group.notificationId)); if (thread) return thread; }
    if (group.paneId) {
      const planId = (await panePlans()).get(group.paneId);
      const thread = fits(planId ? await repository.threadOfPlan(owner, planId) : null);
      if (thread) return thread;
    }
    return create(owner, request ? mirror.ref : group.dedupeKey ? `dedupe:${group.dedupeKey}` : mirror.ref, mirror);
  }
  const planTitle = (owner: string, key: string) => key.startsWith("plan:") ? (deps.planTitle?.(owner, key.slice(5)) ?? Promise.resolve(null)).catch(() => null) : Promise.resolve(null);
  async function create(owner: string, key: string, mirror: Mirror) {
    const at = mirror.opener.at;
    return repository.createThread({ ownerUserId: owner, key, title: await planTitle(owner, key) || mirror.thread.title, origin: mirror.thread.origin, originLabel: mirror.thread.originLabel,
      waitingFor: "NOBODY", unseen: false, closedAt: null, closedBy: null, priority: "INFO", now: "", progress: mirror.thread.progress ?? null,
      refs: { ...mirror.thread.refs, ...(mirror.group.planId ? { planId: mirror.group.planId } : {}) }, createdAt: at, lastEventAt: at });
  }

  /** The Thread's one state from its events, its refs merged with what its records name now; a closed Thread that opens again says so. */
  async function refresh(owner: string, threadId: string, mirrors: readonly Mirror[], history: boolean) {
    const thread = await repository.thread(owner, threadId);
    if (!thread) return;
    const events = await repository.events(owner, threadId);
    const state = inboxThreadState(events, thread.title);
    if (!history && thread.closedAt && !state.closedAt) {
      const reopened = events.filter((event) => event.type === "REOPENED").length;
      await repository.append(owner, `${threadId}:REOPENED:${reopened}`, { threadId, type: "REOPENED", at: iso(), actor: "Space", title: "Reopened", body: "", priority: "INFO" });
    }
    const refs: InboxThreadRefs = { ...thread.refs };
    for (const { thread: meta } of mirrors) {
      refs.planId ??= meta.refs.planId;
      refs.requestId ??= meta.refs.requestId;
      if (meta.refs.requestStatus) refs.requestStatus = meta.refs.requestStatus;
      if (meta.refs.where) refs.where = meta.refs.where;
      if (meta.refs.roomId) refs.roomId = meta.refs.roomId;
      if (meta.refs.paneId) refs.paneId = meta.refs.paneId;
      if (meta.refs.ticketIds?.length) refs.ticketIds = [...new Set([...refs.ticketIds ?? [], ...meta.refs.ticketIds])];
    }
    const progress = mirrors.findLast((mirror) => mirror.thread.progress != null)?.thread.progress ?? thread.progress;
    const lastEventAt = events.reduce((max, event) => event.at > max ? event.at : max, thread.lastEventAt);
    await repository.saveThread({ ...thread, waitingFor: state.waitingFor, unseen: state.unseen, closedAt: state.closedAt, closedBy: state.closedBy,
      priority: state.priority, now: state.now, progress, refs, lastEventAt });
    if (!history) deps.onChange?.(owner, threadId);
    if (!history && inboxThreadAlerts(thread) && !inboxThreadAlerts(state)) deps.onCleared?.(owner, threadId, thread.waitingFor === "OPERATOR");
  }

  /** Appends what changed for each record (keys `<ref>:<TYPE>:<n>`, recorded once), then refreshes the Threads that moved. */
  async function apply(owner: string, mirrors: readonly Mirror[], history = false): Promise<number> {
    if (!mirrors.length) return 0;
    const rows = await repository.eventsOfRefs(owner, mirrors.map((mirror) => mirror.ref));
    const byRef = new Map<string, InboxEventRow[]>();
    for (const row of rows) byRef.set(row.ref!, [...byRef.get(row.ref!) ?? [], row]);
    let plans: Promise<Map<string, string>> | null = null;
    const panePlans = () => (plans ??= deps.panePlans(owner).catch(() => new Map<string, string>()));
    const moved = new Map<string, Mirror[]>();
    const now = iso();
    let appended = 0;
    for (const mirror of mirrors) {
      const own = byRef.get(mirror.ref) ?? [];
      let drafts = mirrorChanges(own, mirror, now);
      let threadId = own.at(-1)?.threadId;
      const from = mirror.open && mirror.opener.ask && threadId ? await repository.thread(owner, threadId) : null;
      if (from && isRequestThread(from)) {
        // An open ask filed in a request's Thread before 17/11 moves to its own: closed there, asked again in its own (at start, by the backfill).
        const n = own.filter((row) => row.type === "CLOSED").length;
        const event = await repository.append(owner, `${mirror.ref}:CLOSED:${n}`, { ...mirror.closer, type: "CLOSED", actor: "Space", title: "Moved to its own thread", body: "", at: now, threadId: from.id });
        if (event) { own.push({ ...event, sourceKey: `${mirror.ref}:CLOSED:${n}` }); moved.set(from.id, [...moved.get(from.id) ?? [], mirror]); }
        threadId = (await resolve(owner, mirror, panePlans)).id;
        drafts = [mirror.opener];
      }
      if (!drafts.length) {
        // An open request moves (Not answered → In progress, its plan's %) without an event: its Thread still shows where it stands.
        const { requestStatus } = mirror.thread.refs;
        const thread = mirror.open && requestStatus && own[0] ? await repository.thread(owner, own[0].threadId) : null;
        // A Thread the operator's Done closed over its open request (before 16/11 12:41) opens again; his Not relevant stands.
        const reopens = async (closed: InboxThread) => Boolean(closed.closedAt) && !inboxThreadState(await repository.events(owner, closed.id), closed.title).closedAt;
        if (thread && (thread.refs.requestStatus !== requestStatus || (mirror.thread.progress != null && thread.progress !== mirror.thread.progress) || await reopens(thread))) {
          moved.set(thread.id, [...moved.get(thread.id) ?? [], mirror]);
        }
        continue;
      }
      threadId ??= (await resolve(owner, mirror, panePlans)).id;
      const counts = new Map<string, number>();
      for (const row of own) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
      for (const draft of drafts) {
        const n = counts.get(draft.type) ?? 0;
        counts.set(draft.type, n + 1);
        const event = await repository.append(owner, `${mirror.ref}:${draft.type}:${n}`, { ...draft, threadId });
        if (!event) continue;
        appended += 1;
        own.push({ ...event, sourceKey: `${mirror.ref}:${draft.type}:${n}` });
      }
      byRef.set(mirror.ref, own);
      moved.set(threadId, [...moved.get(threadId) ?? [], mirror]);
    }
    for (const [threadId, list] of moved) await refresh(owner, threadId, list, history);
    return appended;
  }

  function paneCache() {
    const seen = new Map<string, Promise<boolean>>();
    return (id: string) => seen.get(id) ?? (seen.set(id, deps.paneOpen(id).catch(() => false)), seen.get(id)!);
  }
  async function notificationMirrors(records: readonly SpaceNotification[]) {
    const paneOpen = paneCache();
    return (await Promise.all(records.map((record) => notificationMirror(record, paneOpen)))).filter((mirror): mirror is Mirror => mirror !== null);
  }

  /** Each page of a notification query, oldest page last (the list pages by createdAt). */
  async function eachNotificationPage(owner: string, query: Omit<NotificationListQuery, "limit" | "before">, each: (page: SpaceNotification[]) => Promise<unknown>) {
    for (let before: string | undefined; ;) {
      const page = await deps.notifications.list(owner, { ...query, limit: PAGE, ...(before ? { before } : {}) });
      await each(page);
      // shortcut: a record sharing the page's last createdAt to the millisecond is left for the live sync, if records ever share one.
      if (page.length < PAGE || page.at(-1)!.createdAt === before) return;
      before = page.at(-1)!.createdAt;
    }
  }
  async function allRequests(owner: string): Promise<NousOperatorRequest[]> {
    const out: NousOperatorRequest[] = [];
    for (let before: string | undefined; ;) {
      const page = await deps.requests.page(owner, { limit: PAGE, ...(before ? { before } : {}) });
      out.push(...page.requests);
      if (!page.hasMore || !page.requests.length) return out;
      before = page.requests.at(-1)!.messageId;
    }
  }
  async function syncNotifications(owner: string, records: readonly SpaceNotification[], history = false) {
    const mirrors = await notificationMirrors(records);
    return serial(owner, () => apply(owner, mirrors, history));
  }
  const syncDecisions = (owner: string, decisions: readonly NousDecision[], history = false) => serial(owner, () => apply(owner, decisions.map(decisionMirror), history));
  // Speed audit 21/11: tick() re-applied every historical operator request (often ~1,000+ rows) every 60 s, driving 8.92M space_inbox_events reads/24h.
  // Keep each owner's last synced fingerprint per messageId and apply only changed or new requests on live ticks.
  const syncedRequests = new Map<string, Map<string, string>>();
  const requestFingerprint = (request: NousOperatorRequest) =>
    `${request.status}\u0000${request.planId ?? ""}\u0000${request.planPercent ?? ""}\u0000${request.doneAt ?? ""}\u0000${request.doneId ?? ""}\u0000${request.answeredAt ?? ""}\u0000${request.doneSummary ?? ""}\u0000${(request.tickets ?? []).join(",")}\u0000${request.text}`;
  async function syncRequests(owner: string, history = false, force = false) {
    const requests = await allRequests(owner);
    // Oldest first: a request's own Thread exists before the newer records that join it.
    return serial(owner, async () => {
      const previous = history || force ? undefined : syncedRequests.get(owner);
      const next = new Map<string, string>();
      const changed: NousOperatorRequest[] = [];
      for (const request of requests) {
        const fp = requestFingerprint(request);
        next.set(request.messageId, fp);
        if (!previous || previous.get(request.messageId) !== fp) changed.push(request);
      }
      if (!changed.length) return 0;
      const appended = await apply(owner, changed.map(requestMirror).reverse(), history);
      syncedRequests.set(owner, next);
      return appended;
    });
  }

  const api = {
    mirrorChanges,
    /** A notification created or changed (the event stream): its record, or the decision its card stands for, and a Done's request. */
    async syncNotification(owner: string, id: string): Promise<void> {
      const record = await deps.notifications.get(owner, id);
      if (!record) return;
      const decisionId = DECISION_CARD.exec(record.dedupeKey ?? "")?.[1];
      if (decisionId) {
        const decision = await deps.decisions.get(owner, decisionId);
        if (decision) await syncDecisions(owner, [decision]);
        return;
      }
      await syncNotifications(owner, [record]);
      if (isDone(record)) await syncRequests(owner);
    },
    async syncDecision(owner: string, id: string): Promise<void> {
      const decision = await deps.decisions.get(owner, id);
      if (decision) await syncDecisions(owner, [decision]);
    },
    syncRequests: (owner: string) => syncRequests(owner),
    /** One source record by its ref, after an act wrote to it. */
    async syncRef(owner: string, ref: string): Promise<void> {
      if (ref.startsWith("nous_decision:")) return api.syncDecision(owner, ref);
      if (ref.startsWith("nous_msg:")) { await syncRequests(owner, false, true); return; }
      return api.syncNotification(owner, ref);
    },
    /** The operator closes a Thread (DONE, DISMISS): a ref-less CLOSED, which an ask still open for the operator overrides (§3). */
    closeByOperator(owner: string, threadId: string, notRelevant = false): Promise<void> {
      return serial(owner, async () => {
        const n = (await repository.events(owner, threadId)).filter((event) => event.type === "CLOSED" && !event.ref).length;
        await repository.append(owner, `${threadId}:CLOSED:${n}`, { threadId, type: "CLOSED", at: iso(), actor: "You", title: notRelevant ? INBOX_NOT_RELEVANT : "Closed", body: "", priority: "INFO" });
        await refresh(owner, threadId, [], false);
        syncedRequests.delete(owner);
      });
    },
    /**
     * Plan clipboard:JD8EbQgQdRls §3: a pane's report on a plan is one progress line on the Thread of the request that plan serves (a request
     * with a plan); other plans' reports stay with Nous. Written once per report; the Thread counts once however many lines it holds.
     */
    async progress(owner: string, report: PaneReport, actor: string): Promise<void> {
      const line = inboxProgressLine(report);
      const { planId } = report;
      if (!line || !planId) return;
      return serial(owner, async () => {
        const thread = await repository.threadOfPlan(owner, planId);
        if (!thread?.refs.requestId || thread.closedAt) return;
        const event = await repository.append(owner, `pane_report:${report.id}:PROGRESS:0`, { threadId: thread.id, type: "PROGRESS", at: report.at, actor,
          title: line, body: "", priority: "INFO", ref: `progress:${planId}` });
        if (event) await refresh(owner, thread.id, [], false);
      });
    },
    /** Seen on a request still in progress: a CLOSED on the progress lines' own ref settles them (inboxThreadState) and leaves the Thread open. */
    seenProgress(owner: string, threadId: string): Promise<void> {
      return serial(owner, async () => {
        const events = await repository.events(owner, threadId);
        const last = events.findLast((event) => event.ref?.startsWith("progress:"));
        if (last?.type !== "PROGRESS") return;
        const n = events.filter((event) => event.type === "CLOSED" && event.ref === last.ref).length;
        await repository.append(owner, `${last.ref}:CLOSED:${n}`, { threadId, type: "CLOSED", at: iso(), actor: "You", title: "Seen", body: "", priority: "INFO", ref: last.ref! });
        await refresh(owner, threadId, [], false);
      });
    },
    async badge(owner: string) {
      const threads = await repository.threads(owner, { open: true });
      const needEvents = threads.filter((thread) => thread.unseen && thread.waitingFor !== "OPERATOR");
      const byThread = needEvents.length ? await repository.eventsOfThreads(owner, needEvents.map((thread) => thread.id)) : new Map<string, InboxEvent[]>();
      return inboxBadge(threads.map((thread) => {
        if (!thread.unseen || thread.waitingFor === "OPERATOR") return thread;
        const { openRequest, news } = inboxThreadState(byThread.get(thread.id) ?? [], thread.title);
        return { ...thread, openRequest, news };
      }));
    },
    /**
     * Every minute: what changes without an event. Requests move as Nous works, a hold for Nous ends, a pane closes under a needs-you card, a
     * decision's hold clears. Each query reads only the records it names (what waits on a pane above INFO, what carries a hold).
     */
    async tick(owner: string): Promise<void> {
      await syncRequests(owner);
      await eachNotificationPage(owner, { status: "WAITING", onPane: true, aboveInfo: true }, (page) => syncNotifications(owner, page));
      await eachNotificationPage(owner, { status: "WAITING", payloadHas: "heldForNous" }, (page) => syncNotifications(owner, page));
      await syncDecisions(owner, await deps.decisions.list(owner, { statuses: ["OPEN"] }));
    },
    /** Every record, oldest Threads first; idempotent (each change has its key), so it runs on every start. Pages take the owner's turn one at a time. */
    async backfill(owner: string): Promise<{ appended: number }> {
      let appended = await syncRequests(owner, true);
      for (let before: string | undefined; ;) {
        const page = await deps.decisions.list(owner, { limit: PAGE, ...(before ? { before } : {}) });
        appended += await syncDecisions(owner, [...page].reverse(), true);
        // shortcut: the same millisecond tie as the notification pages, left for the next tick or event.
        if (page.length < PAGE) break;
        before = page.at(-1)!.createdAt;
      }
      await eachNotificationPage(owner, { status: "ALL" }, async (page) => { appended += await syncNotifications(owner, [...page].reverse(), true); });
      // Threads stored before `now` skipped a title equal to the Thread's: refreshed once, after which `now` differs or is blank.
      for (const thread of await repository.threads(owner)) {
        // Plan Threads stored before planTitle carried their first record's title (16/11: a Braintrust answer named an Upwork ask).
        const title = await planTitle(owner, thread.key);
        const retitled = Boolean(title && title !== thread.title);
        if (retitled) await repository.saveThread({ ...thread, title: title! });
        if (thread.now && (thread.now === thread.title || retitled)) await refresh(owner, thread.id, [], true);
      }
      return { appended };
    },
    /**
     * Shadow check (§12 step 1): the asks the Threads hold for the operator against today's Needs you and open decisions, and the Threads'
     * badge against today's item count. Read-only.
     */
    async check(owner: string) {
      const needs: SpaceNotification[] = [];
      await eachNotificationPage(owner, { status: "NEEDS_YOU" }, async (page) => { needs.push(...page.filter((record) => needsYou(record) && !heldForNous(record, clock()))); });
      const unread: SpaceNotification[] = [];
      await eachNotificationPage(owner, { status: "OPEN", aboveInfo: true }, async (page) => {
        unread.push(...page.filter((record) => !needsYou(record) && !heldForNous(record, clock())));
      });
      const decisions = (await deps.decisions.list(owner, { statuses: ["OPEN"] })).filter((decision) => nousDecisionRunsWhen(decision) === null);
      const expected = new Set([...needs.map((record) => DECISION_CARD.exec(record.dedupeKey ?? "")?.[1] ?? record.id), ...decisions.map((decision) => decision.id)]);
      const threads = await repository.threads(owner, { open: true });
      const byThread = threads.length ? await repository.eventsOfThreads(owner, threads.map((thread) => thread.id)) : new Map<string, InboxEvent[]>();
      const asks = new Map<string, number>();
      const badgeRows = threads.map((thread) => {
        const state = inboxThreadState(byThread.get(thread.id) ?? [], thread.title);
        for (const ask of state.openAsks) {
          if (ask.ask?.forOperator) asks.set(ask.ref!, (asks.get(ask.ref!) ?? 0) + 1);
        }
        return thread.unseen && thread.waitingFor !== "OPERATOR" ? { ...thread, openRequest: state.openRequest, news: state.news } : thread;
      });
      const { badge, attention } = inboxBadge(badgeRows);
      return {
        missing: [...expected].filter((ref) => !asks.has(ref)),
        stale: [...asks.keys()].filter((ref) => !expected.has(ref)),
        duplicates: [...asks].filter(([, count]) => count > 1).map(([ref]) => ref),
        threadBadge: badge, attention, openThreads: threads.length,
        // Today's count is per item (every card and decision); the Threads' is per Thread, so it is at most this.
        itemBadge: expected.size + unread.filter((record) => !isDone(record) || waits(record)).length
      };
    }
  };
  return api;
}
export type InboxService = ReturnType<typeof createInboxService>;
