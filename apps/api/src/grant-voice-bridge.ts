import { WebSocket as WsClient, type RawData, type WebSocket } from "ws";
import { LIVEKIT_INFERENCE_WS, liveKitInferenceToken, type GrantVoicePlan } from "./voice-grants.js";

/**
 * Startup grant Live providers (LiveKit Inference, Cartesia, Murf AI, AssemblyAI; plan clipboard:dwUAko_YB9yG): the same
 * browser protocol as the Fish bridge (binary 16 kHz PCM in, binary 24 kHz PCM out; JSON `say`/`stop`/`agent_speaking` in,
 * `session_started`/`user_turn_taken`/`committed`/`tts_done` out), with the grant's speech to text and voice behind it.
 * Keys stay on the server; provider texts never reach logs or close reasons, only `<grant>_<http status>` codes.
 */
export type GrantConnect = (url: string, headers: Record<string, string>) => WebSocket;
const connectGrant: GrantConnect = (url, headers) => new WsClient(url, { headers, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000 });
export const ASSEMBLYAI_STREAM_URL = "wss://streaming.assemblyai.com/v3/ws";
export const CARTESIA_STT_URL = "wss://api.cartesia.ai/stt/websocket";
export const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
export const MURF_STREAM_URL = "https://api.murf.ai/v1/speech/stream";
export const CARTESIA_VERSION = "2025-04-16";
const MAX_CLIENT_FRAME = 64 * 1024;
const MAX_BUFFERED = 1024 * 1024;
const MAX_SAY_CHARS = 4000;
const END_GRACE_MS = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const asBuffer = (data: RawData) => Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
const parse = (data: RawData): Record<string, unknown> | null => {
  try { const value = JSON.parse(asBuffer(data).toString("utf8")); return value && typeof value === "object" ? value : null; } catch { return null; }
};
/** "Unexpected server response: 401" (ws) or an HTTP status becomes `<grant>_401`; anything else `<grant>_unreachable`. */
const failureCode = (grant: string, error: unknown) => {
  const status = typeof error === "number" ? String(error) : /Unexpected server response: (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1];
  return status ? `${grant}_${status}` : `${grant}_unreachable`;
};
/** The voice the browser asked for when it fits this voice engine; otherwise the model's default. */
export function grantVoice(tts: GrantVoicePlan["tts"], requested: unknown): string {
  const voice = typeof requested === "string" ? requested : "";
  const family = tts.engine === "livekit" ? tts.model?.split("/")[0] : tts.engine;
  const fits = family === "murf" ? /^[a-z]{2}-[A-Z]{2}-[A-Za-z]{1,40}$/ : family === "rime" ? /^[a-z][a-z_]{0,40}$/ : family === "inworld" ? /^[A-Z][A-Za-z]{0,40}$/ : UUID;
  return fits.test(voice) ? voice : tts.voice;
}
const baseLanguage = (language?: string) => language?.toLowerCase().split(/[-_]/)[0] || undefined;

type Speech = { socket: WebSocket; audio: (pcm: Buffer) => void; end: () => void };
type Events = { started: () => void; turn: () => void; commit: (text: string) => void; fail: (reason: string) => void };

