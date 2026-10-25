import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

export const SYNTHETIC_MEMORY_GRAPH_MAX_NODES = 50000;
export const SYNTHETIC_MEMORY_NODES_PARAM = "memoryNodes";

// Small deterministic generator (mulberry32): the same size always gives the same graph.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reads the requested synthetic graph size from `?memoryNodes=N`, or 0 when none is requested. */
export function syntheticMemoryNodeCount(search: string): number {
  const raw = new URLSearchParams(search).get(SYNTHETIC_MEMORY_NODES_PARAM);
  const count = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Math.min(count, SYNTHETIC_MEMORY_GRAPH_MAX_NODES);
}

/**
 * Synthetic archive of `nodeCount` nodes and about three edges per node, shaped like a real
 * memory graph: one core file, files, memories, topics, tag edges and semantic edges.
 */
export function createSyntheticMemoryGraph(nodeCount: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const total = Math.max(0, Math.min(SYNTHETIC_MEMORY_GRAPH_MAX_NODES, Math.floor(nodeCount)));
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  if (total === 0) return { nodes, edges };
  const next = random(total);
  const sourceCount = Math.max(1, Math.round(total / 60));
  const topicCount = Math.max(1, Math.round(total / 250));
  const memoryCount = Math.max(0, total - sourceCount - topicCount - 1);
  const sources: string[] = [];
  const topics: string[] = [];
  const pad = (value: number) => String(value).padStart(5, "0");
  nodes.push({ id: "synthetic:source-root", type: "SOURCE", label: "gemini.md", sourcePath: "/demo/gemini.md", recordId: null });
  for (let i = 0; i < sourceCount; i++) {
    const id = `synthetic:source-${pad(i)}`;
    sources.push(id);
    nodes.push({ id, type: "SOURCE", label: `notes-${pad(i)}.md`, sourcePath: `/demo/notes-${pad(i)}.md`, recordId: null });
    edges.push({ id: `synthetic:derived-${pad(i)}`, type: "DERIVED_FROM", source: "synthetic:source-root", target: id });
  }
  for (let i = 0; i < topicCount; i++) {
    const id = `synthetic:topic-${pad(i)}`;
    topics.push(id);
    nodes.push({ id, type: "TOPIC", label: `Topic ${i}`, sourcePath: null, recordId: null });
  }
  for (let i = 0; i < memoryCount; i++) {
    const id = `synthetic:memory-${pad(i)}`;
    const sourceIndex = Math.floor(i * sourceCount / memoryCount);
    const source = sources[sourceIndex]!;
    nodes.push({ id, type: "MEMORY", label: `Synthetic memory ${i}`, sourcePath: `/demo/notes-${pad(sourceIndex)}.md`, recordId: id });
    edges.push({ id: `synthetic:contains-${pad(i)}`, type: "CONTAINS", source, target: id });
    edges.push({ id: `synthetic:tag-${pad(i)}`, type: "TAGGED_WITH", source: id, target: topics[Math.floor(next() * topicCount)]!, origin: "DERIVED_TFIDF", confidence: 0.6, evidence: "Synthetic benchmark tag." });
    // Mostly local links with some long-range ones, as in real archives.
    const near = next() < 0.8;
    const other = near ? Math.min(memoryCount - 1, Math.max(0, i + 1 + Math.floor(next() * 40))) : Math.floor(next() * memoryCount);
    if (other !== i) edges.push({ id: `synthetic:related-${pad(i)}`, type: "SEMANTICALLY_RELATED", source: id, target: `synthetic:memory-${pad(other)}`, origin: "DETERMINISTIC_TFIDF", confidence: 0.5, evidence: "Synthetic benchmark relation." });
  }
  return { nodes, edges };
}
