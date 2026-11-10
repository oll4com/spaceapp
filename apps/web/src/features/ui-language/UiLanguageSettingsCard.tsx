import { useEffect, useState } from "react";
import { UI_LANGUAGES, UI_LANGUAGE_NAMES, agentLanguageOf, uiLanguageOf, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { announceAgentLanguage, announceUiLanguage, useUiText } from "./ui-language.js";

type Choice = { interface: UiLanguage; agents: UiLanguage };

/**
 * Settings → Personal → Language (operator 1/11 11:59 BKK; split 2/11 09:51 BKK «μια για το ui μια για της γλώσσα που μιλας στους agent»):
 * the interface language is Space's own labels and buttons; the agents' language is what Nous, agents and copilots write to him.
 */
export function UiLanguageSettingsCard() {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useUiText();
  useEffect(() => {
    let live = true;
    api.userSettings().then((saved) => {
      if (live) setChoice({ interface: uiLanguageOf(saved, navigator.languages), agents: agentLanguageOf(saved, navigator.languages) });
    }).catch(() => { if (live) setError("Your settings could not load. Reopen Settings to try again."); });
    return () => { live = false; };
  }, []);

  async function choose(key: keyof Choice, next: UiLanguage) {
    if (!choice) return;
    const previous = choice;
    setChoice({ ...choice, [key]: next });
    setError(null);
    try {
      // The agents' language is saved with the interface one, so a later interface change never moves it.
      await api.updateUserSettings(key === "interface" ? { uiLanguage: next, agentLanguage: choice.agents } : { agentLanguage: next });
      if (key === "interface") announceUiLanguage(next); else announceAgentLanguage(next);
    } catch (cause) {
      setChoice(previous);
      setError(cause instanceof Error ? cause.message : "The language could not be saved. Try again.");
    }
  }

  const row = (key: keyof Choice, title: string, hint: string) => (
    <label className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>{t(title)}</strong>
        <small role={error && key === "interface" ? "alert" : undefined}>{error && key === "interface" ? error : t(hint)}</small>
      </span>
      <select aria-label={t(title)} value={choice?.[key] ?? ""} disabled={choice === null} onChange={(event) => void choose(key, event.target.value as UiLanguage)}>
        {choice === null ? <option value="">Loading…</option> : null}
        {UI_LANGUAGES.map((option) => <option key={option} value={option}>{UI_LANGUAGE_NAMES[option]}</option>)}
      </select>
    </label>
  );

  return <section className="agent-settings-card settings-flat-card" aria-label="Language settings">
    {row("interface", "Interface language", "Space's own labels, buttons and menus.")}
    {row("agents", "Agent language", "What Nous, agents and copilots write to you: replies, the steps in the Nous conversation, Needs you cards, decisions and notifications.")}
  </section>;
}
