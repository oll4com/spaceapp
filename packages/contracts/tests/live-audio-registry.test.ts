import { describe, expect, it } from "vitest";
import {
  LIVE_AUDIO_PROVIDERS,
  getAllLiveAudioProviders,
  getDefaultModelForProvider,
  getDefaultVoiceForProvider,
  getLiveAudioProvider,
  getModelsForProvider,
  getVoicesForProvider,
  inferProviderFromModel,
  isLiveAudioProviderId,
  validateLiveAudioConfig,
  voiceRealtimeSessionRequestSchema,
  voiceRealtimeSessionResponseSchema
} from "../src/index.js";

describe("Live Audio Registry and Schemas", () => {
  it("registers all required providers with correct metadata", () => {
    const providers = getAllLiveAudioProviders();
    expect(providers.map((p) => p.id)).toEqual(["openai", "google", "amazon", "local", "fish", "vercel"]);

    const openai = getLiveAudioProvider("openai");
    expect(openai.displayName).toBe("OpenAI");
    expect(openai.transport).toBe("webrtc");
    expect(openai.supportsWebRtc).toBe(true);
    expect(openai.defaultModel).toBe("gpt-live-1");
    expect(openai.defaultVoice).toBe("gleam");

    const google = getLiveAudioProvider("google");
    expect(google.displayName).toBe("Google Gemini");
    expect(google.transport).toBe("websocket");
    expect(google.supportsWebRtc).toBe(false);
    expect(google.supportsWebSocket).toBe(true);
    expect(google.defaultModel).toBe("gemini-3.8-live");
    expect(google.defaultVoice).toBe("Aoede");

    const amazon = getLiveAudioProvider("amazon");
    expect(amazon.displayName).toBe("Amazon Nova");
    expect(amazon.transport).toBe("websocket");
    expect(amazon.supportsWebRtc).toBe(false);
    expect(amazon.supportsWebSocket).toBe(true);
    expect(amazon.defaultModel).toBe("amazon.nova-2-sonic-v1:0");
    expect(amazon.defaultVoice).toBe("en-US-Jenny");

    const local = getLiveAudioProvider("local");
    expect(local.displayName).toContain("Local PC");
    expect(local.defaultModel).toBe("local-qwen3-greek");

    const vercel = getLiveAudioProvider("vercel");
    expect(vercel.displayName).toBe("Vercel AI Gateway");
    expect(vercel.transport).toBe("websocket");
    expect(vercel.supportsWebRtc).toBe(false);
    expect(vercel.supportsWebSocket).toBe(true);
    expect(vercel.defaultModel).toBe("openai/gpt-live-1");
    expect(vercel.defaultVoice).toBe("gleam");

    const fish = getLiveAudioProvider("fish");
    expect(fish.defaultModel).toBe("drama-3");
    expect(fish.voices.map((v) => v.id)).toContain(fish.defaultVoice);
    expect(inferProviderFromModel("drama-3")).toBe("fish");
  });

  it("lists verified model IDs for each provider", () => {
    const openaiModels = getModelsForProvider("openai").map((m) => m.id);
    expect(openaiModels).toContain("gpt-live-1");
    expect(openaiModels).toContain("gpt-4o-realtime-preview");
    expect(openaiModels).toContain("gpt-realtime-2.1");

    const googleModels = getModelsForProvider("google").map((m) => m.id);
    expect(googleModels).toContain("gemini-3.8-live");
    expect(googleModels).toContain("gemini-3.8-live-extended-thinking");
    expect(googleModels).toContain("gemini-3.1-flash-live-preview");
    expect(googleModels).toContain("gemini-2.5-flash-native-audio-latest");
    expect(googleModels).toContain("gemini-2.0-flash-exp");

    const amazonModels = getModelsForProvider("amazon").map((m) => m.id);
    expect(amazonModels).toContain("amazon.nova-2-sonic-v1:0");
    expect(amazonModels).toContain("amazon.nova-sonic-v1:0");

    const localModels = getModelsForProvider("local").map((m) => m.id);
    expect(localModels).toContain("local-qwen3-greek");

    const vercelModels = getModelsForProvider("vercel").map((m) => m.id);
    expect(vercelModels).toContain("openai/gpt-live-1");
    expect(vercelModels).toContain("openai/gpt-realtime-2.1");
    expect(vercelModels).toContain("openai/gpt-realtime-mini");
  });

  it("lists distinct voices per provider", () => {
    const openaiVoices = getVoicesForProvider("openai").map((v) => v.id);
    expect(openaiVoices).toContain("gleam");
    expect(openaiVoices).toContain("alloy");

    const googleVoices = getVoicesForProvider("google").map((v) => v.id);
    expect(googleVoices).toContain("Aoede");
    expect(googleVoices).toContain("Puck");
    expect(googleVoices).toContain("Charon");

    const amazonVoices = getVoicesForProvider("amazon").map((v) => v.id);
    expect(amazonVoices).toContain("en-US-Jenny");
    expect(amazonVoices).toContain("Matthew");
    expect(amazonVoices).toContain("Ruth");

    const vercelVoices = getVoicesForProvider("vercel").map((v) => v.id);
    expect(vercelVoices).toContain("gleam");
    expect(vercelVoices).toContain("alloy");
    expect(vercelVoices).toContain("marin");
  });

  it("infers provider from model ID accurately", () => {
    expect(inferProviderFromModel("gpt-live-1")).toBe("openai");
    expect(inferProviderFromModel("gemini-3.8-live")).toBe("google");
    expect(inferProviderFromModel("gemini-3.8-live-extended-thinking")).toBe("google");
    expect(inferProviderFromModel("gemini-3.1-flash-live-preview")).toBe("google");
    expect(inferProviderFromModel("gemini-2.5-flash-native-audio-latest")).toBe("google");
    expect(inferProviderFromModel("gemini-2.0-flash-exp")).toBe("google");
    expect(inferProviderFromModel("amazon.nova-2-sonic-v1:0")).toBe("amazon");
    expect(inferProviderFromModel("amazon.nova-sonic-v1:0")).toBe("amazon");
    expect(inferProviderFromModel("local-qwen3-greek")).toBe("local");
    expect(inferProviderFromModel("openai/gpt-live-1")).toBe("vercel");
    expect(inferProviderFromModel("gpt-live-1 (Vercel)")).toBe("vercel");
    expect(inferProviderFromModel("unknown-model")).toBe("openai");
  });

  it("validates provider capabilities and catches mismatches", () => {
    const validGoogle = validateLiveAudioConfig({
      provider: "google",
      model: "gemini-2.5-flash-native-audio-latest",
      voice: "Aoede"
    });
    expect(validGoogle.valid).toBe(true);
    expect(validGoogle.normalizedConfig.provider).toBe("google");
    expect(validGoogle.normalizedConfig.transport).toBe("websocket");

    const validVercel = validateLiveAudioConfig({
      provider: "vercel",
      model: "openai/gpt-live-1",
      voice: "gleam"
    });
    expect(validVercel.valid).toBe(true);
    expect(validVercel.normalizedConfig.provider).toBe("vercel");
    expect(validVercel.normalizedConfig.transport).toBe("websocket");

    const invalidWebRtcOnVercel = validateLiveAudioConfig({
      provider: "vercel",
      transport: "webrtc"
    });
    expect(invalidWebRtcOnVercel.valid).toBe(false);
    expect(invalidWebRtcOnVercel.error).toContain("does not support WebRTC transport");

    const invalidWebRtcOnGoogle = validateLiveAudioConfig({
      provider: "google",
      transport: "webrtc"
    });
    expect(invalidWebRtcOnGoogle.valid).toBe(false);
    expect(invalidWebRtcOnGoogle.error).toContain("does not support WebRTC transport");

    const invalidModelOnAmazon = validateLiveAudioConfig({
      provider: "amazon",
      model: "gpt-live-1"
    });
    expect(invalidModelOnAmazon.valid).toBe(false);
    expect(invalidModelOnAmazon.error).toContain("is not supported by provider \"Amazon Nova\"");
  });

  it("validates voiceRealtimeSessionRequestSchema with backwards compatibility", () => {
    const legacyPayload = {
      offerSdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Space Voice\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      model: "gpt-live-1",
      language: "el"
    };
    const parsedLegacy = voiceRealtimeSessionRequestSchema.parse(legacyPayload);
    expect(parsedLegacy.provider).toBe("openai");
    expect(parsedLegacy.offerSdp).toBe(legacyPayload.offerSdp);

    const googlePayload = {
      provider: "google",
      model: "gemini-2.5-flash-native-audio-latest",
      voice: "Aoede",
      language: "el"
    };
    const parsedGoogle = voiceRealtimeSessionRequestSchema.parse(googlePayload);
    expect(parsedGoogle.provider).toBe("google");
    expect(parsedGoogle.model).toBe("gemini-2.5-flash-native-audio-latest");
    expect(parsedGoogle.offerSdp).toBeUndefined();

    const responsePayload = {
      answerSdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=OpenAI\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
      provider: "openai"
    };
    const parsedResponse = voiceRealtimeSessionResponseSchema.parse(responsePayload);
    expect(parsedResponse.answerSdp).toBeDefined();

    const wsResponsePayload = {
      websocketUrl: "wss://generativelanguage.googleapis.com/ws/...",
      sessionId: "gemini_sess_123",
      provider: "google"
    };
    const parsedWsResponse = voiceRealtimeSessionResponseSchema.parse(wsResponsePayload);
    expect(parsedWsResponse.websocketUrl).toBe("wss://generativelanguage.googleapis.com/ws/...");
  });
});
