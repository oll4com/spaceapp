import { z } from "zod";
import { liveAudioProviderIdSchema, type LiveAudioProviderId } from "./schemas.js";

export const liveAudioTransportTypeSchema = z.enum(["webrtc", "websocket"]);
export type LiveAudioTransportType = z.infer<typeof liveAudioTransportTypeSchema>;

export interface LiveAudioModel {
  id: string;
  label: string;
  description: string;
  providerId: LiveAudioProviderId;
  defaultVoice: string;
  nativeAudio: boolean;
  capabilities: {
    bidirectionalAudio: boolean;
    speechToSpeech: boolean;
    interruption: boolean;
    tools: boolean;
    vision: boolean;
  };
}

export interface LiveAudioVoice {
  id: string;
  label: string;
  providerId: LiveAudioProviderId;
  gender?: "female" | "male" | "neutral";
  description?: string;
}

export interface LiveAudioProviderDescriptor {
  id: LiveAudioProviderId;
  displayName: string;
  description: string;
  transport: LiveAudioTransportType;
  defaultModel: string;
  defaultVoice: string;
  models: LiveAudioModel[];
  voices: LiveAudioVoice[];
  supportsWebRtc: boolean;
  supportsWebSocket: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsInterruption: boolean;
  credentialEnvVars: string[];
  credentialKeyFiles: string[];
}

