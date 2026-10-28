import type { Terminal } from "@xterm/xterm";

interface XtermWidthCache {
  _font?: unknown;
  _fontSize?: unknown;
  _weight?: unknown;
  _weightBold?: unknown;
  _container?: {
    ownerDocument?: unknown;
    getClientRects?: () => { length: number };
  };
  _measureElements?: unknown;
  _measure?: (content: string, variant: number) => number;
}

interface XtermRenderer {
  value?: {
    _widthCache?: XtermWidthCache;
  };
  _widthCache?: XtermWidthCache;
}

interface XtermWithWidthCache {
  _core?: {
    _renderService?: {
      _renderer?: XtermRenderer;
    };
  };
}

interface DocumentInvalidationState {
  generation: number;
}

interface TerminalMeasurementState {
  cache: XtermWidthCache;
  terminal: Pick<Terminal, "buffer" | "cols" | "rows">;
  measurements: Map<string, number>;
  rejectedAsciiVariants: Set<number>;
  originalMeasure: (content: string, variant: number) => number;
  ownerDocument: Document;
  renderer: object;
  rendererGeneration: number;
  signature: string | null;
  wrappedMeasure: (content: string, variant: number) => number;
  hiddenPass?: boolean;
}

const documentInvalidationStates = new WeakMap<Document, DocumentInvalidationState>();
const terminalMeasurementStates = new WeakMap<object, TerminalMeasurementState>();
const MAX_MEMOIZED_GLYPH_LENGTH = 128;
const MAX_TERMINAL_MEASUREMENTS = 4096;
// Matches the installed xterm DOM WidthCache; each batch is also calibrated
// against its native measurement before any sibling result is reused.
const XTERM_GLYPH_REPEAT = 32;
const ASCII_FIRST = 32;
const ASCII_LAST = 126;
const MAX_GLYPH_SCAN_CELLS = 65_536;

function isFontWeight(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function cacheOwnerDocument(cache: XtermWidthCache, fallback: Document): Document {
  const candidate = cache._container?.ownerDocument;
  return candidate && typeof candidate === "object" && typeof (candidate as Document).createElement === "function"
    ? (candidate as Document)
    : fallback;
}

function documentInvalidationState(ownerDocument: Document): DocumentInvalidationState {
  const existing = documentInvalidationStates.get(ownerDocument);
  if (existing) return existing;

  const state: DocumentInvalidationState = { generation: 0 };
  const invalidate = () => {
    state.generation += 1;
  };
  ownerDocument.fonts?.addEventListener("loadingdone", invalidate);
  ownerDocument.fonts?.addEventListener("loadingerror", invalidate);
  ownerDocument.defaultView?.addEventListener("resize", invalidate);
  ownerDocument.defaultView?.visualViewport?.addEventListener("resize", invalidate);
  documentInvalidationStates.set(ownerDocument, state);
  return state;
}

function terminalMeasurementSignature(state: TerminalMeasurementState): string | null {
  const { cache, ownerDocument, rendererGeneration } = state;
  if (
    typeof cache._font !== "string" ||
    typeof cache._fontSize !== "number" ||
    !Number.isFinite(cache._fontSize) ||
    !isFontWeight(cache._weight) ||
    !isFontWeight(cache._weightBold)
  ) {
    return null;
  }
  return JSON.stringify([
    cache._font,
    cache._fontSize,
    cache._weight,
    cache._weightBold,
    ownerDocument.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
    rendererGeneration,
    documentInvalidationState(ownerDocument).generation
  ]);
}

function storeMeasurement(measurements: Map<string, number>, key: string, width: number): void {
  if (measurements.size >= MAX_TERMINAL_MEASUREMENTS && !measurements.has(key)) {
    const oldestKey = measurements.keys().next().value;
    if (typeof oldestKey === "string") measurements.delete(oldestKey);
  }
  measurements.set(key, width);
}

// Read only the current viewport, using xterm's public buffer API. This does
// not advance the parser, alter scrollback, write content, or retain a transcript.
function visibleAsciiCandidates(
  state: TerminalMeasurementState,
  content: string,
  variant: number
): string[] {
  const { terminal } = state;
  const { rows, cols } = terminal;
  const buffer = terminal.buffer?.active;
  if (
    !buffer || !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) ||
    rows <= 0 || cols <= 0 || rows * cols > MAX_GLYPH_SCAN_CELLS ||
    !Number.isSafeInteger(buffer.viewportY) || buffer.viewportY < 0
  ) return [];

  const candidates = new Set([content]);
  const reusableCell = buffer.getNullCell();
  for (let row = buffer.viewportY; row < buffer.viewportY + rows; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = 0; column < cols; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell) continue;
      const cellVariant = (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0);
      if (cellVariant !== variant) continue;
      const glyph = cell.getChars();
      if (
        glyph.length === 1 && glyph.charCodeAt(0) >= ASCII_FIRST &&
        glyph.charCodeAt(0) <= ASCII_LAST &&
        !state.measurements.has(JSON.stringify([variant, glyph]))
      ) candidates.add(glyph);
    }
  }
  return [...candidates];
}

