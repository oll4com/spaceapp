import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InboxEvent, InboxPage, InboxTab, InboxThreadView, NousDecision, NousOverview, NousPaneBoard, SpaceNotification } from "@space/contracts";
import { inboxPlainLine, inboxTabOf, inboxThreadCounts } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton, DockChips, DockSearch, DockState, useDockConfirm } from "../dock-kit/DockKit.js";
import { Bell } from "../ui-theme/app-icons.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { AgentFileMentions, FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import { refreshNotifications, useNotificationStore } from "../notifications/notification-store.js";
import { NeedsYouCard, type NeedsYouBoardPane } from "../needs-you/NeedsYouCard.js";
import { NeedsYouFiles } from "../needs-you/NeedsYouFiles.js";
import { NOUS_DONE_OPEN_EVENT, consumeInboxView } from "./nous-done-events.js";
import { planUnblocks } from "./NousNeedsYou.js";
import { DoneTickets } from "./NousDone.js";
import { NousRequests, STATUS_LABELS } from "./NousRequests.js";
import { useNousUiState } from "./nous-ui-state.js";
import { scrollWithin } from "./nous-scroll.js";
import "./nous-done.css";

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
type Group = "operator" | "new" | "working" | "closed";
/** Plan clipboard:JD8EbQgQdRls (operator 24/11): the Inbox's four tabs, in the order the first one with something opens. */
export const INBOX_TABS = ["NEEDS", "DONE", "UPDATES", "REQUESTS"] as const satisfies readonly InboxTab[];
const TAB_LABELS: Record<InboxTab, string> = { NEEDS: "Needs you", DONE: "Done", UPDATES: "Updates", REQUESTS: "Requests" };
const TAB_EMPTY: Record<InboxTab, string> = { NEEDS: "Nothing waits for you", DONE: "You’re up to date", UPDATES: "No updates yet", REQUESTS: "No request in progress" };
const WHERE_LABELS = { stable: "Stable", dev: "Dev", "no code": "No code" } as const;
/** The tab he chose, kept on this device (nous-ui-state); null: the first tab with something. NousDock writes it for a toast, pop-up or push. */
export const INBOX_TAB_KEY = "inbox.tab";
export const isInboxTabChoice = (value: unknown): value is InboxTab | null => value === null || INBOX_TABS.includes(value as InboxTab);
export const inboxGroupOf = (thread: InboxThreadView): Group =>
  thread.closedAt ? "closed" : thread.waitingFor === "OPERATOR" ? "operator" : thread.unseen && !thread.openRequest ? "new" : "working";
const EVENT_LABELS: Record<InboxEvent["type"], string> = { REQUEST: "Request", ASK: "Asked", ANSWER: "Answered", PROGRESS: "Progress", REPORT: "Report",
  UPDATE: "Update", ALERT: "Alert", NOTE: "Nous note", CLOSED: "Closed", REOPENED: "Reopened" };

/** The bell, a toast or the phone's push asks for this view; the dock is lazy, so the request waits for its mount (nous-done-events.ts). */
export function useInboxView(onOpen: () => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const open = () => { if (consumeInboxView()) callback.current(); };
    window.addEventListener(NOUS_DONE_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NOUS_DONE_OPEN_EVENT, open);
  }, []);
}

/** What one Thread card renders its asks with: the source's own card when the dock holds the record (spec §6), else the Thread's verbs. */
export interface InboxCardSources {
  decisions: NousDecision[];
  needs: SpaceNotification[] | null;
  panes?: Map<string, NeedsYouBoardPane>;
  plans?: NousOverview["plans"];
  renderDecision(decision: NousDecision): ReactNode;
  onOpenPlan(id: string): void;
  /** The list keeps one needs-you card open (the one a toast or pop-up was clicked for, first); without it each card keeps its own. */
  openCard?: { id: string | null; set(id: string | null): void };
}

/**
 * One Thread (spec v2 §6): a strip by who it waits on, who and what, its line now, meta and progress; the current step's answer only; a click
 * opens its timeline (Nous's notes folded). The same card in Conversation (E5).
 */
