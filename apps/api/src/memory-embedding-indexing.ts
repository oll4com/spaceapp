import { CanonicalMemoryEmbeddings, type DotMemoryEmbeddings } from "@space/db";
import type { CanonicalMemoryBridge, SpaceStore } from "@space/runtime";
import { CanonicalMemorySearch } from "./canonical-memory-search.js";
import type { SpaceApiConfig } from "./config.js";
import { createMemoryEmbeddingBackfill, type MemoryEmbeddingBackfill } from "./memory-embedding-backfill.js";
import { createMemoryEmbeddings, runMemoryEmbeddingSmoke } from "./memory-embedding-smoke.js";
import { isSemanticMemoryReady } from "./memory-search.js";

/**
 * What keeps stored Space Memory vectors current with the configured embedding model: the canonical index (keyed by model)
 * and the memory_records / Dot memory backfill. Both make vectors only while the provider has passed its smoke within a day
 * (the smoke reruns when older, or after 15 minutes when it failed), and both ask for document vectors.
 */
export function createMemoryEmbeddingIndexing(input: {
  config: SpaceApiConfig;
  store: SpaceStore;
  canonicalMemory: CanonicalMemoryBridge;
  dotMemories: DotMemoryEmbeddings | null;
  /** null turns the backfill off (tests); absent builds it from the config. */
  backfill?: MemoryEmbeddingBackfill | null;
}) {
  const { config, store } = input;
  const ready = async () => {
    if (!config.memoryEmbeddingSmokeEnabled) return false;
    const vector = await store.getMemoryVectorReadiness(config.memoryEmbeddingDimensions);
    let smoke = await store.getLatestMemoryEmbeddingSmoke();
    // A passing smoke holds for a day; a failed one (a free-tier limit, a key not added yet) is retried after 15 minutes.
    const maxAgeMs = isSemanticMemoryReady(smoke, vector) ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000;
    if (!smoke || Date.now() - Date.parse(smoke.checkedAt) > maxAgeMs) {
      const result = await runMemoryEmbeddingSmoke(config, { pgvectorReady: vector.status === "VERIFIED" });
      smoke = await store.recordMemoryEmbeddingSmoke({ ...result, actorUserId: null, traceId: "memory:canonical-index", checkedAt: result.finishedAt });
    }
    return isSemanticMemoryReady(smoke, vector);
  };
  const embed = (texts: string[]) => createMemoryEmbeddings(config, texts, { taskType: "RETRIEVAL_DOCUMENT" });
  const canonicalSearch = config.runtimeStore === "postgres" && config.databaseUrl && config.memoryGraphEnabled &&
    config.memoryEmbeddingProvider && config.memoryEmbeddingModel && config.memoryEmbeddingDimensions === 1536
    ? new CanonicalMemorySearch({ canonical: input.canonicalMemory, repository: CanonicalMemoryEmbeddings.fromConnectionString(config.databaseUrl),
        provider: config.memoryEmbeddingProvider, model: config.memoryEmbeddingModel, ready, embed })
    : null;
  // A bounded pass a minute re-embeds memory_records and Dot memories made by another model (or none).
  const backfill = input.backfill !== undefined ? input.backfill
    : config.runtimeStore === "postgres" && config.memoryEmbeddingProvider && config.memoryEmbeddingModel
      ? createMemoryEmbeddingBackfill({ store, dotMemories: input.dotMemories, model: config.memoryEmbeddingModel, ready, embed })
      : null;
  return { canonicalSearch, backfill };
}
