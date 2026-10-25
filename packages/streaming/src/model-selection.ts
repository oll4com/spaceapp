import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { StreamingBotModelSelection } from "@space/contracts";
import type { StreamingBotLlmConfig } from "./orchestrator.js";

export interface StreamingBotModelOption {
  kind: "API" | "CLI";
  providerId: string;
  modelId: string;
  label: string;
  available: boolean;
  reason: string | null;
}

/** How the orchestrator talks to one route: OpenAI chat/completions or Anthropic messages. */
export interface StreamingBotRoute {
  protocol: "openai" | "anthropic";
  url: string;
}

/**
 * The bot's model routes through Space Gateway, chosen in the Bot tab. Both use the bot's own key, which the operator
 * scopes to paid API accounts (operator decision 2026-10-14: Claude or OpenAI API, not Codex subscriptions).
 * shortcut: the model lists are fixed here; widen them together with the key's allowedModels.
 */
const routes: ReadonlyArray<{ id: string; label: string; protocol: StreamingBotRoute["protocol"]; path: string; models: ReadonlyArray<[string, string]> }> = [
  { id: "gateway-claude", label: "Claude", protocol: "anthropic", path: "/v1/messages",
    models: [["claude-haiku-5-5", "Haiku 5.5 (fast)"], ["claude-sonnet-5-5", "Sonnet 5.5"]] },
  { id: "gateway-openai", label: "OpenAI API", protocol: "openai", path: "/pools/openai/v1/chat/completions",
    models: [["gpt-5.4-mini", "GPT-5.4 mini (fast)"], ["gpt-5-mini", "GPT-5 mini"], ["gpt-4.1-mini", "GPT-4.1 mini"]] }
];

export function dedicatedCredentialReady(config: StreamingBotLlmConfig): boolean {
  if (!config.enabled || !config.keyFile || !isAbsolute(config.keyFile) || !config.keyName?.startsWith("space-streaming-")) return false;
  try {
    const file = lstatSync(config.keyFile);
    return file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= 4096 &&
      (file.mode & 0o007) === 0 && readFileSync(config.keyFile, "utf8").trim().length > 0;
  } catch { return false; }
}

/** The gateway root from SPACE_STREAMING_BOT_BASE_URL (`http://127.0.0.1:4920/v1` → `http://127.0.0.1:4920`). */
function gatewayRoot(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
  } catch { return null; }
}

export function streamingBotModelOptions(config: StreamingBotLlmConfig): StreamingBotModelOption[] {
  const ready = dedicatedCredentialReady(config) && gatewayRoot(config.baseUrl) !== null;
  return routes.flatMap(route => route.models.map(([modelId, name]) => ({
    kind: "API" as const, providerId: route.id, modelId, label: `${route.label} · ${name}`, available: ready,
    reason: ready ? null : "The bot's Space Gateway key is not set up yet (see Setup)."
  })));
}

export function resolveStreamingBotModel(
  selection: StreamingBotModelSelection | null, config: StreamingBotLlmConfig
): { modelId: string | null; route: StreamingBotRoute | null; errorCode: string | null } {
  if (!selection) return { modelId: null, route: null, errorCode: "MODEL_NOT_SELECTED" };
  const route = routes.find(item => item.id === selection.providerId && selection.kind === "API" && item.models.some(([id]) => id === selection.modelId));
  if (!route) return { modelId: null, route: null, errorCode: "MODEL_NOT_IN_CATALOG" };
  const root = gatewayRoot(config.baseUrl);
  if (!dedicatedCredentialReady(config) || !root) return { modelId: null, route: null, errorCode: "MODEL_UNAVAILABLE" };
  return { modelId: selection.modelId, route: { protocol: route.protocol, url: `${root}${route.path}` }, errorCode: null };
}
