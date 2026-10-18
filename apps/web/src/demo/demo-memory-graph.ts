import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeDetail, MemoryGraphOverviewPayload } from "@space/contracts";
import { DEMO_FIXED_AT } from "./demo-fixture.js";

export const DEMO_MEMORY_NODE_COUNTS = [2000, 10_000, 50_000] as const;
export type DemoMemoryNodeCount = typeof DEMO_MEMORY_NODE_COUNTS[number];
export type DemoMemoryGraph = {
  data: MemoryGraphOverviewPayload;
  byId: Map<string, MemoryGraphNode>;
  neighbors: Map<string, MemoryGraphEdge[]>;
};

/** Accept only the supported opt-in fixture sizes from demo URL parameters. */
export function demoMemoryNodeCount(value: unknown): DemoMemoryNodeCount | undefined {
  const count = Number(value);
  return DEMO_MEMORY_NODE_COUNTS.find(candidate => candidate === count);
}

// Yield between bounded batches so fixture construction never monopolizes the UI thread.
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sourcePath = "/demo/memory/space_memory_2026-10.md";
const themes = ["Product", "Engineering", "Research", "Design", "Operations", "Support", "Planning", "Delivery"];

/** Generate deterministic synthetic relations in bounded batches without backend access. */
export async function createLargeDemoMemoryGraph(count: DemoMemoryNodeCount): Promise<DemoMemoryGraph> {
  const nodes: MemoryGraphNode[] = [{ id: "source:synthetic", type: "SOURCE", label: "gemini.md", sourcePath, recordId: null }];
  for (let index = 0; index < themes.length; index++) {
    nodes.push({ id: `topic:synthetic:${index}`, type: "TOPIC", label: themes[index]!, sourcePath: null, recordId: null });
  }
  const memoryCount = count - nodes.length;
  const edges: MemoryGraphEdge[] = [];
  const neighbors = new Map<string, MemoryGraphEdge[]>();
  const addEdge = (edge: MemoryGraphEdge) => {
    edges.push(edge);
    for (const id of [edge.source, edge.target]) {
      let adjacent = neighbors.get(id);
      if (!adjacent) { adjacent = []; neighbors.set(id, adjacent); }
      adjacent.push(edge);
    }
  };
  for (let start = 0; start < memoryCount; start += 400) {
    for (let index = start; index < Math.min(start + 400, memoryCount); index++) {
      const id = `memory:synthetic:${index}`;
      nodes.push({ id, type: "MEMORY", label: `${themes[index % themes.length]} memory ${index + 1}`, sourcePath, recordId: id });
      addEdge({ id: `edge:synthetic:source:${index}`, type: "CONTAINS", source: "source:synthetic", target: id });
      addEdge({ id: `edge:synthetic:tag:${index}`, type: "TAGGED_WITH", source: id, target: `topic:synthetic:${index % themes.length}`, origin: "EXPLICIT_TAG", confidence: 1, evidence: "Explicit synthetic fixture theme." });
      // A synthetic revision chain exercises cross-memory links without implying measured similarity.
      addEdge({ id: `edge:synthetic:revision:${index}`, type: "SUPERSEDES", source: id, target: `memory:synthetic:${(index + themes.length) % memoryCount}`, evidence: "Synthetic fixture revision relationship." });
    }
    await yieldToBrowser();
  }
  const byId = new Map<string, MemoryGraphNode>();
  for (let start = 0; start < nodes.length; start += 1000) {
    for (const node of nodes.slice(start, start + 1000)) byId.set(node.id, node);
    await yieldToBrowser();
  }
  return {
    byId,
    neighbors,
    data: {
      version: 2, layoutVersion: 2, taxonomyVersion: 1, generatedAt: DEMO_FIXED_AT,
      sourceHash: "d".repeat(64), revisionHash: "d".repeat(64), isStale: false,
      summary: { sourceCount: 1, recordCount: memoryCount, nodeCount: count, edgeCount: edges.length, issueCount: 0 },
      nodes, edges, totalMatchingNodes: count, totalMatchingEdges: edges.length, truncated: false,
      filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, month: "all", relationMode: "RELATIONS" },
      months: ["2026-10"]
    }
  };
}

export type LargeDemoMemoryQuery = {
  limit?: number; q?: string; nodeType?: MemoryGraphNode["type"]; sourcePath?: string;
  scope?: "SYSTEM" | "ROOM" | "PROJECT"; roomId?: string; lifecycleStatus?: "ACTIVE" | "ARCHIVED"; month?: string; relationMode?: "CLUSTERED" | "RELATIONS";
};

