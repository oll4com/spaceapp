import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const terminalPaneSource = readFileSync(resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"), "utf8");

describe("terminal asset loading", () => {
  it("loads xterm styles with the deferred terminal runtime instead of the app entry", () => {
    expect(terminalPaneSource).not.toMatch(/^import\s+["']@xterm\/xterm\/css\/xterm\.css["'];?$/m);
    expect(terminalPaneSource).toContain('import("@xterm/xterm/css/xterm.css")');
  });
});
