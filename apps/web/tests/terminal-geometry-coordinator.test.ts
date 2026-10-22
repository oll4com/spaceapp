import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalGeometryCoordinator,
  fitTerminalForInitialAttach
} from "../src/features/terminal-pane/terminal-geometry-coordinator.js";

let nextAnimationFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();

function terminalHost(width = 800, height = 400, screenWidth = width) {
  let currentWidth = width;
  let currentHeight = height;
  let currentScreenWidth = screenWidth;
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  host.appendChild(screen);
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
  vi.spyOn(screen, "getBoundingClientRect").mockImplementation(() => ({
    x: 0,
    y: 0,
    top: 0,
    right: currentScreenWidth,
    bottom: currentHeight,
    left: 0,
    width: currentScreenWidth,
    height: currentHeight,
    toJSON: () => ({})
  }));
  Object.assign(host, {
    setTerminalTestSize(nextWidth: number, nextHeight: number, nextScreenWidth = nextWidth) {
      currentWidth = nextWidth;
      currentHeight = nextHeight;
      currentScreenWidth = nextScreenWidth;
    }
  });
  return host;
}

function fixture(input: {
  visible?: boolean;
  minimized?: boolean;
  cols?: number;
  rows?: number;
  proposedCols?: number;
  proposedRows?: number;
  screenWidth?: number;
  isScrolledToBottom?: () => boolean;
  scrollToBottom?: () => void;
  onRepaint?: (info: { phase: string; cols: number; rows: number; width: number; height: number; suspect: boolean }) => void;
} = {}) {
  let visible = input.visible ?? true;
  let minimized = input.minimized ?? false;
  let leaseId: string | null = "lease:one";
  let socketGeneration = 4;
  const host = terminalHost(800, 400, input.screenWidth ?? 800);
  const terminal = {
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
    refresh: vi.fn(),
    clearTextureAtlas: vi.fn(),
    resize: vi.fn()
  };
  const fitAddon = {
    proposeDimensions: vi.fn(() => ({
      cols: input.proposedCols ?? 80,
      rows: input.proposedRows ?? 24
    })),
    fit: vi.fn(() => {
      terminal.cols = input.proposedCols ?? 80;
      terminal.rows = input.proposedRows ?? 24;
    })
  };
  const sendResize = vi.fn();
  const invalidateWidthMeasurements = vi.fn();
  const measureCharacterSize = vi.fn();
  const onReady = vi.fn();
  const scrollToBottom = input.scrollToBottom ? vi.fn(input.scrollToBottom) : vi.fn();
  const isScrolledToBottom = input.isScrolledToBottom ? vi.fn(input.isScrolledToBottom) : vi.fn(() => true);
  const coordinator = createTerminalGeometryCoordinator({
    ownerDocument: document,
    host,
    getTerminal: () => terminal,
    getFitAddon: () => fitAddon,
    isVisible: () => visible,
    isMinimized: () => minimized,
    measureCharacterSize,
    invalidateWidthMeasurements,
    isScrolledToBottom,
    scrollToBottom,
    getResizeIdentity: () => ({
      socketGeneration,
      sessionId: "cli_session:test",
      leaseId
    }),
    sendResize,
    onReady,
    onRepaint: input.onRepaint
  });
  return {
    coordinator,
    fitAddon,
    host,
    invalidateWidthMeasurements,
    measureCharacterSize,
    onReady,
    sendResize,
    setLeaseId: (value: string | null) => {
      leaseId = value;
    },
    setSocketGeneration: (value: number) => {
      socketGeneration = value;
    },
    setMinimized: (value: boolean) => {
      minimized = value;
    },
    setHostSize: (width: number, height: number, screenWidth = width) => {
      (
        host as unknown as HTMLElement & {
          setTerminalTestSize: (nextWidth: number, nextHeight: number, nextScreenWidth?: number) => void;
        }
      ).setTerminalTestSize(width, height, screenWidth);
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    scrollToBottom,
    isScrolledToBottom,
    terminal
  };
}

async function flushAnimationFrame() {
  const queued = Array.from(animationFrames.values());
  animationFrames.clear();
  for (const callback of queued) callback(performance.now());
  await Promise.resolve();
}

describe("terminal geometry coordinator", () => {
  it("does not request layout-dependent font readiness when fonts are already loaded", () => {
    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    const ready = vi.fn(() => Promise.resolve());
    const fonts = new EventTarget();
    Object.defineProperties(fonts, { status: { value: "loaded" }, ready: { get: ready } });
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const current = fixture();
    try {
      current.coordinator.syncVisibility();
      current.coordinator.requestRefit({ delayedPass: false });
      expect(ready).not.toHaveBeenCalled();
      expect(animationFrames.size).toBeGreaterThan(0);
    } finally {
      current.coordinator.dispose();
      if (original) Object.defineProperty(document, "fonts", original);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("still refits when pending fonts finish loading", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    let resolveFonts!: () => void;
    const ready = new Promise<void>(resolve => { resolveFonts = resolve; });
    const fonts = new EventTarget();
    Object.defineProperties(fonts, { status: { value: "loading" }, ready: { value: ready } });
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const current = fixture();
    try {
      current.coordinator.syncVisibility();
      await flushAnimationFrame(); await flushAnimationFrame();
      const initialFits = current.fitAddon.fit.mock.calls.length;
      fonts.dispatchEvent(new Event("loadingdone"));
      resolveFonts(); await Promise.resolve(); await flushAnimationFrame();
      expect(current.fitAddon.fit.mock.calls.length).toBeGreaterThan(initialFits);
      expect(current.invalidateWidthMeasurements).toHaveBeenCalled();
    } finally {
      current.coordinator.dispose();
      if (original) Object.defineProperty(document, "fonts", original);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    nextAnimationFrameId = 1;
    animationFrames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextAnimationFrameId;
      nextAnimationFrameId += 1;
      animationFrames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      animationFrames.delete(handle);
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels observer, timer, and font refits while hidden and performs one resize after two stable restore samples", async () => {
    const current = fixture({ visible: false });
    current.coordinator.syncVisibility();
    current.coordinator.requestRefit();
    document.fonts?.dispatchEvent?.(new Event("loadingdone"));
    await vi.advanceTimersByTimeAsync(100);

    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    expect(current.sendResize).not.toHaveBeenCalled();

    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    expect(current.onReady).not.toHaveBeenCalled();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.onReady).toHaveBeenCalledOnce();
    expect(current.sendResize).toHaveBeenCalledOnce();
    // The socket's first frame is forced so the CLI repaints into the new xterm.
    expect(current.sendResize).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      leaseId: "lease:one",
      force: true
    });
  });

  it("waits for a synchronized frame without fitting or forcing resize, then resumes", async () => {
    const current = fixture();
    const modes = { synchronizedOutputMode: false };
    Object.assign(current.terminal, { modes });
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame();
    current.fitAddon.fit.mockClear(); current.sendResize.mockClear();
    current.terminal.refresh.mockClear();
    modes.synchronizedOutputMode = true;
    current.setHostSize(640, 400, 800);
    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame(); await flushAnimationFrame();
    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    expect(current.sendResize).not.toHaveBeenCalled();
    expect(current.terminal.refresh).toHaveBeenCalledExactlyOnceWith(0, 23);
    modes.synchronizedOutputMode = false;
    current.setHostSize(640, 400, 640);
    await flushAnimationFrame();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    current.coordinator.dispose();
  });

  it("cancels a synchronized-frame wait when hidden and reuses stable warm geometry", async () => {
    const current = fixture();
    const modes = { synchronizedOutputMode: false };
    Object.assign(current.terminal, { modes });
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame();
    current.fitAddon.fit.mockClear(); current.onReady.mockClear();
    modes.synchronizedOutputMode = true;
    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame();
    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    current.setVisible(false);
    current.coordinator.syncVisibility();
    expect(animationFrames.size).toBe(0);
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame();
    expect(current.onReady).toHaveBeenCalledOnce();
    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    current.coordinator.dispose();
    expect(animationFrames.size).toBe(0);
  });

  it("fits fresh terminal geometry only after two stable frames and waits for repaint", async () => {
    const host = terminalHost(800, 400);
    const terminal = {
      cols: 100,
      rows: 30,
      refresh: vi.fn()
    };
    const fitAddon = {
      fit: vi.fn(() => {
        terminal.cols = 132;
        terminal.rows = 41;
      })
    };

    const pending = fitTerminalForInitialAttach({
      ownerDocument: document,
      host,
      terminal,
      fitAddon
    });
    await flushAnimationFrame();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    await flushAnimationFrame();
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 40);
    await flushAnimationFrame();

    await expect(pending).resolves.toEqual({ cols: 132, rows: 41 });
  });

  it("repairs partial column collapse against proposed dimensions and refreshes valid geometry", async () => {
    const current = fixture({ cols: 24, proposedCols: 80 });
    current.coordinator.syncVisibility();

    expect(current.coordinator.repairIfBroken()).toBe(true);
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.invalidateWidthMeasurements).toHaveBeenCalledOnce();
    expect(current.measureCharacterSize).toHaveBeenCalledOnce();
    expect(current.terminal.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(current.sendResize).toHaveBeenCalledOnce();
  });

  it("repairs an xterm screen covering less than 70 percent of its stable host", async () => {
    const current = fixture({ cols: 80, proposedCols: 80, screenWidth: 480 });
    current.coordinator.syncVisibility();

    expect(current.coordinator.repairIfBroken()).toBe(true);
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.invalidateWidthMeasurements).toHaveBeenCalledOnce();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
  });

  it("repairs an xterm screen overflowing its host by more than 2px", async () => {
    const current = fixture({ cols: 80, proposedCols: 80, screenWidth: 812 });
    current.coordinator.syncVisibility();

    expect(current.coordinator.repairIfBroken()).toBe(true);
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.invalidateWidthMeasurements).toHaveBeenCalledOnce();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
  });

  it("clamps one column when fit overflows the host at fractional zoom", async () => {
    const current = fixture({ cols: 80, proposedCols: 80, screenWidth: 810 });
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.resize).toHaveBeenCalled();
    const firstResize = current.terminal.resize.mock.calls[0]?.[0] ?? 0;
    expect(firstResize).toBeLessThan(80);
    expect(firstResize).toBeGreaterThanOrEqual(77);
    expect(current.sendResize).toHaveBeenCalledOnce();
  });

  it("does not clamp when the screen fits within tolerance", async () => {
    const current = fixture({ cols: 80, proposedCols: 80, screenWidth: 801 });
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.resize).not.toHaveBeenCalled();
  });

  it("deduplicates resize frames by socket, session, lease, columns, and rows", () => {
    const current = fixture();
    current.coordinator.syncVisibility();

    current.coordinator.handleTerminalResize(80, 24);
    current.coordinator.handleTerminalResize(80, 24);
    expect(current.sendResize).toHaveBeenCalledOnce();

    current.setLeaseId("lease:two");
    current.coordinator.handleTerminalResize(80, 24);
    expect(current.sendResize).toHaveBeenCalledTimes(2);

    current.coordinator.handleTerminalResize(0, 24);
    current.coordinator.handleTerminalResize(80, 0);
    expect(current.sendResize).toHaveBeenCalledTimes(2);
  });

  it.each([
    { width: 640, cols: 64, outputRecovery: false },
    { width: 1600, cols: 160, outputRecovery: false },
    { width: 640, cols: 64, outputRecovery: true }
  ])("fits a healthy terminal to a $width px host without a forced redraw (output recovery: $outputRecovery)", async ({ width, cols, outputRecovery }) => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.sendResize.mockClear();

    // The dock changes the host before xterm has fitted its existing screen.
    current.setHostSize(width, 400, 800);
    current.fitAddon.fit.mockImplementation(() => {
      current.terminal.cols = cols;
      current.setHostSize(width, 400, width);
      // Real xterm emits onResize synchronously inside FitAddon.fit().
      current.coordinator.handleTerminalResize(cols, 24);
    });
    current.coordinator.requestRefit({ delayedPass: false });
    if (outputRecovery) current.coordinator.repairIfBroken();
    await flushAnimationFrame();

    expect(current.terminal.cols).toBe(cols);
    expect(current.sendResize.mock.calls).toEqual([[{ cols, rows: 24, leaseId: "lease:one" }]]);
    expect(current.invalidateWidthMeasurements).not.toHaveBeenCalled();
    expect(current.measureCharacterSize).not.toHaveBeenCalled();
    expect(current.terminal.clearTextureAtlas).not.toHaveBeenCalled();
    expect(current.host.dataset.terminalGeometryRepaired).toBe("false");
    current.coordinator.dispose();
  });

  it("still repairs a resized host when an ordinary fit cannot fix its screen", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.sendResize.mockClear();

    current.setHostSize(640, 400, 800);
    current.fitAddon.fit.mockImplementation(() => {
      current.terminal.cols = 64;
      // Simulate stale character measurements: only repair restores the screen.
      if (current.measureCharacterSize.mock.calls.length > 0) current.setHostSize(640, 400, 640);
    });
    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame();

    expect(current.measureCharacterSize).toHaveBeenCalledOnce();
    expect(current.terminal.cols).toBe(64);
    expect(current.host.dataset.terminalScreenWidth).toBe("640");
    expect(current.sendResize).toHaveBeenLastCalledWith({ cols: 64, rows: 24, leaseId: "lease:one", force: true });
    current.coordinator.dispose();
  });

  it("reconcileResize resends an identical frame to heal a stale pane host PTY", () => {
    const current = fixture();
    current.coordinator.syncVisibility();

    current.coordinator.handleTerminalResize(96, 24);
    expect(current.sendResize).toHaveBeenCalledOnce();

    current.coordinator.reconcileResize(96, 24);
    expect(current.sendResize).toHaveBeenCalledTimes(2);

    current.coordinator.reconcileResize(0, 24);
    current.coordinator.reconcileResize(96, 0);
    expect(current.sendResize).toHaveBeenCalledTimes(2);
  });

  it("marks a minimized pane pending without fitting until it is restored", async () => {
    const current = fixture({ minimized: true });
    current.coordinator.syncVisibility();
    current.coordinator.requestRefit({ delayedPass: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(current.fitAddon.fit).not.toHaveBeenCalled();

    current.setMinimized(false);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
  });

  it("reuses stable geometry on hidden to visible resume without fitting again and repaints the reveal", async () => {
    const onRepaint = vi.fn();
    const current = fixture({ onRepaint });
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.refresh).toHaveBeenCalledOnce();
    expect(current.onReady).toHaveBeenCalledOnce();

    current.setVisible(false);
    current.coordinator.syncVisibility();
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.refresh).toHaveBeenCalledTimes(2);
    expect(current.onReady).toHaveBeenCalledTimes(2);
    expect(onRepaint).toHaveBeenCalledWith(expect.objectContaining({ phase: "reveal" }));
  });

  it("forces the repair path for a layout refit even when dimensions look valid", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    current.fitAddon.fit.mockClear();
    current.invalidateWidthMeasurements.mockClear();
    current.measureCharacterSize.mockClear();
    current.terminal.clearTextureAtlas.mockClear();

    current.coordinator.syncVisibility({ repair: true });
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.invalidateWidthMeasurements).toHaveBeenCalledOnce();
    expect(current.measureCharacterSize).toHaveBeenCalledOnce();
    expect(current.terminal.clearTextureAtlas).toHaveBeenCalledOnce();
  });

  // A hidden warm room keeps its panes laid out, so window resizes and fullscreen/mobile switches reach
  // its terminals' hosts while hidden. Nothing may fit or reach the PTY until the reveal, which resizes at
  // most once and only when the grid changed.
  it("never fits or resizes the PTY of a hidden terminal on window or layout changes; the reveal resizes once for a new grid", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame();
    current.setVisible(false);
    current.coordinator.syncVisibility();
    current.fitAddon.fit.mockClear(); current.sendResize.mockClear(); current.terminal.resize.mockClear();
    for (const [width, height] of [[1000, 500], [1200, 700], [1000, 500]] as const) {
      current.setHostSize(width, height);
      window.dispatchEvent(new Event("resize"));
      current.coordinator.requestRefit();
      await vi.advanceTimersByTimeAsync(100);
      await flushAnimationFrame(); await flushAnimationFrame();
    }
    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    expect(current.sendResize).not.toHaveBeenCalled();
    expect(current.terminal.resize).not.toHaveBeenCalled();

    current.fitAddon.proposeDimensions.mockImplementation(() => ({ cols: 100, rows: 30 }));
    current.fitAddon.fit.mockImplementation(() => { current.terminal.cols = 100; current.terminal.rows = 30; });
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame(); await flushAnimationFrame();
    await vi.advanceTimersByTimeAsync(1000);
    expect(current.sendResize).toHaveBeenCalledOnce();
    expect(current.sendResize).toHaveBeenCalledWith(expect.objectContaining({ cols: 100, rows: 30 }));
    current.coordinator.dispose();
  });

  it("sends no PTY resize on reveal when a hidden terminal's layout changed and came back", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame();
    current.setVisible(false);
    current.coordinator.syncVisibility();
    current.sendResize.mockClear();
    current.setHostSize(1200, 700);
    window.dispatchEvent(new Event("resize"));
    current.coordinator.requestRefit();
    current.setHostSize(800, 400);
    window.dispatchEvent(new Event("resize"));
    current.coordinator.requestRefit();
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame(); await flushAnimationFrame(); await flushAnimationFrame();
    await vi.advanceTimersByTimeAsync(1000);
    expect(current.sendResize).not.toHaveBeenCalled();
    current.coordinator.dispose();
  });

  it("fits again when the host size changed while the terminal was hidden", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    current.setVisible(false);
    current.coordinator.syncVisibility();
    current.setHostSize(640, 360);
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(current.terminal.refresh).toHaveBeenCalledTimes(2);
    expect(current.onReady).toHaveBeenCalledTimes(2);
  });

  it("confirms unchanged geometry on a repeated refit without fitting or redrawing every row", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.fitAddon.fit.mockClear();
    current.terminal.refresh.mockClear();
    current.onReady.mockClear();
    current.sendResize.mockClear();

    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame();

    expect(current.fitAddon.fit).not.toHaveBeenCalled();
    expect(current.terminal.refresh).not.toHaveBeenCalled();
    expect(current.onReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cols: 80, rows: 24, repaired: false }));
    // The PTY already has this size; the resize frame stays deduplicated.
    expect(current.sendResize).not.toHaveBeenCalled();

    current.setHostSize(640, 400);
    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalled();
    expect(current.terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("still redraws an unchanged layout when the painted screen collapsed", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.terminal.refresh.mockClear();

    current.setHostSize(800, 400, 300);
    current.coordinator.requestRefit({ delayedPass: false });
    await flushAnimationFrame();

    expect(current.terminal.refresh).toHaveBeenCalled();
  });

  it("resends cached dimensions for a new resize identity without fitting again", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize).toHaveBeenCalledOnce();

    current.setVisible(false);
    current.coordinator.syncVisibility();
    current.setLeaseId("lease:two");
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.terminal.refresh).toHaveBeenCalledTimes(2);
    expect(current.sendResize).toHaveBeenCalledTimes(2);
    expect(current.sendResize).toHaveBeenLastCalledWith({
      cols: 80,
      rows: 24,
      leaseId: "lease:two"
    });
  });

  it("fits again when viewport scale changes while the terminal is hidden", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    current.setVisible(false);
    current.coordinator.syncVisibility();
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    window.dispatchEvent(new Event("resize"));
    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(current.terminal.refresh).toHaveBeenCalledTimes(2);
  });

  it("backgroundResize resizes a hidden terminal without the visibility gate", () => {
    const current = fixture({ visible: false });
    expect(current.coordinator.backgroundResize(120, 40)).toBe(true);
    expect(current.terminal.resize).toHaveBeenCalledWith(120, 40);
    expect(current.terminal.refresh).toHaveBeenCalledWith(0, 39);
    expect(current.sendResize).toHaveBeenCalledWith({ cols: 120, rows: 40, leaseId: "lease:one", force: true });
  });

  it("forces only the first frame of a socket: later grids and leases on that socket are normal frames", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 80, rows: 24, leaseId: "lease:one", force: true }]]);
    current.sendResize.mockClear();

    expect(current.coordinator.backgroundResize(120, 40)).toBe(true);
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 120, rows: 40, leaseId: "lease:one" }]]);
    current.sendResize.mockClear();

    current.setLeaseId("lease:two");
    current.coordinator.requestRefit();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 80, rows: 24, leaseId: "lease:two" }]]);
  });

  it("forces the first frame of every new socket, once, even for a grid the previous socket already sent", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.sendResize.mockClear();

    current.setSocketGeneration(5);
    current.coordinator.requestRefit();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 80, rows: 24, leaseId: "lease:one", force: true }]]);
    current.sendResize.mockClear();

    current.coordinator.requestRefit({ repair: true });
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize).not.toHaveBeenCalled();

    expect(current.coordinator.backgroundResize(120, 40)).toBe(true);
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 120, rows: 40, leaseId: "lease:one" }]]);
  });

  it("backgroundResize as a socket's first frame is forced and a later same-grid foreground frame is not resent", async () => {
    const current = fixture({ visible: false, proposedCols: 120, proposedRows: 40 });
    expect(current.coordinator.backgroundResize(120, 40)).toBe(true);
    expect(current.sendResize.mock.calls).toEqual([[{ cols: 120, rows: 40, leaseId: "lease:one", force: true }]]);
    current.sendResize.mockClear();

    current.setVisible(true);
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    expect(current.sendResize).not.toHaveBeenCalled();
  });

  it("forceRepaint repaints a revealed terminal without refitting", async () => {
    const onRepaint = vi.fn();
    const current = fixture({ onRepaint });
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.terminal.refresh.mockClear();
    onRepaint.mockClear();

    expect(current.coordinator.forceRepaint()).toBe(true);
    expect(onRepaint).toHaveBeenCalledWith(expect.objectContaining({ phase: "force", suspect: false }));
    expect(current.terminal.refresh).toHaveBeenCalledOnce();
    expect(current.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(current.fitAddon.fit).toHaveBeenCalledOnce();
    expect(current.sendResize).toHaveBeenCalledOnce();

    current.setVisible(false);
    current.coordinator.syncVisibility();
    expect(current.coordinator.forceRepaint()).toBe(false);
    expect(current.terminal.refresh).toHaveBeenCalledOnce();
    expect(onRepaint).toHaveBeenCalledOnce();
  });

  it("sends force: true on the first repair frame of a grid for a socket and lease", async () => {
    const current = fixture();
    current.coordinator.syncVisibility({ repair: true });
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.sendResize.mock.calls).toEqual([[{
      cols: 80,
      rows: 24,
      leaseId: "lease:one",
      force: true
    }]]);
  });

  it("repairs the screen without resending a grid the same socket and lease already sent", async () => {
    const current = fixture();
    current.coordinator.syncVisibility({ repair: true });
    await flushAnimationFrame();
    await flushAnimationFrame();
    current.sendResize.mockClear();
    current.invalidateWidthMeasurements.mockClear();
    current.terminal.clearTextureAtlas.mockClear();

    current.coordinator.requestRefit({ repair: true });
    await flushAnimationFrame();

    expect(current.invalidateWidthMeasurements).toHaveBeenCalledOnce();
    expect(current.terminal.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(current.sendResize).not.toHaveBeenCalled();

    current.setLeaseId("lease:two");
    current.coordinator.requestRefit({ repair: true });
    await flushAnimationFrame();

    expect(current.sendResize.mock.calls).toEqual([[{
      cols: 80,
      rows: 24,
      leaseId: "lease:two",
      force: true
    }]]);
  });

  it("restores scroll to bottom both synchronously and on follow-up animation frame when scrolled to bottom", async () => {
    const current = fixture();
    current.coordinator.syncVisibility();
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(current.scrollToBottom).toHaveBeenCalled();
    const callsInitial = current.scrollToBottom.mock.calls.length;

    // Simulate shrinking the terminal host
    current.setHostSize(400, 200);
    current.coordinator.requestRefit({ repair: true });
    await flushAnimationFrame();
    // Flush the follow-up rAF
    await flushAnimationFrame();

    expect(current.scrollToBottom.mock.calls.length).toBeGreaterThan(callsInitial);
  });
});
