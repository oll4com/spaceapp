import type {
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphNodeDetail,
  MemoryGraphOverviewPayload
} from "@space/contracts";

export type DemoMemoryGraphSize = 2000 | 10000 | 50000;
export type DemoMemoryGraphQuery = {
  q?: string;
  nodeType?: MemoryGraphNode["type"];
  scope?: "SYSTEM" | "PROJECT" | "ROOM";
  roomId?: string;
  sourcePath?: string;
  lifecycleStatus?: "ACTIVE" | "ARCHIVED";
  month?: string;
  relationMode?: "CLUSTERED" | "RELATIONS";
  limit?: number;
  page?: number;
  pageSize?: number;
};

const FIXED_AT = "2026-10-01T00:00:00.000Z";
const ROOM_ID = "room:demo-launch";
const EDGE_OFFSETS = [1, 17, 97] as const;
const CHUNK_SIZE = 500;
// The graph contract permits at most 24 distinct memory sources, regardless of node count.
const SOURCE_COUNT = 24;
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Only the local demo route accepts the explicitly bounded benchmark fixture. */
export function demoMemoryGraphSizeFromLocation(location: Pick<Location, "pathname" | "search">): DemoMemoryGraphSize | undefined {
  if (location.pathname.replace(/\/+$/, "") !== "/demo-workspace") return undefined;
  const value = new URLSearchParams(location.search).get("memoryGraphNodes");
  return value === "2000" ? 2000 : value === "10000" ? 10000 : value === "50000" ? 50000 : undefined;
}

/** Generated in bounded tasks; no provider, random seed, backend or stored user data. */
export class DemoMemoryGraph {
  constructor(readonly size: DemoMemoryGraphSize, private readonly yieldTask = yieldToBrowser) {
    if (![2000, 10000, 50000].includes(size)) throw new RangeError("Unsupported demo graph size.");
  }

  private id(index: number): string { return `memory:demo-scale:${String(index).padStart(5, "0")}`; }
  private sourceIndex(index: number): number { return Math.floor(index / Math.ceil(this.size / SOURCE_COUNT)); }
  private isSource(index: number): boolean { return index % Math.ceil(this.size / SOURCE_COUNT) === 0; }
  private sourcePath(index: number): string {
    return `/demo/memory/${String(this.sourceIndex(index)).padStart(4, "0")}/space_memory_2026-10.md`;
  }
  private label(index: number): string {
    return index === 0 ? "space.md" : `Synthetic ${this.isSource(index) ? "source" : "memory"} ${String(index).padStart(5, "0")}`;
  }
  private body(index: number): string {
    return `${this.label(index)} belongs to the deterministic ${this.size}-node demo graph. This is synthetic benchmark content, not a saved user memory.`;
  }
  private node(index: number): MemoryGraphNode {
    const columns = Math.ceil(Math.sqrt(this.size));
    const x = (index % columns) * 24;
    const y = Math.floor(index / columns) * 24;
    return {
      id: this.id(index), type: this.isSource(index) ? "SOURCE" : "MEMORY", label: this.label(index), sourcePath: this.sourcePath(index),
      recordId: this.isSource(index) ? null : this.id(index),
      position: { clustered: { x, y }, relations: { x, y } }
    };
  }
  private edge(index: number, offset: number): MemoryGraphEdge {
    return {
      id: `edge:demo-scale:${index}:${offset}`, type: "SEMANTICALLY_RELATED",
      source: this.id(index), target: this.id((index + offset) % this.size),
      origin: "DETERMINISTIC_TFIDF", confidence: 0.75,
      evidence: "Synthetic fixed-offset relationship for graph benchmarking."
    };
  }
  private matches(index: number, query: DemoMemoryGraphQuery, needle: string): boolean {
    const source = this.isSource(index);
    return (!query.nodeType || query.nodeType === (source ? "SOURCE" : "MEMORY")) &&
      (!query.scope || (!source && query.scope === "ROOM")) && (!query.roomId || (!source && query.roomId === ROOM_ID)) &&
      (!query.sourcePath || query.sourcePath === this.sourcePath(index)) &&
      (!query.lifecycleStatus || (!source && query.lifecycleStatus === "ACTIVE")) &&
      (!query.month || query.month === "all" || query.month === "2026-10") &&
      (!needle || (source ? this.label(index) : this.body(index)).toLowerCase().includes(needle) || this.sourcePath(index).includes(needle));
  }

