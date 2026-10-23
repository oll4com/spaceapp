import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryNetwork3DSimulation, selectMemory3DFallbackNodes, type MemoryPoint3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";

export interface MemoryNetworkLayoutWorkerMessage {
  positions?: Array<[string, { x: number; y: number }]>;
  depth?: Array<[string, MemoryPoint3D]>;
  coords3d: Float32Array;
  step: number;
  totalSteps: number;
  done: boolean;
}

let activeTimer: ReturnType<typeof setTimeout> | null = null;
let activeJobId = 0;

/**
 * Calculates 2D network layout positions for either the full graph or the capped fallback subset.
 *
 * @param nodes Full set of graph nodes.
 * @param edges Full set of graph edges.
 * @param isLarge Whether node count exceeds 2,000 nodes.
 * @returns Serialized map entries of 2D coordinates keyed by node ID.
 */
function compute2DPositions(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  isLarge: boolean,
  selectedNodeId: string | null = null
): Array<[string, { x: number; y: number }]> {
  if (isLarge) {
    const fallback = selectMemory3DFallbackNodes(nodes, edges, selectedNodeId, 2000);
    return [...layoutMemoryNetwork(fallback.nodes, fallback.edges)];
  }
  return [...layoutMemoryNetwork(nodes, edges)];
}

/**
 * Posts incremental layout coordinates and completion status to the parent thread with zero-copy buffer transfer.
 *
 * @param message Structured simulation progress payload.
 * @param transfer Array of transferable array buffers.
 */
function postWorkerMessage(message: MemoryNetworkLayoutWorkerMessage, transfer: Transferable[]): void {
  (self as unknown as { postMessage(msg: MemoryNetworkLayoutWorkerMessage, transfer: Transferable[]): void })
    .postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; selectedNodeId?: string | null }>) => {
  if (activeTimer !== null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  const jobId = ++activeJobId;
  const { nodes, edges, selectedNodeId = null } = event.data;
  const count = nodes.length;
  const isLarge = count > 2000;
  const sim3D = createMemoryNetwork3DSimulation(nodes, edges);

  // Emit an initial interactive frame after a short warm-up batch so the user can rotate/zoom immediately.
  const initialBatch = isLarge ? 4 : Math.min(45, sim3D.totalSteps);
  const initialDone = sim3D.step(initialBatch);
  const firstCoords = sim3D.packCoordinates();

  if (initialDone) {
    const positions = compute2DPositions(nodes, edges, isLarge, selectedNodeId);
    const depth = isLarge ? undefined : [...sim3D.toMap()];
    postWorkerMessage(
      {
        positions,
        depth,
        coords3d: firstCoords,
        step: sim3D.currentStep,
        totalSteps: sim3D.totalSteps,
        done: true
      },
      [firstCoords.buffer]
    );
    return;
  }

  postWorkerMessage(
    {
      coords3d: firstCoords,
      step: sim3D.currentStep,
      totalSteps: sim3D.totalSteps,
      done: false
    },
    [firstCoords.buffer]
  );

  const batchSteps = isLarge ? 8 : 45;
  const tick = () => {
    if (jobId !== activeJobId) return;
    const done = sim3D.step(batchSteps);
    const coords3d = sim3D.packCoordinates();
    if (!done) {
      postWorkerMessage(
        {
          coords3d,
          step: sim3D.currentStep,
          totalSteps: sim3D.totalSteps,
          done: false
        },
        [coords3d.buffer]
      );
      activeTimer = setTimeout(tick, 0);
      return;
    }

    activeTimer = null;
    const positions = compute2DPositions(nodes, edges, isLarge, selectedNodeId);
    const depth = isLarge ? undefined : [...sim3D.toMap()];
    postWorkerMessage(
      {
        positions,
        depth,
        coords3d,
        step: sim3D.currentStep,
        totalSteps: sim3D.totalSteps,
        done: true
      },
      [coords3d.buffer]
    );
  };

  activeTimer = setTimeout(tick, 0);
};
