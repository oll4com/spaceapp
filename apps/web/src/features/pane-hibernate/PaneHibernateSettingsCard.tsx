import { useEffect, useState } from "react";
import { PANE_HIBERNATE_MINUTES, paneHibernateMinutes, type PaneHibernateMinutes } from "@space/contracts";
import { api } from "../../api.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";

/** Settings → Sleeping panes (operator 13/11 14:47 BKK): idle CLI panes stop after this long and resume on their next message (pane-hibernate.ts). */
export function PaneHibernateSettingsCard() {
  const [minutes, setMinutes] = useState<PaneHibernateMinutes | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => { if (live) setMinutes(paneHibernateMinutes(saved)); })
      .catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    return () => { live = false; };
  }, []);

  async function choose(next: PaneHibernateMinutes) {
    const previous = minutes;
    setMinutes(next);
    setError(null);
    try {
      await api.updateUserSettings({ paneHibernate: { minutes: next } });
    } catch (cause) {
      setMinutes(previous);
      setError(cause instanceof Error ? cause.message : "The sleep time could not be saved. Try again.");
    }
  }

  return <section className="agent-settings-card settings-flat-card" aria-label="Sleeping panes settings">
    <label className="settings-flat-row">
      <SettingsLabel label="Sleep idle CLI panes after" help="An idle CLI pane stops to free memory and keeps its conversation; your next message resumes it. Panes that work, wait for you or run a background job never sleep.">
        {error ? <span role="alert">{error}</span> : null}
      </SettingsLabel>
      <select aria-label="Sleep idle CLI panes after" value={minutes ?? ""} disabled={minutes === null} onChange={(event) => void choose(Number(event.target.value) as PaneHibernateMinutes)}>
        {minutes === null ? <option value="">Loading…</option> : null}
        {PANE_HIBERNATE_MINUTES.map((option) => <option key={option} value={option}>{option === 0 ? "Off" : `${option} minutes`}</option>)}
      </select>
    </label>
  </section>;
}
