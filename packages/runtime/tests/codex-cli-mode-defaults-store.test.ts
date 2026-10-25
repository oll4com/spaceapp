import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceNotFoundError } from "../src/index.js";

describe("InMemorySpaceStore Codex CLI mode defaults", () => {
  it("does not invent a model before provider-backed initialization", () => {
    const store = new InMemorySpaceStore();

    expect(() => store.getCodexCliModeDefaults()).toThrow(SpaceNotFoundError);
    expect(store.snapshot().codexCliModeDefaults).toBeNull();
  });

  it("updates one mode atomically while preserving the other mode", () => {
    const store = new InMemorySpaceStore();
    const initialized = store.initializeCodexCliModeDefaults({
      build: { modelId: "gpt-build", reasoningEffort: "high" },
      plan: { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    });

    const updated = store.updateCodexCliModeDefaults({
      mode: "plan",
      modelId: "gpt-plan-2",
      reasoningEffort: "medium"
    });

    expect(updated.build).toEqual(initialized.build);
    expect(updated.plan).toEqual({ modelId: "gpt-plan-2", reasoningEffort: "medium" });
    expect(store.getCodexCliModeDefaults()).toEqual(updated);
  });

  it("keeps the first initialization pair across later startup attempts", () => {
    const store = new InMemorySpaceStore();
    const first = store.initializeCodexCliModeDefaults({
      build: { modelId: "gpt-build", reasoningEffort: "high" },
      plan: { modelId: "gpt-plan", reasoningEffort: "xhigh" }
    });
    const afterRestart = store.initializeCodexCliModeDefaults({
      build: { modelId: "gpt-other", reasoningEffort: "low" },
      plan: { modelId: "gpt-other-plan", reasoningEffort: "low" }
    });

    expect(afterRestart).toEqual(first);
  });
});
