interface XtermWidthCache {
  _font?: unknown;
  _fontSize?: unknown;
  _weight?: unknown;
  _weightBold?: unknown;
  _container?: {
    ownerDocument?: unknown;
  };
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
  measurements: Map<string, number>;
  originalMeasure: (content: string, variant: number) => number;
  ownerDocument: Document;
  renderer: object;
  rendererGeneration: number;
  signature: string | null;
  wrappedMeasure: (content: string, variant: number) => number;
}

const documentInvalidationStates = new WeakMap<Document, DocumentInvalidationState>();
const terminalMeasurementStates = new WeakMap<object, TerminalMeasurementState>();
const MAX_MEMOIZED_GLYPH_LENGTH = 128;
const MAX_TERMINAL_MEASUREMENTS = 4096;

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

function measureWithTerminalMemo(
  state: TerminalMeasurementState,
  receiver: XtermWidthCache,
  content: string,
  variant: number
): number {
  const signature = terminalMeasurementSignature(state);
  if (signature !== state.signature) {
    state.measurements.clear();
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
  if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
    storeMeasurement(state.measurements, key, measuredWidth);
  }
  return measuredWidth;
}

export function invalidateTerminalWidthMeasurements(terminal: unknown): void {
  if (!terminal || typeof terminal !== "object") return;
  const state = terminalMeasurementStates.get(terminal);
  if (!state) return;
  state.measurements.clear();
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
  state.measurements = new Map();
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