/** Speech to text: one socket for the session; turn ends come from the provider. */
function openSpeech(plan: GrantVoicePlan, connect: GrantConnect, on: Events): Speech {
  const language = baseLanguage(plan.language);
  let inTurn = false;
  const partial = (text: unknown) => { if (!inTurn && typeof text === "string" && text.trim()) { inTurn = true; on.turn(); } };
  const final = (text: unknown) => { inTurn = false; if (typeof text === "string" && text.trim()) on.commit(text.trim()); };
  const { engine } = plan.stt;
  if (engine === "assemblyai") {
    const query = new URLSearchParams({ sample_rate: "16000", encoding: "pcm_s16le", format_turns: "true",
      speech_model: language === "en" ? "universal-streaming-english" : "universal-streaming-multilingual" });
    const socket = connect(`${ASSEMBLYAI_STREAM_URL}?${query}`, { Authorization: plan.keys.assemblyai ?? "" });
    socket.on("message", (data: RawData) => {
      const message = parse(data);
      if (message?.type === "Begin") on.started();
      else if (message?.type === "Turn") { if (message.end_of_turn === true) final(message.transcript); else partial(message.transcript); }
      // 1008 "Too many concurrent sessions": the grant's concurrency cap; only the numeric code leaves the server.
      else if (message?.type === "Error") on.fail(`assemblyai_${Number(message.error_code) || "error"}`);
    });
    return { socket, audio: (pcm) => socket.send(pcm), end: () => socket.send(JSON.stringify({ type: "Terminate" })) };
  }
  if (engine === "cartesia") {
    // shortcut: built from Cartesia's published STT docs without a key to test against; check it once the grant key is installed.
    const query = new URLSearchParams({ model: plan.stt.model ?? "ink-whisper", encoding: "pcm_s16le", sample_rate: "16000", ...(language ? { language } : {}) });
    const socket = connect(`${CARTESIA_STT_URL}?${query}`, { "X-API-Key": plan.keys.cartesia ?? "", "Cartesia-Version": CARTESIA_VERSION });
    socket.on("open", () => on.started());
    socket.on("message", (data: RawData) => {
      const message = parse(data);
      if (message?.type === "transcript") { if (message.is_final === true) final(message.text); else partial(message.text); }
    });
    return { socket, audio: (pcm) => socket.send(pcm), end: () => socket.send("done") };
  }
  const model = plan.stt.model ?? "deepgram/nova-3";
  const socket = connect(`${LIVEKIT_INFERENCE_WS}/stt?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${liveKitInferenceToken(plan.keys.livekit!)}` });
  socket.on("open", () => socket.send(JSON.stringify({ type: "session.create", model,
    settings: { sample_rate: "16000", encoding: "pcm_s16le", ...(language ? { language } : {}), extra: {} } })));
  socket.on("message", (data: RawData) => {
    const message = parse(data);
    if (message?.type === "session.created") on.started();
    else if (message?.type === "interim_transcript" || message?.type === "preflight_transcript") partial(message.transcript);
    else if (message?.type === "final_transcript") final(message.transcript);
    else if (message?.type === "error") on.fail("livekit_error");
  });
  return { socket, audio: (pcm) => socket.send(JSON.stringify({ type: "input_audio", audio: pcm.toString("base64") })),
    end: () => socket.send(JSON.stringify({ type: "session.close" })) };
}

