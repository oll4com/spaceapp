import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { syntheticMemoryOverview } from "../../demo/synthetic-memory-graph.js";
import { copyPackedPositions, packedTransferables, prepareMemoryGraph } from "./memory-3d-buffers.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";

type LayoutRequest =
  | { mode: "layout"; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }
  | { mode: "generate"; nodeCount: number; edgeCount?: number }
  | { mode: "fetch"; url: string };

interface OverviewMeta {
  truncated: boolean;
  totalMatchingNodes: number;
  totalMatchingEdges: number;
  isStale: boolean;
  recordCount: number;
  issueCount: number;
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<LayoutRequest>) => {
  void run(event.data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Memory layout could not be calculated.";
    scope.postMessage({ type: "error", message });
  });
};

async function run(request: LayoutRequest) {
  const loadStarted = performance.now();
  const loaded = await load(request);
  const loadMs = performance.now() - loadStarted;
  const started = performance.now();
  const prepared = prepareMemoryGraph(loaded.nodes, loaded.edges, loaded.meta);
  const prepareMs = performance.now() - started;
  const { packed, simulation } = prepared;
  scope.postMessage({ type: "packed", packed, layoutMs: 0, loadMs, prepareMs }, packedTransferables(packed));
  if (simulation.done) {
    const xyz = copyPackedPositions(simulation, packed.count);
    scope.postMessage({ type: "positions", step: simulation.step, done: true, layoutMs: performance.now() - started, xyz: xyz.buffer }, [xyz.buffer as ArrayBuffer]);
  }
  while (!simulation.done) {
    const sliceStarted = performance.now();
    do {
      simulation.advance(1);
    } while (!simulation.done && performance.now() - sliceStarted < 16);
    const xyz = copyPackedPositions(simulation, packed.count);
    scope.postMessage({
      type: "positions",
      step: simulation.step,
      done: simulation.done,
      layoutMs: performance.now() - started,
      xyz: xyz.buffer
    }, [xyz.buffer as ArrayBuffer]);
    if (!simulation.done) await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (request.mode === "layout" && loaded.nodes.length <= 2_000) {
    const positions = layoutMemoryNetwork(loaded.nodes, loaded.edges);
    scope.postMessage({ type: "plan", positions: [...positions] });
  }
}

async function load(request: LayoutRequest): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; meta: OverviewMeta }> {
  if (request.mode === "generate") {
    const overview = syntheticMemoryOverview(request.nodeCount, request.edgeCount);
    return {
      nodes: overview.nodes,
      edges: overview.edges,
      meta: metaFrom(overview.truncated, overview.totalMatchingNodes, overview.totalMatchingEdges, overview.isStale, overview.summary.recordCount, overview.summary.issueCount)
    };
  }
  if (request.mode === "fetch") {
    const response = await fetch(request.url, { credentials: "include" });
    if (!response.ok) throw new Error(`Memory graph request failed (${response.status}).`);
    const payload = await response.json() as { data?: PackedOverview };
    const data = payload.data;
    if (!data) throw new Error("Memory graph response was empty.");
    return {
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      meta: metaFrom(Boolean(data.truncated), data.totalMatchingNodes ?? data.nodes.length, data.totalMatchingEdges ?? data.edges.length, Boolean(data.isStale), data.summary?.recordCount ?? 0, data.summary?.issueCount ?? 0)
    };
  }
  return {
    nodes: request.nodes,
    edges: request.edges,
    meta: metaFrom(false, request.nodes.length, request.edges.length, false, request.nodes.filter(node => node.type === "MEMORY").length, 0)
  };
}

function metaFrom(
  truncated: boolean,
  totalMatchingNodes: number,
  totalMatchingEdges: number,
  isStale: boolean,
  recordCount: number,
  issueCount: number
): OverviewMeta {
  return { truncated, totalMatchingNodes, totalMatchingEdges, isStale, recordCount, issueCount };
}

interface PackedOverview {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  truncated?: boolean;
  totalMatchingNodes?: number;
  totalMatchingEdges?: number;
  isStale?: boolean;
  summary?: { recordCount?: number; issueCount?: number };
}

