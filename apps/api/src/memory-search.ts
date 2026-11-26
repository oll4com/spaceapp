/**
 * Memory search status shared by the memory routes and composition
 * (moved verbatim from the composition root).
 */
import type { MemoryEmbeddingSmokeCheck, MemorySearchMode, MemorySearchStatus, MemoryVectorReadiness } from "@space/contracts";

export function buildMemorySearchStatus(
  mode: MemorySearchMode,
  latestEmbeddingSmoke: MemoryEmbeddingSmokeCheck | null,
  vectorReadiness: MemoryVectorReadiness,
  spaceMemoryReferenceCount = 0
): MemorySearchStatus {
  const semanticReady = isSemanticMemoryReady(latestEmbeddingSmoke, vectorReadiness);
  const semanticStatus =
    semanticReady ? "VERIFIED" : vectorReadiness.status === "ERROR" || latestEmbeddingSmoke?.status === "ERROR" ? "ERROR" : "DISABLED";
  const semanticReason = latestEmbeddingSmoke
    ? `Vector ${vectorReadiness.code}; latest embedding smoke ${latestEmbeddingSmoke.code}: ${latestEmbeddingSmoke.message}`
    : `Vector ${vectorReadiness.code}: ${vectorReadiness.message}. Embedding provider smoke has not passed.`;
  return {
    mode,
    keyword: {
      status: "VERIFIED",
      statusReason:
        "Canonical Space Memory keyword search is active against redacted title, body and provenance fields." +
        (spaceMemoryReferenceCount > 0 ? ` Canonical Space Memory references included: ${spaceMemoryReferenceCount}.` : ""),
      checkedAt: null
    },
    semantic: {
      status: semanticStatus,
      statusReason: semanticReason,
      checkedAt: latestEmbeddingSmoke?.checkedAt ?? vectorReadiness.checkedAt
    }
  };
}

export function isSemanticMemoryReady(
  latestEmbeddingSmoke: MemoryEmbeddingSmokeCheck | null,
  vectorReadiness: MemoryVectorReadiness
): boolean {
  return (
    vectorReadiness.status === "VERIFIED" &&
    vectorReadiness.code === "MEMORY_VECTOR_READY" &&
    latestEmbeddingSmoke?.status === "VERIFIED" &&
    latestEmbeddingSmoke.code === "EMBEDDING_SMOKE_OK" &&
    latestEmbeddingSmoke.embeddingProviderReady === true
  );
}
