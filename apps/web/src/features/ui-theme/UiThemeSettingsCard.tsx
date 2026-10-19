import { AlertTriangle, AppIconProvider, CircleAlert, Globe, Mail, Palette, Pencil, Settings, Terminal, Trash2 } from "./app-icons.js";
import type { ModernAppearance, ModernIconPack, UiBackground, UiTheme } from "../../ui-theme.js";
import "./ui-theme-settings-card.css";

const ICON_PACKS: Array<[ModernIconPack, string]> = [
  ["space", "Space Duotone (default)"],
  ["lucide", "Lucide"],
  ["material-rounded", "Material Rounded"],
  ["motion", "Motion Geometric"],
  ["aurora", "Aurora Neon"]
];
const ICON_PACK_SAMPLES = [Terminal, Globe, Mail, Settings, Pencil, Trash2, AlertTriangle, CircleAlert];
const THEMES: Array<[UiTheme, string]> = [
  ["classic", "Classic"],
  ["modern", "Modern"],
  ["codex", "Graphite"],
  ["motion", "Motion"],
  ["aurora", "Aurora"],
  ["liquid-glass", "Liquid Glass"],
  ["jarvis", "Jarvis"],
  ["aira", "Aira"]
];
const BACKGROUNDS: Array<[UiBackground, string, string]> = [
  ["spaceapp", "SpaceApp", "SpaceApp"],
  ["aurora", "Aurora", "Aurora"],
  ["liquid-glass", "Glass Planet", "Glass Planet"],
  ["jarvis", "Jarvis HUD", "Jarvis HUD"],
  ["aira", "Aira Core", "Aira Core"],
  ["none", "Theme default (no background)", "None"]
];

export function UiThemeSettingsCard({
  currentAppearance,
  currentBackground = "spaceapp",
  currentIconPack,
  currentTheme,
  currentGlassTint = 50,
  onGlassTintChange,
  onChange
}: {
  currentAppearance: ModernAppearance;
  currentBackground?: UiBackground;
  currentIconPack: ModernIconPack;
  currentTheme: UiTheme;
  currentGlassTint?: number;
  onGlassTintChange?: (tint: number) => void;
  onChange: (selection: {
    appearance: ModernAppearance;
    background: UiBackground;
    iconPack: ModernIconPack;
    theme: UiTheme;
  }) => void;
}) {
  const selectTheme = (theme: UiTheme) => {
    // Aurora is a full set: choosing it also brings its background and icon pack.
    // Liquid Glass, Jarvis and Aira bring their own background (same id) and keep the icon pack.
    onChange(theme === "aurora"
      ? { appearance: currentAppearance, background: "aurora", iconPack: "aurora", theme }
      : theme === "liquid-glass" || theme === "jarvis" || theme === "aira"
        ? { appearance: currentAppearance, background: theme, iconPack: currentIconPack, theme }
        : { appearance: currentAppearance, background: currentBackground, iconPack: currentIconPack, theme });
  };
  const selectBackground = (background: UiBackground) =>
    onChange({ appearance: currentAppearance, background, iconPack: currentIconPack, theme: currentTheme });
  return (
    <section className="agent-settings-card settings-flat-card ui-theme-settings-card" aria-label="Interface appearance">
      <div className="agent-settings-section-title settings-flat-heading">
        <Palette aria-hidden="true" />
        <span>
          <strong>Interface appearance</strong>
          <small>Saved to your account and synced across all devices.</small>
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
          onChange={(event) => selectTheme(event.target.value as UiTheme)}
        >
          {THEMES.map(([theme, label]) => <option key={theme} value={theme}>{label}</option>)}
        </select>
      </label>

      {/* Choosing a theme reloads the app, so every theme is shown here before it is chosen. */}
      <div className="ui-theme-previews" role="group" aria-label="Theme previews">
        {THEMES.map(([theme, label]) => (
          <button key={theme} type="button" className="ui-theme-preview" aria-pressed={theme === currentTheme}
            onClick={() => { if (theme !== currentTheme) selectTheme(theme); }}>
            <span className="ui-theme-preview-art" data-theme-preview={theme} aria-hidden="true"><i /><i /><i /><i /></span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Color mode</strong>
          <small>Modern and Liquid Glass support light and dark. Classic, Graphite, Motion, Aurora, Jarvis and Aira use dark colors.</small>
        </span>
        <select
          aria-label="Modern color mode"
          name="modern-color-mode"
          value={currentAppearance}
          disabled={currentTheme !== "modern" && currentTheme !== "liquid-glass"}
          onChange={(event) => onChange({
            appearance: event.target.value as ModernAppearance,
            background: currentBackground,
            iconPack: currentIconPack,
            theme: currentTheme
          })}
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>

      {currentTheme === "liquid-glass" && onGlassTintChange ? (
        <label className="settings-flat-row">
          <span className="settings-flat-row-copy">
            <strong>Liquid Glass</strong>
            <small>From clear glass to a tinted material, as in iOS 27. Changes apply as you slide.</small>
          </span>
          <span className="ui-theme-glass-tint">
            <span aria-hidden="true">Clear</span>
            <input type="range" min={0} max={100} step={1} aria-label="Liquid Glass tint" aria-valuetext={`${currentGlassTint}% tinted`}
              value={currentGlassTint} onChange={(event) => onGlassTintChange(Number(event.target.value))} />
            <span aria-hidden="true">Tinted</span>
          </span>
        </label>
      ) : null}

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Icon pack</strong>
          <small>Available in every interface theme.</small>
        </span>
        <select
          aria-label="Icon pack"
          name="modern-icon-pack"
          value={currentIconPack}
          onChange={(event) => onChange({
            appearance: currentAppearance,
            background: currentBackground,
            iconPack: event.target.value as ModernIconPack,
            theme: currentTheme
          })}
        >
          {ICON_PACKS.map(([pack, label]) => <option key={pack} value={pack}>{label}</option>)}
        </select>
      </label>

      {/* Choosing a pack reloads the app, so every pack is shown here before it is chosen. */}
      <div className="ui-theme-icon-preview" role="group" aria-label="Icon pack preview">
        {ICON_PACKS.map(([pack, label]) => (
          <AppIconProvider key={pack} pack={pack}>
            <div className={pack === currentIconPack ? "is-current" : undefined} data-icon-pack-preview={pack}>
              <span>{label}{pack === currentIconPack ? " (current)" : ""}</span>
              {ICON_PACK_SAMPLES.map((Icon, index) => <Icon key={index} aria-hidden="true" />)}
            </div>
          </AppIconProvider>
        ))}
      </div>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Background</strong>
          <small>SpaceApp artwork, the animated Aurora sky, the Glass Planet wallpaper, the Jarvis HUD, the Aira Core or clean theme default.</small>
        </span>
        <select
          aria-label="Background"
          name="space-ui-background"
          value={currentBackground}
          onChange={(event) => selectBackground(event.target.value as UiBackground)}
        >
          {BACKGROUNDS.map(([background, label]) => <option key={background} value={background}>{label}</option>)}
        </select>
      </label>

      <div className="ui-theme-previews" role="group" aria-label="Background previews">
        {BACKGROUNDS.map(([background, , tileLabel]) => (
          <button key={background} type="button" className="ui-theme-preview" aria-pressed={background === currentBackground}
            onClick={() => { if (background !== currentBackground) selectBackground(background); }}>
            <span className="ui-theme-preview-art" data-background-preview={background} aria-hidden="true" />
            <span>{tileLabel}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
