import { randomBytes } from "node:crypto";

/**
 * Nous Live's relay (nous_msg:85541f3e): the Nous app speaks only Gemini Live's messages, so a provider it cannot reach itself
 * (OpenAI's and Vercel AI Gateway's realtime, the Local PC's Qwen3) runs through the server. The phone opens `/api/nous/live/relay/<ticket>`
 * with a one-use ticket (the mobile gate lets no cookie WebSocket through, as Gemini's own token sits in its URL), and the bridge
 * below translates both ways. The provider's credentials and Nous's context stay on the server.
 */
export type NousLiveRelayTool = { name: string; description: string; parameters: Record<string, unknown> };
export type NousLiveRelayPlan = {
  provider: "vercel" | "local" | "openai";
  model: string;
  voice: string | null;
  /** The spoken language the operator chose ("auto" hears both). */
  language: "el" | "en" | "auto";
  instructions: string;
  tools: NousLiveRelayTool[];
};
/** The provider's socket, opened up front so a provider that fails falls back before the phone connects. */
export type NousLiveRelayUpstream = { url: string; protocols?: string[] };
type Ticket = { plan: NousLiveRelayPlan; upstream: NousLiveRelayUpstream; expiresAt: number };

/** Technical: the phone connects within seconds of the start call; an unused ticket (the phone gave up) frees itself. */
export const NOUS_LIVE_RELAY_TICKET_MS = 120_000;

export class NousLiveRelayTickets {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now: () => number = Date.now) {}
  create(plan: NousLiveRelayPlan, upstream: NousLiveRelayUpstream): { ticket: string; expiresAt: number } {
    for (const [id, entry] of this.tickets) if (entry.expiresAt <= this.now()) this.tickets.delete(id);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + NOUS_LIVE_RELAY_TICKET_MS;
    this.tickets.set(ticket, { plan, upstream, expiresAt });
    return { ticket, expiresAt };
  }
  /** One use: a second connect with the same ticket finds nothing. */
  take(ticket: string): Omit<Ticket, "expiresAt"> | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return entry && entry.expiresAt > this.now() ? entry : null;
  }
  clear() { this.tickets.clear(); }
}

/** 16-bit mono PCM from one rate to another (linear): the phone records 16 kHz and plays 24 kHz. */
export function resamplePcm16(input: Buffer, from: number, to: number): Buffer {
  const count = Math.floor(input.length / 2);
  if (from === to || !count) return input.subarray(0, count * 2);
  const outCount = Math.floor(count * to / from);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    const position = i * from / to;
    const index = Math.floor(position);
    const a = input.readInt16LE(index * 2);
    const b = index + 1 < count ? input.readInt16LE((index + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * (position - index)), i * 2);
  }
  return out;
}
const resample64 = (data: string, from: number, to: number) => resamplePcm16(Buffer.from(data, "base64"), from, to).toString("base64");

/** Vercel AI Gateway's realtime session, as the Live pane configures it (live-session.ts). */
export const gatewayConfig = (plan: NousLiveRelayPlan) => ({
  instructions: plan.instructions,
  ...(plan.voice ? { voice: plan.voice } : {}),
  outputModalities: ["audio"],
  inputAudioFormat: { type: "audio/pcm", rate: 24000 },
  outputAudioFormat: { type: "audio/pcm", rate: 24000 },
  // Semantic VAD waits for an unfinished sentence; it exists only for OpenAI models.
  turnDetection: { type: plan.model.startsWith("openai/") ? "semantic-vad" : "server-vad" },
  inputAudioTranscription: plan.language === "el" ? { language: "el" } : {},
  outputAudioTranscription: {},
  tools: plan.tools.map((tool) => ({ type: "function", ...tool }))
});

/** OpenAI's realtime (GA) session: the Gateway's config in OpenAI's own shape. */
export const openaiSession = (plan: NousLiveRelayPlan) => ({
  type: "realtime",
  instructions: plan.instructions,
  output_modalities: ["audio"],
  audio: {
    input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { type: "semantic_vad" },
      transcription: { model: "gpt-4o-transcribe", ...(plan.language === "el" ? { language: "el" } : {}) } },
    output: { format: { type: "audio/pcm", rate: 24000 }, ...(plan.voice ? { voice: plan.voice } : {}) }
  },
  tools: plan.tools.map((tool) => ({ type: "function", ...tool }))
});