export function InboxThreadCard({ thread, sources, onChanged }: { thread: InboxThreadView; sources: InboxCardSources; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const { confirm, confirmDialog } = useDockConfirm();
  const [events, setEvents] = useState<InboxEvent[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const group = inboxGroupOf(thread);
  // An answered ask leaves the card at once (operator 13/11: every action reacts at once); a failure brings it back with the error.
  const [answered, setAnswered] = useState<string | null>(null);
  const asks = thread.openAsks.filter((event) => event.ask?.forOperator && event.ref !== answered);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.inboxThread(thread.id).then((answer) => { if (!cancelled) setEvents(answer.events); }, (failure: unknown) => { if (!cancelled) setError(messageOf(failure, "The thread could not be loaded.")); });
    return () => { cancelled = true; };
  }, [expanded, thread.id, thread.lastEventAt]);
  const act = async (input: Parameters<typeof api.actInbox>[1]) => {
    setBusy(true);
    setError(null);
    if (input.askId) setAnswered(input.askId);
    try { await api.actInbox(thread.id, input); setText(""); onChanged(); void refreshNotifications(); }
    catch (failure) { setAnswered(null); setError(messageOf(failure, "That did not work. Try again.")); }
    finally { setBusy(false); }
  };
  const dismiss = async () => {
    // E3: an ask still open is cancelled unanswered, so it is confirmed first.
    if (asks.length && !(await confirm({ title: t("Not relevant to you?"), message: t("What it still asks is cancelled without an answer and the thread closes."), confirmLabel: t("Not relevant") }))) return;
    await act({ verb: "DISMISS" });
  };
  const askNode = (event: InboxEvent) => {
    const decision = event.ref ? sources.decisions.find((item) => item.id === event.ref) : undefined;
    if (decision) return <div key={event.id} style={{ display: "contents" }}>{sources.renderDecision(decision)}</div>;
    const card = event.ref ? sources.needs?.find((item) => item.id === event.ref) : undefined;
    if (card) return <NeedsYouCard key={event.id} variant="row" item={card} pane={card.paneId ? sources.panes?.get(card.paneId) : undefined} unblocks={planUnblocks(card, sources.plans ?? [])}
      {...(sources.openCard ? { open: sources.openCard.id === card.id, onOpenChange: (open: boolean) => sources.openCard!.set(open ? card.id : null) } : {})}
      onOpenPlan={sources.onOpenPlan} onAnswered={onChanged} />;
    // shortcut: a record the dock has not loaded answers through the Thread's verbs (no Go to pane); its source card covers that once loaded.
    // Its files show here though (operator nous_msg:acb1aa48, 23/11: an approval of two .md files reached the Nous app with no way to read them).
    const ask = event.ask!;
    const approval = ask.kind === "APPROVAL" && !ask.options.length;
    return (
      <div key={event.id} className="inbox-ask" data-ask-ref={event.ref}>
        <p className="inbox-ask-title">{event.title}</p>
        {event.body ? <div className="inbox-ask-body">{expanded ? <ChatMarkdown content={event.body} /> : inboxPlainLine(event.body)}</div> : null}
        <NeedsYouFiles refs={ask.files} />
        <div className="inbox-ask-actions">
          {approval ? <>
            <DockButton tone="primary" disabled={busy} onClick={() => void act({ verb: "APPROVE", askId: event.ref })}>{t("Approve")}</DockButton>
            {ask.always ? <DockButton disabled={busy} onClick={() => void act({ verb: "APPROVE", askId: event.ref, always: true })}>{t("Always approve")}</DockButton> : null}
            <DockButton disabled={busy} onClick={() => void act({ verb: "DECLINE", askId: event.ref })}>{t("Decline")}</DockButton>
          </> : ask.options.map((option) => (
            <DockButton key={option} tone={option === ask.recommended ? "primary" : "default"} disabled={busy} onClick={() => void act({ verb: "ANSWER", askId: event.ref, option })}>{option}</DockButton>
          ))}
        </div>
        <form className="inbox-ask-answer" onSubmit={(submit) => { submit.preventDefault(); if (text.trim()) void act({ verb: "ANSWER", askId: event.ref, text: text.trim() }); }}>
          <input value={text} onChange={(change) => setText(change.target.value)} maxLength={2_000} aria-label={t("Your answer")} placeholder={t("Answer…")} />
          <DockButton type="submit" disabled={busy || !text.trim()}>{t("Send")}</DockButton>
        </form>
      </div>
    );
  };
  const notes = events?.filter((event) => event.type === "NOTE") ?? [];
  const eventRow = (event: InboxEvent) => (
    <li key={event.id} className={`inbox-event is-${event.type.toLowerCase()}`}>
      <span className="inbox-event-meta">{t(EVENT_LABELS[event.type])} · <time dateTime={event.at}>{formatUserTime(event.at, { withDate: true })}</time></span>
      {event.title ? <strong>{event.title}</strong> : null}
      {event.body ? <div><ChatMarkdown content={event.body} /></div> : null}
    </li>
  );
  return (
    <article className={`inbox-thread is-${group}${thread.priority === "URGENT" && !thread.closedAt ? " is-urgent" : ""}`} data-thread-id={thread.id} aria-label={thread.title}>
      <button type="button" className="inbox-thread-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="inbox-thread-who">{thread.originLabel}</span>
        <span className="inbox-thread-title">{thread.title}</span>
        {/* `now` names the latest ask for the operator, which the card shows below it (plan LkwKdOOh2mXK step 7). */}
        {thread.now && !asks.length ? <span className="inbox-thread-now">{thread.now}</span> : null}
        <span className="inbox-thread-meta">
          <time dateTime={thread.lastEventAt}>{formatUserTime(thread.lastEventAt, { withDate: true })}</time>
          {thread.refs.requestStatus && !thread.closedAt ? ` · ${t(STATUS_LABELS[thread.refs.requestStatus])}` : ""}
          {thread.progress !== null ? ` · ${thread.progress}%` : ""}
          {thread.refs.where ? ` · ${t(WHERE_LABELS[thread.refs.where])}` : ""}
        </span>
      </button>
      {thread.progress !== null && !thread.closedAt ? <progress className="inbox-thread-progress" max={100} value={thread.progress} aria-label={t("Progress")} /> : null}
      {/* A Done report: its summary and what was checked, read without opening the timeline. */}
      {thread.report ? <p className="inbox-thread-report"><FileMentionText text={thread.report} /></p> : null}
      {thread.refs.ticketIds?.length ? <DoneTickets ids={thread.refs.ticketIds} /> : null}
      {asks.map(askNode)}
      {error ? <p role="alert" className="inbox-thread-error">{t(error)}</p> : null}
      <div className="inbox-thread-actions">
        {thread.refs.planId ? <DockButton onClick={() => sources.onOpenPlan(thread.refs.planId!)}>{t("Open plan")}</DockButton> : null}
        {/* Operator 16/11 12:41: work in progress has no Done; it leaves when Nous records it done (Not relevant still closes it). */}
        {/* A request with a plan and unread news is marked seen and stays in progress (plan JD8EbQgQdRls §3). */}
        {!thread.closedAt && !asks.length && (group !== "working" || thread.requestNews) ? <DockButton disabled={busy} onClick={() => void act({ verb: "DONE" })}>{t(thread.requestNews || thread.news === "REPORT" ? "Seen it" : "Done")}</DockButton> : null}
        <DockButton tone="ghost" onClick={() => setExpanded(!expanded)}>{t(expanded ? "Less" : "Details")}</DockButton>
        {!thread.closedAt ? <DockButton disabled={busy} onClick={() => void dismiss()}>{t("Not relevant")}</DockButton> : null}
      </div>
      {expanded ? (
        <div className="inbox-thread-timeline">
          {events === null && !error ? <DockState kind="loading" title={t("Loading the thread")} /> : null}
          <ol>{events?.filter((event) => event.type !== "NOTE").map(eventRow)}</ol>
          {notes.length ? <details><summary>{t("Nous notes ({count})", { count: notes.length })}</summary><ol>{notes.map(eventRow)}</ol></details> : null}
        </div>
      ) : null}
      {confirmDialog}
    </article>
  );
}

