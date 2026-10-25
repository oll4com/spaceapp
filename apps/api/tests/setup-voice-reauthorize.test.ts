import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import { SetupVoiceVerification } from "../src/setup-voice-verification.js";
import { getApiConfig } from "../src/config.js";

// Review 2026-10-21 #4: finishing must ask the provider whether the saved Live connection still works; an unchanged local
// key is not proof. The check opens the provider session and closes it once the provider confirms it; no audio is sent.
describe("Live connection reauthorization at finish", () => {
  it("is true only while the provider accepts the saved key, and sends no audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-voice-reauth-"));
    let acceptedKey = "private-cloud-fixture"; let audioMessages = 0; let sessions = 0;
    const provider = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const upstream = new WebSocketServer({ server: provider });
    upstream.on("connection", (socket, request) => {
      sessions++;
      const key = new URL(request.url!, "http://fixture").searchParams.get("key");
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.setup) {
          if (key === acceptedKey) socket.send(JSON.stringify({ setupComplete: {} }));
          else socket.close(1008, "API key not valid");
        } else audioMessages++;
      });
    });
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    try {
      const config = getApiConfig({ SPACE_GOOGLE_VOICE_BASE_URL: endpoint });
      const credentials = new SetupVoiceCredentials(root, config);
      const { credentialRef } = await credentials.save("user:owner", { providerId: "google", apiKey: "private-cloud-fixture" });
      const store = new InMemorySpaceStore();
      await new SetupExecutionCoordinator(store).updateDraft("user:owner", null, { persona: "creator", level: "balanced",
        requestedFeatureIds: ["pane:live"], connectionChoices: [{ featureId: "pane:live", providerId: "google",
          modelId: "gemini-3.8-live", voiceId: "Aoede", credentialRef }] });
      const verification = new SetupVoiceVerification({ store, credentials, config });
      expect(await verification.reauthorize("user:owner")).toBe(true);
      acceptedKey = "revoked-at-the-provider";
      expect(await verification.reauthorize("user:owner")).toBe(false);
      expect(await verification.reauthorize("user:nobody")).toBe(false);
      expect(sessions).toBe(2);
      expect(audioMessages).toBe(0);
    } finally {
      upstream.close(); provider.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
