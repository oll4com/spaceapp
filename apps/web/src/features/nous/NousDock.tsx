import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { nousDecisionKind, type ClipboardItem, type NousAttachment, type NousDecision, type NousMessage, type NousOverview, type NousState } from "@space/contracts";
import { api } from "../../api.js";
import { ChatMarkdown } from "../agent-pane/ChatMarkdown.js";
import { AgentFileMentions } from "../terminal-pane/AgentFileLinks.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockFullscreenButton, DockIconButton, DockNotice, DockState, useDockConfirm } from "../dock-kit/DockKit.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { requestNousFocus, useLeaveDuringNousFocus } from "../nous-focus/nous-focus-events.js";
import { ArrowDownToLine, Check, ChevronRight, ChevronsUp, CircleStop, Gavel, Maximize2, Minimize2, Nous, Paperclip, Send, Trash2, X } from "../ui-theme/app-icons.js";
import { NousBrain3D } from "./NousBrain3D.js";
import { NousLivePlans, NousLiveStats } from "./NousLiveStats.js";
import { NousNeedsYou, useNeedsYouRequests } from "./NousNeedsYou.js";
import { NousPaneBoard } from "./NousPaneBoard.js";
import { clipboardFiles, NousMessageFiles, NousPendingFiles, operatorText, usePendingFiles } from "./NousFiles.js";
import "./nous.css";

type Tab = "conversation" | "needs" | "decisions" | "overview" | "panes" | "plans";
const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 20_000;
/** While Nous writes (a streamed draft exists) the dock reads it more often; back to the thinking cadence otherwise. */
const DRAFT_POLL_MS = 1_500;
const STATUS_LABELS: Record<NousState["status"], string> = {
  OFF: "Off: answers you only", IDLE: "On: watching every room", THINKING: "Thinking…", PAUSED_MODEL: "Paused: its model is not available"
};
const REASON_LABELS: Record<NonNullable<NousState["running"]>["reason"], string> = {
  OPERATOR: "Answering you", INBOX: "Reading news from the rooms", DECISION: "Acting on your answer", HEARTBEAT: "Checking every room", STANDING: "Standing orders: finished panes and stalled plans",
  REVIEW: "Daily self-review"
};
const VIEW_TITLES: Record<Tab, string> = { conversation: "Conversation", needs: "Needs you", decisions: "Decisions", overview: "Overview", panes: "Pane board", plans: "Plans" };
const CATEGORY_LABELS: Record<NousDecision["category"], string> = { RELEASE: "Release", DESTRUCTIVE: "Irreversible", EXTERNAL: "Third parties or money", DIRECTION: "Direction" };
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const planIdsIn = (text: string) => [...new Set(text.match(/clipboard:[A-Za-z0-9_-]+/g) ?? [])];
const statusText = (status: string) => status.replace(/_/g, " ").toLowerCase();
const clock = (iso: string) => formatUserTime(iso);

// shortcut: there is no single-record clipboard route, so the PLAN list is paged until every id is found (at most 1,000 plans);
// add GET /api/clipboard-items/:id if the operator's plans outgrow it. Missing ids come back as null.
async function findPlans(ids: string[]): Promise<Record<string, ClipboardItem | null>> {
  const found: Record<string, ClipboardItem | null> = Object.fromEntries(ids.map((id) => [id, null]));
  for (let page = 1, left = ids.length; page <= 10 && left > 0; page += 1) {
    const result = await api.clipboardItems({ source: "PLAN", pageSize: 100, page });
    for (const item of result.data) if (found[item.id] === null) { found[item.id] = item; left -= 1; }
    if (page >= result.pagination.totalPages) break;
  }
  return found;
}

