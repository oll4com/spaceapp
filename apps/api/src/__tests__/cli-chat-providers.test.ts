import { describe, expect, it } from "vitest";
import { cliRuntimeModelsChatProviderAdapter } from "../chat-providers.js";

describe("cliRuntimeModelsChatProviderAdapter", () => {
  it("parses 2-column TSV (gemini/cursor format) with single none effort", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:gemini",
      executeModels: async () => [
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)"
      ].join("\n"),
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const result = await adapter.loadCatalog();
    expect(result.error).toBeNull();
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      id: "gemini-3.7-flash-high",
      displayName: "Gemini 3.7 Flash (High)",
      isDefault: true,
      defaultReasoningEffort: "none",
      supportedReasoningEfforts: ["none"]
    });
  });

  it("parses 4-column TSV (copilot/deepseek format) with reasoning efforts", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:deepseek",
      executeModels: async () => [
        "deepseek-pro/deepseek-v4-pro\tDeepSeek V4 Pro\tdisabled,high,max\thigh",
        "deepseek-flash/deepseek-v4-flash\tDeepSeek V4 Flash\tdisabled,low,high,max\thigh"
      ].join("\n"),
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const result = await adapter.loadCatalog();
    expect(result.error).toBeNull();
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      id: "deepseek-pro/deepseek-v4-pro",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["disabled", "high", "max"]
    });
    expect(result.models[1]!.supportedReasoningEfforts).toEqual(["disabled", "low", "high", "max"]);
  });

  it("parses copilot auto + built-in catalog with effort choices", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:copilot",
      executeModels: async () => [
        "auto\tAuto\t\t",
        "claude-sonnet-4.6\tClaude Sonnet 4.6\tnone,minimal,low,medium,high,xhigh,max\t"
      ].join("\n"),
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const result = await adapter.loadCatalog();
    expect(result.error).toBeNull();
    expect(result.models[0]).toMatchObject({ id: "auto", isDefault: true, defaultReasoningEffort: "none" });
    expect(result.models[1]!.supportedReasoningEfforts).toEqual([
      "none", "minimal", "low", "medium", "high", "xhigh", "max"
    ]);
  });

  it("skips invalid model ids and empty lines", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:copilot",
      executeModels: async () => "\n\nbad id with space\tName\n\tMissingId\nok-model\tOK Model\n",
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const result = await adapter.loadCatalog();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.id).toBe("ok-model");
  });

  it("returns an error when the runtime is disabled", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:cursor",
      executeModels: async () => { throw new Error("should not be called"); },
      resolveState: async () => ({ enabled: false, reason: "Cursor is not available." })
    });
    const result = await adapter.loadCatalog();
    expect(result.models).toEqual([]);
    expect(result.error).toBe("Cursor is not available.");
  });

  it("returns an error for an empty catalog", async () => {
    const adapter = cliRuntimeModelsChatProviderAdapter({
      runtimeId: "cli:cursor",
      executeModels: async () => "",
      resolveState: async () => ({ enabled: true, reason: null })
    });
    const result = await adapter.loadCatalog();
    expect(result.models).toEqual([]);
    expect(result.error).toBe("cli:cursor model catalog is unavailable.");
  });
});
