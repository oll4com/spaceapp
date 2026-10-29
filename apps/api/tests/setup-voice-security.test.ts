import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { getApiConfig } from "../src/config.js";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import { SetupVoiceVerification } from "../src/setup-voice-verification.js";

describe("voice endpoint boundary", () => {
  it.each([
    { providerId: "local" as const, modelId: "local-qwen3-greek", voiceId: "default" },
    { providerId: "vercel" as const, modelId: "openai/gpt-live-1", voiceId: "gleam" },
    { providerId: "vercel" as const, modelId: "openai/gpt-realtime-2.1", voiceId: "alloy" }
  ])("never forwards $providerId owner credentials through an HTTP redirect", async choice => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-redirect-"));
    let externalRequests = 0;
    const external = createServer((request, response) => { externalRequests++; request.resume(); response.end("{}"); });
    external.listen(0, "127.0.0.1"); await once(external, "listening");
    const provider = createServer((request, response) => {
      request.resume(); response.writeHead(307, { Location: `http://127.0.0.1:${(external.address() as { port: number }).port}/capture` }); response.end();
    });
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const config = getApiConfig({ SPACE_LOCAL_VOICE_PROVIDER_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
      SPACE_VERCEL_VOICE_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}` });
    const store = new InMemorySpaceStore();
    const credentials = new SetupVoiceCredentials(root, config);
    const { credentialRef } = await credentials.save("user:one", choice.providerId === "local" ? { providerId: "local", token: "owned-redirect-fixture" } : { providerId: "vercel", apiKey: "owned-redirect-fixture" });
    const draft = await new SetupExecutionCoordinator(store).updateDraft("user:one", null, { persona: "everyday", level: "balanced",
      requestedFeatureIds: ["pane:live"], connectionChoices: [{ featureId: "pane:live", ...choice, credentialRef }] });
    const service = new SetupVoiceVerification({ store, credentials, config });
    try {
      await expect(service.begin("user:one", draft.revision)).rejects.toThrow();
      expect(externalRequests).toBe(0);
      expect(await service.currentFingerprint("user:one")).toBeNull();
    } finally {
      service.close();
      await new Promise<void>(resolve => provider.close(() => resolve()));
      await new Promise<void>(resolve => external.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
