import { useState } from "react";
import { useOptionalVoiceInput } from "./VoiceInputProvider.js";
import { readVoiceComposerSettings, writeVoiceComposerSettings, type VoiceComposerSettings } from "../../voice-settings.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { CliShortcutVisibilitySettings } from "../terminal-pane/CliShortcutVisibilitySettings.js";

type ButtonSetting = "terminalShortcutsButton" | "terminalVariablesButton" | "terminalPlansButton"
  | "terminalVoiceButton" | "terminalModelPicker" | "terminalTurnControl" | "terminalAccountPicker" | "terminalLocalDraftButton";

const buttons: Array<{ key: ButtonSetting; name: string; label: string; detail: string }> = [
  { key: "terminalShortcutsButton", name: "float-shortcuts-button", label: "Shortcuts", detail: "A menu of quick commands, such as Plan mode, Model or Clear." },
  { key: "terminalVariablesButton", name: "float-variables-button", label: "Prompt variables", detail: "Insert one of your saved #variables." },
  { key: "terminalPlansButton", name: "float-plans-button", label: "Plans", detail: "Open your saved plans and send one to the agent." },
  { key: "terminalVoiceButton", name: "float-voice-button", label: "Voice mic", detail: "Speak a prompt instead of typing it." },
  { key: "terminalModelPicker", name: "float-model-picker", label: "Model choice", detail: "Switch the AI model and thinking depth of the pane." },
  { key: "terminalTurnControl", name: "float-turn-control", label: "Turn control", detail: "A Stop button while the agent is working." },
  { key: "terminalAccountPicker", name: "float-account-picker", label: "Account picker", detail: "The AI account the pane runs on, with each account's quota." },
  { key: "terminalLocalDraftButton", name: "float-local-draft-button", label: "Local draft", detail: "Open a draft under the pane to write a prompt before sending it." }
];

/** The buttons and menus shown over CLI panes; saved with the voice preferences they share. */
export function CliPaneControlsSettingsCard() {
  // Outside the voice provider the card keeps its own copy of the saved settings.
  const voice = useOptionalVoiceInput();
  const [localSettings, setLocalSettings] = useState(() => readVoiceComposerSettings());
  const settings = voice?.settings ?? localSettings;

  function update(patch: Partial<VoiceComposerSettings>) {
    const next = { ...settings, ...patch };
    writeVoiceComposerSettings(next);
    if (!voice) setLocalSettings(next);
  }

  return (
    <section className="provider-settings-card settings-flat-card cli-pane-controls-settings-card" aria-label="CLI pane controls settings">
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="terminal-context-menu"
        label="Right-click menu"
        detail="Copy, paste and other actions when you right-click inside a pane."
        checked={Boolean(settings.terminalContextMenu ?? true)}
        onChange={(terminalContextMenu) => update({ terminalContextMenu })}
      />
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row voice-toggle"
        name="terminal-local-draft"
        label="Local draft open by default"
        detail="CLI panes open with the local draft under them. A pane where you opened or closed the draft keeps that choice."
        checked={Boolean(settings.terminalLocalDraft)}
        onChange={(terminalLocalDraft) => update({ terminalLocalDraft })}
      />
      <div className="settings-flat-subheading">
        <strong>Buttons</strong>
        <small>Hiding a button only removes it from the pane; the feature keeps working.</small>
      </div>
      {buttons.map(({ key, name, label, detail }) => (
        <SpaceToggle
          key={key}
          className="settings-flat-row settings-flat-toggle-row voice-toggle"
          name={name}
          label={label}
          detail={detail}
          checked={settings[key] ?? true}
          onChange={(checked) => update({ [key]: checked })}
        />
      ))}
      <CliShortcutVisibilitySettings
        hiddenIds={settings.terminalHiddenShortcuts}
        onChange={(terminalHiddenShortcuts) => update({ terminalHiddenShortcuts })}
      />
    </section>
  );
}
