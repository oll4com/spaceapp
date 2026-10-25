import { searchMemoryDocuments } from "./retrieval.js";
import { createHash } from "node:crypto";

export interface MemoryEvaluationDocument {
  id: string;
  title: string;
  body: string;
  provenance: string;
  createdAt: string;
}

export interface MemoryEvaluationQuery {
  id: string;
  query: string;
  expectedIds: string[];
}

export interface MemoryQueryEvaluationReport {
  counts: {
    documents: number;
    positiveQueries: number;
    negativeQueries: number;
  };
  thresholds: {
    recallAt5: number;
    meanReciprocalRank: number;
    falsePositiveRate: number;
  };
  metrics: {
    recallAt5: number;
    meanReciprocalRank: number;
    falsePositiveRate: number;
  };
  queryResults: Array<{
    id: string;
    expectedIds: string[];
    resultIds: string[];
    firstRelevantRank: number | null;
    passed: boolean;
  }>;
  determinismHash: string;
  passed: boolean;
}

const thresholds = {
  recallAt5: 0.85,
  meanReciprocalRank: 0.75,
  falsePositiveRate: 0.05
} as const;

export function searchMemoryEvaluationDocuments(documents: MemoryEvaluationDocument[], query: string, limit = 5): MemoryEvaluationDocument[] {
  return searchMemoryDocuments(documents, query, limit);
}

export function evaluateMemoryQueries(
  documents: MemoryEvaluationDocument[],
  queries: MemoryEvaluationQuery[]
): MemoryQueryEvaluationReport {
  if (documents.length === 0 || documents.length > 10_000) throw new Error("Memory evaluation requires 1 to 10,000 documents.");
  if (queries.length === 0 || queries.length > 1_000) throw new Error("Memory evaluation requires 1 to 1,000 queries.");

  const documentIds = new Set(documents.map((document) => document.id));
  if (documentIds.size !== documents.length) throw new Error("Memory evaluation document IDs must be unique.");
  const queryIds = new Set(queries.map((query) => query.id));
  if (queryIds.size !== queries.length) throw new Error("Memory evaluation query IDs must be unique.");

  const queryResults = queries.map((query) => {
    const resultIds = searchMemoryEvaluationDocuments(documents, query.query, 5).map((document) => document.id);
    const firstRelevantIndex = resultIds.findIndex((id) => query.expectedIds.includes(id));
    const firstRelevantRank = firstRelevantIndex === -1 ? null : firstRelevantIndex + 1;
    return {
      id: query.id,
      expectedIds: [...query.expectedIds],
      resultIds,
      firstRelevantRank,
      passed: query.expectedIds.length > 0 ? firstRelevantRank !== null : resultIds.length === 0
    };
  });
  const positiveResults = queryResults.filter((result) => result.expectedIds.length > 0);
  const negativeResults = queryResults.filter((result) => result.expectedIds.length === 0);
  if (positiveResults.length < 1 || negativeResults.length < 1) {
    throw new Error("Memory evaluation requires both positive and negative queries.");
  }

  const recallAt5 = positiveResults.reduce((sum, result) => sum + result.expectedIds.filter(id => result.resultIds.includes(id)).length / result.expectedIds.length, 0) / positiveResults.length;
  const meanReciprocalRank = positiveResults.reduce(
    (total, result) => total + (result.firstRelevantRank === null ? 0 : 1 / result.firstRelevantRank),
    0
  ) / positiveResults.length;
  const falsePositiveRate = negativeResults.filter((result) => result.resultIds.length > 0).length / negativeResults.length;
  const metrics = { recallAt5, meanReciprocalRank, falsePositiveRate };
  const determinismHash = createHash("sha256").update(JSON.stringify({ metrics, queryResults })).digest("hex");

  return {
    counts: {
      documents: documents.length,
      positiveQueries: positiveResults.length,
      negativeQueries: negativeResults.length
    },
    thresholds: { ...thresholds },
    metrics,
    queryResults,
    determinismHash,
    passed: recallAt5 >= thresholds.recallAt5 &&
      meanReciprocalRank >= thresholds.meanReciprocalRank &&
      falsePositiveRate <= thresholds.falsePositiveRate
  };
}
