import { Palette } from "./app-icons.js";
import type { ModernAppearance, ModernIconPack, UiTheme } from "../../ui-theme.js";
import "./ui-theme-settings-card.css";

export function UiThemeSettingsCard({
  currentAppearance,
  currentIconPack,
  currentTheme,
  onChange
}: {
  currentAppearance: ModernAppearance;
  currentIconPack: ModernIconPack;
  currentTheme: UiTheme;
  onChange: (selection: { appearance: ModernAppearance; iconPack: ModernIconPack; theme: UiTheme }) => void;
}) {
  return (
    <section className="agent-settings-card settings-flat-card ui-theme-settings-card" aria-label="Interface appearance">
      <div className="agent-settings-section-title settings-flat-heading">
        <Palette aria-hidden="true" />
        <span>
          <strong>Interface appearance</strong>
          <small>Saved in this browser. Each change reloads only this tab.</small>
        </span>
      </div>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Interface theme</strong>
          <small>Choose the overall Space layout.</small>
        </span>
        <select
          aria-label="Interface theme"
          name="space-ui-theme"
          value={currentTheme}
          onChange={(event) => onChange({
            appearance: currentAppearance,
            iconPack: currentIconPack,
            theme: event.target.value as UiTheme
          })}
        >
          <option value="classic">Classic</option>
          <option value="modern">Modern</option>
        </select>
      </label>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Color mode</strong>
          <small>Available with the Modern interface.</small>
        </span>
        <select
          aria-label="Modern color mode"
          name="modern-color-mode"
          value={currentAppearance}
          disabled={currentTheme !== "modern"}
          onChange={(event) => onChange({
            appearance: event.target.value as ModernAppearance,
            iconPack: currentIconPack,
            theme: currentTheme
          })}
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Icon pack</strong>
          <small>Available with the Modern interface.</small>
        </span>
        <select
          aria-label="Modern icon pack"
          name="modern-icon-pack"
          value={currentIconPack}
          disabled={currentTheme !== "modern"}
          onChange={(event) => onChange({
            appearance: currentAppearance,
            iconPack: event.target.value as ModernIconPack,
            theme: currentTheme
          })}
        >
          <option value="lucide">Lucide</option>
          <option value="material-rounded">Material Rounded</option>
        </select>
      </label>
    </section>
  );
}
