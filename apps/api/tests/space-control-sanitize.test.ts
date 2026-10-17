import { describe, expect, it } from "vitest";
import { sanitizeControlExecute } from "../src/space-control-routes.js";

describe("Space Control action normalizer", () => {
  it("drops the zero counts a model lists beside the pane type it wants", () => {
    // Live's 2026-10-15 "open two Claude panes" failed: every other type came with 0 and the schema needs >= 1.
    const out = sanitizeControlExecute({ roomId: "room:a", requestId: "live:1", actions: [{ kind: "resource", operation: "panes.open",
      input: { counts: { codex: 0, "claude code": 2, gemini: -1, opencode: 1.6 } } }] }) as { actions: Array<{ input: { counts: Record<string, number> } }> };
    expect(out.actions[0]!.input.counts).toEqual({ claude: 2, opencode: 1 });
  });
});
