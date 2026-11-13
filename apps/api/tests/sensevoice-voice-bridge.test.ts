import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { bridgeSenseVoice, quietestCut, senseVoiceRequest } from "../src/sensevoice-voice-bridge.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: unknown) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.readyState = 3; }
  open() { this.readyState = 1; this.emit("open"); }
}

/** PCM16 frame of `samples` samples at one level (0 is silence). */
const pcm = (samples: number, level = 1000) => { const b = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i += 1) b.writeInt16LE(level, i * 2); return b; };
const header = (request: unknown) => ({ rate: (request as Buffer).readInt32LE(0), samples: (request as Buffer).readInt32LE(4) / 4 });

function setup() {
  const client = new FakeSocket();
  client.readyState = 1;
  const daemon = new FakeSocket();
  const urls: string[] = [];
  const closes: string[] = [];
  bridgeSenseVoice(client as unknown as WebSocket, {
    url: "ws://127.0.0.1:54330",
    connect: (url) => { urls.push(url); return daemon as unknown as WebSocket; },
    onClose: ({ reason }) => closes.push(reason)
  });
  const say = (message: unknown) => client.emit("message", Buffer.from(JSON.stringify(message)), false);
  const reply = (text: string) => daemon.emit("message", Buffer.from(JSON.stringify({ lang: "<|en|>", text })), false);
  const json = () => client.sent.map((item) => JSON.parse(item as string));
  return { client, daemon, urls, closes, say, reply, json };
}

describe("SenseVoice voice bridge", () => {
  it("frames decode requests as sample rate, byte count and float32 samples", () => {
    const request = senseVoiceRequest(16000, Float32Array.from([0.5, -0.25]));
    expect(request.length).toBe(16);
    expect(header(request)).toEqual({ rate: 16000, samples: 2 });
    expect([request.readFloatLE(8), request.readFloatLE(12)]).toEqual([0.5, -0.25]);
  });

  it("cuts a long segment in the quietest window of its last seconds", () => {
    const samples = new Float32Array(16000 * 15).fill(0.5);
    samples.fill(0, 16000 * 13, 16000 * 13 + 1600);
    const cut = quietestCut(samples, 16000);
    expect(cut).toBeGreaterThanOrEqual(16000 * 13);
    expect(cut).toBeLessThanOrEqual(16000 * 13 + 1600);
  });

  it("decodes partial transcripts while speaking, and the rest on stop before closing", () => {
    const { client, daemon, urls, closes, say, reply, json } = setup();
    expect(urls).toEqual(["ws://127.0.0.1:54330"]);
    say({ type: "start", sample_rate: 16000, language: "en" });
    client.emit("message", pcm(8192), true);
    client.emit("message", pcm(8192), true);
    expect(daemon.sent).toHaveLength(0);
    daemon.open();
    expect(daemon.sent.map(header)).toEqual([{ rate: 16000, samples: 16384 }]);
    expect((daemon.sent[0] as Buffer).readFloatLE(8)).toBeCloseTo(1000 / 32768, 6);
    client.emit("message", pcm(16384), true);
    expect(daemon.sent).toHaveLength(1);
    reply("The tribal");
    expect(json()).toEqual([{ type: "user_transcript", text: "The tribal" }]);
    say({ type: "stop" });
    expect(daemon.sent.map(header)[1]).toEqual({ rate: 16000, samples: 32768 });
    expect(client.closed).toBeNull();
    reply("The tribal chieftain called for the boy.");
    expect(json().at(-1)).toEqual({ type: "user_transcript", text: "The tribal chieftain called for the boy.", final: true });
    expect(client.closed).toEqual({ code: 1000, reason: "completed" });
    expect(closes).toEqual(["completed"]);
  });

  it("commits each 10 second segment, one request in flight, and keeps the rest open", () => {
    const { client, daemon, say, reply, json } = setup();
    daemon.open();
    say({ type: "start", sample_rate: 16000 });
    for (let sent = 0; sent < 16000 * 10; sent += 16000) client.emit("message", Buffer.concat([pcm(15000), pcm(1000, 0)]), true);
    // The first second's partial is in flight; the segment waits for its reply (the daemon may answer out of order).
    expect(daemon.sent).toHaveLength(1);
    reply("");
    expect(daemon.sent).toHaveLength(2);
    const segment = header(daemon.sent[1]);
    expect(segment.samples).toBeLessThan(16000 * 10);
    expect(segment.samples).toBeGreaterThan(16000 * 7);
    reply("First segment.");
    say({ type: "stop" });
    expect(header(daemon.sent.at(-1)).samples).toBe(16000 * 10 - segment.samples);
    reply("Second.");
    expect(json().at(-1)).toEqual({ type: "user_transcript", text: "First segment. Second.", final: true });
  });

  it("stops with a fixed reason when the daemon goes away, and never copies its text", () => {
    const { client, daemon, closes } = setup();
    daemon.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:54330 private detail"));
    expect(client.closed).toEqual({ code: 1011, reason: "sensevoice_unavailable" });
    expect(closes).toEqual(["sensevoice_unavailable"]);
    daemon.emit("close");
    expect(closes).toHaveLength(1);
  });

  it("refuses oversized frames and unknown messages, and ends when the browser leaves", () => {
    const big = setup();
    big.client.emit("message", Buffer.alloc(64 * 1024 + 2), true);
    expect(big.client.closed).toEqual({ code: 1009, reason: "voice_frame_too_large" });
    const odd = setup();
    odd.say({ type: "say", text: "x" });
    expect(odd.client.closed).toEqual({ code: 1008, reason: "voice_invalid_message" });
    const gone = setup();
    gone.client.emit("close");
    expect(gone.daemon.readyState).toBe(3);
    expect(gone.closes).toEqual(["client_closed"]);
  });

  it("closes cleanly on stop with no audio", () => {
    const { client, daemon, say, json } = setup();
    daemon.open();
    say({ type: "stop" });
    expect(daemon.sent).toHaveLength(0);
    expect(json()).toEqual([{ type: "user_transcript", text: "", final: true }]);
    expect(client.closed).toEqual({ code: 1000, reason: "completed" });
  });
});
