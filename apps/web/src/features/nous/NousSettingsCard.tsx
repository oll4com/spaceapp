import { useEffect, useState } from "react";
import {
  NOUS_EFFORTS, NOUS_FALLBACK_MODELS, NOUS_LOW_SPEND_KINDS, NOUS_MODELS, NOUS_TURN_KINDS, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousGoalsSettingsSchema, nousStandingOrdersSettingsSchema,
  type NousAway, type NousAwayGrant, type NousLowSpendSettings, type NousModelChoice, type NousModelsSettings, type NousPaneBoardSettings, type NousSettings, type NousGoalsSettings, type NousStandingOrdersSettings, type NousTurnKind
} from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockNotice } from "../dock-kit/DockKit.js";
import { readNousFocusEnabled, writeNousFocusEnabled } from "../nous-focus/nous-focus-events.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

/** Nous's switches, only in Settings → Assistants & AI → Nous (the dock keeps just the On/Off one); the last one is kept on this device. */
export function NousSettingsToggles({ settings, onChange, className }: {
  settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className?: string;
}) {
  const [focusEnabled, setFocusEnabled] = useState(readNousFocusEnabled);
  return (
    <>
      <SpaceToggle className={className} label="Work on my behalf" ariaLabel="Nous works on my behalf"
        detail="Nous answers panes and copilots in every room, moves the plans on and holds your notifications. Releases, irreversible actions and anything to third parties still come to you."
        checked={Boolean(settings?.enabled)} disabled={!settings} onChange={(enabled) => onChange({ enabled })} />
      <SpaceToggle className={className} label="May promote dev to stable" ariaLabel="Nous may promote dev to stable"
        detail="Nous batches finished work and promotes dev to stable without asking you. Hotfixes, npm releases and queue control stay yours."
        checked={Boolean(settings?.mayPromote)} disabled={!settings} onChange={(mayPromote) => onChange({ mayPromote })} />
      <SpaceToggle className={className} label="May approve Warm changes" ariaLabel="Nous may approve Warm changes"
        detail="Nous approves changes to the protected Warm code after reading them; the tests and the real-browser performance check stay required."
        checked={Boolean(settings?.mayApproveWarm)} disabled={!settings} onChange={(mayApproveWarm) => onChange({ mayApproveWarm })} />
      <SpaceToggle className={className} label="May approve security hotfixes" ariaLabel="Nous may approve security hotfixes"
        detail="The Security Copilot's hotfix for an exploited or critical finding goes to stable without asking you. Other hotfixes, promotes and releases stay yours."
        checked={Boolean(settings?.maySecurityHotfix)} disabled={!settings} onChange={(maySecurityHotfix) => onChange({ maySecurityHotfix })} />
      <SpaceToggle className={className} label="Shell" ariaLabel="Nous may use a shell"
        detail="Nous runs commands itself as your CLI user, like a pane, never with sudo. Off: it asks a pane to run them."
        checked={Boolean(settings?.shell)} disabled={!settings} onChange={(shell) => onChange({ shell })} />
      <SpaceToggle className={className} label="Copilot questions go to Nous first" ariaLabel="Copilot questions go to Nous first"
        detail="A copilot's question waits up to an hour for Nous, which answers what it can find itself; the rest comes to you on the pane's card, at once when Nous is off or paused."
        checked={settings?.copilotQuestionsNousFirst ?? true} disabled={!settings} onChange={(copilotQuestionsNousFirst) => onChange({ copilotQuestionsNousFirst })} />
      <SpaceToggle className={className} label="Talk to Nous from Telegram" ariaLabel="Nous takes messages from the paired Telegram chat"
        detail="Write to Nous from your paired Telegram chat and get its answer there; its decisions arrive with Approve and Decline buttons. Only the paired chat; the same rules as the dock."
        checked={Boolean(settings?.telegramInbound)} disabled={!settings} onChange={(telegramInbound) => onChange({ telegramInbound })} />
      <SpaceToggle className={className} label="Bring me to panes that need me" ariaLabel="Nous brings me to panes that need me"
        detail="When any pane needs you (a CLI, a copilot, a browser handoff, Nous), Space offers to switch to it (Go now / Not now, by itself after 5 s when you are free), maximizes it, focuses what needs you and brings you back when it is done. On this device."
        checked={focusEnabled} onChange={(enabled) => { writeNousFocusEnabled(enabled); setFocusEnabled(enabled); }} />
    </>
  );
}

