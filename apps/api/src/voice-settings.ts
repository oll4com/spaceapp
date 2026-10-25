/**
 * Voice transcription settings view shared by the voice routes and Space Control (moved verbatim from the composition
 * root).
 */
import { type LiveAudioProviderId, voiceTranscriptionMaxBytes, voiceTranscriptionSettingsSchema } from "@space/contracts";
import { nowIso } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import {
  voiceModelVoiceOptions, voiceTranscriptionDelayOptions, voiceTranscriptionLanguageOptions, voiceTranscriptionModelOptions
} from "./voice-transcription.js";

export function buildVoiceTranscriptionSettings(config: SpaceApiConfig) {
  const googleConfigured = Boolean(config.googleVoiceKeyFile || config.googleVoiceApiKey);
  const openaiConfigured = Boolean(config.voiceTranscriptionKeyFile);
  const localConfigured = Boolean(config.localVoiceProviderToken);
  const vercelConfigured = Boolean(config.vercelVoiceKeyFile || config.vercelVoiceApiKey);
  const enabled = config.voiceTranscriptionEnabled && (googleConfigured || openaiConfigured || localConfigured || vercelConfigured);

  const providerOptions: LiveAudioProviderId[] = [];
  if (googleConfigured) providerOptions.push("google");
  if (openaiConfigured) providerOptions.push("openai");
  if (localConfigured) providerOptions.push("local");
  if (vercelConfigured) providerOptions.push("vercel");

  const defaultProvider: LiveAudioProviderId = googleConfigured ? "google" : openaiConfigured ? "openai" : localConfigured ? "local" : "google";

  const configuredNames = providerOptions.map(p => p === "google" ? "Google Gemini Live" : p === "openai" ? "OpenAI Realtime" : p === "local" ? "Local PC (Qwen3 Greek)" : "Vercel AI Gateway");
  const statusReason = !config.voiceTranscriptionEnabled
    ? "Voice transcription is disabled by SPACE_VOICE_TRANSCRIPTION_ENABLED."
    : enabled
      ? `${configuredNames.join(", ")} configured.`
      : "No voice transcription provider credentials configured on Space.";

  const defaultModel = defaultProvider === "google"
    ? "gemini-3.8-live"
    : (config.voiceTranscriptionModel || "gpt-live-1");
  const defaultVoice = defaultProvider === "google"
    ? "Aoede"
    : config.voiceTranscriptionVoice;

  return voiceTranscriptionSettingsSchema.parse({
    enabled,
    statusReason,
    defaultProvider,
    providerOptions,
    defaultModel,
    modelOptions: voiceTranscriptionModelOptions,
    defaultVoice,
    voiceOptions: voiceModelVoiceOptions,
    defaultLanguage: "auto",
    languageOptions: voiceTranscriptionLanguageOptions,
    defaultDelay: config.voiceTranscriptionDelay,
    delayOptions: voiceTranscriptionDelayOptions,
    maxBytes: voiceTranscriptionMaxBytes,
    maxDurationMs: config.voiceTranscriptionMaxDurationMs,
    updatedAt: nowIso()
  });
}
