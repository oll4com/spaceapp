import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { createMemoryNetwork3DSimulation, type MemoryPoint3D } from "./memory-3d.js";
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

function postWorkerMessage(message: MemoryNetworkLayoutWorkerMessage, transfer: Transferable[]): void {
  (self as unknown as { postMessage(msg: MemoryNetworkLayoutWorkerMessage, transfer: Transferable[]): void })
    .postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  if (activeTimer !== null) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  const jobId = ++activeJobId;
  const { nodes, edges } = event.data;
  const count = nodes.length;
  const isLarge = count > 2000;
  const sim3D = createMemoryNetwork3DSimulation(nodes, edges);

  // Emit an initial interactive frame after a short warm-up batch so the user can rotate/zoom immediately.
  const initialBatch = isLarge ? 4 : Math.min(45, sim3D.totalSteps);
  const initialDone = sim3D.step(initialBatch);
  const firstCoords = sim3D.packCoordinates();

  if (initialDone) {
    const positions = isLarge ? undefined : [...layoutMemoryNetwork(nodes, edges)];
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
    const positions = isLarge ? undefined : [...layoutMemoryNetwork(nodes, edges)];
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