const AWAY_GRANTS: Array<{ grant: NousAwayGrant; label: string; detail: string }> = [
  { grant: "PROMOTE", label: "While away: may promote dev to stable", detail: "Only right after live:verify:dev passes. Hotfixes, npm and GitHub releases stay yours." },
  { grant: "TEST_PANES", label: "While away: may restart or close my test panes", detail: "Only the panes you opened for your own tests." }
];

/**
 * Away mode (plan clipboard:B7eTUHTJYg3X): while you are away Nous keeps working, writes to its away log instead of the chat,
 * holds its alerts for one summary and briefs you on return. Publishing, payments, deletes, sends to third parties, Warm code and
 * host restarts always wait for you; the grant only widens here.
 */
function NousAwayToggles({ away, onChange, className }: { away: NousAway | null | undefined; onChange(input: { away: boolean; grant?: NousAwayGrant[] }): void; className?: string }) {
  const on = Boolean(away);
  const grant = away?.grant ?? [];
  return (
    <>
      <SpaceToggle className={className} label={away ? `Away since ${formatUserTime(away.startedAt)}` : "Away"} ariaLabel="Nous Away mode"
        detail="Nous keeps working while you are away: no chat replies, alerts held for one summary, a briefing when you write again. Your next message ends it."
        checked={on} disabled={away === undefined} onChange={(next) => onChange({ away: next })} />
      {on ? AWAY_GRANTS.map((item) => (
        <SpaceToggle key={item.grant} className={className} label={item.label} ariaLabel={`Nous Away grant ${item.grant}`} detail={item.detail}
          checked={grant.includes(item.grant)}
          onChange={(next) => onChange({ away: true, grant: next ? [...grant, item.grant] : grant.filter((entry) => entry !== item.grant) })} />
      )) : null}
    </>
  );
}

const PANE_BOARD_MODELS: Array<{ id: NousPaneBoardSettings["model"]; label: string }> = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }
];

/** A whole number saved when the field is left (or Enter), clamped to its range. */
function PaneBoardNumber({ label, detail, value, min, max, onSave }: { label: string; detail: string; value: number; min: number; max: number; onSave(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    const next = Number.isFinite(parsed) && draft.trim() ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy"><strong>{label}</strong><small>{detail}</small></span>
      <input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft} aria-label={label}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    </label>
  );
}

/**
 * Pane board (plan clipboard:Y9cgKVHFaHrr): the cheap Claude model that writes each pane's line, how often Nous refreshes them,
 * its batch and daily limits, the lines' language and which panes the board lists. The labels stay English.
 */
function NousPaneBoardSettingsRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const board = settings?.paneBoard ?? nousPaneBoardSettingsSchema.parse({});
  const save = (patch: Partial<NousPaneBoardSettings>) => onChange({ paneBoard: { ...board, ...patch } });
  const disabled = !settings;
  return (
    <>
      <div className="settings-flat-subheading">
        <strong>Pane board</strong>
        <small>Nous's Panes view: one line per pane by room. Nous refreshes a pane's line only when something changed in it.</small>
      </div>
      <SpaceToggle className={className} label="Pane board summaries" ariaLabel="Nous pane board summaries"
        detail="A cheap Claude model writes each changed pane's line. Off: the board shows Space's own line from the newest report."
        checked={board.enabled} disabled={disabled} onChange={(enabled) => save({ enabled })} />
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy"><strong>Summary model</strong><small>One headless Claude Code run per refresh, with no tools.</small></span>
        <select aria-label="Pane board summary model" value={board.model} disabled={disabled} onChange={(event) => save({ model: event.target.value as NousPaneBoardSettings["model"] })}>
          {PANE_BOARD_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <PaneBoardNumber label="Refresh interval (minutes)" detail="How often Nous looks for changed panes; at most one new line per pane in that time." value={board.intervalMinutes} min={2} max={60}
        onSave={(intervalMinutes) => save({ intervalMinutes })} />
      <PaneBoardNumber label="Panes per summary call" detail="Changed panes beyond this wait for the next refresh." value={board.maxPanesPerCall} min={1} max={20}
        onSave={(maxPanesPerCall) => save({ maxPanesPerCall })} />
      <PaneBoardNumber label="Summary calls per day" detail="After this many calls the board shows Space's own lines until tomorrow (UTC)." value={board.dailyCap} min={10} max={2_000}
        onSave={(dailyCap) => save({ dailyCap })} />
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy"><strong>Summary language</strong><small>The language of the pane lines; the board's labels stay English.</small></span>
        <select aria-label="Pane board summary language" value={board.language} disabled={disabled} onChange={(event) => save({ language: event.target.value as NousPaneBoardSettings["language"] })}>
          <option value="el">Greek</option>
          <option value="en">English</option>
        </select>
      </label>
      <SpaceToggle className={className} label="Show finished panes" ariaLabel="Pane board shows finished panes" detail="Panes whose turn has ended stay on the board."
        checked={board.showFinished} disabled={disabled} onChange={(showFinished) => save({ showFinished })} />
      <SpaceToggle className={className} label="Show closed panes" ariaLabel="Pane board shows closed panes" detail="Closed panes of your rooms appear too, without a reply box."
        checked={board.showClosed} disabled={disabled} onChange={(showClosed) => save({ showClosed })} />
    </>
  );
}

