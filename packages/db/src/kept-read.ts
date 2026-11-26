/**
 * One owner's read, kept until this process writes (`patch` puts the written row in the kept answer, `drop` forgets it) or `ms` pass:
 * calls that meet share the read, a failed read is forgotten.
 * For tables only one repository instance writes (speed audit 14/11: the newest pane report and pane summary per pane).
 * Speed slice 25 (14/11): at 60 s and dropped on every write, the reads still ran ~1.5 times a minute (stable: 135 ms mean, 10.9 s
 * worst, ~15,000 pages each, inside every Nous world and pane board); a write is applied to the kept answer and the age is an hour.
 */
// shortcut: a row written outside this process (a restore, manual SQL) shows after `ms` (or the hourly prune); LISTEN/NOTIFY if a second writer appears.
export function keptRead<T>(read: (owner: string) => Promise<T>, ms = 3_600_000) {
  const kept = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(owner: string): Promise<T> {
      let entry = kept.get(owner);
      if (!entry || Date.now() - entry.at >= ms) {
        const fresh = { at: Date.now(), value: read(owner) };
        fresh.value.catch(() => { if (kept.get(owner) === fresh) kept.delete(owner); });
        kept.set(owner, entry = fresh);
      }
      return entry.value;
    },
    /** After a write that succeeded: the kept answer with the write in it (a read still under way gets it when it ends). */
    patch(owner: string, change: (value: T) => T) {
      const entry = kept.get(owner);
      if (!entry) return;
      entry.value = entry.value.then(change);
      entry.value.catch(() => { if (kept.get(owner) === entry) kept.delete(owner); });
    },
    /** After a failed write (it may have reached the table) and a delete; no owner: every owner. */
    drop(owner?: string) { if (owner === undefined) kept.clear(); else kept.delete(owner); }
  };
}

/** `rows` (the newest row of each key) with `row` in its key's place unless the kept one is newer (`at`, then the id, as the reads order them). */
export function withNewest<R extends { id: string }>(rows: R[], row: R, key: (row: R) => string | null, at: (row: R) => string): R[] {
  const index = rows.findIndex((entry) => key(entry) === key(row));
  if (index < 0) return [...rows, row];
  const kept = rows[index]!;
  return at(kept) > at(row) || (at(kept) === at(row) && Number(kept.id) > Number(row.id)) ? rows : rows.map((entry, position) => (position === index ? row : entry));
}
