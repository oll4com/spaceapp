import { useEffect, useState } from "react";
import { YOUTUBE_SUMMARY_MODELS } from "@space/contracts";
import { api } from "../../api.js";

/** Settings → Assistants & AI → YouTube summary: the Gemini model a YouTube pane's "Summarize with AI" uses. */
export function YouTubeSummarySettingsCard() {
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => { if (live) setModel(saved.youtubeSummaryModel ?? YOUTUBE_SUMMARY_MODELS[0].id); })
      .catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    return () => { live = false; };
  }, []);

  async function choose(next: string) {
    const previous = model;
    setModel(next);
    setError(null);
    try {
      await api.updateUserSettings({ youtubeSummaryModel: next });
    } catch (cause) {
      setModel(previous);
      setError(cause instanceof Error ? cause.message : "The model could not be saved. Try again.");
    }
  }

  return <section className="agent-settings-card settings-flat-card" aria-label="YouTube summary settings">
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>Model</strong>
        <small role={error ? "alert" : undefined}>{error ?? "Gemini on your Antigravity accounts in Space Gateway watches the video."}</small>
      </span>
      <select aria-label="YouTube summary model" value={model ?? ""} disabled={model === null} onChange={(event) => void choose(event.target.value)}>
        {model === null ? <option value="">Loading…</option> : null}
        {YOUTUBE_SUMMARY_MODELS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  </section>;
}
