import { useEffect, useState } from "react";
import type { NousAway, NousAwayGrant, NousSettings } from "@space/contracts";
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

  const saveAway = (input: { away: boolean; grant?: NousAwayGrant[] }) => {
    setError(null);
    void api.setNousAway(input).then((result) => setAway(result.away))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Away mode could not be changed."));
  };

  return (
    <section className="agent-settings-card settings-flat-card" aria-label="Nous settings" aria-busy={!settings && !error}>
      <NousSettingsToggles settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousAwayToggles away={away} onChange={saveAway} className="settings-flat-row settings-flat-toggle-row" />
      {/* The kinds approved with "Always approve" in the Nous dock (operator request 2026-10-18); removing one makes Nous ask again. */}
      {settings?.alwaysApprove?.map((rule) => (
        <div key={rule.key} className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Always approved</strong>
            <small>{rule.label} · since {formatUserTime(rule.at)}</small>
          </span>
          <DockButton aria-label={`Ask me again: ${rule.label}`}
            onClick={() => save({ alwaysApprove: settings.alwaysApprove.filter((kept) => kept.key !== rule.key) })}>Ask me again</DockButton>
        </div>
      ))}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}
