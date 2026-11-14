import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { scoreQuery, scoreHistoryQuery } from "./nous-score-query.js";
import { nousModelLabel, withoutNothingNew } from "@space/contracts";
import { openSettingsSection } from "../settings/settings-section-request.js";
import { NousRemoteMark } from "./NousRemoteMark.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { NEEDS_YOU_CHECKED_HEADER, nousDecisionKind, parseNousGoalCommand, type ClipboardItem, type NousAttachment, type NousDecision, type NousMessage, type NousOverview, type NousPlanHold, type NousState,
  type SpaceNotification, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { AgentFileMentions } from "../terminal-pane/AgentFileLinks.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockFullscreenButton, DockIconButton, DockNotice, DockSearch, DockState, useDockConfirm, type DockChipOption } from "../dock-kit/DockKit.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { requestNousFocus, useLeaveDuringNousFocus } from "../nous-focus/nous-focus-events.js";
import { NousAppointments } from "./NousAppointments.js";
import { clearConversationMatches, findConversationText, paintConversationMatches, searchPlans } from "./nous-search.js";
import { Activity, ArrowLeft, CalendarCheck, ChartSpline, Check, CheckCheck, ChevronDown, ChevronRight, ChevronUp, ChevronsDown, ChevronsUp, CircleStop, ClipboardList, FileSymlink, Gauge, Gavel, Briefcase, Handshake, TrendingUp, LayoutGrid, ListChecks, Maximize2, Megaphone, MessageSquare, Minimize2, Nous, Paperclip, Rocket, Search, Send, Star, Target, Trash2, UserCheck, X } from "../ui-theme/app-icons.js";
import { NousBrain3D } from "./NousBrain3D.js";
import { NousLiveStats } from "./NousLiveStats.js";
import { NousDone, useDoneRequests, useDoneView } from "./NousDone.js";
import { NousUpdates, useOperatorUpdates, useUpdatesView } from "./NousUpdates.js";
import { NousShared, useSharedFiles } from "./NousShared.js";
import { NousRequests, useRequestsInProgress } from "./NousRequests.js";
import { decisionMarkdown, needsYouMarkdown, NousNeedsYou, PlanNeedsYou, useNeedsYouRequests } from "./NousNeedsYou.js";
import { NeedsYouFiles } from "../needs-you/NeedsYouFiles.js";
import { useNeedsYouView } from "../needs-you/needs-you-view.js";
import { consumePlanView, NOUS_DONE_OPEN_EVENT } from "./nous-done-events.js";
import { goToNeedsYouPane, peekNotificationStore } from "../notifications/notification-store.js";
import { NousPaneBoard } from "./NousPaneBoard.js";
import { NousPlanMap } from "./NousPlanMap.js";
import { NousGoals } from "./NousGoals.js";
import { NousPrograms } from "./NousPrograms.js";
import { NousJobs } from "./NousJobs.js";
import { NousCrypto } from "./NousCrypto.js";
import { NousMarketing } from "./NousMarketing.js";
import { useNousHistory } from "./nous-history.js";
import { NousQuotas } from "./NousQuotas.js";
import { NousLoad } from "./NousLoad.js";
import { NousScore } from "./NousScore.js";
import { NousTaskRuns } from "./NousTaskRuns.js";
import { useOptionalVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { VoiceInputButton } from "../voice-input/VoiceInputButton.js";
import { isFlag, isIdOrNull, useNousUiIds, useNousUiState } from "./nous-ui-state.js";
import { useAgentLanguage, useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { clipboardFiles, NousMessageFiles, NousPendingFiles, operatorText, usePendingFiles } from "./NousFiles.js";
import "./nous.css";
import { setClientView } from "../../client-context.js";

type Tab = "conversation" | "needs" | "done" | "updates" | "requests" | "shared" | "decisions" | "overview" | "panes" | "plans" | "goals" | "startup" | "affiliate" | "jobs" | "crypto" | "marketing" | "quotas" | "load" | "score" | "taskRuns";
const FAST_POLL_MS = 3_000;
const NOUS_VOICE_OWNER = "nous-dock";
const SLOW_POLL_MS = 20_000;
/** While Nous writes (a streamed draft exists) the dock reads it more often; back to the thinking cadence otherwise. */
const DRAFT_POLL_MS = 1_500;
const STATUS_LABELS: Record<NousState["status"], string> = {
  OFF: "Off: answers you only", IDLE: "On: watching every room", THINKING: "Thinking…", PAUSED_MODEL: "Paused: its model is not available",
  WAITING_QUOTA: "Waiting for quota: your messages are still answered",
  UNAVAILABLE: "Unavailable: it cannot run here now"
};
const REASON_LABELS: Record<NonNullable<NousState["running"]>["reason"], string> = {
  OPERATOR: "Answering you", INBOX: "Reading news from the rooms", DECISION: "Acting on your answer", HEARTBEAT: "Checking every room", STANDING: "Standing orders: finished panes and stalled plans",
  REVIEW: "Daily self-review", GOAL: "Working on your goals"
};
const VIEW_TITLES: Record<Tab, string> = { conversation: "Conversation", needs: "Needs you", done: "Done", updates: "Updates", requests: "Requests", shared: "Shared", decisions: "Decisions", overview: "Overview", panes: "Pane board", plans: "Plans", goals: "Goals", startup: "Startup programs", affiliate: "Affiliate", jobs: "Job applications", crypto: "Crypto", marketing: "Marketing", quotas: "Quotas", load: "Load", score: "Score", taskRuns: "Task runs" };
// The maximized rail groups the views (operator 3/11, after the Nous app's grouped tabs): what is his, the work, the system.
const RAIL_SECTIONS: Array<[string, Tab[]]> = [["Me", ["conversation", "needs", "decisions", "done", "updates", "requests", "shared"]],
  ["Work", ["overview", "panes", "plans", "goals", "startup", "affiliate", "jobs", "crypto", "marketing"]], ["System", ["quotas", "load", "score", "taskRuns"]]];
const isDecisionFilter = (value: unknown): value is "open" | "all" => value === "open" || value === "all";
const isTab = (value: unknown): value is Tab => typeof value === "string" && Object.hasOwn(VIEW_TITLES, value);
// A tab stored on the removed oll4.com funding page (operator 7/11, nous_msg:e9c06cd838de45f4bccda467) opens Startup programs, where its programs went.
const isStoredTab = (value: unknown): value is Tab | "funding" => value === "funding" || isTab(value);
const CATEGORY_LABELS: Record<NousDecision["category"], string> = { RELEASE: "Release", DESTRUCTIVE: "Irreversible", EXTERNAL: "Third parties or money", DIRECTION: "Direction" };
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const planIdsIn = (text: string) => [...new Set(text.match(/clipboard:[A-Za-z0-9_-]+/g) ?? [])];
const statusText = (status: string) => status.replace(/_/g, " ").toLowerCase();
const clock = (iso: string) => formatUserTime(iso);

// There is no single-record clipboard route, so the PLAN list is paged until every id is found (every page since 31/10; until then
// at most 1,000 plans). Missing ids come back as null.
async function findPlans(ids: string[]): Promise<Record<string, ClipboardItem | null>> {
  const found: Record<string, ClipboardItem | null> = Object.fromEntries(ids.map((id) => [id, null]));
  for (let page = 1, left = ids.length; left > 0; page += 1) {
    const result = await api.clipboardItems({ source: "PLAN", pageSize: 100, page });
    for (const item of result.data) if (found[item.id] === null) { found[item.id] = item; left -= 1; }
    if (page >= result.pagination.totalPages) break;
  }
  return found;
}

/** Nous, the mind of SpaceApp: the one conversation over every room, the critical decisions it brings you and the plans it drives. */
export function NousDock(props: { canRun?: boolean; isAdmin?: boolean }) {
  // Scoped to this dock's authenticated lifetime: another account never inherits its score from browser storage.
  const [queries] = useState(() => new QueryClient());
  useEffect(() => {
    if (!props.canRun) return;
    void queries.prefetchQuery(scoreQuery());
    void queries.prefetchQuery(scoreHistoryQuery("24h"));
    return () => queries.clear();
  }, [queries, props.canRun]);
  return <QueryClientProvider client={queries}><NousDockContent {...props} /></QueryClientProvider>;
}

function NousDockContent({ canRun = false, isAdmin = false }: { canRun?: boolean; isAdmin?: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const isActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  // The view, fullscreen and the open plan stay as the operator left them on this device (plan clipboard:d8nCNBw2mzDK).
  const [isFullscreen, setIsFullscreen] = useNousUiState("fullscreen", false, isFlag);
  const [planView, setPlanView] = useNousUiState("plan", null, isIdOrNull);
  const restoredPlanRef = useRef(planView);
  const [plans, setPlans] = useState<Record<string, ClipboardItem | null>>({});
  const [state, setState] = useState<NousState | null>(null);
  const history = useNousHistory();
  const { messages, files: messageFiles } = history;
  /** The operator's messages still in Nous's queue (no answer yet), from the server. */
  const [waiting, setWaiting] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<NousDecision[]>([]);
  // Older answered decisions the operator loaded (31/10: the dock held only the newest 50 answered ones); null: none loaded yet.
  const [earlier, setEarlier] = useState<{ decisions: NousDecision[]; hasMore: boolean } | null>(null);
  const [overview, setOverview] = useState<NousOverview | null>(null);
  const [storedTab, setTab] = useNousUiState<Tab | "funding">("tab", "conversation", isStoredTab);
  const tab: Tab = storedTab === "funding" ? "startup" : storedTab;
  const [everything, setEverything] = useNousUiState("everything", null, isIdOrNull);
  const [decisionFilter, setDecisionFilter] = useNousUiState("decisions.filter", "open", isDecisionFilter);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Where the last jump left the list: its own scroll event is not the operator scrolling. */
  const jumpTopRef = useRef<number | null>(null);
  /** At the end of the conversation it follows new messages; reading further up it stays put. */
  const stickRef = useRef(true);
  /** "Go to my last message" waits for the page that brings its target; "Load earlier" keeps the row that was on top in place. */
  const pendingJumpRef = useRef<string | null>(null);
  const anchorRef = useRef<{ row: Element; top: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Find in the conversation (operator nous_msg:a44eacc4): the query (null while closed), how many matches back from the newest, how many there are. */
  const [search, setSearch] = useState<string | null>(null);
  const [searchBack, setSearchBack] = useState(0);
  const [searchFound, setSearchFound] = useState(0);
  const searchShownRef = useRef("");
  const pending = usePendingFiles(useCallback((message: string) => setError(message), []));
  // The snip tool's Ctrl+V hands held snips to the composer (SnipToolOverlay attachToNous).
  const addPending = pending.add;
  useEffect(() => {
    const attach = (event: Event) => addPending((event as CustomEvent<File[]>).detail ?? []);
    window.addEventListener("space:nous-attach-files", attach);
    return () => window.removeEventListener("space:nous-attach-files", attach);
  }, [addPending]);
  const voiceInput = useOptionalVoiceInput();
  const voiceOwned = voiceInput?.ownerId === NOUS_VOICE_OWNER;
  useEffect(() => () => voiceInput?.cancel(NOUS_VOICE_OWNER), [voiceInput?.cancel]);
  // The tab the operator writes from reaches Nous with each message (plan clipboard:4TXfIZzj8ITW).
  useEffect(() => { setClientView(`nous:${tab}`); return () => setClientView(undefined); }, [tab]);
  const needs = useNeedsYouRequests(isActive && canRun);
  const done = useDoneRequests(isActive && canRun);
  const shared = useSharedFiles(isActive && canRun);
  const inProgress = useRequestsInProgress(isActive && canRun);
  useDoneView(() => { setPlanView(null); setTab("done"); });
  const updates = useOperatorUpdates(isActive && canRun);
  useUpdatesView(() => { setPlanView(null); setTab("updates"); });
  // A click on a needs-you toast, the small window or a pop-up opens its card here (plan clipboard:ytwWl09xNH0Z): never the pane.
  const [needsFocus, setNeedsFocus] = useState<{ id: string | null } | null>(null);
  const clickedCard = useRef<string | null>(null);
  useNeedsYouView((cardId) => { clickedCard.current = cardId; setPlanView(null); setTab("needs"); setNeedsFocus({ id: cardId }); });
  // No Needs you list to open it in (an account Nous does not serve, or the tab switched off): that click takes him to its pane, as before.
  // Decided once per click (null: the settings are not read yet), so a tab hidden later moves nothing.
  const needsHidden = !canRun ? true : state ? state.settings.dockTabs?.needs === false : null;
  useEffect(() => {
    const id = clickedCard.current;
    if (!id || needsHidden === null) return;
    clickedCard.current = null;
    const card = needsHidden ? peekNotificationStore().items.find((item) => item.id === id) : undefined;
    if (card) goToNeedsYouPane(card);
  }, [needsFocus, needsHidden]);
  useEffect(() => {
    if (tab !== "conversation" && (state?.settings.dockTabs?.[tab] === false || (tab === "taskRuns" && state && !isAdmin))) {
      setPlanView(null);
      setTab("conversation");
    }
  }, [tab, state?.settings.dockTabs, isAdmin]);

  const refresh = useCallback(async () => {
    const [next, list, open] = await Promise.all([api.nous(), history.latest(), api.nousDecisions()]);
    setState(next.state);
    setWaiting(list.waiting ?? []);
    setDecisions(open.decisions);
  }, [history.latest]);

  const thinking = state?.status === "THINKING" || sending;
  // The answer as Nous writes it (streamed from its turn, operator request 2026-10-24); the final ANSWER message replaces it.
  const writing = state?.running?.draft ? state.running.draft : null;
  // The poll cadence depends on whether a draft exists, never on its text: a growing draft must not restart the timer each read.
  const draftLive = writing !== null;
  const fullscreen = isFullscreen || planView !== null;
  useEffect(() => {
    if (!isActive || !canRun) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try { await refresh(); } catch (err) { if (!cancelled) setError(messageOf(err, "Nous could not be reached.")); }
      if (!cancelled) timer = window.setTimeout(() => void tick(), draftLive ? DRAFT_POLL_MS : thinking ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [isActive, canRun, refresh, thinking, draftLive]);

  useEffect(() => {
    // Maximized, the board shows the overview in every view.
    if (!isActive || !canRun || (tab !== "overview" && tab !== "panes" && tab !== "plans" && tab !== "goals" && tab !== "needs" && !fullscreen)) return;
    let cancelled = false;
    const load = () => api.nousOverview().then((result) => { if (!cancelled) setOverview(result.overview); })
      .catch((err: unknown) => { if (!cancelled) setError(messageOf(err, "The overview could not be loaded.")); });
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isActive, canRun, tab, fullscreen]);

  // One Escape closes the open plan first, then fullscreen (useDockFullscreen would leave both at once).
  useEffect(() => {
    if (!isFullscreen && !planView) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { if (planView) setPlanView(null); else setIsFullscreen(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, planView]);

  // While Nous takes the operator to a pane the dock leaves fullscreen (it would cover the pane) and returns to it after.
  useLeaveDuringNousFocus({ fullscreen: isFullscreen, plan: planView }, () => { setIsFullscreen(false); setPlanView(null); },
    (saved) => { setIsFullscreen(saved.fullscreen); setPlanView(saved.plan); });

  // Plans Nous asks about (refs.planId) or names in a reply.
  const planIds = useMemo(() => [...new Set([
    ...decisions.flatMap((decision) => decision.refs.planId ? [decision.refs.planId] : []),
    ...(messages ?? []).flatMap((entry) => entry.kind === "ANSWER" ? planIdsIn(entry.content) : [])
  ])].sort().join(" "), [decisions, messages]);
  const loadPlans = useCallback((ids: string[]) => findPlans(ids).then((found) => setPlans((current) => ({ ...current, ...found })))
    .catch((err: unknown) => setError(messageOf(err, "The plan could not be loaded."))), []);
  useEffect(() => {
    const missing = [...(planIds ? planIds.split(" ") : []), ...(planView ? [planView] : [])].filter((id) => !(id in plans));
    if (missing.length) void loadPlans(missing);
  }, [planIds, planView, plans, loadPlans]);
  // A plan restored from the last visit that the clipboard no longer has closes; one opened now still says "Plan not found".
  useEffect(() => {
    const restored = restoredPlanRef.current;
    if (!restored || !(restored in plans)) return;
    restoredPlanRef.current = null;
    if (plans[restored] === null) setPlanView((current) => current === restored ? null : current);
  }, [plans, setPlanView]);
  // "Show everything" stays open only on a decision still waiting for an answer.
  useEffect(() => {
    if (state && everything && !decisions.some((decision) => decision.id === everything && decision.status === "OPEN")) setEverything(null);
  }, [state, everything, decisions, setEverything]);
  const openPlan = (id: string) => { setPlanView(id); if (id in plans) void loadPlans([id]); };
  // Go on a needs-you card about a plan with no open pane (notification-store.ts) opens that plan here, once the dock is mounted.
  const openPlanRef = useRef(openPlan);
  openPlanRef.current = openPlan;
  useEffect(() => {
    const open = () => { const id = consumePlanView(); if (id) openPlanRef.current(id); };
    window.addEventListener(NOUS_DONE_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NOUS_DONE_OPEN_EVENT, open);
  }, []);
  // An open plan is a history entry (operator 31/10 16:15 BKK): Android's back and the browser's Back close it instead of leaving
  // SpaceApp; closing it any other way takes that entry back. Only an entry this dock pushed is ever taken back.
  const pushedPlanRef = useRef(false);
  useEffect(() => {
    if (!planView) {
      if (pushedPlanRef.current && (window.history.state as { nousPlan?: string } | null)?.nousPlan !== undefined) window.history.back();
      pushedPlanRef.current = false;
      return;
    }
    const current = window.history.state as { nousPlan?: string } | null;
    if (current?.nousPlan === undefined) { window.history.pushState({ ...current, nousPlan: planView }, ""); pushedPlanRef.current = true; }
    else if (current.nousPlan !== planView) window.history.replaceState({ ...current, nousPlan: planView }, "");
    const onPop = (event: PopStateEvent) => {
      if ((event.state as { nousPlan?: string } | null)?.nousPlan === undefined) { pushedPlanRef.current = false; setPlanView(null); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [planView, setPlanView]);
  const planCard = (id: string, key: string) => <NousPlanCard key={key} plan={plans[id]} open={false} onToggle={() => openPlan(id)} />;

  const count = messages?.length ?? 0;
  const toLatest = useCallback(() => { const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; }, []);
  useEffect(() => { stickRef.current = true; toLatest(); }, [tab, fullscreen, toLatest]);
  useEffect(() => { if (stickRef.current) toLatest(); }, [count, toLatest]);
  const onScroll = () => {
    const list = listRef.current;
    if (!list || (jumpTopRef.current !== null && Math.abs(list.scrollTop - jumpTopRef.current) < 2)) return;
    jumpTopRef.current = null;
    stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    if (stickRef.current) list.querySelector("[data-jumped]")?.removeAttribute("data-jumped");
  };
  const jumpTo = (target: HTMLElement) => {
    const list = listRef.current;
    if (!list) return;
    list.querySelector("[data-jumped]")?.removeAttribute("data-jumped");
    target.setAttribute("data-jumped", "");
    // Only the list scrolls: scrollIntoView also moved the dock around it, and the button with it.
    list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top;
    jumpTopRef.current = list.scrollTop;
    stickRef.current = false;
  };
  const jumpPending = () => {
    const row = pendingJumpRef.current ? listRef.current?.querySelector<HTMLElement>(`[data-message-id="${pendingJumpRef.current}"]`) : null;
    if (row) { pendingJumpRef.current = null; jumpTo(row); }
  };
  useLayoutEffect(() => {
    const list = listRef.current, anchor = anchorRef.current;
    anchorRef.current = null;
    if (list && anchor?.row.isConnected) list.scrollTop += anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top;
    jumpPending();
  });
  // Operator request 2026-10-21, fixed 2026-10-27: each press goes one of the operator's messages further back, from where the list is.
  const jumpToMine = () => {
    const list = listRef.current;
    if (!list) return;
    const mine = [...list.querySelectorAll<HTMLElement>(".nous-message.is-operator")];
    const jumped = list.querySelector<HTMLElement>("[data-jumped]");
    const listTop = list.getBoundingClientRect().top;
    // Not scrolled since the last press: the one before it; at the end: the newest; scrolled by hand: the nearest one above the view.
    const index = !mine.length ? -1 : jumped && jumpTopRef.current !== null ? mine.indexOf(jumped) - 1
      : stickRef.current ? mine.length - 1
      : mine.findLastIndex((row) => row.getBoundingClientRect().top - listTop < -4);
    if (index >= 0) { jumpTo(mine[index]!); return; }
    // Operator 31/10: older than every loaded one, so the server's list of the operator's messages says which; pages load until it is here.
    // After the oldest the newest comes again.
    void (async () => {
      const { messages: refs } = await api.nousOperatorIndex();
      const at = refs.findIndex((ref) => ref.id === mine[0]?.dataset.messageId);
      const target = at > 0 ? refs[at - 1] : refs.at(-1);
      if (!target) return;
      pendingJumpRef.current = target.id;
      await history.earlier(target.id);
      jumpPending();
    })().catch((err: unknown) => setError(messageOf(err, "Your earlier messages could not be loaded.")));
  };
  const loadEarlier = () => {
    const list = listRef.current, row = list?.querySelector(".nous-load-earlier")?.nextElementSibling;
    if (list && row) anchorRef.current = { row, top: row.getBoundingClientRect().top - list.getBoundingClientRect().top };
    stickRef.current = false;
    void history.earlier().catch((err: unknown) => setError(messageOf(err, "Earlier messages could not be loaded.")));
  };
  const jumpToLatest = () => { stickRef.current = true; toLatest(); };
  // shortcut: finds in the loaded messages only, "Load earlier messages" brings older ones in; a server search when the operator asks for one.
  useEffect(() => {
    const list = listRef.current;
    const ranges = search !== null && list ? findConversationText(list, search) : [];
    const current = Math.max(0, ranges.length - 1 - searchBack);
    setSearchFound(ranges.length);
    paintConversationMatches(ranges, current);
    // A new query or step scrolls to its match; a message arriving while searching leaves the list where it is.
    const range = ranges[current], key = `${search}|${searchBack}`;
    if (!range || !list) searchShownRef.current = "";
    else if (searchShownRef.current !== key) {
      searchShownRef.current = key;
      const box = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : range.startContainer.parentElement!.getBoundingClientRect();
      list.scrollTop += box.top - list.getBoundingClientRect().top - list.clientHeight / 3;
    }
    return clearConversationMatches;
  }, [search, searchBack, messages, decisions, tab, planView, fullscreen]);
  const stepSearch = (by: number) => setSearchBack((back) => searchFound ? (back + by + searchFound) % searchFound : 0);
  const closeSearch = () => { setSearch(null); setSearchBack(0); };
  const showMessage = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });

  const canSend = (Boolean(draft.trim()) || pending.readyIds.length > 0) && !pending.uploading && !sending;
  const send = async (event?: FormEvent, spoken?: string) => {
    event?.preventDefault();
    const content = (spoken ?? draft).trim();
    if ((!content && !pending.readyIds.length) || pending.uploading || sending) return;
    // /goal alone or /goals opens the Goals view here (operator request 2026-10-27); /goal <text> goes to the server, which records the goal.
    const command = pending.readyIds.length ? null : parseNousGoalCommand(content);
    if (command?.kind === "LIST") { setDraft(""); setPlanView(null); setTab("goals"); return; }
    setSending(true);
    setError(null);
    try {
      await api.sendNousMessage(content, pending.readyIds);
      setDraft("");
      pending.clear();
      stickRef.current = true;
      await refresh();
      if (command?.kind === "CREATE") { setPlanView(null); setTab("goals"); }
    } catch (err) {
      setError(messageOf(err, "Your message could not be sent."));
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); voiceInput?.cancel(NOUS_VOICE_OWNER); void send(); }
  };
  // Dictation fills the box as words come and sends when the speech ends, like every other composer.
  const toggleVoice = () => {
    if (!voiceInput) return;
    if (voiceOwned && voiceInput.status === "recording") { voiceInput.stop(NOUS_VOICE_OWNER); return; }
    const base = draft.trim();
    const compose = (text: string) => voiceInput.settings.insertMode === "replace" ? text : [base, text.trim()].filter(Boolean).join("\n");
    void voiceInput.start({
      id: NOUS_VOICE_OWNER,
      onTranscriptDelta: (text) => setDraft(compose(text)),
      onTranscriptComplete: async (text) => { setDraft(compose(text)); await send(undefined, compose(text)); },
      onError: setError
    });
  };
  // A pasted screenshot (or copied file) attaches; pasted text stays text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    pending.add(files);
  };
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); setDragging(true); };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    pending.add(Array.from(event.dataTransfer.files));
  };
  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try { await work(); await refresh(); } catch (err) { setError(messageOf(err, fallback)); }
  };

  const answerDecision = (decision: NousDecision) => (input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }) =>
    act(() => api.answerNousDecision(decision.id, input), "Your answer could not be saved.");
  // The board's "Needs you" leads to the decision where Nous asked it: into view, the keyboard on its first answer.
  const showDecision = (id: string) => {
    setPlanView(null);
    setTab("conversation");
    window.requestAnimationFrame(() => {
      const card = listRef.current?.querySelector<HTMLElement>(`[data-decision-id="${id}"]`);
      card?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      card?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
  };

  if (!canRun) {
    return (
      <section className="dock-panel nous-dock" aria-label="Nous">
        <DockState kind="empty" icon={Nous} title="Nous is available to administrators and operators" />
      </section>
    );
  }

  // A decision an allowance holds runs by itself (operator 31/10 17:00 BKK «You are asking me for approve AGAIN!!!»): never counted or asked.
  const open = decisions.filter((decision) => decision.status === "OPEN" && !decision.runsWhen);
  const allDecisions = earlier ? [...decisions, ...earlier.decisions.filter((old) => !decisions.some((decision) => decision.id === old.id))] : decisions;
  const shownDecisions = decisionFilter === "open" ? open : allDecisions;
  const answered = allDecisions.filter((decision) => decision.status !== "OPEN");
  const canLoadEarlier = decisionFilter === "all" && (earlier ? earlier.hasMore : decisions.filter((decision) => decision.status !== "OPEN").length >= 50);
  const loadEarlierDecisions = () => {
    const oldest = answered.reduce<string | null>((min, decision) => !min || decision.createdAt < min ? decision.createdAt : min, null);
    if (!oldest) return;
    void api.nousEarlierDecisions(oldest).then((page) => setEarlier((current) => ({ decisions: [...current?.decisions ?? [], ...page.decisions], hasMore: page.hasMore })))
      .catch(() => undefined);
  };
  const byId = new Map((messages ?? []).map((entry) => [entry.id, entry]));
  // Queued until Nous answers it; "answering" once the running turn took it (the turn began after it was sent).
  const queueOf = (entry: NousMessage) => !waiting.includes(entry.id) ? null
    : state?.running?.reason === "OPERATOR" && entry.createdAt <= state.running.startedAt ? "answering" : "queued";
  // An answer quotes the operator's messages it answers, as in a chat (meta.replyTo). Operator 29/10 22:13 BKK «γιατι αναπαραγετε 3 φορες το
  // μηνυμα μου?»: a turn's interim replies and its final answer all name the same message, so each message is quoted once, above the first.
  const quoted = new Set<string>();
  const quotesById = new Map([...(messages ?? [])].filter((entry) => entry.kind === "ANSWER").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((entry) => {
    const fresh = (Array.isArray(entry.meta.replyTo) ? entry.meta.replyTo : []).map(String).filter((id) => !quoted.has(id) && byId.has(id));
    fresh.forEach((id) => quoted.add(id));
    return [entry.id, fresh.map((id) => byId.get(id)!)] as const;
  }));
  const oldestLoaded = messages?.[0]?.createdAt;
  const shownFrom = history.clearedAt && oldestLoaded && oldestLoaded < history.clearedAt ? oldestLoaded : history.clearedAt;
  const entries = messages === null ? [] : [
    // An answer that was only Space's NOTHING_NEW token says nothing to the operator (stable 2/11, rows stored before the server dropped it).
    ...messages.filter((entry) => entry.kind !== "ANSWER" || withoutNothingNew(entry.content)).map((entry) => ({ at: entry.createdAt, tool: entry.kind === "TOOL" ? entry : null, node: (
      <NousMessageRow key={entry.id} message={entry} files={messageFiles[entry.id] ?? []} planCard={planCard}
        queue={entry.kind === "OPERATOR" ? queueOf(entry) : null} quotes={quotesById.get(entry.id) ?? []} onShowMessage={showMessage} />
    ) })),
    // Every decision sits where Nous asked it; one about a plan carries the plan card that opens it. Clear conversation hides the ones asked
    // before it (operator 2/11: they stay in Needs you and Decisions); "Load earlier messages" brings back those of the window it loads.
    ...decisions.filter((decision) => !shownFrom || decision.createdAt >= shownFrom).map((decision) => ({ at: decision.createdAt, tool: null, node: (
      <NousDecisionCard key={decision.id} inline decision={decision} onAnswer={answerDecision(decision)}
        plan={decision.refs.planId ? planCard(decision.refs.planId, "plan") : null} />
    ) }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  // Model first: the narrow dock cuts the line's end (stable 29/10 read "Claude (Ar…" with the provider first).
  const served = state?.execution && !state.execution.model.startsWith("auto") ? state.execution : null;
  const modelLabel = served ? `${nousModelLabel(served.model)}${served.effort && served.effort !== "none" ? ` · ${served.effort}` : ""}${served.phase === "starting" ? ` · ${t("Connecting…")}` : ""}`
    : t("Waiting for the first model response");
  // The provider and model live in Settings → Assistants & AI → Nous; the label is the way there (operator 29/10: "I don't see the provider").
  const modelLink = <button type="button" className="nous-model-link" title={t("Change the provider and model in Settings → Assistants & AI → Nous")}
    onClick={() => openSettingsSection("nous")}>{modelLabel}</button>;
  // Away mode (plan clipboard:B7eTUHTJYg3X): "Away since 23:29 ICT" in the operator's working time zone.
  const statusLine = <p className={`nous-status is-${(state?.status ?? "OFF").toLowerCase()}`} role="status">
    {t(state ? STATUS_LABELS[state.status] : "Loading…")}{state?.away ? <span className="nous-away-line"> · {t("Away since {time}", { time: clock(state.away.startedAt) })}</span> : null}</p>;
  // Operator request 2026-10-17: the dock keeps only Nous's power switch ("Work on my behalf"); every other switch is in Settings.
  const enabled = Boolean(state?.settings.enabled);
  const power = (
    <label className={`nous-power${enabled ? " is-on" : ""}`}
      title={t("Work on my behalf: Nous answers panes and copilots in every room. Its other switches are in Settings → Assistants & AI → Nous.")}>
      <input type="checkbox" role="switch" aria-label={t("Nous works on my behalf")} checked={enabled} disabled={!state}
        onChange={(event) => { const on = event.currentTarget.checked; void act(() => api.updateNousSettings({ enabled: on }), "The setting could not be saved.")
          // Turning it on starts a first review at once: look again shortly so the dock shows it thinking.
          .then(() => { if (on) window.setTimeout(() => void refresh().catch(() => undefined), 1_500); }); }} />
      <span className="nous-power-track" aria-hidden="true"><span className="nous-power-text">{t(enabled ? "On" : "Off")}</span><span className="nous-power-thumb" /></span>
    </label>
  );
  // Why it cannot run (dev, or Claude Code not connected on a self-hosted install) takes the last problem's place.
  const lastError = state?.unavailable ? <p className="nous-muted nous-last-error">{state.unavailable}</p>
    : state?.lastError ? <p className="nous-muted nous-last-error">{t("Last problem: {text}", { text: state.lastError })}</p> : null;
  const activeGoals = state?.goals?.active ?? 0;
  // Icon tabs (operator request 2026-10-27), wrapping to a second row in a narrow dock (31/10); the chosen view shows its name, a wide dock every name (nous.css).
  const tabs: DockChipOption<Tab>[] = [
    { id: "conversation", label: "Conversation", icon: MessageSquare }, { id: "needs", label: "Needs you", icon: UserCheck, tone: "attention", ...((needs?.length ?? 0) + open.length ? { count: (needs?.length ?? 0) + open.length } : {}) },
    { id: "done", label: "Done", icon: CheckCheck, ...(done.count ? { count: done.count } : {}) },
    // Operator 4/11 15:04 BKK (R73): approvals and what Nous carried out, each with its full report; the count is the unread ones.
    { id: "updates", label: "Updates", icon: Megaphone, ...(updates.count ? { count: updates.count } : {}) },
    { id: "requests", label: "Requests", icon: ListChecks, ...(inProgress ? { count: inProgress } : {}) },
    { id: "shared", label: "Shared", icon: FileSymlink, ...(shared.count ? { count: shared.count } : {}) },
    { id: "decisions", label: "Decisions", icon: Gavel, tone: "attention", ...(open.length ? { count: open.length } : {}) }, { id: "overview", label: "Overview", icon: Activity },
    { id: "panes", label: "Panes", icon: LayoutGrid, ...(overview?.panes?.some((pane) => pane.overdue) ? { count: overview.panes.filter((pane) => pane.overdue).length } : {}) },
    { id: "plans", label: "Plans", icon: ClipboardList }, { id: "goals", label: "Goals", icon: Target, ...(activeGoals ? { count: activeGoals } : {}) },
    // Operator 3/11 20:09 BKK (plan clipboard:17yLAnH5ZpyF): every startup program, the oll4.com projects' ones included (7/11).
    { id: "startup", label: "Startup programs", icon: Rocket },
    // Operator 14/11 00:07 BKK (nous_msg:de448bc711204fdb832cf926): every affiliate application and what each approval gives.
    { id: "affiliate", label: "Affiliate", icon: Handshake },
    // Operator 3/11 22:33 BKK (nous_msg:e734994004dd): every job applied to and every crypto method tested, each as one picture.
    { id: "jobs", label: "Job applications", icon: Briefcase }, { id: "crypto", label: "Crypto", icon: TrendingUp },
    // Operator 5/11 10:42 BKK (plan clipboard:netzt-nNvtBL): every marketing post, platform and stats source, scored.
    { id: "marketing", label: "Marketing", icon: Megaphone },
    { id: "quotas", label: "Quotas", icon: Gauge }, { id: "load", label: "Load", icon: ChartSpline },
    // Operator 3/11 23:11 BKK (plan clipboard:1NF6u6gcCwtj): Nous's performance score, which open plans and requests pull down.
    { id: "score", label: "Score", icon: Star },
    // Every run of the scheduled tasks (plan clipboard:GA__W4qBxSPR): ADMIN only, as its route.
    ...(isAdmin ? [{ id: "taskRuns" as const, label: "Task runs", icon: CalendarCheck }] : [])
  ];
  const shownTabs = tabs.filter(({ id }) => id === "conversation" || state?.settings.dockTabs?.[id] !== false).map((option) => ({ ...option, label: t(option.label) }));
  const goTo = (next: Tab) => { setPlanView(null); setTab(next); };
  const openLoad = shownTabs.some((option) => option.id === "load") ? () => goTo("load") : undefined;
  const views = <DockChips label={t("Nous views")} className="nous-views" value={tab} onChange={goTo} options={shownTabs} />;
  const railViews = <DockChips label={t("Nous views")} className="nous-views" value={tab} onChange={goTo}
    options={RAIL_SECTIONS.flatMap(([section, ids]) => ids.flatMap((id) => shownTabs.filter((option) => option.id === id)).map((option) => ({ ...option, section: t(section) })))} />;
  const actions = (
    <>
      {tab === "conversation" && !planView ? (
        <DockIconButton label={t("Clear the conversation")} icon={Trash2} disabled={thinking || !entries.length} onClick={async () => {
          if (!(await confirm({ title: t("Clear the conversation?"), message: t("Nous keeps its notes and decisions; the messages and decisions leave the conversation (decisions stay in Needs you and Decisions) and \"Load earlier messages\" still shows them."), confirmLabel: t("Clear") }))) return;
          await act(async () => { await api.clearNousMessages(); history.cleared(); }, "The conversation could not be cleared.");
        }} />
      ) : null}
      <DockFullscreenButton name="Nous" active={fullscreen} onToggle={() => { setPlanView(null); setIsFullscreen(!fullscreen); }} />
    </>
  );
  const notice = error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null;
  const draftNode = writing ? (
    <div className="nous-message is-answer is-draft" aria-live="polite">
      <ChatMarkdown content={writing} />
      <p className="nous-queue is-answering">{t("Nous is writing…")}</p>
    </div>
  ) : null;
  const view = (items: ReactNode[], trailing: ReactNode) => planView ? (
    <NousPlanView plan={plans[planView]} decisions={decisions} needs={needs} hold={overview?.plans.find((row) => row.id === planView)?.hold}
      onClose={() => setPlanView(null)} answerDecision={answerDecision} />
  ) : tab === "conversation" ? (
    <div className={`nous-conversation${dragging ? " is-dropping" : ""}`} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="nous-messages" data-sensitive-masked="manual" ref={listRef} aria-live="polite" onScroll={onScroll}>
        {history.hasMore ? <DockButton className="nous-load-earlier" onClick={loadEarlier}>{t("Load earlier messages")}</DockButton> : null}
        {messages === null ? <DockState kind="loading" title={t("Loading the conversation")} /> : null}
        {messages?.length === 0 ? <DockState kind="empty" icon={Nous} title={t("Talk to Nous")} detail={t("Ask what is happening in every room, give it a goal, or switch it on to work on your behalf.")} /> : null}
        {items}
        {trailing}
      </div>
      {search !== null ? (
        <div className="nous-search" role="search">
          <input type="search" value={search} autoFocus aria-label={t("Search the conversation")} placeholder={t("Search the conversation")}
            onChange={(event) => { setSearch(event.target.value); setSearchBack(0); }}
            onKeyDown={(event) => {
              // Escape closes the search only, not fullscreen or the plan behind it; Enter goes to the older match, Shift+Enter the newer.
              if (event.key === "Escape") {
                event.preventDefault(); event.stopPropagation(); closeSearch();
                event.currentTarget.closest(".nous-conversation")?.querySelector<HTMLButtonElement>("[data-nous-search-toggle]")?.focus();
              } else if (event.key === "Enter") { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); }
            }} />
          <span className="nous-search-count" aria-live="polite">
            {!search.trim() ? null : searchFound ? t("{at} of {count}", { at: searchFound - Math.min(searchBack, searchFound - 1), count: searchFound }) : t("No matches")}
          </span>
          <DockIconButton label={t("Older match")} icon={ChevronUp} disabled={searchFound < 2} onClick={() => stepSearch(1)} />
          <DockIconButton label={t("Newer match")} icon={ChevronDown} disabled={searchFound < 2} onClick={() => stepSearch(-1)} />
          <DockIconButton label={t("Close search")} icon={X} onClick={closeSearch} />
        </div>
      ) : null}
      <NousPendingFiles files={pending.files} onRemove={pending.remove} />
      <form className="nous-composer" onSubmit={(event) => void send(event)}>
        {/* Operator request 2026-10-21: the message field takes the whole width with Send beside it; the other controls sit above it. */}
        <div className="nous-composer-tools">
          <DockIconButton label={t("Attach files")} icon={Paperclip} onClick={() => fileInputRef.current?.click()} />
          {voiceInput?.settings.enabled ? (
            <VoiceInputButton label="Nous" active={voiceOwned && voiceInput.status === "recording"} onClick={toggleVoice} onPrewarm={voiceInput.prewarm}
              disabled={!voiceInput.serverSettings?.enabled || voiceInput.settingsLoading || Boolean(voiceInput.ownerId && !voiceOwned) || (voiceOwned && voiceInput.status !== "recording")} />
          ) : null}
          <input ref={fileInputRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1}
            onChange={(event) => { pending.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          {state?.status === "THINKING" ? (
            <DockIconButton label={t("Stop")} icon={CircleStop} onClick={() => void act(() => api.stopNous(), "Nous could not be stopped.")} />
          ) : null}
          <span className="nous-composer-jump">
            <DockIconButton label={t("Go to my last message (press again for the one before)")} icon={ChevronsUp} disabled={!count} onClick={jumpToMine} />
            <DockIconButton label={t("Go to the latest message")} icon={ChevronsDown} disabled={!count} onClick={jumpToLatest} />
            <DockIconButton label={t("Search the conversation")} icon={Search} aria-pressed={search !== null} data-nous-search-toggle
              onClick={() => search === null ? setSearch("") : closeSearch()} />
          </span>
        </div>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} rows={2} maxLength={8_000} data-nous-composer
          placeholder={t("Message Nous, or paste a screenshot")} aria-label={t("Message Nous")} />
        <DockIconButton label={t("Send")} icon={Send} tone="primary" type="submit" disabled={!canSend} busy={sending} />
      </form>
      {dragging ? <div className="nous-drop-hint" aria-hidden="true">{t("Drop files to send them to Nous")}</div> : null}
    </div>
  ) : tab === "needs" ? (
    <NousNeedsYou requests={needs} decisions={open} plans={overview?.plans} focus={needsFocus} onOpenPlan={openPlan} renderDecision={(decision) => <NousDecisionCard decision={decision} onAnswer={answerDecision(decision)} />} />
  ) : tab === "done" ? (
    <NousDone requests={done.requests} error={done.error} onRetry={done.retry} onOpenPlan={openPlan} onAcknowledged={done.acknowledged} />
  ) : tab === "updates" ? (
    <NousUpdates updates={updates.updates} error={updates.error} onRetry={updates.retry} />
  ) : tab === "requests" ? (
    <NousRequests active={isActive && canRun} onOpenPlan={openPlan} />
  ) : tab === "shared" ? (
    <NousShared files={shared.files} error={shared.error} onRetry={() => void shared.retry()} onRemoved={shared.removed} />
  ) : tab === "startup" ? (
    <NousPrograms page="startup" active={isActive && canRun} />
  ) : tab === "affiliate" ? (
    <NousPrograms page="affiliate" active={isActive && canRun} />
  ) : tab === "jobs" ? (
    <NousJobs active={isActive && canRun} />
  ) : tab === "crypto" ? (
    <NousCrypto active={isActive && canRun} />
  ) : tab === "marketing" ? (
    <NousMarketing active={isActive && canRun} />
  ) : tab === "goals" ? (
    <NousGoals active={isActive && canRun} overview={overview} onChanged={() => void refresh().catch(() => undefined)} onOpenPlan={openPlan} />
  ) : tab === "quotas" ? (
    <NousQuotas active={isActive} />
  ) : tab === "load" ? (
    <NousLoad active={isActive} />
  ) : tab === "score" ? (
    <NousScore active={isActive} />
  ) : tab === "taskRuns" && isAdmin ? (
    <NousTaskRuns active={isActive} />
  ) : tab === "decisions" ? (
    <div className="nous-decisions">
      {/* Operator request 2026-10-21: only the decisions still waiting for an answer, or all of them. */}
      <DockChips label={t("Show decisions")} value={decisionFilter} onChange={setDecisionFilter} options={[
        { id: "open", label: t("Unanswered"), count: open.length }, { id: "all", label: t("All"), count: allDecisions.length }]} />
      {shownDecisions.length === 0 ? <DockState kind="empty" icon={Nous} title={t(decisionFilter === "open" ? "Nothing waits for you" : "No decisions")}
        detail={t("Nous brings you only releases, irreversible actions, anything to third parties or with money, and product direction.")} /> : null}
      {shownDecisions.map((decision) => (
        <NousDecisionCard key={decision.id} decision={decision} onAnswer={answerDecision(decision)} />
      ))}
      {canLoadEarlier ? <DockButton className="nous-decisions-earlier" onClick={loadEarlierDecisions}>{t("Load earlier decisions")}</DockButton> : null}
    </div>
  ) : tab === "plans" ? (
    // Operator request 2026-10-25: the plan map (holds, unblock first, dates, dependencies) in any dock size; a row opens the plan.
    <section className="nous-overview" aria-label="Plans">
      <NousPlanMap overview={overview} onOpen={openPlan} />
    </section>
  ) : (
    tab === "panes" ? <NousPaneBoard active={isActive} decisions={decisions} overview={overview} onSent={() => void refresh().catch(() => undefined)}
      renderDecision={(decision) => <NousDecisionCard inline decision={decision} onAnswer={answerDecision(decision)} />} />
      : <NousOverviewView overview={overview} active={isActive} onOpenLoad={openLoad} />
  );

  // Only the dialogue stays open (operator request 2026-10-21, every dock size): each run of tool steps, its helpers' included,
  // folds into one line that opens to the whole list.
  const folded: ReactNode[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const steps: NousMessage[] = [];
    while (entries[index]?.tool) steps.push(entries[index++]!.tool!);
    if (steps.length) folded.push(<NousSteps key={steps[0]!.id} steps={steps} />);
    if (index < entries.length) folded.push(entries[index]!.node);
  }

  if (fullscreen) {
    // Maximized (operator request 2026-10-17): a command center for the whole day. Nous on the left, the work in the middle,
    // what waits for the operator on the right.
    const turns = state?.turnsThisHour ?? 0;
    return (
      <section className={`dock-panel nous-dock is-fullscreen nous-workspace${thinking ? " is-thinking" : ""}${tab === "panes" && !planView ? " is-pane-board" : ""}${planView ? " has-plan" : ""}`} aria-label="Nous">
        <AgentFileMentions>
        <aside className="nous-rail" aria-label="Nous status">
          <div className="nous-rail-identity">
            <div className="nous-rail-brain"><NousBrain3D size={64} animate={isActive} thinking={thinking} firing /></div>
            <div className="nous-rail-name"><h2>Nous</h2><p className="nous-tagline">{t("The mind of SpaceApp")}</p></div>
            {power}
            <p className="nous-tagline nous-rail-model">{modelLink}</p>
            <div className="nous-rail-state">
              {statusLine}
              {state?.running ? <p className="nous-running">{t(REASON_LABELS[state.running.reason])} · <NousElapsed since={state.running.startedAt} /></p> : null}
            </div>
          </div>
          {lastError}
          {railViews}
          {/* Each count opens the view that explains it (operator 3/11): the open decisions, the panes whose news fill the inbox, the load. */}
          <div className="nous-gauges" role="group" aria-label={t("Live counts")}>
            {([["Decisions waiting", open.length, "decisions", open.length > 0], ["Inbox", state?.inbox ?? 0, "panes", false], ["Turns this hour", turns, "load", false]] as const)
              .map(([label, value, target, attention]) => shownTabs.some((option) => option.id === target) ? (
                <button key={label} type="button" className={attention ? "is-attention" : undefined} title={t(VIEW_TITLES[target])}
                  onClick={() => { if (target === "decisions") setDecisionFilter("open"); goTo(target); }}>
                  <span className="nous-gauge-value">{value}</span> <span className="nous-gauge-label">{t(label)}</span>
                </button>
              ) : (
                <div key={label} className={attention ? "is-attention" : undefined}><span className="nous-gauge-value">{value}</span> <span className="nous-gauge-label">{t(label)}</span></div>
              ))}
          </div>
        </aside>
        <div className="nous-stage">
          <header className="nous-stage-head">
            {planView ? <DockButton icon={ArrowLeft} className="nous-plan-back" data-nous-plan-back onClick={() => setPlanView(null)}>{t("Back to {where}", { where: t(VIEW_TITLES[tab]) })}</DockButton> : null}
            <h3>{t(planView ? "Plan" : VIEW_TITLES[tab])}</h3>
          </header>
          {notice}
          {view(folded, draftNode)}
        </div>
        {/* The dock's own controls sit at its far right edge (operator request 2026-10-17, plan clipboard:wr9yNPJwkDrp). */}
        <div className="nous-workspace-tools">{actions}</div>
        <NousBoard overview={overview} open={open} onShowDecision={showDecision} openPlan={openPlan} live={isActive} onOpenLoad={openLoad} />
        {confirmDialog}
        </AgentFileMentions>
      </section>
    );
  }

  return (
    <section className="dock-panel nous-dock" aria-label="Nous">
      <AgentFileMentions>
      <header className="nous-hero">
        <NousBrain3D size={60} animate={isActive} thinking={thinking} />
        {/* The dock's header already says "The mind of SpaceApp"; the narrow hero keeps one line each for the model and the status. */}
        <div className="nous-hero-text">
          <h2>Nous</h2>
          <p className="nous-tagline">{modelLink}</p>
          {statusLine}
          <NousRemoteMark active={isActive && canRun} />
        </div>
        {/* The dock's buttons sit under the switch so the views get a full row of their own in a narrow dock. */}
        <div className="nous-hero-side">{power}<div className="nous-hero-actions">{actions}</div></div>
      </header>
      {lastError}
      <div className="nous-toolbar">{views}</div>
      {notice}
      {/* Operator request 2026-10-17: Nous's questions are answered in the conversation too; the entries place every decision where it was asked. */}
      {view(folded, draftNode)}
      {confirmDialog}
      </AgentFileMentions>
    </section>
  );
}

/** A step as Nous's tool wrote it (English), or in the agents' language once the server translated it (nous/step-translations.ts). */
const stepText = (step: NousMessage, language: UiLanguage): string => {
  const translation = step.meta.translation as { language?: unknown; text?: unknown } | undefined;
  return translation?.language === language && typeof translation.text === "string" ? translation.text : step.content;
};

/**
 * One run of tool steps as a single line (count, helpers and the latest step) that opens to every step; in the agents' language, like
 * everything Nous writes to the operator (operator 2/11 09:51 BKK: «6 steps Checked Cody in Alex: ok working» read English).
 */
function NousSteps({ steps }: { steps: NousMessage[] }) {
  const opened = useNousUiIds("steps");
  const agents = useAgentLanguage();
  const t = (text: string, count?: number) => uiText(agents, text, count === undefined ? undefined : { count });
  const id = steps[0]!.id;
  const running = steps.some((step) => step.status === "RUNNING");
  const failed = steps.filter((step) => step.status === "FAILED").length;
  // A gate that held a step for the operator worked as meant (stable 2026-10-22: holds read as failures).
  const held = steps.filter((step) => step.status === "REFUSED").length;
  // Helpers (space_subagents) record their calls under the turn with their own id.
  const helpers = new Set(steps.flatMap((step) => typeof step.meta.subagentId === "string" ? [step.meta.subagentId] : [])).size;
  const usedHelpers = helpers > 0 || steps.some((step) => step.meta.name === "space_subagents");
  return (
    <details className={`nous-steps${running ? " is-running" : ""}`} open={opened.has(id)} onToggle={(event) => opened.setOpen(id, event.currentTarget.open)}>
      <summary>
        <ChevronRight className="nous-steps-chevron" aria-hidden="true" />
        <span className="nous-steps-count">{steps.length === 1 ? t("1 step") : t("{count} steps", steps.length)}</span>
        {usedHelpers ? <span className="nous-steps-helpers">{helpers === 0 ? t("Helpers") : helpers === 1 ? t("1 helper") : t("{count} helpers", helpers)}</span> : null}
        <span className="nous-steps-last">{stepText(steps[steps.length - 1]!, agents)}</span>
        {/* "steps failed", never just "failed": next to the helpers it read as if every helper had failed (operator 2026-10-21). */}
        {failed ? <span className="nous-steps-failed">{failed === 1 ? t("1 step failed") : t("{count} steps failed", failed)}</span> : null}
        {held ? <span className="nous-steps-held">{held === 1 ? t("1 step held back") : t("{count} steps held back", held)}</span> : null}
      </summary>
      <ol>{steps.map((step) => <li key={step.id} className={`nous-tool is-${step.status.toLowerCase()}${step.meta.subagentId ? " is-helper" : ""}`}>{stepText(step, agents)}</li>)}</ol>
    </details>
  );
}

/** How long the running turn has taken, counted every second. */
function NousElapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1_000));
  return <>{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`}</>;
}

/** The maximized view's right column: what waits for the operator and where every plan stands, always in sight. */
function NousBoard({ overview, open, onShowDecision, openPlan, live, onOpenLoad }: {
  overview: NousOverview | null; open: NousDecision[]; onShowDecision(id: string): void; openPlan(id: string): void; live: boolean; onOpenLoad?(): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [query, setQuery] = useState("");
  const plans = searchPlans(overview?.plans ?? [], query);
  return (
    <aside className="nous-board" aria-label={t("Needs you and the plans")}>
      {/* Appointments at the very top (operator 2/11 15:22 BKK), then Live stats, in sight without scrolling; they replace the raw release-train text (releases reach the operator as RELEASE decisions). */}
      <NousAppointments />
      <NousLiveStats overview={overview} active={live} onOpenLoad={onOpenLoad} />
      <section aria-label={t("Needs you")}>
        <h3>{t("Needs you")}{open.length ? <span className="nous-board-count is-attention">{open.length}</span> : null}</h3>
        {open.length === 0 ? <p className="nous-muted">{t("Nothing waits for you. Nous brings releases, irreversible actions, third parties or money, and direction here.")}</p> : null}
        {/* Each one is answered once, where Nous asked it in the conversation; here it is a line that leads there. */}
        {open.map((decision) => (
          <button key={decision.id} type="button" className="nous-board-ask" onClick={() => onShowDecision(decision.id)}>
            <span className={`nous-category is-${decision.category.toLowerCase()}`}>{t(CATEGORY_LABELS[decision.category])}</span>
            <strong>{decision.title}</strong>
            <span className="nous-muted">{t("Asked {time}", { time: clock(decision.createdAt) })}{decision.recommendation ? ` · ${t("Nous recommends:")} ${decision.recommendation}` : ""}</span>
          </button>
        ))}
      </section>
      <section aria-label={t("Plans")}>
        <h3>{t("Plans")}{overview?.plans.length ? <span className="nous-board-count">{plans.length}</span> : null}</h3>
        {overview?.plans.length ? (
          <div className="nous-board-search" onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}>
            <DockSearch value={query} onChange={setQuery} label={t("Search plans")} name="nous-plans-search" />
          </div>
        ) : null}
        {!overview ? <p className="nous-muted">{t("Loading the plans…")}</p> : overview.plans.length === 0 ? <p className="nous-muted">{t("No open plans.")}</p>
          : plans.length === 0 ? <p className="nous-muted">{t("No plan matches.")}</p> : null}
        {plans.map((plan) => (
          <button key={plan.id} type="button" className={`nous-board-plan is-${plan.status.toLowerCase()}`} onClick={() => openPlan(plan.id)}
            aria-label={`Open the plan ${plan.title}, ${plan.progress}%`}>
            <span className="nous-plan-head"><strong>{plan.title}</strong><span>{plan.progress}%</span></span>
            <span className="nous-progress" aria-hidden="true"><span style={{ width: `${plan.progress}%` }} /></span>
            <span className="nous-muted">{statusText(plan.status)}{plan.pane ? ` · ${plan.pane}` : ` · ${t("no pane yet")}`}{plan.room ? ` ${t("in {room}", { room: plan.room })}` : ""}</span>
            {plan.nextStep ? <span className="nous-muted">{t("Next: {step}", { step: plan.nextStep })}</span> : null}
          </button>
        ))}
      </section>
      <section aria-label={t("Needs your hands")}>
        <h3>{t("Needs your hands")}{overview?.needsHands.length ? <span className="nous-board-count is-attention">{overview.needsHands.length}</span> : null}</h3>
        {overview?.needsHands.length ? (
          <ul>{overview.needsHands.map((item) => <li key={item.id}>{item.title}{item.room ? <span className="nous-muted"> · {item.room}</span> : null}</li>)}</ul>
        ) : <p className="nous-muted">{t(overview ? "No sign-in, CAPTCHA or handoff waits for you." : "Loading…")}</p>}
      </section>
    </aside>
  );
}

function NousMessageRow({ message, files, planCard, queue, quotes, onShowMessage }: {
  message: NousMessage; files: NousAttachment[]; planCard(id: string, key: string): ReactNode;
  queue: "queued" | "answering" | null; quotes: NousMessage[]; onShowMessage(id: string): void;
}) {
  switch (message.kind) {
    case "OPERATOR": {
      const text = operatorText(message.content);
      return (
        <div className="nous-message is-operator" data-message-id={message.id}>
          {text ? <p>{text}</p> : null}<NousMessageFiles files={files} />
          {queue ? <p className={`nous-queue is-${queue}`}>{queue === "answering" ? "Nous is answering…" : "Queued: Nous answers it next"}</p> : null}
        </div>
      );
    }
    case "ANSWER": return (
      <div className="nous-message is-answer">
        {quotes.map((quote) => (
          <button key={quote.id} type="button" className="nous-quote" title="Show your message" onClick={() => onShowMessage(quote.id)}>
            {operatorText(quote.content) || "Your files"}
          </button>
        ))}
        <ChatMarkdown content={withoutNothingNew(message.content)} />{planIdsIn(message.content).map((id) => planCard(id, id))}
        {typeof message.meta.model === "string" && !message.meta.model.startsWith("auto") && <small className="nous-muted nous-message-model"
          title={`${nousModelLabel(message.meta.model)}${typeof message.meta.effort === "string" && message.meta.effort !== "none" ? ` · ${message.meta.effort}` : ""}`}>
          {nousModelLabel(message.meta.model)}</small>}
      </div>
    );
    case "TOOL": return <div className={`nous-tool is-${message.status.toLowerCase()}`}>{message.content}</div>;
    case "INBOX": return <NousInbox message={message} />;
    case "DECISION": return <div className="nous-message is-decision"><p>{message.content}</p></div>;
    default: return <div className="nous-message is-error" role="alert"><p>{message.content}</p></div>;
  }
}

/** The news Nous read in a turn, folded; open ones stay open on this device. */
function NousInbox({ message }: { message: NousMessage }) {
  const opened = useNousUiIds("inbox");
  const agents = useAgentLanguage();
  return (
    <details className="nous-inbox" open={opened.has(message.id)} onToggle={(event) => opened.setOpen(message.id, event.currentTarget.open)}>
      <summary>{uiText(agents, "From the rooms and the notifications")}</summary><pre>{message.content}</pre>
    </details>
  );
}

/** The Decisions tab's card; inline (in the conversation) it keeps the body short and says "Not now" instead of "Decline". */
function NousDecisionCard({ decision, onAnswer, inline = false, plan = null }: {
  decision: NousDecision; onAnswer(input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }): Promise<void>; inline?: boolean; plan?: ReactNode;
}) {
  const language = useUiLanguage();
  const agents = useAgentLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useNousUiState("everything", null, isIdOrNull);
  const everything = openId === decision.id;
  const setEverything = (open: boolean) => setOpenId((current) => open ? decision.id : current === decision.id ? null : current);
  const answer = async (input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }) => {
    setBusy(true);
    try { await onAnswer(input); setText(""); setEverything(false); } finally { setBusy(false); }
  };
  const open = decision.status === "OPEN" && !decision.runsWhen;
  const kind = open ? nousDecisionKind(decision) : null;
  // As on a Needs you card, what Nous checked before asking (pane-notices.ts) folds away under the question; "Show everything" keeps it in place.
  const checkedOpen = useNousUiIds("decision.checkedOpen");
  const split = decision.body.lastIndexOf(NEEDS_YOU_CHECKED_HEADER);
  const own = (split < 0 ? decision.body : decision.body.slice(0, split)).trim();
  const checked = split < 0 ? "" : decision.body.slice(split + NEEDS_YOU_CHECKED_HEADER.length).trim();
  // The same answers on the card and at the end of "Show everything".
  const answers = (
    <div className="nous-decision-actions">
      {decision.refs.roomId && decision.refs.paneId ? (
        <DockButton onClick={() => requestNousFocus({ roomId: decision.refs.roomId!, paneId: decision.refs.paneId!, immediate: true })}>{t("Take me there")}</DockButton>
      ) : null}
      {/* With an action, Approve runs it; an option button would only answer in words and leave the action unrun (stable 2026-10-17). */}
      {(decision.action ? [] : decision.options).map((option) => (
        <DockButton key={option} disabled={busy} onClick={() => void answer({ answer: "ANSWER", text: option })}>{t(option)}</DockButton>
      ))}
      {/* Stable 2026-10-22: a typed "yes" closed the card as answered with its action unrun; since 2026-10-24 the server reads a bare yes/no in words as the decision (nousAnswerIntent), Approve takes a note. */}
      <DockButton tone="primary" icon={Check} disabled={busy} onClick={() => void answer({ answer: "APPROVE", ...(text.trim() ? { text: text.trim() } : {}) })}>{t("Approve")}</DockButton>
      {/* Operator request 2026-10-18: this kind never asks again; Settings → Assistants & AI → Nous removes it. */}
      {kind ? (
        <DockButton disabled={busy} title={t("Approve now and every time Nous asks to {kind}", { kind: kind.label })} onClick={() => void answer({ answer: "APPROVE", always: true })}>{t("Always approve")}</DockButton>
      ) : null}
      <DockButton icon={X} disabled={busy} onClick={() => void answer({ answer: "DECLINE" })}>{t(inline ? "Not now" : "Decline")}</DockButton>
      <form className="nous-decision-answer" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ answer: "ANSWER", text: text.trim() }); }}>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} placeholder={t(decision.action ? "Yes/no runs it, or answer in your words" : "Or answer in your words")} aria-label={t("Your answer")} />
        <DockIconButton label={t("Send answer")} icon={Send} type="submit" disabled={busy || !text.trim()} />
      </form>
    </div>
  );
  return (
    <article className={`nous-decision is-${decision.status.toLowerCase()}${inline ? " is-inline" : ""}`} aria-label={decision.title} data-decision-id={decision.id}>
      <header>
        <span className={`nous-category is-${decision.category.toLowerCase()}`}>{t(CATEGORY_LABELS[decision.category])}</span>
        <h3>{decision.title}</h3>
      </header>
      {own ? <ChatMarkdown content={decisionMarkdown(agents, own)} /> : null}
      <NeedsYouFiles refs={decision.refs.files} />
      {checked ? <details className="nous-needs-checked" open={checkedOpen.has(decision.id)} onToggle={(event) => checkedOpen.setOpen(decision.id, event.currentTarget.open)}>
        <summary>{t("What Nous checked")}</summary><ChatMarkdown content={needsYouMarkdown(checked)} /></details> : null}
      {plan}
      {decision.recommendation ? <p className="nous-recommendation"><strong>{t("Nous recommends:")}</strong> {decision.recommendation}</p> : null}
      {decision.action ? <p className="nous-muted">{t(decision.runsWhen ? "Then Space runs" : "On approval Space runs")}: {describeAction(language, decision.action)}</p> : null}
      {decision.runsWhen ? <p className="nous-muted" role="status">{t("Runs by itself when this clears: {what}", { what: decision.runsWhen })}</p> : open ? (
        <>
          {/* Operator request 2026-10-21: the whole decision and every text it sends, read before Approve. */}
          <DockButton className="nous-decision-everything" onClick={() => setEverything(true)}>{t("Show everything")}</DockButton>
          {everything ? null : answers}
          {everything ? <NousDecisionEverything decision={decision} answers={answers} onClose={() => setEverything(false)} /> : null}
        </>
      ) : (
        <p className="nous-muted">{t(decision.status === "APPROVED" ? "Approved" : decision.status === "DECLINED" ? "Declined" : decision.status === "ANSWERED" ? "Answered" : "Cancelled")}
          {decision.answeredAt ? ` ${formatUserTime(decision.answeredAt)}` : ""}
          {decision.status === "ANSWERED" || (decision.status === "APPROVED" && decision.answer) ? `: ${decision.answer ?? ""}` : ""}{decision.outcome ? ` · ${decision.outcome}` : ""}</p>
      )}
      {decision.status !== "OPEN" && decision.status !== "CANCELLED" ? <NousDecisionFeedback decision={decision} /> : null}
    </article>
  );
}

type NousDecisionFile = Awaited<ReturnType<typeof api.nousDecisionFiles>>["files"][number];

/** "Show everything" (operator request 2026-10-21): the whole body, the whole action, every file it sends, and the answers at the end. */
function NousDecisionEverything({ decision, answers, onClose }: { decision: NousDecision; answers: ReactNode; onClose(): void }) {
  const language = useUiLanguage();
  const agents = useAgentLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const ref = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<NousDecisionFile[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const named = decision.refs.files ?? [];
  // A Mail, Freelance or Marketing review sends its own draft: the server reads it with the files (operator 13/11 21:43 BKK).
  const review = decision.action?.type === "COPILOT" && decision.action.item === "REVIEW" && ["MAIL", "FREELANCE", "MARKETING"].includes(decision.action.copilot);
  const namedKey = named.join("\n");
  // A modal like the dock's confirm: above every dock and pane, Escape closes only this.
  useEffect(() => {
    const dialog = ref.current;
    try { if (dialog && !dialog.open) { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); } } catch { dialog?.setAttribute("open", ""); }
    dialog?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useEffect(() => {
    if (!namedKey && !review) return;
    let cancelled = false;
    api.nousDecisionFiles(decision.id).then((result) => { if (!cancelled) setFiles(result.files); })
      .catch((err: unknown) => { if (!cancelled) setFailed(messageOf(err, "The files could not be read.")); });
    return () => { cancelled = true; };
  }, [decision.id, namedKey, review]);
  return (
    <dialog ref={ref} className="nous-everything" aria-modal="true" aria-label={`Everything about: ${decision.title}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); onClose(); }}>
      <AgentFileMentions>
      <header className="nous-everything-head">
        <span className={`nous-category is-${decision.category.toLowerCase()}`}>{t(CATEGORY_LABELS[decision.category])}</span>
        <h3>{decision.title}</h3>
        <DockIconButton label={t("Close")} icon={X} onClick={onClose} />
      </header>
      <div className="nous-everything-body">
        {decision.body ? <ChatMarkdown content={decisionMarkdown(agents, decision.body)} /> : null}
        {decision.recommendation ? <p className="nous-recommendation"><strong>{t("Nous recommends:")}</strong> {decision.recommendation}</p> : null}
        {decision.action ? <section><h4>{t("On approval Space runs")}</h4><p className="nous-everything-action">{describeAction(language, decision.action, Infinity)}</p></section> : null}
        <section aria-label={t("What it sends")}>
          <h4>{t("What it sends")}</h4>
          {(files ? files.length === 0 : named.length === 0 && !review) ? <p className="nous-muted">{t("Nous named no files with the texts this sends. Ask it in the conversation to attach them before you approve.")}</p> : null}
          {failed ? <p className="nous-muted" role="alert">{failed}</p> : (named.length > 0 || review) && files === null ? <DockState kind="loading" title={t("Reading the files")} /> : null}
          {files?.map((file) => (
            <article key={file.ref} className="nous-everything-file" aria-label={file.ref}>
              <h5>{file.ref}{file.truncated ? ` · the first ${file.text?.length.toLocaleString()} of ${file.total?.toLocaleString()} characters` : ""}</h5>
              {file.text === null ? <p className="nous-muted" role="alert">{file.error ?? "The file could not be read."}</p> : <pre>{file.text}</pre>}
            </article>
          ))}
        </section>
      </div>
      {answers}
      </AgentFileMentions>
    </dialog>
  );
}

/** A plan in the conversation; undefined while it loads, null when the clipboard has no such plan. The same button opens and closes it. */
function NousPlanCard({ plan, open, onToggle }: { plan: ClipboardItem | null | undefined; open: boolean; onToggle(): void }) {
  const title = plan ? plan.title ?? plan.text.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 120) : plan === null ? "Plan not found" : "Loading the plan…";
  const next = plan ? [...plan.steps].sort((a, b) => a.order - b.order).find((step) => step.status !== "COMPLETED") : undefined;
  return (
    <article className="nous-plan nous-plan-card" aria-label={`Plan: ${title}`}>
      <div className="nous-plan-head"><strong>{title}</strong>{plan ? <span>{plan.progressPercentage}%</span> : null}</div>
      {plan ? (
        <>
          <div className="nous-progress" role="progressbar" aria-valuenow={plan.progressPercentage} aria-valuemin={0} aria-valuemax={100} aria-label={`${title} progress`}>
            <span style={{ width: `${plan.progressPercentage}%` }} />
          </div>
          <p className="nous-muted">{plan.isCompleted ? "completed" : statusText(plan.executionStatus)}{next ? ` · next: ${next.order}. ${next.title}` : ""}</p>
        </>
      ) : null}
      <DockButton icon={open ? Minimize2 : Maximize2} aria-pressed={open} disabled={plan === null && !open} onClick={onToggle}>
        {open ? "Close the plan" : "Open the plan"}
      </DockButton>
    </article>
  );
}