/** Apply offline query filters and node/edge caps while yielding during large scans. */
export async function largeDemoMemoryOverview(graph: DemoMemoryGraph, query: LargeDemoMemoryQuery): Promise<{ data: MemoryGraphOverviewPayload }> {
  const limit = Math.min(50_000, Math.max(1, Math.floor(query.limit ?? 2000)));
  const needle = query.q?.trim().toLowerCase();
  if (limit >= graph.data.nodes.length && !needle && !query.nodeType && !query.sourcePath && !query.scope && !query.roomId && !query.lifecycleStatus && (!query.month || query.month === "all" || query.month === "2026-10")) {
    return { data: { ...graph.data, filters: { ...graph.data.filters, month: query.month ?? null, relationMode: query.relationMode ?? "RELATIONS" } } };
  }
  const matching = new Set<string>();
  for (let start = 0; start < graph.data.nodes.length; start += 1000) {
    for (const node of graph.data.nodes.slice(start, start + 1000)) {
      if ((!needle || `${node.label} ${node.sourcePath ?? ""}`.toLowerCase().includes(needle)) &&
        (!query.nodeType || node.type === query.nodeType) && (!query.sourcePath || node.sourcePath === query.sourcePath) &&
        (!query.scope || (query.scope === "SYSTEM" && node.type === "MEMORY")) && !query.roomId &&
        (!query.lifecycleStatus || (query.lifecycleStatus === "ACTIVE" && node.type === "MEMORY")) &&
        (!query.month || query.month === "all" || query.month === "2026-10")) matching.add(node.id);
    }
    await yieldToBrowser();
  }
  const anchors = new Set(matching);
  if (query.relationMode !== "CLUSTERED" && matching.size !== graph.data.nodes.length) {
    let batch = 0;
    for (const id of anchors) {
      for (const edge of graph.neighbors.get(id) ?? []) {
        matching.add(edge.source); matching.add(edge.target);
        if (++batch % 1000 === 0) await yieldToBrowser();
      }
    }
  }
  const nodes: MemoryGraphNode[] = [];
  const selected = new Set<string>();
  for (let start = 0; start < graph.data.nodes.length && nodes.length < limit; start += 1000) {
    for (const node of graph.data.nodes.slice(start, start + 1000)) {
      if (matching.has(node.id) && nodes.length < limit) { nodes.push(node); selected.add(node.id); }
    }
    await yieldToBrowser();
  }
  const edges: MemoryGraphEdge[] = [];
  let totalMatchingEdges = 0;
  const edgeLimit = Math.min(150_000, limit * 3);
  for (let start = 0; start < graph.data.edges.length; start += 2000) {
    for (const edge of graph.data.edges.slice(start, start + 2000)) {
      if (!matching.has(edge.source) || !matching.has(edge.target) ||
        (query.relationMode !== "CLUSTERED" && !anchors.has(edge.source) && !anchors.has(edge.target))) continue;
      totalMatchingEdges++;
      if (edges.length < edgeLimit && selected.has(edge.source) && selected.has(edge.target)) edges.push(edge);
    }
    await yieldToBrowser();
  }
  return { data: { ...graph.data, nodes, edges, totalMatchingNodes: matching.size, totalMatchingEdges,
    truncated: nodes.length < matching.size || edges.length < totalMatchingEdges,
    filters: { q: query.q ?? null, nodeType: query.nodeType ?? null, scope: query.scope ?? null,
      roomId: query.roomId ?? null, sourcePath: query.sourcePath ?? null, lifecycleStatus: query.lifecycleStatus ?? null,
      month: query.month ?? null, relationMode: query.relationMode ?? "RELATIONS" }
  } };
}

/** Return one fixture node with at most 500 incident relations, or null for unknown ids. */
export function largeDemoMemoryDetail(graph: DemoMemoryGraph, id: string): MemoryGraphNodeDetail | null {
  const node = graph.byId.get(id);
  if (!node) return null;
  const relatedEdges = (graph.neighbors.get(id) ?? []).slice(0, 500);
  const relatedIds = new Set(relatedEdges.map(edge => edge.source === id ? edge.target : edge.source));
  return { node, relatedEdges, relatedNodes: [...relatedIds].map(relatedId => graph.byId.get(relatedId)!).filter(Boolean), issues: [],
    record: node.type === "MEMORY" ? {
      id, title: node.label, body: `Synthetic demo memory ${id}. This local fixture does not use a backend or an embedding service.`,
      sourcePath, sectionId: "section:synthetic", createdAt: DEMO_FIXED_AT, scope: "SYSTEM", roomId: null,
      provenance: "Synthetic local demo fixture", contentHash: "d".repeat(64), lifecycleStatus: "ACTIVE"
    } : null };
}
