import { useCallback, useEffect, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { api } from "../../api.js";

export const KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY = "space.keyboardAutocorrect.settings";
export const KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT = "space:keyboard-autocorrect-settings-updated";

export interface KeyboardAutocorrectSettings {
  /** Master toggle to enable or disable keyboard layout detection and autocorrection. */
  enabled: boolean;
  /** Whether to display the suggestion banner ("Wrong layout? Convert to: ... Alt+G") above composers. */
  showSuggestionBar: boolean;
  /** Whether to display the keyboard icon action button (Alt+G) in the composer toolbar. */
  showComposerIcon: boolean;
  /** Whether to play a gentle audio beep notification whenever layout mismatch indicator activates. */
  soundEnabled: boolean;
  /** List of supported language codes ("el" for Greek, "en" for English QWERTY). */
  supportedLanguages: string[];
}

export const defaultKeyboardAutocorrectSettings: KeyboardAutocorrectSettings = {
  enabled: true,
  showSuggestionBar: true,
  showComposerIcon: true,
  soundEnabled: true,
  supportedLanguages: ["el", "en"]
};

/**
 * Returns true if the composer layout toggle icon should be visible in toolbars.
 * Requires both the master layout autocorrection setting and the composer icon setting to be enabled.
 */
export function isComposerLayoutIconVisible(settings: KeyboardAutocorrectSettings): boolean {
  return Boolean(settings.enabled && settings.showComposerIcon);
}

/**
 * Returns true if the composer layout suggestion bar should be visible above composers.
 * Requires both the master layout autocorrection setting and the suggestion bar setting to be enabled.
 */
export function isComposerSuggestionBarVisible(settings: KeyboardAutocorrectSettings): boolean {
  return Boolean(settings.enabled && settings.showSuggestionBar);
}


function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readKeyboardAutocorrectSettings(): KeyboardAutocorrectSettings {
  if (typeof window === "undefined") {
    return defaultKeyboardAutocorrectSettings;
  }
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY);
    if (!raw) return defaultKeyboardAutocorrectSettings;
    const parsed = JSON.parse(raw) as Partial<KeyboardAutocorrectSettings>;
    const languages = Array.isArray(parsed.supportedLanguages) && parsed.supportedLanguages.length > 0
      ? parsed.supportedLanguages.filter((l): l is string => typeof l === "string")
      : defaultKeyboardAutocorrectSettings.supportedLanguages;

    return {
      enabled: booleanSetting(parsed.enabled, defaultKeyboardAutocorrectSettings.enabled),
      showSuggestionBar: booleanSetting(parsed.showSuggestionBar, defaultKeyboardAutocorrectSettings.showSuggestionBar),
      showComposerIcon: booleanSetting(parsed.showComposerIcon, defaultKeyboardAutocorrectSettings.showComposerIcon),
      soundEnabled: booleanSetting(parsed.soundEnabled, defaultKeyboardAutocorrectSettings.soundEnabled),
      supportedLanguages: languages
    };
  } catch {
    return defaultKeyboardAutocorrectSettings;
  }
}

export function applyServerKeyboardAutocorrectSettings(settings: KeyboardAutocorrectSettings): void {
  try {
    getSpaceRuntime().platform.localStorage.setItem(
      KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings)
    );
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, { detail: settings }));
    }
  } catch {
    // Ignore storage write errors
  }
}

export function writeKeyboardAutocorrectSettings(settings: KeyboardAutocorrectSettings): void {
  try {
    const persisted: KeyboardAutocorrectSettings = {
      enabled: Boolean(settings.enabled),
      showSuggestionBar: Boolean(settings.showSuggestionBar),
      showComposerIcon: Boolean(settings.showComposerIcon),
      soundEnabled: Boolean(settings.soundEnabled),
      supportedLanguages: Array.isArray(settings.supportedLanguages) ? settings.supportedLanguages : ["el", "en"]
    };
    getSpaceRuntime().platform.localStorage.setItem(
      KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY,
      JSON.stringify(persisted)
    );
    window.dispatchEvent(new CustomEvent(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, { detail: persisted }));
    void api.updateUserSettings({ keyboardAutocorrect: persisted }).catch(() => {
      // Session/offline fallback
    });
  } catch {
    // Ignore storage write errors
  }
}

let sharedAudioContext: AudioContext | null = null;

/**
 * Plays a gentle, pleasant notification beep ("pip") when layout mismatch indicator activates.
 * Respects settings unless `force: true` is passed (e.g. for user testing in settings card).
 */
export function playLayoutSuggestionBeep(options?: { force?: boolean }): void {
  try {
    if (typeof window === "undefined") return;

    if (!options?.force) {
      const current = readKeyboardAutocorrectSettings();
      if (!current.enabled || !current.soundEnabled) return;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioContextClass();
    }
    const ctx = sharedAudioContext;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Gentle short chime: E5 (659.25Hz) rising subtly to A5 (880Hz)
    osc.type = "sine";
    osc.frequency.setValueAtTime(659.25, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);

    // Soft attack & quick pleasant decay (90ms total duration)
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.095);
  } catch {
    // Ignore audio errors (headless environments or autoplay blocks)
  }
}

/**
 * Hook to read and subscribe to keyboard autocorrect settings in React components.
 */
export function useKeyboardAutocorrectSettings(): {
  settings: KeyboardAutocorrectSettings;
  updateSettings: (patch: Partial<KeyboardAutocorrectSettings>) => void;
} {
  const [settings, setSettings] = useState<KeyboardAutocorrectSettings>(() => readKeyboardAutocorrectSettings());

  useEffect(() => {
    function handleUpdate(event: Event) {
      if (event instanceof CustomEvent && event.detail) {
        setSettings(event.detail as KeyboardAutocorrectSettings);
      } else {
        setSettings(readKeyboardAutocorrectSettings());
      }
    }
    window.addEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, handleUpdate);
    window.addEventListener("storage", handleUpdate);
    return () => {
      window.removeEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, handleUpdate);
      window.removeEventListener("storage", handleUpdate);
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<KeyboardAutocorrectSettings>) => {
    const next = { ...readKeyboardAutocorrectSettings(), ...patch };
    writeKeyboardAutocorrectSettings(next);
    setSettings(next);
  }, []);

  return { settings, updateSettings };
}
