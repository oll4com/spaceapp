import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { bridgeFishVoice, FISH_ASR_URL, FISH_TTS_URL, packMsg, unpackMsg } from "../src/fish-voice-bridge.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Array<{ data: unknown; binary?: boolean }> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: unknown, options?: { binary?: boolean }) { this.sent.push({ data, binary: options?.binary }); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.readyState = 3; }
  open() { this.readyState = 1; this.emit("open"); }
  receive(message: unknown) { this.emit("message", packMsg(message), true); }
}

function setup() {
  const client = new FakeSocket();
  client.readyState = 1;
  const upstreams: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }> = [];
  const closes: string[] = [];
  bridgeFishVoice(client as unknown as WebSocket, {
    apiKey: "fish-test-key",
    connect: (url, headers) => { const socket = new FakeSocket(); upstreams.push({ url, headers, socket }); return socket as unknown as WebSocket; },
    onClose: ({ reason }) => closes.push(reason)
  });
  const asr = upstreams[0]!;
  asr.socket.open();
  const json = () => client.sent.filter((item) => typeof item.data === "string").map((item) => JSON.parse(item.data as string));
  return { client, upstreams, asr, closes, json };
}

describe("Fish Audio voice bridge", () => {
  it("round-trips the MessagePack values Fish uses without prototype pollution", () => {
    const long = "λ".repeat(200);
    const value = { type: "audio", data: Buffer.from([1, 2, 3]), n: 300, big: 70000, neg: -5, neg32: -40000, f: 0.5, ok: true, none: null,
      list: [1, "x", false], nested: { a: "b" }, long, longer: "x".repeat(70000) };
    const back = unpackMsg(packMsg(value)) as Record<string, unknown>;
    expect({ ...back, data: Buffer.from(back.data as Uint8Array), nested: { ...(back.nested as object) } }).toEqual(value);
    const polluted = unpackMsg(Buffer.concat([Buffer.from([0x81, 0xa9]), Buffer.from("__proto__"), Buffer.from([0x81, 0xa1, 0x78, 0x01])])) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.keys(polluted)).toEqual(["__proto__"]);
    expect(() => unpackMsg(Buffer.from([0xdc, 0xff, 0xff]))).toThrow(/truncated/);
  });

  it("relays microphone audio and only the agent's speech-to-text events", () => {
    const { client, asr, json } = setup();
    expect(asr.url).toBe(FISH_ASR_URL);
    expect(asr.headers).toEqual({ Authorization: "Bearer fish-test-key", model: "transcribe-stream-1" });
    expect(unpackMsg(asr.socket.sent[0]!.data as Buffer)).toMatchObject({ type: "config", audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 } });
    client.emit("message", Buffer.from([7, 8]), true);
    const audio = unpackMsg(asr.socket.sent[1]!.data as Buffer) as { type: string; data: Uint8Array };
    expect(audio.type).toBe("audio");
    expect([...audio.data]).toEqual([7, 8]);
    asr.socket.receive({ type: "draft", text: "hal" });
    asr.socket.receive({ type: "committed", turn_index: 0, text: "Γεια σου", user_turn: true, language_code: "el", words: [{ text: "Γεια" }], request_id: "r1" });
    expect(json()).toEqual([{ type: "committed", turn_index: 0, text: "Γεια σου", user_turn: true, language_code: "el" }]);
    client.emit("message", Buffer.from(JSON.stringify({ type: "agent_speaking", speaking: true })), false);
    expect(unpackMsg(asr.socket.sent[2]!.data as Buffer)).toEqual({ type: "agent_speaking", speaking: true });
  });

  it("speaks a reply with Drama 3 and stops it on barge-in", () => {
    const { client, upstreams, json } = setup();
    const voice = "c70cfb98867a4bfb9ae20d2401257b92";
    client.emit("message", Buffer.from(JSON.stringify({ type: "say", text: "Hello there", voice })), false);
    const tts = upstreams[1]!;
    expect(tts.url).toBe(FISH_TTS_URL);
    expect(tts.headers.model).toBe("drama-3");
    tts.socket.open();
    expect(tts.socket.sent.map((item) => unpackMsg(item.data as Buffer))).toEqual([
      { event: "start", request: { text: "", reference_id: voice, format: "pcm", sample_rate: 24000, latency: "balanced" } },
      { event: "text", text: "Hello there" },
      { event: "stop" }
    ]);
    tts.socket.receive({ event: "audio", audio: Buffer.from([1, 0, 2, 0]) });
    expect(client.sent.find((item) => item.binary)?.data).toEqual(Buffer.from([1, 0, 2, 0]));
    tts.socket.receive({ event: "finish", reason: "stop" });
    expect(json()).toEqual([{ type: "tts_done", reason: "stop" }]);

    client.emit("message", Buffer.from(JSON.stringify({ type: "say", text: "A long answer", voice })), false);
    const second = upstreams[2]!;
    second.socket.open();
    client.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false);
    expect(second.socket.readyState).toBe(3);
    second.socket.receive({ event: "audio", audio: Buffer.from([9, 9]) });
    expect(client.sent.filter((item) => item.binary)).toHaveLength(1);
  });

  it("refuses a voice that is not a Fish model id and reports a refused key by its status only", () => {
    const first = setup();
    first.client.emit("message", Buffer.from(JSON.stringify({ type: "say", text: "hi", voice: "../../etc" })), false);
    expect(first.client.closed).toEqual({ code: 1008, reason: "voice_invalid_message" });
    expect(first.upstreams).toHaveLength(1);

    const second = setup();
    second.asr.socket.emit("error", new Error("Unexpected server response: 402"));
    expect(second.client.closed).toEqual({ code: 1011, reason: "fish_402" });
    expect(second.closes).toEqual(["fish_402"]);
  });
});
