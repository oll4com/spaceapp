import type { CodexAppServerSocketModelOption } from "@space/codex-app-server";
import type { CodexModelCatalogOption } from "@space/contracts";
import {
  fetchOpenCodeCurrentModel,
  fetchOpenCodeSessionModels,
  openCodeDefaultReasoningEffort,
  type OpenCodeServerControl
} from "@space/opencode-control";

export interface ChatProviderCurrentModel {
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
}

export interface ChatProviderCatalogResult {
  models: CodexModelCatalogOption[];
  current: ChatProviderCurrentModel | null;
  error: string | null;
}

export interface ChatProviderAdapter {
  providerId: string;
  providerName: string;
  configIdPrefix: string;
  loadCatalog(): Promise<ChatProviderCatalogResult>;
}

export type OpenCodeControlResolver = () => Promise<OpenCodeServerControl>;

export const codexChatProviderId = "codex";
export const opencodeChatProviderId = "opencode";

export const codexChatProviderConfigIdPrefix = "codex-v1|";
export const opencodeChatProviderConfigIdPrefix = "opencode-v1|";

export interface CliChatRuntimeState {
  enabled: boolean;
  reason: string | null;
}

export type CliChatRuntimeStateResolver = (runtimeId: string) => Promise<CliChatRuntimeState>;

const cliChatRuntimeNames: Record<string, string> = {
  "cli:cursor": "Cursor",
  "cli:copilot": "GitHub Copilot",
  "cli:github": "GitHub CLI",
  "cli:gemini": "Google Gemini",
  "cli:deepseek": "DeepSeek"
};

export function cliChatRuntimeName(runtimeId: string): string {
  return cliChatRuntimeNames[runtimeId] ?? runtimeId;
}

export function cliRuntimeChatProviderAdapter(options: {
  runtimeId: string;
  providerName?: string;
  defaultModelId?: string;
  defaultModelDisplayName?: string;
  resolveState: CliChatRuntimeStateResolver;
}): ChatProviderAdapter {
  const providerId = options.runtimeId;
  const defaultModelId = options.defaultModelId ?? "auto";
  const defaultModelDisplayName = options.defaultModelDisplayName ?? "Auto model";
  return {
    providerId,
    providerName: options.providerName ?? cliChatRuntimeName(providerId),
    configIdPrefix: `${providerId}-v1|`,
    async loadCatalog() {
      try {
        const state = await options.resolveState(providerId);
        if (!state.enabled) {
          return { models: [], current: null, error: state.reason ?? `${providerId} is not available.` };
        }
        return {
          models: [
            {
              id: defaultModelId,
              displayName: defaultModelDisplayName,
              isDefault: true,
              defaultReasoningEffort: "none",
              supportedReasoningEfforts: ["none"],
              reasoningOptions: [{ reasoningEffort: "none" }]
            }
          ],
          current: null,
          error: null
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "CLI chat runtime is unavailable.";
        return { models: [], current: null, error: message };
      }
    }
  };
}

export function geminiModelsChatProviderAdapter(options: {
  runtimeId: string;
  providerName?: string;
  executeModels: () => Promise<string>;
  resolveState: CliChatRuntimeStateResolver;
}): ChatProviderAdapter {
  const providerId = options.runtimeId;
  return {
    providerId,
    providerName: options.providerName ?? cliChatRuntimeName(providerId),
    configIdPrefix: `${providerId}-v1|`,
    async loadCatalog() {
      try {
        const state = await options.resolveState(providerId);
        if (!state.enabled) {
          return { models: [], current: null, error: state.reason ?? `${providerId} is not available.` };
        }
        const raw = await options.executeModels();
        const models = raw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const tab = line.indexOf("\t");
            const id = tab > 0 ? line.slice(0, tab).trim() : line;
            const displayName = tab > 0 ? line.slice(tab + 1).trim() : line;
            return {
              id,
              displayName,
              isDefault: false,
              defaultReasoningEffort: "none" as const,
              supportedReasoningEfforts: ["none"],
              reasoningOptions: [{ reasoningEffort: "none" }]
            };
          })
          .filter((model) => model.id.length > 0);
        if (!models.length) {
          return { models: [], current: null, error: "Gemini model catalog is unavailable." };
        }
        return { models, current: null, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gemini model catalog is unavailable.";
        return { models: [], current: null, error: message };
      }
    }
  };
}

const cliModelIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const cliReasoningEffortPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case "none": return "No extra reasoning";
    case "disabled": return "Reasoning disabled";
    case "minimal": return "Minimal reasoning";
    case "low": return "Low reasoning";
    case "medium": return "Medium reasoning";
    case "high": return "High reasoning";
    case "xhigh": return "Extra high reasoning";
    case "max": return "Maximum reasoning";
    default: return `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1).toLowerCase()} reasoning`;
  }
}

