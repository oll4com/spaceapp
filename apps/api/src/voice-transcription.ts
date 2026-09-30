import { readFile } from "node:fs/promises";
import { createGateway } from "@ai-sdk/gateway";
import type {
  VoiceModelVoice,
  VoiceRealtimeSessionResponse,
  VoiceTranscriptionDelay,
  VoiceTranscriptionLanguage,
  VoiceTranscriptionModel,
  LiveAudioProviderId
} from "@space/contracts";
import {
  voiceRealtimeSessionResponseSchema,
  voiceTranscriptionModelSchema,
  getAllLiveAudioProviders,
  getLiveAudioProvider,
  inferProviderFromModel,
  LIVE_AUDIO_PROVIDERS
} from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";
import { configuredDelegateModel, estimateLiveCost } from "./live-model-policy.js";

export const voiceTranscriptionModelOptions: VoiceTranscriptionModel[] = [
  "gemini-3.8-live",
  "gemini-3.8-live-extended-thinking",
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash-exp",
  "gpt-live-1",
  "gpt-transcribe",
  "gpt-live-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
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
  provider?: LiveAudioProviderId;
  transport?: "webrtc" | "websocket";
  offerSdp?: string;
  model: VoiceTranscriptionModel | string;
  language: VoiceTranscriptionLanguage;
  delay?: VoiceTranscriptionDelay;
  voice?: VoiceModelVoice | string;
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
  provider?: LiveAudioProviderId | string;
}

