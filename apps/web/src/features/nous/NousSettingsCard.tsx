import { useEffect, useState } from "react";
import { nousPaneBoardSettingsSchema, type NousAway, type NousAwayGrant, type NousPaneBoardSettings, type NousSettings } from "@space/contracts";
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
      <SpaceToggle className={className} label="Bring me to panes that need me" ariaLabel="Nous brings me to panes that need me"
        detail="When a pane needs your hands, Nous offers to switch to it, maximizes it and brings you back when it is done. On this device."
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

/** Settings → Assistants & AI → Nous: every Nous switch, saved to the signed-in operator's Nous settings. */
export function NousSettingsCard() {
  const [settings, setSettings] = useState<NousSettings | null>(null);
  const [away, setAway] = useState<NousAway | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
      {/* The kinds approved with "Always approve" in the Nous dock (operator request 2026-10-18); removing one makes Nous ask again. */}
      {settings?.alwaysApprove?.map((rule) => (
        <div key={rule.key} className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Always approved</strong>
            <small>{rule.label} · since {formatUserTime(rule.at)}</small>
          </span>
          <DockButton aria-label={`Ask me again: ${rule.label}`}
            onClick={() => askAgain(rule.key)}>Ask me again</DockButton>
        </div>
      ))}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}
