import type { VoiceTranscriptionLanguage } from "@space/contracts";
import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const VOICE_SETTINGS_STORAGE_KEY = "space.voiceTranscription.settings";
export const VOICE_SETTINGS_UPDATED_EVENT = "space:voice-transcription-settings-updated";

export type VoiceInsertMode = "append" | "replace";

export interface VoiceComposerSettings {
  enabled: boolean;
  language: VoiceTranscriptionLanguage;
  insertMode: VoiceInsertMode;
  prewarm: boolean;
  terminalVoiceButton: boolean;
  terminalModelPicker: boolean;
  terminalTurnControl: boolean;
}

export const defaultVoiceComposerSettings: VoiceComposerSettings = {
  enabled: true,
  language: "auto",
  insertMode: "append",
  prewarm: true,
  terminalVoiceButton: true,
  terminalModelPicker: false,
  terminalTurnControl: true
};

const voiceLanguages = new Set<VoiceTranscriptionLanguage>(["auto", "el", "en"]);
const voiceInsertModes = new Set<VoiceInsertMode>(["append", "replace"]);

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readVoiceComposerSettings(): VoiceComposerSettings {
  if (typeof window === "undefined") return defaultVoiceComposerSettings;
  try {
    const parsed = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<VoiceComposerSettings>;
    return {
      enabled: booleanSetting(parsed.enabled, defaultVoiceComposerSettings.enabled),
      language: parsed.language && voiceLanguages.has(parsed.language) ? parsed.language : defaultVoiceComposerSettings.language,
      insertMode: parsed.insertMode && voiceInsertModes.has(parsed.insertMode) ? parsed.insertMode : defaultVoiceComposerSettings.insertMode,
      prewarm: booleanSetting(parsed.prewarm, defaultVoiceComposerSettings.prewarm),
      terminalVoiceButton: booleanSetting(parsed.terminalVoiceButton, defaultVoiceComposerSettings.terminalVoiceButton),
      terminalModelPicker: booleanSetting(parsed.terminalModelPicker, defaultVoiceComposerSettings.terminalModelPicker),
      terminalTurnControl: booleanSetting(parsed.terminalTurnControl, defaultVoiceComposerSettings.terminalTurnControl)
    };
  } catch {
    return defaultVoiceComposerSettings;
  }
}

export function writeVoiceComposerSettings(settings: VoiceComposerSettings) {
  const persisted: VoiceComposerSettings = {
    enabled: settings.enabled,
    language: settings.language,
    insertMode: settings.insertMode,
    prewarm: settings.prewarm,
    terminalVoiceButton: settings.terminalVoiceButton,
    terminalModelPicker: settings.terminalModelPicker,
    terminalTurnControl: settings.terminalTurnControl
  };
  getSpaceRuntime().platform.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
  window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_UPDATED_EVENT, { detail: persisted }));
}
