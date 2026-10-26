import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getApiConfig } from "../src/config.js";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import * as runtime from "../src/setup-owner-voice-runtime.js";

describe("owner credentials in normal voice sessions", () => {
  it("uses encrypted OpenAI and Local keys for their owner without changing installation credentials", async () => {
    const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=voice-answer\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const root = await mkdtemp(join(tmpdir(), "setup-owner-voice-runtime-"));
    const authorizations: string[] = [];
    const server = createServer((request, response) => {
      authorizations.push(String(request.headers.authorization ?? request.headers["x-local-voice-token"]));
      request.resume(); response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.url?.includes("local") ? { websocket_url: "/audio" } : { transport: { sdp: answerSdp } }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = getApiConfig({ SPACE_VOICE_TRANSCRIPTION_BASE_URL: `${endpoint}/v1`, SPACE_LOCAL_VOICE_PROVIDER_URL: endpoint });
    const credentials = new SetupVoiceCredentials(root, config);
    await credentials.save("user:one", { providerId: "openai", apiKey: "owner-openai-fixture" });
    await credentials.save("user:one", { providerId: "local", token: "owner-local-fixture" });
    const service = new runtime.SetupOwnerVoiceRuntime({ config, credentials });
    try {
      const openai = await service.call("user:one", { provider: "openai", model: "gpt-live-1", voice: "gleam", language: "en",
        offerSdp: "v=0\r\ns=microphone\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", prompt: "Reply briefly." });
      expect(openai).toMatchObject({ provider: "openai", answerSdp });
      const local = await service.localSession("user:one", { language: "en-US" });
      expect(local.websocket_url).toBe(`${endpoint.replace("http:", "ws:")}/audio`);
      expect(authorizations).toEqual(["Bearer owner-openai-fixture", "owner-local-fixture"]);
      expect(config.voiceTranscriptionKeyFile).toBeNull(); expect(config.localVoiceProviderToken).toBeNull();
      await expect(service.call("user:two", { provider: "openai", model: "gpt-live-1", language: "en", offerSdp: "v=0\r\n" })).rejects.toThrow();
      await expect(service.localSession("user:two", {})).rejects.toThrow();
      const status = await service.status("user:one");
      expect(status.providers.find(item => item.id === "openai")?.configured).toBe(true);
      expect(status.providers.find(item => item.id === "local")?.configured).toBe(true);
      expect(JSON.stringify(status)).not.toContain("owner-openai-fixture");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
