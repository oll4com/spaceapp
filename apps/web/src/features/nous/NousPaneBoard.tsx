import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { NousDecision, NousOverview, NousPaneBoard as Board, NousPaneBoardAnswerInput, NousPaneBoardPane, NousPaneWaitsOn } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockIconButton, DockNotice, DockState } from "../dock-kit/DockKit.js";
import { NOTIFICATION_STREAM_EVENT } from "../notifications/useNotifications.js";
import { NOUS_PANE_BOARD_EVENT, requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import { ChevronDown, ChevronRight, Nous, RefreshCw, Send, Terminal } from "../ui-theme/app-icons.js";

/**
 * Nous's pane board (operator request 2026-10-19, plan clipboard:Y9cgKVHFaHrr): every open pane by room with its live line
 * (what it does, what it waits on), what waits for the operator under it, and a reply box per pane. Full screen it is a wide
 * board; in the narrow dock the same rows stack. The server sends ids on its stream; the board refetches.
 */
type WaitsFilter = "ALL" | "NEEDS_ME" | Exclude<NousPaneWaitsOn, "OPERATOR">;
type Target = NousPaneBoardAnswerInput["target"];
const WAITS_LABELS: Record<NousPaneWaitsOn, string> = { OPERATOR: "You", DATE: "Date", PROMOTE: "Promote", THIRD_PARTY: "Third party", NOUS: "Nous", NONE: "Nothing" };
const STATE_LABELS: Record<string, string> = { working: "Working", waiting: "Waiting", done: "Done", idle: "Idle", closed: "Closed" };
const PAUSED_LABELS: Record<NonNullable<Board["paused"]>, string> = {
  OFF: "Summaries are off in Settings: lines are Space's own.",
  NOUS_OFF: "Nous is off: lines are Space's own where panes changed.",
  UNAVAILABLE: "The summary model runs only on the stable instance: lines are Space's own.",
  DAILY_CAP: "Summaries paused (daily cap): lines are Space's own where panes changed."
};
// Nous's own check of each pane (plan clipboard:MAongwnxq9Ro), from the dock's overview.
const VERDICTS: Record<string, string> = {
  OK_WORKING: "Working fine", WAITING_OPERATOR: "Waits for you", WAITING_DATE: "Waits for a date", NEEDS_ACTION: "Needs action",
  BLOCKED: "Blocked", OPERATOR_TEST: "Your test pane"
};
type PaneCheck = NonNullable<NousOverview["panes"]>[number];
const REFETCH_DEBOUNCE_MS = 1_500;
const POLL_MS = 30_000;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const needsMe = (pane: NousPaneBoardPane) => pane.summary.needsOperator || pane.summary.waitsOn === "OPERATOR";

export function NousPaneBoard({ active, decisions, overview, renderDecision, onSent }: {
  active: boolean; decisions: NousDecision[]; overview: NousOverview | null; renderDecision(decision: NousDecision): ReactNode; onSent?(): void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WaitsFilter>("ALL");
  const [room, setRoom] = useState("ALL");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => api.nousPaneBoard().then((result) => { setBoard(result.board); setError(null); })
    .catch((err: unknown) => setError(messageOf(err, "The pane board could not be loaded."))), []);
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const soon = () => { if (timer === null) timer = window.setTimeout(() => { timer = null; void load(); }, REFETCH_DEBOUNCE_MS); };
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    window.addEventListener(NOUS_PANE_BOARD_EVENT, soon);
    window.addEventListener(NOTIFICATION_STREAM_EVENT, soon);
    return () => {
      window.clearInterval(poll);
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(NOUS_PANE_BOARD_EVENT, soon);
      window.removeEventListener(NOTIFICATION_STREAM_EVENT, soon);
    };
  }, [active, load]);

  const decisionById = useMemo(() => new Map(decisions.filter((decision) => decision.status === "OPEN").map((decision) => [decision.id, decision])), [decisions]);
  const checks = useMemo(() => new Map((overview?.panes ?? []).map((check) => [check.paneId, check])), [overview]);
  if (!board) return error ? <DockNotice>{error}</DockNotice> : <DockState kind="loading" title="Loading the pane board" />;
  const panes = board.rooms.flatMap((entry) => entry.panes);
  if (!panes.length) return <DockState kind="empty" icon={Nous} title="No open panes" detail="Every open pane shows here by room, with what it does and what it waits on." />;

  const matches = (pane: NousPaneBoardPane, value: WaitsFilter) => value === "ALL" || (value === "NEEDS_ME" ? needsMe(pane) : pane.summary.waitsOn === value);
  const count = (value: WaitsFilter) => panes.filter((pane) => matches(pane, value)).length;
  const filters: Array<{ id: WaitsFilter; label: string; count?: number }> = [
    { id: "ALL", label: "All", count: panes.length }, { id: "NEEDS_ME", label: "Needs me", count: count("NEEDS_ME") },
    ...(["DATE", "PROMOTE", "THIRD_PARTY", "NOUS", "NONE"] as const).filter((value) => count(value) > 0 || filter === value)
      .map((value) => ({ id: value, label: value === "NONE" ? "Working or nothing" : WAITS_LABELS[value], count: count(value) }))
  ];
  const rooms = board.rooms.map((entry) => ({ ...entry, panes: entry.panes.filter((pane) => matches(pane, filter)) }));
  const shown = rooms.filter((entry) => (room === "ALL" || entry.roomId === room) && entry.panes.length);
  const refresh = async () => {
    setRefreshing(true);
    try { await api.refreshNousPaneBoard(); } catch (err) { setError(messageOf(err, "The refresh could not start.")); } finally { setRefreshing(false); }
  };

  return (
    <div className="nous-pane-board">
      <div className="nous-pane-board-tools">
        <DockChips label="Waits on" value={filter} onChange={setFilter} options={filters} />
        <DockIconButton label="Refresh the summaries" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()} />
      </div>
      {board.rooms.length > 1 ? (
        <DockChips className="nous-pane-board-rooms" label="Rooms" value={room} onChange={setRoom}
          options={[{ id: "ALL", label: "All rooms" }, ...rooms.filter((entry) => entry.panes.length || entry.roomId === room).map((entry) => ({ id: entry.roomId, label: entry.name, count: entry.panes.length }))]} />
      ) : null}
      {board.paused ? <p className="nous-muted nous-pane-board-paused" role="status">{PAUSED_LABELS[board.paused]}</p> : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {!shown.length ? <DockState kind="empty" icon={Nous} title={filter === "NEEDS_ME" ? "Nothing needs you" : "No panes here"} /> : null}
      {shown.map((entry) => {
        const open = !collapsed.has(entry.roomId);
        const mine = entry.panes.filter(needsMe).length;
        return (
          <section key={entry.roomId} className="nous-board-room" aria-label={`Room ${entry.name}`}>
            <button type="button" className="nous-board-room-head" aria-expanded={open}
              onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(entry.roomId)) next.delete(entry.roomId); else next.add(entry.roomId); return next; })}>
              {/* Wrapped: the shell paints expanded buttons with a direct icon child as active toggles. */}
              <span className="nous-board-room-chevron" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
              <strong>{entry.name}</strong>
              <span className="nous-board-count">{entry.panes.length}</span>
              {mine ? <span className="nous-board-count is-attention" title="Panes that need you">{mine}</span> : null}
            </button>
            {open ? (
              <ol className="nous-board-panes">
                {entry.panes.map((pane) => (
                  <BoardPaneRow key={pane.paneId} pane={pane} roomName={entry.name} check={checks.get(pane.paneId) ?? null}
                    decisions={pane.decisionIds.flatMap((id) => decisionById.get(id) ?? [])} renderDecision={renderDecision}
                    onSent={() => { void load(); onSent?.(); }} />
                ))}
              </ol>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function BoardPaneRow({ pane, roomName, check, decisions, renderDecision, onSent }: {
  pane: NousPaneBoardPane; roomName: string; check: PaneCheck | null; decisions: NousDecision[]; renderDecision(decision: NousDecision): ReactNode; onSent(): void;
}) {
  const Icon = modeIcons[pane.mode as keyof typeof modeIcons] ?? Terminal;
  const questions = pane.copilotItems.filter((item) => item.kind === "QUESTION");
  const targets: Array<{ id: string; label: string; target: Target }> = [
    ...(pane.prompt ? [{ id: "PROMPT", label: "Prompt", target: { kind: "PROMPT" } as Target }] : []),
    ...questions.map((item, index) => ({ id: `Q:${item.id}`, label: questions.length > 1 ? `Question ${index + 1}` : "Question",
      target: { kind: "COPILOT_QUESTION", copilot: item.copilot, questionId: item.id } as Target })),
    { id: "NOUS", label: "Nous", target: { kind: "NOUS" } }
  ];
  const [targetId, setTargetId] = useState(targets[0]!.id);
  const target = targets.find((entry) => entry.id === targetId) ?? targets[0]!;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const resultTimer = useRef<number | null>(null);
  useEffect(() => () => { if (resultTimer.current !== null) window.clearTimeout(resultTimer.current); }, []);
  const goTo = () => requestNousFocus({ roomId: pane.roomId, paneId: pane.paneId, ownerUserId: null, immediate: true });

  const send = async (text: string, chosen: Target) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const answer = await api.answerNousPane(pane.paneId, { text: text.trim(), target: chosen });
      setDraft("");
      setResult({ tone: "success", text: answer.display });
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current);
      resultTimer.current = window.setTimeout(() => setResult(null), 8_000);
      onSent();
    } catch (err) {
      setResult({ tone: "error", text: messageOf(err, "Your reply could not be sent.") });
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(draft, target.target); };
  const summary = pane.summary;
  const cards = [...pane.notifications].sort((a, b) => Number(b.card) - Number(a.card));

  return (
    <li className={`nous-board-pane is-${pane.state}${needsMe(pane) ? " needs-me" : ""}`} aria-label={`${pane.name} in ${roomName}`}>
      <div className="nous-board-pane-head">
        <Icon className="nous-board-pane-icon" aria-hidden="true" />
        <strong className="nous-board-pane-name">{pane.name}</strong>
        <span className={`nous-board-state is-${pane.state}`}>{STATE_LABELS[pane.state] ?? pane.state}</span>
        {pane.model ? <span className="nous-muted nous-board-model">{pane.model}</span> : null}
        {pane.plan ? <span className="nous-board-pane-plan" title={pane.plan.nextStep ? `Next: ${pane.plan.nextStep}` : pane.plan.title}>{pane.plan.title} · {pane.plan.progress}%</span> : null}
        <DockButton className="nous-board-go" onClick={goTo}>Go to pane</DockButton>
      </div>
      <p className="nous-board-line">
        <span className={`nous-waits is-${summary.waitsOn.toLowerCase()}`} title="Waits on">{WAITS_LABELS[summary.waitsOn]}{summary.until ? ` · ${formatUserTime(summary.until)}` : ""}</span>
        <span className="nous-board-line-text">{summary.line}</span>
        <span className="nous-muted nous-board-line-time" title={summary.source === "MODEL" ? `Summary by ${summary.model ?? "the summary model"}` : "Space's own line from the newest report"}>
          {formatUserTime(summary.generatedAt)}{summary.source === "FALLBACK" ? " · Space" : ""}
        </span>
      </p>
      {summary.detail ? <p className="nous-muted nous-board-detail">{summary.detail}</p> : null}
      {check ? (
        <p className="nous-muted nous-board-check">
          <span>{check.checkedAt ? `Nous checked ${formatUserTime(check.checkedAt)}` : "Nous never checked it"}{check.verdict ? ` · ${VERDICTS[check.verdict] ?? check.verdict}` : ""}{check.note ? `: ${check.note}` : ""}</span>
          {check.verdict === "OPERATOR_TEST" ? <span className="nous-pane-badge">Keep open</span> : null}
          <span className={check.overdue ? "is-overdue" : undefined}>{check.overdue ? "Due now" : `Next ${formatUserTime(check.nextCheckAt ?? check.dueAt)}`}</span>
        </p>
      ) : null}
      {cards.length || decisions.length || pane.copilotItems.length ? (
        <ul className="nous-board-items">
          {cards.map((item) => (
            <li key={item.id}>
              <button type="button" className={`nous-board-item${item.card ? " is-card" : ""}`} onClick={goTo} title={item.body || item.title}>
                <strong>{item.card ? "For you" : item.source.toLowerCase().replace(/_/g, " ")}</strong> {item.title}
                {item.card && item.body ? <span className="nous-board-item-body">{item.body}</span> : null}
              </button>
            </li>
          ))}
          {pane.copilotItems.map((item) => (
            <li key={`${item.copilot}:${item.id}`} className="nous-board-item">
              <strong>{item.kind === "QUESTION" ? "Question" : item.kind.toLowerCase().replace(/_/g, " ")}</strong> {item.title}
              {item.detail ? <span className="nous-board-item-body">{item.detail}</span> : null}
              {item.kind === "QUESTION" ? <DockButton onClick={() => setTargetId(`Q:${item.id}`)}>Answer</DockButton>
                : <DockButton onClick={goTo}>Review in the pane</DockButton>}
            </li>
          ))}
          {decisions.map((decision) => <li key={decision.id} className="nous-board-decision">{renderDecision(decision)}</li>)}
        </ul>
      ) : null}
      {pane.prompt ? (
        <div className="nous-board-prompt" role="group" aria-label={`${pane.name} asks`}>
          <span className="nous-board-prompt-question">{pane.prompt.question}</span>
          {pane.prompt.options.map((option) => (
            <DockButton key={option.key} disabled={busy} onClick={() => void send(option.key, { kind: "PROMPT" })}>{option.key}. {option.label}</DockButton>
          ))}
        </div>
      ) : null}
      {pane.state === "closed" ? null : <form className="nous-board-reply" onSubmit={submit}>
        {targets.length > 1 ? <DockChips label={`Reply to ${pane.name} as`} value={target.id} onChange={setTargetId} options={targets.map(({ id, label }) => ({ id, label }))} /> : null}
        <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2_000} aria-label={`Reply about ${pane.name}`}
          placeholder={target.target.kind === "PROMPT" ? "Answer the prompt" : target.target.kind === "COPILOT_QUESTION" ? "Answer the question" : "Tell Nous what to do here"} />
        <DockIconButton label="Send reply" icon={Send} type="submit" busy={busy} disabled={!draft.trim() || busy} />
      </form>}
      {result ? <p className={`nous-board-result is-${result.tone}`} role={result.tone === "error" ? "alert" : "status"}>{result.text}</p> : null}
    </li>
  );
}
