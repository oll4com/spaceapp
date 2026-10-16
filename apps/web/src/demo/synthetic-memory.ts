import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload } from "@space/contracts";

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a deterministic synthetic memory graph topology for benchmarking and scale testing.
 * Creates structured core, source, topic, and memory nodes with proportional containment and tagging edges.
 *
 * @param targetNodes - The desired node count (clamped between 10 and 50,000).
 * @param seed - PRNG seed for deterministic repeatability.
 */
export function generateSyntheticMemoryGraph(targetNodes = 2000, seed = 42): MemoryGraphPayload {
  const count = Math.max(10, Math.min(50000, targetNodes));
  const rng = mulberry32(seed ? seed : count * 1337);

  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];

  // Root node recognized by isMemoryCoreLabel
  const rootNode: MemoryGraphNode = {
    id: "source:space-core",
    type: "SOURCE",
    label: "space.md",
    sourcePath: "/opt/spaceapp/docs/space.md",
    recordId: null
  };
  nodes.push(rootNode);

  // Allocate node budgets
  const sourceCount = Math.max(3, Math.min(120, Math.floor(count * 0.05)));
  const topicCount = Math.max(5, Math.min(160, Math.floor(count * 0.05)));
  const memoryCount = count - 1 - sourceCount - topicCount;

  const sources: MemoryGraphNode[] = [];
  for (let i = 0; i < sourceCount; i++) {
    const id = `source:file-${i}`;
    const node: MemoryGraphNode = {
      id,
      type: "SOURCE",
      label: `document-${i}.md`,
      sourcePath: `/opt/spaceapp/docs/document-${i}.md`,
      recordId: null
    };
    sources.push(node);
    nodes.push(node);
    edges.push({
      id: `edge:core-${i}`,
      type: "DERIVED_FROM",
      source: rootNode.id,
      target: id,
      evidence: "Core system documentation"
    });
  }

  const topics: MemoryGraphNode[] = [];
  const topicNames = [
    "architecture", "performance", "rendering", "webgl", "memory",
    "clustering", "algorithms", "canvas", "shaders", "workers",
    "temporal", "storage", "security", "database", "contracts"
  ];
  for (let i = 0; i < topicCount; i++) {
    const id = `topic:${i}`;
    const name = topicNames[i % topicNames.length]!;
    const node: MemoryGraphNode = {
      id,
      type: "TOPIC",
      label: `${name}-${Math.floor(i / topicNames.length)}`,
      sourcePath: null,
      recordId: null
    };
    topics.push(node);
    nodes.push(node);
  }

  // Create memories and connect them to sources and topics
  for (let i = 0; i < memoryCount; i++) {
    const id = `memory:${i}`;
    const assignedSource = sources[Math.floor(rng() * sources.length)]!;
    const assignedTopic = topics[Math.floor(rng() * topics.length)]!;

    const node: MemoryGraphNode = {
      id,
      type: "MEMORY",
      label: `Fact ${i}: ${assignedTopic.label}`,
      sourcePath: assignedSource.sourcePath,
      recordId: id
    };
    nodes.push(node);

    // Structural containment edge
    edges.push({
      id: `edge:contains-${i}`,
      type: "CONTAINS",
      source: assignedSource.id,
      target: id,
      evidence: "Document section entry"
    });

    // Topic tagging edge
    edges.push({
      id: `edge:tag-${i}`,
      type: "TAGGED_WITH",
      source: id,
      target: assignedTopic.id,
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Synthetic topic assignment"
    });

    // Inter-memory semantic relationships to reach ~150k edges at 50k nodes (~3x ratio)
    if (i > 0 && rng() < 0.65) {
      const neighborIndex = Math.max(0, i - 1 - Math.floor(rng() * 20));
      edges.push({
        id: `edge:semantic-${i}`,
        type: "DERIVED_FROM",
        source: id,
        target: `memory:${neighborIndex}`,
        confidence: 0.85,
        evidence: "Cluster affinity"
      });
    }
  }

  return {
    version: 1,
    generatedAt: "2026-10-16T12:00:00.000Z",
    sourceHash: "0".repeat(64),
    isStale: false,
    months: ["all"],
    summary: {
      sourceCount: sources.length + 1,
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
    }
  };
}
