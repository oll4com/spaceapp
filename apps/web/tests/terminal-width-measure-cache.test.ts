import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  invalidateTerminalWidthMeasurements,
  memoizeTerminalWidthMeasurements
} from "../src/features/terminal-pane/terminal-width-measure-cache.js";

function widthCachePrototype() {
  const measure = vi.fn(function measure(
    this: { measuredWidth: number },
    _content: string,
    _variant: number
  ) {
    return this.measuredWidth;
  });
  return {
    prototype: { _measure: measure },
    measure
  };
}

function widthCache(
  prototype: ReturnType<typeof widthCachePrototype>["prototype"],
  fontSize: number,
  measuredWidth = fontSize,
  ownerDocument = document
) {
  return {
    cache: Object.assign(Object.create(prototype) as typeof prototype, {
      _font: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      _fontSize: fontSize,
      _weight: "normal",
      _weightBold: "bold",
      _flat: new Float32Array(256).fill(-9999),
      _container: { ownerDocument },
      measuredWidth
    })
  };
}

function terminalWithWidthCache(cache: ReturnType<typeof widthCache>["cache"]) {
  return {
    _core: {
      _renderService: {
        _renderer: { value: { _widthCache: cache } }
      }
    }
  };
}

// jsdom has no font layout. Keep the real xterm renderer and substitute only
// its DOM width boundary; the standalone Chrome comparator checks real fonts.
async function withMeasuredTerminal(
  run: (fixture: {
    terminal: Terminal;
    cache: any;
    nativeMeasure: ReturnType<typeof vi.fn>;
    ownerDocument: Document;
    ownerWindow: Window;
    fonts: EventTarget & { status: string };
    setOffset: (value: number) => void;
    setCloneFailure: (value: "mismatch" | "throw" | null) => void;
  }) => void | Promise<void>,
  output = "WIB\r\n\x1b[1;3mWIB\x1b[0m"
) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const ownerDocument = iframe.contentDocument!;
  const ownerWindow = iframe.contentWindow!;
  const matchMedia = vi.fn().mockReturnValue({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn()
  });
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = matchMedia;
  ownerWindow.matchMedia = matchMedia;
  const fonts = Object.assign(new EventTarget(), { status: "loaded" });
  Object.defineProperty(ownerDocument, "fonts", { configurable: true, value: fonts });
  const nativeElements = new Set<HTMLElement>();
  let offset = 0;
  let cloneFailure: "mismatch" | "throw" | null = null;
  const prototype = (ownerWindow as any).HTMLElement.prototype;
  const widthDescriptor = Object.getOwnPropertyDescriptor(prototype, "offsetWidth")!;
  Object.defineProperty(prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains("xterm-char-measure-element")) return 300;
      const clone = nativeElements.size > 0 && !nativeElements.has(this);
      if (clone && cloneFailure === "throw") throw new Error("Unavailable glyph geometry");
      const text = this.textContent ?? "";
      const base = text.startsWith("I") ? 4 : text.startsWith("W") ? 9 : 7;
      const bold = this.style.fontWeight === "bold" ? 2 : 0;
      const italic = this.style.fontStyle === "italic" ? 1 : 0;
      const size = Number.parseFloat(this.parentElement?.style.fontSize ?? "14") || 14;
      return text.length * ((base + bold + italic + offset) * size / 14 +
        (clone && cloneFailure === "mismatch" ? 1 : 0));
    }
  });
  const terminal = new Terminal({ fontSize: 14, cols: 20, rows: 4 });
  try {
    terminal.open(ownerDocument.body);
    await new Promise<void>(resolve => terminal.write(output, resolve));
    const cache = (terminal as any)._core._renderService._renderer.value._widthCache;
    for (const element of cache._measureElements) nativeElements.add(element);
    const nativeMeasure = vi.spyOn(cache, "_measure");
    expect(memoizeTerminalWidthMeasurements(terminal, ownerDocument)).toBe(true);
    await run({ terminal, cache, nativeMeasure, ownerDocument, ownerWindow, fonts,
      setOffset: value => { offset = value; },
      setCloneFailure: value => { cloneFailure = value; } });
  } finally {
    terminal.dispose();
    Object.defineProperty(prototype, "offsetWidth", widthDescriptor);
    window.matchMedia = originalMatchMedia;
    iframe.remove();
  }
}

