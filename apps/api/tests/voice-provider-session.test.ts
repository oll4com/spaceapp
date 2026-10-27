import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiConfig } from "../src/config.js";
import {
  createVoiceRealtimeCall,
  delegatedReasoningEffort,
  getLiveAudioProvidersStatus,
  resolveLiveAudioCredentials
} from "../src/voice-transcription.js";
import { clearDelegatedModelVerdicts } from "../src/live-openai-model-fallback.js";

describe("Voice Provider Session Routing and Credentials", () => {
  it("resolves status for all supported providers", async () => {
    const config = getApiConfig({});
    const status = await getLiveAudioProvidersStatus(config);
    expect(status.providers.map((p) => p.id)).toEqual(["openai", "google", "amazon", "local", "fish", "vercel"]);

    const openai = status.providers.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai?.displayName).toBe("OpenAI");
    expect(openai?.transport).toBe("webrtc");
    expect(openai?.defaultModel).toBe("gpt-live-1");

    const google = status.providers.find((p) => p.id === "google");
    expect(google).toBeDefined();
    expect(google?.displayName).toBe("Google Gemini");
    expect(google?.transport).toBe("websocket");
    expect(google?.defaultModel).toBe("gemini-3.8-live");
    expect(google?.configured).toBe(false);
    expect(google?.missingReason).toContain("SPACE_GOOGLE_VOICE_KEY_FILE or GEMINI_API_KEY");

    const amazon = status.providers.find((p) => p.id === "amazon");
    expect(amazon).toBeDefined();
    expect(amazon?.displayName).toBe("Amazon Nova");
    expect(amazon?.transport).toBe("websocket");
    expect(amazon?.defaultModel).toBe("amazon.nova-2-sonic-v1:0");
    expect(amazon?.configured).toBe(false);
    expect(amazon?.missingReason).toContain("AWS_ACCESS_KEY_ID");

    const vercel = status.providers.find((p) => p.id === "vercel");
    expect(vercel).toBeDefined();
    expect(vercel?.displayName).toBe("Vercel AI Gateway");
    expect(vercel?.transport).toBe("websocket");
    expect(vercel?.defaultModel).toBe("openai/gpt-live-1");
  });

  it("blocks Google Live session when credentials are not configured", async () => {
    const config = getApiConfig({});
    await expect(
      createVoiceRealtimeCall(config, {
        provider: "google",
        model: "gemini-3.8-live",
        language: "el"
      })
    ).rejects.toThrow("Google Gemini Live credentials not configured on Space");
  });

  it("initializes Google Live session when Gemini credentials are provided", async () => {
    const config = getApiConfig({
      GEMINI_API_KEY: "test-gemini-key-12345"
    });
    const session = await createVoiceRealtimeCall(config, {
      provider: "google",
      model: "gemini-3.8-live",
      language: "el"
    });
    expect(session.provider).toBe("google");
    expect(session.model).toBe("gemini-3.8-live");
    expect(session.websocketUrl).toContain("wss://generativelanguage.googleapis.com");
    expect(session.websocketUrl).toContain("key=test-gemini-key-12345");
    expect(session.sessionId).toMatch(/^gemini_live_/);
  });

  it("blocks Amazon Nova 2 Sonic session when credentials are not configured", async () => {
    const config = getApiConfig({});
    await expect(
      createVoiceRealtimeCall(config, {
        provider: "amazon",
        model: "amazon.nova-2-sonic-v1:0",
        language: "el"
      })
    ).rejects.toThrow("Amazon Nova 2 Sonic credentials not configured on Space");
  });

  it("initializes Amazon Nova session when AWS credentials are provided", async () => {
    const config = getApiConfig({
      AWS_ACCESS_KEY_ID: "AKIA_TEST_KEY",
      AWS_SECRET_ACCESS_KEY: "SECRET_TEST_KEY",
      AWS_REGION: "us-west-2"
    });
    const session = await createVoiceRealtimeCall(config, {
      provider: "amazon",
      model: "amazon.nova-2-sonic-v1:0",
      language: "el"
    });
    expect(session.provider).toBe("amazon");
    expect(session.model).toBe("amazon.nova-2-sonic-v1:0");
    expect(session.websocketUrl).toContain("bedrock-runtime.us-west-2.amazonaws.com");
    expect(session.sessionId).toMatch(/^nova_live_/);
  });

  it("preserves full OpenAI WebRTC SDP offer-answer flow", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Space Voice\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=OpenAI\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    await writeFile(keyFile, "sk-test-key-openai");

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        session: { id: "oai_sess_1" },
        transport: { type: "webrtc", sdp: answerSdp }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const config = getApiConfig({
        SPACE_VOICE_TRANSCRIPTION_ENABLED: "true",
        SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile
      });
      const result = await createVoiceRealtimeCall(config, {
        provider: "openai",
        offerSdp,
        model: "gpt-live-1",
        language: "el"
      });
      expect(result.answerSdp).toBe(answerSdp);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-live-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(calledUrl).toContain("/live/sessions");
      const sentPayload = JSON.parse(calledInit.body as string);
      expect(sentPayload.session).not.toHaveProperty("voice");
      expect(sentPayload.session).not.toHaveProperty("input_audio_transcription");
      expect(sentPayload.session.audio.output.voice).toBe("alloy");
      expect(sentPayload.session.audio).not.toHaveProperty("input");
    } finally {
      vi.unstubAllGlobals();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes Vercel Live session when Vercel API key is provided", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/v1/realtime/client-secrets")) {
        return new Response(JSON.stringify({
          token: "vcst_test_token_123",
          expiresAt: 1789578821
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const config = getApiConfig({
        AI_GATEWAY_API_KEY: "vck_test_key_123"
      });
      const session = await createVoiceRealtimeCall(config, {
        provider: "vercel",
        model: "openai/gpt-live-1",
        language: "el"
      });
      expect(session.provider).toBe("vercel");
      expect(session.model).toBe("openai/gpt-live-1");
      expect(session.websocketUrl).toBe("wss://ai-gateway.vercel.sh/v1/live/sessions");
      expect(session.token).toBe("vcst_test_token_123");
      expect(session.protocol).toBe("gpt-live");
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ model: "openai/gpt-live-1", routeKind: "live" });
      expect(session.sessionId).toMatch(/^vercel_live_/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["openai/gpt-realtime-mini", "google/gemini-3.1-flash-live-preview", "xai/grok-voice"])("preserves %s and uses normalized Gateway Realtime", async (model) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "vcst_test", expiresAt: 1789578821 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const session = await createVoiceRealtimeCall(getApiConfig({ AI_GATEWAY_API_KEY: "test-key" }), { provider: "vercel", model, language: "el" });
      expect(session).toMatchObject({ model, protocol: "gateway-realtime", token: "vcst_test" });
      const url = new URL(session.websocketUrl!);
      expect(url.pathname).toBe("/v4/ai/realtime-model");
      expect(url.searchParams.get("ai-model-id")).toBe(model);
      const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(requestUrl).toBe("https://ai-gateway.vercel.sh/v1/realtime/client-secrets");
      expect(JSON.parse(init.body as string)).toEqual({ model });
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses the selected OpenAI Realtime model with multipart SDP and tools, without hosted delegation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    await writeFile(keyFile, "test-key");
    const fetchMock = vi.fn(async () => new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tools = [{ type: "function", name: "space_inspect", parameters: { type: "object" } }];
      const result = await createVoiceRealtimeCall(getApiConfig({ SPACE_VOICE_TRANSCRIPTION_ENABLED: "true", SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile }), {
        provider: "openai", model: "gpt-realtime-mini", language: "el", voice: "alloy", offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", tools, delegatedModel: "should-not-run"
      });
      expect(result).toMatchObject({ model: "gpt-realtime-mini", protocol: "openai-realtime" });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/realtime/calls");
      expect(init.headers).not.toHaveProperty("Content-Type");
      const body = init.body as FormData;
      expect(body.get("sdp")).toContain("m=audio");
      const config = JSON.parse(body.get("session") as string);
      expect(config).toMatchObject({ type: "realtime", model: "gpt-realtime-mini", tools });
      expect(config).not.toHaveProperty("delegation");
    } finally { vi.unstubAllGlobals(); await rm(tempDir, { recursive: true, force: true }); }
  });

  it("sends a GPT-Live delegation effort that the delegated model accepts with web search", async () => {
    clearDelegatedModelVerdicts();
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    await writeFile(keyFile, "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transport: { sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" } })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createVoiceRealtimeCall(getApiConfig({ SPACE_VOICE_TRANSCRIPTION_ENABLED: "true", SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile }), {
        provider: "openai", model: "gpt-live-1", language: "auto", offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        delegatedType: "responses", delegatedModel: "gpt-5.6-terra", delegatedReasoningEffort: "minimal", delegatedWebSearch: true
      });
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      const verification = JSON.parse(calls[0]![1].body as string);
      expect(calls[0]![0]).toBe("https://api.openai.com/v1/responses");
      expect(verification).toMatchObject({ model: "gpt-5.6-terra", reasoning: { effort: "none" }, tools: [{ type: "web_search" }] });
      const [url, init] = calls[1]!;
      expect(url).toBe("https://api.openai.com/v1/live/sessions");
      const { session } = JSON.parse(init.body as string);
      expect(session.delegation.responses).toMatchObject({ model: "gpt-5.6-terra", reasoning: { effort: "none" }, tools: [{ type: "web_search" }] });
    } finally { vi.unstubAllGlobals(); await rm(tempDir, { recursive: true, force: true }); }
  });

  it.each([
    ["gpt-5.6-terra", "minimal", false, "none"],
    ["gpt-5.1", undefined, true, "none"],
    ["gpt-5-mini", "minimal", true, "low"],
    ["gpt-5-mini", "minimal", false, "minimal"],
    ["o4-mini", "minimal", false, "low"],
    ["gpt-5.6-terra", "high", true, "high"]
  ] as const)("maps delegated effort for %s (%s, web search %s) to %s", (model, requested, webSearch, expected) => {
    expect(delegatedReasoningEffort(model, requested, webSearch)).toBe(expected);
  });

  it("does not upgrade an unknown model to a paid Live model", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    await writeFile(keyFile, "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const model of ["unknown-model", "gpt-realtime-whisper"]) {
        await expect(createVoiceRealtimeCall(getApiConfig({ SPACE_VOICE_TRANSCRIPTION_ENABLED: "true", SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile }), {
          provider: "openai", model, language: "el", offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
        })).rejects.toThrow("no automatic paid substitution");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); await rm(tempDir, { recursive: true, force: true }); }
  });

  it.each(["gpt-transcribe", "gpt-live-transcribe", "gpt-4o-mini-transcribe"])("uses transcription-only protocol for %s without a conversation charge", async (model) => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    await writeFile(keyFile, "test-key");
    const fetchMock = vi.fn(async () => new Response("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await createVoiceRealtimeCall(getApiConfig({ SPACE_VOICE_TRANSCRIPTION_ENABLED: "true", SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile }), { provider: "openai", model, language: "el", offerSdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" });
      expect(result).toMatchObject({ model, protocol: "openai-transcription" });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/realtime/calls");
      const session = JSON.parse((init.body as FormData).get("session") as string);
      expect(session).toMatchObject({ type: "transcription", audio: { input: { transcription: { model }, turn_detection: null } } });
      expect(session.audio).not.toHaveProperty("output");
      expect(session).not.toHaveProperty("delegation");
    } finally { vi.unstubAllGlobals(); await rm(tempDir, { recursive: true, force: true }); }
  });

  it("fails OpenAI Live session clearly if offerSdp is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "space-voice-test-"));
    const keyFile = join(tempDir, "voice.key");
    await writeFile(keyFile, "sk-test-key-openai");
    try {
      const config = getApiConfig({
        SPACE_VOICE_TRANSCRIPTION_ENABLED: "true",
        SPACE_VOICE_TRANSCRIPTION_KEY_FILE: keyFile
      });
      await expect(
        createVoiceRealtimeCall(config, {
          provider: "openai",
          model: "gpt-live-1",
          language: "el"
        })
      ).rejects.toThrow("OpenAI Live session requires an SDP offer");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