// Keep all writes before reads, in this terminal's existing font context.
// No measurement is shared across terminals or renderer generations.
function primeVisibleAscii(
  state: TerminalMeasurementState,
  receiver: XtermWidthCache,
  content: string,
  variant: number,
  nativeWidth: number
): void {
  if (
    receiver !== state.cache || content.length !== 1 ||
    content.charCodeAt(0) < ASCII_FIRST || content.charCodeAt(0) > ASCII_LAST ||
    variant < 0 || variant > 3 || state.rejectedAsciiVariants.has(variant)
  ) return;

  const elements = receiver._measureElements;
  if (!Array.isArray(elements)) return;
  const template = elements[variant] as HTMLElement | undefined;
  const container = template?.parentElement;
  if (
    template?.tagName !== "SPAN" || !container?.isConnected ||
    container !== receiver._container ||
    template.ownerDocument !== state.ownerDocument ||
    state.ownerDocument.fonts?.status === "loading"
  ) return;

  const probes: HTMLElement[] = [];
  try {
    const glyphs = visibleAsciiCandidates(state, content, variant);
    if (glyphs.length < 2) return;
    const fragment = state.ownerDocument.createDocumentFragment();
    for (const glyph of glyphs) {
      const probe = template.cloneNode(false) as HTMLElement;
      probe.removeAttribute("id");
      probe.textContent = glyph.repeat(XTERM_GLYPH_REPEAT);
      probes.push(probe);
      fragment.appendChild(probe);
    }
    container.appendChild(fragment);
    const widths = probes.map(probe => probe.offsetWidth / XTERM_GLYPH_REPEAT);
    if (
      widths[0] !== nativeWidth ||
      widths.some(width => !Number.isFinite(width) || width <= 0)
    ) {
      state.rejectedAsciiVariants.add(variant);
      return;
    }
    for (let index = 0; index < glyphs.length; index += 1) {
      storeMeasurement(state.measurements, JSON.stringify([variant, glyphs[index]]), widths[index]!);
    }
  } catch {
    // A failed calibration or unavailable buffer keeps native measurements.
    state.rejectedAsciiVariants.add(variant);
  } finally {
    for (const probe of probes) probe.remove();
  }
}

function measureWithTerminalMemo(
  state: TerminalMeasurementState,
  receiver: XtermWidthCache,
  content: string,
  variant: number
): number {
  // A hidden terminal (display:none) measures every glyph as 0: after the first, the rest of this render pass answers 0
  // without another layout read (operator-approved Warm change 2026-10-26: a hidden render took 36.7 s on the desktop app).
  if (state.hiddenPass) return 0;
  const signature = terminalMeasurementSignature(state);
  if (signature !== state.signature) {
    state.measurements.clear();
    state.rejectedAsciiVariants.clear();
    state.signature = signature;
  }
  if (
    signature === null ||
    content.length > MAX_MEMOIZED_GLYPH_LENGTH ||
    !Number.isInteger(variant)
  ) {
    return state.originalMeasure.call(receiver, content, variant);
  }

  const key = JSON.stringify([variant, content]);
  const cachedWidth = state.measurements.get(key);
  if (cachedWidth !== undefined) return cachedWidth;

  const measuredWidth = state.originalMeasure.call(receiver, content, variant);
  if (measuredWidth === 0 && receiver._container?.getClientRects?.().length === 0) {
    state.hiddenPass = true;
    queueMicrotask(() => { state.hiddenPass = false; });
  }
  if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
    storeMeasurement(state.measurements, key, measuredWidth);
    primeVisibleAscii(state, receiver, content, variant, measuredWidth);
  }
  return measuredWidth;
}

export function invalidateTerminalWidthMeasurements(terminal: unknown): void {
  if (!terminal || typeof terminal !== "object") return;
  const state = terminalMeasurementStates.get(terminal);
  if (!state) return;
  state.measurements.clear();
  state.rejectedAsciiVariants.clear();
  state.signature = null;
}

export function memoizeTerminalWidthMeasurements(terminal: unknown, ownerDocument: Document): boolean {
  if (!terminal || typeof terminal !== "object") return false;
  const renderer = (terminal as XtermWithWidthCache)._core?._renderService?._renderer;
  const rendererIdentity = renderer?.value ?? renderer;
  const widthCache = renderer?.value?._widthCache ?? renderer?._widthCache;
  if (!rendererIdentity || !widthCache || typeof widthCache._measure !== "function") return false;

  const prior = terminalMeasurementStates.get(terminal);
  if (
    prior?.renderer === rendererIdentity &&
    prior.cache === widthCache &&
    widthCache._measure === prior.wrappedMeasure
  ) {
    return true;
  }

  const originalMeasure = widthCache._measure;
  const state = {} as TerminalMeasurementState;
  state.cache = widthCache;
  state.terminal = terminal as Pick<Terminal, "buffer" | "cols" | "rows">;
  state.measurements = new Map();
  state.rejectedAsciiVariants = new Set();
  state.originalMeasure = originalMeasure;
  state.ownerDocument = cacheOwnerDocument(widthCache, ownerDocument);
  state.renderer = rendererIdentity;
  state.rendererGeneration = prior ? prior.rendererGeneration + 1 : 1;
  state.signature = null;
  state.wrappedMeasure = function memoizedTerminalMeasure(
    this: XtermWidthCache,
    content: string,
    variant: number
  ): number {
    return measureWithTerminalMemo(state, this, content, variant);
  };

  try {
    Object.defineProperty(widthCache, "_measure", {
      configurable: true,
      enumerable: false,
      value: state.wrappedMeasure,
      writable: true
    });
  } catch {
    return false;
  }
  terminalMeasurementStates.set(terminal, state);
  return true;
}
