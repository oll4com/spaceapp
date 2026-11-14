import { useEffect, useState } from "react";
import { UI_LANGUAGES, UI_LANGUAGE_NAMES, agentLanguageOf, uiLanguageOf, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { announceAgentLanguage, announceUiLanguage, useUiText } from "./ui-language.js";

type Choice = { interface: UiLanguage; agents: UiLanguage };
const ROWS: Array<{ key: keyof Choice; label: string; help: string }> = [
  { key: "interface", label: "Interface language", help: "Space's own labels, buttons and menus." },
  { key: "agents", label: "Agent language", help: "What Nous, agents and copilots write to you: replies, the steps in the Nous conversation, Needs you cards, decisions and notifications." }
];

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

  return <section className="agent-settings-card settings-flat-card" aria-label="Language settings">
    {ROWS.map(({ key, label, help }) => <label key={key} className="settings-flat-row">
      <SettingsLabel label={label} help={help}>{error && key === "interface" ? <span role="alert">{error}</span> : null}</SettingsLabel>
      <select aria-label={t(label)} value={choice?.[key] ?? ""} disabled={choice === null} onChange={(event) => void choose(key, event.target.value as UiLanguage)}>
        {choice === null ? <option value="">Loading…</option> : null}
        {UI_LANGUAGES.map((option) => <option key={option} value={option}>{UI_LANGUAGE_NAMES[option]}</option>)}
      </select>
    </label>)}
  </section>;
}
