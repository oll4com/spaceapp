import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphPayload, MemoryGraphNodeDetail } from "@space/contracts";
import { DEMO_FIXED_AT } from "./demo-fixture.js";

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
function createRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_NAMES = [
  "Architecture", "Deployment", "Database", "Security", "AI Models",
  "Memory Graph", "Performance", "Streaming", "Realtime Sync", "UI Components",
  "Electron Runtime", "PostgreSQL", "Vector Search", "Docker Engine", "Workspaces"
];

/**
 * Generates a deterministic synthetic memory graph of a specified size.
 * Generates ~3x edges per node (e.g., 50,000 nodes -> 150,000 edges).
 */
export function generateSyntheticMemoryGraph(nodeCount: number = 2000): MemoryGraphPayload {
  const targetCount = Math.max(10, nodeCount);
  const targetEdges = Math.round(targetCount * 3);
  const rng = createRng(42 + targetCount);

  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const edgeSet = new Set<string>();

  // 1. Root core source node (space.md)
  const rootNode: MemoryGraphNode = {
    id: "source:core",
    label: "space.md",
    type: "SOURCE",
    sourcePath: "/workspace/space.md",
    recordId: null
  };
  nodes.push(rootNode);

  // 2. Additional source nodes (~5% of nodes)
  const sourceCount = Math.max(3, Math.floor(targetCount * 0.05));
  const sourceNodes: MemoryGraphNode[] = [];
  for (let i = 1; i <= sourceCount; i++) {
    const node: MemoryGraphNode = {
      id: `source:doc-${i}`,
      label: `System Architecture Doc ${i}.md`,
      type: "SOURCE",
      sourcePath: `/workspace/docs/doc-${i}.md`,
      recordId: null
    };
    nodes.push(node);
    sourceNodes.push(node);

    // Link from root to each source
    const edgeId = `edge:root-source-${i}`;
    edges.push({ id: edgeId, source: rootNode.id, target: node.id, type: "DERIVED_FROM" });
    edgeSet.add(`${rootNode.id}->${node.id}`);
  }

  // 3. Topic nodes (~10% of nodes)
  const topicCount = Math.max(4, Math.floor(targetCount * 0.10));
  const topicNodes: MemoryGraphNode[] = [];
  for (let i = 1; i <= topicCount; i++) {
    const name = TOPIC_NAMES[(i - 1) % TOPIC_NAMES.length]!;
    const node: MemoryGraphNode = {
      id: `topic:${i}`,
      label: topicCount <= TOPIC_NAMES.length ? name : `${name} ${Math.floor((i - 1) / TOPIC_NAMES.length) + 1}`,
      type: "TOPIC",
      sourcePath: null,
      recordId: null
    };
    nodes.push(node);
    topicNodes.push(node);
  }

  // 4. Memory nodes (remaining ~85%)
  const memoryCount = targetCount - nodes.length;
  const memoryNodes: MemoryGraphNode[] = [];
  for (let i = 1; i <= memoryCount; i++) {
    const parentSource = sourceNodes[Math.floor(rng() * sourceNodes.length)]!;
    const node: MemoryGraphNode = {
      id: `memory:${i}`,
      label: `Memory #${i}: Insight on ${TOPIC_NAMES[i % TOPIC_NAMES.length]}`,
      type: "MEMORY",
      sourcePath: parentSource.sourcePath,
      recordId: `rec:${i}`
    };
    nodes.push(node);
    memoryNodes.push(node);

    // Link from parent source to memory
    const edgeKey = `${parentSource.id}->${node.id}`;
    if (!edgeSet.has(edgeKey)) {
      edges.push({ id: `edge:src-mem-${i}`, source: parentSource.id, target: node.id, type: "CONTAINS" });
      edgeSet.add(edgeKey);
    }
  }

  // 5. Connect memory nodes to topics via TAGGED_WITH (ensuring at least 2 memories per topic so createMemoryAtlas keeps it)
  for (let t = 0; t < topicNodes.length; t++) {
    const topic = topicNodes[t]!;
    const mem1 = memoryNodes[(t * 2) % memoryNodes.length]!;
    const mem2 = memoryNodes[(t * 2 + 1) % memoryNodes.length]!;
    for (const mem of [mem1, mem2]) {
      const edgeKey = `${mem.id}->${topic.id}`;
      if (!edgeSet.has(edgeKey)) {
        edges.push({ id: `edge:tag-init-${edges.length}`, source: mem.id, target: topic.id, type: "TAGGED_WITH" });
        edgeSet.add(edgeKey);
      }
    }
  }

  for (let i = 0; i < memoryNodes.length; i++) {
    const mem = memoryNodes[i]!;
    const topic = topicNodes[Math.floor(rng() * topicNodes.length)]!;
    const edgeKey = `${mem.id}->${topic.id}`;
    if (!edgeSet.has(edgeKey)) {
      edges.push({ id: `edge:mem-top-${i}`, source: mem.id, target: topic.id, type: "TAGGED_WITH" });
      edgeSet.add(edgeKey);
    }
  }

  // 6. Connect memory nodes to nearby memories (derived from chain)
  for (let i = 1; i < memoryNodes.length; i++) {
    const memA = memoryNodes[i]!;
    // Link to one of the previous 5 memories
    const offset = 1 + Math.floor(rng() * Math.min(5, i));
    const memB = memoryNodes[i - offset]!;
    const edgeKey = `${memB.id}->${memA.id}`;
    if (!edgeSet.has(edgeKey)) {
      edges.push({ id: `edge:mem-mem-${i}`, source: memB.id, target: memA.id, type: "DERIVED_FROM" });
      edgeSet.add(edgeKey);
    }
  }

  // 7. Add additional edges to reach target edge count (~3x node count)
  let extraEdgeCounter = 0;
  while (edges.length < targetEdges && extraEdgeCounter < targetEdges * 2) {
    extraEdgeCounter++;
    const idxA = Math.floor(rng() * nodes.length);
    const idxB = Math.floor(rng() * nodes.length);
    if (idxA === idxB) continue;
    const a = nodes[idxA]!;
    const b = nodes[idxB]!;
    const key = `${a.id}->${b.id}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({
        id: `edge:extra-${edges.length}`,
        source: a.id,
        target: b.id,
        type: a.type === "SOURCE" ? "CONTAINS" : "DERIVED_FROM"
      });
    }
  }

  return {
    version: 2,
    generatedAt: DEMO_FIXED_AT,
    sourceHash: "0".repeat(64),
    revisionHash: "f".repeat(64),
    isStale: false,
    summary: {
      sourceCount: 1 + sourceCount,
      recordCount: memoryCount,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      issueCount: 0
    },
    nodes,
    edges,
    layoutVersion: 2,
    taxonomyVersion: 2,
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
    months: ["2026-10"]
  };
}

/**
 * Generates synthetic node detail for interactive exploration in demo mode.
 */
export function getSyntheticNodeDetail(nodeId: string, graph?: MemoryGraphPayload): MemoryGraphNodeDetail {
  const node = graph?.nodes.find(n => n.id === nodeId) ?? {
    id: nodeId,
    label: nodeId,
    type: (nodeId.startsWith("source:") ? "SOURCE" : nodeId.startsWith("topic:") ? "TOPIC" : "MEMORY") as MemoryGraphNode["type"],
    sourcePath: "/workspace/docs.md",
    recordId: nodeId.startsWith("memory:") ? `rec:${nodeId}` : null
  };

  return {
    node,
    record: node.recordId ? {
      id: node.recordId,
      sourcePath: node.sourcePath ?? "/workspace/docs.md",
      sectionId: `sec:${node.id}`,
      title: node.label,
      body: `Synthetic memory record body for ${node.label}. This memory was automatically indexed and connected into the 3D knowledge network.`,
      scope: "PROJECT",
      roomId: null,
      provenance: "synthetic",
      contentHash: "0".repeat(64),
      lifecycleStatus: "ACTIVE",
      createdAt: DEMO_FIXED_AT
    } : null,
    relatedNodes: [],
    relatedEdges: [],
    issues: []
  };
}
