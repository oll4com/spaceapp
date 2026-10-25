import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { SpaceConflictError } from "@space/runtime";
import { createCodexLbSpeedDefaultsService } from "../src/codex-lb-speed-defaults.js";

const models = [
  {
    id: "provider-alpha",
    displayName: "Provider Alpha",
    isDefault: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["high"],
    reasoningOptions: [{ reasoningEffort: "high" }]
  },
  {
    id: "provider-beta",
    displayName: "Provider Beta",
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
    reasoningOptions: [{ reasoningEffort: "medium" }]
  }
];

function gatewayStore(repository = new InMemoryGatewayRepository()) {
  return {
    repository,
    store: {
      read: vi.fn(() => repository.speedDefaults()),
      set: vi.fn((modelId: string, tier: "standard" | "fast") => repository.setSpeedDefault(modelId, tier))
    }
  };
}

describe("Codex speed defaults on Space Gateway", () => {
  it("derives rows from the current provider catalog and the gateway's speed map", async () => {
    const { repository, store } = gatewayStore();
    await repository.setSpeedDefault("provider-alpha", "fast");
    const listModels = vi.fn(async () => models);
    const service = createCodexLbSpeedDefaultsService({ listModels, store, now: () => new Date("2026-07-17T08:00:03.000Z") });

    const read = await service.read();
    expect(read.models).toEqual([
      { modelId: "provider-alpha", displayName: "Provider Alpha", tier: "FAST" },
      { modelId: "provider-beta", displayName: "Provider Beta", tier: "STANDARD" }
    ]);
    expect(read.checkedAt).toBe("2026-07-17T08:00:03.000Z");
    const updated = await service.update("provider-beta", "FAST");

    expect(updated.models.map((model) => model.tier)).toEqual(["FAST", "FAST"]);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(store.set).toHaveBeenCalledWith("provider-beta", "fast");
    expect((await repository.speedDefaults()).models).toEqual({ "provider-alpha": "fast", "provider-beta": "fast" });
  });

  it("fails closed before writing when a model is absent from the current catalog", async () => {
    const { store } = gatewayStore();
    const service = createCodexLbSpeedDefaultsService({ listModels: async () => models, store });

    await expect(service.update("provider-removed", "FAST")).rejects.toBeInstanceOf(SpaceConflictError);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("reports the speed map as unavailable when the gateway store fails", async () => {
    const service = createCodexLbSpeedDefaultsService({
      listModels: async () => models,
      store: { read: async () => { throw new Error("database down"); }, set: async () => { throw new Error("database down"); } }
    });

    await expect(service.read()).rejects.toThrow("Codex speed defaults are unavailable.");
  });
});
