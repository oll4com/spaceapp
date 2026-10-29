import { WebSocket as WsClient, type RawData, type WebSocket } from "ws";

/**
 * Fish Audio Live provider (operator request 2026-10-22): Fish's realtime speech to text and Drama 3 text to speech
 * take the API key in an Authorization header and speak MessagePack, so the browser talks to this bridge instead:
 * binary frames are microphone PCM (16 kHz) in and Drama 3 PCM (24 kHz) out, text frames are small JSON events.
 * The key never leaves the server; provider texts are never copied into logs or close reasons.
 */
export const FISH_AUDIO_KEY_FILE = "/opt/spaceapp/secrets/space-fish-audio.key";
export const FISH_ASR_URL = "wss://api.fish.audio/v1/asr/realtime";
export const FISH_TTS_URL = "wss://api.fish.audio/v1/tts/live";
export const FISH_TTS_SAMPLE_RATE = 24000;
const FISH_VOICE_ID = /^[0-9a-f]{32}$/;
const MAX_CLIENT_FRAME = 64 * 1024;
const MAX_BUFFERED = 1024 * 1024;
const MAX_SAY_CHARS = 4000;
// Only these speech-to-text events and fields reach the browser.
const ASR_EVENTS = new Set(["session_started", "speech_start", "user_turn_taken", "user_backchannel", "committed", "error"]);
const ASR_FIELDS = ["type", "turn_index", "text", "user_turn", "language_code", "code", "recoverable"] as const;

/** MessagePack encoding of the values the Fish protocols use (nil, booleans, numbers, strings, bytes, arrays, maps). */
export function packMsg(value: unknown): Buffer {
  const parts: Buffer[] = [];
  const head = (...bytes: number[]) => { parts.push(Buffer.from(bytes)); };
  const sized = (type: number, size: number, n: number) => {
    const b = Buffer.alloc(1 + size); b[0] = type;
    if (size === 1) b.writeUInt8(n, 1); else if (size === 2) b.writeUInt16BE(n, 1); else b.writeUInt32BE(n, 1);
    parts.push(b);
  };
  const length = (n: number, fix: number | null, fixMax: number, c8: number | null, c16: number, c32: number) => {
    if (fix !== null && n <= fixMax) head(fix | n);
    else if (c8 !== null && n < 0x100) sized(c8, 1, n);
    else if (n < 0x10000) sized(c16, 2, n);
    else sized(c32, 4, n);
  };
  const write = (v: unknown): void => {
    if (v === null || v === undefined) return head(0xc0);
    if (typeof v === "boolean") return head(v ? 0xc3 : 0xc2);
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v < 0x80) return head(v);
      if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return sized(0xce, 4, v);
      if (Number.isInteger(v) && v < 0 && v >= -32) return head(v & 0xff);
      if (Number.isInteger(v) && v < 0 && v >= -0x80000000) { const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(v, 1); parts.push(b); return; }
      const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(v, 1); parts.push(b); return;
    }
    if (typeof v === "string") { const s = Buffer.from(v, "utf8"); length(s.length, 0xa0, 31, 0xd9, 0xda, 0xdb); parts.push(s); return; }
    if (v instanceof Uint8Array) { length(v.length, null, 0, 0xc4, 0xc5, 0xc6); parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return; }
    if (Array.isArray(v)) { length(v.length, 0x90, 15, null, 0xdc, 0xdd); v.forEach(write); return; }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, item]) => item !== undefined);
    length(entries.length, 0x80, 15, null, 0xde, 0xdf);
    for (const [key, item] of entries) { write(key); write(item); }
  };
  write(value);
  return Buffer.concat(parts);
}

/** MessagePack decoding; extension types (unused by Fish) are refused. Maps have no prototype. */
export function unpackMsg(buf: Buffer): unknown {
  let at = 0;
  const take = (n: number) => {
    if (at + n > buf.length) throw new Error("msgpack: truncated message");
    const start = at; at += n; return start;
  };
  const str = (n: number) => { const start = take(n); return buf.toString("utf8", start, start + n); };
  const bin = (n: number) => { const start = take(n); return buf.subarray(start, start + n); };
  const items = (n: number) => { if (n > buf.length - at) throw new Error("msgpack: truncated message"); return n; };
  const arr = (n: number): unknown[] => Array.from({ length: items(n) }, () => read());
  const map = (n: number) => {
    const out: Record<string, unknown> = Object.create(null);
    for (let i = items(n); i > 0; i -= 1) { const key = String(read()); out[key] = read(); }
    return out;
  };
  const read = (): unknown => {
    const t = buf[take(1)]!;
    if (t < 0x80) return t;
    if (t < 0x90) return map(t & 0x0f);
    if (t < 0xa0) return arr(t & 0x0f);
    if (t < 0xc0) return str(t & 0x1f);
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(buf.readUInt8(take(1)));
      case 0xc5: return bin(buf.readUInt16BE(take(2)));
      case 0xc6: return bin(buf.readUInt32BE(take(4)));
      case 0xca: return buf.readFloatBE(take(4));
      case 0xcb: return buf.readDoubleBE(take(8));
      case 0xcc: return buf.readUInt8(take(1));
      case 0xcd: return buf.readUInt16BE(take(2));
      case 0xce: return buf.readUInt32BE(take(4));
      case 0xcf: return Number(buf.readBigUInt64BE(take(8)));
      case 0xd0: return buf.readInt8(take(1));
      case 0xd1: return buf.readInt16BE(take(2));
      case 0xd2: return buf.readInt32BE(take(4));
      case 0xd3: return Number(buf.readBigInt64BE(take(8)));
      case 0xd9: return str(buf.readUInt8(take(1)));
      case 0xda: return str(buf.readUInt16BE(take(2)));
      case 0xdb: return str(buf.readUInt32BE(take(4)));
      case 0xdc: return arr(buf.readUInt16BE(take(2)));
      case 0xdd: return arr(buf.readUInt32BE(take(4)));
      case 0xde: return map(buf.readUInt16BE(take(2)));
      case 0xdf: return map(buf.readUInt32BE(take(4)));
    }
    throw new Error(`msgpack: unsupported type 0x${t.toString(16)}`);
  };
  return read();
}

