import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldRequestTerminalControl } from "../src/features/terminal-pane/TerminalPane.js";

const shown = { isVisible: true, isMinimized: false, documentVisibility: "visible" as const, documentHasFocus: true };

// Plan NtzEOzE3Ew00 step 21: a room switch shows every pane of the room; only the focused pane, or one whose PTY lacks its grid, asks for the lease.
describe("shouldRequestTerminalControl", () => {
  it("lets a shown pane ask on its own only when it holds focus or its grid is unsent", () => {
    expect(shouldRequestTerminalControl({ ...shown, automatic: false })).toBe(false);
    expect(shouldRequestTerminalControl({ ...shown, automatic: true })).toBe(true);
  });

  it("keeps real interaction requests as they were", () => {
    expect(shouldRequestTerminalControl({ ...shown, automatic: false, realInteraction: true })).toBe(true);
    expect(shouldRequestTerminalControl({ ...shown, automatic: false, documentHasFocus: false, realInteraction: true })).toBe(true);
  });

  it("never asks for a hidden, minimized or read-only pane, nor on its own in a background page", () => {
    expect(shouldRequestTerminalControl({ ...shown, automatic: true, isVisible: false, realInteraction: true })).toBe(false);
    expect(shouldRequestTerminalControl({ ...shown, automatic: true, isMinimized: true, realInteraction: true })).toBe(false);
    expect(shouldRequestTerminalControl({ ...shown, automatic: true, readOnly: true, realInteraction: true })).toBe(false);
    expect(shouldRequestTerminalControl({ ...shown, automatic: true, documentHasFocus: false })).toBe(false);
    expect(shouldRequestTerminalControl({ ...shown, automatic: true, documentVisibility: "hidden" })).toBe(false);
  });

  it("lets the layout effect a room switch runs ask only through the gate (base-F-5 CONTROL-001 was still 192)", () => {
    const source = readFileSync(resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"), "utf8");
    const effect = /useEffect\(\(\) => \{\n\s*ensureTerminalControl\((\w*)\);\n\s*const coordinator = terminalGeometryCoordinatorRef\.current;/.exec(source);
    expect(effect?.[1]).toBe("");
  });
});
