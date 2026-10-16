/** Same ordering as `a.localeCompare(b)` (ECMA-402 default collation) at a fraction of the cost on large graphs. */
export const compareMemoryIds: (a: string, b: string) => number = new Intl.Collator().compare;
