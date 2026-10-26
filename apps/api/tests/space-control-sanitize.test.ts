import { describe, expect, it } from "vitest";
import { sanitizeControlExecute } from "../src/space-control-routes.js";

describe("Space Control action normalizer", () => {
  it("drops the zero counts a model lists beside the pane type it wants", () => {
    // Live's 2026-10-15 "open two Claude panes" failed: every other type came with 0 and the schema needs >= 1.
    const out = sanitizeControlExecute({ roomId: "room:a", requestId: "live:1", actions: [{ kind: "resource", operation: "panes.open",
      input: { counts: { codex: 0, "claude code": 2, gemini: -1, opencode: 1.6 } } }] }) as { actions: Array<{ input: { counts: Record<string, number> } }> };
    expect(out.actions[0]!.input.counts).toEqual({ claude: 2, opencode: 1 });
  });

  it("takes a pane type with a count as counts, and a moved pane's id from its input (daily review 2026-10-24)", () => {
    const out = sanitizeControlExecute({ roomId: "room:a", requestId: "nous:1", actions: [
      { kind: "resource", operation: "panes.open", input: { type: "vnc" } },
      { kind: "resource", operation: "panes.open", input: { type: "Claude Code", count: 2, model: "claude-opus-5-5" } },
      { kind: "resource", operation: "panes.move", input: { paneId: "pane:b", targetRoomId: "room:c" } }] }) as { actions: Array<{ id?: string; input: Record<string, unknown> }> };
    expect(out.actions.map((action) => action.input)).toEqual([{ counts: { vnc: 1 } }, { counts: { claude: 2 }, model: "claude-opus-5-5" },
      { paneId: "pane:b", targetRoomId: "room:c" }]);
    expect(out.actions[2]!.id).toBe("pane:b");
  });
});