export const LIVE_AUDIO_PROVIDERS: Record<LiveAudioProviderId, LiveAudioProviderDescriptor> = {
  openai: {
    id: "openai",
    displayName: "OpenAI",
    description: "OpenAI Realtime voice conversation via WebRTC",
    transport: "webrtc",
    defaultModel: "gpt-live-1",
    defaultVoice: "gleam",
    supportsWebRtc: true,
    supportsWebSocket: true,
    supportsVision: true,
    supportsTools: true,
    supportsInterruption: true,
    credentialEnvVars: ["SPACE_VOICE_TRANSCRIPTION_KEY_FILE", "OPENAI_API_KEY"],
    credentialKeyFiles: ["/opt/spaceapp/secrets/space-openai-voice.key"],
    models: [
      {
        id: "gpt-live-1",
        label: "gpt-live-1",
        description: "Standard OpenAI Live WebRTC duplex audio model",
        providerId: "openai",
        defaultVoice: "gleam",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gpt-4o-realtime-preview",
        label: "GPT-4o Realtime Preview",
        description: "OpenAI multimodal realtime preview",
        providerId: "openai",
        defaultVoice: "alloy",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gpt-realtime-2.1",
        label: "GPT-Realtime 2.1",
        description: "Next-generation OpenAI Realtime speech model",
        providerId: "openai",
        defaultVoice: "alloy",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gpt-transcribe",
        label: "gpt-transcribe",
        description: "Real-time speech-to-text transcription only",
        providerId: "openai",
        defaultVoice: "alloy",
        nativeAudio: false,
        capabilities: {
          bidirectionalAudio: false,
          speechToSpeech: false,
          interruption: false,
          tools: false,
          vision: false
        }
      }
    ],
    voices: [
      { id: "gleam", label: "Gleam", providerId: "openai", gender: "female", description: "Clear, warm and conversational" },
      { id: "alloy", label: "Alloy", providerId: "openai", gender: "neutral", description: "Neutral and balanced" },
      { id: "ash", label: "Ash", providerId: "openai", gender: "male", description: "Calm and understated" },
      { id: "ballad", label: "Ballad", providerId: "openai", gender: "male", description: "Lyrical and expressive" },
      { id: "coral", label: "Coral", providerId: "openai", gender: "female", description: "Friendly and bright" },
      { id: "echo", label: "Echo", providerId: "openai", gender: "male", description: "Warm and engaging" },
      { id: "sage", label: "Sage", providerId: "openai", gender: "female", description: "Smooth and natural" },
      { id: "shimmer", label: "Shimmer", providerId: "openai", gender: "female", description: "Bright and clear" },
      { id: "bossa", label: "Bossa", providerId: "openai", gender: "neutral", description: "Dynamic and melodious" },
      { id: "tempo", label: "Tempo", providerId: "openai", gender: "male", description: "Fast and confident" },
      { id: "marin", label: "Marin", providerId: "openai", gender: "female", description: "Gentle and measured" },
      { id: "cedar", label: "Cedar", providerId: "openai", gender: "male", description: "Deep and steady" }
    ]
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    description: "Google Gemini 3.8 / 3.1 & 2.5 Live bidirectional voice streaming",
    transport: "websocket",
    defaultModel: "gemini-3.8-live",
    defaultVoice: "Aoede",
    supportsWebRtc: false,
    supportsWebSocket: true,
    supportsVision: true,
    supportsTools: true,
    supportsInterruption: true,
    credentialEnvVars: [
      "SPACE_GOOGLE_VOICE_KEY_FILE",
      "SPACE_GEMINI_VOICE_KEY_FILE",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY"
    ],
    credentialKeyFiles: [
      "/opt/spaceapp/secrets/space-google-voice.key",
      "/opt/spaceapp/secrets/space-gemini-voice.key"
    ],
    models: [
      {
        id: "gemini-3.8-live",
        label: "Gemini 3.8 Live",
        description: "Ultra-low latency real-time voice streaming foundation model",
        providerId: "google",
        defaultVoice: "Aoede",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gemini-3.8-live-extended-thinking",
        label: "Gemini 3.8 Live Extended Thinking",
        description: "High-reasoning live audio-to-audio model with background reasoning",
        providerId: "google",
        defaultVoice: "Charon",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gemini-3.1-flash-live-preview",
        label: "Gemini 3.1 Flash Live Preview",
        description: "Gemini 3.1 Flash live multimodal streaming preview",
        providerId: "google",
        defaultVoice: "Kore",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gemini-2.5-flash-native-audio-latest",
        label: "Gemini 2.5 Flash Native Audio",
        description: "Sub-second low latency native speech-to-speech architecture",
        providerId: "google",
        defaultVoice: "Fenrir",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash Live",
        description: "Gemini 2.5 Flash live multimodal streaming",
        providerId: "google",
        defaultVoice: "Puck",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "gemini-2.0-flash-exp",
        label: "Gemini 2.0 Flash Live",
        description: "Multimodal Live API experimental preview",
        providerId: "google",
        defaultVoice: "Aoede",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      }
    ],
    voices: [
      { id: "Aoede", label: "Aoede", providerId: "google", gender: "female", description: "Melodic and natural" },
      { id: "Charon", label: "Charon", providerId: "google", gender: "male", description: "Deep and measured" },
      { id: "Fenrir", label: "Fenrir", providerId: "google", gender: "male", description: "Authoritative and clear" },
      { id: "Kore", label: "Kore", providerId: "google", gender: "female", description: "Warm and bright" },
      { id: "Puck", label: "Puck", providerId: "google", gender: "male", description: "Playful and animated" }
    ]
  },
  amazon: {
    id: "amazon",
    displayName: "Amazon Nova",
    description: "Amazon Nova 2 Sonic real-time speech-to-speech via Bedrock",
    transport: "websocket",
    defaultModel: "amazon.nova-2-sonic-v1:0",
    defaultVoice: "en-US-Jenny",
    supportsWebRtc: false,
    supportsWebSocket: true,
    supportsVision: false,
    supportsTools: true,
    supportsInterruption: true,
    credentialEnvVars: [
      "SPACE_AWS_VOICE_KEY_FILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY"
    ],
    credentialKeyFiles: [
      "/opt/spaceapp/secrets/space-aws-voice.key"
    ],
    models: [
      {
        id: "amazon.nova-2-sonic-v1:0",
        label: "Amazon Nova 2 Sonic",
        description: "Second-generation real-time speech-to-speech foundation model",
        providerId: "amazon",
        defaultVoice: "en-US-Jenny",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: false
        }
      },
      {
        id: "amazon.nova-sonic-v1:0",
        label: "Amazon Nova Sonic",
        description: "First-generation Nova Sonic speech-to-speech model",
        providerId: "amazon",
        defaultVoice: "en-US-Jenny",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: false
        }
      }
    ],
    voices: [
      { id: "en-US-Jenny", label: "Jenny", providerId: "amazon", gender: "female", description: "Expressive and warm" },
      { id: "Matthew", label: "Matthew", providerId: "amazon", gender: "male", description: "Natural and conversational" },
      { id: "Ruth", label: "Ruth", providerId: "amazon", gender: "female", description: "Warm and reassuring" },
      { id: "Stephen", label: "Stephen", providerId: "amazon", gender: "male", description: "Dynamic and articulate" },
      { id: "Tiffany", label: "Tiffany", providerId: "amazon", gender: "female", description: "Clear and energetic" }
    ]
  },
  local: {
    id: "local",
    displayName: "Local PC (Qwen3 Greek)",
    description: "Self-hosted local speech service",
    transport: "websocket",
    defaultModel: "local-qwen3-greek",
    defaultVoice: "default",
    supportsWebRtc: false,
    supportsWebSocket: true,
    supportsVision: false,
    supportsTools: false,
    supportsInterruption: false,
    credentialEnvVars: ["SPACE_LOCAL_VOICE_PROVIDER_TOKEN"],
    credentialKeyFiles: [],
    models: [
      {
        id: "local-qwen3-greek",
        label: "Local Qwen3 Greek (PC)",
        description: "Self-hosted local streaming voice service",
        providerId: "local",
        defaultVoice: "default",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: false,
          tools: false,
          vision: false
        }
      }
    ],
    voices: [
      { id: "default", label: "Default Greek Voice", providerId: "local", gender: "neutral", description: "Local synthesized Greek voice" }
    ]
  },
  vercel: {
    id: "vercel",
    displayName: "Vercel AI Gateway",
    description: "Vercel AI Gateway GPT-Live voice conversation via WebSocket",
    transport: "websocket",
    defaultModel: "openai/gpt-live-1",
    defaultVoice: "gleam",
    supportsWebRtc: false,
    supportsWebSocket: true,
    supportsVision: true,
    supportsTools: true,
    supportsInterruption: true,
    credentialEnvVars: [
      "SPACE_VERCEL_VOICE_KEY_FILE",
      "SPACE_VERCEL_AI_GATEWAY_KEY_FILE",
      "AI_GATEWAY_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY"
    ],
    credentialKeyFiles: [
      "/opt/spaceapp/secrets/space-vercel-voice.key",
      "/opt/spaceapp/secrets/space-vercel-ai-gateway.key"
    ],
    models: [
      {
        id: "openai/gpt-live-1",
        label: "gpt-live-1 (Vercel)",
        description: "Standard OpenAI Live duplex audio model routed via Vercel AI Gateway",
        providerId: "vercel",
        defaultVoice: "gleam",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "openai/gpt-realtime-2.1",
        label: "GPT-Realtime 2.1 (Vercel)",
        description: "Next-generation OpenAI Realtime speech model routed via Vercel AI Gateway",
        providerId: "vercel",
        defaultVoice: "alloy",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      },
      {
        id: "openai/gpt-realtime-mini",
        label: "GPT-Realtime Mini (Vercel)",
        description: "Fast lightweight OpenAI Realtime model routed via Vercel AI Gateway",
        providerId: "vercel",
        defaultVoice: "alloy",
        nativeAudio: true,
        capabilities: {
          bidirectionalAudio: true,
          speechToSpeech: true,
          interruption: true,
          tools: true,
          vision: true
        }
      }
    ],
    voices: [
      { id: "gleam", label: "Gleam", providerId: "vercel", gender: "female", description: "Clear, warm and conversational" },
      { id: "alloy", label: "Alloy", providerId: "vercel", gender: "neutral", description: "Neutral and balanced" },
      { id: "ash", label: "Ash", providerId: "vercel", gender: "male", description: "Calm and understated" },
      { id: "ballad", label: "Ballad", providerId: "vercel", gender: "male", description: "Lyrical and expressive" },
      { id: "coral", label: "Coral", providerId: "vercel", gender: "female", description: "Friendly and bright" },
      { id: "echo", label: "Echo", providerId: "vercel", gender: "male", description: "Warm and engaging" },
      { id: "sage", label: "Sage", providerId: "vercel", gender: "female", description: "Smooth and natural" },
      { id: "shimmer", label: "Shimmer", providerId: "vercel", gender: "female", description: "Bright and clear" },
      { id: "bossa", label: "Bossa", providerId: "vercel", gender: "neutral", description: "Dynamic and melodious" },
      { id: "tempo", label: "Tempo", providerId: "vercel", gender: "male", description: "Fast and confident" },
      { id: "marin", label: "Marin", providerId: "vercel", gender: "female", description: "Gentle and measured" },
      { id: "cedar", label: "Cedar", providerId: "vercel", gender: "male", description: "Deep and steady" }
    ]
  }
};

