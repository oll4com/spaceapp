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
