import { describe, expect, it } from "vitest";
import {
  codexCliModeDefaultsResponseSchema,
  codexCliModeDefaultsSchema,
  updateCodexCliModeDefaultsInputSchema
} from "../src/index.js";

describe("Codex CLI mode defaults contracts", () => {
  it("defines independent Build and Plan model/reasoning pairs", () => {
    const defaults = codexCliModeDefaultsSchema.parse({
      build: { modelId: "gpt-build", reasoningEffort: "high" },
      plan: { modelId: "gpt-plan", reasoningEffort: "xhigh" },
      updatedAt: "2026-07-20T08:00:00.000Z"
    });

    expect(defaults.build).not.toEqual(defaults.plan);
    expect(updateCodexCliModeDefaultsInputSchema.parse({
      mode: "plan",
      modelId: "gpt-plan-2",
      reasoningEffort: "medium"
    })).toEqual({ mode: "plan", modelId: "gpt-plan-2", reasoningEffort: "medium" });
  });

  it("represents an unavailable live catalog without inventing model options", () => {
    const response = codexCliModeDefaultsResponseSchema.parse({
      defaults: {
        build: { modelId: "gpt-build", reasoningEffort: "high" }
      },
      catalog: {
        status: "UNAVAILABLE",
        models: [],
        error: "Codex model catalog is unavailable."
      }
    });

    expect(response.catalog).toEqual({
      status: "UNAVAILABLE",
      models: [],
      error: "Codex model catalog is unavailable."
    });
    // Codex keeps Plan mode to itself: the response names only the fresh-start pair.
    expect(response.defaults).toEqual({ build: { modelId: "gpt-build", reasoningEffort: "high" } });
  });
});