/** The bridge speaks the Gateway's events; OpenAI's are the same events under other names, translated both ways here. */
export function toOpenAi(message: Record<string, unknown>, plan: NousLiveRelayPlan): Record<string, unknown> | null {
  const item = message.item as Record<string, unknown> | undefined;
  switch (message.type) {
    case "session-update": return { type: "session.update", session: openaiSession(plan) };
    case "input-audio-append": return { type: "input_audio_buffer.append", audio: message.audio };
    case "response-create": return { type: "response.create" };
    case "conversation-item-create":
      return { type: "conversation.item.create", item: item?.type === "function-call-output"
        ? { type: "function_call_output", call_id: item.callId, output: item.output }
        : { type: "message", role: "user", content: [{ type: "input_text", text: item?.text }] } };
    default: return null;
  }
}
const OPENAI_EVENTS: Record<string, string> = {
  "session.updated": "session-updated", "input_audio_buffer.speech_started": "speech-started", "response.output_audio.delta": "audio-delta",
  "conversation.item.input_audio_transcription.completed": "input-transcription-completed", "response.output_audio_transcript.delta": "audio-transcript-delta",
  "response.output_text.delta": "text-delta", "response.created": "response-created", "response.done": "response-done",
  "response.function_call_arguments.done": "function-call-arguments-done", error: "error"
};
export function fromOpenAi(event: Record<string, unknown>): Record<string, unknown> {
  const type = OPENAI_EVENTS[String(event.type)] ?? String(event.type);
  const response = record(event.response), error = record(event.error);
  return { ...event, type, ...(response ? { status: response.status } : {}), ...(event.call_id !== undefined ? { callId: event.call_id } : {}),
    ...(error ? { message: error.message, code: error.code } : {}) };
}

/** The two sockets as `ws` gives them; tests pass fakes. */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
const OPEN = 1;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const parse = (data: Buffer): Json | null => { try { return record(JSON.parse(data.toString("utf8"))); } catch { return null; } };
/** A close reason is at most 123 bytes; what the phone shows as the failure. */
const reasonText = (text: string) => Buffer.from(text, "utf8").subarray(0, 120).toString("utf8").replace(/�+$/, "");

/** Relays one phone to its provider until either side closes; returns the stop the API's preClose calls. */
export function bridgeNousLive(phone: RelaySocket, upstream: RelaySocket, plan: NousLiveRelayPlan,
  onClose: (metadata: { provider: string; code: number }) => void): () => void {
  let done = false;
  // The phone's setup arrives while the provider's socket still connects: it waits for the open.
  const pending: Array<string | Buffer> = [];
  const openai = plan.provider === "openai";
  const up = (message: Json | Buffer) => {
    const translated = openai && !Buffer.isBuffer(message) ? toOpenAi(message, plan) : message;
    if (!translated) return;
    const data = Buffer.isBuffer(translated) ? translated : JSON.stringify(translated);
    if (upstream.readyState === OPEN) upstream.send(data);
    else if (upstream.readyState === 0) pending.push(data);
  };
  const down = (message: Json) => { if (phone.readyState === OPEN) phone.send(JSON.stringify(message)); };
  const content = (serverContent: Json) => down({ serverContent });
  const audioDown = (pcm24: string) => content({ modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm24 } }] } });
  const stop = (code = 1000, reason = "") => {
    if (done) return;
    done = true;
    for (const socket of [phone, upstream]) if (socket.readyState <= OPEN) { try { socket.close(code, reasonText(reason)); } catch { /* already gone */ } }
    onClose({ provider: plan.provider, code });
  };
  const local = plan.provider === "local";
  // Gateway: what waits for the current response to end before the next response-create (tool outputs, Nous's answer).
  let active = 0, wanted = false, started = false;
  const respond = () => { if (wanted && active === 0) { wanted = false; up({ type: "response-create" }); } };

  const fromPhone = (message: Json) => {
    if (message.setup) {
      // The phone's Gemini setup is ignored: the plan the server holds is the session.
      if (!local) up({ type: "session-update", config: gatewayConfig(plan) });
      return;
    }
    const audio = record(record(message.realtimeInput)?.audio)?.data;
    if (typeof audio === "string") {
      if (local) up(Buffer.from(audio, "base64"));
      else if (started) up({ type: "input-audio-append", audio: resample64(audio, 16000, 24000) });
      return;
    }
    const answers = record(message.toolResponse)?.functionResponses;
    if (Array.isArray(answers) && !local) {
      for (const answer of answers.map(record)) {
        if (!answer) continue;
        const output = record(answer.response)?.output;
        up({ type: "conversation-item-create", item: { type: "function-call-output", callId: String(answer.id ?? ""), name: String(answer.name ?? ""),
          output: typeof output === "string" ? output : JSON.stringify(answer.response ?? {}) } });
      }
      wanted = true;
      respond();
      return;
    }
    const turns = record(message.clientContent)?.turns;
    const text = (Array.isArray(turns) ? turns : []).flatMap((turn) => record(turn)?.parts ?? []).map((part) => record(part)?.text).filter((part) => typeof part === "string").join("\n");
    if (!text) return;
    if (local) up({ type: "text", text });
    else { up({ type: "conversation-item-create", item: { type: "text-message", role: "user", text } }); wanted = true; respond(); }
  };

  const fromGateway = (event: Json) => {
    switch (event.type) {
      case "session-updated": if (!started) { started = true; down({ setupComplete: {} }); } break;
      case "speech-started": content({ interrupted: true }); break;
      case "audio-delta": if (typeof event.delta === "string") audioDown(event.delta); break;
      case "input-transcription-completed": if (typeof event.transcript === "string") content({ inputTranscription: { text: event.transcript } }); break;
      case "audio-transcript-delta": case "text-delta": if (typeof event.delta === "string") content({ outputTranscription: { text: event.delta } }); break;
      case "response-created": active++; break;
      case "response-done":
        active = Math.max(0, active - 1);
        if (event.status === "failed") { stop(1011, `${plan.model}: the response failed.`); return; }
        content({ turnComplete: true });
        respond();
        break;
      case "function-call-arguments-done": {
        let args: unknown = {};
        try { args = JSON.parse(String(event.arguments ?? "{}")); } catch { /* the tool answers its own error */ }
        down({ toolCall: { functionCalls: [{ id: String(event.callId ?? ""), name: String(event.name ?? ""), args: record(args) ?? {} }] } });
        break;
      }
      case "error":
        // DEV3D-005: a response-create racing a VAD-started response is refused, not fatal; ask again when that one ends.
        if (event.code === "conversation_already_has_active_response") { wanted = true; break; }
        stop(1011, `${plan.model}: ${typeof event.message === "string" ? event.message : "the provider failed."}`); break;
    }
  };

  const fromLocal = (data: Buffer, binary: boolean) => {
    if (binary) { audioDown(resamplePcm16(data, 16000, 24000).toString("base64")); return; }
    const message = parse(data);
    if (!message) return;
    if (typeof message.audio_base64 === "string") audioDown(resample64(message.audio_base64, 16000, 24000));
    if (message.type === "user_transcript" && typeof message.text === "string") content({ inputTranscription: { text: message.text } });
    if (message.type === "assistant_text" && typeof message.text === "string") content({ outputTranscription: { text: message.text } });
    if (message.type === "listening") content({ turnComplete: true });
    if (message.type === "error") stop(1011, `Local PC: ${typeof message.message === "string" ? message.message : "the voice service failed."}`);
  };

  phone.on("message", (data, binary) => { if (!binary) { const message = parse(data); if (message) fromPhone(message); } });
  upstream.on("message", (data, binary) => {
    if (local) { fromLocal(data, binary); return; }
    const event = binary ? null : parse(data);
    if (event) fromGateway(openai ? fromOpenAi(event) : event);
  });
  upstream.on("open", () => {
    // The local service starts on `start` and says nothing back, so the phone may talk once it is open.
    if (local) up({ type: "start", sample_rate: 16000, language: plan.language });
    for (const data of pending.splice(0)) upstream.send(data);
    if (local) down({ setupComplete: {} });
  });
  phone.on("close", () => stop(1000));
  phone.on("error", () => stop(1011, "The phone's connection failed."));
  upstream.on("close", (code, reason) => stop(code === 1000 ? 1000 : 1011, reason.toString("utf8") || `${plan.provider} closed the voice (${code}).`));
  upstream.on("error", () => stop(1011, `${{ local: "Local PC", vercel: "Vercel AI Gateway", openai: "OpenAI" }[plan.provider]} could not be reached.`));
  return () => stop(1001, "Space is restarting.");
}

