interface XtermWidthCache {
  _font?: unknown;
  _fontSize?: unknown;
  _weight?: unknown;
  _weightBold?: unknown;
  _flat?: unknown;
  _container?: {
    ownerDocument?: unknown;
  };
  _measure?: (content: string, variant: number) => number;
}

interface XtermWithWidthCache {
  _core?: {
    _renderService?: {
      _renderer?: {
        value?: {
          _widthCache?: XtermWidthCache;
        };
        _widthCache?: XtermWidthCache;
      };
    };
  };
}

const measurementsByDocument = new WeakMap<Document, Map<string, number>>();
const patchedWidthCaches = new WeakSet<XtermWidthCache>();
const patchedWidthCachePrototypes = new WeakSet<object>();
const documentsWithFontInvalidation = new WeakSet<Document>();
const MAX_SHARED_GLYPH_LENGTH = 128;
const MAX_SHARED_MEASUREMENTS = 4096;
const MAX_FLAT_CACHE_ENTRIES = 256;

function isFontWeight(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function measurementKey(cache: XtermWidthCache, content: string, variant: number): string | null {
  if (
    content.length > MAX_SHARED_GLYPH_LENGTH ||
    typeof cache._font !== "string" ||
    typeof cache._fontSize !== "number" ||
    !Number.isFinite(cache._fontSize) ||
    !isFontWeight(cache._weight) ||
    !isFontWeight(cache._weightBold) ||
    !Number.isInteger(variant)
  ) {
    return null;
  }
  return JSON.stringify([
    cache._font,
    cache._fontSize,
    cache._weight,
    cache._weightBold,
    variant,
    content
  ]);
}

function documentMeasurements(ownerDocument: Document): Map<string, number> {
  let measurements = measurementsByDocument.get(ownerDocument);
  if (!measurements) {
    measurements = new Map<string, number>();
    measurementsByDocument.set(ownerDocument, measurements);
  }
  if (!documentsWithFontInvalidation.has(ownerDocument)) {
    documentsWithFontInvalidation.add(ownerDocument);
    const clearMeasurements = () => measurements?.clear();
    ownerDocument.fonts?.addEventListener("loadingdone", clearMeasurements);
    ownerDocument.fonts?.addEventListener("loadingerror", clearMeasurements);
  }
  return measurements;
}

function cacheOwnerDocument(cache: XtermWidthCache, fallback: Document): Document {
  const candidate = cache._container?.ownerDocument;
  return candidate && typeof candidate === "object" && typeof (candidate as Document).createElement === "function"
    ? (candidate as Document)
    : fallback;
}

function storeMeasurement(measurements: Map<string, number>, key: string, width: number): void {
  if (measurements.size >= MAX_SHARED_MEASUREMENTS && !measurements.has(key)) {
    const oldestKey = measurements.keys().next().value;
    if (typeof oldestKey === "string") measurements.delete(oldestKey);
  }
  measurements.set(key, width);
}

function seedFlatMeasurements(cache: XtermWidthCache, ownerDocument: Document): void {
  const flat = cache._flat;
  if (!flat || typeof flat !== "object" || !("length" in flat)) return;
  const length = Number((flat as ArrayLike<unknown>).length);
  if (!Number.isInteger(length) || length <= 0) return;
  const measurements = documentMeasurements(cacheOwnerDocument(cache, ownerDocument));
  for (let codePoint = 0; codePoint < Math.min(length, MAX_FLAT_CACHE_ENTRIES); codePoint += 1) {
    const width = (flat as ArrayLike<unknown>)[codePoint];
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) continue;
    const key = measurementKey(cache, String.fromCharCode(codePoint), 0);
    if (key) storeMeasurement(measurements, key, width);
  }
}

function measureWithBrowserCache(
  cache: XtermWidthCache,
  measure: (content: string, variant: number) => number,
  ownerDocument: Document,
  content: string,
  variant: number
): number {
  const measurements = documentMeasurements(cacheOwnerDocument(cache, ownerDocument));
  const key = measurementKey(cache, content, variant);
  if (key) {
    const cachedWidth = measurements.get(key);
    if (cachedWidth !== undefined) return cachedWidth;
  }
  const measuredWidth = measure.call(cache, content, variant);
  if (key && Number.isFinite(measuredWidth) && measuredWidth > 0) {
    storeMeasurement(measurements, key, measuredWidth);
  }
  return measuredWidth;
}

export function memoizeTerminalWidthMeasurements(terminal: unknown, ownerDocument: Document): boolean {
  const renderer = (terminal as XtermWithWidthCache)?._core?._renderService?._renderer;
  const widthCache = renderer?.value?._widthCache ?? renderer?._widthCache;
  if (!widthCache || typeof widthCache._measure !== "function") return false;
  seedFlatMeasurements(widthCache, ownerDocument);

  // Xterm's DOM renderer keeps one WidthCache per terminal. Reuse only the expensive,
  // immutable numeric measurements; renderer state and each terminal's own cache stay isolated.
  const prototype = Object.getPrototypeOf(widthCache) as XtermWidthCache | null;
  if (
    prototype &&
    typeof prototype._measure === "function" &&
    !Object.prototype.hasOwnProperty.call(widthCache, "_measure")
  ) {
    if (!patchedWidthCachePrototypes.has(prototype)) {
      const measure = prototype._measure;
      prototype._measure = function measureWithSharedBrowserCache(content: string, variant: number): number {
        return measureWithBrowserCache(this, measure, ownerDocument, content, variant);
      };
      patchedWidthCachePrototypes.add(prototype);
    }
    return true;
  }

  if (patchedWidthCaches.has(widthCache)) return true;
  const measure = widthCache._measure;
  widthCache._measure = function measureWithInstanceBrowserCache(content: string, variant: number): number {
    return measureWithBrowserCache(this, measure, ownerDocument, content, variant);
  };
  patchedWidthCaches.add(widthCache);
  return true;
}
