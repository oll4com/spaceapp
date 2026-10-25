/**
 * Numeric helpers: Python `statistics` semantics (sample variance, n-1) and the exact float formatting
 * that Headroom's strategy strings rely on. Rust `{:.N}`/`{:.Ne}` round the exact binary value
 * half-to-even, which `Number#toFixed` does not, so rounding goes through BigInt here.
 */
export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const value of values) sum += value;
  const result = sum / values.length;
  return Number.isFinite(result) ? result : undefined;
}

export function sampleVariance(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = mean(values);
  if (m === undefined) return undefined;
  let sum = 0;
  for (const value of values) sum += (value - m) ** 2;
  const variance = sum / (values.length - 1);
  return Number.isFinite(variance) ? variance : undefined;
}

export function sampleStdev(values: readonly number[]): number | undefined {
  const variance = sampleVariance(values);
  return variance === undefined ? undefined : Math.sqrt(variance);
}

export const sortNumbers = (values: readonly number[]) => [...values].sort((a, b) => a - b);

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = sortNumbers(values);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Python `round()` / Rust `round_ties_even`. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Rust `x as usize`: truncate toward zero, saturate at zero. */
export const toUsize = (x: number) => (Number.isNaN(x) ? 0 : Math.max(0, Math.trunc(x)));

/** `|x|` as an exact rational `num / den` (both BigInt). */
function exactRational(x: number): [bigint, bigint] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

/** `round_half_even(|x| * 10^power)` computed exactly. */
function scaledRound(x: number, power: number): bigint {
  let [num, den] = exactRational(x);
  if (power >= 0) num *= 10n ** BigInt(power);
  else den *= 10n ** BigInt(-power);
  const quotient = num / den;
  const twice = (num % den) * 2n;
  return twice > den || (twice === den && quotient % 2n === 1n) ? quotient + 1n : quotient;
}

/** Rust `format!("{:.digits$}", x)` for finite `x`. */
export function toFixedExact(x: number, digits: number): string {
  const text = scaledRound(x, digits).toString().padStart(digits + 1, "0");
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  return digits === 0 ? sign + text : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Headroom `format_g`: an approximation of Python `f"{x:.4g}"` (floor(log10) picks the notation). */
export function formatG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 4) return formatScientific(x);
  const fixed = toFixedExact(x, Math.max(3 - exp, 0));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** Rust `{:.3e}` (exact, half-even) normalized to Python's `1.234e+05` exponent form. */
function formatScientific(x: number): string {
  let exp = Math.floor(Math.log10(Math.abs(x)));
  const [num, den] = exactRational(x);
  // Exact correction of the floating-point log10 estimate so that 10^exp <= |x| < 10^(exp + 1).
  const below = (e: number) => (e >= 0 ? num < 10n ** BigInt(e) * den : num * 10n ** BigInt(-e) < den);
  while (below(exp)) exp--;
  while (!below(exp + 1)) exp++;
  let digits = scaledRound(x, 3 - exp);
  if (digits >= 10000n) {
    exp++;
    digits = scaledRound(x, 3 - exp);
  }
  const text = digits.toString();
  const mantissa = `${text[0]}.${text.slice(1)}`.replace(/0+$/, "").replace(/\.$/, "");
  return `${x < 0 ? "-" : ""}${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Rust `format!("{}", x)` for `f64`: shortest round-trip digits, never exponent notation. */
export function rustDisplayF64(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const [mantissa, exponentText] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const point = Number(exponentText) + 1;
  let body: string;
  if (point <= 0) body = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) body = digits + "0".repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (x < 0 || Object.is(x, -0) ? "-" : "") + body;
}

/** numpy-style linear-interpolation percentile over sorted values. */
export function percentileLinear(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const position = q * (sorted.length - 1);
  const lo = Math.trunc(position);
  const hi = lo + 1 < sorted.length ? lo + 1 : lo;
  const fraction = position - lo;
  return sorted[lo]! * (1 - fraction) + sorted[hi]! * fraction;
}
