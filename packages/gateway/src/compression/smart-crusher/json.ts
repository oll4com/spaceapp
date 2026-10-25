/**
 * JSON value model for the SmartCrusher port. Headroom builds `serde_json` with `preserve_order` and
 * `arbitrary_precision`, so objects keep insertion order (a `Map` here, never a plain object, which would
 * reorder integer-like keys) and numbers keep their exact source text (`1.50` stays `1.50`, `1` != `1.0`).
 */
export class JsonNumber {
  constructor(readonly raw: string) {}
}

export type JsonObject = Map<string, JsonValue>;
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

export const isObject = (value: JsonValue | undefined): value is JsonObject => value instanceof Map;

/** `Value::as_f64` under `arbitrary_precision`: parse the source text, reject non-finite results. */
export function asF64(value: JsonValue | undefined): number | undefined {
  if (!(value instanceof JsonNumber)) return undefined;
  const parsed = Number(value.raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `serde_json::Value` equality: numbers compare by source text. */
export function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a instanceof JsonNumber) return b instanceof JsonNumber && a.raw === b.raw;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]));
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, item] of a) if (!b.has(key) || !jsonEquals(item, b.get(key))) return false;
    return true;
  }
  return false;
}

/** Rust `str` ordering (UTF-8 bytes == code points), not JavaScript's UTF-16 code-unit order. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === length) return a.length - b.length;
  const x = a.charCodeAt(i);
  const y = b.charCodeAt(i);
  const xSurrogate = x >= 0xd800 && x <= 0xdfff;
  // Code-unit order equals code-point order unless exactly one side starts a supplementary character.
  if (xSurrogate === (y >= 0xd800 && y <= 0xdfff)) return x - y;
  return xSurrogate ? 1 : -1;
}

// Rust `char::is_whitespace` (Unicode White_Space); JavaScript's `\s` differs (adds U+FEFF, drops U+0085).
const WS = "\\t\\n\\u000b\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const wsRun = new RegExp(`[${WS}]+`, "u");
const wsChar = new RegExp(`[${WS}]`, "u");
const wsEdges = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");
const wsStart = new RegExp(`^[${WS}]+`, "u");

export const rustTrim = (s: string) => s.replace(wsEdges, "");
export const rustTrimStart = (s: string) => s.replace(wsStart, "");
export const hasWhitespace = (s: string) => wsChar.test(s);
export const splitWhitespace = (s: string) => s.split(wsRun).filter((word) => word !== "");
export function utf8Length(s: string): number {
  if (s.length > 256) return Buffer.byteLength(s, "utf8");
  let bytes = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) bytes += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 2;
      i++;
    } else bytes += 2;
  }
  return bytes;
}

/** Rust `chars().count()`: code points (a surrogate pair counts once). */
export function charCount(s: string): number {
  let count = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      count--;
      i++;
    }
  }
  return count;
}

class ParseError extends Error {}

