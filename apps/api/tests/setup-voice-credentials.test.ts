import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as voice from "../src/setup-voice-credentials.js";
import { getApiConfig } from "../src/config.js";

describe("owner voice credentials", () => {
  it("stores keys encrypted, scopes them to their owner and keeps provider summaries secret-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-credentials-"));
    try {
      const service = new voice.SetupVoiceCredentials(root, getApiConfig({}));
      await service.save("user:one", { providerId: "google", apiKey: "private-test-key-do-not-display" });
      expect((await service.resolve("user:one", "google"))?.apiKey).toBe("private-test-key-do-not-display");
      expect(await service.resolve("user:two", "google")).toBeNull();
      const providers = await service.providers("user:one");
      expect(providers.find(item => item.id === "google")).toMatchObject({ configured: true, credentialSource: "OWNER" });
      expect(providers.find(item => item.id === "google")).toMatchObject({ setupVerificationSupported: true });
      expect(providers.find(item => item.id === "amazon")).toMatchObject({ setupVerificationSupported: false,
        setupUnavailableReason: expect.any(String) });
      expect(JSON.stringify(providers)).not.toContain("private-test-key");
      expect(providers.flatMap(item => item.models).every(model => model.capabilities.bidirectionalAudio && model.capabilities.speechToSpeech)).toBe(true);
      for (const file of await readdir(join(root, "credentials"))) {
        expect(await readFile(join(root, "credentials", file), "utf8")).not.toContain("private-test-key");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects unneeded secret fields and keeps local endpoints under installation policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-validation-"));
    try {
      const service = new voice.SetupVoiceCredentials(root, getApiConfig({}));
      await expect(service.save("user:one", { providerId: "local", token: "test-local-token", endpoint: "http://untrusted.test" } as never)).rejects.toThrow();
      await service.save("user:one", { providerId: "local", token: "test-local-token" });
      expect(await service.resolve("user:one", "local")).toMatchObject({ apiKey: "test-local-token" });
      await expect(service.save("user:one", { providerId: "amazon", accessKeyId: "test", secretAccessKey: "secret" } as never)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
