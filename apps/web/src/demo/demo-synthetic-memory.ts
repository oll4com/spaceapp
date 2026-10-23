import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { DEMO_FIXED_AT } from "./demo-fixture.js";

// Demo mode can generate a deterministic synthetic graph of a given size so the
// 50k-node benchmark is reproducible without a backend or embeddings provider.
export const SYNTHETIC_MEMORY_GRAPH_MAX_NODES = 50000;

const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
};

const syntheticDigest = (nodeCount: number) => {
  let hash = 2166136261 ^ nodeCount;
  let out = "";
  for (let round = 0; round < 16; round++) {
    hash = Math.imul(hash ^ (hash >>> 13), 16777619) >>> 0;
    out += hash.toString(16).padStart(8, "0").slice(0, 4);
  }
  return out;
};

const pad = (value: number) => String(value).padStart(6, "0");

export type SyntheticMemoryGraphShape = { total: number; sources: number; topics: number; memories: number };

export function syntheticMemoryGraphShape(nodeCount: number): SyntheticMemoryGraphShape {
  const total = Math.max(1, Math.min(SYNTHETIC_MEMORY_GRAPH_MAX_NODES, Math.floor(nodeCount)));
  const sources = Math.max(1, Math.min(total, 24));
  const topics = Math.max(1, Math.min(total - sources, Math.round(total / 100)));
  return { total, sources, topics, memories: Math.max(0, total - sources - topics) };
}

const syntheticNode = (id: string, type: MemoryGraphNode["type"], label: string, sourcePath: string, recordId: string | null): MemoryGraphNode => ({
  id, type, label, sourcePath, recordId,
  position: {
    clustered: { x: Math.round((unit(`${id}:cluster-x`) - 0.5) * 400), y: Math.round((unit(`${id}:cluster-y`) - 0.5) * 300) },
    relations: { x: Math.round((unit(`${id}:relations-x`) - 0.5) * 400), y: Math.round((unit(`${id}:relations-y`) - 0.5) * 300) }
  }
});

/** Builds the nodes and edges for index range [start, start + count) of the synthetic shape. */
export function syntheticMemoryGraphSlice(start: number, count: number, shape: SyntheticMemoryGraphShape): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  for (let offset = 0; offset < count; offset++) {
    const index = start + offset;
    if (index >= shape.total) break;
    if (index < shape.sources) {
      const id = `source:synth-${pad(index)}`;
      const sourcePath = `/demo/memory/synthetic_source_${pad(index)}.md`;
      nodes.push(syntheticNode(id, "SOURCE", `synthetic_source_${pad(index)}.md`, sourcePath, null));
      if (shape.sources > 1) edges.push({ id: `memory_edge:synth-derived-${pad(index)}`, type: "DERIVED_FROM", source: id, target: `source:synth-${pad((index + 1) % shape.sources)}` });
    } else if (index < shape.sources + shape.topics) {
      const topic = index - shape.sources;
      nodes.push(syntheticNode(`topic:synth-${pad(topic)}`, "TOPIC", `synthetic topic ${topic}`, `/demo/memory/synthetic_source_${pad(topic % shape.sources)}.md`, null));
    } else {
      const memory = index - shape.sources - shape.topics;
      const parent = memory % shape.sources;
      const id = `memory:synth-${pad(memory)}`;
      const sourcePath = `/demo/memory/synthetic_source_${pad(parent)}.md`;
      nodes.push(syntheticNode(id, "MEMORY", `Synthetic memory ${memory}`, sourcePath, id));
      edges.push({ id: `memory_edge:synth-contains-${pad(index)}`, type: "CONTAINS", source: `source:synth-${pad(parent)}`, target: id });
      edges.push({
        id: `memory_edge:synth-tagged-${pad(index)}`, type: "TAGGED_WITH", source: id, target: `topic:synth-${pad(memory % shape.topics)}`,
        origin: "EXPLICIT_TAG", confidence: 1, evidence: "Deterministic synthetic demo tag."
      });
      if (memory + 1 < shape.memories) {
        edges.push({
          id: `memory_edge:synth-related-${pad(index)}`, type: "SEMANTICALLY_RELATED", source: id, target: `memory:synth-${pad(memory + 1)}`,
          origin: "DETERMINISTIC_TFIDF", confidence: 0.9, evidence: "Deterministic synthetic demo relation."
        });
      }
    }
  }
  return { nodes, edges };
}

export function syntheticMemoryGraphSummary(shape: SyntheticMemoryGraphShape) {
  return {
    sourceCount: shape.sources,
    recordCount: shape.memories,
    nodeCount: shape.total,
    edgeCount: shape.memories * 3 + shape.sources - (shape.memories > 0 ? 1 : 0),
    issueCount: 0
  };
}

export function syntheticMemoryGraphMetadata(nodeCount: number) {
  return {
    version: 2 as const,
    generatedAt: DEMO_FIXED_AT,
    sourceHash: syntheticDigest(nodeCount),
    revisionHash: syntheticDigest(nodeCount + 1),
    isStale: false,
    layoutVersion: 2 as const,
    taxonomyVersion: 2 as const,
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      relationMode: "RELATIONS" as const,
      month: null
    },
    months: [] as string[]
  };
}
