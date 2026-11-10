type RangeIssue = string | { message: string; path: string[] };

/**
 * Business rule shared by schemas with a range: its end is not before its start, and with `strict` not at it either (ARCH-002).
 * ISO date strings compare as times; a range with an unset bound (an optional one) passes. Spread into `.refine(...)`.
 */
export function orderedRange(start: string, end: string, issue: RangeIssue, strict = false): [(value: object) => boolean, RangeIssue] {
  return [(value) => {
    const record = value as Record<string, unknown>;
    if (record[start] === undefined || record[end] === undefined) return true;
    const from = bound(record[start]);
    const to = bound(record[end]);
    return strict ? to > from : to >= from;
  }, issue];
}

const bound = (value: unknown) => (typeof value === "string" ? Date.parse(value) : (value as number));
