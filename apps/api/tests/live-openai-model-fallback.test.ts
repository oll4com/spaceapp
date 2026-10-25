import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiConfig } from "../src/config.js";
import { createVoiceRealtimeCall } from "../src/voice-transcription.js";
import { clearDelegatedModelVerdicts, resolveDelegatedModel } from "../src/live-openai-model-fallback.js";

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const openAiError = (status: number, message: string, code = "invalid_request_error") => json({ error: { message, code } }, status);

describe("OpenAI Live model fallback", () => {
  let tempDir = "";
  let config: ReturnType<typeof getApiConfig>;
  beforeEach(async () => {
    clearDelegatedModelVerdicts();
    tempDir = await mkdtemp(join(tmpdir(), "space-live-fallback-"));
    await writeFile(join(tempDir, "voice.key"), "test-key");
    config = getApiConfig({ SPACE_VOICE_TRANSCRIPTION_ENABLED: "true", SPACE_VOICE_TRANSCRIPTION_KEY_FILE: join(tempDir, "voice.key") });
  });
  afterEach(async () => { vi.unstubAllGlobals(); await rm(tempDir, { recursive: true, force: true }); });

  const liveInput = { provider: "openai" as const, model: "gpt-live-1", language: "auto" as const, voice: "gleam", offerSdp: sdp,
    delegatedType: "responses" as const, delegatedModel: "gpt-5.6-terra", delegatedReasoningEffort: "minimal" as const, delegatedWebSearch: true };

  it("delegates to the first fallback that works when the selected model fails, and remembers the verdict", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/responses")) {
        const model = JSON.parse(init.body as string).model;
        return model === "gpt-5.6-terra" ? openAiError(404, "The model `gpt-5.6-terra` does not exist.", "model_not_found") : json({ status: "completed" });
      }
      return json({ transport: { sdp } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createVoiceRealtimeCall(config, liveInput);
    expect(result).toMatchObject({ model: "gpt-live-1", protocol: "gpt-live", delegatedModel: "gpt-5.5",
      fallbacks: [{ kind: "delegated", requested: "gpt-5.6-terra", used: "gpt-5.5" }] });
    const session = JSON.parse((fetchMock.mock.calls.find(([url]) => url.endsWith("/live/sessions"))![1]).body as string).session;
    expect(session.delegation.responses).toMatchObject({ model: "gpt-5.5", reasoning: { effort: "none" } });

    fetchMock.mockClear();
    await createVoiceRealtimeCall(config, liveInput);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://api.openai.com/v1/live/sessions"]);
  });

  it("waits at most two seconds for a cold check of the selected model and lets it decide the next session", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (response: Response) => void;
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => JSON.parse(init.body as string).model === "gpt-5.6-terra"
        ? new Promise<Response>(resolve => { answer = resolve; }) : Promise.resolve(json({ status: "completed" })));
      const input = { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", model: "gpt-5.6-terra", webSearch: false, fetchImpl: fetchImpl as unknown as typeof fetch };
      const first = resolveDelegatedModel(input);
      await vi.advanceTimersByTimeAsync(1999);
      let settled = false; void first.then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toEqual({ model: "gpt-5.6-terra", effort: "none" });
      answer(openAiError(404, "The model `gpt-5.6-terra` does not exist.", "model_not_found"));
      await vi.advanceTimersByTimeAsync(0);
      await expect(resolveDelegatedModel(input)).resolves.toMatchObject({ model: "gpt-5.5", fallback: { requested: "gpt-5.6-terra", used: "gpt-5.5" } });
      expect(fetchImpl.mock.calls.filter(([, init]) => JSON.parse(init.body as string).model === "gpt-5.6-terra")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it("keeps the selected delegated model when the check cannot run", async () => {
    const fetchMock = vi.fn(async () => openAiError(503, "Service unavailable", "server_error"));
    expect(await resolveDelegatedModel({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5.6-terra", effort: "low", webSearch: true, fetchImpl: fetchMock as unknown as typeof fetch }))
      .toEqual({ model: "gpt-5.6-terra", effort: "low" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an exhausted quota instead of switching models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openAiError(429, "You exceeded your current quota.", "insufficient_quota")));
    await expect(createVoiceRealtimeCall(config, liveInput)).rejects.toThrow("quota or credit balance exhausted");
  });

  it("moves an unavailable gpt-live-1 to GPT-Realtime with a Realtime voice and the session tools", async () => {
    const tools = [{ type: "function", name: "space_inspect", parameters: { type: "object" } }];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/responses")) return json({ status: "completed" });
      // The answer OpenAI gives for a Live model it does not serve.
      if (url.endsWith("/live/sessions")) return openAiError(400, "Model \"gpt-live-1\" is not supported in realtime mode.", "invalid_model");
      return new Response(sdp);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createVoiceRealtimeCall(config, { ...liveInput, tools });
    expect(result).toMatchObject({ model: "gpt-realtime-2.1", protocol: "openai-realtime",
      fallbacks: [{ kind: "voice", requested: "gpt-live-1", used: "gpt-realtime-2.1" }] });
    expect(result).not.toHaveProperty("delegatedModel");
    const [url, init] = fetchMock.mock.calls.find(([candidate]) => candidate.endsWith("/realtime/calls"))!;
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    const session = JSON.parse((init as RequestInit & { body: FormData }).body.get("session") as string);
    expect(session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1", tools,
      audio: { input: { transcription: { model: "whisper-1" }, turn_detection: { type: "semantic_vad" } }, output: { voice: "marin" } } });
    expect(session).not.toHaveProperty("voice");
    expect(session).not.toHaveProperty("input_audio_transcription");
    expect(session).not.toHaveProperty("delegation");
  });

  it("does not switch voice models on a request error", async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/responses") ? json({ status: "completed" }) : openAiError(400, "Invalid instructions."));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createVoiceRealtimeCall(config, liveInput)).rejects.toThrow("Invalid instructions.");
    expect(fetchMock.mock.calls.filter(([url]) => !url.endsWith("/responses"))).toHaveLength(1);
  });

  it("fails clearly when OpenAI rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openAiError(401, "Incorrect API key provided.", "invalid_api_key")));
    await expect(createVoiceRealtimeCall(config, liveInput)).rejects.toThrow("OpenAI rejected the Live API key");
  });
});
