import { useState } from "react";
import { Keyboard, Volume2, RotateCcw } from "../ui-theme/app-icons.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  defaultKeyboardAutocorrectSettings,
  playLayoutSuggestionBeep,
  useKeyboardAutocorrectSettings
} from "./keyboard-autocorrect-settings.js";
import "./keyboard-autocorrect-settings.css";

export function KeyboardAutocorrectSettingsCard() {
  const { settings, updateSettings } = useKeyboardAutocorrectSettings();
  const [isTestingSound, setIsTestingSound] = useState(false);

  function toggleLanguage(code: string, enabled: boolean) {
    let next: string[];
    if (enabled) {
      next = settings.supportedLanguages.includes(code)
        ? settings.supportedLanguages
        : [...settings.supportedLanguages, code];
    } else {
      next = settings.supportedLanguages.filter((l) => l !== code);
      // Ensure at least one language remains
      if (next.length === 0) {
        next = [code];
      }
    }
    updateSettings({ supportedLanguages: next });
  }

  const isGreekEnabled = settings.supportedLanguages.includes("el");
  const isEnglishEnabled = settings.supportedLanguages.includes("en");

  return (
    <section
      className="agent-settings-card settings-flat-card keyboard-autocorrect-settings-card"
      aria-label="Keyboard layout and autocorrection settings"
    >
      <div className="agent-settings-section-title settings-flat-heading">
        <Keyboard aria-hidden="true" />
        <span>
          <strong>Keyboard layout</strong>
          <small>Detection, suggestions, and auto-corrections.</small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="keyboard-autocorrect-reset-btn"
            title="Reset to defaults"
            aria-label="Reset keyboard autocorrection settings to defaults"
            onClick={() => updateSettings(defaultKeyboardAutocorrectSettings)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>

      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-master-toggle"
        name="keyboard-autocorrect-master"
        label="Enable layout autocorrection"
        help="Detects text typed in the wrong keyboard layout and suggests the corrected text (Alt+G)."
        checked={settings.enabled}
        onChange={(checked) => updateSettings({ enabled: checked })}
      />

      {settings.enabled ? (
        <>
          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-banner-toggle"
            name="keyboard-autocorrect-banner"
            label="Show suggestion banner"
            help="Shows the converted text above composers; Alt+G keeps working when it is hidden."
            checked={settings.showSuggestionBar}
            onChange={(checked) => updateSettings({ showSuggestionBar: checked })}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-icon-toggle"
            name="keyboard-autocorrect-icon"
            label="Show composer keyboard icon"
            help="Shows the Alt+G layout button in composer action bars."
            checked={settings.showComposerIcon}
            onChange={(checked) => updateSettings({ showComposerIcon: checked })}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-sound-toggle"
            name="keyboard-autocorrect-sound"
            label="Audio alert on detection"
            help="Plays a subtle chime when a wrong layout is detected."
            checked={settings.soundEnabled}
            onChange={(checked) => updateSettings({ soundEnabled: checked })}
          />

          {settings.soundEnabled ? (
            <div className="settings-flat-row keyboard-autocorrect-sound-preview-row">
              <SettingsLabel label="Chime preview" help="Plays the detection chime so you can hear it." />
              <button
                type="button"
                className="settings-flat-control keyboard-autocorrect-test-btn"
                title="Play layout notification chime"
                aria-label="Play layout notification chime"
                onClick={() => {
                  setIsTestingSound(true);
                  playLayoutSuggestionBeep({ force: true });
                  setTimeout(() => setIsTestingSound(false), 500);
                }}
              >
                <Volume2 aria-hidden="true" className={isTestingSound ? "is-playing" : ""} />
                <span>{isTestingSound ? "Playing…" : "Test sound"}</span>
              </button>
            </div>
          ) : null}

          <div className="settings-flat-subheading"><SettingsLabel label="Supported languages" help="The layouts to monitor and convert between. At least one stays on." /></div>

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row language-toggle-el"
            name="language-toggle-el"
            label="Greek"
            help="Detects Greek typed on QWERTY and converts tonos & dialytika."
            checked={isGreekEnabled}
            onChange={(checked) => toggleLanguage("el", checked)}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row language-toggle-en"
            name="language-toggle-en"
            label="English (QWERTY Latin)"
            help="Detects English commands typed on Greek layout (e.g. μψπ → mcp)."
            checked={isEnglishEnabled}
            onChange={(checked) => toggleLanguage("en", checked)}
          />
        </>
      ) : null}
    </section>
  );
}
