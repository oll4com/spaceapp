import { createGateway, getGatewayRealtimeProtocols } from "@ai-sdk/gateway";
import type { LiveAudioProviderId } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import { createLocalVoiceSession, createVoiceRealtimeCall } from "./voice-transcription.js";

export type VoiceCheckChoice = { providerId: LiveAudioProviderId; modelId: string; voiceId: string };
// Kept here, not in setup-voice-credentials.ts, so the credential store can import this module without a cycle.
export interface SetupVoiceCredential {
  apiKey: string;
  source: "OWNER" | "INSTALLATION";
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
}
export function supportsSetupVoiceProvider(providerId: LiveAudioProviderId): boolean {
  return ["google", "openai", "vercel", "local"].includes(providerId);
}
export type VoiceCheckWire = {
  url: string; headers: Record<string, string>; protocols: string[]; readyOnOpen: boolean;
  start: () => string; input: (pcm: Buffer) => Buffer | string;
  receive: (data: Buffer, binary: boolean) => { ready?: boolean; transcript?: boolean; audio?: Buffer[]; failed?: boolean };
};
const instructions = "This is a short microphone and playback check. Reply briefly to the spoken input. Do not call tools.";
const invalid = () => new Error("The selected voice transport could not be checked safely.");

/** Fractional conversion state is scoped to one transient audio stream. */
function resampler(sourceRate: number, targetRate: number) {
  let phase = 0; let previous = 0;
  return (pcm: Buffer): Buffer => {
    if (pcm.length % 2) throw invalid();
    if (sourceRate === targetRate) return pcm;
    const samples: number[] = [];
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i);
      phase += targetRate;
      while (phase >= sourceRate) {
        phase -= sourceRate;
        const weight = 1 - phase / targetRate;
        samples.push(Math.round(previous + (sample - previous) * weight));
      }
      previous = sample;
    }
    const output = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
    return output;
  };
}
function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 90_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) throw invalid();
  const pcm = Buffer.from(value, "base64");
  if (!pcm.length || pcm.length % 2) throw invalid();
  return pcm;
}
function approvedSocket(candidate: string, endpoint: string): string {
  const socket = new URL(candidate); const approved = new URL(endpoint);
  if (socket.host !== approved.host || socket.username || socket.password || socket.hash ||
    socket.protocol !== (approved.protocol === "https:" ? "wss:" : "ws:")) throw invalid();
  return socket.toString();
}
export async function createVoiceCheckWire(config: SpaceApiConfig, choice: VoiceCheckChoice, credential: SetupVoiceCredential): Promise<VoiceCheckWire> {
  const { providerId, modelId, voiceId } = choice;
  const headers: Record<string, string> = {}; let protocols: string[] = [];
  let url: string; let endpoint: string;
  const protocol = providerId === "local" ? "local" : providerId === "google" ? "google" :
    /^(?:openai\/)?gpt-live-/.test(modelId) ? "live" : providerId === "vercel" ? "gateway" : "realtime";
  if (providerId === "local") {
    endpoint = config.localVoiceProviderUrl;
    const session = await createLocalVoiceSession({ ...config, localVoiceProviderToken: credential.apiKey }, {
      language: "en-US", model: modelId, voice: voiceId, prompt: instructions
    });
    const candidate = session.websocket_url ?? session.ws_url ?? session.url;
    if (typeof candidate !== "string") throw invalid(); url = candidate;
    headers["X-Local-Voice-Token"] = credential.apiKey;
    if (typeof session.token === "string") {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,1024}$/.test(session.token)) throw invalid();
      protocols = [session.token];
    }
  } else if (providerId === "google") {
    endpoint = config.googleVoiceBaseUrl;
    const socket = new URL(`${endpoint.replace(/^http/, "ws").replace(/\/+$/, "")}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`);
    socket.searchParams.set("key", credential.apiKey); url = socket.toString();
  } else if (providerId === "vercel") {
    endpoint = config.vercelVoiceBaseUrl;
    const session = await createVoiceRealtimeCall(config, { provider: "vercel", model: modelId, language: "en" }, credential);
    if (!session.websocketUrl || !session.token || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,4096}$/.test(session.token)) throw invalid();
    url = session.websocketUrl; protocols = getGatewayRealtimeProtocols(session.token);
  } else if (providerId === "openai") {
    endpoint = config.voiceTranscriptionBaseUrl;
    const socket = new URL(`${endpoint.replace(/^http/, "ws").replace(/\/+$/, "")}/${protocol === "live" ? "live/sessions" : "realtime"}`);
    if (protocol === "realtime") socket.searchParams.set("model", modelId);
    url = socket.toString(); headers.Authorization = `Bearer ${credential.apiKey}`;
  } else throw invalid();
  url = approvedSocket(url, endpoint);
  const toProvider = resampler(16000, protocol === "google" || protocol === "local" ? 16000 : 24000);
  const fromProvider = resampler(protocol === "local" ? 16000 : 24000, 16000);
  const gateway = protocol === "gateway" ? createGateway().experimental_realtime(modelId) : null;
  const encode = (event: Parameters<NonNullable<typeof gateway>["serializeClientEvent"]>[0]) => JSON.stringify(gateway!.serializeClientEvent(event));
  return {
    url, headers, protocols, readyOnOpen: protocol === "local",
    start: () => {
      if (protocol === "local") return JSON.stringify({ type: "start", sample_rate: 16000, language: "en-US" });
      if (protocol === "google") return JSON.stringify({ setup: { model: `models/${modelId}`, generationConfig: {
        responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } }
      }, systemInstruction: { parts: [{ text: instructions }] }, inputAudioTranscription: {}, outputAudioTranscription: {} } });
      if (protocol === "live") return JSON.stringify({ type: "session.start", session: { model: modelId, store: false,
        delegation: { type: "client" }, instructions, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: voiceId } } } });
      if (protocol === "gateway") return encode({ type: "session-update", config: { instructions, voice: voiceId,
        outputModalities: ["audio"], inputAudioFormat: { type: "audio/pcm", rate: 24000 }, outputAudioFormat: { type: "audio/pcm", rate: 24000 },
        turnDetection: { type: "server-vad" }, inputAudioTranscription: { language: "en" }, outputAudioTranscription: {} } });
      return JSON.stringify({ type: "session.update", session: { type: "realtime", instructions, output_modalities: ["audio"],
        audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "whisper-1", language: "en" },
          turn_detection: { type: "server_vad", create_response: true } }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: voiceId } } } });
    },
    input: pcm => {
      const audio = toProvider(pcm).toString("base64");
      if (protocol === "local") return pcm;
      if (protocol === "google") return JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: audio } } });
      if (protocol === "gateway") return encode({ type: "input-audio-append", audio });
      return JSON.stringify({ type: protocol === "live" ? "session.input_audio.append" : "input_audio_buffer.append", audio });
    },
    receive: (data, binary) => {
      if (binary) { if (protocol !== "local") throw invalid(); return { audio: [fromProvider(data)] }; }
      const message = JSON.parse(data.toString());
      if (message.error || message.type === "error") return { failed: true };
      if (protocol === "local") return { transcript: message.type === "user_transcript" && typeof message.text === "string" && Boolean(message.text.trim()),
        audio: message.audio_base64 ? [fromProvider(base64(message.audio_base64))] : [] };
      if (protocol === "google") {
        const text = message.serverContent?.inputTranscription?.text;
        const parts: { inlineData?: { data?: string; mimeType?: string } }[] = message.serverContent?.modelTurn?.parts ?? [];
        const audio = parts.flatMap(part => {
          if (!part.inlineData) return [];
          if (part.inlineData.mimeType !== "audio/pcm;rate=24000") throw invalid();
          return [fromProvider(base64(part.inlineData.data))];
        });
        return { ready: Boolean(message.setupComplete), transcript: typeof text === "string" && Boolean(text.trim()), audio };
      }
      if (protocol === "gateway") {
        const event = gateway!.parseServerEvent(message);
        if (Array.isArray(event)) throw invalid();
        return { ready: event.type === "session-updated", failed: event.type === "error",
          transcript: event.type === "input-transcription-completed" && Boolean(event.transcript?.trim()),
          audio: event.type === "audio-delta" ? [fromProvider(base64(event.delta))] : [] };
      }
      return { ready: message.type === (protocol === "live" ? "session.started" : "session.updated"),
        transcript: message.type === "session.input_transcript.delta" ? typeof message.delta === "string" && Boolean(message.delta.trim()) :
          message.type === "conversation.item.input_audio_transcription.completed" && typeof message.transcript === "string" && Boolean(message.transcript.trim()),
        audio: ["session.output_audio.delta", "response.output_audio.delta", "response.audio.delta"].includes(message.type) ? [fromProvider(base64(message.delta))] : [] };
    }
  };
}
