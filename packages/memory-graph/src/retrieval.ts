import { normalizeMemoryQuery, memoryQueryTerms, memoryTermMatches } from "./query-normalization.js";
import { memoryTextWindows } from "./excerpt.js";
export { normalizeMemoryQuery } from "./query-normalization.js";
/** Normalized title/body computed earlier from exactly `source`; ignored once a field no longer matches. */
export interface MemorySearchTextHint { source: [title: string, body: string]; title: string; body: string }
interface SearchDocument { id: string; title: string; body: string; provenance: string; createdAt: string; searchText?: MemorySearchTextHint }
const normalizedCache = new WeakMap<SearchDocument, { raw: string[]; title: string; body: string; text: string; passages: string[] }>();
// Save metadata (marker, Source/provenance line, created_at) and the canonical-save heading prefix
// repeat in every record, so they would match almost any query without being evidence.
const boilerplateLine = /^(?:<!--\s*space-memory:|-\s*source:\s*space api memory\.save|-\s*created_at=)/;
function searchableBody(body: string): string {
  return body.split("\n").filter(line => !boilerplateLine.test(line.trim()))
    .map(line => line.replace(/^(#{1,6}\s.*?)space canonical memory:\s*/, "$1")).join("\n");
}
function normalizedDocument(document: SearchDocument) {
  const raw = [document.title, document.body];
  const cached = normalizedCache.get(document);
  if (cached && cached.raw.every((value, n) => value === raw[n])) return cached;
  const hint = document.searchText;
  const reuse = hint !== undefined && hint.source[0] === document.title && hint.source[1] === document.body;
  const title = reuse ? hint.title : normalizeMemoryQuery(document.title);
  const body = searchableBody(reuse ? hint.body : normalizeMemoryQuery(document.body));
  const result = { raw, title, body, text: `${title}\n${body}`,
    passages: body.split(/\n+/).flatMap(line => memoryTextWindows(line, 640)) };
  normalizedCache.set(document, result);
  return result;
}

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Shared ranking: every term (or 2/3 for natural questions) must match; rarer terms, terms in the
 * title and terms found together in one passage weigh more; newer records get a small bonus.
 */
export function searchMemoryDocuments<T extends SearchDocument>(documents: T[], query: string, limit = documents.length): T[] {
  const normalized = normalizeMemoryQuery(query.trim());
  if (!normalized) return [];
  const terms = memoryQueryTerms(query);
  if (!terms.length) return [];
  const naturalQuestion = normalized.split(/\s+/).length >= 5 && /[?;]$/.test(normalized);
  const identifiers = terms.filter(term => /\d/.test(term));
  const candidates = documents.flatMap(document => {
    const normalizedDoc = normalizedDocument(document);
    const matched = terms.filter(term => memoryTermMatches(normalizedDoc.text, term));
    if (!identifiers.every(term => matched.includes(term))) return [];
    const naturalMatch = naturalQuestion && matched.length >= Math.max(2, Math.ceil(terms.length * 2 / 3));
    if (matched.length !== terms.length && !naturalMatch) return [];
    return [{ document, normalizedDoc, matched }];
  });
  const total = Math.max(1, candidates.length);
  const weight = new Map(terms.map(term => [term,
    1 + Math.log(total / Math.max(1, candidates.filter(row => row.matched.includes(term)).length))]));
  const weigh = (list: string[]) => list.reduce((sum, term) => sum + weight.get(term)!, 0);
  const newest = candidates.reduce((max, row) => Math.max(max, Date.parse(row.document.createdAt) || 0), 0);
  return candidates.map(({ document, normalizedDoc: { title, body, passages }, matched }) => {
    const passageCoverage = passages.reduce((best, passage) =>
      Math.max(best, weigh(matched.filter(term => memoryTermMatches(passage, term)))), 0);
    const ageDays = Math.max(0, (newest - (Date.parse(document.createdAt) || 0)) / dayMs);
    const score = weigh(matched) * 3 + (title.includes(normalized) ? 10 : 0) + (body.includes(normalized) ? 3 : 0) +
      weigh(matched.filter(term => memoryTermMatches(title, term))) * 2 + passageCoverage * 3 +
      4 * Math.pow(0.5, ageDays / 60);
    return { document, score };
  }).sort((a, b) => b.score - a.score || b.document.createdAt.localeCompare(a.document.createdAt) || a.document.id.localeCompare(b.document.id))
    .slice(0, limit).map(row => row.document);
}