function parseCliModelsTsv(raw: string): CodexModelCatalogOption[] {
  const models: CodexModelCatalogOption[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const columns = line.split("\t");
    const id = (columns[0] ?? "").trim();
    const displayName = (columns[1] ?? "").trim();
    if (!id || !cliModelIdentifierPattern.test(id) || seen.has(id)) continue;
    const efforts = (columns[2] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value && cliReasoningEffortPattern.test(value))
      .slice(0, 20);
    const declaredDefault = (columns[3] ?? "").trim();
    const supportedReasoningEfforts = efforts.length ? efforts : ["none"];
    const defaultReasoningEffort =
      declaredDefault && supportedReasoningEfforts.includes(declaredDefault)
        ? declaredDefault
        : supportedReasoningEfforts[0] ?? "none";
    seen.add(id);
    models.push({
      id,
      displayName: displayName || id,
      isDefault: index === 0,
      defaultReasoningEffort,
      supportedReasoningEfforts,
      reasoningOptions: supportedReasoningEfforts.map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffortLabel(reasoningEffort)
      }))
    });
    index += 1;
  }
  return models;
}

export function cliRuntimeModelsChatProviderAdapter(options: {
  runtimeId: string;
  providerName?: string;
  executeModels: () => Promise<string>;
  resolveState: CliChatRuntimeStateResolver;
}): ChatProviderAdapter {
  const providerId = options.runtimeId;
  return {
    providerId,
    providerName: options.providerName ?? cliChatRuntimeName(providerId),
    configIdPrefix: `${providerId}-v1|`,
    async loadCatalog() {
      try {
        const state = await options.resolveState(providerId);
        if (!state.enabled) {
          return { models: [], current: null, error: state.reason ?? `${providerId} is not available.` };
        }
        const raw = await options.executeModels();
        const models = parseCliModelsTsv(raw);
        if (!models.length) {
          return { models: [], current: null, error: `${providerId} model catalog is unavailable.` };
        }
        return { models, current: null, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : `${providerId} model catalog is unavailable.`;
        return { models: [], current: null, error: message };
      }
    }
  };
}

export function codexChatProviderAdapter(
  control: { listModels(): Promise<CodexAppServerSocketModelOption[]> } | null | undefined,
  loadCatalogOverride?: () => Promise<ChatProviderCatalogResult>
): ChatProviderAdapter {
  return {
    providerId: codexChatProviderId,
    providerName: "Codex (OpenAI)",
    configIdPrefix: codexChatProviderConfigIdPrefix,
    async loadCatalog() {
      if (loadCatalogOverride) return loadCatalogOverride();
      if (!control) {
        return { models: [], current: null, error: "Codex model catalog control is unavailable." };
      }
      try {
        const catalog = await control.listModels();
        return {
          models: catalog.map(codexCatalogEntry),
          current: null,
          error: null
        };
      } catch {
        return { models: [], current: null, error: "Codex model catalog is unavailable." };
      }
    }
  };
}

export function opencodeChatProviderAdapter(resolveControl: OpenCodeControlResolver): ChatProviderAdapter {
  return {
    providerId: opencodeChatProviderId,
    providerName: "OpenCode",
    configIdPrefix: opencodeChatProviderConfigIdPrefix,
    async loadCatalog() {
      try {
        const control = await resolveControl();
        const descriptors = await fetchOpenCodeSessionModels(control);
        const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
        const currentModelId = currentModel ? `${currentModel.providerID}/${currentModel.id}` : null;
        const models = descriptors.map((descriptor) => {
          const optionId = `${descriptor.providerId}/${descriptor.modelId}`;
          const listedVariants = descriptor.variants.length > 0 ? descriptor.variants : [];
          const supportedReasoningEfforts = listedVariants.length > 0
            ? listedVariants
            : [openCodeDefaultReasoningEffort];
          return {
            id: optionId,
            displayName: descriptor.displayName,
            isDefault: optionId === currentModelId,
            defaultReasoningEffort:
              descriptor.defaultVariant ?? listedVariants[0] ?? openCodeDefaultReasoningEffort,
            supportedReasoningEfforts,
            reasoningOptions: listedVariants.map((reasoningEffort) => ({ reasoningEffort }))
          };
        });
        return {
          models,
          current: currentModel
            ? {
                providerId: opencodeChatProviderId,
                modelId: `${currentModel.providerID}/${currentModel.id}`,
                reasoningEffort: currentModel.variant ?? null
              }
            : null,
          error: null
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "OpenCode model catalog is unavailable.";
        return { models: [], current: null, error: message };
      }
    }
  };
}

function codexCatalogEntry(model: CodexAppServerSocketModelOption): CodexModelCatalogOption {
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    reasoningOptions: model.reasoningOptions
  };
}

export function providerForConfigId(
  adapters: ChatProviderAdapter[],
  configId: string | null
): ChatProviderAdapter | null {
  if (!configId) return null;
  return adapters.find((adapter) => configId.startsWith(adapter.configIdPrefix)) ?? null;
}
