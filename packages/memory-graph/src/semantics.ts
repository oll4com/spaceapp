import type { MemoryGraphRecord, MemoryGraphTopicAssignment } from "./types.js";

const maximumDerivedTopics = 3;
const maximumSemanticRelationsPerRecord = 3;
const semanticSimilarityThreshold = 0.18;
const credentialAssignmentPattern = /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*([^\s,;]+)/giu;
const credentialKeyPattern = /\bsk-[A-Za-z0-9_-]{8,}\b/giu;
const credentialLikeLabelPattern = /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+)/iu;
const opaqueIdentifierPattern = /^(?:[a-f0-9]{7,48}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;

const stopWords = new Set([
  "about", "after", "again", "also", "and", "are", "been", "before", "being", "between", "body", "but", "can",
  "canonical", "could", "each", "from", "have", "into", "memory", "more", "must", "none", "only", "original",
  "provenance", "request", "should", "source", "space", "than", "that", "the", "their", "then", "there", "these",
  "this", "through", "trace", "using", "was", "were", "will", "with", "without", "would",
  "αλλα", "απο", "αυτα", "αυτη", "αυτο", "για", "δεν", "εαν", "εχει", "εχουν", "ειναι", "ενα", "εναν", "ενας",
  "επι", "και", "καθε", "κατα", "μαζι", "με", "μεσα", "μια", "μιας", "μου", "να", "οπως", "οταν", "οι", "ομως",
  "που", "πρεπει", "σε", "στη", "στην", "στις", "στο", "στον", "τα", "τη", "την", "της", "το", "τον", "του",
  "των", "ως"
]);

interface WeightedDocument {
  id: string;
  termFrequency: Map<string, number>;
}

export interface MemorySemanticRelation {
  source: string;
  target: string;
  confidence: number;
  evidence: string;
}

export interface MemorySemanticAnalysis {
  records: MemoryGraphRecord[];
  relations: MemorySemanticRelation[];
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ");
}

function semanticSafeText(value: string): { value: string; excludedTerms: Set<string> } {
  const excludedTerms = new Set<string>();
  const safe = value.replace(credentialAssignmentPattern, (_match, assignedValue: string) => {
    const normalizedAssignedValue = normalizeTerm(assignedValue);
    for (const match of normalizedAssignedValue.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)) {
      if (match[0]) excludedTerms.add(match[0].replace(/^[._-]+|[._-]+$/g, ""));
    }
    return " ";
  });
  return { value: safe.replace(credentialKeyPattern, " "), excludedTerms };
}

