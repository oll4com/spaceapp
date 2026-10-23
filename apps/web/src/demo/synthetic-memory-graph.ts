import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/**
 * Deterministic synthetic memory graph for scale benchmarks: a core source,
 * a ring of source files, topics, and memories with contains / tagged /
 * semantic edges at roughly three edges per node (50,000 nodes ≈ 150,000
 * edges). Anyone can reproduce the 3D renderer's benchmark in demo mode
 * with ?demoGraphSize=50000 — no backend or embeddings provider needed.
 */
export function generateSyntheticMemoryGraph(nodeCount: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const total = Math.max(1, Math.floor(nodeCount));
  const nodes: MemoryGraphNode[] = [{ id: "source:space.md", type: "SOURCE", label: "space.md", sourcePath: "/demo/memory/space.md", recordId: null }];
  const edges: MemoryGraphEdge[] = [];
  const sourceCount = Math.max(1, Math.min(400, Math.round(total / 250)));
  const sources: string[] = [];
  for (let s = 0; s < sourceCount && nodes.length < total; s++) {
    const id = `source:file-${s}`;
    sources.push(id);
    nodes.push({ id, type: "SOURCE", label: `file-${s}.md`, sourcePath: `/demo/memory/file-${s}.md`, recordId: null });
    edges.push({ id: `edge:derived-${s}`, type: "DERIVED_FROM", source: id, target: "source:space.md" });
  }
  const topicCount = Math.max(2, Math.min(64, Math.round(total / 1500)));
  const topics: string[] = [];
  for (let t = 0; t < topicCount && nodes.length < total; t++) {
    const id = `topic:topic-${t}`;
    topics.push(id);
    nodes.push({ id, type: "TOPIC", label: `Topic ${t}`, sourcePath: null, recordId: null });
  }
  let memoryIndex = 0;
  while (nodes.length < total) {
    const id = `memory:synthetic-${memoryIndex}`;
    const source = sources[memoryIndex % sources.length]!;
    nodes.push({ id, type: "MEMORY", label: `Synthetic memory ${memoryIndex}`, sourcePath: `/demo/memory/file-${memoryIndex % sources.length}.md`, recordId: id });
    edges.push({ id: `edge:contains-${memoryIndex}`, type: "CONTAINS", source, target: id });
    if (memoryIndex % 3 === 0) {
      edges.push({ id: `edge:tagged-${memoryIndex}`, type: "TAGGED_WITH", source: id, target: topics[memoryIndex % topics.length]!, origin: "EXPLICIT_TAG", confidence: 1, evidence: "Synthetic demo tag." });
    }
    if (memoryIndex > 0) {
      edges.push({ id: `edge:related-${memoryIndex}`, type: "SEMANTICALLY_RELATED", source: id, target: `memory:synthetic-${memoryIndex - 1}`, origin: "DETERMINISTIC_TFIDF", confidence: 0.8, evidence: "Synthetic demo relation." });
    }
    if (memoryIndex >= 7 && memoryIndex % 5 === 0) {
      edges.push({ id: `edge:related-skip-${memoryIndex}`, type: "SEMANTICALLY_RELATED", source: `memory:synthetic-${memoryIndex - 7}`, target: id, origin: "DETERMINISTIC_TFIDF", confidence: 0.6, evidence: "Synthetic demo relation." });
    }
    if (memoryIndex >= 2 && memoryIndex % 2 === 0) {
      edges.push({ id: `edge:related-pair-${memoryIndex}`, type: "SEMANTICALLY_RELATED", source: `memory:synthetic-${memoryIndex - 2}`, target: id, origin: "DETERMINISTIC_TFIDF", confidence: 0.7, evidence: "Synthetic demo relation." });
    }
    memoryIndex++;
  }
  return { nodes, edges };
}