export type FishConnect = (url: string, headers: Record<string, string>) => WebSocket;
const connectFish: FishConnect = (url, headers) => new WsClient(url, { headers, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000 });
const asBuffer = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
/** "Unexpected server response: 402" becomes fish_402; any other failure a fixed class. */
const failureCode = (error: unknown) => {
  const status = /Unexpected server response: (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1];
  return status ? `fish_${status}` : "fish_unreachable";
};

/** Bridges one browser socket to Fish speech to text (for the session) and Drama 3 (one connection per reply). */
export function bridgeFishVoice(client: WebSocket, options: {
  apiKey: string;
  connect?: FishConnect;
  onClose?: (metadata: { reason: string; replies: number }) => void;
}): () => void {
  const connect = options.connect ?? connectFish;
  const auth = { Authorization: `Bearer ${options.apiKey}` };
  let stopped = false;
  let replies = 0;
  let tts: WebSocket | null = null;
  const toClient = (data: Buffer | string) => {
    if (stopped || client.readyState !== 1) return;
    if (client.bufferedAmount > MAX_BUFFERED) { stop("voice_transport_limit", 1009); return; }
    client.send(data, { binary: typeof data !== "string" });
  };
  const toAsr = (message: Record<string, unknown>) => { if (asr.readyState === 1) asr.send(packMsg(message)); };
  const endTts = () => {
    const current = tts;
    tts = null;
    if (current && current.readyState < 2) current.terminate();
  };
  const stop = (reason: string, code = 1011) => {
    if (stopped) return;
    stopped = true;
    endTts();
    if (asr.readyState < 2) asr.terminate();
    if (client.readyState < 2) client.close(code, reason);
    options.onClose?.({ reason, replies });
  };
  const say = (text: string, voice: string) => {
    endTts();
    const socket = connect(FISH_TTS_URL, { ...auth, model: "drama-3" });
    tts = socket;
    replies += 1;
    let finished = false;
    const done = (reason: string) => {
      if (finished || tts !== socket) return;
      finished = true;
      endTts();
      toClient(JSON.stringify({ type: "tts_done", reason }));
    };
    socket.on("open", () => {
      if (tts !== socket) return;
      socket.send(packMsg({ event: "start", request: { text: "", reference_id: voice, format: "pcm", sample_rate: FISH_TTS_SAMPLE_RATE, latency: "balanced" } }));
      socket.send(packMsg({ event: "text", text }));
      socket.send(packMsg({ event: "stop" }));
    });
    socket.on("message", (data: RawData) => {
      if (tts !== socket) return;
      let message: Record<string, unknown>;
      try { message = unpackMsg(asBuffer(data)) as Record<string, unknown>; } catch { done("error"); return; }
      if (message.event === "audio" && message.audio instanceof Uint8Array) toClient(Buffer.from(message.audio));
      else if (message.event === "finish") done(message.reason === "stop" ? "stop" : "error");
    });
    socket.on("error", (error) => done(failureCode(error)));
    socket.on("close", () => done("error"));
  };

  const asr = connect(FISH_ASR_URL, { ...auth, model: "transcribe-stream-1" });
  asr.on("open", () => {
    if (!stopped) asr.send(packMsg({ type: "config", audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 }, results: { diarize: false } }));
  });
  asr.on("message", (data: RawData) => {
    let message: Record<string, unknown>;
    try { message = unpackMsg(asBuffer(data)) as Record<string, unknown>; } catch { stop("fish_invalid_event"); return; }
    if (typeof message.type !== "string" || !ASR_EVENTS.has(message.type)) return;
    const event: Record<string, unknown> = {};
    for (const field of ASR_FIELDS) if (field in message) event[field] = message[field];
    toClient(JSON.stringify(event));
  });
  asr.on("error", (error) => stop(failureCode(error)));
  asr.on("close", () => stop("fish_closed"));

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (stopped) return;
    const frame = asBuffer(data);
    if (frame.length > MAX_CLIENT_FRAME) { stop("voice_frame_too_large", 1009); return; }
    if (isBinary) { toAsr({ type: "audio", data: frame }); return; }
    let message: { type?: unknown; text?: unknown; voice?: unknown; speaking?: unknown };
    try { message = JSON.parse(frame.toString("utf8")); } catch { stop("voice_invalid_message", 1008); return; }
    if (message.type === "say" && typeof message.text === "string" && message.text.trim() && typeof message.voice === "string" && FISH_VOICE_ID.test(message.voice)) {
      say(message.text.slice(0, MAX_SAY_CHARS), message.voice);
    } else if (message.type === "stop") endTts();
    else if (message.type === "agent_speaking" && typeof message.speaking === "boolean") toAsr({ type: "agent_speaking", speaking: message.speaking });
    else stop("voice_invalid_message", 1008);
  });
  client.on("close", () => stop("client_closed", 1000));
  client.on("error", () => stop("client_error"));
  return () => stop("server_shutdown", 1001);
}
