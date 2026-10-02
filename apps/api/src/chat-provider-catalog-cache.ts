import type { ChatProviderAdapter, ChatProviderCatalogResult } from "./chat-providers.js";

interface Entry {
  result?: ChatProviderCatalogResult;
  checkedAt: number;
  pending?: Promise<ChatProviderCatalogResult>;
}

/** Catalog metadata only: execution authorization and runtime toggles remain live. */
export function createChatProviderCatalogCache(options: {
  refreshAfterMs?: number;
  maxAgeMs?: number;
  now?: () => number;
} = {}) {
  const entries = new Map<string, Entry>();
  const now = options.now ?? Date.now;
  const refreshAfterMs = options.refreshAfterMs ?? 30_000;
  const maxAgeMs = options.maxAgeMs ?? 120_000;

  function refresh(provider: ChatProviderAdapter, entry: Entry) {
    entry.pending ??= Promise.resolve().then(() => provider.loadCatalog())
      .catch(() => ({ models: [], current: null, error: `${provider.providerName} model catalog is unavailable.` }))
      .then(result => {
        entry.result = result;
        entry.checkedAt = now();
        entry.pending = undefined;
        return result;
      });
    return entry.pending;
  }

  function start(provider: ChatProviderAdapter) {
    let entry = entries.get(provider.providerId);
    if (!entry) {
      entry = { checkedAt: 0 };
      entries.set(provider.providerId, entry);
    }
    if (!entry.result || entry.result.error || now() - entry.checkedAt >= refreshAfterMs) {
      void refresh(provider, entry);
    }
    return entry;
  }

  return {
    warm(provider: ChatProviderAdapter) { start(provider); },
    forget(providerId: string) { entries.delete(providerId); },
    async read(provider: ChatProviderAdapter, required: boolean): Promise<ChatProviderCatalogResult> {
      const entry = start(provider);
      const recent = entry.result && now() - entry.checkedAt < maxAgeMs;
      if (recent && !entry.result!.error) return entry.result!;
      // A selected provider must resolve its own catalog before it can execute.
      // Unrelated cold/failed providers never hold the Chat session response open.
      if (required) return refresh(provider, entry);
      if (recent) return entry.result!;
      return { models: [], current: null, error: `${provider.providerName} model catalog is loading.` };
    }
  };
}
