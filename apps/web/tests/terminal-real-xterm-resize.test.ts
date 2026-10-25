import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createTerminalGeometryCoordinator } from "../src/features/terminal-pane/terminal-geometry-coordinator.js";

describe("real xterm resize scroll behavior", () => {
  it.each(["two-pass", "cursor-prelude", "slow-synchronized", "plain-redraw"])("presents complete frames for %s resize output", async scenario => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    }));
    let width = 800;
    let visible = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperties(host, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => 400 }
    });
    const terminal = new Terminal({ cols: 80, rows: 20 });
    const fitAddon = new FitAddon();
    fitAddon.proposeDimensions = () => ({ cols: width / 10, rows: 20 });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockImplementation(() => ({
      width: terminal.cols * 10, height: 400, x: 0, y: 0, top: 0, left: 0,
      right: terminal.cols * 10, bottom: 400, toJSON: () => ({})
    }));
    const coordinator = createTerminalGeometryCoordinator({
      ownerDocument: document, host, getTerminal: () => terminal, getFitAddon: () => fitAddon,
      isVisible: () => visible, isMinimized: () => false,
      getResizeIdentity: () => null, sendResize: () => {},
      measureCharacterSize: () => {}, invalidateWidthMeasurements: () => {}
    });
    const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const presentedText = () => (host.querySelector("[data-terminal-resize-frame] .xterm-rows")
      ?? screen.querySelector(".xterm-rows"))?.textContent;
    try {
      coordinator.syncVisibility();
      await frame(); await frame();
      await write("COMPLETE_PREVIOUS_FRAME");
      await frame(); await frame();
      width = 640;
      coordinator.requestRefit({ delayedPass: false });
      await frame(); await frame();
      // The browser fit paints before a remote PTY can answer the resize.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
      expect(host.querySelector("[data-terminal-resize-frame]")).not.toBeNull();
      if (scenario !== "two-pass") {
        // Cursor/control traffic is not a completed redraw. The observed
        // Gemini sequence has a separate pause before erase + history output.
        await write("\x1b[H\x1b[?25l");
        await frame(); await frame();
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(host.querySelector("[data-terminal-resize-frame]")).not.toBeNull();
        await write("\x1b[3J\x1b[2J\x1b[H");
        await frame(); await frame();
        await new Promise(resolve => setTimeout(resolve, 220));
        expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
        if (scenario === "slow-synchronized") {
          await write("\x1b[?2026hPARTIAL_HISTORY");
          await new Promise(resolve => setTimeout(resolve, 450));
          expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
        }
      }
      // Real Codex emits a short first frame, then clears outside DEC 2026
      // about 75 ms later before reconstructing the rest of its history.
      await write(scenario === "plain-redraw"
        ? "\x1b[2J\x1b[HTEMPORARY_RESIZE_FRAME"
        : "\x1b[?2026h\x1b[2J\x1b[HTEMPORARY_RESIZE_FRAME\x1b[?2026l");
      await frame(); await frame();
      expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
      await new Promise(resolve => setTimeout(resolve, 75));
      await write("\x1b[2J\x1b[H");
      await frame(); await frame();
      expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
      await write("\x1b[?2026hPARTIAL_HISTORY");
      await frame();
      expect(presentedText()).toContain("COMPLETE_PREVIOUS_FRAME");
      await write("\x1b[2J\x1b[HCOMPLETE_RESIZED_FRAME\x1b[?2026l");
      await new Promise(resolve => setTimeout(resolve, 300));
      await frame();
      expect(presentedText()).toContain("COMPLETE_RESIZED_FRAME");
      expect(host.querySelector("[data-terminal-resize-frame]")).toBeNull();
      expect(terminal.cols).toBe(64);
      // A changed layout while hidden must not hold an old room's viewport,
      // including when its restore fit waits for a synchronized frame.
      visible = false;
      coordinator.syncVisibility();
      width = 800;
      await write("\x1b[?2026h");
      visible = true;
      coordinator.syncVisibility();
      await frame(); await frame();
      await write("\x1b[?2026l");
      await frame(); await frame();
      expect(terminal.cols).toBe(80);
      expect(host.querySelector("[data-terminal-resize-frame]")).toBeNull();
    } finally {
      coordinator.dispose(); terminal.dispose(); host.remove(); vi.restoreAllMocks();
    }
  });

  it("does not reveal a partial synchronized CLI redraw while fitting a dock resize", async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    }));
    let width = 800;
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperties(host, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => 400 }
    });
    const terminal = new Terminal({ cols: 80, rows: 20 });
    const fitAddon = new FitAddon();
    fitAddon.proposeDimensions = () => ({ cols: width / 10, rows: 20 });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockImplementation(() => ({
      width: terminal.cols * 10, height: 400, x: 0, y: 0, top: 0, left: 0,
      right: terminal.cols * 10, bottom: 400, toJSON: () => ({})
    }));
    const coordinator = createTerminalGeometryCoordinator({
      ownerDocument: document, host, getTerminal: () => terminal, getFitAddon: () => fitAddon,
      isVisible: () => true, isMinimized: () => false,
      getResizeIdentity: () => null, sendResize: () => {},
      measureCharacterSize: () => {}, invalidateWidthMeasurements: () => {}
    });
    const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      coordinator.syncVisibility();
      await frame(); await frame();
      await write("COMPLETE_PREVIOUS_FRAME");
      await frame(); await frame();
      await write("\x1b[?2026h\x1b[2J\x1b[HPARTIAL_NEXT_FRAME");
      await frame();
      expect(screen.querySelector(".xterm-rows")?.textContent).toContain("COMPLETE_PREVIOUS_FRAME");
      width = 640;
      coordinator.requestRefit({ delayedPass: false });
      await frame(); await frame();
      expect(screen.querySelector(".xterm-rows")?.textContent).toContain("COMPLETE_PREVIOUS_FRAME");
      expect(screen.querySelector(".xterm-rows")?.textContent).not.toContain("PARTIAL_NEXT_FRAME");
      expect(terminal.cols).toBe(80);
      await write("\x1b[2J\x1b[HCOMPLETE_NEXT_FRAME\x1b[?2026l");
      await frame(); await frame();
      expect(terminal.cols).toBe(64);
      expect(screen.querySelector(".xterm-rows")?.textContent).toContain("COMPLETE_NEXT_FRAME");
    } finally {
      coordinator.dispose(); terminal.dispose(); host.remove(); vi.restoreAllMocks();
    }
  });

  it("keeps painted rows visible between a dock resize and the next xterm render", async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    }));
    let width = 800;
    const host = document.createElement("div");
    host.style.height = "400px";
    document.body.appendChild(host);
    Object.defineProperties(host, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => 400 }
    });
    const terminal = new Terminal({ cols: 80, rows: 20 });
    const fitAddon = new FitAddon();
    fitAddon.proposeDimensions = () => ({ cols: width / 10, rows: 20 });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockImplementation(() => ({
      width: terminal.cols * 10, height: 400, x: 0, y: 0, top: 0, left: 0,
      right: terminal.cols * 10, bottom: 400, toJSON: () => ({})
    }));
    const sendResize = vi.fn();
    const refitContents: string[] = [];
    const coordinator = createTerminalGeometryCoordinator({
      ownerDocument: document, host, getTerminal: () => terminal, getFitAddon: () => fitAddon,
      isVisible: () => true, isMinimized: () => false,
      getResizeIdentity: () => ({ socketGeneration: 1, sessionId: "cli_session:dock", leaseId: "lease:dock" }),
      sendResize, measureCharacterSize: () => {}, invalidateWidthMeasurements: () => {},
      onRepaint: ({ phase }) => {
        if (width === 640 && phase === "refit") refitContents.push(screen.querySelector(".xterm-rows")?.textContent ?? "");
      }
    });
    const resizeListener = terminal.onResize(({ cols, rows }) => coordinator.handleTerminalResize(cols, rows));
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      coordinator.syncVisibility();
      await nextFrame();
      await nextFrame();
      await new Promise<void>(resolve => terminal.write("DOCK_CONTENT_STAYS_VISIBLE", resolve));
      await nextFrame();
      await nextFrame();
      expect(screen.querySelector(".xterm-rows")?.textContent).toContain("DOCK_CONTENT_STAYS_VISIBLE");
      sendResize.mockClear();

      width = 640;
      coordinator.requestRefit({ delayedPass: false });
      await nextFrame();
      await nextFrame();
      expect(terminal.cols).toBe(64);
      expect(refitContents.length).toBeGreaterThan(0);
      expect(refitContents.every(content => content.includes("DOCK_CONTENT_STAYS_VISIBLE"))).toBe(true);
      expect(sendResize.mock.calls).toEqual([[{ cols: 64, rows: 20, leaseId: "lease:dock" }]]);
    } finally {
      resizeListener.dispose();
      coordinator.dispose();
      terminal.dispose();
      host.remove();
      vi.restoreAllMocks();
    }
  });

  it("keeps real xterm pinned to bottom during refit", async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    let currentWidth = 400;
    let currentHeight = 300;
    const host = document.createElement("div");
    host.style.width = "400px";
    host.style.height = "300px";
    document.body.appendChild(host);

    Object.defineProperties(host, {
      clientWidth: { configurable: true, get: () => currentWidth },
      clientHeight: { configurable: true, get: () => currentHeight }
    });
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      right: currentWidth,
      bottom: currentHeight,
      left: 0,
      width: currentWidth,
      height: currentHeight,
      toJSON: () => ({})
    }));

    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000 });
    const fitAddon = new FitAddon();
    fitAddon.proposeDimensions = () => ({
      cols: Math.floor(currentWidth / 10),
      rows: Math.floor(currentHeight / 20)
    });
    term.loadAddon(fitAddon);
    term.open(host);

    const wasAtBottomRef = { current: true };
    term.onScroll(() => {
      const activeBuffer = term.buffer.active;
      if (activeBuffer) {
        if (activeBuffer.baseY <= 0 || activeBuffer.viewportY >= activeBuffer.baseY - 1) {
          wasAtBottomRef.current = true;
        } else if (activeBuffer.viewportY < activeBuffer.baseY - 2) {
          wasAtBottomRef.current = false;
        }
      }
    });

    for (let i = 0; i < 50; i++) {
      term.writeln("Line " + i + ": " + "some long text ".repeat(10));
    }
    term.scrollToBottom();

    expect(wasAtBottomRef.current).toBe(true);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

    const coordinator = createTerminalGeometryCoordinator({
      ownerDocument: document,
      host,
      getTerminal: () => term as any,
      getFitAddon: () => fitAddon as any,
      isVisible: () => true,
      isMinimized: () => false,
      isScrolledToBottom: () => {
        const activeBuffer = term.buffer.active;
        if (!activeBuffer) return wasAtBottomRef.current;
        if (activeBuffer.baseY <= 0) return true;
        if (activeBuffer.viewportY >= activeBuffer.baseY - 1) return true;
        return wasAtBottomRef.current;
      },
      scrollToBottom: () => {
        term.scrollToBottom();
        wasAtBottomRef.current = true;
      },
      getResizeIdentity: () => null,
      sendResize: () => {},
      measureCharacterSize: () => {},
      invalidateWidthMeasurements: () => {}
    });

    coordinator.syncVisibility();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    console.log("BEFORE maximize: cols =", term.cols, "rows =", term.rows, "baseY =", term.buffer.active.baseY);

    // Now simulate maximize: host expands
    currentWidth = 1200;
    currentHeight = 800;

    coordinator.requestRefit({ repair: true });
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    console.log("TEST RESULT after maximize:", {
      cols: term.cols,
      rows: term.rows,
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      wasAtBottom: wasAtBottomRef.current
    });

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);

    // Now simulate unmaximize / restore: host shrinks
    currentWidth = 400;
    currentHeight = 300;

    coordinator.requestRefit({ repair: true });
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    console.log("TEST RESULT after unmaximize:", {
      cols: term.cols,
      rows: term.rows,
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      wasAtBottom: wasAtBottomRef.current
    });

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  it("retains multiline conversation history across a CLI prompt-only prelude and delayed history redraw", async () => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    }));
    let width = 800;
    const host = document.createElement("div");
    document.body.appendChild(host);
    Object.defineProperties(host, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, get: () => 400 }
    });
    const terminal = new Terminal({ cols: 80, rows: 20 });
    const fitAddon = new FitAddon();
    fitAddon.proposeDimensions = () => ({ cols: width / 10, rows: 20 });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockImplementation(() => ({
      width: terminal.cols * 10, height: 400, x: 0, y: 0, top: 0, left: 0,
      right: terminal.cols * 10, bottom: 400, toJSON: () => ({})
    }));
    const coordinator = createTerminalGeometryCoordinator({
      ownerDocument: document, host, getTerminal: () => terminal, getFitAddon: () => fitAddon,
      isVisible: () => true, isMinimized: () => false,
      getResizeIdentity: () => null, sendResize: () => {},
      measureCharacterSize: () => {}, invalidateWidthMeasurements: () => {}
    });
    const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const presentedText = () => (host.querySelector("[data-terminal-resize-frame] .xterm-rows")
      ?? screen.querySelector(".xterm-rows"))?.textContent;
    try {
      coordinator.syncVisibility();
      await frame(); await frame();
      const initialHistory = Array.from({ length: 10 }, (_, i) => `CONVERSATION_TURN_${i + 1}`).join("\r\n");
      await write(initialHistory);
      await frame(); await frame();
      expect(presentedText()).toContain("CONVERSATION_TURN_1");
      expect(presentedText()).toContain("CONVERSATION_TURN_10");

      width = 640;
      coordinator.requestRefit({ delayedPass: false });
      await frame(); await frame();
      expect(host.querySelector("[data-terminal-resize-frame]")).not.toBeNull();
      expect(presentedText()).toContain("CONVERSATION_TURN_1");

      await write("\x1b[3J\x1b[2J\x1b[HPROMPT_STATUS_BAR");
      await frame(); await frame();

      await new Promise(resolve => setTimeout(resolve, 250));

      expect(host.querySelector("[data-terminal-resize-frame]")).not.toBeNull();
      expect(presentedText()).toContain("CONVERSATION_TURN_1");

      const resizedHistory = Array.from({ length: 10 }, (_, i) => `RESIZED_TURN_${i + 1}`).join("\r\n");
      await write(`\x1b[HPROMPT_STATUS_BAR\r\n${resizedHistory}`);
      await frame(); await frame();

      await new Promise(resolve => setTimeout(resolve, 300));
      await frame();

      expect(host.querySelector("[data-terminal-resize-frame]")).toBeNull();
      expect(presentedText()).toContain("RESIZED_TURN_1");
      expect(presentedText()).toContain("RESIZED_TURN_10");
    } finally {
      coordinator.dispose(); terminal.dispose(); host.remove(); vi.restoreAllMocks();
    }
  });
});
