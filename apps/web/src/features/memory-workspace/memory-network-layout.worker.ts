import { layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const { nodes, edges } = event.data;
  if (!nodes || !nodes.length) {
    self.postMessage({ positions: [], depth: [], step: 180, totalSteps: 180, done: true });
    return;
  }

  // 1. Compute 2D network layout
  const positions = layoutMemoryNetwork(nodes, edges);
  const positionsArray = [...positions];

  // 2. Stream 3D force simulation positions incrementally while the 180-step simulation converges
  layoutMemoryNetwork3D(nodes, edges, progress => {
    self.postMessage({
      positions: positionsArray,
      depth: [...progress.positions],
      step: progress.step,
      totalSteps: progress.totalSteps,
      done: progress.done
    });
  });
};
