import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizePresentation } from "../src/features/terminal-pane/terminal-resize-presentation.js";

function fixture() {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.innerHTML = '<div class="xterm"><div class="xterm-viewport"></div><div class="xterm-screen"><div class="xterm-rows"><div>previous frame</div></div></div></div>';
  document.body.appendChild(host);
  let eligible = true;
  const parsed = new Set<() => void>();
  const rendered = new Set<() => void>();
  const terminal = {
    modes: { synchronizedOutputMode: false },
    onWriteParsed(listener: () => void) { parsed.add(listener); return { dispose: () => parsed.delete(listener) }; },
    onRender(listener: () => void) { rendered.add(listener); return { dispose: () => rendered.delete(listener) }; }
  };
  const presentation = createTerminalResizePresentation(host, () => terminal, () => eligible);
  return {
    host, terminal, presentation,
    overlay: () => host.querySelector<HTMLElement>("[data-terminal-resize-frame]"),
    parse: (text = "resized frame") => {
      const row = document.createElement("div");
      row.textContent = text;
      host.querySelector(".xterm-screen .xterm-rows")!.replaceChildren(row);
      parsed.forEach(listener => listener());
    },
    render: () => rendered.forEach(listener => listener()),
    hide: () => { eligible = false; document.dispatchEvent(new Event("visibilitychange")); }
  };
}

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("resize frame presentation", () => {
  it("does not mistake the local resize paint for a delayed CLI response", () => {
    const f = fixture();
    f.presentation.begin();
    f.render(); // fit/refresh paints immediately, before the PTY receives resize.
    vi.advanceTimersByTime(300);
    expect(f.overlay()?.textContent).toBe("previous frame");
    f.parse(); f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).toBeNull();
    f.presentation.dispose();
  });

  it("waits for output from a second resize while keeping the original deadline", () => {
    const f = fixture();
    f.presentation.begin();
    f.parse(); f.render();
    vi.advanceTimersByTime(100);
    f.presentation.begin();
    f.render();
    vi.advanceTimersByTime(300);
    expect(f.overlay()).not.toBeNull();
    vi.advanceTimersByTime(600);
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("releases at the deadline when the CLI produces no resize output", () => {
    const f = fixture();
    f.presentation.begin();
    f.render();
    vi.advanceTimersByTime(1000);
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("retains a cursor-only prelude and blank redraw, but bounds a stalled CLI", () => {
    const f = fixture();
    f.presentation.begin();
    f.render();
    f.parse("previous frame"); f.render();
    vi.advanceTimersByTime(500);
    expect(f.overlay()).not.toBeNull();
    f.parse(""); f.render();
    vi.advanceTimersByTime(1000);
    expect(f.overlay()).not.toBeNull();
    vi.advanceTimersByTime(3500);
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("reveals a completed repaint even when its text matches the old frame", () => {
    const f = fixture();
    f.presentation.begin();
    f.render();
    f.parse(""); f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).not.toBeNull();
    f.parse("previous frame"); f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).toBeNull();
    f.presentation.dispose();
  });

  it.each(["pointerdown", "wheel", "keydown", "beforeinput", "paste", "copy"])("releases immediately for %s without consuming the event", eventName => {
    const f = fixture();
    f.presentation.begin();
    expect(f.overlay()?.textContent).toBe("previous frame");
    const event = new Event(eventName, { bubbles: true, cancelable: true });
    f.host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("bounds continuous output and repeated resize holds", () => {
    const f = fixture();
    f.presentation.begin();
    for (let n = 0; n < 52; n += 1) {
      f.parse(`stream frame ${n}`); f.render();
      if (n < 8) f.presentation.begin();
      vi.advanceTimersByTime(100);
    }
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("waits for rendering after parsing and for synchronized output to end", () => {
    const f = fixture();
    f.presentation.begin();
    f.parse();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).not.toBeNull();
    f.terminal.modes.synchronizedOutputMode = true;
    f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).not.toBeNull();
    f.terminal.modes.synchronizedOutputMode = false;
    f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).toBeNull();
    f.presentation.dispose();
  });

  it.each(["hide", "cancel", "dispose"] as const)("cleans timers and the held viewport on %s", action => {
    const f = fixture();
    f.presentation.begin();
    if (action === "hide") f.hide();
    else f.presentation[action]();
    expect(f.overlay()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    f.parse(); f.render();
    expect(vi.getTimerCount()).toBe(0);
    f.presentation.dispose();
  });

  it("leaves the live renderer measurable and keeps a single inaccessible viewport copy", () => {
    const f = fixture();
    f.presentation.begin();
    const liveRows = f.host.querySelector(".xterm-screen .xterm-rows")!;
    liveRows.textContent = "updated live output";
    f.presentation.begin();
    expect(f.host.querySelectorAll("[data-terminal-resize-frame]")).toHaveLength(1);
    expect(f.host.querySelector(".xterm-rows")?.textContent).toBe("updated live output");
    expect(f.overlay()?.textContent).toBe("previous frame");
    expect(f.overlay()?.getAttribute("aria-hidden")).toBe("true");
    expect(f.overlay()?.style.pointerEvents).toBe("none");
    f.presentation.dispose();
  });

  it("retains the previous frame when a CLI emits only an initial prompt line and delays history reconstruction", () => {
    const f = fixture();
    const rowsContainer = f.host.querySelector(".xterm-screen .xterm-rows")!;
    rowsContainer.replaceChildren(
      ...["line 1", "line 2", "line 3", "line 4", "line 5"].map(t => {
        const d = document.createElement("div");
        d.textContent = t;
        return d;
      })
    );
    f.presentation.begin();
    f.render();
    vi.advanceTimersByTime(100);
    expect(f.overlay()).not.toBeNull();
    // CLI erases screen on SIGWINCH
    f.parse(""); f.render();
    vi.advanceTimersByTime(100);
    expect(f.overlay()).not.toBeNull();
    // CLI emits 1-line prompt bar and pauses while formatting markdown/history
    f.parse("prompt line"); f.render();
    vi.advanceTimersByTime(250);
    // Must NOT release during the pause!
    expect(f.overlay()).not.toBeNull();
    // CLI outputs reconstructed history
    const historyRows = ["prompt line", "history 1", "history 2", "history 3", "history 4"].map(t => {
      const d = document.createElement("div");
      d.textContent = t;
      return d;
    });
    rowsContainer.replaceChildren(...historyRows);
    f.parse("prompt line\nhistory 1\nhistory 2\nhistory 3\nhistory 4");
    f.render();
    vi.advanceTimersByTime(250);
    expect(f.overlay()).toBeNull();
    f.presentation.dispose();
  });
});
