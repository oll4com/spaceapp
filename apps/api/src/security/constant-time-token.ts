import { timingSafeEqual } from "node:crypto";

const MAX_TOKEN_BYTES = 512;

export function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export function secureTokenMatches(
  expected: string | null,
  submitted: string | string[] | undefined
): boolean {
  const actual = headerString(submitted);
  if (!expected || !actual) return false;

  const expectedByteLength = Buffer.byteLength(expected, "utf8");
  const actualByteLength = Buffer.byteLength(actual, "utf8");
  if (
    expectedByteLength === 0 ||
    expectedByteLength > MAX_TOKEN_BYTES ||
    actualByteLength > MAX_TOKEN_BYTES ||
    expectedByteLength !== actualByteLength
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(actual, "utf8")
  );
}
