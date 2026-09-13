import { normalizeMemoryQuery, memoryQueryTerms, memoryTermMatches } from "./query-normalization.js";
import { memoryTextWindows } from "./excerpt.js";
export { normalizeMemoryQuery } from "./query-normalization.js";
interface SearchDocument { id: string; title: string; body: string; provenance: string; createdAt: string }
const normalizedCache = new WeakMap<SearchDocument, { raw: string[]; title: string; body: string; text: string; passages: string[] }>();
function normalizedDocument(document: SearchDocument) {
  const raw = [document.title, document.body, document.provenance];
  const cached = normalizedCache.get(document);
  if (cached && cached.raw.every((value, n) => value === raw[n])) return cached;
  const title = normalizeMemoryQuery(document.title), body = normalizeMemoryQuery(document.body);
  const result = { raw, title, body, text: `${title}\n${body}\n${normalizeMemoryQuery(document.provenance)}`,
    passages: body.split(/\n+/).flatMap(line => memoryTextWindows(line, 640)) };
  normalizedCache.set(document, result);
  return result;
}

/** Shared ranking rewards term coverage and evidence within a bounded passage. */
export function searchMemoryDocuments<T extends SearchDocument>(documents: T[], query: string, limit = documents.length): T[] {
  const normalized = normalizeMemoryQuery(query.trim());
  if (!normalized) return [];
  const terms = memoryQueryTerms(query);
  if (!terms.length) return [];
  const naturalQuestion = normalized.split(/\s+/).length >= 5 && /[?;]$/.test(normalized);
  return documents.map(document => {
    const { title, body, text, passages } = normalizedDocument(document);
    const matches = terms.filter(term => memoryTermMatches(text, term)).length;
    const identifiers = terms.filter(term => /\d/.test(term));
    if (!identifiers.every(term => memoryTermMatches(text, term))) return { document, score: 0 };
    const naturalMatch = naturalQuestion && matches >= Math.max(2, Math.ceil(terms.length * 2 / 3));
    if (matches !== terms.length && !naturalMatch) return { document, score: 0 };
    const passageCoverage = passages.reduce((best, passage) => Math.max(best,
      terms.filter(term => memoryTermMatches(passage, term)).length), 0);
    const score = matches * 3 + (title.includes(normalized) ? 10 : 0) + (body.includes(normalized) ? 3 : 0) +
      terms.reduce((n, term) => n + (memoryTermMatches(title, term) ? 2 : 0), 0) + passageCoverage * 3;
    return { document, score };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.document.createdAt.localeCompare(a.document.createdAt) || a.document.id.localeCompare(b.document.id))
    .slice(0, limit).map(row => row.document);
}