/** Run an authenticated, non-persistent vision/file turn for the Live bridge. */
export async function createVoiceAttachmentResponse(
  config: SpaceApiConfig,
  input: VoiceAttachmentResponseInput
): Promise<{ text: string }> {
  if (!input.buffer.byteLength || input.buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error("Attachment must be between 1 byte and 10MB.");
  }
  const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;
  const isImage = input.mimeType.startsWith("image/");
  const promptText = input.prompt?.trim() || "Describe this attachment and answer the user's implied question concisely.";

  const chatContent: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [
    { type: "text", text: promptText }
  ];
  if (isImage) {
    chatContent.push({ type: "image_url", image_url: { url: dataUrl, detail: "auto" } });
  } else {
    chatContent.push({ type: "text", text: `\n\n[File: ${input.filename}]\n${input.buffer.toString("utf8").slice(0, 10000)}` });
  }

  const vercelCred = await resolveLiveAudioCredentials(config, "vercel");
  const googleCred = await resolveLiveAudioCredentials(config, "google");
  const openaiCred = await resolveLiveAudioCredentials(config, "openai");

  interface ProviderCandidate {
    id: "vercel" | "google" | "openai";
    url: string;
    key: string;
    model: string;
  }

  const candidates: ProviderCandidate[] = [];

  const vercelCandidate: ProviderCandidate | null = vercelCred.apiKey
    ? {
        id: "vercel",
        url: (() => {
          const rawBaseUrl = (config.vercelVoiceBaseUrl || "https://ai-gateway.vercel.sh").replace(/\/+$/, "");
          return rawBaseUrl.endsWith("/v1") ? `${rawBaseUrl}/chat/completions` : `${rawBaseUrl}/v1/chat/completions`;
        })(),
        key: vercelCred.apiKey,
        model: input.model?.includes("/") ? input.model : `openai/${input.model || "gpt-4o-mini"}`
      }
    : null;

  const googleCandidate: ProviderCandidate | null = googleCred.apiKey
    ? {
        id: "google",
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        key: googleCred.apiKey,
        model: input.model && input.model.startsWith("gemini-") && !input.model.includes("2.5") && !input.model.includes("2.0")
          ? input.model
          : "gemini-3.6-flash"
      }
    : null;

  const openaiCandidate: ProviderCandidate | null = openaiCred.apiKey
    ? {
        id: "openai",
        url: `${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/chat/completions`,
        key: openaiCred.apiKey,
        model: input.model && !input.model.includes("/") && !input.model.startsWith("gemini") ? input.model : "gpt-4o-mini"
      }
    : null;

  const requestedProvider = String(input.provider || "").toLowerCase();
  if (requestedProvider === "vercel" || requestedProvider === "openai/gpt-live-1") {
    if (vercelCandidate) candidates.push(vercelCandidate);
    if (googleCandidate) candidates.push(googleCandidate);
    if (openaiCandidate) candidates.push(openaiCandidate);
  } else if (requestedProvider === "google") {
    if (googleCandidate) candidates.push(googleCandidate);
    if (vercelCandidate) candidates.push(vercelCandidate);
    if (openaiCandidate) candidates.push(openaiCandidate);
  } else if (requestedProvider === "openai") {
    if (openaiCandidate) candidates.push(openaiCandidate);
    if (vercelCandidate) candidates.push(vercelCandidate);
    if (googleCandidate) candidates.push(googleCandidate);
  } else {
    if (vercelCandidate) candidates.push(vercelCandidate);
    if (googleCandidate) candidates.push(googleCandidate);
    if (openaiCandidate) candidates.push(openaiCandidate);
  }

  if (candidates.length === 0) {
    throw new Error("No configured vision AI provider found (checked Vercel, Google, OpenAI).");
  }

  let lastError: Error | null = null;
  for (const c of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.voiceTranscriptionTimeoutMs || 15000);
    try {
      const resp = await fetch(c.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: "user", content: chatContent }]
        }),
        signal: controller.signal
      });

      if (resp.ok) {
        const parsed = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = parsed.choices?.[0]?.message?.content?.trim();
        if (text) {
          clearTimeout(timeout);
          return { text };
        }
      }
      const rawText = await resp.text().catch(() => "");
      lastError = new Error(`Provider ${c.id} HTTP ${resp.status}: ${rawText.slice(0, 300)}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Attachment analysis failed on all available vision providers.");
}

export async function createVoiceDelegateResponse(
  config: SpaceApiConfig,
  input: {
    query: string;
    roomId?: string;
    tools?: Array<Record<string, unknown>>;
  },
  signal?: AbortSignal
): Promise<{ toolCall: { name: string; args: Record<string, unknown> } | null; message: string | null; telemetry?: { provider: "google" | "vercel" | "openai" | null; model: string | null; latencyMs: number; attempt: number; estimatedCostUsd: number | null; routing?: "delegate" | "jev-read" } }> {
  const googleCred = await resolveLiveAudioCredentials(config, "google");
  const vercelCred = await resolveLiveAudioCredentials(config, "vercel");
  const openaiCred = await resolveLiveAudioCredentials(config, "openai");

  const formattedTools = (input.tools || [])
    .filter((t: any) => t && (t.name || t.function?.name))
    .map((t: any) => ({
      type: "function",
      function: {
        name: t.name || t.function?.name,
        description: t.description || t.function?.description,
        parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} }
      }
    }));

  const systemPrompt =
    "You are the SpaceApp voice assistant action router. The user is speaking in Greek.\n" +
    "Select and invoke the appropriate tool if the user's intent requires performing an action, inspecting room state, controlling playback, testing tools, capturing the screen/vision, opening or closing panes, or querying data.\n" +
    "DIRECTIVES:\n" +
    "- If the user asks to perform an action or asks whether you can perform an action, ALWAYS call the corresponding tool immediately in the same turn.\n" +
    "- If and only if the user is having a casual conversation, greeting, or asking a general question that requires no tool, reply naturally and concisely in Greek without a tool call.\n" +
    "- Strictly adhere to the declared tools and their parameter schemas.";

  const candidates: Array<{ url: string; key: string; model: string; provider: "google" | "vercel" | "openai" }> = [];
  if (googleCred.apiKey) {
    candidates.push({
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: googleCred.apiKey,
      model: configuredDelegateModel(config.liveModelPolicy, "google", "gemini-3.6-flash", config.liveModelPolicy.mode),
      provider: "google"
    });
  }
  if (vercelCred.apiKey) {
    const rawBaseUrl = (config.vercelVoiceBaseUrl || "https://ai-gateway.vercel.sh").replace(/\/+$/, "");
    const completionsUrl = rawBaseUrl.endsWith("/v1")
      ? `${rawBaseUrl}/chat/completions`
      : `${rawBaseUrl}/v1/chat/completions`;
    candidates.push({
      url: completionsUrl,
      key: vercelCred.apiKey,
      model: configuredDelegateModel(config.liveModelPolicy, "vercel", "openai/gpt-4o-mini", config.liveModelPolicy.mode),
      provider: "vercel"
    });
  }
  if (openaiCred.apiKey) {
    const baseUrl = normalizedBaseUrl(config.voiceTranscriptionBaseUrl);
    candidates.push({
      url: `${baseUrl}/chat/completions`,
      key: openaiCred.apiKey,
      model: configuredDelegateModel(config.liveModelPolicy, "openai", "gpt-4o-mini", config.liveModelPolicy.mode),
      provider: "openai"
    });
  }

  const startedAt = Date.now();
  for (const [index, c] of candidates.entries()) {
    if (signal?.aborted) break;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(c.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: c.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: input.query }
          ],
          ...(formattedTools.length > 0 ? { tools: formattedTools, tool_choice: "auto" } : {})
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const usage = data.usage ?? {};
        const policyEntry = config.liveModelPolicy.models.find(entry =>
          entry.id === c.model && entry.provider === c.provider && entry.protocol === "responses");
        const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
        const outputTokens = usage.completion_tokens ?? usage.output_tokens;
        const validTokens = (value: unknown): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        const estimatedCostUsd = policyEntry && validTokens(inputTokens) && validTokens(outputTokens) ? estimateLiveCost({
          model: policyEntry,
          inputTokens,
          outputTokens
        }) : null;
        const telemetry = { provider: c.provider,
          model: c.model, latencyMs: Date.now() - startedAt, attempt: index + 1, estimatedCostUsd };
        const choice = data.choices?.[0]?.message;
        if (choice?.tool_calls && choice.tool_calls.length > 0) {
          const tc = choice.tool_calls[0];
          let args: Record<string, unknown> = {};
          try {
            args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
          } catch {}
          return {
            toolCall: {
              name: tc.function?.name || "",
              args
            },
            message: null,
            telemetry
          };
        }
        if (choice?.content?.trim()) {
          return {
            toolCall: null,
            message: choice.content.trim(),
            telemetry
          };
        }
      }
    } catch {
      // Try next candidate
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }

  return { toolCall: null, message: null, telemetry: { provider: null, model: null, latencyMs: Date.now() - startedAt, attempt: candidates.length, estimatedCostUsd: null } };
}

export function isLiveConversationSessionModel(_model: VoiceTranscriptionModel | string): boolean {
  return true;
}

export function normalizeVoiceTranscriptionModel(model: VoiceTranscriptionModel | string | undefined): VoiceTranscriptionModel {
  if (model && voiceTranscriptionModelSchema.safeParse(model).success) {
    return model as VoiceTranscriptionModel;
  }
  return "gpt-live-1";
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

export async function resolveLiveAudioCredentials(
  config: SpaceApiConfig,
  provider: LiveAudioProviderId
): Promise<{ configured: boolean; apiKey?: string; missingReason?: string }> {
  if (provider === "openai") {
    if (!config.voiceTranscriptionEnabled) {
      return { configured: false, missingReason: "Voice transcription is disabled on Space." };
    }
    if (!config.voiceTranscriptionKeyFile) {
      return {
        configured: false,
        missingReason: "OpenAI Voice key file is not configured on Space (SPACE_VOICE_TRANSCRIPTION_KEY_FILE)."
      };
    }
    try {
      const key = (await readFile(config.voiceTranscriptionKeyFile, "utf8")).trim();
      if (!key) {
        return { configured: false, missingReason: "OpenAI Voice key file is empty." };
      }
      return { configured: true, apiKey: key };
    } catch (err) {
      return {
        configured: false,
        missingReason: `Failed to read OpenAI Voice key file: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  if (provider === "google") {
    if (config.googleVoiceKeyFile) {
      try {
        const key = (await readFile(config.googleVoiceKeyFile, "utf8")).trim();
        if (key) return { configured: true, apiKey: key };
      } catch {}
    }
    if (config.googleVoiceApiKey?.trim()) {
      return { configured: true, apiKey: config.googleVoiceApiKey.trim() };
    }
    return {
      configured: false,
      missingReason: "Google Gemini Live credentials not configured on Space. Please set SPACE_GOOGLE_VOICE_KEY_FILE or GEMINI_API_KEY."
    };
  }

  if (provider === "amazon") {
    if (config.awsVoiceKeyFile) {
      try {
        const key = (await readFile(config.awsVoiceKeyFile, "utf8")).trim();
        if (key) return { configured: true, apiKey: key };
      } catch {}
    }
    if (config.awsAccessKeyId?.trim() && config.awsSecretAccessKey?.trim()) {
      return { configured: true, apiKey: config.awsAccessKeyId.trim() };
    }
    return {
      configured: false,
      missingReason: "Amazon Nova 2 Sonic credentials not configured on Space. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or SPACE_AWS_VOICE_KEY_FILE."
    };
  }

  if (provider === "local") {
    if (config.localVoiceProviderToken) {
      return { configured: true, apiKey: config.localVoiceProviderToken };
    }
    return {
      configured: false,
      missingReason: "Local voice provider token is not configured on Space (SPACE_LOCAL_VOICE_PROVIDER_TOKEN)."
    };
  }

  if (provider === "vercel") {
    if (config.vercelVoiceKeyFile) {
      try {
        const key = (await readFile(config.vercelVoiceKeyFile, "utf8")).trim();
        if (key) return { configured: true, apiKey: key };
      } catch {}
    }
    try {
      const defaultKey = (await readFile("/opt/spaceapp/secrets/space-vercel-voice.key", "utf8")).trim();
      if (defaultKey) return { configured: true, apiKey: defaultKey };
    } catch {}
    if (config.vercelVoiceApiKey?.trim()) {
      return { configured: true, apiKey: config.vercelVoiceApiKey.trim() };
    }
    return {
      configured: false,
      missingReason: "Vercel AI Gateway credentials not configured on Space. Please set SPACE_VERCEL_VOICE_KEY_FILE or AI_GATEWAY_API_KEY."
    };
  }

  return { configured: false, missingReason: `Unknown provider: ${provider}` };
}

