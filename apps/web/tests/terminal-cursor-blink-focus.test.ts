import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Nous 10/11 (operator lag, Warm-approved): every terminal shows a solid cursor. xterm 6 blinks only the focused terminal,
// but that one CSS blink alone kept the renderer at a 60 fps style recalc (headless: ~53% -> 38% of a core).
describe("terminal cursor", () => {
  it("does not blink in any terminal", () => {
    const source = readFileSync(resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"), "utf8");
    expect(source).toContain("cursorBlink: false,");
    expect(source).not.toContain("cursorBlink: true");
  });
});
