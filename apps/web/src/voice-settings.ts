import type { VoiceModelVoice, VoiceTranscriptionLanguage, VoiceTranscriptionModel } from "@space/contracts";
import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const VOICE_SETTINGS_STORAGE_KEY = "space.voiceTranscription.settings";
export const VOICE_SETTINGS_UPDATED_EVENT = "space:voice-transcription-settings-updated";

export type VoiceInsertMode = "append" | "replace";

export interface VoiceComposerSettings {
  enabled: boolean;
  model: VoiceTranscriptionModel;
  voice: VoiceModelVoice;
  language: VoiceTranscriptionLanguage;
  insertMode: VoiceInsertMode;
  prewarm: boolean;
  opening: string;
  prompt: string;
  delegatedModel: string;
  delegatedType: "responses" | "client";
  delegatedReasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  delegatedWebSearch: boolean;
  delegatedPrompt: string;
  terminalVoiceButton: boolean;
  terminalModelPicker: boolean;
  terminalTurnControl: boolean;
}

export const defaultVoiceComposerSettings: VoiceComposerSettings = {
  enabled: true,
  model: "gpt-transcribe",
  voice: "alloy",
  language: "auto",
  insertMode: "append",
  prewarm: true,
  opening: "",
  prompt: "",
  delegatedModel: "gpt-6-astra",
  delegatedType: "responses",
  delegatedReasoningEffort: "xhigh",
  delegatedWebSearch: true,
  delegatedPrompt: "",
  terminalVoiceButton: true,
  terminalModelPicker: true,
  terminalTurnControl: true
};

const voiceModels = new Set<string>([
  "gpt-transcribe",
  "gpt-live-1",
  "gpt-live-1-mini",
  "gpt-live-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
  "gpt-realtime-whisper"
  ,"local-qwen3-greek"
]);
const voiceVoices = new Set<VoiceModelVoice>([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "bossa",
  "tempo",
  "marin",
  "cedar"
]);
const voiceLanguages = new Set<VoiceTranscriptionLanguage>(["auto", "el", "en"]);
const voiceInsertModes = new Set<VoiceInsertMode>(["append", "replace"]);
const delegatedReasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readVoiceComposerSettings(): VoiceComposerSettings {
  if (typeof window === "undefined") return defaultVoiceComposerSettings;
  try {
    const parsed = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<VoiceComposerSettings> & { terminalControlsVersion?: number };
    return {
      enabled: booleanSetting(parsed.enabled, defaultVoiceComposerSettings.enabled),
      model: parsed.model && voiceModels.has(parsed.model) ? parsed.model : defaultVoiceComposerSettings.model,
      voice: parsed.voice && voiceVoices.has(parsed.voice) ? parsed.voice : defaultVoiceComposerSettings.voice,
      language: parsed.language && voiceLanguages.has(parsed.language) ? parsed.language : defaultVoiceComposerSettings.language,
      insertMode: parsed.insertMode && voiceInsertModes.has(parsed.insertMode) ? parsed.insertMode : defaultVoiceComposerSettings.insertMode,
      prewarm: booleanSetting(parsed.prewarm, defaultVoiceComposerSettings.prewarm),
      opening: typeof parsed.opening === "string" ? parsed.opening : defaultVoiceComposerSettings.opening,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : defaultVoiceComposerSettings.prompt,
      delegatedModel: typeof parsed.delegatedModel === "string" && parsed.delegatedModel.trim() ? parsed.delegatedModel : defaultVoiceComposerSettings.delegatedModel,
      delegatedType: parsed.delegatedType === "client" ? "client" : "responses",
      delegatedReasoningEffort: parsed.delegatedReasoningEffort && delegatedReasoningEfforts.has(parsed.delegatedReasoningEffort)
        ? (parsed.delegatedReasoningEffort as VoiceComposerSettings["delegatedReasoningEffort"])
        : defaultVoiceComposerSettings.delegatedReasoningEffort,
      delegatedWebSearch: booleanSetting(parsed.delegatedWebSearch, defaultVoiceComposerSettings.delegatedWebSearch),
      delegatedPrompt: typeof parsed.delegatedPrompt === "string" ? parsed.delegatedPrompt : defaultVoiceComposerSettings.delegatedPrompt,
      terminalVoiceButton: booleanSetting(parsed.terminalVoiceButton, defaultVoiceComposerSettings.terminalVoiceButton),
      // Enable the new footer shortcut once for existing installations.
      terminalModelPicker: parsed.terminalControlsVersion === 2
        ? booleanSetting(parsed.terminalModelPicker, defaultVoiceComposerSettings.terminalModelPicker)
        : true,
      terminalTurnControl: booleanSetting(parsed.terminalTurnControl, defaultVoiceComposerSettings.terminalTurnControl)
    };
  } catch {
    return defaultVoiceComposerSettings;
  }
}

export function writeVoiceComposerSettings(settings: VoiceComposerSettings) {
  const persisted: VoiceComposerSettings = {
    enabled: settings.enabled,
    model: settings.model,
    voice: settings.voice,
    language: settings.language,
    insertMode: settings.insertMode,
    prewarm: settings.prewarm,
    opening: settings.opening,
    prompt: settings.prompt,
    delegatedModel: settings.delegatedModel,
    delegatedType: settings.delegatedType,
    delegatedReasoningEffort: settings.delegatedReasoningEffort,
    delegatedWebSearch: settings.delegatedWebSearch,
    delegatedPrompt: settings.delegatedPrompt,
    terminalVoiceButton: settings.terminalVoiceButton,
    terminalModelPicker: settings.terminalModelPicker,
    terminalTurnControl: settings.terminalTurnControl
  };
  getSpaceRuntime().platform.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...persisted, terminalControlsVersion: 2 }));
  window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_UPDATED_EVENT, { detail: persisted }));
}
