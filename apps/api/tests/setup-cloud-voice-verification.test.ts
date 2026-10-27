import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import { SetupVoiceCredentials } from "../src/setup-voice-credentials.js";
import { SetupVoiceVerification } from "../src/setup-voice-verification.js";
import { getApiConfig } from "../src/config.js";

describe("cloud voice setup duplex checks", () => {
  it.each([
    { providerId: "google" as const, modelId: "gemini-3.8-live", voiceId: "Aoede" },
    { providerId: "openai" as const, modelId: "gpt-live-1", voiceId: "gleam" },
    { providerId: "vercel" as const, modelId: "openai/gpt-live-1", voiceId: "gleam" },
    { providerId: "openai" as const, modelId: "gpt-realtime-2.1", voiceId: "alloy" },
    { providerId: "vercel" as const, modelId: "openai/gpt-realtime-2.1", voiceId: "alloy" }
  ])("verifies $providerId/$modelId with its selected model and owner connection without exposing the credential", async choice => {
    const root = await mkdtemp(join(tmpdir(), "setup-cloud-audio-"));
    let selectedModel = ""; let selectedVoice = ""; let inputBytes = 0; let keyWasAuthorized = false;
    const provider = createServer((request, response) => {
      keyWasAuthorized = request.headers.authorization === "Bearer private-cloud-fixture";
      request.resume(); response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "ephemeral-fixture", expiresAt: Date.now() + 60_000 }));
    });
    const upstream = new WebSocketServer({ server: provider });
    upstream.on("connection", (socket, request) => {
      if (choice.providerId === "google") keyWasAuthorized = new URL(request.url!, "http://fixture").searchParams.get("key") === "private-cloud-fixture";
      if (choice.providerId === "openai") keyWasAuthorized = request.headers.authorization === "Bearer private-cloud-fixture";
      if (choice.providerId === "vercel") expect(request.headers["sec-websocket-protocol"]).toContain("ai-gateway-auth.ephemeral-fixture");
      socket.on("message", data => {
        const message = JSON.parse(data.toString());
        if (message.setup) {
          selectedModel = message.setup.model; selectedVoice = message.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
          socket.send(JSON.stringify({ setupComplete: {} }));
        } else if (message.type === "session.start") {
          selectedModel = message.session.model; selectedVoice = message.session.audio.output.voice;
          socket.send(JSON.stringify({ type: "session.started" }));
        } else if (message.type === "session.update") {
          selectedModel = new URL(request.url!, "http://fixture").searchParams.get("model")!;
          selectedVoice = message.session.audio.output.voice;
          socket.send(JSON.stringify({ type: "session.updated" }));
        } else if (message.type === "session-update") {
          selectedModel = new URL(request.url!, "http://fixture").searchParams.get("ai-model-id")!;
          selectedVoice = message.config.voice;
          socket.send(JSON.stringify({ type: "session-updated" }));
        } else {
          const audio = message.realtimeInput?.audio?.data ?? message.audio;
          if (typeof audio !== "string") return;
          inputBytes += Buffer.from(audio, "base64").length;
          const reply = Buffer.alloc(19_200, 8).toString("base64");
          if (choice.providerId === "google") socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: "test speech" },
            modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: reply } }] } } }));
          else if (choice.providerId === "vercel" && choice.modelId.includes("realtime")) {
            socket.send(JSON.stringify({ type: "audio-delta", delta: reply }));
            socket.send(JSON.stringify({ type: "input-transcription-completed", itemId: "fixture-input", transcript: "test speech" }));
          } else if (choice.modelId.includes("realtime")) {
            socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "test speech" }));
            socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: reply }));
          } else {
            socket.send(JSON.stringify({ type: "session.input_transcript.delta", delta: "test speech" }));
            socket.send(JSON.stringify({ type: "session.output_audio.delta", delta: reply }));
          }
        }
      });
    });
    provider.listen(0, "127.0.0.1"); await once(provider, "listening");
    const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const config = getApiConfig({ SPACE_GOOGLE_VOICE_BASE_URL: endpoint, SPACE_VOICE_TRANSCRIPTION_BASE_URL: `${endpoint}/v1`, SPACE_VERCEL_VOICE_BASE_URL: endpoint });
    const credentials = new SetupVoiceCredentials(root, config);
    const { credentialRef } = await credentials.save("user:owner", { providerId: choice.providerId, apiKey: "private-cloud-fixture" });
    const store = new InMemorySpaceStore();
    const draft = await new SetupExecutionCoordinator(store).updateDraft("user:owner", null, { persona: "creator", level: "balanced",
      requestedFeatureIds: ["pane:live"], connectionChoices: [{ featureId: "pane:live", ...choice, credentialRef }] });
    const service = new SetupVoiceVerification({ store, credentials, config });
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(relay, "listening");
    let browser: WebSocket | undefined;
    try {
      const check = await service.begin("user:owner", draft.revision);
      expect(JSON.stringify(check)).not.toContain("private-cloud-fixture");
      relay.on("connection", socket => { void service.attach("user:owner", check.checkId, socket); });
      browser = new WebSocket(`ws://127.0.0.1:${(relay.address() as { port: number }).port}`); await once(browser, "open");
      const ready = new Promise<void>(resolve => browser!.on("message", (data, binary) => { if (!binary && JSON.parse(data.toString()).type === "listening") resolve(); }));
      await ready;
      const response = new Promise<number>(resolve => browser!.on("message", (data, binary) => { if (binary) resolve((data as Buffer).length); }));
      browser.send(Buffer.alloc(12_800, 6)); const playedBytes = await response;
      expect(playedBytes).toBe(12_800);
      expect(inputBytes).toBe(choice.providerId === "google" ? 12_800 : 19_200);
      expect(selectedModel).toBe(choice.providerId === "google" ? "models/gemini-3.8-live" : choice.modelId);
      expect(selectedVoice).toBe(choice.voiceId); expect(keyWasAuthorized).toBe(true);
      expect(await service.currentFingerprint("user:owner")).toBeNull();
      const verified = new Promise<void>(resolve => browser!.on("message", (data, binary) => { if (!binary && JSON.parse(data.toString()).type === "verified") resolve(); }));
      browser.send(JSON.stringify({ type: "playback-complete", playedBytes })); await verified;
      expect(await service.currentFingerprint("user:owner")).toMatch(/^[a-f0-9]{64}$/);
      await credentials.save("user:owner", { providerId: choice.providerId, apiKey: "rotated-cloud-fixture" });
      expect(await service.currentFingerprint("user:owner")).toBeNull();
    } finally {
      service.close(); browser?.terminate(); for (const socket of relay.clients) socket.terminate(); for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>(resolve => relay.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  });
});
