import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeDetail } from "@space/contracts";
import { MEMORY_GRAPH_OVERVIEW_MAX_EDGE_LIMIT, MEMORY_GRAPH_OVERVIEW_MAX_NODE_LIMIT } from "@space/contracts";

const SOURCE_HASH = "c".repeat(64);
const CONTENT_HASH = "d".repeat(64);

export interface SyntheticMemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  nodeCount: number;
  edgeCount: number;
}

export function clampSyntheticMemorySize(nodeCount: number, edgeCount?: number) {
  const nodes = Math.max(1, Math.min(MEMORY_GRAPH_OVERVIEW_MAX_NODE_LIMIT, Math.floor(nodeCount) || 1));
  const requestedEdges = edgeCount === undefined ? nodes * 3 : Math.floor(edgeCount);
  const edges = Math.max(0, Math.min(MEMORY_GRAPH_OVERVIEW_MAX_EDGE_LIMIT, requestedEdges));
  return { nodes, edges };
}

/** Deterministic archive large enough to reproduce the 3D benchmark without a backend. */
export function createSyntheticMemoryGraph(nodeCount: number, edgeCount?: number): SyntheticMemoryGraph {
  const size = clampSyntheticMemorySize(nodeCount, edgeCount);
  const topicCount = size.nodes >= 16 ? Math.min(8, Math.floor(size.nodes / 20)) : 0;
  const sourceCount = size.nodes >= 8 ? Math.min(23, Math.max(1, Math.floor(size.nodes / 80))) : 0;
  const memoryCount = size.nodes - 1 - sourceCount - topicCount;
  const nodes: MemoryGraphNode[] = [{
    id: "source:space.md",
    type: "SOURCE",
    label: "space.md",
    sourcePath: "/demo/memory/space.md",
    recordId: null
  }];
  for (let index = 0; index < sourceCount; index++) {
    const month = String((index % 12) + 1).padStart(2, "0");
    nodes.push({
      id: `source:${String(index + 1).padStart(8, "0")}`,
      type: "SOURCE",
      label: `archive-${String(index + 1).padStart(2, "0")}.md`,
      sourcePath: `/demo/memory/space_memory_2026-${month}.md`,
      recordId: null
    });
  }
  for (let index = 0; index < topicCount; index++) {
    nodes.push({
      id: `topic:${String(index + 1).padStart(8, "0")}`,
      type: "TOPIC",
      label: `Topic ${index + 1}`,
      sourcePath: null,
      recordId: null
    });
  }
  const sourceIds = nodes.filter(node => node.type === "SOURCE").map(node => node.id);
  const sourcePaths = new Map(nodes.filter(node => node.type === "SOURCE").map(node => [node.id, node.sourcePath]));
  for (let index = 0; index < memoryCount; index++) {
    const source = sourceIds[index % sourceIds.length] ?? "source:space.md";
    nodes.push({
      id: `memory:${String(index + 1).padStart(8, "0")}`,
      type: "MEMORY",
      label: `Memory ${String(index + 1).padStart(6, "0")}`,
      sourcePath: sourcePaths.get(source) ?? "/demo/memory/space.md",
      recordId: `memory:${String(index + 1).padStart(8, "0")}`
    });
  }
  const edges: MemoryGraphEdge[] = [];
  const push = (edge: MemoryGraphEdge) => {
    if (edges.length < size.edges) edges.push(edge);
  };
  for (let index = 0; index < sourceCount; index++) {
    push({
      id: `edge:derived:${String(index + 1).padStart(8, "0")}`,
      type: "DERIVED_FROM",
      source: "source:space.md",
      target: `source:${String(index + 1).padStart(8, "0")}`
    });
  }
  for (let index = 0; index < memoryCount; index++) {
    push({
      id: `edge:contains:${String(index + 1).padStart(8, "0")}`,
      type: "CONTAINS",
      source: sourceIds[index % sourceIds.length]!,
      target: `memory:${String(index + 1).padStart(8, "0")}`
    });
  }
  if (topicCount > 0) {
    for (let index = 0; index < memoryCount; index++) {
      const topic = (index % topicCount) + 1;
      push({
        id: `edge:tag:${String(index + 1).padStart(8, "0")}`,
        type: "TAGGED_WITH",
        source: `memory:${String(index + 1).padStart(8, "0")}`,
        target: `topic:${String(topic).padStart(8, "0")}`,
        origin: "EXPLICIT_TAG",
        confidence: 1,
        evidence: "Synthetic explicit tag."
      });
    }
  }
  let semantic = 0;
  while (edges.length < size.edges && memoryCount > 1) {
    const source = semantic % memoryCount;
    const target = (source + 1 + (semantic % (memoryCount - 1))) % memoryCount;
    if (source !== target) {
      push({
        id: `edge:semantic:${String(semantic + 1).padStart(8, "0")}`,
        type: "SEMANTICALLY_RELATED",
        source: `memory:${String(source + 1).padStart(8, "0")}`,
        target: `memory:${String(target + 1).padStart(8, "0")}`,
        origin: "DETERMINISTIC_TFIDF",
        confidence: 0.42,
        evidence: "Synthetic semantic link."
      });
    }
    semantic += 1;
    if (semantic > size.edges + memoryCount) break;
  }
  return { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
}

export function syntheticMemoryOverview(nodeCount: number, edgeCount?: number) {
  const graph = createSyntheticMemoryGraph(nodeCount, edgeCount);
  const sourceCount = Math.min(24, graph.nodes.filter(node => node.type === "SOURCE").length);
  return {
    version: 1 as const,
    generatedAt: "2026-07-16T08:00:00.000Z",
    sourceHash: SOURCE_HASH,
    isStale: false,
    summary: {
      sourceCount,
      recordCount: graph.nodes.filter(node => node.type === "MEMORY").length,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      issueCount: 0
    },
    nodes: graph.nodes,
    edges: graph.edges,
    totalMatchingNodes: graph.nodeCount,
    totalMatchingEdges: graph.edgeCount,
    truncated: false,
    filters: {
      q: null,
      nodeType: null,
      scope: null,
      roomId: null,
      sourcePath: null,
      lifecycleStatus: null,
      relationMode: "RELATIONS" as const,
      month: "all"
    },
    months: ["2026-10"]
  };
}

const syntheticId = /^(?:source:space\.md|source:\d{8}|topic:\d{8}|memory:\d{8})$/;

export function syntheticMemoryNodeDetail(id: string): MemoryGraphNodeDetail | null {
  if (!syntheticId.test(id)) return null;
  const type = id.startsWith("memory:") ? "MEMORY" as const : id.startsWith("topic:") ? "TOPIC" as const : "SOURCE" as const;
  const label = id === "source:space.md"
    ? "space.md"
    : type === "MEMORY"
      ? `Memory ${id.slice("memory:".length)}`
      : type === "TOPIC"
        ? `Topic ${Number(id.slice("topic:".length))}`
        : `archive-${id.slice("source:".length)}.md`;
  return {
    node: {
      id,
      type,
      label,
      sourcePath: type === "TOPIC" ? null : "/demo/memory/space.md",
      recordId: type === "MEMORY" ? id : null
    },
    record: type === "MEMORY" ? {
      id,
      sourcePath: "/demo/memory/space.md",
      sectionId: "section:synthetic",
      title: label,
      body: "Synthetic memory generated in the local demo.",
      createdAt: "2026-07-16T08:00:00.000Z",
      scope: "SYSTEM",
      roomId: null,
      provenance: "demo",
      contentHash: CONTENT_HASH,
      lifecycleStatus: "ACTIVE"
    } : null,
    relatedNodes: [],
    relatedEdges: [],
    issues: []
  };
}
