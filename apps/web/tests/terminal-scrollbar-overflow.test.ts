import { describe, expect, it } from "vitest";
import {
  checkHasScrollbackContent,
  clearTerminalViewportEvidence,
  syncTerminalViewportEvidence
} from "../src/features/terminal-pane/TerminalPane.js";

describe("terminal scrollbar overflow and scrollback evidence", () => {
  it("does not invalidate DOM styles when viewport evidence is unchanged", () => {
    const host = document.createElement("div");
    const terminal = { rows: 24, buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0 } } } as any;
    const observer = new MutationObserver(() => {});
    observer.observe(host, { attributes: true });
    syncTerminalViewportEvidence(host, terminal);
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    syncTerminalViewportEvidence(host, terminal);
    expect(observer.takeRecords()).toHaveLength(0);
    terminal.buffer.active.cursorY = 1;
    syncTerminalViewportEvidence(host, terminal);
    expect(host.dataset.terminalCursorY).toBe("1");
    expect(observer.takeRecords().map(record => record.attributeName).sort()).toEqual([
      "data-terminal-cursor-absolute-y", "data-terminal-cursor-y"
    ]);
    observer.disconnect();
  });

  it("determines scrollback presence accurately based on actual content", () => {
    // 1. baseY <= 0 has no scrollback
    expect(checkHasScrollbackContent({} as any, 0)).toBe(false);
    expect(checkHasScrollbackContent({} as any, -1)).toBe(false);

    // 2. baseY > 0 but scrollback contains only blank lines (e.g. fresh Codex CLI banner wrap)
    const emptyLinesBuffer = {
      getLine(y: number) {
        return {
          translateToString() {
            return y === 0 ? "" : "   ";
          }
        };
      }
    } as any;
    expect(checkHasScrollbackContent(emptyLinesBuffer, 1)).toBe(false);
    expect(checkHasScrollbackContent(emptyLinesBuffer, 2)).toBe(false);

    // 3. baseY > 0 with real text in scrollback
    const contentBuffer = {
      getLine(y: number) {
        return {
          translateToString() {
            return y === 0 ? "OpenAI Codex" : "";
          }
        };
      }
    } as any;
    expect(checkHasScrollbackContent(contentBuffer, 1)).toBe(true);

    // 4. Large baseY (> 50) always returns true
    expect(checkHasScrollbackContent(emptyLinesBuffer, 51)).toBe(true);
  });

  it("syncs terminalHasScrollback dataset attribute to prevent unwanted scrollbar in fresh panes", () => {
    const host = document.createElement("div");

    // Case A: Fresh terminal with baseY = 0
    const terminalZero = {
      rows: 24,
      buffer: {
        active: {
          viewportY: 0,
          baseY: 0,
          cursorY: 0,
          getLine: () => undefined
        }
      }
    } as any;
    syncTerminalViewportEvidence(host, terminalZero);
    expect(host.dataset.terminalHasScrollback).toBe("false");
    expect(host.dataset.terminalAtBottom).toBe("true");

    // Case B: Fresh Codex CLI pane where initial banner wrap pushed 1 blank line into scrollback
    const terminalFreshCodex = {
      rows: 21,
      buffer: {
        active: {
          viewportY: 1,
          baseY: 1,
          cursorY: 16,
          getLine(y: number) {
            return {
              translateToString() {
                return ""; // Line 0 is empty
              }
            };
          }
        }
      }
    } as any;
    syncTerminalViewportEvidence(host, terminalFreshCodex);
    // Crucial: Must be "false" so CSS hides the vertical scrollbar slider on fresh panes!
    expect(host.dataset.terminalHasScrollback).toBe("false");
    expect(host.dataset.terminalAtBottom).toBe("true");

    // Case C: User scrolls up into the buffer
    const terminalScrolledUp = {
      rows: 21,
      buffer: {
        active: {
          viewportY: 0,
          baseY: 1,
          cursorY: 16,
          getLine: () => ({ translateToString: () => "" })
        }
      }
    } as any;
    syncTerminalViewportEvidence(host, terminalScrolledUp);
    expect(host.dataset.terminalHasScrollback).toBe("true");
    expect(host.dataset.terminalAtBottom).toBe("false");

    // Case D: Real output with scrollback content at the bottom
    const terminalWithContent = {
      rows: 21,
      buffer: {
        active: {
          viewportY: 10,
          baseY: 10,
          cursorY: 5,
          getLine(y: number) {
            return {
              translateToString() {
                return `output line ${y}`;
              }
            };
          }
        }
      }
    } as any;
    syncTerminalViewportEvidence(host, terminalWithContent);
    expect(host.dataset.terminalHasScrollback).toBe("true");
    expect(host.dataset.terminalAtBottom).toBe("true");

    // Clear evidence
    clearTerminalViewportEvidence(host);
    expect(host.dataset.terminalHasScrollback).toBeUndefined();
    expect(host.dataset.terminalBaseY).toBeUndefined();
  });
});