function safeTopicLabel(value: string): string | null {
  const label = value.replace(/`/g, "").trim();
  if (
    label.length < 1 ||
    label.length > 48 ||
    credentialLikeLabelPattern.test(label) ||
    !/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]| [\p{L}\p{N}._-])*$/u.test(label)
  ) return null;
  return label;
}

export function explicitMemoryTags(body: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/^\s*-\s*Tags:\s*(.+)$/gim)) {
    for (const candidate of (match[1] ?? "").split(",")) {
      const label = safeTopicLabel(candidate);
      if (!label) continue;
      const key = normalizeTerm(label);
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(label);
      if (tags.length === 12) return tags;
    }
  }
  return tags;
}

function tokenize(value: string): string[] {
  const safe = semanticSafeText(value);
  const normalized = normalizeTerm(safe.value);
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)) {
    const token = (match[0] ?? "").replace(/^[._-]+|[._-]+$/g, "");
    if (
      token.length < 3 ||
      token.length > 48 ||
      /^\d+$/u.test(token) ||
      opaqueIdentifierPattern.test(token) ||
      safe.excludedTerms.has(token) ||
      stopWords.has(token)
    ) continue;
    tokens.push(token);
  }
  return tokens;
}

function semanticBody(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*-\s*(?:Source|Tags):/i.test(line) && !/<!--\s*space-memory:/i.test(line))
    .join("\n");
}

function weightedDocument(record: MemoryGraphRecord, tags: string[]): WeightedDocument {
  const termFrequency = new Map<string, number>();
  const add = (term: string, weight: number) => termFrequency.set(term, (termFrequency.get(term) ?? 0) + weight);
  for (const term of tokenize(record.title)) add(term, 2);
  for (const term of tokenize(semanticBody(record.body))) add(term, 1);
  for (const tag of tags) {
    const normalizedTag = normalizeTerm(tag);
    if (safeTopicLabel(normalizedTag)) add(normalizedTag, 2);
    for (const term of tokenize(tag)) add(term, 1);
  }
  return { id: record.id, termFrequency };
}

function documentFrequencies(documents: WeightedDocument[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.termFrequency.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

function inverseDocumentFrequency(documentCount: number, frequency: number): number {
  return Math.log((documentCount + 1) / (frequency + 1)) + 1;
}

function tfIdfVectors(
  documents: WeightedDocument[],
  frequencies: Map<string, number>
): Map<string, Map<string, number>> {
  const vectors = new Map<string, Map<string, number>>();
  for (const document of documents) {
    const vector = new Map<string, number>();
    let squaredLength = 0;
    for (const [term, count] of document.termFrequency) {
      const weight = (1 + Math.log(count)) * inverseDocumentFrequency(documents.length, frequencies.get(term) ?? 1);
      vector.set(term, weight);
      squaredLength += weight * weight;
    }
    const length = Math.sqrt(squaredLength) || 1;
    for (const [term, weight] of vector) vector.set(term, weight / length);
    vectors.set(document.id, vector);
  }
  return vectors;
}

function derivedTopics(
  document: WeightedDocument,
  documentCount: number,
  frequencies: Map<string, number>,
  explicitTags: string[]
): MemoryGraphTopicAssignment[] {
  const explicitKeys = new Set(explicitTags.map(normalizeTerm));
  const maximumFrequency = Math.max(2, Math.ceil(documentCount * 0.8));
  const candidates = [...document.termFrequency]
    .filter(([term]) => !explicitKeys.has(term) && (frequencies.get(term) ?? 0) <= maximumFrequency)
    .map(([term, count]) => ({
      term,
      score: (1 + Math.log(count)) * inverseDocumentFrequency(documentCount, frequencies.get(term) ?? 1)
    }))
    .sort((left, right) => right.score - left.score || left.term.localeCompare(right.term))
    .slice(0, maximumDerivedTopics);
  const maximumScore = candidates[0]?.score ?? 1;
  return candidates.map(({ term, score }) => ({
    label: term,
    origin: "DERIVED_TFIDF",
    confidence: round(Math.min(0.95, 0.55 + (score / maximumScore) * 0.4))
  }));
}

function semanticRelations(
  documents: WeightedDocument[],
  vectors: Map<string, Map<string, number>>,
  frequencies: Map<string, number>
): MemorySemanticRelation[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const postings = new Map<string, string[]>();
  const maximumPostingSize = Math.min(80, Math.max(8, Math.ceil(documents.length * 0.08)));
  for (const document of documents) {
    for (const term of document.termFrequency.keys()) {
      if ((frequencies.get(term) ?? 0) > maximumPostingSize) continue;
      const ids = postings.get(term) ?? [];
      ids.push(document.id);
      postings.set(term, ids);
    }
  }

  const candidateKeys = new Set<string>();
  for (const ids of postings.values()) {
    const ordered = [...ids].sort();
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        candidateKeys.add(`${ordered[leftIndex]}\n${ordered[rightIndex]}`);
      }
    }
  }

  const candidates: MemorySemanticRelation[] = [];
  for (const key of [...candidateKeys].sort()) {
    const [source, target] = key.split("\n") as [string, string];
    const sourceVector = vectors.get(source)!;
    const targetVector = vectors.get(target)!;
    const smaller = sourceVector.size <= targetVector.size ? sourceVector : targetVector;
    const larger = smaller === sourceVector ? targetVector : sourceVector;
    const contributions = [...smaller]
      .flatMap(([term, weight]) => {
        const otherWeight = larger.get(term);
        return otherWeight === undefined ? [] : [{ term, value: weight * otherWeight }];
      })
      .sort((left, right) => right.value - left.value || left.term.localeCompare(right.term));
    const confidence = round(contributions.reduce((total, contribution) => total + contribution.value, 0));
    if (confidence < semanticSimilarityThreshold) continue;
    if (contributions.length < 2 && confidence < 0.4) continue;
    const sharedTerms = contributions.slice(0, 5).map(({ term }) => term);
    if (!byId.has(source) || !byId.has(target) || !sharedTerms.length) continue;
    candidates.push({
      source,
      target,
      confidence,
      evidence: `Shared terms: ${sharedTerms.join(", ")}; deterministic TF-IDF cosine=${confidence.toFixed(3)}.`
    });
  }

  candidates.sort((left, right) =>
    right.confidence - left.confidence ||
    left.source.localeCompare(right.source) ||
    left.target.localeCompare(right.target)
  );
  const degree = new Map<string, number>();
  const selected: MemorySemanticRelation[] = [];
  for (const candidate of candidates) {
    if (
      (degree.get(candidate.source) ?? 0) >= maximumSemanticRelationsPerRecord ||
      (degree.get(candidate.target) ?? 0) >= maximumSemanticRelationsPerRecord
    ) continue;
    selected.push(candidate);
    degree.set(candidate.source, (degree.get(candidate.source) ?? 0) + 1);
    degree.set(candidate.target, (degree.get(candidate.target) ?? 0) + 1);
  }
  return selected.sort((left, right) =>
    left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
  );
}

export function analyzeMemoryGraphSemantics(records: MemoryGraphRecord[]): MemorySemanticAnalysis {
  const explicitTagsById = new Map(records.map((record) => [record.id, explicitMemoryTags(record.body)]));
  const documents = records.map((record) => weightedDocument(record, explicitTagsById.get(record.id) ?? []));
  const frequencies = documentFrequencies(documents);
  const vectors = tfIdfVectors(documents, frequencies);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const annotatedRecords = records.map((record) => {
    const tags = explicitTagsById.get(record.id) ?? [];
    const explicitTopics: MemoryGraphTopicAssignment[] = tags.map((label) => ({
      label,
      origin: "EXPLICIT_TAG",
      confidence: 1
    }));
    return {
      ...record,
      tags,
      topics: [
        ...explicitTopics,
        ...derivedTopics(documentsById.get(record.id)!, documents.length, frequencies, tags)
      ]
    };
  });
  return { records: annotatedRecords, relations: semanticRelations(documents, vectors, frequencies) };
}
