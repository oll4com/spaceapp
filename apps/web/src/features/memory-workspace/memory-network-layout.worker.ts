import { layoutMemoryNetwork3D, type LayoutStreamStep } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  const positions2D = layoutMemoryNetwork(nodes, edges);

  layoutMemoryNetwork3D(nodes, edges, (stepInfo: LayoutStreamStep) => {
    (self as unknown as { postMessage: (msg: unknown) => void }).postMessage({
      positions: stepInfo.done ? [...positions2D] : undefined,
      depth: [...stepInfo.positions],
      step: stepInfo.step,
      totalSteps: stepInfo.totalSteps,
      done: stepInfo.done
    });
  });
};
