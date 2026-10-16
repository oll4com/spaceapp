import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/**
 * Deterministic synthetic memory graph for the demo workspace, so anyone can
 * reproduce the large-graph rendering benchmark without a real archive:
 * request the overview with a `limit` (or `graphSize`) above the fixture
 * size and the demo store serves a generated graph of exactly that many
 * nodes — one `space.md` core source, ~2% sources, ~1% topics, the rest
 * memories, with CONTAINS / DERIVED_FROM / TAGGED_WITH /
 * SEMANTICALLY_RELATED edges at ~3 edges per node (150k edges at 50k
 * nodes). Every choice derives from the node index or the same FNV hash the
 * layouts use, so the graph is identical on every call and every machine.
 */
export function createSyntheticMemoryGraph(size: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const total = Math.max(1, Math.floor(size));
  const sourceCount = Math.max(1, Math.round(total * 0.02));
  const topicCount = Math.max(1, Math.round(total * 0.01));
  const memoryCount = Math.max(0, total - sourceCount - topicCount);
  const nodes: MemoryGraphNode[] = [];
  const sourcePath = (index: number) => index === 0 ? "/demo/synthetic/space.md" : `/demo/synthetic/source-${index}.md`;
  for (let i = 0; i < sourceCount; i++) {
    nodes.push({
      id: `synthetic:source:${i}`,
      type: "SOURCE",
      label: i === 0 ? "space.md" : `synthetic-source-${i}.md`,
      sourcePath: sourcePath(i),
      recordId: null
    });
  }
  for (let i = 0; i < topicCount; i++) {
    nodes.push({ id: `synthetic:topic:${i}`, type: "TOPIC", label: `Synthetic topic ${i}`, sourcePath: null, recordId: null });
  }
  for (let i = 0; i < memoryCount; i++) {
    nodes.push({
      id: `synthetic:memory:${i}`,
      type: "MEMORY",
      label: `Synthetic memory ${i}`,
      sourcePath: sourcePath(i % sourceCount),
      recordId: `synthetic:record:${i}`
    });
  }
  const edges: MemoryGraphEdge[] = [];
  const push = (type: MemoryGraphEdge["type"], source: string, target: string, extra: Partial<MemoryGraphEdge> = {}) => {
    edges.push({ id: `synthetic:edge:${edges.length}`, type, source, target, ...extra });
  };
  for (let i = 1; i < sourceCount; i++) push("DERIVED_FROM", `synthetic:source:${i}`, `synthetic:source:${i - 1}`);
  for (let i = 0; i < memoryCount; i++) {
    push("CONTAINS", `synthetic:source:${i % sourceCount}`, `synthetic:memory:${i}`);
    push("TAGGED_WITH", `synthetic:memory:${i}`, `synthetic:topic:${(i * 7) % topicCount}`, {
      origin: "EXPLICIT_TAG",
      confidence: 0.9,
      evidence: "Synthetic benchmark fixture."
    });
  }
  // One semantic link per memory to a deterministic pseudo-random peer.
  for (let i = 0; memoryCount > 1 && i < memoryCount; i++) {
    const target = (i + 1 + Math.floor(unit(`synthetic:peer:${i}`) * (memoryCount - 1))) % memoryCount;
    if (target === i) continue;
    push("SEMANTICALLY_RELATED", `synthetic:memory:${i}`, `synthetic:memory:${target}`, {
      origin: "DETERMINISTIC_TFIDF",
      confidence: 0.5 + unit(`synthetic:confidence:${i}`) * 0.5,
      evidence: "Synthetic benchmark fixture."
    });
  }
  return { nodes, edges };
}

// The layouts' FNV-style avalanche hash, kept local so the fixture has no
// import cycle with the memory workspace.
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};
