import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nousSeesRoom } from "../src/nous/wiring.js";

// DEV3D-007: a "Keep Nous out" room (docs/agents/room-nous-off.md) leaked into Nous's notices, owner waits and score.
describe("Nous's room filter", () => {
  it("leaves out archived, CLI recovery and Keep Nous out rooms", () => {
    const room = { archivedAt: null, kind: "WORKSPACE", nousExcluded: false } as const;
    expect(nousSeesRoom(room)).toBe(true);
    expect(nousSeesRoom({ ...room, nousExcluded: true })).toBe(false);
    expect(nousSeesRoom({ ...room, archivedAt: "2026-11-22T00:00:00.000Z" })).toBe(false);
    expect(nousSeesRoom({ ...room, kind: "CLI_RECOVERY" })).toBe(false);
  });

  it("is the only room-kind filter in the wiring, and its pane notices skip a Keep Nous out room", () => {
    const source = readFileSync(new URL("../src/nous/wiring.ts", import.meta.url), "utf8");
    // A second hand-written archived/CLI-recovery filter is how the switch leaked: every list goes through nousSeesRoom.
    expect(source.match(/CLI_RECOVERY/g)).toHaveLength(1);
    expect(source).toContain('if (room.kind === "AGENT_PROOF" || room.nousExcluded) return;');
    expect(source).toMatch(/const room = await store\.getRoom\(event\.roomId\);\n\s+if \(room\.nousExcluded\) return;/);
  });
});