/** Nous, the mind of SpaceApp: the one conversation over every room, the critical decisions it brings you and the plans it drives. */
export function NousDock({ canRun = false }: { canRun?: boolean }) {
  const isActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [planView, setPlanView] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, ClipboardItem | null>>({});
  const [state, setState] = useState<NousState | null>(null);
  const [messages, setMessages] = useState<NousMessage[] | null>(null);
  /** The operator's messages still in Nous's queue (no answer yet), from the server. */
  const [waiting, setWaiting] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<NousDecision[]>([]);
  const [overview, setOverview] = useState<NousOverview | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [decisionFilter, setDecisionFilter] = useState<"open" | "all">("open");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [messageFiles, setMessageFiles] = useState<Record<string, NousAttachment[]>>({});
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Operator request 2026-10-21: "my messages" walks back from the newest (0) one per press; reaching the end starts it over.
  const mineRef = useRef(-1);
  /** Where the last jump left the list: its own scroll event is not the operator scrolling. */
  const jumpTopRef = useRef<number | null>(null);
  /** At the end of the conversation it follows new messages; reading further up it stays put. */
  const stickRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pending = usePendingFiles(useCallback((message: string) => setError(message), []));
  const needs = useNeedsYouRequests(isActive && canRun);

  const refresh = useCallback(async () => {
    const [next, list, open] = await Promise.all([api.nous(), api.nousMessages(), api.nousDecisions()]);
    setState(next.state);
    setMessages(list.messages);
    setWaiting(list.waiting ?? []);
    setMessageFiles(list.attachments ?? {});
    setDecisions(open.decisions);
  }, []);

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
    if (!isActive || !canRun || (tab !== "overview" && tab !== "panes" && tab !== "plans" && !fullscreen)) return;
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
    const missing = planIds ? planIds.split(" ").filter((id) => !(id in plans)) : [];
    if (missing.length) void loadPlans(missing);
  }, [planIds, plans, loadPlans]);
  const openPlan = (id: string) => { setPlanView(id); void loadPlans([id]); };
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
    if (stickRef.current) { mineRef.current = -1; list.querySelector("[data-jumped]")?.removeAttribute("data-jumped"); }
  };
  const jumpToMine = () => {
    const list = listRef.current;
    const mine = [...(list?.querySelectorAll<HTMLElement>(".nous-message.is-operator") ?? [])].reverse();
    if (!list || !mine.length) return;
    mineRef.current = Math.min(mineRef.current + 1, mine.length - 1);
    const target = mine[mineRef.current]!;
    list.querySelector("[data-jumped]")?.removeAttribute("data-jumped");
    target.setAttribute("data-jumped", "");
    target.scrollIntoView?.({ block: "start" });
    jumpTopRef.current = list.scrollTop;
    stickRef.current = false;
  };
  const jumpToLatest = () => { stickRef.current = true; toLatest(); };
  const showMessage = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });

  const canSend = (Boolean(draft.trim()) || pending.readyIds.length > 0) && !pending.uploading && !sending;
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await api.sendNousMessage(content, pending.readyIds);
      setDraft("");
      pending.clear();
      stickRef.current = true;
      await refresh();
    } catch (err) {
      setError(messageOf(err, "Your message could not be sent."));
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
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

  const open = decisions.filter((decision) => decision.status === "OPEN");
  const shownDecisions = decisionFilter === "open" ? open : decisions;
  const byId = new Map((messages ?? []).map((entry) => [entry.id, entry]));
  // Queued until Nous answers it; "answering" once the running turn took it (the turn began after it was sent).
  const queueOf = (entry: NousMessage) => !waiting.includes(entry.id) ? null
    : state?.running?.reason === "OPERATOR" && entry.createdAt <= state.running.startedAt ? "answering" : "queued";
  // An answer quotes the operator's messages it answers, as in a chat (meta.replyTo).
  const quotesOf = (entry: NousMessage) => (Array.isArray(entry.meta.replyTo) ? entry.meta.replyTo : []).flatMap((id) => byId.get(String(id)) ?? []);
  const entries = messages === null ? [] : [
    ...messages.map((entry) => ({ at: entry.createdAt, tool: entry.kind === "TOOL" ? entry : null, node: (
      <NousMessageRow key={entry.id} message={entry} files={messageFiles[entry.id] ?? []} planCard={planCard}
        queue={entry.kind === "OPERATOR" ? queueOf(entry) : null} quotes={entry.kind === "ANSWER" ? quotesOf(entry) : []} onShowMessage={showMessage} />
    ) })),
    // Every decision sits where Nous asked it; one about a plan carries the plan card that opens it.
    ...decisions.map((decision) => ({ at: decision.createdAt, tool: null, node: (
      <NousDecisionCard key={decision.id} inline decision={decision} onAnswer={answerDecision(decision)}
        plan={decision.refs.planId ? planCard(decision.refs.planId, "plan") : null} />
    ) }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  const modelLabel = state ? `${state.model.replace(/^claude-(\w)/, (_, first: string) => `Claude ${first.toUpperCase()}`).replace(/-(\d)-(\d)$/, " $1.$2")} · ${state.effort}` : "…";
  // Away mode (plan clipboard:B7eTUHTJYg3X): "Away since 23:29 ICT" in the operator's working time zone.
  const statusLine = <p className={`nous-status is-${(state?.status ?? "OFF").toLowerCase()}`} role="status">
    {state ? STATUS_LABELS[state.status] : "Loading…"}{state?.away ? <span className="nous-away-line"> · Away since {clock(state.away.startedAt)}</span> : null}</p>;
  // Operator request 2026-10-17: the dock keeps only Nous's power switch ("Work on my behalf"); every other switch is in Settings.
  const enabled = Boolean(state?.settings.enabled);
  const power = (
    <label className={`nous-power${enabled ? " is-on" : ""}`}
      title="Work on my behalf: Nous answers panes and copilots in every room. Its other switches are in Settings → Assistants & AI → Nous.">
      <input type="checkbox" role="switch" aria-label="Nous works on my behalf" checked={enabled} disabled={!state}
        onChange={(event) => { const on = event.currentTarget.checked; void act(() => api.updateNousSettings({ enabled: on }), "The setting could not be saved.")
          // Turning it on starts a first review at once: look again shortly so the dock shows it thinking.
          .then(() => { if (on) window.setTimeout(() => void refresh().catch(() => undefined), 1_500); }); }} />
      <span className="nous-power-track" aria-hidden="true"><span className="nous-power-text">{enabled ? "On" : "Off"}</span><span className="nous-power-thumb" /></span>
    </label>
  );
  const lastError = state?.lastError ? <p className="nous-muted nous-last-error">Last problem: {state.lastError}</p> : null;
  const views = <DockChips label="Nous views" value={tab} onChange={(next) => { setPlanView(null); setTab(next); }} options={[
    { id: "conversation", label: "Conversation" }, { id: "needs", label: "Needs you", ...(needs?.length ? { count: needs.length } : {}) }, { id: "decisions", label: "Decisions", ...(open.length ? { count: open.length } : {}) }, { id: "overview", label: "Overview" },
    { id: "panes", label: "Panes", ...(overview?.panes?.some((pane) => pane.overdue) ? { count: overview.panes.filter((pane) => pane.overdue).length } : {}) },
    { id: "plans", label: "Plans" }
  ]} />;
  const actions = (
    <>
      {tab === "conversation" && !planView ? (
        <DockIconButton label="Clear the conversation" icon={Trash2} disabled={thinking || !count} onClick={async () => {
          if (!(await confirm({ title: "Clear the conversation?", message: "Nous keeps its notes and decisions; the messages are removed.", confirmLabel: "Clear" }))) return;
          await act(() => api.clearNousMessages(), "The conversation could not be cleared.");
        }} />
      ) : null}
      <DockFullscreenButton name="Nous" active={fullscreen} onToggle={() => { setPlanView(null); setIsFullscreen(!fullscreen); }} />
    </>
  );
  const notice = error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null;
  const draftNode = writing ? (
    <div className="nous-message is-answer is-draft" aria-live="polite">
      <ChatMarkdown content={writing} />
      <p className="nous-queue is-answering">Nous is writing…</p>
    </div>
  ) : null;
  const view = (items: ReactNode[], trailing: ReactNode) => planView ? (
    <NousPlanView plan={plans[planView]} decisions={decisions.filter((decision) => decision.refs.planId === planView)}
      onClose={() => setPlanView(null)} answerDecision={answerDecision} />
  ) : tab === "conversation" ? (
    <div className={`nous-conversation${dragging ? " is-dropping" : ""}`} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="nous-messages" data-sensitive-masked="manual" ref={listRef} aria-live="polite" onScroll={onScroll}>
        {messages === null ? <DockState kind="loading" title="Loading the conversation" /> : null}
        {messages?.length === 0 ? <DockState kind="empty" icon={Nous} title="Talk to Nous" detail="Ask what is happening in every room, give it a goal, or switch it on to work on your behalf." /> : null}
        {items}
        {trailing}
      </div>
      <NousPendingFiles files={pending.files} onRemove={pending.remove} />
      <form className="nous-composer" onSubmit={(event) => void send(event)}>
        {/* Operator request 2026-10-21: the message field takes the whole width with Send beside it; the other controls sit above it. */}
        <div className="nous-composer-tools">
          <DockIconButton label="Attach files" icon={Paperclip} onClick={() => fileInputRef.current?.click()} />
          <input ref={fileInputRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1}
            onChange={(event) => { pending.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          {state?.status === "THINKING" ? (
            <DockIconButton label="Stop" icon={CircleStop} onClick={() => void act(() => api.stopNous(), "Nous could not be stopped.")} />
          ) : null}
          <span className="nous-composer-jump">
            <DockIconButton label="Go to my last message (press again for the one before)" icon={ChevronsUp} disabled={!count} onClick={jumpToMine} />
            <DockIconButton label="Go to the latest message" icon={ArrowDownToLine} disabled={!count} onClick={jumpToLatest} />
          </span>
        </div>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} rows={2} maxLength={8_000}
          placeholder="Message Nous, or paste a screenshot" aria-label="Message Nous" />
        <DockIconButton label="Send" icon={Send} tone="primary" type="submit" disabled={!canSend} busy={sending} />
      </form>
      {dragging ? <div className="nous-drop-hint" aria-hidden="true">Drop files to send them to Nous</div> : null}
    </div>
  ) : tab === "needs" ? (
    <NousNeedsYou requests={needs} />
  ) : tab === "decisions" ? (
    <div className="nous-decisions">
      {/* Operator request 2026-10-21: only the decisions still waiting for an answer, or all of them. */}
      <DockChips label="Show decisions" value={decisionFilter} onChange={setDecisionFilter} options={[
        { id: "open", label: "Unanswered", count: open.length }, { id: "all", label: "All", count: decisions.length }]} />
      {shownDecisions.length === 0 ? <DockState kind="empty" icon={Nous} title={decisionFilter === "open" ? "Nothing waits for you" : "No decisions"}
        detail="Nous brings you only releases, irreversible actions, anything to third parties or with money, and product direction." /> : null}
      {shownDecisions.map((decision) => (
        <NousDecisionCard key={decision.id} decision={decision} onAnswer={answerDecision(decision)} />
      ))}
    </div>
  ) : tab === "plans" ? (
    // Operator request 2026-10-19 (plan clipboard:7PiQv4Cnq0C2): Live's plan list in any dock size; a row opens the plan.
    <div className="nous-overview">
      <section className="nous-live" aria-label="Plans" data-motion={isActive ? "on" : "off"}>
        <NousLivePlans overview={overview} active={isActive} onOpen={openPlan} />
        {!overview ? <DockState kind="loading" title="Loading the plans" />
          : overview.plans.some((plan) => plan.pane) ? null : <p className="nous-muted">No open plan is on a pane.</p>}
      </section>
    </div>
  ) : (
    tab === "panes" ? <NousPaneBoard active={isActive} decisions={decisions} overview={overview} onSent={() => void refresh().catch(() => undefined)}
      renderDecision={(decision) => <NousDecisionCard inline decision={decision} onAnswer={answerDecision(decision)} />} />
      : <NousOverviewView overview={overview} active={isActive} />
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
    const maxTurns = state?.settings.maxTurnsPerHour ?? 20;
    return (
      <section className={`dock-panel nous-dock is-fullscreen nous-workspace${thinking ? " is-thinking" : ""}${tab === "panes" && !planView ? " is-pane-board" : ""}`} aria-label="Nous">
        <AgentFileMentions>
        <aside className="nous-rail" aria-label="Nous status">
          <div className="nous-rail-identity">
            <div className="nous-rail-brain"><NousBrain3D size={168} animate={isActive} thinking={thinking} firing /></div>
            <h2>Nous</h2>
            <p className="nous-tagline">The mind of SpaceApp</p>
            <p className="nous-tagline">{modelLabel}</p>
            {statusLine}
            {state?.running ? <p className="nous-running">{REASON_LABELS[state.running.reason]} · <NousElapsed since={state.running.startedAt} /></p> : null}
            {power}
          </div>
          {views}
          <dl className="nous-gauges">
            <div className={open.length ? "is-attention" : undefined}><dt>Decisions waiting</dt><dd>{open.length}</dd></div>
            <div><dt>Inbox</dt><dd>{state?.inbox ?? 0}</dd></div>
            <div className="is-meter">
              <dt>Turns this hour</dt><dd>{turns}<span> of {maxTurns}</span></dd>
              <span className="nous-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (turns / maxTurns) * 100)}%` }} /></span>
            </div>
          </dl>
          {lastError}
        </aside>
        <div className="nous-stage">
          <header className="nous-stage-head"><h3>{planView ? "Plan" : VIEW_TITLES[tab]}</h3></header>
          {notice}
          {view(folded, draftNode)}
        </div>
        {/* The dock's own controls sit at its far right edge (operator request 2026-10-17, plan clipboard:wr9yNPJwkDrp). */}
        <div className="nous-workspace-tools">{actions}</div>
        <NousBoard overview={overview} open={open} onShowDecision={showDecision} openPlan={openPlan} live={isActive} />
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
          <p className="nous-tagline" title={modelLabel}>{modelLabel}</p>
          {statusLine}
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

/** One run of tool steps as a single line (count, helpers and the latest step) that opens to every step. */
function NousSteps({ steps }: { steps: NousMessage[] }) {
  const running = steps.some((step) => step.status === "RUNNING");
  const failed = steps.filter((step) => step.status === "FAILED").length;
  // A gate that held a step for the operator worked as meant (stable 2026-10-22: holds read as failures).
  const held = steps.filter((step) => step.status === "REFUSED").length;
  // Helpers (space_subagents) record their calls under the turn with their own id.
  const helpers = new Set(steps.flatMap((step) => typeof step.meta.subagentId === "string" ? [step.meta.subagentId] : [])).size;
  const usedHelpers = helpers > 0 || steps.some((step) => step.meta.name === "space_subagents");
  return (
    <details className={`nous-steps${running ? " is-running" : ""}`}>
      <summary>
        <ChevronRight className="nous-steps-chevron" aria-hidden="true" />
        <span className="nous-steps-count">{steps.length === 1 ? "1 step" : `${steps.length} steps`}</span>
        {usedHelpers ? <span className="nous-steps-helpers">{helpers === 0 ? "Helpers" : helpers === 1 ? "1 helper" : `${helpers} helpers`}</span> : null}
        <span className="nous-steps-last">{steps[steps.length - 1]!.content}</span>
        {/* "steps failed", never just "failed": next to the helpers it read as if every helper had failed (operator 2026-10-21). */}
        {failed ? <span className="nous-steps-failed">{failed === 1 ? "1 step failed" : `${failed} steps failed`}</span> : null}
        {held ? <span className="nous-steps-held">{held === 1 ? "1 step held back" : `${held} steps held back`}</span> : null}
      </summary>
      <ol>{steps.map((step) => <li key={step.id} className={`nous-tool is-${step.status.toLowerCase()}${step.meta.subagentId ? " is-helper" : ""}`}>{step.content}</li>)}</ol>
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
function NousBoard({ overview, open, onShowDecision, openPlan, live }: {
  overview: NousOverview | null; open: NousDecision[]; onShowDecision(id: string): void; openPlan(id: string): void; live: boolean;
}) {
  return (
    <aside className="nous-board" aria-label="Needs you and the plans">
      {/* Live stats first, in sight without scrolling; they replace the raw release-train text (releases reach the operator as RELEASE decisions). */}
      <NousLiveStats overview={overview} active={live} />
      <section aria-label="Needs you">
        <h3>Needs you{open.length ? <span className="nous-board-count is-attention">{open.length}</span> : null}</h3>
        {open.length === 0 ? <p className="nous-muted">Nothing waits for you. Nous brings releases, irreversible actions, third parties or money, and direction here.</p> : null}
        {/* Each one is answered once, where Nous asked it in the conversation; here it is a line that leads there. */}
        {open.map((decision) => (
          <button key={decision.id} type="button" className="nous-board-ask" onClick={() => onShowDecision(decision.id)}>
            <span className={`nous-category is-${decision.category.toLowerCase()}`}>{CATEGORY_LABELS[decision.category]}</span>
            <strong>{decision.title}</strong>
            <span className="nous-muted">Asked {clock(decision.createdAt)}{decision.recommendation ? ` · Nous recommends: ${decision.recommendation}` : ""}</span>
          </button>
        ))}
      </section>
      <section aria-label="Plans">
        <h3>Plans{overview?.plans.length ? <span className="nous-board-count">{overview.plans.length}</span> : null}</h3>
        {!overview ? <p className="nous-muted">Loading the plans…</p> : overview.plans.length === 0 ? <p className="nous-muted">No open plans.</p> : null}
        {overview?.plans.map((plan) => (
          <button key={plan.id} type="button" className={`nous-board-plan is-${plan.status.toLowerCase()}`} onClick={() => openPlan(plan.id)}
            aria-label={`Open the plan ${plan.title}, ${plan.progress}%`}>
            <span className="nous-plan-head"><strong>{plan.title}</strong><span>{plan.progress}%</span></span>
            <span className="nous-progress" aria-hidden="true"><span style={{ width: `${plan.progress}%` }} /></span>
            <span className="nous-muted">{statusText(plan.status)}{plan.pane ? ` · ${plan.pane}` : " · no pane yet"}{plan.room ? ` in ${plan.room}` : ""}</span>
            {plan.nextStep ? <span className="nous-muted">Next: {plan.nextStep}</span> : null}
          </button>
        ))}
      </section>
      <section aria-label="Needs your hands">
        <h3>Needs your hands{overview?.needsHands.length ? <span className="nous-board-count is-attention">{overview.needsHands.length}</span> : null}</h3>
        {overview?.needsHands.length ? (
          <ul>{overview.needsHands.map((item) => <li key={item.id}>{item.title}{item.room ? <span className="nous-muted"> · {item.room}</span> : null}</li>)}</ul>
        ) : <p className="nous-muted">{overview ? "No sign-in, CAPTCHA or handoff waits for you." : "Loading…"}</p>}
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
        <ChatMarkdown content={message.content} />{planIdsIn(message.content).map((id) => planCard(id, id))}
      </div>
    );
    case "TOOL": return <div className={`nous-tool is-${message.status.toLowerCase()}`}>{message.content}</div>;
    case "INBOX": return (
      <details className="nous-inbox"><summary>From the rooms and the notifications</summary><pre>{message.content}</pre></details>
    );
    case "DECISION": return <div className="nous-message is-decision"><p>{message.content}</p></div>;
    default: return <div className="nous-message is-error" role="alert"><p>{message.content}</p></div>;
  }
}

/** The Decisions tab's card; inline (in the conversation) it keeps the body short and says "Not now" instead of "Decline". */
function NousDecisionCard({ decision, onAnswer, inline = false, plan = null }: {
  decision: NousDecision; onAnswer(input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }): Promise<void>; inline?: boolean; plan?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [everything, setEverything] = useState(false);
  const answer = async (input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }) => {
    setBusy(true);
    try { await onAnswer(input); setText(""); setEverything(false); } finally { setBusy(false); }
  };
  const open = decision.status === "OPEN";
  const kind = open ? nousDecisionKind(decision) : null;
  // The same answers on the card and at the end of "Show everything".
  const answers = (
    <div className="nous-decision-actions">
      {decision.refs.roomId && decision.refs.paneId ? (
        <DockButton onClick={() => requestNousFocus({ roomId: decision.refs.roomId!, paneId: decision.refs.paneId!, immediate: true })}>Take me there</DockButton>
      ) : null}
      {/* With an action, Approve runs it; an option button would only answer in words and leave the action unrun (stable 2026-10-17). */}
      {(decision.action ? [] : decision.options).map((option) => (
        <DockButton key={option} disabled={busy} onClick={() => void answer({ answer: "ANSWER", text: option })}>{option}</DockButton>
      ))}
      {/* Stable 2026-10-22: a typed "yes" closed the card as answered with its action unrun; since 2026-10-24 the server reads a bare yes/no in words as the decision (nousAnswerIntent), Approve takes a note. */}
      <DockButton tone="primary" icon={Check} disabled={busy} onClick={() => void answer({ answer: "APPROVE", ...(text.trim() ? { text: text.trim() } : {}) })}>Approve</DockButton>
      {/* Operator request 2026-10-18: this kind never asks again; Settings → Assistants & AI → Nous removes it. */}
      {kind ? (
        <DockButton disabled={busy} title={`Approve now and every time Nous asks to ${kind.label}`} onClick={() => void answer({ answer: "APPROVE", always: true })}>Always approve</DockButton>
      ) : null}
      <DockButton icon={X} disabled={busy} onClick={() => void answer({ answer: "DECLINE" })}>{inline ? "Not now" : "Decline"}</DockButton>
      <form className="nous-decision-answer" onSubmit={(event) => { event.preventDefault(); if (text.trim()) void answer({ answer: "ANSWER", text: text.trim() }); }}>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} placeholder={decision.action ? "Yes/no runs it, or answer in your words" : "Or answer in your words"} aria-label="Your answer" />
        <DockIconButton label="Send answer" icon={Send} type="submit" disabled={busy || !text.trim()} />
      </form>
    </div>
  );
  return (
    <article className={`nous-decision is-${decision.status.toLowerCase()}${inline ? " is-inline" : ""}`} aria-label={decision.title} data-decision-id={decision.id}>
      <header>
        <span className={`nous-category is-${decision.category.toLowerCase()}`}>{CATEGORY_LABELS[decision.category]}</span>
        <h3>{decision.title}</h3>
      </header>
      {decision.body ? <ChatMarkdown content={decision.body} /> : null}
      {plan}
      {decision.recommendation ? <p className="nous-recommendation"><strong>Nous recommends:</strong> {decision.recommendation}</p> : null}
      {decision.action ? <p className="nous-muted">On approval Space runs: {describeAction(decision.action)}</p> : null}
      {open ? (
        <>
          {/* Operator request 2026-10-21: the whole decision and every text it sends, read before Approve. */}
          <DockButton className="nous-decision-everything" onClick={() => setEverything(true)}>Show everything</DockButton>
          {everything ? null : answers}
          {everything ? <NousDecisionEverything decision={decision} answers={answers} onClose={() => setEverything(false)} /> : null}
        </>
      ) : (
        <p className="nous-muted">{decision.status === "APPROVED" ? "Approved" : decision.status === "DECLINED" ? "Declined" : decision.status === "ANSWERED" ? "Answered" : "Cancelled"}
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
  const ref = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<NousDecisionFile[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const named = decision.refs.files ?? [];
  const namedKey = named.join("\n");
  // A modal like the dock's confirm: above every dock and pane, Escape closes only this.
  useEffect(() => {
    const dialog = ref.current;
    try { if (dialog && !dialog.open) { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); } } catch { dialog?.setAttribute("open", ""); }
    dialog?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useEffect(() => {
    if (!namedKey) return;
    let cancelled = false;
    api.nousDecisionFiles(decision.id).then((result) => { if (!cancelled) setFiles(result.files); })
      .catch((err: unknown) => { if (!cancelled) setFailed(messageOf(err, "The files could not be read.")); });
    return () => { cancelled = true; };
  }, [decision.id, namedKey]);
  return (
    <dialog ref={ref} className="nous-everything" aria-modal="true" aria-label={`Everything about: ${decision.title}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); onClose(); }}>
      <AgentFileMentions>
      <header className="nous-everything-head">
        <span className={`nous-category is-${decision.category.toLowerCase()}`}>{CATEGORY_LABELS[decision.category]}</span>
        <h3>{decision.title}</h3>
        <DockIconButton label="Close" icon={X} onClick={onClose} />
      </header>
      <div className="nous-everything-body">
        {decision.body ? <ChatMarkdown content={decision.body} /> : null}
        {decision.recommendation ? <p className="nous-recommendation"><strong>Nous recommends:</strong> {decision.recommendation}</p> : null}
        {decision.action ? <section><h4>On approval Space runs</h4><p className="nous-everything-action">{describeAction(decision.action, Infinity)}</p></section> : null}
        <section aria-label="What it sends">
          <h4>What it sends</h4>
          {named.length === 0 ? <p className="nous-muted">Nous named no files with the texts this sends. Ask it in the conversation to attach them before you approve.</p> : null}
          {failed ? <p className="nous-muted" role="alert">{failed}</p> : named.length > 0 && files === null ? <DockState kind="loading" title="Reading the files" /> : null}
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

/** The plan fullscreen inside the dock: its steps, its full text and the decisions Nous asked about it, answered as in the Decisions tab. */
function NousPlanView({ plan, decisions, onClose, answerDecision }: {
  plan: ClipboardItem | null | undefined; decisions: NousDecision[]; onClose(): void;
  answerDecision(decision: NousDecision): (input: { answer: "APPROVE" | "DECLINE" | "ANSWER"; text?: string; always?: boolean }) => Promise<void>;
}) {
  return (
    <div className="nous-plan-view" role="region" aria-label="Plan">
      <NousPlanCard plan={plan} open onToggle={onClose} />
      {plan?.steps.length ? (
        <ol className="nous-plan-steps" aria-label="Steps">
          {[...plan.steps].sort((a, b) => a.order - b.order).map((step) => (
            <li key={step.id} className={`is-${step.status.toLowerCase()}`}><span>{step.title}</span> <span className="nous-step-status">{statusText(step.status)}</span></li>
          ))}
        </ol>
      ) : null}
      {plan ? <div className="nous-plan-text"><ChatMarkdown content={plan.text} /></div> : null}
      {decisions.map((decision) => <NousDecisionCard key={decision.id} inline decision={decision} onAnswer={answerDecision(decision)} />)}
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

function describeAction(action: NonNullable<NousDecision["action"]>, textLimit = 160): string {
  if (action.type === "PANE_TEXT") return action.mode === "ANSWER" ? `answer “${action.text}” to the pane's prompt` : `send “${action.text.slice(0, textLimit)}” to the pane`;
  if (action.type === "RELEASE_APPROVE") return `approve the ${action.product} release at its candidate commit`;
  if (action.type === "SPACE_CONTROL") return `run in Space Control: ${action.actions.map((entry) => [entry.kind, entry.operation].filter(Boolean).join(" ")).join(", ")}`;
  if (action.type === "VAULT_BROKER_REINSTALL") return "rebuild the Vault broker from stable's code and restart it, as root";
  return `${action.decision} the ${action.copilot.toLowerCase()} copilot's ${action.item.toLowerCase()}`;
}

function NousOverviewView({ overview, active }: { overview: NousOverview | null; active: boolean }) {
  if (!overview) return <DockState kind="loading" title="Loading the overview" />;
  return (
    <div className="nous-overview">
      <details className="nous-live-collapsible" open>
        <summary>Live stats</summary>
        <NousLiveStats overview={overview} active={active} />
      </details>
      <section aria-label="Open plans">
        <h3>Open plans</h3>
        {overview.plans.length === 0 ? <p className="nous-muted">No open plans.</p> : null}
        {overview.plans.map((plan) => (
          <div key={plan.id} className="nous-plan">
            <div className="nous-plan-head"><strong>{plan.title}</strong><span>{plan.progress}%</span></div>
            <div className="nous-progress" role="progressbar" aria-valuenow={plan.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${plan.title} progress`}>
              <span style={{ width: `${plan.progress}%` }} />
            </div>
            <p className="nous-muted">{plan.status.replace(/_/g, " ").toLowerCase()}{plan.pane ? ` · ${plan.pane}` : " · no pane yet"}{plan.room ? ` in ${plan.room}` : ""}{plan.nextStep ? ` · next: ${plan.nextStep}` : ""}</p>
          </div>
        ))}
      </section>
      <section aria-label="Needs your hands">
        <h3>Needs your hands</h3>
        {overview.needsHands.length === 0 ? <p className="nous-muted">Nothing: no sign-in, CAPTCHA or handoff waits for you.</p> : (
          <ul>{overview.needsHands.map((item) => <li key={item.id}>{item.title}{item.room ? ` · ${item.room}` : ""}</li>)}</ul>
        )}
      </section>
      <section aria-label="Plan map">
        <h3>Plan map</h3>
        {overview.planMap ? <ChatMarkdown content={overview.planMap} /> : <p className="nous-muted">Nous writes here which plans depend on or collide with which.</p>}
      </section>
    </div>
  );
}
