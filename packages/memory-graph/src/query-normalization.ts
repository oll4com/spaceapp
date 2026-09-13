const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
const months = [
  ["january", "ιανουαριοσ", "ιανουαριου"], ["february", "φεβρουαριοσ", "φεβρουαριου"],
  ["march", "μαρτιοσ", "μαρτιου"], ["april", "απριλιοσ", "απριλιου"],
  ["may", "μαιοσ", "μαιου"], ["june", "ιουνιοσ", "ιουνιου"],
  ["july", "ιουλιοσ", "ιουλιου"], ["august", "αυγουστοσ", "αυγουστου"],
  ["september", "σεπτεμβριοσ", "σεπτεμβριου"], ["october", "οκτωβριοσ", "οκτωβριου"],
  ["november", "νοεμβριοσ", "νοεμβριου"], ["december", "δεκεμβριοσ", "δεκεμβριου"]
];

/** Normalize valid written dates without rewriting canonical display text. */
export function normalizeMemoryDates(text: string): string {
  const iso = (original: string, day: string, month: string, year: string) => {
    const m = months.findIndex(names => names.includes(fold(month)));
    if (m < 0) return original;
    const date = new Date(Date.UTC(Number(year), m, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== m || date.getUTCDate() !== Number(day)) return original;
    return `${year}-${String(m + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  };
  return text.replace(/(?<![\p{L}\p{N}])(\d{1,2})\s+(\p{L}+)\s+(\d{4})(?!\d)/gu,
    (all, day, month, year) => iso(all, day, month, year))
    .replace(/(?<![\p{L}\p{N}])(\p{L}+)\s+(\d{1,2}),?\s+(\d{4})(?!\d)/gu,
      (all, month, day, year) => iso(all, day, month, year));
}

// Small operational vocabulary, applied symmetrically to query and documents.
// This is lexical normalization, not unrestricted translation or fuzzy IDs.
const aliases: Record<string, string> = {
  μνημη: "memory", μνημησ: "memory", αναμνηση: "memory", αναμνησεισ: "memory",
  εξωτερικο: "external", εξωτερικη: "external", εξωτερικα: "external", εξωτερικου: "external",
  κανονικη: "canonical", κανονικησ: "canonical", λειτουργικη: "operational", λειτουργικησ: "operational",
  προεπιλεγμενο: "default", προεπιλεγμενη: "default", προεπιλογη: "default",
  μοντελο: "model", μοντελου: "model", μοντελα: "model", models: "model",
  καθαρη: "clean", καθαρησ: "clean", εγκατασταση: "setup", εγκαταστασησ: "setup", installation: "setup",
  οριο: "limit", οριου: "limit", συμπιεση: "compact", συμπιεσησ: "compact", compaction: "compact",
  αυτοματη: "auto", αυτοματησ: "auto", αυτοματησυμπιεση: "compact", αυτοματα: "automatic",
  πλανο: "plan", πλανα: "plan", σχεδιο: "plan", σχεδια: "plan", plans: "plan",
  αποθηκευουμε: "save", αποθηκευση: "save", αποθηκευονται: "stored", saving: "save", saved: "save",
  διαγραφηκε: "deleted", διαγραφη: "deleted", deleted: "deleted",
  δημοσια: "public", δημοσιο: "public", νεα: "new", νεο: "new", διευθυνση: "address",
  backups: "backup"
};

export function normalizeMemoryQuery(text: string): string {
  return fold(normalizeMemoryDates(text)).replace(/αντιγραφ(?:α|ο) ασφαλειασ/g, "backup")
    .replace(/[\p{L}]+/gu, word => aliases[word] ?? word);
}

const stopWords = new Set([
  "the", "a", "an", "is", "are", "was", "what", "which", "where", "how", "does", "do", "of", "for", "to", "and", "in",
  "η", "ο", "το", "τα", "τη", "την", "τον", "του", "τησ", "των", "σε", "στο", "στη", "στην", "στον", "και", "με", "για", "απο",
  "ειναι", "ποια", "ποιο", "ποιοσ", "που", "πωσ", "τι", "να", "εχει", "ποτε", "στισ", "στα", "πρεπει", "βρισκεται", "βρισκονται"
]);

export function memoryQueryTerms(query: string): string[] {
  return [...new Set(normalizeMemoryQuery(query).split(/\s+/)
    .map(t => t.replace(/^[?;:,!"'`()\[\]{}]+|[?;:,!"'`()\[\]{}]+$/g, ""))
    .filter(t => t && !stopWords.has(t)))];
}

export function memoryTermMatches(text: string, term: string): boolean {
  const numeric = /\d/.test(term);
  if (!numeric && !/^[\p{L}]{1,3}$/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Short words such as IP must not match clipboard, Stripe, or unrelated IDs.
  if (!numeric) return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
  // Numeric values and machine identifiers must not match prefixes/suffixes.
  // A standalone year may still match the year component of an ISO date.
  const numericContinuation = term.includes("-") ? "[.-]\\d" : "\\.\\d";
  return new RegExp(`(?<![\\p{L}\\p{N}_.])${escaped}(?![\\p{L}\\p{N}_]|${numericContinuation})`, "u").test(text);
}
