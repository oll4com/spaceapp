import { memoryQueryTerms, memoryTermMatches, normalizeMemoryQuery } from "./query-normalization.js";

/** Overlapping raw-text windows keep normalized matching separate from display offsets. */
export function memoryTextWindows(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const windows: string[] = [];
  const stride = Math.max(1, Math.floor(width / 4));
  for (let start = 0; start < text.length; start += stride) {
    windows.push(text.slice(start, start + width));
    if (start + width >= text.length) break;
  }
  return windows;
}

/** Return actual source text around the strongest evidence, within the character budget. */
export function memoryExcerpt(body: string, query: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const width = Math.max(1, maxChars - 2);
  const terms = memoryQueryTerms(query);
  const stride = Math.max(1, Math.floor(width / 4));
  let bestStart = 0, bestScore = -1, bestCenterScore = -1;
  for (let start = 0; start < body.length; start += stride) {
    const text = normalizeMemoryQuery(body.slice(start, start + width));
    const score = terms.filter(term => memoryTermMatches(text, term)).length;
    const center = normalizeMemoryQuery(body.slice(start + stride, start + width - stride));
    const centerScore = terms.filter(term => memoryTermMatches(center, term)).length;
    if (score > bestScore || (score === bestScore && centerScore > bestCenterScore)) {
      bestScore = score; bestCenterScore = centerScore; bestStart = start;
    }
    if (start + width >= body.length) break;
  }
  return `${bestStart ? "…" : ""}${body.slice(bestStart, bestStart + width)}${bestStart + width < body.length ? "…" : ""}`;
}
