import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload } from "@space/contracts";

/**
 * Deterministically generates a synthetic memory graph of a specified size for benchmarking.
 * Produces structured file (SOURCE), memory items (MEMORY), topics (TOPIC), and derived links.
 *
 * @param nodeCount - Total target node count (e.g. 2000, 10000, 50000).
 * @param edgeFactor - Ratio of edges per node (default: ~3 edges per node for 150k edges at 50k nodes).
 * @returns Complete synthetic MemoryGraphPayload.
 */
export function generateSyntheticMemoryGraph(nodeCount = 2000, edgeFactor = 3): MemoryGraphPayload {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];

  const sourceCount = Math.min(24, Math.max(1, Math.round(nodeCount * 0.05)));
  const topicCount = Math.max(1, Math.round(nodeCount * 0.03));
  const memoryCount = nodeCount - sourceCount - topicCount;

  // Root core file
  nodes.push({
    id: "source:core-root",
    label: "gemini.md",
    type: "SOURCE",
    sourcePath: "/workspace/docs/gemini.md",
    recordId: null
  });

  // Source files
  for (let i = 1; i < sourceCount; i++) {
    const id = `source:file-${i}`;
    nodes.push({
      id,
      label: `doc-source-${i}.md`,
      type: "SOURCE",
      sourcePath: `/workspace/docs/source-${i}.md`,
      recordId: null
    });
    // Link to root or preceding source
    edges.push({
      id: `edge:source-link-${i}`,
      type: "DERIVED_FROM",
      source: i === 1 || i % 5 === 0 ? "source:core-root" : `source:file-${Math.floor(i / 2)}`,
      target: id,
      origin: "DERIVED_TFIDF"
    });
  }

  // Topics
  for (let i = 0; i < topicCount; i++) {
    nodes.push({
      id: `topic:topic-${i}`,
      label: `Topic ${i + 1}`,
      type: "TOPIC",
      sourcePath: null,
      recordId: null
    });
  }

  // Memory records
  for (let i = 0; i < memoryCount; i++) {
    const parentSourceIndex = i % sourceCount;
    const parentSourceId = parentSourceIndex === 0 ? "source:core-root" : `source:file-${parentSourceIndex}`;
    const memoryId = `memory:rec-${i}`;

    nodes.push({
      id: memoryId,
      label: `Memory Item ${i} (${parentSourceIndex})`,
      type: "MEMORY",
      sourcePath: `/workspace/docs/source-${parentSourceIndex}.md`,
      recordId: memoryId
    });

    edges.push({
      id: `edge:contains-${i}`,
      type: "CONTAINS",
      source: parentSourceId,
      target: memoryId,
      origin: undefined
    });

    // Cross-link to a topic
    if (topicCount > 0 && i % 2 === 0) {
      const topicIndex = Math.floor(i / 2) % topicCount;
      const topicId = `topic:topic-${topicIndex}`;
      edges.push({
        id: `edge:topic-${i}`,
        type: "TAGGED_WITH",
        source: memoryId,
        target: topicId,
        origin: i % 4 === 0 ? "EXPLICIT_TAG" : "DERIVED_TFIDF",
        confidence: 0.95,
        evidence: `Synthetic topic linkage for record ${i}`
      });
    }

    // Occasional inter-memory derived edge
    if (i > 10 && i % 3 === 0) {
      edges.push({
        id: `edge:derived-${i}`,
        type: "DERIVED_FROM",
        source: `memory:rec-${i - 5}`,
        target: memoryId,
        origin: "DERIVED_TFIDF"
      });
    }
  }

  // Generate deterministic supplementary edges until target edgeFactor is reached
  const targetEdges = Math.round(nodeCount * edgeFactor);
  let step = 1;
  while (edges.length < targetEdges && memoryCount > 1) {
    const idx = edges.length % memoryCount;
    const targetIdx = (idx + step) % memoryCount;
    if (idx !== targetIdx) {
      edges.push({
        id: `edge:dense-${edges.length}`,
        type: "DERIVED_FROM",
        source: `memory:rec-${idx}`,
        target: `memory:rec-${targetIdx}`,
        origin: "DERIVED_TFIDF"
      });
    }
    step = (step % (memoryCount - 1)) + 1;
  }

  return {
    version: 1,
    layoutVersion: 1,
    taxonomyVersion: 1,
    generatedAt: "2026-10-16T12:00:00.000Z",
    sourceHash: nodeCount.toString(16).padStart(64, "a"),
    revisionHash: nodeCount.toString(16).padStart(64, "b"),
    isStale: false,
    nodes,
    edges,
    months: [],
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      month: null,
      relationMode: "RELATIONS"
    },
    summary: {
      sourceCount,
      recordCount: memoryCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0
    }
  };
}
