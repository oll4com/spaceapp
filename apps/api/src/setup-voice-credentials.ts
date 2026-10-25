import { getAllLiveAudioProviders, type LiveAudioProviderId } from "@space/contracts";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SpaceApiConfig } from "./config.js";
import { DemoCredentialStore } from "./demo-projects/credentials.js";
import { resolveLiveAudioCredentials } from "./voice-transcription.js";
import { supportsSetupVoiceProvider, type SetupVoiceCredential } from "./setup-voice-wire.js";

const secret = z.string().trim().min(8).max(8000).refine(value => !/[\r\n\0]/.test(value));
export const setupVoiceCredentialInput = z.discriminatedUnion("providerId", [
  z.object({ providerId: z.literal("openai"), apiKey: secret }).strict(),
  z.object({ providerId: z.literal("google"), apiKey: secret }).strict(),
  z.object({ providerId: z.literal("vercel"), apiKey: secret }).strict(),
  z.object({ providerId: z.literal("local"), token: secret }).strict(),
  z.object({ providerId: z.literal("amazon"), accessKeyId: secret, secretAccessKey: secret,
    sessionToken: secret.optional(), region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/) }).strict()
]);

export type { SetupVoiceCredential };

export class SetupVoiceCredentials {
  private readonly store: DemoCredentialStore;
  private initialized: Promise<void> | null = null;
  constructor(private readonly root: string, private readonly config: SpaceApiConfig) { this.store = new DemoCredentialStore(root); }
  private reference(ownerId: string, providerId: LiveAudioProviderId) {
    return `cred:voice:${createHash("sha256").update(ownerId).digest("hex").slice(0, 32)}:${providerId}`;
  }
  ownsReference(ownerId: string, providerId: LiveAudioProviderId, reference: string) {
    return reference === this.reference(ownerId, providerId);
  }
  async save(ownerId: string, input: unknown): Promise<{ credentialRef: string }> {
    const parsed = setupVoiceCredentialInput.safeParse(input);
    if (!parsed.success || !ownerId) throw new Error("Enter the required credential fields for this voice provider.");
    this.initialized ??= this.store.initialize().catch(error => { this.initialized = null; throw error; });
    await this.initialized;
    const reference = this.reference(ownerId, parsed.data.providerId);
    await this.store.write(reference, parsed.data);
    return { credentialRef: reference };
  }
  async resolve(ownerId: string, providerId: LiveAudioProviderId): Promise<SetupVoiceCredential | null> {
    try {
      await stat(join(this.root, "master.key"));
      const record = setupVoiceCredentialInput.parse(await this.store.read(this.reference(ownerId, providerId)));
      if (record.providerId !== providerId) throw new Error("The voice connection scope is invalid.");
      return { source: "OWNER", apiKey: "apiKey" in record ? record.apiKey : "token" in record ? record.token : record.accessKeyId,
        ...(record.providerId === "amazon" ? { secretAccessKey: record.secretAccessKey, region: record.region, sessionToken: record.sessionToken } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved voice connection could not be read securely.");
    }
    const installed = await resolveLiveAudioCredentials(this.config, providerId);
    if (!installed.configured || !installed.apiKey) return null;
    return { apiKey: installed.apiKey, source: "INSTALLATION", ...(providerId === "amazon" ? {
      secretAccessKey: this.config.awsSecretAccessKey ?? undefined, region: this.config.awsRegion
    } : {}) };
  }
  async providers(ownerId: string) {
    return Promise.all(getAllLiveAudioProviders().map(async provider => {
      const credential = await this.resolve(ownerId, provider.id);
      const { credentialEnvVars: _env, credentialKeyFiles: _files, ...publicProvider } = provider;
      return { ...publicProvider, models: provider.models.filter(model => model.capabilities.bidirectionalAudio && model.capabilities.speechToSpeech),
        configured: Boolean(credential), credentialSource: credential?.source ?? null,
        setupVerificationSupported: supportsSetupVoiceProvider(provider.id),
        setupUnavailableReason: supportsSetupVoiceProvider(provider.id) ? null : "Live verification is unavailable for this provider on this installation. Choose another provider or skip Live for now." };
    }));
  }
}
