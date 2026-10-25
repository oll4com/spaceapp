import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { CouncilModel, CouncilModelsResponse, CouncilRun, CouncilRunSummary, NotificationSettings } from "@space/contracts";
import { COUNCIL_MAX_MEMBERS, COUNCIL_MAX_REVIEW_ROUNDS, COUNCIL_MAX_TOTAL_ROUNDS, notificationChannelEnabled, resolveNotificationSettings } from "@space/contracts";
import { api } from "../../api.js";
import { ChatCopyButton, ChatMarkdown, safeChatUrl } from "../agent-pane/ChatMarkdown.js";
import { notifyClipboardUpdated } from "../clipboard-dock/clipboard-events.js";
import { DockButton, DockIconButton, DockNotice, DockState, DockToolbar, useDockConfirm } from "../dock-kit/DockKit.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import { desktopNotificationsEnabled, desktopNotificationsSupported, setDesktopNotifications } from "../notifications/desktop-notifications.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { ArrowLeft, CircleStop, ClipboardList, MessagesSquare, Play, RotateCcw, Send, SlidersHorizontal, Trash2 } from "../ui-theme/app-icons.js";
import "./council.css";

const POLL_MS = 2_000;
const WORKING: readonly CouncilRun["status"][] = ["PLANNING", "RUNNING"];
/** Working runs, and finished ones whose coordinator is writing a plan into the clipboard, are polled. */
const isWorking = (run: CouncilRun) => WORKING.includes(run.status) || run.clipboardPlan?.status === "WRITING";
const STEPS: Array<{ stage: CouncilRun["stage"]; label: string }> = [
  { stage: "PLAN", label: "Plan" }, { stage: "RESEARCH", label: "Research" }, { stage: "ANSWERS", label: "Answers" },
  { stage: "MERGE", label: "Merge" }, { stage: "REVIEW", label: "Review" }, { stage: "FINAL", label: "Final" }
];
const STATUS_LABELS: Record<CouncilRun["status"], string> = {
  PLANNING: "Planning", NEEDS_INPUT: "Needs your answers", AWAITING_APPROVAL: "Waiting for your approval", RUNNING: "Working",
  COMPLETED: "Done", FAILED: "Failed", INTERRUPTED: "Stopped", CANCELLED: "Cancelled"
};

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** The Research Council: one question, several models, an anonymous merge, a scored review and an agreed Top 3. */
export function CouncilDock({ canRun = false }: { canRun?: boolean }) {
  const isActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [catalog, setCatalog] = useState<CouncilModelsResponse | null>(null);
  const [runs, setRuns] = useState<CouncilRunSummary[] | null>(null);
  const [run, setRun] = useState<CouncilRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshList = useCallback(async () => {
    const [models, list] = await Promise.all([api.councilModels(), api.councilRuns()]);
    setCatalog(models);
    setRuns(list.runs);
    return list.runs;
  }, []);

  // First open: the catalog, the history, and the run still waiting for you (if any).
  useEffect(() => {
    if (!isActive || !canRun || runs !== null) return;
    void refreshList().then(async (list) => {
      const open = list.find((item) => item.status !== "COMPLETED" && item.status !== "CANCELLED" && item.status !== "FAILED");
      if (open) setRun((await api.councilRun(open.id)).run);
    }).catch((err: unknown) => setError(messageOf(err, "The Council could not be loaded.")));
  }, [isActive, canRun, runs, refreshList]);

  // shortcut: polling, upgrade to an SSE stream like room-agent if runs get many viewers.
  const runId = run?.id ?? null;
  const working = run ? isWorking(run) : false;
  useEffect(() => {
    if (!isActive || !runId || !working) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const next = (await api.councilRun(runId)).run;
        if (cancelled) return;
        setRun(next);
        if (!isWorking(next)) { void refreshList().catch(() => undefined); return; }
      } catch (err) {
        if (!cancelled) setError(messageOf(err, "The run could not be refreshed."));
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [isActive, runId, working, refreshList]);

  // An open Clipboard dock reloads once the coordinator saved a plan into it.
  const planItemId = run?.clipboardPlan?.itemId ?? null;
  useEffect(() => { if (planItemId) notifyClipboardUpdated(); }, [planItemId]);

  const act = useCallback(async (work: () => Promise<{ run: CouncilRun } | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result) setRun(result.run);
    } catch (err) {
      setError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!canRun) {
    return (
      <section className="dock-panel council-dock" aria-label="Council">
        <DockState kind="empty" icon={MessagesSquare} title="The Council is available to administrators and operators" />
      </section>
    );
  }

  const models = catalog?.models ?? [];
  return (
    <section className="dock-panel council-dock" aria-label="Council">
      <DockToolbar
        className="council-toolbar"
        summary={run ? <>Coordinated by <strong>{nameOf(models, run.coordinatorModelId)}</strong> · {STATUS_LABELS[run.status]}</> : "Several models answer, review each other and agree on a Top 3."}
      >
        {run ? <DockIconButton label="New question" icon={ArrowLeft} onClick={() => { setRun(null); setError(null); void refreshList().catch(() => undefined); }} /> : null}
        <DockIconButton label="Council settings" icon={SlidersHorizontal} aria-expanded={settingsOpen} aria-controls="council-settings"
          className={settingsOpen ? "is-active" : undefined} onClick={() => setSettingsOpen((open) => !open)} />
      </DockToolbar>
      {settingsOpen ? <CouncilSettings /> : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {run ? (
        <RunView run={run} models={models} busy={busy} act={act} confirm={confirm} />
      ) : (
        <HomeView catalog={catalog} runs={runs} busy={busy}
          onAsk={(question, coordinatorModelId) => act(() => api.createCouncilRun({ question, coordinatorModelId }), "The Council could not start.")}
          onOpen={(id) => act(() => api.councilRun(id), "The run could not be opened.")}
          onDelete={async (id) => {
            if (!(await confirm({ title: "Delete this run?", message: "Its answers, reviews and final answer are removed.", confirmLabel: "Delete" }))) return;
            await act(async () => { await api.deleteCouncilRun(id); await refreshList(); }, "The run could not be deleted.");
          }} />
      )}
      {confirmDialog}
    </section>
  );
}

/** Like the Room Agent's settings: the Council's notifications (Settings → Notifications → Per source) and this device's desktop alerts. */
function CouncilSettings() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [desktop, setDesktop] = useState(desktopNotificationsEnabled);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setSettings(resolveNotificationSettings(user.notifications)); })
      .catch((err: unknown) => { if (!cancelled) setError(messageOf(err, "Notification settings could not be loaded.")); });
    return () => { cancelled = true; };
  }, []);
  const notify = (on: boolean) => {
    if (!settings) return;
    // On follows your channels (desktop, Telegram); off silences the Council everywhere.
    const next = { ...settings, perSource: { ...settings.perSource, COUNCIL: on ? { inApp: true } : { inApp: false, desktop: false, telegram: false } } };
    setSettings(next);
    setError(null);
    void api.updateUserSettings({ notifications: next }).catch((err: unknown) => { setSettings(settings); setError(messageOf(err, "Notification settings could not be saved.")); });
  };
  return (
    <div className="council-section council-settings" id="council-settings" role="group" aria-label="Council settings">
      <SpaceToggle compact className="council-setting" label="Notifications" detail="Tell me when the council needs my answers or approval, and when a run finishes or fails."
        ariaLabel="Council notifications" checked={settings ? notificationChannelEnabled(settings, "COUNCIL", "inApp") : false} disabled={!settings} onChange={notify} />
      {desktopNotificationsSupported() ? (
        <SpaceToggle compact className="council-setting" label="Desktop alerts" detail="Show them while Space is in the background."
          ariaLabel="Desktop notifications" checked={desktop} onChange={(enabled) => void setDesktopNotifications(enabled).then(setDesktop)} />
      ) : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </div>
  );
}

