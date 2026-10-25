import { describe, expect, it } from "vitest";
import { setupFreeModelCatalogSchema } from "../src/setup-free-models.js";

const catalog = (cost: unknown) => ({ schema: 1, benchmarkVersion: "tool-call:v1", checkedAt: "2026-10-21T08:00:00.000Z", models: [
  { id: "opencode/big-pickle", anonymousAvailable: true, setupPassed: 2, attempts: 2, successes: 2, latencyMs: 50, context: null,
    toolcall: true, text: true, cost }
] });

describe("installer free model catalog", () => {
  it("takes a model only with every price zero; an extra price dimension is refused, not dropped (review 2026-10-21 #2)", () => {
    expect(setupFreeModelCatalogSchema.safeParse(catalog({ input: 0, output: 0, cache: { read: 0, write: 0 } })).success).toBe(true);
    expect(setupFreeModelCatalogSchema.safeParse(catalog({ input: 0, output: 0, cache: { read: 2, write: 3 } })).success).toBe(false);
    expect(setupFreeModelCatalogSchema.safeParse(catalog({ input: 0, output: 0, cache: { read: 0, write: 0 }, reasoning: 1 })).success).toBe(false);
    expect(setupFreeModelCatalogSchema.safeParse(catalog({ input: 0, output: 0, cache: { read: 0, write: 0, storage: 0.1 } })).success).toBe(false);
  });
});
