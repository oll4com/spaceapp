import { readFile } from "node:fs/promises";
import type {
  VoiceRealtimeSessionResponse,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel
} from "@space/contracts";
import { voiceRealtimeSessionResponseSchema } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

export const voiceTranscriptionModelOptions: VoiceTranscriptionModel[] = [
  "gpt-realtime-whisper",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1"
];
export const voiceTranscriptionLanguageOptions: VoiceTranscriptionLanguage[] = ["auto", "el", "en"];
export const voiceTranscriptionDelayOptions: VoiceTranscriptionDelay[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface VoiceRealtimeCallInput {
  offerSdp: string;
  model: VoiceTranscriptionModel;
  language: VoiceTranscriptionLanguage;
  delay?: VoiceTranscriptionDelay;
  safetyIdentifier?: string | null;
}

function normalizedBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.replace(/\/+$/, "");
}

function parseOpenAiError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
  if (!error || typeof error.message !== "string") return fallback;
  return typeof error.code === "string" ? `${error.code}: ${error.message}` : error.message;
}

function buildRealtimeSessionConfig(
  config: SpaceApiConfig,
  input: Pick<VoiceRealtimeCallInput, "model" | "language" | "delay">
) {
  const transcription: {
    model: VoiceTranscriptionModel;
    language?: Exclude<VoiceTranscriptionLanguage, "auto">;
    delay?: VoiceTranscriptionDelay;
  } = {
    model: input.model
  };
  if (input.language !== "auto") {
    transcription.language = input.language;
  }
  transcription.delay = input.delay ?? config.voiceTranscriptionDelay;
  return {
    type: "transcription",
    audio: {
      input: {
        transcription,
        turn_detection: null
      }
    }
  };
}

export async function createVoiceRealtimeCall(
  config: SpaceApiConfig,
  input: VoiceRealtimeCallInput
): Promise<VoiceRealtimeSessionResponse> {
  if (!config.voiceTranscriptionEnabled) {
    throw new Error("Voice transcription is disabled.");
  }
  if (!config.voiceTranscriptionKeyFile) {
    throw new Error("Voice transcription key file is not configured.");
  }

  const apiKey = (await readFile(config.voiceTranscriptionKeyFile, "utf8")).trim();
  if (!apiKey) {
    throw new Error("Voice transcription key file is empty.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.voiceTranscriptionTimeoutMs);
  try {
    const form = new FormData();
    form.append("sdp", input.offerSdp);
    form.append("session", JSON.stringify(buildRealtimeSessionConfig(config, input)));

    const response = await fetch(`${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/realtime/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(input.safetyIdentifier ? { "OpenAI-Safety-Identifier": input.safetyIdentifier } : {})
      },
      body: form,
      signal: controller.signal
    });
    const rawBody = await response.text();
    if (!response.ok) {
      let message = rawBody || `OpenAI Realtime call failed with HTTP ${response.status}.`;
      try {
        message = parseOpenAiError(JSON.parse(rawBody) as unknown, message);
      } catch {
        // Keep raw body fallback.
      }
      throw new Error(message);
    }
    const answerSdp = rawBody.trim();
    if (!answerSdp) {
      throw new Error("OpenAI Realtime call returned empty SDP.");
    }
    return voiceRealtimeSessionResponseSchema.parse({ answerSdp });
  } finally {
    clearTimeout(timeout);
  }
}
