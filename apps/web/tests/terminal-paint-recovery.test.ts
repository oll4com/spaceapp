import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalPaintIsStale, watchTerminalPaint } from "../src/features/terminal-pane/terminal-paint-recovery.js";

function fixture() {
  const host = document.createElement("div");
  host.innerHTML = '<div class="xterm-rows"><div>history</div><div>Working</div></div>';
  document.body.append(host);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 400, height: 300 } as DOMRect);
  const events = { write: () => {}, render: () => {}, scroll: () => {} };
  const dispose = vi.fn();
  const lines = ["older", "history", "Working"];
  let concealed = false;
  const terminal = {
    rows: 2, cols: 80,
    modes: { synchronizedOutputMode: false },
    buffer: { active: { viewportY: 1, getLine: (y: number) => ({
      length: lines[y]!.length,
      translateToString: () => lines[y],
      getCell: (x: number) => ({ getChars: () => lines[y]![x], isInvisible: () => concealed })
    }) } },
    refresh: vi.fn(),
    onWriteParsed: (fn: () => void) => { events.write = fn; return { dispose }; },
    onRender: (fn: () => void) => { events.render = fn; return { dispose }; },
    onScroll: (fn: () => void) => { events.scroll = fn; return { dispose }; }
  };
  return { host, terminal: terminal as unknown as Terminal, refresh: terminal.refresh, events, dispose,
    conceal: () => { concealed = true; },
    eraseRow: () => host.querySelector(".xterm-rows")!.children[0]!.replaceChildren() };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("terminal paint recovery", () => {
  it("detects missing history even while the working row and grid remain intact", () => {
    const f = fixture();
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(false);
    f.eraseRow();
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(true);
  });

  it("detects stale nonempty rows and respects the scrolled viewport", () => {
    const f = fixture();
    f.host.querySelector(".xterm-rows")!.children[0]!.textContent = "old frame";
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(true);
    f.host.querySelector(".xterm-rows")!.children[0]!.textContent = "history";
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(false);
  });

  it("does not expose concealed text or interrupt synchronized output", () => {
    const f = fixture();
    f.conceal();
    Array.from(f.host.querySelector(".xterm-rows")!.children).forEach((row) => { row.textContent = " "; });
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(false);
    Object.assign(f.terminal.modes, { synchronizedOutputMode: true });
    f.host.querySelector(".xterm-rows")!.children[0]!.textContent = "old frame";
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(false);
  });

  it("leaves other renderers alone", () => {
    const f = fixture();
    f.host.replaceChildren(document.createElement("canvas"));
    expect(terminalPaintIsStale(f.terminal, f.host)).toBe(false);
  });

  it("coalesces bursts and repairs once through refresh without writing or resizing", () => {
    vi.useFakeTimers();
    const f = fixture();
    const watcher = watchTerminalPaint(f.terminal, f.host, () => true);
    f.eraseRow();
    for (let i = 0; i < 100; i += 1) { f.events.write(); f.events.render(); }
    vi.advanceTimersByTime(249);
    expect(f.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(0, 1);
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("lets the native renderer settle without an unnecessary refresh", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.eraseRow();
    const watcher = watchTerminalPaint(f.terminal, f.host, () => true);
    f.events.write();
    f.host.querySelector(".xterm-rows")!.children[0]!.textContent = "history";
    f.events.render();
    vi.advanceTimersByTime(1000);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    watcher.dispose();
  });

  it("skips hidden and minimized panes and cancels pending work on disposal", () => {
    vi.useFakeTimers();
    const f = fixture();
    let visible = true;
    const watcher = watchTerminalPaint(f.terminal, f.host, () => visible);
    f.eraseRow();
    visible = false;
    vi.advanceTimersByTime(500);
    f.events.write();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.refresh).not.toHaveBeenCalled();
    visible = true;
    f.events.render();
    watcher.dispose();
    vi.advanceTimersByTime(500);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(3);
  });
});
