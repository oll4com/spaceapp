import { useState } from "react";
import { Hash, Settings, Wrench } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { usePromptVariables } from "./prompt-variables-store.js";
import { PromptVariablesManagerModal } from "./PromptVariablesManagerModal.js";
import "./prompt-variables.css";

export function PromptVariablesSettingsCard() {
  const { variables, settings, updateSettings } = usePromptVariables();
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <section
      className="agent-settings-card settings-flat-card prompt-variables-settings-card"
      aria-label="Prompt variables settings"
    >
      <div className="agent-settings-section-title settings-flat-heading">
        <Hash aria-hidden="true" />
        <span>
          <strong>Prompt variables</strong>
          <small>Custom #variable expansions and prompt shortcuts.</small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="keyboard-autocorrect-test-btn"
            style={{ width: "auto", minHeight: "1.8rem", padding: "0.2rem 0.65rem" }}
            onClick={() => setManagerOpen(true)}
            aria-label="Manage prompt variables"
          >
            <Settings aria-hidden="true" style={{ width: 13, height: 13 }} />
            <span>Manage ({variables.length})</span>
          </button>
        </div>
      </div>

      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row"
        name="prompt-variables-master"
        checked={settings.enabled}
        onChange={(checked) => updateSettings({ enabled: checked })}
        label="Enable # prompt variables autocomplete"
        detail="Show interactive variable suggestions dropdown when typing # in CLI terminals and composers."
      />

      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row"
        name="prompt-variables-auto-expand"
        checked={settings.autoExpandOnSubmit}
        disabled={!settings.enabled}
        onChange={(checked) => updateSettings({ autoExpandOnSubmit: checked })}
        label="Auto-expand #variables on submission"
        detail="Automatically replace recognized #variable names with their technical definition when sending the prompt."
      />

      <PromptVariablesManagerModal
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
      />
    </section>
  );
}
