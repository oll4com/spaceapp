import { useEffect, useState } from "react";
import { api } from "../../api.js";
import { JOB_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotSettingsCard } from "../copilot-kit/CopilotSettingsCard.js";
import { DockNotice } from "../dock-kit/DockKit.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/** Settings → Job Copilot: the copilot kit's settings card bound to Job Copilot (settings.jobCopilot), and the daily application target. */
export function JobCopilotSettingsCard() {
  return (
    <>
      <CopilotSettingsCard kind={JOB_COPILOT_KIND} />
      <JobApplyTargetCard />
    </>
  );
}

/** The target lives in the owner's Job Copilot profile (dailyTarget), never in pane settings: the Browser Host reads those with older contracts. */
function JobApplyTargetCard() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [saved, setSaved] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.jobApplyProfile().then(({ profile }) => { if (!cancelled) { setSaved(profile.dailyTarget); setDraft(String(profile.dailyTarget)); } })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : uiText(language, "Settings could not be loaded.")); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once; a language change needs no refetch

  function save() {
    const next = Number.parseInt(draft, 10);
    if (saved === null || !Number.isFinite(next) || next < 0) { setDraft(String(saved ?? 0)); return; }
    if (next === saved) return;
    setError(null);
    api.updateJobApplyProfile({ dailyTarget: next })
      .then(({ profile }) => { setSaved(profile.dailyTarget); setDraft(String(profile.dailyTarget)); })
      .catch((caught: unknown) => { setDraft(String(saved)); setError(caught instanceof Error ? caught.message : t("The daily application target could not be saved.")); });
  }

  return (
    <section className="agent-settings-card settings-flat-card job-copilot-target-card" aria-label={t("Daily application target")} aria-busy={saved === null}>
      <label className="settings-flat-row">
        <SettingsLabel label="Daily application target" help="Applications a day across your Job Copilot panes; 0 is off. Behind its pace Space keeps a run going and finds more postings; your Stop holds it until you start again. Every check before a submit stays." />
        <input type="number" min={0} step={1} inputMode="numeric" name="job-copilot-daily-target" aria-label={t("Daily application target")} value={draft} disabled={saved === null}
          onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </label>
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}
