import { describe, expect, it } from "vitest";
import { openCode2VerboseModel } from "../src/opencode-model-bench.js";

describe("OpenCode model bench on OpenCode 2", () => {
  it("reads an /api/model entry as the v1 verbose model the bench lists", () => {
    // Entry recorded from OpenCode 2.0.31 (2026-10-16).
    expect(openCode2VerboseModel({
      id: "deepseek-v4.1-flash-free", modelID: "deepseek-v4.1-flash-free", providerID: "opencode", family: "deepseek-flash",
      name: "DeepSeek V4.1 Flash Free", package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/inference/openai/v1" },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: true },
      variants: [{ id: "low" }, { id: "high" }], time: { released: 1_788_998_400_000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: "active", enabled: true, limit: { context: 200_000, output: 32_000 }
    })).toEqual({
      id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", family: "deepseek-flash", status: "active",
      api: { id: "deepseek-v4.1-flash-free", url: "https://opencode.ai/inference/openai/v1", npm: "@opencode/ai/providers/openai-compatible" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200_000, output: 32_000 },
      capabilities: { temperature: true, reasoning: true, toolcall: true, input: { text: true, image: true }, output: { text: true } }
    });
  });
});
