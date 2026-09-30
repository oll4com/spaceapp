import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model, Provider, StreamingBotModelSelection } from "@space/contracts";
import type { StreamingBotLlmConfig } from "./orchestrator.js";

export interface StreamingBotModelOption {
  kind: "API" | "CLI";
  providerId: string;
  modelId: string;
  label: string;
  available: boolean;
  reason: string | null;
}

function matchingUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try { return new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, ""); }
  catch { return false; }
}

function dedicatedCredentialReady(config: StreamingBotLlmConfig): boolean {
  if (!config.enabled || !config.keyFile || !isAbsolute(config.keyFile) || !config.keyName?.startsWith("space-streaming-")) return false;
  try {
    const file = lstatSync(config.keyFile);
    return file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= 4096 &&
      (file.mode & 0o007) === 0 && readFileSync(config.keyFile, "utf8").trim().length > 0;
  } catch { return false; }
}

export function streamingBotModelOptions(providers: Provider[], models: Model[], config: StreamingBotLlmConfig): StreamingBotModelOption[] {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const keyReady = dedicatedCredentialReady(config);
  return models.map(model => {
    const provider = byId.get(model.providerId);
    const kind = provider?.id.startsWith("cli:") || provider?.id === "opencode" ? "CLI" : "API";
    const available = kind === "API" && provider?.status === "VERIFIED" && model.status === "VERIFIED" &&
      matchingUrl(provider.baseUrl, config.baseUrl) && keyReady;
    return { kind, providerId: model.providerId, modelId: model.id, label: `${provider?.displayName ?? model.providerId} · ${model.displayName}`,
      available: Boolean(available), reason: available ? null : kind === "CLI" ? "Isolated CLI bot sessions are not verified yet." : "A verified dedicated Streaming API key and matching endpoint are required." };
  });
}

export function resolveStreamingBotModel(
  selection: StreamingBotModelSelection | null,
  providers: Provider[], models: Model[], config: StreamingBotLlmConfig
): { modelId: string | null; errorCode: string | null } {
  if (!selection) return { modelId: null, errorCode: "MODEL_NOT_SELECTED" };
  const option = streamingBotModelOptions(providers, models, config).find(item =>
    item.kind === selection.kind && item.providerId === selection.providerId && item.modelId === selection.modelId);
  if (!option) return { modelId: null, errorCode: "MODEL_NOT_IN_CATALOG" };
  if (!option.available) return { modelId: null, errorCode: "MODEL_UNAVAILABLE" };
  const model = models.find(item => item.id === selection.modelId && item.providerId === selection.providerId);
  return { modelId: model?.runtimeId ?? model?.id ?? null, errorCode: null };
}
