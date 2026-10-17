import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload } from "@space/contracts";
import { yieldMemoryWork as pause } from "../features/memory-workspace/memory-yield.js";

/** Provider-free benchmark fixture. Stable IDs, topology and labels for every size. */
export async function createSyntheticMemoryGraph(requested: number): Promise<MemoryGraphPayload> {
  const count = Math.max(2, Math.min(50000, Math.floor(Number.isFinite(requested) ? requested : 2000)));
  const sources = Math.max(1, Math.min(24, Math.ceil(count / 100)));
  const nodes: MemoryGraphNode[] = [], edges: MemoryGraphEdge[] = [];
  const id = (i: number) => `synthetic:memory:${String(i).padStart(5, "0")}`;
  for (let i = 0; i < count; i++) {
    const source = i < sources;
    nodes.push({ id: id(i), type: source ? "SOURCE" : "MEMORY", recordId: source ? null : id(i),
      label: i === 0 ? "gemini.md" : source ? `Archive ${i}` : `Synthetic memory ${i}`,
      sourcePath: `synthetic/space_memory_2026-${String(1 + i % 12).padStart(2, "0")}.md` });
    if (i) edges.push({ id: `synthetic:edge:${edges.length}`, source: id(source || sources === 1 ? 0 : 1 + i % (sources - 1)), target: id(i), type: source ? "DERIVED_FROM" : "CONTAINS" });
    if (i % 1000 === 999) await pause();
  }
  while (edges.length < count * 3) {
    const sequence = edges.length, a = sequence % count;
    let b = (Math.imul(sequence + 1, 2654435761) >>> 0) % count;
    if (a === b) b = (b + 1) % count;
    edges.push({ id: `synthetic:edge:${sequence}`, source: id(a), target: id(b), type: "SEMANTICALLY_RELATED", origin: "DETERMINISTIC_TFIDF", confidence: 0.5, evidence: "Synthetic benchmark relationship; no real similarity measurement." });
    if (sequence % 3000 === 2999) await pause();
  }
  return { version: 2, layoutVersion: 2, taxonomyVersion: 2, generatedAt: "2026-01-01T00:00:00.000Z", sourceHash: "0".repeat(64), isStale: false,
    summary: { sourceCount: sources, recordCount: count - sources, nodeCount: count, edgeCount: edges.length, issueCount: 0 }, nodes, edges, months: [],
    filters: { q: null, nodeType: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "RELATIONS", month: "all" } };
}