/**
 * Standing orders (operator orders 2026-10-21): Space itself brings Nous the finished panes (to save to memory and close) and the
 * stalled plans every tick, in a turn of their own, until each one is handled.
 */
function NousStandingOrdersRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const orders = settings?.standingOrders ?? nousStandingOrdersSettingsSchema.parse({});
  const save = (patch: Partial<NousStandingOrdersSettings>) => onChange({ standingOrders: { ...orders, ...patch } });
  return (
    <>
      <div className="settings-flat-subheading">
        <strong>Standing orders</strong>
        <small>Space repeats them in code, 24/7: finished panes are asked to save to memory and then closed by Nous; stalled plans get one action each.</small>
      </div>
      <SpaceToggle className={className} label="Close finished panes after their memory save" ariaLabel="Nous closes finished panes after their memory save"
        detail="Nous asks each finished CLI pane to save to memory, Space verifies the save, Nous closes the pane. A pane bound to a scheduled task stays open."
        checked={orders.closeFinishedPanes} disabled={!settings} onChange={(closeFinishedPanes) => save({ closeFinishedPanes })} />
      <SpaceToggle className={className} label="Close your own panes too" ariaLabel="Nous closes your own panes after their memory save"
        detail="Panes you work in yourself (your test panes) are saved to memory and closed like any finished pane once their task is done. Off: Nous never closes them."
        checked={orders.closeOperatorPanes} disabled={!settings} onChange={(closeOperatorPanes) => save({ closeOperatorPanes })} />
      <PaneBoardNumber label="Finished after (minutes)" detail="A pane that has been done or idle this long, with nothing waiting on it, counts as finished." value={orders.finishedAfterMinutes} min={5} max={720}
        onSave={(finishedAfterMinutes) => save({ finishedAfterMinutes })} />
      <PaneBoardNumber label="Stalled after (hours)" detail="A plan that has not moved this long (or has no pane) is stalled; Nous nudges it once per window." value={orders.stalledAfterHours} min={1} max={72}
        onSave={(stalledAfterHours) => save({ stalledAfterHours })} />
      <PaneBoardNumber label="Check every (minutes)" detail="How often Space looks for finished panes and stalled plans." value={orders.tickMinutes} min={2} max={60}
        onSave={(tickMinutes) => save({ tickMinutes })} />
      <SpaceToggle className={className} label="Daily self-review" ariaLabel="Nous reviews its own day"
        detail="Once a day Space brings Nous its own turns, failures and corrections of the last 24 hours in a turn of its own; Nous turns the repeated causes into lessons and saves the review to Space Memory."
        checked={orders.dailyReview} disabled={!settings} onChange={(dailyReview) => save({ dailyReview })} />
      <PaneBoardNumber label="Self-review at (hour)" detail="The hour of the day, in your time zone, the daily self-review starts (0-23)." value={orders.dailyReviewHour} min={0} max={23}
        onSave={(dailyReviewHour) => save({ dailyReviewHour })} />
    </>
  );
}

const NOUS_MODEL_LABELS: Record<NousModelChoice["model"], string> = {
  "claude-fable-5-1": "Claude Fable 5.1", "claude-opus-5-5": "Claude Opus 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-haiku-5-5": "Claude Haiku 5.5"
};
const TURN_KIND_LABELS: Record<NousTurnKind, { label: string; detail: string }> = {
  operator: { label: "Answering you", detail: "Turns your messages start." },
  decision: { label: "Acting on your answers", detail: "Turns your decision answers start." },
  inbox: { label: "Reading news from the rooms", detail: "Inbox turns: pane events, reports and notifications." },
  standing: { label: "Standing orders", detail: "Finished panes and stalled plans every tick, the Away round and the daily self-review." },
  helper: { label: "Helpers", detail: "The helper turns of space_subagents." },
  goal: { label: "Working on your goals", detail: "The goal loop's turns: the strongest model and effort by default, never downgraded in low-spend mode." }
};