/** The pane board's panes, for the needs-you cards' place lines; read once while a card is shown. */
export function useNeedsYouPanes(wanted: boolean): Map<string, NeedsYouBoardPane> | undefined {
  const [board, setBoard] = useState<NousPaneBoard | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void api.nousPaneBoard().then((result: { board: NousPaneBoard }) => { if (!cancelled) setBoard(result.board); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [wanted]);
  return useMemo(() => board ? new Map<string, NeedsYouBoardPane>(board.rooms.flatMap((room) => room.panes.map((pane) => [pane.paneId, { ...pane, roomName: room.name, lineLanguage: board.settings.language }] as const))) : undefined, [board]);
}

/**
 * Nous › «Εισερχόμενα» v2 (spec §6, plan clipboard:aE7U1J_gU9OV) in four tabs (plan clipboard:JD8EbQgQdRls): Needs you, Done, Updates and
 * Requests over the same Threads, each with the server's counter; the search covers every Thread whatever the tab.
 */
export function NousInbox({ active, sources, focus, trailing }: {
  active: boolean; sources: Omit<InboxCardSources, "panes" | "openCard">;
  /** The needs-you card a toast, the small window or a pop-up was clicked for (a new object each click). */
  focus: { id: string | null } | null; trailing?: ReactNode;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const store = useNotificationStore();
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [page, setPage] = useState<InboxPage | null>(null);
  const [older, setOlder] = useState<{ threads: InboxThreadView[]; cursor: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [doneBusy, setDoneBusy] = useState(false);
  const [chosen, setChosen] = useNousUiState<InboxTab | null>(INBOX_TAB_KEY, null, isInboxTabChoice);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => { const timer = window.setTimeout(() => setAsked(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => setOlder(null), [asked]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // What is open comes whole; the closed page is the Updates tab's read ones (a search reads every Thread).
    api.inbox(asked ? { q: asked } : { tab: "UPDATES" }).then((next) => { if (!cancelled) { setPage(next); setError(null); } },
      (failure: unknown) => { if (!cancelled) setError(messageOf(failure, "The inbox could not be loaded. Try again.")); });
    return () => { cancelled = true; };
  }, [active, asked, store.inbox, revision]);
  const cursor = older ? older.cursor : page?.cursor ?? null;
  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const next = await api.inbox({ cursor, tab: "UPDATES" });
      setOlder((current) => ({ threads: [...current?.threads ?? [], ...next.threads], cursor: next.cursor }));
    } catch (failure) { setError(messageOf(failure, "The inbox could not be loaded. Try again.")); } finally { setLoadingOlder(false); }
  };
  // shortcut: older read updates page with a button, not on scroll; add an IntersectionObserver if the operator asks.
  const loadEarlier = cursor ? <DockButton className="nous-load-earlier" busy={loadingOlder} disabled={loadingOlder} onClick={() => void loadOlder()}>{t("Load earlier")}</DockButton> : null;
  const threads = useMemo(() => {
    const first = page?.threads ?? [];
    const ids = new Set(first.map((thread) => thread.id));
    return [...first, ...(older?.threads ?? []).filter((thread) => !ids.has(thread.id))];
  }, [page, older]);
  const panes = useNeedsYouPanes(active && threads.some((thread) => thread.openAsks.some((event) => event.ref?.startsWith("notification:"))));
  const counts = page?.summary.tabs;
  const countOf = (id: InboxTab) => counts?.[id.toLowerCase() as Lowercase<InboxTab>] ?? 0;
  const tab = chosen ?? INBOX_TABS.find((id) => countOf(id) > 0) ?? "NEEDS";
  // A clicked needs-you card opens in its Thread, brought into view once the list holds it.
  const scrollTo = useRef<string | null>(focus?.id ?? null);
  const [openCard, setOpenCard] = useState<string | null>(focus?.id ?? null);
  useEffect(() => { if (focus?.id) { scrollTo.current = focus.id; setOpenCard(focus.id); } }, [focus]);
  useEffect(() => {
    const id = scrollTo.current;
    const card = id ? [...rootRef.current?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? []].find((element) => element.querySelector(`[data-notification-id="${CSS.escape(id)}"]`)) : null;
    if (card) { scrollWithin(card, "nearest", "auto", rootRef.current); scrollTo.current = null; }
  }, [threads, focus, tab]);
  const open = threads.filter((thread) => !thread.closedAt);
  const inTab = (id: InboxTab) => open.filter((thread) => !thread.held && (thread.tab ?? inboxTabOf(thread)) === id);
  // Updates: news on a request with a plan first (it stays under Requests too), then what counts; only what does not count (INFO alerts) folds at the end.
  // Operator 26/11 20:38 BKK (chip 6, one card: 5 ATTENTION alerts were folded): the cards on top are the server's tabs.updates, by its own inboxThreadCounts.
  const updates = [...open.filter((thread) => thread.requestNews), ...inTab("UPDATES").filter(inboxThreadCounts)];
  const alerts = inTab("UPDATES").filter((thread) => !inboxThreadCounts(thread));
  const read = threads.filter((thread) => thread.closedAt);
  const held = open.filter((thread) => thread.held);
  // «Seen all» marks only the active tab's list (Done or Updates); a request's news is seen and it stays in progress.
  const seenAll = async (ids: string[]) => {
    setDoneBusy(true);
    // Technical: the route takes 500 ids a call (inboxDoneAllInputSchema), so more go in turns.
    try { for (let at = 0; at < ids.length; at += 500) await api.inboxDoneAll(ids.slice(at, at + 500)); reload(); void refreshNotifications(); }
    catch (failure) { setError(messageOf(failure, "That did not work. Try again.")); } finally { setDoneBusy(false); }
  };
  const seenAllBar = (ids: string[]) => ids.length ? <div className="nous-inbox-summary">
    <DockButton className="nous-inbox-done-all" disabled={doneBusy} busy={doneBusy} onClick={() => void seenAll(ids)}>{t("Seen all")}</DockButton>
  </div> : null;
  const cardSources: InboxCardSources = { ...sources, panes, openCard: { id: openCard, set: setOpenCard } };
  const cards = (list: InboxThreadView[]) => list.map((thread) => <InboxThreadCard key={thread.id} thread={thread} sources={cardSources} onChanged={reload} />);
  const empty = (title: string) => <DockState kind="empty" icon={Bell} title={t(title)} />;
  const shown = inTab(tab);
  return (
    <AgentFileMentions>
    <div className="nous-decisions nous-inbox" ref={rootRef} data-inbox-tab={asked ? "search" : tab}>
      <DockSearch value={query} onChange={setQuery} label={t("Search the inbox")} placeholder={t("Search every thread")} />
      {!asked ? <DockChips className="nous-inbox-tabs" label={t("Inbox tabs")} value={tab} onChange={setChosen}
        options={INBOX_TABS.map((id) => ({ id, label: t(TAB_LABELS[id]), ...(countOf(id) ? { count: countOf(id) } : {}), ...(id === "NEEDS" ? { tone: "attention" as const } : {}) }))} /> : null}
      {error ? <div><p role="alert">{t(error)}</p><DockButton onClick={reload}>{t("Retry")}</DockButton></div> : null}
      {!page && !error ? <DockState kind="loading" title={t("Loading the inbox")} /> : null}
      {/* shortcut: a tab's cards unmount when another tab shows, so an answer typed and not sent is lost on a tab switch; keep the tabs mounted if the operator asks. */}
      {!page ? null : asked ? <>{threads.length ? null : empty("No thread matches")}{cards(threads)}</>
        : tab === "UPDATES" ? <>
          {seenAllBar([...updates, ...alerts].map((thread) => thread.id))}
          {updates.length || alerts.length || read.length ? null : empty(TAB_EMPTY.UPDATES)}
          {cards(updates)}
          {read.length ? <h3 className="nous-inbox-group-title">{t("Earlier updates")}</h3> : null}
          {cards(read)}
          {loadEarlier}
          {alerts.length ? <details className="nous-inbox-alerts"><summary>{t("Alerts from copilots and the system ({count})", { count: alerts.length })}</summary>{cards(alerts)}</details> : null}
        </>
        : tab === "REQUESTS" ? <>
          {cards(shown)}
          {/* Plan LkwKdOOh2mXK step 1: what Nous or an agent decides (held for Nous) is one folded line each, never a card. */}
          {held.length ? <details className="nous-inbox-held"><summary>{t("Nous handles these ({count})", { count: held.length })}</summary>
            <ul>{held.map((thread) => <li key={thread.id} data-thread-id={thread.id} title={thread.now || thread.title}><span>{thread.originLabel}</span> {thread.now || thread.title}</li>)}</ul></details> : null}
          <h3 className="nous-inbox-group-title">{t("All requests")}</h3>
          <NousRequests active={active} onOpenPlan={sources.onOpenPlan} />
          {trailing}
        </>
        : <>{tab === "DONE" ? seenAllBar(shown.map((thread) => thread.id)) : null}{shown.length ? null : empty(TAB_EMPTY[tab])}{cards(shown)}{tab === "NEEDS" ? trailing : null}</>}
    </div>
    </AgentFileMentions>
  );
}
