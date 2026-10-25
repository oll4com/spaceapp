import { LIVE_AUDIO_PROVIDERS, type LiveAudioProviderId } from "@space/contracts";

const unavailableReasons = new Set(["provider_quota_exhausted", "provider_auth_failed"]);
const unavailableUntil = new Map<LiveAudioProviderId, number>();
/** How long a provider without credits (or with a rejected key) is passed over before it is tried again. */
export const VOICE_PROVIDER_RECHECK_MS = 10 * 60_000;
/** Providers voice input can fall back to, in order. */
const fallbackOrder: LiveAudioProviderId[] = ["openai", "google"];

/**
 * Why Space's voice relay closed a provider session, when it knows: the relay sends fixed reason codes
 * (apps/api/src/voice-ws-proxy.ts), never the provider's own text. Null for any other close.
 */
export function voiceRelayCloseExplanation(reason: string | undefined, provider: string): string | null {
  if (reason === "provider_quota_exhausted") {
    return `${provider} is unavailable: the credits of Space's voice key are used up. Top up its billing (Google AI Studio for Gemini) or choose another voice provider in Settings.`;
  }
  if (reason === "provider_auth_failed") return `${provider} rejected Space's voice key. Check the voice key on the server.`;
  return null;
}

/** Remembers, for this page, that a provider has no credits or rejected its key. */
export function noteVoiceRelayClose(provider: LiveAudioProviderId, reason: string | undefined, now = Date.now()): void {
  if (reason && unavailableReasons.has(reason)) unavailableUntil.set(provider, now + VOICE_PROVIDER_RECHECK_MS);
}

export function voiceProviderUnavailable(provider: LiveAudioProviderId, now = Date.now()): boolean {
  const until = unavailableUntil.get(provider);
  if (until === undefined) return false;
  if (until > now) return true;
  unavailableUntil.delete(provider);
  return false;
}

export function resetVoiceProviderAvailability(): void {
  unavailableUntil.clear();
}

export interface VoiceProviderChoice {
  provider: LiveAudioProviderId;
  model: string;
  voice?: string;
  /** The preferred provider that was passed over, when another one is used instead. */
  fallbackFrom: LiveAudioProviderId | null;
}

/**
 * The provider a voice input session uses: the operator's choice, unless that provider has no credits (or rejected
 * its key) in this page and another configured provider can take over with its default model and voice. The stored
 * preference never changes.
 */
export function resolveVoiceProvider(preferred: { provider: LiveAudioProviderId; model: string; voice?: string },
  configured: readonly LiveAudioProviderId[] | undefined, now = Date.now()): VoiceProviderChoice {
  if (!voiceProviderUnavailable(preferred.provider, now)) return { ...preferred, fallbackFrom: null };
  const next = fallbackOrder.find((provider) => provider !== preferred.provider && configured?.includes(provider) && !voiceProviderUnavailable(provider, now));
  if (!next) return { ...preferred, fallbackFrom: null };
  const descriptor = LIVE_AUDIO_PROVIDERS[next];
  return { provider: next, model: descriptor.defaultModel, voice: descriptor.defaultVoice, fallbackFrom: preferred.provider };
}

export function voiceProviderLabel(provider: LiveAudioProviderId): string {
  return provider === "google" ? "Google Gemini Live" : LIVE_AUDIO_PROVIDERS[provider]?.displayName ?? provider;
}
