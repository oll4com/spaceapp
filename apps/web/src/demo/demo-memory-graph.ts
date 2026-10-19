import type { MemoryGraphNode, MemoryGraphEdge, MemoryGraphOverviewPayload, MemoryGraphNodeDetail } from "@space/contracts";

export function syntheticMemoryNode(index: number): MemoryGraphNode {
  // Match the live archive's 24-source contract while scaling memory records.
  const source = index < 960 && index % 40 === 0;
  return { id: `demo:graph:${index}`, type: source ? "SOURCE" : "MEMORY", label: index === 0 ? "space.md" : source ? `source-${index / 40}.md` : `Synthetic memory ${index}`,
    sourcePath: `/demo/memory/source-${Math.floor(index / 40) % 24}.md`, recordId: source ? null : `demo:record:${index}` };
}

/** Synthetic data only: stable identities, no providers, embeddings, accounts or backend. */
export function createSyntheticMemoryGraph(requestedCount: number): MemoryGraphOverviewPayload {
  const count = Math.max(1, Math.min(50000, Math.floor(Number.isFinite(requestedCount) ? requestedCount : 2000)));
  const nodes = Array.from({ length: count }, (_, i) => syntheticMemoryNode(i));
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 3 && count > 1; j++) {
      const target = (i + 1 + j * 997) % count;
      if (target === i) continue;
      edges.push({ id: `demo:edge:${i}:${j}`, source: nodes[i]!.id, target: nodes[target]!.id,
        ...(j === 0 ? { type: "DERIVED_FROM" as const } : { type: "SEMANTICALLY_RELATED" as const, origin: "DETERMINISTIC_TFIDF" as const, confidence: 0.8, evidence: "Synthetic demo relationship; not inferred from user data." }) });
    }
  }
  const sourceCount = Math.min(24, Math.ceil(count / 40));
  return { version: 2, generatedAt: "2026-10-16T00:00:00.000Z", sourceHash: "0".repeat(64), isStale: false,
    summary: { nodeCount: count, edgeCount: edges.length, sourceCount, recordCount: count - sourceCount, issueCount: 0 },
    nodes, edges, totalMatchingNodes: count, totalMatchingEdges: edges.length, truncated: false, months: [],
    filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, month: "all", relationMode: "RELATIONS" } };
}

export function syntheticMemoryNodeDetail(id: string): MemoryGraphNodeDetail | null {
  const match = /^demo:graph:(\d+)$/.exec(id);
  const index = match ? Number(match[1]) : -1;
  if (index < 0 || index >= 50000) return null;
  return { node: syntheticMemoryNode(index), record: null, relatedNodes: [], relatedEdges: [], issues: [] };
}