function nameOf(models: readonly CouncilModel[], id: string): string {
  return models.find((model) => model.id === id)?.displayName ?? id.slice(id.indexOf("/") + 1);
}

function HomeView({ catalog, runs, busy, onAsk, onOpen, onDelete }: {
  catalog: CouncilModelsResponse | null;
  runs: CouncilRunSummary[] | null;
  busy: boolean;
  onAsk(question: string, coordinatorModelId: string | undefined): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
}) {
  const [question, setQuestion] = useState("");
  const [coordinator, setCoordinator] = useState<string>("");
  const available = (catalog?.models ?? []).filter((model) => model.available);
  const defaultAvailable = available.some((model) => model.id === catalog?.coordinatorDefault);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (question.trim().length >= 3 && !busy) onAsk(question.trim(), coordinator || undefined);
  };
  return (
    <>
      <form className="council-ask" onSubmit={submit}>
        <label htmlFor="council-question" className="sr-only">Your question</label>
        <textarea id="council-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={2_000}
          placeholder="Ask a research question… e.g. How can I make 100 euros in one day?"
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit(event); }} />
        <div className="council-ask-row">
          <label className="council-select">
            <span>Coordinator</span>
            <select value={coordinator} onChange={(event) => setCoordinator(event.target.value)} disabled={!catalog}>
              <option value="">{defaultAvailable ? `${nameOfCatalog(catalog, catalog!.coordinatorDefault)} (default)` : "Best available"}</option>
              {available.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
          </label>
          <DockButton type="submit" tone="primary" icon={Send} busy={busy} disabled={busy || question.trim().length < 3 || !catalog}>Ask the council</DockButton>
        </div>
        {catalog && !catalog.webSearch ? <small className="council-muted">Web search is unavailable here; the models answer from what they know.</small> : null}
      </form>
      <div className="council-history">
        <h3>Recent questions</h3>
        {runs === null ? <DockState kind="loading" title="Loading…" /> : runs.length === 0 ? (
          <p className="council-muted">No questions yet. The coordinator plans first and waits for your approval before any model answers.</p>
        ) : (
          <ul>
            {runs.map((item) => (
              <li key={item.id}>
                <button type="button" className="council-history-item" title={item.question} onClick={() => onOpen(item.id)}>
                  <span data-sensitive-masked="manual">{item.question}</span>
                  <small className={`council-status is-${item.status.toLowerCase()}`}>{STATUS_LABELS[item.status]}</small>
                </button>
                <DockIconButton label="Delete run" icon={Trash2} tone="danger" onClick={() => onDelete(item.id)} disabled={busy} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function nameOfCatalog(catalog: CouncilModelsResponse | null, id: string) {
  return nameOf(catalog?.models ?? [], id);
}

type Act = (work: () => Promise<{ run: CouncilRun } | void>, fallback: string) => Promise<void>;
type Confirm = ReturnType<typeof useDockConfirm>["confirm"];

function RunView({ run, models, busy, act, confirm }: { run: CouncilRun; models: CouncilModel[]; busy: boolean; act: Act; confirm: Confirm }) {
  const stepIndex = STEPS.findIndex((step) => step.stage === run.stage);
  const cancel = async () => {
    if (await confirm({ title: "Cancel this run?", message: "Nothing more is asked of the models. You can still read what is done.", confirmLabel: "Cancel run" })) {
      await act(() => api.councilRunAction(run.id, "cancel"), "The run could not be cancelled.");
    }
  };
  return (
    <div className="council-run">
      <h3 className="council-question" data-sensitive-masked="manual">{run.question}</h3>
      <ol className="council-steps" aria-label="Progress">
        {STEPS.map((step, index) => (
          <li key={step.stage} className={run.stage === "DONE" || index < stepIndex ? "is-done" : index === stepIndex ? "is-current" : undefined}>
            {step.label}{step.stage === "REVIEW" && run.rounds.length > 1 ? ` ${run.rounds.length}` : ""}
          </li>
        ))}
      </ol>

      {run.status === "PLANNING" ? <DockState kind="loading" title={`${nameOf(models, run.coordinatorModelId)} is preparing the plan…`} /> : null}
      {run.status === "NEEDS_INPUT" ? <QuestionsForm run={run} busy={busy} act={act} onCancel={cancel} /> : null}
      {run.status === "AWAITING_APPROVAL" && run.plan ? <PlanReview run={run} models={models} busy={busy} act={act} onCancel={cancel} /> : null}
      {run.status === "RUNNING" ? (
        <div className="council-working">
          <DockState kind="loading" title={run.events.at(-1)?.text ?? "Working…"} />
          <MemberChips run={run} models={models} />
          <DockButton icon={CircleStop} onClick={() => void act(() => api.councilRunAction(run.id, "stop"), "The run could not be stopped.")} disabled={busy}>Stop</DockButton>
        </div>
      ) : null}
      {run.status === "INTERRUPTED" || run.status === "FAILED" ? (
        <div className="council-working">
          <DockNotice tone={run.status === "FAILED" ? "error" : "warning"}>{run.error ?? STATUS_LABELS[run.status]}</DockNotice>
          <div className="council-actions">
            <DockButton tone="primary" icon={Play} busy={busy} disabled={busy} onClick={() => void act(() => api.councilRunAction(run.id, "resume"), "The run could not resume.")}>Resume</DockButton>
            <DockButton tone="ghost" onClick={() => void cancel()} disabled={busy}>Cancel run</DockButton>
          </div>
        </div>
      ) : null}
      {run.status === "CANCELLED" ? <DockNotice tone="info">This run was cancelled.</DockNotice> : null}
      {run.status !== "RUNNING" && run.answers.length ? <div className="council-field"><span>Models</span><MemberChips run={run} models={models} /></div> : null}
      {run.status === "COMPLETED" && run.final ? <FinalView run={run} busy={busy} act={act} /> : null}
      {run.status !== "PLANNING" && run.status !== "NEEDS_INPUT" && run.status !== "AWAITING_APPROVAL" ? <Details run={run} models={models} /> : null}
      <details className="council-section">
        <summary>Activity ({run.events.length})</summary>
        <ol className="council-events">
          {run.events.slice(-40).map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> {event.text}</li>)}
        </ol>
      </details>
    </div>
  );
}

function QuestionsForm({ run, busy, act, onCancel }: { run: CouncilRun; busy: boolean; act: Act; onCancel(): void }) {
  const round = run.qa.at(-1)!;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form className="council-section council-form" onSubmit={(event) => {
      event.preventDefault();
      void act(() => api.councilRunAction(run.id, "answers", { answers }), "Your answers could not be sent.");
    }}>
      <p className="council-muted">The coordinator needs a few facts before it plans. Leave a field empty to skip it.</p>
      {round.questions.map((question) => (
        <label key={question.id} className="council-field">
          <span>{question.text}</span>
          <textarea rows={2} maxLength={2_000} value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
        </label>
      ))}
      <div className="council-actions">
        <DockButton type="submit" tone="primary" icon={Send} busy={busy} disabled={busy}>Send answers</DockButton>
        <DockButton tone="ghost" onClick={onCancel} disabled={busy}>Cancel run</DockButton>
      </div>
    </form>
  );
}

function PlanReview({ run, models, busy, act, onCancel }: { run: CouncilRun; models: CouncilModel[]; busy: boolean; act: Act; onCancel(): void }) {
  const plan = run.plan!;
  const [members, setMembers] = useState<string[]>(() => plan.members.map((member) => member.modelId));
  const [context, setContext] = useState(plan.personalContext);
  const [rounds, setRounds] = useState(plan.reviewRounds);
  const [changes, setChanges] = useState("");
  const [changing, setChanging] = useState(false);
  const available = models.filter((model) => model.available);
  const extra = available.filter((model) => !members.includes(model.id));
  const providers = useMemo(() => [...new Set(members.map((id) => models.find((model) => model.id === id)?.providerId ?? id.split("/")[0]))].join(", "), [members, models]);
  const reasons = new Map(plan.members.map((member) => [member.modelId, member.reason]));
  return (
    <div className="council-section council-plan">
      <h4>The coordinator's plan</h4>
      <p>{plan.understanding}</p>

      <label className="council-field">
        <span>What will be shared about you</span>
        <textarea rows={4} maxLength={2_500} value={context} onChange={(event) => setContext(event.target.value)} />
        <small className="council-muted">Sent to: {providers || "no provider"}. Edit or remove anything before you approve.</small>
      </label>

      <div className="council-field">
        <span>Models ({members.length} of at most {COUNCIL_MAX_MEMBERS})</span>
        <div className="council-chips">
          {members.map((id) => (
            <button key={id} type="button" className="council-chip is-on" aria-pressed="true" title={reasons.get(id) || "Remove from the council"}
              disabled={members.length <= 2} onClick={() => setMembers(members.filter((member) => member !== id))}>
              {nameOf(models, id)} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
        {extra.length && members.length < COUNCIL_MAX_MEMBERS ? (
          <select aria-label="Add a model" value="" onChange={(event) => event.target.value && setMembers([...members, event.target.value])}>
            <option value="">Add a model…</option>
            {extra.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        ) : null}
        {models.some((model) => !model.available) ? <small className="council-muted">{models.filter((model) => !model.available).length} models are unavailable on this instance.</small> : null}
      </div>

      <div className="council-field">
        <span>Review rounds</span>
        <div className="council-chips" role="group" aria-label="Review rounds">
          {Array.from({ length: COUNCIL_MAX_REVIEW_ROUNDS }, (_, index) => index + 1).map((count) => (
            <button key={count} type="button" className={`council-chip${rounds === count ? " is-on" : ""}`} aria-pressed={rounds === count} onClick={() => setRounds(count)}>{count}</button>
          ))}
        </div>
      </div>

      <dl className="council-facts">
        <dt>Scored on</dt><dd>{plan.criteria.map((criterion) => criterion.label).join(" · ")}</dd>
        <dt>Web searches</dt><dd>{plan.searchQueries.length ? plan.searchQueries.join(" · ") : "None"}</dd>
        {run.estimate ? <><dt>Estimate</dt><dd>About {run.estimate.calls} model calls, about {run.estimate.minutes} minutes</dd></> : null}
      </dl>

      {changing ? (
        <label className="council-field">
          <span>What should change?</span>
          <textarea rows={2} maxLength={2_000} value={changes} onChange={(event) => setChanges(event.target.value)} autoFocus />
        </label>
      ) : null}
      <div className="council-actions">
        {changing ? (
          <DockButton tone="primary" icon={Send} busy={busy} disabled={busy || !changes.trim()}
            onClick={() => void act(() => api.councilRunAction(run.id, "changes", { text: changes.trim() }), "Your changes could not be sent.")}>Send changes</DockButton>
        ) : (
          <DockButton tone="primary" icon={Play} busy={busy} disabled={busy || members.length < 2}
            onClick={() => void act(() => api.councilRunAction(run.id, "approve", { members, personalContext: context, reviewRounds: rounds }), "The plan could not be approved.")}>Approve & run</DockButton>
        )}
        <DockButton tone="ghost" onClick={() => setChanging(!changing)} disabled={busy}>{changing ? "Back" : "Request changes"}</DockButton>
        <DockButton tone="ghost" onClick={onCancel} disabled={busy}>Cancel</DockButton>
      </div>
    </div>
  );
}

function MemberChips({ run, models }: { run: CouncilRun; models: CouncilModel[] }) {
  const round = run.rounds.at(-1);
  const running = run.status === "RUNNING";
  const reviewing = running && run.stage === "REVIEW" && round;
  const items = reviewing
    ? round.reviews.map((review) => ({ id: review.modelId, status: review.status, error: review.error }))
    : run.answers.map((answer) => ({ id: answer.modelId, status: answer.status, error: answer.error }));
  if (!items.length) return null;
  return (
    <ul className="council-members" aria-label={reviewing ? "Reviews" : running ? "Answers" : "Models"}>
      {items.map((item) => (
        <li key={item.id} className={`is-${item.status.toLowerCase()}`} title={item.error ?? undefined}>
          {nameOf(models, item.id)} {running || item.status !== "DONE" ? <small>{item.status === "PENDING" ? (reviewing ? "reviewing" : "answering") : item.status === "DONE" ? "done" : "failed"}</small> : null}
        </li>
      ))}
    </ul>
  );
}

function FinalView({ run, busy, act }: { run: CouncilRun; busy: boolean; act: Act }) {
  const final = run.final!;
  const plan = run.clipboardPlan ?? null;
  const writing = plan?.status === "WRITING";
  return (
    <div className="council-section council-final">
      <ol className="council-top" aria-label="Top 3">
        {final.top.map((entry, index) => (
          <li key={entry.positionId}>
            <span className="council-rank">{index + 1}</span>
            <strong>{entry.title}</strong>
            <small>{entry.mean.toFixed(1)}/10 · {entry.agree} of {entry.reviewers} agree</small>
          </li>
        ))}
      </ol>
      {final.top.length < 3 ? (
        <p className="council-muted">{final.top.some((entry) => entry.reviewers > 0 && entry.agree * 3 >= entry.reviewers * 2)
          ? `The council agreed on ${final.top.length} ${final.top.length === 1 ? "answer" : "answers"}; weaker options are listed in the answer.`
          : "No answer reached agreement; this is the best scored one."}</p>
      ) : null}
      <div className="council-answer" data-sensitive-masked="manual"><ChatMarkdown content={final.text} /></div>
      <div className="council-actions">
        <ChatCopyButton text={final.text} label="Copy" />
        {run.rounds.length < COUNCIL_MAX_TOTAL_ROUNDS ? (
          <DockButton icon={RotateCcw} busy={busy} disabled={busy || writing} onClick={() => void act(() => api.councilRunAction(run.id, "another-round"), "Another round could not start.")}>Another review round</DockButton>
        ) : null}
        <DockButton icon={ClipboardList} busy={writing} disabled={busy || writing} title="The coordinator turns this answer into a step-by-step plan in your clipboard"
          onClick={() => void act(() => api.councilRunAction(run.id, "clipboard-plan"), "The plan could not be started.")}>{writing ? "Writing the plan…" : "Create plan"}</DockButton>
      </div>
      {plan?.status === "DONE" ? <DockNotice tone="success">Saved to your clipboard as a plan: <strong>{plan.title}</strong></DockNotice> : null}
      {plan?.status === "FAILED" ? <DockNotice tone="error">The plan could not be written: {plan.error}</DockNotice> : null}
    </div>
  );
}

function Details({ run, models }: { run: CouncilRun; models: CouncilModel[] }) {
  if (!run.answers.length && !run.evidence.length) return null;
  return (
    <details className="council-section council-details">
      <summary>Details: who said what</summary>
      {run.plan ? <p className="council-muted">Shared about you: {run.plan.personalContext || "nothing"}</p> : null}
      {run.evidence.length ? (
        <>
          <h5>Sources</h5>
          <ul className="council-sources">
            {run.evidence.map((item) => {
              const href = safeChatUrl(item.url);
              return <li key={item.url}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{item.title || item.url}</a> : item.title} — {item.finding}</li>;
            })}
          </ul>
        </>
      ) : null}
      <h5>Independent answers</h5>
      {run.answers.map((answer) => (
        <details key={answer.modelId} className="council-answer-item" data-sensitive-masked="manual">
          <summary>{nameOf(models, answer.modelId)} <small>{answer.status === "DONE" ? `${Math.round((answer.ms ?? 0) / 1000)} s` : answer.status.toLowerCase()}</small></summary>
          {answer.status === "DONE" ? <ChatMarkdown content={answer.text} /> : <p className="council-muted">{answer.error ?? "No answer."}</p>}
        </details>
      ))}
      {run.rounds.map((round) => (
        <details key={round.round} className="council-answer-item" data-sensitive-masked="manual">
          <summary>Round {round.round}: merged answer and scores</summary>
          <ChatMarkdown content={round.merged} />
          <div className="council-table-wrap">
            <table className="council-table">
              <thead><tr><th scope="col">Position</th>{round.reviews.map((review) => <th key={review.modelId} scope="col">{nameOf(models, review.modelId)}</th>)}<th scope="col">Mean</th></tr></thead>
              <tbody>
                {round.ranking.map((entry) => (
                  <tr key={entry.positionId}>
                    <th scope="row">{round.positions.find((position) => position.id === entry.positionId)?.title ?? entry.positionId}</th>
                    {round.reviews.map((review) => <td key={review.modelId}>{review.scores.find((score) => score.positionId === entry.positionId)?.score ?? "–"}</td>)}
                    <td>{entry.mean.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </details>
  );
}
