import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { ASSEMBLYAI_STREAM_URL, bridgeGrantVoice, grantVoice, MURF_STREAM_URL } from "../src/grant-voice-bridge.js";
import { grantVoicePlan, liveKitInferenceToken, parseLiveKitEnv, type GrantKeys, type GrantVoicePlan } from "../src/voice-grants.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<{ data: unknown; binary?: boolean }> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: unknown, options?: { binary?: boolean }) { this.sent.push({ data, binary: options?.binary }); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(message: unknown) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}

const livekit = { url: "wss://x.livekit.cloud", apiKey: "APIkey", apiSecret: "secret" };
const keys: GrantKeys = { livekit, murf: "murf-key", assemblyai: "aai-key" };

function setup(plan: GrantVoicePlan, fetchImpl?: typeof fetch) {
  const client = new FakeSocket();
  client.readyState = 1;
  const upstreams: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }> = [];
  const closes: string[] = [];
  bridgeGrantVoice(client as unknown as WebSocket, {
    plan,
    connect: (url, headers) => { const socket = new FakeSocket(); upstreams.push({ url, headers, socket }); return socket as unknown as WebSocket; },
    fetch: fetchImpl,
    onClose: ({ reason }) => closes.push(reason)
  });
  const json = () => client.sent.filter((item) => typeof item.data === "string").map((item) => JSON.parse(item.data as string));
  const say = (text: string, voice?: string) => client.emit("message", Buffer.from(JSON.stringify({ type: "say", text, voice })), false);
  return { client, upstreams, closes, json, say };
}

