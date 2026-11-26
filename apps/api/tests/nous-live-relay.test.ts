import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { bridgeNousLive, NOUS_LIVE_RELAY_TICKET_MS, NousLiveRelayTickets, relayUpstream, resamplePcm16, type NousLiveRelayPlan } from "../src/nous/live/relay.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  json() { return this.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data)); }
  receive(message: unknown) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}
const plan = (provider: NousLiveRelayPlan["provider"]): NousLiveRelayPlan => ({ provider, model: { local: "local-qwen3-greek", vercel: "openai/gpt-realtime-2.1", openai: "gpt-realtime-2.1" }[provider], voice: "alloy",
  language: "el", instructions: "You are Nous Live.", tools: [{ name: "time_now", description: "The time.", parameters: { type: "object" } }] });
const pcm = (...samples: number[]) => { const buffer = Buffer.alloc(samples.length * 2); samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2)); return buffer; };

describe("Nous Live's relay (nous_msg:85541f3e)", () => {
  it("hands out one-use tickets that expire", () => {
    let now = 0;
    const tickets = new NousLiveRelayTickets(() => now);
    const { ticket } = tickets.create(plan("vercel"), { url: "wss://gw" });
    expect(tickets.take(ticket)).toMatchObject({ upstream: { url: "wss://gw" } });
    expect(tickets.take(ticket)).toBeNull();
    const late = tickets.create(plan("vercel"), { url: "wss://gw" }).ticket;
    now += NOUS_LIVE_RELAY_TICKET_MS;
    expect(tickets.take(late)).toBeNull();
  });

  it("resamples 16-bit PCM between the phone's and the provider's rates", () => {
    expect([...new Int16Array(new Uint8Array(resamplePcm16(pcm(0, 300), 16000, 24000)).buffer)]).toEqual([0, 200, 300]);
    expect(resamplePcm16(pcm(0, 100, 200), 24000, 16000).length).toBe(4);
    expect(resamplePcm16(pcm(7), 16000, 16000)).toEqual(pcm(7));
  });

  it("speaks Vercel AI Gateway's realtime protocol for the phone, both ways", () => {
    const phone = new FakeSocket(), upstream = new FakeSocket();
    upstream.readyState = 0;
    const onClose = vi.fn();
    bridgeNousLive(phone as never, upstream as never, plan("vercel"), onClose);
    // The setup arrives before the provider's socket is open: it waits, and the server's plan replaces it.
    phone.receive({ setup: { model: "ignored" } });
    expect(upstream.sent).toEqual([]);
    upstream.readyState = 1; upstream.emit("open");
    expect(upstream.json()[0]).toMatchObject({ type: "session-update", config: { instructions: "You are Nous Live.", voice: "alloy", turnDetection: { type: "semantic-vad" },
      inputAudioTranscription: { language: "el" }, tools: [{ type: "function", name: "time_now" }] } });
    // Audio before the session is set up is dropped; after, 16 kHz becomes 24 kHz.
    phone.receive({ realtimeInput: { audio: { data: pcm(0, 300).toString("base64") } } });
    upstream.receive({ type: "session-updated" });
    expect(phone.json()).toEqual([{ setupComplete: {} }]);
    phone.receive({ realtimeInput: { audio: { data: pcm(0, 300).toString("base64") } } });
    expect(upstream.json().slice(1)).toEqual([{ type: "input-audio-append", audio: pcm(0, 200, 300).toString("base64") }]);

    upstream.receive({ type: "response-created" });
    upstream.receive({ type: "speech-started" });
    upstream.receive({ type: "input-transcription-completed", transcript: "Τι ώρα είναι;" });
    upstream.receive({ type: "audio-delta", delta: "AAAA" });
    upstream.receive({ type: "audio-transcript-delta", delta: "Είναι" });
    upstream.receive({ type: "function-call-arguments-done", callId: "c1", name: "time_now", arguments: "{\"zone\":\"local\"}" });
    // The tool's answer waits for the running response to end, then asks for the next one.
    phone.receive({ toolResponse: { functionResponses: [{ id: "c1", name: "time_now", response: { output: "11:51" } }] } });
    expect(upstream.json().at(-1)).toEqual({ type: "conversation-item-create", item: { type: "function-call-output", callId: "c1", name: "time_now", output: "11:51" } });
    upstream.receive({ type: "response-done", status: "completed" });
    expect(upstream.json().at(-1)).toEqual({ type: "response-create" });
    expect(phone.json().slice(1)).toEqual([
      { serverContent: { interrupted: true } },
      { serverContent: { inputTranscription: { text: "Τι ώρα είναι;" } } },
      { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } },
      { serverContent: { outputTranscription: { text: "Είναι" } } },
      { toolCall: { functionCalls: [{ id: "c1", name: "time_now", args: { zone: "local" } }] } },
      { serverContent: { turnComplete: true } }
    ]);
    phone.receive({ clientContent: { turns: [{ role: "user", parts: [{ text: "Nous answers: done" }] }] } });
    expect(upstream.json().slice(-2)).toEqual([{ type: "conversation-item-create", item: { type: "text-message", role: "user", text: "Nous answers: done" } }, { type: "response-create" }]);

    // A provider error ends both sides with its reason, once.
    upstream.receive({ type: "error", message: "Insufficient credits." });
    expect(phone.closed).toEqual({ code: 1011, reason: "openai/gpt-realtime-2.1: Insufficient credits." });
    expect(upstream.closed?.code).toBe(1011);
    phone.emit("close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("speaks the Local PC's PCM protocol for the phone, both ways", () => {
    const phone = new FakeSocket(), upstream = new FakeSocket();
    upstream.readyState = 0;
    const stop = bridgeNousLive(phone as never, upstream as never, plan("local"), vi.fn());
    phone.receive({ setup: {} });
    phone.receive({ realtimeInput: { audio: { data: pcm(5, 6).toString("base64") } } });
    upstream.readyState = 1; upstream.emit("open");
    expect(upstream.sent).toEqual([JSON.stringify({ type: "start", sample_rate: 16000, language: "el" }), pcm(5, 6)]);
    expect(phone.json()).toEqual([{ setupComplete: {} }]);
    upstream.emit("message", pcm(0, 300), true);
    upstream.receive({ type: "user_transcript", text: "Γεια" });
    upstream.receive({ type: "assistant_text", text: "Γεια σου" });
    upstream.receive({ type: "listening" });
    expect(phone.json().slice(1)).toEqual([
      { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm(0, 200, 300).toString("base64") } }] } } },
      { serverContent: { inputTranscription: { text: "Γεια" } } },
      { serverContent: { outputTranscription: { text: "Γεια σου" } } },
      { serverContent: { turnComplete: true } }
    ]);
    stop();
    expect(phone.closed).toEqual({ code: 1001, reason: "Space is restarting." });
  });

  it("speaks OpenAI's own realtime protocol for the phone, both ways", () => {
    const phone = new FakeSocket(), upstream = new FakeSocket();
    bridgeNousLive(phone as never, upstream as never, plan("openai"), vi.fn());
    phone.receive({ setup: {} });
    expect(upstream.json()[0]).toMatchObject({ type: "session.update", session: { type: "realtime", instructions: "You are Nous Live.",
      audio: { input: { transcription: { language: "el" } }, output: { voice: "alloy" } }, tools: [{ type: "function", name: "time_now" }] } });
    upstream.receive({ type: "session.updated" });
    phone.receive({ realtimeInput: { audio: { data: pcm(0, 300).toString("base64") } } });
    expect(upstream.json().at(-1)).toEqual({ type: "input_audio_buffer.append", audio: pcm(0, 200, 300).toString("base64") });
    upstream.receive({ type: "response.created" });
    upstream.receive({ type: "response.output_audio.delta", delta: "AAAA" });
    upstream.receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "time_now", arguments: "{}" });
    phone.receive({ toolResponse: { functionResponses: [{ id: "c1", name: "time_now", response: { output: "11:51" } }] } });
    expect(upstream.json().at(-1)).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "11:51" } });
    upstream.receive({ type: "response.done", response: { status: "completed" } });
    expect(upstream.json().at(-1)).toEqual({ type: "response.create" });
    phone.receive({ clientContent: { turns: [{ parts: [{ text: "Nous answers: done" }] }] } });
    expect(upstream.json().at(-2)).toEqual({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Nous answers: done" }] } });
    expect(phone.json()).toEqual([{ setupComplete: {} }, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } },
      { toolCall: { functionCalls: [{ id: "c1", name: "time_now", args: {} }] } }, { serverContent: { turnComplete: true } }]);
    // DEV3D-005: a response.create refused because VAD already started one keeps the call, and asks again when that response ends.
    upstream.receive({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "Conversation already has an active response in progress." } });
    expect(phone.closed).toBeNull();
    const asked = upstream.json().length;
    upstream.receive({ type: "response.created" });
    upstream.receive({ type: "response.done", response: { status: "completed" } });
    expect(upstream.json().slice(asked)).toEqual([{ type: "response.create" }]);
    upstream.receive({ type: "error", error: { message: "You exceeded your current quota." } });
    expect(phone.closed).toEqual({ code: 1011, reason: "gpt-realtime-2.1: You exceeded your current quota." });
  });

  it("opens the provider's session with the owner's own connection before the phone connects", async () => {
    const runtime = { call: vi.fn(async () => ({ websocketUrl: "wss://gw/realtime", token: "tok" })), localSession: vi.fn(async () => ({ ws_url: "ws://pc/voice", token: "lt" })),
      openaiRealtime: vi.fn(async () => ({ websocketUrl: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", token: "ek_1" })) };
    expect(await relayUpstream(runtime, "user:1", plan("openai"))).toEqual({ url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", protocols: ["realtime", "openai-insecure-api-key.ek_1"] });
    expect(runtime.openaiRealtime).toHaveBeenCalledWith("user:1", "gpt-realtime-2.1");
    expect(await relayUpstream(runtime, "user:1", plan("vercel"))).toEqual({ url: "wss://gw/realtime", protocols: ["ai-gateway-realtime.v1", "ai-gateway-auth.tok"] });
    expect(runtime.call).toHaveBeenCalledWith("user:1", { provider: "vercel", model: "openai/gpt-realtime-2.1", language: "el", voice: "alloy" });
    expect(await relayUpstream(runtime, "user:1", plan("local"))).toEqual({ url: "ws://pc/voice", protocols: ["lt"] });
    expect(runtime.localSession).toHaveBeenCalledWith("user:1", { language: "el-GR", prompt: "You are Nous Live." });
    await expect(relayUpstream({ ...runtime, call: vi.fn(async () => ({})) }, "user:1", plan("vercel"))).rejects.toThrow(/no realtime session/);
  });
});
