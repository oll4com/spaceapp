import { describe, expect, it, vi } from "vitest";
import { createChatProviderCatalogCache } from "../src/chat-provider-catalog-cache.js";
import type { ChatProviderAdapter, ChatProviderCatalogResult } from "../src/chat-providers.js";

const healthy: ChatProviderCatalogResult = { models: [{ id: "model", displayName: "Model", isDefault: true,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }], current: null, error: null };
function provider(loadCatalog: ChatProviderAdapter["loadCatalog"]): ChatProviderAdapter {
  return { providerId: "provider", providerName: "Provider", configIdPrefix: "provider-v1|", loadCatalog };
}
function deferred() {
  let resolve!: (value: ChatProviderCatalogResult) => void;
  const promise = new Promise<ChatProviderCatalogResult>(r => { resolve = r; });
  return { promise, resolve };
}

describe("Chat provider catalog cache", () => {
  it("coalesces concurrent discovery and lets an unrelated cold catalog stay in the background", async () => {
    const gate = deferred(), load = vi.fn(() => gate.promise), p = provider(load);
    const cache = createChatProviderCatalogCache();
    cache.warm(p);
    const required = cache.read(p, true);
    expect((await cache.read(p, false)).error).toContain("loading");
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve(healthy);
    expect(await required).toBe(healthy);
    expect(await cache.read(p, true)).toBe(healthy);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refreshes healthy metadata in the background and replaces it with a discovered failure", async () => {
    let time = 0;
    const gate = deferred(), load = vi.fn().mockResolvedValueOnce(healthy).mockImplementation(() => gate.promise);
    const p = provider(load), cache = createChatProviderCatalogCache({ now: () => time });
    await cache.read(p, true);
    time = 30_001;
    expect(await cache.read(p, true)).toBe(healthy);
    const unavailable = { models: [], current: null, error: "Unavailable" };
    gate.resolve(unavailable);
    await vi.waitFor(async () => expect(await cache.read(p, true)).toEqual(unavailable));
    expect((await cache.read(p, false)).models).toEqual([]);
  });

  it("waits for a selected catalog after the hard age limit and forgets metadata on disable", async () => {
    let time = 0;
    const gate = deferred(), load = vi.fn().mockResolvedValueOnce(healthy).mockImplementation(() => gate.promise);
    const p = provider(load), cache = createChatProviderCatalogCache({ now: () => time });
    await cache.read(p, true);
    time = 120_001;
    let resolved = false;
    const required = cache.read(p, true).then(value => { resolved = true; return value; });
    expect((await cache.read(p, false)).models).toEqual([]);
    expect(resolved).toBe(false);
    gate.resolve(healthy);
    await required;
    cache.forget(p.providerId);
    cache.warm(p);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it("recovers a selected provider without choosing another provider", async () => {
    const load = vi.fn().mockResolvedValueOnce({ models: [], current: null, error: "Offline" }).mockResolvedValue(healthy);
    const p = provider(load), cache = createChatProviderCatalogCache();
    expect((await cache.read(p, true)).error).toBe("Offline");
    expect(await cache.read(p, true)).toBe(healthy);
  });
});
