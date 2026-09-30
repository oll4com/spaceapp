import { controlVoicePreferencePatchSchema, voiceTranscriptionSettingsSchema, voiceTranscriptionModelSchema,
  voiceModelVoiceSchema, voiceTranscriptionLanguageSchema } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { readVoiceComposerSettings, writeVoiceComposerSettings } from "../../voice-settings.js";

export async function applyControlVoicePreferences(input: unknown, isCurrent: () => boolean) {
  if (getSpaceRuntime().kind !== "live" || !isCurrent()) throw new Error("The selected Space control client is no longer active.");
  const patch = controlVoicePreferencePatchSchema.parse(input);
  // The running installation is the availability source, not a duplicate model
  // list in the voice tool prompt. Lookup failure must not select a fallback.
  if (patch.model !== undefined || patch.voice !== undefined || patch.language !== undefined || patch.enabled === true) {
    const capabilities = voiceTranscriptionSettingsSchema.parse(await api.voiceTranscriptionSettings());
    if (patch.enabled === true && !capabilities.enabled) throw new Error("Voice input is unavailable in this installation.");
    if (patch.model !== undefined && !capabilities.modelOptions.includes(voiceTranscriptionModelSchema.parse(patch.model))) throw new Error("The requested voice model is not available. No preference was changed.");
    if (patch.voice !== undefined && !capabilities.voiceOptions?.includes(voiceModelVoiceSchema.parse(patch.voice))) throw new Error("The requested voice profile is not available. No preference was changed.");
    if (patch.language !== undefined && !capabilities.languageOptions.includes(voiceTranscriptionLanguageSchema.parse(patch.language))) throw new Error("The requested voice language is not available. No preference was changed.");
  }
  // Recheck room, focus and command expiry after the asynchronous lookup.
  if (!isCurrent()) throw new Error("The selected Space control client changed or the command expired. No preference was changed.");
  const current = readVoiceComposerSettings({ strict: true });
  const next = { ...current, ...patch,
    model: patch.model === undefined ? current.model : voiceTranscriptionModelSchema.parse(patch.model),
    voice: patch.voice === undefined ? current.voice : voiceModelVoiceSchema.parse(patch.voice),
    language: patch.language === undefined ? current.language : voiceTranscriptionLanguageSchema.parse(patch.language) };
  writeVoiceComposerSettings(next);
  const readBack = readVoiceComposerSettings({ strict: true });
  if (Object.keys(next).some(key => readBack[key as keyof typeof next] !== next[key as keyof typeof next])) {
    throw new Error("Voice preference read-back did not match the requested update. Inspect preferences before retrying.");
  }
  return { ok: true, evidence: { applied: true, persisted: true, scope: "BROWSER_VOICE_COMPOSER", changesActiveLiveSession: false,
    preferences: Object.fromEntries(Object.keys(patch).map(key => [key, readBack[key as keyof typeof readBack]])) } };
}