export function isLiveAudioProviderId(value: unknown): value is LiveAudioProviderId {
  return typeof value === "string" && value in LIVE_AUDIO_PROVIDERS;
}

export function getLiveAudioProvider(providerId?: string | null): LiveAudioProviderDescriptor {
  if (providerId && isLiveAudioProviderId(providerId)) {
    return LIVE_AUDIO_PROVIDERS[providerId];
  }
  return LIVE_AUDIO_PROVIDERS.openai;
}

export function getAllLiveAudioProviders(): LiveAudioProviderDescriptor[] {
  return Object.values(LIVE_AUDIO_PROVIDERS);
}

export function getModelsForProvider(providerId?: string | null): LiveAudioModel[] {
  return getLiveAudioProvider(providerId).models;
}

export function getVoicesForProvider(providerId?: string | null): LiveAudioVoice[] {
  return getLiveAudioProvider(providerId).voices;
}

export function getDefaultModelForProvider(providerId?: string | null): string {
  return getLiveAudioProvider(providerId).defaultModel;
}

export function getDefaultVoiceForProvider(providerId?: string | null): string {
  return getLiveAudioProvider(providerId).defaultVoice;
}

export function inferProviderFromModel(modelId?: string | null): LiveAudioProviderId {
  if (!modelId) return "openai";
  const trimmed = modelId.trim();
  if (trimmed.startsWith("gemini-")) return "google";
  if (trimmed.startsWith("amazon.nova") || trimmed.startsWith("nova-")) return "amazon";
  if (trimmed === "local-qwen3-greek" || trimmed.startsWith("local-")) return "local";
  if (trimmed.startsWith("openai/") || trimmed.includes("(Vercel)") || trimmed.startsWith("vercel/")) return "vercel";
  return "openai";
}

