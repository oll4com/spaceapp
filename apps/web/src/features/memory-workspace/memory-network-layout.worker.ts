import { createMemoryNetwork3DSimulation } from "./memory-3d.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryNetworkLayoutMessage, MemoryNetworkLayoutRequest, MemoryNetworkLayoutWorkerRequest } from "./memory-network-layout-protocol.js";
import { memoryReplyTransferables, packMemoryAtlas, packMemoryDepth } from "./memory-network-replies.js";

let request = 0;
/** Let queued graph requests invalidate the current generation between force slices. */
const yieldToWorker = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Prepare atlas metadata and stream force snapshots; a newer generation cancels the old run. */
async function runLayout(data: MemoryNetworkLayoutRequest, current: number) {
  const { mode, prepareAtlas } = data;
  // Taxonomy/color/date preparation belongs off the UI thread too. Only 3D opts
  // into the complete graph; the existing 2D overview keeps its tag thresholds.
  const atlas = prepareAtlas ? createMemoryAtlas(data.nodes, data.edges, false, undefined, mode === "3D") : undefined;
  const nodes = atlas?.nodes ?? data.nodes, edges = atlas?.edges ?? data.edges;
  const simulation = createMemoryNetwork3DSimulation(nodes, edges);
  const packed = mode === "3D" && Boolean(atlas) && nodes.length > 2000;
  /** Transfer owned packed buffers, retaining structured-clone support for legacy replies. */
  const post = (message: MemoryNetworkLayoutMessage) => {
    const transfer = memoryReplyTransferables(message);
    if (transfer.length) self.postMessage(message, { transfer });
    else self.postMessage(message);
  };
  /** Publish an independent depth frame in raw topology order or the legacy keyed form. */
  const depthMessage = () => packed ? { packedDepth: packMemoryDepth(data.nodes, simulation.snapshot()) } : { depth: [...simulation.snapshot()] };
  post({ ...(atlas ? mode === "3D" ? { atlas: { ...atlas, nodes: [], edges: [], ...(packed ? { positions: new Map() } : {}) }, rawGraph: true,
    ...(packed ? { packedAtlas: packMemoryAtlas(data.nodes, atlas.positions) } : {}) } : { atlas } : {}), ...depthMessage(), done: false, progress: 0 });
  await yieldToWorker();
  let lastSnapshot = performance.now();
  while (!simulation.done) {
    if (current !== request) return;
    const sliceStart = performance.now();
    do { simulation.advance(); } while (!simulation.done && performance.now() - sliceStart < 16);
    if (!simulation.done && performance.now() - lastSnapshot >= 250) {
      post({ ...depthMessage(), done: false, progress: simulation.progress });
      lastSnapshot = performance.now();
    }
    // New graph requests can cancel this run, and UI receives positions while
    // the same deterministic spring/repulsion simulation continues converging.
    await yieldToWorker();
  }
  if (current !== request) return;
  const snapshot = simulation.snapshot();
  if (packed) {
    const packedDepth = packMemoryDepth(data.nodes, snapshot), packedPositions = new Float32Array(data.nodes.length * 2);
    for (let index = 0; index < data.nodes.length; index++) {
      packedPositions[index * 2] = packedDepth[index * 3]!;
      packedPositions[index * 2 + 1] = packedDepth[index * 3 + 1]!;
    }
    post({ packedDepth, packedPositions, done: true, progress: 1 });
    return;
  }
  const depth = [...snapshot];
  const positions = mode === "3D"
    ? depth.map(([id, point]) => [id, { x: point.x, y: point.y }] as [string, { x: number; y: number }])
    : [...layoutMemoryNetwork(nodes, edges)];
  if (current === request) post({ positions, depth, done: true, progress: 1 });
}

let pending: MemoryNetworkLayoutRequest | null = null;
/** Accept whole requests or ordered graph chunks; begin cancels immediately and finish starts the assembled graph. */
self.onmessage = (event: MessageEvent<MemoryNetworkLayoutWorkerRequest>) => {
  const data = event.data;
  if (!("kind" in data)) {
    pending = null;
    void runLayout(data, ++request);
    return;
  }
  if (data.kind === "begin") {
    // Cancel a previous simulation immediately, before the new graph is assembled.
    request++;
    pending = { nodes: [], edges: [], mode: data.mode, prepareAtlas: data.prepareAtlas };
  } else if (data.kind === "nodes" && pending) {
    pending.nodes.push(...data.nodes);
  } else if (data.kind === "edges" && pending) {
    pending.edges.push(...data.edges);
  } else if (data.kind === "finish" && pending) {
    const complete = pending;
    pending = null;
    void runLayout(complete, request);
  }
};
