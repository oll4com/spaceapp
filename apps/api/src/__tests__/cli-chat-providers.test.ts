import { describe, expect, it } from "vitest";
import {
  cliChatRuntimeName,
  cliRuntimeModelsChatProviderAdapter,
  opencodeChatProviderAdapter
} from "../chat-providers.js";
import type { OpenCodeServerControl } from "@space/opencode-control";

const openCodeControl: OpenCodeServerControl = {
  version: 1,
  spaceSessionId: "space-shared",
  nativeSessionId: "ses_catalog",
  serverPort: 47047,
  serverHost: "10.254.240.13",
  serverUsername: "space",
  serverPassword: "secret",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

describe("OpenCode Chat native model catalog", () => {
  it("advertises configured Zen and Go models with their native reasoning options", async () => {
    const adapter = opencodeChatProviderAdapter(
      async () => openCodeControl,
      async () => [
        { providerId: "opencode", providerName: "OpenCode Zen", modelId: "nemotron-3-ultra-free", displayName: "Nemotron 3 Ultra Free", variants: [], defaultVariant: null },
        { providerId: "opencode-go", providerName: "OpenCode Go", modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", variants: ["high", "max"], defaultVariant: "max" },
        { providerId: "opencode-go", providerName: "OpenCode Go", modelId: "qwen3.7-plus", displayName: "Qwen3.7 Plus", variants: ["minimal", "high"], defaultVariant: null }
      ]
    );

    const result = await adapter.loadCatalog();

    expect(result.error).toBeNull();
    expect(result.current).toBeNull();
    expect(result.models.map(model => model.id)).toEqual([
      "opencode/nemotron-3-ultra-free", "opencode-go/deepseek-v4-pro", "opencode-go/qwen3.7-plus"
    ]);
    expect(result.models[0]).toMatchObject({
      displayName: "Nemotron 3 Ultra Free", description: "OpenCode Zen", isDefault: true,
      supportedReasoningEfforts: ["medium"], reasoningOptions: []
    });
    expect(result.models[1]).toMatchObject({
      description: "OpenCode Go", isDefault: false, defaultReasoningEffort: "max",
      supportedReasoningEfforts: ["high", "max"],
      reasoningOptions: [{ reasoningEffort: "high" }, { reasoningEffort: "max" }]
    });
    expect(result.models[2]!.defaultReasoningEffort).toBe("minimal");
  });

  it("picks up newly advertised models without a Chat allowlist update", async () => {
    const adapter = opencodeChatProviderAdapter(
      async () => openCodeControl,
      async () => [{ providerId: "opencode", modelId: "new-model", displayName: "New model", variants: [], defaultVariant: null }]
    );
    const result = await adapter.loadCatalog();
    expect(result.error).toBeNull();
    expect(result.models.map(model => model.id)).toEqual(["opencode/new-model"]);
  });

  it("reports an empty native catalog without inventing model options", async () => {
    const adapter = opencodeChatProviderAdapter(async () => openCodeControl, async () => []);
    const result = await adapter.loadCatalog();
    expect(result.models).toEqual([]);
    expect(result.error).toBe("OpenCode did not advertise any available models.");
  });

  it("reports catalog failures and does not fall back to a stale model", async () => {
    const adapter = opencodeChatProviderAdapter(async () => openCodeControl, async () => { throw new Error("Catalog unavailable"); });
    expect(await adapter.loadCatalog()).toEqual({ models: [], current: null, error: "Catalog unavailable" });
  });
});

describe("cliChatRuntimeName", () => {
  it("provides display names for every chat CLI runtime", () => {
    expect(cliChatRuntimeName("cli:kimi")).toBe("Kimi Code");
    expect(cliChatRuntimeName("cli:claude")).toBe("Claude Code");
    expect(cliChatRuntimeName("cli:qwen")).toBe("Qwen Code");
    expect(cliChatRuntimeName("cli:grok")).toBe("Grok");
    expect(cliChatRuntimeName("cli:autohand")).toBe("Autohand");
    expect(cliChatRuntimeName("cli:hermes")).toBe("Hermes");
  });
});

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
