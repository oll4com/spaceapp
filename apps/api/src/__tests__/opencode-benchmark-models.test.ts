import { describe, expect, it } from "vitest";
import { loadOpenCodeBenchmarkModels, openCodeModelsForProvider } from "../opencode-benchmark-models.js";
import { CHESS_CLI_PROVIDERS } from "../chess/chess-cli.js";
import { cliContestants, cliModelArgument, isOpencodeProvider } from "../chess/chess-players.js";
import { loadArenaModelCatalog } from "../benchmark-routes.js";

describe("OpenCode & Space Gateway Benchmark Models", () => {
  it("loads OpenCode models including all Space Gateway pools", async () => {
    const catalog = await loadOpenCodeBenchmarkModels();
    expect(catalog.size).toBeGreaterThanOrEqual(10);
    expect(catalog.has("opencode")).toBe(true);
    expect(catalog.has("space-gateway-claude")).toBe(true);
    expect(catalog.has("space-gateway-nvidia")).toBe(true);
    expect(catalog.has("space-gateway-gemini")).toBe(true);

    const opencodeModels = catalog.get("opencode")!;
    expect(opencodeModels.length).toBeGreaterThanOrEqual(12);
    expect(opencodeModels.some((m) => m.id === "opencode/big-pickle")).toBe(true);

    const nvidiaModels = catalog.get("space-gateway-nvidia")!;
    expect(nvidiaModels.length).toBeGreaterThanOrEqual(5);
    expect(nvidiaModels.some((m) => m.id.includes("nemotron"))).toBe(true);
  });

  it("retrieves models for a specific provider via openCodeModelsForProvider", async () => {
    const claudeModels = await openCodeModelsForProvider("space-gateway-claude");
    expect(claudeModels.length).toBeGreaterThanOrEqual(4);
    expect(claudeModels.some((m) => m.id === "space-gateway-claude/claude-sonnet-5-5")).toBe(true);
    expect(claudeModels[0]!.efforts).toContain("low");
  });

  it("registers Space Gateway providers in CHESS_CLI_PROVIDERS", () => {
    const ids = CHESS_CLI_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("space-gateway-claude");
    expect(ids).toContain("space-gateway-nvidia");
    expect(ids).toContain("space-gateway-groq");
    expect(ids).toContain("space-gateway-mistral");
    expect(ids).toContain("space-gateway-adaption");
    expect(ids).toContain("space-gateway-amd");
    expect(ids).toContain("space-gateway-ovh");
    expect(ids).toContain("space-gateway-gemini");
    expect(ids).toContain("space-gateway-cloudflare");
    expect(ids).toContain("space-gateway-zai");
    expect(ids).toContain("space-gateway-inception");
    expect(ids).toContain("space-gateway-freeai");

    const spec = CHESS_CLI_PROVIDERS.find((p) => p.id === "space-gateway-gemini")!;
    expect(spec.runtimeId).toBe("cli:opencode");
    expect(spec.catalog).toBe("opencode");
  });

  it("formats contestants and cliModelArgument correctly for opencode providers", () => {
    const spec = CHESS_CLI_PROVIDERS.find((p) => p.id === "space-gateway-gemini")!;
    const models = [
      { id: "space-gateway-gemini/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", efforts: ["default"] },
    ];
    const contestants = cliContestants(spec, models);
    expect(contestants).toHaveLength(1);
    expect(contestants[0]!.id).toBe("space-gateway-gemini/gemini-3.5-flash-lite@default");
    expect(contestants[0]!.providerId).toBe("space-gateway-gemini");
    expect(contestants[0]!.modelId).toBe("space-gateway-gemini/gemini-3.5-flash-lite");

    expect(isOpencodeProvider("space-gateway-gemini")).toBe(true);
    expect(isOpencodeProvider("opencode")).toBe(true);
    expect(isOpencodeProvider("claude")).toBe(false);

    expect(cliModelArgument(contestants[0]!)).toBe("space-gateway-gemini/gemini-3.5-flash-lite");
  });

  it("serves all Space Gateway and OpenCode models in loadArenaModelCatalog", async () => {
    const arenaCatalog = await loadArenaModelCatalog();
    expect(arenaCatalog.available).toBe(true);
    const providerIds = new Set(arenaCatalog.models.map((m) => m.providerId));
    expect(providerIds.has("opencode")).toBe(true);
    expect(providerIds.has("space-gateway-claude")).toBe(true);
    expect(providerIds.has("space-gateway-nvidia")).toBe(true);
    expect(providerIds.has("space-gateway-gemini")).toBe(true);

    const modelIds = new Set(arenaCatalog.models.map((m) => m.id));
    expect(modelIds.has("opencode/big-pickle")).toBe(true);
    expect(modelIds.has("space-gateway-claude/claude-sonnet-5-5")).toBe(true);
  });
});