/** What the relay needs of SetupOwnerVoiceRuntime: the caller's own credentials mint the upstream session. */
export type NousLiveVoiceRuntime = {
  call(owner: string, input: { provider: "vercel"; model: string; language: "el" | "en" | "auto"; voice?: string }): Promise<{ websocketUrl?: string; token?: string }>;
  localSession(owner: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** A short-lived OpenAI realtime client secret from the caller's key (the key itself never sits in a ticket). */
  openaiRealtime(owner: string, model: string): Promise<{ websocketUrl: string; token: string }>;
};

/** The provider's session before the phone connects: a provider that cannot start throws here and the next one is tried. */
export async function relayUpstream(runtime: NousLiveVoiceRuntime, owner: string, plan: NousLiveRelayPlan): Promise<NousLiveRelayUpstream> {
  if (plan.provider === "local") {
    const body = await runtime.localSession(owner, { language: plan.language === "en" ? "en-US" : "el-GR", prompt: plan.instructions });
    const url = [body.websocket_url, body.ws_url, body.url].find((value): value is string => typeof value === "string" && value.length > 0);
    if (!url) throw new Error("The Local PC returned no voice session.");
    return { url, ...(typeof body.token === "string" ? { protocols: [body.token] } : {}) };
  }
  if (plan.provider === "openai") {
    const session = await runtime.openaiRealtime(owner, plan.model);
    return { url: session.websocketUrl, protocols: ["realtime", `openai-insecure-api-key.${session.token}`] };
  }
  const session = await runtime.call(owner, { provider: "vercel", model: plan.model, language: plan.language, ...(plan.voice ? { voice: plan.voice } : {}) });
  if (!session.websocketUrl || !session.token) throw new Error("Vercel AI Gateway returned no realtime session.");
  return { url: session.websocketUrl, protocols: ["ai-gateway-realtime.v1", `ai-gateway-auth.${session.token}`] };
}
