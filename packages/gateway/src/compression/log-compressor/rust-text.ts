/**
 * Rust `str` helpers the log compressor relies on. TypeScript port support for Headroom
 * `crates/headroom-core/src/transforms/log_compressor.rs` (Apache-2.0, Headroom Contributors).
 *
 * Rust's `trim_start`, `trim` and `split_whitespace` use the Unicode `White_Space` property, which differs
 * from JavaScript's `\s` (JS adds U+FEFF and omits U+0085), so the exact set is spelled out here.
 */
const WHITE_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const leadingWhiteSpace = new RegExp(`^[${WHITE_SPACE}]+`);
const trailingWhiteSpace = new RegExp(`[${WHITE_SPACE}]+$`);
const whiteSpaceRun = new RegExp(`[${WHITE_SPACE}]+`);
const whiteSpaceChar = new RegExp(`^[${WHITE_SPACE}]$`);

export const trimStart = (text: string): string => text.replace(leadingWhiteSpace, "");

export const trim = (text: string): string => text.replace(leadingWhiteSpace, "").replace(trailingWhiteSpace, "");

export const isWhiteSpace = (char: string): boolean => whiteSpaceChar.test(char);

/** `str::split_whitespace`: no empty pieces. */
export const splitWhiteSpace = (text: string): string[] => text.split(whiteSpaceRun).filter((piece) => piece !== "");

export const isAsciiDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";

/** Number of leading ASCII digits. */
export function leadingDigits(text: string): number {
  let count = 0;
  while (isAsciiDigit(text[count])) count += 1;
  return count;
}

/** `str::starts_with([' ', '\t'])`. */
export const startsIndented = (text: string): boolean => text.startsWith(" ") || text.startsWith("\t");

/** `str::len()`: UTF-8 byte length. */
export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
