import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeDetail, MemoryGraphSummary } from "@space/contracts";

/** Sizes offered by the 3D view; the generator itself accepts any count of at least 200. */
export const SYNTHETIC_MEMORY_SIZES = [2000, 10_000, 50_000] as const;
const MAX_MONTHLY_SOURCES = 23; // 23 monthly sources + 1 core source = 24 sources, conforming to memoryGraphSummarySchema max 24
const EDGES_PER_NODE = 3;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticMemoryGraph {
  size: number;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  summary: MemoryGraphSummary;
  months: string[];
}

const monthKey = (offset: number) => {
  const total = 2026 * 12 + 9 - offset; // newest month is 2026-10
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};

/**
 * Deterministic synthetic archive of exactly `size` nodes and 3 * `size` edges: one core source,
 * one source per month (at most 23), topics, and memories. Ids embed the size so graphs of
 * different sizes never share node details.
 */
export function generateSyntheticMemoryGraph(size: number): SyntheticMemoryGraph {
  if (!Number.isInteger(size) || size < 200) throw new Error("A synthetic memory graph needs an integer size of at least 200.");
  const random = mulberry32(0x5eed ^ size);
  const tag = `synthetic-${size}`;
  const monthlySourceCount = Math.min(MAX_MONTHLY_SOURCES, Math.max(2, Math.floor(size / 600)));
  const topicCount = Math.min(200, Math.max(8, Math.round(size / 250)));
  const memoryCount = size - 1 - monthlySourceCount - topicCount;
  const months = Array.from({ length: monthlySourceCount }, (_, index) => monthKey(index)).reverse();
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const pad = (value: number) => String(value).padStart(6, "0");

  const coreId = `source:${tag}-core`;
  nodes.push({ id: coreId, type: "SOURCE", label: "space.md", sourcePath: `/demo/${tag}/space.md`, recordId: null });
  const sourceIds: string[] = [], sourcePaths: string[] = [];
  months.forEach((month, index) => {
    const id = `source:${tag}-${month}`, sourcePath = `/demo/${tag}/space_memory_${month}.md`;
    sourceIds.push(id); sourcePaths.push(sourcePath);
    nodes.push({ id, type: "SOURCE", label: `space_memory_${month}.md`, sourcePath, recordId: null });
    edges.push({ id: `edge:${tag}-core-${pad(index)}`, type: "DERIVED_FROM", source: coreId, target: id });
  });
  const topicIds = Array.from({ length: topicCount }, (_, index) => {
    const id = `topic:${tag}-${pad(index)}`;
    nodes.push({ id, type: "TOPIC", label: `Topic ${index + 1}`, sourcePath: null, recordId: null });
    return id;
  });
  const memoryIds: string[] = [], memorySource: number[] = [];
  for (let index = 0; index < memoryCount; index++) {
    const id = `memory:${tag}-${pad(index)}`, source = Math.floor(index * monthlySourceCount / memoryCount);
    memoryIds.push(id); memorySource.push(source);
    nodes.push({ id, type: "MEMORY", label: `Synthetic memory ${index + 1}`, sourcePath: sourcePaths[source]!, recordId: id });
    edges.push({ id: `edge:${tag}-contains-${pad(index)}`, type: "CONTAINS", source: sourceIds[source]!, target: id });
    const topic = topicIds[Math.floor(random() ** 2 * topicCount)]!; // skewed so a few topics dominate
    edges.push({ id: `edge:${tag}-tag-${pad(index)}`, type: "TAGGED_WITH", source: id, target: topic, origin: index % 3 === 0 ? "EXPLICIT_TAG" : "DERIVED_TFIDF", confidence: 0.9, evidence: "Synthetic tag." });
  }
  // Related memories fill the budget to exactly three edges per node, mostly within a source's neighbourhood.
  const target = size * EDGES_PER_NODE, seen = new Set<number>();
  let attempts = 0;
  while (edges.length < target && attempts++ < target * 20) {
    const a = Math.floor(random() * memoryCount);
    const local = random() < 0.8;
    const b = local ? Math.max(0, Math.min(memoryCount - 1, a + Math.floor((random() - 0.5) * 120))) : Math.floor(random() * memoryCount);
    if (a === b) continue;
    const key = Math.min(a, b) * memoryCount + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: `edge:${tag}-rel-${pad(edges.length)}`, type: "SEMANTICALLY_RELATED", source: memoryIds[a]!, target: memoryIds[b]!, origin: "DETERMINISTIC_TFIDF", confidence: Math.round(random() * 100) / 100, evidence: "Synthetic similarity." });
  }
  return {
    size, nodes, edges, months,
    summary: { sourceCount: 1 + monthlySourceCount, recordCount: memoryCount, nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0 }
  };
}

/** Lazily built detail for one synthetic node, with related nodes capped like the real endpoint. */
export function syntheticNodeDetail(graph: SyntheticMemoryGraph, nodeId: string, createdAt: string): MemoryGraphNodeDetail | null {
  const node = graph.nodes.find(candidate => candidate.id === nodeId);
  if (!node) return null;
  const relatedEdges = graph.edges.filter(edge => edge.source === nodeId || edge.target === nodeId).slice(0, 200);
  const relatedIds = new Set(relatedEdges.flatMap(edge => [edge.source, edge.target]).filter(id => id !== nodeId));
  return {
    node,
    record: node.recordId && node.sourcePath ? {
      id: node.recordId, sourcePath: node.sourcePath, sectionId: `section:${node.id.slice(7)}`, title: node.label,
      body: `## ${node.label}\n- Deterministic synthetic memory for benchmarking the 3D view.`,
      createdAt, scope: "SYSTEM", roomId: null, provenance: "Synthetic benchmark graph.",
      contentHash: "d".repeat(64), lifecycleStatus: "ACTIVE", tags: [], topics: []
    } : null,
    relatedNodes: graph.nodes.filter(candidate => relatedIds.has(candidate.id)).slice(0, 200),
    relatedEdges,
    issues: []
  };
}
