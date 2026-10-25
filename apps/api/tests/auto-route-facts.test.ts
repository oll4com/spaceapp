import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutoRouteFactsLoader, createPriceCatalogLoader } from "../src/auto-route-facts.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Auto route facts", () => {
  it("loads the operator's price list alone for calls outside Chat runs, and nothing without a valid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "space-price-catalog-")); dirs.push(dir);
    const prices = join(dir, "prices.json");
    writeFileSync(prices, JSON.stringify({ version: "v2", currency: "USD", prices: [{ model: "gpt-5.6-sol", inputPerMillion: 1, outputPerMillion: 8 }] }));
    expect((await createPriceCatalogLoader(prices)())?.version).toBe("v2");
    expect(await createPriceCatalogLoader(null)()).toBeNull();
    expect(await createPriceCatalogLoader(join(dir, "missing.json"))()).toBeNull();
    writeFileSync(join(dir, "bad.json"), "{");
    expect(await createPriceCatalogLoader(join(dir, "bad.json"))()).toBeNull();
  });
  it("reads modalities and context windows from the runtime catalog and the operator's prices, rereading changed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "space-auto-facts-")); dirs.push(dir);
    writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [
      { slug: "vision", input_modalities: ["text", "image"], context_window: 272000 }, { slug: "plain", input_modalities: "text", context_window: -1 }, { slug: 7 }] }));
    const prices = join(dir, "prices.json");
    writeFileSync(prices, JSON.stringify({ version: "v1", currency: "USD", prices: [{ model: "vision", inputPerMillion: 1, outputPerMillion: 4 }] }));
    const load = createAutoRouteFactsLoader({ codexHome: dir, priceCatalogPath: prices });
    const facts = await load();
    expect([...facts.capabilities]).toEqual([["vision", { inputModalities: ["text", "image"], contextWindow: 272000 }], ["plain", { inputModalities: null, contextWindow: null }]]);
    expect(facts.prices?.version).toBe("v1");
    writeFileSync(prices, "{ not json");
    utimesSync(prices, new Date(), new Date(Date.now() + 5_000));
    expect((await load()).prices).toBeNull();
    expect((await createAutoRouteFactsLoader({ codexHome: join(dir, "missing"), priceCatalogPath: null })())).toEqual({ capabilities: new Map(), prices: null });
  });
});
