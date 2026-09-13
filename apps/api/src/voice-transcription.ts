import { readFile } from "node:fs/promises";
import type {
  VoiceModelVoice,
  VoiceRealtimeSessionResponse,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel
} from "@space/contracts";
import {
  voiceRealtimeSessionResponseSchema,
  voiceTranscriptionModelSchema
} from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

export const voiceTranscriptionModelOptions: VoiceTranscriptionModel[] = [
  "gpt-transcribe",
  "gpt-live-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-live-1",
  "gpt-live-1-mini",
  "whisper-1",
  "gpt-realtime-whisper",
  "local-qwen3-greek" as VoiceTranscriptionModel
];

export async function getLocalVoiceProviderStatus(config: SpaceApiConfig): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${config.localVoiceProviderUrl.replace(/\/+$/, "")}/health`, {
      headers: config.localVoiceProviderToken ? { "X-Local-Voice-Token": config.localVoiceProviderToken } : undefined,
      signal: AbortSignal.timeout(3000)
    });
    const body = await response.json().catch(() => ({}));
    return { ...body, reachable: response.ok, configured: Boolean(config.localVoiceProviderToken) };
  } catch (error) {
    return { status: "unavailable", reachable: false, configured: Boolean(config.localVoiceProviderToken), reason: error instanceof Error ? error.message : "Provider unreachable." };
  }
}

export async function createLocalVoiceSession(config: SpaceApiConfig, input: Record<string, unknown>) {
  if (!config.localVoiceProviderToken) throw new Error("Local voice provider token is not configured on Space.");
  const response = await fetch(`${config.localVoiceProviderUrl.replace(/\/+$/, "")}/api/voice/local/sessions`, {
    method: "POST",
    headers: { "X-Local-Voice-Token": config.localVoiceProviderToken, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : `Local provider returned HTTP ${response.status}.`);
  // Provider returns a relative websocket path; browsers cannot open it directly
  // from the Space origin. Normalize it to the configured provider origin.
  if (body && typeof body === "object") {
    const candidate = typeof body.websocket_url === "string" ? "websocket_url" : typeof body.ws_url === "string" ? "ws_url" : typeof body.url === "string" ? "url" : null;
    if (candidate && typeof body[candidate] === "string" && body[candidate].startsWith("/")) {
      const base = new URL(config.localVoiceProviderUrl);
      base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      body[candidate] = `${base.origin.replace(/^http/, "ws")}${body[candidate]}`;
    }
  }
  return body;
}

export const voiceModelVoiceOptions: VoiceModelVoice[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "bossa",
  "tempo",
  "gleam"
];

export const voiceTranscriptionLanguageOptions: VoiceTranscriptionLanguage[] = ["auto", "el", "en"];
export const voiceTranscriptionDelayOptions: VoiceTranscriptionDelay[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface VoiceRealtimeCallInput {
  offerSdp: string;
  model: VoiceTranscriptionModel | string;
  language: VoiceTranscriptionLanguage;
  delay?: VoiceTranscriptionDelay;
  voice?: VoiceModelVoice;
  opening?: string;
  prompt?: string;
  delegatedModel?: string;
  delegatedType?: "responses" | "client";
  delegatedReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  delegatedWebSearch?: boolean;
  delegatedPrompt?: string;
  safetyIdentifier?: string | null;
  tools?: Array<Record<string, unknown>>;
}

export interface VoiceAttachmentResponseInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  model: string;
  prompt?: string;
}

/** Run an authenticated, non-persistent vision/file turn for the Live bridge. */
export async function createVoiceAttachmentResponse(
  config: SpaceApiConfig,
  input: VoiceAttachmentResponseInput
): Promise<{ text: string }> {
  if (!config.voiceTranscriptionEnabled || !config.voiceTranscriptionKeyFile) {
    throw new Error("Voice transcription is disabled.");
  }
  if (!input.buffer.byteLength || input.buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error("Attachment must be between 1 byte and 10MB.");
  }
  const apiKey = (await readFile(config.voiceTranscriptionKeyFile, "utf8")).trim();
  if (!apiKey) throw new Error("Voice transcription key file is empty.");
  const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;
  const isImage = input.mimeType.startsWith("image/");
  const content = [
    { type: "input_text", text: input.prompt?.trim() || "Describe this attachment and answer the user's implied question concisely." },
    isImage
      ? { type: "input_image", image_url: dataUrl, detail: "auto" }
      : { type: "input_file", filename: input.filename, file_data: dataUrl }
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.voiceTranscriptionTimeoutMs);
  try {
    const response = await fetch(`${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.model, input: [{ role: "user", content }] }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(parseOpenAiError(JSON.parse(raw || "{}"), `Attachment analysis failed with HTTP ${response.status}.`));
    const parsed = JSON.parse(raw) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = parsed.output_text || parsed.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join(" ").trim() || "";
    if (!text) throw new Error("Attachment analysis returned no text.");
    return { text };
  } finally {
    clearTimeout(timeout);
  }
}

