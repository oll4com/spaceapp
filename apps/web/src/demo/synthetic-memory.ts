import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload } from "@space/contracts";

/**
 * Synthetic memory graph generator for the public demo (issue #62).
 *
 * Deterministic for a given size, so anyone can reproduce the large-graph
 * benchmark at 2k / 10k / 50k nodes without a backend, an embeddings provider
 * or real memory files. The shape mirrors the canonical corpus: a core rules
 * file, monthly source files, memory records inside them, explicit tag topics
 * binding memories together, and provenance edges from the core file to every
 * source. Payload fits the overview schema budget (nodes <= 50,000,
 * edges <= 150,000, summary.sourceCount <= 24).
 */

const SLOPE = 4294967291; // large prime so the multiplicative hash spreads

function unit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, SLOPE);
  return ((hash ^ (hash >>> 13)) >>> 0) / 4294967296;
}

const MONTHS = [
  "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
  "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"
];

export const SYNTHETIC_MEMORY_SIZES = [2000, 10000, 50000];

/** Builds a contract-valid memory graph payload with exactly `size` nodes. */
export function createSyntheticMemoryGraph(size: number): MemoryGraphPayload {
  const total = Math.max(2000, Math.min(50000, Math.floor(size)));
  const rootId = `source:core-${total}`;
  const topicCount = Math.max(24, Math.round(total * 0.004));
  const sourceCount = Math.max(2, Math.min(MONTHS.length, Math.round(total * 0.0006)));
  const memoryCount = total - 1 - sourceCount - topicCount;

  const nodes: MemoryGraphNode[] = [
    { id: rootId, type: "SOURCE", label: "space.md", sourcePath: "/opt/spaceapp/docs/space.md", recordId: null }
  ];
  const sources: MemoryGraphNode[] = [];
  for (let index = 0; index < sourceCount; index += 1) {
    const month = MONTHS[Math.floor((index / sourceCount) * MONTHS.length)]!;
    const node: MemoryGraphNode = {
      id: `source:synthetic-${total}-${index}`,
      type: "SOURCE",
      label: `space_memory_${month}.md`,
      sourcePath: `/opt/spaceapp/docs/space_memory_${month}.md`,
      recordId: null
    };
    nodes.push(node);
    sources.push(node);
  }
  const topics: MemoryGraphNode[] = [];
  for (let index = 0; index < topicCount; index += 1) {
    const node: MemoryGraphNode = {
      id: `topic:synthetic-${total}-${index}`,
      type: "TOPIC",
      label: `Synthetic theme ${index}`,
      sourcePath: null,
      recordId: null
    };
    nodes.push(node);
    topics.push(node);
  }
  for (let index = 0; index < memoryCount; index += 1) {
    nodes.push({
      id: `memory:synthetic-${total}-${index}`,
      type: "MEMORY",
      label: `Synthetic memory ${index}`,
      sourcePath: sources[index % sourceCount]!.sourcePath,
      recordId: `memory:synthetic-${total}-${index}`
    });
  }

  const edges: MemoryGraphEdge[] = [];
  // Provenance from the core file to every monthly source.
  for (const source of sources) {
    edges.push({ id: `edge:derived:${source.id}`, type: "DERIVED_FROM", source: rootId, target: source.id });
  }
  // Every memory lives in exactly one source file.
  for (let index = 0; index < memoryCount; index += 1) {
    const source = sources[index % sourceCount]!;
    edges.push({
      id: `edge:contains:synthetic-${total}-${index}`,
      type: "CONTAINS",
      source: source.id,
      target: `memory:synthetic-${total}-${index}`
    });
  }
  // Two explicit tag links per memory keep the topic layer connected while the
  // total stays inside the overview edge budget even at 50k nodes.
  const tagCount = Math.min(2 * memoryCount, 149000 - edges.length);
  for (let index = 0; index < tagCount; index += 1) {
    const memoryIndex = Math.floor(index / 2) % memoryCount;
    const topic = topics[Math.floor(unit(`tag:${index}`) * topicCount) % topicCount]!;
    edges.push({
      id: `edge:tag:synthetic-${total}-${index}`,
      type: "TAGGED_WITH",
      source: `memory:synthetic-${total}-${memoryIndex}`,
      target: topic.id,
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Synthetic demo tag (issue #62 benchmark corpus)."
    });
  }

  return {
    version: 2,
    layoutVersion: 2,
    taxonomyVersion: 1,
    generatedAt: "2026-10-16T00:00:00.000Z",
    sourceHash: "b".repeat(64),
    isStale: false,
    summary: {
      sourceCount: sourceCount + 1,
      recordCount: memoryCount,
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
    },
    months: []
  };
}
