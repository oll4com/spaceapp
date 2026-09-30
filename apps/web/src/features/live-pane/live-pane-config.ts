import type { LivePersonalMemoryItem } from "../../live-api.js";
import type { LiveAudioProviderId } from "@space/contracts";

export interface LivePaneStoredConfig {
  streamingMode?: boolean;
  provider?: LiveAudioProviderId;
  prompt?: string;
  voiceModel?: string;
  voice?: string;
  language?: "auto" | "el" | "en";
  timeZone?: string;
  opening?: string;
  voicePrompt?: string;
  delegatedModel?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  webSearch?: boolean;
  delegatedPrompt?: string;
  geminiMemoryEnabled?: boolean;
  enableMcpTools?: boolean;
  enableProfileMemory?: boolean;
  selectedDeviceId?: string;
  voiceOnly?: boolean;
  showToolCalls?: boolean;
  personalMemoryCollapsed?: boolean;
  personalMemories?: LivePersonalMemoryItem[];
}

const GLOBAL_CONFIG_KEY = "space_live_pane_default";

export function loadLivePaneConfig(paneId: string): LivePaneStoredConfig {
  try {
    if (typeof localStorage === "undefined") return {};
    const defaultRaw = localStorage.getItem(GLOBAL_CONFIG_KEY);
    const paneRaw = localStorage.getItem(`space_live_pane_${paneId}`);
    const defaultConfig: LivePaneStoredConfig = defaultRaw ? JSON.parse(defaultRaw) : {};
    const paneConfig: LivePaneStoredConfig = paneRaw ? JSON.parse(paneRaw) : {};
    return { ...defaultConfig, ...paneConfig };
  } catch {}
  return {};
}

export function saveLivePaneConfig(paneId: string, config: LivePaneStoredConfig, persistAsDefault = false) {
  try {
    if (typeof localStorage === "undefined") return;
    const serialized = JSON.stringify(config);
    localStorage.setItem(`space_live_pane_${paneId}`, serialized);
    if (persistAsDefault) {
      const { streamingMode: _paneOnlyMode, ...defaults } = config;
      localStorage.setItem(GLOBAL_CONFIG_KEY, JSON.stringify(defaults));
    }
  } catch {}
}
