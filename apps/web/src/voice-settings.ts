import {
  voiceModelVoiceSchema,
  voiceTranscriptionModelSchema,
  isLiveAudioProviderId,
  inferProviderFromModel,
  type LiveAudioProviderId,
  type VoiceModelVoice,
  type VoiceTranscriptionLanguage,
  type VoiceTranscriptionModel
} from "@space/contracts";
import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";
import { api } from "./api.js";

export const VOICE_SETTINGS_STORAGE_KEY = "space.voiceTranscription.settings";
export const VOICE_SETTINGS_UPDATED_EVENT = "space:voice-transcription-settings-updated";

export type VoiceInsertMode = "append" | "replace";

export interface VoiceComposerSettings {
  enabled: boolean;
  provider?: LiveAudioProviderId;
  model: VoiceTranscriptionModel | string;
  voice: VoiceModelVoice | string;
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
  terminalContextMenu?: boolean;
}

export const defaultVoiceComposerSettings: VoiceComposerSettings = {
  enabled: true,
  provider: "google",
  model: "gemini-3.8-live",
  voice: "Aoede",
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
  terminalTurnControl: true,
  terminalContextMenu: true
};

const voiceModels = new Set<string>(voiceTranscriptionModelSchema.options);
const voiceVoices = new Set<VoiceModelVoice>(voiceModelVoiceSchema.options);
const voiceLanguages = new Set<VoiceTranscriptionLanguage>(["auto", "el", "en"]);
const voiceInsertModes = new Set<VoiceInsertMode>(["append", "replace"]);
const delegatedReasoningEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readVoiceComposerSettings(options?: { strict?: boolean }): VoiceComposerSettings {
  if (typeof window === "undefined") {
    if (options?.strict) throw new Error("Voice preference storage is unavailable.");
    return defaultVoiceComposerSettings;
  }
  try {
    const parsed = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "{}") as Partial<VoiceComposerSettings> & { terminalControlsVersion?: number };
    const provider = parsed.provider && isLiveAudioProviderId(parsed.provider)
      ? parsed.provider
      : (parsed.model ? inferProviderFromModel(parsed.model) : defaultVoiceComposerSettings.provider);
    return {
      enabled: booleanSetting(parsed.enabled, defaultVoiceComposerSettings.enabled),
      provider,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : (provider === "google" ? "gemini-3.8-live" : defaultVoiceComposerSettings.model),
      voice: typeof parsed.voice === "string" && parsed.voice.trim() ? parsed.voice.trim() : (provider === "google" ? "Aoede" : defaultVoiceComposerSettings.voice),
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
      terminalTurnControl: booleanSetting(parsed.terminalTurnControl, defaultVoiceComposerSettings.terminalTurnControl),
      terminalContextMenu: booleanSetting(parsed.terminalContextMenu, defaultVoiceComposerSettings.terminalContextMenu ?? true)
    };
  } catch (error) {
    if (options?.strict) throw error;
    return defaultVoiceComposerSettings;
  }
}

export function applyServerVoiceSettings(settings: Partial<VoiceComposerSettings>): void {
  try {
    const full = { ...defaultVoiceComposerSettings, ...settings };
    getSpaceRuntime().platform.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...full, terminalControlsVersion: 2 }));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_UPDATED_EVENT, { detail: full }));
    }
  } catch {
    // Session-only fallback when storage is disabled
  }
}

export function writeVoiceComposerSettings(settings: VoiceComposerSettings) {
  const persisted: VoiceComposerSettings = {
    enabled: settings.enabled,
    provider: settings.provider,
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
    terminalTurnControl: settings.terminalTurnControl,
    terminalContextMenu: booleanSetting(settings.terminalContextMenu, defaultVoiceComposerSettings.terminalContextMenu ?? true)
  };
  getSpaceRuntime().platform.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...persisted, terminalControlsVersion: 2 }));
  window.dispatchEvent(new CustomEvent(VOICE_SETTINGS_UPDATED_EVENT, { detail: persisted }));
  try {
    void api.updateUserSettings({ voice: persisted }).catch(() => {
      // Session/offline fallback
    });
  } catch {
    // Runtime unavailable (e.g. isolated unit tests)
  }
}
