/**
 * Small helpers that reproduce Rust standard-library and `regex`-crate semantics the Headroom diff transforms
 * depend on, so the TypeScript port of Headroom's `diff_compressor.rs` / `unidiff_detector.rs` (Apache-2.0,
 * Headroom Contributors) matches byte for byte. Private to the diff-compressor folder; candidates for a shared
 * `compression/rust-compat` module once other Headroom ports need them.
 */

/** `usize::MAX` on the 64-bit targets Headroom ships. */
export const USIZE_MAX = (1n << 64n) - 1n;

/**
 * Body of the Rust `regex` crate's Unicode `\w` class (UTS #18 Annex C): Alphabetic, Mark, Decimal_Number,
 * Connector_Punctuation, Join_Control. Use with the `u` flag. JavaScript's `\w`/`\b` are ASCII-only.
 */
const RUST_WORD_CHARS = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";

/**
 * Builds a `u`-flag regex source for Rust's `\b(alt1|alt2|...)\b` when every alternative starts and ends with a
 * word character: Unicode word boundaries expressed as look-arounds.
 */
export function rustWordBounded(alternation: string): string {
  return `(?<![${RUST_WORD_CHARS}])(?:${alternation})(?![${RUST_WORD_CHARS}])`;
}

/** Rust `char::is_whitespace` (Unicode White_Space). Differs from JS `\s`: includes U+0085, excludes U+FEFF. */
const RUST_WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** Rust `str::split_whitespace()`. */
export function splitRustWhitespace(text: string): string[] {
  return text.split(RUST_WHITESPACE).filter((part) => part !== "");
}

/** Rust `str::len()`: the UTF-8 byte length. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Orders strings like Rust `String`'s `Ord` (UTF-8 byte order), which `BTreeMap` iteration follows. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Rust `str::lines()`: splits on `\n`, strips one `\r` before each `\n`, yields no trailing empty line for a
 * final newline, and keeps a bare `\r` at the very end (Rust >= 1.77 behaviour; Headroom pins 1.95).
 */
export function rustLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const terminated = text.endsWith("\n");
  if (terminated) parts.pop();
  const lastTerminated = terminated ? parts.length : parts.length - 1;
  for (let index = 0; index < lastTerminated; index += 1) {
    const part = parts[index]!;
    if (part.endsWith("\r")) parts[index] = part.slice(0, -1);
  }
  return parts;
}

/**
 * `<usize as FromStr>::from_str` for a regex `\d+` capture. The Rust `regex` crate's `\d` is Unicode
 * `\p{Nd}`, but the integer parser only accepts ASCII digits, so non-ASCII digits and values above
 * `usize::MAX` return `null` (Rust `Err`).
 */
export function parseRustUsize(digits: string): bigint | null {
  if (!/^[0-9]+$/.test(digits)) return null;
  const value = BigInt(digits);
  return value > USIZE_MAX ? null : value;
}

/**
 * Rust `format!("{:.N}", value)` for an `f64`: exact decimal expansion with round-half-to-even on ties
 * (`Number.prototype.toFixed` rounds ties up), `-` kept on negative zero, `inf` / `NaN` spelled like Rust.
 */
export function formatRustFixed(value: number, precision: number): string {
  if (Number.isNaN(value)) return "NaN";
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === Infinity) return negative ? "-inf" : "inf";
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biasedExponent === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biasedExponent === 0 ? 1 : biasedExponent) - 1075;
  const scale = 10n ** BigInt(precision);
  let scaled: bigint;
  if (exponent >= 0) {
    scaled = (mantissa << BigInt(exponent)) * scale;
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    scaled = numerator / denominator;
    const twiceRemainder = (numerator % denominator) * 2n;
    if (twiceRemainder > denominator || (twiceRemainder === denominator && scaled % 2n === 1n)) scaled += 1n;
  }
  const digits = scaled.toString().padStart(precision + 1, "0");
  const integerPart = digits.slice(0, digits.length - precision);
  const fractionPart = digits.slice(digits.length - precision);
  return `${negative ? "-" : ""}${integerPart}${precision > 0 ? `.${fractionPart}` : ""}`;
}