describe("memoizeTerminalWidthMeasurements", () => {
  it("installs on the real xterm renderer and survives its width-cache clear", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn()
    } as unknown as MediaQueryList);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const terminal = new Terminal();
    try {
      terminal.open(host);
      expect(memoizeTerminalWidthMeasurements(terminal, document)).toBe(true);
      const cache = (terminal as any)._core._renderService._renderer.value._widthCache;
      const span = cache._measureElements[0] as HTMLElement;
      const readWidth = vi.fn(() => 240);
      Object.defineProperty(span, "offsetWidth", { configurable: true, get: readWidth });
      expect(cache.get("W", false, false)).toBe(7.5);
      cache.clear();
      expect(cache.get("W", false, false)).toBe(7.5);
      expect(readWidth).toHaveBeenCalledOnce();
    } finally {
      terminal.dispose(); host.remove(); window.matchMedia = originalMatchMedia;
    }
  });

  it("memoizes repeated glyph measurements per terminal without mutating the cache prototype", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    const terminal = terminalWithWidthCache(first.cache);
    const originalPrototypeMeasure = shared.prototype._measure;

    memoizeTerminalWidthMeasurements(terminal, ownerDocument);
    expect(first.cache._measure("M", 0)).toBe(7.5);
    expect(first.cache._measure("M", 0)).toBe(7.5);
    expect(shared.measure).toHaveBeenCalledOnce();
    expect(shared.prototype._measure).toBe(originalPrototypeMeasure);
    expect(Object.prototype.hasOwnProperty.call(first.cache, "_measure")).toBe(true);
  });

  it("measures a hidden terminal once per render pass, still answering 0, and measures again after the pass", async () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const hidden = widthCache(shared.prototype, 12, 0, ownerDocument);
    let rendered = false;
    hidden.cache._container = Object.assign(hidden.cache._container, { getClientRects: () => ({ length: rendered ? 1 : 0 }) });
    memoizeTerminalWidthMeasurements(terminalWithWidthCache(hidden.cache), ownerDocument);

    expect(["W", "λ", "─", "W"].map((glyph) => hidden.cache._measure(glyph, 0))).toEqual([0, 0, 0, 0]);
    expect(shared.measure).toHaveBeenCalledOnce();
    await Promise.resolve();
    rendered = true;
    hidden.cache.measuredWidth = 7.5;
    expect(hidden.cache._measure("W", 0)).toBe(7.5);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("keeps measuring a zero-width glyph in a rendered terminal", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const visible = widthCache(shared.prototype, 12, 0, ownerDocument);
    visible.cache._container = Object.assign(visible.cache._container, { getClientRects: () => ({ length: 1 }) });
    memoizeTerminalWidthMeasurements(terminalWithWidthCache(visible.cache), ownerDocument);

    expect(visible.cache._measure("​", 0)).toBe(0);
    visible.cache.measuredWidth = 7.5;
    expect(visible.cache._measure("W", 0)).toBe(7.5);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("does not share measurements between terminals or seed from xterm's private flat cache", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    const second = widthCache(shared.prototype, 12, 8.25, ownerDocument);
    const glyphCode = "W".charCodeAt(0);

    first.cache._flat[glyphCode] = 99;
    memoizeTerminalWidthMeasurements(terminalWithWidthCache(first.cache), ownerDocument);
    memoizeTerminalWidthMeasurements(terminalWithWidthCache(second.cache), ownerDocument);

    expect(first.cache._measure("W", 0)).toBe(7.5);
    expect(second.cache._measure("W", 0)).toBe(8.25);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("invalidates a terminal memo when its font tuple changes", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    const terminal = terminalWithWidthCache(first.cache);

    memoizeTerminalWidthMeasurements(terminal, ownerDocument);
    expect(first.cache._measure("W", 0)).toBe(7.5);
    first.cache._fontSize = 14;
    first.cache.measuredWidth = 8.75;
    expect(first.cache._measure("W", 0)).toBe(8.75);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("invalidates a terminal memo when DPR changes", () => {
    const ownerDocument = document;
    const ownerWindow = window;
    const originalDpr = ownerWindow.devicePixelRatio;
    Object.defineProperty(ownerWindow, "devicePixelRatio", { configurable: true, value: 1 });
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    try {
      memoizeTerminalWidthMeasurements(terminalWithWidthCache(first.cache), ownerDocument);

      expect(first.cache._measure("M", 0)).toBe(7.5);
      Object.defineProperty(ownerWindow, "devicePixelRatio", { configurable: true, value: 2 });
      first.cache.measuredWidth = 8.25;
      expect(first.cache._measure("M", 0)).toBe(8.25);
      expect(shared.measure).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(ownerWindow, "devicePixelRatio", { configurable: true, value: originalDpr });
    }
  });

  it("invalidates a terminal memo on font load and explicit geometry repair", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const fontEvents = new EventTarget();
    Object.defineProperty(ownerDocument, "fonts", {
      configurable: true,
      value: fontEvents
    });
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    const terminal = terminalWithWidthCache(first.cache);
    memoizeTerminalWidthMeasurements(terminal, ownerDocument);

    expect(first.cache._measure("M", 0)).toBe(7.5);
    fontEvents.dispatchEvent(new Event("loadingdone"));
    expect(first.cache._measure("M", 0)).toBe(7.5);
    invalidateTerminalWidthMeasurements(terminal);
    expect(first.cache._measure("M", 0)).toBe(7.5);
    expect(shared.measure).toHaveBeenCalledTimes(3);
  });

  it("starts a fresh memo when xterm replaces the renderer generation", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    const second = widthCache(shared.prototype, 12, 8.25, ownerDocument);
    const terminal = terminalWithWidthCache(first.cache);
    memoizeTerminalWidthMeasurements(terminal, ownerDocument);

    expect(first.cache._measure("M", 0)).toBe(7.5);
    terminal._core._renderService._renderer.value = { _widthCache: second.cache };
    memoizeTerminalWidthMeasurements(terminal, ownerDocument);
    expect(second.cache._measure("M", 0)).toBe(8.25);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("does not memoize oversized untrusted glyph content", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const shared = widthCachePrototype();
    const first = widthCache(shared.prototype, 12, 7.5, ownerDocument);
    memoizeTerminalWidthMeasurements(terminalWithWidthCache(first.cache), ownerDocument);
    const oversizedGlyph = "x".repeat(129);

    expect(first.cache._measure(oversizedGlyph, 0)).toBe(7.5);
    expect(first.cache._measure(oversizedGlyph, 0)).toBe(7.5);
    expect(shared.measure).toHaveBeenCalledTimes(2);
  });

  it("fails open when xterm internals are unavailable", () => {
    expect(memoizeTerminalWidthMeasurements({}, document)).toBe(false);
  });

  it("avoids native write/read pairs for subsequent ASCII glyphs in the same font variant", () => {
    return withMeasuredTerminal(({ cache, nativeMeasure }) => {
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(cache._measure("B", 0)).toBe(7);
      expect(nativeMeasure).toHaveBeenCalledTimes(1);
      expect(cache._measure("W", 3)).toBe(12);
      expect(cache._measure("I", 3)).toBe(7);
      expect(nativeMeasure).toHaveBeenCalledTimes(2);
      expect(cache._container.children).toHaveLength(4);
    });
  });

  it("keeps batch widths local when two terminals have different measured font metrics", () => {
    return withMeasuredTerminal(first => withMeasuredTerminal(second => {
      second.setOffset(2);
      expect(first.cache._measure("W", 0)).toBe(9);
      expect(second.cache._measure("W", 0)).toBe(11);
      expect(first.cache._measure("I", 0)).toBe(4);
      expect(second.cache._measure("I", 0)).toBe(6);
    }));
  });

  it.each(["mismatch", "throw"] as const)("keeps native widths and removes probes after batch %s", failure => {
    return withMeasuredTerminal(({ cache, nativeMeasure, setCloneFailure }) => {
      setCloneFailure(failure);
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(2);
      expect(cache._container.children).toHaveLength(4);
    });
  });

  it("remeasures batched glyphs after font, DPR and explicit geometry invalidation", () => {
    return withMeasuredTerminal(({ terminal, cache, nativeMeasure, ownerWindow, fonts, setOffset }) => {
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      cache.setFont(cache._font, 28, "normal", "bold");
      expect(cache._measure("I", 0)).toBe(8);
      setOffset(1);
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(cache._measure("I", 0)).toBe(10);
      setOffset(2);
      Object.defineProperty(ownerWindow, "devicePixelRatio", { configurable: true, value: 2 });
      expect(cache._measure("I", 0)).toBe(12);
      setOffset(3);
      invalidateTerminalWidthMeasurements(terminal);
      expect(cache._measure("I", 0)).toBe(14);
      expect(nativeMeasure).toHaveBeenCalledTimes(5);
    });
  });

  it("uses native measurements for non-ASCII and combined glyphs", () => {
    return withMeasuredTerminal(({ cache, nativeMeasure }) => {
      expect(cache._measure("λ", 0)).toBe(7);
      expect(cache._measure("e\u0301", 0)).toBe(14);
      expect(cache._measure("😀", 0)).toBe(14);
      expect(nativeMeasure).toHaveBeenCalledTimes(3);
      expect(cache._container.children).toHaveLength(4);
    });
  });

  it("does not prime fallback font widths while fonts are loading", () => {
    return withMeasuredTerminal(({ cache, nativeMeasure, fonts, setOffset }) => {
      fonts.status = "loading";
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(2);
      fonts.status = "loaded";
      setOffset(1);
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(cache._measure("W", 0)).toBe(10);
      expect(cache._measure("I", 0)).toBe(5);
      expect(nativeMeasure).toHaveBeenCalledTimes(3);
    });
  });
  it("does not premeasure characters absent from the viewport or in a different variant", () => {
    return withMeasuredTerminal(({ cache, nativeMeasure }) => {
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(1);
      expect(cache._measure("Z", 0)).toBe(7);
      expect(cache._measure("Q", 0)).toBe(7);
      expect(nativeMeasure).toHaveBeenCalledTimes(3);
      expect(cache._container.children).toHaveLength(4);
    }, "WI\r\n\x1b[1mQ\x1b[0m");
  });

  it("excludes offscreen scrollback and leaves buffer contents and cursor unchanged", () => {
    return withMeasuredTerminal(({ terminal, cache, nativeMeasure }) => {
      const snapshot = () => {
        const buffer = terminal.buffer.active;
        return { type: buffer.type, viewport: buffer.viewportY, base: buffer.baseY,
          x: buffer.cursorX, y: buffer.cursorY,
          lines: Array.from({ length: buffer.length }, (_,row) => buffer.getLine(row)?.translateToString()) };
      };
      const before = snapshot();
      expect(terminal.buffer.active.viewportY).toBeGreaterThan(0);
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(1);
      expect(cache._measure("Z", 0)).toBe(7);
      expect(nativeMeasure).toHaveBeenCalledTimes(2);
      expect(snapshot()).toEqual(before);
    }, "Z\r\n0\r\n0\r\n0\r\nWI");
  });

  it("reads the alternate screen without changing either buffer", () => {
    return withMeasuredTerminal(({ terminal, cache, nativeMeasure }) => {
      const snapshot = () => [terminal.buffer.normal, terminal.buffer.alternate].map(buffer => ({
        type: buffer.type, viewport: buffer.viewportY, base: buffer.baseY,
        x: buffer.cursorX, y: buffer.cursorY,
        lines: Array.from({ length: buffer.length }, (_,row) => buffer.getLine(row)?.translateToString())
      }));
      expect(terminal.buffer.active.type).toBe("alternate");
      const before = snapshot();
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(1);
      expect(snapshot()).toEqual(before);
    }, "NORMAL\x1b[?1049hWI");
  });

  it("keeps native measurement when the viewport scan exceeds its bound", () => {
    return withMeasuredTerminal(({ terminal, cache, nativeMeasure }) => {
      Object.defineProperty(terminal, "rows", { configurable: true, value: 1000 });
      Object.defineProperty(terminal, "cols", { configurable: true, value: 1000 });
      expect(cache._measure("W", 0)).toBe(9);
      expect(cache._measure("I", 0)).toBe(4);
      expect(nativeMeasure).toHaveBeenCalledTimes(2);
      expect(cache._container.children).toHaveLength(4);
    });
  });

});