/** One reply: streams 24 kHz PCM to `audio`, then calls `done` once ("stop" when complete). Returns a cancel. */
function speak(plan: GrantVoicePlan, text: string, voice: string, deps: { connect: GrantConnect; fetch: typeof fetch },
  audio: (pcm: Buffer) => void, done: (reason: string) => void): () => void {
  const language = baseLanguage(plan.language);
  const { engine } = plan.tts;
  if (engine === "livekit") {
    const model = plan.tts.model ?? "cartesia/sonic-3";
    const socket = deps.connect(`${LIVEKIT_INFERENCE_WS}/tts?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${liveKitInferenceToken(plan.keys.livekit!)}` });
    const config = { model, voice, ...(language ? { language } : {}) };
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "session.create", sample_rate: "24000", encoding: "pcm_s16le", ...config, extra: {} }));
      socket.send(JSON.stringify({ type: "input_transcript", transcript: `${text} `, generation_config: config, extra: {} }));
      socket.send(JSON.stringify({ type: "session.flush" }));
    });
    socket.on("message", (data: RawData) => {
      const message = parse(data);
      if (message?.type === "output_audio" && typeof message.audio === "string") audio(Buffer.from(message.audio, "base64"));
      else if (message?.type === "done") done("stop");
      else if (message?.type === "error") done("livekit_error");
    });
    socket.on("error", (error) => done(failureCode("livekit", error)));
    socket.on("close", () => done("livekit_closed"));
    return () => { if (socket.readyState < 2) socket.terminate(); };
  }
  const controller = new AbortController();
  const request = engine === "murf"
    ? { url: MURF_STREAM_URL, headers: <Record<string, string>>{ "api-key": plan.keys.murf ?? "" },
      body: { text, voiceId: voice, model: "FALCON", format: "PCM", sampleRate: 24000, channelType: "MONO" } }
    : { url: CARTESIA_TTS_URL, headers: <Record<string, string>>{ "X-API-Key": plan.keys.cartesia ?? "", "Cartesia-Version": CARTESIA_VERSION },
      body: { model_id: plan.tts.model ?? "sonic-3", transcript: text, voice: { mode: "id", id: voice }, ...(language ? { language } : {}),
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 } } };
  void (async () => {
    const response = await deps.fetch(request.url, { method: "POST", signal: controller.signal,
      headers: { ...request.headers, "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
    if (!response.ok || !response.body) { done(failureCode(engine, response.status)); return; }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) audio(Buffer.from(chunk));
    done("stop");
  })().catch((error) => { if (!controller.signal.aborted) done(failureCode(engine, error)); });
  return () => controller.abort();
}

/** Bridges one browser socket to a grant's speech to text (for the session) and voice (one request per reply). */
export function bridgeGrantVoice(client: WebSocket, options: {
  plan: GrantVoicePlan;
  connect?: GrantConnect;
  fetch?: typeof fetch;
  onClose?: (metadata: { reason: string; replies: number }) => void;
}): () => void {
  const deps = { connect: options.connect ?? connectGrant, fetch: options.fetch ?? fetch };
  const { plan } = options;
  let stopped = false;
  let replies = 0;
  let cancelReply: (() => void) | null = null;
  const toClient = (data: Buffer | string) => {
    if (stopped || client.readyState !== 1) return;
    if (client.bufferedAmount > MAX_BUFFERED) { stop("voice_transport_limit", 1009); return; }
    client.send(data, { binary: typeof data !== "string" });
  };
  const event = (message: Record<string, unknown>) => toClient(JSON.stringify(message));
  const endReply = () => { const cancel = cancelReply; cancelReply = null; cancel?.(); };
  const stop = (reason: string, code = 1011) => {
    if (stopped) return;
    stopped = true;
    endReply();
    // The provider frees its session only after answering the end message (AssemblyAI caps concurrent sessions), so let it
    // close the socket; END_GRACE_MS is how long it gets before the socket is cut.
    let ended = false;
    try { if (speech.socket.readyState === 1) { speech.end(); ended = true; } } catch { /* the socket is already gone: nothing to end */ }
    if (ended) { const cut = setTimeout(() => speech.socket.terminate(), END_GRACE_MS); speech.socket.once("close", () => clearTimeout(cut)); }
    else if (speech.socket.readyState < 2) speech.socket.terminate();
    if (client.readyState < 2) client.close(code, reason);
    options.onClose?.({ reason, replies });
  };
  const say = (text: string, voice: string) => {
    endReply();
    replies += 1;
    let finished = false;
    const cancel = speak(plan, text, voice, deps, (pcm) => { if (!finished && cancelReply === cancel) toClient(pcm); }, (reason) => {
      if (finished || cancelReply !== cancel) return;
      finished = true;
      endReply();
      event({ type: "tts_done", reason });
    });
    cancelReply = cancel;
  };

  const speech = openSpeech(plan, deps.connect, {
    started: () => event({ type: "session_started" }),
    turn: () => event({ type: "user_turn_taken" }),
    commit: (text) => event({ type: "committed", text, user_turn: true }),
    fail: (reason) => stop(reason)
  });
  speech.socket.on("error", (error) => stop(failureCode(plan.stt.engine, error)));
  speech.socket.on("close", () => stop(`${plan.stt.engine}_closed`));

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (stopped) return;
    const frame = asBuffer(data);
    if (frame.length > MAX_CLIENT_FRAME) { stop("voice_frame_too_large", 1009); return; }
    if (isBinary) { if (speech.socket.readyState === 1) speech.audio(frame); return; }
    let message: { type?: unknown; text?: unknown; voice?: unknown; speaking?: unknown };
    try { message = JSON.parse(frame.toString("utf8")); } catch { stop("voice_invalid_message", 1008); return; }
    if (message.type === "say" && typeof message.text === "string" && message.text.trim()) say(message.text.slice(0, MAX_SAY_CHARS), grantVoice(plan.tts, message.voice));
    else if (message.type === "stop") endReply();
    else if (message.type === "agent_speaking" && typeof message.speaking === "boolean") return;
    else stop("voice_invalid_message", 1008);
  });
  client.on("close", () => stop("client_closed", 1000));
  client.on("error", () => stop("client_error"));
  return () => stop("server_shutdown", 1001);
}
