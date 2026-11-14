import { useEffect, useState } from "react";
import { MAX_ROOM_LIMIT, MAX_ROOMS } from "@space/contracts";
import { api } from "../../api.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";

const ROOM_LIMIT_OPTIONS = Array.from({ length: MAX_ROOM_LIMIT }, (_, index) => index + 1);

/** Settings → Workspace → Rooms: how many rooms of their own the user may open; test rooms never count. */
export function RoomLimitSettingsCard() {
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => { if (live) setLimit(saved.roomLimit ?? MAX_ROOMS); })
      .catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    return () => { live = false; };
  }, []);

  async function choose(next: number) {
    const previous = limit;
    setLimit(next);
    setError(null);
    try {
      await api.updateUserSettings({ roomLimit: next });
    } catch (cause) {
      setLimit(previous);
      setError(cause instanceof Error ? cause.message : "The room limit could not be saved. Try again.");
    }
  }

  return <section className="agent-settings-card settings-flat-card" aria-label="Room settings">
    <label className="settings-flat-row">
      <SettingsLabel label="Room limit" help="How many rooms of your own you can open. Test rooms that agents open for their checks never count.">
        {error ? <span role="alert">{error}</span> : null}
      </SettingsLabel>
      <select aria-label="Room limit" value={limit ?? ""} disabled={limit === null} onChange={(event) => void choose(Number(event.target.value))}>
        {limit === null ? <option value="">Loading…</option> : null}
        {ROOM_LIMIT_OPTIONS.map((option) => <option key={option} value={option}>{option} rooms</option>)}
      </select>
    </label>
  </section>;
}
