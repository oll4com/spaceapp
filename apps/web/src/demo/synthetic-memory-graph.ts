import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeDetail, MemoryGraphSummary } from "@space/contracts";

/** Sizes offered by the 3D view; the generator itself accepts any count of at least 200. */
export const SYNTHETIC_MEMORY_SIZES = [2000, 10_000, 50_000] as const;
const MAX_SYNTHETIC_SOURCES = 24; // memoryGraphSummarySchema caps sourceCount at 24
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

const CHECK_EVERY = 256; // iterations between clock reads while building

/**
 * Deterministic synthetic archive of exactly `size` nodes and 3 * `size` edges: one core source,
 * one source per month (at most 24), topics, and memories. Ids embed the size so graphs of
 * different sizes never share node details.
 *
 * Built by a resumable stepper so a caller on the main thread can slice the work (see `generateSyntheticMemoryGraphAsync`);
 * every slice continues the same random sequence, so the result never depends on how the work was sliced.
 */
export class SyntheticGraphBuilder {
  private readonly size: number; private readonly tag: string; private readonly random: () => number;
  private readonly sourceCount: number; private readonly topicCount: number; private readonly memoryCount: number;
  private readonly months: string[]; private readonly nodes: MemoryGraphNode[] = []; private readonly edges: MemoryGraphEdge[] = [];
  private readonly sourceIds: string[] = []; private readonly sourcePaths: string[] = []; private topicIds: string[] = [];
  private readonly memoryIds: string[] = [];
  private readonly target: number; private readonly seen = new Set<number>();
  private phase: "memories" | "related" | "done" = "memories";
  private index = 0; private attempts = 0; private slices = 0;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 200) throw new Error("A synthetic memory graph needs an integer size of at least 200.");
    this.size = size;
    this.random = mulberry32(0x5eed ^ size);
    this.tag = `synthetic-${size}`;
    this.sourceCount = Math.min(MAX_SYNTHETIC_SOURCES, Math.max(3, Math.floor(size / 600)));
    this.topicCount = Math.min(200, Math.max(8, Math.round(size / 250)));
    this.memoryCount = size - 1 - this.sourceCount - this.topicCount;
    this.months = Array.from({ length: this.sourceCount }, (_, index) => monthKey(index)).reverse();
    this.target = size * EDGES_PER_NODE;
    const { tag, nodes, edges } = this;
    const pad = padId;
    const coreId = `source:${tag}-core`;
    nodes.push({ id: coreId, type: "SOURCE", label: "space.md", sourcePath: `/demo/${tag}/space.md`, recordId: null });
    this.months.forEach((month, index) => {
      const id = `source:${tag}-${month}`, sourcePath = `/demo/${tag}/space_memory_${month}.md`;
      this.sourceIds.push(id); this.sourcePaths.push(sourcePath);
      nodes.push({ id, type: "SOURCE", label: `space_memory_${month}.md`, sourcePath, recordId: null });
      edges.push({ id: `edge:${tag}-core-${pad(index)}`, type: "DERIVED_FROM", source: coreId, target: id });
    });
    this.topicIds = Array.from({ length: this.topicCount }, (_, index) => {
      const id = `topic:${tag}-${pad(index)}`;
      nodes.push({ id, type: "TOPIC", label: `Topic ${index + 1}`, sourcePath: null, recordId: null });
      return id;
    });
  }

  get done(): boolean { return this.phase === "done"; }
  /** Number of `step` calls so far (for tests and diagnostics). */
  get sliceCount(): number { return this.slices; }

  /** Runs for about `budgetMs` (the clock is read every CHECK_EVERY iterations, and at least one batch always runs); returns true when finished. */
  step(budgetMs: number, now: () => number = () => performance.now()): boolean {
    this.slices++;
    const started = now();
    while (!this.done) {
      if (this.phase === "memories") this.memories(Math.min(this.memoryCount, this.index + CHECK_EVERY)); else this.related(CHECK_EVERY);
      if (!this.done && now() - started >= budgetMs) break;
    }
    return this.done;
  }

  private memories(end: number) {
    const { tag, nodes, edges, random, memoryCount, sourceCount, sourceIds, sourcePaths, topicIds, topicCount, memoryIds } = this;
    for (; this.index < end; this.index++) {
      const index = this.index;
      const id = `memory:${tag}-${padId(index)}`, source = Math.floor(index * sourceCount / memoryCount);
      memoryIds.push(id);
      nodes.push({ id, type: "MEMORY", label: `Synthetic memory ${index + 1}`, sourcePath: sourcePaths[source]!, recordId: id });
      edges.push({ id: `edge:${tag}-contains-${padId(index)}`, type: "CONTAINS", source: sourceIds[source]!, target: id });
      const topic = topicIds[Math.floor(random() ** 2 * topicCount)]!; // skewed so a few topics dominate
      edges.push({ id: `edge:${tag}-tag-${padId(index)}`, type: "TAGGED_WITH", source: id, target: topic, origin: index % 3 === 0 ? "EXPLICIT_TAG" : "DERIVED_TFIDF", confidence: 0.9, evidence: "Synthetic tag." });
    }
    if (this.index >= memoryCount) this.phase = "related";
  }

  // Related memories fill the budget to exactly three edges per node, mostly within a source's neighbourhood.
  private related(batch: number) {
    const { tag, edges, random, memoryCount, memoryIds, target, seen } = this;
    for (let n = 0; n < batch; n++) {
      if (!(edges.length < target && this.attempts++ < target * 20)) { this.phase = "done"; return; }
      const a = Math.floor(random() * memoryCount);
      const local = random() < 0.8;
      const b = local ? Math.max(0, Math.min(memoryCount - 1, a + Math.floor((random() - 0.5) * 120))) : Math.floor(random() * memoryCount);
      if (a === b) continue;
      const key = Math.min(a, b) * memoryCount + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `edge:${tag}-rel-${padId(edges.length)}`, type: "SEMANTICALLY_RELATED", source: memoryIds[a]!, target: memoryIds[b]!, origin: "DETERMINISTIC_TFIDF", confidence: Math.round(random() * 100) / 100, evidence: "Synthetic similarity." });
    }
  }

  result(): SyntheticMemoryGraph {
    if (this.phase !== "done") throw new Error("The synthetic memory graph is not finished.");
    const { nodes, edges } = this;
    return { size: this.size, nodes, edges, months: this.months, summary: { sourceCount: this.sourceCount, recordCount: this.memoryCount, nodeCount: nodes.length, edgeCount: edges.length, issueCount: 0 } };
  }
}

const padId = (value: number) => String(value).padStart(6, "0");

export function generateSyntheticMemoryGraph(size: number): SyntheticMemoryGraph {
  const builder = new SyntheticGraphBuilder(size);
  builder.step(Infinity);
  return builder.result();
}

export interface SyntheticSlicing { sliceMs?: number; now?: () => number; yieldToEvents?: () => Promise<void> }
export const SYNTHETIC_SLICE_MS = 20;
const yieldToTimers = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The same graph as `generateSyntheticMemoryGraph`, built in slices of about `sliceMs` with a yield between them so the main thread stays responsive. */
export async function generateSyntheticMemoryGraphAsync(size: number, { sliceMs = SYNTHETIC_SLICE_MS, now, yieldToEvents = yieldToTimers }: SyntheticSlicing = {}): Promise<SyntheticMemoryGraph> {
  const builder = new SyntheticGraphBuilder(size);
  while (!builder.step(sliceMs, now)) await yieldToEvents();
  return builder.result();
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
