import { useEffect, useState } from "react";
import { HISTORY_PERIOD_DAYS, historyPeriodDays, type HistoryPeriodDays } from "@space/contracts";
import { api } from "../../api.js";

/** Settings → Personal → History (operator 1/11 03:37 BKK): how far back every history reaches, 90 days at most (history-period.ts). */
export function HistoryPeriodSettingsCard() {
  const [days, setDays] = useState<HistoryPeriodDays | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => { if (live) setDays(historyPeriodDays(saved)); })
      .catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    return () => { live = false; };
  }, []);

  async function choose(next: HistoryPeriodDays) {
    const previous = days;
    setDays(next);
    setError(null);
    try {
      await api.updateUserSettings({ history: { periodDays: next } });
    } catch (cause) {
      setDays(previous);
      setError(cause instanceof Error ? cause.message : "The history period could not be saved. Try again.");
    }
  }

  return <section className="agent-settings-card settings-flat-card" aria-label="History settings">
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>History period</strong>
        <small role={error ? "alert" : undefined}>{error ?? "How far back every history goes: Nous, notifications, copilot activity, Live, logs, Task runs and usage charts. What still waits for you always shows."}</small>
      </span>
      <select aria-label="History period" value={days ?? ""} disabled={days === null} onChange={(event) => void choose(Number(event.target.value) as HistoryPeriodDays)}>
        {days === null ? <option value="">Loading…</option> : null}
        {HISTORY_PERIOD_DAYS.map((option) => <option key={option} value={option}>{option} days</option>)}
      </select>
    </label>
  </section>;
}