export function isLiveConversationSessionModel(_model: VoiceTranscriptionModel | string): boolean {
  return true;
}

export function normalizeVoiceTranscriptionModel(model: VoiceTranscriptionModel | string | undefined): VoiceTranscriptionModel {
  if (model && voiceTranscriptionModelSchema.safeParse(model).success) {
    return model as VoiceTranscriptionModel;
  }
  return "gpt-transcribe";
}

export function sanitizeOfferSdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:"))
    .join("\r\n");
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
    languages?: Array<Exclude<VoiceTranscriptionLanguage, "auto">>;
    delay?: VoiceTranscriptionDelay;
  } = {
    model: normalizeVoiceTranscriptionModel(input.model)
  };
  if (input.language !== "auto") {
    transcription.languages = [input.language];
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
  const normalizedModel = normalizeVoiceTranscriptionModel(input.model);
  const sanitizedSdp = sanitizeOfferSdp(input.offerSdp);

  try {
    const upstreamModel = input.model?.trim() || "gpt-live-1";
    const sessionPayload: Record<string, unknown> = {
      model: upstreamModel,
      audio: {
        output: {
          voice: input.voice ?? config.voiceTranscriptionVoice ?? "alloy"
        }
      }
    };
    const instructionParts: string[] = [];
    if (input.opening?.trim()) {
      instructionParts.push(
        `On the first assistant response, say exactly: "${input.opening.trim()}". This is a one-time opening. Never repeat this greeting, or any greeting, on later turns; answer the user's next message directly.`
      );
    }

    if (normalizedModel.includes("transcribe")) {
      instructionParts.push("You are a real-time speech-to-text transcriber. Transcribe the user's speech accurately and verbatim. Do not engage in conversation or generate audio responses.");
    } else {
      const languageInstruction =
        input.language === "el"
          ? "You are a helpful, fluent AI assistant speaking Greek (Ελληνικά). You understand spoken Greek perfectly and always reply directly and naturally in fluent Greek."
          : input.language === "en"
            ? "You are a helpful AI assistant speaking English. Always converse in English."
            : "You are a helpful bilingual AI assistant fluent in Greek (Ελληνικά) and English. You understand spoken Greek and English. When the user speaks Greek, always converse and reply in natural, fluent Greek. When the user speaks English, reply in English.";
      instructionParts.push(languageInstruction);
    }

    if (input.prompt?.trim()) {
      instructionParts.push(input.prompt.trim());
    }
    if (instructionParts.length > 0) {
      sessionPayload.instructions = instructionParts.join("\n\n");
    }

    if (input.delegatedType === "client") {
      sessionPayload.delegation = { type: "client" };
    } else if (input.delegatedModel) {
      const responsesConfig: Record<string, unknown> = {
        model: input.delegatedModel
      };
      if (input.delegatedPrompt?.trim()) {
        responsesConfig.instructions = input.delegatedPrompt.trim();
      } else if (sessionPayload.instructions) {
        responsesConfig.instructions = sessionPayload.instructions;
      }
      if (input.delegatedReasoningEffort) {
        responsesConfig.reasoning = {
          effort: input.delegatedReasoningEffort
        };
      }
      const delegatedTools: Array<Record<string, unknown>> = [];
      if (input.delegatedWebSearch) {
        delegatedTools.push({ type: "web_search" });
      }
      if (input.tools && input.tools.length > 0) {
        delegatedTools.push(...input.tools);
      }
      if (delegatedTools.length > 0) {
        responsesConfig.tools = delegatedTools;
        responsesConfig.tool_choice = "auto";
      }
      sessionPayload.delegation = {
        type: "responses",
        responses: responsesConfig
      };
    }

    const livePayload = {
      transport: {
        type: "webrtc",
        sdp: sanitizedSdp
      },
      session: sessionPayload
    };

    const response = await fetch(`${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/live/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.safetyIdentifier ? { "OpenAI-Safety-Identifier": input.safetyIdentifier } : {})
      },
      body: JSON.stringify(livePayload),
      signal: controller.signal
    });

    const rawBody = await response.text();
    if (!response.ok) {
      let message = rawBody || `OpenAI Live session failed with HTTP ${response.status}.`;
      try {
        message = parseOpenAiError(JSON.parse(rawBody) as unknown, message);
      } catch {
        // Keep raw body fallback.
      }
      if (response.status === 429 || message.includes("credit_balance_exhausted") || message.includes("insufficient_quota")) {
        message = "OpenAI API quota or credit balance exhausted. Please verify API key credits in the active organization.";
      } else if (response.status === 500) {
        message = "OpenAI Live session failed with HTTP 500 (Internal Server Error). gpt-live-1 requires an active credit balance for the upfront WebRTC initialization charge (15s). Please verify your API key organization credits, or switch to gpt-transcribe in Settings.";
      }
      throw new Error(message);
    }

    let answerSdp = "";
    try {
      const parsed = JSON.parse(rawBody) as { transport?: { sdp?: string } };
      answerSdp = parsed.transport?.sdp || "";
    } catch {
      answerSdp = rawBody;
    }
    if (!answerSdp.trim()) {
      throw new Error("OpenAI Live session returned empty SDP.");
    }
    return voiceRealtimeSessionResponseSchema.parse({ answerSdp });
  } finally {
    clearTimeout(timeout);
  }
}

export const DEFAULT_OPENAI_MODELS: string[] = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-nano",
  "o3",
  "o4-mini",
  "chat-latest",
  "gpt-3.5-turbo",
  "gpt-5.5-pro",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-chat-latest",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.1",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "o3-mini",
  "o3-pro",
  "o1",
  "o1-mini",
  "o1-pro",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-live-1",
  "gpt-live-1-mini",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2",
  "gpt-realtime-1.5",
  "gpt-realtime",
  "gpt-transcribe"
];

let cachedOpenAiModels: { timestamp: number; models: string[] } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchOpenAiModels(config: SpaceApiConfig): Promise<string[]> {
  const now = Date.now();
  if (cachedOpenAiModels && now - cachedOpenAiModels.timestamp < CACHE_TTL_MS) {
    return cachedOpenAiModels.models;
  }

  const modelSet = new Set<string>(DEFAULT_OPENAI_MODELS);

  if (config.voiceTranscriptionKeyFile) {
    try {
      const apiKey = (await readFile(config.voiceTranscriptionKeyFile, "utf8")).trim();
      if (apiKey) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(`${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/models`, {
            headers: {
              Authorization: `Bearer ${apiKey}`
            },
            signal: controller.signal
          });
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id?: string }> };
            if (Array.isArray(data.data)) {
              for (const item of data.data) {
                if (item && typeof item.id === "string" && item.id.trim()) {
                  modelSet.add(item.id.trim());
                }
              }
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch {
      // Fall back to default model set on error
    }
  }

  const priorityList = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.4-nano",
    "o3",
    "o4-mini",
    "chat-latest",
    "gpt-3.5-turbo"
  ];
  const prioritySet = new Set(priorityList);
  const remaining = Array.from(modelSet).filter((m) => !prioritySet.has(m)).sort();
  const models = [...priorityList.filter((m) => modelSet.has(m)), ...remaining];

  cachedOpenAiModels = { timestamp: now, models };
  return models;
}
