import type { MemoryGraphSnapshot } from "@space/contracts";

/** Synthetic, deterministic route fixture; it contains no operator memory. */
export function largeMemoryGraph(nodeCount = 50_000, edgesPerNode = 3): MemoryGraphSnapshot {
  const id = (index: number) => `memory:synthetic-${String(index).padStart(5, "0")}`;
  const nodes: MemoryGraphSnapshot["nodes"] = Array.from({ length: nodeCount }, (_, index) => ({
    id: id(index),
    type: "MEMORY",
    label: index === 0 ? "Synthetic token=fixture-node-secret" : `Synthetic memory ${index}`,
    sourcePath: null,
    recordId: null
  }));
  const edges: MemoryGraphSnapshot["edges"] = Array.from({ length: nodeCount * edgesPerNode }, (_, index) => {
    const source = Math.floor(index / edgesPerNode);
    return {
      id: `edge:synthetic-${index}`,
      type: "DERIVED_FROM",
      source: id(source),
      target: id((source + index % edgesPerNode + 1) % nodeCount),
      ...(index === 0 ? { evidence: "Synthetic password=fixture-edge-secret" } : {})
    };
  });
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "f".repeat(64),
    records: [],
    nodes,
    edges,
    issues: [],
    summary: { sourceCount: 0, recordCount: 0, nodeCount, edgeCount: edges.length, issueCount: 0 }
  };
}
