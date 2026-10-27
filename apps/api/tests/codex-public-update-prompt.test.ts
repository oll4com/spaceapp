import { describe, expect, it } from "vitest";
import { buildCliSpawnArgs } from "../src/cli-terminal.js";

// 1.1.7 (task:xY6KPcDLwGL9): a public install pins Codex in its image; Codex 0.145.0's own "Update available" menu
// blocked a pane's start in the 1.1.6 lab, so public installs start Codex with its update check off.
const codex = { id: "cli:codex", commandName: "codex-vscode-parity" } as never;
const off = ["--config", "check_for_update_on_startup=false"];
const thread = "019f4434-0000-7000-8000-000000000117";

describe("Codex update check on public installs", () => {
  it("is off for every Codex start of a public install: its own default, a pane selection and a resume", () => {
    const options = { codexChoosesDefaults: true, publicDistribution: true };
    expect(buildCliSpawnArgs(codex, { codexThreadId: null, modelId: null, reasoningEffort: null }, options))
      .toEqual([...off, "--no-alt-screen"]);
    expect(buildCliSpawnArgs(codex, { codexThreadId: null, modelId: "gpt-5-mini", reasoningEffort: "high" }, options))
      .toEqual(["--model", "gpt-5-mini", "--config", "model_reasoning_effort=high", ...off, "--no-alt-screen"]);
    expect(buildCliSpawnArgs(codex, { codexThreadId: thread, modelId: null, reasoningEffort: null }, options))
      .toEqual(["resume", ...off, "--no-alt-screen", thread]);
  });

  it("leaves stable and dev Codex starts unchanged", () => {
    expect(buildCliSpawnArgs(codex, { codexThreadId: null, modelId: "gpt-5-mini", reasoningEffort: "high" }))
      .toEqual(["--model", "gpt-5-mini", "--config", "model_reasoning_effort=high", "--no-alt-screen"]);
    expect(buildCliSpawnArgs(codex, { codexThreadId: thread, modelId: null, reasoningEffort: null }))
      .toEqual(["resume", "--no-alt-screen", thread]);
  });
});
