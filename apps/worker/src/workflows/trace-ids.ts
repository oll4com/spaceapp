/** Pure trace helpers for the deterministic workflow sandbox. */
export interface ParsedTraceparent { traceId: string; parentId: string; flags: string }
export function parseTraceparent(value: unknown): ParsedTraceparent | null {
  if (typeof value !== "string") return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, parentId: match[2]!, flags: match[3]! };
}
export function formatTraceparent(traceId: string, spanId: string, flags = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}
export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value);
}
export function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(value);
}
