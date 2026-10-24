import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/**
 * Deterministic synthetic memory graph for renderer benchmarks.
 *
 * Demo mode builds this graph when the demo URL carries a `demoGraphSize`
 * query parameter (for example `/demo-workspace?demoGraphSize=50000`), so
 * anyone can reproduce the 3D renderer's frame-time benchmark without a
 * backend or an embeddings provider. The shape mirrors a real archive: a
 * core source file, source files that contain memories, explicit topic
 * tags, and semantic links — roughly three edges per node, so 50,000
 * nodes come with about 150,000 edges.
 */

const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

const scatter = (id: string, salt: string, radius: number) => {
  const angle = unit(`${id}:${salt}:angle`) * Math.PI * 2;
  const distance = Math.sqrt(unit(`${id}:${salt}:distance`)) * radius;
  return { x: Math.round(Math.cos(angle) * distance * 100) / 100, y: Math.round(Math.sin(angle) * distance * 100) / 100 };
};

export function createSyntheticMemoryGraph(nodeCount: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const count = Math.max(4, Math.floor(nodeCount));
  const sourceCount = Math.min(400, Math.max(2, Math.round(count / 25)));
  const topicCount = Math.min(200, Math.max(2, Math.round(count / 100)));
  const memoryCount = count - sourceCount - topicCount;
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const sources: MemoryGraphNode[] = [];
  for (let i = 0; i < sourceCount; i++) {
    const core = i === 0;
    const sourcePath = core ? "/demo/synthetic/space.md" : `/demo/synthetic/space_memory_2026-${String(1 + (i % 9)).padStart(2, "0")}.md`;
    const node: MemoryGraphNode = {
      id: `synthetic:source:${i}`,
      type: "SOURCE",
      label: core ? "space.md" : sourcePath.split("/").at(-1)!,
      sourcePath,
      recordId: null,
      position: { clustered: scatter(`synthetic:source:${i}`, "clustered", 60), relations: scatter(`synthetic:source:${i}`, "relations", 60) }
    };
    sources.push(node);
    nodes.push(node);
    if (!core) edges.push({ id: `synthetic:edge:derived:${i}`, type: "DERIVED_FROM", source: sources[0]!.id, target: node.id });
  }
  const topics: MemoryGraphNode[] = [];
  for (let i = 0; i < topicCount; i++) {
    const node: MemoryGraphNode = {
      id: `synthetic:topic:${i}`,
      type: "TOPIC",
      label: `synthetic topic ${i}`,
      sourcePath: null,
      recordId: null,
      position: { clustered: scatter(`synthetic:topic:${i}`, "clustered", 60), relations: scatter(`synthetic:topic:${i}`, "relations", 60) }
    };
    topics.push(node);
    nodes.push(node);
  }
  const memories: MemoryGraphNode[] = [];
  for (let i = 0; i < memoryCount; i++) {
    const source = sources[i % sourceCount]!;
    const node: MemoryGraphNode = {
      id: `synthetic:memory:${i}`,
      type: "MEMORY",
      label: `Synthetic memory ${i}`,
      sourcePath: source.sourcePath,
      recordId: `synthetic:memory:${i}`,
      position: { clustered: scatter(`synthetic:memory:${i}`, "clustered", 60), relations: scatter(`synthetic:memory:${i}`, "relations", 60) }
    };
    memories.push(node);
    nodes.push(node);
    edges.push({ id: `synthetic:edge:contains:${i}`, type: "CONTAINS", source: source.id, target: node.id });
    const topic = topics[i % topicCount]!;
    edges.push({ id: `synthetic:edge:tagged:${i}`, type: "TAGGED_WITH", source: node.id, target: topic.id, origin: "EXPLICIT_TAG", confidence: 1 });
  }
  for (let i = 0; i < memoryCount; i++) {
    const target = memories[(i * 7 + 13) % memoryCount]!;
    if (target.id === memories[i]!.id) continue;
    edges.push({ id: `synthetic:edge:related:${i}`, type: "SEMANTICALLY_RELATED", source: memories[i]!.id, target: target.id, confidence: 0.5 });
  }
  return { nodes, edges };
}

/** Reads the requested synthetic graph size from the demo URL, if present and sane. */
export function demoGraphSizeFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get("demoGraphSize");
  if (!raw) return null;
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 100 || size > 200_000) return null;
  return size;
}
