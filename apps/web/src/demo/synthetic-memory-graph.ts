import type { MemoryGraphNode, MemoryGraphEdge, MemoryGraphPayload } from "@space/contracts";

/**
 * Generates a deterministic synthetic memory graph for benchmarking
 * 3D rendering and force layout at scale (e.g. 2k, 10k, 50k nodes).
 */
export function generateSyntheticMemoryGraph(targetNodeCount: number): MemoryGraphPayload {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];

  nodes.push({
    id: "root-gemini",
    label: "gemini.md",
    type: "SOURCE",
    sourcePath: "/opt/spaceapp/docs/gemini.md",
    recordId: null
  });

  const sourceCount = Math.max(12, Math.floor(targetNodeCount / 28));
  for (let s = 0; s < sourceCount && nodes.length < targetNodeCount; s++) {
    const sId = `source-${s}`;
    nodes.push({
      id: sId,
      label: `source-${s}.md`,
      type: "SOURCE",
      sourcePath: `/opt/spaceapp/docs/source-${s}.md`,
      recordId: null
    });
    edges.push({
      id: `edge-source-${s}`,
      type: "DERIVED_FROM",
      source: "root-gemini",
      target: sId
    });
  }

  let memIdx = 0;
  while (nodes.length < targetNodeCount) {
    const parentSource = nodes[1 + (memIdx % sourceCount)]!;
    const memId = `mem-${memIdx}`;
    nodes.push({
      id: memId,
      label: `Memory record ${memIdx}`,
      type: "MEMORY",
      sourcePath: parentSource.sourcePath,
      recordId: `rec-${memIdx}`
    });
    edges.push({
      id: `edge-contains-${memIdx}`,
      type: "CONTAINS",
      source: parentSource.id,
      target: memId
    });
    memIdx++;
  }

  const targetEdgeCount = Math.min(targetNodeCount * 3, 150000);
  let extraEdgeIdx = 0;
  const numNodes = nodes.length;
  while (edges.length < targetEdgeCount && numNodes > 2) {
    const srcIndex = 1 + (extraEdgeIdx % (numNodes - 1));
    const step = 7 + (extraEdgeIdx % 31);
    const dstIndex = 1 + ((srcIndex + step) % (numNodes - 1));
    if (srcIndex !== dstIndex) {
      edges.push({
        id: `edge-rel-${extraEdgeIdx}`,
        type: extraEdgeIdx % 3 === 0 ? "DERIVED_FROM" : "TAGGED_WITH",
        source: nodes[srcIndex]!.id,
        target: nodes[dstIndex]!.id
      });
    }
    extraEdgeIdx++;
  }

  return {
    version: 1,
    layoutVersion: 1,
    taxonomyVersion: 1,
    revisionHash: `synth-${targetNodeCount}`,
    sourceHash: `synth-source-${targetNodeCount}`,
    generatedAt: "2026-10-16T20:00:00Z",
    isStale: false,
    months: [],
    summary: {
      sourceCount,
      recordCount: memIdx,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0
    },
    nodes,
    edges,
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      relationMode: "RELATIONS",
      month: null
    }
  };
}