/** `serde_json::from_str` strictness: RFC 8259 grammar, recursion limit 128, paired surrogates only. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    const parser = new Parser(text);
    parser.skipWhitespace();
    const value = parser.value(128);
    parser.skipWhitespace();
    return parser.pos === text.length ? value : undefined;
  } catch (error) {
    if (error instanceof ParseError || error instanceof RangeError) return undefined;
    throw error;
  }
}

class Parser {
  pos = 0;
  constructor(private readonly text: string) {}

  skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }

  value(depth: number): JsonValue {
    const c = this.text[this.pos];
    if (c === "{" || c === "[") {
      if (depth - 1 === 0) throw new ParseError("recursion limit exceeded");
      return c === "{" ? this.object(depth - 1) : this.array(depth - 1);
    }
    if (c === '"') return this.string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
    for (const [literal, result] of [["null", null], ["true", true], ["false", false]] as const) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return result;
      }
    }
    throw new ParseError("expected value");
  }

  private object(depth: number): JsonObject {
    const map: JsonObject = new Map();
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return map;
    }
    for (;;) {
      if (this.text[this.pos] !== '"') throw new ParseError("expected key");
      const key = this.string();
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") throw new ParseError("expected colon");
      this.pos++;
      this.skipWhitespace();
      map.set(key, this.value(depth));
      this.skipWhitespace();
      const next = this.text[this.pos++];
      if (next === "}") return map;
      if (next !== ",") throw new ParseError("expected comma");
      this.skipWhitespace();
    }
  }

  private array(depth: number): JsonValue[] {
    const items: JsonValue[] = [];
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.value(depth));
      this.skipWhitespace();
      const next = this.text[this.pos++];
      if (next === "]") return items;
      if (next !== ",") throw new ParseError("expected comma");
      this.skipWhitespace();
    }
  }

  private number(): JsonNumber {
    const start = this.pos;
    if (this.text[this.pos] === "-") this.pos++;
    if (this.text[this.pos] === "0") {
      this.pos++;
      if (this.isDigit()) throw new ParseError("leading zero");
    } else if (!this.digits()) throw new ParseError("invalid number");
    if (this.text[this.pos] === ".") {
      this.pos++;
      if (!this.digits()) throw new ParseError("invalid number");
    }
    if (this.text[this.pos] === "e" || this.text[this.pos] === "E") {
      this.pos++;
      if (this.text[this.pos] === "+" || this.text[this.pos] === "-") this.pos++;
      if (!this.digits()) throw new ParseError("invalid number");
    }
    return new JsonNumber(this.text.slice(start, this.pos));
  }

  private isDigit(): boolean {
    const c = this.text.charCodeAt(this.pos);
    return c >= 0x30 && c <= 0x39;
  }

  private digits(): boolean {
    const start = this.pos;
    while (this.isDigit()) this.pos++;
    return this.pos > start;
  }

  private string(): string {
    this.pos++;
    let out = "";
    let chunk = this.pos;
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (Number.isNaN(c) || c < 0x20) throw new ParseError("unterminated string or control character");
      if (c === 0x22) {
        out += this.text.slice(chunk, this.pos++);
        return out;
      }
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += this.text.slice(chunk, this.pos);
      const escape = this.text[this.pos + 1];
      this.pos += 2;
      const simple = escape === undefined ? undefined : SIMPLE_ESCAPES[escape];
      if (simple !== undefined) out += simple;
      else if (escape === "u") out += this.unicodeEscape();
      else throw new ParseError("invalid escape");
      chunk = this.pos;
    }
  }

  private unicodeEscape(): string {
    const high = this.hex4();
    if (high >= 0xdc00 && high <= 0xdfff) throw new ParseError("lone surrogate");
    if (high < 0xd800 || high > 0xdbff) return String.fromCharCode(high);
    if (this.text[this.pos] !== "\\" || this.text[this.pos + 1] !== "u") throw new ParseError("lone surrogate");
    this.pos += 2;
    const low = this.hex4();
    if (low < 0xdc00 || low > 0xdfff) throw new ParseError("lone surrogate");
    return String.fromCharCode(high, low);
  }

  private hex4(): number {
    const digits = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new ParseError("invalid unicode escape");
    this.pos += 4;
    return Number.parseInt(digits, 16);
  }
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NAMED_ESCAPES: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
const escapeUnit = (c: string) => NAMED_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

const ESCAPE = /["\\\u0000-\u001f]/;
const ESCAPE_ALL = /["\\\u0000-\u001f]/g;
const ESCAPE_ASCII = /["\\\u0000-\u001f\u007f-\uffff]/;
const ESCAPE_ASCII_ALL = /["\\\u0000-\u001f\u007f-\uffff]/g;

function quote(s: string, ensureAscii: boolean): string {
  if (!(ensureAscii ? ESCAPE_ASCII : ESCAPE).test(s)) return `"${s}"`;
  return `"${s.replace(ensureAscii ? ESCAPE_ASCII_ALL : ESCAPE_ALL, escapeUnit)}"`;
}

/**
 * `serde_json::to_string` — compact, raw UTF-8, insertion order. Byte-identical to Headroom's
 * `python_safe_json_dumps`, which re-serializes the crushed document.
 */
export function toJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return quote(value, false);
  if (value instanceof JsonNumber) return value.raw;
  let out: string;
  if (Array.isArray(value)) {
    out = "[";
    for (let i = 0; i < value.length; i++) out += (i === 0 ? "" : ",") + toJson(value[i]!);
    return out + "]";
  }
  out = "{";
  for (const [key, item] of value) out += (out.length === 1 ? "" : ",") + quote(key, false) + ":" + toJson(item);
  return out + "}";
}

/** Python `json.dumps(value[, sort_keys=True])`: `", "`/`": "` separators, ASCII-escaped (`\uXXXX`). */
export function pythonJsonDumps(value: JsonValue, sortKeys: boolean): string {
  if (value === null || typeof value === "boolean" || value instanceof JsonNumber) return toJson(value);
  if (typeof value === "string") return quote(value, true);
  if (Array.isArray(value)) return `[${value.map((item) => pythonJsonDumps(item, sortKeys)).join(", ")}]`;
  const keys = [...value.keys()];
  if (sortKeys) keys.sort(compareCodePoints);
  return `{${keys.map((key) => `${quote(key, true)}: ${pythonJsonDumps(value.get(key)!, sortKeys)}`).join(", ")}}`;
}

/** Python `str(v)` as Headroom approximates it for uniqueness counting (`None`, `True`, unquoted strings). */
export function pythonStr(value: JsonValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  return toJson(value);
}

/** Rust `Display` of a scalar `Value` (`true`, `1.5`, unquoted strings) — used as a frequency key. */
export function scalarText(value: JsonValue): string {
  return typeof value === "string" ? value : toJson(value);
}

/** `serde_json::Map::remove` under `preserve_order` is `swap_remove`: the last entry fills the hole. */
export function swapRemove(map: JsonObject, key: string): void {
  const keys = [...map.keys()];
  const index = keys.indexOf(key);
  if (index < 0) return;
  const lastKey = keys[keys.length - 1]!;
  if (index === keys.length - 1) {
    map.delete(key);
    return;
  }
  const lastValue = map.get(lastKey)!;
  const entries = [...map];
  entries[index] = [lastKey, lastValue];
  entries.pop();
  map.clear();
  for (const [k, v] of entries) map.set(k, v);
}
