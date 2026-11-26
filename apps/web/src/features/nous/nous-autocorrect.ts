// Operator request 2026-11-26: Greek + English spelling in the Nous chat that works like Android's keyboard (Gboard).
// The desktop app's preload exposes Chromium's spellchecker (spaceDesktop.spellcheck); a plain browser only underlines.
export type DesktopSpell = { isMisspelled: (word: string) => boolean; suggestions: (word: string) => string[] };
export type Correction = { start: number; original: string; replacement: string; boundary: string };

export const desktopSpell = (): DesktopSpell | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { spaceDesktop?: { spellcheck?: DesktopSpell } }).spaceDesktop?.spellcheck;

const BOUNDARY = /^[\s.,;:!?·)\]]$/u;
const WORD_BEFORE = /[\p{L}\p{M}'’]+$/u;
const bare = (word: string) => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Gboard corrects only a near miss: a suggestion further than two edits from the typed word is a guess, not a typo.
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The word before a just-typed space or punctuation at caret-1, swapped for the first suggestion when it is a near miss; null otherwise. */
export function autocorrect(text: string, caret: number, spell: DesktopSpell, kept: ReadonlySet<string>): Correction | null {
  const boundary = text[caret - 1];
  if (!boundary || !BOUNDARY.test(boundary)) return null;
  const original = WORD_BEFORE.exec(text.slice(0, caret - 1))?.[0];
  if (!original || original.length < 2 || kept.has(original)) return null;
  const start = caret - 1 - original.length;
  // Inside a link, path, handle, code or a word with digits; an inner capital (camelCase, ABC): names, not typos.
  if (/[\p{N}_@/\\#.:=-]/u.test(text[start - 1] ?? "")) return null;
  if (/\p{Lu}/u.test(original.slice(1))) return null;
  if (!spell.isMisspelled(original)) return null;
  const suggestions = spell.suggestions(original);
  // A missing Greek accent is the common typo, but Hunspell may rank a rarer stress first (καλήμερα before καλημέρα):
  // use the only accent-only variant; with two or more, guessing the stress is wrong too often, so leave the word underlined.
  const accentOnly = suggestions.filter((s) => s !== original && bare(s) === bare(original));
  if (accentOnly.length > 1) return null;
  const replacement = accentOnly[0] ?? suggestions[0];
  if (!replacement || replacement === original || edits(original.toLowerCase(), replacement.toLowerCase()) > 2) return null;
  return { start, original, replacement, boundary };
}

export const applyCorrection = (text: string, c: Correction) => ({
  text: text.slice(0, c.start) + c.replacement + text.slice(c.start + c.original.length),
  caret: c.start + c.replacement.length + c.boundary.length
});

/** Backspace right after a correction: the typed word comes back with its space or punctuation (as Android's keyboard does); null when the text moved on. */
export function undoCorrection(text: string, caret: number, c: Correction): { text: string; caret: number } | null {
  const end = c.start + c.replacement.length + c.boundary.length;
  if (caret !== end || text.slice(c.start, end) !== c.replacement + c.boundary) return null;
  return { text: text.slice(0, c.start) + c.original + text.slice(end - c.boundary.length), caret: c.start + c.original.length + c.boundary.length };
}
