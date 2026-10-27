import { describe, expect, it } from "vitest";
import { buildCliEnvironment } from "../src/cli-terminal.js";
import { findCliRuntimeDescriptor } from "../src/cli-runtime-descriptors.js";
import { getApiConfig } from "../src/config.js";

describe("pane model pick at CLI launch", () => {
  const config = getApiConfig({});

  it.each(["cli:qwen", "cli:kimi", "cli:grok", "cli:deepseek", "cli:copilot", "cli:omp", "cli:qoder", "cli:hermes", "cli:droid", "cli:muse"])(
    "starts %s on the pane's own model and effort",
    (runtimeId) => {
      const env = buildCliEnvironment(config, { runtimeId, modelId: "provider/picked-model", reasoningEffort: "high" });
      expect(env.SPACE_CLI_MODEL_ID).toBe("provider/picked-model");
      expect(env.SPACE_CLI_REASONING_EFFORT).toBe("high");
    }
  );

  it("never pins the runtime's generic default as if the pane had chosen it", () => {
    const fallback = findCliRuntimeDescriptor("cli:grok")!.defaultModelId;
    const env = buildCliEnvironment(config, { runtimeId: "cli:grok", modelId: fallback, reasoningEffort: "high" });
    expect(env.SPACE_CLI_MODEL_ID).toBeUndefined();
    expect(env.SPACE_CLI_REASONING_EFFORT).toBeUndefined();
  });

  it("starts Oh My Pi on Space's default too, so its own config default never decides", () => {
    const fallback = findCliRuntimeDescriptor("cli:omp")!.defaultModelId;
    const env = buildCliEnvironment(config, { runtimeId: "cli:omp", modelId: fallback, reasoningEffort: "high" });
    expect(env.SPACE_CLI_MODEL_ID).toBe("space-gateway/gpt-6-sol");
    expect(env.SPACE_CLI_REASONING_EFFORT).toBe("high");
  });

  it("leaves Codex, Claude, Gemini and catalog-family runtimes on their own launch paths", () => {
    for (const runtimeId of ["cli:codex", "cli:claude", "cli:gemini", "cli:cursor", "cli:opencode"]) {
      expect(buildCliEnvironment(config, { runtimeId, modelId: "provider/picked-model" }).SPACE_CLI_MODEL_ID, runtimeId).toBeUndefined();
    }
  });
});
