/**
 * Rust `str` semantics the search compressor depends on, for its TypeScript port of Headroom
 * (Apache-2.0, Headroom Contributors). Kept private to this folder; the log compressor carries a similar copy.
 */

/** Rust `char::is_whitespace` (Unicode White_Space). Unlike JS `\s` it includes U+0085 and excludes U+FEFF. */
export function isWhitespace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000;
}

/** Rust `u8::is_ascii_whitespace`: space, tab, LF, form feed, CR (not vertical tab). */
export const isAsciiWhitespace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
export const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
export const isAsciiAlpha = (code: number): boolean => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
export const isAsciiAlphanumeric = (code: number): boolean => isAsciiDigit(code) || isAsciiAlpha(code);

/** Rust `str::trim`. */
export function trim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Rust `str::split_whitespace` (all White_Space characters are in the BMP, so code units suffice). */
export function splitWhitespace(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const boundary = i === text.length || isWhitespace(text.charCodeAt(i));
    if (boundary && start >= 0) {
      words.push(text.slice(start, i));
      start = -1;
    } else if (!boundary && start < 0) start = i;
  }
  return words;
}

/** Rust `str::to_ascii_lowercase`: only A-Z change. */
export const asciiLowercase = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** Headroom's CJK ranges (ideographs, kana, Hangul), shared by query scoring and the bigram curve. */
export const isCjkChar = (code: number): boolean => (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf)
  || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);

export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Rust `String` ordering (UTF-8 bytes, i.e. code points). Plain JS comparison orders UTF-16 code units,
 * which puts astral characters before U+E000..U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

const codePointRank = (unit: number): number => (unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit);