/** The plan fullscreen inside the dock: what it needs from the operator, its steps, its full text and the decisions Nous asked about it. */
function NousPlanView({ plan, decisions, needs, hold, onClose, answerDecision }: {
  plan: ClipboardItem | null | undefined; decisions: NousDecision[]; needs: SpaceNotification[] | null; hold: NousPlanHold | null | undefined; onClose(): void;
  answerDecision(decision: NousDecision): (input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }) => Promise<void>;
}) {
  return (
    <div className="nous-plan-view" role="region" aria-label="Plan">
      <NousPlanCard plan={plan} open onToggle={onClose} />
      {plan ? <PlanNeedsYou plan={plan} hold={hold} needs={needs} decisions={decisions}
        renderDecision={(decision) => <NousDecisionCard inline decision={decision} onAnswer={answerDecision(decision)} />} /> : null}
      {plan?.steps.length ? (
        <ol className="nous-plan-steps" aria-label="Steps">
          {[...plan.steps].sort((a, b) => a.order - b.order).map((step) => (
            <li key={step.id} className={`is-${step.status.toLowerCase()}`}><span>{step.title}</span> <span className="nous-step-status">{statusText(step.status)}</span></li>
          ))}
        </ol>
      ) : null}
      {plan ? <div className="nous-plan-text"><ChatMarkdown content={plan.text} /></div> : null}
      {/* Its open decisions are under "What it needs from you"; the answered ones stay here. */}
      {decisions.filter((decision) => decision.refs.planId === plan?.id && decision.status !== "OPEN").map((decision) => (
        <NousDecisionCard key={decision.id} inline decision={decision} onAnswer={answerDecision(decision)} />))}
    </div>
  );
}

