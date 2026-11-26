import { inferProviderFromModel } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import type { SetupVoiceCredentials } from "./setup-voice-credentials.js";
import { createLocalVoiceSession, createVoiceRealtimeCall, getLiveAudioProvidersStatus, resolveLiveAudioCredentials, type VoiceRealtimeCallInput } from "./voice-transcription.js";

/** Resolve only the caller's encrypted connection, then installation-authorized scope. */
export class SetupOwnerVoiceRuntime {
  constructor(private readonly options: { config: SpaceApiConfig; credentials: SetupVoiceCredentials }) {}
  async call(ownerId: string, input: VoiceRealtimeCallInput) {
    const provider = input.provider ?? inferProviderFromModel(input.model);
    const credential = await this.options.credentials.resolve(ownerId, provider);
    return createVoiceRealtimeCall(this.options.config, input, credential ?? undefined);
  }
  async localSession(ownerId: string, input: Record<string, unknown>) {
    const credential = await this.options.credentials.resolve(ownerId, "local");
    if (!credential) throw new Error("Connect the approved Local voice service in Setup & connections first.");
    return createLocalVoiceSession({ ...this.options.config, localVoiceProviderToken: credential.apiKey }, input);
  }
  /** Nous Live's relay: an OpenAI realtime client secret minted with the caller's key, else Space's (a key without room fails here). */
  async openaiRealtime(ownerId: string, model: string) {
    const credential = await this.options.credentials.resolve(ownerId, "openai") ?? await resolveLiveAudioCredentials(this.options.config, "openai");
    if (!credential.apiKey) throw new Error("missingReason" in credential && credential.missingReason ? credential.missingReason : "No OpenAI key is connected.");
    const base = this.options.config.voiceTranscriptionBaseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/realtime/client_secrets`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.options.config.voiceTranscriptionTimeoutMs),
      headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ session: { type: "realtime", model } }) });
    const body = await response.json().catch(() => null) as { value?: string; error?: { message?: string } } | null;
    if (!response.ok || !body?.value) throw new Error(`OpenAI: ${body?.error?.message ?? `HTTP ${response.status}`}`);
    return { websocketUrl: `${base.replace(/^http/, "ws")}/realtime?model=${encodeURIComponent(model)}`, token: body.value };
  }
  async status(ownerId: string) {
    const installed = await getLiveAudioProvidersStatus(this.options.config);
    const scoped = await this.options.credentials.providers(ownerId);
    return { providers: installed.providers.map(provider => {
      const connection = scoped.find(item => item.id === provider.id);
      return connection?.configured ? { ...provider, configured: true, missingReason: undefined } : provider;
    }) };
  }
}
