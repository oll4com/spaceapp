import { describe, expect, it } from "vitest";
import { heldToolFailures, historicalToolHold } from "../src/nous/tool-holds.js";

/** Daily Nous errors 27/11: the 23/11 space_cli_update failures whose causes are fixed on dev (b77fa171da, a100c3a384, e03c918045). */
describe("Nous errors 27/11: space_cli_update", () => {
  const kimi = "CLI update of every managed CLI: FAIL (12 checked): Kimi Code CLI UPDATE_FAILED_ROLLED_BACK: Kimi Code CLI update failed (Kimi Code stable release asset ids are invalid.); the previous current versio…";
  const zod = (scope: string) => `The update of ${scope} failed: [ { "code": "invalid_value", "values": [ "cli:codex", "cli:claude", "cli:gemini", "cli:opencode", "cli:autohand", "cli:qwen", "cli:kimi", "cli:grok", "cli:deep…`;

  it("holds the fixed causes and nothing else", () => {
    expect(heldToolFailures("space_cli_update", { calls: 4, failed: 2, refused: 0, errors: [zod("every managed CLI"), zod("cli:harness")] })).toBe(2);
    expect(historicalToolHold("space_cli_update", kimi)).toBe(true);
    expect(historicalToolHold("space_cli_update", kimi.replace("asset ids are invalid", "download timed out"))).toBe(false);
    expect(historicalToolHold("space_cli_update", "CLI update of every managed CLI: FAIL (12 checked): Codex CLI UPDATE_FAILED_ROLLED_BACK: …")).toBe(false);
    expect(historicalToolHold("space_cli_update", zod("every managed CLI").replace("cli:deep…", "cli:harness\" ] } ]"))).toBe(false);
  });
});