export function validateLiveAudioConfig(config: {
  provider?: string | null;
  model?: string | null;
  voice?: string | null;
  transport?: string | null;
}): {
  valid: boolean;
  error?: string;
  normalizedConfig: {
    provider: LiveAudioProviderId;
    model: string;
    voice: string;
    transport: LiveAudioTransportType;
  };
} {
  const providerId: LiveAudioProviderId =
    config.provider && isLiveAudioProviderId(config.provider)
      ? config.provider
      : inferProviderFromModel(config.model);

  const provider = LIVE_AUDIO_PROVIDERS[providerId];
  const model = config.model?.trim() || provider.defaultModel;
  const voice = config.voice?.trim() || provider.defaultVoice;
  const transport: LiveAudioTransportType =
    config.transport === "webrtc" || config.transport === "websocket"
      ? config.transport
      : provider.transport;

  // Validate model matches provider
  const modelExists = provider.models.some((m) => m.id === model);
  const isModelCompatible =
    modelExists ||
    (provider.id === "openai" && model.startsWith("gpt-")) ||
    (provider.id === "vercel" && (model.startsWith("openai/") || model.startsWith("gpt-") || model.startsWith("vercel/"))) ||
    (provider.id === "google" && model.startsWith("gemini-")) ||
    (provider.id === "amazon" && (model.startsWith("amazon.") || model.startsWith("nova-"))) ||
    (provider.id === "local" && model.startsWith("local-"));
  if (!isModelCompatible) {
    return {
      valid: false,
      error: `Model "${model}" is not supported by provider "${provider.displayName}".`,
      normalizedConfig: {
        provider: providerId,
        model: provider.defaultModel,
        voice: provider.defaultVoice,
        transport: provider.transport
      }
    };
  }

  // Validate transport matches provider capability
  if (transport === "webrtc" && !provider.supportsWebRtc) {
    return {
      valid: false,
      error: `Provider "${provider.displayName}" does not support WebRTC transport; use WebSocket.`,
      normalizedConfig: {
        provider: providerId,
        model,
        voice,
        transport: provider.transport
      }
    };
  }

  return {
    valid: true,
    normalizedConfig: {
      provider: providerId,
      model,
      voice,
      transport
    }
  };
}
