import { readFile, writeFile } from "node:fs/promises";
import { restartOpenCodeSharedServer } from "./service-restarts.js";
import {
  type CliProviderSetting,
  type CliProviderSettingsResponse
} from "@space/contracts";

export const DEFAULT_OPENCODE_CONFIG_PATH = "/var/lib/spaceapp-user/.config/opencode/opencode.json";

export interface KnownProviderMeta {
  id: string;
  name: string;
  description: string;
}

export const KNOWN_OPENCODE_PROVIDERS: readonly KnownProviderMeta[] = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    description: "Free curated coding models (Muse, MiMo, Big Pickle)"
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "Official OpenCode Go subscription models (GLM, Kimi, Grok, MiniMax)"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Unified router across multiple AI model providers"
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    description: "Cloudflare Workers AI inference models"
  },
  {
    id: "orcarouter",
    name: "OrcaRouter",
    description: "OrcaRouter AI routing and free model pool"
  },
  {
    id: "omniroute",
    name: "OmniRoute",
    description: "OmniRoute AI gateway models"
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI API coding and reasoning models"
  },
  {
    id: "kimi-for-coding",
    name: "Kimi for Coding",
    description: "Moonshot Kimi coding models"
  }
];

export interface OpenCodeConfigFile {
  provider?: Record<string, { name?: string; models?: Record<string, unknown> }>;
  disabled_providers?: string[];
  [key: string]: unknown;
}

export async function readOpenCodeConfigFile(path = DEFAULT_OPENCODE_CONFIG_PATH): Promise<OpenCodeConfigFile> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as OpenCodeConfigFile;
  } catch {
    return {};
  }
}

export async function writeOpenCodeConfigFile(
  config: OpenCodeConfigFile,
  path = DEFAULT_OPENCODE_CONFIG_PATH
): Promise<void> {
  const content = JSON.stringify(config, null, 2) + "\n";
  await writeFile(path, content, "utf8");
}

export async function getCliProviderSettings(
  configPath = DEFAULT_OPENCODE_CONFIG_PATH
): Promise<CliProviderSettingsResponse> {
  const config = await readOpenCodeConfigFile(configPath);
  const disabledSet = new Set(Array.isArray(config.disabled_providers) ? config.disabled_providers : []);

  const providersMap = new Map<string, CliProviderSetting>();

  for (const known of KNOWN_OPENCODE_PROVIDERS) {
    const customConfig = config.provider?.[known.id];
    const customModelsCount = customConfig?.models ? Object.keys(customConfig.models).length : undefined;
    providersMap.set(known.id, {
      id: known.id,
      name: customConfig?.name || known.name,
      description: known.description,
      enabled: !disabledSet.has(known.id),
      modelsCount: customModelsCount,
      isCustom: false
    });
  }

  if (config.provider && typeof config.provider === "object") {
    for (const [id, def] of Object.entries(config.provider)) {
      if (!providersMap.has(id)) {
        const modelsCount = def?.models ? Object.keys(def.models).length : undefined;
        providersMap.set(id, {
          id,
          name: def?.name || id,
          description: "Custom configured provider",
          enabled: !disabledSet.has(id),
          modelsCount,
          isCustom: true
        });
      }
    }
  }

  return {
    providers: Array.from(providersMap.values()),
    disabledProviders: Array.from(disabledSet),
    checkedAt: new Date().toISOString()
  };
}

export async function updateCliProviderSetting(
  providerId: string,
  enabled: boolean,
  options?: {
    configPath?: string;
    restartServer?: () => Promise<void>;
  }
): Promise<CliProviderSettingsResponse> {
  const configPath = options?.configPath ?? DEFAULT_OPENCODE_CONFIG_PATH;
  const restart = options?.restartServer ?? restartOpenCodeSharedServer;

  const config = await readOpenCodeConfigFile(configPath);
  const disabledList = Array.isArray(config.disabled_providers) ? [...config.disabled_providers] : [];
  const set = new Set(disabledList);

  if (enabled) {
    set.delete(providerId);
  } else {
    set.add(providerId);
  }

  config.disabled_providers = Array.from(set);
  await writeOpenCodeConfigFile(config, configPath);
  await restart().catch(() => undefined);

  return getCliProviderSettings(configPath);
}

export async function updateAllCliProviders(
  enabled: boolean,
  options?: {
    configPath?: string;
    restartServer?: () => Promise<void>;
  }
): Promise<CliProviderSettingsResponse> {
  const configPath = options?.configPath ?? DEFAULT_OPENCODE_CONFIG_PATH;
  const restart = options?.restartServer ?? restartOpenCodeSharedServer;

  const config = await readOpenCodeConfigFile(configPath);

  if (enabled) {
    config.disabled_providers = [];
  } else {
    const allIds = new Set(KNOWN_OPENCODE_PROVIDERS.map((p) => p.id));
    if (config.provider && typeof config.provider === "object") {
      for (const id of Object.keys(config.provider)) {
        allIds.add(id);
      }
    }
    config.disabled_providers = Array.from(allIds);
  }

  await writeOpenCodeConfigFile(config, configPath);
  await restart().catch(() => undefined);

  return getCliProviderSettings(configPath);
}