/** The operator tells Nous it could have decided this itself (plan clipboard:L7RgHsveHbcR step 5); it counts in Nous's escalation score. */
function NousDecisionFeedback({ decision }: { decision: NousDecision }) {
  const [could, setCould] = useState(Boolean(decision.couldHaveDecided));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setCould(Boolean(decision.couldHaveDecided)), [decision.couldHaveDecided]);
  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try { setCould(Boolean((await api.nousDecisionFeedback(decision.id, !could)).decision.couldHaveDecided)); } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <div className="nous-decision-feedback">
      <DockButton icon={Gavel} aria-pressed={could} disabled={busy} onClick={() => void toggle()}>You could have decided this</DockButton>
      {failed ? <span className="nous-muted" role="alert">Your feedback could not be saved.</span> : null}
    </div>
  );
}

/** What an approved decision runs, in the operator's language; the text it sends stays as written (it goes to the pane as is). */
function describeAction(language: UiLanguage, action: NonNullable<NousDecision["action"]>, textLimit = 160): string {
  const t = (text: string, vars: Record<string, string>) => uiText(language, text, vars);
  if (action.type === "PANE_TEXT") return action.mode === "ANSWER" ? t("answer “{text}” to the pane's prompt", { text: action.text }) : t("send “{text}” to the pane", { text: action.text.slice(0, textLimit) });
  if (action.type === "RELEASE_APPROVE") return t("approve the {product} release at its candidate commit", { product: action.product });
  if (action.type === "SPACE_CONTROL") return t("run in Space Control: {actions}", { actions: action.actions.map((entry) => [entry.kind, entry.operation].filter(Boolean).join(" ")).join(", ") });
  if (action.type === "VAULT_BROKER_REINSTALL") return t("rebuild the Vault broker from stable's code and restart it, as root", {});
  return t("{decision} the {copilot} copilot's {item}", { decision: action.decision, copilot: action.copilot.toLowerCase(), item: action.item.toLowerCase() });
}

