import { readFile } from "node:fs/promises";
import { currentOpenCodeBinary, type ChessCliModel } from "./chess/chess-cli.js";
import { runNativeMetadataCommand } from "./task-title-native.js";
import { SPACE_AGENT_HOME } from "@space/contracts";

export interface OpenCodeModelCatalogEntry {
  id: string;
  providerId: string;
  name: string;
  efforts: string[];
}

export const DEFAULT_OPENCODE_CONFIG_PATH = `${SPACE_AGENT_HOME}/.config/opencode/opencode.json`;

const CACHE_TTL_MS = 60_000;
let cachedCatalog: { expiresAt: number; data: Map<string, ChessCliModel[]> } | null = null;

export function clearOpenCodeBenchmarkCache(): void {
  cachedCatalog = null;
}

/** Built-in free models provided natively by OpenCode Zen. */
const OPENCODE_NATIVE_FREE_MODELS: ChessCliModel[] = [
  { id: "opencode/hy4-flash-free", name: "Hy4 flash Free", efforts: ["none", "high"] },
  { id: "opencode/iceman-free", name: "Iceman Free", efforts: ["default"] },
  { id: "opencode/inkling-2-small-free", name: "Inkling 2 Small Free", efforts: ["none", "minimal", "low", "medium", "high", "max"] },
  { id: "opencode/longcat-2.5-free", name: "LongCat 2.5 Free", efforts: ["default"] },
  { id: "opencode/flint-40b-free", name: "Flint 40B Free", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", efforts: ["low", "high", "max"] },
  { id: "opencode/nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", efforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  { id: "opencode/beam-free", name: "Beam Free", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", efforts: ["default"] },
  { id: "opencode/glm-5.3-flash-free", name: "GLM-5.3-Flash Free", efforts: ["low", "high", "max"] },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", efforts: ["default"] },
  { id: "opencode/big-pickle", name: "Big Pickle", efforts: ["default"] },
];

/** Curated and fallback models for Space Gateway providers (fast, verified chat models first). */
const SPACE_GATEWAY_FALLBACK_MODELS: Record<string, ChessCliModel[]> = {
  "space-gateway-claude": [
    { id: "space-gateway-claude/claude-haiku-5-5", name: "Claude Haiku 5.5 (API credits)", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "space-gateway-claude/claude-sonnet-5-5", name: "Claude Sonnet 5.5 (API credits)", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "space-gateway-claude/claude-opus-5-5", name: "Claude Opus 5.5 (API credits)", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "space-gateway-claude/claude-fable-5-1", name: "Claude Fable 5.1 (API credits)", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
  "space-gateway-nvidia": [
    { id: "space-gateway-nvidia/minimaxai/minimax-m3.1-flash", name: "minimaxai/minimax-m3.1-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/nvidia/nemotron-3-ultra-550b-a55b", name: "nvidia/nemotron-3-ultra-550b-a55b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", name: "nvidia/nemotron-3.5-lightning-30b-a3b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/stepfun-ai/step-5-preview", name: "stepfun-ai/step-5-preview", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/mistralai/mistral-large-4-1t-a52b", name: "mistralai/mistral-large-4-1t-a52b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", name: "nvidia/nemotron-3.5-super-vl-120b-a12b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/nvidia/nemotron-3.5-bolt-e4b", name: "nvidia/nemotron-3.5-bolt-e4b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/poolside/laguna-xs-2.1", name: "poolside/laguna-xs-2.1", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/meta/muse-glimmer-30b", name: "meta/muse-glimmer-30b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-nvidia/openai/gpt-oss-20b", name: "openai/gpt-oss-20b", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-groq": [
    { id: "space-gateway-groq/openai/gpt-oss-120b", name: "openai/gpt-oss-120b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-groq/openai/gpt-oss-20b", name: "openai/gpt-oss-20b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-groq/qwen/qwen3.8-27b", name: "qwen/qwen3.8-27b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-groq/allam-2-7b", name: "allam-2-7b", efforts: ["default"] },
  ],
  "space-gateway-mistral": [
    { id: "space-gateway-mistral/codestral-latest", name: "codestral-latest", efforts: ["default"] },
    { id: "space-gateway-mistral/ministral-8b-latest", name: "ministral-8b-latest", efforts: ["default"] },
    { id: "space-gateway-mistral/ministral-14b-latest", name: "ministral-14b-latest", efforts: ["default"] },
    { id: "space-gateway-mistral/mistral-small-latest", name: "mistral-small-latest", efforts: ["default"] },
    { id: "space-gateway-mistral/mistral-medium-latest", name: "mistral-medium-latest", efforts: ["default"] },
    { id: "space-gateway-mistral/magistral-small-latest", name: "magistral-small-latest", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-mistral/magistral-medium-latest", name: "magistral-medium-latest", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-adaption": [
    { id: "space-gateway-adaption/glm-5.3-flash", name: "glm-5.3-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/deepseek-v4-flash", name: "deepseek-v4-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/glm-5.2", name: "glm-5.2", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/qwen3.5-397b", name: "qwen3.5-397b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/qwen3.8-27b", name: "qwen3.8-27b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/gemma-4-31b-it", name: "gemma-4-31b-it", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-adaption/gemma-4-26b-a4b-it", name: "gemma-4-26b-a4b-it", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-amd": [
    { id: "space-gateway-amd/DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-amd/DeepSeek-V4-Flash", name: "DeepSeek-V4-Flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-amd/Gemma-4-31B-IT", name: "Gemma-4-31B-IT", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-amd/MiniCPM-V-4.7-35B-A3B", name: "MiniCPM-V-4.7-35B-A3B", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-amd/Qwen3.8-27B", name: "Qwen3.8-27B", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-ovh": [
    { id: "space-gateway-ovh/gpt-oss-120b", name: "gpt-oss-120b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/Qwen3.8-27B", name: "Qwen3.8-27B", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/Qwen3.5-9B", name: "Qwen3.5-9B", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/gpt-oss-20b", name: "gpt-oss-20b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/Mistral-Small-3.2-24B-Instruct-2506", name: "Mistral-Small-3.2-24B-Instruct-2506", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/Qwen3.6-27B", name: "Qwen3.6-27B", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-ovh/Qwen3.5-397B-A17B", name: "Qwen3.5-397B-A17B", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-gemini": [
    { id: "space-gateway-gemini/gemini-3-flash-preview", name: "gemini-3-flash-preview", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-gemini/gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-gemini/gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-gemini/gemini-3.1-flash-lite-preview", name: "gemini-3.1-flash-lite-preview", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-gemini/gemini-flash-lite-latest", name: "gemini-flash-lite-latest", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-cloudflare": [
    { id: "space-gateway-cloudflare/@cf/nvidia/nemotron-3-120b-a12b", name: "@cf/nvidia/nemotron-3-120b-a12b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-cloudflare/@cf/zai-org/glm-4.7-flash", name: "@cf/zai-org/glm-4.7-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-cloudflare/@cf/qwen/qwen3.8-27b", name: "@cf/qwen/qwen3.8-27b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-cloudflare/@cf/google/gemma-4-26b-a4b-it", name: "@cf/google/gemma-4-26b-a4b-it", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-zai": [
    { id: "space-gateway-zai/glm-4.5-flash", name: "glm-4.5-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-zai/glm-4.7-flash", name: "glm-4.7-flash", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-zai/glm-4.6v-flash", name: "glm-4.6v-flash", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-inception": [
    { id: "space-gateway-inception/mercury-3", name: "mercury-3", efforts: ["low", "medium", "high"] },
  ],
  "space-gateway-freeai": [
    { id: "space-gateway-freeai/qwen3-8b", name: "qwen3-8b", efforts: ["default"] },
    { id: "space-gateway-freeai/qwen7b", name: "qwen7b", efforts: ["default"] },
    { id: "space-gateway-freeai/mistral", name: "mistral", efforts: ["default"] },
    { id: "space-gateway-freeai/deepseek-r1-7b", name: "deepseek-r1-7b", efforts: ["low", "medium", "high"] },
    { id: "space-gateway-freeai/deepseek-r1", name: "deepseek-r1", efforts: ["low", "medium", "high"] },
  ],
};

interface OpenCodeApiItem {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  status?: unknown;
  variants?: Array<{ id?: unknown }>;
}

function parseOpenCodeApiPayload(output: string): Map<string, ChessCliModel[]> | null {
  try {
    const parsed = JSON.parse(output) as { data?: OpenCodeApiItem[] };
    const list = Array.isArray(parsed?.data) ? parsed.data : [];
    if (!list.length) return null;
    const map = new Map<string, ChessCliModel[]>();
    for (const m of list) {
      if (m?.enabled === false || m?.status === "deprecated") continue;
      const providerId = typeof m.providerID === "string" && m.providerID.trim() ? m.providerID.trim() : "opencode";
      const rawId = String(m.id ?? "").trim();
      if (!rawId) continue;
      const name = String(m.name ?? rawId).trim() || rawId;
      const variants = Array.isArray(m.variants)
        ? m.variants
            .map((v) => String(v?.id ?? "").trim())
            .filter((v: string) => /^[a-z][a-z0-9_-]{0,19}$/.test(v))
        : [];
      const efforts: string[] = variants.length > 0 ? Array.from(new Set<string>(variants)) : ["default"];
      const fullModelId = rawId.startsWith(`${providerId}/`) ? rawId : `${providerId}/${rawId}`;
      const providerModels = map.get(providerId) ?? [];
      providerModels.push({ id: fullModelId, name, efforts });
      map.set(providerId, providerModels);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

interface ConfigProvider {
  name?: unknown;
  models?: Record<string, { name?: unknown }>;
}

async function loadOpenCodeConfigFile(configPath: string): Promise<Map<string, ChessCliModel[]> | null> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { disabled_providers?: unknown[]; provider?: Record<string, ConfigProvider> };
    const disabled = new Set(Array.isArray(parsed.disabled_providers) ? parsed.disabled_providers : []);
    const map = new Map<string, ChessCliModel[]>();
    for (const [pId, pCfg] of Object.entries(parsed.provider ?? {})) {
      if (disabled.has(pId)) continue;
      const modelsObj = pCfg?.models;
      if (!modelsObj || typeof modelsObj !== "object") continue;
      const pModels: ChessCliModel[] = [];
      const defaultEfforts = (pCfg.name && String(pCfg.name).toLowerCase().includes("claude")) || pId.includes("claude")
        ? ["low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high"];
      for (const [mId, mCfg] of Object.entries(modelsObj)) {
        const name = String(mCfg?.name ?? mId).trim() || mId;
        const fullModelId = mId.startsWith(`${pId}/`) ? mId : `${pId}/${mId}`;
        pModels.push({ id: fullModelId, name, efforts: defaultEfforts });
      }
      if (pModels.length > 0) map.set(pId, pModels);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Loads all models from OpenCode across all configured and enabled providers
 * (built-in OpenCode models + Space Gateway providers).
 */
export async function loadOpenCodeBenchmarkModels(): Promise<Map<string, ChessCliModel[]>> {
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cachedCatalog.data;
  }

  let result: Map<string, ChessCliModel[]> | null = null;

  // 1. Fast path: load ~/.config/opencode/opencode.json directly without child process overhead.
  const fileResult = await loadOpenCodeConfigFile(DEFAULT_OPENCODE_CONFIG_PATH);
  if (fileResult && fileResult.size > 0) {
    result = fileResult;
  }

  // 2. Query standalone OpenCode runtime API only if config file was not present or empty.
  if (!result || result.size <= 1) {
    try {
      const binary = await currentOpenCodeBinary();
      if (binary) {
        const output = await runNativeMetadataCommand(
          binary,
          ["api", "GET", "/api/model", "--standalone"],
          "",
          undefined,
          2_000,
          1_048_576,
          {
            cwd: "/etc",
            env: {
              PATH: process.env.PATH,
              LANG: "C.UTF-8",
              HOME: SPACE_AGENT_HOME,
              XDG_CONFIG_HOME: `${SPACE_AGENT_HOME}/.config`,
              OPENCODE_CONFIG: DEFAULT_OPENCODE_CONFIG_PATH,
            },
          }
        );
        const apiResult = parseOpenCodeApiPayload(output);
        if (apiResult) {
          if (!result) result = new Map();
          for (const [pId, models] of apiResult.entries()) {
            if (!result.has(pId)) result.set(pId, models);
          }
        }
      }
    } catch {
      // Standalone query is optional fallback.
    }
  }

  // 3. Ensure native opencode free models and standard space-gateway providers exist, with fast probes first.
  if (!result) result = new Map();
  if (!result.has("opencode") || result.get("opencode")!.length === 0) {
    result.set("opencode", [...OPENCODE_NATIVE_FREE_MODELS]);
  }
  for (const [pId, fallbackModels] of Object.entries(SPACE_GATEWAY_FALLBACK_MODELS)) {
    const existing = result.get(pId) ?? [];
    const seen = new Set<string>();
    const merged: ChessCliModel[] = [];
    for (const m of [...fallbackModels, ...existing]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    if (merged.length > 0) {
      result.set(pId, merged);
    }
  }

  cachedCatalog = { expiresAt: now + CACHE_TTL_MS, data: result };
  return result;
}

/**
 * Returns models for a specific OpenCode/Space Gateway provider.
 */
export async function openCodeModelsForProvider(providerId: string): Promise<ChessCliModel[]> {
  const map = await loadOpenCodeBenchmarkModels();
  return map.get(providerId) ?? [];
}
