import { WebSocket as WsClient, type RawData, type WebSocket } from "ws";

/**
 * Local SenseVoice-Small speech to text (plan clipboard:plan-sensevoice-e00e2efe). sherpa-onnx's offline websocket server
 * (deploy/space-local-voice-transcribe.service) decodes whole utterances, so the browser keeps the local voice protocol
 * (text "start" and "stop", binary PCM16 frames, "user_transcript" events) and this bridge cuts the audio into segments,
 * has the daemon decode each and joins the texts. Daemon request: int32 LE sample rate, int32 LE byte count, float32
 * samples; one JSON reply per request. With several work threads the daemon answers out of order (13/11), so the bridge keeps
 * one request in flight. Audio stays on this server; daemon texts never reach logs or close reasons.
 */
const MAX_CLIENT_FRAME = 64 * 1024;
const MAX_BUFFERED = 1024 * 1024;
// Technical bound: SenseVoice garbles long audio (13/11 on en.wav: 7 s clean, 10-12 s drop a word, 14 s and more repeat and lose
// phrases), so a segment is decoded by 10 s, cut in the quietest point of its last 3 s.
const SEGMENT_SECONDS = 10;
// A partial transcript after each second of new audio, while no decode is waiting.
const INTERIM_SECONDS = 1;
// The cut goes in the quietest 100 ms of the segment's last 3 s, so a word is not split.
const CUT_WINDOW_SECONDS = 0.1;
const CUT_SEARCH_SECONDS = 3;

type DecodeKind = "interim" | "segment" | "final";
export type SenseVoiceConnect = (url: string) => WebSocket;
const connectSenseVoice: SenseVoiceConnect = (url) => new WsClient(url, { maxPayload: MAX_BUFFERED, handshakeTimeout: 5_000 });
const asBuffer = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
const join = (a: string, b: string) => [a, b].filter(Boolean).join(" ");

/** One decode request in the sherpa-onnx offline websocket protocol. */
export function senseVoiceRequest(sampleRate: number, samples: Float32Array): Buffer {
  const out = Buffer.alloc(8 + samples.length * 4);
  out.writeInt32LE(sampleRate, 0);
  out.writeInt32LE(samples.length * 4, 4);
  for (let i = 0; i < samples.length; i += 1) out.writeFloatLE(samples[i]!, 8 + i * 4);
  return out;
}

/** Where a long segment is cut: the middle of the quietest window in its last seconds. */
export function quietestCut(samples: Float32Array, sampleRate: number): number {
  const window = Math.max(2, Math.round(CUT_WINDOW_SECONDS * sampleRate));
  const step = window >> 1;
  let best = samples.length - step;
  let bestEnergy = Infinity;
  for (let start = Math.max(0, samples.length - Math.round(CUT_SEARCH_SECONDS * sampleRate)); start + window <= samples.length; start += step) {
    let energy = 0;
    for (let i = start; i < start + window; i += 1) energy += samples[i]! * samples[i]!;
    if (energy < bestEnergy) { bestEnergy = energy; best = start + step; }
  }
  return best;
}

/** Bridges one browser socket to the local SenseVoice daemon. */
export function bridgeSenseVoice(client: WebSocket, options: {
  url: string;
  connect?: SenseVoiceConnect;
  onClose?: (metadata: { reason: string; decodes: number }) => void;
}): () => void {
  let stopped = false;
  let finishing = false;
  let sampleRate = 16_000;
  let open = new Float32Array(sampleRate * 4);
  let length = 0;
  let sinceInterim = 0;
  let committed = "";
  let interim = "";
  let decodes = 0;
  let inFlight: DecodeKind | null = null;
  const waiting: Array<{ kind: DecodeKind; request: Buffer }> = [];
  const busy = () => inFlight !== null || waiting.length > 0;

  const toClient = (message: Record<string, unknown>) => {
    if (stopped || client.readyState !== 1) return;
    if (client.bufferedAmount > MAX_BUFFERED) { stop("voice_transport_limit", 1009); return; }
    client.send(JSON.stringify(message));
  };
  const stop = (reason: string, code = 1011) => {
    if (stopped) return;
    stopped = true;
    if (daemon.readyState < 2) daemon.terminate();
    if (client.readyState < 2) client.close(code, reason);
    options.onClose?.({ reason, decodes });
  };
  const sendNext = () => {
    if (inFlight || daemon.readyState !== 1) return;
    const next = waiting.shift();
    if (!next) return;
    inFlight = next.kind;
    daemon.send(next.request);
  };
  const decode = (kind: DecodeKind, samples: Float32Array) => {
    decodes += 1;
    waiting.push({ kind, request: senseVoiceRequest(sampleRate, samples) });
    sendNext();
  };
  const finishIfDone = () => {
    if (!finishing || busy()) return;
    toClient({ type: "user_transcript", text: committed, final: true });
    stop("completed", 1000);
  };
  const take = (count: number) => {
    const head = open.slice(0, count);
    open.copyWithin(0, count, length);
    length -= count;
    return head;
  };
  const append = (frame: Buffer) => {
    const count = frame.length >> 1;
    if (length + count > open.length) {
      const grown = new Float32Array(Math.max(open.length * 2, length + count));
      grown.set(open.subarray(0, length));
      open = grown;
    }
    for (let i = 0; i < count; i += 1) open[length + i] = frame.readInt16LE(i * 2) / 32768;
    length += count;
    sinceInterim += count;
    if (length >= SEGMENT_SECONDS * sampleRate) {
      decode("segment", take(quietestCut(open.subarray(0, length), sampleRate)));
      sinceInterim = length;
    } else if (sinceInterim >= INTERIM_SECONDS * sampleRate && !busy()) {
      sinceInterim = 0;
      decode("interim", open.slice(0, length));
    }
  };

  const daemon = (options.connect ?? connectSenseVoice)(options.url);
  daemon.on("open", sendNext);
  daemon.on("message", (data: RawData, isBinary: boolean) => {
    const kind = inFlight;
    inFlight = null;
    let text: unknown;
    try { text = isBinary || !kind ? null : (JSON.parse(asBuffer(data).toString("utf8")) as { text?: unknown }).text; } catch { text = null; }
    if (typeof text !== "string") { stop("sensevoice_invalid_reply"); return; }
    if (kind === "interim") interim = text.trim();
    else { committed = join(committed, text.trim()); interim = ""; }
    if (kind !== "final") toClient({ type: "user_transcript", text: join(committed, interim) });
    sendNext();
    finishIfDone();
  });
  daemon.on("error", () => stop("sensevoice_unavailable"));
  daemon.on("close", () => stop("sensevoice_closed"));

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (stopped || finishing) return;
    const frame = asBuffer(data);
    if (frame.length > MAX_CLIENT_FRAME) { stop("voice_frame_too_large", 1009); return; }
    if (isBinary) { append(frame); return; }
    let message: { type?: unknown; sample_rate?: unknown };
    try { message = JSON.parse(frame.toString("utf8")); } catch { stop("voice_invalid_message", 1008); return; }
    if (message.type === "start") {
      const rate = message.sample_rate ?? sampleRate;
      if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 8_000 || rate > 192_000 || decodes || length) { stop("voice_invalid_message", 1008); return; }
      sampleRate = rate;
    } else if (message.type === "stop") {
      finishing = true;
      if (length) decode("final", take(length));
      finishIfDone();
    } else stop("voice_invalid_message", 1008);
  });
  client.on("close", () => stop("client_closed", 1000));
  client.on("error", () => stop("client_error"));
  return () => stop("server_shutdown", 1001);
}
