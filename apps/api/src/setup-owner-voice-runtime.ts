import { inferProviderFromModel } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import type { SetupVoiceCredentials } from "./setup-voice-credentials.js";
import { createLocalVoiceSession, createVoiceRealtimeCall, getLiveAudioProvidersStatus, type VoiceRealtimeCallInput } from "./voice-transcription.js";

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
  async status(ownerId: string) {
    const installed = await getLiveAudioProvidersStatus(this.options.config);
    const scoped = await this.options.credentials.providers(ownerId);
    return { providers: installed.providers.map(provider => {
      const connection = scoped.find(item => item.id === provider.id);
      return connection?.configured ? { ...provider, configured: true, missingReason: undefined } : provider;
    }) };
  }
}