describe("startup voice grants", () => {
  it("plans each grant model from the keys it has and names the one it misses", () => {
    expect(grantVoicePlan("livekit", "livekit/rime-arcana", keys, "el").plan).toMatchObject({
      stt: { engine: "livekit", model: "deepgram/nova-3" }, tts: { engine: "livekit", model: "rime/arcana" }, language: "el" });
    expect(grantVoicePlan("murf", undefined, keys).plan).toMatchObject({ stt: { engine: "assemblyai" }, tts: { engine: "murf" } });
    expect(grantVoicePlan("assemblyai", "assemblyai/universal-streaming-sonic", keys).plan?.tts).toMatchObject({ engine: "livekit", model: "cartesia/sonic-3" });
    expect(grantVoicePlan("assemblyai", "assemblyai/universal-streaming-sonic", { ...keys, cartesia: "c" }).plan?.tts).toMatchObject({ engine: "cartesia" });
    expect(grantVoicePlan("cartesia", undefined, keys).missing).toMatch(/Cartesia/);
    expect(grantVoicePlan("murf", undefined, { murf: "m" }).missing).toMatch(/AssemblyAI or LiveKit/);
  });

  it("reads the LiveKit env file and signs an inference token with the API secret", () => {
    expect(parseLiveKitEnv('LIVEKIT_URL="wss://a" LIVEKIT_API_KEY=k\nLIVEKIT_API_SECRET=s')).toEqual({ url: "wss://a", apiKey: "k", apiSecret: "s" });
    expect(parseLiveKitEnv("LIVEKIT_URL=wss://a")).toBeUndefined();
    const [, payload] = liveKitInferenceToken(livekit, "me", 60, 1000).split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iss: "APIkey", sub: "me", nbf: 995, exp: 1060, inference: { perform: true } });
  });

  it("keeps a voice only when it fits the voice engine", () => {
    expect(grantVoice({ engine: "murf", voice: "en-US-natalie" }, "el-GR-stavros")).toBe("el-GR-stavros");
    expect(grantVoice({ engine: "murf", voice: "en-US-natalie" }, "../etc")).toBe("en-US-natalie");
    expect(grantVoice({ engine: "livekit", model: "rime/arcana", voice: "celeste" }, "luna")).toBe("luna");
    expect(grantVoice({ engine: "livekit", model: "cartesia/sonic-3", voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc" }, "luna")).toBe("9626c31c-bec5-4cca-baa8-f8ba9e84c8bc");
  });

  it("relays AssemblyAI turns and speaks with LiveKit Inference, stopping on barge-in", () => {
    const plan = grantVoicePlan("assemblyai", "assemblyai/universal-streaming-sonic", keys, "el-GR").plan!;
    const { client, upstreams, json, say } = setup(plan);
    const stt = upstreams[0]!;
    expect(stt.url.startsWith(`${ASSEMBLYAI_STREAM_URL}?`)).toBe(true);
    expect(stt.url).toContain("speech_model=universal-streaming-multilingual");
    expect(stt.headers).toEqual({ Authorization: "aai-key" });
    stt.socket.open();
    stt.socket.receive({ type: "Begin" });
    client.emit("message", Buffer.from([7, 8]), true);
    expect(stt.socket.sent[0]!.data).toEqual(Buffer.from([7, 8]));
    stt.socket.receive({ type: "Turn", transcript: "Γεια", end_of_turn: false });
    stt.socket.receive({ type: "Turn", transcript: "Γεια σου", end_of_turn: true });
    expect(json()).toEqual([{ type: "session_started" }, { type: "user_turn_taken" }, { type: "committed", text: "Γεια σου", user_turn: true }]);

    say("Hello", "not-a-uuid");
    const tts = upstreams[1]!;
    expect(tts.url).toBe("wss://agent-gateway.livekit.cloud/v1/tts?model=cartesia%2Fsonic-3");
    expect(tts.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    tts.socket.open();
    const sent = tts.socket.sent.map((item) => JSON.parse(item.data as string));
    expect(sent.map((item) => item.type)).toEqual(["session.create", "input_transcript", "session.flush"]);
    expect(sent[0]).toMatchObject({ voice: plan.tts.voice, language: "el", sample_rate: "24000" });
    tts.socket.receive({ type: "output_audio", audio: Buffer.from([1, 0]).toString("base64") });
    expect(client.sent.find((item) => item.binary)?.data).toEqual(Buffer.from([1, 0]));
    client.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
    expect(tts.socket.readyState).toBe(3);
    tts.socket.receive({ type: "output_audio", audio: Buffer.from([9, 9]).toString("base64") });
    expect(client.sent.filter((item) => item.binary)).toHaveLength(1);
  });

  it("ends the session with AssemblyAI's error code, never its text", () => {
    const { client, upstreams, closes } = setup(grantVoicePlan("murf", undefined, keys).plan!);
    upstreams[0]!.socket.open();
    upstreams[0]!.socket.receive({ type: "Error", error_code: 1008, error: "Too many concurrent sessions" });
    expect(closes).toEqual(["assemblyai_1008"]);
    expect(client.closed).toEqual({ code: 1011, reason: "assemblyai_1008" });
    expect(JSON.parse(upstreams[0]!.socket.sent.at(-1)!.data as string)).toEqual({ type: "Terminate" });
  });

  it("streams Murf PCM, reports HTTP failures as codes only, and closes on bad input", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return status === 200 ? new Response(new Uint8Array([3, 0, 4, 0])) : new Response("secret provider text", { status });
    }) as unknown as typeof fetch;
    const { client, upstreams, closes, json, say } = setup(grantVoicePlan("murf", undefined, keys).plan!, fetchImpl);
    upstreams[0]!.socket.open();
    say("Καλημέρα", "el-GR-stavros");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls[0]!.url).toBe(MURF_STREAM_URL);
    expect((calls[0]!.init.headers as Record<string, string>)["api-key"]).toBe("murf-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ text: "Καλημέρα", voiceId: "el-GR-stavros", format: "PCM", sampleRate: 24000 });
    expect(client.sent.find((item) => item.binary)?.data).toEqual(Buffer.from([3, 0, 4, 0]));
    status = 402;
    say("again");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(json().filter((item) => item.type === "tts_done")).toEqual([{ type: "tts_done", reason: "stop" }, { type: "tts_done", reason: "murf_402" }]);
    client.emit("message", Buffer.from("{nope"), false);
    expect(client.closed).toEqual({ code: 1008, reason: "voice_invalid_message" });
    expect(closes).toEqual(["voice_invalid_message"]);
    expect(JSON.parse(upstreams[0]!.socket.sent.at(-1)!.data as string)).toEqual({ type: "Terminate" });
  });
});