  async overview(query: DemoMemoryGraphQuery = {}, offset = 0): Promise<MemoryGraphOverviewPayload> {
    const limit = query.limit ?? 2000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50000) throw new RangeError("Graph limit must be between 1 and 50000.");
    const needle = query.q?.trim().toLowerCase() ?? "";
    const matching = new Set<number>();
    const matchingSources = new Set<number>();
    let recordCount = 0;
    const visible = new Set<number>();
    const nodes: MemoryGraphNode[] = [];
    const edges: MemoryGraphEdge[] = [];
    // Yield before the first batch, too: selecting a graph must let the loading UI paint.
    for (let start = 0; start < this.size; start += CHUNK_SIZE) {
      await this.yieldTask();
      for (let index = start; index < Math.min(start + CHUNK_SIZE, this.size); index++) {
        if (!this.matches(index, query, needle)) continue;
        matching.add(index);
        matchingSources.add(this.sourceIndex(index));
        if (!this.isSource(index)) recordCount++;
        if (matching.size <= offset || nodes.length >= limit) continue;
        visible.add(index);
        nodes.push(this.node(index));
      }
    }
    let totalMatchingEdges = 0;
    for (let start = 0; start < this.size; start += CHUNK_SIZE) {
      await this.yieldTask();
      for (let index = start; index < Math.min(start + CHUNK_SIZE, this.size); index++) {
        if (!matching.has(index)) continue;
        for (const edgeOffset of EDGE_OFFSETS) {
          const target = (index + edgeOffset) % this.size;
          if (!matching.has(target)) continue;
          totalMatchingEdges++;
          if (visible.has(index) && visible.has(target)) edges.push(this.edge(index, edgeOffset));
        }
      }
    }
    // Synthetic identity, intentionally stable across runs and independent of wall time.
    const hash = this.size.toString(16).padStart(64, "0");
    return {
      version: 2, generatedAt: FIXED_AT, sourceHash: hash, revisionHash: hash, isStale: false,
      summary: { sourceCount: matchingSources.size, recordCount,
        nodeCount: matching.size, edgeCount: totalMatchingEdges, issueCount: 0 },
      nodes, edges, layoutVersion: 2, taxonomyVersion: 2,
      filters: { q: query.q ?? null, nodeType: query.nodeType ?? null, scope: query.scope ?? null,
        roomId: query.roomId ?? null, sourcePath: query.sourcePath ?? null,
        lifecycleStatus: query.lifecycleStatus ?? null, relationMode: query.relationMode ?? "RELATIONS", month: query.month ?? null },
      months: ["2026-10"], totalMatchingNodes: matching.size, totalMatchingEdges,
      truncated: nodes.length < matching.size
    };
  }

  async page(query: DemoMemoryGraphQuery = {}) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const { totalMatchingNodes, totalMatchingEdges: _edges, truncated: _truncated, ...data } =
      await this.overview({ ...query, limit: pageSize }, (page - 1) * pageSize);
    return { data, pagination: { page, pageSize, totalItems: totalMatchingNodes,
      totalPages: Math.ceil(totalMatchingNodes / pageSize) } };
  }

  detail(id: string): MemoryGraphNodeDetail | undefined {
    const match = /^memory:demo-scale:(\d{5})$/.exec(id);
    if (!match) return undefined;
    const index = Number(match[1]);
    if (index >= this.size) return undefined;
    const relatedIndices = EDGE_OFFSETS.flatMap((offset) => [(index + offset) % this.size, (index - offset + this.size) % this.size]);
    return {
      node: this.node(index), record: this.isSource(index) ? null : {
        id, sourcePath: this.sourcePath(index), sectionId: `section:demo-scale:${index}`,
        title: this.label(index), body: this.body(index), createdAt: FIXED_AT,
        scope: "ROOM", roomId: ROOM_ID, provenance: "Deterministic local benchmark fixture",
        contentHash: index.toString(16).padStart(64, "0"), lifecycleStatus: "ACTIVE", tags: ["synthetic"]
      },
      relatedNodes: relatedIndices.map((related) => this.node(related)),
      relatedEdges: EDGE_OFFSETS.flatMap((offset) => [this.edge(index, offset), this.edge((index - offset + this.size) % this.size, offset)]),
      issues: []
    };
  }
}
