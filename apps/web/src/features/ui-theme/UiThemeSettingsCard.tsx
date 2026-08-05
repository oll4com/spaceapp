import { Palette } from "./app-icons.js";
import { useState } from "react";
import type { ModernAppearance, ModernIconPack, UiTheme } from "../../ui-theme.js";
import "./ui-theme-settings-card.css";

export function UiThemeSettingsCard({
  currentAppearance,
  currentIconPack,
  currentTheme,
  onApply
}: {
  currentAppearance: ModernAppearance;
  currentIconPack: ModernIconPack;
  currentTheme: UiTheme;
  onApply: (selection: { appearance: ModernAppearance; iconPack: ModernIconPack; theme: UiTheme }) => void;
}) {
  const [appearance, setAppearance] = useState(currentAppearance);
  const [iconPack, setIconPack] = useState(currentIconPack);
  const [theme, setTheme] = useState(currentTheme);
  const changed = theme !== currentTheme || appearance !== currentAppearance || iconPack !== currentIconPack;

  return (
    <section className="agent-settings-card ui-theme-settings-card" aria-label="Interface appearance">
      <div className="agent-settings-section-title">
        <Palette aria-hidden="true" />
        <span>
          <strong>Interface appearance</strong>
          <small>Modern is isolated and opt-in for this browser only.</small>
        </span>
      </div>

      <fieldset className="ui-theme-options">
        <legend>Interface theme</legend>
        <label>
          <input
            type="radio"
            name="space-ui-theme"
            value="classic"
            aria-label="Current (Classic)"
            checked={theme === "classic"}
            onChange={() => setTheme("classic")}
          />
          <span>
            <strong>Current (Classic)</strong>
            <small>The existing Space layout and styling.</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="space-ui-theme"
            value="modern"
            aria-label="Modern"
            checked={theme === "modern"}
            onChange={() => setTheme("modern")}
          />
          <span>
            <strong>Modern</strong>
            <small>Responsive grouped controls with separate Dark and Light modes.</small>
          </span>
        </label>
      </fieldset>

      {theme === "modern" ? (
        <div className="ui-theme-modern-options">
          <label className="provider-default-select ui-theme-color-mode">
            <span>Color mode</span>
            <select
              aria-label="Modern color mode"
              name="modern-color-mode"
              value={appearance}
              onChange={(event) => setAppearance(event.target.value as ModernAppearance)}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label className="provider-default-select ui-theme-icon-pack">
            <span>Icon pack</span>
            <select
              aria-label="Modern icon pack"
              name="modern-icon-pack"
              value={iconPack}
              onChange={(event) => setIconPack(event.target.value as ModernIconPack)}
            >
              <option value="lucide">Lucide</option>
              <option value="material-rounded">Material Rounded</option>
            </select>
          </label>
        </div>
      ) : null}

      <p className="settings-card-note">
        Applying an interface theme reloads only this browser. Running CLI processes stay active on the pane host.
      </p>
      <button
        type="button"
        className="ui-theme-apply"
        disabled={!changed}
        onClick={() => onApply({ appearance, iconPack, theme })}
      >
        Apply and reload
      </button>
    </section>
  );
}