function NousOverviewView({ overview, active, onOpenLoad }: { overview: NousOverview | null; active: boolean; onOpenLoad?(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [liveStats, setLiveStats] = useNousUiState("overview.liveStats", true, isFlag);
  if (!overview) return <DockState kind="loading" title={t("Loading the overview")} />;
  return (
    <div className="nous-overview">
      <details className="nous-live-collapsible" open={liveStats} onToggle={(event) => setLiveStats(event.currentTarget.open)}>
        <summary>{t("Live stats")}</summary>
        <NousLiveStats overview={overview} active={active} onOpenLoad={onOpenLoad} />
      </details>
      <section aria-label={t("Open plans")}>
        <h3>{t("Open plans")}</h3>
        {overview.plans.length === 0 ? <p className="nous-muted">{t("No open plans.")}</p> : null}
        {overview.plans.map((plan) => (
          <div key={plan.id} className="nous-plan">
            <div className="nous-plan-head"><strong>{plan.title}</strong><span>{plan.progress}%</span></div>
            <div className="nous-progress" role="progressbar" aria-valuenow={plan.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${plan.title} progress`}>
              <span style={{ width: `${plan.progress}%` }} />
            </div>
            <p className="nous-muted">{plan.status.replace(/_/g, " ").toLowerCase()}{plan.pane ? ` · ${plan.pane}` : ` · ${t("no pane yet")}`}{plan.room ? ` ${t("in {room}", { room: plan.room })}` : ""}{plan.nextStep ? ` · ${t("next: {step}", { step: plan.nextStep })}` : ""}</p>
          </div>
        ))}
      </section>
      <section aria-label={t("Needs your hands")}>
        <h3>{t("Needs your hands")}</h3>
        {overview.needsHands.length === 0 ? <p className="nous-muted">{t("Nothing: no sign-in, CAPTCHA or handoff waits for you.")}</p> : (
          <ul>{overview.needsHands.map((item) => <li key={item.id}>{item.title}{item.room ? ` · ${item.room}` : ""}</li>)}</ul>
        )}
      </section>
      <section aria-label={t("Plan map")}>
        <h3>{t("Plan map")}</h3>
        {overview.planMap ? <ChatMarkdown content={overview.planMap} /> : <p className="nous-muted">{t("Nous writes here which plans depend on or collide with which.")}</p>}
      </section>
    </div>
  );
}
