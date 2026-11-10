import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { getLiveAudioProvider, SPACE_AGENT_HOME, SPACE_INSTALL_ROOT, type LiveAudioProviderId } from "@space/contracts";

/**
 * Startup voice grants (operator 2026-11-08, plan clipboard:dwUAko_YB9yG): where their keys live and which speech to text
 * and voice each Live model uses. Keys come from the environment, then the install root's `secrets`, then the agent user's
 * `~/.config/space` (where the grant signups saved them). They stay on the server.
 */
export type LiveKitKeys = { url: string; apiKey: string; apiSecret: string };
export type GrantKeys = { livekit?: LiveKitKeys; cartesia?: string; murf?: string; assemblyai?: string };
export type GrantSttEngine = "assemblyai" | "cartesia" | "livekit";
export type GrantTtsEngine = "murf" | "cartesia" | "livekit";
export type GrantVoicePlan = {
  stt: { engine: GrantSttEngine; model?: string };
  tts: { engine: GrantTtsEngine; model?: string; voice: string };
  language?: string;
  keys: GrantKeys;
};
export const GRANT_LIVE_PROVIDERS = ["livekit", "cartesia", "murf", "assemblyai"] as const;
export const isGrantLiveProvider = (id: string): id is (typeof GRANT_LIVE_PROVIDERS)[number] => (GRANT_LIVE_PROVIDERS as readonly string[]).includes(id);

const SOURCES = {
  livekit: { fileEnv: "SPACE_LIVEKIT_ENV_FILE", file: "space-livekit.env", home: "livekit.key", label: "LiveKit" },
  cartesia: { fileEnv: "SPACE_CARTESIA_KEY_FILE", keyEnv: "CARTESIA_API_KEY", file: "space-cartesia.key", home: "cartesia.key", label: "Cartesia" },
  murf: { fileEnv: "SPACE_MURF_KEY_FILE", keyEnv: "MURF_API_KEY", file: "space-murf.key", home: "murf.key", label: "Murf AI" },
  assemblyai: { fileEnv: "SPACE_ASSEMBLYAI_KEY_FILE", keyEnv: "ASSEMBLYAI_API_KEY", file: "space-assemblyai.key", home: "assemblyai.key", label: "AssemblyAI" }
} as const;
const grantFiles = (grant: keyof typeof SOURCES, env: NodeJS.ProcessEnv) =>
  [env[SOURCES[grant].fileEnv], `${SPACE_INSTALL_ROOT}/secrets/${SOURCES[grant].file}`, `${SPACE_AGENT_HOME}/.config/space/${SOURCES[grant].home}`].filter(Boolean) as string[];
const firstFile = async (paths: string[]) => {
  for (const path of paths) {
    try { const text = (await readFile(path, "utf8")).trim(); if (text) return text; } catch { /* a missing or unreadable file: try the next one */ }
  }
  return undefined;
};

/** `LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…`, one per line or space separated, quotes allowed. */
export function parseLiveKitEnv(text: string): LiveKitKeys | undefined {
  const values = Object.fromEntries([...text.matchAll(/(LIVEKIT_[A-Z_]+)=["']?([^\s"']+)/g)].map((match) => [match[1], match[2]]));
  return values.LIVEKIT_URL && values.LIVEKIT_API_KEY && values.LIVEKIT_API_SECRET
    ? { url: values.LIVEKIT_URL, apiKey: values.LIVEKIT_API_KEY, apiSecret: values.LIVEKIT_API_SECRET } : undefined;
}

export async function readGrantKeys(env: NodeJS.ProcessEnv = process.env): Promise<GrantKeys> {
  const keys: GrantKeys = {};
  keys.livekit = env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_URL
    ? { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET }
    : parseLiveKitEnv((await firstFile(grantFiles("livekit", env))) ?? "");
  for (const grant of ["cartesia", "murf", "assemblyai"] as const) keys[grant] = env[SOURCES[grant].keyEnv]?.trim() || await firstFile(grantFiles(grant, env));
  if (!keys.livekit) delete keys.livekit;
  return keys;
}

const LIVEKIT_TTS_MODELS: Record<string, string> = {
  "livekit/cartesia-sonic-3": "cartesia/sonic-3", "livekit/rime-arcana": "rime/arcana", "livekit/inworld-tts-1": "inworld/inworld-tts-1"
};
const need = (...labels: string[]) => `Needs the ${labels.join(" or ")} key on Space (${SPACE_INSTALL_ROOT}/secrets).`;

/** The speech to text and voice one grant Live model uses, or what key it still needs. */
export function grantVoicePlan(provider: LiveAudioProviderId, model: string | undefined, keys: GrantKeys, language?: string):
  { plan: GrantVoicePlan; missing?: undefined } | { plan?: undefined; missing: string } {
  const descriptor = getLiveAudioProvider(provider);
  const entry = descriptor.models.find((item) => item.id === model) ?? descriptor.models.find((item) => item.id === descriptor.defaultModel)!;
  const plan = (stt: GrantVoicePlan["stt"], tts: Omit<GrantVoicePlan["tts"], "voice">): { plan: GrantVoicePlan } =>
    ({ plan: { stt, tts: { ...tts, voice: entry.defaultVoice }, keys, ...(language ? { language } : {}) } });
  const lkStt = { engine: "livekit" as const, model: "deepgram/nova-3" };
  const sonic = keys.cartesia ? { engine: "cartesia" as const, model: "sonic-3" } : { engine: "livekit" as const, model: "cartesia/sonic-3" };
  if (provider === "livekit") return keys.livekit ? plan(lkStt, { engine: "livekit", model: LIVEKIT_TTS_MODELS[entry.id] ?? "cartesia/sonic-3" }) : { missing: need("LiveKit") };
  if (provider === "cartesia") return keys.cartesia ? plan({ engine: "cartesia", model: "ink-whisper" }, { engine: "cartesia", model: "sonic-3" }) : { missing: need("Cartesia") };
  if (provider === "murf") {
    if (!keys.murf) return { missing: need("Murf AI") };
    if (keys.assemblyai) return plan({ engine: "assemblyai" }, { engine: "murf" });
    return keys.livekit ? plan(lkStt, { engine: "murf" }) : { missing: `${need("AssemblyAI", "LiveKit")} Murf AI only speaks.` };
  }
  if (provider === "assemblyai") {
    if (!keys.assemblyai) return { missing: need("AssemblyAI") };
    if (entry.id.endsWith("-murf")) return keys.murf ? plan({ engine: "assemblyai" }, { engine: "murf" }) : { missing: need("Murf AI") };
    return keys.cartesia || keys.livekit ? plan({ engine: "assemblyai" }, sonic) : { missing: need("Cartesia", "LiveKit") };
  }
  return { missing: `Unknown voice grant provider: ${provider}` };
}

/** LiveKit Inference access token: HS256, issuer = API key, `inference.perform` grant. */
export function liveKitInferenceToken(keys: LiveKitKeys, identity = "space-voice", ttlSeconds = 600, now = Math.floor(Date.now() / 1000)): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: keys.apiKey, sub: identity, nbf: now - 5, exp: now + ttlSeconds, inference: { perform: true } })}`;
  return `${head}.${createHmac("sha256", keys.apiSecret).update(head).digest("base64url")}`;
}
export const LIVEKIT_INFERENCE_WS = "wss://agent-gateway.livekit.cloud/v1";
