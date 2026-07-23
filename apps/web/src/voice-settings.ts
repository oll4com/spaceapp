import type { VoiceTranscriptionDelay, VoiceTranscriptionLanguage, VoiceTranscriptionModel } from "@space/contracts";
import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const VOICE_SETTINGS_STORAGE_KEY = "space.voiceTranscription.settings";
export const VOICE_SETTINGS_UPDATED_EVENT = "space:voice-transcription-settings-updated";

export type VoiceInsertMode = "append" | "replace";

export interface VoiceComposerSettings {
  enabled: boolean;
  model: VoiceTranscriptionModel;
  language: VoiceTranscriptionLanguage;
  delay: VoiceTranscriptionDelay;
  insertMode: VoiceInsertMode;
  autoSend: boolean;
}

export const defaultVoiceComposerSettings: VoiceComposerSettings = {
  enabled: true,
  model: "gpt-realtime-whisper",
  language: "auto",
  delay: "minimal",
  insertMode: "append",
  autoSend: false
};

const voiceModels = new Set<VoiceTranscriptionModel>(["gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
const voiceLanguages = new Set<VoiceTranscriptionLanguage>(["auto", "el", "en"]);
const voiceDelays = new Set<VoiceTranscriptionDelay>(["minimal", "low", "medium", "high", "xhigh"]);
const voiceInsertModes = new Set<VoiceInsertMode>(["append", "replace"]);

export function readVoiceComposerSettings(): VoiceComposerSettings {
  if (typeof window === "undefined") return defaultVoiceComposerSettings;
  try {
    const parsed = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<VoiceComposerSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultVoiceComposerSettings.enabled,
      model: parsed.model && voiceModels.has(parsed.model) ? parsed.model : defaultVoiceComposerSettings.model,
      language: parsed.language && voiceLanguages.has(parsed.language) ? parsed.language : defaultVoiceComposerSettings.language,
      delay: parsed.delay && voiceDelays.has(parsed.delay) ? parsed.delay : defaultVoiceComposerSettings.delay,
      insertMode: parsed.insertMode && voiceInsertModes.has(parsed.insertMode) ? parsed.insertMode : defaultVoiceComposerSettings.insertMode,
      autoSend: typeof parsed.autoSend === "boolean" ? parsed.autoSend : defaultVoiceComposerSettings.autoSend
    };
  } catch {
    return defaultVoiceComposerSettings;
  }
}

export function writeVoiceComposerSettings(settings: VoiceComposerSettings) {
  getSpaceRuntime().platform.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_UPDATED_EVENT, { detail: settings }));
}
