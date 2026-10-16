import { layoutMemoryNetwork3D, type LayoutStreamStep } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const positions2D = layoutMemoryNetwork(nodes, edges);

  layoutMemoryNetwork3D(nodes, edges, (stepInfo: LayoutStreamStep) => {
    const coordsBuffer = stepInfo.coords.buffer;
    (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage(
      {
        positions: [...positions2D],
        depth: [...stepInfo.positions],
        coords: stepInfo.coords,
        step: stepInfo.step,
        totalSteps: stepInfo.totalSteps,
        done: stepInfo.done
      },
      [coordsBuffer]
    );
  });
};