/**
 * Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the goal loop that works the operator's goals in turns of its own.
 */
function NousGoalsRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const goals = settings?.goals ?? nousGoalsSettingsSchema.parse({});
  const save = (patch: Partial<NousGoalsSettings>) => onChange({ goals: { ...goals, ...patch } });
  return (
    <>
      <div className="settings-flat-subheading">
        <strong>Goals</strong>
        <small>Your standing objectives (/goal in the Nous dock). While one is active, Nous works it in goal turns of its own, in parallel with everything else, and backs off only while nothing moves or the goal waits on you, a third party or a date.</small>
      </div>
      <SpaceToggle className={className} label="Goal loop" ariaLabel="Nous goal loop"
        detail="A goal turn shortly after the previous one while a goal is active. Off: goals stay listed and Nous still serves them in its other turns."
        checked={goals.loop} disabled={!settings} onChange={(loop) => save({ loop })} />
      <PaneBoardNumber label="Gap between goal turns (seconds)" detail="How long after a goal turn ends the next one may start." value={goals.gapSeconds} min={10} max={3_600}
        onSave={(gapSeconds) => save({ gapSeconds })} />
      <PaneBoardNumber label="Back off (minutes)" detail="The first pause when a goal did not move or waits on someone; it doubles while nothing changes." value={goals.backoffMinutes} min={1} max={180}
        onSave={(backoffMinutes) => save({ backoffMinutes, backoffMaxMinutes: Math.max(backoffMinutes, goals.backoffMaxMinutes) })} />
      <PaneBoardNumber label="Back off at most (minutes)" detail="The longest pause between goal turns of a goal that does not move." value={goals.backoffMaxMinutes} min={goals.backoffMinutes} max={720}
        onSave={(backoffMaxMinutes) => save({ backoffMaxMinutes: Math.max(goals.backoffMinutes, backoffMaxMinutes) })} />
      <PaneBoardNumber label="Unchanged turns before backing off" detail="Goal turns in a row that leave a goal unchanged before it backs off." value={goals.unchangedTurns} min={1} max={20}
        onSave={(unchangedTurns) => save({ unchangedTurns })} />
    </>
  );
}

/**
 * The model and effort per turn kind (operator decision 2026-10-24: Fable 5.1, max for the operator's and decision turns, high for
 * inbox, standing and helper turns), the fallback model (off by default, operator decision 2026-10-21) and the inbox turns an hour.
 */
function NousModelsRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const models = settings?.models ?? nousModelsSettingsSchema.parse({});
  const save = (kind: NousTurnKind, patch: Partial<NousModelChoice>) => onChange({ models: { ...models, [kind]: { ...models[kind], ...patch } } as NousModelsSettings });
  return (
    <>
      <div className="settings-flat-subheading">
        <strong>Models per turn kind</strong>
        <small>Which Claude model and effort each kind of Nous turn runs on: Fable 5.1 by default, max when you wait for it (your messages, your decisions), high for the inbox, the standing orders and the helpers. Every turn is a headless Claude Code run on the subscription accounts.</small>
      </div>
      {NOUS_TURN_KINDS.map((kind) => (
        <div key={kind} className={className}>
          <span className="settings-flat-row-copy"><strong>{TURN_KIND_LABELS[kind].label}</strong><small>{TURN_KIND_LABELS[kind].detail}</small></span>
          <select aria-label={`Nous model for ${kind} turns`} value={models[kind].model} disabled={!settings} onChange={(event) => save(kind, { model: event.target.value as NousModelChoice["model"] })}>
            {NOUS_MODELS.map((model) => <option key={model} value={model}>{NOUS_MODEL_LABELS[model]}</option>)}
          </select>
          <select aria-label={`Nous effort for ${kind} turns`} value={models[kind].effort} disabled={!settings} onChange={(event) => save(kind, { effort: event.target.value as NousModelChoice["effort"] })}>
            {NOUS_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
      ))}
      <div className={className}>
        <span className="settings-flat-row-copy"><strong>Fallback model</strong><small>Claude Code continues a turn on it only when the main model is overloaded or unavailable. Off (operator decision 2026-10-21): Nous pauses ten minutes instead.</small></span>
        <select aria-label="Nous fallback model" value={settings?.fallbackModel ?? "none"} disabled={!settings} onChange={(event) => onChange({ fallbackModel: event.target.value as NousSettings["fallbackModel"] })}>
          {NOUS_FALLBACK_MODELS.map((model) => <option key={model} value={model}>{model === "none" ? "Off" : NOUS_MODEL_LABELS[model]}</option>)}
        </select>
      </div>
      <PaneBoardNumber label="Inbox turns per hour" detail="At most this many inbox turns an hour (pane events, reports, notifications). Your messages, your decisions and the standing orders are never limited."
        value={settings?.maxTurnsPerHour ?? 20} min={1} max={120} onSave={(maxTurnsPerHour) => onChange({ maxTurnsPerHour })} />
    </>
  );
}

