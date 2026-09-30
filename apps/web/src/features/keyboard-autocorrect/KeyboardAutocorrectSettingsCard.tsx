import { useState } from "react";
import { Keyboard, Volume2, RotateCcw } from "lucide-react";
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
        detail={
          settings.enabled
            ? "Detects wrong keyboard layout and suggests corrections (Alt+G)."
            : "Layout mismatch detection is disabled."
        }
        checked={settings.enabled}
        onChange={(checked) => updateSettings({ enabled: checked })}
      />

      {settings.enabled ? (
        <>
          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-banner-toggle"
            name="keyboard-autocorrect-banner"
            label="Show suggestion banner"
            detail={
              settings.showSuggestionBar
                ? "Displays conversion preview with Alt+G above composers."
                : "Suggestion banner is hidden (Alt+G shortcut remains active)."
            }
            checked={settings.showSuggestionBar}
            onChange={(checked) => updateSettings({ showSuggestionBar: checked })}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-icon-toggle"
            name="keyboard-autocorrect-icon"
            label="Show composer keyboard icon"
            detail={
              settings.showComposerIcon
                ? "Displays the Alt+G toggle button in composer action bars."
                : "Hides the layout toggle button from composer toolbars."
            }
            checked={settings.showComposerIcon}
            onChange={(checked) => updateSettings({ showComposerIcon: checked })}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row keyboard-autocorrect-sound-toggle"
            name="keyboard-autocorrect-sound"
            label="Audio alert on detection"
            detail={
              settings.soundEnabled
                ? "Plays a subtle chime when wrong layout is detected."
                : "Layout detection is silent without audio chime."
            }
            checked={settings.soundEnabled}
            onChange={(checked) => updateSettings({ soundEnabled: checked })}
          />

          {settings.soundEnabled ? (
            <div className="settings-flat-row keyboard-autocorrect-sound-preview-row">
              <span className="settings-flat-row-copy">
                <strong>Chime preview</strong>
                <small>Test the notification sound.</small>
              </span>
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

          <div className="settings-flat-subheading">
            <strong>Supported languages</strong>
            <small>Select layouts to monitor and convert between.</small>
          </div>

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row language-toggle-el"
            name="language-toggle-el"
            label="Greek (Ελληνικά)"
            detail="Detects Greek typed on QWERTY and converts tonos & dialytika."
            checked={isGreekEnabled}
            onChange={(checked) => toggleLanguage("el", checked)}
          />

          <SpaceToggle
            className="settings-flat-row settings-flat-toggle-row language-toggle-en"
            name="language-toggle-en"
            label="English (QWERTY Latin)"
            detail="Detects English commands typed on Greek layout (e.g. μψπ → mcp)."
            checked={isEnglishEnabled}
            onChange={(checked) => toggleLanguage("en", checked)}
          />
        </>
      ) : null}
    </section>
  );
}
