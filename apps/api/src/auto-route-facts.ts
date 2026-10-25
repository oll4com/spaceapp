import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { modelPriceCatalogSchema, type ModelPriceCatalog } from "@space/contracts";
import type { AutoRouteFacts } from "./space-agent.js";

/**
 * Space Dots Stage 7: model facts for the Auto policy's shadow decisions —
 * input modalities and context windows from the Codex runtime's own model
 * catalog cache, and the operator's versioned price list
 * (SPACE_MODEL_PRICE_CATALOG). Each file is reread when it changes; a missing
 * or invalid file means the facts are unknown, never guessed.
 */
function fileCache() {
  const cache = new Map<string, { mtimeMs: number; value: unknown }>();
  return async function cached<T>(path: string, parse: (raw: string) => T): Promise<T | null> {
    let mtimeMs: number;
    try { mtimeMs = (await stat(path)).mtimeMs; } catch { return null; }
    const hit = cache.get(path);
    if (hit?.mtimeMs === mtimeMs) return hit.value as T | null;
    let value: T | null = null;
    try { value = parse(await readFile(path, "utf8")); } catch { value = null; }
    cache.set(path, { mtimeMs, value });
    return value;
  };
}

/** The operator's price list alone, for model calls outside Chat runs (the Dot's own messages). */
export function createPriceCatalogLoader(priceCatalogPath: string | null) {
  const cached = fileCache();
  return async (): Promise<ModelPriceCatalog | null> => priceCatalogPath
    ? await cached(priceCatalogPath, (raw) => modelPriceCatalogSchema.parse(JSON.parse(raw))) : null;
}

export function createAutoRouteFactsLoader(options: { codexHome: string; priceCatalogPath: string | null }) {
  const cached = fileCache();
  return async function loadAutoRouteFacts(): Promise<AutoRouteFacts> {
    const models = await cached(join(options.codexHome, "models_cache.json"), (raw) => {
      const parsed = JSON.parse(raw) as { models?: Array<{ slug?: unknown; input_modalities?: unknown; context_window?: unknown }> };
      const capabilities: AutoRouteFacts["capabilities"] = new Map();
      for (const model of parsed.models ?? []) {
        if (typeof model.slug !== "string" || !model.slug || model.slug.length > 200) continue;
        capabilities.set(model.slug, {
          inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities.filter((item): item is string => typeof item === "string").slice(0, 10) : null,
          contextWindow: typeof model.context_window === "number" && Number.isInteger(model.context_window) && model.context_window > 0 ? model.context_window : null
        });
      }
      return capabilities;
    });
    const prices: ModelPriceCatalog | null = options.priceCatalogPath
      ? await cached(options.priceCatalogPath, (raw) => modelPriceCatalogSchema.parse(JSON.parse(raw))) : null;
    return { capabilities: models ?? new Map(), prices };
  };
}