function NousLowSpendRows({ settings, onChange }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void }) {
  const low = settings?.lowSpend ?? nousLowSpendSettingsSchema.parse({});
  const save = (patch: Partial<NousLowSpendSettings>) => { if (settings) onChange({ lowSpend: { ...low, ...patch } }); };
  const model = (kind: typeof NOUS_LOW_SPEND_KINDS[number], patch: Partial<NousModelChoice>) => save({ models: { ...low.models, [kind]: { ...low.models[kind], ...patch } } });
  const criticalModel = (kind: typeof NOUS_LOW_SPEND_KINDS[number], patch: Partial<NousLowSpendSettings["criticalModels"]["inbox"]>) =>
    save({ criticalModels: { ...low.criticalModels, [kind]: { ...low.criticalModels[kind], ...patch } } });
  return (
    <>
      <div className="settings-flat-subheading"><strong>Low-spend mode</strong><small>Keep Claude quota available for the work that needs it.</small></div>
      <div className="settings-flat-row">
        <span className="settings-flat-row-copy"><strong>Low-spend mode</strong><small>Auto watches cached quotas and returns to normal after resets. Always on keeps spending low. Off keeps your normal turn settings.</small></span>
        <select aria-label="Nous low-spend mode" disabled={!settings} value={low.mode} onChange={(event) => save({ mode: event.target.value as NousLowSpendSettings["mode"] })}>
          <option value="AUTO">Auto</option><option value="ON">Always on</option><option value="OFF">Off</option>
        </select>
      </div>
      <SpaceToggle className="settings-flat-row" label="Cheaper model in low-spend mode" ariaLabel="Cheaper model in low-spend mode"
        detail="Automatic turns use the models below: Sonnet 5.5 in LOW and Haiku 5.5 in CRITICAL by default. Your messages and decisions keep their model. Normal models return after recovery."
        checked={low.cheaperModel} disabled={!settings} onChange={(cheaperModel) => save({ cheaperModel })} />
      <div className="settings-flat-subheading"><small>Your messages and decisions keep their model with effort at most high. The inbox batches more slowly, helpers are limited to one (none in CRITICAL), and stalled-plan nudges wait.</small></div>
      <PaneBoardNumber label="Max accounts needed for normal spending" detail="Auto conserves when fewer accounts have room in their 5-hour window." value={low.minMaxAccountsWithRoom} min={1} max={100} onSave={(minMaxAccountsWithRoom) => save({ minMaxAccountsWithRoom })} />
      <PaneBoardNumber label="Quota left to count as room (%)" detail="A Claude Max account needs at least this percentage left in its 5-hour window and its week. None with room is CRITICAL: the API key never serves Claude Code." value={low.roomRemainingPercent} min={1} max={100} onSave={(roomRemainingPercent) => save({ roomRemainingPercent })} />
      <PaneBoardNumber label="Inbox turns per hour while conserving" detail="An upper limit in LOW and CRITICAL; a lower normal inbox limit still applies." value={low.maxTurnsPerHour} min={1} max={120} onSave={(maxTurnsPerHour) => save({ maxTurnsPerHour })} />
      {NOUS_LOW_SPEND_KINDS.map((kind) => (
        <div className="settings-flat-row" key={kind}>
          <span className="settings-flat-row-copy"><strong>{TURN_KIND_LABELS[kind].label} in LOW</strong><small>Sonnet 5.5 medium by default.</small></span>
          <select aria-label={`Nous low-spend model for ${kind} turns`} disabled={!settings || !low.cheaperModel} value={low.models[kind].model} onChange={(event) => model(kind, { model: event.target.value as NousModelChoice["model"] })}>
            {NOUS_MODELS.map((id) => <option key={id} value={id}>{NOUS_MODEL_LABELS[id]}</option>)}
          </select>
          <select aria-label={`Nous low-spend effort for ${kind} turns`} disabled={!settings || !low.cheaperModel} value={low.models[kind].effort} onChange={(event) => model(kind, { effort: event.target.value as NousModelChoice["effort"] })}>
            {NOUS_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
      ))}
      {NOUS_LOW_SPEND_KINDS.map((kind) => (
        <div className="settings-flat-row" key={`critical-${kind}`}>
          <span className="settings-flat-row-copy"><strong>{TURN_KIND_LABELS[kind].label} in CRITICAL</strong><small>{kind === "helper" ? "Haiku 5.5 medium by default. Helpers remain disabled in CRITICAL." : "Haiku 5.5 medium by default."}</small></span>
          <select aria-label={`Nous critical model for ${kind} turns`} disabled={!settings || !low.cheaperModel} value={low.criticalModels[kind].model} onChange={(event) => criticalModel(kind, { model: event.target.value as NousModelChoice["model"] })}>
            {NOUS_MODELS.map((id) => <option key={id} value={id}>{NOUS_MODEL_LABELS[id]}</option>)}
          </select>
          <select aria-label={`Nous critical effort for ${kind} turns`} disabled={!settings || !low.cheaperModel} value={low.criticalModels[kind].effort} onChange={(event) => criticalModel(kind, { effort: event.target.value as "low" | "medium" })}>
            <option value="low">low</option><option value="medium">medium</option>
          </select>
        </div>
      ))}
    </>
  );
}

/** Settings → Assistants & AI → Nous: every Nous switch, saved to the signed-in operator's Nous settings. */
export function NousSettingsCard() {
  const [settings, setSettings] = useState<NousSettings | null>(null);
  const [away, setAway] = useState<NousAway | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Goal 7365014c-c: how often each Always-approve kind ran by itself in 14 days (a read only; the list stays the settings' own).
  const [spared, setSpared] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void api.nousAlwaysApprove().then(({ rules }) => { if (!cancelled) setSpared(new Map(rules.map((rule) => [rule.key, rule.count]))); }).catch(() => undefined);
    api.nous().then(({ state }) => { if (!cancelled) { setSettings(state.settings); setAway(state.away ?? null); } })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Nous settings could not be loaded."); });
    return () => { cancelled = true; };
  }, []);

  const save = (patch: Partial<NousSettings>) => {
    setError(null);
    void api.updateNousSettings(patch).then((result) => setSettings(result.settings))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The setting could not be saved."));
  };

  // The kept list is the one saved now: a rule approved in the dock after this card loaded stays (Record Retention Invariant).
  const askAgain = (key: string) => {
    setError(null);
    void api.nous().then(({ state }) => save({ alwaysApprove: (state.settings.alwaysApprove ?? []).filter((kept) => kept.key !== key) }))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The setting could not be saved."));
  };

  const saveAway = (input: { away: boolean; grant?: NousAwayGrant[] }) => {
    setError(null);
    void api.setNousAway(input).then((result) => setAway(result.away))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Away mode could not be changed."));
  };

  return (
    <section className="agent-settings-card settings-flat-card" aria-label="Nous settings" aria-busy={!settings && !error}>
      <NousSettingsToggles settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousAwayToggles away={away} onChange={saveAway} className="settings-flat-row settings-flat-toggle-row" />
      <NousPaneBoardSettingsRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousStandingOrdersRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousGoalsRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousModelsRows settings={settings} onChange={save} className="settings-flat-row" />
      <NousLowSpendRows settings={settings} onChange={save} />
      {/* The kinds approved with "Always approve" in the Nous dock (operator request 2026-10-18); removing one makes Nous ask again. */}
      {settings?.alwaysApprove?.map((rule) => (
        <div key={rule.key} className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Always approved</strong>
            <small>{rule.label} · since {formatUserTime(rule.at)}{spared.has(rule.key) ? ` · ran ${spared.get(rule.key)} time${spared.get(rule.key) === 1 ? "" : "s"} for you in 14 days` : ""}</small>
          </span>
          <DockButton aria-label={`Ask me again: ${rule.label}`}
            onClick={() => askAgain(rule.key)}>Ask me again</DockButton>
        </div>
      ))}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}
