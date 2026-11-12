import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Terminal } from "@xterm/xterm";

// Operator PC 28/10-10/11, Warm-approved 11/11: 15 TypeErrors "reading 'dimensions'" from scrollToBottom() in a write callback after the pane closed.
describe("terminal write callback after dispose", () => {
  it("xterm still runs the callback after dispose, and scrolling there throws", async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const host = document.createElement("div");
    document.body.append(host);
    const terminal = new Terminal({ cols: 80, rows: 20 });
    terminal.open(host);
    const thrown = await new Promise<unknown>((settle) => {
      terminal.write("x".repeat(100), () => {
        try { terminal.scrollToBottom(); settle(null); } catch (error) { settle(error); }
      });
      terminal.dispose();
    });
    expect(thrown).toBeInstanceOf(TypeError);
    host.remove();
  });

  it("the replay writer stops before scrolling a disposed terminal", () => {
    const source = readFileSync(resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"), "utf8");
    const callback = source.slice(source.indexOf("replayTerminal.write(chunk, () => {"));
    expect(callback.indexOf("if (disposed) { done(); return; }")).toBeGreaterThan(0);
    expect(callback.indexOf("if (disposed) { done(); return; }")).toBeLessThan(callback.indexOf("replayTerminal.scrollToBottom()"));
  });
});