export async function getLiveAudioProvidersStatus(config: SpaceApiConfig) {
  const providers = getAllLiveAudioProviders();
  const results = await Promise.all(
    providers.map(async (p) => {
      const cred = await resolveLiveAudioCredentials(config, p.id);
      return {
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        transport: p.transport,
        defaultModel: p.defaultModel,
        models: p.models,
        defaultVoice: p.defaultVoice,
        voices: p.voices,
        configured: cred.configured,
        missingReason: cred.missingReason
      };
    })
  );
  return { providers: results };
}

export async function createVoiceRealtimeCall(
  config: SpaceApiConfig,
  input: VoiceRealtimeCallInput
): Promise<VoiceRealtimeSessionResponse> {
  const provider: LiveAudioProviderId = input.provider || inferProviderFromModel(input.model);

  // 1. Google Gemini Live provider flow
  if (provider === "google") {
    const cred = await resolveLiveAudioCredentials(config, "google");
    if (!cred.configured || !cred.apiKey) {
      throw new Error(cred.missingReason || "Google Gemini Live credentials not configured on Space.");
    }
    const targetModel = input.model?.trim() || "gemini-3.8-live";
    const wsBase = config.googleVoiceBaseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const websocketUrl = `${wsBase}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${cred.apiKey}`;
    return voiceRealtimeSessionResponseSchema.parse({
      provider: "google",
      protocol: "google-live",
      model: targetModel,
      websocketUrl,
      sessionId: `gemini_live_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    });
  }

  // 2. Amazon Nova 2 Sonic provider flow
  if (provider === "amazon") {
    const cred = await resolveLiveAudioCredentials(config, "amazon");
    if (!cred.configured || !cred.apiKey) {
      throw new Error(cred.missingReason || "Amazon Nova 2 Sonic credentials not configured on Space.");
    }
    const targetModel = input.model?.trim() || "amazon.nova-2-sonic-v1:0";
    const region = config.awsRegion || "us-east-1";
    const websocketUrl = `wss://bedrock-runtime.${region}.amazonaws.com/model/${targetModel}/invoke-with-bidirectional-stream`;
    return voiceRealtimeSessionResponseSchema.parse({
      provider: "amazon",
      model: targetModel,
      websocketUrl,
      sessionId: `nova_live_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    });
  }

  // 3. Local provider flow
  if (provider === "local" || input.model === "local-qwen3-greek") {
    const localSession = await createLocalVoiceSession(config, {
      language: input.language,
      opening: input.opening,
      prompt: input.prompt
    });
    const wsUrl = typeof localSession.websocket_url === "string"
      ? localSession.websocket_url
      : typeof localSession.ws_url === "string"
        ? localSession.ws_url
        : typeof localSession.url === "string"
          ? localSession.url
          : "";
    return voiceRealtimeSessionResponseSchema.parse({
      provider: "local",
      model: "local-qwen3-greek",
      websocketUrl: wsUrl,
      sessionId: typeof localSession.id === "string" ? localSession.id : undefined
    });
  }

  // 4. Vercel AI Gateway Live flow (WebSocket with client secret token)
  if (provider === "vercel") {
    const cred = await resolveLiveAudioCredentials(config, "vercel");
    if (!cred.configured || !cred.apiKey) {
      throw new Error(cred.missingReason || "Vercel AI Gateway credentials not configured on Space.");
    }
    let targetModel = input.model?.trim() || "openai/gpt-live-1";
    if (!targetModel.includes("/")) {
      targetModel = `openai/${targetModel}`;
    }
    const baseUrl = (config.vercelVoiceBaseUrl || "https://ai-gateway.vercel.sh").replace(/\/+$/, "");
    // GPT-Live is a continuous session protocol, not the Gateway's normalized
    // turn-based Realtime protocol. Never select the route solely by provider.
    if (!targetModel.startsWith("openai/gpt-live-")) {
      const gateway = createGateway({
        apiKey: cred.apiKey,
        baseURL: `${baseUrl}/v4/ai`,
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(config.voiceTranscriptionTimeoutMs) })
      });
      const secret = await gateway.experimental_realtime.getToken({ model: targetModel });
      return voiceRealtimeSessionResponseSchema.parse({
        provider: "vercel",
        protocol: "gateway-realtime",
        model: targetModel,
        websocketUrl: secret.url,
        token: secret.token,
        expiresAt: secret.expiresAt
      });
    }
    const clientSecretRes = await fetch(`${baseUrl}/v1/realtime/client-secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: targetModel, routeKind: "live" }),
      signal: AbortSignal.timeout(config.voiceTranscriptionTimeoutMs)
    });
    if (!clientSecretRes.ok) {
      throw new Error(`Failed to create Vercel Live client secret: HTTP ${clientSecretRes.status}`);
    }
    const clientSecretData = (await clientSecretRes.json()) as { token?: string; expiresAt?: number };
    if (!clientSecretData.token) {
      throw new Error("Vercel AI Gateway returned empty client token for Live session.");
    }
    const wsBase = baseUrl.replace(/^http/, "ws");
    return voiceRealtimeSessionResponseSchema.parse({
      provider: "vercel",
      protocol: "gpt-live",
      model: targetModel,
      websocketUrl: `${wsBase}/v1/live/sessions`,
      token: clientSecretData.token,
      expiresAt: clientSecretData.expiresAt,
      sessionId: `vercel_live_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    });
  }

  // 5. OpenAI Live flow (WebRTC)
  const cred = await resolveLiveAudioCredentials(config, "openai");
  if (!cred.configured || !cred.apiKey) {
    throw new Error(cred.missingReason || "Voice transcription is disabled or key file missing.");
  }
  if (!input.offerSdp) {
    throw new Error("OpenAI Live session requires an SDP offer for WebRTC negotiation.");
  }
  const apiKey = cred.apiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.voiceTranscriptionTimeoutMs);
  const normalizedModel = normalizeVoiceTranscriptionModel(input.model);
  const sanitizedSdp = sanitizeOfferSdp(input.offerSdp!);

  try {
    const upstreamModel = input.model?.trim() || config.voiceTranscriptionModel || "gpt-live-1";
    const isLive = upstreamModel.startsWith("gpt-live-") && upstreamModel !== "gpt-live-transcribe";
    const isRealtime = /^gpt-(?:realtime(?:-|$)|4o(?:-mini)?-realtime)/.test(upstreamModel) && upstreamModel !== "gpt-realtime-whisper";
    const isTranscription = ["gpt-transcribe", "gpt-live-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"].includes(upstreamModel);
    if (!isLive && !isRealtime && !isTranscription) {
      throw new Error(`Model ${upstreamModel} is not a conversational Live/Realtime model. Select a voice conversation model; no automatic paid substitution was made.`);
    }
    const chosenVoice = input.voice ?? config.voiceTranscriptionVoice ?? "alloy";
    const turnDetectionConfig = isTranscription ? null : {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 300,
      create_response: true
    };

    let sessionPayload: Record<string, unknown> = {
      model: upstreamModel,
      audio: {
        output: {
          voice: chosenVoice
        },
        input: {
          transcription: {
            model: "whisper-1"
          },
          ...(turnDetectionConfig ? { turn_detection: turnDetectionConfig } : {})
        }
      }
    };

    if (!isLive) {
      sessionPayload.voice = chosenVoice;
      sessionPayload.input_audio_transcription = {
        model: "whisper-1"
      };
      if (turnDetectionConfig) {
        sessionPayload.turn_detection = turnDetectionConfig;
      }
    }
    const instructionParts: string[] = [];
    if (input.opening?.trim()) {
      instructionParts.push(
        `On the first assistant response, say exactly: "${input.opening.trim()}". This is a one-time opening. Never repeat this greeting, or any greeting, on later turns; answer the user's next message directly.`
      );
    }

    if (normalizedModel.includes("transcribe") || (upstreamModel === "gpt-live-1" && !input.opening?.trim() && !input.prompt?.trim() && !input.delegatedModel)) {
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

    if (isTranscription) {
      const streaming = upstreamModel === "gpt-live-transcribe" || upstreamModel === "gpt-transcribe";
      sessionPayload = {
        type: "transcription",
        audio: { input: {
          transcription: {
            model: upstreamModel,
            ...(input.language && input.language !== "auto" ? (streaming ? { languages: [input.language] } : { language: input.language }) : {}),
            ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
            ...(streaming && input.delay ? { delay: input.delay } : {})
          },
          turn_detection: null
        } }
      };
    } else if (!isLive) {
      sessionPayload.type = "realtime";
      sessionPayload.output_modalities = ["audio"];
      sessionPayload.tools = input.tools || [];
      sessionPayload.tool_choice = "auto";
    } else if (input.delegatedType === "client") {
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
      responsesConfig.reasoning = {
        effort: input.delegatedReasoningEffort || "minimal"
      };
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

    const realtimeForm = new FormData();
    if (!isLive) {
      realtimeForm.set("sdp", sanitizedSdp);
      realtimeForm.set("session", JSON.stringify(sessionPayload));
    }
    const response = await fetch(`${normalizedBaseUrl(config.voiceTranscriptionBaseUrl)}/${isLive ? "live/sessions" : "realtime/calls"}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(isLive ? { "Content-Type": "application/json" } : {}),
        ...(input.safetyIdentifier ? { "OpenAI-Safety-Identifier": input.safetyIdentifier } : {})
      },
      body: isLive ? JSON.stringify(livePayload) : realtimeForm,
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
      } else if (response.status === 500 && isLive) {
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
    return voiceRealtimeSessionResponseSchema.parse({ answerSdp, provider: "openai", model: upstreamModel, protocol: isLive ? "gpt-live" : isTranscription ? "openai-transcription" : "openai-realtime" });
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
