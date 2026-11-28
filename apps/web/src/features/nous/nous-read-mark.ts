/** A box in viewport px (getBoundingClientRect's top and bottom). */
export type ReadBox = { top: number; bottom: number };

/**
 * The Conversation's last-read mark (operator nous_msg:443bb5d5: a yellow band on the scrollbar down to where they left off): the newest
 * time of the last row read. `ats` are the rows' newest times, oldest first; `box(i)` the row's box. A row is read once the view showed it
 * whole. `seen` keeps the rows whose end the view has shown, and the mark moves through the unbroken run of seen rows after it: opening at
 * the newest message jumps past the first unread row and leaves it unread, while a row that shifted out of view after it was seen (rows
 * above taking their real height, operator 27/11) no longer stops the band.
 */
export function nextReadMark(ats: readonly string[], box: (index: number) => ReadBox, mark: string | null, view: ReadBox, seen: Set<string>): string | null {
  let last = -1;
  for (let low = 0, high = ats.length - 1; low <= high;) {
    const middle = (low + high) >> 1;
    if (box(middle).bottom <= view.bottom + 1) { last = middle; low = middle + 1; } else high = middle - 1;
  }
  if (last < 0) return mark;
  if (mark === null) return ats[last]!;
  for (let index = last; index >= 0 && box(index).bottom > view.top; index--) seen.add(ats[index]!);
  let read = readRows(ats, mark);
  while (read < ats.length && seen.has(ats[read]!)) read++;
  return read && ats[read - 1]! > mark ? ats[read - 1]! : mark;
}

/** How many rows (oldest first) the mark covers. */
export const readRows = (ats: readonly string[], mark: string | null): number => mark === null ? 0 : ats.filter((at) => at <= mark).length;
