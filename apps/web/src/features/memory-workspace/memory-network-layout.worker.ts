import { createMemoryNetwork3DSimulation, type MemoryPoint3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

export type MemoryLayoutWorkerMessage = {
  type?: "progress" | "complete";
  step: number;
  totalSteps: number;
  done: boolean;
  orderedIds: string[];
  packedDepth: Float32Array;
  positions?: Array<[string, { x: number; y: number }]>;
  depth?: Array<[string, MemoryPoint3D]>;
};

const postFrame = (message: MemoryLayoutWorkerMessage, transfer?: Transferable[]) => {
  (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage(
    message,
    transfer ?? []
  );
};

self.onmessage = (
  event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; batchSteps?: number }>
) => {
  const { nodes, edges } = event.data;
  const simulation = createMemoryNetwork3DSimulation(nodes, edges);
  const totalSteps = simulation.totalSteps;
  const orderedIds = simulation.orderedIds;
  const batchSteps =
    event.data.batchSteps ?? (nodes.length <= 500 ? 60 : nodes.length > 5_000 ? 6 : 30);

  if (totalSteps > 0) {
    const initialPacked = simulation.packedPositions();
    postFrame(
      {
        type: "progress",
        step: 0,
        totalSteps,
        done: false,
        orderedIds,
        packedDepth: initialPacked
      },
      [initialPacked.buffer]
    );
  }

  const runBatch = () => {
    const done = totalSteps === 0 ? true : simulation.step(batchSteps);
    const step = simulation.currentStep();
    const packedDepth = simulation.packedPositions();
    if (!done) {
      postFrame(
        {
          type: "progress",
          step,
          totalSteps,
          done: false,
          orderedIds,
          packedDepth
        },
        [packedDepth.buffer]
      );
      setTimeout(runBatch, 0);
      return;
    }

    const positions = [...layoutMemoryNetwork(nodes, edges)];
    const includeFullDepthEntries = nodes.length <= 5_000;
    postFrame(
      {
        type: "complete",
        step,
        totalSteps,
        done: true,
        orderedIds,
        packedDepth,
        positions,
        ...(includeFullDepthEntries ? { depth: [...simulation.snapshot()] } : {})
      },
      [packedDepth.buffer]
    );
  };

  if (nodes.length > 500 && totalSteps > 0) {
    setTimeout(runBatch, 0);
  } else {
    runBatch();
  }
};
