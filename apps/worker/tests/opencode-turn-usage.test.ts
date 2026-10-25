import { describe, expect, it } from "vitest";
import { openCodeTurnUsage } from "../src/opencode-turn-usage.js";

describe("OpenCode assistant message usage", () => {
  it("maps OpenCode counters to the ledger's Codex meaning", () => {
    expect(openCodeTurnUsage({
      role: "assistant", providerID: "opencode", modelID: "big-pickle",
      tokens: { input: 1_200, output: 300, reasoning: 50, cache: { read: 8_000, write: 100 } }
    })).toEqual({
      // Cached input is part of input; reasoning is part of output.
      totals: { inputTokens: 9_300, cachedInputTokens: 8_000, outputTokens: 350, reasoningOutputTokens: 50, totalTokens: 9_650 },
      model: "opencode/big-pickle"
    });
  });

  it("treats missing cache and reasoning counters as zero and an unsafe model as unreported", () => {
    expect(openCodeTurnUsage({ role: "assistant", modelID: "m", providerID: "bad provider", tokens: { input: 10, output: 5 } }))
      .toEqual({ totals: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 }, model: null });
  });

  it("measures nothing for non-assistant, zero, negative or malformed counters", () => {
    expect(openCodeTurnUsage(null)).toBeNull();
    expect(openCodeTurnUsage({ role: "user", tokens: { input: 10, output: 5 } })).toBeNull();
    expect(openCodeTurnUsage({ role: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })).toBeNull();
    expect(openCodeTurnUsage({ role: "assistant", tokens: { input: -1, output: 5 } })).toBeNull();
    expect(openCodeTurnUsage({ role: "assistant", tokens: { input: "10", output: 5 } })).toBeNull();
    expect(openCodeTurnUsage({ role: "assistant", tokens: { input: 10, output: Number.NaN } })).toBeNull();
    expect(openCodeTurnUsage({ role: "assistant" })).toBeNull();
  });
});
